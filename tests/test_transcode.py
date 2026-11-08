"""Tests for pacs.transcode and the three places that use it: the Storage SCU's
uncompressed fallback, the Q/R SCP's C-MOVE/C-GET sub-operations, and WADO-RS.

The compressed sources are pydicom's own bundled test files (JPEG Lossless SV1,
JPEG Baseline, RLE, JPEG-LS, JPEG 2000), so the decoders are exercised on
codestreams other encoders wrote rather than on ones this module made itself.
A codec this install lacks skips its test; it never fails it — degrading to
"send as stored" is the documented behaviour without one.

Runs under pytest, or directly:  python3 tests/test_transcode.py
"""

from __future__ import annotations

import io
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np                                                   # noqa: E402
import pydicom                                                       # noqa: E402
import pytest                                                        # noqa: E402
from pydicom import dcmread                                          # noqa: E402
from pydicom.dataset import Dataset, FileMetaDataset                 # noqa: E402
from pydicom.uid import (ExplicitVRLittleEndian, ImplicitVRLittleEndian,  # noqa: E402
                         JPEG2000, JPEG2000Lossless, JPEGBaseline8Bit, JPEGLSLossless,
                         MRImageStorage, RLELossless, SecondaryCaptureImageStorage,
                         generate_uid)
from pynetdicom import AE, build_role, evt                           # noqa: E402
from pynetdicom.sop_class import StudyRootQueryRetrieveInformationModelGet  # noqa: E402

from pacs import connections as C                                    # noqa: E402
from pacs import transcode as T                                      # noqa: E402
from pacs.scu import Destination, c_store                            # noqa: E402

_FILES = os.path.join(os.path.dirname(pydicom.__file__), "data", "test_files")


def _bundled(name: str):
    path = os.path.join(_FILES, name)
    if not os.path.isfile(path):
        pytest.skip(f"pydicom test file {name} is not installed")
    return dcmread(path)


def _need_decode(ts):
    if not T.can_decode(ts):
        pytest.skip(f"no {C.ts_name(ts)} decoder installed")


def _need_encode(ts):
    if not T.can_encode(ts):
        pytest.skip(f"no {C.ts_name(ts)} encoder installed")


def _native(bits=16, spp=1, frames=2, rows=64, cols=64) -> tuple[Dataset, np.ndarray]:
    """A synthetic native image. 64x64 because OpenJPEG's default six DWT
    resolutions need at least 32 pixels a side."""
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.SOPClassUID = SecondaryCaptureImageStorage
    ds.SOPInstanceUID = generate_uid()
    ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.StudyInstanceUID, ds.SeriesInstanceUID = generate_uid(), generate_uid()
    ds.PatientID, ds.Modality = "P-TC", "OT"
    ds.Rows, ds.Columns, ds.SamplesPerPixel = rows, cols, spp
    ds.PhotometricInterpretation = "MONOCHROME2" if spp == 1 else "RGB"
    if spp > 1:
        ds.PlanarConfiguration = 0
    ds.BitsAllocated = bits
    ds.BitsStored = 12 if bits == 16 else 8
    ds.HighBit = ds.BitsStored - 1
    ds.PixelRepresentation = 0
    ds.NumberOfFrames = frames
    rng = np.random.default_rng(7)
    shape = (frames, rows, cols) + ((spp,) if spp > 1 else ())
    top = 4095 if bits == 16 else 255
    arr = rng.integers(0, top, size=shape).astype(np.uint16 if bits == 16 else np.uint8)
    ds.PixelData = arr.tobytes()
    return ds, arr


def _bytes(ds) -> bytes:
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    return buf.getvalue()


# ------------------------------------------------------------- the module
@pytest.mark.parametrize("target", [RLELossless, JPEGLSLossless, JPEG2000Lossless])
@pytest.mark.parametrize("shape", [dict(), dict(bits=8, spp=3, frames=1)])
def test_lossless_round_trip_is_pixel_exact(target, shape):
    _need_encode(target)
    src, arr = _native(**shape)
    uid = src.SOPInstanceUID
    enc = T.transcode(src, target)
    assert str(enc.file_meta.TransferSyntaxUID) == target
    assert enc.SOPInstanceUID == uid and enc.file_meta.MediaStorageSOPInstanceUID == uid
    # Not in place: the source still holds its own pixels and syntax.
    assert str(src.file_meta.TransferSyntaxUID) == ExplicitVRLittleEndian
    # Through Part 10 bytes and back, as it travels.
    back = T.transcode(dcmread(io.BytesIO(_bytes(enc))), ExplicitVRLittleEndian)
    assert np.array_equal(back.pixel_array.reshape(arr.shape), arr)
    assert "LossyImageCompression" not in back


