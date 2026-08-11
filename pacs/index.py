"""SQLite instance index — the query layer behind DICOMweb (QIDO-RS) and the
Query/Retrieve SCP.

``history.scan_studies`` answers "what is on disk?" by walking the whole tree
and opening a header per directory. That is acceptable for a dashboard poll and
hopeless for a query protocol that asks the same question hundreds of times a
minute. This module keeps one row per stored FILE and derives patient / study /
series answers by aggregating that one table, so a study summary can never
drift out of step with the instances it summarises.

The index is a cache, never the source of truth. Every row points at a file
that is still on disk; losing the database costs a rescan, never an image.
"""

from __future__ import annotations

import os
import queue
import sqlite3
import threading
import time
from typing import Any, Callable, Optional

from .dicomfs import is_dicom
from .history import _fmt_name

# Bumping this rebuilds the table from scratch on next open (and the caller is
# told to rescan). The index holds nothing that isn't re-derivable from the
# files themselves, so a migration would be more code than a rebuild.
SCHEMA_VERSION = 1

_BATCH = 500            # rows per write transaction during a rescan
_QUEUE_MAX = 20000      # background-writer backlog before we fall back to sync writes

_SCHEMA = """
CREATE TABLE IF NOT EXISTS instances (
    id                  INTEGER PRIMARY KEY,
    path                TEXT    NOT NULL UNIQUE,
    grp                 TEXT    NOT NULL,
    sop_uid             TEXT    NOT NULL,
    series_uid          TEXT    NOT NULL DEFAULT '',
    study_uid           TEXT    NOT NULL DEFAULT '',
    patient_id          TEXT    NOT NULL DEFAULT '',
    patient_name        TEXT    NOT NULL DEFAULT '',
    study_date          TEXT    NOT NULL DEFAULT '',
    study_time          TEXT    NOT NULL DEFAULT '',
    accession           TEXT    NOT NULL DEFAULT '',
    modality            TEXT    NOT NULL DEFAULT '',
    study_desc          TEXT    NOT NULL DEFAULT '',
    series_desc         TEXT    NOT NULL DEFAULT '',
    series_number       INTEGER,
    instance_number     INTEGER,
    sop_class_uid       TEXT    NOT NULL DEFAULT '',
    transfer_syntax_uid TEXT    NOT NULL DEFAULT '',
    size                INTEGER NOT NULL DEFAULT 0,
    mtime               REAL    NOT NULL DEFAULT 0,
    indexed_at          REAL    NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_inst_sop      ON instances(sop_uid);
CREATE INDEX IF NOT EXISTS ix_inst_study    ON instances(study_uid);
CREATE INDEX IF NOT EXISTS ix_inst_series   ON instances(series_uid, instance_number);
CREATE INDEX IF NOT EXISTS ix_inst_patient  ON instances(patient_id);
CREATE INDEX IF NOT EXISTS ix_inst_name     ON instances(patient_name);
CREATE INDEX IF NOT EXISTS ix_inst_date     ON instances(study_date);
CREATE INDEX IF NOT EXISTS ix_inst_acc      ON instances(accession);
CREATE INDEX IF NOT EXISTS ix_inst_grp      ON instances(grp, mtime);
CREATE INDEX IF NOT EXISTS ix_inst_modality ON instances(modality);
"""

# The schema is applied statement by statement, never through executescript:
# sqlite3.Connection.executescript COMMITs whatever transaction is open before
# it runs, which would tear apart the very transaction _ensure_schema needs to
# hold. Splitting on ';' is safe here because the schema contains no string
# literals — the day it does, this stops being a split and becomes a parser.
_SCHEMA_STATEMENTS = tuple(s.strip() for s in _SCHEMA.split(";") if s.strip())

_INSERT = """
INSERT INTO instances
    (path, grp, sop_uid, series_uid, study_uid, patient_id, patient_name,
     study_date, study_time, accession, modality, study_desc, series_desc,
     series_number, instance_number, sop_class_uid, transfer_syntax_uid,
     size, mtime, indexed_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(path) DO UPDATE SET
    grp=excluded.grp, sop_uid=excluded.sop_uid, series_uid=excluded.series_uid,
    study_uid=excluded.study_uid, patient_id=excluded.patient_id,
    patient_name=excluded.patient_name, study_date=excluded.study_date,
    study_time=excluded.study_time, accession=excluded.accession,
    modality=excluded.modality, study_desc=excluded.study_desc,
    series_desc=excluded.series_desc, series_number=excluded.series_number,
    instance_number=excluded.instance_number, sop_class_uid=excluded.sop_class_uid,
    transfer_syntax_uid=excluded.transfer_syntax_uid, size=excluded.size,
    mtime=excluded.mtime, indexed_at=excluded.indexed_at
"""

_ROW_FIELDS = (
    "path", "grp", "sop_uid", "series_uid", "study_uid", "patient_id",
    "patient_name", "study_date", "study_time", "accession", "modality",
    "study_desc", "series_desc", "series_number", "instance_number",
    "sop_class_uid", "transfer_syntax_uid", "size", "mtime", "indexed_at",
)

# DICOM keyword -> (column, match kind, level). The level decides WHERE a
# filter may be applied without corrupting an aggregate: filtering a study
# query on Modality must not shrink that study's instance count, so anything
# below study level becomes an IN-subquery instead of a WHERE clause.
_FIELDS: dict[str, tuple[str, str, str]] = {
    "StudyInstanceUID":    ("study_uid", "uid", "study"),
    "PatientID":           ("patient_id", "text", "study"),
    "PatientName":         ("patient_name", "text", "study"),
    "StudyDate":           ("study_date", "date", "study"),
    "StudyTime":           ("study_time", "time", "study"),
    "AccessionNumber":     ("accession", "text", "study"),
    "StudyDescription":    ("study_desc", "text", "study"),
    "SeriesInstanceUID":   ("series_uid", "uid", "series"),
    "Modality":            ("modality", "cs", "series"),
    "ModalitiesInStudy":   ("modality", "cs", "series"),
    "SeriesNumber":        ("series_number", "num", "series"),
    "SeriesDescription":   ("series_desc", "text", "series"),
    "SOPInstanceUID":      ("sop_uid", "uid", "instance"),
    "SOPClassUID":         ("sop_class_uid", "uid", "instance"),
    "SOPClassesInStudy":   ("sop_class_uid", "uid", "instance"),
    "InstanceNumber":      ("instance_number", "num", "instance"),
    "TransferSyntaxUID":   ("transfer_syntax_uid", "uid", "instance"),
    "group":               ("grp", "cs", "file"),
}

