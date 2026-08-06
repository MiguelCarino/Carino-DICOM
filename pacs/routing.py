"""Conditional routing — which destinations does THIS file go to?

Auto-send historically fanned every file out to every enabled destination.
Real gateways route: CT to the archive, US to the reading workstation, anything
from AE ``MAMMO1`` somewhere else entirely. This module is the decision half of
that; it never opens a socket, never writes a file and never mutates config, so
it can be exercised (and unit-tested) without a network.

The one rule that outranks every other design consideration here: **a study must
never end up going nowhere.** Every path through :meth:`Router.route` that fails
to produce a destination — routing off, no rule matched, header unreadable, a
rule naming a destination that no longer exists — falls back to *every enabled
destination*, i.e. exactly the behaviour that shipped before routing existed.
Over-sending is an operator annoyance; under-sending is a lost image.

The single exception is a HOLD, and it is deliberate: a destination a rule asks
to de-identify for is not sent to at all unless the scrub can actually happen.
Two ways it cannot — ``deid.profile`` is ``off``, or the sender has no usable
de-identifier — and they are different causes with the same remedy shape, so
they get the same outcome. The study is not lost by it — it stays in the
outgoing folder and is never archived or deleted — and the alternative was
forwarding identity to a node the operator believes receives none. See
:meth:`Router.deid_profile` for the first cause and :meth:`Decision.honoured_by`
for the second.

Rule shape (see config.example.json)::

    {"name": "CT from the ER",
     "match": {"modality": "CT", "calling_aet": "ER_*"},
     "destinations": ["Teaching archive"],
     "deidentify": true,
     "stop": true}

Every ``match`` key is optional; absent or ``""`` matches anything. Values are
case-insensitive fnmatch globs, or a list of globs meaning "any of these".

A rule's ``deidentify`` and the global ``deid.profile`` are two halves of ONE
decision, and this module now owns both halves — see the note above
:meth:`Router.deid_profile` for why, and for what happens when they contradict
each other.
"""

from __future__ import annotations

import fnmatch
import os
from dataclasses import dataclass, field, replace
from typing import Any, Iterable, Optional

from .dicomfs import is_dicom

# The attributes a rule may match on. Anything else in a rule's `match` object
# is a typo, and a typo has to be visible: see _match_rule().
_MATCH_FIELDS = ("modality", "calling_aet", "station", "patient_id", "study_desc")

# Spellings we accept for the same field, so a rule written from memory works.
_ALIASES = {
    "source_aet": "calling_aet",
    "calling_ae": "calling_aet",
    "station_name": "station",
    "study_description": "study_desc",
}


def _text(value: Any) -> str:
    """A DICOM element as a plain comparable string ('' for absent/None)."""
    if value is None:
        return ""
    return str(value).strip()


def attributes_from_dataset(ds, extra: Optional[dict] = None) -> dict:
    """The five routable attributes of an already-parsed dataset.

    ``extra`` wins over the header. The receiver knows the true calling AE title
    from the association, which is more trustworthy than the copy the sender may
    or may not have written into the file meta."""
    meta = getattr(ds, "file_meta", None)
    attrs = {
        "modality": _text(getattr(ds, "Modality", "")),
        "calling_aet": _text(getattr(meta, "SourceApplicationEntityTitle", "")
                             or getattr(ds, "SourceApplicationEntityTitle", "")),
        "station": _text(getattr(ds, "StationName", "")),
        "patient_id": _text(getattr(ds, "PatientID", "")),
        "study_desc": _text(getattr(ds, "StudyDescription", "")),
    }
    for k, v in (extra or {}).items():
        k = _ALIASES.get(k, k)
        if k in attrs and _text(v):
            attrs[k] = _text(v)
    return attrs


