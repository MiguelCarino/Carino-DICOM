"""The tick that tells the dashboard an order ARRIVED.

The claim under test is that ``OrderStore.created_seq`` moves once, upward, for
every order created for a real patient — the receptionist's typed one during an
outage and the RIS's HL7 one alike — and moves for nothing else. That is the
whole contract the beep rests on: the dashboard keeps the last value it saw and
alerts on an increase, so anything else that moved it would alert the front desk
about an event nobody is waiting for, and anything that failed to move it would
leave a real patient's order sitting unannounced on a screen nobody is watching.

Why a counter of its own, rather than the numbers already in /api/status:

  * ``ris.orders_in`` counts what the HL7 LISTENER created. It is structurally
    zero for an order somebody typed in, which is precisely the order this
    feature exists for — the listener is down, that is why reception is typing.
  * ``ris.counts.total`` falls when closed orders are purged, so a client
    diffing it sees a decrease and then stays silent for the next real order.
    That is the regression `purging closed orders…` below pins down.
  * ``ris.last_order`` is the newest OPEN order, so its id moves backwards when
    the newest open order closes, and `created` is second-resolution, so two
    orders in one second are indistinguishable.

The asymmetry that runs through all of it: the tick is an EDGE, not a state. It
is never derived from what the store currently holds and only ever incremented —
so a purge, a delete, a match or a cancel cannot move it.

It does, however, survive a restart, and that is a correction rather than a
detail. It used to be process-lifetime, on the argument that a dashboard reading
a smaller value re-baselines in silence instead of announcing history. The
silence is the problem: a restart is not an empty moment. The HL7 listener
accepts before the web server answers its first poll and reception keeps typing
throughout, so the orders the new process has already created are inside the
value being adopted — three STAT orders flushed by a reconnecting RIS, no beep,
no flash, nothing to re-announce when the tab comes back. Persisting it keeps
the tick monotonic across the restart, so those orders read as the arrivals they
are; a restart that creates nothing still moves the tick by nothing and still
announces nothing, which is what the old design was actually protecting.

    ./.venv/bin/python tests/test_ris_created_seq.py     # or under pytest
"""
from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pacs.ris import (  # noqa: E402
    ORIGIN_MANUAL,
    ORIGIN_RIS,
    ORIGIN_TEST,
    HL7Message,
    OrderStore,
)
from pacs.server import _order_brief  # noqa: E402


# ---- fixtures ------------------------------------------------------------
def orm(accession="ACC-1", placer="PL-1", filler=None, control="NW",
        patient="DOE^JANE", pid="P-1", desc="CT HEAD", modality="CT") -> HL7Message:
    """One ORM^O01, shaped like the one in tests/test_ris.py so the two files
    describe the same feed. ORC-1 order control, ORC-2 placer, ORC-3 filler —
    and the accession IS the filler order number."""
    filler = accession if filler is None else filler
    segs = [
        "MSH|^~\\&|RIS|HOSP|CARINOPACS|HOSP|20260809090000||ORM^O01|MSG1|P|2.3",
        f"PID|||{pid}||{patient}||19800101|F",
        f"ORC|{control}|{placer}|{filler}||||||||||REF^DOC",
        f"OBR|1|{placer}|{filler}|{desc}|||20260809093000|||||||||REF^DOC||||||||{modality}",
    ]
    return HL7Message("\r".join(segs) + "\r")


def store() -> tuple[OrderStore, str]:
    d = tempfile.mkdtemp(prefix="carino-ris-arrival-")
    return OrderStore(d), d


def typed(s: OrderStore, accession="H-1", patient="Typed") -> dict:
    """What the Emergency RIS panel does: a hand-keyed order for a real
    patient, stamped as this appliance's."""
    return s.add({"accession": accession, "patient": patient},
                 source="manual", origin=ORIGIN_MANUAL)


PASS, FAIL = [], []


def check(cond, label):
    """Records and prints like the other suites' check(), and then ASSERTS.

    The bare recording form these files share is silent under pytest — a
    function that only appends to a list still returns None, which pytest reads
    as a pass. main() below catches the assertion so the standalone run keeps
    its full tally; under pytest the first bad check fails the test, which is
    the only way this file can be a gate in CI."""
    (PASS if cond else FAIL).append(label)
    print(("  ok    " if cond else "  FAIL  ") + label)
    assert cond, label


