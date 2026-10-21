"""What each modality asks the worklist for — every attribute in its C-FIND
query, and what this appliance sent back for it.

A modality's worklist query is a list of attributes: the ones it filled in are
filters (match keys), the empty ones are what it wants filled (return keys).
``mwl.build_worklist_item`` answers with one fixed set whatever was asked, so an
attribute a console wants and we never send — Patient Weight, Medical Alerts,
Admission ID — goes missing without a trace, and "the worklist is missing a
field" cannot be diagnosed. This store is the trace: per calling AE title, each
attribute it has asked for (sequences as paths, ``(0040,0100) > (0008,0060)``),
how often as a filter and how often as a fill-in, and how the last answer
carried it — ``filled``, sent ``empty``, or ``not_sent``.

Values are NEVER stored. A filter's value is a patient name, an ID, an
accession; only the fact that the attribute was asked for, and whether the
query or the answer carried a value, is kept. The file holds AE titles and
addresses — the site's network map, not its patients — and is still written
0600 like its neighbours.

Written to ``<store_dir>/mwl_asks.json``. Every console re-queries every few
seconds, so the file is rewritten at once only when something a reader would
see changed (a new station, a new attribute, a different answer) and otherwise
at most once a minute; the counts in between are kept in memory. Bounded by
MAX_STATIONS and MAX_TAGS so a misbehaving or hostile SCU cannot grow it.
"""
from __future__ import annotations

import json
import os
import threading
import time
from typing import Callable, Iterable, Optional

from .logbuf import LogBuffer

MAX_STATIONS = 64          # calling AE titles kept; the longest-silent one goes first
MAX_TAGS = 512             # attribute paths per station; a real query has 20–60
SAVE_EVERY_SEC = 60.0      # counts-only changes wait this long for the disk

FILLED, EMPTY, NOT_SENT, SENT = "filled", "empty", "not_sent", "sent"
# SENT: no order has answered this station yet, so all that is known is that the
# attribute is part of what an item carries (from a template item).


def _hex(tag) -> str:
    return f"{int(tag):08X}"


def _has_value(elem) -> bool:
    if elem.VR == "SQ":
        return any(_has_value(e) for item in (elem.value or []) for e in item)
    v = elem.value
    if v is None:
        return False
    if isinstance(v, (str, bytes)):
        return bool(v.strip() if isinstance(v, str) else v)
    try:
        return len(v) > 0
    except TypeError:
        return True


def query_paths(ds, prefix: tuple = ()) -> dict:
    """Every attribute path in a query identifier → whether the query gave it a
    value. A sequence counts as one path itself and contributes the union of
    its items' paths. Group-length elements (gggg,0000) are left out."""
    out: dict = {}
    if ds is None:
        return out
    for elem in ds:
        if elem.tag.element == 0x0000:
            continue
        path = prefix + (_hex(elem.tag),)
        key = ">".join(path)
        out[key] = out.get(key, False) or _has_value(elem)
        if elem.VR == "SQ":
            for item in elem.value or []:
                for k, v in query_paths(item, path).items():
                    out[k] = out.get(k, False) or v
    return out


def _answer_status(answers: list, key: str) -> Optional[str]:
    """How the items sent carried one path: FILLED if any item had a value,
    EMPTY if items had it but none with a value, NOT_SENT if none had it."""
    parts = key.split(">")
    seen = False

    def walk(ds, i):
        nonlocal seen
        tag = int(parts[i], 16)
        if tag not in ds:
            return False
        elem = ds[tag]
        if i == len(parts) - 1:
            seen = True
            return _has_value(elem)
        if elem.VR != "SQ":
            return False
        return any(walk(item, i + 1) for item in (elem.value or []))

    if any(walk(a, 0) for a in answers if a is not None):
        return FILLED
    return EMPTY if seen else NOT_SENT


def describe_path(key: str) -> dict:
    """Display form of a stored path: tag numbers and keywords, both joined
    with ' > '. Private and unknown tags have no keyword."""
    from pydicom.datadict import keyword_for_tag
    tags, names = [], []
    for p in key.split(">"):
        t = int(p, 16)
        tags.append(f"({t >> 16:04X},{t & 0xFFFF:04X})")
        names.append(keyword_for_tag(t) or ("Private" if (t >> 16) % 2 else "?"))
    return {"tag": " > ".join(tags), "name": " > ".join(names)}