@pytest.mark.parametrize("name", ["SC_rgb_jpeg_gdcm.dcm",          # JPEG Lossless SV1
                                  "MR_small_RLE.dcm",
                                  "MR_small_jpeg_ls_lossless.dcm",
                                  "MR_small_jp2klossless.dcm"])
def test_lossless_sources_decode_to_the_same_pixels(name):
    ds = _bundled(name)
    ts = str(ds.file_meta.TransferSyntaxUID)
    _need_decode(ts)
    want = ds.pixel_array.copy()
    out = T.transcode(ds, ExplicitVRLittleEndian)
    assert str(out.file_meta.TransferSyntaxUID) == ExplicitVRLittleEndian
    assert out.SOPInstanceUID == ds.SOPInstanceUID
    assert np.array_equal(out.pixel_array, want)
    assert str(getattr(out, "LossyImageCompression", "")) != "01"
    # Implicit VR LE is reachable too, and is the same pixels.
    imp = T.transcode(ds, ImplicitVRLittleEndian)
    assert str(imp.file_meta.TransferSyntaxUID) == ImplicitVRLittleEndian
    assert np.array_equal(dcmread(io.BytesIO(_bytes(imp))).pixel_array, want)


def test_lossy_source_keeps_its_lossy_flag():
    ds = _bundled("SC_rgb_jpeg_dcmtk.dcm")                       # JPEG Baseline, YBR_FULL
    _need_decode(JPEGBaseline8Bit)
    # As a modality that left the lossy attributes out would send it.
    for kw in ("LossyImageCompression", "LossyImageCompressionMethod",
               "LossyImageCompressionRatio"):
        if kw in ds:
            delattr(ds, kw)
    out = T.transcode(ds, ExplicitVRLittleEndian)
    assert out.LossyImageCompression == "01"
    assert "ISO_10918_1" in list(T._multi(out, "LossyImageCompressionMethod"))
    assert float(T._multi(out, "LossyImageCompressionRatio")[-1]) > 1
    # YBR_FULL stays YBR_FULL: the decoder's own values, not a second rounding into RGB.
    assert out.PhotometricInterpretation == "YBR_FULL"
    assert out.SOPInstanceUID == ds.SOPInstanceUID
    # It survives a write and a read.
    again = dcmread(io.BytesIO(_bytes(out)))
    assert again.LossyImageCompression == "01"


def test_lossless_ybr_full_decompresses_to_its_stored_values():
    # A colour conversion here would be a rounding step under the same SOP
    # Instance UID with no lossy flag: different numbers, presented as the original.
    import copy
    from pydicom import examples
    from pydicom.pixels import convert_color_space
    _need_decode(RLELossless)
    ds = copy.deepcopy(examples.rgb_color)
    ybr = convert_color_space(ds.pixel_array, "RGB", "YBR_FULL")
    ds.PhotometricInterpretation = "YBR_FULL"
    ds.PlanarConfiguration = 0
    ds.PixelData = ybr.tobytes()
    ds.compress(RLELossless, encoding_plugin="pydicom", generate_instance_uid=False)
    out = T.transcode(ds, ExplicitVRLittleEndian)
    assert out.PhotometricInterpretation == "YBR_FULL"
    assert "LossyImageCompression" not in out
    # The raw Pixel Data: pixel_array would convert YBR to RGB for display.
    assert np.array_equal(np.frombuffer(out.PixelData, dtype=np.uint8).reshape(ybr.shape), ybr)


def test_an_existing_lossy_history_is_kept_not_rewritten():
    ds = _bundled("SC_rgb_jpeg_dcmtk.dcm")
    _need_decode(JPEGBaseline8Bit)
    ds.LossyImageCompression = "01"
    ds.LossyImageCompressionMethod = "ISO_10918_1"
    ds.LossyImageCompressionRatio = "12.5"
    out = T.transcode(ds, ExplicitVRLittleEndian)
    assert out.LossyImageCompression == "01"
    assert T._multi(out, "LossyImageCompressionMethod") == ["ISO_10918_1"]
    assert T._multi(out, "LossyImageCompressionRatio") == ["12.5"]


