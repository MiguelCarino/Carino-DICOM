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
    """Records and prints like the other suites' check(), and then ASSERTS.

    The bare recording form only appended to a list, which returns None — and a
    test function that returns None is a PASS to pytest. This file drives a real
    MwlSCP over a socket, so it is the suite most likely to catch a regression
    in the worklist, and for as long as check() could not fail it reported every
    one of them as green in CI while printing FAIL to a terminal nobody reads.
    main() below catches the assertion so a standalone run still prints the
    whole tally; under pytest the first bad check fails its test, which is the
    only way this file is a gate."""
    (PASS if cond else FAIL).append(label)
    print(("  ok    " if cond else "  FAIL  ") + label)
    assert cond, label


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


# ---- what the receptionist's typing looks like on a real association ------
# The probe above reads items through scu._worklist_item, which flattens each
# one into a dict of strings — so the two properties that decide whether a
# scanner KEEPS an item are invisible to it: the VR each value has to be legal
# for, and how many values the element carries. Both are the SCU's business and
# both are checked by the toolkit on the modality, which is entitled to drop the
# whole item rather than the offending key. So this section associates directly.
#
# Every order shape below is something the intake form as shipped accepts (the
# fields have no character class, and #ordAcc/#ordPatient/#ordPid have no
# maxlength either), or that an ordinary HL7 feed produces without anybody
# typing anything unusual — \T\ is HL7's escape for &, and parse_order does not
# unescape it, so any name carrying an ampersand arrives with two backslashes in
# it. Each one reached a live MwlSCP and came back illegal.
def raw_find(fx, station_aet="", modality="", date=""):
    """The datasets a modality really receives from *fx*, un-flattened.

    Deliberately not c_find_worklist(): that is the diagnostic path and it
    returns strings. This is the scanner's path."""
    from pydicom.dataset import Dataset
    from pynetdicom import AE
    from pynetdicom.sop_class import ModalityWorklistInformationFind

    q = Dataset()
    q.PatientName = ""
    q.PatientID = ""
    q.AccessionNumber = ""
    q.StudyInstanceUID = ""
    q.ReferringPhysicianName = ""
    q.RequestedProcedureID = ""
    step = Dataset()
    step.Modality = modality
    step.ScheduledStationAETitle = station_aet
    step.ScheduledProcedureStepStartDate = date
    step.ScheduledProcedureStepStartTime = ""
    step.ScheduledProcedureStepID = ""
    q.ScheduledProcedureStepSequence = [step]

    ae = AE(ae_title="CT_ER_01")
    ae.add_requested_context(ModalityWorklistInformationFind)
    assoc = ae.associate("127.0.0.1", fx.port, ae_title="OTHERRIS")
    items = []
    try:
        for status, ds in assoc.send_c_find(q, ModalityWorklistInformationFind):
            if ds is not None and status and status.Status in (0xFF00, 0xFF01):
                items.append(ds)
    finally:
        assoc.release()
    return items


# Type 1 in the MWL IOD: required and non-zero-length. Named here rather than
# imported from tests/test_emergency_worklist.py because that file owns the IOD
# reasoning and this one owns the wire; the overlap is two short tuples and the
# duplication is what keeps either file runnable on its own.
WIRE_TYPE_1 = ("StudyInstanceUID", "RequestedProcedureID")
WIRE_STEP_TYPE_1 = ("Modality", "ScheduledStationAETitle",
                    "ScheduledProcedureStepStartDate",
                    "ScheduledProcedureStepStartTime", "ScheduledProcedureStepID")


def wire_faults(ds) -> list:
    """Everything about *ds* that would make a validating SCU reject it: a value
    illegal for its VR, an element carrying more than one value where the IOD
    allows one, or an empty Type 1."""
    from pydicom import config
    from pydicom.multival import MultiValue
    from pydicom.valuerep import validate_value

    bad = []

    def walk(dataset, prefix=""):
        for elem in dataset:
            if elem.VR == "SQ":
                for item in elem.value or []:
                    walk(item, prefix=f"{elem.keyword}.")
                continue
            value = elem.value
            if isinstance(value, (MultiValue, list, tuple)):
                # Checked before stringifying, and that order is the point: the
                # repr of a MultiValue ("['CT', 'MR']", "[DOE, JANE]") is inside
                # the character set of PN and SH, so a check made after str()
                # cannot see a split name or accession at all.
                bad.append(f"{prefix}{elem.keyword} (VR {elem.VR}) carries "
                           f"{len(value)} values: {list(value)!r}")
                continue
            if value is None or str(value) == "":
                continue
            if "\\" in str(value):
                bad.append(f"{prefix}{elem.keyword} (VR {elem.VR}) = {str(value)[:24]!r}: "
                           "carries the value delimiter")
                continue
            try:
                validate_value(elem.VR, str(value), config.RAISE)
            except ValueError as exc:
                bad.append(f"{prefix}{elem.keyword} (VR {elem.VR}) = {str(value)[:24]!r}: "
                           f"{str(exc).split('.')[0]}")

    walk(ds)
    for attr in WIRE_TYPE_1:
        if not str(getattr(ds, attr, "") or "").strip():
            bad.append(f"{attr} is empty, and it is Type 1")
    seq = getattr(ds, "ScheduledProcedureStepSequence", None)
    if not seq:
        return bad + ["ScheduledProcedureStepSequence is missing"]
    for attr in WIRE_STEP_TYPE_1:
        if not str(getattr(seq[0], attr, "") or "").strip():
            bad.append(f"SPS.{attr} is empty, and it is Type 1")
    return bad


