"""A tiny thread-safe log ring buffer shared by the DICOM threads and the
web dashboard.  Every component logs through here so the UI can poll a single
stream of recent events without wiring up a real logging backend.

If a ``log_dir`` is set, each entry is also appended to a dated file
(``<log_dir>/YYYY-MM-DD.log``, UTC), giving a persistent per-day history."""

from __future__ import annotations

import os
import re
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Optional


_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_DAY_FILE = re.compile(r"^\d{4}-\d{2}-\d{2}\.log$")


def _as_int(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


class LogBuffer:
    """One buffer per process, written by every thread in it: every listener,
    the folder watcher and the monitors call add() on the same instance while
    the dashboard polls since() from Flask's workers.

    The two locks are not the same lock on purpose. ``_lock`` guards the ring
    and the sequence counter; ``_flock`` serialises the append to the dated
    file, and add() has let go of ``_lock`` before it takes it — so a log
    folder that has gone slow, full or missing blocks only the thread doing
    that write, and the ring stays readable and writable by everyone else. What
    that costs is file ORDER: two entries can reach the file in the opposite
    order to the seq they were given, and the stamp on the line is only to the
    second, so it cannot always sort them back. The dashboard reads the ring
    instead, where the entries are in the order the seq was handed out because
    both happen under the one lock. A receiver blocked behind a full disk would
    have been the worse half of that trade.
    """

    # Big enough that a chatty print session or an index rescan does not push
    # the one failure an operator is looking for out of the dashboard's reach;
    # the dated files keep everything older.
    def __init__(self, capacity: int = 2000, log_dir: str = ""):
        self._lock = threading.Lock()
        self._flock = threading.Lock()
        self._items: "deque[dict]" = deque(maxlen=capacity)
        self._seq = 0
        self.log_dir = log_dir
        # kind -> {"message", "at"} of the newest warn/error of that kind. Kept
        # beside the ring rather than searched for in it: a service card asks
        # every two seconds, and its last problem must outlive both the ring
        # rotating and the listener object being rebuilt by a Stop/Start.
        self._problems: dict[str, dict] = {}

    def add(self, level: str, message: str, **fields) -> None:
        """Record one event. Extra keyword arguments ride along in the entry.

        Those extras are handed to the browser verbatim by the Activity poll,
        so they are an interface, not scratch space. ``kind`` is the one this
        module reads itself (it prefixes the line in the dated file), and the
        dashboard keys off the same values — "store", "send", "print", "ris",
        "mwl", "qr" — to decide which services it has seen traffic for. A typo
        in one is a service that looks idle while it works.
        """
        with self._lock:
            self._seq += 1
            entry = {
                "seq": self._seq,
                "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "epoch": int(time.time()),
                "level": level,
                "message": message,
                **fields,
            }
            self._items.append(entry)
            if level in ("warn", "error") and fields.get("kind"):
                self._problems[str(fields["kind"])] = {"message": message, "at": entry["epoch"]}
        self._write_file(entry)

    def _write_file(self, entry: dict) -> None:
        if not self.log_dir:
            return
        with self._flock:
            try:
                os.makedirs(self.log_dir, exist_ok=True)
                day = entry["ts"][:10]  # YYYY-MM-DD (UTC)
                kind = entry.get("kind", "")
                prefix = (kind + " ") if kind else ""
                line = "%s [%-5s] %s%s\n" % (entry["ts"], entry["level"].upper(), prefix, entry["message"])
                # 0640, not the 0644 a plain open() gives: these lines carry
                # patient names, patient IDs, accession numbers and the AE titles
                # of every node this box talks to. On a shared machine that is a
                # patient list any unprivileged account could read.
                path = os.path.join(self.log_dir, day + ".log")
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o640)
                with os.fdopen(fd, "a", encoding="utf-8") as fh:
                    fh.write(line)
            except OSError:
                pass

    def info(self, message: str, **f) -> None:
        self.add("info", message, **f)

    def warn(self, message: str, **f) -> None:
        self.add("warn", message, **f)

    def error(self, message: str, **f) -> None:
        self.add("error", message, **f)

    def since(self, seq: int = 0) -> list[dict]:
        """Return every entry whose seq is greater than `seq` (for UI polling)."""
        with self._lock:
            return [it for it in self._items if it["seq"] > seq]

    def query(self, since: int = 0, kinds=None, level: str = "", text: str = "",
              limit: int = 0) -> list[dict]:
        """since() with the Activity log's filters, newest ``limit`` kept.

        ``level`` "warn" means warn and error, "error" only error. ``text`` is a
        case-insensitive substring of the message."""
        floor = {"warn": ("warn", "error"), "error": ("error",)}.get(level)
        kinds = {k for k in (kinds or []) if k}
        needle = text.lower()
        after = _as_int(since)
        with self._lock:
            out = [it for it in self._items
                   if it["seq"] > after
                   and (not kinds or it.get("kind") in kinds)
                   and (floor is None or it["level"] in floor)
                   and (not needle or needle in str(it["message"]).lower())]
        return out[-limit:] if limit and limit > 0 else out

    def last_problem(self, *kinds: str) -> Optional[dict]:
        """The newest warn/error logged under any of ``kinds``, or None."""
        with self._lock:
            found = [self._problems[k] for k in kinds if k in self._problems]
        return dict(max(found, key=lambda p: p["at"])) if found else None

    # ---- the dated files -----------------------------------------------------
    def days(self) -> list[str]:
        """The days that have a log file, newest first."""
        try:
            names = os.listdir(self.log_dir) if self.log_dir else []
        except OSError:
            return []
        return sorted((n[:-4] for n in names if _DAY_FILE.fullmatch(n)), reverse=True)

    def day_file(self, day: str) -> Optional[str]:
        """Path of one day's file, or None. The day is matched against the
        file-name pattern before it is joined, so nothing a caller sends can
        name a file outside the log folder."""
        if not self.log_dir or not _DAY.fullmatch(str(day or "")):
            return None
        path = os.path.join(self.log_dir, day + ".log")
        return path if os.path.isfile(path) else None

    def tail(self, n: int = 100) -> list[dict]:
        with self._lock:
            return list(self._items)[-n:]

    @property
    def last_seq(self) -> int:
        with self._lock:
            return self._seq
