"""Generate the Carino mark — the tray, app and packaging icons — with the
standard library only (no Pillow), so a build machine needs nothing installed.

The mark is a bold C: a ring of 90-degree mouth, cut radially at both terminals,
in Carino gold on transparency. It is drawn from the constants below rather than
traced from a bitmap, so any size can be regenerated exactly. The same numbers
produce Branding/logo-candidates/f_plain.svg.

Why a C and not the old aperture: this file used to draw a concentric
aperture/clock glyph while the web favicon shipped a hand-drawn face, so the
product had two unrelated marks. It now has one, and it is the same one the
browser tab shows.

Run:  python3 make_icon.py
"""
import math
import os
import struct
import zlib

GOLD = (0xEA, 0xB3, 0x08)

# --- the mark ------------------------------------------------------------
# Drawn in a 100x100 space, then fitted to the canvas with equal padding.
CX = CY = 50.0      # centre of the ring
R = 34.0            # arc centreline radius
W = 16.0            # stroke width  -> outer 42, inner 26
GAP = 44.0          # half the mouth, in degrees, opening to the right
PAD = 7.0           # clear space around the mark, in the same 100 units


def _fit():
    """Optical centring. The C's rightmost ink is the outer corner of a
    terminal, not the full width of the ring, so the raw drawing sits left of
    centre. Fit its real bounding box instead of the circle's."""
    ro = R + W / 2
    left, top, bottom = CX - ro, CY - ro, CY + ro
    right = CX + ro * math.cos(math.radians(GAP))
    w, h = right - left, bottom - top
    s = (100 - 2 * PAD) / max(w, h)
    tx = PAD + (100 - 2 * PAD - w * s) / 2 - left * s
    ty = PAD + (100 - 2 * PAD - h * s) / 2 - top * s
    return CX * s + tx, CY * s + ty, R * s, W * s


MX, MY, MR, MW = _fit()


def _coverage(u, v, px):
    """How much of the pixel at (u, v) the mark covers, 0..1.

    Analytic rather than supersampled: the shape is the intersection of an
    annulus and everything outside the mouth wedge, and the signed distance to
    each is cheap. Taking the larger of the two gives the distance to the
    shape, and a one-pixel ramp across it is the anti-aliasing.
    """
    dx, dy = u - MX, v - MY
    d = math.hypot(dx, dy)
    if d < 1e-9:
        return 0.0
    ring = abs(d - MR) - MW / 2                       # <0 inside the stroke
    ang = abs(math.degrees(math.atan2(-dy, dx)))      # 0 at the mouth's centre
    wedge = d * math.sin(math.radians(GAP - ang))     # <0 outside the mouth
    sd = max(ring, wedge)
    return min(1.0, max(0.0, 0.5 - sd / px))


def png_bytes(size):
    px = 100.0 / size                                  # one pixel, in mark units
    raw = bytearray()
    for y in range(size):
        raw.append(0)                                  # filter type 0
        v = (y + 0.5) * px
        for x in range(size):
            a = _coverage((x + 0.5) * px, v, px)
            raw += bytes(GOLD + (int(round(255 * a)),)) if a else b"\0\0\0\0"

    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data
                + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))


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


def write_svg(path):
    """The vector source, from the same constants — for anything that wants the
    mark at a size this script was not run at."""
    def pt(deg):
        return (MX + MR * math.cos(math.radians(deg)),
                MY - MR * math.sin(math.radians(deg)))
    x1, y1 = pt(GAP)
    x2, y2 = pt(-GAP)
    colour = "#%02x%02x%02x" % GOLD
    with open(path, "w", encoding="utf-8") as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" '
                'width="512" height="512" role="img" aria-label="Carino">'
                f'<path d="M {x1:.2f} {y1:.2f} A {MR:.2f} {MR:.2f} 0 1 0 {x2:.2f} {y2:.2f}" '
                f'fill="none" stroke="{colour}" stroke-width="{MW:.2f}" '
                'stroke-linecap="butt"/></svg>')
    print("wrote", path)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    write_svg(os.path.join(here, "logo.svg"))
    write_png(os.path.join(here, "tray.png"), 32)    # tray icon (runtime)
    write_png(os.path.join(here, "icon.png"), 512)   # window icon (runtime)
    write_png(os.path.join(here, "logo50.png"), 50)  # source for the web webp
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
    print()
    print("The one step this script cannot do, because it needs ImageMagick:")
    print("  the web favicons — pacs/web/logo.webp, pacs/web/editor/logo.webp")
    print("  and docs/favicon.webp are the same file --")
    print("      magick assets/logo50.png -define webp:lossless=true logo.webp")
