"""The disposable second archive: the delete guard, the wiring, and the flag.

Runs under pytest, or standalone: python3 tests/test_dev_peer.py

Three defects are worth writing tests against here, and they are not the same
kind of defect.

  * A helper that ends in shutil.rmtree. Most of this file attacks
    remove_peer_dir with the shapes an attacker or a typo would produce — "..",
    a symlink wearing the prefix, the temp root itself, a path somewhere else
    entirely — and asserts both halves: that it refused, AND that the thing it
    was pointed at is still there. A guard that raises after deleting is not a
    guard.

  * A second archive that must be impossible to conjure over HTTP. The feature
    is a launch flag precisely because a config key would be editable through
    POST /api/config, so the tests assert what a request CANNOT do: no
    capability, no route; no flag, no feature — and in that order, so a profile
    that may not do this is never told whether the build even has it.

  * A status block that must not default to visible. It carries an AE title,
    two ports and a path under the system temp folder. The non-disclosure test
    searches the serialised payload rather than reading its keys, because that
    is how a leak is actually found.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest                                            # noqa: E402

from pacs import devpeer                                 # noqa: E402
from pacs import users as U                              # noqa: E402
from pacs.config import Config, validate                 # noqa: E402
from pacs.devpeer import DevPeer, remove_peer_dir, sweep_stale   # noqa: E402
from pacs.web import create_app                          # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_web_auth import FakeLog, FakeServer, WRITE      # noqa: E402


def _symlinks_work(tmp_path) -> bool:
    """Windows needs a privilege for this, and a skip beats a red suite there."""
    try:
        os.symlink(str(tmp_path), str(tmp_path / "probe-link"), target_is_directory=True)
    except (OSError, NotImplementedError, AttributeError):
        return False
    os.unlink(str(tmp_path / "probe-link"))
    return True


# ---- the path guard -----------------------------------------------------
# Every case here is "the caller asked for a directory tree to be deleted".
# The assertion is always two-part: it refused, and the target survived.

def test_the_guard_refuses_a_path_outside_the_temporary_folder(tmp_path):
    victim = tmp_path / "elsewhere"
    victim.mkdir()
    (victim / "keep.txt").write_text("mine", encoding="utf-8")
    with pytest.raises(ValueError) as exc:
        remove_peer_dir(str(victim))
    assert "refusing to delete" in str(exc.value)
    assert (victim / "keep.txt").exists()


def test_the_guard_refuses_the_temporary_folder_itself():
    """"." and "carino-peer-x/.." both resolve to the temp root.

    It is the case that is easiest to leave out of a prefix check, and it is
    the one that would take every other process's scratch files with it. Note
    ONE ".." after a peer name, not two: two climbs to the root's parent, which
    is a different refusal and used to be asserted here by mistake.
    """
    root = tempfile.gettempdir()
    assert os.path.isdir(root)
    for candidate in (root,
                      os.path.join(root, devpeer.PEER_PREFIX + "x", ".."),
                      os.path.join(root, ".")):
        with pytest.raises(ValueError) as exc:
            remove_peer_dir(candidate)
        assert "refusing to delete" in str(exc.value)
    assert os.path.isdir(root)


def test_the_guard_refuses_a_path_that_climbs_out_with_dotdot():
    peer = tempfile.mkdtemp(prefix=devpeer.PEER_PREFIX)
    try:
        with pytest.raises(ValueError):
            remove_peer_dir(os.path.join(peer, "..", ".."))
        assert os.path.isdir(peer)
    finally:
        shutil.rmtree(peer, ignore_errors=True)


def test_the_guard_refuses_a_symlink_wearing_our_prefix(tmp_path):
    """The one shape somebody could plant: a world-writable temp directory and
    a link named like ours, pointing somewhere else.

    The link's target is ITSELF a carino-peer-* directory one level under the
    temp root, and that is the point of the test rather than an incidental
    detail. A link aimed anywhere else is refused by the "directly under the
    root" rule whether or not the islink check exists, so a test written that
    way asserts nothing about the defence it names: delete the islink line and
    it still passes. With this shape the islink check is the only thing between
    a caller and an rmtree of a tree it did not name — the guard follows a link
    to a legitimate-looking directory and deletes the WRONG peer.
    """
    if not _symlinks_work(tmp_path):
        pytest.skip("this platform will not let the test create a symlink")
    victim = tempfile.mkdtemp(prefix=devpeer.PEER_PREFIX)
    with open(os.path.join(victim, "precious.txt"), "w", encoding="utf-8") as fh:
        fh.write("another session's archive")
    link = os.path.join(tempfile.gettempdir(), devpeer.PEER_PREFIX + "link")
    if os.path.lexists(link):
        os.unlink(link)
    os.symlink(victim, link, target_is_directory=True)
    try:
        with pytest.raises(ValueError) as exc:
            remove_peer_dir(link)
        assert "symlink" in str(exc.value)
        assert os.path.isdir(victim)
        assert os.path.exists(os.path.join(victim, "precious.txt"))
        assert os.path.islink(link), "the link itself must not have been removed either"
    finally:
        if os.path.lexists(link):
            os.unlink(link)
        shutil.rmtree(victim, ignore_errors=True)


def test_the_guard_refuses_a_directory_that_is_not_one_of_ours():
    other = tempfile.mkdtemp(prefix="carino-other-")
    try:
        with pytest.raises(ValueError):
            remove_peer_dir(other)
        assert os.path.isdir(other)
    finally:
        shutil.rmtree(other, ignore_errors=True)


def test_the_guard_refuses_a_peer_directory_nested_deeper_than_one_level():
    """mkdtemp puts a peer exactly one level down. Anything deeper is somebody
    else's tree that happens to sit under the same root."""
    outer = tempfile.mkdtemp(prefix=devpeer.PEER_PREFIX)
    inner = os.path.join(outer, devpeer.PEER_PREFIX + "b")
    os.mkdir(inner)
    try:
        with pytest.raises(ValueError):
            remove_peer_dir(inner)
        assert os.path.isdir(inner)
    finally:
        shutil.rmtree(outer, ignore_errors=True)


