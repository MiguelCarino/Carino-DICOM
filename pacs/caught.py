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
# "Addressed to nobody" has two spellings on the wire and this module is where
# they are read as ONE. A worklist item may not carry a zero-length
# ScheduledStationAETitle — it is Type 1, and a modality that validates it drops
# the whole item — so this appliance's own worklist writes
# mwl.UNASSIGNED_STATION_AET into the attribute instead of writing nothing,
# while a third-party provider that still answers with a blank means exactly the
# same thing. The word is imported rather than repeated here on purpose: a
# second copy of it in a second file is precisely how the row tallies and the
# verdict came to disagree about the same item. It is a constant, not a worklist
# path — nothing in this module hands an order to anything.
from .mwl import UNASSIGNED_STATION_AET

# Probes are cheap to run and a bored operator will run a lot of them. Old
# rounds are dropped rather than kept for ever: the useful window is "what did
# it say just now", and a year of them is a file nobody reads holding
# identifiers nobody needs.
MAX_ROUNDS = 40


class CaughtStore:
    """Thread-safe, JSON-file-backed list of probe rounds, newest first.

    The whole file is rewritten on every change. That is affordable only because
    MAX_ROUNDS bounds it, and in exchange there is no append path to get wrong
    and no partial round on disk. Loaded once, at construction, which happens
    while PacsServer is starting up: a file that is missing or will not parse
    has to end in an empty history rather than an engine that will not boot.
    """

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
        """Read the rounds file, or start empty when it cannot be read.

        A missing or truncated file is not worth a traceback here: refusing to
        start the appliance because a diagnostic file is malformed would trade a
        working PACS for a probe history nobody would miss. Only OSError and a
        JSON parse failure are absorbed, so a file that parses into something
        other than this store's object still reaches the caller.
        Entries with no id are dropped as not something this store wrote.
        """
        try:
            with open(self._path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            rounds = data.get("rounds", [])
            if isinstance(rounds, list):
                self._rounds = [r for r in rounds if isinstance(r, dict) and r.get("id")]
                for rnd in self._rounds:
                    _resplit(rnd)
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
        were asked. Order is the whole diagnosis — server._probe_verdict() reads
        them narrowest-question first and names the key that is wrong — so they
        are stored as a list and never sorted or keyed by label.

        The items are filed verbatim, patient identifiers and all: they are the
        other hospital's patients, which is why this panel sits behind
        config.read and why MAX_ROUNDS throws old rounds away."""
        rows = []
        for pr in probes:
            items = list(getattr(pr, "items", []) or [])
            rows.append({
                "label": getattr(pr, "label", ""),
                "ok": bool(getattr(pr, "ok", False)),
                "message": getattr(pr, "message", ""),
                "station_key": getattr(pr, "station_key", ""),
                "date_key": getattr(pr, "date_key", ""),
                "calling_key": getattr(pr, "calling_key", ""),
                "modality_key": getattr(pr, "modality_key", ""),
                "count": len(items),
                # Split by who each item is actually addressed to. This is the
                # line that turns "3 came back" into an answer: an item with no
                # ScheduledStationAETitle reaches EVERY modality, so a station
                # can appear to be working while only ever seeing the
                # unaddressed spillover. Through split_by_addressee() rather
                # than counted here, so the row and the sentence
                # server._probe_verdict() writes over it read the item the same
                # way.
                **split_by_addressee(items, station_aet),
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


def addressed_to_nobody(station_aet) -> bool:
    """True when a worklist item is scheduled to no particular station.

    THE predicate — every consumer of a probe round asks this one rather than
    spelling the answer out for itself: the per-row split below, and
    server._probe_verdict(), which builds its sentence out of that split. An
    item like this reaches EVERY modality, so calling it another station's is
    the false "your order went to a different scanner" (it sends somebody to
    edit a station field the order has not got), and calling it this station's
    is the false "working" the whole panel exists to prevent.

    Two spellings, one meaning: a blank, which is what a third-party provider
    answers with, and mwl.UNASSIGNED_STATION_AET, which is what this
    appliance's own worklist has to answer with because the attribute is Type 1.
    """
    s = str(station_aet or "").strip()
    return not s or s.upper() == UNASSIGNED_STATION_AET.upper()


def split_by_addressee(items, station_aet: str) -> dict:
    """One probe answer split three ways: for this station, for nobody, for
    somebody else.

    The three are exclusive and exhaustive by construction — they sum to
    ``len(items)`` — because the verdict reads them against the row's ``count``
    and an item counted twice, or not at all, is a sentence about orders that do
    not exist. Nobody is tested FIRST: ``UNASSIGNED`` is not a station, so it can
    neither match the one being asked as nor be filed under someone else's.
    """
    this = nobody = other = 0
    for it in items:
        aet = it.get("station_aet") if isinstance(it, dict) else ""
        if addressed_to_nobody(aet):
            nobody += 1
        elif _same_ae(aet, station_aet):
            this += 1
        else:
            other += 1
    return {"for_this_station": this, "for_nobody": nobody, "for_someone_else": other}


def _resplit(rnd: dict) -> None:
    """Re-read one stored round's tallies under the CURRENT predicate.

    A round filed before "nobody" gained its second spelling carries counts
    split under the blank-only rule, and the panel draws those counts straight
    out of the file. The items themselves are filed verbatim, so the answer can
    simply be read again — and it has to be, because server._probe_verdict()
    recounts from those same items: a panel row contradicting the sentence
    printed above it would be this diagnosis disagreeing with itself, which is
    the fault the split exists to find. Rows that came back empty have nothing
    to recount and keep what they were stored with.
    """
    station = str(rnd.get("station_aet", "") or "")
    for row in (rnd.get("probes") or []):
        if not isinstance(row, dict):
            continue
        items = row.get("items")
        if isinstance(items, list) and items:
            row.update(split_by_addressee(items, station))


def _same_ae(a, b) -> bool:
    """DICOM compares AE titles case-insensitively.

    An empty AE title matches nothing here, not even another empty one — an item
    with no ScheduledStationAETitle is addressed to nobody, and letting it count
    as this station's would produce exactly the false "working" this panel exists
    to prevent. Callers ask addressed_to_nobody() first, so by the time this runs
    both spellings of "nobody" are already out of the way; the guard stays
    because a bare equality test on two empty strings is one edit away from
    being true again.
    """
    return str(a or "").strip().upper() == str(b or "").strip().upper() and bool(str(a or "").strip())


def _utc_stamp() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
