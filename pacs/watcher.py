"""Folder watcher — the "auto-send" daemon.

Polls the configured outgoing folder on an interval, and for every stable new
DICOM file forwards it (C-STORE) to each enabled destination.  Design notes:

  * Polling (not inotify): more reliable across network shares and identical on
    every OS, at the cost of up-to `poll_interval` seconds of latency.
  * A file is only sent once it is *stable* (size unchanged between two polls
    and non-zero) so we never forward a half-written object.
  * Per-destination tracking with retry: a file is "done" only once every
    destination it was ROUTED to has accepted it; failures are retried on the
    next pass.  State survives restarts via a small JSON sidecar.
  * Reads the live Config each pass, so dashboard edits (new hosts, changed
    folder) take effect without a restart.
  * Routing decides per file which of the enabled destinations it goes to, and
    which of those get a de-identified copy.  The decision is written into the
    send-state entry BEFORE the sends, because the archive pass reads it back:
    "has this file reached everywhere it owes" is a per-file question the
    moment a rule can send a study to a subset of the nodes.
  * Which of them get the scrubbed copy is asked of the routing Decision and of
    nothing else — `Decision.honoured_by(deider)` settles it against the one
    de-identifier this pass will use, and a destination whose scrub cannot be
    honoured is HELD rather than dialled in the clear.  Every version of that
    question answered here instead ("asked for, AND we happen to have a
    de-identifier") has shipped the same leak: a set narrower than the decision
    promised, sent identified, reported de-identified.
  * That recorded route is only trustworthy in the pass that wrote it.  It is
    written under one destination list and read back under another, and every
    edit in between — a rename, a disable, a deletion, an added node, a rule
    change — turns it into a lie.  So the archive gate only ever considers
    files the CURRENT pass routed (`evaluated` below); nothing else may be
    moved, and above all nothing else may be deleted.
  * "The current pass" is not a moment, it is minutes: a C-STORE association
    can stay open for a long time, so a config save lands *inside* a pass as
    easily as between two.  A pass therefore fingerprints the config it is
    reasoning about and the archive gate refuses to act if that fingerprint
    moved underneath it — see `_config_generation`.
  * The same fingerprint governs SENDING, not just archiving.  The destination
    list, the TLS context, `on_success`, the router and the de-identifier are
    each read once at the top of a pass and then used for every file in it, so
    a save landing mid-pass does not merely archive on settings the operator
    replaced — it forwards on them.  The invariant, stated where it bites
    hardest: NO FILE MAY BE SENT UNDER A DE-IDENTIFICATION SETTING THE OPERATOR
    HAS ALREADY REPLACED.  A pass that sees its fingerprint move therefore
    abandons what is left of itself; the files stay in the outgoing folder and
    the next pass re-routes them against the config as saved — see
    `_config_moved`.
  * A destination NAME is not a machine.  entry["sent"] records names, and an
    operator can re-point a name at another host, port or called AE at any
    time; every study recorded as delivered to that name is then recorded as
    delivered to an address that has never seen it.  So each accepted name is
    stamped with the address that accepted it, and a name whose address moved
    is owed the study again — see `_reopen_repointed`.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
from typing import Optional

from . import routing
from .config import Config
from .dicomfs import is_dicom
from .logbuf import LogBuffer
from .routing import Router
from .scu import Destination, SendResult, c_store
from .state import SendState


_BACKOFF_CAP = 300.0     # never wait more than 5 min between retries


def _backoff(attempts: int, base: float) -> float:
    """Exponential backoff (base, 2×, 4×…) capped at _BACKOFF_CAP seconds.
    Keeps a permanently-down node from being hammered every poll while still
    retrying often enough that a brief outage recovers quickly."""
    base = max(5.0, float(base or 5.0))
    return min(_BACKOFF_CAP, base * (2 ** max(0, attempts - 1)))


def _dedupe(target: str) -> str:
    """A non-clashing variant of *target* (adds _1, _2… before the extension)."""
    if not os.path.exists(target):
        return target
    base, ext = os.path.splitext(target)
    i = 1
    while os.path.exists(f"{base}_{i}{ext}"):
        i += 1
    return f"{base}_{i}{ext}"


def _merge_move(src: str, dst: str) -> None:
    """Recursively move EVERYTHING from *src* into *dst* (files, subfolders,
    non-DICOM and all), then remove the now-empty source tree."""
    os.makedirs(dst, exist_ok=True)
    for name in os.listdir(src):
        s = os.path.join(src, name)
        d = os.path.join(dst, name)
        if os.path.isdir(s):
            _merge_move(s, d)
        else:
            os.makedirs(os.path.dirname(d) or ".", exist_ok=True)
            shutil.move(s, _dedupe(d))
    os.rmdir(src)


class FolderWatcher:
    def __init__(self, cfg: Config, log: LogBuffer, index=None):
        self.cfg = cfg
        self.log = log
        self.index = index
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._sizes: dict[str, int] = {}          # path -> last-seen size (stability check)
        self.state = SendState(os.path.join(os.path.dirname(cfg.path), ".carinopacs_state.json"))
        # One long-lived router: it owns the parsed-header cache and the
        # warn-once memo, both of which a per-pass instance would throw away —
        # re-reading every header and re-logging every misconfiguration every
        # few seconds. It is re-pointed at the live config on each pass.
        self.router = Router(log=log)
        self._deider = None
        self._deid_key: Optional[str] = None
        # Hold announcements already made, keyed by cause + the names held.
        # Cleared when the deid settings move (see _deidentifier), so a fix — or
        # a regression — is re-reported, and keyed by cause so the two causes
        # cannot silence each other.
        self._said_held: set[str] = set()
        # Studies held back by a destination that left the config still owing
        # them -> when we last said so. Not a warn-ONCE memo: this condition
        # never clears by itself and nothing retries it — there is no node left
        # to dial — so it has to keep announcing itself until an operator acts.
        # The stuck panel lists these too (PacsServer.stuck_sends reports them
        # under "orphaned"); the log is the second copy, for whoever is reading
        # the send history rather than the dashboard. Once every poll would bury
        # that history; once and never again would let a held study go quiet.
        self._warned_stale: dict[str, float] = {}
        self._lock = threading.Lock()
        self.sent_count = 0
        self.failed_count = 0
        self.last_activity = ""
        # Last forward ATTEMPT (not the last success) — "did the last thing that
        # happened work?" is the question the dashboard actually needs answered.
        self.last_sent: Optional[dict] = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="pacs-watcher", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        t = self._thread
        if t and t.is_alive() and t is not threading.current_thread():
            t.join(timeout=5)
        self._thread = None

    # ------------------------------------------------------------------ loop
    def _run(self) -> None:
        watch = self.cfg.resolved("scu", "watch_dir")
        os.makedirs(watch, exist_ok=True)
        self.log.info(f"Watcher started on {watch}", kind="watch")
        while not self._stop.is_set():
            try:
                self._scan_once()
            except Exception as exc:
                self.log.error(f"Watcher pass failed: {exc}", kind="watch")
            interval = float(self.cfg.scu.get("poll_interval", 3) or 3)
            self._stop.wait(max(1.0, interval))
        self.log.info("Watcher stopped", kind="watch")

    def _candidates(self, watch: str, skip_dirs: list[str]) -> list[str]:
        skips = [os.path.abspath(d) for d in skip_dirs if d]
        found = []
        for root, _dirs, files in os.walk(watch):
            # never rescan the archive or the pending-review store
            aroot = os.path.abspath(root)
            if any(aroot == s or aroot.startswith(s + os.sep) for s in skips):
                continue
            for name in files:
                if name.startswith("."):
                    continue
                p = os.path.join(root, name)
                if is_dicom(p):
                    found.append(p)
        return found

    def _deidentifier(self):
        """The de-identifier for the current config, or None when there is none.

        Rebuilt only when the deid settings actually change: a Deidentifier is
        immutable and shouts about risky options (keep_private) the moment it is
        constructed, so building one per pass would repeat that warning every
        few seconds and bury the send log.

        None means BOTH "the profile is off" and "one could not be built", and
        the caller must not care which: either way there is nothing to scrub
        with, and routing.Decision.honoured_by turns that into a hold. Building
        can genuinely fail on a config that is in force: Config.load() does not
        validate (a PACS that refuses to start is a PACS the operator cannot
        fix), so a hand-edited file with a JSON number in deid.prefix runs, and
        the constructor dies on it the first time a rule asks for a scrub. The
        failure is contained here rather than allowed out of the pass, because a
        watcher that stops sending is worse than one that stops scrubbing, and
        everything a scrub was owed to is held anyway.

        The old value is dropped BEFORE the attempt, never after. Keeping it
        would mean a failed rebuild leaves the pass forwarding under settings the
        operator has replaced — and when the value being kept is the None from a
        profile that used to be 'off', it is the leak itself: the router reads
        the new profile live and starts routing to the node a rule scrubs for
        while this returns nothing to scrub with."""
        from .deid import Deidentifier
        key = json.dumps(self.cfg.deid, sort_keys=True, default=str)
        if key != self._deid_key:
            self._deid_key = key
            self._deider = None
            self._said_held.clear()         # a fix (or a regression) is re-reported
            try:
                self._deider = Deidentifier.from_config(self.cfg, self.log)
            except Exception as exc:
                self.log.error(
                    f"Could not build the de-identifier ({exc}) — any destination a rule "
                    "asks to de-identify for is HELD, not forwarded. Fix the "
                    "de-identification settings, or take 'deidentify' off the rule.",
                    kind="send")
        return self._deider

    def _announce_hold(self, path: str, decision) -> None:
        """Say on the send channel that deliveries are being withheld, and why.

        The routing engine announces the holds IT can explain (kind='route'), but
        an operator watching forwards go past reads the send channel, and a study
        that never leaves has to be visible there too — a hold nobody is told
        about is just a slower stall.

        The message states the cause the decision actually carries. The line this
        replaces asserted "deid.profile is 'off'" for every hold it saw, which
        stopped being true the moment the profile-off case became a hold: from
        then on the only decisions reaching it were ones whose profile was NOT
        off, and it printed the false cause verbatim at the exact sites that
        needed the true one. Once per cause + set of names per deid generation:
        nothing retries a held study, so a per-pass line would bury the send log,
        and _deidentifier() clears the memo when the settings move."""
        if not decision.held:
            return
        key = decision.hold_cause + "|" + ";".join(sorted(decision.held))
        if key in self._said_held:
            return
        if len(self._said_held) > 256:
            self._said_held.clear()         # bounded; the condition re-announces
        self._said_held.add(key)
        self.log.error(decision.hold_message(os.path.basename(path)), kind="send")

    def _send_to_name(self, path: str, payload: str, entry: dict, fails: dict,
                      dest_name: str, nodes: list, calling_aet: str, tls_ctx,
                      interval: float) -> None:
        """C-STORE *payload* to EVERY enabled node carrying *dest_name*.

        One routed name can resolve to more than one node — nothing but config
        validation stops it, and a hand-edited config.json bypasses that. The
        name is only recorded as sent once all of them accepted, because that is
        the finest grain the state model has: entry["sent"] holds names, so a
        partial success cannot be written down. The cost is re-sending to the
        node that already took it on the next pass; the alternative is marking
        the name done and letting the archive pass delete a study a node never
        received. *path* is what the operator sees in the log — with a scrubbed
        copy in flight it is not the file on the wire."""
        errors = []
        for dest in nodes:
            if self._stop.is_set():
                return
            try:
                res = c_store(dest, payload, calling_aet, tls_context=tls_ctx)
            except Exception as exc:        # noqa: BLE001 - a pass must survive one file
                # c_store answers with a SendResult and does not raise, and this
                # exists so that staying true is not load-bearing. A raise here
                # unwinds the whole scan: nothing is marked failed, nothing backs
                # off, the stuck panel stays empty, and every file behind this one
                # stops being dialled — a silent halt rather than one bad file.
                res = SendResult(False, f"send raised ({exc})")
            if not res.ok:
                errors.append(f"{dest.host}:{dest.port} {res.message}"
                              if len(nodes) > 1 else res.message)
        if errors:
            self._note_failure(path, fails, dest_name, "; ".join(errors), interval)
        else:
            self._note_success(path, entry, fails, dest_name,
                               self._node_fingerprint(nodes))

    def _note_success(self, path: str, entry: dict, fails: dict, dest_name: str,
                      fingerprint: str = "") -> None:
        entry["sent"].append(dest_name)
        # Which MACHINE took it, beside the name that was dialled — see
        # _reopen_repointed for why the name alone is not a delivery record.
        entry.setdefault("sent_to", {})[dest_name] = fingerprint
        fails.pop(dest_name, None)          # clear any prior failure
        with self._lock:
            self.sent_count += 1
            self.last_activity = f"{os.path.basename(path)} -> {dest_name}"
            self.last_sent = {
                "epoch": int(time.time()), "file": os.path.basename(path),
                "dest": dest_name, "ok": True, "error": "",
            }
        self.log.info(f"Sent {os.path.basename(path)} -> {dest_name}", kind="send")

    def _note_failure(self, path: str, fails: dict, dest_name: str,
                      message: str, interval: float) -> None:
        """Record a failed forward: attempt count, error and the backoff deadline.
        The file is not touched — it stays in the outgoing folder, stays visible
        in the stuck panel, and is retried until it lands."""
        f = fails.setdefault(dest_name, {"attempts": 0})
        f["attempts"] += 1
        f["last_error"] = message
        f["next_try"] = time.time() + _backoff(f["attempts"], interval)
        with self._lock:
            self.failed_count += 1
            self.last_sent = {
                "epoch": int(time.time()), "file": os.path.basename(path),
                "dest": dest_name, "ok": False, "error": message,
            }
        self.log.warn(
            f"Send {os.path.basename(path)} -> {dest_name}: {message} "
            f"(attempt {f['attempts']}, retry in {int(f['next_try'] - time.time())}s)",
            kind="send",
        )

    def _config_generation(self) -> str:
        """A fingerprint of the config this pass is reasoning about.

        Deliberately the WHOLE object rather than just the destination list. A
        rule edit re-routes the file, a node re-pointed at another host means
        the name on the wire no longer identifies the machine that took the
        study (this only buys that case a pass; what actually gets it to the new
        address is `_reopen_repointed`, because the staleness there is in the
        RECORD and outlives any one pass), `on_success` flipping to "keep" means
        the operator has just said do-not-delete — from inside a pass none of
        those are distinguishable from the destination list changing, and every
        one of them makes the pass's own conclusions statements about a config
        that is gone. Config is a few KB and only ever written when an operator
        saves, so serialising it per file and per send costs nothing next to the
        sockets around it, and it cannot flap on its own."""
        try:
            return json.dumps(self.cfg.data, sort_keys=True, default=str)
        except (TypeError, ValueError):
            # A config that will not serialise must not take the pass down with
            # it: the exception would escape _scan_once before a single file was
            # forwarded, and a watcher that stops sending is worse than one that
            # stops archiving. repr is stable for a dict nobody has replaced,
            # which is the only thing this comparison asks of it.
            return repr(self.cfg.data)

    def _config_moved(self, generation: str) -> bool:
        """Has the operator replaced the config this pass began under?

        Every send below the top of a pass runs on values read once: the
        destination list, the resolved node behind each name, the TLS context,
        the calling AE, the router and the de-identifier. A save landing mid-pass
        makes every one of them a statement about a config that is gone, and one
        of them leaks: flip deid.profile on, or edit a rule to deidentify:true,
        and the files still queued behind the association currently open go out
        IDENTIFIED to the node that was just told to receive anonymised studies
        only. That is the invariant this exists to hold — no file may be sent
        under a de-identification setting the operator has already replaced.

        Of the two ways to hold it, this one abandons the rest of the pass rather
        than re-reading the router and the de-identifier per file. Re-reading
        keeps throughput, but it half-applies a save by construction: one file of
        a study ships under the old settings and its neighbour under the new,
        with the destination list, the node map and the TLS context still stale
        around them because they were resolved before the loop. Abandoning is one
        rule for the whole pass — a pass acts only on the config it began under,
        sends included — and it cannot deliver a mixture. The files it walks away
        from are untouched in the outgoing folder with their sizes already in the
        stability map, so the next pass picks them straight up under the new
        config; the cost is one poll interval, once, per save.

        Called before each file and before each send, so serialising the config
        happens more than twice a pass now. It is a few KB against a C-STORE that
        opens a socket — the comparison is not what this loop spends its time on.
        """
        if self._config_generation() == generation:
            return False
        # Only ever logged once per pass: every caller abandons on True.
        self.log.info(
            "Config changed while this pass was running — the rest of it is deferred "
            "to the next pass, which will re-route and re-send under the new settings",
            kind="watch")
        return True

    def _abandon(self, path: str, entry: dict) -> None:
        """Leave the pass, keeping what it already delivered.

        The sends that DID happen are on the wire and cannot be recalled, so the
        record of them is persisted before walking away — an abandoned pass that
        dropped them would forward those files a second time on the next one."""
        self.state.put(path, entry)
        self.state.save()

    @staticmethod
    def _node_fingerprint(nodes: list) -> str:
        """The address(es) a destination name resolves to right now.

        host, port and called AE — the three things that decide which machine and
        which application entity a C-STORE actually reaches. Deliberately NOT
        tls: turning the link on a node encrypted changes how we talk to it, not
        who we are talking to, and re-transmitting a study for that would be
        traffic with nothing behind it. Sorted, because one name may resolve to
        several nodes and their order in the config is not identity."""
        return ";".join(sorted(f"{d.host}:{d.port}|{d.aet}" for d in nodes))

    def _reopen_repointed(self, path: str, entry: dict, nodes: dict) -> None:
        """Un-mark any destination whose name now resolves to a different machine.

        entry["sent"] holds NAMES. A name is a label on an address, and the
        operator can move it: correct a typo'd host, follow a node to a new box,
        point at a different called AE. The moment they do, every study recorded
        as delivered to that name is recorded as delivered to an address that has
        never seen it — and nothing downstream notices, because the route still
        names an enabled destination, so the archive gate is satisfied and the
        study is moved or, under on_success=delete, destroyed.

        The generation fingerprint cannot rescue that case and was wrongly
        claimed to: it defers the archive by one pass, and on the next pass the
        record already reads as satisfied. The staleness is in the RECORD, so the
        fix has to be there too — which is also why it works between passes and
        not only inside one.

        Why re-send rather than accept the delivery that did happen: renaming a
        node (same machine, new label) already costs a re-send here — the route
        no longer intersects, so the study waits and goes out again to the new
        name. Re-pointing one is the opposite edit, a genuinely different machine
        under the same label, and it cannot be the single change that counts as
        no change at all. The failure modes are not symmetric either: a repeated
        C-STORE of an instance the receiver already holds is idempotent (same SOP
        Instance UID), while a study archived on an address the operator has just
        corrected away is an image that silently never arrives.

        A name with no recorded address is ADOPTED, not re-sent: entries written
        before this record existed, and the ones the manual-send path writes,
        carry no address at all, and re-sending on "unknown" would re-transmit
        every file in the outgoing folder on the first pass after an upgrade."""
        seen = entry.get("sent_to")
        if not isinstance(seen, dict):
            seen = {}
        for name in list(entry.get("sent") or []):
            if name not in nodes:
                continue    # not enabled now: an orphan, and _fully_sent's job
            live = self._node_fingerprint(nodes[name])
            if not seen.get(name):
                seen[name] = live       # unknown (or blank) is adopted, never re-sent
            elif seen[name] != live:
                was = seen.pop(name)
                # Every occurrence: a name that somehow got recorded twice would
                # otherwise stay half-marked and read as delivered.
                entry["sent"] = [n for n in entry["sent"] if n != name]
                self.log.warn(
                    f"{name} now points at {live}, not {was} — "
                    f"{os.path.basename(path)} reached the old address only and is "
                    "owed to the new one", kind="send")
        if seen:
            # Only attached when there is something to remember: a file that has
            # reached nobody yet gets no empty key in the sidecar. When it came
            # OUT of the entry it is the same object, so the adoptions and
            # removals above are already recorded.
            entry["sent_to"] = seen

    def _scan_once(self) -> None:
        # Fingerprint BEFORE reading anything else off the config: a save that
        # lands between these two lines is then seen as a change (the archive
        # pass declines) instead of being missed — the other order would fold a
        # half-read, half-new config into a fingerprint that still matches at
        # the end of the pass.
        generation = self._config_generation()
        scu = self.cfg.scu
        watch = self.cfg.resolved("scu", "watch_dir")
        sent_dir = self.cfg.resolved("scu", "sent_dir")
        pending_dir = self.cfg.resolved("scu", "pending_dir")
        calling_aet = scu.get("aet", "CARINOSCU")
        on_success = scu.get("on_success", "keep")
        dests = [Destination.from_dict(d) for d in self.cfg.enabled_destinations()]

        if not os.path.isdir(watch):
            return
        if not dests:
            return  # nothing to send to; leave files untouched

        # Build the client TLS context once per pass if any node uses TLS.
        tls_ctx = None
        if any(d.tls for d in dests):
            try:
                from .tlsutil import client_context
                tls_ctx = client_context(
                    verify=bool(scu.get("tls_verify", True)),
                    ca=self.cfg.resolve_path(scu.get("tls_ca", "")),
                    certfile=self.cfg.resolve_path(scu.get("tls_cert", "")),
                    keyfile=self.cfg.resolve_path(scu.get("tls_key", "")),
                )
            except Exception as exc:
                self.log.error(f"TLS config error — sends to TLS nodes will fail: {exc}", kind="send")

        # `want` is no longer "what every file owes" — routing makes that a
        # per-file question. It is now only the live enabled-name set, used to
        # intersect a recorded route at archive time so a node the operator
        # deleted cannot pin a study in the outgoing folder for good.
        want = {d.name for d in dests}
        # Every enabled node behind each name, built once per pass. A
        # name -> single-node map is what collapsed two nodes sharing a name into
        # whichever one came last, so there is deliberately no such map here.
        nodes = {n: routing.resolve_all(dests, [n]) for n in want}
        # Order matters: the fallback route is the enabled list verbatim, so it
        # is passed in config order, never as a set.
        self.router.update(self.cfg.routing, [d.name for d in dests])
        deider = self._deidentifier()

        # Every file THIS pass got as far as routing. The archive gate refuses
        # to judge anything else: a route recorded under yesterday's destination
        # list is evidence about yesterday's config, and archiving on it is how
        # a study reaches nobody and is deleted for it.
        evaluated: set[str] = set()

        for path in self._candidates(watch, [sent_dir, pending_dir]):
            if self._stop.is_set():
                return
            if self._config_moved(generation):
                # Everything from here down — dests, nodes, tls_ctx, the router,
                # the de-identifier — describes a config the operator replaced.
                # Walk away with what is already recorded; the files are still in
                # the outgoing folder and the next pass re-routes them.
                self.state.save()
                return
            try:
                size = os.path.getsize(path)
                mtime = os.path.getmtime(path)
            except OSError:
                continue

            # stability gate: only proceed when size is non-zero and steady
            prev = self._sizes.get(path)
            self._sizes[path] = size
            if size == 0 or prev != size:
                continue
            # Past the gate: the bytes are settled and everything below re-routes
            # this file against the live config, so its entry is about to become
            # a statement about NOW. That, and only that, makes it archivable.
            evaluated.add(os.path.abspath(path))

            entry = self.state.get(path, size, mtime)
            # Before anything is judged sent: a name whose machine moved has not
            # been delivered to, whoever was told otherwise.
            self._reopen_repointed(path, entry, nodes)
            fails = entry.setdefault("fail", {})
            interval = float(scu.get("poll_interval", 3) or 3)
            now = time.time()
            # Route BEFORE working out what is due, and persist the route even
            # when nothing is due: _fully_sent reads entry["route"] back, so an
            # unstamped file would sit in the outgoing folder forever.
            # The route, and then the same route settled against the ONE
            # de-identifier this pass will actually scrub with. Everything below
            # reads the settled decision and nothing else: what gets scrubbed and
            # what gets sent are two answers out of one object, so they cannot
            # come apart the way they did when each send site re-derived the
            # first from `deider is not None`.
            decision = self.router.route(path).honoured_by(deider)
            self._announce_hold(path, decision)
            if routing.record_route(entry, decision) and self.index is not None:
                # First sighting (or the file was replaced): make it findable.
                self.index.enqueue_file(path, "outgoing")
            self.state.put(path, entry)
            # A destination is due if this file was routed to it, it has not
            # accepted yet, and its backoff timer has elapsed. The recorded
            # route is what is walked (not decision.destinations) so a pinned
            # delivery is due like any other.
            todo = [n for n in entry["route"]
                    if n in want and n not in entry["sent"]
                    and now >= fails.get(n, {}).get("next_try", 0)]
            if not todo:
                continue

            # The scrub set comes from the DECISION and from nothing else. It
            # used to read "asked for AND this pass happens to hold a
            # de-identifier", which let the set actually scrubbed be NARROWER
            # than the set the decision asked for — and every destination that
            # fell out of that gap went out identified while the decision, the
            # log, /api/status and the dashboard all called it de-identified.
            # honoured_by has already moved anything unscrubbable into `held`,
            # and record_route keeps held names out of the route `todo` walks, so
            # a name reaching here is one that will be scrubbed.
            scrub = {n for n in todo if decision.needs_deid(n)}
            for name in [n for n in todo if n not in scrub]:
                if self._stop.is_set():
                    return
                # Between two sends of the SAME file as much as between two
                # files: the config can move while the first association is open,
                # and the second name is where the leak would go out.
                if self._config_moved(generation):
                    self._abandon(path, entry)
                    return
                self._send_to_name(path, path, entry, fails, name, nodes[name],
                                   calling_aet, tls_ctx, interval)
            if scrub:
                # De-identification travels on a COPY. Rewriting the file in
                # place would move its size/mtime, SendState would read that as a
                # new file, and the whole study would be forwarded again — so the
                # original is opened read-only and stays byte-identical.
                try:
                    from .deid import deidentified_tempfile
                    with deidentified_tempfile(path, deider) as scrubbed:
                        for name in [n for n in todo if n in scrub]:
                            if self._stop.is_set():
                                return
                            # Checked here too, and returned rather than raised:
                            # the except below turns an exception into a send
                            # failure, and abandoning a pass is not one.
                            if self._config_moved(generation):
                                self._abandon(path, entry)
                                return
                            self._send_to_name(path, scrubbed, entry, fails, name,
                                               nodes[name], calling_aet, tls_ctx, interval)
                except Exception as exc:
                    # A scrub that fails is a SEND failure, never a skip: the
                    # file stays on disk, goes into backoff and shows up as
                    # stuck. Forwarding it un-scrubbed instead would leak the
                    # PHI the rule exists to remove.
                    for name in sorted(scrub):
                        self._note_failure(path, fails, name,
                                           f"de-identification failed: {exc}", interval)
            self.state.put(path, entry)

        # Archive/delete whole studies once all their DICOMs are fully sent —
        # moves EVERYTHING (non-DICOM files and subfolders too) and leaves no
        # folders behind in the outgoing tree.
        self._archive_pass(watch, sent_dir, pending_dir, on_success, want, evaluated,
                           generation)
        self.state.save()

    # --------------------------------------------------------------- archiving
    def _dicoms_under(self, entrypath: str) -> list[str]:
        if os.path.isfile(entrypath):
            return [entrypath] if is_dicom(entrypath) else []
        out = []
        for root, _dirs, files in os.walk(entrypath):
            for f in files:
                if f.startswith("."):
                    continue
                p = os.path.join(root, f)
                if is_dicom(p):
                    out.append(p)
        return out

    _STALE_REWARN = 900.0                   # re-announce a held study every 15 min

    def _warn_stale_route(self, path: str, stale: list) -> None:
        key = os.path.abspath(path) + "|" + ",".join(sorted(stale))
        now = time.time()
        if now - self._warned_stale.get(key, 0.0) < self._STALE_REWARN:
            return
        if len(self._warned_stale) > 4096:
            self._warned_stale.clear()      # bounded; the condition re-announces
        self._warned_stale[key] = now
        self.log.warn(
            f"{os.path.basename(path)} still owes {', '.join(sorted(stale))}, which is "
            "no longer an enabled destination — it stays in the outgoing folder until "
            "that node is restored (or renamed back)", kind="send")

    def _fully_sent(self, path: str, want: set, evaluated: set) -> bool:
        """Done = THIS pass routed the file, and every destination it is recorded
        as owing has accepted it. Four conditions, each spelled out rather than
        left to fall out of set algebra, because each one is a study that would
        otherwise be moved — or with on_success=delete, destroyed — having
        reached fewer nodes than the operator believes.

        1. *evaluated*. entry["route"] answers "where does this file go?" as of
           the pass that wrote it. Rename a node, disable it, delete it, add one,
           edit a rule — the record is now about a config that no longer exists.
           The first pass after a restart writes no records at all (the stability
           map starts empty, so every file is skipped), which is exactly when the
           stalest routes get read. Only a file this pass re-routed against the
           live destination list may be judged.
        2. The live (size, mtime), via routing.fully_sent: an entry describes the
           BYTES it was recorded against, and a file rewritten under the same
           name owes a fresh send of its new content.
        3. A NON-EMPTY want set. An empty intersection is a subset of everything,
           so bare set logic reads "owes nobody" as "delivered to everybody" —
           the exact inversion: a study whose every destination was renamed away
           reached NOBODY. Not routed and routed-to-nothing are both "not done".
           routing.fully_sent refuses an empty set at the source now as well;
           this stays because it is the check that decides a delete, and that
           one is spelled out here rather than imported.
        4. NOTHING dropped out of the route unsent. A name in the route that is
           not enabled now and never accepted the file can only be a PIN once
           condition 1 holds (a re-routed file's route is the live decision plus
           its pins), and a pin is a delivery someone already promised — the
           emergency hold-and-forward owes the primary every held instance. A
           node leaving the config does not cancel that promise; the study waits,
           loudly, where the stuck panel can see it — nothing retries a name
           with no node behind it, so PacsServer.stuck_sends() lists these under
           "orphaned" and the operator has to restore the node or accept the
           loss. A hold that is invisible is just a slower leak."""
        if os.path.abspath(path) not in evaluated:
            return False
        try:
            stat = (os.path.getsize(path), os.path.getmtime(path))
        except OSError:
            return False    # vanished mid-pass; nothing to archive, retry next time
        entry = self.state.peek(path)
        need = routing.wanted_from(entry, want)
        if not need:
            return False    # None = never routed; set() = owed to nobody living
        stale = [n for n in (entry.get("route") or [])
                 if n not in want and n not in (entry.get("sent") or [])]
        if stale:
            self._warn_stale_route(path, stale)
            return False
        return routing.fully_sent(entry, want, stat=stat)

    def _convertibles_under(self, entrypath: str) -> list[tuple[str, str]]:
        """(path, kind) for every non-DICOM PDF/image under *entrypath*."""
        from . import ingest
        if os.path.isfile(entrypath):
            k = None if is_dicom(entrypath) else ingest.detect_kind(entrypath)
            return [(entrypath, k)] if k else []
        out = []
        for root, _dirs, files in os.walk(entrypath):
            for f in files:
                if f.startswith("."):
                    continue
                p = os.path.join(root, f)
                if is_dicom(p):
                    continue
                k = ingest.detect_kind(p)
                if k:
                    out.append((p, k))
        return out

    def _study_identity(self, dicoms: list[str]) -> dict:
        """Patient/study identity read from a sibling DICOM header, so a queued
        report inherits the study it was sitting next to."""
        from .history import _fmt_name, _read_header
        hdr = None
        for p in dicoms:
            hdr = _read_header(p)
            if hdr is not None:
                break
        if hdr is None:
            return {}
        return {
            "patient": _fmt_name(getattr(hdr, "PatientName", "")),
            "patient_name": str(getattr(hdr, "PatientName", "") or ""),
            "patient_id": str(getattr(hdr, "PatientID", "") or ""),
            "study_uid": str(getattr(hdr, "StudyInstanceUID", "") or ""),
            "study_date": str(getattr(hdr, "StudyDate", "") or ""),
            "study_desc": str(getattr(hdr, "StudyDescription", "") or ""),
            "accession": str(getattr(hdr, "AccessionNumber", "") or ""),
        }

    def _siphon_pending(self, entrypath, pending_dir, dicoms, name) -> int:
        """Move any PDF/image beside a study into the pending-review store,
        pre-filling its identity from the study. Returns how many were queued."""
        conv = self._convertibles_under(entrypath)
        if not conv or not pending_dir:
            return 0
        from . import ingest
        identity = self._study_identity(dicoms)
        identity["source"] = name
        queued = 0
        for path, kind in conv:
            try:
                ingest.stage_pending(pending_dir, path, identity, kind)
                queued += 1
            except OSError as exc:
                self.log.warn(f"Could not queue {os.path.basename(path)} for review: {exc}", kind="send")
        return queued

    def _archive_pass(self, watch, sent_dir, pending_dir, on_success, want,
                      evaluated, generation) -> None:
        """After sending, for each top-level item in the outgoing folder whose
        every DICOM has reached all enabled nodes, move/delete the WHOLE item
        (all files & subfolders) so nothing — empty or not — is left behind.

        *evaluated* is the set of absolute paths this pass actually routed. A
        study containing so much as one file the pass did not look at is left
        alone until the pass that does look at it — one poll interval of delay
        against archiving something on a route the config outgrew.

        *generation* is the config fingerprint taken when the pass began. It is
        re-read below, immediately before anything destructive, and a mismatch
        abandons the archive pass entirely. Per ITEM, not once for the loop:
        moving a large study takes time, and the item after it — its pending
        siphon included, which reads the pending_dir this pass captured — must
        not run on a config the operator replaced halfway down the list."""
        if on_success not in ("move", "delete"):
            return  # "keep": leave everything in place
        try:
            names = os.listdir(watch)
        except OSError:
            return
        sent_abs = os.path.abspath(sent_dir)
        pending_abs = os.path.abspath(pending_dir) if pending_dir else None
        for name in names:
            if name.startswith("."):
                continue
            entrypath = os.path.join(watch, name)
            ap = os.path.abspath(entrypath)
            if ap == sent_abs or ap.startswith(sent_abs + os.sep):
                continue  # never touch the archive itself (if nested under watch)
            if pending_abs and (ap == pending_abs or ap.startswith(pending_abs + os.sep)):
                continue  # never touch the pending store (if nested under watch)
            dicoms = self._dicoms_under(entrypath)
            if not dicoms:
                continue  # not a study (contains no DICOM) — leave it untouched
            if not all(self._fully_sent(f, want, evaluated) for f in dicoms):
                continue  # some instance still pending/failed — retry next pass
            # Judged — now, before anything is moved or destroyed, check that the
            # config the judgement was made under is still the config in force.
            # A C-STORE association can hold a pass open for minutes, which is
            # ample time for a Save to land: the operator adds "Teaching" (or
            # renames a node, or swaps one out) while this study is on the wire,
            # and everything above — `want`, `nodes`, `on_success`, and the
            # routes recorded this pass — is about the destination list they
            # just replaced. Re-reading the LIVE list here would not rescue it:
            # a file routed to "Archive" alone still reads as complete beside a
            # brand-new "Teaching" it was never routed to, because the record is
            # what is stale, not the comparison. So the pass declines outright.
            # Simpler to reason about (one rule: a pass may only act on the
            # config it began under) and it is the only reading that cannot
            # delete a study the operator has just given a new destination.
            # Cost: archiving waits one poll interval, once, per save.
            if self._config_generation() != generation:
                self.log.info(
                    "Config changed while this pass was running — archiving deferred "
                    "to the next pass, which will re-route against the new settings",
                    kind="watch")
                return
            # Route any PDF/image beside the study to the review queue first, so
            # the archive/delete below only handles DICOM + inert files.
            queued = self._siphon_pending(entrypath, pending_dir, dicoms, name)
            if queued:
                self.log.info(f"Queued {queued} non-DICOM file(s) from {name} for review", kind="send")
            try:
                if on_success == "delete":
                    if os.path.isdir(entrypath):
                        shutil.rmtree(entrypath)
                    else:
                        os.remove(entrypath)
                    verb = "Deleted"
                else:
                    rel = os.path.relpath(entrypath, watch)
                    target = os.path.join(sent_dir, rel)
                    if os.path.isfile(entrypath):
                        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
                        # Keep the name it actually landed under: _dedupe may
                        # have renamed it, and the index is told where the file
                        # IS, not where we asked for it to go.
                        target = _dedupe(target)
                        shutil.move(entrypath, target)
                    else:
                        _merge_move(entrypath, target)
                    verb = "Archived"
            except OSError as exc:
                self.log.warn(f"Could not {on_success} {name}: {exc}", kind="send")
                continue
            for f in dicoms:
                self.state.drop(f)
                self._sizes.pop(f, None)
                self.router.cache.forget(f)
                if self.index is not None:
                    self.index.enqueue_remove(f)
            if self.index is not None and on_success == "move":
                # Re-file the archived copies under their new paths. Removals
                # and adds share one queue, so the add can never overtake the
                # remove it replaces, and the paths are read back off disk
                # because _merge_move may have de-duplicated a name.
                for f in self._dicoms_under(target):
                    self.index.enqueue_file(f, "sent")
            self.log.info(f"{verb} after send: {name}", kind="send")

    def stats(self) -> dict:
        with self._lock:
            return {
                "running": self.running,
                "sent": self.sent_count,
                "failed": self.failed_count,
                "last_activity": self.last_activity,
                "last_sent": self.last_sent,
            }
