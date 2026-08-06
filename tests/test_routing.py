"""Tests for pacs.routing (the conditional routing rule engine).

Runs under pytest, or directly:  python3 tests/test_routing.py
"""

from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

from pacs import routing
from pacs.routing import Decision, HeaderCache, Router, fully_sent, record_route, wanted_from

ALL = ["Archive", "Workstation", "Teaching"]


class FakeLog:
    """Stand-in for LogBuffer — records what routing decided to shout about."""

    def __init__(self):
        self.entries = []

    def warn(self, message, **f):
        self.entries.append(("warn", message, f))

    def info(self, message, **f):
        self.entries.append(("info", message, f))

    def error(self, message, **f):
        self.entries.append(("error", message, f))

    @property
    def warnings(self):
        return [m for lvl, m, _ in self.entries if lvl == "warn"]


def rule(name, dests=(), stop=False, deid=False, **match):
    return {"name": name, "match": dict(match), "destinations": list(dests),
            "stop": stop, "deidentify": deid}


def router(rules, enabled=ALL, on=True, log=None):
    return Router({"enabled": on, "rules": list(rules)}, enabled, log=log)


def attrs(**kw):
    base = {"modality": "", "calling_aet": "", "station": "",
            "patient_id": "", "study_desc": ""}
    base.update(kw)
    return base


def write_dicom(path, modality="CT", station="ROOM1", patient_id="P1",
                study_desc="Head CT", source_aet="MOD1"):
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = generate_uid()
    if source_aet:
        meta.SourceApplicationEntityTitle = source_aet
    ds = Dataset()
    ds.file_meta = meta
    ds.preamble = b"\0" * 128
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.PatientName = "Doe^Jane"
    ds.PatientID = patient_id
    ds.Modality = modality
    ds.StationName = station
    ds.StudyDescription = study_desc
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        ds.save_as(path, enforce_file_format=True)      # pydicom >= 3
    except TypeError:
        ds.save_as(path, write_like_original=False)     # pydicom 2.x
    return path


# ------------------------------------------------------------------ order + stop
def test_rules_evaluate_in_order_and_accumulate():
    r = router([rule("ct", ["Archive"], modality="CT"),
                rule("room", ["Workstation"], station="ROOM1")])
    d = r.route(attrs=attrs(modality="CT", station="ROOM1"))
    assert d.destinations == ("Archive", "Workstation")
    assert d.rules == ("ct", "room")
    assert not d.fallback


def test_stop_ends_evaluation():
    r = router([rule("ct", ["Archive"], stop=True, modality="CT"),
                rule("room", ["Workstation"], station="ROOM1")])
    d = r.route(attrs=attrs(modality="CT", station="ROOM1"))
    assert d.destinations == ("Archive",)
    assert d.rules == ("ct",)


def test_stop_only_applies_when_the_rule_matches():
    r = router([rule("mr", ["Teaching"], stop=True, modality="MR"),
                rule("ct", ["Archive"], modality="CT")])
    d = r.route(attrs=attrs(modality="CT"))
    assert d.destinations == ("Archive",)


def test_output_order_follows_the_destination_list_not_rule_order():
    r = router([rule("a", ["Teaching"], modality="CT"),
                rule("b", ["Archive"], modality="CT")])
    d = r.route(attrs=attrs(modality="CT"))
    assert d.destinations == ("Archive", "Teaching")


# --------------------------------------------------------------- drop-through
def test_empty_destinations_drops_through_to_the_next_rule():
    r = router([rule("filter", [], modality="CT"),
                rule("catch", ["Workstation"], modality="CT")])
    d = r.route(attrs=attrs(modality="CT"))
    assert d.destinations == ("Workstation",)
    assert d.rules == ("catch",)


def test_empty_destinations_with_stop_still_drops_through():
    # "send nowhere" is not an expressible outcome; stop on an empty rule is ignored.
    r = router([rule("sink", [], stop=True, modality="CT"),
                rule("catch", ["Workstation"], modality="CT")])
    d = r.route(attrs=attrs(modality="CT"))
    assert d.destinations == ("Workstation",)


def test_empty_destinations_alone_falls_back_to_all():
    r = router([rule("sink", [], stop=True, modality="CT")])
    d = r.route(attrs=attrs(modality="CT"))
    assert d.destinations == tuple(ALL)
    assert d.fallback


# ------------------------------------------------------------------- matching
def test_glob_matching_on_every_field():
    cases = [
        ("modality", "C*", {"modality": "CT"}, {"modality": "MR"}),
        ("calling_aet", "ER_*", {"calling_aet": "ER_CT1"}, {"calling_aet": "WARD_CT1"}),
        ("station", "ROOM?", {"station": "ROOM3"}, {"station": "ROOM33"}),
        ("patient_id", "TEST*", {"patient_id": "TEST0042"}, {"patient_id": "REAL42"}),
        ("study_desc", "*mammo*", {"study_desc": "Bilateral MAMMOgram"}, {"study_desc": "Head CT"}),
    ]
    for fieldname, pattern, hit, miss in cases:
        r = router([rule("r", ["Archive"], stop=True, **{fieldname: pattern})])
        assert r.route(attrs=attrs(**hit)).destinations == ("Archive",), fieldname
        assert r.route(attrs=attrs(**miss)).fallback is True, fieldname


def test_matching_is_case_insensitive():
    r = router([rule("r", ["Archive"], stop=True, modality="ct", calling_aet="er_*")])
    d = r.route(attrs=attrs(modality="CT", calling_aet="ER_ONE"))
    assert d.destinations == ("Archive",)


def test_all_match_fields_must_match():
    r = router([rule("r", ["Archive"], modality="CT", station="ROOM1")])
    assert r.route(attrs=attrs(modality="CT", station="ROOM9")).fallback is True


def test_empty_and_absent_match_fields_match_anything():
    r = router([rule("r", ["Archive"], stop=True, modality="", station="")])
    assert r.route(attrs=attrs(modality="US")).destinations == ("Archive",)
    r2 = router([{"name": "bare", "destinations": ["Archive"], "stop": True}])
    assert r2.route(attrs=attrs(modality="US")).destinations == ("Archive",)


def test_match_value_may_be_a_list_of_globs():
    r = router([rule("r", ["Archive"], stop=True, modality=["CT", "MR"])])
    assert r.route(attrs=attrs(modality="MR")).destinations == ("Archive",)
    assert r.route(attrs=attrs(modality="US")).fallback is True


def test_a_pattern_never_matches_a_missing_value():
    r = router([rule("r", ["Archive"], station="ROOM1")])
    assert r.route(attrs=attrs(station="")).fallback is True


def test_field_aliases():
    r = router([rule("r", ["Archive"], stop=True, source_aet="MOD*", station_name="ROOM1")])
    assert r.route(attrs=attrs(calling_aet="MOD1", station="ROOM1")).destinations == ("Archive",)


def test_unknown_match_key_skips_the_rule_loudly():
    log = FakeLog()
    r = router([rule("typo", ["Archive"], stop=True, modallity="CT")], log=log)
    d = r.route(attrs=attrs(modality="CT"))
    assert d.fallback is True and d.destinations == tuple(ALL)
    assert any("unknown match key" in w for w in log.warnings)


def test_underscore_keys_in_match_are_ignored():
    rl = rule("r", ["Archive"], stop=True, modality="CT")
    rl["match"]["_comment"] = "documentation"
    assert router([rl]).route(attrs=attrs(modality="CT")).destinations == ("Archive",)


# ------------------------------------------------- unknown / disabled destinations
def test_unknown_destination_is_warned_and_the_rest_still_send():
    log = FakeLog()
    r = router([rule("r", ["Archive", "Ghost"], stop=True, modality="CT")], log=log)
    d = r.route(attrs=attrs(modality="CT"))
    assert d.destinations == ("Archive",)
    assert d.unresolved == ("r -> Ghost",)
    assert any("Ghost" in w for w in log.warnings)


def test_rule_whose_destinations_are_all_disabled_drops_through():
    r = router([rule("dead", ["Ghost"], stop=True, modality="CT"),
                rule("live", ["Workstation"], modality="CT")])
    d = r.route(attrs=attrs(modality="CT"))
    assert d.destinations == ("Workstation",)


def test_rule_resolving_to_nothing_falls_back_to_all_and_shouts():
    log = FakeLog()
    r = router([rule("dead", ["Ghost"], stop=True, modality="CT")], log=log)
    d = r.route(path=None, attrs=attrs(modality="CT"))
    assert d.destinations == tuple(ALL)        # never nowhere
    assert d.fallback and d.unresolved
    assert any("fell back" in w for w in log.warnings)


def test_disabling_a_destination_removes_it_from_routes():
    r = router([rule("r", ["Archive", "Teaching"], stop=True, modality="CT")],
               enabled=["Archive", "Workstation"])
    assert r.route(attrs=attrs(modality="CT")).destinations == ("Archive",)


def test_warnings_are_emitted_once_until_the_config_changes():
    log = FakeLog()
    r = router([rule("r", ["Ghost"], modality="CT")], log=log)
    for _ in range(5):
        r.route(attrs=attrs(modality="CT"))
    first = len(log.warnings)
    assert first > 0
    r.update({"enabled": True, "rules": [rule("r", ["Ghost"], modality="MR")]}, ALL)
    r.route(attrs=attrs(modality="MR"))
    assert len(log.warnings) > first


def test_blank_or_duplicate_destination_names_are_an_error():
    # Send state keys on the name and has no second key, so two nodes called
    # "Archive" are genuinely unrepresentable — that is an error, not a note.
    log = FakeLog()
    Router({"enabled": True, "rules": []}, ["Archive", "Archive", ""], log=log)
    errs = [m for lvl, m, _ in log.entries if lvl == "error"]
    assert any("unique" in m for m in errs), log.entries
    assert log.warnings == []


# ------------------------------------------------------------------- fallbacks
def test_routing_disabled_sends_everywhere():
    r = router([rule("r", ["Archive"], stop=True, modality="CT")], on=False)
    d = r.route(attrs=attrs(modality="CT"))
    assert d.destinations == tuple(ALL) and d.fallback


def test_no_rules_sends_everywhere():
    d = router([]).route(attrs=attrs(modality="CT"))
    assert d.destinations == tuple(ALL) and d.fallback


def test_no_rule_matches_sends_everywhere():
    r = router([rule("r", ["Archive"], modality="MR")])
    d = r.route(attrs=attrs(modality="US"))
    assert d.destinations == tuple(ALL) and d.fallback and d.rules == ()


def test_no_enabled_destinations_yields_nothing_but_does_not_crash():
    r = router([rule("r", ["Archive"], modality="CT")], enabled=[])
    assert router([], enabled=[]).route(attrs=attrs()).destinations == ()
    assert r.route(attrs=attrs(modality="CT")).destinations == ()


def test_unparseable_file_falls_back_to_all():
    log = FakeLog()
    with tempfile.TemporaryDirectory() as tmp:
        junk = os.path.join(tmp, "not-a-dicom.dcm")
        with open(junk, "wb") as fh:
            fh.write(b"\0" * 200)
        r = router([rule("r", ["Archive"], stop=True, modality="CT")], log=log)
        d = r.route(path=junk)
        assert d.destinations == tuple(ALL) and d.fallback
        assert "unreadable" in d.reason


def test_missing_file_falls_back_to_all():
    r = router([rule("r", ["Archive"], stop=True, modality="CT")])
    d = r.route(path="/nonexistent/nope.dcm")
    assert d.destinations == tuple(ALL) and d.fallback


# ------------------------------------------------------- header read + caching
def test_routes_a_real_file_from_its_header():
    with tempfile.TemporaryDirectory() as tmp:
        p = write_dicom(os.path.join(tmp, "a.dcm"), modality="CT", source_aet="ER_CT1")
        r = router([rule("er-ct", ["Teaching"], stop=True, deid=True,
                         modality="CT", calling_aet="ER_*")])
        d = r.route(path=p)
        assert d.destinations == ("Teaching",)
        assert d.deidentify and d.needs_deid("Teaching")


def test_header_cache_reuses_within_a_scan_and_notices_replacement():
    with tempfile.TemporaryDirectory() as tmp:
        p = write_dicom(os.path.join(tmp, "a.dcm"), modality="CT")
        cache = HeaderCache()
        assert cache.attributes(p)["modality"] == "CT"
        assert cache.attributes(p)["modality"] == "CT"
        assert cache.hits == 1 and cache.misses == 1
        os.remove(p)
        write_dicom(p, modality="MR", study_desc="Brain MR" * 4)  # different size+mtime
        os.utime(p, (0, 0))
        assert cache.attributes(p)["modality"] == "MR"


def test_header_cache_is_bounded():
    cache = HeaderCache(max_entries=2)
    with tempfile.TemporaryDirectory() as tmp:
        paths = [write_dicom(os.path.join(tmp, f"{i}.dcm")) for i in range(3)]
        for p in paths:
            cache.attributes(p)
        assert len(cache._data) <= 2


def test_extra_overrides_the_header_source_aet():
    ds = Dataset()
    ds.Modality = "CT"
    a = routing.attributes_from_dataset(ds, {"calling_aet": "MAMMO1"})
    assert a["calling_aet"] == "MAMMO1" and a["modality"] == "CT"


# --------------------------------------------------------------------- explain
def test_explain_traces_every_rule():
    r = router([rule("mr", ["Teaching"], modality="MR"),
                rule("ct", ["Archive"], stop=True, modality="CT"),
                rule("later", ["Workstation"], modality="CT")])
    out = r.explain(attrs=attrs(modality="CT"))
    assert [x["matched"] for x in out["rules"]] == [False, True, False]
    assert "stop" in out["rules"][1]["action"]
    assert "not evaluated" in out["rules"][2]["action"]
    assert out["decision"]["destinations"] == ["Archive"]
    fields = out["rules"][0]["fields"]
    assert fields[0] == {"field": "modality", "patterns": ["MR"],
                         "value": "CT", "matched": False}


def test_explain_does_not_log():
    log = FakeLog()
    r = router([rule("r", ["Ghost"], modality="CT")], log=log)
    r.explain(attrs=attrs(modality="CT"))
    assert log.entries == []


def test_explain_reports_an_unreadable_file():
    with tempfile.TemporaryDirectory() as tmp:
        junk = os.path.join(tmp, "x.dcm")
        with open(junk, "wb") as fh:
            fh.write(b"junk")
        out = router([rule("r", ["Archive"], modality="CT")]).explain(path=junk)
        assert out["parsed"] is False
        assert out["decision"]["destinations"] == ALL


# ------------------------------------------- the per-file want set (archive gate)
def test_unrouted_entry_is_never_fully_sent():
    # The pre-routing bug in the other direction: an entry we have not stamped
    # must not look "done" just because nothing is required of it.
    assert fully_sent({"sent": []}, ALL) is False
    assert fully_sent(None, ALL) is False
    assert wanted_from(None, ALL) is None


def test_fully_sent_uses_the_recorded_route_not_the_global_list():
    entry = {"sent": []}
    record_route(entry, Decision(destinations=("Archive", "Teaching")))
    assert entry["route"] == ["Archive", "Teaching"]
    assert fully_sent(entry, ALL) is False
    entry["sent"] = ["Archive"]
    assert fully_sent(entry, ALL) is False          # still owes Teaching
    entry["sent"] = ["Archive", "Teaching"]
    assert fully_sent(entry, ALL) is True           # done, though Workstation never got it


