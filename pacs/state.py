"""Persistent per-file send state so restarts don't re-forward everything.

Keyed by absolute path; each entry remembers the file's size+mtime (to detect
that a same-named file was replaced with new content), which destinations have
already accepted it, and any destination it was PINNED to — a delivery promised
by whoever queued the file, which the routing rules may widen but never revoke.
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Optional


class SendState:
    """The record of what has already been delivered, shared by every thread.

    One instance per process, owned by FolderWatcher. The watcher thread reads
    and rewrites entries on every pass while the dashboard reaches the same
    object from Flask's worker threads.

    The lock guards the MAP: which paths are known and which entry object each
    one holds. It does not guard the entries. get() hands back the live entry
    rather than a copy, so a caller mutates it in place and put() writes the
    same object back; all_entries() is the exception and copies, because its
    caller is somewhere else entirely. Nothing reaches disk until save() is
    called — the watcher does that once at the end of a pass, so a kill in the
    middle of one re-sends what that pass had already delivered.

    Because entries are mutated outside the lock, every reader that walks the
    whole map (save, all_entries, clear_backoff) snapshots it with the C JSON
    encoder in one call, which never yields the GIL part-way: walking it with
    Python code raced the watcher and raised "dictionary changed size during
    iteration".

    Pins (emergency hold-and-forward) are made durable through a small append
    journal beside the state file instead of a full rewrite per instance, so
    the C-STORE thread pays O(1), not O(size of the ledger), per held image.
    """

    def __init__(self, path: str, log=None):
        self.path = path
        self.log = log
        self._lock = threading.Lock()
        self._data: dict[str, dict] = {}
        self._dirty = False
        # key -> JSON of the entry as last put()/saved: put() only marks the
        # map dirty when the entry actually changed, so an idle pass does not
        # rewrite the whole sidecar every poll.
        self._fp: dict[str, str] = {}
        # Paths dropped while their file is gone: a watcher still holding the
        # old entry must not put() it back.
        self._tombstones: set[str] = set()
        # Set when the state file could not be used and was set aside.
        self.load_problem = ""
        self._load()

    @property
    def journal_path(self) -> str:
        return self.path + ".pins"

    def _say(self, msg: str) -> None:
        if self.log is not None:
            try:
                self.log.error(msg, kind="send")
            except Exception:
                pass

    def _quarantine(self, why: str) -> None:
        stamp = time.strftime("%Y%m%dT%H%M%S")
        aside = f"{self.path}.corrupt-{stamp}"
        try:
            os.replace(self.path, aside)
        except OSError:
            aside = "(could not be moved aside)"
        self.load_problem = (f"The send-state ledger {self.path} was unusable ({why}) and has been "
                             f"set aside as {aside}. Send history and hold-and-forward pins were "
                             f"reset: files still in the outgoing folder will be offered again.")
        self._say(self.load_problem)

    def _load(self) -> None:
        # A missing state file is an empty one. An unreadable or corrupt one is
        # ALSO treated as empty — that is the only outcome that still lets the
        # watcher start, and the cost is duplicate sends, never a lost image —
        # but it is set aside and SAID, never silently overwritten: it held the
        # emergency pins, and the operator has to know those were reset.
        if os.path.exists(self.path):
            try:
                with open(self.path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
            except (OSError, ValueError) as exc:
                data = None
                self._quarantine(f"not readable as JSON: {exc}")
            if data is not None and not isinstance(data, dict):
                self._quarantine(f"a JSON {type(data).__name__}, not an object")
                data = None
            if isinstance(data, dict):
                self._data = {k: v for k, v in data.items()
                              if isinstance(k, str) and isinstance(v, dict)}
        self._fold_journal()

    def _fold_journal(self) -> None:
        """Re-apply pins recorded since the last full save."""
        try:
            with open(self.journal_path, "r", encoding="utf-8") as fh:
                lines = fh.readlines()
        except OSError:
            return
        for line in lines:
            try:
                rec = json.loads(line)
            except ValueError:
                continue            # a torn last line from a crash mid-append
            if not isinstance(rec, dict):
                continue
            key, names = rec.get("path"), rec.get("pin")
            if not isinstance(key, str) or not isinstance(names, list):
                continue
            e = self._data.get(key)
            if not e or e.get("size") != rec.get("size") or e.get("mtime") != rec.get("mtime"):
                e = {"sent": [], "size": rec.get("size"), "mtime": rec.get("mtime")}
                self._data[key] = e
            pinned = e.setdefault("pin", [])
            for n in names:
                if n not in pinned:
                    pinned.append(n)
            self._dirty = True

    def get(self, path: str, size: int, mtime: float) -> dict:
        """Return the entry for `path`, resetting it if the file changed."""
        key = os.path.abspath(path)
        with self._lock:
            self._tombstones.discard(key)
            e = self._data.get(key)
            if not isinstance(e, dict) or e.get("size") != size or e.get("mtime") != mtime:
                e = {"sent": [], "size": size, "mtime": mtime}
                self._data[key] = e
                self._dirty = True
            return e

    def peek(self, path: str) -> dict | None:
        """Return the existing entry for `path` without creating one (read-only)."""
        with self._lock:
            return self._data.get(os.path.abspath(path))

    def pin(self, path: str, names, durable: bool = False) -> None:
        """Record destinations this file MUST reach whatever the routing rules
        decide, and stamp the entry against the bytes on disk right now.

        Emergency hold-and-forward drops a copy of every received instance into
        the outgoing folder so the primary PACS back-fills when it returns. That
        promise cannot be left to the rule engine: one `stop` rule aimed
        elsewhere would send the held copy to a teaching archive, mark it fully
        sent and let it be archived (or deleted) having never reached the
        primary — the failover guarantee silently void. The pin travels with the
        bytes, so get() dropping it along with the rest of the entry when the
        file is replaced is correct: new content is a new promise.

        *durable* appends the pin to the journal (fsynced) so it survives a
        crash before the next full save — at constant cost per call."""
        names = [str(n) for n in names if str(n or "").strip()]
        if not names:
            return
        key = os.path.abspath(path)
        try:
            size = os.path.getsize(key)
            mtime = os.path.getmtime(key)
        except OSError:
            return
        with self._lock:
            self._tombstones.discard(key)
            e = self._data.get(key)
            if not e or e.get("size") != size or e.get("mtime") != mtime:
                e = {"sent": [], "size": size, "mtime": mtime}
                self._data[key] = e
            pinned = e.setdefault("pin", [])
            for n in names:
                if n not in pinned:
                    pinned.append(n)
            self._dirty = True
            if durable:
                line = json.dumps({"path": key, "size": size, "mtime": mtime, "pin": names})
                try:
                    fd = os.open(self.journal_path,
                                 os.O_WRONLY | os.O_CREAT | os.O_APPEND
                                 | getattr(os, "O_NOFOLLOW", 0), 0o600)
                    try:
                        os.write(fd, (line + "\n").encode("utf-8"))
                        os.fsync(fd)
                    finally:
                        os.close(fd)
                except OSError as exc:
                    self._say(f"Could not journal a hold-and-forward pin for "
                              f"{os.path.basename(key)}: {exc} — it is kept in memory and "
                              f"written at the next save")

    def put(self, path: str, entry: dict) -> None:
        key = os.path.abspath(path)
        try:
            fp = json.dumps(entry, sort_keys=True)
        except (TypeError, ValueError):
            fp = None
        with self._lock:
            if key in self._tombstones and not os.path.exists(key):
                return      # discarded while a pass still held it: stay gone
            prev = self._data.get(key)
            if prev is entry and fp is not None and self._fp.get(key) == fp:
                return      # nothing changed since the last put: no rewrite
            self._data[key] = entry
            if fp is not None:
                self._fp[key] = fp
            self._dirty = True

    def drop(self, path: str) -> None:
        key = os.path.abspath(path)
        with self._lock:
            self._fp.pop(key, None)
            if not os.path.exists(key):
                self._tombstones.add(key)
                if len(self._tombstones) > 65536:
                    self._tombstones.clear()
            if self._data.pop(key, None) is not None:
                self._dirty = True

    def _snapshot_locked(self) -> str:
        # One call into the C encoder: it never releases the GIL while walking,
        # so a watcher mutating an entry cannot change a dict mid-iteration.
        return json.dumps(self._data)

    def all_entries(self) -> dict:
        """A copy of every (path -> entry) pair, for read-only scans (the
        'stuck sends' view). Entries are copied so callers can't mutate state
        without going through put()."""
        with self._lock:
            blob = self._snapshot_locked()
        return json.loads(blob)

    def clear_backoff(self, dest_names=None, enabled=None, existing_only: bool = False) -> int:
        """Zero the retry-backoff timer on failing destinations so the next
        watcher pass attempts them immediately. `dest_names` limits it to those
        destinations (None = all); `enabled`, when given, further limits it to
        names that are live destinations, and `existing_only` to files that are
        still on disk — so the count returned is what will actually be retried."""
        touched = 0
        with self._lock:
            items = list(self._data.items())
        for key, e in items:
            if not isinstance(e, dict):
                continue
            if existing_only and not os.path.exists(key):
                continue
            fails = e.get("fail") or {}
            hit = False
            for name, f in list(fails.items()):
                if dest_names is not None and name not in dest_names:
                    continue
                if enabled is not None and name not in enabled:
                    continue
                if isinstance(f, dict) and f.get("next_try", 0):
                    f["next_try"] = 0
                    hit = True
            if hit:
                touched += 1
        if touched:
            with self._lock:
                self._dirty = True
        return touched

    def save(self) -> None:
        """Write the map to disk if anything has changed since the last save.

        Unique temp file, fsync, rename, fsync the directory (atomicio), so a
        reader — the next `pacs serve` starting up — sees the whole old map or
        the whole new one, and a power cut cannot leave an empty ledger behind
        a rename that already landed. 0600: it names every patient folder.

        A write that fails is logged and leaves the map marked dirty, so the
        next save carries the same change. It never raises.
        """
        from .atomicio import atomic_write_text
        with self._lock:
            if not self._dirty:
                return
            try:
                blob = self._snapshot_locked()
                atomic_write_text(self.path, blob, mode=0o600)
                self._dirty = False
            except Exception as exc:
                self._say(f"Could not save the send-state ledger {self.path}: {exc}")
                return
            # Everything the journal held is in the file now.
            try:
                if os.path.exists(self.journal_path):
                    os.remove(self.journal_path)
            except OSError:
                pass

    def save_problem(self) -> Optional[str]:
        return self.load_problem or None
