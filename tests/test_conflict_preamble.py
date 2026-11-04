"""A stored instance is never silently replaced by a different object under its
SOP Instance UID, and no file this appliance writes or hands out carries a
non-zero preamble.

The first is the published "retrieve a study, plant a payload, C-STORE it back"
attack; the second is the DICOM/executable polyglot (CVE-2019-11687). Every
dataset here is synthetic, and the "payloads" are inert marker strings.

Runs under pytest, or directly:  python3 tests/test_conflict_preamble.py
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import pytest                                              # noqa: E402
from pydicom import dcmread                                # noqa: E402
from pydicom.uid import generate_uid                       # noqa: E402

from pacs import config as C                               # noqa: E402
from pacs import dicomfs                                   # noqa: E402
from pacs.scp import (INSTANCE_CONFLICT, StorageSCP,       # noqa: E402
                      default_quarantine_dir, file_instance)
from test_review_store import Event, Log, ct, free_port, scp_for  # noqa: E402
from test_dicomweb import Env, _as_bytes, _split_multipart, _stow_body, make_dataset  # noqa: E402

# An inert stand-in for an executable header: the two bytes a PE file starts
# with, then filler. Nothing here is runnable.
MARKED_PREAMBLE = b"MZ" + b"\x90" * 126
STOW_CT = 'multipart/related; type="application/dicom"; boundary=carinotest'


class Audit:
    def __init__(self):
        self.records = []

    def record(self, action, **kw):
        self.records.append((action, kw))
        return {}


def quarantined(scp_or_dir):
    d = scp_or_dir if isinstance(scp_or_dir, str) else scp_or_dir.quarantine_dir
    return sorted(os.listdir(d)) if os.path.isdir(d) else []


def no_scratch(folder):
    from pacs.atomicio import TMP_PREFIX
    return not [f for f in os.listdir(folder) if f.startswith(TMP_PREFIX)]


def tampered(sop, **kw):
    ds = ct(sop=sop, **kw)
    ds.ImageComments = "SYNTHETIC-PAYLOAD-MARKER"
    ds.PixelData = b"\x02" * len(ds.PixelData)
    return ds


# ------------------------------------------------------------ C-STORE resends
def test_an_identical_resend_leaves_the_stored_file_alone():
    with tempfile.TemporaryDirectory() as tmp:
        calls = []
        scp = scp_for(tmp, on_received=lambda ds, p: calls.append(p), audit=Audit())
        sop = "1.2.826.0.1.3680043.8.498.2001"
        assert scp._handle_store(Event(ct(sop=sop))) == 0x0000
        path = os.path.join(tmp, "received", sop + ".dcm")
        before = (open(path, "rb").read(), os.stat(path).st_mtime_ns)
        assert scp._handle_store(Event(ct(sop=sop))) == 0x0000
        assert (open(path, "rb").read(), os.stat(path).st_mtime_ns) == before
        assert quarantined(scp) == []
        assert scp.conflict_count == 0 and scp.received_count == 2
        assert scp.audit.records == []
        assert no_scratch(os.path.join(tmp, "received"))
        assert len(calls) == 2           # a resend is still a delivery: RIS matching runs


def test_a_tampered_resend_keeps_the_stored_copy_and_quarantines_the_new_one():
    with tempfile.TemporaryDirectory() as tmp:
        calls = []
        scp = scp_for(tmp, on_received=lambda ds, p: calls.append(p), audit=Audit())
        sop = "1.2.826.0.1.3680043.8.498.2002"
        assert scp._handle_store(Event(ct(sop=sop))) == 0x0000
        path = os.path.join(tmp, "received", sop + ".dcm")
        good = open(path, "rb").read()

        assert scp._handle_store(Event(tampered(sop))) == 0x0000
        assert open(path, "rb").read() == good
        assert "ImageComments" not in dcmread(path)
        q = quarantined(scp)
        assert len(q) == 1 and q[0].endswith(f"_{sop}_incoming.dcm")
        held = dcmread(os.path.join(scp.quarantine_dir, q[0]))
        assert held.ImageComments == "SYNTHETIC-PAYLOAD-MARKER"
        assert scp.conflict_count == 1 and scp.received_count == 1
        assert len(calls) == 1           # nothing downstream acts on the copy not stored
        errors = [m for lvl, m, _k in scp.log.lines if lvl == "error"]
        assert any("stored copy was kept" in m and q[0] in m for m in errors)
        (action, rec), = scp.audit.records
        assert action == INSTANCE_CONFLICT and rec["outcome"] == "kept" and rec["target"] == sop
        assert rec["detail"]["stored_sha256"] != rec["detail"]["incoming_sha256"]
        assert rec["detail"]["quarantined"] == q[0]
        assert no_scratch(os.path.join(tmp, "received"))


def test_a_second_tampered_resend_is_quarantined_beside_the_first():
    with tempfile.TemporaryDirectory() as tmp:
        scp = scp_for(tmp)
        sop = "1.2.826.0.1.3680043.8.498.2003"
        scp._handle_store(Event(ct(sop=sop)))
        scp._handle_store(Event(tampered(sop)))
        scp._handle_store(Event(tampered(sop, name="OTHER^NAME")))
        assert len(quarantined(scp)) == 2


def test_a_resend_with_another_patient_is_still_warned_about_and_kept_out():
    with tempfile.TemporaryDirectory() as tmp:
        scp = scp_for(tmp)
        assert scp._handle_store(Event(ct(sop="1.2.13", patient="ALICE"))) == 0x0000
        assert scp._handle_store(Event(ct(sop="1.2.13", patient="MALLORY"))) == 0x0000
        assert any("different PatientID" in m for lvl, m, _ in scp.log.lines if lvl == "warn")
        assert str(dcmread(os.path.join(tmp, "received", "1.2.13.dcm")).PatientID) == "ALICE"


def test_the_replace_policy_stores_the_new_copy_and_quarantines_the_old():
    with tempfile.TemporaryDirectory() as tmp:
        calls = []
        scp = scp_for(tmp, on_received=lambda ds, p: calls.append(p),
                      on_conflict="replace", audit=Audit())
        sop = "1.2.826.0.1.3680043.8.498.2004"
        scp._handle_store(Event(ct(sop=sop)))
        path = os.path.join(tmp, "received", sop + ".dcm")
        good = open(path, "rb").read()
        assert scp._handle_store(Event(tampered(sop))) == 0x0000
        assert dcmread(path).ImageComments == "SYNTHETIC-PAYLOAD-MARKER"
        q = quarantined(scp)
        assert len(q) == 1 and q[0].endswith("_replaced.dcm")
        assert open(os.path.join(scp.quarantine_dir, q[0]), "rb").read() == good
        assert scp.audit.records[0][1]["outcome"] == "replaced"
        assert len(calls) == 2 and scp.conflict_count == 1
        assert no_scratch(os.path.join(tmp, "received"))


def test_a_failed_quarantine_write_fails_the_store_and_keeps_the_original(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        scp = scp_for(tmp)
        sop = "1.2.826.0.1.3680043.8.498.2005"
        scp._handle_store(Event(ct(sop=sop)))
        path = os.path.join(tmp, "received", sop + ".dcm")
        good = open(path, "rb").read()
        # A file where the quarantine folder should be: makedirs fails, and the
        # sender must hear about it so it retries, rather than the copy vanishing.
        with open(scp.quarantine_dir, "w") as fh:
            fh.write("in the way")
        status = scp._handle_store(Event(tampered(sop)))
        assert (status & 0xF000) in (0xA000, 0xC000), hex(status)
        assert open(path, "rb").read() == good
        assert no_scratch(os.path.join(tmp, "received"))


def test_the_quarantine_defaults_beside_the_storage_folder_never_inside_it():
    with tempfile.TemporaryDirectory() as tmp:
        scp = scp_for(tmp)
        assert scp.quarantine_dir == os.path.join(tmp, "quarantine")
        assert default_quarantine_dir(os.path.join(tmp, "received")) == scp.quarantine_dir


def test_an_unknown_conflict_policy_is_refused():
    with tempfile.TemporaryDirectory() as tmp:
        with pytest.raises(ValueError, match="on_conflict"):
            StorageSCP(aet="CARINO", bind="127.0.0.1", port=free_port(),
                       storage_dir=os.path.join(tmp, "received"), organize=False,
                       log=Log(), min_free_mb=0, on_conflict="overwrite")


def test_file_instance_compares_the_data_set_not_the_meta_group():
    """The meta group names the sending AE. One object resent by another
    sender differs only there, and is the same object."""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "x.dcm")
        a = ct(sop="1.2.20")
        a.file_meta.SourceApplicationEntityTitle = "CT1"
        b = ct(sop="1.2.20")
        b.file_meta.SourceApplicationEntityTitle = "SOMEONE_ELSE"
        q = os.path.join(tmp, "q")
        assert file_instance(a, path, quarantine_dir=q) == "stored"
        assert file_instance(b, path, quarantine_dir=q) == "identical"
        assert not os.path.exists(q)


# ------------------------------------------------------------ preambles
def test_save_dicom_writes_a_zero_preamble_whatever_the_dataset_carried():
    with tempfile.TemporaryDirectory() as tmp:
        ds = ct(sop="1.2.30")
        ds.preamble = MARKED_PREAMBLE
        path = os.path.join(tmp, "x.dcm")
        dicomfs.save_dicom(ds, path)
        with open(path, "rb") as fh:
            head = fh.read(132)
        assert head == dicomfs.ZERO_PREAMBLE + b"DICM"


def test_clear_preamble_says_whether_there_was_anything_to_clear():
    ds = ct(sop="1.2.31")
    assert dicomfs.clear_preamble(ds) is False
    ds.preamble = dicomfs.ZERO_PREAMBLE
    assert dicomfs.clear_preamble(ds) is False
    ds.preamble = MARKED_PREAMBLE
    assert dicomfs.clear_preamble(ds) is True and ds.preamble is None


def test_servable_chunks_zero_the_preamble_and_change_nothing_else():
    with tempfile.TemporaryDirectory() as tmp:
        ds = ct(sop="1.2.32", rows=600)
        ds.preamble = MARKED_PREAMBLE
        path = os.path.join(tmp, "planted.dcm")
        ds.save_as(path, **dicomfs.SAVE_KWARGS)       # as somebody else would write it
        raw = open(path, "rb").read()
        assert raw[:2] == b"MZ"
        out = b"".join(dicomfs.servable_chunks(path, chunk=100))
        assert out == dicomfs.ZERO_PREAMBLE + raw[128:]


def test_servable_chunks_leave_a_file_without_a_part10_header_alone():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "raw.bin")
        data = b"MZ" + b"\x01" * 300
        with open(path, "wb") as fh:
            fh.write(data)
        assert b"".join(dicomfs.servable_chunks(path)) == data


def test_the_deidentified_writer_zeroes_the_preamble():
    from pacs.deid import write_dataset
    with tempfile.TemporaryDirectory() as tmp:
        ds = ct(sop="1.2.33")
        ds.preamble = MARKED_PREAMBLE
        path = os.path.join(tmp, "x.dcm")
        write_dataset(ds, path)
        assert open(path, "rb").read(128) == dicomfs.ZERO_PREAMBLE


# ------------------------------------------------------------ DICOMweb
def _stow(env, *datasets):
    return env.client.post("/dicom-web/studies",
                           data=_stow_body([_as_bytes(d) for d in datasets]),
                           content_type=STOW_CT)


def test_stow_stores_a_marked_preamble_as_zeros_and_says_so():
    env = Env()
    try:
        ds = make_dataset(rows=4, cols=4)
        ds.preamble = MARKED_PREAMBLE
        r = _stow(env, ds)
        assert r.status_code == 200, r.get_data(as_text=True)
        path = env.server.index.get_instance_path(ds.SOPInstanceUID)
        assert open(path, "rb").read(132) == dicomfs.ZERO_PREAMBLE + b"DICM"
        assert any("non-empty preamble" in e["message"] for e in env.server.log.since(0))
    finally:
        env.close()


def test_stow_keeps_the_stored_copy_when_a_tampered_one_is_posted():
    env = Env()
    try:
        st, se, sop = generate_uid(), generate_uid(), generate_uid()
        good = make_dataset(study_uid=st, series_uid=se, sop_uid=sop, rows=4, cols=4)
        assert _stow(env, good).status_code == 200
        path = env.server.index.get_instance_path(sop)
        before = open(path, "rb").read()
        bad = make_dataset(study_uid=st, series_uid=se, sop_uid=sop, rows=4, cols=4)
        bad.ImageComments = "SYNTHETIC-PAYLOAD-MARKER"
        assert _stow(env, bad).status_code == 200
        assert open(path, "rb").read() == before
        qdir = env.server.cfg.resolved("scp", "quarantine_dir")
        assert len(quarantined(qdir)) == 1
        assert len(env.server.reconciled) == 1
        # The archive answers with what it holds, not with what was posted.
        parts = _split_multipart(env.client.get(f"/dicom-web/studies/{st}"))
        assert len(parts) == 1 and "ImageComments" not in dcmread(io.BytesIO(parts[0]))
    finally:
        env.close()


def test_wado_hands_out_a_planted_preamble_as_zeros():
    env = Env()
    try:
        ds = make_dataset(rows=4, cols=4)
        ds.preamble = MARKED_PREAMBLE
        path = env.server.store(ds)                   # written as an outsider would
        raw = open(path, "rb").read()
        assert raw[:2] == b"MZ"
        parts = _split_multipart(env.client.get(f"/dicom-web/studies/{ds.StudyInstanceUID}"))
        assert parts == [dicomfs.ZERO_PREAMBLE + raw[128:]]
    finally:
        env.close()


# ------------------------------------------------------------ dashboard download
def test_the_dashboard_download_hands_out_a_planted_preamble_as_zeros(tmp_path):
    from pacs.config import Config
    from pacs.server import PacsServer
    from pacs.web import create_app
    cfg = Config(os.path.join(str(tmp_path), "config.json"))
    cfg.data["scp"]["enabled"] = False
    cfg.data["index"]["enabled"] = False
    cfg.save()
    srv = PacsServer(cfg)
    root = srv.cfg.resolved("scp", "storage_dir")
    study = os.path.join(root, "P", "S")
    ds = ct(sop="1.2.40")
    ds.preamble = MARKED_PREAMBLE
    os.makedirs(os.path.join(study, "SE"))
    ds.save_as(os.path.join(study, "SE", "a.dcm"), **dicomfs.SAVE_KWARGS)
    raw = open(os.path.join(study, "SE", "a.dcm"), "rb").read()
    client = create_app(srv).test_client()
    r = client.get("/api/studies/file",
                   query_string={"group": "received", "path": study,
                                 "name": os.path.join("SE", "a.dcm")},
                   headers={"Host": "127.0.0.1:8042"})
    assert r.status_code == 200, r.get_data(as_text=True)
    assert r.headers["Content-Type"] == "application/dicom"
    assert r.headers["Content-Disposition"] == 'inline; filename="a.dcm"'
    assert r.get_data() == dicomfs.ZERO_PREAMBLE + raw[128:]


# ------------------------------------------------------------ configuration
def _doc(**edits):
    import copy
    d = copy.deepcopy(C.DEFAULTS)
    for dotted, value in edits.items():
        sec, _, key = dotted.partition("__")
        d[sec][key] = value
    return d


def test_the_defaults_validate():
    C.validate(_doc())
    assert C.DEFAULTS["scp"]["on_conflict"] == "keep"


def test_validate_refuses_an_unknown_conflict_policy():
    with pytest.raises(ValueError, match="on_conflict"):
        C.validate(_doc(scp__on_conflict="overwrite"))


@pytest.mark.parametrize("where", ["./received", "./received/q", "./outgoing/q", "./sent",
                                   "./pending"])
def test_validate_refuses_a_quarantine_that_would_be_retrieved_or_forwarded(where):
    with pytest.raises(ValueError, match="quarantine_dir"):
        C.validate(_doc(scp__quarantine_dir=where))


def test_validate_refuses_an_empty_quarantine():
    with pytest.raises(ValueError, match="quarantine_dir"):
        C.validate(_doc(scp__quarantine_dir="  "))


def test_the_quarantine_is_not_a_storage_root():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "config.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({}, fh)
        cfg = C.Config(path)
        assert cfg.resolved("scp", "quarantine_dir") not in cfg.storage_roots()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