def test_lossy_targets_are_refused_by_name():
    src, _ = _native()
    for target in (JPEGBaseline8Bit, JPEG2000, "1.2.840.10008.1.2.4.81"):
        with pytest.raises(T.TranscodeError) as e:
            T.transcode(src, target)
        assert e.value.reason == "lossy_target"
        assert "lossy" in str(e.value) and C.ts_name(target) in str(e.value)
    # Lossy to another lossy syntax: refused as a second generation.
    with pytest.raises(T.TranscodeError) as e:
        T.check(JPEGBaseline8Bit, JPEG2000)
    assert e.value.reason == "lossy_target" and "second generation" in str(e.value)


def test_unsupported_targets_and_missing_codecs(monkeypatch):
    src, _ = _native()
    with pytest.raises(T.TranscodeError) as e:
        T.transcode(src, "1.2.840.10008.1.2.2")          # Big Endian: retired
    assert e.value.reason == "unsupported"
    monkeypatch.setattr(T, "capabilities", lambda: {"decode": {}, "encode": {}})
    with pytest.raises(T.TranscodeError) as e:
        T.check(RLELossless, ExplicitVRLittleEndian)
    assert e.value.reason == "no_decoder"
    with pytest.raises(T.TranscodeError) as e:
        T.check(ExplicitVRLittleEndian, RLELossless)
    assert e.value.reason == "no_encoder"
    assert T.fallback_syntaxes(RLELossless) == []
    assert T.send_target(RLELossless, {ExplicitVRLittleEndian}) is None


def test_too_large_is_refused_before_decoding(monkeypatch):
    ds = _bundled("MR_small_RLE.dcm")
    _need_decode(RLELossless)
    monkeypatch.setattr(T, "MAX_DECOMPRESSED_BYTES", 1024)
    with pytest.raises(T.TranscodeError) as e:
        T.transcode(ds, ExplicitVRLittleEndian)
    assert e.value.reason == "too_large"
    assert str(ds.file_meta.TransferSyntaxUID) == RLELossless


def test_names_resolve():
    assert T.resolve("rle") == RLELossless
    assert T.resolve("JPEGLSLossless") == JPEGLSLossless
    assert T.resolve("JPEG 2000 Lossless") == JPEG2000Lossless
    assert T.resolve(ExplicitVRLittleEndian) == ExplicitVRLittleEndian
    with pytest.raises(ValueError):
        T.resolve("jpeg-lossy-please")


def test_cli_transcode(tmp_path):
    from pacs.__main__ import main
    ds = _bundled("MR_small_RLE.dcm")
    _need_decode(RLELossless)
    src = tmp_path / "in.dcm"
    shutil.copy(os.path.join(_FILES, "MR_small_RLE.dcm"), src)
    before = src.read_bytes()
    out = tmp_path / "out.dcm"
    assert main(["transcode", str(src), str(out), "--to", "explicit"]) == 0
    got = dcmread(out)
    assert str(got.file_meta.TransferSyntaxUID) == ExplicitVRLittleEndian
    assert np.array_equal(got.pixel_array, ds.pixel_array)
    assert src.read_bytes() == before
    assert main(["transcode", str(src), str(out), "--to", "explicit"]) == 2      # exists
    assert main(["transcode", str(src), str(tmp_path / "x.dcm"), "--to", "jpeg baseline"]) == 2
    assert main(["transcode", "--list"]) == 0


# ------------------------------------------------------------- the SCU
class _OnlyUncompressed:
    """A node that takes one SOP class, uncompressed only, and keeps what it
    receives: the transfer syntax of the context and the decoded dataset."""

    def __init__(self, sop, tss=(ExplicitVRLittleEndian,)):
        from test_services import _free_port
        self.port = _free_port()
        self.got: list = []
        ae = AE(ae_title="PLAIN")
        ae.add_supported_context(sop, list(tss))
        self.server = ae.start_server(("127.0.0.1", self.port), block=False,
                                      evt_handlers=[(evt.EVT_C_STORE, self._store)])
        time.sleep(0.2)

    def _store(self, event):
        ds = event.dataset
        ds.file_meta = event.file_meta
        self.got.append((str(event.context.transfer_syntax), ds))
        return 0x0000

    def dest(self):
        return Destination("PLAIN_NODE", "127.0.0.1", self.port, "PLAIN")

    def close(self):
        self.server.shutdown()


