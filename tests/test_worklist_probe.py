"""The worklist probe: asking another RIS what it would give one of our
modalities, and turning the answers into a diagnosis.

Driven against a REAL Modality Worklist SCP — this project's own, serving a
handmade order store — so what is under test is a genuine C-FIND over a socket
rather than a mock agreeing with itself.

The claim is not "a C-FIND works". It is that the FOUR questions, taken
together, locate the fault; and, critically, that a count is never read as
success on its own. An order carrying no ScheduledStationAETitle reaches every
modality, so a scanner can appear to be scheduled while it is only ever seeing
the orders nobody addressed.

    ./.venv/bin/python tests/test_worklist_probe.py     # or under pytest
"""
from __future__ import annotations

import os
import socket
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pacs.caught import CaughtStore  # noqa: E402
from pacs.logbuf import LogBuffer  # noqa: E402
from pacs.mwl import MwlSCP  # noqa: E402
from pacs.scu import Destination, c_find_worklist  # noqa: E402
from pacs.server import _probe_verdict  # noqa: E402

PASS, FAIL = [], []


def check(cond, label):
    (PASS if cond else FAIL).append(label)
    print(("  ok    " if cond else "  FAIL  ") + label)


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


TODAY = time.strftime("%Y%m%d")
OTHER_DAY = "20200101"


def order(acc, station="", date=TODAY, modality="CT", name="PHANTOM^TEST"):
    return {"accession": acc, "patient_id": "P-" + acc, "patient_name": name,
            "patient": name.replace("^", " "), "study_desc": "EXAM", "modality": modality,
            "station_aet": station, "station_name": "", "scheduled_dt": date,
            "study_uid": "1.2.826.0.1.3680043.10.99999.9." + acc.replace("-", ""),
            "status": "open", "id": acc, "sps_id": acc, "procedure_id": acc}


class Fixture:
    """A worklist provider holding a fixed set of orders."""

    def __init__(self, orders):
        self.port = free_port()
        self.log = LogBuffer()
        self.scp = MwlSCP(aet="OTHERRIS", bind="127.0.0.1", port=self.port,
                          get_orders=lambda: orders, log=self.log)
        self.scp.start()
        time.sleep(0.5)
        self.dest = Destination(name="src", host="127.0.0.1", port=self.port, aet="OTHERRIS")

    def probe_all(self, station, modality=""):
        """The same five questions probe_worklist() asks, in the same order —
        one key relaxed at a time."""
        return [
            c_find_worklist(self.dest, station, station_aet=station, date=TODAY, modality=modality),
            c_find_worklist(self.dest, station, station_aet=station, date=TODAY),
            c_find_worklist(self.dest, station, station_aet=station, date=""),
            c_find_worklist(self.dest, station, station_aet="", date=TODAY),
            c_find_worklist(self.dest, station, station_aet="", date=""),
        ]

    def round_for_modality(self, station, modality):
        store = CaughtStore(tempfile.mkdtemp(prefix="carino-caught-"))
        return store.add_round(station, {"host": "127.0.0.1", "port": self.port, "aet": "OTHERRIS"},
                               self.probe_all(station, modality))

    def round_for(self, station):
        store = CaughtStore(tempfile.mkdtemp(prefix="carino-caught-"))
        return store.add_round(station, {"host": "127.0.0.1", "port": self.port, "aet": "OTHERRIS"},
                               self.probe_all(station))

    def stop(self):
        self.scp.stop()


# ---- the happy case ------------------------------------------------------
def test_an_order_addressed_to_the_station_reads_as_working():
    fx = Fixture([order("A-1", station="CT_ER_01")])
    try:
        rnd = fx.round_for("CT_ER_01")
        first = rnd["probes"][0]
        check(first["ok"] and first["count"] == 1, "the targeted question returns the order")
        check(first["for_this_station"] == 1, "…and it is addressed to this station")
        check("Working" in _probe_verdict(rnd), "the verdict says working: " + _probe_verdict(rnd))
    finally:
        fx.stop()


# ---- the case the whole design exists for --------------------------------
def test_orders_addressed_to_nobody_are_not_reported_as_working():
    """An order with no ScheduledStationAETitle reaches every modality. A count
    alone would call this healthy; it is a scanner that nothing is scheduled
    to."""
    fx = Fixture([order("A-1", station=""), order("A-2", station="")])
    try:
        rnd = fx.round_for("CT_ER_01")
        first = rnd["probes"][0]
        check(first["count"] == 2, "two orders come back for the targeted question")
        check(first["for_this_station"] == 0, "…none of them addressed to this station")
        check(first["for_nobody"] == 2, "…both addressed to nobody")
        v = _probe_verdict(rnd)
        check("NOBODY" in v, "the verdict says so rather than 'working': " + v)
        check("Working" not in v, "…and never claims it works")
    finally:
        fx.stop()


# ---- the three faults the matrix separates -------------------------------
def test_a_date_mismatch_is_named():
    fx = Fixture([order("A-1", station="CT_ER_01", date=OTHER_DAY)])
    try:
        rnd = fx.round_for("CT_ER_01")
        check(rnd["probes"][0]["count"] == 0, "nothing for today")
        check(rnd["probes"][2]["for_this_station"] == 1, "…but the order exists on another date")
        v = _probe_verdict(rnd)
        check("not for today" in v, "the verdict names the date: " + v)
    finally:
        fx.stop()


