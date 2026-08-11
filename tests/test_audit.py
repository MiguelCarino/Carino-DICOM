"""The audit trail: append-only, attributed, hash-chained.

Runs under pytest, or standalone: python3 tests/test_audit.py

The chain is the part worth testing, and testing it means BREAKING it — a
verify() that has only ever seen intact files proves nothing at all. So most of
what follows writes a real trail, edits it the way a person with a text editor
would, and asserts that the edit is found and located.

The honest limit is asserted too: this detects tampering by anything that
cannot recompute the chain. Somebody who rewrites every record consistently is
not caught by anything kept on the same disk, which is why AuditLog.head() is
published for external anchoring. A test that pretended otherwise would be
worse than none.
"""

from __future__ import annotations

import builtins
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest                                            # noqa: E402

from pacs import audit as A                              # noqa: E402
from pacs import users as U                              # noqa: E402


class FakeLog:
    def __init__(self):
        self.lines = []

    def info(self, msg, kind=""):
        self.lines.append(("info", msg))

    def warn(self, msg, kind=""):
        self.lines.append(("warn", msg))

    def error(self, msg, kind=""):
        self.lines.append(("error", msg))


@pytest.fixture()
def trail(tmp_path):
    return A.AuditLog(str(tmp_path / "audit"), log=FakeLog()).open()


ANA = U.Profile({"id": "u_0123456789ab", "name": "Ana Ruiz", "role": "radiologist"})


# ---- writing ------------------------------------------------------------

def test_a_record_names_who_what_and_whether_it_worked(trail):
    rec = trail.record(A.STUDY_DELETED, actor=ANA, target="recv/P-1/1.2.3",
                       source="10.0.0.9", outcome="ok")
    assert rec["actor"]["name"] == "Ana Ruiz"
    assert rec["actor"]["id"] == ANA.id
    assert rec["actor"]["role"] == "radiologist"
    assert rec["action"] == A.STUDY_DELETED
    assert rec["target"] == "recv/P-1/1.2.3"
    assert rec["outcome"] == "ok"
    assert rec["source"] == "10.0.0.9"
    assert rec["prev"] == A.GENESIS and rec["hash"]


def test_the_shared_token_is_recorded_as_a_service_not_as_a_person(trail):
    """Attributing a script's delete to whoever holds the token would be a lie
    the trail cannot be allowed to tell."""
    rec = trail.record(A.STUDY_DELETED, actor=U.SERVICE_PROFILE)
    assert rec["actor"]["service"] is True
    assert rec["actor"]["name"] == "API token"


def test_no_actor_is_the_system_not_an_empty_person(trail):
    rec = trail.record(A.SHUTDOWN, actor=None)
    assert rec["actor"]["name"] == "system"
    assert rec["actor"]["service"] is True


def test_reads_are_not_recorded_unless_the_operator_asks(trail):
    """"Who viewed this patient" is required in some places and multiplies the
    size of the file by how often somebody refreshes a dashboard elsewhere."""
    assert trail.record(A.STUDY_READ, actor=ANA) is None
    trail.log_reads = True
    assert trail.record(A.STUDY_READ, actor=ANA) is not None


def test_a_disabled_trail_writes_nothing_and_says_so(tmp_path):
    off = A.AuditLog(str(tmp_path / "audit"), enabled=False).open()
    assert off.record(A.LOGIN, actor=ANA) is None
    assert off.stats()["enabled"] is False


# ---- the chain ----------------------------------------------------------

def test_a_clean_trail_verifies(trail):
    for i in range(20):
        trail.record(A.STUDY_SENT, actor=ANA, target=f"study-{i}")
    result = trail.verify()
    assert result["ok"] is True
    assert result["records"] == 20
    assert result["broken_at"] is None
    assert result["head"] == trail.head()


