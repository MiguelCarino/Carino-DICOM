# Regenerating the manual's screenshots

The seventeen figures in `docs/manual/img/{en,es,pt-BR}/` are captured from a real
instance of this software, with studies invented for the picture. This directory
is how they were made, and how to make them again when the dashboard changes —
because a manual whose screenshots are a release behind is a manual that teaches
the wrong thing, and by the time anybody notices, nobody remembers how the
originals were produced.

Two rules the whole procedure exists to keep:

1. **No patient, ever.** Every study, order, name and identifier below is forged
   by `forge-studies.py` in the test UID arc. Never point this at an instance
   that has seen clinical data — not to "just grab one panel", not with the PHI
   toggles off. A screenshot is the easiest place in a project to publish a
   patient, and it is published in three languages at once.
2. **Nothing about the machine that took them.** The demo runs in containers, so
   the paths in the pictures are `/data/...` and the address is the container's
   own — not somebody's home directory and not their LAN address. That is the
   whole reason for the container step; a host run is otherwise identical and
   leaks both.

## What you need

`podman` (or `docker`, with the obvious substitutions), a `chromium-browser`
binary, node 22 or newer for the built-in `WebSocket`, ImageMagick for the
conversion, and this repository's virtualenv for the two Python scripts.

## 1. Build the image and bring up two instances

The peer exists so that forwarding has somewhere to succeed; the demo needs at
least one destination that accepts and one that refuses, or the Stuck panel has
nothing in it.

    podman build --format docker -t carino-pacs:local .
    podman network create pacsdemo

    mkdir -p /tmp/pacsdemo/peer /tmp/pacsdemo/demo
    podman run -d --name pacs-peer --network pacsdemo \
      --userns keep-id:uid=1000,gid=1000 -v /tmp/pacsdemo/peer:/data:z \
      -e PACS_SERVICES=scp -e PACS_AUTH_TOKEN=peer-token \
      localhost/carino-pacs:local

    podman run -d --name pacs-demo --network pacsdemo \
      --userns keep-id:uid=1000,gid=1000 -v /tmp/pacsdemo/demo:/data:z \
      -p 127.0.0.1:18042:8042 -p 127.0.0.1:11412:11112 -p 127.0.0.1:12575:2575 \
      -e PACS_SERVICES=scp,scu,print,mwl,qr,ris,dicomweb \
      -e PACS_AUTH_TOKEN=manual-screenshots-token \
      localhost/carino-pacs:local

Those published ports are deliberately not the obvious ones. `tests/` allocates
DICOM ports from **11211** upward, so a demo instance published on `11212` makes
`test_print.py` fail with `EADDRINUSE` — a failure that looks like a bug in the
print SCP and is really a screenshot session nobody remembered was still up.

## 2. Give the demo something worth photographing

Edit `/tmp/pacsdemo/demo/config.json` and restart the container. What the
figures need:

* **destinations** — `Main archive` and `Reading room` at `pacs-peer:11112`
  (these accept), and `Teaching archive` at `pacs-peer:11199` (nothing listens:
  it refuses at once, which is what fills the Stuck panel without waiting out a
  TCP timeout).
* **routing** — a rule per shape the manual describes: MR to the reading room
  (`stop`), CT to the teaching archive with **de-identify** ticked, ultrasound
  to the reading room, CR to the teaching archive.
* **`deid.profile: "off"`** while that CT rule still asks for a scrub. This is
  what produces the *held, nothing is being sent* half of the Stuck panel — the
  case the manual spends a warning box on, and the one worth a picture.
* **`scu.on_success: "move"`**, so the archive pass runs and sweeps the PDF and
  the JPEG into Pending review. With `keep` it never runs and Pending stays
  empty.

