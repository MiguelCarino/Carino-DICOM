"""The connection doctor: the journal of recent associations, the plain-words
diagnosis with its fix, and the destination check that asks a node what it
would refuse before a real study fails on it.

Real pynetdicom associations on loopback against fake remotes that refuse in
each of the ways a real one does, plus a real PacsServer for the incoming side
and the HTTP layer.

Run:  python3 tests/test_connections.py      (or under pytest)
"""

from __future__ import annotations

import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pydicom.dataset import Dataset, FileMetaDataset            # noqa: E402
from pydicom.uid import (ExplicitVRLittleEndian, ImplicitVRLittleEndian,  # noqa: E402
                         JPEGLosslessSV1, SecondaryCaptureImageStorage, generate_uid)
from pynetdicom import AE                                       # noqa: E402
from pynetdicom.sop_class import Verification                   # noqa: E402

from pacs import connections as C                               # noqa: E402
from pacs import users as U                                     # noqa: E402
from pacs.scu import Destination, c_check, c_echo, c_store      # noqa: E402

from dashboard_js import WEB_DIR                                # noqa: E402
from test_services import _H, _done, _free_port, _pacs          # noqa: E402

SECRET = "SECRET^PATIENT"


class Remote:
    """Somebody else's DICOM node, configured to disagree with us."""

    def __init__(self, contexts=(), aet="REMOTE", calling=None, check_called=False):
        self.port = _free_port()
        self.aet = aet
        ae = AE(ae_title=aet)
        ae.add_supported_context(Verification)
        for sop, tss in contexts:
            ae.add_supported_context(sop, tss)
        if calling:
            ae.require_calling_aet = list(calling)
        ae.require_called_aet = check_called
        self.server = ae.start_server(("127.0.0.1", self.port), block=False,
                                      evt_handlers=[])
        time.sleep(0.2)

    def dest(self, aet=None, name="OLD_PACS"):
        return Destination(name, "127.0.0.1", self.port, aet or self.aet)

    def close(self):
        self.server.shutdown()


def _instance(tmp, ts, name="one.dcm"):
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    ds.file_meta.TransferSyntaxUID = ts
    ds.SOPClassUID = SecondaryCaptureImageStorage
    ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID = generate_uid()
    ds.PatientName, ds.PatientID, ds.Modality = SECRET, "P-SECRET-1", "OT"
    ds.StudyInstanceUID, ds.SeriesInstanceUID = generate_uid(), generate_uid()
    path = os.path.join(tmp, name)
    ds.save_as(path, enforce_file_format=True)
    return path


class _Journal:
    """A fresh sending-side journal for one test, put back afterwards."""

    def __enter__(self):
        self.old = C.sender_journal()
        self.j = C.ConnectionJournal()
        C.install_sender_journal(self.j)
        return self.j

    def __exit__(self, *exc):
        C.install_sender_journal(self.old)


def _codes(entry, here=None):
    return [f["code"] for f in C.diagnose(entry, here)]


def _tmpdir():
    import tempfile
    return tempfile.mkdtemp(prefix="carino-conn-")


# ---------------------------------------------------------------- outgoing
def test_a_remote_that_refuses_our_calling_ae():
    remote = Remote(calling=["SOMEONE_ELSE"])
    try:
        with _Journal() as j:
            res = c_echo(remote.dest(), "CARINOSCU", timeout=5)
            assert not res.ok
            (e,) = j.entries()
        assert e["outcome"] == "rejected" and e["reject"] == [1, 1, 3], e
        assert e["direction"] == "out" and e["calling"] == "CARINOSCU" and e["called"] == "REMOTE"
        (f,) = C.diagnose(e)
        assert f["code"] == "out_calling_refused", f
        assert "add CARINOSCU" in f["fix"] and "OLD_PACS" in f["fix"], f["fix"]
    finally:
        remote.close()


def test_a_remote_that_takes_the_class_but_not_the_files_transfer_syntax():
    tmp = _tmpdir()
    remote = Remote([(SecondaryCaptureImageStorage, [ExplicitVRLittleEndian])])
    try:
        path = _instance(tmp, JPEGLosslessSV1)
        with _Journal() as j:
            res = c_store(remote.dest(), path, "CARINOSCU", timeout=5)
            assert not res.ok
            # The send's own error says it is the encoding, not the port.
            assert "not as JPEG Lossless SV1" in res.message, res.message
            assert "does not convert" in res.message, res.message
            (e,) = j.entries()
        assert e["outcome"] == "none_accepted", e
        (ctx,) = e["contexts"]
        assert ctx["sop"] == SecondaryCaptureImageStorage and ctx["proposed"] == [JPEGLosslessSV1]
        assert ctx["result"] == C.TS_NOT_SUPPORTED and ctx["accepted"] == ""
        (f,) = C.diagnose(e)
        assert f["code"] == "out_ts_refused", f
        assert f["say"] == ("OLD_PACS accepts Secondary Capture Image Storage, but not as "
                            "JPEG Lossless SV1."), f["say"]
        # The sender proposes only the file's own syntax; the fix must not
        # promise a conversion that does not happen.
        assert "cannot convert" in f["fix"], f["fix"]
        assert SECRET not in json.dumps(j.entries()) and "P-SECRET-1" not in json.dumps(j.entries())
    finally:
        remote.close()


