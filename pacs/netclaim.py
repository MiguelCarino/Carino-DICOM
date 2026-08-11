"""Refuse a port something else is already listening on.

POSIX needs nothing here. bind() already fails with EADDRINUSE when another
process holds the port, SO_REUSEADDR or not, and every listener in this package
finds out that way — which is why a receiver moved onto an occupied port stays
down and says so.

Windows does not work like that, and the difference is not a detail. Winsock's
SO_REUSEADDR does not mean "rebind through TIME_WAIT", it means "sharing
permitted": Microsoft's own table gives a second SO_REUSEADDR bind over a first
one as Success, permitted across user accounts, after which "the behavior for
all sockets bound to that port is indeterminate ... any incoming TCP connection
requests over the port cannot be guaranteed to be handled by the correct
socket". Every listener this appliance opens sets that option — the DIMSE SCPs
through pynetdicom's AssociationServer.server_bind, the HL7 listener by hand,
the dashboard through Werkzeug's allow_reuse_address — so on Windows all of them
opt out of the protection the platform would otherwise have given them.

What that costs here: two engines can hold 11112 at once, both reporting a
healthy receiver, with each incoming association going to whichever of them
Winsock picks. A modality's study then lands in one instance's storage folder or
is split across two, and the operator sees a study short by some images with
nothing anywhere saying why. An image that silently never arrives is the failure
this project is written against, so the port is claimed exclusively first.

    https://learn.microsoft.com/en-us/windows/win32/winsock/using-so-reuseaddr-and-so-exclusiveaddruse
"""

from __future__ import annotations

import socket

# Absent on POSIX, which is exactly how this module decides it has nothing to do.
_EXCLUSIVE = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)


def _resolve(bind: str, port: int):
    """(family, socktype, proto, sockaddr) for a bind string. `bind` is free-form
    config and defaults to 0.0.0.0, so this must accept "", a dotted quad, a
    hostname and an IPv6 literal alike — refusing a spelling that works would
    stop a service that had been starting fine."""
    family, socktype, proto, _canon, addr = socket.getaddrinfo(
        bind or "0.0.0.0", int(port), type=socket.SOCK_STREAM)[0]
    return family, socktype, proto, addr


def _accepting(bind: str, port: int) -> bool:
    """Is something actually answering on this port?

    A completed connection is the only evidence that separates a live listener
    from the wreckage a closed one leaves behind. That distinction is the whole
    reason this exists: connections in TIME_WAIT can fail an exclusive bind, and
    refusing on those would stop a service restarting after its own shutdown —
    trading a rare silent split for a common noisy outage, which is a worse
    deal than the bug.
    """
    host = "127.0.0.1" if bind in ("", "0.0.0.0", "::") else bind
    try:
        family, socktype, proto, addr = _resolve(host, port)
    except OSError:
        return False
    probe = socket.socket(family, socktype, proto)
    probe.settimeout(0.5)
    try:
        return probe.connect_ex(addr) == 0
    except OSError:
        return False
    finally:
        probe.close()


def claim(bind: str, port: int) -> None:
    """Raise OSError if something is already listening on (*bind*, *port*).
    No-op on POSIX, where bind() refuses it a moment later anyway.

    SO_EXCLUSIVEADDRUSE is the only probe on Windows that reports a port held by
    an SO_REUSEADDR listener as busy — a plain bind would quietly join it. It is
    tried first because it costs nothing and touches nobody: the probe never
    listens and never accepts.

    A probe that fails is not on its own proof that anyone is there, so it is
    confirmed by connecting before the port is refused. Bound-but-not-listening
    and TIME_WAIT both fail the probe and neither can take an association, so
    neither is worth refusing a start for.

    There is a window between this and the real bind. It is microseconds wide,
    and the case being guarded is two engines started minutes apart, not two
    racing.
    """
    if _EXCLUSIVE is None:
        return
    family, socktype, proto, addr = _resolve(bind, port)
    probe = socket.socket(family, socktype, proto)
    try:
        probe.setsockopt(socket.SOL_SOCKET, _EXCLUSIVE, 1)
        probe.bind(addr)
    except OSError:
        if _accepting(bind, port):
            raise
    finally:
        probe.close()
