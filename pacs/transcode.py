"""Transfer-syntax transcoding — the narrow, lossless-only kind.

Until this module the engine never converted anything: an instance left the way
it arrived, and a node or a viewer that would not take that encoding got a loud
refusal instead of an image. That is still the default and still how every
instance is STORED (pacs/scp.py files what it receives, byte for byte). What
changes is the way out, in three places and only on demand:

* the Storage SCU (scu.c_store) and the Q/R SCP's C-MOVE/C-GET sub-operations
  (qr.py) offer Explicit and Implicit VR Little Endian beside the stored syntax,
  and decompress an in-memory copy when the far side accepts only those;
* WADO-RS (dicomweb.py) honours ``transfer-syntax=`` in Accept instead of
  answering 406 for every syntax it did not happen to store;
* ``pacs transcode`` does the same to a file on the command line.

The rules are about not degrading a diagnostic image, and they are the whole
point of having a module rather than calling pydicom inline:

1. **Decompressing is always allowed.** Native pixels hold exactly what the
   decoder produced, so nothing is lost that was not already lost. When the
   source WAS lossy (JPEG Baseline, JPEG-LS Near-Lossless, irreversible JPEG
   2000/HTJ2K) the result keeps Lossy Image Compression (0028,2110) = "01" and
   carries the ratio (0028,2112) and method (0028,2114) forward, appending this
   step's when the header did not already record it — PS3.3 C.7.6.1.1.5 says
   the flag, once set, is never cleared, and a decompressed JPEG with no flag
   reads as an original to every viewer that shows one.
2. **Compressing is allowed only to a lossless syntax** — RLE Lossless, JPEG-LS
   Lossless, JPEG 2000 Lossless, and HTJ2K Lossless where an installed plugin
   can encode it. Never to a lossy one, whoever asks: a lossy encoding of an
   original is a clinical decision this appliance has no business making on a
   viewer's say-so, and a lossy encoding of an already-lossy image stacks a
   second generation of loss on a picture somebody may read a fracture off.
   Both are refused by name (:class:`TranscodeError` reason ``lossy_target``).
3. **Same SOP Instance UID.** A lossless transcode is the same image (PS3.4
   doesn't ask for a new UID for a change of transfer syntax, and every peer
   matching on the UID — the far PACS's duplicate check, a C-MOVE's failed
   list — has to see the instance it already knows). pydicom 3 generates a new
   UID by default in both compress() and decompress(); we turn that off.
   Every encode is decoded again and compared with the source pixels before it
   is handed out, so "lossless" is checked rather than assumed: a codec that
   lost a bit under a kept UID would be an undetectable substitution.
4. **Never the stored file.** Everything here works on an in-memory dataset;
   nothing in this module writes to disk (the CLI writes its own OUT).
5. **Bounded memory.** Decoding is refused above :data:`MAX_DECOMPRESSED_BYTES`
   and at most :data:`MAX_CONCURRENT` transcodes run at once — a WADO-RS client
   that asks for a whole 2 GB study in another syntax gets an answer, not an
   appliance that stopped answering.

Every codec is optional. pydicom finds the pylibjpeg plugins through their entry
points, Pillow covers 8-bit JPEG, and :func:`capabilities` asks pydicom once
which decoders and encoders are actually usable on this install. A missing
plugin (an install from source on a Python with no wheel) never raises at
import; it turns into ``no_decoder`` / ``no_encoder`` and the caller's usual
loud "cannot send / cannot serve this", exactly what happened before this module
existed.
"""

from __future__ import annotations

import copy
import functools
import threading
from typing import Optional

from .connections import EXPLICIT_LE, IMPLICIT_LE, ts_name

# ---- the syntaxes, by what they do to pixels --------------------------------
DEFLATED_LE = "1.2.840.10008.1.2.1.99"
BIG_ENDIAN = "1.2.840.10008.1.2.2"
RLE_LOSSLESS = "1.2.840.10008.1.2.5"
JPEG_LS_LOSSLESS = "1.2.840.10008.1.2.4.80"
JPEG_2000_LOSSLESS = "1.2.840.10008.1.2.4.90"
HTJ2K_LOSSLESS = "1.2.840.10008.1.2.4.201"

