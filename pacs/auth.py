"""Bearer-token auth for the dashboard API and DICOMweb.

The API binds 127.0.0.1 by default, where "no auth" is defensible: only a
process on this machine can reach it, and the X-Carino header stops a page the
operator has open from firing cross-site writes. But web.host is operator
configurable, and the moment it becomes 0.0.0.0 that same API hands any LAN
neighbour the study list, the storage paths, the DICOM bytes and /api/shutdown.

So: ``web.auth_token`` empty means no auth, and config validation refuses a
non-loopback host with an empty token. Loopback stays frictionless; anything
reachable off-box is forced to authenticate. This module is the enforcement
half of that contract — it does not decide policy, it applies it.

Credentials accepted on every protected request:

  * ``Authorization: Bearer <token>``
  * ``X-Carino-Token: <token>``
  * a ``carino_session`` cookie, issued by POST /api/login

The cookie exists so the dashboard asks for the token once instead of holding
it in JavaScript where every XSS and every browser extension can read it. It
never carries the token — only an HMAC over a secret generated at startup and
kept in memory, so a restart logs everyone out. That is the correct trade for a
single-operator appliance: no session store on disk, nothing to leak, and the
worst case is retyping a token after a service restart.
"""

from __future__ import annotations

import hmac
import secrets
import time
from collections import deque
from hashlib import sha256
from typing import Any, Optional

from . import users as _users
from .config import auth_token_of

SESSION_COOKIE = "carino_session"
SESSION_TTL = 12 * 3600         # a working day; the operator retypes at most once per shift

# Two cookie formats, deliberately not one.
#
#   "1"  ver.exp.nonce.sig                  — the shared token's session
#   "2"  ver.exp.nonce.profile_id.sig       — one person's session
#
# A v1 value is what every install that predates profiles is already holding, and
# it keeps working untouched. Version 2 carries WHO, because a capability check
# has to name somebody and an audit entry has to attribute to them. Keeping the
# formats apart rather than growing one is what makes "a v1 cookie can never be
# read as naming a profile" true by parsing rather than by care: verify() rejects
# anything that is not exactly four parts, so a v2 value cannot drift into the
# token path and a forged "2" prefix cannot shorten its way into the v1 one.
SESSION_VERSION = "1"
SESSION_VERSION_PROFILE = "2"

# Everything under these prefixes needs a credential when a token is set.
# "/dicom-web" is listed even though this file predates that blueprint: the
# whole point of a token is that no route can be reachable by accident.
PROTECTED_PREFIXES = ("/api", "/dicom-web")

# ---- what is deliberately NOT protected ---------------------------------
# The static dashboard (index.html, app.js, the stylesheet, the bundled
# editor) is served to anyone who asks, and that is the right answer, not an
# oversight:
#   * it contains no patient data and no configuration — every byte of both
#     arrives over /api/*, which 401s without a credential;
#   * gating it makes the token prompt unreachable. A browser cannot render a
#     "paste your token" form it was never allowed to download, and there is
#     no fallback UI to fall back to. Auth that cannot be satisfied is an
#     outage, and this is medical software;
#   * the alternative — HTTP Basic on the static tree — hands the token to the
#     browser's credential store and to every subsequent request, including
#     the ones we want to answer anonymously.
# The exposure is a login page and the app shell. Everything of value is
# behind the API guard.
PUBLIC_PATHS = frozenset({
    "/api/auth",        # "does this server want a token?" — the 401 already says so
    "/api/login",
    "/api/logout",
    # The profile picker, for the same reason /api/login is public: a browser
    # cannot draw a "who are you" screen out of a 401. It answers names, roles
    # and whether each needs a password — never an email, a capability list or
    # any password material — and it answers nothing at all when the operator
    # sets users.list_profiles false. See Profile.public().
    "/api/profiles",
})

# Failed-attempt budget per client IP. Small enough that guessing a
# token_urlsafe(32) is hopeless, short enough that an operator who fat-fingers
# their token waits half a minute, never longer. There is no escalation and no
# permanent ban, and a correct credential is honoured even mid-block: locking
# the only operator out of a running PACS is a worse failure than a slow brute
# force, and 8 bad tokens from a NAT neighbour must not be able to do it.
FAIL_LIMIT = 8
FAIL_WINDOW = 60.0
FAIL_BLOCK = 30.0
MAX_TRACKED_CLIENTS = 1024


