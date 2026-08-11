"""The audit trail — who did what, when, and whether it worked.

Deliberately not the log. ``LogBuffer`` is a 500-entry ring with dated files
behind it, and its job is "what is this box doing right now": it is read by an
operator watching a transfer, it drops its oldest line without ceremony, and
nothing in it names a person. That is the right design for an operational log
and the wrong one for the question a hospital actually asks, which is *who
deleted that study*.

So this is a second artifact with different properties:

* **Append-only.** Records are written and never revised. A correction is
  another record, not an edit.
* **Attributed.** Every record names the profile that caused it. Where the
  actor is the shared API token rather than a person, it says so — attributing
  a script's action to a human who was not there is worse than saying "token".
* **Hash-chained.** Each record covers the previous one's digest, so any
  edit, reorder or deletion breaks every digest after it and :func:`verify`
  says exactly where.

**What the chain does and does not prove.** Be precise about this, because an
audit trail that is trusted further than it earns is worse than one nobody
trusts at all.

It DOES detect: a record edited in place, a record removed from the middle,
records reordered, a file truncated mid-line, and any corruption of a file that
is not the newest one. Each of those breaks a digest, and :func:`verify` says
which record and why.

It does NOT detect two things, both for the same reason — a hash chain
authenticates the ORDER and CONTENT of what is present, not the fact that
something is missing from the end:

* **Truncation at a record boundary.** Delete the last fifty lines and the
  remaining prefix is a perfectly valid chain of everything before them.
  :func:`verify` will say so, honestly, because as far as the file is concerned
  it is intact.
* **A wholesale rewrite.** Somebody with write access to this directory and a
  copy of this file can recompute every digest. Nothing kept beside the data
  can prevent that, which is the same honest limit that applies to encryption
  whose key sits next to what it encrypts.

What closes both is anchoring, and it is the reason :meth:`AuditLog.head` is
published in ``status()``: record that digest somewhere this appliance cannot
write — a monitoring system, a ticket, a colleague's inbox — and any later
truncation or rewrite produces a head that does not match the one you kept, and
a record count that went backwards. Sites that need non-repudiation must anchor.
Sites that need to catch accidents, casual edits and a disk going bad are
already covered by the chain alone.

Recording reads is off by default. "Who viewed this patient" is a real
requirement in some jurisdictions and it multiplies the volume of this file by
the number of times somebody refreshes a dashboard, so it is a decision the
operator makes with ``audit.log_reads`` rather than one this file makes for
them.
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Iterator, Optional

CURRENT = "audit.jsonl"
ARCHIVE_GLOB = "audit-*.jsonl"
GENESIS = "0" * 64            # the previous digest of the very first record

# Rotation is by size, not by day. A dated file sounds tidier until an appliance
# that receives nothing for a week produces seven empty files, or a busy morning
# produces one that no editor will open. Eight megabytes is roughly 40k records.
DEFAULT_MAX_BYTES = 8 * 1024 * 1024

# Actions worth their own constant, because they are matched on elsewhere and a
# typo in a string literal would silently produce an unfindable audit entry.
LOGIN = "login"
LOGIN_FAILED = "login.failed"
LOGOUT = "logout"
CONFIG_CHANGED = "config.changed"
PROFILE_CREATED = "profile.created"
PROFILE_CHANGED = "profile.changed"
PROFILE_DELETED = "profile.deleted"
PASSWORD_CHANGED = "password.changed"
TOKEN_ROTATED = "token.rotated"
DEID_CHANGED = "deid.changed"
STUDY_SENT = "study.sent"
STUDY_DELETED = "study.deleted"
STUDY_READ = "study.read"
ORDER_CHANGED = "order.changed"
SERVICE_CHANGED = "service.changed"
# A worklist probe borrows a modality's AE title to ask another RIS a question.
# Auditable because it is this appliance presenting itself as somebody else's
# equipment, however briefly and however good the reason.
WORKLIST_PROBED = "worklist.probed"
EMERGENCY_CHANGED = "emergency.changed"
SHUTDOWN = "shutdown"
DENIED = "denied"

# Actions that only ever describe a read. Suppressed unless audit.log_reads is
# on; kept in one set so the decision is made once rather than at each call.
READ_ACTIONS = frozenset({STUDY_READ})


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def digest(previous: str, record: dict) -> str:
    """The chain digest for *record*, following *previous*.

    Canonical JSON — sorted keys, no spaces — because the digest has to be
    reproducible by :func:`verify` reading the file back, and Python's default
    separators would make it depend on how it was written rather than on what
    was said. ``default=str`` so a value nothing validated cannot make writing
    an audit record raise: losing the record is a worse outcome than storing an
    approximate rendering of one odd field.
    """
    body = {k: v for k, v in record.items() if k != "hash"}
    payload = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256((previous + payload).encode("utf-8")).hexdigest()


class AuditLog:
    """Append-only, hash-chained records under one directory.

    Safe to share between threads: the DICOM receive threads, the watcher and
    every Flask worker write here. One lock covers read-modify-append, because
    the chain makes each write depend on the last one — two records computed
    against the same predecessor would both look valid alone and break verify()
    together.
    """

    def __init__(self, directory: str, *, enabled: bool = True,
                 max_bytes: int = DEFAULT_MAX_BYTES, log_reads: bool = False,
                 fsync: bool = True, log=None):
        self.dir = str(directory or "")
        self.enabled = bool(enabled)
        self.max_bytes = int(max_bytes)
        self.log_reads = bool(log_reads)
        self.fsync = bool(fsync)
        self.log = log
        self._lock = threading.RLock()
        self._head = GENESIS
        self._seq = 0
        self._broken = ""       # set when we could not write; surfaces in status()
        self._opened = False

    # ---- paths -----------------------------------------------------------
    @property
    def path(self) -> str:
        return os.path.join(self.dir, CURRENT)

    def files(self) -> list:
        """Every audit file, oldest first, with the live one last.

        Archives sort by name, and the name carries a UTC timestamp, so the
        lexical order is the chronological one. That is the whole reason the
        rotation name is built the way it is.
        """
        archives = sorted(glob.glob(os.path.join(self.dir, ARCHIVE_GLOB)))
        live = self.path
        return archives + ([live] if os.path.exists(live) else [])

    # ---- lifecycle -------------------------------------------------------
    def open(self) -> "AuditLog":
        """Create the directory and pick the chain up where it left off.

        Recovers the head by reading the last well-formed record rather than
        trusting a sidecar, because a sidecar is one more thing to lose and a
        head that disagrees with the file would break verify() for records that
        were written perfectly well.
        """
        if not self.enabled:
            return self
        with self._lock:
            try:
                os.makedirs(self.dir, exist_ok=True)
            except OSError as exc:
                self._fail(f"audit directory {self.dir} cannot be created: {exc}")
                return self
            try:
                last = self._last_record()
            except (OSError, UnicodeDecodeError) as exc:
                # The head cannot be guessed. Falling through to an older archive
                # — or to GENESIS — writes a record whose prev names the wrong
                # link, and verify() would then report tampering on a trail
                # nobody had touched. Staying shut is the honest failure: record()
                # reports the gap and retries open() on the next call, so this
                # heals by itself once the file can be read again.
                self._fail(f"audit chain head cannot be read: {exc}")
                return self
            if last is not None:
                self._head = str(last.get("hash") or GENESIS)
                try:
                    self._seq = int(last.get("seq") or 0)
                except (TypeError, ValueError):
                    self._seq = 0
            self._opened = True
        return self

    def _last_record(self) -> Optional[dict]:
        """The newest record that still carries a digest, or None on a fresh trail.

        Files are searched newest first, and looking past the live file matters:
        a restart immediately after a rotation finds no audit.jsonl at all, and
        chaining from GENESIS there would append a record claiming to be the
        first one to a directory already full of archives — verify() would then
        report a break in a trail nobody had touched.
        """
        files = self.files()
        for path in reversed(files):
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    lines = [ln for ln in fh.read().splitlines() if ln.strip()]
            except FileNotFoundError:
                continue                    # rotated away since files() listed it
            except OSError:
                raise                       # open() decides; see the comment there
            for line in reversed(lines):
                try:
                    rec = json.loads(line)
                except ValueError:
                    # A torn final line — the machine lost power mid-append.
                    # Skip it and chain from the last INTACT record: continuing
                    # from a half-written one would make every later digest
                    # unverifiable, which turns one lost record into a whole
                    # unusable trail.
                    continue
                if isinstance(rec, dict) and rec.get("hash"):
                    return rec
        return None

    def _fail(self, message: str) -> None:
        self._broken = message
        if self.log is not None:
            self.log.error(message, kind="audit")

    @property
    def broken(self) -> str:
        """Why the trail is not being written, "" when it is fine.

        Published in status() rather than only logged. An audit trail that
        silently stopped recording is indistinguishable from one where nothing
        happened, and that is the failure a reader of this file would least
        like to discover afterwards.
        """
        return self._broken

    def head(self) -> str:
        """The current chain digest — the value an external monitor anchors."""
        with self._lock:
            return self._head

    # ---- writing ---------------------------------------------------------
    def record(self, action: str, *, actor: Any = None, target: str = "",
               outcome: str = "ok", source: str = "", detail: Any = None,
               **fields) -> Optional[dict]:
        """Append one record. Returns it, or None when nothing was written.

        Never raises. An audit write that throws would propagate out of whatever
        it was auditing — a study delete that half-happened because recording it
        failed is a worse outcome than a gap in the trail, and the gap is
        reported through :attr:`broken` rather than hidden.
        """
        if not self.enabled:
            return None
        if action in READ_ACTIONS and not self.log_reads:
            return None
        try:
            with self._lock:
                if not self._opened:
                    self.open()
                    if not self._opened:
                        return None
                self._rotate_if_needed()
                self._seq += 1
                record = {
                    "seq": self._seq,
                    "ts": _now_iso(),
                    "epoch": int(time.time()),
                    "action": str(action),
                    "actor": _actor_of(actor),
                    "target": str(target or ""),
                    "outcome": str(outcome or "ok"),
                    "source": str(source or ""),
                    "prev": self._head,
                }
                if detail is not None:
                    record["detail"] = detail
                for key, value in fields.items():
                    # Extra fields fill gaps and never overwrite. A caller that
                    # passes seq= or prev= as a keyword — by accident or not —
                    # must not be able to write its own place in the chain.
                    if key not in record:
                        record[key] = value
                record["hash"] = digest(self._head, record)
                line = json.dumps(record, sort_keys=True, separators=(",", ":"),
                                  default=str)
                with open(self.path, "a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
                    if self.fsync:
                        # An audit record that is still in the page cache when
                        # the machine loses power is an audit record that did
                        # not happen. Costly, and correct: this file is written
                        # on deliberate actions, not per received instance.
                        fh.flush()
                        os.fsync(fh.fileno())
                self._head = record["hash"]
                self._broken = ""
                return record
        except OSError as exc:
            self._fail(f"audit record could not be written to {self.path}: {exc}")
            return None
        except Exception as exc:               # never take the caller down
            self._fail(f"audit record failed: {exc}")
            return None

    def _rotate_if_needed(self) -> None:
        """Move the live file aside once it has grown past max_bytes.

        Checked before the append rather than after, so a file overshoots by at
        most one record. Rotation does not restart the chain: the first record
        of the new file still carries the last record of the archive as its
        prev, which is why verify() has to walk every file files() returns and
        not only the live one.
        """
        if self.max_bytes <= 0:
            return
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return
        if size < self.max_bytes:
            return
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        # The sequence suffix is ALWAYS present and always three digits, which
        # is not decoration. files() orders archives lexically and verify()
        # walks them in that order, so the name has to sort chronologically.
        # With the suffix added only on collision, "audit-<stamp>-1.jsonl"
        # sorted BEFORE "audit-<stamp>.jsonl" — '-' is 0x2D and '.' is 0x2E —
        # so two rotations inside the same second were read back in the wrong
        # order and verify() reported the chain broken on a trail that was
        # perfectly intact. A false "your audit trail was tampered with" is
        # about the worst thing this file could say.
        n = 0
        while True:
            target = os.path.join(self.dir, f"audit-{stamp}-{n:03d}.jsonl")
            if not os.path.exists(target):
                break
            n += 1
        try:
            os.replace(self.path, target)
        except OSError as exc:
            # Keep writing to the oversized file rather than stop recording.
            self._fail(f"audit rotation failed ({exc}) — still recording to {self.path}")

    # ---- reading ---------------------------------------------------------
    def read_all(self) -> Iterator[dict]:
        """Every record across every file, oldest first, in chain order.

        A line that will not parse is yielded as ``{"_unparseable": ...}``, and a
        whole file that will not open as ``{"_unreadable": ...}``, rather than
        either being dropped: both are findings verify() has to report, and a
        file stepped over silently is how a short chain gets called intact and
        how an export hands an inspector a trail with the middle missing.
        tail() drops both again for display, where there is nothing to show.

        Both injected keys are underscore-prefixed, and verify() removes keys
        beginning with an underscore before recomputing the digest. Naming one
        of them plainly — ``file`` — would add it to the hashed body and fail
        every record in the trail.
        """
        for path in self.files():
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            rec = json.loads(line)
                        except ValueError:
                            yield {"_unparseable": line[:200], "_file": os.path.basename(path)}
                            continue
                        if isinstance(rec, dict):
                            rec["_file"] = os.path.basename(path)
                            yield rec
            except (OSError, UnicodeDecodeError) as exc:
                # The file is read in chunks, so a bad byte anywhere in a chunk
                # arrives before the records that shared it. That makes this
                # marker land EARLIER than the corruption, never later, which is
                # the conservative direction: verify() stops short of a record it
                # could have checked rather than past one it could not.
                yield {"_unreadable": str(exc), "_file": os.path.basename(path)}

    def tail(self, limit: int = 200, *, action: str = "",
             actor_id: str = "") -> list:
        """The most recent records, newest first, for the dashboard.

        Walks backwards a file at a time and stops as soon as *limit* is filled,
        rather than materialising every record that ever happened to slice the
        end off it. That is not a micro-optimisation: rotation caps a file, not
        the trail, so a couple of years of it is hundreds of megabytes, and
        building that list to render one screenful cost seconds and gigabytes of
        peak memory — on an appliance where the largest process is this one, and
        where the OOM killer taking it also takes the receiver.

        A file that will not read is skipped rather than reported. This is the
        dashboard's view, and verify() is the function whose job is to say the
        trail has a hole in it; refusing to show the newest records because an
        old archive went bad would hide the present to report the past.
        """
        want = max(1, int(limit))
        out: list = []
        for path in reversed(self.files()):
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    lines = fh.read().splitlines()
            except (OSError, UnicodeDecodeError):
                continue
            name = os.path.basename(path)
            for line in reversed(lines):
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue            # a torn line: verify() reports it, not this
                if not isinstance(rec, dict):
                    continue
                if action and rec.get("action") != action:
                    continue
                if actor_id and (rec.get("actor") or {}).get("id") != actor_id:
                    continue
                rec["_file"] = name
                out.append(rec)
                if len(out) >= want:
                    return out
        return out

    def verify(self) -> dict:
        """Walk the chain and report the first place it breaks.

        Returns ``{"ok": bool, "records": n, "broken_at": seq|None,
        "reason": str, "head": digest}``. Stops at the first break rather than
        listing every subsequent one: once a link is altered, every digest after
        it fails as a consequence, and a report of nine thousand failures hides
        the one that matters.
        """
        previous = GENESIS
        count = 0
        for record in self.read_all():
            if "_unreadable" in record:
                # Nothing past this point can be checked, and "ok" over the part
                # that happened to be readable is the one answer this function
                # must never give.
                return {"ok": False, "records": count, "broken_at": None,
                        "reason": f"{record['_file']} could not be read, so the "
                                  f"chain cannot be checked past it: "
                                  f"{record['_unreadable']}",
                        "head": previous}
            if "_unparseable" in record:
                return {"ok": False, "records": count, "broken_at": count + 1,
                        "reason": f"a line in {record['_file']} is not valid JSON — "
                                  f"the file has been edited or truncated",
                        "head": previous}
            count += 1
            stored = str(record.get("hash") or "")
            claimed_prev = str(record.get("prev") or "")
            body = {k: v for k, v in record.items() if not k.startswith("_")}
            if claimed_prev != previous:
                return {"ok": False, "records": count, "broken_at": record.get("seq"),
                        "reason": "a record is missing, or records were reordered: this "
                                  "one follows a different record than the one before it "
                                  "in the file",
                        "head": previous}
            if digest(previous, body) != stored:
                return {"ok": False, "records": count, "broken_at": record.get("seq"),
                        "reason": "this record's contents do not match its digest — it "
                                  "was altered after it was written",
                        "head": previous}
            previous = stored
        return {"ok": True, "records": count, "broken_at": None, "reason": "",
                "head": previous}

    def stats(self) -> dict:
        """What status() publishes about the trail."""
        files = self.files()
        total = 0
        for path in files:
            try:
                total += os.path.getsize(path)
            except OSError:
                pass
        return {
            "enabled": self.enabled,
            "dir": self.dir,
            "files": len(files),
            "bytes": total,
            "head": self.head(),
            "log_reads": self.log_reads,
            # "" when healthy. A dashboard that renders this only when non-empty
            # is the difference between an operator learning their trail stopped
            # and finding out at an inspection.
            "broken": self.broken,
        }


def _actor_of(actor: Any) -> dict:
    """Normalise whoever caused this into the record's actor block.

    Accepts a users.Profile, a plain dict, or None. None becomes the system
    actor, which is honest for the things that genuinely have no person behind
    them — a scheduled rotation, a study arriving over DICOM, the engine
    shutting down on SIGTERM.
    """
    if actor is None:
        return {"id": "", "name": "system", "role": "system", "service": True}
    for attr in ("id", "name", "role"):
        if not hasattr(actor, attr):
            break
    else:
        return {
            "id": getattr(actor, "id", ""),
            "name": getattr(actor, "name", "") or "unknown",
            "role": getattr(actor, "role", ""),
            # The shared token is not a person, and the trail says so rather
            # than attributing a script's delete to whoever happens to hold it.
            "service": getattr(actor, "role", "") == "service",
        }
    if isinstance(actor, dict):
        return {
            "id": str(actor.get("id", "")),
            "name": str(actor.get("name", "") or "unknown"),
            "role": str(actor.get("role", "")),
            "service": bool(actor.get("service", False)),
        }
    return {"id": "", "name": str(actor), "role": "", "service": False}
