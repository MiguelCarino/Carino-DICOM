"""Regression tests for the 2026-10 review: config validation, the RIS order
store and MLLP listener, the worklist matcher, the print SCP, the emergency
controller, the notifier, the audit trail, the SCU, the update check, the
small stores, the dev-peer sweep, the container entrypoint and healthcheck,
and the desktop shell's host helpers.

Runs under pytest, or directly:  python3 tests/test_review_misc.py
"""

from __future__ import annotations

import copy
import json
import os
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import time
import tracemalloc
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest                                              # noqa: E402
from pydicom.dataset import Dataset                        # noqa: E402

from pacs import config as C                               # noqa: E402
from pacs import users as U                                # noqa: E402
from pacs.logbuf import LogBuffer                          # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def doc(**edits):
    d = copy.deepcopy(C.DEFAULTS)
    for dotted, value in edits.items():
        parts = dotted.split("__")
        node = d
        for p in parts[:-1]:
            node = node[p]
        node[parts[-1]] = value
    return d


# =================================================================== config
@pytest.mark.parametrize("edits", [
    {"dicomweb__enabled": True, "dicomweb__cors_origins": ["*"]},
    {"dicomweb__cors_origins": ["null"]},
    {"web__editor_url": "javascript:alert(1)//"},
    {"scp__min_free_gb": "two"}, {"scp__min_free_gb": -5},
    {"scp__aet": "A\\B"}, {"scu__aet": ""}, {"scp__aet": "ÄÖ"},
    {"destinations": [{"name": "A", "host": "h", "port": 104, "aet": ""}]},
    {"destinations": [None]},
    {"scu__sent_dir": "./outgoing", "scu__on_success": "move"},
    {"scu__sent_dir": "."}, {"scu__pending_dir": "./outgoing"}, {"scp__storage_dir": ""},
    {"web__port": 11112}, {"web__port": 0}, {"web__port": 70000}, {"web__port": "abc"},
    {"web__port": True},
    {"scp__allowed_aets": "CT1"}, {"qr__allowed_aets": [5]},
    {"ris__allowed_hosts": ["not-an-ip"]},
    {"notify__webhook__enabled": "false", "notify__webhook__url": "https://h.example/x"},
    {"notify__webhook__secret": 123}, {"notify__smtp__password": 123},
    {"scp__port": True},
    {"qr__move_destinations": {"X": {"host": "h", "port": True, "aet": "X"}}},
    {"notify__webhook__enabled": True, "notify__webhook__url": "http://"},
    {"scu__poll_interval": "5"}, {"scu__poll_interval": float("nan")},
])
def test_validate_refuses(edits):
    with pytest.raises(ValueError):
        C.validate(doc(**edits))


@pytest.mark.parametrize("edits", [
    {"scp__min_free_gb": 0}, {"scp__min_free_gb": 1.5},
    {"web__editor_url": "/editor/"}, {"web__editor_url": "https://dcm.carino.systems/"},
    {"notify__webhook__url": "HTTPS://h.example/x"},
    {"ris__allowed_hosts": ["10.0.0.5", "::1"]},
])
def test_validate_accepts(edits):
    C.validate(doc(**edits))


def test_a_save_of_a_broken_floor_never_takes_the_receiver_down():
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        cfg = C.Config(os.path.join(tmp, "config.json"))
        cfg.data["index"]["enabled"] = False
        cfg.data["logs_dir"] = os.path.join(tmp, "logs")
        cfg.data["scp"].update(enabled=True, bind="127.0.0.1", port=free_port())
        cfg.save()
        srv = PacsServer(cfg)
        srv.sync_services()
        try:
            new = copy.deepcopy(cfg.data)
            new["scp"]["min_free_gb"] = "two"
            with pytest.raises(ValueError):
                srv.apply_config(new)
            assert json.load(open(cfg.path))["scp"]["min_free_gb"] != "two"
            assert srv.scp.running
        finally:
            srv.shutdown()


def test_a_post_with_a_non_object_destination_is_400_not_500(tmp_path):
    from test_web_auth import WRITE, make
    _srv, _app, c = make(str(tmp_path))
    d = c.get("/api/config").get_json()
    d["destinations"] = [None]
    r = c.post("/api/config", json=d, headers=WRITE)
    assert r.status_code == 400 and r.get_json().get("error")


def test_config_save_is_private_and_sweeps_planted_temps():
    with tempfile.TemporaryDirectory() as tmp:
        p = os.path.join(tmp, "config.json")
        victim = os.path.join(tmp, "victim")
        open(victim, "w").write("keep")
        os.symlink(victim, p + ".tmp")
        cfg = C.Config(p)
        cfg.save()
        if os.name == "posix":               # Windows has no mode bits to check
            assert stat.S_IMODE(os.stat(p).st_mode) == 0o600
        assert not os.path.lexists(p + ".tmp") and open(victim).read() == "keep"


def test_version_moves_with_every_secret_and_never_contains_one():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = C.Config(os.path.join(tmp, "config.json"))
        seen = {cfg.version()}
        for setter, value in ((lambda v: cfg.web.__setitem__("auth_token", v), "tok-1234567890"),
                              (lambda v: cfg.deid.__setitem__("secret", v), "site-key-abcdef"),
                              (lambda v: cfg.data["notify"]["webhook"].__setitem__("secret", v), "wh-k"),
                              (lambda v: cfg.data["notify"]["smtp"].__setitem__("password", v), "pw")):
            setter(value)
            v = cfg.version()
            assert v not in seen and value not in v
            seen.add(v)


