"""Regression tests for the 2026-10 review of DICOMweb: WADO-RS path
segments, Accept negotiation, frame retrieval and labels, the truncation
warning, and STOW-RS identity, crash safety, completeness and limits.

Runs under pytest, or directly:  python3 tests/test_review_dicomweb.py
"""

from __future__ import annotations

import errno
import io
import os
import re
import sys
import threading
import tracemalloc

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest                                              # noqa: E402
from pydicom.uid import (DeflatedExplicitVRLittleEndian, JPEGBaseline8Bit,  # noqa: E402
                         generate_uid)

from pacs import dicomweb as DW                            # noqa: E402
from test_dicomweb import (Env, _as_bytes, _seed, _split_multipart, _stow_body,  # noqa: E402
                           make_dataset)

STOW_CT = 'multipart/related; type="application/dicom"; boundary=carinotest'


def _inst(seed, n=0):
    ds = seed["ct"][n]
    return (f"/dicom-web/studies/{seed['ct_study']}/series/{seed['ct_series']}"
            f"/instances/{ds.SOPInstanceUID}")


# --------------------------------------------------------- {instance} is a UID
@pytest.mark.parametrize("suffix", ["", "/metadata", "/frames/1"])
def test_an_instance_segment_is_never_a_pattern(suffix):
    env = Env()
    try:
        s = _seed(env)
        base = f"/dicom-web/studies/{s['ct_study']}/series/{s['ct_series']}/instances"
        assert env.client.get(f"{base}/*{suffix}").status_code == 404
        two = f"{s['ct'][0].SOPInstanceUID}%5C{s['ct'][1].SOPInstanceUID}"
        assert env.client.get(f"{base}/{two}{suffix}").status_code == 404
    finally:
        env.close()


# --------------------------------------------------------- Accept negotiation
@pytest.mark.parametrize("accept", [
    'multipart/related; type="application/dicom"; transfer-syntax=1.2.840.10008.1.2.4.50, */*;q=0.1',
    'multipart/related; type="application/dicom"; transfer-syntax=1.2.840.10008.1.2.4.50, '
    'multipart/related; type="application/dicom"; transfer-syntax=*;q=0.5',
])
def test_a_later_acceptable_range_is_honoured(accept):
    env = Env()
    try:
        s = _seed(env)
        r = env.client.get(f"/dicom-web/studies/{s['ct_study']}", headers={"Accept": accept})
        assert r.status_code == 200, r.status_code
    finally:
        env.close()


def _jpeg_instance(env):
    st, se = generate_uid(), generate_uid()
    ds = make_dataset(study_uid=st, series_uid=se, transfer_syntax=JPEGBaseline8Bit,
                      rows=8, cols=8)
    from pydicom.encaps import encapsulate
    ds.PixelData = encapsulate([b"\xff\xd8\xff\xe0fakejpeg\xff\xd9"])
    ds["PixelData"].VR = "OB"
    ds["PixelData"].is_undefined_length = True
    env.server.store(ds)
    return f"/dicom-web/studies/{st}/series/{se}/instances/{ds.SOPInstanceUID}/frames/1"


def test_a_frame_request_for_another_jpeg_syntax_is_406():
    env = Env()
    try:
        url = _jpeg_instance(env)
        r = env.client.get(url, headers={
            "Accept": 'multipart/related; type="image/jpeg"; transfer-syntax=1.2.840.10008.1.2.4.70'})
        assert r.status_code == 406
        ok = env.client.get(url, headers={"Accept": 'multipart/related; type="image/jpeg"'})
        assert ok.status_code == 200
        assert "transfer-syntax=1.2.840.10008.1.2.4.50" in ok.get_data().decode("latin-1")
    finally:
        env.close()


def test_a_deflated_instance_frame_is_labelled_explicit_little_endian():
    env = Env()
    try:
        st, se = generate_uid(), generate_uid()
        ds = make_dataset(study_uid=st, series_uid=se, rows=4, cols=4,
                          transfer_syntax=DeflatedExplicitVRLittleEndian)
        env.server.store(ds)
        r = env.client.get(f"/dicom-web/studies/{st}/series/{se}/instances/"
                           f"{ds.SOPInstanceUID}/frames/1")
        assert r.status_code == 200
        body = r.get_data().decode("latin-1")
        assert "application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1\r\n" in body
    finally:
        env.close()


