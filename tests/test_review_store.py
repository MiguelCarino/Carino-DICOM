"""Regression tests for the 2026-10 review of the C-STORE receive path: UID
validation, path sanitising, crash-safe writes, status codes, listener limits
and AE-title validation.

Runs under pytest, or directly:  python3 tests/test_review_store.py
"""

from __future__ import annotations

import copy
import errno
import io
import ntpath
import os
import socket
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest                                              # noqa: E402
from pydicom.dataset import Dataset, FileMetaDataset       # noqa: E402
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid  # noqa: E402
from pynetdicom import AE, StoragePresentationContexts     # noqa: E402
from pynetdicom.sop_class import Verification              # noqa: E402

from pacs import config as C                               # noqa: E402
from pacs import dicomfs, netclaim                         # noqa: E402
from pacs.atomicio import TMP_PREFIX                       # noqa: E402
from pacs.index import InstanceIndex                       # noqa: E402
from pacs.scp import InvalidInstanceUID, StorageSCP, _safe, dest_path  # noqa: E402


class Log:
    def __init__(self):
        self.lines = []

    def info(self, m, **k):
        self.lines.append(("info", m, k))

    def warn(self, m, **k):
        self.lines.append(("warn", m, k))

    def error(self, m, **k):
        self.lines.append(("error", m, k))

    def text(self):
        return "\n".join(m for _l, m, _k in self.lines)


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def ct(sop=None, patient="P1", name="DOE^JANE", study="1.2.3", series="1.2.3.4", rows=2):
    ds = Dataset()
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = sop if sop is not None else generate_uid()
    ds.PatientID = patient
    ds.PatientName = name
    ds.StudyInstanceUID = study
    ds.SeriesInstanceUID = series
    ds.Modality = "CT"
    ds.Rows = rows
    ds.Columns = 2
    ds.BitsAllocated = 8
    ds.SamplesPerPixel = 1
    ds.PixelData = b"\x01" * (rows * 2)
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = str(ds.SOPInstanceUID or "1.2")
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.file_meta = meta
    return ds


class Req:
    def __init__(self, affected=""):
        self.AffectedSOPInstanceUID = affected


class Ctx:
    abstract_syntax = CTImageStorage


class Requestor:
    ae_title = "CT1"
    address = "127.0.0.1"


class Assoc:
    requestor = Requestor()


class Event:
    """The slice of pynetdicom's EVT_C_STORE event _handle_store reads."""

    def __init__(self, ds, affected="", decode_error=None):
        self._ds = ds
        self._err = decode_error
        self.file_meta = ds.file_meta if ds is not None else FileMetaDataset()
        self.request = Req(affected)
        self.context = Ctx()
        self.assoc = Assoc()

    @property
    def dataset(self):
        if self._err is not None:
            raise self._err
        return self._ds


def scp_for(tmp, organize=False, **kw):
    return StorageSCP(aet="CARINO", bind="127.0.0.1", port=free_port(),
                      storage_dir=os.path.join(tmp, "received"), organize=organize,
                      log=Log(), min_free_mb=0, **kw)


def files_under(root):
    return sorted(os.path.relpath(os.path.join(r, f), root)
                  for r, _d, fs in os.walk(root) for f in fs)


# ------------------------------------------------------------ UIDs and names
def test_malformed_sop_uids_are_refused_over_the_wire_not_collapsed():
    with tempfile.TemporaryDirectory() as tmp:
        scp = scp_for(tmp)
        scp.start()
        try:
            statuses = []
            for uid in ("..", "._", "???", "1.2.3 4", "1.2.3_4"):
                ae = AE("CT1")
                ae.add_requested_context(CTImageStorage, ExplicitVRLittleEndian)
                assoc = ae.associate("127.0.0.1", scp.port, ae_title="CARINO")
                assert assoc.is_established
                ds = ct(sop=uid)
                ds.file_meta.MediaStorageSOPInstanceUID = "1.2"
                st = assoc.send_c_store(ds)
                statuses.append(st.Status if st else None)
                assoc.release()
            assert all(s is not None and s != 0x0000 for s in statuses), statuses
            assert all(s == 0xC000 for s in statuses), [hex(s) for s in statuses]
            root = os.path.join(tmp, "received")
            assert files_under(root) == [] if os.path.isdir(root) else True
        finally:
            scp.stop()


def test_dest_path_never_returns_a_shared_name_for_a_missing_uid():
    with pytest.raises(InvalidInstanceUID):
        dest_path("/r", ct(sop=""), True)
    p = dest_path("/r", ct(sop=""), True, sop_uid="1.2.840.99.7")
    assert p.endswith(os.path.join("1.2.3.4", "1.2.840.99.7.dcm"))


def test_invalid_study_and_series_uids_become_distinct_hashes():
    a = dest_path("/r", ct(sop="1.2.5", study="1.2.3 4"), True)
    b = dest_path("/r", ct(sop="1.2.5", study="1.2.3_4"), True)
    assert a != b
    assert "NOSTUDY" in dest_path("/r", ct(sop="1.2.5", study=""), True)


