"""End-to-end tests for the Query/Retrieve SCP.

Drives real pynetdicom Q/R SCUs against a live :class:`~pacs.qr.QrSCP` backed by
a real sqlite index and real files on disk. Covers:

  1. C-FIND STUDY level: wildcards, universal keys, return-keys-only responses
  2. C-FIND date ranges (closed and open-ended), and open-ended TIME ranges
  3. C-FIND DA+TM ranges: the attribute-independent default over DIMSE, and the
     Combined Date and Time reading the index can do when it is negotiated
     (both halves of PS3.4 C.2.2.2.5.4, on the standard's own worked example)
  4. C-FIND SERIES and IMAGE levels
  5. C-FIND PATIENT level (Patient Root) + refusal on Study Root
  6. C-FIND 0xFF01 when a match key (including a sequence) had to be dropped,
     and when an Optional return key had to be omitted (PS3.4 C.2.2.1.3)
  7. C-MOVE to a real StorageSCP, with sub-operation counts
  8. C-MOVE to an unknown destination -> 0xA801, and via the fallback list
  9. C-MOVE where a file vanished -> warning + FailedSOPInstanceUIDList
 10. C-MOVE refused against a storage-only destination -> 0xA900, not 0xA801
 11. C-GET on the same association (SCP/SCU role negotiation)
 12. allowed_aets rejection, and refusal of a keyless retrieve identifier
 13. C-CANCEL and stop() mid-query; stop/restart on the same port

Run:  python3 tests/test_qr.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import (
    ExplicitVRLittleEndian,
    SecondaryCaptureImageStorage,
    generate_uid,
)
from pynetdicom import AE, build_role, evt
from pynetdicom.sop_class import (
    PatientRootQueryRetrieveInformationModelFind,
    StudyRootQueryRetrieveInformationModelFind,
    StudyRootQueryRetrieveInformationModelGet,
    StudyRootQueryRetrieveInformationModelMove,
)

from pacs.index import InstanceIndex
from pacs.logbuf import LogBuffer
from pacs.qr import QrSCP
from pacs.scp import StorageSCP

SCU_AET = "WORKSTATION1"
QR_AET = "CARINOQR"
DEST_AET = "REMOTEPACS"

_PORT = 11400


def _next_port() -> int:
    global _PORT
    _PORT += 1
    return _PORT


# ------------------------------------------------------------------ fixtures
def _write_instance(root: str, **kw) -> str:
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.SOPClassUID = SecondaryCaptureImageStorage
    ds.SOPInstanceUID = kw.get("sop_uid") or generate_uid()
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    for key, val in kw.items():
        if key != "sop_uid":
            setattr(ds, key, val)
    path = os.path.join(root, ds.SeriesInstanceUID, ds.SOPInstanceUID + ".dcm")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    ds.save_as(path, enforce_file_format=True)
    return path


class Fixture:
    """Three studies across two patients, indexed and on disk."""

    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="carinoqr-test-")
        self.root = os.path.join(self.tmp, "received")
        os.makedirs(self.root, exist_ok=True)
        self.log = LogBuffer()
        self.index = InstanceIndex(os.path.join(self.tmp, "index.db"), self.log)
        self.paths: dict = {}

        # Patient P001 — two studies, one of them two series of two instances.
        self.study_ct = generate_uid()
        s1, s2 = generate_uid(), generate_uid()
        for series, num in ((s1, 1), (s2, 2)):
            for inst in (1, 2):
                self._add(PatientName="DOE^JANE", PatientID="P001",
                          StudyInstanceUID=self.study_ct, SeriesInstanceUID=series,
                          StudyDate="20240110", StudyTime="101500", Modality="CT",
                          AccessionNumber="ACC1", StudyDescription="CHEST CT",
                          SeriesDescription=f"AXIAL {num}", SeriesNumber=num,
                          InstanceNumber=inst)
        self.series_ct1 = s1

        self.study_mr = generate_uid()
        self._add(PatientName="DOE^JANE", PatientID="P001",
                  StudyInstanceUID=self.study_mr, SeriesInstanceUID=generate_uid(),
                  StudyDate="20240220", StudyTime="084500", Modality="MR",
                  AccessionNumber="ACC2", StudyDescription="HEAD MR",
                  SeriesDescription="T1", SeriesNumber=1, InstanceNumber=1)

        self.study_xr = generate_uid()
        series_xr = generate_uid()
        for inst in (1, 2, 3):
            self._add(PatientName="SMITH^JOHN", PatientID="P002",
                      StudyInstanceUID=self.study_xr, SeriesInstanceUID=series_xr,
                      StudyDate="20250315", StudyTime="150000", Modality="CR",
                      AccessionNumber="ACC3", StudyDescription="KNEE XR",
                      SeriesDescription="AP", SeriesNumber=1, InstanceNumber=inst)

    def add_ps34_example(self) -> dict:
        """The four studies PS3.4 C.2.2.2.5.4 spells its DA+TM worked example
        out on: 5 Jul 14:00, 6 Jul 03:00, 6 Jul 14:00, 7 Jul 23:00. Kept off the
        default fixture so the counter assertions elsewhere stay readable."""
        out = {}
        for name, date, tm in (("jul5_1400", "20060705", "140000"),
                               ("jul6_0300", "20060706", "030000"),
                               ("jul6_1400", "20060706", "140000"),
                               ("jul7_2300", "20060707", "230000")):
            uid = generate_uid()
            out[name] = uid
            self._add(PatientName="RANGE^EXAMPLE", PatientID="P003",
                      StudyInstanceUID=uid, SeriesInstanceUID=generate_uid(),
                      StudyDate=date, StudyTime=tm, Modality="OT",
                      AccessionNumber="ACC4", StudyDescription="RANGE EXAMPLE",
                      SeriesDescription="EX", SeriesNumber=1, InstanceNumber=1)
        return out

    def _add(self, **kw) -> None:
        path = _write_instance(self.root, **kw)
        self.index.add_file(path, "received")
        self.paths.setdefault(kw["StudyInstanceUID"], []).append(path)

    def close(self) -> None:
        self.index.close()


def _start_qr(fx: Fixture, **kw) -> QrSCP:
    scp = QrSCP(aet=QR_AET, bind="127.0.0.1", port=_next_port(), log=fx.log,
                index=fx.index, **kw)
    scp.start()
    time.sleep(0.3)
    assert scp.running, "QR SCP did not start"
    return scp


def _find(port: int, query: Dataset, model=StudyRootQueryRetrieveInformationModelFind,
          aet: str = SCU_AET) -> list:
    ae = AE(ae_title=aet)
    ae.add_requested_context(model)
    assoc = ae.associate("127.0.0.1", port, ae_title=QR_AET)
    assert assoc.is_established, "SCU could not associate for C-FIND"
    try:
        out = []
        for status, identifier in assoc.send_c_find(query, model):
            out.append((status.Status if status else None, identifier))
        return out
    finally:
        assoc.release()


def _matches(replies: list) -> list:
    # 0xFF01 is a pending too — "matches are continuing, but an optional key was
    # not supported" — so a match is a match under either pending status.
    return [ds for st, ds in replies if st in (0xFF00, 0xFF01) and ds is not None]


def _pendings(replies: list) -> list:
    return [st for st, ds in replies if st in (0xFF00, 0xFF01)]


def _final(replies: list):
    return replies[-1][0] if replies else None


# --------------------------------------------------------------------- C-FIND
def test_find_study_wildcard():
    fx = Fixture()
    scp = _start_qr(fx)
    try:
        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.PatientName = "DOE*"
        q.PatientID = ""
        q.StudyInstanceUID = ""
        q.StudyDate = ""
        q.StudyDescription = ""
        q.ModalitiesInStudy = ""
        q.NumberOfStudyRelatedInstances = ""
        q.InstitutionName = ""              # we cannot answer this one
        replies = _find(scp.port, q)
        rows = _matches(replies)
        assert len(rows) == 2, f"expected 2 studies for DOE*, got {len(rows)}"
        assert _final(replies) == 0x0000, f"final status {_final(replies):#06x}"

        by_uid = {str(r.StudyInstanceUID): r for r in rows}
        ct = by_uid[fx.study_ct]
        assert str(ct.QueryRetrieveLevel) == "STUDY", "level missing from response"
        assert str(ct.StudyDescription) == "CHEST CT", ct.StudyDescription
        assert int(ct.NumberOfStudyRelatedInstances) == 4, ct.NumberOfStudyRelatedInstances
        assert str(ct.ModalitiesInStudy) == "CT", ct.ModalitiesInStudy
        # PS3.4 C.2.2.1.3: an Optional Key the SCP cannot support SHALL NOT be
        # returned. Zero-length would say "we looked, this study has no
        # institution", which is a different and untrue claim.
        assert "InstitutionName" not in ct, \
            "an unsupportable Optional Key must be omitted, not returned zero-length"
        assert _pendings(replies) == [0xFF01] * 2, \
            f"omitting a return key must be flagged: {[hex(s) for s in _pendings(replies)]}"
        # Return-keys-only: nothing the SCU did not ask for (bar the level and
        # character set) may appear.
        extra = {e.keyword for e in ct} - {
            "QueryRetrieveLevel", "SpecificCharacterSet", "PatientName", "PatientID",
            "StudyInstanceUID", "StudyDate", "StudyDescription", "ModalitiesInStudy",
            "NumberOfStudyRelatedInstances"}
        assert not extra, f"response carries unrequested keys: {extra}"

        # Universal matching: an all-empty identifier returns every study. Every
        # key in it is one we support, so the pendings stay plain 0xFF00 — some
        # SCUs treat anything else as terminal, so this is not a detail.
        q2 = Dataset()
        q2.QueryRetrieveLevel = "STUDY"
        q2.StudyInstanceUID = ""
        replies2 = _find(scp.port, q2)
        assert len(_matches(replies2)) == 3, "universal query did not return all"
        assert _pendings(replies2) == [0xFF00] * 3, \
            f"a fully supported query must stay 0xFF00: {[hex(s) for s in _pendings(replies2)]}"

        # '?' single-character wildcard on the accession number.
        q3 = Dataset()
        q3.QueryRetrieveLevel = "STUDY"
        q3.AccessionNumber = "ACC?"
        q3.StudyInstanceUID = ""
        assert len(_matches(_find(scp.port, q3))) == 3, "'?' wildcard did not match"

        assert scp.query_count == 3 and scp.match_count == 8, \
            f"counters wrong: {scp.query_count} queries / {scp.match_count} matches"
        print("  [1] C-FIND STUDY: wildcards, universal keys, return-keys-only OK")
    finally:
        scp.stop()
        fx.close()


def test_find_date_range():
    fx = Fixture()
    scp = _start_qr(fx)
    try:
        def dates(value):
            q = Dataset()
            q.QueryRetrieveLevel = "STUDY"
            q.StudyDate = value
            q.StudyInstanceUID = ""
            return {str(r.StudyInstanceUID) for r in _matches(_find(scp.port, q))}

        assert dates("20240101-20240131") == {fx.study_ct}, "closed range wrong"
        assert dates("20240101-20241231") == {fx.study_ct, fx.study_mr}, "wide range wrong"
        assert dates("20250101-") == {fx.study_xr}, "open-ended start wrong"
        assert dates("-20240115") == {fx.study_ct}, "open-ended end wrong"
        assert dates("20240220") == {fx.study_mr}, "exact date wrong"
        assert dates("20990101-20991231") == set(), "future range should match nothing"

        # A UID list (backslash separated) is a match on any of them.
        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.StudyInstanceUID = [fx.study_mr, fx.study_xr]
        got = {str(r.StudyInstanceUID) for r in _matches(_find(scp.port, q))}
        assert got == {fx.study_mr, fx.study_xr}, f"UID list matching wrong: {got}"
        print("  [2] C-FIND date ranges (closed/open/exact) + UID list matching OK")
    finally:
        scp.stop()
        fx.close()


def test_find_open_ended_time_range():
    """An open-ended TM range must stay open. With the empty bound padded out to
    '000000' the query became a BETWEEN whose top is below its bottom, so a real
    SCU asking for "anything from 15:00 on" got told the archive is empty."""
    fx = Fixture()
    scp = _start_qr(fx)
    try:
        def times(value):
            q = Dataset()
            q.QueryRetrieveLevel = "STUDY"
            q.StudyTime = value
            q.StudyInstanceUID = ""
            return {str(r.StudyInstanceUID) for r in _matches(_find(scp.port, q))}

        # Fixture clocks: CT 10:15:00, MR 08:45:00, XR 15:00:00.
        assert times("150000-") == {fx.study_xr}, f"open upper bound: {times('150000-')}"
        assert times("084500-") == {fx.study_ct, fx.study_mr, fx.study_xr}, "open from 08:45"
        assert times("-101500") == {fx.study_ct, fx.study_mr}, "open lower bound"
        assert times("1500-") == {fx.study_xr}, "4-digit device time, open upper bound"
        assert times("084500-101500") == {fx.study_ct, fx.study_mr}, "closed range"
        assert times("160000-") == set(), "nothing is that late"
        print("  [3] C-FIND open-ended TIME ranges stay open at both ends OK")
    finally:
        scp.stop()
        fx.close()


def test_find_date_time_range_is_attribute_independent():
    """PS3.4 C.2.2.2.5.4: over plain DIMSE a DA range and the TM range of the
    same entity are matched INDEPENDENTLY and the results intersect — the pair
    is only folded into one DateTime span when the SCU has negotiated Combined
    Date and Time Matching (PS3.4 C.4.1.1.3.1), and this SCP performs no
    Extended Negotiation at all.

    The standard's own worked example is the assertion below: four studies at
    5 Jul 14:00, 6 Jul 03:00, 6 Jul 14:00 and 7 Jul 23:00, queried with
    StudyDate=20060705-20060707 and StudyTime=100000-180000. The required
    default answer is the three daily 10:00-18:00 windows, i.e. the two 14:00
    studies — NOT the single span from the 5th at 10:00 to the 7th at 18:00,
    which would also drag in the 6 Jul 03:00 study the SCU never asked for.
    Widening a query on the SCU's behalf is the one direction it must never
    drift: the operator sees studies they did not ask for and trusts the filter
    less, or worse, stops reading past the first screen of them."""
    fx = Fixture()
    ex = fx.add_ps34_example()
    scp = _start_qr(fx)
    try:
        def window(date, tm):
            q = Dataset()
            q.QueryRetrieveLevel = "STUDY"
            q.StudyDate = date
            q.StudyTime = tm
            q.StudyInstanceUID = ""
            return {str(r.StudyInstanceUID) for r in _matches(_find(scp.port, q))}

        got = window("20060705-20060707", "100000-180000")
        assert got == {ex["jul5_1400"], ex["jul6_1400"]}, \
            f"PS3.4 C.2.2.2.5.4 default answer wrong: {sorted(got)}"

        # Same rule on the ordinary fixture: 09:00-16:00 across the whole span
        # keeps the CT (10:15) and the XR (15:00) and drops the MR (08:45),
        # which the combined reading of the very same identifier would have kept.
        assert window("20240110-20250315", "090000-160000") == {fx.study_ct, fx.study_xr}, \
            "independent DA/TM matching must drop the 08:45 study"

        # One side not a range is not a pair either way: each key matches alone.
        assert window("20240110-20240220", "084500") == {fx.study_mr}, "single TM value"
        assert window("20240110", "100000-110000") == {fx.study_ct}, "single DA value"
        print("  [4] C-FIND DA+TM ranges match independently by default "
              "(PS3.4 C.2.2.2.5.4) OK")
    finally:
        scp.stop()
        fx.close()


def test_combined_date_time_is_the_negotiated_reading():
    """The other half of PS3.4 C.2.2.2.5.4, asserted here so the suite records
    the distinction instead of losing it.

    Combined Date and Time Matching folds the DA range and the TM range into a
    SINGLE span — on the standard's worked example, from the 5th at 10:00 to the
    7th at 18:00, which is a strictly wider answer than the default. The index
    implements it behind ``combined_datetime=True``; :mod:`pacs.qr` never passes
    it, because an SCP may only use this reading when the SCU asked for it
    through Extended Negotiation, which nothing here offers or accepts. If this
    SCP ever grows Extended Negotiation, THIS is the answer it then owes."""
    fx = Fixture()
    ex = fx.add_ps34_example()
    scp = _start_qr(fx)
    try:
        filters = {"StudyDate": "20060705-20060707", "StudyTime": "100000-180000"}

        def uids(**kw):
            return {r["StudyInstanceUID"]
                    for r in fx.index.query_studies(filters, limit=0, **kw)}

        # Negotiated: one span, so the 6 Jul 03:00 study is inside it.
        assert uids(combined_datetime=True) == {
            ex["jul5_1400"], ex["jul6_0300"], ex["jul6_1400"]}, \
            "combined DA+TM span wrong"
        # Default: the three daily windows, same as the wire.
        assert uids(combined_datetime=False) == {ex["jul5_1400"], ex["jul6_1400"]}, \
            "index default is not the attribute-independent reading"

        # And the DIMSE SCP really does take the default path — same identifier,
        # narrower answer, because it never negotiated the combined one.
        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.StudyDate = "20060705-20060707"
        q.StudyTime = "100000-180000"
        q.StudyInstanceUID = ""
        wire = {str(r.StudyInstanceUID) for r in _matches(_find(scp.port, q))}
        assert wire == {ex["jul5_1400"], ex["jul6_1400"]}, \
            f"C-FIND used the negotiated reading unasked: {sorted(wire)}"

        # Fixture cross-check: the 08:45 MR that independent matching drops is
        # exactly what the combined span pulls back in.
        span = {"StudyDate": "20240110-20250315", "StudyTime": "090000-160000"}
        got = {r["StudyInstanceUID"] for r in
               fx.index.query_studies(span, limit=0, combined_datetime=True)}
        assert got == {fx.study_ct, fx.study_mr, fx.study_xr}, \
            f"combined span over the fixture wrong: {sorted(got)}"
        print("  [5] combined DA+TM is available but negotiated-only; C-FIND "
              "does not use it OK")
    finally:
        scp.stop()
        fx.close()


def test_find_series_and_image():
    fx = Fixture()
    scp = _start_qr(fx)
    try:
        q = Dataset()
        q.QueryRetrieveLevel = "SERIES"
        q.StudyInstanceUID = fx.study_ct
        q.SeriesInstanceUID = ""
        q.Modality = ""
        q.SeriesNumber = ""
        q.SeriesDescription = ""
        q.NumberOfSeriesRelatedInstances = ""
        rows = _matches(_find(scp.port, q))
        assert len(rows) == 2, f"expected 2 series, got {len(rows)}"
        assert {str(r.Modality) for r in rows} == {"CT"}, "series modality wrong"
        assert {int(r.NumberOfSeriesRelatedInstances) for r in rows} == {2}, \
            "series instance counts wrong"
        assert all(str(r.StudyInstanceUID) == fx.study_ct for r in rows), \
            "series response must carry the study's unique key"

        q = Dataset()
        q.QueryRetrieveLevel = "IMAGE"
        q.StudyInstanceUID = fx.study_ct
        q.SeriesInstanceUID = fx.series_ct1
        q.SOPInstanceUID = ""
        q.InstanceNumber = ""
        rows = _matches(_find(scp.port, q))
        assert len(rows) == 2, f"expected 2 instances, got {len(rows)}"
        assert sorted(int(r.InstanceNumber) for r in rows) == [1, 2], "instance numbers wrong"

        # A series-level key on a STUDY query selects the study without
        # shrinking its counts.
        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.ModalitiesInStudy = "CT"
        q.StudyInstanceUID = ""
        q.NumberOfStudyRelatedInstances = ""
        rows = _matches(_find(scp.port, q))
        assert len(rows) == 1 and int(rows[0].NumberOfStudyRelatedInstances) == 4, \
            "modality filter shrank the study's instance count"
        print("  [6] C-FIND SERIES + IMAGE levels, counts intact under filters OK")
    finally:
        scp.stop()
        fx.close()


def test_find_patient_level():
    fx = Fixture()
    scp = _start_qr(fx)
    try:
        q = Dataset()
        q.QueryRetrieveLevel = "PATIENT"
        q.PatientID = ""
        q.PatientName = ""
        q.NumberOfPatientRelatedStudies = ""
        q.NumberOfPatientRelatedInstances = ""
        rows = _matches(_find(scp.port, q, PatientRootQueryRetrieveInformationModelFind))
        assert len(rows) == 2, f"expected 2 patients, got {len(rows)}"
        by_id = {str(r.PatientID): r for r in rows}
        assert int(by_id["P001"].NumberOfPatientRelatedStudies) == 2, by_id["P001"]
        assert int(by_id["P001"].NumberOfPatientRelatedInstances) == 5, by_id["P001"]
        assert int(by_id["P002"].NumberOfPatientRelatedInstances) == 3, by_id["P002"]

        # Study Root has no patient level — the query must be refused, not
        # silently answered as if it were a study query.
        replies = _find(scp.port, q, StudyRootQueryRetrieveInformationModelFind)
        assert _final(replies) == 0xC000, f"expected 0xC000, got {_final(replies):#06x}"
        assert not _matches(replies), "refused query must not return matches"
        print("  [7] C-FIND PATIENT level aggregates; Study Root refuses it OK")
    finally:
        scp.stop()
        fx.close()


def test_find_dropped_key_is_reported():
    """A match key we cannot honour widens the result set. The SCU has to be
    told, and 0xFF01 is how PS3.4 C.4.1.1.4 says to tell it — otherwise the
    wider answer looks like the archive's honest reply to the filter it sent."""
    fx = Fixture()
    scp = _start_qr(fx)
    try:
        item = Dataset()
        item.CodeValue = "24627-2"
        item.CodingSchemeDesignator = "LN"
        item.CodeMeaning = "CT Chest"

        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.InstitutionName = "MERCY GENERAL"     # a match key we cannot answer
        q.ProcedureCodeSequence = [item]        # sequence matching is not implemented
        q.StudyInstanceUID = ""
        replies = _find(scp.port, q)
        rows = _matches(replies)
        assert len(rows) == 3, f"both keys dropped, so all 3 studies come back: {len(rows)}"
        assert _pendings(replies) == [0xFF01] * 3, \
            f"dropped keys must be flagged: {[hex(s) for s in _pendings(replies)]}"
        assert _final(replies) == 0x0000, f"final status {_final(replies):#06x}"

        warned = [e["message"] for e in fx.log.tail(200)
                  if "unsupported match key" in e["message"]]
        assert warned, "the dropped keys were never logged"
        assert "InstitutionName" in warned[-1] and "ProcedureCodeSequence" in warned[-1], \
            f"log names the wrong keys: {warned[-1]}"

        # A zero-item sequence is NOT a dropped match key — it filters nothing,
        # so it must not be blamed for widening the results. It is still an
        # Optional *return* key we cannot build, which is the other reason for
        # 0xFF01, so the status is the same and the log entry is not.
        q2 = Dataset()
        q2.QueryRetrieveLevel = "STUDY"
        q2.PatientName = "DOE*"
        q2.ProcedureCodeSequence = []
        q2.StudyInstanceUID = ""
        before = len(fx.log.tail(500))
        replies2 = _find(scp.port, q2)
        assert len(_matches(replies2)) == 2, "the empty sequence changed the match set"
        assert _pendings(replies2) == [0xFF01] * 2, \
            f"an unbuildable return key is still 0xFF01: {[hex(s) for s in _pendings(replies2)]}"
        fresh = [e["message"] for e in fx.log.tail(500)[before:]]
        assert not any("unsupported match key" in m for m in fresh), \
            f"an empty sequence must not be reported as a dropped MATCH key: {fresh}"
        assert any("unsupported return key" in m and "ProcedureCodeSequence" in m
                   for m in fresh), f"the omitted return key was never logged: {fresh}"

        # And the control: every key supported, so plain 0xFF00.
        q3 = Dataset()
        q3.QueryRetrieveLevel = "STUDY"
        q3.PatientName = "DOE*"
        q3.StudyInstanceUID = ""
        q3.StudyDate = ""
        q3.AccessionNumber = ""
        assert _pendings(_find(scp.port, q3)) == [0xFF00] * 2, \
            "a fully supported query must not be downgraded to 0xFF01"
        print("  [8] C-FIND reports dropped match keys (incl. sequences) as 0xFF01 OK")
    finally:
        scp.stop()
        fx.close()