class HeaderCache:
    """Per-scan memo of file -> routable attributes.

    A watcher pass re-examines every file in the outgoing tree every few
    seconds; without this, a study stuck behind a down node would be re-parsed
    forever. Entries are validated against (size, mtime) so a file replaced
    under the same name is re-read rather than routed on its predecessor's
    header."""

    def __init__(self, max_entries: int = 4096):
        self.max_entries = max_entries
        self._data: dict[str, tuple[int, float, Optional[dict]]] = {}
        self.hits = 0
        self.misses = 0

    def attributes(self, path: str) -> Optional[dict]:
        """Routable attributes for *path*, or None if it will not parse."""
        key = os.path.abspath(path)
        try:
            size = os.path.getsize(key)
            mtime = os.path.getmtime(key)
        except OSError:
            return None
        hit = self._data.get(key)
        if hit is not None and hit[0] == size and hit[1] == mtime:
            self.hits += 1
            return hit[2]
        self.misses += 1
        attrs = self._read(key)
        # Bounded without an LRU: re-reading a header costs one stat + a partial
        # parse, so dropping everything on overflow is cheaper than tracking
        # recency, and the pass after the flush repopulates only live files.
        if len(self._data) >= self.max_entries:
            self._data.clear()
        self._data[key] = (size, mtime, attrs)
        return attrs

    def forget(self, path: str) -> None:
        self._data.pop(os.path.abspath(path), None)

    def clear(self) -> None:
        self._data.clear()

    @staticmethod
    def _read(path: str) -> Optional[dict]:
        """stop_before_pixels header read; None on anything unreadable."""
        # The magic-byte check first, because dcmread(force=True) never raises on
        # a non-DICOM file — it hands back a dataset of garbage whose attributes
        # all read as blank, which would quietly satisfy a permissive rule
        # instead of falling back to every destination.
        if not is_dicom(path):
            return None
        try:
            from pydicom import dcmread
            return attributes_from_dataset(dcmread(path, stop_before_pixels=True, force=True))
        except Exception:
            return None


# Causes of a hold. Different causes, same remedy shape ("make the scrub
# possible, or stop asking for it"), so they get the same outcome and differ only
# in what the operator is told.
HOLD_PROFILE_OFF = "profile-off"
HOLD_NO_DEIDENTIFIER = "no-deidentifier"


def usable_deidentifier(deider) -> bool:
    """True when *deider* will actually rewrite the instances handed to it.

    Asked of the OBJECT, never of the config, because the two can disagree:
    ``deid.deidentified_tempfile`` yields the SOURCE path unchanged for a
    de-identifier that exists but is disabled, so ``deider is not None`` is not
    the question — a Deidentifier built for the 'off' profile forwards identity
    exactly as surely as no de-identifier at all. Duck-typed on ``enabled`` so a
    caller's stand-in is judged the same way the real one is."""
    return deider is not None and bool(getattr(deider, "enabled", False))


