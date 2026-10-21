"""What the Send button delivered, per study and per destination.

Auto-send keeps its own record (state.SendState), keyed by the files in the
outgoing folder. A study sent by hand from Received or Sent / Archived never
enters that folder, so before this record existed the only trace of it was the
Activity log: History showed the study as if nothing had ever been done with it.

Keyed by StudyInstanceUID, so the answer follows the study wherever it is
listed (Received, Outgoing, Sent / Archived). A study with no UID falls back to
its folder. Bounded: the oldest studies are forgotten past KEEP, so an
appliance that sends by hand every day does not grow this file without end.
"""

from __future__ import annotations

import json
import os
import threading
import time

KEEP = 2000


def study_key(study_uid: str, path: str) -> str:
    return study_uid or ("path:" + os.path.abspath(path))


class HandSends:
    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        self._data: dict = {}
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                self._data = data
        except (OSError, ValueError):
            pass

    def record(self, key: str, dest: str, *, ok: int, fail: int, held: int = 0,
               last_error: str = "", when: float | None = None) -> None:
        """One destination's outcome for one press of Send. Replaces that
        destination's previous outcome: the latest send is the answer."""
        now = time.time() if when is None else when
        with self._lock:
            st = self._data.setdefault(key, {"t": now, "dests": {}})
            st["t"] = now
            st["dests"][dest] = {"epoch": int(now), "ok": int(ok), "fail": int(fail),
                                 "held": int(held), "last_error": last_error or ""}
            if len(self._data) > KEEP:
                for k in sorted(self._data, key=lambda k: self._data[k].get("t", 0))[:len(self._data) - KEEP]:
                    del self._data[k]
            self._save()

    def get(self, key: str) -> list:
        """[{name, state, epoch, ok, fail, held, last_error}], by name.

        state: "sent" every instance arrived; "partial" some failed or were
        held; "failed" nothing arrived."""
        with self._lock:
            dests = dict((self._data.get(key) or {}).get("dests") or {})
        out = []
        for name in sorted(dests, key=str.lower):
            d = dests[name]
            bad = d.get("fail", 0) + d.get("held", 0)
            state = "failed" if not d.get("ok") else ("partial" if bad else "sent")
            out.append({"name": name, "state": state, **d})
        return out

    def _save(self) -> None:
        # Crash-safe and private (0600): it names studies and patients' folders.
        from .atomicio import atomic_write_text
        try:
            atomic_write_text(self.path, json.dumps(self._data), mode=0o600)
        except (OSError, TypeError, ValueError):
            pass
