"""The Stuck panel's per-file detail and its two actions (discard, send-to).

Both actions delete or transmit, and their file handles come from a request
body, so most of this file is about what they REFUSE: anything the stuck
listing itself would not have shown as orphaned or held.

Runs under pytest, or standalone: python3 tests/test_stuck_actions.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pacs import scu                                     # noqa: E402
from pacs import users as U                              # noqa: E402
from test_history import write_instance                  # noqa: E402

WRITE = {"X-Carino": "1"}
NODE_A = {"name": "PACS-A", "host": "127.0.0.1", "port": 1, "aet": "PACSA", "enabled": True}


def _engine():
    from pacs.config import Config
    from pacs.server import PacsServer
    tmp = tempfile.mkdtemp(prefix="carino-stuck-")
    cfg = Config(os.path.join(tmp, "config.json")).load()
    cfg.scu["watch_dir"] = os.path.join(tmp, "outgoing")
    cfg.data["destinations"] = [dict(NODE_A)]
    cfg.save()
    srv = PacsServer(cfg)
    watch = cfg.resolved("scu", "watch_dir")
    return srv, tmp, watch


def _queue(srv, watch, rel, entry, **tags):
    path = write_instance(os.path.join(watch, rel), **tags)
    srv.watcher.state.put(path, {"sent": [], "fail": {}, **entry})
    return path


def _populate(srv, watch):
    orphan = _queue(srv, watch, "P1/s/orphan.dcm", {"route": ["Gone"]},
                    patient_name="DOE^JANE", patient_id="P1", study_desc="Head CT")
    held = _queue(srv, watch, "P2/s/held.dcm", {"route": [], "held": ["Research"]},
                  patient_name="ROE^JOHN", patient_id="P2", study_desc="Chest")
    queued = _queue(srv, watch, "P3/s/queued.dcm", {"route": ["PACS-A"]})
    retrying = _queue(srv, watch, "P4/s/retry.dcm", {
        "route": ["PACS-A"],
        "fail": {"PACS-A": {"attempts": 2, "last_error": "refused", "next_try": time.time() + 60}}},
        patient_name="POE^ANN", patient_id="P4")
    return orphan, held, queued, retrying


# ---- the listing ------------------------------------------------------------

def test_rows_carry_who_each_file_belongs_to_only_when_asked():
    srv, _tmp, watch = _engine()
    try:
        _populate(srv, watch)
        full = srv.stuck_sends(detail=True)
        item = full["orphaned"][0]["items"][0]
        assert item["patient"] == "JANE DOE" and item["patient_id"] == "P1"
        assert item["study_desc"] == "Head CT"
        assert item["rel"] == os.path.join("P1", "s", "orphan.dcm")
        assert full["held"][0]["items"][0]["patient"] == "JOHN ROE"
        # The retrying rows used to carry no files at all.
        retry = full["destinations"][0]
        assert retry["files"] == ["retry.dcm"]
        assert retry["items"][0]["patient_id"] == "P4"
        # The badge path reads no headers.
        light = srv.stuck_sends()
        assert "items" not in light["orphaned"][0]
        assert light["attention_files"] == full["attention_files"] == 3
    finally:
        srv.shutdown()


# ---- discard ----------------------------------------------------------------

def test_discard_removes_an_orphan_and_forgets_it():
    srv, _tmp, watch = _engine()
    try:
        orphan, held, _q, _r = _populate(srv, watch)
        res = srv.discard_stuck([os.path.relpath(orphan, watch), os.path.relpath(held, watch)])
        assert res["ok"] and res["removed"] == 2, res
        assert not os.path.exists(orphan) and not os.path.exists(held)
        assert srv.watcher.state.peek(orphan) is None
        assert not srv.stuck_sends()["orphaned"]
        # The emptied study folders are pruned, the outgoing folder itself kept.
        assert not os.path.exists(os.path.dirname(orphan))
        assert os.path.isdir(watch)
    finally:
        srv.shutdown()


def test_discard_refuses_anything_the_listing_did_not_report():
    srv, tmp, watch = _engine()
    try:
        orphan, _h, queued, retrying = _populate(srv, watch)
        outside = write_instance(os.path.join(tmp, "elsewhere", "x.dcm"))
        srv.watcher.state.put(outside, {"route": ["Gone"], "sent": []})
        for bad in ([os.path.relpath(queued, watch)],            # merely queued
                    [os.path.relpath(retrying, watch)],          # retries on its own
                    ["../elsewhere/x.dcm"],                       # traversal
                    [outside],                                    # absolute
                    [os.path.relpath(orphan, watch), "nope.dcm"],  # all or nothing
                    [], "P1/s/orphan.dcm", [None]):
            res = srv.discard_stuck(bad)
            assert not res["ok"] and res["field"] == "files", (bad, res)
        for p in (orphan, queued, retrying, outside):
            assert os.path.exists(p)
    finally:
        srv.shutdown()


def test_discard_refuses_a_file_that_still_owes_a_live_node():
    srv, _tmp, watch = _engine()
    try:
        # Orphaned for "Gone", but PACS-A (enabled) has not got it yet.
        both = _queue(srv, watch, "P9/s/both.dcm", {
            "route": ["PACS-A", "Gone"],
            "fail": {"PACS-A": {"attempts": 1, "last_error": "refused",
                                "next_try": time.time() + 60}}}, patient_id="P9")
        # Held for Research while still owed to PACS-A.
        held = _queue(srv, watch, "P8/s/held.dcm",
                      {"route": ["PACS-A"], "held": ["Research"]}, patient_id="P8")
        for p in (both, held):
            res = srv.discard_stuck([os.path.relpath(p, watch)])
            assert not res["ok"] and res["field"] == "files", res
            assert res["owing"] == ["PACS-A"] and "PACS-A" in res["message"]
            assert os.path.exists(p) and srv.watcher.state.peek(p) is not None
        # Once PACS-A has it, the file owes nobody living and may go.
        e = srv.watcher.state.peek(both)
        e["sent"] = ["PACS-A"]
        e["fail"] = {}
        srv.watcher.state.put(both, e)
        res = srv.discard_stuck([os.path.relpath(both, watch)])
        assert res["ok"] and res["removed"] == 1, res
        assert not os.path.exists(both)
    finally:
        srv.shutdown()


# ---- send ---------------------------------------------------------------------

def _wait_for(log, text, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if any(text in e.get("message", "") for e in log.since(0)):
            return True
        time.sleep(0.05)
    return False


def test_send_forwards_to_the_picked_node_and_keeps_the_file():
    srv, _tmp, watch = _engine()
    sent = []
    real = scu.c_store

    def fake(dest, path, aet, **kw):
        sent.append((dest.name, os.path.basename(path)))
        return scu.SendResult(True, "ok")
    scu.c_store = fake
    try:
        orphan, _h, _q, _r = _populate(srv, watch)
        res = srv.send_stuck([os.path.relpath(orphan, watch)], "PACS-A")
        assert res["ok"] and res["files"] == 1, res
        assert _wait_for(srv.log, "Stuck files sent to PACS-A")
        assert sent == [("PACS-A", "orphan.dcm")]
        assert os.path.exists(orphan)
    finally:
        scu.c_store = real
        srv.shutdown()


def test_send_refuses_an_unknown_node_and_a_held_one():
    srv, _tmp, watch = _engine()
    try:
        orphan, _h, _q, _r = _populate(srv, watch)
        rel = [os.path.relpath(orphan, watch)]
        res = srv.send_stuck(rel, "Nowhere")
        assert not res["ok"] and res["field"] == "destination"
        res = srv.send_stuck(rel, "")
        assert not res["ok"] and res["field"] == "destination"
        # A rule scrubs for PACS-A and the profile is off: nothing goes to it,
        # not even by hand.
        with srv.cfg.mutate():
            srv.cfg.data["routing"] = {"enabled": True, "rules": [
                {"name": "r", "match": {}, "destinations": ["PACS-A"], "deidentify": True}]}
            srv.cfg.data["deid"]["profile"] = "off"
            srv.cfg.save()
        res = srv.send_stuck(rel, "PACS-A")
        assert not res["ok"] and res["field"] == "destination", res
    finally:
        srv.shutdown()


# ---- the HTTP layer -------------------------------------------------------------

def test_discard_needs_studies_delete_and_send_needs_studies_send():
    from pacs.web import create_app
    srv, _tmp, watch = _engine()
    try:
        orphan, _h, _q, _r = _populate(srv, watch)
        with srv.cfg.mutate():
            srv.cfg.users["profiles"] = U.preset_profiles()
            srv.cfg.save()
        ids = {p["name"]: p["id"] for p in srv.cfg.users["profiles"]}
        app = create_app(srv)

        def signed_in(name):
            c = app.test_client()
            assert c.post("/api/login", json={"profile": ids[name]},
                          headers=WRITE).status_code == 200
            return c

        rel = os.path.relpath(orphan, watch)
        it = signed_in("IT")                     # studies.send, not studies.delete
        assert it.post("/api/stuck/discard", json={"files": [rel]},
                       headers=WRITE).status_code == 403
        assert os.path.exists(orphan)
        r = it.post("/api/stuck/send", json={"files": ["../x"], "destination": "PACS-A"},
                    headers=WRITE)
        assert r.status_code == 400 and r.get_json()["field"] == "files"
        # IT may not see patient names; the per-file rows go through the same
        # redaction as everything else.
        body = it.get("/api/stuck").get_json()
        assert body["orphaned"][0]["items"][0]["patient"] == U.REDACTED
        assert body["orphaned"][0]["items"][0]["patient_id"] == "P1"
        admin = signed_in("Administrator")
        r = admin.post("/api/stuck/discard", json={"files": [rel]}, headers=WRITE)
        assert r.status_code == 200, r.get_json()
        assert not os.path.exists(orphan)
    finally:
        srv.shutdown()


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except Exception as exc:          # noqa: BLE001
                failed += 1
                print(f"FAIL {name}: {exc!r}")
    sys.exit(1 if failed else 0)
