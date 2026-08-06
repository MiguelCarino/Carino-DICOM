"""Tests for pacs.deid (de-identification applied on forward).

Runs under pytest, or directly:  python3 tests/test_deid.py
"""

from __future__ import annotations

import copy
import datetime
import hashlib
import os
import random
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pydicom import dcmread
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian

from pacs.deid import (Deidentifier, DeidError, deidentified_tempfile,
                       load_profile_table, write_dataset, _ACTIONS)

PATIENT_ID = "MRN-004471"
STUDY_UID = "1.2.826.0.1.3680043.9.7.1"
SERIES_UID = "1.2.826.0.1.3680043.9.7.1.1"
SOP_UID = "1.2.826.0.1.3680043.9.7.1.1.1"
SNOMED_UID = "2.16.840.1.113883.6.96"
MAPPING_RESOURCE_UID = "2.16.840.1.113883.3.26.1.1"


def make_ds(*, patient_id: str = PATIENT_ID, study_uid: str = STUDY_UID,
            series_uid: str = SERIES_UID, sop_uid: str = SOP_UID,
            study_date: str = "20240115", patient_age: str = "047Y") -> FileDataset:
    """A dataset carrying one of every kind of thing the profile has to handle."""
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.SourceApplicationEntityTitle = "STMARYS_CT1"
    ds = FileDataset("x", Dataset(), file_meta=meta, preamble=b"\0" * 128)

    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = sop_uid
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    ds.FrameOfReferenceUID = "1.2.826.0.1.3680043.9.7.1.9"

    # Direct identifiers.
    ds.PatientName = "SANCHEZ^MARIA^ELENA"
    ds.PatientID = patient_id
    ds.PatientBirthDate = "19770304"
    ds.PatientAddress = "12 Calle Mayor, Madrid"
    ds.OtherPatientIDs = "OLD-119"
    ds.PatientTelephoneNumbers = "+34 600 000 000"
    # The alternative-calendar block: the same date of birth again, in LO/CS
    # where neither the action table nor a VR-driven temporal rule looks.
    ds.add_new(0x00100033, "LO", "13560304")  # PatientBirthDateInAlternativeCalendar
    ds.add_new(0x00100034, "LO", "14451128")  # PatientDeathDateInAlternativeCalendar
    ds.add_new(0x00100035, "CS", "HIJRI")     # PatientAlternativeCalendar
    ds.add_new(0x00100012, "PN", "MARIA")     # NameToUse, added to E.1-1 after 2023
    ds.ReferringPhysicianName = "GARCIA^LUIS"
    ds.PerformingPhysicianName = "LOPEZ^ANA"
    ds.OperatorsName = "TECH^JO"
    ds.AccessionNumber = "ACC99381"
    ds.StudyDescription = "CT HEAD - MRS SANCHEZ, WARD 4"
    ds.SeriesDescription = "AXIAL 1MM"

    # Retained under the patient-characteristics option.
    ds.PatientSex = "F"
    ds.PatientAge = patient_age
    ds.PatientWeight = 61.5

    # Device / institution identity.
    ds.StationName = "CT1"
    ds.DeviceSerialNumber = "SN-88213"
    ds.InstitutionName = "St Mary's Hospital"
    ds.InstitutionAddress = "1 Hospital Road"

    # Temporal.
    ds.StudyDate = study_date
    ds.SeriesDate = study_date
    ds.StudyTime = "101530"
    ds.AcquisitionDateTime = study_date + "101530.000000+0100"

    ds.Modality = "CT"
    ds.SeriesNumber = 1
    ds.InstanceNumber = 1
    ds.BurnedInAnnotation = "NO"

    # Private block: creator plus one identifying private value.
    ds.add_new(0x00090010, "LO", "ACME_IMAGING")
    ds.add_new(0x00091001, "LO", "PATIENT=SANCHEZ MARIA")

    # Retired curve data and an overlay plane, neither expressible in the flat
    # action table.
    ds.add_new(0x50001000, "LO", "curve payload")
    ds.add_new(0x60003000, "OW", b"\x00\x01\x02\x03")

    # PHI nested inside a sequence, plus a UID that has to stay internally
    # consistent with the top-level remap.
    item = Dataset()
    item.RequestedProcedureID = "RP-77"
    item.ScheduledProcedureStepDescription = "HEAD CT FOR MRS SANCHEZ"
    item.StudyInstanceUID = study_uid
    ds.RequestAttributesSequence = [item]

    # ReferencedImageSequence is X/Z/U* — kept so nested references survive, which
    # makes it the place to prove the recursive passes actually descend.
    ref = Dataset()
    ref.ReferencedSOPClassUID = CTImageStorage
    ref.ReferencedSOPInstanceUID = "1.2.826.0.1.3680043.9.7.1.1.9"
    ref.OperatorsName = "TECH^JO"
    ref.add_new(0x00090010, "LO", "ACME_IMAGING")
    ref.add_new(0x00091001, "LO", "PATIENT=SANCHEZ MARIA")
    ds.ReferencedImageSequence = [ref]

    # Coded content: the UIDs here name SNOMED CT and a mapping resource, not
    # this study. (0008,1032) is not in Table E.1-1 at all, so the sequence
    # survives and its contents have to come out the far side resolvable.
    code = Dataset()
    code.CodeValue = "363679005"
    code.CodingSchemeDesignator = "SCT"
    code.CodeMeaning = "Imaging"
    code.add_new(0x0008010C, "UI", SNOMED_UID)       # CodingSchemeUID
    code.add_new(0x00080118, "UI", MAPPING_RESOURCE_UID)  # MappingResourceUID
    ds.ProcedureCodeSequence = [code]
    return ds


