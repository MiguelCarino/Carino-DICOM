"""Non-DICOM ingestion — turn PDFs and images into real DICOM instances.

A lot of modalities (sonography suites, report printers, screenshot tools) emit
PDFs or JPEG/PNG images instead of DICOM.  Rather than invent a "dummy" object,
we wrap them in the *standard* SOP classes every PACS understands:

  * PDF   -> Encapsulated PDF Storage   (1.2.840.10008.5.1.4.1.1.104.1)
  * image -> Secondary Capture Storage  (1.2.840.10008.5.1.4.1.1.7)

The hard part is never the DICOM — it is the patient/study *identity*, which a
loose file can't supply.  Two entry points feed identity in:

  * the watcher siphons convertible files it finds beside a study into a review
    "pending" queue, pre-filling identity from a sibling DICOM header;
  * the dashboard "Attach" action inherits identity straight from the target
    study (so a report can be added to an already-sent study and re-sent).

This module owns the converters and the on-disk pending store; it deliberately
knows nothing about the watcher or the web layer.
"""

from __future__ import annotations

import json
import os
import shutil
import uuid

from .dicomfs import save_dicom

CONVERTIBLE_EXTS = {
    ".pdf": "pdf",
    ".jpg": "image",
    ".jpeg": "image",
    ".png": "image",
}

META_NAME = "meta.json"


# --------------------------------------------------------------------- detect
def _classify(head: bytes, filename: str = "") -> str | None:
    """'pdf' | 'image' | None from magic bytes, falling back to the extension."""
    if head[:4] == b"%PDF":
        return "pdf"
    if head[:3] == b"\xff\xd8\xff":                 # JPEG
        return "image"
    if head[:8] == b"\x89PNG\r\n\x1a\n":            # PNG
        return "image"
    return CONVERTIBLE_EXTS.get(os.path.splitext(filename)[1].lower())


def detect_kind(path: str) -> str | None:
    """Classify a file on disk (see _classify). Anything not PDF/JPEG/PNG → None."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(16)
    except OSError:
        return None
    return _classify(head, path)


def detect_kind_bytes(data: bytes, filename: str = "") -> str | None:
    """Classify an in-memory upload (used by the dashboard Attach action)."""
    return _classify(data[:16], filename)


# ------------------------------------------------------------------- builders
def _norm_date(value) -> str:
    """Coerce a date to DICOM DA form (YYYYMMDD); '' if it isn't a full date."""
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    return digits[:8] if len(digits) >= 8 else ""


def _resolve_patient_name(meta: dict) -> str:
    """Best PatientName to write: keep the original 'Family^Given' structure when
    the form value is just its display form unchanged, otherwise use what the
    user typed (verbatim if it already contains a '^').

    The round-trip comparison is what protects the component structure. The
    review form is shown a display name, so writing back whatever it holds would
    flatten 'Doe^Jane' into the single component 'Jane Doe' — a name that no
    longer matches the one on the rest of the study this file was converted to
    join. Only a value the operator actually changed is worth that.
    """
    from .history import _fmt_name
    typed = str(meta.get("patient") or "").strip()
    raw = str(meta.get("patient_name") or "").strip()
    if not typed:
        return raw
    if "^" in typed:
        return typed
    if raw and _fmt_name(raw) == typed:
        return raw
    return typed


def _file_meta(sop_class: str, sop_inst: str):
    from pydicom.dataset import FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, PYDICOM_IMPLEMENTATION_UID

    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID = sop_class
    fm.MediaStorageSOPInstanceUID = sop_inst
    fm.TransferSyntaxUID = ExplicitVRLittleEndian
    fm.ImplementationClassUID = PYDICOM_IMPLEMENTATION_UID
    return fm


def _base_dataset(sop_class: str, meta: dict):
    """A Dataset carrying the shared Patient/Study/Series identity, ready for a
    modality-specific module to be layered on top."""
    from pydicom.dataset import Dataset
    from pydicom.uid import generate_uid

    sop_inst = generate_uid()
    ds = Dataset()
    ds.file_meta = _file_meta(sop_class, sop_inst)
    ds.preamble = b"\x00" * 128
    ds.is_little_endian = True
    ds.is_implicit_VR = False

    ds.SpecificCharacterSet = "ISO_IR 192"          # UTF-8 → accented names survive
    ds.SOPClassUID = sop_class
    ds.SOPInstanceUID = sop_inst

    # Patient / Study — inherited identity (study_uid keeps it grouped correctly)
    ds.PatientName = _resolve_patient_name(meta)
    ds.PatientID = str(meta.get("patient_id") or "")
    ds.PatientBirthDate = _norm_date(meta.get("patient_birthdate"))
    ds.PatientSex = str(meta.get("patient_sex") or "")
    # A fresh UID when the identity carried none — never blank and never a
    # constant. The attribute is Type 1, and any fixed stand-in would collect
    # every identity-less import on the receiver into one ever-growing study.
    ds.StudyInstanceUID = str(meta.get("study_uid") or "") or generate_uid()
    ds.StudyDate = _norm_date(meta.get("study_date"))
    ds.StudyTime = ""
    ds.AccessionNumber = str(meta.get("accession") or "")
    ds.StudyID = str(meta.get("study_id") or "")
    ds.StudyDescription = str(meta.get("study_desc") or "")
    ds.ReferringPhysicianName = str(meta.get("referring") or "")

    # Series — always a NEW series so it slots beside the study's imaging series
    ds.SeriesInstanceUID = generate_uid()
    ds.SeriesNumber = "999"
    ds.InstanceNumber = "1"
    ds.SeriesDescription = str(meta.get("series_desc") or "")
    return ds


