"""Who may answer a failover, and who has already answered it.

Runs under pytest, or standalone: python3 tests/test_emergency_authority.py

Two behaviours, both new, both about the same outage being three different
questions to three different people.

**Who may activate** is a policy the administrator writes — a role, a named
person, or nobody because the appliance does it automatically. It is checked
alongside the capability rather than instead of it: the capability says "this is
the kind of person who makes failover calls at all", the policy says "and the
administrator designated them for THIS appliance".

**Who has acknowledged** used to be one boolean, and the boolean was the defect
this file exists to keep fixed. A receptionist clearing a pop-up they could do
nothing about took it off the radiologist's screen and off IT's at the same
time — and the radiologist is the one who was going to push the study to an
alternate node.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest                                            # noqa: E402

from pacs import users as U                              # noqa: E402
from pacs.config import Config                           # noqa: E402
from pacs.emergency import EmergencyController, IDLE, TRIGGERED   # noqa: E402
from pacs.logbuf import LogBuffer                        # noqa: E402


class FakeServer:
    """Only what the controller reaches for while it is deciding things."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.notifier = None
        self.mwl_started = 0
        self.watcher = type("W", (), {"running": True})()

    def stuck_sends(self):
        return {"destinations": []}

    def start_mwl(self):
        self.mwl_started += 1

    def stop_mwl(self):
        pass

    def start_watcher(self):
        pass

    def retry_stuck(self):
        return {"reset": 0}


@pytest.fixture()
def ctl(tmp_path):
    cfg = Config(str(tmp_path / "config.json")).load()
    with cfg.mutate():
        cfg.users["profiles"] = U.preset_profiles()
        cfg.emergency["armed"] = True
    controller = EmergencyController(FakeServer(cfg), LogBuffer())
    controller.state = TRIGGERED
    controller.trigger_dest = "Primary PACS"
    return controller


def who(ctl):
    return {p.role: p for p in U.profiles_of(ctl.server.cfg.users)}


# ---- who may activate ---------------------------------------------------

def test_with_no_policy_anyone_holding_the_capability_may_activate(ctl):
    """The default, and what every appliance upgraded into this feature has."""
    people = who(ctl)
    assert ctl.may_activate(people["radiologist"])
    assert ctl.may_activate(people["admin"])
    # Reception holds no emergency.activate, so the capability still governs.
    assert not ctl.may_activate(people["receptionist"])


def test_a_role_policy_narrows_it_to_that_role(ctl):
    with ctl.server.cfg.mutate():
        ctl.server.cfg.emergency["activate_by"] = ["role:radiologist"]
    people = who(ctl)
    assert ctl.may_activate(people["radiologist"])
    assert not ctl.may_activate(people["it"])
    # Including the administrator, who wrote the policy. Honouring it literally
    # is the point: they said who decides. They can always change it back, and
    # the audit trail then shows they did — which is what accountability means.
    assert not ctl.may_activate(people["admin"])


def test_a_policy_can_name_one_person(ctl):
    people = who(ctl)
    with ctl.server.cfg.mutate():
        ctl.server.cfg.emergency["activate_by"] = [people["radiologist"].id]
    assert ctl.may_activate(people["radiologist"])
    assert not ctl.may_activate(people["admin"])


def test_the_policy_never_grants_what_the_capability_withholds(ctl):
    """Designation is a narrowing, not a grant.

    Naming a profile that cannot reach the endpoint would produce a button that
    fails when pressed, which is worse than one that is not there.
    """
    people = who(ctl)
    with ctl.server.cfg.mutate():
        ctl.server.cfg.emergency["activate_by"] = [people["receptionist"].id]
    assert not ctl.may_activate(people["receptionist"])


def test_an_appliance_without_profiles_lets_whoever_is_there_decide(ctl):
    assert ctl.may_activate(None)


def test_the_banner_says_who_can_answer_when_you_cannot(ctl):
    with ctl.server.cfg.mutate():
        ctl.server.cfg.emergency["activate_by"] = ["role:radiologist"]
    status = ctl.status(who(ctl)["it"])
    assert status["may_activate"] is False
    assert status["activate_by"] == ["anyone with the radiologist role"]


# ---- who is told --------------------------------------------------------

def test_everyone_is_told_by_default(ctl):
    for profile in U.profiles_of(ctl.server.cfg.users):
        assert ctl.status(profile)["prompt"] is True, profile.name