@dataclass(frozen=True)
class Decision:
    """What one file should do. ``destinations`` is never empty unless there are
    no enabled destinations at all.

    Three sets, and they do not overlap in the way a reader expects, so read this
    once: ``destinations`` is everything the rules picked, ``deid_dests`` is the
    subset that WILL be scrubbed, and ``held`` is the subset that must not be
    sent to at all because a rule asked for a scrub that cannot happen — the
    profile is off, or the sender has no usable de-identifier (``hold_cause``
    says which). ``sendable`` — destinations minus held — is what a sender walks.
    Nothing outside this class may re-derive any of them from the rules, from
    ``deid.profile`` or from a de-identifier it happens to be holding; that is
    the whole point of the type, and :meth:`honoured_by` is the one door in."""
    destinations: tuple[str, ...] = ()
    deid_dests: frozenset[str] = frozenset()
    held: frozenset[str] = frozenset()
    rules: tuple[str, ...] = ()          # names of the rules that contributed
    fallback: bool = False               # True = "all enabled", not a rule result
    reason: str = ""
    unresolved: tuple[str, ...] = ()     # "rule -> destination" pairs that did not resolve
    attributes: dict = field(default_factory=dict)
    hold_cause: str = ""                 # HOLD_* — why `held` is not empty

    @property
    def deidentify(self) -> bool:
        """True if ANY destination in this decision needs de-identification.

        "Needs" as in "and will get it". A rule asking for a scrub that cannot
        happen leaves this False and fills :attr:`held` instead — this flag is
        read straight into "the study was de-identified", and it may only ever
        be True about a study that actually was."""
        return bool(self.deid_dests)

    def needs_deid(self, dest_name: str) -> bool:
        return dest_name in self.deid_dests

    def is_held(self, dest_name: str) -> bool:
        return dest_name in self.held

    @property
    def sendable(self) -> tuple[str, ...]:
        """The destinations a sender may actually open an association to."""
        return tuple(d for d in self.destinations if d not in self.held)

    # The ONLY supported way to put "which destinations a rule scrubs for"
    # together with "what this sender can actually scrub with". It is a method on
    # the Decision rather than a helper a sender calls beside one because every
    # open-coded version of it has been the same defect, three rounds running:
    #
    #     scrub = {n for n in todo if deider is not None and decision.needs_deid(n)}
    #
    # That idiom silently yields a set NARROWER than the Decision promised
    # whenever the de-identifier is missing or disabled, and every destination in
    # the gap is then dialled IN THE CLEAR while `deidentify` — which /api/status,
    # /api/routing/test and the dashboard all read as "this study was scrubbed" —
    # still names it. The shape below cannot do that: a name only ever leaves
    # `deid_dests` by landing in `held`, and a held name is already out of
    # `sendable`, out of the route `record_route` stamps, and enough to keep
    # `fully_sent` False. Narrowing what gets scrubbed and narrowing what gets
    # sent are now the same edit, so they cannot come apart.
    def honoured_by(self, deider) -> "Decision":
        """This decision as it stands once the sender's de-identifier is known.

        Call it on every route() result before sending, with whatever
        de-identifier the sender will actually use — ``None`` included. Returns
        this decision unchanged when the scrub can be honoured, and otherwise one
        that HOLDS every destination it cannot back, exactly as a profile of
        'off' does. Idempotent, so a caller that is not sure whether it has
        already been applied may apply it again."""
        if not self.deid_dests or usable_deidentifier(deider):
            return self
        held = self.held | self.deid_dests
        reason = self.reason
        if reason:
            reason += "; "
        return replace(
            self, deid_dests=frozenset(), held=held,
            hold_cause=HOLD_NO_DEIDENTIFIER,
            reason=reason + ("HELD, not sent to %s — a rule asks for de-identification "
                             "and this sender has no usable de-identifier"
                             % ", ".join(sorted(self.deid_dests))))

    def hold_message(self, who: str = "the study") -> str:
        """What to tell the operator about this decision's hold, cause and all.

        One sentence of "what is not happening" and one of "what to do about
        it". The remedy is the same either way — make the scrub possible or stop
        asking for it — but the cause is not, and a message that asserts a cause
        it cannot know is how the last round shipped 'deid.profile is off' to
        sites whose profile was on."""
        if not self.held:
            return ""
        if self.hold_cause == HOLD_NO_DEIDENTIFIER:
            cause = ("a routing rule asks for de-identification and this sender has no "
                     "usable de-identifier, so nothing can be scrubbed")
            remedy = ("Fix the de-identification settings so one can be built (the failure "
                      "is logged separately), or take 'deidentify' off the rule.")
        else:
            cause = ("a routing rule asks for de-identification and deid.profile is 'off', "
                     "so nothing can be scrubbed")
            remedy = "Turn the de-identification profile on, or take 'deidentify' off the rule."
        return ("%s: NOT sent to %s — %s. It stays in the outgoing folder (never archived, "
                "never deleted). %s" % (who, ", ".join(sorted(self.held)), cause, remedy))

    def as_dict(self) -> dict:
        return {
            "destinations": list(self.destinations),
            # What a sender will do, spelled out for every reader of this
            # payload: the dashboard drew "destinations" as delivery, which is a
            # lie the moment one of them is held.
            "sendable": list(self.sendable),
            "deidentify": sorted(self.deid_dests),
            "held": sorted(self.held),
            # Why, in one machine-readable token, so a reader that wants to
            # phrase the hold itself does not have to guess the cause out of the
            # reason string — guessing it is what put a false cause in the log.
            "hold_cause": self.hold_cause,
            "rules": list(self.rules),
            "fallback": self.fallback,
            "reason": self.reason,
            "unresolved": list(self.unresolved),
            "attributes": dict(self.attributes),
        }


def _patterns(raw: Any) -> list[str]:
    """A match value as a list of globs. '' / [] / None mean 'match anything'."""
    if raw is None:
        return []
    if isinstance(raw, (list, tuple)):
        return [str(p).strip() for p in raw if str(p).strip()]
    raw = str(raw).strip()
    return [raw] if raw else []


def _field_matches(value: str, patterns: list[str]) -> bool:
    # fnmatchcase on pre-lowered strings rather than fnmatch(): fnmatch applies
    # os.path.normcase, which on Windows also rewrites separators — routing must
    # behave identically on every OS.
    if not patterns:
        return True
    low = value.lower()
    return any(fnmatch.fnmatchcase(low, p.lower()) for p in patterns)


