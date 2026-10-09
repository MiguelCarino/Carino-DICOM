"""Push the forged studies into the running instance the way a modality would.

C-STORE for the archive, an HL7 ORM^O01 over MLLP for the order list, and —
when a fourth argument names the published print port — one film printed the
way a print-only ultrasound prints it, so the print card shows a real
"Last print" and Pending holds a captured sheet. Nothing is written into the
instance's folders by hand: the screenshots should show what the software did,
not what a script staged.

    seed-traffic.py <forged-dir> <scp-port> <ris-port> [<print-port>]
"""
import pathlib
import socket
import sys
import time

from pydicom import dcmread
from pynetdicom import AE

FORGED = pathlib.Path(sys.argv[1])
SCP_PORT = int(sys.argv[2])
RIS_PORT = int(sys.argv[3])
PRINT_PORT = int(sys.argv[4]) if len(sys.argv) > 4 else 0

# Which calling AE title each patient's study arrives under — the routing rules
# in this instance key off ER_* for the CT-from-the-emergency-room case.
CALLING = {
    "DEMO-0001": "ER_CT_01",
    "DEMO-0002": "US_ROOM_2",
    "DEMO-0003": "CR_PORTABLE",
    "DEMO-0004": "MR_CONSOLE",
    "DEMO-0005": "ER_CT_01",
}

files = sorted(FORGED.glob("*.dcm"))
by_patient = {}
for f in files:
    by_patient.setdefault(f.name.split("_")[0], []).append(f)

sent = 0
for pid, paths in by_patient.items():
    ae = AE(ae_title=CALLING.get(pid, "MODALITY"))
    ds0 = dcmread(paths[0])
    ae.add_requested_context(ds0.SOPClassUID, "1.2.840.10008.1.2.1")
    # The called AE must match the target's scp.aet. This is only ever pointed
    # at the two containers the README brings up, and those are built from this
    # repository, so they answer to the current default; an instance installed
    # before the rename still answers to CARINOPACS.
    assoc = ae.associate("127.0.0.1", SCP_PORT, ae_title="CARINODICOM")
    if not assoc.is_established:
        print(f"  ! {pid}: association rejected")
        continue
    for p in paths:
        status = assoc.send_c_store(dcmread(p))
        if getattr(status, "Status", None) == 0x0000:
            sent += 1
    assoc.release()
    print(f"  {pid}: {len(paths)} instances as {CALLING.get(pid)}")
    time.sleep(0.4)

print(f"stored {sent}/{len(files)}")

# ---- HL7 orders, so the Orders panel has a worklist ------------------------
ORDERS = [
    ("A2400122", "DEMO-0006", "PHANTOM^ZETA",  "CT", "ABDOMEN AND PELVIS WITH CONTRAST"),
    ("A2400123", "DEMO-0007", "TESTPATTERN^ETA", "CR", "CHEST PA"),
    ("A2400124", "DEMO-0008", "PHANTOM^THETA", "MR", "LUMBAR SPINE WITHOUT CONTRAST"),
]
for i, (acc, pid, name, modality, desc) in enumerate(ORDERS):
    msg = "\r".join([
        f"MSH|^~\\&|EXAMPLERIS|EXAMPLE|CARINODICOM|EXAMPLE|20260808093000||ORM^O01|MSG{i:05d}|P|2.3",
        f"PID|||{pid}||{name}||19700101|O",
        f"ORC|NW|{acc}||||||||||REF^EXAMPLE^REFERRER",
        f"OBR|1|{acc}||{desc}|||20260808093000|||||||||REF^EXAMPLE^REFERRER||||||||{modality}",
    ]) + "\r"
    frame = b"\x0b" + msg.encode("utf-8") + b"\x1c\r"
    with socket.create_connection(("127.0.0.1", RIS_PORT), timeout=5) as s:
        s.sendall(frame)
        s.settimeout(5)
        try:
            ack = s.recv(4096)
        except socket.timeout:
            ack = b"(no ack)"
    print(f"  order {acc}: {ack[:40]!r}")

# ---- one printed film, so the print card and Pending have something real ---
# The same conversation test_print.py's _drive() holds, cut to its minimum: film
# session, film box, one image box, print. The SCU supplies its own UIDs here
# because pynetdicom's SCU does not hand back the ones a printer mints; the
# minting path has its own test.
if PRINT_PORT:
    from pydicom.dataset import Dataset
    from pydicom.uid import generate_uid
    from pynetdicom.sop_class import (
        BasicFilmBox, BasicFilmSession, BasicGrayscaleImageBox,
        BasicGrayscalePrintManagementMeta,
    )
    meta = BasicGrayscalePrintManagementMeta
    ae = AE(ae_title="US_ROOM_2")
    ae.add_requested_context(meta)
    assoc = ae.associate("127.0.0.1", PRINT_PORT, ae_title="CARINOPRINT")
    if not assoc.is_established:
        print("  ! print: association rejected")
    else:
        su, fu = generate_uid(), generate_uid()
        fs = Dataset()
        fs.FilmSessionLabel = "US ABDOMEN (demo film)"
        assoc.send_n_create(fs, BasicFilmSession, su, meta_uid=meta)
        fb = Dataset()
        fb.ImageDisplayFormat = "STANDARD\\1,1"
        st, created = assoc.send_n_create(fb, BasicFilmBox, fu, meta_uid=meta)
        rows = cols = 256
        img = Dataset()
        img.SamplesPerPixel = 1
        img.PhotometricInterpretation = "MONOCHROME2"
        img.Rows, img.Columns = rows, cols
        img.BitsAllocated = img.BitsStored = 8
        img.HighBit = 7
        img.PixelRepresentation = 0
        # A plain diagonal ramp: obviously a test pattern, never an image of anyone.
        img.PixelData = bytes((r + c) // 2 for r in range(rows) for c in range(cols))
        m = Dataset()
        m.ImageBoxPosition = 1
        m.BasicGrayscaleImageSequence = [img]
        box = created.ReferencedImageBoxSequence[0]
        assoc.send_n_set(m, BasicGrayscaleImageBox, box.ReferencedSOPInstanceUID, meta_uid=meta)
        st, _ = assoc.send_n_action(None, 1, BasicFilmBox, fu, meta_uid=meta)
        assoc.release()
        print(f"  print: one film as US_ROOM_2 (status {getattr(st, 'Status', '?')})")