def _d(profile="basic", **kw) -> Deidentifier:
    kw.setdefault("secret", "unit-test-secret")
    return Deidentifier(profile=profile, **kw)


def _val(ds, keyword):
    return ds.get(keyword, None)


# --------------------------------------------------------------------------


def test_profile_table_matches_editor():
    """The embedded table and the browser tool's must never disagree about
    which attributes identify a patient."""
    assert load_profile_table() == _ACTIONS
    assert _ACTIONS[0x00100010] == "Z"
    assert _ACTIONS[0x00100020] == "Z/D"
    assert len(_ACTIONS) == 656


def test_alternative_calendar_dates_are_covered():
    """(0010,0033)-(0010,0035) are LO/CS, not DA. Table E.1-1 as published does
    not list them, so a real date of birth used to come out verbatim and
    unshifted under every profile."""
    for tag in (0x00100033, 0x00100034, 0x00100035):
        assert _ACTIONS[tag] == "X"
    for profile in ("basic", "strict"):
        for keep in (True, False):
            out = _d(profile, keep_dates=keep).deidentified_copy(make_ds())
            for tag in (0x00100033, 0x00100034, 0x00100035):
                assert tag not in out, "%08X survived %s/keep_dates=%s" % (
                    tag, profile, keep)


def test_table_carries_the_rows_added_since_the_2023_edition():
    """The table was generated from an extract of an older edition and was
    short 35 rows. Spot-check one from each block that was missing."""
    expected = {
        0x00081301: "X",    # PrincipalDiagnosisCodeSequence
        0x00100012: "X",    # NameToUse
        0x00100016: "X",    # PronounComment
        0x00100045: "X",    # GenderIdentityComment
        0x00102162: "X",    # EthnicGroups
        0x00181010: "X",    # SecondaryCaptureDeviceID
        0x003A0203: "X",    # ChannelLabel
        0x00400556: "X",    # AcquisitionContextDescription
        0x0040A034: "X",    # EffectiveStartDateTime
        0x0040B020: "X/D",  # WaveformAnnotationSequence
        0x0040E012: "X",    # DisplayURI
        0x00700006: "D",    # UnformattedTextValue
        0x300A0054: "U",    # TableTopPositionAlignmentUID
    }
    for tag, action in expected.items():
        assert _ACTIONS.get(tag) == action, "%08X: %r" % (tag, _ACTIONS.get(tag))
    out = _d("basic").deidentified_copy(make_ds())
    assert 0x00100012 not in out, "NameToUse survived"


def test_identifying_tags_gone_basic():
    out = _d("basic").deidentified_copy(make_ds())
    for kw in ("PatientAddress", "OtherPatientIDs", "PatientTelephoneNumbers",
               "PerformingPhysicianName", "StudyDescription", "SeriesDescription"):
        assert kw not in out, "%s survived the basic profile" % kw
    for kw in ("ReferringPhysicianName", "AccessionNumber", "PatientBirthDate",
               "OperatorsName"):
        assert not out.get(kw, None), "%s should be zero-length, got %r" % (kw, out.get(kw))
    assert "SANCHEZ" not in str(out.PatientName).upper()
    assert str(out.PatientID) != PATIENT_ID


def test_identifying_tags_gone_strict():
    out = _d("strict").deidentified_copy(make_ds())
    for kw in ("PatientAddress", "OtherPatientIDs", "PatientTelephoneNumbers",
               "StudyDescription", "InstitutionAddress"):
        assert kw not in out, "%s survived the strict profile" % kw
    assert "SANCHEZ" not in str(out.PatientName).upper()


def test_sequence_of_pure_phi_is_removed_whole():
    """(0040,0275) Request Attributes is action X: the scheduled-step detail it
    carries is worthless without the order it came from, so it goes entirely."""
    out = _d("basic").deidentified_copy(make_ds())
    assert "RequestAttributesSequence" not in out


def test_phi_nested_in_a_surviving_sequence_is_cleaned():
    out = _d("basic").deidentified_copy(make_ds())
    item = out.ReferencedImageSequence[0]
    assert not item.get("OperatorsName", None)
    assert 0x00091001 not in item, "private tags must be removed inside sequences too"
    assert 0x00090010 not in item


def test_curve_and_overlay_data_removed():
    out = _d("basic").deidentified_copy(make_ds())
    assert 0x50001000 not in out
    assert 0x60003000 not in out


def test_patient_characteristics_retained():
    out = _d("strict").deidentified_copy(make_ds())
    assert str(out.PatientSex) == "F"
    assert str(out.PatientAge) == "047Y"
    assert float(out.PatientWeight) == 61.5


