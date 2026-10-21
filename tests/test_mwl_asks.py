"""What each modality asks the worklist for (pacs/mwlasks.py): every attribute
path in its C-FIND query, filter or fill-in, and how our answer carried it —
recorded without a single patient value.

Runs under pytest, or directly:  python3 tests/test_mwl_asks.py
"""

from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest                                              # noqa: E402
from pydicom.dataset import Dataset                        # noqa: E402

from pacs import mwlasks as A                              # noqa: E402
from pacs import users as U                                # noqa: E402
from pacs.logbuf import LogBuffer                          # noqa: E402
from pacs.mwl import MwlSCP                                # noqa: E402
from pacs.web import create_app                            # noqa: E402
from test_web_auth import FakeServer, WRITE                # noqa: E402

ORDER = {"id": "a1b2c3d4e5f6", "status": "open", "accession": "ACC9917",
         "patient_id": "PID-4471", "patient_name": "DOE^JANE", "modality": "CT",
         "study_desc": "CT HEAD", "study_uid": "1.2.826.0.1.3680043.10.99999.1"}
SECRETS = ("DOE", "JANE", "PID-4471", "ACC9917", "CT HEAD")


def _tmp():
    return tempfile.mkdtemp(prefix="carino-mwlasks-")


def _query(name="DOE^JANE", modality="CT"):
    q = Dataset()
    q.PatientName = name
    q.PatientID = ""
    q.AccessionNumber = ""
    q.PatientWeight = ""
    q.MedicalAlerts = ""
    q.add_new(0x00091010, "LO", "")                 # a private attribute
    sps = Dataset()
    sps.Modality = modality
    sps.ScheduledStationAETitle = ""
    sps.ScheduledProcedureStepStartDate = ""
    q.ScheduledProcedureStepSequence = [sps]
    return q


def _event(query, aet="CT1"):
    ns = types.SimpleNamespace
    return ns(identifier=query, is_cancelled=False,
              assoc=ns(requestor=ns(ae_title=aet, address="10.0.0.21")))


def _scp(store, orders=(ORDER,)):
    return MwlSCP(aet="MWL", bind="127.0.0.1", port=1, log=LogBuffer(),
                  get_orders=lambda: list(orders), asks=store)


def _find(scp, query, aet="CT1"):
    return list(scp._handle_find(_event(query, aet)))


def _station(store, aet="CT1"):
    return next(s for s in store.stations() if s["aet"] == aet)


def _tag(st, name):
    return next(t for t in st["tags"] if t["name"] == name)


def test_query_paths_cover_sequences_and_say_which_had_a_value():
    p = A.query_paths(_query())
    assert p["00100010"] is True                     # PatientName filtered
    assert p["00100020"] is False                    # PatientID wanted
    assert p["00400100"] is True                     # the SPS sequence carries a filter
    assert p["00400100>00080060"] is True            # SPS > Modality
    assert p["00400100>00400001"] is False           # SPS > Station AE wanted
    assert "00091010" in p


def test_a_query_is_recorded_per_station_with_our_answer_per_attribute():
    store = A.MwlAskStore(_tmp())
    out = _find(_scp(store), _query())
    assert [s for s, _ in out] == [0xFF00]           # the modality still got its item
    st = _station(store)
    assert st["queries"] == 1 and st["address"] == "10.0.0.21"
    assert _tag(st, "PatientName")["status"] == "filled"
    assert _tag(st, "PatientName")["filter"] == 1 and _tag(st, "PatientID")["fill"] == 1
    assert _tag(st, "ScheduledProcedureStepSequence > Modality")["status"] == "filled"
    assert _tag(st, "PatientWeight")["status"] == "not_sent"
    assert _tag(st, "MedicalAlerts")["status"] == "not_sent"
    assert _tag(st, "Private")["tag"] == "(0009,1010)"
    # Missing first: the operator reads what the modality is not getting at the top.
    assert st["tags"][0]["status"] == "not_sent"
    assert st["counts"]["not_sent"] == 3


def test_no_patient_value_reaches_the_file():
    d = _tmp()
    store = A.MwlAskStore(d)
    _find(_scp(store), _query())
    raw = open(os.path.join(d, "mwl_asks.json"), encoding="utf-8").read()
    for s in SECRETS:
        assert s not in raw, s
    if os.name != "nt":
        assert stat.S_IMODE(os.stat(os.path.join(d, "mwl_asks.json")).st_mode) == 0o600