# Native encodings (PS3.5 A.1-A.3, A.5). Pixels in these are already decoded;
# changing between them is a re-write of the header, never a pixel operation.
NATIVE = frozenset({IMPLICIT_LE, EXPLICIT_LE, DEFLATED_LE, BIG_ENDIAN})

# What decompression may produce. Explicit VR Little Endian is what pydicom's
# decompress() writes and what PS3.18 8.7.3 allows for native frames; Implicit
# is the one syntax every Storage SCP must take (PS3.5 10.1), so a send that
# only gets Implicit accepted can still go. Big Endian is retired (PS3.5 A.3)
# and Deflated buys a WAN a few percent at a codec's worth of risk — neither is
# a target.
DECOMPRESS_TARGETS = frozenset({EXPLICIT_LE, IMPLICIT_LE})

# What compression may produce: lossless-only syntaxes, nothing else. Whether
# each one can actually be encoded here is capabilities()'s question.
LOSSLESS_TARGETS = (RLE_LOSSLESS, JPEG_LS_LOSSLESS, JPEG_2000_LOSSLESS, HTJ2K_LOSSLESS)

# Compressed syntaxes that can only be lossless (PS3.5 A.4.1-A.4.4, A.4.6, A.4.11):
# a decode of these reproduces the original exactly.
LOSSLESS_ONLY = frozenset({
    "1.2.840.10008.1.2.4.57",   # JPEG Lossless, Process 14
    "1.2.840.10008.1.2.4.70",   # JPEG Lossless SV1
    JPEG_LS_LOSSLESS,
    JPEG_2000_LOSSLESS,
    "1.2.840.10008.1.2.4.92",   # JPEG 2000 Part 2 multi-component, lossless only
    HTJ2K_LOSSLESS,
    "1.2.840.10008.1.2.4.202",  # HTJ2K Lossless RPCL
    RLE_LOSSLESS,
})

# Syntaxes that are lossy, or may be, with the PS3.3 C.7.6.1.1.5.1 defined term
# for (0028,2114) Lossy Image Compression Method. JPEG Baseline/Extended are DCT
# and always lossy. JPEG-LS Near-Lossless, "JPEG 2000" (.91, .93) and HTJ2K
# (.203) are lossy unless the encoder chose otherwise, and nothing in the
# codestream we could trust says which; we treat them as lossy unless the header
# explicitly says (0028,2110) = "00". Flagging an original as lossy costs a
# radiologist a second look; not flagging a lossy image costs them the reason to.
LOSSY_METHOD = {
    "1.2.840.10008.1.2.4.50": "ISO_10918_1",    # JPEG Baseline
    "1.2.840.10008.1.2.4.51": "ISO_10918_1",    # JPEG Extended
    "1.2.840.10008.1.2.4.81": "ISO_14495_1",    # JPEG-LS Near-Lossless
    "1.2.840.10008.1.2.4.91": "ISO_15444_1",    # JPEG 2000 (lossless or lossy)
    "1.2.840.10008.1.2.4.93": "ISO_15444_2",    # JPEG 2000 Part 2 multi-component
    "1.2.840.10008.1.2.4.203": "ISO_15444_15",  # HTJ2K (lossless or lossy)
}
ALWAYS_LOSSY = frozenset({"1.2.840.10008.1.2.4.50", "1.2.840.10008.1.2.4.51"})

# Every compressed syntax pydicom 3 may have a decoder for. Video (MPEG/HEVC)
# is absent on purpose: pydicom decodes none of it, and a frame-by-frame decode
# of a cine is not what anybody sending one wants.
_DECODABLE = tuple(sorted(LOSSLESS_ONLY | set(LOSSY_METHOD)))