class Router:
    """Evaluates the rule list. Cheap to construct; safe to keep for the life of
    the watcher and re-point at fresh config each pass via :meth:`update`."""

    def __init__(self, routing_cfg: Optional[dict] = None,
                 enabled_names: Iterable[str] = (), log=None,
                 cache: Optional[HeaderCache] = None, cfg=None):
        self.log = log
        self.cache = cache if cache is not None else HeaderCache()
        self._warned: set[str] = set()
        self.enabled: tuple[str, ...] = ()
        self._enabled_set: frozenset[str] = frozenset()
        self.rules: tuple[dict, ...] = ()
        self.enabled_flag = False
        self.cfg = None
        self._deid_seen: Optional[str] = None
        self.bind(cfg)                    # before update(): the first decision needs it
        self.update(routing_cfg, enabled_names)

    @classmethod
    def from_config(cls, cfg, log=None) -> "Router":
        """A one-shot router built from a live Config (for the explain endpoint
        and any caller that does not keep one around)."""
        names = [d.get("name", d.get("host", "")) for d in cfg.enabled_destinations()]
        return cls(cfg.routing, names, log=log, cfg=cfg)

    def bind(self, cfg) -> "Router":
        """Point a long-lived router at the live Config.

        The Config OBJECT, never a copy of ``deid``: a router that outlives saves
        (the watcher's does) would otherwise be reasoning about a profile the
        operator has already changed, and the window between the save and the
        push is exactly the window a study leaves in. The sender reads
        ``cfg.deid`` from the same object in the same pass, so the two cannot
        disagree about what is being scrubbed."""
        self.cfg = cfg
        return self

    # ---- the profile half of the de-identification decision -----------------
    # `deidentify: true` on a rule says WHICH destinations get a scrubbed copy;
    # `deid.profile` says whether scrubbing happens at all ("Off — send studies
    # exactly as received"). They were read in two different places: the rules
    # here, the profile in the senders. So with the profile off and a rule asking
    # for a scrub, this module answered "de-identified" — to /api/routing/test,
    # to /api/status and to the dashboard — while the senders, finding no
    # de-identifier, forwarded the study IDENTIFIED. The operator asked for
    # de-identification, was told it was happening, and the patient's identity
    # left the building. A silent leak at least leaves an operator suspicious;
    # that combination actively stopped them checking.
    #
    # Three ways to make one answer out of the two halves:
    #
    #   * The rule wins and the profile is only a default. Rejected: it makes
    #     "off" not mean off, and every sender would then have to build a
    #     de-identifier from a config that says there is none — the same split
    #     brain, moved one layer down.
    #   * Reject the pair in config validation. The strongest answer where it
    #     applies, and it does not apply here: the profile is edited on one card
    #     and the rules on another, so "profile off AND a rule scrubs" is a STATE
    #     two valid saves arrive at, not an edit validation can refuse. Refusing
    #     it there would also mean a save that turns the profile off is rejected
    #     because of a rule the operator is on their way to deleting.
    #   * HOLD: a destination a rule asks to scrub is not sent to AT ALL while
    #     the profile is off. Chosen.
    #
    # Holding stalls delivery to that one destination and that cost is real, so
    # it is taken with both eyes open: the study is not lost (it stays in the
    # outgoing folder, it is never archived and never deleted — see fully_sent),
    # every other destination on the same study still receives it, the log says
    # so, the de-identification panel says so in the loudest state it has, and
    # ONE edit releases it — turn the profile on, or take `deidentify` off the
    # rule. Against that: forwarding identity to a node the operator believes
    # receives none is not a delivery at all, it is a disclosure, and it is not
    # undoable by any later edit.
    @property
    def deid_profile(self) -> str:
        """The live de-identification profile; ``"off"`` means nothing is scrubbed.

        A router with no Config bound reports the config default rather than
        "off": it has no way to know, and answering "off" would hold every
        de-identified route in an install that is set up perfectly. The one
        production router built without a Config is the watcher's, and
        PacsServer binds it the moment it exists (there is a test on that
        wiring, because a router that quietly went unbound would leak)."""
        cfg = self.cfg
        if cfg is None:
            return "basic"
        deid = getattr(cfg, "deid", None)
        if deid is None and isinstance(cfg, dict):
            deid = cfg.get("deid")
        return str((deid or {}).get("profile", "basic") or "basic")

    @property
    def deid_available(self) -> bool:
        """Can a rule's ``deidentify`` actually be honoured right now?"""
        return self.deid_profile != "off"

    def deid_summary(self) -> dict:
        """The config-level answer to "what is being scrubbed, and what is stuck".

        Same split as a Decision, without a file: ``destinations`` are the nodes
        rules scrub for, ``held`` the nodes a rule asks to scrub while the
        profile is off — nothing is sent to those. /api/status serves this
        verbatim so the dashboard cannot reach a different conclusion from the
        one the senders act on.

        Rules that cannot fire are not counted: routing switched off, or a rule
        naming a destination that is not enabled, means nothing is scrubbed for
        that name and nothing is held either."""
        asked: set[str] = set()
        if self.enabled_flag:
            for rule in self.rules:
                if not rule.get("deidentify"):
                    continue
                for d in (rule.get("destinations") or []):
                    name = str(d).strip()
                    if name in self._enabled_set:
                        asked.add(name)
        available = self.deid_available
        return {"profile": self.deid_profile,
                "destinations": sorted(asked) if available else [],
                "held": [] if available else sorted(asked)}

    def update(self, routing_cfg: Optional[dict], enabled_names: Iterable[str]) -> None:
        """Re-point at the current config. The warn-once memo is cleared only
        when something actually changed, so a fix is re-reported (and a standing
        misconfiguration is not re-logged every three seconds)."""
        cfg = routing_cfg or {}
        rules = tuple(r for r in (cfg.get("rules") or []) if isinstance(r, dict))
        names, seen = [], set()
        dupes = []
        for n in enabled_names:
            n = str(n or "")
            if n in seen:
                dupes.append(n)
                continue
            seen.add(n)
            names.append(n)
        # The profile is part of "something changed" even though it does not
        # live in this dict: a hold is announced once, and an operator who turns
        # the profile off after the last announcement has to hear about it.
        profile = self.deid_profile
        changed = (tuple(names) != self.enabled or rules != self.rules
                   or bool(cfg.get("enabled")) != self.enabled_flag
                   or profile != self._deid_seen)
        self.enabled = tuple(names)
        self._enabled_set = frozenset(names)
        self.rules = rules
        self.enabled_flag = bool(cfg.get("enabled"))
        self._deid_seen = profile
        if changed:
            self._warned.clear()
        # Send state, backoff and the archive gate are all keyed by destination
        # NAME, and there is no second key to fall back on: two nodes sharing a
        # name share one state slot, so the state model simply cannot say "node A
        # has it, node B does not". The senders compensate by treating the name
        # as one unit — every node behind it gets the file, and the name counts
        # as sent only when all of them accepted — which over-delivers on a
        # partial failure but can never archive behind a node that missed out.
        # That is a workaround for an unrepresentable config, so it is an error,
        # not a note: the operator has to rename one of them.
        if dupes or "" in seen:
            bad = sorted({d for d in dupes} | ({""} if "" in seen else set()))
            self._warn("dupe:" + ",".join(bad),
                       "Destinations have blank or duplicate names (%s) — send tracking "
                       "keys on the name and cannot tell those nodes apart, so each such "
                       "study is re-sent to all of them until every one accepts; give "
                       "every node a unique one"
                       % ", ".join(repr(b) for b in bad), level="error")

    # ------------------------------------------------------------------ deciding
    def route(self, path: Optional[str] = None, attrs: Optional[dict] = None) -> Decision:
        """The destinations *path* (or a pre-read *attrs*) should be sent to."""
        if attrs is None and path is not None:
            attrs = self.cache.attributes(path)
            if attrs is None:
                # A file we cannot parse is still a file somebody expects to
                # arrive. Route it the old way rather than guessing or dropping.
                self._warn("unreadable:" + os.path.abspath(path),
                           "Could not read %s for routing — sending to all enabled "
                           "destinations" % os.path.basename(path))
                return self._all(attrs={}, reason="header unreadable — routed to all destinations")
        attrs = attrs or {}
        decision, trace = self._evaluate(attrs)
        self._emit_warnings(decision, trace, path)
        return decision

    def explain(self, path: Optional[str] = None, attrs: Optional[dict] = None) -> dict:
        """Per-rule trace of one routing decision, for the dashboard. Pure: it
        logs nothing, so an operator can poke at it without filling the log."""
        parsed = True
        if attrs is None and path is not None:
            attrs = self.cache.attributes(path)
            parsed = attrs is not None
        attrs = attrs or {}
        if not parsed:
            decision = self._all(attrs={}, reason="header unreadable — routed to all destinations")
            trace = []
        else:
            decision, trace = self._evaluate(attrs)
        return {
            "file": os.path.basename(path) if path else "",
            "path": path or "",
            "parsed": parsed,
            "routing_enabled": self.enabled_flag,
            # The profile belongs in the same payload as the rules: "would this
            # study be de-identified?" is not answerable from either half alone,
            # and the dashboard used to answer it from the rules only.
            "deid_profile": self.deid_profile,
            "attributes": dict(attrs),
            "enabled_destinations": list(self.enabled),
            "rules": trace,
            "decision": decision.as_dict(),
        }

    # ------------------------------------------------------------------ internals
    def _all(self, attrs: dict, reason: str) -> Decision:
        return Decision(destinations=self.enabled, rules=(), fallback=True,
                        reason=reason, attributes=dict(attrs))

    def _evaluate(self, attrs: dict) -> tuple[Decision, list[dict]]:
        """Walk the rules. Returns the decision plus a per-rule trace (shared by
        route() and explain() so the dashboard can never disagree with what was
        actually sent)."""
        if not self.enabled_flag or not self.rules:
            why = "routing disabled" if not self.enabled_flag else "no rules configured"
            return self._all(attrs, why + " — all enabled destinations"), []

        picked: list[str] = []
        asked: set[str] = set()          # destinations a rule wants scrubbed
        matched_rules: list[str] = []
        unresolved: list[str] = []
        trace: list[dict] = []
        stopped = False

        for i, rule in enumerate(self.rules):
            name = str(rule.get("name") or f"rule #{i + 1}")
            if stopped:
                trace.append({"index": i + 1, "name": name, "matched": False,
                              "action": "not evaluated (a previous rule stopped)",
                              "fields": [], "destinations": [], "unresolved": []})
                continue
            ok, fields, bad_keys = _match_rule(rule, attrs)
            row = {"index": i + 1, "name": name, "matched": ok, "fields": fields,
                   "destinations": [], "unresolved": [], "action": ""}
            if bad_keys:
                row["unknown_match_keys"] = bad_keys
                # An unrecognised match key cannot be evaluated, so the rule is
                # skipped rather than treated as "matches anything" — a typo must
                # not silently widen a rule to every study in the department.
                row["action"] = "skipped (unknown match key: %s)" % ", ".join(bad_keys)
                unresolved.append("%s -> unknown match key %s" % (name, ", ".join(bad_keys)))
                trace.append(row)
                continue
            if not ok:
                row["action"] = "no match"
                trace.append(row)
                continue

            wanted = [str(d).strip() for d in (rule.get("destinations") or []) if str(d).strip()]
            if not wanted:
                # A matched rule with no destinations is a FILTER, not a sink: it
                # falls through to the next rule. "stop" is deliberately ignored
                # here, because honouring it would mean "match this study and
                # send it nowhere", which is the one outcome this module exists
                # to prevent.
                row["action"] = "matched, no destinations — dropping through"
                trace.append(row)
                continue

            resolved = [d for d in wanted if d in self._enabled_set]
            missing = [d for d in wanted if d not in self._enabled_set]
            for d in missing:
                unresolved.append("%s -> %s" % (name, d))
            row["unresolved"] = missing
            if not resolved:
                # Every node this rule names is gone or disabled. Continuing to
                # the next rule (or, failing that, to the all-destinations
                # fallback) is the only option that keeps the study moving; a
                # rule that resolves to nothing must not be able to consume it.
                row["action"] = "matched, but no named destination is enabled — dropping through"
                trace.append(row)
                continue

            matched_rules.append(name)
            for d in resolved:
                if d not in picked:
                    picked.append(d)
            if rule.get("deidentify"):
                # De-identification is per-destination but decided per-rule, and
                # the union is taken in the safe direction: if any rule that
                # routes to a node asked for scrubbing, that node gets scrubbed
                # — and if the profile cannot scrub, that node gets nothing.
                # Another rule routing to the same node without `deidentify`
                # does not buy it an identified copy.
                asked.update(resolved)
            row["destinations"] = resolved
            if rule.get("stop"):
                row["action"] = "matched — stop"
                stopped = True
            else:
                row["action"] = "matched"
            trace.append(row)

        if not picked:
            return Decision(destinations=self.enabled, rules=(), fallback=True,
                            reason="no rule matched — all enabled destinations",
                            unresolved=tuple(unresolved), attributes=dict(attrs)), trace

        # Ordered by the destinations list, not by rule order, so two files that
        # end up at the same nodes always report the same route string.
        ordered = tuple(n for n in self.enabled if n in set(picked))
        # The one place the two halves of the de-identification decision are put
        # together (see deid_profile above). Every reader downstream — the
        # watcher, the manual send, the explain endpoint, /api/status, the
        # dashboard — takes the answer from here rather than re-deriving it.
        available = self.deid_available
        deid = frozenset(asked) if available else frozenset()
        held = frozenset() if available else frozenset(asked)
        reason = "matched: " + ", ".join(matched_rules)
        if held:
            reason += ("; HELD, not sent to %s — a rule asks for de-identification "
                       "and deid.profile is 'off'" % ", ".join(sorted(held)))
            # The trace is what the dashboard draws rule by rule, so the rule
            # that caused the hold has to carry it: a row still reading
            # "matched → Research" would say the study went there.
            for row in trace:
                blocked = [d for d in row["destinations"] if d in held]
                if blocked:
                    row["held"] = blocked
                    row["action"] += (" — HELD, not sent to %s (deid.profile is 'off')"
                                      % ", ".join(blocked))
        return Decision(destinations=ordered, deid_dests=deid, held=held,
                        rules=tuple(matched_rules), fallback=False,
                        reason=reason, hold_cause=HOLD_PROFILE_OFF if held else "",
                        unresolved=tuple(unresolved), attributes=dict(attrs)), trace

    def _emit_warnings(self, decision: Decision, trace: list[dict], path) -> None:
        if not self.log:
            return
        who = os.path.basename(path) if path else "study"
        for item in decision.unresolved:
            self._warn("unresolved:" + item,
                       "Routing rule %s names a destination that does not exist or is "
                       "disabled — that rule cannot deliver anything" % item)
        if decision.held and decision.hold_cause == HOLD_PROFILE_OFF:
            # Once per config generation (update() clears the memo when the rules
            # or the profile move), because this condition does not clear by
            # itself: nothing retries a held study and no timer releases it. It
            # is an error, not a warning — the operator asked for
            # de-identification and studies are piling up in the outgoing folder
            # because it cannot be done.
            #
            # Only this cause: a decision straight out of route() can hold for no
            # other reason, and the sender's own de-identifier — the second cause
            # — is not visible from here. Naming a cause this module cannot see is
            # how a hold came to be reported as "deid.profile is 'off'" at sites
            # whose profile was on; whoever holds the de-identifier says that one.
            self._warn("deid-held:" + ";".join(sorted(decision.held)),
                       "A routing rule asks for de-identification but deid.profile is "
                       "'off' — nothing can be scrubbed, so %s is NOT being sent to %s. "
                       "The studies stay in the outgoing folder (never archived, never "
                       "deleted). Turn the de-identification profile on, or take "
                       "'deidentify' off the rule."
                       % (who, ", ".join(sorted(decision.held))), level="error")
        # The loudest case among the routing-only failures: the rules had
        # something to say about this file and none of it was usable, so it went
        # out on the pre-routing fan-out. That is safe but it is not what the
        # operator configured.
        if decision.fallback and decision.unresolved:
            self._warn("fellback:" + ";".join(decision.unresolved),
                       "%s fell back to all %d enabled destination(s) because its "
                       "routing rules resolved to nothing" % (who, len(self.enabled)))

    def _warn(self, key: str, message: str, level: str = "warn") -> None:
        if not self.log or key in self._warned:
            return
        self._warned.add(key)
        getattr(self.log, level)(message, kind="route")