def test_an_order_addressed_to_another_station_is_named():
    fx = Fixture([order("A-1", station="MR_CONSOLE")])
    try:
        rnd = fx.round_for("CT_ER_01")
        check(rnd["probes"][0]["count"] == 0, "the targeted question returns nothing")
        third = rnd["probes"][3]
        check(third["count"] == 1 and third["for_someone_else"] == 1,
              "…while an untargeted question shows it belongs to another station")
        v = _probe_verdict(rnd)
        check("other stations" in v, "the verdict says it is assigned elsewhere: " + v)
    finally:
        fx.stop()


def test_an_empty_provider_is_named():
    fx = Fixture([])
    try:
        rnd = fx.round_for("CT_ER_01")
        check(all(p["count"] == 0 for p in rnd["probes"]), "every question comes back empty")
        v = _probe_verdict(rnd)
        check("nothing at all" in v, "the verdict points upstream of the RIS: " + v)
    finally:
        fx.stop()


def test_an_unreachable_provider_is_named_before_anything_else():
    """When the association fails, nothing downstream of it means anything and
    the verdict must not pretend otherwise."""
    store = CaughtStore(tempfile.mkdtemp(prefix="carino-caught-"))
    dead = Destination(name="src", host="127.0.0.1", port=free_port(), aet="NOBODY")
    probes = [c_find_worklist(dead, "CT_ER_01", station_aet="CT_ER_01", date=TODAY),
              c_find_worklist(dead, "CT_ER_01", station_aet="CT_ER_01", date=TODAY),
              c_find_worklist(dead, "CT_ER_01", station_aet="CT_ER_01", date=""),
              c_find_worklist(dead, "CT_ER_01", station_aet="", date=TODAY),
              c_find_worklist(dead, "CT_ER_01", station_aet="", date="")]
    rnd = store.add_round("CT_ER_01", {"host": dead.host, "port": dead.port, "aet": "NOBODY"}, probes)
    check(not rnd["probes"][0]["ok"], "the probe reports the failure")
    v = _probe_verdict(rnd)
    check("Could not reach" in v, "the verdict leads with it: " + v[:60])


def test_a_modality_key_mismatch_is_not_blamed_on_the_station():
    """Found by running this against a real second instance, not on paper. The
    first version folded the modality key into the narrowest question, so an
    order tagged CT that a scanner asks for as MR came back empty and the
    verdict blamed the station AE title — sending somebody to edit the wrong
    field. One key is relaxed at a time now, and this is the test that says so."""
    fx = Fixture([order("A-1", station="MR_CONSOLE", modality="CT")])
    try:
        rnd = fx.round_for_modality("MR_CONSOLE", "MR")
        check(rnd["probes"][0]["count"] == 0, "asking with the wrong modality returns nothing")
        check(rnd["probes"][1]["for_this_station"] == 1,
              "…dropping only the modality key finds the order")
        v = _probe_verdict(rnd)
        check("MODALITY key" in v, "the verdict names the modality, not the station: " + v)
        check("AE title" not in v, "…and does not send anybody to the station field")
    finally:
        fx.stop()


# ---- the identity being borrowed -----------------------------------------
def test_the_probe_associates_as_the_modality_not_as_this_appliance():
    """The point of the whole exercise: the provider must see the SCANNER
    asking, or the answer is not the scanner's answer."""
    seen = []
    fx = Fixture([order("A-1", station="CT_ER_01")])
    try:
        original = fx.scp.log.info
        fx.scp.log.info = lambda msg, **k: (seen.append(msg), original(msg, **k))[1]
        c_find_worklist(fx.dest, "CT_ER_01", station_aet="CT_ER_01", date=TODAY)
        time.sleep(0.3)
        check(any("CT_ER_01" in m for m in seen),
              "the provider logged the modality's AE title as the caller")
    finally:
        fx.stop()


# ---- the store is a record, not a queue ----------------------------------
def test_the_caught_store_is_not_the_order_store():
    """The separation that stops another hospital's orders being served to this
    department's modalities. CaughtStore has no notion of an open order, so
    mwl.py has nothing to pick up even if it were pointed at it."""
    store = CaughtStore(tempfile.mkdtemp(prefix="carino-caught-"))
    check(not hasattr(store, "match"), "no reconciliation against arriving studies")
    check(not hasattr(store, "close"), "nothing to close — Carino did not create these")
    check(not hasattr(store, "add"), "no order-creating surface at all")
    check(hasattr(store, "rounds"), "only rounds of probe results")


def test_rounds_are_bounded():
    from pacs.caught import MAX_ROUNDS
    store = CaughtStore(tempfile.mkdtemp(prefix="carino-caught-"))
    for i in range(MAX_ROUNDS + 5):
        store.add_round("CT_ER_01", {"host": "h", "port": 1, "aet": "A"}, [])
    check(store.counts()["rounds"] == MAX_ROUNDS,
          f"kept to {MAX_ROUNDS} rounds, not growing for ever on a long-lived appliance")


def test_the_log_line_carries_accessions_and_no_names():
    """The items live behind config.read; the operational log is read by more
    people than that and gets pasted into support threads."""
    log = LogBuffer()
    fx = Fixture([order("A-1", station="CT_ER_01", name="SECRET^PATIENT")])
    try:
        store = CaughtStore(tempfile.mkdtemp(prefix="carino-caught-"), log=log)
        store.add_round("CT_ER_01", {"host": "h", "port": 1, "aet": "A"}, fx.probe_all("CT_ER_01"))
        lines = " ".join(e.get("message", "") for e in log.tail(50))
        check("A-1" in lines, "the accession is in the log")
        check("SECRET" not in lines, "the patient name is not")
        check("PATIENT" not in lines, "…in any form")
    finally:
        fx.stop()


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