# ---- the tick rises for a real order --------------------------------------
def test_a_hand_keyed_order_raises_the_created_tick():
    """The primary case. The RIS is unreachable, so the listener is stopped and
    ris.orders_in cannot move; the receptionist types the order anyway and the
    imaging staff must still be told."""
    s, _ = store()
    check(s.created_seq == 0, "a fresh store has not created anything")
    typed(s)
    check(s.created_seq == 1, "a typed order raises the tick by one")
    typed(s, accession="H-2", patient="Second")
    check(s.created_seq == 2, "…and the next one raises it again")


def test_an_hl7_order_raises_the_created_tick():
    s, _ = store()
    _o, action = s.apply_hl7(orm(), source="HL7 10.0.0.5")
    check(action == "created", "the ORM creates an order")
    check(s.created_seq == 1, "an HL7 order raises the tick too — one counter, both paths")


def test_a_burst_of_hl7_orders_raises_the_tick_once_each():
    """The dashboard diffs, so five orders between two polls must read as five
    — one alert saying five, not five alerts and not one."""
    s, _ = store()
    for i in range(5):
        s.apply_hl7(orm(accession=f"ACC-{i}", placer=f"PL-{i}"), source="HL7 10.0.0.5")
    check(s.created_seq == 5, "five distinct ORMs move the tick by five")
    check(s.counts()["total"] == 5, "…and really are five orders")


def test_an_order_with_an_unrecognised_origin_still_counts_as_the_real_one_it_becomes():
    """_add_locked rewrites an out-of-range origin to carino-manual. The count
    has to read the STORED origin, not the argument, or an order that is about
    to be filed as a real hand-keyed one would be counted as a test and arrive
    in silence."""
    s, _ = store()
    o = s.add({"accession": "H-9", "patient": "Odd"}, source="manual", origin="nonsense")
    check(o["origin"] == ORIGIN_MANUAL, "a bogus origin is normalised to this appliance's")
    check(s.created_seq == 1, "…and the order it has become is counted")


# ---- and for nothing else --------------------------------------------------
def test_a_test_order_does_not_raise_the_created_tick():
    """The Test order checkbox exercises the whole chain — store, worklist,
    reconciliation — and must do it in silence. Nobody's exam is waiting, and a
    front desk that hears the beep during a demo learns to ignore it."""
    s, _ = store()
    s.add({"accession": "T-1", "patient": "Made"}, source="test generator", origin=ORIGIN_TEST)
    check(s.created_seq == 0, "a carino-test order does not move the tick")
    check(s.counts()["total"] == 1, "…while still being a real row in the store")
    typed(s)
    check(s.created_seq == 1, "…and a real order after it still announces itself")


def test_amending_cancelling_matching_and_closing_leave_the_created_tick_alone():
    """Everything a live order goes through after it exists. None of it is an
    arrival, and every one of these used to be a candidate signal."""
    s, _ = store()
    first, _ = s.apply_hl7(orm(), source="HL7 10.0.0.5")
    check(s.created_seq == 1, "the order arrives once")

    s.apply_hl7(orm(desc="CT HEAD WITH CONTRAST"), source="HL7 10.0.0.5")
    check(s.created_seq == 1, "an HL7 amendment is not an arrival")

    s.update(first["id"], {"station_aet": "CT_ER_01"})
    check(s.created_seq == 1, "the operator aiming it at a modality is not an arrival")

    matched = s.match(accession="ACC-1")
    check(matched is not None and matched["id"] == first["id"], "the study reconciles to it")
    check(s.created_seq == 1, "…and matching it is not an arrival")

    s.close(first["id"], reason="matched", matched_study="1.2.3")
    check(s.created_seq == 1, "closing it — the study landed — is not an arrival")

    second = typed(s, accession="H-2", patient="Cancel Me")
    check(s.created_seq == 2, "a second real order does raise it")
    s.close(second["id"], reason="cancelled-here")
    check(s.created_seq == 2, "…and withdrawing it does not lower it")

    third, _ = s.apply_hl7(orm(accession="ACC-3", placer="PL-3"), source="HL7 10.0.0.5")
    check(s.created_seq == 3, "a third order arrives")
    _o, action = s.apply_hl7(orm(accession="ACC-3", placer="PL-3", control="CA"),
                             source="HL7 10.0.0.5")
    check(action == "cancelled", "the RIS cancels it")
    check(s.created_seq == 3, "…and a relayed cancel is not an arrival")

    _none, unknown = s.apply_hl7(orm(accession="ACC-NEVER", placer="PL-NEVER", control="CA"),
                                 source="HL7 10.0.0.5")
    check(unknown == "cancel-unknown", "a cancel for an order never received creates nothing")
    check(s.created_seq == 3, "…so it announces nothing either")

    s.apply_hl7(orm(desc="SOMETHING ELSE"), source="HL7 10.0.0.5")
    check(s.created_seq == 3, "a message about an already-closed order is not an arrival")

    check(s.delete(third["id"]), "the order is deleted outright")
    check(s.created_seq == 3, "…and deleting it does not lower the tick")


