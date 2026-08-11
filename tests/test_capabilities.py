"""Capability enforcement at the HTTP layer, against the real create_app().

Runs under pytest, or standalone: python3 tests/test_capabilities.py

This is the suite that matters most, because it tests the thing a browser
cannot be trusted to do. Every check here is about the SERVER: what it refuses,
and — the half that is easy to forget — what it never sends in the first place.
A panel hidden in app.js while its data still arrives is not access control, it
is a cosmetic that reads like one.

Two classes of test:

  * refusals — 403 with a named capability, so the operator learns what to ask
    for rather than filing a bug about a broken button;
  * non-disclosure — the payload for a restricted profile does not contain the
    values it was not granted, asserted by searching the serialised response
    rather than by reading the keys the endpoint meant to send.

The second is deliberately paranoid. A regression that leaks a patient name
under a new spelling passes every key-by-key assertion and fails a substring
search, and the substring search is the one that matches how a leak is actually
found.
"""

from __future__ import annotations

import copy
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest                                            # noqa: E402

from pacs import users as U                              # noqa: E402
from pacs.web import create_app                          # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_web_auth import FakeServer, WRITE              # noqa: E402


@pytest.fixture()
def app_and_ids(tmp_path):
    srv = FakeServer(str(tmp_path))
    with srv.cfg.mutate():
        srv.cfg.users["profiles"] = U.preset_profiles()
        srv.cfg.save()
    app = create_app(srv)
    ids = {p["name"]: p["id"] for p in srv.cfg.users["profiles"]}
    return app, ids, srv


def signed_in(app, ids, name):
    client = app.test_client()
    resp = client.post("/api/login", json={"profile": ids[name]}, headers=WRITE)
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return client


# ---- refusals -----------------------------------------------------------

# (profile, method, path, body) -> expected status. 403 is "you are known and
# not permitted"; anything 2xx/4xx-other means the gate let it reach the
# handler, which is what these rows assert about the ones that should pass.
DENIED = [
    ("Reception", "post", "/api/shutdown", None),
    ("Reception", "post", "/api/studies/delete", {"path": "x"}),
    ("Reception", "get", "/api/config", None),
    ("Reception", "post", "/api/receiver", {"action": "stop"}),
    ("Reception", "get", "/api/routing", None),
    ("Reception", "get", "/api/audit", None),
    ("Reception", "get", "/api/profiles/manage", None),
    ("IT", "post", "/api/shutdown", None),
    ("IT", "post", "/api/studies/delete", {"path": "x"}),
    ("IT", "get", "/api/ris/orders", None),
    ("IT", "get", "/api/profiles/manage", None),
    ("IT", "post", "/api/deid/secret", {"action": "clear"}),
    ("Radiologist", "get", "/api/config", None),
    ("Radiologist", "post", "/api/receiver", {"action": "stop"}),
    ("Radiologist", "post", "/api/studies/delete", {"path": "x"}),
    ("Radiologist", "get", "/api/profiles/manage", None),
]


@pytest.mark.parametrize("who,method,path,body", DENIED)
def test_the_presets_are_refused_what_they_do_not_hold(app_and_ids, who, method, path, body):
    app, ids, _srv = app_and_ids
    client = signed_in(app, ids, who)
    resp = getattr(client, method)(path, json=body, headers=WRITE) if body is not None \
        else getattr(client, method)(path, headers=WRITE)
    assert resp.status_code == 403, f"{who} {method.upper()} {path} -> {resp.status_code}"


def test_a_refusal_names_the_capability_so_the_operator_can_ask_for_it(app_and_ids):
    app, ids, _srv = app_and_ids
    client = signed_in(app, ids, "Reception")
    body = client.post("/api/shutdown", headers=WRITE).get_json()
    assert body["forbidden"]["capability"] == "system.shutdown"
    assert body["forbidden"]["profile"] == "Reception"