def generate_token(nbytes: int = 32) -> str:
    """A fresh token for `pacs init --token` / the dashboard's Generate button.

    32 bytes of urandom is ~43 URL-safe characters and roughly 256 bits, which
    is not guessable at any rate the network allows, rate limiter or not.
    """
    return secrets.token_urlsafe(nbytes)


def token_from_headers(headers: Any) -> str:
    """Pull a presented token out of a request's headers, "" if none.

    Accepts either spelling. Nothing here logs, echoes or stores the value —
    the caller compares it and drops it.
    """
    auth = str(headers.get("Authorization") or "").strip()
    if auth:
        parts = auth.split(None, 1)
        if len(parts) == 2 and parts[0].lower() == "bearer":
            return parts[1].strip()
    return str(headers.get("X-Carino-Token") or "").strip()


def path_is_protected(path: str, extra_prefixes: tuple[str, ...] = ()) -> bool:
    p = str(path or "/")
    if p in PUBLIC_PATHS:
        return False
    for prefix in PROTECTED_PREFIXES + tuple(extra_prefixes):
        if p == prefix or p.startswith(prefix + "/"):
            return True
    return False


class RateLimiter:
    """Sliding window of failed attempts per client, with a fixed short block.

    It counts failures and nothing else. The caller checks the credential first
    and only lands here when that credential was wrong, so a correct token is
    never refused by a block — the alternative locked out every operator who
    shared a source IP with a noisy client. Attempts made while a block is
    already standing are not recorded either, so a hammering client cannot renew
    its own block forever; a client that walks away always gets back in.
    """

    def __init__(self, limit: int = FAIL_LIMIT, window: float = FAIL_WINDOW,
                 block: float = FAIL_BLOCK, max_clients: int = MAX_TRACKED_CLIENTS):
        self.limit = int(limit)
        self.window = float(window)
        self.block = float(block)
        self.max_clients = int(max_clients)
        self._fails: dict[str, deque[float]] = {}
        self._blocked: dict[str, float] = {}   # key -> epoch when the block lifts
        self._noted: dict[str, float] = {}     # key -> epoch we last logged, for log throttling

    def _prune(self, now: float) -> None:
        # An attacker spraying from a botnet must not be able to grow this dict
        # until the PACS runs out of memory, so tracking is capacity bound. Drop
        # expired keys first; if that is not enough, drop the least recently
        # active. Losing a key only forgives past failures, it never grants
        # access.
        for key in [k for k, until in self._blocked.items() if until <= now]:
            self._blocked.pop(key, None)
        for key in [k for k, hits in self._fails.items()
                    if not hits or hits[-1] <= now - self.window]:
            self._fails.pop(key, None)
            self._noted.pop(key, None)
        while len(self._fails) > self.max_clients:
            oldest = min(self._fails, key=lambda k: self._fails[k][-1])
            self._fails.pop(oldest, None)
            self._noted.pop(oldest, None)

    def retry_after(self, key: str, now: Optional[float] = None) -> int:
        """Seconds this client must wait, 0 when it may attempt now."""
        now = time.time() if now is None else now
        until = self._blocked.get(key, 0.0)
        if until <= now:
            return 0
        return max(1, int(round(until - now)))

    def record_failure(self, key: str, now: Optional[float] = None) -> int:
        """Count one evaluated failure; returns the new retry_after."""
        now = time.time() if now is None else now
        hits = self._fails.setdefault(key, deque())
        cutoff = now - self.window
        while hits and hits[0] <= cutoff:
            hits.popleft()
        hits.append(now)
        if len(hits) >= self.limit:
            self._blocked[key] = now + self.block
            hits.clear()
        self._prune(now)
        return self.retry_after(key, now)

    def clear(self, key: str) -> None:
        """A correct credential forgives the client's history."""
        self._fails.pop(key, None)
        self._blocked.pop(key, None)
        self._noted.pop(key, None)

    def should_log(self, key: str, now: Optional[float] = None) -> bool:
        """One log line per client per window.

        A brute-forcer must not be able to flush real receive/send activity out
        of the log buffer just by making noise.
        """
        now = time.time() if now is None else now
        if now - self._noted.get(key, 0.0) < self.window:
            return False
        self._noted[key] = now
        return True