# ---- the regression that justifies the design ------------------------------
def test_purging_closed_orders_drops_the_total_but_never_the_created_tick():
    """This is why ris.counts.total was rejected as the signal. Purge a
    morning's closed orders and total falls; a client diffing a number that
    fell has no way to tell that from "nothing happened", so the receptionist's
    NEXT order arrives in silence. The tick is not derived from what the store
    holds, so a purge cannot touch it."""
    s, _ = store()
    for i in range(4):
        o = typed(s, accession=f"H-{i}", patient=f"Patient {i}")
        s.close(o["id"], reason="matched", matched_study=f"1.2.{i}")
    typed(s, accession="H-OPEN", patient="Still Waiting")
    check(s.created_seq == 5, "five real orders, five ticks")
    check(s.counts()["total"] == 5, "…and five rows")

    purged = s.purge_closed()
    check(purged == 4, "the four closed orders are purged")
    check(s.counts()["total"] == 1, "counts.total falls to the one still open")
    check(s.created_seq == 5, "…and the created tick does NOT fall with it")

    typed(s, accession="H-NEXT", patient="After The Purge")
    check(s.created_seq == 6, "the order typed after a purge still raises the tick")


def test_the_created_tick_survives_a_restart_so_the_orders_around_it_are_not_swallowed():
    """The regression this file was written the wrong way round for.

    A dashboard that has been up all shift holds a baseline. Restart the engine
    — the runbook's own remedy during an outage, a nightly restart, an operator
    applying config — and a tick that began again at zero came back SMALLER,
    which the client reads as "re-baseline, announce nothing". Every order the
    new process created before that poll is inside the adopted value: the HL7
    listener is accepting orders before the web server answers (sync_services
    starts it long before app.run), and on a backgrounded tab the poll that does
    the adopting can be a minute late.

    So the property is monotonicity ACROSS the restart, not the absence of a
    number in a file. The store is asked, not the file: where the tick is kept
    is the store's business, and a test that asserted the file's shape is what
    fixed the wrong behaviour in place."""
    s, d = store()
    typed(s)
    typed(s, accession="H-2", patient="Second")
    check(s.created_seq == 2, "two orders are counted")
    baseline = s.created_seq              # what the tech's dashboard is holding

    reloaded = OrderStore(d)              # the appliance restarts
    check(reloaded.counts()["total"] == 2, "a restart still has both orders")
    check(reloaded.created_seq == baseline,
          "…and the tick comes back where the dashboards left it, not at zero")

    # Reception keeps typing between the restart and the tab's next poll — the
    # window the old design lost entirely.
    for i in (3, 4, 5):
        typed(reloaded, accession=f"H-{i}", patient=f"After Restart {i}")
    check(reloaded.created_seq == baseline + 3,
          "the three orders typed after the restart raise it by three")
    check(reloaded.created_seq > baseline,
          "…so the first poll after the restart reads HIGHER and announces them")

    once_more = OrderStore(d)
    check(once_more.created_seq == baseline + 3,
          "a restart that creates nothing moves the tick by nothing, and announces nothing")