def test_find_unsupported_return_keys_are_omitted():
    """PS3.4 C.2.2.1.3: Optional Keys the SCP does not support SHALL NOT be
    returned. Table C.4-1 then reserves 0xFF00 for responses in which every
    Optional Key WAS supported, and gives 0xFF01 for the rest.

    Returning them present-but-zero-length instead is worse than it sounds: the
    SCU cannot tell "this archive does not index birth dates" from "this patient
    has no birth date", so a demographic mismatch that should have been caught
    reads as a clean match. These six are precisely the study-level attributes
    the index has no column for."""
    fx = Fixture()
    scp = _start_qr(fx)
    try:
        unheld = ["ReferringPhysicianName", "InstitutionName", "PatientBirthDate",
                  "PatientSex", "StudyID", "NameOfPhysiciansReadingStudy"]
        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.StudyInstanceUID = fx.study_ct
        q.StudyDate = ""
        q.PatientName = ""
        for kw in unheld:
            setattr(q, kw, "")
        replies = _find(scp.port, q)
        rows = _matches(replies)
        assert len(rows) == 1, f"expected the one CT study, got {len(rows)}"
        ds = rows[0]
        still_there = [kw for kw in unheld if kw in ds]
        assert not still_there, \
            f"unsupported Optional Keys came back anyway: {still_there}"
        assert _pendings(replies) == [0xFF01], \
            f"omitted Optional Keys must give 0xFF01: {[hex(s) for s in _pendings(replies)]}"
        assert _final(replies) == 0x0000, f"final status {_final(replies):#06x}"

        # The keys we DO hold are unaffected.
        assert str(ds.StudyDate) == "20240110", ds.StudyDate
        assert str(ds.PatientName) == "DOE^JANE", ds.PatientName

        # The other half of the rule: a key the index DOES hold but has no value
        # for on this study comes back present and zero-length. "We looked and
        # there is nothing" is a true answer, and it is not the same answer as
        # "we cannot answer that" — which is the whole point of the distinction.
        blank = generate_uid()
        fx._add(PatientName="NULL^DESC", PatientID="P004", StudyInstanceUID=blank,
                SeriesInstanceUID=generate_uid(), StudyDate="20240401",
                StudyTime="120000", Modality="OT", SeriesNumber=1, InstanceNumber=1)
        q2 = Dataset()
        q2.QueryRetrieveLevel = "STUDY"
        q2.StudyInstanceUID = blank
        q2.StudyDescription = ""
        q2.AccessionNumber = ""
        replies2 = _find(scp.port, q2)
        row2 = _matches(replies2)[0]
        assert "StudyDescription" in row2 and not str(row2.StudyDescription or ""), \
            "a supported key with no value must be present and zero-length"
        assert "AccessionNumber" in row2, "supported keys must still be returned"
        assert _pendings(replies2) == [0xFF00], \
            f"empty values are not unsupported keys: {[hex(s) for s in _pendings(replies2)]}"

        # SERIES level has its own idea of what is supported: the index's series
        # rows carry no patient demographics, so PatientName is an unsupportable
        # Optional Key there even though STUDY level answers it fine.
        q3 = Dataset()
        q3.QueryRetrieveLevel = "SERIES"
        q3.StudyInstanceUID = fx.study_ct
        q3.SeriesInstanceUID = ""
        q3.PatientBirthDate = ""
        replies3 = _find(scp.port, q3)
        assert all("PatientBirthDate" not in r for r in _matches(replies3)), \
            "SERIES responses must not fake a birth date either"
        assert _pendings(replies3) == [0xFF01] * 2, \
            f"SERIES level status: {[hex(s) for s in _pendings(replies3)]}"

        logged = [e["message"] for e in fx.log.tail(300)
                  if "unsupported return key" in e["message"]]
        assert logged, "omitted return keys were never logged"
        assert "PatientBirthDate" in " ".join(logged), f"log names the wrong keys: {logged}"
        print("  [9] C-FIND omits unsupportable Optional Keys and says so with "
              "0xFF01 (PS3.4 C.2.2.1.3) OK")
    finally:
        scp.stop()
        fx.close()


