"""Regression tests for the 2026-10 review of routing and the manual send:
de-identification as a property of the node, the header cache identity,
calling_aet, comma patterns, and the manual send's guards.

Runs under pytest, or directly:  python3 tests/test_review_routing.py
"""

from __future__ import annotations

import copy
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest                                              # noqa: E402
from pydicom.dataset import Dataset, FileMetaDataset       # noqa: E402

from pacs import routing                                   # noqa: E402
from pacs.config import Config                             # noqa: E402
from pacs.routing import (Decision, HeaderCache, Router, _field_matches,  # noqa: E402
                          _patterns, attributes_from_dataset)
from test_routing import FakeStore, dest, fake_store, make_config, write_dicom  # noqa: E402
from test_web_auth import (_after_first_store, _arrived, _dicom, _join_sends,  # noqa: E402
                           _receiver)


def _r(rules, enabled=("Archive", "Research"), profile="basic"):
    return Router({"enabled": True, "rules": rules}, list(enabled),
                  cfg={"deid": {"profile": profile}})


CT_TO_RESEARCH = {"name": "ct", "match": {"modality": "CT"}, "destinations": ["Research"],
                  "deidentify": True, "stop": True}


def test_the_fallback_scrubs_for_a_node_a_rule_scrubs_for():
    d = _r([CT_TO_RESEARCH]).route(attrs={"modality": "MR"}).honoured_by(_Usable())
    assert d.fallback and "Research" in d.sendable
    assert d.needs_deid("Research")


def test_the_fallback_holds_that_node_when_the_profile_is_off():
    r = _r([CT_TO_RESEARCH], profile="off")
    d = r.route(attrs={"modality": "MR"})
    assert "Research" in d.held and "Research" not in d.sendable
    assert r.deid_summary()["held"] == ["Research"]


def test_a_typo_in_the_match_key_does_not_send_identified():
    rule = dict(CT_TO_RESEARCH, match={"modalty": "CT"})
    d = _r([rule]).route(attrs={"modality": "CT"})
    assert "Research" not in d.sendable or d.needs_deid("Research")


def test_a_case_mismatched_destination_name_still_protects_the_node():
    rule = dict(CT_TO_RESEARCH, destinations=["research"])
    d = _r([rule]).route(attrs={"modality": "CT"})
    assert "Research" not in d.sendable or d.needs_deid("Research")


def test_an_earlier_identified_route_to_the_node_is_scrubbed_too():
    rules = [{"name": "all", "match": {}, "destinations": ["Research"], "stop": True},
             {"name": "ct", "match": {"modality": "CT"}, "destinations": ["Research"],
              "deidentify": True}]
    assert _r(rules).route(attrs={"modality": "CT"}).needs_deid("Research")


@pytest.mark.parametrize("attrs", [{"modality": "CT"}, {"modality": "MR"}, {}])
def test_every_decision_scrubs_every_node_the_summary_says_is_scrubbed(attrs):
    r = _r([CT_TO_RESEARCH])
    d = r.route(attrs=attrs)
    assert set(d.sendable) & set(r.deid_summary()["destinations"]) <= set(d.deid_dests)


class _Usable:
    enabled = True


def test_honoured_by_none_holds_and_is_idempotent():
    d = Decision(destinations=("A",), deid_dests=frozenset({"A"}))
    once = d.honoured_by(None)
    assert once.sendable == () and once.hold_cause == "no-deidentifier"
    assert once.honoured_by(None) == once


def test_resolve_all_keeps_both_nodes_behind_one_name():
    from pacs.scu import Destination
    a1, a2 = Destination("A", "h1", 104, "X"), Destination("A", "h2", 104, "X")
    assert routing.resolve_all([a1, a2], ["A"]) == [a1, a2]


