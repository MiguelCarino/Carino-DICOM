"""The worklist half of an emergency: honestly reported, and not taken away.

Runs under pytest, or standalone: ./.venv/bin/python tests/test_emergency_worklist.py

An emergency reaches the modalities through exactly one thing — the Modality
Worklist. Everything else the controller does (hold-and-forward, the banner, the
notifications) is invisible to the tech standing at the scanner. Four claims:

  * **Resume normal does not confiscate a configured service.** Stopping the
    worklist unconditionally cost an appliance that permanently enables it
    (``mwl.enabled``, or a ``no_ris`` destination) its worklist after the first
    emergency episode, with nothing to bring it back — sync_worklist() runs on
    launch and on a config change, not on a timer. The emergency may undo what
    it did; it may not undo what the hospital configured.
  * **Activation reports what is true, not what it intended.** A start that
    failed used to be logged once and then announced as "Worklist serving", and
    the tech spent the outage pulling an empty worklist while the dashboard said
    everything was fine.
  * **A hand-keyed order still yields a legal worklist item.** Type 1
    attributes are required, non-zero-length; some modalities reject the whole
    item rather than the offending key, so an emergency order typed with a
    patient and an exam and nothing else would never appear on the scanner.
    Every one of them is enumerated below from the IOD and checked, for every
    order shape the intake form permits — the earlier version of this file
    named that guarantee and then checked four attributes, three of which the
    hand-keyed order does not even have.
  * **The orders typed during the outage keep reaching the modalities until
    somebody has scanned them.** Resume normal, and a configuration save,
    both used to end the only path a hand-keyed order has to a scanner while
    the order was still open — and the real RIS never heard about that order,
    so nothing else was going to serve it.

And one claim about the confirmation reception reads: queuing an order says
whether a worklist is actually serving it, because "Order queued" answered the
wrong question.
"""

from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pacs.config import Config                                      # noqa: E402
from pacs.emergency import ACTIVE, EmergencyController, TRIGGERED    # noqa: E402
from pacs.logbuf import LogBuffer                                   # noqa: E402
from pacs.mwl import (                                             # noqa: E402
    TEMP_PATIENT_PREFIX,
    UNSTATED_PROCEDURE,
    build_worklist_item,
    order_matches_query,
)
from pacs.ris import ORIGIN_MANUAL, ORIGIN_RIS, OrderStore          # noqa: E402


class FakeScp:
    def __init__(self, running=True):
        self.running = running

    def stop(self):                      # PacsServer.shutdown() calls it
        self.running = False


class FakeServer:
    """Only what the controller touches, plus the two things this file is about:
    an ``mwl_scp`` that can answer whether it is actually listening, and
    ``worklist_wanted()``, which is the same predicate the server itself starts
    the worklist from on launch."""

    def __init__(self, cfg, wanted=False, scp=None, start_raises=False,
                 start_succeeds=True):
        self.cfg = cfg
        self.notifier = None
        self.watcher = type("W", (), {"running": True})()
        self.mwl_scp = scp
        # A real OrderStore, under the attribute name PacsServer keeps its own
        # under (``self.orders`` — see start_mwl()'s get_orders lambda), because
        # standing down has to be able to ask whether anything hand-keyed during
        # the outage is still waiting to be scanned. A stub with one method
        # would only prove the controller calls the method this file expects;
        # the real store proves it reads the same open/closed and origin the
        # dashboard does.
        self.orders = OrderStore(tempfile.mkdtemp(prefix="carino-emg-mwl-orders-"))
        self.wanted = wanted
        self.start_raises = start_raises
        self.start_succeeds = start_succeeds
        self.started = 0
        self.stopped = 0

    def stuck_sends(self):
        return {"destinations": []}

    def worklist_wanted(self):
        return self.wanted

    def start_mwl(self):
        self.started += 1
        if self.start_raises:
            raise OSError("address already in use")
        if self.start_succeeds:
            self.mwl_scp = FakeScp(True)
        # else: returns without raising and nothing is listening — the case the
        # old code took at its word.

    def stop_mwl(self):
        self.stopped += 1
        self.mwl_scp = None

    def start_watcher(self):
        pass

    def retry_stuck(self):
        return {"reset": 0}


def controller(**kw):
    d = tempfile.mkdtemp(prefix="carino-emg-mwl-")
    cfg = Config(os.path.join(d, "config.json")).load()
    with cfg.mutate():
        cfg.emergency["armed"] = True
    ctl = EmergencyController(FakeServer(cfg, **kw), LogBuffer())
    ctl.state = TRIGGERED
    ctl.trigger_dest = "Primary PACS"
    return ctl


PASS, FAIL = [], []


def check(cond, label):
    (PASS if cond else FAIL).append(label)
    print(("  ok    " if cond else "  FAIL  ") + label)
    assert cond, label


# ---- Resume normal is not allowed to confiscate a configured service -------
def test_resume_leaves_a_worklist_that_configuration_permanently_enables():
    """The defect in one sentence: one emergency episode used to end with every
    modality in the hospital silently unscheduled."""
    ctl = controller(wanted=True, scp=FakeScp(True))
    ctl.activate()
    check(ctl.state == ACTIVE, "the emergency is active")
    ctl.resume()
    check(ctl.server.stopped == 0, "Resume normal did NOT stop the worklist")
    check(ctl.server.mwl_scp is not None and ctl.server.mwl_scp.running,
          "…so the modalities are still being served after the episode")


def test_resume_leaves_a_worklist_that_was_already_serving_before_the_emergency():
    """The other half of the same guard: not configured permanently, but it was
    up before we arrived, so it is not ours to take down."""
    ctl = controller(wanted=False, scp=FakeScp(True))
    ctl.activate()
    ctl.resume()
    check(ctl.server.stopped == 0, "a worklist we found running is left running")


def test_resume_stops_only_the_worklist_this_emergency_started():
    """And the emergency really does clean up after itself, or the guard above
    would just be a leak."""
    ctl = controller(wanted=False, scp=None)
    ctl.activate()
    check(ctl.server.started == 1, "activation started the worklist")
    check(ctl.server.mwl_scp is not None, "…and it came up")
    ctl.resume()
    check(ctl.server.stopped == 1, "standing down stopped the one we started")


def test_a_worklist_enabled_during_the_outage_is_not_stopped_on_the_way_out():
    """Re-asked at resume() rather than decided at activation, because an
    administrator may enable it while the emergency is running."""
    ctl = controller(wanted=False, scp=None)
    ctl.activate()
    ctl.server.wanted = True                     # somebody enabled it mid-outage
    ctl.resume()
    check(ctl.server.stopped == 0, "the now-permanent worklist survives Resume normal")


# ---- activation reports what is true ---------------------------------------
def test_a_worklist_that_did_not_come_up_is_never_reported_as_serving():
    """start_mwl() returning without raising is not a bound port: it is
    idempotent and returns early when an SCP object already exists. The SCP
    itself has to be asked."""
    ctl = controller(wanted=False, scp=None, start_succeeds=False)
    ctl.activate()
    st = ctl.status()
    check(st["worklist_serving"] is False, "status says the worklist is NOT serving")
    check(bool(st["worklist_error"]), "…and names a reason rather than leaving it blank")
    lines = [it["message"] for it in ctl.log.since(0)]
    check(any("NOT SERVING" in m for m in lines),
          "the activation line says so too, instead of 'Worklist serving'")


def test_a_worklist_that_failed_to_start_is_reported_and_not_claimed():
    ctl = controller(wanted=False, scp=None, start_raises=True)
    ctl.activate()
    st = ctl.status()
    check(st["worklist_serving"] is False, "a raised start is not serving either")
    check("failed to start" in st["worklist_error"], "the status carries a short reason")
    lines = [it["message"] for it in ctl.log.since(0)]
    check(any("address already in use" in m for m in lines),
          "the exception itself is in the log, where the person who can act reads it")
    check(not any("address already in use" in str(st[k]) for k in ("worklist_error",)),
          "…and not in the status block, which reaches every signed-in profile")


def test_a_worklist_that_dies_mid_outage_is_reported_and_its_return_clears_it():
    """Asked on every tick rather than remembered from activate(), or a verdict
    an hour old sticks to the banner for the rest of the outage."""
    ctl = controller(wanted=False, scp=None)
    ctl.activate()
    check(ctl.status()["worklist_serving"] is True, "it came up")
    ctl.server.mwl_scp.running = False           # the SCP died
    ctl._recheck_worklist()
    check(ctl.status()["worklist_serving"] is False, "the next tick notices")
    check(bool(ctl.mwl_error), "…and says why")
    ctl.server.mwl_scp.running = True            # the operator restarted it
    ctl._recheck_worklist()
    check(ctl.status()["worklist_serving"] is True, "a worklist that returns clears the alarm")
    check(ctl.mwl_error == "", "…and leaves no stale reason behind")


def test_a_server_that_cannot_answer_is_not_accused_of_an_outage():
    """None is not a failure: a server object that does not expose mwl_scp at
    all is no evidence either way, and this file's older behaviour — take a
    start that did not raise at its word — is what it must keep."""
    ctl = controller(wanted=False, scp=None)
    real = ctl.server

    class Bare:                          # no mwl_scp attribute at all
        cfg = real.cfg
        notifier = None
        watcher = real.watcher
        stuck_sends = staticmethod(real.stuck_sends)
        retry_stuck = staticmethod(real.retry_stuck)
        start_mwl = stop_mwl = start_watcher = staticmethod(lambda: None)

    ctl.server = Bare()
    ctl.activate()
    check(ctl.status()["worklist_serving"] is True,
          "unknowable reads as serving, exactly as before this change")
    check(ctl.mwl_error == "", "and nothing is claimed about it")


# ---- the item a modality actually receives ---------------------------------
# Type 1 means required AND non-zero-length (PS3.5 7.4.1): sending the tag with
# nothing in it does not satisfy it, and a modality is entitled to drop the
# whole item rather than the one key — which is how an order the receptionist
# watched being queued never appears on the scanner, and the outage reads as a
# Carino fault.
#
# Enumerated from the IOD, not from the attributes that happen to pass: the
# Scheduled Procedure Step module (PS3.3 C.4.10) for the sequence and what is
# inside it, the Requested Procedure module (PS3.3 C.4.11) for the two
# top-level ones. Every attribute build_worklist_item() sets that is Type 1 is
# in one of the two tuples; anything it sets that is NOT is deliberately absent,
# because an empty Type 2 (Accession Number on a name-only order, Patient's
# Birth Date on anybody unidentified) is a legal and honest answer.
SPS_TYPE_1 = (
    ("Modality", "(0008,0060) Modality"),
    ("ScheduledStationAETitle", "(0040,0001) Scheduled Station AE Title"),
    ("ScheduledProcedureStepStartDate", "(0040,0002) SPS Start Date"),
    ("ScheduledProcedureStepStartTime", "(0040,0003) SPS Start Time"),
    ("ScheduledProcedureStepID", "(0040,0009) Scheduled Procedure Step ID"),
)
TOP_TYPE_1 = (
    ("StudyInstanceUID", "(0020,000D) Study Instance UID"),
    ("RequestedProcedureID", "(0040,1001) Requested Procedure ID"),
)
# Patient's Name and Patient ID are Type 2 in the Patient Identification module,
# so they are not on the list above — but PS3.4 Table K.6-1 makes both REQUIRED
# MATCHING KEYS of the worklist model, and this SCP answers queries on both
# (mwl.order_matches_query). Returned zero-length they are worse than a dropped
# item: the row IS offered to the scanner, the tech reads a nameless line, and
# the identity the modality burns into the exam names nobody. Held to the same
# non-zero-length bar here, for that reason rather than by citing Type 1.
MATCHING_KEY_REQUIRED = (
    ("PatientName", "(0010,0010) Patient's Name"),
    ("PatientID", "(0010,0020) Patient ID"),
)

# Type 1C is not a softer Type 2. Both description attributes below are
# required if their code-sequence alternative is absent (PS3.4 Table K.6-1:
# (0040,0007) against (0040,0008), (0032,1060) against (0032,1064)), and
# build_worklist_item() emits neither sequence on any item it builds — so the
# condition is met on every row this appliance ever puts on a scanner, and both
# are as required here as the Type 1s above. They are listed separately anyway,
# because WHY they are required is a different sentence and the next person to
# add a code sequence needs to find it.
#
# The cost of getting this wrong is not only conformance. (0040,0007) is the
# column the tech reads to know what exam to perform, so an item that ships it
# zero-length puts a patient name and a blank on the scanner — and the order
# is not obliged to carry a description at all, which makes the empty one the
# ORDINARY shape rather than an edge case.
REQUIRED_1C = (
    ("RequestedProcedureDescription",
     "(0032,1060) Requested Procedure Description, 1C with no (0032,1064)"),
)
SPS_REQUIRED_1C = (
    ("ScheduledProcedureStepDescription",
     "(0040,0007) SPS Description, 1C with no (0040,0008)"),
)

