"""Opt-in check for a newer release.

Off unless `web.update_check` is true, which only an administrator can set. When
it is on, the engine asks GitHub's releases API for the latest stable tag at most
once a day: one HTTPS GET carrying a User-Agent and nothing else. No identifier,
nothing about this machine, its studies or its operator. Nothing is downloaded or
installed — the dashboard shows the answer and links to the website.

The engine asks rather than the browser on purpose. A cross-origin fetch from the
dashboard would carry an Origin header naming the appliance's own address
(`http://10.0.0.5:8042`) to GitHub on every check.

A failure is recorded for the Overview and otherwise SILENT: no retry loop and no
log line. Air-gapped sites are the normal case, and a daily "could not reach
GitHub" would be noise in the one log an operator reads to find a real fault.
"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.request
from typing import Optional

REPO = "MiguelCarino/Carino-DICOM"
# /releases/latest excludes pre-releases, so an rc tag never reads as an update.
API_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
WEBSITE = "https://dicom.carino.systems/"
INTERVAL_SEC = 24 * 60 * 60
TIMEOUT_SEC = 10
# A release payload is a few kB; anything past this is not the reply we asked for.
MAX_BYTES = 256 * 1024

_VERSION = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


def parse_version(tag) -> Optional[tuple]:
    m = _VERSION.match(str("" if tag is None else tag).strip())
    return tuple(int(x) for x in m.groups()) if m else None


def is_newer(remote, local) -> bool:
    """Numeric, field by field: "1.10.0" is newer than "1.9.0" although it sorts
    first as text. A tag this cannot parse is "no update" — the only safe reading
    of a version we do not understand is that ours is fine."""
    a, b = parse_version(remote), parse_version(local)
    return bool(a and b and a > b)


def fetch_latest_tag(current: str) -> Optional[str]:
    req = urllib.request.Request(API_URL, headers={
        "Accept": "application/vnd.github+json",
        # GitHub refuses a request without one, so every check would fail.
        "User-Agent": f"Carino-DICOM/{current}",
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as res:
        if res.status != 200:
            return None
        body = res.read(MAX_BYTES + 1)
    if len(body) > MAX_BYTES:
        return None
    tag = json.loads(body.decode("utf-8")).get("tag_name")
    return tag if isinstance(tag, str) else None


class UpdateCheck:
    def __init__(self, current: str, fetch=fetch_latest_tag, clock=time.time):
        self.current = current
        self._fetch = fetch
        self._clock = clock
        self._lock = threading.Lock()
        self._latest: Optional[str] = None
        self._checked_at = 0.0
        self._reachable: Optional[bool] = None
        self._running = False

    def maybe_check(self, enabled: bool, force: bool = False) -> None:
        """Start a background check when one is due. Cheap enough for every
        status poll: it returns at once unless a day has passed (or `force`)."""
        if not enabled:
            return
        with self._lock:
            if self._running:
                return
            if not force and self._checked_at and self._clock() - self._checked_at < INTERVAL_SEC:
                return
            self._running = True
        threading.Thread(target=self._run, name="update-check", daemon=True).start()

    def _run(self) -> None:
        try:
            tag = self._fetch(self.current)
            ok = tag is not None
        except Exception:
            tag, ok = None, False
        with self._lock:
            # A failed check keeps the last good answer, so a newer release that
            # was already found does not disappear because one request failed.
            if ok:
                self._latest = tag
            self._reachable = ok
            self._checked_at = self._clock()
            self._running = False

    def status(self, enabled: bool) -> dict:
        with self._lock:
            latest = self._latest if enabled else None
            return {
                "enabled": bool(enabled),
                "current": self.current,
                "latest": latest,
                "newer": bool(enabled and is_newer(latest, self.current)),
                "checked_at": int(self._checked_at) if enabled else 0,
                "reachable": self._reachable if enabled else None,
                "checking": bool(enabled and self._running),
                "website": WEBSITE,
            }