def test_the_guard_deletes_a_real_peer_directory():
    """The refusals above are worthless if they also refuse the legitimate case."""
    peer = tempfile.mkdtemp(prefix=devpeer.PEER_PREFIX)
    with open(os.path.join(peer, "index.db"), "w", encoding="utf-8") as fh:
        fh.write("x")
    remove_peer_dir(peer)
    assert not os.path.exists(peer)


def test_the_guard_realpaths_both_sides_the_way_macos_needs(tmp_path, monkeypatch):
    """The macOS shape, reproduced on any host.

    /tmp and /var/folders are symlinks into /private there, so a guard that
    compares raw strings passes on Linux CI and refuses every legitimate delete
    on a Mac — the worst possible split, because Linux is the half that runs the
    tests.
    """
    if not _symlinks_work(tmp_path):
        pytest.skip("this platform will not let the test create a symlink")
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    os.symlink(str(real), str(link), target_is_directory=True)
    monkeypatch.setattr(devpeer.tempfile, "gettempdir", lambda: str(link))
    peer = os.path.join(str(link), devpeer.PEER_PREFIX + "x")
    os.mkdir(peer)
    remove_peer_dir(peer)
    assert not os.path.exists(peer)


# ---- ports and AE titles ------------------------------------------------

def test_a_generated_ae_title_fits_the_dicom_limit():
    """16 characters is a DICOM limit and config validation enforces it, so a
    longer title would be refused by the peer's own config rather than caught
    here."""
    seen = set()
    for _ in range(200):
        aet = devpeer._new_aet()
        assert len(aet) <= 16, aet
        assert aet.startswith(devpeer.AE_PREFIX)
        seen.add(aet)
    # Distinctness is the point of the suffix: allowed_aets, routing rules and
    # move_destinations are all keyed by AE title.
    assert len(seen) > 1


def test_reserved_ports_are_real_free_ports_and_never_the_same():
    """Never a fixed offset from the primary's ports: +100 is occupied on
    somebody's machine, and holding the first socket open is what stops the
    second reservation being handed the same number."""
    sock_a, port_a = devpeer._reserve_port()
    sock_b, port_b = devpeer._reserve_port()
    try:
        assert port_a and port_b and port_a != port_b
    finally:
        sock_a.close()
        sock_b.close()
    for port in (port_a, port_b):
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind(("127.0.0.1", port))     # free again the moment we let go
        finally:
            probe.close()


