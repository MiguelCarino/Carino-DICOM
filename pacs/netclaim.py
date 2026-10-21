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
    infos = socket.getaddrinfo(bind or "0.0.0.0", int(port), type=socket.SOCK_STREAM)
    # Resolve the way pynetdicom's AddressInformation does when it binds: the
    # first IPv4 answer, else the first IPv6 one. getaddrinfo('localhost') lists
    # ::1 first on most hosts, and probing [::1] while the real bind lands on
    # 127.0.0.1 let the guard pass a port another engine already held there.
    for info in infos:
        if info[0] == socket.AF_INET:
            family, socktype, proto, _canon, addr = info
            return family, socktype, proto, addr
    family, socktype, proto, _canon, addr = infos[0]
    return family, socktype, proto, addr


def _local_addresses() -> list[str]:
    """This machine's own IPv4 addresses, best effort, for probing a wildcard
    bind: a listener on one specific interface is not answering on 127.0.0.1,
    and Winsock lets a wildcard bind share its port."""
    out: list[str] = []
    try:
        for a in socket.gethostbyname_ex(socket.gethostname())[2]:
            if a not in out and not a.startswith("127."):
                out.append(a)
    except OSError:
        pass
    return out


def _accepting(bind: str, port: int) -> bool:
    """Is something actually answering on this port?

    A completed connection is the only evidence that separates a live listener
    from the wreckage a closed one leaves behind. That distinction is the whole
    reason this exists: connections in TIME_WAIT can fail an exclusive bind, and
    refusing on those would stop a service restarting after its own shutdown —
    trading a rare silent split for a common noisy outage, which is a worse
    deal than the bug.
    """
    # A wildcard cannot be connected to, so it becomes the loopback of its own
    # family. "::" resolved to 127.0.0.1 dialled the wrong stack: an IPv6-bound
    # listener was never found, the probe reported nothing there, and the port
    # was allowed — the exact silent double-bind this module exists to stop.
    host = {"": "127.0.0.1", "0.0.0.0": "127.0.0.1", "::": "::1"}.get(bind, bind)
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
    if (bind or "0.0.0.0") in ("0.0.0.0", "::"):
        # A wildcard bind succeeds beside a listener on one specific address,
        # so ask each of this machine's own addresses whether one answers.
        for a in _local_addresses():
            if _accepting(a, port):
                raise OSError(f"port {port} is already in use on {a}")


# ---- association limits for the DIMSE listeners -----------------------------
DEFAULT_MAX_ASSOCIATIONS = 50
DEFAULT_MAX_PER_HOST = 20
DEFAULT_ACSE_TIMEOUT = 10.0


def limit_listener(ae, max_associations=None, acse_timeout=None) -> None:
    """Raise pynetdicom's association ceiling (default 10, which eleven silent
    TCP connections from anywhere used to fill, locking out even allow-listed
    modalities) and shorten the wait for an A-ASSOCIATE-RQ, so a socket that
    never speaks is dropped in seconds rather than holding a slot for 30."""
    try:
        n = int(max_associations or DEFAULT_MAX_ASSOCIATIONS)
    except (TypeError, ValueError):
        n = DEFAULT_MAX_ASSOCIATIONS
    ae.maximum_associations = max(1, n)
    ae.acse_timeout = float(acse_timeout or DEFAULT_ACSE_TIMEOUT)


def cap_per_host(server, max_per_host=None, log=None, label: str = "listener") -> None:
    """Refuse a new TCP connection from a host that already holds
    *max_per_host* associations on *server*, before any DICOM is spoken, so a
    single machine cannot occupy every slot the listener has. 0 disables."""
    try:
        cap = int(DEFAULT_MAX_PER_HOST if max_per_host is None else max_per_host)
    except (TypeError, ValueError):
        cap = DEFAULT_MAX_PER_HOST
    if cap <= 0 or server is None:
        return

    def verify_request(request, client_address) -> bool:
        host = client_address[0] if isinstance(client_address, tuple) else str(client_address)
        held = 0
        try:
            for a in list(server.active_associations):
                try:
                    if a.is_acceptor and str(a.requestor.address) == host:
                        held += 1
                except Exception:
                    continue
        except Exception:
            return True
        if held >= cap:
            if log is not None:
                try:
                    log.warn(f"{label}: refused a connection from {host} — it already "
                             f"holds {held} associations (limit {cap})", kind="scp")
                except Exception:
                    pass
            return False
        return True

    server.verify_request = verify_request
