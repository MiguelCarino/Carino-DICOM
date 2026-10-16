"""Add eye photos: an order's Ophthalmic Photography files, made in the bundled
editor, filed against that order.

The editor is a browser page, so the PACS is the only place a wrong file can be
stopped. What is worth a test is exactly what would otherwise go out under the
patient's name: a photo of somebody else, a file that is not an eye photo, a
second visit's photos piling into an order already closed, a SOP Instance UID
that is really a path. And the other half — the prefill the editor is opened
with is the identity the worklist serves a modality (PS3.4 K.6), stand-ins and
all, because that identity is what the filed photos are checked against.

    ./.venv/bin/python tests/test_eye_photos.py     # or under pytest
"""
from __future__ import annotations

import io
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pydicom.dataset import Dataset, FileMetaDataset  # noqa: E402
from pydicom.uid import ExplicitVRLittleEndian, generate_uid  # noqa: E402

from pacs import ris  # noqa: E402
from pacs import users as U  # noqa: E402
from pacs.config import Config  # noqa: E402
from pacs.server import OP_PHOTO_CLASSES, PacsServer  # noqa: E402
from pacs.web import create_app  # noqa: E402

OP_8BIT = "1.2.840.10008.5.1.4.1.1.77.1.5.1"
SECONDARY_CAPTURE = "1.2.840.10008.5.1.4.1.1.7"
WRITE = {"X-Carino": "1"}


def server(profiles: bool = False) -> PacsServer:
    d = tempfile.mkdtemp(prefix="carino-eye-")
    cfg = Config(os.path.join(d, "config.json")).load()
    with cfg.mutate():
        cfg.scu["watch_dir"] = os.path.join(d, "outgoing")
        cfg.scp["storage_dir"] = os.path.join(d, "received")
        cfg.data["logs_dir"] = os.path.join(d, "logs")
        cfg.index["enabled"] = False
        if profiles:
            cfg.users["profiles"] = U.preset_profiles()
    cfg.save()
    return PacsServer(cfg)


def add_order(srv, **fields) -> dict:
    base = {"accession": "EYE-1", "patient_name": "DOE^JANE", "patient_id": "P-77",
            "patient_birthdate": "19800102", "patient_sex": "F", "modality": "OP",
            "study_desc": "Fundus photos", "referring": "HOUSE^GREG"}
    base.update(fields)
    return srv.orders.add(base, source="manual", origin=ris.ORIGIN_MANUAL)


def photo(study_uid, patient_id="P-77", accession="EYE-1", sop_class=OP_8BIT, sop=None) -> bytes:
    """A Part 10 file shaped like the editor's: only the attributes the filing checks."""
    ds = Dataset()
    ds.SOPClassUID = sop_class
    ds.SOPInstanceUID = sop or generate_uid()
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = generate_uid()
    ds.PatientID = patient_id
    ds.PatientName = "DOE^JANE"
    ds.AccessionNumber = accession
    ds.Modality = "OP"
    ds.ImageLaterality = "R"
    ds.file_meta = FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    return buf.getvalue()


def outgoing(srv) -> list:
    d = srv.cfg.resolved("scu", "watch_dir")
    return sorted(os.listdir(d)) if os.path.isdir(d) else []


# ---- the prefill --------------------------------------------------------
def test_the_prefill_is_what_the_worklist_serves_a_modality():
    srv = server()
    o = add_order(srv, patient_birthdate="1980-01-02")
    r = srv.eye_photo_prefill(o["id"])
    assert r["ok"], r
    p = r["prefill"]
    assert p["patient_name"] == "DOE^JANE" and p["patient_id"] == "P-77"
    assert p["patient_birthdate"] == "19800102", "a DA, as the worklist sends it"
    assert p["study_uid"] == o["study_uid"] and p["accession"] == "EYE-1"
    # The step and procedure IDs the worklist item carries (PS3.3 Table 10-9 in the
    # editor's Request Attributes Sequence).
    assert p["sps_id"] and p["procedure_id"] and p["referring"] == "HOUSE^GREG"


def test_an_order_with_no_patient_id_is_prefilled_with_the_worklists_stand_in():
    srv = server()
    o = add_order(srv, patient_id="")
    p = srv.eye_photo_prefill(o["id"])["prefill"]
    assert p["patient_id"] == "TMP-" + o["id"], p
    # …and a photo carrying it is this order's, one without it is not.
    assert srv.add_eye_photos_to_order(o["id"], [("x.dcm", photo(o["study_uid"], patient_id=""))])["ok"] is False
    assert srv.add_eye_photos_to_order(o["id"], [("x.dcm", photo(o["study_uid"], patient_id=p["patient_id"]))])["ok"]


def test_an_order_for_another_modality_takes_no_eye_photos():
    srv = server()
    o = add_order(srv, modality="CT")
    assert srv.eye_photo_prefill(o["id"])["ok"] is False
    r = srv.add_eye_photos_to_order(o["id"], [("a.dcm", photo(o["study_uid"]))])
    assert r["ok"] is False and "CT" in r["message"]
    # A blank modality is an order aimed at every worklist, and may be one.
    blank = add_order(srv, accession="EYE-2", modality="")
    assert srv.eye_photo_prefill(blank["id"])["ok"]