# The VR length caps the attributes above have to fit, because every one of them
# is now filled from a FALLBACK on a hand-keyed order, and an over-long fallback
# fails the same way an empty one does — the SCU rejects the item and the order
# is not on the worklist. SH is 16, AE is 16, CS is 16, LO is 64 (PS3.5 6.2).
VR_MAX = {
    "Modality": 16,                      # CS
    "RequestedProcedureDescription": 64,          # LO
    "ScheduledProcedureStepDescription": 64,      # LO
    "ScheduledStationAETitle": 16,       # AE
    "ScheduledProcedureStepID": 16,      # SH
    "RequestedProcedureID": 16,          # SH
    "PatientID": 64,                     # LO
}


def order(**fields) -> dict:
    """One order as the appliance really stores it.

    Built through OrderStore rather than written out as a literal, so what
    reaches build_worklist_item() is the dict MwlSCP actually hands it —
    ``self.orders.list("open")`` — complete with the id the store stamps and
    the Study Instance UID it generates up front. A literal dict is a
    friendlier input than the product ever sees, and the version of this file
    that used one is why three empty Type 1s went unnoticed.
    """
    d = tempfile.mkdtemp(prefix="carino-emg-mwl-ord-")
    return OrderStore(d).add(fields, source="manual", origin=ORIGIN_MANUAL)


def empty_required(ds) -> list:
    """Every required-non-empty attribute of *ds* that is absent or zero-length,
    named the way a conformance statement names it.

    A list rather than a check per attribute on purpose: one run then tells
    whoever is reading it ALL of what is missing from the item, instead of the
    first one, which is the difference between one repair and four rounds.
    """
    gaps = [name for attr, name in TOP_TYPE_1 + MATCHING_KEY_REQUIRED + REQUIRED_1C
            if not str(getattr(ds, attr, "") or "").strip()]
    seq = getattr(ds, "ScheduledProcedureStepSequence", None)
    if not seq:
        # The sequence itself is Type 1, and an item without one is not a
        # worklist item at all — there is nothing further to report about it.
        return gaps + ["(0040,0100) Scheduled Procedure Step Sequence"]
    step = seq[0]
    return gaps + [name for attr, name in SPS_TYPE_1 + SPS_REQUIRED_1C
                   if not str(getattr(step, attr, "") or "").strip()]


SPS_ATTRS = SPS_TYPE_1 + SPS_REQUIRED_1C


def in_step(attr) -> bool:
    """True when *attr* lives inside the Scheduled Procedure Step, not on the
    top-level dataset.

    Asked through one named list because the two helpers below both have to
    look in the right place, and the version of this that tested membership of
    SPS_TYPE_1 alone sent every SPS attribute that is not Type 1 to the
    top-level dataset — where it is absent, the "skip what is not there" guard
    fires, and the attribute is reported clean without ever being looked at."""
    return any(attr == a for a, _ in SPS_ATTRS)


def too_long(ds) -> list:
    """Every filled attribute whose value does not fit its VR."""
    seq = getattr(ds, "ScheduledProcedureStepSequence", None)
    step = seq[0] if seq else None
    over = []
    for attr, cap in VR_MAX.items():
        src = step if in_step(attr) else ds
        if src is None:
            continue          # empty_required() already reported the missing sequence
        value = str(getattr(src, attr, "") or "")
        if len(value) > cap:
            over.append(f"{attr}={value!r} ({len(value)} > {cap})")
    return over


# The three tuples above say what may not be EMPTY. This one is a different bar
# on the same attributes: a value that is present but not LEGAL for its VR fails
# in exactly the same way, because an SCU strict enough to drop an item over a
# zero-length Type 1 is the same SCU strict enough to drop it over a CS full of
# punctuation. Accession Number rides along although it is Type 2 — it is
# returned verbatim from the order (mwl.build_worklist_item) and nothing between
# the intake form and the item caps it, so it is the one remaining place an
# operator's typing reaches a modality unchecked.
VALIDATED = SPS_TYPE_1 + TOP_TYPE_1 + MATCHING_KEY_REQUIRED + REQUIRED_1C + SPS_REQUIRED_1C + (
    ("AccessionNumber", "(0008,0050) Accession Number"),
    # Referring Physician's Name rides along for the same reason the accession
    # does: Type 2, returned from the order with no check of its own
    # (mwl.build_worklist_item passes it through _pn_fit and nothing else), and
    # filled from an intake field the operator types free text into.
    ("ReferringPhysicianName", "(0008,0090) Referring Physician's Name"),
)


def illegal(ds) -> list:
    """Every filled attribute of *ds* whose value is not legal for its VR.

    Two checks, and the order of them is the whole point of this helper.

    **Value multiplicity first, on the raw element.** Every attribute in
    VALIDATED is VM 1 in the MWL IOD, so a value that arrives on the wire as
    two is illegal however legal each half looks. pydicom splits an element on
    ``\\`` — PN, CS, AE and SH all permit multiplicity at the VR level — so the
    element holds a MultiValue, and an SCU assigning that back to a VM-1 tag
    raises. This check used to be made AFTER ``str()``, and str() on a
    MultiValue yields a Python repr: ``"['A^B', 'C=D']"`` for SH and
    ``'[DOE, JANE]'`` for PN both pass pydicom's character-set check, because
    brackets, commas, quotes and spaces are all inside SH's and PN's
    repertoires. The gate therefore reported a split Type 1 attribute as legal
    — it could not see the one shape its docstring claimed to catch — which is
    why a backslash typed into the intake form reached a live C-FIND
    unnoticed. A bare ``\\`` inside a string value is the same defect arriving
    in the form pydicom did not split, so it is named here too.

    **Then the VR itself**, through pydicom's own validator rather than a
    hand-rolled character class, because it is the same check the toolkit on the
    receiving modality performs and it catches every remaining way one value
    goes wrong at once: the VR's character set, its length cap, and — for PN —
    the per-component cap that a flat length check in too_long() cannot
    express. Stringifying is safe at this point and nowhere earlier: whatever
    is left is a single value, and str() of a PersonName is the name.
    """
    from pydicom import config
    from pydicom.datadict import dictionary_VR
    from pydicom.multival import MultiValue
    from pydicom.valuerep import validate_value

    seq = getattr(ds, "ScheduledProcedureStepSequence", None)
    step = seq[0] if seq else None
    bad = []
    for attr, name in VALIDATED:
        src = step if in_step(attr) else ds
        if src is None or attr not in src:
            continue          # empty_required() already reports what is absent
        value = src[attr].value
        vr = dictionary_VR(src[attr].tag)
        if isinstance(value, (MultiValue, list, tuple)):
            bad.append(f"{name} (VR {vr}) = {list(value)!r}: "
                       f"{len(value)} values in a VM 1 attribute")
            continue
        if value is None or str(value) == "":
            continue          # …and what is there but zero-length
        if "\\" in str(value):
            bad.append(f"{name} (VR {vr}) = {str(value)[:24]!r}: "
                       "carries a backslash, which is the value delimiter")
            continue
        try:
            validate_value(vr, str(value), config.RAISE)
        except ValueError as exc:
            bad.append(f"{name} (VR {vr}) = {str(value)[:24]!r}: {str(exc).split('.')[0]}")
    return bad


def query(modality="", station="", patient_name="", patient_id="",
          accession="", date=""):
    """A C-FIND identifier shaped like a modality's, for the leniency checks.

    Default is the all-empty (universal) query, which is a real thing a modality
    sends and the hardest case for the item builder: nothing was asked, so
    nothing can be echoed back, and every blank the order left has to be filled
    from a stand-in or not at all.

    Every argument is written into the identifier UNVALIDATED and may be any
    value a real SCU can put on the wire — a list, an over-long string, one
    carrying characters its VR forbids. That is the point of the helper: this
    appliance echoes query values into its own Type 1 attributes, so the SCU is
    an untrusted input to the item builder, and a helper that could only build
    well-formed single-valued strings was why the echo rule went out with no
    inspection of what it was echoing. pydicom warns on each of those
    assignments; the warning is suppressed here because building the malformed
    identifier is deliberate, and the item built FROM it is what is under test.
    """
    import warnings

    from pydicom.dataset import Dataset

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        ds = Dataset()
        ds.PatientName = patient_name
        ds.PatientID = patient_id
        ds.AccessionNumber = accession
        step = Dataset()
        step.Modality = modality
        step.ScheduledStationAETitle = station
        step.ScheduledProcedureStepStartDate = date
        ds.ScheduledProcedureStepSequence = [step]
    return ds


def item_for(o, q=None):
    """The worklist item ``build_worklist_item`` returns for order *o*, answering
    query *q*.

    The signature is inspected rather than assumed. The module's own rule — a
    key matched leniently comes back as the value the SCU asked for — can only
    be applied by a builder that is handed the query, so the parameter may or
    may not be there while this is being repaired; either way the ITEM is what
    these tests are about, and a universal query is the right default because a
    legal item may not depend on the SCU having filled anything in.
    """
    import inspect

    if len(inspect.signature(build_worklist_item).parameters) > 1:
        return build_worklist_item(o, query() if q is None else q)
    return build_worklist_item(o)


def test_a_hand_keyed_order_yields_a_worklist_item_with_no_empty_type_1s():
    """Patient and exam typed, nothing else — the emergency order this whole
    feature exists for. Every required attribute, not a sample of them."""
    o = order(patient="DOE^JANE", study_desc="CT HEAD")
    ds = item_for(o)
    check(empty_required(ds) == [],
          "no required attribute is zero-length; empty: " + (", ".join(empty_required(ds)) or "none"))
    check(too_long(ds) == [],
          "…and no filled-in fallback overflows its VR: " + (", ".join(too_long(ds)) or "none"))

    step = ds.ScheduledProcedureStepSequence[0]
    check(str(step.ScheduledProcedureStepID) == o["id"],
          "the step id is the order's own id, so the exam comes back naming its order")
    check(str(ds.StudyInstanceUID) == o["study_uid"],
          "the UID is the order's own, so the exam reconciles to it exactly")
    check(str(step.ScheduledProcedureStepStartTime) == "000000",
          "the time is midnight of that day: deterministic, sorts to the head, claims nothing")
    # Determinism is the half a clock-based fallback would fail.
    again = item_for(o)
    check(str(again.ScheduledProcedureStepSequence[0].ScheduledProcedureStepStartTime)
          == str(step.ScheduledProcedureStepStartTime),
          "two C-FINDs a second apart return the identical item")
    check(str(again.PatientID) == str(ds.PatientID),
          "…including the identifier, which is a fallback and must not drift either")


def test_every_order_shape_the_intake_form_accepts_yields_a_legal_item():
    """add_order() takes an order carrying any ONE of accession, patient name or
    patient ID (server.add_order). Each of those three is a real thing a
    receptionist types during an outage — a trauma patient with no name yet is
    an accession, a name arriving ahead of the paperwork is a name — and each
    one has to produce an item a scanner will accept, not just the friendly
    shape with every box filled."""
    shapes = {
        "a name-only trauma order": order(patient="DOE^JANE"),
        "an accession-only order": order(accession="ER-4471"),
        "a patient-ID-only order": order(patient_id="TRAUMA-7"),
        "an order with no modality": order(patient="DOE^JANE", accession="ER-1",
                                           station_aet="CT_ER_01"),
        "an order with no station AET": order(patient="DOE^JANE", accession="ER-2",
                                              modality="CT"),
        "an order with neither": order(patient="DOE^JANE", accession="ER-3",
                                       study_desc="CT HEAD"),
    }
    for label, o in shapes.items():
        ds = item_for(o)
        gaps = empty_required(ds)
        check(gaps == [], f"{label} is legal; empty: " + (", ".join(gaps) or "none"))
        check(too_long(ds) == [], "…and fits every VR: " + (", ".join(too_long(ds)) or "none"))