# ---- the startup sweep --------------------------------------------------
# Always against an INJECTED tmp_root. A sweep of the real temporary folder
# could delete a directory belonging to a developer's live session, which is
# precisely the accident this module exists to avoid.

def test_the_sweep_removes_a_directory_left_by_a_killed_run(tmp_path):
    stale = tmp_path / (devpeer.PEER_PREFIX + "dead")
    stale.mkdir()
    (stale / "index.db").write_text("x", encoding="utf-8")
    removed = sweep_stale(tmp_root=str(tmp_path))
    assert removed == [str(stale)]
    assert not stale.exists()


def test_the_sweep_leaves_a_stranger_alone(tmp_path):
    stranger = tmp_path / "something-else"
    stranger.mkdir()
    assert sweep_stale(tmp_root=str(tmp_path)) == []
    assert stranger.is_dir()


def test_the_sweep_leaves_a_directory_whose_owner_is_still_running(tmp_path):
    """A second live dashboard on the same box is not litter. The owner pid is
    checked with os.kill(pid, 0), which is POSIX-only on purpose — see
    devpeer._pid_alive for why it is never asked on Windows."""
    if os.name != "posix":
        pytest.skip("_pid_alive only asks the question on POSIX")
    live = tmp_path / (devpeer.PEER_PREFIX + "live")
    live.mkdir()
    (live / devpeer.OWNER_FILE).write_text(str(os.getpid()), encoding="utf-8")
    assert sweep_stale(tmp_root=str(tmp_path)) == []
    assert live.is_dir()


def test_the_sweep_never_follows_a_symlink_or_removes_a_file(tmp_path):
    """Two link shapes and a plain file, and the assertion that bites is on the
    RETURN VALUE.

    `link_in` points at a real stale peer directory inside the same root — the
    one shape where following the link would still end in a legitimate-looking
    rmtree. The sweep must reach that directory by its own name, once, and
    never through the link: a sweep that followed links would report the tree
    twice (or report the link instead), which is exactly what `removed` is
    asserted to be here.
    """
    if not _symlinks_work(tmp_path):
        pytest.skip("this platform will not let the test create a symlink")
    root = tmp_path / "root"
    root.mkdir()
    victim = tmp_path / "victim"
    victim.mkdir()
    (victim / "precious.txt").write_text("keep", encoding="utf-8")
    plain = root / (devpeer.PEER_PREFIX + "f")
    plain.write_text("not a directory", encoding="utf-8")
    link_out = root / (devpeer.PEER_PREFIX + "l")
    os.symlink(str(victim), str(link_out), target_is_directory=True)
    stale = root / (devpeer.PEER_PREFIX + "target")
    stale.mkdir()
    (stale / "index.db").write_text("x", encoding="utf-8")
    link_in = root / (devpeer.PEER_PREFIX + "m")
    os.symlink(str(stale), str(link_in), target_is_directory=True)

    assert sweep_stale(tmp_root=str(root)) == [str(stale)]
    assert not stale.exists()
    assert plain.is_file()
    assert os.path.islink(str(link_out))
    assert os.path.islink(str(link_in))
    assert (victim / "precious.txt").exists()


def test_the_sweep_drops_destination_rows_a_killed_run_left_behind(tmp_path):
    """A destination aimed at an archive that no longer exists is exactly what
    this feature refuses to leave on an appliance."""
    cfg = Config(str(tmp_path / "config.json"))
    cfg.data["destinations"] = [
        {"name": "Real PACS", "host": "10.0.0.9", "port": 104, "aet": "REMOTE",
         "enabled": True},
        {"name": "Dev peer CARINOPEERAB12", "host": "127.0.0.1", "port": 51000,
         "aet": "CARINOPEERAB12", "enabled": True, "ephemeral": True},
        {"name": "Black hole CARINOPEERAB12", "host": "127.0.0.1", "port": 51001,
         "aet": "CARINOVOID", "enabled": False, "ephemeral": True},
    ]
    cfg.save()
    sweep_stale(tmp_root=str(tmp_path / "empty-root"), cfg=cfg)
    assert [d["name"] for d in cfg.destinations] == ["Real PACS"]
    reloaded = Config(str(tmp_path / "config.json"))
    assert [d["name"] for d in reloaded.destinations] == ["Real PACS"]