def test_patient_age_capped_at_hipaa_ceiling():
    out = _d("basic").deidentified_copy(make_ds(patient_age="094Y"))
    assert str(out.PatientAge) == "089Y"


def test_device_and_institution_kept_in_basic_dropped_in_strict():
    keep = _d("basic").deidentified_copy(make_ds())
    assert str(keep.StationName) == "CT1"
    assert str(keep.DeviceSerialNumber) == "SN-88213"
    assert str(keep.InstitutionName) == "St Mary's Hospital"

    drop = _d("strict").deidentified_copy(make_ds())
    assert not drop.get("StationName", None)
    assert not drop.get("DeviceSerialNumber", None)
    assert not drop.get("InstitutionName", None)
    assert "InstitutionAddress" not in drop
    assert "SourceApplicationEntityTitle" not in drop.file_meta


# -- UID remapping ---------------------------------------------------------


def test_uid_remap_consistent_within_a_study():
    d = _d("basic")
    a = d.deidentified_copy(make_ds(sop_uid=SOP_UID + ".1"))
    b = d.deidentified_copy(make_ds(sop_uid=SOP_UID + ".2"))
    assert a.StudyInstanceUID == b.StudyInstanceUID
    assert a.SeriesInstanceUID == b.SeriesInstanceUID
    assert a.SOPInstanceUID != b.SOPInstanceUID
    assert a.StudyInstanceUID != STUDY_UID
    # A UID buried in a sequence must land on the same remapped value in every
    # object, or the two instances reference images that no longer agree.
    a_ref = str(a.ReferencedImageSequence[0].ReferencedSOPInstanceUID)
    b_ref = str(b.ReferencedImageSequence[0].ReferencedSOPInstanceUID)
    assert a_ref == b_ref and a_ref.startswith("2.25.")


def test_uid_remap_stable_across_runs():
    """Two independently constructed Deidentifiers stand in for a restart."""
    first = _d("basic").deidentified_copy(make_ds())
    second = _d("basic").deidentified_copy(make_ds())
    assert first.StudyInstanceUID == second.StudyInstanceUID
    assert first.SeriesInstanceUID == second.SeriesInstanceUID
    assert first.SOPInstanceUID == second.SOPInstanceUID
    assert first.file_meta.MediaStorageSOPInstanceUID == second.file_meta.MediaStorageSOPInstanceUID


def test_uid_remap_leaves_standard_uids_alone():
    out = _d("basic").deidentified_copy(make_ds())
    assert str(out.SOPClassUID) == str(CTImageStorage)
    assert str(out.file_meta.TransferSyntaxUID) == str(ExplicitVRLittleEndian)
    assert str(out.file_meta.MediaStorageSOPClassUID) == str(CTImageStorage)
    assert str(out.ReferencedImageSequence[0].ReferencedSOPClassUID) == str(CTImageStorage)
    assert str(out.ReferencedImageSequence[0].ReferencedSOPInstanceUID).startswith("2.25.")


def test_coded_content_uids_are_left_resolvable():
    """Remapping every UI value by VR rewrote the UIDs that name SNOMED CT and
    the mapping resource, and a recipient handed 2.25.* in their place cannot
    resolve a single coded concept in the object."""
    for profile in ("basic", "strict"):
        item = _d(profile).deidentified_copy(make_ds()).ProcedureCodeSequence[0]
        assert str(item[0x0008010C].value) == SNOMED_UID
        assert str(item[0x00080118].value) == MAPPING_RESOURCE_UID
        assert str(item.CodeValue) == "363679005"


def test_instance_uid_families_are_still_remapped():
    """The narrowed pass must not narrow to nothing: everything Table E.1-1
    marks U still has to move, at top level and nested."""
    out = _d("basic").deidentified_copy(make_ds())
    for kw in ("StudyInstanceUID", "SeriesInstanceUID", "SOPInstanceUID",
               "FrameOfReferenceUID"):
        assert str(out.get(kw)).startswith("2.25."), "%s was not remapped" % kw
    nested = out.ReferencedImageSequence[0].ReferencedSOPInstanceUID
    assert str(nested).startswith("2.25.")


def test_frame_of_reference_family_moves_with_the_frame_of_reference():
    """Table E.1-1 marks (0020,0052) U but never lists these. Left alone they
    hand over the site's OID tree and stop matching the geometry they name."""
    src = make_ds()
    src.add_new(0x00209312, "UI", src.FrameOfReferenceUID)  # VolumeFrameOfReferenceUID
    src.add_new(0x0018991E, "UI", src.FrameOfReferenceUID)  # TargetFrameOfReferenceUID
    src.add_new(0x00200242, "UI", SOP_UID)  # SOPInstanceUIDOfConcatenationSource
    out = _d("basic").deidentified_copy(src)
    assert str(out[0x00209312].value) == str(out.FrameOfReferenceUID)
    assert str(out[0x0018991E].value) == str(out.FrameOfReferenceUID)
    assert str(out[0x00200242].value) == str(out.SOPInstanceUID)
    assert str(out[0x00209312].value).startswith("2.25.")


