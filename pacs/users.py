"""Profiles — who is using this box, and what they are allowed to do.

Until now the whole API had exactly one credential: ``web.auth_token``, shared,
and equivalent to root. Handing a receptionist the emergency order form meant
handing them ``POST /api/shutdown``, ``POST /api/studies/delete-all`` and the
whole of ``GET /api/config`` in the same gesture. This module is the answer to
that, and to the two things a hospital asks for immediately afterwards: an
audit trail that can name a person, and a way to keep patient identifiers away
from staff whose job does not need them.

Three ideas carry the design.

**A profile is a row, not a type.** "Receptionist" is not a class in this file
and never becomes one. The four presets are seed data written on first run —
after that they are ordinary rows the administrator can rename, re-permission
or delete. That is what makes "the presets are editable" free rather than a
special case, and it is why nothing downstream may branch on a profile's
``role``: it is a label for humans and for the emergency-authority policy, not
a permission.

**The unit of permission is a capability, not a panel.** The gate has to live
at the endpoint — the dashboard is one page fed by one very disclosive status
payload, so hiding a nav button proves nothing about what the browser already
received. Capabilities name what an endpoint does; the UI derives its panels
from them. Deriving keeps the two honest automatically, where a second
hand-maintained "which panels does this role see" list is the exact seam that
has produced four defects in this tree already.

**Withheld is not the same as absent.** A profile may see a study without
seeing who it belongs to. A redacted field comes back as :data:`REDACTED`, not
as ``""``, because an empty accession means "this study has none" and an
operator who reads one as the other will go looking for a bug that is not
there.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from typing import Any, Iterable, Optional

# ---- capabilities -------------------------------------------------------
# Named after what the endpoint DOES, not after the panel it feeds, so a
# capability survives a UI redesign. Every entry here is enforced server-side in
# web.py; the dashboard's panel visibility is derived from the same set.
#
# The two at the bottom are separated deliberately. Either one can be used to
# grant every other capability to anybody — auth.manage by editing profiles,
# deid.manage by disabling the scrub that keeps a research node from receiving
# identified studies. They are the crown jewels and a preset must never hand
# them out casually.
CAPABILITIES: dict[str, str] = {
    "studies.read":       "See stored studies and the receive history",
    "studies.send":       "Forward a stored study to a destination",
    "studies.delete":     "Delete stored studies",
    "orders.read":        "See emergency RIS orders",
    "orders.write":       "Create, edit, close and cancel orders",
    "routing.read":       "See the routing rules",
    "routing.write":      "Edit the routing rules",
    "destinations.write": "Add, edit and remove destinations",
    "services.control":   "Start and stop the receiver, printer, worklist and Q/R",
    "emergency.activate": "Activate or stand down emergency failover",
    "logs.read":          "Read the operational log",
    "audit.read":         "Read and export the audit trail",
    "config.read":        "See the configuration document",
    "config.write":       "Change the configuration",
    "system.shutdown":    "Shut the engine down from the dashboard",
    "auth.manage":        "Create and edit profiles, and set what they may do",
    "deid.manage":        "Change the de-identification profile and site key",
}

# ---- identifiers a profile may or may not be shown ----------------------
# Per-field rather than one phi.read flag, because "IT cannot be in the blind
# either" is a real operational constraint: somebody has to trace a study
# through the routing engine at 3am, and an accession number is how you do that
# without learning whose scan it was. The administrator draws the line per
# profile; this module only enforces it.
#
# Keys are the field names the API already publishes (status(), the history
# browser, the index, QIDO). Adding a field to the API means adding it here —
# see the test that walks the status payload and fails on an unclassified
# identifier, which is what stops a future field from leaking by omission.
PHI_FIELDS: dict[str, str] = {
    "patient_name":      "Patient name",
    "patient_id":        "Patient ID",
    "patient_birthdate": "Date of birth",
    "patient_sex":       "Sex",
    "accession":         "Accession number",
    "study_desc":        "Study description",
    "referring":         "Referring physician",
}

# What a withheld value looks like on the wire. Not "", which already means
# "this study genuinely has no accession"; not a localised word, because
# /dicom-web and every script answer to non-browser clients that will never load
# the dashboard's dictionary. The dashboard renders it as a lock and explains
# who to ask, rather than letting it read as missing data.
REDACTED = "***"

# ---- password storage ---------------------------------------------------
# PBKDF2-HMAC-SHA256 out of hashlib. Deliberately stdlib: this project ships as
# a frozen single-file binary and a Docker image with five dependencies, and
# adding argon2/bcrypt for the login screen would mean a compiled wheel in the
# freeze on three platforms. PBKDF2 at a high iteration count is the weakest of
# the good answers and still far past what an attacker who has already got the
# config file off a 0600 path is likely to bother with.
#
# The count is stored PER RECORD, not read from this constant at verify time, so
# raising it later leaves every existing password working and only new ones
# slower. A password set on a Raspberry Pi and verified on a server must not
# depend on the two machines agreeing about what year it is.
PBKDF2_ITERATIONS = 600_000
PBKDF2_ALGO = "pbkdf2_sha256"
SALT_BYTES = 16

# A profile id is generated, never typed, and never reused. It is what the audit
# trail records: a name can be corrected ("Ana Ruis" -> "Ana Ruiz") without
# rewriting history, and a deleted profile's entries still resolve to something
# specific rather than to whoever inherits the name next.
_ID_RE = re.compile(r"^u_[0-9a-f]{12}$")

MAX_NAME = 64
MAX_ROLE = 32


def new_id() -> str:
    return "u_" + secrets.token_hex(6)


def is_valid_id(value: Any) -> bool:
    return isinstance(value, str) and bool(_ID_RE.match(value))


def hash_password(password: str, *, iterations: int = PBKDF2_ITERATIONS) -> dict:
    """Derive a storable record from a plaintext password.

    Returns the record; the caller stores it and drops the plaintext. Nothing
    here logs, echoes or retains the input.
    """
    if not isinstance(password, str) or not password:
        raise ValueError("a password cannot be empty — use no password for an open profile")
    salt = secrets.token_bytes(SALT_BYTES)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations))
    return {
        "algo": PBKDF2_ALGO,
        "iterations": int(iterations),
        "salt": salt.hex(),
        "hash": dk.hex(),
    }


def verify_password(record: Any, password: str) -> bool:
    """Constant-time check of *password* against a stored record.

    False for an open profile (no record) rather than True: "this profile has no
    password" is a question for :func:`is_locked`, and a caller that asks this
    one is asking to verify a credential. Answering True would turn every open
    profile into one that accepts any password, which is how a profile the
    administrator later locks stays open in some forgotten code path.
    """
    if not isinstance(record, dict) or not isinstance(password, str) or not password:
        return False
    if record.get("algo") != PBKDF2_ALGO:
        return False
    try:
        iterations = int(record.get("iterations", 0))
        salt = bytes.fromhex(str(record.get("salt", "")))
        expected = bytes.fromhex(str(record.get("hash", "")))
    except (TypeError, ValueError):
        return False
    if iterations < 1 or not salt or not expected:
        return False
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(dk, expected)


def password_fingerprint(record: Any) -> str:
    """A short, non-reversible stand-in for a stored password record.

    Two jobs, both of which need "did this change" and neither of which may be
    given the material to answer "what is it". The session cookie binds to it,
    so changing a profile's password invalidates that profile's sessions and
    nobody else's. Config.version() folds it into the ETag, so a Save built
    before a password change is refused instead of silently reverting it — the
    same hole the token had, closed the same way.

    The stored hash is already a KDF output over a random salt, so a digest of
    it discloses nothing an attacker holding the config does not have; the
    salt is included so two profiles that pick the same password do not
    fingerprint alike.
    """
    if not isinstance(record, dict):
        return "open"
    material = f"{record.get('algo', '')}\0{record.get('salt', '')}\0{record.get('hash', '')}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


class Profile:
    """One row, wrapped so callers stop reaching into the dict.

    Read-only by construction. Editing goes through the /api/profiles endpoints
    so it lands under the config lock with an audit entry attached, never by
    mutating one of these.
    """

    __slots__ = ("data",)

    def __init__(self, data: Any):
        self.data = data if isinstance(data, dict) else {}

    # ---- identity --------------------------------------------------------
    @property
    def id(self) -> str:
        value = self.data.get("id", "")
        return value if isinstance(value, str) else ""

    @property
    def name(self) -> str:
        value = self.data.get("name", "")
        return value.strip() if isinstance(value, str) else ""

    @property
    def role(self) -> str:
        """A label, never a permission.

        The emergency-activation policy can point at a role, and the audit trail
        records it alongside the name so a reader knows in what capacity someone
        acted. Nothing else in the tree may branch on it — the moment a role
        implies an access decision, editing a preset stops being safe.
        """
        value = self.data.get("role", "")
        return value.strip() if isinstance(value, str) else ""

    @property
    def enabled(self) -> bool:
        return self.data.get("enabled", True) is not False

    @property
    def email(self) -> str:
        value = self.data.get("email", "")
        return value.strip() if isinstance(value, str) else ""

    @property
    def locale(self) -> str:
        value = self.data.get("locale", "")
        return value.strip() if isinstance(value, str) else ""

    # ---- authority -------------------------------------------------------
    @property
    def admin(self) -> bool:
        """Holds every capability, including ones a later version invents.

        This is why it is a flag and not a saved list of all seventeen names. An
        upgrade that adds a capability must not silently withhold it from the
        administrator — an appliance that comes back from an update with nobody
        able to reach the new screen is an outage, and the administrator is the
        one person who could fix it.
        """
        return self.data.get("admin", False) is True

    def capabilities(self) -> frozenset:
        if self.admin:
            return frozenset(CAPABILITIES)
        raw = self.data.get("capabilities", ())
        if not isinstance(raw, (list, tuple, set, frozenset)):
            return frozenset()
        # Unknown names are dropped rather than carried: a capability removed by
        # an upgrade would otherwise sit in the file looking like a grant, and a
        # typo in a hand-edited config would look like one too.
        return frozenset(c for c in raw if isinstance(c, str) and c in CAPABILITIES)

    def can(self, capability: str) -> bool:
        if not self.enabled:
            return False
        if self.admin:
            return capability in CAPABILITIES
        return capability in self.capabilities()

    @property
    def locked(self) -> bool:
        """Does this profile need a password? ("password locked or not")"""
        return isinstance(self.data.get("password"), dict)

    def check_password(self, password: str) -> bool:
        return verify_password(self.data.get("password"), password)

    def credential_fingerprint(self) -> str:
        return password_fingerprint(self.data.get("password"))

    # ---- what identifiers this profile may see ---------------------------
    def phi_visible(self) -> frozenset:
        """The identifier fields this profile is allowed to be shown.

        An administrator sees everything for the same reason they hold every
        capability: they are the person who decides what everyone else sees, and
        a redaction they cannot see through is one they cannot verify.
        """
        if self.admin:
            return frozenset(PHI_FIELDS)
        raw = self.data.get("phi_visible", ())
        if not isinstance(raw, (list, tuple, set, frozenset)):
            return frozenset()
        return frozenset(f for f in raw if isinstance(f, str) and f in PHI_FIELDS)

    def sees(self, field: str) -> bool:
        # A field nobody classified is withheld, not shown. This is the only
        # safe default: the failure mode of guessing wrong is a leak that
        # nothing reports, and the failure mode of this is a visible *** that
        # somebody asks about.
        if field not in PHI_FIELDS:
            return True          # not an identifier at all — modality, port, counts
        return field in self.phi_visible()

    # ---- serialisation ---------------------------------------------------
    def public(self) -> dict:
        """What the picker may show before anyone has authenticated.

        No email, no capability list, no password material — only enough to draw
        a button and know whether to prompt. See ``users.list_profiles`` in the
        config for why even the name is a considered disclosure.
        """
        return {"id": self.id, "name": self.name, "role": self.role,
                "locked": self.locked}

    def describe(self) -> dict:
        """The full row for an administrator's editor. Never the password."""
        return {
            "id": self.id,
            "name": self.name,
            "role": self.role,
            "enabled": self.enabled,
            "admin": self.admin,
            "locked": self.locked,
            "email": self.email,
            "locale": self.locale,
            "capabilities": sorted(self.capabilities()),
            "phi_visible": sorted(self.phi_visible()),
        }

    def __repr__(self) -> str:      # pragma: no cover - diagnostics only
        return f"<Profile {self.id} {self.name!r} role={self.role!r}>"