# --------------------------------------------------------------------- C-MOVE
class _Receiver:
    """A real StorageSCP standing in for the move destination."""

    def __init__(self, log: LogBuffer):
        self.dir = tempfile.mkdtemp(prefix="carinoqr-dest-")
        self.port = _next_port()
        self.scp = StorageSCP(aet=DEST_AET, bind="127.0.0.1", port=self.port,
                              storage_dir=self.dir, organize=False, log=log)
        self.scp.start()
        time.sleep(0.3)

    def stored(self) -> int:
        return self.scp.received_count

    def close(self) -> None:
        self.scp.stop()


def _move(port: int, query: Dataset, dest: str = DEST_AET, aet: str = SCU_AET) -> list:
    ae = AE(ae_title=aet)
    ae.add_requested_context(StudyRootQueryRetrieveInformationModelMove)
    assoc = ae.associate("127.0.0.1", port, ae_title=QR_AET)
    assert assoc.is_established, "SCU could not associate for C-MOVE"
    try:
        return [(st.Status if st else None, st, ds) for st, ds in assoc.send_c_move(
            query, dest, StudyRootQueryRetrieveInformationModelMove)]
    finally:
        assoc.release()


def test_move_study():
    fx = Fixture()
    dest = _Receiver(fx.log)
    scp = _start_qr(fx, move_destinations={
        DEST_AET: {"host": "127.0.0.1", "port": dest.port, "aet": DEST_AET}})
    try:
        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.StudyInstanceUID = fx.study_ct
        replies = _move(scp.port, q)
        code, final, _ = replies[-1]
        assert code == 0x0000, f"C-MOVE final status {code:#06x}"
        assert int(final.NumberOfCompletedSuboperations) == 4, final
        assert int(final.NumberOfFailedSuboperations) == 0, final
        assert int(final.NumberOfWarningSuboperations) == 0, final
        time.sleep(0.3)
        assert dest.stored() == 4, f"destination stored {dest.stored()} of 4"

        # Pending responses must count down accurately.
        remaining = [int(st.NumberOfRemainingSuboperations) for c, st, _ in replies
                     if c == 0xFF00 and "NumberOfRemainingSuboperations" in st]
        assert remaining == [3, 2, 1, 0], f"remaining counts wrong: {remaining}"

        # SERIES level retrieves only that series.
        q = Dataset()
        q.QueryRetrieveLevel = "SERIES"
        q.StudyInstanceUID = fx.study_ct
        q.SeriesInstanceUID = fx.series_ct1
        code, final, _ = _move(scp.port, q)[-1]
        assert code == 0x0000 and int(final.NumberOfCompletedSuboperations) == 2, final
        assert scp.move_count == 2 and scp.sent_count == 6, \
            f"counters wrong: {scp.move_count} moves / {scp.sent_count} sent"
        print(" [10] C-MOVE STUDY + SERIES to a real Storage SCP, counts exact OK")
    finally:
        scp.stop()
        dest.close()
        fx.close()