def test_repeat_queries_count_in_memory_and_reach_disk_at_most_once_a_minute():
    t = [1000.0]
    d = _tmp()
    store = A.MwlAskStore(d, clock=lambda: t[0])
    scp = _scp(store)
    _find(scp, _query())
    saves = []
    real = store._save_locked
    store._save_locked = lambda: (saves.append(1), real())
    for _ in range(5):
        t[0] += 2
        _find(scp, _query())
    assert saves == [] and _station(store)["queries"] == 6
    t[0] += A.SAVE_EVERY_SEC
    _find(scp, _query())
    assert saves == [1]
    # Something a reader would see — a new attribute — is written at once.
    q = _query()
    q.AdmissionID = ""
    _find(scp, q)
    assert len(saves) == 2
    on_disk = json.load(open(os.path.join(d, "mwl_asks.json")))
    assert on_disk["stations"]["CT1"]["queries"] == 8


def test_with_no_matching_order_the_template_says_what_we_would_send():
    store = A.MwlAskStore(_tmp())
    _find(_scp(store, orders=()), _query())
    st = _station(store)
    assert _tag(st, "PatientName")["status"] == "sent"
    assert _tag(st, "PatientWeight")["status"] == "not_sent"
    # A later real answer replaces the guess; a later empty one keeps it.
    _find(_scp(store), _query())
    assert _tag(_station(store), "PatientName")["status"] == "filled"
    _find(_scp(store, orders=()), _query())
    assert _tag(_station(store), "PatientName")["status"] == "filled"


def test_attributes_not_in_the_latest_query_are_marked():
    store = A.MwlAskStore(_tmp())
    scp = _scp(store)
    _find(scp, _query())
    q = _query()
    del q.MedicalAlerts
    _find(scp, q)
    st = _station(store)
    assert _tag(st, "MedicalAlerts")["in_last"] is False
    assert _tag(st, "PatientWeight")["in_last"] is True


def test_the_record_is_bounded():
    store = A.MwlAskStore(_tmp())
    for i in range(A.MAX_STATIONS + 3):
        store.record(f"ST{i:03d}", "", _query(), [])
    assert len(store.stations()) == A.MAX_STATIONS
    big = Dataset()
    for i in range(A.MAX_TAGS + 10):
        big.add_new(0x00111000 + i, "LO", "")
    store.record("BIG", "", big, [])
    st = _station(store, "BIG")
    assert len(st["tags"]) == A.MAX_TAGS and st["dropped"] == 10


def test_an_unreadable_file_starts_empty_and_says_so():
    d = _tmp()
    open(os.path.join(d, "mwl_asks.json"), "w").write("{ not json")
    log = LogBuffer()
    store = A.MwlAskStore(d, log=log)
    assert store.stations() == []
    assert any("could not be read" in e.get("message", "") for e in log.since(0))


def test_a_failing_record_never_costs_the_modality_its_worklist():
    class Broken:
        def record(self, *a, **k):
            raise RuntimeError("disk on fire")

        def flush(self):
            pass
    out = _find(_scp(Broken()), _query())
    assert [s for s, _ in out] == [0xFF00]


def test_survives_a_restart_and_clears():
    d = _tmp()
    store = A.MwlAskStore(d)
    _find(_scp(store), _query())
    again = A.MwlAskStore(d)
    assert _tag(_station(again), "PatientWeight")["status"] == "not_sent"
    assert again.clear() == 1 and again.stations() == []
    assert A.MwlAskStore(d).stations() == []


# ------------------------------------------------------------------ the API
def _app(caps):
    srv = FakeServer(_tmp())
    srv.mwl_asks = A.MwlAskStore(_tmp())
    srv.mwl_asks.record("CT1", "10.0.0.21", _query(), [])
    row = {"id": U.new_id(), "name": "Viewer", "role": "", "enabled": True,
           "capabilities": list(caps), "phi_visible": [], "password": None}
    with srv.cfg.mutate():
        srv.cfg.users["profiles"] = U.preset_profiles() + [row]
        srv.cfg.save()
    app = create_app(srv)
    c = app.test_client()
    assert c.post("/api/login", json={"profile": row["id"]}, headers=WRITE).status_code == 200
    return srv, c


def test_the_api_lists_with_config_read_and_clearing_needs_more():
    srv, c = _app(["config.read"])
    r = c.get("/api/worklist/asks")
    assert r.status_code == 200
    st = r.get_json()["stations"][0]
    assert st["aet"] == "CT1" and any(t["name"] == "PatientWeight" for t in st["tags"])
    for s in SECRETS:
        assert s not in r.get_data(as_text=True)
    assert c.post("/api/worklist/asks/clear", headers=WRITE).status_code == 403
    assert srv.mwl_asks.stations()


def test_clearing_with_services_control():
    srv, c = _app(["config.read", "services.control"])
    r = c.post("/api/worklist/asks/clear", headers=WRITE)
    assert r.status_code == 200 and srv.mwl_asks.stations() == []


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