# The identity a bearer token authenticates as. web.auth_token predates
# profiles and is what every machine client holds — the DICOMweb viewer, the
# tray shell, whatever script somebody wrote. It keeps working exactly as it
# did, as an administrator, because the alternative is that upgrading breaks
# every integration on the site and the operator's first experience of the
# feature is an outage. It is a service credential, and the audit trail says so
# rather than attributing its actions to a person who was not there.
SERVICE_PROFILE = Profile({
    "id": "u_000000000000",
    "name": "API token",
    "role": "service",
    "enabled": True,
    "admin": True,
})

# Nobody at all: no capabilities, no identifiers, not enabled. Returned instead
# of None so a caller that forgets to check gets a denial rather than an
# AttributeError halfway through composing a payload — a crash here would be
# served as a 500 from an endpoint that was supposed to be refusing access.
ANONYMOUS = Profile({
    "id": "",
    "name": "",
    "role": "",
    "enabled": False,
    "admin": False,
})


def profiles_of(users: Any) -> list:
    """Every configured row, as Profiles, in file order."""
    if not isinstance(users, dict):
        return []
    raw = users.get("profiles", ())
    if not isinstance(raw, (list, tuple)):
        return []
    return [Profile(p) for p in raw if isinstance(p, dict)]


def by_id(users: Any, profile_id: str) -> Optional[Profile]:
    """Look one up. None when it is absent — callers decide what that means.

    Deliberately not a dict comprehension keyed by id: two rows sharing an id is
    a hand-edited config, and building a dict would silently pick the last one
    while validate() is refusing the file. Scanning in file order means the
    first match wins consistently everywhere, which is the same rule the send
    path already applies to destinations that share a name.
    """
    if not isinstance(profile_id, str) or not profile_id:
        return None
    for p in profiles_of(users):
        if p.id == profile_id:
            return p
    return None


