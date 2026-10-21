"""Outbound notification — webhook and e-mail.

The dashboard banner only reaches somebody who already has the dashboard open.
That is fine for the operator watching a transfer and useless for the case this
exists to serve: the primary PACS goes down at 03:00 and the radiologist on
call is not looking at a screen. So this module carries the same event off the
box, through two channels a self-hosted site can actually run — an HTTP POST to
whatever they already have, and SMTP to an address on each profile.

Three rules shape everything here.

**Nothing here may delay the thing it is reporting.** A failover that waits on
an SMTP handshake is a failover that did not happen. Every send is queued to a
worker thread; the caller returns immediately, always.

**Nothing here may take the caller down.** The monitor thread calling this is
the only source of destination health on the appliance. Every exception is
caught and turned into a counter and a log line.

**The message respects who is reading it.** Recipients are Profiles, not
addresses, and the same outage renders differently for each: reception is told
to start keying orders by hand, a radiologist is told their primary is
unreachable, and a profile holding routing.read additionally gets the state
and since-when lines. No message carries a host, port or error text: an e-mail
is the one place an access control cannot be applied after the fact.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import queue
import smtplib
import threading
import time
import ssl
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from typing import Any, Optional

# Bounded on purpose. A webhook endpoint that has gone away must not let an
# unbounded backlog of failed sends grow until the PACS runs out of memory —
# and a notification about an outage from forty minutes ago is not worth the
# memory anyway. When it is full the oldest is dropped and the drop is counted,
# which is visible in status() rather than silent.
QUEUE_MAX = 256

# Roles the message text knows how to speak to. A role is a free-text label an
# administrator types, so this is a lookup with a fallback and never a
# requirement — an unrecognised role gets the generic wording, not an error and
# not silence.
ROLE_GUIDANCE = {
    "receptionist": (
        "Orders cannot reach the modalities from the RIS while this lasts. "
        "Key new orders into Carino DICOM by hand (Orders → New order) and give "
        "the technologist the accession number to type into the modality — that "
        "is what lets the study be matched back to the order afterwards."),
    "radiologist": (
        "Studies arriving now are being held on this appliance rather than "
        "reaching the primary. If reading cannot wait, forward the study you "
        "need to an alternate destination from the History panel. Nothing is "
        "lost either way — held studies back-fill automatically when the "
        "primary returns."),
    "it": (
        "The primary is failing its health probe. If this is an address change "
        "rather than an outage, correct the destination and the monitor will "
        "clear on the next probe. Everything received meanwhile is queued on "
        "disk and forwards on recovery."),
    "admin": (
        "Failover is waiting for a decision. Activating starts the local "
        "worklist and holds incoming studies for the primary; dismissing leaves "
        "the appliance receiving and queueing but serves no worklist."),
}

GENERIC_GUIDANCE = (
    "Carino DICOM is still receiving and is queueing studies for the primary. "
    "Nothing is lost while this lasts.")

SUBJECTS = {
    "triggered": "Carino DICOM: primary '{dest}' is unreachable",
    "activated": "Carino DICOM: emergency failover ACTIVE ({dest})",
    "resolved":  "Carino DICOM: back to normal ({dest})",
}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A webhook is POSTed to the configured URL and nowhere else. urllib's
    default turns a 3xx into a bodiless GET to wherever Location points (an
    internal address included) and then reports the alert as delivered."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def redact_url(url: str) -> str:
    """scheme://host[:port]/… — never the userinfo, path or query, which for
    Slack/Teams/Discord incoming webhooks IS the credential."""
    try:
        parts = urllib.parse.urlsplit(str(url or ""))
        host = parts.hostname or "?"
        if ":" in host:
            host = f"[{host}]"
        port = f":{parts.port}" if parts.port else ""
        return f"{parts.scheme}://{host}{port}/…"
    except ValueError:
        return "(unparseable URL)"


def _smtp_context(sm: dict) -> ssl.SSLContext:
    """A VERIFYING TLS context for SMTP. smtplib's own default (context=None)
    accepts any certificate, so a man in the middle got the SMTP password and
    the alert. smtp.ca_file adds an internal CA; smtp.verify false is the
    explicit, logged opt-out."""
    ca = str(sm.get("ca_file", "") or "").strip() or None
    ctx = ssl.create_default_context(cafile=ca)
    if sm.get("verify") is False:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


class Notifier:
    """Queued, best-effort delivery to a webhook and/or a set of mailboxes."""

    def __init__(self, cfg, log=None, audit=None):
        self.cfg = cfg
        self.log = log
        self.audit = audit
        self._q: "queue.Queue[Optional[tuple]]" = queue.Queue(maxsize=QUEUE_MAX)
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self.sent = 0
        self.failed = 0
        self.dropped = 0
        self.last_error = ""
        self.last_sent = ""

    # ---- config views ----------------------------------------------------
    # Properties, not values captured in __init__, and that is the whole reason
    # start() can be honest about a Settings save applying without a restart:
    # every send re-reads the config object it was handed, so turning the
    # webhook off stops the next delivery rather than the next boot.
    #
    # _webhook and _smtp coerce instead of trusting because this config is
    # hand-editable JSON and the reader is a worker thread: a ``webhook``
    # somebody wrote as a string has to arrive here as "nothing is configured"
    # rather than as a TypeError inside the worker, counted and logged as a
    # delivery failure, which sends whoever reads it hunting the network for a
    # problem that is in the file. _cfg guards only the LOOKUP — a config object
    # with no ``notify`` block at all — and not what that block turns out to be.
    @property
    def _cfg(self) -> dict:
        try:
            return self.cfg.notify
        except (AttributeError, KeyError, TypeError):
            return {}

    @property
    def enabled(self) -> bool:
        return bool(self._cfg.get("enabled", False))

    @property
    def _webhook(self) -> dict:
        wh = self._cfg.get("webhook")
        return wh if isinstance(wh, dict) else {}

    @property
    def _smtp(self) -> dict:
        sm = self._cfg.get("smtp")
        return sm if isinstance(sm, dict) else {}

    # ---- lifecycle -------------------------------------------------------
    def start(self) -> None:
        """Bring the worker up (idempotent).

        Started even when notification is off, because the config is read live
        at send time: an operator who turns webhooks on in Settings must not
        have to restart the engine, and every other service in this app applies
        without one.
        """
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop = threading.Event()
            self._thread = threading.Thread(target=self._loop, args=(self._stop,),
                                            name="pacs-notify", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        """Flag the worker down and wait briefly for it.

        Joined, like every other worker in this tree, because apply_config()
        stops and starts in immediate succession and an unjoined thread would
        make start() decline — leaving the appliance with no notifier for the
        life of the process. The timeout is short and a send in flight is
        allowed to be lost: this is a notification, not a study.
        """
        self._stop.set()
        try:
            self._q.put_nowait(None)        # wake the worker out of its get()
        except queue.Full:
            pass
        t = self._thread
        if t and t.is_alive() and t is not threading.current_thread():
            t.join(timeout=3)
        self._thread = None

    # ---- the public event ------------------------------------------------
    def emergency(self, event: str, status: dict, audience: list,
                  actor=None) -> None:
        """Queue one failover event for everyone the policy named.

        Returns immediately. Never raises — the monitor thread calls this while
        holding nothing, but it is still the thread that keeps destination
        health alive, and an exception escaping here would end it.
        """
        try:
            if not self.enabled:
                return
            self.start()
            payload = {
                "event": f"emergency.{event}",
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "state": status.get("state", ""),
                "destination": status.get("trigger_dest", ""),
                "since": status.get("since", ""),
                "activated_by": status.get("activated_by", ""),
                "actor": getattr(actor, "name", "") or "",
            }
            # Facts the 'resolved' wording is built from, when the controller
            # knows them: whether the primary is actually answering, whether
            # failover had been activated, how many held instances still wait.
            for k in ("primary_online", "was_active", "held_remaining"):
                if k in status:
                    payload[k] = status[k]
            self._enqueue(("webhook", payload, None))
            for profile in audience or []:
                if getattr(profile, "email", ""):
                    self._enqueue(("email", payload, profile))
        except Exception as exc:            # never propagate into the monitor
            self._note_error(f"notification could not be queued: {exc}")

    def _enqueue(self, item: tuple) -> None:
        try:
            self._q.put_nowait(item)
        except queue.Full:
            # Drop the OLDEST, not this one. The newest event is the one that
            # describes the current state of the appliance; a backlog of stale
            # "primary is down" messages delivered after it has recovered is
            # actively misleading.
            try:
                self._q.get_nowait()
                self.dropped += 1
                self._q.put_nowait(item)
            except (queue.Empty, queue.Full):
                self.dropped += 1

    # ---- worker ----------------------------------------------------------
    def _loop(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                item = self._q.get(timeout=1.0)
            except queue.Empty:
                continue
            if item is None:
                break
            try:
                kind, payload, profile = item
                if kind == "webhook":
                    self._post_webhook(payload)
                elif kind == "email":
                    self._send_email(payload, profile)
            except Exception as exc:
                self._note_error(str(exc))

    def _note_error(self, message: str) -> None:
        self.failed += 1
        self.last_error = message[:400]
        if self.log is not None:
            self.log.warn(f"Notification failed: {message}", kind="notify")

    def _note_sent(self, what: str) -> None:
        self.sent += 1
        # A success clears the error. The dashboard reads last_error as the
        # notifier's state right now, and a scar left by an SMTP server that has
        # since come back reads there as an outage still in progress.
        self.last_error = ""
        self.last_sent = f"{time.strftime('%H:%M:%S', time.gmtime())} {what}"

    # ---- webhook ---------------------------------------------------------
    def _post_webhook(self, payload: dict) -> None:
        wh = self._webhook
        url = str(wh.get("url", "") or "").strip()
        if not wh.get("enabled", False) or not url:
            return
        try:
            parts = urllib.parse.urlsplit(url)
            scheme_ok = parts.scheme.lower() in ("http", "https") and bool(parts.hostname)
        except ValueError:
            scheme_ok = False
        if not scheme_ok:
            # A loaded config is not validated: file:// or ftp:// must never
            # reach urlopen.
            self._note_error("webhook URL must be an http:// or https:// URL with a host "
                             f"({redact_url(url)}) — nothing was sent")
            return
        body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        headers = {"Content-Type": "application/json",
                   # Receivers allow-list this token, so it keeps the
                   # pre-rename spelling until they have been told otherwise.
                   "User-Agent": "Carino-PACS"}
        secret = str(wh.get("secret", "") or "")
        if secret:
            # The receiver has no other way to know this POST came from the
            # PACS and not from anyone who learned the URL. Signed over the
            # exact bytes sent, so a proxy that reformats the JSON invalidates
            # it rather than passing an altered body off as genuine.
            headers["X-Carino-Signature"] = "sha256=" + hmac.new(
                secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
        timeout = _positive(wh.get("timeout_sec"), 10.0)
        retries = max(0, int(wh.get("retries", 2) or 0))
        last = ""
        for attempt in range(retries + 1):
            # Checked per attempt, not once before the loop. stop() waits a few
            # seconds for this thread, and the backoff below can outlast that on
            # its own — a shutdown that has to sit out the remaining retries of a
            # dead endpoint is a shutdown the operator sees as a hang.
            if self._stop.is_set():
                return
            try:
                req = urllib.request.Request(url, data=body, headers=headers,
                                             method="POST")
                with _OPENER.open(req, timeout=timeout) as resp:
                    if 200 <= resp.status < 300:
                        self._note_sent(f"webhook {payload.get('event', '')}")
                        return
                    last = f"HTTP {resp.status}"
            except urllib.error.HTTPError as exc:
                last = f"HTTP {exc.code}"
                if 300 <= exc.code < 400:
                    # Not followed (see _NoRedirect): the configured URL is wrong.
                    loc = redact_url(exc.headers.get("Location", "") if exc.headers else "")
                    last = f"HTTP {exc.code} redirect to {loc} — update the webhook URL"
                    break
                # 4xx is the receiver saying the request itself is wrong. Retrying
                # an unchanged body against it just makes the same mistake three
                # times; 408 and 429 are the two that genuinely mean "later".
                if 400 <= exc.code < 500 and exc.code not in (408, 429):
                    break
            except Exception as exc:
                last = str(exc)
            if attempt < retries:
                # Linear, not exponential, and short. This is an outage alert:
                # a delivery that finally succeeds four minutes later is not
                # worth the wait it imposed on everything behind it in the queue.
                time.sleep(min(5.0, 1.0 + attempt))
        self._note_error(f"webhook POST to {redact_url(url)} failed ({last})")

    # ---- e-mail ----------------------------------------------------------
    def _send_email(self, payload: dict, profile) -> None:
        sm = self._smtp
        host = str(sm.get("host", "") or "").strip()
        if not sm.get("enabled", False) or not host:
            return
        to = getattr(profile, "email", "")
        if not to:
            return
        if any(c in str(to) for c in "\r\n\x00") or "," in str(to):
            # A header-injection attempt (Bcc: smuggled in) or a malformed
            # address: never handed to the SMTP server.
            self._note_error("a recipient address contains a line break or a comma — not sent")
            return
        # The fallback sender keeps the pre-rename spelling: a site that has
        # allow-listed this address would silently drop the failover alert —
        # the one message that must arrive — if it changed under them.
        sender = str(sm.get("from", "") or "").strip() or f"carino-pacs@{host}"
        msg = EmailMessage()
        msg["Subject"] = SUBJECTS.get(
            payload.get("event", "").split(".")[-1],
            "Carino DICOM: emergency failover").format(
                dest=payload.get("destination", "") or "the primary")
        msg["From"] = sender
        msg["To"] = to
        msg.set_content(self._body_for(payload, profile))

        port = int(_positive(sm.get("port"), 587))
        timeout = _positive(sm.get("timeout_sec"), 15.0)
        mode = str(sm.get("tls", "starttls") or "starttls").strip().lower()
        if mode not in ("starttls", "ssl", "none"):
            # A loaded config is not validated, and an unrecognised value used
            # to mean "no encryption" — with the password sent anyway.
            self._note_error(f"notify.smtp.tls is {sm.get('tls')!r}, not starttls, ssl or none — "
                             f"no mail was sent")
            return
        user = str(sm.get("username", "") or "")
        password = str(sm.get("password", "") or "")
        if mode == "none" and user:
            from .config import is_loopback_host
            if not (is_loopback_host(host) or sm.get("allow_plaintext_auth") is True):
                self._note_error("notify.smtp.tls is 'none' with a username — the password "
                                 "would cross the network in cleartext; not sent")
                return
        try:
            ctx = _smtp_context(sm)
            if mode == "ssl":
                server = smtplib.SMTP_SSL(host, port, timeout=timeout, context=ctx)
            else:
                server = smtplib.SMTP(host, port, timeout=timeout)
            with server:
                if mode == "starttls":
                    server.starttls(context=ctx)
                # Authentication is opt-in by the presence of a username,
                # because the relay this is usually pointed at is the hospital's
                # own and takes internal mail without credentials. Calling
                # login() unconditionally would fail against exactly that
                # server, and the failure would look like a bad password.
                if user:
                    server.login(user, password)
                server.send_message(msg)
            self._note_sent(f"email to {to}")
        except Exception as exc:
            self._note_error(f"SMTP to {to} via {host}:{port} failed ({exc})")

    @staticmethod
    def _body_for(payload: dict, profile) -> str:
        """The message as this recipient should read it.

        Two things vary. The GUIDANCE varies by role, because the three people
        being told about one outage have three different jobs to do about it and
        a single generic paragraph helps none of them. The DETAIL varies by
        capability: the State / Since lines go only to somebody who could have
        read them in the dashboard (routing.read). The destination NAME is in
        every message — subject and headline — because it is what the outage is
        about; no host, port or error text is ever included. An e-mail leaves the appliance and
        cannot be un-sent, so it is the last place to be generous with
        information the reader is not cleared for.
        """
        role = (getattr(profile, "role", "") or "").casefold()
        guidance = ROLE_GUIDANCE.get(role, GENERIC_GUIDANCE)
        dest = payload.get("destination", "") or "the primary destination"
        event = payload.get("event", "")

        if event.endswith("resolved"):
            # Worded from what is actually known, never assumed: an operator can
            # press Resume normal while the primary is still down.
            online = payload.get("primary_online")
            if online is False:
                headline = (f"Emergency mode was ended by an operator, but {dest} is still "
                            f"NOT answering. Studies are not being delivered to it.")
            else:
                headline = (f"{dest} is reachable again and Carino DICOM has returned to "
                            f"normal operation.")
                if payload.get("was_active", True):
                    left = payload.get("held_remaining")
                    if left:
                        headline += f" {left} held instance(s) are still being forwarded."
                    else:
                        headline += " Studies held during the outage are being forwarded."
        elif event.endswith("activated"):
            by = payload.get("activated_by") or "the system"
            headline = (f"Emergency failover is ACTIVE, activated by {by}. "
                        f"Carino DICOM is serving the modality worklist locally and "
                        f"holding received studies for {dest}.")
        else:
            headline = (f"{dest} has stopped answering and Carino DICOM has raised an "
                        f"emergency. Failover has NOT been activated — it is waiting "
                        f"for someone to decide.")

        lines = [headline, "", guidance, ""]
        # Capability-gated detail. routing.read is what the dashboard requires
        # to show the destination table, so it is what this requires to put an
        # address in an e-mail.
        if getattr(profile, "can", None) and profile.can("routing.read"):
            lines += [f"Destination: {dest}",
                      f"State: {payload.get('state', '')}",
                      f"Since: {payload.get('since', '') or 'just now'}", ""]
        lines += ["Open the Carino DICOM dashboard to act on this.",
                  "",
                  "— Carino DICOM. This message was sent because your profile is named "
                  "in this appliance's emergency notification list."]
        return "\n".join(lines)

    # ---- status ----------------------------------------------------------
    def stats(self) -> dict:
        """What the dashboard is told about this notifier. Never a secret.

        The webhook signing key is reported as the one bit an operator needs —
        whether the POSTs are signed at all — and the SMTP password is not
        reported in any form. Both are write-only everywhere else in the app:
        redacted out of GET /api/config, refused if they come back in on a save,
        settable only through POST /api/notify/secret. This dict rides the
        status payload, which is polled continuously, so a field here that
        echoed either value would quietly undo all of that in the least likely
        place anyone thought to look.
        """
        wh = self._webhook
        sm = self._smtp
        return {
            "enabled": self.enabled,
            "webhook": {
                "enabled": bool(wh.get("enabled", False)),
                "configured": bool(str(wh.get("url", "") or "").strip()),
                "signed": bool(str(wh.get("secret", "") or "")),
            },
            "smtp": {
                "enabled": bool(sm.get("enabled", False)),
                "configured": bool(str(sm.get("host", "") or "").strip()),
                "host": str(sm.get("host", "") or ""),
            },
            "sent": self.sent,
            "failed": self.failed,
            # A dropped notification is one the appliance decided not to keep.
            # Published rather than only counted internally, because "nobody was
            # told" is the failure this whole module exists to prevent.
            "dropped": self.dropped,
            "queued": self._q.qsize(),
            "last_sent": self.last_sent,
            "last_error": self.last_error,
        }


def _positive(value: Any, default: float) -> float:
    """A timeout or port from a hand-edited config, coerced or defaulted.

    A zero or negative timeout means "never time out" to urllib and smtplib,
    which would hang the worker thread on a black-holed host until the process
    ends — one unreachable webhook and no notification ever leaves again.
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if number > 0 else default
