"""Modality Worklist SCP — serve RIS orders to modalities (the "order OUT" half).

When the RIS is down (emergency failover) or simply to feed a worklist, a
modality needs to *pull* its schedule.  In DICOM you cannot push an order onto a
modality — it queries a **Modality Worklist** (C-FIND) and pulls matching items.
This module is that worklist provider: it answers
``ModalityWorklistInformationFind`` C-FIND queries out of the shared
:class:`~pacs.ris.OrderStore` — every **open** order is one worklist item.

Shape mirrors ``scp.py`` / ``print_scp.py``: a non-blocking ``pynetdicom`` server
with the same TLS / allowed-AET / counter / start-stop surface.  The DIMSE verb
is **C-FIND** against the worklist information model rather than C-STORE.

Matching (lenient by design — the goal is *keep imaging flowing*, so we would
rather over-show an order than hide one a tech needs):

  * The SCU sends a query identifier with some keys filled (match keys) and the
    rest empty (return keys).  We honour the common ones: PatientID, PatientName,
    AccessionNumber, StudyInstanceUID (top level) and Modality,
    ScheduledStationAETitle, ScheduledProcedureStepStartDate (inside the
    Scheduled Procedure Step Sequence).
  * An empty query key matches everything (universal matching).  Wildcards
    ``*``/``?`` are supported.  A MULTI-VALUED key (``CT\\MR`` from a shared
    CT/MR console) means "any of these" and is satisfied by any one of its
    values — a key read as one long string instead would match nothing and hide
    from that console exactly the orders whose modality the receptionist did
    type.
  * An order that leaves a field blank (e.g. no target modality on a hand-keyed
    emergency order) matches *any* value for that field — so an untargeted order
    appears on every modality's worklist.  Set ``station_aet`` on the order to
    target one modality.
  * Leniency has a price on the way back out, and one rule pays it: **a key we
    matched leniently is RETURNED as the value the query asked for**.  The
    attribute is Type 1 (it may not come back empty) and it is the key the SCU
    matched on (it may not come back contradicting the query), and the queried
    value is the only answer that satisfies both — it is also the true one, the
    item being offered to that scanner for that scanner to perform.  Where the
    query was universal, or asked with something that is not one legal value for
    the attribute's VR (a wildcard, a multi-valued ``CT\\MR`` from a shared
    console, an over-long or punctuated string — ``_echoable`` rejects each),
    the item carries a documented stand-in instead.
    ``build_worklist_item`` names the stand-in for each key and the single
    deliberate exception (``ScheduledStationAETitle``).

Keys we do NOT match on
----------------------
Every other key is treated as a return key even when the SCU filled it in —
RequestedProcedureID, ScheduledProcedureStepID, ScheduledProcedureStepStartTime,
ScheduledStationName, PatientBirthDate, ReferringPhysicianName — and only the
first item of the query's Scheduled Procedure Step Sequence is read at all.  An
unhonoured key can therefore only ever widen the answer: the modality is shown
items it did not ask for, never deprived of one it did.  That is the right way
round for an emergency worklist, but it is the first place to look when a
modality's list is too long, and the reason a "nothing on my worklist" call is
almost never one of these keys.

Text keys are compared whole and case-insensitively, so a PatientName query of
``SMITH`` does not match an order for ``SMITH^JOHN``; ``SMITH*`` does.  Case
insensitivity is also why the modality registry refuses two stations whose AE
titles differ only in case — to this module they are one station.

The response carries the order's pre-generated **Study Instance UID**, so the
exam the modality produces is stamped with the same UID and reconciles back to
the order exactly (see ``OrderStore.match`` / ``_reconcile_study``).
"""

from __future__ import annotations

import datetime
import fnmatch
import threading
from typing import Callable, Optional

from pynetdicom import AE, evt
from pynetdicom.sop_class import (
    ModalityWorklistInformationFind,
    Verification,
)

from .assocwords import caller_of, listener_refusal
from .logbuf import LogBuffer
from .netclaim import claim


def _peer_addr(event) -> str:
    try:
        addr = event.assoc.requestor.address
        return str(addr) if addr else "?"
    except Exception:
        return "?"


def _digits(value) -> str:
    """Just the digits of *value*.

    ``scheduled_dt`` reaches an order either as HL7 OBR-7 (``20260809143000``)
    or from the dashboard's ``datetime-local`` field (``2026-08-09T14:30``).
    Dropping every non-digit makes those one shape, which the DA and TM slices
    below can then cut by position without knowing which one they got.
    """
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def _order_date(order: dict) -> str:
    """The order's scheduled date as DICOM DA (YYYYMMDD), or '' if it has none.

    Eight digits in the right place is not the same thing as a date, and this
    value lands in a Type 1 DA (SPS Start Date). HL7 OBR-7 arrives from whatever
    sent it, so ``20260231`` reaches here as readily as a real day; the
    dashboard's ``datetime-local`` cannot produce one, but it is not the only
    door. A value that is not a day on the calendar is therefore treated as no
    date at all, which hands the attribute to _step_date's existing fallbacks
    (the queried date, else today) instead of putting a DA on the wire that the
    scanner cannot parse.
    """
    d = _digits(order.get("scheduled_dt"))[:8]
    return d if _is_da(d) else ""


def _order_time(order: dict) -> str:
    """The order's scheduled time as DICOM TM (HHMMSS), or '' if it has none.

    Validated for the same reason and in the same way as the date above: an
    HL7-sourced ``scheduled_dt`` can carry an hour no clock shows, and the
    caller's ``or "000000"`` is a fallback that only fires for a value this
    function rejects.
    """
    d = _digits(order.get("scheduled_dt"))
    t = d[8:14] if len(d) >= 10 else ""
    return t if _is_tm(t) else ""


def _today() -> str:
    return datetime.date.today().strftime("%Y%m%d")


# The Modality (0008,0060) an item carries when neither the order nor the query
# named one. "OT" is the standard's own defined term for Other (PS3.3
# C.7.3.1.1.1) — the coded way of saying "equipment class not stated", which is
# exactly what a hand-keyed order says. It is a legal CS value, where a
# zero-length one is not, and it invents no equipment that nobody chose.
UNSTATED_MODALITY = "OT"

# Prefix for the stand-in Patient ID below. Four characters so the whole
# identifier is "TMP-" + the order's twelve-hex id = 16 characters exactly: LO
# allows 64, but modality consoles that still show a sixteen-character patient
# field are common enough that an identifier which survives one intact is worth
# the arithmetic. It is also what makes the archive searchable afterwards — every
# exam produced from an unidentified emergency order is one `PatientID` prefix
# query away from the person who has to merge them.
TEMP_PATIENT_PREFIX = "TMP-"

# The ScheduledStationAETitle (0040,0001) an item carries when the order is
# addressed to no particular room. Type 1 forbids the empty string, and this is
# the one lenient key whose queried value must NOT be echoed back (see the note
# at the end of build_worklist_item), so it needs a word of its own. Ten
# characters, inside AE's sixteen, and shaped so it cannot collide with a real
# station: an AE title is configured per device, and no device is configured as
# the absence of itself. It says what is true — the step is scheduled, the room
# is not chosen — and it is the value the worklist probe reads back as
# "addressed to nobody" (server._probe_verdict).
UNASSIGNED_STATION_AET = "UNASSIGNED"

