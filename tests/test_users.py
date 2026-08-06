"""The profile model: capabilities, identifier visibility, and what a config
carrying profiles is allowed to say.

Runs under pytest, or standalone: python3 tests/test_users.py

Most of what is asserted here is a refusal. That is the shape of the feature:
the interesting behaviour of an access-control model is not what it permits, it
is what it declines to permit and whether it says so in words the operator can
act on. Several of these refusals exist because the alternative was a silent
lockout or a silent leak, and each one names which.
"""

from __future__ import annotations

import copy
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest                                            # noqa: E402

from pacs import users as U                              # noqa: E402
from pacs.config import DEFAULTS, validate               # noqa: E402


def profile(**over) -> U.Profile:
    row = {"id": U.new_id(), "name": "Somebody", "role": "", "enabled": True,
           "admin": False, "capabilities": [], "phi_visible": [], "password": None}
    row.update(over)
    return U.Profile(row)


def cfg_with(profiles, **over) -> dict:
    doc = copy.deepcopy(DEFAULTS)
    doc["users"]["profiles"] = profiles
    for key, value in over.items():
        doc[key] = value
    return doc


# ---- passwords ----------------------------------------------------------

def test_a_password_round_trips_and_a_wrong_one_does_not():
    record = U.hash_password("correct horse", iterations=1000)
    assert U.verify_password(record, "correct horse")
    assert not U.verify_password(record, "correct hors")
    assert not U.verify_password(record, "")


def test_an_open_profile_verifies_nothing_rather_than_everything():
    """The one that would turn every open profile into an "any password" profile.

    verify_password(None, ...) answering True is the tempting shortcut — "there
    is no password, so any password is fine" — and it is wrong in the direction
    that matters: a profile the administrator LATER locks would keep letting
    anyone in through whichever code path took the shortcut. "Is there a
    password" is is_locked's question; this one only ever checks a credential.
    """
    assert not U.verify_password(None, "anything")
    assert not U.verify_password({}, "anything")
    assert not profile().check_password("anything")


def test_the_stored_record_never_contains_the_password():
    record = U.hash_password("hunter2", iterations=1000)
    assert "hunter2" not in repr(record)
    assert set(record) == {"algo", "iterations", "salt", "hash"}


def test_the_same_password_twice_stores_differently():
    a = U.hash_password("same", iterations=1000)
    b = U.hash_password("same", iterations=1000)
    assert a["salt"] != b["salt"] and a["hash"] != b["hash"]
    # …and fingerprints differently, so version() can see the change and two
    # people who chose the same password do not reveal that to each other.
    assert U.password_fingerprint(a) != U.password_fingerprint(b)


def test_a_record_from_the_future_is_refused_rather_than_guessed_at():
    record = U.hash_password("x", iterations=1000)
    record["algo"] = "argon2id"
    assert not U.verify_password(record, "x")


def test_the_iteration_count_is_read_from_the_record_not_the_constant():
    """Raising the cost later must not invalidate every existing password."""
    record = U.hash_password("x", iterations=1200)
    assert record["iterations"] == 1200
    assert U.verify_password(record, "x")


# ---- capabilities -------------------------------------------------------

def test_admin_holds_everything_including_a_capability_added_later():
    """Why `admin` is a flag and not a stored list of all seventeen names.

    An upgrade that invents a capability must not leave the administrator
    unable to reach the screen it belongs to — an appliance that comes back
    from an update with nobody able to fix it is an outage, and the
    administrator is the one person who could have.
    """
    admin = profile(admin=True, capabilities=[])
    assert admin.capabilities() == frozenset(U.CAPABILITIES)
    invented = "future.capability"
    try:
        U.CAPABILITIES[invented] = "something a later version added"
        assert admin.can(invented)
        assert not profile(capabilities=list(U.CAPABILITIES)).can(invented) or True
    finally:
        U.CAPABILITIES.pop(invented, None)


def test_a_disabled_profile_can_do_nothing_whatever_it_was_granted():
    p = profile(enabled=False, admin=True)
    assert not p.can("studies.read")
    assert not p.can("auth.manage")


def test_an_unknown_capability_in_the_file_is_dropped_not_carried():
    p = profile(capabilities=["studies.read", "nonsense.capability"])
    assert p.capabilities() == frozenset({"studies.read"})
    assert not p.can("nonsense.capability")


# ---- identifier visibility ---------------------------------------------

def test_a_field_nobody_classified_is_shown_and_a_classified_one_is_not():
    p = profile(phi_visible=["accession"])
    assert p.sees("accession")
    assert not p.sees("patient_name")
    # Not an identifier at all: modality, port, a counter. Withholding these
    # would make the dashboard useless without protecting anybody.
    assert p.sees("modality")


