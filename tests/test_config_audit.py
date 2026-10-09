"""POST /api/config: what the audit record says changed, and the routing /
destinations write capabilities. Plus the routing dry-run of a DRAFT rule list.

Driven against the real create_app() with the stub server from test_web_auth.

Runs under pytest, or standalone: python3 tests/test_config_audit.py
"""

from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pacs import audit                                   # noqa: E402
from pacs import users as U                              # noqa: E402
from pacs.web import create_app                          # noqa: E402
from test_web_auth import WRITE, FakeServer, make        # noqa: E402

NODE_A = {"name": "PACS-A", "host": "10.0.0.5", "port": 104, "aet": "PACSA",
          "enabled": True}
NODE_B = {"name": "PACS-B", "host": "10.0.0.6", "port": 104, "aet": "PACSB",
          "enabled": True}


def _setup(strip_from_it=()):
    srv = FakeServer(tempfile.mkdtemp(prefix="carino-cfg-audit-"))
    profiles = U.preset_profiles()
    for p in profiles:
        if p["name"] == "IT":
            p["capabilities"] = [c for c in p["capabilities"] if c not in strip_from_it]
    with srv.cfg.mutate():
        srv.cfg.users["profiles"] = profiles
        srv.cfg.data["destinations"] = [dict(NODE_A)]
        srv.cfg.save()
    app = create_app(srv)
    ids = {p["name"]: p["id"] for p in profiles}
    client = app.test_client()
    r = client.post("/api/login", json={"profile": ids["IT"]}, headers=WRITE)
    assert r.status_code == 200, r.get_data(as_text=True)
    return srv, client


def _last_config_record(srv):
    rows = srv.audit.tail(20, action=audit.CONFIG_CHANGED)
    assert rows, "no config.changed record"
    return rows[0]


# ---- the detail ------------------------------------------------------------

def test_config_changes_names_sections_and_nodes():
    stored = {"scp": {"aet": "A"}, "destinations": [NODE_A],
              "routing": {"enabled": True, "rules": [{"name": "r1"}]}}
    incoming = {"scp": {"aet": "B"}, "destinations": [NODE_B],
                "routing": {"enabled": True, "rules": [{"name": "r1"}, {"name": "r2"}]}}
    change = audit.config_changes(stored, incoming)
    assert {"scp", "destinations", "routing"} <= set(change["sections"])
    assert change["destinations_added"] == ["PACS-B"]
    assert change["destinations_removed"] == ["PACS-A"]
    assert change["rules_added"] == ["r2"]
    assert "rules_removed" not in change


def test_a_round_trip_save_changes_nothing_and_says_so():
    srv, c = _setup()
    body = c.get("/api/config").get_json()
    assert c.post("/api/config", json=body, headers=WRITE).status_code == 200
    rec = _last_config_record(srv)
    assert rec["outcome"] == "ok"
    assert rec["detail"]["sections"] == []


def test_the_record_names_the_destination_added_and_removed():
    srv, c = _setup()
    body = c.get("/api/config").get_json()
    body["destinations"] = [dict(NODE_B)]
    r = c.post("/api/config", json=body, headers=WRITE)
    assert r.status_code == 200, r.get_json()
    detail = _last_config_record(srv)["detail"]
    assert detail["sections"] == ["destinations"]
    assert detail["destinations_added"] == ["PACS-B"]
    assert detail["destinations_removed"] == ["PACS-A"]
    # Names only: the host is configuration, not a decision.
    assert "10.0.0.6" not in str(detail)


def test_an_ordinary_change_lists_its_section():
    srv, c = _setup()
    body = c.get("/api/config").get_json()
    body["scp"]["aet"] = "RENAMED"
    assert c.post("/api/config", json=body, headers=WRITE).status_code == 200
    assert _last_config_record(srv)["detail"]["sections"] == ["scp"]


# ---- routing.write / destinations.write ------------------------------------