def _live_peer_dir(root, aet):
    """A peer folder that looks exactly like one this process is using."""
    path = os.path.join(str(root), devpeer.PEER_PREFIX + aet.lower())
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, devpeer.OWNER_FILE), "w", encoding="utf-8") as fh:
        fh.write(str(os.getpid()))
    with open(os.path.join(path, "config.json"), "w", encoding="utf-8") as fh:
        json.dump({"scp": {"aet": aet, "port": 51000}}, fh)
    return path


def test_the_sweep_keeps_the_rows_of_a_peer_it_just_decided_is_still_alive(tmp_path):
    """The half that deletes DIRECTORIES leaves a live peer alone. The half
    that deletes ROWS has to make the same decision, or the sweep cuts a running
    archive off from the primary that created it: the peer keeps receiving
    nothing, the dashboard keeps showing it, and the config on disk no longer
    knows it exists. `pacs serve` runs this on every start, so a second
    dashboard on the same machine is an ordinary Tuesday, not a corner case.
    """
    if os.name != "posix":
        pytest.skip("_pid_alive only asks the question on POSIX")
    root = tmp_path / "root"
    root.mkdir()
    live_dir = _live_peer_dir(root, "CARINOPEERLIVE")
    cfg = Config(str(tmp_path / "config.json"))
    cfg.data["destinations"] = [
        {"name": "Real PACS", "host": "10.0.0.9", "port": 104, "aet": "REMOTE", "enabled": True},
        {"name": "Dev peer CARINOPEERLIVE", "host": "127.0.0.1", "port": 51000,
         "aet": "CARINOPEERLIVE", "enabled": True, "ephemeral": True},
        {"name": "Black hole CARINOPEERLIVE", "host": "127.0.0.1", "port": 51001,
         "aet": "CARINOVOID", "enabled": False, "ephemeral": True},
        {"name": "Dev peer CARINOPEERDEAD", "host": "127.0.0.1", "port": 52000,
         "aet": "CARINOPEERDEAD", "enabled": True, "ephemeral": True},
    ]
    cfg.save()
    assert sweep_stale(tmp_root=str(root), cfg=cfg) == []
    assert os.path.isdir(live_dir), "the directory half already got this right"
    names = [d["name"] for d in cfg.destinations]
    assert names == ["Real PACS", "Dev peer CARINOPEERLIVE", "Black hole CARINOPEERLIVE"]
    reloaded = Config(str(tmp_path / "config.json"))
    assert [d["name"] for d in reloaded.destinations] == names


def test_the_sweep_touches_no_rows_at_all_when_a_live_peer_will_not_say_who_it_is(tmp_path):
    """An unreadable config in a folder whose owner is running is a title this
    process cannot exclude. One more restart with a stale row is recoverable;
    cutting a live peer loose is not, so the whole config half is skipped."""
    if os.name != "posix":
        pytest.skip("_pid_alive only asks the question on POSIX")
    root = tmp_path / "root"
    root.mkdir()
    mystery = root / (devpeer.PEER_PREFIX + "mystery")
    mystery.mkdir()
    (mystery / devpeer.OWNER_FILE).write_text(str(os.getpid()), encoding="utf-8")
    cfg = Config(str(tmp_path / "config.json"))
    cfg.data["destinations"] = [
        {"name": "Dev peer CARINOPEERAB12", "host": "127.0.0.1", "port": 51000,
         "aet": "CARINOPEERAB12", "enabled": True, "ephemeral": True},
    ]
    cfg.save()
    assert sweep_stale(tmp_root=str(root), cfg=cfg) == []
    assert [d["name"] for d in cfg.destinations] == ["Dev peer CARINOPEERAB12"]
    assert mystery.is_dir()


# ---- the HTTP surface ---------------------------------------------------

