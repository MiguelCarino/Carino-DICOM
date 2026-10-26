"""Generate Carino DICOM's desktop icons -- window, tray, Linux, macOS and Windows
packaging -- from logo.svg, the fleet mark that sits beside this script.

This script no longer draws the mark. It used to, analytically and with the
standard library alone, when the mark was a ring and a blocky letter: both are
a handful of signed distances. The fleet mark is now the hub's C with a
pictogram of the job inside it (Branding/marks/marks.py, stem "dicom"), and
pictograms are curves and round-capped strokes -- drawing those here would mean
re-implementing an SVG renderer. So logo.svg is the source, rasterised with
rsvg-convert (librsvg2-tools on Fedora, librsvg2-bin on Debian), and the
Branding repo's deploy.py is what puts a new logo.svg here.

The .icns and .ico containers are still written by hand below: both are just
PNGs in a wrapper, and ImageMagick's `magick x.png out.icns` writes a bare PNG
under an .icns name, which loads nowhere and fails silently.

The web favicons (docs/favicon.webp, docs/logo.webp and pacs/web/{logo,favicon}.webp) are deployed from Branding/marks/dicom.webp, not
written from here.

Run:  python3 make_icon.py
"""
import os
import shutil
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SVG = os.path.join(HERE, "logo.svg")


def png_bytes(size):
    if not shutil.which("rsvg-convert"):
        sys.exit("make_icon.py needs rsvg-convert (librsvg2-tools / librsvg2-bin)")
    return subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), SVG],
                          check=True, capture_output=True).stdout


def write_png(path, size):
    with open(path, "wb") as f:
        f.write(png_bytes(size))
    print("wrote", path, f"{size}x{size}")


# --- the platform bundles ------------------------------------------------
# Both formats are containers around PNGs, which is what the previously shipped
# icon.icns and icon.ico turned out to hold, so they are written here rather
# than shelled out to a tool that has to be installed first. ImageMagick is not
# an option for the mac one: `magick x.png out.icns` writes a bare PNG under an
# .icns name, which loads nowhere and fails silently.

ICNS_TYPES = [(b"ic11", 32), (b"ic12", 64), (b"ic07", 128), (b"ic08", 256),
              (b"ic13", 256), (b"ic09", 512), (b"ic14", 512), (b"ic10", 1024)]


def write_icns(path, cache=None):
    cache = {} if cache is None else cache
    body = b""
    for typ, size in ICNS_TYPES:
        if size not in cache:
            cache[size] = png_bytes(size)
        body += typ + struct.pack(">I", len(cache[size]) + 8) + cache[size]
    with open(path, "wb") as f:
        f.write(b"icns" + struct.pack(">I", len(body) + 8) + body)
    print("wrote", path, f"{len(ICNS_TYPES)} members")


ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def write_ico(path, cache=None):
    cache = {} if cache is None else cache
    pngs = []
    for size in ICO_SIZES:
        if size not in cache:
            cache[size] = png_bytes(size)
        pngs.append(cache[size])
    offset = 6 + 16 * len(pngs)
    head = struct.pack("<HHH", 0, 1, len(pngs))
    for size, data in zip(ICO_SIZES, pngs):
        dim = 0 if size >= 256 else size               # 0 means 256 in an ICO
        head += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    with open(path, "wb") as f:
        f.write(head + b"".join(pngs))
    print("wrote", path, f"{len(pngs)} sizes")


if __name__ == "__main__":
    here = HERE
    write_png(os.path.join(here, "tray.png"), 32)    # tray icon (runtime)
    write_png(os.path.join(here, "icon.png"), 512)   # window icon (runtime)
    write_png(os.path.join(here, "logo50.png"), 50)  # 50x50, the favicon size
    # Size set for Linux packaging (electron-builder linux.icon = this dir).
    build = os.path.join(here, "..", "build")
    icons = os.path.join(build, "icons")
    os.makedirs(icons, exist_ok=True)
    shared = {}
    for sz in (16, 24, 32, 48, 64, 128, 256, 512):
        shared[sz] = png_bytes(sz)
        with open(os.path.join(icons, "%dx%d.png" % (sz, sz)), "wb") as f:
            f.write(shared[sz])
        print("wrote", os.path.join(icons, "%dx%d.png" % (sz, sz)), f"{sz}x{sz}")
    write_icns(os.path.join(build, "icon.icns"), shared)
    write_ico(os.path.join(build, "icon.ico"), shared)