def test_config_write_without_destinations_write_cannot_change_destinations():
    srv, c = _setup(strip_from_it=("destinations.write",))
    body = c.get("/api/config").get_json()
    body["destinations"].append(dict(NODE_B))
    r = c.post("/api/config", json=body, headers=WRITE)
    assert r.status_code == 403
    assert r.get_json()["forbidden"]["capability"] == "destinations.write"
    assert [d["name"] for d in srv.cfg.destinations] == ["PACS-A"]


def test_config_write_without_routing_write_cannot_change_rules():
    srv, c = _setup(strip_from_it=("routing.write",))
    body = c.get("/api/config").get_json()
    body["routing"]["rules"] = [{"name": "r", "match": {"modality": "CT"},
                                 "destinations": ["PACS-A"]}]
    r = c.post("/api/config", json=body, headers=WRITE)
    assert r.status_code == 403
    assert r.get_json()["forbidden"]["capability"] == "routing.write"
    assert not srv.cfg.routing.get("rules")


def test_without_either_capability_ordinary_settings_still_save():
    srv, c = _setup(strip_from_it=("routing.write", "destinations.write"))
    body = c.get("/api/config").get_json()
    body["scp"]["aet"] = "STILLOK"
    assert c.post("/api/config", json=body, headers=WRITE).status_code == 200
    assert srv.cfg.scp["aet"] == "STILLOK"


def test_the_it_preset_holds_both_and_may_change_both():
    srv, c = _setup()
    body = c.get("/api/config").get_json()
    body["destinations"].append(dict(NODE_B))
    body["routing"]["rules"] = [{"name": "r", "match": {}, "destinations": ["PACS-B"]}]
    assert c.post("/api/config", json=body, headers=WRITE).status_code == 200
    assert len(srv.cfg.destinations) == 2


def test_rule_match_values_are_shown_and_survive_a_save():
    # IT may not see study descriptions, but a rule's pattern is configuration.
    srv, c = _setup(strip_from_it=("routing.write",))
    with srv.cfg.mutate():
        srv.cfg.data["routing"] = {"enabled": True, "rules": [
            {"name": "r1", "match": {"study_desc": "CHEST*", "patient_name": "TEST^*"},
             "destinations": ["PACS-A"]}]}
        srv.cfg.save()
    body = c.get("/api/config").get_json()
    assert body["routing"]["rules"][0]["match"] == {"study_desc": "CHEST*",
                                                    "patient_name": "TEST^*"}
    body["scp"]["aet"] = "RENAMED"
    r = c.post("/api/config", json=body, headers=WRITE)
    assert r.status_code == 200, r.get_json()
    assert srv.cfg.routing["rules"][0]["match"]["study_desc"] == "CHEST*"
    assert _last_config_record(srv)["detail"]["sections"] == ["scp"]
    # The Save's response is redacted too, and keeps the rule as well.
    assert r.get_json()["config"]["routing"]["rules"][0]["match"]["study_desc"] == "CHEST*"
    # Patient data under the same key names elsewhere is still withheld.
    prof = U.Profile({"id": "u_000000000001", "name": "x", "capabilities": [],
                      "phi_visible": [], "enabled": True})
    out = U.redact({"items": [{"study_desc": "Head CT"}],
                    "rules": [{"match": {"study_desc": "CHEST*"}, "study_desc": "x"}]}, prof)
    assert out["items"][0]["study_desc"] == U.REDACTED
    assert out["rules"][0]["match"]["study_desc"] == "CHEST*"
    assert out["rules"][0]["study_desc"] == U.REDACTED


def test_flags_the_dashboard_fills_in_are_not_a_destination_change():
    # The stored row has no tls/no_ris/emergency_trigger/ephemeral; the
    # dashboard posts every one back as false.
    srv, c = _setup(strip_from_it=("destinations.write",))
    body = c.get("/api/config").get_json()
    body["destinations"][0].update(tls=False, no_ris=False, emergency_trigger=False,
                                   ephemeral=False)
    body["scp"]["aet"] = "RENAMED"
    r = c.post("/api/config", json=body, headers=WRITE)
    assert r.status_code == 200, r.get_json()
    assert _last_config_record(srv)["detail"]["sections"] == ["scp"]
    # A flag that really moved still counts.
    body = c.get("/api/config").get_json()
    body["destinations"][0]["tls"] = True
    r = c.post("/api/config", json=body, headers=WRITE)
    assert r.status_code == 403
    assert audit.config_changes({"destinations": [dict(NODE_A)]},
                                {"destinations": [dict(NODE_A, tls=True)]}
                                )["destinations_changed"] == ["PACS-A"]


