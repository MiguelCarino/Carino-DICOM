"""Study browser for the dashboard's transaction history.

Walks a storage folder (received or the sent/archive folder), reads one header
per directory to group instances into studies, and exposes safe delete helpers.
Everything is path-based and gated to the given root via ``safe_within``.

The DIRECTORY is the unit of that grouping, not the SeriesInstanceUID: one
header is read per folder and stands for the whole folder. That is why a series
stored in two folders is listed twice and two series sharing a folder are listed
once — the browser describes the shelf, not the catalogue, and an operator
hunting for a study on disk needs the shelf.

Serving this from the sqlite index instead of the disk was built and taken back
out, and the reasons are worth writing down because it is the obvious idea. The
index normalises what it stores — SeriesNumber into an INTEGER column, StudyDate
to bare digits, Modality to upper case — so a header carrying ``003`` or
``2024.01.15`` came back different from the two paths, and because the series
list is sorted on that string it came back in a different ORDER too. Worse, an
index cannot say whether it is complete: a first rescan halfway through its
batches reads exactly like a small archive, and a row left behind by a folder
removed out of band becomes a study that is not on disk — which widens a
multi-folder study's ``path`` to a common ancestor, the ancestor the delete
button is then pointed at. A browser whose job is to hand an operator a path to
delete has to have looked at the path.
"""

from __future__ import annotations

import os
import shutil

from .dicomfs import is_dicom, prune_empty_dirs, safe_within


def _read_header(path: str):
    try:
        from pydicom import dcmread
        return dcmread(path, stop_before_pixels=True, force=True)
    except Exception:
        return None


def _fmt_date(raw) -> str:
    s = str(raw or "").strip()
    if len(s) == 8 and s.isdigit():
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    return s


def _fmt_name(raw) -> str:
    """DICOM PersonName 'Family^Given^Middle^Prefix^Suffix' → 'Given Family'."""
    s = str(raw or "").strip()
    if not s:
        return ""
    parts = s.split("^")
    fam = parts[0].strip() if parts else ""
    giv = parts[1].strip() if len(parts) > 1 else ""
    if fam or giv:
        return (f"{giv} {fam}").strip()
    return s.replace("^", " ").strip()


def scan_studies(root: str, max_studies: int = 800) -> list[dict]:
    """Group every stored instance under *root* into studies (newest first)."""
    if not root or not os.path.isdir(root):
        return []

    studies: dict[str, dict] = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        # One magic-byte test per file. Counting the folder and finding its
        # header were two loops over the same names, and a count cannot stop
        # early, so every file the hunt had already tested was tested again.
        hdr = None
        count = 0
        for f in sorted(f for f in filenames if not f.startswith(".")):
            p = os.path.join(dirpath, f)
            if not is_dicom(p):
                continue
            count += 1
            if hdr is None:
                hdr = _read_header(p)
        if hdr is None:
            continue

        suid = str(getattr(hdr, "StudyInstanceUID", "") or "")
        # A study with no StudyInstanceUID is keyed on the directory's PARENT,
        # so the Patient/Study/Series trees the SCP writes still collapse into
        # one row when the sender left the UID out.
        key = suid or os.path.dirname(dirpath) or dirpath
        st = studies.get(key)
        if st is None:
            # The study-level tags are read once, in the first folder of the
            # study to be reached. Every attribute read off a pydicom Dataset
            # converts a raw element, so pulling them again in each of a
            # multi-folder study's folders costs more than fusing the two loops
            # above ever saved — and the later folders' values are discarded.
            st = {
                "patient": _fmt_name(getattr(hdr, "PatientName", "")),
                "patient_id": str(getattr(hdr, "PatientID", "") or ""),
                "study_date": _fmt_date(getattr(hdr, "StudyDate", "")),
                "study_desc": str(getattr(hdr, "StudyDescription", "") or ""),
                "study_uid": suid,
                "series": [],
                "instances": 0,
                "_dirs": [],
                "_mods": set(),
                "mtime": 0.0,
            }
            studies[key] = st

        modality = str(getattr(hdr, "Modality", "") or "")
        if modality:
            st["_mods"].add(modality)
        st["series"].append({
            "desc": str(getattr(hdr, "SeriesDescription", "") or ""),
            "modality": modality,
            "number": str(getattr(hdr, "SeriesNumber", "") or ""),
            "count": count,
        })
        st["instances"] += count
        st["_dirs"].append(dirpath)
        try:
            # The DIRECTORY's mtime, never a file's: archiving copies files with
            # copy2 (which preserves their mtimes) into a freshly created folder,
            # so only the folder records that the study moved, and the browser's
            # whole job is to show what moved recently.
            st["mtime"] = max(st["mtime"], os.path.getmtime(dirpath))
        except OSError:
            pass

    out = []
    for st in studies.values():
        dirs = st.pop("_dirs")
        try:
            st["path"] = os.path.commonpath(dirs) if len(dirs) > 1 else dirs[0]
        except ValueError:
            st["path"] = dirs[0]
        st["modality"] = ",".join(sorted(st.pop("_mods"))) or "?"
        st["series"].sort(key=lambda s: (s.get("number") or "", s.get("desc") or ""))
        out.append(st)
    # Sorted before the cap, so it keeps the newest studies rather than
    # whichever ones os.walk happened to reach first.
    out.sort(key=lambda s: s.get("mtime", 0), reverse=True)
    return out[:max_studies]


