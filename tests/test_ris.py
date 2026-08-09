"""Order identity and ORC-1 handling.

The claim under test is that a SECOND message about an order lands on the order
it is about. Before this existed, every ORM created a new row: seeding a demo
with three orders four times produced twelve open orders, which is how the bug
was found. On a live feed the same defect is worse than untidy — two open orders
for one accession carry two different Study Instance UIDs, so the modality can
burn the wrong one into the exam and reconciliation then closes one order and
orphans the other permanently.

The asymmetry that runs through all of it: an order must never disappear
quietly. An unrecognised control code therefore upserts (leaving a visible,
hand-cancellable order) rather than cancels, a closed order is never reopened
or rewritten behind the operator, and a cancel for an order this PACS never saw
creates nothing.

    ./.venv/bin/python tests/test_ris.py     # or under pytest
"""
from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pacs.ris import (  # noqa: E402
    CANCEL_CONTROLS,
    CLOSE_BY_RIS,
    ORIGIN_MANUAL,
    ORIGIN_RIS,
    ORIGIN_TEST,
    HL7Message,
    OrderStore,
    may_cancel_here,
    order_control,
    origin_of,
    parse_order,
)


# ---- fixtures ------------------------------------------------------------
def orm(accession="ACC-1", placer="PL-1", filler=None, control="NW",
        patient="DOE^JANE", pid="P-1", desc="CT HEAD", modality="CT") -> HL7Message:
    """One ORM^O01. Fields sit where a real feed puts them: ORC-1 order control,
    ORC-2 placer order number, ORC-3 filler order number — and the accession IS
    the filler order number, which is where parse_order looks for it first and
    where most RIS profiles put it. Pass filler="" to model the common case of a
    first message that has not been given one yet."""
    filler = accession if filler is None else filler
    segs = [
        "MSH|^~\\&|RIS|HOSP|CARINOPACS|HOSP|20260809090000||ORM^O01|MSG1|P|2.3",
        f"PID|||{pid}||{patient}||19800101|F",
        f"ORC|{control}|{placer}|{filler}||||||||||REF^DOC",
        f"OBR|1|{placer}|{filler}|{desc}|||20260809093000|||||||||REF^DOC||||||||{modality}",
    ]
    return HL7Message("\r".join(segs) + "\r")


def store() -> tuple[OrderStore, str]:
    d = tempfile.mkdtemp(prefix="carino-ris-")
    return OrderStore(d), d


PASS, FAIL = [], []


def check(cond, label):
    (PASS if cond else FAIL).append(label)
    print(("  ok    " if cond else "  FAIL  ") + label)


# ---- parsing -------------------------------------------------------------
def test_parse_lifts_identity_and_control():
    m = orm(placer="PL-9", filler="FL-9", control="XO")
    f = parse_order(m)
    check(f["placer_order_number"] == "PL-9", "ORC-2 becomes placer_order_number")
    check(f["filler_order_number"] == "FL-9", "ORC-3 becomes filler_order_number")
    check(order_control(m) == "XO", "ORC-1 is read as the order control code")
    check(order_control(HL7Message("MSH|^~\\&|A|B|C|D|||ORM^O01|1|P|2.3\r")) == "",
          "a message with no ORC yields an empty control code, not an error")


def test_identity_components_are_stripped():
    """EI datatypes carry ^namespace^universal-id after the value. Only the
    first component is the identifier; keeping the rest would make the same
    order look like two the moment a sender started populating them."""
    m = HL7Message(
        "MSH|^~\\&|RIS|H|C|H|||ORM^O01|1|P|2.3\r"
        "PID|||P-1||DOE^JANE\r"
        "ORC|NW|PL-1^RIS^HOSP|FL-1^PACS^HOSP\r"
        "OBR|1|PL-1|FL-1|CT HEAD\r"
    )
    f = parse_order(m)
    check(f["placer_order_number"] == "PL-1", "placer number drops its namespace components")
    check(f["filler_order_number"] == "FL-1", "filler number drops its namespace components")


# ---- the regression this change exists for --------------------------------
def test_the_same_order_four_times_is_one_order():
    s, _ = store()
    for _ in range(4):
        s.apply_hl7(orm(), source="test")
    check(s.counts()["total"] == 1, "four identical ORMs make ONE order (was four)")
    check(s.counts()["open"] == 1, "…and it is open")


