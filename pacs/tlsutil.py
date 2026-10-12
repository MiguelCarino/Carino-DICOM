"""Build ssl.SSLContext objects for DICOM-over-TLS and for the HTTPS dashboard.

The receiver (SCP) uses a *server* context: its own certificate + private key,
and — if a CA is supplied — it also requires and verifies client certificates
(mutual TLS). The sender (SCU) uses a *client* context: verify the remote's
certificate against a CA (or the system trust store), optionally present our
own certificate for mutual TLS, or skip verification entirely for self-signed
/ test setups.
"""

from __future__ import annotations

import hashlib
import ipaddress
import os
import socket
import ssl

# TLS 1.2 suites for the dashboard: forward secrecy and AEAD only. TLS 1.3 has
# its own fixed list in OpenSSL and is not affected by this string.
WEB_CIPHERS = "ECDHE+AESGCM:ECDHE+CHACHA20:DHE+AESGCM:DHE+CHACHA20:!aNULL:!eNULL:!MD5:!DSS:!SHA1"


def server_context(certfile: str, keyfile: str, ca: str = "") -> ssl.SSLContext:
    """The context a listener binds with. Raises ValueError if cert or key is missing.

    Every listener builds this once, as it starts, and hands it to pynetdicom
    for the life of the socket: a certificate replaced on disk — a renewal — is
    not in use until that service is restarted.
    """
    if not certfile or not keyfile:
        raise ValueError("TLS receiver needs both a certificate and a private key")
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(certfile=certfile, keyfile=keyfile)
    if ca:
        # A CA on the receiver side means: require + verify client certs (mTLS).
        ctx.load_verify_locations(cafile=ca)
        ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx


def client_context(verify: bool = True, ca: str = "", certfile: str = "", keyfile: str = "") -> ssl.SSLContext:
    """The context every outbound association dials with — one for all destinations.

    Verifying means verifying the NAME as well: PROTOCOL_TLS_CLIENT switches
    hostname checking on and the verify branch leaves it on, and pynetdicom is
    given the destination's configured host as the name to check. A node
    addressed by IP therefore needs that IP in the certificate's SAN, or the
    association fails on a certificate that is otherwise perfectly valid.

    An empty ``keyfile`` is not "no key" — it is the ssl default, which looks
    for the private key inside ``certfile``.
    """
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    if verify:
        if ca:
            ctx.load_verify_locations(cafile=ca)
        else:
            ctx.load_default_certs()  # system trust store
    else:
        # Encrypted but unauthenticated — fine for self-signed / testing.
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    if certfile:
        ctx.load_cert_chain(certfile=certfile, keyfile=keyfile or None)
    return ctx


# ---- the web dashboard -------------------------------------------------------

class _LazyHandshakeContext(ssl.SSLContext):
    """An SSLContext that never handshakes inside accept().

    Werkzeug wraps its LISTENING socket with this context, and Python's
    SSLSocket.accept() then performs the TLS handshake of every new connection
    on the thread that accepts — the one thread the whole dashboard has. A
    client that opens a TCP connection and sends nothing would stall every
    other request until it gave up. With do_handshake_on_connect forced off,
    the handshake happens on the first read instead, which is in the
    per-request worker thread, so a stalled client holds one thread and nothing
    else.
    """

    def wrap_socket(self, sock, server_side=False, do_handshake_on_connect=True, *args, **kwargs):
        return super().wrap_socket(sock, server_side, False, *args, **kwargs)


def _readable_file(path: str, what: str) -> None:
    if not path:
        raise ValueError(f"web.tls is on but web.{what} is not set")
    if not os.path.isfile(path):
        raise ValueError(f"web.{what}: {path} does not exist (or is not a file)")
    try:
        with open(path, "rb") as fh:
            fh.read(1)
    except OSError as exc:
        raise ValueError(f"web.{what}: {path} cannot be read by this account ({exc.strerror or exc})") from None