def test_remapped_uids_are_legal_length():
    d = _d("basic")
    for src in (STUDY_UID, SERIES_UID, SOP_UID, "1.3.6.1.4.1.99999.1.2.3.4.5.6.7.8.9"):
        assert len(d.map_uid(src)) <= 64


def test_file_meta_sop_uid_follows_the_dataset():
    out = _d("basic").deidentified_copy(make_ds())
    assert str(out.file_meta.MediaStorageSOPInstanceUID) == str(out.SOPInstanceUID)


def test_different_secrets_produce_different_mappings():
    a = Deidentifier(profile="basic", secret="site-a").deidentified_copy(make_ds())
    b = Deidentifier(profile="basic", secret="site-b").deidentified_copy(make_ds())
    assert a.StudyInstanceUID != b.StudyInstanceUID
    assert a.PatientID != b.PatientID


# -- pseudonymisation ------------------------------------------------------


def test_same_patient_id_anonymises_identically_on_two_invocations():
    one = _d("basic").deidentified_copy(make_ds(study_uid=STUDY_UID + ".1"))
    two = _d("basic").deidentified_copy(make_ds(study_uid=STUDY_UID + ".2"))
    assert str(one.PatientID) == str(two.PatientID)
    assert str(one.PatientName) == str(two.PatientName)
    assert str(one.PatientID).startswith("ANON")
    assert str(one.StudyInstanceUID) != str(two.StudyInstanceUID)


def test_different_patients_get_different_pseudonyms():
    d = _d("basic")
    a = d.deidentified_copy(make_ds(patient_id="MRN-1"))
    b = d.deidentified_copy(make_ds(patient_id="MRN-2"))
    assert str(a.PatientID) != str(b.PatientID)


def test_blank_patient_id_does_not_merge_two_patients():
    """A blank PatientID must fall back to the study, or every unidentified
    patient collapses into one anonymised person."""
    d = _d("basic")
    a = d.deidentified_copy(make_ds(patient_id="", study_uid=STUDY_UID + ".81"))
    b = d.deidentified_copy(make_ds(patient_id="", study_uid=STUDY_UID + ".82"))
    assert str(a.PatientID) != str(b.PatientID)


def test_prefix_is_honoured():
    out = Deidentifier(profile="basic", prefix="RESEARCH", secret="s").deidentified_copy(make_ds())
    assert str(out.PatientID).startswith("RESEARCH")


# -- dates -----------------------------------------------------------------


def _as_date(v) -> datetime.date:
    s = str(v)
    return datetime.date(int(s[:4]), int(s[4:6]), int(s[6:8]))


def test_dates_are_shifted_not_blanked():
    out = _d("basic").deidentified_copy(make_ds())
    assert out.StudyDate and str(out.StudyDate) != "20240115"
    assert len(str(out.StudyDate)) == 8
    assert str(out.AcquisitionDateTime).endswith(".000000+0100")
    assert str(out.AcquisitionDateTime)[:8] == str(out.StudyDate)
    # The date and datetime attributes still agree with each other, in both
    # halves — an object that contradicts itself is its own kind of failure.
    assert str(out.AcquisitionDateTime)[8:14] == str(out.StudyTime)


def test_clock_times_are_not_moved():
    """The offset is a whole number of days, so a clock time shifts onto
    itself. Moving the clock as well is what the module cannot do and stay
    honest: see test_a_dateless_time_cannot_carry_and_so_nothing_does."""
    out = _d("basic").deidentified_copy(make_ds())
    assert str(out.StudyTime) == "101530"
    assert str(out.AcquisitionDateTime)[8:14] == "101530"
    assert str(out.StudyDate) != "20240115", "the date is what moves"


def test_time_precision_and_fraction_survive():
    src = make_ds()
    src.StudyTime = "10"                       # hour precision
    src.SeriesTime = "101530.250000"           # fractional seconds
    out = _d("basic").deidentified_copy(src)
    assert str(out.StudyTime) == "10"
    assert str(out.SeriesTime) == "101530.250000"


def test_study_and_series_keep_their_interval_across_midnight():
    """The reported regression, exactly as reported. A clock offset that wrapped
    at midnight without carrying turned a 30-minute study/series gap into
    -23.5 h, while the object went on asserting 113107."""
    src = Dataset()
    src.PatientID = "P070"
    src.StudyDate, src.StudyTime = "20240115", "100000"
    src.SeriesDate, src.SeriesTime = "20240115", "103000"
    out = Deidentifier(profile="basic", secret="s3cret").deidentified_copy(src)
    gap = _instant(out.SeriesDate, out.SeriesTime) - _instant(out.StudyDate, out.StudyTime)
    assert gap == datetime.timedelta(minutes=30), \
        "series landed %s from the study (was +0:30:00)" % gap
    assert str(out.StudyTime) == "100000" and str(out.SeriesTime) == "103000"
    assert str(out.StudyDate) == str(out.SeriesDate)


