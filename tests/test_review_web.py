"""Regression tests for the 2026-10 review of the dashboard API: the Host
allow-list, login throttling and sessions, per-endpoint capabilities, PHI
redaction, the config-save gates, the secrets endpoints, profiles, security
headers, the editor's CORS and the audit trail.

Driven against the real create_app() (with the stub server of test_web_auth,
or a real PacsServer where the behaviour lives in server.py).

Runs under pytest, or directly:  python3 tests/test_review_web.py
"""

from __future__ import annotations

import copy
import json
import os
import stat
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest                                              # noqa: E402

from pacs import auth, ingest, users as U                  # noqa: E402
from pacs.logbuf import LogBuffer                          # noqa: E402
from pacs.web import create_app                            # noqa: E402
from test_web_auth import FakeServer, TOKEN, WRITE, make   # noqa: E402

FOREIGN = {"Host": "attacker.example:8042", "Origin": "http://attacker.example:8042"}


_MADE: list = []


def _tmp():
    d = tempfile.mkdtemp(prefix="carino-review-web-")
    _MADE.append(d)
    return d


@pytest.fixture(autouse=True, scope="module")
def _cleanup():
    yield
    import shutil
    for d in _MADE:
        shutil.rmtree(d, ignore_errors=True)


def _row(name, caps, phi=(), password=None, **extra):
    r = {"id": U.new_id(), "name": name, "role": extra.pop("role", ""), "enabled": True,
         "capabilities": list(caps), "phi_visible": list(phi),
         "password": U.hash_password(password) if password else None}
    r.update(extra)
    return r


def _with_profiles(rows, presets=True):
    srv = FakeServer(_tmp())
    profiles = (U.preset_profiles() if presets else []) + list(rows)
    with srv.cfg.mutate():
        srv.cfg.users["profiles"] = profiles
        srv.cfg.save()
    app = create_app(srv)
    ids = {p["name"]: p["id"] for p in srv.cfg.users["profiles"]}
    return srv, app, ids


def _login(app, pid, password=None):
    c = app.test_client()
    body = {"profile": pid}
    if password:
        body["password"] = password
    r = c.post("/api/login", json=body, headers=WRITE)
    assert r.status_code == 200, r.get_data(as_text=True)
    return c


# ---------------------------------------------------------- Host allow-list
def test_a_foreign_host_is_refused_while_no_credential_is_required():
    srv, _app, c = make(_tmp())
    shut = []
    srv.shutdown = lambda: shut.append(True)
    assert c.get("/api/config", headers=FOREIGN).status_code == 421
    assert c.post("/api/shutdown", headers={**FOREIGN, **WRITE}).status_code == 421
    assert shut == []
    before = copy.deepcopy(srv.cfg.dicomweb)
    doc = copy.deepcopy(srv.cfg.data)
    doc["dicomweb"]["cors_origins"] = ["*"]
    r = c.post("/api/config", json=doc, headers={**FOREIGN, **WRITE})
    assert r.status_code == 421 and srv.cfg.dicomweb == before


@pytest.mark.parametrize("host", ["127.0.0.1:8042", "localhost:8042", "[::1]:8042", "localhost"])
def test_loopback_names_keep_working(host):
    _srv, _app, c = make(_tmp())
    assert c.get("/api/status", headers={"Host": host}).status_code == 200


def test_an_operator_listed_name_is_accepted():
    _srv, _app, c = make(_tmp(), web__allowed_hosts=["pacs.local"])
    assert c.get("/api/status", headers={"Host": "pacs.local:8042"}).status_code == 200


def test_the_write_header_is_still_required():
    _srv, _app, c = make(_tmp())
    r = c.post("/api/shutdown")
    assert r.status_code == 403 and r.get_json()["message"] == "missing X-Carino header"


@pytest.mark.parametrize("path", ["/api/status", "//api/status", "/api//status", "/api/status/",
                                  "/api/%73tatus", "/dicom-web//studies",
                                  "/dicom-web/../api/status"])