def _copy_bundled(tmp, name):
    path = os.path.join(tmp, name)
    shutil.copy(os.path.join(_FILES, name), path)
    return path


def test_scu_sends_decompressed_to_a_node_that_takes_only_explicit():
    ds = _bundled("MR_small_RLE.dcm")
    _need_decode(RLELossless)
    tmp = tempfile.mkdtemp(prefix="carino-tc-")
    node = _OnlyUncompressed(MRImageStorage)
    try:
        path = _copy_bundled(tmp, "MR_small_RLE.dcm")
        before = open(path, "rb").read()
        j = C.ConnectionJournal()
        old = C.sender_journal()
        C.install_sender_journal(j)
        try:
            res = c_store(node.dest(), path, "CARINOSCU", timeout=10)
        finally:
            C.install_sender_journal(old)
        assert res.ok, res.message
        assert res.transcoded == "RLE Lossless → Explicit VR Little Endian", res.transcoded
        assert "sent decompressed" in res.message
        ((ts, got),) = node.got
        assert ts == ExplicitVRLittleEndian
        assert got.SOPInstanceUID == ds.SOPInstanceUID
        assert np.array_equal(got.pixel_array, ds.pixel_array)
        assert open(path, "rb").read() == before, "the stored file was modified"
        (entry,) = j.entries()
        assert "sent decompressed" in entry["detail"]
        assert [c["proposed"] for c in entry["contexts"]] == [
            [RLELossless], [ExplicitVRLittleEndian], [ImplicitVRLittleEndian]]
    finally:
        node.close()
        shutil.rmtree(tmp, ignore_errors=True)


def test_scu_falls_back_to_implicit_when_only_that_is_accepted():
    ds = _bundled("MR_small_RLE.dcm")
    _need_decode(RLELossless)
    tmp = tempfile.mkdtemp(prefix="carino-tc-")
    node = _OnlyUncompressed(MRImageStorage, tss=(ImplicitVRLittleEndian,))
    try:
        res = c_store(node.dest(), _copy_bundled(tmp, "MR_small_RLE.dcm"), "CARINOSCU", timeout=10)
        assert res.ok and res.transcoded.endswith("Implicit VR Little Endian"), res
        ((ts, got),) = node.got
        assert ts == ImplicitVRLittleEndian
        assert np.array_equal(got.pixel_array, ds.pixel_array)
    finally:
        node.close()
        shutil.rmtree(tmp, ignore_errors=True)


def test_scu_sends_as_stored_when_the_stored_syntax_is_accepted():
    _need_decode(RLELossless)
    tmp = tempfile.mkdtemp(prefix="carino-tc-")
    node = _OnlyUncompressed(MRImageStorage, tss=(RLELossless, ExplicitVRLittleEndian))
    try:
        res = c_store(node.dest(), _copy_bundled(tmp, "MR_small_RLE.dcm"), "CARINOSCU", timeout=10)
        assert res.ok and res.transcoded == "" and res.message == "stored", res
        ((ts, _got),) = node.got
        assert ts == RLELossless
    finally:
        node.close()
        shutil.rmtree(tmp, ignore_errors=True)


def test_scu_without_a_decoder_still_fails_loudly(monkeypatch):
    monkeypatch.setattr(T, "capabilities", lambda: {"decode": {}, "encode": {}})
    tmp = tempfile.mkdtemp(prefix="carino-tc-")
    node = _OnlyUncompressed(MRImageStorage)
    try:
        res = c_store(node.dest(), _copy_bundled(tmp, "MR_small_RLE.dcm"), "CARINOSCU", timeout=10)
        assert not res.ok
        assert "RLE Lossless" in res.message and "no decoder" in res.message, res.message
        assert node.got == []
    finally:
        node.close()
        shutil.rmtree(tmp, ignore_errors=True)