def test_a_disabled_destination_cannot_pin_a_study_forever():
    entry = {"sent": ["Archive"]}
    record_route(entry, Decision(destinations=("Archive", "Teaching")))
    assert fully_sent(entry, ALL) is False
    assert fully_sent(entry, ["Archive", "Workstation"]) is True   # Teaching removed
    assert wanted_from(entry, ["Archive", "Workstation"]) == {"Archive"}


def test_a_route_to_nothing_is_never_fully_sent():
    # The inversion this module exists to prevent, at the source: set() is a
    # subset of everything, so "owes nobody" reads as "reached everybody". A
    # recorded empty route means the file reached NO node — the watcher never
    # gets here (it returns early when there are no enabled destinations), but
    # the helper is shared API and the next caller must not be handed the trap.
    entry = {"sent": []}
    record_route(entry, Decision(destinations=()))
    assert entry["route"] == []
    assert fully_sent(entry, ALL) is False
    assert fully_sent(entry, []) is False


def test_an_intersection_emptied_by_a_rename_is_not_fully_sent():
    # The same empty set reached the way it actually happens in the field: the
    # route was recorded under a name that has since been renamed away, so the
    # live intersection is empty while the file has reached nobody.
    entry = {"sent": []}
    record_route(entry, Decision(destinations=("PACS",)))
    assert wanted_from(entry, ["PACS Main"]) == set()
    assert fully_sent(entry, ["PACS Main"]) is False
    assert fully_sent(entry, ["PACS Main"], stat=None) is False
    # And the non-empty case still answers normally in both directions.
    assert fully_sent(entry, ["PACS"]) is False
    entry["sent"] = ["PACS"]
    assert fully_sent(entry, ["PACS"]) is True


def test_record_route_reports_change_and_carries_deid():
    entry = {"sent": []}
    d = Decision(destinations=("Archive",), deid_dests=frozenset({"Archive"}))
    assert record_route(entry, d) is True
    assert record_route(entry, d) is False
    assert entry["deid"] == ["Archive"]


def test_want_set_is_per_file():
    a, b = {"sent": ["Archive"]}, {"sent": ["Archive"]}
    record_route(a, Decision(destinations=("Archive",)))
    record_route(b, Decision(destinations=("Archive", "Workstation")))
    assert fully_sent(a, ALL) is True and fully_sent(b, ALL) is False


def test_replaced_file_loses_its_route_via_sendstate():
    # SendState.get() rebuilds the entry when size/mtime change, which drops
    # "route" along with "sent" — the new content is re-routed from scratch.
    from pacs.state import SendState
    with tempfile.TemporaryDirectory() as tmp:
        st = SendState(os.path.join(tmp, "state.json"))
        p = os.path.join(tmp, "a.dcm")
        e = st.get(p, 10, 100.0)
        record_route(e, Decision(destinations=("Archive",)))
        e["sent"].append("Archive")
        st.put(p, e)
        assert fully_sent(st.peek(p), ALL) is True
        e2 = st.get(p, 20, 200.0)
        assert "route" not in e2
        assert fully_sent(st.peek(p), ALL) is False


# ================================================================ image loss
# Everything below drives the real FolderWatcher / PacsServer against a fake
# C-STORE. They are here rather than in a routing unit file because every one of
# them is a route that was decided correctly and then delivered to the wrong set
# of sockets — the bug always lives in the gap between the two.

import contextlib
import json
import shutil
import threading
import time as _time

from pacs.scu import SendResult
from pacs.state import SendState
from pacs.watcher import FolderWatcher


def dest(name, host="10.0.0.1", port=104, aet="REMOTE", **extra):
    d = {"name": name, "host": host, "port": port, "aet": aet}
    d.update(extra)
    return d


def make_config(tmp, destinations, rules=None, on_success="keep", routing_on=None):
    """A real Config in *tmp* — the watcher reads paths, poll interval and the
    enabled-destination list straight off it, so faking it would test a fake."""
    from pacs.config import Config
    cfg = Config(os.path.join(tmp, "config.json"))
    cfg.data["destinations"] = list(destinations)
    if routing_on is None:
        routing_on = bool(rules)
    cfg.data["routing"] = {"enabled": routing_on, "rules": list(rules or [])}
    cfg.data["scu"]["on_success"] = on_success
    cfg.data["index"]["enabled"] = False
    cfg.data["deid"]["profile"] = "off"
    return cfg


class FakeStore:
    """Records every C-STORE by (name, host, port) — the point of these tests is
    that a NODE was reached, and two nodes can share a name."""

    def __init__(self, fail=()):
        self.fail = set(fail)
        self.calls = []

    def __call__(self, dst, filepath, calling_aet, timeout=30, tls_context=None):
        base = os.path.basename(filepath)
        self.calls.append((dst.name, dst.host, dst.port, base))
        if dst.name in self.fail or (dst.host, dst.port) in self.fail or base in self.fail:
            return SendResult(False, "association rejected")
        return SendResult(True, "stored")

    @property
    def nodes(self):
        return sorted({(n, h, p) for n, h, p, _ in self.calls})

    def hosts_for(self, filename):
        return sorted({h for _, h, _, f in self.calls if f == filename})


@contextlib.contextmanager
def fake_store(store):
    """Patch both call sites: the watcher binds c_store at import, send_study
    imports it per call out of pacs.scu."""
    from pacs import scu, watcher as watcher_mod
    old_w, old_s = watcher_mod.c_store, scu.c_store
    watcher_mod.c_store, scu.c_store = store, store
    try:
        yield store
    finally:
        watcher_mod.c_store, scu.c_store = old_w, old_s


def scan(w, times=1):
    """Run whole watcher passes. Two are needed before anything is sent: a file
    is only forwarded once its size has been seen unchanged twice."""
    for _ in range(times):
        w._scan_once()


def scan_like_the_daemon(w, times=1):
    """Whole passes the way the watcher thread runs them.

    _run() catches everything a pass raises, logs it and comes back on the next
    poll, so a pass that dies is not the end of the story — it is the setup for
    the next one, which runs with whatever half-updated state the dead pass left
    behind. A test that lets the exception out asserts on a process that in
    production keeps going."""
    for _ in range(times):
        try:
            w._scan_once()
        except Exception as exc:
            w.log.error(f"Watcher pass failed: {exc}", kind="watch")


def join_manual_sends(timeout=15):
    for t in list(threading.enumerate()):
        if t.name == "pacs-send":
            t.join(timeout=timeout)


# ------------------------------------------- duplicate names (watcher, BLOCKER)
def test_two_nodes_sharing_a_name_both_receive_the_study():
    # A name -> Destination map keeps only the last node, so the other one never
    # sees the study while the send state records the name as delivered.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("PACS", "10.0.0.1"), dest("PACS", "10.0.0.2")])
        out = cfg.resolved("scu", "watch_dir")
        write_dicom(os.path.join(out, "a.dcm"))
        w = FolderWatcher(cfg, FakeLog())
        with fake_store(FakeStore()) as store:
            scan(w, 2)
        assert store.hosts_for("a.dcm") == ["10.0.0.1", "10.0.0.2"], store.calls


def test_a_failing_twin_keeps_the_study_out_of_the_archive():
    # The half that loses images: node 1 is down, node 2 accepts. Collapsing the
    # pair to node 2 marks "PACS" sent, and on_success=delete then DESTROYS the
    # only copy of a study node 1 never received.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("PACS", "10.0.0.1"), dest("PACS", "10.0.0.2")],
                          on_success="delete")
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        w = FolderWatcher(cfg, FakeLog())
        with fake_store(FakeStore(fail={("10.0.0.1", 104)})):
            scan(w, 2)
        assert os.path.exists(p), "study deleted while 10.0.0.1 never received it"
        assert w._fully_sent(p, {"PACS"}, {os.path.abspath(p)}) is False


# ------------------------------------------ duplicate names (send_study, MAJOR)
def test_manual_send_reaches_every_node_sharing_a_name():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("PACS", "10.0.0.1"), dest("PACS", "10.0.0.2")])
        recv = cfg.resolved("scp", "storage_dir")
        study = os.path.join(recv, "study1")
        write_dicom(os.path.join(study, "a.dcm"))
        from pacs.server import PacsServer
        srv = PacsServer(cfg)
        with fake_store(FakeStore()) as store:
            res = srv.send_study("received", study)
            assert res["ok"], res
            join_manual_sends()
        assert store.hosts_for("a.dcm") == ["10.0.0.1", "10.0.0.2"], store.calls


# ------------------------------------------------- hold-and-forward (MAJOR)
def test_held_instances_always_reach_the_primary_whatever_the_rules_say():
    # The failover guarantee: a study received while the primary is down must
    # land on the primary when it returns. A stop-rule that routes it elsewhere
    # must not be able to consume it.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(
            tmp,
            [dest("Primary", "10.0.0.1", emergency_trigger=True),
             dest("Teaching", "10.0.0.9")],
            rules=[{"name": "ct-to-teaching", "match": {"modality": "CT"},
                    "destinations": ["Teaching"], "stop": True}],
            on_success="delete",
        )
        recv = cfg.resolved("scp", "storage_dir")
        src = write_dicom(os.path.join(recv, "a.dcm"))
        from pacs.server import PacsServer
        srv = PacsServer(cfg)
        srv._queue_for_forward(src)
        held = os.path.join(cfg.resolved("scu", "watch_dir"), "a.dcm")
        assert os.path.isfile(held)
        with fake_store(FakeStore()) as store:
            scan(srv.watcher, 2)
        assert "10.0.0.1" in store.hosts_for("a.dcm"), store.calls
        assert not os.path.exists(held), "held copy still queued after both nodes took it"


def test_a_held_instance_is_not_archived_before_the_primary_takes_it():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(
            tmp,
            [dest("Primary", "10.0.0.1", emergency_trigger=True),
             dest("Teaching", "10.0.0.9")],
            rules=[{"name": "ct-to-teaching", "match": {"modality": "CT"},
                    "destinations": ["Teaching"], "stop": True}],
            on_success="delete",
        )
        recv = cfg.resolved("scp", "storage_dir")
        src = write_dicom(os.path.join(recv, "a.dcm"))
        from pacs.server import PacsServer
        srv = PacsServer(cfg)
        srv._queue_for_forward(src)
        held = os.path.join(cfg.resolved("scu", "watch_dir"), "a.dcm")
        with fake_store(FakeStore(fail={"Primary"})):
            scan(srv.watcher, 2)
        assert os.path.exists(held), "held copy destroyed without reaching the primary"


# ------------------------------------------------ rewritten in place (MINOR)
def test_a_file_rewritten_after_it_was_sent_is_not_archived_on_stale_state():
    # b.dcm keeps the folder in the outgoing tree while a.dcm is replaced under
    # the same name. a.dcm's send state still describes the OLD bytes, and the
    # archive gate must not accept it — with on_success=delete the new content
    # would be destroyed having never been forwarded.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1")], on_success="delete")
        out = cfg.resolved("scu", "watch_dir")
        study = os.path.join(out, "study1")
        a = write_dicom(os.path.join(study, "a.dcm"), study_desc="Head CT")
        b = write_dicom(os.path.join(study, "b.dcm"), study_desc="Head CT")
        w = FolderWatcher(cfg, FakeLog())
        store = FakeStore(fail={"b.dcm"})   # b keeps the folder in the outgoing tree
        with fake_store(store):
            scan(w, 2)                      # a lands, b fails
        assert os.path.exists(a) and os.path.exists(b)
        assert w._fully_sent(a, {"Archive"}, {os.path.abspath(a)}) is True

        os.remove(a)                        # replaced under the same name
        write_dicom(a, study_desc="Head CT with contrast" * 6)
        os.utime(a, (1, 1))

        store.fail.clear()
        w.state.clear_backoff()
        with fake_store(store):
            scan(w, 1)                      # b lands; a is not stable yet
        assert os.path.exists(a), "study deleted on a.dcm's stale send state"
        with fake_store(store):
            scan(w, 2)                      # a re-stabilises, is re-sent, then archived
        sends_of_a = [c for c in store.calls if c[3] == "a.dcm"]
        assert len(sends_of_a) >= 2, sends_of_a
        assert not os.path.exists(study)


def test_fully_sent_rejects_an_entry_recorded_against_different_bytes():
    entry = {"sent": ["Archive"], "size": 10, "mtime": 100.0}
    record_route(entry, Decision(destinations=("Archive",)))
    assert fully_sent(entry, ALL) is True
    assert fully_sent(entry, ALL, stat=(10, 100.0)) is True
    assert fully_sent(entry, ALL, stat=(11, 100.0)) is False
    assert fully_sent(entry, ALL, stat=(10, 101.0)) is False
    assert fully_sent(None, ALL, stat=(10, 100.0)) is False


# ------------------------------------------------------- resolving route names
def test_resolve_all_returns_every_node_behind_a_name_in_route_order():
    from pacs.scu import Destination
    nodes = [Destination("PACS", "10.0.0.1", 104, "A"),
             Destination("Teaching", "10.0.0.9", 104, "T"),
             Destination("PACS", "10.0.0.2", 104, "B")]
    got = routing.resolve_all(nodes, ["PACS", "Teaching", "Ghost"])
    assert [(d.name, d.host) for d in got] == [
        ("PACS", "10.0.0.1"), ("PACS", "10.0.0.2"), ("Teaching", "10.0.0.9")]
    assert routing.resolve_all(nodes, []) == []


def test_pinned_destinations_are_merged_into_every_recorded_route():
    entry = {"sent": [], "pin": ["Primary"]}
    record_route(entry, Decision(destinations=("Teaching",)))
    assert entry["route"] == ["Teaching", "Primary"]
    assert fully_sent(entry, ALL + ["Primary"]) is False
    entry["sent"] = ["Teaching", "Primary"]
    assert fully_sent(entry, ALL + ["Primary"]) is True


def test_sendstate_pin_survives_and_is_dropped_with_the_file():
    with tempfile.TemporaryDirectory() as tmp:
        st = SendState(os.path.join(tmp, "state.json"))
        p = os.path.join(tmp, "a.dcm")
        with open(p, "wb") as fh:
            fh.write(b"x" * 32)
        st.pin(p, ["Primary"])
        st.pin(p, ["Primary", "Other"])          # idempotent, additive
        assert st.peek(p)["pin"] == ["Primary", "Other"]
        st.save()
        again = SendState(os.path.join(tmp, "state.json"))
        assert again.peek(p)["pin"] == ["Primary", "Other"]
        # Replaced content resets the entry — including the pin, which belonged
        # to the bytes that were queued, not to the name.
        e = st.get(p, 99, 5.0)
        assert "pin" not in e


# =================================================== end-to-end delivery battery
# The unit tests above prove the decision; these prove the sockets. Every one of
# them asks the same question in a different configuration: did the file reach
# every node it was owed to, and was it archived only after it did.

THREE = [dest("Archive", "10.0.0.1"), dest("Workstation", "10.0.0.2"),
         dest("Teaching", "10.0.0.3")]


def run_watcher(cfg, passes=2, store=None, prep=None):
    w = FolderWatcher(cfg, FakeLog())
    if prep:
        prep(w)
    store = store or FakeStore()
    with fake_store(store):
        scan(w, passes)
    return w, store


def names_for(store, filename="a.dcm"):
    return sorted({n for n, _, _, f in store.calls if f == filename})


