"""Approving a pending (review-queue) item: the identity that ends up in the DICOM.

Two of these are patient-safety tests and are the reason the file exists:

  * a profile that may not see a field is shown "***" in it, and approving must
    never write that placeholder into the instance;
  * correcting the patient on an item that inherited a study UID from beside
    another patient's study must not file the new patient under that UID.

Runs under pytest, or standalone: python3 tests/test_pending_approve.py
"""

from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pydicom import dcmread                              # noqa: E402

from pacs import ingest, ris                             # noqa: E402
from pacs import users as U                              # noqa: E402

PNG_1PX = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
           b"\x08\x00\x00\x00\x00:~\x9bU\x00\x00\x00\nIDATx\x9cc`\x00\x00\x00\x02"
           b"\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82")

WRITE = {"X-Carino": "1"}

STUDY_A = "1.2.826.0.1.3680043.8.498.1"


def _stage(root, identity, name="report.png"):
    pending = os.path.join(root, "pending")
    os.makedirs(pending, exist_ok=True)
    src = os.path.join(root, name)
    with open(src, "wb") as fh:
        fh.write(PNG_1PX)
    pid = ingest.stage_pending(pending, src, identity, "image")
    return pending, pid


def _sibling_identity():
    return {"patient": "Jane Doe", "patient_name": "Doe^Jane", "patient_id": "P-A",
            "study_uid": STUDY_A, "study_date": "20240115", "study_desc": "Head CT",
            "accession": "ACC-A"}


def _approve(edits, identity=None, **kw):
    root = tempfile.mkdtemp(prefix="carino-pending-")
    pending, pid = _stage(root, identity if identity is not None else _sibling_identity())
    out = ingest.approve_pending(pending, pid, edits, os.path.join(root, "out"), **kw)
    return dcmread(out)


# ---- the placeholder is never written ------------------------------------

def test_redacted_values_are_dropped_not_written():
    ds = _approve({"patient": U.REDACTED, "study_desc": U.REDACTED,
                   "patient_id": "P-A", "accession": "ACC-A"})
    assert str(ds.PatientName) == "Doe^Jane"
    assert ds.StudyDescription == "Head CT"
    assert U.REDACTED not in str(ds.PatientName)
    # Nothing changed about the patient, so the study it was found beside keeps it.
    assert ds.StudyInstanceUID == STUDY_A


def test_redacted_placeholder_with_whitespace_is_still_the_placeholder():
    ds = _approve({"patient": " *** ", "patient_id": "P-A"})
    assert str(ds.PatientName) == "Doe^Jane"


# ---- a corrected patient does not keep the other patient's study --------

def test_a_corrected_patient_id_gets_a_new_study():
    ds = _approve({"patient": "Jane Doe", "patient_id": "P-B"})
    assert ds.PatientID == "P-B"
    assert ds.StudyInstanceUID and ds.StudyInstanceUID != STUDY_A


def test_a_corrected_patient_name_gets_a_new_study():
    ds = _approve({"patient": "John Roe", "patient_id": "P-A"})
    assert str(ds.PatientName) == "John Roe"
    assert ds.StudyInstanceUID != STUDY_A


def test_a_corrected_patient_does_not_keep_the_other_patients_accession():
    # The form posts back what it was pre-filled with: patient A's study fields.
    ds = _approve({"patient": "John Roe", "patient_id": "P-B", "accession": "ACC-A",
                   "study_date": "20240115", "study_desc": "Head CT"})
    assert ds.StudyInstanceUID != STUDY_A
    assert str(getattr(ds, "AccessionNumber", "") or "") == ""
    assert str(getattr(ds, "StudyDescription", "") or "") != "Head CT"
    assert str(getattr(ds, "StudyDate", "") or "") != "20240115"
    # Values the operator actually changed are theirs and are written.
    ds = _approve({"patient": "John Roe", "patient_id": "P-B", "accession": "ACC-B",
                   "study_date": "2026-03-04", "study_desc": "Chest"})
    assert ds.AccessionNumber == "ACC-B" and ds.StudyDescription == "Chest"
    assert ds.StudyDate == "20260304"
    # keep_study keeps all of it.
    ds = _approve({"patient": "John Roe", "patient_id": "P-B"}, keep_study=True)
    assert ds.AccessionNumber == "ACC-A" and ds.StudyInstanceUID == STUDY_A


def test_keep_study_is_the_operators_explicit_choice():
    ds = _approve({"patient": "John Roe", "patient_id": "P-A"}, keep_study=True)
    assert ds.StudyInstanceUID == STUDY_A


def test_the_same_name_in_another_spelling_is_not_a_different_patient():
    ds = _approve({"patient": "JANE  doe", "patient_id": "P-A"})
    assert ds.StudyInstanceUID == STUDY_A


def test_filling_in_an_empty_identity_keeps_the_study():
    """A print film arrives with no patient; identifying it is not a correction."""
    ident = {"study_uid": STUDY_A}
    root = tempfile.mkdtemp(prefix="carino-pending-")
    pending, pid = _stage(root, ident)
    out = ingest.approve_pending(pending, pid, {"patient": "Jane Doe", "patient_id": "P-A"},
                                 os.path.join(root, "out"))
    ds = dcmread(out)
    assert ds.StudyInstanceUID == STUDY_A
    assert ds.PatientID == "P-A"


