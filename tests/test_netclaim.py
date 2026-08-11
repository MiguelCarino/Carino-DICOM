"""Claiming a port before binding it for real.

The defect this guards is invisible on the platform the suite mostly runs on.
On POSIX bind() already refuses a port another process is listening on, so there
is nothing to fix and — more to the point — nothing to break: a probe that bound
strictly here would refuse a service its own restart, because the previous
listener's connections sit in TIME_WAIT while the real bind gets through on
SO_REUSEADDR. On Windows the same constant means "sharing permitted" and a
second listener comes up beside the first, so the probe is the whole defence.

So both halves are asserted, each on the platform it applies to, and neither is
a silent skip: a no-op that started raising would take every POSIX restart down,
and a gate that stopped refusing would put Windows back where it was.

Runs under pytest, or standalone: python3 tests/test_netclaim.py
"""

from __future__ import annotations

import os
import socket
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest                                            # noqa: E402

from pacs import netclaim                                # noqa: E402
from pacs.netclaim import claim                          # noqa: E402

WINDOWS = hasattr(socket, "SO_EXCLUSIVEADDRUSE")


def _listener() -> socket.socket:
    """A port held the way every listener in this package holds one."""
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", 0))
    s.listen(1)
    return s


def test_a_free_port_is_claimed_without_complaint():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    claim("127.0.0.1", port)


def test_a_port_somebody_is_listening_on_is_refused_where_the_platform_can_tell():
    held = _listener()
    port = held.getsockname()[1]
    try:
        if WINDOWS:
            with pytest.raises(OSError):
                claim("127.0.0.1", port)
        else:
            # Deliberately not refused: bind() refuses it for real a moment
            # later, and being strict here would cost every restart through
            # TIME_WAIT for a check the platform already makes.
            claim("127.0.0.1", port)
    finally:
        held.close()


def test_the_wildcard_address_is_accepted_as_a_bind_string():
    """scp.bind is free-form and defaults to 0.0.0.0, and an empty string means
    the same thing. Resolving it wrongly would refuse a working config."""
    for bind in ("", "0.0.0.0", "127.0.0.1"):
        s = socket.socket()
        s.bind((bind or "0.0.0.0", 0))
        port = s.getsockname()[1]
        s.close()
        claim(bind, port)


def test_the_gate_refuses_a_live_listener_and_steps_aside_for_the_rest(monkeypatch):
    """Both sides of the decision, because both cost something: refusing too
    eagerly takes a service's own restart down, and refusing too rarely is the
    defect this module exists for.

    Windows runs the real option. Everywhere else it is driven with a stand-in,
    because a second SO_REUSEADDR bind fails on POSIX the way the real one fails
    there — the substitution that must NOT be made on Windows, where that same
    constant means the opposite and the bind would succeed. Making it anyway is
    how this test first failed on Windows and nowhere else, which is a fair
    summary of the bug."""
    if not WINDOWS:
        monkeypatch.setattr(netclaim, "_EXCLUSIVE", socket.SO_REUSEADDR)

    live = _listener()
    try:
        with pytest.raises(OSError):
            claim("127.0.0.1", live.getsockname()[1])
    finally:
        live.close()

    encumbered = socket.socket()
    encumbered.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    encumbered.bind(("127.0.0.1", 0))
    try:
        # Bound but never listening: no association can arrive here, so refusing
        # would cost a start and save nothing. TIME_WAIT wears this same shape,
        # which is the case that would otherwise break every restart.
        claim("127.0.0.1", encumbered.getsockname()[1])
    finally:
        encumbered.close()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