def test_no_path_spelling_slips_past_the_token(path):
    _srv, _app, c = make(_tmp(), token=TOKEN, dicomweb__enabled=True)
    assert c.get(path).status_code != 200


def test_stow_refuses_simple_content_types_and_foreign_origins():
    _srv, _app, c = make(_tmp(), dicomweb__enabled=True)
    assert c.post("/dicom-web/studies", data=b"x", content_type="text/plain").status_code == 415
    r = c.post("/dicom-web/studies", data=b"x",
               content_type='multipart/related; type="application/dicom"; boundary=b',
               headers={"Origin": "http://evil.example"})
    assert r.status_code == 403


def test_dicomweb_answers_to_no_rebound_name():
    _srv, _app, c = make(_tmp(), dicomweb__enabled=True)
    r = c.get("/dicom-web/studies", headers={"Host": "evil.example",
                                             "Accept": "application/dicom+json"})
    assert r.status_code in (400, 403, 421)


# ------------------------------------------------------------------ login
def test_a_blocked_client_is_refused_before_the_password_is_checked(monkeypatch):
    srv, app, ids = _with_profiles([_row("Ana", ["studies.read"], password="hunter22")])
    c = app.test_client()
    for _ in range(8):
        c.post("/api/login", json={"profile": ids["Ana"], "password": "wrong"}, headers=WRITE)
    checked = []
    real = U.Profile.check_password
    monkeypatch.setattr(U.Profile, "check_password",
                        lambda self, pw: (checked.append(pw), real(self, pw))[1])
    t0 = time.perf_counter()
    r = c.post("/api/login", json={"profile": ids["Ana"], "password": "hunter22"}, headers=WRITE)
    assert r.status_code == 429
    assert checked == []
    assert time.perf_counter() - t0 < 0.05


def test_unknown_and_known_ids_cost_about_the_same():
    srv, app, ids = _with_profiles([_row("Ana", ["studies.read"], password="hunter22")])

    def timed(pid):
        c = app.test_client()
        t0 = time.perf_counter()
        c.post("/api/login", json={"profile": pid, "password": "nope"}, headers=WRITE)
        return time.perf_counter() - t0
    known = min(timed(ids["Ana"]) for _ in range(2))
    unknown = min(timed("u_bbbbbbbbbbbb") for _ in range(2))
    assert unknown > known / 3


def test_a_block_on_one_account_does_not_lock_out_another():
    srv, app, ids = _with_profiles([_row("Ana", ["studies.read"], password="hunter22"),
                                    _row("Bea", ["studies.read"], password="correct8")])
    c = app.test_client()
    for _ in range(8):
        c.post("/api/login", json={"profile": ids["Ana"], "password": "wrong"}, headers=WRITE)
    r = c.post("/api/login", json={"profile": ids["Bea"], "password": "correct8"}, headers=WRITE)
    assert r.status_code == 200


def test_login_by_typed_name_when_the_picker_is_hidden():
    srv, app, ids = _with_profiles([_row("Ana", ["studies.read"], password="hunter22")])
    with srv.cfg.mutate():
        srv.cfg.users["list_profiles"] = False
        srv.cfg.save()
    c = app.test_client()
    r = c.post("/api/login", json={"profile": "Ana", "password": "hunter22"}, headers=WRITE)
    assert r.status_code == 200 and "carino_session" in r.headers.get("Set-Cookie", "")
    assert c.post("/api/login", json={"profile": "ana", "password": "hunter22"},
                  headers=WRITE).status_code == 200
    bad = app.test_client().post("/api/login", json={"profile": "Nobody", "password": "x"},
                                 headers=WRITE)
    assert bad.status_code == 401 and bad.get_json()["auth"]["reason"] == "invalid"


