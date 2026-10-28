"""Regression tests for the 2026-10 review of the forwarder: backoff, the
per-pass circuit breaker, the stability gate, links and hidden folders, the
archive/delete safety rules, the send-state ledger and hold-and-forward.

Runs under pytest, or directly:  python3 tests/test_review_watcher.py
"""

from __future__ import annotations

import errno
import json
import os
import shutil
import stat
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest                                              # noqa: E402

from pacs import watcher as W                              # noqa: E402
from pacs.scu import SendResult                            # noqa: E402
from pacs.state import SendState                           # noqa: E402
from pacs.watcher import FolderWatcher, _backoff           # noqa: E402
from test_routing import (FakeLog, FakeStore, dest, fake_store, make_config,  # noqa: E402
                          scan, write_dicom)


class LinkStore(FakeStore):
    """A store whose named nodes fail at the LINK level (no association)."""

    def __call__(self, dst, filepath, calling_aet, timeout=30, tls_context=None):
        base = os.path.basename(filepath)
        self.calls.append((dst.name, dst.host, dst.port, base))
        if dst.name in self.fail:
            return SendResult(False, "connection refused", link=True)
        return SendResult(True, "stored")


def watcher(cfg):
    return FolderWatcher(cfg, FakeLog())


def out_dir(cfg):
    return cfg.resolved("scu", "watch_dir")


# ------------------------------------------------------------------- backoff
def test_backoff_never_overflows():
    assert _backoff(1024, 3) == 300.0
    assert _backoff(1025, 3) == 300.0
    assert _backoff(10 ** 6, 3) == 300.0


def test_a_node_down_for_a_long_weekend_does_not_halt_the_pass():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Dead", "10.0.0.1"), dest("Live", "10.0.0.2")])
        w = watcher(cfg)
        a = write_dicom(os.path.join(out_dir(cfg), "a", "1.dcm"))
        store = FakeStore(fail={"Dead"})
        with fake_store(store):
            scan(w, 2)
            e = w.state.peek(a)
            e["fail"]["Dead"].update({"attempts": 1024, "next_try": 0})
            write_dicom(os.path.join(out_dir(cfg), "c", "3.dcm"))
            scan(w, 3)
        assert ("Live", "10.0.0.2", 104, "3.dcm") in store.calls


def test_one_dead_node_costs_one_attempt_per_pass_not_one_per_file():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Dead", "10.0.0.1"), dest("Live", "10.0.0.2")])
        for i in range(50):
            write_dicom(os.path.join(out_dir(cfg), f"s{i}", "x.dcm"))
        w = watcher(cfg)
        store = LinkStore(fail={"Dead"})
        with fake_store(store):
            scan(w, 1)                       # sizes recorded, nothing sent
            store.calls.clear()
            scan(w, 1)                       # the sending pass
        dead = [c for c in store.calls if c[0] == "Dead"]
        live = [c for c in store.calls if c[0] == "Live"]
        assert len(dead) == 1, len(dead)
        assert len(live) == 50


