"""Regression tests for the 2026-10 review of the instance index and the
Query/Retrieve SCP: case-sensitive matching, PN normalisation, universal '*',
bad file names, nested roots, and C-FIND / C-MOVE status reporting.

Runs under pytest, or directly:  python3 tests/test_review_qr_index.py
"""

from __future__ import annotations

import os
import socket
import sys
import tempfile
import threading
import time
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest                                              # noqa: E402
from pydicom.dataset import Dataset, FileMetaDataset       # noqa: E402
from pydicom.uid import ExplicitVRLittleEndian, SecondaryCaptureImageStorage, generate_uid  # noqa: E402
from pynetdicom import AE, AllStoragePresentationContexts, ALL_TRANSFER_SYNTAXES, evt  # noqa: E402
from pynetdicom.sop_class import (StudyRootQueryRetrieveInformationModelFind,  # noqa: E402
                                  StudyRootQueryRetrieveInformationModelMove)

from pacs import qr as Q                                   # noqa: E402
from pacs.index import InstanceIndex                       # noqa: E402
from pacs.logbuf import LogBuffer                          # noqa: E402
from pacs.qr import QrSCP, query_filters                   # noqa: E402


def _rename_to_undecodable(path: str) -> bytes:
    """Rename *path* to P\\xe9rez.dcm beside it, a name that is not valid UTF-8,
    and return the new bytes path; or skip, since only some file systems can hold
    one. Linux takes any bytes; APFS refuses them (EILSEQ), and Windows cannot
    even decode a bytes path that carries one."""
    try:
        bad = os.path.join(os.path.dirname(path).encode(), b"P\xe9rez.dcm")
        os.rename(path.encode(), bad)
    except (OSError, UnicodeError) as e:
        pytest.skip(f"this file system cannot hold a non-UTF-8 name ({type(e).__name__})")
    return bad


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def write(root, **kw):
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.SOPClassUID = SecondaryCaptureImageStorage
    ds.SOPInstanceUID = kw.pop("sop_uid", None) or generate_uid()
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    kw.setdefault("SeriesInstanceUID", generate_uid())
    kw.setdefault("StudyInstanceUID", generate_uid())
    for k, v in kw.items():
        setattr(ds, k, v)
    name = kw.pop("_name", None) if "_name" in kw else None
    path = os.path.join(root, ds.SeriesInstanceUID, (name or ds.SOPInstanceUID) + ".dcm")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    ds.save_as(path, enforce_file_format=True)
    return path, ds


_MADE: list = []


@pytest.fixture(autouse=True, scope="module")
def _cleanup():
    yield
    import shutil
    for d in _MADE:
        shutil.rmtree(d, ignore_errors=True)


class Env:
    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="carino-qrrev-")
        _MADE.append(self.tmp)
        self.root = os.path.join(self.tmp, "received")
        os.makedirs(self.root)
        self.log = LogBuffer()
        self.index = InstanceIndex(os.path.join(self.tmp, "index.db"), self.log)

    def add(self, **kw):
        path, ds = write(self.root, **kw)
        self.index.add_file(path, "received")
        return path, ds


# ------------------------------------------------------------- index matching
def test_patient_id_matching_is_case_sensitive():
    e = Env()
    _, a = e.add(PatientID="ab123", PatientName="DOE^JANE")
    _, b = e.add(PatientID="AB123", PatientName="ROE^RICK")
    rows = e.index.query_studies(query_filters(_q("STUDY", PatientID="ab123"))[0])
    assert [r["StudyInstanceUID"] for r in rows] == [a.StudyInstanceUID]
    assert e.index.query_studies({"PatientID": "ab*"})[0]["StudyInstanceUID"] == a.StudyInstanceUID
    assert len(e.index.query_studies({"PatientID": "ab*"})) == 1


def test_accession_is_case_sensitive_and_pn_is_not():
    e = Env()
    e.add(AccessionNumber="ACC1", PatientName="DOE^JANE")
    assert e.index.query_studies({"AccessionNumber": "acc1"}) == []
    assert len(e.index.query_studies({"PatientName": "doe^jane"})) == 1