def _match_rule(rule: dict, attrs: dict) -> tuple[bool, list[dict], list[str]]:
    """(matched, per-field trace, unknown match keys) for one rule."""
    match = rule.get("match") or {}
    if not isinstance(match, dict):
        return False, [], ["<match is not an object>"]
    fields: list[dict] = []
    unknown: list[str] = []
    ok = True
    for raw_key, raw_val in match.items():
        key = _ALIASES.get(str(raw_key).lower(), str(raw_key).lower())
        if key.startswith("_"):
            continue                      # "_comment" and friends are documentation
        if key not in _MATCH_FIELDS:
            unknown.append(str(raw_key))
            continue
        pats = _patterns(raw_val)
        if not pats:
            continue                      # absent/empty matches anything
        value = _text(attrs.get(key, ""))
        hit = _field_matches(value, pats)
        fields.append({"field": key, "patterns": pats, "value": value, "matched": hit})
        ok = ok and hit
    return (ok and not unknown), fields, unknown


# --------------------------------------------------------------- send bookkeeping
# The archive pass moves a study only once every instance is "fully sent", and
# before routing that meant "accepted by every enabled destination". Under
# routing a file legitimately owes a send to a SUBSET, so the target set has to
# be per-file, recorded at send time, and read back at archive time. Getting it
# wrong is not cosmetic: compute it too wide and the outgoing folder never
# drains, too narrow and a study is archived while a node is still owed it.
# These two helpers are the whole contract; the watcher should not open-code it.

