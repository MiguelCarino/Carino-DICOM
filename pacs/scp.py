"""Storage SCP — the "receive" half of the PACS.

Listens for associations and handles C-STORE (store the incoming instance to
disk) and C-ECHO (verification ping).  Every storage SOP class is accepted
with every transfer syntax pynetdicom knows, so compressed objects (JPEG,
JPEG-LS, JPEG2000, RLE) are stored as-received without transcoding.
"""

from __future__ import annotations

import errno
import os
import re
import shutil
import threading
import time
from typing import Callable, Optional

from pynetdicom import AE, evt, AllStoragePresentationContexts, ALL_TRANSFER_SYNTAXES
from pynetdicom.sop_class import Verification

from .assocwords import caller_of, listener_refusal
from .connections import listener_handlers
from .dicomfs import save_dicom
from .logbuf import LogBuffer
from .netclaim import cap_per_host, claim, limit_listener

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]")

# PS3.5 9.1: a UID is digits and dots only, at most 64 characters. Lenient
# about leading zeros in a component (common in the field, harmless here).
_UID_RE = re.compile(r"^[0-9]+(\.[0-9]+)*$")

# Win32 device names, refused as a path component on Windows with or without an
# extension. Prefixed on every platform so a storage tree copied between a
# Linux box and a Windows desktop install stays usable on both.
_RESERVED = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(10)} \
    | {f"LPT{i}" for i in range(10)} | {"COM\u00b9", "COM\u00b2", "COM\u00b3",
                                       "LPT\u00b9", "LPT\u00b2", "LPT\u00b3"}


def valid_uid(value) -> bool:
    """True when *value* is a syntactically valid DICOM UID (PS3.5 9.1)."""
    s = str(value or "").strip().rstrip("\x00")
    return bool(s) and len(s) <= 64 and bool(_UID_RE.match(s))


def _safe(component: str, fallback: str) -> str:
    """Turn a DICOM UID/ID into a safe single path component.

    Truncated BEFORE the edge strip, so a long value cannot end in a dot or a
    space (which Win32 silently drops), and a Windows device name (CON, NUL,
    COM1, LPT1 ... with or without an extension) is prefixed with '_'.
    """
    s = _UNSAFE.sub("_", str(component or "").strip())[:120]
    s = s.strip("._ ") or fallback
    stem = s.split(".", 1)[0].upper()
    if stem in _RESERVED:
        s = "_" + s
    return s


def _uid_component(value, fallback: str) -> str:
    """A path component for a Study/Series UID. A valid UID is used as-is; an
    invalid one is never sanitised into a name another value could share — it
    becomes a hash of the raw value, so two different malformed UIDs cannot
    collapse into one folder."""
    raw = str(value or "").strip().rstrip("\x00")
    if not raw:
        return fallback
    if valid_uid(raw):
        return raw
    import hashlib
    return "x" + hashlib.sha256(raw.encode("utf-8", "surrogateescape")).hexdigest()[:24]


def _peer_addr(event) -> str:
    """Remote peer's IP address for an association event, or '?' if unavailable."""
    try:
        addr = event.assoc.requestor.address
        return str(addr) if addr else "?"
    except Exception:
        return "?"


def _store_snapshot(ds, path: str, event) -> dict:
    """A small, immutable record of the instance just stored, for the dashboard's
    "last received".  Every read is best-effort: telemetry must never be the
    reason a C-STORE fails, so a tag we cannot decode becomes an empty string."""
    from .history import _fmt_name          # lazy: this is the C-STORE path, not the poll path
    snap = {
        "epoch": int(time.time()),
        "modality": "", "patient": "", "patient_id": "", "study_uid": "",
        "file": os.path.basename(path),
        "from_aet": "", "peer": _peer_addr(event),
    }
    try:
        snap["modality"] = str(getattr(ds, "Modality", "") or "")
        snap["patient"] = _fmt_name(getattr(ds, "PatientName", ""))
        snap["patient_id"] = str(getattr(ds, "PatientID", "") or "")
        snap["study_uid"] = str(getattr(ds, "StudyInstanceUID", "") or "")
    except Exception:
        pass
    try:
        snap["from_aet"] = str(event.assoc.requestor.ae_title or "")
    except Exception:
        pass
    return snap