def test_a_dateless_time_cannot_carry_and_so_nothing_does():
    """(0008,0012) InstanceCreationDate has no time beside it to carry from.
    Any offset with a sub-day component moves the values that *can* carry off
    the ones that cannot, and the object starts contradicting itself — which is
    the reason the offset is whole days."""
    src = Dataset()
    src.PatientID = "P070"
    src.InstanceCreationDate = "20240115"          # bare DA, no partner time
    src.StudyDate, src.StudyTime = "20240115", "000500"   # would carry back a day
    src.AcquisitionDateTime = "20240115000500.000000+0100"
    out = Deidentifier(profile="basic", secret="s3cret").deidentified_copy(src)
    assert str(out.InstanceCreationDate) == str(out.StudyDate)
    assert str(out.AcquisitionDateTime)[:8] == str(out.StudyDate)


def test_datetime_keeps_its_timezone():
    src = make_ds()
    src.AcquisitionDateTime = "20240115101530.250000-0430"
    out = _d("basic").deidentified_copy(src)
    assert str(out.AcquisitionDateTime).endswith("101530.250000-0430")
    assert str(out.AcquisitionDateTime)[:8] == str(out.StudyDate)


def test_datetime_shift_carries_through_the_calendar():
    """A DT is shifted as one moment, not as two independent halves. Leap day
    and month end are where doing it by hand goes wrong."""
    src = Dataset()
    src.PatientID = "CAL-1"
    src.AcquisitionDateTime = "20240301235959.999999+0000"
    d = _d("basic")
    out = d.deidentified_copy(src)
    moved = _instant(str(out.AcquisitionDateTime)[:8], str(out.AcquisitionDateTime)[8:14])
    expected = datetime.datetime(2024, 3, 1, 23, 59, 59) + \
        datetime.timedelta(days=d.date_offset("pid:CAL-1"))
    assert moved == expected
    assert str(out.AcquisitionDateTime).endswith(".999999+0000")


# The statistical proof. A few hundred synthetic patients with realistic
# date/time spreads, every temporal value reconstructed the way a recipient
# would, and every interval compared against the original. One patient going
# through cleanly proves nothing here: the wrapping bug only bit when a study's
# values straddled the shifted midnight, which is why the corpus is checked for
# containing enough of those to have caught it.

_MARKS = (("Study", 0), ("Series", 30 * 60), ("Acquisition", 45 * 60),
          ("Content", 50 * 60))


def _instant(date_v, time_v) -> datetime.datetime:
    """Rebuild an absolute moment from a DA/TM pair, as a recipient must."""
    d, t = str(date_v), str(time_v).partition(".")[0]
    return datetime.datetime(int(d[0:4]), int(d[4:6]), int(d[6:8]),
                             int(t[0:2]), int(t[2:4]), int(t[4:6]))


def _temporal_corpus(n: int = 400):
    """n patients, three visits each, spread over six years and the full clock.

    Every eighth patient starts at 23:2x so the study itself crosses midnight —
    the shape that made date and time disagree.
    """
    rng = random.Random(20240115)
    out = []
    for i in range(n):
        day = datetime.datetime(2019, 1, 1) + datetime.timedelta(days=rng.randrange(2200))
        if i % 8 == 0:
            start = day.replace(hour=23, minute=rng.randrange(20, 60), second=rng.randrange(60))
        else:
            start = day.replace(hour=rng.randrange(24), minute=rng.randrange(60),
                                second=rng.randrange(60))
        visits = [start,
                  start + datetime.timedelta(days=37, hours=rng.randrange(-6, 7)),
                  start + datetime.timedelta(days=181, hours=rng.randrange(-6, 7))]
        out.append(("P%04d" % i, visits))
    return out


def _visit_ds(patient_id: str, start: datetime.datetime) -> Dataset:
    ds = Dataset()
    ds.PatientID = patient_id
    for name, offset in _MARKS:
        moment = start + datetime.timedelta(seconds=offset)
        setattr(ds, name + "Date", moment.strftime("%Y%m%d"))
        setattr(ds, name + "Time", moment.strftime("%H%M%S"))
    acq = start + datetime.timedelta(seconds=45 * 60)
    ds.AcquisitionDateTime = acq.strftime("%Y%m%d%H%M%S") + ".000000+0100"
    ds.InstanceCreationDate = start.strftime("%Y%m%d")  # bare DA, no partner
    return ds