def test_a_huge_frame_list_is_refused_up_front():
    env = Env()
    try:
        st, se = generate_uid(), generate_uid()
        ds = make_dataset(study_uid=st, series_uid=se, rows=128, cols=128, frames=2)
        env.server.store(ds)
        url = (f"/dicom-web/studies/{st}/series/{se}/instances/{ds.SOPInstanceUID}"
               f"/frames/" + ",".join(["1"] * 4000))
        tracemalloc.start()
        r = env.client.get(url)
        _cur, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        assert r.status_code == 400 or peak < 4000 * 128 * 128 // 4
    finally:
        env.close()


def test_ybr_full_422_frames_are_sliced_at_two_values_per_pixel():
    env = Env()
    try:
        st, se = generate_uid(), generate_uid()
        ds = make_dataset(study_uid=st, series_uid=se, rows=4, cols=4, frames=2)
        ds.SamplesPerPixel = 3
        ds.PhotometricInterpretation = "YBR_FULL_422"
        ds.PlanarConfiguration = 0
        ds.PixelData = bytes(range(64))
        env.server.store(ds)
        r = env.client.get(f"/dicom-web/studies/{st}/series/{se}/instances/"
                           f"{ds.SOPInstanceUID}/frames/2")
        assert r.status_code == 200
        assert _split_multipart(r) == [bytes(range(32, 64))]
    finally:
        env.close()


def test_no_truncated_warning_when_the_result_just_fills_the_limit():
    env = Env()
    try:
        st, se = generate_uid(), generate_uid()
        for n in (1, 2):
            env.server.store(make_dataset(study_uid=st, series_uid=se, instance_number=n))
        r = env.client.get("/dicom-web/instances?limit=2",
                           headers={"Accept": "application/dicom+json"})
        assert r.status_code == 200
        assert "truncated" not in (r.headers.get("Warning") or "")
        r1 = env.client.get("/dicom-web/instances?limit=1",
                            headers={"Accept": "application/dicom+json"})
        assert "truncated" in (r1.headers.get("Warning") or "")
    finally:
        env.close()


def test_a_vanished_newest_copy_is_retrieved_from_the_older_one():
    env = Env()
    try:
        st, se = generate_uid(), generate_uid()
        ds = make_dataset(study_uid=st, series_uid=se)
        old = env.server.store(ds)
        newer = os.path.join(env.dir, "outgoing", "copy.dcm")
        os.makedirs(os.path.dirname(newer), exist_ok=True)
        import shutil
        shutil.copy(old, newer)
        os.utime(newer, (os.path.getmtime(old) + 100,) * 2)
        env.server.index.add_file(newer, "outgoing")
        os.remove(newer)
        r = env.client.get(f"/dicom-web/studies/{st}/series/{se}/instances/{ds.SOPInstanceUID}")
        assert r.status_code == 200
    finally:
        env.close()


# --------------------------------------------------------------------- STOW
def _stow(env, blobs, url="/dicom-web/studies", **kw):
    return env.client.post(url, data=_stow_body(blobs, **kw), content_type=STOW_CT)


def test_one_post_may_carry_more_than_one_study():
    env = Env()
    try:
        a, b = make_dataset(), make_dataset()
        r = _stow(env, [_as_bytes(a), _as_bytes(b)])
        assert r.status_code == 200, r.get_json()
        refs = r.get_json()["00081199"]["Value"]
        assert {x["00081155"]["Value"][0] for x in refs} == {str(a.SOPInstanceUID),
                                                             str(b.SOPInstanceUID)}
        r2 = _stow(env, [_as_bytes(make_dataset(study_uid=str(a.StudyInstanceUID))),
                         _as_bytes(make_dataset())], url=f"/dicom-web/studies/{a.StudyInstanceUID}")
        assert r2.status_code == 202 and "00081198" in r2.get_json()
    finally:
        env.close()


def test_instances_without_identity_are_refused_and_nothing_is_written():
    env = Env()
    try:
        st, se = generate_uid(), generate_uid()
        blobs = []
        for n in (1, 2):
            ds = make_dataset(study_uid=st, series_uid=se, instance_number=n)
            del ds.SOPInstanceUID
            ds.file_meta.MediaStorageSOPInstanceUID = "1.2"
            blobs.append(_as_bytes(ds))
        r = _stow(env, blobs)
        assert r.status_code == 409
        assert len(r.get_json()["0008119A"]["Value"]) == 2
        storage = env.server.storage
        assert not os.path.isdir(storage) or not [f for _r, _d, fs in os.walk(storage) for f in fs]
        ds = make_dataset()
        del ds.SOPClassUID
        r = _stow(env, [_as_bytes(ds)])
        assert r.status_code == 409 and "00081199" not in r.get_json()
    finally:
        env.close()