def study_files(root: str, path: str) -> list[str]:
    """All DICOM files under *path* (a study dir or single file), gated to root."""
    if not safe_within(root, path):
        raise ValueError("path is outside the storage folder")
    files: list[str] = []
    if os.path.isdir(path):
        for dp, _dn, fns in os.walk(path):
            for f in fns:
                if f.startswith("."):
                    continue
                fp = os.path.join(dp, f)
                if is_dicom(fp):
                    files.append(fp)
    elif os.path.isfile(path) and is_dicom(path):
        files.append(path)
    return files


def study_identity(root: str, path: str) -> dict:
    """Patient/study identity of an existing study, for a report/image attached
    to it to inherit (keeps the new instance grouped under the same study).

    Gated to *root* via study_files; returns {} if the study has no DICOM."""
    files = study_files(root, path)
    hdr = None
    for p in files:
        hdr = _read_header(p)
        if hdr is not None:
            break
    if hdr is None:
        return {}
    return {
        "patient": _fmt_name(getattr(hdr, "PatientName", "")),
        "patient_name": str(getattr(hdr, "PatientName", "") or ""),
        "patient_id": str(getattr(hdr, "PatientID", "") or ""),
        "study_uid": str(getattr(hdr, "StudyInstanceUID", "") or ""),
        "study_date": str(getattr(hdr, "StudyDate", "") or ""),
        "study_desc": str(getattr(hdr, "StudyDescription", "") or ""),
        "accession": str(getattr(hdr, "AccessionNumber", "") or ""),
        "study_id": str(getattr(hdr, "StudyID", "") or ""),
    }


def delete_study(root: str, path: str) -> None:
    """Delete one study's folder (or file) and prune the empty parents it leaves."""
    real_root = os.path.realpath(root)
    real_path = os.path.realpath(path)
    if real_path == real_root or not safe_within(root, path):
        raise ValueError("refusing to delete outside the storage folder")
    if os.path.isdir(real_path):
        shutil.rmtree(real_path)
    elif os.path.isfile(real_path):
        os.remove(real_path)
    else:
        raise ValueError("study no longer exists")
    prune_empty_dirs(os.path.dirname(real_path), real_root)


def delete_all(root: str) -> int:
    """Remove every study under *root* (keeps the root and any hidden sidecars)."""
    if not root or not os.path.isdir(root):
        return 0
    removed = 0
    for name in os.listdir(root):
        if name.startswith("."):        # keep .carinopacs_state.json etc.
            continue
        p = os.path.join(root, name)
        try:
            if os.path.isdir(p):
                shutil.rmtree(p)
            else:
                os.remove(p)
            removed += 1
        except OSError:
            pass
    return removed