def test_logout_ends_the_session_on_the_server():
    srv, app, ids = _with_profiles([])
    c = _login(app, ids["Administrator"])
    cookie = c.get_cookie("carino_session").value
    assert c.post("/api/logout", headers=WRITE).status_code == 200
    thief = app.test_client()
    thief.set_cookie("carino_session", cookie)
    assert thief.get("/api/status").status_code == 401


def test_the_rate_limiter_is_thread_safe():
    lim = auth.RateLimiter(max_clients=50)
    errors = []
    old = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)

    def work(n):
        try:
            for i in range(3000):
                k = f"{n}-{i % 40}"
                lim.record_failure(k)
                lim.retry_after(k)
                if i % 7 == 0:
                    lim.clear(k)
        except Exception as exc:          # noqa: BLE001
            errors.append(exc)
    ts = [threading.Thread(target=work, args=(n,)) for n in range(8)]
    try:
        for t in ts:
            t.start()
        for t in ts:
            t.join()
    finally:
        sys.setswitchinterval(old)
    assert errors == []


def test_session_cookie_flags():
    srv, app, ids = _with_profiles([])
    r = app.test_client().post("/api/login", json={"profile": ids["Administrator"]}, headers=WRITE)
    cookie = r.headers["Set-Cookie"]
    assert "HttpOnly" in cookie and "SameSite=Strict" in cookie and "Secure" not in cookie
    rs = app.test_client().post("/api/login", json={"profile": ids["Administrator"]},
                                headers=WRITE, base_url="https://localhost")
    assert "Secure" in rs.headers["Set-Cookie"]


# ----------------------------------------------------------- capabilities
def test_the_worklist_probe_and_its_clear_need_more_than_config_read():
    srv, app, ids = _with_profiles([_row("Viewer", ["config.read"])])
    called = []
    srv.probe_worklist = lambda st: called.append(st) or {"ok": True}
    c = _login(app, ids["Viewer"])
    r = c.post("/api/worklist/probe", json={"station_aet": "CT1"}, headers=WRITE)
    assert r.status_code == 403 and called == []
    assert r.get_json()["forbidden"]["capability"] in ("services.control", "config.write")
    assert c.post("/api/worklist/caught/clear", headers=WRITE).status_code == 403


def _stage_pdf(tmp, text=b"%PDF-1.4 DOE^JANE PID-777"):
    pending = os.path.join(tmp, "pending")
    src = os.path.join(tmp, "report.pdf")
    open(src, "wb").write(text)
    pid = ingest.stage_pending(pending, src, {"patient": "DOE^JANE"}, "pdf")
    return pending, pid


def _wire_preview(srv, pending):
    srv.pending_preview = lambda pid: ingest.preview_path(pending, pid)


def test_the_pending_preview_needs_every_identifier():
    srv, app, ids = _with_profiles([])
    pending, pid = _stage_pdf(_tmp())
    _wire_preview(srv, pending)
    for who in ("IT",):
        r = _login(app, ids[who]).get(f"/api/pending/preview?id={pid}")
        assert r.status_code == 403 and r.get_json()["forbidden"]["capability"] == "phi.all"
        assert b"DOE^JANE" not in r.data
    ok = _login(app, ids["Administrator"]).get(f"/api/pending/preview?id={pid}")
    assert ok.status_code == 200 and ok.data.startswith(b"%PDF")
    rad = _login(app, ids["Radiologist"]).get(f"/api/pending/preview?id={pid}")
    assert rad.status_code == 200


def test_reveal_is_an_action_not_a_read():
    srv, app, ids = _with_profiles([_row("Viewer", ["studies.read"])])
    called = []
    srv.reveal_study = lambda g, p: called.append(p) or {"ok": True}
    r = _login(app, ids["Viewer"]).post("/api/studies/reveal", json={"path": "/x"}, headers=WRITE)
    assert r.status_code == 403 and called == []


def test_echo_refuses_link_local_and_metadata_addresses():
    srv, app, ids = _with_profiles([])
    srv.echo = lambda d: (_ for _ in ()).throw(AssertionError("dialled"))
    r = _login(app, ids["IT"]).post("/api/echo", json={"host": "169.254.169.254", "port": 80,
                                                       "aet": "X"}, headers=WRITE)
    assert r.status_code == 400