def test_what_the_order_does_say_is_returned_verbatim_and_never_overwritten():
    """The other edge of filling the blanks in: a fallback that also fires when
    the order HAS the value would put a guess on the scanner in place of what
    the receptionist typed, which is a worse failure than the empty one — it is
    wrong rather than missing, and nothing on the screen says so.

    The query below deliberately contradicts the order on both echoed keys.
    _handle_find would never pair the two — order_matches_query rejects an MR
    order for a CT's query — so this is a guard on the function's contract
    rather than a scenario: echoing the queried value is a FALLBACK for a blank,
    never an override of a stated one."""
    o = order(patient="DOE^JANE", patient_id="MRN-99", accession="ER-9",
              modality="MR", station_aet="MR_1", study_desc="MRI BRAIN",
              sps_id="SPS-1", procedure_id="RP-1")
    ds = item_for(o, query(modality="CT", station="CT_ER_01"))
    step = ds.ScheduledProcedureStepSequence[0]
    check(str(ds.PatientID) == "MRN-99", "the typed patient ID is the one returned")
    check(str(ds.PatientName) == "DOE^JANE", "…and the typed name")
    check(str(step.Modality) == "MR", "the typed modality is not replaced by a fallback")
    check(str(step.ScheduledStationAETitle) == "MR_1", "…nor the typed station")
    check(str(step.ScheduledProcedureStepID) == "SPS-1", "…nor the step id")
    check(str(ds.RequestedProcedureID) == "RP-1", "…nor the requested procedure id")
    check(str(ds.AccessionNumber) == "ER-9", "and the accession comes back as typed")


def test_an_untargeted_order_is_still_shown_to_every_modality_that_asks():
    """The leniency the blank fields buy is the point of them, and filling the
    Type 1s in must not cost it: an order addressed to no modality still has to
    be SELECTED by a CT asking for CT, or the fix for the empty attribute would
    have taken the order off the worklist by another route."""
    o = order(patient="DOE^JANE", study_desc="CT HEAD")
    check(order_matches_query(o, query(modality="CT", station="CTSCAN1")),
          "the CT's query selects the untargeted order")
    check(order_matches_query(o, query(modality="MR", station="MR_1")),
          "…and so does the MR's — untargeted means everywhere")
    check(order_matches_query(o, query(patient_name="DOE^JANE")),
          "and a query by name finds it")
    check(not order_matches_query(o, query(patient_name="SMITH^JOHN")),
          "…while a query for somebody else does not")


def test_a_key_matched_leniently_comes_back_as_the_value_the_scanner_asked_for():
    """The rule the module's own docstring states, and the reason the blank
    Modality was a defect rather than an honest answer. The item reached this
    CT *because* the order names no modality; returning the tag empty fails
    Type 1, and returning a guess contradicts the key the SCU matched on. The
    value the scanner asked for is the only answer that is neither — and it is
    true, because this item is being offered to that scanner to perform."""
    o = order(patient="DOE^JANE", study_desc="CT HEAD")
    step = item_for(o, query(modality="CT", station="CTSCAN1")).ScheduledProcedureStepSequence[0]
    check(str(step.Modality) == "CT",
          "the CT that pulled the untargeted order is told the step is a CT")
    mr = item_for(o, query(modality="MR")).ScheduledProcedureStepSequence[0]
    check(str(mr.Modality) == "MR",
          "…and the MR that pulled the same order is told it is an MR")
    check(str(item_for(o, query(modality="CT*")).ScheduledProcedureStepSequence[0].Modality) != "CT*",
          "a wildcard is not echoed back verbatim — it is a pattern, not a modality")


# The echo rule turns every worklist SCU into an input to our item builder: a
# value arrives off the wire and is written straight into a Type 1 attribute of
# the item we hand back. A shared CT/MR console legitimately asks with a
# multi-valued Modality, and nothing stops a badly-written one asking with forty
# characters of punctuation. Echoed without inspection, that is an item a
# validating modality drops — the exact failure filling the blank Modality in
# was meant to end, reached from the other side. The wildcard was the only
# hostile value the earlier version of this file covered.
HOSTILE_MODALITIES = (
    (["CT", "MR"], "a multi-valued Modality (CT\\MR) from a shared CT/MR console"),
    ("A" * 40, "a Modality forty characters long, well past CS's cap of sixteen"),
    ("ct;head", "a Modality carrying characters CS does not permit"),
    ("CT*", "a wildcard, which is a pattern and not a modality"),
)


def test_a_hostile_query_value_is_not_echoed_into_the_item_verbatim():
    """The echoed key must end up a legal single CS value whatever the SCU sent.

    Falling back to the stand-in is the right answer for all of these, and it is
    the answer the wildcard already gets: the order genuinely names no modality,
    so there is nothing true to say, and an item that says UNSTATED is one the
    scanner can still perform. What it may not be is an item nobody will accept.
    """
    o = order(patient="DOE^JANE", study_desc="CT HEAD")
    for value, label in HOSTILE_MODALITIES:
        ds = item_for(o, query(modality=value, station="CTSCAN1"))
        step = ds.ScheduledProcedureStepSequence[0]
        check(illegal(ds) == [],
              f"{label}: the item is still legal; illegal: " + (", ".join(illegal(ds)) or "none"))
        check(empty_required(ds) == [],
              "…and nothing was blanked out to achieve that: "
              + (", ".join(empty_required(ds)) or "none"))
        check(str(step.Modality) != str(value),
              "…and what the SCU sent is not what came back: " + repr(str(step.Modality)))

    # ScheduledStationAETitle is never echoed at all, but it is filled from a
    # stand-in on the same code path, so the same hostile query has to leave it
    # alone rather than reflect the room name the SCU invented.
    aet = item_for(o, query(station="X" * 40)).ScheduledProcedureStepSequence[0]
    check(str(aet.ScheduledStationAETitle) != "X" * 40,
          "an over-long station AE title in the query is not echoed into AE either")


# The tests above are the ECHO half of the multi-value defence — what the query
# is allowed to put INSIDE an item. This is the SELECTION half, which decides
# whether there is an item at all, and it reads the same untrusted query.
#
# It went untested for four rounds, and the gap had a precise shape worth
# naming so it is not reopened: HOSTILE_MODALITIES was fed to item_for() alone,
# always against an order carrying NO modality. A blank order field takes
# _match_text's lenient arm and returns True before the comparison is ever
# reached, so those runs exercised the builder and never the matcher —
# order_matches_query was not called with a multi-valued key anywhere in this
# file. A `str(query_value or "")` coercion on the match path therefore shipped:
# pydicom hands a multi-valued key back as a MultiValue, str() of which is its
# Python repr (`"['CT', 'MR']"`), which equals no modality anybody ever typed.
# Every order that NAMED one vanished from a shared console's worklist, and the
# untargeted ones survived — by the same leniency that hid the defect. The
# orders lost were the well-formed ones.
#
# The bar every test below is written against is the module's own promise (see
# "Keys we do NOT match on" in pacs/mwl.py): an unhonoured key may only ever
# WIDEN the answer — "the modality is shown items it did not ask for, never
# deprived of one it did". So widening is licensed here and is never asserted
# against: a key the module declines to honour may legally return more rows, and
# a test that pinned the row count would forbid a repair the module reserves the
# right to make. What may never happen is the other direction, and that is what
# is checked — an order naming exactly what the console asked for is selected,
# and an order naming nothing is still selected by everybody.


def selected(orders, q) -> set:
    """The labels of *orders* (a label→order dict) that query *q* selects.

    A set of labels rather than a count, because the question these tests ask is
    always *which* order went missing: a bare number tells whoever reads the
    failure that the worklist is short and not that it is short of the one order
    the receptionist typed a modality into.
    """
    return {label for label, o in orders.items() if order_matches_query(o, q)}


def test_a_shared_console_asking_for_two_modalities_sees_at_least_what_one_would():
    """``Modality=CT\\MR`` is not a hostile shape — it is what a shared CT/MR
    console sends, as this module states in its own matching notes, and the
    room it describes is an ordinary one in a small hospital.

    The invariant is stated so that it does not prescribe an implementation:
    asking for CT *or* MR may not return fewer orders than asking for CT alone,
    nor fewer than asking for MR alone. Honouring the key as an OR satisfies
    that; so does declining to honour it and widening to everything, which is
    the disposition pacs/mwl.py reserves for the keys it does not match on.
    Hiding the CT order from the CT satisfies neither, and that single outcome
    is what these checks forbid.
    """
    orders = {
        "the CT order": order(patient="DOE^JANE", study_desc="Head CT", modality="CT"),
        "the MR order": order(patient="ROE^JOHN", study_desc="Brain MR", modality="MR"),
        "an XA order": order(patient="POE^SAM", study_desc="Angio", modality="XA"),
        "an untargeted order": order(patient="VOE^KIM", study_desc="Chest"),
    }
    both = selected(orders, query(modality=["CT", "MR"]))
    check("the CT order" in both,
          "the shared CT/MR console is still shown the order typed CT; it sees "
          + repr(sorted(both)))
    check("the MR order" in both, "…and the order typed MR")
    check("an untargeted order" in both,
          "…and the untargeted order, which every modality is shown")
    # Not a restatement of the three checks above: each single-valued query is
    # one a real console sends, and if splitting the room into two
    # single-modality consoles would show MORE work than the shared one, the
    # shared console is being deprived of orders it asked for by name.
    ct = selected(orders, query(modality="CT"))
    mr = selected(orders, query(modality="MR"))
    check(ct <= both, "CT\\MR shows everything a plain CT query shows; missing: "
          + (", ".join(sorted(ct - both)) or "none"))
    check(mr <= both, "…and everything a plain MR query shows; missing: "
          + (", ".join(sorted(mr - both)) or "none"))
    # Which value the SCU sent first is its business and not a filter.
    check(selected(orders, query(modality=["MR", "CT"])) == both,
          "…and the answer does not depend on the order of the values sent")
    # This one is about the WIRE, not the panel. #ordMod is a closed list of
    # upper-case codes now, so the dashboard can no longer submit "ct" — but the
    # two other doors into the store are unchanged and rightly so: HL7 OBR-24
    # carries whatever the sending RIS wrote there, and POST /api/orders takes
    # the field it is given. _match_text compares .upper() on both sides, so an
    # order that arrived as "ct" IS a CT order, and a shared console may not
    # lose it either.
    lower = {"an order that arrived as 'ct'": order(patient="LOE^ANN", modality="ct")}
    check(selected(lower, query(modality=["CT", "MR"])) == {"an order that arrived as 'ct'"},
          "a modality in lower case is still selected by the console's CT\\MR")


def test_a_multi_valued_date_does_not_hide_the_days_it_asked_for():
    """The same coercion sat on the date key, and a console asking for two days
    is asking for MORE work, not less — a weekend list, a "today and tomorrow"
    prefetch before the link goes down. Coerced into a repr the value equals no
    day at all, and the only orders left are the dateless ones, spared by the
    same leniency that masked the modality defect."""
    orders = {
        "an order scheduled on the first": order(patient="DOE^JANE",
                                                 scheduled_dt="2026-01-01T09:00"),
        "an order scheduled on the second": order(patient="ROE^JOHN",
                                                  scheduled_dt="2026-01-02T09:00"),
        "an order scheduled in June": order(patient="POE^SAM",
                                            scheduled_dt="2026-06-15T09:00"),
        "a dateless order": order(patient="VOE^KIM", study_desc="Chest"),
    }
    both = selected(orders, query(date=["20260101", "20260102"]))
    check("an order scheduled on the first" in both,
          "a two-day query still shows the first of the days it named; it sees "
          + repr(sorted(both)))
    check("an order scheduled on the second" in both, "…and the second")
    check("a dateless order" in both,
          "…and the dateless order, which a date filter may never hide")
    first = selected(orders, query(date="20260101"))
    second = selected(orders, query(date="20260102"))
    check((first | second) <= both,
          "…so asking for two days shows at least what asking for either one shows; missing: "
          + (", ".join(sorted((first | second) - both)) or "none"))
    # The other edge, or "stop hiding things" could be satisfied by matching
    # everything and the date key would have been deleted rather than repaired.
    # The range form is the honoured, single-valued way of asking the same
    # question, and it still has to filter.
    ranged = selected(orders, query(date="20260101-20260102"))
    check("an order scheduled in June" not in ranged,
          "a real date RANGE still filters: the June order is not on a January list")