def test_move_unknown_destination():
    fx = Fixture()
    scp = _start_qr(fx, move_destinations={})
    try:
        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.StudyInstanceUID = fx.study_ct
        code, _, _ = _move(scp.port, q, dest="NOSUCHAE")[-1]
        assert code == 0xA801, f"expected 0xA801 Move Destination unknown, got {code:#06x}"
        assert scp.refused_count == 1, "refusal not counted"
        assert scp.move_count == 0, "a refused move must not count as a move"
        print(" [11] C-MOVE to an unknown destination -> 0xA801, nothing crashed OK")
    finally:
        scp.stop()
        fx.close()


def test_move_destination_fallback():
    fx = Fixture()
    dest = _Receiver(fx.log)
    scp = _start_qr(fx, move_destinations={}, get_destinations=lambda: [
        {"name": "Main PACS", "host": "127.0.0.1", "port": dest.port, "aet": DEST_AET}])
    try:
        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.StudyInstanceUID = fx.study_mr
        code, final, _ = _move(scp.port, q)[-1]
        assert code == 0x0000 and int(final.NumberOfCompletedSuboperations) == 1, final
        print(" [12] C-MOVE resolves an AE from the ordinary destination list OK")
    finally:
        scp.stop()
        dest.close()
        fx.close()