def test_attach_needs_studies_read_as_well_as_send():
    srv, app, ids = _with_profiles([_row("Sender", ["studies.send"])])
    r = _login(app, ids["Sender"]).post("/api/studies/attach", data={"path": "x"}, headers=WRITE)
    assert r.status_code in (400, 403)


# ------------------------------------------------------------------- PHI
def test_order_log_lines_carry_no_name_or_description():
    from pacs import ris
    log = LogBuffer()
    with tempfile.TemporaryDirectory() as tmp:
        store = ris.OrderStore(tmp, log=log)
        msg = ris.HL7Message("MSH|^~\\&|RIS|H|PACS|H|20260101||ORM^O01|C1|P|2.5\r"
                             "PID|||P1||DOE^JANE\rORC|NW|PL1|ACC-SECRET-9\r"
                             "OBR|1|PL1|ACC-SECRET-9|CHEST XRAY\r")
        store.apply_hl7(msg, source="hl7")
    text = "\n".join(e["message"] for e in log.tail(50))
    assert "JANE" not in text and "CHEST XRAY" not in text


def test_the_dated_log_file_needs_every_identifier():
    srv, app, ids = _with_profiles([])
    d = _tmp()
    srv.log = LogBuffer(log_dir=d)
    srv.log.info("something happened", kind="ris")
    day = srv.log.days()[0]
    r = _login(app, ids["IT"]).get(f"/api/log/file?day={day}")
    assert r.status_code == 403 and r.get_json()["forbidden"]["capability"] == "phi.all"


def test_paths_reach_a_restricted_profile_only_as_handles():
    srv, app, ids = _with_profiles([_row("Viewer", ["studies.read", "studies.send",
                                                    "routing.read"])])
    srv.list_studies = lambda group: {"studies": [{"patient_id": "PID-777", "patient": "X",
                                                   "path": "/srv/storage/PID-777/1.2"}]}
    sent = []
    srv.send_study = lambda g, p: sent.append(p) or {"ok": True}
    c = _login(app, ids["Viewer"])
    body = c.get("/api/studies").get_data(as_text=True)
    assert "PID-777" not in body
    handle = json.loads(body)["studies"][0]["path"]
    assert c.post("/api/studies/send", json={"path": handle}, headers=WRITE).status_code == 200
    assert sent == ["/srv/storage/PID-777/1.2"]


def test_a_log_path_field_does_not_name_the_patient():
    srv, app, ids = _with_profiles([_row("Logs", ["logs.read"])])
    srv.log = LogBuffer()
    srv.log.info("Stored CT x.dcm", kind="store", path="/srv/storage/PID-777/1.2/1.2.1/x.dcm")
    body = _login(app, ids["Logs"]).get("/api/log").get_data(as_text=True)
    assert "PID-777" not in body


def test_order_numbers_are_redacted_like_the_accession():
    srv, app, ids = _with_profiles([_row("Orders", ["orders.read"],
                                         phi=["patient_name", "patient_id"])])
    srv.list_orders = lambda status=None: {"orders": [{"id": "o1", "accession": "ACC-SECRET-9",
                                                       "filler_order_number": "ACC-SECRET-9",
                                                       "placer_order_number": "ACC-SECRET-9"}],
                                           "counts": {}}
    body = _login(app, ids["Orders"]).get("/api/ris/orders").get_data(as_text=True)
    assert "ACC-SECRET-9" not in body


