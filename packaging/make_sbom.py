"""Write an SPDX 2.3 software bill of materials for one build of Carino DICOM.

    python packaging/make_sbom.py                       # ./carino-dicom.spdx.json
    python packaging/make_sbom.py --out dist/sbom.json

Run it with the interpreter whose site-packages is being shipped: the Docker
builder's /opt/venv, or the .venv that PyInstaller freezes. It describes what
is *installed* there, not what requirements.txt allows. That is the whole
reason it runs at build time instead of being committed: requirements.txt
gives ranges (``pydicom>=3.0``), so a checked-in SBOM would be wrong the day
any dependency released, and wrong in a way nobody would notice.

What it lists:

* Every distribution reachable from requirements.txt through installed
  ``Requires-Dist`` metadata (pip, setuptools and test tools are not shipped
  and are not reached), with its version, its licence as declared in the
  package metadata, and a purl. The licence is the package's own claim,
  normalised to an SPDX id where the trove classifier or field maps cleanly,
  and ``NOASSERTION`` where it does not: a guess would be worse than a gap.
* The C libraries compiled into those wheels, which a scanner reading
  package names would never see: OpenJPEG in pylibjpeg-openjpeg, CharLS in
  pyjpegls, libjpeg in pylibjpeg-libjpeg, Pillow's image libraries, OpenSSL in
  cryptography. Versions are asked of the libraries themselves at run time
  where they say (Pillow's ``features.version``, ``get_openjpeg_version``,
  OpenSSL's version text), and are ``NOASSERTION`` where they do not.
* The bundled editor's components, folded in from
  ``pacs/web/editor/sbom.spdx.json``. That file is upstream's, re-synced with
  the tree it describes, and it carries a SHA-1/SHA-256 of every vendored file;
  its file paths are re-rooted under ``pacs/web/editor/`` here.

Not listed: the CPython the installer or image carries (the base image or the
build runner decides it), and the Electron shell, whose dependencies are in
``desktop/package-lock.json`` (``npm sbom`` reads that directly).

Deterministic for a given environment: the namespace is a hash of the
content, and ``created`` comes from SOURCE_DATE_EPOCH when set.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import importlib.metadata as md
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EDITOR_SBOM = ROOT / "pacs" / "web" / "editor" / "sbom.spdx.json"
EDITOR_PREFIX = "./pacs/web/editor/"

# Trove classifiers and free-text License fields seen in this dependency tree,
# mapped to SPDX ids. Anything not here is reported as NOASSERTION.
_CLASSIFIER = {
    "MIT License": "MIT",
    "BSD License": "BSD-3-Clause",
    "Apache Software License": "Apache-2.0",
    "Python Software Foundation License": "PSF-2.0",
    "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "GNU General Public License v3 (GPLv3)": "GPL-3.0-only",
    "GNU General Public License v3 or later (GPLv3+)": "GPL-3.0-or-later",
    "GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0-only",
    "ISC License (ISCL)": "ISC",
    "Historical Permission Notice and Disclaimer (HPND)": "HPND",
    "The Unlicense (Unlicense)": "Unlicense",
}
_SPDX_ID = re.compile(r"^[A-Za-z0-9.+-]+( (AND|OR|WITH) [A-Za-z0-9.+-]+)*$")


def _norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _license(dist: md.Distribution) -> str:
    meta = dist.metadata
    expr = (meta.get("License-Expression") or "").strip()
    if expr and _SPDX_ID.match(expr):
        return expr
    found = []
    for c in meta.get_all("Classifier") or []:
        if c.startswith("License :: OSI Approved :: ") or c.startswith("License :: "):
            spdx = _CLASSIFIER.get(c.rsplit(" :: ", 1)[-1])
            if spdx and spdx not in found:
                found.append(spdx)
    if found:
        return " AND ".join(found)
    field = (meta.get("License") or "").strip()
    # A short field that is already an SPDX id ("MIT", "BSD-3-Clause"); long
    # fields are usually the whole licence text, which says nothing parseable.
    if field and len(field) < 40 and _SPDX_ID.match(field):
        return field
    return "NOASSERTION"


def _requirement_names(text: str) -> list[str]:
    names = []
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)", line)
        if m:
            names.append(m.group(1))
    return names


def _closure(roots: list[str]) -> dict[str, md.Distribution]:
    """Installed distributions reachable from roots, keyed by normalised name.

    Extras are not followed and environment markers are evaluated loosely: a
    requirement guarded by ``extra ==`` is skipped, any other marker is taken
    when the distribution is installed (if it is installed, it shipped)."""
    seen: dict[str, md.Distribution] = {}
    todo = list(roots)
    while todo:
        name = todo.pop()
        key = _norm(name)
        if key in seen:
            continue
        try:
            dist = md.distribution(name)
        except md.PackageNotFoundError:
            continue
        seen[key] = dist
        for req in dist.requires or []:
            if "extra ==" in req.replace("extra==", "extra =="):
                continue
            m = re.match(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)", req)
            if m:
                todo.append(m.group(1))
    return seen


def _pil(feature: str):
    from PIL import features
    return features.version(feature)


def _openjpeg():
    from openjpeg.utils import get_openjpeg_version
    return ".".join(str(n) for n in get_openjpeg_version())


def _openssl():
    from cryptography.hazmat.backends.openssl.backend import backend
    m = re.match(r"OpenSSL (\S+)", backend.openssl_version_text())
    return m.group(1) if m else None


# (wheel distribution, library, SPDX licence, version probe or None, CPE vendor:product or None).
# Statically linked or bundled into the wheel; the wheel's own licence covers its wrapper only.
NATIVE = [
    ("pylibjpeg-openjpeg", "OpenJPEG", "BSD-2-Clause", _openjpeg, "uclouvain:openjpeg"),
    ("pyjpegls", "CharLS", "BSD-3-Clause", None, "team-charls:charls"),
    ("pylibjpeg-libjpeg", "libjpeg (Thomas Richter)", "GPL-3.0-only", None, None),
    ("pillow", "libjpeg-turbo", "IJG AND BSD-3-Clause AND Zlib", lambda: _pil("libjpeg_turbo"), "libjpeg-turbo:libjpeg-turbo"),
    ("pillow", "OpenJPEG", "BSD-2-Clause", lambda: _pil("jpg_2000"), "uclouvain:openjpeg"),
    ("pillow", "zlib-ng", "Zlib", lambda: _pil("zlib"), None),
    ("pillow", "libtiff", "libtiff", lambda: _pil("libtiff"), "libtiff:libtiff"),
    ("pillow", "libwebp", "BSD-3-Clause", lambda: _pil("webp"), "webmproject:libwebp"),
    ("pillow", "FreeType", "FTL OR GPL-2.0-or-later", lambda: _pil("freetype2"), "freetype:freetype"),
    ("pillow", "Little CMS", "MIT", lambda: _pil("littlecms2"), "littlecms:little_cms_color_engine"),
    ("pillow", "libavif", "BSD-2-Clause", lambda: _pil("avif"), "aomedia:libavif"),
    ("pillow", "libraqm", "MIT", lambda: _pil("raqm"), None),
    ("cryptography", "OpenSSL", "Apache-2.0", _openssl, "openssl:openssl"),
]


def _probe(fn) -> str:
    if fn is None:
        return "NOASSERTION"
    try:
        v = fn()
    except Exception:
        return "NOASSERTION"
    return str(v) if v else "NOASSERTION"


def _created() -> str:
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    when = (_dt.datetime.fromtimestamp(int(epoch), _dt.timezone.utc) if epoch
            else _dt.datetime.now(_dt.timezone.utc))
    return when.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _version() -> str:
    text = (ROOT / "pacs" / "__init__.py").read_text(encoding="utf-8")
    m = re.search(r'__version__\s*=\s*"([^"]+)"', text)
    return m.group(1) if m else "NOASSERTION"


def build(requirements: Path = ROOT / "requirements.txt", editor_sbom: Path = EDITOR_SBOM,
          created: str | None = None) -> dict:
    version = _version()
    root_id = "SPDXRef-Package-carino-dicom"
    packages = [{
        "SPDXID": root_id, "name": "Carino DICOM", "versionInfo": version,
        "downloadLocation": "git+https://github.com/MiguelCarino/Carino-DICOM",
        "licenseConcluded": "AGPL-3.0-or-later", "licenseDeclared": "AGPL-3.0-or-later",
        "copyrightText": "NOASSERTION", "filesAnalyzed": False, "supplier": "Person: Miguel Carino",
        "comment": "Only third-party components are listed; the engine's own sources are not enumerated.",
    }]
    files: list[dict] = []
    rels = [{"spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": root_id}]

    roots = _requirement_names(requirements.read_text(encoding="utf-8"))
    dists = _closure(roots)
    direct = {_norm(n) for n in roots}
    for key in sorted(dists):
        dist = dists[key]
        name, ver = dist.metadata["Name"], dist.version
        pid = f"SPDXRef-Package-pypi-{key}"
        lic = _license(dist)
        packages.append({
            "SPDXID": pid, "name": name, "versionInfo": ver,
            "downloadLocation": f"https://pypi.org/project/{name}/{ver}/",
            "licenseConcluded": lic, "licenseDeclared": lic, "copyrightText": "NOASSERTION",
            "filesAnalyzed": False, "supplier": "NOASSERTION",
            "externalRefs": [{"referenceCategory": "PACKAGE-MANAGER", "referenceType": "purl",
                              "referenceLocator": f"pkg:pypi/{key}@{ver}"}],
        })
        rels.append({"spdxElementId": root_id,
                     "relationshipType": "DEPENDS_ON" if key in direct else "CONTAINS",
                     "relatedSpdxElement": pid})
        if key not in direct:
            rels[-1]["comment"] = "installed as a dependency of a requirement"

    for wheel, lib, lic, probe, cpe in NATIVE:
        key = _norm(wheel)
        if key not in dists:
            continue
        ver = _probe(probe)
        if ver == "NOASSERTION" and probe is not None and wheel == "pillow":
            continue  # a Pillow build without that codec: nothing shipped
        pid = f"SPDXRef-Package-native-{key}-{_norm(lib).replace(' ', '-').replace('(', '').replace(')', '')}"
        pkg = {"SPDXID": pid, "name": lib, "versionInfo": ver, "downloadLocation": "NOASSERTION",
               "licenseConcluded": lic, "licenseDeclared": lic, "copyrightText": "NOASSERTION",
               "filesAnalyzed": False, "supplier": "NOASSERTION",
               "comment": f"compiled into the {dists[key].metadata['Name']} wheel"}
        if cpe and ver != "NOASSERTION":
            pkg["externalRefs"] = [{"referenceCategory": "SECURITY", "referenceType": "cpe23Type",
                                    "referenceLocator": f"cpe:2.3:a:{cpe}:{ver}:*:*:*:*:*:*:*"}]
        packages.append(pkg)
        rels.append({"spdxElementId": f"SPDXRef-Package-pypi-{key}", "relationshipType": "CONTAINS",
                     "relatedSpdxElement": pid})

    if editor_sbom.exists():
        ed = json.loads(editor_sbom.read_text(encoding="utf-8"))
        remap = {}
        for p in ed["packages"]:
            new = p["SPDXID"].replace("SPDXRef-Package-", "SPDXRef-Package-editor-", 1)
            remap[p["SPDXID"]] = new
            packages.append({**p, "SPDXID": new})
        for f in ed["files"]:
            new = f["SPDXID"].replace("SPDXRef-File-", "SPDXRef-File-editor-", 1)
            remap[f["SPDXID"]] = new
            files.append({**f, "SPDXID": new, "fileName": EDITOR_PREFIX + f["fileName"].removeprefix("./")})
        for r in ed["relationships"]:
            if r["spdxElementId"] == "SPDXRef-DOCUMENT":
                continue
            rels.append({**r, "spdxElementId": remap[r["spdxElementId"]],
                         "relatedSpdxElement": remap[r["relatedSpdxElement"]]})
        rels.append({"spdxElementId": root_id, "relationshipType": "CONTAINS",
                     "relatedSpdxElement": remap["SPDXRef-Package-carino-dicom-editor"],
                     "comment": "bundled at pacs/web/editor/, served at /editor/"})

    body = {"packages": packages, "files": files, "relationships": rels}
    digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:32]
    return {
        "spdxVersion": "SPDX-2.3", "dataLicense": "CC0-1.0", "SPDXID": "SPDXRef-DOCUMENT",
        "name": f"Carino DICOM {version} build components",
        "documentNamespace": f"https://github.com/MiguelCarino/Carino-DICOM/spdx/{version}-{digest}",
        "creationInfo": {
            "created": created or _created(),
            "creators": ["Tool: packaging/make_sbom.py",
                         f"Tool: Python-{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"],
        },
        **body,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default="carino-dicom.spdx.json", help="where to write the SBOM")
    args = ap.parse_args(argv)
    doc = build()
    missing = [n for n in _requirement_names((ROOT / "requirements.txt").read_text(encoding="utf-8"))
               if _norm(n) not in {p["SPDXID"].removeprefix("SPDXRef-Package-pypi-") for p in doc["packages"]}]
    if missing:
        # An SBOM written from the wrong interpreter would silently list nothing.
        print(f"make_sbom: not installed in this interpreter: {', '.join(missing)}", file=sys.stderr)
        return 1
    Path(args.out).write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.out}: {len(doc['packages'])} packages, {len(doc['files'])} files", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