def test_move_missing_file_is_reported():
    """A file the index knows about but that is gone from disk must be REPORTED,
    never quietly left out of the count."""
    fx = Fixture()
    dest = _Receiver(fx.log)
    scp = _start_qr(fx, move_destinations={
        DEST_AET: {"host": "127.0.0.1", "port": dest.port, "aet": DEST_AET}})
    try:
        victim = fx.paths[fx.study_ct][0]
        gone_uid = str(pydicom.dcmread(victim).SOPInstanceUID)
        os.remove(victim)

        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.StudyInstanceUID = fx.study_ct
        code, final, ident = _move(scp.port, q)[-1]
        assert code == 0xB000, f"expected 0xB000 warning, got {code:#06x}"
        assert int(final.NumberOfCompletedSuboperations) == 3, final
        assert int(final.NumberOfFailedSuboperations) == 1, final
        failed = [str(u) for u in (ident.FailedSOPInstanceUIDList
                                   if isinstance(ident.FailedSOPInstanceUIDList, (list, pydicom.multival.MultiValue))
                                   else [ident.FailedSOPInstanceUIDList])]
        assert failed == [gone_uid], f"failed UID list wrong: {failed}"
        assert scp.failed_count == 1, "failure not counted"
        assert any("could not be read" in e["message"] for e in fx.log.tail(200)), \
            "the missing instance was not logged as an error"
        print(" [13] C-MOVE with a vanished file: warning + failed UID list, nothing hidden OK")
    finally:
        scp.stop()
        dest.close()
        fx.close()