# ---- required identity and the study date --------------------------------

def _refused(edits, identity=None):
    root = tempfile.mkdtemp(prefix="carino-pending-")
    pending, pid = _stage(root, identity if identity is not None else {})
    try:
        ingest.approve_pending(pending, pid, edits, os.path.join(root, "out"))
    except ingest.PendingInputError as exc:
        # Refused before anything was written, and the item is still queued.
        assert not os.path.isdir(os.path.join(root, "out")) or not os.listdir(
            os.path.join(root, "out"))
        assert ingest.list_pending(pending)
        return exc.field
    raise AssertionError("approve was not refused")


def test_patient_name_is_required():
    assert _refused({"patient": "", "patient_id": "P1"}) == "patient"


def test_patient_id_is_required():
    assert _refused({"patient": "Jane Doe", "patient_id": "  "}) == "patient_id"


def test_study_date_formats():
    assert ingest.form_date("2026-03-04") == "20260304"
    assert ingest.form_date("20260304") == "20260304"
    assert ingest.form_date("") == ""
    for bad in ("3/4/2026", "2026-3-4", "202603", "2026-02-30", "tomorrow"):
        try:
            ingest.form_date(bad)
        except ingest.PendingInputError as exc:
            assert exc.field == "study_date"
        else:
            raise AssertionError(f"{bad!r} accepted")


def test_a_bad_study_date_refuses_the_approval():
    assert _refused({"patient": "Jane Doe", "patient_id": "P1",
                     "study_date": "3/4/2026"}) == "study_date"


def test_an_iso_study_date_is_written_as_da():
    ds = _approve({"patient": "Jane Doe", "patient_id": "P-A", "study_date": "2026-03-04"})
    assert ds.StudyDate == "20260304"


# ---- an order supplies the identity and is closed -------------------------

def _engine(tmp):
    from pacs.config import Config
    from pacs.server import PacsServer
    cfg = Config(os.path.join(tmp, "config.json")).load()
    cfg.scu["watch_dir"] = os.path.join(tmp, "outgoing")
    cfg.scu["pending_dir"] = os.path.join(tmp, "pending")
    cfg.save()
    return PacsServer(cfg)


def test_approving_against_an_order_takes_its_identity_and_closes_it():
    tmp = tempfile.mkdtemp(prefix="carino-pending-order-")
    srv = _engine(tmp)
    try:
        order = srv.orders.add({"accession": "ACC-9", "patient_name": "ROE^JOHN",
                                "patient_id": "P-9", "study_desc": "Chest film",
                                "scheduled_dt": "20260808093000"})
        pending = srv._pending_dir()
        _, pid = _stage(tmp, _sibling_identity())
        # _stage wrote into <tmp>/pending, which is this engine's pending_dir.
        assert os.path.realpath(os.path.join(tmp, "pending")) == os.path.realpath(pending)
        res = srv.approve_pending(pid, {"patient": "Typed Over", "patient_id": "X",
                                        "series_desc": "Film 1"},
                                  order_id=order["id"])
        assert res["ok"], res
        outs = [f for f in os.listdir(os.path.join(tmp, "outgoing")) if f.endswith(".dcm")]
        assert len(outs) == 1
        ds = dcmread(os.path.join(tmp, "outgoing", outs[0]))
        assert ds.StudyInstanceUID == order["study_uid"]
        assert str(ds.PatientName) == "ROE^JOHN"
        assert ds.PatientID == "P-9"
        assert ds.AccessionNumber == "ACC-9"
        assert ds.StudyDate == "20260808"
        assert ds.SeriesDescription == "Film 1"
        closed = srv.orders.get(order["id"])
        assert closed["status"] == "closed"
        assert closed["close_reason"] == ris.CLOSE_CAPTURED
        assert closed["matched_study"] == order["study_uid"]
    finally:
        srv.shutdown()


def test_a_closed_or_unknown_order_refuses_and_keeps_the_item():
    tmp = tempfile.mkdtemp(prefix="carino-pending-order-")
    srv = _engine(tmp)
    try:
        order = srv.orders.add({"accession": "ACC-1", "patient_id": "P1"})
        srv.orders.close(order["id"], reason="cancelled")
        _, pid = _stage(tmp, {})
        res = srv.approve_pending(pid, {}, order_id=order["id"])
        assert not res["ok"] and res["field"] == "order_id"
        res = srv.approve_pending(pid, {}, order_id="nope")
        assert not res["ok"] and res["field"] == "order_id"
        assert len(ingest.list_pending(srv._pending_dir())) == 1
    finally:
        srv.shutdown()


# ---- the HTTP layer --------------------------------------------------------

def _web(tmp):
    from pacs.web import create_app
    srv = _engine(tmp)
    with srv.cfg.mutate():
        srv.cfg.users["profiles"] = U.preset_profiles()
        srv.cfg.save()
    app = create_app(srv)
    ids = {p["name"]: p["id"] for p in srv.cfg.users["profiles"]}
    return srv, app, ids