def test_repeat_keeps_the_study_uid():
    """The invariant everything else rests on. The modality burns this UID into
    the exam via the worklist; a second UID for the same order is an exam that
    can never be reconciled."""
    s, _ = store()
    first, _ = s.apply_hl7(orm(), source="test")
    again, action = s.apply_hl7(orm(desc="CT HEAD WITH CONTRAST"), source="test")
    check(action == "updated", "the second message is an amendment, not a new order")
    check(again["study_uid"] == first["study_uid"], "the Study Instance UID is never re-minted")
    check(again["id"] == first["id"], "…and it is the same order record")
    check(again["study_desc"] == "CT HEAD WITH CONTRAST", "the amended field is written")
    check(again["revision"] == 2, "the revision counter moves")


def test_identity_survives_a_late_filler_number():
    """The first message often has no filler order number and the second does.
    Matching on any shared identifier is what stops that pair becoming two."""
    s, _ = store()
    s.apply_hl7(orm(placer="PL-7", filler=""), source="test")
    _o, action = s.apply_hl7(orm(placer="PL-7", filler="FL-7"), source="test")
    check(action == "updated", "a later message that adds the filler number is still the same order")
    check(s.counts()["total"] == 1, "…and does not create a second row")


# ---- ORC-1 ---------------------------------------------------------------
def test_cancel_closes_and_keeps():
    s, _ = store()
    s.apply_hl7(orm(), source="test")
    o, action = s.apply_hl7(orm(control="CA"), source="test")
    check(action == "cancelled", "ORC-1 CA cancels")
    check(o["status"] == "closed", "…the order is closed")
    check(s.counts()["total"] == 1, "…kept for the audit trail, not deleted")
    check(s.counts()["open"] == 0, "…and off every worklist")
    check("cancel" in (o.get("close_reason") or ""), "…with a reason that says who cancelled it")


def test_every_cancel_code_cancels():
    for code in sorted(CANCEL_CONTROLS):
        s, _ = store()
        s.apply_hl7(orm(), source="test")
        _o, action = s.apply_hl7(orm(control=code), source="test")
        check(action == "cancelled", f"ORC-1 {code} cancels")


def test_unknown_control_code_upserts_rather_than_cancels():
    """The safe direction. An unrecognised code that upserts leaves a visible
    order somebody can cancel by hand; one that cancelled would close a live
    order silently and the exam would never be performed."""
    s, _ = store()
    s.apply_hl7(orm(), source="test")
    _o, action = s.apply_hl7(orm(control="ZZ"), source="test")
    check(action == "updated", "an unknown ORC-1 amends")
    check(s.counts()["open"] == 1, "…and leaves the order open")


def test_cancel_for_an_unknown_order_creates_nothing():
    s, _ = store()
    o, action = s.apply_hl7(orm(control="CA"), source="test")
    check(action == "cancel-unknown", "a cancel for an order never received is reported")
    check(o is None and s.counts()["total"] == 0, "…and invents no phantom order")


# ---- closed orders are not resurrected ------------------------------------
def test_an_amendment_after_the_study_landed_changes_nothing():
    s, _ = store()
    first, _ = s.apply_hl7(orm(), source="test")
    s.close(first["id"], reason="matched", matched_study="1.2.3")
    o, action = s.apply_hl7(orm(desc="SOMETHING ELSE"), source="test")
    check(action == "ignored-closed", "a status message after completion is reported, not applied")
    check(o["status"] == "closed", "…the order stays closed")
    check(o["study_desc"] == "CT HEAD", "…and is not rewritten behind the operator")
    check(s.counts()["total"] == 1, "…nor duplicated")


def test_cancelling_an_already_closed_order_is_a_no_op():
    s, _ = store()
    first, _ = s.apply_hl7(orm(), source="test")
    s.close(first["id"], reason="matched", matched_study="1.2.3")
    o, action = s.apply_hl7(orm(control="CA"), source="test")
    check(action == "already-closed", "cancelling a completed order is a no-op")
    check(o["close_reason"] == "matched", "…and does not overwrite why it actually closed")


