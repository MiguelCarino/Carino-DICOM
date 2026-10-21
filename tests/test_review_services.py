"""Regression tests for the 2026-10 review of the pending-review store, the
study browser's file operations and the Stuck panel's actions.

Runs under pytest, or directly:  python3 tests/test_review_services.py
"""

from __future__ import annotations

import copy
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest                                              # noqa: E402

from pacs import history, ingest                           # noqa: E402
from pacs.web import create_app                            # noqa: E402
from test_history import write_instance                    # noqa: E402
from test_routing import FakeLog, write_dicom              # noqa: E402
from test_stuck_actions import NODE_A, WRITE, _engine, _queue  # noqa: E402
from test_web_auth import make                             # noqa: E402

PDF = b"%PDF-1.4\n" + b"0" * 64


# ------------------------------------------------------------ pending store
def test_a_link_beside_a_study_is_never_a_convertible(tmp_path):
    from pacs.watcher import FolderWatcher
    from test_routing import make_config
    secret = tmp_path / "id_rsa"
    secret.write_bytes(b"TOPSECRET")
    study = tmp_path / "out" / "study1"
    study.mkdir(parents=True)
    os.symlink(str(secret), str(study / "report.pdf"))
    w = FolderWatcher(make_config(str(tmp_path), []), FakeLog())
    assert w._convertibles_under(str(study)) == []
    with pytest.raises(ValueError):
        ingest.stage_pending(str(tmp_path / "pending"), str(study / "report.pdf"), {}, "pdf")


def test_a_linked_payload_is_neither_previewed_nor_approved(tmp_path):
    pending = tmp_path / "pending"
    src = tmp_path / "r.pdf"
    src.write_bytes(PDF)
    pid = ingest.stage_pending(str(pending), str(src), {"patient": "X", "patient_id": "1"}, "pdf")
    entry = pending / pid
    payload = next(p for p in entry.iterdir() if p.name != "meta.json")
    payload.unlink()
    outside = tmp_path / "secret.pdf"
    outside.write_bytes(b"%PDF-1.4 TOPSECRET")
    os.symlink(str(outside), str(payload))
    assert ingest.preview_path(str(pending), pid) is None
    out = tmp_path / "out"
    with pytest.raises(ValueError):
        ingest.approve_pending(str(pending), pid, {"patient": "A^B", "patient_id": "1"}, str(out))
    assert not out.exists() or not list(out.iterdir())


def test_kind_comes_from_the_bytes_not_the_name(tmp_path):
    fake = tmp_path / "x.pdf"
    fake.write_bytes(b"not a pdf at all")
    assert ingest.detect_kind(str(fake)) is None
    with pytest.raises(ValueError):
        ingest.build_encapsulated_pdf(b"not a pdf", {})


def test_a_preview_is_served_as_what_it_is(tmp_path):
    srv, _app, c = make(str(tmp_path))
    pending = tmp_path / "pending"
    evil = tmp_path / "evil.html"
    evil.write_bytes(b'%PDF-1.4\n<script>fetch("/api/config")</script>')
    pid = ingest.stage_pending(str(pending), str(evil), {}, "pdf")
    srv.pending_preview = lambda p: ingest.preview_path(str(pending), p)
    r = c.get(f"/api/pending/preview?id={pid}")
    assert r.status_code == 200
    assert r.headers["Content-Type"].startswith("application/pdf")
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert "sandbox" in r.headers.get("Content-Security-Policy", "")


@pytest.mark.parametrize("name", ["meta.json", "META.JSON"])
def test_a_file_named_like_the_sidecar_keeps_its_bytes(tmp_path, name):
    pending = tmp_path / "pending"
    src = tmp_path / name
    src.write_bytes(b"%PDF-1.4 the only copy of the report")
    pid = ingest.stage_pending(str(pending), str(src), {}, "pdf")
    meta = json.loads((pending / pid / "meta.json").read_text())
    assert meta["filename"] == name
    out = ingest.approve_pending(str(pending), pid, {"patient": "A^B", "patient_id": "1"},
                                 str(tmp_path / "out"))
    from pydicom import dcmread
    assert bytes(dcmread(out).EncapsulatedDocument).startswith(b"%PDF")


def test_a_sidecar_is_written_whole_or_not_at_all(tmp_path, monkeypatch):
    pending = tmp_path / "pending"
    src = tmp_path / "r.pdf"
    src.write_bytes(PDF)

    def boom(*a, **k):
        raise RuntimeError("midway")
    monkeypatch.setattr(ingest.json, "dumps", boom)
    with pytest.raises(RuntimeError):
        ingest.stage_pending(str(pending), str(src), {}, "pdf")
    assert not [p for p in pending.rglob("meta.json")]


