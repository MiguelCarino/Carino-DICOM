"""Flask-level tests for pacs/web.py: auth, the X-Carino guard, the DICOMweb
mount and the routing/index/qr endpoints.

Driven against the REAL create_app() with a stub PacsServer, so route wiring,
before_request ordering and Werkzeug's URL matching are exercised for real while
server.py stays out of the picture (it is being written in parallel; the stub
below is the contract web.py assumes of it).

Runs under pytest, or standalone: python3 tests/test_web_auth.py
"""

from __future__ import annotations

import contextlib
import copy
import io
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pacs import auth                                    # noqa: E402
from pacs.config import Config                           # noqa: E402
from pacs.index import InstanceIndex                     # noqa: E402
from pacs.web import create_app                          # noqa: E402

TOKEN = "s3cret-token-value-for-tests"
JSON = {"Accept": "application/dicom+json"}
WRITE = {"X-Carino": "1"}


class FakeLog:
    def __init__(self):
        self.lines = []

    def _add(self, level, msg, kind=""):
        self.lines.append((level, msg, kind))

    def info(self, msg, kind=""):
        self._add("info", msg, kind)

    def warn(self, msg, kind=""):
        self._add("warn", msg, kind)

    def error(self, msg, kind=""):
        self._add("error", msg, kind)


class FakeServer:
    """Exactly the PacsServer surface pacs/web.py touches in these tests."""

    def __init__(self, tmpdir):
        self.cfg = Config(os.path.join(tmpdir, "config.json")).load()
        self.log = FakeLog()
        self.index = InstanceIndex(os.path.join(tmpdir, "index.db"), log=self.log)
        self.calls = []
        self.qr_running = False
        self.qr_error = None

    # -- services
    def start_qr(self):
        self.calls.append("start_qr")
        if self.qr_error is not None:
            raise self.qr_error
        self.qr_running = True

    def stop_qr(self):
        self.calls.append("stop_qr")
        self.qr_running = False

    def status(self):
        return {
            "qr": {"enabled": True, "running": self.qr_running, "port": 11115},
            "receiver": {"running": False},
            "destinations": self.cfg.destinations,
            "config_path": self.cfg.path,
            "ris": {"last_order": {"patient": "SECRET^PATIENT"}},
        }

    # -- config (PacsServer.apply_config, minus the service bouncing)
    #
    # The `edit` form is reproduced faithfully, lock and all, because it is a
    # safety property and not a convenience: web.py hands it the merge that
    # re-asserts the stored token and site key, and the whole point of that
    # merge is that it runs INSIDE the critical section that then writes. A fake
    # that called edit() outside the lock would pass every test here while the
    # thing being tested — a rotation cannot be reverted by a Save — was false.
    def apply_config(self, new_data=None, enforce=False, edit=None):
        self.calls.append("apply_config")
        if new_data is None and edit is None:
            raise ValueError("apply_config needs a document or an edit")
        with self.cfg.mutate():
            if edit is not None:
                new_data = edit(copy.deepcopy(self.cfg.data))
            self.cfg.replace(new_data)

    # -- routing / index
    def explain_route(self, group, path):
        self.calls.append(("explain_route", group, path))
        if group not in ("received", "sent"):
            return {"ok": False, "message": "group must be received|sent"}
        return {"ok": True, "path": path, "decision": {"destinations": ["Archive"]}}

    def rescan_index(self):
        self.calls.append("rescan_index")
        if self.index is None:
            return {"ok": False, "message": "the instance index is disabled"}
        return {"ok": True, "message": "Rescanning the storage folders…"}

    def index_status(self):
        block = {"enabled": True, "path": self.cfg.resolved("index", "path"),
                 "rescan_on_start": True, "scanning": False, "studies": 0,
                 "instances": 0, "queued": 0, "writing": False, "errors": 0}
        if self.index is None:
            return {**block, "enabled": False}
        block.update({k: self.index.stats()[k] for k in ("studies", "instances")})
        return block

    # -- studies (only what the CORS-open routes need)
    def study_dicom_files(self, group, path):
        return {"ok": True, "files": []}

    def study_dicom_file(self, group, path, name):
        return None


def make(tmpdir, token="", **cfg_edits):
    srv = FakeServer(tmpdir)
    srv.cfg.web["auth_token"] = token
    for dotted, value in cfg_edits.items():
        section, _, key = dotted.partition("__")
        srv.cfg.data[section][key] = value
    app = create_app(srv)
    app.config["TESTING"] = True
    return srv, app, app.test_client()


def _tmp():
    d = tempfile.mkdtemp(prefix="carino-web-")
    return d


# ---------------------------------------------------------------- no token
def test_no_token_leaves_the_api_open():
    _, _, c = make(_tmp())
    r = c.get("/api/status")
    assert r.status_code == 200, r.data
    assert r.get_json()["auth"] == {"required": False, "authenticated": True}


def test_no_token_dicomweb_open():
    _, _, c = make(_tmp(), dicomweb__enabled=True)
    r = c.get("/dicom-web/studies", headers=JSON)
    assert r.status_code in (200, 204), (r.status_code, r.data[:200])


# ---------------------------------------------------------------- gating
def test_status_is_gated_and_leaks_nothing_before_login():
    _, _, c = make(_tmp(), token=TOKEN)
    r = c.get("/api/status")
    assert r.status_code == 401
    assert r.headers.get("WWW-Authenticate") == 'Bearer realm="Carino PACS"'
    body = r.get_json()
    assert body["ok"] is False
    assert body["auth"] == {"required": True, "reason": "missing", "retry_after": 0}
    # the disclosive payload must not appear in any form
    assert b"SECRET^PATIENT" not in r.data
    assert b"config_path" not in r.data


def test_every_new_route_is_gated():
    _, _, c = make(_tmp(), token=TOKEN, dicomweb__enabled=True)
    gets = ["/api/status", "/api/config", "/api/routing", "/api/index",
            "/api/studies/files?path=x", "/api/studies/file?path=x&name=y",
            "/api/log", "/api/stuck", "/dicom-web/studies"]
    for url in gets:
        assert c.get(url, headers=JSON).status_code == 401, url
    posts = ["/api/qr", "/api/routing/test", "/api/index/rescan", "/api/shutdown"]
    for url in posts:
        r = c.post(url, json={}, headers=WRITE)
        assert r.status_code == 401, (url, r.status_code)