def test_a_multi_valued_top_level_key_does_not_empty_the_worklist_outright():
    """PatientID, PatientName, AccessionNumber and StudyInstanceUID are matched
    with NO leniency — there is no "the order left it blank" arm on them,
    because an order carrying no accession is not an order about every
    accession. A coercion there therefore does not hide the well-formed orders
    and spare the blank ones the way the modality key did: it hides every order
    there is, and the console is handed an empty list with the association
    succeeding and nothing logged anywhere saying why.

    Two accessions on one query is what a technologist's filter sends when two
    cases are pulled onto one console."""
    orders = {
        "the first accession": order(patient="DOE^JANE", accession="A05"),
        "the second accession": order(patient="ROE^JOHN", accession="A06"),
        "a third case entirely": order(patient="POE^SAM", accession="A99"),
    }
    both = selected(orders, query(accession=["A05", "A06"]))
    check(bool(both),
          "a two-accession query does not come back empty; it sees " + repr(sorted(both)))
    check("the first accession" in both and "the second accession" in both,
          "…and both of the accessions it named by name are on the list")
    one = selected(orders, query(accession="A05"))
    check(one <= both, "…so it shows at least what asking for one of them shows; missing: "
          + (", ".join(sorted(one - both)) or "none"))
    check(one == {"the first accession"},
          "and a single accession still filters to the one case it named")


def test_every_hostile_query_shape_still_selects_the_order_that_names_it():
    """HOSTILE_MODALITIES pushed through the COMPARISON rather than the builder,
    and against orders that STATE a modality rather than leaving it blank —
    which is the whole point, since a blank one returns True on the lenient arm
    before any comparison happens and proves nothing about selection.

    One bar for all four shapes, and it is the module's own: whatever the
    console asked for, an order naming that same thing is not hidden from it.
    For the shared console that means CT and MR both; for the wildcard it means
    the CT the pattern covers; for the over-long and the punctuated values it
    means an order carrying that same value — those two are values no order
    SHOULD carry, but nothing on the write path rejects them. The panel's closed
    list constrains the PANEL; HL7 and POST /api/orders still store the modality
    they are handed, and HOSTILE_ORDER_MODALITIES is the list of what really
    arrives that way, so the pair does meet in practice. Nothing here asserts
    that a hostile query shows FEWER orders: widening is the direction the
    module licenses.
    """
    for value, label in HOSTILE_MODALITIES:
        named = value[0] if isinstance(value, (list, tuple)) else value
        # The wildcard is the one shape whose subject is not the value itself:
        # "CT*" is a pattern, and the order it covers is the plain CT.
        wanted = "CT" if named == "CT*" else named
        orders = {
            "the order that names what it asked for": order(patient="DOE^JANE",
                                                            modality=wanted),
            "an untargeted order": order(patient="ROE^JOHN", study_desc="Chest"),
        }
        got = selected(orders, query(modality=value))
        check(got == set(orders),
              f"{label}: it hides neither the order naming what it asked for nor "
              "the untargeted one; it sees " + repr(sorted(got)))
        # A repr-based comparison is perfectly stable, so a wrong answer that
        # flickered would be a different and much louder bug — but selection is
        # what puts a patient on a scanner's list, so it is worth one line to
        # say that two identical C-FINDs a second apart select the same orders.
        check(selected(orders, query(modality=value)) == got,
              "…and the same query asked twice selects the same orders")

    # The first value of a multi-valued key is the one a half-repair reaches
    # (``q[0]`` instead of ``str(q)``), so the SECOND value is named separately:
    # the MR half of a shared CT/MR console is not a free rider on the CT half.
    mr_only = {"the MR order": order(patient="VOE^KIM", modality="MR")}
    check(selected(mr_only, query(modality=["CT", "MR"])) == {"the MR order"},
          "the second value of a multi-valued Modality selects too, not only the first")


# The SCU is not the only untrusted input to the item builder. The ORDER is the
# other one — and it is no longer the dashboard that makes it so. #ordMod is a
# closed list of DICOM codes, so the panel can now only submit a code some
# scanner actually asks for; the doors that stay open are HL7 (OBR-24 carries
# whatever the sending RIS wrote) and POST /api/orders, and they stay open on
# purpose, because refusing an order mid-outage is the one thing this whole
# feature exists to prevent. Whatever arrives that way goes straight into
# Modality (0008,0060), a Type 1 CS, ahead of the query echo — so the whole
# argument for validating the echoed value applies to it unchanged, and the
# query-side repair left this door open. Lower case is the ordinary case rather
# than a hostile one: _match_text compares .upper(), so an order carrying "ct"
# IS selected by a CT's query and then answered in a case CS forbids, which is
# the worst of the three outcomes — the item is offered and then dropped. Every
# value below is therefore a WIRE value; none of them can be typed into the
# panel any more, and every one of them can still reach this builder.
HOSTILE_ORDER_MODALITIES = (
    ("ct", "a modality typed in lower case, which is what the intake field collects"),
    ("Ct", "…and the half-capitalised form of the same"),
    ("ct;head", "a modality carrying characters CS does not permit"),
    ("CT\\MR", "a modality carrying the value delimiter itself"),
    ("A" * 40, "a modality forty characters long, well past CS's cap of sixteen"),
)


def test_the_orders_own_modality_is_validated_and_not_only_the_querys():
    """Whatever was typed, the CT that pulls this order is handed one legal CS
    value — and never the raw string."""
    for value, label in HOSTILE_ORDER_MODALITIES:
        o = order(patient="DOE^JANE", study_desc="CT HEAD", modality=value)
        ds = item_for(o, query(modality="CT", station="CTSCAN1"))
        step = ds.ScheduledProcedureStepSequence[0]
        check(illegal(ds) == [],
              f"{label}: the item is still legal; illegal: " + (", ".join(illegal(ds)) or "none"))
        check(empty_required(ds) == [],
              "…and nothing was blanked out to achieve that: "
              + (", ".join(empty_required(ds)) or "none"))
        check(str(step.Modality) != value,
              "…and what was typed is not what went on the wire: " + repr(str(step.Modality)))

    # The two cases above are not equivalent, and the difference matters to the
    # tech. "ct" is a modality the receptionist DID state, so the answer is that
    # modality in the case the VR defines — the same normalisation _echoable
    # already performs on the query side, and for the same reason: the order was
    # matched as CT, so returning CT returns the value that was matched. Falling
    # back to OT here would be legal and untrue, because OT is the coded way of
    # saying "equipment class not stated" and this order stated it.
    for typed in ("ct", "Ct", "CT"):
        o = order(patient="DOE^JANE", study_desc="CT HEAD", modality=typed)
        ds = item_for(o, query(modality="CT", station="CTSCAN1"))
        check(str(ds.ScheduledProcedureStepSequence[0].Modality) == "CT",
              f"a modality typed {typed!r} reaches the scanner as 'CT'")
        check(order_matches_query(o, query(modality="CT")),
              f"…and the CT's own query still selects the order typed {typed!r}")


def test_a_backslash_in_a_typed_field_never_splits_a_vm_1_attribute():
    """``\\`` is DICOM's value delimiter, and every attribute below is VM 1 in
    the MWL IOD. One backslash anywhere in the order therefore does not produce
    a wrong value — it produces TWO values in an attribute allowed one, which is
    the same lost item as an empty Type 1, from the other direction.

    Both doors reach here. The intake form has no sanitising on #ordPatient,
    #ordAcc or #ordRef; and an ordinary HL7 feed does it without anybody typing
    a backslash at all, because ``\\T\\`` is HL7's escape for ``&`` and
    ris.parse_order does not unescape it, so any name or organisation
    containing an ampersand arrives here carrying two of them.
    """
    o = order(patient="DOE\\JANE", patient_id="MRN\\99", accession="A^B\\C=D",
              modality="CT\\MR", station_aet="CT\\MR", referring="HOUSE\\G",
              study_desc="CT HEAD\\NECK", sps_id="SPS\\1", procedure_id="RP\\1")
    ds = item_for(o)
    check(illegal(ds) == [],
          "not one attribute went out split or delimiter-carrying: "
          + (", ".join(illegal(ds)) or "none"))
    check(empty_required(ds) == [],
          "…and nothing was emptied to achieve it: "
          + (", ".join(empty_required(ds)) or "none"))
    # Named separately because this is the one a real HL7 feed reaches on its
    # own, and because VM is the property under test — a MultiValue here cannot
    # even be assigned back to the tag by the SCU that receives it.
    check(ds["PatientName"].VM == 1, f"Patient's Name is one value, not {ds['PatientName'].VM}")


# The other half of "this value carries no name", and the half an `or` chain
# cannot see. PN's delimiters are legal characters, so a name built out of
# nothing else survives every check the fallback chain makes — it is a non-empty
# string — and then encodes to a value that is empty or blank. `=` is the worst
# of them: pydicom renders PersonName("=") as "", so a required matching key
# goes out ZERO-LENGTH from a value that looked filled. `^^` is the same defect
# one step milder: non-empty on the wire, and a blank line on the scanner's
# list, which is the nameless row the stand-in was written to replace.
#
# The typed field is the door. #ordPatient is free text with no sanitising; HL7
# sends its own empty-components form (`^^^^`) routinely for a name it does not
# have, but ris._fmt_hl7_name already flattens that to "" upstream, so the feed
# arrives here clean and the receptionist's keyboard does not.
DELIMITER_ONLY_NAMES = (
    ("=", "a lone group delimiter, which encodes to a zero-length value"),
    ("==", "…and the three-group form of the same nothing"),
    (" = ", "…and the same with the whitespace a typist leaves around it"),
    ("^", "a lone component delimiter"),
    ("^^", "an empty surname and given name"),
    ("^^^^", "the five-component empty XPN, typed rather than fed"),
)


def test_a_name_made_only_of_pn_delimiters_falls_through_to_the_stand_in():
    """A name of nothing but structure is treated as the absent name it is.

    The caller's rule is already the right one and was only half applied: a name
    made of characters PN cannot carry falls through to the UNKNOWN^<accession>
    stand-in, and a name made of characters PN carries only as STRUCTURE has to
    fall through by the same rule, because both of them name nobody.
    """
    for value, label in DELIMITER_ONLY_NAMES:
        o = order(patient=value, accession="ACC-7", study_desc="CT HEAD")
        ds = item_for(o)
        check(empty_required(ds) == [],
              f"{label}: nothing required came back empty; empty: "
              + (", ".join(empty_required(ds)) or "none"))
        check(illegal(ds) == [],
              "…and the item is still legal: " + (", ".join(illegal(ds)) or "none"))
        # empty_required() reads str(PersonName), which is "" for "=" but "^^"
        # for "^^" — so the blank-line case needs the stronger bar named here:
        # a name has to carry at least one character that is not a delimiter.
        check(str(ds.PatientName).strip("^= ") != "",
              "…and the name carries an actual character: " + repr(str(ds.PatientName)))
        check(str(ds.PatientName) == "UNKNOWN^ACC-7",
              "…which is the stand-in built from the accession, not what was typed")

    # The boundary in the other direction, or the rule above could be satisfied
    # by throwing every structured name away: `^` and `=` are what a properly
    # formatted DICOM name is MADE of, and one is still returned verbatim.
    kept = order(patient="DOE^JANE^Q", accession="ACC-7")
    check(str(item_for(kept).PatientName) == "DOE^JANE^Q",
          "a real structured name is returned exactly as it was given")


def test_a_typed_patient_id_too_long_for_lo_falls_back_to_the_stand_in():
    """Patient ID is the one required identifier that had no length check, and
    #ordPid is the one intake field with no maxlength — so the value that
    overrides the designed stand-in is also the value most able to break the
    attribute the stand-in exists to keep usable.

    Falling through is the answer, not truncation: RequestedProcedureID and the
    SPS ID already fall through (_within), and a sixty-four-character prefix of
    an identifier names a different patient to whoever merges the exam later,
    which is precisely the harm TMP- was written to avoid.
    """
    o = order(patient="DOE^JANE", patient_id="P" * 300)
    ds = item_for(o)
    check(illegal(ds) == [],
          "the item is legal: " + (", ".join(illegal(ds)) or "none"))
    check(too_long(ds) == [],
          "…and Patient ID fits LO: " + (", ".join(too_long(ds)) or "none"))
    check(str(ds.PatientID) != ("P" * 300)[:64],
          "the over-long identifier is not truncated into the attribute")
    check(str(ds.PatientID) == TEMP_PATIENT_PREFIX + o["id"],
          "…it falls through to the stand-in, which is searchable and names the order")
    # The boundary in the other direction, or the guard above could be satisfied
    # by discarding every typed identifier: what FITS is still what is returned.
    fits = order(patient="DOE^JANE", patient_id="Q" * 64)
    check(str(item_for(fits).PatientID) == "Q" * 64,
          "a sixty-four-character identifier is exactly what LO holds, and is kept")