def _signed_in(app, ids, name):
    c = app.test_client()
    r = c.post("/api/login", json={"profile": ids[name]}, headers=WRITE)
    assert r.status_code == 200, r.get_data(as_text=True)
    return c


def test_it_profile_sees_locked_fields_and_cannot_write_the_placeholder():
    tmp = tempfile.mkdtemp(prefix="carino-pending-web-")
    srv, app, ids = _web(tmp)
    try:
        _, pid = _stage(tmp, _sibling_identity())
        c = _signed_in(app, ids, "IT")
        item = c.get("/api/pending").get_json()["items"][0]
        # IT may see the accession and the patient ID, nothing else.
        assert item["patient"] == U.REDACTED
        assert item["study_desc"] == U.REDACTED
        assert set(item["redacted"]) >= {"patient", "patient_name", "study_desc"}
        assert "patient_id" not in item["redacted"] and "accession" not in item["redacted"]
        # The form posts back exactly what it was shown.
        r = c.post("/api/pending/approve", headers=WRITE, json={
            "id": pid, "patient": item["patient"], "patient_id": item["patient_id"],
            "study_desc": item["study_desc"], "accession": item["accession"],
            "study_date": item["study_date"]})
        assert r.status_code == 200, r.get_json()
        outs = os.listdir(os.path.join(tmp, "outgoing"))
        ds = dcmread(os.path.join(tmp, "outgoing", outs[0]))
        assert str(ds.PatientName) == "Doe^Jane"
        assert ds.StudyDescription == "Head CT"
        assert ds.StudyInstanceUID == STUDY_A
    finally:
        srv.shutdown()


def test_an_administrator_has_nothing_locked_and_errors_name_the_field():
    tmp = tempfile.mkdtemp(prefix="carino-pending-web-")
    srv, app, ids = _web(tmp)
    try:
        _, pid = _stage(tmp, {})
        c = _signed_in(app, ids, "Administrator")
        item = c.get("/api/pending").get_json()["items"][0]
        assert item["redacted"] == []
        r = c.post("/api/pending/approve", headers=WRITE,
                   json={"id": pid, "patient": "Jane Doe", "patient_id": ""})
        assert r.status_code == 400
        assert r.get_json()["field"] == "patient_id" and r.get_json()["error"]
        r = c.post("/api/pending/approve", headers=WRITE,
                   json={"id": pid, "patient": "Jane Doe", "patient_id": "P1",
                         "study_date": "04/03/2026"})
        assert r.status_code == 400 and r.get_json()["field"] == "study_date"
        r = c.post("/api/pending/approve", headers=WRITE,
                   json={"id": pid, "patient": "Jane Doe", "patient_id": "P1",
                         "study_date": "2026-03-04"})
        assert r.status_code == 200, r.get_json()
    finally:
        srv.shutdown()


def test_matching_an_order_needs_orders_write_and_hides_order_state():
    tmp = tempfile.mkdtemp(prefix="carino-pending-web-")
    srv, app, ids = _web(tmp)
    try:
        order = srv.orders.add({"accession": "ACC-1", "patient_id": "P1"})
        _, pid = _stage(tmp, {})
        # Radiologist: studies.send, orders.read, but no orders.write.
        c = _signed_in(app, ids, "Radiologist")
        r = c.post("/api/pending/approve", headers=WRITE,
                   json={"id": pid, "order_id": order["id"]})
        assert r.status_code == 403
        assert r.get_json()["forbidden"]["capability"] == "orders.write"
        assert srv.orders.get(order["id"])["status"] == "open"
        # A profile that may close orders but not read them gets one answer
        # for "no such order" and "already closed".
        with srv.cfg.mutate():
            srv.cfg.users["profiles"].append({
                "id": U.new_id(), "name": "Blind", "role": "custom", "enabled": True,
                "admin": False, "capabilities": ["studies.read", "studies.send", "orders.write"],
                "phi_visible": [], "password": None, "email": "", "locale": ""})
            srv.cfg.save()
        ids = {p["name"]: p["id"] for p in srv.cfg.users["profiles"]}
        c = _signed_in(app, ids, "Blind")
        srv.orders.close(order["id"], reason="cancelled")
        a = c.post("/api/pending/approve", headers=WRITE,
                   json={"id": pid, "order_id": order["id"]}).get_json()
        b = c.post("/api/pending/approve", headers=WRITE,
                   json={"id": pid, "order_id": "nope"}).get_json()
        assert a == b and a["field"] == "order_id", (a, b)
        # Someone who may read orders still gets the precise reason.
        c = _signed_in(app, ids, "Administrator")
        r = c.post("/api/pending/approve", headers=WRITE,
                   json={"id": pid, "order_id": order["id"]}).get_json()
        assert "closed" in r["error"]
    finally:
        srv.shutdown()


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except Exception as exc:          # noqa: BLE001
                failed += 1
                print(f"FAIL {name}: {exc!r}")
    sys.exit(1 if failed else 0)