def enabled_profiles(users: Any) -> list:
    return [p for p in profiles_of(users) if p.enabled]


def profiles_in_use(users: Any) -> bool:
    """Is this appliance running with profiles at all?

    False is the pre-profiles world and stays fully supported: no picker, no
    capability checks, ``web.auth_token`` alone, exactly as every install that
    predates this module behaves today. Everything downstream branches on this
    one question rather than on "is the list empty", so there is a single place
    that decides what "not configured" means.
    """
    return bool(enabled_profiles(users))


def admins(users: Any) -> list:
    return [p for p in enabled_profiles(users) if p.admin or p.can("auth.manage")]


def in_role(users: Any, role: str) -> list:
    """Enabled profiles carrying *role*, compared case-insensitively.

    Case-insensitive because the role is free text an administrator types, and
    an emergency that does not fire because somebody wrote "Radiologist" where
    the policy says "radiologist" is not a distinction worth defending.
    """
    want = str(role or "").strip().casefold()
    if not want:
        return []
    return [p for p in enabled_profiles(users) if p.role.casefold() == want]


def roles_in_use(users: Any) -> list:
    """Distinct roles, for the emergency-authority picker. Sorted, deduped."""
    seen: dict[str, str] = {}
    for p in enabled_profiles(users):
        if p.role:
            seen.setdefault(p.role.casefold(), p.role)
    return [seen[k] for k in sorted(seen)]