# A DA is a CALENDAR date, not eight digits (PS3.5 6.2). pydicom's own validator
# checks the character set and the length and stops there, so these pass illegal()
# and still make the item unusable: the SCU parses (0040,0002) into a date and
# 20261340 is not one. Every value below is something a real SCU sends — a badly
# built date picker, a year-2100 rollover bug, an off-by-one on month length.
NON_CALENDAR_DATES = (
    ("20261340", "a thirteenth month"),
    ("20260231", "the thirty-first of February"),
    ("20260229", "the 29th of a February that has 28 days"),
    ("99999999", "all nines"),
    ("00000000", "all zeroes — there is no year zero"),
    ("20261340-20261350", "…and the same thing through the range form"),
)


def is_calendar_date(value: str) -> bool:
    import datetime as _dt
    try:
        _dt.date(int(value[0:4]), int(value[4:6]), int(value[6:8]))
    except (ValueError, TypeError):
        return False
    return len(value) == 8


def test_a_date_that_is_not_a_calendar_date_is_never_echoed_into_the_sps_date():
    """The echo rule's own limit: a dateless order is stamped with the date the
    scanner asked for, and the scanner may ask for something that is not a date.
    Today is the answer for one that is not — which is what _step_date's
    docstring already promises for a "malformed" query and only delivered for
    the ones malformed in length or character set."""
    o = order(patient="DOE^JANE", study_desc="CT HEAD")      # no date of its own
    for value, label in NON_CALENDAR_DATES:
        ds = item_for(o, query(date=value))
        got = str(ds.ScheduledProcedureStepSequence[0].ScheduledProcedureStepStartDate)
        check(is_calendar_date(got), f"{label}: the item carries a real date, not {got!r}")
        check(got != value.partition("-")[0],
              "…and not the junk the SCU sent back at it: " + repr(got))
        check(illegal(ds) == [], "…with the rest of the item still legal: "
              + (", ".join(illegal(ds)) or "none"))

    # The other edge, or "return today whenever anything looks odd" would pass
    # the loop above and destroy the feature: a date that IS a date is still
    # echoed, and a range still clamps into range rather than answering today.
    exact = item_for(o, query(date="20260110")).ScheduledProcedureStepSequence[0]
    check(str(exact.ScheduledProcedureStepStartDate) == "20260110",
          "a real date asked for is still the date returned")
    ranged = item_for(o, query(date="20200101-20200110")).ScheduledProcedureStepSequence[0]
    check(str(ranged.ScheduledProcedureStepStartDate) == "20200110",
          "…and a range whose end is in the past still clamps to its end")


def test_an_over_long_accession_stays_inside_the_attributes_it_lands_in():
    """A barcode-derived accession runs well past sixty-four characters, and the
    intake form as shipped accepts it: #ordAcc is plain free text with no
    maxlength and no character class, and neither add_order nor the store caps
    it. That is deliberate rather than an oversight — an accession is COPIED off
    a requisition or scanned off a barcode, never chosen, so the panel cannot
    constrain it the way it constrains the modality. Which is precisely why the
    item builder has to.

    It lands in two places. On an accession-only trauma order it becomes the
    second component of the PatientName stand-in, where PN allows sixty-four
    characters per component; and it is returned as Accession Number itself,
    verbatim, into an SH that allows sixteen. Both are the one-way trip the rest
    of this section is about — a value we generated that the scanner rejects,
    leaving the order off the worklist with nothing on the dashboard saying so.
    """
    ds = item_for(order(accession="B" * 300))
    pn = [g for g in illegal(ds) if "Patient's Name" in g]
    check(pn == [],
          "the stand-in name fits PN's per-component cap: " + (", ".join(pn) or "none"))
    check(empty_required(ds) == [],
          "…without leaving anything zero-length: " + (", ".join(empty_required(ds)) or "none"))
    check(illegal(ds) == [],
          "…and nothing else in the item overflows its VR: " + (", ".join(illegal(ds)) or "none"))


def test_a_targeted_order_is_shown_only_where_it_was_aimed():
    """Filling ScheduledStationAETitle in as a fallback must not make every
    order look targeted: the operator aiming one at a room is a real filter, and
    the worklist probe's for_nobody count (caught.py, server._probe_verdict) is
    the diagnosis that depends on the two being distinguishable."""
    o = order(patient="DOE^JANE", modality="CT", station_aet="CT_ER_01")
    check(order_matches_query(o, query(station="CT_ER_01")), "its own room sees it")
    check(not order_matches_query(o, query(station="MR_1")),
          "the room it was not aimed at does not")
    check(not order_matches_query(o, query(modality="MR")),
          "and neither does a modality of the wrong type")


def test_an_order_with_no_exam_name_still_says_what_the_step_is():
    """The description is 1C against a code sequence this module never emits, so
    it is required on every item — and it is the field the intake form is least
    likely to have filled. #ordDesc carries no `required` attribute and
    server.add_order demands only one of accession / patient / patient ID, so
    "no exam name" is not a hostile shape: it is what a receptionist types when
    the patient arrives ahead of the paperwork.

    Three ways the description arrives as nothing, and all three have to produce
    the same honest stand-in rather than a present-and-zero-length attribute —
    which is the shape UNSTATED_MODALITY and the station AET fallback exist to
    avoid for their own attributes, and it is worse than an absent one because
    the row IS offered to the scanner and the tech reads a blank.
    """
    shapes = {
        "an order with no description at all": order(patient="DOE^JANE"),
        "a description typed as spaces": order(patient="ROE^JOHN", study_desc="   "),
        "a description made only of characters LO forbids":
            order(patient="POE^SAM", study_desc="\\"),
    }
    for label, o in shapes.items():
        ds = item_for(o)
        step = ds.ScheduledProcedureStepSequence[0]
        gaps = empty_required(ds)
        check(gaps == [], f"{label} leaves no required attribute empty; empty: "
                          + (", ".join(gaps) or "none"))
        check(str(ds.RequestedProcedureDescription) == UNSTATED_PROCEDURE,
              f"{label}: (0032,1060) says why there is no exam name instead of saying nothing")
        check(str(step.ScheduledProcedureStepDescription) == UNSTATED_PROCEDURE,
              f"{label}: …and so does (0040,0007), which is the column the tech reads")
        check(illegal(ds) == [], f"{label}: the stand-in is itself a legal LO: "
                                 + (", ".join(illegal(ds)) or "none"))
        # The stand-in is only defensible while the alternative really is
        # absent. If a code sequence is ever added, this assertion is the line
        # that says the pair has to be reconsidered together.
        check(not hasattr(ds, "RequestedProcedureCodeSequence")
              and not hasattr(step, "ScheduledProtocolCodeSequence"),
              f"{label}: neither code-sequence alternative is emitted, which is what "
              "makes the description required rather than optional")

    # The other edge, for the reason the verbatim test above exists: a fallback
    # that also fires when the order HAS a description would put "UNSPECIFIED"
    # on the scanner in place of the exam the receptionist actually typed.
    typed = item_for(order(patient="VOE^KIM", study_desc="CT HEAD"))
    check(str(typed.RequestedProcedureDescription) == "CT HEAD",
          "an exam name that WAS typed is returned verbatim and not overwritten")
    check(str(typed.ScheduledProcedureStepSequence[0].ScheduledProcedureStepDescription)
          == "CT HEAD",
          "…in the step as well as in the requested procedure")


# A UID is digits and dots, and the two ways of breaking PS3.5 9.1 are both
# spelled entirely in digits and dots: an EMPTY component ("1.", "1..2") and a
# component with a LEADING ZERO ("1.02", which would otherwise be a second
# spelling of "1.2" — DICOM compares UIDs as strings, not as numbers). A
# character-class check passes both, and pydicom refuses both, so an order
# carrying one puts an unusable value in a Type 1 the modality burns into the
# exam it produces.
#
# The door is narrower than the form: #ordUid does not exist, but ORDER_FIELDS
# keeps study_uid and POST /api/ris/orders hands the JSON body to
# server.add_order, a route the Reception preset holds orders.write for. It is
# also the exact caller _derived_study_uid's own comment names, which is what
# makes an unchecked value here a fitting that does not do its job.
ILLEGAL_STORED_UIDS = (
    ("1.02.3", "a component with a leading zero, which is a second spelling of 1.2.3"),
    ("1.", "a trailing dot, which names a component that is not a number"),
    ("1..2", "an empty component in the middle"),
    ("01.2", "a leading zero in the first component"),
    (".", "a UID that is punctuation alone"),
)


def test_a_stored_study_uid_that_is_not_a_uid_falls_back_to_a_derived_one():
    """Not "it is rejected" — rejected leaves a Type 1 empty, which is the
    failure this whole section is about. The bar is that the attribute comes
    back FILLED with something a modality will accept, which is what
    _derived_study_uid was fitted for.
    """
    for value, label in ILLEGAL_STORED_UIDS:
        o = order(patient="DOE^JANE", study_uid=value)
        # The store keeps what it was handed: the repair belongs at the wire,
        # not in the store, and asserting this here is what stops the test from
        # passing because the input never arrived.
        check(o.get("study_uid") == value,
              f"{label}: the store really does keep the value the API sent")
        ds = item_for(o)
        check(str(ds.StudyInstanceUID) != value,
              f"{label}: it is not echoed into (0020,000D) verbatim")
        check(empty_required(ds) == [],
              f"{label}: …and the Type 1 is filled rather than emptied; empty: "
              + (", ".join(empty_required(ds)) or "none"))
        check(illegal(ds) == [],
              f"{label}: what replaces it is a UID pydicom accepts: "
              + (", ".join(illegal(ds)) or "none"))
        # Determinism matters here more than anywhere else in the item: this is
        # the key the exam reconciles on, so two C-FINDs must not hand the
        # scanner two different studies for one order.
        check(str(item_for(o).StudyInstanceUID) == str(ds.StudyInstanceUID),
              f"{label}: two C-FINDs derive the same UID")

    # And the other edge again: a stored UID that IS legal is the order's own
    # identity and must survive untouched.
    good = order(patient="ROE^JOHN", study_uid="1.2.826.0.1.3680043.10.99999.9.1")
    check(str(item_for(good).StudyInstanceUID) == "1.2.826.0.1.3680043.10.99999.9.1",
          "a legal stored UID is returned verbatim, not replaced by a derived one")


# ---- the orders typed during the outage keep their way out -----------------
# Resume normal is pressed when the PRIMARY is back, which is not the same
# moment the work is done. An order hand-keyed during the outage exists in
# exactly one place — this appliance's store — because it was typed precisely
# BECAUSE the RIS could not be reached, so the returning RIS will never put it
# on a worklist. Stop the emergency worklist while that order is still open and
# the patient is still waiting, and nothing anywhere can tell a modality about
# them; the order sits on the dashboard's Open tab looking handled.
def test_resume_keeps_the_worklist_while_an_order_typed_in_the_outage_is_open():
    ctl = controller(wanted=False, scp=None)
    ctl.activate()
    check(ctl.server.started == 1, "the emergency brought the worklist up")
    ctl.server.orders.add({"accession": "ER-1", "patient": "DOE^JANE"},
                          source="manual", origin=ORIGIN_MANUAL)
    ctl.resume()
    check(ctl.server.stopped == 0,
          "Resume normal did NOT stop the worklist the open order needs")
    check(ctl.server.mwl_scp is not None and ctl.server.mwl_scp.running,
          "…so the modality that has not scanned that patient yet can still pull it")


def test_resume_says_out_loud_that_it_left_the_worklist_up_and_why():
    """A worklist still bound after the emergency is over is a surprise to the
    next person who looks at the services, and 'why is the MWL running?' has to
    be answerable from the log rather than from reading this module."""
    ctl = controller(wanted=False, scp=None)
    ctl.activate()
    ctl.server.orders.add({"accession": "ER-1", "patient": "DOE^JANE"},
                          source="manual", origin=ORIGIN_MANUAL)
    ctl.resume()
    lines = [it["message"].lower() for it in ctl.log.since(0)]
    # Deliberately loose about the wording and strict about the substance: one
    # line has to tie the worklist to the orders, because that pairing is the
    # whole answer to the question the next person asks ("the emergency is over,
    # why is the MWL still bound?"). The activation line names the worklist
    # without naming an order, so it cannot satisfy this by accident.
    check(any("worklist" in m and "order" in m for m in lines),
          "the log ties the still-running worklist to the orders that need it")


