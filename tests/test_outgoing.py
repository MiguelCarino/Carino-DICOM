"""History → Outgoing: the outgoing folder, one row per study, with where each
study has been delivered.

Under scu.on_success "keep" (the default) a forwarded study never leaves the
outgoing folder, so the Sent / Archived list stays empty and this list is the
only place a delivered study can be found. The per-destination answer is read
off the watcher's SendState, the same record the Stuck tab reads.

Runs under pytest, or standalone: python3 tests/test_outgoing.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pacs import users as U                              # noqa: E402
from test_history import write_instance                  # noqa: E402
from test_routing import FakeStore, fake_store           # noqa: E402

WRITE = {"X-Carino": "1"}
NODE_A = {"name": "PACS-A", "host": "127.0.0.1", "port": 1, "aet": "PACSA", "enabled": True}
NODE_B = {"name": "PACS-B", "host": "127.0.0.1", "port": 2, "aet": "PACSB", "enabled": True}


def _engine(on_success="keep", dests=(NODE_A,)):
    from pacs.config import Config
    from pacs.server import PacsServer
    tmp = tempfile.mkdtemp(prefix="carino-outgoing-")
    cfg = Config(os.path.join(tmp, "config.json")).load()
    cfg.scu["watch_dir"] = os.path.join(tmp, "outgoing")
    cfg.scu["sent_dir"] = os.path.join(tmp, "sent")
    cfg.scu["on_success"] = on_success
    cfg.data["destinations"] = [dict(d) for d in dests]
    cfg.save()
    srv = PacsServer(cfg)
    return srv, tmp, cfg.resolved("scu", "watch_dir")


def _queue(srv, watch, rel, entry, **tags):
    """A file in the outgoing folder with a SendState entry stamped against its
    bytes, as a watcher pass would have left it."""
    path = write_instance(os.path.join(watch, rel), **tags)
    srv.watcher.state.put(path, {"sent": [], "fail": {}, "size": os.path.getsize(path),
                                 "mtime": os.path.getmtime(path), **entry})
    return path


def _by_uid(body):
    return {s["study_uid"]: s for s in body["studies"]}


def _dests(study):
    return {d["name"]: d for d in study["dests"]}


# ---- the listing ------------------------------------------------------------

def test_a_study_sent_under_keep_is_listed_in_outgoing_as_sent():
    """The reported bug: forwarded, kept, and nowhere in History."""
    srv, _tmp, watch = _engine()
    try:
        write_instance(os.path.join(watch, "P1", "s1", "1.dcm"), study_uid="1.9.1")
        write_instance(os.path.join(watch, "P1", "s1", "2.dcm"), study_uid="1.9.1",
                       instance_number=2)
        with fake_store(FakeStore()):
            for _ in range(2):          # the stability gate needs two sightings
                srv.watcher._scan_once()
        out = srv.list_studies("outgoing")
        assert out["group"] == "outgoing" and out["on_success"] == "keep"
        study = _by_uid(out)["1.9.1"]
        assert study["unrouted"] == 0
        assert _dests(study) == {"PACS-A": {
            "name": "PACS-A", "files": 2, "sent": 2, "state": "sent",
            "attempts": 0, "last_error": "", "next_in": None}}
        # And the archive is still empty, which is why Outgoing has to exist.
        sent = srv.list_studies("sent")
        assert sent["studies"] == [] and sent["on_success"] == "keep"
    finally:
        srv.shutdown()


def test_a_failing_destination_reads_as_retrying_beside_one_that_accepted():
    srv, _tmp, watch = _engine(dests=(NODE_A, NODE_B))
    try:
        write_instance(os.path.join(watch, "P2", "s", "1.dcm"), study_uid="1.9.2")
        with fake_store(FakeStore(fail={"PACS-B"})):
            for _ in range(2):
                srv.watcher._scan_once()
        d = _dests(_by_uid(srv.list_studies("outgoing"))["1.9.2"])
        assert d["PACS-A"]["state"] == "sent"
        b = d["PACS-B"]
        assert b["state"] == "retrying" and b["sent"] == 0 and b["attempts"] >= 1
        assert "rejected" in b["last_error"] and b["next_in"] is not None
    finally:
        srv.shutdown()


def test_every_send_state_and_the_worst_file_wins():
    srv, _tmp, watch = _engine(dests=(NODE_A, NODE_B))
    try:
        later = time.time() + 120
        # One study, four files, each in a different state for some node.
        _queue(srv, watch, "P3/s/a.dcm", {"route": ["PACS-A", "PACS-B"], "sent": ["PACS-A"]},
               study_uid="1.9.3")
        _queue(srv, watch, "P3/s/b.dcm", {
            "route": ["PACS-A", "PACS-B"], "sent": ["PACS-A"],
            "fail": {"PACS-B": {"attempts": 3, "last_error": "refused", "next_try": later}}},
            study_uid="1.9.3", instance_number=2)
        _queue(srv, watch, "P3/s/c.dcm", {"route": ["PACS-A", "Gone"], "held": ["Research"],
                                          "hold_cause": "profile-off"},
               study_uid="1.9.3", instance_number=3)
        # Never looked at by a pass: no entry at all.
        write_instance(os.path.join(watch, "P3", "s", "d.dcm"), study_uid="1.9.3",
                       instance_number=4)
        study = _by_uid(srv.list_studies("outgoing"))["1.9.3"]
        assert study["instances"] == 4 and study["unrouted"] == 1
        d = _dests(study)
        # c.dcm is still due for PACS-A: one unsent file outranks two sent ones.
        assert d["PACS-A"]["state"] == "sending"
        assert (d["PACS-A"]["sent"], d["PACS-A"]["files"]) == (2, 3)
        assert d["PACS-B"]["state"] == "retrying" and d["PACS-B"]["attempts"] == 3
        assert d["PACS-B"]["last_error"] == "refused"
        assert 0 < d["PACS-B"]["next_in"] <= 120
        assert d["Gone"]["state"] == "stuck"          # the Stuck tab's "orphaned"
        assert d["Research"]["state"] == "held"
    finally:
        srv.shutdown()


def test_a_replaced_file_is_not_reported_on_its_old_entry():
    srv, _tmp, watch = _engine()
    try:
        path = _queue(srv, watch, "P4/s/x.dcm", {"route": ["PACS-A"], "sent": ["PACS-A"]},
                      study_uid="1.9.4")
        # New bytes under the same name owe a fresh send; the old "sent" is not theirs.
        e = srv.watcher.state.peek(path)
        e["size"] = e["size"] + 1
        study = _by_uid(srv.list_studies("outgoing"))["1.9.4"]
        assert study["dests"] == [] and study["unrouted"] == 1
    finally:
        srv.shutdown()


def test_sent_and_pending_trees_inside_the_outgoing_folder_are_not_outgoing():
    srv, _tmp, watch = _engine()
    try:
        with srv.cfg.mutate():
            srv.cfg.scu["sent_dir"] = os.path.join(watch, "sent")
            srv.cfg.scu["pending_dir"] = os.path.join(watch, "pending")
            srv.cfg.save()
        write_instance(os.path.join(watch, "P5", "s", "1.dcm"), study_uid="1.9.5")
        write_instance(os.path.join(watch, "sent", "P6", "s", "1.dcm"), study_uid="1.9.6")
        write_instance(os.path.join(watch, "pending", "P7", "s", "1.dcm"), study_uid="1.9.7")
        assert set(_by_uid(srv.list_studies("outgoing"))) == {"1.9.5"}
        # The archive itself still lists what is in it.
        assert set(_by_uid(srv.list_studies("sent"))) == {"1.9.6"}
    finally:
        srv.shutdown()


def test_delete_all_on_outgoing_keeps_the_sent_and_pending_trees_inside_it():
    srv, _tmp, watch = _engine()
    try:
        with srv.cfg.mutate():
            srv.cfg.scu["sent_dir"] = os.path.join(watch, "sent")
            # A pending tree one level down: its parent is emptied around it.
            srv.cfg.scu["pending_dir"] = os.path.join(watch, "hold", "pending")
            srv.cfg.save()
        write_instance(os.path.join(watch, "P5", "s", "1.dcm"), study_uid="1.9.5")
        write_instance(os.path.join(watch, "hold", "P9", "1.dcm"), study_uid="1.9.9")
        write_instance(os.path.join(watch, "sent", "P6", "s", "1.dcm"), study_uid="1.9.6")
        write_instance(os.path.join(watch, "hold", "pending", "P7", "s", "1.dcm"),
                       study_uid="1.9.7")
        assert set(_by_uid(srv.list_studies("outgoing"))) == {"1.9.5", "1.9.9"}
        res = srv.delete_all_studies("outgoing")
        assert res["ok"] and res["removed"] == 2
        assert srv.list_studies("outgoing")["total"] == 0
        assert set(_by_uid(srv.list_studies("sent"))) == {"1.9.6"}
        assert os.path.isfile(os.path.join(watch, "hold", "pending", "P7", "s", "1.dcm"))
    finally:
        srv.shutdown()


def test_an_unknown_group_is_refused():
    srv, _tmp, _watch = _engine()
    try:
        try:
            srv.list_studies("elsewhere")
        except ValueError as exc:
            assert "outgoing" in str(exc)
        else:
            raise AssertionError("an unknown group was listed")
    finally:
        srv.shutdown()


# ---- the HTTP layer -------------------------------------------------------------

def test_outgoing_over_http_needs_studies_read_and_is_redacted():
    from pacs.web import create_app
    srv, _tmp, watch = _engine()
    try:
        _queue(srv, watch, "P8/s/a.dcm", {"route": ["PACS-A"], "sent": ["PACS-A"]},
               study_uid="1.9.8", patient_name="DOE^JANE", patient_id="P8")
        with srv.cfg.mutate():
            srv.cfg.users["profiles"] = U.preset_profiles() + [{
                "id": U.new_id(), "name": "Orders only", "role": "x", "enabled": True,
                "admin": False, "capabilities": ["orders.read"], "phi_visible": [],
                "password": None}]
            srv.cfg.save()
        ids = {p["name"]: p["id"] for p in srv.cfg.users["profiles"]}
        app = create_app(srv)

        def signed_in(name):
            c = app.test_client()
            assert c.post("/api/login", json={"profile": ids[name]},
                          headers=WRITE).status_code == 200
            return c

        assert app.test_client().get("/api/studies?group=outgoing").status_code == 401
        r = signed_in("Orders only").get("/api/studies?group=outgoing")
        assert r.status_code == 403
        assert r.get_json()["forbidden"]["capability"] == "studies.read"

        body = signed_in("Administrator").get("/api/studies?group=outgoing").get_json()
        study = _by_uid(body)["1.9.8"]
        assert study["patient"] == "JANE DOE"
        assert study["dests"][0]["name"] == "PACS-A" and study["dests"][0]["state"] == "sent"
        # IT may not see patient names; the new list goes through the same redaction.
        body = signed_in("IT").get("/api/studies?group=outgoing").get_json()
        assert _by_uid(body)["1.9.8"]["patient"] == U.REDACTED
        assert "DOE" not in str(body)

        admin = signed_in("Administrator")
        assert admin.get("/api/studies?group=sent").get_json()["on_success"] == "keep"
        assert admin.get("/api/studies?group=nowhere").status_code == 400
    finally:
        srv.shutdown()



# ---- what the Send button delivered ---------------------------------------------

def _wait_for_hand(srv, group, uid, n=1, timeout=10):
    """send_study runs on a thread; the record lands when it finishes."""
    end = time.time() + timeout
    while time.time() < end:
        study = _by_uid(srv.list_studies(group)).get(uid)
        if study and len(study["hand"]) >= n:
            return study
        time.sleep(0.05)
    raise AssertionError(f"no hand-send record for {uid}")


def test_a_study_sent_by_hand_from_received_says_where_it_went():
    """Sent by hand, it never enters the outgoing folder, so Auto-send's record
    cannot answer for it: before this record, History showed nothing at all."""
    srv, tmp, _watch = _engine(dests=(NODE_A, NODE_B))
    try:
        recv = srv.cfg.resolved("scp", "storage_dir")
        write_instance(os.path.join(recv, "P5", "s", "1.dcm"), study_uid="1.9.5")
        write_instance(os.path.join(recv, "P5", "s", "2.dcm"), study_uid="1.9.5",
                       instance_number=2)
        assert _by_uid(srv.list_studies("received"))["1.9.5"]["hand"] == []
        path = _by_uid(srv.list_studies("received"))["1.9.5"]["path"]
        with fake_store(FakeStore(fail={"PACS-B"})):
            assert srv.send_study("received", path)["ok"]
            study = _wait_for_hand(srv, "received", "1.9.5", n=2)
        hand = {d["name"]: d for d in study["hand"]}
        assert hand["PACS-A"]["state"] == "sent" and hand["PACS-A"]["ok"] == 2
        assert hand["PACS-B"]["state"] == "failed" and hand["PACS-B"]["fail"] == 2
        assert hand["PACS-B"]["last_error"] == "association rejected"
        # It survives a restart, and the latest press is the answer.
        srv.shutdown()
        from pacs.server import PacsServer
        srv = PacsServer(srv.cfg)
        with fake_store(FakeStore()):
            srv.send_study("received", path)
            end = time.time() + 10
            while time.time() < end:
                hand = {d["name"]: d for d in _by_uid(srv.list_studies("received"))["1.9.5"]["hand"]}
                if hand["PACS-B"]["state"] == "sent":
                    break
                time.sleep(0.05)
        assert hand["PACS-B"] == {**hand["PACS-B"], "state": "sent", "ok": 2, "fail": 0,
                                  "last_error": ""}
    finally:
        srv.shutdown()


def test_without_routing_read_destination_names_and_errors_are_withheld():
    """As on the Overview: an error carries host:port, and the names are the
    routing table. A studies.read profile still sees whether a study went out."""
    from pacs.web import create_app
    srv, _tmp, watch = _engine(dests=(NODE_A, NODE_B))
    try:
        _queue(srv, watch, "P9/s/a.dcm",
               {"route": ["PACS-A", "PACS-B"], "sent": ["PACS-A"],
                "fail": {"PACS-B": {"attempts": 3, "last_error": "refused 10.0.0.9:104",
                                    "next_try": time.time() + 60}}},
               study_uid="1.9.9")
        srv.handsent.record("1.9.9", "PACS-B", ok=0, fail=1, last_error="refused 10.0.0.9:104")
        with srv.cfg.mutate():
            srv.cfg.users["profiles"] = U.preset_profiles() + [{
                "id": U.new_id(), "name": "Viewer", "role": "x", "enabled": True,
                "admin": False, "capabilities": ["studies.read"], "phi_visible": [],
                "password": None}]
            srv.cfg.save()
        ids = {p["name"]: p["id"] for p in srv.cfg.users["profiles"]}
        app = create_app(srv)

        def get(name):
            c = app.test_client()
            assert c.post("/api/login", json={"profile": ids[name]},
                          headers=WRITE).status_code == 200
            return c.get("/api/studies?group=outgoing").get_json()

        study = _by_uid(get("Viewer"))["1.9.9"]
        assert "PACS" not in str(study) and "10.0.0.9" not in str(study)
        assert study["dests"] == [{"name": "", "last_error": "", "state": "retrying",
                                   "files": 2, "sent": 1, "attempts": 3,
                                   "next_in": study["dests"][0]["next_in"]}]
        assert study["hand"][0]["name"] == "" and study["hand"][0]["state"] == "failed"
        study = _by_uid(get("Administrator"))["1.9.9"]
        assert {d["name"] for d in study["dests"]} == {"PACS-A", "PACS-B"}
        assert study["hand"][0]["last_error"] == "refused 10.0.0.9:104"
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