# ---- principals ---------------------------------------------------------
# A "principal" is how the config points at somebody without hard-coding which
# somebody. Two spellings, both written by an administrator:
#
#   "role:radiologist"    everyone carrying that role
#   "u_9f2c1a0b4d7e"      one specific person
#
# This exists because the emergency policy has to say "a user or role X,
# designated by the admin" without the code caring which was chosen. A bare
# role name would have been ambiguous the day somebody names a profile
# "radiologist", so the prefix is required and validate() enforces it.
ROLE_PREFIX = "role:"


def matches_principal(profile: Profile, spec: Any) -> bool:
    if not isinstance(spec, str) or not profile.enabled:
        return False
    spec = spec.strip()
    if spec in ("*", "any"):
        return True
    if spec.lower().startswith(ROLE_PREFIX):
        return profile.role.casefold() == spec[len(ROLE_PREFIX):].strip().casefold()
    return bool(profile.id) and profile.id == spec


def matches_any(profile: Profile, specs: Any) -> bool:
    """Does *profile* match any of *specs*?

    An EMPTY list means everyone, not no one, and every caller depends on that
    reading. It is what makes the policy fields default to today's behaviour: an
    appliance upgraded into this feature has empty lists, so nothing narrows and
    nothing changes until an administrator says otherwise. The opposite default
    would have meant an upgrade that silently stops notifying anybody about a
    primary going down.
    """
    if not isinstance(specs, (list, tuple)) or not specs:
        return True
    return any(matches_principal(profile, s) for s in specs)


