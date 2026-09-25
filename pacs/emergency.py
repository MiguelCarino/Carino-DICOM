"""Emergency failover — health monitor + state machine.

Watches the destinations flagged ``emergency_trigger`` (the primary PACS). When
one is unreachable beyond a threshold, it raises an **emergency**: by default it
does not silently open sockets — it flips a ``prompt`` flag the dashboard turns
into a "primary PACS unreachable — activate emergency RIS?" pop-up. The operator
**activates** (start the worklist SCP + hold-and-forward) or **dismisses** it.

State machine (see docs/ris-emergency-design.md):

    off ──arm()──▶ idle ──trigger detected──▶ triggered ──activate()──▶ active
     ▲              ▲   ◀── recovered ───────────┘                        │
     └──disarm()────┘                                          primary verified back
                    ▲                                                     │
                    └──────────── resume() ◀── recovering ◀──────────────┘

Detection uses **both** signals (locked decision): an active periodic C-ECHO
probe *and* the watcher's passive send-failures. Recovery needs
``recovery_successes`` consecutive good probes (hysteresis) so a flapping link
can't rattle the state. On recovery the held studies are auto-flushed, but the
operator must click **Resume normal** to fully stand down (no auto-exit).

The controller is deliberately thin: it drives the state and calls back into the
``PacsServer`` for the DICOM-facing actions (probe, start/stop worklist, flush).
"""

from __future__ import annotations

import threading
import time
from typing import Optional

from . import ris
from . import users
from .logbuf import LogBuffer


def _actor_key(profile) -> str:
    """The acknowledgement key for whoever is looking at the prompt.

    A profile's id, or "" for an appliance running without profiles — where
    there is one operator, one key, and therefore exactly the single-dismiss
    behaviour this file had before acknowledgement became per person.
    """
    return getattr(profile, "id", "") or ""


# State constants.
OFF = "off"                # not armed
IDLE = "idle"              # armed, everything healthy
TRIGGERED = "triggered"    # a primary is offline, awaiting operator decision
ACTIVE = "active"          # emergency running (worklist + hold-and-forward)
RECOVERING = "recovering"  # primary back, held studies flushing, awaiting Resume


class _Health:
    """Per-destination reachability tracker."""
    __slots__ = ("online", "consecutive_fails", "consecutive_ok",
                 "offline_since", "last_error", "last_probe", "probe_ok")

    def __init__(self):
        self.online = True
        self.consecutive_fails = 0
        self.consecutive_ok = 0
        self.offline_since: Optional[float] = None
        self.last_error = ""
        self.last_probe: Optional[float] = None
        # Did the last C-ECHO itself answer? Kept apart from last_error, which
        # also carries "forward failing" — a node that answers our probe while
        # its send queue backs up is reachable, and saying otherwise sends the
        # operator to check a network that is fine.
        self.probe_ok: Optional[bool] = None


