"""Small filesystem helpers shared by the watcher and the history/browse code."""

from __future__ import annotations

import hashlib
import inspect
import os
import struct
from typing import Iterator, Optional

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


# os.pread exists on Unix only. Resolved once at import rather than per call:
# is_dicom() runs tens of thousands of times per browse walk.
_HAS_PREAD = hasattr(os, "pread")


ZERO_PREAMBLE = b"\x00" * 128


def clear_preamble(ds) -> bool:
    """Blank the 128-byte preamble of *ds*. True when there was content to clear.

    PS3.10 7.1 leaves the preamble to the application, so nothing stops it from
    holding something else, and the best-known use is hostile: a Windows
    executable header there turns one file into a valid DICOM object and a
    runnable program at once (CVE-2019-11687). Nothing this appliance does
    reads a preamble, so every file it writes gets the zeros PS3.10 recommends.
    pydicom writes zeros for ``None`` when it produces a full Part 10 file."""
    pre = getattr(ds, "preamble", None)
    if pre is None:
        return False
    ds.preamble = None
    return bytes(pre) != ZERO_PREAMBLE


def _body_offset(head: bytes) -> Optional[int]:
    """Where the data set starts in a Part 10 file whose first 144 bytes are
    *head*, worked out from the File Meta group length. None when the head is
    not shaped like the files this package writes."""
    if len(head) < 144 or head[128:132] != b"DICM":
        return None
    if head[132:138] != b"\x02\x00\x00\x00UL" or head[138:140] != b"\x04\x00":
        return None
    return 144 + struct.unpack("<I", head[140:144])[0]


def file_body_digest(path: str) -> Optional[str]:
    """SHA-256 of the data set in a Part 10 file, read in chunks, leaving out the
    preamble and the File Meta group. The meta group names the sending AE and
    the implementation that wrote the file, so two copies of one object that
    arrived from different senders differ there and nowhere else. None when the
    file cannot be read or is not shaped like a Part 10 file."""
    try:
        with open(path, "rb") as fh:
            start = _body_offset(fh.read(144))
            if start is None:
                return None
            fh.seek(start)
            h = hashlib.sha256()
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                h.update(chunk)
            return h.hexdigest()
    except OSError:
        return None


def servable_chunks(path: str, chunk: int = 1024 * 1024) -> Iterator[bytes]:
    """Yield the bytes of *path* for a download, with the preamble zeroed.

    Files written here already have a zero preamble. Files in the outgoing and
    sent folders were put there by somebody else, as were files stored before
    this was in place. A download hands a file to a workstation, so the one
    part of the file that can make it executable is blanked on the way out."""
    with open(path, "rb") as fh:
        head = fh.read(132)
        if len(head) == 132 and head[128:132] == b"DICM" and head[:128] != ZERO_PREAMBLE:
            head = ZERO_PREAMBLE + head[128:]
        yield head
        for block in iter(lambda: fh.read(chunk), b""):
            yield block


def save_dicom(ds, path, fsync: bool = True) -> None:
    """Write *ds* as a complete Part 10 file, whatever pydicom version is installed.

    Never in place: the bytes go to a dot-prefixed scratch file in the same
    directory, are fsynced, and are renamed over *path* (see atomicio). A write
    that fails part-way — an element that cannot be encoded, a full disk, a
    crash — therefore leaves the previous copy of the instance intact and no
    truncated .dcm at the final name, and two writers of the same path are
    serialised so the last complete object wins whole. The preamble is always
    written as zeros (see :func:`clear_preamble`)."""
    from .atomicio import atomic_write, path_lock
    clear_preamble(ds)
    with path_lock(path):
        atomic_write(path, lambda fh: ds.save_as(fh, **SAVE_KWARGS), fsync=fsync)


def is_dicom(path: str) -> bool:
    """True if the file has the DICM magic at offset 128 (extension-agnostic).

    Asked of every file the watcher and the browse walk meet, including the ones
    that turn out not to be DICOM at all, so it reads four bytes and stops. An
    unreadable path is not DICOM rather than an error: this is the question that
    decides whether a file is a candidate, and a permission problem on one file
    must not end the walk over the rest of them.

    Read off a raw descriptor rather than through open(): this is the busiest
    call in the product — the study browser asks it of every file under the
    storage root on every page load, the rescan asks it of every candidate, and
    the watcher asks it of every file in the outgoing folder every three seconds
    — and a buffered reader allocates an 8 KB buffer and pulls a whole block
    through it to hand back four bytes. Measured over 14,400 files, alternating
    the two implementations in one process so both see the same page cache:
    282 ms -> 231 ms median, and the browse walk 612 ms -> 561 ms.

    os.pread is Unix-only, so Windows keeps the original spelling. Both branches
    answer the same question; only the syscall count differs."""
    if _HAS_PREAD:
        try:
            fd = os.open(path, os.O_RDONLY)
        except OSError:
            return False
        try:
            return os.pread(fd, 4, 128) == b"DICM"
        except OSError:
            return False
        finally:
            os.close(fd)
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


def within_roots(path: str, roots: list[str]) -> bool:
    """True if *path* lives inside any of *roots*. The containment question on
    its own, separate from whether the file is there.

    The index is a cache, not an authority. Every retrieval answers from a row
    it holds, and a row that is stale or poisoned still names a path this
    process has the rights to open — so containment has to be asked again at
    the moment of reading, by whoever is about to read.

    It lives here, taking the roots rather than working them out, because there
    are two retrieval paths and they must not each own a copy. DICOMweb asked
    this question and DIMSE Query/Retrieve did not, so C-MOVE and C-GET read
    whatever path a row named while WADO refused the very same row. One
    definition, and that difference cannot come back.

    Empty roots deny everything, which is what a caller that was never told
    which folders are its own should be able to serve.
    """
    if not path:
        return False
    return any(safe_within(r, path) for r in roots)


def servable(path: str, roots: list[str]) -> bool:
    """``within_roots`` and the file is actually there.

    For a caller that has to tell a requester "no" in one move. A caller that
    reports a missing file differently from a refused one — the Q/R SCP names
    both in its log and only one of them is a configuration fault — wants
    ``within_roots`` and its own open() instead, so that the two answers do not
    arrive under the same sentence.
    """
    return within_roots(path, roots) and os.path.isfile(path)


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