class StubPeer:
    """A dev peer that records instead of creating one. The routes must be
    reachable without a real archive coming into existence."""

    def __init__(self):
        self.calls = []

    def status(self):
        return {"available": True, "running": False, "aet": "", "scp_port": 0}

    def create(self):
        self.calls.append("create")
        return self.status()

    def discard(self):
        self.calls.append("discard")
        return self.status()


@pytest.fixture()
def app_and_ids(tmp_path):
    srv = FakeServer(str(tmp_path))
    with srv.cfg.mutate():
        srv.cfg.users["profiles"] = U.preset_profiles()
        srv.cfg.save()
    app = create_app(srv)
    ids = {p["name"]: p["id"] for p in srv.cfg.users["profiles"]}
    return app, ids, srv


def signed_in(app, ids, name):
    client = app.test_client()
    resp = client.post("/api/login", json={"profile": ids[name]}, headers=WRITE)
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return client


def test_the_routes_are_refused_to_a_profile_without_the_capability(app_and_ids):
    app, ids, _srv = app_and_ids
    client = signed_in(app, ids, "Reception")
    body = client.post("/api/dev-peer", json={"action": "create"}, headers=WRITE).get_json()
    assert body["forbidden"]["capability"] == "devpeer.manage"
    assert body["forbidden"]["profile"] == "Reception"
    assert client.get("/api/dev-peer", headers=WRITE).status_code == 403


def test_the_routes_report_the_flag_was_never_given_rather_than_a_broken_endpoint(app_and_ids):
    """IT holds the capability, so what is left is the flag.

    404 with the argument named, not 405 from the static catch-all: "this build
    has no such thing" and "you used the wrong method" send an operator to two
    different places.
    """
    app, ids, _srv = app_and_ids
    client = signed_in(app, ids, "IT")
    resp = client.post("/api/dev-peer", json={"action": "create"}, headers=WRITE)
    assert resp.status_code == 404
    assert "--dev-peer" in resp.get_json()["error"]
    resp = client.get("/api/dev-peer", headers=WRITE)
    assert resp.status_code == 404
    assert "--dev-peer" in resp.get_json()["error"]


def test_a_bad_action_is_refused_before_anything_is_created(tmp_path):
    srv = FakeServer(str(tmp_path))
    with srv.cfg.mutate():
        srv.cfg.users["profiles"] = U.preset_profiles()
        srv.cfg.save()
    stub = StubPeer()
    srv.dev_peer = stub
    app = create_app(srv)
    ids = {p["name"]: p["id"] for p in srv.cfg.users["profiles"]}
    client = signed_in(app, ids, "IT")
    resp = client.post("/api/dev-peer", json={"action": "nuke"}, headers=WRITE)
    assert resp.status_code == 400
    assert stub.calls == []
    # And the capability holder can still work it, or the refusal above proves
    # nothing about the gate.
    assert client.post("/api/dev-peer", json={"action": "create"},
                       headers=WRITE).status_code == 200
    assert stub.calls == ["create"]


class PeerStatusServer(FakeServer):
    """A FakeServer whose status() carries the dev_peer block, so the gate in
    _STATUS_GATES is exercised against a real payload."""

    def status(self):
        body = super().status()
        body["dev_peer"] = {
            "available": True, "running": True, "aet": "CARINOPEERAB12",
            "scp_port": 54321, "qr_port": 54322, "void_port": 54323,
            "config_dir": "/tmp/carino-peer-ab12",
            "storage_dir": "/tmp/carino-peer-ab12/received",
            "destinations": [], "received": 0, "errors": 0,
            "studies": 0, "instances": 0, "created_at": 0,
        }
        return body


def test_the_status_block_is_dropped_for_a_profile_that_may_not_see_it(tmp_path):
    srv = PeerStatusServer(str(tmp_path))
    srv.dev_peer = StubPeer()
    with srv.cfg.mutate():
        srv.cfg.users["profiles"] = U.preset_profiles()
        srv.cfg.save()
    app = create_app(srv)
    ids = {p["name"]: p["id"] for p in srv.cfg.users["profiles"]}
    for who in ("IT", "Administrator"):
        body = signed_in(app, ids, who).get("/api/status", headers=WRITE).get_json()
        assert "dev_peer" in body, who
    for who in ("Reception", "Radiologist"):
        payload = signed_in(app, ids, who).get("/api/status", headers=WRITE).get_json()
        assert "dev_peer" not in payload, who
        # The non-disclosure half: searched, not read key by key. A regression
        # that moves the AE title or the temp path under a new spelling passes
        # every key assertion and fails this one.
        blob = json.dumps(payload)
        assert "CARINOPEERAB12" not in blob
        assert "54321" not in blob
        assert "carino-peer-" not in blob