# ====================================================================== RIS
def _store(tmp, **kw):
    from pacs import ris
    return ris.OrderStore(tmp, log=LogBuffer(), **kw)


def test_later_instances_of_a_matched_study_do_not_close_the_next_order():
    with tempfile.TemporaryDirectory() as tmp:
        st = _store(tmp, match_on="accession_or_patient")
        ct = st.add({"accession": "CT1", "patient_id": "P1", "study_uid": "1.2.3"})
        st.add({"accession": "XR1", "patient_id": "P1"})
        assert st.match("CT1", "P1", "1.2.3")["id"] == ct["id"]
        st.close(ct["id"], reason="matched", matched_study="1.2.3")
        assert st.match("CT1", "P1", "1.2.3") is None
        assert st.match("OTHER-ACC", "P1", "1.2.3.4") is None


def test_an_hl7_message_never_merges_into_another_patients_manual_order():
    from pacs import ris
    with tempfile.TemporaryDirectory() as tmp:
        st = _store(tmp)
        manual = st.add({"accession": "1234", "patient_id": "MAN1", "patient_name": "SMITH^ANA"})
        msg = ris.HL7Message("MSH|^~\\&|RIS|H|PACS|H|20260101||ORM^O01|C1|P|2.5\r"
                             "PID|||RIS9||JONES^BOB\rORC|NW|1234\rOBR|1|1234\r")
        order, action = st.apply_hl7(msg, source="hl7")
        assert not (action == "updated" and order["id"] == manual["id"])
        assert st.get(manual["id"])["patient_id"] == "MAN1"


def test_a_corrupt_order_file_is_set_aside_not_overwritten():
    with tempfile.TemporaryDirectory() as tmp:
        st = _store(tmp)
        for i in range(3):
            st.add({"accession": f"A{i}"})
        path = os.path.join(tmp, "orders.json")
        raw = open(path).read()
        open(path, "w").write(raw[:-20])
        st2 = _store(tmp)
        assert st2.load_problem
        st2.add({"accession": "NEW"})
        aside = [n for n in os.listdir(tmp) if n.startswith("orders.json.corrupt")]
        assert aside and open(os.path.join(tmp, aside[0])).read() == raw[:-20]
        open(path, "w").write("[]")
        _store(tmp)                                     # does not raise


def test_the_order_file_is_private():
    if os.name != "posix":
        pytest.skip("POSIX file modes")
    old = os.umask(0o022)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            _store(tmp).add({"accession": "A"})
            assert stat.S_IMODE(os.stat(os.path.join(tmp, "orders.json")).st_mode) & 0o077 == 0
    finally:
        os.umask(old)


def test_a_second_close_never_rewrites_the_first_reason_and_study_uid_is_kept():
    with tempfile.TemporaryDirectory() as tmp:
        st = _store(tmp)
        o = st.add({"accession": "A"})
        uid = st.get(o["id"])["study_uid"]
        st.update(o["id"], {"study_uid": ""})
        assert st.get(o["id"])["study_uid"] == uid
        st.close(o["id"], reason="matched", matched_study="1.2")
        st.close(o["id"], reason="cancelled-here")
        assert st.get(o["id"])["close_reason"] == "matched"
        with pytest.raises(ValueError):
            st.update(o["id"], {"accession": "B"})


def _listener(tmp, **kw):
    from pacs import ris
    lst = ris.RisListener("127.0.0.1", free_port(), _store(tmp), LogBuffer(), **kw)
    lst.start()
    return lst


def test_an_endless_frame_is_cut_off():
    from pacs import ris
    with tempfile.TemporaryDirectory() as tmp:
        lst = _listener(tmp)
        try:
            s = socket.create_connection(("127.0.0.1", lst.port))
            s.sendall(bytes([ris.VT]))
            chunk = b"A" * 65536
            sent = 0
            closed = False
            try:
                while sent < 8 * 1024 * 1024:
                    s.sendall(chunk)
                    sent += len(chunk)
            except OSError:
                closed = True
            s.settimeout(5)
            try:
                data = s.recv(4096)
                closed = closed or data == b"" or b"AR" in data
            except OSError:
                closed = True
            assert closed
            s.close()
        finally:
            lst.stop()


def test_connections_beyond_the_cap_are_refused():
    with tempfile.TemporaryDirectory() as tmp:
        lst = _listener(tmp, max_connections=3)
        socks = []
        try:
            for _ in range(6):
                socks.append(socket.create_connection(("127.0.0.1", lst.port)))
            time.sleep(0.5)
            handlers = [t for t in threading.enumerate() if t.name == "pacs-ris-conn"]
            assert len(handlers) <= 3
        finally:
            for s in socks:
                s.close()
            lst.stop()


def test_an_ipv6_bind_starts_or_refuses_cleanly():
    from pacs import ris
    with tempfile.TemporaryDirectory() as tmp:
        lst = ris.RisListener("::1", free_port(), _store(tmp), LogBuffer())
        try:
            lst.start()
        except OSError:
            pytest.skip("no IPv6 loopback here")
        assert lst.running
        lst.stop()