HOSTILE_ORDERS = {
    "a modality typed in lower case": dict(modality="ct"),
    "a modality carrying punctuation": dict(modality="ct;head"),
    "a modality with a backslash in it": dict(modality="CT\\MR"),
    "a station AE title with a backslash": dict(station="CT\\MR"),
    "a patient name arriving from HL7 with \\T\\ in it": dict(name="OBRIEN\\T\\SONS^JAMES"),
    "a three-hundred-character patient ID": dict(patient_id="P" * 300),
    "a barcode accession": dict(acc_value="B" * 300),
    "a referring physician with a backslash": dict(referring="HOUSE\\G"),
}


def wire_order(acc, **kw):
    """order(), with a Study Instance UID that is a legal UI.

    The helper at the top of this file builds its UID from the accession, which
    is fine for every test above — they read the probe's flattened strings — and
    is not a UI at all once a letter gets into it, so a real SCP drops the
    element and the item arrives missing a Type 1 for a reason that has nothing
    to do with what is under test here."""
    o = order(acc, **kw)
    o["study_uid"] = ("1.2.826.0.1.3680043.10.99999.9."
                      + ("".join(ch for ch in str(acc) if ch.isdigit()) or "0"))
    return o


def hostile_order(label, spec, i):
    """One of the shapes above, in the dict shape OrderStore really holds."""
    o = wire_order(f"H-{i}", station=spec.get("station", ""),
                   modality=spec.get("modality", "CT"), name=spec.get("name", "PHANTOM^TEST"))
    if "patient_id" in spec:
        o["patient_id"] = spec["patient_id"]
    if "acc_value" in spec:
        o["accession"] = spec["acc_value"]
    if "referring" in spec:
        o["referring"] = spec["referring"]
    return o


def test_an_order_typed_with_hostile_characters_still_reaches_the_scanner_whole():
    """Nine order shapes the intake form and the HL7 feed both permit, answered
    over a real association. Not one of them may produce an element a modality
    would reject — and not one may be answered with a blanked Type 1 either,
    which would be the same lost item reached by the other route."""
    orders = [hostile_order(label, spec, i)
              for i, (label, spec) in enumerate(HOSTILE_ORDERS.items())]
    fx = Fixture(orders)
    try:
        items = raw_find(fx)
        check(len(items) == len(orders),
              f"every one of the {len(orders)} orders is offered to the CT: {len(items)}")
        for ds, (label, _spec) in zip(items, HOSTILE_ORDERS.items()):
            faults = wire_faults(ds)
            check(faults == [], f"{label}: " + (" | ".join(faults) or "nothing a scanner would reject"))
    finally:
        fx.stop()


def test_an_order_typed_in_lower_case_is_still_selected_by_the_ct_that_asks():
    """The half a validating repair could take away. Matching is
    case-insensitive, so "ct" IS this CT's order; answering it with a legal
    value must not mean answering somebody else's query or none at all."""
    fx = Fixture([dict(wire_order("A-1", station="CT_ER_01"), modality="ct")])
    try:
        items = raw_find(fx, station_aet="CT_ER_01", modality="CT", date=TODAY)
        check(len(items) == 1, f"the CT's own query still selects it: {len(items)} item(s)")
        if items:
            step = items[0].ScheduledProcedureStepSequence[0]
            check(str(step.Modality) == "CT",
                  "…and is told the step is a CT, in the case the VR defines: "
                  + repr(str(step.Modality)))
            check(wire_faults(items[0]) == [], "…with nothing on the item a scanner would reject")
    finally:
        fx.stop()


def test_a_scanner_asking_for_a_date_that_is_not_a_date_gets_a_date_back():
    """A dateless order is stamped with the date that was asked for, and an SCU
    is free to ask for 20261340. Eight digits is the FORM of a DA, not a day:
    echoed straight back it is a Type 1 the modality cannot parse."""
    import datetime

    fx = Fixture([dict(wire_order("A-1", station="CT_ER_01"), scheduled_dt="")])
    try:
        for junk in ("20261340", "99999999", "20260229"):
            items = raw_find(fx, station_aet="CT_ER_01", date=junk)
            check(len(items) == 1, f"the order is still offered for {junk}")
            if not items:
                continue
            got = str(items[0].ScheduledProcedureStepSequence[0].ScheduledProcedureStepStartDate)
            try:
                datetime.date(int(got[0:4]), int(got[4:6]), int(got[6:8]))
                real = len(got) == 8
            except ValueError:
                real = False
            check(real, f"{junk} comes back as a real calendar date, not {got!r}")
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
        try:
            fn()
        except AssertionError:
            pass               # check() already recorded and printed it
    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