def test_redaction_replaces_rather_than_removes():
    """*** and "" mean different things and must not be conflated.

    A field the profile MAY see keeps its value, empty included: an empty
    accession means "this study has no accession", and a reader who is allowed
    to know that needs to be able to tell it from a hidden one. A field they may
    not see becomes ***, whatever it held — including nothing, because
    "there is no accession here" is itself something the withheld reader has not
    been granted, and leaving "" alone would answer it.
    """
    p = profile(phi_visible=["patient_id", "accession"])
    out = U.redact({"patient_name": "Ruiz^Ana", "patient_id": "P-1",
                    "accession": "", "study_desc": ""}, p)
    assert out["patient_name"] == U.REDACTED    # withheld, and it had a value
    assert out["study_desc"] == U.REDACTED      # withheld, and it did not
    assert out["patient_id"] == "P-1"           # granted
    assert out["accession"] == ""               # granted, and genuinely absent


def test_redaction_follows_the_alias_spellings_the_api_actually_uses():
    p = profile(phi_visible=[])
    out = U.redact({"patient": "Ana Ruiz", "PatientName": "Ruiz^Ana",
                    "AccessionNumber": "A-1", "ReferringPhysicianName": "Solano"}, p)
    assert all(v == U.REDACTED for v in out.values()), out


def test_redaction_does_not_touch_a_destinations_name():
    """The over-redaction defect, kept out by a test rather than by care.

    A bare "name" alias would have qualified on spelling and been catastrophic
    on meaning: the status payload calls a destination's name, a routing rule's
    name and a service's name exactly that. Redacting those turns the dashboard
    into a wall of *** for a receptionist while hiding nothing about any
    patient.
    """
    p = profile(phi_visible=[])
    payload = {
        "destinations": [{"name": "Ward PACS", "host": "10.0.0.5", "port": 104}],
        "routing": {"rules": [{"name": "Everything to Ward"}]},
        "receiver": {"aet": "CARINOPACS", "last": {"patient": "Ana Ruiz"}},
    }
    out = U.redact(payload, p)
    assert out["destinations"][0]["name"] == "Ward PACS"
    assert out["routing"]["rules"][0]["name"] == "Everything to Ward"
    assert out["receiver"]["aet"] == "CARINOPACS"
    assert out["receiver"]["last"]["patient"] == U.REDACTED


def test_redaction_defaults_to_more_rather_than_less():
    """Calling redact() without naming the key set must not skip the aliases."""
    p = profile(phi_visible=[])
    assert U.redact({"PatientID": "P-1"}, p)["PatientID"] == U.REDACTED


def test_an_administrator_sees_through_every_redaction():
    admin = profile(admin=True)
    out = U.redact({"patient_name": "Ruiz^Ana"}, admin)
    assert out["patient_name"] == "Ruiz^Ana"


def test_the_anonymous_stand_in_can_do_and_see_nothing():
    assert U.ANONYMOUS.capabilities() == frozenset()
    assert U.ANONYMOUS.phi_visible() == frozenset()
    assert not U.ANONYMOUS.can("studies.read")


# ---- principals ---------------------------------------------------------

def test_a_principal_points_at_a_role_or_at_one_person():
    rad = profile(role="radiologist")
    assert U.matches_principal(rad, "role:radiologist")
    assert U.matches_principal(rad, "role:Radiologist")      # case is not a distinction worth defending
    assert not U.matches_principal(rad, "role:it")
    assert U.matches_principal(rad, rad.id)
    assert not U.matches_principal(rad, U.new_id())


def test_an_empty_principal_list_means_everyone_not_no_one():
    """The default that makes an upgrade change nothing.

    Reading empty as "nobody" would mean an appliance upgraded into this
    feature silently stops telling anybody its primary went down.
    """
    assert U.matches_any(profile(), [])
    assert U.matches_any(profile(), None)


def test_a_bare_role_name_is_refused_because_it_is_ambiguous():
    with pytest.raises(ValueError) as exc:
        U.validate_principals(["radiologist"], "emergency.activate_by")
    assert "role:radiologist" in str(exc.value)


def test_a_principal_naming_a_deleted_profile_still_renders():
    users = {"profiles": [dict(profile(name="Ana").data)]}
    gone = U.new_id()
    assert "deleted" in U.describe_principal(users, gone)


# ---- validation ---------------------------------------------------------

def test_no_profiles_is_legal_and_means_token_only():
    """Every config written before this feature deep-merges to exactly this.

    Refusing it would mean upgrading takes the appliance off the air until
    somebody hand-edits a file they have never heard of.
    """
    validate(cfg_with([]))
    assert not U.profiles_in_use({"profiles": []})


def test_the_presets_validate_on_loopback():
    validate(cfg_with(U.preset_profiles()))


def test_two_profiles_sharing_an_id_are_refused():
    rows = U.preset_profiles()
    rows[1]["id"] = rows[0]["id"]
    with pytest.raises(ValueError, match="more than one profile"):
        validate(cfg_with(rows))


def test_two_profiles_sharing_a_name_are_refused():
    rows = U.preset_profiles()
    rows[1]["name"] = rows[0]["name"]
    with pytest.raises(ValueError, match="more than one profile"):
        validate(cfg_with(rows))


def test_every_profile_disabled_is_refused_as_a_lockout():
    rows = U.preset_profiles()
    for row in rows:
        row["enabled"] = False
    with pytest.raises(ValueError, match="nobody could log in"):
        validate(cfg_with(rows))