def test_the_ack_keeps_the_senders_delimiters_and_identity():
    from pacs import ris
    msg = ris.HL7Message("MSH#^~\\&#APP|X#FAC#R#F##20200101#ORM^O01#CTRL|EVIL#T#2.5.1")
    ack = ris.build_ack(msg, "AA")
    msh, msa = [x for x in ack.split("\r") if x]
    assert msh.split("#")[10:12] == ["T", "2.5.1"]
    assert msa.split("#")[2] == "CTRL|EVIL"


# ====================================================================== MWL
def _q(**sps):
    ds = Dataset()
    step = Dataset()
    for k, v in sps.items():
        setattr(step, k, v)
    ds.ScheduledProcedureStepSequence = [step]
    return ds


def test_stand_in_identifiers_can_be_queried_back():
    from pacs.mwl import build_worklist_item, order_matches_query
    o = {"id": "abcdef123456", "patient": "X", "patient_id": "", "status": "open"}
    q = Dataset()
    q.PatientID = build_worklist_item(o).PatientID
    assert order_matches_query(o, q)
    o2 = {"id": "abcdef123457", "accession": "ACC9", "status": "open"}
    q2 = Dataset()
    q2.PatientName = "UNKNOWN^ACC9"
    assert order_matches_query(o2, q2)


def test_brackets_are_literal_in_a_wildcard():
    from pacs.mwl import order_matches_query
    q = Dataset()
    q.PatientName = "[!Z]*"
    assert not order_matches_query({"patient_name": "ADAMS^X"}, q)


def test_legacy_dates_and_start_times_are_honoured():
    from pacs.mwl import order_matches_query
    assert order_matches_query({"scheduled_dt": "2026-10-20T10:00"},
                               _q(ScheduledProcedureStepStartDate="2026.10.20"))
    assert not order_matches_query({"scheduled_dt": "2026-10-20T18:00"},
                                   _q(ScheduledProcedureStepStartDate="20261020",
                                      ScheduledProcedureStepStartTime="080000-120000"))


def test_unassigned_station_reads_as_blank():
    from pacs.mwl import order_matches_query
    assert order_matches_query({"station_aet": "UNASSIGNED", "modality": "CT"},
                               _q(ScheduledStationAETitle="CT1", Modality="CT"))


def test_an_unreadable_order_store_is_c000_not_an_empty_success():
    from pacs.mwl import MwlSCP
    import types

    def broken():
        raise RuntimeError("store gone")
    scp = MwlSCP(aet="MWL", bind="127.0.0.1", port=free_port(), log=LogBuffer(),
                 get_orders=broken)
    ns = types.SimpleNamespace
    ev = ns(identifier=Dataset(), is_cancelled=False,
            assoc=ns(requestor=ns(ae_title="CT1", address="127.0.0.1")))
    assert next(scp._handle_find(ev))[0] == 0xC000
    with pytest.raises(ValueError):
        MwlSCP(aet="MWL", bind="127.0.0.1", port=1, log=LogBuffer(), get_orders=list,
               allowed_aets="CT1")


# ==================================================================== print
def test_a_film_box_asking_for_too_many_images_is_refused_fast():
    from pacs import print_scp as P
    assert P._cell_count("STANDARD\\1000,1000") > P.MAX_CELLS_PER_FILM
    assert P._cell_count("ROW\\100000") > P.MAX_CELLS_PER_FILM
    t0 = time.perf_counter()
    assert P._cell_count("STANDARD\\65535,65535") > P.MAX_CELLS_PER_FILM
    assert time.perf_counter() - t0 < 0.5


def test_a_decompression_bomb_image_box_is_refused_without_allocating_it():
    from pacs.print_scp import _image_from_item
    it = Dataset()
    it.Rows = it.Columns = 65535
    it.BitsAllocated = 16
    it.SamplesPerPixel = 1
    it.PixelData = b"\0\0"
    tracemalloc.start()
    assert _image_from_item(it) is None
    _c, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert peak < 2 * 1024 * 1024
    it2 = Dataset()
    it2.Rows = it2.Columns = 4000
    it2.BitsAllocated = 8
    it2.SamplesPerPixel = 1
    it2.PixelData = b"\0\0"
    assert _image_from_item(it2) is None


def test_untrusted_print_hints_are_dropped_at_the_boundary():
    from pacs.print_scp import _scrape_identity
    ds = Dataset()
    ds.StudyInstanceUID = "not a uid!"
    ds.StudyDate = "2026-1"
    ds.PatientID = "P1"
    out = {}
    _scrape_identity(ds, out)
    assert "study_uid" not in out and "study_date" not in out and out["patient_id"] == "P1"


# ================================================================ emergency
class EServer:
    def __init__(self, cfg):
        self.cfg = cfg
        self.ok = True
        self.stuck = []
        self.retried = []
        self.events = []
        outer = self

        class N:
            def emergency(self, event, status, audience, actor=None):
                outer.events.append((event, dict(status)))
        self.notifier = N()
        self.watcher = type("W", (), {"running": True})()

    def _probe(self, d):
        return (self.ok, "refused" if not self.ok else "ok")

    def stuck_sends(self):
        return {"destinations": [{"name": n} for n in self.stuck]}

    def retry_stuck(self, dest=None):
        self.retried.append(dest)
        return {"reset": 0}

    def start_mwl(self):
        pass

    def stop_mwl(self):
        pass

    def start_watcher(self):
        pass