def test_resume_stops_the_worklist_once_those_orders_are_closed():
    """The other half, or the guard above is just a leak: an emergency worklist
    that outlives every order it was serving is a bound port and an unattended
    service, and nothing else will ever take it down."""
    ctl = controller(wanted=False, scp=None)
    ctl.activate()
    o = ctl.server.orders.add({"accession": "ER-1", "patient": "DOE^JANE"},
                              source="manual", origin=ORIGIN_MANUAL)
    ctl.server.orders.close(o["id"], reason="matched", matched_study="1.2.3")
    ctl.resume()
    check(ctl.server.stopped == 1,
          "the study landed, nothing is waiting, and the worklist comes down with the emergency")


def test_an_open_ris_order_does_not_hold_the_emergency_worklist_open():
    """Provenance is the whole argument, so it has to be the actual predicate.
    An order the RIS sent is one the RIS still knows about: the primary is back,
    that is why Resume was pressed, and the normal worklist arrangement serves
    it again. Only the orders that exist NOWHERE ELSE — the ones typed here
    while the RIS was unreachable — can strand a patient."""
    ctl = controller(wanted=False, scp=None)
    ctl.activate()
    ctl.server.orders.add({"accession": "ACC-1", "patient": "DOE^JANE"},
                          source="HL7 10.0.0.5", origin=ORIGIN_RIS)
    ctl.resume()
    check(ctl.server.stopped == 1,
          "an order the RIS owns does not keep the emergency's worklist alive")


def test_a_configuration_save_during_an_outage_neither_cancels_it_nor_stops_the_worklist():
    """apply_config() bounces the health monitor, and the setup chooser then
    syncs the services to the enrolled set. Both ran straight through an ACTIVE
    emergency: the bounce cancelled it (stop() sets OFF, and the mid-outage
    worklist watchdog is only asked while ACTIVE), and the sync then read
    "worklist not wanted, worklist running" and stopped it. Nothing restarted
    it, the banner was gone, and an administrator saving an unrelated setting
    had silently ended the failover.

    Against the real PacsServer, because the defect is entirely in how these
    three real methods compose — but with the worklist lifecycle faked, since a
    genuine bind would make this a test of whether port 11114 is free."""
    import copy as _copy

    from pacs.server import PacsServer

    d = tempfile.mkdtemp(prefix="carino-emg-mwl-cfg-")
    cfg = Config(os.path.join(d, "config.json")).load()
    with cfg.mutate():
        cfg.emergency["armed"] = True
    cfg.save()
    srv = PacsServer(cfg)
    srv.start_mwl = lambda: setattr(srv, "mwl_scp", FakeScp(True))
    srv.stop_mwl = lambda: setattr(srv, "mwl_scp", None)
    try:
        srv.emergency.state = TRIGGERED
        srv.emergency.trigger_dest = "Primary PACS"
        srv.emergency.activate()
        check(srv.emergency.state == ACTIVE, "the emergency is running")
        check(srv.mwl_scp is not None and srv.mwl_scp.running, "…and the worklist with it")
        srv.orders.add({"accession": "ER-1", "patient": "DOE^JANE"},
                       source="manual", origin=ORIGIN_MANUAL)

        srv.apply_config(_copy.deepcopy(cfg.data))
        check(srv.emergency.state == ACTIVE,
              "a plain Save during the outage does not cancel the emergency")
        check(srv.mwl_scp is not None and srv.mwl_scp.running,
              "…and does not take the worklist away from the modalities")

        rows = srv.sync_services()
        check(srv.mwl_scp is not None and srv.mwl_scp.running,
              "the enforcing sync leaves the worklist the emergency is holding up")
        check(not any(r.get("service") == "mwl" and r.get("action") == "stop" for r in rows),
              "…and does not even report having stopped it")
        check(srv.emergency.state == ACTIVE, "the emergency survives the chooser too")
    finally:
        srv.shutdown()


# ---- what reception is told when they press Queue --------------------------
def test_queuing_an_order_says_whether_a_worklist_is_actually_serving_it():
    """"Order queued" answered the wrong question: reception does not care that
    the order reached a file on this box."""
    from pacs.server import PacsServer

    d = tempfile.mkdtemp(prefix="carino-emg-mwl-srv-")
    cfg = Config(os.path.join(d, "config.json")).load()
    cfg.save()
    srv = PacsServer(cfg)
    try:
        r = srv.add_order({"accession": "H-1", "patient": "Typed"})
        check(r["ok"] is True, "the order is still queued — nothing is refused")
        check("Modality Worklist" in r["message"],
              "…and the confirmation names the worklist rather than stopping at 'queued'")
        check("not reach" in r["message"] or "NOT running" in r["message"],
              "with nothing serving, it does not claim the order propagated")
        srv.mwl_scp = FakeScp(True)
        r = srv.add_order({"accession": "H-2", "patient": "Typed Two"})
        check("serving it" in r["message"], "with a worklist up, it says so")
    finally:
        srv.shutdown()


def test_every_confirmation_reaches_reception_in_a_language_they_read():
    """The confirmation is the only place anybody is told the order is going
    nowhere — no banner, no badge and no LED carries that — so in a fleet that
    ships es / pt-BR / ja / ru it cannot be engine English.

    The engine therefore sends a machine-readable ``code`` and the dashboard
    says the sentence. That is a handoff across three files, and the half that
    silently rots is the far end: rename a code in server.py, or add a fifth
    outcome, and add_order still answers, the dashboard still renders *something* (its
    default falls back to the engine's English), i18n-parity still passes
    because the literal it checks is still in the dashboard, and nobody finds out
    until a Japanese front desk reads an English safety warning. Nothing else
    in the repository looks at all three files at once, so this does.
    """
    import re

    from pacs.server import PacsServer

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    from dashboard_js import read_dashboard_js
    app = read_dashboard_js()
    i18n = open(os.path.join(here, "pacs/web/i18n.js"), encoding="utf-8").read()
    msgs = PacsServer.ORDER_QUEUED_MESSAGES

    # Derived rather than a literal count: the number of outcomes is allowed to
    # change (it went from three to four when the failed start was separated
    # out), and a magic number here fails the next honest addition while
    # catching nothing the pairing check does not. What may NOT change is that
    # every outcome is said for a real order and for a test one.
    reals = {c for c in msgs if not c.startswith("test_")}
    check(len(msgs) == 2 * len(reals),
          f"every outcome is said for a real order and a test one: {len(msgs)} "
          f"confirmation(s) for {len(reals)} outcome(s)")
    for code, english in msgs.items():
        check(f'case "{code}":' in app,
              f"the dashboard knows the code {code}")
        check(f'T("{english}")' in app,
              f"…and says it through T(), not as engine text [{code}]")
        # Four locale blocks, so four occurrences of the key. Counting is
        # enough here because i18n-parity.mjs already proves each block is a
        # distinct language and that no key is reachable in one and missing in
        # another; what it cannot know is that these eight in particular are
        # required rather than optional, which is the claim being made here.
        found = i18n.count("'" + english + "'")
        check(found == 4,
              f"…and it is translated in all four locales, not {found} [{code}]")

    # The other direction: a case in the dashboard for a code the engine can no longer
    # emit is dead text that a translator will keep maintaining for ever.
    for code in re.findall(r'case "((?:test_)?order_queued_\w+)":', app):
        check(code in msgs, f"the dashboard case {code} is still a code the engine sends")


def test_a_worklist_that_failed_to_start_is_named_as_the_cause():
    """The wrong half of the old sentence was the remedy. An emergency brings
    its own worklist up whether or not ``mwl.enabled`` is set, so when that
    start lost a race for the port, the strictly-configured predicate was False
    and reception was told "no Modality Worklist is enabled … Enable MWL" —
    a cause that was not the cause, and an instruction that binds the very port
    somebody else is holding. The appliance knew better the whole time; the
    reason was sitting on ``emergency.mwl_error``."""
    from pacs.server import PacsServer

    d = tempfile.mkdtemp(prefix="carino-emg-mwl-cause-")
    cfg = Config(os.path.join(d, "config.json")).load()
    cfg.save()
    srv = PacsServer(cfg)
    try:
        srv.emergency.state = ACTIVE
        srv.emergency.mwl_error = "the worklist SCP failed to start"
        r = srv.add_order({"accession": "F-1", "patient": "Squatted^Port"})
        check(r["code"] == "order_queued_mwl_failed",
              f"the failed start is the cause reception is given, not {r['code']}")
        check("Enable MWL" not in r["message"],
              "…and it does not offer a remedy that would bind the held port")

        # mwl_error is cleared by resume() and set only by activate(), so the
        # window it speaks for is ACTIVE/RECOVERING. Outside it the same string
        # is a souvenir of a previous outage and must not explain this order.
        srv.emergency.state = "off"
        r = srv.add_order({"accession": "F-2", "patient": "Later^Quiet"})
        check(r["code"] == "order_queued_no_mwl",
              f"a stale reason does not speak for a later order: {r['code']}")
    finally:
        srv.shutdown()

    # The ordering inside _worklist_outcome() is the repair, not an accident of
    # how the branches were typed, so it is asserted where the two candidate
    # answers differ: MWL enabled in the configuration AND the emergency's
    # start refused. "It is enabled — start it" is true and useless, because
    # starting it is exactly what just failed on a port somebody else holds;
    # the specific answer has to win over the merely-configured one.
    d = tempfile.mkdtemp(prefix="carino-emg-mwl-cause2-")
    cfg = Config(os.path.join(d, "config.json")).load()
    with cfg.mutate():
        cfg.mwl["enabled"] = True
    cfg.save()
    srv = PacsServer(cfg)
    try:
        srv.mwl_scp = None
        srv.emergency.state = ACTIVE
        srv.emergency.mwl_error = "address already in use"
        r = srv.add_order({"accession": "F-3", "patient": "Enabled^ButHeld"})
        check(r["code"] == "order_queued_mwl_failed",
              f"the failed start outranks 'it is enabled', got {r['code']}")
    finally:
        srv.shutdown()


def test_the_worklist_left_up_for_stranded_orders_comes_down_when_they_close():
    """resume() leaves the worklist serving while an order typed during the
    outage is still open, and the log tells the operator to scan those patients
    and it comes down. It did not come down: sync_worklist() only ever starts,
    and it runs on launch and on a config save rather than on a timer, so the
    port stayed bound for the life of the process while the appliance claimed
    otherwise in the one place an operator is told what to do.

    The real start_mwl()/stop_mwl() run here — only the socket is faked —
    because the flag that decides whether a worklist is reclaimable is set
    inside start_mwl(), and a test that faked the start would be asserting
    against its own bookkeeping rather than the appliance's."""
    import pacs.server as server_mod
    from pacs.server import PacsServer

    class SocketlessScp:
        """Everything start_mwl() touches, minus the bind."""

        def __init__(self, **kw):
            self.running = False

        def start(self):
            self.running = True

        def stop(self):
            self.running = False

    d = tempfile.mkdtemp(prefix="carino-emg-mwl-release-")
    cfg = Config(os.path.join(d, "config.json")).load()
    with cfg.mutate():
        cfg.emergency["armed"] = True
    cfg.save()
    real_scp = server_mod.MwlSCP
    server_mod.MwlSCP = SocketlessScp
    srv = PacsServer(cfg)
    try:
        srv.emergency.state = TRIGGERED
        srv.emergency.trigger_dest = "Primary PACS"
        srv.emergency.activate()
        check(srv.mwl_scp is not None and srv.mwl_scp.running,
              "the outage brings a worklist up")
        check(srv.mwl_for_orders is True,
              "…and it is marked as one the appliance may reclaim")

        o = srv.orders.add({"accession": "ER-9", "patient": "DOE^JANE"},
                           source="manual", origin=ORIGIN_MANUAL)
        srv.emergency.resume()
        check(srv.mwl_scp is not None and srv.mwl_scp.running,
              "resume leaves it serving while the hand-keyed order is open")

        srv.close_order(o["id"])
        check(not (srv.mwl_scp and srv.mwl_scp.running),
              "closing the last stranded order finally brings it down")
        check(srv.mwl_for_orders is False,
              "…and the appliance stops claiming that worklist")
    finally:
        srv.shutdown()
        server_mod.MwlSCP = real_scp


