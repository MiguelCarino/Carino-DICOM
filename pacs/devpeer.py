"""The disposable second archive — a whole PACS, inside this process, on demand.

Testing store-and-forward, routing, de-identification-on-forward, C-MOVE and the
cross-origin editor hand-off all need somewhere for a study to GO. Until now that
meant an operator hand-writing a second config.json, picking two ports nothing
else uses, remembering to delete the folder afterwards, and — the part that
actually goes wrong — leaving a destination on the real appliance aimed at an
archive that stopped existing weeks ago. This module is that second archive,
created by one click and deleted with the same certainty it was created.

Three decisions carry the whole design, and each one is a refusal:

  * IT IS A LAUNCH FLAG, NEVER A CONFIG KEY. `pacs serve --dev-peer` is the only
    way in. A config key would be editable through POST /api/config, so an admin
    token on a deployed appliance would be enough to switch on "spawn a second
    archive that stores patient images somewhere new" — and the dashboard is
    exactly where an attacker who has the token already is. A launch argument
    cannot be reached over HTTP at all. The shipped builds never pass it:
    Dockerfile's CMD is ["serve"], and desktop/main.js builds a fixed argument
    list with no route for an extra one. (docker/entrypoint.py does forward
    container CMD arguments, so a container operator CAN pass it deliberately —
    which is the correct property: a deliberate local decision, not a remote one.)

  * IT IS LOOPBACK, UNCONDITIONALLY. Not a setting, not an override. A test
    archive a modality on the LAN can find is a second, unaudited store for
    somebody's images, and nobody would notice it was there.

  * IT IS IN-PROCESS. Engine and listeners are plain objects over a Config
    (ae.start_server(block=False) throughout), so the peer is a second
    PacsServer inside the dashboard's own process. No subprocess to supervise,
    nothing to package, and it dies with its parent by construction.

Deletion is the highest-risk part of the feature — it ends in shutil.rmtree —
so it happens on exactly three occasions and no others:

    (a) an explicit "Stop and discard" from the dashboard,
    (b) the parent process shutting down (PacsServer.shutdown, plus an atexit
        net for the exits that bypass it),
    (c) a startup sweep of stale carino-peer-* trees, which is the only answer
        to SIGKILL and power loss. It runs on EVERY `pacs serve`, not only the
        ones carrying the flag: the restart after a crash is normally the plain
        one — the developer has finished testing, and the container and desktop
        launchers never pass the flag at all — and gating the cleanup on it left
        the appliance with a live destination aimed at a released loopback port,
        which is the one outcome this feature promises never to leave behind.
        It removes nothing belonging to a peer whose owner process is alive.

NEVER on a browser tab closing — there is no reliable unload event, and a page
that was merely refreshed would take the archive with it. NEVER on a timer — a
timer that deletes a directory tree is a worse thing to own than a test config
that outlives its session. And every delete goes through remove_peer_dir(),
which refuses anything that is not a directory one level under the temporary
folder wearing our prefix.
"""

from __future__ import annotations

import atexit
import copy
import json
import os
import secrets
import shutil
import socket
import tempfile
import threading
import time
from datetime import datetime, timezone
from typing import Optional

from .config import Config
from .dicomfs import safe_within

# Every peer directory is named with this, and the guard below refuses to delete
# a directory that is not. One constant, so the thing that creates and the thing
# that deletes cannot drift apart.
PEER_PREFIX = "carino-peer-"
# 10 characters + 4 hex = 14, inside the 16-character DICOM limit that config
# validation enforces on every AE title. Anything longer would be refused by the
# peer's OWN config, and the failure would arrive as a validation error during
# create() rather than as anything an operator could read.
AE_PREFIX = "CARINOPEER"
VOID_AET = "CARINOVOID"
# Written inside each peer directory, holding the pid that made it, so the
# startup sweep can tell a tree left behind by a killed run from one a second
# live dashboard on this machine is using right now.
OWNER_FILE = ".peer-owner"