# ---- routing dry-run of a draft ---------------------------------------------

def _routing_setup():
    srv, c = _setup()
    with srv.cfg.mutate():
        srv.cfg.data["destinations"] = [dict(NODE_A), dict(NODE_B)]
        srv.cfg.data["routing"] = {"enabled": True, "rules": [
            {"name": "saved", "match": {"modality": "CT"}, "destinations": ["PACS-A"]}]}
        srv.cfg.save()
    return srv, c


def test_routing_test_uses_the_saved_rules_by_default():
    _srv, c = _routing_setup()
    r = c.post("/api/routing/test", json={"modality": "CT"}, headers=WRITE)
    assert r.status_code == 200
    assert r.get_json()["decision"]["destinations"] == ["PACS-A"]


def test_routing_test_can_try_a_draft_without_saving_it():
    srv, c = _routing_setup()
    draft = [{"name": "draft", "match": {"modality": "CT"}, "destinations": ["PACS-B"]}]
    r = c.post("/api/routing/test", json={"modality": "CT", "rules": draft}, headers=WRITE)
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["decision"]["destinations"] == ["PACS-B"]
    # Nothing was saved.
    assert srv.cfg.routing["rules"][0]["name"] == "saved"


def test_routing_test_refuses_a_draft_a_save_would_refuse():
    _srv, c = _routing_setup()
    r = c.post("/api/routing/test", headers=WRITE,
               json={"modality": "CT", "rules": [{"match": {}, "destinations": []}]})
    assert r.status_code == 400
    assert r.get_json()["field"] == "rules"
    r = c.post("/api/routing/test", headers=WRITE, json={"modality": "CT", "rules": "x"})
    assert r.status_code == 400


def test_routing_test_checks_a_draft_even_when_the_stored_config_is_invalid():
    srv, c = _routing_setup()
    with srv.cfg.mutate():
        srv.cfg.data["scp"]["port"] = 70000          # hand-edited, already invalid
        srv.cfg.save()
    for bad in ([5], [{"name": "r", "match": "CT", "destinations": []}],
                [{"match": {}, "destinations": []}],
                [{"name": "r", "match": {}, "destinations": "PACS-A"}]):
        r = c.post("/api/routing/test", headers=WRITE, json={"modality": "CT", "rules": bad})
        assert r.status_code == 400, (bad, r.status_code)
        assert r.get_json()["field"] == "rules"
    good = [{"name": "draft", "match": {"modality": "CT"}, "destinations": ["PACS-B"]}]
    r = c.post("/api/routing/test", headers=WRITE, json={"modality": "CT", "rules": good})
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["decision"]["destinations"] == ["PACS-B"]


# ---- one act, one record -----------------------------------------------------

def test_a_self_recording_endpoint_is_not_recorded_twice():
    # /api/profiles/listing writes its own config.changed record; the generic
    # recorder used to add a second "api.profiles.listing" row for the same act.
    srv, _app, c = make(tempfile.mkdtemp(prefix="carino-cfg-audit-"), token="t0ken")
    auth = {**WRITE, "Authorization": "Bearer t0ken"}
    r = c.post("/api/profiles/listing", json={"list_profiles": False}, headers=auth)
    assert r.status_code == 200, r.get_data(as_text=True)
    rows = [x for x in srv.audit.tail(50) if x["action"] != audit.LOGIN]
    assert [x["action"] for x in rows] == [audit.CONFIG_CHANGED], rows
    assert rows[0]["target"] == "users.list_profiles"


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
