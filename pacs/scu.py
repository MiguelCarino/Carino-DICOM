"""Storage SCU — the "send" half.

C-STORE a single .dcm file to a remote node, and C-ECHO to test connectivity.
We request the instance's own transfer syntax (compressed objects are sent
as-is; pynetdicom does not transcode), so if a remote refuses that syntax the
store fails loudly rather than silently corrupting data.
"""

from __future__ import annotations

import os
import socket
import ssl
import threading
import time
from dataclasses import dataclass
from typing import Optional

from pydicom import dcmread
from pydicom.uid import ImplicitVRLittleEndian
from pynetdicom import AE, evt
from pynetdicom.sop_class import Verification

from .assocwords import describe_reject

# C-STORE statuses that are "stored, with a caveat" — treat as success.
# Reading them as failure would cost more than the caveat: the sender never
# writes the destination down as done, so the watcher offers the same file
# again on every pass and the study never becomes archivable — a permanent
# resend loop against a node that already holds the images.
_WARNING_STATUSES = {0xB000, 0xB006, 0xB007}


@dataclass
class Destination:
    name: str
    host: str
    port: int
    aet: str
    tls: bool = False  # connect to this node over TLS

    @classmethod
    def from_dict(cls, d: dict) -> "Destination":
        """Build from one config entry; KeyError if it has no host/port/aet.

        A node with no ``name`` key is named after its host. The name is what
        routing rules are written against and what the send log records, so a
        node that has none still needs something a rule could name and an
        operator could recognise in a line that says a study was sent.
        """
        return cls(name=d.get("name", d["host"]), host=d["host"], port=int(d["port"]),
                   aet=d["aet"], tls=bool(d.get("tls", False)))


def _tls_args(dest: "Destination", tls_context: Optional[ssl.SSLContext]):
    """pynetdicom associate() tls_args tuple, or None for a plaintext link."""
    if dest.tls and tls_context is not None:
        return (tls_context, dest.host)
    return None


@dataclass
class SendResult:
    ok: bool
    message: str


def _associate(ae: AE, dest: "Destination", tls_context):
    """ae.associate() that also remembers whether the TCP connection opened.

    pynetdicom reports "could not connect" and "connected, then refused or
    dropped" the same way — an association that is not established — and the
    two have different fixes, so the difference is kept here for
    _why_not_established()."""
    opened: list = []
    assoc = ae.associate(dest.host, dest.port, ae_title=dest.aet,
                         tls_args=_tls_args(dest, tls_context),
                         evt_handlers=[(evt.EVT_CONN_OPEN, lambda _e: opened.append(True))])
    assoc._carino_opened = bool(opened)
    return assoc


# Recent answers from the diagnostic connect below, per (host, port, tls). A
# dead node is tried for every queued file on every Auto-send pass; without
# this each of those failures paid a second connect timeout on top of the
# association's own, purely to word the error.
_DIAG_TTL = 30.0
# Windows reports a connect to a closed port only after retrying the SYN for
# about two seconds, so a two-second budget there turned every refusal into
# "no reply" — the wrong half of the two fixes.
_DIAG_TIMEOUT = 4.0 if os.name == "nt" else 2.0
_diag_cache: dict = {}
_diag_lock = threading.Lock()


def _why_no_connection(dest: "Destination", timeout) -> str:
    """The socket never opened, and pynetdicom kept the reason in its own
    logger. One short plain connect recovers it — at most once per node per
    _DIAG_TTL, reusing the last answer in between."""
    key = (dest.host, dest.port, bool(dest.tls))
    now = time.monotonic()
    with _diag_lock:
        hit = _diag_cache.get(key)
        if hit and now - hit[0] < _DIAG_TTL:
            return hit[1]
    try:
        with socket.create_connection((dest.host, dest.port),
                                      timeout=min(float(timeout), _DIAG_TIMEOUT)):
            pass
    except ConnectionRefusedError:
        why = (f"connection refused by {dest.host}:{dest.port} — nothing is listening "
               f"there; check that the remote is running and the port is right")
    except (socket.timeout, TimeoutError):
        why = (f"no reply from {dest.host}:{dest.port} — the host is off, unreachable, "
               f"or a firewall is dropping the connection")
    except OSError as exc:
        why = f"could not connect to {dest.host}:{dest.port}: {exc}"
    else:
        if dest.tls:
            why = (f"TLS handshake with {dest.host}:{dest.port} failed — check the "
                   f"certificates and that the remote expects TLS")
        else:
            # Not cached: the node is back, and the next try should say so
            # or, better, succeed.
            return f"could not connect to {dest.host}:{dest.port} (it answers now — try again)"
    with _diag_lock:
        if len(_diag_cache) > 256:
            _diag_cache.clear()
        _diag_cache[key] = (now, why)
    return why