# The procedure description an item carries when the order named no exam. It
# fills both description attributes: Requested Procedure Description (0032,1060)
# and Scheduled Procedure Step Description (0040,0007). Both are type 1C, not
# type 3 — each is required unless its code-sequence alternative is present
# (0032,1064 and 0040,0008 respectively), and this module emits neither
# sequence, so on every item it builds the condition is met and the attribute is
# as required as a Type 1 is. A zero-length one therefore costs what a
# zero-length Type 1 costs, at the same strict SCUs, which is the whole failure
# build_worklist_item exists to prevent.
#
# It is not a rare shape either: the intake form does not require a description
# (#ordDesc carries no `required`, and add_order accepts an order with only an
# accession, a patient or a patient ID), and a description typed as nothing but
# whitespace or characters LO cannot carry reduces to the same empty string.
#
# Chosen as words rather than a code because there is no defined term to reach
# for the way UNSTATED_MODALITY reaches for "OT": no code means "exam not
# stated". And the words matter, because (0040,0007) is the column the tech
# reads to know what to perform. A blank there reads as a fault in the worklist
# and sends the call to IT; this says what is actually true — the order arrived
# without an exam named — and sends it to the person who typed it.
UNSTATED_PROCEDURE = "UNSPECIFIED - SEE ORDER"


# PS3.5 6.2: SH — Short String — is sixteen characters. Several attributes this
# module fills are SH, and all of them can be handed something longer than that
# by a source with no limit of its own (a barcode accession typed into the
# intake form, an HL7 placer order number from OBR-2).
SH_MAX = 16

# PS3.5 6.2: LO — Long String — is sixty-four characters. The two description
# attributes below are LO and are filled from an order's study_desc, which
# arrives either from an intake field with no length limit or from HL7 OBR-4;
# Patient ID is LO as well.
LO_MAX = 64

# PS3.5 6.2: CS and AE are sixteen characters, UI sixty-four.
CS_MAX = 16
AE_MAX = 16
UI_MAX = 64

# Characters legal in a CS value: uppercase letters, digits, space, underscore.
_CS_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _")
# An AE title is drawn from the default repertoire minus the backslash and the
# control characters; PS3.5 6.2 adds that it may not be all spaces.
_AE_CHARS = frozenset(chr(c) for c in range(0x20, 0x7F)) - {"\\"}
# A UID is digits and dots and nothing else (PS3.5 9.1). Which characters it may
# contain is only half of what that section says, though; how they may be
# ARRANGED is the other half, and _is_uid below is that half.
_UI_CHARS = frozenset("0123456789.")


def _is_uid(value: str) -> bool:
    """True when *value* is a UID by GRAMMAR as well as by character set.

    ``_UI_CHARS`` alone lets two illegal shapes through, because both are
    spelled entirely in digits and dots: a UID may not contain an EMPTY
    component (``1.`` and ``1..2`` each name a component that is not a number),
    and a component may not carry a LEADING ZERO (PS3.5 9.1) — otherwise
    ``1.02`` and ``1.2`` would be two spellings of one identifier, and DICOM
    compares UIDs as literal strings rather than as numbers.

    It matters here for the reason every other check in this file matters:
    pydicom refuses both (``Invalid value for VR UI``), and the Study Instance
    UID is a Type 1 attribute the modality burns into the exam it produces. A
    stored value that is not a UID reconciles to nothing anyway, so failing it
    here hands the attribute to ``_derived_study_uid`` — which is exactly what
    that stand-in was fitted for.
    """
    return all(p.isdigit() and (len(p) == 1 or p[0] != "0")
               for p in value.split("."))


def _repertoire_ok(ch: str) -> bool:
    """True when *ch* may appear in a single-valued text value (SH, LO, PN).

    Those VRs take the default repertoire — which, under the ``ISO_IR 192``
    character set this module declares, means any UTF-8 character — MINUS two
    kinds. The backslash is DICOM's value delimiter, so one character of typed
    text turns a VM-1 attribute into a VM-2 one. Control characters are excluded
    outright for SH and LO (only the long-text VRs admit CR/LF/FF/ESC), and this
    module writes no long-text VR.
    """
    code = ord(ch)
    return ch != "\\" and not (code < 0x20 or 0x7F <= code <= 0x9F)


# The length cap and character repertoire each VR this module writes into
# allows, keyed by VR (PS3.5 Table 6.2-1), as (max characters, the allowed set
# or None for "the default text repertoire" per _repertoire_ok, uppercase).
# Every VR this module puts a value into is listed, because every value it
# writes — one the receptionist typed, one the query asked for, one this file
# invents as a stand-in — has to be legal in the element it lands in, and there
# is one table saying what legal means rather than a rule per call site. Asking
# for a VR that is not here refuses the value rather than guessing a cap.
#
# Uppercasing is CS's alone. CS defines no lowercase letter, and _match_text
# compares case-insensitively, so a Modality of "ct" already matched *as* "CT"
# and returning it in the case CS defines returns the value that was matched.
# SH, LO, PN and AE all carry case meaningfully, and an AE title in particular
# is configured on the device exactly as it is spelled.
#
# The two date/time VRs are absent on purpose: they are validated by _is_da and
# _is_tm, which are calendar and clock checks, not charset ones — and a date
# RANGE ("a-b") is a legal thing to find in a query but not a legal DA value, so
# the range has to be split before either half can be checked.
_VR_SINGLE_VALUE_RULES = {
    "AE": (AE_MAX, _AE_CHARS, False),
    "CS": (CS_MAX, _CS_CHARS, True),
    "LO": (LO_MAX, None, False),
    "SH": (SH_MAX, None, False),
    "UI": (UI_MAX, _UI_CHARS, False),
}


def _vr_value(value, vr: str) -> str:
    """*value* when it is one legal single value of *vr*, else ''.

    The module's one rule for a value it may write verbatim into an element:
    right type, one value (no backslash), inside the VR's cap, inside the VR's
    repertoire — and, where the VR has one beyond its repertoire, inside its
    grammar (:func:`_is_uid`). Shaped to return a string rather than a bool so it drops into
    the ``or`` chains that fill the Type 1 attributes below — a value its VR
    cannot carry falls through to the next fallback exactly as a missing one
    does, instead of going out on the wire illegal and taking the whole item
    with it. That is the disposition for IDENTIFIERS, where a truncated value
    names a different order or a different person; prose takes the other
    disposition, :func:`_vr_text`.

    Deliberately ``isinstance`` rather than ``str()``: pydicom hands a
    multi-valued element back as a ``MultiValue``, which stringifies without
    error into its Python repr — the shape a ``str(... or "")`` coercion hides
    and puts on the wire as ``['CT', 'MR']``.
    """
    if not isinstance(value, str):
        return ""
    v = value.strip()
    if not v:
        return ""
    rule = _VR_SINGLE_VALUE_RULES.get(vr)
    if rule is None:
        return ""
    max_len, allowed, upper = rule
    if upper:
        v = v.upper()
    if len(v) > max_len:
        return ""
    if allowed is None:
        return v if all(_repertoire_ok(c) for c in v) else ""
    if not all(c in allowed for c in v):
        return ""
    # UI is the one VR in the table whose legality is not settled by its
    # character set: a UID is a grammar too, and both ways of breaking it are
    # written in the characters _UI_CHARS allows. The rules table has no column
    # for a grammar, so the check lives in _is_uid and is asked for by name.
    return v if vr != "UI" or _is_uid(v) else ""


# What each identifier an order carries has to fit for this module to be able to
# put it on the wire as typed, named once so the gate upstream and the item
# built here cannot drift apart. Keyed by the ORDER field, not by the element,
# because the callers that ask are holding an order dict.
#
# Only the three keys OrderStore.match reconciles on are listed (ris.py: Study
# Instance UID, then accession, then patient id), and that is the whole point of
# the list rather than an omission. An identifier that cannot be represented is
# not merely missing from the item — it is missing from the ONE value the study
# coming back off the scanner will be matched against, so the order stays open
# forever and the auto-close never fires. The order's other identifiers degrade
# to a stand-in and cost a label; these three cost the reconciliation.
RECONCILING_IDENTIFIERS = {
    "accession": "SH",
    "patient_id": "LO",
    "study_uid": "UI",
}