def test_every_interval_survives_across_hundreds_of_patients():
    d = _d("basic")
    corpus = _temporal_corpus()
    straddled = 0
    for patient_id, visits in corpus:
        shift = None
        for start in visits:
            src = _visit_ds(patient_id, start)
            if src.StudyDate != src.ContentDate:
                straddled += 1
            out = d.deidentified_copy(src)

            # Every value in the object moved by one identical offset — which
            # is a stronger statement than "the intervals happen to match", and
            # it is the statement 113107 makes.
            for name, offset in _MARKS:
                moved = _instant(out[name + "Date"].value, out[name + "Time"].value)
                delta = moved - (start + datetime.timedelta(seconds=offset))
                if shift is None:
                    shift = delta
                assert delta == shift, "%s %s moved %s, everything else %s" % (
                    patient_id, name, delta, shift)

            # The bare date with no time beside it moved by the same offset.
            bare = _instant(out.InstanceCreationDate, "000000")
            assert bare - start.replace(hour=0, minute=0, second=0) == shift

            # The DT agrees with the DA/TM pair naming the same moment, keeps
            # its fraction and keeps its timezone.
            dt = str(out.AcquisitionDateTime)
            assert dt.endswith(".000000+0100"), dt
            assert _instant(dt[:8], dt[8:14]) == \
                _instant(out.AcquisitionDate, out.AcquisitionTime)

            # No clock time may leave the building out of range.
            for name, _ in _MARKS:
                t = str(out[name + "Time"].value)
                assert int(t[0:2]) < 24 and int(t[2:4]) < 60 and int(t[4:6]) < 60, t

        # A whole-day offset, so no clock time moved at all...
        assert shift.seconds == 0 and shift.microseconds == 0, shift
        # ...and the same offset carried across every visit of this patient, so
        # the 37- and 181-day follow-up intervals are intact.
        assert shift.days == d.date_offset("pid:" + patient_id)

    assert len(corpus) == 400
    assert straddled >= 80, "corpus stopped exercising the midnight case (%d)" % straddled


def test_gps_time_stamp_is_not_covered_by_the_temporal_option():
    """(0016,0077) is a DT with action X and no entry in either temporal
    column. Retaining every DT by VR kept it, and it pins an acquisition to a
    second — next to the GPS latitude/longitude in the same block."""
    src = make_ds()
    src.add_new(0x00160077, "DT", "20240115101530")
    for keep in (True, False):
        out = _d("basic", keep_dates=keep).deidentified_copy(src)
        assert 0x00160077 not in out


def test_date_shift_is_consistent_per_patient_and_preserves_intervals():
    d = _d("basic")
    a = d.deidentified_copy(make_ds(study_date="20200101", study_uid=STUDY_UID + ".81"))
    b = d.deidentified_copy(make_ds(study_date="20200311", study_uid=STUDY_UID + ".82"))
    original_gap = (_as_date("20200311") - _as_date("20200101")).days
    assert (_as_date(b.StudyDate) - _as_date(a.StudyDate)).days == original_gap == 70
    # Every date attribute in one object moves by the same offset.
    assert str(a.SeriesDate) == str(a.StudyDate)


def test_date_shift_differs_between_patients():
    d = _d("basic")
    a = d.deidentified_copy(make_ds(patient_id="MRN-A"))
    b = d.deidentified_copy(make_ds(patient_id="MRN-B"))
    assert str(a.StudyDate) != str(b.StudyDate)


def test_date_shift_is_stable_across_runs():
    assert str(_d("basic").deidentified_copy(make_ds()).StudyDate) == \
           str(_d("basic").deidentified_copy(make_ds()).StudyDate)


def test_keep_dates_leaves_dates_alone():
    out = _d("basic", keep_dates=True).deidentified_copy(make_ds())
    assert str(out.StudyDate) == "20240115"
    assert str(out.StudyTime) == "101530"
    assert str(out.AcquisitionDateTime) == "20240115101530.000000+0100"
    assert str(out.LongitudinalTemporalInformationModified) == "UNMODIFIED"


def test_birth_date_is_not_covered_by_the_temporal_option():
    for keep in (True, False):
        out = _d("basic", keep_dates=keep).deidentified_copy(make_ds())
        assert not out.get("PatientBirthDate", None)


# -- private attributes ----------------------------------------------------


def test_private_tags_removed_by_default():
    out = _d("basic").deidentified_copy(make_ds())
    assert 0x00091001 not in out
    assert 0x00090010 not in out


def test_private_tags_kept_when_asked():
    out = _d("basic", keep_private=True).deidentified_copy(make_ds())
    assert str(out[0x00091001].value) == "PATIENT=SANCHEZ MARIA"


def test_private_information_in_the_file_meta_is_removed():
    """Group 2 is outside Table E.1-1 and outside the recursive passes, so it
    needs its own handling or a vendor blob rides out in the Part-10 header."""
    src = make_ds()
    src.file_meta.add_new(0x00020100, "UI", "1.2.826.0.1.3680043.9.7.99")
    src.file_meta.add_new(0x00020102, "OB", b"NAME=SANCHEZ")
    out = _d("basic").deidentified_copy(src)
    assert 0x00020100 not in out.file_meta
    assert 0x00020102 not in out.file_meta


def test_keep_private_downgrades_the_identity_removed_claim():
    out = _d("basic", keep_private=True).deidentified_copy(make_ds())
    assert str(out.PatientIdentityRemoved) == "NO"
    assert any("PRIVATE" in str(m) for m in out.DeidentificationMethod)


def test_strict_removes_private_even_when_keep_private_is_set():
    d = _d("strict", keep_private=True)
    assert d.keep_private is False
    out = d.deidentified_copy(make_ds())
    assert 0x00091001 not in out
    assert str(out.PatientIdentityRemoved) == "YES"


# -- evidence attributes ---------------------------------------------------