# The decoded size above which we refuse. One GiB is the largest object the
# engine takes in one piece anywhere else (dicomweb._STOW_MAX_BYTES), and a
# decode holds the source, the decoded frames and the joined Pixel Data at once,
# so a transcode at the cap peaks near three times this. Above it is a
# tomosynthesis or a long cine, which is sent or served as stored.
MAX_DECOMPRESSED_BYTES = 1024 * 1024 * 1024

# Transcodes in flight at once, across the SCU, the Q/R SCP and WADO-RS. Each
# can hold ~3 GiB at the cap, and none of the callers is in a hurry that a
# queue of two would hurt: a send waiting for a slot is still a send.
MAX_CONCURRENT = 2
_slots = threading.BoundedSemaphore(MAX_CONCURRENT)


class TranscodeError(Exception):
    """A transcode that will not or cannot be done, with a machine-readable
    *reason* and a message meant for whoever has to read it:

    * ``lossy_target`` — the target is a lossy syntax (rule 2);
    * ``unsupported`` — the target is not a syntax this module produces, or the
      object cannot be put in it (no pixels, float pixels, a geometry the codec
      refuses);
    * ``no_decoder`` / ``no_encoder`` — the codec is not installed here;
    * ``too_large`` — above MAX_DECOMPRESSED_BYTES;
    * ``not_lossless`` — the encode did not decode back to the same pixels;
    * ``failed`` — the codec raised (a corrupt codestream, usually).
    """

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


# ---- what this install can do ------------------------------------------------
@functools.lru_cache(maxsize=1)
def capabilities() -> dict:
    """``{"decode": {uid: [plugins]}, "encode": {uid: [plugins]}}`` for this
    install, asked of pydicom once and cached for the life of the process.

    pydicom's ``is_available`` imports each plugin's dependencies, so the probe
    is what tells "pyjpegls has no wheel for this Python" from "installed".
    Anything that raises here — numpy missing makes pydicom.pixels itself fail
    to import — is an empty answer, never an exception: the caller only ever
    learns that a codec is absent."""
    decode: dict = {}
    encode: dict = {}
    try:
        import numpy  # noqa: F401 - every pixel handler needs it
        from pydicom.pixels import get_decoder, get_encoder
    except Exception:
        return {"decode": decode, "encode": encode}
    for uid in _DECODABLE:
        try:
            dec = get_decoder(uid)
            if dec.is_available:
                decode[uid] = sorted(dec.available_plugins)
        except Exception:
            pass
    for uid in LOSSLESS_TARGETS:
        try:
            enc = get_encoder(uid)          # raises for a syntax pydicom has no encoder for
            if enc.is_available:
                encode[uid] = sorted(enc.available_plugins)
        except Exception:
            pass
    return {"decode": decode, "encode": encode}


def can_decode(ts: str) -> bool:
    """Whether pixels stored as *ts* can be turned into native pixels here."""
    ts = str(ts or "")
    return ts in NATIVE or ts in capabilities()["decode"]


def can_encode(ts: str) -> bool:
    return str(ts or "") in capabilities()["encode"]


def fallback_syntaxes(ts: str) -> list[str]:
    """The extra transfer syntaxes a sender may propose beside *ts* — Explicit
    then Implicit VR Little Endian — or [] when there is no fallback: *ts* is
    already native (pynetdicom converts between native syntaxes itself), or no
    decoder for it is installed, so proposing uncompressed would only win a
    context the send could not use."""
    ts = str(ts or "")
    if ts in NATIVE or not can_decode(ts):
        return []
    return [EXPLICIT_LE, IMPLICIT_LE]


def send_target(stored_ts: str, accepted: set) -> Optional[str]:
    """What to send an instance stored as *stored_ts* as, given the transfer
    syntaxes the far side *accepted* for its SOP class: None to send it as
    stored (the stored syntax was accepted, or nothing better was), else
    Explicit VR Little Endian — pynetdicom writes Implicit itself when only
    that was accepted, because the two are convertible without touching a
    pixel."""
    stored_ts = str(stored_ts or "")
    accepted = {str(t) for t in accepted}
    if stored_ts in accepted or stored_ts in NATIVE:
        return None
    if accepted & DECOMPRESS_TARGETS and can_decode(stored_ts):
        return EXPLICIT_LE
    return None