def test_scu_names_both_refusals_when_uncompressed_is_refused_too():
    _need_decode(RLELossless)
    tmp = tempfile.mkdtemp(prefix="carino-tc-")
    node = _OnlyUncompressed(MRImageStorage, tss=(JPEGLSLossless,))
    try:
        res = c_store(node.dest(), _copy_bundled(tmp, "MR_small_RLE.dcm"), "CARINOSCU", timeout=10)
        assert not res.ok and res.link
        assert "neither as RLE Lossless nor uncompressed" in res.message, res.message
    finally:
        node.close()
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------- Q/R SCP
def _qr_with_rle():
    from test_qr import Fixture, _start_qr
    fx = Fixture()
    src = dcmread(os.path.join(_FILES, "MR_small_RLE.dcm"))
    src.StudyInstanceUID = generate_uid()
    src.SeriesInstanceUID = generate_uid()
    src.PatientID = "P-RLE"
    path = os.path.join(fx.root, "rle.dcm")
    src.save_as(path, enforce_file_format=True)
    fx.index.add_file(path, "received")
    return fx, src, path, _start_qr


def test_move_sends_decompressed_to_a_destination_that_takes_only_explicit():
    _need_decode(RLELossless)
    from test_qr import DEST_AET, _move
    fx, src, path, start = _qr_with_rle()
    node = _OnlyUncompressed(MRImageStorage)
    scp = start(fx, move_destinations={
        DEST_AET: {"host": "127.0.0.1", "port": node.port, "aet": "PLAIN"}})
    try:
        before = open(path, "rb").read()
        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.StudyInstanceUID = src.StudyInstanceUID
        code, final, _ = _move(scp.port, q)[-1]
        assert code == 0x0000 and int(final.NumberOfCompletedSuboperations) == 1, final
        time.sleep(0.3)
        ((ts, got),) = node.got
        assert ts == ExplicitVRLittleEndian
        assert got.SOPInstanceUID == src.SOPInstanceUID
        assert np.array_equal(got.pixel_array, src.pixel_array)
        assert open(path, "rb").read() == before
        said = [e["message"] for e in fx.log.tail(50) if e.get("kind") == "qr"]
        assert any("sent decompressed" in m for m in said), said
    finally:
        scp.stop()
        node.close()
        fx.close()


def test_get_sends_decompressed_when_the_requestor_takes_only_explicit():
    _need_decode(RLELossless)
    from test_qr import QR_AET, SCU_AET
    fx, src, _path, start = _qr_with_rle()
    scp = start(fx)
    got = []

    def handle_store(event):
        got.append((str(event.context.transfer_syntax), event.dataset))
        return 0x0000
    try:
        ae = AE(ae_title=SCU_AET)
        ae.add_requested_context(StudyRootQueryRetrieveInformationModelGet)
        ae.add_requested_context(MRImageStorage, ExplicitVRLittleEndian)
        assoc = ae.associate("127.0.0.1", scp.port, ae_title=QR_AET,
                             ext_neg=[build_role(MRImageStorage, scp_role=True)],
                             evt_handlers=[(evt.EVT_C_STORE, handle_store)])
        assert assoc.is_established
        q = Dataset()
        q.QueryRetrieveLevel = "STUDY"
        q.StudyInstanceUID = src.StudyInstanceUID
        replies = [st for st, _ in assoc.send_c_get(q, StudyRootQueryRetrieveInformationModelGet)]
        assoc.release()
        assert replies[-1].Status == 0x0000, replies[-1]
        ((ts, ds),) = got
        assert ts == ExplicitVRLittleEndian
        ds.file_meta = FileMetaDataset()
        ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
        assert np.array_equal(ds.pixel_array, src.pixel_array)
    finally:
        scp.stop()
        fx.close()


def test_move_contexts_offer_uncompressed_beside_a_decodable_syntax():
    from pacs.qr import _retrieve_contexts
    _need_decode(RLELossless)
    rows = [{"SOPClassUID": MRImageStorage, "TransferSyntaxUID": RLELossless},
            {"SOPClassUID": MRImageStorage, "TransferSyntaxUID": ExplicitVRLittleEndian}]
    pairs = [(str(c.abstract_syntax), [str(t) for t in c.transfer_syntax])
             for c in _retrieve_contexts(rows)]
    assert pairs == [(MRImageStorage, [RLELossless]), (MRImageStorage, [ExplicitVRLittleEndian]),
                     (MRImageStorage, [ImplicitVRLittleEndian])], pairs


