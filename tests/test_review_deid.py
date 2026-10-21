"""Regression tests for the 2026-10 review of the de-identification profile.

Runs under pytest, or directly:  python3 tests/test_review_deid.py
"""

from __future__ import annotations

import glob
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest                                              # noqa: E402
from pydicom.dataset import Dataset                        # noqa: E402

from pacs.deid import Deidentifier, DeidError, deidentified_tempfile, write_dataset  # noqa: E402
from test_deid import make_ds                              # noqa: E402


def _d(profile="basic", **kw):
    kw.setdefault("secret", "unit-test-secret")
    return Deidentifier(profile=profile, **kw)


def test_a_uid_that_only_looks_like_the_standard_root_is_remapped():
    d = _d()
    out = d.map_uid("1.2.840.100081.5.6")
    assert out != "1.2.840.100081.5.6" and out.startswith("2.25.")
    assert d.map_uid("1.2.840.10008.5.1.4.1.1.2") == "1.2.840.10008.5.1.4.1.1.2"


def test_without_a_site_key_the_output_does_not_claim_identity_removed():
    d = Deidentifier(secret="")
    out = d.deidentified_copy(make_ds(patient_id="004217"))
    assert str(out.PatientIdentityRemoved) == "NO"
    codes = [str(i.CodeValue) for i in out.DeidentificationMethodCodeSequence]
    assert "113100" not in codes
    # ...because the mapping really is reversible by enumeration:
    target = str(out.PatientID)
    hit = next(x for x in (f"{n:06d}" for n in range(0, 10000))
               if d.pseudo_id("pid:" + x) == target)
    assert hit == "004217"


def test_with_a_site_key_the_claims_are_made():
    out = _d().deidentified_copy(make_ds())
    assert str(out.PatientIdentityRemoved) == "YES"
    assert "113100" in [str(i.CodeValue) for i in out.DeidentificationMethodCodeSequence]


def test_an_encapsulated_document_is_refused_rather_than_emptied():
    ds = make_ds()
    ds.EncapsulatedDocument = b"%PDF-1.4 report "
    try:
        out = _d().deidentified_copy(ds)
    except DeidError:
        return
    assert out.get("EncapsulatedDocument") not in (None, b"")


def test_a_d_action_uid_is_remapped_not_blanked():
    ds = make_ds()
    item = Dataset()
    item.AnnotationGroupUID = "1.2.3.4.66"
    ds.AnnotationGroupSequence = [item]
    out = _d().deidentified_copy(ds)
    v = out.AnnotationGroupSequence[0].AnnotationGroupUID
    assert v and str(v).startswith("2.25.")


def test_sr_content_is_cleaned_or_refused_never_silently_emptied():
    ds = make_ds()
    t = Dataset()
    t.ValueType = "TEXT"
    t.TextValue = "Mrs Doe from ward 4"
    ds.ContentSequence = [t]
    try:
        out = _d().deidentified_copy(ds)
    except DeidError:
        return
    seq = out.get("ContentSequence")
    assert seq is not None and len(seq) == 1
    assert "Doe" not in str(seq[0].get("TextValue", "") or "")


def test_an_unlisted_person_name_is_emptied():
    ds = make_ds()
    ds.add_new(0x00142006, "PN", "Smith^Evaluator")
    out = _d().deidentified_copy(ds)
    v = out[0x00142006].value if 0x00142006 in out else None
    assert not v


def test_the_whole_overlay_group_goes():
    ds = make_ds()
    ds.add_new(0x60000022, "LO", "Jane Doe")
    ds.add_new(0x60001500, "LO", "Doe^Jane")
    ds.add_new(0x60000010, "US", 512)
    out = _d().deidentified_copy(ds)
    assert not [e for e in out if e.tag.group == 0x6000]


def test_the_file_meta_is_rebuilt_without_any_source_identity():
    ds = make_ds()
    fm = ds.file_meta
    fm.add_new(0x00020017, "AE", "SENDAE")
    fm.add_new(0x00020018, "AE", "RECVAE")
    fm.add_new(0x00020026, "UR", "dicom://ct1.stmarys.example:104")
    fm.add_new(0x00020027, "UR", "dicom://router.example")
    fm.ImplementationClassUID = "1.2.3.777.1"
    out = _d("strict").deidentified_copy(ds)
    for tag in (0x00020016, 0x00020017, 0x00020018, 0x00020026, 0x00020027, 0x00020028):
        assert tag not in out.file_meta, hex(tag)
    assert str(out.file_meta.ImplementationClassUID) != "1.2.3.777.1"


def test_the_preamble_never_carries_the_source_text():
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "src.dcm")
        ds = make_ds()
        ds.preamble = b"PATIENT JANE DOE MRN 123456".ljust(128, b"\0")
        write_dataset(ds, src)
        with deidentified_tempfile(src, _d()) as path:
            assert open(path, "rb").read()[:128] == b"\x00" * 128


def test_the_issuer_keeps_two_patients_apart_when_asked_to():
    a, b = make_ds(patient_id="1001"), make_ds(patient_id="1001")
    a.IssuerOfPatientID = "HOSP_A"
    b.IssuerOfPatientID = "CLINIC_B"
    d = _d(issuer_in_identity=True)
    assert d.deidentified_copy(a).PatientID != d.deidentified_copy(b).PatientID
    # and by default (compatibility with existing exports) nothing changes:
    plain = _d()
    assert plain.deidentified_copy(a).PatientID == plain.deidentified_copy(b).PatientID


def test_a_failing_scrub_leaves_no_temp_file_behind():
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "src.dcm")
        write_dataset(make_ds(), src)
        before = set(glob.glob(os.path.join(tempfile.gettempdir(), "carino-deid-*")))
        with pytest.raises(RuntimeError):
            with deidentified_tempfile(src, _d()):
                raise RuntimeError("caller failed")
        after = set(glob.glob(os.path.join(tempfile.gettempdir(), "carino-deid-*")))
        assert after <= before


def test_strict_ignores_keep_private():
    d = Deidentifier(profile="strict", keep_private=True, secret="k")
    assert d.keep_private is False
    out = d.deidentified_copy(make_ds())
    assert "113100" in [str(i.CodeValue) for i in out.DeidentificationMethodCodeSequence]


def test_a_multi_valued_uid_under_a_d_action_is_remapped_value_by_value():
    d = _d()
    ds = Dataset()
    ds.add_new(0x006A0003, "UI", ["1.2.3.4", "1.2.3.5"])    # AnnotationGroupUID
    d._apply_profile(ds)
    vals = list(ds[0x006A0003].value)
    assert len(vals) == 2 and all(v.startswith("2.25.") for v in vals)
    assert vals == [d.map_uid("1.2.3.4"), d.map_uid("1.2.3.5")]


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
