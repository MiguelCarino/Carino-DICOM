"""Where an install looks for its config, its studies and its logs.

The product shipped as Carino PACS and was renamed to Carino DICOM after 1.0.0,
so two home directories are in circulation: ``~/CarinoDICOM`` for anything
installed since, ``~/CarinoPACS`` for anything installed before. ``default_dir``
picks between them, and the order it picks in is the whole point of this file.

Get it wrong in the obvious direction — check the old name first — and a user
who has already migrated is silently handed the stale ``~/CarinoPACS`` still
sitting in their home. Every study filed since the move is invisible, nothing
errors, and the archive looks like it lost months of work. Get it wrong in the
other direction — drop the legacy branch — and an install made before the rename
comes up on a brand new empty directory with its own archive still on disk and
unreferenced. Both failures are silent, both look like data loss, and neither is
caught by any other suite. Hence six tests for four lines of code.

The HOME juggling below is deliberate: the pytest ``monkeypatch`` fixture would
work under pytest and nowhere else, and every file here has to keep running as

    ./.venv/bin/python tests/test_config_dir.py     # or under pytest
"""
from __future__ import annotations

import copy
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pacs.config import DEFAULTS, DEFAULT_CONFIG, default_dir, validate  # noqa: E402


class fake_home:
    """A throwaway home directory, optionally pre-seeded with data dirs.

    USERPROFILE goes along with HOME because that is what ``expanduser`` reads
    on Windows, and a test that only sets one passes on the author's laptop and
    resolves the real home everywhere else.
    """

    def __init__(self, *existing: str):
        self.existing = existing

    def __enter__(self) -> str:
        self._tmp = tempfile.TemporaryDirectory()
        self._saved = {k: os.environ.get(k) for k in ("HOME", "USERPROFILE")}
        os.environ["HOME"] = os.environ["USERPROFILE"] = self._tmp.name
        for name in self.existing:
            os.makedirs(os.path.join(self._tmp.name, name))
        return self._tmp.name

    def __exit__(self, *exc):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()
        return False


def test_the_new_directory_wins_when_both_exist():
    """The branch that keeps a migrated user out of a stale archive.

    Having both is normal, not exotic: moving the data is a copy for most people
    and the old directory stays behind until they get round to deleting it.
    """
    with fake_home("CarinoDICOM", "CarinoPACS") as home:
        assert default_dir() == os.path.join(home, "CarinoDICOM")


def test_a_legacy_install_keeps_its_old_directory():
    """An install from before the rename must come up on its own archive, with
    nothing to do and nothing to notice."""
    with fake_home("CarinoPACS") as home:
        assert default_dir() == os.path.join(home, "CarinoPACS")


def test_a_clean_machine_gets_the_new_name():
    with fake_home() as home:
        assert default_dir() == os.path.join(home, "CarinoDICOM")


def test_only_the_new_directory_is_also_the_new_directory():
    with fake_home("CarinoDICOM") as home:
        assert default_dir() == os.path.join(home, "CarinoDICOM")


def test_resolving_the_default_creates_nothing():
    """config.py is imported by ``--help`` and by the packaging preflight, so a
    mkdir at resolution time would litter a home directory on a command that was
    only ever asking a question. The directory is made by Config.save()."""
    with fake_home() as home:
        default_dir()
        assert not os.path.exists(os.path.join(home, "CarinoDICOM"))
        assert not os.path.exists(os.path.join(home, "CarinoPACS"))


def test_the_default_config_sits_in_the_resolved_directory():
    """The config file is not addressed separately: it is always ``config.json``
    inside whichever directory the resolver picked, which is what makes the
    fallback above worth anything.

    DEFAULT_CONFIG is frozen at import, so it is checked against the real home
    rather than a fake one — under a fake home the same invariant is asserted
    against a freshly resolved directory instead. The AE title check rides along
    because the same rename moved the scp default, and a default that fails the
    16-character DICOM limit would break every fresh install at first save.
    """
    assert DEFAULT_CONFIG == os.path.join(default_dir(), "config.json")
    with fake_home("CarinoPACS") as home:
        assert os.path.join(default_dir(), "config.json") == os.path.join(
            home, "CarinoPACS", "config.json")

    assert DEFAULTS["scp"]["aet"] == "CARINODICOM"
    assert len(DEFAULTS["scp"]["aet"]) <= 16
    validate(copy.deepcopy(DEFAULTS))


def main():
    passed, failed = 0, 0
    for fn in sorted(
        (v for k, v in globals().items() if k.startswith("test_")),
        key=lambda f: f.__code__.co_firstlineno,
    ):
        try:
            fn()
        except AssertionError as exc:
            failed += 1
            print("  FAIL  " + fn.__name__ + " " + str(exc))
        else:
            passed += 1
            print("  ok    " + fn.__name__)
    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