# Callers reach for keywords, column names and lowercase spellings in about
# equal measure; accepting all three costs one dict and removes a whole class
# of "my filter silently did nothing" bugs.
_ALIASES: dict[str, str] = {}
for _kw, (_col, _k, _l) in _FIELDS.items():
    _ALIASES[_kw] = _kw
    _ALIASES[_kw.lower()] = _kw
    _ALIASES.setdefault(_col, _kw)
del _kw, _col, _k, _l
_ALIASES["Group"] = "group"
_ALIASES["patient"] = "PatientName"
_ALIASES["study_description"] = "StudyDescription"
_ALIASES["series_description"] = "SeriesDescription"

# DA/TM attribute pairs that PS3.4 C.2.2.2.5 lets an SCP read as ONE DateTime
# range when both carry a range, instead of as two independent windows. That
# reading is the negotiable Combined Date and Time Matching option, NOT the
# default — see _build's combined_datetime, which is what turns it on.
_DT_PAIRS = (("StudyDate", "StudyTime"), ("SeriesDate", "SeriesTime"))

_ORDER_KEYS = {
    "StudyDate": "study_date", "StudyTime": "study_time",
    "PatientName": "patient_name", "PatientID": "patient_id",
    "AccessionNumber": "accession", "StudyDescription": "study_desc",
    "mtime": "mtime", "Modality": "modality",
}


class _NullLog:
    def info(self, *a, **k): pass
    def warn(self, *a, **k): pass
    def error(self, *a, **k): pass


# ---------------------------------------------------------------- value coercion
def _s(v: Any) -> str:
    return str(v).strip() if v is not None else ""


def _norm_date(v: Any) -> str:
    """DA -> bare YYYYMMDD. Old ACR-NEMA files write '2024.01.31'; leaving the
    punctuation in would break every range comparison against a modern file."""
    d = "".join(ch for ch in _s(v) if ch.isdigit())
    return d[:8]


def _norm_time(v: Any) -> str:
    """TM -> digits only, fraction dropped. Stored short (some devices send
    'HHMM'); comparisons pad it back out, see _time_expr."""
    t = _s(v).split(".")[0]
    return "".join(ch for ch in t if ch.isdigit())[:6]


def _norm_num(v: Any) -> Optional[int]:
    """IS -> int, or None when the file has junk there. Stored as a number so
    '003' and '3' are the same series and sorting is numeric, not lexical."""
    s = _s(v)
    if not s:
        return None
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return None


def _time_expr(col: str) -> str:
    """Right-pad a TM column to HHMMSS so comparisons work across mixed lengths
    (plenty of devices send bare 'HHMM')."""
    return f"substr({col} || '000000', 1, 6)"


def _cmp_time(v: Any) -> str:
    """A TM query value padded the same way _time_expr pads the column — both
    sides must be 6 digits or '1015' never equals a stored '101500'.

    An absent value stays absent: padding '' into '000000' would turn the open
    end of 'HHMMSS-' into a real upper bound of midnight, and the range would
    then match nothing at all instead of everything after HHMMSS."""
    t = _norm_time(v)
    return (t + "000000")[:6] if t else ""


def _like_pattern(value: str) -> str:
    """DICOM wildcards (* and ?) -> SQL LIKE. The % and _ that were literal in
    the DICOM value are escaped first, so a description containing '100%' does
    not turn into a match-anything pattern."""
    return (value.replace("%", r"\%").replace("_", r"\_")
                 .replace("*", "%").replace("?", "_"))


def _prefix_term(col: str, prefix: str) -> tuple[str, list]:
    """SQL for "path starts with this directory". Deliberately NOT LIKE: a
    Windows path is full of backslashes, which is LIKE's escape character here,
    and a filename may legitimately contain % or _."""
    return f"substr({col}, 1, ?) = ?", [len(prefix), prefix]


def _parse_range(value: str) -> Optional[tuple[str, str]]:
    """'YYYYMMDD-YYYYMMDD' (either side optional) -> (lo, hi); None if the value
    is not a range. Only the FIRST dash separates, so a malformed extra dash
    lands in the upper bound rather than silently changing the query shape."""
    if "-" not in value:
        return None
    lo, _, hi = value.partition("-")
    return lo.strip(), hi.strip()


def _single_range(raw: Any) -> Optional[tuple[str, str]]:
    """(lo, hi) when *raw* is ONE value that is a range, else None.

    Range matching is defined for a single value only (PS3.4 C.2.2.2.5), so a
    backslash list stays on the ordinary per-value path rather than being
    silently reinterpreted as a range."""
    if isinstance(raw, (list, tuple, set)):
        vals = [_s(v) for v in raw if _s(v)]
        if len(vals) != 1:
            return None
        v = vals[0]
    else:
        v = _s(raw)
    if not v or "\\" in v:
        return None
    return _parse_range(v)


def _datetime_term(da_col: str, tm_col: str, da_raw: Any,
                   tm_raw: Any) -> Optional[tuple[str, list]]:
    """One combined DA+TM range -> (sql, params), or None when the pair is not
    two ranges and the callers should fall back to matching them separately.

    The comparison is on the concatenation of the two columns, which only lines
    up when the stored date really is 8 digits — hence the length guard rather
    than the usual ``!= ''``. A stored time that is missing or short pads to the
    start of its day through _time_expr, so an instance with a date but no time
    still lands on the timeline instead of dropping out of the window."""
    d = _single_range(da_raw)
    t = _single_range(tm_raw)
    if d is None or t is None:
        return None
    d_lo, d_hi = _norm_date(d[0]), _norm_date(d[1])
    t_lo, t_hi = _cmp_time(t[0]), _cmp_time(t[1])
    # An open end of the DATE is what makes the combined bound open; an open end
    # of the time alone just means "the whole of that day".
    lo = (d_lo + (t_lo or "000000")) if d_lo else ""
    hi = (d_hi + (t_hi or "235959")) if d_hi else ""
    expr = f"({da_col} || {_time_expr(tm_col)})"
    guard = f"length({da_col}) = 8"
    if lo and hi:
        return f"({expr} BETWEEN ? AND ? AND {guard})", [lo, hi]
    if lo:
        return f"({expr} >= ? AND {guard})", [lo]
    if hi:
        return f"({expr} <= ? AND {guard})", [hi]
    return None


