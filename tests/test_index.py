"""Tests for pacs.index (the sqlite instance index).

Runs under pytest, or directly:  python3 tests/test_index.py
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

from pacs.index import InstanceIndex

CT_SOP = str(CTImageStorage)


def _save(ds, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        ds.save_as(path, enforce_file_format=True)      # pydicom >= 3
    except TypeError:
        ds.save_as(path, write_like_original=False)     # pydicom 2.x


def make_instance(root: str, *, patient_name: str, patient_id: str, study_uid: str,
                  series_uid: str, sop_uid: str, modality: str = "CT",
                  study_date: str = "20240115", study_time: str = "101530",
                  accession: str = "ACC1", study_desc: str = "Head CT",
                  series_desc: str = "Axial", series_number: int = 1,
                  instance_number: int = 1, name: str = "") -> str:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset("x", Dataset(), file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = sop_uid
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    ds.PatientName = patient_name
    ds.PatientID = patient_id
    ds.StudyDate = study_date
    ds.StudyTime = study_time
    ds.AccessionNumber = accession
    ds.StudyDescription = study_desc
    ds.SeriesDescription = series_desc
    ds.SeriesNumber = series_number
    ds.InstanceNumber = instance_number
    ds.Modality = modality
    # Mirrors scp.dest_path's Patient/Study/Series/SOP layout; leading dots are
    # stripped the way _safe() does, so a folder is only hidden when a test
    # deliberately asks for it.
    part = lambda s: (s[-8:].strip("._") or "x")            # noqa: E731
    path = os.path.join(root, patient_id, part(study_uid), part(series_uid),
                        (name or part(sop_uid)) + ".dcm")
    _save(ds, path)
    return path


def build_archive(root: str) -> dict:
    """Two patients / three studies / five series with known shapes."""
    out = {"studies": {}, "paths": []}

    # DOE^JANE — one study, two series (CT + SR), 3 + 2 instances
    s1 = generate_uid()
    ser1, ser2 = generate_uid(), generate_uid()
    for i in range(1, 4):
        out["paths"].append(make_instance(
            root, patient_name="DOE^JANE", patient_id="P001", study_uid=s1,
            series_uid=ser1, sop_uid=generate_uid(), modality="CT",
            study_date="20240115", accession="ACC001", study_desc="Head CT",
            series_desc="Axial", series_number=1, instance_number=i))
    for i in range(1, 3):
        out["paths"].append(make_instance(
            root, patient_name="DOE^JANE", patient_id="P001", study_uid=s1,
            series_uid=ser2, sop_uid=generate_uid(), modality="SR",
            study_date="20240115", accession="ACC001", study_desc="Head CT",
            series_desc="Report", series_number=2, instance_number=i))
    out["studies"]["jane"] = {"uid": s1, "series": [ser1, ser2], "instances": 5}

    # DOE^JOHN — two studies
    s2 = generate_uid()
    ser3 = generate_uid()
    for i in range(1, 5):
        out["paths"].append(make_instance(
            root, patient_name="DOE^JOHN", patient_id="P002", study_uid=s2,
            series_uid=ser3, sop_uid=generate_uid(), modality="MR",
            study_date="20240220", accession="ACC002", study_desc="Brain MRI",
            series_desc="T1", series_number=10, instance_number=i))
    out["studies"]["john_mr"] = {"uid": s2, "series": [ser3], "instances": 4}

    s3 = generate_uid()
    ser4 = generate_uid()
    out["paths"].append(make_instance(
        root, patient_name="DOE^JOHN", patient_id="P002", study_uid=s3,
        series_uid=ser4, sop_uid=generate_uid(), modality="CR",
        study_date="20231201", accession="ACC003", study_desc="Chest X-Ray",
        series_desc="PA", series_number=1, instance_number=1))
    out["studies"]["john_cr"] = {"uid": s3, "series": [ser4], "instances": 1}
    return out


class Env:
    """A temp archive + a fresh on-disk index over it."""

    def __init__(self, async_writes: bool = False):
        self.dir = tempfile.mkdtemp(prefix="carino-index-test-")
        self.received = os.path.join(self.dir, "received")
        self.sent = os.path.join(self.dir, "sent")
        os.makedirs(self.received)
        os.makedirs(self.sent)
        self.info = build_archive(self.received)
        self.db = os.path.join(self.dir, "index.sqlite3")
        self.idx = InstanceIndex(self.db, async_writes=async_writes)

    def index_all(self, group: str = "received") -> int:
        return sum(1 for p in self.info["paths"] if self.idx.add_file(p, group))

    def close(self):
        self.idx.close()
        shutil.rmtree(self.dir, ignore_errors=True)


# --------------------------------------------------------------------- tests
def test_add_and_stats():
    env = Env()
    try:
        assert env.index_all() == 10
        st = env.idx.stats()
        assert st["files"] == 10 and st["instances"] == 10
        assert st["studies"] == 3 and st["series"] == 4 and st["patients"] == 2
        assert st["groups"] == {"received": 10}
        assert st["bytes"] > 0

        # A non-DICOM file is skipped, not fatal.
        junk = os.path.join(env.received, "notes.txt")
        with open(junk, "w") as fh:
            fh.write("hello")
        assert env.idx.add_file(junk, "received") is False
        assert env.idx.stats()["files"] == 10
    finally:
        env.close()


def test_query_studies_and_aggregates():
    env = Env()
    try:
        env.index_all()
        studies = env.idx.query_studies()
        assert len(studies) == 3
        # Default order is newest StudyDate first.
        assert [s["StudyDate"] for s in studies] == ["20240220", "20240115", "20231201"]

        jane = [s for s in studies if s["PatientID"] == "P001"][0]
        assert jane["NumberOfStudyRelatedInstances"] == 5
        assert jane["NumberOfStudyRelatedSeries"] == 2
        assert jane["ModalitiesInStudy"] == ["CT", "SR"]
        assert jane["patient"] == "JANE DOE"
        assert jane["StudyTime"] == "101530"
        assert os.path.isdir(jane["path"])
        assert env.idx.count("study") == 3
        assert env.idx.count("series") == 4
        assert env.idx.count("instance") == 10

        # An empty filter value is DICOM's universal match, not "== ''".
        assert len(env.idx.query_studies({"PatientID": ""})) == 3
        assert len(env.idx.query_studies({"PatientID": "P001"})) == 1
        # Unknown keys are ignored rather than crashing the query.
        assert len(env.idx.query_studies({"NoSuchKeyword": "x"})) == 3

        asc = env.idx.query_studies(order_by="StudyDate")
        assert asc[0]["StudyDate"] == "20231201"
    finally:
        env.close()


def test_wildcards():
    env = Env()
    try:
        env.index_all()
        assert len(env.idx.query_studies({"PatientName": "DOE*"})) == 3
        assert len(env.idx.query_studies({"PatientName": "*JANE"})) == 1
        assert len(env.idx.query_studies({"PatientName": "doe^jane"})) == 1   # case-insensitive
        assert len(env.idx.query_studies({"PatientID": "P00?"})) == 3
        assert len(env.idx.query_studies({"PatientID": "P0?1"})) == 1
        assert len(env.idx.query_studies({"StudyDescription": "*CT*"})) == 1
        assert len(env.idx.query_studies({"AccessionNumber": "ACC00*"})) == 3
        # Multi-value (backslash) matching, the way a C-FIND UID list arrives.
        two = env.idx.query_studies({"AccessionNumber": "ACC001\\ACC003"})
        assert len(two) == 2
        assert len(env.idx.query_studies({"PatientID": ["P001", "P002"]})) == 3
        # A study-level query filtered on a series-level key keeps whole counts.
        ct = env.idx.query_studies({"ModalitiesInStudy": "CT"})
        assert len(ct) == 1
        assert ct[0]["NumberOfStudyRelatedInstances"] == 5     # not just the 3 CT ones
        assert ct[0]["NumberOfStudyRelatedSeries"] == 2
        assert ct[0]["ModalitiesInStudy"] == ["CT", "SR"]
        assert len(env.idx.query_studies({"ModalitiesInStudy": "CT\\MR"})) == 2
        assert len(env.idx.query_studies({"ModalitiesInStudy": "C*"})) == 2
    finally:
        env.close()


def test_date_and_time_ranges():
    env = Env()
    try:
        env.index_all()
        q = env.idx.query_studies
        assert len(q({"StudyDate": "20240101-20240301"})) == 2
        assert len(q({"StudyDate": "20240116-"})) == 1
        assert len(q({"StudyDate": "-20240116"})) == 2
        assert len(q({"StudyDate": "20240115"})) == 1
        assert len(q({"StudyDate": "20240115-20240115"})) == 1
        assert len(q({"StudyDate": "19900101-19900102"})) == 0
        # Punctuated (ACR-NEMA) dates normalise to the same key.
        assert len(q({"StudyDate": "2024.01.15"})) == 1
        # TM compares padded on BOTH sides, so a 4-digit device time brackets
        # the same as a 6-digit one.
        assert len(q({"StudyTime": "1000-1100"})) == 3
        assert len(q({"StudyTime": "100000-110000"})) == 3
        assert len(q({"StudyTime": "1200-"})) == 0
        assert len(q({"StudyTime": "101530"})) == 3
        assert len(q({"StudyTime": "1015"})) == 0        # 10:15:00 exactly, and none are
        env.idx.add_file(make_instance(
            env.received, patient_name="EARLY^BIRD", patient_id="P010",
            study_uid="1.2.777", series_uid="1.2.777.1", sop_uid="1.2.777.1.1",
            study_time="0930", study_date="20240115", name="early"), "received")
        assert len(q({"StudyTime": "0930"})) == 1        # stored short, queried short
        assert len(q({"StudyTime": "093000"})) == 1      # stored short, queried long
        assert len(q({"StudyTime": "0900-0940"})) == 1
    finally:
        env.close()


def _clock(env, pid: str, uid: str, date: str, tm: str) -> None:
    """One study for one patient at an exact date/time, for the range tests."""
    env.idx.add_file(make_instance(
        env.received, patient_name=f"CLOCK^{pid}", patient_id=pid, study_uid=uid,
        series_uid=uid + ".1", sop_uid=uid + ".1.1", study_date=date,
        study_time=tm, name=pid), "received")


def test_open_ended_time_range():
    """'HHMMSS-' is open at the top. Padding the absent bound out to '000000'
    turns it into a closed BETWEEN whose upper bound is BELOW its lower one, so
    the query matches nothing at all instead of everything after HHMMSS."""
    env = Env()
    try:
        env.index_all()
        day = "20240301"
        _clock(env, "P100", "1.2.100", day, "080000")
        _clock(env, "P101", "1.2.101", day, "120000")
        _clock(env, "P102", "1.2.102", day, "180000")

        def ids(**flt):
            # The exact StudyDate keeps the base archive out and is not itself a
            # range, so the pair stays on the independent path.
            flt["StudyDate"] = day
            return sorted(s["PatientID"] for s in env.idx.query_studies(flt, limit=0))

        assert ids(StudyTime="120000-") == ["P101", "P102"], ids(StudyTime="120000-")
        assert ids(StudyTime="-120000") == ["P100", "P101"], ids(StudyTime="-120000")
        assert ids(StudyTime="1200-") == ["P101", "P102"], ids(StudyTime="1200-")
        assert ids(StudyTime="080000-180000") == ["P100", "P101", "P102"]
        assert ids(StudyTime="190000-") == []
        assert ids(StudyTime="-070000") == []

        # The DA path is the same shape and must stay open at both ends too.
        def dates(value):
            return sorted(s["PatientID"] for s in
                          env.idx.query_studies({"StudyDate": value}, limit=0))

        assert dates("20240301-") == ["P100", "P101", "P102"]
        assert dates("-20231231") == ["P002"]          # only the 20231201 CR study
    finally:
        env.close()


def test_date_time_pair_defaults_to_intersection():
    """PS3.4's own worked example (C.2.2.2.5), replayed.

    StudyDate=20060705-20060707 with StudyTime=100000-180000 must return the
    THREE time periods 10:00-18:00 on July 5, 6 and 7 — the intersection of the
    two ranges. Reading them as the single span 5 Jul 10:00 → 7 Jul 18:00 is
    Combined Date and Time Matching, which is available only after successful
    Extended Negotiation (PS3.4 C.4.1.1.3.1) and which this index therefore
    keeps OFF unless the caller asks. Combined by default makes every date+time
    query silently WIDER than the SCU wrote: the 3am study below is the proof —
    it is inside the span and outside every one of the three time periods."""
    env = Env()
    try:
        _clock(env, "P500", "1.2.500", "20060705", "140000")   # in period 1
        _clock(env, "P501", "1.2.501", "20060706", "030000")   # in the SPAN only
        _clock(env, "P502", "1.2.502", "20060706", "140000")   # in period 2
        _clock(env, "P503", "1.2.503", "20060707", "230000")   # outside both

        def ids(**kw):
            return sorted(s["PatientID"] for s in env.idx.query_studies(
                {"StudyDate": "20060705-20060707", "StudyTime": "100000-180000"},
                limit=0, **kw))

        assert ids() == ["P500", "P502"], f"default must intersect: {ids()}"
        assert ids(combined_datetime=True) == ["P500", "P501", "P502"]

        # count() must agree with the query it is counting, or QIDO-RS reports a
        # total for a result set the body does not contain.
        flt = {"StudyDate": "20060705-20060707", "StudyTime": "100000-180000"}
        assert env.idx.count("study", flt) == 2
        assert env.idx.count("study", flt, combined_datetime=True) == 3

        # Every level takes the same switch; series/instance queries of a study
        # must not answer a wider question than the study query did.
        assert len(env.idx.query_series(filters=flt, limit=0)) == 2
        assert len(env.idx.query_series(filters=flt, limit=0, combined_datetime=True)) == 3
        assert len(env.idx.query_instances(filters=flt, limit=0)) == 2
        assert len(env.idx.query_instances(filters=flt, limit=0, combined_datetime=True)) == 3
    finally:
        env.close()


def test_combined_date_time_range():
    """With the option on, a DA range and its TM range are ONE DateTime window.
    Read as two independent windows an overnight query has an empty
    intersection, which is exactly why an SCU has to negotiate for this."""
    env = Env()
    try:
        _clock(env, "P200", "1.2.200", "20240110", "101500")   # before the window opens
        _clock(env, "P201", "1.2.201", "20240220", "084500")   # inside it
        _clock(env, "P202", "1.2.202", "20250315", "150000")   # after it closes
        _clock(env, "P203", "1.2.203", "20240201", "030000")   # a 3am night-shift study

        def ids(date, tm, combined=True):
            return sorted(s["PatientID"] for s in env.idx.query_studies(
                {"StudyDate": date, "StudyTime": tm}, limit=0,
                combined_datetime=combined))

        got = ids("20240110-20240220", "110000-090000")
        assert got == ["P201", "P203"], f"overnight window wrong: {got}"
        # The same overnight query without the option is an empty intersection.
        assert ids("20240110-20240220", "110000-090000", combined=False) == []

        # Same window one day narrower: only the boundary study survives.
        assert ids("20240220-20240220", "110000-090000") == []
        assert ids("20240219-20240220", "110000-090000") == ["P201"]

        # Only ONE side carrying a range is not a pair — each key still matches
        # on its own, with or without the option, so the two agree here.
        for c in (True, False):
            assert ids("20240110-20240220", "084500", combined=c) == ["P201"]
            assert ids("20240220", "080000-090000", combined=c) == ["P201"]

        # An open end of the DATE opens the combined bound; an open end of the
        # TIME alone only means "to the end of that day".
        assert ids("20240201-", "030000-") == ["P201", "P202", "P203"]
        assert ids("-20240201", "-030000") == ["P200", "P203"]
    finally:
        env.close()


def test_series_and_instances():
    env = Env()
    try:
        env.index_all()
        jane = env.info["studies"]["jane"]
        series = env.idx.query_series(jane["uid"])
        assert [s["SeriesNumber"] for s in series] == [1, 2]
        assert [s["Modality"] for s in series] == ["CT", "SR"]
        assert series[0]["NumberOfSeriesRelatedInstances"] == 3
        assert series[1]["NumberOfSeriesRelatedInstances"] == 2
        assert os.path.isdir(series[0]["path"])

        assert len(env.idx.query_series(filters={"Modality": "CT"})) == 1
        assert len(env.idx.query_series(filters={"Modality": ""})) == 4
        assert len(env.idx.query_series(jane["uid"], {"Modality": "SR"})) == 1
        assert len(env.idx.query_series(jane["uid"], {"SeriesNumber": "2"})) == 1

        inst = env.idx.query_instances(jane["uid"], jane["series"][0])
        assert [i["InstanceNumber"] for i in inst] == [1, 2, 3]
        assert inst[0]["SOPClassUID"] == CT_SOP
        assert inst[0]["TransferSyntaxUID"] == "1.2.840.10008.1.2.1"
        assert inst[0]["size"] > 0 and os.path.isfile(inst[0]["path"])

        sop = inst[1]["SOPInstanceUID"]
        assert env.idx.get_instance_path(sop) == inst[1]["path"]
        assert env.idx.get_instance(sop)["InstanceNumber"] == 2
        assert env.idx.get_instance_path("1.2.3.nope") is None

        # C-MOVE ordering: series then instance number.
        paths = env.idx.instance_paths(study_uid=jane["uid"])
        assert len(paths) == 5
        assert paths == env.idx.instance_paths(study_uid=jane["uid"])
        assert len(env.idx.instance_paths(series_uid=jane["series"][1])) == 2
        assert len(env.idx.instance_paths(sop_uid=sop)) == 1

        # A row whose file vanished is skipped, never served.
        os.remove(inst[1]["path"])
        assert env.idx.get_instance_path(sop) is None
        assert len(env.idx.instance_paths(study_uid=jane["uid"])) == 4
        assert len(env.idx.instance_paths(study_uid=jane["uid"], existing_only=False)) == 5
    finally:
        env.close()


def test_paging():
    env = Env()
    try:
        env.index_all()
        jane = env.info["studies"]["jane"]
        all_inst = env.idx.query_instances(jane["uid"])
        assert len(all_inst) == 5
        seen = []
        for off in (0, 2, 4):
            page = env.idx.query_instances(jane["uid"], limit=2, offset=off)
            seen.extend(i["SOPInstanceUID"] for i in page)
        assert seen == [i["SOPInstanceUID"] for i in all_inst]
        assert len(env.idx.query_studies(limit=2)) == 2
        assert len(env.idx.query_studies(limit=2, offset=2)) == 1
        assert len(env.idx.query_studies(limit=0)) == 3          # 0 = no limit
        assert env.idx.count("instance", study_uid=jane["uid"]) == 5
    finally:
        env.close()


def test_groups_and_dedup():
    env = Env()
    try:
        env.index_all("received")
        # The same instance archived under 'sent': a second file, one instance.
        src = env.info["paths"][0]
        dup = os.path.join(env.sent, "copy.dcm")
        shutil.copy2(src, dup)
        os.utime(dup, (time.time() + 10, time.time() + 10))
        assert env.idx.add_file(dup, "sent") is True

        st = env.idx.stats()
        assert st["files"] == 11 and st["instances"] == 10
        assert st["groups"] == {"received": 10, "sent": 1}

        sop = env.idx.query_instances(filters={"group": "sent"})[0]["SOPInstanceUID"]
        rows = env.idx.query_instances(filters={"SOPInstanceUID": sop})
        assert len(rows) == 1                    # deduped by SOPInstanceUID
        assert rows[0]["path"] == dup            # newest file wins
        assert env.idx.get_instance_path(sop, group="received") == src

        assert len(env.idx.query_studies({"group": "sent"})) == 1
        assert env.idx.remove_group("sent") == 1
        assert env.idx.stats()["files"] == 10
    finally:
        env.close()


def test_removals():
    env = Env()
    try:
        env.index_all()
        jane = env.info["studies"]["jane"]
        one = env.idx.query_instances(jane["uid"])[0]["path"]
        assert env.idx.remove_file(one) == 1
        assert env.idx.remove_file(one) == 0
        assert env.idx.stats()["files"] == 9

        study_dir = env.idx.query_studies({"StudyInstanceUID": jane["uid"]})[0]["path"]
        assert env.idx.remove_under(study_dir) == 4
        assert env.idx.query_studies({"StudyInstanceUID": jane["uid"]}) == []
        assert env.idx.clear() == 5
        assert env.idx.stats()["files"] == 0
    finally:
        env.close()


def test_rescan_incremental():
    env = Env()
    try:
        roots = {"received": env.received, "sent": env.sent}
        first = env.idx.rescan(roots)
        assert first["added"] == 10 and first["updated"] == 0
        assert first["skipped"] == 0 and first["removed"] == 0

        second = env.idx.rescan(roots)
        assert second["added"] == 0 and second["updated"] == 0
        assert second["skipped"] == 10 and second["removed"] == 0
        assert second["files"] == 10

        # A rewritten file is re-read; everything else is still skipped.
        target = env.info["paths"][0]
        os.utime(target, (time.time() + 5, time.time() + 5))
        third = env.idx.rescan(roots)
        assert third["updated"] == 1 and third["skipped"] == 9 and third["added"] == 0

        # A file moved to the archive shows up in its new group and leaves the old.
        moved = os.path.join(env.sent, os.path.basename(target))
        shutil.move(target, moved)
        fourth = env.idx.rescan(roots)
        assert fourth["added"] == 1 and fourth["removed"] == 1
        assert env.idx.stats()["groups"] == {"received": 9, "sent": 1}

        # Non-DICOM files are counted as skipped-unparseable, never fatal.
        with open(os.path.join(env.received, "readme.txt"), "w") as fh:
            fh.write("x" * 400)
        fifth = env.idx.rescan(roots)
        assert fifth["failed"] == 1 and fifth["added"] == 0
        assert env.idx.stats()["files"] == 10

        # A cancelled rescan must not purge: a partial walk cannot tell
        # "deleted" from "not reached yet".
        stop = threading.Event()
        stop.set()
        sixth = env.idx.rescan(roots, stop=stop)
        assert sixth["cancelled"] is True and sixth["removed"] == 0
        assert env.idx.stats()["files"] == 10
    finally:
        env.close()


def test_rescan_purges_deleted_files():
    env = Env()
    try:
        roots = {"received": env.received}
        env.idx.rescan(roots)
        shutil.rmtree(os.path.dirname(os.path.dirname(env.info["paths"][0])))
        res = env.idx.rescan(roots)
        assert res["removed"] == 5 and res["skipped"] == 5
        assert env.idx.stats()["studies"] == 2
    finally:
        env.close()


def test_rescan_sees_what_add_file_sees():
    """The purge may only delete rows for files the walk decided are GONE. A
    hidden file or folder the walk refuses to enter is not the same thing: it is
    still on disk, add_file still indexes it, and deleting its row would make a
    stored study unfindable."""
    env = Env()
    try:
        hidden = make_instance(
            os.path.join(env.received, ".staging"), patient_name="HID^DEN",
            patient_id="P900", study_uid="1.2.900", series_uid="1.2.900.1",
            sop_uid="1.2.900.1.1", modality="US", name=".hidden")
        assert os.path.basename(hidden).startswith(".")
        assert env.idx.add_file(hidden, "received") is True

        res = env.idx.rescan({"received": env.received})
        assert res["added"] == 10 and res["skipped"] == 1 and res["removed"] == 0
        assert env.idx.get_instance_path("1.2.900.1.1") == env.idx.norm_path(hidden)
        again = env.idx.rescan({"received": env.received})
        assert again["removed"] == 0 and again["skipped"] == 11
    finally:
        env.close()


def test_rescan_races_live_stores():
    """A rescan running while instances arrive must not purge the arrivals:
    a file created after the walk listed its directory is invisible to that
    walk, and deleting its row would un-find a study that is on disk."""
    env = Env(async_writes=True)
    try:
        roots = {"received": env.received}
        env.idx.rescan(roots)
        stop = threading.Event()
        stored = []

        def storer():
            i = 0
            while not stop.is_set() and i < 300:
                i += 1
                p = make_instance(
                    env.received, patient_name="LIVE^ONE", patient_id="P999",
                    study_uid=f"1.2.999.{i}", series_uid=f"1.2.9991.{i}",
                    sop_uid=f"1.2.9992.{i}", modality="US")
                env.idx.enqueue_file(p, "received")
                stored.append(p)

        t = threading.Thread(target=storer)
        t.start()
        passes = [env.idx.rescan(roots) for _ in range(3)]
        stop.set()
        t.join(timeout=30)
        assert not t.is_alive()
        assert env.idx.flush(timeout=30) is True
        on_disk = sum(1 for _dp, _dn, fs in os.walk(env.received) for _f in fs)
        assert env.idx.stats()["files"] == on_disk
        assert [p["removed"] for p in passes] == [0, 0, 0]
        assert env.idx.errors == 0
    finally:
        env.close()


def test_deleted_database_is_survivable():
    env = Env()
    try:
        env.index_all()
        assert env.idx.stats()["files"] == 10
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(env.db + suffix)
            except OSError:
                pass
        # Schema is recreated on demand; the index is empty but usable, and a
        # rescan puts it back.
        assert env.idx.query_studies() == []
        assert env.idx.add_file(env.info["paths"][0], "received") is True
        assert env.idx.stats()["files"] == 1
        assert env.idx.rescan({"received": env.received})["added"] == 9
        assert env.idx.stats()["files"] == 10
    finally:
        env.close()


def test_concurrent_writers():
    env = Env()
    try:
        errors: list[BaseException] = []
        barrier = threading.Barrier(6)

        def worker(chunk):
            try:
                barrier.wait(timeout=10)
                for p in chunk:
                    env.idx.add_file(p, "received")
                    env.idx.query_studies(limit=5)          # reads race the writes
            except BaseException as exc:                    # noqa: BLE001 - reported below
                errors.append(exc)

        paths = env.info["paths"]
        threads = [threading.Thread(target=worker, args=(paths[i::5],)) for i in range(5)]
        for t in threads:
            t.start()
        barrier.wait(timeout=10)
        for t in threads:
            t.join(timeout=30)
            assert not t.is_alive()
        assert errors == []
        assert env.idx.stats()["files"] == 10
        assert len(env.idx.query_studies()) == 3
    finally:
        env.close()


class _CaptureLog:
    def __init__(self):
        self.warns: list[str] = []

    def info(self, *a, **k): pass
    def warn(self, msg, *a, **k): self.warns.append(str(msg))
    def error(self, *a, **k): pass


def test_cold_boot_schema_is_atomic():
    """Every thread that first touches the database at once must end up with
    ONE schema, created once.

    Cold boot is the normal startup sequence — the rescan thread, the
    background writer, a QIDO request and the Q/R SCP all open their own
    connection within milliseconds of each other. When creating the table and
    stamping its version were two separate autocommitted statements, a thread
    sampling in between saw a table stamped version 0, read that as an obsolete
    layout, and DROPped the table another thread had just built: the queries
    already running against it died with "no such table: instances", and the
    log told the operator the schema had changed on a database that had never
    existed before."""
    for _ in range(8):
        d = tempfile.mkdtemp(prefix="carino-index-boot-")
        try:
            received = os.path.join(d, "received")
            os.makedirs(received)
            log = _CaptureLog()
            idx = InstanceIndex(os.path.join(d, "index.sqlite3"), log=log)
            errors: list[str] = []
            barrier = threading.Barrier(8)
            work = (
                lambda: idx.query_studies(limit=5),
                lambda: idx.query_series(limit=5),
                lambda: idx.query_instances(limit=5),
                lambda: idx.count("study"),
                lambda: idx.rescan({"received": received}),
                idx.stats,
                lambda: idx.clear(),
                lambda: idx.query_studies({"PatientID": "P001"}),
            )

            def worker(k):
                try:
                    barrier.wait(timeout=20)
                    work[k]()
                except BaseException as exc:            # noqa: BLE001 - reported below
                    errors.append(f"{type(exc).__name__}: {exc}")

            threads = [threading.Thread(target=worker, args=(k,)) for k in range(len(work))]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=30)
                assert not t.is_alive()
            assert errors == [], errors
            # A database that has just been created cannot have been rebuilt,
            # and nobody should have been told to rescan.
            assert idx.stats()["rebuilt"] is False
            assert log.warns == [], log.warns
            assert idx.errors == 0
            idx.close()
        finally:
            shutil.rmtree(d, ignore_errors=True)


def test_background_writer():
    env = Env(async_writes=True)
    try:
        from pydicom import dcmread
        assert env.idx.writing is True

        def worker(chunk):
            for p in chunk:
                env.idx.enqueue_dataset(dcmread(p, stop_before_pixels=True), p, "received")

        paths = env.info["paths"]
        threads = [threading.Thread(target=worker, args=(paths[i::4],)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        assert env.idx.flush(timeout=10) is True
        assert env.idx.stats()["files"] == 10

        env.idx.enqueue_remove(paths[0])
        env.idx.enqueue_file(paths[0], "sent")
        assert env.idx.flush(timeout=10) is True
        assert env.idx.stats()["groups"] == {"received": 9, "sent": 1}

        # stop() must join AND write whatever is still queued.
        env.idx.enqueue_file(paths[1], "sent")
        env.idx.stop()
        assert env.idx.writing is False
        assert env.idx.stats()["groups"]["sent"] == 2
        assert env.idx.errors == 0

        # Restart is clean (fresh queue + event, no straggler resurrection).
        env.idx.start()
        assert env.idx.writing is True
        env.idx.enqueue_file(paths[2], "sent")
        assert env.idx.flush(timeout=10) is True
        assert env.idx.stats()["groups"]["sent"] == 3
    finally:
        env.close()


def test_memory_index():
    """The :memory: mode is what unit tests and one-shot tools use; it must
    share one connection instead of handing each thread an empty database."""
    env = Env()
    try:
        idx = InstanceIndex(":memory:")
        for p in env.info["paths"]:
            idx.add_file(p, "received")
        done = []

        def worker():
            done.append(len(idx.query_studies()))
        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
        assert done == [3, 3, 3, 3]
        assert idx.stats()["files"] == 10
        idx.close()
    finally:
        env.close()


if __name__ == "__main__":
    fns = [(n, f) for n, f in sorted(globals().items())
           if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in fns:
        t0 = time.time()
        try:
            fn()
            print(f"  ok   {name}  ({time.time() - t0:.2f}s)")
        except BaseException as exc:
            failed += 1
            print(f"  FAIL {name}: {type(exc).__name__}: {exc}")
            import traceback
            traceback.print_exc()
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
