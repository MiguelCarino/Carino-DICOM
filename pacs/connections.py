"""The connection doctor: what happened on recent DICOM associations, and why.

A failed transfer is usually not a broken network. It is two configurations
that disagree — an AE title typed on one side only, a port that belongs to
another service, a modality that offers JPEG 2000 to a node that takes CT only
uncompressed — and each side's log says only "association rejected" or
"no presentation context". The fix is always on one side or the other, and
naming it needs the negotiation itself: who called whom, as what, offering
which SOP classes in which transfer syntaxes, and the per-context answer.

Two halves. ConnectionJournal keeps that negotiation for recent associations
in both directions — our listeners' incoming ones and the sender's outgoing
ones. diagnose() turns one entry into a sentence and a fix, and suggests only
settings that exist; where the remedy is on the other machine it says so.

The journal holds UIDs, AE titles and addresses only. Nothing here touches a
dataset, so no patient identifier can reach it, and it lives in memory: what
it describes is the last few minutes of traffic, which a restart makes stale
anyway, and every failure it records is also in the Activity log and its dated
files.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from typing import Optional

from .assocwords import reject_parts, reject_reason

# Distinct situations kept, not associations: see _key().
CAPACITY = 200

# PS3.8 9.3.3.2 Presentation Context Item (A-ASSOCIATE-AC), Result/Reason.
ACCEPTED, USER_REJECTION, NO_REASON, SOP_NOT_SUPPORTED, TS_NOT_SUPPORTED = 0, 1, 2, 3, 4

IMPLICIT_LE = "1.2.840.10008.1.2"
EXPLICIT_LE = "1.2.840.10008.1.2.1"
VERIFICATION = "1.2.840.10008.1.1"
# The native (unencapsulated) encodings, PS3.5 A.1-A.3. Every Storage SCP must
# take Implicit VR Little Endian (PS3.5 10.1), so this is what "uncompressed"
# means when a fix tells the other side to send it.
UNCOMPRESSED = frozenset({IMPLICIT_LE, EXPLICIT_LE, "1.2.840.10008.1.2.2"})

# pydicom's names for transfer syntaxes are the standard's full titles
# ("JPEG Lossless, Non-Hierarchical, First-Order Prediction (Process 14
# [Selection Value 1])"), which no modality menu uses. These are the names on
# the export screens a technologist will be looking at.
_TS_NAMES = {
    IMPLICIT_LE: "Implicit VR Little Endian",
    EXPLICIT_LE: "Explicit VR Little Endian",
    "1.2.840.10008.1.2.1.99": "Deflated Explicit VR Little Endian",
    "1.2.840.10008.1.2.2": "Explicit VR Big Endian",
    "1.2.840.10008.1.2.4.50": "JPEG Baseline",
    "1.2.840.10008.1.2.4.51": "JPEG Extended",
    "1.2.840.10008.1.2.4.57": "JPEG Lossless",
    "1.2.840.10008.1.2.4.70": "JPEG Lossless SV1",
    "1.2.840.10008.1.2.4.80": "JPEG-LS Lossless",
    "1.2.840.10008.1.2.4.81": "JPEG-LS Near-Lossless",
    "1.2.840.10008.1.2.4.90": "JPEG 2000 Lossless",
    "1.2.840.10008.1.2.4.91": "JPEG 2000",
    "1.2.840.10008.1.2.4.201": "HTJ2K Lossless",
    "1.2.840.10008.1.2.4.202": "HTJ2K Lossless RPCL",
    "1.2.840.10008.1.2.4.203": "HTJ2K",
    "1.2.840.10008.1.2.5": "RLE Lossless",
}


def ts_name(uid: str) -> str:
    uid = str(uid or "")
    if uid in _TS_NAMES:
        return _TS_NAMES[uid]
    return _uid_name(uid)


def sop_name(uid: str) -> str:
    return _uid_name(str(uid or ""))


def _uid_name(uid: str) -> str:
    try:
        from pydicom.uid import UID
        return str(UID(uid).name) or uid
    except Exception:
        return uid


# ---- the journal -----------------------------------------------------------
def _key(e: dict) -> tuple:
    """What makes two associations the same situation.

    A study is one association per instance (scu.c_store), so a 500-image CT to
    a node that refuses it is 500 identical failures. Folded into one entry with
    a count, the journal keeps 200 distinct problems instead of the last 200
    images of one of them."""
    ctx = tuple((c["sop"], tuple(c["proposed"]), c["accepted"], c["result"])
                for c in e["contexts"])
    return (e["direction"], e["service"], e["dest"], e["peer"], e["port"], e["calling"],
            e["called"], e["tls"], e["outcome"], tuple(e["reject"] or ()), ctx)


class ConnectionJournal:
    def __init__(self, capacity: int = CAPACITY):
        self._lock = threading.Lock()
        self._items: "OrderedDict[tuple, dict]" = OrderedDict()
        self._seq = 0
        self.capacity = capacity

    def record(self, *, direction: str, service: str, calling: str, called: str,
               peer: str, port: int, outcome: str, dest: str = "", tls: bool = False,
               reject=None, contexts=(), detail: str = "", when: Optional[float] = None) -> dict:
        now = time.time() if when is None else when
        entry = {
            "direction": direction, "service": service, "dest": dest or "",
            "calling": str(calling or "").strip(), "called": str(called or "").strip(),
            "peer": str(peer or ""), "port": int(port or 0), "tls": bool(tls),
            "outcome": outcome, "reject": list(reject) if reject else None,
            "contexts": [dict(c) for c in contexts], "detail": detail or "",
        }
        key = _key(entry)
        with self._lock:
            self._seq += 1
            old = self._items.pop(key, None)
            if old is not None:
                old.update(last=now, count=old["count"] + 1, seq=self._seq, detail=entry["detail"])
                entry = old
            else:
                entry.update(first=now, last=now, count=1, seq=self._seq)
            self._items[key] = entry
            while len(self._items) > self.capacity:
                self._items.popitem(last=False)
            return dict(entry)

    def entries(self, peer: str = "", limit: int = 0) -> list[dict]:
        """Newest first. *peer* matches an AE title, an address or a destination
        name, case-insensitively, so one box for "show me the US room" works
        whether the operator knows its title or its IP."""
        needle = str(peer or "").strip().lower()
        with self._lock:
            rows = [dict(e) for e in reversed(self._items.values())]
        if needle:
            rows = [e for e in rows if any(needle in str(e.get(f, "")).lower()
                                           for f in ("calling", "called", "peer", "dest"))]
        return rows[:limit] if limit and limit > 0 else rows

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


# The sending side has one journal per process, installed by PacsServer. It is
# a module global rather than a parameter because c_store's signature is shared
# by every caller and by the recording stubs the test suites put in its place;
# a new argument there would be one more thing each of them must thread through.
_sender: Optional[ConnectionJournal] = None


def install_sender_journal(journal: Optional[ConnectionJournal]) -> None:
    global _sender
    _sender = journal


def sender_journal() -> Optional[ConnectionJournal]:
    return _sender


def note_outgoing(*, service: str, dest, calling: str, outcome: str, reject=None,
                  contexts=(), detail: str = "") -> None:
    """One outgoing association, into the installed journal if there is one."""
    j = _sender
    if j is None or not service:
        return
    try:
        j.record(direction="out", service=service, dest=getattr(dest, "name", ""),
                 calling=calling, called=getattr(dest, "aet", ""), peer=getattr(dest, "host", ""),
                 port=getattr(dest, "port", 0), tls=bool(getattr(dest, "tls", False)),
                 outcome=outcome, reject=reject, contexts=contexts, detail=detail)
    except Exception:
        pass                        # a send must never fail on its own bookkeeping


def requested_contexts(assoc) -> list[dict]:
    """Per proposed context: SOP class, transfer syntaxes offered, the one
    accepted, and the PS3.8 result. Ours as requestor."""
    try:
        proposed = list(assoc.requestor.requested_contexts)
    except Exception:
        return []
    return _merge(proposed, assoc)


def offered_contexts(assoc) -> list[dict]:
    """The same, for an association a remote proposed to one of our listeners:
    the offer is read from its A-ASSOCIATE-RQ."""
    try:
        proposed = list(assoc.requestor.primitive.presentation_context_definition_list)
    except Exception:
        return []
    return _merge(proposed, assoc)


def _merge(proposed, assoc) -> list[dict]:
    answers = {}
    try:
        for cx in assoc.accepted_contexts:
            answers[cx.context_id] = (ACCEPTED, str(cx.transfer_syntax[0]) if cx.transfer_syntax else "")
        for cx in assoc.rejected_contexts:
            answers[cx.context_id] = (int(cx.result) if cx.result is not None else NO_REASON, "")
    except Exception:
        pass
    out = []
    for cx in proposed:
        result, ts = answers.get(cx.context_id, (None, ""))
        out.append({"sop": str(cx.abstract_syntax or ""),
                    "proposed": [str(t) for t in (cx.transfer_syntax or [])],
                    "accepted": ts, "result": result})
    return out


# ---- our listeners ----------------------------------------------------------
def listener_handlers(journal: Optional[ConnectionJournal], service: str, aet: str,
                      port: int, tls: bool = False) -> list:
    """pynetdicom event handlers that journal one listener's associations.
    Empty without a journal, so a listener built outside PacsServer (the dev
    peer, the test suites) behaves exactly as before."""
    if journal is None:
        return []
    from pynetdicom import evt

    def base(event):
        a = event.assoc
        try:
            calling = str(a.requestor.ae_title or "")
            called = str(a.requestor.primitive.called_ae_title or "")
        except Exception:
            calling, called = "", ""
        try:
            peer = str(a.requestor.address or "")
        except Exception:
            peer = ""
        return dict(direction="in", service=service, calling=calling, called=called or aet,
                    peer=peer, port=port, tls=tls)

    def accepted(event):
        try:
            ctx = offered_contexts(event.assoc)
            ok = any(c["result"] == ACCEPTED for c in ctx)
            journal.record(outcome="accepted" if ok else "none_accepted", contexts=ctx,
                           **base(event))
        except Exception:
            pass                    # bookkeeping must never cost an association

    def rejected(event):
        try:
            prim = getattr(event.assoc.acceptor, "primitive", None)
            journal.record(outcome="rejected", reject=reject_parts(prim), **base(event))
        except Exception:
            pass

    def aborted(event):
        # Only an abort after something was agreed is news: with nothing
        # accepted the requestor has nothing to send and aborts at once
        # (pynetdicom does), and the accepted entry already says why.
        try:
            if event.assoc.accepted_contexts:
                journal.record(outcome="aborted", **base(event))
        except Exception:
            pass

    return [(evt.EVT_ACCEPTED, accepted), (evt.EVT_REJECTED, rejected),
            (evt.EVT_ABORTED, aborted)]


# ---- the diagnoser ----------------------------------------------------------
# One sentence (what happened) and one fix (what to change, and where) per
# situation, with {named} blanks. The dashboard holds the same table in
# js/06-logs.js so it can say them in the operator's language;
# tests/test_connections.py fails if the two drift.
_TEXT = {
    "in_ok": ("{calling} at {peer} connected and was accepted.", ""),
    "in_ae_swapped": (
        "{peer} called in as {calling}, which is this PACS's own AE title, and asked for {called}.",
        "The two AE titles are swapped on that device: its own AE title goes in the local (calling) "
        "field, and {calling} goes in the remote (called) field."),
    "in_not_allowed": (
        "{calling} at {peer} was turned away: its AE title is not in the allowed list.",
        "If {calling} should be able to connect, add it under Configuration → Settings → {group} → "
        "Accept only these AEs."),
    "in_busy": (
        "{calling} at {peer} was turned away for now: too many connections at once.",
        "Nothing to change if it is rare — the sender retries. If it keeps happening, the sender "
        "may be leaving connections open."),
    "in_rejected": ("{calling} at {peer} was turned away: {reason}.", ""),
    "in_wrong_port": (
        "{calling} tried to send images to port {port}, which is not where this PACS receives "
        "images.",
        "On {calling}, set the storage destination to port {rx_port} with AE title {rx_aet}."),
    "in_wrong_port_off": (
        "{calling} tried to send images to port {port}, which is not where this PACS receives "
        "images.",
        "Turn the receiver on under Services, then point {calling} at its port."),
    "in_other_port": (
        "{calling} asked port {port} for {sops}, which this PACS offers on another port.",
        "On {calling}, set that service's port to {right_port} with AE title {right_aet}."),
    "in_other_port_off": (
        "{calling} asked port {port} for {sops}, which this PACS offers on another port.",
        "That service is not running here. Turn it on under Services, then point {calling} at "
        "its port."),
    "in_sop_refused": (
        "{calling} offered {sops}, which this service does not accept.",
        "This PACS has no setting to accept it. Ask the vendor whether {calling} can send it as a "
        "standard object (for example Secondary Capture), or send it to a system that takes it."),
    "in_ts_refused": (
        "{calling} offered {sop} only as {tss}, which this PACS does not accept.",
        "This PACS has no setting to add a transfer syntax. On {calling}, choose an uncompressed "
        "(Explicit VR Little Endian) or JPEG Lossless export for it."),
    "in_called_mismatch": (
        "{calling} calls this PACS {called}, but its AE title is {aet}. It works only because "
        "this PACS does not check the called AE title.",
        "On {calling}, set the remote AE title to {aet}."),
    "in_aborted": (
        "{calling} at {peer} dropped the connection part-way through.",
        "Usually a network drop or a transfer cancelled on {calling}; check its queue for that "
        "study."),
    "out_ok": ("{dest} ({called} at {host}:{port}) accepted the connection.", ""),
    "out_refused": (
        "Nothing is listening at {host}:{port}.",
        "Check that {dest} is running and that its port is right under Configuration → "
        "Destinations (a PACS usually receives on 104 or 11112)."),
    "out_unreachable": (
        "{host}:{port} did not answer: the machine is off, unreachable, or a firewall is dropping "
        "the connection.",
        "Check the address of {dest}, and that any firewall between the two allows port {port}."),
    "out_tls_failed": (
        "The TLS handshake with {dest} at {host}:{port} failed.",
        "Check the certificates under Configuration → Settings → Sending, and that {dest} expects "
        "TLS on port {port}. If it does not, untick TLS on its row under Destinations."),
    "out_maybe_tls": (
        "{dest} at {host}:{port} took the connection and dropped it without answering.",
        "That is what a TLS-only port does with a plain connection. If {dest} uses DICOM-TLS, "
        "tick TLS on its row under Configuration → Destinations."),
    "out_dropped": (
        "{dest} at {host}:{port} took the connection and dropped it without answering.",
        "Check the log on {dest}: it may not trust this PC's certificate."),
    "out_no_answer": (
        "{dest} at {host}:{port} took the connection but never answered the association request.",
        "{dest} may be overloaded or hung. Check that it is working, then try again."),
    "out_ae_swapped": (
        "{dest} refused the connection, and the AE titles look swapped: the destination is set to "
        "{called}, which is an AE title of this PACS.",
        "Under Configuration → Destinations, set {dest}'s AE title to the remote's own AE title. "
        "This PACS calls as {calling}; that is the title {dest} must accept."),
    "out_calling_refused": (
        "{dest} does not accept calls from {calling}, the AE title this PACS sends as.",
        "On {dest}, add {calling} (at this PC's address) to the AE titles it accepts."),
    "out_called_unknown": (
        "{dest} does not answer to the AE title {called}.",
        "Check {dest}'s AE title under Configuration → Destinations: it must match what {dest} "
        "calls itself, exactly, including case."),
    "out_busy": (
        "{dest} turned the connection away for now: it is busy.",
        "Nothing to change here — sends are retried. If it keeps happening, ask whoever runs "
        "{dest} to allow more connections."),
    "out_rejected": ("{dest} refused the connection: {reason}.", ""),
    "out_not_storage": (
        "{dest} answers C-ECHO but accepts none of the image types offered — it is probably a "
        "worklist or query port.",
        "Check the port under Configuration → Destinations; a PACS usually receives images on 104 "
        "or 11112."),
    "out_sop_refused": (
        "{dest} does not accept {sops}.",
        "Check that {host}:{port} is the right service on {dest}. If it is, ask whoever runs it to "
        "enable this, or stop routing these images to {dest} (Configuration → Routing)."),
    "out_ts_only_uncompressed": (
        "{dest} accepts {sop} only uncompressed; images stored here as {tss} are refused.",
        "This PACS sends each image exactly as it was received and cannot convert it, so these "
        "cannot be sent as they are. Enable {tss} on {dest}, or have the modality send "
        "uncompressed images."),
    "out_ts_refused": (
        "{dest} accepts {sop}, but not as {tss}.",
        "This PACS sends each image exactly as it was received and cannot convert it, so it "
        "cannot be sent as it is. Enable {tss} on {dest}, or have the modality send it in a "
        "transfer syntax {dest} accepts."),
    "out_ctx_refused": ("{dest} refused {sops} ({reason}).", ""),
}

# How loud each one is on the dashboard.
_LEVEL = {"in_ok": "ok", "out_ok": "ok", "in_called_mismatch": "info",
          "in_busy": "warn", "out_busy": "warn"}

# The Settings group each listener's allow-list lives in, by its dashboard title.
_GROUP = {"receiver": "This PACS", "printer": "Printing", "worklist": "Worklist and orders",
          "qr": "Query and web access"}

_CTX_REASON = {USER_REJECTION: "refused by the remote", NO_REASON: "no reason given",
               SOP_NOT_SUPPORTED: "abstract syntax not supported",
               TS_NOT_SUPPORTED: "transfer syntaxes not supported"}


def _finding(code: str, vars_: dict, level: str = "") -> dict:
    say, fix = _TEXT[code]
    v = {k: str(val) for k, val in vars_.items()}
    return {"code": code, "level": level or _LEVEL.get(code, "error"), "vars": v,
            "say": say.format(**v), "fix": fix.format(**v)}


def _names(uids, namer) -> str:
    return ", ".join(dict.fromkeys(namer(u) for u in uids))


def _refused_sops(contexts) -> dict:
    """SOP class -> results of its contexts, for every SOP class that no
    context got accepted for. One refusal beside an acceptance for the same
    class is ordinary negotiation (the requestor offered a choice), not a fault."""
    by_sop: dict = {}
    for c in contexts:
        if c["result"] is None:
            continue
        by_sop.setdefault(c["sop"], []).append(c)
    return {sop: cs for sop, cs in by_sop.items()
            if not any(c["result"] == ACCEPTED for c in cs)}


def diagnose(entry: dict, here: Optional[dict] = None) -> list[dict]:
    """Findings for one journal entry, worst first. *here* is what this PACS
    is (PacsServer._here): its listeners' AE titles by service and as a list,
    the AE it sends as, and where the receiver listens."""
    here = here or {}
    own = {str(a).strip() for a in here.get("own_aets", []) if str(a).strip()}
    if entry["direction"] == "in":
        return _diagnose_in(entry, here, own)
    # Our sending AE counts as ours on the way out only: the listeners' own
    # self-test calls in as it, and that is not a swap.
    scu = str(here.get("scu_aet") or "").strip()
    return _diagnose_out(entry, own | ({scu} if scu else set()))


def _diagnose_in(e: dict, here: dict, own: set) -> list[dict]:
    listener_aet = here.get("aets", {}).get(e["service"], "")
    v = {"calling": e["calling"] or "?", "called": e["called"], "peer": e["peer"] or "?",
         "port": e["port"], "aet": listener_aet or e["called"]}
    out = []
    # Checked before the refusal it usually causes: "not in the allowed list"
    # is true and points at the wrong machine.
    if e["calling"] and e["calling"] in own and e["called"] != e["calling"]:
        out.append(_finding("in_ae_swapped", v))
    if e["outcome"] == "rejected":
        _result, source, diag = e["reject"] or (0, 0, 0)
        if (source, diag) == (1, 3):
            if not out:
                out.append(_finding("in_not_allowed", {**v, "group": _GROUP.get(e["service"], "This PACS")}))
        elif source == 3:
            out.append(_finding("in_busy", v))
        elif not out:
            out.append(_finding("in_rejected", {**v, "reason": _reason_of(e["reject"])}))
        return out
    if e["outcome"] == "aborted":
        return out + [_finding("in_aborted", v)]
    refused = _refused_sops(e["contexts"])
    # Nothing accepted, and what was asked for is what another of our
    # listeners does: the device has the right machine and the wrong port.
    wanted = {_service_for(s) for s in refused} - {None}
    if e["outcome"] == "none_accepted" and len(wanted) == 1 and e["service"] not in wanted:
        (svc,) = wanted
        running = here.get("running", {}).get(svc, False)
        right = {"right_port": here.get("ports", {}).get(svc, ""),
                 "right_aet": here.get("aets", {}).get(svc, "")}
        if svc == "receiver":
            out.append(_finding("in_wrong_port" if running else "in_wrong_port_off",
                                {**v, "rx_port": right["right_port"], "rx_aet": right["right_aet"]}))
        else:
            out.append(_finding("in_other_port" if running else "in_other_port_off",
                                {**v, **right, "sops": _names(refused, sop_name)}))
        return out
    level = "" if e["outcome"] == "none_accepted" else "warn"
    no_sop = [s for s, cs in refused.items() if any(c["result"] == SOP_NOT_SUPPORTED for c in cs)]
    if no_sop:
        out.append(_finding("in_sop_refused", {**v, "sops": _names(no_sop, sop_name)}, level))
    for sop, cs in refused.items():
        if sop not in no_sop and all(c["result"] == TS_NOT_SUPPORTED for c in cs):
            tss = [t for c in cs for t in c["proposed"]]
            out.append(_finding("in_ts_refused", {**v, "sop": sop_name(sop),
                                                  "tss": _names(tss, ts_name)}, level))
    if not out and listener_aet and e["called"] and e["called"] != listener_aet:
        out.append(_finding("in_called_mismatch", v))
    return out or [_finding("in_ok", v)]


def _service_for(sop: str):
    """Which of our listeners serves this SOP class, if any."""
    if sop == VERIFICATION:
        return None
    name = sop_name(sop)
    if name.endswith("Storage"):
        return "receiver"
    if "Worklist" in name:
        return "worklist"
    if "Query/Retrieve" in name:
        return "qr"
    if "Print" in name or "Film" in name:
        return "printer"
    return None


def _reason_of(reject) -> str:
    class _P:
        pass
    p = _P()
    p.result, p.result_source, p.diagnostic = (list(reject or ()) + [0, 0, 0])[:3]
    return reject_reason(p)


def _diagnose_out(e: dict, own: set) -> list[dict]:
    v = {"dest": e["dest"] or e["called"] or e["peer"], "host": e["peer"], "port": e["port"],
         "calling": e["calling"], "called": e["called"]}
    oc = e["outcome"]
    simple = {"refused": "out_refused", "unreachable": "out_unreachable", "tls": "out_tls_failed",
              "no_answer": "out_no_answer"}
    if oc in simple:
        return [_finding(simple[oc], v)]
    if oc == "aborted":
        return [_finding("out_dropped" if e["tls"] else "out_maybe_tls", v)]
    if oc == "error":
        return [_finding("out_rejected", {**v, "reason": e.get("detail") or "connection error"})]
    if oc == "rejected":
        _result, source, diag = e["reject"] or (0, 0, 0)
        swapped = e["called"] in own or (e["calling"] and e["calling"] == e["called"])
        if (source, diag) in ((1, 3), (1, 7)) and swapped:
            return [_finding("out_ae_swapped", v)]
        if (source, diag) == (1, 3):
            return [_finding("out_calling_refused", v)]
        if (source, diag) == (1, 7):
            return [_finding("out_called_unknown", v)]
        if source == 3:
            return [_finding("out_busy", v)]
        return [_finding("out_rejected", {**v, "reason": _reason_of(e["reject"])})]
    return _context_findings(e, v) or [_finding("out_ok", v)]


def _context_findings(e: dict, v: dict) -> list[dict]:
    ctx = e["contexts"]
    if e["service"] == "echo":
        # The destination Test offers six common image classes beside C-ECHO.
        # A node that takes none of them is not a store, whatever else it is;
        # one that takes some is a store that specialises, which is fine.
        offered = [c for c in ctx if c["sop"] != VERIFICATION and c["result"] is not None]
        if offered and not any(c["result"] == ACCEPTED for c in offered):
            return [_finding("out_not_storage", v)]
        return []
    refused = _refused_sops(ctx)
    check = e["service"] == "check"
    out = []
    by_reason: dict = {}
    for sop, cs in refused.items():
        reasons = {c["result"] for c in cs}
        if reasons == {TS_NOT_SUPPORTED}:
            out.append(_ts_finding(v, sop, cs, []))
        else:
            r = SOP_NOT_SUPPORTED if SOP_NOT_SUPPORTED in reasons else min(reasons)
            by_reason.setdefault(r, []).append(sop)
    if check:
        # The check offers each stored syntax in a context of its own, so a
        # class can be accepted in one syntax and refused in another — and the
        # sender proposes only the file's own (scu.c_store), so every refused
        # pair is a set of images that will fail.
        for sop in dict.fromkeys(c["sop"] for c in ctx):
            if sop in refused:
                continue
            cs = [c for c in ctx if c["sop"] == sop]
            bad = [c for c in cs if c["result"] == TS_NOT_SUPPORTED and not c.get("reference")]
            if bad:
                good = [c for c in cs if c["result"] == ACCEPTED]
                out.append(_ts_finding(v, sop, bad, good))
    for r, sops in by_reason.items():
        code = "out_sop_refused" if r == SOP_NOT_SUPPORTED else "out_ctx_refused"
        out.append(_finding(code, {**v, "sops": _names(sops, sop_name),
                                   "reason": _CTX_REASON.get(r, f"result {r}")}))
    return out


def _ts_finding(v: dict, sop: str, bad: list, good: list) -> dict:
    tss = _names([t for c in bad for t in c["proposed"] if not c.get("reference")]
                 or [t for c in bad for t in c["proposed"]], ts_name)
    only_plain = good and all(c["accepted"] in UNCOMPRESSED for c in good)
    code = "out_ts_only_uncompressed" if only_plain else "out_ts_refused"
    return _finding(code, {**v, "sop": sop_name(sop), "tss": tss})


def describe(entry: dict, here: Optional[dict] = None) -> dict:
    """An entry as the dashboard shows it: names beside the UIDs, and the
    findings. The UIDs stay, because they are what a vendor's support line
    will ask for."""
    out = dict(entry)
    out["contexts"] = [{**c, "sop_name": sop_name(c["sop"]),
                        "proposed_names": [ts_name(t) for t in c["proposed"]],
                        "accepted_name": ts_name(c["accepted"]) if c["accepted"] else ""}
                       for c in entry["contexts"]]
    out["findings"] = diagnose(entry, here)
    return out