def describe_principal(users_cfg: Any, spec: Any) -> str:
    """A principal as a human reads it, for the dashboard and the audit trail."""
    if not isinstance(spec, str):
        return str(spec)
    spec = spec.strip()
    if spec in ("*", "any"):
        return "anyone on duty"
    if spec.lower().startswith(ROLE_PREFIX):
        return f"anyone with the {spec[len(ROLE_PREFIX):].strip()} role"
    found = by_id(users_cfg, spec)
    # A principal naming a profile that has since been deleted still has to
    # render as something. Saying so is better than a bare id, because a policy
    # pointing at nobody is a policy that will not fire and the administrator
    # needs to see that in the screen where they set it.
    return found.name if found is not None else f"a deleted profile ({spec})"


def validate_principals(specs: Any, where: str) -> None:
    if specs is None:
        return
    if not isinstance(specs, list):
        raise ValueError(f"{where} must be a list of \"role:<name>\" entries or profile ids.")
    for s in specs:
        if not isinstance(s, str) or not s.strip():
            raise ValueError(f"{where} contains {s!r}, which is not a principal.")
        s = s.strip()
        if s in ("*", "any") or s.lower().startswith(ROLE_PREFIX):
            continue
        if not is_valid_id(s):
            raise ValueError(
                f"{where} contains {s!r}. Point at a role as \"role:{s}\", or at one "
                f"person by their profile id. A bare name is ambiguous the moment "
                f"somebody is called the same thing as a role.")


def redact(payload: Any, profile: Profile, *, fields: Optional[Iterable[str]] = None) -> Any:
    """Return *payload* with every identifier this profile may not see removed.

    Walks dicts and lists so one call covers a study row, a list of them, or the
    whole status payload. Keys are matched against :data:`PHI_FIELDS` and
    :data:`_ALIASES` by name, which is why the API's field names and those
    tables have to stay in step — the test that walks a live status payload is
    what enforces it.

    *fields* defaults to every known identifier key, which is the only safe
    default: a caller who forgets the argument gets more redaction than they
    needed, never less. Pass a narrower set to leave a spelling alone. A
    non-string value is replaced too — a birthdate that arrives as a number is
    still a birthdate.
    """
    extra = ALL_PHI_KEYS if fields is None else frozenset(
        f for f in fields if isinstance(f, str))

    def visible(key: str) -> bool:
        if key in extra:
            # An alias inherits the visibility of the field it aliases when the
            # caller named one, and is withheld otherwise.
            return profile.sees(_ALIASES.get(key, key))
        return profile.sees(key)

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            out = {}
            for key, value in node.items():
                if isinstance(key, str) and (key in PHI_FIELDS or key in extra) and not visible(key):
                    out[key] = REDACTED
                else:
                    out[key] = walk(value)
            return out
        if isinstance(node, list):
            return [walk(v) for v in node]
        if isinstance(node, tuple):
            return tuple(walk(v) for v in node)
        return node

    return walk(payload)


