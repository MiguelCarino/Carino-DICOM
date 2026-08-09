"""Caught worklist items — what another RIS answered when we asked it as one of
our modalities.

This is a **record, not a work queue**, and the separation from
:class:`pacs.ris.OrderStore` is deliberate and load-bearing rather than tidy.
``pacs/mwl.py`` serves *every open order in the OrderStore* as a worklist item,
so a caught order filed there would be handed straight back out to this
department's modalities — another hospital's orders, on your scanners, with no
step in between that anybody chose. Keeping them in a different file makes that
impossible by construction; a flag on a shared store would only make it
unlikely, and only until the next change to the query that reads it.

Consequences of "record, not queue", each of which is a thing this class does
NOT have:

  * no ``status`` — Carino neither completes nor cancels these; it did not
    create them and their real state lives in the RIS that did;
  * no Study Instance UID minting — the one on the item is the RIS's;
  * no reconciliation against arriving studies;
  * no worklist path of any kind.

What it is for: proving where a broken worklist is broken. A scanner is not
seeing its schedule, so the scanner is taken off the network, and this appliance
asks the RIS the same question the scanner would have asked, using the
scanner's own AE title. What comes back — and what does not — is the answer.

Written to ``<store_dir>/caught.json``. Bounded: this is diagnostic exhaust and
must not grow without limit on an appliance that runs for years.
"""
from __future__ import annotations

import json
import os
import threading
import uuid
from typing import Optional

from .logbuf import LogBuffer

# Probes are cheap to run and a bored operator will run a lot of them. Old
# rounds are dropped rather than kept for ever: the useful window is "what did
# it say just now", and a year of them is a file nobody reads holding
# identifiers nobody needs.
MAX_ROUNDS = 40


class CaughtStore:
    """Thread-safe, JSON-file-backed list of probe rounds."""

    def __init__(self, store_dir: str, log: Optional[LogBuffer] = None,
                 now: Optional[callable] = None):
        self.store_dir = store_dir
        self.log = log
        self._now = now or _utc_stamp
        self._lock = threading.Lock()
        self._rounds: list[dict] = []
        self._load()

    @property
    def _path(self) -> str:
        return os.path.join(self.store_dir, "caught.json")

    def _load(self) -> None:
        try:
            with open(self._path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            rounds = data.get("rounds", [])
            if isinstance(rounds, list):
                self._rounds = [r for r in rounds if isinstance(r, dict) and r.get("id")]
        except (OSError, ValueError):
            pass

    def _save_locked(self) -> None:
        os.makedirs(self.store_dir, exist_ok=True)
        tmp = self._path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"rounds": self._rounds}, fh, indent=2)
        os.replace(tmp, self._path)

    def add_round(self, station_aet: str, source: dict, probes: list) -> dict:
        """File one probe round — several questions asked of one provider as one
        modality — and return it.

        `probes` are :class:`pacs.scu.WorklistProbe` results in the order they
        were asked."""
        rows = []
        for pr in probes:
            items = list(getattr(pr, "items", []) or [])
            rows.append({
                "label": getattr(pr, "label", ""),
                "ok": bool(getattr(pr, "ok", False)),
                "message": getattr(pr, "message", ""),
                "station_key": getattr(pr, "station_key", ""),
                "date_key": getattr(pr, "date_key", ""),
                "count": len(items),
                # Split by who each item is actually addressed to. This is the
                # line that turns "3 came back" into an answer: an item with no
                # ScheduledStationAETitle reaches EVERY modality, so a station
                # can appear to be working while only ever seeing the
                # unaddressed spillover.
                "for_this_station": sum(1 for it in items
                                        if _same_ae(it.get("station_aet"), station_aet)),
                "for_nobody": sum(1 for it in items if not str(it.get("station_aet") or "").strip()),
                "for_someone_else": sum(1 for it in items
                                        if str(it.get("station_aet") or "").strip()
                                        and not _same_ae(it.get("station_aet"), station_aet)),
                "items": items,
            })
        rnd = {
            "id": uuid.uuid4().hex[:12],
            "at": self._now(),
            "station_aet": station_aet,
            "source": {"host": source.get("host", ""), "port": source.get("port", 0),
                       "aet": source.get("aet", "")},
            "probes": rows,
        }
        with self._lock:
            self._rounds.insert(0, rnd)          # newest first; the panel reads top-down
            del self._rounds[MAX_ROUNDS:]
            self._save_locked()
        if self.log:
            # Accessions, never names. The items themselves carry patient
            # identifiers and live behind config.read; the operational log is
            # read by more people than that and is copied into support threads.
            accs = [it.get("accession", "") for row in rows for it in row["items"]]
            accs = [a for a in accs if a][:8]
            total = sum(row["count"] for row in rows)
            self.log.info(
                f"Worklist probe as {station_aet}: {len(rows)} question(s), {total} item(s)"
                + (f" [acc {', '.join(accs)}]" if accs else ""),
                kind="mwl",
            )
        return rnd

    def rounds(self, limit: int = 0) -> list[dict]:
        with self._lock:
            out = [dict(r) for r in self._rounds]
        return out[:limit] if limit else out

    def latest(self) -> Optional[dict]:
        with self._lock:
            return dict(self._rounds[0]) if self._rounds else None

    def clear(self) -> int:
        with self._lock:
            n = len(self._rounds)
            self._rounds = []
            self._save_locked()
        return n

    def counts(self) -> dict:
        with self._lock:
            rounds = list(self._rounds)
        return {
            "rounds": len(rounds),
            "items": sum(p.get("count", 0) for r in rounds for p in r.get("probes", [])),
        }


def _same_ae(a, b) -> bool:
    """DICOM compares AE titles case-insensitively."""
    return str(a or "").strip().upper() == str(b or "").strip().upper() and bool(str(a or "").strip())


def _utc_stamp() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
