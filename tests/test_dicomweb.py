"""Tests for pacs.dicomweb (QIDO-RS / WADO-RS / STOW-RS).

Runs under pytest, or directly:  python3 tests/test_dicomweb.py
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import Flask
from pydicom import dcmread
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, JPEGBaseline8Bit, generate_uid

from pacs.config import Config
from pacs.dicomweb import _parse_multipart_related, create_blueprint
from pacs.index import InstanceIndex
from pacs.logbuf import LogBuffer
from pacs.scp import dest_path

CT_SOP = str(CTImageStorage)


def _save(ds, path: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    try:
        ds.save_as(path, enforce_file_format=True)      # pydicom >= 3
    except TypeError:
        ds.save_as(path, write_like_original=False)     # pydicom 2.x


def make_dataset(*, patient_name="Doe^Jane", patient_id="P1", study_uid=None,
                 series_uid=None, sop_uid=None, modality="CT", study_date="20240115",
                 study_time="101530", accession="ACC1", study_desc="Head CT",
                 series_desc="Axial", series_number=1, instance_number=1,
                 birth_date="19800101", rows=0, cols=0, frames=1,
                 transfer_syntax=ExplicitVRLittleEndian) -> FileDataset:
    sop_uid = sop_uid or generate_uid()
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = transfer_syntax
    ds = FileDataset("x", Dataset(), file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = sop_uid
    ds.StudyInstanceUID = study_uid or generate_uid()
    ds.SeriesInstanceUID = series_uid or generate_uid()
    ds.PatientName = patient_name
    ds.PatientID = patient_id
    ds.PatientBirthDate = birth_date
    ds.StudyDate = study_date
    ds.StudyTime = study_time
    ds.AccessionNumber = accession
    ds.StudyDescription = study_desc
    ds.SeriesDescription = series_desc
    ds.SeriesNumber = series_number
    ds.InstanceNumber = instance_number
    ds.Modality = modality
    if rows and cols:
        ds.Rows = rows
        ds.Columns = cols
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated = 8
        ds.BitsStored = 8
        ds.HighBit = 7
        ds.PixelRepresentation = 0
        if frames > 1:
            ds.NumberOfFrames = frames
        ds.PixelData = bytes(range(256)) * ((rows * cols * frames) // 256 + 1)
        ds.PixelData = ds.PixelData[:rows * cols * frames]
    return ds


class _Server:
    """The slice of PacsServer that pacs.dicomweb actually uses."""

    def __init__(self, root: str):
        self.root = root
        cfg_path = os.path.join(root, "config.json")
        with open(cfg_path, "w", encoding="utf-8") as fh:
            json.dump({"scp": {"storage_dir": "./received", "organize": True},
                       "scu": {"watch_dir": "./outgoing", "sent_dir": "./sent"},
                       "dicomweb": {"enabled": True, "allow_stow": True}}, fh)
        self.cfg = Config(cfg_path)
        self.log = LogBuffer()
        self.index = InstanceIndex(os.path.join(root, "index.db"), self.log)
        self.reconciled: list[str] = []

    def _reconcile_study(self, ds, path):
        self.reconciled.append(path)

    @property
    def storage(self) -> str:
        return self.cfg.resolved("scp", "storage_dir")

    def store(self, ds) -> str:
        """Put an instance on disk the way the receiver would, and index it."""
        path = dest_path(self.storage, ds, True)
        _save(ds, path)
        assert self.index.add_file(path, "received")
        return path

    def close(self):
        self.index.close()


class Env:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="carino-dicomweb-")
        self.server = _Server(self.dir)
        app = Flask(__name__)
        app.register_blueprint(create_blueprint(self.server))
        self.app = app
        self.client = app.test_client()

    def close(self):
        self.server.close()
        shutil.rmtree(self.dir, ignore_errors=True)


def _seed(env: Env) -> dict:
    """Two patients: one two-series CT study, one single-instance MR study."""
    st1, se1, se2 = generate_uid(), generate_uid(), generate_uid()
    ds_list = []
    for n in (1, 2):
        ds = make_dataset(patient_name="Smith^John", patient_id="P100", study_uid=st1,
                          series_uid=se1, modality="CT", instance_number=n,
                          rows=4, cols=4)
        env.server.store(ds)
        ds_list.append(ds)
    ds = make_dataset(patient_name="Smith^John", patient_id="P100", study_uid=st1,
                      series_uid=se2, modality="CT", series_number=2, instance_number=1,
                      series_desc="Coronal", rows=4, cols=4)
    env.server.store(ds)
    ds_list.append(ds)

    st2, se3 = generate_uid(), generate_uid()
    mr = make_dataset(patient_name="Nakamura^Kei", patient_id="P200", study_uid=st2,
                      series_uid=se3, modality="MR", accession="ACC2",
                      study_date="20240320", study_desc="Brain MR", rows=4, cols=4)
    env.server.store(mr)
    return {"ct_study": st1, "ct_series": se1, "ct_series2": se2, "mr_study": st2,
            "mr_series": se3, "ct": ds_list, "mr": mr}


def _get_json(resp) -> list:
    assert resp.status_code == 200, resp.get_data(as_text=True)
    assert resp.headers["Content-Type"].startswith("application/dicom+json")
    return json.loads(resp.get_data(as_text=True))


def _split_multipart(resp) -> list[bytes]:
    """Independent multipart splitter — deliberately NOT the module's own parser,
    so a bug in it cannot pass the test by agreeing with itself."""
    ctype = resp.headers["Content-Type"]
    m = re.search(r"boundary=([^;]+)", ctype)
    assert m, ctype
    sep = b"\r\n--" + m.group(1).strip('"').encode("ascii")
    segments = (b"\r\n" + resp.get_data()).split(sep)
    assert segments[0] == b"", segments[0][:80]
    assert segments[-1] == b"--\r\n", segments[-1][:80]
    out = []
    for seg in segments[1:-1]:
        head, marker, content = seg.partition(b"\r\n\r\n")
        assert marker and b"Content-Type:" in head, head[:80]
        out.append(content)
    return out


def _stow_body(blobs: list[bytes], boundary: bytes = b"carinotest",
               content_type: bytes = b"application/dicom") -> bytes:
    body = b""
    for blob in blobs:
        body += b"--" + boundary + b"\r\nContent-Type: " + content_type + b"\r\n\r\n" + blob + b"\r\n"
    return body + b"--" + boundary + b"--\r\n"


def _as_bytes(ds) -> bytes:
    import io
    buf = io.BytesIO()
    try:
        ds.save_as(buf, enforce_file_format=True)
    except TypeError:
        ds.save_as(buf, write_like_original=False)
    return buf.getvalue()


# ------------------------------------------------------------------ QIDO-RS
def test_qido_studies_json_model():
    env = Env()
    try:
        seed = _seed(env)
        objs = _get_json(env.client.get("/dicom-web/studies"))
        assert len(objs) == 2
        by_uid = {o["0020000D"]["Value"][0]: o for o in objs}
        ct = by_uid[seed["ct_study"]]
        # Keys are 8 hex digits, every element carries a VR.
        for key, el in ct.items():
            assert re.fullmatch(r"[0-9A-F]{8}", key), key
            assert "vr" in el
        assert ct["0020000D"]["vr"] == "UI"
        assert ct["00100010"]["vr"] == "PN"
        assert ct["00100010"]["Value"] == [{"Alphabetic": "Smith^John"}]
        assert ct["00100020"]["Value"] == ["P100"]
        assert ct["00080020"]["Value"] == ["20240115"]
        assert ct["00080061"]["vr"] == "CS" and ct["00080061"]["Value"] == ["CT"]
        assert ct["00201206"]["Value"] == [2]          # series, as a JSON number
        assert ct["00201208"]["Value"] == [3]          # instances
        assert ct["00080056"]["Value"] == ["ONLINE"]
        assert ct["00081190"]["vr"] == "UR"
        assert ct["00081190"]["Value"][0].endswith(f"/dicom-web/studies/{seed['ct_study']}")
        # Required returns the index cannot source are present but empty — never
        # invented, never silently absent.
        assert ct["00100030"] == {"vr": "DA"}          # PatientBirthDate
        assert ct["00100040"] == {"vr": "CS"}          # PatientSex
    finally:
        env.close()


def test_qido_filtering_and_wildcards():
    env = Env()
    try:
        seed = _seed(env)
        c = env.client
        one = _get_json(c.get("/dicom-web/studies?PatientID=P200"))
        assert len(one) == 1 and one[0]["0020000D"]["Value"][0] == seed["mr_study"]
        # Wildcards, case-insensitive text matching.
        assert len(_get_json(c.get("/dicom-web/studies?PatientName=smith*"))) == 1
        assert len(_get_json(c.get("/dicom-web/studies?PatientName=*^*"))) == 2
        assert len(_get_json(c.get("/dicom-web/studies?PatientName=*mura*"))) == 1
        assert len(_get_json(c.get("/dicom-web/studies?StudyDescription=Brain*"))) == 1
        # Hex-tag form of the same key (00100020 = PatientID).
        assert len(_get_json(c.get("/dicom-web/studies?00100020=P100"))) == 1
        # Date range, open-ended range, and a modality filter that selects a
        # study without shrinking its counts.
        assert len(_get_json(c.get("/dicom-web/studies?StudyDate=20240101-20240201"))) == 1
        assert len(_get_json(c.get("/dicom-web/studies?StudyDate=20240201-"))) == 1
        mods = _get_json(c.get("/dicom-web/studies?ModalitiesInStudy=CT"))
        assert len(mods) == 1 and mods[0]["00201208"]["Value"] == [3]
        # An empty value is DICOM's universal match, not "equals empty".
        assert len(_get_json(c.get("/dicom-web/studies?PatientID="))) == 2
    finally:
        env.close()


def test_qido_levels_and_paging():
    env = Env()
    try:
        seed = _seed(env)
        c = env.client
        series = _get_json(c.get(f"/dicom-web/studies/{seed['ct_study']}/series"))
        assert len(series) == 2
        assert {s["0020000E"]["Value"][0] for s in series} == {seed["ct_series"], seed["ct_series2"]}
        assert series[0]["00080060"]["Value"] == ["CT"]
        inst = _get_json(c.get(f"/dicom-web/studies/{seed['ct_study']}"
                               f"/series/{seed['ct_series']}/instances"))
        assert len(inst) == 2
        assert inst[0]["00080018"]["vr"] == "UI"
        assert inst[0]["00083002"]["Value"] == [str(ExplicitVRLittleEndian)]
        assert len(_get_json(c.get(f"/dicom-web/studies/{seed['ct_study']}/instances"))) == 3
        # Flat forms.
        assert len(_get_json(c.get("/dicom-web/series"))) == 3
        assert len(_get_json(c.get("/dicom-web/instances"))) == 4
        # Paging.
        page1 = _get_json(c.get("/dicom-web/instances?limit=2&offset=0"))
        page2 = _get_json(c.get("/dicom-web/instances?limit=2&offset=2"))
        assert len(page1) == len(page2) == 2
        seen = {o["00080018"]["Value"][0] for o in page1 + page2}
        assert len(seen) == 4
    finally:
        env.close()


def test_qido_204_and_warnings():
    env = Env()
    try:
        _seed(env)
        r = env.client.get("/dicom-web/studies?PatientID=NOBODY")
        assert r.status_code == 204
        assert r.get_data() == b""
        # An unsupported matching key is ignored with a Warning (PS3.18 8.3.4.2)
        # rather than failing the query, which is what viewers expect — but it
        # widens the result set, so the warning has to be there.
        r = env.client.get("/dicom-web/studies?PatientSex=F")
        assert r.status_code == 200 and len(_get_json(r)) == 2
        assert "PatientSex" in r.headers.get("Warning", "")
        r = env.client.get("/dicom-web/studies?bogusparam=1")
        assert "bogusparam" in r.headers.get("Warning", "")
        r = env.client.get("/dicom-web/studies?fuzzymatching=true")
        assert r.status_code == 200 and "fuzzymatching" in r.headers.get("Warning", "")
    finally:
        env.close()


def test_qido_includefield():
    env = Env()
    try:
        seed = _seed(env)
        objs = _get_json(env.client.get("/dicom-web/studies?includefield=PatientBirthDate"))
        ct = [o for o in objs if o["0020000D"]["Value"][0] == seed["ct_study"]][0]
        assert ct["00100030"]["Value"] == ["19800101"]
        objs = _get_json(env.client.get(
            f"/dicom-web/studies/{seed['ct_study']}/series/{seed['ct_series']}"
            f"/instances?includefield=all"))
        assert objs[0]["00280010"]["Value"] == [4]        # Rows, from the header
        assert objs[0]["00280100"]["Value"] == [8]        # BitsAllocated
    finally:
        env.close()


def test_qido_returns_the_required_attributes_at_every_level():
    """PS3.18 Table 10.6.1-5 required returns must be in the default response.

    A viewer cannot tell "attribute absent" from "server does not implement it",
    so the ones the index has no column for go out zero-length rather than being
    left out until somebody asks for includefield."""
    env = Env()
    try:
        seed = _seed(env)
        c = env.client
        study = [o for o in _get_json(c.get("/dicom-web/studies"))
                 if o["0020000D"]["Value"][0] == seed["ct_study"]][0]
        for tag in ("0020000D", "00080020", "00080030", "00080050", "00080056",
                    "00080061", "00080090", "00080201", "00081190", "00100010",
                    "00100020", "00100030", "00100040", "00200010", "00201206",
                    "00201208"):
            assert tag in study, tag
        # Empty means empty: no fabricated value, no "Value": [""].
        for tag in ("00080090", "00080201", "00100030", "00100040", "00200010"):
            assert "Value" not in study[tag], (tag, study[tag])

        series = _get_json(c.get(f"/dicom-web/studies/{seed['ct_study']}/series"))[0]
        for tag in ("00080060", "00080201", "0008103E", "00081190", "0020000E",
                    "00200011", "00201209", "00080056", "00400275"):
            assert tag in series, tag
        for tag in ("00080201", "00400244", "00400245"):
            assert "Value" not in series[tag], (tag, series[tag])
        # No scheduled step. PS3.18 F.2.5: an empty sequence carries no "Value"
        # member at all, exactly like an empty string attribute — "Value": [] is
        # pydicom's export talking, not DICOM JSON.
        assert series["00400275"] == {"vr": "SQ"}

        inst = _get_json(c.get(f"/dicom-web/studies/{seed['ct_study']}"
                               f"/series/{seed['ct_series']}/instances"))[0]
        for tag in ("00080016", "00080018", "00080056", "00080201", "00081190",
                    "00200013", "00280010", "00280011", "00280100", "00280008"):
            assert tag in inst, tag
        for tag in ("00080201", "00280010", "00280011", "00280100", "00280008"):
            assert "Value" not in inst[tag], (tag, inst[tag])

        # includefield=all replaces the placeholders with what the header holds.
        inst = _get_json(c.get(f"/dicom-web/studies/{seed['ct_study']}"
                               f"/series/{seed['ct_series']}/instances?includefield=all"))[0]
        assert inst["00280010"]["Value"] == [4]        # Rows
        assert inst["00280100"]["Value"] == [8]        # BitsAllocated
        study = [o for o in _get_json(c.get("/dicom-web/studies?includefield=all"))
                 if o["0020000D"]["Value"][0] == seed["ct_study"]][0]
        assert study["00100030"]["Value"] == ["19800101"]
    finally:
        env.close()


def test_no_response_ever_encodes_an_empty_value_array():
    """PS3.18 F.2.5: an attribute we hold no value for carries no "Value" member.

    Swept over every JSON-producing endpoint rather than asserted on the one
    attribute that was found wrong, because the source of the bug is pydicom's
    exporter, not the placeholder — anything empty that reaches to_json_dict()
    comes out as "Value": [], including sequences a modality genuinely sent
    empty and multi-valued attributes that arrived with no values."""
    env = Env()

    def sweep(obj, where):
        if isinstance(obj, list):
            for item in obj:
                sweep(item, where)
            return
        if not isinstance(obj, dict):
            return
        for key, entry in obj.items():
            if isinstance(entry, dict) and "Value" in entry:
                assert entry["Value"] != [], (where, key, entry)
            sweep(entry, where)

    try:
        seed = _seed(env)
        # An instance carrying exactly what pydicom exports badly: an empty
        # sequence and an empty multi-value, neither of them a placeholder.
        ds = make_dataset(study_uid=seed["ct_study"], series_uid=seed["ct_series"],
                          instance_number=9, rows=4, cols=4)
        ds.ReferencedImageSequence = []
        ds.ImageType = []
        env.server.store(ds)

        c = env.client
        urls = [
            "/dicom-web/studies",
            "/dicom-web/studies?includefield=all",
            f"/dicom-web/studies/{seed['ct_study']}/series",
            f"/dicom-web/studies/{seed['ct_study']}/series?includefield=all",
            f"/dicom-web/studies/{seed['ct_study']}/instances",
            f"/dicom-web/studies/{seed['ct_study']}/instances?includefield=all",
            f"/dicom-web/studies/{seed['ct_study']}/metadata",
            f"/dicom-web/studies/{seed['ct_study']}/series/{seed['ct_series']}/metadata",
            f"/dicom-web/studies/{seed['ct_study']}/series/{seed['ct_series']}"
            f"/instances/{ds.SOPInstanceUID}/metadata",
        ]
        for url in urls:
            sweep(_get_json(c.get(url)), url)

        # ...and the empty sequence really was in the response, so the sweep
        # above had something to catch rather than passing on absence.
        meta = _get_json(c.get(f"/dicom-web/studies/{seed['ct_study']}/series/"
                               f"{seed['ct_series']}/instances/{ds.SOPInstanceUID}/metadata"))[0]
        assert meta["00081140"] == {"vr": "SQ"}, meta.get("00081140")
    finally:
        env.close()


def test_qido_accept_406():
    env = Env()
    try:
        _seed(env)
        r = env.client.get("/dicom-web/studies", headers={"Accept": "application/dicom+xml"})
        assert r.status_code == 406
    finally:
        env.close()


# ------------------------------------------------------------------ WADO-RS
def test_wado_instance_bytes_are_intact():
    env = Env()
    try:
        seed = _seed(env)
        ds = seed["ct"][0]
        r = env.client.get(f"/dicom-web/studies/{seed['ct_study']}"
                           f"/series/{seed['ct_series']}/instances/{ds.SOPInstanceUID}")
        assert r.status_code == 200
        assert r.headers["Content-Type"].startswith('multipart/related; type="application/dicom"')
        parts = _split_multipart(r)
        assert len(parts) == 1
        blob = parts[0]
        assert blob[128:132] == b"DICM"
        on_disk = open(env.server.index.get_instance_path(ds.SOPInstanceUID), "rb").read()
        assert blob == on_disk
        back = dcmread(__import__("io").BytesIO(blob))
        assert back.SOPInstanceUID == ds.SOPInstanceUID
        assert back.PixelData == ds.PixelData
    finally:
        env.close()


def test_wado_study_and_series():
    env = Env()
    try:
        seed = _seed(env)
        parts = _split_multipart(env.client.get(f"/dicom-web/studies/{seed['ct_study']}"))
        assert len(parts) == 3
        assert all(p[128:132] == b"DICM" for p in parts)
        parts = _split_multipart(env.client.get(
            f"/dicom-web/studies/{seed['ct_study']}/series/{seed['ct_series2']}"))
        assert len(parts) == 1
        assert env.client.get("/dicom-web/studies/1.2.3.4.5").status_code == 404
    finally:
        env.close()


def test_wado_accept_and_transfer_syntax():
    env = Env()
    try:
        seed = _seed(env)
        url = f"/dicom-web/studies/{seed['ct_study']}"
        assert env.client.get(url, headers={"Accept": "image/jpeg"}).status_code == 406
        assert env.client.get(url, headers={
            "Accept": 'multipart/related; type="application/dicom+xml"'}).status_code == 406
        # We never transcode: asking for a syntax we did not store is a 406.
        assert env.client.get(url, headers={
            "Accept": 'multipart/related; type="application/dicom"; '
                      'transfer-syntax=1.2.840.10008.1.2.4.50'}).status_code == 406
        assert env.client.get(url, headers={
            "Accept": 'multipart/related; type="application/dicom"; '
                      'transfer-syntax=*'}).status_code == 200
    finally:
        env.close()


def test_wado_study_parts_are_grouped_by_series():
    """Study-level parts come out series-by-series, not InstanceNumber-first.

    Nothing is lost either way — every part is a complete object — but a viewer
    that renders parts as they arrive would otherwise show one slice of each
    series in turn for the whole download."""
    env = Env()
    try:
        st, se1, se2 = generate_uid(), generate_uid(), generate_uid()
        for series_uid, series_number in ((se2, 2), (se1, 1)):
            for n in (1, 2, 3):
                env.server.store(make_dataset(study_uid=st, series_uid=series_uid,
                                              series_number=series_number,
                                              instance_number=n, rows=4, cols=4))
        parts = _split_multipart(env.client.get(f"/dicom-web/studies/{st}"))
        assert len(parts) == 6
        order = [(dcmread(__import__("io").BytesIO(p)).SeriesInstanceUID,
                  int(dcmread(__import__("io").BytesIO(p)).InstanceNumber)) for p in parts]
        assert order == [(se1, 1), (se1, 2), (se1, 3), (se2, 1), (se2, 2), (se2, 3)], order
    finally:
        env.close()


def test_wado_metadata():
    env = Env()
    try:
        seed = _seed(env)
        ds = seed["ct"][0]
        objs = _get_json(env.client.get(
            f"/dicom-web/studies/{seed['ct_study']}/series/{seed['ct_series']}"
            f"/instances/{ds.SOPInstanceUID}/metadata"))
        assert len(objs) == 1
        meta = objs[0]
        assert meta["00080018"]["Value"] == [ds.SOPInstanceUID]
        assert meta["00100010"]["Value"] == [{"Alphabetic": "Smith^John"}]
        assert meta["00020010"]["Value"] == [str(ExplicitVRLittleEndian)]
        assert "7FE00010" not in meta            # bulk data never inlined
        assert len(_get_json(env.client.get(
            f"/dicom-web/studies/{seed['ct_study']}/metadata"))) == 3
        assert len(_get_json(env.client.get(
            f"/dicom-web/studies/{seed['ct_study']}"
            f"/series/{seed['ct_series']}/metadata"))) == 2
    finally:
        env.close()


def test_wado_frames():
    env = Env()
    try:
        st, se = generate_uid(), generate_uid()
        ds = make_dataset(study_uid=st, series_uid=se, rows=4, cols=4, frames=3)
        env.server.store(ds)
        base = (f"/dicom-web/studies/{st}/series/{se}/instances/{ds.SOPInstanceUID}/frames")
        r = env.client.get(base + "/2")
        assert r.status_code == 200
        assert 'type="application/octet-stream"' in r.headers["Content-Type"]
        parts = _split_multipart(r)
        assert len(parts) == 1
        assert parts[0] == bytes(ds.PixelData)[16:32]
        parts = _split_multipart(env.client.get(base + "/1,3"))
        assert parts == [bytes(ds.PixelData)[0:16], bytes(ds.PixelData)[32:48]]
        assert env.client.get(base + "/9").status_code == 404
        assert env.client.get(base + "/abc").status_code == 400
    finally:
        env.close()


def test_wado_frames_compressed_are_not_transcoded():
    env = Env()
    try:
        from pydicom.encaps import encapsulate
        st, se = generate_uid(), generate_uid()
        ds = make_dataset(study_uid=st, series_uid=se, rows=4, cols=4,
                          transfer_syntax=JPEGBaseline8Bit)
        # Even length on purpose: DICOM pads odd fragments, so an odd frame
        # would come back one byte longer and the comparison would be a lie.
        frame = b"\xff\xd8\xff\xe0not-really-jpeg!\xff\xd9"
        ds.PixelData = encapsulate([frame])
        ds["PixelData"].is_undefined_length = True
        env.server.store(ds)
        url = (f"/dicom-web/studies/{st}/series/{se}"
               f"/instances/{ds.SOPInstanceUID}/frames/1")
        r = env.client.get(url)
        assert r.status_code == 200, r.get_data(as_text=True)
        assert 'type="image/jpeg"' in r.headers["Content-Type"]
        assert _split_multipart(r) == [frame]
        # A client that will only take raw pixels must be told we cannot make them.
        assert env.client.get(url, headers={
            "Accept": 'multipart/related; type="application/octet-stream"'}).status_code == 406
    finally:
        env.close()


# ------------------------------------------------------------------ STOW-RS
def test_stow_round_trip():
    env = Env()
    try:
        st, se = generate_uid(), generate_uid()
        a = make_dataset(study_uid=st, series_uid=se, instance_number=1, rows=4, cols=4)
        b = make_dataset(study_uid=st, series_uid=se, instance_number=2, rows=4, cols=4)
        body = _stow_body([_as_bytes(a), _as_bytes(b)])
        r = env.client.post("/dicom-web/studies", data=body,
                            content_type='multipart/related; type="application/dicom"; '
                                         'boundary=carinotest')
        assert r.status_code == 200, r.get_data(as_text=True)
        payload = json.loads(r.get_data(as_text=True))
        refs = payload["00081199"]["Value"]
        assert len(refs) == 2
        assert {x["00081155"]["Value"][0] for x in refs} == {a.SOPInstanceUID, b.SOPInstanceUID}
        assert "00081198" not in payload
        assert "0008119A" not in payload
        assert payload["00081190"]["Value"][0].endswith(f"/studies/{st}")
        # Filed exactly where a C-STORE would have put it, and reconciled.
        stored = env.server.index.get_instance_path(a.SOPInstanceUID)
        assert stored == dest_path(env.server.storage, a, True)
        assert os.path.isfile(stored)
        assert len(env.server.reconciled) == 2
        # Queryable immediately, and retrievable byte-for-byte.
        objs = _get_json(env.client.get(f"/dicom-web/studies?StudyInstanceUID={st}"))
        assert objs[0]["00201208"]["Value"] == [2]
        parts = _split_multipart(env.client.get(f"/dicom-web/studies/{st}"))
        assert len(parts) == 2
        assert all(p[128:132] == b"DICM" for p in parts)
        assert dcmread(__import__("io").BytesIO(parts[0])).PixelData == a.PixelData
    finally:
        env.close()


def test_stow_study_mismatch_and_failures():
    env = Env()
    try:
        st, other = generate_uid(), generate_uid()
        good = make_dataset(study_uid=st, rows=4, cols=4)
        wrong = make_dataset(study_uid=other, rows=4, cols=4)
        # Mixed batch -> 202 Accepted with both sequences.
        body = _stow_body([_as_bytes(good), _as_bytes(wrong)])
        r = env.client.post(f"/dicom-web/studies/{st}", data=body,
                            content_type='multipart/related; boundary=carinotest')
        assert r.status_code == 202, r.get_data(as_text=True)
        payload = json.loads(r.get_data(as_text=True))
        assert len(payload["00081199"]["Value"]) == 1
        assert len(payload["00081198"]["Value"]) == 1
        assert payload["00081198"]["Value"][0]["00081197"]["Value"] == [0x0110]
        assert "0008119A" not in payload      # that failure HAS a SOP Instance
        # Everything fails -> 409 Conflict. An unparseable part has no SOP
        # Instance to reference, so PS3.18 Table I.1-1 puts it in
        # OtherFailuresSequence (0008,119A), never in FailedSOPSequence with
        # zero-length Type 1 UIDs.
        r = env.client.post(f"/dicom-web/studies/{st}", data=_stow_body([b"not a dicom file"]),
                            content_type='multipart/related; boundary=carinotest')
        assert r.status_code == 409
        payload = json.loads(r.get_data(as_text=True))
        assert "00081198" not in payload, payload
        assert payload["0008119A"]["Value"] == [{"00081197": {"vr": "US", "Value": [0xC000]}}]
        assert "00081199" not in payload
        # A part whose own Content-Type is not application/dicom is refused
        # before it is parsed, so it has no SOP Instance either — and a batch
        # holding one is still a partial failure, not a 200.
        body = _stow_body([_as_bytes(make_dataset(study_uid=st, rows=4, cols=4))],
                          content_type=b"application/dicom+xml")
        r = env.client.post(f"/dicom-web/studies/{st}", data=body,
                            content_type="multipart/related; boundary=carinotest")
        assert r.status_code == 409
        payload = json.loads(r.get_data(as_text=True))
        assert "00081198" not in payload, payload
        assert payload["0008119A"]["Value"][0]["00081197"]["Value"] == [0x0122]
    finally:
        env.close()


def test_stow_all_failed_has_no_dangling_retrieve_url():
    """A 409 with nothing stored has no study to point at, so RetrieveURL goes
    out zero-length — emitting ".../studies/" sends the client after a study that
    does not exist, but omitting the attribute entirely is wrong too: Table I.1-1
    types it 2, so it must be present."""
    env = Env()
    try:
        r = env.client.post("/dicom-web/studies", data=_stow_body([b"not a dicom file"]),
                            content_type="multipart/related; boundary=carinotest")
        assert r.status_code == 409
        payload = json.loads(r.get_data(as_text=True))
        assert payload["00081190"] == {"vr": "UR"}, payload
        assert payload["0008119A"]["Value"][0]["00081197"]["Value"] == [0xC000]
        # Posting to a named study still gets a URL: that study is the target the
        # client asked about, whether or not this batch landed.
        st = generate_uid()
        r = env.client.post(f"/dicom-web/studies/{st}", data=_stow_body([b"junk"]),
                            content_type="multipart/related; boundary=carinotest")
        assert r.status_code == 409
        payload = json.loads(r.get_data(as_text=True))
        assert payload["00081190"]["Value"][0].endswith(f"/studies/{st}")
    finally:
        env.close()


def test_stow_bad_requests():
    env = Env()
    try:
        blob = _as_bytes(make_dataset())
        c = env.client
        assert c.post("/dicom-web/studies", data=blob,
                      content_type="application/dicom").status_code == 415
        assert c.post("/dicom-web/studies", data=_stow_body([blob]),
                      content_type='multipart/related; type="application/dicom+xml"; '
                                   'boundary=carinotest').status_code == 415
        assert c.post("/dicom-web/studies", data=b"nothing here",
                      content_type="multipart/related; boundary=carinotest").status_code == 400
        env.server.cfg.data["dicomweb"]["allow_stow"] = False
        assert c.post("/dicom-web/studies", data=_stow_body([blob]),
                      content_type="multipart/related; boundary=carinotest").status_code == 403
    finally:
        env.close()


class LiveEnv(Env):
    """Env behind a real socket, on the same WSGI server the engine runs.

    The Flask test client always sends Content-Length, so nothing about
    Transfer-Encoding: chunked can be tested through it."""

    def __init__(self):
        super().__init__()
        import threading
        from werkzeug.serving import WSGIRequestHandler, make_server

        class Quiet(WSGIRequestHandler):
            def log(self, *a, **k): pass
            def log_request(self, *a, **k): pass

        self.srv = make_server("127.0.0.1", 0, self.app, threaded=True, request_handler=Quiet)
        self.port = self.srv.server_port
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.srv.shutdown()
        self.thread.join(timeout=5)
        super().close()


def _chunk(payload: bytes) -> bytes:
    return b"%x\r\n" % len(payload) + payload + b"\r\n"


def _chunked_headers(port: int) -> bytes:
    return (b"POST /dicom-web/studies HTTP/1.1\r\n"
            b"Host: 127.0.0.1:%d\r\n" % port +
            b'Content-Type: multipart/related; type="application/dicom"; '
            b"boundary=carinotest\r\n"
            b"Transfer-Encoding: chunked\r\n"
            b"Connection: close\r\n\r\n")


def _read_all(sock, timeout: float = 2.0) -> bytes:
    # Short timeout on purpose: a server that answered 413 mid-body may never get
    # to close the socket cleanly, and the response is in the first packet anyway.
    sock.settimeout(timeout)
    out = b""
    try:
        while True:
            got = sock.recv(65536)
            if not got:
                break
            out += got
    except OSError:
        pass
    return out


def test_stow_accepts_a_chunked_body():
    """Bounding the read must not cost us chunked uploads — plenty of clients
    stream a study without knowing its length up front."""
    import socket
    env = LiveEnv()
    try:
        ds = make_dataset(rows=4, cols=4)
        body = _stow_body([_as_bytes(ds)])
        sock = socket.create_connection(("127.0.0.1", env.port), timeout=10)
        sock.settimeout(10)
        sock.sendall(_chunked_headers(env.port))
        for i in range(0, len(body), 4096):
            sock.sendall(_chunk(body[i:i + 4096]))
        sock.sendall(b"0\r\n\r\n")
        resp = _read_all(sock)
        sock.close()
        assert resp.startswith(b"HTTP/1.1 200"), resp[:200]
        assert ds.SOPInstanceUID.encode() in resp
        assert env.server.index.get_instance_path(ds.SOPInstanceUID)
    finally:
        env.close()


def test_stow_chunked_body_is_bounded_while_it_is_read():
    """An unbounded chunked POST must not be allowed to buffer into RAM.

    content_length is None under chunked encoding, so any check after get_data()
    is a check on memory already committed: the process dies before it can run,
    taking the SCP and the forwarder with it. The read itself has to stop. The
    ceiling here is 512x the configured limit — reaching it means the server was
    still swallowing the body."""
    import select
    import socket
    from pacs import dicomweb

    env = LiveEnv()
    original = dicomweb._STOW_MAX_BYTES
    dicomweb._STOW_MAX_BYTES = 128 * 1024
    try:
        sock = socket.create_connection(("127.0.0.1", env.port), timeout=10)
        sock.settimeout(10)
        sock.sendall(_chunked_headers(env.port))
        framed = _chunk(b"\xab" * 65536)
        ceiling = 512 * dicomweb._STOW_MAX_BYTES
        sent, stopped = 0, ""
        while sent < ceiling:
            if select.select([sock], [], [], 0)[0]:
                stopped = "the server answered"
                break
            try:
                sock.sendall(framed)
            except OSError as exc:
                stopped = f"the socket was closed ({type(exc).__name__})"
                break
            sent += len(framed)
        assert stopped, f"the server swallowed {sent} bytes of an unbounded body"
        resp = _read_all(sock)
        sock.close()
        assert resp.startswith(b"HTTP/1.1 413"), (stopped, sent, resp[:200])
        # The read stopped near the ceiling, not after the whole body: what got
        # through is socket buffering, not a gigabyte in the heap.
        assert sent <= 16 * dicomweb._STOW_MAX_BYTES, sent
        assert any("413" in e["message"] or "limit" in e["message"]
                   for e in env.server.log.since(0))
    finally:
        dicomweb._STOW_MAX_BYTES = original
        env.close()


def test_stow_over_the_limit_never_stores_a_partial_batch():
    """An over-limit body is refused whole.

    The read stops at the ceiling, so the tail of the multipart is simply gone.
    Parsing what arrived would store the instances that fit and answer 200 —
    the client would be told its study landed while the last images of it never
    existed. It has to be a 413 with nothing filed."""
    import socket
    from pacs import dicomweb

    env = LiveEnv()
    original = dicomweb._STOW_MAX_BYTES
    try:
        three = [make_dataset(rows=4, cols=4) for _ in range(3)]
        body = _stow_body([_as_bytes(ds) for ds in three])
        # Room for the first instance and change, so a truncated read would parse
        # into a plausible-looking part or two.
        dicomweb._STOW_MAX_BYTES = len(_stow_body([_as_bytes(three[0])])) + 64
        assert len(body) > dicomweb._STOW_MAX_BYTES

        sock = socket.create_connection(("127.0.0.1", env.port), timeout=10)
        sock.settimeout(10)
        sock.sendall(_chunked_headers(env.port))
        for i in range(0, len(body), 2048):
            sock.sendall(_chunk(body[i:i + 2048]))
        sock.sendall(b"0\r\n\r\n")
        resp = _read_all(sock)
        sock.close()
        assert resp.startswith(b"HTTP/1.1 413"), resp[:200]
        for ds in three:
            assert env.server.index.get_instance_path(ds.SOPInstanceUID) is None

        # Same answer when the client does declare the length.
        r = env.client.post("/dicom-web/studies", data=body,
                            content_type='multipart/related; type="application/dicom"; '
                                         'boundary=carinotest')
        assert r.status_code == 413, r.get_data(as_text=True)
        for ds in three:
            assert env.server.index.get_instance_path(ds.SOPInstanceUID) is None
    finally:
        dicomweb._STOW_MAX_BYTES = original
        env.close()


def test_multipart_parser_handles_padding_and_binary():
    """The parser must survive a preamble, an epilogue, a part with no headers,
    and content full of CRLFs (which is what DICOM pixel data looks like)."""
    payload = b"\r\n\r\n--not-a-boundary\r\n\x00\xff\r\n"
    body = (b"preamble ignored\r\n"
            b"--B\r\nContent-Type: application/dicom\r\n\r\n" + payload + b"\r\n"
            b"--B\r\n\r\n" + b"second" + b"\r\n"
            b"--B--\r\nepilogue")
    parts = _parse_multipart_related(body, b"B")
    assert len(parts) == 2
    assert parts[0][0]["content-type"] == "application/dicom"
    assert parts[0][1] == payload
    assert parts[1][0] == {}
    assert parts[1][1] == b"second"


# ------------------------------------------------------------------ safety
def test_paths_outside_the_storage_roots_are_refused():
    env = Env()
    try:
        seed = _seed(env)
        secret = os.path.join(env.dir, "outside", "secret.dcm")
        os.makedirs(os.path.dirname(secret), exist_ok=True)
        ds = make_dataset(study_uid="9.9.9", series_uid="9.9.8", sop_uid="9.9.7", rows=4, cols=4)
        _save(ds, secret)
        # A poisoned/stale index row must never talk the server into reading it.
        assert env.server.index.add_file(secret, "received")
        assert env.client.get("/dicom-web/studies/9.9.9").status_code == 404
        assert env.client.get("/dicom-web/studies/9.9.9/metadata").status_code == 404
        assert env.client.get("/dicom-web/studies/9.9.9/series/9.9.8"
                              "/instances/9.9.7/frames/1").status_code == 404
        # It is still listed by QIDO (the file exists; we just refuse to serve it).
        assert len(_get_json(env.client.get("/dicom-web/studies?StudyInstanceUID=9.9.9"))) == 1
        # Traversal through the UID segments gets nowhere.
        for bad in ("..%2f..%2f..%2fetc%2fpasswd", "..", "%2e%2e%2f%2e%2e%2fconfig.json"):
            r = env.client.get(f"/dicom-web/studies/{bad}")
            assert r.status_code in (400, 404), (bad, r.status_code)
            assert b"DICM" not in r.get_data()
        r = env.client.get(f"/dicom-web/studies/{seed['ct_study']}/series/../../../etc")
        assert r.status_code in (301, 308, 400, 404), r.status_code
    finally:
        env.close()


def test_missing_file_is_206_not_a_silent_short_study():
    env = Env()
    try:
        seed = _seed(env)
        gone = env.server.index.get_instance_path(seed["ct"][0].SOPInstanceUID)
        os.remove(gone)
        r = env.client.get(f"/dicom-web/studies/{seed['ct_study']}")
        assert r.status_code == 206
        assert len(_split_multipart(r)) == 2
        assert any("gone" in e["message"] or "outside" in e["message"]
                   for e in env.server.log.since(0))
    finally:
        env.close()


def test_warning_header_cannot_be_forged():
    env = Env()
    try:
        _seed(env)
        r = env.client.get('/dicom-web/studies?ev"il%0d%0aX-Injected:%201=x')
        assert "X-Injected" not in r.headers
        assert '"' not in r.headers.get("Warning", "").split("carino-dicom ")[-1][1:-1]
    finally:
        env.close()


def test_stats_counters():
    env = Env()
    try:
        blueprint = env.app.blueprints["dicomweb"]
        _seed(env)
        env.client.get("/dicom-web/studies")
        st, se = generate_uid(), generate_uid()
        ds = make_dataset(study_uid=st, series_uid=se, rows=4, cols=4)
        env.client.post("/dicom-web/studies", data=_stow_body([_as_bytes(ds)]),
                        content_type="multipart/related; boundary=carinotest")
        env.client.get(f"/dicom-web/studies/{st}").get_data()
        snap = blueprint.stats.snapshot()
        assert snap["queries"] == 1 and snap["stored"] == 1
        assert snap["retrieved"] == 1 and snap["failed"] == 0
    finally:
        env.close()


def test_disabled_service_is_503():
    env = Env()
    try:
        _seed(env)
        env.server.cfg.data["dicomweb"]["enabled"] = False
        assert env.client.get("/dicom-web/studies").status_code == 503
        env.server.cfg.data["dicomweb"]["enabled"] = True
        assert env.client.get("/dicom-web/studies").status_code == 200
    finally:
        env.close()


def test_cors_is_off_until_an_origin_is_configured():
    env = Env()
    try:
        _seed(env)
        r = env.client.get("/dicom-web/studies", headers={"Origin": "https://viewer.example"})
        assert "Access-Control-Allow-Origin" not in r.headers
        env.server.cfg.data["dicomweb"]["cors_origins"] = ["https://viewer.example"]
        r = env.client.get("/dicom-web/studies", headers={"Origin": "https://viewer.example"})
        assert r.headers["Access-Control-Allow-Origin"] == "https://viewer.example"
        r = env.client.get("/dicom-web/studies", headers={"Origin": "https://evil.example"})
        assert "Access-Control-Allow-Origin" not in r.headers
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