# ------------------------------------------------------------- WADO-RS
def _wado_env():
    from test_dicomweb import Env
    return Env()


def _rle_stored(env):
    src = dcmread(os.path.join(_FILES, "MR_small_RLE.dcm"))
    src.StudyInstanceUID, src.SeriesInstanceUID = generate_uid(), generate_uid()
    path = env.server.store(src)
    return src, path


def test_wado_instance_converted_to_the_asked_syntax():
    _need_decode(RLELossless)
    from test_dicomweb import _split_multipart
    env = _wado_env()
    try:
        src, path = _rle_stored(env)
        before = open(path, "rb").read()
        url = (f"/dicom-web/studies/{src.StudyInstanceUID}/series/{src.SeriesInstanceUID}"
               f"/instances/{src.SOPInstanceUID}")
        r = env.client.get(url, headers={"Accept": 'multipart/related; type="application/dicom"; '
                                                   f'transfer-syntax={ExplicitVRLittleEndian}'})
        assert r.status_code == 200, r.get_data(as_text=True)
        assert f"transfer-syntax={ExplicitVRLittleEndian}".encode() in r.get_data()[:400]
        (part,) = _split_multipart(r)
        assert part[:128] == b"\0" * 128
        got = dcmread(io.BytesIO(part))
        assert str(got.file_meta.TransferSyntaxUID) == ExplicitVRLittleEndian
        assert got.SOPInstanceUID == src.SOPInstanceUID
        assert np.array_equal(got.pixel_array, src.pixel_array)
        assert open(path, "rb").read() == before
        # The study level converts too, and '*' still means as stored.
        r = env.client.get(f"/dicom-web/studies/{src.StudyInstanceUID}",
                           headers={"Accept": 'multipart/related; type="application/dicom"; '
                                              f'transfer-syntax={ExplicitVRLittleEndian}'})
        assert r.status_code == 200
        r = env.client.get(url, headers={"Accept": 'multipart/related; type="application/dicom"; '
                                                   'transfer-syntax=*'})
        assert r.status_code == 200 and f"transfer-syntax={RLELossless}" in r.get_data()[:400].decode(
            "latin-1")
    finally:
        env.close()


def test_wado_lossless_reencode_and_lossy_refusal():
    _need_decode(RLELossless)
    env = _wado_env()
    try:
        src, _path = _rle_stored(env)
        url = (f"/dicom-web/studies/{src.StudyInstanceUID}/series/{src.SeriesInstanceUID}"
               f"/instances/{src.SOPInstanceUID}")
        if T.can_encode(JPEGLSLossless):
            r = env.client.get(url, headers={"Accept": 'multipart/related; type="application/dicom"; '
                                                       f'transfer-syntax={JPEGLSLossless}'})
            assert r.status_code == 200, r.get_data(as_text=True)
        r = env.client.get(url, headers={"Accept": 'multipart/related; type="application/dicom"; '
                                                   f'transfer-syntax={JPEGBaseline8Bit}'})
        assert r.status_code == 406
        assert "lossy" in r.get_json()["error"], r.get_json()
    finally:
        env.close()


def test_wado_frames_of_a_compressed_instance_as_octet_stream():
    _need_decode(RLELossless)
    from test_dicomweb import _split_multipart
    env = _wado_env()
    try:
        src, _path = _rle_stored(env)
        url = (f"/dicom-web/studies/{src.StudyInstanceUID}/series/{src.SeriesInstanceUID}"
               f"/instances/{src.SOPInstanceUID}/frames/1")
        r = env.client.get(url, headers={"Accept": 'multipart/related; type="application/octet-stream"'})
        assert r.status_code == 200, r.get_data(as_text=True)
        assert 'type="application/octet-stream"' in r.headers["Content-Type"]
        (frame,) = _split_multipart(r)
        assert frame == src.pixel_array.astype("<u2" if src.pixel_array.dtype.kind == "u"
                                                else "<i2").tobytes()
        # Stored media is still the default answer.
        r = env.client.get(url)
        assert r.status_code == 200 and 'type="image/dicom-rle"' in r.headers["Content-Type"]
        # Frames are never re-compressed.
        r = env.client.get(url, headers={"Accept": 'multipart/related; type="image/jp2"'})
        assert r.status_code == 406
    finally:
        env.close()


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
