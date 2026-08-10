"""Small filesystem helpers shared by the watcher and the history/browse code."""

from __future__ import annotations

import inspect
import os

from pydicom.dataset import Dataset

# How to ask pydicom for a complete Part 10 file (preamble + meta) on whichever
# version is installed. pydicom 3 renamed write_like_original=False to
# enforce_file_format=True and left the old spelling working but deprecated, so a
# call site that hard-codes the old name is silently fine today and raises the day
# pydicom drops it — taking the C-STORE write path with it. Resolved once, here.
SAVE_KWARGS = (
    {"enforce_file_format": True}
    if "enforce_file_format" in inspect.signature(Dataset.save_as).parameters
    else {"write_like_original": False}
)


def save_dicom(ds, path) -> None:
    """Write *ds* as a complete Part 10 file, whatever pydicom version is installed."""
    ds.save_as(path, **SAVE_KWARGS)


def is_dicom(path: str) -> bool:
    """True if the file has the DICM magic at offset 128 (extension-agnostic).

    Asked of every file the watcher and the browse walk meet, including the ones
    that turn out not to be DICOM at all, so it reads four bytes and stops. An
    unreadable path is not DICOM rather than an error: this is the question that
    decides whether a file is a candidate, and a permission problem on one file
    must not end the walk over the rest of them."""
    try:
        with open(path, "rb") as fh:
            fh.seek(128)
            return fh.read(4) == b"DICM"
    except OSError:
        return False


def safe_within(root: str, path: str) -> bool:
    """True if *path* is *root* itself or lives inside it (realpath-based, so it
    also defeats ``..`` traversal and symlink escapes). Used to gate destructive
    actions to the configured storage folders only."""
    if not root or not path:
        return False
    try:
        root = os.path.realpath(root)
        path = os.path.realpath(path)
    except OSError:
        return False
    return path == root or path.startswith(root + os.sep)


def prune_empty_dirs(start_dir: str, stop_at: str) -> None:
    """Remove *start_dir* and its now-empty parents, walking up until (but not
    including) *stop_at*. Never removes a non-empty directory. This is what keeps
    the outgoing tree from filling up with empty Patient/Study/Series folders
    after their files are archived or deleted."""
    if not start_dir or not stop_at:
        return
    d = os.path.abspath(start_dir)
    stop = os.path.abspath(stop_at)
    while d != stop and d.startswith(stop + os.sep):
        try:
            os.rmdir(d)            # only succeeds if the directory is empty
        except OSError:
            break                  # not empty (or already gone) → stop climbing
        d = os.path.dirname(d)