def _why_not_established(assoc, dest: "Destination", calling_aet: str, timeout) -> str:
    """Why an association did not come up, in words for whoever has to fix it:
    a refusal (with the remote's reason), an abort, no reply, or no
    connection at all."""
    scheme = "TLS " if dest.tls else ""
    where = f"{dest.aet} at {dest.host}:{dest.port}"
    if getattr(assoc, "is_rejected", False):
        prim = getattr(getattr(assoc, "acceptor", None), "primitive", None)
        return (f"{scheme}association {describe_reject(prim, calling_aet=calling_aet, called_aet=dest.aet)}"
                f" ({where})")
    if not getattr(assoc, "_carino_opened", True):
        return _why_no_connection(dest, timeout)
    prim = getattr(getattr(assoc, "acceptor", None), "primitive", None)
    if getattr(assoc, "is_aborted", False):
        if prim is not None and getattr(prim, "result", None) == 0:
            return (f"{scheme}association with {where} accepted but nothing we proposed was "
                    f"(no common presentation context), so it was aborted — it does not take this "
                    f"kind of object. If {dest.port} is a worklist or query port rather than its "
                    f"storage port, fix the destination")
        return (f"{scheme}association aborted by {where} — it took the connection and then "
                f"dropped it{' (often a TLS mismatch)' if not dest.tls else ''}")
    return (f"no answer to the association request from {where} within {timeout}s")


# What "can it take images?" is asked with: the storage classes a department
# actually sends, under the transfer syntaxes pynetdicom proposes by default.
# Any one of them accepted means the node stores images; none means it is
# something else that also answers C-ECHO — a worklist or a query service.
_PROBE_STORAGE = (
    "1.2.840.10008.5.1.4.1.1.2",      # CT Image Storage
    "1.2.840.10008.5.1.4.1.1.4",      # MR Image Storage
    "1.2.840.10008.5.1.4.1.1.6.1",    # Ultrasound Image Storage
    "1.2.840.10008.5.1.4.1.1.1",      # Computed Radiography Image Storage
    "1.2.840.10008.5.1.4.1.1.1.1",    # Digital X-Ray Image Storage - For Presentation
    "1.2.840.10008.5.1.4.1.1.7",      # Secondary Capture Image Storage
)


def c_echo(dest: Destination, calling_aet: str, timeout: int = 10,
           tls_context: Optional[ssl.SSLContext] = None,
           check_storage: bool = False) -> SendResult:
    """C-ECHO *dest* and report whether it answered, as a SendResult.

    Refusal, timeout, a TLS handshake that fails and a host that is simply off
    all come back as ``ok=False`` with a message meant to be read by whoever is
    standing at the machine — a result, never an exception. This runs from a
    dashboard button and from the emergency health monitor's polling loop
    alike, and to that loop a node being down is ordinary input rather than an
    error it should have to survive.

    With *check_storage* the same association also offers the common image
    storage classes, and a node that answers C-ECHO but accepts none of them is
    reported as a failure: it is a worklist or a query port, not somewhere a
    study can be sent. The destination Test uses this; the failover monitor's
    reachability probe does not.
    """
    ae = AE(ae_title=calling_aet)
    ae.add_requested_context(Verification)
    if check_storage:
        for uid in _PROBE_STORAGE:
            ae.add_requested_context(uid)
    ae.acse_timeout = timeout
    ae.dimse_timeout = timeout
    ae.network_timeout = timeout
    try:
        assoc = _associate(ae, dest, tls_context)
    except (ssl.SSLError, OSError) as exc:
        return SendResult(False, f"TLS/connection error: {exc}")
    if not assoc.is_established:
        return SendResult(False, _why_not_established(assoc, dest, calling_aet, timeout))
    try:
        status = assoc.send_c_echo()
        if status and status.Status == 0x0000:
            if check_storage and not any(
                    str(c.abstract_syntax) in _PROBE_STORAGE for c in assoc.accepted_contexts):
                return SendResult(False, (
                    f"{dest.aet} at {dest.host}:{dest.port} answers C-ECHO but accepts none of the "
                    f"image types offered (CT, MR, US, CR, DX, Secondary Capture). It is probably a "
                    f"worklist or query port, not a storage port — studies sent here will fail. "
                    f"Check the port: a PACS usually stores on 104 or 11112."))
            return SendResult(True, "verification OK" + (" · accepts images" if check_storage else ""))
        code = f"0x{status.Status:04X}" if status else "no response"
        return SendResult(False, f"C-ECHO failed ({code})")
    finally:
        assoc.release()