def test_a_restart_mid_outage_announces_the_orders_typed_around_it():
    """The same claim as the dashboard performs it, because the defect only
    existed in the arithmetic between the two: the store was always right about
    how many orders it held, and the client still heard nothing.

    The three lines below RESTATE pacs/web/app.js's arrival branch — baseline on
    the first value seen, adopt a value that went backwards, announce the
    difference when it rises. They are not that branch: the real one is cut out
    of app.js and driven in pacs/web/tests/alert-state.mjs, which is where a
    change to the branch itself is caught. Nothing else about the browser is
    simulated here; what is under test is that the sequence of values this store
    hands that branch no longer contains a backwards step that a real arrival is
    hidden inside."""
    seen = {"last": None}
    alerts = []

    def poll(st):
        seq = st.created_seq
        if seen["last"] is None or seq < seen["last"]:
            seen["last"] = seq                     # first poll, or re-baseline
            return
        if seq > seen["last"]:
            alerts.append(seq - seen["last"])
            seen["last"] = seq

    s, d = store()
    for i in range(8):
        typed(s, accession=f"SHIFT-{i}", patient=f"Patient {i}")
    poll(s)
    check(seen["last"] == 8 and alerts == [],
          "the tab that has been up all shift baselines on 8 and announces nothing")

    restarted = OrderStore(d)                      # the service restarts
    for i in range(3):
        typed(restarted, accession=f"STAT-{i}", patient=f"Trauma {i}")
    poll(restarted)                                # the tab's next poll
    check(alerts == [3],
          "the three STAT orders queued around the restart announce themselves: "
          + repr(alerts))
    check(restarted.counts()["open"] == 11, "…and they really are all open on the store")


def test_a_purge_after_a_restart_still_cannot_lower_the_tick():
    """Persisting it is the one change that could have made the tick a state —
    a number re-derived from what is on disk would fall with a purge, and the
    next real order after the purge would arrive in silence. It is seeded from
    the stored counter, never from len(orders)."""
    s, d = store()
    for i in range(4):
        o = typed(s, accession=f"H-{i}", patient=f"Patient {i}")
        s.close(o["id"], reason="matched", matched_study=f"1.2.{i}")
    check(s.created_seq == 4, "four real orders, four ticks")
    check(s.purge_closed() == 4, "all four are purged")
    check(s.counts()["total"] == 0, "the store now holds nothing")

    reloaded = OrderStore(d)
    check(reloaded.created_seq == 4,
          "…and the restarted store still reports four, not zero")
    typed(reloaded, accession="H-NEXT", patient="After The Purge")
    check(reloaded.created_seq == 5, "so the next real order still announces itself")


def test_a_store_written_before_the_tick_was_persisted_still_loads():
    """The one upgrade restart, and any orders.json restored from a backup: the
    file carries no tick at all. It has to load the ORDERS — losing those to a
    missing integer would be a far worse failure than a missed beep — and the
    client's backwards-step arm handles the rest."""
    import json
    s, d = store()
    typed(s)
    typed(s, accession="H-2", patient="Second")
    path = os.path.join(d, "orders.json")
    legacy = json.load(open(path))
    legacy.pop("created_seq", None)                # the pre-upgrade shape
    json.dump(legacy, open(path, "w"), indent=2)

    reloaded = OrderStore(d)
    check(reloaded.counts()["total"] == 2, "both orders survive a file with no tick in it")
    typed(reloaded, accession="H-3", patient="Third")
    check(reloaded.created_seq >= 1, "…and the tick still rises for the next real order")


# ---- provenance survives the trim /api/status does -------------------------
def test_the_order_brief_carries_origin_and_tells_the_three_apart():
    """/api/status ships a trimmed order, not the whole record. Provenance has
    to survive that trim, because 'is this a real patient or the test
    generator?' is the same question the tick answers with silence — and the
    panel has to be able to answer it for a row the operator is looking at."""
    s, _ = store()
    from_ris, _ = s.apply_hl7(orm(), source="HL7 10.0.0.5")
    hand = typed(s)
    made = s.add({"accession": "T-1", "patient": "Made"}, source="test generator",
                 origin=ORIGIN_TEST)

    fields = ("id", "accession", "patient", "status", "origin")
    briefs = {o["accession"]: _order_brief(o, fields) for o in (from_ris, hand, made)}
    check(all("origin" in b for b in briefs.values()), "the brief keeps origin")
    check(briefs["ACC-1"]["origin"] == ORIGIN_RIS, "the HL7 order is the RIS's")
    check(briefs["H-1"]["origin"] == ORIGIN_MANUAL, "the typed one is this appliance's")
    check(briefs["T-1"]["origin"] == ORIGIN_TEST, "and the generated one says so")
    check(len({ORIGIN_RIS, ORIGIN_MANUAL, ORIGIN_TEST}) == 3,
          "the three origins are three distinct values, not shades of one")
    check(_order_brief(None, fields) is None, "no order briefs to nothing, not an empty row")