def build_encapsulated_pdf(pdf_bytes: bytes, meta: dict):
    """Wrap raw PDF bytes in an Encapsulated PDF Storage instance (verbatim, so
    the document stays selectable/searchable in a viewer)."""
    from pydicom.uid import EncapsulatedPDFStorage

    ds = _base_dataset(EncapsulatedPDFStorage, meta)
    ds.Modality = "DOC"
    ds.ConversionType = "WSD"                        # Workstation
    ds.BurnedInAnnotation = "NO"
    ds.SeriesDescription = ds.SeriesDescription or "Encapsulated PDF"
    ds.DocumentTitle = str(meta.get("series_desc") or meta.get("study_desc") or "PDF document")
    ds.MIMETypeOfEncapsulatedDocument = "application/pdf"
    if len(pdf_bytes) % 2:                           # OB must be even length
        pdf_bytes = pdf_bytes + b"\x00"
    ds.EncapsulatedDocument = pdf_bytes
    return ds


def build_secondary_capture(img_bytes: bytes, meta: dict):
    """Decode an image (PIL) and store it as an uncompressed Secondary Capture."""
    import io

    from PIL import Image
    from pydicom.uid import SecondaryCaptureImageStorage

    with Image.open(io.BytesIO(img_bytes)) as im:
        im.load()
        # The convert() calls are not cosmetic. tobytes() hands back whatever
        # the source mode packs — one byte per pixel for a palette image, four
        # for RGBA — while the header below states SamplesPerPixel and
        # PhotometricInterpretation as fact. Normalising to L or RGB first is
        # what keeps that statement and the bytes describing the same picture.
        # A mismatch is not rejected anywhere: the object is stored, forwarded
        # and opened, and renders as skewed garbage.
        if im.mode in ("L", "I;16", "1"):
            im = im.convert("L")
            samples, photometric = 1, "MONOCHROME2"
        else:
            im = im.convert("RGB")
            samples, photometric = 3, "RGB"
        cols, rows = im.size
        pixels = im.tobytes()

    ds = _base_dataset(SecondaryCaptureImageStorage, meta)
    ds.Modality = "OT"                              # Other
    ds.ConversionType = "WSD"
    ds.SeriesDescription = ds.SeriesDescription or "Imported image"
    ds.SamplesPerPixel = samples
    ds.PhotometricInterpretation = photometric
    if samples == 3:
        ds.PlanarConfiguration = 0                  # pixel-interleaved (RGBRGB…)
    ds.Rows = rows
    ds.Columns = cols
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    if len(pixels) % 2:
        pixels = pixels + b"\x00"
    ds.PixelData = pixels
    return ds


def build_from_bytes(data: bytes, kind: str, meta: dict):
    if kind == "pdf":
        return build_encapsulated_pdf(data, meta)
    if kind == "image":
        return build_secondary_capture(data, meta)
    raise ValueError(f"don't know how to convert kind={kind!r}")


def save_instance(ds, out_dir: str) -> str:
    """Write *ds* into *out_dir* as ``<SOPInstanceUID>.dcm`` and return the path."""
    # Written in place rather than to a temp name and renamed. The filename is
    # the UID _base_dataset generated moments ago, so it cannot collide with a
    # file already there and cannot overwrite one; and the only consumer that
    # watches a destination folder — the auto-send watcher on the outgoing
    # folder — refuses to forward a file until its size has held steady across
    # two polls, so a half-written instance is skipped rather than sent.
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"{ds.SOPInstanceUID}.dcm")
    save_dicom(ds, out)
    return out


# ------------------------------------------------------------- pending store
# Layout:  <pending_dir>/<id>/<original filename>   +   <pending_dir>/<id>/meta.json
def _safe_entry_dir(pending_dir: str, pid: str) -> str:
    """Resolve a pending id to its folder, refusing anything that escapes root."""
    # The id arrives from a query string. Rejecting the root itself is the half
    # that is easy to leave out: an empty id, "." and "anything/.." all resolve
    # to the pending folder, and discard_pending would then hand the entire
    # review queue to shutil.rmtree.
    base = os.path.realpath(pending_dir)
    entry = os.path.realpath(os.path.join(pending_dir, pid))
    if entry == base or not entry.startswith(base + os.sep):
        raise ValueError("invalid pending id")
    return entry