@dataclass
class WorklistProbe:
    """One question put to a remote worklist provider, and its answer."""
    label: str                  # what was asked, in the operator's words
    ok: bool                    # did the association and the query succeed
    message: str                # why not, when it did not
    items: list                 # the worklist items that came back
    station_key: str            # the ScheduledStationAETitle we asked for ("" = any)
    date_key: str               # the date we asked for ("" = any)
    # The rest of the question, so the dashboard can say it in the operator's
    # language instead of showing `label`, which is English.
    calling_key: str = ""       # the calling AE title we asked as
    modality_key: str = ""      # the modality we asked for ("" = any)


def c_find_worklist(dest: Destination, calling_aet: str, station_aet: str = "",
                    date: str = "", modality: str = "", timeout: int = 20,
                    tls_context: Optional[ssl.SSLContext] = None) -> WorklistProbe:
    """Ask a remote Modality Worklist provider what it has, AS a given modality.

    `calling_aet` is the borrowed identity — the AE title of the scanner being
    diagnosed, not this appliance's. That is the whole point: a worklist
    provider may answer differently depending on who is asking, and the fault
    being chased is usually exactly that. It also means the scanner must be off
    the network first, because two devices answering to one AE title is a
    conflict this code cannot detect and must not cause quietly.

    An empty `station_aet` is universal matching: "everything you have". An
    empty `date` likewise. The difference between the answers to those and the
    answers to the targeted question is the diagnosis — see the note in
    server.probe_worklist().
    """
    from pydicom.dataset import Dataset
    from pynetdicom.sop_class import ModalityWorklistInformationFind

    ae = AE(ae_title=calling_aet)
    ae.add_requested_context(ModalityWorklistInformationFind)
    ae.acse_timeout = timeout
    ae.dimse_timeout = timeout
    ae.network_timeout = timeout

    # The label is what the operator reads down the table, so it has to name
    # every key that varies — including the modality, or the first two questions
    # print identically and the one difference between them is invisible.
    label = f"as {calling_aet}" + (f", station {station_aet}" if station_aet else ", any station")
    label += f", {date}" if date else ", any date"
    label += f", {modality}" if modality else ", any modality"

    def _probe(*args):
        pr = WorklistProbe(*args)
        pr.calling_key, pr.modality_key = calling_aet, modality
        return pr

    try:
        assoc = _associate(ae, dest, tls_context)
    except (ssl.SSLError, OSError) as exc:
        return _probe(label, False, f"TLS/connection error: {exc}", [], station_aet, date)
    if not assoc.is_established:
        return _probe(label, False,
                             _why_not_established(assoc, dest, calling_aet, timeout),
                             [], station_aet, date)

    # The identifier a modality sends: a few match keys filled, the rest present
    # and empty so the provider returns them. Sending the return keys matters —
    # a provider is entitled to omit anything not asked for.
    ds = Dataset()
    ds.AccessionNumber = ""
    ds.PatientName = ""
    ds.PatientID = ""
    ds.PatientBirthDate = ""
    ds.PatientSex = ""
    ds.StudyInstanceUID = ""
    ds.ReferringPhysicianName = ""
    ds.RequestedProcedureDescription = ""
    ds.RequestedProcedureID = ""
    step = Dataset()
    step.Modality = modality or ""
    step.ScheduledStationAETitle = station_aet or ""
    step.ScheduledStationName = ""
    step.ScheduledProcedureStepStartDate = date or ""
    step.ScheduledProcedureStepStartTime = ""
    step.ScheduledProcedureStepDescription = ""
    step.ScheduledProcedureStepID = ""
    step.ScheduledPerformingPhysicianName = ""
    ds.ScheduledProcedureStepSequence = [step]

    items: list = []
    try:
        for status, identifier in assoc.send_c_find(ds, ModalityWorklistInformationFind):
            if not status:
                return _probe(label, False, "connection lost during the query",
                                     items, station_aet, date)
            code = status.Status
            if code in (0xFF00, 0xFF01) and identifier is not None:
                items.append(_worklist_item(identifier))
            elif code == 0x0000:
                break                       # success, no more matches
            elif code not in (0xFF00, 0xFF01):
                return _probe(label, False, f"C-FIND failed (0x{code:04X})",
                                     items, station_aet, date)
    except Exception as exc:                # a malformed response must not take the probe down
        return _probe(label, False, f"query error: {exc}", items, station_aet, date)
    finally:
        assoc.release()
    return _probe(label, True, f"{len(items)} item(s)", items, station_aet, date)