# Names the API already publishes for fields that PHI_FIELDS classifies under a
# different spelling. Every one of these is a place a redaction would otherwise
# miss because the key did not match, which is the whole failure mode: the field
# is classified, the payload calls it something else, and it goes out in clear.
#
# Every entry has to be a key that means an identifier WHEREVER it appears,
# because redact() walks a whole payload and matches on the key alone. A bare
# "name" would have qualified on spelling and been catastrophic on meaning: the
# status payload calls a destination's name, a routing rule's name and a
# service's name exactly that, and redacting those turns the dashboard into a
# wall of *** for a receptionist while hiding nothing about any patient. The
# same disqualifies "description", "sex" and "birthdate". None of them are
# needed anyway — the order store and the history browser both spell these
# fields the canonical way, and "patient" (the formatted display name) is the
# single genuine alias in the tree.
_ALIASES: dict[str, str] = {
    "patient":                 "patient_name",   # history browser + order briefs
    "PatientName":             "patient_name",   # QIDO-RS / C-FIND JSON
    "PatientID":               "patient_id",
    "PatientBirthDate":        "patient_birthdate",
    "PatientSex":              "patient_sex",
    "AccessionNumber":         "accession",
    "StudyDescription":        "study_desc",
    "ReferringPhysicianName":  "referring",
}

# Every key redact() should treat as an identifier, so a caller can hand the
# whole set over without knowing which spellings a given payload uses.
ALL_PHI_KEYS = frozenset(PHI_FIELDS) | frozenset(_ALIASES)


# ---- the presets --------------------------------------------------------
# Seed data. Written once on first run, then owned by the administrator: these
# are ordinary rows afterwards and nothing in the tree looks them up by name or
# by role. Delete all four and the appliance still works, provided one
# administrator survives — which validate() enforces.
#
# Every preset ships OPEN (no password). A locked appliance nobody can get into
# is an outage, and the first-run flow is where the administrator sets the first
# password, with the dashboard nagging until they do. The one place that is not
# tolerable is a network-reachable bind, and validate() refuses that combination
# outright rather than leaving it to a nag.

def preset_profiles() -> list:
    """The four rows a fresh install starts with."""
    return [
        {
            "id": new_id(),
            "name": "Administrator",
            "role": "admin",
            "enabled": True,
            "admin": True,          # holds everything, including future capabilities
            "capabilities": [],     # unread while admin is true; kept for when it is cleared
            "phi_visible": sorted(PHI_FIELDS),
            "password": None,
            "email": "",
            "locale": "",
        },
        {
            "id": new_id(),
            "name": "IT",
            "role": "it",
            "enabled": True,
            "admin": False,
            # Everything technical, and nothing clinical. Notably absent:
            # studies.delete (a routing problem is never fixed by deleting the
            # evidence), deid.manage and auth.manage.
            "capabilities": [
                "studies.read", "studies.send",
                "routing.read", "routing.write",
                "destinations.write", "services.control",
                "logs.read", "audit.read",
                "config.read", "config.write",
                "emergency.activate",
            ],
            # The line the administrator can move. An accession and a patient ID
            # are what you trace a study through the routing engine with at 3am;
            # a name, a date of birth and a study description are what turn that
            # trace into a look at somebody's chart. IT is not blind and is not
            # reading the notes.
            "phi_visible": ["accession", "patient_id"],
            "password": None,
            "email": "",
            "locale": "",
        },
        {
            "id": new_id(),
            "name": "Radiologist",
            "role": "radiologist",
            "enabled": True,
            "admin": False,
            # Clinical work: read the studies, push one to an alternate node
            # when the primary is down, and make the failover call.
            "capabilities": [
                "studies.read", "studies.send",
                "orders.read",
                "routing.read",
                "emergency.activate",
                "logs.read",
            ],
            "phi_visible": sorted(PHI_FIELDS),
            "password": None,
            "email": "",
            "locale": "",
        },
        {
            "id": new_id(),
            "name": "Reception",
            "role": "receptionist",
            "enabled": True,
            "admin": False,
            # Order intake, which is the whole job during a RIS outage: key the
            # order in so the technologist has an accession to type into the
            # modality. No routing, no destinations, no services, no config.
            "capabilities": [
                "orders.read", "orders.write",
                "studies.read",
            ],
            # Demographics are what they are typing in, so they see them. The
            # referring physician and the study description are on the order form
            # too. This profile has the widest identifier view of the three
            # non-admin presets and the narrowest authority, which is the shape
            # minimum-necessary actually takes at a front desk.
            "phi_visible": ["patient_name", "patient_id", "patient_birthdate",
                            "patient_sex", "accession", "study_desc", "referring"],
            "password": None,
            "email": "",
            "locale": "",
        },
    ]