## 3. Traffic

    .venv/bin/python docs/manual/tools/forge-studies.py /tmp/pacsdemo/forged
    .venv/bin/python docs/manual/tools/seed-traffic.py /tmp/pacsdemo/forged 11412 12575

    # two invented attachments — a referral note and a scanned film
    magick -size 900x1200 xc:white -fill black -pointsize 34 \
      -annotate +60+120 "EXAMPLE IMAGING CENTRE" -pointsize 24 \
      -annotate +60+180 "Referral note (demo document)" \
      -annotate +60+260 "Patient: PHANTOM, DELTA    ID: DEMO-0004" \
      -annotate +60+300 "Accession: A2400120" \
      -annotate +60+420 "This page is invented for a screenshot in the manual." \
      /tmp/pacsdemo/referral.pdf
    magick -size 1024x768 gradient:'#222'-'#888' -fill white -pointsize 40 \
      -annotate +60+120 "OUTSIDE STUDY (demo)" \
      -annotate +60+180 "scanned film, not DICOM" /tmp/pacsdemo/outside-film.jpg

    # a study folder with them beside it -> Pending review
    mkdir -p /tmp/pacsdemo/demo/outgoing/MR-BRAIN-DEMO-0004
    cp /tmp/pacsdemo/forged/DEMO-0004_*.dcm \
       /tmp/pacsdemo/referral.pdf /tmp/pacsdemo/outside-film.jpg \
       /tmp/pacsdemo/demo/outgoing/MR-BRAIN-DEMO-0004/

Send the studies **after** the last restart. The Overview's *received* and
*sent* tiles count from when the service last started, so a restart after this
step photographs two zeroes and a machine that looks idle.

## 4. Capture

`capture.mjs` needs no npm install — it drives Chromium over CDP with node's own
`WebSocket`. One run per language per mode:

    for L in en es pt-BR; do
      node docs/manual/tools/capture.mjs $L /tmp/pacsdemo/shots/$L \
        http://127.0.0.1:18042/ manual-screenshots-token panels
    done

**`gate` and `first-run`** come from an instance that has never been set up: the
container entrypoint marks setup done on first boot, so bring up a third one,
blank `setup_completed` in its `config.json`, turn every service off, restart,
and capture it in `setup` mode.

**`people` and `gate-people`** come from an instance that *has* profiles, which
is a one-way door — do them last, on the demo instance, in `people` mode. Seed
the four presets first. The dashboard's own *Turn on profiles* button refuses
here, and correctly: it would create a passwordless administrator on a container
that publishes on `0.0.0.0`. Create them through the API with passwords instead
(`POST /api/profiles/save`, which needs an `X-Carino` header as well as the
token — that header is the CSRF guard, and every POST wants it).

## 5. Convert and place

1920px wide is a little over 2× the manual's 820px column, which is what keeps
the small monospace values legible when a reader zooms in. The two gate figures
are a card on an empty page, so they are cropped instead of scaled.

    for L in en es pt-BR; do
      for f in /tmp/pacsdemo/shots/$L/*.png; do
        magick "$f" -resize 1920x -quality 80 -define webp:method=6 \
          "docs/manual/img/$L/$(basename "${f%.png}").webp"
      done
      magick /tmp/pacsdemo/shots/$L/gate.png -gravity center \
        -crop 1150x950+0+0 +repage -quality 82 "docs/manual/img/$L/gate.webp"
      magick /tmp/pacsdemo/shots/$L/gate-people.png -gravity center \
        -crop 1200x1080+0+0 +repage -quality 82 "docs/manual/img/$L/gate-people.webp"
    done

Keep the file names: they are what the three manuals reference, and the
`width`/`height` on each `<img>` matches the sizes above. If a crop changes,
change the attributes with it — they are there so a figure does not shove the
paragraph somebody is reading down the page while it loads.

## 6. Tear down

    podman rm -f pacs-demo pacs-peer pacs-setup
    podman network rm pacsdemo
    rm -rf /tmp/pacsdemo

## Checking the result

Serve `docs/` and load each manual. Every figure is `loading="lazy"`, so scroll
the whole page before believing it:

    [...document.querySelectorAll('.shot img')]
      .filter(i => !i.complete || i.naturalWidth === 0)
      .map(i => i.getAttribute('src'))

An empty array is the pass. The three manuals carry the same seventeen figures
at the same anchors — if one language gains or loses one, that is a divergence,
not a translation.