def test_e2e_routing_off_fans_out_to_every_enabled_node():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, THREE, routing_on=False)
        write_dicom(os.path.join(cfg.resolved("scu", "watch_dir"), "a.dcm"))
        _, store = run_watcher(cfg)
        assert names_for(store) == ["Archive", "Teaching", "Workstation"]


def test_e2e_a_matching_rule_narrows_delivery_and_then_archives():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, THREE, on_success="move", rules=[
            {"name": "ct", "match": {"modality": "CT"},
             "destinations": ["Teaching"], "stop": True}])
        out = cfg.resolved("scu", "watch_dir")
        write_dicom(os.path.join(out, "a.dcm"))
        _, store = run_watcher(cfg)
        assert names_for(store) == ["Teaching"]
        assert os.path.isfile(os.path.join(cfg.resolved("scu", "sent_dir"), "a.dcm"))
        assert not os.path.exists(os.path.join(out, "a.dcm"))


def test_e2e_no_rule_matches_falls_back_to_every_node():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, THREE, rules=[
            {"name": "mr-only", "match": {"modality": "MR"},
             "destinations": ["Teaching"], "stop": True}])
        write_dicom(os.path.join(cfg.resolved("scu", "watch_dir"), "a.dcm"), modality="CT")
        _, store = run_watcher(cfg)
        assert names_for(store) == ["Archive", "Teaching", "Workstation"]


def test_e2e_an_unknown_destination_name_does_not_strand_the_rest():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, THREE, on_success="delete", rules=[
            {"name": "ct", "match": {"modality": "CT"},
             "destinations": ["Ghost", "Archive"], "stop": True}])
        out = cfg.resolved("scu", "watch_dir")
        write_dicom(os.path.join(out, "a.dcm"))
        _, store = run_watcher(cfg)
        assert names_for(store) == ["Archive"]
        assert not os.path.exists(os.path.join(out, "a.dcm"))   # Ghost cannot pin it


def test_e2e_a_rule_naming_only_a_disabled_node_falls_back_to_all():
    with tempfile.TemporaryDirectory() as tmp:
        dests = [dict(d) for d in THREE]
        dests[2]["enabled"] = False                              # Teaching off
        cfg = make_config(tmp, dests, rules=[
            {"name": "ct", "match": {"modality": "CT"},
             "destinations": ["Teaching"], "stop": True}])
        write_dicom(os.path.join(cfg.resolved("scu", "watch_dir"), "a.dcm"))
        _, store = run_watcher(cfg)
        assert names_for(store) == ["Archive", "Workstation"]


def test_e2e_an_unreadable_header_is_sent_everywhere_not_dropped():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, THREE, rules=[
            {"name": "ct", "match": {"modality": "CT"},
             "destinations": ["Teaching"], "stop": True}])
        out = cfg.resolved("scu", "watch_dir")
        good = write_dicom(os.path.join(out, "good.dcm"))
        broken = os.path.join(out, "broken.dcm")
        with open(good, "rb") as fh:
            head = fh.read(140)
        with open(broken, "wb") as fh:                # DICM magic, garbage body
            fh.write(head + b"\xff" * 400)
        _, store = run_watcher(cfg)
        assert names_for(store, "broken.dcm") == ["Archive", "Teaching", "Workstation"]


def test_e2e_the_want_set_is_per_file_within_one_study():
    # Two instances of one study, routed to different nodes. The folder may only
    # be archived when BOTH have reached their own set.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, THREE, on_success="move", rules=[
            {"name": "ct", "match": {"modality": "CT"},
             "destinations": ["Archive"], "stop": True},
            {"name": "us", "match": {"modality": "US"},
             "destinations": ["Teaching"], "stop": True}])
        out = cfg.resolved("scu", "watch_dir")
        study = os.path.join(out, "study1")
        write_dicom(os.path.join(study, "a.dcm"), modality="CT")
        write_dicom(os.path.join(study, "b.dcm"), modality="US")
        store = FakeStore(fail={"Teaching"})
        w, store = run_watcher(cfg, store=store)
        assert names_for(store, "a.dcm") == ["Archive"]
        assert names_for(store, "b.dcm") == ["Teaching"]
        assert os.path.isdir(study), "archived while b.dcm still owed Teaching"
        store.fail.clear()
        w.state.clear_backoff()
        with fake_store(store):
            scan(w, 1)
        assert not os.path.exists(study)
        assert os.path.isfile(os.path.join(cfg.resolved("scu", "sent_dir"), "study1", "b.dcm"))


def test_e2e_a_narrow_route_archives_without_the_nodes_it_never_owed():
    # The other direction: a study routed to one node must not wait forever for
    # the two it was never sent to.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, THREE, on_success="move", rules=[
            {"name": "ct", "match": {"modality": "CT"},
             "destinations": ["Archive"], "stop": True}])
        out = cfg.resolved("scu", "watch_dir")
        write_dicom(os.path.join(out, "a.dcm"))
        _, store = run_watcher(cfg)
        assert names_for(store) == ["Archive"]
        assert os.path.isfile(os.path.join(cfg.resolved("scu", "sent_dir"), "a.dcm"))


def test_e2e_a_wide_route_is_not_archived_until_the_last_node_accepts():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, THREE, on_success="delete", rules=[
            {"name": "ct", "match": {"modality": "CT"},
             "destinations": ["Archive", "Teaching"], "stop": True}])
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        store = FakeStore(fail={"Teaching"})
        w, store = run_watcher(cfg, store=store)
        assert os.path.exists(p)
        store.fail.clear()
        w.state.clear_backoff()
        with fake_store(store):
            scan(w, 1)
        assert not os.path.exists(p)
        assert names_for(store) == ["Archive", "Teaching"]


def test_e2e_a_deleted_destination_unpins_a_stuck_study():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, THREE, on_success="move", rules=[
            {"name": "ct", "match": {"modality": "CT"},
             "destinations": ["Archive", "Teaching"], "stop": True}])
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        w, store = run_watcher(cfg, store=FakeStore(fail={"Teaching"}))
        assert os.path.exists(p)
        cfg.data["destinations"] = [d for d in cfg.data["destinations"]
                                    if d["name"] != "Teaching"]
        with fake_store(store):
            scan(w, 1)
        assert os.path.isfile(os.path.join(cfg.resolved("scu", "sent_dir"), "a.dcm"))


def test_e2e_a_report_beside_a_study_is_siphoned_to_the_review_queue():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive")], on_success="move")
        out = cfg.resolved("scu", "watch_dir")
        study = os.path.join(out, "study1")
        write_dicom(os.path.join(study, "a.dcm"))
        with open(os.path.join(study, "report.pdf"), "wb") as fh:
            fh.write(b"%PDF-1.4\n" + b"0" * 64)
        run_watcher(cfg)
        pending = cfg.resolved("scu", "pending_dir")
        staged = [f for _r, _d, fs in os.walk(pending) for f in fs if f == "report.pdf"]
        assert staged == ["report.pdf"], os.listdir(pending)
        assert os.path.isfile(os.path.join(cfg.resolved("scu", "sent_dir"), "study1", "a.dcm"))


def test_e2e_the_archive_pass_moves_the_whole_item_and_leaves_nothing_behind():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive")], on_success="move")
        out = cfg.resolved("scu", "watch_dir")
        study = os.path.join(out, "study1", "series1")
        write_dicom(os.path.join(study, "a.dcm"))
        with open(os.path.join(out, "study1", "notes.txt"), "w") as fh:
            fh.write("inert")
        run_watcher(cfg)
        sent = cfg.resolved("scu", "sent_dir")
        assert os.path.isfile(os.path.join(sent, "study1", "series1", "a.dcm"))
        assert os.path.isfile(os.path.join(sent, "study1", "notes.txt"))
        assert os.listdir(out) == []


def test_e2e_no_enabled_destinations_leaves_everything_untouched():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [], on_success="delete")
        p = write_dicom(os.path.join(cfg.resolved("scu", "watch_dir"), "a.dcm"))
        _, store = run_watcher(cfg)
        assert store.calls == []
        assert os.path.exists(p)


# ============================================ the route is a record, not the truth
# entry["route"] is written in one pass and read back in another, and the config
# can change in between. Every test below changes exactly one thing between the
# two moments and asks whether the archive gate still believes the record. The
# first pass after a restart is where this bites hardest: the stability map
# starts empty, so that pass re-routes NOTHING while the archive gate happily
# judges everything.


def restart(cfg):
    """A service restart: a brand-new watcher over the same config and the same
    on-disk send state, with an empty size map (so its first pass evaluates no
    file at all)."""
    return FolderWatcher(cfg, FakeLog())


def test_a_renamed_destination_does_not_archive_a_study_that_reached_nobody():
    # The BLOCKER, verbatim: one node, on_success=delete, a study waiting because
    # the node is down. The operator changes its LABEL — same host, port and AE —
    # and restarts. The recorded route says "PACS", the live list says "PACS
    # Main", the intersection is empty, and empty is a subset of everything.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("PACS", "10.0.0.1")], on_success="delete")
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        w, _ = run_watcher(cfg, store=FakeStore(fail={"PACS"}))
        assert os.path.exists(p)
        assert w.state.peek(p)["route"] == ["PACS"] and w.state.peek(p)["sent"] == []

        cfg.data["destinations"][0]["name"] = "PACS Main"
        w2 = restart(cfg)
        store = FakeStore()
        with fake_store(store):
            scan(w2, 1)
        assert os.path.exists(p), "study destroyed on a route recorded under the old name"
        assert store.calls == [], "nothing was even sent before it was archived"
        with fake_store(store):
            scan(w2, 1)                     # re-routed under the live name, then sent
        assert names_for(store) == ["PACS Main"], store.calls
        assert not os.path.exists(p)


def test_a_deleted_destination_does_not_make_an_empty_route_look_complete():
    # The same empty intersection reached by deleting the node instead of
    # renaming it, with a second node still enabled so the watcher keeps running.
    # An empty want set means the study owes nobody living — which is to say it
    # reached NOBODY, the opposite of done.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("PACS", "10.0.0.1"), dest("Teaching", "10.0.0.9")],
                          on_success="delete", rules=[
                              {"name": "ct", "match": {"modality": "CT"},
                               "destinations": ["PACS"], "stop": True}])
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        w, _ = run_watcher(cfg, store=FakeStore(fail={"PACS"}))
        assert w.state.peek(p)["route"] == ["PACS"] and w.state.peek(p)["sent"] == []

        cfg.data["destinations"] = [d for d in cfg.data["destinations"]
                                    if d["name"] != "PACS"]
        w2 = restart(cfg)
        store = FakeStore()
        with fake_store(store):
            scan(w2, 1)
        assert os.path.exists(p), "empty want set read as delivered; study destroyed"
        with fake_store(store):
            scan(w2, 1)                     # rule resolves to nothing -> fallback
        assert names_for(store) == ["Teaching"], store.calls
        assert not os.path.exists(p)


def test_the_first_pass_after_a_restart_archives_nothing_it_did_not_evaluate():
    # The mechanism itself, with no config edit at all: the pass that skips every
    # file on the stability gate must not archive on the records it did not touch.
    # One poll interval of patience is the whole cost.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive")], on_success="keep")
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        _, store = run_watcher(cfg)
        assert names_for(store) == ["Archive"]

        cfg.data["scu"]["on_success"] = "move"
        w2 = restart(cfg)
        with fake_store(FakeStore()):
            scan(w2, 1)
        assert os.path.exists(p), "archived a file the pass never routed"
        with fake_store(FakeStore()):
            scan(w2, 1)
        assert os.path.isfile(os.path.join(cfg.resolved("scu", "sent_dir"), "a.dcm"))


def test_a_destination_added_while_the_service_was_down_still_gets_the_backlog():
    # The change nobody thinks of as dangerous: adding a node. The backlog's
    # recorded route predates it, so on the stale record every waiting study is
    # "complete" and gets deleted before the new node is ever dialled.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1")], on_success="keep")
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        run_watcher(cfg)

        cfg.data["destinations"].append(dest("Teaching", "10.0.0.9"))
        cfg.data["scu"]["on_success"] = "delete"
        w2 = restart(cfg)
        store = FakeStore()
        with fake_store(store):
            scan(w2, 1)
        assert os.path.exists(p), "backlog deleted before the new node saw any of it"
        with fake_store(store):
            scan(w2, 1)
        assert names_for(store) == ["Teaching"], store.calls
        assert not os.path.exists(p)


def test_a_rule_widened_while_the_service_was_down_is_honoured_before_archiving():
    # Same shape, reached by editing a rule rather than the destination list.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1"), dest("Teaching", "10.0.0.9")],
                          on_success="keep", rules=[
                              {"name": "ct", "match": {"modality": "CT"},
                               "destinations": ["Archive"], "stop": True}])
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        _, store = run_watcher(cfg)
        assert names_for(store) == ["Archive"]

        cfg.data["routing"]["rules"][0]["destinations"] = ["Archive", "Teaching"]
        cfg.data["scu"]["on_success"] = "delete"
        w2 = restart(cfg)
        store = FakeStore()
        with fake_store(store):
            scan(w2, 1)
        assert os.path.exists(p), "deleted on the route the widened rule replaced"
        with fake_store(store):
            scan(w2, 1)
        assert names_for(store) == ["Teaching"], store.calls
        assert not os.path.exists(p)


def test_a_pinned_destination_removed_from_the_config_holds_the_study():
    # The defect without a restart: a route may also SHRINK while the process
    # runs. Once the file is re-routed each pass, the only thing that can drop
    # out of its route is a pin — a delivery already promised to the primary by
    # hold-and-forward. Removing the node does not cancel the promise, so the
    # study waits where the stuck panel can see it, and says so once.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Primary", "10.0.0.1"), dest("Teaching", "10.0.0.9")],
                          on_success="delete")
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        log = FakeLog()
        w = FolderWatcher(cfg, log)
        w.state.pin(p, ["Primary"])
        with fake_store(FakeStore(fail={"Primary"})):
            scan(w, 2)
        assert os.path.exists(p)
        assert w.state.peek(p)["sent"] == ["Teaching"]

        cfg.data["destinations"] = [d for d in cfg.data["destinations"]
                                    if d["name"] != "Primary"]
        with fake_store(FakeStore()):
            scan(w, 1)
        assert os.path.exists(p), "held copy destroyed with the primary's promise unmet"
        said = [m for m in log.warnings if "Primary" in m]
        assert said, log.entries
        with fake_store(FakeStore()):
            scan(w, 3)
        assert os.path.exists(p)
        # Still held, and still only said once: the condition lasts until the
        # operator acts, and the log has a send history to be readable for.
        assert [m for m in log.warnings if "Primary" in m] == said


def test_a_dead_destination_is_still_unpinned_by_deleting_it():
    # The counterweight to the test above: the escape hatch has to survive. A
    # study stuck on a node the operator deletes drains on the next pass, because
    # the pass re-routes it and the dead name is simply no longer in its route.
    # Only a PIN outlives the config.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1"), dest("Teaching", "10.0.0.9")],
                          on_success="move")
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        w, store = run_watcher(cfg, store=FakeStore(fail={"Teaching"}))
        assert os.path.exists(p)
        cfg.data["destinations"] = [d for d in cfg.data["destinations"]
                                    if d["name"] != "Teaching"]
        with fake_store(store):
            scan(w, 1)
        assert os.path.isfile(os.path.join(cfg.resolved("scu", "sent_dir"), "a.dcm"))


