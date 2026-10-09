"""Orchestrator — owns the shared Config + LogBuffer and the two workers
(Storage SCP receiver and the folder watcher).  Both the CLI and the web
dashboard drive the app exclusively through this object."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import threading
import time
from typing import Optional

from . import __version__
from .audit import AuditLog
from .config import Config
from . import users
from .emergency import ACTIVE as EMG_ACTIVE, EmergencyController, RECOVERING as EMG_RECOVERING
from .index import InstanceIndex
from .logbuf import LogBuffer
from . import mwl
from .mwl import MwlSCP
from .updates import UpdateCheck
from .notify import Notifier
from .print_scp import PrintSCP
from .qr import QrSCP
from . import ris
from .caught import CaughtStore, split_by_addressee
from .ris import OrderStore, RisListener, _utc_stamp
from .scp import StorageSCP
from .scu import Destination, SendResult, c_echo
from .watcher import FolderWatcher

# The build that offers the service chooser. It is reported next to the marker
# so the dashboard can say WHICH engine ran setup; it is deliberately never
# compared against the marker — re-offering setup because the version moved
# would be a migration, and there is nothing to migrate from yet.
SETUP_VERSION = __version__

# What the setup chooser may switch on, as (post key, config section).
SETUP_SERVICES = (("receiver", "scp"), ("watcher", "scu"), ("printer", "print"),
                  ("ris", "ris"), ("mwl", "mwl"), ("qr", "qr"))

# How long an index size readout is reused. stats() is three full-table
# aggregates and /api/status is polled every two seconds, so an archive of a few
# hundred thousand instances would spend its life counting itself. These are a
# size readout, not a live counter — a few seconds stale is invisible.
_INDEX_STATS_TTL = 15.0


class _SendConfig:
    """The configuration ONE manual send runs under, frozen when it starts.

    Two objects have to agree about de-identification for a send to be honest:
    the Router, which decides which destinations get a scrubbed copy, and the
    Deidentifier, which performs the scrub. The Router reads ``deid.profile``
    live off the Config it is bound to; a Deidentifier is built once and is
    ``None`` when the profile was off. Bind the Router to the LIVE config and a
    profile switched on mid-send makes the two disagree: the router starts
    routing to a node it now reports as scrubbed for, the de-identifier built
    before the flip is still None, and the rest of the study goes out identified
    to exactly that node — while /api/status calls it de-identified. That flip is
    not a hypothetical either, it is the remediation the hold message instructs.

    So a manual send does not observe configuration changes at all. It is one
    action an operator started under settings they could see, it finishes under
    those, and an edit takes effect the next time they press Send. The watcher
    answers the same question the other way — it abandons the pass mid-flight —
    and that is right for the watcher and wrong here: it has a next pass to pick
    the files back up and a manual send has none, so abandoning would drop the
    rest of the study with nothing to resume it. Rebuilding the de-identifier per
    instance was the third option and it is the worst of them: it half-applies a
    save by construction, shipping one instance of a study under the old settings
    and its neighbour under the new, with the destination list and the TLS
    context still stale around them.

    What freezing does NOT buy is silence. It closed the leak in one direction
    (a profile switched ON mid-send no longer routes to a node the frozen
    de-identifier cannot scrub for) and opened a quieter one in the other: a
    rule that GAINS ``deidentify: true`` while a Send is in flight delivered the
    rest of the study identified, with nothing said on any channel, while
    /api/status reported that destination as scrubbed-for from the instant of
    the save. So the send carries its own ``signature`` and compares it against
    the live config as it goes — see ``_deid_answers`` and the stale check in
    send_study for what it does about a change it finds.
    """

    __slots__ = ("deid", "routing", "signature")

    def __init__(self, cfg):
        import copy
        # Copies, not references: apply_config assigns freshly merged dicts, but
        # a frozen view that aliased the live ones would still be a live read on
        # any path that edits in place, which is the whole thing being prevented.
        self.deid = copy.deepcopy(cfg.deid)
        self.routing = copy.deepcopy(cfg.routing)
        self.signature = _config_signature(cfg)


def _config_signature(cfg) -> str:
    """Fingerprint of the two sections a send's honesty depends on.

    The cheap half of the stale check: identical means nothing that could move
    a de-identification answer has been saved, and the expensive comparison is
    skipped. ``default=str`` so a value nothing has validated yet — this is
    asked once per instance, off the LIVE config — can never raise inside a
    send.
    """
    import json
    return json.dumps([cfg.deid, cfg.routing], sort_keys=True, default=str)


def _service_inputs(data: dict, name: str) -> list:
    """What a listener is BUILT from: the config it reads once, at start. A
    save that changes none of it has nothing to restart that listener for.

    `enabled` is left out — the flag is on/off, handled as its own transition.
    The receiver and Q/R hold the index object, which a change to the index's
    switch or path replaces. The RIS listener reads only its socket settings at
    start; match_on and store_dir are re-pointed live."""
    def sect(key):
        block = data.get(key)
        return {k: v for k, v in block.items() if k != "enabled"} if isinstance(block, dict) else {}
    idx = data.get("index") if isinstance(data.get("index"), dict) else {}
    index = [bool(idx.get("enabled", True)), str(idx.get("path", "") or "")]
    if name == "receiver":
        return [sect("scp"), index]
    if name == "qr":
        return [sect("qr"), index]
    if name == "ris":
        r = sect("ris")
        return [{k: r.get(k) for k in ("bind", "port", "allowed_hosts")}]
    return [sect({"printer": "print"}.get(name, name))]


def _deid_answers(router, names) -> dict:
    """What de-identification each destination is PROMISED, one string per name.

    The comparison key for "did the answer move under an in-flight send". Built
    through the same ``_settled_deid()`` /api/status serves, so the send and the
    dashboard cannot reach different conclusions about what changed, and it
    folds in the settings that decide what a scrub REMOVES (the profile itself
    and the two keep flags): half a study scrubbed under 'basic' and half under
    'strict' is two different promises inside one study, and the operator who
    tightened the profile mid-send is the one who most needs the rest of it to
    not go out under the old one. Deliberately NOT deid.prefix or deid.secret —
    those change what a pseudonym looks like, not what leaves the building, and
    a frozen send is right to keep one stem across the whole study.

    Settled rather than summarised, because the promise it records has to be the
    promise the SEND keeps: a profile that is on with nothing buildable behind it
    holds, so recording "scrub" for that name would leave a repaired config
    reading as no change at all — the send would go on withholding under the
    frozen answer while /api/status reported the node scrubbed-for, and nothing
    would tell the operator to press Send again.
    """
    summary = _settled_deid(router.deid_summary(), router.cfg)
    scrubbed, held = set(summary["destinations"]), set(summary["held"])
    deid = getattr(router.cfg, "deid", None) or {}
    how = "scrub:%s:%s:%s" % (summary["profile"], bool(deid.get("keep_private")),
                              bool(deid.get("keep_dates")))
    return {n: (how if n in scrubbed else ("hold" if n in held else "clear")) for n in names}


def _buildable_scrubber(cfg, log=None):
    """The de-identifier a sender would build from *cfg* right now, or None.

    Contained exactly the way the watcher contains its own build, and for the
    same reason: ``Config.load()`` does not validate, so a config that is in
    force can still be one nothing can be built from (``deid.prefix`` as a JSON
    number is the measured example). A read-only status call has to REPORT that
    state, never raise on it — a dashboard that 500s is a dashboard that cannot
    tell anybody what is wrong.
    """
    from .deid import Deidentifier
    try:
        return Deidentifier.from_config(cfg, log)
    except Exception:
        return None


def _settled_deid(summary: dict, cfg) -> dict:
    """A ``Router.deid_summary()`` with the OTHER half of the answer folded in.

    ``deid_summary()`` answers the config half alone: which nodes rules ask a
    scrub for, and which of them are held because ``deid.profile`` is 'off'. It
    cannot answer the second half, because a Router holds no de-identifier — and
    a profile that is ON with nothing that can be BUILT to perform it scrubs
    exactly as much as a profile that is off. The summary called those nodes
    de-identified-for and every read-only surface repeated it: /api/status listed
    the node under "de-identified for" while the senders were holding it, which
    is the sentence this project has now had to unsay four times.

    So the two halves are put together here, by the same method the senders use
    — ``Decision.honoured_by``, which can only move a name out of the scrubbed
    set by putting it into the held one. That there is ONE way to combine them is
    the whole point; a second derivation beside it is what produced the four
    rounds. ``hold_cause`` rides along so a reader can phrase the hold without
    guessing which of the two it is looking at.

    *cfg* is whatever the summary was computed against — the live Config for the
    dashboard, a frozen _SendConfig for a send in flight — because "can one be
    built" has to be asked of the same settings the rest of the answer came from.
    """
    from . import routing
    asked = set(summary["destinations"]) | set(summary["held"])
    # A config-level decision: no file, so no rules and no route — only the
    # de-identification half, which is the half a summary describes.
    view = routing.Decision(
        destinations=tuple(sorted(asked)),
        deid_dests=frozenset(summary["destinations"]),
        held=frozenset(summary["held"]),
        hold_cause=routing.HOLD_PROFILE_OFF if summary["held"] else "")
    scrubber = _buildable_scrubber(cfg)
    settled = view.honoured_by(scrubber)
    return {"profile": summary["profile"],
            "destinations": sorted(settled.deid_dests),
            "held": sorted(settled.held),
            # "" when nothing is held. Carried rather than left to the reader to
            # infer from `profile`: with the profile ON and a hold in force,
            # `profile` is precisely the field that leads to the wrong cause.
            "hold_cause": settled.hold_cause}


def _deid_state(cfg) -> dict:
    """The settled de-identification answer for a whole Config — the /api/status
    block, and the only lens a read-only surface should look through."""
    from . import routing
    return _settled_deid(routing.Router.from_config(cfg, None).deid_summary(), cfg)


def _settled_explain(payload: dict, cfg) -> dict:
    """A ``Router.explain()`` payload with the sender's half folded in.

    Same gap as the summary, one endpoint along: explain() answers from the rules
    and ``deid.profile``, because a Router holds no de-identifier, so a dry run
    over a study that would be HELD for want of one still reported it
    "de-identified for" and sendable. This is the screen an operator checks
    BEFORE letting a research forward go out, so it is the last place that may
    describe a scrub that will not happen.

    Settled through ``Decision.honoured_by`` — the same door the senders use, on
    a Decision rebuilt from the payload it just produced — rather than by asking
    the question a second way here.
    """
    from . import routing
    d = payload.get("decision") or {}
    before = routing.Decision(
        destinations=tuple(d.get("destinations") or []),
        deid_dests=frozenset(d.get("deidentify") or []),
        held=frozenset(d.get("held") or []),
        hold_cause=str(d.get("hold_cause", "") or ""),
        reason=str(d.get("reason", "") or ""))
    scrubber = _buildable_scrubber(cfg)
    after = before.honoured_by(scrubber)
    if after is before:
        return payload                  # nothing to settle: the answer stands
    out = dict(payload)
    settled = dict(d)
    settled["sendable"] = list(after.sendable)
    settled["deidentify"] = sorted(after.deid_dests)
    settled["held"] = sorted(after.held)
    settled["hold_cause"] = after.hold_cause
    settled["reason"] = after.reason
    out["decision"] = settled
    # The trace is drawn rule by rule, so the rule that caused the hold has to
    # carry it too — a row still reading "matched → Research" says the study went
    # there, which is the same false reassurance in smaller print.
    rows = []
    for row in (payload.get("rules") or []):
        blocked = [n for n in (row.get("destinations") or []) if n in after.held]
        if blocked and not row.get("held"):
            row = dict(row)
            row["held"] = blocked
            row["action"] = "%s — HELD, not sent to %s (no de-identifier could be built)" % (
                row.get("action", ""), ", ".join(blocked))
        rows.append(row)
    out["rules"] = rows
    return out


def _order_brief(order: Optional[dict], fields: tuple) -> Optional[dict]:
    """Trim an order down to the handful of fields a dashboard line shows. A
    whole order carries the patient's full identity plus 16 scheduling fields,
    and /api/status is polled every two seconds — it gets what it draws."""
    if not order:
        return None
    return {k: str(order.get(k, "") or "") for k in fields}


def _dcm_today() -> str:
    from datetime import date
    return date.today().strftime("%Y%m%d")


def _addressed(probe: dict, station_aet: str) -> dict:
    """One probe row split by who its items are addressed to.

    Through caught.split_by_addressee(), which is the same predicate CaughtStore
    counted the row with — asked a second time rather than answered a second
    way. That distinction is the whole repair: "addressed to nobody" has two
    spellings on the wire (a blank from a third-party provider, ``UNASSIGNED``
    from this appliance's own Type 1-safe worklist), and while only some readers
    knew the second one, the same item was a scheduled order to the row and an
    unaddressed one to the sentence printed over it.

    Recounted here rather than simply read off the row because a round filed
    before the second spelling existed still carries the old tallies; its items
    are stored verbatim, so they can be. A row that came back EMPTY has nothing
    to recount, and its stored tallies (zeros, for an empty answer) stand.
    """
    items = probe.get("items") or []
    if items:
        return split_by_addressee(items, station_aet)
    return {k: int(probe.get(k) or 0)
            for k in ("for_this_station", "for_nobody", "for_someone_else")}


def _probe_verdict(rnd: dict) -> str:
    """Read the four answers and say, in one sentence, where the fault is.

    The operator can read the table themselves; this is the line that stops them
    having to. It deliberately never says "working" on a count alone — an order
    addressed to nobody reaches every modality, so a scanner seeing only those
    is a scanner that is not being scheduled, however healthy the number looks.
    """
    p = rnd.get("probes", [])
    if len(p) < 5:
        return "probe incomplete"
    a, b, c, d, e = p[0], p[1], p[2], p[3], p[4]
    if not a["ok"]:
        # The association itself failed: nothing downstream of it means anything.
        return f"Could not reach the worklist source — {a['message']}. Check the host, port and its called AE title before reading anything else."
    # Every row is read through the one predicate, not just the first: a row
    # whose unaddressed orders were filed as somebody else's made this sentence
    # name stations that do not exist, and send the operator to edit a station
    # field the order has not got.
    station = str(rnd.get("station_aet", "") or "")
    sa, sb, sc, sd = (_addressed(row, station) for row in (a, b, c, d))
    # Read narrowest first, and relax one key at a time. The first question that
    # STARTS returning orders this scanner would see is the key that is wrong.
    if sa["for_this_station"] > 0:
        return f"Working. {sa['for_this_station']} order(s) addressed to this modality for today, and it would see them."
    if a["count"] > 0 and sa["for_nobody"] == a["count"]:
        return f"The {a['count']} order(s) coming back are addressed to NOBODY, so every modality sees them. Nothing is scheduled to this one specifically."
    if b["ok"] and sb["for_this_station"] > 0:
        return f"The MODALITY key is the problem. Drop it and {sb['for_this_station']} order(s) for this station appear; the orders are not tagged with the modality this scanner asks for."
    # Same key, same repair, and the orders behind it are unaddressed: the
    # scanner WOULD see them once the modality key stops hiding them, so naming
    # the key is the useful half — but an unaddressed order is still scheduled
    # to nothing, and this line may no more call that "for this station" than
    # the branch above may call it working.
    if b["ok"] and sb["for_nobody"] > 0:
        return f"The MODALITY key is the problem. Drop it and {sb['for_nobody']} order(s) appear — addressed to NOBODY, so every modality would see them, but none is assigned to this one. The orders are not tagged with the modality this scanner asks for."
    if c["ok"] and sc["for_this_station"] > 0:
        return f"Orders exist for this modality but not for today ({sc['for_this_station']} on other dates). Check the date the scanner asks for, and the clock on both machines."
    if c["ok"] and sc["for_nobody"] > 0:
        return f"Orders exist on other dates ({sc['for_nobody']}), addressed to NOBODY rather than to this station. Check the date the scanner asks for, and the clock on both machines."
    if d["ok"] and d["count"] > 0:
        # Named one at a time, and only when there are any: "addressed to other
        # stations" about orders addressed to nobody is the wrong repair told in
        # a confident voice. This is also the one branch that may NOT add "so
        # every modality sees them" — the station key was dropped to ask it, so
        # nothing here shows that an answer naming this station would carry
        # them, and a provider stricter than ours would withhold them.
        named = []
        if sd["for_someone_else"]:
            named.append(f"{sd['for_someone_else']} addressed to other stations")
        if sd["for_nobody"]:
            named.append(f"{sd['for_nobody']} addressed to no station at all")
        return (f"The RIS has {d['count']} order(s) for today, but none for this station"
                + (f" — {' and '.join(named)}." if named else
                   " and none addressed to any station.")
                + " The order is not being assigned to this AE title.")
    if e["ok"] and e["count"] > 0:
        return f"Nothing for today at all; {e['count']} order(s) exist on other dates."
    return "The worklist source answered, and has nothing at all. The orders are not reaching the RIS."


class PacsServer:
    # dev_peer is keyword-only and defaulted so every other command
    # (receive/send/print/ris/mwl/qr) and every existing caller is untouched:
    # only `pacs serve --dev-peer` passes it.
    def __init__(self, cfg: Config, *, dev_peer: bool = False):
        self.cfg = cfg
        # When this process started: the origin for uptime and for the counters
        # of objects that outlive a save (the watcher is built once, here).
        self.started_at = time.time()
        self.update_check = UpdateCheck(__version__)
        # Counter origins for the services this object REBUILDS on a Start or
        # on a save that changes them (RIS/worklist): their tallies zero with
        # the new object, so each is stamped where it is constructed and
        # reported next to its counters. The printer is the exception — its
        # tallies are carried into the new object, so its origin is stamped
        # once. StorageSCP carries its own started_at.
        self._counter_since: dict[str, float] = {}
        self.log = LogBuffer(log_dir=cfg.logs_dir)
        # Config.load() does not validate, on purpose (its comment argues why:
        # a PACS that refuses to start is a PACS the operator cannot fix). The
        # cost of that decision is a hand-edited config.json used unvalidated
        # and unremarked, so it is remarked HERE — the one place that has both
        # the document and somewhere to say it. It never raises: this is a note
        # about a config that is already in use, not a gate in front of it.
        self.config_problem = ""
        try:
            from .config import validate
            validate(cfg.data)
        except ValueError as exc:
            self.config_problem = str(exc)
        except Exception:
            pass                    # a checker that itself breaks is not news the operator can use
        if self.config_problem:
            self.log.warn(
                f"{cfg.path} would be REFUSED if it were saved from the dashboard: "
                f"{self.config_problem} — it is being used as it stands. Fix it in Settings "
                f"(the next Save will not go through until you do) or in the file.",
                kind="config",
            )
        # The audit trail. Opened here rather than lazily on first record so a
        # directory that cannot be created is reported at startup, next to the
        # config problem above, instead of at the moment somebody deletes a
        # study and the one record that mattered is the one that failed.
        acfg = cfg.audit
        self.audit = AuditLog(
            cfg.resolved("audit", "dir"),
            enabled=bool(acfg.get("enabled", True)),
            max_bytes=int(acfg.get("max_bytes", 8388608) or 0),
            log_reads=bool(acfg.get("log_reads", False)),
            fsync=bool(acfg.get("fsync", True)),
            log=self.log,
        ).open()
        if self.audit.broken:
            self.log.warn(
                f"The audit trail is not being written: {self.audit.broken}. "
                f"The PACS is running normally, but nothing is recording who does what.",
                kind="audit")
        # Reads its config live, so an operator turning webhooks or e-mail on in
        # Settings gets them without a restart. Started lazily on the first
        # event rather than here: an appliance with notification off should not
        # be carrying a worker thread for it.
        self.notifier = Notifier(cfg, log=self.log, audit=self.audit)
        self._lock = threading.Lock()
        self.scp: Optional[StorageSCP] = None
        self.print_scp: Optional[PrintSCP] = None
        self.ris: Optional[RisListener] = None
        self.mwl_scp: Optional[MwlSCP] = None
        # True while the bound worklist exists only because something needed
        # serving — an emergency, or an order typed during one that is still
        # open — rather than because configuration or an operator asked for it.
        # It is what release_worklist() needs and the emergency controller's own
        # ``_mwl_ours`` cannot supply: resume() clears that flag on the way out,
        # deliberately, so by the time the last stranded order is finally closed
        # nothing downstream remembers whose worklist this was. Set by the two
        # callers that bind such a worklist — EmergencyController.activate() and
        # sync_worklist() — and by nobody else; see start_mwl() for why it is
        # not a default.
        self.mwl_for_orders = False
        self.qr_scp: Optional[QrSCP] = None
        # The instance index is a cache in front of the stored files — QR and
        # DICOMweb answer out of it, nothing else depends on it, and losing it
        # costs a rescan rather than an image. None when it is switched off, so
        # every consumer has to say what it does without one.
        self.index: Optional[InstanceIndex] = None
        self._index_thread: Optional[threading.Thread] = None
        self._index_stop: Optional[threading.Event] = None
        self._index_stats_at = 0.0
        self._index_stats: dict = {}
        self._build_index()
        # Set by the web layer when it registers the DICOMweb blueprint; status()
        # reports its counters when it is there and zeroes when it is not.
        self.dicomweb = None
        # The disposable second archive, or None. Only `pacs serve --dev-peer`
        # passes the flag, and it cannot be reached over HTTP: a config key
        # would be editable through POST /api/config, so an admin token on a
        # deployed appliance could switch on "spawn a second archive".
        # Immutable for the life of the process on purpose — a restart is the
        # only way to change it, and that is the property the whole feature
        # rests on. Constructing it allocates nothing: no temp directory, no
        # thread, no disk walk, so the flag costs nothing until it is used.
        self.dev_peer = None
        if dev_peer:
            from .devpeer import DevPeer      # kept off the import path of every other command
            self.dev_peer = DevPeer(self, self.log)
        # The order store is always live (manual entry works even with the HL7
        # listener stopped); the listener is an optional front door onto it.
        self.orders = OrderStore(
            store_dir=cfg.resolved("ris", "store_dir"),
            log=self.log,
            match_on=cfg.ris.get("match_on", "accession"),
            site_modalities=lambda: list(self.cfg.ris.get("modalities") or []),
        )
        # Deliberately NOT the order store. mwl.py serves every open order in
        # that one, so a caught item filed there would be handed back out to
        # this department's modalities. See pacs/caught.py.
        self.caught = CaughtStore(store_dir=cfg.resolved("ris", "store_dir"), log=self.log)
        self.watcher = FolderWatcher(cfg, self.log, index=self.index)
        # The watcher's router outlives every save, and it is the only router in
        # the process built without a Config. Bind it to the live one HERE, next
        # to the construction, so its routing decisions read the same
        # deid.profile the sender does: unbound, it would assume scrubbing is
        # available and hand back decisions saying "de-identified" about studies
        # the sender forwards untouched. Binding the object (not a copy of
        # cfg.deid) is what keeps the two in step across a save — self.cfg is
        # never reassigned, apply_config replaces cfg.data underneath it.
        self.watcher.router.bind(cfg)
        self.emergency = EmergencyController(self, self.log)
        # Said once per process: hold-and-forward with nothing flagged as the
        # primary has no delivery it can promise (see _queue_for_forward).
        self._warned_no_primary = False
        # Manual sends whose de-identification promise was replaced while they
        # were in flight (see send_study). Its own lock: a send thread must not
        # queue behind a service start/stop to record a note, and status() must
        # not be able to read the list half-written.
        self._stale_sends: list = []
        self._stale_lock = threading.Lock()

    # ---- instance index ----------------------------------------------------
    def _index_roots(self) -> dict:
        """The three trees the index covers, as {group: root} — the same groups
        _group_root resolves, so a row's group answers "which browser tab"."""
        return {
            "received": self.cfg.resolved("scp", "storage_dir"),
            "sent": self.cfg.resolved("scu", "sent_dir"),
            "outgoing": self.cfg.resolved("scu", "watch_dir"),
        }

    def _build_index(self) -> None:
        """(Re)create the index object for the current config. Never starts the
        writer or a rescan — start_index() does that, so constructing a
        PacsServer stays free of threads and disk walks."""
        if not self.cfg.index.get("enabled", True):
            self.index = None
            return
        path = self.cfg.resolved("index", "path") or ":memory:"
        self.index = InstanceIndex(path, log=self.log)

    def start_index(self) -> None:
        """Bring the index up: background writer on so the C-STORE path hands
        off a row instead of waiting on sqlite, plus (when configured) one
        reconciliation walk of the storage roots. The walk runs on its own
        thread — a cold archive takes minutes and nothing may wait on it."""
        with self._lock:
            if self.index is None:
                return
            self.index.start()
            if not self.cfg.index.get("rescan_on_start", True):
                return
            if self._index_thread and self._index_thread.is_alive():
                return
            # Fresh Event per run: a straggler from a timed-out join must see
            # ITS cancel flag, never the next run's.
            stop = threading.Event()
            t = threading.Thread(target=self._rescan_run, args=(self.index, stop),
                                 name="pacs-index-scan", daemon=True)
            self._index_stop, self._index_thread = stop, t
            t.start()

    def stop_index(self) -> None:
        with self._lock:
            stop, t = self._index_stop, self._index_thread
            self._index_stop = self._index_thread = None
            idx = self.index
        # Joined OUTSIDE the lock: a rescan pass takes it to publish its result.
        if stop is not None:
            stop.set()
        if t is not None and t.is_alive() and t is not threading.current_thread():
            t.join(timeout=10)
        if idx is not None:
            # close(), not stop(): this thread's sqlite handle would otherwise keep
            # index.db open, and Windows cannot delete a folder with an open file.
            idx.close()

    def _rescan_run(self, idx: InstanceIndex, stop: threading.Event) -> None:
        try:
            c = idx.rescan(self._index_roots(), purge=True, stop=stop)
        except Exception as exc:
            self.log.error(f"Index rescan failed: {exc}", kind="index")
        else:
            if c.get("cancelled"):
                self.log.info(f"Index rescan cancelled after {c['files']} file(s)", kind="index")
            else:
                self.log.info(
                    f"Index rescan: {c['added']} added, {c['updated']} updated, "
                    f"{c['removed']} removed, {c['skipped']} unchanged, "
                    f"{c['failed']} unreadable ({c['seconds']}s)",
                    kind="index",
                )
        with self._lock:
            if self._index_stop is stop:
                self._index_stop = self._index_thread = None

    def rescan_index(self) -> dict:
        """Kick a reconciliation walk from the dashboard. Returns immediately —
        the result lands in the Activity log (kind='index')."""
        if self.index is None:
            return {"ok": False, "message": "the instance index is disabled — enable it in Settings"}
        with self._lock:
            if self._index_thread and self._index_thread.is_alive():
                return {"ok": False, "message": "a rescan is already running"}
            stop = threading.Event()
            t = threading.Thread(target=self._rescan_run, args=(self.index, stop),
                                 name="pacs-index-scan", daemon=True)
            self._index_stop, self._index_thread = stop, t
            t.start()
        return {"ok": True, "message": "Rescanning the storage folders…"}

    def _sync_index(self) -> None:
        """Re-point the index after a save. The database path (and whether there
        is one at all) is fixed at construction, so a change means a new object;
        the watcher holds a reference, so it is handed the new one too."""
        old = self.index
        enabled = bool(self.cfg.index.get("enabled", True))
        path = self.cfg.resolved("index", "path") or ":memory:"
        if bool(old) == enabled and (old is None or old.path == path):
            return
        self.stop_index()
        self._build_index()
        self.watcher.index = self.index
        self._index_stats_at = 0.0
        if self.index is not None:
            self.index.start()
            # A new database (or one just switched back on) knows nothing about
            # what is already on disk, and an empty index is a PACS that reports
            # itself empty to every modality that queries it.
            self.rescan_index()

    # ---- receiver (Storage SCP) -------------------------------------------
    def start_receiver(self) -> None:
        with self._lock:
            if self.scp and self.scp.running:
                return
            s = self.cfg.scp
            self.scp = StorageSCP(
                aet=s["aet"],
                bind=s.get("bind", "0.0.0.0"),
                port=int(s["port"]),
                storage_dir=self.cfg.resolved("scp", "storage_dir"),
                organize=bool(s.get("organize", True)),
                log=self.log,
                on_received=self._reconcile_study,
                index=self.index,
                allowed_aets=s.get("allowed_aets", []),
                tls=bool(s.get("tls", False)),
                tls_cert=self.cfg.resolve_path(s.get("tls_cert", "")),
                tls_key=self.cfg.resolve_path(s.get("tls_key", "")),
                tls_ca=self.cfg.resolve_path(s.get("tls_ca", "")),
                min_free_mb=int(float(s.get("min_free_gb", 2) or 0) * 1024),
            )
            self.scp.start()

    def _scu_tls_context(self):
        """Build the client-side TLS context from the current SCU config."""
        from .tlsutil import client_context
        scu = self.cfg.scu
        return client_context(
            verify=bool(scu.get("tls_verify", True)),
            ca=self.cfg.resolve_path(scu.get("tls_ca", "")),
            certfile=self.cfg.resolve_path(scu.get("tls_cert", "")),
            keyfile=self.cfg.resolve_path(scu.get("tls_key", "")),
        )

    def stop_receiver(self) -> None:
        with self._lock:
            if self.scp:
                self.scp.stop()

    def _probe(self, dest: dict):
        """Quiet C-ECHO to a destination for the emergency health monitor —
        returns (ok, message) without logging (it runs every probe interval)."""
        from .scu import Destination, c_echo
        d = Destination.from_dict(dest)
        ctx = None
        if d.tls:
            try:
                ctx = self._scu_tls_context()
            except Exception as exc:
                return False, f"TLS config error: {exc}"
        res = c_echo(d, self.cfg.scu.get("aet", "CARINOSCU"), tls_context=ctx)
        return res.ok, res.message

    # ---- print receiver (virtual DICOM film printer) ----------------------
    def _ingest_print(self, data: bytes, kind: str, identity: dict, name: str) -> None:
        """Sink for a captured print job: stage the rendered film (PDF or image)
        into the pending-review queue (a print carries no trustworthy identity,
        so an operator confirms + approves it before it is ever forwarded)."""
        from . import ingest
        pending_dir = self._pending_dir()
        os.makedirs(pending_dir, exist_ok=True)
        tmp_dir = tempfile.mkdtemp(prefix="carinoprint-")
        tmp = os.path.join(tmp_dir, name)
        try:
            with open(tmp, "wb") as fh:
                fh.write(data)
            ingest.stage_pending(pending_dir, tmp, identity, kind)
        finally:
            import shutil as _sh
            _sh.rmtree(tmp_dir, ignore_errors=True)

    def start_printer(self) -> None:
        with self._lock:
            if self.print_scp and self.print_scp.running:
                return
            p = self.cfg.printer
            old = self.print_scp
            self.print_scp = PrintSCP(
                aet=p.get("aet", "CARINOPRINT"),
                bind=p.get("bind", "0.0.0.0"),
                port=int(p.get("port", 11113)),
                log=self.log,
                on_output=self._ingest_print,
                color=bool(p.get("color", False)),
                layout=p.get("layout", "pdf"),
                allowed_aets=p.get("allowed_aets", []),
                tls=bool(p.get("tls", False)),
                tls_cert=self.cfg.resolve_path(p.get("tls_cert", "")),
                tls_key=self.cfg.resolve_path(p.get("tls_key", "")),
                tls_ca=self.cfg.resolve_path(p.get("tls_ca", "")),
            )
            # The card's evidence — how many films, the last one, the last
            # problem — is what an operator checks after a modality reports a
            # failed print, so a Stop/Start or a Save must not wipe it. The
            # counters keep the origin they were first counted from.
            if old is not None:
                for attr in ("printed_count", "error_count", "last_problem", "last_print"):
                    setattr(self.print_scp, attr, getattr(old, attr))
            self._counter_since.setdefault("printer", time.time())
            self.print_scp.start()

    def stop_printer(self) -> None:
        with self._lock:
            if self.print_scp:
                self.print_scp.stop()

    # ---- emergency RIS (HL7/MLLP order intake + reconciliation) -----------
    def start_ris(self) -> None:
        with self._lock:
            if self.ris and self.ris.running:
                return
            r = self.cfg.ris
            # match_on may have changed in config since the store was built.
            self.orders.match_on = r.get("match_on", "accession")
            self.ris = RisListener(
                bind=r.get("bind", "0.0.0.0"),
                port=int(r.get("port", 2575)),
                store=self.orders,
                log=self.log,
                allowed_hosts=r.get("allowed_hosts", []),
            )
            self._counter_since["ris"] = time.time()
            self.ris.start()

    def stop_ris(self) -> None:
        with self._lock:
            if self.ris:
                self.ris.stop()

    # ---- Modality Worklist SCP (serve orders to modalities) ---------------
    def start_mwl(self) -> None:
        with self._lock:
            if self.mwl_scp and self.mwl_scp.running:
                return
            m = self.cfg.mwl
            self.mwl_scp = MwlSCP(
                aet=m.get("aet", "CARINOMWL"),
                bind=m.get("bind", "0.0.0.0"),
                port=int(m.get("port", 11114)),
                log=self.log,
                get_orders=lambda: self.orders.list("open"),
                allowed_aets=m.get("allowed_aets", []),
                tls=bool(m.get("tls", False)),
                tls_cert=self.cfg.resolve_path(m.get("tls_cert", "")),
                tls_key=self.cfg.resolve_path(m.get("tls_key", "")),
                tls_ca=self.cfg.resolve_path(m.get("tls_ca", "")),
            )
            self._counter_since["mwl"] = time.time()
            self.mwl_scp.start()
            # Whose worklist is this? The caller's, and it stays up until the
            # caller stops it. The opposite default — "a worklist nothing in the
            # configuration wanted must be the emergency's, so it may be
            # reclaimed" — reads well and is wrong, because ``serve --mwl`` is
            # also a worklist nothing in the configuration wanted: the
            # documented run-once override inherited a "may be reclaimed" it
            # never asked for, and release_worklist() then took it down on the
            # first order that CLOSED — a reconciled C-STORE, a cancel, a
            # delete, even a purge that removed nothing — stranding the orders
            # that were still open and logging a stand-down that had not
            # happened. A default that every caller but one has to undo is a
            # default the next caller will forget to undo, and the next caller
            # was a launch flag documented in two manuals.
            #
            # So the two starts that ARE reclaimable claim the worklist
            # themselves, immediately after us: EmergencyController.activate(),
            # for the one an outage brings up, and sync_worklist(), for the one
            # a restart mid-outage re-binds for orders that exist in this store
            # and nowhere else. Both of those reasons end; a flag nobody set
            # cannot.
            self.mwl_for_orders = False

    def stop_mwl(self) -> None:
        with self._lock:
            if self.mwl_scp:
                self.mwl_scp.stop()

    # ---- Query/Retrieve SCP (C-FIND / C-MOVE / C-GET over the index) -------
    def start_qr(self) -> None:
        with self._lock:
            if self.qr_scp and self.qr_scp.running:
                return
            if self.index is None:
                # Q/R answers exclusively out of the index. Binding the port
                # without one would advertise an archive that reports itself
                # empty to every modality that asks — worse than not answering.
                raise ValueError("Query/Retrieve needs the instance index — enable index.enabled")
            q = self.cfg.qr
            self.qr_scp = QrSCP(
                aet=q.get("aet", "CARINOQR"),
                bind=q.get("bind", "0.0.0.0"),
                port=int(q.get("port", 11115)),
                log=self.log,
                index=self.index,
                move_destinations=q.get("move_destinations", {}),
                get_destinations=self.cfg.enabled_destinations,
                get_tls_context=self._scu_tls_context,
                # The same folders DICOMweb serves from, from the same place, so
                # a C-MOVE and a WADO retrieve of one instance can never reach
                # different verdicts about whether it may be read.
                get_storage_roots=self.cfg.storage_roots,
                allowed_aets=q.get("allowed_aets", []),
                tls=bool(q.get("tls", False)),
                tls_cert=self.cfg.resolve_path(q.get("tls_cert", "")),
                tls_key=self.cfg.resolve_path(q.get("tls_key", "")),
                tls_ca=self.cfg.resolve_path(q.get("tls_ca", "")),
            )
            self.qr_scp.start()

    def stop_qr(self) -> None:
        with self._lock:
            if self.qr_scp:
                self.qr_scp.stop()

    def worklist_wanted(self) -> bool:
        """True if the Modality Worklist should run as a permanent service: the
        SCP is explicitly enabled, OR any enabled destination is flagged
        ``no_ris`` (that PACS has no RIS, so Carino is its worklist source).

        Strictly the CONFIGURED question, and it has to stay that way: this is
        what EmergencyController._worklist_is_permanent() reads to decide
        whether a worklist is the hospital's or the emergency's own, and what
        the "no Modality Worklist is enabled" line reception reads is computed
        from — but only AFTER _worklist_outcome() has ruled out an emergency
        worklist that failed to bind, because on that appliance this predicate
        is False and "enable MWL" is not the remedy. Whether something is being
        SERVED right now that nothing else can serve is a different question —
        worklist_in_use()."""
        if self.cfg.mwl.get("enabled"):
            return True
        return any(d.get("no_ris") for d in self.cfg.enabled_destinations())

    def orders_only_we_can_serve(self) -> int:
        """How many OPEN orders exist that nothing but this worklist will serve.

        Manual orders only, and that is the whole distinction: ``carino-manual``
        means somebody typed a real patient into this box during an outage,
        precisely because the RIS could not be reached — so the RIS does not
        have the order, will not have it when it comes back, and no other
        worklist in the hospital can put it in front of a tech. An order that
        arrived as HL7 (``carino-ris``) is the real RIS's to re-serve, and a test
        order is nobody's exam: neither is a reason to hold a port open.

        The counting itself is ris.open_orders_stranded_here(), because the
        emergency controller asks the same question when the operator stands
        down, and the two answering it differently would strand exactly the
        patient both of them exist to protect.
        """
        return ris.open_orders_stranded_here(self.orders)

    def worklist_in_use(self) -> bool:
        """True if the worklist must keep running whatever configuration says:
        it is configured, an emergency is on the air, or an order typed during
        one is still open.

        This is the predicate the config paths use, because a save is not a
        decision about an outage. apply_config() restarts a bound service whose
        settings changed, and the worklist was the one service whose restart asked only
        about configuration — so an administrator finishing the setup chooser in
        the middle of a failover took the emergency's only path to the modalities
        down with it, permanently (sync_worklist() runs on launch and on a save,
        not on a timer) and without a word. The same hole swallows a hand-keyed
        order that outlives the emergency: it exists in this store and nowhere
        else, and the RIS that is now back was never told about it.

        Deliberately NOT folded into worklist_wanted(): resume() reads that one
        to tell the hospital's worklist from the emergency's own, and an
        emergency that is still ACTIVE would make its own worklist look
        permanent — resume() would then never stop what it started.
        """
        if self.worklist_wanted() or self.orders_only_we_can_serve() > 0:
            return True
        # getattr both ways: sync_worklist() is reachable from startup paths
        # that run before the controller is built, and a fake server in a test
        # need not carry one at all.
        return getattr(getattr(self, "emergency", None), "state", "") in (EMG_ACTIVE, EMG_RECOVERING)

    def sync_worklist(self) -> None:
        """Start the worklist SCP if it's wanted and not already running
        (called on launch and after a config change)."""
        if self.worklist_in_use() and not (self.mwl_scp and self.mwl_scp.running):
            # Asked BEFORE the start, because afterwards the question is no
            # longer answerable the same way, and asked at all because this is
            # the one place that binds a worklist without a human behind it:
            # worklist_in_use() said yes, so if worklist_wanted() says no the
            # only reasons left are an emergency on the air or an order it
            # stranded. That is the appliance coming back up in the middle of
            # an outage and re-binding the worklist for patients whose orders
            # exist here and nowhere else — the same worklist activate() would
            # have bound, and it has to be lettable-go of in the same way, or
            # the port stays bound for the life of the process after the last
            # of those patients is finally scanned.
            reclaimable = not self.worklist_wanted()
            try:
                self.start_mwl()
            except Exception as exc:
                self.log.error(f"Could not start worklist SCP: {exc}", kind="mwl")
            else:
                self.mwl_for_orders = reclaimable

    def release_worklist(self) -> None:
        """The other half of sync_worklist(): stop a worklist that is bound for
        a reason which has now expired.

        EmergencyController.resume() deliberately leaves the worklist serving
        when an order typed during the outage is still open — that order exists
        in this store and nowhere else, so stopping it would end the only path
        the patient has to a scanner — and the log tells the operator what to do
        about it: scan those patients and it comes down. It did not come down.
        sync_worklist() only ever starts, it runs on launch and on a config save
        rather than on a timer, and nothing re-asked the question when the last
        of those orders was finally closed, so the port stayed bound for the
        life of the process and the operator was told a behaviour the appliance
        did not have.

        So the closing paths ask here. Three conditions, all of them necessary:
        the worklist has to be up; ``worklist_in_use()`` has to be False, which
        is the whole of "configuration does not want it, no emergency is on the
        air, and no hand-keyed order is still open"; and it has to be a worklist
        we bound for those reasons rather than one the hospital configured, an
        operator started by hand, or a run-now service apply_config is keeping
        alive — that last distinction is ``mwl_for_orders``, and it is why this
        is not simply sync_worklist() run backwards.
        """
        if not (self.mwl_scp and self.mwl_scp.running):
            return
        if not self.mwl_for_orders or self.worklist_in_use():
            return
        try:
            self.stop_mwl()
        except Exception as exc:
            # A worklist that will not stop is still answering modalities with
            # orders that belong to the RIS again — the same reason resume()
            # surfaces its own failed stop rather than swallowing it.
            self.log.error(f"Could not stop worklist SCP: {exc}", kind="mwl")
            return
        self.mwl_for_orders = False
        # The counterpart of the "worklist left serving" line resume() writes:
        # whoever read that one and went and scanned the patients gets to see
        # that it worked, without having to go and look at the services panel.
        self.log.info(
            "Worklist stopped — the last order typed during the outage is closed, "
            "and nothing else needs a worklist on this appliance",
            kind="mwl",
        )

    def _reconcile_study(self, ds, path: str) -> None:
        """Called for every C-STORE'd instance: try to match it to an open RIS
        order by Accession Number (or Patient ID fallback). On a hit, close +
        archive the order. Delivery of the study is NEVER gated on this — the
        instance is already stored; this only reconciles order tracking."""
        accession = str(getattr(ds, "AccessionNumber", "") or "")
        patient_id = str(getattr(ds, "PatientID", "") or "")
        study_uid = str(getattr(ds, "StudyInstanceUID", "") or "")
        # Hold-and-forward: while emergency failover is active, copy every
        # received instance into the outgoing folder so the watcher forwards it
        # to the primary (retrying/holding until it's back). Independent of
        # whether the study matches an order.
        if self.emergency.active and self.cfg.emergency.get("hold_and_forward", True):
            self._queue_for_forward(path)
        if not accession and not patient_id and not study_uid:
            return
        # Study Instance UID is the strongest key (exact when the exam was made
        # from a Carino order via MWL); accession / patient id are fallbacks.
        order = self.orders.match(accession, patient_id, study_uid)
        if not order:
            return
        if self.cfg.ris.get("auto_close", True):
            self.orders.close(order["id"], reason=ris.CLOSE_MATCHED, matched_study=study_uid)
            self.log.info(
                f"RIS order matched + closed: {order.get('patient') or '?'} "
                f"[acc {order.get('accession') or '—'}] ← study {os.path.basename(path)}",
                kind="ris",
            )
            # The study for a stranded order just landed — this is literally
            # "scan those patients and it comes down", so ask whether the
            # worklist resume() left up still has anybody to serve.
            self.release_worklist()
        else:
            self.log.info(
                f"RIS order matched (left open — auto-close off): "
                f"{order.get('patient') or '?'} [acc {order.get('accession') or '—'}]",
                kind="ris",
            )

    def _holdforward_primaries(self) -> list:
        """The destination names a held instance owes a delivery to: the nodes
        flagged ``emergency_trigger``, which is what "the primary" means here.
        The node that actually triggered the outage is included even if the flag
        has since been cleared — it is the one the operator is waiting on."""
        names = [str(d.get("name") or "") for d in self.cfg.enabled_destinations()
                 if d.get("emergency_trigger")]
        trigger = str(getattr(self.emergency, "trigger_dest", "") or "")
        if trigger and trigger not in names:
            names.append(trigger)
        return [n for n in names if n]

    def _queue_for_forward(self, path: str) -> None:
        """Copy a received instance into the outgoing watch folder so the normal
        auto-send/retry pipeline forwards it to the primary (used by emergency
        hold-and-forward). Best-effort — never break the C-STORE on a copy error.

        The primary is PINNED onto the copy's send state rather than left to the
        rule engine. Dropping the file in the watch folder alone means the rules
        decide where it goes, and one ``{"destinations": ["Teaching"], "stop":
        true}`` would send the held copy to a teaching archive, mark it fully
        sent and let it be archived — or deleted — having never reached the
        primary, which is the entire reason hold-and-forward exists. A pin only
        widens the route; the rules still add whatever else they want."""
        import shutil as _sh
        try:
            watch = self.cfg.resolved("scu", "watch_dir")
            os.makedirs(watch, exist_ok=True)
            dst = os.path.join(watch, os.path.basename(path))
            if os.path.abspath(dst) == os.path.abspath(path):
                return
            if not os.path.exists(dst):
                _sh.copy2(path, dst)
        except OSError as exc:
            self.log.warn(f"Emergency hold-and-forward: could not queue {os.path.basename(path)}: {exc}",
                          kind="emergency")
            return
        primaries = self._holdforward_primaries()
        if primaries:
            # Pinned every time, not just on the copy: an earlier queue attempt
            # may have landed the file before the primary was known. Flushed
            # immediately — the watcher only persists at the end of a pass, and a
            # crash in between would leave the held copy on disk with the promise
            # gone, which is the failover guarantee quietly evaporating.
            self.watcher.state.pin(dst, primaries)
            self.watcher.state.save()
        elif not self._warned_no_primary:
            self._warned_no_primary = True
            self.log.warn(
                "Emergency hold-and-forward has no primary to hold FOR — no enabled "
                "destination is flagged emergency_trigger, so held studies go wherever "
                "the routing rules send them and nothing guarantees a back-fill",
                kind="emergency",
            )

    # ---- emergency failover (health monitor + state machine) --------------
    def emergency_action(self, action: str, profile=None) -> dict:
        """Drive the failover state machine from the dashboard.

        *profile* is whoever asked. It decides three things: whether they are
        allowed to activate at all, whose acknowledgement a dismiss records, and
        whose name goes in the log and the audit trail next to the decision.
        None means an appliance running without profiles, where there is one
        operator and every answer is yes.
        """
        fn = {
            "arm": self.emergency.arm,
            "disarm": self.emergency.disarm,
            "activate": self.emergency.activate,
            "dismiss": self.emergency.dismiss,
            "resume": self.emergency.resume,
        }.get(action)
        if not fn:
            return {"ok": False, "message": "action must be arm|disarm|activate|dismiss|resume"}
        # emergency.activate as a capability says "this person makes failover
        # decisions"; emergency.activate_by says the administrator designated
        # them on THIS appliance. The endpoint checked the first. This checks
        # the second, and it has to be here rather than in the route, because
        # the state machine is what knows the policy.
        #
        # Dismiss is deliberately NOT gated: acknowledging a prompt is saying "I
        # have seen this", which anybody being shown it is entitled to say. Only
        # the three that change what the appliance is doing are restricted.
        if action in ("activate", "arm", "disarm", "resume") and not self.emergency.may_activate(profile):
            named = ", ".join(
                users.describe_principal(self.cfg.users, s)
                for s in (self.cfg.emergency.get("activate_by") or [])) or "an administrator"
            return {"ok": False,
                    "message": f"failover decisions on this appliance are for {named}. "
                               f"Your profile can see the alert but not answer it."}
        return {"ok": True, "emergency": fn(profile)}

    # ---- RIS orders (CRUD over the store) ---------------------------------
    def list_orders(self, status: Optional[str] = None) -> dict:
        return {"orders": self.orders.list(status), "counts": self.orders.counts()}

    def station_list(self, *, usable_only: bool = False) -> list:
        """The department's rooms as the order form needs them: name, AE title,
        modality code. Nothing else from the entry.

        This exists so that "which rooms can an order be aimed at?" has ONE
        answer on the wire, published in two places — inside the status payload,
        and on its own at GET /api/ris/orders/stations for the order form, which
        needs it before the first status poll lands and cannot read the
        configuration to get it. Reception holds orders.read and orders.write
        and not config.read, and that gap is why the station field was free text
        while the modality beside it was a closed list: an AE title that is not
        exactly a console's AE title is matched by nothing (mwl.py matches
        ScheduledStationAETitle by equality, leniently only when the ORDER's is
        blank), so "SALA CT" typed where CT_1 was meant hides the order from the
        very console that asks for it while reception is told the worklist is
        serving it.

        Deliberately a projection and never the config entry itself: an entry
        may grow a field that is the administrator's business, and a list an
        unprivileged profile reads must not widen because something upstream
        did. Four keys, named here, and that is the whole contract.

        *usable_only* drops the rooms an order cannot actually be aimed at — a
        disabled one is equipment out of service, and one with no AE title is
        matched by no worklist query at all, so offering either would offer a
        target that silently reaches nobody, which is the failure the picker
        exists to end. The row shape does not change with it, so one renderer
        reads either list.
        """
        out = []
        for m in self.cfg.modalities:
            enabled = bool(m.get("enabled", True))
            aet = str(m.get("aet", ""))
            if usable_only and (not enabled or not aet):
                continue
            out.append({"name": str(m.get("name", "")), "aet": aet,
                        "modality": str(m.get("modality", "")),
                        "enabled": enabled})
        return out

    def order_stations(self) -> dict:
        """The rooms an order may be aimed at, as the order form reads them.

        An empty list is a real answer — nobody has registered this
        department's equipment yet — and the form has to keep accepting an
        order with no station either way: a blank ScheduledStationAETitle is
        served to EVERY console, which is the safe direction and the documented
        default. Reception is never left unable to file an order because the
        configuration is thin.
        """
        return {"ok": True, "stations": self.station_list(usable_only=True)}

    # What reception is told when they press Queue: a machine-readable outcome
    # the dashboard translates, and the English that outcome means.
    #
    # "Order queued" on its own answered the wrong question. Reception does not
    # care that the order reached a file on this box; they care that the tech at
    # the modality will see it, and that only happens if a Modality Worklist is
    # actually serving. So the confirmation says which of the four situations
    # they are in, and never claims the order propagated when nothing is there
    # to serve it.
    #
    # It travels as a code rather than as engine text, which is the exception to
    # this file's usual rule, and it is worth saying why. Engine text is English
    # here because of WHO reads it: a log line, an API error, a start failure's
    # cause are all read by the person who can act on them, and that person
    # reads the log anyway. Three of these four sentences are not that. They are
    # read by a receptionist, in the middle of an outage, and one of them is the
    # ONLY place anybody is told that the order just typed is reaching no
    # scanner at all — there is no banner for it, no badge, no LED. This
    # appliance ships in es, pt-BR, ja and ru. A safety warning the person at
    # the desk cannot read is not a warning, so the dashboard gets a code it can
    # put through T() and says it in their language.
    #
    # The English stays on ``message`` regardless: curl, the tests and any
    # client that is not the dashboard keep exactly the sentence they had, and a
    # dashboard too old to know a code still has something true to show.
    ORDER_QUEUED_MESSAGES = {
        "order_queued_serving":
            "Order queued — the Modality Worklist is serving it",
        "test_order_queued_serving":
            "Test order queued — the Modality Worklist is serving it",
        "order_queued_mwl_stopped":
            "Order queued, but the Modality Worklist is NOT running, so no modality can "
            "query it. It is enabled — start it, or check the log for why it stopped.",
        "test_order_queued_mwl_stopped":
            "Test order queued, but the Modality Worklist is NOT running, so no modality can "
            "query it. It is enabled — start it, or check the log for why it stopped.",
        "order_queued_mwl_failed":
            "Order queued, but the Modality Worklist failed to start, so the order will not "
            "reach any modality. Check the log for the cause — usually its port is already "
            "in use — and hand the details to the tech.",
        "test_order_queued_mwl_failed":
            "Test order queued, but the Modality Worklist failed to start, so the order will "
            "not reach any modality. Check the log for the cause — usually its port is "
            "already in use — and hand the details to the tech.",
        "order_queued_no_mwl":
            "Order queued, but no Modality Worklist is enabled, so the order will not reach "
            "any modality. Enable MWL, or hand the details to the tech.",
        "test_order_queued_no_mwl":
            "Test order queued, but no Modality Worklist is enabled, so the order will not "
            "reach any modality. Enable MWL, or hand the details to the tech.",
        # The fifth outcome, and the only one that is about the order rather
        # than about the service: a worklist really is serving it, and the AE
        # title it was aimed at belongs to no console this appliance has heard
        # of, so every console that filters by station queries past it. Narrower
        # than the three above — a console that sends no station key still sees
        # the order — and said narrowly, because a warning that overstates is a
        # warning that gets ignored.
        "order_queued_station_unknown":
            "Order queued, but no station registered here answers to that AE title, so a "
            "console that filters by station will not see it. Pick the room from the list, "
            "or leave the target blank to show the order on every worklist.",
        "test_order_queued_station_unknown":
            "Test order queued, but no station registered here answers to that AE title, so a "
            "console that filters by station will not see it. Pick the room from the list, "
            "or leave the target blank to show the order on every worklist.",
    }

    # Why an order is refused outright, as a code the dashboard translates and
    # the English that code means — the same two-part contract as
    # ORDER_QUEUED_MESSAGES above, and here for the same reason: a receptionist
    # in the middle of an outage reads it, and this appliance ships in es,
    # pt-BR, ja and ru.
    #
    # These are the only refusals this endpoint issues that are about a VALUE
    # rather than about the request, and they exist because the alternative is
    # worse in a way nobody can see. An accession the worklist cannot carry used
    # to be accepted, confirmed with the green "the Modality Worklist is serving
    # it", and then dropped from the item on the wire — so the study coming back
    # from the scanner had nothing to reconcile against, the order never closed,
    # and the first person to notice was whoever audited the open list days
    # later. Refusing at the moment it is typed is the only point in the whole
    # path where the person who can fix it is still looking at it.
    #
    # Each sentence states the WHOLE rule for its field — the cap and the
    # characters — because the two failures are one refusal, and an instruction
    # to shorten a value whose real problem is a backslash is an instruction
    # that does not work. The caps are mwl.SH_MAX and mwl.LO_MAX; they are
    # spelled out rather than interpolated so that a translator sees a whole
    # sentence, and mwl.identifier_fits, not this text, is what actually decides.
    ORDER_REFUSED_MESSAGES = {
        "order_refused_accession":
            "Order NOT queued — a Modality Worklist cannot carry that accession number. It "
            "must be at most 16 characters and must not contain a backslash. Shorten or "
            "retype it, or leave it blank — a shortened accession names a different order, "
            "so this appliance will not shorten it for you.",
        "order_refused_patient_id":
            "Order NOT queued — a Modality Worklist cannot carry that patient ID. It must be "
            "at most 64 characters and must not contain a backslash. Shorten or retype it, or "
            "leave it blank and the order will carry a temporary ID naming itself.",
        # No dashboard field writes this one — study_uid is only reachable over
        # the API — so it is here to be an honest answer to a client that sends
        # one, not a sentence reception will ever be shown.
        "order_refused_study_uid":
            "Order NOT queued — that Study Instance UID is not a legal DICOM UID (digits and "
            "dots, at most 64 characters, no leading zero in a component). Leave it out and "
            "this appliance will generate one.",
    }

    def _unrepresentable_identifier(self, fields: dict) -> str:
        """The refusal code for the first reconciling identifier this order
        carries that a worklist could not send as typed, or '' when it carries
        none.

        Only the three keys OrderStore reconciles on are checked
        (mwl.RECONCILING_IDENTIFIERS), and the narrowness is the point. The
        order's other values degrade honestly inside mwl.py — a description is
        shortened, a modality nobody can parse becomes OT, a station nobody
        knows is warned about rather than refused — and refusing an order over
        any of those would be refusing a patient during an outage over a label.
        These three are different: they are what a returning study is matched
        against, so an unrepresentable one is not a degraded order, it is an
        order that can never be closed.

        Fields the caller did not send are not checked, so this is safe to ask
        on a partial update: identifier_fits() reads an absent value as fine,
        and an update that does not mention the accession must not be refused
        over the one already stored.
        """
        for field, vr in mwl.RECONCILING_IDENTIFIERS.items():
            if field in fields and not mwl.identifier_fits(fields.get(field), vr):
                return f"order_refused_{field}"
        return ""

    def add_order(self, fields: dict) -> dict:
        if not any(str(fields.get(k, "")).strip() for k in ("accession", "patient", "patient_id")):
            return {"ok": False, "message": "an order needs at least an accession, patient name or patient ID"}
        # Asked before the order is stored, never after: an order that is in the
        # store is already being served, and by the time anything downstream
        # notices, reception has been told the worklist has it.
        refused = self._unrepresentable_identifier(fields)
        if refused:
            return {"ok": False, "code": refused,
                    "message": self.ORDER_REFUSED_MESSAGES[refused]}
        # A test order and a real one behave identically all the way through —
        # that is the point of testing with them — so the only thing separating
        # them is this flag, and it has to be carried rather than guessed.
        testing = bool(fields.get("test"))
        order = self.orders.add(
            fields,
            source="test generator" if testing else "manual",
            origin=ris.ORIGIN_TEST if testing else ris.ORIGIN_MANUAL,
        )
        code = (("test_order_queued_" if testing else "order_queued_")
                + self._worklist_outcome(fields.get("station_aet", "")))
        return {"ok": True, "code": code, "message": self.ORDER_QUEUED_MESSAGES[code],
                "order": order}

    def _worklist_outcome(self, station_aet: str = "") -> str:
        """Which of the five situations the order that was just queued is in,
        as the tail of an ``order_queued_*`` code.

        The failed-start case is asked BEFORE worklist_wanted(), and that order
        is the whole point of it. An emergency brings its own worklist up
        (EmergencyController.activate), and it does so whether or not
        ``mwl.enabled`` is set — so when that start fails on a squatted port,
        the strictly-configured predicate is False and reception used to be told
        "no Modality Worklist is enabled … Enable MWL". Both halves were wrong
        in the way that costs the most: the cause was not a missing setting, and
        the remedy could not work, because enabling MWL binds the same port that
        is already being held by whatever the log names. The appliance knew —
        ``emergency.mwl_error`` is on the very status payload the dashboard is
        polling — and said something else. Now the specific answer wins.
        """
        if self.mwl_scp and self.mwl_scp.running:
            # A worklist is serving, so the only thing left that can keep this
            # order off a screen is where it was aimed. Asked last of the four
            # service questions and only in this branch, because the three
            # below are about a worklist that is not there at all, and they say
            # it better than this can.
            if self._station_is_unknown(station_aet):
                return "station_unknown"
            return "serving"
        # getattr for the same reason worklist_in_use() uses it: this is
        # reachable from a fake server in a test that carries no controller.
        # mwl_error is written in three places — activate() sets it, resume()
        # clears it, and _recheck_worklist() both sets and clears it on every
        # tick of a live outage — but all three of them run inside ACTIVE or
        # RECOVERING, and nothing writes it outside that window. So the state
        # gate below, not the setters, is what keeps a stale reason left over
        # from a previous outage from speaking for this order; it is also what
        # lets a worklist that died mid-outage name itself as the cause here
        # rather than reporting the healthy verdict activate() left an hour ago.
        emg = getattr(self, "emergency", None)
        if (getattr(emg, "mwl_error", "")
                and getattr(emg, "state", "") in (EMG_ACTIVE, EMG_RECOVERING)):
            return "mwl_failed"
        if self.worklist_wanted():
            return "mwl_stopped"
        return "no_mwl"

    def _station_is_unknown(self, station_aet: str) -> bool:
        """Was this order aimed at an AE title no console here answers to?

        The order is never refused for it — an outage is not the moment to
        reject a patient over an AE title, and the registry is not evidence of
        what exists, only of what somebody wrote down. What changes is the
        sentence reception reads, which is the only surface they have.

        Three deliberate Falses, each one a case where a warning would be worse
        than silence:

        * A BLANK station is the lenient branch of the matcher and the form's
          default — ``mwl.py`` shows such an order to every console — so it is
          "show it everywhere", never a miss.
        * An EMPTY registry means nothing has been written down. Most installs
          start that way, and checking against an empty list would warn about
          every station anybody ever typed, which is how a safety sentence
          stops being read.
        * A registered room that is switched OFF still answers to its AE title:
          ``enabled`` governs what this appliance SENDS to, not what pulls a
          worklist, so an order aimed at one is not aimed at nothing. Hence
          station_list() rather than station_list(usable_only=True) here — the
          picker offers fewer rooms than the check accepts, on purpose.

        Compared upper-cased, which is how ``mwl.py`` matches the key and how
        config.py already refuses two rooms the same AE title: an order that
        WILL reach its console must never be warned about over a difference the
        matcher does not make.
        """
        want = str(station_aet or "").strip().upper()
        if not want:
            return False
        known = {s["aet"].strip().upper() for s in self.station_list() if s["aet"].strip()}
        if not known:
            return False
        return want not in known

    def update_order(self, oid: str, fields: dict) -> dict:
        # The same gate as add_order, because this writes the same fields into
        # the same store. An edit is in fact the repair path for an order that
        # arrived over HL7 carrying an accession the worklist could not send, so
        # the one thing it must not do is let a second unrepresentable value in
        # while the operator is trying to get the first one out.
        refused = self._unrepresentable_identifier(fields)
        if refused:
            return {"ok": False, "code": refused,
                    "message": self.ORDER_REFUSED_MESSAGES[refused]}
        o = self.orders.update(oid, fields)
        if not o:
            return {"ok": False, "message": "order not found"}
        self.log.info(f"RIS order edited [acc {o.get('accession') or '—'}]", kind="ris")
        return {"ok": True, "message": "Order updated", "order": o}

    def close_order(self, oid: str) -> dict:
        """Withdraw an order — but only one this appliance created.

        An order that came from the real RIS belongs to the RIS. Carino serves
        it on a worklist and notices its study arriving; it does not decide the
        exam is off. A cancellation the RIS itself sends is relayed by
        OrderStore.apply and recorded as CLOSE_BY_RIS, which is a different
        thing and stays allowed."""
        existing = self.orders.get(oid)
        if not existing:
            return {"ok": False, "message": "order not found"}
        if not ris.may_cancel_here(existing):
            self.log.warn(
                f"Refused to cancel order [acc {existing.get('accession') or '—'}] — "
                f"it came from the RIS, and only the RIS can withdraw it",
                kind="ris",
            )
            return {"ok": False,
                    "message": "This order came from the RIS. Only the RIS can cancel it — "
                               "cancel it there, or delete it here if it should never have arrived."}
        o = self.orders.close(oid, reason=ris.CLOSE_BY_OPERATOR)
        self.log.info(f"RIS order cancelled here [acc {o.get('accession') or '—'}]", kind="ris")
        # Cancelling the last stranded order settles it as finally as scanning
        # the patient does: nothing is waiting on that worklist any more.
        self.release_worklist()
        return {"ok": True, "message": "Order cancelled"}

    def delete_order(self, oid: str) -> dict:
        ok = self.orders.delete(oid)
        if ok:
            self.release_worklist()
        return {"ok": ok, "message": "Order deleted" if ok else "order not found"}

    def purge_closed_orders(self) -> dict:
        n = self.orders.purge_closed()
        self.log.info(f"Purged {n} closed RIS order(s)", kind="ris")
        # Purging only removes orders that are already closed, so it cannot be
        # what frees the worklist — but it is the operator tidying the list
        # after the outage, and asking costs one predicate.
        self.release_worklist()
        return {"ok": True, "removed": n, "message": f"Removed {n} closed order(s)"}

    @staticmethod
    def _order_identity(order: dict) -> dict:
        """The patient and study an order hands a converted file — study UID
        included, since that is the UID the modality burns in via the worklist
        and the one the order is later matched on."""
        return {
            "patient": order.get("patient", ""),
            "patient_name": order.get("patient_name", ""),
            "patient_id": order.get("patient_id", ""),
            "patient_birthdate": order.get("patient_birthdate", ""),
            "patient_sex": order.get("patient_sex", ""),
            "study_uid": order.get("study_uid", ""),
            "study_date": order.get("scheduled_dt", ""),
            "study_desc": order.get("study_desc", ""),
            "accession": order.get("accession", ""),
            "referring": order.get("referring", ""),
        }

    def create_study_from_order(self, order_id: str, filename: str, data: bytes) -> dict:
        """Use-case-B bridge: wrap an exported PDF/image as a DICOM study that
        inherits THIS order's identity (patient, IDs, accession, and the order's
        pre-generated Study Instance UID), drop it into the outgoing folder for
        the normal auto-send/hold-and-forward pipeline, and close the order as
        fulfilled. The tech captured the study in a legacy tool and relates the
        export to the on-screen order — no hand-typed identity."""
        from . import ingest
        order = self.orders.get(order_id)
        if not order:
            return {"ok": False, "message": "order not found"}
        if order.get("status") != "open":
            return {"ok": False, "message": "order is already closed"}
        kind = ingest.detect_kind_bytes(data, filename)
        if not kind:
            return {"ok": False, "message": "unsupported file — capture a PDF, JPEG or PNG"}
        base = os.path.splitext(os.path.basename(filename))[0]
        meta = {
            **self._order_identity(order),
            "series_desc": base or order.get("study_desc") or "Captured study",
            "source": "RIS order " + (order.get("accession") or order_id),
        }
        watch = self.cfg.resolved("scu", "watch_dir")
        try:
            ds = ingest.build_from_bytes(data, kind, meta)
            out = ingest.save_instance(ds, watch)
        except Exception as exc:
            return {"ok": False, "message": f"could not convert: {exc}"}
        if self.index is not None:
            self.index.enqueue_file(out, "outgoing")
        self.orders.close(order_id, reason=ris.CLOSE_CAPTURED, matched_study=order.get("study_uid", ""))
        self.log.info(
            f"Captured study for order [acc {order.get('accession') or '—'}] "
            f"→ {os.path.basename(out)} into outgoing; order closed",
            kind="ris",
        )
        # The fifth and last way an order settles, and the one an outage is
        # most likely to use: use case B exists for the legacy unit that cannot
        # C-STORE, so on that site every hand-keyed order ends here rather than
        # at _reconcile_study(). Without this call the worklist resume() left up
        # "until those patients are scanned" survived exactly the path that
        # scans them, which is the promise emergency.py makes to the operator in
        # the log line they are meant to act on.
        self.release_worklist()
        if self.watcher.running:
            msg = "Study created and queued — Auto-send will forward it (held until the PACS is reachable)."
        else:
            msg = "Study created in the outgoing folder — start Auto-send to forward it."
        return {"ok": True, "message": msg, "file": os.path.basename(out)}

    # ---- watcher (auto-send) ----------------------------------------------
    def start_watcher(self) -> None:
        self.watcher.start()

    def stop_watcher(self) -> None:
        self.watcher.stop()

    # ---- one-off actions ---------------------------------------------------
    def echo(self, dest: dict) -> SendResult:
        d = Destination.from_dict(dest)
        self.log.info(f"C-ECHO -> {d.name} ({d.host}:{d.port}){' [TLS]' if d.tls else ''}", kind="echo")
        ctx = None
        if d.tls:
            try:
                ctx = self._scu_tls_context()
            except Exception as exc:  # bad cert/key/CA path
                self.log.warn(f"C-ECHO {d.name}: TLS config error: {exc}", kind="echo")
                return SendResult(False, f"TLS config error: {exc}")
        res = c_echo(d, self.cfg.scu.get("aet", "CARINOSCU"), tls_context=ctx, check_storage=True)
        (self.log.info if res.ok else self.log.warn)(
            f"C-ECHO {d.name}: {res.message}", kind="echo"
        )
        return res

    def selftest(self, service: str, do_print: bool = False) -> dict:
        """Test one of our own listeners from the inside: C-ECHO for the DICOM
        ones (and, for the printer, optionally a real one-sheet print that lands
        in Pending), an HL7 ACK round trip for the RIS listener. Always a
        {ok, message, ms} — a failure is an answer, never an exception."""
        from . import selftest as st
        t0 = time.monotonic()

        def done(ok: bool, message: str) -> dict:
            return {"ok": ok, "message": message, "ms": int((time.monotonic() - t0) * 1000)}

        table = {
            "receiver": (self.scp, "receiver"),
            "printer": (self.print_scp, "print receiver"),
            "mwl": (self.mwl_scp, "worklist"),
            "qr": (self.qr_scp, "Query/Retrieve"),
            "ris": (self.ris, "RIS listener"),
        }
        if service not in table:
            return done(False, "service must be receiver, printer, mwl, qr or ris")
        obj, label = table[service]
        if not (obj and obj.running):
            return done(False, f"The {label} is not running — start it first.")
        host = st.loopback_for(obj.bind)
        try:
            if service == "ris":
                ok, said = st.hl7_ping(host, int(obj.port))
                if not ok and obj.allowed_hosts and host not in obj.allowed_hosts:
                    said += (f" — {host} is not in its allowed hosts "
                             f"({', '.join(obj.allowed_hosts)}), so it was turned away")
                return done(ok, f"RIS listener at {host}:{obj.port}: {said}.")
            allowed = list(obj.allowed_aets or [])
            calling = allowed[0].strip() if allowed else self.cfg.scu.get("aet", "CARINOSCU")
            as_whom = (f" Called as {calling}, the first AE title in its allowed list."
                       if allowed else "")
            ctx = None
            if obj.tls:
                scu = self.cfg.scu
                ctx = st.client_tls(bool(obj.tls_ca),
                                    self.cfg.resolve_path(scu.get("tls_cert", "")),
                                    self.cfg.resolve_path(scu.get("tls_key", "")))
            dest = Destination(name=label, host=host, port=int(obj.port), aet=obj.aet,
                               tls=bool(obj.tls))
            res = c_echo(dest, calling, timeout=5, tls_context=ctx)
            where = f"{obj.aet} at {host}:{obj.port}{' over TLS' if obj.tls else ''}"
            if not res.ok:
                return done(False, f"The {label} did not answer C-ECHO ({where}): {res.message}.{as_whom}")
            if service == "printer" and do_print:
                ok, said = st.test_print(host, int(obj.port), obj.aet, calling, ctx)
                return done(ok, f"Test print to {where}: {said}.{as_whom}")
            return done(True, f"The {label} answered C-ECHO ({where}).{as_whom}")
        except Exception as exc:          # a bad client certificate path, say
            return done(False, f"The test could not run: {exc}")

    # ---- worklist probe ----------------------------------------------------
    def probe_worklist(self, station_aet: str) -> dict:
        """Ask the other RIS what it would give one of our modalities.

        Several questions rather than one, because a single answer does not
        locate a fault. A modality that is not seeing its schedule usually fails
        for one of three reasons, and only the DIFFERENCES between these answers
        tell them apart:

          A  station + date + modality   the narrowest — closest to what a
                                          scanner actually asks
          B  station + date              drops the modality key
          C  station, any date           drops the date — isolates a date or
                                          timezone filter
          D  any station, date           drops the station — orders exist, but
                                          are not addressed to this scanner
          E  any station, any date       is there anything there at all

        One variable is relaxed at a time, on purpose. An earlier version folded
        the modality key into the first question and then blamed the station for
        its absence, which is a diagnosis that sends somebody to edit the wrong
        field.

        And a count alone still lies. An order with no ScheduledStationAETitle
        reaches EVERY modality, so a scanner can look healthy while only ever
        receiving the unaddressed spillover; CaughtStore splits each answer into
        addressed-to-this-station, addressed-to-nobody and addressed-elsewhere
        for exactly that reason.

        The scanner's own AE title is borrowed as the calling AE — that is what
        makes the answer the scanner's answer rather than ours. It is also why
        the scanner has to be off the network first, which this code cannot
        check and does not pretend to.
        """
        from .scu import c_find_worklist

        src = self.cfg.worklist_source or {}
        host, aet = str(src.get("host", "")).strip(), str(src.get("aet", "")).strip()
        if not host or not aet:
            return {"ok": False, "message": "No worklist source configured. Set the other RIS's "
                                            "host, port and AE title in Settings first."}
        station = str(station_aet or "").strip()
        if not station:
            return {"ok": False, "message": "Pick a modality to ask as"}
        known = [m for m in self.cfg.modalities
                 if str(m.get("aet", "")).strip().upper() == station.upper()]
        if not known:
            return {"ok": False, "message": f"'{station}' is not a registered modality. Add it "
                                            f"under Configuration → Modalities first, so the "
                                            f"AE title being borrowed is one somebody chose."}
        modality = str(known[0].get("modality", "") or "")

        d = Destination(name="worklist source", host=host, port=int(src.get("port", 105) or 105),
                        aet=aet, tls=bool(src.get("tls", False)))
        ctx = None
        if d.tls:
            try:
                ctx = self._scu_tls_context()
            except Exception as exc:
                return {"ok": False, "message": f"TLS config error: {exc}"}

        today = _dcm_today()
        questions = [
            (station, today, modality),   # A — narrowest
            (station, today, ""),         # B — modality dropped
            (station, "", ""),            # C — date dropped
            ("", today, ""),              # D — station dropped
            ("", "", ""),                 # E — everything dropped
        ]
        self.log.info(
            f"Worklist probe: asking {d.host}:{d.port} ({d.aet}) as {station} — "
            f"the modality must be off the network for this to mean anything",
            kind="mwl",
        )
        probes = [c_find_worklist(d, station, station_aet=sa, date=dt, modality=md, tls_context=ctx)
                  for sa, dt, md in questions]
        rnd = self.caught.add_round(station, {"host": d.host, "port": d.port, "aet": d.aet}, probes)
        # Audited by the web layer, which is where the actor is known — see
        # api_worklist_probe(). Borrowing somebody else's AE title is worth a
        # name against it.
        return {"ok": True, "round": rnd, "message": _probe_verdict(rnd),
                "items": sum(p.get("count", 0) for p in rnd["probes"])}

    # ---- study history / browse -------------------------------------------
    def _group_root(self, group: str) -> Optional[str]:
        """Resolve a history 'group' to its storage folder."""
        if group == "received":
            return self.cfg.resolved("scp", "storage_dir")
        if group in ("sent", "archived"):
            return self.cfg.resolved("scu", "sent_dir")
        if group == "outgoing":
            return self.cfg.resolved("scu", "watch_dir")
        return None

    @staticmethod
    def _index_group(group: str) -> str:
        """History group -> index group. 'archived' is the browser's name for
        the same tree 'sent' resolves to, and the index only knows one of them."""
        return "sent" if group == "archived" else group

    def list_studies(self, group: str) -> dict:
        from . import history
        root = self._group_root(group)
        if root is None:
            raise ValueError("group must be received|sent")
        # Walked, never read from the index, even though the index holds a row
        # per stored file and would answer without touching the disk. The list
        # is what the delete and send buttons are aimed at, and the index cannot
        # tell a caller whether it is complete: a first rescan still running
        # reads like a small archive, and a row outliving the folder it names
        # turns into a study that is not there. history.py's module docstring
        # has the full account, so nobody rebuilds it.
        return {"group": group, "root": root, **history.scan(root)}

    def delete_study(self, group: str, path: str) -> dict:
        from . import history
        root = self._group_root(group)
        if root is None:
            return {"ok": False, "message": "group must be received|sent"}
        try:
            history.delete_study(root, path)
        except (ValueError, OSError) as exc:
            return {"ok": False, "message": str(exc)}
        if self.index is not None:
            # The files are gone; rows pointing at them would answer a query
            # with a 404 the client cannot make sense of.
            self.index.remove_under(path)
        self.log.info(f"Deleted study {os.path.basename(path)} from {group}", kind="config")
        return {"ok": True, "message": "Study deleted"}

    def delete_all_studies(self, group: str) -> dict:
        from . import history
        root = self._group_root(group)
        if root is None:
            return {"ok": False, "message": "group must be received|sent"}
        n = history.delete_all(root)
        if self.index is not None:
            self.index.remove_group(self._index_group(group))
        self.log.info(f"Deleted all {group} studies ({n} removed)", kind="config")
        return {"ok": True, "removed": n, "message": f"Removed {n} studies"}

    def reveal_study(self, group: str, path: str) -> dict:
        root = self._group_root(group)
        from .dicomfs import safe_within
        if root is None or not safe_within(root, path):
            return {"ok": False, "message": "path is outside the storage folder"}
        folder = path if os.path.isdir(path) else os.path.dirname(path)
        if not os.path.exists(folder):
            return {"ok": False, "message": "folder no longer exists"}
        try:
            if sys.platform.startswith("win"):
                os.startfile(folder)   # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", folder])
            else:
                subprocess.Popen(["xdg-open", folder])
        except Exception as exc:
            return {"ok": False, "message": f"could not open folder: {exc}"}
        return {"ok": True, "message": f"Opened {folder}"}

    def send_study(self, group: str, path: str) -> dict:
        """Forward every instance of a study to the destinations routing picks.

        Routed per file, exactly like the watcher: a manual send that fanned out
        to every node would contradict auto-send, and — worse — would forward
        identified data to a node a rule scrubs for.

        Runs in a background thread so a big study doesn't block the request;
        per-file results stream to the Activity log (kind='send')."""
        from . import history, routing
        from .deid import Deidentifier, deidentified_tempfile
        from .scu import Destination, c_store
        root = self._group_root(group)
        if root is None:
            return {"ok": False, "message": "group must be received|sent"}
        try:
            files = history.study_files(root, path)
        except (ValueError, OSError) as exc:
            return {"ok": False, "message": str(exc)}
        if not files:
            return {"ok": False, "message": "no DICOM files found for this study"}
        dests = [Destination.from_dict(d) for d in self.cfg.enabled_destinations()]
        if not dests:
            return {"ok": False, "message": "no enabled destinations — add one in Destinations first"}
        ctx = None
        if any(d.tls for d in dests):
            try:
                ctx = self._scu_tls_context()
            except Exception as exc:
                return {"ok": False, "message": f"TLS config error: {exc}"}
        aet = self.cfg.scu.get("aet", "CARINOSCU")
        label = os.path.basename(path.rstrip("/\\")) or "study"
        # The router and the de-identifier are built from ONE frozen view of the
        # config, so the two halves of the de-identification decision cannot come
        # apart underneath this send. See _SendConfig.
        frozen = _SendConfig(self.cfg)
        dest_names = [d.name for d in dests]
        router = routing.Router(frozen.routing, dest_names, log=self.log, cfg=frozen)
        # What this send PROMISES each destination, recorded at the moment it is
        # promised. Everything the stale check below does is a comparison against
        # this dict.
        promised = _deid_answers(router, dest_names)
        try:
            deider = Deidentifier.from_config(frozen, self.log)
        except Exception as exc:
            # Having no de-identifier is not a reason to forward identified, and
            # it is not a reason to fail the request either: every destination the
            # decision asks a scrub for is HELD below, exactly as it would be with
            # the profile off, because it is the same situation.
            self.log.error(f"Send {label}: could not build the de-identifier ({exc}) — "
                           f"any destination a rule scrubs for is held, not forwarded",
                           kind="send")
            deider = None
        # "Is there a de-identifier" asked once, and asked of the object rather
        # than of the config: deidentified_tempfile yields the SOURCE path for a
        # disabled one, so a de-identifier that exists but does nothing forwards
        # identity just as surely as no de-identifier at all.
        can_scrub = deider is not None and deider.enabled
        # Said once per set of held names per study, whichever way the hold was
        # reached: a thousand-instance study must not write a thousand copies of
        # it, and an operator who reads one line has read the whole message.
        _PROFILE_OFF = ("a routing rule asks for de-identification and deid.profile is "
                        "'off', so nothing can be scrubbed and these instances are held "
                        "rather than forwarded identified. Turn the de-identification "
                        "profile on, or take 'deidentify' off the rule.")
        _NO_DEIDENTIFIER = ("this send has no de-identifier and a rule asks for one, so "
                            "these instances are held rather than forwarded identified. A "
                            "send runs under the settings it started with — press Send "
                            "again to run it under the current ones.")
        _SUPERSEDED = ("the de-identification settings for these destinations were CHANGED "
                       "while this send was in flight. A send finishes under the settings it "
                       "started with, so the rest of the study would leave under settings the "
                       "operator has already replaced — and /api/status is already reporting "
                       "the new ones for it. They are held instead; press Send again to "
                       "deliver the whole study under the current settings.")

        def _record(fp: str, dname: str, res) -> bool:
            with self.watcher._lock:
                if res.ok:
                    self.watcher.sent_count += 1
                    self.watcher.last_activity = f"{os.path.basename(fp)} -> {dname}"
                else:
                    self.watcher.failed_count += 1
                # A manual send is a forward like any other — it has to move
                # "last transfer" or the dashboard goes stale.
                self.watcher.last_sent = {
                    "epoch": int(time.time()), "file": os.path.basename(fp),
                    "dest": dname, "ok": bool(res.ok), "error": "" if res.ok else res.message,
                }
            if res.ok:
                self.log.info(f"Sent {os.path.basename(fp)} -> {dname}", kind="send")
            else:
                self.log.warn(f"Send {os.path.basename(fp)} -> {dname}: {res.message}", kind="send")
            return bool(res.ok)

        def _run():
            ok = fail = held = 0
            reached: set = set()
            said: set = set()

            def _hold(names: set, why: str) -> None:
                """Withhold a set of destinations for this file, and say so.

                The watcher announces its holds on its own path; the manual send
                said nothing at all, on any channel, and forwarded identified."""
                nonlocal held
                held += len(names)
                key = ";".join(sorted(names)) + "|" + why
                if key in said:
                    return
                said.add(key)
                self.log.error(f"{label}: NOT sent to {', '.join(sorted(names))} — {why}",
                               kind="send")

            # Destinations whose de-identification answer has been replaced under
            # this send. Sticky: once a promise has been superseded, this send is
            # no longer the one that can honour it, and un-holding on a revert
            # would make the answer for a study depend on when each instance
            # happened to be dialled.
            superseded: set = set()

            def _restale() -> None:
                """Has the config moved under us, and does it change a promise?

                Asked per instance, off the LIVE config, because the whole point
                is that the frozen view cannot see this. The signature comparison
                is the cheap gate — an unchanged config costs one json.dumps and
                nothing else.

                Whether it should also STOP the send: no, and not for the same
                reason the watcher abandons its pass. Stopping everything would
                strand the destinations whose promise did NOT move — including
                the ordinary identified forwards that are the study's clinical
                delivery — mid-study, with no next pass to finish them. Sending
                to a destination whose promise DID move would put an instance on
                the wire under a setting the operator has already replaced, and
                that is the invariant this whole area exists to protect. Holding
                exactly the moved ones costs neither: a manual send reads the
                study and moves nothing, so pressing Send again re-delivers every
                instance under the current settings, and a C-STORE the far end
                has already taken is idempotent by SOP Instance UID."""
                if _config_signature(self.cfg) == frozen.signature:
                    return
                live = _deid_answers(
                    routing.Router(self.cfg.routing, dest_names, cfg=self.cfg), dest_names)
                moved = {n for n in dest_names
                         if live.get(n) != promised.get(n)} - superseded
                if not moved:
                    return
                superseded.update(moved)
                # On every channel this send already uses: the log here, the
                # completion summary below, and /api/status through the note.
                self.log.warn(
                    f"{label}: the de-identification settings changed while this send was "
                    f"running — {', '.join(sorted(moved))} "
                    f"{'is' if len(moved) == 1 else 'are'} no longer being sent to by it",
                    kind="send")
                self._note_stale_send(label, sorted(superseded))

            def _blocked(dname: str) -> bool:
                """Asked immediately before each c_store, not once per instance.

                A save can land between two deliveries of the SAME instance —
                the first destination has it and the second has not been dialled
                yet — and an instance that leaves in that gap leaves under a
                promise that has already been replaced. This is the last point
                at which that can still be true, so it is where it is asked."""
                _restale()
                if dname not in superseded:
                    return False
                _hold({dname}, _SUPERSEDED)
                return True

            for fp in files:
                _restale()
                decision = router.route(fp)
                if decision.held:
                    _hold(set(decision.held), _PROFILE_OFF)
                # Every node behind each SENDABLE routed name — held ones are not
                # dialled at all. Resend is the recovery path an operator reaches
                # for when a node missed a study, so it is the last place that may
                # collapse two same-named nodes into whichever one a dict happened
                # to keep.
                todo = routing.resolve_all(dests, decision.sendable)
                # A superseded promise is withheld before anything is dialled, in
                # the same shape as every other hold here: not sent to at all.
                if superseded:
                    blocked = {d.name for d in todo if d.name in superseded}
                    if blocked:
                        _hold(blocked, _SUPERSEDED)
                        todo = [d for d in todo if d.name not in blocked]
                # The scrub set comes from the DECISION and from nothing else. It
                # used to read "asked for AND this send happens to hold a
                # de-identifier", which let the set actually scrubbed be NARROWER
                # than the set the decision asked for — and every destination that
                # fell out of the gap was sent identified while the decision, the
                # log and /api/status all called it de-identified.
                scrub = {d.name for d in todo if decision.needs_deid(d.name)}
                if scrub and not can_scrub:
                    # Asked for and impossible. That is the config state's
                    # situation exactly, so it gets the config state's outcome:
                    # not sent to, rather than sent to in the clear.
                    _hold(scrub, _NO_DEIDENTIFIER)
                    todo = [d for d in todo if d.name not in scrub]
                    scrub = set()
                for d in [x for x in todo if x.name not in scrub]:
                    if _blocked(d.name):
                        continue
                    reached.add((d.name, d.host, d.port))
                    if _record(fp, d.name, c_store(d, fp, aet, tls_context=ctx)):
                        ok += 1
                    else:
                        fail += 1
                # Re-asked before the scrubbed copy is built, so a destination
                # whose promise moved while the identified half of this instance
                # was on the wire is dropped here too — and a set that empties
                # costs no temp file.
                scrub = {n for n in scrub if not _blocked(n)}
                if not scrub:
                    continue
                # One scrubbed copy per file serves every node that wants one:
                # the profile is deterministic and the original is never touched.
                try:
                    with deidentified_tempfile(fp, deider) as scrubbed:
                        for d in [x for x in todo if x.name in scrub]:
                            reached.add((d.name, d.host, d.port))
                            if _record(fp, d.name, c_store(d, scrubbed, aet, tls_context=ctx)):
                                ok += 1
                            else:
                                fail += 1
                except Exception as exc:
                    fail += len([x for x in todo if x.name in scrub])
                    self.log.error(
                        f"Send {os.path.basename(fp)}: de-identification failed ({exc}) — "
                        f"not forwarded to {', '.join(sorted(scrub))}",
                        kind="send",
                    )
            # The held count rides on the summary line too: the per-study error
            # above is one line in a busy log, and this is the one an operator
            # reads to find out whether the send they just pressed did what they
            # asked. "12 ok, 0 failed" with six deliveries withheld is the same
            # false assurance in a different place.
            summary = (f"Manual send of {label} finished: {ok} ok, {fail} failed "
                       f"({len(files)} instance(s) → {len(reached)} node(s))")
            if held:
                # Not "the profile is off": a hold is also how this send answers
                # "a rule asks for a scrub and there is no de-identifier", and the
                # summary must not name a cause the error lines above contradict.
                summary += (f"; {held} delivery/deliveries HELD, not sent — a rule asks "
                            f"for de-identification that could not be performed (see the "
                            f"errors above)")
            if superseded:
                # The summary is the line an operator reads when the send is over,
                # so the one thing they cannot be left to infer is that this send
                # finished under settings that are no longer the ones on screen.
                summary += (f"; the de-identification settings changed mid-send, so "
                            f"{', '.join(sorted(superseded))} received nothing further "
                            f"from it — press Send again to deliver the whole study "
                            f"under the current settings")
            if held or superseded:
                self.log.warn(summary, kind="send")
            else:
                self.log.info(summary, kind="send")

        threading.Thread(target=_run, name="pacs-send", daemon=True).start()
        return {"ok": True, "message": f"Sending {len(files)} instance(s) to their routed destination(s)…"}

    # How many mid-send changes /api/status carries. One row per study, newest
    # last: this is a notice with an action attached ("press Send again"), not a
    # history, and the ones an operator can still act on are the recent ones.
    _STALE_SENDS_KEPT = 5

    def _note_stale_send(self, study: str, held: list) -> None:
        """Record — for /api/status — that a send finished under settings that
        have since been replaced, and which destinations it therefore stopped
        delivering to. The third channel: the log says it as it happens and the
        completion summary says it at the end, but both scroll away, and the
        dashboard is where an operator looks for what is not moving."""
        row = {"study": study, "at": int(time.time()), "held": list(held)}
        with self._stale_lock:
            self._stale_sends = ([r for r in self._stale_sends if r["study"] != study]
                                 + [row])[-self._STALE_SENDS_KEPT:]

    def stale_sends(self) -> list:
        with self._stale_lock:
            return [dict(r) for r in self._stale_sends]

    def explain_route(self, group: str, path: str, routing_cfg: Optional[dict] = None) -> dict:
        """Where would this study go, and why — rule by rule. Read-only, and the
        router is built without a log on purpose: pressing the button in the
        dashboard must not write warnings into the Activity feed."""
        from . import history, routing
        root = self._group_root(group)
        if root is None:
            return {"ok": False, "message": "group must be received|sent"}
        try:
            files = history.study_files(root, path)
        except (ValueError, OSError) as exc:
            return {"ok": False, "message": str(exc)}
        if not files:
            return {"ok": False, "message": "no DICOM files found for this study"}
        r = routing.Router.from_config(self.cfg, None)
        if routing_cfg is not None:
            # A draft from the rule editor, already validated by the caller.
            r.update(routing_cfg, r.enabled)
        # Settled before it leaves: a dry run that promises a scrub this install
        # cannot perform is the same lie as /api/status making the promise, told
        # to the operator at the moment they are deciding whether to forward.
        return {"ok": True, **_settled_explain(r.explain(files[0]), self.cfg)}

    def attach_to_study(self, group: str, path: str, filename: str, data: bytes) -> dict:
        """Wrap an uploaded PDF/image as a DICOM instance inheriting the target
        study's identity and drop it into the study's folder as a new series.
        The user then hits Send/Resend to forward the study (report included)."""
        from . import history, ingest
        from .dicomfs import safe_within
        root = self._group_root(group)
        if root is None:
            return {"ok": False, "message": "group must be received|sent"}
        if not safe_within(root, path):
            return {"ok": False, "message": "path is outside the storage folder"}
        kind = ingest.detect_kind_bytes(data, filename)
        if not kind:
            return {"ok": False, "message": "unsupported file — attach a PDF, JPEG or PNG"}
        try:
            identity = history.study_identity(root, path)
        except (ValueError, OSError) as exc:
            return {"ok": False, "message": str(exc)}
        if not identity:
            return {"ok": False, "message": "could not read the study's patient/identity"}
        identity["series_desc"] = os.path.splitext(os.path.basename(filename))[0] or "Attachment"
        study_dir = path if os.path.isdir(path) else os.path.dirname(path)
        # Land it in its own subfolder so it reads as a separate DOC/OT series
        # (the browser groups a study one modality per folder).
        dest_dir = os.path.join(study_dir, "attachments")
        try:
            ds = ingest.build_from_bytes(data, kind, identity)
            out = ingest.save_instance(ds, dest_dir)
        except Exception as exc:
            return {"ok": False, "message": f"could not convert: {exc}"}
        if self.index is not None:
            self.index.enqueue_file(out, self._index_group(group))
        self.log.info(f"Attached {filename} to study {os.path.basename(study_dir)} ({group})", kind="config")
        return {"ok": True, "message": f"Attached {filename} — hit {'Resend' if group in ('sent', 'archived') else 'Send'} to forward it",
                "file": os.path.basename(out)}

    # ---- DICOM-editor deep-link -------------------------------------------
    def study_dicom_files(self, group: str, path: str) -> dict:
        """Manifest of a study's DICOM files ({name, url}) for the DICOM-editor
        deep-link to fetch. Reuses study_files' root gate."""
        from . import history
        from urllib.parse import urlencode
        root = self._group_root(group)
        if root is None:
            return {"ok": False, "message": "group must be received|sent"}
        try:
            files = history.study_files(root, path)
        except (ValueError, OSError) as exc:
            return {"ok": False, "message": str(exc)}
        if not files:
            return {"ok": False, "message": "no DICOM files found for this study"}
        base = path if os.path.isdir(path) else os.path.dirname(path)
        out = []
        for fp in files:
            name = os.path.relpath(fp, base)
            url = "/api/studies/file?" + urlencode({"group": group, "path": path, "name": name})
            out.append({"name": name, "url": url})
        return {"ok": True, "files": out}

    def study_dicom_file(self, group: str, path: str, name: str) -> Optional[str]:
        """Absolute path of one named DICOM file in a study, or None. Only files
        that study_files already vouched for (in-root, is_dicom) can match, so a
        crafted 'name' can't escape the study."""
        from . import history
        root = self._group_root(group)
        if root is None:
            return None
        try:
            files = history.study_files(root, path)
        except (ValueError, OSError):
            return None
        base = path if os.path.isdir(path) else os.path.dirname(path)
        for fp in files:
            if os.path.relpath(fp, base) == name:
                return fp
        return None

    # ---- pending imports (non-DICOM awaiting review) ----------------------
    def _pending_dir(self) -> str:
        return self.cfg.resolved("scu", "pending_dir")

    def list_pending(self) -> dict:
        from . import ingest
        d = self._pending_dir()
        return {"root": d, "items": ingest.list_pending(d)}

    def approve_pending(self, pid: str, edits: dict, order_id: str = "",
                        keep_study: bool = False) -> dict:
        """Convert a queued file into the outgoing folder so the normal
        auto-send + archive pipeline forwards and files it.

        With *order_id* the file takes that open order's identity and study UID,
        exactly as a capture against the order does, and the order closes as
        captured — a film identified from the worklist is that order fulfilled."""
        from . import ingest
        watch = self.cfg.resolved("scu", "watch_dir")
        order = None
        if order_id:
            order = self.orders.get(order_id)
            order = dict(order) if order else None
            if not order:
                return {"ok": False, "message": "order not found", "error": "order not found",
                        "field": "order_id"}
            if order.get("status") != "open":
                return {"ok": False, "message": "order is already closed",
                        "error": "order is already closed", "field": "order_id"}
        try:
            out = ingest.approve_pending(
                self._pending_dir(), pid, edits or {}, watch, keep_study=keep_study,
                identity=self._order_identity(order) if order else None)
        except ingest.PendingInputError as exc:
            return {"ok": False, "message": str(exc), "error": str(exc), "field": exc.field}
        except (ValueError, OSError) as exc:
            return {"ok": False, "message": str(exc)}
        except Exception as exc:
            return {"ok": False, "message": f"could not convert: {exc}"}
        if self.index is not None:
            self.index.enqueue_file(out, "outgoing")
        self.log.info(f"Approved review item → {os.path.basename(out)} into outgoing", kind="config")
        if order:
            # Closed only once the instance is on disk, as a capture does: a
            # conversion that failed leaves the order open to be tried again.
            self.orders.close(order_id, reason=ris.CLOSE_CAPTURED,
                              matched_study=order.get("study_uid", ""))
            self.log.info(f"Review item matched to order {order_id}; "
                          f"order closed", kind="ris")
            self.release_worklist()
        if self.watcher.running:
            msg = "Converted and queued — Auto-send will forward it."
        else:
            msg = "Converted into the outgoing folder — start Auto-send to forward it."
        return {"ok": True, "message": msg}

    def discard_pending(self, pid: str) -> dict:
        from . import ingest
        try:
            ok = ingest.discard_pending(self._pending_dir(), pid)
        except ValueError as exc:
            return {"ok": False, "message": str(exc)}
        return {"ok": ok, "message": "Discarded" if ok else "item not found"}

    def pending_preview(self, pid: str):
        """(folder, filename) of a queued file's raw bytes, or None."""
        from . import ingest
        try:
            return ingest.preview_path(self._pending_dir(), pid)
        except ValueError:
            return None

    # ---- config ------------------------------------------------------------
    # THE APPLY INVARIANT. apply_config() has exactly two legal exits, and at
    # both of them the in-memory config, the file on disk and the running
    # services agree with each other:
    #
    #   (a) it raises having disturbed nothing — old config in memory AND on
    #       disk, and every service that was running still running under it. A
    #       save that cannot be written costs the department nothing.
    #   (b) it returns (or re-raises one kept failure) with the new config in
    #       memory AND on disk, and every service the new config wants having
    #       been GIVEN its start. One that could not bind is logged and shows on
    #       the dashboard as enabled-but-not-running — never stopped in silence.
    #
    # There is no third exit, and in particular no "half a config applied, PACS
    # off the air". Two rules hold that line, and whoever adds the next service
    # here has to keep both:
    #
    #   1. NOTHING IS STOPPED UNTIL THE NEW CONFIG IS ON DISK. Persisting is the
    #      step that fails for reasons outside this process — a read-only bind
    #      mount (our own docker-compose.yml mounts one), a full disk, ownership
    #      that changed under a container restart. would_accept() vets the
    #      candidate, not the directory, so validation alone never made the
    #      bounce safe: stopping first meant an unwritable config directory took
    #      the whole PACS down with nothing left running to bring it back.
    #   2. ONCE THE BOUNCE HAS BEGUN, EVERY PATH OUT OF IT GOES THROUGH THE
    #      RESTART. The stops, the re-point between them and the starts are each
    #      fenced by _apply_step(), so no single failure — a stop() that throws,
    #      an index that will not reopen, a port something else grabbed while we
    #      held it open — can leave this method with the other services down.
    def _apply_step(self, action, what: str, kind: str) -> Optional[Exception]:
        """Run one step of a config apply, RETURNING the failure instead of
        raising it. Between the stop and the restart there is no exception worth
        a service that never comes back, so every step in that window reports
        this way and the caller decides what to do with the first one."""
        try:
            action()
        except Exception as exc:
            self.log.error(f"Could not {what}: {exc}", kind=kind)
            return exc
        return None

    def _repoint_live_objects(self) -> None:
        """Re-aim the objects that outlive a save at the config just persisted.
        Runs between the stop and the restart because start_qr binds the NEW
        index object, and the receiver is rebuilt around it too."""
        self.log.log_dir = self.cfg.logs_dir   # logs_dir may have changed
        # store_dir / match_on may have changed — repoint the live order store.
        self.orders.store_dir = self.cfg.resolved("ris", "store_dir")
        self.orders.match_on = self.cfg.ris.get("match_on", "accession")
        self._sync_index()

    def apply_config(self, new_data: Optional[dict] = None, enforce: bool = False,
                     edit=None) -> dict:
        """Persist a new config from the dashboard and hot-apply it.

        A listener is bound to a port/AE at start time, so a running one whose
        own inputs changed (_service_inputs) is bounced, and only that one; the
        watcher reads config live, so it just keeps going. A flag turned on
        starts its service and a flag turned off stops it. Returns the engine
        labels of what was restarted, started and stopped.
        Read the apply invariant above this method before reordering anything
        in it — the order is the safety property, not an accident.

        `enforce` marks a save that DEFINES the enrolled set — the setup
        chooser's. Such a save touches nothing but the bounce of services that
        were running and stay enrolled: every other transition is left to the
        sync_services() the caller runs next, which is the single place
        enrollment is enforced and the only one that reports per-service rows.

        `edit` is for the callers that do not have a whole document to post but
        a CHANGE to make to the stored one — the setup chooser's five flags. It
        is handed a copy of the live config INSIDE the critical section below
        and returns the document to persist. That placement is the whole point:
        a caller that reads cfg.data, edits the copy and only then calls this is
        a read-modify-write with the lock held for neither half, and a Save
        landing in the gap is silently reverted by it.
        """
        import copy

        if new_data is None and edit is None:
            raise ValueError("apply_config needs a document or an edit")
        # Validate the candidate first so a bad post never disturbs a running
        # receiver (raises ValueError, surfaced to the caller as a 400). The
        # `edit` form is validated inside the lock instead, where its document
        # exists; replace() re-validates either way before it assigns, so
        # neither path can disturb a service with a config it then refuses.
        if new_data is not None:
            self.cfg.would_accept(new_data)
        # Rule 1: persist BEFORE the bounce. replace() assigns the merged data
        # and only then writes it, so a write that fails leaves the NEW config in
        # memory over an unchanged file — services would be running one config
        # while every reader of self.cfg saw another. Put the old data back, and
        # since not one service has been stopped yet they all stay up on exactly
        # the config they were started with. This is exit (a).
        #
        # Snapshot, swap and rollback are ONE critical section, under the same
        # lock replace() takes. Werkzeug is threaded: with the snapshot taken
        # outside it, thread B could deepcopy the config, be descheduled before
        # its replace() got the lock, and then — if its write failed — put ITS
        # pre-snapshot back over a save from thread A that had already landed on
        # disk. Nothing notices: the file says A, the process says pre-A, and
        # they disagree silently until the next restart. The lock is re-entrant
        # and everything inside is pure (deepcopy) or takes it again on the same
        # thread (replace -> save), so nothing here can wait on another thread.
        #
        # The bounce below stays OUTSIDE: it joins service threads, and holding
        # a config lock across a join is how a stop() that waits on a thread
        # reading config deadlocks the dashboard. It does not need the lock —
        # rule 1 has already put the new config on disk by then, and every
        # service is restarted from self.cfg, whatever a later save makes of it.
        with self.cfg.mutate():
            if edit is not None:
                new_data = edit(copy.deepcopy(self.cfg.data))
                self.cfg.would_accept(new_data)
            previous = copy.deepcopy(self.cfg.data)
            try:
                self.cfg.replace(new_data)
            except Exception:
                self.cfg.data = previous
                raise
        # A config that has just been through validate() has no problem left to
        # report; the startup note must not outlive the edit that fixed it.
        self.config_problem = ""
        listeners = self._listener_table()
        now = self.cfg.data
        running = {n: self._is_running(n) for n in listeners}
        enabled = {n: bool((now.get(sec) or {}).get("enabled")) for n, (sec, *_r) in listeners.items()}
        was_enabled = {n: bool((previous.get(sec) or {}).get("enabled"))
                       for n, (sec, *_r) in listeners.items()}
        moved = {n for n in listeners
                 if _service_inputs(previous, n) != _service_inputs(now, n)}
        was_for_orders = self.mwl_for_orders
        # Turned off in this save (C2b: the flag IS on/off) — stopped and not
        # started again. Not under an enforcing save: sync_services() performs
        # that transition and reports it. The worklist is turned off only when
        # nothing else needs it; an emergency, a no_ris destination or an order
        # typed during an outage keeps it serving whatever the flag says.
        turned_off = {n for n in listeners
                      if not enforce and running[n] and was_enabled[n] and not enabled[n]
                      and not (n == "mwl" and self.worklist_in_use())}
        # Restarted: running, and something it was built from changed. A save
        # that only touches destinations, routing, de-identification, the web
        # settings, modalities or notifications restarts nothing — the watcher
        # and the sender read those live, and a restart aborts associations in
        # flight. An enforcing save leaves alone what it is disabling.
        if enforce:
            bounce = [n for n in listeners if running[n] and n in moved
                      and (self.worklist_in_use() if n == "mwl" else enabled[n])]
        else:
            bounce = [n for n in listeners if running[n] and n in moved and n not in turned_off]
        restarted, started, stopped = [], [], []
        # ---- the bounce: past this line only exit (b) is left ---------------
        for n in [n for n in listeners if n in bounce or n in turned_off]:
            _sec, _start, stop, label, kind = listeners[n]
            # A stop() that throws used to take the services after it down with
            # it and skip the restart entirely: config saved, PACS mute. It is a
            # log line now — the socket may or may not have closed, and the
            # start below will say so if it did not.
            failed = self._apply_step(stop, f"stop the {label} for the config change", kind)
            if n in turned_off and failed is None:
                stopped.append(label)
        # Nothing on the dashboard draws a failed re-point, so like the run-now
        # case below it is kept and handed to the caller once everything else
        # has been applied.
        first_exc = self._apply_step(
            self._repoint_live_objects, "re-point the live objects at the new config", "config")
        for n in bounce:
            _sec, start, _stop, label, kind = listeners[n]
            try:
                start()
            except Exception as exc:
                self.log.error(f"Could not start {label}: {exc}", kind=kind)
                # Enabled but not bound is a state the dashboard shows (and the
                # log explains), not a reason to abort a save that is already
                # persisted. A run-now service that is NOT enrolled draws nothing
                # on the dashboard, so for that case the exception is the only
                # signal the caller will ever get: it is kept and re-raised once
                # everything else has been applied.
                if not enabled[n] and first_exc is None:
                    first_exc = exc
                continue
            restarted.append(label)
            if n == "mwl":
                # Whoever owned the worklist before the save owns it after: a
                # reclaimable one stays reclaimable unless this save made it
                # configured, and an operator's stays the operator's.
                self.mwl_for_orders = was_for_orders and not self.worklist_wanted()
        if "mwl" in turned_off:
            self.mwl_for_orders = False
        elif not enforce and running["mwl"] and was_enabled["mwl"] and not enabled["mwl"]:
            # Switched off but still needed (see turned_off): it now serves only
            # for that reason, so it is let go when the reason ends.
            self.mwl_for_orders = not self.worklist_wanted()
        if not enforce:
            # Newly enabled (or enabled and not bound — a port that was busy at
            # the last attempt): give it its start. An enforcing save leaves
            # this to sync_services(), which reports each one as a row.
            for n in ("receiver", "printer", "ris", "qr"):
                _sec, start, _stop, label, kind = listeners[n]
                if not enabled[n] or self._is_running(n):
                    continue
                try:
                    start()
                    started.append(label)
                except Exception as exc:
                    self.log.error(f"Could not start {label}: {exc}", kind=kind)
        had_mwl = self._is_running("mwl")
        self.sync_worklist()   # a no_ris destination may now want a permanent worklist
        if not had_mwl and self._is_running("mwl"):
            started.append(listeners["mwl"][3])
        if not enforce:
            # The watcher is never bounced (it reads config live); it follows
            # its flag like the listeners, except under an enforcing save, where
            # sync_services() moves it and says so.
            scu_was = bool((previous.get("scu") or {}).get("enabled"))
            scu_now = bool(self.cfg.scu.get("enabled"))
            if scu_now and not self.watcher.running:
                try:
                    self.start_watcher()
                    started.append("watcher")
                except Exception as exc:
                    self.log.error(f"Could not start watcher: {exc}", kind="watch")
            elif scu_was and not scu_now and self.watcher.running:
                if self._apply_step(self.stop_watcher, "stop the watcher", "watch") is None:
                    stopped.append("watcher")
        # Re-sync the health monitor to the new config (armed flag / trigger
        # set). Fenced like everything else in the bounce: the monitor is the
        # last thing standing between a dark primary and a failover, but a
        # thread that will not join is no reason to swallow the log line that
        # tells the operator their save landed.
        #
        # The bounce is a monitor-thread restart, and it must not double as a
        # decision about the outage: stop() sets the state to OFF and start()
        # sets it to IDLE, so before this line a save landing mid-failover ended
        # the emergency outright — banner gone, `activated_by` still set,
        # _recheck_worklist (which only runs while ACTIVE) silently off for the
        # rest of the outage, and nobody told. Saving a configuration is not
        # answering "is the primary back?"; only the operator's Resume normal,
        # and the monitor's own recovery detection, are. So an emergency that
        # was on the air before the bounce is on the air after it, and the
        # monitor re-evaluates it on its next tick like any other.
        was_emergency = getattr(self.emergency, "state", "")
        self._apply_step(self.emergency.stop, "pause the health monitor", "emergency")
        self._apply_step(self.emergency.start, "resume the health monitor", "emergency")
        if was_emergency in (EMG_ACTIVE, EMG_RECOVERING) and self.emergency.state != was_emergency:
            self.emergency.state = was_emergency
        self.log.info("Configuration updated — " + (
            "restarted: " + ", ".join(restarted) if restarted else "no service restarted"),
            kind="config")
        if first_exc is not None:
            raise first_exc
        return {"restarted": restarted, "started": started, "stopped": stopped}

    # ---- one service on or off (a card's Start / Stop) --------------------
    def _listener_table(self) -> dict:
        """name -> (config section, start, stop, engine label, log kind), in
        the order a bounce takes them down."""
        return {
            "receiver": ("scp", self.start_receiver, self.stop_receiver, "receiver", "scp"),
            "printer": ("print", self.start_printer, self.stop_printer, "print receiver", "print"),
            "ris": ("ris", self.start_ris, self.stop_ris, "RIS listener", "ris"),
            "mwl": ("mwl", self.start_mwl, self.stop_mwl, "worklist SCP", "mwl"),
            "qr": ("qr", self.start_qr, self.stop_qr, "Query/Retrieve SCP", "qr"),
        }

    def _is_running(self, name: str) -> bool:
        if name == "watcher":
            return bool(self.watcher.running)
        obj = {"receiver": self.scp, "printer": self.print_scp, "ris": self.ris,
               "mwl": self.mwl_scp, "qr": self.qr_scp}.get(name)
        return bool(obj and obj.running)

    def _persist_enabled(self, section: str, value: bool, narrow: bool = False) -> None:
        """Write ONE enabled flag, under the lock and through the validation a
        Save goes through, so the two cannot interleave. The config version is
        derived from the document, so it moves with the flag: a dashboard still
        holding the old version is refused (409) instead of putting it back.

        *narrow* writes just the flag without validating the whole document:
        for a stored config that is already invalid (config_problem), where a
        full validation would refuse every flag over a field this one never
        touches — and leave the operator unable even to Stop a service."""
        import copy
        with self.cfg.mutate():
            if bool((self.cfg.data.get(section) or {}).get("enabled")) == value:
                return
            if narrow:
                block = self.cfg.data.get(section)
                if not isinstance(block, dict):
                    raise ValueError(f"'{section}' must be an object")
                block["enabled"] = value
                try:
                    self.cfg.save()
                except Exception:
                    block["enabled"] = not value
                    raise
                return
            doc = copy.deepcopy(self.cfg.data)
            doc.setdefault(section, {})["enabled"] = value
            previous = self.cfg.data
            try:
                self.cfg.replace(doc)
            except Exception:
                self.cfg.data = previous
                raise
        self.config_problem = ""

    # Every listener section, for the start check on an already-invalid config.
    _LISTENER_SECTIONS = (("scp", 11112), ("print", 11113), ("mwl", 11114),
                          ("qr", 11115), ("ris", 2575))

    def _own_start_problem(self, section: str) -> str:
        """What would stop *section* starting, judged on that section alone plus
        the ports the other listeners hold — for a stored config that already
        fails validation somewhere else. "" when nothing of its own is wrong.

        A probe document rather than the full one: validate() stops at the first
        error, so on a config with a bad notify.smtp.port every Start would be
        refused over a field the service never reads."""
        import copy
        import re
        from .config import DEFAULTS, _deep_merge
        data = self.cfg.data
        probe = copy.deepcopy(DEFAULTS)
        own = copy.deepcopy(data.get(section) or {})
        if not isinstance(own, dict):
            return f"'{section}' must be an object"
        own["enabled"] = True
        probe[section] = _deep_merge(probe.get(section) or {}, own)
        for other, default in self._LISTENER_SECTIONS:
            if other == section:
                continue
            blk = data.get(other)
            port = blk.get("port", default) if isinstance(blk, dict) else None
            if isinstance(port, int) and 1 <= port <= 65535:
                # Only what the clash check reads; anything else wrong with that
                # section is that section's problem, not this one's.
                probe.setdefault(other, {}).update(
                    port=port, enabled=bool(blk.get("enabled")))
        try:
            self.cfg.would_accept(probe)
        except ValueError as exc:
            msg = str(exc)
            if re.search(rf"(^|\W){re.escape(section)}(\.|')", msg):
                return msg
        return ""

    def set_service(self, name: str, action: str) -> None:
        """Start or Stop from a service card. One model: Start = enable + start,
        Stop = disable + stop, so a stopped service stays stopped across a
        restart and a Save, and a running one is not "enabled but not running".
        Only this service's flag is written and only this service moves.

        Start validates first and persists after the start, so a port clash or
        a bind failure leaves the flag as it was. Stop stops first and records
        the flag after, best effort: Stop is the control an operator reaches
        for when something is wrong, and neither an invalid stored config nor
        an unwritable config directory may keep a service running against
        their wish (an unrecorded Stop is logged — it comes back at restart).
        Raises KeyError (unknown service), ValueError (refused) or OSError."""
        import copy
        if name == "watcher":
            section, start, stop, label, kind = ("scu", self.start_watcher, self.stop_watcher,
                                                 "watcher", "watch")
        else:
            section, start, stop, label, kind = self._listener_table()[name]
        if action == "start":
            doc = copy.deepcopy(self.cfg.data)
            doc.setdefault(section, {})["enabled"] = True
            narrow = False
            try:
                self.cfg.would_accept(doc)
            except ValueError as refused:
                # Refused for something the stored config ALREADY had wrong
                # (config_problem)? Then only this service's own settings and
                # its port can stand in the way; enabling it did not cause the
                # rest and must not be blocked by it.
                try:
                    self.cfg.would_accept(self.cfg.data)
                    stored_ok = True
                except ValueError:
                    stored_ok = False
                if stored_ok:
                    raise refused           # valid before: enabling this broke it
                own = self._own_start_problem(section)
                if own:
                    raise ValueError(own)
                narrow = True
            was = self._is_running(name)
            start()
            if name == "mwl":
                # An operator pressing Start says the worklist stays up until an
                # operator presses Stop. start_mwl() clears the reclaimable flag
                # on a start it performs, but returns early when the SCP is
                # already up — and pressing Start on a worklist an outage
                # brought up is an operator adopting it.
                self.mwl_for_orders = False
            try:
                self._persist_enabled(section, True, narrow=narrow)
            except Exception:
                if not was:
                    self._apply_step(stop, f"stop the {label} again", kind)
                raise
        elif action == "stop":
            stop()
            try:
                self._persist_enabled(section, False, narrow=True)
            except Exception as exc:
                self.log.error(f"Stopped the {label}, but could not record it in the "
                               f"config ({exc}) — it will start again at the next restart",
                               kind=kind)
        else:
            raise ValueError("action must be start|stop")

    # ---- service enrollment (the dashboard's setup chooser) ---------------
    def sync_services(self) -> list:
        """Bring the running services in line with the enabled flags: start what
        is enabled and stopped, stop what is disabled and running. Each
        transition stands alone — a port already in use must not stop the rest
        coming up — and every outcome is reported back as a row."""
        rows: list = []
        for name, want, running, start, stop, label, kind in (
            ("receiver", bool(self.cfg.scp.get("enabled")), bool(self.scp and self.scp.running),
             self.start_receiver, self.stop_receiver, "receiver", "scp"),
            ("watcher", bool(self.cfg.scu.get("enabled")), self.watcher.running,
             self.start_watcher, self.stop_watcher, "watcher", "watch"),
            ("printer", bool(self.cfg.printer.get("enabled")), bool(self.print_scp and self.print_scp.running),
             self.start_printer, self.stop_printer, "print receiver", "print"),
            ("ris", bool(self.cfg.ris.get("enabled")), bool(self.ris and self.ris.running),
             self.start_ris, self.stop_ris, "RIS listener", "ris"),
            # worklist_in_use(), not mwl.enabled: a no_ris destination makes the
            # worklist permanent, and sync_worklist() would otherwise start
            # again what this just stopped. The wider predicate rather than the
            # flag is also what stops an enforcing save — the setup chooser —
            # from stopping the worklist that an emergency in progress, or an
            # order typed during one, is being served from; and, because this
            # row runs in both directions, what STARTS one that a save already
            # stopped.
            ("mwl", self.worklist_in_use(), bool(self.mwl_scp and self.mwl_scp.running),
             self.start_mwl, self.stop_mwl, "worklist SCP", "mwl"),
            ("qr", bool(self.cfg.qr.get("enabled")), bool(self.qr_scp and self.qr_scp.running),
             self.start_qr, self.stop_qr, "Query/Retrieve SCP", "qr"),
        ):
            if want == running:
                continue
            action = "start" if want else "stop"
            try:
                (start if want else stop)()
                rows.append({"service": name, "action": action, "ok": True, "error": ""})
            except Exception as exc:
                self.log.error(f"Could not {action} {label}: {exc}", kind=kind)
                rows.append({"service": name, "action": action, "ok": False, "error": str(exc)})
        return rows

    def apply_setup(self, picks: dict, modalities: Optional[list] = None) -> dict:
        """Finish the setup chooser: write the five enabled flags plus the
        completion marker in ONE save, then sync the services to them.

        One save is the point — apply_config restarts each bound service whose
        settings changed, so posting the five service toggles separately could
        mean five windows with the receiver down. A service
        that then fails to bind is reported in `results`, not as an error: it
        is enrolled, which is exactly what was asked for."""
        # A `services` that is not an object (an array, say) passes the "key in
        # picks" test and then blows up on the subscript — a 500 for a bad body
        # shape, where every other write endpoint gives a 400. ValueError is the
        # route's 400.
        if not isinstance(picks, dict):
            raise ValueError("services must be an object of service -> true/false")

        def edit(doc: dict) -> dict:
            for key, section in SETUP_SERVICES:
                if key in picks:   # an absent key leaves that service's flag alone
                    doc[section]["enabled"] = bool(picks[key])
            doc["setup_completed"] = _utc_stamp()
            # The chooser's "modalities at this site", when it asked. None leaves
            # the stored list alone; validation refuses a malformed one.
            if modalities is not None:
                doc["ris"]["modalities"] = modalities
            return doc

        # Through `edit` rather than a document snapshotted here: this is a
        # read-modify-write on cfg.data like the token endpoint's and the health
        # monitor's, and it was the last one taking its copy outside the lock. A
        # POST /api/config landing between the copy and the write was reverted
        # whole — the operator's destinations, rules and ports back to what they
        # were before their Save, with a 200 on both requests and nothing said.
        # enforce: this save defines the enrolled set, so it must not start what
        # it is disabling and must not race sync_services() for what it enables.
        self.apply_config(edit=edit, enforce=True)
        results = self.sync_services()
        on = [k for k, section in SETUP_SERVICES if self.cfg.data[section].get("enabled")]
        self.log.info(
            "Service setup saved: " + (", ".join(on) if on else "nothing enabled"),
            kind="config",
        )
        return {"ok": True, "setup": self.setup_state(), "results": results,
                "message": f"{len(on)} service(s) enabled"}

    def check_ports(self, items) -> dict:
        """Can these ports actually be bound on this machine? validate() only
        checks that ports are in range and distinct, so "another PACS already
        owns 11112" is otherwise only discoverable by enabling the receiver and
        reading the log — and the chooser is where that answer is worth having.

        A port one of OUR OWN running services holds is reported free (mine), or
        the probe would call a healthy receiver broken. Known asymmetry: the RIS
        listener sets SO_REUSEADDR when it really binds and this probe does not,
        so its port can read busy while it is in truth rebindable."""
        import socket
        # On Windows a plain bind joins an SO_REUSEADDR listener rather than
        # being refused by it, so without this the chooser reports a port
        # somebody is listening on as free — the one direction the comment below
        # says this probe must never be wrong in.
        exclusive = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        ours = set()
        for obj, sect, default_port in (
            (self.scp, self.cfg.scp, 11112),
            (self.print_scp, self.cfg.printer, 11113),
            (self.ris, self.cfg.ris, 2575),
            (self.mwl_scp, self.cfg.mwl, 11114),
            (self.qr_scp, self.cfg.qr, 11115),
        ):
            if obj and obj.running:
                ours.add((str(sect.get("bind") or "0.0.0.0"), int(sect.get("port", default_port))))
        out = []
        for it in (items or []):
            it = it if isinstance(it, dict) else {}
            bind = str(it.get("bind") or "0.0.0.0")
            try:
                port = int(it.get("port", 0))
            except (TypeError, ValueError):
                port = 0
            row = {"service": str(it.get("service", "")), "port": port,
                   "free": False, "mine": False, "error": ""}
            if not 1 <= port <= 65535:
                row["error"] = "port must be 1..65535"
                out.append(row)
                continue
            if (bind, port) in ours:
                row["free"] = row["mine"] = True
                out.append(row)
                continue
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            # No SO_REUSEADDR on purpose: with it set, a port still in TIME_WAIT
            # binds cleanly and we would report a port pynetdicom will fight
            # over as free. A stricter probe can only produce a false "in use",
            # never a false "free", and that is the direction to be wrong in.
            if exclusive is not None:
                s.setsockopt(socket.SOL_SOCKET, exclusive, 1)
            try:
                s.bind((bind, port))
                row["free"] = True
            except OSError as exc:
                row["error"] = str(exc)
            finally:
                s.close()
            out.append(row)
        return {"ok": True, "results": out}

    def setup_state(self) -> dict:
        """Has this install been through the service chooser? The marker alone
        decides it: "" means no run has ever finished the chooser, so it is
        offered. Whether a config file exists is reported (one stat, no walk)
        because "never set up" reads differently with and without one, but it is
        NOT part of the decision — a hand-written config has still never been
        chosen, and guessing otherwise would be a migration by another name."""
        marker = str(self.cfg.data.get("setup_completed", "") or "").strip()
        return {
            "needed": not marker,
            "completed": marker,
            "version": SETUP_VERSION,
            "config_path": self.cfg.path,
            "config_exists": os.path.exists(self.cfg.path),
        }

    # ---- opt-in update check ----------------------------------------------
    def update_enabled(self) -> bool:
        return (self.cfg.data.get("web") or {}).get("update_check") is True

    def update_state(self) -> dict:
        """The Overview's version line. Starts a check only when one is due and
        the operator turned it on; with it off nothing ever leaves the machine."""
        on = self.update_enabled()
        self.update_check.maybe_check(on)
        return self.update_check.status(on)

    def set_update_check(self, on: bool) -> dict:
        """Write web.update_check alone, like a service's enabled flag: no
        service restarts for it, and a config that is invalid elsewhere must
        not stop the operator from turning it off."""
        with self.cfg.mutate():
            web = self.cfg.data.get("web")
            if not isinstance(web, dict):
                raise ValueError("'web' must be an object")
            if web.get("update_check") is not on:
                before = web.get("update_check", False)
                web["update_check"] = on
                try:
                    self.cfg.save()
                except Exception:
                    web["update_check"] = before
                    raise
                self.log.info("Update check turned " + ("on" if on else "off"), kind="config")
        self.update_check.maybe_check(on, force=on)
        return self.update_check.status(on)

    # ---- status ------------------------------------------------------------
    @staticmethod
    def _local_ip() -> Optional[str]:
        """The machine's primary LAN IP (the address remote nodes would use to
        reach this receiver), or None when there is no network route."""
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.settimeout(0.2)
            s.connect(("8.8.8.8", 80))     # no packets sent; just resolves the source IP
            ip = s.getsockname()[0]
            return ip if ip and not ip.startswith("127.") else None
        except OSError:
            return None
        finally:
            s.close()

    @staticmethod
    def _local_ips() -> list:
        """Every non-loopback IPv4 address on this host, so an operator can point
        a modality on ANY local subnet at the right one. Default-route IP first,
        the rest sorted. Handles a multi-homed host with several device networks
        (and an air-gapped device subnet that has no default route at all)."""
        import socket
        found: list = []
        try:
            import psutil
            for addrs in psutil.net_if_addrs().values():
                for a in addrs:
                    if (a.family == socket.AF_INET and a.address
                            and not a.address.startswith("127.")
                            and a.address not in found):
                        found.append(a.address)
        except Exception:                       # psutil missing / platform quirk
            pass
        primary = PacsServer._local_ip()        # default-route source IP (or None)
        if primary and primary in found:
            found.remove(primary)
        found.sort()
        if primary:
            found.insert(0, primary)
        return found

    # ---- stuck sends (failed / backing-off forwards) ----------------------
    def _enabled_dest_names(self) -> set:
        return {d.get("name", "") for d in self.cfg.enabled_destinations()}

    # How many file names a single orphan or held row carries; the rest are
    # counted in "more". Enough for the operator to recognise the study, bounded
    # so a thousand held instances cannot turn one API response into a megabyte.
    _ORPHAN_SAMPLE = 10

    # Why a held destination is held, and the one edit that releases it. Two
    # fields rather than one sentence because a panel shows the situation and the
    # action in different places, and because "what do I do about it" is the half
    # an operator actually needs — a hold has a remedy, unlike an orphan.
    #
    # Keyed by the cause the entry was STAMPED with (routing.record_route writes
    # entry["hold_cause"]), because there are two of them and they do not look
    # different from the outside. The pair below used to be one text asserting
    # "deid.profile is 'off'" over every held row, and the day the second cause
    # shipped that text became false exactly where it mattered: the profile is
    # ON in that state, so the panel's one prescription — turn it on — is a
    # no-op, and the only other thing it offers, taking 'deidentify' off the
    # rule, is what forwards the study IDENTIFIED. The remedy an operator can
    # act on has to belong to the cause they are actually in.
    #
    # The empty key is not padding: an entry recorded before hold_cause existed
    # carries the names without the cause, and the whole failure being repaired
    # here is a surface asserting a cause it cannot know. That row says what is
    # true (nothing can be scrubbed) and sends the operator to the one place that
    # settles which half it is.
    _HELD_TAIL = ("The instances wait in the outgoing folder — never archived, never "
                  "deleted — and nothing retries them; no timer releases a hold.")
    _HELD_REASON = {
        "profile-off": ("Nothing is being sent to %(name)s: a routing rule asks for "
                        "de-identification and deid.profile is 'off', so no copy can be "
                        "scrubbed. " + _HELD_TAIL),
        "no-deidentifier": ("Nothing is being sent to %(name)s: a routing rule asks for "
                            "de-identification, the profile is ON, and no de-identifier "
                            "could be built from the current settings — so no copy can be "
                            "scrubbed. " + _HELD_TAIL),
        "": ("Nothing is being sent to %(name)s: a routing rule asks for de-identification "
             "and no copy can be scrubbed. These instances do not all carry the same "
             "recorded cause, so this row does not claim one. " + _HELD_TAIL),
    }
    _HELD_REMEDY = {
        "profile-off": ("Turn the de-identification profile on, or take 'deidentify' off "
                        "the rule that routes to %(name)s. Either edit releases them on the "
                        "next Auto-send pass, and the studies are all still there."),
        "no-deidentifier": ("Do NOT turn the profile off — that does not release anything, "
                            "it only changes which half is stopping the scrub. Fix the "
                            "de-identification settings until one can be built (the failure "
                            "is in the log, on the send channel) and the next Auto-send pass "
                            "releases them, studies and all. Taking 'deidentify' off the rule "
                            "that routes to %(name)s also releases them — as IDENTIFIED "
                            "copies, which is the one outcome this hold exists to prevent."),
        "": ("Look at the de-identification profile. If it is 'off', turning it on releases "
             "them; if it is on, nothing could be built to scrub with and the send channel "
             "carries that failure. Either way the next Auto-send pass re-records these rows "
             "with the cause. Taking 'deidentify' off the rule that routes to %(name)s "
             "releases them too — as IDENTIFIED copies."),
    }

    def stuck_sends(self, detail: bool = False, _actionable: Optional[dict] = None) -> dict:
        """Everything sitting in the outgoing folder that is not moving, in three
        deliberately separate lists.

        *detail* adds ``items`` to each row — the sampled files with the patient,
        accession and study description read from their headers — for the
        panel. The badge and the failover monitor call this every poll and leave
        it off, since it costs a header read per sampled file. *_actionable*, when
        given, collects every orphaned or held file (absolute path -> list) so
        the discard and send actions can refuse anything this listing would not
        have shown.

        ``destinations`` — the original stuck panel, unchanged: a forward to a
        node that is STILL enabled has FAILED at least once and is waiting out
        its backoff. Freshly-queued (never-attempted) files are not 'stuck'.
        These retry themselves; the list exists so an operator can see which
        node is down, why, and hit Retry.

        ``orphaned`` — studies routed to a name that is no longer an enabled
        destination and never accepted it: a hold-and-forward pin, or a route
        recorded before the node was renamed/deleted/disabled. The watcher will
        not archive or delete these (retention beats deletion for images), and
        NOTHING retries them either — there is no node left to dial. That makes
        them the one failure mode here with no self-correcting end: the outgoing
        folder grows without bound and, before this list existed, the only trace
        was a log line every fifteen minutes while the panel above reported
        zero. They are reported apart from the backoff-stuck rows because the
        operator action is different — restore the node, or accept the loss —
        and because a Retry button would be a lie on them.

        ``held`` — destinations a rule asks to de-identify for while nothing can
        perform the scrub. These were invisible to BOTH lists above, and not by
        accident: a held destination is never dialled, so it never fails and the
        backoff list cannot see it, and record_route deliberately keeps it out of
        entry["route"], so the orphan list cannot either. The measured result was
        an entry reading ``{"route": [], "held": ["Research"], "sent": []}`` with
        the panel reporting zero while the outgoing folder grew without bound —
        the third time in this project that work was held back correctly and the
        screen the operator watches said everything was fine. Unlike an orphan
        this one has a remedy and it is one edit, so the row carries it — and it
        carries the row's own ``cause``, because there are two ways to reach a
        hold and they take OPPOSITE remedies. Told to turn a profile on that is
        already on, the only other move the message offers is taking the scrub
        off the rule, which forwards the study identified.

        All three lists are per-destination-name and each row names files, so the
        dashboard can render each as its own section without touching the
        contract of the others."""
        import time

        from . import routing
        want = self._enabled_dest_names()
        per: dict = {}
        orphans: dict = {}
        holds: dict = {}
        files = 0
        orphan_files = 0
        held_files = 0
        attention = 0
        now = time.time()
        for path, e in self.watcher.state.all_entries().items():
            if not os.path.exists(path):
                continue
            sent = set(e.get("sent", []))
            fails = e.get("fail", {}) or {}
            pins = set(e.get("pin") or [])
            stuck_here = False
            # A file owes only the nodes it was routed to. An entry with no
            # recorded route has never been through a send pass, so fall back to
            # the enabled set rather than report it as owing nothing.
            need = routing.wanted_from(e, want)
            for dname in (want if need is None else need):
                if dname in sent:
                    continue
                f = fails.get(dname)
                if not f:
                    continue                       # queued but not yet failed
                stuck_here = True
                agg = per.setdefault(dname, {"name": dname, "instances": 0,
                                             "attempts": 0, "last_error": "", "next_try": float("inf"),
                                             "files": [], "more": 0})
                agg["instances"] += 1
                self._stuck_sample(agg, path, detail)
                agg["attempts"] = max(agg["attempts"], int(f.get("attempts", 0)))
                agg["last_error"] = f.get("last_error", "") or agg["last_error"]
                agg["next_try"] = min(agg["next_try"], float(f.get("next_try", 0) or 0))
            # The names `need` above cannot see, because the intersection with
            # the live enabled set is exactly what drops them: routed, never
            # accepted, and gone from the config. This is the watcher's archive
            # condition 4 read from the outside.
            orphan_here = False
            for dname in (e.get("route") or []):
                if dname in want or dname in sent:
                    continue
                orphan_here = True
                agg = orphans.setdefault(dname, {"name": dname, "instances": 0,
                                                 "pinned": False, "pinned_files": 0,
                                                 "files": [], "more": 0})
                agg["instances"] += 1
                # A pin is a promise somebody already made on this study's
                # behalf (hold-and-forward owes the primary every held
                # instance), so it is worth telling apart from an ordinary route
                # the config outgrew — and they are not the same situation at
                # all: the pinned copies are held for good, the rest drain on the
                # next pass. Counted, not just flagged, because one row can hold
                # both kinds and the message has to say how many of each.
                if dname in pins:
                    agg["pinned_files"] += 1
                    agg["pinned"] = True
                self._stuck_sample(agg, path, detail)
                if _actionable is not None:
                    _actionable.setdefault(os.path.abspath(path), []).append("orphaned")
            # The names no list above can reach, because nothing was ever
            # attempted for them and they were kept out of the route on purpose.
            held_here = False
            for dname in (e.get("held") or []):
                if dname in sent:
                    # Delivered under an earlier, working profile and only held
                    # now. The FILE is correctly not done (fully_sent refuses a
                    # recorded hold), but this node has the study, and a row
                    # saying otherwise sends the operator chasing a delivery that
                    # already happened.
                    continue
                held_here = True
                agg = holds.setdefault(dname, {"name": dname, "instances": 0,
                                               "files": [], "more": 0, "cause": None})
                agg["instances"] += 1
                # Per ROW, and only while every entry under it agrees. One
                # destination can collect instances held under both causes — the
                # profile was off this morning, it is on now and nothing builds —
                # and a row that picked the first cause it saw would prescribe a
                # remedy for half its own files. `None` is "nothing seen yet",
                # and anything that disagrees with what is already there settles
                # the row on "" (see _HELD_REASON): stating no cause is honest,
                # stating the wrong one is what this round is repairing.
                cause = str(e.get("hold_cause", "") or "")
                agg["cause"] = cause if agg["cause"] is None else (
                    agg["cause"] if agg["cause"] == cause else "")
                self._stuck_sample(agg, path, detail)
                if _actionable is not None:
                    _actionable.setdefault(os.path.abspath(path), []).append("held")
            if stuck_here:
                files += 1
            if orphan_here:
                orphan_files += 1
            if held_here:
                held_files += 1
            if stuck_here or orphan_here or held_here:
                attention += 1
        dests = sorted(per.values(), key=lambda x: -x["instances"])
        for d in dests:
            d["next_in"] = max(0, int(d.pop("next_try") - now))
        orphaned = sorted(orphans.values(), key=lambda x: -x["instances"])
        # A pinned orphan and an unpinned one are different situations with
        # different remedies and different deadlines, so the row says which one
        # it is. The single sentence this replaces promised the pinned case's
        # protection to both — "they will not be archived or deleted" — which is
        # simply untrue of an unpinned file: the next pass re-routes it without
        # the departed name, drops it from the route, and files (or with
        # on_success=delete, destroys) it having never reached that node. An
        # operator who checks and finds the danger overstated learns to skip the
        # message; one who trusts it here loses the study while reading it.
        for o in orphaned:
            held = o["pinned_files"]
            loose = o["instances"] - held
            msg = ("%s is not an enabled destination any more, but %d file(s) in the "
                   "outgoing folder were routed to it and never reached it. Nothing "
                   "retries them — there is no node left to dial."
                   % (o["name"], o["instances"]))
            if held:
                msg += (" %d %s pinned: a hold-and-forward copy promised to that node "
                        "while it was offline. Pinned files are held in the outgoing "
                        "folder indefinitely — never archived, never deleted — until you "
                        "restore a node under the same name to drain them, or delete the "
                        "files to accept the loss." % (held, "is" if held == 1 else "are"))
            if loose:
                msg += (" %d %s not pinned, and nothing holds an unpinned file: the next "
                        "Auto-send pass re-routes it without %s, then archives or deletes "
                        "it under the current on-success setting, having never reached "
                        "that node. Restoring the node only helps until that pass runs."
                        % (loose, "is" if loose == 1 else "are", o["name"]))
            o["message"] = msg
        held_rows = sorted(holds.values(), key=lambda x: -x["instances"])
        for h in held_rows:
            # An unrecognised token from a newer engine (or a hand-edited state
            # file) reads as "no agreed cause" rather than as a KeyError on a
            # read-only panel — and the "" texts assert nothing it cannot back.
            cause = h["cause"] if h["cause"] in self._HELD_REASON else ""
            h["cause"] = cause
            h["reason"] = self._HELD_REASON[cause] % {"name": h["name"]}
            h["remedy"] = self._HELD_REMEDY[cause] % {"name": h["name"]}
            # The two together, for a panel that draws one line per row.
            h["message"] = h["reason"] + " " + h["remedy"]
        return {"destinations": dests, "files": files,
                "orphaned": orphaned, "orphaned_files": orphan_files,
                "held": held_rows, "held_files": held_files,
                "attention_files": attention}

    def _stuck_sample(self, agg: dict, path: str, detail: bool) -> None:
        """Add one file to a stuck row's bounded sample (the rest are counted)."""
        if len(agg["files"]) >= self._ORPHAN_SAMPLE:
            agg["more"] += 1
            return
        agg["files"].append(os.path.basename(path))
        if detail:
            agg.setdefault("items", []).append(self._stuck_item(path))

    def _stuck_item(self, path: str) -> dict:
        """Who a stuck file belongs to, for the panel: one header read, pixels
        skipped, cached on (path, mtime) so a refresh of an unchanged queue reads
        nothing. ``rel`` is the handle the discard and send actions take — a path
        inside the outgoing folder, or "" for a file outside it (the folder was
        moved since the file was queued), which no action will touch."""
        from .dicomfs import safe_within
        from .history import _fmt_name, _read_header
        watch = self.cfg.resolved("scu", "watch_dir")
        rel = os.path.relpath(path, watch) if safe_within(watch, path) else ""
        try:
            key = (path, os.path.getmtime(path))
        except OSError:
            key = None
        cache = getattr(self, "_stuck_headers", None)
        if cache is None:
            cache = self._stuck_headers = {}
        ident = cache.get(key) if key else None
        if ident is None:
            hdr = _read_header(path)
            ident = {
                "patient": _fmt_name(getattr(hdr, "PatientName", "")) if hdr else "",
                "patient_id": str(getattr(hdr, "PatientID", "") or "") if hdr else "",
                "accession": str(getattr(hdr, "AccessionNumber", "") or "") if hdr else "",
                "study_desc": str(getattr(hdr, "StudyDescription", "") or "") if hdr else "",
                "study_uid": str(getattr(hdr, "StudyInstanceUID", "") or "") if hdr else "",
            }
            if key:
                if len(cache) > 2000:     # bounded: a queue that drained leaves stale keys
                    cache.clear()
                cache[key] = ident
        return {"file": os.path.basename(path), "rel": rel, **ident}

    def stuck_count(self) -> int:
        """Files needing an operator's attention — backoff-stuck, orphaned and
        held, counted once each even when a file is more than one. This is the
        badge: an orphaned study that nothing will ever retry, or a held one that
        no timer releases, has to raise it — or the panel that now lists it is
        behind a "0" nobody clicks."""
        return self.stuck_sends()["attention_files"]

    def retry_stuck(self, dest: Optional[str] = None) -> dict:
        """Clear the retry backoff so the next watcher pass attempts immediately
        (all stuck destinations, or just `dest`)."""
        names = {dest} if dest else None
        n = self.watcher.state.clear_backoff(names)
        self.watcher.state.save()
        if not self.watcher.running:
            return {"ok": True, "reset": n,
                    "message": f"Cleared backoff on {n} item(s) — start Auto-send to retry them."}
        return {"ok": True, "reset": n, "message": f"Retrying {n} item(s) now…"}

    def _resolve_stuck_files(self, files) -> tuple:
        """Map the panel's file handles to absolute paths, or say why not.

        Only a file the stuck listing itself reports as orphaned or held is
        accepted: these actions delete and transmit, and the handle comes from a
        request body. Anything else — a path outside the outgoing folder, a
        traversal, a file that is merely queued or still retrying on its own —
        refuses the whole request rather than acting on part of it."""
        from .dicomfs import safe_within
        if not isinstance(files, list) or not files:
            return None, "send 'files': the stuck files to act on"
        watch = self.cfg.resolved("scu", "watch_dir")
        actionable: dict = {}
        self.stuck_sends(_actionable=actionable)
        out = []
        for rel in files:
            if not isinstance(rel, str) or not rel.strip() or os.path.isabs(rel):
                return None, f"not a stuck file: {rel!r}"
            fp = os.path.abspath(os.path.join(watch, rel))
            if not safe_within(watch, fp) or fp not in actionable:
                return None, f"not an orphaned or held file in the outgoing folder: {rel}"
            if fp not in out:
                out.append(fp)
        return out, ""

    def discard_stuck(self, files) -> dict:
        """Delete orphaned/held files from the outgoing folder — the operator
        accepting that they will never reach the node they were routed to."""
        from .dicomfs import prune_empty_dirs
        from . import routing
        paths, why = self._resolve_stuck_files(files)
        if paths is None:
            return {"ok": False, "message": why, "error": why, "field": "files"}
        # Orphaned/held is about ONE name on the entry; the same file can still
        # owe a live node (routed to PACS-A and to a deleted node, or held for
        # Research while PACS-A retries). Deleting it would lose that delivery
        # too, so such a file refuses the whole request — the operator discards
        # it once the live node has it. Refusing rather than trimming the dead
        # name off the entry: the next pass re-records route/held from the rules
        # and would put it straight back.
        want = self._enabled_dest_names()
        owing: set = set()
        n = 0
        for fp in paths:
            e = self.watcher.state.peek(fp) or {}
            need = routing.wanted_from(e, want)
            # None = never routed: it owes whatever is enabled, like stuck_sends.
            left = (set(want) if need is None else need) - set(e.get("sent", []))
            if left:
                n += 1
                owing |= left
        if owing:
            why = (f"{n} of these file(s) still have to reach "
                   f"{', '.join(sorted(owing))}; nothing was removed. They are delivered "
                   f"there on their own — discard them once that is done.")
            return {"ok": False, "message": why, "error": why, "field": "files",
                    "owing": sorted(owing)}
        watch = self.cfg.resolved("scu", "watch_dir")
        removed = 0
        for fp in paths:
            try:
                os.remove(fp)
            except FileNotFoundError:
                pass
            except OSError as exc:
                self.log.warn(f"Could not remove stuck file {os.path.basename(fp)}: {exc}",
                              kind="send")
                continue
            removed += 1
            self.watcher.state.drop(fp)
            if self.index is not None:
                self.index.remove_file(fp)
            prune_empty_dirs(os.path.dirname(fp), watch)
        self.watcher.state.save()
        self.log.warn(f"Discarded {removed} stuck file(s) from the outgoing folder", kind="send")
        return {"ok": True, "removed": removed, "message": f"Removed {removed} file(s)"}

    def send_stuck(self, files, destination: str) -> dict:
        """One-off forward of orphaned/held files to a destination the operator
        picks. The files stay in the outgoing folder (remove them once the copy
        is confirmed), and de-identification is honoured: a destination any rule
        scrubs for gets a scrubbed copy or nothing."""
        from . import routing
        from .deid import Deidentifier, deidentified_tempfile
        from .scu import Destination, c_store
        name = str(destination or "").strip()
        dests = [Destination.from_dict(d) for d in self.cfg.enabled_destinations()]
        nodes = routing.resolve_all(dests, [name]) if name else []
        if not nodes:
            why = f"'{name}' is not an enabled destination" if name else "pick a destination"
            return {"ok": False, "message": why, "error": why, "field": "destination"}
        paths, why = self._resolve_stuck_files(files)
        if paths is None:
            return {"ok": False, "message": why, "error": why, "field": "files"}
        router = routing.Router.from_config(self.cfg, None)
        # Scrubbed if ANY rule scrubs for this node, not only one matching this
        # file: the operator is sending outside the rules, and the node's own
        # promise is the only one left to keep.
        summary = router.deid_summary()
        if name in summary["held"]:
            why = (f"{name} is held: a routing rule asks for de-identification and the "
                   f"profile is off, so nothing is sent to it")
            return {"ok": False, "message": why, "error": why, "field": "destination"}
        scrub = name in summary["destinations"]
        deider = None
        if scrub:
            try:
                deider = Deidentifier.from_config(self.cfg, self.log)
            except Exception as exc:
                deider = None
                self.log.error(f"Stuck send: could not build the de-identifier ({exc})", kind="send")
            if not routing.usable_deidentifier(deider):
                why = (f"{name} needs a de-identified copy and no de-identifier can be built "
                       f"from the current settings — nothing was sent")
                return {"ok": False, "message": why, "error": why, "field": "destination"}
        ctx = None
        if any(d.tls for d in nodes):
            try:
                ctx = self._scu_tls_context()
            except Exception as exc:
                return {"ok": False, "message": f"TLS config error: {exc}"}
        aet = self.cfg.scu.get("aet", "CARINOSCU")

        def _run():
            ok = fail = 0
            for fp in paths:
                try:
                    with deidentified_tempfile(fp, deider if scrub else None) as payload:
                        for d in nodes:
                            res = c_store(d, payload, aet, tls_context=ctx)
                            if res.ok:
                                ok += 1
                                self.log.info(f"Sent {os.path.basename(fp)} -> {d.name}", kind="send")
                            else:
                                fail += 1
                                self.log.warn(f"Send {os.path.basename(fp)} -> {d.name}: "
                                              f"{res.message}", kind="send")
                except Exception as exc:
                    fail += len(nodes)
                    self.log.error(f"Send {os.path.basename(fp)}: {exc}", kind="send")
            (self.log.info if not fail else self.log.warn)(
                f"Stuck files sent to {name}: {ok} ok, {fail} failed — they stay in the "
                f"outgoing folder until removed", kind="send")

        threading.Thread(target=_run, name="pacs-stuck-send", daemon=True).start()
        return {"ok": True, "files": len(paths),
                "message": f"Sending {len(paths)} file(s) to {name}…"}

    # ---- disk headroom on the storage volume ------------------------------
    def _disk_status(self) -> dict:
        import shutil as _sh
        path = self.cfg.resolved("scp", "storage_dir")
        probe = path if os.path.isdir(path) else (os.path.dirname(path) or ".")
        floor_gb = float(self.cfg.scp.get("min_free_gb", 2) or 0)
        try:
            u = _sh.disk_usage(probe)
            free_gb = u.free / (1024 ** 3)
            return {
                "path": path,
                "free_gb": round(free_gb, 1),
                "total_gb": round(u.total / (1024 ** 3), 1),
                "free_pct": round(100 * u.free / u.total, 1) if u.total else 0,
                "floor_gb": floor_gb,
                "low": bool(floor_gb > 0 and free_gb < floor_gb),
            }
        except OSError:
            return {"path": path, "free_gb": None, "low": False, "floor_gb": floor_gb}

    # ---- the doors de-identify-on-forward does not cover --------------------
    # Tokens, not sentences: the dashboard owns the wording (and translates it),
    # the engine owns the fact. Q/R and DICOMweb hand out what is on disk —
    # qr.py's C-MOVE and C-GET stream the stored file, and WADO-RS reads the same
    # bytes — so nothing in a retrieval path consults deid.profile or a routing
    # rule. That is defensible on its own (a scrub is a property of a forward,
    # and a retrieval is not one), and it is dangerous NEXT TO the
    # de-identification panel, which names a node under "de-identified for" while
    # this PACS is open for that same node to pull the originals from. An
    # operator opening Q/R to a research node has to know which of the two doors
    # they are opening.
    def _raw_retrieval(self) -> list:
        """Which retrieval services are serving stored instances unscrubbed."""
        open_doors = []
        if bool(self.cfg.qr.get("enabled", False)):
            open_doors.append("qr")
        if bool(self.cfg.dicomweb.get("enabled", False)):
            open_doors.append("dicomweb")
        return open_doors

    def index_status(self) -> dict:
        """Index block for the dashboard: live handles read every time, size
        figures reused for _INDEX_STATS_TTL seconds (see the constant)."""
        icfg = self.cfg.index
        block = {
            "enabled": bool(icfg.get("enabled", True)),
            "path": self.cfg.resolved("index", "path"),
            "rescan_on_start": bool(icfg.get("rescan_on_start", True)),
            "scanning": bool(self._index_thread and self._index_thread.is_alive()),
            "files": 0, "instances": 0, "series": 0, "studies": 0, "patients": 0,
            "bytes": 0, "db_bytes": 0, "groups": {}, "errors": 0,
            "queued": 0, "writing": False, "rebuilt": False,
        }
        idx = self.index
        if idx is None:
            return block
        now = time.time()
        if now - self._index_stats_at > _INDEX_STATS_TTL:
            try:
                self._index_stats = idx.stats()
                self._index_stats_at = now
            except Exception as exc:
                self.log.warn(f"Could not read index stats: {exc}", kind="index")
        block.update(self._index_stats)
        # Backlog and writer health are the two figures a stale reading would
        # actually mislead about, and both are attribute reads.
        q = getattr(idx, "_q", None)
        block["queued"] = q.qsize() if q is not None else 0
        block["writing"] = idx.writing
        block["errors"] = idx.errors
        return block

    def held_remaining(self) -> Optional[int]:
        """Instances hold-and-forward still owes a primary, counted only while
        an emergency is on the air or recovering (None otherwise) — the number
        that tells the operator when Resume is safe."""
        if getattr(self.emergency, "state", "") not in (EMG_ACTIVE, EMG_RECOVERING):
            return None
        n = 0
        for path, entry in self.watcher.state.all_entries().items():
            sent = set(entry.get("sent") or [])
            if any(p not in sent for p in (entry.get("pin") or [])) and os.path.exists(path):
                n += 1
        return n

    def status(self) -> dict:
        from . import ingest
        scp = self.scp
        pscp = self.print_scp
        pr = self.cfg.printer
        ris = self.ris
        rcfg = self.cfg.ris
        mwl = self.mwl_scp
        mcfg = self.cfg.mwl
        qr = self.qr_scp
        qcfg = self.cfg.qr
        stuck = self.stuck_sends()
        return {
            "receiver": {
                "enabled": bool(self.cfg.scp.get("enabled", False)),   # enrolled
                "running": bool(scp and scp.running),                  # bound right now
                "aet": self.cfg.scp["aet"],
                "bind": self.cfg.scp.get("bind", "0.0.0.0"),
                "port": self.cfg.scp["port"],
                "storage_dir": self.cfg.resolved("scp", "storage_dir"),
                "organize": self.cfg.scp.get("organize", True),
                "received": scp.received_count if scp else 0,
                "errors": scp.error_count if scp else 0,
                "refused": scp.refused_count if scp else 0,
                # Origin of the three counters above (and of `last`): the epoch
                # THIS receiver object was built, not the process start — a save
                # or a Start replaces it and zeroes them. No receiver has ever
                # run in this process yet: the counters are 0 since boot.
                "since": int(scp.started_at) if scp else int(self.started_at),
                "tls": bool(self.cfg.scp.get("tls", False)),
                "tls_mutual": bool(self.cfg.scp.get("tls", False) and self.cfg.scp.get("tls_ca", "")),
                # Last instance THIS receiver object stored; null means either
                # no receiver has ever run in this process or none has arrived
                # since it started — running/enabled tell those apart.
                "last": scp.last_stored if scp else None,
                # The newest refusal or error of this listener, {message, at},
                # kept by the log so it outlives a Stop/Start and a Save.
                "last_problem": self.log.last_problem("scp", "store"),
            },
            "printer": {
                "enabled": bool(pr.get("enabled", False)),
                "running": bool(pscp and pscp.running),
                "aet": pr.get("aet", "CARINOPRINT"),
                "bind": pr.get("bind", "0.0.0.0"),
                "port": int(pr.get("port", 11113)),
                "color": bool(pr.get("color", False)),
                "layout": pr.get("layout", "pdf"),
                "printed": pscp.printed_count if pscp else 0,
                "errors": pscp.error_count if pscp else 0,
                # What the card says when a modality reports a failed print:
                # the last refusal/failure in plain words, and the last film
                # that did arrive, so "is it working?" has an answer.
                # From the log rather than the object so a failed start counts
                # too; the object's own copy says the same about a print.
                "last_problem": self.log.last_problem("print"),
                "last_print": pscp.last_print if pscp else None,
                "tls": bool(pr.get("tls", False)),
                "tls_mutual": bool(pr.get("tls", False) and pr.get("tls_ca", "")),
                "since": int(self._counter_since.get("printer", self.started_at)),
            },
            "watcher": {
                **self.watcher.stats(),                                # carries last_sent
                "enabled": bool(self.cfg.scu.get("enabled", False)),
                "watch_dir": self.cfg.resolved("scu", "watch_dir"),
                "aet": self.cfg.scu.get("aet", "CARINOSCU"),
                "on_success": self.cfg.scu.get("on_success", "keep"),
                "poll_interval": self.cfg.scu.get("poll_interval", 3),
                "tls_verify": bool(self.cfg.scu.get("tls_verify", True)),
                # sent/failed count since the process started: the watcher object
                # is built once and survives every save, unlike the receiver.
                "since": int(self.started_at),
            },
            # The station list: names and AE titles of this department's own
            # equipment — no address, no credential, no PHI — and the order form
            # needs it to offer a target to whoever keys orders in, which is the
            # profile with the fewest capabilities of any. It used to be ungated
            # on that argument. It is now gated on orders.read (web._STATUS_GATES),
            # which is the same argument said properly: the room list is what an
            # order is aimed at, so it belongs to whoever handles orders, and a
            # profile that may not even see an order has no business enumerating
            # the department's equipment. Reception holds orders.read, so nothing
            # the argument was made for loses anything; see order_stations(),
            # which is the same list served on its own for the order form.
            "modalities": self.station_list(),
            "site_modalities": list(self.cfg.ris.get("modalities") or []),
            "ris": {
                "enabled": bool(rcfg.get("enabled", False)),
                "running": bool(ris and ris.running),
                "bind": rcfg.get("bind", "0.0.0.0"),
                "port": int(rcfg.get("port", 2575)),
                "match_on": rcfg.get("match_on", "accession"),
                "auto_close": bool(rcfg.get("auto_close", True)),
                "received": ris.received_count if ris else 0,
                "orders_in": ris.order_count if ris else 0,
                # A live feed does not only create. Amendments and cancellations
                # used to arrive as duplicate orders; now they land on the order
                # they are about, and these say how often that happens.
                "orders_amended": ris.updated_count if ris else 0,
                "orders_cancelled": ris.cancelled_count if ris else 0,
                "orders_noop": ris.noop_count if ris else 0,
                "errors": ris.error_count if ris else 0,
                "last_problem": self.log.last_problem("ris"),
                # Anchors received/orders_in/errors ONLY. `counts` below comes
                # from the persisted store and survives restarts entirely — it
                # is a current state, not a window, and has no origin to give.
                "since": int(self._counter_since.get("ris", self.started_at)),
                "counts": self.orders.counts(),
                # A tick to diff, never a number to display: monotonic over the
                # life of the STORE, so it is carried across a restart rather
                # than starting over at 0 — a dashboard that was up all shift
                # would otherwise adopt the smaller value in silence and eat
                # every order the new process had already taken. It counts real
                # orders CREATED (manual + HL7) and nothing else, so a dashboard
                # can tell "an order just arrived" from "an order just closed" without
                # diffing counts that fall on a purge. Deliberately not written
                # `if ris else 0`: the store is live even with the HL7 listener
                # stopped (see the note below), and a receptionist typing an
                # order during an outage is the primary case this exists for.
                "created_seq": self.orders.created_seq,
                # The store is always live (manual entry works with the listener
                # stopped), so these are real whatever "running" says.
                "last_order": _order_brief(
                    self.orders.latest("open"),
                    # `origin` travels with the brief so the dashboard can tell a
                    # test order from a real one on the enum (ris.ORIGINS) rather
                    # than by matching `source`, which is a display string that
                    # is free to be reworded or translated at any time.
                    ("id", "accession", "patient", "patient_id", "modality",
                     "study_desc", "created", "source", "status", "origin")),
                # Orders in without orders matched cannot answer whether
                # reconciliation — the whole point of the RIS — is working.
                "last_closed": _order_brief(
                    self.orders.latest("closed", by="closed"),
                    ("id", "accession", "patient", "created", "closed",
                     "close_reason", "matched_study")),
            },
            "mwl": {
                "enabled": bool(mcfg.get("enabled", False)),
                "running": bool(mwl and mwl.running),
                "aet": mcfg.get("aet", "CARINOMWL"),
                "bind": mcfg.get("bind", "0.0.0.0"),
                "port": int(mcfg.get("port", 11114)),
                "queries": mwl.query_count if mwl else 0,
                "matches": mwl.match_count if mwl else 0,
                "errors": mwl.error_count if mwl else 0,
                "since": int(self._counter_since.get("mwl", self.started_at)),
                "tls": bool(mcfg.get("tls", False)),
                "tls_mutual": bool(mcfg.get("tls", False) and mcfg.get("tls_ca", "")),
                "last_problem": self.log.last_problem("mwl"),
                "wanted": self.worklist_wanted(),   # permanent (enabled or a no_ris destination)
            },
            "qr": {
                "enabled": bool(qcfg.get("enabled", False)),
                "running": bool(qr and qr.running),
                "aet": qcfg.get("aet", "CARINOQR"),
                "bind": qcfg.get("bind", "0.0.0.0"),
                "port": int(qcfg.get("port", 11115)),
                "queries": qr.query_count if qr else 0,
                "matches": qr.match_count if qr else 0,
                "moves": qr.move_count if qr else 0,
                "gets": qr.get_count if qr else 0,
                "sent": qr.sent_count if qr else 0,
                "move_failures": qr.move_failures if qr else 0,
                "errors": qr.error_count if qr else 0,
                # QrSCP carries its own started_at, like the receiver: it is
                # rebuilt by a save that changes its settings, and its
                # counters restart with it.
                "since": int(qr.started_at) if qr else int(self.started_at),
                "tls": bool(qcfg.get("tls", False)),
                "tls_mutual": bool(qcfg.get("tls", False) and qcfg.get("tls_ca", "")),
                # C-MOVE names a destination by AE title; these are the ones we
                # can resolve without falling back to the destination list.
                "destinations": sorted(qcfg.get("move_destinations", {}) or {}),
                "last": qr.last_query if qr else None,
                "last_problem": self.log.last_problem("qr"),
            },
            "index": self.index_status(),
            "dicomweb": {
                "enabled": bool(self.cfg.dicomweb.get("enabled", False)),
                "allow_stow": bool(self.cfg.dicomweb.get("allow_stow", True)),
                "url": "/dicom-web",
                # The blueprint hands its counters over when the web layer
                # registers it; a headless run has none and says so with zeros.
                **(self.dicomweb.snapshot() if self.dicomweb is not None else
                   {"since": int(self.started_at), "queries": 0, "retrieved": 0,
                    "stored": 0, "failed": 0, "errors": 0}),
            },
            "routing": {
                "enabled": bool(self.cfg.routing.get("enabled", False)),
                # Names only. The rules themselves are in /api/config; this block
                # is polled every two seconds and only has to say "is it on, and
                # is anything actually configured".
                "rules": [str(r.get("name", "")) for r in (self.cfg.routing.get("rules") or [])
                          if isinstance(r, dict)],
            },
            "deid": {
                # `profile` comes from _deid_state() below with the rest of the
                # de-identification answer, so this block cannot report a profile
                # that disagrees with the destinations it lists under it.
                "keep_private": bool(self.cfg.deid.get("keep_private", False)),
                "keep_dates": bool(self.cfg.deid.get("keep_dates", False)),
                "prefix": self.cfg.deid.get("prefix", "ANON"),
                # Whether a site key is set, never the key: it is what makes the
                # pseudonyms unguessable, and this payload goes to a browser.
                "secret_set": bool(str(self.cfg.deid.get("secret", "") or "").strip()),
                # `destinations` (scrubbed for), `held` (a rule asks and nothing
                # can scrub) and `hold_cause` (which of the two ways that
                # happened) come from the routing engine settled against the
                # de-identifier that would actually run — never from a second
                # reading of the rules here, and never from the summary alone.
                # This block was that second reading, and it listed every rule
                # destination as de-identified whatever the profile said; then it
                # was the summary, and it listed a node as de-identified while a
                # profile that was ON had nothing buildable behind it. Both times
                # the dashboard told the operator studies were being scrubbed
                # while the senders held them.
                **_deid_state(self.cfg),
                # The doors a scrub does NOT cover, listed while they are open.
                # De-identify-on-forward happens in the sender, on a temp copy,
                # on the way to a destination a rule names; C-MOVE, C-GET and
                # WADO-RS all serve the stored file as it was received. A node
                # this block names under `destinations` and that is also allowed
                # to PULL takes the identified original through the other door,
                # and nothing on this screen said so.
                "retrieval_raw": self._raw_retrieval(),
                # `destinations` and `held` above describe the config as it is
                # NOW. A manual send that started before the last save is not
                # covered by them — it runs frozen — so a send that noticed the
                # answer move underneath it says so here, next to the answer it
                # no longer matches. Without this the block would report a
                # destination as scrubbed-for while an in-flight send was
                # withholding it, and nothing on the dashboard would explain the
                # study that stopped halfway.
                "superseded_sends": self.stale_sends(),
            },
            "emergency": {**self.emergency.status(), "held_remaining": self.held_remaining()},
            # Present ONLY when this process was started with --dev-peer, so a
            # dashboard that never sees this key hides the panel entirely.
            # Here rather than in web.py's _status_for because that function
            # only re-composes what status() returned — a block added there
            # would be invisible to every consumer that is not the dashboard.
            **({"dev_peer": self.dev_peer.status()} if self.dev_peer is not None else {}),
            "destinations": self.cfg.destinations,
            "config_path": self.cfg.path,
            # "" when the stored config would validate. Non-empty means it was
            # hand-edited into a state a Save would refuse and is being used
            # anyway — see the comment on Config.load() for why that is the
            # deliberate choice, and __init__ for the log line that goes with it.
            "config_problem": self.config_problem,
            "logs_dir": self.cfg.logs_dir,
            "host_ip": self._local_ip(),
            "host_ips": self._local_ips(),
            # Current-state figures, NOT counters: pending is a live count of the
            # review folder, stuck a live count of failed outgoing items, disk a
            # reading of the volume right now, and ris.counts comes from the
            # persisted order store. None of them carries a `since`, because none
            # of them describes a window — that absence is how the dashboard
            # tells them apart from received/sent, which do.
            "pending": ingest.count_pending(self._pending_dir()),
            "stuck": stuck["attention_files"],
            # Per destination: what its forwards are doing right now. Overview
            # draws a node whose sends keep failing as failing, instead of the
            # "Not checked" a node outside the failover probe would otherwise get.
            "stuck_by_dest": {d["name"]: {"instances": d.get("instances", 0),
                                          "last_error": d.get("last_error", "")}
                              for d in stuck.get("destinations", [])},
            "disk": self._disk_status(),
            "editor_url": self.cfg.web.get("editor_url", ""),
            # Same epoch base as a log entry. This is when the PROCESS started —
            # it is uptime's origin, not the counters': each block above carries
            # its own `since`, because a save that changes a service rebuilds the
            # object behind it.
            "started_at": int(self.started_at),
            "uptime_sec": int(time.time() - self.started_at),
            "setup": self.setup_state(),
            "update": self.update_state(),
            # Published, not merely logged. A trail that stopped recording looks
            # exactly like a quiet week, and the dashboard has to be able to say
            # which it is. Carries `head` too, which is the digest an external
            # monitor anchors — see the note at the top of pacs/audit.py about
            # what a chain kept on the same box can and cannot prove.
            "audit": self.audit.stats(),
            # Whether anybody is actually being reached. "enabled but
            # nothing sent and three failed" is the state an operator has
            # to be able to see BEFORE the outage that depends on it.
            "notify": self.notifier.stats(),
        }

    def shutdown(self) -> None:
        # First, and inside shutdown() rather than in an atexit handler: POST
        # /api/shutdown calls this and then os._exit(0), which runs no atexit
        # handler and no finally block. The dashboard's own Stop button is the
        # most common shutdown on an appliance, so an atexit-only discard would
        # leak a carino-peer-* tree — index, test studies and all — every single
        # session. Before the services come down because discard() also rewrites
        # this config's destinations and wants the primary intact while it does.
        # discard() is idempotent and never raises: shutdown() runs twice on the
        # /api/shutdown path, and an exception here would skip stop_index() and
        # drop the index writer's backlog.
        if self.dev_peer is not None:
            self.dev_peer.discard()
        self.emergency.stop()
        self.stop_watcher()
        self.stop_receiver()
        self.stop_printer()
        self.stop_ris()
        self.stop_mwl()
        self.stop_qr()
        # Last: the index writer drains its backlog on stop, and everything
        # above is still feeding it until it is down.
        self.stop_index()