class _StorageOnlyReceiver:
    """A destination that speaks storage and nothing else — no Verification
    context. Plenty of real workstations and film printers are exactly this."""

    def __init__(self):
        self.port = _next_port()
        self.received: list[str] = []
        ae = AE(ae_title=DEST_AET)
        ae.add_supported_context(SecondaryCaptureImageStorage, ExplicitVRLittleEndian)
        self.server = ae.start_server(("127.0.0.1", self.port), block=False,
                                      evt_handlers=[(evt.EVT_C_STORE, self._store)])
        time.sleep(0.3)

    def _store(self, event) -> int:
        self.received.append(str(event.dataset.SOPInstanceUID))
        return 0x0000

    def close(self) -> None:
        self.server.shutdown()


def test_move_refusal_reaches_storage_only_destination():
    """The refusal path still has to open the sub-association, and if the
    destination accepts none of the contexts we propose the requestor aborts —
    which pynetdicom reports as 0xA801 'Move Destination unknown'. The SCU then
    goes looking at its destination table instead of at the identifier it sent."""
    fx = Fixture()
    dest = _StorageOnlyReceiver()
    scp = _start_qr(fx, move_destinations={
        DEST_AET: {"host": "127.0.0.1", "port": dest.port, "aet": DEST_AET}})
    try:
        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.PatientID = "P001"                # not a STUDY-level retrieve key
        code, final, _ = _move(scp.port, q)[-1]
        assert code == 0xA900, \
            f"expected 0xA900 for a bad identifier, got {code:#06x}"
        assert int(final.NumberOfFailedSuboperations) == 1, final
        assert dest.received == [], "a refused move must not send anything"

        # Same node, valid identifier: the real send is unaffected.
        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.StudyInstanceUID = fx.study_xr
        code, final, _ = _move(scp.port, q)[-1]
        assert code == 0x0000 and int(final.NumberOfCompletedSuboperations) == 3, final
        time.sleep(0.3)
        assert len(dest.received) == 3, f"destination stored {len(dest.received)} of 3"
        print(" [14] C-MOVE refusal to a storage-only node reports 0xA900, not 0xA801 OK")
    finally:
        scp.stop()
        dest.close()
        fx.close()