def test_evidence_attributes_are_set():
    out = _d("basic").deidentified_copy(make_ds())
    assert str(out.PatientIdentityRemoved) == "YES"
    assert out.DeidentificationMethod
    codes = [str(i.CodeValue) for i in out.DeidentificationMethodCodeSequence]
    assert "113100" in codes                       # Basic Profile
    assert "113107" in codes                       # modified dates
    assert "113108" in codes                       # patient characteristics
    assert "113109" in codes and "113112" in codes  # device + institution
    for item in out.DeidentificationMethodCodeSequence:
        assert str(item.CodingSchemeDesignator) == "DCM"
        assert str(item.CodeMeaning)
    assert str(out.LongitudinalTemporalInformationModified) == "MODIFIED"
    # The pixel caveat travels with the object, not just with the docs.
    assert any("PIXEL DATA NOT CLEANED" in str(m) for m in out.DeidentificationMethod)


def test_strict_does_not_claim_the_retain_options_it_dropped():
    out = _d("strict").deidentified_copy(make_ds())
    codes = [str(i.CodeValue) for i in out.DeidentificationMethodCodeSequence]
    assert "113109" not in codes and "113112" not in codes
    assert "113100" in codes


def test_keep_private_drops_the_basic_profile_claim():
    """The Basic Profile requires private attributes removed. Asserting 113100
    while forwarding them unvetted misleads every machine that reads the code
    sequence instead of the free text."""
    out = _d("basic", keep_private=True).deidentified_copy(make_ds())
    codes = [str(i.CodeValue) for i in out.DeidentificationMethodCodeSequence]
    assert "113100" not in codes
    assert not any("Basic Application Confidentiality Profile" in str(m)
                   for m in out.DeidentificationMethod)
    # The retain options are still true statements about what was done.
    assert "113107" in codes and "113108" in codes
    assert str(out.PatientIdentityRemoved) == "NO"


def test_full_dates_option_declared_when_keeping_dates():
    out = _d("basic", keep_dates=True).deidentified_copy(make_ds())
    codes = [str(i.CodeValue) for i in out.DeidentificationMethodCodeSequence]
    assert "113106" in codes and "113107" not in codes


def test_the_object_says_the_clock_did_not_move():
    """113107 on its own lets a recipient assume the times were shifted too, and
    they were not — the offset is whole days so the intervals survive. PS3.15
    E.3.6 wants the manner of modification described; describing it here is the
    only version of that a receiving system ever reads, and it is what makes the
    coded evidence a complete statement rather than a half-true one."""
    out = _d("basic").deidentified_copy(make_ds())
    text = [str(m) for m in out.DeidentificationMethod]
    said = [m for m in text if "CLOCK TIMES KEPT" in m]
    assert said, text
    assert "DATES SHIFTED" in said[0]
    assert all(len(m) <= 64 for m in text), text     # LO, 64 bytes per value
    # It is a statement about what this run did, so it must not appear on a run
    # that did not shift anything.
    kept = _d("basic", keep_dates=True).deidentified_copy(make_ds())
    assert not any("CLOCK TIMES KEPT" in str(m) for m in kept.DeidentificationMethod)


# -- the original must survive untouched -----------------------------------


def test_source_dataset_is_not_mutated():
    src = make_ds()
    before = copy.deepcopy(src)
    _d("basic").deidentified_copy(src)
    assert str(src.PatientName) == str(before.PatientName)
    assert str(src.PatientID) == PATIENT_ID
    assert str(src.StudyInstanceUID) == STUDY_UID
    assert 0x00091001 in src
    assert str(src.StudyDate) == "20240115"
    assert "PatientIdentityRemoved" not in src


def test_source_file_on_disk_is_byte_identical_afterwards():
    tmpdir = tempfile.mkdtemp(prefix="deid-test-")
    try:
        path = os.path.join(tmpdir, "original.dcm")
        write_dataset(make_ds(), path)
        with open(path, "rb") as fh:
            before = hashlib.sha256(fh.read()).hexdigest()

        ds = dcmread(path)
        out = _d("strict").deidentified_copy(ds)
        assert str(out.PatientID) != PATIENT_ID

        with deidentified_tempfile(path, _d("basic")) as anon_path:
            assert os.path.exists(anon_path)
            assert os.path.abspath(anon_path) != os.path.abspath(path)

        with open(path, "rb") as fh:
            after = hashlib.sha256(fh.read()).hexdigest()
        assert before == after
    finally:
        _rmtree(tmpdir)


# -- the temp-file helper --------------------------------------------------


def test_tempfile_helper_writes_a_readable_copy_and_cleans_up():
    tmpdir = tempfile.mkdtemp(prefix="deid-test-")
    try:
        path = os.path.join(tmpdir, "in.dcm")
        write_dataset(make_ds(), path)
        with deidentified_tempfile(path, _d("basic")) as anon:
            held = anon
            re_read = dcmread(anon)
            assert str(re_read.PatientID).startswith("ANON")
            assert str(re_read.PatientID) != PATIENT_ID
            assert str(re_read.file_meta.MediaStorageSOPInstanceUID) == str(re_read.SOPInstanceUID)
            assert 0x00091001 not in re_read
        assert not os.path.exists(held), "temp copy was left behind"
    finally:
        _rmtree(tmpdir)