def test_a_failed_restow_keeps_the_good_copy(monkeypatch):
    from pydicom import filewriter
    env = Env()
    try:
        ds = make_dataset()
        assert _stow(env, [_as_bytes(ds)]).status_code == 200
        from pacs.scp import dest_path
        path = dest_path(env.server.storage, ds, True)
        good = open(path, "rb").read()
        real = filewriter.write_dataset
        blob = _as_bytes(ds)

        def enospc(fp, dataset, *a, **k):
            raise OSError(errno.ENOSPC, "No space left on device")
        monkeypatch.setattr(filewriter, "write_dataset", enospc)
        r = _stow(env, [blob])
        monkeypatch.setattr(filewriter, "write_dataset", real)
        assert r.status_code == 409
        assert open(path, "rb").read() == good
    finally:
        env.close()


def test_a_failed_first_stow_leaves_no_file(monkeypatch):
    from pydicom import filewriter
    env = Env()
    try:
        def enospc(fp, dataset, *a, **k):
            raise OSError(errno.ENOSPC, "No space left on device")
        blob = _as_bytes(make_dataset())
        monkeypatch.setattr(filewriter, "write_dataset", enospc)
        r = _stow(env, [blob])
        assert r.status_code == 409
        storage = env.server.storage
        left = [f for _r, _d, fs in os.walk(storage) for f in fs] if os.path.isdir(storage) else []
        assert left == []
    finally:
        env.close()


def test_a_body_cut_off_before_its_close_delimiter_is_not_200():
    env = Env()
    try:
        body = _stow_body([_as_bytes(make_dataset()), _as_bytes(make_dataset())])[:-200]
        r = env.client.post("/dicom-web/studies", data=body, content_type=STOW_CT)
        assert r.status_code == 400 or (r.status_code == 202 and "0008119A" in r.get_json())
    finally:
        env.close()


def test_a_stow_parses_without_copying_the_body_over_and_over():
    env = Env()
    try:
        ds = make_dataset(rows=2048, cols=2048)
        body = _stow_body([_as_bytes(ds)])
        tracemalloc.start()
        r = env.client.post("/dicom-web/studies", data=body, content_type=STOW_CT)
        _c, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        assert r.status_code == 200
        assert peak < 3.2 * len(body), peak / len(body)
    finally:
        env.close()


def test_concurrent_stows_beyond_the_limit_get_503(monkeypatch):
    env = Env()
    try:
        gate = threading.Event()
        entered = threading.Semaphore(0)
        real = DW.store_instance

        def slow(server, ds, source="STOW-RS"):
            entered.release()
            gate.wait(5)
            return real(server, ds, source=source)
        monkeypatch.setattr(DW, "store_instance", slow)
        results = []

        def post():
            c = env.app.test_client()
            results.append(c.post("/dicom-web/studies", data=_stow_body([_as_bytes(make_dataset())]),
                                  content_type=STOW_CT))
        ts = [threading.Thread(target=post) for _ in range(2)]
        for t in ts:
            t.start()
        for _ in range(2):
            assert entered.acquire(timeout=5)
        third = env.client.post("/dicom-web/studies", data=_stow_body([_as_bytes(make_dataset())]),
                                content_type=STOW_CT)
        gate.set()
        for t in ts:
            t.join()
        assert third.status_code == 503 and third.headers.get("Retry-After")
    finally:
        env.close()


def test_an_unsupported_part_type_is_counted_as_failed():
    env = Env()
    try:
        bp_stats = env.app.blueprints["dicomweb"].stats
        before = bp_stats.snapshot()["failed"] if hasattr(bp_stats, "snapshot") else None
        r = _stow(env, [b"\xff\xd8\xff"], content_type=b"image/jpeg")
        assert r.status_code == 409
        assert r.get_json()["0008119A"]["Value"][0]["00081197"]["Value"] == [0x0122]
        after = bp_stats.snapshot()["failed"] if hasattr(bp_stats, "snapshot") else None
        if before is not None:
            assert after == before + 1
    finally:
        env.close()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
