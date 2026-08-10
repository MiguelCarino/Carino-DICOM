"""A tiny thread-safe log ring buffer shared by the DICOM threads and the
web dashboard.  Every component logs through here so the UI can poll a single
stream of recent events without wiring up a real logging backend.

If a ``log_dir`` is set, each entry is also appended to a dated file
(``<log_dir>/YYYY-MM-DD.log``, UTC), giving a persistent per-day history."""

from __future__ import annotations

import os
import threading
import time
from collections import deque
from datetime import datetime, timezone


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

    def __init__(self, capacity: int = 500, log_dir: str = ""):
        self._lock = threading.Lock()
        self._flock = threading.Lock()
        self._items: "deque[dict]" = deque(maxlen=capacity)
        self._seq = 0
        self.log_dir = log_dir

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

    def tail(self, n: int = 100) -> list[dict]:
        with self._lock:
            return list(self._items)[-n:]

    @property
    def last_seq(self) -> int:
        with self._lock:
            return self._seq