def test_trailing_empty_name_components_are_the_same_name():
    e = Env()
    e.add(PatientName="DOE^JANE^^^")
    assert len(e.index.query_studies({"PatientName": "DOE^JANE"})) == 1


def test_a_lone_star_is_universal_even_where_the_value_is_absent():
    e = Env()
    study = generate_uid()
    for n in (1, 2, 3):
        e.add(StudyInstanceUID=study, SeriesNumber=n)
    e.add(StudyInstanceUID=study)                      # no SeriesNumber
    assert len(e.index.query_series(filters={"SeriesNumber": "*"}, limit=0)) == 4
    e.add(PatientName="NODATE^X")
    assert len(e.index.query_studies({"StudyDate": "*"}, limit=0)) == \
        len(e.index.query_studies({}, limit=0))


def test_regression_unicode_wildcard_and_time_ranges():
    e = Env()
    e.add(PatientName="山田^太郎", SpecificCharacterSet="ISO_IR 192", StudyTime="101500")
    e.add(PatientName="B^B", StudyTime="120000")
    e.add(PatientName="C^C", StudyTime="120030")
    assert len(e.index.query_studies({"PatientName": "山?^太郎"})) == 1
    assert len(e.index.query_studies({"StudyTime": "1000-1200"})) == 2


def _q(level, **keys):
    ds = Dataset()
    ds.QueryRetrieveLevel = level
    for k, v in keys.items():
        setattr(ds, k, v)
    return ds


def test_a_patient_level_retrieve_never_pulls_in_another_patient():
    e = Env()
    _, a = e.add(PatientID="ab123")
    e.add(PatientID="AB123")
    scp = QrSCP(aet="CARINOQR", bind="127.0.0.1", port=free_port(), log=e.log, index=e.index,
                get_storage_roots=lambda: [e.root])
    rows = scp._retrieve_rows(_q("PATIENT", PatientID="ab123"), "PATIENT")
    assert rows and {r["StudyInstanceUID"] for r in rows} == {a.StudyInstanceUID}


def test_a_bad_file_name_does_not_abort_the_rescan():
    e = Env()
    for _ in range(5):
        write(e.root)
    path, _ = write(e.root)
    _rename_to_undecodable(path)
    idx = InstanceIndex(os.path.join(e.tmp, "fresh.db"), e.log)
    counts = idx.rescan({"received": e.root})
    assert counts["failed"] >= 1
    assert idx.stats()["files"] == 5


def test_a_bad_file_name_does_not_sink_its_async_batch():
    e = Env()
    idx = InstanceIndex(os.path.join(e.tmp, "a.db"), e.log)
    idx.start()
    try:
        paths = [write(e.root)[0] for _ in range(5)]
        p, _ = write(e.root)
        bad = _rename_to_undecodable(p)
        for q in paths:
            idx.enqueue_file(q, "received")
        idx.enqueue_file(os.fsdecode(bad), "received")
        assert idx.flush(10)
        assert idx.stats()["files"] == 5
    finally:
        idx.close()


def test_an_unreadable_folder_is_not_purged():
    if os.name != "posix" or os.geteuid() == 0:
        pytest.skip("needs POSIX permissions and a non-root user")
    e = Env()
    p1 = os.path.join(e.root, "P1")
    p2 = os.path.join(e.root, "P2")
    for d in (p1, p2):
        path, _ = write(d)
        e.index.add_file(path, "received")
    os.chmod(p2, 0)
    try:
        counts = e.index.rescan({"received": e.root}, purge=True)
        assert counts["removed"] == 0 or counts["errors"] > 0
        assert e.index.stats()["files"] == 2
    finally:
        os.chmod(p2, 0o755)


def test_an_emptied_root_is_not_purged():
    e = Env()
    for _ in range(3):
        e.add()
    import shutil
    for name in os.listdir(e.root):
        shutil.rmtree(os.path.join(e.root, name))
    e.index.rescan({"received": e.root}, purge=True)
    assert e.index.stats()["files"] == 3
    assert any("empty" in x["message"] for x in e.log.tail(20))