def test_an_administrator_is_refused_nothing_on_capability_grounds(app_and_ids):
    """Every refusal above must be about the capability, not about the endpoint.

    Two endpoints 403 an administrator for a different and pre-existing reason:
    rotating the token and changing the de-identification site key demand the
    raw token rather than a session cookie, because a cookie must not be enough
    to replace the secret that issued it. That is a separate control and stays,
    so this asserts the refusal is not a CAPABILITY refusal rather than that
    there is none.
    """
    app, ids, _srv = app_and_ids
    client = signed_in(app, ids, "Administrator")
    for _who, method, path, body in DENIED:
        resp = getattr(client, method)(path, json=body, headers=WRITE) if body is not None \
            else getattr(client, method)(path, headers=WRITE)
        if resp.status_code != 403:
            continue
        payload = resp.get_json() or {}
        assert "forbidden" not in payload, \
            f"admin refused {method.upper()} {path} on capability grounds: {payload}"


# ---- the escalation paths out of config.write ---------------------------

def test_config_write_cannot_grant_itself_admin(app_and_ids):
    """The reason POST /api/config re-asserts the stored profile list.

    IT holds config.write. Without this, posting a document with an extra admin
    row in `users` would be a two-line path from "can edit settings" to "can do
    anything", and the endpoint that took it would report success.
    """
    app, ids, srv = app_and_ids
    client = signed_in(app, ids, "IT")
    doc = client.get("/api/config")
    assert doc.status_code == 200
    body = doc.get_json()
    body["users"] = {"profiles": [{
        "id": U.new_id(), "name": "Backdoor", "role": "x", "enabled": True,
        "admin": True, "capabilities": [], "phi_visible": [], "password": None,
    }], "list_profiles": True}
    resp = client.post("/api/config", json=body, headers=WRITE)
    assert resp.status_code == 400
    assert "users.profiles cannot be set from here" in resp.get_json()["error"]
    names = [p.name for p in U.profiles_of(srv.cfg.users)]
    assert "Backdoor" not in names


def test_a_save_that_omits_users_does_not_delete_every_profile(app_and_ids):
    """cfg.replace() merges over DEFAULTS, where users.profiles is [].

    A dashboard Save is built from a page-load snapshot of a redacted GET, so it
    does not carry the section. Without the server re-asserting it, one Settings
    Save would delete every profile on the appliance and switch access control
    off — reported as success.
    """
    app, ids, srv = app_and_ids
    client = signed_in(app, ids, "Administrator")
    body = client.get("/api/config").get_json()
    body.pop("users", None)
    assert client.post("/api/config", json=body, headers=WRITE).status_code == 200
    assert len(U.profiles_of(srv.cfg.users)) == 4
    assert U.profiles_in_use(srv.cfg.users)


def test_config_write_cannot_turn_de_identification_off(app_and_ids):
    """Turning the profile off is how a study a rule promised to scrub reaches
    a research node identified. That is not part of "edit the config"."""
    app, ids, srv = app_and_ids
    client = signed_in(app, ids, "IT")
    body = client.get("/api/config").get_json()
    body["deid"]["profile"] = "off"
    resp = client.post("/api/config", json=body, headers=WRITE)
    assert resp.status_code == 403
    assert resp.get_json()["forbidden"]["capability"] == "deid.manage"
    assert srv.cfg.deid.get("profile") != "off"


def test_config_write_may_still_change_ordinary_settings(app_and_ids):
    """The refusals above must not have made the capability useless."""
    app, ids, srv = app_and_ids
    client = signed_in(app, ids, "IT")
    body = client.get("/api/config").get_json()
    body["scp"]["aet"] = "RENAMEDAET"
    assert client.post("/api/config", json=body, headers=WRITE).status_code == 200
    assert srv.cfg.scp["aet"] == "RENAMEDAET"