# --------------------------------------------------------------- stability
def test_a_preallocated_file_is_not_sent_while_its_bytes_still_change():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Live", "10.0.0.2")])
        final = write_dicom(os.path.join(tmp, "src", "full.dcm"))
        data = open(final, "rb").read()
        target = os.path.join(out_dir(cfg), "full.dcm")
        os.makedirs(out_dir(cfg), exist_ok=True)
        with open(target, "wb") as fh:
            fh.truncate(len(data))
        with open(target, "r+b") as fh:
            fh.write(data[:200])
        os.utime(target, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
        w = watcher(cfg)
        store = FakeStore()
        sent_payloads = []

        def recording(dst, filepath, *a, **k):
            sent_payloads.append(open(filepath, "rb").read())
            return store(dst, filepath, *a, **k)
        with fake_store(recording):
            scan(w, 1)
            with open(target, "r+b") as fh:
                fh.seek(200)
                fh.write(data[200:])
            os.utime(target, ns=(1_700_000_001_000_000_000, 1_700_000_001_000_000_000))
            scan(w, 1)
            assert sent_payloads == [], "sent while the bytes were still changing"
            scan(w, 1)
        assert sent_payloads == [data]


# ------------------------------------------------------- links, hidden dirs
def test_a_symlink_in_the_outgoing_folder_is_never_forwarded():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Live", "10.0.0.2")])
        secret = write_dicom(os.path.join(tmp, "storage", "secret.dcm"))
        os.makedirs(out_dir(cfg), exist_ok=True)
        os.symlink(secret, os.path.join(out_dir(cfg), "link.dcm"))
        w = watcher(cfg)
        store = FakeStore()
        with fake_store(store):
            scan(w, 2)
        assert store.calls == []
        assert any("symlink" in m for m in w.log.warnings)


def test_a_hidden_staging_folder_is_neither_sent_nor_archived():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Live", "10.0.0.2")], on_success="move")
        p = write_dicom(os.path.join(out_dir(cfg), ".staging", "x.dcm"))
        w = watcher(cfg)
        store = FakeStore()
        with fake_store(store):
            scan(w, 4)
        assert store.calls == []
        assert os.path.exists(p)


def test_an_idle_pass_does_not_rewrite_the_sidecar():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Live", "10.0.0.2")], on_success="keep")
        write_dicom(os.path.join(out_dir(cfg), "a.dcm"))
        w = watcher(cfg)
        with fake_store(FakeStore()):
            scan(w, 3)
            before = os.stat(w.state.path).st_mtime_ns
            time.sleep(0.02)
            scan(w, 1)
        assert os.stat(w.state.path).st_mtime_ns == before


def test_a_stop_mid_send_resumes_after_a_restart_and_never_archives_early():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("A", "10.0.0.1"), dest("B", "10.0.0.2")], on_success="move")
        p = write_dicom(os.path.join(out_dir(cfg), "S1", "a.dcm"))
        w = watcher(cfg)
        store = FakeStore()

        def stopping(dst, filepath, *a, **k):
            w._stop.set()
            return store(dst, filepath, *a, **k)
        with fake_store(stopping):
            scan(w, 2)
        assert os.path.exists(p)
        w.state.save()
        w2 = watcher(cfg)
        store2 = FakeStore()
        with fake_store(store2):
            scan(w2, 3)
        names = {c[0] for c in store2.calls}
        assert "B" in names or {"A", "B"} <= names
        assert not os.path.exists(p)          # archived only after both took it


# --------------------------------------------------------- archive safety
def test_a_half_copied_instance_is_not_deleted_with_its_study():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Live", "10.0.0.2")], on_success="delete")
        write_dicom(os.path.join(out_dir(cfg), "S1", "a.dcm"))
        w = watcher(cfg)
        with fake_store(FakeStore()):
            scan(w, 1)
            with open(os.path.join(out_dir(cfg), "S1", "b.dcm"), "wb") as fh:
                fh.write(b"\0" * 100)
            scan(w, 1)
        assert os.path.exists(os.path.join(out_dir(cfg), "S1", "b.dcm"))


def test_a_copy_tools_hidden_temp_file_survives_the_delete():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Live", "10.0.0.2")], on_success="delete")
        write_dicom(os.path.join(out_dir(cfg), "S1", "a.dcm"))
        write_dicom(os.path.join(out_dir(cfg), "S1", ".b.dcm.Xy12"))
        w = watcher(cfg)
        with fake_store(FakeStore()):
            scan(w, 3)
        assert os.path.exists(os.path.join(out_dir(cfg), "S1", ".b.dcm.Xy12"))


