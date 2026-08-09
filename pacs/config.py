"""Config load/save + defaults + light validation.

The whole app is configured by one JSON file. By default it lives in
``~/CarinoPACS/config.json`` and the relative folder defaults (``./received``,
``./outgoing``, ``./sent``, ``./logs``) therefore resolve to subfolders of
``~/CarinoPACS`` — so a fresh install keeps everything together in one visible
place in the user's home. Paths are resolved relative to the config file's own
directory (with ``~`` expansion) so they behave predictably no matter the CWD.
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import threading
import time
from typing import Any

# Imported as a module, not as names: users.py holds the profile rules and this
# file holds the document they live in, and the arrow only ever points this way.
# users.py must never import config — the fingerprint helper below and
# validate() both call into it, and a cycle here would break `import pacs`.
from . import users as _users

# Default home for config + data + logs: ~/CarinoPACS
DEFAULT_DIR = os.path.join(os.path.expanduser("~"), "CarinoPACS")
DEFAULT_CONFIG = os.path.join(DEFAULT_DIR, "config.json")

DEFAULTS: dict[str, Any] = {
    "scp": {
        "enabled": False,       # opt-in — off by default; the setup chooser enrolls it
        "aet": "CARINOPACS",
        "bind": "0.0.0.0",
        "port": 11112,
        "storage_dir": "./received",
        "organize": True,
        "min_free_gb": 2,       # refuse C-STORE when the storage volume drops below this (0 = off)
        "allowed_aets": [],
        "tls": False,           # serve DICOM over TLS
        "tls_cert": "",         # server certificate (PEM)
        "tls_key": "",          # server private key (PEM)
        "tls_ca": "",           # if set: require + verify client certs (mutual TLS)
    },
    "scu": {
        "enabled": False,       # opt-in — off by default; the setup chooser enrolls it
        "aet": "CARINOSCU",
        "watch_dir": "./outgoing",
        "poll_interval": 3,
        "on_success": "keep",   # keep | move | delete
        "sent_dir": "./sent",
        "pending_dir": "./pending",  # non-DICOM (PDF/image) files awaiting review+convert
        "tls_verify": True,     # verify the remote server's certificate
        "tls_ca": "",           # CA bundle to verify against ("" = system trust store)
        "tls_cert": "",         # our client certificate for mutual TLS (optional)
        "tls_key": "",          # our client private key (optional)
    },
    "print": {                  # virtual DICOM film printer (capture print-only modalities)
        "enabled": False,       # opt-in — off by default
        "aet": "CARINOPRINT",
        "bind": "0.0.0.0",
        "port": 11113,          # distinct from scp.port (11112)
        "color": False,         # also advertise Basic Color Print Management
        "layout": "pdf",        # how a captured film is stored: pdf (Encapsulated PDF) | image (Secondary Capture)
        "allowed_aets": [],
        "tls": False,
        "tls_cert": "",
        "tls_key": "",
        "tls_ca": "",
    },
    "mwl": {                    # Modality Worklist SCP — serve orders to modalities
        "enabled": False,       # opt-in — off by default
        "aet": "CARINOMWL",
        "bind": "0.0.0.0",
        "port": 11114,          # distinct from scp (11112) and print (11113)
        "allowed_aets": [],
        "tls": False,
        "tls_cert": "",
        "tls_key": "",
        "tls_ca": "",
    },
    "ris": {                    # emergency RIS: HL7/MLLP order intake + manual entry
        "enabled": False,       # opt-in — off by default
        "bind": "0.0.0.0",
        "port": 2575,           # IANA-registered HL7/MLLP port (distinct from the DICOM ports)
        "store_dir": "./ris",   # orders.json lives here
        "match_on": "accession",  # accession | accession_or_patient (Patient-ID fallback)
        "auto_close": True,     # close+archive a matched order automatically on study receipt
        "allowed_hosts": [],    # source IPs allowed to send HL7 (blank = any)
    },
    "qr": {                     # Query/Retrieve SCP — C-FIND, C-MOVE, C-GET over the index
        "enabled": False,       # opt-in — off by default
        "aet": "CARINOQR",
        "bind": "0.0.0.0",
        "port": 11115,          # distinct from scp (11112), print (11113), mwl (11114)
        "allowed_aets": [],
        # C-MOVE names a destination by AE title only, so the SCP has to resolve it
        # itself: calling AE title -> {"host": .., "port": .., "aet": ..}.
        "move_destinations": {},
        "tls": False,
        "tls_cert": "",
        "tls_key": "",
        "tls_ca": "",
    },
    "dicomweb": {               # QIDO-RS / WADO-RS / STOW-RS under /dicom-web
        "enabled": False,       # opt-in — off by default
        "allow_stow": True,     # accept STOW-RS uploads (read-only deployment: turn off)
        # Browser origins allowed to call /dicom-web cross-site, exact match
        # ("https://viewer.example"). Empty = no CORS headers at all, which is
        # what a same-origin viewer and every non-browser client want.
        "cors_origins": [],
    },
    "index": {                  # sqlite instance index — what QR and DICOMweb query
        "enabled": True,
        "path": "./index.db",
        "rescan_on_start": True,  # re-walk storage_dir at startup so files added behind our back are found
    },
    "routing": {                # per-study rules: where a received study is forwarded
        "enabled": False,
        "rules": [],            # see config.example.json for the rule shape
    },
    "deid": {                   # de-identification applied when a rule asks for it
        "profile": "basic",     # basic | strict | off
        "keep_private": False,  # keep private tags (they routinely carry identifiers)
        "keep_dates": False,    # keep study/series/acquisition dates unshifted
        "prefix": "ANON",       # stem for generated patient names / IDs
    },
    "emergency": {              # failover: watch primary destination(s), prompt to activate
        "armed": False,         # is the health monitor running / failover armed?
        "probe_interval_sec": 30,   # how often to C-ECHO each emergency_trigger destination
        "offline_threshold_sec": 120,  # continuous-failure duration before triggering
        "recovery_successes": 2,    # consecutive good probes to declare a primary back
        "auto_activate": False,     # False = pop up + ask; True = start emergency services automatically
        "hold_and_forward": True,   # while active, auto-queue received studies for the primary
        # WHO may press the button, declared by the administrator. Entries are
        # "role:radiologist" or a profile id. EMPTY means anyone holding the
        # emergency.activate capability, which is the behaviour every existing
        # install already has — so an upgrade narrows nothing until somebody
        # decides to. Setting auto_activate is the third option: nobody presses
        # it, the appliance does.
        "activate_by": [],
        # WHO is told. Same spelling, same empty-means-everyone rule. This is
        # separate from activate_by on purpose: the receptionist needs to know
        # the RIS is down so they can start keying orders, and must not be the
        # one deciding to fail over.
        "notify": [],
    },
    "notify": {                 # reach people who do not have the dashboard open
        "enabled": False,       # opt-in — nothing leaves this box until asked
        "webhook": {
            "enabled": False,
            "url": "",
            # Shared with the receiver so it can tell a genuine POST from anyone
            # who learned the URL. Sent as an HMAC over the exact body, in
            # X-Carino-Signature. Treated as a secret: redacted from
            # GET /api/config and covered by version(), like the other two.
            "secret": "",
            "timeout_sec": 10,
            "retries": 2,
        },
        "smtp": {
            "enabled": False,
            "host": "",
            "port": 587,
            "tls": "starttls",  # starttls | ssl | none
            "username": "",
            "password": "",     # a secret, treated as one — see above
            "from": "",
        },
    },
    "audit": {                  # who did what — append-only and hash-chained
        "enabled": True,        # on by default: "there is no audit trail" is the gap this closes
        "dir": "./audit",
        "max_bytes": 8388608,   # rotate at 8 MB (~40k records)
        # Recording every study anyone opens answers "who viewed this patient",
        # which some jurisdictions require and which multiplies the size of the
        # trail by how often people refresh a dashboard. The operator decides.
        "log_reads": False,
        # fsync each record. Slow by design and correct for this file: a record
        # still in the page cache when the machine loses power is a record that
        # did not happen. It fires on deliberate actions, not per instance.
        "fsync": True,
    },
    "destinations": [],
    # The modalities this department has — the equipment that PULLS a worklist
    # and PUSHES studies back, as opposed to `destinations`, which is where
    # studies are forwarded ON to. Each entry is one station:
    #   {"name": "ER CT", "aet": "CT_ER_01", "modality": "CT",
    #    "station_name": "", "enabled": true}
    # An order's station_aet is chosen from this list rather than typed. A
    # mistyped AE title is not a cosmetic error: the worklist matches it
    # exactly, so the order appears on NO station for a modality that queries
    # with its own AE, and on EVERY station for one that queries with the key
    # empty. Same typo, opposite failures, decided by the vendor.
    "modalities": [],
    "users": {                  # who may use the dashboard, and what they may do
        # EMPTY = profiles are not in use and web.auth_token alone governs
        # access, which is exactly how every install that predates this feature
        # behaves. Seeded with four editable presets when the operator turns
        # profiles on; see pacs/users.py.
        "profiles": [],
        # Show the profile buttons before anyone has logged in. True is the
        # kiosk case this was built for — a shared front-desk machine where you
        # tap your name and type a password. It does publish the staff list to
        # anyone who can reach the port, so a site that binds off-box and cares
        # about that sets this false and gets a name-and-password form instead.
        "list_profiles": True,
    },
    "web": {
        "host": "127.0.0.1",
        "port": 8042,
        "editor_url": "/editor/",   # DICOM-editor for ✎ Edit; "/editor/" = the bundled same-origin copy, or a full URL, or "" to hide
        "auth_token": "",       # "" = no auth, allowed ONLY while host is loopback; non-empty = required on every /api call
    },
    "logs_dir": "./logs",       # dated log files (one per day) live here
    "setup_completed": "",      # UTC stamp of the run that finished the service chooser; "" = never, so the chooser is offered
}

_PATH_FIELDS = [("scp", "storage_dir"), ("scu", "watch_dir"), ("scu", "sent_dir"),
                ("scu", "pending_dir"), ("ris", "store_dir"), ("index", "path"),
                ("audit", "dir")]

_LOOPBACK_NAMES = ("localhost", "localhost.localdomain", "ip6-localhost")

# Scratch files a save writes beside the config, before renaming over it. The
# shape is the one the rest of the tree already writes and .dockerignore already
# excludes (*.tmp.*): a temp that vanishes mid-COPY fails an image build.
_TMP_PREFIX = ".tmp."
# A save takes milliseconds. Anything wearing our scratch prefix and an hour of
# age belongs to a process that was killed mid-save, so it is safe to remove —
# and picking an interval no live save can be inside of is what keeps the sweep
# from deleting a temp another thread is about to rename.
_TMP_STALE_SEC = 3600


class ConfigError(ValueError):
    """The config file exists but cannot be used.

    A ValueError on purpose: everything that already handles a bad config —
    cmd_serve, the dashboard's save path — catches ValueError, and a file that
    will not parse is the same class of problem as one that will not validate.
    What it adds is a message an operator can act on, in place of
    json's "Expecting value: line 1 column 1 (char 0)".
    """


def is_loopback_host(host: str) -> bool:
    """True when binding to *host* only exposes a service to this machine.

    The dashboard API is unauthenticated by default, so this is the switch that
    decides whether web.auth_token is mandatory. It fails closed: anything we
    cannot parse — including "" and "0.0.0.0", which bind every interface — is
    reported as network-reachable rather than assumed safe.
    """
    h = str(host or "").strip().lower()
    if h in _LOOPBACK_NAMES:
        return True
    if h.startswith("[") and h.endswith("]"):   # bracketed IPv6 literal, "[::1]"
        h = h[1:-1]
    h = h.split("%", 1)[0]                      # drop an IPv6 zone id, "fe80::1%eth0"
    try:
        addr = ipaddress.ip_address(h)
    except ValueError:
        return False
    # ::ffff:127.0.0.1 is a loopback address wearing an IPv6 costume; ipaddress
    # only tests ::1/128 for IPv6, so unwrap the mapping before asking.
    mapped = getattr(addr, "ipv4_mapped", None)
    if mapped is not None:
        addr = mapped
    return addr.is_loopback


def web_host_of(web: Any) -> str:
    """The address the dashboard binds, as every reader must see it.

    One coercion, so the security gate and the code that actually binds can
    never disagree about what "the host" is. A missing key means the DEFAULTS
    value (127.0.0.1) is what will be bound after the merge, so that is what
    callers reading a raw, unmerged config file must be told too.
    """
    if not isinstance(web, dict):
        return DEFAULTS["web"]["host"]
    host = web.get("host", DEFAULTS["web"]["host"])
    if not isinstance(host, str):
        # Not a hostname; is_loopback_host fails it closed and that is the
        # answer we want to hand every caller, identically.
        return ""
    return host.strip()


def auth_token_of(web: Any) -> str:
    """The configured dashboard token, or "" when there is none.

    One coercion for every reader — validate()'s security gate, auth.AuthGuard,
    the CLI's serve gate, the container entrypoint. They used to disagree, and
    the disagreement was exploitable: str(x) turned a JSON 0 / false / null into
    the non-empty "0" / "False" / "None" and satisfied "you must set a token",
    while str(x or "") turned the same value into "" and the guard enforced
    nothing. A non-string is not a token, so here it is no token to everybody,
    and validate() rejects it outright rather than let it look like one.
    """
    if not isinstance(web, dict):
        return ""
    token = web.get("auth_token", "")
    if not isinstance(token, str):
        return ""
    return token.strip()


# The two secrets under notify, as (section, field). Named once so version(),
# the redactor in web.py and notify_secrets_of() cannot drift apart — a secret
# one of them knows about and another does not is a secret that leaks through
# whichever one forgot.
_NOTIFY_SECRETS = (("webhook", "secret"), ("smtp", "password"))


def notify_secrets_of(notify: Any) -> dict:
    """The two secrets under ``notify``, as {path: value}, "" when unset.

    Same one-coercion rule as auth_token_of and deid_secret_of, and the same
    reason: three readers have to agree about whether a secret is configured —
    the redactor that keeps it out of GET /api/config, version() which has to
    detect it changing, and the notifier that uses it. A non-string is not a
    secret, so it is no secret to all three.
    """
    out = {"notify.webhook.secret": "", "notify.smtp.password": ""}
    if not isinstance(notify, dict):
        return out
    wh = notify.get("webhook")
    if isinstance(wh, dict) and isinstance(wh.get("secret"), str):
        out["notify.webhook.secret"] = wh["secret"].strip()
    sm = notify.get("smtp")
    if isinstance(sm, dict) and isinstance(sm.get("password"), str):
        # NOT stripped. A password whose leading or trailing space is
        # significant is a password somebody chose, and silently trimming it
        # here would make the login fail with no explanation anywhere.
        out["notify.smtp.password"] = sm["password"]
    return out


def deid_secret_of(deid: Any) -> str:
    """The de-identification site key, or "" when there is none.

    The same one-coercion rule as auth_token_of, for the same reason: this key
    is what makes the pseudonyms unguessable, so every reader — the redactor in
    web.py, the dashboard's "a key is set" mirror, the sender that builds the
    Deidentifier — has to agree on whether one is configured. A non-string is
    not a key (Deidentifier would blow up on .encode() mid-forward), so here it
    is no key to everybody, and validate() refuses it outright.
    """
    if not isinstance(deid, dict):
        return ""
    secret = deid.get("secret", "")
    if not isinstance(secret, str):
        return ""
    return secret.strip()


# Keys the secret fingerprints that go into Config.version(). Random, per
# process, never written down and never sent anywhere.
#
# version() has to COVER web.auth_token and deid.secret — a rotation changes the
# stored document, and a fingerprint that cannot see the change cannot refuse a
# Save built before it. But version() is published as an ETag to every holder of
# a session COOKIE, and a cookie is deliberately not enough to read either
# secret (see _holds_the_token in web.py). A plain digest of the raw value would
# hand exactly that caller an offline oracle: guess a token, hash, compare, and
# a 12-character operator-chosen one falls to a wordlist in seconds.
#
# Keying it closes that. Without the key a guess cannot be confirmed, so the
# fingerprint proves only "this changed" — which is all If-Match ever asks. It
# is the same move the session cookie already makes with the same value (a
# keyed fingerprint of the token, under a secret generated at startup), for the
# same reason and with the same restart-scoped consequence. The
# cost is that the version is not stable across a restart: a dashboard holding
# an ETag from before one is told to reload. That is the honest answer anyway
# (the process it loaded from is gone, and config.json may have been hand-edited
# while it was down), and it is the cheap half of the trade.
_VERSION_KEY = secrets.token_bytes(32)


def _secret_fingerprint(label: str, value: str) -> str:
    """A stand-in for a secret inside the version hash: reveals only change.

    Labelled so two fields holding the SAME value do not fingerprint the same
    and betray that they match.
    """
    return hmac.new(_VERSION_KEY, f"{label}\0{value}".encode("utf-8"),
                    hashlib.sha256).hexdigest()[:16]


def _whoami() -> str:
    """Which account is reading the file, for a permission error's message.

    A config unreadable under systemd or docker is almost always owned by the
    operator and read by a service user, and naming that user is the whole
    difference between "chmod something" and "chown it to this". Best effort:
    getuser() raises when there is no passwd entry (a scratch container), and a
    diagnostic must never be what stops the diagnosis.
    """
    try:
        import getpass
        return getpass.getuser()
    except Exception:
        uid = getattr(os, "getuid", None)
        return f"uid {uid()}" if uid else "this account"


def _fsync_dir(directory: str) -> None:
    """Make the rename itself survive a power cut, where the platform allows it.

    os.replace is atomic for anyone reading the file, but the directory entry
    can still be sitting in a cache when the machine loses power — which is how
    a config that was saved an hour ago comes back missing. Best effort: Windows
    cannot open a directory, and some filesystems refuse the fsync, and neither
    is a reason to fail a save that already landed.
    """
    try:
        fd = os.open(directory, getattr(os, "O_DIRECTORY", 0) | os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _deep_merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


class Config:
    def __init__(self, path: str):
        self.path = os.path.abspath(path)
        # Serialises every read-modify-write that goes through this object. The
        # dashboard is Werkzeug with threaded=True, so POST /api/config, the
        # token endpoint, the de-id key endpoint and emergency arm/disarm can all
        # be inside a config write at the same instant. See mutate().
        self._lock = threading.RLock()
        self.data: dict[str, Any] = copy.deepcopy(DEFAULTS)
        self.load()

    # ---- persistence -------------------------------------------------------
    def load(self) -> "Config":
        # DELIBERATELY NOT validate()d, and this is the third time it has been
        # noticed, so here is the reasoning. validate() guards the WRITE path —
        # POST /api/config, the setup chooser, the CLI — where a refusal costs
        # the operator one corrected keystroke and nothing else. On the READ
        # path a refusal costs the department the PACS: `pacs serve` would exit,
        # the receiver would not bind, modalities would get connection refused,
        # and the dashboard — the only tool the operator has for FIXING the
        # config — would be the thing that will not start. A config that is
        # merely questionable (a mistyped AE title, a port two services share)
        # is a far smaller harm than a dark receiver, and the file being read
        # here has usually been hand-edited by someone who is already in a
        # hurry.
        #
        # What is NOT tolerated on this path is a file that cannot be read as a
        # document at all: _parse raises ConfigError rather than fall back to
        # DEFAULTS, because guessing there silently turns services off.
        #
        # The gap that leaves — a hand-edited config.json is used unvalidated —
        # is closed by SAYING so instead of by refusing: PacsServer logs the
        # validation error at startup and carries on, so the operator sees the
        # exact complaint in the Activity log with a running dashboard to fix it
        # in. Anything that reverses this decision has to answer the question
        # "how does the operator repair the config once we refuse to start".
        #
        # No os.path.exists() pre-check: between the check and the open, the
        # answer can change (our own save renames over this path), and the
        # missing-file case is exactly what FileNotFoundError already says.
        with self._lock:
            try:
                with open(self.path, "r", encoding="utf-8") as fh:
                    text = fh.read()
            except FileNotFoundError:
                self.data = copy.deepcopy(DEFAULTS)
                return self
            except UnicodeDecodeError as exc:
                # A file half-overwritten with binary, or a config someone saved
                # from a Windows editor in UTF-16. Same class as unparseable
                # JSON, and it used to reach the operator as a raw traceback.
                raise ConfigError(
                    f"{self.path} is not readable as UTF-8 text ({exc.reason} at byte "
                    f"{exc.start}) — the file is corrupted, not merely mis-edited. {self._hint()}"
                ) from exc
            except OSError as exc:
                # Every other way the file exists but will not open: a directory
                # at that path, a permission the service account does not have,
                # a broken path component. Guessing DEFAULTS here is the same
                # unsafe fallback _parse refuses, so say which one it was and stop.
                raise ConfigError(
                    f"{self.path} cannot be read: {exc.strerror or exc} — check that the path is "
                    f"a file (not a directory) and that this account can read it "
                    f"(running as {_whoami()}). {self._hint()}"
                ) from exc
            self.data = _deep_merge(DEFAULTS, self._parse(text))
        return self

    def _hint(self) -> str:
        """The way out, in one sentence, appended to every unusable-config error."""
        return (f"Restore your backup of {self.path}, or delete the file and run "
                f"`python -m pacs -c {self.path} init` to scaffold a fresh one "
                f"(you will have to re-enter web.auth_token and deid.secret).")

    def version(self) -> str:
        """A fingerprint of the config a dashboard Save is allowed to change.

        POST /api/config posts a whole document assembled from a page-load
        snapshot, so two tabs editing different sections both save cleanly and
        the later one silently reverts the earlier. A client that carries this
        value back can be told it is working from a stale copy instead.

        Derived rather than stored: a counter in the file would be lost the
        moment someone edits config.json by hand, which is exactly when a stale
        Save does the most damage.

        The two secrets used to be folded in as BOOLEANS, on the reasoning that
        they cannot be set through that endpoint so a rotation need not
        invalidate an open Save. That reasoning had a hole in it, and it was the
        expensive kind: the endpoint re-asserted the stored secrets from a read
        taken outside the lock, so a rotation landing in the gap was reverted by
        the Save — and this fingerprint, blind to both values, could not refuse
        that Save either. The one mechanism built to catch a silent revert was
        blind to the two values most worth protecting. Both halves are fixed:
        the endpoint now merges under mutate(), and the secrets are covered here
        through _secret_fingerprint(), which is keyed so covering them cannot
        turn this string into a brute-force oracle. Read the note on
        _VERSION_KEY before changing either.
        """
        with self._lock:
            doc = copy.deepcopy(self.data)
        web = doc.get("web")
        if isinstance(web, dict):
            web["auth_token"] = _secret_fingerprint("web.auth_token", auth_token_of(web))
        deid = doc.get("deid")
        if isinstance(deid, dict):
            deid["secret"] = _secret_fingerprint("deid.secret", deid_secret_of(deid))
        # The notifier's two secrets, for the same reason and by the same rule:
        # a webhook signing key or an SMTP password that changes has to move
        # this fingerprint, or a Save assembled before the change puts the old
        # one back and If-Match cannot refuse it.
        notify = doc.get("notify")
        if isinstance(notify, dict):
            secrets_now = notify_secrets_of(notify)
            for section, field in _NOTIFY_SECRETS:
                block = notify.get(section)
                if isinstance(block, dict) and field in block:
                    path = f"notify.{section}.{field}"
                    block[field] = _secret_fingerprint(path, secrets_now[path])
        # Password records, for both halves of the same reason the two secrets
        # above are here. They have to be COVERED, or a Save assembled before
        # somebody changed their password silently puts the old one back and
        # If-Match cannot tell. And they cannot be covered RAW, because this
        # string is published as an ETag to every holder of a session cookie
        # and the stored hash is a PBKDF2 output — handing that to a caller who
        # is not allowed to read it is an offline cracking target, which is the
        # exact mistake the token made. Keyed fingerprint, labelled per profile
        # so two people who chose the same password do not match here.
        users = doc.get("users")
        if isinstance(users, dict) and isinstance(users.get("profiles"), list):
            for row in users["profiles"]:
                if isinstance(row, dict) and isinstance(row.get("password"), dict):
                    row["password"] = _secret_fingerprint(
                        f"users.password.{row.get('id', '')}",
                        _users.password_fingerprint(row["password"]))
        # sort_keys so key order in the file cannot change the fingerprint;
        # default=str so a value nothing else validates can never make asking
        # for the version raise.
        payload = json.dumps(doc, sort_keys=True, separators=(",", ":"), default=str)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]

    def _parse(self, text: str) -> dict:
        """The config file's text as a dict, or ConfigError saying why not.

        Falling back to DEFAULTS here would be the worse failure: a config that
        lost scp.enabled starts a PACS with no receiver, and every modality
        pushing to it gets a connection refused for a reason the dashboard shows
        as "all good". Nothing about this file is recoverable by guessing, so
        say what is wrong and stop.
        """
        hint = self._hint()
        if not text.strip():
            raise ConfigError(
                f"{self.path} is empty ({len(text)} bytes) — it holds no settings at all. "
                f"Refusing to start on the defaults, which would leave the receiver off and "
                f"lose every study sent here. {hint}"
            )
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ConfigError(
                f"{self.path} is not valid JSON: {exc}. The usual cause is a half-written file "
                f"(a crash or a power cut mid-save) or a hand edit with a trailing comma. {hint}"
            ) from exc
        if not isinstance(raw, dict):
            raise ConfigError(
                f"{self.path} must contain a JSON object ({{...}}), not a "
                f"{type(raw).__name__}. {hint}"
            )
        return raw

    def save(self) -> None:
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, exist_ok=True)
        with self._lock:
            # Serialised to text first, and under the lock: dumping straight
            # into the file let a concurrent writer change self.data halfway
            # through the document, and made the write itself long enough for
            # two savers to interleave inside it.
            payload = json.dumps(self.data, indent=2)
            self._sweep_temps(directory)
            tmp = self._write_temp(directory, payload)
            # Atomic because tmp is in the config's own directory: a reader
            # (another `pacs serve` starting up) sees the whole old file or the
            # whole new one, never a partial write.
            os.replace(tmp, self.path)
            _fsync_dir(directory)

    def _write_temp(self, directory: str, payload: str) -> str:
        """Write payload to a fresh scratch file beside the config; return its path.

        This file holds web.auth_token and deid.secret in plaintext — the shared
        secret for the whole dashboard API and the site key behind every
        pseudonym. Written through open() it landed 0644, readable by every
        unprivileged account on the box. os.replace keeps the temp file's mode,
        so creating the temp at 0600 is what makes the config 0600.

        The name carries the pid (so litter names the process that left it) and
        random bytes (so two threads in that process cannot collide either). It
        used to be config.json.tmp for everybody: two concurrent savers shared
        one temp, and one unlinked the other's file mid-write. os.replace then
        raised FileNotFoundError, or renamed an unfinished temp over config.json
        and left the next `pacs serve` reading a zero-byte file — a PACS that
        will not start because two people pressed Save. Unpredictability is
        also the better half of the symlink defence, but O_NOFOLLOW stays: it is
        what makes "we only ever write a file we created ourselves" true rather
        than likely. With O_EXCL that also means the mode O_CREAT applies is the
        mode the config ends up with — no fchmod fixup needed.
        """
        base = os.path.basename(self.path)
        for _ in range(8):
            tmp = os.path.join(
                directory, f"{base}{_TMP_PREFIX}{os.getpid()}.{secrets.token_hex(8)}")
            try:
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                             | getattr(os, "O_NOFOLLOW", 0), 0o600)  # O_NOFOLLOW is POSIX-only
            except FileExistsError:
                continue        # 64 random bits collided, or someone is guessing: pick another
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    fh.write(payload)
                    fh.flush()
                    # Before the rename, always: without it the directory entry
                    # can reach the disk ahead of the bytes, and a power cut
                    # leaves a config.json that exists and is empty.
                    os.fsync(fh.fileno())
            except BaseException:
                # Never leave our own litter behind: the sweep only collects
                # files old enough to be certain they are abandoned, so a temp
                # dropped here would sit in the config directory for an hour.
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            return tmp
        raise OSError(f"could not create a temporary file next to {self.path}")

    def _sweep_temps(self, directory: str) -> None:
        """Clear out scratch files left by a save that was killed mid-flight.

        Age-gated on purpose: a temp belonging to a save happening right now
        must not be removed, or that saver's os.replace fails — the very bug
        this rewrite is fixing. Nothing here follows a link: unlink removes the
        LINK, never its target, and lstat does not resolve one either.
        """
        base = os.path.basename(self.path)
        # Older versions wrote a fixed <config>.tmp. It is never ours now, so it
        # is always abandoned — and it is the one name an attacker could have
        # predicted well enough to plant a symlink at. Sweeping it disarms the
        # plant rather than following it.
        stale = [self.path + ".tmp"]
        cutoff = time.time() - _TMP_STALE_SEC
        try:
            for name in os.listdir(directory):
                if not name.startswith(base + _TMP_PREFIX):
                    continue
                path = os.path.join(directory, name)
                try:
                    if os.lstat(path).st_mtime < cutoff:
                        stale.append(path)
                except OSError:
                    pass
        except OSError:
            pass        # unreadable directory: the open in _write_temp reports it
        for path in stale:
            try:
                os.unlink(path)
            except OSError:
                pass    # gone already, or not ours to remove — neither blocks a save

    def mutate(self):
        """Hold the config still across a read-modify-write.

        ``with cfg.mutate(): cfg.web["auth_token"] = value; cfg.save()``

        A unique temp name stops two savers from destroying the file, but it
        does not stop the second one from silently discarding the first one's
        change: both saves succeed and the last writer wins. Any caller that
        reads a value out of cfg.data, changes it and saves — the token
        endpoint, the de-id key endpoint, emergency arm/disarm — has to run that
        whole sequence under this, or a concurrent replace() can swap self.data
        out from under it between the change and the save.
        """
        return self._lock

    def replace(self, new_data: dict) -> "Config":
        """Validate + persist a full config object coming from the dashboard."""
        # One critical section for validate + swap + write: a second POST
        # arriving mid-way must not be able to save a document that never
        # existed in memory.
        with self.mutate():
            merged = _deep_merge(DEFAULTS, new_data)
            validate(merged)
            self.data = merged
            self.save()
        return self

    def would_accept(self, new_data: dict) -> None:
        """Validate a candidate config without applying it (raises ValueError)."""
        validate(_deep_merge(DEFAULTS, new_data))

    # ---- convenient views --------------------------------------------------
    @property
    def scp(self) -> dict:
        return self.data["scp"]

    @property
    def scu(self) -> dict:
        return self.data["scu"]

    @property
    def web(self) -> dict:
        return self.data["web"]

    @property
    def printer(self) -> dict:
        return self.data["print"]

    @property
    def mwl(self) -> dict:
        return self.data["mwl"]

    @property
    def ris(self) -> dict:
        return self.data["ris"]

    @property
    def qr(self) -> dict:
        return self.data["qr"]

    @property
    def dicomweb(self) -> dict:
        return self.data["dicomweb"]

    @property
    def index(self) -> dict:
        return self.data["index"]

    @property
    def routing(self) -> dict:
        return self.data["routing"]

    @property
    def deid(self) -> dict:
        return self.data["deid"]

    @property
    def emergency(self) -> dict:
        return self.data["emergency"]

    @property
    def users(self) -> dict:
        return self.data["users"]

    @property
    def audit(self) -> dict:
        return self.data["audit"]

    @property
    def destinations(self) -> list[dict]:
        return self.data["destinations"]

    def enabled_destinations(self) -> list[dict]:
        return [d for d in self.destinations if d.get("enabled", True)]

    @property
    def modalities(self) -> list:
        return self.data.setdefault("modalities", [])

    def enabled_modalities(self) -> list[dict]:
        return [m for m in self.modalities if m.get("enabled", True)]

    @property
    def logs_dir(self) -> str:
        """Absolute path of the dated-log folder."""
        return self.resolve_path(self.data.get("logs_dir", "./logs"))

    def resolved(self, section: str, field: str) -> str:
        """Absolute path for a path field, relative to the config file dir."""
        return self.resolve_path(self.data[section][field])

    def resolve_path(self, value: str) -> str:
        """Absolute path for a possibly-relative file path ('~' expanded); '' stays ''."""
        if not value:
            return ""
        value = os.path.expanduser(value)
        if os.path.isabs(value):
            return os.path.normpath(value)
        base = os.path.dirname(self.path)
        return os.path.normpath(os.path.join(base, value))


def _check_bools(data: dict) -> None:
    """Every flag DEFAULTS declares as a boolean has to arrive as one.

    The same shape as the auth_token confusion, one type down: nothing checked
    these, and every reader is a plain truthiness test, so a JSON *string*
    "false" reads as TRUE everywhere. That is not a cosmetic mismatch —
    deid.keep_private: "false" keeps the private tags, which routinely carry the
    patient's name, in a study the operator believes is de-identified. Driven
    off DEFAULTS rather than a list, so a flag added there is covered the day it
    lands.
    """
    for section, defaults in DEFAULTS.items():
        if not isinstance(defaults, dict):
            continue
        got = data.get(section)
        if not isinstance(got, dict):
            continue
        for key, default in defaults.items():
            if not isinstance(default, bool) or key not in got:
                continue
            if not isinstance(got[key], bool):
                raise ValueError(
                    f"{section}.{key} must be true or false, not {type(got[key]).__name__} "
                    f"({got[key]!r}). A quoted \"false\" is a non-empty string, which reads as "
                    f"TRUE — this would turn {section}.{key} on."
                )


# The two string fields that are checked by hand further down, with a message
# about what they ARE rather than about their type. Skipped by _check_strings so
# the operator gets that message and not the generic one. (deid.secret is not in
# DEFAULTS at all — an absent key is "no site key" — so it never reaches here.)
_BESPOKE_STRINGS = {("web", "auth_token")}


def _check_strings(data: dict) -> None:
    """Every field DEFAULTS declares as a string has to arrive as one.

    Same shape as the flags above, one type sideways, and the same reason to
    hunt the pattern instead of the instance: a string field here is READ by
    calling a string method on it, so the wrong type does not misbehave — it
    raises, at a distance from the edit that made it. deid.prefix was the
    measured one (POST /api/config with a JSON number answered 200 and
    persisted it; Deidentifier.__init__ then died on ``(5 or "ANON").strip()``
    partway through the first forward that scrubs), and it sat one line under a
    comment saying exactly that about deid.secret. The rest fail identically:
    every path goes through os.path.expanduser (TypeError), web.editor_url
    through ``(x or "").strip()``, an AE title into pynetdicom.

    Driven off DEFAULTS rather than a list, so a field added there is covered
    the day it lands — including the top-level ones (logs_dir,
    setup_completed), which the flag check above cannot see.
    """
    def refuse(name: str, value) -> None:
        raise ValueError(
            f"{name} must be a string, not {type(value).__name__} ({value!r}). It is read as "
            f"text — a number or true/false raises inside the service that uses it, long "
            f"after this save was accepted. Quote it, or leave it out for the default."
        )

    for section, defaults in DEFAULTS.items():
        if isinstance(defaults, str):
            if section in data and not isinstance(data[section], str):
                refuse(section, data[section])
            continue
        if not isinstance(defaults, dict):
            continue
        got = data.get(section)
        if not isinstance(got, dict):
            continue
        for key, default in defaults.items():
            if not isinstance(default, str) or key not in got:
                continue
            if (section, key) in _BESPOKE_STRINGS:
                continue
            if not isinstance(got[key], str):
                refuse(f"{section}.{key}", got[key])


def _dest_label(d: dict) -> str:
    """How a destination row is named back to the operator in an error.

    The name on its own cannot identify a row in the one error where it matters
    (two rows carrying the SAME name), so this is what the operator can actually
    search config.json for: 'PACS' at 10.0.0.5:104 AE ARCHIVE.
    """
    return f"'{d.get('name')}' at {d.get('host')}:{d.get('port')} AE {d.get('aet')}"


def validate(data: dict) -> None:
    """Raise ValueError on anything that would make the app misbehave."""
    for section in ("scp", "scu", "web"):
        if not isinstance(data.get(section), dict):
            raise ValueError(f"'{section}' must be an object")
    _check_bools(data)
    _check_strings(data)

    # The scp checks below are deliberately unconditional — they do NOT look at
    # scp.enabled. A config that only validates while the receiver is off would
    # explode the moment the setup chooser enrolls it, and the scp port stays
    # reserved (print/mwl/ris are checked against it) whether it is bound or not.
    p = data["scp"]["port"]
    if not (isinstance(p, int) and 1 <= p <= 65535):
        raise ValueError("scp.port must be 1..65535")
    if not str(data["scp"]["aet"]).strip():
        raise ValueError("scp.aet is required")
    if len(str(data["scp"]["aet"])) > 16 or len(str(data["scu"]["aet"])) > 16:
        raise ValueError("AE titles must be 16 characters or fewer")
    if data["scu"]["on_success"] not in ("keep", "move", "delete"):
        raise ValueError("scu.on_success must be keep|move|delete")
    try:
        if float(data["scu"]["poll_interval"]) < 1:
            raise ValueError
    except (TypeError, ValueError):
        raise ValueError("scu.poll_interval must be a number >= 1")

    if data["scp"].get("tls"):
        if not str(data["scp"].get("tls_cert", "")).strip() or not str(data["scp"].get("tls_key", "")).strip():
            raise ValueError("scp.tls is on but tls_cert / tls_key are not set")

    pr = data.get("print")
    if pr is not None:
        if not isinstance(pr, dict):
            raise ValueError("'print' must be an object")
        pp = pr.get("port", 11113)
        if not (isinstance(pp, int) and 1 <= pp <= 65535):
            raise ValueError("print.port must be 1..65535")
        if len(str(pr.get("aet", ""))) > 16:
            raise ValueError("print.aet must be 16 characters or fewer")
        if pr.get("layout", "pdf") not in ("pdf", "image", "secondary_capture", "sc"):
            raise ValueError("print.layout must be 'pdf' or 'image'")
        if pr.get("tls") and (not str(pr.get("tls_cert", "")).strip() or not str(pr.get("tls_key", "")).strip()):
            raise ValueError("print.tls is on but tls_cert / tls_key are not set")

    mwl = data.get("mwl")
    if mwl is not None:
        if not isinstance(mwl, dict):
            raise ValueError("'mwl' must be an object")
        mp = mwl.get("port", 11114)
        if not (isinstance(mp, int) and 1 <= mp <= 65535):
            raise ValueError("mwl.port must be 1..65535")
        if len(str(mwl.get("aet", ""))) > 16:
            raise ValueError("mwl.aet must be 16 characters or fewer")
        if mwl.get("tls") and (not str(mwl.get("tls_cert", "")).strip() or not str(mwl.get("tls_key", "")).strip()):
            raise ValueError("mwl.tls is on but tls_cert / tls_key are not set")

    ris = data.get("ris")
    if ris is not None:
        if not isinstance(ris, dict):
            raise ValueError("'ris' must be an object")
        rp = ris.get("port", 2575)
        if not (isinstance(rp, int) and 1 <= rp <= 65535):
            raise ValueError("ris.port must be 1..65535")
        if ris.get("match_on", "accession") not in ("accession", "accession_or_patient"):
            raise ValueError("ris.match_on must be 'accession' or 'accession_or_patient'")
        if not isinstance(ris.get("allowed_hosts", []), list):
            raise ValueError("ris.allowed_hosts must be a list")

    qr = data.get("qr")
    if qr is not None:
        if not isinstance(qr, dict):
            raise ValueError("'qr' must be an object")
        qp = qr.get("port", 11115)
        if not (isinstance(qp, int) and 1 <= qp <= 65535):
            raise ValueError("qr.port must be 1..65535")
        if len(str(qr.get("aet", ""))) > 16:
            raise ValueError("qr.aet must be 16 characters or fewer")
        if not isinstance(qr.get("allowed_aets", []), list):
            raise ValueError("qr.allowed_aets must be a list")
        # C-MOVE resolves a destination AE title through this map. A non-object
        # here would blow up inside the move handler mid-transfer instead of here.
        mv = qr.get("move_destinations", {})
        if not isinstance(mv, dict):
            raise ValueError("qr.move_destinations must be an object of AE title -> {host, port, aet}")
        for ae, dest in mv.items():
            if not isinstance(dest, dict):
                raise ValueError(f"qr.move_destinations['{ae}'] must be an object with host / port / aet")
            for key in ("host", "port", "aet"):
                if key not in dest:
                    raise ValueError(f"qr.move_destinations['{ae}'] missing '{key}'")
            if not (isinstance(dest["port"], int) and 1 <= dest["port"] <= 65535):
                raise ValueError(f"qr.move_destinations['{ae}'] has an invalid port")
            if len(str(dest["aet"])) > 16:
                raise ValueError(f"qr.move_destinations['{ae}'] AE title too long")
        if qr.get("tls") and (not str(qr.get("tls_cert", "")).strip() or not str(qr.get("tls_key", "")).strip()):
            raise ValueError("qr.tls is on but tls_cert / tls_key are not set")

    # Every listener binds on the same machine, so no two may claim one port.
    # Disabled services are skipped — parking two of them on the same number is
    # harmless — except scp, whose port stays reserved whether or not the
    # receiver is bound, so that enrolling it from the setup chooser can never
    # fail to bind against a service the operator already had running.
    taken: dict[int, str] = {}
    for name, section, default, always in (("scp", data["scp"], 11112, True),
                                           ("print", data.get("print"), 11113, False),
                                           ("mwl", data.get("mwl"), 11114, False),
                                           ("qr", data.get("qr"), 11115, False),
                                           ("ris", data.get("ris"), 2575, False)):
        if not isinstance(section, dict) or not (always or section.get("enabled")):
            continue
        port = section.get("port", default)
        if not isinstance(port, int):
            continue
        if port in taken:
            raise ValueError(f"{taken[port]}.port and {name}.port are both {port} — "
                             "every enabled listener needs its own port")
        taken[port] = name

    idx = data.get("index")
    if idx is not None and not isinstance(idx, dict):
        raise ValueError("'index' must be an object")

    dw = data.get("dicomweb")
    if dw is not None:
        if not isinstance(dw, dict):
            raise ValueError("'dicomweb' must be an object")
        # The blueprint exact-matches a browser's Origin against this list. A
        # non-list (or a list holding an int) would throw inside the CORS check
        # on a live request instead of here, and the failure mode is a viewer
        # that cannot load studies for a reason nothing explains.
        co = dw.get("cors_origins", [])
        if not isinstance(co, list) or not all(isinstance(x, str) for x in co):
            raise ValueError("dicomweb.cors_origins must be a list of origin strings "
                             "like \"https://viewer.example\" (scheme + host, no path)")

    rt = data.get("routing")
    if rt is not None:
        if not isinstance(rt, dict):
            raise ValueError("'routing' must be an object")
        rules = rt.get("rules", [])
        if not isinstance(rules, list):
            raise ValueError("routing.rules must be a list")
        for i, rule in enumerate(rules):
            if not isinstance(rule, dict):
                raise ValueError(f"routing rule #{i + 1} must be an object")
            if not isinstance(rule.get("name"), str) or not rule["name"].strip():
                raise ValueError(f"routing rule #{i + 1} needs a 'name'")
            if not isinstance(rule.get("match", {}), dict):
                raise ValueError(f"routing rule '{rule['name']}' has an invalid 'match' (must be an object)")
            # Destinations are names, not inline peers — a typo here would
            # otherwise surface as a study that silently matches and goes nowhere.
            dests = rule.get("destinations", [])
            if not isinstance(dests, list) or not all(isinstance(x, str) for x in dests):
                raise ValueError(f"routing rule '{rule['name']}' destinations must be a list of destination names")

    dd = data.get("deid")
    if dd is not None:
        if not isinstance(dd, dict):
            raise ValueError("'deid' must be an object")
        if dd.get("profile", "basic") not in ("basic", "strict", "off"):
            raise ValueError("deid.profile must be 'basic', 'strict' or 'off'")
        # Same rule as web.auth_token, and for the same reason: the site key is
        # fed straight into HMAC, so a JSON number or true/false raises inside
        # the sender halfway through a forward instead of being refused here.
        # It is checked here rather than in _check_strings because it is not in
        # DEFAULTS (an absent key is "no site key", and writing "" into the file
        # is not the same statement). deid.prefix — which is fed to .strip() in
        # the same constructor and used to sit unchecked one line below this
        # comment — is covered by _check_strings with the rest of its family.
        if not isinstance(dd.get("secret", ""), str):
            raise ValueError(
                "deid.secret must be a string. It is the site key every pseudonym is derived "
                "from — use \"\" for none, or a real one: "
                "python3 -c \"import secrets; print(secrets.token_urlsafe(32))\""
            )

    em = data.get("emergency")
    if em is not None:
        if not isinstance(em, dict):
            raise ValueError("'emergency' must be an object")
        for k in ("probe_interval_sec", "recovery_successes"):
            v = em.get(k)
            if v is not None and not (isinstance(v, (int, float)) and v >= 1):
                raise ValueError(f"emergency.{k} must be a number >= 1")
        ot = em.get("offline_threshold_sec")
        if ot is not None and not (isinstance(ot, (int, float)) and ot >= 0):
            raise ValueError("emergency.offline_threshold_sec must be a number >= 0")
        _users.validate_principals(em.get("activate_by"), "emergency.activate_by")
        _users.validate_principals(em.get("notify"), "emergency.notify")
        # A policy naming only people who cannot act is a failover that will not
        # fire, and it fails at 3am rather than at the moment it was configured.
        # Only checked when profiles are actually in use — with none configured
        # the capability question has no one to ask.
        activate_by = em.get("activate_by") or []
        if activate_by and _users.profiles_in_use(data.get("users", {})):
            able = [p for p in _users.enabled_profiles(data.get("users", {}))
                    if _users.matches_any(p, activate_by) and p.can("emergency.activate")]
            if not able:
                named = ", ".join(_users.describe_principal(data.get("users", {}), s)
                                  for s in activate_by)
                raise ValueError(
                    f"emergency.activate_by names {named}, but nobody matching that can "
                    f"activate failover — they would all need the emergency.activate "
                    f"capability. As it stands the prompt would appear and no one could "
                    f"answer it. Grant the capability, name someone else, or set "
                    f"emergency.auto_activate true.")

    # Security gate. The dashboard API has no login of its own; it is safe
    # unauthenticated only because it answers on loopback, where the OS is the
    # access control. The moment the operator binds it anywhere reachable, a
    # token stops being optional — refuse the config rather than quietly serve
    # patient data and a full-control API to the whole network.
    # A token that is not a string is not a token. Reported here rather than
    # normalised away, because a config carrying `"auth_token": 0` looks to the
    # operator like a token is set: every reader must agree it is not, and the
    # operator has to be told which it is.
    if not isinstance(data["web"].get("auth_token", ""), str):
        raise ValueError(
            "web.auth_token must be a string. A JSON number, true/false or null is not a token — "
            "use \"\" for no token (loopback only), or a real one: "
            "python3 -c \"import secrets; print(secrets.token_urlsafe(32))\""
        )
    web_host = web_host_of(data["web"])
    reachable = not is_loopback_host(web_host)
    if reachable and not auth_token_of(data["web"]):
        raise ValueError(
            f"web.host is '{web_host}', which is reachable from the network, but web.auth_token is empty. "
            "Set a token — generate one with: python3 -c \"import secrets; print(secrets.token_urlsafe(32))\" — "
            "or set web.host back to 127.0.0.1 to keep the dashboard on this machine only."
        )

    nt = data.get("notify")
    if nt is not None:
        if not isinstance(nt, dict):
            raise ValueError("'notify' must be an object")
        wh = nt.get("webhook")
        if wh is not None:
            if not isinstance(wh, dict):
                raise ValueError("notify.webhook must be an object")
            url = str(wh.get("url", "") or "").strip()
            if wh.get("enabled") and not url:
                raise ValueError(
                    "notify.webhook.enabled is true but notify.webhook.url is empty — "
                    "nothing would be sent, and the appliance would report notification "
                    "as configured.")
            if url and not (url.startswith("http://") or url.startswith("https://")):
                raise ValueError(
                    f"notify.webhook.url is '{url}' — it must start with http:// or https://.")
            r = wh.get("retries")
            if r is not None and not (isinstance(r, int) and not isinstance(r, bool) and r >= 0):
                raise ValueError("notify.webhook.retries must be a whole number >= 0")
        sm = nt.get("smtp")
        if sm is not None:
            if not isinstance(sm, dict):
                raise ValueError("notify.smtp must be an object")
            if sm.get("enabled") and not str(sm.get("host", "") or "").strip():
                raise ValueError(
                    "notify.smtp.enabled is true but notify.smtp.host is empty — no mail "
                    "would be sent, and the appliance would report e-mail as configured.")
            port = sm.get("port")
            if port is not None and not (isinstance(port, int) and not isinstance(port, bool)
                                         and 1 <= port <= 65535):
                raise ValueError("notify.smtp.port must be a port number between 1 and 65535")
            mode = str(sm.get("tls", "starttls") or "").lower()
            if mode not in ("starttls", "ssl", "none"):
                raise ValueError(
                    f"notify.smtp.tls is '{mode}' — it must be starttls, ssl or none. "
                    f"An unrecognised value used to mean no encryption, which is not a "
                    f"thing to arrive at by typo when a password is being sent.")

    au = data.get("audit")
    if au is not None:
        if not isinstance(au, dict):
            raise ValueError("'audit' must be an object")
        mb = au.get("max_bytes")
        if mb is not None and not (isinstance(mb, int) and not isinstance(mb, bool) and mb >= 0):
            raise ValueError(
                "audit.max_bytes must be a whole number of bytes (0 = never rotate).")
        if au.get("enabled", True) and not str(au.get("dir", "") or "").strip():
            # An audit trail configured on with nowhere to write is the one
            # failure mode this feature cannot tolerate quietly: it looks
            # enabled in Settings and records nothing.
            raise ValueError(
                "audit.enabled is true but audit.dir is empty — the trail would have "
                "nowhere to be written. Set a folder, or set audit.enabled false and "
                "accept that this appliance keeps no record of who did what.")

    # Profiles answer the same question one layer down: the token says whether a
    # stranger can reach the API at all, and these say what each person who gets
    # past it may do. The bind is passed in because an OPEN profile — one with
    # no password — is a defensible thing on loopback and an unauthenticated
    # stranger with write access off-box, and only the host knows which of those
    # this appliance is. An empty profile list is legal and means token-only.
    _users.validate_profiles(data.get("users", {}), network_reachable=reachable)

    mods = data.get("modalities", [])
    if not isinstance(mods, list):
        raise ValueError("modalities must be a list")
    seen_mod: dict[str, int] = {}
    for i, m in enumerate(mods):
        if not isinstance(m, dict):
            raise ValueError(f"modality #{i + 1} must be an object")
        name = str(m.get("name", "")).strip()
        aet = str(m.get("aet", "")).strip()
        if not name:
            raise ValueError(f"modality #{i + 1} has a blank name — it is what the order form shows")
        if not aet:
            raise ValueError(f"modality '{name}' has no AE title. It is the whole point of the "
                             "entry: the worklist matches ScheduledStationAETitle against it.")
        if len(aet) > 16:
            raise ValueError(f"modality '{name}' AE title must be 16 characters or fewer (DICOM limit)")
        # DICOM AE titles are a restricted character set; a space or a backslash
        # in one produces associations that fail in ways nobody traces back here.
        if any(c in aet for c in "\\ ") or not aet.isprintable():
            raise ValueError(f"modality '{name}' AE title '{aet}' contains a space or backslash — "
                             "a DICOM AE title may not")
        for flag in ("enabled",):
            if flag in m and not isinstance(m[flag], bool):
                raise ValueError(f"modality '{name}' has a non-boolean '{flag}' ({m[flag]!r})")
        # Two stations sharing an AE title cannot be told apart by the worklist,
        # so an order aimed at one appears on both.
        key = aet.upper()
        if key in seen_mod:
            raise ValueError(f"modalities #{seen_mod[key] + 1} and #{i + 1} share the AE title "
                             f"'{aet}'. The worklist matches on it, so an order aimed at one "
                             "would appear on both.")
        seen_mod[key] = i

    dests = data.get("destinations", [])
    if not isinstance(dests, list):
        raise ValueError("destinations must be a list")
    # The name is the join key for routing rules, per-destination send state,
    # the retry backoff and the archive gate that decides a study is fully sent.
    # Every one of those lives in a dict keyed by name, so two destinations
    # sharing one collapse to a single entry: the study is marked delivered when
    # ONE of them got it, and the other node silently never receives the images.
    # That is image loss, so the name is an invariant, enforced here.
    seen: dict[str, tuple[int, dict]] = {}
    for i, d in enumerate(dests):
        for key in ("name", "host", "port", "aet"):
            if key not in d:
                raise ValueError(f"destination #{i + 1} missing '{key}'")
        if not (isinstance(d["port"], int) and 1 <= d["port"] <= 65535):
            raise ValueError(f"destination '{d.get('name')}' has an invalid port")
        if len(str(d["aet"])) > 16:
            raise ValueError(f"destination '{d.get('name')}' AE title too long")
        # destinations is a list, so _check_bools cannot reach these. Same
        # hazard, higher stakes: enabled: "false" is a node the operator
        # switched off that keeps receiving studies.
        for flag in ("enabled", "tls", "no_ris", "emergency_trigger"):
            if flag in d and not isinstance(d[flag], bool):
                raise ValueError(
                    f"destination '{d.get('name')}' has a non-boolean '{flag}' ({d[flag]!r}) — "
                    "it must be true or false; a quoted \"false\" reads as TRUE."
                )
        name = d["name"] if isinstance(d["name"], str) else ""
        if not name.strip():
            raise ValueError(
                f"destination #{i + 1} has a blank name. Every destination needs a name — it is "
                "what routing rules, the send state and the archive gate key on."
            )
        # Case-insensitively: "PACS" and "pacs" would key separately in some
        # dicts and identically in others, which is worse than either.
        key = name.strip().lower()
        if key in seen:
            # Naming the two rows by NAME alone was useless in the case that
            # matters most — an exact duplicate printed "'PACS' and 'PACS'", and
            # with four destinations nothing said which two to look at. The row
            # number and the address are unique even when the name is not.
            first_i, first = seen[key]
            raise ValueError(
                f"destinations #{first_i + 1} ({_dest_label(first)}) and #{i + 1} "
                f"({_dest_label(d)}) have the same name. "
                "Destination names must be unique (case is not enough to tell them apart) — "
                "send state and the archive gate key on the name, so duplicates make one of "
                "them silently never receive its images. Rename one."
            )
        seen[key] = (i, d)