def test_a_save_that_leaves_deid_alone_needs_no_deid_manage(app_and_ids):
    app, ids, _srv = app_and_ids
    client = signed_in(app, ids, "IT")
    body = client.get("/api/config").get_json()
    assert client.post("/api/config", json=body, headers=WRITE).status_code == 200


# ---- non-disclosure -----------------------------------------------------

def test_the_config_document_never_carries_password_material(app_and_ids):
    """IT holds config.read and deliberately does NOT hold auth.manage.

    A stored PBKDF2 record handed to somebody who may not manage accounts is an
    offline cracking target against their colleagues' passwords.
    """
    app, ids, srv = app_and_ids
    with srv.cfg.mutate():
        srv.cfg.users["profiles"][3]["password"] = U.hash_password("front-desk", iterations=1000)
        srv.cfg.save()
    stored = srv.cfg.users["profiles"][3]["password"]
    client = signed_in(app, ids, "IT")
    raw = client.get("/api/config").get_data(as_text=True)
    assert stored["hash"] not in raw
    assert stored["salt"] not in raw
    # …and the administrator's editor still gets what it needs to render.
    admin = signed_in(app, ids, "Administrator")
    rows = admin.get("/api/profiles/manage").get_json()["profiles"]
    reception = [r for r in rows if r["name"] == "Reception"][0]
    assert reception["locked"] is True
    assert "password" not in reception


def test_the_picker_publishes_names_and_nothing_else(app_and_ids):
    app, ids, srv = app_and_ids
    with srv.cfg.mutate():
        srv.cfg.users["profiles"][1]["email"] = "it@hospital.test"
        srv.cfg.save()
    rows = app.test_client().get("/api/profiles").get_json()["profiles"]
    assert {"id", "name", "role", "locked"} == set(rows[0])
    assert "it@hospital.test" not in json.dumps(rows)


def test_hiding_the_picker_hides_it(app_and_ids):
    app, ids, srv = app_and_ids
    with srv.cfg.mutate():
        srv.cfg.users["list_profiles"] = False
        srv.cfg.save()
    body = app.test_client().get("/api/profiles").get_json()
    assert body["profiles"] == [] and body["listed"] is False
    # Still says profiles ARE in use, so the gate knows to draw a login at all.
    assert body["enabled"] is True


def test_status_is_composed_per_profile_not_filtered_in_the_browser(app_and_ids):
    app, ids, srv = app_and_ids

    def status_for(name):
        return signed_in(app, ids, name).get("/api/status").get_json()

    reception = status_for("Reception")
    assert "destinations" not in reception
    assert "config_path" not in reception
    assert "routing" not in reception

    it = status_for("IT")
    assert "destinations" in it
    assert "config_path" in it
    assert "ris" not in it              # carries the last order's identity

    admin = status_for("Administrator")
    assert "destinations" in admin and "ris" in admin and "config_path" in admin


def test_a_restricted_profile_is_refused_dicomweb_rather_than_served_identifiers(app_and_ids):
    """QIDO answers in DICOM tag keys and WADO in raw Part 10 bytes, so the
    identifier redactor cannot reach either. Serving them anyway would make the
    per-field policy true on one surface and false on another."""
    app, ids, _srv = app_and_ids
    client = signed_in(app, ids, "IT")
    resp = client.get("/dicom-web/studies")
    assert resp.status_code == 403
    body = resp.get_json()
    assert "patient_name" in body["forbidden"]["withheld"]
    assert "redaction" in body["detail"]

    # Somebody unrestricted gets through the gate (503 = the service is off,
    # which is the handler answering, not the guard).
    rad = signed_in(app, ids, "Radiologist")
    assert rad.get("/dicom-web/studies").status_code != 403


def test_an_audit_export_is_refused_to_a_restricted_profile(app_and_ids):
    """An export must carry the records exactly as written or the chain cannot
    be checked against it — so it cannot be redacted, so it is refused."""
    app, ids, _srv = app_and_ids
    client = signed_in(app, ids, "IT")
    assert client.get("/api/audit").status_code == 200          # reading is fine
    resp = client.get("/api/audit/export")
    assert resp.status_code == 403
    assert "cannot be checked" in resp.get_json()["detail"]