# ---- end to end ---------------------------------------------------------
# Real listeners on loopback, and no associations are opened against them, so
# nothing here can hang waiting on a DICOM peer.

class StubServer:
    """The PacsServer surface DevPeer touches: a config and a log."""

    def __init__(self, cfg, log):
        self.cfg = cfg
        self.log = log


def _primary(tmp_path):
    cfg = Config(str(tmp_path / "config.json"))
    cfg.data["scp"]["aet"] = "CARINOPACS"
    cfg.data["scp"]["port"] = 11112
    cfg.data["destinations"] = [
        {"name": "Real PACS", "host": "10.0.0.9", "port": 104, "aet": "REMOTE",
         "enabled": True},
    ]
    cfg.save()
    return cfg


def test_a_peer_is_created_wired_and_then_leaves_nothing_behind(tmp_path):
    cfg = _primary(tmp_path)
    peer = DevPeer(StubServer(cfg, FakeLog()), FakeLog())
    try:
        block = peer.create()
        assert os.path.isdir(block["config_dir"])
        assert os.path.dirname(os.path.realpath(block["config_dir"])) == \
            os.path.realpath(tempfile.gettempdir())
        assert os.path.basename(block["config_dir"]).startswith(devpeer.PEER_PREFIX)
        assert len(block["aet"]) <= 16
        assert block["scp_port"] and block["qr_port"]
        assert block["scp_port"] != block["qr_port"] != block["void_port"]
        assert block["running"] is True
        # "Record the actual ports" means the numbers in the block are the ones
        # something is listening on — not two integers the allocator liked.
        # status()["running"] only says an object exists, so it is asked here
        # with a TCP connect: a create that bound nothing, or bound a different
        # port, passes every other assertion in this file.
        for port in (block["scp_port"], block["qr_port"]):
            probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            probe.settimeout(5)
            try:
                probe.connect(("127.0.0.1", port))
            finally:
                probe.close()
        # And the black hole is a hole: the row exists so sends FAIL against it.
        void = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        void.settimeout(5)
        try:
            with pytest.raises(OSError):
                void.connect(("127.0.0.1", block["void_port"]))
        finally:
            void.close()

        rows = cfg.destinations
        assert [r["name"] for r in rows][0] == "Real PACS", "the site's own row must survive"
        added = [r for r in rows if r.get("ephemeral")]
        assert len(added) == 2
        for row in added:
            assert row["host"] == "127.0.0.1"
            assert row["ephemeral"] is True
            # Never a trigger (the failover monitor probes those while armed)
            # and never no_ris (that moves the worklist enrolment card).
            assert row["emergency_trigger"] is False
            assert row["no_ris"] is False
        peer_row = [r for r in added if r["aet"] == block["aet"]][0]
        void_row = [r for r in added if r["aet"] == devpeer.VOID_AET][0]
        # The asymmetry is deliberate: with routing off the decision falls back
        # to every ENABLED destination, so an enabled black hole would strand
        # every study on the archive in the Stuck tab.
        assert peer_row["enabled"] is True
        assert void_row["enabled"] is False

        gone = peer.discard()
        assert gone["running"] is False
        assert not os.path.exists(block["config_dir"])
        assert [r["name"] for r in cfg.destinations] == ["Real PACS"]
        reloaded = Config(str(tmp_path / "config.json"))
        assert [r["name"] for r in reloaded.destinations] == ["Real PACS"]
        # Called twice on the /api/shutdown path, so the second one has to be a
        # silent no-op rather than an exception that skips stop_index().
        assert peer.discard()["running"] is False
    finally:
        peer.discard()