# ==================================== the config can also change DURING a pass
# Everything above changes the config between two passes. A pass is not a
# moment though: one C-STORE association can hold it open for minutes, which is
# ample time for an operator to hit Save. The pass then routes and sends under
# one destination list and archives under another, inside a single _scan_once.


class SavingStore(FakeStore):
    """A C-STORE that takes a config save while the association is open.

    The mutation lands after the pass has snapshotted its destination list and
    before the archive gate reads it back — the window a between-passes edit
    cannot reach."""

    def __init__(self, cfg, mutate, fail=()):
        super().__init__(fail=fail)
        self.cfg = cfg
        self.mutate = mutate
        self.saved = False

    def __call__(self, dst, filepath, calling_aet, timeout=30, tls_context=None):
        res = super().__call__(dst, filepath, calling_aet, timeout=timeout,
                               tls_context=tls_context)
        if not self.saved:
            self.saved = True
            self.mutate(self.cfg)
        return res


def test_a_destination_added_mid_pass_is_not_archived_around():
    # One destination, on_success=delete, a study draining. The pass routes to
    # "Archive" and C-STOREs it; while that association is open the operator
    # adds "Teaching" and saves. The archive gate at the end of the SAME pass
    # still holds the pre-edit want set, so the study is deleted before the node
    # the operator just configured is ever dialled.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1")], on_success="delete")
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        w = FolderWatcher(cfg, FakeLog())
        with fake_store(FakeStore()):
            scan(w, 1)                      # stability pass: nothing sent yet

        def add_teaching(c):
            c.data["destinations"].append(dest("Teaching", "10.0.0.9"))

        store = SavingStore(cfg, add_teaching)
        with fake_store(store):
            scan(w, 1)                      # routes, sends, and the save lands mid-send
        assert names_for(store) == ["Archive"], store.calls
        assert os.path.exists(p), "deleted on the pre-edit list; Teaching never saw it"
        with fake_store(store):
            scan(w, 1)                      # re-routed against the config as saved
        assert names_for(store) == ["Archive", "Teaching"], store.calls
        assert not os.path.exists(p)


def test_a_destination_renamed_mid_pass_is_not_archived_around():
    # The same window reached by a rename instead of an addition: the study is
    # delivered to "Archive", and by the time the archive gate runs there is no
    # node of that name at all. Deleting it here destroys the only copy the
    # renamed node has not been asked for yet.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1")], on_success="delete")
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        w = FolderWatcher(cfg, FakeLog())
        with fake_store(FakeStore()):
            scan(w, 1)

        def rename(c):
            c.data["destinations"][0]["name"] = "Archive Main"

        store = SavingStore(cfg, rename)
        with fake_store(store):
            scan(w, 1)
        assert os.path.exists(p), "deleted mid-rename, with the new name never dialled"
        with fake_store(store):
            scan(w, 1)
        assert names_for(store) == ["Archive", "Archive Main"], store.calls
        assert not os.path.exists(p)


def test_on_success_switched_to_keep_mid_pass_is_honoured():
    # The config change that is not about routing at all. The operator decides
    # mid-drain that nothing should be deleted; the pass is already holding
    # on_success="delete" and would act on it.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1")], on_success="delete")
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        w = FolderWatcher(cfg, FakeLog())
        with fake_store(FakeStore()):
            scan(w, 1)

        def stop_deleting(c):
            c.data["scu"]["on_success"] = "keep"

        with fake_store(SavingStore(cfg, stop_deleting)):
            scan(w, 2)
        assert os.path.exists(p), "deleted after the operator turned deletion off"


def test_a_pass_with_no_config_change_still_archives():
    # The counterweight: the guard must cost one pass per SAVE, not one pass
    # per pass. Nothing touches the config here and the study drains as usual.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1")], on_success="delete")
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        w, store = run_watcher(cfg)
        assert names_for(store) == ["Archive"]
        assert not os.path.exists(p)


# ============================== a pass may only SEND under the config it began under
# The tests above all end at the archive gate, which is only the LAST thing a
# pass does. Everything before it — the destination list, the TLS context, the
# router, the de-identifier — is read once at the top of the pass and then used
# for every file in it. A save landing mid-pass therefore does not just archive
# on stale settings, it SENDS on them: the remaining files of that pass go out
# under the config the operator has already replaced. For de-identification that
# is a PHI leak, so the invariant is stated as a rule about sending, not about
# archiving: no file may leave under a de-identification setting the operator has
# already replaced.


class PhiStore(FakeStore):
    """A saving C-STORE that also records what was ON THE WIRE.

    The bytes handed to the SCU are not the file the log names — a scrubbed copy
    travels under a temp name — so the patient identity is read back out of
    whatever was actually sent, together with whether the operator's save had
    already landed when it went out. Those two columns are the whole test:
    nothing carrying PHI may appear after the save."""

    def __init__(self, cfg, mutate, fail=()):
        super().__init__(fail=fail)
        self.cfg = cfg
        self.mutate = mutate
        self.saved = False
        self.wire = []          # (dest name, patient name on the wire, save had landed)

    def __call__(self, dst, filepath, calling_aet, timeout=30, tls_context=None):
        from pydicom import dcmread
        self.wire.append((dst.name, str(dcmread(filepath).PatientName), self.saved))
        res = super().__call__(dst, filepath, calling_aet, timeout=timeout,
                               tls_context=tls_context)
        if not self.saved:
            self.saved = True
            self.mutate(self.cfg)
        return res

    @property
    def leaked(self):
        """Sends that carried the real patient name after the save landed."""
        return [w for w in self.wire if w[2] and w[1] == "Doe^Jane"]

    def leaked_to(self, name):
        """The same question asked of ONE destination.

        `leaked` answers it for the whole wire, which is only the right question
        when every node in the test is one a rule scrubs for. Once a plain
        destination is in the config to give the save its moment, identified
        copies going THERE are the send working, not the leak."""
        return [w for w in self.wire if w[0] == name and w[2] and w[1] == "Doe^Jane"]


def _three_files(cfg):
    out = cfg.resolved("scu", "watch_dir")
    return [write_dicom(os.path.join(out, f"{n}.dcm")) for n in ("a", "b", "c")]


def saving(change):
    """A dashboard Save as the server really performs one.

    PacsServer.apply_config hands the whole object to Config.replace, which
    validates it and assigns a freshly merged dict — so every nested dict a pass
    captured (or a Router is holding) is left pointing at the object the operator
    replaced. Editing cfg.data in place instead would ALIAS into those holders and
    let a stale reader see the new value by accident, which is exactly the thing
    under test."""
    import copy

    def do(cfg):
        data = copy.deepcopy(cfg.data)
        change(data)
        cfg.replace(data)
    return do


def test_a_rule_flipped_to_deidentify_mid_pass_does_not_ship_the_rest_identified():
    # The reported leak, verbatim: three files, one destination, deid.profile
    # already 'basic', and the operator edits the rule to deidentify:true while
    # the first C-STORE is open. The router was read once at the top of the pass,
    # so files two and three go out IDENTIFIED to the node the operator has just
    # said must only ever receive anonymised studies.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Teaching", "10.0.0.9")], on_success="keep",
                          rules=[rule("all", ["Teaching"], deid=False)])
        cfg.data["deid"]["profile"] = "basic"
        _three_files(cfg)
        w = FolderWatcher(cfg, FakeLog())
        with fake_store(FakeStore()):
            scan(w, 1)                      # stability pass: nothing sent yet

        def scrub_from_now_on(data):
            data["routing"]["rules"][0]["deidentify"] = True

        store = PhiStore(cfg, saving(scrub_from_now_on))
        with fake_store(store):
            scan(w, 1)                      # the save lands inside the first send
        assert not store.leaked, store.wire
        # And the pass that was abandoned has to resume, not lose the files: the
        # two that did not go out are re-routed under the new rule and scrubbed.
        with fake_store(store):
            scan(w, 2)
        assert len(store.wire) == 3, store.wire
        assert len([x for x in store.wire if x[1] != "Doe^Jane"]) == 2, store.wire


def test_deid_switched_on_mid_pass_does_not_ship_the_rest_identified():
    # The same leak reached through the profile instead of the rule. The rule
    # asks for scrubbing all along and deid.profile is 'off', so Teaching is
    # HELD; the operator does what the hold says and turns the profile on, and
    # the save lands mid-pass. _deidentifier() is read once at the top of a pass,
    # so the fix must not reach the files still queued behind it half-applied.
    #
    # Archive is the moment-maker: it is in no rule that scrubs, so it receives
    # identified copies throughout (that is the send working) and its first
    # C-STORE is where the save is dropped in. Teaching is the subject, and the
    # claim is about Teaching alone.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1"), dest("Teaching", "10.0.0.9")],
                          on_success="keep",
                          rules=[rule("everything", ["Archive"]),
                                 rule("scrub", ["Teaching"], deid=True)])
        cfg.data["deid"]["profile"] = "off"
        _three_files(cfg)
        w = FolderWatcher(cfg, FakeLog())
        w.router.bind(cfg)          # PacsServer's wiring, without a PacsServer
        with fake_store(FakeStore()):
            scan(w, 1)

        def turn_deid_on(data):
            data["deid"]["profile"] = "basic"

        store = PhiStore(cfg, saving(turn_deid_on))
        with fake_store(store):
            scan(w, 1)
        with fake_store(store):
            scan(w, 3)
        # Nothing carrying the identity ever reached the node a rule scrubs for
        # — before the save it was held, after it, it was scrubbed.
        assert [x for x in store.wire if x[0] == "Teaching" and x[1] == "Doe^Jane"] == [], \
            store.wire
        teaching = [x for x in store.wire if x[0] == "Teaching"]
        assert len(teaching) == 3, store.wire
        assert not store.leaked_to("Teaching"), store.wire
        # Archive is in no rule that scrubs, so it gets identified copies of all
        # three throughout — the hold withholds one destination, not the study.
        assert len([x for x in store.wire if x[0] == "Archive"]) == 3, store.wire


def test_a_destination_disabled_mid_pass_receives_nothing_more_from_that_pass():
    # Not a PHI question — the same staleness in the destination list. The pass
    # snapshotted [Archive, Teaching]; the operator disables Teaching while the
    # first C-STORE is open. Every send after that moment is to a node the
    # operator has withdrawn, and there are five of them.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1"), dest("Teaching", "10.0.0.9")],
                          on_success="keep")
        _three_files(cfg)
        w = FolderWatcher(cfg, FakeLog())
        with fake_store(FakeStore()):
            scan(w, 1)

        def drop_teaching(data):
            data["destinations"][1]["enabled"] = False

        store = SavingStore(cfg, saving(drop_teaching))
        with fake_store(store):
            scan(w, 1)
        assert [c for c in store.calls if c[0] == "Teaching"] == [], store.calls
        # Resumed under the new list, and nothing is sent twice: the abandoned
        # pass persisted what it had already delivered.
        with fake_store(store):
            scan(w, 2)
        assert sorted(c[3] for c in store.calls) == ["a.dcm", "b.dcm", "c.dcm"], store.calls


# ================================================= a NAME is not a MACHINE
# entry["sent"] records destination names. A name is a label an operator can
# re-point at another host, port or called AE at any time, and the moment they
# do, every study recorded as delivered to that name is recorded as delivered to
# an address that has never seen it. Nothing downstream notices — the route still
# names an enabled destination, so the archive gate is satisfied and the study is
# moved or deleted. Renaming a node (same machine, new label) already costs a
# re-send; re-pointing one (new machine, same label) cannot be the single edit
# that is treated as no change at all.


def test_a_destination_re_pointed_mid_pass_still_reaches_the_new_host():
    # The case the generation guard was CLAIMED to cover and does not: the guard
    # defers the archive by one pass, and on that next pass the route reads as
    # already satisfied, so the study is deleted having reached only the address
    # the operator has just corrected away.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1")], on_success="delete")
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        w = FolderWatcher(cfg, FakeLog())
        with fake_store(FakeStore()):
            scan(w, 1)

        def repoint(data):
            data["destinations"][0]["host"] = "10.0.0.2"

        store = SavingStore(cfg, saving(repoint))
        with fake_store(store):
            scan(w, 1)                      # stored to 10.0.0.1, then the save lands
        assert os.path.exists(p), "archived on the pre-edit address"
        with fake_store(store):
            scan(w, 1)
        assert store.hosts_for("a.dcm") == ["10.0.0.1", "10.0.0.2"], store.calls
        assert not os.path.exists(p)


def test_a_destination_re_pointed_between_passes_still_reaches_the_new_host():
    # The same hole with no mid-pass timing at all — the record outlives the
    # config here exactly as it does within one pass, which is why this is fixed
    # at the record and not at the generation fingerprint.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1", port=104, aet="REMOTE")],
                          on_success="keep")
        out = cfg.resolved("scu", "watch_dir")
        write_dicom(os.path.join(out, "a.dcm"))
        w, store = run_watcher(cfg)
        assert store.hosts_for("a.dcm") == ["10.0.0.1"]
        cfg.data["destinations"][0]["host"] = "10.0.0.2"
        with fake_store(store):
            scan(w, 1)
        assert store.hosts_for("a.dcm") == ["10.0.0.1", "10.0.0.2"], store.calls
        # A called AE re-pointed under the same name is another machine too.
        cfg.data["destinations"][0]["aet"] = "OTHER"
        with fake_store(store):
            scan(w, 1)
        assert [c for c in store.calls if c[3] == "a.dcm"][-1][:3] == ("Archive", "10.0.0.2", 104)
        assert len([c for c in store.calls if c[3] == "a.dcm"]) == 3, store.calls


def test_an_unchanged_destination_is_never_re_sent():
    # The counterweight: re-delivery must cost one send per RE-POINT, not one per
    # pass. Nothing touches the address here and the study is sent exactly once
    # however long it sits in the outgoing folder.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1")], on_success="keep")
        write_dicom(os.path.join(cfg.resolved("scu", "watch_dir"), "a.dcm"))
        _, store = run_watcher(cfg, passes=6)
        assert len(store.calls) == 1, store.calls


def test_a_send_recorded_before_node_identity_was_tracked_is_not_re_sent():
    # An entry written by an older build, or by the manual-send path, carries no
    # record of WHICH machine took the study. Adopting the live address is the
    # only reading that does not re-transmit the whole outgoing folder on the
    # first pass after an upgrade — the alternative is a flood nobody asked for.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1")], on_success="keep")
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        w, store = run_watcher(cfg)
        entry = dict(w.state.peek(p))
        entry.pop("sent_to", None)          # as an older sidecar would have it
        w.state.put(p, entry)
        with fake_store(store):
            scan(w, 2)
        assert len(store.calls) == 1, store.calls


# ============================================ a held study has to be VISIBLE
# Refusing to archive a study whose destination left the config is the right
# trade — retention beats deletion for images — but a hold nothing retries and
# nobody can see is just a slower leak. The stuck panel is where the operator
# already looks, so it has to say so there.