def resolve_all(dests: Iterable, names: Iterable[str]) -> list:
    """Every destination object whose ``name`` appears in *names*, in route order.

    Deliberately not a ``{d.name: d}`` lookup. Nothing stops a hand-edited
    config.json from carrying two enabled nodes under one name, and a name->node
    map keeps only the last of them: the other never gets a C-STORE, the send
    state records the name as delivered anyway, and the archive pass moves — or,
    with on_success=delete, destroys — a study a node never received. Config
    validation rejecting duplicates is a second line of defence, not this one."""
    by_name: dict[str, list] = {}
    for d in dests:
        by_name.setdefault(d.name, []).append(d)
    out = []
    for n in names:
        out.extend(by_name.get(n, ()))
    return out


def record_route(entry: dict, decision: Decision) -> bool:
    """Stamp a SendState entry with the route this file was decided to take.

    Must be called BEFORE the sends, on every pass that evaluates a file, and
    the entry must be persisted even when nothing is due — an entry with no
    ``route`` is never considered fully sent, so an unstamped file would sit in
    the outgoing folder forever. Returns True if the entry changed.

    Any destination the entry was PINNED to is unioned in: a pin is a delivery
    the caller has already promised (emergency hold-and-forward owes the primary
    every held instance), and the rule engine must not be able to route around a
    promise — a ``stop`` rule pointing somewhere else would otherwise send the
    held copy to a teaching archive and let the primary's copy be deleted.

    A destination the decision HELD is kept out of the route, pin or no pin: the
    route is the list a sender walks, and a held destination is precisely one
    that must not be dialled. It is recorded under ``held`` instead, which is
    what stops fully_sent() reading the shorter route as a completed delivery —
    dropping the name silently is how a study gets archived having never gone
    anywhere. A pin loses to a hold for the same reason it beats a rule: a
    promise to deliver is not a permission to disclose."""
    held = sorted(decision.held)
    route = [d for d in decision.destinations if not decision.is_held(d)]
    for pinned in entry.get("pin") or []:
        if pinned not in route and not decision.is_held(pinned):
            route.append(pinned)
    deid = sorted(decision.deid_dests)
    changed = (entry.get("route") != route or entry.get("deid") != deid
               or (entry.get("held") or []) != held)
    entry["route"] = route
    entry["deid"] = deid
    # Only when there is something to hold: an entry written before this existed
    # must not read as changed on the first pass after an upgrade (that would
    # re-enqueue every file in the outgoing folder for indexing).
    if held:
        entry["held"] = held
        # The CAUSE travels with the names, because there is now more than one
        # and they do not look different from the outside. Anything that reads
        # entry["held"] back and explains it to an operator — the stuck panel
        # does — would otherwise have to guess, and a guessed cause is how a
        # hold came to be reported as "deid.profile is 'off'" at sites whose
        # profile was on. Deliberately outside `changed`: the cause moving is
        # not the file moving, and re-indexing on it would be churn.
        entry["hold_cause"] = decision.hold_cause
    else:
        entry.pop("held", None)
        entry.pop("hold_cause", None)
    return changed