def test_an_order_edit_never_writes_the_placeholder_back():
    srv, app, ids = _with_profiles([_row("Clerk", ["orders.read", "orders.write"],
                                         phi=["patient_name", "patient_id", "accession"])])
    got = []
    srv.update_order = lambda oid, fields: got.append(fields) or {"ok": True}
    r = _login(app, ids["Clerk"]).post("/api/ris/orders/update", json={
        "id": "o1", "patient_birthdate": "***", "patient_sex": "***", "referring": "***",
        "study_desc": "***", "modality": "DX"}, headers=WRITE)
    assert r.status_code == 200
    assert got and "***" not in got[0].values() and got[0]["modality"] == "DX"


def test_full_phi_profiles_are_not_over_redacted():
    srv, app, ids = _with_profiles([])
    srv.log = LogBuffer()
    srv.log.info("Something about DOE^JANE", kind="store", path="/s/PID-1/x.dcm")
    body = _login(app, ids["Radiologist"]).get("/api/log").get_data(as_text=True)
    assert "PID-1" in body


def test_rule_match_blocks_are_not_redacted():
    out = U.redact({"rules": [{"match": {"study_desc": "CHEST*"}}]}, U.Profile({"phi_visible": []}))
    assert out["rules"][0]["match"]["study_desc"] == "CHEST*"


# --------------------------------------------------------------- config save
def _ops(caps_minus=("destinations.write", "routing.write")):
    it = next(p for p in U.preset_profiles() if p["name"] == "IT")
    return _row("Ops", [c for c in it["capabilities"] if c not in caps_minus],
                phi=it.get("phi_visible") or [])


@pytest.mark.parametrize("edit, field", [
    (lambda d: d["qr"].update(move_destinations={"EVIL": {"host": "203.0.113.5", "port": 104,
                                                          "aet": "EVIL"}}), "qr.move_destinations"),
    (lambda d: d["web"].update(editor_url="https://attacker.example/"), "web.editor_url"),
    (lambda d: d["dicomweb"].update(cors_origins=["https://viewer.example"]),
     "dicomweb.cors_origins"),
])
def test_egress_fields_need_destinations_write(edit, field):
    srv, app, ids = _with_profiles([_ops()])
    c = _login(app, ids["Ops"])
    doc = c.get("/api/config").get_json()
    edit(doc)
    r = c.post("/api/config", json=doc, headers=WRITE)
    assert r.status_code == 403, r.get_data(as_text=True)
    assert r.get_json()["forbidden"]["capability"] == "destinations.write"
    assert field in r.get_json()["forbidden"]["fields"]


def test_echoing_the_editor_url_back_unchanged_is_fine():
    srv, app, ids = _with_profiles([_ops()])
    c = _login(app, ids["Ops"])
    doc = c.get("/api/config").get_json()
    assert c.post("/api/config", json=doc, headers=WRITE).status_code == 200


def test_a_destructive_forwarder_setting_needs_studies_delete():
    srv, app, ids = _with_profiles([_ops()])
    c = _login(app, ids["Ops"])
    doc = c.get("/api/config").get_json()
    doc["scu"]["on_success"] = "delete"
    r = c.post("/api/config", json=doc, headers=WRITE)
    assert r.status_code == 403 and r.get_json()["forbidden"]["capability"] == "studies.delete"


def test_the_audit_trail_cannot_be_turned_off_with_config_write():
    srv, app, ids = _with_profiles([])
    c = _login(app, ids["IT"])
    doc = c.get("/api/config").get_json()
    doc["audit"]["enabled"] = False
    r = c.post("/api/config", json=doc, headers=WRITE)
    assert r.status_code == 403 and r.get_json()["forbidden"]["capability"] == "auth.manage"


def test_the_forwarder_may_not_point_at_the_archive():
    from pacs.config import Config
    with tempfile.TemporaryDirectory() as tmp:
        cfg = Config(os.path.join(tmp, "config.json"))
        doc = copy.deepcopy(cfg.data)
        doc["scu"]["watch_dir"] = doc["scp"]["storage_dir"]
        with pytest.raises(ValueError, match="watch_dir"):
            cfg.would_accept(doc)
        doc["scu"]["watch_dir"] = os.path.join(doc["scp"]["storage_dir"], "inner")
        with pytest.raises(ValueError):
            cfg.would_accept(doc)


