"""DICOMweb (PS3.18) — QIDO-RS, WADO-RS and STOW-RS as a Flask blueprint.

This is the cheap half of "make Carino visible to modern viewers": OHIF, Weasis
and friends speak HTTP to /dicom-web and never negotiate a DIMSE association.
Queries are answered from the sqlite instance index (``pacs.index``), retrievals
stream files straight off disk, and stores go through the *same* filing that a
C-STORE uses so a study posted by a viewer is indistinguishable from one pushed
by a modality.

Deliberately NOT implemented, because a half-working viewer is worse than an
absent feature: /rendered (needs a codec + windowing pipeline), /thumbnail,
bulkdata URIs, and transcoding between transfer syntaxes. Anything we cannot
produce is answered 406, never faked.
"""

from __future__ import annotations

import inspect
import io
import json
import os
import re
import threading
import time
import uuid
from typing import Any, Iterator, Optional

from flask import Blueprint, Response, request
from werkzeug.exceptions import RequestEntityTooLarge
from pydicom import dcmread
from pydicom.datadict import keyword_for_tag, tag_for_keyword
from pydicom.dataset import Dataset

from .dicomfs import safe_within
from .scp import dest_path

URL_PREFIX = "/dicom-web"

# Hard ceiling on a QIDO page. A viewer asking for the instances of a 3000-image
# CT must get all of them, so this is generous rather than tidy; past it the
# response carries a Warning header saying it was truncated (silently short
# results are how viewers end up displaying half a study).
_QIDO_MAX = 5000

# includefield beyond what the index stores costs one header read per row, so it
# is capped separately from the row limit.
_HEADER_READ_MAX = 500

# STOW bodies are parsed in memory (multipart/related cannot be streamed without
# a parser far larger than this module), so the read itself is capped here — see
# stow(). Generous: a whole CT study arrives in one POST from some viewers.
_STOW_MAX_BYTES = 1024 * 1024 * 1024

_CHUNK = 256 * 1024

# Binary values above this are dropped from metadata responses rather than
# base64'd into them: there is no bulkdata endpoint to point a BulkDataURI at,
# and a multi-megabyte InlineBinary would break every client that asked for
# "metadata". Omission is legal; a broken response is not.
_INLINE_BULK_MAX = 8192

_JSON_CT = "application/dicom+json"

# pydicom 3 renamed the "write a proper Part 10 file" switch. Resolved once so
# the store path neither warns per instance nor breaks on either major version.
_SAVE_KW = ({"enforce_file_format": True}
            if "enforce_file_format" in inspect.signature(Dataset.save_as).parameters
            else {"write_like_original": False})

_UNCOMPRESSED_TS = {
    "1.2.840.10008.1.2",        # Implicit VR LE
    "1.2.840.10008.1.2.1",      # Explicit VR LE
    "1.2.840.10008.1.2.1.99",   # Deflated Explicit VR LE
    "1.2.840.10008.1.2.2",      # Explicit VR BE
}

# PS3.18 Table 8.7.3-5: encapsulated pixel data is handed back as-stored under
# the media type of its encoding. We never transcode, so this map is the whole
# of our frame-format support.
_TS_MEDIA = {
    "1.2.840.10008.1.2.4.50": "image/jpeg",
    "1.2.840.10008.1.2.4.51": "image/jpeg",
    "1.2.840.10008.1.2.4.57": "image/jpeg",
    "1.2.840.10008.1.2.4.70": "image/jpeg",
    "1.2.840.10008.1.2.4.80": "image/jls",
    "1.2.840.10008.1.2.4.81": "image/jls",
    "1.2.840.10008.1.2.4.90": "image/jp2",
    "1.2.840.10008.1.2.4.91": "image/jp2",
    "1.2.840.10008.1.2.4.92": "image/jpx",
    "1.2.840.10008.1.2.4.93": "image/jpx",
    "1.2.840.10008.1.2.4.201": "image/jphc",
    "1.2.840.10008.1.2.4.202": "image/jphc",
    "1.2.840.10008.1.2.4.203": "image/jphc",
    "1.2.840.10008.1.2.5": "image/dicom-rle",
}

# Matching keys the index can actually answer (mirrors index._FIELDS). Anything
# else a client sends is reported back in a Warning header instead of being
# quietly ignored — a filter that does nothing returns too MANY studies, which
# looks like the query worked.
_MATCHABLE = {
    "StudyInstanceUID", "PatientID", "PatientName", "StudyDate", "StudyTime",
    "AccessionNumber", "StudyDescription", "SeriesInstanceUID", "Modality",
    "ModalitiesInStudy", "SeriesNumber", "SeriesDescription", "SOPInstanceUID",
    "SOPClassUID", "SOPClassesInStudy", "InstanceNumber", "TransferSyntaxUID",
}

_RESERVED_PARAMS = {"limit", "offset", "includefield", "fuzzymatching", "orderby",
                    "_", "accept"}

# PS3.18 Table 10.6.1-5 requires these in every QIDO response at their level, and
# the index has no column for any of them (it stores what DIMSE matching needs).
# They go out zero-length rather than absent: an empty value is the standard's way
# of saying "we hold no value for this", while an absent required attribute is
# indistinguishable from a server that does not implement it, and viewers that key
# on the presence of, say, Rows read the whole row as malformed. includefield=all
# replaces them with the real values off the instance header — always reading the
# header would turn a 3000-instance query into 3000 file opens.
_REQUIRED_BLANK = {
    "study": ("ReferringPhysicianName", "PatientBirthDate", "PatientSex",
              "StudyID", "TimezoneOffsetFromUTC"),
    "series": ("TimezoneOffsetFromUTC", "PerformedProcedureStepStartDate",
               "PerformedProcedureStepStartTime", "RequestAttributesSequence"),
    "instance": ("TimezoneOffsetFromUTC", "Rows", "Columns", "BitsAllocated",
                 "NumberOfFrames"),
}