def test_a_remote_that_accepts_nothing_we_offer():
    tmp = _tmpdir()
    remote = Remote()                       # Verification only
    try:
        path = _instance(tmp, ExplicitVRLittleEndian)
        with _Journal() as j:
            assert not c_store(remote.dest(), path, "CARINOSCU", timeout=5).ok
            (e,) = j.entries()
        assert e["outcome"] == "none_accepted"
        assert e["contexts"][0]["result"] == C.SOP_NOT_SUPPORTED
        (f,) = C.diagnose(e)
        assert f["code"] == "out_sop_refused" and "Secondary Capture Image Storage" in f["say"], f
        # And the Test on that node says it is not a store at all.
        with _Journal() as j:
            assert not c_echo(remote.dest(), "CARINOSCU", timeout=5, check_storage=True).ok
            assert _codes(j.entries()[0]) == ["out_not_storage"]
    finally:
        remote.close()


def test_a_closed_port():
    with _Journal() as j:
        dead = Destination("OLD_PACS", "127.0.0.1", _free_port(), "REMOTE")
        assert not c_echo(dead, "CARINOSCU", timeout=5).ok
        (e,) = j.entries()
    assert e["outcome"] == "refused" and e["contexts"] == [], e
    (f,) = C.diagnose(e)
    assert f["code"] == "out_refused" and f["say"] == f"Nothing is listening at 127.0.0.1:{dead.port}."


def test_the_failover_probe_is_kept_out_of_the_journal():
    with _Journal() as j:
        c_echo(Destination("X", "127.0.0.1", _free_port(), "X"), "CARINOSCU", timeout=5, record=False)
        assert j.entries() == []


def test_identical_failures_fold_into_one_entry():
    tmp = _tmpdir()
    remote = Remote()
    try:
        path = _instance(tmp, ExplicitVRLittleEndian)
        with _Journal() as j:
            for _ in range(3):
                c_store(remote.dest(), path, "CARINOSCU", timeout=5)
            entries = j.entries()
        assert len(entries) == 1 and entries[0]["count"] == 3, entries
    finally:
        remote.close()


def test_the_journal_is_bounded():
    j = C.ConnectionJournal(capacity=5)
    for i in range(12):
        j.record(direction="out", service="send", calling="A", called=f"N{i}", peer="h",
                 port=104, outcome="refused")
    rows = j.entries()
    assert len(rows) == 5 and rows[0]["called"] == "N11", [r["called"] for r in rows]


def test_the_check_batches_past_128_contexts():
    """PS3.8 caps one association at 128 presentation contexts; the check must
    split rather than fail, and keep each class with its reference syntax."""
    remote = Remote([(SecondaryCaptureImageStorage, [ExplicitVRLittleEndian])])
    try:
        pairs = [(f"1.2.826.0.1.3680043.10.1999.{i}", ExplicitVRLittleEndian) for i in range(70)]
        pairs.append((SecondaryCaptureImageStorage, JPEGLosslessSV1))
        with _Journal():
            res = c_check(remote.dest(), "CARINOSCU", pairs, timeout=5)
        assert res["ok"], res
        assert res["batches"] == 2 and len(res["contexts"]) == 142, (res["batches"], len(res["contexts"]))
        assert all(c["result"] is not None for c in res["contexts"])
        sc = [c for c in res["contexts"] if c["sop"] == SecondaryCaptureImageStorage]
        assert {(c["proposed"][0], c["result"], bool(c.get("reference"))) for c in sc} == {
            (JPEGLosslessSV1, C.TS_NOT_SUPPORTED, False), (ImplicitVRLittleEndian, C.TS_NOT_SUPPORTED, True)}
    finally:
        remote.close()


# ---------------------------------------------------------------- incoming
def _incoming(srv):
    return [e for e in srv.journal.entries() if e["direction"] == "in"]