def test_a_notify_policy_narrows_who_sees_the_prompt(ctl):
    with ctl.server.cfg.mutate():
        ctl.server.cfg.emergency["notify"] = ["role:radiologist", "role:it"]
    people = who(ctl)
    assert ctl.status(people["radiologist"])["prompt"] is True
    assert ctl.status(people["it"])["prompt"] is True
    assert ctl.status(people["receptionist"])["prompt"] is False


def test_the_audience_is_profiles_so_a_message_can_respect_what_they_see(ctl):
    with ctl.server.cfg.mutate():
        ctl.server.cfg.emergency["notify"] = ["role:radiologist"]
    audience = ctl.audience()
    assert [p.name for p in audience] == ["Radiologist"]
    assert hasattr(audience[0], "phi_visible")


# ---- who has already answered -------------------------------------------

def test_one_person_acknowledging_does_not_silence_anybody_else(ctl):
    """The defect, kept fixed.

    Three people are being asked three different questions about one outage.
    Reception clearing a pop-up they can do nothing about must not take it off
    the radiologist's screen — they are the one who was going to push the study
    somewhere it could be read.
    """
    people = who(ctl)
    ctl.dismiss(people["receptionist"])
    assert ctl.status(people["receptionist"])["prompt"] is False
    assert ctl.status(people["radiologist"])["prompt"] is True
    assert ctl.status(people["it"])["prompt"] is True


def test_acknowledgement_is_per_person_not_per_role(ctl):
    """Two radiologists on shift are two people, and one of them acknowledging
    is not the other one knowing."""
    with ctl.server.cfg.mutate():
        rows = ctl.server.cfg.users["profiles"]
        rows.append({
            "id": U.new_id(), "name": "Second radiologist", "role": "radiologist",
            "enabled": True, "admin": False,
            "capabilities": ["studies.read", "emergency.activate"],
            "phi_visible": sorted(U.PHI_FIELDS), "password": None,
        })
    both = [p for p in U.profiles_of(ctl.server.cfg.users) if p.role == "radiologist"]
    assert len(both) == 2
    ctl.dismiss(both[0])
    assert ctl.status(both[0])["prompt"] is False
    assert ctl.status(both[1])["prompt"] is True


def test_a_new_outage_asks_everybody_again(ctl):
    people = who(ctl)
    for profile in people.values():
        ctl.dismiss(profile)
    assert all(ctl.status(p)["prompt"] is False for p in people.values())
    # The monitor clearing and re-raising: a fresh outage is a fresh question.
    ctl._evaluate([])                      # recovered before activation
    assert ctl.state == IDLE
    ctl._evaluate(["Primary PACS"])        # and down again
    assert ctl.state == TRIGGERED
    assert all(ctl.status(p)["prompt"] is True for p in people.values())


def test_an_appliance_without_profiles_keeps_the_old_single_dismiss(ctl):
    assert ctl.status(None)["prompt"] is True
    ctl.dismiss(None)
    assert ctl.status(None)["prompt"] is False


def test_acknowledging_is_not_gated_on_being_allowed_to_activate(ctl):
    """"I have seen this" is something anybody being shown it is entitled to
    say. Only the actions that change what the appliance is doing are
    restricted."""
    with ctl.server.cfg.mutate():
        ctl.server.cfg.emergency["activate_by"] = ["role:radiologist"]
    people = who(ctl)
    assert ctl.may_activate(people["receptionist"]) is False
    ctl.dismiss(people["receptionist"])
    assert ctl.status(people["receptionist"])["prompt"] is False


# ---- the record ---------------------------------------------------------

def test_activating_records_who_made_the_call(ctl):
    people = who(ctl)
    status = ctl.activate(people["radiologist"])
    assert status["activated_by"] == "Radiologist"
    assert ctl.server.mwl_started == 1


def test_an_automatic_failover_is_attributed_to_the_system_not_to_a_person(ctl):
    """Putting a decision in somebody's name that they did not make is the one
    thing an attributed record must never do."""
    status = ctl.activate(None)
    assert status["activated_by"] == "the system"


def test_standing_down_clears_who_activated_it(ctl):
    people = who(ctl)
    ctl.activate(people["radiologist"])
    status = ctl.resume(people["radiologist"])
    assert status["activated_by"] == ""


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