# ---- names -------------------------------------------------------------------
_ALIASES = {
    "explicit": EXPLICIT_LE, "explicit-le": EXPLICIT_LE, "uncompressed": EXPLICIT_LE,
    "implicit": IMPLICIT_LE, "implicit-le": IMPLICIT_LE,
    "rle": RLE_LOSSLESS, "jpeg-ls": JPEG_LS_LOSSLESS, "jpegls": JPEG_LS_LOSSLESS,
    "jls": JPEG_LS_LOSSLESS, "j2k": JPEG_2000_LOSSLESS, "jpeg2000": JPEG_2000_LOSSLESS,
    "jp2": JPEG_2000_LOSSLESS, "htj2k": HTJ2K_LOSSLESS,
}


def resolve(name: str) -> str:
    """A transfer syntax UID from a UID, a pydicom keyword
    (``JPEGLSLossless``), the name the dashboard shows (``JPEG-LS Lossless``),
    or a short alias (``rle``, ``j2k``). ValueError for anything else — a
    command line that names a syntax by a typo must not quietly pick one."""
    s = str(name or "").strip()
    if not s:
        raise ValueError("no transfer syntax given")
    if s[0].isdigit():
        return s
    low = s.lower()
    if low in _ALIASES:
        return _ALIASES[low]
    from .connections import _TS_NAMES
    for uid, nm in _TS_NAMES.items():
        if nm.lower() == low:
            return uid
    try:
        import pydicom.uid as _u
        val = getattr(_u, s, None)
        if isinstance(val, str) and val.startswith("1.2.840.10008.1.2"):
            return str(val)
    except Exception:
        pass
    raise ValueError(f"unknown transfer syntax '{s}' — give a UID, a pydicom keyword "
                     f"such as JPEGLSLossless, or one of: {', '.join(sorted(_ALIASES))}")


# ---- the rules, without touching pixels ---------------------------------------
def source_is_lossy(ds, ts: str) -> bool:
    """Whether the pixels in *ds* (stored as *ts*) have been through lossy
    compression, now or at any earlier step — see LOSSY_METHOD."""
    flag = str(getattr(ds, "LossyImageCompression", "") or "").strip()
    if flag == "01":
        return True
    ts = str(ts or "")
    if ts in ALWAYS_LOSSY:
        return True
    return ts in LOSSY_METHOD and flag != "00"


def check(source_ts: str, target_ts: str) -> None:
    """Raise TranscodeError when *source_ts* → *target_ts* breaks a rule or
    needs a codec this install lacks. Header-free, so a caller can turn a
    request down before reading a file; :func:`transcode` repeats it and adds
    the checks that need the dataset (size, pixel shape, the lossy flag)."""
    src, dst = str(source_ts or ""), str(target_ts or "")
    if src == dst:
        return
    if src == BIG_ENDIAN:
        # Retired (PS3.5 A.3), and its OW pixels would need a byte swap that
        # pydicom's writer does not do; served and sent as stored, as before.
        raise TranscodeError("unsupported", (
            f"{ts_name(src)} is retired and is not converted here"))
    if dst in LOSSY_METHOD or dst in ALWAYS_LOSSY:
        if src in LOSSY_METHOD:
            raise TranscodeError("lossy_target", (
                f"refusing to re-encode {ts_name(src)} as {ts_name(dst)}: that is a second "
                f"generation of lossy compression on an image that already had one. "
                f"Ask for {ts_name(EXPLICIT_LE)} or a lossless syntax instead"))
        raise TranscodeError("lossy_target", (
            f"{ts_name(dst)} is a lossy transfer syntax, and this server never encodes "
            f"lossy. Ask for {ts_name(EXPLICIT_LE)} or a lossless syntax "
            f"({', '.join(ts_name(t) for t in LOSSLESS_TARGETS)})"))
    if dst not in DECOMPRESS_TARGETS and dst not in LOSSLESS_TARGETS:
        raise TranscodeError("unsupported", (
            f"{ts_name(dst)} is not a syntax this server converts to (it produces "
            f"{ts_name(EXPLICIT_LE)}, {ts_name(IMPLICIT_LE)} and "
            f"{', '.join(ts_name(t) for t in LOSSLESS_TARGETS)})"))
    if src not in NATIVE and not can_decode(src):
        raise TranscodeError("no_decoder", (
            f"no decoder for {ts_name(src)} is installed here, so it can only be sent "
            f"or served as stored"))
    if dst in LOSSLESS_TARGETS and not can_encode(dst):
        raise TranscodeError("no_encoder", (
            f"no {ts_name(dst)} encoder is installed here"))