# Windows will not delete a folder that holds an open file, and the index keeps
# one sqlite handle per thread: these tests close what they opened, and their
# temporary folders tolerate a handle another thread has not let go of yet.
def test_an_emptied_root_does_not_block_purging_the_other_groups():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:  # Windows: see above
        recv = os.path.join(tmp, "recv")
        out = os.path.join(tmp, "out")
        idx = InstanceIndex(os.path.join(tmp, "i.db"), LogBuffer())
        gone, _ = write(recv)
        kept, _ = write(recv)
        held, _ = write(out)
        for p, g in ((gone, "received"), (kept, "received"), (held, "outgoing")):
            idx.add_file(p, g)
        os.remove(gone)                      # a stale row in a healthy group
        import shutil
        shutil.rmtree(os.path.dirname(held))  # the outgoing root now looks unmounted
        try:
            counts = idx.rescan({"received": recv, "outgoing": out}, purge=True)
            assert counts["removed"] == 1
            assert idx.stats()["files"] == 2  # the received survivor + the outgoing row kept
        finally:
            idx.close()


def test_a_nested_sent_folder_keeps_its_own_group():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:  # Windows: see above
        out = os.path.join(tmp, "out")
        sent = os.path.join(out, "sent")
        write(sent)
        idx = InstanceIndex(os.path.join(tmp, "i.db"), LogBuffer())
        roots = {"sent": sent, "outgoing": out}
        try:
            idx.rescan(roots)
            assert idx.stats()["groups"] == {"sent": 1}
            c = idx.rescan(roots)
            assert idx.stats()["groups"] == {"sent": 1}
            assert c["added"] == 0 and c["skipped"] == 1
        finally:
            idx.close()


def test_remove_under_is_a_folder_boundary():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:  # Windows: see above
        idx = InstanceIndex(os.path.join(tmp, "i.db"), LogBuffer())
        a, _ = write(os.path.join(tmp, "r", "a"))
        b, _ = write(os.path.join(tmp, "r", "ab"))
        try:
            idx.add_file(a, "received")
            idx.add_file(b, "received")
            assert idx.remove_under(os.path.join(tmp, "r", "a")) == 1
            assert idx.stats()["files"] == 1
        finally:
            idx.close()


def test_a_root_change_starts_a_rescan():
    from pacs.config import Config
    from pacs.server import PacsServer
    import copy
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:  # Windows: see above
        cfg = Config(os.path.join(tmp, "config.json"))
        cfg.data["scp"]["enabled"] = False
        cfg.data["index"]["path"] = os.path.join(tmp, "index.db")
        cfg.data["logs_dir"] = os.path.join(tmp, "logs")
        cfg.save()
        srv = PacsServer(cfg)
        srv.start_index()
        try:
            new_root = os.path.join(tmp, "elsewhere")
            write(new_root)
            doc = copy.deepcopy(cfg.data)
            doc["scp"]["storage_dir"] = new_root
            srv.apply_config(doc)
            deadline = time.time() + 10
            while time.time() < deadline and srv.index.stats()["files"] < 1:
                time.sleep(0.1)
            assert srv.index.stats()["files"] == 1
        finally:
            srv.shutdown()


# ---------------------------------------------------------------- C-FIND
def test_a_capped_find_does_not_end_on_success(monkeypatch):
    e = Env()
    for _ in range(3):
        e.add()
    monkeypatch.setattr(Q, "_MAX_MATCHES", 2)
    scp = QrSCP(aet="CARINOQR", bind="127.0.0.1", port=free_port(), log=e.log, index=e.index,
                get_storage_roots=lambda: [e.root])
    scp.start()
    try:
        ae = AE("WS1")
        ae.add_requested_context(StudyRootQueryRetrieveInformationModelFind)
        assoc = ae.associate("127.0.0.1", scp.port, ae_title="CARINOQR")
        out = [s.Status for s, _i in assoc.send_c_find(
            _q("STUDY", StudyInstanceUID=""), StudyRootQueryRetrieveInformationModelFind)]
        assoc.release()
        assert out.count(0xFF00) + out.count(0xFF01) == 2
        assert out[-1] != 0x0000 and out[-1] == 0xA700
    finally:
        scp.stop()


