# Regenerating the manual's screenshots

The figures in `docs/manual/img/{en,es,pt-BR,ja,ru}/` are captured from a real
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
   patient, and it is published in every language at once.
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
least one destination that accepts and one that refuses, or the Stuck tab of
Studies has nothing in it.

    podman build --format docker -t carino-dicom:local .
    podman network create pacsdemo

    mkdir -p /tmp/pacsdemo/peer /tmp/pacsdemo/demo
    podman run -d --name pacs-peer --network pacsdemo \
      --userns keep-id:uid=1000,gid=1000 -v /tmp/pacsdemo/peer:/data:z \
      -e PACS_SERVICES=scp -e PACS_AUTH_TOKEN=peer-token \
      localhost/carino-dicom:local

    podman run -d --name pacs-demo --network pacsdemo \
      --userns keep-id:uid=1000,gid=1000 -v /tmp/pacsdemo/demo:/data:z \
      -p 127.0.0.1:18042:8042 -p 127.0.0.1:11512:11112 -p 127.0.0.1:12575:2575 \
      -e PACS_SERVICES=scp,scu,print,mwl,qr,ris,dicomweb \
      -e PACS_AUTH_TOKEN=manual-screenshots-token \
      localhost/carino-dicom:local

Those published ports are deliberately not the obvious ones. The suites take
DICOM ports in two arcs, a fresh number per test and never one twice:
`test_print.py` counts up from **11211**, and `tests/test_qr.py` counts up from
**11401**. A demo instance published inside either arc makes that suite fail
with `EADDRINUSE` — a failure that reads as a bug in the print SCP or the
query/retrieve SCP and is really a screenshot session nobody remembered was
still up. `11512` is clear of both with room for either arc to grow. Earlier
versions of this file published on `11412`, which is inside `test_qr.py`'s
range: if the query/retrieve tests start failing on a machine that has taken
screenshots, look for an old container before looking at the code.

## 2. Give the demo something worth photographing

Edit `/tmp/pacsdemo/demo/config.json` and restart the container. What the
figures need:

* **destinations** — `Main archive` and `Reading room` at `pacs-peer:11112`
  (these accept), and `Teaching archive` at `pacs-peer:11199` (nothing listens:
  it refuses at once, which is what fills the Stuck tab without waiting out a
  TCP timeout).
* **routing** — `"enabled": true` first: the engine ships off, and with it off
  every study fans out to every enabled destination exactly as it did before
  rules existed, no rule fires and nothing is ever held. Then a rule per shape
  the manual describes: MR to the reading room (`stop`), CT to the teaching
  archive with **de-identify** ticked, ultrasound to the reading room, CR to the
  teaching archive.

  A rule's destination list is keyed **`destinations`** — that spelling, plural
  (`pacs/routing.py`, and the worked rule in `config.example.json`). Nothing
  rejects another one: config validation checks the shape of the key it knows
  and ignores keys it does not, so `"destination"` or `"dests"` loads clean, and
  the rule then matches with an empty destination list. The engine reads that as
  a *filter* and drops through to the next rule, and finally to the
  all-destinations fallback. The demo comes up looking nearly right — studies
  arrive, the Routing tab lists the rules, every rule reads as configured — and
  the Stuck tab is empty because nothing was ever routed anywhere in particular,
  not because the hold below is working. Check the key before you check anything
  else; it cost a debugging session. A misspelled key inside `match` does not do
  this: the trace names it and skips the rule.
* **`deid.profile: "off"`** while that CT rule still asks for a scrub. This is
  what produces the *held, nothing is being sent* half of the Stuck tab — the
  case the manual spends a warning box on, and the one worth a picture. It is
  the easiest state to arrange in which a held row is drawn at all, not the only
  one: the engine records two causes for a hold — this one (`profile-off`) and a
  profile that is on with no de-identifier buildable from the de-identification
  settings (`no-deidentifier`) — and the row template carries the same two jump
  buttons either way, to the Settings tab and the Routing tab, the two places the
  hold is released. This cause is one config key; the other takes a broken
  de-identifier to arrange. The manual now tells the reader to use those buttons,
  so without this combination the `stuck` figure does not show the repair its own
  paragraph describes.
* **`scu.on_success: "move"`**, so the archive pass runs and sweeps the PDF and
  the JPEG into the Pending tab. With `keep` it never runs and Pending stays
  empty.