def test_an_audit_export_refuses_rather_than_handing_over_a_short_trail(app_and_ids):
    """An export is evidence, and a silently short one is indistinguishable from
    a complete one to the person it is handed to. Refusing is the only answer
    that leaves them able to tell."""
    app, ids, srv = app_and_ids
    srv.audit.record("login", actor=None)
    live = srv.audit.path
    os.remove(live)
    os.makedirs(live)                   # denial that also holds on Windows
    client = signed_in(app, ids, "Administrator")
    resp = client.get("/api/audit/export")
    assert resp.status_code == 503, "a trail with a hole in it was exported as complete"
    body = resp.get_json()
    assert body["ok"] is False
    assert "could not be read" in body["detail"]


def test_an_audit_target_carrying_a_patient_id_follows_the_same_policy(app_and_ids):
    """The storage layout puts the PatientID in a study's path, so a target is
    an identifier wearing a different key name. The generic redactor cannot see
    that, and this is the endpoint built to prove access control works."""
    app, ids, srv = app_and_ids
    with srv.cfg.mutate():
        # Narrow IT to the accession only, so patient_id becomes withheld.
        srv.cfg.users["profiles"][1]["phi_visible"] = ["accession"]
        srv.cfg.save()
    admin = signed_in(app, ids, "Administrator")
    admin.post("/api/studies/delete", json={"path": "received/P-99120/1.2.3"}, headers=WRITE)
    client = signed_in(app, ids, "IT")
    raw = client.get("/api/audit").get_data(as_text=True)
    assert "P-99120" not in raw


# ---- backward compatibility ---------------------------------------------

def test_an_appliance_with_no_profiles_behaves_exactly_as_before(tmp_path):
    """The upgrade path. Every config written before this feature deep-merges
    to an empty profile list, and must keep working with no login at all."""
    srv = FakeServer(str(tmp_path))
    app = create_app(srv)
    client = app.test_client()
    assert client.get("/api/status").status_code == 200
    assert client.get("/api/config").status_code == 200
    assert client.post("/api/receiver", json={"action": "stop"}, headers=WRITE).status_code != 403
    who = client.get("/api/status").get_json()["auth"]
    assert who["profiles"] is False
    assert who["required"] is False


def test_the_shared_token_still_authenticates_as_an_administrator(tmp_path):
    """Every machine client holds it — the DICOMweb viewer, the tray shell,
    whatever script somebody wrote. Turning profiles on must not break them."""
    srv = FakeServer(str(tmp_path))
    with srv.cfg.mutate():
        srv.cfg.users["profiles"] = U.preset_profiles()
        srv.cfg.web["auth_token"] = "t" * 32
        srv.cfg.save()
    app = create_app(srv)
    client = app.test_client()
    auth = {"Authorization": "Bearer " + "t" * 32, **WRITE}
    assert client.get("/api/status", headers=auth).status_code == 200
    assert client.get("/api/config", headers=auth).status_code == 200
    who = client.get("/api/status", headers=auth).get_json()["auth"]["who"]
    assert who["admin"] is True and who["service"] is True


def test_turning_profiles_on_makes_a_credential_mandatory(tmp_path):
    """Otherwise seeding profiles on a loopback box — the common case, and the
    one the whole feature is for — produces a picker anyone can walk past."""
    srv = FakeServer(str(tmp_path))
    app = create_app(srv)
    anon = app.test_client()
    assert anon.get("/api/status").status_code == 200        # before
    with srv.cfg.mutate():
        srv.cfg.users["profiles"] = U.preset_profiles()
        srv.cfg.save()
    assert anon.get("/api/status").status_code == 401        # after


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