def _ctl(tmp, **em):
    from pacs.emergency import EmergencyController
    cfg = C.Config(os.path.join(tmp, "config.json"))
    cfg.data["destinations"] = [{"name": "Primary", "host": "h", "port": 104, "aet": "P",
                                 "enabled": True, "emergency_trigger": True}]
    cfg.data["emergency"].update(armed=True, offline_threshold_sec=0, recovery_successes=2, **em)
    srv = EServer(cfg)
    return EmergencyController(srv, LogBuffer()), srv


def test_a_primary_dropping_during_recovery_is_an_outage_again():
    from pacs.emergency import ACTIVE, RECOVERING, TRIGGERED
    with tempfile.TemporaryDirectory() as tmp:
        c, srv = _ctl(tmp)
        c.state = "idle"
        srv.ok = False
        c._tick()
        assert c.state == TRIGGERED
        c.activate()
        srv.ok = True
        c._tick()
        c._tick()
        assert c.state == RECOVERING
        srv.ok = False
        c._tick()
        assert c.state == ACTIVE


def test_a_refused_instance_from_a_reachable_primary_is_not_an_outage():
    from pacs.emergency import IDLE
    with tempfile.TemporaryDirectory() as tmp:
        c, srv = _ctl(tmp)
        c.state = IDLE
        srv.stuck = ["Primary"]
        c._tick()
        assert c.state == IDLE
        assert not [e for e, _ in srv.events if e == "triggered"]


def test_recovery_flushes_once_and_only_the_primary():
    from pacs.emergency import RECOVERING
    with tempfile.TemporaryDirectory() as tmp:
        c, srv = _ctl(tmp)
        c.state = "idle"
        srv.ok = False
        c._tick()
        c.activate()
        srv.ok = True
        srv.stuck = ["Primary"]
        for _ in range(4):
            c._tick()
        assert c.state == RECOVERING
        assert srv.retried == ["Primary"]


def test_a_config_save_does_not_retrigger_or_reactivate():
    from pacs.emergency import ACTIVE, TRIGGERED
    with tempfile.TemporaryDirectory() as tmp:
        c, srv = _ctl(tmp)
        c.state = TRIGGERED
        c.trigger_dest = "Primary"
        c.dismiss(None)
        srv.ok = False
        c.restart_monitor()
        time.sleep(0.3)
        assert c.state == TRIGGERED
        assert not [e for e, _ in srv.events if e == "triggered"]
        assert c.status()["prompt"] is False
        c.stop()
        c2, srv2 = _ctl(tmp, auto_activate=True)
        c2.state = ACTIVE
        c2.activated_by = "Dr X"
        seen = []
        orig_spawn = c2._spawn

        def spy():
            seen.append(c2.active)
            orig_spawn()
        c2._spawn = spy
        srv2.ok = False
        c2.restart_monitor()
        time.sleep(0.3)
        c2.stop()
        assert seen == [True]
        assert c2.activated_by == "Dr X"
        assert not [e for e, _ in srv2.events if e == "activated"]


def test_resolved_names_the_destination_and_says_what_is_true():
    from pacs.emergency import TRIGGERED
    with tempfile.TemporaryDirectory() as tmp:
        c, srv = _ctl(tmp)
        c.state = "idle"
        srv.ok = False
        c._tick()
        c.activate()
        c.resume()
        ev, st = srv.events[-1]
        assert ev == "resolved" and st["trigger_dest"] == "Primary"
        assert st["primary_online"] is False
        n_before = len(srv.events)
        c.resume()                                   # nothing to resolve now
        assert len(srv.events) == n_before


def test_a_trigger_that_clears_before_activation_is_announced():
    with tempfile.TemporaryDirectory() as tmp:
        c, srv = _ctl(tmp)
        c.state = "idle"
        srv.ok = False
        c._tick()
        srv.ok = True
        c._tick()
        c._tick()
        assert [e for e, _ in srv.events][-1] == "resolved"