def test_a_same_size_replacement_that_keeps_its_mtime_is_reread():
    with tempfile.TemporaryDirectory() as tmp:
        p = write_dicom(os.path.join(tmp, "IM0001"), patient_id="AAAA")
        os.utime(p, (1_700_000_000, 1_700_000_000))
        cache = HeaderCache()
        assert cache.attributes(p)["patient_id"] == "AAAA"
        q = write_dicom(os.path.join(tmp, "new"), patient_id="BBBB")
        assert os.path.getsize(p) == os.path.getsize(q)
        os.utime(q, (1_700_000_000, 1_700_000_000))
        os.replace(q, p)
        assert cache.attributes(p)["patient_id"] == "BBBB"


def test_calling_aet_comes_only_from_the_file_meta():
    ds = Dataset()
    ds.SourceApplicationEntityTitle = "ER_SPOOF"
    assert attributes_from_dataset(ds)["calling_aet"] == ""
    ds2 = Dataset()
    ds2.file_meta = FileMetaDataset()
    ds2.file_meta.SourceApplicationEntityTitle = "SPOOF"
    assert attributes_from_dataset(ds2, extra={"calling_aet": "REAL"})["calling_aet"] == "REAL"


def test_a_comma_string_matches_the_same_as_the_list_the_dashboard_saves():
    assert _field_matches("CT", _patterns("CT,MR")) == _field_matches("CT", _patterns(["CT", "MR"]))
    assert _field_matches("CT", _patterns("CT,MR")) is True
    assert _field_matches("CHEST, PA", _patterns(["CHEST, PA"])) is True


# ------------------------------------------------------------ manual send
def _cfg(tmp, aport, rport, rules, profile="basic"):
    cfg = Config(os.path.join(tmp, "config.json"))
    cfg.data["scp"]["enabled"] = False
    cfg.data["index"]["enabled"] = False
    cfg.data["deid"]["profile"] = profile
    cfg.data["deid"]["secret"] = "a-site-key-for-tests"
    cfg.data["destinations"] = [
        {"name": "Archive", "host": "127.0.0.1", "port": aport, "aet": "ARCHIVE", "enabled": True},
        {"name": "Research", "host": "127.0.0.1", "port": rport, "aet": "RESEARCH", "enabled": True}]
    cfg.data["routing"] = {"enabled": True, "rules": rules}
    return cfg


@pytest.mark.parametrize("change", ["deidentify", "match"])
def test_a_rule_change_mid_send_never_leaks_identified_to_research(change):
    from pacs.server import PacsServer
    rules = [{"name": "mr", "match": {"modality": "MR"}, "destinations": ["Research"],
              "deidentify": True},
             {"name": "all", "match": {}, "destinations": ["Archive", "Research"]}]
    with tempfile.TemporaryDirectory() as tmp:
        with _receiver(tmp, "ARCHIVE") as (archive, aport):
            with _receiver(tmp, "RESEARCH") as (research, rport):
                cfg = _cfg(tmp, aport, rport, rules)
                study = os.path.join(cfg.resolved("scp", "storage_dir"), "study1")
                for n in "abcd":
                    _dicom(os.path.join(study, f"{n}.dcm"))
                srv = PacsServer(cfg)
                try:
                    def edit():
                        doc = copy.deepcopy(cfg.data)
                        if change == "deidentify":
                            doc["routing"]["rules"][1]["deidentify"] = True
                        else:
                            doc["routing"]["rules"][0]["match"]["modality"] = "*"
                        srv.apply_config(doc)
                    with _after_first_store(edit):
                        assert srv.send_study("received", study)["ok"]
                        _join_sends()
                    assert _arrived(research).count("Doe^Jane") <= 1, _arrived(research)
                    if change == "deidentify":
                        stale = srv.status()["deid"]["superseded_sends"]
                        assert stale and "Research" in stale[-1]["held"], stale
                finally:
                    srv.shutdown()