def web_server_context(certfile: str, keyfile: str) -> ssl.SSLContext:
    """The HTTPS context for the dashboard and DICOMweb.

    TLS 1.2 minimum, forward-secret AEAD suites only. Raises ValueError with a
    sentence an operator can act on: which file, and what is wrong with it.
    Like the DICOM listeners, the certificate is read once at start; a renewed
    one is in use after a restart.
    """
    _readable_file(certfile, "tls_cert")
    _readable_file(keyfile, "tls_key")
    ctx = _LazyHandshakeContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.set_ciphers(WEB_CIPHERS)
    ctx.options |= ssl.OP_NO_COMPRESSION | ssl.OP_CIPHER_SERVER_PREFERENCE
    try:
        ctx.load_cert_chain(certfile=certfile, keyfile=keyfile)
    except ssl.SSLError as exc:
        reason = (exc.reason or str(exc)).upper()
        if "KEY_VALUES_MISMATCH" in reason or "MISMATCH" in reason:
            raise ValueError(f"web.tls_key {keyfile} is not the private key of the certificate "
                             f"{certfile} — they do not belong together") from None
        if "PEM" in reason or "NO_START_LINE" in reason or "BAD_BASE64" in reason:
            raise ValueError(f"web.tls_cert / web.tls_key: {certfile} or {keyfile} is not a PEM "
                             f"certificate / private key ({exc.reason or exc})") from None
        raise ValueError(f"web TLS: could not load {certfile} with {keyfile}: {exc}") from None
    except OSError as exc:
        raise ValueError(f"web TLS: could not load {certfile} with {keyfile}: {exc}") from None
    return ctx


def cert_fingerprint(certfile: str) -> str:
    """SHA-256 fingerprint of the first certificate in a PEM file, as AA:BB:…

    The same value a browser shows under the certificate's details, so an
    operator can compare the two before trusting a self-signed certificate.
    """
    with open(certfile, "r", encoding="ascii", errors="replace") as fh:
        pem = fh.read()
    end = "-----END CERTIFICATE-----"
    i = pem.find("-----BEGIN CERTIFICATE-----")
    j = pem.find(end, i)
    if i < 0 or j < 0:
        raise ValueError(f"{certfile} contains no PEM certificate")
    der = ssl.PEM_cert_to_DER_cert(pem[i:j + len(end)] + "\n")
    digest = hashlib.sha256(der).hexdigest().upper()
    return ":".join(digest[k:k + 2] for k in range(0, len(digest), 2))


def lan_ip() -> str:
    """The address this machine would use to reach a LAN peer, or "".

    A UDP connect sends nothing; it only asks the kernel which source address
    the route would use.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))       # TEST-NET-1: never routed, never sent to
            ip = s.getsockname()[0]
    except OSError:
        return ""
    return "" if ip.startswith("127.") or ip == "0.0.0.0" else ip


def generate_self_signed(certfile: str, keyfile: str, names, days: int = 825) -> str:
    """Write a self-signed certificate + private key for the dashboard.

    ``names`` are DNS names and/or IP addresses; each becomes a SAN, and
    localhost / 127.0.0.1 / ::1 are always added so the loopback URL keeps
    working. The key is ECDSA P-256 and is created mode 0600. Returns the
    certificate's SHA-256 fingerprint.

    Needs the ``cryptography`` package (in requirements.txt). The engine itself
    does not: serving HTTPS is the standard library's ssl module.
    """
    try:
        import datetime
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    except ImportError:
        raise RuntimeError(
            "generating a certificate needs the 'cryptography' package: pip install cryptography\n"
            "  or make one with openssl instead:\n"
            "  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 825 \\\n"
            "    -keyout web-key.pem -out web-cert.pem -subj /CN=carino-dicom \\\n"
            "    -addext subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<this machine's LAN IP>"
        ) from None

    sans, seen = [], set()
    for raw in list(names) + ["localhost", "127.0.0.1", "::1"]:
        n = str(raw).strip()
        if not n or n.lower() in seen:
            continue
        seen.add(n.lower())
        try:
            sans.append(x509.IPAddress(ipaddress.ip_address(n)))
        except ValueError:
            sans.append(x509.DNSName(n))
    cn = next((str(n).strip() for n in names if str(n).strip()), "localhost")[:64]

    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn),
                         x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Carino DICOM (self-signed)")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject).issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=int(days)))
        .add_extension(x509.SubjectAlternativeName(sans), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, key_encipherment=False, content_commitment=False,
                                     data_encipherment=False, key_agreement=False, key_cert_sign=False,
                                     crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(key, hashes.SHA256())
    )
    for path in (certfile, keyfile):
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    key_pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption())
    # O_EXCL-free but created 0600 from the first byte: never world-readable,
    # not even between open() and a later chmod().
    fd = os.open(keyfile, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(key_pem)
    try:
        os.chmod(keyfile, 0o600)        # an existing file keeps its old mode through O_TRUNC
    except OSError:
        pass                            # Windows: ACLs, not mode bits
    with open(certfile, "wb") as fh:
        fh.write(cert.public_bytes(serialization.Encoding.PEM))
    return cert_fingerprint(certfile)
