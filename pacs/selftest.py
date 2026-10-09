"""A listener tested from the inside: connect to our own port the way a
modality would, and say in one sentence whether it answered.

Every function here returns ``(ok, message)`` and never raises — the dashboard
button that calls them must get an answer, not a 500 — and every network wait
is bounded, because a listener that has hung is exactly the case worth testing.
"""

from __future__ import annotations

import socket
import ssl
import time
from typing import Optional

# What a test film is called in Pending, so nobody mistakes it for a patient's.
TEST_PRINT_DESC = "TEST PRINT — safe to discard"

_TIMEOUT = 8


def loopback_for(bind: str) -> str:
    """The address to dial a listener on: its bind address, or loopback when
    it listens on every interface."""
    b = str(bind or "").strip()
    return "127.0.0.1" if b in ("", "0.0.0.0", "::", "*") else b


def client_tls(mutual: bool, certfile: str = "", keyfile: str = "") -> ssl.SSLContext:
    """A client context for talking to OUR OWN TLS listener. The certificate is
    not verified: this checks that the listener answers, and the name it was
    issued for is rarely 127.0.0.1. A mutual listener wants a client
    certificate; the sender's (Auto-send) is offered when one is set."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    if mutual and certfile and keyfile:
        ctx.load_cert_chain(certfile, keyfile)
    return ctx


def _gray_film_item(rows: int = 64, cols: int = 64):
    from pydicom.dataset import Dataset
    it = Dataset()
    it.SamplesPerPixel = 1
    it.PhotometricInterpretation = "MONOCHROME2"
    it.Rows, it.Columns = rows, cols
    it.BitsAllocated = it.BitsStored = 8
    it.HighBit = 7
    it.PixelRepresentation = 0
    it.PixelData = bytes((c * 255) // (cols - 1) for _r in range(rows) for c in range(cols))
    return it


def test_print(host: str, port: int, called_aet: str, calling_aet: str,
               tls_context: Optional[ssl.SSLContext] = None) -> tuple[bool, str]:
    """Drive one grayscale, one-sheet print through a print SCP, the four moves
    a modality makes: Film Session, Film Box, Image Box, print."""
    from pydicom.dataset import Dataset
    from pydicom.uid import generate_uid
    from pynetdicom import AE
    from pynetdicom.sop_class import (BasicFilmBox, BasicFilmSession, BasicGrayscaleImageBox,
                                      BasicGrayscalePrintManagementMeta as META)
    ae = AE(ae_title=calling_aet)
    ae.add_requested_context(META)
    ae.acse_timeout = ae.dimse_timeout = ae.network_timeout = _TIMEOUT
    ae.connection_timeout = _TIMEOUT
    try:
        assoc = ae.associate(host, port, ae_title=called_aet,
                             tls_args=(tls_context, host) if tls_context else None)
    except (OSError, ssl.SSLError) as exc:
        return False, f"could not connect: {exc}"
    if not assoc.is_established:
        return False, "the print receiver did not accept the association (see the log for why)"
    try:
        session, film = generate_uid(), generate_uid()
        fs = Dataset()
        fs.SpecificCharacterSet = "ISO_IR 192"      # the dash in the description
        fs.FilmSessionLabel = "TEST PRINT"
        fs.StudyDescription = TEST_PRINT_DESC
        st, _ = assoc.send_n_create(fs, BasicFilmSession, session, meta_uid=META)
        if not st or st.Status != 0x0000:
            return False, f"Film Session refused ({_code(st)})"
        fb = Dataset()
        fb.ImageDisplayFormat = "STANDARD\\1,1"
        st, created = assoc.send_n_create(fb, BasicFilmBox, film, meta_uid=META)
        if not st or st.Status != 0x0000 or created is None:
            return False, f"Film Box refused ({_code(st)})"
        box = created.ReferencedImageBoxSequence[0].ReferencedSOPInstanceUID
        ib = Dataset()
        ib.ImageBoxPosition = 1
        ib.BasicGrayscaleImageSequence = [_gray_film_item()]
        st, _ = assoc.send_n_set(ib, BasicGrayscaleImageBox, box, meta_uid=META)
        if not st or st.Status != 0x0000:
            return False, f"image refused ({_code(st)})"
        st, _ = assoc.send_n_action(None, 1, BasicFilmBox, film, meta_uid=META)
        if not st or st.Status != 0x0000:
            return False, f"print refused ({_code(st)})"
        return True, f'captured — it is in Pending as "{TEST_PRINT_DESC}"'
    except Exception as exc:                      # a malformed reply must not become a 500
        return False, f"print conversation failed: {exc}"
    finally:
        assoc.release()


def _code(status) -> str:
    return f"0x{status.Status:04X}" if status else "no response"


def hl7_ping(host: str, port: int) -> tuple[bool, str]:
    """Send the listener one HL7 message that is not an order (a QRY, which it
    acknowledges and ignores) and read the ACK back."""
    VT, FS, CR = b"\x0b", b"\x1c", b"\x0d"
    ctrl = f"SELFTEST{int(time.time())}"
    stamp = time.strftime("%Y%m%d%H%M%S")
    msg = (f"MSH|^~\\&|CARINOSELFTEST|CARINO|CARINORIS|CARINO|{stamp}||QRY^A19|{ctrl}|P|2.3\r"
           f"QRD|{stamp}|R|I|{ctrl}|||1^RD|SELFTEST|DEM\r")
    try:
        with socket.create_connection((host, port), timeout=_TIMEOUT) as s:
            s.settimeout(_TIMEOUT)
            s.sendall(VT + msg.encode("ascii") + FS + CR)
            buf = b""
            while FS + CR not in buf:
                chunk = s.recv(4096)
                if not chunk:
                    break
                buf += chunk
    except ConnectionRefusedError:
        return False, f"connection refused on {host}:{port}"
    except (socket.timeout, TimeoutError):
        return False, f"no ACK from {host}:{port} within {_TIMEOUT}s"
    except OSError as exc:
        return False, f"could not reach {host}:{port}: {exc}"
    if not buf:
        return False, "connected, but the listener closed the connection without an ACK"
    text = buf.strip(VT + FS + CR).decode("utf-8", "replace")
    for seg in text.split("\r"):
        if seg.startswith("MSA|"):
            code = (seg.split("|") + ["", ""])[1]
            if code in ("AA", "CA"):
                return True, "answered with an HL7 ACK"
            return False, f"answered {code} instead of AA"
    return False, "answered, but not with an HL7 ACK"