def test_a_save_that_cannot_restart_the_receiver_says_so():
    import socket
    from pacs.config import Config
    from pacs.server import PacsServer

    def free():
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        p = s.getsockname()[1]
        s.close()
        return p
    with tempfile.TemporaryDirectory() as tmp:
        cfg = Config(os.path.join(tmp, "config.json"))
        cfg.data["index"]["enabled"] = False
        cfg.data["logs_dir"] = os.path.join(tmp, "logs")
        cfg.data["scp"].update(enabled=True, bind="127.0.0.1", port=free())
        cfg.save()
        srv = PacsServer(cfg)
        srv.sync_services()
        busy = socket.socket()
        busy.bind(("127.0.0.1", 0))
        busy.listen(1)
        try:
            c = create_app(srv).test_client()
            doc = c.get("/api/config").get_json()
            doc["scp"]["port"] = busy.getsockname()[1]
            r = c.post("/api/config", json=doc, headers=WRITE)
            assert r.status_code == 200
            assert [f for f in r.get_json()["failed"] if "eceiver" in f["service"]]
        finally:
            busy.close()
            srv.shutdown()


# ---------------------------------------------------------------- secrets
def test_a_profiles_only_administrator_can_set_the_site_key():
    srv, app, ids = _with_profiles([])
    c = _login(app, ids["Administrator"])
    r = c.post("/api/deid/secret", json={"action": "set", "secret": "a-long-site-key-xyz-123"},
               headers=WRITE)
    assert r.status_code == 200, r.get_data(as_text=True)
    assert srv.cfg.deid.get("secret")
    rec = _login(app, ids["Reception"]).post("/api/deid/secret",
                                             json={"action": "set", "secret": "x" * 20},
                                             headers=WRITE)
    assert rec.status_code == 403


def test_api_answers_are_never_cached():
    _srv, _app, c = make(_tmp(), token=TOKEN)
    r = c.post("/api/auth/token", json={"action": "rotate"},
               headers={**WRITE, "Authorization": f"Bearer {TOKEN}"})
    assert "no-store" in r.headers.get("Cache-Control", "")


def test_a_webhook_key_of_spaces_is_refused():
    _srv, _app, c = make(_tmp())
    r = c.post("/api/notify/secret", json={"field": "webhook", "action": "set", "value": "   "},
               headers=WRITE)
    assert r.status_code == 400


def test_a_null_notify_block_does_not_500():
    srv, _app, c = make(_tmp())
    srv.cfg.data["notify"]["webhook"] = None
    r = c.post("/api/notify/secret", json={"field": "webhook", "action": "set", "value": "abc"},
               headers=WRITE)
    assert r.status_code in (200, 400)


def test_a_webhook_url_never_reaches_the_log_whole():
    from pacs.notify import Notifier
    from pacs.config import Config
    with tempfile.TemporaryDirectory() as tmp:
        cfg = Config(os.path.join(tmp, "config.json"))
        cfg.data["notify"].update(enabled=True)
        cfg.data["notify"]["webhook"].update(enabled=True, retries=0, timeout_sec=1,
                                             url="http://127.0.0.1:9/services/T0/B0/SECRETPART")
        log = LogBuffer()
        n = Notifier(cfg, log=log)
        n._post_webhook({"event": "x"})
        assert "SECRETPART" not in (n.last_error or "")
        assert not [e for e in log.tail(20) if "SECRETPART" in e["message"]]