def _our_leftovers():
    """Peer folders in the real temp root that THIS process created.

    Scoped by the recorded owner pid, never by prefix alone: a developer
    running the suite while a dashboard of their own is up must not have that
    dashboard's archive counted as this test's litter — or, worse, deleted by
    a cleanup somebody adds here later.
    """
    root = tempfile.gettempdir()
    return [name for name in os.listdir(root)
            if name.startswith(devpeer.PEER_PREFIX)
            and devpeer._owner_pid(os.path.join(root, name)) == os.getpid()]


def test_a_peer_that_cannot_start_leaves_no_directory_and_no_destination_rows(tmp_path, monkeypatch):
    """A half-created peer is worse than a failed create.

    This is the LISTENER failure: start_receiver raises, which happens before
    any row is written, so the destination assertion below is only a guard
    against a future create() that wires first. The two failures that do write
    something — a peer config that will not write, and a failure after the
    wiring — get their own tests underneath.
    """
    import pacs.server

    cfg = _primary(tmp_path)
    before = [dict(r) for r in cfg.destinations]

    def refuse(self):
        raise OSError("address in use")

    monkeypatch.setattr(pacs.server.PacsServer, "start_receiver", refuse)
    peer = DevPeer(StubServer(cfg, FakeLog()), FakeLog())
    with pytest.raises(OSError):
        peer.create()
    assert cfg.destinations == before
    assert _our_leftovers() == [], "a temp tree was left behind"


def test_a_peer_whose_config_cannot_be_written_leaks_no_folder_and_no_ports(tmp_path, monkeypatch):
    """The seam between the two try blocks, which used to leak on every click.

    _write_peer_config raises on a full or read-only temp filesystem, and on any
    primary whose own AE title is over-long (it is copied into the peer's
    move_destinations, and cfg.replace() validates). The route turns both into a
    400, so an operator retries — and each retry left one carino-peer-* tree,
    recording the LIVE pid so no sweep would ever take it, plus two loopback
    ports held for the life of the process.
    """
    cfg = _primary(tmp_path)
    ports = []
    real_reserve = devpeer._reserve_port

    def spy(bind="127.0.0.1"):
        sock, port = real_reserve(bind)
        ports.append(port)
        return sock, port

    def refuse(self, *args):
        raise ValueError("qr.move_destinations['...'] AE title too long")

    monkeypatch.setattr(devpeer, "_reserve_port", spy)
    monkeypatch.setattr(DevPeer, "_write_peer_config", refuse)
    peer = DevPeer(StubServer(cfg, FakeLog()), FakeLog())
    with pytest.raises(ValueError):
        peer.create()
    assert _our_leftovers() == [], "a temp tree was left behind"
    assert ports, "the reservations under test were never made"
    for port in ports:
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind(("127.0.0.1", port))     # still held → EADDRINUSE
        finally:
            probe.close()
    assert cfg.destinations == [dict(r) for r in cfg.destinations if not r.get("ephemeral")]


def test_a_reservation_that_fails_halfway_lets_go_of_the_one_it_already_took(tmp_path, monkeypatch):
    """The second _reserve_port() raising must not strand the first socket."""
    cfg = _primary(tmp_path)
    taken = []
    real_reserve = devpeer._reserve_port

    def once_then_refuse(bind="127.0.0.1"):
        if taken:
            raise OSError("no ports left")
        sock, port = real_reserve(bind)
        taken.append(port)
        return sock, port

    monkeypatch.setattr(devpeer, "_reserve_port", once_then_refuse)
    peer = DevPeer(StubServer(cfg, FakeLog()), FakeLog())
    with pytest.raises(OSError):
        peer.create()
    assert _our_leftovers() == []
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", taken[0]))
    finally:
        probe.close()


