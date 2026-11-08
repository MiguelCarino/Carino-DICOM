"""packaging/make_sbom.py: the build-time SPDX bill of materials.

The SBOM is generated, never committed (requirements.txt gives ranges, so only
the installed environment knows the versions). These tests run the generator
against the test interpreter's own site-packages and check that what it writes
is internally consistent and true of this checkout, in particular that every
checksum folded in from the bundled editor's sbom.spdx.json matches the file on
disk. That last one is the check that a re-sync of pacs/web/editor/ copied the
SBOM together with the bundles it describes.
"""

from __future__ import annotations

import hashlib
import importlib.metadata as md
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("make_sbom", ROOT / "packaging" / "make_sbom.py")
make_sbom = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(make_sbom)


@pytest.fixture(scope="module")
def doc():
    return make_sbom.build(created="2026-01-01T00:00:00Z")


def test_document_header(doc):
    assert doc["spdxVersion"] == "SPDX-2.3"
    assert doc["dataLicense"] == "CC0-1.0"
    assert doc["SPDXID"] == "SPDXRef-DOCUMENT"
    assert doc["creationInfo"]["created"] == "2026-01-01T00:00:00Z"
    assert doc["documentNamespace"].startswith("https://")


def test_ids_are_unique_and_relationships_resolve(doc):
    ids = [p["SPDXID"] for p in doc["packages"]] + [f["SPDXID"] for f in doc["files"]]
    assert len(ids) == len(set(ids))
    known = set(ids) | {"SPDXRef-DOCUMENT"}
    for r in doc["relationships"]:
        assert r["spdxElementId"] in known, r
        assert r["relatedSpdxElement"] in known, r


def test_every_requirement_is_listed_at_its_installed_version(doc):
    by_name = {p["name"].lower(): p for p in doc["packages"] if p["SPDXID"].startswith("SPDXRef-Package-pypi-")}
    text = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    for name in make_sbom._requirement_names(text):
        try:
            installed = md.version(name)
        except md.PackageNotFoundError:
            pytest.skip(f"{name} is not installed in the test interpreter")
        pkg = by_name.get(name.lower()) or by_name.get(make_sbom._norm(name))
        assert pkg is not None, name
        assert pkg["versionInfo"] == installed


def test_pydicom_licence_and_purl(doc):
    pkg = next(p for p in doc["packages"] if p["SPDXID"] == "SPDXRef-Package-pypi-pydicom")
    assert pkg["licenseConcluded"] == "MIT"
    assert pkg["externalRefs"][0]["referenceLocator"] == f"pkg:pypi/pydicom@{md.version('pydicom')}"


def test_bundled_editor_files_match_the_checkout(doc):
    files = [f for f in doc["files"] if f["fileName"].startswith(make_sbom.EDITOR_PREFIX)]
    assert files, "the bundled editor's SBOM was not folded in"
    for f in files:
        path = ROOT / f["fileName"].removeprefix("./")
        assert path.is_file(), f["fileName"]
        want = {c["algorithm"]: c["checksumValue"] for c in f["checksums"]}
        data = path.read_bytes()
        assert hashlib.sha256(data).hexdigest() == want["SHA256"], f["fileName"]
        assert hashlib.sha1(data).hexdigest() == want["SHA1"], f["fileName"]


def test_editor_is_contained_by_the_engine(doc):
    rel = [r for r in doc["relationships"]
           if r["spdxElementId"] == "SPDXRef-Package-carino-dicom"
           and r["relatedSpdxElement"] == "SPDXRef-Package-editor-carino-dicom-editor"]
    assert rel and rel[0]["relationshipType"] == "CONTAINS"


def test_deterministic_for_one_environment():
    a = make_sbom.build(created="2026-01-01T00:00:00Z")
    b = make_sbom.build(created="2026-01-01T00:00:00Z")
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def test_main_writes_a_file(tmp_path):
    out = tmp_path / "sbom.json"
    assert make_sbom.main(["--out", str(out)]) == 0
    assert json.loads(out.read_text(encoding="utf-8"))["spdxVersion"] == "SPDX-2.3"
