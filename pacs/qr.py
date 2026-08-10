"""Query/Retrieve SCP — C-FIND, C-MOVE and C-GET over the sqlite instance index.

This is the half of the PACS that old equipment can actually talk to.  A 2009
ultrasound or a CR reader will never speak QIDO-RS; it speaks DIMSE, and it
expects to be able to ask "what studies do you have for this patient" and then
"send them to me / to that workstation".  That is exactly the Patient Root and
Study Root Query/Retrieve information models, served here at PATIENT, STUDY,
SERIES and IMAGE level.

Shape mirrors ``scp.py`` / ``mwl.py``: a non-blocking ``pynetdicom`` server with
the same TLS / allowed-AET / counter / start-stop surface.

**All matching is delegated to** :mod:`pacs.index`.  The index already
implements DICOM matching in SQL — universal (empty value), single value,
wildcard ``*``/``?``, backslash-separated UID lists and ``a-b`` date/time
ranges — so a C-FIND here is a translation of the query identifier into an
index filter dict and nothing more.  Re-implementing matching in Python over
the results would guarantee the two drift apart, and a Q/R that quietly
disagrees with the archive's own study list is how images go missing.
(``mwl.py`` matches in Python because it matches *in-memory order dicts* with
deliberate leniency — a blank field on an order matches every query so an
untargeted order still reaches every modality.  That leniency is wrong here:
an archive query must answer for what it actually holds.  The two are not
interchangeable; see the integration notes.)

Retrieve (C-MOVE / C-GET) never invents an instance list: it resolves the
identifier through the same index, then hands the files over.  Anything the
index knows about but cannot be read off disk right now is counted as a
**failed sub-operation** and named in the Failed SOP Instance UID List — it is
never quietly dropped from the count, because a C-MOVE that reports success
while sending fewer images than it matched is the worst failure this software
can have.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Callable, Optional

from pynetdicom import AE, ALL_TRANSFER_SYNTAXES, AllStoragePresentationContexts, evt
from pynetdicom.presentation import build_context
from pynetdicom.sop_class import (
    PatientRootQueryRetrieveInformationModelFind,
    PatientRootQueryRetrieveInformationModelGet,
    PatientRootQueryRetrieveInformationModelMove,
    StudyRootQueryRetrieveInformationModelFind,
    StudyRootQueryRetrieveInformationModelGet,
    StudyRootQueryRetrieveInformationModelMove,
    Verification,
)

from .dicomfs import within_roots
from .logbuf import LogBuffer

# A C-FIND that would return more than this is a mistake at the other end (an
# IMAGE-level query with no study key walks the whole archive).  We answer with
# the first slice and say so loudly rather than spending minutes building
# responses nobody reads.  Retrieve is NOT capped — see _retrieve_rows.
_MAX_MATCHES = 20000

# Presentation contexts are limited to 128 per association, so that many
# distinct (SOP class, transfer syntax) pairs is the ceiling for one C-MOVE.
_MAX_CONTEXTS = 128

_MODELS_FIND = (
    PatientRootQueryRetrieveInformationModelFind,
    StudyRootQueryRetrieveInformationModelFind,
)
_MODELS_MOVE = (
    PatientRootQueryRetrieveInformationModelMove,
    StudyRootQueryRetrieveInformationModelMove,
)
_MODELS_GET = (
    PatientRootQueryRetrieveInformationModelGet,
    StudyRootQueryRetrieveInformationModelGet,
)

# Which information model a request arrived on decides whether PATIENT level is
# legal: Study Root has no patient level at all (PS3.4 C.6.2).
_PATIENT_ROOT = {
    PatientRootQueryRetrieveInformationModelFind,
    PatientRootQueryRetrieveInformationModelMove,
    PatientRootQueryRetrieveInformationModelGet,
}

# Real equipment sends all of these for the image level.
_LEVEL_ALIASES = {"IMAGE": "IMAGE", "INSTANCE": "IMAGE", "COMPOSITE": "IMAGE",
                  "PATIENT": "PATIENT", "STUDY": "STUDY", "SERIES": "SERIES"}

# Match keys we can answer.  Every one of these is a key the index knows, and
# the index applies DICOM matching semantics to it.
_MATCH_KEYS = {
    "PatientID", "PatientName", "StudyInstanceUID", "StudyDate", "StudyTime",
    "AccessionNumber", "StudyDescription", "SeriesInstanceUID", "Modality",
    "ModalitiesInStudy", "SeriesNumber", "SeriesDescription", "SOPInstanceUID",
    "SOPClassUID", "SOPClassesInStudy", "InstanceNumber", "TransferSyntaxUID",
}

# Unique key(s) of each level.  PS3.4 C.4.1.1.3.1: the SCP shall return the
# unique key of the level whether or not the SCU asked for it, otherwise the
# SCU cannot address the next level down.
_UNIQUE_KEYS = {
    "PATIENT": ("PatientID",),
    "STUDY": ("StudyInstanceUID",),
    "SERIES": ("StudyInstanceUID", "SeriesInstanceUID"),
    "IMAGE": ("StudyInstanceUID", "SeriesInstanceUID", "SOPInstanceUID"),
}

# The key a retrieve identifier MUST carry at each level.  Without one of these
# the request selects the entire archive, which is never what anyone meant.
_RETRIEVE_KEYS = {
    "PATIENT": ("PatientID",),
    "STUDY": ("StudyInstanceUID",),
    "SERIES": ("SeriesInstanceUID",),
    "IMAGE": ("SOPInstanceUID",),
}

# Index result dicts carry display helpers alongside the DICOM keywords; those
# are for the dashboard, not for the wire.
_NOT_DICOM = {"patient", "modality", "group", "mtime", "path", "size"}


def peer_addr(event) -> str:
    """Remote peer's IP address for an association event, or '?' if unavailable.

    Same helper as ``scp.py`` / ``mwl.py`` / ``print_scp.py`` — see the
    integration notes, this wants to live in one place."""
    try:
        addr = event.assoc.requestor.address
        return str(addr) if addr else "?"
    except Exception:
        return "?"


def _calling_aet(event) -> str:
    try:
        return str(event.assoc.requestor.ae_title or "?")
    except Exception:
        return "?"


def _elem_value(elem):
    """A query element's value in a shape the index understands: a list for
    multi-valued elements (the index treats a list as an OR), else a string."""
    val = elem.value
    if val is None:
        return ""
    # pydicom's MultiValue is not a list subclass, so isinstance alone misses
    # exactly the case that matters most here (a backslash-separated UID list).
    if isinstance(val, (list, tuple)) or type(val).__name__ == "MultiValue":
        return [str(v) for v in val]
    return str(val)


def query_filters(query) -> tuple[dict, list[str]]:
    """Translate a C-FIND/C-MOVE/C-GET identifier into index filters.

    Returns ``(filters, ignored)`` where *ignored* names the match keys that
    carried a value we cannot honour.  An element with an empty value is a
    *return* key, not a match key, and is deliberately left out of the filters —
    passing it through as ``""`` would mean "field is empty" instead of
    "match everything"."""
    filters: dict = {}
    ignored: list[str] = []
    for elem in query:
        if elem.tag.group in (0x0000, 0x0002):
            continue
        kw = elem.keyword or ""
        if kw in ("QueryRetrieveLevel", "SpecificCharacterSet"):
            continue
        if elem.VR == "SQ":
            # Sequence matching (PS3.4 C.2.2.2.6) is not implemented. A
            # zero-item sequence is a return key and matches everything, so it
            # costs nothing; one WITH items is a real filter we are about to
            # drop, and dropping it silently hands the SCU more than it asked
            # for. Name it so it is logged and reported back as 0xFF01.
            if elem.value:
                ignored.append(kw or str(elem.tag))
            continue
        value = _elem_value(elem)
        if not value or (isinstance(value, list) and not any(v.strip() for v in value)):
            continue                       # universal / return key
        if kw in _MATCH_KEYS:
            filters[kw] = value
        else:
            ignored.append(kw or str(elem.tag))
    return filters, ignored


def build_response(level: str, row: dict, query, retrieve_aet: str = ""):
    """One C-FIND pending response for *row*, and the keys it could not answer.

    Returns ``(dataset, unsupported)``.  Only what the SCU asked for comes back
    (plus the level and its unique keys).  Two different "we have nothing"
    cases, and PS3.4 wants them told apart:

    * a key the index *knows* but holds no value for goes back **present and
      zero-length** — that is the honest "this study has no description";
    * a key the index cannot answer at all is **omitted entirely**.
      PS3.4 C.2.2.1.3: an SCP shall not return Optional Keys it does not
      support.  Returning it empty instead claims we looked and found nothing,
      which is how an SCU concludes a patient has no birth date rather than
      that it asked the wrong archive.  *unsupported* names those keys so the
      caller can downgrade the pending status to 0xFF01 (PS3.4 Table C.4-1
      reserves 0xFF00 for responses where every Optional Key was supported).

    This is deliberately NOT the rule QIDO-RS follows next door.  PS3.18
    Table 10.6.1-5 makes the level's required attributes mandatory in *every*
    response, so ``dicomweb.py`` emits the ones the index cannot answer as
    zero-length (``_REQUIRED_BLANK``) — the exact opposite of this function.
    Two standards, two rules; do not "unify" them."""
    from pydicom.dataset import Dataset

    values = {k: v for k, v in row.items() if k not in _NOT_DICOM}
    values["RetrieveAETitle"] = retrieve_aet
    values["InstanceAvailability"] = "ONLINE"

    ds = Dataset()
    ds.SpecificCharacterSet = "ISO_IR 192"      # UTF-8 → accented names survive
    ds.QueryRetrieveLevel = level
    for key in _UNIQUE_KEYS[level]:
        setattr(ds, key, values.get(key) or "")

    unsupported: list[str] = []
    for elem in query:
        if elem.tag.group in (0x0000, 0x0002):
            continue
        kw = elem.keyword or ""
        if kw in ("QueryRetrieveLevel", "SpecificCharacterSet") or elem.tag in ds:
            continue
        if elem.VR == "SQ":
            # Sequence return keys are the same story: we cannot build one, so
            # it is left out and named. (query_filters names it too when it
            # carried items — one key can fail as both a match and a return
            # key, and either way the SCU is owed 0xFF01.)
            unsupported.append(kw or str(elem.tag))
            continue
        if kw in values:
            setattr(ds, kw, values[kw])     # None → a present, zero-length element
        else:
            unsupported.append(kw or str(elem.tag))
    return ds, unsupported


def _patient_rows(studies: list[dict]) -> list[dict]:
    """Fold study rows into patient rows. The index is instance-granular and
    has no patient table on purpose (a summary that can drift from what it
    summarises is a lie waiting to happen), so the patient level is derived
    here — the counts are sums over the same rows a STUDY query would return."""
    out: dict[str, dict] = {}
    for s in studies:
        pid = s.get("PatientID") or ""
        row = out.get(pid)
        if row is None:
            row = out[pid] = {
                "PatientID": pid,
                "PatientName": s.get("PatientName") or "",
                "NumberOfPatientRelatedStudies": 0,
                "NumberOfPatientRelatedSeries": 0,
                "NumberOfPatientRelatedInstances": 0,
                "ModalitiesInStudy": set(),
            }
        row["NumberOfPatientRelatedStudies"] += 1
        row["NumberOfPatientRelatedSeries"] += int(s.get("NumberOfStudyRelatedSeries") or 0)
        row["NumberOfPatientRelatedInstances"] += int(s.get("NumberOfStudyRelatedInstances") or 0)
        row["ModalitiesInStudy"].update(s.get("ModalitiesInStudy") or [])
        if not row["PatientName"]:
            row["PatientName"] = s.get("PatientName") or ""
    for row in out.values():
        row["ModalitiesInStudy"] = sorted(row["ModalitiesInStudy"])
    return list(out.values())


class QrSCP:
    """Query/Retrieve SCP.  Reads through an :class:`~pacs.index.InstanceIndex`
    and writes nothing."""

    def __init__(
        self,
        aet: str,
        bind: str,
        port: int,
        log: LogBuffer,
        index,
        move_destinations: Optional[dict] = None,
        get_destinations: Optional[Callable[[], list]] = None,
        get_tls_context: Optional[Callable[[], object]] = None,
        get_storage_roots: Optional[Callable[[], list[str]]] = None,
        allowed_aets: Optional[list[str]] = None,
        tls: bool = False,
        tls_cert: str = "",
        tls_key: str = "",
        tls_ca: str = "",
    ):
        self.aet = aet
        self.bind = bind
        self.port = port
        self.log = log
        self.index = index
        # Move Destination AE title -> {"host":.., "port":.., "aet":.., "tls":..}
        self.move_destinations = dict(move_destinations or {})
        # Fallback lookup over the normal destination list, so an operator who
        # already configured a node under Destinations doesn't have to type it
        # twice to be able to C-MOVE to it.
        self.get_destinations = get_destinations
        # The SCU-side TLS context builder (PacsServer._scu_tls_context), so an
        # outbound C-MOVE uses exactly the same client certificate / verify
        # settings as an outbound auto-forward.
        self.get_tls_context = get_tls_context
        # Config.storage_roots, called per retrieval rather than read once, so
        # a folder the operator repoints away stops being readable immediately
        # instead of at the next restart. Absent (a bare QrSCP in a test, or a
        # caller that never wired it) means NO root is allowed and every
        # retrieval fails closed — an SCP that hands out files because nobody
        # told it which folders are its own is the failure this guards.
        self.get_storage_roots = get_storage_roots
        self.allowed_aets = [a for a in (allowed_aets or []) if str(a).strip()]
        self.tls = tls
        self.tls_cert = tls_cert
        self.tls_key = tls_key
        self.tls_ca = tls_ca
        self._server = None
        self._lock = threading.Lock()
        # A fresh Event per run. In-flight retrieves poll it, so stop() can end
        # them promptly; and because the next start() makes a NEW one, a
        # straggler from a timed-out join can never be un-stopped by a restart.
        self._stopping = threading.Event()
        self._stopping.set()
        # Counter origin: the server rebuilds this object on every config save,
        # so the counters below restart later than the process did (same reason
        # StorageSCP carries its own started_at).
        self.started_at = time.time()
        self.query_count = 0
        self.match_count = 0
        self.move_count = 0
        self.get_count = 0
        self.sent_count = 0
        self.failed_count = 0       # instances the index knows but we could not send
        self.refused_count = 0      # requests refused (unknown destination / bad identifier)
        self.error_count = 0
        self.last_query: Optional[dict] = None

    @property
    def move_failures(self) -> int:
        """Everything a retrieve did not deliver: refused requests plus
        instances that matched but could not be read off disk."""
        return self.refused_count + self.failed_count

    # ---- query -------------------------------------------------------------
    def _level(self, query, model) -> Optional[str]:
        """The identifier's Query/Retrieve Level, normalised, or None if this
        model cannot serve it."""
        raw = str(getattr(query, "QueryRetrieveLevel", "") or "").strip().upper()
        level = _LEVEL_ALIASES.get(raw, "")
        if not level:
            # Non-conformant but common on old kit. Assume the root level of
            # the model rather than refusing the whole query.
            level = "PATIENT" if model in _PATIENT_ROOT else "STUDY"
        if level == "PATIENT" and model not in _PATIENT_ROOT:
            return None
        return level

    def _find_rows(self, level: str, filters: dict) -> list[dict]:
        idx = self.index
        if level == "PATIENT":
            return _patient_rows(idx.query_studies(filters, limit=0))
        if level == "STUDY":
            return idx.query_studies(filters, limit=_MAX_MATCHES + 1)
        if level == "SERIES":
            return idx.query_series(filters=filters, limit=_MAX_MATCHES + 1)
        return idx.query_instances(filters=filters, limit=_MAX_MATCHES + 1)

    def _retrieve_rows(self, query, level: str) -> Optional[list[dict]]:
        """Instance rows a C-MOVE/C-GET identifier selects, or None when the
        identifier carries no key for its level (which would select the whole
        archive — refused with 'identifier does not match SOP class')."""
        filters, ignored = query_filters(query)
        if not any(k in filters for k in _RETRIEVE_KEYS[level]):
            return None
        if ignored:
            self.log.warn(f"QR: ignoring unsupported retrieve key(s) {', '.join(ignored)}",
                          kind="qr")
        return self.index.query_instances(filters=filters, limit=0)

    # ---- DIMSE handlers ----------------------------------------------------
    def _handle_echo(self, event) -> int:
        self.log.info(f"C-ECHO from {_calling_aet(event)} @ {peer_addr(event)}", kind="qr")
        return 0x0000

    def _handle_find(self, event):
        """Yield one pending response per match, then return (pynetdicom sends
        Success)."""
        stopping = self._stopping
        who, addr = _calling_aet(event), peer_addr(event)
        model = event.context.abstract_syntax
        try:
            query = event.identifier
            level = self._level(query, model)
            if level is None:
                self.log.warn(f"C-FIND from {who} @ {addr}: PATIENT level is not "
                              f"part of the Study Root model", kind="qr")
                with self._lock:
                    self.refused_count += 1
                yield 0xC000, None
                return
            filters, ignored = query_filters(query)
            rows = self._find_rows(level, filters)
        except Exception as exc:
            with self._lock:
                self.error_count += 1
            self.log.error(f"C-FIND from {who} @ {addr} failed: {exc}", kind="qr")
            yield 0xC000, None
            return

        truncated = len(rows) > _MAX_MATCHES
        if truncated:
            rows = rows[:_MAX_MATCHES]
        summary = ", ".join(f"{k}={v}" for k, v in filters.items()) or "all"
        with self._lock:
            self.query_count += 1
            self.last_query = {"epoch": int(time.time()), "level": level, "aet": who,
                               "peer": addr, "filters": summary, "matches": len(rows)}
        self.log.info(f"C-FIND {level} from {who} @ {addr} [{summary}] → "
                      f"{len(rows)} match(es)", kind="qr")
        if ignored:
            self.log.warn(f"C-FIND from {who}: ignoring unsupported match key(s) "
                          f"{', '.join(ignored)} — results are wider than asked",
                          kind="qr")
        if truncated:
            self.log.warn(f"C-FIND {level} from {who} hit the {_MAX_MATCHES}-match "
                          f"ceiling; narrow the query", kind="qr")

        # PS3.4 Table C.4-1: 0xFF00 means "matches are continuing" AND that every
        # Optional Key was supported as a Required Key. 0xFF01 is the same
        # "continuing" with the warning that one or more were not. TWO different
        # things put us in the second case, and both must raise it:
        #   * a match key we could not honour (``ignored``) — the result set is
        #     wider than the SCU asked for, and this is the only way it finds out;
        #   * a return key we cannot answer, which build_response omits rather
        #     than faking as zero-length (PS3.4 C.2.2.1.3).
        # A query where neither happened keeps plain 0xFF00, because there are
        # SCUs that treat anything else as terminal and stop reading matches.
        n = 0
        named: set[str] = set()
        for row in rows:
            if event.is_cancelled or stopping.is_set():
                self.log.info(f"C-FIND from {who} cancelled after {n} match(es)", kind="qr")
                with self._lock:
                    self.match_count += n
                yield 0xFE00, None
                return
            try:
                item, unsupported = build_response(level, row, query, self.aet)
            except Exception as exc:
                with self._lock:
                    self.error_count += 1
                self.log.error(f"C-FIND: could not build a response row: {exc}", kind="qr")
                continue
            fresh = [k for k in unsupported if k not in named]
            if fresh:
                named.update(fresh)
                self.log.warn(f"C-FIND from {who}: omitting unsupported return key(s) "
                              f"{', '.join(fresh)} — reported as 0xFF01", kind="qr")
            n += 1
            yield (0xFF01 if (ignored or unsupported) else 0xFF00), item
        with self._lock:
            self.match_count += n

    def _handle_move(self, event):
        """Destination first, then the sub-operation count, then one pending
        yield per instance — pynetdicom opens the store association and keeps
        the remaining/completed/failed/warning tally itself."""
        stopping = self._stopping
        who, addr = _calling_aet(event), peer_addr(event)
        dest_aet = str(event.move_destination or "").strip()
        dest = self.resolve_move_destination(dest_aet)
        if dest is None:
            with self._lock:
                self.refused_count += 1
            known = ", ".join(sorted(self.move_destinations)) or "none configured"
            self.log.error(f"C-MOVE from {who} @ {addr}: unknown move destination "
                           f"'{dest_aet}' (known: {known})", kind="qr")
            yield None, None                # → 0xA801 Move Destination unknown
            return

        rows, level, refuse = None, None, ""
        try:
            query = event.identifier
            level = self._level(query, event.context.abstract_syntax)
            if level is None:
                refuse = "PATIENT level is not part of the Study Root model"
            else:
                rows = self._retrieve_rows(query, level)
                if rows is None:
                    refuse = "identifier has no usable key for its level"
        except Exception as exc:
            with self._lock:
                self.error_count += 1
            refuse = f"unreadable identifier ({exc})"

        contexts = _retrieve_contexts(rows or [])
        kwargs = {"ae_title": dest.get("aet") or dest_aet}
        if dest.get("tls") and self.get_tls_context:
            try:
                kwargs["tls_args"] = (self.get_tls_context(), dest["host"])
            except Exception as exc:
                refuse = f"TLS config error ({exc})"
                contexts = []
        kwargs["contexts"] = contexts or _fallback_contexts()
        yield dest["host"], int(dest["port"]), kwargs

        if refuse:
            # One "sub-operation" that we immediately fail: the alternative is a
            # Success response that moved nothing, which is a lie.
            with self._lock:
                self.refused_count += 1
            self.log.error(f"C-MOVE from {who} @ {addr} refused: {refuse}", kind="qr")
            yield 1
            yield 0xA900, _failed_list([])
            return

        with self._lock:
            self.move_count += 1
        self.log.info(f"C-MOVE {level} from {who} @ {addr} → {dest_aet} "
                      f"({dest['host']}:{dest['port']}): {len(rows)} instance(s)", kind="qr")
        yield len(rows)
        yield from self._yield_instances(rows, event, stopping, who, f"C-MOVE → {dest_aet}")

    def _handle_get(self, event):
        """Sub-operation count first, then one pending yield per instance —
        pynetdicom C-STOREs them back over this same association."""
        stopping = self._stopping
        who, addr = _calling_aet(event), peer_addr(event)
        rows, level, refuse = None, None, ""
        try:
            query = event.identifier
            level = self._level(query, event.context.abstract_syntax)
            if level is None:
                refuse = "PATIENT level is not part of the Study Root model"
            else:
                rows = self._retrieve_rows(query, level)
                if rows is None:
                    refuse = "identifier has no usable key for its level"
        except Exception as exc:
            with self._lock:
                self.error_count += 1
            refuse = f"unreadable identifier ({exc})"

        if refuse:
            with self._lock:
                self.refused_count += 1
            self.log.error(f"C-GET from {who} @ {addr} refused: {refuse}", kind="qr")
            yield 1
            yield 0xA900, _failed_list([])
            return

        with self._lock:
            self.get_count += 1
        self.log.info(f"C-GET {level} from {who} @ {addr}: {len(rows)} instance(s)", kind="qr")
        yield len(rows)
        yield from self._yield_instances(rows, event, stopping, who, "C-GET")

    def _yield_instances(self, rows: list[dict], event, stopping, who: str, what: str):
        """Shared body of C-MOVE and C-GET: read each matched instance and hand
        it to pynetdicom as a pending sub-operation.

        A row whose file we cannot read is NOT skipped — it is held back and
        reported at the end as a failed sub-operation with its SOP Instance UID
        in the Failed SOP Instance UID List, so the SCU sees a warning and knows
        exactly which images it did not get.

        A row naming a path outside the storage folders is refused the same way,
        and for a different reason: the index is a cache, not an authority, and
        the row is the only thing standing between a query and an open(). This
        used to read whatever path the row named — DICOMweb had asked the
        question since it was written and this side never had. The two now share
        one definition of the answer; see dicomfs.within_roots."""
        from pydicom import dcmread

        # Once per retrieval, not once per row: a study is thousands of rows and
        # every root costs two realpath() calls. Still per RETRIEVAL rather than
        # cached on the object, so an operator who repoints a storage folder is
        # not still serving out of the old one until something restarts.
        roots = list(self.get_storage_roots() or []) if self.get_storage_roots else []
        if not roots:
            # Nothing is inside no folders, so every row below is refused and
            # the SCU is told. Loud, because a Q/R SCP that can retrieve nothing
            # is a misconfiguration and the alternative reading of the same
            # symptom — "the archive is empty" — sends somebody hunting in the
            # wrong place entirely.
            self.log.error(
                f"{what}: no storage folders are configured for retrieval, so nothing "
                f"can be read out. Every instance in this request will be refused.",
                kind="qr")

        broken: list[str] = []
        sent = 0
        for row in rows:
            if event.is_cancelled or stopping.is_set():
                self.log.warn(f"{what} cancelled after {sent} instance(s)", kind="qr")
                with self._lock:
                    self.sent_count += sent
                yield 0xFE00, _failed_list(broken)
                return
            path = row.get("path") or ""
            if not within_roots(path, roots):
                # Reported as a failed sub-operation rather than skipped, for
                # the same reason an unreadable file is: the SCU has to learn
                # which images it did not get. Logged apart from "cannot read"
                # because they are different faults — this one says the index
                # and the configured folders disagree, and no amount of fixing
                # permissions will address it.
                broken.append(str(row.get("SOPInstanceUID") or ""))
                self.log.error(
                    f"{what}: refusing {os.path.basename(path) or '(no path)'} — the index "
                    f"names a file outside every configured storage folder. The index is a "
                    f"cache, so this is a stale or wrong row rather than a missing image; "
                    f"a rescan is what clears it.", kind="qr", path=path)
                continue
            try:
                ds = dcmread(path)
            except Exception as exc:
                broken.append(str(row.get("SOPInstanceUID") or ""))
                self.log.error(f"{what}: cannot read {os.path.basename(path) or path}: "
                               f"{exc}", kind="qr", path=path)
                continue
            sent += 1
            yield 0xFF00, ds

        with self._lock:
            self.sent_count += sent
            self.failed_count += len(broken)
        if not broken:
            return                          # pynetdicom sends the final Success
        # Everything we never yielded is still counted as "remaining", and
        # pynetdicom rolls remaining into failed on a Failure/Warning status —
        # which is exactly the accounting we want for unreadable files.
        self.log.error(f"{what}: {len(broken)} of {len(rows)} instance(s) could not be "
                       f"read and were NOT delivered", kind="qr")
        yield (0xA702 if sent == 0 else 0xB000), _failed_list(broken)

    # ---- move destinations -------------------------------------------------
    def resolve_move_destination(self, dest_aet: str) -> Optional[dict]:
        """Resolve a C-MOVE Move Destination AE title to a network node.

        ``qr.move_destinations`` wins; failing that we fall back to the ordinary
        destination list matched by AE title, because a node the operator has
        already configured (and echo-tested) under Destinations is a node they
        clearly trust.  No match at all means the move is refused — we never
        guess a host."""
        if not dest_aet:
            return None
        table = self.move_destinations or {}
        entry = table.get(dest_aet)
        if entry is None:
            for key, val in table.items():
                if str(key).strip().upper() == dest_aet.upper():
                    entry = val
                    break
        if isinstance(entry, dict) and entry.get("host") and entry.get("port"):
            return {"host": str(entry["host"]), "port": int(entry["port"]),
                    "aet": str(entry.get("aet") or dest_aet), "tls": bool(entry.get("tls"))}
        if not self.get_destinations:
            return None
        try:
            dests = self.get_destinations() or []
        except Exception:
            return None
        for d in dests:
            if str(d.get("aet", "")).strip().upper() != dest_aet.upper():
                continue
            if not d.get("host") or not d.get("port"):
                continue
            return {"host": str(d["host"]), "port": int(d["port"]),
                    "aet": str(d.get("aet") or dest_aet), "tls": bool(d.get("tls"))}
        return None

    # ---- lifecycle ---------------------------------------------------------
    @property
    def running(self) -> bool:
        return self._server is not None

    def start(self) -> None:
        if self.running:
            return
        ae = AE(ae_title=self.aet)
        for model in _MODELS_FIND + _MODELS_MOVE + _MODELS_GET:
            ae.add_supported_context(model)
        # C-GET returns the instances on the requestor's own association, which
        # reverses the usual roles: the requestor becomes the Storage SCP and we
        # become the Storage SCU. scp_role=True is what permits that reversal
        # (the flag names the role the REQUESTOR may take); without it every
        # C-GET sub-operation dies with "no accepted presentation context".
        # scu_role stays False so this port never advertises itself as somewhere
        # to push images — that is the receiver's job, on the receiver's port.
        for ctx in AllStoragePresentationContexts:
            ae.add_supported_context(ctx.abstract_syntax, ALL_TRANSFER_SYNTAXES,
                                     scu_role=False, scp_role=True)
        ae.add_supported_context(Verification)
        if self.allowed_aets:
            ae.require_calling_aet = list(self.allowed_aets)
        handlers = [
            (evt.EVT_C_FIND, self._handle_find),
            (evt.EVT_C_MOVE, self._handle_move),
            (evt.EVT_C_GET, self._handle_get),
            (evt.EVT_C_ECHO, self._handle_echo),
        ]
        ssl_context = None
        if self.tls:
            from .tlsutil import server_context
            ssl_context = server_context(self.tls_cert, self.tls_key, self.tls_ca)
        self._stopping = threading.Event()          # fresh per run
        self._server = ae.start_server(
            (self.bind, self.port), block=False, evt_handlers=handlers, ssl_context=ssl_context
        )
        allow = ", ".join(self.allowed_aets) if self.allowed_aets else "any"
        proto = "DICOM-TLS" + (" (mutual)" if self.tls and self.tls_ca else "") if self.tls else "plain DICOM"
        self.log.info(
            f"Query/Retrieve listening on {self.bind}:{self.port} as {self.aet} "
            f"[{proto}] (accept: {allow})",
            kind="qr",
        )

    def stop(self, timeout: float = 5.0) -> None:
        """Stop accepting, end in-flight retrieves, and JOIN their threads.

        apply_config() stops and immediately restarts this object, so stop()
        must not return while a C-MOVE is still reading files and streaming
        them: that thread would keep logging and counting against an object the
        dashboard has already replaced.  Setting the per-run event first is what
        makes the join short — the retrieve generators poll it between
        instances."""
        if not self.running:
            return
        self._stopping.set()
        server = self._server
        try:
            assocs = list(getattr(server, "active_associations", []))
        except Exception:
            assocs = []
        try:
            server.shutdown()               # stops the acceptor and closes the socket
        finally:
            self._server = None
        me = threading.current_thread()
        for t in assocs:
            try:
                if t.is_alive() and t is not me:
                    t.join(timeout=timeout)
            except Exception:
                pass
        self.log.info("Query/Retrieve stopped", kind="qr")


def _failed_list(uids: list[str]):
    """The Failed SOP Instance UID List identifier pynetdicom attaches to a
    Cancel / Warning / Failure retrieve response."""
    from pydicom.dataset import Dataset
    ds = Dataset()
    ds.FailedSOPInstanceUIDList = [u for u in uids if u]
    return ds


def _fallback_contexts() -> list:
    """Contexts to propose when the matched rows named none of their own —
    which is every refusal, because a refused C-MOVE has no rows.

    pynetdicom's move flow still makes us open the sub-association before we can
    answer with a real status, and if the destination accepts none of what we
    propose the requestor aborts, which pynetdicom then reports as 0xA801 "Move
    Destination unknown". The SCU is then told the wrong thing entirely: it goes
    looking at its move-destination configuration instead of at the identifier
    it sent. A storage node accepts storage contexts by definition, so propose
    those as well as Verification and let whichever one it supports stick."""
    ctxs = [build_context(Verification)]
    ctxs += list(AllStoragePresentationContexts)[:_MAX_CONTEXTS - len(ctxs)]
    return ctxs


def _retrieve_contexts(rows: list[dict]) -> list:
    """Presentation contexts for a C-MOVE sub-association: one per distinct
    (SOP class, transfer syntax) actually present in the matched instances.

    Built from the index rows rather than by opening files — the index already
    stores both UIDs.  We propose the instances' own transfer syntaxes because
    pynetdicom does not transcode; offering anything else would only produce a
    context the store cannot use."""
    seen: list[tuple[str, str]] = []
    for row in rows:
        sop = str(row.get("SOPClassUID") or "")
        ts = str(row.get("TransferSyntaxUID") or "")
        if not sop or not ts:
            continue
        pair = (sop, ts)
        if pair not in seen:
            seen.append(pair)
        if len(seen) >= _MAX_CONTEXTS:
            break
    return [build_context(sop, ts) for sop, ts in seen]