def test_tempfile_helper_is_a_passthrough_when_disabled():
    tmpdir = tempfile.mkdtemp(prefix="deid-test-")
    try:
        path = os.path.join(tmpdir, "in.dcm")
        write_dataset(make_ds(), path)
        with deidentified_tempfile(path, None) as p:
            assert p == path
        assert os.path.exists(path)
    finally:
        _rmtree(tmpdir)


# -- config wiring ---------------------------------------------------------


def test_no_phi_string_survives_anywhere_in_the_written_file():
    """Attribute-by-attribute assertions can miss a copy of the name sitting in
    an element nobody thought to check. Grep the bytes instead."""
    tmpdir = tempfile.mkdtemp(prefix="deid-test-")
    try:
        out = _d("strict").deidentified_copy(make_ds())
        path = os.path.join(tmpdir, "anon.dcm")
        write_dataset(out, path)
        with open(path, "rb") as fh:
            blob = fh.read().upper()
        for phi in (b"SANCHEZ", b"MRN-004471", b"MADRID", b"GARCIA", b"LOPEZ",
                    b"ACC99381", b"ST MARY", b"600 000 000", b"WARD 4",
                    b"SN-88213", b"STMARYS_CT1", b"19770304",
                    b"13560304", b"14451128", b"HIJRI"):
            assert phi not in blob, "%r survived into the forwarded file" % phi
        # And the study is still readable and still a CT.
        again = dcmread(path)
        assert str(again.Modality) == "CT"
    finally:
        _rmtree(tmpdir)


def test_pixel_data_survives_untouched():
    """The profile must never damage the image itself — and deepcopy must not
    balloon memory by duplicating the payload, which it does not for bytes."""
    src = make_ds()
    src.Rows = 4
    src.Columns = 4
    src.BitsAllocated = 8
    src.SamplesPerPixel = 1
    src.PhotometricInterpretation = "MONOCHROME2"
    src.PixelData = bytes(range(16))
    out = _d("strict").deidentified_copy(src)
    assert out.PixelData == bytes(range(16))
    assert out.PixelData is src.PixelData
    assert int(out.Rows) == 4


def test_dataset_without_file_meta_is_handled():
    """StorageSCP hands over event.dataset, which has no file meta of its own
    until the receiver attaches one."""
    src = make_ds()
    bare = Dataset()
    for elem in src:
        bare.add(elem)
    out = _d("basic").deidentified_copy(bare)
    assert str(out.PatientID).startswith("ANON")
    assert str(out.SOPInstanceUID).startswith("2.25.")


def test_from_config_returns_none_when_off():
    assert Deidentifier.from_config({"profile": "off"}) is None


def test_from_config_reads_every_knob():
    d = Deidentifier.from_config({"profile": "strict", "keep_private": False,
                                  "keep_dates": True, "prefix": "STUDY7",
                                  "secret": "abc"})
    assert d.profile == "strict" and d.keep_dates is True and d.prefix == "STUDY7"
    assert str(d.deidentified_copy(make_ds()).PatientID).startswith("STUDY7")


def test_off_profile_never_touches_anything():
    d = Deidentifier(profile="off")
    src = make_ds()
    assert d.enabled is False
    assert d.deidentified_copy(src) is src
    assert str(src.PatientID) == PATIENT_ID


def test_unknown_profile_is_rejected():
    try:
        Deidentifier(profile="paranoid")
    except ValueError:
        return
    raise AssertionError("an unknown profile must not be accepted silently")


def test_failure_raises_rather_than_returning_half_scrubbed_data():
    class Exploding(Deidentifier):
        def _apply_profile(self, ds):
            raise RuntimeError("boom")

    try:
        Exploding(profile="basic").deidentified_copy(make_ds())
    except DeidError:
        return
    raise AssertionError("a de-identification failure must surface as DeidError")


def test_warnings_are_logged_once_per_study():
    class Log:
        def __init__(self):
            self.lines = []

        def warn(self, msg, **f):
            self.lines.append(msg)

        def info(self, msg, **f):
            self.lines.append(msg)

    log = Log()
    d = Deidentifier(profile="basic", secret="s", log=log)
    for n in range(5):
        ds = make_ds(sop_uid=SOP_UID + ".%d" % n)
        ds.BurnedInAnnotation = "YES"
        d.deidentified_copy(ds)
    burned = [ln for ln in log.lines if "burned-in" in ln]
    assert len(burned) == 1, "expected one warning per study, got %d" % len(burned)


def _rmtree(path: str) -> None:
    import shutil
    shutil.rmtree(path, ignore_errors=True)


if __name__ == "__main__":
    fns = [(n, f) for n, f in sorted(globals().items())
           if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in fns:
        t0 = time.time()
        try:
            fn()
            print(f"  ok   {name}  ({time.time() - t0:.2f}s)")
        except BaseException as exc:
            failed += 1
            print(f"  FAIL {name}: {type(exc).__name__}: {exc}")
            import traceback
            traceback.print_exc()
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