def identifier_fits(value, vr: str) -> bool:
    """True when *value* can travel as one legal *vr* value, or is absent.

    The question the intake form and the API ask BEFORE an identifier is
    stored, answered by the same rule that decides what goes on the wire, so
    that "we accepted it" and "a modality can be shown it" cannot mean two
    different things. Absent is deliberately True: an emergency order is
    allowed to carry no accession and no patient id at all — add_order only
    insists on one of the three — and an empty field is a thing reception chose,
    not a value that will be quietly dropped later.

    Exposed, where the rest of this VR machinery is private, because the layer
    that has to refuse an unrepresentable identifier is the one where the person
    who typed it is still looking at it. By the time build_worklist_item sees
    the value, the receptionist has been told the worklist is serving the order
    and has gone back to the queue of patients.
    """
    v = str(value or "").strip()
    return not v or bool(_vr_value(v, vr))


def _vr_text(value, vr: str) -> str:
    """*value* reduced to a legal single value of *vr* by removing and clipping.

    The other disposition. PROSE — an exam description — may be shortened
    without lying: a description cut at the sixty-fourth character still
    describes the same exam, where a shortened identifier would name a different
    one. The characters the VR forbids are dropped for the same reason the PN
    delimiters are dropped from the stand-in name below: a backslash inside a
    typed description is a typist's slash, not a request for a second value, and
    obeying it as a delimiter breaks the attribute for every SCU that reads it.
    """
    rule = _VR_SINGLE_VALUE_RULES.get(vr)
    if rule is None:
        return ""
    max_len, allowed, upper = rule
    v = str(value or "").strip()
    if upper:
        v = v.upper()
    keep = _repertoire_ok if allowed is None else allowed.__contains__
    return "".join(c for c in v if keep(c))[:max_len].strip()


def _echoable(query_value, vr: str = "") -> str:
    """The queried value when it is one we may honestly echo back, else ''.

    Used for the keys this module matches LENIENTLY: the order left the field
    blank, so the item reached a scanner that asked for a specific value, and
    the value it asked for is the only answer that neither comes back empty
    (Type 1) nor contradicts the key the SCU matched on. Wildcards are excluded
    because a pattern is not a value — ``CT*`` is not a Modality any IOD
    defines, and an SCU reading it back would be worse off than with the
    stand-in.

    *vr* is the VR of the element the value would be written into, and passing
    it is what keeps this rule from trading one broken item for another. The
    whole justification for echoing (see :func:`build_worklist_item`) is that
    some modalities drop the entire item rather than the offending key — and an
    SCU strict enough to drop a zero-length CS is strict enough to drop an
    illegally-valued one. Three ways a real query arrives unechoable:

      * it is not a ``str`` at all. A shared CT/MR console queries
        ``Modality=CT\\MR``, which pydicom hands us as a ``MultiValue``;
        ``str()`` on one yields its Python repr, so the item would go out on the
        wire carrying literally ``['CT', 'MR']`` — twelve characters of which
        none is legal in CS. A multi-valued query key is also not one value we
        could honestly claim the step is, so there is nothing to echo.
      * it is longer than the VR allows (a forty-character Modality query).
      * it contains characters the VR forbids (``ct;head``).

    Case is the one thing normalised rather than rejected. :func:`_match_text`
    compares case-insensitively, so a query of ``ct`` already matched this order
    *as* ``CT``; returning it in the case CS defines is returning the value that
    was matched, not a different one.

    Everything except the wildcard rule is :func:`_vr_value`: the legality a
    queried value has to satisfy is the legality any value has to satisfy, and
    it is the same table for both. The wildcard rule is the part that belongs to
    echoing alone — ``CT*`` is a perfectly legal CS value and still not a
    Modality any IOD defines.
    """
    if not isinstance(query_value, str):
        return ""
    q = query_value.strip()
    if not q or any(c in q for c in "*?"):
        return ""
    # vr is empty for the one caller that needs the raw string back — _step_date,
    # which must see a date RANGE whole before it can split it.
    return _vr_value(q, vr) if vr else q


def _is_da(value: str) -> bool:
    """True for a well-formed DICOM DA (YYYYMMDD) that is also a real date.

    Eight digits is the FORM of a DA; ``20260231`` has the form and is not a
    day. The distinction matters because a value that passes here is written
    into a Type 1 DA and is not checked again: pydicom refuses it
    (``Invalid value for VR DA``) and an SCU strict enough to validate drops the
    item, which is the whole failure this module's Type 1 handling exists to
    prevent. ``datetime.date`` is the calendar — it knows the month lengths and
    it knows which years are leap years — so the round-trip is the check.
    """
    if len(value) != 8 or not value.isdigit():
        return False
    try:
        datetime.date(int(value[0:4]), int(value[4:6]), int(value[6:8]))
    except ValueError:
        return False
    return True


def _is_tm(value: str) -> bool:
    """True for a well-formed DICOM TM: HH, HHMM or HHMMSS, on a real clock.

    The companion to :func:`_is_da` and for the same reason — the SPS Start Time
    this module writes is Type 1. TM's fractional-second form is not accepted
    because :func:`_order_time` cannot produce one; the shorter forms are,
    because an HL7 OBR-7 legitimately arrives hour- or minute-precise. Leap
    seconds are why the seconds field admits 60.
    """
    if len(value) not in (2, 4, 6) or not value.isdigit():
        return False
    parts = [int(value[i:i + 2]) for i in range(0, len(value), 2)]
    limits = (23, 59, 60)
    return all(p <= limits[i] for i, p in enumerate(parts))


def _step_date_for(q: str, today: str) -> str:
    """The date to stamp a dateless order with for ONE query value.

    :func:`_step_date` has the reasoning; this is the arithmetic, split out so
    that a multi-valued date key is answered by the same rule applied to each of
    its values rather than by a rule of its own.
    """
    if "-" in q:
        lo, _, hi = q.partition("-")
        lo, hi = lo.strip(), hi.strip()
        if _is_da(lo) and today < lo:
            return lo
        if _is_da(hi) and today > hi:
            return hi
        return today
    return q if _is_da(q) else today


def _step_date(order_date: str, query_value) -> str:
    """The SPS Start Date to return, given the order's own date (possibly none)
    and the date the query asked for.

    An order WITH a date always returns its own: leniency never applied to it.
    A dateless order matched the query leniently (see :func:`_match_date`), so
    the same rule the other lenient keys follow applies here too — it comes back
    stamped with the date that was asked for, and a range comes back clamped
    INTO the range rather than stamped with a today that may sit outside it.
    Before this, every dateless order came back as today whatever the query
    said, which is the one place the module contradicted its own reasoning: a
    scanner asking for tomorrow's list was handed an item dated today and was
    entitled to drop it.

    Today is still the answer to a universal or malformed date query. It claims
    nothing nobody typed — "this day, hour unknown" is what a hand-keyed order
    says — and it is deterministic within the day, so two C-FINDs a second apart
    return the identical item.

    A MULTI-VALUED date key asks for several days at once (:func:`_query_values`),
    and any one of them is an answer the SCU cannot call a contradiction. Today
    is preferred whenever it is one of them, because today is the honest answer
    for an order nobody dated and because it keeps the item identical across
    C-FINDs; otherwise the first value's answer is taken, which is still a day
    the scanner asked to see.
    """
    if order_date:
        return order_date
    today = _today()
    answers = [_step_date_for(q, today)
               for q in (_echoable(v) for v in _query_values(query_value)) if q]
    if not answers:
        return today
    return today if today in answers else answers[0]


def _pn_component(value: str) -> str:
    """*value* reduced to something that can be dropped into one PN component.

    ``^``, ``=`` and ``\\`` are PN's own delimiters, so an accession carrying one
    would silently split the name into extra components — or, as a backslash,
    turn one worklist item into two values of a multi-valued attribute.
    """
    return "".join(ch for ch in str(value or "").strip() if ch not in "^=\\")