def wanted_from(entry: Optional[dict], enabled_names: Iterable[str]) -> Optional[set]:
    """The destinations this file still has to reach: its recorded route,
    intersected with what is enabled *now*.

    None means "not routed yet" — the caller must treat that as not-done rather
    than as an empty requirement. Intersecting with the live enabled set is what
    lets an operator unblock a study by deleting a dead node; without it the
    study would be pinned in the outgoing folder for good."""
    if not entry:
        return None
    route = entry.get("route")
    if route is None:
        return None
    return set(route) & set(enabled_names)


def fully_sent(entry: Optional[dict], enabled_names: Iterable[str],
               stat: Optional[tuple] = None) -> bool:
    """True when every destination this file was routed to (and that is still
    enabled) has accepted it, and there was at least one. A file that has not
    been routed yet is never 'done' — archiving something we have not even
    looked at is exactly the silent-loss failure this whole module is written
    against — and neither is a file that owes NOBODY.

    An empty requirement is the inversion this module exists to prevent, and it
    is the one bare set algebra gets backwards: ``set().issubset(anything)`` is
    True, so "every destination it owes has accepted it" reads as done for a
    study that reached no node at all. That is not a hypothetical shape — it is
    what a route recorded under a destination the operator then renamed away
    intersects down to. Not routed and routed-to-nothing are both "not done";
    over-holding costs the operator a folder that will not drain (and says so
    in the stuck panel), under-sending costs an image.

    *stat* is the file's live ``(size, mtime)``. Pass it whenever the answer
    decides whether the file is archived or deleted: an entry describes the
    BYTES it was recorded against, and a file rewritten under the same name owes
    a fresh send of its new content. Judging the new bytes on the old entry
    archives them unsent — under on_success=delete, destroys them — in the
    window before the stability gate re-stabilises the file."""
    if stat is not None and (not entry or entry.get("size") != stat[0]
                             or entry.get("mtime") != stat[1]):
        return False
    if entry and entry.get("held"):
        # A destination is being withheld because a rule asks for a scrub the
        # profile cannot perform. The file owes it, so the file is not done —
        # without this the hold would read as "routed nowhere and therefore
        # finished", and the study would be archived (or with on_success=delete,
        # destroyed) having never reached the node it was routed to.
        return False
    need = wanted_from(entry, enabled_names)
    if not need:
        return False    # None = never routed; set() = owed to nobody living
    return need.issubset(set((entry or {}).get("sent", [])))