def test_log_files_are_tightened_and_never_followed():
    with tempfile.TemporaryDirectory() as d:
        log = LogBuffer(log_dir=d)
        log.info("first")
        day = log.days()[0]
        path = os.path.join(d, day + ".log")
        os.chmod(path, 0o644)
        log.info("second")
        if os.name == "posix":               # Windows has no mode bits to tighten
            assert stat.S_IMODE(os.stat(path).st_mode) == 0o640
        for bad in ("../../etc/passwd", "2026-01-01/../x", "2026-01-01.log"):
            assert log.day_file(bad) is None
        # Not following a planted link rests on O_NOFOLLOW, which Windows lacks
        # (pacs/logbuf.py asks for it with getattr); there the writer would follow.
        if os.name != "posix":
            return
        os.remove(path)
        victim = os.path.join(d, "victim.txt")
        open(victim, "w").write("untouched")
        os.symlink(victim, path)
        log.info("third")
        assert open(victim).read() == "untouched"


def test_a_line_break_cannot_forge_a_log_line():
    with tempfile.TemporaryDirectory() as d:
        log = LogBuffer(log_dir=d)
        log.info("Worklist probe [acc X\n2026-01-01T00:00:00+00:00 [ERROR] forged]", kind="mwl")
        lines = open(os.path.join(d, log.days()[0] + ".log")).read().splitlines()
        assert len(lines) == 1


# --------------------------------------------------------------- profiles
def test_seeding_from_a_rebound_name_is_refused():
    srv, _app, c = make(_tmp())
    r = c.post("/api/profiles/seed", headers=WRITE, base_url="http://rebind.attacker.example:8080")
    assert r.status_code in (400, 403, 421)
    assert U.profiles_of(srv.cfg.users) == []
    ok = c.post("/api/profiles/seed", headers=WRITE)
    assert ok.status_code == 200 and "carino_session" in ok.headers.get("Set-Cookie", "")
    again = c.post("/api/profiles/seed", headers=WRITE)
    assert again.status_code in (400, 401)


def test_a_stale_save_cannot_resurrect_a_deleted_profile():
    srv, app, ids = _with_profiles([_row("Ana", ["studies.read", "studies.delete"],
                                         password="hunter22")])
    c = _login(app, ids["Administrator"])
    rows = c.get("/api/profiles/manage").get_json()["profiles"]
    ana = next(r for r in rows if r["name"] == "Ana")
    assert c.post("/api/profiles/delete", json={"id": ana["id"]}, headers=WRITE).status_code == 200
    r = c.post("/api/profiles/save", json=ana, headers=WRITE)
    assert r.status_code == 404
    assert not [p for p in c.get("/api/profiles/manage").get_json()["profiles"]
                if p["name"] == "Ana"]


def test_a_password_needs_eight_characters():
    srv, app, ids = _with_profiles([])
    c = _login(app, ids["Administrator"])
    short = c.post("/api/profiles/save", json={"name": "Y", "capabilities": ["studies.read"],
                                               "password": {"action": "set", "value": "1234567"}},
                   headers=WRITE)
    assert short.status_code == 400
    ok = c.post("/api/profiles/save", json={"name": "Y", "capabilities": ["studies.read"],
                                            "password": {"action": "set", "value": "12345678"}},
                headers=WRITE)
    assert ok.status_code == 200
    stored = next(p for p in srv.cfg.users["profiles"] if p["name"] == "Y")["password"]
    assert stored["algo"] == "pbkdf2_sha256"
    assert "12345678" not in open(srv.cfg.path).read()


def test_profiles_can_be_seeded_on_a_network_bind_with_an_admin_password():
    srv, _app, c = make(_tmp(), token=TOKEN, web__host="0.0.0.0")
    bearer = {**WRITE, "Authorization": f"Bearer {TOKEN}"}
    assert c.post("/api/profiles/seed", headers=bearer).status_code == 400
    r = c.post("/api/profiles/seed", json={"admin_password": "long-enough-pass"}, headers=bearer)
    assert r.status_code == 200, r.get_data(as_text=True)
    admin = next(p for p in U.profiles_of(srv.cfg.users) if p.admin)
    assert admin.locked
    srv.cfg.would_accept(srv.cfg.data)


# ----------------------------------------------------- static, CORS, headers
@pytest.mark.parametrize("bad", ["javascript:alert(1)//", "data:text/html,x", "//evil.example/",
                                 "vbscript:x"])
