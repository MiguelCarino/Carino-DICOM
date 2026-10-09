"""The opt-in update check: off means nothing leaves the machine, on means at
most one request a day, and the answer reaches the Overview.

No network: every check goes through a stub in place of the GitHub fetch.

Run:  python3 tests/test_updates.py      (or under pytest)
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pacs import __version__, updates                       # noqa: E402
from pacs.config import Config, validate                    # noqa: E402
from pacs.server import PacsServer                          # noqa: E402
from pacs.updates import UpdateCheck, is_newer              # noqa: E402
from pacs.web import create_app                             # noqa: E402

_H = {"X-Carino": "1"}


class _Stub:
    """Stands in for fetch_latest_tag and counts the calls."""

    def __init__(self, answer="v9.0.0"):
        self.answer = answer
        self.calls = 0
        self.done = threading.Event()

    def __call__(self, current):
        self.calls += 1
        try:
            if isinstance(self.answer, Exception):
                raise self.answer
            return self.answer
        finally:
            self.done.set()


def _settle(chk: UpdateCheck, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if not chk.status(True)["checking"]:
            return
        time.sleep(0.01)
    raise AssertionError("update check never finished")


def test_versions_compare_as_numbers_not_text():
    assert is_newer("v1.10.0", "1.9.0")
    assert is_newer("1.2.1", "1.2.0")
    assert not is_newer("v1.2.0", "1.2.0")
    assert not is_newer("v1.1.9", "1.2.0")
    # A tag that is not a plain version is never an update.
    for odd in ("nightly", "v2.0.0-rc1", "", None, "2026-10-09"):
        assert not is_newer(odd, "1.2.0"), odd


def test_off_never_asks():
    stub = _Stub()
    chk = UpdateCheck("1.2.0", fetch=stub)
    for _ in range(5):
        chk.maybe_check(False)
        chk.maybe_check(False, force=True)
    time.sleep(0.05)
    assert stub.calls == 0
    st = chk.status(False)
    assert st["enabled"] is False and st["latest"] is None and st["newer"] is False


def test_on_asks_once_a_day():
    now = [1_000_000.0]
    stub = _Stub("v1.3.0")
    chk = UpdateCheck("1.2.0", fetch=stub, clock=lambda: now[0])
    chk.maybe_check(True)
    _settle(chk)
    for _ in range(10):              # every status poll calls this
        chk.maybe_check(True)
    _settle(chk)
    assert stub.calls == 1
    st = chk.status(True)
    assert st["latest"] == "v1.3.0" and st["newer"] is True and st["reachable"] is True
    assert st["website"] == updates.WEBSITE
    now[0] += updates.INTERVAL_SEC + 1
    chk.maybe_check(True)
    _settle(chk)
    assert stub.calls == 2


def test_a_failed_check_keeps_the_last_answer_and_says_so():
    stub = _Stub("v1.3.0")
    chk = UpdateCheck("1.2.0", fetch=stub)
    chk.maybe_check(True)
    _settle(chk)
    stub.answer = OSError("no route to host")
    chk.maybe_check(True, force=True)
    _settle(chk)
    st = chk.status(True)
    assert st["reachable"] is False
    assert st["latest"] == "v1.3.0" and st["newer"] is True


def test_the_setting_must_be_a_boolean():
    tmp = tempfile.mkdtemp(prefix="carino-upd-")
    try:
        cfg = Config(os.path.join(tmp, "config.json"))
        assert cfg.data["web"]["update_check"] is False
        cfg.data["web"]["update_check"] = "yes"
        try:
            validate(cfg.data)
        except ValueError as exc:
            assert "update_check" in str(exc)
        else:
            raise AssertionError("a string was accepted as web.update_check")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _server():
    tmp = tempfile.mkdtemp(prefix="carino-upd-")
    cfg = Config(os.path.join(tmp, "config.json"))
    cfg.data["logs_dir"] = os.path.join(tmp, "logs")
    cfg.data["index"]["enabled"] = False
    cfg.save()
    srv = PacsServer(cfg)
    stub = _Stub("v99.0.0")
    srv.update_check = UpdateCheck(__version__, fetch=stub)
    return srv, create_app(srv).test_client(), stub, tmp


def test_status_reports_the_version_and_stays_quiet_until_enabled():
    srv, client, stub, tmp = _server()
    try:
        for _ in range(3):
            up = client.get("/api/status").get_json()["update"]
        assert up["enabled"] is False and up["current"] == __version__
        time.sleep(0.05)
        assert stub.calls == 0
    finally:
        srv.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)


def test_enabling_from_the_dashboard_saves_checks_and_can_be_undone():
    srv, client, stub, tmp = _server()
    try:
        r = client.post("/api/update-check", json={"action": "enable"}, headers=_H)
        assert r.status_code == 200, r.get_json()
        assert stub.done.wait(5)
        _settle(srv.update_check)
        assert Config(srv.cfg.path).load().data["web"]["update_check"] is True
        up = client.get("/api/status").get_json()["update"]
        assert up["enabled"] and up["newer"] and up["latest"] == "v99.0.0", up

        r = client.post("/api/update-check", json={"action": "disable"}, headers=_H)
        assert r.status_code == 200
        assert Config(srv.cfg.path).load().data["web"]["update_check"] is False
        calls = stub.calls
        up = client.get("/api/status").get_json()["update"]
        assert up["enabled"] is False and up["latest"] is None
        r = client.post("/api/update-check", json={"action": "check"}, headers=_H)
        assert r.status_code == 200
        time.sleep(0.05)
        assert stub.calls == calls       # "check now" while off asks nobody

        assert client.post("/api/update-check", json={"action": "x"}, headers=_H).status_code == 400
    finally:
        srv.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"\nPASS — {len(tests)} update-check tests")