class _Where:
    """Accumulates SQL fragments + params for one query."""

    def __init__(self):
        self.sql: list[str] = []
        self.params: list[Any] = []

    def add(self, frag: str, params: list) -> None:
        self.sql.append(frag)
        self.params.extend(params)

    def clause(self, extra: str = "") -> str:
        parts = list(self.sql)
        if extra:
            parts.append(extra)
        return (" WHERE " + " AND ".join(parts)) if parts else ""


def _term(col: str, kind: str, raw: Any) -> Optional[tuple[str, list]]:
    """One filter -> (sql, params), or None when it matches everything.

    An empty value is DICOM's "universal match" and must NOT become
    ``col = ''`` — that would return the instances with a *missing* value
    instead of all of them."""
    if raw is None:
        return None
    if isinstance(raw, (list, tuple, set)):
        values = [_s(v) for v in raw]
    else:
        # A backslash is DICOM's multi-value separator (used constantly in
        # C-FIND UID lists); splitting here is what makes a list query work.
        values = _s(raw).split("\\")
    values = [v for v in values if v != ""]
    if not values:
        return None

    frags: list[str] = []
    params: list[Any] = []
    for v in values:
        if kind in ("date", "time"):
            norm = _norm_date if kind == "date" else _cmp_time
            expr = col if kind == "date" else _time_expr(col)
            rng = _parse_range(v)
            if rng is not None:
                lo, hi = norm(rng[0]), norm(rng[1])
                if lo and hi:
                    frags.append(f"({expr} BETWEEN ? AND ? AND {col} != '')")
                    params += [lo, hi]
                elif lo:
                    frags.append(f"({expr} >= ? AND {col} != '')")
                    params.append(lo)
                elif hi:
                    frags.append(f"({expr} <= ? AND {col} != '')")
                    params.append(hi)
                continue
            if "*" in v or "?" in v:
                frags.append(f"{col} LIKE ? ESCAPE '\\'")
                params.append(_like_pattern(v))
            else:
                frags.append(f"{expr} = ?")
                params.append(norm(v))
        elif kind == "num":
            if "*" in v or "?" in v:
                frags.append(f"CAST({col} AS TEXT) LIKE ? ESCAPE '\\'")
                params.append(_like_pattern(v))
            else:
                n = _norm_num(v)
                if n is None:
                    frags.append("0")           # unparseable number matches nothing
                else:
                    frags.append(f"{col} = ?")
                    params.append(n)
        elif kind == "uid":
            # UIDs are case-sensitive by definition; everything else in DICOM
            # matching is not, and every real-world sender assumes it is not.
            if "*" in v or "?" in v:
                frags.append(f"{col} GLOB ?")
                params.append(v.replace("[", "[[]"))
            else:
                frags.append(f"{col} = ?")
                params.append(v)
        else:  # text / cs
            if "*" in v or "?" in v:
                frags.append(f"{col} LIKE ? ESCAPE '\\'")
                params.append(_like_pattern(v))
            else:
                frags.append(f"{col} = ? COLLATE NOCASE")
                params.append(v)
    if not frags:
        return None
    return ("(" + " OR ".join(frags) + ")", params)


def _build(where: _Where, filters: Optional[dict], levels: set, subquery_key: str = "",
           combined_datetime: bool = False) -> None:
    """Apply *filters* to *where*. Anything whose level is not in *levels* is
    pushed into an IN-subquery on *subquery_key* so it selects rows without
    truncating the aggregate the caller is about to compute.

    *combined_datetime* picks between the two readings PS3.4 C.2.2.2.5 gives a
    DA range paired with the TM range of the same entity. It defaults OFF,
    which is the standard's default: the two are matched independently and
    INTERSECT. The standard's own worked example is
    StudyDate=20060705-20060707 with StudyTime=100000-180000, and the required
    answer is 10:00-18:00 on each of the three days — not the single span from
    the 5th at 10:00 to the 7th at 18:00. That span is Combined Date and Time
    Matching, which an SCU has to ask for via Extended Negotiation
    (PS3.4 C.4.1.1.3.1); applying it unasked silently WIDENS every date+time
    query past what the SCU wrote, which is the one direction a query must
    never drift on its own."""
    items: list[tuple[str, Any]] = []
    for key, raw in (filters or {}).items():
        kw = _ALIASES.get(key) or _ALIASES.get(str(key).lower())
        if kw:
            items.append((kw, raw))

    def emit(level: str, frag: str, params: list) -> None:
        if level in levels or not subquery_key:
            where.add(frag, params)
        else:
            where.add(
                f"{subquery_key} IN (SELECT {subquery_key} FROM instances WHERE {frag})",
                params,
            )

    # Only when the caller has the option: a DA/TM pair that both carry ranges
    # becomes one comparison over the joined date-time, consuming both keys so
    # they are not then matched again on their own.
    used: set[int] = set()
    if combined_datetime:
        for da_kw, tm_kw in _DT_PAIRS:
            da_i = next((i for i, (kw, _) in enumerate(items) if kw == da_kw), None)
            tm_i = next((i for i, (kw, _) in enumerate(items) if kw == tm_kw), None)
            if da_i is None or tm_i is None:
                continue
            da_col, _kind, level = _FIELDS[da_kw]
            tm_col = _FIELDS[tm_kw][0]
            term = _datetime_term(da_col, tm_col, items[da_i][1], items[tm_i][1])
            if term is None:
                continue
            emit(level, term[0], term[1])
            used.update((da_i, tm_i))

    for i, (kw, raw) in enumerate(items):
        if i in used:
            continue
        col, kind, level = _FIELDS[kw]
        term = _term(col, kind, raw)
        if term is None:
            continue
        emit(level, term[0], term[1])