class SessionSigner:
    """Issues and verifies the signed cookie value.

    The secret is per-process and never written anywhere, so sessions die with
    the process. The signed payload includes a fingerprint of the token that
    was presented at login, which means rotating web.auth_token invalidates
    every outstanding session without needing to track them.
    """

    def __init__(self, ttl: int = SESSION_TTL):
        self._secret = secrets.token_bytes(32)
        self.ttl = int(ttl)

    def _sign(self, payload: str) -> str:
        return hmac.new(self._secret, payload.encode("utf-8"), sha256).hexdigest()

    def fingerprint(self, token: str) -> str:
        """Short HMAC of the token under the session secret.

        Keyed, not a bare hash: the cookie is handed to a browser, and a plain
        digest of the token would be an offline-crackable copy of it.
        """
        return self._sign("fp:" + str(token or ""))[:32]

    def issue(self, token: str, now: Optional[float] = None) -> str:
        now = time.time() if now is None else now
        exp = int(now + self.ttl)
        nonce = secrets.token_urlsafe(9)
        payload = f"{SESSION_VERSION}.{exp}.{nonce}.{self.fingerprint(token)}"
        return f"{SESSION_VERSION}.{exp}.{nonce}.{self._sign(payload)}"

    def verify(self, value: str, token: str, now: Optional[float] = None) -> str:
        """"" when the cookie is good, else a reason: invalid | expired.

        Signature first, expiry second — the expiry is inside the signed
        payload, so a tampered one never reaches the clock comparison.
        """
        now = time.time() if now is None else now
        parts = str(value or "").split(".")
        if len(parts) != 4:
            return "invalid"
        ver, exp_s, nonce, sig = parts
        if ver != SESSION_VERSION:
            return "invalid"
        payload = f"{ver}.{exp_s}.{nonce}.{self.fingerprint(token)}"
        if not hmac.compare_digest(sig, self._sign(payload)):
            return "invalid"
        try:
            exp = int(exp_s)
        except ValueError:
            return "invalid"
        if exp <= now:
            return "expired"
        return ""

    # ---- profile sessions (format 2) ------------------------------------
    def issue_profile(self, profile_id: str, credential_fp: str,
                      now: Optional[float] = None) -> str:
        """A session naming one person, bound to the credential they used.

        *credential_fp* is users.password_fingerprint of their stored password,
        or the constant for an open profile. Binding to it is what makes a
        password change log that person out — and only that person, which is the
        whole difference from the token, where a rotation logs out everybody.
        """
        now = time.time() if now is None else now
        exp = int(now + self.ttl)
        nonce = secrets.token_urlsafe(9)
        pid = str(profile_id or "")
        payload = f"{SESSION_VERSION_PROFILE}.{exp}.{nonce}.{pid}.{self.fingerprint(credential_fp)}"
        return f"{SESSION_VERSION_PROFILE}.{exp}.{nonce}.{pid}.{self._sign(payload)}"

    @staticmethod
    def claimed_profile_id(value: str) -> str:
        """The profile id a cookie CLAIMS, with nothing verified yet.

        Used for exactly one thing: choosing which stored password to check the
        signature against. That is safe because the signature check immediately
        afterwards is what proves the claim — an attacker who edits this field
        selects a different key and then fails to match. It must never be used
        as an identity on its own, which is why it is a static method that
        returns a bare string and not a Profile: there is nothing here to
        mistake for a lookup that already succeeded.
        """
        parts = str(value or "").split(".")
        if len(parts) != 5 or parts[0] != SESSION_VERSION_PROFILE:
            return ""
        return parts[3]

    def verify_profile(self, value: str, credential_fp: str,
                       now: Optional[float] = None) -> str:
        """"" when the cookie is good, else invalid | expired."""
        now = time.time() if now is None else now
        parts = str(value or "").split(".")
        if len(parts) != 5:
            return "invalid"
        ver, exp_s, nonce, pid, sig = parts
        if ver != SESSION_VERSION_PROFILE:
            return "invalid"
        payload = f"{ver}.{exp_s}.{nonce}.{pid}.{self.fingerprint(credential_fp)}"
        if not hmac.compare_digest(sig, self._sign(payload)):
            return "invalid"
        try:
            exp = int(exp_s)
        except ValueError:
            return "invalid"
        if exp <= now:
            return "expired"
        return ""


