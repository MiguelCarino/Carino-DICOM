"""Tests for pacs.auth (dashboard API token + session guard) and for the
config.py half of the same contract — the security gate that decides a token is
mandatory, and the type checks that stop a value from meaning one thing to the
gate and another to the guard. The two halves are tested together because that
disagreement is what made them exploitable.

Runs under pytest, or directly:  python3 tests/test_auth.py
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pacs.auth import (
    FAIL_LIMIT,
    PUBLIC_PATHS,
    SESSION_COOKIE,
    AuthGuard,
    RateLimiter,
    SessionSigner,
    generate_token,
    install,
    path_is_protected,
    token_from_headers,
)
from pacs.config import DEFAULTS, Config, auth_token_of, validate

TOKEN = "s3cr3t-token-value_ABCdef-0123456789"


class FakeCfg:
    """Just enough Config surface for AuthGuard: a live .web dict."""

    def __init__(self, token: str = "", host: str = "127.0.0.1"):
        self.data = {"web": {"host": host, "port": 8042, "auth_token": token}}

    @property
    def web(self) -> dict:
        return self.data["web"]


class FakeLog:
    def __init__(self):
        self.lines: list[tuple[str, str, str]] = []

    def info(self, message, **f):
        self.lines.append(("info", message, f.get("kind", "")))

    def warn(self, message, **f):
        self.lines.append(("warn", message, f.get("kind", "")))

    def error(self, message, **f):
        self.lines.append(("error", message, f.get("kind", "")))


def guard(token: str = TOKEN, log=None) -> AuthGuard:
    return AuthGuard(FakeCfg(token), log=log)


def check(g: AuthGuard, path="/api/status", method="GET", headers=None,
          cookies=None, ip="10.0.0.5", now=None):
    return g.check(method=method, path=path, headers=headers or {},
                   cookies=cookies or {}, client_ip=ip, now=now)


# ---- token generation ---------------------------------------------------

def test_generate_token_is_long_url_safe_and_unique():
    a, b = generate_token(), generate_token()
    assert a != b
    assert len(a) >= 40
    assert all(c.isalnum() or c in "-_" for c in a)


# ---- the token coercion: one reader, one answer -------------------------
# The values that used to split the two readers apart: falsy in Python, but not
# the empty string, so str(x) made them look like a token and str(x or "") made
# them look like none.
NOT_A_TOKEN = [0, 0.0, False, None, [], {}, "", "   "]


def test_auth_token_of_accepts_only_a_real_string():
    for value in NOT_A_TOKEN:
        assert auth_token_of({"auth_token": value}) == "", repr(value)
    assert auth_token_of({"auth_token": "  tok  "}) == "tok"
    assert auth_token_of({}) == ""
    assert auth_token_of(None) == ""


def test_the_security_gate_and_the_guard_cannot_disagree():
    """The blocker, closed. config.validate() coerced the token with str(x) and
    AuthGuard with str(x or ""), so a JSON 0 / false / null / [] / {} satisfied
    "a network-reachable host must have a token" while the guard read it as no
    token at all — POST /api/config once, and the dashboard API answered the
    whole LAN unauthenticated."""
    for value in NOT_A_TOKEN:
        data = copy.deepcopy(DEFAULTS)
        data["web"]["host"] = "0.0.0.0"
        data["web"]["auth_token"] = value
        try:
            validate(data)
        except ValueError:
            refused = True
        else:
            refused = False
        assert refused, f"validate() accepted auth_token={value!r} on a 0.0.0.0 host"
        # ...and the guard agrees there is nothing to enforce, which is exactly
        # why the config above must never be storable.
        assert not AuthGuard(FakeCfg(value, host="0.0.0.0")).required, repr(value)


def test_a_real_token_satisfies_both_readers():
    data = copy.deepcopy(DEFAULTS)
    data["web"]["host"] = "0.0.0.0"
    data["web"]["auth_token"] = TOKEN
    validate(data)                                  # no raise
    g = AuthGuard(FakeCfg(TOKEN, host="0.0.0.0"))
    assert g.required and g.token == TOKEN
    assert check(g, headers={"X-Carino-Token": TOKEN}).ok
    assert not check(g).ok


def test_a_non_string_token_is_refused_even_on_loopback():
    """Not normalised away: `"auth_token": 0` reads to an operator as a token
    that is set, and every reader here says it is not. Say which."""
    for value in (0, False, None, [], {}):
        data = copy.deepcopy(DEFAULTS)
        data["web"]["auth_token"] = value
        try:
            validate(data)
        except ValueError as exc:
            assert "auth_token" in str(exc) and "string" in str(exc)
        else:
            raise AssertionError(f"validate() accepted auth_token={value!r}")
    data = copy.deepcopy(DEFAULTS)
    data["web"]["auth_token"] = ""                  # the ordinary loopback case
    validate(data)


def test_a_quoted_false_cannot_switch_a_flag_on():
    """The same confusion one type down, and the reason to hunt the pattern
    rather than the bug: every boolean in this config is read by plain
    truthiness, so the string "false" reads as TRUE. deid.keep_private: "false"
    would keep the private tags — which routinely carry the patient's name — in
    a study the operator believes is de-identified."""
    for section, key in (("deid", "keep_private"), ("dicomweb", "allow_stow"),
                         ("scp", "enabled"), ("scu", "tls_verify"), ("scp", "tls")):
        data = copy.deepcopy(DEFAULTS)
        data[section][key] = "false"
        try:
            validate(data)
        except ValueError as exc:
            assert f"{section}.{key}" in str(exc), str(exc)
        else:
            raise AssertionError(f'validate() accepted {section}.{key} = "false"')
        data[section][key] = True                   # a real boolean is fine
        data["scp"]["tls_cert"] = data["scp"]["tls_key"] = "/tmp/x.pem"
        validate(data)


def test_duplicate_destination_names_are_refused():
    """The name is the join key for the send state, the retry backoff and the
    archive gate. Two destinations sharing one collapse in every by_name dict,
    the study is archived as fully sent once ONE of them has it, and the other
    node silently never gets the images."""
    node = {"host": "h", "port": 104, "aet": "A", "enabled": True}
    for names in (["PACS", "PACS"], ["PACS", "pacs"], ["PACS", " pacs "], ["", "x"], ["   "]):
        data = copy.deepcopy(DEFAULTS)
        data["destinations"] = [dict(node, name=n) for n in names]
        try:
            validate(data)
        except ValueError as exc:
            assert "name" in str(exc), str(exc)
        else:
            raise AssertionError(f"validate() accepted destination names {names!r}")
    data = copy.deepcopy(DEFAULTS)
    data["destinations"] = [dict(node, name="PACS"), dict(node, name="Teaching archive")]
    validate(data)                                  # distinct names are fine


def test_destination_flags_are_booleans_too():
    node = {"name": "PACS", "host": "h", "port": 104, "aet": "A"}
    for flag in ("enabled", "tls", "no_ris", "emergency_trigger"):
        data = copy.deepcopy(DEFAULTS)
        data["destinations"] = [dict(node, **{flag: "false"})]
        try:
            validate(data)
        except ValueError as exc:
            assert flag in str(exc)
        else:
            raise AssertionError(f'validate() accepted destination {flag} = "false"')


# ---- header parsing -----------------------------------------------------

def test_token_from_headers_bearer_and_custom_header():
    assert token_from_headers({"Authorization": f"Bearer {TOKEN}"}) == TOKEN
    assert token_from_headers({"Authorization": f"bearer  {TOKEN}"}) == TOKEN
    assert token_from_headers({"X-Carino-Token": TOKEN}) == TOKEN
    assert token_from_headers({}) == ""
    # A non-Bearer scheme must not be mistaken for the token itself.
    assert token_from_headers({"Authorization": "Basic dXNlcjpwdw=="}) == ""
    assert token_from_headers({"Authorization": TOKEN}) == ""


# ---- path gating --------------------------------------------------------

def test_only_api_and_dicomweb_are_protected():
    for p in ("/api", "/api/status", "/api/studies/file", "/api/shutdown",
              "/dicom-web", "/dicom-web/studies"):
        assert path_is_protected(p), p
    for p in ("/", "/app.js", "/style.css", "/editor/", "/editor/app.js",
              "/apibogus", "/dicom-webhook"):
        assert not path_is_protected(p), p


def test_login_endpoints_are_public_paths():
    for p in ("/api/auth", "/api/login", "/api/logout"):
        assert p in PUBLIC_PATHS
        assert not path_is_protected(p)


def test_extra_prefixes_are_honoured():
    assert not path_is_protected("/wado")
    assert path_is_protected("/wado", ("/wado",))
    assert path_is_protected("/wado/x", ("/wado",))


# ---- the disabled case: loopback, no token ------------------------------

def test_no_token_means_everything_passes():
    g = guard("")
    assert not g.required
    assert check(g).ok
    assert check(g, "/api/shutdown", "POST").ok
    assert g.status() == {"required": False, "authenticated": True}


def test_whitespace_only_token_is_treated_as_unset():
    g = guard("   ")
    assert not g.required
    assert check(g).ok


# ---- header credentials -------------------------------------------------

def test_correct_bearer_token_passes():
    g = guard()
    assert check(g, headers={"Authorization": f"Bearer {TOKEN}"}).ok
    assert check(g, headers={"X-Carino-Token": TOKEN}).ok


def test_missing_credential_is_401_with_the_prompt_shape():
    g = guard()
    v = check(g)
    assert not v.ok and v.status == 401 and v.reason == "missing"
    body = v.body()
    assert body["ok"] is False
    assert body["auth"]["required"] is True
    assert body["auth"]["reason"] == "missing"
    # the token must never travel back to the client in an error
    assert TOKEN not in repr(body)


def test_wrong_token_is_401_invalid_and_never_echoed():
    g = guard()
    v = check(g, headers={"Authorization": "Bearer wrong"})
    assert not v.ok and v.status == 401 and v.reason == "invalid"
    assert TOKEN not in repr(v.body())


def test_prefix_of_the_real_token_is_rejected():
    g = guard()
    assert not check(g, headers={"X-Carino-Token": TOKEN[:-1]}).ok
    assert not check(g, headers={"X-Carino-Token": TOKEN + "x"}).ok


def test_non_ascii_token_fails_cleanly_rather_than_raising():
    g = guard()
    v = check(g, headers={"X-Carino-Token": "tokén\U0001f600"})
    assert not v.ok and v.status == 401


def test_options_preflight_is_never_blocked():
    g = guard()
    assert check(g, "/api/studies/file", method="OPTIONS").ok


def test_static_dashboard_is_reachable_without_a_credential():
    g = guard()
    for p in ("/", "/app.js", "/style.css", "/editor/"):
        assert check(g, p).ok, p


def test_cors_open_editor_routes_are_gated_when_a_token_is_set():
    g = guard()
    assert not check(g, "/api/studies/files").ok
    assert not check(g, "/api/studies/file").ok
    assert check(g, "/api/studies/file",
                 headers={"X-Carino-Token": TOKEN}).ok


# ---- session cookie -----------------------------------------------------

def test_session_cookie_never_contains_the_token():
    s = SessionSigner()
    value = s.issue(TOKEN)
    assert TOKEN not in value
    assert s.verify(value, TOKEN) == ""


def test_session_cookie_round_trips_through_check():
    g = guard()
    cookie = g.sessions.issue(TOKEN)
    assert check(g, cookies={SESSION_COOKIE: cookie}).ok


def test_tampered_cookie_is_invalid():
    s = SessionSigner()
    value = s.issue(TOKEN)
    ver, exp, nonce, sig = value.split(".")
    forged = f"{ver}.{int(exp) + 99999}.{nonce}.{sig}"
    assert s.verify(forged, TOKEN) == "invalid"
    assert s.verify(value[:-1] + ("0" if value[-1] != "0" else "1"), TOKEN) == "invalid"
    assert s.verify("garbage", TOKEN) == "invalid"
    assert s.verify("", TOKEN) == "invalid"
    assert s.verify("1.2.3", TOKEN) == "invalid"


def test_expired_cookie_reports_expired_not_invalid():
    s = SessionSigner(ttl=10)
    now = time.time()
    value = s.issue(TOKEN, now=now)
    assert s.verify(value, TOKEN, now=now + 5) == ""
    assert s.verify(value, TOKEN, now=now + 11) == "expired"
    g = guard()
    g.sessions = s
    v = check(g, cookies={SESSION_COOKIE: value}, now=now + 11)
    assert not v.ok and v.status == 401 and v.reason == "expired"


def test_rotating_the_token_invalidates_outstanding_sessions():
    cfg = FakeCfg(TOKEN)
    g = AuthGuard(cfg)
    cookie = g.sessions.issue(TOKEN)
    assert check(g, cookies={SESSION_COOKIE: cookie}).ok
    cfg.web["auth_token"] = "a-different-token"
    assert not check(g, cookies={SESSION_COOKIE: cookie}).ok


def test_restart_invalidates_sessions():
    # A fresh signer means a fresh secret: yesterday's cookie is worthless.
    cookie = SessionSigner().issue(TOKEN)
    assert SessionSigner().verify(cookie, TOKEN) == "invalid"


def test_a_forged_cookie_does_not_burn_the_rate_limit_budget():
    g = guard()
    for _ in range(50):
        assert not check(g, cookies={SESSION_COOKIE: "1.9999999999.x.deadbeef"}).ok
    # still able to authenticate: garbage cookies must not lock the operator out
    assert check(g, headers={"X-Carino-Token": TOKEN}).ok


# ---- rate limiting ------------------------------------------------------

def test_rate_limiter_blocks_after_the_budget_then_releases():
    rl = RateLimiter(limit=3, window=60.0, block=30.0)
    now = 1000.0
    assert rl.retry_after("a", now) == 0
    assert rl.record_failure("a", now) == 0
    assert rl.record_failure("a", now) == 0
    assert rl.record_failure("a", now) > 0
    assert rl.retry_after("a", now + 29) > 0
    assert rl.retry_after("a", now + 31) == 0


def test_rate_limit_window_slides_so_slow_typos_never_block():
    rl = RateLimiter(limit=3, window=60.0, block=30.0)
    now = 1000.0
    for i in range(10):
        assert rl.record_failure("a", now + i * 40) == 0


def test_a_correct_credential_clears_the_penalty():
    rl = RateLimiter(limit=2, window=60.0, block=30.0)
    rl.record_failure("a", 1000.0)
    rl.record_failure("a", 1000.0)
    assert rl.retry_after("a", 1000.0) > 0
    rl.clear("a")
    assert rl.retry_after("a", 1000.0) == 0


def test_rate_limit_is_per_client_ip():
    rl = RateLimiter(limit=2, window=60.0, block=30.0)
    rl.record_failure("a", 1000.0)
    rl.record_failure("a", 1000.0)
    assert rl.retry_after("a", 1000.0) > 0
    assert rl.retry_after("b", 1000.0) == 0


def test_tracked_clients_are_capacity_bound():
    rl = RateLimiter(limit=100, window=60.0, block=30.0, max_clients=16)
    for i in range(500):
        rl.record_failure(f"ip-{i}", 1000.0 + i * 0.001)
    assert len(rl._fails) <= 16


def test_guard_returns_429_with_retry_after_and_then_recovers():
    g = guard()
    now = 5000.0
    last = None
    for _ in range(20):
        last = check(g, headers={"X-Carino-Token": "nope"}, now=now)
    assert last.status == 429 and last.reason == "rate_limited"
    assert last.retry_after > 0
    assert last.body()["auth"]["retry_after"] > 0
    # ...and the block lifts on its own, with no operator intervention
    assert check(g, headers={"X-Carino-Token": TOKEN}, now=now + 31).ok


def test_the_right_token_is_honoured_during_a_block():
    """The operator must never be locked out of their own PACS by someone else
    on the same source address. The block slows guessing; it is not a reason to
    refuse a credential we have already verified as correct."""
    g = guard()
    now = 5000.0
    for _ in range(FAIL_LIMIT + 4):
        check(g, headers={"X-Carino-Token": "nope"}, now=now)
    assert check(g, headers={"X-Carino-Token": "nope"}, now=now).status == 429
    # the correct token gets through mid-block, and clears the penalty with it
    assert check(g, headers={"X-Carino-Token": TOKEN}, now=now).ok
    assert g.limiter.retry_after("10.0.0.5", now) == 0
    # a live session cookie is a verified credential too
    for _ in range(FAIL_LIMIT + 4):
        check(g, headers={"X-Carino-Token": "nope"}, now=now)
    cookie = g.sessions.issue(TOKEN, now=now)
    assert check(g, cookies={SESSION_COOKIE: cookie}, now=now).ok


def test_login_succeeds_during_a_block():
    """The dashboard's own recovery path — typing the token into the prompt —
    is the one thing a NAT neighbour must not be able to take away."""
    g = guard()
    now = 100.0
    for _ in range(FAIL_LIMIT + 4):
        g.login("wrong", "10.0.0.5", now=now)
    assert g.login("wrong", "10.0.0.5", now=now).status == 429
    v = g.login(TOKEN, "10.0.0.5", now=now)
    assert v.ok and v.refresh


def test_a_shared_ip_cannot_hold_the_operator_at_429_forever():
    """The reported attack, run for ten full block periods: 8 bad tokens every
    30s from a co-located client, and the operator authenticating throughout."""
    g = guard()
    now = 1000.0
    for period in range(10):
        t = now + period * 30.0
        for i in range(FAIL_LIMIT):
            check(g, headers={"X-Carino-Token": "nope"}, now=t + i * 0.01)
        assert check(g, headers={"X-Carino-Token": TOKEN}, now=t + 1).ok, period


def test_hammering_while_blocked_does_not_extend_the_block():
    g = guard()
    now = 5000.0
    for _ in range(10):
        check(g, headers={"X-Carino-Token": "nope"}, now=now)
    for t in range(1, 30):
        check(g, headers={"X-Carino-Token": "nope"}, now=now + t)
    assert check(g, headers={"X-Carino-Token": TOKEN}, now=now + 31).ok


def test_failed_attempts_are_logged_but_throttled_and_tokenless():
    log = FakeLog()
    g = guard(log=log)
    now = 5000.0
    for i in range(30):
        check(g, headers={"X-Carino-Token": "nope"}, ip="10.0.0.9", now=now + i * 0.1)
    warns = [l for l in log.lines if l[0] == "warn"]
    assert 1 <= len(warns) <= 2
    assert warns[0][2] == "auth"
    assert "10.0.0.9" in warns[0][1]
    assert "nope" not in warns[0][1]
    assert TOKEN not in warns[0][1]


# ---- login --------------------------------------------------------------

def test_login_success_and_failure():
    log = FakeLog()
    g = guard(log=log)
    bad = g.login("wrong", "10.0.0.5")
    assert not bad.ok and bad.status == 401
    good = g.login(TOKEN, "10.0.0.5")
    assert good.ok and good.refresh
    assert any(l[0] == "info" and l[2] == "auth" for l in log.lines)
    assert all(TOKEN not in l[1] for l in log.lines)


def test_login_is_rate_limited_too():
    g = guard()
    now = 100.0
    last = None
    for _ in range(20):
        last = g.login("wrong", "10.0.0.5", now=now)
    assert last.status == 429


def test_authenticated_and_status_helpers():
    g = guard()
    assert not g.authenticated(headers={}, cookies={})
    assert g.authenticated(headers={"X-Carino-Token": TOKEN}, cookies={})
    cookie = g.sessions.issue(TOKEN)
    assert g.authenticated(headers={}, cookies={SESSION_COOKIE: cookie})
    st = g.status(headers={}, cookies={})
    assert st == {"required": True, "authenticated": False}


# ---- Flask integration --------------------------------------------------

def _app(token: str = TOKEN):
    from flask import Flask, jsonify

    cfg = FakeCfg(token)
    app = Flask(__name__)
    app.config["TESTING"] = True
    g = install(app, cfg, log=FakeLog())

    @app.get("/api/status")
    def status():
        return jsonify(ok=True, secret="patient list")

    @app.post("/api/shutdown")
    def shutdown():
        return jsonify(ok=True)

    @app.get("/")
    def index():
        return "<html>dashboard shell</html>"

    return app, cfg, g


def test_flask_guard_blocks_and_admits():
    app, _cfg, _g = _app()
    c = app.test_client()

    r = c.get("/api/status")
    assert r.status_code == 401
    assert r.get_json()["auth"]["required"] is True
    assert r.headers.get("WWW-Authenticate", "").startswith("Bearer")
    assert TOKEN not in r.get_data(as_text=True)

    r = c.get("/api/status", headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 200 and r.get_json()["ok"] is True

    # the static shell stays anonymous so the token prompt can render
    assert c.get("/").status_code == 200


def test_flask_login_sets_a_usable_httponly_session_cookie():
    app, _cfg, _g = _app()
    c = app.test_client()

    assert c.post("/api/login", json={"token": "wrong"}).status_code == 401

    r = c.post("/api/login", json={"token": TOKEN})
    assert r.status_code == 200 and r.get_json()["ok"] is True
    raw = r.headers.get("Set-Cookie", "")
    assert SESSION_COOKIE in raw
    assert "HttpOnly" in raw
    assert "SameSite=Strict" in raw
    assert TOKEN not in raw
    assert "Secure" not in raw          # plain-HTTP dashboard: a Secure cookie would never be sent

    # the client now carries the cookie, so no header is needed
    r = c.get("/api/status")
    assert r.status_code == 200

    assert c.post("/api/logout").status_code == 200
    assert c.get("/api/status").status_code == 401


def test_flask_auth_endpoint_is_public():
    app, _cfg, _g = _app()
    c = app.test_client()
    r = c.get("/api/auth")
    assert r.status_code == 200
    assert r.get_json()["auth"] == {"required": True, "authenticated": False}
    c.post("/api/login", json={"token": TOKEN})
    assert c.get("/api/auth").get_json()["auth"]["authenticated"] is True


def test_flask_no_token_configured_leaves_everything_open():
    app, _cfg, _g = _app("")
    c = app.test_client()
    assert c.get("/api/status").status_code == 200
    assert c.post("/api/shutdown").status_code == 200
    assert c.get("/api/auth").get_json()["auth"]["required"] is False


def test_flask_token_set_at_runtime_takes_effect_without_restart():
    app, cfg, _g = _app("")
    c = app.test_client()
    assert c.get("/api/status").status_code == 200
    cfg.web["auth_token"] = TOKEN
    assert c.get("/api/status").status_code == 401
    cfg.web["auth_token"] = ""
    assert c.get("/api/status").status_code == 200


def test_flask_write_route_is_blocked_without_auth():
    app, _cfg, _g = _app()
    c = app.test_client()
    r = c.post("/api/shutdown", headers={"X-Carino": "1"})
    assert r.status_code == 401
    r = c.post("/api/shutdown", headers={"X-Carino": "1",
                                         "Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 200


def test_flask_rate_limit_surfaces_429_and_retry_after():
    app, _cfg, _g = _app()
    c = app.test_client()
    last = None
    for _ in range(20):
        last = c.get("/api/status", headers={"X-Carino-Token": "nope"})
    assert last.status_code == 429
    assert int(last.headers["Retry-After"]) > 0
    assert last.get_json()["auth"]["reason"] == "rate_limited"


# ---- concurrent config writes -------------------------------------------
# The dashboard runs Werkzeug with threaded=True, so two config-writing requests
# really do execute at the same time: a double-clicked Save is two POST
# /api/config, and POST /api/auth/token, the deid-key endpoint and the emergency
# arm/disarm path all end in cfg.save() as well. The file being written holds
# web.auth_token, and losing it means a PACS that will not start.

def _cfg_dir() -> str:
    return tempfile.mkdtemp(prefix="carino-cfg-")


def _run_together(fn, threads: int) -> list[BaseException]:
    """Run fn(i) on `threads` threads released at the same instant.

    The barrier is the point: without it the threads start milliseconds apart
    and a save is over before the next one begins, which is exactly the race
    not happening.
    """
    errors: list[BaseException] = []
    gate = threading.Barrier(threads)

    def run(i: int) -> None:
        try:
            gate.wait()
            fn(i)
        except BaseException as exc:      # noqa: BLE001 — the test IS the assertion
            errors.append(exc)

    ts = [threading.Thread(target=run, args=(i,)) for i in range(threads)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(30)
    return errors


def _fat_config(cfg: Config) -> None:
    """Enough destinations that a save is a real write, not one syscall.

    A two-line config is dumped so fast the threads rarely overlap; this is the
    size of a config from a site with a few dozen nodes.
    """
    cfg.data["destinations"] = [
        {"name": f"NODE{i:02d}", "host": f"10.0.0.{i}", "port": 104,
         "aet": f"ARCHIVE{i:02d}", "enabled": True}
        for i in range(60)
    ]


def _leftovers(d: str) -> list[str]:
    return sorted(n for n in os.listdir(d) if n != "config.json")


def test_concurrent_saves_never_corrupt_the_config():
    """Two operators pressing Save at the same moment must not be able to
    destroy config.json.

    With a temp file named from a FIXED path, the savers shared one temp: one
    unlinked the other's file mid-write, so os.replace either raised
    FileNotFoundError or renamed a half-written (routinely zero-byte) temp over
    the config — and `pacs serve` then died on a JSONDecodeError nothing in the
    dashboard could explain."""
    d = _cfg_dir()
    cfg = Config(os.path.join(d, "config.json"))
    _fat_config(cfg)
    cfg.save()
    expected = copy.deepcopy(cfg.data)

    # A second process reading the file while the dashboard writes it — which is
    # precisely `pacs serve` starting up — must never catch it mid-rename. On
    # the shared temp name it did: this reader saw a zero-byte config.json.
    stop = threading.Event()
    torn: list[str] = []

    def reader() -> None:
        while not stop.is_set():
            try:
                with open(cfg.path, "r", encoding="utf-8") as fh:
                    raw = fh.read()
            except FileNotFoundError:
                torn.append("config.json vanished")
                continue
            if not raw.strip():
                torn.append(f"config.json read back as {len(raw)} bytes")
                continue
            try:
                json.loads(raw)
            except json.JSONDecodeError as exc:
                torn.append(f"config.json read back unparseable: {exc}")

    watcher = threading.Thread(target=reader)
    watcher.start()
    try:
        for round_no in range(50):
            errors = _run_together(lambda i: cfg.save(), threads=8)
            assert not errors, f"round {round_no}: save() raised {errors[0]!r}"
            size = os.path.getsize(cfg.path)
            assert size > 0, f"round {round_no}: config.json was left zero-byte"
            with open(cfg.path, "r", encoding="utf-8") as fh:
                assert json.load(fh) == expected, f"round {round_no}: config.json came back changed"
            # A save that dies mid-flight must not leave its scratch file behind
            # either — litter in this directory is what the old fixed name
            # turned into a collision in the first place.
            assert _leftovers(d) == [], f"round {round_no}: left {_leftovers(d)} behind"
    finally:
        stop.set()
        watcher.join(30)
    assert not torn, torn[:3]
    if os.name == "posix":
        # 0600 is not incidental: this file holds web.auth_token and deid.secret
        # in plaintext.
        assert os.stat(cfg.path).st_mode & 0o777 == 0o600, oct(os.stat(cfg.path).st_mode)


def test_a_save_racing_a_full_config_post_lands_one_whole_document():
    """POST /api/config (cfg.replace) against POST /api/auth/token (cfg.save).

    Whichever wins, what is on disk has to be one complete document. A file
    holding the port from one save and the AE title from the other is a config
    no operator wrote and none can debug."""
    d = _cfg_dir()
    cfg = Config(os.path.join(d, "config.json"))
    _fat_config(cfg)
    cfg.save()
    base = copy.deepcopy(cfg.data)
    alpha = copy.deepcopy(base)
    alpha["scp"]["port"], alpha["scu"]["aet"] = 21112, "ALPHA"
    bravo = copy.deepcopy(base)
    bravo["scp"]["port"], bravo["scu"]["aet"] = 21113, "BRAVO"
    pairs = {(21112, "ALPHA"), (21113, "BRAVO")}

    def writer(i: int) -> None:
        cfg.replace(alpha if i % 2 else bravo)

    for round_no in range(50):
        errors = _run_together(writer, threads=6)
        assert not errors, f"round {round_no}: replace() raised {errors[0]!r}"
        with open(cfg.path, "r", encoding="utf-8") as fh:
            got = json.load(fh)
        assert (got["scp"]["port"], got["scu"]["aet"]) in pairs, \
            f"round {round_no}: config.json mixes two saves: {got['scp']['port']} / {got['scu']['aet']}"
        assert got["destinations"] == base["destinations"], f"round {round_no}: destinations lost"
        assert _leftovers(d) == [], f"round {round_no}: left {_leftovers(d)} behind"


def test_a_save_that_is_killed_mid_flight_does_not_wedge_the_next_one():
    """O_EXCL refuses a file it did not create. With one fixed temp name, the
    leftover of a crashed save blocked every save after it; with unique names it
    cannot, and the abandoned scratch file is swept once it is old enough to be
    certain nobody is still writing it."""
    d = _cfg_dir()
    cfg = Config(os.path.join(d, "config.json"))
    litter = os.path.join(d, "config.json.tmp.4242.deadbeefdeadbeef")
    with open(litter, "w", encoding="utf-8") as fh:
        fh.write("half a config from a crash")
    os.utime(litter, (0, 0))          # an hour+ old: abandoned, not in flight
    fresh = os.path.join(d, "config.json.tmp.4243.0123456789abcdef")
    with open(fresh, "w", encoding="utf-8") as fh:
        fh.write("a save happening right now")
    cfg.save()
    assert json.load(open(cfg.path, encoding="utf-8"))["web"]["port"] == 8042
    assert not os.path.exists(litter), "the abandoned scratch file was left behind"
    # The young one belongs to a save that has not renamed yet. Deleting it is
    # how the old code broke: that saver's os.replace would fail.
    assert os.path.exists(fresh), "the sweep deleted a temp file a live save still needs"


def test_an_empty_or_truncated_config_is_refused_with_an_explanation():
    """What the operator actually saw was `JSONDecodeError: Expecting value:
    line 1 column 1 (char 0)` and a traceback — nothing naming the file, and
    nothing to do about it. Loading the DEFAULTS instead would be worse: a PACS
    that starts with the receiver off and no token, quietly."""
    from pacs.config import ConfigError

    for body in ("", "   \n", '{"scp": {"port": 111', "[]", "not json at all"):
        d = _cfg_dir()
        path = os.path.join(d, "config.json")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(body)
        try:
            Config(path)
        except ConfigError as exc:
            assert isinstance(exc, ValueError), "callers catch ValueError for a bad config"
            assert path in str(exc), str(exc)
            assert "init" in str(exc), f"no way out offered: {exc}"
        else:
            raise AssertionError(f"Config accepted {body!r}")
    # ...and a config that is simply absent is still the normal first run.
    d = _cfg_dir()
    assert Config(os.path.join(d, "config.json")).data["web"]["port"] == 8042


def test_a_config_that_cannot_be_opened_is_explained_too():
    """The three ways the file exists and still will not load. Only the JSON
    ones were answered: a directory at the config path, a file this account
    cannot read (a systemd unit's User=, a container's uid) and a file whose
    bytes are not text at all each reached the operator as a raw traceback out
    of open(), with the same 'guess DEFAULTS' hazard behind it — a PACS that
    starts with the receiver off because nobody could read the config saying it
    should be on."""
    from pacs.config import ConfigError

    d = _cfg_dir()
    as_dir = os.path.join(d, "config.json")
    os.makedirs(as_dir)
    cases = [as_dir]

    binary = os.path.join(_cfg_dir(), "config.json")
    with open(binary, "wb") as fh:                    # half-overwritten with rubbish
        fh.write(b'{"scp": {"port": 1111\xff\xfe\x00garbage')
    cases.append(binary)

    unreadable = os.path.join(_cfg_dir(), "config.json")
    with open(unreadable, "w", encoding="utf-8") as fh:
        fh.write("{}")
    if os.name == "posix" and os.getuid() != 0:       # root reads it regardless
        os.chmod(unreadable, 0o000)
        cases.append(unreadable)

    for path in cases:
        try:
            Config(path)
        except ConfigError as exc:
            assert isinstance(exc, ValueError), "callers catch ValueError for a bad config"
            assert path in str(exc), str(exc)
            assert "init" in str(exc), f"no way out offered: {exc}"
        except Exception as exc:                      # noqa: BLE001
            raise AssertionError(f"{path}: {type(exc).__name__} escaped as itself: {exc}")
        else:
            raise AssertionError(f"Config accepted {path}")


def test_the_config_version_covers_the_secrets_without_leaking_them():
    """cfg.version() is what POST /api/config compares an If-Match against, so
    what it does and does not cover is a security property, not a detail.

    It must move when the document does — that is the whole point — and the two
    secrets are part of the document. They used to be folded in as booleans, on
    the reasoning that they cannot be set through that endpoint so a rotation
    need not invalidate an open Save. That left the one mechanism built to catch
    a silent revert blind to exactly the values worth protecting: a Save that
    reverted a token rotation could not be refused, because the fingerprint
    could not see the rotation. Both halves are asserted here — the fingerprint
    moves with each secret, and it still cannot be used to recover one.

    The version is published as an ETag to every holder of a session COOKIE, and
    a cookie is deliberately not enough to read either secret. A plain digest of
    the raw document would hand that caller an offline oracle for a short
    operator-chosen token, so the secrets go in through a KEYED fingerprint —
    and the test for "keyed" is that the same document in another process does
    not fingerprint the same, which is what makes a guess unconfirmable."""
    d = _cfg_dir()
    path = os.path.join(d, "config.json")
    cfg = Config(path)
    v0 = cfg.version()
    assert v0 == cfg.version(), "the same document fingerprinted twice must match"

    cfg.data["scp"]["port"] = 11199
    assert cfg.version() != v0, "a changed document kept its old fingerprint"
    cfg.data["scp"]["port"] = DEFAULTS["scp"]["port"]
    assert cfg.version() == v0, "the fingerprint is not a function of the document alone"

    # Key order in the file must not count as a change: config.json is hand
    # edited, and re-ordering two keys is not somebody else's save.
    reordered = Config(os.path.join(_cfg_dir(), "config.json"))
    reordered.data = {k: copy.deepcopy(v) for k, v in reversed(list(cfg.data.items()))}
    assert reordered.version() == v0

    # Setting, rotating and clearing a token are three changes to the document,
    # and all three have to be visible to a stale-Save check.
    cfg.web["auth_token"] = TOKEN
    v_token = cfg.version()
    assert v_token != v0, "setting the first token left the fingerprint where it was"
    cfg.web["auth_token"] = TOKEN + "-rotated"
    v_rotated = cfg.version()
    assert v_rotated != v_token, ("rotating the token did not move the config fingerprint — "
                                  "a Save built before the rotation cannot be refused")
    cfg.web["auth_token"] = ""
    assert cfg.version() not in (v_token, v_rotated), "clearing the token was invisible"
    cfg.web["auth_token"] = TOKEN + "-rotated"
    assert cfg.version() == v_rotated, "the fingerprint is not a function of the value alone"

    cfg.deid["secret"] = "site-key-one"
    v_secret = cfg.version()
    cfg.deid["secret"] = "site-key-two"
    assert cfg.version() != v_secret, "changing the site key did not move the fingerprint"

    # And covering them does not publish them, in any of the three ways it could.
    for probe in (TOKEN, TOKEN + "-rotated", "site-key-one", "site-key-two"):
        assert probe not in cfg.version()
    plain = hashlib.sha256(
        json.dumps(cfg.data, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()[:16]
    assert cfg.version() != plain, ("the version is a plain digest of the raw document — "
                                    "anyone holding it can brute-force the token offline")
    # The one that matters: an attacker who holds an ETag and guesses a token
    # cannot check the guess, because reproducing the fingerprint needs a key
    # that never leaves this process. Same file, same document, other process.
    cfg.save()
    same_process = Config(path)
    assert same_process.version() == cfg.version(), ("two Config objects on one document "
                                                     "must agree, or If-Match is a coin toss")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    script = ("import sys; sys.path.insert(0, %r)\n"
              "from pacs.config import Config\n"
              "print(Config(sys.argv[1]).version())\n" % root)
    elsewhere = subprocess.run([sys.executable, "-c", script, path],
                               capture_output=True, text=True, timeout=120)
    assert elsewhere.returncode == 0, elsewhere.stderr
    assert elsewhere.stdout.strip() and elsewhere.stdout.strip() != cfg.version(), (
        "the same document fingerprints identically in another process — the secrets are "
        "hashed unkeyed, so the ETag is an offline oracle for them")


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