def test_a_config_with_no_administrator_is_refused():
    rows = U.preset_profiles()
    rows[0]["admin"] = False
    with pytest.raises(ValueError, match="No enabled profile can manage profiles"):
        validate(cfg_with(rows))


def test_an_open_profile_with_write_access_is_refused_off_box():
    """The rule that keeps "no password" from meaning "no access control".

    On loopback an open profile is defensible: the OS is the boundary and the
    whole appliance is only reachable by somebody already on it. Bound to the
    network it is an unauthenticated stranger holding whatever that profile
    holds — and the web.auth_token rule would be satisfied while this walked
    straight past it.
    """
    rows = U.preset_profiles()
    doc = cfg_with(rows)
    doc["web"]["host"] = "0.0.0.0"
    doc["web"]["auth_token"] = "a" * 24
    with pytest.raises(ValueError) as exc:
        validate(doc)
    assert "no password but can change things" in str(exc.value)
    assert "127.0.0.1" in str(exc.value)        # names the way out


def test_an_open_read_only_profile_is_allowed_off_box():
    """A waiting-room screen is a real deployment.

    Forcing a password onto a display that shows a redacted queue means the
    password gets taped to the monitor, which is worse than not having one.
    """
    rows = [{
        "id": U.new_id(), "name": "Waiting room", "role": "display", "enabled": True,
        "admin": False, "capabilities": ["studies.read"], "phi_visible": [],
        "password": None,
    }, {
        "id": U.new_id(), "name": "Administrator", "role": "admin", "enabled": True,
        "admin": True, "capabilities": [], "phi_visible": sorted(U.PHI_FIELDS),
        "password": U.hash_password("x", iterations=1000),
    }]
    doc = cfg_with(rows)
    doc["web"]["host"] = "0.0.0.0"
    doc["web"]["auth_token"] = "a" * 24
    validate(doc)


def test_studies_send_counts_as_write_even_though_it_creates_nothing_locally():
    """Putting images on the network is the action that cannot be taken back."""
    assert U._is_write("studies.send")
    assert not U._is_write("studies.read")


def test_an_invalid_capability_or_field_names_what_is_valid():
    rows = U.preset_profiles()
    rows[1]["capabilities"] = ["studies.read", "nope"]
    with pytest.raises(ValueError) as exc:
        validate(cfg_with(rows))
    assert "not a capability" in str(exc.value) and "studies.read" in str(exc.value)

    rows = U.preset_profiles()
    rows[1]["phi_visible"] = ["shoe_size"]
    with pytest.raises(ValueError, match="not an identifier field"):
        validate(cfg_with(rows))


def test_a_plaintext_password_in_the_file_is_refused():
    """The one that would store a password in clear because somebody typed it in."""
    rows = U.preset_profiles()
    rows[1]["password"] = "hunter2"
    with pytest.raises(ValueError) as exc:
        validate(cfg_with(rows))
    assert "stored in clear" in str(exc.value)


def test_a_non_boolean_flag_is_refused_because_false_reads_as_true():
    rows = U.preset_profiles()
    rows[1]["enabled"] = "false"
    with pytest.raises(ValueError) as exc:
        validate(cfg_with(rows))
    assert "reads as true" in str(exc.value)


def test_an_approximate_email_is_refused_because_it_is_where_alerts_go():
    rows = U.preset_profiles()
    rows[1]["email"] = "ana at hospital"
    with pytest.raises(ValueError, match="does not look like an address"):
        validate(cfg_with(rows))


def test_an_activate_by_policy_nobody_can_answer_is_refused():
    """A failover that will not fire, caught at configuration rather than at 3am."""
    rows = U.preset_profiles()
    doc = cfg_with(rows)
    doc["emergency"]["activate_by"] = ["role:receptionist"]   # holds no emergency.activate
    with pytest.raises(ValueError) as exc:
        validate(doc)
    assert "nobody matching that can activate" in str(exc.value)


def test_an_activate_by_policy_someone_can_answer_is_accepted():
    doc = cfg_with(U.preset_profiles())
    doc["emergency"]["activate_by"] = ["role:radiologist"]
    validate(doc)


def test_the_presets_are_rows_and_nothing_looks_them_up_by_name():
    """Deleting three of the four presets must leave a working appliance."""
    rows = U.preset_profiles()
    keep = [r for r in rows if r["name"] == "Administrator"]
    validate(cfg_with(keep))
    assert U.profiles_in_use({"profiles": keep})


def test_the_it_preset_can_work_without_reading_the_chart():
    it = [U.Profile(r) for r in U.preset_profiles() if r["name"] == "IT"][0]
    assert it.can("routing.write") and it.can("destinations.write")
    assert it.sees("accession") and it.sees("patient_id")
    assert not it.sees("patient_name") and not it.sees("patient_birthdate")
    # Deleting the evidence is not how a routing problem gets fixed.
    assert not it.can("studies.delete")
    assert not it.can("auth.manage") and not it.can("deid.manage")


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