def test_the_editor_url_cannot_be_a_script(bad):
    from pacs import config as C
    d = copy.deepcopy(C.DEFAULTS)
    d["web"]["editor_url"] = bad
    with pytest.raises(ValueError, match="editor_url"):
        C.validate(d)


@pytest.mark.parametrize("good", ["", "/editor/", "https://editor.example/e/"])
def test_the_editor_url_accepts_the_real_shapes(good):
    from pacs import config as C
    d = copy.deepcopy(C.DEFAULTS)
    d["web"]["editor_url"] = good
    C.validate(d)


def test_every_response_carries_nosniff_and_frame_protection():
    _srv, _app, c = make(_tmp())
    for url in ("/", "/js/01-core.js", "/api/status"):
        r = c.get(url)
        assert r.headers.get("X-Content-Type-Options") == "nosniff", url
        assert r.headers.get("X-Frame-Options") in ("DENY", "SAMEORIGIN"), url


@pytest.mark.parametrize("url, origin", [
    ("https://Editor.Example:443/e/", "https://editor.example"),
    ("https://u:p@editor.example/", "https://editor.example"),
    ("http://editor.example:8080/", "http://editor.example:8080"),
])
def test_the_editor_origin_is_serialised_like_a_browser_does(url, origin):
    _srv, _app, c = make(_tmp(), web__editor_url=url)
    r = c.get("/api/studies/files?path=x")
    assert r.headers.get("Access-Control-Allow-Origin") == origin
    pre = c.open("/api/studies/files", method="OPTIONS")
    assert "authorization" in pre.headers.get("Access-Control-Allow-Headers", "").lower()


# ------------------------------------------------------------------ audit
def test_an_export_is_itself_recorded_and_keeps_a_torn_line_raw():
    srv, app, ids = _with_profiles([])
    c = _login(app, ids["Administrator"])
    with open(srv.audit.path, "a") as fh:
        fh.write('{"torn":\n')
    r = c.get("/api/audit/export")
    assert r.status_code == 200
    assert "{}" not in r.get_data(as_text=True).splitlines()
    assert '{"torn":' in r.get_data(as_text=True)
    assert srv.audit.tail(1)[0]["action"] == "audit.exported"


def test_a_dicomweb_refusal_is_recorded():
    srv, app, ids = _with_profiles([])
    srv.cfg.dicomweb["enabled"] = True
    c = _login(app, ids["Reception"])
    r = c.post("/dicom-web/studies", data=b"x",
               content_type='multipart/related; type="application/dicom"; boundary=b')
    assert r.status_code == 403
    rec = srv.audit.tail(5)
    assert any(x["action"] == "denied" and x.get("endpoint") == "/dicom-web/studies" for x in rec)


def test_a_token_login_is_attributed_to_the_service_identity():
    srv, _app, c = make(_tmp(), token=TOKEN)
    assert c.post("/api/login", json={"token": TOKEN}, headers=WRITE).status_code == 200
    rec = srv.audit.tail(1, action="login")[0]
    assert rec["actor"]["role"] == "service"


def test_a_dashboard_file_hand_out_is_an_audited_read_when_log_reads_is_on():
    tmp = _tmp()
    srv, _app, c = make(tmp)
    f = os.path.join(tmp, "1.2.3.dcm")
    with open(f, "wb") as fh:
        fh.write(b"DICM")
    srv.study_dicom_file = lambda group, path, name: f
    srv.audit.log_reads = True
    r = c.get("/api/studies/file?group=received&path=x&name=1.2.3.dcm")
    assert r.status_code == 200
    rec = srv.audit.tail(1, action="study.read")
    assert rec and rec[0]["target"] == "1.2.3.dcm"
    srv.audit.log_reads = False
    c.get("/api/studies/file?group=received&path=x&name=1.2.3.dcm")
    assert len(srv.audit.tail(10, action="study.read")) == 1


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