def test_the_status_block_ships_the_tick_and_the_origin_with_the_listener_stopped():
    """End to end, against the real engine rather than a stub, because the two
    halves of this only meet in PacsServer.status(): the tick has to be read off
    the STORE (`self.orders`), not off the listener, or it would be absent in
    exactly the emergency it was built for — `ris` is None whenever HL7 intake
    is stopped, and that is when reception starts typing."""
    from pacs.config import Config
    from pacs.server import PacsServer

    d = tempfile.mkdtemp(prefix="carino-ris-arrival-srv-")
    cfg = Config(os.path.join(d, "config.json")).load()
    cfg.save()
    srv = PacsServer(cfg)
    try:
        check(srv.ris is None, "the HL7 listener is not running")
        block = srv.status()["ris"]
        check(block["running"] is False, "…and status says so")
        check(block["created_seq"] == 0, "a fresh engine has created nothing")

        srv.orders.add({"accession": "H-1", "patient": "Typed"},
                       source="manual", origin=ORIGIN_MANUAL)
        block = srv.status()["ris"]
        check(block["created_seq"] == 1, "a typed order reaches the dashboard as a tick")
        check(block["orders_in"] == 0,
              "…while orders_in stays zero — which is why it could not be the signal")
        check(block["last_order"]["origin"] == ORIGIN_MANUAL,
              "and the brief /api/status ships carries the order's origin")

        srv.orders.add({"accession": "T-1", "patient": "Made"},
                       source="test generator", origin=ORIGIN_TEST)
        block = srv.status()["ris"]
        check(block["created_seq"] == 1, "a test order moves no tick")
        check(block["counts"]["total"] == 2, "…though the store really holds both")
        # Deliberately NOT asserting which order last_order now points at: it is
        # latest("open") ordered on a second-resolution `created`, so two orders
        # keyed in the same second tie. That tie is one of the reasons the
        # arrival signal is a tick and not this field.
    finally:
        srv.shutdown()


# ---- what a late or missed poll can still recover --------------------------
# Two of round 3's failures live in the browser and pytest cannot reach either:
#
#   * a /api/status slower than the two-second poll period starves
#     renderStatus() for ever, because pollStatus() compares its in-flight token
#     against the counter of requests ISSUED rather than against the last one
#     RENDERED, so a response that lands after the next tick is dropped unread.
#   * a tone owed at an arrival (the context was asleep) is paid by the click
#     that answers the SIGN-IN PROMPT, because showAuthGate() drops the two
#     visual deferrals and not the audible one.
#
# Both repairs are in app.js, and the assertions for them are in
# pacs/web/tests/alert-state.mjs — a standalone node harness that cuts the
# arrival decision, the live region, the deferred tone and the poll watermark
# out of app.js and drives them as a state machine against a clock, a speaker
# and a store it controls. This comment used to say the repairs were "asserted
# where JavaScript can be run", which was true of nowhere: all three could be
# reverted at once with pytest, i18n-parity and `node --check` still green, and
# a comment claiming a gate there is none of is worse than no comment at all.
#
# What is asserted where, so that the next person does not have to find out the
# hard way:
#
#   here          the payload half. The ris block is never served from a cache,
#                 so a response that LANDS late still carries the current tick
#                 and counts — which is the whole reason rendering a late
#                 response is safe rather than a way to paint history — and
#                 everything a dropped alert would have announced is still on
#                 the first payload of the session that replaces it.
#   in the .mjs   the decision half. Whether that response is rendered at all,
#                 whether an increase announces exactly once and with the right
#                 count, what the sign-in prompt drops, and which clock the
#                 owed tone is measured against.
#   nowhere       the sound actually reaching the room and the screen reader
#                 actually speaking the region: that needs a real device and a
#                 real AT, and neither is in this repo. The tone is scheduled on
#                 a recording AudioContext in the harness; that it is audible at
#                 the front desk is still checked by a person.
#
# The alert is a courtesy; the order list is the record, and it is the record
# that must not have a hole in it.
def test_a_status_response_that_lands_late_still_carries_the_current_tick():
    """Rendering a late response is only safe if a late response is a CURRENT
    one. Nothing in the ris block may be served from a cache: the index stats
    next to it are memoised behind a TTL, and a tick or a count answered from
    that kind of snapshot would make a recovered poll announce a number that was
    true some seconds ago — or announce nothing at all."""
    from pacs.config import Config
    from pacs.server import PacsServer

    d = tempfile.mkdtemp(prefix="carino-ris-arrival-late-")
    cfg = Config(os.path.join(d, "config.json")).load()
    cfg.save()
    srv = PacsServer(cfg)
    try:
        first = srv.status()["ris"]
        # The order the receptionist types while the previous response is still
        # in flight on a stalled link. Back to back with the call above, so any
        # TTL a status section hides behind is still warm.
        srv.orders.add({"accession": "H-1", "patient": "Typed"},
                       source="manual", origin=ORIGIN_MANUAL)
        second = srv.status()["ris"]
        check(second["created_seq"] == first["created_seq"] + 1,
              "the next response carries the tick as it is NOW, not as it was cached")
        check(second["counts"]["open"] == first["counts"]["open"] + 1,
              "…and the counts with it")
        check(second["created_seq"] >= first["created_seq"],
              "the tick never goes backwards between two responses of one process")
    finally:
        srv.shutdown()