class Verdict:
    """Outcome of one auth check: what to do, and what to tell the client."""

    __slots__ = ("ok", "status", "reason", "retry_after", "refresh")

    def __init__(self, ok: bool, status: int = 200, reason: str = "",
                 retry_after: int = 0, refresh: bool = False):
        self.ok = ok
        self.status = status
        self.reason = reason
        self.retry_after = retry_after
        self.refresh = refresh      # cookie should be re-issued (login, or a token rotation)

    def body(self) -> dict:
        """The JSON shape the dashboard keys off to raise its token prompt.

        `auth.required` is the flag to test — a plain `ok: false` is every
        other error in this API, and the UI must be able to tell "wrong input"
        from "you are not logged in".
        """
        msg = ("too many failed attempts — wait and try again"
               if self.reason == "rate_limited" else "authentication required")
        return {
            "ok": False,
            "error": msg,
            "auth": {"required": True, "reason": self.reason,
                     "retry_after": self.retry_after},
        }


class AuthGuard:
    """Policy + state for one server. Reads the token live from config.

    Live, not cached: the operator can set or rotate web.auth_token from
    Settings and it takes effect on the next request, with no restart and no
    window where a saved token is not yet being enforced.
    """

    def __init__(self, cfg, log=None, ttl: int = SESSION_TTL,
                 extra_prefixes: tuple[str, ...] = ()):
        self.cfg = cfg
        self.log = log
        self.sessions = SessionSigner(ttl=ttl)
        self.limiter = RateLimiter()
        self.extra_prefixes = tuple(extra_prefixes)

    @property
    def token(self) -> str:
        # config.auth_token_of, never a local coercion: the gate that decides a
        # token is MANDATORY and the guard that ENFORCES it have to read the
        # same value out of the same JSON, or a config exists that satisfies one
        # and not the other. One did — see auth_token_of's docstring.
        return auth_token_of(self.cfg.web)

    @property
    def profiles_enabled(self) -> bool:
        """Is this appliance running with profiles, or on the token alone?

        Read live from config for the same reason the token is: an operator who
        seeds profiles from the dashboard must not have to restart, and there
        must be no window in which profiles exist but nothing enforces them.
        """
        try:
            return _users.profiles_in_use(self.cfg.users)
        except (AttributeError, KeyError, TypeError):
            # A Config built before the users section existed, or a stub in a
            # test. No profiles is the honest answer and the safe one: it means
            # the guard falls back to exactly the token behaviour it had before.
            return False

    @property
    def required(self) -> bool:
        """Must a request carry a credential?

        Turning profiles on has to be sufficient by itself. It used to be the
        token alone that decided this, and leaving it that way would have meant
        an operator who seeds profiles on a loopback box — the common case, and
        the one the whole feature is for — gets a picker that anyone can walk
        past, because with no token set the guard waves every request through
        before it ever looks at who is asking.
        """
        return bool(self.token) or self.profiles_enabled

    def verify_token(self, presented: str) -> bool:
        token = self.token
        if not token or not presented:
            return False
        # compare_digest on bytes: the str overload raises on non-ASCII, and a
        # token pasted with a stray unicode character must fail as a wrong
        # token, not as a 500.
        return hmac.compare_digest(presented.encode("utf-8", "surrogatepass"),
                                   token.encode("utf-8", "surrogatepass"))

    def check(self, *, method: str, path: str, headers: Any, cookies: Any,
              client_ip: str, now: Optional[float] = None) -> Verdict:
        """Decide one request. Never raises, never logs the credential."""
        if not self.required:
            return Verdict(True)
        # CORS preflights carry no credentials by definition; rejecting them
        # breaks the editor deep-link before the real request is ever sent, and
        # an OPTIONS response discloses nothing.
        if str(method).upper() == "OPTIONS":
            return Verdict(True)
        if not path_is_protected(path, self.extra_prefixes):
            return Verdict(True)

        # The credential is checked BEFORE the block, and a correct one always
        # gets through. The block exists to slow guessing, and guessing a
        # token_urlsafe(32) is not a threat that justifies locking the operator
        # out of a running PACS: rejecting a valid token during a block means
        # anyone sharing the operator's source IP — NAT, a second browser, the
        # same host — can hold the dashboard at 429 forever with 8 bad tokens
        # every 30s. Only failures are counted, below.
        presented = token_from_headers(headers)
        if presented:
            if self.verify_token(presented):
                self.limiter.clear(client_ip)
                return Verdict(True)
            return self._fail(client_ip, "invalid", now)

        raw = self._cookie(cookies)
        if raw:
            # A profile session is checked against that profile's password, a
            # token session against the token. Which one this is comes from the
            # cookie's own format, so the two can never be confused: a v1 value
            # has no id to look up and a v2 value never reaches the token path.
            if SessionSigner.claimed_profile_id(raw):
                _profile, reason = self._profile_from_cookie(raw, now)
                if not reason:
                    return Verdict(True)
                return Verdict(False, 401, reason)
            reason = self.sessions.verify(raw, self.token, now)
            if not reason:
                # A token session is still a valid credential when profiles are
                # on — it authenticates as the service identity, which is what
                # every existing dashboard tab is holding the moment the
                # operator seeds profiles. Logging all of them out mid-shift to
                # celebrate the new feature is not an upgrade path.
                return Verdict(True)
            # An expired or token-rotated session is a stale browser, not a
            # guess: it costs the attacker nothing to forge garbage cookies, so
            # counting them against the window would let anyone lock an
            # operator out for 30s at a time from a spoofable position.
            return Verdict(False, 401, reason)

        return Verdict(False, 401, "missing")

    @staticmethod
    def _cookie(cookies: Any) -> str:
        try:
            return str(cookies.get(SESSION_COOKIE) or "")
        except Exception:
            return ""

    def _profile_from_cookie(self, raw: str, now: Optional[float] = None):
        """(Profile, "") for a good profile session, (None, reason) otherwise.

        The lookup happens on every request rather than being cached in the
        cookie, which is the point: an administrator who disables someone or
        edits what they may do has it take effect on that person's very next
        request, with no restart and no waiting for a session to expire. A
        cached capability list would have meant a revoked profile keeps working
        for up to twelve hours.
        """
        pid = SessionSigner.claimed_profile_id(raw)
        if not pid:
            return None, "invalid"
        profile = _users.by_id(self.cfg.users, pid)
        # Deleted or disabled reads as invalid, not as its own reason. The
        # browser's move is identical (log in again), and naming the difference
        # would tell an unauthenticated caller which ids exist.
        if profile is None or not profile.enabled:
            return None, "invalid"
        reason = self.sessions.verify_profile(raw, profile.credential_fingerprint(), now)
        if reason:
            return None, reason
        return profile, ""

    def identify(self, *, headers: Any, cookies: Any) -> "_users.Profile":
        """Who is making this request. Never raises, never returns None.

        Returns users.ANONYMOUS rather than None so a caller that forgets to
        check gets a denial from the capability test instead of an
        AttributeError halfway through composing a payload — a crash there would
        be served as a 500 from an endpoint whose whole job at that moment was
        to refuse.
        """
        if not self.profiles_enabled:
            # No capability model in force: this is the pre-profiles world, where
            # holding the token (or being on loopback with no token set) means
            # holding everything. Saying so explicitly here is what lets every
            # endpoint downstream ask "can you" without also asking "are
            # profiles on".
            return _users.SERVICE_PROFILE
        presented = token_from_headers(headers)
        if presented and self.verify_token(presented):
            return _users.SERVICE_PROFILE
        raw = self._cookie(cookies)
        if raw:
            if SessionSigner.claimed_profile_id(raw):
                profile, reason = self._profile_from_cookie(raw)
                if not reason and profile is not None:
                    return profile
            elif self.token and not self.sessions.verify(raw, self.token):
                return _users.SERVICE_PROFILE
        return _users.ANONYMOUS

    def _fail(self, client_ip: str, reason: str, now: Optional[float] = None) -> Verdict:
        if self.log is not None and self.limiter.should_log(client_ip, now):
            self.log.warn(f"Rejected API request with a bad token from {client_ip}",
                          kind="auth")
        # Already blocked: report the wait, but do NOT record — counting attempts
        # made during a block would let a hammering client renew its own block
        # forever, and the operator's correct token now clears it anyway.
        wait = self.limiter.retry_after(client_ip, now)
        if wait:
            return Verdict(False, 429, "rate_limited", retry_after=wait)
        wait = self.limiter.record_failure(client_ip, now)
        if wait:
            return Verdict(False, 429, "rate_limited", retry_after=wait)
        return Verdict(False, 401, reason)

    def login(self, presented: str, client_ip: str,
              now: Optional[float] = None) -> Verdict:
        """POST /api/login. On success the caller sets the session cookie."""
        if not self.required:
            return Verdict(True, refresh=False)
        # Credential first, same as check(): the operator typing the right token
        # must always be able to log in, however much noise a co-located client
        # has been making from the same address.
        if not self.verify_token(str(presented or "").strip()):
            return self._fail(client_ip, "invalid", now)
        self.limiter.clear(client_ip)
        if self.log is not None:
            self.log.info(f"Dashboard authenticated from {client_ip}", kind="auth")
        return Verdict(True, refresh=True)

    def login_profile(self, profile_id: str, password: str, client_ip: str,
                      now: Optional[float] = None):
        """POST /api/login with a profile. Returns (Verdict, Profile).

        An OPEN profile — one with no password — logs in on the strength of
        being picked, which is the point of the setting and is why validate()
        refuses that combination on a network-reachable bind. It is still a
        deliberate POST rather than something the page assumes, so the audit
        trail has a login to record and the operator has a session to end.
        """
        profile = _users.by_id(self.cfg.users, str(profile_id or ""))
        if profile is None or not profile.enabled:
            # A wrong id and a wrong password answer identically, and both are
            # counted. The picker already publishes which profiles exist when
            # the operator wants it to; where they have turned that off, this
            # must not put it back by being more specific about failures.
            return self._fail(client_ip, "invalid", now), _users.ANONYMOUS
        if profile.locked:
            if not profile.check_password(str(password or "")):
                return self._fail(client_ip, "invalid", now), _users.ANONYMOUS
        elif password:
            # They typed a password at a profile that has none. Refusing is the
            # honest answer: silently accepting it teaches somebody that their
            # password "works" and leaves them believing the account is
            # protected when anyone can click straight in.
            return self._fail(client_ip, "invalid", now), _users.ANONYMOUS
        self.limiter.clear(client_ip)
        if self.log is not None:
            self.log.info(f"{profile.name} signed in from {client_ip}", kind="auth")
        return Verdict(True, refresh=True), profile

    def authenticated(self, *, headers: Any, cookies: Any) -> bool:
        """Is this request already carrying a good credential? (for /api/auth)"""
        if not self.required:
            return True
        presented = token_from_headers(headers)
        if presented and self.verify_token(presented):
            return True
        raw = self._cookie(cookies)
        if not raw:
            return False
        if SessionSigner.claimed_profile_id(raw):
            _profile, reason = self._profile_from_cookie(raw)
            return not reason
        return not self.sessions.verify(raw, self.token)

    def status(self, *, headers: Any = None, cookies: Any = None) -> dict:
        """What the login screen needs to decide what to draw.

        ``profiles`` says whether to show a picker at all; ``who`` is the
        identity of the current session, and is what the dashboard derives its
        panels from. Both are absent-shaped rather than wrong when there is no
        request to inspect, because /api/login answers this before a cookie has
        been set on the response.
        """
        base = {
            "required": self.required,
            "profiles": self.profiles_enabled,
            # An operator who turned the picker off gets a name-and-password
            # form instead, and the browser has to be told which.
            "list_profiles": self.lists_profiles(),
        }
        if headers is None or cookies is None:
            base["authenticated"] = not self.required
            base["who"] = None
            return base
        base["authenticated"] = self.authenticated(headers=headers, cookies=cookies)
        who = self.identify(headers=headers, cookies=cookies)
        base["who"] = self.whoami(who) if base["authenticated"] else None
        return base

    def lists_profiles(self) -> bool:
        try:
            return self.cfg.users.get("list_profiles", True) is not False
        except (AttributeError, KeyError, TypeError):
            return True

    # ---- the capability gate, as endpoints use it ------------------------
    # Flask is imported inside these rather than at module scope so the guard
    # stays testable without an app, and so a CLI that only wants verify_token
    # does not drag the web stack into a frozen binary's import graph.

    def current(self) -> "_users.Profile":
        """Who is making the request Flask is currently handling."""
        from flask import request
        return self.identify(headers=request.headers, cookies=request.cookies)

    def deny(self, capability: str):
        """None when the caller may do this, else the response to return.

        The shape every protected endpoint uses::

            denied = guard.deny("studies.delete")
            if denied:
                return denied

        Deliberately not a decorator. Several endpoints need the capability to
        depend on what was posted — /api/config asks for config.write, but the
        same handler is where a de-identification change needs deid.manage —
        and a decorator would have pushed that decision to the top of the
        function where the body is not parsed yet. A two-line guard at the point
        of the decision reads worse and is right more often.
        """
        from flask import jsonify, request
        # Preflights carry no credentials by definition, so there is nobody to
        # check a capability against and a 403 here would break the editor's
        # cross-origin deep-link before the real request was ever sent. check()
        # already waves OPTIONS through for the same reason; this has to agree
        # with it, or the two gates disagree about the same request and the
        # failure looks like a network fault.
        if str(request.method).upper() == "OPTIONS":
            return None
        who = self.current()
        if who.can(capability):
            return None
        resp = jsonify({
            "ok": False,
            "error": "not permitted",
            # Named so the dashboard can say WHICH permission is missing and
            # who to ask for it, instead of a bare "forbidden" that sends the
            # operator to the logs. The capability name is not a secret — the
            # caller is authenticated, and knowing what they lack is the whole
            # content of the refusal.
            "forbidden": {"capability": capability,
                          "profile": who.name,
                          "role": who.role},
        })
        resp.status_code = 403
        return resp

    @staticmethod
    def whoami(profile: "_users.Profile") -> dict:
        """The identity the dashboard renders and derives its panels from.

        Capabilities are published to their own holder deliberately: the page
        has to know which panels to draw, and it is going to find out anyway
        the moment it calls an endpoint. What it must never do is DECIDE
        anything with them — every one of these is enforced server-side, and
        this list is a rendering hint, not a permission.
        """
        return {
            "id": profile.id,
            "name": profile.name,
            "role": profile.role,
            "admin": profile.admin,
            "service": profile.id == _users.SERVICE_PROFILE.id,
            "capabilities": sorted(profile.capabilities()),
            "phi_visible": sorted(profile.phi_visible()),
        }