def _new_aet() -> str:
    """A fresh AE title for one peer.

    The random suffix is not decoration. allowed_aets, routing rules and
    qr.move_destinations are all keyed by AE title, so a peer that reused the
    primary's — or a name the site already has configured for a real node —
    would be resolved as that node by the first C-MOVE anyone tried.
    """
    return AE_PREFIX + secrets.token_hex(2).upper()


def _reserve_port(bind: str = "127.0.0.1") -> tuple[socket.socket, int]:
    """Bind :0 and hand back the still-open socket and the real port.

    Never a fixed offset from the primary's ports: +100 is occupied on somebody's
    machine, and the failure surfaces as a listener that did not come up rather
    than as a number that was already taken.

    The socket is deliberately returned OPEN and closed immediately before the
    listener that wants that port binds it. That is the narrowest window
    achievable in-process, and it is what stops the second reservation in one
    create() from being handed the first one's number. No SO_REUSEADDR: the
    point is to hold the number, not to share it. netclaim.claim() cannot help
    here — SO_EXCLUSIVEADDRUSE is Windows-only and claim() is a no-op on POSIX —
    so the real protection against losing the race is the EADDRINUSE that comes
    out of ae.start_server, which create() turns into a full discard.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((bind, 0))
        return sock, int(sock.getsockname()[1])
    except BaseException:
        sock.close()
        raise


def remove_peer_dir(path: str, root: Optional[str] = None) -> None:
    """Delete one peer directory, or refuse and say why.

    Every rule here is a rule about a shutil.rmtree, so each is written out
    rather than folded into one clever expression:

      * realpath BOTH sides before comparing. tempfile.gettempdir() is
        /var/folders/... on macOS and /tmp on most CI images, and both are
        symlinks into /private — a raw string comparison refuses every
        legitimate delete on a Mac and passes on Linux, which is the worst
        possible split, because Linux is the half that runs the tests.
      * refuse a symlink outright, BEFORE resolving it. A link wearing our
        prefix is the one thing anybody could plant in a world-writable temp
        directory, and following it is how this deletes somebody's home folder.
      * refuse the temp root itself. "", "." and "carino-peer-x/.." all resolve
        to it, and it is the case that is easiest to leave out.
      * require the parent to BE the root, not merely to contain it. One level
        down is where mkdtemp puts us; anything deeper is somebody else's tree
        that happens to sit under the same root.

    *root* exists for the sweep and for the tests, which must never point a
    directory-tree delete at the developer's real /tmp. It is always a path this
    process generated or a test chose — it is never taken from a request body,
    and nothing reachable over HTTP passes it.
    """
    if not path or not isinstance(path, str):
        raise ValueError("refusing to delete outside the temporary folder: no path given")
    # On the RAW path, before anything resolves it.
    if os.path.islink(path):
        raise ValueError(
            f"refusing to delete outside the temporary folder: {path} is a symlink")
    real_root = os.path.realpath(root or tempfile.gettempdir())
    real = os.path.realpath(path)
    if real == real_root:
        raise ValueError(
            f"refusing to delete outside the temporary folder: {path} IS the temporary folder")
    if os.path.dirname(real) != real_root:
        raise ValueError(
            f"refusing to delete outside the temporary folder: {path} is not directly "
            f"inside {real_root}")
    if not os.path.basename(real).startswith(PEER_PREFIX):
        raise ValueError(
            f"refusing to delete outside the temporary folder: {path} is not a "
            f"{PEER_PREFIX}* directory")
    if not os.path.isdir(real) or os.path.islink(real):
        raise ValueError(
            f"refusing to delete outside the temporary folder: {path} is not a directory")
    # No ignore_errors: a tree that would not go away is news, and the callers
    # all log it rather than pretend the archive is gone.
    shutil.rmtree(real)


def _owner_pid(peer_dir: str) -> int:
    """The pid recorded in *peer_dir*, or 0 when there is nothing readable."""
    try:
        with open(os.path.join(peer_dir, OWNER_FILE), "r", encoding="utf-8") as fh:
            return int(fh.read().strip() or 0)
    except (OSError, ValueError):
        return 0


def _pid_alive(pid: int) -> bool:
    """Is that process still there? POSIX only, and deliberately.

    On Windows os.kill(pid, 0) does not ask a question — CPython maps it onto
    OpenProcess + TerminateProcess, so the "check" would KILL the process it is
    asking about. So it is never called there, and the cost is that a second
    --dev-peer dashboard on one Windows development box would sweep the first
    one's directory at startup. That is temp test data on a developer's machine;
    killing a live process to find out whether it is alive is not a trade worth
    making to protect it.
    """
    if pid <= 0 or os.name != "posix":
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True             # somebody else's process, but a process
    except OSError:
        return False
    return True


def _peer_aet(peer_dir: str) -> str:
    """The AE title recorded in that peer's own config, or "" when unreadable.

    The sweep needs it to answer the only question that separates litter from a
    working archive: WHICH of the primary's ephemeral rows belong to a peer that
    is still running. The DevPeer object that minted them lives in the other
    process, so its config.json is the only place this one can read the title
    back from.
    """
    try:
        with open(os.path.join(peer_dir, "config.json"), "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        return str((doc.get("scp") or {}).get("aet", "") or "")
    except (OSError, ValueError, AttributeError):
        return ""


def _names_a_live_peer(row: dict, live_aets: set) -> bool:
    """Does this destination row point at one of the peers that is still up?

    Both rows _wire_primary writes carry the peer's AE title — the peer row IS
    that AE, and the black hole is named after it — so one title identifies the
    pair. Matched loosely (either field, case-insensitively) on purpose: this
    decides whether to KEEP a row, and the cost of a false match is a stale row
    that the next sweep removes, while the cost of a miss is a running peer's
    wiring deleted underneath it.
    """
    aet = str(row.get("aet", "") or "").strip().upper()
    name = str(row.get("name", "") or "").upper()
    return any(live and (aet == live.upper() or live.upper() in name) for live in live_aets)


def sweep_stale(tmp_root: Optional[str] = None, log=None, cfg=None) -> list[str]:
    """Remove peer trees, and peer destination rows, left behind by a killed run.

    SIGKILL and a power cut run no atexit handler and no finally block, so
    nothing in-process can cover them. This is the answer to that case, and it
    is why it exists at all: without it the one failure mode nobody can prevent
    is also the one nobody ever cleans up after.

    Not age-gated, unlike Config._sweep_temps. This runs at startup, before this
    process has minted a peer of its own, so there is no in-flight tree to
    protect — and a peer directory's mtime does not move while it is in use, so
    an age gate would protect nothing and leak everything older than the cutoff.
    A tree whose recorded owner is still running is left alone instead: that is
    a second live dashboard, not litter — and so are ITS rows on the primary,
    which is the one thing this function must get right. It is called on every
    `pacs serve`, with or without the flag, and it is called AFTER the port
    claim: it rewrites config.json, so it must never run on a launch that is
    about to be refused because the real appliance is already up.
    """
    root = tmp_root or tempfile.gettempdir()
    removed: list[str] = []
    # The peers this sweep decided NOT to touch, by AE title. The directory half
    # below is liveness-gated; the config half has to be gated by the SAME
    # decision or it deletes the wiring of the archive the directory half just
    # protected — a second dashboard whose peer is up, receiving, and suddenly
    # unreachable from the primary that created it.
    live_aets: set = set()
    # A live peer whose config we could not read is a title we cannot exclude.
    # The config half is skipped entirely in that case: leaving a stale row for
    # one more restart is recoverable, and cutting a live peer loose is not.
    live_unreadable = False
    try:
        names = os.listdir(root)
    except OSError:
        # An unreadable temp folder is not a startup failure, and it must not
        # skip the config half below: the rows on the PRIMARY are the part an
        # operator can still be hurt by, and they are cleaned from a file this
        # process definitely can read. It does mean no peer can be found alive,
        # so a second dashboard's rows would go — on a machine whose temp folder
        # this process cannot list, which is already broken in a bigger way.
        names = []
    for name in names:
        if not name.startswith(PEER_PREFIX):
            continue
        path = os.path.join(root, name)
        # Nothing here follows a link, and a plain file wearing the prefix is
        # not a peer: both are left exactly where they are.
        if os.path.islink(path) or not os.path.isdir(path):
            continue
        pid = _owner_pid(path)
        if _pid_alive(pid):
            aet = _peer_aet(path)
            if aet:
                live_aets.add(aet)
            else:
                live_unreadable = True
            if log:
                log.info(f"Leaving dev peer folder {path} alone — process {pid} is still "
                         f"running and is using it.", kind="devpeer")
            continue
        try:
            remove_peer_dir(path, root=root)
            removed.append(path)
        except (ValueError, OSError) as exc:
            if log:
                log.warn(f"Could not remove the stale dev peer folder {path}: {exc}",
                         kind="devpeer")
    if removed and log:
        log.info(f"Removed {len(removed)} stale dev peer folder(s) left by an earlier run.",
                 kind="devpeer")
    if cfg is not None and live_unreadable:
        if log:
            log.warn("Leaving the dev peer destinations alone: a peer folder whose owner is "
                     "still running does not say which AE title it holds, and a row that "
                     "belongs to it must not be removed while it is up.", kind="devpeer")
    elif cfg is not None:
        # A killed run also leaves its rows on the PRIMARY, pointed at an
        # archive that no longer exists — the exact thing this feature refuses
        # to leave behind. Same critical section as _wire_primary, for the same
        # reason: a POST /api/config landing in the gap would put them back.
        #
        # The `ephemeral` flag alone decides, EXCEPT for the peers found running
        # above: that is the documented meaning of the flag (see the validate()
        # comment in config.py — "a row `pacs serve --dev-peer` wrote and will
        # remove again"), and narrowing it to rows that still LOOK like ours
        # would leave a renamed row aimed at a dead archive, which is the one
        # outcome this feature exists to prevent.
        try:
            with cfg.mutate():
                rows = [r for r in cfg.destinations
                        if not r.get("ephemeral") or _names_a_live_peer(r, live_aets)]
                if len(rows) != len(cfg.destinations):
                    dropped = len(cfg.destinations) - len(rows)
                    cfg.data["destinations"] = rows
                    cfg.save()
                    if log:
                        log.info(f"Dropped {dropped} destination(s) left pointing at a dev peer "
                                 f"that no longer exists.", kind="devpeer")
        except (OSError, ValueError) as exc:
            if log:
                log.warn(f"Could not clear the leftover dev peer destinations: {exc}",
                         kind="devpeer")
    return removed


class DevPeer:
    """One disposable archive, and the primary-side wiring that reaches it.

    Constructed by PacsServer when --dev-peer was given, the same way
    EmergencyController is: it holds the primary server and its log and
    ALLOCATES NOTHING. No temp directory, no thread, no disk walk — constructing
    a PacsServer stays free of all three, and a flag that is never used must
    cost nothing at all.
    """

    def __init__(self, server, log):
        self.server = server
        self.log = log
        # Re-entrant: discard() is called from shutdown() and from atexit, and
        # create()'s failure path calls the same teardown its success path uses.
        self._lock = threading.RLock()
        self.dir = ""               # the mkdtemp path; "" when nothing is running
        self.aet = ""
        self.scp_port = 0
        self.qr_port = 0
        self.void_port = 0
        self.peer = None            # the second PacsServer
        self.created_at = 0.0
        self.dest_names: list[str] = []     # the rows we wrote on the PRIMARY
        self._atexit = False

    # ---- what the dashboard sees ------------------------------------------
    def status(self) -> dict:
        """The dev_peer block, cheap enough for the 2-second status poll.

        COUNTS, NEVER AN IDENTITY. No patient name, no accession, no study
        description: the peer is where you check that a forward ARRIVED, and the
        primary's Studies panel — which has the per-field identifier policy on
        it — is where a study is looked at. Keeping this block free of
        identifiers is what keeps it out of that policy entirely.

        One stable shape whether or not a peer is running, so the panel never
        has to render two layouts.
        """
        peer = self.peer
        received = errors = studies = instances = 0
        if peer is not None:
            scp = peer.scp
            if scp is not None:
                # Attribute reads, not a method call: this is on the poll path.
                received = int(getattr(scp, "received_count", 0))
                errors = int(getattr(scp, "error_count", 0))
            try:
                idx = peer.index_status()
                studies = int(idx.get("studies", 0))
                instances = int(idx.get("instances", 0))
            except Exception:
                pass            # a peer whose index is unreadable still reports its ports
        return {
            "available": True,
            "running": peer is not None,
            "aet": self.aet,
            "scp_port": self.scp_port,
            "qr_port": self.qr_port,
            "void_port": self.void_port,
            "config_dir": self.dir,
            "storage_dir": (os.path.join(self.dir, "received") if self.dir else ""),
            "destinations": list(self.dest_names),
            "received": received,
            "errors": errors,
            "studies": studies,
            "instances": instances,
            "created_at": int(self.created_at),
        }

    # ---- create -----------------------------------------------------------
    def create(self) -> dict:
        """Mint a peer: temp config dir, two loopback listeners, two destinations."""
        with self._lock:
            if self.peer is not None:
                raise ValueError("a dev peer is already running — discard it first")
            aet = _new_aet()
            # Asserted rather than assumed: config validation refuses an AE title
            # over 16 characters, and a peer whose own config will not validate
            # fails somewhere much less legible than here.
            assert len(aet) <= 16, aet
            # GENERATED, never taken from input. Nothing on the HTTP surface
            # contributes a single character of this path, which is what makes
            # the delete guard's "one level under the temp root" rule something
            # the caller cannot argue with.
            peer_dir = tempfile.mkdtemp(prefix=PEER_PREFIX)
            # mkdtemp lands in the system temp directory, so this cannot normally
            # happen — and it costs one call to make it impossible. A peer tree
            # inside a watched or storage folder would be picked up by the
            # watcher as a new study and forwarded, to the peer, which stores it
            # in the watched folder again (see the warning on
            # deid.deidentified_tempfile for the same hazard one level down).
            watched = list(self.server.cfg.storage_roots())
            watched.append(self.server.cfg.resolved("scu", "pending_dir"))
            for root in watched:
                if root and safe_within(root, peer_dir):
                    remove_peer_dir(peer_dir)
                    raise ValueError(
                        f"the system temporary folder ({peer_dir}) is inside this appliance's "
                        f"own storage ({root}) — a test archive there would be picked up by "
                        f"the watcher and forwarded in a loop")
            # ONE guarded region, deliberately, from the first byte written into
            # the temp tree to the last row written on the primary. It was two,
            # and _write_peer_config sat in the seam between them: a full temp
            # filesystem or a primary whose own AE title is over-long made it
            # raise, and every failed attempt left a carino-peer-* tree and two
            # bound ports behind — reachable from a button, once per click. The
            # invariant this feature actually promises is "the failure path
            # leaves nothing at all behind", and only one handler can promise it.
            sock_a = sock_b = None
            peer = None
            try:
                with open(os.path.join(peer_dir, OWNER_FILE), "w", encoding="utf-8") as fh:
                    fh.write(str(os.getpid()))
                sock_a, scp_port = _reserve_port()
                sock_b, qr_port = _reserve_port()
                # The black hole's port is one nothing listens on, and closing
                # the reservation immediately is precisely what makes it that.
                # The OS may hand the number to something else later; on
                # loopback, with an ephemeral range that cycles, that is an
                # acceptable risk for a bench tool and the row ships disabled
                # anyway.
                sock_c, void_port = _reserve_port()
                sock_c.close()
                cfg = self._write_peer_config(peer_dir, aet, scp_port, qr_port)
                # Imported here: server.py imports this module, so a top-level
                # import would be a cycle.
                from .server import PacsServer
                # dev_peer stays False — a peer never gets a peer of its own.
                peer = PacsServer(cfg)
                peer.start_index()
                sock_a.close()
                peer.start_receiver()
                sock_b.close()
                peer.start_qr()
                # NEVER start_watcher(): a folder watcher over a temp directory
                # forwarding to this site's real destinations. And NEVER
                # emergency.start(): a second failover monitor C-ECHOing the
                # department's clinical nodes on a timer, from an archive
                # somebody created to try something out.
                self._wire_primary(aet, scp_port, void_port)
            except BaseException:
                # A half-created peer — a temp tree with no engine, or listeners
                # nothing has a record of — is worse than a failed create, so the
                # failure path leaves nothing at all behind.
                for sock in (sock_a, sock_b):
                    # None when the reservation itself is what failed: the
                    # second _reserve_port() raising used to leak the first
                    # socket for the life of the process.
                    if sock is None:
                        continue
                    try:
                        sock.close()
                    except OSError:
                        pass
                if self.dest_names:
                    # Nothing can raise after _wire_primary returns today, so
                    # this is a net rather than a fix — but "the rows are only
                    # safe because nothing was ever added below them" is an
                    # invariant a future edit breaks silently, and the thing it
                    # would leave behind is a destination aimed at an archive
                    # that never came up.
                    try:
                        self._unwire_primary()
                    except Exception:
                        pass
                    self.dest_names = []
                if peer is not None:
                    try:
                        peer.shutdown()
                    except Exception:
                        pass
                try:
                    remove_peer_dir(peer_dir)
                except (ValueError, OSError):
                    pass
                raise
            self.peer = peer
            self.dir = peer_dir
            self.aet = aet
            self.scp_port = scp_port
            self.qr_port = qr_port
            self.void_port = void_port
            self.created_at = time.time()
            if not self._atexit:
                # The SECONDARY net. The primary one is PacsServer.shutdown(),
                # because POST /api/shutdown calls shutdown() and then
                # os._exit(0) from a daemon thread — which runs no atexit handler
                # and no finally block, and is the most common way an appliance
                # is stopped. This covers only the exits that bypass both: an
                # exception escaping before app.run, or an embedded host. SIGKILL
                # and power loss are covered by neither; that is sweep_stale.
                atexit.register(self.discard)
                self._atexit = True
            # warn, not info: a second archive existing on this machine is worth
            # seeing in a log somebody is skimming.
            self.log.warn(
                f"Dev peer {aet} created on 127.0.0.1:{scp_port} (Q/R {qr_port}) in {peer_dir}",
                kind="devpeer")
            # Said out loud rather than left to fail silently. The peer's Q/R
            # can push a study BACK to this archive, and its C-MOVE sub-
            # operations arrive with the peer's own AE title as the caller
            # (QrSCP opens them under its own AE). StorageSCP applies
            # allowed_aets at start(), so on a hardened appliance the return
            # direction is refused at association time and the operator sees a
            # move that just does not arrive. It is not fixed here: adding the
            # title to the list would need the CLINICAL receiver restarted for
            # a bench tool, which is a far worse trade than a log line.
            allowed = [str(a).strip().upper()
                       for a in (self.server.cfg.scp.get("allowed_aets") or [])]
            if allowed and aet.upper() not in allowed:
                self.log.warn(
                    f"This archive only accepts associations from {', '.join(allowed)}, so a "
                    f"C-MOVE issued AT the peer cannot push back here — the peer calls as "
                    f"{aet}. Sending TO the peer works. To test the return direction, add "
                    f"{aet} to scp.allowed_aets and restart the receiver.", kind="devpeer")
            return self.status()

    def _write_peer_config(self, peer_dir: str, aet: str, scp_port: int, qr_port: int) -> Config:
        """The peer's whole config.json, written and validated before anything starts."""
        stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        primary = self.server.cfg
        overrides = {
            # Loopback UNCONDITIONALLY and not configurable: a test archive a
            # modality on the LAN can find is a second, unaudited store for
            # somebody's images.
            "scp": {"enabled": True, "aet": aet, "bind": "127.0.0.1", "port": scp_port,
                    "storage_dir": "./received", "organize": True, "allowed_aets": []},
            "scu": {"enabled": False, "aet": aet},
            "qr": {"enabled": True, "aet": aet, "bind": "127.0.0.1", "port": qr_port,
                   "allowed_aets": [],
                   # So a C-MOVE issued AT the peer can push back to this
                   # archive. Written into the peer's config BEFORE its QrSCP
                   # exists, which is the only moment that works: QrSCP copies
                   # this table at construction, so a later config write would
                   # change the file and not the running listener.
                   #
                   # It is the ADDRESS, not permission to use it: the primary's
                   # StorageSCP applies its own scp.allowed_aets at start(), so
                   # on an appliance that restricts callers this route is
                   # refused until the peer's title is added there and the
                   # receiver restarted. create() logs exactly that when it
                   # applies, because a move that is refused at association time
                   # says nothing on the peer side.
                   "move_destinations": {
                       str(primary.scp["aet"]): {"host": "127.0.0.1",
                                                 "port": int(primary.scp["port"]),
                                                 "aet": str(primary.scp["aet"])}}},
            "index": {"enabled": True, "path": "./index.db", "rescan_on_start": False},
            # The peer forwards NOTHING. A peer that routed onward could send a
            # study straight back to the archive it came from, and a test that
            # loops is worse than a test that does not run.
            "routing": {"enabled": False, "rules": []},
            "print": {"enabled": False},
            "mwl": {"enabled": False},
            "ris": {"enabled": False},
            "dicomweb": {"enabled": False},
            "emergency": {"armed": False},
            # Off on purpose. An audit trail deleted with the thing it audits is
            # theatre; the record that matters — that a second archive was
            # created, and by whom — is written to the PRIMARY's trail by the
            # route that called this.
            "audit": {"enabled": False},
            "users": {"profiles": []},
            "setup_completed": stamp,
        }
        # web is left at DEFAULTS (127.0.0.1:8042, no token) because nothing ever
        # builds a Flask app over this config — and loopback with no token is the
        # one combination validate() permits, so it cannot be the thing that
        # makes the peer's config refuse to save.
        #
        # Every path here stays RELATIVE. Config.resolve_path anchors a relative
        # path to the config file's own directory, so storage, index.db,
        # .carinopacs_state.json, the order store and the logs all land beside
        # this generated config — and the entire archive goes away in one rmtree.
        cfg = Config(os.path.join(peer_dir, "config.json"))
        # replace(), not save(): it is the call that validates, and a peer config
        # that would not validate must fail here rather than at start_receiver.
        cfg.replace(overrides)
        return cfg

    # ---- primary-side wiring ----------------------------------------------
    def _wire_primary(self, aet: str, scp_port: int, void_port: int) -> None:
        """Add the two destination rows that make the peer reachable.

        Deliberately NOT PacsServer.apply_config: that bounces the receiver, the
        printer, RIS, MWL and Q/R for a change no listener binds. Nothing needs
        restarting here — the router and the sender read
        cfg.enabled_destinations() fresh on every pass, and QrSCP was handed that
        bound method rather than a copy, so an enabled row is live the moment it
        is written.

        The primary's `qr` section is deliberately left alone. QrSCP copies
        move_destinations at construction and applies allowed_aets at start(), so
        writing either would change the file and not the running listener — a
        config edit that silently does nothing until a restart is worse than no
        edit. It is also unnecessary: resolve_move_destination falls back to
        get_destinations() matched by AE title, so the enabled row below already
        makes primary→peer C-MOVE resolve.
        """
        cfg = self.server.cfg
        # enabled: the peer row is on, the black hole is off, and the asymmetry
        # is the whole point. With routing off (or no rule matching) the decision
        # falls back to EVERY enabled destination, so an enabled black hole would
        # strand every study this archive receives in the Stuck tab. An enabled
        # peer only copies them to a loopback archive that is deleted with it.
        # The operator flips the black hole on in Configuration → Destinations
        # when they want the Stuck tab to fill, which is what the manual's own
        # demo recipe asks for.
        peer_row = {"name": f"Dev peer {aet}", "host": "127.0.0.1", "port": scp_port,
                    "aet": aet, "enabled": True, "tls": False,
                    # Never a trigger: the failover monitor probes these while
                    # armed, and a discarded peer would then read as the primary
                    # PACS going offline. Never no_ris either — that changes the
                    # worklist enrolment card for a row nobody enrolled.
                    "no_ris": False, "emergency_trigger": False, "ephemeral": True}
        void_row = {"name": f"Black hole {aet}", "host": "127.0.0.1", "port": void_port,
                    "aet": VOID_AET, "enabled": False, "tls": False,
                    "no_ris": False, "emergency_trigger": False, "ephemeral": True}
        with cfg.mutate():
            # The pre-filter drops rows a killed run left behind, so a create
            # never has to compete with its own ghost for a name.
            rows = [copy.deepcopy(r) for r in cfg.destinations if not r.get("ephemeral")]
            rows.extend([peer_row, void_row])
            candidate = copy.deepcopy(cfg.data)
            candidate["destinations"] = rows
            # What turns a name collision into a legible 400 instead of a
            # half-written config: validate() refuses duplicate destination names
            # case-insensitively, and the route hands the message straight on.
            cfg.would_accept(candidate)
            previous = copy.deepcopy(cfg.data.get("destinations", []))
            cfg.data["destinations"] = rows      # a NEW list, so the rollback restores something
            try:
                cfg.save()
            except OSError:
                cfg.data["destinations"] = previous
                raise
        self.dest_names = [peer_row["name"], void_row["name"]]

    def _unwire_primary(self) -> None:
        """Take our two rows back off the primary."""
        cfg = self.server.cfg
        recorded = {n.strip().lower() for n in self.dest_names}
        with cfg.mutate():
            # The `ephemeral` flag is the marker; the recorded names are the
            # second signal, because a dashboard Save rebuilds each destination
            # row from its form inputs and could drop the flag on the way
            # through. The names come from THIS object, which nothing over HTTP
            # can edit — the same argument the launch flag itself rests on. A
            # name is never accepted from a request body.
            rows = [r for r in cfg.destinations
                    if not r.get("ephemeral")
                    and str(r.get("name", "")).strip().lower() not in recorded]
            if len(rows) == len(cfg.destinations):
                return
            previous = copy.deepcopy(cfg.data.get("destinations", []))
            cfg.data["destinations"] = rows
            try:
                cfg.save()
            except OSError:
                cfg.data["destinations"] = previous
                raise

    # ---- discard ----------------------------------------------------------
    def discard(self) -> dict:
        """Stop the peer, unwire it, delete everything it stored.

        Idempotent, and it NEVER raises. PacsServer.shutdown() calls it, and on
        the POST /api/shutdown path shutdown() runs twice — once from the route
        and once from cmd_serve's finally. An exception here would skip
        stop_index() and drop the index writer's backlog, which is a real cost
        paid for a teardown that was already finished.
        """
        with self._lock:
            if self.peer is None and not self.dir:
                return self.status()            # the no-op second call
            peer, peer_dir, aet = self.peer, self.dir, self.aet
            # Cleared BEFORE the work, so a concurrent second call cannot start
            # the same teardown a second time.
            self.peer = None
            self.dir = ""
            if peer is not None:
                try:
                    peer.shutdown()
                except Exception as exc:
                    self.log.error(f"Dev peer {aet} did not shut down cleanly: {exc}",
                                   kind="devpeer")
            try:
                self._unwire_primary()
            except Exception as exc:
                # A read-only config directory or a full disk must never be able
                # to stop the engine from stopping.
                self.log.error(f"Could not remove the dev peer's destinations: {exc}",
                               kind="devpeer")
            if peer_dir:
                try:
                    remove_peer_dir(peer_dir)
                except (ValueError, OSError) as exc:
                    self.log.error(f"Could not delete the dev peer folder {peer_dir}: {exc}",
                                   kind="devpeer")
            self.aet = ""
            self.scp_port = self.qr_port = self.void_port = 0
            self.dest_names = []
            self.created_at = 0.0
            self.log.warn(f"Dev peer {aet} discarded — its archive and its destinations are gone.",
                          kind="devpeer")
            return self.status()