@pytest.mark.parametrize("pid", ["", ".", "..", "a/..", "../x", "/etc", "a\x00b"])
def test_an_entry_id_never_escapes_the_store(tmp_path, pid):
    with pytest.raises(ValueError):
        ingest._safe_entry_dir(str(tmp_path), pid)


def test_a_linked_entry_folder_is_refused(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    store = tmp_path / "pending"
    store.mkdir()
    os.symlink(str(outside), str(store / "abc"))
    with pytest.raises(ValueError):
        ingest._safe_entry_dir(str(store), "abc")


# ------------------------------------------------------------ study browser
def _srv(tmp):
    from pacs.config import Config
    from pacs.server import PacsServer
    cfg = Config(os.path.join(tmp, "config.json"))
    cfg.data["scp"]["enabled"] = False
    cfg.data["index"]["enabled"] = False
    cfg.save()
    return PacsServer(cfg)


def test_a_file_linked_out_of_the_root_is_never_handed_out(tmp_path):
    srv = _srv(str(tmp_path))
    root = srv.cfg.resolved("scp", "storage_dir")
    study = os.path.join(root, "P", "S")
    write_dicom(os.path.join(study, "SE", "a.dcm"))
    secret = write_dicom(str(tmp_path / "elsewhere" / "secret.dcm"))
    os.symlink(secret, os.path.join(study, "SE", "leak.dcm"))
    names = [f["name"] for f in srv.study_dicom_files("received", study)["files"]]
    assert all("leak.dcm" not in n for n in names)
    assert srv.study_dicom_file("received", study, os.path.join("SE", "leak.dcm")) is None


def test_an_attachments_link_out_of_the_root_is_refused(tmp_path):
    srv = _srv(str(tmp_path))
    root = srv.cfg.resolved("scp", "storage_dir")
    study = os.path.join(root, "P", "S")
    write_dicom(os.path.join(study, "a.dcm"))
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(str(outside), os.path.join(study, "attachments"))
    res = srv.attach_to_study("received", study, "r.pdf", PDF)
    assert res["ok"] is False and list(outside.iterdir()) == []


def test_deleting_a_shared_parent_does_not_take_another_study(tmp_path):
    srv = _srv(str(tmp_path))
    watch = srv.cfg.resolved("scu", "watch_dir")
    write_instance(os.path.join(watch, "today", "exA", "1.dcm"), study_uid="1.1")
    write_instance(os.path.join(watch, "today", "exB", "1.dcm"), study_uid="1.1")
    other = write_instance(os.path.join(watch, "today", "exC", "1.dcm"), study_uid="2.2")
    listed = {s["study_uid"]: s["path"] for s in srv.list_studies("outgoing")["studies"]}
    srv.delete_study("outgoing", listed["1.1"])
    assert os.path.exists(other)


def test_the_nested_archive_cannot_be_deleted_as_a_study(tmp_path):
    srv = _srv(str(tmp_path))
    watch = srv.cfg.resolved("scu", "watch_dir")
    sent = os.path.join(watch, "sent")
    with srv.cfg.mutate():
        srv.cfg.scu["sent_dir"] = sent
    write_instance(os.path.join(sent, "S", "1.dcm"), study_uid="1.9")
    res = srv.delete_study("outgoing", sent)
    assert res["ok"] is False and os.path.isdir(sent)


def test_delete_all_through_a_linked_watch_folder_keeps_the_archive(tmp_path):
    srv = _srv(str(tmp_path))
    real = tmp_path / "realout"
    real.mkdir()
    link = tmp_path / "linkout"
    os.symlink(str(real), str(link))
    archived = write_instance(str(real / "sent" / "S" / "1.dcm"), study_uid="1.9.6")
    with srv.cfg.mutate():
        srv.cfg.scu["watch_dir"] = str(link)
        srv.cfg.scu["sent_dir"] = str(real / "sent")
    assert "1.9.6" not in [s["study_uid"] for s in srv.list_studies("outgoing")["studies"]]
    srv.delete_all_studies("outgoing")
    assert os.path.exists(archived)


def test_an_attachment_over_the_cap_is_refused_before_it_is_read(tmp_path):
    srv, _app, c = make(str(tmp_path))
    called = []
    srv.attach_to_study = lambda *a: called.append(a) or {"ok": True}
    r = c.post("/api/studies/attach", data={"path": "x"}, headers=WRITE,
               environ_overrides={"CONTENT_LENGTH": str(200 * 1024 * 1024)})
    assert r.status_code == 413 and called == []


# --------------------------------------------------------------- Stuck panel
def test_replaced_bytes_are_not_an_orphan_and_cannot_be_discarded():
    srv, tmp, watch = _engine()
    p = _queue(srv, watch, "P1/s/x.dcm", {"route": ["Gone"]})
    st = os.stat(p)
    e = srv.watcher.state.peek(p)
    e.update(size=st.st_size, mtime=st.st_mtime)
    write_instance(p, patient_name="CORRECTED^NAME")
    os.utime(p, (st.st_mtime + 5, st.st_mtime + 5))
    assert srv.stuck_sends()["orphaned"] == []
    res = srv.discard_stuck(["P1/s/x.dcm"])
    assert res["ok"] is False and os.path.exists(p)


def test_a_one_off_send_stops_when_the_rules_change_under_it(monkeypatch):
    srv, tmp, watch = _engine()
    a = _queue(srv, watch, "P1/s/a.dcm", {"route": ["Gone"]})
    b = _queue(srv, watch, "P1/s/b.dcm", {"route": ["Gone"]})
    sent = []

    def store(dst, path, *a_, **k):
        sent.append(path)
        if len(sent) == 1:
            with srv.cfg.mutate():
                srv.cfg.data["routing"] = {"enabled": True, "rules": [
                    {"name": "r", "match": {}, "destinations": ["PACS-A"], "deidentify": True}]}
        return scu.SendResult(True, "stored")
    from pacs import scu
    monkeypatch.setattr(scu, "c_store", store)
    assert srv.send_stuck(["P1/s/a.dcm", "P1/s/b.dcm"], "PACS-A")["ok"]
    for _ in range(100):
        if any("configuration changed" in e["message"] for e in srv.log.tail(50)):
            break
        time.sleep(0.05)
    assert b not in sent
    assert any("configuration changed" in e["message"] for e in srv.log.tail(50))


def test_a_file_already_gone_is_not_counted_as_removed(monkeypatch):
    srv, tmp, watch = _engine()
    p = _queue(srv, watch, "P1/s/x.dcm", {"route": ["Gone"]})
    real = srv._resolve_stuck_files

    def then_vanish(files):
        out = real(files)
        os.remove(p)
        return out
    monkeypatch.setattr(srv, "_resolve_stuck_files", then_vanish)
    res = srv.discard_stuck(["P1/s/x.dcm"])
    assert res["removed"] == 0 and srv.watcher.state.peek(p) is None


@pytest.mark.parametrize("url, body", [("/api/stuck/discard", [1]), ("/api/stuck/send", [1]),
                                       ("/api/stuck/retry", [1]),
                                       ("/api/stuck/retry", {"dest": ["a"]}),
                                       ("/api/stuck/retry", {"dest": {"a": 1}})])
def test_a_malformed_body_is_400_not_500(url, body):
    srv, tmp, watch = _engine()
    r = create_app(srv).test_client().post(url, json=body, headers=WRITE)
    assert r.status_code == 400, r.get_data(as_text=True)


def test_retry_counts_only_what_will_actually_be_retried():
    srv, tmp, watch = _engine()
    _queue(srv, watch, "P1/s/x.dcm", {"route": ["Gone"],
                                      "fail": {"Gone": {"next_try": time.time() + 600}}})
    gone = _queue(srv, watch, "P2/s/y.dcm", {"route": ["PACS-A"],
                                             "fail": {"PACS-A": {"next_try": time.time() + 600}}})
    os.remove(gone)
    assert srv.stuck_sends()["files"] == 0
    assert srv.retry_stuck()["reset"] == 0


def test_regression_an_orphan_still_owing_a_live_node_is_kept():
    srv, tmp, watch = _engine()
    p = _queue(srv, watch, "P1/s/x.dcm", {"route": ["PACS-A", "Gone"]})
    res = srv.discard_stuck(["P1/s/x.dcm"])
    assert res["ok"] is False and res["owing"] == ["PACS-A"] and os.path.exists(p)


def test_regression_no_identified_copy_when_no_scrubber_can_be_built(monkeypatch):
    from pacs import deid, scu
    srv, tmp, watch = _engine()
    _queue(srv, watch, "P1/s/x.dcm", {"route": ["Gone"]})
    with srv.cfg.mutate():
        srv.cfg.data["routing"] = {"enabled": True, "rules": [
            {"name": "r", "match": {}, "destinations": ["PACS-A"], "deidentify": True}]}
        srv.cfg.deid["profile"] = "basic"

    def broken(*a, **k):
        raise RuntimeError("no scrubber")
    monkeypatch.setattr(deid.Deidentifier, "from_config", classmethod(lambda cls, *a, **k: broken()))
    called = []
    monkeypatch.setattr(scu, "c_store", lambda *a, **k: called.append(a))
    res = srv.send_stuck(["P1/s/x.dcm"], "PACS-A")
    assert res["ok"] is False and res["field"] == "destination" and called == []


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