# ---- Flask wiring -------------------------------------------------------
# Kept here rather than in web.py so the enforcement and the endpoints that
# grant it live in one file; web.py's diff is the install() call.

def set_session_cookie(resp, guard: "AuthGuard", profile) -> Any:
    """Attach a session for *profile* to an already-built response.

    Exists for exactly one caller: the endpoint that turns profiles on. That
    request is the last one its client can make anonymously — enabling profiles
    is what makes a credential mandatory — so it has to hand back the session
    that keeps them logged in, or the operator's reward for switching on access
    control is being locked out of their own dashboard.

    Kept here beside the other cookie code so there is one place that knows the
    flags a session cookie is set with.
    """
    from flask import request
    resp.set_cookie(
        SESSION_COOKIE,
        guard.sessions.issue_profile(profile.id, profile.credential_fingerprint()),
        max_age=guard.sessions.ttl,
        httponly=True,
        samesite="Strict",
        secure=bool(request.is_secure),
        path="/",
    )
    return resp


def install(app, cfg, log=None, ttl: int = SESSION_TTL,
            extra_prefixes: tuple[str, ...] = (), audit_log=None) -> AuthGuard:
    """Register the guard plus /api/auth, /api/login, /api/logout on *app*.

    Returns the AuthGuard so the caller can reach it (tests, a CLI status
    line). Register this BEFORE the X-Carino write guard: an unauthenticated
    write should answer 401-with-a-prompt rather than 403-missing-header, or
    the dashboard shows the wrong recovery path.
    """
    from flask import jsonify, request

    guard = AuthGuard(cfg, log=log, ttl=ttl, extra_prefixes=extra_prefixes)

    def _audit(action: str, **fields) -> None:
        """Record to the trail if there is one. Optional on purpose: the tests
        build this app without a server, and auth has to work without an audit
        sink for the same reason it works without a LogBuffer."""
        if audit_log is None:
            return
        try:
            audit_log.record(action, source=_client_ip(), **fields)
        except Exception:
            pass

    def _client_ip() -> str:
        # remote_addr only. X-Forwarded-For is attacker-controlled when there
        # is no proxy in front of us — and there is not — so trusting it would
        # hand every brute-forcer a fresh rate-limit bucket per request.
        return request.remote_addr or "unknown"

    def _reject(verdict: Verdict):
        resp = jsonify(verdict.body())
        resp.status_code = verdict.status
        if verdict.status == 401:
            resp.headers["WWW-Authenticate"] = 'Bearer realm="Carino DICOM"'
        if verdict.retry_after:
            resp.headers["Retry-After"] = str(verdict.retry_after)
        return resp

    def _set_cookie(resp, value: Optional[str] = None):
        # Secure only over HTTPS: the dashboard is plain HTTP on loopback and
        # on most LAN deployments, and a Secure cookie there is silently never
        # sent — a login that appears to succeed and then 401s every request.
        resp.set_cookie(
            SESSION_COOKIE,
            guard.sessions.issue(guard.token) if value is None else value,
            max_age=guard.sessions.ttl,
            httponly=True,          # keeps the session out of reach of any injected script
            samesite="Strict",      # the API is same-origin; nothing legitimate posts here cross-site
            secure=bool(request.is_secure),
            path="/",
        )
        return resp

    @app.before_request
    def _require_auth():
        verdict = guard.check(method=request.method, path=request.path,
                              headers=request.headers, cookies=request.cookies,
                              client_ip=_client_ip())
        if verdict.ok:
            return None
        return _reject(verdict)

    @app.get("/api/auth")
    def api_auth():
        """Public on purpose: it answers only "is a token required, and am I
        holding one". The 401 body says as much already, and the dashboard
        needs the answer before it can decide whether to prompt."""
        return jsonify(ok=True, auth=guard.status(headers=request.headers,
                                                  cookies=request.cookies))

    @app.get("/api/profiles")
    def api_profiles():
        """The picker's list. Public, and deliberately thin.

        Publishing staff names to anyone who can reach the port is a real
        disclosure, not a hypothetical one, so it is the operator's call:
        users.list_profiles false answers an empty list and the dashboard falls
        back to typing a name. Disabled profiles are never listed either way —
        a button that cannot log in is a support call.
        """
        if not guard.profiles_enabled or not guard.lists_profiles():
            return jsonify(ok=True, profiles=[], listed=False,
                           enabled=guard.profiles_enabled)
        rows = [p.public() for p in _users.enabled_profiles(guard.cfg.users)]
        return jsonify(ok=True, profiles=rows, listed=True, enabled=True)

    @app.post("/api/login")
    def api_login():
        body = request.get_json(silent=True) or {}
        # A profile login and a token login are told apart by which field is
        # present, not by what is configured: an appliance can have both, and a
        # machine client holding the token must keep working while a person at
        # the same box logs in as themselves.
        if body.get("profile"):
            verdict, profile = guard.login_profile(
                str(body.get("profile") or ""), str(body.get("password") or ""),
                _client_ip())
            if not verdict.ok:
                # The id that was tried, never the password, and never a
                # judgement about whether that id exists — the record says what
                # arrived, which is all it can honestly say.
                _audit("login.failed", target=str(body.get("profile") or ""),
                       outcome="denied", reason=verdict.reason)
                return _reject(verdict)
            _audit("login", actor=profile, target=profile.name)
            resp = jsonify(ok=True, auth={**guard.status(),
                                          "authenticated": True,
                                          "who": guard.whoami(profile)})
            return _set_cookie(resp, guard.sessions.issue_profile(
                profile.id, profile.credential_fingerprint()))
        verdict = guard.login(str(body.get("token") or ""), _client_ip())
        if not verdict.ok:
            _audit("login.failed", target="api token", outcome="denied",
                   reason=verdict.reason)
            return _reject(verdict)
        _audit("login", target="api token")
        resp = jsonify(ok=True, auth=guard.status())
        return _set_cookie(resp) if verdict.refresh else resp

    @app.post("/api/logout")
    def api_logout():
        # Recorded BEFORE the cookie is cleared, while there is still a session
        # to say whose it was.
        _audit("logout", actor=guard.identify(headers=request.headers,
                                              cookies=request.cookies))
        resp = jsonify(ok=True)
        resp.delete_cookie(SESSION_COOKIE, path="/", samesite="Strict")
        return resp

    return guard