class InvalidInstanceUID(ValueError):
    """The dataset has no usable SOP Instance UID, so it cannot be filed under
    a name that is its own. Storing it anyway would let it overwrite another
    instance (every such object used to become unknown.dcm)."""


def dest_path(base: str, ds, organize: bool, sop_uid: str = "") -> str:
    """Where an instance is filed. Raises InvalidInstanceUID when neither the
    dataset's SOPInstanceUID nor *sop_uid* (the C-STORE request's Affected SOP
    Instance UID) is a valid UID — never a shared fallback filename."""
    sop = str(getattr(ds, "SOPInstanceUID", "") or "").strip().rstrip("\x00")
    if not sop:
        sop = str(sop_uid or "").strip().rstrip("\x00")
    if not valid_uid(sop):
        raise InvalidInstanceUID(f"invalid or missing SOP Instance UID {sop!r}")
    if not organize:
        return os.path.join(base, sop + ".dcm")
    patient = _safe(getattr(ds, "PatientID", ""), "NOID")
    study = _uid_component(getattr(ds, "StudyInstanceUID", ""), "NOSTUDY")
    series = _uid_component(getattr(ds, "SeriesInstanceUID", ""), "NOSERIES")
    return os.path.join(base, patient, study, series, sop + ".dcm")


def _existing_patient(path: str) -> Optional[str]:
    """PatientID of the instance already filed at *path*, or None."""
    if not os.path.exists(path):
        return None
    try:
        from pydicom import dcmread
        old = dcmread(path, stop_before_pixels=True, force=True,
                      specific_tags=["PatientID"])
        return str(getattr(old, "PatientID", "") or "")
    except Exception:
        return None


# errno values that genuinely mean "out of resources": the only failures a
# sender should treat as temporary and retry (PS3.4 Table B.2-1, A7xx).
_RESOURCE_ERRNOS = {getattr(errno, n) for n in ("ENOSPC", "EDQUOT", "EFBIG")
                    if hasattr(errno, n)}