def test_releasing_the_worklist_never_reclaims_one_somebody_else_wants():
    """The danger in the repair above is the mirror image of the defect: a
    worklist stopped because an order closed, when that worklist was never the
    emergency's. Two owners have to survive it — the hospital, which enabled
    MWL in the configuration, and an operator who pressed Start on the services
    panel and is entitled to have it stay up until they press Stop."""
    import pacs.server as server_mod
    from pacs.server import PacsServer

    class SocketlessScp:
        def __init__(self, **kw):
            self.running = False

        def start(self):
            self.running = True

        def stop(self):
            self.running = False

    real_scp = server_mod.MwlSCP
    server_mod.MwlSCP = SocketlessScp

    # The operator's own worklist: nothing configured it, so start_mwl() marks
    # it reclaimable and the one caller carrying human intent clears the flag —
    # exactly as the services endpoint in web.py does.
    d = tempfile.mkdtemp(prefix="carino-emg-mwl-keep1-")
    cfg = Config(os.path.join(d, "config.json")).load()
    cfg.save()
    srv = PacsServer(cfg)
    try:
        srv.start_mwl()
        srv.mwl_for_orders = False
        o = srv.orders.add({"accession": "OP-1", "patient": "Someone"},
                           source="manual", origin=ORIGIN_MANUAL)
        srv.close_order(o["id"])
        check(srv.mwl_scp is not None and srv.mwl_scp.running,
              "an operator's Start outlives the order that happened to close")
    finally:
        srv.shutdown()

    # The hospital's worklist: worklist_wanted() is True, so worklist_in_use()
    # is True for ever and release_worklist() has nothing to reclaim.
    d = tempfile.mkdtemp(prefix="carino-emg-mwl-keep2-")
    cfg = Config(os.path.join(d, "config.json")).load()
    with cfg.mutate():
        cfg.mwl["enabled"] = True
    cfg.save()
    srv = PacsServer(cfg)
    try:
        srv.start_mwl()
        o = srv.orders.add({"accession": "CFG-1", "patient": "Someone Else"},
                           source="manual", origin=ORIGIN_MANUAL)
        srv.close_order(o["id"])
        check(srv.mwl_scp is not None and srv.mwl_scp.running,
              "a configured worklist is never taken away by an order closing")
    finally:
        srv.shutdown()
        server_mod.MwlSCP = real_scp


# ---- the run-once override is a human decision, not a reclaimable one ------
def run_once_override_block() -> str:
    """The run-once `--receive/--ris/--mwl/--qr` override section of
    ``cmd_serve``, cut out of pacs/__main__.py and returned as source.

    Extracted rather than paraphrased, and that is the entire point of the test
    below. The flag deciding whether a worklist may be reclaimed is set INSIDE
    start_mwl() and has to be cleared BY THE CALLER, so a test that calls
    start_mwl() itself and then clears the flag — which is what the sibling test
    of the operator's Start button does, quite correctly, because there the
    caller is a web endpoint — is asserting against its own bookkeeping. The one
    shape that broke was a caller that did not remember, and the only way to see
    it is to run the caller's own source.

    It is cut by anchor, and a missing anchor FAILS loudly rather than quietly
    testing nothing: if either marker stops matching exactly once the section
    has been reshaped, and this test needs re-anchoring rather than deleting.
    """
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    lines = open(os.path.join(here, "pacs/__main__.py"), encoding="utf-8").read().splitlines()
    opens = [i for i, ln in enumerate(lines)
             if ln.strip().startswith("for flag, start, label, kind in (")]
    closes = [i for i, ln in enumerate(lines) if "Emergency failover monitor" in ln]
    check(len(opens) == 1,
          f"the override loop is where this test cuts it ({len(opens)} match(es) "
          "for its opening anchor — anything but one means the section moved and "
          "this test needs re-anchoring, not deleting)")
    check(len(closes) == 1,
          f"…and so is the line that ends the section ({len(closes)} match(es))")
    check(bool(closes and opens and closes[0] > opens[0]),
          "…and the end comes after the beginning")
    import textwrap
    return textwrap.dedent("\n".join(lines[opens[0]:closes[0]]))


def test_a_run_once_mwl_override_is_not_reclaimed_while_orders_are_open():
    """``serve --mwl`` is an operator saying "run the worklist this time" — its
    own help text is *"start the Modality Worklist SCP for this run even if
    config has it off"* — and nothing in the configuration wants one. That was
    once the exact shape start_mwl() marked reclaimable, on the reasoning that a
    worklist nothing configured must be the emergency's.

    release_worklist() then took it away, and release_worklist() is reached from
    five closing paths that need no emergency, no hand-keyed order and no
    operator action at all: a reconciled C-STORE, a cancel, a delete, a capture,
    and a purge that purges nothing. The appliance logged *"the last order typed
    during the outage is closed"* about a run in which no outage happened and no
    order was typed — while orders that arrived over HL7 were still open, and
    the CT that had pulled them a second earlier was REFUSED on its next query
    for the rest of the process, because sync_worklist() only ever starts, on
    launch and on a config save.

    The ownership is claimed rather than inferred now: start_mwl() leaves the
    worklist the caller's, and the two starts that ARE reclaimable say so right
    after calling it. This test does not assert that arrangement from the
    inside — it runs the CALLER's own source, because a test that called
    start_mwl() itself and then set the flag would be agreeing with its own
    bookkeeping, which is exactly how the launch flag went uncovered while the
    two callers that remembered were both gated.
    """
    import pacs.server as server_mod
    from pacs.server import PacsServer

    class SocketlessScp:
        def __init__(self, **kw):
            self.running = False

        def start(self):
            self.running = True

        def stop(self):
            self.running = False

    block = compile(run_once_override_block(), "<pacs/__main__.py cmd_serve>", "exec")

    d = tempfile.mkdtemp(prefix="carino-emg-mwl-runonce-")
    cfg = Config(os.path.join(d, "config.json")).load()
    cfg.save()                                   # mwl.enabled stays False
    real_scp = server_mod.MwlSCP
    server_mod.MwlSCP = SocketlessScp
    srv = PacsServer(cfg)
    try:
        # Exactly the argv the documentation describes: `serve --mwl`, nothing
        # else overridden. Only `sys` and `print` come from here; `args` and
        # `server` are what cmd_serve holds at that point.
        args = type("Args", (), {"receive": False, "watch": False, "print": False,
                                 "ris": False, "mwl": True, "qr": False})()
        exec(block, {"args": args, "server": srv, "sys": sys,
                     "print": lambda *a, **k: None})
        check(srv.mwl_scp is not None and srv.mwl_scp.running,
              "--mwl brought the worklist up for this run")
        check(srv.mwl_for_orders is False,
              "…and it is NOT marked as one an order closing may reclaim: the "
              "operator asked for it, the same as the services panel's Start")

        # The mixed pair is the sharp case. Reception typed one during the
        # outage; the RIS sent the other. Closing the typed one is the moment
        # release_worklist() asks its question, and the HL7 order — which the
        # same worklist is the only thing serving on this run — is still open.
        typed = srv.orders.add({"accession": "ER-1", "patient": "DOE^JANE"},
                               source="manual", origin=ORIGIN_MANUAL)
        srv.orders.add({"accession": "ACC-2", "patient": "ROE^JOHN"},
                       source="HL7 10.0.0.5", origin=ORIGIN_RIS)
        srv.close_order(typed["id"])
        check(srv.mwl_scp is not None and srv.mwl_scp.running,
              "an order closing does not take the run-once worklist away while "
              "another order is still open")
        check(len(srv.orders.list("open")) == 1,
              "…and that open order is still there to be served")

        # A purge removes only orders that are already closed, so it can free
        # nothing — it is the operator tidying the list — and it asks anyway.
        # On a --mwl run it used to answer by stopping the SCP.
        srv.purge_closed_orders()
        check(srv.mwl_scp is not None and srv.mwl_scp.running,
              "a purge that purges nothing does not stop it either")

        # And the last order closing does not end it: an override is for the
        # RUN. Nothing brings a worklist back inside one — sync_worklist() is
        # called on launch and on a config save — so anything that stops it here
        # stops it until the operator notices and restarts the process.
        for o in list(srv.orders.list("open")):
            srv.delete_order(o["id"])
        check(srv.mwl_scp is not None and srv.mwl_scp.running,
              "the run-once worklist outlives the last order, the way the "
              "operator's Start button does")
    finally:
        srv.shutdown()
        server_mod.MwlSCP = real_scp


# ---- the station field aims the order, so a miss may not read as a hit -----
def test_a_station_that_matches_no_configured_console_is_not_confirmed_as_serving():
    """``ScheduledStationAETitle`` is matched the same way Modality is — exact,
    and lenient on BLANK rather than on WRONG — so the three outcomes for the
    field labelled "Target modality" are: left empty, and every console sees the
    order; an AE title a console really answers to, and that console sees it;
    anything else, and NO station-filtered console sees it at all, while
    reception is told the Modality Worklist is serving it.

    The panel is a picker now, fed by station_list() under `orders.read` rather
    than out of a configuration Reception cannot read — and that closes the
    typing, not the claim. Three things still put an unknown AE title on an
    order: `POST /api/ris/orders`, which is a documented interface and takes the
    field it is given; an appliance whose registry is empty, where the panel
    still offers a text box because an order that cannot be aimed at all is
    worse than one aimed at a typo; and a room deleted or renamed after the
    order was filed. So the judgement belongs in the ENGINE, where every client
    gets the same answer — `message` is what curl and any browser too old to
    know the code keep, and it may not be true on screen and false on the wire.

    What may NOT happen is a refusal: an outage is not the moment to reject a
    patient over an AE title, and the registry is evidence of what somebody
    wrote down rather than of what exists. The order is queued, it goes on the
    worklist, and every console that sends no station key still sees it. What
    changes is the sentence — which is the only surface reception has, so it
    may not be the strongest one the appliance owns.
    """
    from pacs.server import PacsServer

    def server_with(*modalities):
        d = tempfile.mkdtemp(prefix="carino-emg-mwl-station-")
        cfg = Config(os.path.join(d, "config.json")).load()
        if modalities:
            with cfg.mutate():
                cfg.modalities.extend(modalities)
        cfg.save()
        srv = PacsServer(cfg)
        srv.mwl_scp = FakeScp(True)          # serving, so "serving" is the
        return srv                           # answer everything else has to beat

    msgs = PacsServer.ORDER_QUEUED_MESSAGES
    ct = {"name": "ER CT", "aet": "CT_ER_01", "modality": "CT", "enabled": True}
    old = {"name": "Spare room", "aet": "XR_OLD", "modality": "DX", "enabled": False}

    srv = server_with(ct, old)
    try:
        r = srv.add_order({"accession": "S-1", "patient": "GOMEZ^ANA",
                           "station_aet": "SALA CT"})
        check(r["ok"] is True,
              "the order is queued — an outage is not the moment to refuse one")
        check(r["order"]["id"] in [o["id"] for o in srv.orders.list("open")],
              "…and it is on the worklist, where a console that sends no station "
              "key still sees it: hiding it would be the worse failure")
        check(r.get("code") != "order_queued_serving",
              "…but it is NOT confirmed as served by a worklist no console will "
              f"ask for it on, got {r.get('code')!r}")
        check("serving it" not in r["message"],
              "…and the sentence does not say so either: " + r["message"])
        # Whatever code this is, it goes through the same handoff as the other
        # four — a code the dashboard has never heard of is engine English on a
        # Japanese front desk, which is the thing that contract exists to stop.
        check(r.get("code") in msgs,
              f"the outcome travels as a known code, not as prose: {r.get('code')!r}")
        check(r["message"] == msgs[r["code"]],
              "…and message is that code's sentence, for every client that is "
              "not the dashboard")

        # A test order is still a test order: the twin carries the warning too,
        # or the rehearsal of this exact failure is the one that stays silent.
        t = srv.add_order({"accession": "S-2", "patient": "TEST^ONE",
                           "station_aet": "SALA CT", "test": True})
        check(t["code"].startswith("test_"),
              f"the test-order twin of the same warning, not {t['code']!r}")
        check(t["code"] != "test_order_queued_serving",
              "…and it warns rather than confirming")
    finally:
        srv.shutdown()

    # The other direction matters as much. This sentence is the only place the
    # front desk is told an order is going nowhere, so a warning it earns by
    # doing the right thing is how it stops being read at all.
    srv = server_with(ct, old)
    try:
        good = srv.add_order({"accession": "S-3", "patient": "AIMED^RIGHT",
                              "station_aet": "CT_ER_01"})
        check(good["code"] == "order_queued_serving",
              f"the console that is registered gets the good sentence, not {good['code']!r}")

        # AE titles are compared the way the worklist compares them and the way
        # config.py already refuses duplicates — upper-cased — so an order that
        # WILL reach its console must not be warned about on a difference the
        # matcher does not make.
        cased = srv.add_order({"accession": "S-4", "patient": "AIMED^LOWER",
                               "station_aet": "ct_er_01"})
        check(cased["code"] == "order_queued_serving",
              f"…in the case the matcher itself ignores, not {cased['code']!r}")

        # Blank is the lenient branch and the panel's default: every console
        # sees it, which is the right answer when reception does not know the
        # room. Warning about that would warn about most orders.
        blank = srv.add_order({"accession": "S-5", "patient": "NO^STATION"})
        check(blank["code"] == "order_queued_serving",
              f"no station named is not a miss, it is 'show everywhere': {blank['code']!r}")
    finally:
        srv.shutdown()

    # A room registered and switched off is still a room with that AE title:
    # `enabled` governs what this appliance SENDS to, not what pulls a worklist,
    # so an order aimed at one is not aimed at nothing. The picker deliberately
    # offers FEWER rooms than this check accepts — it will not offer equipment
    # out of service — and the asymmetry is the right way round, because the
    # picker is choosing for somebody and this sentence is judging a choice
    # already made, possibly by a different client on a different day.
    srv = server_with(ct, old)
    try:
        off = srv.add_order({"accession": "S-6", "patient": "AIMED^SPARE",
                             "station_aet": "XR_OLD"})
        check(off["code"] == "order_queued_serving",
              f"a registered-but-disabled console is a real AE title: {off['code']!r}")
        offered = {r["aet"].upper() for r in srv.station_list(usable_only=True)}
        check("XR_OLD" not in offered,
              "…and the picker still does not offer it: " + repr(sorted(offered)))
    finally:
        srv.shutdown()

    # And the appliance that has registered nothing. The registry is optional,
    # most installs start empty, and a check against an empty list would warn
    # about every station anybody ever types — the same warning fatigue, arrived
    # at from the opposite side.
    srv = server_with()
    try:
        r = srv.add_order({"accession": "S-7", "patient": "NO^REGISTRY",
                           "station_aet": "CT1"})
        check(r["code"] == "order_queued_serving",
              "with no modalities registered there is nothing to check against, "
              f"so nothing is claimed: {r['code']!r}")
    finally:
        srv.shutdown()