## 3. Traffic

    .venv/bin/python docs/manual/tools/forge-studies.py /tmp/pacsdemo/forged
    .venv/bin/python docs/manual/tools/seed-traffic.py /tmp/pacsdemo/forged 11512 12575

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

    # a study folder with them beside it -> the Pending tab
    mkdir -p /tmp/pacsdemo/demo/outgoing/MR-BRAIN-DEMO-0004
    cp /tmp/pacsdemo/forged/DEMO-0004_*.dcm \
       /tmp/pacsdemo/referral.pdf /tmp/pacsdemo/outside-film.jpg \
       /tmp/pacsdemo/demo/outgoing/MR-BRAIN-DEMO-0004/

    # and the two studies the Stuck figure is of
    mkdir -p /tmp/pacsdemo/demo/outgoing/CT-CHEST-DEMO-0001 \
             /tmp/pacsdemo/demo/outgoing/CR-CHEST-DEMO-0003
    cp /tmp/pacsdemo/forged/DEMO-0001_*.dcm /tmp/pacsdemo/demo/outgoing/CT-CHEST-DEMO-0001/
    cp /tmp/pacsdemo/forged/DEMO-0003_*.dcm /tmp/pacsdemo/demo/outgoing/CR-CHEST-DEMO-0003/

**Only the outgoing folder is routed.** A study that merely arrived over
C-STORE sits in `received`, where no rule ever sees it — so seeding traffic and
staging the MR study is not enough to fill the Stuck tab. The MR study matches a
rule that sends it to the reading room, which accepts, and it forwards cleanly.
That leaves *Nothing stuck — every forward is up to date* on screen, which looks
like a healthy appliance rather than like a figure that failed, and it is
published in every language at once.

The two studies above are each half of the figure: the **CT** matches the rule
that asks to de-identify while `deid.profile` is `off`, so its destinations are
held; the **CR** is routed to the teaching archive on a port nothing listens on,
so it fails and retries with backoff. Check both arrived before capturing —
`curl -s -H "Authorization: Bearer $TOKEN" .../api/stuck` should carry a
non-empty `held` **and** a non-empty `destinations`.

Send the studies **after** the last restart. The Overview's *received* and
*sent* tiles count from when the service last started, so a restart after this
step photographs two zeroes and a machine that looks idle. A config save does
the same to *received* on its own — the receiver is rebuilt by a save and its
counter starts again, while the watcher's *sent* survives — so make any
last-minute edit in the dashboard before this step, not after.

## 4. Capture

`capture.mjs` needs no npm install — it drives Chromium over CDP with node's own
`WebSocket`. One run per language per mode:

    for L in en es pt-BR ja ru; do
      node docs/manual/tools/capture.mjs $L /tmp/pacsdemo/shots/$L \
        http://127.0.0.1:18042/ manual-screenshots-token panels
    done

The sidebar is six rows, and most figures are a tab inside one of them, so each
capture clicks the nav row and then the tab — `stuck` is Studies then Stuck,
`routing` is Configuration then Routing. Capture signs in with the API token,
which is an administrator and therefore sees every tab; a run signed in as one
of the seeded profiles would find some of the strip missing, because a tab a
profile's capabilities do not pay for is not drawn at all, and those figures
come out as `! name: tab hidden for this profile` lines — or `! name: nav row
hidden for this profile`, when the whole row is gone — rather than files. Read
the run's output either way: `panels` mode prints the dashboard names and then
`editor` and `editor-tags`, and every `!` line in place of one of them is a
figure that will be missing from every manual.

**`gate` and `first-run`** come from an instance that has never been set up: the
container entrypoint marks setup done on first boot, so bring up a third one,
blank `setup_completed` in its `config.json`, turn every service off, restart,
and capture it in `setup` mode.

**`people` and `gate-people`** come from an instance that *has* profiles, which
is a one-way door — do them last, on the demo instance, in `people` mode. That
mode opens Configuration and selects its People tab, which is where People lives
now; the tab is there before the profiles are, but it holds the *Turn on
profiles* invitation rather than the table the figure is of. Seed the four
presets first — but not with the dashboard's own *Turn on profiles* button.
Nothing refuses that button: it writes the four presets with no passwords at all
and signs the browser that pressed it in as the administrator it just made, so a
container reachable by anything but loopback ends up with an open Administrator
that any visitor picks out of the sign-in list in one click. Create the four
through the API with passwords instead (`POST /api/profiles/save`, one call each
— a body with no `id` creates a profile. It needs an `X-Carino` header as well
as the token: that header is the CSRF guard, and every POST wants it).

## 5. Convert and place

1920px wide is a little over 2× the manual's 820px column, which is what keeps
the small monospace values legible when a reader zooms in. The two gate figures
are a card on an empty page, so they are cropped instead of scaled.

    for L in en es pt-BR ja ru; do
      for f in /tmp/pacsdemo/shots/$L/*.png; do
        magick "$f" -resize 1920x -quality 80 -define webp:method=6 \
          "docs/manual/img/$L/$(basename "${f%.png}").webp"
      done
      magick /tmp/pacsdemo/shots/$L/gate.png -gravity center \
        -crop 1150x950+0+0 +repage -quality 82 "docs/manual/img/$L/gate.webp"
      magick /tmp/pacsdemo/shots/$L/gate-people.png -gravity center \
        -crop 1200x1080+0+0 +repage -quality 82 "docs/manual/img/$L/gate-people.webp"
    done

Keep the file names: they are what the manuals reference, and the
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

An empty array is the pass. Every manual carries the same figures at the same
anchors — if one language gains or loses one, that is a divergence, not a
translation.