def stage_pending(pending_dir: str, src: str, identity: dict, kind: str) -> str:
    """Move *src* into the pending store with an identity sidecar; return its id."""
    pid = uuid.uuid4().hex
    entry = os.path.join(pending_dir, pid)
    os.makedirs(entry, exist_ok=True)
    fname = os.path.basename(src)
    dst = os.path.join(entry, fname)
    # Move first, sidecar second. The move is what takes the file out of the
    # folder it was found in, so the watcher's next poll cannot queue the same
    # report into a second entry. A crash in the gap between the two leaves a
    # folder with no meta.json, which _load_entry refuses — the file is still on
    # disk and recoverable, and the review queue never lists an item it cannot
    # then open.
    shutil.move(src, dst)
    try:
        size = os.path.getsize(dst)
        staged_at = os.path.getmtime(dst)
    except OSError:
        size, staged_at = 0, 0.0
    meta = {
        "id": pid,
        "filename": fname,
        "kind": kind,
        "size": size,
        "staged_at": staged_at,
        "patient": identity.get("patient", ""),
        "patient_name": identity.get("patient_name", ""),
        "patient_id": identity.get("patient_id", ""),
        "study_uid": identity.get("study_uid", ""),
        "study_date": identity.get("study_date", ""),
        "study_desc": identity.get("study_desc", ""),
        "series_desc": identity.get("series_desc", ""),
        "accession": identity.get("accession", ""),
        "source": identity.get("source", ""),
    }
    with open(os.path.join(entry, META_NAME), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    return pid


def _load_entry(entry: str) -> dict | None:
    """The entry's metadata plus a '_path' handle, or None if it is not whole.

    An entry is real only when the sidecar parses AND the file it names is
    there. A half-staged folder, a sidecar caught mid-write and an item whose
    file was removed underneath us all read as absent rather than as an error,
    which is what lets list_pending skip one broken entry instead of taking the
    whole review queue off the dashboard with it.
    """
    try:
        with open(os.path.join(entry, META_NAME), "r", encoding="utf-8") as fh:
            meta = json.load(fh)
    except (OSError, ValueError):
        return None
    fname = meta.get("filename") or ""
    fpath = os.path.join(entry, fname)
    if not fname or not os.path.isfile(fpath):
        return None
    meta["_path"] = fpath
    return meta


def list_pending(pending_dir: str) -> list[dict]:
    """Every reviewable item in the store (newest first); '_path' is stripped."""
    if not pending_dir or not os.path.isdir(pending_dir):
        return []
    out = []
    for name in os.listdir(pending_dir):
        entry = os.path.join(pending_dir, name)
        if name.startswith(".") or not os.path.isdir(entry):
            continue
        meta = _load_entry(entry)
        if meta:
            meta.pop("_path", None)
            out.append(meta)
    out.sort(key=lambda m: m.get("staged_at", 0), reverse=True)
    return out


def count_pending(pending_dir: str) -> int:
    return len(list_pending(pending_dir))


def preview_path(pending_dir: str, pid: str) -> tuple[str, str] | None:
    """(folder, filename) of a pending item's raw file, for serving a preview."""
    entry = _safe_entry_dir(pending_dir, pid)
    meta = _load_entry(entry)
    if not meta:
        return None
    return entry, meta["filename"]


def approve_pending(pending_dir: str, pid: str, edits: dict, out_dir: str) -> str:
    """Convert a pending item to DICOM in *out_dir* (the watch folder, so the
    normal send+archive pipeline carries it), then remove the pending entry."""
    entry = _safe_entry_dir(pending_dir, pid)
    meta = _load_entry(entry)
    if not meta:
        raise ValueError("pending item not found")
    # Identity the operator corrected wins over the identity that was pre-filled
    # from a sibling header. The KIND does not: it is the sidecar's, decided when
    # the item was staged, so nothing coming back from a review form can talk the
    # converter into handing a PDF to the image path.
    build_meta = {**meta, **(edits or {})}
    with open(meta["_path"], "rb") as fh:
        data = fh.read()
    ds = build_from_bytes(data, meta["kind"], build_meta)
    out = save_instance(ds, out_dir)
    # The entry is destroyed only once the instance is on disk. Everything that
    # can fail above — an unreadable file, an image PIL will not decode, a full
    # volume — fails with the item still queued for review. The other order
    # trades an operator's only copy of a report for a traceback.
    shutil.rmtree(entry, ignore_errors=True)
    return out


def discard_pending(pending_dir: str, pid: str) -> bool:
    entry = _safe_entry_dir(pending_dir, pid)
    if not os.path.isdir(entry):
        return False
    shutil.rmtree(entry, ignore_errors=True)
    return True