# ---------------------------------------------------------------------- C-GET
def test_get_study():
    fx = Fixture()
    scp = _start_qr(fx)
    received = []

    def handle_store(event):
        received.append(event.dataset.SOPInstanceUID)
        return 0x0000

    try:
        ae = AE(ae_title=SCU_AET)
        ae.add_requested_context(StudyRootQueryRetrieveInformationModelGet)
        ae.add_requested_context(SecondaryCaptureImageStorage, ExplicitVRLittleEndian)
        role = build_role(SecondaryCaptureImageStorage, scp_role=True)
        assoc = ae.associate("127.0.0.1", scp.port, ae_title=QR_AET, ext_neg=[role],
                             evt_handlers=[(evt.EVT_C_STORE, handle_store)])
        assert assoc.is_established, "SCU could not associate for C-GET"
        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.StudyInstanceUID = fx.study_xr
        replies = [(st.Status if st else None, st) for st, _ in assoc.send_c_get(
            q, StudyRootQueryRetrieveInformationModelGet)]
        assoc.release()
        code, final = replies[-1]
        assert code == 0x0000, f"C-GET final status {code:#06x}"
        assert int(final.NumberOfCompletedSuboperations) == 3, final
        assert len(received) == 3, f"received {len(received)} instances on the association"
        assert scp.get_count == 1 and scp.sent_count == 3, "C-GET counters wrong"
        print(" [15] C-GET returns instances on the same association OK")
    finally:
        scp.stop()
        fx.close()


