"""Forge a small set of DICOM studies for the manual's screenshots.

Everything here is invented: the names are obviously fictional, the IDs are in
the 1.2.826.0.1.3680043.10.99999 test arc, and the pixels are a gradient. No
real study is ever opened by this script — a manual is a public document and a
screenshot of it is the easiest place in a project to leak a patient.
"""
import datetime
import pathlib
import sys

import array

from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

ROOT = "1.2.826.0.1.3680043.10.99999"
OUT = pathlib.Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)

STUDIES = [
    # (PatientName, PatientID, modality, description, station, series, images, accession)
    ("PHANTOM^ALPHA",     "DEMO-0001", "CT", "CHEST WITHOUT CONTRAST",  "CT_ER_01",  2, 3, "A2400117"),
    ("PHANTOM^BETA",      "DEMO-0002", "US", "ABDOMEN COMPLETE",        "US_ROOM_2", 1, 2, "A2400118"),
    ("TESTPATTERN^GAMMA", "DEMO-0003", "CR", "CHEST PA AND LATERAL",    "CR_PORT_1", 1, 2, "A2400119"),
    ("PHANTOM^DELTA",     "DEMO-0004", "MR", "BRAIN WITHOUT CONTRAST",  "MR_01",     2, 2, "A2400120"),
    ("TESTPATTERN^EPS",   "DEMO-0005", "CT", "HEAD WITHOUT CONTRAST",   "CT_ER_01",  1, 3, "A2400121"),
]

rows = cols = 128
when = datetime.datetime(2026, 8, 8, 9, 30, 0)


def frame(seed: int) -> bytes:
    px = array.array("H", bytes(rows * cols * 2))
    for y in range(rows):
        band = 16 <= y < 40
        base = y * cols
        for x in range(cols):
            # a bright band across the top third, so a viewer shows structure
            px[base + x] = 3800 if (band and 16 <= x < 112) else (x * 7 + y * 3 + seed * 40) % 4096
    return px.tobytes()


n = 0
for pname, pid, modality, desc, station, n_series, n_img, accession in STUDIES:
    study_uid = generate_uid(prefix=f"{ROOT}.1.")
    for s in range(n_series):
        series_uid = generate_uid(prefix=f"{ROOT}.2.")
        for i in range(n_img):
            fm = FileMetaDataset()
            fm.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.2"
            fm.MediaStorageSOPInstanceUID = generate_uid(prefix=f"{ROOT}.3.")
            fm.TransferSyntaxUID = ExplicitVRLittleEndian
            fm.ImplementationVersionName = "CARINO_FORGE"

            ds = FileDataset(None, {}, file_meta=fm, preamble=b"\0" * 128)
            ds.SOPClassUID = fm.MediaStorageSOPClassUID
            ds.SOPInstanceUID = fm.MediaStorageSOPInstanceUID
            ds.PatientName = pname
            ds.PatientID = pid
            ds.PatientBirthDate = "19700101"
            ds.PatientSex = "O"
            ds.StudyInstanceUID = study_uid
            ds.SeriesInstanceUID = series_uid
            ds.StudyDate = when.strftime("%Y%m%d")
            ds.StudyTime = when.strftime("%H%M%S")
            ds.SeriesDate = ds.StudyDate
            ds.SeriesTime = ds.StudyTime
            ds.AccessionNumber = accession
            ds.Modality = modality
            ds.StudyDescription = desc
            ds.SeriesDescription = f"{desc} - series {s + 1}"
            ds.StationName = station
            ds.InstitutionName = "Example Imaging Centre"
            ds.ReferringPhysicianName = "EXAMPLE^REFERRER"
            ds.SeriesNumber = s + 1
            ds.InstanceNumber = i + 1
            ds.Rows = rows
            ds.Columns = cols
            ds.SamplesPerPixel = 1
            ds.PhotometricInterpretation = "MONOCHROME2"
            ds.BitsAllocated = 16
            ds.BitsStored = 12
            ds.HighBit = 11
            ds.PixelRepresentation = 0
            ds.WindowCenter = 2048
            ds.WindowWidth = 4096
            ds.PixelData = frame(i + s * 3)

            path = OUT / f"{pid}_{s + 1}_{i + 1}.dcm"
            ds.save_as(path, enforce_file_format=True)
            n += 1

print(f"forged {n} instances across {len(STUDIES)} studies in {OUT}")
