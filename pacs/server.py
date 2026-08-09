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
from .emergency import EmergencyController
from .index import InstanceIndex
from .logbuf import LogBuffer
from .mwl import MwlSCP
from .notify import Notifier
from .print_scp import PrintSCP
from .qr import QrSCP
from . import ris
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


class PacsServer:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        # When this process started: the origin for uptime and for the counters
        # of objects that outlive a save (the watcher is built once, here).
        self.started_at = time.time()
        # Counter origins for the three services this object REBUILDS on every
        # save and every Start (print/RIS/worklist): their tallies zero with the
        # new object, so each is stamped where it is constructed and reported
        # next to its counters. StorageSCP carries its own started_at.
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
        # The order store is always live (manual entry works even with the HL7
        # listener stopped); the listener is an optional front door onto it.
        self.orders = OrderStore(
            store_dir=cfg.resolved("ris", "store_dir"),
            log=self.log,
            match_on=cfg.ris.get("match_on", "accession"),
        )
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
            idx.stop()

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
            self._counter_since["printer"] = time.time()
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
        ``no_ris`` (that PACS has no RIS, so Carino is its worklist source)."""
        if self.cfg.mwl.get("enabled"):
            return True
        return any(d.get("no_ris") for d in self.cfg.enabled_destinations())

    def sync_worklist(self) -> None:
        """Start the worklist SCP if it's wanted and not already running
        (called on launch and after a config change)."""
        if self.worklist_wanted() and not (self.mwl_scp and self.mwl_scp.running):
            try:
                self.start_mwl()
            except Exception as exc:
                self.log.error(f"Could not start worklist SCP: {exc}", kind="mwl")

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

    def add_order(self, fields: dict) -> dict:
        if not any(str(fields.get(k, "")).strip() for k in ("accession", "patient", "patient_id")):
            return {"ok": False, "message": "an order needs at least an accession, patient name or patient ID"}
        # A test order and a real one behave identically all the way through —
        # that is the point of testing with them — so the only thing separating
        # them is this flag, and it has to be carried rather than guessed.
        testing = bool(fields.get("test"))
        order = self.orders.add(
            fields,
            source="test generator" if testing else "manual",
            origin=ris.ORIGIN_TEST if testing else ris.ORIGIN_MANUAL,
        )
        return {"ok": True,
                "message": "Test order queued" if testing else "Order queued",
                "order": order}

    def update_order(self, oid: str, fields: dict) -> dict:
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
        return {"ok": True, "message": "Order cancelled"}

    def delete_order(self, oid: str) -> dict:
        ok = self.orders.delete(oid)
        return {"ok": ok, "message": "Order deleted" if ok else "order not found"}

    def purge_closed_orders(self) -> dict:
        n = self.orders.purge_closed()
        self.log.info(f"Purged {n} closed RIS order(s)", kind="ris")
        return {"ok": True, "removed": n, "message": f"Removed {n} closed order(s)"}

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
        res = c_echo(d, self.cfg.scu.get("aet", "CARINOSCU"), tls_context=ctx)
        (self.log.info if res.ok else self.log.warn)(
            f"C-ECHO {d.name}: {res.message}", kind="echo"
        )
        return res

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
        return {"group": group, "root": root, "studies": history.scan_studies(root)}

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

    def explain_route(self, group: str, path: str) -> dict:
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

    def approve_pending(self, pid: str, edits: dict) -> dict:
        """Convert a queued file into the outgoing folder so the normal
        auto-send + archive pipeline forwards and files it."""
        from . import ingest
        watch = self.cfg.resolved("scu", "watch_dir")
        try:
            out = ingest.approve_pending(self._pending_dir(), pid, edits or {}, watch)
        except (ValueError, OSError) as exc:
            return {"ok": False, "message": str(exc)}
        except Exception as exc:
            return {"ok": False, "message": f"could not convert: {exc}"}
        if self.index is not None:
            self.index.enqueue_file(out, "outgoing")
        self.log.info(f"Approved review item → {os.path.basename(out)} into outgoing", kind="config")
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
                     edit=None) -> None:
        """Persist a new config from the dashboard and hot-apply it.

        The receiver is bound to a port/AE at start time, so if it is running
        we bounce it; the watcher reads config live, so it just keeps going.
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
        was_receiving = bool(self.scp and self.scp.running)
        was_printing = bool(self.print_scp and self.print_scp.running)
        was_ris = bool(self.ris and self.ris.running)
        was_mwl = bool(self.mwl_scp and self.mwl_scp.running)
        was_qr = bool(self.qr_scp and self.qr_scp.running)
        # ---- the bounce: past this line only exit (b) is left ---------------
        for stop, label, kind in (
            (self.stop_receiver, "receiver", "scp"),
            (self.stop_printer, "print receiver", "print"),
            (self.stop_ris, "RIS listener", "ris"),
            (self.stop_mwl, "worklist SCP", "mwl"),
            (self.stop_qr, "Query/Retrieve SCP", "qr"),
        ):
            # A stop() that throws took the services after it down with it and
            # skipped the restart entirely: config saved, PACS mute. It is a log
            # line now — the socket may or may not have closed, and the start
            # below will say so if it did not.
            self._apply_step(stop, f"stop the {label} for the config change", kind)
        # Nothing on the dashboard draws a failed re-point, so like the run-now
        # case below it is kept and handed to the caller once everything else
        # has been applied.
        first_exc = self._apply_step(
            self._repoint_live_objects, "re-point the live objects at the new config", "config")
        # A plain save restarts whatever was running and also starts anything it
        # newly ENABLES — persisting "enabled: true" and leaving the service
        # stopped would be a trap. It never STOPS a running service, though: the
        # flag is enrollment, and Start on the card (like the CLI overrides) is
        # a deliberate run-now on top of it.
        # An enforcing save only bounces what was running AND stays enrolled. It
        # starts nothing it is disabling — rebinding a port for ~50ms after the
        # operator said "off" is exactly the bounce the chooser exists to avoid —
        # and nothing it newly enables either, so sync_services() below performs
        # each of those transitions once, and reports it.
        for was, enabled, start, label, kind in (
            (was_receiving, self.cfg.scp.get("enabled"), self.start_receiver, "receiver", "scp"),
            (was_printing, self.cfg.printer.get("enabled"), self.start_printer, "print receiver", "print"),
            (was_ris, self.cfg.ris.get("enabled"), self.start_ris, "RIS listener", "ris"),
            (was_qr, self.cfg.qr.get("enabled"), self.start_qr, "Query/Retrieve SCP", "qr"),
        ):
            if not ((was and enabled) if enforce else (was or enabled)):
                continue
            try:
                start()
            except Exception as exc:
                self.log.error(f"Could not start {label}: {exc}", kind=kind)
                # Enabled but not bound is a state the dashboard shows (and the
                # log explains), not a reason to abort a save that is already
                # persisted — the remaining services, the worklist and the health
                # monitor still have to be brought up. A run-now service that is
                # NOT enrolled draws nothing on the dashboard, so for that one
                # case the exception is the only signal the caller will ever get:
                # it is kept and re-raised once everything else has been applied.
                # An enforcing save never reaches here on a disabled service, and
                # sync_services() retries the rest into a results row.
                if was and not enabled and first_exc is None:
                    first_exc = exc
        # The worklist is not in the loop above: worklist_wanted(), not the flag,
        # decides whether it runs, and sync_worklist() starts a wanted one. This
        # is only the run-now case — a worklist nothing wants, kept alive across
        # a plain save the same way the three services above are.
        if was_mwl and not enforce and not self.worklist_wanted():
            try:
                self.start_mwl()
            except Exception as exc:
                self.log.error(f"Could not start worklist SCP: {exc}", kind="mwl")
                if first_exc is None:
                    first_exc = exc
        self.sync_worklist()   # a no_ris destination may now want a permanent worklist
        if self.cfg.scu.get("enabled") and not self.watcher.running and not enforce:
            # The watcher is never bounced (it reads config live), so a newly
            # enrolled one needs its own nudge — except under an enforcing save,
            # where sync_services() starts it and says so.
            try:
                self.start_watcher()
            except Exception as exc:
                self.log.error(f"Could not start watcher: {exc}", kind="watch")
        # Re-sync the health monitor to the new config (armed flag / trigger
        # set). Fenced like everything else in the bounce: the monitor is the
        # last thing standing between a dark primary and a failover, but a
        # thread that will not join is no reason to swallow the log line that
        # tells the operator their save landed.
        self._apply_step(self.emergency.stop, "pause the health monitor", "emergency")
        self._apply_step(self.emergency.start, "resume the health monitor", "emergency")
        self.log.info("Configuration updated", kind="config")
        if first_exc is not None:
            raise first_exc

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
            # worklist_wanted(), not mwl.enabled: a no_ris destination makes the
            # worklist permanent, and sync_worklist() would otherwise start
            # again what this just stopped.
            ("mwl", self.worklist_wanted(), bool(self.mwl_scp and self.mwl_scp.running),
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

    def apply_setup(self, picks: dict) -> dict:
        """Finish the setup chooser: write the five enabled flags plus the
        completion marker in ONE save, then sync the services to them.

        One save is the point — apply_config stops and restarts every bound
        service each time it runs, so posting the five service toggles
        separately would mean five windows with the receiver down. A service
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

    def stuck_sends(self) -> dict:
        """Everything sitting in the outgoing folder that is not moving, in three
        deliberately separate lists.

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
                                             "attempts": 0, "last_error": "", "next_try": float("inf")})
                agg["instances"] += 1
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
                if len(agg["files"]) < self._ORPHAN_SAMPLE:
                    agg["files"].append(os.path.basename(path))
                else:
                    agg["more"] += 1
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
                if len(agg["files"]) < self._ORPHAN_SAMPLE:
                    agg["files"].append(os.path.basename(path))
                else:
                    agg["more"] += 1
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
                "tls": bool(pr.get("tls", False)),
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
                # Anchors received/orders_in/errors ONLY. `counts` below comes
                # from the persisted store and survives restarts entirely — it
                # is a current state, not a window, and has no origin to give.
                "since": int(self._counter_since.get("ris", self.started_at)),
                "counts": self.orders.counts(),
                # The store is always live (manual entry works with the listener
                # stopped), so these are real whatever "running" says.
                "last_order": _order_brief(
                    self.orders.latest("open"),
                    ("id", "accession", "patient", "patient_id", "modality",
                     "study_desc", "created", "source", "status")),
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
                # rebuilt on every save, so its counters restart with it.
                "since": int(qr.started_at) if qr else int(self.started_at),
                "tls": bool(qcfg.get("tls", False)),
                "tls_mutual": bool(qcfg.get("tls", False) and qcfg.get("tls_ca", "")),
                # C-MOVE names a destination by AE title; these are the ones we
                # can resolve without falling back to the destination list.
                "destinations": sorted(qcfg.get("move_destinations", {}) or {}),
                "last": qr.last_query if qr else None,
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
            "emergency": self.emergency.status(),
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
            "stuck": self.stuck_count(),
            "disk": self._disk_status(),
            "editor_url": self.cfg.web.get("editor_url", ""),
            # Same epoch base as a log entry. This is when the PROCESS started —
            # it is uptime's origin, not the counters': each block above carries
            # its own `since`, because a save rebuilds the object behind it.
            "started_at": int(self.started_at),
            "uptime_sec": int(time.time() - self.started_at),
            "setup": self.setup_state(),
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
