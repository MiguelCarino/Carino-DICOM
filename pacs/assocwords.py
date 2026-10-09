"""Association refusals and failures in words an operator can act on.

pynetdicom keeps the A-ASSOCIATE-RJ result / source / reason on the
association and says what they meant only in its own logger, which nobody on
the floor reads. Both sides of a refusal end up here: the listeners, to say
why they turned a modality away, and the sender, to say why a remote turned
us away.
"""

from __future__ import annotations

# (source, diagnostic) -> plain words. PS3.8 9.3.4: the meaning of the reason
# depends on which layer refused.
_REASONS = {
    (1, 1): "no reason given",
    (1, 2): "application context not supported",
    (1, 3): "calling AE title not recognised",
    (1, 7): "called AE title not recognised",
    (2, 1): "no reason given",
    (2, 2): "protocol version not supported",
    (3, 1): "temporary congestion",
    (3, 2): "too many associations at once",
}


def reject_parts(primitive) -> tuple[int, int, int]:
    """(result, source, diagnostic) of an A-ASSOCIATE-RJ primitive; zeros when
    the primitive is missing or carries none of them."""
    def num(name):
        try:
            return int(getattr(primitive, name, 0) or 0)
        except (TypeError, ValueError):
            return 0
    return num("result"), num("result_source"), num("diagnostic")


def reject_reason(primitive) -> str:
    """The reason half alone: "calling AE title not recognised"."""
    _result, source, diag = reject_parts(primitive)
    return _REASONS.get((source, diag), f"reason {source}/{diag}")


def describe_reject(primitive, *, calling_aet: str = "", called_aet: str = "") -> str:
    """One sentence for a refusal we received, with the fix when there is one."""
    result, source, diag = reject_parts(primitive)
    how = "permanently" if result == 1 else "for now" if result == 2 else ""
    text = f"rejected {how}: {reject_reason(primitive)}" if how else \
        f"rejected: {reject_reason(primitive)}"
    if (source, diag) == (1, 3) and calling_aet:
        text += f" — add {calling_aet} to the remote's allowed AE titles"
    elif (source, diag) == (1, 7) and called_aet:
        text += f" — the remote does not answer to {called_aet}; check the AE title"
    elif source == 3:
        text += " — the remote is busy; it will be tried again"
    return text


def listener_refusal(event, allowed_aets) -> str:
    """Why one of our listeners refused an association (for EVT_REJECTED).

    Read off the reject we actually sent rather than re-derived, so it cannot
    disagree with what the modality was told; the allow-list is named because
    that is where the fix is."""
    prim = None
    try:
        prim = event.assoc.acceptor.primitive
    except Exception:
        pass
    _result, source, diag = reject_parts(prim)
    allowed = [a.strip() for a in (allowed_aets or []) if str(a).strip()]
    if (source, diag) == (1, 3) or (prim is None and allowed):
        return f"its AE title is not in the allowed list ({', '.join(allowed)})" if allowed \
            else "its AE title is not recognised"
    if (source, diag) == (3, 2):
        return "too many connections at once"
    return reject_reason(prim) if prim is not None else "refused"


def caller_of(event) -> tuple[str, str]:
    """(calling AE title, peer address) of an association event, best effort."""
    try:
        who = str(event.assoc.requestor.ae_title or "").strip()
    except Exception:
        who = ""
    try:
        addr = str(event.assoc.requestor.address or "") or "?"
    except Exception:
        addr = "?"
    return who, addr