def test_a_destination_that_left_the_config_shows_up_in_the_stuck_panel():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Primary", "10.0.0.1"), dest("Teaching", "10.0.0.9")],
                          on_success="delete")
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        from pacs.server import PacsServer
        srv = PacsServer(cfg)
        w = srv.watcher
        w.state.pin(p, ["Primary"])                  # hold-and-forward's promise
        with fake_store(FakeStore(fail={"Primary"})):
            scan(w, 2)
        assert os.path.exists(p) and w.state.peek(p)["sent"] == ["Teaching"]

        # While Primary is configured this is an ordinary backoff-stuck send.
        panel = srv.stuck_sends()
        assert [d["name"] for d in panel["destinations"]] == ["Primary"]
        assert panel["files"] == 1 and panel["orphaned"] == []

        cfg.data["destinations"] = [d for d in cfg.data["destinations"]
                                    if d["name"] != "Primary"]
        with fake_store(FakeStore()):
            scan(w, 1)
        assert os.path.exists(p), "held copy destroyed with the promise unmet"

        panel = srv.stuck_sends()
        # The old panel goes quiet — correctly, there is nothing to retry — and
        # the study appears in its own list instead of vanishing from both.
        assert panel["destinations"] == [] and panel["files"] == 0
        orphan = panel["orphaned"]
        assert [o["name"] for o in orphan] == ["Primary"], panel
        assert orphan[0]["instances"] == 1
        assert orphan[0]["pinned"] is True
        assert orphan[0]["files"] == ["a.dcm"] and orphan[0]["more"] == 0
        assert "Primary" in orphan[0]["message"]
        assert panel["orphaned_files"] == 1 and panel["attention_files"] == 1
        # And the badge the operator actually sees is no longer zero.
        assert srv.stuck_count() == 1
        assert srv.status()["stuck"] == 1


def test_an_orphaned_route_that_was_never_pinned_is_reported_too():
    # Not only pins fall out of a route: a node deleted while a study waited on
    # it leaves the same unretryable owing behind on the pass that recorded it.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1"), dest("Teaching", "10.0.0.9")],
                          on_success="keep")
        out = cfg.resolved("scu", "watch_dir")
        write_dicom(os.path.join(out, "a.dcm"))
        from pacs.server import PacsServer
        srv = PacsServer(cfg)
        with fake_store(FakeStore(fail={"Teaching"})):
            scan(srv.watcher, 2)
        cfg.data["destinations"] = [d for d in cfg.data["destinations"]
                                    if d["name"] != "Teaching"]
        panel = srv.stuck_sends()
        assert [o["name"] for o in panel["orphaned"]] == ["Teaching"], panel
        assert panel["orphaned"][0]["pinned"] is False
        assert panel["orphaned_files"] == 1


def test_the_orphan_list_names_a_bounded_sample_of_files():
    # A department-sized backlog must not turn one API response into a
    # megabyte of file names.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Primary", "10.0.0.1"), dest("Teaching", "10.0.0.9")],
                          on_success="keep")
        out = cfg.resolved("scu", "watch_dir")
        paths = [write_dicom(os.path.join(out, f"f{i}.dcm")) for i in range(14)]
        from pacs.server import PacsServer
        srv = PacsServer(cfg)
        for p in paths:
            srv.watcher.state.pin(p, ["Primary"])
        with fake_store(FakeStore(fail={"Primary"})):
            scan(srv.watcher, 2)
        cfg.data["destinations"] = [d for d in cfg.data["destinations"]
                                    if d["name"] != "Primary"]
        row = srv.stuck_sends()["orphaned"][0]
        assert row["instances"] == 14
        assert len(row["files"]) == PacsServer._ORPHAN_SAMPLE
        assert row["more"] == 14 - PacsServer._ORPHAN_SAMPLE


def test_a_file_stuck_and_orphaned_at_once_counts_as_one_for_the_badge():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Primary", "10.0.0.1"), dest("Teaching", "10.0.0.9")],
                          on_success="keep")
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        from pacs.server import PacsServer
        srv = PacsServer(cfg)
        srv.watcher.state.pin(p, ["Primary"])
        with fake_store(FakeStore(fail={"Primary", "Teaching"})):
            scan(srv.watcher, 2)
        cfg.data["destinations"] = [d for d in cfg.data["destinations"]
                                    if d["name"] != "Primary"]
        panel = srv.stuck_sends()
        assert panel["files"] == 1 and panel["orphaned_files"] == 1
        assert panel["attention_files"] == 1        # one file, not two
        assert srv.stuck_count() == 1


def test_nothing_owing_reports_an_empty_panel_in_every_list():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1")], on_success="keep")
        write_dicom(os.path.join(cfg.resolved("scu", "watch_dir"), "a.dcm"))
        from pacs.server import PacsServer
        srv = PacsServer(cfg)
        with fake_store(FakeStore()):
            scan(srv.watcher, 2)
        panel = srv.stuck_sends()
        assert panel == {"destinations": [], "files": 0, "orphaned": [],
                         "orphaned_files": 0, "held": [], "held_files": 0,
                         "attention_files": 0}
        assert srv.stuck_count() == 0


# ------------------------------------------------------ and so does a HELD study
# The hold is the one owing in this system that is never dialled, so it never
# fails, and record_route keeps the held name out of entry["route"] on purpose —
# the route is the list a sender walks. Between them that put a held study out of
# reach of BOTH lists above: no failure for the backoff list, no route entry for
# the orphan list. The panel reported zero while the outgoing folder grew.


def test_a_held_study_is_visible_in_the_stuck_panel():
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Research", "10.0.0.9")], on_success="delete",
                          rules=[rule("research", ["Research"], deid=True)])
        cfg.data["scp"]["enabled"] = False
        cfg.data["deid"]["profile"] = "off"
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        srv = PacsServer(cfg)
        with fake_store(FakeStore()) as store:
            scan(srv.watcher, 3)
        # The measured state from the report: nothing dialled, nothing failed,
        # nothing archived, an empty route and a recorded hold.
        assert store.calls == [] and os.path.exists(p)
        e = srv.watcher.state.peek(p)
        assert e["route"] == [] and e["held"] == ["Research"] and e["sent"] == []
        assert e["fail"] == {}

        panel = srv.stuck_sends()
        # The two existing lists are right to be empty — there is nothing to
        # retry and no departed node — and the contract they render is untouched.
        assert panel["destinations"] == [] and panel["files"] == 0
        assert panel["orphaned"] == [] and panel["orphaned_files"] == 0
        rows = [h for h in panel["held"] if h["name"] == "Research"]
        assert rows, panel
        row = rows[0]
        assert row["instances"] == 1 and row["files"] == ["a.dcm"] and row["more"] == 0
        assert row["cause"] == routing.HOLD_PROFILE_OFF, row
        assert "deid.profile" in row["reason"], row
        assert "deidentify" in row["remedy"], row
        assert "Research" in row["message"], row
        assert panel["held_files"] == 1 and panel["attention_files"] == 1
        # The badge the operator actually watches.
        assert srv.stuck_count() == 1
        assert srv.status()["stuck"] == 1

        # One edit releases it, and the panel goes quiet on its own.
        cfg.data["deid"]["profile"] = "basic"
        with fake_store(FakeStore()):
            scan(srv.watcher, 2)
        panel = srv.stuck_sends()
        assert panel["held"] == [] and panel["held_files"] == 0
        assert srv.stuck_count() == 0
        assert not os.path.exists(p), "released and delivered, so it may be archived"


def test_a_held_row_prescribes_the_remedy_for_the_cause_it_was_STAMPED_with():
    """The stuck panel, per hold cause. The row used to assert one of them.

    It said "a routing rule asks for de-identification and deid.profile is 'off'"
    over every held row, and prescribed turning the profile on. Reached the other
    way — profile ON, nothing buildable to scrub with — that sentence is false
    where it matters most: the operator turns on a profile that is already on,
    nothing happens, and the only other thing the row offers is taking
    'deidentify' off the rule, which releases the study by forwarding it
    IDENTIFIED to the one node a rule exists to scrub for. The panel's single
    remedy was the harm.

    Driven off the recorded state rather than the live config, because that is
    what the panel reads: record_route stamps entry["hold_cause"] at the moment
    of the decision, and rows outlive the settings that produced them.
    """
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Research", "10.0.0.9")], on_success="keep",
                          rules=[rule("research", ["Research"], deid=True)])
        cfg.data["scp"]["enabled"] = False
        out = cfg.resolved("scu", "watch_dir")
        paths = [write_dicom(os.path.join(out, n)) for n in ("a.dcm", "b.dcm")]
        srv = PacsServer(cfg)

        def row_for(stamps) -> dict:
            """One held row, over entries stamped with *stamps* (one per file)."""
            for p, cause in zip(paths, stamps):
                e = {"sent": [], "route": [], "held": ["Research"],
                     "size": os.path.getsize(p), "mtime": int(os.path.getmtime(p))}
                if cause is not None:
                    e["hold_cause"] = cause
                srv.watcher.state.put(p, e)
            rows = srv.stuck_sends()["held"]
            assert len(rows) == 1, rows
            return rows[0]

        off = row_for([routing.HOLD_PROFILE_OFF] * 2)
        assert off["cause"] == routing.HOLD_PROFILE_OFF
        assert "deid.profile is 'off'" in off["reason"], off
        assert "Turn the de-identification profile on" in off["remedy"], off

        none = row_for([routing.HOLD_NO_DEIDENTIFIER] * 2)
        assert none["cause"] == routing.HOLD_NO_DEIDENTIFIER
        # The true cause, and NOT the other one asserted anywhere in the row.
        assert "no de-identifier could be built" in none["reason"], none
        assert "deid.profile is 'off'" not in none["message"], none
        assert "Turn the de-identification profile on" not in none["message"], none
        # And the remedy leads away from the two edits that do harm or nothing.
        assert "Do NOT turn the profile off" in none["remedy"], none
        assert "IDENTIFIED" in none["remedy"], none

        # An entry written before hold_cause existed, and a row whose instances
        # disagree: two ways to have no cause worth asserting, and the same
        # answer — say what is true, name neither.
        for stamps in ([None, None], [routing.HOLD_PROFILE_OFF, routing.HOLD_NO_DEIDENTIFIER]):
            quiet = row_for(stamps)
            assert quiet["cause"] == "", stamps
            assert "deid.profile is 'off'" not in quiet["message"], stamps
            assert "the profile is ON" not in quiet["message"], stamps
            assert "Look at the de-identification profile" in quiet["remedy"], stamps


def test_a_file_held_and_stuck_at_once_counts_as_one_for_the_badge():
    # Two owings on one file — Archive backing off, Research held — and one file
    # needing attention. The badge counts files, not owings.
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1"), dest("Research", "10.0.0.9")],
                          on_success="keep",
                          rules=[rule("everything", ["Archive"]),
                                 rule("research", ["Research"], deid=True)])
        cfg.data["scp"]["enabled"] = False
        cfg.data["deid"]["profile"] = "off"
        out = cfg.resolved("scu", "watch_dir")
        write_dicom(os.path.join(out, "a.dcm"))
        srv = PacsServer(cfg)
        with fake_store(FakeStore(fail={"Archive"})):
            scan(srv.watcher, 2)
        panel = srv.stuck_sends()
        assert [d["name"] for d in panel["destinations"]] == ["Archive"]
        assert [h["name"] for h in panel["held"]] == ["Research"]
        assert panel["files"] == 1 and panel["held_files"] == 1
        assert panel["attention_files"] == 1
        assert srv.stuck_count() == 1


def test_a_hold_on_a_node_that_already_received_the_study_is_not_reported():
    # A study delivered under a working profile, then the profile turned off. The
    # file is not 'done' any more (fully_sent refuses a recorded hold), but this
    # node has the study, and a row saying otherwise sends the operator chasing a
    # delivery that happened.
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Research", "10.0.0.9")], on_success="keep",
                          rules=[rule("research", ["Research"], deid=True)])
        cfg.data["scp"]["enabled"] = False
        cfg.data["deid"]["profile"] = "basic"
        out = cfg.resolved("scu", "watch_dir")
        p = write_dicom(os.path.join(out, "a.dcm"))
        srv = PacsServer(cfg)
        with fake_store(FakeStore()) as store:
            scan(srv.watcher, 2)
        # Not names_for(): a scrubbed copy travels under a temp name, so the file
        # on the wire is not the file in the outgoing folder.
        assert [n for n, _h, _p, _f in store.calls] == ["Research"], store.calls
        assert srv.watcher.state.peek(p)["sent"] == ["Research"]
        cfg.data["deid"]["profile"] = "off"
        with fake_store(FakeStore()):
            scan(srv.watcher, 1)
        assert srv.watcher.state.peek(p)["held"] == ["Research"]
        panel = srv.stuck_sends()
        assert panel["held"] == [], panel
        assert srv.stuck_count() == 0


# ==================== the two halves of ONE de-identification decision
# A rule's `deidentify` says WHICH destinations get a scrubbed copy; deid.profile
# says whether scrubbing can happen at all ("Off — send studies exactly as
# received"). They used to be read in two different places, so with the profile
# off and a rule asking for a scrub the engine reported "de-identified" to
# /api/routing/test, to /api/status and to the dashboard while the senders,
# finding no de-identifier, forwarded the study IDENTIFIED. The operator asked
# for de-identification, was told it was happening, and the identity left the
# building.
#
# The engine now answers both halves in one place (routing.Router) and HOLDS: a
# destination a rule asks to scrub is not sent to at all while the profile is
# off. The tests below hold every reader of that decision to it — the watcher and
# the manual send against a REAL Storage SCP, the status payload, and the
# dashboard's own rendering.


class DeidCfg:
    """The only thing Router.bind() reads off a Config: cfg.deid."""

    def __init__(self, profile="basic"):
        self.deid = {"profile": profile}


def deid_router(rules, enabled=ALL, profile="off", log=None):
    return Router({"enabled": True, "rules": list(rules)}, enabled,
                  log=log, cfg=DeidCfg(profile))


def test_a_rule_that_scrubs_while_the_profile_is_off_is_a_hold_not_a_scrub():
    log = FakeLog()
    d = deid_router([rule("research", ["Teaching"], deid=True)], log=log).route(
        attrs=attrs(modality="CT"))
    # The claim that mattered: nothing may say this study is de-identified.
    assert d.deidentify is False and d.needs_deid("Teaching") is False
    assert d.deid_dests == frozenset()
    assert d.held == frozenset({"Teaching"})
    assert d.is_held("Teaching")
    # Still in the decision (it is owed), never in what a sender walks.
    assert d.destinations == ("Teaching",) and d.sendable == ()
    body = d.as_dict()
    assert body["deidentify"] == [] and body["held"] == ["Teaching"]
    assert body["sendable"] == []
    assert "deid.profile" in body["reason"]
    assert any("deid.profile" in m for _l, m, _f in log.entries if _l == "error"), log.entries


def test_the_same_rule_with_a_profile_on_scrubs_and_holds_nothing():
    d = deid_router([rule("research", ["Teaching"], deid=True)],
                    profile="basic").route(attrs=attrs(modality="CT"))
    assert d.deidentify and d.needs_deid("Teaching")
    assert d.held == frozenset() and d.sendable == ("Teaching",)


def test_a_second_rule_without_deidentify_does_not_buy_an_identified_copy():
    # Two rules, same node: one scrubs, one does not. The union is taken in the
    # safe direction, so with the profile off the node is held, not sent to.
    d = deid_router([rule("scrub", ["Teaching"], deid=True, modality="CT"),
                     rule("everything", ["Teaching"])]).route(attrs=attrs(modality="CT"))
    assert d.held == frozenset({"Teaching"}) and d.sendable == ()