def test_the_orders_typed_while_a_session_was_dead_are_all_there_at_sign_in():
    """The server half of the sign-in case: the prompt is raised by a 401, and
    everything that happened behind it is on the very first payload of the
    session that replaces it. That is what makes dropping a deferred alert at
    the gate the right thing to do rather than a loss — flashing and chirping
    for orders that are already on the list is announcing history."""
    from pacs.config import Config
    from pacs.server import PacsServer
    from pacs.web import create_app

    d = tempfile.mkdtemp(prefix="carino-ris-arrival-gate-")
    cfg = Config(os.path.join(d, "config.json")).load()
    cfg.web["auth_token"] = "the-token-this-session-holds"
    cfg.index["enabled"] = False
    cfg.save()
    srv = PacsServer(cfg)
    try:
        client = create_app(srv).test_client()
        held = {"Authorization": "Bearer the-token-this-session-holds"}
        r = client.get("/api/status", headers=held)
        check(r.status_code == 200, "the signed-in tab polls normally")
        baseline = r.get_json()["ris"]["created_seq"]

        # The session ends underneath it — a rotated token here; a logout or an
        # expired cookie reaches the same place. This 401 is the event that
        # raises the prompt the operator then clicks on.
        cfg.web["auth_token"] = "a-rotated-token"
        check(client.get("/api/status", headers=held).status_code == 401,
              "the next poll is refused, which is what puts the sign-in prompt up")

        # Reception keeps typing while nobody is signed in on that workstation.
        for i in (1, 2):
            srv.orders.add({"accession": f"ER-{i}", "patient": f"Trauma {i}"},
                           source="manual", origin=ORIGIN_MANUAL)

        signed_in = {"Authorization": "Bearer a-rotated-token"}
        block = client.get("/api/status", headers=signed_in).get_json()["ris"]
        check(block["created_seq"] == baseline + 2,
              "the first payload of the new session accounts for both of them")
        check(block["counts"]["open"] == 2,
              "…and both are open on the list the operator is looking at")
        # WHICH of the two it names is deliberately not asserted: last_order is
        # latest("open") over a second-resolution `created`, so two orders typed
        # in the same second tie — one of the reasons the arrival signal is the
        # tick above and not this field. That it names one of the orders typed
        # behind the prompt, rather than something stale, is the claim.
        check(block["last_order"]["accession"] in ("ER-1", "ER-2"),
              "…and the brief names one of them, not an order from before the gap")
    finally:
        srv.shutdown()