# ---------------------------------------------------------------- C-MOVE
class Rejecting:
    """A Storage SCP that refuses chosen SOP Instance UIDs with 0xA700."""

    def __init__(self, reject=()):
        self.reject = set(reject)
        self.got = []
        self.port = free_port()
        ae = AE("DEST")
        for c in AllStoragePresentationContexts:
            ae.add_supported_context(c.abstract_syntax, ALL_TRANSFER_SYNTAXES)
        self.server = ae.start_server(("127.0.0.1", self.port), block=False,
                                      evt_handlers=[(evt.EVT_C_STORE, self._store)])

    def _store(self, event):
        uid = str(event.dataset.SOPInstanceUID)
        if uid in self.reject:
            return 0xA700
        self.got.append(uid)
        return 0x0000

    def close(self):
        self.server.shutdown()


def _move(port, query, dest="DEST"):
    ae = AE("WS1")
    ae.add_requested_context(StudyRootQueryRetrieveInformationModelMove)
    assoc = ae.associate("127.0.0.1", port, ae_title="CARINOQR")
    out = list(assoc.send_c_move(query, dest, StudyRootQueryRetrieveInformationModelMove))
    assoc.release()
    return out


def _qr(e, **kw):
    kw.setdefault("get_storage_roots", lambda: [e.root])
    scp = QrSCP(aet="CARINOQR", bind="127.0.0.1", port=free_port(), log=e.log, index=e.index, **kw)
    scp.start()
    return scp


def test_the_failed_list_names_both_the_missing_file_and_the_refused_instance():
    e = Env()
    study = generate_uid()
    made = [e.add(StudyInstanceUID=study, InstanceNumber=i) for i in range(4)]
    os.remove(made[0][0])
    dest = Rejecting(reject={str(made[1][1].SOPInstanceUID)})
    scp = _qr(e, move_destinations={"DEST": {"host": "127.0.0.1", "port": dest.port, "aet": "DEST"}})
    try:
        status, ident = _move(scp.port, _q("STUDY", StudyInstanceUID=study))[-1]
        assert status.Status == 0xB000
        assert int(status.NumberOfFailedSuboperations) == 2
        failed = set(ident.FailedSOPInstanceUIDList)
        assert {str(made[0][1].SOPInstanceUID), str(made[1][1].SOPInstanceUID)} <= failed
    finally:
        scp.stop()
        dest.close()


def test_nothing_delivered_is_a702_not_b000():
    e = Env()
    study = generate_uid()
    made = [e.add(StudyInstanceUID=study, InstanceNumber=i) for i in range(3)]
    os.remove(made[0][0])
    dest = Rejecting(reject={str(m[1].SOPInstanceUID) for m in made[1:]})
    scp = _qr(e, move_destinations={"DEST": {"host": "127.0.0.1", "port": dest.port, "aet": "DEST"}})
    try:
        status, _ = _move(scp.port, _q("STUDY", StudyInstanceUID=study))[-1]
        assert status.Status == 0xA702
        assert int(status.get("NumberOfCompletedSuboperations", 0) or 0) == 0
    finally:
        scp.stop()
        dest.close()


def test_the_exact_ae_title_wins_and_an_ambiguous_one_is_refused():
    e = Env()
    scp = QrSCP(aet="CARINOQR", bind="127.0.0.1", port=free_port(), log=e.log, index=e.index,
                get_destinations=lambda: [{"name": "a", "aet": "pacs", "host": "h", "port": 1},
                                          {"name": "b", "aet": "PACS", "host": "h", "port": 2}])
    assert scp.resolve_move_destination("PACS")["port"] == 2
    amb = QrSCP(aet="CARINOQR", bind="127.0.0.1", port=free_port(), log=e.log, index=e.index,
                get_destinations=lambda: [{"name": "a", "aet": "pacs", "host": "h", "port": 1},
                                          {"name": "b", "aet": "Pacs", "host": "h", "port": 2}])
    assert amb.resolve_move_destination("PACS") is None