def test_editing_one_record_is_detected_and_located(trail):
    for i in range(6):
        trail.record(A.STUDY_DELETED, actor=ANA, target=f"study-{i}")
    lines = open(trail.path).read().splitlines()
    doctored = json.loads(lines[2])
    doctored["actor"] = {"id": "u_ffffffffffff", "name": "Somebody Else",
                         "role": "", "service": False}
    lines[2] = json.dumps(doctored, sort_keys=True, separators=(",", ":"))
    open(trail.path, "w").write("\n".join(lines) + "\n")

    result = A.AuditLog(trail.dir).verify()
    assert result["ok"] is False
    assert result["broken_at"] == 3
    assert "altered" in result["reason"]


def test_deleting_a_record_is_detected(trail):
    """The tampering somebody actually attempts: remove the line about you."""
    for i in range(6):
        trail.record(A.STUDY_DELETED, actor=ANA, target=f"study-{i}")
    lines = open(trail.path).read().splitlines()
    del lines[3]
    open(trail.path, "w").write("\n".join(lines) + "\n")

    result = A.AuditLog(trail.dir).verify()
    assert result["ok"] is False
    assert "missing" in result["reason"] or "reordered" in result["reason"]


def test_reordering_records_is_detected(trail):
    for i in range(5):
        trail.record(A.STUDY_SENT, actor=ANA, target=f"study-{i}")
    lines = open(trail.path).read().splitlines()
    lines[1], lines[3] = lines[3], lines[1]
    open(trail.path, "w").write("\n".join(lines) + "\n")
    assert A.AuditLog(trail.dir).verify()["ok"] is False


def test_a_file_cut_mid_line_is_detected(trail):
    for i in range(4):
        trail.record(A.STUDY_SENT, actor=ANA, target=f"study-{i}")
    lines = open(trail.path).read().splitlines()
    open(trail.path, "w").write("\n".join(lines[:-1]) + "\n" + lines[-1][:40])
    result = A.AuditLog(trail.dir).verify()
    assert result["ok"] is False
    assert "not valid JSON" in result["reason"]


def test_truncating_the_END_is_NOT_detected_by_the_chain_alone(trail):
    """The limit, asserted so nobody has to discover it during an inspection.

    A hash chain authenticates the ORDER and CONTENT of what is present. It
    cannot speak about what is missing from the end: delete the last two records
    and the remaining prefix is a genuinely valid chain of everything before
    them, so verify() says intact — honestly, because as far as the file is
    concerned it is.

    What catches this is the head digest, published in status() precisely so it
    can be anchored somewhere this appliance cannot write. The assertions below
    are the two halves of that: verify() cannot tell, and the head can.
    """
    for i in range(6):
        trail.record(A.STUDY_SENT, actor=ANA, target=f"study-{i}")
    anchored_head = trail.head()
    anchored_count = trail.verify()["records"]

    lines = open(trail.path).read().splitlines()
    open(trail.path, "w").write("\n".join(lines[:-2]) + "\n")

    after = A.AuditLog(trail.dir).verify()
    assert after["ok"] is True, "documented limit — see the note at the top of pacs/audit.py"
    assert after["records"] == anchored_count - 2

    # …and this is why the head is published.
    assert after["head"] != anchored_head
    assert after["records"] < anchored_count


def test_verify_reports_the_first_break_not_every_consequence_of_it(trail):
    """Once a link is altered every digest after it fails as a consequence.

    A report of nine thousand failures hides the one that matters.
    """
    for i in range(30):
        trail.record(A.STUDY_SENT, actor=ANA, target=f"study-{i}")
    lines = open(trail.path).read().splitlines()
    doctored = json.loads(lines[1])
    doctored["target"] = "something else"
    lines[1] = json.dumps(doctored, sort_keys=True, separators=(",", ":"))
    open(trail.path, "w").write("\n".join(lines) + "\n")
    result = A.AuditLog(trail.dir).verify()
    assert result["broken_at"] == 2