def test_an_unbound_router_assumes_the_default_profile():
    # A Router with no Config cannot read deid.profile and must not hold every
    # de-identified route on a guess. PacsServer binds the one production router
    # built this way (see the wiring test below).
    r = router([rule("research", ["Teaching"], deid=True)])
    assert r.deid_profile == "basic" and r.deid_available
    assert r.route(attrs=attrs()).held == frozenset()


def test_record_route_keeps_a_held_destination_out_of_the_route_and_out_of_done():
    d = Decision(destinations=("Archive", "Research"), deid_dests=frozenset(),
                 held=frozenset({"Research"}))
    entry = {"sent": ["Archive"]}
    assert record_route(entry, d) is True
    assert entry["route"] == ["Archive"], "a held destination is still dialled"
    assert entry["held"] == ["Research"]
    # Dropping the name from the route without recording the hold would read as
    # "everything it owes has accepted it" — archived, and under delete, gone.
    assert fully_sent(entry, ["Archive", "Research"]) is False
    # Released the moment the profile comes back on.
    freed = Decision(destinations=("Archive", "Research"),
                     deid_dests=frozenset({"Research"}))
    assert record_route(entry, freed) is True
    assert entry["route"] == ["Archive", "Research"] and "held" not in entry
    assert fully_sent(entry, ["Archive", "Research"]) is False   # Research not sent yet
    entry["sent"].append("Research")
    assert fully_sent(entry, ["Archive", "Research"]) is True


def test_a_pin_does_not_release_a_held_destination():
    # A pin is a promise to DELIVER; it is not a permission to disclose. The
    # promise survives as a hold rather than as an identified C-STORE.
    d = Decision(destinations=("Research",), held=frozenset({"Research"}))
    entry = {"sent": [], "pin": ["Research"]}
    record_route(entry, d)
    assert entry["route"] == [] and entry["held"] == ["Research"]
    assert fully_sent(entry, ["Research"]) is False


def test_deid_summary_is_the_status_payload_and_ignores_rules_that_cannot_fire():
    on = deid_router([rule("research", ["Teaching"], deid=True)], profile="basic")
    assert on.deid_summary() == {"profile": "basic", "destinations": ["Teaching"], "held": []}
    off = deid_router([rule("research", ["Teaching"], deid=True)])
    assert off.deid_summary() == {"profile": "off", "destinations": [], "held": ["Teaching"]}
    # A rule naming a node that is not enabled scrubs for nobody and holds nobody.
    gone = deid_router([rule("research", ["Gone"], deid=True)])
    assert gone.deid_summary()["held"] == []
    # Routing switched off: no rule fires, so nothing is scrubbed and nothing held.
    dark = Router({"enabled": False, "rules": [rule("research", ["Teaching"], deid=True)]},
                  ALL, cfg=DeidCfg("off"))
    assert dark.deid_summary()["held"] == []


def test_the_hold_is_announced_again_when_the_profile_moves():
    # The warn-once memo is keyed on the config generation, and the profile is
    # part of it: an operator who turns the profile off after the last
    # announcement has to hear about it.
    log = FakeLog()
    cfg = DeidCfg("off")
    r = Router({"enabled": True, "rules": [rule("research", ["Teaching"], deid=True)]},
               ALL, log=log, cfg=cfg)
    r.route(attrs=attrs())
    r.route(attrs=attrs())
    assert len([m for l, m, _ in log.entries if l == "error"]) == 1
    cfg.deid["profile"] = "basic"
    r.update({"enabled": True, "rules": list(r.rules)}, ALL)
    r.route(attrs=attrs())
    cfg.deid["profile"] = "off"
    r.update({"enabled": True, "rules": list(r.rules)}, ALL)
    r.route(attrs=attrs())
    assert len([m for l, m, _ in log.entries if l == "error"]) == 2


# ---------------------------------- the OTHER half: what the sender can scrub WITH
# `deid.profile` is not the only way a scrub can fail to happen. A sender also
# needs a de-identifier OBJECT, and it can be missing (the build raised) or
# present-but-inert (built for the 'off' profile, in which case
# deidentified_tempfile hands back the source path untouched). Every send site
# used to answer "does this destination get scrubbed?" by ANDing the decision
# with its own view of that object:
#
#     scrub = {n for n in todo if deider is not None and decision.needs_deid(n)}
#
# which is a set narrower than the decision promised, sent in the clear and
# reported de-identified. Decision.honoured_by is now the only supported way to
# put the two together, and it can only ever move a name from deid_dests into
# held — never out of both.


class FakeDeider:
    """A de-identifier as the senders judge one: by asking it if it is enabled."""

    def __init__(self, enabled=True):
        self.enabled = enabled


def test_honoured_by_holds_what_it_cannot_scrub_and_says_which_cause():
    d = deid_router([rule("research", ["Teaching"], deid=True)],
                    profile="basic").route(attrs=attrs())
    assert d.deid_dests == frozenset({"Teaching"}) and d.held == frozenset()
    for nothing_usable in (None, FakeDeider(enabled=False)):
        got = d.honoured_by(nothing_usable)
        assert got.deid_dests == frozenset(), nothing_usable
        assert got.deidentify is False, "reported a scrub it cannot back"
        assert got.held == frozenset({"Teaching"}) and got.sendable == ()
        assert got.hold_cause == routing.HOLD_NO_DEIDENTIFIER
        assert "no usable de-identifier" in got.reason
        # The cause is named, and the cause it is NOT is not asserted.
        assert "deid.profile" not in got.hold_message("a.dcm")
        assert "Teaching" in got.hold_message("a.dcm")


def test_honoured_by_leaves_a_scrub_it_can_back_alone_and_is_idempotent():
    d = deid_router([rule("research", ["Teaching"], deid=True)],
                    profile="basic").route(attrs=attrs())
    assert d.honoured_by(FakeDeider()) is d
    off = deid_router([rule("research", ["Teaching"], deid=True)]).route(attrs=attrs())
    # Already held for the other cause: there is nothing left to narrow, and the
    # cause must not be overwritten by the sender's half of the question.
    assert off.honoured_by(None) is off
    assert off.hold_cause == routing.HOLD_PROFILE_OFF
    once = d.honoured_by(None)
    assert once.honoured_by(None) == once


def test_usable_is_asked_of_the_object_not_of_the_config():
    # A Deidentifier built for the 'off' profile is not None, and yields the
    # SOURCE path out of deidentified_tempfile — so `deider is not None` is the
    # wrong question, and asking it forwards identity.
    from pacs.deid import Deidentifier
    inert = Deidentifier(profile="off")
    assert inert is not None and routing.usable_deidentifier(inert) is False
    assert routing.usable_deidentifier(Deidentifier(profile="basic")) is True
    assert routing.usable_deidentifier(None) is False


def test_no_send_site_outside_routing_may_ask_the_scrub_question_itself():
    """The class, not the instance: grep the package for the idiom itself.

    Three rounds fixed this defect in three different files, so the guard is not
    another assertion about one of them. routing.Decision owns "which
    destinations get scrubbed"; no expression anywhere else may combine that
    answer with a de-identifier's availability, because combining them is the
    only way to produce a set narrower than the decision promised. A caller that
    needs both asks Decision.honoured_by, which cannot narrow without holding."""
    import ast
    pkg = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pacs")
    scrub_terms = ("needs_deid", "deid_dests", "deidentify")
    avail_terms = ("deider", "can_scrub", "usable_deidentifier")
    offenders = []
    for root, _dirs, files in os.walk(pkg):
        if "__pycache__" in root:
            continue
        for name in sorted(files):
            if not name.endswith(".py"):
                continue
            path = os.path.join(root, name)
            # routing.py is the one place allowed to hold both halves — that is
            # what makes it the answer.
            if os.path.abspath(path) == os.path.abspath(routing.__file__):
                continue
            src = open(path, encoding="utf-8").read()
            for node in ast.walk(ast.parse(src, path)):
                if not isinstance(node, ast.expr):
                    continue
                seg = ast.get_source_segment(src, node) or ""
                if (any(t in seg for t in scrub_terms)
                        and any(t in seg for t in avail_terms)):
                    offenders.append("%s:%d  %s" % (name, node.lineno, seg.strip()[:120]))
                    break
    assert not offenders, (
        "these expressions re-derive which destinations get scrubbed instead of "
        "taking it from the Decision:\n  " + "\n  ".join(offenders))


# --------------------------------------------- against a REAL Storage SCP
# The bytes on the wire are the only evidence that settles this one: a decision
# object can say anything. These start pacs.scp.StorageSCP on loopback, forward
# to it for real, and read back what it wrote to disk.


def _free_port() -> int:
    import socket
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


@contextlib.contextmanager
def storage_scp(tmp, aet="E2ERECV"):
    """A real receiver on loopback. Yields (its storage folder, its port)."""
    from pacs.scp import StorageSCP
    store = os.path.join(tmp, "arrived")
    os.makedirs(store, exist_ok=True)
    scp = StorageSCP(aet=aet, bind="127.0.0.1", port=_free_port(), storage_dir=store,
                     organize=False, log=FakeLog(), min_free_mb=0)
    scp.start()
    for _ in range(200):
        if scp.running:
            break
        _time.sleep(0.02)
    assert scp.running, "the test SCP never came up"
    try:
        yield store, scp.port
    finally:
        scp.stop()


def arrived_names(store) -> list:
    """The PatientName of every instance the SCP actually wrote."""
    from pydicom import dcmread
    out = []
    for root, _dirs, files in os.walk(store):
        for f in files:
            out.append(str(dcmread(os.path.join(root, f)).PatientName))
    return sorted(out)


def errors_of(srv) -> str:
    return "\n".join(e["message"] for e in srv.log.tail(400) if e["level"] == "error")


def test_e2e_the_watcher_sends_a_real_scp_nothing_when_it_cannot_scrub():
    # The BLOCKER end to end: deid.profile "off" (the dropdown's first option)
    # and a rule with deidentify:true. /api/routing/test, /api/status and the
    # dashboard all AFFIRMED the study would be scrubbed while this path
    # forwarded it identified. Now the identity does not leave, and the study is
    # not lost either — it waits in the outgoing folder, undeleted, until the
    # configuration is fixed.
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        with storage_scp(tmp) as (store, port):
            cfg = make_config(tmp, [dest("Research", "127.0.0.1", port=port, aet="E2ERECV")],
                              on_success="delete",
                              rules=[rule("research", ["Research"], deid=True)])
            cfg.data["scp"]["enabled"] = False
            cfg.data["deid"]["profile"] = "off"
            out = cfg.resolved("scu", "watch_dir")
            p = write_dicom(os.path.join(out, "a.dcm"))
            srv = PacsServer(cfg)
            scan(srv.watcher, 2)
            assert arrived_names(store) == [], \
                "a study left IDENTIFIED while the engine reported de-identification"
            assert os.path.exists(p), "the held study was deleted instead of held"
            assert "deid.profile" in errors_of(srv), errors_of(srv)
            # The decision every other reader sees agrees with the wire.
            d = srv.watcher.router.route(p)
            assert d.deidentify is False and d.held == frozenset({"Research"})

            # One edit releases it, and what arrives is anonymised.
            cfg.data["deid"]["profile"] = "basic"
            scan(srv.watcher, 2)
            names = arrived_names(store)
            assert len(names) == 1 and names[0] != "Doe^Jane", names
            assert not os.path.exists(p), "delivered, so the archive pass may have it"


def _api(srv):
    """A client on the REAL dashboard app — the documented way in."""
    from pacs.web import create_app
    return create_app(srv).test_client()


def _save_over_the_api(client, change):
    """GET /api/config, change one key, POST it back. A dashboard Save."""
    body = client.get("/api/config").get_json()
    change(body)
    r = client.post("/api/config", json=body, headers={"X-Carino": "1"})
    assert r.status_code == 200, (r.status_code, r.get_json())
    return r


@contextlib.contextmanager
def unbuildable_deidentifier(message="site key unreadable"):
    """Deidentifier.from_config raising, for the duration of the block.

    Stands in for every reason construction can fail, and it is a stand-in on
    purpose. The measured one was a JSON number in deid.prefix: POST /api/config
    accepted it, it was inert while the profile was off (from_config returns None
    before it looks at the prefix), and it raised in the constructor the moment
    the operator turned the profile on. Config validation now type-checks that
    field, which closes that particular door — and the watcher must hold whether
    or not the door after it is closed too. Validation is the second line of
    defence here, never the first: a hand-edited file, a field added to DEFAULTS
    tomorrow, or any construction failure validation cannot see all arrive at the
    same state, and the answer to all of them is a hold rather than a forward."""
    from pacs.deid import Deidentifier
    real = Deidentifier.__dict__["from_config"]

    def boom(cls, cfg, log=None):
        raise RuntimeError(message)

    Deidentifier.from_config = classmethod(boom)
    try:
        yield
    finally:
        Deidentifier.from_config = real


def test_e2e_the_watcher_holds_when_the_operators_own_fix_leaves_nothing_to_scrub_with():
    # The BLOCKER, reached the way an operator reaches it, against a real Storage
    # SCP. A quiet, correct site: deid.profile is 'off', a rule scrubs for
    # Research, Research is HELD, and every channel says so.
    #
    # The operator then does exactly what the hold message instructs and turns the
    # profile on, one key, through POST /api/config. Now the router routes to
    # Research — it reads deid.profile live — and the de-identifier cannot be
    # BUILT. The _config_moved fence does not cover that: the config has not
    # moved, it has arrived. The watcher's scrub set was recomputed per send as
    # "asked for AND we happen to have a de-identifier", so Research fell out of
    # it and the study went out IDENTIFIED to the one node a rule scrubs for,
    # while the decision, /api/status and the dashboard all called it scrubbed.
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        with storage_scp(os.path.join(tmp, "arch"), aet="E2EARCH") as (archive, aport):
            with storage_scp(os.path.join(tmp, "res"), aet="E2ERECV") as (research, rport):
                cfg = make_config(
                    tmp,
                    [dest("Archive", "127.0.0.1", port=aport, aet="E2EARCH"),
                     dest("Research", "127.0.0.1", port=rport, aet="E2ERECV")],
                    on_success="delete",
                    rules=[rule("everything", ["Archive"]),
                           rule("research", ["Research"], deid=True)])
                cfg.data["scp"]["enabled"] = False
                cfg.data["deid"]["profile"] = "off"
                cfg.save()
                out = cfg.resolved("scu", "watch_dir")
                p = write_dicom(os.path.join(out, "a.dcm"))
                srv = PacsServer(cfg)
                client = _api(srv)

                # (1) the quiet correct site.
                scan(srv.watcher, 2)
                assert arrived_names(research) == [], "held, so nothing should have arrived"
                assert arrived_names(archive) == ["Doe^Jane"], "the hold stopped the whole study"
                assert srv.watcher.state.peek(p)["held"] == ["Research"]
                assert "deid.profile" in errors_of(srv), errors_of(srv)

                # (2) the operator does what the hold message says, over the API.
                said_before = {e["message"] for e in srv.log.tail(500)}
                _save_over_the_api(client, lambda b: b["deid"].__setitem__("profile", "basic"))
                assert srv.cfg.deid["profile"] == "basic", "the save never landed"

                # (3) and nothing leaves identified. Passes run the way the
                # daemon runs them, so a pass that dies on the unbuildable
                # de-identifier is followed by the next one, exactly as in
                # production — that next pass is where the leak used to go out.
                with unbuildable_deidentifier():
                    scan_like_the_daemon(srv.watcher, 3)
                assert arrived_names(research) == [], (
                    "a study left IDENTIFIED to the node a rule scrubs for, after the "
                    "operator did exactly what the hold message told them to do")
                assert os.path.exists(p), "the held study was deleted instead of held"
                entry = srv.watcher.state.peek(p)
                assert entry["held"] == ["Research"] and entry["route"] == ["Archive"]
                assert entry["hold_cause"] == routing.HOLD_NO_DEIDENTIFIER
                # Told on the send channel, with the cause that is actually true —
                # the profile is on, so a line blaming it would be a false cause.
                fresh = [e["message"] for e in srv.log.tail(500)
                         if e["message"] not in said_before]
                held_lines = [m for m in fresh if "Research" in m and "NOT sent" in m]
                assert held_lines, fresh
                assert all("deid.profile is 'off'" not in m for m in held_lines), held_lines
                assert any("de-identifier" in m for m in fresh), fresh
                # Archive is in no rule that scrubs: it had the study all along.
                assert arrived_names(archive) == ["Doe^Jane"]

                # (4) with a de-identifier that builds, the hold releases itself
                # and what arrives is anonymised. Every instance arrives: the
                # study waited, it was not lost.
                srv.watcher._deid_key = None        # the settings did not move; the world did
                scan(srv.watcher, 2)
                names = arrived_names(research)
                assert len(names) == 1 and names[0] != "Doe^Jane", names
                assert not os.path.exists(p), "delivered, so the archive pass may have it"