# includefield=all: attributes worth reading off the representative instance's
# header, per level. Kept to the level's own modules so a study result never
# grows instance-specific attributes it cannot speak for.
_EXTRA_ALL = {
    "study": ("PatientBirthDate", "PatientSex", "PatientAge", "IssuerOfPatientID",
              "ReferringPhysicianName", "StudyID", "InstitutionName"),
    "series": ("SeriesDate", "SeriesTime", "BodyPartExamined", "Laterality",
               "ProtocolName", "PatientPosition", "Manufacturer",
               "ManufacturerModelName", "StationName",
               "PerformedProcedureStepStartDate", "PerformedProcedureStepStartTime"),
    "instance": ("Rows", "Columns", "BitsAllocated", "BitsStored", "HighBit",
                 "PixelRepresentation", "SamplesPerPixel", "PhotometricInterpretation",
                 "NumberOfFrames", "ContentDate", "ContentTime", "ImageType",
                 "AcquisitionNumber", "SliceThickness", "SliceLocation",
                 "ImagePositionPatient", "ImageOrientationPatient", "PixelSpacing",
                 "WindowCenter", "WindowWidth", "RescaleIntercept", "RescaleSlope"),
}

_HEX8 = re.compile(r"^[0-9A-Fa-f]{8}$")
_KEYWORD = re.compile(r"^[A-Za-z][A-Za-z0-9]*$")


