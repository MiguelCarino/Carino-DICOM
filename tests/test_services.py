"""Service control as the dashboard drives it: one on/off model, saves that
restart only what changed, refusals that say why, the Activity log's filters
and files, self-tests, and validation errors that name their field.

Real PacsServer, real listeners on OS-assigned loopback ports, real create_app.

Run:  python3 tests/test_services.py      (or under pytest)
"""

from __future__ import annotations

import copy
import json
import os
import shutil
import socket
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pynetdicom import AE                                  # noqa: E402
from pynetdicom.sop_class import Verification              # noqa: E402

from pacs.config import Config                             # noqa: E402
from pacs.scu import Destination, c_echo                   # noqa: E402
from pacs.server import PacsServer                         # noqa: E402
from pacs.web import create_app                            # noqa: E402

_H = {"X-Carino": "1"}


def _free_port() -> int:
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def _pacs(**sections):
    """A real server with the receiver and the printer enrolled, index off."""
    tmp = tempfile.mkdtemp(prefix="carino-svc-")
    cfg = Config(os.path.join(tmp, "config.json"))
    cfg.data["logs_dir"] = os.path.join(tmp, "logs")
    cfg.data["index"]["enabled"] = False
    cfg.data["scp"].update({"enabled": True, "bind": "127.0.0.1", "port": _free_port(),
                            "storage_dir": os.path.join(tmp, "received")})
    cfg.data["scu"].update({"enabled": False, "watch_dir": os.path.join(tmp, "outgoing"),
                            "sent_dir": os.path.join(tmp, "sent"),
                            "pending_dir": os.path.join(tmp, "pending")})
    cfg.data["ris"].update({"store_dir": os.path.join(tmp, "orders"), "bind": "127.0.0.1",
                            "port": _free_port()})
    cfg.data["print"].update({"enabled": True, "bind": "127.0.0.1", "port": _free_port()})
    cfg.data["mwl"].update({"bind": "127.0.0.1", "port": _free_port()})
    for name, values in sections.items():
        cfg.data[name].update(values)
    cfg.save()
    srv = PacsServer(cfg)
    srv.sync_services()
    client = create_app(srv).test_client()
    return srv, client, tmp


def _done(srv, tmp):
    srv.shutdown()
    shutil.rmtree(tmp, ignore_errors=True)


def _on_disk(srv) -> dict:
    with open(srv.cfg.path, encoding="utf-8") as fh:
        return json.load(fh)


def _save(client, doc, etag=None):
    headers = dict(_H)
    if etag:
        headers["If-Match"] = etag
    return client.post("/api/config", json=doc, headers=headers)


# ---------------------------------------------------------------- C1 one model
def test_stop_and_start_persist_only_their_flag():
    srv, client, tmp = _pacs()
    try:
        receiver = srv.scp
        etag = client.get("/api/config").headers["ETag"]
        r = client.post("/api/printer", json={"action": "stop"}, headers=_H)
        assert r.status_code == 200 and r.get_json()["printer"]["running"] is False, r.get_json()
        assert r.get_json()["printer"]["enabled"] is False
        assert _on_disk(srv)["print"]["enabled"] is False, "Stop did not persist the flag"
        assert srv.scp is receiver and receiver.running, "Stop on one card bounced the receiver"
        # The version moved with the flag, so a Save built on the old copy is
        # refused instead of turning the printer back on.
        stale = _save(client, copy.deepcopy(_on_disk(srv)), etag)
        assert stale.status_code == 409, stale.get_json()

        r = client.post("/api/printer", json={"action": "start"}, headers=_H)
        assert r.status_code == 200 and r.get_json()["printer"]["running"] is True
        assert _on_disk(srv)["print"]["enabled"] is True
        assert srv.scp is receiver, "Start on one card bounced the receiver"

        r = client.post("/api/receiver", json={"action": "stop"}, headers=_H)
        assert r.status_code == 200 and _on_disk(srv)["scp"]["enabled"] is False
        r = client.post("/api/watcher", json={"action": "start"}, headers=_H)
        assert r.status_code == 200 and _on_disk(srv)["scu"]["enabled"] is True
        assert client.post("/api/printer", json={"action": "x"}, headers=_H).status_code == 400
    finally:
        _done(srv, tmp)


def test_start_that_would_clash_is_refused_and_persists_nothing():
    srv, client, tmp = _pacs()
    try:
        srv.cfg.data["mwl"]["port"] = srv.cfg.printer["port"]     # same port as the printer
        srv.cfg.save()
        r = client.post("/api/mwl", json={"action": "start"}, headers=_H)
        assert r.status_code == 400 and "port" in r.get_json()["error"], r.get_json()
        assert _on_disk(srv)["mwl"]["enabled"] is False
        assert not (srv.mwl_scp and srv.mwl_scp.running)
    finally:
        _done(srv, tmp)