class MwlAskStore:
    """Thread-safe, JSON-backed record of worklist queries, one entry per
    calling AE title. Loaded once at construction; a missing or unreadable file
    starts empty rather than stopping the appliance — it is a diagnostic."""

    def __init__(self, store_dir: str, log: Optional[LogBuffer] = None,
                 now: Optional[Callable[[], str]] = None,
                 clock: Optional[Callable[[], float]] = None):
        self.store_dir = store_dir
        self.log = log
        self._now = now or _utc_stamp
        self._clock = clock or time.monotonic
        self._lock = threading.Lock()
        self._stations: dict = {}
        self._dirty = False
        self._saved_at = self._clock()
        self._warned = False
        self._load()

    @property
    def _path(self) -> str:
        return os.path.join(self.store_dir, "mwl_asks.json")

    def _load(self) -> None:
        try:
            with open(self._path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            return
        except (OSError, ValueError) as exc:
            self._warn(f"Worklist query record {self._path} could not be read ({exc}) — starting empty")
            return
        stations = data.get("stations", {}) if isinstance(data, dict) else {}
        if isinstance(stations, dict):
            self._stations = {k: v for k, v in stations.items()
                              if isinstance(v, dict) and isinstance(v.get("tags"), dict)}

    def _warn(self, text: str) -> None:
        if self.log is not None:
            try:
                self.log.warn(text, kind="mwl")
            except Exception:
                pass

    def _save_locked(self) -> None:
        os.makedirs(self.store_dir, exist_ok=True)
        from .atomicio import atomic_write_text
        atomic_write_text(self._path, json.dumps({"stations": self._stations}, indent=1), mode=0o600)
        self._dirty = False
        self._saved_at = self._clock()

    def record(self, calling_aet: str, address: str, query, answers: Iterable,
               template=None) -> None:
        """File one C-FIND: the query's attribute paths and how *answers* (the
        items sent, possibly none) carried each. *template* is an item built
        from a blank order, used only for a path no real answer has covered."""
        paths = query_paths(query)
        answers = [a for a in (answers or []) if a is not None]
        aet = str(calling_aet or "").strip().upper() or "?"
        stamp = self._now()
        with self._lock:
            st = self._stations.get(aet)
            changed = st is None
            if st is None:
                if len(self._stations) >= MAX_STATIONS:
                    oldest = min(self._stations, key=lambda k: self._stations[k].get("last", ""))
                    del self._stations[oldest]
                st = self._stations[aet] = {"aet": aet, "first": stamp, "queries": 0,
                                            "tags": {}, "dropped": 0}
            st["queries"] = int(st.get("queries", 0)) + 1
            st["last"] = stamp
            if address and address != "?" and st.get("address") != address:
                st["address"] = address
                changed = True
            last = sorted(paths)
            if st.get("last_query") != last:
                st["last_query"] = last
                changed = True
            tags = st["tags"]
            for key, has_value in paths.items():
                t = tags.get(key)
                if t is None:
                    if len(tags) >= MAX_TAGS:
                        st["dropped"] = int(st.get("dropped", 0)) + 1
                        continue
                    t = tags[key] = {"filter": 0, "fill": 0}
                    changed = True
                t["filter" if has_value else "fill"] += 1
                t["last"] = stamp
                if answers:
                    status = _answer_status(answers, key)
                elif t.get("status") in (FILLED, EMPTY, NOT_SENT):
                    status = t["status"]          # nothing matched this time: keep what we learnt
                elif template is not None:
                    status = SENT if _answer_status([template], key) != NOT_SENT else NOT_SENT
                else:
                    status = t.get("status")
                if status and t.get("status") != status:
                    t["status"] = status
                    changed = True
            self._dirty = True
            if changed or self._clock() - self._saved_at >= SAVE_EVERY_SEC:
                try:
                    self._save_locked()
                except OSError as exc:
                    if not self._warned:
                        self._warned = True
                        self._warn(f"Worklist query record could not be written ({exc}); "
                                   f"it is kept in memory until the next save works")

    def flush(self) -> None:
        with self._lock:
            if self._dirty:
                try:
                    self._save_locked()
                except OSError:
                    pass

    def stations(self) -> list[dict]:
        """Every station, most recently heard first, with its attributes in
        display form: missing ones first, then sent empty, then the rest."""
        order = {NOT_SENT: 0, EMPTY: 1, SENT: 2, FILLED: 3}
        with self._lock:
            snap = json.loads(json.dumps(self._stations))
        out = []
        for st in sorted(snap.values(), key=lambda s: s.get("last", ""), reverse=True):
            in_last = set(st.get("last_query") or [])
            rows = []
            for key, t in st.get("tags", {}).items():
                rows.append({"path": key, **describe_path(key),
                             "filter": t.get("filter", 0), "fill": t.get("fill", 0),
                             "status": t.get("status") or "", "last": t.get("last", ""),
                             "in_last": key in in_last})
            rows.sort(key=lambda r: (order.get(r["status"], 4), r["path"]))
            counts = {s: sum(1 for r in rows if r["status"] == s) for s in (FILLED, EMPTY, NOT_SENT, SENT)}
            out.append({"aet": st.get("aet"), "address": st.get("address", ""),
                        "first": st.get("first", ""), "last": st.get("last", ""),
                        "queries": st.get("queries", 0), "dropped": st.get("dropped", 0),
                        "counts": counts, "tags": rows})
        return out

    def clear(self) -> int:
        with self._lock:
            n = len(self._stations)
            self._stations = {}
            try:
                self._save_locked()
            except OSError:
                pass
            return n


def _utc_stamp() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