def test_arm_and_disarm_are_serialised():
    with tempfile.TemporaryDirectory() as tmp:
        c, _srv = _ctl(tmp)
        ts = [threading.Thread(target=c.arm if i % 2 else c.disarm) for i in range(10)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        assert not (c.armed and (c._thread is None or not c._thread.is_alive()))
        c.stop()


# ================================================================= notifier
def _cert(tmp):
    from pacs import tlsutil
    cert, key = os.path.join(tmp, "c.pem"), os.path.join(tmp, "k.pem")
    tlsutil.generate_self_signed(cert, key, ["attacker.invalid"], days=2)
    return cert, key


class FakeSMTP:
    """EHLO/STARTTLS/AUTH just far enough to see what a client would send."""

    def __init__(self, cert, key, implicit=False):
        self.auth = []
        self.tls = False
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.ctx.load_cert_chain(cert, key)
        self.implicit = implicit
        self.t = threading.Thread(target=self._run, daemon=True)
        self.t.start()

    def _run(self):
        try:
            conn, _ = self.sock.accept()
            conn.settimeout(5)
            if self.implicit:
                conn = self.ctx.wrap_socket(conn, server_side=True)
                self.tls = True
            f = conn.makefile("rwb")
            f.write(b"220 fake\r\n"); f.flush()
            while True:
                line = f.readline()
                if not line:
                    return
                cmd = line.strip().upper()
                if cmd.startswith(b"EHLO"):
                    f.write(b"250-fake\r\n250-AUTH PLAIN\r\n250 STARTTLS\r\n"); f.flush()
                elif cmd == b"STARTTLS":
                    f.write(b"220 go\r\n"); f.flush()
                    conn = self.ctx.wrap_socket(conn, server_side=True)
                    self.tls = True
                    f = conn.makefile("rwb")
                elif cmd.startswith(b"AUTH"):
                    self.auth.append((self.tls, line))
                    f.write(b"235 ok\r\n"); f.flush()
                elif cmd.startswith(b"QUIT"):
                    f.write(b"221 bye\r\n"); f.flush()
                    return
                else:
                    f.write(b"250 ok\r\n"); f.flush()
        except Exception:
            return

    def close(self):
        self.sock.close()


def _notifier(smtp=None, webhook=None):
    from pacs.notify import Notifier

    class Cfg:
        notify = {"enabled": True, "smtp": smtp or {"enabled": False},
                  "webhook": webhook or {"enabled": False}}
    return Notifier(Cfg(), log=LogBuffer())


def _person(email="somebody@hospital.test"):
    return U.Profile({"id": U.new_id(), "name": "S", "role": "it", "enabled": True,
                      "email": email, "capabilities": [], "phi_visible": []})


@pytest.mark.parametrize("mode", ["starttls", "ssl"])
def test_smtp_never_accepts_an_untrusted_certificate(mode):
    with tempfile.TemporaryDirectory() as tmp:
        cert, key = _cert(tmp)
        srv = FakeSMTP(cert, key, implicit=(mode == "ssl"))
        try:
            n = _notifier(smtp={"enabled": True, "host": "127.0.0.1", "port": srv.port,
                                "tls": mode, "username": "alerts", "password": "s3cret",
                                "timeout_sec": 3})
            n._send_email({"event": "emergency.triggered", "destination": "P"}, _person())
            assert n.failed == 1 and n.sent == 0
            assert srv.auth == []
        finally:
            srv.close()


@pytest.mark.parametrize("tls", [" starttls", "tsl", "TLS"])
def test_an_unrecognised_tls_mode_never_sends_the_password(tls):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(0.5)
    try:
        n = _notifier(smtp={"enabled": True, "host": "127.0.0.1",
                            "port": listener.getsockname()[1], "tls": tls, "username": "u",
                            "password": "p", "timeout_sec": 2})
        n._send_email({"event": "emergency.triggered"}, _person())
        if tls.strip().lower() == "starttls":
            return                                      # normalised and honoured
        assert n.failed == 1 and "tls" in n.last_error.lower()
        with pytest.raises(socket.timeout):
            listener.accept()
    finally:
        listener.close()


def test_validate_refuses_a_cleartext_login_to_a_remote_relay():
    with pytest.raises(ValueError):
        C.validate(doc(notify__smtp__enabled=True, notify__smtp__host="mail.example",
                       notify__smtp__tls="none", notify__smtp__username="u"))


class _Web:
    def __init__(self, handler):
        self.httpd = HTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def test_a_webhook_redirect_is_a_failure_not_a_delivery():
    hits = []

    class Sink(BaseHTTPRequestHandler):
        def do_GET(self):
            hits.append(self.path)
            self.send_response(200)
            self.end_headers()

        def log_message(self, *a):
            pass
    sink = _Web(Sink)

    class Bounce(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{sink.port}/internal-admin")
            self.end_headers()

        def log_message(self, *a):
            pass
    bounce = _Web(Bounce)
    try:
        n = _notifier(webhook={"enabled": True, "url": f"http://127.0.0.1:{bounce.port}/h",
                               "retries": 0, "timeout_sec": 3})
        n._post_webhook({"event": "x"})
        assert hits == []
        assert n.sent == 0 and n.failed == 1
        assert "302" in n.last_error or "redirect" in n.last_error
    finally:
        sink.close()
        bounce.close()


@pytest.mark.parametrize("url", ["file:///etc/hostname", "ftp://127.0.0.1/x"])
def test_a_non_http_webhook_is_never_opened(url, monkeypatch):
    from pacs import notify
    monkeypatch.setattr(notify._OPENER, "open", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("opened")))
    n = _notifier(webhook={"enabled": True, "url": url, "retries": 0})
    n._post_webhook({"event": "x"})
    assert n.failed == 1 and "http" in n.last_error


def test_a_header_injection_address_is_never_mailed():
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(0.5)
    try:
        n = _notifier(smtp={"enabled": True, "host": "127.0.0.1",
                            "port": listener.getsockname()[1], "tls": "none"})
        n._send_email({"event": "x"}, _person("a@b.c\r\nBcc: x@y"))
        assert n.failed == 1
        with pytest.raises(socket.timeout):
            listener.accept()
    finally:
        listener.close()


# ==================================================================== audit
def _trail(tmp, **kw):
    from pacs.audit import AuditLog
    return AuditLog(os.path.join(tmp, "audit"), **kw).open()


def test_a_torn_last_line_does_not_swallow_the_next_record():
    from pacs.audit import AuditLog
    with tempfile.TemporaryDirectory() as tmp:
        t = _trail(tmp)
        t.record("a")
        t.record("b")
        with open(t.path, "a") as fh:
            fh.write('{"action":"c","seq":3,"pre')
        t2 = AuditLog(os.path.join(tmp, "audit")).open()
        t2.record("d", target="after-crash")
        assert "d" in [r["action"] for r in t2.tail(10)]
        for line in open(t2.path).read().splitlines():
            json.loads(line)
        assert t2.verify()["ok"] is True


def test_a_rotation_failure_stays_visible(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        t = _trail(tmp, max_bytes=10)
        t.record("a")

        def refuse(a, b):
            raise PermissionError("locked")
        monkeypatch.setattr(os, "replace", refuse)
        t.record("b")
        assert t.stats()["rotation_problem"]


def test_the_trail_is_private():
    if os.name != "posix":
        pytest.skip("POSIX file modes")
    old = os.umask(0o022)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            t = _trail(tmp)
            t.record("x")
            assert stat.S_IMODE(os.stat(t.path).st_mode) == 0o600
            assert stat.S_IMODE(os.stat(t.dir).st_mode) == 0o700
    finally:
        os.umask(old)


def test_a_clock_stepping_back_or_a_stray_file_is_not_tampering(monkeypatch):
    import pacs.audit as A
    from datetime import datetime, timezone
    with tempfile.TemporaryDirectory() as tmp:
        t = _trail(tmp, max_bytes=10)
        t.record("a")
        t.record("b")

        class Past(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime(2000, 1, 1, tzinfo=timezone.utc)
        monkeypatch.setattr(A, "datetime", Past)
        t.record("c")
        t.record("d")
        assert t.verify()["ok"] is True
        shutil.copy(t.path, os.path.join(t.dir, "audit-backup.jsonl"))
        assert t.verify()["ok"] is True


def test_a_rotation_between_listing_and_reading_is_invisible(monkeypatch):
    from pacs.audit import AuditLog
    with tempfile.TemporaryDirectory() as tmp:
        t = _trail(tmp, max_bytes=10)
        for x in "abc":
            t.record(x)
        real = AuditLog.files
        fired = []

        def files_then_rotate(self):
            out = real(self)
            if not fired:
                fired.append(1)
                self._rotate_if_needed()
            return out
        monkeypatch.setattr(AuditLog, "files", files_then_rotate)
        assert t.verify()["ok"] is True


def test_records_that_do_not_round_trip_still_verify():
    with tempfile.TemporaryDirectory() as tmp:
        t = _trail(tmp)
        t.record("x", detail={2: "a", 10: "b"})
        t.record("y", _note=1)
        assert t.verify()["ok"] is True


# ====================================================================== SCU
def _plain_scp(supported=None):
    from pynetdicom import AE, AllStoragePresentationContexts, ALL_TRANSFER_SYNTAXES, evt
    from pynetdicom.sop_class import Verification
    got = []
    ae = AE("REMOTE")
    if supported is None:
        for c in AllStoragePresentationContexts:
            ae.add_supported_context(c.abstract_syntax, ALL_TRANSFER_SYNTAXES)
        ae.add_supported_context(Verification)
    else:
        for s in supported:
            ae.add_supported_context(s)
    port = free_port()

    def store(event):
        got.append(str(event.dataset.PatientName))
        return 0
    server = ae.start_server(("127.0.0.1", port), block=False,
                             evt_handlers=[(evt.EVT_C_STORE, store)])
    return server, port, got


def _file(tmp):
    from test_web_auth import _dicom
    return _dicom(os.path.join(tmp, "a.dcm"))


def test_a_tls_destination_is_never_sent_in_plaintext():
    from pacs.scu import Destination, c_store, _tls_args, TLSRequired
    with tempfile.TemporaryDirectory() as tmp:
        server, port, got = _plain_scp()
        try:
            res = c_store(Destination("A", "127.0.0.1", port, "REMOTE", tls=True), _file(tmp),
                          "CARINOSCU", tls_context=None)
            assert res.ok is False and got == []
        finally:
            server.shutdown()
        with pytest.raises(TLSRequired):
            _tls_args(Destination("A", "h", 1, "R", tls=True), None)


def test_the_watcher_fails_closed_on_a_broken_tls_setup():
    from test_routing import FakeLog, make_config, scan, write_dicom
    from pacs.watcher import FolderWatcher
    with tempfile.TemporaryDirectory() as tmp:
        server, port, got = _plain_scp()
        try:
            cfg = make_config(tmp, [{"name": "Archive", "host": "127.0.0.1", "port": port,
                                     "aet": "REMOTE", "tls": True}])
            cfg.data["scu"]["tls_ca"] = "/missing.pem"
            p = write_dicom(os.path.join(cfg.resolved("scu", "watch_dir"), "a.dcm"))
            w = FolderWatcher(cfg, FakeLog())
            scan(w, 3)
            assert got == []
            e = w.state.peek(p)
            assert "Archive" not in e["sent"] and e["fail"].get("Archive")
        finally:
            server.shutdown()


def test_every_scu_call_bounds_the_tcp_connect(monkeypatch):
    from pacs import scu
    from pacs.scu import Destination, c_echo
    seen = []
    real = scu.AE.associate

    def spy(self, *a, **k):
        seen.append(self.connection_timeout)
        return real(self, *a, **k)
    monkeypatch.setattr(scu.AE, "associate", spy)
    c_echo(Destination("x", "127.0.0.1", free_port(), "X"), "CARINOSCU", timeout=2)
    assert seen and seen[0] is not None and seen[0] <= 2


@pytest.mark.parametrize("aet", ["", "A" * 17, "BAD\\AE"])
def test_a_bad_called_ae_title_is_a_result_not_an_exception(aet):
    from pacs.scu import Destination, c_echo, c_store
    with tempfile.TemporaryDirectory() as tmp:
        f = _file(tmp)
        assert c_store(Destination("n", "127.0.0.1", free_port(), aet), f, "CARINOSCU").ok is False
        assert c_echo(Destination("n", "127.0.0.1", free_port(), aet), "CARINOSCU").ok is False


def test_a_storage_only_node_answers_a_test_without_raising():
    from pynetdicom.sop_class import CTImageStorage
    from pacs.scu import Destination, c_echo
    server, port, _got = _plain_scp(supported=[CTImageStorage])
    try:
        res = c_echo(Destination("n", "127.0.0.1", port, "REMOTE"), "CARINOSCU",
                     check_storage=True, timeout=3)
        assert isinstance(res.ok, bool)
    finally:
        server.shutdown()


def test_the_probe_asks_as_the_registered_spelling(monkeypatch):
    from pacs import scu
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        cfg = C.Config(os.path.join(tmp, "config.json"))
        cfg.data["scp"]["enabled"] = False
        cfg.data["index"]["enabled"] = False
        cfg.data["modalities"] = [{"name": "CT", "aet": "CT01", "modality": "CT", "enabled": True}]
        cfg.data["worklist_source"] = {"host": "127.0.0.1", "port": free_port(), "aet": "RIS"}
        srv = PacsServer(cfg)
        asked = []

        def fake(dest, calling_aet, station_aet="", **k):
            asked.append((calling_aet, station_aet))
            return scu.WorklistProbe("q", True, "", [], station_aet, "")
        monkeypatch.setattr(scu, "c_find_worklist", fake)
        srv.probe_worklist("ct01")
        assert asked and all(a[0] == "CT01" for a in asked)
        assert [a[1] for a in asked][:3] == ["CT01"] * 3


# ======================================================= update check, stores
def test_a_clock_stepping_back_does_not_stop_update_checks():
    from pacs.updates import UpdateCheck
    calls = []
    clock = [2e9]
    mono = [1000.0]
    c = UpdateCheck("1.3.0", fetch=lambda cur: calls.append(1) or "v1.3.0",
                    clock=lambda: clock[0], monotonic=lambda: mono[0])
    c._run()
    clock[0] = 1.8e9
    mono[0] += 3 * 86400
    c.maybe_check(True)
    for t in threading.enumerate():
        if t.name == "update-check":
            t.join(5)
    assert len(calls) == 2


def test_caught_rounds_are_private_bounded_and_tolerant():
    from pacs.caught import CaughtStore, MAX_ROUNDS
    old = os.umask(0o022)
    try:
        with tempfile.TemporaryDirectory() as d:
            st = CaughtStore(d)
            st.add_round("CT1", {}, [])
            if os.name == "posix":           # Windows has no mode bits to check
                assert stat.S_IMODE(os.stat(os.path.join(d, "caught.json")).st_mode) & 0o077 == 0
            p = os.path.join(d, "caught.json")
            open(p, "w").write('{"rounds":[{"id":"x","probes":5}]}')
            CaughtStore(d)
            open(p, "w").write("[]")
            CaughtStore(d)
            json.dump({"rounds": [{"id": str(i), "probes": []} for i in range(500)]}, open(p, "w"))
            assert CaughtStore(d).counts()["rounds"] == MAX_ROUNDS
    finally:
        os.umask(old)


# ================================================================ dev peer
def test_a_planted_peer_folder_is_neither_trusted_nor_deleted(tmp_path):
    from pacs import devpeer
    if os.name != "posix":
        pytest.skip("POSIX ownership")
    planted = tmp_path / (devpeer.PEER_PREFIX + "evil")
    planted.mkdir(mode=0o755)
    (planted / devpeer.OWNER_FILE).write_text("1")
    cfg = C.Config(str(tmp_path / "config.json"))
    cfg.data["destinations"] = [{"name": "Dev peer CARINOPEERAB12", "host": "127.0.0.1",
                                 "port": 51000, "aet": "CARINOPEERAB12", "enabled": True,
                                 "ephemeral": True}]
    cfg.save()
    devpeer.sweep_stale(tmp_root=str(tmp_path), cfg=cfg)
    assert cfg.destinations == []
    assert planted.is_dir()


def test_a_folder_naming_our_own_pid_is_litter(tmp_path):
    from pacs import devpeer
    d = tmp_path / (devpeer.PEER_PREFIX + "x")
    d.mkdir(mode=0o700)
    (d / devpeer.OWNER_FILE).write_text(str(os.getpid()))
    (d / "config.json").write_text(json.dumps({"scp": {"aet": "CARINOPEERAB12"}}))
    cfg = C.Config(str(tmp_path / "config.json"))
    cfg.data["destinations"] = [{"name": "Dev peer CARINOPEERAB12", "host": "127.0.0.1",
                                 "port": 51000, "aet": "CARINOPEERAB12", "enabled": True,
                                 "ephemeral": True}]
    cfg.save()
    assert devpeer.sweep_stale(tmp_root=str(tmp_path), cfg=cfg) == [str(d)]
    assert cfg.destinations == []


def test_a_peer_title_matches_exactly():
    from pacs import devpeer
    assert devpeer._names_a_live_peer({"name": "Dev peer CARINOPEERAB12", "aet": "X"},
                                      {"AB1"}) is False
    assert devpeer._names_a_live_peer({"name": "Dev peer CARINOPEERAB12", "aet": "X"},
                                      {"CARINOPEERAB12"}) is True


# ====================================================== container + desktop
sys.path.insert(0, os.path.join(ROOT, "docker"))


def _entry(monkeypatch, tmp, **env):
    import importlib
    for k in ("PACS_SERVICES", "PACS_WEB_PORT", "PACS_WEB_HOST", "PACS_AUTH_TOKEN",
              "PACS_AUTH_TOKEN_FILE"):
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    import entrypoint
    importlib.reload(entrypoint)
    return entrypoint


def test_a_failed_first_boot_is_still_a_first_boot(monkeypatch, tmp_path):
    p = str(tmp_path / "config.json")
    ep = _entry(monkeypatch, tmp_path, PACS_SERVICES="scp,mlw")
    with pytest.raises(SystemExit):
        ep.prepare_config(p)
    ep = _entry(monkeypatch, tmp_path, PACS_SERVICES="scp,mwl")
    ep.prepare_config(p)
    d = json.load(open(p))
    assert d["web"]["host"] == "0.0.0.0" and d["web"]["auth_token"]
    assert d["scp"]["enabled"] and d["mwl"]["enabled"]


def test_an_empty_config_gets_the_operator_message(monkeypatch, tmp_path):
    p = tmp_path / "config.json"
    p.write_text("")
    ep = _entry(monkeypatch, tmp_path)
    with pytest.raises(SystemExit):
        ep.prepare_config(str(p))


def test_the_entrypoint_never_follows_a_planted_temp(monkeypatch, tmp_path):
    p = tmp_path / "config.json"
    victim = tmp_path / "victim.txt"
    victim.write_text("keep")
    os.symlink(str(victim), str(p) + ".tmp")
    ep = _entry(monkeypatch, tmp_path, PACS_AUTH_TOKEN="env-token-value-abcdef")
    synced = []
    real = os.fsync
    monkeypatch.setattr(os, "fsync", lambda fd: (synced.append(fd), real(fd))[1])
    ep.prepare_config(str(p))
    assert victim.read_text() == "keep"
    assert not os.path.islink(p)
    if os.name == "posix":                   # Windows has no mode bits to check
        assert stat.S_IMODE(os.stat(p).st_mode) == 0o600
    assert synced


def test_the_healthcheck_probes_the_configured_address_with_a_real_header():
    import healthcheck
    s = socket.socket()
    try:
        s.bind(("127.0.0.2", 0))
    except OSError:
        pytest.skip("no 127.0.0.2 on this host")
    s.listen(1)
    try:
        healthcheck.check_listener({"enabled": True, "port": s.getsockname()[1],
                                    "bind": "127.0.0.2"}, "Storage SCP")
    finally:
        s.close()
    src = open(os.path.join(ROOT, "docker", "healthcheck.py")).read()
    assert "X-Carino-Token" in src and "X-Auth-Token" not in src


def _node(js):
    if not shutil.which("node"):
        pytest.skip("node is not installed")
    out = subprocess.run(["node", "-e", js], capture_output=True, text=True, timeout=30,
                         cwd=os.path.join(ROOT, "desktop"))
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_the_desktop_shell_builds_urls_for_every_bind():
    got = _node("""
const h = require('./hosts'); const path = require('path');
const r = {};
for (const host of ['::1', '::', ' 127.0.0.1 ', '0.0.0.0', '', '10.0.0.5']) {
  r[host] = {url: h.serverUrlFor('http', host, 8042), bind: h.bindHostFor(host)};
}
r.expand = h.expandUser('~svc/tls/c.pem', '/home/me', path.posix);
r.home = h.expandUser('~/c.pem', '/home/me', path.posix);
r.win = h.expandUser('~svc\\\\tls\\\\c.pem', 'C:\\\\Users\\\\me', path.win32);
console.log(JSON.stringify(r));
""")
    assert got["::1"]["url"] == "http://[::1]:8042/"
    assert got["::"]["url"] in ("http://[::1]:8042/", "http://127.0.0.1:8042/")
    assert got[" 127.0.0.1 "]["url"] == "http://127.0.0.1:8042/"
    assert got["0.0.0.0"]["url"] == "http://127.0.0.1:8042/" and got["0.0.0.0"]["bind"] == "0.0.0.0"
    assert got[""]["url"] == "http://127.0.0.1:8042/" and got[""]["bind"] == ""
    assert got["expand"] == "/home/svc/tls/c.pem" and got["home"] == "/home/me/c.pem"
    assert got["win"] == "C:\\Users\\svc\\tls\\c.pem"


def test_the_desktop_engine_is_not_forced_onto_loopback():
    src = open(os.path.join(ROOT, "desktop", "main.js"), encoding="utf-8").read()
    assert '"--host", host, "--port"' not in src
    assert "did-create-window" in src


def test_a_move_destination_without_an_aet_still_validates():
    from pacs.config import DEFAULTS, _deep_merge, validate
    with tempfile.TemporaryDirectory() as tmp:
        doc = _deep_merge(DEFAULTS, {"qr": {"move_destinations": {
            "WS1": {"host": "10.0.0.7", "port": 104, "aet": ""}}}})
        validate(doc, base_dir=tmp)          # dialled as its own key, as before
        doc["qr"]["move_destinations"]["WS1"]["aet"] = "A\\B"
        with pytest.raises(ValueError):
            validate(doc, base_dir=tmp)


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