def decoded_size(ds) -> int:
    """Bytes of native Pixel Data *ds* decodes to, from its Image Pixel module.
    0 when the header does not say (no pixels, or no geometry)."""
    try:
        rows = int(getattr(ds, "Rows", 0) or 0)
        cols = int(getattr(ds, "Columns", 0) or 0)
        spp = int(getattr(ds, "SamplesPerPixel", 1) or 1)
        bits = int(getattr(ds, "BitsAllocated", 8) or 8)
        frames = int(getattr(ds, "NumberOfFrames", 1) or 1)
    except (TypeError, ValueError):
        return 0
    if bits == 1:
        return (rows * cols * spp * frames + 7) // 8
    return rows * cols * spp * ((bits + 7) // 8) * max(frames, 1)


def check_size(ds, frames: Optional[int] = None) -> None:
    """TranscodeError ``too_large`` when decoding *ds* (or *frames* of its
    frames) would allocate more than MAX_DECOMPRESSED_BYTES."""
    size = decoded_size(ds)
    if frames is not None:
        total = max(int(getattr(ds, "NumberOfFrames", 1) or 1), 1)
        size = size // total * frames
    if size > MAX_DECOMPRESSED_BYTES:
        raise TranscodeError("too_large", (
            f"{size // (1024 * 1024)} MiB of pixels once decoded, above the "
            f"{MAX_DECOMPRESSED_BYTES // (1024 * 1024)} MiB this server will decode in "
            f"memory; it can only be sent or served as stored"))


# ---- doing it ------------------------------------------------------------------
def transcode(ds, target_ts: str, *, in_place: bool = False):
    """*ds* re-encoded in *target_ts*, or TranscodeError.

    Returns a new Dataset unless *in_place* — pass that only for a dataset the
    caller has just read for this purpose and nobody else holds. The SOP
    Instance UID is kept; the source's lossy history is carried (rule 1);
    an encode is verified pixel for pixel (rule 3). A dataset already in
    *target_ts* comes back unchanged."""
    target = str(target_ts or "")
    meta = getattr(ds, "file_meta", None)
    source = str(getattr(meta, "TransferSyntaxUID", "") or "")
    if not source:
        raise TranscodeError("unsupported", "the instance has no (0002,0010) Transfer Syntax UID")
    if source == target:
        return ds if in_place else copy.deepcopy(ds)
    check(source, target)

    has_pixels = "PixelData" in ds
    if not has_pixels:
        if target in LOSSLESS_TARGETS:
            raise TranscodeError("unsupported", (
                f"the instance has no Pixel Data to compress as {ts_name(target)}"))
        # No pixels (an SR, a KO, a presentation state): a change between
        # native syntaxes is a header rewrite and nothing else.
        out = ds if in_place else copy.deepcopy(ds)
        out.file_meta.TransferSyntaxUID = target
        _mark_written(out)
        return out

    if source in NATIVE and target in DECOMPRESS_TARGETS:
        # Native to native: pydicom re-encodes the VRs on write and the pixel
        # bytes are little endian either side, so no pixel is touched.
        out = ds if in_place else copy.deepcopy(ds)
        out.file_meta.TransferSyntaxUID = target
        _mark_written(out)
        return out

    check_size(ds)
    lossy = source_is_lossy(ds, source)
    with _slots:
        out = ds if in_place else copy.deepcopy(ds)
        try:
            if source not in NATIVE:
                _decompress(out, source, lossy)
            if target in LOSSLESS_TARGETS:
                _compress(out, target)
            else:
                out.file_meta.TransferSyntaxUID = target
        except TranscodeError:
            raise
        except MemoryError:
            raise TranscodeError("too_large", "ran out of memory decoding the pixels")
        except Exception as exc:
            raise TranscodeError("failed", (
                f"{ts_name(source)} → {ts_name(target)} failed: {exc}")) from exc
    _mark_written(out)
    return out


def _decompress(ds, source: str, lossy: bool) -> None:
    """Decode *ds* in place to Explicit VR Little Endian, keeping its UID and
    recording its lossy history (rule 1)."""
    compressed_len = 0
    try:
        compressed_len = len(ds["PixelData"].value)
    except Exception:
        pass
    native_len = decoded_size(ds)
    # as_rgb only for YBR_FULL_422. pydicom cannot hand 4:2:2 back as native
    # samples (it refuses: the upsampled bytes do not fit the subsampled
    # geometry), so it converts to RGB and rewrites Photometric Interpretation.
    # Anywhere else the colour conversion would be a rounding step under an
    # unchanged SOP Instance UID: a lossless RLE or JPEG-LS YBR_FULL would come
    # out as different numbers labelled RGB, unflagged. as_rgb=False gives the
    # stored values exactly (and J2K YBR_RCT/ICT still comes back as RGB,
    # because OpenJPEG undoes the component transform itself).
    pi = str(getattr(ds, "PhotometricInterpretation", "") or "").strip().upper()
    if pi == "YBR_FULL_422" and not lossy:
        raise TranscodeError("unsupported", (
            "a lossless YBR_FULL_422 image cannot be decompressed without converting its "
            "colour to RGB, which would change the values under the same SOP Instance UID"))
    ds.decompress(as_rgb=(pi == "YBR_FULL_422"), generate_instance_uid=False)
    # PS3.3 C.7.6.3.1.8: the Extended Offset Table describes encapsulated
    # fragments; on native Pixel Data it points into nothing, and pydicom
    # leaves it behind.
    for tag in (0x7FE00001, 0x7FE00002):
        if tag in ds:
            del ds[tag]
    if not lossy:
        return
    already = str(getattr(ds, "LossyImageCompression", "") or "").strip() == "01"
    ds.LossyImageCompression = "01"
    method = LOSSY_METHOD.get(source)
    if already or not method:
        # The header already tells the story (PS3.3 C.7.6.1.1.5: a set flag is
        # never cleared and what it recorded stays); decompression adds no
        # loss of its own, so there is nothing new to append.
        return
    methods = list(_multi(ds, "LossyImageCompressionMethod"))
    ratios = list(_multi(ds, "LossyImageCompressionRatio"))
    methods.append(method)
    if compressed_len and native_len:
        # DS is at most 16 characters (PS3.5 6.2); two decimals is what
        # modalities write.
        ratios.append(f"{native_len / compressed_len:.2f}"[:16])
    ds.LossyImageCompressionMethod = methods if len(methods) > 1 else methods[0]
    if ratios:
        ds.LossyImageCompressionRatio = ratios if len(ratios) > 1 else ratios[0]


def _multi(ds, keyword: str) -> list:
    val = getattr(ds, keyword, None)
    if val is None or val == "":
        return []
    if isinstance(val, (list, tuple)) or type(val).__name__ == "MultiValue":
        return [str(v) for v in val]
    return [str(val)]


def _compress(ds, target: str) -> None:
    """Encode native *ds* in place as lossless *target*, then decode it again
    and compare (rule 3)."""
    import numpy as np
    from pydicom.pixels import get_decoder

    try:
        before = np.array(ds.pixel_array, copy=True)
    except Exception as exc:
        raise TranscodeError("failed", f"the native pixels could not be read: {exc}") from exc
    try:
        ds.compress(target, generate_instance_uid=False)
    except (ValueError, NotImplementedError) as exc:
        # pydicom refuses up front what the codec cannot hold: JPEG-LS above
        # 16 bits, RLE with more than 15 segments, signed J2K at some depths.
        raise TranscodeError("unsupported", f"{ts_name(target)} cannot hold this image: {exc}") from exc
    try:
        after, _meta = get_decoder(target).as_array(ds, as_rgb=False)
    except Exception as exc:
        raise TranscodeError("failed", f"the {ts_name(target)} encoding would not decode: {exc}") from exc
    if before.shape != after.shape or not np.array_equal(before, after):
        raise TranscodeError("not_lossless", (
            f"the {ts_name(target)} encoding did not decode back to the same pixels, so it "
            f"was discarded rather than handed out under the same SOP Instance UID"))


def _mark_written(ds) -> None:
    """PS3.10 7.1: (0002,0012)/(0002,0013) name the implementation that wrote
    the file, and after a re-encode that is pydicom, not the modality."""
    try:
        import pydicom
        from pydicom.uid import PYDICOM_IMPLEMENTATION_UID
        ds.file_meta.ImplementationClassUID = PYDICOM_IMPLEMENTATION_UID
        ds.file_meta.ImplementationVersionName = f"PYDICOM {pydicom.__version__}"[:16]
    except Exception:
        pass


def decode_frames(ds, wanted: list[int]) -> list[bytes]:
    """The requested 1-based frames of compressed *ds* as native little-endian
    bytes, decoding only those frames.

    For WADO-RS frames, which have no header of their own to carry a changed
    Photometric Interpretation: the client read the instance's metadata and
    will interpret these bytes by it. So frames are decoded only where the
    decode leaves the photometric as declared — MONOCHROME1/2, PALETTE COLOR
    and RGB. A YBR source decodes to a different colour space (or, for 422, a
    different size), which would be a wrong picture rather than an error; the
    whole instance (with its header rewritten) is the way to get those."""
    from pydicom.pixels import get_decoder

    source = str(ds.file_meta.TransferSyntaxUID)
    check(source, EXPLICIT_LE)
    pi = str(getattr(ds, "PhotometricInterpretation", "") or "").strip().upper()
    if pi not in ("MONOCHROME1", "MONOCHROME2", "PALETTE COLOR", "RGB"):
        raise TranscodeError("unsupported", (
            f"frames of a {pi or 'no-photometric'} {ts_name(source)} instance would decode to "
            f"a different colour space than its metadata declares; retrieve the instance "
            f"with transfer-syntax={EXPLICIT_LE} instead"))
    if int(getattr(ds, "BitsAllocated", 8) or 8) == 1:
        raise TranscodeError("unsupported", "single-bit pixel data cannot be split into frames")
    unique = sorted(set(wanted))
    check_size(ds, frames=len(unique))
    out: dict = {}
    with _slots:
        try:
            dec = get_decoder(source)
            for n, (arr, _meta) in zip(unique, dec.iter_array(
                    ds, indices=[n - 1 for n in unique], as_rgb=False)):
                out[n] = arr.astype(arr.dtype.newbyteorder("<"), copy=False).tobytes()
        except TranscodeError:
            raise
        except Exception as exc:
            raise TranscodeError("failed", f"{ts_name(source)} frames would not decode: {exc}") from exc
    return [out[n] for n in wanted]


def describe() -> list[dict]:
    """One row per syntax this module knows, for ``pacs transcode --list``:
    whether it decodes and encodes here, and through which plugins."""
    caps = capabilities()
    rows = []
    for uid in sorted(set(_DECODABLE) | set(LOSSLESS_TARGETS), key=lambda u: ts_name(u)):
        rows.append({
            "uid": uid, "name": ts_name(uid),
            "lossy": uid in LOSSY_METHOD or uid in ALWAYS_LOSSY,
            "decode": caps["decode"].get(uid, []),
            "encode": caps["encode"].get(uid, []) if uid in LOSSLESS_TARGETS else None,
        })
    return rows
