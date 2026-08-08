"""Push the forged studies into the running instance the way a modality would.

C-STORE for the archive, an HL7 ORM^O01 over MLLP for the order list. Nothing
is written into the instance's folders by hand: the screenshots should show
what the software did, not what a script staged.
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
    assoc = ae.associate("127.0.0.1", SCP_PORT, ae_title="CARINOPACS")
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
        f"MSH|^~\\&|EXAMPLERIS|EXAMPLE|CARINOPACS|EXAMPLE|20260808093000||ORM^O01|MSG{i:05d}|P|2.3",
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
