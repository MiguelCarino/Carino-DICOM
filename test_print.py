"""End-to-end tests for the virtual DICOM Print SCP.

Drives real pynetdicom Print SCUs against a live PrintSCP and checks the
captured film lands in the pending queue and approves into DICOM. Covers:

  1. grayscale + PDF layout (2-up film)         -> Encapsulated PDF (DOC)
  2. grayscale + image layout                   -> Secondary Capture (OT)
  3. colour print (colour meta + colour boxes)  -> captured PDF
  4. identity scraping (modality sends Patient/Study on the film session)

Run:  ./.venv/bin/python test_print.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time

import pydicom
from pydicom.dataset import Dataset
from pydicom.uid import generate_uid
from pynetdicom import AE, evt
from pynetdicom.sop_class import (
    BasicAnnotationBox,
    BasicColorImageBox,
    BasicColorPrintManagementMeta,
    BasicFilmBox,
    BasicFilmSession,
    BasicGrayscaleImageBox,
    BasicGrayscalePrintManagementMeta,
    PresentationLUT,
    PrintJob,
    Printer,
    PrinterConfigurationRetrieval,
    PrinterInstance,
    Verification,
)

from pacs.config import Config
from pacs.server import PacsServer

_PORT = 11210
SCU_AET = "MODALITY01"


def _next_port() -> int:
    global _PORT
    _PORT += 1
    return _PORT


def _gray_item(value: int, rows: int = 24, cols: int = 24) -> Dataset:
    it = Dataset()
    it.SamplesPerPixel = 1
    it.PhotometricInterpretation = "MONOCHROME2"
    it.Rows, it.Columns = rows, cols
    it.BitsAllocated = it.BitsStored = 8
    it.HighBit = 7
    it.PixelRepresentation = 0
    it.PixelData = bytes([value]) * (rows * cols)
    return it


def _color_item(rgb: tuple, rows: int = 16, cols: int = 16) -> Dataset:
    it = Dataset()
    it.SamplesPerPixel = 3
    it.PhotometricInterpretation = "RGB"
    it.PlanarConfiguration = 0
    it.Rows, it.Columns = rows, cols
    it.BitsAllocated = it.BitsStored = 8
    it.HighBit = 7
    it.PixelRepresentation = 0
    it.PixelData = bytes(rgb) * (rows * cols)
    return it


def _start_server(**print_cfg):
    tmp = tempfile.mkdtemp(prefix="carinoprint-test-")
    cfg = Config(os.path.join(tmp, "config.json"))
    cfg.printer.update({"enabled": True, "port": _next_port(), **print_cfg})
    cfg.save()
    server = PacsServer(cfg)
    server.start_printer()
    time.sleep(0.4)
    assert server.print_scp and server.print_scp.running, "print SCP did not start"
    return server, cfg


def _drive(port, meta, box_cls, items, fmt="STANDARD\\1,1", session_attrs=None):
    """Run one full print conversation; returns the Film Box N-CREATE reply."""
    ae = AE(ae_title=SCU_AET)
    ae.add_requested_context(meta)
    assoc = ae.associate("127.0.0.1", port)
    assert assoc.is_established, "SCU could not associate"
    su, fu = generate_uid(), generate_uid()

    fs = Dataset()
    fs.FilmSessionLabel = "STUDY FILM"
    for k, v in (session_attrs or {}).items():
        setattr(fs, k, v)
    st, _ = assoc.send_n_create(fs, BasicFilmSession, su, meta_uid=meta)
    assert st.Status == 0x0000, "film session create failed"

    fb = Dataset()
    fb.ImageDisplayFormat = fmt
    st, created = assoc.send_n_create(fb, BasicFilmBox, fu, meta_uid=meta)
    assert st.Status == 0x0000, "film box create failed"
    boxes = created.ReferencedImageBoxSequence
    assert len(boxes) == len(items), f"expected {len(items)} boxes, got {len(boxes)}"

    seq_kw = "BasicColorImageSequence" if box_cls == BasicColorImageBox else "BasicGrayscaleImageSequence"
    for pos, (ib, item) in enumerate(zip(boxes, items), start=1):
        m = Dataset()
        m.ImageBoxPosition = pos
        setattr(m, seq_kw, [item])
        st, _ = assoc.send_n_set(m, box_cls, ib.ReferencedSOPInstanceUID, meta_uid=meta)
        assert st.Status == 0x0000, f"image box {pos} set failed"

    st, _ = assoc.send_n_action(None, 1, BasicFilmBox, fu, meta_uid=meta)
    assert st.Status == 0x0000, f"print action failed ({st.Status:#06x})"
    assoc.release()
    time.sleep(0.3)
    return created


def _pending(cfg):
    pdir = cfg.resolved("scu", "pending_dir")
    out = []
    for d in sorted(os.listdir(pdir)):
        entry = os.path.join(pdir, d)
        if os.path.isdir(entry) and os.path.isfile(os.path.join(entry, "meta.json")):
            meta = json.load(open(os.path.join(entry, "meta.json")))
            meta["_dir"] = entry
            out.append(meta)
    return out


# ------------------------------------------------------------------- scenarios
def test_grayscale_pdf():
    server, cfg = _start_server(layout="pdf")
    try:
        _drive(cfg.printer["port"], BasicGrayscalePrintManagementMeta,
               BasicGrayscaleImageBox, [_gray_item(80), _gray_item(160)], fmt="STANDARD\\1,2")
        items = _pending(cfg)
        assert len(items) == 1 and items[0]["kind"] == "pdf", "expected one PDF pending item"
        assert SCU_AET in items[0]["source"], "source missing SCU AE"
        head = open(os.path.join(items[0]["_dir"], items[0]["filename"]), "rb").read(5)
        assert head == b"%PDF-", "not a PDF"
        res = server.approve_pending(items[0]["id"], {"patient": "DOE^JANE", "patient_id": "P1"})
        assert res.get("ok"), res
        dcm = [f for f in os.listdir(cfg.resolved("scu", "watch_dir")) if f.endswith(".dcm")][0]
        ds = pydicom.dcmread(os.path.join(cfg.resolved("scu", "watch_dir"), dcm))
        assert ds.Modality == "DOC" and ds.PatientID == "P1"
        print("  [1] grayscale+PDF: 2-up film -> Encapsulated PDF (DOC) OK")
    finally:
        server.shutdown()


def test_grayscale_image():
    server, cfg = _start_server(layout="image")
    try:
        _drive(cfg.printer["port"], BasicGrayscalePrintManagementMeta,
               BasicGrayscaleImageBox, [_gray_item(120)])
        items = _pending(cfg)
        assert len(items) == 1 and items[0]["kind"] == "image", "expected one image pending item"
        assert items[0]["filename"].endswith(".png"), "expected a .png"
        res = server.approve_pending(items[0]["id"], {"patient": "ROE^RICHARD", "patient_id": "P2"})
        assert res.get("ok"), res
        dcm = [f for f in os.listdir(cfg.resolved("scu", "watch_dir")) if f.endswith(".dcm")][0]
        ds = pydicom.dcmread(os.path.join(cfg.resolved("scu", "watch_dir"), dcm))
        assert ds.Modality == "OT" and int(ds.Rows) > 0 and int(ds.Columns) > 0
        print("  [2] grayscale+image: film -> Secondary Capture (OT) OK")
    finally:
        server.shutdown()


def test_color_pdf():
    server, cfg = _start_server(layout="pdf", color=True)
    try:
        created = _drive(cfg.printer["port"], BasicColorPrintManagementMeta,
                         BasicColorImageBox, [_color_item((220, 40, 40))])
        assert str(created.ReferencedImageBoxSequence[0].ReferencedSOPClassUID) == BasicColorImageBox, \
            "server did not hand back colour image box class on the colour meta"
        items = _pending(cfg)
        assert len(items) == 1 and items[0]["kind"] == "pdf", "colour print did not queue a PDF"
        head = open(os.path.join(items[0]["_dir"], items[0]["filename"]), "rb").read(5)
        assert head == b"%PDF-", "colour render is not a PDF"
        print("  [3] color print: colour meta + colour boxes -> captured PDF OK")
    finally:
        server.shutdown()


def test_identity_scrape():
    server, cfg = _start_server(layout="pdf")
    try:
        su_study = generate_uid()
        _drive(cfg.printer["port"], BasicGrayscalePrintManagementMeta,
               BasicGrayscaleImageBox, [_gray_item(90)],
               session_attrs={
                   "PatientName": "SMITH^JOHN",
                   "PatientID": "MRN-42",
                   "StudyInstanceUID": su_study,
                   "StudyDescription": "PORTABLE CHEST",
                   "AccessionNumber": "ACC-7",
               })
        meta = _pending(cfg)[0]
        assert meta["patient_id"] == "MRN-42", meta
        assert meta["patient"] == "JOHN SMITH", meta
        assert meta["study_uid"] == su_study, meta
        assert meta["study_desc"] == "PORTABLE CHEST", meta
        assert meta["accession"] == "ACC-7", meta
        print("  [4] identity scrape: Patient/Study pre-filled from print attrs OK")
    finally:
        server.shutdown()


def test_annotation_and_printjob():
    server, cfg = _start_server(layout="pdf")
    try:
        port = cfg.printer["port"]
        ae = AE(ae_title=SCU_AET)
        ae.add_requested_context(BasicGrayscalePrintManagementMeta)
        ae.add_requested_context(BasicAnnotationBox)
        ae.add_requested_context(PrintJob)
        a = ae.associate("127.0.0.1", port)
        assert a.is_established, "SCU could not associate (annotation/printjob contexts)"
        meta = BasicGrayscalePrintManagementMeta
        su, fu = generate_uid(), generate_uid()

        fs = Dataset()          # non-empty but no FilmSessionLabel → annotation drives study_desc
        fs.NumberOfCopies = "1"
        fs.PrintPriority = "MED"
        st, _ = a.send_n_create(fs, BasicFilmSession, su, meta_uid=meta)
        assert st.Status == 0x0000

        fb = Dataset()
        fb.ImageDisplayFormat = "STANDARD\\1,1"
        fb.AnnotationDisplayFormatID = "PATIENTINFO"
        st, created = a.send_n_create(fb, BasicFilmBox, fu, meta_uid=meta)
        assert st.Status == 0x0000
        assert "ReferencedBasicAnnotationBoxSequence" in created, "no annotation boxes handed back"
        annos = created.ReferencedBasicAnnotationBoxSequence
        assert len(annos) == 6, f"expected annotation pool of 6, got {len(annos)}"

        # image box
        ib = created.ReferencedImageBoxSequence[0]
        m = Dataset(); m.ImageBoxPosition = 1
        m.BasicGrayscaleImageSequence = [_gray_item(100)]
        st, _ = a.send_n_set(m, BasicGrayscaleImageBox, ib.ReferencedSOPInstanceUID, meta_uid=meta)
        assert st.Status == 0x0000

        # two annotation strings (on their own SOP class context)
        for pos, text in ((1, "SMITH^JOHN  MRN-42"), (2, "PORTABLE CHEST")):
            am = Dataset(); am.AnnotationPosition = pos; am.TextString = text
            st, _ = a.send_n_set(am, BasicAnnotationBox, annos[pos - 1].ReferencedSOPInstanceUID)
            assert st.Status == 0x0000, f"annotation {pos} set failed"

        # print → returns a Print Job reference
        st, reply = a.send_n_action(None, 1, BasicFilmBox, fu, meta_uid=meta)
        assert st.Status == 0x0000
        assert reply is not None and "ReferencedPrintJobSequence" in reply, "no print job handed back"
        pj_uid = reply.ReferencedPrintJobSequence[0].ReferencedSOPInstanceUID

        # poll the print job status
        st, info = a.send_n_get([0x21000020], PrintJob, pj_uid)
        assert st.Status == 0x0000 and info.ExecutionStatus == "DONE", "print job not DONE"
        a.release(); time.sleep(0.3)

        item = _pending(cfg)[0]
        assert item["study_desc"] == "SMITH^JOHN  MRN-42", \
            f"annotation not used as study desc: {item['study_desc']!r}"
        print("  [5] annotation box + print job: text captured, job reports DONE OK")
    finally:
        server.shutdown()


def test_bitdepth_and_robustness():
    from pacs.print_scp import _image_from_item
    # 12-bit stored in 16 bits: a max-value pixel must render near white, not ~15.
    it = Dataset()
    it.SamplesPerPixel = 1; it.PhotometricInterpretation = "MONOCHROME2"
    it.Rows = it.Columns = 2; it.BitsAllocated = 16; it.BitsStored = 12; it.HighBit = 11
    it.PixelRepresentation = 0
    it.PixelData = (0x0FFF).to_bytes(2, "little") * 4    # all pixels = 4095
    im = _image_from_item(it)
    px = im.convert("L").getpixel((0, 0))
    assert px >= 240, f"12-bit max pixel rendered too dark ({px}); scaling broken"

    # Truncated pixel data must not crash — it pads and still returns an image.
    it2 = Dataset()
    it2.SamplesPerPixel = 1; it2.PhotometricInterpretation = "MONOCHROME2"
    it2.Rows = it2.Columns = 4; it2.BitsAllocated = 8; it2.BitsStored = 8; it2.HighBit = 7
    it2.PixelRepresentation = 0; it2.PixelData = b"\xff\xff"   # far too short (need 16)
    assert _image_from_item(it2) is not None, "short pixel data should not fail decode"
    print("  [6] bit-depth + robustness: 12-bit scales bright, short pixels survive OK")


def test_empty_job_survives():
    # An N-ACTION with no image data returns a warning but must NOT abort — the
    # same association can then print a real film.
    server, cfg = _start_server(layout="pdf")
    try:
        port = cfg.printer["port"]
        ae = AE(ae_title=SCU_AET)
        ae.add_requested_context(BasicGrayscalePrintManagementMeta)
        a = ae.associate("127.0.0.1", port)
        meta = BasicGrayscalePrintManagementMeta
        su, fu = generate_uid(), generate_uid()
        fs = Dataset(); fs.NumberOfCopies = "1"
        a.send_n_create(fs, BasicFilmSession, su, meta_uid=meta)
        fb = Dataset(); fb.ImageDisplayFormat = "STANDARD\\1,1"
        a.send_n_create(fb, BasicFilmBox, fu, meta_uid=meta)
        st, _ = a.send_n_action(None, 1, BasicFilmBox, fu, meta_uid=meta)   # no image set
        assert st.Status == 0xB603, f"empty print should warn, got {st.Status:#06x}"
        assert a.is_established, "association aborted on an empty print"
        # now a real film on the SAME association
        fu2 = generate_uid()
        fb2 = Dataset(); fb2.ImageDisplayFormat = "STANDARD\\1,1"
        st, created = a.send_n_create(fb2, BasicFilmBox, fu2, meta_uid=meta)
        m = Dataset(); m.ImageBoxPosition = 1; m.BasicGrayscaleImageSequence = [_gray_item(70)]
        a.send_n_set(m, BasicGrayscaleImageBox, created.ReferencedImageBoxSequence[0].ReferencedSOPInstanceUID, meta_uid=meta)
        st, _ = a.send_n_action(None, 1, BasicFilmBox, fu2, meta_uid=meta)
        assert st.Status == 0x0000, "real film after empty print failed"
        a.release(); time.sleep(0.3)
        assert len(_pending(cfg)) == 1, "expected exactly one captured film"
        print("  [7] empty print warns without aborting; association still usable OK")
    finally:
        server.shutdown()


def _log_lines(server, kind="print"):
    return [f"{e['level']} {e['message']}" for e in server.log.tail(200) if e.get("kind") == kind]


def test_printer_assigned_uids():
    # Most modalities leave the Film Session and Film Box UIDs to the printer
    # and take them from the N-CREATE response. Before this was handled the
    # very first create failed with 0x0110 and nothing reached the app log.
    server, cfg = _start_server(layout="pdf")
    try:
        meta = BasicGrayscalePrintManagementMeta
        ae = AE(ae_title=SCU_AET)
        ae.add_requested_context(meta)
        ae.add_requested_context(PresentationLUT)
        # pynetdicom's SCU does not surface the UID an N-CREATE response
        # carries, so read it off the response command set as it arrives.
        minted = []
        def on_recv(event):
            cs = event.message.command_set
            if "AffectedSOPInstanceUID" in cs and cs.CommandField == 0x8140:   # N-CREATE-RSP
                minted.append(str(cs.AffectedSOPInstanceUID))
        a = ae.associate("127.0.0.1", cfg.printer["port"],
                         evt_handlers=[(evt.EVT_DIMSE_RECV, on_recv)])
        assert a.is_established
        assert not a.rejected_contexts, "Presentation LUT was refused"
        lut = Dataset(); lut.PresentationLUTShape = "IDENTITY"
        st, _ = a.send_n_create(lut, PresentationLUT, None)
        assert st.Status == 0x0000, f"presentation LUT create failed ({st.Status:#06x})"
        assert len(minted) == 1, "no UID handed back for the presentation LUT"
        fs = Dataset(); fs.FilmSessionLabel = "NO UIDS"
        st, _ = a.send_n_create(fs, BasicFilmSession, None, meta_uid=meta)
        assert st.Status == 0x0000, f"film session create failed ({st.Status:#06x})"
        assert len(minted) == 2, "no film session UID handed back"
        session_uid = minted[1]
        fb = Dataset(); fb.ImageDisplayFormat = "STANDARD\\1,1"
        st, created = a.send_n_create(fb, BasicFilmBox, None, meta_uid=meta)
        assert st.Status == 0x0000, f"film box create failed ({st.Status:#06x})"
        assert len(minted) == 3 and minted[2] != session_uid, "no distinct film box UID handed back"
        assert "AffectedSOPInstanceUID" not in created, "UID leaked into the attribute list"
        # Changing the session (copies, label) and the film box after creating
        # them is routine and must not be mistaken for a stray image box.
        fs2 = Dataset(); fs2.NumberOfCopies = "2"; fs2.FilmSessionLabel = "RELABELLED"
        st, _ = a.send_n_set(fs2, BasicFilmSession, session_uid, meta_uid=meta)
        assert st.Status == 0x0000, f"film session N-SET refused ({st.Status:#06x})"
        fb2 = Dataset(); fb2.FilmOrientation = "LANDSCAPE"
        st, _ = a.send_n_set(fb2, BasicFilmBox, minted[2], meta_uid=meta)
        assert st.Status == 0x0000, f"film box N-SET refused ({st.Status:#06x})"
        m = Dataset(); m.ImageBoxPosition = 1; m.BasicGrayscaleImageSequence = [_gray_item(50)]
        st, _ = a.send_n_set(m, BasicGrayscaleImageBox,
                             created.ReferencedImageBoxSequence[0].ReferencedSOPInstanceUID, meta_uid=meta)
        assert st.Status == 0x0000
        st, _ = a.send_n_action(None, 1, BasicFilmSession, session_uid, meta_uid=meta)
        assert st.Status == 0x0000, f"print action failed ({st.Status:#06x})"
        a.release(); time.sleep(0.3)
        items = _pending(cfg)
        assert len(items) == 1 and items[0]["study_desc"] == "RELABELLED", items
        assert any("Print session from MODALITY01" in ln for ln in _log_lines(server)), _log_lines(server)
        print("  [8] printer-assigned UIDs + Presentation LUT + session/film N-SET: film prints OK")
    finally:
        server.shutdown()


def test_failures_reach_the_log():
    # Every way a print can go wrong from this side leaves a line in the app
    # log that says what happened, not just a status code on the modality.
    server, cfg = _start_server(layout="pdf", allowed_aets=["CT01"])
    try:
        port = cfg.printer["port"]
        meta = BasicGrayscalePrintManagementMeta

        # 1. calling AE not allowed -> refused, and the log says why
        ae = AE(ae_title="STRANGER")
        ae.add_requested_context(meta)
        a = ae.associate("127.0.0.1", port)
        assert a.is_rejected
        time.sleep(0.2)
        assert any("refused STRANGER" in ln and "allowed list" in ln for ln in _log_lines(server)), \
            _log_lines(server)

        # 2. colour asked of a grayscale printer -> named in the log
        ae = AE(ae_title="CT01")
        ae.add_requested_context(BasicColorPrintManagementMeta)
        ae.add_requested_context(Verification)    # something to establish on
        a = ae.associate("127.0.0.1", port)
        assert a.is_established
        time.sleep(0.2)
        assert any(ln.startswith("warn") and "does not offer" in ln and "colour" in ln
                   for ln in _log_lines(server)), _log_lines(server)
        a.release(); time.sleep(0.2)

        # 2b. colour AND grayscale proposed, grayscale accepted -> it prints:
        # an info line, not a problem on the card
        server.print_scp.last_problem = None
        ae = AE(ae_title="CT01")
        ae.add_requested_context(meta)
        ae.add_requested_context(BasicColorPrintManagementMeta)
        a = ae.associate("127.0.0.1", port)
        assert a.is_established
        time.sleep(0.2)
        assert any(ln.startswith("info") and "printing in grayscale" in ln
                   for ln in _log_lines(server)), _log_lines(server)
        assert server.print_scp.last_problem is None, server.print_scp.last_problem

        # 3. image for a box that was never handed out -> refused and logged
        m = Dataset(); m.ImageBoxPosition = 1; m.BasicGrayscaleImageSequence = [_gray_item(40)]
        st, _ = a.send_n_set(m, BasicGrayscaleImageBox, generate_uid(), meta_uid=meta)
        assert st.Status == 0x0112, f"unknown image box should be refused, got {st.Status:#06x}"
        assert any("never handed out" in ln for ln in _log_lines(server)), _log_lines(server)

        # 4. print with nothing in it -> the reason, not just "no data"
        st, _ = a.send_n_action(None, 1, BasicFilmBox, generate_uid(), meta_uid=meta)
        assert st.Status == 0xB603
        assert any("was never created here" in ln for ln in _log_lines(server)), _log_lines(server)

        # 5. an exception pynetdicom swallows -> bridged into the app log
        orig = server.print_scp._handle_n_get
        def boom(event):
            raise RuntimeError("disk on fire")
        server.print_scp._server.unbind(evt.EVT_N_GET, orig)
        server.print_scp._server.bind(evt.EVT_N_GET, boom)
        before = server.print_scp.error_count
        st, _ = a.send_n_get([0x21100010], Printer, PrinterInstance, meta_uid=meta)
        assert st.Status == 0x0110
        time.sleep(0.2)
        # pynetdicom logs the failure twice (the message, then the exception);
        # it is one failure on the card's counter.
        assert server.print_scp.error_count == before + 1, \
            (server.print_scp.error_count, before, _log_lines(server))
        assert any(ln.startswith("error") and "disk on fire" in ln for ln in _log_lines(server)), \
            _log_lines(server)
        a.release(); time.sleep(0.2)
        print("  [9] refused AE, missing colour, stray image, empty print, handler crash: all logged OK")
    finally:
        server.shutdown()


def test_refused_contexts_and_the_session_label():
    # A class proposed twice and refused once is not missing; only a class
    # with no accepted context is named.
    server, cfg = _start_server(layout="pdf")
    try:
        scp = server.print_scp

        class Cx:
            def __init__(self, uid):
                self.abstract_syntax = uid

        class Req:
            ae_title = "CT01"
            address, port = "127.0.0.1", 4000

        class Assoc:
            requestor = Req()
            def __init__(self, ok, refused):
                self.accepted_contexts = [Cx(u) for u in ok]
                self.rejected_contexts = [Cx(u) for u in refused]

        class Ev:
            def __init__(self, ok, refused):
                self.assoc = Assoc(ok, refused)

        scp.last_problem = None
        scp._handle_accepted(Ev([BasicGrayscalePrintManagementMeta],
                                [BasicGrayscalePrintManagementMeta]))
        assert scp.last_problem is None, scp.last_problem
        scp._handle_accepted(Ev([BasicGrayscalePrintManagementMeta],
                                [BasicGrayscalePrintManagementMeta, Printer]))
        msg = scp.last_problem["message"]
        assert "Printer" in msg and "Grayscale" not in msg, msg

        # The session label (modalities put the patient's name in it) titles
        # the pending item but never reaches the log.
        _drive(cfg.printer["port"], BasicGrayscalePrintManagementMeta,
               BasicGrayscaleImageBox, [_gray_item(70)],
               session_attrs={"FilmSessionLabel": "DOE^JANE CHEST"})
        assert _pending(cfg)[0]["study_desc"] == "DOE^JANE CHEST"
        assert not any("DOE^JANE" in ln for ln in _log_lines(server)), _log_lines(server)
        assert any("Print session from" in ln for ln in _log_lines(server))
        print("  [10b] partial refusals named precisely; session label kept out of the log OK")
    finally:
        server.shutdown()


def test_evidence_survives_restart():
    # The card's counters, last print and last problem are what an operator
    # checks after a modality reports a failed print: a Stop/Start or a Save
    # that rebuilds the receiver must not wipe them.
    server, cfg = _start_server(layout="pdf", allowed_aets=["CT01", SCU_AET])
    try:
        port = cfg.printer["port"]
        _drive(port, BasicGrayscalePrintManagementMeta, BasicGrayscaleImageBox, [_gray_item(60)])
        ae = AE(ae_title="STRANGER")
        ae.add_requested_context(BasicGrayscalePrintManagementMeta)
        assert ae.associate("127.0.0.1", port).is_rejected
        time.sleep(0.2)
        before = server.status()["printer"]
        assert before["printed"] == 1 and before["errors"] == 1, before
        assert before["last_print"] and "STRANGER" in before["last_problem"]["message"], before
        assert before["tls_mutual"] is False
        server.set_service("printer", "stop")
        server.set_service("printer", "start")
        new = dict(cfg.data, print=dict(cfg.data["print"], color=True))   # rebuilds it
        res = server.apply_config(new)
        assert res["restarted"] == ["print receiver"], res
        after = server.status()["printer"]
        for key in ("printed", "errors", "last_print", "last_problem", "since"):
            assert after[key] == before[key], (key, before[key], after[key])
        print("  [10] counters, last print and last problem survive Stop/Start and a Save OK")
    finally:
        server.shutdown()


def test_printer_configuration():
    # Some modalities ask the printer what it supports before the first film;
    # a printer that refuses the question can lose the whole print.
    server, cfg = _start_server(layout="pdf", color=True)
    try:
        ae = AE(ae_title=SCU_AET)
        ae.add_requested_context(PrinterConfigurationRetrieval)
        a = ae.associate("127.0.0.1", cfg.printer["port"])
        assert a.is_established, "SCU could not associate for printer configuration"
        st, info = a.send_n_get([0x2000001E], PrinterConfigurationRetrieval,
                                "1.2.840.10008.5.1.1.17.376")
        assert st.Status == 0x0000, f"printer configuration N-GET: 0x{st.Status:04X}"
        item = info.PrinterConfigurationSequence[0]
        assert BasicColorPrintManagementMeta in item.SOPClassesSupported, item
        a.release(); time.sleep(0.2)
        assert server.print_scp.last_problem is None, server.print_scp.last_problem
        print("  [12] printer configuration retrieval answered OK")
    finally:
        server.shutdown()


def test_selftest_echo_and_print():
    # The card's Test button: C-ECHO the printer from the inside, then drive a
    # real one-sheet print that lands in Pending under an unmistakable name. With
    # an allow-list the test calls as its first AE title and says so.
    server, cfg = _start_server(layout="pdf", allowed_aets=["CT01"])
    try:
        res = server.selftest("printer")
        assert res["ok"] and "C-ECHO" in res["message"] and "CT01" in res["message"], res
        assert isinstance(res["ms"], int)
        res = server.selftest("printer", do_print=True)
        assert res["ok"], res
        items = _pending(cfg)
        assert len(items) == 1 and items[0]["study_desc"] == "TEST PRINT — safe to discard", items
        server.set_service("printer", "stop")
        res = server.selftest("printer")
        assert not res["ok"] and "not running" in res["message"], res
        assert not server.selftest("nonsense")["ok"]
        print("  [11] self-test: C-ECHO as the allowed AE, test print lands in Pending OK")
    finally:
        server.shutdown()


def main() -> int:
    tests = [test_grayscale_pdf, test_grayscale_image, test_color_pdf, test_identity_scrape,
             test_annotation_and_printjob, test_bitdepth_and_robustness, test_empty_job_survives,
             test_printer_assigned_uids, test_failures_reach_the_log,
             test_refused_contexts_and_the_session_label,
             test_evidence_survives_restart, test_selftest_echo_and_print,
             test_printer_configuration]
    try:
        for t in tests:
            t()
    except AssertionError as exc:
        print(f"\nFAIL — {exc}", file=sys.stderr)
        return 1
    print("\nPASS — all print SCP scenarios (grayscale/color, PDF/image, identity) green.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