def test_bearer_and_x_carino_token_both_admit():
    _, _, c = make(_tmp(), token=TOKEN)
    assert c.get("/api/status", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200
    assert c.get("/api/status", headers={"Authorization": f"bEaReR {TOKEN}"}).status_code == 200
    assert c.get("/api/status", headers={"X-Carino-Token": TOKEN}).status_code == 200


def test_wrong_token_is_401_invalid():
    _, _, c = make(_tmp(), token=TOKEN)
    r = c.get("/api/status", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401
    assert r.get_json()["auth"]["reason"] == "invalid"
    # the real token must never be echoed back
    assert TOKEN.encode() not in r.data


def test_status_reports_authenticated_once_logged_in():
    _, _, c = make(_tmp(), token=TOKEN)
    r = c.get("/api/status", headers={"X-Carino-Token": TOKEN})
    assert r.get_json()["auth"] == {"required": True, "authenticated": True}


# ---------------------------------------------------------------- login/cookie
def test_login_sets_cookie_and_cookie_authenticates():
    _, _, c = make(_tmp(), token=TOKEN)
    r = c.post("/api/login", json={"token": TOKEN}, headers=WRITE)
    assert r.status_code == 200, r.data
    setc = r.headers.get("Set-Cookie", "")
    assert "carino_session=" in setc
    assert "HttpOnly" in setc and "SameSite=Strict" in setc
    assert TOKEN not in setc                     # the raw token never reaches the browser jar
    # the client keeps the cookie; subsequent calls need no header
    assert c.get("/api/status").status_code == 200


def test_login_is_a_write_so_it_needs_x_carino():
    """The documented integration trap: no header -> 403, not 401."""
    _, _, c = make(_tmp(), token=TOKEN)
    r = c.post("/api/login", json={"token": TOKEN})
    assert r.status_code == 403
    assert r.get_json()["message"] == "missing X-Carino header"


def test_login_with_wrong_token_is_401_and_sets_no_cookie():
    _, _, c = make(_tmp(), token=TOKEN)
    r = c.post("/api/login", json={"token": "wrong"}, headers=WRITE)
    assert r.status_code == 401
    assert "carino_session=" not in r.headers.get("Set-Cookie", "")


def test_logout_clears_the_cookie():
    _, _, c = make(_tmp(), token=TOKEN)
    c.post("/api/login", json={"token": TOKEN}, headers=WRITE)
    assert c.get("/api/status").status_code == 200
    r = c.post("/api/logout", headers=WRITE)
    assert r.status_code == 200
    assert c.get("/api/status").status_code == 401


def test_expired_cookie_reports_expired_not_invalid():
    _, app, c = make(_tmp(), token=TOKEN)
    guard = app.extensions["carino_auth"]
    stale = guard.sessions.issue(TOKEN, now=time.time() - auth.SESSION_TTL - 60)
    c.set_cookie("carino_session", stale)
    r = c.get("/api/status")
    assert r.status_code == 401
    assert r.get_json()["auth"]["reason"] == "expired"


def test_forged_cookie_is_invalid_and_costs_the_attacker_no_budget():
    _, app, c = make(_tmp(), token=TOKEN)
    c.set_cookie("carino_session", "1.99999999999.abc.deadbeef")
    for _ in range(20):
        r = c.get("/api/status")
        assert r.status_code == 401, r.status_code
        assert r.get_json()["auth"]["reason"] == "invalid"
    # forged cookies must not be able to lock the operator out
    assert c.get("/api/status", headers={"X-Carino-Token": TOKEN}).status_code == 200


def test_rotating_the_token_kills_live_sessions():
    srv, _, c = make(_tmp(), token=TOKEN)
    c.post("/api/login", json={"token": TOKEN}, headers=WRITE)
    assert c.get("/api/status").status_code == 200
    srv.cfg.web["auth_token"] = "a-brand-new-token"      # live read, no restart
    assert c.get("/api/status").status_code == 401
    assert c.get("/api/status", headers={"X-Carino-Token": "a-brand-new-token"}).status_code == 200


def test_setting_a_token_at_runtime_takes_effect_immediately():
    srv, _, c = make(_tmp())
    assert c.get("/api/status").status_code == 200
    srv.cfg.web["auth_token"] = TOKEN
    assert c.get("/api/status").status_code == 401


def test_rate_limited_after_the_budget_with_retry_after():
    _, _, c = make(_tmp(), token=TOKEN)
    seen = []
    for _ in range(auth.FAIL_LIMIT + 2):
        seen.append(c.get("/api/status", headers={"X-Carino-Token": "bad"}).status_code)
    assert 429 in seen, seen
    r = c.get("/api/status", headers={"X-Carino-Token": "bad"})
    assert r.status_code == 429
    assert int(r.headers["Retry-After"]) > 0
    assert r.get_json()["auth"]["reason"] == "rate_limited"
    # ...and the correct token still gets through: 8 bad tokens from anyone
    # sharing this source address must not be able to lock the operator out of a
    # running PACS. Only failures are counted.
    assert c.get("/api/status", headers={"X-Carino-Token": TOKEN}).status_code == 200
    # a good credential also forgives the history, so the block is gone
    assert c.get("/api/status", headers={"X-Carino-Token": TOKEN}).status_code == 200


def test_a_blocked_client_can_still_log_in_with_the_right_token():
    _, _, c = make(_tmp(), token=TOKEN)
    for _ in range(auth.FAIL_LIMIT + 2):
        c.post("/api/login", json={"token": "bad"}, headers=WRITE)
    assert c.post("/api/login", json={"token": "bad"}, headers=WRITE).status_code == 429
    r = c.post("/api/login", json={"token": TOKEN}, headers=WRITE)
    assert r.status_code == 200, r.data
    assert "carino_session=" in r.headers.get("Set-Cookie", "")


def test_api_auth_is_public():
    _, _, c = make(_tmp(), token=TOKEN)
    r = c.get("/api/auth")
    assert r.status_code == 200
    assert r.get_json()["auth"] == {"required": True, "authenticated": False}


def test_options_preflight_is_never_gated():
    _, _, c = make(_tmp(), token=TOKEN)
    assert c.options("/api/studies/files").status_code in (200, 204)


# ---------------------------------------------------------------- the token is not config
def _login(c, token=TOKEN):
    r = c.post("/api/login", json={"token": token}, headers=WRITE)
    assert r.status_code == 200, r.data
    return c


def test_get_config_redacts_the_token_for_a_cookie_holder():
    """The reported escalation: GET /api/config handed the permanent shared
    secret to anything holding a 12-hour session cookie, so an XSS or a browser
    extension that stole a session upgraded itself to the token — inverting the
    only reason the cookie exists."""
    srv, _, c = make(_tmp(), token=TOKEN)
    _login(c)
    r = c.get("/api/config")
    assert r.status_code == 200
    assert TOKEN.encode() not in r.data
    web = r.get_json()["web"]
    assert "auth_token" not in web
    assert web["auth_token_set"] is True
    # the live config is untouched — this is a redacted copy, not a mutation
    assert srv.cfg.web["auth_token"] == TOKEN


def test_get_config_says_when_no_token_is_set():
    _, _, c = make(_tmp())
    assert c.get("/api/config").get_json()["web"]["auth_token_set"] is False


def test_a_save_cannot_blank_the_token():
    """A dashboard posts back what GET gave it, and GET no longer carries a
    token. That must mean 'keep', never 'clear': a Save that silently dropped
    the token would leave a LAN-bound dashboard with no credential at all."""
    srv, _, c = make(_tmp(), token=TOKEN)
    _login(c)
    body = c.get("/api/config").get_json()
    body["web"]["editor_url"] = "/editor/"
    r = c.post("/api/config", json=body, headers=WRITE)
    assert r.status_code == 200, r.data
    assert srv.cfg.web["auth_token"] == TOKEN
    # not even by omitting the whole web section
    assert c.post("/api/config", json={"scp": {"port": 11112}}, headers=WRITE).status_code == 200
    assert srv.cfg.web["auth_token"] == TOKEN
    # and the response is redacted too
    assert TOKEN.encode() not in r.data
    assert "auth_token_set" not in json_config(srv)


def json_config(srv):
    """What actually landed on disk — auth_token_set is a view, never stored."""
    import json
    with open(srv.cfg.path, "r", encoding="utf-8") as fh:
        return json.load(fh)["web"]


def test_a_save_cannot_set_the_token_either():
    """A cookie holder must not be able to plant a token they know. Refused out
    loud, with the endpoint that does it."""
    srv, _, c = make(_tmp(), token=TOKEN)
    _login(c)
    r = c.post("/api/config", json={"web": {"auth_token": "planted-by-a-stolen-cookie"}},
               headers=WRITE)
    assert r.status_code == 400
    assert "/api/auth/token" in r.get_json()["error"]
    assert srv.cfg.web["auth_token"] == TOKEN
    # ...including the falsy shapes that used to slip past the security gate:
    # a JSON 0 / false / [] / {} is not the stored token, so it is refused, and
    # "" is a blanking attempt wearing a different hat.
    for value in (0, False, [], {}, ""):
        r = c.post("/api/config", json={"web": {"auth_token": value}}, headers=WRITE)
        assert r.status_code == 400, (value, r.status_code)
        assert srv.cfg.web["auth_token"] == TOKEN, value
    # null is the one exception: a JS client that round-trips an absent field
    # produces it, and "no value" can only ever mean keep — never clear.
    r = c.post("/api/config", json={"web": {"auth_token": None}}, headers=WRITE)
    assert r.status_code == 200, r.data
    assert srv.cfg.web["auth_token"] == TOKEN


def test_a_save_may_echo_the_token_back_unchanged():
    """A caller holding the real token (curl, a script) posting a full config
    with it is not trying to change anything, and must not be fought."""
    srv, _, c = make(_tmp(), token=TOKEN)
    body = c.get("/api/config", headers={"X-Carino-Token": TOKEN}).get_json()
    body["web"].pop("auth_token_set")
    body["web"]["auth_token"] = TOKEN
    r = c.post("/api/config", json=body, headers={**WRITE, "X-Carino-Token": TOKEN})
    assert r.status_code == 200, r.data
    assert srv.cfg.web["auth_token"] == TOKEN


def test_rotation_needs_the_token_itself_not_a_session_cookie():
    srv, _, c = make(_tmp(), token=TOKEN)
    _login(c)
    r = c.post("/api/auth/token", json={"action": "rotate"}, headers=WRITE)
    assert r.status_code == 403
    assert "header" in r.get_json()["error"]
    assert srv.cfg.web["auth_token"] == TOKEN


def test_rotation_mints_a_token_once_and_signs_every_session_out():
    srv, _, c = make(_tmp(), token=TOKEN)
    _login(c)                                        # a live session
    h = {**WRITE, "X-Carino-Token": TOKEN}
    r = c.post("/api/auth/token", json={"action": "rotate"}, headers=h)
    assert r.status_code == 200, r.data
    new = r.get_json()["token"]
    assert len(new) >= 40 and new != TOKEN
    assert srv.cfg.web["auth_token"] == new
    assert json_config(srv)["auth_token"] == new     # persisted, not just in memory
    # the cookie was signed against the old token's fingerprint
    assert c.get("/api/status").status_code == 401
    assert c.get("/api/status", headers={"X-Carino-Token": new}).status_code == 200
    # and it is shown exactly once
    assert TOKEN.encode() not in r.data
    assert new.encode() not in c.get("/api/config", headers={"X-Carino-Token": new}).data
    assert all(new not in line[1] for line in srv.log.lines)


def test_an_operator_chosen_token_must_be_long_enough():
    srv, _, c = make(_tmp(), token=TOKEN)
    h = {**WRITE, "X-Carino-Token": TOKEN}
    r = c.post("/api/auth/token", json={"action": "set", "token": "hunter2"}, headers=h)
    assert r.status_code == 400
    assert srv.cfg.web["auth_token"] == TOKEN
    r = c.post("/api/auth/token", json={"action": "set", "token": "a-long-enough-token-x"},
               headers=h)
    assert r.status_code == 200 and "token" not in r.get_json()
    assert srv.cfg.web["auth_token"] == "a-long-enough-token-x"


def test_the_first_token_can_be_set_with_no_credential_on_loopback():
    """Bootstrapping: nothing is configured, the API is loopback-only, and this
    is how the operator gets a token before binding the dashboard to the LAN."""
    srv, _, c = make(_tmp())
    r = c.post("/api/auth/token", json={"action": "rotate"}, headers=WRITE)
    assert r.status_code == 200, r.data
    assert srv.cfg.web["auth_token"] == r.get_json()["token"]
    assert c.get("/api/status").status_code == 401   # enforced immediately, no restart


def test_clearing_is_refused_while_the_dashboard_is_reachable():
    srv, _, c = make(_tmp(), token=TOKEN)
    srv.cfg.web["host"] = "0.0.0.0"
    h = {**WRITE, "X-Carino-Token": TOKEN}
    r = c.post("/api/auth/token", json={"action": "clear"}, headers=h)
    assert r.status_code == 400
    assert "0.0.0.0" in r.get_json()["error"]
    assert srv.cfg.web["auth_token"] == TOKEN
    # back on loopback it is allowed
    srv.cfg.web["host"] = "127.0.0.1"
    assert c.post("/api/auth/token", json={"action": "clear"}, headers=h).status_code == 200
    assert srv.cfg.web["auth_token"] == ""
    assert c.get("/api/status").status_code == 200


def test_the_rotation_endpoint_is_itself_gated():
    _, _, c = make(_tmp(), token=TOKEN)
    assert c.post("/api/auth/token", json={"action": "rotate"}, headers=WRITE).status_code == 401
    r = c.post("/api/auth/token", json={"action": "wobble"},
               headers={**WRITE, "X-Carino-Token": TOKEN})
    assert r.status_code == 400 and "rotate|set|clear" in r.get_json()["error"]


# ------------------------------------------------- secret writes vs. a concurrent save
def _lost_update_probe(cfg, hold=0.08):
    """Drive a config replace() into the middle of a secret endpoint's own
    read-modify-write, and report what that endpoint actually persisted.

    The window is real but a few microseconds wide, so it is widened here rather
    than raced for: the endpoint's save() is wrapped, and on the request thread
    it hands off to a second thread sitting on a document snapshotted BEFORE the
    endpoint touched anything (a dashboard tab that loaded, then Saved). When
    the endpoint holds cfg.mutate() the second thread cannot get in and the
    hand-off simply times out, which is the whole point.

    Returns the list of tokens/keys the endpoint's save left on disk, read back
    while the request thread still holds whatever lock it took.
    """
    import threading

    real_save = cfg.save
    requester = threading.current_thread()
    hand_off, replaced, landed = threading.Event(), threading.Event(), []

    def hooked_save():
        if threading.current_thread() is not requester:
            return real_save()
        hand_off.set()               # the concurrent Save may go now
        replaced.wait(hold)          # ... and this is its chance to land
        real_save()
        with open(cfg.path, "r", encoding="utf-8") as fh:
            landed.append(json.load(fh))

    cfg.save = hooked_save

    def other_dashboard(stale):
        if hand_off.wait(5):
            try:
                cfg.replace(stale)
            finally:
                replaced.set()

    return landed, hand_off, replaced, other_dashboard


def test_a_token_rotation_is_never_silently_lost_to_a_concurrent_save():
    """POST /api/auth/token read cfg.data, changed it and saved without holding
    cfg.mutate(). A config Save arriving in that gap swaps self.data out, and
    the endpoint's own save then writes the OLD token back — while answering
    ok:true with a freshly minted one. The operator is told the previous token
    is dead, writes the new one down, and the dead one still opens the API.

    Twenty-four rounds, because "it did not happen this time" is not the claim.
    """
    import threading

    for _ in range(24):
        srv, _, c = make(_tmp(), token=TOKEN)
        # A second dashboard's document, assembled before the rotation: it
        # carries the token that was current when its page loaded.
        stale = copy.deepcopy(srv.cfg.data)
        stale["scp"]["port"] = 11190
        landed, _hand, _done, other = _lost_update_probe(srv.cfg)
        t = threading.Thread(target=other, args=(stale,), daemon=True)
        t.start()
        r = c.post("/api/auth/token", json={"action": "rotate"},
                   headers={**WRITE, "X-Carino-Token": TOKEN})
        t.join(10)
        assert r.status_code == 200, r.data
        minted = r.get_json()["token"]
        assert landed, "the endpoint never reached its own save()"
        on_disk = landed[0]["web"]["auth_token"]
        assert on_disk == minted, (
            f"rotation answered ok:true but its own save persisted {on_disk!r}, "
            f"not the minted {minted!r} — the old token still authenticates")


def test_a_site_key_change_is_never_silently_lost_to_a_concurrent_save():
    """Same hole, higher cost: the operator is told the new de-identification
    key is in force, so every export from here on is believed to carry
    pseudonyms derived from it. If the change was discarded they are derived
    from the old one instead, and nothing anywhere records which key made which
    export."""
    import threading

    key = "site-key-long-enough-for-the-floor"
    for _ in range(24):
        srv, _, c = make(_tmp(), token=TOKEN)
        stale = copy.deepcopy(srv.cfg.data)
        stale["scp"]["port"] = 11190
        landed, _hand, _done, other = _lost_update_probe(srv.cfg)
        t = threading.Thread(target=other, args=(stale,), daemon=True)
        t.start()
        r = c.post("/api/deid/secret", json={"action": "set", "secret": key},
                   headers={**WRITE, "X-Carino-Token": TOKEN})
        t.join(10)
        assert r.status_code == 200, r.data
        assert r.get_json()["secret_set"] is True
        assert landed, "the endpoint never reached its own save()"
        on_disk = landed[0].get("deid", {}).get("secret", "")
        assert on_disk == key, (
            f"the site key endpoint answered ok:true but persisted {on_disk!r} — "
            f"exports would keep using the previous key")


# ---------------------------------------------------------------- destinations
def test_duplicate_destination_names_are_refused_by_a_save():
    """Send state, the retry backoff and the archive gate are all dicts keyed by
    destination name, so two enabled destinations sharing one collapse to a
    single entry: the study is archived as fully sent when ONE of them got it,
    and the other node silently never receives the images."""
    srv, _, c = make(_tmp())
    base = c.get("/api/config").get_json()
    base["web"].pop("auth_token_set")

    def save(dests):
        body = dict(base, destinations=dests)
        return c.post("/api/config", json=body, headers=WRITE)

    node = {"host": "h", "port": 104, "aet": "A", "enabled": True}
    r = save([dict(node, name="PACS"), dict(node, name="PACS")])
    assert r.status_code == 400
    assert "same name" in r.get_json()["error"]
    # case is not enough to tell them apart either
    r = save([dict(node, name="PACS"), dict(node, name="pacs")])
    assert r.status_code == 400, r.data
    r = save([dict(node, name="PACS"), dict(node, name=" pacs ")])
    assert r.status_code == 400, r.data
    # a blank name is no name at all
    r = save([dict(node, name="")])
    assert r.status_code == 400 and "blank name" in r.get_json()["error"]
    r = save([dict(node, name="   ")])
    assert r.status_code == 400
    # ...and the legitimate config still saves
    r = save([dict(node, name="PACS"), dict(node, name="Teaching archive")])
    assert r.status_code == 200, r.data
    assert [d["name"] for d in srv.cfg.destinations] == ["PACS", "Teaching archive"]


# ---------------------------------------------------------------- dicomweb config
def test_cors_origins_is_a_real_config_field():
    """pacs/dicomweb.py reads dicomweb.cors_origins on every request; it was in
    no DEFAULTS, so a dashboard round-trip could not carry it and nothing
    validated it."""
    from pacs.config import DEFAULTS

    assert DEFAULTS["dicomweb"]["cors_origins"] == []
    srv, _, c = make(_tmp())
    body = c.get("/api/config").get_json()
    body["web"].pop("auth_token_set")
    assert body["dicomweb"]["cors_origins"] == []
    body["dicomweb"]["cors_origins"] = ["https://viewer.example"]
    assert c.post("/api/config", json=body, headers=WRITE).status_code == 200
    assert srv.cfg.dicomweb["cors_origins"] == ["https://viewer.example"]
    for bad in ("https://viewer.example", [1], [None], {}):
        body["dicomweb"]["cors_origins"] = bad
        r = c.post("/api/config", json=body, headers=WRITE)
        assert r.status_code == 400, (bad, r.status_code)
        assert "cors_origins" in r.get_json()["error"]


# ------------------------------------------------------- concurrent saves
def test_two_dashboards_saving_at_once_no_longer_discard_each_other():
    """A Save posts a WHOLE document assembled from a page-load snapshot, so two
    tabs editing different sections never merge: both were told ok:true, the
    later one won, and the earlier change was gone with nothing said. On this
    API that silent revert can be a destination, a routing rule or scp.enabled
    — a study stops being forwarded and nothing anywhere explains it."""
    srv, _, c = make(_tmp())
    first = c.get("/api/config")
    etag = first.headers.get("ETag")
    assert etag, "GET /api/config publishes no version for a Save to be checked against"
    tab_a = first.get_json()
    tab_b = copy.deepcopy(tab_a)                 # the same snapshot, in a second tab

    tab_a["scp"]["aet"] = "TAB-A"
    saved = c.post("/api/config", json=tab_a, headers=WRITE)
    assert saved.status_code == 200, saved.data
    assert saved.headers.get("ETag") not in (None, etag), "the version did not move with the document"

    tab_b["scu"]["aet"] = "TAB-B"
    stale = c.post("/api/config", json=tab_b, headers={**WRITE, "If-Match": etag})
    assert stale.status_code == 409, (stale.status_code, stale.data)
    body = stale.get_json()
    assert body.get("code") == "stale_config", body
    assert "reload" in body["error"].lower(), body["error"]
    assert srv.cfg.scp["aet"] == "TAB-A", "the other tab's change was reverted anyway"
    assert srv.cfg.scu["aet"] != "TAB-B", "a refused save was applied"

    # The recovery the message names has to actually work, and the fresh version
    # is accepted bare as well as quoted — nobody is refused over punctuation.
    fresh = c.get("/api/config")
    retry = fresh.get_json()
    retry["scu"]["aet"] = "TAB-B"
    r = c.post("/api/config", json=retry,
               headers={**WRITE, "If-Match": fresh.headers["ETag"].strip('"')})
    assert r.status_code == 200, r.data
    assert (srv.cfg.scp["aet"], srv.cfg.scu["aet"]) == ("TAB-A", "TAB-B")


def test_a_save_with_no_version_still_behaves_exactly_as_before():
    """The dashboard in this tree does not send one yet — collectConfig()
    assembles a fixed set of top-level keys — and a Save that began failing on
    something the client cannot send would be worse than the bug being fixed.
    No If-Match is the old last-writer-wins behaviour, unchanged."""
    from pacs.config import DEFAULTS

    srv, _, c = make(_tmp())
    snapshot = c.get("/api/config").get_json()
    a, b = copy.deepcopy(snapshot), copy.deepcopy(snapshot)
    a["scp"]["aet"], b["scu"]["aet"] = "TAB-A", "TAB-B"
    assert c.post("/api/config", json=a, headers=WRITE).status_code == 200
    r = c.post("/api/config", json=b, headers=WRITE)
    assert r.status_code == 200, r.data
    assert srv.cfg.scu["aet"] == "TAB-B"
    assert srv.cfg.scp["aet"] == DEFAULTS["scp"]["aet"], "unversioned saves changed meaning"


def test_the_version_is_a_header_never_a_config_field():
    """It rides in the ETag and nowhere else. A field in the document would have
    made every client that posts back what GET handed it (both e2e suites here,
    and app.js in spirit) conflict with itself the day it shipped — and a field
    the server accepted but did not check would be a client believing its Save
    is guarded when nothing is guarding it. So the key is refused out loud, the
    way a token posted to this endpoint already is, and never reaches the file."""
    srv, _, c = make(_tmp())
    r = c.get("/api/config")
    assert "config_version" not in r.get_json(), "the version leaked into the document"
    body = r.get_json()
    body["config_version"] = r.headers["ETag"].strip('"')
    bad = c.post("/api/config", json=body, headers=WRITE)
    assert bad.status_code == 400, (bad.status_code, bad.data)
    assert "If-Match" in bad.get_json()["error"]
    assert "config_version" not in srv.cfg.data
    # And the save that does go through writes no trace of it either: the merge
    # over DEFAULTS keeps every key it is handed, so one slipped in here would
    # be in config.json for good.
    body.pop("config_version")
    assert c.post("/api/config", json=body, headers=WRITE).status_code == 200
    with open(srv.cfg.path, encoding="utf-8") as fh:
        assert "config_version" not in json.load(fh)


def test_a_stale_save_is_refused_even_when_the_change_came_from_elsewhere():
    """Not only another dashboard: the setup chooser, the token endpoint and a
    hand edit to config.json all move the document under a tab that is sitting
    on a snapshot. The fingerprint is of the stored document, so it does not
    matter who changed it."""
    srv, _, c = make(_tmp())
    r = c.get("/api/config")
    etag, doc = r.headers["ETag"], r.get_json()
    with srv.cfg.mutate():
        srv.cfg.data["destinations"] = [{"name": "Archive", "host": "10.0.0.5",
                                         "port": 104, "aet": "ARCHIVE"}]
        srv.cfg.save()
    doc["scp"]["port"] = 11190
    late = c.post("/api/config", json=doc, headers={**WRITE, "If-Match": etag})
    assert late.status_code == 409, (late.status_code, late.data)
    assert srv.cfg.destinations, "the out-of-band destination was wiped by a stale save"


# ---------------------------------------------------------------- file modes
# Not strictly web tests, but they belong beside the token ones: both are about
# what a secret looks like once it is on disk, where the API guard cannot help.
def test_dated_log_files_are_not_world_readable():
    """Log lines carry patient names, patient IDs, accession numbers and the AE
    title of every node this box talks to."""
    if os.name != "posix":
        return
    from pacs.logbuf import LogBuffer

    d = _tmp()
    log = LogBuffer(log_dir=d)
    log.info("Received CT study for DOE^JANE (ID 12345)", kind="store")
    files = [f for f in os.listdir(d) if f.endswith(".log")]
    assert files, os.listdir(d)
    mode = os.stat(os.path.join(d, files[0])).st_mode & 0o777
    assert mode == 0o640, oct(mode)


def test_the_config_file_is_not_world_readable():
    """It holds web.auth_token in plaintext; at 0644 every local account owns
    the dashboard API."""
    if os.name != "posix":
        return
    srv, _, c = make(_tmp())
    h = {**WRITE}
    assert c.post("/api/auth/token", json={"action": "rotate"}, headers=h).status_code == 200
    mode = os.stat(srv.cfg.path).st_mode & 0o777
    assert mode == 0o600, oct(mode)


def test_a_scaffolded_config_starts_at_0600_too():
    """`pacs init` copies config.example.json, which is a 0644 file in the
    repo — and the dashboard writes the token into that copy later."""
    if os.name != "posix":
        return
    from pacs.__main__ import main as cli

    path = os.path.join(_tmp(), "config.json")
    assert cli(["--config", path, "init"]) == 0
    assert os.stat(path).st_mode & 0o777 == 0o600, oct(os.stat(path).st_mode & 0o777)


# ---------------------------------------------------------------- static tree
def test_static_shell_stays_anonymous_so_the_prompt_can_render():
    _, _, c = make(_tmp(), token=TOKEN)
    for url in ("/", "/app.js", "/styles.css", "/editor/"):
        r = c.get(url)
        assert r.status_code == 200, (url, r.status_code)


# ---------------------------------------------------------------- X-Carino
def test_x_carino_still_fires_for_an_authenticated_write():
    srv, _, c = make(_tmp(), token=TOKEN)
    h = {"X-Carino-Token": TOKEN}
    r = c.post("/api/qr", json={"action": "start"}, headers=h)
    assert r.status_code == 403
    assert r.get_json()["message"] == "missing X-Carino header"
    assert srv.calls == []                       # never reached the server
    r = c.post("/api/qr", json={"action": "start"}, headers={**h, **WRITE})
    assert r.status_code == 200
    assert "start_qr" in srv.calls


def test_auth_answers_before_the_write_guard():
    """401 (log in) must win over 403 (missing header) or the dashboard shows
    the operator the wrong recovery."""
    _, _, c = make(_tmp(), token=TOKEN)
    assert c.post("/api/qr", json={"action": "start"}).status_code == 401


# ---------------------------------------------------------------- DICOMweb
def test_dicomweb_is_not_swallowed_by_the_catch_all():
    _, app, c = make(_tmp(), dicomweb__enabled=True)
    # the router must pick the blueprint, not static_files
    adapter = app.url_map.bind("localhost")
    endpoint, _ = adapter.match("/dicom-web/studies", method="GET")
    assert endpoint == "dicomweb.qido_studies", endpoint
    r = c.get("/dicom-web/studies", headers=JSON)
    assert r.status_code in (200, 204)
    assert b"<!DOCTYPE" not in r.data and b"<html" not in r.data.lower()


def test_dicomweb_deep_paths_are_not_swallowed_either():
    _, app, c = make(_tmp(), dicomweb__enabled=True)
    adapter = app.url_map.bind("localhost")
    for url in ("/dicom-web/studies/1.2.3/series/4.5.6/instances",
                "/dicom-web/studies/1.2.3/metadata",
                "/dicom-web/studies/1.2.3/series/4.5/instances/6.7/frames/1"):
        endpoint, _ = adapter.match(url, method="GET")
        assert endpoint.startswith("dicomweb."), (url, endpoint)
    assert adapter.match("/dicom-web/studies", method="POST")[0].startswith("dicomweb.")


def test_the_catch_all_would_otherwise_swallow_unmatched_api_paths():
    """Proof the reserved-prefix guard is load-bearing, not decorative: an
    unmatched path under a reserved prefix really does route to static_files,
    so without the guard a modality would get the dashboard's 404 page."""
    _, app, _ = make(_tmp(), dicomweb__enabled=True)
    adapter = app.url_map.bind("localhost")
    for url in ("/dicom-web", "/dicom-web/wado", "/api/does-not-exist"):
        endpoint, _ = adapter.match(url, method="GET")
        assert endpoint == "static_files", (url, endpoint)


def test_reserved_prefixes_never_fall_through_to_the_static_tree():
    _, _, c = make(_tmp())
    for url in ("/dicom-web", "/dicom-web/nope/at/all", "/api/does-not-exist"):
        r = c.get(url)
        assert r.status_code == 404, (url, r.status_code)
        assert r.is_json, (url, r.content_type)
        assert r.get_json()["message"] == "no such endpoint", url


def test_dicomweb_disabled_answers_503_not_404():
    _, _, c = make(_tmp())          # dicomweb.enabled defaults False
    r = c.get("/dicom-web/studies", headers=JSON)
    assert r.status_code == 503, (r.status_code, r.data[:200])


def test_dicomweb_enable_needs_no_restart():
    srv, _, c = make(_tmp())
    assert c.get("/dicom-web/studies", headers=JSON).status_code == 503
    srv.cfg.data["dicomweb"]["enabled"] = True
    assert c.get("/dicom-web/studies", headers=JSON).status_code in (200, 204)


def test_stow_is_exempt_from_x_carino_but_not_from_auth():
    srv, _, c = make(_tmp(), dicomweb__enabled=True)
    # no X-Carino header, and it must NOT be a 403 — a modality cannot send one
    r = c.post("/dicom-web/studies", data=b"x", content_type="text/plain")
    assert r.status_code != 403, r.data[:200]
    assert r.status_code in (400, 415), (r.status_code, r.data[:200])
    # with a token configured it is still gated
    srv.cfg.web["auth_token"] = TOKEN
    assert c.post("/dicom-web/studies", data=b"x", content_type="text/plain").status_code == 401


def test_dicomweb_stats_are_published_on_the_server():
    srv, _, _ = make(_tmp())
    assert hasattr(srv, "dicomweb")
    snap = srv.dicomweb.snapshot()
    for key in ("queries", "retrieved", "stored", "failed", "errors"):
        assert key in snap, key


# ---------------------------------------------------------------- editor CORS
def _editor(tmpdir, token=""):
    return make(tmpdir, token=token, web__editor_url="https://dicom.example.org/e/")


def test_editor_cors_is_an_exact_origin_and_never_credentialed():
    _, _, c = _editor(_tmp())
    r = c.get("/api/studies/files?path=x")
    assert r.headers["Access-Control-Allow-Origin"] == "https://dicom.example.org"
    assert "Access-Control-Allow-Credentials" not in r.headers
    p = c.options("/api/studies/files")
    assert p.headers["Access-Control-Allow-Origin"] == "https://dicom.example.org"
    assert "Access-Control-Allow-Credentials" not in p.headers


def test_bundled_editor_emits_no_cors_at_all():
    _, _, c = make(_tmp())          # web.editor_url defaults to "/editor/"
    r = c.get("/api/studies/files?path=x")
    assert "Access-Control-Allow-Origin" not in r.headers


def test_auth_failure_on_the_editor_routes_is_readable_cross_origin():
    _, _, c = _editor(_tmp(), token=TOKEN)
    for url in ("/api/studies/files?path=x", "/api/studies/file?path=x&name=y"):
        r = c.get(url)
        assert r.status_code == 401, url
        assert r.headers["Access-Control-Allow-Origin"] == "https://dicom.example.org", url
        assert "Access-Control-Allow-Credentials" not in r.headers, url


def test_auth_failure_elsewhere_stays_opaque():
    _, _, c = _editor(_tmp(), token=TOKEN)
    r = c.get("/api/status")
    assert r.status_code == 401
    assert "Access-Control-Allow-Origin" not in r.headers


# ---------------------------------------------------------------- routing
def test_get_routing_lists_rules_destinations_and_fields():
    srv, _, c = make(_tmp())
    srv.cfg.data["destinations"] = [
        {"name": "Archive", "enabled": True, "host": "h", "port": 104, "aet": "A"},
        {"name": "Off", "enabled": False, "host": "h", "port": 104, "aet": "B"},
    ]
    srv.cfg.data["routing"] = {"enabled": True,
                               "rules": [{"name": "CT", "match": {"modality": "CT"},
                                          "destinations": ["Archive"]}]}
    r = c.get("/api/routing")
    assert r.status_code == 200
    b = r.get_json()
    assert b["enabled"] is True
    assert b["destinations"] == ["Archive"]          # disabled node is not offerable
    assert b["rules"][0]["name"] == "CT"
    assert set(b["fields"]) == {"modality", "calling_aet", "station",
                                "patient_id", "study_desc"}


def test_routing_test_with_described_attributes():
    srv, _, c = make(_tmp())
    srv.cfg.data["destinations"] = [
        {"name": "Archive", "enabled": True, "host": "h", "port": 104, "aet": "A"},
        {"name": "Research", "enabled": True, "host": "h", "port": 104, "aet": "B"},
    ]
    srv.cfg.data["routing"] = {"enabled": True, "rules": [
        {"name": "CT to research", "match": {"modality": "CT"},
         "destinations": ["Research"], "deidentify": True},
    ]}
    r = c.post("/api/routing/test", json={"attributes": {"modality": "CT"}},
               headers=WRITE)
    assert r.status_code == 200, r.data
    b = r.get_json()
    assert b["ok"] is True
    assert b["decision"]["destinations"] == ["Research"]
    assert b["decision"]["deidentify"] == ["Research"]
    assert b["decision"]["fallback"] is False
    assert b["rules"][0]["name"] == "CT to research"
    # a non-matching study falls back to everything, and says so
    r = c.post("/api/routing/test", json={"modality": "MR"}, headers=WRITE)
    b = r.get_json()
    assert b["decision"]["fallback"] is True
    assert b["decision"]["destinations"] == ["Archive", "Research"]


def test_routing_test_never_logs():
    srv, _, c = make(_tmp())
    srv.cfg.data["routing"] = {"enabled": True, "rules": [
        {"name": "bad", "match": {"modality": "CT"}, "destinations": ["Ghost"]}]}
    before = len(srv.log.lines)
    for _ in range(30):
        c.post("/api/routing/test", json={"modality": "CT"}, headers=WRITE)
    assert len(srv.log.lines) == before


def test_routing_test_against_a_stored_study_delegates_to_the_server():
    srv, _, c = make(_tmp())
    r = c.post("/api/routing/test", json={"group": "received", "path": "/s/1"},
               headers=WRITE)
    assert r.status_code == 200
    assert ("explain_route", "received", "/s/1") in srv.calls
    r = c.post("/api/routing/test", json={"group": "bogus", "path": "/s/1"},
               headers=WRITE)
    assert r.status_code == 400


def test_routing_test_needs_something_to_evaluate():
    _, _, c = make(_tmp())
    r = c.post("/api/routing/test", json={}, headers=WRITE)
    assert r.status_code == 400
    assert "attributes" in r.get_json()["message"]
    r = c.post("/api/routing/test", json={"attributes": "CT"}, headers=WRITE)
    assert r.status_code == 400


# ---------------------------------------------------------------- index
def test_get_index_reports_config_and_stats():
    srv, _, c = make(_tmp())
    r = c.get("/api/index")
    assert r.status_code == 200
    b = r.get_json()["index"]
    assert b["enabled"] is True and b["scanning"] is False
    assert b["path"].endswith("index.db") and os.path.isabs(b["path"])
    assert b["studies"] == 0 and b["instances"] == 0


def test_get_index_survives_no_index():
    srv, _, c = make(_tmp())
    srv.index = None
    b = c.get("/api/index").get_json()["index"]
    assert b["enabled"] is False


def test_index_rescan_is_a_guarded_write():
    srv, _, c = make(_tmp())
    assert c.post("/api/index/rescan", json={}).status_code == 403
    r = c.post("/api/index/rescan", json={}, headers=WRITE)
    assert r.status_code == 200
    assert r.get_json()["ok"] is True
    assert "rescan_index" in srv.calls


def test_index_rescan_refusal_is_a_400_not_a_500():
    srv, _, c = make(_tmp())
    srv.index = None
    r = c.post("/api/index/rescan", json={}, headers=WRITE)
    assert r.status_code == 400
    assert r.get_json()["ok"] is False


# ---------------------------------------------------------------- qr
def test_qr_start_stop_mirrors_printer():
    srv, _, c = make(_tmp())
    r = c.post("/api/qr", json={"action": "start"}, headers=WRITE)
    assert r.status_code == 200 and r.get_json()["qr"]["running"] is True
    r = c.post("/api/qr", json={"action": "stop"}, headers=WRITE)
    assert r.status_code == 200 and r.get_json()["qr"]["running"] is False
    r = c.post("/api/qr", json={"action": "wobble"}, headers=WRITE)
    assert r.status_code == 400 and "start|stop" in r.get_json()["error"]


def test_qr_surfaces_the_index_disabled_valueerror_not_a_500():
    srv, _, c = make(_tmp())
    srv.qr_error = ValueError("Query/Retrieve needs the instance index")
    r = c.post("/api/qr", json={"action": "start"}, headers=WRITE)
    assert r.status_code == 400
    assert "instance index" in r.get_json()["error"]
    srv.qr_error = OSError("address already in use")
    r = c.post("/api/qr", json={"action": "start"}, headers=WRITE)
    assert r.status_code == 400
    assert "already in use" in r.get_json()["error"]


# ---------------------------------------------------------------- deid site key
# The second secret in this config file, and it went out in the clear from the
# same endpoint the token used to. Holding it turns an exported "ANON-…" set
# back into a lookup table: re-derive the HMAC and a guessed Patient ID is
# confirmed, a study is re-linked across exports, the shifted dates come back.
SITE_KEY = "site-key-for-tests-0123456789"


def test_get_config_redacts_the_deid_site_key():
    """GET /api/config handed deid.secret to anything holding a session cookie,
    verbatim, while carefully hiding web.auth_token two keys above it."""
    srv, _, c = make(_tmp(), token=TOKEN)
    srv.cfg.deid["secret"] = SITE_KEY
    _login(c)
    r = c.get("/api/config")
    assert r.status_code == 200
    assert SITE_KEY.encode() not in r.data
    deid = r.get_json()["deid"]
    assert "secret" not in deid
    assert deid["secret_set"] is True
    # a redacted copy, never a mutation of the live config
    assert srv.cfg.deid["secret"] == SITE_KEY


def test_get_config_says_when_no_site_key_is_set():
    _, _, c = make(_tmp())
    assert c.get("/api/config").get_json()["deid"]["secret_set"] is False


def test_a_save_cannot_blank_the_site_key():
    """deid.secret is not in DEFAULTS, so a Save posting back a redacted GET
    merges over a config that has no key in it — and the key is gone. Every
    export after that carries different pseudonyms and different date shifts
    than the ones before it, and nothing says why."""
    srv, _, c = make(_tmp(), token=TOKEN)
    srv.cfg.deid["secret"] = SITE_KEY
    _login(c)
    body = c.get("/api/config").get_json()
    r = c.post("/api/config", json=body, headers=WRITE)
    assert r.status_code == 200, r.data
    assert srv.cfg.deid["secret"] == SITE_KEY
    # not even by omitting the whole deid section
    assert c.post("/api/config", json={"scp": {"port": 11112}}, headers=WRITE).status_code == 200
    assert srv.cfg.deid["secret"] == SITE_KEY
    # the response is redacted too, and the mirror is never persisted
    assert SITE_KEY.encode() not in r.data
    import json as _json
    with open(srv.cfg.path, "r", encoding="utf-8") as fh:
        on_disk = _json.load(fh)["deid"]
    assert on_disk["secret"] == SITE_KEY
    assert "secret_set" not in on_disk


def test_a_save_cannot_set_the_site_key_either():
    srv, _, c = make(_tmp(), token=TOKEN)
    srv.cfg.deid["secret"] = SITE_KEY
    _login(c)
    r = c.post("/api/config", json={"deid": {"secret": "planted-by-a-stolen-cookie"}},
               headers=WRITE)
    assert r.status_code == 400
    assert "/api/deid/secret" in r.get_json()["error"]
    assert srv.cfg.deid["secret"] == SITE_KEY
    # falsy shapes are a replacement attempt like any other; "" is a blanking one
    for value in (0, False, [], {}, ""):
        r = c.post("/api/config", json={"deid": {"secret": value}}, headers=WRITE)
        assert r.status_code == 400, (value, r.status_code)
        assert srv.cfg.deid["secret"] == SITE_KEY, value
    # null is "no value", which can only mean keep
    assert c.post("/api/config", json={"deid": {"secret": None}}, headers=WRITE).status_code == 200
    assert srv.cfg.deid["secret"] == SITE_KEY
    # ...and a caller that already holds the key may echo it back unchanged
    body = c.get("/api/config").get_json()
    body["deid"]["secret"] = SITE_KEY
    assert c.post("/api/config", json=body, headers=WRITE).status_code == 200
    assert srv.cfg.deid["secret"] == SITE_KEY


def test_the_site_key_endpoint_needs_the_token_not_a_cookie():
    srv, _, c = make(_tmp(), token=TOKEN)
    srv.cfg.deid["secret"] = SITE_KEY
    _login(c)
    r = c.post("/api/deid/secret", json={"action": "set", "secret": "a-new-site-key-value"},
               headers=WRITE)
    assert r.status_code == 403
    assert srv.cfg.deid["secret"] == SITE_KEY
    h = {**WRITE, "X-Carino-Token": TOKEN}
    # too short is refused: this key is attacked offline, not guessed on the wire
    r = c.post("/api/deid/secret", json={"action": "set", "secret": "short"}, headers=h)
    assert r.status_code == 400 and srv.cfg.deid["secret"] == SITE_KEY
    r = c.post("/api/deid/secret", json={"action": "wobble"}, headers=h)
    assert r.status_code == 400 and "set|clear" in r.get_json()["error"]
    # the real thing lands, on disk, and is not echoed back
    r = c.post("/api/deid/secret", json={"action": "set", "secret": "a-new-site-key-value"},
               headers=h)
    assert r.status_code == 200, r.data
    assert r.get_json()["secret_set"] is True
    assert b"a-new-site-key-value" not in r.data
    assert srv.cfg.deid["secret"] == "a-new-site-key-value"
    import json as _json
    with open(srv.cfg.path, "r", encoding="utf-8") as fh:
        assert _json.load(fh)["deid"]["secret"] == "a-new-site-key-value"
    # ...and clearing leaves no empty key behind
    assert c.post("/api/deid/secret", json={"action": "clear"}, headers=h).status_code == 200
    assert "secret" not in srv.cfg.deid
    assert c.get("/api/config", headers={"X-Carino-Token": TOKEN}).get_json()["deid"]["secret_set"] is False
    # nothing about any of that reached the log
    assert not [ln for ln in srv.log.lines if SITE_KEY in ln[1] or "a-new-site-key" in ln[1]]


def test_a_non_string_site_key_is_refused_by_validation():
    """It is fed straight into HMAC; a JSON number raises inside the sender
    halfway through a forward instead of being refused at the door."""
    import copy as _copy

    from pacs.config import DEFAULTS, validate

    for bad in (0, True, [], {}):
        candidate = _copy.deepcopy(DEFAULTS)
        candidate["deid"]["secret"] = bad
        try:
            validate(candidate)
        except ValueError as exc:
            assert "deid.secret" in str(exc), exc
        else:
            raise AssertionError(f"validate accepted deid.secret={bad!r}")


# ---------------------------------------------------------------- config file writes
def test_the_config_temp_file_is_never_written_through_a_symlink():
    """Config.save() writes config.json.tmp — a perfectly predictable name. A
    symlink planted there was FOLLOWED: the target was truncated to the config
    JSON and left at 0600. Reachable whenever another local account can write
    the config directory."""
    if os.name != "posix":
        return
    d = _tmp()
    victim = os.path.join(d, "victim.txt")
    with open(victim, "w", encoding="utf-8") as fh:
        fh.write("someone else's file")
    os.chmod(victim, 0o644)
    cfg = Config(os.path.join(d, "config.json"))
    os.symlink(victim, cfg.path + ".tmp")
    cfg.save()
    with open(victim, "r", encoding="utf-8") as fh:
        assert fh.read() == "someone else's file", "save() wrote through the planted symlink"
    assert os.stat(victim).st_mode & 0o777 == 0o644, oct(os.stat(victim).st_mode & 0o777)
    # and the config itself still landed, at 0600
    assert os.path.isfile(cfg.path)
    assert os.stat(cfg.path).st_mode & 0o777 == 0o600
    assert not os.path.exists(cfg.path + ".tmp")


def test_a_stale_temp_file_does_not_wedge_a_save():
    """O_EXCL refuses a file it did not create, so the leftover of a crashed
    save has to be cleared out of the way — otherwise the dashboard could never
    write its config again."""
    d = _tmp()
    cfg = Config(os.path.join(d, "config.json"))
    with open(cfg.path + ".tmp", "w", encoding="utf-8") as fh:
        fh.write("half a config from a crash")
    cfg.save()
    import json as _json
    with open(cfg.path, "r", encoding="utf-8") as fh:
        assert _json.load(fh)["web"]["port"] == 8042


# ---------------------------------------------------------------- destination errors
def test_a_duplicate_destination_error_names_the_rows_not_just_the_name():
    """The exact-duplicate case printed "destinations 'PACS' and 'PACS' have the
    same name", which tells an operator with four destinations nothing about
    which two to fix. Position and address are unique even when the name is
    not."""
    srv, _, c = make(_tmp())
    base = c.get("/api/config").get_json()
    node = {"port": 104, "aet": "ARCHIVE", "enabled": True}
    body = dict(base, destinations=[
        dict(node, name="Teaching", host="10.0.0.7"),
        dict(node, name="PACS", host="10.0.0.1"),
        dict(node, name="Ward", host="10.0.0.8"),
        dict(node, name="PACS", host="10.0.0.2", port=11112),
    ])
    r = c.post("/api/config", json=body, headers=WRITE)
    assert r.status_code == 400
    err = r.get_json()["error"]
    assert "same name" in err
    assert "#2" in err and "#4" in err, err
    assert "10.0.0.1:104" in err and "10.0.0.2:11112" in err, err


# ---------------------------------------------------------------- emergency health
class _FakeWatcher:
    running = True


class _EmergencyServer:
    """The PacsServer surface EmergencyController touches."""

    def __init__(self, cfg, dead):
        self.cfg = cfg
        self.dead = dead           # host that never answers a C-ECHO
        self.watcher = _FakeWatcher()
        self.probes = []

    def _probe(self, dest):
        self.probes.append(dest.get("host"))
        if dest.get("host") == self.dead:
            return False, "connection refused"
        return True, ""

    def stuck_sends(self):
        return {"destinations": []}

    def start_mwl(self):
        pass

    def stop_mwl(self):
        pass

    def start_watcher(self):
        pass

    def retry_stuck(self):
        return {"reset": 0}


def test_two_nodes_sharing_a_name_each_get_their_own_health():
    """Health was keyed by destination NAME, so two rows sharing one shared a
    single record and the last probe of the pass won: the healthy twin cleared
    the dead twin's failure count and wiped offline_since on every tick, the
    outage never accumulated past the threshold, and the failover never fired.
    validate() refuses duplicate names, but config.json is a text file — and a
    hand-edited one is exactly what the send path was hardened for."""
    from pacs import emergency as em

    srv = FakeServer(_tmp())
    cfg = srv.cfg
    cfg.data["destinations"] = [
        {"name": "Primary", "host": "10.0.0.1", "port": 104, "aet": "PACS",
         "enabled": True, "emergency_trigger": True},
        {"name": "Primary", "host": "10.0.0.2", "port": 104, "aet": "PACS",
         "enabled": True, "emergency_trigger": True},
    ]
    cfg.data["emergency"].update({"armed": True, "offline_threshold_sec": 60,
                                  "recovery_successes": 2, "auto_activate": False})
    ctl = em.EmergencyController(_EmergencyServer(cfg, dead="10.0.0.1"), srv.log)
    clock = [1000.0]
    ctl._now = lambda: clock[0]
    ctl.state = em.IDLE
    for _ in range(4):             # 4 probes, 30s apart: past a 60s threshold
        ctl._tick()
        clock[0] += 30
    assert ctl.state == em.TRIGGERED, (ctl.state, ctl.status())
    assert ctl.trigger_dest == "Primary"
    rows = {r["address"]: r for r in ctl.status()["destinations"]}
    assert rows["10.0.0.1:104"]["online"] is False, rows
    assert rows["10.0.0.2:104"]["online"] is True, rows
    assert "10.0.0.1:104" in "".join(ln[1] for ln in srv.log.lines if ln[0] == "warn")


def test_one_node_per_name_still_recovers_normally():
    """The ordinary config must not change shape: one row, one record, offline
    then back online after recovery_successes good probes."""
    from pacs import emergency as em

    srv = FakeServer(_tmp())
    cfg = srv.cfg
    cfg.data["destinations"] = [
        {"name": "Primary", "host": "10.0.0.1", "port": 104, "aet": "PACS",
         "enabled": True, "emergency_trigger": True},
    ]
    cfg.data["emergency"].update({"armed": True, "offline_threshold_sec": 0,
                                  "recovery_successes": 2})
    server = _EmergencyServer(cfg, dead="10.0.0.1")
    ctl = em.EmergencyController(server, srv.log)
    ctl.state = em.IDLE
    ctl._tick()
    assert ctl.state == em.TRIGGERED
    server.dead = ""               # the node comes back
    ctl._tick()
    assert ctl.state == em.TRIGGERED, "one good probe is not recovery"
    ctl._tick()
    assert ctl.state == em.IDLE
    assert ctl.status()["destinations"][0]["online"] is True


# ---------------------------------------------------------------- apply_config
# These drive the REAL PacsServer, not the stub above: the subject is what
# apply_config() does to live services and to the config file, which is exactly
# what a stub cannot have. They bind loopback ports and freeze a directory, so
# each one cleans up after itself in a finally.


def _free_port() -> int:
    import socket
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def _pacs(printer: bool = False):
    """A real PacsServer whose config sits in a directory of its own, so that
    directory can be made read-only without freezing the logs, the storage tree
    or the order store with it. The index is off: Q/R is not what these are
    about, and a sqlite file in the directory we are about to freeze would only
    add noise."""
    from pacs.server import PacsServer

    tmp = _tmp()
    cfgdir, data = os.path.join(tmp, "cfg"), os.path.join(tmp, "data")
    os.makedirs(cfgdir)
    os.makedirs(data)
    cfg = Config(os.path.join(cfgdir, "config.json"))
    cfg.data["logs_dir"] = os.path.join(data, "logs")
    cfg.data["index"]["enabled"] = False
    cfg.data["scp"].update({"enabled": True, "bind": "127.0.0.1", "port": _free_port(),
                            "storage_dir": os.path.join(data, "received")})
    cfg.data["scu"].update({"enabled": False, "watch_dir": os.path.join(data, "outgoing"),
                            "sent_dir": os.path.join(data, "sent"),
                            "pending_dir": os.path.join(data, "pending")})
    cfg.data["ris"]["store_dir"] = os.path.join(data, "orders")
    cfg.data["print"].update({"enabled": printer, "bind": "127.0.0.1", "port": _free_port()})
    cfg.save()
    return PacsServer(cfg)


def _errors(srv) -> str:
    return "\n".join(e["message"] for e in srv.log.tail(200) if e["level"] == "error")


def test_a_save_that_cannot_be_written_leaves_the_pacs_on_the_air():
    """apply_config stopped the receiver, the printer, the RIS, the worklist and
    Q/R and only THEN persisted. A config directory that cannot be written — the
    read-only bind mount in this repo's own docker-compose.yml, a full disk,
    ownership changed under a container restart — therefore took the entire PACS
    off the air on a save that never landed, with nothing left running to bring
    it back and the new config sitting in memory over the old file. Modalities
    send into a closed port after that, and an image that silently never arrives
    is the one failure this project is written against.

    Exit (a) of the apply invariant: raise having disturbed nothing."""
    import copy as _copy
    import json

    srv = _pacs()
    cfgdir = os.path.dirname(srv.cfg.path)
    try:
        srv.start_receiver()
        assert srv.scp and srv.scp.running, "receiver never came up"
        with open(srv.cfg.path, encoding="utf-8") as fh:
            before = json.load(fh)
        new = _copy.deepcopy(srv.cfg.data)
        new["scp"]["aet"] = "REBRANDED"
        os.chmod(cfgdir, 0o500)          # a read-only mount, the cheap way
        try:
            srv.apply_config(new)
        except OSError:
            pass                         # PermissionError: the save legitimately failed
        else:
            raise AssertionError("an unwritable config directory reported a save")
        assert srv.scp is not None and srv.scp.running, \
            "a save that could not be written took the receiver off the air"
        assert srv.cfg.scp["aet"] == before["scp"]["aet"], \
            "config half-applied: memory moved on, the file and the services did not"
        os.chmod(cfgdir, 0o700)
        with open(srv.cfg.path, encoding="utf-8") as fh:
            assert json.load(fh) == before, "the file changed after all"
    finally:
        os.chmod(cfgdir, 0o700)
        srv.stop_receiver()


def test_a_service_that_will_not_stop_does_not_strand_the_others():
    """The bounce is five stops and four starts and any of them can throw — a
    shutdown() that raises, an association thread that will not join. Raising out
    of the middle left the save persisted and every service from the failure
    onwards stopped: the same outage by another door. Each step stands alone
    now, and the restart runs whatever happened."""
    import copy as _copy

    srv = _pacs()
    try:
        srv.start_receiver()

        def wont_stop():
            raise RuntimeError("shutdown() hung on an association")

        srv.stop_printer = wont_stop          # the second stop in the bounce
        new = _copy.deepcopy(srv.cfg.data)
        new["scp"]["aet"] = "REBRANDED"
        srv.apply_config(new)
        assert srv.scp and srv.scp.running, "the receiver never came back"
        assert srv.cfg.scp["aet"] == "REBRANDED", "the save did not apply"
        assert "print receiver" in _errors(srv), \
            "the failed stop was swallowed instead of logged"
    finally:
        srv.stop_receiver()


def test_a_receiver_that_cannot_rebind_does_not_take_the_rest_down():
    """A persist failure is not the only way an apply can go wrong mid-flight:
    would_accept() proves the candidate is well-formed, not that the operator's
    new port is free. Something else owning it must cost the receiver only —
    the save is already on disk and stays applied, the print receiver that had
    nothing to do with it stays up, and the failure is in the log where the
    dashboard's enabled-but-not-running row sends the operator to read it.

    Exit (b): the config applied, every service given its start."""
    import copy as _copy
    import socket

    srv = _pacs(printer=True)
    squatter = socket.socket()
    squatter.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    squatter.bind(("127.0.0.1", 0))
    squatter.listen(1)
    try:
        srv.start_receiver()
        srv.start_printer()
        assert srv.print_scp and srv.print_scp.running
        new = _copy.deepcopy(srv.cfg.data)
        new["scp"]["port"] = squatter.getsockname()[1]
        srv.apply_config(new)
        assert not (srv.scp and srv.scp.running), "bound a port somebody else holds"
        assert srv.print_scp and srv.print_scp.running, \
            "the print receiver was stopped for the receiver's port conflict"
        assert srv.cfg.scp["port"] == squatter.getsockname()[1]
        assert "start receiver" in _errors(srv), "the bind failure was never logged"
    finally:
        squatter.close()
        srv.stop_receiver()
        srv.stop_printer()


# ------------------------------------------------------- orphaned-route rows
def _orphan(srv, name: str, pins: int, loose: int) -> dict:
    """Put `pins` pinned and `loose` unpinned files in the outgoing folder, each
    routed to `name` and none of them sent, then read the row back."""
    out = srv.cfg.resolved("scu", "watch_dir")
    os.makedirs(out, exist_ok=True)
    for i in range(pins + loose):
        p = os.path.join(out, f"f{i}.dcm")
        with open(p, "wb") as fh:
            fh.write(b"x")
        entry = {"sent": [], "size": 1, "mtime": 0.0, "route": [name]}
        if i < pins:
            entry["pin"] = [name]
        srv.watcher.state.put(p, entry)
    return srv.stuck_sends()["orphaned"][0]


def test_an_unpinned_orphan_is_not_promised_the_pinned_one_s_protection():
    """The row said the listed files "will not be archived or deleted" and told
    the operator to restore the node to drain them. For an unpinned route that
    is false — the next watcher pass re-routes the file, the departed name drops
    out of the route, and on_success files or deletes it having never reached
    that node. Overstating the danger is how a warning gets ignored."""
    srv = _pacs()
    msg = _orphan(srv, "Teaching", pins=0, loose=1)["message"]
    assert "Teaching" in msg
    assert "will not be archived or deleted" not in msg, "the old false promise is back"
    assert "indefinitely" not in msg, "an unpinned orphan is not held indefinitely"
    assert "not pinned" in msg and "re-routes" in msg, msg
    assert "1 is not pinned" in msg, msg


def test_a_pinned_orphan_says_it_is_held_indefinitely():
    """The other half: a pin IS a promise nothing clears by itself, so that file
    really does sit there until an operator acts. Same panel, different remedy,
    so the message has to be different too."""
    srv = _pacs()
    msg = _orphan(srv, "Primary", pins=1, loose=0)["message"]
    assert "hold-and-forward" in msg and "indefinitely" in msg, msg
    assert "not pinned" not in msg, "no unpinned file here to warn about"
    assert "next Auto-send pass" not in msg, msg


def test_a_mixed_orphan_row_counts_both_kinds():
    """One departed node can owe both, and the two halves have different
    deadlines: the operator has to be told how many are actually being held."""
    srv = _pacs()
    row = _orphan(srv, "Primary", pins=2, loose=3)
    assert row["instances"] == 5 and row["pinned"] is True and row["pinned_files"] == 2
    assert "2 are pinned" in row["message"], row["message"]
    assert "3 are not pinned" in row["message"], row["message"]


# ---------------------------------------------------------------- shutdown
def test_sigterm_unwinds_instead_of_killing():
    """`docker stop` and `systemctl stop` send SIGTERM. With no disposition it
    is the kernel's default — the process dies where it stands, so
    PacsServer.shutdown() never runs and the DICOM listeners are never closed.
    Measured before the fix: 0.02s to death, nothing in the log. Only Ctrl+C
    stopped this engine cleanly.

    Lives here rather than in a suite of its own because `serve` is the command
    both this file and that signal are about."""
    import signal as _signal

    from pacs.__main__ import _install_sigterm

    previous = _signal.getsignal(_signal.SIGTERM)
    try:
        _install_sigterm()
        handler = _signal.getsignal(_signal.SIGTERM)
        assert handler not in (_signal.SIG_DFL, _signal.SIG_IGN, previous)
        # the same exception Werkzeug already unwinds on, so app.run() returns
        # and cmd_serve's `finally: server.shutdown()` runs
        try:
            handler(_signal.SIGTERM, None)
        except KeyboardInterrupt:
            pass
        else:
            raise AssertionError("SIGTERM handler did not raise KeyboardInterrupt")
    finally:
        _signal.signal(_signal.SIGTERM, previous)


# ---------------------------------------------------------------- CLI
# The command line is the other front door onto the same config, and these two
# live beside the SIGTERM test above for the same reason: `serve` is the command
# this file is about, and every subcommand builds a Config as its first act.
def _run_cli(argv):
    """main(argv) with the streams captured; returns (exit code, stderr, stdout).

    SIGTERM is saved and restored because main() installs a handler of its own —
    a test must not leave the runner's disposition changed under it."""
    import signal as _signal

    from pacs.__main__ import main

    previous = _signal.getsignal(_signal.SIGTERM)
    err, out = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            code = main(argv)
    finally:
        _signal.signal(_signal.SIGTERM, previous)
    return code, err.getvalue(), out.getvalue()


def test_a_config_that_will_not_load_is_a_message_not_a_traceback():
    """ConfigError's message names the file, what is wrong with it and how to
    get back — and it was arriving as the LAST LINE of a six-frame stack trace,
    where nobody reads it. Operators saw a crash and went looking for a bug in
    the PACS instead of a comma in their config. Every subcommand, because every
    one of them builds a Config before it does anything else."""
    d = _tmp()
    path = os.path.join(d, "config.json")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write('{"scp": {"port": 111')          # a save killed halfway
    for cmd in (["serve"], ["receive"], ["send"], ["print"], ["ris"], ["mwl"],
                ["qr"], ["init"], ["echo", "--name", "Archive"]):
        code, err, _ = _run_cli(["-c", path] + cmd)
        assert code != 0, f"{cmd}: a config that will not load exited 0"
        assert "Traceback" not in err, f"{cmd}: still a traceback:\n{err}"
        assert "ConfigError" not in err, f"{cmd}: the exception class leaked:\n{err}"
        assert err.strip().count("\n") == 0, f"{cmd}: more than the message:\n{err}"
        assert path in err and "init" in err, f"{cmd}: {err}"


def test_an_unexpected_exception_still_gets_its_traceback():
    """The other half, and the half that must not regress: a bug in this app is
    not an operator error, and swallowing it would leave a failure with nothing
    to debug from. Only ConfigError is caught."""
    import pacs.__main__ as cli

    def boom(args):
        raise RuntimeError("a genuine bug, not a bad config")

    original = cli.cmd_echo                       # build_parser() resolves this
    cli.cmd_echo = boom                           # global inside main()
    try:
        _run_cli(["-c", os.path.join(_tmp(), "config.json"), "echo", "--name", "x"])
    except RuntimeError:
        pass
    else:
        raise AssertionError("an unexpected exception was swallowed")
    finally:
        cli.cmd_echo = original


# ------------------------------------------- the config lock, over real HTTP
# Every read-modify-write on cfg.data has to hold cfg.mutate(), and emergency
# arm/disarm was the last one that did not: it wrote straight into the live
# cfg.data and called save(). A POST /api/config landing between those two
# assigns a freshly merged document, so the write lands on the section dict
# nobody holds any more and the save persists the OTHER one — while the endpoint
# answers 200 and reports the state it believes it just set. The operator arms
# failover, is told it is armed, and finds out otherwise when the primary goes
# down.
#
# These run against a real socket with real concurrency, because a Flask test
# client is one request at a time and this bug needs two requests inside the
# config at once.
def _pacs_server(tmpdir, destinations=40):
    """A real PacsServer on a real config, with nothing that binds a port.

    The destinations are there to make a save a real write rather than one
    syscall — the window this measures is the length of a config replace."""
    from pacs.server import PacsServer
    cfg = Config(os.path.join(tmpdir, "config.json"))
    cfg.data["scp"]["enabled"] = False
    cfg.data["index"]["enabled"] = False
    cfg.data["destinations"] = [
        {"name": f"NODE{i:03d}", "host": f"10.0.0.{i % 250}", "port": 104,
         "aet": f"ARCHIVE{i:03d}", "enabled": True} for i in range(destinations)]
    cfg.save()
    return PacsServer(cfg)


@contextlib.contextmanager
def _live_dashboard(srv):
    """The dashboard on a loopback socket, threaded as `pacs serve` runs it."""
    import threading

    from werkzeug.serving import WSGIRequestHandler, make_server

    class Quiet(WSGIRequestHandler):
        def log(self, *args, **kw):
            pass

    app = create_app(srv)
    http = make_server("127.0.0.1", 0, app, threaded=True, request_handler=Quiet)
    worker = threading.Thread(target=http.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{http.server_port}"
    finally:
        http.shutdown()
        worker.join(10)


def _http(base, method, path, body=None, headers=None):
    """One dashboard call; returns (status, body, ETag). Never raises on a 4xx —
    a refused Save is data here, not an error."""
    import urllib.error
    import urllib.request
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Carino", "1")            # the write guard, on every POST
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}"), resp.headers.get("ETag")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode() or "{}"), exc.headers.get("ETag")


def test_arm_disarm_is_never_lost_to_a_concurrent_dashboard_save():
    """Alternating arm/disarm against a dashboard saving flat out.

    What is asserted is NOT the final state. A Save posts a whole document
    assembled from a page-load snapshot, so one that was built before the arm is
    entitled to revert it (that is what If-Match exists for) and does. The claim
    here is narrower and is exactly what the lock buys: the document each
    arm/disarm ITSELF persists carries the value that call just set. It is
    witnessed at _write_temp, which receives the precise text the save renames
    over config.json — serialised under the lock, after every merge.

    Measured on the unlocked version: 5 to 11 of 40 lost per run, in both
    directions — arms that never reached the file, and disarms that left
    `armed: true` in it with no monitor running behind them. Locked: 0 of 240
    over six runs.
    """
    import sys as _sys
    import threading

    arms, savers, saves_each = 40, 8, 400
    tmp = _tmp()
    srv = _pacs_server(tmp, destinations=150)
    marker = threading.local()
    witnessed: list = []
    real_write = Config._write_temp

    def witness(self, directory, payload):
        # Only the saves performed BY an arm/disarm are of interest; every other
        # save on this box is a dashboard Save and is allowed to say anything.
        if getattr(marker, "on", False):
            witnessed.append(bool(json.loads(payload)["emergency"]["armed"]))
        return real_write(self, directory, payload)

    real_action = srv.emergency_action

    def marked(action):
        marker.on = True
        try:
            return real_action(action)
        finally:
            marker.on = False

    srv.emergency_action = marked
    Config._write_temp = witness
    # The gap between the write and the save is a few bytecodes wide, and a
    # CPython thread that does not block inside it is almost never preempted
    # there at the default 5ms switch interval — the race is real and is simply
    # not reachable in a test that lasts seconds. Shrinking the interval is what
    # makes it reproducible; it changes scheduling, not semantics.
    previous_interval = _sys.getswitchinterval()
    _sys.setswitchinterval(1e-6)
    stop = threading.Event()
    applied = [0]
    counted = threading.Lock()

    def saver():
        n = 0
        while not stop.is_set() and n < saves_each:
            _, document, _etag = _http(base, "GET", "/api/config")
            document["scu"]["poll_interval"] = 3 + (n % 5)
            code, _, _ = _http(base, "POST", "/api/config", document)
            if code == 200:
                with counted:
                    applied[0] += 1
            n += 1

    try:
        with _live_dashboard(srv) as base:
            threads = [threading.Thread(target=saver) for _ in range(savers)]
            for t in threads:
                t.start()
            time.sleep(0.05)                      # let the savers get going
            intents = []
            try:
                for i in range(arms):
                    intent = (i % 2 == 0)
                    code, body, _ = _http(base, "POST", "/api/emergency",
                                          {"action": "arm" if intent else "disarm"})
                    assert code == 200, (code, body)
                    intents.append(intent)
                    time.sleep(0.01)
            finally:
                stop.set()
                for t in threads:
                    t.join(60)
    finally:
        Config._write_temp = real_write
        _sys.setswitchinterval(previous_interval)
        srv.shutdown()

    assert applied[0] >= 20, f"only {applied[0]} Saves landed — nothing was raced"
    assert len(witnessed) == arms, (len(witnessed), arms)
    lost = [(i, "arm" if want else "disarm") for i, (want, got)
            in enumerate(zip(intents, witnessed)) if want != got]
    assert not lost, (f"{len(lost)} of {arms} arm/disarm calls persisted a document "
                      f"contradicting the action they had just performed: {lost[:8]} "
                      f"(against {applied[0]} concurrent Saves)")


def test_the_setup_chooser_cannot_revert_a_save_that_lands_under_it():
    """apply_setup read cfg.data, edited a copy and only then called
    apply_config: a read-modify-write with the lock held for neither half. A
    dashboard Save landing in that gap was reverted whole — destinations, rules
    and ports back to what they were before it — with a 200 on both requests and
    nothing said anywhere.

    Deterministic: the Save is performed from inside the chooser's own edit, on
    another thread, while the chooser holds (or, on the broken version, does not
    hold) the config lock."""
    import threading

    from pacs import server as server_mod

    tmp = _tmp()
    srv = _pacs_server(tmp, destinations=2)
    started, done = threading.Event(), threading.Event()
    failed: list = []

    def competing_save():
        started.wait(10)
        document = copy.deepcopy(srv.cfg.data)
        document["destinations"].append(
            {"name": "LATE", "host": "10.9.9.9", "port": 104, "aet": "LATE", "enabled": True})
        try:
            srv.apply_config(document)
        except Exception as exc:                  # noqa: BLE001
            failed.append(exc)
        finally:
            done.set()

    worker = threading.Thread(target=competing_save)
    worker.start()
    # The stamp is taken where the chooser builds its document, which is where
    # the snapshot used to be taken too. Releasing the competing Save here puts
    # it exactly in the old gap; it can only get all the way through while we
    # are standing in it if the lock is not being held. Half a second, not a
    # join: on the fixed version it never finishes here, and must not be waited
    # for from inside the lock it is waiting on.
    real_stamp = server_mod._utc_stamp

    def stamped():
        started.set()
        done.wait(0.5)
        return real_stamp()

    try:
        server_mod._utc_stamp = stamped
        srv.apply_setup({"receiver": False})      # enrols nothing, so nothing binds
    finally:
        server_mod._utc_stamp = real_stamp
        worker.join(30)
        srv.shutdown()

    assert not failed, failed
    names = [d["name"] for d in srv.cfg.destinations]
    # Whichever order the two landed in, the Save that reached disk cannot be
    # rolled back by a document that predates it. (The reverse is not claimed:
    # the Save carries a whole page-load snapshot, so it is entitled to revert
    # the chooser's own flags — that is the stale-document problem If-Match
    # answers, and it is not this one.)
    assert "LATE" in names, ("the setup chooser reverted a Save that had already landed: "
                             f"{names}")
    with open(srv.cfg.path, encoding="utf-8") as fh:
        stored = json.load(fh)
    assert [d["name"] for d in stored["destinations"]] == names, "memory and disk disagree"


def test_a_token_rotation_is_never_reverted_by_a_concurrent_save():
    """Rotations against a continuous stream of dashboard Saves.

    POST /api/config read the stored web.auth_token and deid.secret OUTSIDE any
    lock and re-asserted them into a document it applied some time later. A
    rotation landing in that gap was written straight back out of existence —
    and POST /api/auth/token had already answered 200, told the operator every
    session was invalidated, and shown them a token that was not the one in the
    file. SECURITY.md's promise, "rotating web.auth_token invalidates every
    outstanding session immediately", was simply false under a concurrent Save.
    Measured on that version: 25 of 40 rotations reverted. An operator who
    rotates because they believe the token is compromised, is told it worked,
    and is still running the old one is worse off than one who got an error.

    Three things are asserted per rotation, and the third is the one an operator
    would feel: the minted token is what is in memory, it is what is on disk,
    and the PREVIOUS token no longer opens the API. Then, once the noise stops,
    the other half of the fix: a Save built before a rotation is REFUSED rather
    than applied — which needs cfg.version() to be able to SEE the rotation, and
    it could not while the two secrets were folded into it as booleans.
    """
    import threading

    rotations, savers, saves_each = 40, 8, 400
    tmp = _tmp()
    srv = _pacs_server(tmp, destinations=150)
    with srv.cfg.mutate():
        srv.cfg.web["auth_token"] = TOKEN
        srv.cfg.save()

    live = {"token": TOKEN}
    held = threading.Lock()

    def credential():
        with held:
            return {"X-Carino-Token": live["token"]}

    stop = threading.Event()
    applied = [0]
    counted = threading.Lock()

    def saver():
        n = 0
        while not stop.is_set() and n < saves_each:
            code, document, _ = _http(base, "GET", "/api/config", headers=credential())
            if code == 200:
                # A whole-document Save, exactly as the dashboard posts one: the
                # redacted GET body, one field changed, straight back.
                document["scu"]["poll_interval"] = 3 + (n % 5)
                code, _, _ = _http(base, "POST", "/api/config", document,
                                   headers=credential())
                if code == 200:
                    with counted:
                        applied[0] += 1
            n += 1

    reverted: list = []
    still_open: list = []
    try:
        with _live_dashboard(srv) as base:
            threads = [threading.Thread(target=saver) for _ in range(savers)]
            for t in threads:
                t.start()
            time.sleep(0.05)                      # let the savers get going
            try:
                for i in range(rotations):
                    previous = live["token"]
                    code, body, _ = _http(base, "POST", "/api/auth/token",
                                          {"action": "rotate"},
                                          headers={"X-Carino-Token": previous})
                    if code != 200:
                        # The token the PREVIOUS rotation minted and returned no
                        # longer opens the API: a Save put the old one back
                        # after that rotation had answered 200. That is the bug,
                        # recorded rather than raised, so the remaining
                        # rotations still get measured — and then recovered from
                        # the config, which only a test can see.
                        reverted.append((i - 1, f"the minted token was refused with {code}"))
                        with held:
                            live["token"] = srv.cfg.web.get("auth_token", "")
                        continue
                    minted = body["token"]
                    with held:
                        live["token"] = minted
                    # The window the bug lived in: Saves that were already in
                    # flight when the rotation landed get to finish here.
                    time.sleep(0.01)
                    stored = srv.cfg.web.get("auth_token")
                    with open(srv.cfg.path, encoding="utf-8") as fh:
                        on_disk = json.load(fh).get("web", {}).get("auth_token")
                    if stored != minted or on_disk != minted:
                        reverted.append((i, "memory" if stored != minted else "disk"))
                    # Nothing else rotates, so the previous token must now be
                    # dead. This is the claim SECURITY.md makes, over the wire.
                    code, _, _ = _http(base, "GET", "/api/config",
                                       headers={"X-Carino-Token": previous})
                    if code == 200:
                        still_open.append(i)
            finally:
                stop.set()
                for t in threads:
                    t.join(60)

            assert applied[0] >= 20, f"only {applied[0]} Saves landed — nothing was raced"
            # Counted by rotation, not by symptom: one revert shows up twice —
            # once as the stored token not matching, once as the next rotation
            # being turned away with the credential this test was handed.
            assert not reverted, (
                f"{len({i for i, _ in reverted})} of {rotations} rotations were silently "
                f"reverted by a concurrent Save after answering 200: {reverted[:8]} "
                f"(against {applied[0]} Saves)")
            assert not still_open, (
                f"the token replaced by rotations {still_open[:8]} still opened the API — "
                f"the operator was told every session was invalidated and it was not")

            # ---- and the stale Save is refused, not applied -----------------
            # Deterministic, with the savers stopped so nothing else moves the
            # document: take a snapshot, rotate under it, post the snapshot back
            # with the ETag it came with.
            code, document, etag = _http(base, "GET", "/api/config", headers=credential())
            assert code == 200 and etag, (code, etag)
            code, body, _ = _http(base, "POST", "/api/auth/token", {"action": "rotate"},
                                  headers=credential())
            assert code == 200, (code, body)
            with held:
                live["token"] = body["token"]
            document["scu"]["poll_interval"] = 9
            code, body, _ = _http(base, "POST", "/api/config", document,
                                  headers={**credential(), "If-Match": etag})
            assert code == 409, ("a Save built before the rotation was accepted — the "
                                 "config version cannot see a rotation", code, body)
            assert body.get("code") == "stale_config", body
            assert srv.cfg.scu["poll_interval"] != 9, "a refused Save was applied anyway"
            assert srv.cfg.web["auth_token"] == live["token"], "the refused Save moved the token"
    finally:
        srv.shutdown()


# ------------------------------------------------- string fields in the config
# validate() type-checked deid.profile and deid.secret — with a comment saying a
# non-string secret "raises inside the sender halfway through a forward instead
# of being refused here" — and left deid.prefix, one line away and fed to
# .strip() in the same constructor, unchecked. Same shape as the boolean sweep,
# so it is answered the same way: driven off DEFAULTS, not off a list.
def test_a_non_string_deid_prefix_is_refused_at_the_door():
    """POST /api/config with deid.prefix as a JSON number returned 200 and
    persisted it; the next forward that scrubs died inside Deidentifier."""
    from pacs.deid import Deidentifier

    srv, _app, c = make(_tmp())
    document = c.get("/api/config").get_json()
    document["deid"]["prefix"] = 5
    r = c.post("/api/config", json=document, headers=WRITE)
    assert r.status_code == 400, r.data
    assert "deid.prefix" in r.get_json()["error"], r.get_json()
    assert srv.cfg.deid["prefix"] == "ANON", "the bad prefix was persisted anyway"

    # And the reason it is worth a 400 — run for real, not asserted from memory.
    try:
        Deidentifier(profile="basic", prefix=5)
    except AttributeError:
        pass
    else:
        raise AssertionError("Deidentifier accepted a non-string prefix after all")


def test_every_string_field_defaults_declares_is_type_checked():
    """The sweep, as a test rather than as a list in a commit message: every
    field DEFAULTS types as a string is refused when it arrives as something
    else, and the error names it. A field added to DEFAULTS is covered the day
    it lands, and this test is what makes that claim true."""
    from pacs.config import DEFAULTS, validate

    checked = []
    for section, defaults in DEFAULTS.items():
        pairs = ([(section, None)] if isinstance(defaults, str) else
                 [(section, k) for k, v in defaults.items() if isinstance(v, str)]
                 if isinstance(defaults, dict) else [])
        for sec, key in pairs:
            name = sec if key is None else f"{sec}.{key}"
            for bad in (5, True, ["x"], {"a": 1}, None):
                data = copy.deepcopy(DEFAULTS)
                if key is None:
                    data[sec] = bad
                else:
                    data[sec][key] = bad
                try:
                    validate(data)
                except ValueError as exc:
                    assert name in str(exc), f"{name} = {bad!r} refused, but the error "\
                                             f"does not say which field: {exc}"
                else:
                    raise AssertionError(f"validate() accepted {name} = {bad!r}")
            checked.append(name)
    # A floor, not an exact count: the point of the data-driven check is that
    # the number grows on its own. It covered 41 fields the day it was written —
    # 40 through _check_strings and web.auth_token through the security gate.
    assert len(checked) >= 40, (len(checked), checked)
    assert "deid.prefix" in checked and "web.editor_url" in checked, checked
    # A real string is still fine, in every one of them.
    validate(copy.deepcopy(DEFAULTS))


def test_a_hand_edited_config_is_used_but_never_silently():
    """Config.load() does not validate, deliberately: refusing to start is
    refusing the operator the dashboard they would fix the file in, and the
    receiver goes dark with it. The price of that decision is a config nobody
    checked, so it is checked at startup and SAID — not raised."""
    from pacs.config import DEFAULTS
    from pacs.server import PacsServer

    d = _tmp()
    path = os.path.join(d, "config.json")
    document = copy.deepcopy(DEFAULTS)
    document["deid"]["prefix"] = 5                 # would be refused by any Save
    document["index"]["enabled"] = False
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(document, fh)

    cfg = Config(path)                             # must not raise: see load()
    assert cfg.deid["prefix"] == 5
    srv = PacsServer(cfg)
    try:
        assert "deid.prefix" in srv.config_problem, (
            f"the config was used unvalidated and unremarked: {srv.config_problem!r}")
        assert srv.status()["config_problem"] == srv.config_problem
        said = [e["message"] for e in srv.log.tail(50) if e["level"] == "warn"]
        assert any("deid.prefix" in m for m in said), said
        # ...and the note does not outlive the edit that fixes it.
        fixed = copy.deepcopy(cfg.data)
        fixed["deid"]["prefix"] = "ANON"
        srv.apply_config(fixed)
        assert srv.config_problem == ""
        assert srv.status()["config_problem"] == ""
    finally:
        srv.shutdown()


# ------------------------------------------- a config change under a live send
# _SendConfig freezes deid + routing for the whole of a manual send, which is
# right (a send has no next pass to pick the rest of the study back up) and
# which closed the leak in one direction. The other direction stayed open and
# said nothing: a rule that GAINS deidentify:true mid-send kept delivering the
# rest of the study IDENTIFIED to that node, while /api/status reported it as
# scrubbed-for from the instant of the save.
def _free_port() -> int:
    import socket
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def _dicom(path):
    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = generate_uid()
    ds = Dataset()
    ds.file_meta = meta
    ds.preamble = b"\0" * 128
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.PatientName = "Doe^Jane"
    ds.PatientID = "P1"
    ds.Modality = "CT"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        ds.save_as(path, enforce_file_format=True)      # pydicom >= 3
    except TypeError:
        ds.save_as(path, write_like_original=False)     # pydicom 2.x
    return path


@contextlib.contextmanager
def _receiver(tmpdir, aet):
    """A real Storage SCP on loopback. A Decision object can claim anything;
    what is on the receiver's disk cannot."""
    from pacs.scp import StorageSCP
    store = os.path.join(tmpdir, aet)
    os.makedirs(store, exist_ok=True)
    scp = StorageSCP(aet=aet, bind="127.0.0.1", port=_free_port(), storage_dir=store,
                     organize=False, log=FakeLog(), min_free_mb=0)
    scp.start()
    for _ in range(200):
        if scp.running:
            break
        time.sleep(0.02)
    assert scp.running, f"the test SCP {aet} never came up"
    try:
        yield store, scp.port
    finally:
        scp.stop()


def _arrived(store) -> list:
    from pydicom import dcmread
    names = []
    for root, _dirs, files in os.walk(store):
        for f in files:
            names.append(str(dcmread(os.path.join(root, f)).PatientName))
    return sorted(names)


def _join_sends(timeout=30):
    import threading
    for t in list(threading.enumerate()):
        if t.name == "pacs-send":
            t.join(timeout=timeout)


@contextlib.contextmanager
def _after_first_store(hook):
    """The real c_store with a trigger on its first call — the only
    deterministic moment this path offers is "an association just closed"."""
    from pacs import scu
    real = scu.c_store
    calls = []

    def hooked(dst, filepath, calling_aet, timeout=30, tls_context=None):
        res = real(dst, filepath, calling_aet, timeout=timeout, tls_context=tls_context)
        calls.append(dst.name)
        if len(calls) == 1:
            hook()
        return res

    scu.c_store = hooked
    try:
        yield calls
    finally:
        scu.c_store = real


def test_a_rule_that_gains_deidentify_mid_send_stops_delivering_to_that_node():
    """The quiet half of the freeze, against two real receivers.

    Research is routed identified when the send starts. Mid-send the operator
    ticks "de-identify" on the rule that feeds it — /api/status says scrubbed-for
    from that instant — and the frozen send kept shipping the rest of the study
    to it in the clear, with no line in the log, no mark on the summary and
    nothing on the dashboard.

    It now holds Research for the remainder and says so on all three. It does
    NOT stop the send: Archive's promise did not move, and abandoning it would
    strand a half-delivered study at a node nothing will come back to."""
    from pacs.server import PacsServer

    with tempfile.TemporaryDirectory() as tmp:
        with _receiver(tmp, "ARCHIVE") as (archive, aport):
            with _receiver(tmp, "RESEARCH") as (research, rport):
                cfg = Config(os.path.join(tmp, "config.json"))
                cfg.data["scp"]["enabled"] = False
                cfg.data["index"]["enabled"] = False
                cfg.data["deid"]["profile"] = "basic"
                cfg.data["destinations"] = [
                    {"name": "Archive", "host": "127.0.0.1", "port": aport,
                     "aet": "ARCHIVE", "enabled": True},
                    {"name": "Research", "host": "127.0.0.1", "port": rport,
                     "aet": "RESEARCH", "enabled": True}]
                cfg.data["routing"] = {"enabled": True, "rules": [
                    {"name": "archive", "match": {}, "destinations": ["Archive"]},
                    {"name": "research", "match": {}, "destinations": ["Research"]}]}
                study = os.path.join(cfg.resolved("scp", "storage_dir"), "study1")
                for n in ("a", "b", "c"):
                    _dicom(os.path.join(study, f"{n}.dcm"))
                srv = PacsServer(cfg)
                try:
                    def tick_deidentify():
                        document = copy.deepcopy(cfg.data)
                        document["routing"]["rules"][1]["deidentify"] = True
                        srv.apply_config(document)

                    with _after_first_store(tick_deidentify):
                        assert srv.send_study("received", study)["ok"]
                        _join_sends()
                    assert cfg.routing["rules"][1]["deidentify"] is True, \
                        "the mid-send save never landed"

                    # Read off the receivers' own disks. Research keeps whatever
                    # left before the save — that instance was honestly reported
                    # identified at the time — and nothing after it.
                    got = _arrived(research)
                    assert got in ([], ["Doe^Jane"]), (
                        "the rule gained deidentify:true mid-send and the rest of the "
                        f"study still left IDENTIFIED to Research: {got}")
                    # Archive's promise never moved, so the send finished for it.
                    assert _arrived(archive) == ["Doe^Jane"] * 3, _arrived(archive)

                    said = "\n".join(e["message"] for e in srv.log.tail(400)
                                     if e["level"] in ("warn", "error"))
                    assert "Research" in said and "changed" in said, said
                    assert "HELD" in said, said
                    stale = srv.status()["deid"]["superseded_sends"]
                    assert stale and stale[-1]["held"] == ["Research"], stale
                    assert stale[-1]["study"] == "study1", stale

                    # The remedy the message gives, run: press Send again and the
                    # whole study arrives, de-identified, under the new settings.
                    assert srv.send_study("received", study)["ok"]
                    _join_sends()
                    now = _arrived(research)
                    assert len([n for n in now if n != "Doe^Jane"]) == 3, now
                finally:
                    srv.shutdown()


# ---------------------------------------------------------------- runner
if __name__ == "__main__":
    fns = [(n, f) for n, f in sorted(globals().items())
           if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in fns:
        try:
            fn()
            print(f"  ok   {name}")
        except Exception as exc:                      # noqa: BLE001
            failed += 1
            import traceback
            print(f"  FAIL {name}: {exc.__class__.__name__}: {exc}")
            traceback.print_exc()
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