def test_ae_titles_swapped_on_the_modality():
    """The modality has this PACS's AE title as its own and its own as ours."""
    srv, client, tmp = _pacs()
    try:
        ours = srv.cfg.scp["aet"]
        res = c_echo(Destination("R", "127.0.0.1", srv.cfg.scp["port"], "US_ROOM2"), ours,
                     timeout=5, record=False)
        assert res.ok, res.message          # this PACS does not check the called title
        time.sleep(0.2)
        entries = client.get("/api/connections", headers=_H).get_json()["entries"]
        e = next(x for x in entries if x["direction"] == "in")
        assert e["calling"] == ours and e["called"] == "US_ROOM2"
        f = e["findings"][0]
        assert f["code"] == "in_ae_swapped", e["findings"]
        assert "swapped" in f["fix"] and "US_ROOM2" in f["say"]
    finally:
        _done(srv, tmp)


def test_ae_titles_swapped_on_a_destination():
    srv, client, tmp = _pacs()
    remote = Remote(check_called=True)
    try:
        # The destination row carries this PACS's own receiver title.
        dest = {"name": "OLD_PACS", "host": "127.0.0.1", "port": remote.port,
                "aet": srv.cfg.scp["aet"]}
        r = client.post("/api/echo", json=dest, headers=_H).get_json()
        assert not r["ok"]
        e = next(x for x in client.get("/api/connections?peer=OLD_PACS", headers=_H)
                 .get_json()["entries"] if x["direction"] == "out")
        assert e["reject"] == [1, 1, 7]
        assert [f["code"] for f in e["findings"]] == ["out_ae_swapped"], e["findings"]
    finally:
        remote.close()
        _done(srv, tmp)


def test_a_modality_not_in_the_allowed_list():
    srv, client, tmp = _pacs(scp={"allowed_aets": ["CT01"]})
    try:
        c_echo(Destination("R", "127.0.0.1", srv.cfg.scp["port"], srv.cfg.scp["aet"]),
               "US_ROOM2", timeout=5, record=False)
        time.sleep(0.2)
        (e,) = _incoming(srv)
        assert e["outcome"] == "rejected" and e["calling"] == "US_ROOM2"
        (f,) = C.diagnose(e, srv._here())
        assert f["code"] == "in_not_allowed"
        assert f["fix"] == ("If US_ROOM2 should be able to connect, add it under Configuration → "
                            "Settings → This PACS → Accept only these AEs."), f["fix"]
    finally:
        _done(srv, tmp)


def test_images_sent_to_the_worklist_port():
    srv, client, tmp = _pacs(mwl={"enabled": True})
    try:
        srv.sync_services()
        path = _instance(tmp, ExplicitVRLittleEndian)
        c_store(Destination("W", "127.0.0.1", srv.cfg.mwl["port"], srv.cfg.mwl["aet"]), path,
                "US_ROOM2", timeout=5)
        time.sleep(0.2)
        e = next(x for x in _incoming(srv) if x["service"] == "worklist")
        assert e["outcome"] == "none_accepted"
        (f,) = C.diagnose(e, srv._here())
        assert f["code"] == "in_wrong_port", f
        assert f"port {srv.cfg.scp['port']}" in f["fix"] and srv.cfg.scp["aet"] in f["fix"]

        # And the other way round: a worklist query aimed at the receiver.
        from pacs.scu import c_find_worklist
        c_find_worklist(Destination("R", "127.0.0.1", srv.cfg.scp["port"], srv.cfg.scp["aet"]),
                        "US_ROOM2", timeout=5)
        time.sleep(0.2)
        e = next(x for x in _incoming(srv) if x["service"] == "receiver"
                 and x["outcome"] == "none_accepted")
        (f,) = C.diagnose(e, srv._here())
        assert f["code"] == "in_other_port", f
        assert f["vars"]["right_port"] == str(srv.cfg.mwl["port"]), f
        assert f["vars"]["right_aet"] == srv.cfg.mwl["aet"], f
        assert "Modality Worklist" in f["say"], f["say"]
    finally:
        _done(srv, tmp)