# ---- what an amendment must not destroy -----------------------------------
def test_a_sparse_amendment_does_not_blank_the_order():
    """A status-change message carries almost nothing. Writing its empty fields
    over a full order would erase the demographics the technologist is reading."""
    s, _ = store()
    s.apply_hl7(orm(desc="CT HEAD", modality="CT"), source="test")
    sparse = HL7Message(
        "MSH|^~\\&|RIS|H|C|H|||ORM^O01|2|P|2.3\r"
        "PID|||P-1\r"
        "ORC|SC|PL-1\r"
        "OBR|1|PL-1\r"
    )
    o, action = s.apply_hl7(sparse, source="test")
    check(action == "updated", "the status message lands on the order")
    check(o["study_desc"] == "CT HEAD", "…and does not blank the study description")
    check(o["modality"] == "CT", "…nor the modality")
    check(o["patient"] == "JANE DOE", "…nor the patient name")


def test_an_amendment_keeps_the_operator_s_target_modality():
    """No ORM carries station_aet — the operator sets it to aim the order at one
    modality's worklist. An amendment that wiped it would send the order back to
    every station, which is the failure the field exists to prevent."""
    s, _ = store()
    first, _ = s.apply_hl7(orm(), source="test")
    s.update(first["id"], {"station_aet": "CT_ER_01"})
    o, _action = s.apply_hl7(orm(desc="CT HEAD WITH CONTRAST"), source="test")
    check(o["station_aet"] == "CT_ER_01", "the target modality survives an amendment")


# ---- the operator's own edit still clears ---------------------------------
def test_a_manual_edit_can_still_clear_a_field():
    """The HL7 path ignores empty values; the dashboard's edit must not, or an
    operator could never remove a wrong target modality."""
    s, _ = store()
    first, _ = s.apply_hl7(orm(), source="test")
    s.update(first["id"], {"station_aet": "CT_ER_01"})
    cleared = s.update(first["id"], {"station_aet": ""})
    check(cleared["station_aet"] == "", "an operator edit clears the field")


# ---- reconciliation still works afterwards --------------------------------
def test_match_still_finds_an_amended_order():
    s, _ = store()
    first, _ = s.apply_hl7(orm(), source="test")
    s.apply_hl7(orm(desc="CT HEAD WITH CONTRAST"), source="test")
    by_uid = s.match(study_uid=first["study_uid"])
    check(by_uid is not None and by_uid["id"] == first["id"],
          "the study reconciles by Study Instance UID after an amendment")
    by_acc = s.match(accession="ACC-1")
    check(by_acc is not None and by_acc["id"] == first["id"],
          "…and by accession")


def test_a_cancelled_order_no_longer_matches():
    s, _ = store()
    s.apply_hl7(orm(), source="test")
    s.apply_hl7(orm(control="CA"), source="test")
    check(s.match(accession="ACC-1") is None,
          "a cancelled order does not claim an arriving study")


# ---- through the MLLP handler --------------------------------------------
def test_the_listener_counts_what_actually_happened():
    from pacs.logbuf import LogBuffer
    from pacs.ris import RisListener
    s, _ = store()
    lis = RisListener(bind="127.0.0.1", port=0, store=s, log=LogBuffer())

    def frame(m: HL7Message) -> bytes:
        return m.raw.encode()

    lis._process(frame(orm()), "test")                    # created
    lis._process(frame(orm(desc="AMENDED")), "test")      # updated
    lis._process(frame(orm(control="CA")), "test")        # cancelled
    lis._process(frame(orm(accession="ACC-9", placer="PL-9", control="CA")), "test")  # cancel-unknown
    check(lis.order_count == 1, "the listener counts one order created")
    check(lis.updated_count == 1, "…one amended")
    check(lis.cancelled_count == 1, "…one cancelled")
    check(lis.noop_count == 1, "…and one message about an order it never had")
    check(lis.error_count == 0, "none of which is an error")
    check(s.counts()["total"] == 1, "one order in the store, not four")