# ---- validation ---------------------------------------------------------
# Called from config.validate(), which owns the "raise ValueError with something
# the operator can act on" contract. Kept here so the rules live beside the
# model they constrain.

def validate_profiles(users: Any, *, network_reachable: bool) -> None:
    """Raise ValueError on a profile list that would make the app misbehave.

    *network_reachable* is the same question config.validate() asks about
    web.host, and it is what turns the open-profile rule from a preference into
    a refusal.
    """
    if not isinstance(users, dict):
        raise ValueError("users must be an object with a 'profiles' list.")
    raw = users.get("profiles", [])
    if not isinstance(raw, list):
        raise ValueError("users.profiles must be a list of profile objects.")

    if not isinstance(users.get("list_profiles", True), bool):
        raise ValueError("users.list_profiles must be true or false.")

    if not raw:
        # An EMPTY list means profiles are not in use, and that has to stay
        # legal. Every config.json written before this feature existed has no
        # users key at all, so it deep-merges to exactly this — and refusing it
        # would mean upgrading takes the appliance off the air until somebody
        # hand-edits a file they have never heard of. Empty is therefore
        # "token-only, behave exactly as the previous version", which is also
        # what the operator gets if they delete every profile.
        return

    seen_ids: set = set()
    seen_names: set = set()
    for i, row in enumerate(raw):
        where = f"users.profiles[{i}]"
        if not isinstance(row, dict):
            raise ValueError(f"{where} must be an object.")
        p = Profile(row)

        if not is_valid_id(row.get("id")):
            raise ValueError(
                f"{where}.id must look like 'u_' followed by 12 hex characters. "
                f"Ids are generated, not typed — add profiles from the dashboard, "
                f"or copy the shape of an existing row.")
        if p.id in seen_ids:
            # The duplicate-name defect this tree already fixed for destinations,
            # one layer up: two rows sharing an id means the audit trail cannot
            # say which of them acted, and every lookup silently resolves to one.
            raise ValueError(
                f"{where}.id '{p.id}' is used by more than one profile. "
                f"Ids identify a person in the audit trail and have to be unique.")
        seen_ids.add(p.id)

        if not p.name:
            raise ValueError(f"{where}.name is empty — the picker would draw a blank button.")
        if len(p.name) > MAX_NAME:
            raise ValueError(f"{where}.name is longer than {MAX_NAME} characters.")
        key = p.name.casefold()
        if key in seen_names:
            raise ValueError(
                f"{where}.name '{p.name}' is used by more than one profile. "
                f"Two identical buttons in the picker is a login nobody can get right, "
                f"and an audit entry nobody can attribute.")
        seen_names.add(key)

        if len(p.role) > MAX_ROLE:
            raise ValueError(f"{where}.role is longer than {MAX_ROLE} characters.")

        for flag in ("enabled", "admin"):
            if flag in row and not isinstance(row[flag], bool):
                raise ValueError(
                    f"{where}.{flag} must be true or false, not {row[flag]!r}. "
                    f"A string \"false\" reads as true.")

        caps = row.get("capabilities", [])
        if not isinstance(caps, list):
            raise ValueError(f"{where}.capabilities must be a list of capability names.")
        for c in caps:
            if not isinstance(c, str) or c not in CAPABILITIES:
                raise ValueError(
                    f"{where}.capabilities contains {c!r}, which is not a capability. "
                    f"Known: {', '.join(sorted(CAPABILITIES))}.")

        phi = row.get("phi_visible", [])
        if not isinstance(phi, list):
            raise ValueError(f"{where}.phi_visible must be a list of field names.")
        for f in phi:
            if not isinstance(f, str) or f not in PHI_FIELDS:
                raise ValueError(
                    f"{where}.phi_visible contains {f!r}, which is not an identifier field. "
                    f"Known: {', '.join(sorted(PHI_FIELDS))}.")

        pw = row.get("password", None)
        if pw is not None:
            if not isinstance(pw, dict):
                raise ValueError(
                    f"{where}.password must be null (open profile) or a stored hash object. "
                    f"A plaintext password here would be stored in clear — set it from the dashboard.")
            if pw.get("algo") != PBKDF2_ALGO:
                raise ValueError(
                    f"{where}.password.algo must be '{PBKDF2_ALGO}'. "
                    f"Re-set the password from the dashboard.")
            for field in ("salt", "hash"):
                value = pw.get(field, "")
                if not isinstance(value, str) or not value:
                    raise ValueError(f"{where}.password.{field} is missing.")
                try:
                    bytes.fromhex(value)
                except ValueError:
                    raise ValueError(f"{where}.password.{field} is not hex.")
            if not isinstance(pw.get("iterations"), int) or pw["iterations"] < 1:
                raise ValueError(f"{where}.password.iterations must be a positive whole number.")

        email = row.get("email", "")
        if not isinstance(email, str):
            raise ValueError(f"{where}.email must be a string.")
        if email and ("@" not in email or email.startswith("@") or email.endswith("@")):
            raise ValueError(
                f"{where}.email '{email}' does not look like an address. "
                f"It is where this profile's emergency notifications go — leave it "
                f"blank rather than approximate.")

    if not enabled_profiles(users):
        # Every row disabled is the same state as no rows, and it is far more
        # likely to be a mistake — an administrator disabling the last account
        # while tidying up. Say so instead of falling through to a login screen
        # with nothing on it.
        raise ValueError(
            "Every profile is disabled, so nobody could log in. Enable one, or "
            "remove them all to go back to token-only access.")

    if not admins(users):
        raise ValueError(
            "No enabled profile can manage profiles. Somebody has to be able to "
            "grant access, or the next change to who works here needs the config "
            "file edited by hand. Keep one enabled profile with admin: true.")

    if network_reachable:
        # An open profile on a loopback bind is defensible — the OS is the
        # boundary, and the whole appliance is already only reachable by someone
        # on the box. Off-box it is not: an open profile carrying write
        # authority is an unauthenticated stranger with that authority, and the
        # bind rule that forces web.auth_token would be satisfied while this
        # walked straight past it.
        #
        # Read-only open profiles are still allowed. A waiting-room screen that
        # shows the queue with every identifier redacted is a real deployment,
        # and forcing a password onto it would mean the password gets taped to
        # the monitor.
        for p in profiles_of(users):
            if not p.enabled or p.locked:
                continue
            writes = sorted(c for c in p.capabilities() if _is_write(c))
            if p.admin:
                writes = ["everything (admin)"]
            if writes:
                raise ValueError(
                    f"Profile '{p.name}' has no password but can change things "
                    f"({', '.join(writes)}), and web.host is reachable from the network. "
                    f"Anyone who can reach the dashboard could use it. Set a password on "
                    f"it, remove its write access, or bind the dashboard to 127.0.0.1.")


_READ_ONLY = frozenset({
    "studies.read", "orders.read", "routing.read", "logs.read",
    "audit.read", "config.read",
})


def _is_write(capability: str) -> bool:
    """Does this capability change something, or reach off the box?

    studies.send counts as a write even though it creates nothing locally: it
    puts patient images on the network, which is the one action here whose
    consequences an operator cannot take back.
    """
    return capability in CAPABILITIES and capability not in _READ_ONLY