def test_the_watcher_holds_rather_than_forwards_when_the_de_identifier_will_not_build():
    # The same claim without the sockets, and the part the fence could not see:
    # a build that RAISES must not leave the previous de-identifier in place. Here
    # the previous one is the None a profile of 'off' produces, so keeping it is
    # the leak itself.
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Research", "10.0.0.9")], on_success="delete",
                          rules=[rule("research", ["Research"], deid=True)])
        cfg.data["scp"]["enabled"] = False
        cfg.data["deid"]["profile"] = "off"
        p = write_dicom(os.path.join(cfg.resolved("scu", "watch_dir"), "a.dcm"))
        srv = PacsServer(cfg)
        with fake_store(FakeStore()) as store:
            scan(srv.watcher, 2)
        assert store.calls == [], store.calls
        assert srv.watcher._deider is None      # the profile is off: nothing to scrub with

        saving(lambda d: d["deid"].__setitem__("profile", "basic"))(cfg)
        with unbuildable_deidentifier():
            with fake_store(FakeStore()) as store:
                scan_like_the_daemon(srv.watcher, 3)
        assert store.calls == [], "forwarded identified with no de-identifier: %r" % (store.calls,)
        assert srv.watcher._deider is None, "a failed build kept a stale de-identifier"
        assert os.path.exists(p)
        assert "de-identifier" in errors_of(srv), errors_of(srv)


def test_a_hand_edited_config_that_cannot_build_a_de_identifier_holds():
    # The same state with no test double anywhere, reached the way it is still
    # reachable in production: Config.load() does not validate, on purpose — "a
    # PACS that refuses to start is a PACS the operator cannot fix" — so a
    # hand-edited file is USED as it stands and PacsServer only remarks on it.
    # deid.prefix as a JSON number is the measured example: the dashboard now
    # refuses to SAVE it, and nothing refuses to RUN it. Profile on, a rule
    # scrubbing, and Deidentifier.__init__ dying on (5 or "ANON").strip().
    from pacs.config import Config
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Research", "10.0.0.9")], on_success="delete",
                          rules=[rule("research", ["Research"], deid=True)])
        cfg.data["scp"]["enabled"] = False
        cfg.data["deid"]["profile"] = "basic"       # the router WILL route to Research
        cfg.data["deid"]["prefix"] = 5              # and nothing will build a scrubber
        with open(cfg.path, "w", encoding="utf-8") as fh:
            json.dump(cfg.data, fh)
        live = Config(cfg.path)                     # loaded, unvalidated, as it stands
        p = write_dicom(os.path.join(live.resolved("scu", "watch_dir"), "a.dcm"))
        srv = PacsServer(live)
        assert srv.config_problem, "the config was accepted without a word"
        with fake_store(FakeStore()) as store:
            scan_like_the_daemon(srv.watcher, 3)
        assert store.calls == [], "forwarded identified with no de-identifier: %r" % (store.calls,)
        assert srv.watcher.state.peek(p)["held"] == ["Research"]
        assert srv.watcher.state.peek(p)["hold_cause"] == routing.HOLD_NO_DEIDENTIFIER
        assert os.path.exists(p), "the held study was deleted instead of held"


def test_an_inert_de_identifier_holds_exactly_as_a_missing_one_does():
    # deidentified_tempfile yields the SOURCE path for a Deidentifier built on
    # the 'off' profile, so a sender that only checks `is not None` forwards the
    # unscrubbed original and calls it de-identified. The watcher asks the object.
    from pacs.deid import Deidentifier
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Research", "10.0.0.9")], on_success="delete",
                          rules=[rule("research", ["Research"], deid=True)])
        cfg.data["scp"]["enabled"] = False
        cfg.data["deid"]["profile"] = "basic"       # the router WILL route to it
        p = write_dicom(os.path.join(cfg.resolved("scu", "watch_dir"), "a.dcm"))
        srv = PacsServer(cfg)
        srv.watcher._deider = Deidentifier(profile="off")
        srv.watcher._deid_key = json.dumps(cfg.deid, sort_keys=True, default=str)
        with fake_store(FakeStore()) as store:
            scan(srv.watcher, 2)
        assert store.calls == [], "forwarded the source file as a scrubbed copy: %r" % (store.calls,)
        assert srv.watcher.state.peek(p)["held"] == ["Research"]
        assert os.path.exists(p)


def test_an_unbound_watcher_router_holds_instead_of_forwarding_identified():
    # A FolderWatcher built without a PacsServer has an UNBOUND router, which
    # cannot read deid.profile and assumes the config default rather than holding
    # every de-identified route on a guess. That guess used to be a leak: the
    # decision claimed a scrub, the de-identifier was None because the profile
    # really was off, and the file went out identified. It is a hold now — the
    # decision is settled against the de-identifier the pass actually has.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Teaching", "10.0.0.9")], on_success="keep",
                          rules=[rule("all", ["Teaching"], deid=True)])
        cfg.data["deid"]["profile"] = "off"
        p = write_dicom(os.path.join(cfg.resolved("scu", "watch_dir"), "a.dcm"))
        w = FolderWatcher(cfg, FakeLog())
        assert w.router.cfg is None and w.router.deid_available
        with fake_store(FakeStore()) as store:
            scan(w, 2)
        assert store.calls == [], store.calls
        assert w.state.peek(p)["held"] == ["Teaching"]


def test_e2e_the_manual_send_holds_and_says_so_on_every_channel():
    # The History panel's Send/Resend button forwarded identified in the same
    # configuration with no warning anywhere — not even the log line the watcher
    # emits. Same hold, and it is said out loud.
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        with storage_scp(tmp) as (store, port):
            cfg = make_config(tmp, [dest("Research", "127.0.0.1", port=port, aet="E2ERECV")],
                              rules=[rule("research", ["Research"], deid=True)])
            cfg.data["scp"]["enabled"] = False
            cfg.data["deid"]["profile"] = "off"
            study = os.path.join(cfg.resolved("scp", "storage_dir"), "study1")
            write_dicom(os.path.join(study, "a.dcm"))
            srv = PacsServer(cfg)
            assert srv.send_study("received", study)["ok"]
            join_manual_sends()
            assert arrived_names(store) == [], "Send/Resend forwarded an identified study"
            said = errors_of(srv)
            assert "Research" in said and "deid.profile" in said, said
            assert any("HELD" in e["message"] for e in srv.log.tail(400)), srv.log.tail(400)

            cfg.data["deid"]["profile"] = "basic"
            assert srv.send_study("received", study)["ok"]
            join_manual_sends()
            names = arrived_names(store)
            assert len(names) == 1 and names[0] != "Doe^Jane", names


@contextlib.contextmanager
def store_hook(after_first):
    """The REAL c_store with a trigger on its first call.

    A mid-send configuration change needs a deterministic moment, and the only
    one this path offers is "an association just closed". Everything else stays
    real — real sockets, real bytes, a real receiver writing files — which is the
    whole point: a Decision object can say anything, what arrived cannot."""
    from pacs import scu
    real = scu.c_store
    calls = []

    def hooked(dst, filepath, calling_aet, timeout=30, tls_context=None):
        res = real(dst, filepath, calling_aet, timeout=timeout, tls_context=tls_context)
        calls.append(dst.name)
        if len(calls) == 1:
            after_first()
        return res

    scu.c_store = hooked
    try:
        yield calls
    finally:
        scu.c_store = real


def test_e2e_a_profile_turned_on_mid_manual_send_never_ships_the_rest_identified():
    # The BLOCKER, and the irony is the point: this is triggered by exactly the
    # remediation the hold error message instructs. The operator presses Send on a
    # multi-instance study, Research is correctly held, the log says "turn the
    # de-identification profile on", they do it — and the router, which reads
    # deid.profile LIVE, immediately starts routing to Research while the
    # de-identifier built at the top of the send is still None. The rest of the
    # study went out IDENTIFIED to the one node a rule scrubs for, and /api/status
    # reported it de-identified.
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        with storage_scp(os.path.join(tmp, "arch"), aet="E2EARCH") as (archive, aport):
            with storage_scp(os.path.join(tmp, "res"), aet="E2ERECV") as (research, rport):
                cfg = make_config(
                    tmp,
                    [dest("Archive", "127.0.0.1", port=aport, aet="E2EARCH"),
                     dest("Research", "127.0.0.1", port=rport, aet="E2ERECV")],
                    rules=[rule("everything", ["Archive"]),
                           rule("research", ["Research"], deid=True)])
                cfg.data["scp"]["enabled"] = False
                cfg.data["deid"]["profile"] = "off"
                study = os.path.join(cfg.resolved("scp", "storage_dir"), "study1")
                for n in ("a", "b", "c"):
                    write_dicom(os.path.join(study, f"{n}.dcm"))
                srv = PacsServer(cfg)

                def turn_deid_on():
                    saving(lambda data: data["deid"].__setitem__("profile", "basic"))(cfg)

                with store_hook(turn_deid_on) as calls:
                    assert srv.send_study("received", study)["ok"]
                    join_manual_sends()
                assert cfg.deid["profile"] == "basic", "the mid-send save never landed"
                # The claim under test, read off the receiver's own disk.
                assert arrived_names(research) == [], (
                    "the profile was switched on mid-send and the rest of the study "
                    "left IDENTIFIED to the node a rule scrubs for")
                # Archive is in no rule that scrubs, so it is delivered identified
                # throughout — that is the send working, and it is what gives the
                # save its moment to land.
                assert calls == ["Archive"] * 3, calls
                assert arrived_names(archive) == ["Doe^Jane"] * 3
                said = errors_of(srv)
                assert "Research" in said and "deid.profile" in said, said

                # The send finished under the settings it began with, so the fix
                # takes effect on the NEXT press — and then what arrives is
                # anonymised, and every instance of it arrives.
                assert srv.send_study("received", study)["ok"]
                join_manual_sends()
                names = arrived_names(research)
                assert len(names) == 3, names
                assert "Doe^Jane" not in names, names


def test_a_manual_send_with_no_deidentifier_holds_rather_than_forwards_identified():
    # The invariant behind the fix, stated on its own: the set of destinations
    # actually scrubbed may never be NARROWER than the set the decision asked
    # for. Here the decision asks for a scrub and the send has no de-identifier,
    # which is the same situation as the profile being off and gets the same
    # outcome — a hold, not an identified forward.
    from pacs.deid import Deidentifier
    from pacs.server import PacsServer
    real = Deidentifier.__dict__["from_config"]

    def run(replacement) -> tuple:
        with tempfile.TemporaryDirectory() as tmp:
            cfg = make_config(tmp, [dest("Research", "10.0.0.9")],
                              rules=[rule("research", ["Research"], deid=True)])
            cfg.data["scp"]["enabled"] = False
            cfg.data["deid"]["profile"] = "basic"        # the router WILL route to it
            study = os.path.join(cfg.resolved("scp", "storage_dir"), "study1")
            write_dicom(os.path.join(study, "a.dcm"))
            srv = PacsServer(cfg)
            Deidentifier.from_config = replacement
            try:
                with fake_store(FakeStore()) as store:
                    assert srv.send_study("received", study)["ok"]
                    join_manual_sends()
            finally:
                Deidentifier.from_config = real
            return store.calls, errors_of(srv)

    # (a) the two halves simply disagree — no de-identifier where the decision
    #     says there is one.
    calls, said = run(classmethod(lambda cls, cfg, log=None: None))
    assert calls == [], "forwarded identified with no de-identifier: %r" % (calls,)
    assert "Research" in said and "held" in said.lower(), said

    # (b) building one failed outright. A send that cannot scrub still may not
    #     disclose, and it may not take the request down with it either.
    def boom(cls, cfg, log=None):
        raise RuntimeError("bad site key")

    calls, said = run(classmethod(boom))
    assert calls == [], "forwarded identified after the de-identifier failed: %r" % (calls,)
    assert "Research" in said, said


def test_status_never_calls_a_held_destination_de_identified():
    # /api/status re-read the rules on its own and listed every rule destination
    # as de-identified whatever the profile said. It reads the routing engine now.
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Research", "10.0.0.9")],
                          rules=[rule("research", ["Research"], deid=True)])
        cfg.data["scp"]["enabled"] = False
        cfg.data["deid"]["profile"] = "off"
        srv = PacsServer(cfg)
        block = srv.status()["deid"]
        assert block["destinations"] == [], "status claimed a de-identification that is not happening"
        assert block["held"] == ["Research"] and block["profile"] == "off"
        cfg.data["deid"]["profile"] = "basic"
        block = srv.status()["deid"]
        assert block["destinations"] == ["Research"] and block["held"] == []
        # Nothing held, so nothing to explain: an empty cause is the only honest
        # value here, and a reader branching on it must not find a stale one.
        assert block["hold_cause"] == ""


def test_status_holds_a_node_the_profile_alone_says_is_scrubbed_for():
    # The second cause, at the surface that shipped the first one for four
    # rounds. deid_summary() answers "is the profile off?" and NOTHING else, so a
    # profile that is on with nothing buildable behind it read as
    # de-identified-for on /api/status while the senders were holding it — the
    # same sentence, the same screen, a different half of the same decision.
    #
    # The config is the one from the report: hand-edited (Config.load does not
    # validate), profile on, deid.prefix a JSON number, and Deidentifier.__init__
    # dying on (5 or "ANON").strip().
    from pacs.config import Config
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Research", "10.0.0.9")],
                          rules=[rule("research", ["Research"], deid=True)])
        cfg.data["scp"]["enabled"] = False
        cfg.data["deid"]["profile"] = "basic"       # ON — this is the whole point
        cfg.data["deid"]["prefix"] = 5
        with open(cfg.path, "w", encoding="utf-8") as fh:
            json.dump(cfg.data, fh)
        srv = PacsServer(Config(cfg.path))
        block = srv.status()["deid"]
        assert block["profile"] == "basic", "the profile really is on"
        assert block["destinations"] == [], \
            "status called a node de-identified-for that no sender can scrub for"
        assert block["held"] == ["Research"]
        assert block["hold_cause"] == routing.HOLD_NO_DEIDENTIFIER, block
        # And the OTHER minor of the same shape: the engine validates what it
        # loaded and publishes the verdict, which is the entire price paid for
        # Config.load() not refusing to start.
        assert "deid.prefix" in srv.status()["config_problem"], srv.status()

        # Repaired through the API the panel points at: the hold clears itself
        # and the node is de-identified-for again, cause and all.
        srv.apply_config({**srv.cfg.data, "deid": {**srv.cfg.deid, "prefix": "ANON"}})
        block = srv.status()["deid"]
        assert block["destinations"] == ["Research"] and block["held"] == []
        assert block["hold_cause"] == "" and srv.status()["config_problem"] == ""