# PS3.5 6.2: a PN value may carry at most three component GROUPS (alphabetic,
# ideographic, phonetic, separated by "="), and each group is limited to sixty
# four characters INCLUDING the "^" delimiters between its five components. The
# cap is therefore on the whole group, not on each name part — which is why
# _pn_fit below clamps "UNKNOWN^<accession>" as one string rather than clamping
# the accession to sixty four and shipping seventy two.
PN_GROUP_MAX = 64
PN_MAX_GROUPS = 3
# Five components to a group: family^given^middle^prefix^suffix.
PN_MAX_COMPONENTS = 5


def _derived_study_uid(oid: str) -> str:
    """A legal Study Instance UID derived from the order id, or '' without one.

    The stand-in for the one Type 1 whose stored value can reach here unusable
    (see build_worklist_item). ``entropy_srcs`` makes pydicom hash the order id
    rather than draw randomness, so the same order yields the same UID on every
    C-FIND and after every restart — the determinism the rest of this function
    is built on. The pydicom import is local because the module-level ones are,
    and for the same reason ``ris._gen_uid`` keeps its own local.
    """
    if not oid:
        return ""
    from pydicom.uid import generate_uid
    return str(generate_uid(entropy_srcs=["carino-mwl-order", oid]))


def _pn_fit(value: str) -> str:
    """*value* clamped to what PN can legally carry, keeping its structure.

    Patient's Name reaches this module from two places that are both free of any
    length limit: the accession-derived stand-in built below (barcode-derived
    accession schemes run well past sixty four characters) and the name the
    receptionist typed (the intake field has no ``maxlength``). Over-long is the
    same failure as empty — the SCU rejects the attribute, and the modalities
    that reject the whole item rather than the key are the ones this function's
    caller exists to keep. Truncation is the right answer rather than a
    stand-in: the head of a name or an accession is what a human reads off the
    requisition, and the identifier that is guaranteed unique and searchable is
    Patient ID (``TMP-`` + the order id), not this.

    PN is the one VR here whose delimiters are part of a legal value, so it gets
    its own function rather than a row in _VR_SINGLE_VALUE_RULES: ``=`` divides
    the at-most-three component groups and ``^`` the at-most-five components of
    each, and both are kept and counted. The backslash is not one of them — it
    is the VALUE delimiter, so a name carrying one goes out as two values of a
    VM-1 attribute, and pydicom will not even assign it. :func:`_pn_component`
    has dropped it from the stand-in since that stand-in existed; this drops it
    from every name, which is where it actually arrives: an HL7 PID-5 carries
    ``\\T\\`` as the escape for ``&``, and a receptionist typing an initial can
    type the wrong slash. Dropping rather than substituting keeps one rule —
    what PN cannot carry, PN does not carry — and the honest repair for the HL7
    escape belongs upstream in ``ris.parse_order``, not here.
    """
    # _repertoire_ok is what rejects the backslash, along with the control
    # characters no single-valued text VR admits.
    clean = "".join(ch for ch in str(value or "").strip() if _repertoire_ok(ch))
    groups = []
    for group in clean.split("=")[:PN_MAX_GROUPS]:
        groups.append("^".join(group.split("^")[:PN_MAX_COMPONENTS])[:PN_GROUP_MAX])
    fitted = "=".join(groups)
    # A value built out of nothing but PN's own delimiters names nobody, and it
    # is the empty Type 1 the caller falls back to the stand-in to avoid — it
    # just does not LOOK empty to an `or` chain. A typed "=" encodes to a
    # zero-length element (pydicom renders PersonName("=") as ""), and "^^"
    # encodes to a value that is non-empty only in the delimiters, which draws
    # the nameless line on the scanner's list that the stand-in exists to
    # replace. The caller's rule is already the right one — a name made only of
    # characters PN cannot carry falls through — and the delimiters are the
    # other half of "carries no name", so they fall through by the same rule
    # rather than by a second one. Reachable from the intake field, which is
    # free text with no sanitising; HL7's own empty-components form ("^^^^")
    # is already flattened to "" upstream by ris._fmt_hl7_name.
    return fitted if fitted.strip("^= ") else ""


# --------------------------------------------------------------------- matching
def _query_values(query_value) -> list[str]:
    """Every value a query key carries, stripped, as a list.

    A DICOM match key may be MULTI-VALUED, and a multi-valued key means "any of
    these": a shared CT/MR console sends ``Modality=CT\\MR`` and is entitled to
    the CT orders AND the MR ones. pydicom hands that key back as a
    ``MultiValue``, so the ``str(query_value or "")`` this function replaced
    turned the console's query into the Python repr ``"['CT', 'MR']"``, which is
    equal to no order's modality and matched nothing — hiding from that console
    precisely the orders on which the receptionist DID name the modality, while
    the untargeted ones still appeared on the lenient branch. An emergency
    worklist may over-show an order; the one thing it may never do is withhold
    one that was asked for by name (see "Keys we do NOT match on" above).

    Deliberately ``isinstance`` rather than ``str()``, which is the discipline
    :func:`_vr_value` states for the way OUT applied to the way IN: what pydicom
    hands back as several values is read as several values, never stringified
    into a shape that is neither a value nor an error. It is asked by TYPE and
    not by "can I iterate this", and the difference is not academic —
    ``PatientName`` comes back as a ``PersonName``, which iterates over its
    CHARACTERS, so a query for ``DOE^JANE`` read that way would become eight
    one-character values and match nobody. A multi-valued element is a
    ``MultiValue``; everything that is not one is one value. The import is local
    for the same reason ``_derived_study_uid``'s is — this module's
    module-level imports are pynetdicom's.

    Empty members are dropped rather than read as universal — a trailing
    delimiter (``CT\\``) is one console's punctuation, not a request for every
    order on the appliance — and a key whose members are ALL empty is the
    universal query it looks like.
    """
    from pydicom.multival import MultiValue
    if query_value is None:
        return []
    if isinstance(query_value, (MultiValue, list, tuple)):
        return [v for v in (str(x).strip() for x in query_value) if v]
    q = str(query_value).strip()
    return [q] if q else []


def _match_one_text(q: str, o: str) -> bool:
    """One query VALUE against one order value: wildcard, else case-insensitive
    equality. Split out of :func:`_match_text` so that honouring every value of a
    multi-valued key is a loop over the existing rule rather than a second rule."""
    if any(c in q for c in "*?"):
        return fnmatch.fnmatch(o.upper(), q.upper())
    return o.upper() == q.upper()


def _match_text(query_value, order_value, lenient_blank_order: bool = False) -> bool:
    """One text key. Empty query = universal match. ``*``/``?`` = wildcard.
    Otherwise case-insensitive equality against ANY of the key's values, a
    multi-valued key being DICOM's "any of these" (:func:`_query_values`). When
    *lenient_blank_order* and the order leaves the field blank, it matches any
    queried value."""
    queries = _query_values(query_value)
    o = str(order_value or "").strip()
    if not queries:
        return True                     # universal / return-key
    if lenient_blank_order and not o:
        return True                     # untargeted order shows for any value
    return any(_match_one_text(q, o) for q in queries)


def _match_one_date(q: str, order_date: str) -> bool:
    """One date query VALUE — an exact date or an ``a-b`` / ``a-`` / ``-b`` range —
    against the order's date. Split out for the reason :func:`_match_one_text` is."""
    if "-" in q:
        lo, _, hi = q.partition("-")
        lo, hi = lo.strip(), hi.strip()
        if lo and order_date < lo:
            return False
        if hi and order_date > hi:
            return False
        return True
    return order_date == q


def _match_date(query_value, order_date: str) -> bool:
    """DICOM date matching (exact or ``a-b`` / ``a-`` / ``-b`` range), satisfied by
    ANY of the key's values — a worklist SCU legitimately asks for two days at
    once, and the coercion this replaced dropped every dated order when it did.
    Empty query matches all. An order with NO scheduled date matches any query
    (lenient — a hand-keyed emergency order must not be hidden by a date
    filter)."""
    queries = _query_values(query_value)
    if not queries:
        return True
    if not order_date:
        return True                     # dateless order: never hide it
    return any(_match_one_date(q, order_date) for q in queries)