def _worklist_item(ds) -> dict:
    """One returned worklist item as a plain dict, in the same field names an
    order uses, so the two are comparable without a translation layer."""
    def g(obj, name):
        return str(getattr(obj, name, "") or "").strip()
    step = None
    seq = getattr(ds, "ScheduledProcedureStepSequence", None)
    if seq:
        try:
            step = seq[0]
        except (IndexError, TypeError):
            step = None
    return {
        "accession": g(ds, "AccessionNumber"),
        "patient_name": g(ds, "PatientName"),
        "patient_id": g(ds, "PatientID"),
        "patient_birthdate": g(ds, "PatientBirthDate"),
        "patient_sex": g(ds, "PatientSex"),
        "study_uid": g(ds, "StudyInstanceUID"),
        "referring": g(ds, "ReferringPhysicianName"),
        "study_desc": g(ds, "RequestedProcedureDescription") or (g(step, "ScheduledProcedureStepDescription") if step else ""),
        "modality": g(step, "Modality") if step else "",
        "station_aet": g(step, "ScheduledStationAETitle") if step else "",
        "station_name": g(step, "ScheduledStationName") if step else "",
        "scheduled_date": g(step, "ScheduledProcedureStepStartDate") if step else "",
        "scheduled_time": g(step, "ScheduledProcedureStepStartTime") if step else "",
        "sps_id": g(step, "ScheduledProcedureStepID") if step else "",
    }


def c_store(dest: Destination, filepath: str, calling_aet: str, timeout: int = 30,
            tls_context: Optional[ssl.SSLContext] = None) -> SendResult:
    """C-STORE one file to one node over an association of its own.

    ``ok`` is true for 0x0000 and for the warning statuses above — the object
    is on the far side either way. An unreadable file, a missing SOP
    Class UID, a refused association and a failure status are all ``ok=False``
    with a message written to survive being pasted into a support thread.

    One file, one destination, one association, and the payload named by a
    path rather than handed over as a dataset. That is what lets the same
    instance leave identified to the archive and de-identified to a research
    node in a single pass: the two are two calls with two paths, and neither
    can see the other's dataset. It also means a study costs one association
    and one full read per instance per node — the price of that isolation,
    paid on every send.
    """
    # The whole file, pixels included, because this dataset IS the payload.
    # The stop_before_pixels read used everywhere else in the project (routing,
    # index, history, dicomweb) is the wrong tool here by exactly one attribute
    # and would put an image-less instance on the wire. Reading before
    # associate() is also deliberate: an unreadable file is reported without a
    # socket being opened, and the transfer syntax proposed below is then the
    # one the file genuinely carries rather than a guess.
    try:
        ds = dcmread(filepath)
    except Exception as exc:
        return SendResult(False, f"unreadable ({exc})")

    ts = getattr(getattr(ds, "file_meta", None), "TransferSyntaxUID", None) or ImplicitVRLittleEndian
    sop_class = getattr(ds, "SOPClassUID", None)
    if not sop_class:
        return SendResult(False, "no SOPClassUID")

    ae = AE(ae_title=calling_aet)
    try:
        ae.add_requested_context(sop_class, ts)
    except ValueError as exc:
        # An over-long or malformed UI value is refused here, before any socket
        # is opened. dcmread accepted it and is_dicom accepted it, so a file
        # that reaches this line can still be one pynetdicom will not describe.
        return SendResult(False, f"cannot propose a context for this instance ({exc})")
    ae.acse_timeout = timeout
    ae.dimse_timeout = timeout
    ae.network_timeout = timeout
    try:
        assoc = _associate(ae, dest, tls_context)
    except (ssl.SSLError, OSError) as exc:
        return SendResult(False, f"TLS/connection error: {exc}")
    if not assoc.is_established:
        return SendResult(False, _why_not_established(assoc, dest, calling_aet, timeout))
    try:
        status = assoc.send_c_store(ds)
        if not status:
            return SendResult(False, "no C-STORE response (timeout/abort)")
        code = status.Status
        if code == 0x0000 or code in _WARNING_STATUSES:
            return SendResult(True, "stored" if code == 0x0000 else f"stored (warning 0x{code:04X})")
        return SendResult(False, f"C-STORE failed (0x{code:04X})")
    except Exception as exc:                    # noqa: BLE001 - see below
        # pynetdicom RAISES rather than answering with a status for an instance
        # it cannot put on the wire: no (0008,0018), file meta carrying no
        # transfer syntax, an element that will not re-encode. All of those pass
        # is_dicom() and dcmread(), so they arrive here looking like any other
        # file, from the one folder third parties are invited to drop into.
        #
        # Every caller of this function treats a bad instance as a SendResult,
        # and an exception out of here is not the loud failure it looks like: it
        # unwinds the watcher's entire pass, so no destination is recorded as
        # failed, nothing enters backoff, the stuck panel stays empty, and every
        # file queued behind this one is never dialled again — silently, on a
        # three-second loop, for as long as the file sits there. One malformed
        # instance must cost one instance.
        return SendResult(False, f"cannot send this instance ({exc})")
    finally:
        assoc.release()