class InstanceIndex:
    """A sqlite index of every stored instance, one row per file on disk.

    Threading: sqlite connections are NOT safe to share across threads while a
    transaction is open, and ``check_same_thread=False`` only silences the
    guard — it does not make sharing correct. So each thread gets its own
    connection (``threading.local``), WAL lets those readers run while a write
    is in flight, and every write additionally takes a process-wide lock so two
    threads can never hold ``BEGIN IMMEDIATE`` at once. The one exception is a
    ``:memory:`` index, where per-thread connections would each get a private
    empty database; that mode keeps a single shared connection and serialises
    reads through the same lock.
    """

    def __init__(self, path: str, log: Any = None, async_writes: bool = False):
        self.memory = (path == ":memory:")
        self.path = path if self.memory else os.path.abspath(os.path.expanduser(path))
        self.log = log or _NullLog()
        self._lock = threading.RLock()
        self._local = threading.local()
        self._shared: Optional[sqlite3.Connection] = None
        self._rebuilt = False
        self._writer: Optional[threading.Thread] = None
        self._stop: Optional[threading.Event] = None
        self._q: Optional[queue.Queue] = None
        self.errors = 0
        self.last_write = 0.0
        if async_writes:
            self.start()

    # ------------------------------------------------------------ connections
    def _open(self) -> sqlite3.Connection:
        if not self.memory:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        # check_same_thread stays ON for a file index — it is the guard that
        # proves the per-thread connections really are per-thread. It is only
        # relaxed for :memory:, where one connection IS the database and every
        # access to it is serialised by self._lock instead.
        conn = sqlite3.connect(self.path, timeout=30.0, isolation_level=None,
                               check_same_thread=not self.memory)
        conn.row_factory = sqlite3.Row
        try:
            if not self.memory:
                conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA busy_timeout=30000")
            conn.execute("PRAGMA temp_store=MEMORY")
        except sqlite3.Error:
            pass                      # a filesystem that refuses WAL still works, just slower
        self._ensure_schema(conn)
        return conn

    def _ensure_schema(self, conn: sqlite3.Connection) -> None:
        """Sample the version and create/rebuild the table, atomically.

        Sampling, creating and stamping used to be separate autocommitted
        statements, so a second thread opening its own connection between the
        CREATE and the stamp saw a table carrying version 0 — an "old layout" —
        and DROPped the table the first thread had just built. Every query
        already in flight then died with "no such table: instances". Cold boot
        is exactly when that happens: the rescan thread, the background writer,
        a QIDO request and the Q/R SCP all first-touch the database at once,
        which is the normal startup sequence.

        One IMMEDIATE transaction closes the window: the whole sample-drop-
        create-stamp is invisible until it commits, and a second thread's BEGIN
        waits behind it (busy_timeout) and then finds a fully stamped table with
        nothing to do. PRAGMA user_version lives in the database header and is
        written transactionally, so it rolls back with the rest."""
        rebuilt = False
        conn.execute("BEGIN IMMEDIATE")
        try:
            ver = conn.execute("PRAGMA user_version").fetchone()[0]
            have = conn.execute(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='instances'"
            ).fetchone()[0]
            if have and ver != SCHEMA_VERSION:
                # No migration path by design: everything here is re-derivable
                # from the files, so an old layout is dropped and the caller is
                # told to rescan rather than carrying compatibility code forever.
                conn.execute("DROP TABLE IF EXISTS instances")
                have = 0
                rebuilt = True
            if not have:
                for stmt in _SCHEMA_STATEMENTS:
                    conn.execute(stmt)
                conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            conn.execute("COMMIT")
        except BaseException:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        # Announced only once the rebuild is durable — a rolled-back attempt
        # must not tell the operator to go and rescan.
        if rebuilt:
            self._rebuilt = True
            self.log.warn("Instance index schema changed — rebuilt empty, a rescan is needed",
                          kind="index")

    def _conn(self) -> sqlite3.Connection:
        if self.memory:
            if self._shared is None:
                self._shared = self._open()
            return self._shared
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            # An open handle keeps working against an unlinked inode, so if the
            # DB file is deleted (or replaced) underneath us every subsequent
            # write would land in a file nobody can read. One stat per call is
            # cheap next to the query it precedes.
            try:
                st = os.stat(self.path)
                if (st.st_dev, st.st_ino) == getattr(self._local, "ident", None):
                    return conn
            except OSError:
                pass
            self._close_local()
        conn = self._open()
        self._local.conn = conn
        try:
            st = os.stat(self.path)
            self._local.ident = (st.st_dev, st.st_ino)
        except OSError:
            self._local.ident = None
        return conn

    def _close_local(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            except sqlite3.Error:
                pass
        self._local.conn = None
        self._local.ident = None

    def _drop_conn(self) -> None:
        if self.memory:
            if self._shared is not None:
                try:
                    self._shared.close()
                except sqlite3.Error:
                    pass
                self._shared = None
        else:
            self._close_local()

    def close(self) -> None:
        """Stop the writer (if any) and drop this thread's connection."""
        self.stop()
        with self._lock:
            self._drop_conn()

    # --------------------------------------------------------------- plumbing
    def _read(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        for attempt in (0, 1):
            try:
                if self.memory:
                    with self._lock:
                        return self._conn().execute(sql, params).fetchall()
                return self._conn().execute(sql, params).fetchall()
            except sqlite3.Error:
                self._drop_conn()
                if attempt:
                    raise
        return []

    def _write(self, fn: Callable[[sqlite3.Connection], Any]) -> Any:
        """Run *fn* inside one immediate transaction, retrying once on a fresh
        connection (that is the deleted-database case, and it must survive)."""
        for attempt in (0, 1):
            try:
                with self._lock:
                    conn = self._conn()
                    conn.execute("BEGIN IMMEDIATE")
                    try:
                        out = fn(conn)
                        conn.execute("COMMIT")
                    except BaseException:
                        try:
                            conn.execute("ROLLBACK")
                        except sqlite3.Error:
                            pass
                        raise
                self.last_write = time.time()
                return out
            except sqlite3.Error as exc:
                self._drop_conn()
                if attempt:
                    self.errors += 1
                    self.log.warn(f"Index write failed: {exc}", kind="index")
                    raise
        return None

    # ----------------------------------------------------------- row building
    @staticmethod
    def _row(ds, path: str, group: str) -> Optional[tuple]:
        """Flatten a header into a row tuple, or None if it is not an instance."""
        sop = _s(getattr(ds, "SOPInstanceUID", ""))
        if not sop:
            return None                      # DICOMDIR and friends: nothing to index
        meta = getattr(ds, "file_meta", None)
        try:
            st = os.stat(path)
            size, mtime = int(st.st_size), float(st.st_mtime)
        except OSError:
            # Indexing with a zero stat is better than not indexing: the next
            # rescan sees the mismatch and refreshes the row.
            size, mtime = 0, 0.0
        return (
            path, group, sop,
            _s(getattr(ds, "SeriesInstanceUID", "")),
            _s(getattr(ds, "StudyInstanceUID", "")),
            _s(getattr(ds, "PatientID", "")),
            _s(getattr(ds, "PatientName", "")),
            _norm_date(getattr(ds, "StudyDate", "")),
            _norm_time(getattr(ds, "StudyTime", "")),
            _s(getattr(ds, "AccessionNumber", "")),
            _s(getattr(ds, "Modality", "")).upper(),
            _s(getattr(ds, "StudyDescription", "")),
            _s(getattr(ds, "SeriesDescription", "")),
            _norm_num(getattr(ds, "SeriesNumber", None)),
            _norm_num(getattr(ds, "InstanceNumber", None)),
            _s(getattr(ds, "SOPClassUID", "")),
            _s(getattr(meta, "TransferSyntaxUID", "")),
            size, mtime, time.time(),
        )

    def _row_from_file(self, path: str, group: str) -> Optional[tuple]:
        if not is_dicom(path):
            return None
        try:
            from pydicom import dcmread
            ds = dcmread(path, stop_before_pixels=True, force=True)
        except Exception:
            return None                      # unparseable is skipped, never fatal
        return self._row(ds, path, group)

    @staticmethod
    def norm_path(path: str) -> str:
        """The index's canonical key: absolute + normalised, but NOT realpath'd,
        so it matches the paths ``Config.resolved()`` hands the rest of the app
        even when the storage folder is reached through a symlink."""
        return os.path.abspath(os.path.normpath(path))

    # -------------------------------------------------------------- mutations
    def add_dataset(self, ds, path: str, group: str) -> bool:
        """Index an already-parsed dataset (the C-STORE path — no re-read)."""
        row = self._row(ds, self.norm_path(path), group)
        if row is None:
            return False
        self._write(lambda c: c.execute(_INSERT, row))
        return True

    def add_file(self, path: str, group: str, ds=None) -> bool:
        """Index one file. Returns False when it is not a parseable instance."""
        p = self.norm_path(path)
        row = self._row(ds, p, group) if ds is not None else self._row_from_file(p, group)
        if row is None:
            return False
        self._write(lambda c: c.execute(_INSERT, row))
        return True

    def remove_file(self, path: str) -> int:
        p = self.norm_path(path)
        cur = self._write(lambda c: c.execute("DELETE FROM instances WHERE path = ?", (p,)))
        return cur.rowcount if cur else 0

    def remove_under(self, path: str) -> int:
        """Drop every row under a directory (a deleted study, an archived tree).
        Matches the directory itself and anything below it."""
        p = self.norm_path(path)
        frag, params = _prefix_term("path", p.rstrip(os.sep) + os.sep)
        cur = self._write(lambda c: c.execute(
            f"DELETE FROM instances WHERE path = ? OR {frag}", (p, *params)))
        return cur.rowcount if cur else 0

    def remove_group(self, group: str) -> int:
        cur = self._write(lambda c: c.execute("DELETE FROM instances WHERE grp = ?", (group,)))
        return cur.rowcount if cur else 0

    def clear(self) -> int:
        cur = self._write(lambda c: c.execute("DELETE FROM instances"))
        return cur.rowcount if cur else 0

    # ------------------------------------------------------ background writer
    def start(self) -> None:
        """Start the background writer so callers on latency-critical threads
        (the C-STORE handler) can hand off a row instead of waiting on sqlite."""
        with self._lock:
            if self._writer is not None and self._writer.is_alive():
                return
            # Fresh Event + Queue per run: a straggler thread from a timed-out
            # join must drain ITS queue and see ITS stop flag, never the new
            # run's, or two writers end up fighting over the same backlog.
            stop = threading.Event()
            q: queue.Queue = queue.Queue(maxsize=_QUEUE_MAX)
            self._stop, self._q = stop, q
            self._writer = threading.Thread(target=self._drain, args=(stop, q),
                                            name="pacs-index", daemon=True)
            self._writer.start()

    def stop(self, timeout: float = 5.0) -> None:
        with self._lock:
            stop, q, t = self._stop, self._q, self._writer
            self._stop = self._q = self._writer = None
        if stop is not None:
            stop.set()
        if t is not None and t.is_alive() and t is not threading.current_thread():
            t.join(timeout=timeout)
        # Whatever the writer did not get to is written here rather than
        # dropped: a lost row is a study that silently stops being findable.
        if q is not None:
            pending = []
            while True:
                try:
                    pending.append(q.get_nowait())
                    q.task_done()
                except queue.Empty:
                    break
            if pending:
                self._flush_batch(pending)

    @property
    def writing(self) -> bool:
        t = self._writer
        return t is not None and t.is_alive()

    def enqueue_dataset(self, ds, path: str, group: str) -> None:
        """Queue an already-parsed dataset. The header is flattened on the
        CALLER's thread (pure Python, microseconds) so the writer never has to
        hold a reference to a whole dataset, and the caller never touches
        sqlite."""
        row = self._row(ds, self.norm_path(path), group)
        if row is not None:
            self._submit(("add", row))

    def enqueue_file(self, path: str, group: str) -> None:
        self._submit(("file", (self.norm_path(path), group)))

    def enqueue_remove(self, path: str) -> None:
        """Queued delete. Removals go through the same queue as adds so a
        delete can never overtake the add it is meant to undo."""
        self._submit(("del", self.norm_path(path)))

    def _submit(self, item: tuple) -> None:
        q = self._q if self.writing else None
        if q is not None:
            try:
                q.put_nowait(item)
                return
            except queue.Full:
                # Backlogged: write it here instead. Slow beats losing the row.
                self.log.warn("Index queue full — writing inline", kind="index")
        self._flush_batch([item])

    def flush(self, timeout: float = 10.0) -> bool:
        """Block until the queued work is written. Returns False on timeout.
        ``Queue.join`` has no timeout, hence the poll."""
        q = self._q
        if q is None:
            return True
        deadline = time.time() + timeout
        while q.unfinished_tasks:
            if time.time() >= deadline:
                return False
            time.sleep(0.005)
        return True

    def _drain(self, stop: threading.Event, q: queue.Queue) -> None:
        while not stop.is_set():
            try:
                first = q.get(timeout=0.25)
            except queue.Empty:
                continue
            batch = [first]
            while len(batch) < _BATCH:
                try:
                    batch.append(q.get_nowait())
                except queue.Empty:
                    break
            try:
                self._flush_batch(batch)
            except Exception as exc:
                # The writer thread must outlive any single bad row: if it dies
                # here, later submissions queue up behind nobody and the studies
                # they describe quietly stop being findable.
                self.errors += 1
                self.log.warn(f"Index writer error: {exc}", kind="index")
            finally:
                for _ in batch:
                    q.task_done()

    def _flush_batch(self, items: list[tuple]) -> None:
        rows: list[tuple] = []
        for kind, payload in items:
            if kind == "add":
                rows.append(payload)
            elif kind == "file":
                row = self._row_from_file(payload[0], payload[1])
                if row is not None:
                    rows.append(row)
            elif kind == "del":
                rows.append(payload)          # a bare str marks a delete below

        def work(conn):
            for r in rows:
                if isinstance(r, str):
                    conn.execute("DELETE FROM instances WHERE path = ?", (r,))
                else:
                    conn.execute(_INSERT, r)

        if not rows:
            return
        try:
            self._write(work)
        except sqlite3.Error:
            pass                              # already counted + logged in _write

    # ------------------------------------------------------------------ rescan
    def rescan(self, roots: dict, purge: bool = True,
               stop: Optional[threading.Event] = None) -> dict:
        """Reconcile the index with what is actually on disk.

        *roots* is ``{group: root_path}``. Incremental: a file whose path, size
        and mtime already match its row is not re-read. When *purge* is on,
        rows in those groups whose file is gone are deleted — but never after a
        cancelled walk, because a partial walk cannot tell "gone" from "not
        reached yet"."""
        started = time.time()
        counts = {"added": 0, "updated": 0, "skipped": 0, "failed": 0, "removed": 0,
                  "files": 0, "errors": 0, "cancelled": False, "seconds": 0.0}
        groups = {g: r for g, r in (roots or {}).items() if r and os.path.isdir(r)}
        if not groups:
            counts["seconds"] = round(time.time() - started, 3)
            return counts

        conn = self._conn()
        # A temp table (per-connection, never touches the main DB) keeps the
        # "seen" set flat in memory no matter how large the archive is.
        with self._lock:
            conn.execute("DROP TABLE IF EXISTS temp.scan_seen")
            conn.execute("CREATE TEMP TABLE scan_seen (path TEXT PRIMARY KEY)")

        pending: list[tuple] = []
        seen: list[tuple] = []
        restarted = False           # the seen set was begun again mid-walk

        def commit():
            nonlocal restarted
            if not pending and not seen:
                return

            def work(c):
                nonlocal restarted
                # This batch may be running on a connection that has never seen
                # scan_seen: _write retries on a fresh one after an error, and
                # _conn() swaps connections when the database file is replaced
                # underneath it. A temp table belongs to its connection, so on
                # either path it is gone — and without this every remaining batch
                # of the rescan would fail on the missing table, turning one
                # transient error into an index that quietly stops filling while
                # "added" (counted during the walk) still reports a clean run.
                if not c.execute("SELECT 1 FROM sqlite_temp_master WHERE type='table' "
                                 "AND name='scan_seen'").fetchone():
                    c.execute("CREATE TEMP TABLE scan_seen (path TEXT PRIMARY KEY)")
                    restarted = True
                for r in pending:
                    c.execute(_INSERT, r)
                c.executemany("INSERT OR IGNORE INTO scan_seen (path) VALUES (?)", seen)
            try:
                self._write(work)
            except sqlite3.Error:
                # Already logged in _write. Losing a batch means those files are
                # missing from the "seen" set too, so the purge below MUST be
                # skipped or it would delete rows for files that are on disk.
                counts["errors"] += 1
            pending.clear()
            seen.clear()

        for group, root in groups.items():
            known = self._known(group, root)
            # Every file is offered to is_dicom, hidden ones included. The walk
            # MUST accept exactly what add_file accepts: anything the walk
            # declines but add_file indexed would be deleted by the purge below
            # while the file is still sitting on disk. Sidecars cost one failed
            # magic-byte read each, which is the cheaper half of that trade.
            for dirpath, _dirnames, filenames in os.walk(root):
                if stop is not None and stop.is_set():
                    counts["cancelled"] = True
                    break
                for name in sorted(filenames):
                    path = self.norm_path(os.path.join(dirpath, name))
                    try:
                        st = os.stat(path)
                    except OSError:
                        continue
                    counts["files"] += 1
                    seen.append((path,))
                    prev = known.get(path)
                    if prev is not None and prev[0] == int(st.st_size) and \
                            abs(prev[1] - float(st.st_mtime)) < 1e-6:
                        counts["skipped"] += 1
                        if len(seen) >= _BATCH:
                            commit()
                        continue
                    row = self._row_from_file(path, group)
                    if row is None:
                        counts["failed"] += 1
                    else:
                        pending.append(row)
                        counts["updated" if prev is not None else "added"] += 1
                    if len(pending) >= _BATCH or len(seen) >= _BATCH:
                        commit()
            if counts["cancelled"]:
                break
        commit()

        # restarted: the seen set was begun again part-way through, so it holds
        # only what was walked after that point. Purging against it would delete
        # rows for files still sitting on disk — the same reason a lost batch
        # suppresses the purge, reached without any error being raised.
        if purge and not counts["cancelled"] and not counts["errors"] and not restarted:
            marks = ",".join("?" for _ in groups)

            def prune(c):
                # indexed_at guards the race with a C-STORE that landed mid-walk:
                # a row written after the scan started was never eligible for
                # the "seen" set, and deleting it would un-find a live study.
                return c.execute(
                    f"DELETE FROM instances WHERE grp IN ({marks}) AND indexed_at < ? "
                    "AND path NOT IN (SELECT path FROM scan_seen)",
                    (*groups.keys(), started),
                )
            try:
                cur = self._write(prune)
                counts["removed"] = cur.rowcount if cur else 0
            except sqlite3.Error:
                counts["errors"] += 1

        with self._lock:
            try:
                self._conn().execute("DROP TABLE IF EXISTS temp.scan_seen")
            except sqlite3.Error:
                pass
        counts["seconds"] = round(time.time() - started, 3)
        # "added" is counted during the walk, before the write that stores it, so
        # a run that lost batches still reports them as new. Saying so on the one
        # line an operator reads is what stops a half-filled index looking clean.
        level = self.log.warn if (counts["cancelled"] or counts["errors"]) else self.log.info
        lost = f", {counts['errors']} batch(es) not written" if counts["errors"] else ""
        level(
            f"Index rescan: {counts['added']} new, {counts['updated']} updated, "
            f"{counts['skipped']} unchanged, {counts['removed']} gone, "
            f"{counts['failed']} skipped{lost} in {counts['seconds']}s",
            kind="index",
        )
        return counts

    def _known(self, group: str, root: str) -> dict[str, tuple[int, float]]:
        """path -> (size, mtime) for one group, read in one query so the walk
        can skip unchanged files without a round-trip per file."""
        frag, params = _prefix_term("path", self.norm_path(root).rstrip(os.sep) + os.sep)
        rows = self._read(
            f"SELECT path, size, mtime FROM instances WHERE grp = ? AND {frag}",
            (group, *params))
        return {r["path"]: (r["size"], r["mtime"]) for r in rows}

    # ------------------------------------------------------------------ queries
    def query_studies(self, filters: Optional[dict] = None, limit: int = 200,
                      offset: int = 0, order_by: str = "-StudyDate",
                      combined_datetime: bool = False) -> list[dict]:
        """Studies matching *filters*, newest first by default.

        Filters use DICOM keywords (plus ``group``); ``*``/``?`` wildcards and
        ``YYYYMMDD-YYYYMMDD`` ranges are supported, an empty value matches
        everything. Series/instance-level filters select the study without
        shrinking its counts. *combined_datetime* is the negotiated DA+TM
        reading, off by default — see _build."""
        w = _Where()
        _build(w, filters, {"study", "file"}, "study_uid", combined_datetime)
        col, desc = self._order(order_by, "study_date", True)
        sql = f"""
            SELECT study_uid, patient_id, patient_name, study_date, study_time,
                   accession, study_desc, grp,
                   COUNT(DISTINCT sop_uid)    AS n_inst,
                   COUNT(DISTINCT series_uid) AS n_series,
                   group_concat(DISTINCT modality) AS mods,
                   MAX(mtime) AS mtime, MIN(path) AS p_lo, MAX(path) AS p_hi
            FROM instances{w.clause()}
            GROUP BY study_uid
            ORDER BY {col} {'DESC' if desc else 'ASC'}, mtime DESC
            {self._page(limit, offset)}
        """
        return [self._study_dict(r) for r in self._read(sql, tuple(w.params))]

    def query_series(self, study_uid: Optional[str] = None, filters: Optional[dict] = None,
                     limit: int = 500, offset: int = 0,
                     combined_datetime: bool = False) -> list[dict]:
        """Series of one study (or of every study when *study_uid* is None).
        *combined_datetime* is the negotiated DA+TM reading — see _build."""
        w = _Where()
        if study_uid:
            w.add("study_uid = ?", [study_uid])
        _build(w, filters, {"study", "series", "file"}, "series_uid", combined_datetime)
        sql = f"""
            SELECT study_uid, series_uid, modality, series_number, series_desc, grp,
                   COUNT(DISTINCT sop_uid) AS n_inst, MAX(mtime) AS mtime,
                   MIN(path) AS p_lo, MAX(path) AS p_hi
            FROM instances{w.clause()}
            GROUP BY series_uid
            ORDER BY series_number IS NULL, series_number ASC, series_uid ASC
            {self._page(limit, offset)}
        """
        return [self._series_dict(r) for r in self._read(sql, tuple(w.params))]

    def query_instances(self, study_uid: Optional[str] = None, series_uid: Optional[str] = None,
                        filters: Optional[dict] = None, limit: int = 1000,
                        offset: int = 0, combined_datetime: bool = False) -> list[dict]:
        """Instances, deduplicated by SOPInstanceUID.

        The same instance can exist in more than one group (received AND sent);
        the row returned is the newest file, which is the one worth serving.
        *combined_datetime* is the negotiated DA+TM reading — see _build."""
        w = _Where()
        if study_uid:
            w.add("study_uid = ?", [study_uid])
        if series_uid:
            w.add("series_uid = ?", [series_uid])
        _build(w, filters, {"study", "series", "instance", "file"}, "", combined_datetime)
        sql = f"""
            SELECT sop_uid, series_uid, study_uid, sop_class_uid, transfer_syntax_uid,
                   instance_number, series_number, modality, path, grp, size,
                   MAX(mtime) AS mtime
            FROM instances{w.clause()}
            GROUP BY sop_uid
            ORDER BY instance_number IS NULL, instance_number ASC, sop_uid ASC
            {self._page(limit, offset)}
        """
        return [self._instance_dict(r) for r in self._read(sql, tuple(w.params))]

    def count(self, level: str = "study", filters: Optional[dict] = None,
              study_uid: Optional[str] = None, series_uid: Optional[str] = None,
              combined_datetime: bool = False) -> int:
        """Total matches at *level* ('study' | 'series' | 'instance'), ignoring
        paging — QIDO-RS needs it for the result-count header. It must be given
        the same *combined_datetime* as the query it is counting, or the header
        describes a different result set than the body."""
        keys = {"study": ("study_uid", {"study", "file"}, "study_uid"),
                "series": ("series_uid", {"study", "series", "file"}, "series_uid"),
                "instance": ("sop_uid", {"study", "series", "instance", "file"}, "")}
        if level not in keys:
            raise ValueError("level must be study|series|instance")
        col, levels, subkey = keys[level]
        w = _Where()
        if study_uid:
            w.add("study_uid = ?", [study_uid])
        if series_uid:
            w.add("series_uid = ?", [series_uid])
        _build(w, filters, levels, subkey, combined_datetime)
        rows = self._read(f"SELECT COUNT(DISTINCT {col}) AS n FROM instances{w.clause()}",
                          tuple(w.params))
        return int(rows[0]["n"]) if rows else 0

    def get_instance(self, sop_uid: str, group: Optional[str] = None) -> Optional[dict]:
        rows = self.query_instances(filters={"SOPInstanceUID": sop_uid, "group": group or ""},
                                    limit=1)
        return rows[0] if rows else None

    def get_instance_path(self, sop_uid: str, group: Optional[str] = None) -> Optional[str]:
        """On-disk path of an instance, or None. Rows whose file has vanished
        are skipped (but NOT deleted — an unmounted share must not empty the
        index); the next rescan is what prunes them."""
        w = _Where()
        w.add("sop_uid = ?", [sop_uid])
        if group:
            w.add("grp = ?", [group])
        rows = self._read(
            f"SELECT path FROM instances{w.clause()} ORDER BY mtime DESC", tuple(w.params))
        for r in rows:
            if os.path.exists(r["path"]):
                return r["path"]
        return None

    def instance_paths(self, study_uid: Optional[str] = None, series_uid: Optional[str] = None,
                       sop_uid: Optional[str] = None, group: Optional[str] = None,
                       existing_only: bool = True) -> list[str]:
        """Every file for a study / series / instance, in send order. This is
        what C-MOVE and C-GET iterate."""
        w = _Where()
        for col, val in (("study_uid", study_uid), ("series_uid", series_uid),
                         ("sop_uid", sop_uid), ("grp", group)):
            if val:
                w.add(f"{col} = ?", [val])
        rows = self._read(
            f"SELECT path, series_number, instance_number FROM instances{w.clause()} "
            "ORDER BY series_number IS NULL, series_number, "
            "instance_number IS NULL, instance_number, path",
            tuple(w.params))
        out, seen = [], set()
        for r in rows:
            p = r["path"]
            if p in seen:
                continue
            if existing_only and not os.path.exists(p):
                continue
            seen.add(p)
            out.append(p)
        return out

    def stats(self) -> dict:
        rows = self._read(
            "SELECT COUNT(*) AS files, COUNT(DISTINCT sop_uid) AS instances, "
            "COUNT(DISTINCT series_uid) AS series, COUNT(DISTINCT study_uid) AS studies, "
            "COUNT(DISTINCT patient_id) AS patients, COALESCE(SUM(size),0) AS bytes, "
            "MAX(mtime) AS newest FROM instances")
        r = rows[0] if rows else None
        groups = {row["grp"]: row["n"] for row in
                  self._read("SELECT grp, COUNT(*) AS n FROM instances GROUP BY grp")}
        try:
            db_bytes = os.path.getsize(self.path) if not self.memory else 0
        except OSError:
            db_bytes = 0
        q = self._q
        return {
            "path": self.path,
            "schema": SCHEMA_VERSION,
            "files": int(r["files"]) if r else 0,
            "instances": int(r["instances"]) if r else 0,
            "series": int(r["series"]) if r else 0,
            "studies": int(r["studies"]) if r else 0,
            "patients": int(r["patients"]) if r else 0,
            "bytes": int(r["bytes"]) if r else 0,
            "newest": float(r["newest"] or 0) if r else 0.0,
            "groups": groups,
            "db_bytes": db_bytes,
            "queued": q.qsize() if q is not None else 0,
            "writing": self.writing,
            "errors": self.errors,
            "last_write": self.last_write,
            "rebuilt": self._rebuilt,
        }

    # ------------------------------------------------------------------ output
    @staticmethod
    def _page(limit: Optional[int], offset: int) -> str:
        off = max(0, int(offset or 0))
        if not limit:                       # 0 / None = everything
            return f"LIMIT -1 OFFSET {off}" if off else ""
        return f"LIMIT {max(1, int(limit))} OFFSET {off}"

    @staticmethod
    def _order(order_by: str, default: str, default_desc: bool) -> tuple[str, bool]:
        raw = _s(order_by)
        desc = raw.startswith("-")
        key = raw.lstrip("-+")
        col = _ORDER_KEYS.get(key) or _ORDER_KEYS.get(_ALIASES.get(key, ""), "")
        if not col:
            return default, default_desc
        return col, desc

    @staticmethod
    def _common_dir(lo: str, hi: str) -> str:
        """Directory shared by every file of the group. The lexicographic min
        and max bracket the whole set, so their common prefix IS the set's."""
        if not lo:
            return ""
        if lo == hi:
            return os.path.dirname(lo)
        try:
            return os.path.commonpath([lo, hi])
        except ValueError:
            return os.path.dirname(lo)

    @classmethod
    def _study_dict(cls, r: sqlite3.Row) -> dict:
        mods = sorted({m for m in (r["mods"] or "").split(",") if m})
        return {
            "StudyInstanceUID": r["study_uid"],
            "PatientID": r["patient_id"],
            "PatientName": r["patient_name"],
            "StudyDate": r["study_date"],
            "StudyTime": r["study_time"],
            "AccessionNumber": r["accession"],
            "StudyDescription": r["study_desc"],
            "ModalitiesInStudy": mods,
            "NumberOfStudyRelatedSeries": int(r["n_series"]),
            "NumberOfStudyRelatedInstances": int(r["n_inst"]),
            "patient": _fmt_name(r["patient_name"]),
            "modality": ",".join(mods) or "?",
            "group": r["grp"],
            "mtime": float(r["mtime"] or 0),
            "path": cls._common_dir(r["p_lo"], r["p_hi"]),
        }

    @classmethod
    def _series_dict(cls, r: sqlite3.Row) -> dict:
        return {
            "StudyInstanceUID": r["study_uid"],
            "SeriesInstanceUID": r["series_uid"],
            "Modality": r["modality"],
            "SeriesNumber": r["series_number"],
            "SeriesDescription": r["series_desc"],
            "NumberOfSeriesRelatedInstances": int(r["n_inst"]),
            "group": r["grp"],
            "mtime": float(r["mtime"] or 0),
            "path": cls._common_dir(r["p_lo"], r["p_hi"]),
        }

    @staticmethod
    def _instance_dict(r: sqlite3.Row) -> dict:
        return {
            "SOPInstanceUID": r["sop_uid"],
            "SeriesInstanceUID": r["series_uid"],
            "StudyInstanceUID": r["study_uid"],
            "SOPClassUID": r["sop_class_uid"],
            "TransferSyntaxUID": r["transfer_syntax_uid"],
            "InstanceNumber": r["instance_number"],
            "SeriesNumber": r["series_number"],
            "Modality": r["modality"],
            "path": r["path"],
            "group": r["grp"],
            "size": int(r["size"] or 0),
            "mtime": float(r["mtime"] or 0),
        }
