"""Build ssl.SSLContext objects for DICOM-over-TLS.

The receiver (SCP) uses a *server* context: its own certificate + private key,
and — if a CA is supplied — it also requires and verifies client certificates
(mutual TLS). The sender (SCU) uses a *client* context: verify the remote's
certificate against a CA (or the system trust store), optionally present our
own certificate for mutual TLS, or skip verification entirely for self-signed
/ test setups.
"""

from __future__ import annotations

import ssl


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