def test_an_instance_arriving_during_the_siphon_is_not_deleted_unsent(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Live", "10.0.0.2")], on_success="delete")
        write_dicom(os.path.join(out_dir(cfg), "S1", "a.dcm"))
        w = watcher(cfg)
        real = w._siphon_pending
        late = os.path.join(out_dir(cfg), "S1", "late.dcm")

        def arriving(*a, **k):
            if not os.path.exists(late):
                write_dicom(late)
            return real(*a, **k)
        monkeypatch.setattr(w, "_siphon_pending", arriving)
        with fake_store(FakeStore()):
            scan(w, 2)
        assert os.path.exists(late)


def test_a_report_that_cannot_be_queued_is_not_deleted(monkeypatch):
    from pacs import ingest
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Live", "10.0.0.2")], on_success="delete")
        write_dicom(os.path.join(out_dir(cfg), "S1", "a.dcm"))
        rep = os.path.join(out_dir(cfg), "S1", "report.pdf")
        with open(rep, "wb") as fh:
            fh.write(b"%PDF-1.4\n" + b"0" * 64)

        def full(*a, **k):
            raise OSError(28, "No space left on device")
        monkeypatch.setattr(ingest, "stage_pending", full)
        w = watcher(cfg)
        with fake_store(FakeStore()):
            scan(w, 3)
        assert os.path.exists(rep)


def test_a_report_is_not_deleted_when_there_is_no_pending_folder():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Live", "10.0.0.2")], on_success="delete")
        cfg.data["scu"]["pending_dir"] = ""
        write_dicom(os.path.join(out_dir(cfg), "S1", "a.dcm"))
        rep = os.path.join(out_dir(cfg), "S1", "report.pdf")
        with open(rep, "wb") as fh:
            fh.write(b"%PDF-1.4\n" + b"0" * 64)
        w = watcher(cfg)
        with fake_store(FakeStore()):
            scan(w, 3)
        assert os.path.exists(rep)


def test_move_never_follows_a_linked_folder_out_of_the_watch_tree():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Live", "10.0.0.2")], on_success="move")
        ext = os.path.join(tmp, "ext")
        unsent = write_dicom(os.path.join(ext, "unsent.dcm"))
        write_dicom(os.path.join(out_dir(cfg), "S1", "a.dcm"))
        os.symlink(ext, os.path.join(out_dir(cfg), "S1", "linked"))
        w = watcher(cfg)
        with fake_store(FakeStore()):
            scan(w, 3)
        assert os.path.exists(unsent)
        sent = cfg.resolved("scu", "sent_dir")
        assert not os.path.exists(os.path.join(sent, "S1", "linked", "unsent.dcm"))


def test_delete_with_a_linked_folder_leaves_the_target_untouched():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Live", "10.0.0.2")], on_success="delete")
        ext = os.path.join(tmp, "ext")
        target = write_dicom(os.path.join(ext, "keep.dcm"))
        write_dicom(os.path.join(out_dir(cfg), "S1", "a.dcm"))
        os.symlink(ext, os.path.join(out_dir(cfg), "S1", "linked"))
        w = watcher(cfg)
        with fake_store(FakeStore()):
            scan(w, 3)
        assert os.path.exists(target)


def test_a_cross_device_move_that_fails_half_way_leaves_no_truncated_twin(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Live", "10.0.0.2")], on_success="move")
        src = write_dicom(os.path.join(out_dir(cfg), "S1", "a.dcm"))
        size = os.path.getsize(src)
        real = shutil.move
        state = {"failed": False}

        def flaky(s, d, *a, **k):
            if not state["failed"]:
                state["failed"] = True
                with open(s, "rb") as fh, open(d, "wb") as out:
                    out.write(fh.read()[: size // 2])
                raise OSError(28, "No space left on device")
            return real(s, d, *a, **k)
        monkeypatch.setattr(W.shutil, "move", flaky)
        w = watcher(cfg)
        with fake_store(FakeStore()):
            scan(w, 4)
        landed = os.path.join(cfg.resolved("scu", "sent_dir"), "S1")
        assert sorted(os.listdir(landed)) == ["a.dcm"]
        assert os.path.getsize(os.path.join(landed, "a.dcm")) == size


def test_a_partial_move_leaves_no_state_for_files_already_gone(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Live", "10.0.0.2")], on_success="move")
        paths = [write_dicom(os.path.join(out_dir(cfg), "S1", f"i{i}.dcm")) for i in range(3)]
        real = shutil.move
        n = {"calls": 0}

        def eio_on_second(s, d, *a, **k):
            n["calls"] += 1
            if n["calls"] == 2:
                raise OSError(errno.EIO, "I/O error")
            return real(s, d, *a, **k)
        monkeypatch.setattr(W.shutil, "move", eio_on_second)
        w = watcher(cfg)
        with fake_store(FakeStore()):
            scan(w, 2)
        for p in paths:
            if not os.path.exists(p):
                assert w.state.peek(p) is None, p


# ------------------------------------------------------------- send state
def _hammer(st, entry, stop):
    i = 0
    while not stop.is_set():
        entry["fail"][f"k{i}"] = {"next_try": 1}
        entry["fail"].pop(f"k{i - 1}", None)
        i += 1


@pytest.mark.parametrize("reader", ["save", "all_entries", "clear_backoff"])
def test_the_ledger_survives_concurrent_mutation(reader):
    with tempfile.TemporaryDirectory() as tmp:
        f = os.path.join(tmp, "x.dcm")
        open(f, "wb").write(b"x")
        st = SendState(os.path.join(tmp, "state.json"))
        e = st.get(f, 1, os.path.getmtime(f))
        e["fail"] = {}
        stop = threading.Event()
        t = threading.Thread(target=_hammer, args=(st, e, stop))
        old = sys.getswitchinterval()
        sys.setswitchinterval(1e-6)
        t.start()
        try:
            deadline = time.time() + 1.5
            while time.time() < deadline:
                if reader == "save":
                    st._dirty = True
                    st.save()
                    json.load(open(st.path))
                elif reader == "all_entries":
                    st.all_entries()
                else:
                    assert st.clear_backoff() >= 0
        finally:
            stop.set()
            t.join()
            sys.setswitchinterval(old)


def test_the_ledgers_are_private(monkeypatch):
    if os.name != "posix":
        pytest.skip("POSIX file modes")
    from pacs.handsent import HandSends
    old = os.umask(0o022)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            f = os.path.join(tmp, "x.dcm")
            open(f, "wb").write(b"x")
            st = SendState(os.path.join(tmp, "state.json"))
            st.pin(f, ["PRIMARY"])
            st.save()
            assert stat.S_IMODE(os.stat(st.path).st_mode) == 0o600
            hs = HandSends(os.path.join(tmp, "hand.json"))
            hs.record("k", "Archive", ok=1, fail=0)
            assert stat.S_IMODE(os.stat(os.path.join(tmp, "hand.json")).st_mode) == 0o600
    finally:
        os.umask(old)


def test_a_non_object_ledger_is_quarantined_not_fatal():
    with tempfile.TemporaryDirectory() as tmp:
        p = os.path.join(tmp, "state.json")
        open(p, "w").write("[]")
        st = SendState(p)
        e = st.get(os.path.join(tmp, "f"), 1, 1.0)
        assert e["sent"] == []
        assert [n for n in os.listdir(tmp) if n.startswith("state.json.corrupt")]
        assert st.load_problem


def test_a_truncated_ledger_is_kept_aside_not_overwritten():
    with tempfile.TemporaryDirectory() as tmp:
        f = os.path.join(tmp, "x.dcm")
        open(f, "wb").write(b"x")
        p = os.path.join(tmp, "state.json")
        st = SendState(p)
        st.pin(f, ["PRIMARY"])
        st.save()
        raw = open(p).read()
        open(p, "w").write(raw[: len(raw) // 2])
        st2 = SendState(p)
        st2.get(f, 1, os.path.getmtime(f))
        st2.save()
        aside = [n for n in os.listdir(tmp) if n.startswith("state.json.corrupt")]
        assert aside and open(os.path.join(tmp, aside[0])).read() == raw[: len(raw) // 2]


def test_save_fsyncs_before_the_rename(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        st = SendState(os.path.join(tmp, "state.json"))
        st.get(os.path.join(tmp, "f"), 1, 1.0)
        order = []
        real_fsync, real_replace = os.fsync, os.replace
        monkeypatch.setattr(os, "fsync", lambda fd: (order.append("fsync"), real_fsync(fd))[1])
        monkeypatch.setattr(os, "replace", lambda a, b: (order.append("replace"), real_replace(a, b))[1])
        st.save()
        assert "fsync" in order and order.index("fsync") < order.index("replace")


def test_a_pin_survives_a_crash_before_the_next_save():
    with tempfile.TemporaryDirectory() as tmp:
        f = os.path.join(tmp, "x.dcm")
        open(f, "wb").write(b"x")
        p = os.path.join(tmp, "state.json")
        SendState(p).pin(f, ["PRIMARY"], durable=True)       # never saved
        assert SendState(p).peek(f)["pin"] == ["PRIMARY"]


def test_a_discarded_entry_is_not_resurrected_by_a_late_put():
    with tempfile.TemporaryDirectory() as tmp:
        f = os.path.join(tmp, "x.dcm")
        open(f, "wb").write(b"x")
        st = SendState(os.path.join(tmp, "state.json"))
        e = st.get(f, 1, os.path.getmtime(f))
        os.remove(f)
        st.drop(f)
        st.put(f, e)
        assert st.peek(f) is None


# --------------------------------------------------------- hold-and-forward
def _held_server(tmp, **extra):
    from pacs.server import PacsServer
    cfg = make_config(tmp, [dest("Primary", "10.0.0.1", emergency_trigger=True)], **extra)
    return cfg, PacsServer(cfg)


def test_a_corrected_resend_refreshes_the_held_copy():
    with tempfile.TemporaryDirectory() as tmp:
        cfg, srv = _held_server(tmp, on_success="keep")
        src = write_dicom(os.path.join(cfg.resolved("scp", "storage_dir"), "x.dcm"),
                          study_desc="WRONG")
        srv._queue_for_forward(src)
        held = os.path.join(out_dir(cfg), "x.dcm")
        write_dicom(src, study_desc="CORRECTED PLUS")
        os.utime(src, (time.time() + 5, time.time() + 5))
        srv._queue_for_forward(src)
        assert open(held, "rb").read() == open(src, "rb").read()


def test_a_truncated_leftover_is_replaced_whole():
    with tempfile.TemporaryDirectory() as tmp:
        cfg, srv = _held_server(tmp)
        src = write_dicom(os.path.join(cfg.resolved("scp", "storage_dir"), "x.dcm"))
        os.makedirs(out_dir(cfg), exist_ok=True)
        held = os.path.join(out_dir(cfg), "x.dcm")
        open(held, "wb").write(open(src, "rb").read()[:200])
        srv._queue_for_forward(src)
        assert open(held, "rb").read() == open(src, "rb").read()


def test_a_copy_that_fails_half_way_leaves_nothing_at_the_held_name(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        cfg, srv = _held_server(tmp)
        src = write_dicom(os.path.join(cfg.resolved("scp", "storage_dir"), "x.dcm"))
        real = shutil.copyfileobj

        def half(fs, fd, *a, **k):
            fd.write(fs.read(100))
            raise OSError(28, "No space left on device")
        monkeypatch.setattr(shutil, "copyfileobj", half)
        srv._queue_for_forward(src)
        monkeypatch.setattr(shutil, "copyfileobj", real)
        assert not os.path.exists(os.path.join(out_dir(cfg), "x.dcm"))
        assert any("could not queue" in m for _l, m, _k in
                   [(e["level"], e["message"], None) for e in srv.log.tail(50)])
        srv._queue_for_forward(src)
        assert open(os.path.join(out_dir(cfg), "x.dcm"), "rb").read() == open(src, "rb").read()


def test_pinning_does_not_rewrite_the_ledger_per_instance():
    with tempfile.TemporaryDirectory() as tmp:
        cfg, srv = _held_server(tmp)
        st = srv.watcher.state
        for i in range(20000):
            st._data[f"/x/{i}.dcm"] = {"sent": [], "size": 1, "mtime": 1.0}
        st._dirty = True
        st.save()
        before = os.stat(st.path).st_mtime_ns
        src = write_dicom(os.path.join(cfg.resolved("scp", "storage_dir"), "x.dcm"))
        t0 = time.perf_counter()
        srv._queue_for_forward(src)
        elapsed = time.perf_counter() - t0
        assert os.stat(st.path).st_mtime_ns == before, "the whole ledger was rewritten"
        assert elapsed < 0.5


def test_the_no_primary_warning_comes_back_for_a_new_outage():
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1")])
        srv = PacsServer(cfg)
        src = write_dicom(os.path.join(cfg.resolved("scp", "storage_dir"), "x.dcm"))

        def warnings():
            return [e for e in srv.log.tail(200) if "no primary to hold FOR" in e["message"]]
        srv.emergency.since = 100.0
        srv._queue_for_forward(src)
        srv._queue_for_forward(src)
        assert len(warnings()) == 1
        srv.emergency.since = 200.0
        srv._queue_for_forward(src)
        assert len(warnings()) == 2


def test_no_emergency_means_nothing_is_held():
    with tempfile.TemporaryDirectory() as tmp:
        cfg, srv = _held_server(tmp)
        src = write_dicom(os.path.join(cfg.resolved("scp", "storage_dir"), "x.dcm"))
        from pydicom import dcmread
        srv._reconcile_study(dcmread(src), src)
        assert not os.path.exists(out_dir(cfg)) or os.listdir(out_dir(cfg)) == []


def test_a_received_file_already_in_the_watch_folder_is_left_alone():
    with tempfile.TemporaryDirectory() as tmp:
        cfg, srv = _held_server(tmp)
        src = write_dicom(os.path.join(out_dir(cfg), "x.dcm"))
        srv._queue_for_forward(src)
        assert os.path.exists(src)


def test_a_hold_failure_does_not_stop_order_matching(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        cfg, srv = _held_server(tmp)
        src = write_dicom(os.path.join(cfg.resolved("scp", "storage_dir"), "x.dcm"))
        from pydicom import dcmread
        ds = dcmread(src)
        ds.AccessionNumber = "ACC-1"
        order = srv.orders.add({"accession": "ACC-1", "patient_id": "P1"})
        srv.emergency.state = "active"

        def boom(*a, **k):
            raise RuntimeError("ledger exploded")
        monkeypatch.setattr(srv.watcher.state, "pin", boom)
        srv._reconcile_study(ds, src)
        assert srv.orders.get(order["id"])["status"] == "closed"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