# ------------------------------------------------------------------- refusals
def test_allowed_aets():
    fx = Fixture()
    scp = _start_qr(fx, allowed_aets=["GOODAE"])
    try:
        ae = AE(ae_title="BADAE")
        ae.add_requested_context(StudyRootQueryRetrieveInformationModelFind)
        assoc = ae.associate("127.0.0.1", scp.port, ae_title=QR_AET)
        assert not assoc.is_established, "an unlisted calling AE was let in"

        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.StudyInstanceUID = ""
        assert len(_matches(_find(scp.port, q, aet="GOODAE"))) == 3, \
            "the listed calling AE was refused"
        print(" [16] allowed_aets: unlisted AE rejected, listed AE served OK")
    finally:
        scp.stop()
        fx.close()


def test_keyless_retrieve_refused():
    """A retrieve identifier with no key for its level would select the whole
    archive. It must come back as a failure, not as an empty success."""
    fx = Fixture()
    dest = _Receiver(fx.log)
    scp = _start_qr(fx, move_destinations={
        DEST_AET: {"host": "127.0.0.1", "port": dest.port, "aet": DEST_AET}})
    try:
        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.PatientID = "P001"                # not a STUDY-level unique key
        code, final, _ = _move(scp.port, q)[-1]
        assert code == 0xA900, f"expected 0xA900, got {code:#06x}"
        assert int(final.NumberOfFailedSuboperations) == 1, final
        assert dest.stored() == 0, "a refused move must not send anything"

        # A well-formed identifier that simply matches nothing is a clean
        # success with zero sub-operations.
        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.StudyInstanceUID = "1.2.3.4.5.6.7.8.9"
        code, final, _ = _move(scp.port, q)[-1]
        assert code == 0x0000 and int(final.NumberOfCompletedSuboperations) == 0, final
        print(" [17] keyless retrieve refused (0xA900); no-match retrieve succeeds empty OK")
    finally:
        scp.stop()
        dest.close()
        fx.close()


class _StubEvent:
    """Just enough of a pynetdicom event to drive a handler generator directly.

    Cancellation over a real association is a race against how fast the SCP
    answers, which is exactly the kind of test that passes on a laptop and fails
    on a busy machine. Driving the generator gives a deterministic answer to the
    only question that matters: does the handler stop when told to."""

    def __init__(self, identifier):
        ns = types.SimpleNamespace
        self.identifier = identifier
        self.context = ns(abstract_syntax=StudyRootQueryRetrieveInformationModelFind)
        self.assoc = ns(requestor=ns(ae_title=SCU_AET, address="127.0.0.1"))
        self.is_cancelled = False


def test_find_cancel_and_stop():
    fx = Fixture()
    scp = _start_qr(fx)
    try:
        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.StudyInstanceUID = ""

        ev = _StubEvent(q)
        gen = scp._handle_find(ev)
        assert next(gen)[0] == 0xFF00, "first match should be pending"
        ev.is_cancelled = True
        status, ds = next(gen)
        assert status == 0xFE00 and ds is None, f"expected Cancel, got {status:#06x}"
        assert scp.match_count == 1, "cancelled query counted matches it never sent"

        # stop() must end an in-flight query too, not just close the port.
        ev2 = _StubEvent(q)
        gen2 = scp._handle_find(ev2)
        assert next(gen2)[0] == 0xFF00
        scp._stopping.set()
        assert next(gen2)[0] == 0xFE00, "in-flight query ignored the stop flag"
        print(" [18] C-FIND honours C-CANCEL and the stop flag mid-query OK")
    finally:
        scp._stopping.clear()
        scp.stop()
        fx.close()


def test_stop_joins_and_restarts():
    """stop() must not return while an association thread is still live, and a
    restart must bind cleanly (landmine: apply_config stops then starts)."""
    fx = Fixture()
    scp = _start_qr(fx)
    try:
        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.StudyInstanceUID = ""
        assert len(_matches(_find(scp.port, q))) == 3
        before = {t.ident for t in threading.enumerate()}
        scp.stop()
        assert not scp.running, "still running after stop()"
        leftover = [t.name for t in threading.enumerate()
                    if t.ident in before and "AcceptorThread" in t.name]
        assert not leftover, f"association threads outlived stop(): {leftover}"
        scp.start()
        time.sleep(0.3)
        assert scp.running, "could not restart on the same port"
        assert len(_matches(_find(scp.port, q))) == 3, "restarted SCP does not answer"
        print(" [19] stop() joins its associations and the port rebinds cleanly OK")
    finally:
        scp.stop()
        fx.close()


def main() -> int:
    tests = [test_find_study_wildcard, test_find_date_range,
             test_find_open_ended_time_range,
             test_find_date_time_range_is_attribute_independent,
             test_combined_date_time_is_the_negotiated_reading,
             test_find_series_and_image, test_find_patient_level,
             test_find_dropped_key_is_reported,
             test_find_unsupported_return_keys_are_omitted,
             test_move_study, test_move_unknown_destination,
             test_move_destination_fallback, test_move_missing_file_is_reported,
             test_move_refusal_reaches_storage_only_destination,
             test_get_study, test_allowed_aets, test_keyless_retrieve_refused,
             test_find_cancel_and_stop, test_stop_joins_and_restarts]
    failed = 0
    for t in tests:
        try:
            t()
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL {t.__name__}: {exc}", file=sys.stderr)
        except Exception as exc:            # a crash is a failure too
            failed += 1
            import traceback
            traceback.print_exc()
            print(f"  ERROR {t.__name__}: {exc}", file=sys.stderr)
    if failed:
        print(f"\nFAIL — {failed} of {len(tests)} Q/R scenarios failed.", file=sys.stderr)
        return 1
    print(f"\nPASS — all {len(tests)} Q/R scenarios green.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
