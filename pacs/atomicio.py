"""Crash-safe file writes shared by every store that keeps state on disk.

One rule, written once: a file other code reads is never rewritten in place.
The new bytes go to a unique scratch file in the SAME directory (so the rename
cannot cross a filesystem), are flushed and fsynced, and are then renamed over
the final name with os.replace — atomic for readers on POSIX and Windows — and
the directory is fsynced so the rename itself survives a power cut.

Consequences callers rely on:

* a reader sees the whole old file or the whole new one, never a truncated mix;
* a write that fails (ENOSPC, EFBIG, an unencodable element, a crash) leaves
  the previous file untouched and no partial file at the final name;
* the scratch file is dot-prefixed (``.tmp.<name>.<random>``) so the watcher,
  the rescan and the study browser — which all skip dot-files — never pick up a
  half-written one.
"""

from __future__ import annotations

import contextlib
import os
import secrets
import threading
import time
from typing import Callable, Iterator

TMP_PREFIX = ".tmp."

# Windows refuses a rename over a file somebody holds open; that condition is
# transient (a scanner, a reader), so it is waited out briefly. Zero on POSIX.
_REPLACE_RETRY_SEC = 0.5 if os.name == "nt" else 0.0


def fsync_dir(directory: str) -> None:
    """fsync a directory so a rename or create in it is durable. Best effort:
    Windows cannot open a directory and some filesystems refuse the call."""
    try:
        fd = os.open(directory or ".", getattr(os, "O_DIRECTORY", 0) | os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def replace(src: str, dst: str) -> None:
    """os.replace, retried briefly while Windows reports the target busy."""
    deadline = time.monotonic() + _REPLACE_RETRY_SEC
    while True:
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.01)


def _open_temp(directory: str, base: str, mode: int) -> tuple[int, str]:
    for _ in range(8):
        tmp = os.path.join(directory, f"{TMP_PREFIX}{base}.{secrets.token_hex(6)}")
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                         | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0), mode)
            return fd, tmp
        except FileExistsError:
            continue
    raise OSError(f"could not create a temporary file in {directory}")


def atomic_write(path: str, write: Callable, *, mode: int = 0o666,
                 fsync: bool = True, binary: bool = True) -> None:
    """Write *path* crash-safely. ``write(fh)`` fills an open file object.

    *mode* is passed to os.open, so the umask still applies (0o666 gives the
    ordinary 0644 a plain open() would; pass 0o600 for anything private). An
    exception from *write* or from the rename leaves no scratch file behind and
    the previous *path* exactly as it was.
    """
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = _open_temp(directory, os.path.basename(path), mode)
    try:
        if binary:
            fh = os.fdopen(fd, "wb")
        else:
            fh = os.fdopen(fd, "w", encoding="utf-8", newline="")
        with fh:
            write(fh)
            fh.flush()
            if fsync:
                os.fsync(fh.fileno())
        replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    if fsync:
        fsync_dir(directory)


def atomic_write_text(path: str, text: str, *, mode: int = 0o600, fsync: bool = True) -> None:
    atomic_write(path, lambda fh: fh.write(text), mode=mode, fsync=fsync, binary=False)


def atomic_write_bytes(path: str, data: bytes, *, mode: int = 0o666, fsync: bool = True) -> None:
    atomic_write(path, lambda fh: fh.write(data), mode=mode, fsync=fsync, binary=True)


def atomic_copy(src: str, dst: str, *, fsync: bool = True) -> None:
    """Copy *src* to *dst* through a scratch file + rename, keeping src's mtime
    (as shutil.copy2 does) so size+mtime identity checks treat the copy as the
    same bytes."""
    import shutil
    st = os.stat(src)

    def _w(fh):
        with open(src, "rb") as s:
            shutil.copyfileobj(s, fh, 1024 * 1024)
    directory = os.path.dirname(os.path.abspath(dst))
    fd, tmp = _open_temp(directory, os.path.basename(dst), 0o666)
    try:
        with os.fdopen(fd, "wb") as fh:
            _w(fh)
            fh.flush()
            if fsync:
                os.fsync(fh.fileno())
        try:
            os.utime(tmp, ns=(st.st_atime_ns, st.st_mtime_ns))
        except OSError:
            pass
        replace(tmp, dst)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    if fsync:
        fsync_dir(directory)


def is_temp_name(name: str) -> bool:
    return os.path.basename(name).startswith(TMP_PREFIX)


# ---- per-path serialisation --------------------------------------------------
_locks_guard = threading.Lock()
_locks: dict[str, list] = {}       # path -> [Lock, refcount]


@contextlib.contextmanager
def path_lock(path: str) -> Iterator[None]:
    """Serialise writers of one destination path inside this process. Entries
    are reference-counted so the table never grows past the number of paths
    being written at this instant."""
    key = os.path.abspath(path)
    with _locks_guard:
        slot = _locks.get(key)
        if slot is None:
            slot = _locks[key] = [threading.Lock(), 0]
        slot[1] += 1
    slot[0].acquire()
    try:
        yield
    finally:
        slot[0].release()
        with _locks_guard:
            slot[1] -= 1
            if slot[1] <= 0 and _locks.get(key) is slot:
                del _locks[key]