@pytest.mark.parametrize("pid", ["CON", "NUL", "AUX", "PRN", "COM1", "LPT1", "con", "Con.txt"])
def test_windows_device_names_never_reach_a_path_component(pid):
    p = dest_path("C:\\r", ct(sop="1.2.5", patient=pid), True)
    parts = p.replace("\\", "/").split("/")
    for comp in parts[1:]:
        assert not ntpath.isreserved(os.path.join("C:\\r", comp)), comp
        assert comp.split(".")[0].upper() not in ("CON", "NUL", "AUX", "PRN", "COM1", "LPT1")


def test_truncation_happens_before_the_edge_strip():
    out = _safe("a" * 119 + ".b", "F")
    assert not out.endswith(".") and not out.endswith(" ")


def test_safe_regressions():
    assert _safe("..", "F") == "F"
    assert _safe("/etc/passwd", "F") == "etc_passwd"
    for raw in ("a\x00b", "../x", "x/y\\z", ".hidden"):
        out = _safe(raw, "F")
        assert "\x00" not in out and os.sep not in out and "/" not in out
        assert not out.startswith(".")


# --------------------------------------------------------- the handler itself
def test_two_instances_without_any_sop_uid_are_rejected():
    with tempfile.TemporaryDirectory() as tmp:
        scp = scp_for(tmp, organize=True)
        for name in ("ALICE", "BOB"):
            ds = ct(sop="", name=name)
            del ds.SOPInstanceUID
            assert scp._handle_store(Event(ds)) == 0xC000
        assert files_under(os.path.join(tmp, "received")) == [] \
            if os.path.isdir(os.path.join(tmp, "received")) else True


def test_the_affected_sop_instance_uid_names_a_dataset_that_has_none():
    with tempfile.TemporaryDirectory() as tmp:
        scp = scp_for(tmp)
        ds = ct(sop="")
        del ds.SOPInstanceUID
        assert scp._handle_store(Event(ds, affected="1.2.840.5.6")) == 0x0000
        assert files_under(os.path.join(tmp, "received")) == ["1.2.840.5.6.dcm"]


def test_a_dataset_that_does_not_decode_is_c210():
    with tempfile.TemporaryDirectory() as tmp:
        scp = scp_for(tmp)
        assert scp._handle_store(Event(ct(), decode_error=ValueError("bad"))) == 0xC210


def test_a_sop_class_mismatch_is_a900():
    with tempfile.TemporaryDirectory() as tmp:
        scp = scp_for(tmp)
        ds = ct()
        ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.4"       # MR, sent on a CT context
        assert scp._handle_store(Event(ds)) == 0xA900


def test_an_unencodable_resend_keeps_the_good_copy_and_is_not_out_of_resources():
    with tempfile.TemporaryDirectory() as tmp:
        scp = scp_for(tmp)
        sop = "1.2.826.0.1.3680043.8.498.1234"
        assert scp._handle_store(Event(ct(sop=sop))) == 0x0000
        path = os.path.join(tmp, "received", sop + ".dcm")
        good = open(path, "rb").read()
        bad = ct(sop=sop)
        bad.Rows = "notanumber"
        status = scp._handle_store(Event(bad))
        assert status != 0xA700 and (status & 0xF000) == 0xC000, hex(status)
        assert open(path, "rb").read() == good
        assert not [f for f in os.listdir(os.path.dirname(path)) if f.startswith(TMP_PREFIX)]