class DicomWebStats:
    """Counters for the dashboard. Not persisted — they describe this process."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.started_at = time.time()
        self.queries = 0
        self.retrieved = 0      # instances handed to a WADO client
        self.stored = 0         # instances accepted by STOW
        self.failed = 0         # instances STOW refused
        self.errors = 0

    def bump(self, field: str, n: int = 1) -> None:
        with self._lock:
            setattr(self, field, getattr(self, field) + n)

    def snapshot(self) -> dict:
        with self._lock:
            return {"since": int(self.started_at), "queries": self.queries,
                    "retrieved": self.retrieved, "stored": self.stored,
                    "failed": self.failed, "errors": self.errors}


# --------------------------------------------------------------- content types
def _split_outside_quotes(value: str, sep: str) -> list[str]:
    """Split on *sep* but not inside a quoted string — `type="a/b, c"` is one
    parameter, and a naive split on ',' would turn it into two media ranges."""
    out, buf, quoted = [], [], False
    for ch in value:
        if ch == '"':
            quoted = not quoted
        if ch == sep and not quoted:
            out.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    out.append("".join(buf))
    return [s.strip() for s in out if s.strip()]


def _params(bits: list[str]) -> dict:
    p = {}
    for bit in bits:
        k, _, v = bit.partition("=")
        p[k.strip().lower()] = v.strip().strip('"')
    return p


def _media_ranges(header: str) -> list[tuple[str, dict, float]]:
    """Accept header -> [(mime, params, q)] best first. An empty header means
    "anything", which every caller here treats as "our default"."""
    out: list[tuple[str, dict, float]] = []
    for item in _split_outside_quotes(header or "", ","):
        bits = _split_outside_quotes(item, ";")
        if not bits:
            continue
        p = _params(bits[1:])
        try:
            q = float(p.get("q", "1"))
        except ValueError:
            q = 1.0
        out.append((bits[0].strip().lower(), p, q))
    out.sort(key=lambda r: -r[2])
    return out


def _accepts_json(header: str) -> bool:
    ranges = _media_ranges(header)
    if not ranges:
        return True
    for mime, _p, q in ranges:
        if q <= 0:
            continue
        if mime in ("*/*", "application/*", "application/json", _JSON_CT):
            return True
    return False


def _accepts_dicom_parts(header: str) -> tuple[bool, Optional[str]]:
    """(acceptable, requested transfer syntax). A specific transfer-syntax that
    is not the one on disk is a 406: we store what we were given and never
    transcode, so pretending otherwise would hand back mislabelled pixels."""
    ranges = _media_ranges(header)
    if not ranges:
        return True, None
    for mime, p, q in ranges:
        if q <= 0:
            continue
        if mime in ("*/*", "multipart/*"):
            return True, None
        if mime == "multipart/related":
            t = (p.get("type") or "").lower()
            if t in ("", "application/dicom"):
                ts = p.get("transfer-syntax") or None
                return True, (None if ts == "*" else ts)
    return False, None


def _accepts_frames(header: str, media: str) -> bool:
    ranges = _media_ranges(header)
    if not ranges:
        return True
    for mime, p, q in ranges:
        if q <= 0:
            continue
        if mime in ("*/*", "multipart/*"):
            return True
        if mime == "multipart/related":
            t = (p.get("type") or "").lower()
            if t in ("", media):
                return True
    return False


# --------------------------------------------------------------- DICOM JSON
def _clean_bulk(ds: Dataset) -> None:
    """Drop bulk values a metadata response cannot carry (see _INLINE_BULK_MAX).
    Recurses into sequences because that is exactly where icon images and
    private blobs hide."""
    for elem in list(ds):
        if elem.VR == "SQ":
            for item in (elem.value or []):
                _clean_bulk(item)
            continue
        val = elem.value
        if isinstance(val, (bytes, bytearray, memoryview)) and len(val) > _INLINE_BULK_MAX:
            del ds[elem.tag]


def _no_empty_values(obj: dict) -> dict:
    """Drop the ``"Value": []`` members pydicom exports for empty attributes.

    PS3.18 F.2.5 is explicit that an attribute we hold no value for carries no
    "Value", "InlineBinary" or "BulkDataURI" member at all — an empty array is a
    third thing, and a strict reader is entitled to reject it. Every zero-length
    attribute this module writes by hand is already encoded that way; pydicom's
    JSON export is what reintroduces the empty list, for empty sequences (the
    RequestAttributesSequence placeholder in _REQUIRED_BLANK) and for any empty
    multi-value that came off a file. Doing it here rather than at the one known
    site covers QIDO at all three levels and WADO metadata, which is where the
    sequences a modality actually sent empty turn up.
    """
    for entry in obj.values():
        if not isinstance(entry, dict):
            continue
        value = entry.get("Value")
        if isinstance(value, list) and not value:
            del entry["Value"]
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, dict):        # sequence item: recurse
                    _no_empty_values(item)
    return obj


def _to_json(ds: Dataset) -> dict:
    _clean_bulk(ds)
    return _no_empty_values(ds.to_json_dict())


def _warning_header(warnings: list[str]) -> str:
    """RFC 7234 warn-text. The strip is not cosmetic: warnings quote query
    parameters the client chose, and a quote or a newline in one of those would
    forge a header."""
    safe = ("".join(ch for ch in w if ch.isprintable() and ch != '"')[:120] for w in warnings)
    return ", ".join(f'299 carino-pacs "{w}"' for w in safe)


def _json_response(payload: Any, status: int = 200, warnings: Optional[list[str]] = None) -> Response:
    resp = Response(json.dumps(payload), status=status, mimetype=_JSON_CT)
    if warnings:
        resp.headers["Warning"] = _warning_header(warnings)
    return resp


def _error(status: int, message: str) -> Response:
    return Response(json.dumps({"error": message}), status=status,
                    mimetype="application/json")


def _set(ds: Dataset, keyword: str, value: Any) -> None:
    """Set an attribute, tolerating a value the dictionary considers malformed.

    Files in the wild carry over-long SH values and junk IS values; a query must
    still return the study (with the attribute dropped) rather than 500."""
    try:
        setattr(ds, keyword, value)
    except Exception:
        pass


def _blank(ds: Dataset, level: str) -> None:
    """Seed the level's required returns as zero-length (see _REQUIRED_BLANK).

    Called before the values we do have, so anything the index can source simply
    overwrites its own placeholder."""
    for kw in _REQUIRED_BLANK.get(level, ()):
        _set(ds, kw, None)


# --------------------------------------------------------------- QIDO parsing
def _to_keyword(name: str) -> Optional[str]:
    """QIDO matching key -> DICOM keyword. Accepts keywords and 8-hex tags;
    sequence paths ("0040A730.00080100") are not indexed, so they return None
    and are reported as unsupported."""
    n = (name or "").strip()
    if _HEX8.match(n):
        return keyword_for_tag(int(n, 16)) or None
    if _KEYWORD.match(n) and tag_for_keyword(n):
        return n
    return None


def _parse_filters(args) -> tuple[dict, list[str]]:
    filters: dict = {}
    warns: list[str] = []
    for raw_key in args.keys():
        if raw_key.lower() in _RESERVED_PARAMS:
            continue
        kw = _to_keyword(raw_key)
        values = [v for v in args.getlist(raw_key) if v != ""]
        if kw is None:
            warns.append(f"unsupported query parameter '{raw_key}' was ignored")
            continue
        if kw not in _MATCHABLE:
            warns.append(f"matching on {kw} is not supported and was ignored")
            continue
        if not values:
            continue        # universal match: nothing to add
        filters[kw] = values if len(values) > 1 else values[0]
    if str(args.get("fuzzymatching", "")).lower() == "true":
        warns.append("fuzzymatching is not supported; exact/wildcard matching was used")
    return filters, warns


def _parse_include(args, level: str) -> tuple[list[str], bool]:
    """(extra keywords, wants_all). Values may repeat and may be comma-joined."""
    wants_all = False
    out: list[str] = []
    for raw in args.getlist("includefield"):
        for item in raw.split(","):
            item = item.strip()
            if not item:
                continue
            if item.lower() == "all":
                wants_all = True
                continue
            kw = _to_keyword(item)
            if kw:
                out.append(kw)
    if wants_all:
        out.extend(_EXTRA_ALL.get(level, ()))
    # Deduplicate, keep order.
    seen, ordered = set(), []
    for kw in out:
        if kw not in seen:
            seen.add(kw)
            ordered.append(kw)
    return ordered, wants_all


def _parse_paging(args) -> tuple[int, int, list[str]]:
    warns: list[str] = []
    try:
        limit = int(args.get("limit", _QIDO_MAX))
    except ValueError:
        limit = _QIDO_MAX
        warns.append("limit was not a number; the server default was used")
    try:
        offset = max(0, int(args.get("offset", 0)))
    except ValueError:
        offset = 0
        warns.append("offset was not a number; 0 was used")
    if limit <= 0 or limit > _QIDO_MAX:
        if limit > _QIDO_MAX:
            warns.append(f"limit capped at {_QIDO_MAX}")
        limit = _QIDO_MAX
    return limit, offset, warns


# --------------------------------------------------------------- multipart out
def _multipart_headers(boundary: str, content_type: str) -> bytes:
    return (f"--{boundary}\r\nContent-Type: {content_type}\r\n\r\n").encode("ascii")


def _stream_parts(parts: list[tuple[str, str]], boundary: str, log, stats) -> Iterator[bytes]:
    """Yield a multipart/related body, one file per part, read in chunks.

    Deliberately no per-part Content-Length: the length would have to be stat'ed
    before the read, and a file that changed size in between would corrupt the
    stream. Boundaries alone delimit the parts, which is what the standard
    requires anyway.
    """
    for path, content_type in parts:
        yield _multipart_headers(boundary, content_type)
        try:
            with open(path, "rb") as fh:
                while True:
                    chunk = fh.read(_CHUNK)
                    if not chunk:
                        break
                    yield chunk
        except OSError as exc:
            # Aborting mid-body leaves the client with an unterminated multipart,
            # which is exactly right: it must fail loudly, not silently receive a
            # study with an image missing.
            stats.bump("errors")
            log.error(f"DICOMweb retrieve aborted — could not read {path}: {exc}", kind="dicomweb")
            raise
        yield b"\r\n"
        stats.bump("retrieved")
    yield f"--{boundary}--\r\n".encode("ascii")


def _multipart_response(parts: list[tuple[str, str]], part_type: str, status: int,
                        log, stats) -> Response:
    boundary = uuid.uuid4().hex
    body = _stream_parts(parts, boundary, log, stats)
    ct = f'multipart/related; type="{part_type}"; boundary={boundary}'
    return Response(body, status=status, mimetype=None, content_type=ct)


# --------------------------------------------------------------- multipart in
def _parse_multipart_related(body: bytes, boundary: bytes) -> list[tuple[dict, bytes]]:
    """Parse a multipart/related body into [(headers, content)].

    Werkzeug only parses multipart/form-data, so this is ours. Strictly CRLF, per
    RFC 2046: a lenient parser would have to normalise line endings, and the
    parts here are binary DICOM where a rewritten 0x0A is a corrupted image.
    """
    parts: list[tuple[dict, bytes]] = []
    sep = b"\r\n--" + boundary
    data = b"\r\n" + body          # so the opening boundary matches the same shape
    pos = data.find(sep)
    while pos != -1:
        cursor = pos + len(sep)
        if data[cursor:cursor + 2] == b"--":
            break                  # closing boundary
        eol = data.find(b"\r\n", cursor)
        if eol == -1:
            break
        cursor = eol + 2
        if data[cursor:cursor + 2] == b"\r\n":
            headers, cursor = {}, cursor + 2
        else:
            end = data.find(b"\r\n\r\n", cursor)
            if end == -1:
                break
            headers = {}
            for line in data[cursor:end].split(b"\r\n"):
                k, _, v = line.partition(b":")
                if v:
                    headers[k.decode("latin-1").strip().lower()] = v.decode("latin-1").strip()
            cursor = end + 4
        nxt = data.find(sep, cursor)
        if nxt == -1:
            break
        parts.append((headers, data[cursor:nxt]))
        pos = nxt
    return parts


def _boundary_of(content_type: str) -> tuple[Optional[bytes], str]:
    """(boundary, declared part type) from a multipart/related Content-Type."""
    bits = _split_outside_quotes(content_type or "", ";")
    if not bits or bits[0].strip().lower() != "multipart/related":
        return None, ""
    p = _params(bits[1:])
    b = p.get("boundary") or ""
    return (b.encode("latin-1") if b else None), (p.get("type") or "").lower()


# --------------------------------------------------------------- storage
def store_instance(server, ds: Dataset, source: str = "STOW-RS") -> str:
    """File one instance exactly as a C-STORE would and return its path.

    Same layout function (``scp.dest_path``), same storage root, same free-space
    floor, same ``_reconcile_study`` callback the receiver fires — so RIS
    matching, emergency hold-and-forward and indexing all behave identically no
    matter which protocol carried the image. Raises OSError on a refusal or a
    write failure; the caller turns that into a FailedSOPSequence entry.
    """
    cfg = server.cfg
    root = cfg.resolved("scp", "storage_dir")
    min_free_mb = int(float(cfg.scp.get("min_free_gb", 2) or 0) * 1024)
    if not _space_ok(root, min_free_mb):
        raise OSError(f"storage volume below the {min_free_mb} MB free-space floor")

    path = dest_path(root, ds, bool(cfg.scp.get("organize", True)))
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    ds.save_as(path, **_SAVE_KW)

    # The index is written synchronously here, unlike the C-STORE path's queued
    # write: a STOW client routinely queries for what it just posted, and a
    # background write would make that round trip a race. It is an upsert keyed
    # on the path, so the queued write that _reconcile_study may also schedule is
    # harmless.
    index = getattr(server, "index", None)
    if index is not None:
        try:
            index.add_dataset(ds, path, "received")
        except Exception as exc:
            server.log.warn(f"{source}: stored {os.path.basename(path)} but could not index it: {exc}",
                            kind="dicomweb")

    reconcile = getattr(server, "_reconcile_study", None)
    if reconcile is not None:
        try:
            reconcile(ds, path)
        except Exception:
            pass        # the image is on disk; order matching is never worth losing it

    server.log.info(
        f"Stored {getattr(ds, 'Modality', '?')} {os.path.basename(path)} "
        f"via {source} from {request.remote_addr or '?'}",
        kind="store", path=path,
    )
    return path


def _space_ok(storage_dir: str, min_free_mb: int) -> bool:
    """Mirrors StorageSCP's disk guard: refuse before writing rather than leave a
    half-written object. Fails open when the volume can't be probed."""
    if min_free_mb <= 0:
        return True
    import shutil
    try:
        probe = storage_dir if os.path.isdir(storage_dir) else (os.path.dirname(storage_dir) or ".")
        return int(shutil.disk_usage(probe).free // (1024 * 1024)) >= min_free_mb
    except OSError:
        return True


# --------------------------------------------------------------- frames
def _frame_media(ts: str) -> Optional[str]:
    if ts in _UNCOMPRESSED_TS:
        return "application/octet-stream"
    return _TS_MEDIA.get(ts)


def _uncompressed_frames(ds: Dataset, wanted: list[int]) -> list[bytes]:
    rows = int(getattr(ds, "Rows", 0) or 0)
    cols = int(getattr(ds, "Columns", 0) or 0)
    samples = int(getattr(ds, "SamplesPerPixel", 1) or 1)
    bits = int(getattr(ds, "BitsAllocated", 8) or 8)
    total = int(getattr(ds, "NumberOfFrames", 1) or 1)
    px = ds.get("PixelData")
    if not rows or not cols or px is None:
        raise ValueError("instance has no pixel data")
    pixels = bytes(px.value if hasattr(px, "value") else px)
    if bits == 1:
        # Bit-packed frames run into each other with no byte padding, so a frame
        # can start mid-byte. Slicing that correctly means re-packing, which is
        # image processing, not retrieval — refuse instead of returning a shifted
        # image that looks plausible.
        raise ValueError("single-bit pixel data cannot be split into frames")
    size = rows * cols * samples * (bits // 8)
    out = []
    for n in wanted:
        if n < 1 or n > total:
            raise IndexError(f"frame {n} is out of range (1-{total})")
        start = (n - 1) * size
        frame = pixels[start:start + size]
        if len(frame) != size:
            raise ValueError(f"frame {n} is truncated in the stored file")
        out.append(frame)
    return out


def _encapsulated_frames(ds: Dataset, wanted: list[int]) -> list[bytes]:
    """Encapsulated frames handed back byte-for-byte as stored — no decoding, so
    no codec dependency and no re-encoding loss."""
    from pydicom import encaps
    px = ds.get("PixelData")
    if px is None:
        raise ValueError("instance has no pixel data")
    raw = bytes(px.value if hasattr(px, "value") else px)
    total = int(getattr(ds, "NumberOfFrames", 1) or 1)
    for n in wanted:
        if n < 1 or n > total:
            raise IndexError(f"frame {n} is out of range (1-{total})")
    if hasattr(encaps, "get_frame"):          # pydicom >= 3
        return [encaps.get_frame(raw, n - 1, number_of_frames=total) for n in wanted]
    frames = list(encaps.generate_pixel_data_frame(raw, total))   # pydicom 2.x
    return [frames[n - 1] for n in wanted]


# --------------------------------------------------------------- blueprint
def create_blueprint(server) -> Blueprint:
    """The /dicom-web blueprint. *server* is the PacsServer (cfg, log, index)."""
    bp = Blueprint("dicomweb", __name__, url_prefix=URL_PREFIX)
    stats = DicomWebStats()
    bp.stats = stats                     # the dashboard reads this via status()

    def cfg():
        return server.cfg

    def index():
        idx = getattr(server, "index", None)
        if idx is None:
            raise RuntimeError("the instance index is not available")
        return idx

    def base_url() -> str:
        return request.url_root.rstrip("/") + URL_PREFIX

    def roots() -> list[str]:
        """Every folder we are allowed to serve a file from, resolved fresh so a
        config change takes effect without a restart.

        The outgoing watch folder is deliberately in the set. Files waiting there
        are indexed, so QIDO already lists them; dropping them from WADO would
        answer "here is your study" and hand back the copies that happen to have
        been forwarded already — an under-delivered study, which is the one
        failure mode this server does not get to have. Nothing extra is exposed
        either way: servable() only serves paths the index holds, and the index
        holds parsed DICOM files, not whatever else the folder contains.
        """
        c = cfg()
        return [c.resolved("scp", "storage_dir"), c.resolved("scu", "sent_dir"),
                c.resolved("scu", "watch_dir")]

    def servable(path: str) -> bool:
        """The index is a cache, not an authority: a poisoned or stale row must
        never talk us into reading outside the storage roots."""
        if not path:
            return False
        allowed = roots()
        return any(safe_within(r, path) for r in allowed) and os.path.isfile(path)

    # ---- gate + CORS ------------------------------------------------------
    @bp.before_request
    def _gate():
        if request.method == "OPTIONS":
            return None                  # preflight is answered even when disabled
        if not cfg().dicomweb.get("enabled", False):
            return _error(503, "DICOMweb is disabled (config: dicomweb.enabled)")
        if getattr(server, "index", None) is None:
            return _error(503, "the instance index is not available")
        return None

    def _allowed_origin() -> Optional[str]:
        """Exact-match against dicomweb.cors_origins. A wildcard would let any
        page the operator has open read their whole archive off localhost, so
        '*' is honoured only if the operator wrote it themselves."""
        origin = request.headers.get("Origin")
        if not origin:
            return None
        allowed = cfg().dicomweb.get("cors_origins") or []
        if not isinstance(allowed, list):
            return None
        allowed = [str(a).strip() for a in allowed]
        if origin in allowed:
            return origin
        return origin if "*" in allowed else None

    @bp.after_request
    def _cors(resp):
        origin = _allowed_origin()
        if origin:
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Access-Control-Allow-Private-Network"] = "true"
            resp.headers["Access-Control-Expose-Headers"] = "Content-Type, Warning"
            resp.headers["Vary"] = "Origin"
            if request.method == "OPTIONS":
                resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
                resp.headers["Access-Control-Allow-Headers"] = \
                    "Content-Type, Accept, Authorization, X-Carino, X-Carino-Token"
                resp.headers["Access-Control-Max-Age"] = "600"
        return resp

    # ---- QIDO-RS ----------------------------------------------------------
    def _header_extras(ds_out: Dataset, path: str, keywords: list[str]) -> None:
        if not keywords or not servable(path):
            return
        try:
            hdr = dcmread(path, stop_before_pixels=True)
        except Exception:
            return
        for kw in keywords:
            tag = tag_for_keyword(kw)
            if tag is None or tag not in hdr:
                continue
            try:
                ds_out[tag] = hdr[tag]
            except Exception:
                pass

    def _study_object(row: dict, extras: list[str], reads_left: list[int]) -> dict:
        ds = Dataset()
        _blank(ds, "study")
        _set(ds, "StudyInstanceUID", row.get("StudyInstanceUID", ""))
        _set(ds, "StudyDate", row.get("StudyDate", ""))
        _set(ds, "StudyTime", row.get("StudyTime", ""))
        _set(ds, "AccessionNumber", row.get("AccessionNumber", ""))
        _set(ds, "ModalitiesInStudy", row.get("ModalitiesInStudy") or [])
        _set(ds, "StudyDescription", row.get("StudyDescription", ""))
        _set(ds, "PatientName", row.get("PatientName", ""))
        _set(ds, "PatientID", row.get("PatientID", ""))
        _set(ds, "NumberOfStudyRelatedSeries", int(row.get("NumberOfStudyRelatedSeries", 0)))
        _set(ds, "NumberOfStudyRelatedInstances", int(row.get("NumberOfStudyRelatedInstances", 0)))
        _set(ds, "InstanceAvailability", "ONLINE")
        _set(ds, "RetrieveURL", f"{base_url()}/studies/{row.get('StudyInstanceUID', '')}")
        if extras and reads_left[0] > 0:
            rows = index().query_instances(study_uid=row.get("StudyInstanceUID"), limit=1)
            if rows:
                reads_left[0] -= 1
                _header_extras(ds, rows[0]["path"], extras)
        return _to_json(ds)

    def _series_object(row: dict, extras: list[str], reads_left: list[int]) -> dict:
        ds = Dataset()
        _blank(ds, "series")
        _set(ds, "StudyInstanceUID", row.get("StudyInstanceUID", ""))
        _set(ds, "SeriesInstanceUID", row.get("SeriesInstanceUID", ""))
        _set(ds, "Modality", row.get("Modality", ""))
        _set(ds, "SeriesNumber", row.get("SeriesNumber"))
        _set(ds, "SeriesDescription", row.get("SeriesDescription", ""))
        _set(ds, "NumberOfSeriesRelatedInstances", int(row.get("NumberOfSeriesRelatedInstances", 0)))
        _set(ds, "InstanceAvailability", "ONLINE")
        _set(ds, "RetrieveURL", f"{base_url()}/studies/{row.get('StudyInstanceUID', '')}"
                                f"/series/{row.get('SeriesInstanceUID', '')}")
        if extras and reads_left[0] > 0:
            rows = index().query_instances(series_uid=row.get("SeriesInstanceUID"), limit=1)
            if rows:
                reads_left[0] -= 1
                _header_extras(ds, rows[0]["path"], extras)
        return _to_json(ds)

    def _instance_object(row: dict, extras: list[str], reads_left: list[int]) -> dict:
        ds = Dataset()
        _blank(ds, "instance")
        _set(ds, "StudyInstanceUID", row.get("StudyInstanceUID", ""))
        _set(ds, "SeriesInstanceUID", row.get("SeriesInstanceUID", ""))
        _set(ds, "SOPInstanceUID", row.get("SOPInstanceUID", ""))
        _set(ds, "SOPClassUID", row.get("SOPClassUID", ""))
        _set(ds, "InstanceNumber", row.get("InstanceNumber"))
        _set(ds, "Modality", row.get("Modality", ""))
        _set(ds, "InstanceAvailability", "ONLINE")
        # 00083002, not the file-meta 00020010: this is the "what you would get
        # if you retrieved me" advertisement, which is what a viewer needs.
        _set(ds, "AvailableTransferSyntaxUID", row.get("TransferSyntaxUID", ""))
        _set(ds, "RetrieveURL", f"{base_url()}/studies/{row.get('StudyInstanceUID', '')}"
                                f"/series/{row.get('SeriesInstanceUID', '')}"
                                f"/instances/{row.get('SOPInstanceUID', '')}")
        if extras and reads_left[0] > 0:
            reads_left[0] -= 1
            _header_extras(ds, row.get("path", ""), extras)
        return _to_json(ds)

    def _qido(level: str, study_uid: Optional[str] = None, series_uid: Optional[str] = None):
        if not _accepts_json(request.headers.get("Accept", "")):
            return _error(406, "only application/dicom+json is available for QIDO-RS")
        filters, warns = _parse_filters(request.args)
        limit, offset, pw = _parse_paging(request.args)
        warns += pw
        extras, _wants_all = _parse_include(request.args, level)
        idx = index()
        try:
            if level == "study":
                rows = idx.query_studies(filters, limit=limit, offset=offset)
            elif level == "series":
                rows = idx.query_series(study_uid, filters, limit=limit, offset=offset)
            else:
                rows = idx.query_instances(study_uid, series_uid, filters,
                                           limit=limit, offset=offset)
        except Exception as exc:
            stats.bump("errors")
            server.log.error(f"DICOMweb query failed: {exc}", kind="dicomweb")
            return _error(500, f"query failed: {exc}")
        stats.bump("queries")
        if len(rows) >= limit:
            warns.append(f"result truncated at {limit}; use offset to page")
        reads_left = [_HEADER_READ_MAX]
        build = {"study": _study_object, "series": _series_object}.get(level, _instance_object)
        objs = []
        for row in rows:
            try:
                objs.append(build(row, extras, reads_left))
            except Exception as exc:
                # A single unrepresentable row must not blank the whole query;
                # emit its identity so the study is still retrievable and say so.
                stats.bump("errors")
                server.log.warn(f"DICOMweb: could not render a {level} result: {exc}", kind="dicomweb")
                objs.append({"0020000D": {"vr": "UI", "Value": [row.get("StudyInstanceUID", "")]}})
        if not objs:
            # PS3.18: no match is 204 with no body, NOT 200 with an empty array.
            resp = Response(status=204)
            if warns:
                resp.headers["Warning"] = _warning_header(warns)
            return resp
        return _json_response(objs, warnings=warns)

    @bp.get("/studies", strict_slashes=False)
    def qido_studies():
        return _qido("study")

    @bp.get("/studies/<study>/series", strict_slashes=False)
    def qido_study_series(study):
        return _qido("series", study_uid=study)

    @bp.get("/studies/<study>/series/<series>/instances", strict_slashes=False)
    def qido_series_instances(study, series):
        return _qido("instance", study_uid=study, series_uid=series)

    @bp.get("/studies/<study>/instances", strict_slashes=False)
    def qido_study_instances(study):
        return _qido("instance", study_uid=study)

    @bp.get("/series", strict_slashes=False)
    def qido_series():
        return _qido("series")

    @bp.get("/instances", strict_slashes=False)
    def qido_instances():
        return _qido("instance")

    # ---- WADO-RS retrieve -------------------------------------------------
    def _rows_for(study=None, series=None, sop=None) -> list[dict]:
        rows = index().query_instances(study_uid=study, series_uid=series,
                                       filters={"SOPInstanceUID": sop} if sop else None,
                                       limit=0)
        # The index orders instances by InstanceNumber alone, which at study level
        # interleaves the series: slice 1 of every series, then slice 2 of every
        # series. Nothing is lost — each part is a complete Part 10 object and a
        # viewer re-sorts after parsing — but viewers that render parts as they
        # arrive show a study assembling itself out of order for the whole
        # download. Series-then-instance costs one sort and makes the stream read
        # the way the study does. None sorts last, as in the index.
        def rank(v: Any) -> tuple:
            # Junk in a number column must not raise here: a TypeError mid-sort
            # would 500 a retrieve, which is a study not delivered.
            try:
                return (0, int(v))
            except (TypeError, ValueError):
                return (1, 0)

        def order(row: dict) -> tuple:
            return (rank(row.get("SeriesNumber")), row.get("SeriesInstanceUID") or "",
                    rank(row.get("InstanceNumber")), row.get("SOPInstanceUID") or "")
        return sorted(rows, key=order)

    def _retrieve(rows: list[dict], label: str):
        ok, wanted_ts = _accepts_dicom_parts(request.headers.get("Accept", ""))
        if not ok:
            return _error(406, 'only multipart/related; type="application/dicom" is available')
        if not rows:
            return _error(404, f"no instances found for {label}")
        parts, missing = [], 0
        for row in rows:
            path = row.get("path", "")
            ts = row.get("TransferSyntaxUID") or "1.2.840.10008.1.2.1"
            if wanted_ts and ts != wanted_ts:
                return _error(406, f"instances are stored as {ts}; this server does not transcode")
            if not servable(path):
                missing += 1
                server.log.warn(f"DICOMweb retrieve: {label} references a file that is gone "
                                f"or outside the storage folders ({path})", kind="dicomweb")
                continue
            parts.append((path, f'application/dicom; transfer-syntax={ts}'))
        if not parts:
            return _error(404, f"no readable instances for {label}")
        # 206 is the standard's way of saying "this is the study, minus what we
        # could not read" — better than a 200 that quietly under-delivers.
        return _multipart_response(parts, "application/dicom",
                                   206 if missing else 200, server.log, stats)

    @bp.get("/studies/<study>")
    def wado_study(study):
        return _retrieve(_rows_for(study=study), f"study {study}")

    @bp.get("/studies/<study>/series/<series>")
    def wado_series(study, series):
        return _retrieve(_rows_for(study=study, series=series), f"series {series}")

    @bp.get("/studies/<study>/series/<series>/instances/<sop>")
    def wado_instance(study, series, sop):
        return _retrieve(_rows_for(study=study, series=series, sop=sop), f"instance {sop}")

    # ---- WADO-RS metadata -------------------------------------------------
    def _metadata(rows: list[dict], label: str):
        if not _accepts_json(request.headers.get("Accept", "")):
            return _error(406, "only application/dicom+json metadata is available")
        if not rows:
            return _error(404, f"no instances found for {label}")
        out = []
        for row in rows:
            path = row.get("path", "")
            if not servable(path):
                continue
            try:
                ds = dcmread(path, stop_before_pixels=True)
            except Exception as exc:
                stats.bump("errors")
                server.log.warn(f"DICOMweb metadata: could not read {path}: {exc}", kind="dicomweb")
                continue
            obj = _to_json(ds)
            # Bulk data (pixels) is omitted, so the transfer syntax is the only
            # way a viewer can tell how the frames it fetches next are encoded.
            ts = getattr(getattr(ds, "file_meta", None), "TransferSyntaxUID", None)
            if ts:
                obj["00020010"] = {"vr": "UI", "Value": [str(ts)]}
            out.append(obj)
        if not out:
            return _error(404, f"no readable instances for {label}")
        return _json_response(out)

    @bp.get("/studies/<study>/metadata")
    def wado_study_metadata(study):
        return _metadata(_rows_for(study=study), f"study {study}")

    @bp.get("/studies/<study>/series/<series>/metadata")
    def wado_series_metadata(study, series):
        return _metadata(_rows_for(study=study, series=series), f"series {series}")

    @bp.get("/studies/<study>/series/<series>/instances/<sop>/metadata")
    def wado_instance_metadata(study, series, sop):
        return _metadata(_rows_for(study=study, series=series, sop=sop), f"instance {sop}")

    # ---- WADO-RS frames ---------------------------------------------------
    @bp.get("/studies/<study>/series/<series>/instances/<sop>/frames/<frames>")
    def wado_frames(study, series, sop, frames):
        try:
            wanted = [int(n) for n in frames.split(",") if n.strip()]
        except ValueError:
            return _error(400, "frame list must be comma-separated numbers")
        if not wanted:
            return _error(400, "no frames requested")
        rows = _rows_for(study=study, series=series, sop=sop)
        if not rows or not servable(rows[0].get("path", "")):
            return _error(404, f"instance {sop} not found")
        row = rows[0]
        ts = row.get("TransferSyntaxUID") or ""
        media = _frame_media(ts)
        if media is None:
            return _error(406, f"frames of {ts} instances are not served (no transcoding)")
        if not _accepts_frames(request.headers.get("Accept", ""), media):
            return _error(406, f'only multipart/related; type="{media}" is available for these frames')
        try:
            ds = dcmread(row["path"])
            data = (_uncompressed_frames(ds, wanted) if ts in _UNCOMPRESSED_TS
                    else _encapsulated_frames(ds, wanted))
        except IndexError as exc:
            return _error(404, str(exc))
        except Exception as exc:
            stats.bump("errors")
            server.log.warn(f"DICOMweb frames: {row['path']}: {exc}", kind="dicomweb")
            return _error(500, f"could not extract frames: {exc}")

        boundary = uuid.uuid4().hex
        ct = f'{media}; transfer-syntax={ts}' if media == "application/octet-stream" else media

        def gen():
            for frame in data:
                yield _multipart_headers(boundary, ct)
                yield frame
                yield b"\r\n"
            yield f"--{boundary}--\r\n".encode("ascii")

        stats.bump("retrieved")
        return Response(gen(), status=200,
                        content_type=f'multipart/related; type="{media}"; boundary={boundary}')

    # ---- STOW-RS ----------------------------------------------------------
    def _sop_ref(ds: Dataset, study_uid: str) -> dict:
        return {
            "00081150": {"vr": "UI", "Value": [str(getattr(ds, "SOPClassUID", "") or "")]},
            "00081155": {"vr": "UI", "Value": [str(getattr(ds, "SOPInstanceUID", "") or "")]},
            "00081190": {"vr": "UR", "Value": [
                f"{base_url()}/studies/{study_uid}"
                f"/series/{getattr(ds, 'SeriesInstanceUID', '')}"
                f"/instances/{getattr(ds, 'SOPInstanceUID', '')}"]},
        }

    def _fail(failed: list, other: list, ds: Optional[Dataset], reason: int) -> None:
        """File one failure into the sequence PS3.18 Annex I has for it.

        FailedSOPSequence items are SOP Instance References, where
        ReferencedSOPClassUID and ReferencedSOPInstanceUID are both Type 1 — so a
        part we could not parse, or one whose UIDs are missing, has nothing to put
        in an item there. Table I.1-1 gives OtherFailuresSequence (0008,119A) for
        exactly that: failures not associated with a specific SOP Instance, each
        item carrying the Failure Reason alone. Emitting a reference to the empty
        UID instead would be a malformed item AND a claim that some instance with
        no identity failed, which no client can act on.
        """
        cls = str(getattr(ds, "SOPClassUID", "") or "") if ds is not None else ""
        sop = str(getattr(ds, "SOPInstanceUID", "") or "") if ds is not None else ""
        if cls and sop:
            failed.append({
                "00081150": {"vr": "UI", "Value": [cls]},
                "00081155": {"vr": "UI", "Value": [sop]},
                "00081197": {"vr": "US", "Value": [reason]},
            })
        else:
            other.append({"00081197": {"vr": "US", "Value": [reason]}})

    @bp.post("/studies", strict_slashes=False)
    @bp.post("/studies/<study>")
    def stow(study: Optional[str] = None):
        if not cfg().dicomweb.get("allow_stow", True):
            return _error(403, "STOW-RS is disabled (config: dicomweb.allow_stow)")
        boundary, declared = _boundary_of(request.headers.get("Content-Type", ""))
        if boundary is None:
            return _error(415, 'STOW-RS requires multipart/related; type="application/dicom"')
        if declared and declared != "application/dicom":
            return _error(415, f"unsupported part type '{declared}'; only application/dicom is accepted")
        # Bound the READ, not the result. Content-Length is absent under
        # Transfer-Encoding: chunked, so a size check after get_data() is a check
        # on memory already committed — an unbounded chunked POST buffers until the
        # OOM killer takes this process, and with it the SCP, the forwarder and
        # every other DICOM service in it. Werkzeug enforces max_content_length
        # while reading, so it must be set before anything touches request.stream
        # (which caches the limited wrapper on first use).
        #
        # The extra byte is load-bearing: werkzeug stops the read AT the ceiling
        # and only raises on the next read, so a body of exactly the ceiling comes
        # back silently truncated. Reading one byte past the limit turns that into
        # a length we can test — a truncated multipart would otherwise parse into
        # fewer instances than the client sent and be answered 200.
        request.max_content_length = _STOW_MAX_BYTES + 1
        over = False
        try:
            body = request.get_data(cache=False)
        except RequestEntityTooLarge:
            body, over = b"", True          # a declared Content-Length over the ceiling
        if over or len(body) > _STOW_MAX_BYTES:
            server.log.warn(f"STOW-RS: refused a body over the "
                            f"{_STOW_MAX_BYTES // (1024 * 1024)} MB limit from "
                            f"{request.remote_addr or '?'}", kind="dicomweb")
            return _error(413, f"request larger than the {_STOW_MAX_BYTES // (1024 * 1024)} MB STOW limit")
        parts = _parse_multipart_related(body, boundary)
        if not parts:
            return _error(400, "no multipart/related parts found (CRLF boundaries are required)")

        stored: list[dict] = []
        failed: list[dict] = []
        other: list[dict] = []
        target = study or ""
        for headers, content in parts:
            ctype = (headers.get("content-type") or "application/dicom").split(";")[0].strip().lower()
            if ctype != "application/dicom":
                _fail(failed, other, None, 0x0122)          # SOP Class not supported
                continue
            try:
                ds = dcmread(io.BytesIO(content))
            except Exception as exc:
                stats.bump("failed")
                _fail(failed, other, None, 0xC000)          # cannot understand
                server.log.warn(f"STOW-RS: rejected an unreadable part: {exc}", kind="dicomweb")
                continue
            uid = str(getattr(ds, "StudyInstanceUID", "") or "")
            if target and uid != target:
                stats.bump("failed")
                _fail(failed, other, ds, 0x0110)            # processing failure
                server.log.warn(f"STOW-RS: instance belongs to study {uid}, "
                                f"not the requested {target}", kind="dicomweb")
                continue
            try:
                store_instance(server, ds, source="STOW-RS")
            except Exception as exc:
                stats.bump("failed")
                _fail(failed, other, ds, 0xA700 if isinstance(exc, OSError) else 0x0110)
                server.log.error(f"STOW-RS: could not store {getattr(ds, 'SOPInstanceUID', '?')}: {exc}",
                                 kind="dicomweb")
                continue
            stats.bump("stored")
            stored.append(_sop_ref(ds, uid or target))
            if not target:
                target = uid

        # RetrieveURL is Type 2 in Table I.1-1: it must be PRESENT, and may be
        # zero-length. So it always ships — but with no value when every part
        # failed and there is no study UID, because ".../studies/" would send a
        # client chasing a URL that cannot resolve. Zero-length says "no study to
        # retrieve" in the standard's own vocabulary; omitting it says "this
        # server does not implement the attribute", which is a different claim.
        payload: dict = {"00081190": {"vr": "UR"}}
        if target:
            payload["00081190"]["Value"] = [f"{base_url()}/studies/{target}"]
        if stored:
            payload["00081199"] = {"vr": "SQ", "Value": stored}
        if failed:
            payload["00081198"] = {"vr": "SQ", "Value": failed}
        if other:
            payload["0008119A"] = {"vr": "SQ", "Value": other}
        status = 200 if stored and not (failed or other) else (202 if stored else 409)
        return _json_response(payload, status=status)

    return bp