# ---- the order the beep announced has to be one a modality can pull --------
# The tick is only worth sounding if the thing it announces can be acted on.
# These two go at the seam between this file and tests/test_emergency_worklist.py
# — that file owns the enumeration of what a legal worklist item is (and the
# reasons, and the PS3.3/PS3.4 citations); this one owns the claim that the
# order OrderStore just created and counted is such an item. The short list
# below is deliberately a restatement, not an import: the stores are built here
# from the panel's own field dicts, and the point being made is about the handoff
# rather than about the IOD.
WORKLIST_MUST_FILL = (
    ("StudyInstanceUID", "Study Instance UID"),
    ("RequestedProcedureID", "Requested Procedure ID"),
    ("PatientName", "Patient's Name"),
    ("PatientID", "Patient ID"),
)
WORKLIST_STEP_MUST_FILL = (
    ("Modality", "Modality"),
    ("ScheduledStationAETitle", "Scheduled Station AE Title"),
    ("ScheduledProcedureStepStartDate", "SPS Start Date"),
    ("ScheduledProcedureStepStartTime", "SPS Start Time"),
    ("ScheduledProcedureStepID", "Scheduled Procedure Step ID"),
)


def _blank_on_the_wire(order: dict) -> list:
    """The attributes a modality would receive empty for *order*."""
    from pacs.mwl import build_worklist_item
    import inspect

    if len(inspect.signature(build_worklist_item).parameters) > 1:
        # The builder answers a specific query when it is given one; the empty
        # (universal) identifier is the case that has to stand on its own.
        from pydicom.dataset import Dataset
        q = Dataset()
        q.ScheduledProcedureStepSequence = [Dataset()]
        ds = build_worklist_item(order, q)
    else:
        ds = build_worklist_item(order)
    gaps = [name for attr, name in WORKLIST_MUST_FILL
            if not str(getattr(ds, attr, "") or "").strip()]
    seq = getattr(ds, "ScheduledProcedureStepSequence", None)
    if not seq:
        return gaps + ["Scheduled Procedure Step Sequence"]
    return gaps + [name for attr, name in WORKLIST_STEP_MUST_FILL
                   if not str(getattr(seq[0], attr, "") or "").strip()]


def test_every_order_that_raises_the_tick_is_one_a_modality_can_actually_pull():
    """The beep is a promise that somebody can now go and scan this patient. It
    is made for every shape add_order() accepts — any ONE of accession, patient
    name or patient ID — so every one of those shapes has to survive the trip
    onto a worklist, not just the demonstration order with every box filled.

    Asserted here as well as in the worklist suite because this is the store's
    side of the handoff: these are the dicts OrderStore really writes, with the
    id and the Study Instance UID it stamps, which is the exact list MwlSCP
    serves (``get_orders=lambda: self.orders.list("open")``)."""
    s, _ = store()
    shapes = {
        "a name-only trauma order": {"patient": "DOE^JANE"},
        "an accession-only order": {"accession": "ER-4471"},
        "a patient-ID-only order": {"patient_id": "TRAUMA-7"},
        "a patient and an exam": {"patient": "DOE^JANE", "study_desc": "CT HEAD"},
    }
    for label, fields in shapes.items():
        o = s.add(fields, source="manual", origin=ORIGIN_MANUAL)
        gaps = _blank_on_the_wire(o)
        check(gaps == [], f"{label} reaches the modality whole; empty: "
                          + (", ".join(gaps) or "none"))
    check(s.created_seq == len(shapes), "…and every one of them rang the front desk")


def test_a_matching_modality_query_selects_the_order_the_tick_announced():
    """The other half: legal is not the same as visible. An order typed with no
    target modality has to be selected by whatever scanner asks next, because
    nobody has decided which room the patient goes to yet — that decision is
    what the tech is being alerted to make."""
    from pacs.mwl import order_matches_query
    from pydicom.dataset import Dataset

    s, _ = store()
    o = s.add({"patient": "DOE^JANE", "study_desc": "CT HEAD"},
              source="manual", origin=ORIGIN_MANUAL)
    check(s.created_seq == 1, "the order announced itself")

    q = Dataset()
    step = Dataset()
    step.Modality = "CT"
    step.ScheduledStationAETitle = "CTSCAN1"
    q.ScheduledProcedureStepSequence = [step]
    check(order_matches_query(o, q), "the CT down the corridor sees it")
    check(o["status"] == "open", "…for as long as it is open, which is until it is scanned")


def main():
    for fn in sorted(
        (v for k, v in globals().items() if k.startswith("test_")),
        key=lambda f: f.__code__.co_firstlineno,
    ):
        print(fn.__name__)
        try:
            fn()
        except AssertionError:
            pass               # check() already recorded and printed it
    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