# ---- persistence --------------------------------------------------------

def test_a_restart_continues_the_chain_rather_than_starting_a_new_one(trail):
    for i in range(3):
        trail.record(A.LOGIN, actor=ANA)
    reopened = A.AuditLog(trail.dir).open()
    reopened.record(A.LOGIN, actor=ANA)
    result = reopened.verify()
    assert result["ok"] is True and result["records"] == 4
    # The sequence keeps counting too — a restart that reset it to 1 would make
    # "record 3" ambiguous across the life of the appliance.
    assert json.loads(open(trail.path).read().splitlines()[-1])["seq"] == 4


def test_rotation_keeps_the_files_in_chronological_order(tmp_path):
    """The defect this test was written for.

    Archives are ordered lexically and verify() walks them in that order, so the
    filename has to sort chronologically. With the collision suffix added only
    when needed, "audit-<stamp>-1.jsonl" sorted BEFORE "audit-<stamp>.jsonl" —
    '-' is 0x2D and '.' is 0x2E — so two rotations inside the same second were
    read back in the wrong order and verify() reported a break in a trail that
    was perfectly intact. A false "your audit trail was tampered with" is about
    the worst thing this module could say.
    """
    small = A.AuditLog(str(tmp_path / "audit"), max_bytes=400).open()
    for i in range(40):
        small.record(A.STUDY_SENT, actor=ANA, target=f"study-{i}")
    files = [os.path.basename(f) for f in small.files()]
    assert len(files) > 3, files                 # it really did rotate, several times
    assert files == sorted(files[:-1]) + [A.CURRENT]
    assert small.verify()["ok"] is True, small.verify()


def test_rotation_does_not_lose_records(tmp_path):
    small = A.AuditLog(str(tmp_path / "audit"), max_bytes=400).open()
    for i in range(40):
        small.record(A.STUDY_SENT, actor=ANA, target=f"study-{i}")
    assert small.verify()["records"] == 40


# ---- never in the caller's way ------------------------------------------

def test_a_trail_that_cannot_be_written_reports_rather_than_raises(tmp_path):
    """A study delete that half-happened because recording it failed is worse
    than a gap in the trail. The gap is reported through `broken`.

    The denial is a directory standing where the record file goes, not a chmod.
    chmod cannot express "unwritable" on Windows — it sets only the read-only
    flag, and that flag is ignored on directories — and it cannot express it
    under root either, which is how this repo's own container images run. Either
    way the write would have succeeded and this test would have asserted
    nothing, which is how it went unnoticed that record()'s failure path had
    never once executed."""
    log = FakeLog()
    blocked = tmp_path / "nope"
    os.makedirs(str(blocked / A.CURRENT))
    t = A.AuditLog(str(blocked), log=log).open()
    assert t.record(A.STUDY_DELETED, actor=ANA) is None
    assert t.broken
    assert t.stats()["broken"]
    assert any(level == "error" for level, _ in log.lines)


def _make_unreadable(path: str) -> None:
    """Put a directory where a trail file was. Portable where chmod is not: this
    raises on every platform, under root, and inside a container."""
    os.remove(path)
    os.makedirs(path)


def test_a_trail_file_that_cannot_be_read_is_never_reported_intact(tmp_path):
    """The one answer verify() must never give about records it did not read.

    Skipping an unreadable file left verify() walking a short chain and calling
    it ok — so the dashboard's audit banner stayed green while an archive full
    of records was invisible. On Windows this is not exotic: a backup agent or a
    virus scanner holding a file open produces exactly the sharing violation
    that arrives here as OSError."""
    d = str(tmp_path / "audit")
    t = A.AuditLog(d, log=FakeLog()).open()
    for _ in range(3):
        t.record(A.LOGIN, actor=ANA)
    assert t.verify()["ok"] is True

    _make_unreadable(t.path)
    report = t.verify()
    assert report["ok"] is False, "a trail nobody could read was reported intact"
    assert A.CURRENT in report["reason"]
    assert "could not be read" in report["reason"]