# ---- filing -------------------------------------------------------------
def test_photos_for_the_order_are_filed_byte_for_byte_and_close_it():
    srv = server()
    o = add_order(srv)
    files = [("OD.dcm", photo(o["study_uid"])), ("OS.dcm", photo(o["study_uid"]))]
    r = srv.add_eye_photos_to_order(o["id"], files)
    assert r["ok"] and r["count"] == 2, r
    names = outgoing(srv)
    assert len(names) == 2
    on_disk = {open(os.path.join(srv.cfg.resolved("scu", "watch_dir"), n), "rb").read() for n in names}
    assert on_disk == {data for _, data in files}, "written as they came, not re-encoded"
    closed = srv.orders.get(o["id"])
    assert closed["status"] == "closed" and closed["close_reason"] == ris.CLOSE_CAPTURED
    again = srv.add_eye_photos_to_order(o["id"], [("x.dcm", photo(o["study_uid"]))])
    assert again["ok"] is False and "closed" in again["message"], "a closed order takes no more"


def test_one_wrong_file_files_none_of_them():
    srv = server()
    o = add_order(srv)
    good = ("OD.dcm", photo(o["study_uid"]))
    wrong = [
        ("other-patient.dcm", photo(o["study_uid"], patient_id="P-78")),
        ("other-study.dcm", photo(generate_uid())),
        ("other-accession.dcm", photo(o["study_uid"], accession="EYE-9")),
        ("picture.dcm", photo(o["study_uid"], sop_class=SECONDARY_CAPTURE)),
        ("a.jpg", b"\xff\xd8\xff\xe0" + b"\0" * 200),
        ("path.dcm", photo(o["study_uid"], sop="../../etc")),
    ]
    for bad in wrong:
        r = srv.add_eye_photos_to_order(o["id"], [good, bad])
        assert r["ok"] is False, bad[0]
        assert bad[0] in r["message"], (bad[0], r["message"])
        assert outgoing(srv) == [], bad[0] + ": nothing filed"
        assert srv.orders.get(o["id"])["status"] == "open", bad[0] + ": the order stays open"
    dup = photo(o["study_uid"])
    assert srv.add_eye_photos_to_order(o["id"], [("a.dcm", dup), ("b.dcm", dup)])["ok"] is False


def test_both_ophthalmic_photography_classes_and_nothing_else():
    assert OP_8BIT in OP_PHOTO_CLASSES and len(OP_PHOTO_CLASSES) == 2
    assert all(c.startswith("1.2.840.10008.5.1.4.1.1.77.1.5.") for c in OP_PHOTO_CLASSES)


# ---- over HTTP ----------------------------------------------------------
def signed_in(app, srv, name):
    ids = {p["name"]: p["id"] for p in srv.cfg.users["profiles"]}
    c = app.test_client()
    resp = c.post("/api/login", json={"profile": ids[name]}, headers=WRITE)
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return c


def test_both_halves_need_orders_write():
    srv = server(profiles=True)
    o = add_order(srv)
    app = create_app(srv)
    reader = signed_in(app, srv, "Radiologist")              # orders.read, not orders.write
    r = reader.get("/api/ris/orders/photos?id=" + o["id"])
    assert r.status_code == 403 and r.get_json()["forbidden"]["capability"] == "orders.write"
    r = reader.post("/api/ris/orders/photos", headers=WRITE, data={
        "id": o["id"], "file": (io.BytesIO(photo(o["study_uid"])), "OD.dcm")})
    assert r.status_code == 403
    assert outgoing(srv) == []

    desk = signed_in(app, srv, "Reception")
    r = desk.get("/api/ris/orders/photos?id=" + o["id"])
    assert r.status_code == 200 and r.get_json()["prefill"]["patient_id"] == "P-77"
    r = desk.post("/api/ris/orders/photos", headers=WRITE, data={"id": o["id"], "file": [
        (io.BytesIO(photo(o["study_uid"])), "OD.dcm"), (io.BytesIO(photo(o["study_uid"])), "OS.dcm")]},
        content_type="multipart/form-data")
    assert r.status_code == 200 and r.get_json()["count"] == 2, r.get_data(as_text=True)
    assert len(outgoing(srv)) == 2
    # Recorded like every other write, by order id and never by patient.
    rows = [x for x in srv.audit.read_all() if x.get("endpoint") == "/api/ris/orders/photos"]
    assert [x.get("outcome") for x in rows] == ["denied", "ok"], rows
    assert rows[-1]["target"] == "id=" + o["id"] and "DOE" not in str(rows), rows[-1]


def test_a_post_without_files_is_refused_before_anything_happens():
    srv = server()
    o = add_order(srv)
    c = create_app(srv).test_client()
    r = c.post("/api/ris/orders/photos", headers=WRITE, data={"id": o["id"]})
    assert r.status_code == 400
    assert srv.orders.get(o["id"])["status"] == "open"


if __name__ == "__main__":
    import inspect
    failed = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and inspect.isfunction(fn):
            try:
                fn()
                print("  ok    " + name)
            except AssertionError as exc:
                failed += 1
                print("  FAIL  " + name + ": " + str(exc))
    sys.exit(1 if failed else 0)
