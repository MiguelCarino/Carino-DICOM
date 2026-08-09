"""The modality registry's validation rules.

A modality entry is the AE title an order is aimed at, and the worklist matches
that title exactly. The rules below are all one idea: a registry that accepts a
wrong entry is worse than no registry, because the operator now believes the
list is authoritative.

The failure a typo produces is worth stating, because it is not symmetric. If
the modality queries the worklist with its own AE title in
ScheduledStationAETitle, an order aimed at a typo matches NOTHING and appears on
no station. If it queries with the key empty — universal matching, equally
conformant — the same order appears on EVERY station. Same typo, opposite
outcomes, decided by the vendor. That is what the registry exists to remove.

    ./.venv/bin/python tests/test_modalities.py     # or under pytest
"""
from __future__ import annotations

import copy
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pacs.config import DEFAULTS, validate  # noqa: E402

PASS, FAIL = [], []


def check(cond, label):
    (PASS if cond else FAIL).append(label)
    print(("  ok    " if cond else "  FAIL  ") + label)


def accepts(mods) -> bool:
    d = copy.deepcopy(DEFAULTS)
    d["modalities"] = mods
    try:
        validate(d)
        return True
    except ValueError:
        return False


def refuses_with(mods) -> str:
    d = copy.deepcopy(DEFAULTS)
    d["modalities"] = mods
    try:
        validate(d)
        return ""
    except ValueError as exc:
        return str(exc)


def test_a_well_formed_registry_is_accepted():
    check(accepts([]), "an empty registry is legal — it is the state every install starts in")
    check(accepts([{"name": "ER CT", "aet": "CT_ER_01", "modality": "CT", "enabled": True}]),
          "a complete entry is accepted")
    check(accepts([{"name": "ER CT", "aet": "CT_ER_01"}]),
          "modality and enabled are optional — the AE title is what the worklist needs")


def test_an_entry_without_an_ae_title_is_refused():
    why = refuses_with([{"name": "ER CT", "aet": ""}])
    check("AE title" in why, "an entry with no AE title is refused: " + why[:60])


def test_an_entry_without_a_name_is_refused():
    why = refuses_with([{"name": "", "aet": "CT_ER_01"}])
    check("name" in why, "an entry with no name is refused — the order form has nothing to show")


def test_the_dicom_length_limit_is_enforced():
    check(accepts([{"name": "x", "aet": "A" * 16}]), "16 characters is allowed")
    why = refuses_with([{"name": "x", "aet": "A" * 17}])
    check("16 characters" in why, "17 is refused, with the DICOM limit named: " + why[:56])


def test_ae_titles_may_not_carry_a_space_or_backslash():
    """Both are outside the DICOM AE title character set. An association made
    with one fails in ways nobody traces back to a config field."""
    for bad in ("CT ER 01", "CT\\ER"):
        why = refuses_with([{"name": "x", "aet": bad}])
        check("space or backslash" in why, f"{bad!r} is refused")


def test_two_stations_may_not_share_an_ae_title():
    why = refuses_with([{"name": "ER CT", "aet": "CT_01"},
                        {"name": "Ward CT", "aet": "CT_01"}])
    check("share the AE title" in why, "a duplicate AE title is refused")
    check("appear on both" in why, "…and the message says what would happen: " + why[-40:])


def test_the_duplicate_check_is_case_insensitive():
    """DICOM compares AE titles case-insensitively, so two rows differing only
    in case are one station to the worklist and two to the operator."""
    why = refuses_with([{"name": "a", "aet": "CT_01"}, {"name": "b", "aet": "ct_01"}])
    check("share the AE title" in why, "CT_01 and ct_01 are the same station")


def test_a_quoted_boolean_is_refused():
    """The hazard `_check_bools` exists for, one level down in a list: a
    modality with enabled: "false" is one the operator switched off that keeps
    appearing in the order form."""
    why = refuses_with([{"name": "x", "aet": "A", "enabled": "false"}])
    check("non-boolean" in why, "enabled: \"false\" is refused, not read as True")


def test_the_registry_and_destinations_stay_separate_lists():
    """They look alike and mean opposite things: a modality PULLS a worklist
    from this appliance, a destination RECEIVES studies from it. Sharing one AE
    title between the two lists is normal and must not be refused."""
    d = copy.deepcopy(DEFAULTS)
    d["modalities"] = [{"name": "ER CT", "aet": "SHARED_AE"}]
    d["destinations"] = [{"name": "Ward PACS", "host": "10.0.0.5", "port": 104, "aet": "SHARED_AE"}]
    try:
        validate(d)
        check(True, "one AE title may appear in both lists — they are different directions")
    except ValueError as exc:
        check(False, "a shared AE title was refused: " + str(exc)[:60])


def main():
    for fn in sorted(
        (v for k, v in globals().items() if k.startswith("test_")),
        key=lambda f: f.__code__.co_firstlineno,
    ):
        print(fn.__name__)
        fn()
    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