def test_a_dry_run_over_a_real_study_never_promises_a_scrub_that_cannot_happen():
    # The other read-only surface, over the branch this lane owns: POST
    # /api/routing/test with a 'path' lands in PacsServer.explain_route. It is
    # the screen an operator checks BEFORE letting a research forward go out, and
    # it answered from the rules and deid.profile alone — so with the profile on
    # and nothing buildable behind it, the panel said "de-identified for
    # Research" and drew the rule as a green hit over a study that was going
    # nowhere at all.
    from pacs.config import Config
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Research", "10.0.0.9")],
                          rules=[rule("research", ["Research"], deid=True)])
        cfg.data["scp"]["enabled"] = False
        cfg.data["deid"]["profile"] = "basic"
        cfg.data["deid"]["prefix"] = 5              # nothing can be built from this
        with open(cfg.path, "w", encoding="utf-8") as fh:
            json.dump(cfg.data, fh)
        live = Config(cfg.path)
        study = os.path.join(live.resolved("scp", "storage_dir"), "study1")
        write_dicom(os.path.join(study, "a.dcm"))
        srv = PacsServer(live)
        res = srv.explain_route("received", study)
        assert res["ok"], res
        d = res["decision"]
        assert d["deidentify"] == [], "the dry run promised a scrub nothing can perform"
        assert d["held"] == ["Research"] and d["sendable"] == []
        assert d["hold_cause"] == routing.HOLD_NO_DEIDENTIFIER, d
        assert "no usable de-identifier" in d["reason"], d
        # And the rule that asked for it says so where it is drawn.
        row = res["rules"][0]
        assert row["held"] == ["Research"], row
        assert "HELD" in row["action"] and "de-identifier" in row["action"], row

        # With the profile off it is the OTHER cause, and the payload must not be
        # re-stamped with this one on the way past. Edited in memory rather than
        # saved: this whole config is one the dashboard refuses (that is what
        # makes it unbuildable), so there is no Save that lands it.
        live.data["deid"]["profile"] = "off"
        d = srv.explain_route("received", study)["decision"]
        assert d["held"] == ["Research"] and d["hold_cause"] == routing.HOLD_PROFILE_OFF, d
        assert "deid.profile is 'off'" in d["reason"], d


def test_the_settled_answer_comes_from_honoured_by_and_not_from_a_second_reading():
    # The shape of the fix, not just its output: /api/status is the routing
    # engine's own answer put through Decision.honoured_by — the one door every
    # sender goes through — so a change to what "honoured" means reaches the
    # dashboard without anybody remembering to make the same edit twice. Four
    # rounds of this defect were four copies of the same AND, so the test is that
    # there is one.
    from pacs import server as server_mod
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Research", "10.0.0.9")],
                          rules=[rule("research", ["Research"], deid=True)])
        cfg.data["deid"]["profile"] = "basic"
        seen = []
        real = routing.Decision.honoured_by

        def watched(self, deider):
            seen.append(sorted(self.deid_dests))
            return real(self, deider)

        routing.Decision.honoured_by = watched
        try:
            state = server_mod._deid_state(cfg)
        finally:
            routing.Decision.honoured_by = real
        assert seen == [["Research"]], \
            "the status block answered the scrub question without honoured_by: %r" % (seen,)
        assert state["destinations"] == ["Research"] and state["hold_cause"] == ""


def test_the_servers_watcher_router_reads_the_live_deid_profile():
    # The watcher's router is the only one in the process built without a Config,
    # and unbound it cannot see deid.profile at all — every decision it made
    # would claim a de-identification the sender does not perform. This is the
    # wiring that stops that, named so it cannot be dropped by accident.
    from pacs.server import PacsServer
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Research", "10.0.0.9")],
                          rules=[rule("research", ["Research"], deid=True)])
        cfg.data["scp"]["enabled"] = False
        cfg.data["deid"]["profile"] = "off"
        srv = PacsServer(cfg)
        assert srv.watcher.router.cfg is cfg
        assert srv.watcher.router.deid_profile == "off"
        # Bound to the OBJECT, so a save is visible without anyone pushing it.
        saving(lambda data: data["deid"].__setitem__("profile", "strict"))(cfg)
        assert srv.watcher.router.deid_profile == "strict"


# ------------------------------------------------------- the dashboard's own state
# renderDeidState()'s warning condition was inverted with respect to danger: it
# read "no destination is scrubbed for AND a profile is on", so it went amber in
# the harmless case (a profile configured ahead of the rule that will use it) and
# stayed the ordinary muted note colour in the dangerous one (rules asking for
# scrubbing, profile off, deliveries held). This runs the shipped function.

APP_JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "pacs", "web", "app.js")


def _js_function(path: str, name: str) -> str:
    """The source of one function out of a file, by brace matching."""
    src = open(path, encoding="utf-8").read()
    start = src.index("function %s(" % name)
    depth, i = 0, src.index("{", start)
    while True:
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[start:i + 1]
        i += 1


def _render_deid_state(payloads: list) -> list:
    """Run renderDeidState() over each payload in node.

    Returns the panel sentence, its classes, and every line the function APPENDS
    beside it — the site key, the retrieval caveat, the superseded-send note.
    Those are collected rather than dropped on the floor because each of them is
    a statement about what leaves this building, and a harness that cannot see
    them is a harness that would have passed while they said nothing.
    """
    import json
    import shutil as _shutil
    import subprocess
    node = _shutil.which("node")
    assert node, "node is needed to exercise the dashboard's own code"
    harness = """
const classes = new Set();
let appended = [];
const el = {
  textContent: "",
  appendChild(c) { appended.push({ text: c.textContent, cls: c.className || "" }); },
  classList: {
    toggle(n, on) { if (on) classes.add(n); else classes.delete(n); },
    add(n) { classes.add(n); },
    remove(n) { classes.delete(n); },
  },
};
const document = { createElement: () => ({ classList: { add() {} }, style: {} }) };
const $ = () => el;
const settingsOpen = () => true;
const T = (s) => s;
const TF = (s, v) => s.replace(/\\{(\\w+)\\}/g, (_m, k) => v[k]);
__FN__
const out = [];
for (const dd of __PAYLOADS__) {
  classes.clear();
  el.textContent = "";
  appended = [];
  renderDeidState(dd);
  out.push({ text: el.textContent, classes: [...classes], lines: appended });
}
console.log(JSON.stringify(out));
"""
    script = (harness.replace("__FN__", _js_function(APP_JS, "renderDeidState"))
                     .replace("__PAYLOADS__", json.dumps(payloads)))
    with tempfile.TemporaryDirectory() as tmp:
        fp = os.path.join(tmp, "render.mjs")
        with open(fp, "w", encoding="utf-8") as fh:
            fh.write(script)
        res = subprocess.run([node, fp], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_the_dashboard_shouts_in_the_dangerous_state_and_not_the_harmless_one():
    LOUD = {"warn-note", "bad-note"}
    danger, harmless, working = _render_deid_state([
        {"profile": "off", "destinations": [], "held": ["Research"]},
        {"profile": "basic", "destinations": [], "held": []},
        {"profile": "basic", "destinations": ["Research"], "held": []},
    ])
    assert set(danger["classes"]) & LOUD, \
        "the state that stops studies arriving rendered as an ordinary note"
    assert "Research" in danger["text"] and "HELD" in danger["text"], danger["text"]
    assert not (set(harmless["classes"]) & LOUD), \
        "a profile configured ahead of its rule is not a warning"
    assert not (set(working["classes"]) & LOUD), working
    assert "Research" in working["text"]


def test_the_dashboard_states_the_hold_cause_it_was_GIVEN_and_never_the_other_one():
    # The shipped function, over both causes. The panel had one sentence for
    # every hold — "the de-identification profile is off … Turn a profile on" —
    # and at a site holding for the other cause every clause of it is wrong: the
    # profile IS on, turning it on does nothing, and the operator is left with
    # "take de-identify off the rule", which releases the studies by sending them
    # identified to the node the rule exists to scrub for.
    off, none, unknown = _render_deid_state([
        {"profile": "off", "destinations": [], "held": ["Research"], "hold_cause": "profile-off"},
        {"profile": "basic", "destinations": [], "held": ["Research"],
         "hold_cause": "no-deidentifier"},
        # An engine that names no cause: neither claim may be made.
        {"profile": "basic", "destinations": [], "held": ["Research"]},
    ])
    assert "profile is off" in off["text"] and "Turn a profile on" in off["text"], off["text"]

    assert "no de-identifier can be built" in none["text"], none["text"]
    assert "profile is off" not in none["text"], \
        "told an operator whose profile is ON that it is off: " + none["text"]
    assert "Turn a profile on" not in none["text"], \
        "prescribed the one edit that does nothing here: " + none["text"]
    # And it says out loud what the wrong advice would have led to.
    assert "does NOT release them" in none["text"], none["text"]
    assert "releases them identified" in none["text"], none["text"]

    assert "profile is off" not in unknown["text"] and "The profile is on" not in unknown["text"], \
        "guessed a cause the engine did not give: " + unknown["text"]
    assert "HELD" in unknown["text"] and "Research" in unknown["text"], unknown["text"]


def test_the_dashboard_says_that_a_scrub_does_not_cover_the_retrieval_doors():
    # De-identify-on-forward is a property of FORWARDING. qr.py's C-MOVE and
    # C-GET and DICOMweb's WADO-RS all serve the stored instance as it was
    # received, and neither consults deid.profile or a routing rule — correct on
    # its own terms, and dangerous three lines under "Rules de-identify for:
    # Research" while Research is also allowed to pull. An operator opening Q/R
    # to a research node has to be told which of the two doors they are opening.
    shut, open_doors, no_rule = _render_deid_state([
        {"profile": "basic", "destinations": ["Research"], "held": [], "retrieval_raw": []},
        {"profile": "basic", "destinations": ["Research"], "held": [],
         "retrieval_raw": ["qr", "dicomweb"]},
        # Nothing is scrubbed, so there is no promise for a retrieval to
        # undercut: the line would be noise on every install that never
        # de-identifies anything.
        {"profile": "basic", "destinations": [], "held": [], "retrieval_raw": ["qr"]},
    ])
    said = lambda r: " ".join(l["text"] for l in r["lines"])          # noqa: E731
    assert "FORWARDING" not in said(shut), said(shut)
    assert "FORWARDING only" in said(open_doors), said(open_doors)
    assert "C-MOVE" in said(open_doors) and "WADO-RS" in said(open_doors), said(open_doors)
    assert "identified originals" in said(open_doors), said(open_doors)
    assert "FORWARDING" not in said(no_rule), said(no_rule)


def test_the_dashboard_renders_the_superseded_sends_the_engine_publishes():
    # status.deid.superseded_sends is written by send_study when the answer moves
    # under an in-flight send — the study stops half-delivered on purpose — and
    # nothing rendered it, so the panel above described the NEW settings while
    # part of a study was being withheld under the old ones and no screen
    # explained the study that stopped.
    quiet, moved = _render_deid_state([
        {"profile": "basic", "destinations": ["Research"], "held": [], "superseded_sends": []},
        {"profile": "basic", "destinations": ["Research"], "held": [],
         "superseded_sends": [{"study": "study1", "at": 1, "held": ["Research"]}]},
    ])
    said = lambda r: " ".join(l["text"] for l in r["lines"])          # noqa: E731
    assert "study1" not in said(quiet), said(quiet)
    assert "study1" in said(moved), said(moved)
    assert "Press Send again" in said(moved), said(moved)


# ============================================ two Saves inside apply_config at once
# Werkzeug is threaded: two tabs, or the dashboard and the desktop app, can be
# inside apply_config at the same instant. The rollback that protects a save
# whose WRITE fails was taken outside the config lock, so it could restore a
# pre-snapshot config over a different save that had already landed — after
# which the file on disk and the running process disagree silently, and nothing
# ever reconciles them.


def test_a_failed_save_cannot_roll_back_over_a_save_that_already_landed():
    import copy as _copy
    import json
    from pacs.config import Config
    from pacs.server import PacsServer

    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, [dest("Archive", "10.0.0.1")])
        cfg.data["scp"]["enabled"] = False
        cfg.data["scu"]["enabled"] = False
        cfg.save()
        srv = PacsServer(cfg)

        real_save, real_deepcopy = Config.save, _copy.deepcopy
        a_landed = threading.Event()
        parked = threading.Event()

        def only_bs_write_fails(self):
            # The one failure the rollback exists for: a config directory that
            # cannot be written (a read-only bind mount, a full disk).
            if self.data["scp"]["aet"] == "B_FAILS":
                raise OSError("read-only config directory")
            return real_save(self)

        def hooked_deepcopy(obj, *a, **k):
            # Park B exactly where it took its rollback snapshot, and let A try
            # to save while it is parked. Bounded, because with the snapshot
            # under the lock A cannot get in — which is the fix, not a hang.
            if (obj is srv.cfg.data and threading.current_thread().name == "saver-B"
                    and not parked.is_set()):
                parked.set()
                a_landed.wait(3.0)
            return real_deepcopy(obj, *a, **k)

        def save_a():
            new = real_deepcopy(srv.cfg.data)
            new["scp"]["aet"] = "A_LANDED"
            srv.apply_config(new)
            a_landed.set()

        def save_b():
            new = real_deepcopy(srv.cfg.data)
            new["scp"]["aet"] = "B_FAILS"
            try:
                srv.apply_config(new)
            except OSError:
                pass                      # the save legitimately failed
            else:
                raise AssertionError("an unwritable config directory reported a save")

        Config.save, _copy.deepcopy = only_bs_write_fails, hooked_deepcopy
        try:
            b = threading.Thread(target=save_b, name="saver-B")
            b.start()
            assert parked.wait(5), "B never reached its snapshot"
            a = threading.Thread(target=save_a, name="saver-A")
            a.start()
            b.join(20)
            a.join(20)
            assert not b.is_alive() and not a.is_alive(), "a save deadlocked"
        finally:
            Config.save, _copy.deepcopy = real_save, real_deepcopy

        with open(cfg.path, encoding="utf-8") as fh:
            on_disk = json.load(fh)
        assert on_disk["scp"]["aet"] == "A_LANDED", on_disk["scp"]["aet"]
        assert srv.cfg.data["scp"]["aet"] == on_disk["scp"]["aet"], \
            "the failed save rolled its own pre-snapshot over a save that had landed: " \
            "the file says %s, the running process says %s" % (
                on_disk["scp"]["aet"], srv.cfg.data["scp"]["aet"])


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok   ", name)
            except Exception as exc:
                failures += 1
                print("FAIL ", name, "->", repr(exc))
    print(("%d failure(s)" % failures) if failures else "all passed")
    sys.exit(1 if failures else 0)