def test_a_failure_after_the_wiring_takes_the_destination_rows_back(tmp_path, monkeypatch):
    """Nothing in create() can raise after _wire_primary today — this is what
    protects that invariant.

    If anything ever is added below it, the thing left behind is precisely what
    this feature refuses to leave anywhere: an enabled destination on the real
    appliance aimed at an archive that never came up.
    """
    cfg = _primary(tmp_path)
    before = [dict(r) for r in cfg.destinations]
    real_wire = DevPeer._wire_primary

    def wire_then_fail(self, *args):
        real_wire(self, *args)
        assert any(r.get("ephemeral") for r in cfg.destinations), "the rows must exist first"
        raise RuntimeError("whatever gets added below the wiring one day")

    monkeypatch.setattr(DevPeer, "_wire_primary", wire_then_fail)
    peer = DevPeer(StubServer(cfg, FakeLog()), FakeLog())
    with pytest.raises(RuntimeError):
        peer.create()
    assert cfg.destinations == before
    reloaded = Config(str(tmp_path / "config.json"))
    assert [r["name"] for r in reloaded.destinations] == ["Real PACS"]
    assert _our_leftovers() == []


# ---- the engine wiring (server.py) --------------------------------------
# The flag→DevPeer branch, the status block and the discard-on-shutdown path
# live in PacsServer, and a stub cannot exercise any of them: a FakeServer that
# fabricates a dev_peer dict proves only that the status gate drops a key that
# was already there.

def test_only_the_flag_creates_the_peer_and_only_then_does_status_carry_it(tmp_path):
    from pacs.server import PacsServer

    cfg = _primary(tmp_path)
    plain = PacsServer(cfg)
    try:
        assert plain.dev_peer is None
        # Absent, not empty: a dashboard that never sees the key hides the whole
        # panel, which is how "this build cannot do that" is expressed.
        assert "dev_peer" not in plain.status()
    finally:
        plain.shutdown()

    srv = PacsServer(cfg, dev_peer=True)
    try:
        assert srv.dev_peer is not None
        block = srv.status()["dev_peer"]
        assert block["available"] is True
        # Constructing it allocates nothing — no temp folder, no listener.
        assert block["running"] is False
        assert block["config_dir"] == ""
        assert _our_leftovers() == []
    finally:
        srv.shutdown()


def test_stopping_the_engine_deletes_the_peer_and_its_rows(tmp_path):
    """The dashboard's own Stop button is the most common shutdown there is,
    and PacsServer.shutdown() is the hook that catches it — atexit does not run
    on the /api/shutdown path, which ends in os._exit(0)."""
    from pacs.server import PacsServer

    cfg = _primary(tmp_path)
    srv = PacsServer(cfg, dev_peer=True)
    try:
        block = srv.dev_peer.create()
        assert os.path.isdir(block["config_dir"])
        assert srv.status()["dev_peer"]["running"] is True
        assert len([r for r in cfg.destinations if r.get("ephemeral")]) == 2
        srv.shutdown()
        assert not os.path.exists(block["config_dir"])
        assert [r["name"] for r in cfg.destinations] == ["Real PACS"]
        reloaded = Config(str(tmp_path / "config.json"))
        assert [r["name"] for r in reloaded.destinations] == ["Real PACS"]
        # Twice on the /api/shutdown path, so the second one is a no-op.
        srv.shutdown()
    finally:
        if srv.dev_peer is not None:
            srv.dev_peer.discard()


def test_the_peer_config_validates_and_keeps_everything_beside_itself(tmp_path):
    """Every path in the peer's config stays relative, so Config.resolve_path
    anchors the whole archive beside the generated config — and one rmtree takes
    all of it."""
    cfg = _primary(tmp_path)
    peer = DevPeer(StubServer(cfg, FakeLog()), FakeLog())
    try:
        block = peer.create()
        peer_config = os.path.join(block["config_dir"], "config.json")
        with open(peer_config, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        validate(doc)                          # must not raise
        assert doc["scp"]["bind"] == "127.0.0.1"
        assert doc["qr"]["bind"] == "127.0.0.1"
        assert doc["routing"]["enabled"] is False
        assert doc["audit"]["enabled"] is False
        # The return direction for a C-MOVE issued AT the peer, written before
        # its QrSCP existed — the only moment that reaches the listener.
        assert "CARINOPACS" in doc["qr"]["move_destinations"]
        loaded = Config(peer_config)
        root = os.path.realpath(block["config_dir"])
        for section, field in (("scp", "storage_dir"), ("index", "path")):
            assert os.path.realpath(loaded.resolved(section, field)).startswith(root)
    finally:
        peer.discard()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
