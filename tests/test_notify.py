"""Outbound notification: webhook and e-mail.

Runs under pytest, or standalone: python3 tests/test_notify.py

The webhook half is driven against a REAL local HTTP server rather than a mocked
urlopen, because two of the three things worth asserting are properties of the
wire: the signature covers the exact bytes sent, and a receiver that answers 4xx
is not retried while one that answers 5xx is. A mock would assert that the mock
was called.

Everything here is also about staying out of the caller's way. The thread that
calls this is the emergency monitor — the only source of destination health on
the appliance — so a webhook that hangs, an SMTP server that is down, or a
config full of nonsense must all end in a counter and a log line, never in an
exception and never in a delay.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest                                            # noqa: E402

from pacs import users as U                              # noqa: E402
from pacs.notify import Notifier                         # noqa: E402


class FakeLog:
    def __init__(self):
        self.lines = []

    def info(self, msg, kind=""):
        self.lines.append(("info", msg))

    def warn(self, msg, kind=""):
        self.lines.append(("warn", msg))

    def error(self, msg, kind=""):
        self.lines.append(("error", msg))


class Cfg:
    def __init__(self, notify):
        self.notify = notify


class Receiver:
    """A real HTTP endpoint that records what arrived and can be told to fail."""

    def __init__(self, status=200):
        self.status = status
        self.hits = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(n)
                outer.hits.append({"headers": dict(self.headers), "body": body})
                self.send_response(outer.status)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *a):
                pass

        self.httpd = HTTPServer(("127.0.0.1", 0), H)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.httpd.server_address[1]}/hook"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def wait(self, n=1, timeout=8.0):
        deadline = time.time() + timeout
        while len(self.hits) < n and time.time() < deadline:
            time.sleep(0.05)
        return len(self.hits)


STATUS = {"state": "triggered", "trigger_dest": "Primary PACS",
          "since": "2026-08-06T03:00:00Z", "activated_by": ""}


def person(role, **over):
    row = {"id": U.new_id(), "name": "Somebody", "role": role, "enabled": True,
           "email": "somebody@hospital.test", "capabilities": [], "phi_visible": []}
    row.update(over)
    return U.Profile(row)


@pytest.fixture()
def receiver():
    r = Receiver()
    yield r
    r.close()


def notifier_for(receiver, *, secret="", retries=1, log=None):
    return Notifier(Cfg({
        "enabled": True,
        "webhook": {"enabled": True, "url": receiver.url, "secret": secret,
                    "timeout_sec": 3, "retries": retries},
        "smtp": {"enabled": False},
    }), log=log or FakeLog())


# ---- the webhook --------------------------------------------------------

def test_an_event_reaches_the_receiver_with_the_facts_of_the_outage(receiver):
    n = notifier_for(receiver)
    try:
        n.emergency("triggered", STATUS, [])
        assert receiver.wait() == 1
        body = json.loads(receiver.hits[0]["body"])
        assert body["event"] == "emergency.triggered"
        assert body["destination"] == "Primary PACS"
        assert body["state"] == "triggered"
    finally:
        n.stop()


def test_the_signature_covers_the_exact_bytes_that_were_sent(receiver):
    """Signed over the body as transmitted, not over a re-serialisation.

    A proxy that reformats the JSON has to invalidate the signature rather than
    pass an altered body off as genuine — which is what a signature computed
    from the parsed object would have allowed.
    """
    n = notifier_for(receiver, secret="sig-key")
    try:
        n.emergency("triggered", STATUS, [])
        assert receiver.wait() == 1
        hit = receiver.hits[0]
        expected = "sha256=" + hmac.new(b"sig-key", hit["body"], hashlib.sha256).hexdigest()
        assert hit["headers"].get("X-Carino-Signature") == expected
    finally:
        n.stop()


def test_no_secret_means_no_signature_header_rather_than_an_empty_one(receiver):
    n = notifier_for(receiver)
    try:
        n.emergency("triggered", STATUS, [])
        assert receiver.wait() == 1
        assert "X-Carino-Signature" not in receiver.hits[0]["headers"]
    finally:
        n.stop()


def test_a_5xx_is_retried(receiver):
    receiver.status = 503
    log = FakeLog()
    n = notifier_for(receiver, retries=2, log=log)
    try:
        n.emergency("triggered", STATUS, [])
        assert receiver.wait(3) == 3            # the attempt plus two retries
        time.sleep(0.3)
        assert n.stats()["failed"] == 1
        assert any("webhook POST" in msg for _lvl, msg in log.lines)
    finally:
        n.stop()


def test_a_4xx_is_not_retried_because_the_body_will_not_get_better(receiver):
    """Retrying an unchanged body against a receiver that called it malformed
    just makes the same mistake three times."""
    receiver.status = 400
    n = notifier_for(receiver, retries=3)
    try:
        n.emergency("triggered", STATUS, [])
        time.sleep(1.2)
        assert len(receiver.hits) == 1
    finally:
        n.stop()


def test_a_429_IS_retried_because_it_means_later_not_wrong(receiver):
    receiver.status = 429
    n = notifier_for(receiver, retries=1)
    try:
        n.emergency("triggered", STATUS, [])
        assert receiver.wait(2) == 2
    finally:
        n.stop()


def test_an_unreachable_receiver_is_a_counter_and_a_log_line_not_an_exception():
    log = FakeLog()
    n = Notifier(Cfg({
        "enabled": True,
        # Nothing is listening here. The port is closed, so this fails fast
        # rather than hanging, which is what makes the test bounded.
        "webhook": {"enabled": True, "url": "http://127.0.0.1:9/hook",
                    "timeout_sec": 2, "retries": 0},
        "smtp": {"enabled": False},
    }), log=log)
    try:
        n.emergency("triggered", STATUS, [])       # must not raise
        time.sleep(1.5)
        assert n.stats()["failed"] >= 1
        assert n.stats()["last_error"]
    finally:
        n.stop()


def test_notification_switched_off_sends_nothing(receiver):
    n = Notifier(Cfg({
        "enabled": False,
        "webhook": {"enabled": True, "url": receiver.url},
        "smtp": {"enabled": False},
    }), log=FakeLog())
    try:
        n.emergency("triggered", STATUS, [])
        time.sleep(0.5)
        assert receiver.hits == []
    finally:
        n.stop()


def test_the_queue_is_bounded_and_drops_the_oldest():
    """An endpoint that has gone away must not let a backlog grow until the
    PACS runs out of memory — and a "primary is down" message delivered forty
    minutes after it recovered is actively misleading, so the NEWEST wins."""
    n = Notifier(Cfg({"enabled": True,
                      "webhook": {"enabled": False},
                      "smtp": {"enabled": False}}), log=FakeLog())
    from pacs.notify import QUEUE_MAX
    for i in range(QUEUE_MAX + 40):
        n._enqueue(("webhook", {"event": f"e{i}"}, None))
    assert n._q.qsize() <= QUEUE_MAX
    assert n.dropped >= 40
    # The most recent event survived, which is the one describing the current
    # state of the appliance.
    last = None
    while not n._q.empty():
        last = n._q.get_nowait()
    assert last[1]["event"] == f"e{QUEUE_MAX + 39}"


def test_a_timeout_of_zero_does_not_mean_wait_forever():
    """urllib and smtplib read 0 as "no timeout", which would hang the worker on
    a black-holed host until the process ends — one bad host and no notification
    ever leaves again."""
    from pacs.notify import _positive
    assert _positive(0, 10.0) == 10.0
    assert _positive(-5, 10.0) == 10.0
    assert _positive("nonsense", 10.0) == 10.0
    assert _positive(3, 10.0) == 3.0


def test_stop_is_safe_before_anything_was_ever_sent():
    n = Notifier(Cfg({"enabled": False}), log=FakeLog())
    n.stop()            # must not raise, must not hang


# ---- the message ---------------------------------------------------------

def test_each_role_is_told_what_ITS_job_is_about_this_outage():
    """The requirement the whole notify feature exists for: three people, one
    outage, three different things to do about it."""
    payload = {"event": "emergency.triggered", "destination": "Primary PACS",
               "state": "triggered", "since": "now"}
    bodies = {role: Notifier._body_for(payload, person(role))
              for role in ("receptionist", "radiologist", "it")}
    assert "by hand" in bodies["receptionist"]
    assert "accession" in bodies["receptionist"]
    assert "alternate destination" in bodies["radiologist"]
    assert "health probe" in bodies["it"]
    assert len(set(bodies.values())) == 3


def test_an_unrecognised_role_gets_neutral_wording_not_silence():
    """A role is free text an administrator typed. Anything else would make
    naming a role wrongly into a notification nobody receives."""
    body = Notifier._body_for({"event": "emergency.triggered", "destination": "P"},
                              person("pathologist"))
    assert "still receiving" in body
    assert "Nothing is lost" in body


def test_the_destination_address_only_goes_to_somebody_who_could_read_it_anyway():
    """An e-mail leaves the appliance and cannot be un-sent, so it is the last
    place to be generous with information the reader is not cleared for."""
    payload = {"event": "emergency.triggered", "destination": "Primary PACS",
               "state": "triggered", "since": "03:00"}
    allowed = Notifier._body_for(payload, person("it", capabilities=["routing.read"]))
    withheld = Notifier._body_for(payload, person("receptionist"))
    assert "State: triggered" in allowed
    assert "State:" not in withheld


def test_the_three_events_read_differently():
    p = person("radiologist")
    triggered = Notifier._body_for({"event": "emergency.triggered", "destination": "P"}, p)
    activated = Notifier._body_for({"event": "emergency.activated", "destination": "P",
                                    "activated_by": "Ana Ruiz"}, p)
    resolved = Notifier._body_for({"event": "emergency.resolved", "destination": "P"}, p)
    assert "has NOT been activated" in triggered
    assert "Ana Ruiz" in activated
    assert "returned to" in resolved and "forwarded" in resolved


def test_only_people_with_an_address_are_queued_for_email(receiver):
    n = notifier_for(receiver)
    try:
        n.emergency("triggered", STATUS, [person("it", email=""),
                                          person("radiologist", email="a@b.test")])
        time.sleep(0.4)
        # One webhook plus one e-mail attempt; the address-less profile is not
        # queued at all rather than queued and failed.
        assert n.stats()["queued"] + n.stats()["sent"] + n.stats()["failed"] <= 2
    finally:
        n.stop()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