def test_start_and_stop_work_while_the_stored_config_is_invalid():
    srv, client, tmp = _pacs()
    try:
        # Hand-edited and invalid somewhere no listener reads.
        srv.cfg.data["destinations"] = [{"name": "X", "host": "h", "port": 0, "aet": "X"}]
        srv.cfg.save()
        etag = client.get("/api/config").headers["ETag"]
        r = client.post("/api/printer", json={"action": "stop"}, headers=_H)
        assert r.status_code == 200 and r.get_json()["printer"]["running"] is False, r.get_json()
        assert _on_disk(srv)["print"]["enabled"] is False
        # Only the flag was written: the invalid row is still there, as it was.
        assert _on_disk(srv)["destinations"][0]["port"] == 0
        assert client.get("/api/config").headers["ETag"] != etag
        r = client.post("/api/printer", json={"action": "start"}, headers=_H)
        assert r.status_code == 200 and r.get_json()["printer"]["running"] is True, r.get_json()
        assert _on_disk(srv)["print"]["enabled"] is True
        # A problem of the service's OWN still refuses its Start.
        srv.cfg.data["mwl"]["port"] = srv.cfg.printer["port"]
        srv.cfg.save()
        r = client.post("/api/mwl", json={"action": "start"}, headers=_H)
        assert r.status_code == 400 and "mwl.port" in r.get_json()["error"], r.get_json()
        srv.cfg.data["mwl"]["port"] = 70000
        srv.cfg.save()
        r = client.post("/api/mwl", json={"action": "start"}, headers=_H)
        assert r.status_code == 400 and "mwl.port" in r.get_json()["error"], r.get_json()
        assert _on_disk(srv)["mwl"]["enabled"] is False
        # Even the receiver's own invalid port does not stop the watcher.
        srv.cfg.data["scp"]["port"] = 70000
        srv.cfg.save()
        r = client.post("/api/watcher", json={"action": "start"}, headers=_H)
        assert r.status_code == 200 and _on_disk(srv)["scu"]["enabled"] is True, r.get_json()
        r = client.post("/api/watcher", json={"action": "stop"}, headers=_H)
        assert r.status_code == 200 and not srv.watcher.running
        assert _on_disk(srv)["scu"]["enabled"] is False
    finally:
        _done(srv, tmp)


def test_setup_waits_for_a_card_start_stop_in_progress():
    import threading
    srv, client, tmp = _pacs()
    try:
        windows = []

        def slow_switch(name, action):
            t0 = time.monotonic()
            time.sleep(0.4)
            windows.append(("card", t0, time.monotonic()))

        def fake_setup(picks):
            t0 = time.monotonic()
            windows.append(("setup", t0, time.monotonic()))
            return {"ok": True}

        srv.set_service = slow_switch
        srv.apply_setup = fake_setup
        app = client.application
        card = threading.Thread(target=lambda: app.test_client().post(
            "/api/printer", json={"action": "stop"}, headers=_H))
        card.start()
        time.sleep(0.1)
        assert app.test_client().post("/api/setup", json={"services": {}},
                                      headers=_H).status_code == 200
        card.join()
        (_, c0, c1), = [w for w in windows if w[0] == "card"]
        (_, s0, _s1), = [w for w in windows if w[0] == "setup"]
        assert s0 >= c1, "setup ran while a card's Start/Stop was moving services"
    finally:
        _done(srv, tmp)


def test_worklist_start_is_an_operator_adopting_it():
    srv, client, tmp = _pacs()
    try:
        srv.mwl_for_orders = True
        r = client.post("/api/mwl", json={"action": "start"}, headers=_H)
        assert r.status_code == 200 and r.get_json()["mwl"]["running"], r.get_json()
        assert srv.mwl_for_orders is False and _on_disk(srv)["mwl"]["enabled"] is True
    finally:
        _done(srv, tmp)


# ------------------------------------------------- C2 / C2b selective restarts
def test_a_save_restarts_only_what_changed():
    srv, client, tmp = _pacs()
    try:
        receiver, printer = srv.scp, srv.print_scp
        doc = copy.deepcopy(_on_disk(srv))
        doc["destinations"] = [{"name": "ARCHIVE", "host": "10.0.0.9", "port": 104,
                                "aet": "ARCHIVE", "enabled": True}]
        doc["routing"]["enabled"] = True
        r = _save(client, doc)
        assert r.status_code == 200, r.get_json()
        assert r.get_json()["restarted"] == [], r.get_json()
        assert srv.scp is receiver and srv.print_scp is printer, "a destination save bounced a listener"

        doc = copy.deepcopy(_on_disk(srv))
        doc["print"]["aet"] = "NEWPRINT"
        r = _save(client, doc)
        assert r.get_json()["restarted"] == ["print receiver"], r.get_json()
        assert srv.scp is receiver, "a printer change bounced the receiver"
        assert srv.print_scp is not printer and srv.print_scp.aet == "NEWPRINT"
    finally:
        _done(srv, tmp)