# ---- provenance decides authority ----------------------------------------
def test_origin_is_recorded_at_creation():
    s, _ = store()
    from_ris, _ = s.apply_hl7(orm(), source="HL7 10.0.0.5")
    typed = s.add({"accession": "H-1", "patient": "Typed"}, source="manual", origin=ORIGIN_MANUAL)
    made = s.add({"accession": "T-1", "patient": "Made"}, source="test generator", origin=ORIGIN_TEST)
    check(from_ris["origin"] == ORIGIN_RIS, "an HL7 order is the RIS's")
    check(typed["origin"] == ORIGIN_MANUAL, "a typed order is this appliance's")
    check(made["origin"] == ORIGIN_TEST, "a generated one is marked as a test")


def test_only_carino_orders_may_be_cancelled_here():
    """The rule, stated once. Carino completes what it observes and withdraws
    only what it created."""
    s, _ = store()
    from_ris, _ = s.apply_hl7(orm(), source="HL7 10.0.0.5")
    typed = s.add({"accession": "H-1", "patient": "Typed"}, source="manual", origin=ORIGIN_MANUAL)
    made = s.add({"accession": "T-1"}, source="test generator", origin=ORIGIN_TEST)
    check(not may_cancel_here(from_ris), "a RIS order may not be cancelled here")
    check(may_cancel_here(typed), "an order typed here may")
    check(may_cancel_here(made), "…and so may a test order")


def test_relaying_a_ris_cancel_is_not_cancelling_here():
    """Honouring ORC-1 CA is repeating the owner's decision, not making one, so
    it stays allowed on a RIS order — and is credited to the RIS."""
    s, _ = store()
    s.apply_hl7(orm(), source="HL7 10.0.0.5")
    o, action = s.apply_hl7(orm(control="CA"), source="HL7 10.0.0.5")
    check(action == "cancelled", "the relay still happens for a RIS order")
    check(o["close_reason"] == CLOSE_BY_RIS, "…and the RIS is credited, not this appliance")
    check(not may_cancel_here(o), "…while the order remains one this appliance could not have withdrawn")


def test_origin_is_inferred_for_orders_written_before_the_field_existed():
    """orders.json survives upgrades. A row with no `origin` carried its
    provenance only in the `source` display string."""
    check(origin_of({"source": "HL7 10.0.0.5:2575"}) == ORIGIN_RIS,
          "an old HL7 row is recognised as the RIS's")
    check(origin_of({"source": "manual"}) == ORIGIN_MANUAL,
          "an old hand-keyed row is recognised as this appliance's")
    check(origin_of({}) == ORIGIN_MANUAL,
          "a row with nothing at all defaults to this appliance's, never the RIS's")
    check(origin_of({"origin": ORIGIN_TEST, "source": "HL7 x"}) == ORIGIN_TEST,
          "an explicit origin wins over the guess")


def test_the_store_stamps_origin_on_load():
    import json
    s, d = store()
    s.add({"accession": "OLD-1"}, source="HL7 10.0.0.9", origin=ORIGIN_RIS)
    path = os.path.join(d, "orders.json")
    raw = json.load(open(path))
    for o in raw["orders"]:
        o.pop("origin", None)          # an orders.json from before the field
    json.dump(raw, open(path, "w"))
    reloaded = OrderStore(d)
    row = reloaded.list()[0]
    check(row["origin"] == ORIGIN_RIS, "an origin-less row is stamped from its source on load")


def test_concurrent_messages_about_one_order_do_not_race():
    """The listener runs a thread per connection, so two messages about the same
    order can be in apply() at once. Find-then-create has to be one atomic step
    or a burst produces exactly the duplicates this change removes."""
    import threading
    s, _ = store()
    barrier = threading.Barrier(8)
    errors = []

    def fire(i):
        try:
            barrier.wait(timeout=5)
            s.apply_hl7(orm(desc=f"CT HEAD {i}"), source="test")
        except Exception as exc:          # pragma: no cover - only on a real race
            errors.append(exc)

    threads = [threading.Thread(target=fire, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    check(not errors, f"eight concurrent messages raise nothing: {errors[:1]}")
    check(s.counts()["total"] == 1, "…and produce ONE order, not eight")
    uids = {o["study_uid"] for o in s.list()}
    check(len(uids) == 1, "…with a single Study Instance UID")


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