def test_the_storage_root_itself_cannot_be_sent():
    from pacs.server import PacsServer
    import threading
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive")])
        root = cfg.resolved("scp", "storage_dir")
        write_dicom(os.path.join(root, "s1", "a.dcm"))
        srv = PacsServer(cfg)
        before = {t.ident for t in threading.enumerate() if t.name == "pacs-send"}
        res = srv.send_study("received", root)
        assert res["ok"] is False
        assert {t.ident for t in threading.enumerate() if t.name == "pacs-send"} <= before
        assert srv.explain_route("received", root)["ok"] is False


def test_a_second_send_of_the_same_study_waits_for_the_first():
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive")])
        study = os.path.join(cfg.resolved("scp", "storage_dir"), "s1")
        for n in "ab":
            write_dicom(os.path.join(study, f"{n}.dcm"))
        srv = PacsServer(cfg)

        class Slow(FakeStore):
            def __call__(self, *a, **k):
                time.sleep(0.3)
                return super().__call__(*a, **k)
        store = Slow()
        with fake_store(store):
            assert srv.send_study("received", study)["ok"] is True
            second = srv.send_study("received", study)
            _join_sends()
        assert second["ok"] is False
        assert len(store.calls) == 2


def test_a_file_linked_from_outside_the_root_is_not_part_of_a_study():
    from pacs import history
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "received")
        study = os.path.join(root, "study1")
        write_dicom(os.path.join(study, "a.dcm"))
        outside = write_dicom(os.path.join(tmp, "elsewhere", "secret.dcm"))
        os.symlink(outside, os.path.join(study, "link.dcm"))
        files = history.study_files(root, study)
        assert [os.path.basename(f) for f in files] == ["a.dcm"]


def test_deid_failures_are_counted_once_per_node_in_both_records(monkeypatch):
    from pacs import deid
    from pacs.server import PacsServer
    from pacs.handsent import study_key
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Research", "10.0.0.1"), dest("Research", "10.0.0.2")],
                          rules=[{"name": "r", "match": {}, "destinations": ["Research"],
                                  "deidentify": True}])
        cfg.data["deid"]["profile"] = "basic"
        study = os.path.join(cfg.resolved("scp", "storage_dir"), "s1")
        write_dicom(os.path.join(study, "a.dcm"))
        srv = PacsServer(cfg)

        def broken(*a, **k):
            raise deid.DeidError("cannot scrub")
        monkeypatch.setattr(deid, "deidentified_tempfile", broken)
        with fake_store(FakeStore()):
            assert srv.send_study("received", study)["ok"]
            _join_sends()
        from pacs import history
        key = study_key(history.study_identity(cfg.resolved("scp", "storage_dir"), study)
                        .get("study_uid", ""), study)
        rows = srv.handsent.get(key)
        summary = [e["message"] for e in srv.log.tail(100) if "Manual send of" in e["message"]][-1]
        assert rows and rows[0]["fail"] == 2
        assert "2 failed" in summary


def test_profile_off_holds_every_instance_for_a_scrubbed_node():
    from pacs.server import PacsServer
    from pacs.handsent import study_key
    from pacs import history
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Research", "10.0.0.1")],
                          rules=[{"name": "r", "match": {}, "destinations": ["Research"],
                                  "deidentify": True}])
        cfg.data["deid"]["profile"] = "off"
        study = os.path.join(cfg.resolved("scp", "storage_dir"), "s1")
        for n in "ab":
            write_dicom(os.path.join(study, f"{n}.dcm"))
        srv = PacsServer(cfg)
        store = FakeStore()
        with fake_store(store):
            srv.send_study("received", study)
            _join_sends()
        assert store.calls == []
        key = study_key(history.study_identity(cfg.resolved("scp", "storage_dir"), study)
                        .get("study_uid", ""), study)
        assert srv.handsent.get(key)[0]["held"] == 2
        assert any("HELD" in e["message"] for e in srv.log.tail(100)
                   if "Manual send of" in e["message"])


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