def _query_sps_item(ds):
    """First item of the query's Scheduled Procedure Step Sequence, or None.

    A worklist query carries exactly one scheduled step, so anything past the
    first item came from a non-conformant SCU.  It is ignored rather than read
    as a second alternative: guessing an OR there would put orders on a
    modality that nothing in the message asked for.
    """
    seq = getattr(ds, "ScheduledProcedureStepSequence", None)
    try:
        return seq[0] if seq else None
    except (TypeError, IndexError):
        return None


def order_matches_query(order: dict, ds) -> bool:
    """True if *order* satisfies every match key present in the C-FIND query *ds*."""
    if not _match_text(getattr(ds, "PatientID", ""), order.get("patient_id")):
        return False
    if not _match_text(getattr(ds, "PatientName", ""), order.get("patient_name") or order.get("patient")):
        return False
    if not _match_text(getattr(ds, "AccessionNumber", ""), order.get("accession")):
        return False
    if not _match_text(getattr(ds, "StudyInstanceUID", ""), order.get("study_uid")):
        return False
    q = _query_sps_item(ds)
    if q is not None:
        # Modality / station may be blank on the order → lenient (show everywhere).
        if not _match_text(getattr(q, "Modality", ""), order.get("modality"), lenient_blank_order=True):
            return False
        if not _match_text(getattr(q, "ScheduledStationAETitle", ""), order.get("station_aet"), lenient_blank_order=True):
            return False
        if not _match_date(getattr(q, "ScheduledProcedureStepStartDate", ""), _order_date(order)):
            return False
    return True


# ---------------------------------------------------------------- response build
def _note_substitution(report, order: dict, attr: str, typed: str, sent: str) -> None:
    """Tell *report* that a reconciling identifier did not go out as it is stored.

    The half of the repair that cannot be done upstream. An order typed into
    this appliance is gated before it is stored (``identifier_fits``), but an
    order that arrived over HL7 never passed that gate, and an order already in
    a store from before the gate existed never passed it either — so this
    function still has to decide what to send, and whatever it decides, the
    operator has to be able to find out that it decided anything.

    Silence is the one disposition that is not available. A blanked accession
    and a substituted patient id both look, from the dashboard, exactly like an
    order that is being served normally: the green confirmation is the same,
    the open-order row is the same, and the first sign of trouble is a study
    that sits unreconciled and an order that never closes. A line in the log
    names the order, the attribute, and both values, which is enough to shorten
    the accession on the order and have the next C-FIND carry it.

    *report* is optional so that the callers that build an item to look at its
    shape — tests, the item preview — need not invent a sink. Nothing here may
    raise: a log that is full or wedged must not cost the modality its worklist.
    """
    if report is None or not typed or typed == sent:
        return
    try:
        report(str(order.get("id", "") or ""), attr, typed, sent)
    except Exception:
        pass