def test_a_file_that_cannot_be_read_is_reported_by_read_all_not_stepped_over(tmp_path):
    """Everything downstream — verify(), the export, the dashboard — reads the
    trail through this one generator, so this is where the finding has to come
    from. Stepping over the file leaves each of them describing a trail that is
    missing records, with nothing to say so."""
    d = str(tmp_path / "audit")
    t = A.AuditLog(d, log=FakeLog()).open()
    t.record(A.LOGIN, actor=ANA)
    _make_unreadable(t.path)
    assert any("_unreadable" in r for r in t.read_all()), \
        "read_all stepped over the file instead of reporting it"


def test_a_head_that_cannot_be_read_stops_the_trail_instead_of_guessing(tmp_path,
                                                                       monkeypatch):
    """Chaining from an older archive — or from GENESIS — appends a record whose
    prev names the wrong link, and verify() then reports tampering on a trail
    nobody touched. Refusing to open is the honest failure, and it heals by
    itself: record() retries open() every time until the file reads again.

    The denial here is reads-refused-appends-fine, because that is the shape the
    problem actually arrives in — a scanner or backup agent holding the file
    open on Windows — and because a denial that blocked the append too would
    make this test pass for the wrong reason."""
    d = str(tmp_path / "audit")
    t = A.AuditLog(d, log=FakeLog()).open()
    for _ in range(3):
        t.record(A.LOGIN, actor=ANA)
    assert t.verify()["ok"] is True

    real_open = builtins.open
    live = t.path

    def refuse_to_read_the_live_file(path, mode="r", *a, **k):
        if str(path) == live and "r" in mode:
            raise PermissionError(13, "the file is held by another process")
        return real_open(path, mode, *a, **k)

    monkeypatch.setattr(builtins, "open", refuse_to_read_the_live_file)
    log = FakeLog()
    blind = A.AuditLog(d, log=log).open()
    assert blind.record(A.LOGIN, actor=ANA) is None, \
        "a record was appended under a head that could not be established"
    assert blind.broken
    assert any(level == "error" for level, _ in log.lines)

    monkeypatch.undo()
    assert t.verify()["ok"] is True, \
        "the trail now reports tampering that never happened"


def test_a_value_nothing_validated_cannot_stop_a_record_being_written(trail):
    """Losing the record is a worse outcome than storing an odd field oddly."""
    class Weird:
        def __repr__(self):
            return "<weird>"

    rec = trail.record(A.CONFIG_CHANGED, actor=ANA, detail={"thing": Weird()})
    assert rec is not None
    assert trail.verify()["ok"] is True


def test_the_head_is_published_for_external_anchoring(trail):
    """What closes the gap the chain cannot close on its own.

    Nothing kept beside the data can stop somebody with write access from
    rewriting the whole chain consistently. An anchor taken elsewhere can.
    """
    before = trail.head()
    trail.record(A.LOGIN, actor=ANA)
    assert trail.head() != before
    assert trail.stats()["head"] == trail.head()


def test_tail_filters_by_action_and_by_actor(trail):
    other = U.Profile({"id": "u_ffffffffffff", "name": "Bea", "role": "it"})
    trail.record(A.LOGIN, actor=ANA)
    trail.record(A.STUDY_DELETED, actor=ANA, target="x")
    trail.record(A.LOGIN, actor=other)
    assert [r["actor"]["name"] for r in trail.tail(action=A.LOGIN)] == ["Bea", "Ana Ruiz"]
    assert len(trail.tail(actor_id=ANA.id)) == 2


def test_tail_is_newest_first(trail):
    for i in range(5):
        trail.record(A.STUDY_SENT, actor=ANA, target=str(i))
    assert [r["target"] for r in trail.tail(3)] == ["4", "3", "2"]


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