# ------------------------------------------------- the check, over HTTP
def test_check_names_what_a_destination_would_refuse():
    """Two kinds of object in the archive; the destination takes Secondary
    Capture only uncompressed, so the JPEG Lossless one would fail."""
    srv, client, tmp = _pacs(index={"enabled": True, "rescan_on_start": False})
    remote = Remote([(SecondaryCaptureImageStorage, [ExplicitVRLittleEndian, ImplicitVRLittleEndian])])
    try:
        here = Destination("RX", "127.0.0.1", srv.cfg.scp["port"], srv.cfg.scp["aet"])
        for i, ts in enumerate((JPEGLosslessSV1, ExplicitVRLittleEndian)):
            assert c_store(here, _instance(tmp, ts, f"i{i}.dcm"), "MOD1", timeout=5).ok
        assert srv.index is not None and srv.index.flush()
        dest = {"name": "OLD_PACS", "host": "127.0.0.1", "port": remote.port, "aet": "REMOTE"}
        r = client.post("/api/connections/check", json=dest, headers=_H).get_json()
        assert r["reachable"] and not r["ok"] and r["from_archive"], r
        assert r["message"] == "OLD_PACS would refuse 1 of 2 kind(s) of object stored here", r["message"]
        assert [f["code"] for f in r["findings"]] == ["out_ts_only_uncompressed"], r["findings"]
        assert "JPEG Lossless SV1" in r["findings"][0]["say"]
        refused = [p for p in r["pairs"] if not p["accepted"] and not p["reference"]]
        assert [(p["ts"], p["instances"]) for p in refused] == [(JPEGLosslessSV1, 1)], r["pairs"]
        body = json.dumps(client.get("/api/connections", headers=_H).get_json())
        assert SECRET not in body and "P-SECRET-1" not in body
    finally:
        remote.close()
        _done(srv, tmp)


def test_check_on_a_closed_port_says_so():
    srv, client, tmp = _pacs()
    try:
        dest = {"name": "OLD_PACS", "host": "127.0.0.1", "port": _free_port(), "aet": "REMOTE"}
        r = client.post("/api/connections/check", json=dest, headers=_H).get_json()
        assert not r["ok"] and not r["reachable"]
        assert [f["code"] for f in r["findings"]] == ["out_refused"], r
    finally:
        _done(srv, tmp)


def test_capability_gates():
    srv, _client, tmp = _pacs()
    try:
        from pacs.web import create_app
        with srv.cfg.mutate():
            srv.cfg.users["profiles"] = U.preset_profiles()
            srv.cfg.save()
        app = create_app(srv)
        ids = {p["name"]: p["id"] for p in srv.cfg.users["profiles"]}
        dest = {"name": "X", "host": "127.0.0.1", "port": _free_port(), "aet": "X"}

        def as_(name):
            c = app.test_client()
            assert c.post("/api/login", json={"profile": ids[name]}, headers=_H).status_code == 200
            return c
        rec, rad, it = as_("Reception"), as_("Radiologist"), as_("IT")
        r = rec.get("/api/connections", headers=_H)
        assert r.status_code == 403 and r.get_json()["forbidden"]["capability"] == "logs.read"
        r = rec.post("/api/connections/check", json=dest, headers=_H)
        assert r.status_code == 403 and r.get_json()["forbidden"]["capability"] == "services.control"
        # Reading the journal is reading the log; testing a node is running a service.
        assert rad.get("/api/connections", headers=_H).status_code == 200
        assert rad.post("/api/connections/check", json=dest, headers=_H).status_code == 403
        assert it.get("/api/connections", headers=_H).status_code == 200
        assert it.post("/api/connections/check", json=dest, headers=_H).status_code == 200
        assert it.post("/api/connections/check", json={"host": "x"}, headers=_H).status_code == 400
    finally:
        _done(srv, tmp)


# ------------------------------------------------- the dashboard's copy
def test_the_dashboard_says_the_same_sentences():
    """The Connections tab renders findings itself so they can be translated;
    a sentence edited in connections.py alone would go stale there."""
    src = open(os.path.join(WEB_DIR, "js", "06-logs.js"), encoding="utf-8").read()
    block = src[src.index("const CONN_TEXT = {"):]
    block = block[:block.index("\n};")]
    found = re.findall(r'^  ([\w]+): \[\s*("(?:[^"\\]|\\.)*"),\s*("(?:[^"\\]|\\.)*")\]', block, re.M)
    mapped = {c: (json.loads(s), json.loads(f)) for c, s, f in found}
    assert mapped == C._TEXT, sorted(set(mapped) ^ set(C._TEXT)) or \
        [c for c in C._TEXT if mapped.get(c) != C._TEXT[c]]


def test_every_sentence_is_translated():
    """CONN_TEXT reaches TF() through a variable, which i18n-parity.mjs cannot
    follow, so a sentence missing from a locale would render English silently."""
    src = open(os.path.join(WEB_DIR, "i18n.js"), encoding="utf-8").read()
    for name in ("es", "'pt-BR'", "ja", "ru"):
        start = src.index("\n    " + name + ": {")
        body = src[start:src.index("\n    },", start)]
        for code, pair in C._TEXT.items():
            for s in pair:
                if s:
                    lit = "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "':"
                    assert lit in body, f"{name} has no translation for {code}: {s!r}"


if __name__ == "__main__":
    names = [n for n in list(globals()) if n.startswith("test_")]
    for n in names:
        globals()[n]()
        print(f"  ok   {n}")