def build_worklist_item(order: dict, query=None, report=None):
    """A full MWL C-FIND response dataset for one order. We return the standard
    attribute set regardless of which return keys the SCU asked for — extra
    attributes are harmless and save us guessing the SCU's return-key list.

    Type 1 attributes (required, non-zero-length) are the reason this function
    is not a straight field copy. A hand-keyed emergency order routinely carries
    none of them: the receptionist types a patient, an exam and presses Enter.
    A zero-length Type 1 is not cosmetic — some modalities drop the whole item
    rather than the offending key, so the order that was just queued never
    appears on the scanner and the outage reads as a Carino fault. Each one
    below is therefore filled, and never arbitrarily: from the order, or from
    the query that selected this order, or from a stand-in this file names and
    justifies. The one Type 1 the echo rule is deliberately NOT applied to, and
    why, is documented at the end.

    The three sources are held to one standard, because an SCU cannot tell them
    apart: EVERY value written below must be legal for the VR of the element it
    lands in — right character set, inside the length cap, and ONE value.
    Whichever source it came from, an illegal value costs exactly what an empty
    Type 1 costs, and costs it at the same strict SCUs. ``_VR_SINGLE_VALUE_RULES``
    is the single statement of what legal means; :func:`_vr_value` applies it to
    identifiers (an unusable value falls through to the next fallback, as a
    missing one does), :func:`_vr_text` to prose (shortened, not dropped),
    :func:`_pn_fit` to names, and :func:`_is_da` / :func:`_is_tm` to the date and
    time, which are calendars and clocks rather than character sets.

    *query* is the C-FIND identifier this item is being built in answer to, and
    it is optional only so that callers testing the shape of an item need not
    construct one. It exists because a Type 1 key cannot be answered honestly
    without it: the keys a blank order matched LENIENTLY (Modality, SPS Start
    Date) are the keys the SCU filtered on, so returning a value the SCU did not
    ask for hands it an item it is entitled to discard — and an order discarded
    at the scanner is indistinguishable, to the tech, from the order never
    having been queued. Given the query, those keys come back as the value that
    was asked for, which is both non-empty and the truth: this item is being
    offered to that scanner, for that scanner to perform.

    *report* is how this function says that an identifier the order carries did
    not go out as it is stored — called as ``report(order_id, attribute, typed,
    sent)``, see :func:`_note_substitution`. It is asked for on exactly the
    three keys OrderStore reconciles a returning study on, because on those
    three a stand-in or a blank is not a cosmetic loss but an order that can
    never be closed. Optional, so a caller inspecting the shape of an item need
    not supply one; :class:`MwlSCP` always does.
    """
    from pydicom.dataset import Dataset

    # The query's scheduled step, when we were given a query at all. Only the
    # first item is read, for the reason _query_sps_item gives.
    q_step = _query_sps_item(query) if query is not None else None

    ds = Dataset()
    ds.SpecificCharacterSet = "ISO_IR 192"          # UTF-8 → accented names survive

    # The order's own id is the last-resort identifier for the Type 1 id
    # attributes below: OrderStore stamps it on every order at creation, it is
    # twelve hex characters so it fits SH (16), and it is unique for the life of
    # the store.
    oid = str(order.get("id", "") or "")
    acc = str(order.get("accession", "") or "").strip()

    # Patient / study identification.
    #
    # Patient's Name and Patient ID are both Type 1 in the worklist information
    # model (PS3.4 Table K.6-1 lists each as a required matching key), and
    # add_order() accepts an order carrying any ONE of accession / patient name /
    # patient ID — so a legal trauma order reaches here with either of them
    # blank. Neither was ever matched leniently (order_matches_query compares
    # both strictly), which is what makes a stand-in safe: an order with no
    # patient id is only ever returned to a query that asked for no particular
    # one, so nothing we put here can contradict what the SCU matched on.
    #
    # The stand-ins are the order's own identifiers, not invented ones. The
    # objection to inventing a patient identifier is real — the modality burns
    # it into the exam and somebody has to merge it back out of the archive
    # later — but an EMPTY Patient ID is burned into the exam just the same,
    # and it is the one value that cannot be searched for afterwards. "TMP-" +
    # the order id can: it is unique, it is deterministic, it says plainly that
    # nobody identified this patient, and it names the exact order to merge
    # against. The department's own temporary identifier, typed into the intake
    # form, still overrides it — that decision belongs on the form, and this is
    # only what the modality is shown when the form did not carry it.
    #
    # _pn_fit is applied to whichever of the three we end up with, not only to
    # the stand-in: a typed name is no more length-checked or delimiter-checked
    # on the way in than an accession is, and PN's sixty-four-character group
    # limit — and its backslash — are broken the same way by either. The typed
    # name is fitted SEPARATELY from the stand-in rather than inside one
    # expression so that a name made entirely of characters PN cannot carry
    # (a lone backslash, a pasted control character) falls through to the
    # stand-in instead of emptying a Type 1.
    ds.PatientName = (_pn_fit(order.get("patient_name") or order.get("patient"))
                      or _pn_fit(f"UNKNOWN^{_pn_component(acc or oid)}"))
    # Patient ID is LO, and it is the one Type 1 identifier a source with no
    # length limit of its own fills directly: the intake field has no
    # `maxlength` and HL7 PID-3.1 has none either. Fitted like every other
    # identifier here, so an over-long or backslash-carrying one falls through
    # to the "TMP-" stand-in that exists for exactly this attribute — the
    # stand-in was written so this Type 1 is never unusable, and a typed value
    # the VR cannot carry is more unusable than the empty one it replaced.
    ds.PatientID = (_vr_value(order.get("patient_id", ""), "LO")
                    or (f"{TEMP_PATIENT_PREFIX}{oid}" if oid else _vr_value(acc, "LO")))
    # Reported, because this is the one stand-in that replaces a patient
    # identifier somebody actually typed. The substitution stays — a Type 1 this
    # department can search for beats an empty one, and that argument is made
    # above — but it is no longer silent: with match_on='accession_or_patient'
    # the stored value is a reconciliation key, and the exam comes back carrying
    # "TMP-" + the order id, which the store will compare against the over-long
    # id it holds and not match. The operator is told which order to shorten.
    _note_substitution(report, order, "PatientID",
                       str(order.get("patient_id", "") or "").strip(), ds.PatientID)
    # Type 2 DA and CS. An order's birth date arrives as HL7 PID-7 or from a
    # date field, and neither guarantees a day on the calendar; sex arrives as
    # PID-8 or a select. Both are Type 2, so the empty value a malformed one
    # falls back to is legal where the malformed one is not.
    bdate = _digits(order.get("patient_birthdate"))[:8]
    ds.PatientBirthDate = bdate if _is_da(bdate) else ""
    ds.PatientSex = _vr_value(order.get("patient_sex", ""), "CS")
    # Burned into the exam → exact reconcile, and Type 1. OrderStore generates
    # this UID on every order it creates, so in practice it is always a legal
    # UI; it is fitted anyway because ORDER_FIELDS lets an API caller supply one
    # instead, and a UI carrying a backslash is not one illegal attribute but a
    # dataset the SCU parses differently from the one we sent.
    #
    # The stand-in is derived from the order id, by the same argument that
    # justifies the "TMP-" patient identifier above: a stored study_uid that is
    # not a UID reconciles to nothing already — no exam will ever carry it — so
    # a derived one loses nothing and keeps the item legal for the SCUs that
    # drop a malformed one whole. entropy_srcs makes it a pure function of the
    # order id, so it is stable across C-FINDs and across restarts, which a
    # freshly generated UID would not be. The real repair is upstream in
    # OrderStore, which should refuse a study_uid it did not generate.
    ds.StudyInstanceUID = (_vr_value(order.get("study_uid", ""), "UI")
                           or _derived_study_uid(oid))
    # Reported for the same reason, and it is the strongest of the three keys:
    # OrderStore.match tries Study Instance UID first and always. A stored UID
    # that is not a UID reconciles to nothing whether we send it or not — the
    # comment above says why the derived one loses nothing — but "loses nothing"
    # is a statement about this line, not about the order, which is still never
    # going to close. That is worth a line naming it.
    _note_substitution(report, order, "StudyInstanceUID",
                       str(order.get("study_uid", "") or "").strip(), ds.StudyInstanceUID)
    # Accession Number is SH, and unlike the identifiers below it is Type 2 —
    # so an EMPTY one is legal here where an over-long one is not. It is also
    # the one attribute that may carry the department's accession or nothing at
    # all: no fallback would be true in it, and a TRUNCATED accession is worse
    # than an absent one, because the modality burns this value into the exam
    # and a sixteen-character prefix of a barcode scheme names a different order
    # — or no order — to whoever merges the study afterwards. Verbatim when it
    # fits, empty when it does not.
    #
    # This comment used to end "Reconciliation loses nothing either way", and
    # that sentence was wrong in the most expensive direction. Accession is the
    # DEFAULT reconciliation key: OrderStore is constructed with
    # match_on="accession", and match() compares the incoming study's accession
    # against the one stored on the order. Send this element empty and the exam
    # comes back with no accession to compare, so the order stays open forever
    # and the auto-close never fires. It is true that an MWL-served exam also
    # carries the Study Instance UID, which match() tries first — but that is a
    # second path, not a reason the first one may fail in silence, and it is not
    # there at all for the tech who keys the study in at a console that was
    # never given the worklist item.
    #
    # Empty is nonetheless still what goes out, and the two alternatives are why:
    #
    #  * TRUNCATING names a different order, as above, and does it in the value
    #    the scanner burns into the exam.
    #  * A DERIVED stand-in — the order id, the way PatientID and
    #    RequestedProcedureID take one — would reconcile no better and lie as
    #    well. match() compares against what the STORE holds, which is the
    #    over-long accession; an invented sixteen-character one equals nothing
    #    in it. The tech would be reading a plausible accession off the console
    #    that belongs to no order and no department scheme.
    #
    # So the value is honest and the LOSS is what stops being silent: the
    # substitution is reported, the log names the order and what could not be
    # carried, and the accession can be shortened on the order so the next
    # C-FIND carries it. The repair for the rest is upstream and is now there —
    # identifier_fits() gates the intake form and the API, so a typed accession
    # no longer reaches this line unrepresentable. What still does is an order
    # off an HL7 feed, whose OBR-3 has no sixteen-character limit of its own,
    # and an order stored before that gate existed.
    ds.AccessionNumber = _vr_value(acc, "SH")
    _note_substitution(report, order, "AccessionNumber", acc, ds.AccessionNumber)
    ds.ReferringPhysicianName = _pn_fit(order.get("referring", ""))
    # Requested Procedure ID is Type 1. A hand-keyed order has no procedure id,
    # so it falls back to the SPS id and then to the order's own id — the only
    # identifier that is always there. Not to the accession number: a
    # hand-keyed accession can exceed SH's 16 characters, it is already returned
    # in its own attribute, and it is itself one of the fields an emergency
    # order may not have.
    #
    # An HL7-sourced order can overrun SH here too — procedure_id and sps_id are
    # OBR-2 / ORC-2, a placer order number with no sixteen-character limit of its
    # own (ris.py) — so each is taken only if it fits and otherwise falls through
    # to the order id, for the same reason the accession was already excluded:
    # an over-long Type 1 is as unusable to the scanner as an empty one.
    ds.RequestedProcedureID = (_vr_value(order.get("procedure_id", ""), "SH")
                               or _vr_value(order.get("sps_id", ""), "SH")
                               or _vr_value(oid, "SH"))
    # The exam's description, reduced to what LO holds. Prose is the one thing
    # here that may be truncated without lying: a description shortened at the
    # sixty-fourth character still describes the same exam, where a shortened
    # identifier would name a different one — which is why this is the one place
    # _vr_text is used instead of _vr_value. Computed once because both the
    # Requested Procedure and the Scheduled Step carry it.
    #
    # The stand-in is not decoration. Both attributes this value lands in are
    # type 1C against a code sequence this module never emits, which makes them
    # required here exactly as the Type 1s above are — and the order is not
    # obliged to carry a description at all, so most items would otherwise ship
    # the pair of them zero-length. UNSTATED_PROCEDURE says why the attribute is
    # not a real exam name; an empty one says nothing, and says it in the field
    # the tech reads to know what to do with the patient.
    desc = _vr_text(order.get("study_desc", ""), "LO") or UNSTATED_PROCEDURE
    ds.RequestedProcedureDescription = desc

    # Scheduled Procedure Step Sequence — one step per order
    step = Dataset()
    # Modality is Type 1, and it is the first key a hand-keyed order leaves
    # blank: the receptionist knows the patient needs a head CT, not which of
    # the three CTs will take it, and the form does not ask. A blank one matched
    # the query leniently, so this item is in a CT's response precisely because
    # it is addressed to no modality — and the CT is the only device that will
    # ever read this copy of the item. Echoing the modality it asked for is
    # therefore both the honest answer (a step performed on that scanner IS that
    # modality) and the only non-empty one it cannot discard for contradicting
    # its own query. Asked universally, or with anything that is not itself one
    # legal CS value — a wildcard, a multi-valued CT\MR query from a shared
    # console, an over-long or punctuated string — the item falls back to OT —
    # Other — which is the standard's way of saying what the order says:
    # equipment class not stated. The VR is passed to _echoable rather than
    # assumed by it because this is the one echo that lands in a CS; sending back
    # an illegal CS would lose the item at exactly the SCUs this fallback exists
    # to satisfy.
    #
    # The ORDER's own modality is fitted to CS by the same rule. CS defines no
    # lowercase letter, so an order carrying "ct" would have gone out illegal —
    # and gone out in answer to a CT's query for "CT", because _match_text
    # matched it case-insensitively. Uppercasing it (inside _vr_value) returns
    # the value that was matched. What is NOT tried here is deciding whether
    # the uppercased value is a modality anybody recognises: Modality is a
    # Defined Term, extensible by design, and a site that codes its portable
    # fleet "DX_PORT" is entitled to. A value that is not a legal CS at all
    # ("ct;head") falls through to the echo and then to OT, which keeps the
    # item on the scanner rather than losing it to a key somebody got wrong.
    #
    # Be careful what that fallback is read as promising, because it rescues
    # the RETURN and never the SELECTION. An order whose modality is neither
    # blank nor the code the console asked for — "CT HEAD" against a scanner
    # asking "CT" — is refused by order_matches_query long before this line is
    # reached, so nothing here can put it on that scanner's screen; only a
    # console that sends no Modality key at all ever sees it. This comment used
    # to say such an order "goes out as typed … visibly the receptionist's
    # words", which was true only of that one universal-query console and read
    # as a general reassurance it never was.
    #
    # That is why the repair for a mistyped modality had to be upstream, and is:
    # the intake field is no longer free text but a select of codes built from a
    # constant (fillModalityChoices in pacs/web/js/07-config.js), whose blank first choice is the
    # one that shows on every worklist, so reception can no longer submit a
    # value that selection would hide. What still reaches this line unconstrained
    # is text from somewhere we do not own — an HL7 OBR-24 off a feed, or a
    # direct API caller — and for those the CS fitting above is the whole of the
    # protection.
    step.Modality = (_vr_value(order.get("modality", ""), "CS")
                     or _echoable(getattr(q_step, "Modality", "") if q_step is not None else "", "CS")
                     or UNSTATED_MODALITY)
    # ScheduledStationAETitle is Type 1 too, and the key where this file's echo
    # rule stops — the long-form reasoning is at the end of the function. In
    # short: the queried AE title is the one value that must never be echoed
    # (it would tell every scanner that asks that the order is assigned to IT),
    # so an unaddressed order says so in a word instead of saying nothing.
    # Fitted to AE for the same reason the modality above is fitted to CS: the
    # station is typed into the same form, and an AE title longer than sixteen
    # characters or carrying a backslash is not one a device could have been
    # configured with. An unusable one is therefore the same as an absent one —
    # the order is addressed to nobody, which the stand-in says plainly.
    step.ScheduledStationAETitle = (_vr_value(order.get("station_aet", ""), "AE")
                                    or UNASSIGNED_STATION_AET)
    # SH and Type 2, so — like Accession Number — it is the station's real name
    # or nothing; there is no honest sixteen-character abbreviation of a room.
    step.ScheduledStationName = _vr_value(order.get("station_name", ""), "SH")
    # SPS Start Date is Type 1: a worklist item that leaves it blank is not one
    # a modality has to accept, and some drop the whole item rather than the
    # key. An undated order matches a query for ANY date (see _match_date), so
    # it is shown rather than withheld — and, by the same rule Modality follows,
    # it is shown carrying the date that was asked for rather than a today the
    # query may never have mentioned. _step_date has the full reasoning,
    # including what a date RANGE is answered with.
    step.ScheduledProcedureStepStartDate = _step_date(
        _order_date(order),
        getattr(q_step, "ScheduledProcedureStepStartDate", "") if q_step is not None else "")
    # SPS Start Time is Type 1 as well, and a hand-keyed order gives no time at
    # all (the dashboard's datetime-local may be left empty, and HL7 OBR-7
    # legitimately arrives date-only). Midnight of the date above, specifically,
    # for three reasons — it is not merely "a non-empty TM":
    #   * it is the earliest instant of the day the step is scheduled for, so
    #     the item sorts to the HEAD of the tech's list rather than into a slot
    #     later in the shift, and an emergency order is the last thing that
    #     should be sitting below the routine ones;
    #   * it is deterministic, so two C-FINDs a second apart return the
    #     identical item. The current clock would not, and an SCU that caches or
    #     de-duplicates worklist items by content would see the same order drift
    #     and re-appear;
    #   * it claims nothing nobody typed. "This day, hour unknown" is exactly
    #     what a hand-keyed order says, whereas stamping `now` records a
    #     scheduling decision that was never made — and the modality copies this
    #     value into the exam, where it outlives the outage.
    step.ScheduledProcedureStepStartTime = _order_time(order) or "000000"
    step.ScheduledProcedureStepDescription = desc
    # SPS ID is Type 1, and the order's own id is the right fallback rather than
    # just an available one: the modality echoes this value back in the image's
    # Request Attributes Sequence, so an exam produced from an emergency
    # worklist arrives carrying the exact key that names the order it came
    # from — instead of carrying nothing and leaving reconciliation to the
    # accession fallback the outage may have deprived us of.
    # SH again, and fitted the same way as Requested Procedure ID above: an HL7
    # placer order number that will not fit sixteen characters is not shipped
    # truncated, it falls through to the order id.
    step.ScheduledProcedureStepID = (_vr_value(order.get("sps_id", ""), "SH")
                                     or _vr_value(order.get("procedure_id", ""), "SH")
                                     or _vr_value(oid, "SH"))
    step.ScheduledPerformingPhysicianName = ""
    ds.ScheduledProcedureStepSequence = [step]
    # ---- the one key the echo rule is NOT applied to ------------------------
    # ScheduledStationAETitle. Every other lenient key comes back as the value
    # the SCU asked for; this one comes back as UNASSIGNED_STATION_AET however
    # the query was written, and the asymmetry is deliberate.
    #
    # Modality describes what the step IS, so a CT that pulled an untargeted
    # order can be told the step is a CT without inventing anything. A station
    # AE title records a routing DECISION the department makes, and echoing it
    # would tell every scanner that asks that this order is assigned to IT. That
    # is not a cosmetic lie: an order addressed to nobody reaching every modality
    # is a real and intended state — what a receptionist wants before anybody
    # has decided which room the patient goes to — and the worklist probe's five
    # questions exist to separate a station that is genuinely scheduled from one
    # that only ever sees the unaddressed spillover. Echo it and the probe reads
    # its own answers back as "Working. N order(s) addressed to this modality"
    # (server._probe_verdict) for a scanner nothing is scheduled to, which is the
    # single wrong answer that whole diagnosis was built to stop giving.
    #
    # A word that is plainly not a station costs nothing on the wire and fixes
    # the Type 1: an SCU strict enough to re-filter its own query drops an
    # UNASSIGNED item exactly as it dropped the empty one, while every SCU that
    # validates Type 1 — the ones that were throwing the whole item away — now
    # keeps it. What it does cost is a name downstream: "addressed to nobody" is
    # no longer spelled "" everywhere, so every reader of a returned item has to
    # know both spellings. They all do, and through one predicate rather than
    # three copies of it: caught.addressed_to_nobody() is the question,
    # caught.split_by_addressee() is the only thing that asks it, and that one
    # call fills the probe row's `for_nobody` tally and feeds the sentence
    # server._probe_verdict() writes over that row. A row and the diagnosis
    # printed above it therefore cannot disagree about which items reached this
    # station and which reached every station.
    return ds