def test_a_destination_routing_scrubs_for_is_not_a_move_target():
    e = Env()
    scp = QrSCP(aet="CARINOQR", bind="127.0.0.1", port=free_port(), log=e.log, index=e.index,
                get_destinations=lambda: [{"name": "Teach", "aet": "TEACH", "host": "h", "port": 1}],
                is_deid_destination=lambda name: name == "Teach")
    assert scp.resolve_move_destination("TEACH") is None


def test_a_vanished_newest_copy_is_served_from_the_older_one():
    e = Env()
    study = generate_uid()
    path, ds = e.add(StudyInstanceUID=study)
    sent_root = os.path.join(e.tmp, "sent")
    newer, _ = write(sent_root, sop_uid=str(ds.SOPInstanceUID), StudyInstanceUID=study,
                     SeriesInstanceUID=str(ds.SeriesInstanceUID))
    os.utime(newer, (time.time() + 100, time.time() + 100))
    e.index.add_file(newer, "sent")
    os.remove(newer)
    dest = Rejecting()
    scp = _qr(e, get_storage_roots=lambda: [e.root, sent_root],
              move_destinations={"DEST": {"host": "127.0.0.1", "port": dest.port, "aet": "DEST"}})
    try:
        status, _ = _move(scp.port, _q("STUDY", StudyInstanceUID=study))[-1]
        assert status.Status == 0x0000
        assert dest.got == [str(ds.SOPInstanceUID)]
    finally:
        scp.stop()
        dest.close()


def test_stop_ends_idle_associations_promptly():
    e = Env()
    scp = _qr(e)
    ae = AE("WS1")
    ae.add_requested_context(StudyRootQueryRetrieveInformationModelFind)
    assoc = ae.associate("127.0.0.1", scp.port, ae_title="CARINOQR")
    assert assoc.is_established
    t0 = time.time()
    scp.stop(timeout=3)
    assert time.time() - t0 < 2.5
    deadline = time.time() + 5
    while assoc.is_established and time.time() < deadline:
        time.sleep(0.05)
    assert not assoc.is_established


def _ev(identifier, cancelled=False):
    ns = types.SimpleNamespace
    return ns(identifier=identifier, is_cancelled=cancelled,
              context=ns(abstract_syntax=StudyRootQueryRetrieveInformationModelMove),
              assoc=ns(requestor=ns(ae_title="WS1", address="127.0.0.1")))


def test_a_service_stop_mid_retrieve_is_not_reported_as_a_cancel():
    e = Env()
    path, ds = e.add()
    scp = QrSCP(aet="CARINOQR", bind="127.0.0.1", port=free_port(), log=e.log, index=e.index,
                get_storage_roots=lambda: [e.root])
    rows = e.index.query_instances(limit=0)
    stop = threading.Event()
    stop.set()
    first = next(scp._yield_instances(rows, _ev(None), stop, "WS1", "C-MOVE"))
    assert first[0] != 0xFE00


def test_a_tls_destination_is_never_dialled_in_plaintext():
    e = Env()
    path, ds = e.add()
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(5)
    listener.settimeout(0.5)
    port = listener.getsockname()[1]

    def bad_ctx():
        raise OSError("no CA bundle")
    scp = _qr(e, move_destinations={"SECURE": {"host": "127.0.0.1", "port": port,
                                               "aet": "SECURE", "tls": True}},
              get_tls_context=bad_ctx)
    try:
        status, _ = _move(scp.port, _q("STUDY", StudyInstanceUID=str(ds.StudyInstanceUID)),
                          dest="SECURE")[-1]
        assert status.Status == 0xA801
        with pytest.raises(socket.timeout):
            listener.accept()
    finally:
        scp.stop()
        listener.close()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