def test_a_save_flipping_enabled_stops_and_starts():
    srv, client, tmp = _pacs()
    try:
        doc = copy.deepcopy(_on_disk(srv))
        doc["print"]["enabled"] = False
        r = _save(client, doc).get_json()
        assert r["stopped"] == ["print receiver"] and r["restarted"] == [], r
        assert not srv.print_scp.running
        doc["print"]["enabled"] = True
        r = _save(client, doc).get_json()
        assert r["started"] == ["print receiver"], r
        assert srv.print_scp.running
    finally:
        _done(srv, tmp)


# ------------------------------------------------------------ C3 last_problem
def test_rejection_is_logged_with_its_reason_and_on_the_card():
    srv, client, tmp = _pacs(scp={"allowed_aets": ["CT01"]})
    try:
        ae = AE(ae_title="STRANGER")
        ae.add_requested_context(Verification)
        assert ae.associate("127.0.0.1", srv.cfg.scp["port"]).is_rejected
        time.sleep(0.2)
        lines = [e["message"] for e in srv.log.tail(50) if e.get("kind") == "scp"]
        assert any("refused STRANGER" in ln and "allowed list (CT01)" in ln for ln in lines), lines
        card = srv.status()["receiver"]
        assert "STRANGER" in card["last_problem"]["message"] and card["last_problem"]["at"] > 0
        assert card["errors"] == 1
        for block in ("printer", "ris", "mwl", "qr"):
            assert "last_problem" in srv.status()[block], block
        # Survives a Stop/Start of the receiver.
        srv.set_service("receiver", "stop")
        srv.set_service("receiver", "start")
        assert "STRANGER" in srv.status()["receiver"]["last_problem"]["message"]
    finally:
        _done(srv, tmp)


def test_worklist_rejection_is_logged():
    srv, client, tmp = _pacs(mwl={"allowed_aets": ["CT01"]})
    try:
        srv.set_service("mwl", "start")
        ae = AE(ae_title="STRANGER")
        ae.add_requested_context(Verification)
        assert ae.associate("127.0.0.1", srv.cfg.mwl["port"]).is_rejected
        time.sleep(0.2)
        problem = srv.status()["mwl"]["last_problem"]
        assert problem and "MWL: refused STRANGER" in problem["message"], problem
        assert "allowed list (CT01)" in problem["message"]
    finally:
        _done(srv, tmp)


def test_received_file_records_the_sending_ae():
    from pydicom import dcmread
    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, SecondaryCaptureImageStorage, generate_uid
    from pacs.scu import c_store
    srv, client, tmp = _pacs()
    try:
        ds = Dataset()
        ds.file_meta = FileMetaDataset()
        ds.file_meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
        ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds.SOPClassUID = SecondaryCaptureImageStorage
        ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID = generate_uid()
        ds.PatientID, ds.Modality = "P1", "OT"
        ds.StudyInstanceUID, ds.SeriesInstanceUID = generate_uid(), generate_uid()
        src = os.path.join(tmp, "one.dcm")
        ds.save_as(src, enforce_file_format=True)
        dest = Destination("R", "127.0.0.1", srv.cfg.scp["port"], srv.cfg.scp["aet"])
        res = c_store(dest, src, "MODALITY7", timeout=5)
        assert res.ok, res.message
        stored = srv.scp.last_stored
        path = os.path.join(srv.cfg.resolved("scp", "storage_dir"), "P1", ds.StudyInstanceUID,
                            ds.SeriesInstanceUID, stored["file"])
        assert dcmread(path).file_meta.SourceApplicationEntityTitle == "MODALITY7"
    finally:
        _done(srv, tmp)


# ------------------------------------------------------------ C5 scu reasons
def test_sender_says_why_an_association_failed():
    srv, client, tmp = _pacs(scp={"allowed_aets": ["CT01"]})
    try:
        port = srv.cfg.scp["port"]
        res = c_echo(Destination("R", "127.0.0.1", port, srv.cfg.scp["aet"]), "STRANGER", timeout=5)
        assert not res.ok
        assert "rejected permanently" in res.message and "calling AE title not recognised" in res.message
        assert "add STRANGER" in res.message, res.message
        res = c_echo(Destination("R", "127.0.0.1", _free_port(), "NOBODY"), "CT01", timeout=3)
        assert not res.ok and "connection refused" in res.message, res.message
        res = c_echo(Destination("R", "127.0.0.1", port, srv.cfg.scp["aet"]), "CT01", timeout=5)
        assert res.ok, res.message
    finally:
        _done(srv, tmp)


