"""Tests for pacs.history (the study browser behind the dashboard's history).

Characterisation, not specification: every assertion here pins what
``scan_studies`` returns TODAY, field by field, because the dashboard and the
delete path read those exact keys and an optimisation that changes the shape is
indistinguishable from an optimisation that loses a study. Where the current
answer looks wrong (string-sorted series numbers, a garbage file with DICM magic
becoming a study), the test says so in a comment and pins it anyway — a
rewrite that quietly fixes one of those is still a behaviour change and should
have to say it is.

Runs under pytest, or directly:  python3 tests/test_history.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

from pacs import history
from pacs.dicomfs import safe_within, save_dicom
from pacs.history import delete_study, scan_studies, study_files

# Whole seconds, so a directory mtime survives the round trip through utime and
# os.path.getmtime as an exact float and the ordering tests can compare ==.
T0 = 1700000000.0

FIELDS = ["instances", "modality", "mtime", "path", "patient", "patient_id",
          "series", "study_date", "study_desc", "study_uid"]


def write_instance(path, *, patient_name="DOE^JANE", patient_id="P001",
                   study_uid="1.2.3", series_uid="1.2.3.1", modality="CT",
                   study_date="20240115", study_desc="Head CT",
                   series_desc="Axial", series_number=1, instance_number=1):
    """One real Part 10 file. Any keyword passed as None omits its tag, which is
    how the "no Modality" and "no StudyInstanceUID" cases are built."""
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset("x", Dataset(), file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.SeriesInstanceUID = series_uid
    ds.InstanceNumber = instance_number
    for tag, value in (("StudyInstanceUID", study_uid), ("PatientName", patient_name),
                       ("PatientID", patient_id), ("StudyDate", study_date),
                       ("StudyDescription", study_desc), ("Modality", modality),
                       ("SeriesDescription", series_desc),
                       ("SeriesNumber", series_number)):
        if value is not None:
            setattr(ds, tag, value)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    save_dicom(ds, path)
    return path


def write_junk(path, data=b"this is not a DICOM file"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    return path


def stamp(path, when):
    os.utime(path, (when, when))
    return path


def one(root, **kw):
    """The single study under *root*, asserted to be the only one."""
    out = scan_studies(root, **kw)
    assert len(out) == 1, out
    return out[0]


# ------------------------------------------------------------ the whole record
def test_a_study_in_one_directory_reports_every_field():
    with tempfile.TemporaryDirectory() as tmp:
        d = os.path.join(tmp, "P001", "study", "series")
        for i in (1, 2, 3):
            write_instance(os.path.join(d, f"{i}.dcm"), instance_number=i)
        stamp(d, T0)

        st = one(tmp)
        # The key set is the contract the dashboard renders from; an extra key is
        # as much of a change as a missing one.
        assert sorted(st) == FIELDS, sorted(st)
        assert st["patient"] == "JANE DOE"
        assert st["patient_id"] == "P001"
        assert st["study_date"] == "2024-01-15"
        assert st["study_desc"] == "Head CT"
        assert st["study_uid"] == "1.2.3"
        assert st["series"] == [{"desc": "Axial", "modality": "CT",
                                 "number": "1", "count": 3}]
        assert st["instances"] == 3
        assert st["path"] == d
        assert st["modality"] == "CT"
        assert st["mtime"] == T0
        # SeriesNumber arrives as an int and leaves as a string.
        assert isinstance(st["series"][0]["number"], str)
        assert isinstance(st["mtime"], float)


def test_a_study_spanning_several_directories_collapses_to_their_commonpath():
    with tempfile.TemporaryDirectory() as tmp:
        study = os.path.join(tmp, "P001", "study")
        a = os.path.join(study, "ct")
        b = os.path.join(study, "sr")
        write_instance(os.path.join(a, "1.dcm"), series_uid="1.2.3.1")
        write_instance(os.path.join(a, "2.dcm"), series_uid="1.2.3.1")
        write_instance(os.path.join(b, "1.dcm"), series_uid="1.2.3.2", modality="SR",
                       series_desc="Report", series_number=2)
        stamp(a, T0)
        stamp(b, T0 + 60)

        st = one(tmp)
        assert st["path"] == study            # the parent holds no files itself
        assert st["instances"] == 3
        assert st["modality"] == "CT,SR"      # comma-joined, sorted, distinct
        assert st["mtime"] == T0 + 60         # the newest of the dirs it spans
        assert st["series"] == [
            {"desc": "Axial", "modality": "CT", "number": "1", "count": 2},
            {"desc": "Report", "modality": "SR", "number": "2", "count": 1}]


def test_studies_in_unrelated_trees_still_share_a_uid_and_a_commonpath():
    # commonpath of two branches that only meet at the root gives the root back,
    # so "path" for a split study can be the whole storage folder — and that is
    # the path the delete button would act on.
    with tempfile.TemporaryDirectory() as tmp:
        a = os.path.join(tmp, "incoming", "aaa")
        b = os.path.join(tmp, "archive", "bbb")
        write_instance(os.path.join(a, "1.dcm"))
        write_instance(os.path.join(b, "1.dcm"), series_uid="1.2.3.2", series_number=2)
        stamp(a, T0)
        stamp(b, T0)

        st = one(tmp)
        assert st["path"] == tmp
        assert st["instances"] == 2


# -------------------------------------------------------------- several studies
def _three_studies(tmp):
    dirs = []
    for n, when in ((1, T0), (2, T0 + 300), (3, T0 + 600)):
        d = os.path.join(tmp, f"P00{n}", "study")
        write_instance(os.path.join(d, "1.dcm"), patient_id=f"P00{n}",
                       patient_name=f"DOE^{n}", study_uid=f"1.2.{n}",
                       series_uid=f"1.2.{n}.1")
        dirs.append(stamp(d, when))
    return dirs


def test_studies_come_back_newest_directory_first():
    with tempfile.TemporaryDirectory() as tmp:
        _three_studies(tmp)
        out = scan_studies(tmp)
        assert [s["patient_id"] for s in out] == ["P003", "P002", "P001"]
        assert [s["mtime"] for s in out] == [T0 + 600, T0 + 300, T0]


def test_max_studies_caps_after_sorting_so_it_keeps_the_newest():
    with tempfile.TemporaryDirectory() as tmp:
        _three_studies(tmp)
        assert [s["patient_id"] for s in scan_studies(tmp, max_studies=2)] == \
            ["P003", "P002"]
        assert [s["patient_id"] for s in scan_studies(tmp, max_studies=1)] == ["P003"]
        # Zero is a real cap, not "unlimited".
        assert scan_studies(tmp, max_studies=0) == []
        assert len(scan_studies(tmp, max_studies=99)) == 3


# ------------------------------------------------------- what is and is not DICOM
def test_files_without_the_dicm_magic_are_not_counted():
    with tempfile.TemporaryDirectory() as tmp:
        d = os.path.join(tmp, "study")
        write_instance(os.path.join(d, "1.dcm"))
        write_instance(os.path.join(d, "2.dcm"))
        write_junk(os.path.join(d, "notes.txt"))
        write_junk(os.path.join(d, "report.pdf"), b"%PDF-1.4\n" + b"0" * 300)
        write_junk(os.path.join(d, "3.dcm"))       # a .dcm extension proves nothing
        stamp(d, T0)

        st = one(tmp)
        assert st["instances"] == 2
        assert st["series"][0]["count"] == 2


def test_the_header_comes_from_the_first_dicom_and_the_rest_are_still_counted():
    # Counting a folder and picking the file that describes it share one pass,
    # and the two halves fail in opposite directions: a header taken from the
    # wrong file renames the series, a count that stopped where the header was
    # found loses instances. Junk sorts ahead of every instance here and a
    # second instance sorts behind them, so neither mistake can go unnoticed.
    with tempfile.TemporaryDirectory() as tmp:
        d = os.path.join(tmp, "study")
        write_junk(os.path.join(d, "0-README.txt"))
        write_junk(os.path.join(d, "1-cover.dcm"))
        write_instance(os.path.join(d, "2.dcm"), series_desc="Axial", series_number=1)
        write_instance(os.path.join(d, "3.dcm"), series_desc="Later", series_number=9)
        stamp(d, T0)

        st = one(tmp)
        assert st["series"] == [{"desc": "Axial", "modality": "CT",
                                 "number": "1", "count": 2}]
        assert st["instances"] == 2


def test_dot_files_are_skipped_and_a_dot_only_directory_disappears():
    with tempfile.TemporaryDirectory() as tmp:
        d = os.path.join(tmp, "study")
        write_instance(os.path.join(d, "1.dcm"))
        write_instance(os.path.join(d, ".partial.dcm"))     # a real DICOM, hidden
        stamp(d, T0)
        sidecar = os.path.join(tmp, "sidecars")
        write_instance(os.path.join(sidecar, ".only.dcm"))

        out = scan_studies(tmp)
        assert len(out) == 1, out
        assert out[0]["path"] == d
        assert out[0]["instances"] == 1


def test_a_hidden_directory_is_still_walked():
    # os.walk is not pruned on dirnames, so only hidden FILES are skipped: a
    # study parked in a dot-folder shows up in the browser. It is also the one
    # thing delete_all deliberately leaves alone, so the two disagree.
    with tempfile.TemporaryDirectory() as tmp:
        d = os.path.join(tmp, ".staging", "study")
        write_instance(os.path.join(d, "1.dcm"))
        stamp(d, T0)
        assert one(tmp)["path"] == d


def test_a_directory_with_no_dicom_at_all_is_skipped_entirely():
    with tempfile.TemporaryDirectory() as tmp:
        junk = os.path.join(tmp, "junk")
        write_junk(os.path.join(junk, "a.txt"))
        write_junk(os.path.join(junk, "b.dcm"))
        os.makedirs(os.path.join(tmp, "empty"))
        good = os.path.join(tmp, "study")
        write_instance(os.path.join(good, "1.dcm"))
        stamp(good, T0)

        out = scan_studies(tmp)
        assert [s["path"] for s in out] == [good]


def test_a_file_with_dicm_magic_and_a_garbage_body_becomes_an_empty_study():
    # dcmread(force=True) does not fail on a truncated or corrupt file, it hands
    # back a Dataset with nothing in it, so the "no readable header" skip is only
    # ever reached when NOTHING in the directory carries the magic. The result is
    # a study row with a blank patient, a blank UID and "?" for modality, keyed
    # on the parent directory. Pinned as-is; it is what the dashboard shows now.
    with tempfile.TemporaryDirectory() as tmp:
        d = os.path.join(tmp, "corrupt")
        write_junk(os.path.join(d, "a.dcm"), b"\0" * 128 + b"DICM" + b"\xff" * 200)
        stamp(d, T0)

        st = one(tmp)
        assert st["study_uid"] == ""
        assert st["patient"] == "" and st["patient_id"] == ""
        assert st["study_date"] == "" and st["study_desc"] == ""
        assert st["modality"] == "?"
        assert st["instances"] == 1
        assert st["path"] == d


# --------------------------------------------------------------- grouping keys
def test_a_study_with_no_uid_is_keyed_on_the_parent_directory():
    # Two sibling folders under one parent merge into a single study; the same
    # two folders under different parents do not.
    with tempfile.TemporaryDirectory() as tmp:
        parent = os.path.join(tmp, "unidentified")
        for name in ("a", "b"):
            d = os.path.join(parent, name)
            write_instance(os.path.join(d, "1.dcm"), study_uid=None)
            stamp(d, T0)
        elsewhere = os.path.join(tmp, "other", "c")
        write_instance(os.path.join(elsewhere, "1.dcm"), study_uid=None)
        stamp(elsewhere, T0)

        out = scan_studies(tmp)
        assert len(out) == 2, out
        merged = [s for s in out if s["path"] == parent][0]
        assert merged["instances"] == 2 and len(merged["series"]) == 2
        assert merged["study_uid"] == ""


def test_one_series_entry_per_directory_not_per_series_uid():
    # The header is read once per DIRECTORY, so the directory is the unit: two
    # folders of one series report twice, and two series sharing a folder report
    # once — under whichever file sorts first, with the whole folder's count.
    with tempfile.TemporaryDirectory() as tmp:
        split = os.path.join(tmp, "split")
        for half in ("part1", "part2"):
            d = os.path.join(split, half)
            write_instance(os.path.join(d, "1.dcm"), series_uid="1.2.3.1")
            stamp(d, T0)
        st = one(tmp)
        assert len(st["series"]) == 2
        assert [s["count"] for s in st["series"]] == [1, 1]

    with tempfile.TemporaryDirectory() as tmp:
        d = os.path.join(tmp, "mixed")
        write_instance(os.path.join(d, "1.dcm"), series_uid="1.2.3.1",
                       series_desc="Axial", series_number=1)
        write_instance(os.path.join(d, "2.dcm"), series_uid="1.2.3.2", modality="SR",
                       series_desc="Report", series_number=2)
        stamp(d, T0)
        st = one(tmp)
        assert st["series"] == [{"desc": "Axial", "modality": "CT",
                                 "number": "1", "count": 2}]
        assert st["instances"] == 2
        # The SR file was counted but its modality never was: only the header
        # that was actually read contributes to the modality column.
        assert st["modality"] == "CT"


def test_series_sort_by_number_then_description():
    with tempfile.TemporaryDirectory() as tmp:
        study = os.path.join(tmp, "study")
        for number, desc in ((2, "Sagittal"), (10, "Coronal"), (2, "Axial")):
            d = os.path.join(study, f"{number}-{desc}")
            write_instance(os.path.join(d, "1.dcm"), series_number=number,
                           series_desc=desc)
            stamp(d, T0)

        st = one(tmp)
        # Both keys are strings, so "10" sorts before "2" — series 10 is listed
        # first. Numeric order would read 2, 2, 10. Pinned, not endorsed.
        assert [(s["number"], s["desc"]) for s in st["series"]] == [
            ("10", "Coronal"), ("2", "Axial"), ("2", "Sagittal")]


def test_a_study_with_no_modality_falls_back_to_a_question_mark():
    with tempfile.TemporaryDirectory() as tmp:
        d = os.path.join(tmp, "study")
        write_instance(os.path.join(d, "1.dcm"), modality=None)
        stamp(d, T0)

        st = one(tmp)
        assert st["modality"] == "?"        # the study column
        assert st["series"][0]["modality"] == ""    # the series row stays blank


# ---------------------------------------------------------------- formatting
def test_patient_name_formatting():
    assert history._fmt_name("Doe^Jane^Q^Dr^MD") == "Jane Doe"
    assert history._fmt_name("Doe^Jane") == "Jane Doe"
    assert history._fmt_name("MADONNA") == "MADONNA"        # no caret at all
    assert history._fmt_name("Doe^") == "Doe"
    assert history._fmt_name("^Jane") == "Jane"
    assert history._fmt_name("  Doe^Jane  ") == "Jane Doe"
    assert history._fmt_name("") == ""
    assert history._fmt_name(None) == ""
    assert history._fmt_name("^^") == ""


def test_patient_name_formatting_end_to_end():
    with tempfile.TemporaryDirectory() as tmp:
        d = os.path.join(tmp, "study")
        write_instance(os.path.join(d, "1.dcm"), patient_name="MADONNA")
        stamp(d, T0)
        assert one(tmp)["patient"] == "MADONNA"


def test_study_date_formatting():
    assert history._fmt_date("20240115") == "2024-01-15"
    assert history._fmt_date("2024-01-15") == "2024-01-15"   # already punctuated
    assert history._fmt_date("2024") == "2024"               # too short, verbatim
    assert history._fmt_date("2024011") == "2024011"
    assert history._fmt_date("2024JAN15") == "2024JAN15"     # 8 chars, not digits
    assert history._fmt_date("") == ""
    assert history._fmt_date(None) == ""
    assert history._fmt_date(" 20240115 ") == "2024-01-15"   # stripped first


def test_study_date_formatting_end_to_end():
    with tempfile.TemporaryDirectory() as tmp:
        d = os.path.join(tmp, "study")
        write_instance(os.path.join(d, "1.dcm"), study_date="2024JAN15")
        stamp(d, T0)
        assert one(tmp)["study_date"] == "2024JAN15"


# --------------------------------------------------------------- empty answers
def test_an_empty_or_absent_root_is_an_empty_list_not_an_error():
    with tempfile.TemporaryDirectory() as tmp:
        assert scan_studies(tmp) == []
        assert scan_studies(os.path.join(tmp, "nope")) == []
        # A file where a folder was expected reads the same as absent.
        f = write_junk(os.path.join(tmp, "a.txt"))
        assert scan_studies(f) == []
    assert scan_studies("") == []
    assert scan_studies(None) == []


# ---------------------------------------------------------- study_files + gating
def test_study_files_collects_dicom_under_a_directory_or_a_single_file():
    with tempfile.TemporaryDirectory() as tmp:
        study = os.path.join(tmp, "study")
        a = write_instance(os.path.join(study, "ct", "1.dcm"))
        b = write_instance(os.path.join(study, "sr", "1.dcm"), modality="SR")
        write_junk(os.path.join(study, "notes.txt"))
        hidden = write_instance(os.path.join(study, ".partial.dcm"))

        assert sorted(study_files(tmp, study)) == sorted([a, b])
        assert study_files(tmp, a) == [a]
        assert study_files(tmp, os.path.join(study, "notes.txt")) == []
        assert study_files(tmp, hidden) == [hidden]     # named directly, not walked
        assert study_files(tmp, os.path.join(tmp, "gone")) == []
        assert sorted(study_files(tmp, tmp)) == sorted([a, b])


def test_study_files_refuses_a_path_outside_the_root():
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "received")
        outside = os.path.join(tmp, "elsewhere")
        os.makedirs(root)
        write_instance(os.path.join(outside, "1.dcm"))

        for bad in (outside, os.path.join(root, "..", "elsewhere"),
                    os.path.dirname(root), "/etc"):
            try:
                study_files(root, bad)
            except ValueError:
                pass
            else:
                raise AssertionError(f"traversal allowed: {bad}")


def test_safe_within_gates_the_storage_folder():
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "received")
        os.makedirs(os.path.join(root, "study"))
        assert safe_within(root, root) is True
        assert safe_within(root, os.path.join(root, "study")) is True
        assert safe_within(root, os.path.join(root, "..", "elsewhere")) is False
        assert safe_within(root, tmp) is False
        # A sibling whose name merely starts with the root's is not inside it.
        assert safe_within(root, root + "-old") is False
        assert safe_within(root, "") is False
        assert safe_within("", root) is False


def test_delete_study_refuses_the_root_and_anything_outside_it():
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "received")
        d = os.path.join(root, "P001", "study")
        write_instance(os.path.join(d, "1.dcm"))
        outside = write_instance(os.path.join(tmp, "elsewhere", "1.dcm"))

        for bad in (root, outside, os.path.join(root, "..", "elsewhere")):
            try:
                delete_study(root, bad)
            except ValueError:
                pass
            else:
                raise AssertionError(f"delete allowed: {bad}")
        assert os.path.isfile(outside)

        delete_study(root, d)
        assert not os.path.exists(d)
        # The now-empty P001 folder is pruned; the root itself never is.
        assert not os.path.exists(os.path.join(root, "P001"))
        assert os.path.isdir(root)
        assert scan_studies(root) == []


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