def test_a_full_disk_mid_write_leaves_no_file_and_no_index_row(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        calls = []
        scp = scp_for(tmp, on_received=lambda ds, p: calls.append(p))
        real = Dataset.save_as

        def half_then_enospc(self, fp, *a, **k):
            fp.write(b"\0" * 1000)
            raise OSError(errno.ENOSPC, "No space left on device")
        monkeypatch.setattr(Dataset, "save_as", half_then_enospc)
        assert scp._handle_store(Event(ct(sop="1.2.9"))) == 0xA700
        monkeypatch.setattr(Dataset, "save_as", real)
        root = os.path.join(tmp, "received")
        assert files_under(root) == []
        assert calls == []
        idx = InstanceIndex(":memory:", log=Log())
        assert idx.rescan({"received": root})["added"] == 0


def test_eacces_is_not_reported_as_out_of_resources(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        scp = scp_for(tmp)

        def denied(self, fp, *a, **k):
            raise PermissionError(errno.EACCES, "Permission denied")
        monkeypatch.setattr(Dataset, "save_as", denied)
        status = scp._handle_store(Event(ct(sop="1.2.10")))
        assert status != 0xA700 and status == 0xC211
        assert "not out of space" in scp.log.text()


def test_a_store_is_fsynced_before_success(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        scp = scp_for(tmp)
        synced = []
        real = os.fsync
        monkeypatch.setattr(os, "fsync", lambda fd: (synced.append(fd), real(fd))[1])
        assert scp._handle_store(Event(ct(sop="1.2.11"))) == 0x0000
        assert len(synced) >= 2          # the file, then its directory


def test_a_failing_callback_is_logged_and_the_store_still_succeeds():
    with tempfile.TemporaryDirectory() as tmp:
        def boom(ds, p):
            raise RuntimeError("reconcile exploded")
        scp = scp_for(tmp, on_received=boom)
        assert scp._handle_store(Event(ct(sop="1.2.12"))) == 0x0000
        errors = [m for lvl, m, _k in scp.log.lines if lvl == "error"]
        assert any("1.2.12.dcm" in m and "reconcile exploded" in m for m in errors)


def test_a_resend_with_another_patient_is_warned_about():
    with tempfile.TemporaryDirectory() as tmp:
        scp = scp_for(tmp)
        assert scp._handle_store(Event(ct(sop="1.2.13", patient="ALICE"))) == 0x0000
        assert scp._handle_store(Event(ct(sop="1.2.13", patient="MALLORY"))) == 0x0000
        assert any("different PatientID" in m for lvl, m, _ in scp.log.lines if lvl == "warn")


def test_a_free_space_probe_that_fails_is_fail_open(monkeypatch):
    import shutil
    with tempfile.TemporaryDirectory() as tmp:
        scp = scp_for(tmp)
        scp.min_free_mb = 100

        def broken(_p):
            raise OSError("no statvfs")
        monkeypatch.setattr(shutil, "disk_usage", broken)
        assert scp._space_ok() is True
        assert scp._handle_store(Event(ct(sop="1.2.14"))) == 0x0000


def test_concurrent_writers_of_one_sop_leave_one_whole_object():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "x.dcm")
        big = ct(sop="1.2.15", rows=3000)
        big.PixelData = b"\x07" * (3000 * 2) + b"\x00" * (8 * 1024 * 1024)
        small = ct(sop="1.2.15", name="SMALL")

        def ser(ds):
            buf = io.BytesIO()
            ds.save_as(buf, **dicomfs.SAVE_KWARGS)
            return buf.getvalue()
        expected = {ser(big), ser(small)}
        t = threading.Thread(target=dicomfs.save_dicom, args=(big, path))
        t.start()
        time.sleep(0.01)
        dicomfs.save_dicom(small, path)
        t.join()
        assert open(path, "rb").read() in expected


# ------------------------------------------------------------ listener limits
def test_eleven_silent_sockets_do_not_lock_out_an_allow_listed_modality():
    with tempfile.TemporaryDirectory() as tmp:
        scp = scp_for(tmp, allowed_aets=["CT1"])
        scp.start()
        socks = []
        try:
            for _ in range(11):
                socks.append(socket.create_connection(("127.0.0.1", scp.port)))
            time.sleep(0.3)
            ae = AE("CT1")
            ae.add_requested_context(Verification)
            assoc = ae.associate("127.0.0.1", scp.port, ae_title="CARINO")
            assert assoc.is_established
            assoc.release()
        finally:
            for s in socks:
                s.close()
            scp.stop()


def test_one_host_cannot_hold_more_than_its_share_of_slots():
    with tempfile.TemporaryDirectory() as tmp:
        scp = scp_for(tmp, max_per_host=2)
        scp.start()
        socks = []
        try:
            for _ in range(2):
                socks.append(socket.create_connection(("127.0.0.1", scp.port)))
            time.sleep(0.3)
            ae = AE("CT1")
            ae.add_requested_context(Verification)
            ae.acse_timeout = 3
            assoc = ae.associate("127.0.0.1", scp.port, ae_title="CARINO")
            assert not assoc.is_established
            assert "already" in scp.log.text()
        finally:
            for s in socks:
                s.close()
            scp.stop()


def test_a_bare_string_allow_list_is_refused_by_the_listener():
    with tempfile.TemporaryDirectory() as tmp:
        with pytest.raises(ValueError):
            scp_for(tmp, allowed_aets="CT1")


def _doc(**edits):
    d = copy.deepcopy(C.DEFAULTS)
    for dotted, value in edits.items():
        sec, _, key = dotted.partition("__")
        d[sec][key] = value
    return d


@pytest.mark.parametrize("section", ["scp", "print", "mwl", "qr"])
def test_validate_refuses_a_string_allow_list(section):
    with pytest.raises(ValueError, match="allowed_aets"):
        C.validate(_doc(**{f"{section}__allowed_aets": "CT1"}))


@pytest.mark.parametrize("entry", ["A" * 17, "BAD\\AE", "", "Ä"])
def test_validate_refuses_an_entry_the_listener_would_not_start_with(entry):
    with pytest.raises(ValueError, match="allowed_aets"):
        C.validate(_doc(scp__allowed_aets=[entry]))


def test_validate_accepts_padded_allow_list_entries():
    C.validate(_doc(scp__allowed_aets=["  CT1  "]))


def test_netclaim_resolves_like_pynetdicom_binds():
    from pynetdicom.transport import AddressInformation
    p = free_port()
    assert netclaim._resolve("localhost", p)[3][0] == \
        AddressInformation.from_tuple(("localhost", p)).address


def test_limit_listener_raises_the_ceiling_and_shortens_the_wait():
    ae = AE("X")
    netclaim.limit_listener(ae)
    assert ae.maximum_associations >= 20 and ae.acse_timeout <= 10


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