class StorageSCP:
    def __init__(
        self,
        aet: str,
        bind: str,
        port: int,
        storage_dir: str,
        organize: bool,
        log: LogBuffer,
        allowed_aets: Optional[list[str]] = None,
        on_received: Optional[Callable[[object, str], None]] = None,
        index=None,
        tls: bool = False,
        tls_cert: str = "",
        tls_key: str = "",
        tls_ca: str = "",
        min_free_mb: int = 2048,
        journal=None,
        max_associations: Optional[int] = None,
        max_per_host: Optional[int] = None,
    ):
        self.aet = aet
        # connections.ConnectionJournal, or None outside PacsServer.
        self.journal = journal
        self.max_associations = max_associations
        self.max_per_host = max_per_host
        if isinstance(allowed_aets, str):
            # A bare string used to be iterated character by character, so
            # "CT1" became an allow-list of 'C', 'T' and '1'.
            raise ValueError("allowed_aets must be a list of AE titles, not a string")
        self.bind = bind
        self.port = port
        self.storage_dir = storage_dir
        self.organize = organize
        self.min_free_mb = max(0, int(min_free_mb or 0))
        self.log = log
        self.allowed_aets = [a for a in (allowed_aets or []) if str(a).strip()]
        self.on_received = on_received
        # Optional InstanceIndex. It is a cache in front of the files, never the
        # record itself, so it is handed the instance AFTER the write and can
        # never be a reason a C-STORE fails.
        self.index = index
        self.tls = tls
        self.tls_cert = tls_cert
        self.tls_key = tls_key
        self.tls_ca = tls_ca
        self._server = None
        self._lock = threading.Lock()
        # When the counters below were zeroed. The server builds a NEW receiver
        # on every config save and every Start, so they restart at a moment
        # LATER than the process did; anchoring them to the server's start time
        # would claim a window they never covered ("0 received since 09:00" on a
        # receiver rebuilt at 09:05). The dashboard reads this as their origin.
        self.started_at = time.time()
        self.received_count = 0
        self.error_count = 0
        self.refused_count = 0
        # Last instance stored by THIS object — None until one arrives, and gone
        # again when the receiver is rebuilt (a config save replaces it), which is
        # why the dashboard shows it against started_at above.
        self.last_stored: Optional[dict] = None
        self._warned_low = False

    # ---- disk guard --------------------------------------------------------
    def _free_mb(self) -> Optional[int]:
        """Free megabytes on the storage volume, or None if it can't be read."""
        try:
            probe = self.storage_dir if os.path.isdir(self.storage_dir) else \
                (os.path.dirname(self.storage_dir) or ".")
            return int(shutil.disk_usage(probe).free // (1024 * 1024))
        except OSError:
            return None

    def _space_ok(self) -> bool:
        """True if there's room to accept another instance. Fail-open when the
        free space can't be read (don't reject on a probe error)."""
        if self.min_free_mb <= 0:
            return True
        free = self._free_mb()
        return free is None or free >= self.min_free_mb

    # ---- DIMSE handlers ----------------------------------------------------
    def _handle_echo(self, event) -> int:
        who = event.assoc.requestor.ae_title
        self.log.info(f"C-ECHO from {who} @ {_peer_addr(event)}", kind="echo")
        return 0x0000

    def _handle_store(self, event) -> int:
        # Refuse before writing if the disk is below the safety floor — a
        # half-written object is worse than a clean "out of resources" reject
        # the sender can retry once space is freed.
        if not self._space_ok():
            with self._lock:
                self.refused_count += 1
            free = self._free_mb()
            self.log.error(
                f"Refused C-STORE — low disk space ({free} MB free < {self.min_free_mb} MB floor) "
                f"on {self.storage_dir}",
                kind="store",
            )
            return 0xA700          # Refused: Out of Resources
        try:
            ds = event.dataset
        except Exception as exc:
            # The data set itself could not be decoded: "cannot understand".
            with self._lock:
                self.error_count += 1
            self.log.error(f"Failed to decode an incoming instance: {exc}", kind="store")
            return 0xC210
        path = ""
        try:
            ds.file_meta = event.file_meta
            req = getattr(event, "request", None)
            affected = str(getattr(req, "AffectedSOPInstanceUID", "") or "")
            # Data Set does not match SOP Class (A900): the dataset names a SOP
            # class other than the one the presentation context was negotiated for.
            try:
                ctx_cls = str(event.context.abstract_syntax or "")
            except Exception:
                ctx_cls = ""
            ds_cls = str(getattr(ds, "SOPClassUID", "") or "")
            if ctx_cls and ds_cls and ds_cls != ctx_cls:
                with self._lock:
                    self.error_count += 1
                self.log.error(f"Refused C-STORE: SOP Class {ds_cls} does not match the "
                               f"negotiated {ctx_cls}", kind="store")
                return 0xA900
            # Who sent it, kept in the file itself (0002,0016) the way storescp
            # does: History reads the source AE from here, and it is the one
            # record of the sender that survives the file being copied around.
            caller = str(event.assoc.requestor.ae_title or "").strip()
            if caller:
                ds.file_meta.SourceApplicationEntityTitle = caller
            try:
                path = dest_path(self.storage_dir, ds, self.organize, sop_uid=affected)
            except InvalidInstanceUID as exc:
                with self._lock:
                    self.error_count += 1
                self.log.error(f"Refused C-STORE from {caller or '?'}: {exc}", kind="store")
                return 0xC000          # Error: cannot understand
            if not str(getattr(ds, "SOPInstanceUID", "") or "").strip():
                ds.SOPInstanceUID = affected.strip()
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            before = _existing_patient(path)
            new_pid = str(getattr(ds, "PatientID", "") or "")
            if before is not None and before != new_pid:
                self.log.warn(
                    f"C-STORE from {caller or '?'} replaces {os.path.basename(path)} "
                    f"with a different PatientID (same SOP Instance UID) — check the sender",
                    kind="store", path=path)
            save_dicom(ds, path)
        except OSError as exc:
            with self._lock:
                self.error_count += 1
            if exc.errno in _RESOURCE_ERRNOS:
                self.log.error(f"Failed to store instance (out of space): {exc}", kind="store")
                return 0xA700
            self.log.error(f"Failed to store instance (I/O error, not out of space): {exc}",
                           kind="store")
            return 0xC211
        except Exception as exc:  # an unencodable or otherwise invalid dataset
            with self._lock:
                self.error_count += 1
            self.log.error(f"Failed to store instance: {exc}", kind="store")
            return 0xC211
        # Read the tags OUTSIDE the lock and assign the finished dict inside
        # it: the critical section stays two attribute writes, and a reader
        # only ever sees a complete snapshot (we never mutate one in place).
        snap = _store_snapshot(ds, path, event)
        with self._lock:
            self.received_count += 1
            self.last_stored = snap
        who = event.assoc.requestor.ae_title
        self.log.info(
            f"Stored {getattr(ds, 'Modality', '?')} {os.path.basename(path)} "
            f"from {who} @ {_peer_addr(event)}",
            kind="store",
            path=path,
        )
        if self.index is not None:
            # Hand the already-parsed dataset over rather than the path: the
            # index flattens the header on this thread (microseconds) and
            # queues the row for its own writer, so the association is never
            # waiting on sqlite. A failure here costs a query result, not an
            # image — the file is on disk and a rescan will find it.
            try:
                self.index.enqueue_dataset(ds, path, "received")
            except Exception as exc:
                self.log.warn(f"Could not index {os.path.basename(path)}: {exc}", kind="index")
        if self.on_received:
            try:
                self.on_received(ds, path)
            except Exception as exc:  # never let a callback kill the association
                self.log.error(f"Post-store processing failed for {os.path.basename(path)} "
                               f"(stored; RIS match / hold-and-forward may be missing): {exc}",
                               kind="store", path=path)
        return 0x0000

    def _handle_rejected(self, event) -> None:
        """Say why a modality was turned away, which pynetdicom does not. It
        counts as an error: from the modality's side its images did not go."""
        who, addr = caller_of(event)
        with self._lock:
            self.error_count += 1
        self.log.warn(f"Receiver: refused {who or 'a modality'} @ {addr} — "
                      f"{listener_refusal(event, self.allowed_aets)}", kind="scp")

    # ---- lifecycle ---------------------------------------------------------
    @property
    def running(self) -> bool:
        return self._server is not None

    def start(self) -> None:
        if self.running:
            return
        os.makedirs(self.storage_dir, exist_ok=True)
        ae = AE(ae_title=self.aet)
        limit_listener(ae, self.max_associations)
        for ctx in AllStoragePresentationContexts:
            ae.add_supported_context(ctx.abstract_syntax, ALL_TRANSFER_SYNTAXES)
        ae.add_supported_context(Verification)
        if self.allowed_aets:
            ae.require_calling_aet = list(self.allowed_aets)
        handlers = [
            (evt.EVT_C_STORE, self._handle_store),
            (evt.EVT_C_ECHO, self._handle_echo),
            (evt.EVT_REJECTED, self._handle_rejected),
        ]
        handlers += listener_handlers(self.journal, "receiver", self.aet, self.port, bool(self.tls))
        ssl_context = None
        if self.tls:
            from .tlsutil import server_context
            ssl_context = server_context(self.tls_cert, self.tls_key, self.tls_ca)
        # Nothing else may already hold this port. On Windows a plain bind
        # would silently join an existing listener instead of refusing it;
        # netclaim explains why that costs images.
        claim(self.bind, self.port)
        self._server = ae.start_server(
            (self.bind, self.port), block=False, evt_handlers=handlers, ssl_context=ssl_context
        )
        cap_per_host(self._server, self.max_per_host, log=self.log, label="Receiver")
        allow = ", ".join(self.allowed_aets) if self.allowed_aets else "any"
        proto = "DICOM-TLS" + (" (mutual)" if self.tls and self.tls_ca else "") if self.tls else "plain DICOM"
        self.log.info(
            f"Receiver listening on {self.bind}:{self.port} as {self.aet} "
            f"[{proto}] (accept: {allow}) -> {self.storage_dir}",
            kind="scp",
        )

    def stop(self) -> None:
        if not self.running:
            return
        try:
            self._server.shutdown()
        finally:
            self._server = None
            self.log.info("Receiver stopped", kind="scp")