class EmergencyController:
    def __init__(self, server, log: LogBuffer):
        self.server = server
        self.log = log
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._health: dict[tuple, _Health] = {}      # _key(dest) -> health
        self.state = OFF
        self.trigger_dest = ""
        self.since = 0.0
        # WHO has dealt with this outage, by profile id. It used to be a single
        # boolean, and the boolean was the bug: dismiss() silenced the prompt for
        # everybody, so a receptionist clearing a pop-up they could do nothing
        # about took it off the radiologist's screen and off IT's at the same
        # time. The three of them are being asked three different questions —
        # start keying orders by hand, push to an alternate node, change an
        # address — and each has to answer for themselves.
        #
        # Keyed by profile id, not by role: two radiologists on shift are two
        # people, and one of them acknowledging is not the other one knowing.
        # The empty-string key is the appliance running without profiles, where
        # there is exactly one operator and the old behaviour is the right one.
        self.acknowledged: set = set()
        self.activated_by = ""
        # Did THIS emergency start the Modality Worklist, or did it find one
        # already serving? Only a worklist the emergency started may be stopped
        # when the operator stands down — see resume().
        self._mwl_ours = False
        # Why the worklist is not serving, when activate() could not bring it up
        # (or when it has since died). Empty means "nothing to report"; it is
        # never a claim that the worklist IS serving — status()["worklist_serving"]
        # answers that, and it is asked of the SCP rather than remembered.
        self.mwl_error = ""
        self._now = time.time

    # ---- config views ------------------------------------------------------
    @property
    def _cfg(self) -> dict:
        return self.server.cfg.emergency

    @property
    def armed(self) -> bool:
        return bool(self._cfg.get("armed", False))

    @property
    def active(self) -> bool:
        return self.state in (ACTIVE, RECOVERING)

    def _trigger_dests(self) -> list:
        return [d for d in self.server.cfg.enabled_destinations() if d.get("emergency_trigger")]

    @staticmethod
    def _key(d: dict) -> tuple:
        """Health is tracked per NODE, not per destination name.

        Keyed by name alone, two rows sharing a name shared one _Health record
        and the last probe of the pass won: the healthy twin's success reset
        consecutive_fails and wiped offline_since every single tick, so the dead
        twin's outage never accumulated past offline_threshold_sec, `online`
        never flipped, and the failover NEVER TRIGGERED. The primary is down,
        the monitor says everything is fine, and the studies pile up unsent.

        validate() refuses duplicate names, so this only happens in a
        hand-edited config.json — which is exactly the case the send path was
        already hardened for (one routed name fans out to every node carrying
        it, and is marked sent only when all of them took it). The monitor now
        matches that: every physical node gets its own record, its own failure
        count and its own place in the status list. Everything is str()'d
        because a hand-edited file is also where a port arrives as a dict, and
        an unhashable key here would raise on every tick of the monitor loop.
        """
        return (str(d.get("name", "")), str(d.get("host", "")),
                str(d.get("port", "")), str(d.get("aet", "")))

    @staticmethod
    def _addr(d: dict) -> str:
        """host:port, for the operator who now has two rows called 'Primary'."""
        return f"{d.get('host', '')}:{d.get('port', '')}"

    # ---- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        """Start the monitor thread if failover is armed (idempotent).

        stop() joins its worker and clears the reference, so a live thread here
        is a genuine double-start and nothing else. It must not be the "worker
        the caller just asked to stop" case: early-returning onto a thread that
        is about to observe its stop flag leaves no monitor at all, and the
        monitor is the only source of destination reachability."""
        if not self.armed:
            return
        if self._thread and self._thread.is_alive():
            if self.state == OFF:
                self.state = IDLE
            return
        # Each run owns its stop/wake pair. A worker whose join timed out (a
        # C-ECHO can sit on the wire for seconds) therefore keeps the flag it was
        # stopped with and exits on its own — clearing a shared event here would
        # resurrect it alongside its replacement.
        self._stop, self._wake = threading.Event(), threading.Event()
        self.state = IDLE
        self._thread = threading.Thread(target=self._loop, args=(self._stop, self._wake),
                                        name="pacs-emergency", daemon=True)
        self._thread.start()
        n = len(self._trigger_dests())
        self.log.info(
            f"Emergency failover armed — monitoring {n} destination(s) "
            f"(probe every {self._cfg.get('probe_interval_sec', 30)}s)",
            kind="emergency",
        )

    def stop(self) -> None:
        """Flag the monitor down and wait for it. apply_config() stops then
        starts in immediate succession, so an unjoined worker would still be
        alive when start() looks, start() would decline, and the machine would
        end up with no monitor for the life of the process.

        Never under ``_lock``: the worker takes it in _evaluate()."""
        self._stop.set()
        self._wake.set()
        self.state = OFF
        t = self._thread
        if t and t.is_alive() and t is not threading.current_thread():
            t.join(timeout=2)
        self._thread = None

    def _set_armed(self, value: bool) -> None:
        """Persist emergency.armed, under the config lock.

        The read of ``emergency`` and the save that follows it are one
        read-modify-write and have to be one critical section, exactly as the
        token endpoint's is. Without the lock a POST /api/config landing in the
        gap assigns a freshly merged cfg.data, our write lands on the section
        dict nobody holds any more, and the save writes the OTHER document —
        so the operator is told failover is armed, config.json says it is not,
        and start() (which re-reads ``armed``) declines to start the monitor.
        Measured over real HTTP: alternating arm/disarm against concurrent
        dashboard Saves lost calls in both directions.

        Deliberately only the read-modify-write: start()/stop() stay outside,
        because stop() joins the monitor thread and holding a config lock across
        a join is how this would deadlock against a worker that reads config.
        The lock is re-entrant, so save() re-taking it here is free."""
        with self.server.cfg.mutate():
            previous = self._cfg.get("armed", False)
            self._cfg["armed"] = value
            try:
                self.server.cfg.save()
            except OSError:
                # mutate() holds the config still; it does not undo anything. A
                # save that raised leaves exactly the split this docstring is
                # about, reached through a door the lock does not cover: memory
                # armed, the file not, and start() reads the file. Rolled back
                # for the same reason the token endpoint rolls back.
                self._cfg["armed"] = previous
                raise

    def arm(self, profile=None) -> dict:
        self._set_armed(True)
        self.start()
        return self.status(profile)

    def disarm(self, profile=None) -> dict:
        self._set_armed(False)
        self.stop()
        with self._lock:
            self._health.clear()
            self.trigger_dest = ""
            self.acknowledged.clear()
        self.log.info("Emergency failover disarmed", kind="emergency")
        return self.status(profile)

    def _notify(self, event: str, actor=None) -> None:
        """Tell the people the policy names, through whatever channels are on.

        Best effort and never in the caller's way: a webhook that times out or
        an SMTP server that is down must not delay a failover or take the
        controller's thread with it. The notifier does its own retrying and
        reports its own failures — this only decides WHO and hands over.

        The audience is Profiles, not addresses, because each message is
        rendered for its recipient: the same outage is "start keying orders by
        hand" to reception, "your primary is unreachable, push to the alternate
        node" to a radiologist, and an address and a port to IT.
        """
        notifier = getattr(self.server, "notifier", None)
        if notifier is None:
            return
        try:
            notifier.emergency(event, self.status(), self.audience(), actor=actor)
        except Exception as exc:
            self.log.error(f"Emergency notification failed: {exc}", kind="emergency")

    # ---- who may do what about this outage ---------------------------------
    @property
    def _users_cfg(self) -> dict:
        try:
            return self.server.cfg.users
        except (AttributeError, KeyError, TypeError):
            return {}

    def may_activate(self, profile=None) -> bool:
        """May this profile press Activate?

        Two gates, and both have to hold. The capability says they are the kind
        of person who makes this call at all; ``emergency.activate_by`` says the
        administrator designated them for THIS appliance. Either alone is the
        wrong answer: capability alone ignores the designation the operator was
        asked to make, and designation alone would let an administrator hand the
        button to a profile that cannot reach the endpoint anyway.

        With no profiles configured, or no policy set, this is True — the
        pre-profiles behaviour, where whoever is at the dashboard decides.
        """
        if profile is None:
            return True
        if not profile.can("emergency.activate"):
            return False
        return users.matches_any(profile, self._cfg.get("activate_by") or [])

    def notifies(self, profile=None) -> bool:
        """Is this profile someone ``emergency.notify`` says to tell?"""
        if profile is None:
            return True
        return users.matches_any(profile, self._cfg.get("notify") or [])

    def audience(self):
        """Every enabled profile the policy says to tell, for the notifier.

        Returned as Profiles rather than addresses because the notifier has to
        respect what each of them may see: a message naming the patient whose
        study is stuck is a message that must not go to somebody whose profile
        withholds patient names.
        """
        return [p for p in users.enabled_profiles(self._users_cfg)
                if self.notifies(p)]

    # ---- the worklist half of the emergency --------------------------------
    # The worklist is how an order reaches a modality at all. Everything else
    # the emergency does (hold-and-forward, the banner, the notifications) is
    # invisible to the tech standing at the scanner; this is not. Two questions
    # about it have to be asked honestly, and neither used to be: is it serving
    # NOW, and did WE start it.
    def _worklist_serving(self) -> Optional[bool]:
        """True serving / False not serving / None unknowable.

        None is not a failure: the controller drives whatever is handed to it as
        ``server``, and something that does not expose ``mwl_scp`` at all is no
        evidence either way — there, a start that returned without raising is
        taken at its word, exactly as this file behaved before. False is a
        positive answer, the SCP itself saying it has no listener, and that is
        the case that must never be reported as serving.
        """
        if not hasattr(self.server, "mwl_scp"):
            return None
        scp = getattr(self.server, "mwl_scp", None)
        if scp is None:
            return False
        return bool(getattr(scp, "running", False))

    def _worklist_is_permanent(self) -> bool:
        """Does configuration want the worklist up outside any emergency?

        The same predicate the server starts it from on launch —
        ``worklist_wanted()``: ``mwl.enabled``, or any enabled destination
        flagged ``no_ris`` (that PACS has no RIS, so this appliance is its
        worklist source, emergency or not).

        Unanswerable means True, deliberately. Leaving a worklist running costs
        a bound port; stopping one the hospital configured takes every
        modality's schedule away with nothing to bring it back — sync_worklist()
        runs on launch and on a config change, not on a timer.
        """
        try:
            return bool(self.server.worklist_wanted())
        except Exception:
            return True

    def _stranded_orders(self) -> int:
        """How many open orders would lose their only worklist if we stopped it.

        Asked of the store the dashboard reads, through the same predicate the
        server's ``orders_only_we_can_serve()`` uses, so standing down and
        saving a configuration can never disagree about which patients are still
        waiting. An appliance handed a ``server`` with no store answers 0 — no
        store is no evidence that somebody is waiting.
        """
        store = getattr(self.server, "orders", None)
        if store is None:
            return 0
        return ris.open_orders_stranded_here(store)

    def _recheck_worklist(self) -> None:
        """Keep the worklist verdict current while the emergency is up.

        Deliberately NOT a retry: restarting an SCP on a timer turns a port
        conflict into a log flood and a fight with whatever holds the port. This
        only stops a stale verdict sticking to the banner for the rest of the
        outage — an operator who fixes the fault and starts the worklist by hand
        sees it clear, and a worklist that DIES mid-outage is reported instead of
        being remembered as healthy from an activate() an hour ago.
        """
        serving = self._worklist_serving()
        if serving is None:
            return
        if serving and self.mwl_error:
            self.mwl_error = ""
            self.log.info("Emergency: worklist SCP is serving again", kind="emergency")
        elif not serving and not self.mwl_error:
            self.mwl_error = "the worklist SCP is not listening"
            self.log.error("Emergency: the worklist SCP has STOPPED — modalities are "
                           "no longer being served orders", kind="emergency")

    # ---- operator actions --------------------------------------------------
    def activate(self, profile=None) -> dict:
        """Operator confirmed the pop-up: bring up the local emergency services.
        Starts the Modality Worklist SCP and turns on hold-and-forward so studies
        received during the outage queue for the primary and back-fill on return."""
        with self._lock:
            self.state = ACTIVE
            self.since = self._now()
            self.acknowledged.clear()
            # Recorded so the banner, the log and the audit trail can all say
            # who made the call. "the system" is the honest answer for
            # auto_activate — attributing an automatic failover to whoever
            # happened to be logged in would put a decision in someone's name
            # that they did not make.
            self.activated_by = getattr(profile, "name", "") or "the system"
        # Read BEFORE the start: afterwards "we brought it up" and "it was
        # already up" are indistinguishable, and resume() has to tell them apart.
        before = self._worklist_serving()
        self.mwl_error = ""
        try:
            self.server.start_mwl()
        except Exception as exc:
            # A short fixed reason in the status, the exception itself only in
            # the log. ``emergency`` is not in web._STATUS_GATES, so this block
            # reaches every signed-in profile including reception — and a start
            # failure's text carries exactly what the gated fields exist to
            # withhold: a bind address, or the path of a TLS certificate that is
            # not there. The person who can act on the cause can read the log.
            self.mwl_error = "the worklist SCP failed to start"
            self.log.error(f"Emergency: worklist SCP failed to start: {exc}", kind="emergency")
        else:
            # A start that did not raise is not a bound port: start_mwl() is
            # idempotent and returns early when an SCP object already exists, so
            # the SCP itself is asked. This is the swallowed failure — the
            # exception above was logged once and then the activation announced
            # "Worklist serving" regardless, and the tech spent the outage
            # pulling an empty worklist while the dashboard said it was fine.
            if self._worklist_serving() is False:
                self.mwl_error = "the worklist SCP is not listening"
                self.log.error("Emergency: the worklist SCP did not come up — orders "
                               "will NOT reach the modalities", kind="emergency")
            elif before is not True:
                self._mwl_ours = True
                # The same fact in the server's own bookkeeping, set at the
                # same moment so the two can never disagree: _mwl_ours answers
                # "should resume() stop this worklist now?", and the server's
                # flag answers "may a closing order stop it later?" — which is
                # the question left over when resume() leaves it serving for
                # orders that are still open. Set here rather than inside
                # start_mwl(), because start_mwl() cannot tell an outage from a
                # launch flag, and guessing is what took `serve --mwl`'s
                # worklist away on the first order that closed.
                self.server.mwl_for_orders = True
        # A running watcher is what forwards (and holds+retries) the studies.
        try:
            if not self.server.watcher.running:
                self.server.start_watcher()
        except Exception as exc:
            self.log.error(f"Emergency: auto-send failed to start: {exc}", kind="emergency")
        # The one line everybody reads afterwards, so it says what is actually
        # true of the worklist rather than what activation intended.
        worklist = ("Worklist serving" if not self.mwl_error else
                    "WORKLIST NOT SERVING — modalities will NOT receive these orders "
                    "(cause on the line above)")
        self.log.warn(
            f"EMERGENCY ACTIVATED by {self.activated_by} — primary "
            f"'{self.trigger_dest}' unreachable. {worklist}; received "
            f"studies held for forward.",
            kind="emergency",
        )
        self._notify("activated", profile)
        return self.status(profile)

    def dismiss(self, profile=None) -> dict:
        """One person acknowledged the pop-up: stop asking THEM about this outage.

        Everyone else still gets asked. The banner stays up for all of them,
        including the person who dismissed — this only stops the modal
        re-opening in their face, it never means the outage was handled. An
        appliance running without profiles has one operator and gets exactly the
        behaviour it had before.
        """
        with self._lock:
            self.acknowledged.add(_actor_key(profile))
        who = getattr(profile, "name", "") or "the operator"
        self.log.info(f"Emergency prompt acknowledged by {who} — failover not activated",
                      kind="emergency")
        return self.status(profile)

    def resume(self, profile=None) -> dict:
        """Operator stood down: return to armed/idle, stopping ONLY the worklist
        this emergency started.

        It used to stop the worklist unconditionally, and that had a long tail.
        An appliance whose configuration permanently enables the Modality
        Worklist — ``mwl.enabled``, or any enabled destination flagged
        ``no_ris``, both of which ``worklist_wanted()`` reads — lost its worklist
        the first time anybody pressed Resume normal, and nothing ever started it
        again: sync_worklist() runs on launch and after a config change, not on a
        timer. One emergency episode, and every modality in the hospital quietly
        stopped being scheduled until somebody restarted the service. The
        emergency is allowed to undo what it did; it is not allowed to undo what
        the hospital configured.

        Three independent guards, because each alone leaves a hole:
        ``_mwl_ours`` covers the worklist that was already serving when we
        activated; the permanence check covers an administrator who enabled it
        DURING the outage — the reason it is re-asked here rather than decided
        at activation time; and the stranded-order check covers the gap between
        the two moments Resume normal is confused for. Resume is pressed when
        the PRIMARY is back, which is not the moment the WORK is done. An order
        hand-keyed during the outage exists in this appliance's store and
        nowhere else — it was typed precisely BECAUSE the RIS could not be
        reached, so the RIS that is now back was never told about it and will
        never put it on a worklist. Stopping the worklist while that order is
        still open ends the only path that patient has to a scanner, and the
        order sits on the Open tab looking handled.
        """
        permanent = self._worklist_is_permanent()
        stranded = self._stranded_orders()
        if self._mwl_ours and not permanent and not stranded:
            try:
                self.server.stop_mwl()
            except Exception as exc:
                # Surfaced rather than swallowed: a worklist that would not stop
                # is still serving orders that are about to be the real RIS's
                # again, and that is worth a line in the log.
                self.log.error(f"Emergency: worklist SCP failed to stop: {exc}",
                               kind="emergency")
        elif self._worklist_serving() is not False:
            # A worklist still bound after the emergency is over is a surprise
            # to the next person who looks at the services, so the log answers
            # "the emergency is over, why is the MWL still up?" without anyone
            # having to read this module. The stranded orders are named first
            # when they are the binding reason, because that is the one an
            # operator can act on — scan those patients and it comes down.
            #
            # That last clause is a promise, so it is worth naming what keeps
            # it: PacsServer.release_worklist(), asked by every path that
            # settles such an order — the study arriving and reconciling, an
            # operator cancelling, a delete, a purge, and the use-case-B
            # capture that is how these orders settle on a site with no
            # modality that can C-STORE. The capture was the one that did not
            # ask, which meant the sentence below was false on exactly the
            # workflow an outage reaches for first.
            if stranded and not permanent:
                reason = (f"{stranded} order(s) typed during the outage are still open, "
                          f"and the RIS that is back was never told about them")
            elif permanent:
                reason = "configuration enables it outside the emergency"
            else:
                reason = "it was already running before the emergency"
            self.log.info("Emergency resolved — worklist left serving: " + reason,
                          kind="emergency")
        self._mwl_ours = False
        self.mwl_error = ""
        with self._lock:
            self.state = IDLE if self.armed else OFF
            self.trigger_dest = ""
            self.acknowledged.clear()
        self.activated_by = ""
        self.log.info(
            f"Emergency resolved by {getattr(profile, 'name', '') or 'the operator'} "
            f"— resumed normal operation", kind="emergency")
        self._notify("resolved", profile)
        return self.status(profile)

    # ---- monitor loop ------------------------------------------------------
    def _loop(self, stop: threading.Event, wake: threading.Event) -> None:
        # Reads its OWN events, never self._stop/self._wake: a later start() has
        # already replaced those, and this worker must stay stopped.
        while not stop.is_set():
            try:
                self._tick()
            except Exception as exc:  # never let the monitor die
                self.log.error(f"Emergency monitor error: {exc}", kind="emergency")
            wake.clear()
            wake.wait(max(5, int(self._cfg.get("probe_interval_sec", 30))))

    def _tick(self) -> None:
        dests = self._trigger_dests()
        threshold = float(self._cfg.get("offline_threshold_sec", 120))
        need_ok = int(self._cfg.get("recovery_successes", 2))
        now = self._now()

        try:
            stuck = {d["name"] for d in self.server.stuck_sends().get("destinations", [])}
        except Exception:
            stuck = set()

        offline_names = []
        for d in dests:
            name = d.get("name", "")
            h = self._health.setdefault(self._key(d), _Health())
            ok, msg = self.server._probe(d)
            # Both signals. The passive one is per-NAME by construction — the
            # sender only records a name as sent once every node carrying it
            # accepted — so a name that is stuck marks each of its nodes failing,
            # which is the honest reading: one of them is not taking images.
            failing = (not ok) or (name in stuck)
            h.last_probe = now
            h.probe_ok = ok
            if failing:
                h.consecutive_fails += 1
                h.consecutive_ok = 0
                h.last_error = msg if not ok else "forward failing"
                if h.offline_since is None:
                    h.offline_since = now
                if h.online and (now - h.offline_since) >= threshold:
                    h.online = False
                    self.log.warn(f"Emergency: '{name}' ({self._addr(d)}) is OFFLINE "
                                  f"({h.last_error})", kind="emergency")
            else:
                h.consecutive_ok += 1
                h.consecutive_fails = 0
                h.last_error = ""
                if not h.online and h.consecutive_ok >= need_ok:
                    h.online = True
                    h.offline_since = None
                    self.log.info(f"Emergency: '{name}' ({self._addr(d)}) is back ONLINE",
                                  kind="emergency")
                elif h.online:
                    h.offline_since = None
            if not h.online:
                offline_names.append(name)

        self._evaluate(offline_names)

    def _evaluate(self, offline_names: list) -> None:
        with self._lock:
            if not self.armed:
                self.state = OFF
                return
            any_offline = bool(offline_names)

            if self.state == IDLE and any_offline:
                self.trigger_dest = offline_names[0]
                self.since = self._now()
                self.acknowledged.clear()
                if self._cfg.get("auto_activate"):
                    self._unlocked_activate = True   # handled below outside the lock
                else:
                    self.state = TRIGGERED
                    # Deferred exactly like the activate above, and for the same
                    # reason: _lock is not re-entrant, _notify calls status()
                    # which takes it, and notifying from in here would deadlock
                    # the monitor thread — leaving the appliance with no health
                    # probe at the moment its primary went down.
                    self._unlocked_notify = "triggered"
                    self.log.warn(
                        f"Emergency TRIGGERED — '{self.trigger_dest}' unreachable; "
                        f"awaiting operator decision", kind="emergency")

            elif self.state == TRIGGERED and not any_offline:
                self.state = IDLE
                self.trigger_dest = ""
                self.acknowledged.clear()
                self.log.info("Emergency stand-down — primary recovered before activation",
                              kind="emergency")

            elif self.state == ACTIVE and not any_offline:
                self.state = RECOVERING

        # auto_activate path (do the socket work outside the lock)
        if getattr(self, "_unlocked_activate", False):
            self._unlocked_activate = False
            self.activate()

        pending = getattr(self, "_unlocked_notify", "")
        if pending:
            self._unlocked_notify = ""
            self._notify(pending)

        # Outside the lock, like everything else that touches the server: the
        # worklist is the emergency's only path to the modalities, so its state
        # is re-read on every tick rather than remembered from activation.
        if self.state == ACTIVE:
            self._recheck_worklist()

        if self.state == RECOVERING:
            self._flush_once()

    def _flush_once(self) -> None:
        """Primary is back — clear send backoff so the held studies forward now."""
        try:
            if not self.server.watcher.running:
                self.server.start_watcher()
            res = self.server.retry_stuck()
            if res.get("reset"):
                self.log.info(f"Emergency recovery — flushing {res['reset']} held instance(s) to primary",
                              kind="emergency")
        except Exception as exc:
            self.log.error(f"Emergency flush error: {exc}", kind="emergency")

    # ---- status ------------------------------------------------------------
    def _iso(self, t: float) -> str:
        if not t:
            return ""
        import datetime
        return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def status(self, profile=None) -> dict:
        with self._lock:
            dests = []
            for d in self._trigger_dests():
                name = d.get("name", "")
                h = self._health.get(self._key(d))
                dests.append({
                    "name": name,
                    # Two rows may legitimately carry the same name here (a
                    # hand-edited config), so the address is what tells the
                    # operator which of them is the one that is down.
                    "address": self._addr(d),
                    "online": bool(h.online) if h else True,
                    "offline_since": self._iso(h.offline_since) if (h and h.offline_since) else "",
                    "last_error": h.last_error if h else "",
                    "probe_ok": (h.probe_ok if h else None),
                    # "online" defaults to True before the first probe, so it is
                    # only meaningful once "checked" says a probe actually ran —
                    # an unprobed node must not be reported as reachable.
                    "last_probe": self._iso(h.last_probe) if (h and h.last_probe) else "",
                    "checked": bool(h and h.last_probe),
                })
            # Whether the modal opens is now a question about a PERSON, so it
            # is answered per request rather than stored. Three things have to
            # be true: the appliance is waiting for a decision, this profile is
            # someone the policy says to tell, and they have not already
            # answered for this outage.
            prompt = (self.state == TRIGGERED
                      and self.notifies(profile)
                      and _actor_key(profile) not in self.acknowledged)
            return {
                "armed": self.armed,
                "state": self.state,
                "active": self.active,
                "trigger_dest": self.trigger_dest,
                "since": self._iso(self.since),
                "prompt": prompt,
                # What this particular caller may do about it. The dashboard
                # draws Activate from this rather than from the capability
                # alone, because holding emergency.activate and being the person
                # the administrator designated are two different things.
                "may_activate": self.may_activate(profile),
                # Rendered on the banner so somebody who cannot act knows who
                # can, instead of staring at a disabled button.
                "activate_by": [users.describe_principal(self._users_cfg, s)
                                for s in (self._cfg.get("activate_by") or [])],
                "activated_by": self.activated_by,
                # The half of the emergency that actually reaches the
                # modalities. Asked of the SCP on every request rather than
                # remembered from activate(), because a failed start used to be
                # logged once and then reported as serving for the rest of the
                # outage. Unknowable reads as serving (see _worklist_serving);
                # only a definite "no listener" says no.
                "worklist_serving": self._worklist_serving() is not False,
                "worklist_error": self.mwl_error,
                "acknowledged": len(self.acknowledged),
                "auto_activate": bool(self._cfg.get("auto_activate")),
                "monitored": len(dests),
                "destinations": dests,
            }