def test_a_dead_node_is_diagnosed_once_and_briefly():
    from pacs import scu
    dead = Destination("D", "127.0.0.1", _free_port(), "NOBODY")
    real = scu.socket.create_connection
    calls = []

    def counting(addr, timeout=None, *a, **k):
        calls.append(timeout)
        return real(addr, timeout, *a, **k)
    scu.socket.create_connection = counting
    scu._diag_cache.clear()
    try:
        first = c_echo(dead, "CT01", timeout=10)
        again = c_echo(dead, "CT01", timeout=10)
        assert not first.ok and "connection refused" in first.message, first.message
        assert again.message == first.message
        # Capped well under the association's own timeout, and not repeated
        # for the next file to the same node.
        assert calls == [scu._DIAG_TIMEOUT], calls
        scu._diag_cache.clear()
        c_echo(dead, "CT01", timeout=10)
        assert len(calls) == 2
    finally:
        scu.socket.create_connection = real
        scu._diag_cache.clear()


# --------------------------------------------------------- C6 the Activity log
def test_log_filters_and_files():
    srv, client, tmp = _pacs()
    try:
        srv.log.info("print ok one", kind="print")
        srv.log.warn("print jammed", kind="print")
        srv.log.error("store failed hard", kind="store")
        srv.log.info("jammed but harmless", kind="ris")

        def get(qs):
            r = client.get("/api/log" + qs)
            assert r.status_code == 200
            return [e["message"] for e in r.get_json()["entries"]]

        assert get("?kind=print")[-2:] == ["print ok one", "print jammed"]
        assert get("?kind=print&level=warn") == ["print jammed"]
        assert "store failed hard" in get("?level=warn") and "print ok one" not in get("?level=warn")
        assert "store failed hard" in get("?level=error") and "print jammed" not in get("?level=error")
        assert get("?q=JAMMED") == ["print jammed", "jammed but harmless"]
        assert get("?kind=print,ris&q=jammed&limit=1") == ["jammed but harmless"]
        assert srv.log._items.maxlen >= 2000

        today = time.strftime("%Y-%m-%d", time.gmtime())
        days = client.get("/api/log/days").get_json()["days"]
        assert today in days, days
        r = client.get(f"/api/log/file?day={today}")
        assert r.status_code == 200 and r.mimetype == "text/plain"
        assert "attachment" in r.headers.get("Content-Disposition", "")
        assert b"print jammed" in r.data
        r.close()
        assert client.get("/api/log/file?day=1999-01-01").status_code == 404
        assert client.get("/api/log/file?day=../config").status_code == 404
        assert client.get("/api/log/file").status_code == 404
    finally:
        _done(srv, tmp)


# ------------------------------------------------------------- C4 self-tests
def test_selftest_receiver_and_ris():
    srv, client, tmp = _pacs(ris={"enabled": True})
    try:
        r = client.post("/api/selftest", json={"service": "receiver"}, headers=_H).get_json()
        assert r["ok"] and "C-ECHO" in r["message"] and isinstance(r["ms"], int), r
        r = client.post("/api/selftest", json={"service": "ris"}, headers=_H).get_json()
        assert r["ok"] and "ACK" in r["message"], r
        r = client.post("/api/selftest", json={"service": "mwl"}, headers=_H).get_json()
        assert r["ok"] is False and "not running" in r["message"], r
        r = client.post("/api/selftest", json={"service": "bogus"}, headers=_H)
        assert r.status_code == 200 and r.get_json()["ok"] is False
    finally:
        _done(srv, tmp)


# ------------------------------------------------- C12 errors name the field
def test_validation_error_names_the_field():
    srv, client, tmp = _pacs()
    try:
        doc = copy.deepcopy(_on_disk(srv))
        doc["scp"]["port"] = 0
        r = _save(client, doc)
        assert r.status_code == 400 and r.get_json()["field"] == "scp.port", r.get_json()
        doc = copy.deepcopy(_on_disk(srv))
        doc["print"]["tls"] = True
        r = _save(client, doc)
        assert r.status_code == 400 and r.get_json()["field"] == "print.tls_cert", r.get_json()
        doc = copy.deepcopy(_on_disk(srv))
        doc["scu"]["aet"] = "X" * 20
        assert _save(client, doc).get_json()["field"] == "scu.aet"
    finally:
        _done(srv, tmp)


# ------------------------------------------------------------- C13 emergency
def test_held_remaining_only_during_an_emergency():
    srv, client, tmp = _pacs()
    try:
        assert srv.status()["emergency"]["held_remaining"] is None
        assert "held_remaining" in client.get("/api/status").get_json()["emergency"]
    finally:
        _done(srv, tmp)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"\nPASS — {len(tests)} service tests")