class MwlSCP:
    """The worklist provider: every open order in the store is one C-FIND item.

    ``get_orders`` is called on each query rather than cached, so an order
    hand-keyed in the middle of an outage is on the next worklist the modality
    pulls and there is no staleness to invalidate. The list is still a snapshot
    taken when the query arrived: an order created while a C-FIND is being
    answered waits for the next pull, which is the right trade when the
    alternative is a response whose contents change under the SCU.

    Above the transport — a CA on the listener makes it demand a client
    certificate — the AE-title allowlist is the whole of the access control. A
    permitted caller sees every open order its query matches, and its query is
    its own to write: ``station_aet`` on an order is a filter for the operator,
    never a confidentiality boundary. This is why another hospital's caught orders
    are kept in a separate store with no worklist path at all (``caught.py``)
    rather than flagged inside this one.
    """

    def __init__(
        self,
        aet: str,
        bind: str,
        port: int,
        log: LogBuffer,
        get_orders: Callable[[], list],
        allowed_aets: Optional[list[str]] = None,
        tls: bool = False,
        tls_cert: str = "",
        tls_key: str = "",
        tls_ca: str = "",
    ):
        self.aet = aet
        self.bind = bind
        self.port = port
        self.log = log
        # Callable returning the current OPEN orders (decouples us from OrderStore).
        self.get_orders = get_orders
        self.allowed_aets = [a for a in (allowed_aets or []) if str(a).strip()]
        self.tls = tls
        self.tls_cert = tls_cert
        self.tls_key = tls_key
        self.tls_ca = tls_ca
        self._server = None
        self._lock = threading.Lock()
        self.query_count = 0
        self.match_count = 0
        self.error_count = 0
        # (order id, attribute) pairs already named in the log by
        # _report_substitution. Every console on the floor re-queries the
        # worklist every few seconds, and the same order answers every one of
        # those queries, so an unrepresentable accession would otherwise write
        # the same warning hundreds of times an hour into the buffer the
        # operator reads to find out why the worklist is not running. Once per
        # order per attribute per process is enough to be findable, and the
        # order stays in the open list until somebody fixes or closes it.
        self._reported: set[tuple[str, str]] = set()

    def _report_substitution(self, oid: str, attr: str, typed: str, sent: str) -> None:
        """Log, once, that an order's identifier could not go out as it is stored.

        Warn rather than error: the item itself is legal and the modality is
        being served, so nothing has failed yet — what has happened is that the
        key the study will be reconciled on is not the key the order holds, and
        the operator is the only one who can put that right, by shortening the
        value on the order or by closing it by hand when the study lands.

        Both values are in the line on purpose. The one that was typed is what
        reception will recognise; the one that went out is what the tech is
        reading off the console, and matching those two up is the whole job.
        """
        key = (oid, attr)
        with self._lock:
            if key in self._reported:
                return
            self._reported.add(key)
        self.log.warn(
            f"MWL: order {oid or '—'} — {attr} cannot go on a worklist as stored "
            f"({typed!r}); sent {sent!r} instead, so a study coming back will not "
            f"reconcile on it. Correct it on the order, or close the order by hand "
            f"when the study arrives.",
            kind="mwl")

    # ---- DIMSE handlers ----------------------------------------------------
    def _handle_echo(self, event) -> int:
        who = event.assoc.requestor.ae_title
        self.log.info(f"C-ECHO from {who} @ {_peer_addr(event)}", kind="mwl")
        return 0x0000

    def _handle_find(self, event):
        """Yield one worklist item per matching open order. Generator protocol:
        each yield is (status, dataset); pynetdicom sends Success when we return."""
        who = event.assoc.requestor.ae_title
        try:
            query = event.identifier
        except Exception as exc:
            with self._lock:
                self.error_count += 1
            self.log.error(f"MWL: bad query from {who}: {exc}", kind="mwl")
            yield 0xC000, None           # Unable to process
            return
        with self._lock:
            self.query_count += 1
        try:
            # Filtered again here rather than trusted, even though the caller
            # already asks the store for open orders: what counts as a worklist
            # item is this module's decision, so a caller that hands over its
            # whole store cannot put a closed one back on a modality's screen.
            orders = [o for o in (self.get_orders() or []) if o.get("status") == "open"]
        except Exception:
            orders = []
        matches = [o for o in orders if order_matches_query(o, query)]
        self.log.info(
            f"MWL query from {who} @ {_peer_addr(event)} → {len(matches)} "
            f"of {len(orders)} open order(s)", kind="mwl")
        n = 0
        for order in matches:
            if event.is_cancelled:
                yield 0xFE00, None       # Cancel
                return
            try:
                # The query goes with the order: a key that matched leniently is
                # answered with the value this SCU asked for, so the item it
                # receives can never contradict its own query. See
                # build_worklist_item.
                item = build_worklist_item(order, query,
                                           report=self._report_substitution)
            except Exception as exc:
                with self._lock:
                    self.error_count += 1
                # By id: an error here is also the worklist card's "last
                # problem", and an accession is an identifier.
                self.log.error(f"MWL: could not build item for order "
                               f"{order.get('id') or '?'}: {exc}", kind="mwl")
                continue
            n += 1
            yield 0xFF00, item           # Pending — one match
        with self._lock:
            self.match_count += n
        # Generator return → pynetdicom sends 0x0000 Success.

    def _handle_rejected(self, event) -> None:
        """Say why a modality was turned away, which pynetdicom does not."""
        who, addr = caller_of(event)
        with self._lock:
            self.error_count += 1
        self.log.warn(f"MWL: refused {who or 'a modality'} @ {addr} — "
                      f"{listener_refusal(event, self.allowed_aets)}", kind="mwl")

    # ---- lifecycle ---------------------------------------------------------
    @property
    def running(self) -> bool:
        return self._server is not None

    def start(self) -> None:
        if self.running:
            return
        ae = AE(ae_title=self.aet)
        ae.add_supported_context(ModalityWorklistInformationFind)
        ae.add_supported_context(Verification)
        if self.allowed_aets:
            ae.require_calling_aet = list(self.allowed_aets)
        handlers = [
            (evt.EVT_C_FIND, self._handle_find),
            (evt.EVT_C_ECHO, self._handle_echo),
            (evt.EVT_REJECTED, self._handle_rejected),
        ]
        ssl_context = None
        if self.tls:
            from .tlsutil import server_context
            ssl_context = server_context(self.tls_cert, self.tls_key, self.tls_ca)
        # Nothing else may already hold this port. On Windows a plain bind
        # would silently join an existing listener instead of refusing it;
        # netclaim explains why that costs images.
        claim(self.bind, self.port)
        self._server = ae.start_server(
            (self.bind, self.port), block=False, evt_handlers=handlers, ssl_context=ssl_context
        )
        allow = ", ".join(self.allowed_aets) if self.allowed_aets else "any"
        proto = "DICOM-TLS" + (" (mutual)" if self.tls and self.tls_ca else "") if self.tls else "plain DICOM"
        self.log.info(
            f"Worklist (MWL) listening on {self.bind}:{self.port} as {self.aet} "
            f"[{proto}] (accept: {allow})",
            kind="mwl",
        )

    def stop(self) -> None:
        if not self.running:
            return
        try:
            self._server.shutdown()
        finally:
            self._server = None
            self.log.info("Worklist (MWL) stopped", kind="mwl")
