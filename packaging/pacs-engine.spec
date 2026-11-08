# PyInstaller spec for the Carino DICOM engine (onedir).
# Build from the repo root:
#     pyinstaller packaging/pacs-engine.spec --distpath desktop/engine --workpath build/pyi
# Produces:  desktop/engine/pacs-engine/pacs-engine[.exe]  (+ _internal/)
# The Electron app bundles that folder as an extraResource and launches the binary.

import importlib.util
import os

from PyInstaller.utils.hooks import collect_all, copy_metadata

# Fail LOUDLY if a required dependency isn't importable in the Python running
# PyInstaller. Otherwise collect_all() silently no-ops on the missing package
# and the frozen engine ships without it — crashing at launch with
# "ModuleNotFoundError: No module named 'pydicom'" and serving nothing. Always
# freeze with the venv from ./setup.sh (which installs requirements.txt).
_REQUIRED = ("pydicom", "pynetdicom", "flask", "PIL", "psutil",
             # Transcoding (pacs/transcode.py). A bundle without them still runs —
             # it sends and serves everything as stored — but a desktop install
             # is a binary nobody can pip-install into, so a missing codec there
             # is a codec missing for good. Freezing without them is refused.
             "numpy", "pylibjpeg", "openjpeg", "rle", "libjpeg")
_missing = [m for m in _REQUIRED if importlib.util.find_spec(m) is None]
if _missing:
    raise SystemExit(
        "\n\nCannot freeze Carino DICOM: missing dependencies in this Python: "
        + ", ".join(_missing)
        + "\nFreeze with the project venv instead:\n"
        "  rm -rf .venv && ./setup.sh\n"
        "  ./.venv/bin/python -m PyInstaller packaging/pacs-engine.spec --distpath desktop/engine --workpath build/pyi\n"
    )

# Paths in a .spec resolve relative to the spec's own dir (SPECPATH), so anchor
# everything to the repo root (the spec lives in <root>/packaging/).
ROOT = os.path.dirname(SPECPATH)

datas, binaries, hiddenimports = [], [], []
# Import names. jpeg_ls (pyjpegls, JPEG-LS encode) is optional: requirements.txt
# skips it on CPython 3.14+, where it has no wheel, and JPEG-LS still decodes
# through libjpeg — so it is collected when present and not demanded.
_CODECS = ("numpy", "pylibjpeg", "openjpeg", "rle", "libjpeg")
_OPTIONAL = tuple(m for m in ("jpeg_ls",) if importlib.util.find_spec(m) is not None)
for pkg in ("pynetdicom", "pydicom", "PIL", "psutil") + _CODECS + _OPTIONAL:
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# pydicom never imports the codecs: pylibjpeg finds them through the entry
# points in their dist-info (pylibjpeg.pixel_data_decoders / _encoders), read
# with importlib.metadata at runtime. collect_all() copies metadata only for a
# distribution named like the import package, and none of these is —
# pylibjpeg-openjpeg ships `openjpeg`, pyjpegls ships `jpeg_ls` — so without
# these lines the frozen engine has every codec on disk and finds none of them.
for dist in ("pylibjpeg", "pylibjpeg-openjpeg", "pylibjpeg-rle", "pylibjpeg-libjpeg", "numpy") \
        + (("pyjpegls",) if _OPTIONAL else ()):
    datas += copy_metadata(dist)
# The compiled halves live at top level beside their packages (_openjpeg.so,
# _libjpeg.so, _CharLS.so), outside what collect_all("openjpeg") walks. The
# packages import them, so analysis normally follows; named here so a lazy
# import in a future release cannot drop them silently.
hiddenimports += [m for m in ("_openjpeg", "_libjpeg", "_CharLS")
                  if importlib.util.find_spec(m) is not None]

# Our Flask dashboard assets (served from disk by pacs/web.py).
datas += [(os.path.join(ROOT, "pacs", "web"), "pacs/web")]

# The manual, so the appliance carries its own documentation. A desktop install
# is the deployment most likely to be sitting on a clinical VLAN with no route
# to the internet, which is exactly where somebody needs the page explaining
# what a held study is. It is bundled at the top level rather than under
# pacs/web/ because docs/manual/ is also what GitHub Pages publishes, and one
# copy that both serve is the only arrangement in which they cannot drift.
# pacs.web.MANUAL_DIR looks for it here; see the note there for why the pages'
# relative paths still resolve.
#
# Everything except tools/, which is how the figures are REGENERATED — a
# screenshot harness, a DICOM forger and a traffic seeder. None of it is
# documentation an operator reads, and a traffic generator inside a medical
# appliance is a thing somebody has to explain in a review. It stays in the
# repository, where the person re-shooting the manual is.
#
# Computed rather than listed so that a directory added to the manual later
# ships without anyone remembering this file. That fails toward shipping too
# much documentation, which is the safe direction; only the one name below is
# ever held back.
_MANUAL_SRC = os.path.join(ROOT, "docs", "manual")
_MANUAL_SKIP = {"tools"}
for _name in sorted(os.listdir(_MANUAL_SRC)):
    if _name in _MANUAL_SKIP:
        continue
    _path = os.path.join(_MANUAL_SRC, _name)
    # A directory source contributes its CONTENTS to the destination, so each
    # one needs its own name on the right-hand side; a file just lands in it.
    datas += [(_path, os.path.join("manual", _name) if os.path.isdir(_path) else "manual")]

a = Analysis(
    [os.path.join(ROOT, "packaging", "engine_entry.py")],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports + ["flask", "werkzeug", "jinja2"],
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="pacs-engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,          # Electron spawns it with windowsHide:true, so no window
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="pacs-engine",
)