# ---- the outcome codes and the sentences stay one thing --------------------
def test_every_outcome_code_the_engine_can_return_is_one_the_dashboard_knows():
    """The test above walks the SENTENCES and proves each is translated. This
    one walks the other way — from what add_order can actually construct — and
    that is the direction a repair breaks it, because this handoff has broken
    once already.

    The code is built as a prefix plus a tail, and the tail comes from a
    different method. Rename a tail, or add a fifth outcome, and the pair stops
    being a key: add_order raises KeyError on the one call reception makes
    mid-outage, and the surface that says "this order is reaching no scanner"
    becomes a 500. Neither pytest on the engine nor i18n-parity.mjs on the web
    files can see it — both halves stay internally consistent, and the only
    thing wrong is between them.

    Mechanical, so it keeps working after the people who wrote it have gone:
    the tails are read out of the source rather than listed here, and a code
    spelled out whole where the enumeration cannot see it is itself a failure.
    """
    import inspect
    import re

    from pacs.server import PacsServer

    msgs = PacsServer.ORDER_QUEUED_MESSAGES
    outcome_src = inspect.getsource(PacsServer._worklist_outcome)
    add_src = inspect.getsource(PacsServer.add_order)

    tails = set(re.findall(r'return\s+"([a-z][a-z_]*)"', outcome_src))
    # A tail chosen in add_order itself (an outcome that is not about the state
    # of the worklist at all) counts too, and is recognised by the only thing
    # that makes it one: prefixing it produces a code with a sentence.
    tails |= {t for t in re.findall(r'"([a-z][a-z_]*)"', add_src)
              if "order_queued_" + t in msgs}
    check(len(tails) >= 4,
          f"the outcome tails are readable from the source: {sorted(tails)}")

    prefixes = set(re.findall(r'"((?:test_)?order_queued_)"', add_src))
    check(prefixes == {"order_queued_", "test_order_queued_"},
          f"add_order still builds the code from those two prefixes: {sorted(prefixes)}")
    whole = set(re.findall(r'"((?:test_)?order_queued_[a-z][a-z_]*)"', add_src))
    check(whole == set(),
          "…and from nothing else: a complete code written out in add_order is "
          "an outcome this enumeration cannot reach, so it would ship unchecked "
          "— " + (", ".join(sorted(whole)) or "none"))

    for prefix in sorted(prefixes):
        for tail in sorted(tails):
            check(prefix + tail in msgs,
                  f"the code {prefix + tail} the engine can return has a sentence")

    # Closed under the pairing, which is the half a hand-maintained table loses
    # first: a warning that exists for real orders and not for test ones means
    # the rehearsal of that exact situation is the run that says nothing.
    reals = sorted(c for c in msgs if not c.startswith("test_"))
    for code in reals:
        check("test_" + code in msgs, f"…and a test-order twin for {code}")
    check(len(msgs) == 2 * len(reals),
          f"every sentence is one of a pair: {len(msgs)} for {len(reals)} outcome(s)")

    from dashboard_js import read_dashboard_js
    app = read_dashboard_js()

    # The source-derived half proves the dict is complete. This half proves the
    # product agrees, by asking it: every state add_order can be called in, and
    # the code that really comes back out of it.
    d = tempfile.mkdtemp(prefix="carino-emg-mwl-codes-")
    cfg = Config(os.path.join(d, "config.json")).load()
    cfg.save()
    srv = PacsServer(cfg)
    try:
        seen = set()
        srv.mwl_scp = FakeScp(True)
        seen.add(srv.add_order({"accession": "C-1", "patient": "SERVED^ONE"})["code"])
        seen.add(srv.add_order({"accession": "C-2", "patient": "SERVED^TEST",
                                "test": True})["code"])
        srv.mwl_scp = None
        seen.add(srv.add_order({"accession": "C-3", "patient": "NO^WORKLIST"})["code"])
        with cfg.mutate():
            cfg.mwl["enabled"] = True
        seen.add(srv.add_order({"accession": "C-4", "patient": "ENABLED^DOWN"})["code"])
        srv.emergency.state = ACTIVE
        srv.emergency.mwl_error = "address already in use"
        seen.add(srv.add_order({"accession": "C-5", "patient": "PORT^HELD"})["code"])
        check(len(seen) >= 5,
              f"five distinct situations produced five distinct codes: {sorted(seen)}")
        for code in sorted(seen):
            check(code in msgs, f"{code} came back out of the product and has a sentence")
            check(f'case "{code}":' in app,
                  f"…and the dashboard has a case for it, so it is said in four languages")
    finally:
        srv.shutdown()


def test_the_station_list_reaches_the_profile_that_types_the_orders():
    """The station picker is only a picker if reception can be handed the rooms.

    This is a contract between three files and no one of them can keep it
    alone. ``PacsServer.station_list()`` builds the rooms; ``web.py`` publishes
    them under **orders.read** — on the status payload and on
    ``GET /api/ris/orders/stations`` — and the dashboard (``pacs/web/js/*.js``) reads
    ``status.modalities`` into ``statusModalities`` and builds
    ``#ordStationSel`` out of it. Break any one link and nothing raises:
    the panel quietly falls back to the free-text AE title it used to be, and
    reception goes back to typing "SALA CT" into a key the worklist matches by
    exact equality, while the confirmation says the Modality Worklist is serving
    the order. That was the finding this whole picker exists to close, and it
    would come back silently.

    The likeliest way to break it is a tidy-up: ``modalities`` looks like
    configuration, and moving that gate to ``config.read`` — where every other
    config-shaped block sits — is a one-word change that takes the list away
    from the only profile that needs it, because reception has orders.read and
    not config.read. So the gate is asserted from BOTH sides: reception is
    handed the rooms, and a profile with no orders.read is handed nothing, which
    is the other way this goes wrong (publishing the equipment to everybody).

    Against the real PacsServer, the real create_app() and the real preset
    profiles, because the composition being tested is the one the gate performs
    and a fake status() would only test the fixture.
    """
    from pacs import users as U
    from pacs.server import PacsServer
    from pacs.web import create_app

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    from dashboard_js import read_dashboard_js
    app_js = read_dashboard_js()
    html = open(os.path.join(here, "pacs/web/index.html"), encoding="utf-8").read()

    d = tempfile.mkdtemp(prefix="carino-emg-station-handoff-")
    cfg = Config(os.path.join(d, "config.json")).load()
    with cfg.mutate():
        cfg.modalities.extend([
            {"name": "ER CT", "aet": "CT_ER_01", "modality": "CT", "enabled": True},
            # Out of service, so the two publications can be told apart: the
            # picker must not offer a room an order cannot usefully be aimed at.
            {"name": "Spare X-ray", "aet": "XR_OLD", "modality": "DX", "enabled": False},
        ])
        cfg.users["profiles"] = U.preset_profiles()
    cfg.save()
    srv = PacsServer(cfg)
    try:
        web = create_app(srv)
        ids = {p["name"]: p["id"] for p in cfg.users["profiles"]}

        def signed_in(name):
            c = web.test_client()
            r = c.post("/api/login", json={"profile": ids[name]},
                       headers={"X-Carino": "1"})
            assert r.status_code == 200, r.get_data(as_text=True)
            return c

        front_desk = signed_in("Reception")
        check(front_desk.get("/api/config").status_code == 403,
              "reception still cannot read the configuration — which is why the "
              "list had to be published somewhere else, and is the premise of "
              "everything below")

        status = front_desk.get("/api/status").get_json()
        rooms = status.get("modalities")
        check(isinstance(rooms, list),
              f"…and the status payload carries the rooms anyway: {rooms!r}")
        check({r["aet"] for r in rooms} >= {"CT_ER_01"},
              f"…by AE title, which is the only thing a worklist query matches: {rooms!r}")
        check(all({"name", "aet", "modality"} <= set(r) for r in rooms),
              "…with the name the operator recognises and the code the room "
              f"answers to, or the option cannot be written: {rooms!r}")

        endpoint = front_desk.get("/api/ris/orders/stations")
        check(endpoint.status_code == 200,
              f"the same list stands on its own under orders.read, got {endpoint.status_code}")
        offered = {r["aet"] for r in endpoint.get_json()["stations"]}
        check(offered == {"CT_ER_01"},
              "…and it offers only the rooms an order can actually be aimed at, "
              f"not the one out of service: {sorted(offered)}")

        # The other direction. A profile with no orders.read may not see an
        # order, so it has no business enumerating the equipment either — and
        # "reachable by reception" must not have been bought by ungating it.
        it = signed_in("IT")
        check("modalities" not in it.get("/api/status").get_json(),
              "a profile without orders.read is not handed the equipment list")
        check(it.get("/api/ris/orders/stations").status_code == 403,
              "…and is refused the endpoint that serves it on its own")
    finally:
        srv.shutdown()

    # The browser half of the same contract, read out of the source. pytest
    # cannot run the dashboard and i18n-parity.mjs cannot see a server gate, so the
    # join between them is checked here or nowhere.
    check("s.modalities" in app_js,
          "the dashboard reads the rooms off the status payload — the copy reception "
          "is allowed to have — and not only out of /api/config")
    check("statusModalities" in app_js and "knownModalities" in app_js,
          "…through the one accessor both targeting fields ask, so the picker "
          "and the modality list can never disagree about what is registered")
    check('id="ordStationSel"' in html and "fillStationChoices" in app_js,
          "…and there is a <select> for it to fill, or the station field is "
          "still the free text this closed")


def main():
    for fn in sorted(
        (v for k, v in globals().items() if k.startswith("test_")),
        key=lambda f: f.__code__.co_firstlineno,
    ):
        print(fn.__name__)
        try:
            fn()
        except AssertionError:
            pass
    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
