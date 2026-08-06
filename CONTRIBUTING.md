# Contributing to Carino PACS

Thanks for looking. This is a single-maintainer project (Miguel Carino) of about
13,000 lines of Python (plus roughly 9,000 more of tests), a vanilla-JS
dashboard with no build step, and an Electron tray app. The
scarcest resource here is review time, so this document tries to front-load
everything that would otherwise come back as review comments.

Read [the safety rule](#the-rule-that-outranks-everything) even if you read
nothing else.

---

## What this is, and what it is not

Carino PACS is a **DICOM gateway and continuity appliance**. It receives studies,
forwards them, captures print-only modalities, serves a worklist, takes HL7
orders, and keeps a department imaging when the upstream PACS or RIS is down. It
is meant to run on one machine in one department, configured by one JSON file, by
someone who is a technologist or an IT generalist rather than a PACS engineer.

It is deliberately **not**:

- **Not an enterprise PACS.** No user accounts, no roles, no HL7 v2 conformance
  suite, no DICOM SR reporting, no long-term archive tiering, no clustering. If
  you need those, you want Orthanc, dcm4chee or a commercial vendor, and that is
  a fine answer — say so in an issue and nobody will be offended.
- **Not a diagnostic viewer.** The bundled editor is a tag editor and
  de-identifier, not a reading workstation. Nothing here is calibrated for
  diagnosis.
- **Not a medical device.** It is not CE-marked, not FDA-cleared, not certified
  by anyone, and the licence disclaims warranty in the strongest terms the law
  allows. Do not submit changes premised on it being a regulated device, and do
  not add claims to the docs that imply it is one.
- **Not telemetric.** The software never phones home — no analytics, no crash
  reporting, no update pings, no usage counters, no remote logging. This is not
  an oversight to be fixed, it is a property to be preserved. A patch that adds
  an outbound network call to anything other than a DICOM node the operator
  configured, or the operator's own dashboard, will be rejected on sight. The
  same goes for a bundled asset fetched from a CDN at runtime: everything the
  dashboard needs is vendored in the repo.

Feature requests are welcome. Feature requests that turn this into a small
enterprise PACS are the ones most likely to be declined, and it will not be
personal.

---

## The rule that outranks everything

**This software moves medical images. An image that is silently not delivered is
worse than a crash.**

A crash is visible. A dropped study is discovered weeks later by a radiologist
who cannot find an exam that the technologist is certain they sent. Every design
decision in this codebase bends toward that asymmetry, and yours should too:

- **Failures retry and stay visible.** The folder watcher tracks delivery
  per-destination and only marks a file done once *every* currently-enabled
  destination has accepted it; failures are retried with exponential backoff
  capped at five minutes, and the state survives a restart via a JSON sidecar
  (`pacs/watcher.py`, `pacs/state.py`).
- **Nothing is deleted on a guess.** Matched RIS orders are closed and archived,
  never erased, so the reconciliation trail survives (`pacs/ris.py`). Studies are
  only deleted through helpers gated by `safe_within()` to the configured
  storage roots (`pacs/dicomfs.py`).
- **When routing cannot decide, it over-sends.** Every path through
  `Router.route()` that fails to produce a destination — routing off, no rule
  matched, unreadable header, a rule naming a destination that no longer exists —
  falls back to *every enabled destination*. Over-sending annoys an operator;
  under-sending loses an image (`pacs/routing.py`).
- **The one exception: a scrub that cannot happen holds the delivery.** When a
  rule asks to de-identify for a destination and the scrub cannot actually be
  performed, that destination is **held** — not sent to at all, rather than
  forwarded identified. It is the same asymmetry one level up: a study waiting in
  the outgoing folder is released by an edit, while identity that has arrived at
  an outside node is not recoverable by any edit. It is not a drop — nothing is
  archived or deleted, the other destinations still receive the study, and the
  log raises an error naming what is being withheld. `routing.Decision` is the
  only place the halves are put together; do not re-derive `deidentify` from the
  rules, from `deid.profile`, or from a de-identifier a caller happens to be
  holding, anywhere else (`pacs/routing.py`).
- **A hold has two causes and they are not interchangeable.**
  `HOLD_PROFILE_OFF` is `deid.profile == "off"` and comes out of
  `Router.route()`. `HOLD_NO_DEIDENTIFIER` is a profile that is on with no
  usable de-identifier behind it, and comes out of `Decision.honoured_by(deider)`
  — which is the only supported way to settle a route against the de-identifier
  a sender will actually use, and which every sender must call before sending.
  The outcome is the same and the remedy is not, so **anything that explains a
  hold to a human must branch on `Decision.hold_cause`** (carried into the send
  state by `record_route` and out through `/api/stuck`) and must never assert a
  cause it cannot see. Telling a site whose profile is already on to "turn the
  profile on" pushes the operator toward the one edit that forwards the study
  identified; that is a safety defect, not a wording nit. `Router._emit_warnings`
  is the worked example: it names `profile-off` only, because the sender's
  de-identifier is not visible from inside the router.
- **Refuse loudly rather than accept and lose.** When free disk falls below the
  configured floor, the Storage SCP rejects the C-STORE *before writing*, so the
  modality sees a failure status and can be retried — instead of writing a
  truncated file onto a full volume (`pacs/scp.py`).
- **Delivery is never gated on bookkeeping.** A study with no matching order is
  still stored and still forwarded; the order simply stays open for manual
  reconciliation. Identity matching is a convenience, never a gate.
- **The index is a cache, never the source of truth.** `pacs/index.py` holds
  nothing that cannot be re-derived by rescanning the files. Losing the database
  costs a rescan, never an image.

If your change introduces a path where a study can be dropped, swallowed or
silently skipped, it will not be merged, even if the code is otherwise better
than what it replaces. When in doubt, fail visibly and keep the bytes.

---

## Getting a dev environment up

You need **Python 3.10+** and, for the desktop app, **Node 18+**. Nothing is
compiled.

```bash
git clone https://github.com/MiguelCarino/Carino-PACS
cd Carino-PACS
./setup.sh                 # Windows: .\setup.ps1
./run.sh init              # creates ~/CarinoPACS/config.json and its folders
./run.sh serve             # dashboard at http://127.0.0.1:8042
```

`setup.sh` creates `.venv` and installs `requirements.txt`. `run.sh` is only a
wrapper that execs `.venv/bin/python -m pacs "$@"`, so anything below that says
`run.sh <cmd>` can equally be `python -m pacs <cmd>` in an activated venv.

### The trap: a copied `.venv` is broken

**A virtualenv is not portable.** Its `pyvenv.cfg` and its `bin/python` symlink
carry absolute paths. If you copy, move, rename or archive the repo directory —
or unpack it somewhere else on another machine — the `.venv` inside it will
still *look* fine and will still run, but it resolves to the wrong interpreter
and cannot see `pydicom`, `pynetdicom` or `flask`. The symptom is a
`ModuleNotFoundError: No module named 'pydicom'` from a Python that you can
clearly see has pydicom installed, and it wastes an afternoon every time.

The fix is always the same:

```bash
rm -rf .venv && ./setup.sh
```

Do this reflexively after any move or copy of the working tree. If in doubt,
`./.venv/bin/python -c "import pydicom, pynetdicom, flask"` is the one-line
check.

### `setup.sh` does not install PyInstaller

Freezing the engine for a packaged build needs PyInstaller, which is *not* in
`requirements.txt` and *not* installed by `setup.sh` — it is a build tool, not a
runtime dependency, and most contributors never need it. Install it into the
same venv when you need it:

```bash
./.venv/bin/pip install pyinstaller       # Windows: .\.venv\Scripts\pip install pyinstaller
```

And freeze **with that venv's Python**, not a system one. A freeze done with a
bare interpreter produces an engine that starts and then dies on the first
import. See `BUILDING.md` for the full packaging path.

### Desktop app (Electron tray + window)

```bash
cd desktop && npm install && npm start
```

In dev it drives the `.venv` you already created, so there is no build step.

### Resetting to a clean slate

`./reset.sh` deletes all runtime state — `~/CarinoPACS`, `.venv`,
`desktop/node_modules`, `desktop/dist`, `desktop/engine`, build artifacts and
stray Electron userData — and leaves source untouched. It prompts before doing
it; `-y` skips the prompt. Use it before reproducing an onboarding or first-run
bug, because a lot of those only reproduce on a truly fresh install.

---

## Where things live

Everything under `pacs/` is a plain module in one flat package. There is no
framework and no plugin system; the call graph is meant to be readable top to
bottom.

**`pacs/__main__.py`** — the CLI. Subcommands: `serve`, `receive`, `send`,
`print`, `ris`, `mwl`, `echo`, `init`, and the Query/Retrieve listener. Note the
argparse shape: `--config` / `-c` is a **global** option and must come *before*
the subcommand (`python -m pacs --config /path/config.json serve`, never
`serve --config …`). The `serve --receive/--watch/--print/--ris/--mwl` flags
start a service for that run only and deliberately never write the config's
`enabled` flags — enrolment belongs to the dashboard's setup chooser.

**`pacs/config.py`** — the whole app is configured by one JSON file, by default
`~/CarinoPACS/config.json`. Holds `DEFAULTS`, load/save, and validation. Relative
paths in the config resolve against the config file's own directory, so
`./received` means `~/CarinoPACS/received` regardless of the working directory.
`validate()` is also where the security gate lives (see below).

**`pacs/server.py`** — the orchestrator. Owns the shared `Config` and
`LogBuffer` and every worker, and exposes start/stop/status/apply_config. Both
the CLI and the web layer drive the app exclusively through this object; nothing
else should reach past it into a worker.

**`pacs/scp.py`** — Storage SCP. C-STORE and C-ECHO, every storage SOP class
with every transfer syntax pynetdicom knows, so compressed objects are stored
as received without transcoding. Owns the disk-space guard and the
Patient/Study/Series foldering.

**`pacs/scu.py`** — Storage SCU. C-STORE one file to a remote node, and C-ECHO.
Requests the instance's own transfer syntax; if a remote refuses it, the send
fails loudly rather than transcoding behind your back.

**`pacs/watcher.py`** — the auto-send daemon. Polls the outgoing folder (polling,
not inotify: identical on every OS and reliable on network shares), waits for a
file to be *stable* before sending so a half-written object is never forwarded,
tracks per-destination delivery, retries with backoff, and re-reads the live
config each pass so dashboard edits apply without a restart.

**`pacs/routing.py`** — pure decision layer: given a file's header and the rules,
which destinations does it go to, and should it be de-identified? Opens no
sockets, writes no files, mutates no config — which is exactly why it is the
easiest module in the tree to unit-test. It owns **every** half of the
de-identification question — the rules' `deidentify`, the global `deid.profile`,
and (through `Decision.honoured_by`) whether the sender has a de-identifier that
will actually rewrite anything — so a `Decision` is the single source of truth:
`destinations` is what the rules picked, `deid_dests` what will actually be
scrubbed, `held` what must not be dialled at all, `hold_cause` why, and
`sendable` what a sender walks. Read those; never re-derive them. A name only
ever leaves `deid_dests` by landing in `held`, which is what stops "narrow what
gets scrubbed" and "narrow what gets sent" from coming apart — the same defect
three rounds running before the type owned it.

**`pacs/deid.py`** — de-identification applied **on forward only**. The gateway
stores what it receives untouched; when a routing rule asks for it — the
`deid` section sets *how*, never *whether* — the copy that *leaves* is
de-identified and the archived original is never rewritten. That asymmetry is the module's whole point, which
is why the only entry point returns a new `Dataset`. Implements the PS3.15
Annex E Basic profile and declares the retain options it applied; generated
values come from HMAC-SHA256 over a site key, so the mapping is deterministic
with no lookup table to lose and re-sending a study is idempotent. It
deliberately does not claim Clean Pixel Data — burned-in demographics survive,
and only a human looking at the image can catch that. The action table is kept
in step with the bundled editor's `deid-profile.js` by a test that re-parses the
JS and fails on drift.

**`pacs/qr.py`** — Query/Retrieve SCP: C-FIND, C-MOVE and C-GET at PATIENT,
STUDY, SERIES and IMAGE level, for the equipment that will never speak
QIDO-RS. **All matching is delegated to `pacs/index.py`**, which already
implements DICOM matching in SQL. Do not reimplement matching in Python over
the results — a Q/R that quietly disagrees with the archive's own study list is
how images go missing. (`mwl.py` matches in Python for the opposite reason: its
leniency is deliberate and belongs only to worklists.)

**`pacs/dicomweb.py`** — DICOMweb (PS3.18) as a Flask blueprint: QIDO-RS,
WADO-RS and STOW-RS under `/dicom-web`, so OHIF, Weasis and similar viewers work
over plain HTTP. Queries come from the index, retrievals stream off disk, and
stores go through the same filing a C-STORE uses. `/rendered`, `/thumbnail`,
bulkdata URIs and transfer-syntax transcoding are deliberately absent, and
anything the server cannot produce is answered 406 rather than faked — a
half-working viewer is worse than an absent feature.

**`pacs/index.py`** — SQLite instance index, one row per stored file, with study
and series answers derived by aggregation so a summary cannot drift from the
instances it summarises. This is the query layer behind DICOMweb QIDO-RS and the
Query/Retrieve SCP. Bumping `SCHEMA_VERSION` rebuilds from scratch rather than
migrating, because nothing in it is irreplaceable.

**`pacs/history.py`** — the dashboard's study browser: walk a storage tree, read
one header per series, group into studies, and offer delete helpers gated by
`safe_within`. Fine for a dashboard poll, hopeless for a query protocol — that
is what `index.py` exists for.

**`pacs/ingest.py`** — non-DICOM ingestion. Wraps PDFs into Encapsulated PDF
Storage and images into Secondary Capture, and owns the on-disk "pending" review
queue. The hard part is never the DICOM, it is patient identity, which a loose
file cannot supply — so identity is fed in either from a sibling DICOM header or
from the study the operator attaches to.

**`pacs/print_scp.py`** — virtual DICOM film printer. Accepts Basic Grayscale
(and optionally Color) Print Management, reassembles each film sheet, rasterises
to PDF, and stages it into the pending queue. Print is DIMSE-**N**
(N-CREATE/N-SET/N-ACTION/N-GET/N-DELETE) over a Film Session → Film Box → Image
Box tree, not C-STORE. A film has burned-in pixels and no structured identity,
so the result is never auto-sent — an operator identifies and approves it.

**`pacs/ris.py`** — emergency RIS. HL7 v2 `ORM^O01` order intake over MLLP plus
the `OrderStore`, and study↔order reconciliation by Accession Number (Patient ID
as fallback). The HL7 parser is a deliberately small dependency-free
pipe-delimited reader for MSH/PID/ORC/OBR, intentionally lenient because
real-world ORMs vary wildly.

**`pacs/mwl.py`** — Modality Worklist SCP. Answers C-FIND against the worklist
information model out of the same `OrderStore`; every open order is one worklist
item. Matching is lenient on purpose: an order that leaves a field blank matches
any value, because hiding an order a technologist needs is worse than showing
one they do not.

**`pacs/emergency.py`** — failover state machine. Probes the destinations flagged
as primary, and on sustained failure raises a prompt the dashboard turns into
"primary PACS unreachable — activate emergency RIS?". Uses both an active C-ECHO
probe and the watcher's passive send failures, with hysteresis on recovery.
Deliberately thin: it drives state and calls back into `PacsServer` for anything
DICOM-facing.

**`pacs/auth.py`** — bearer-token auth for `/api` and `/dicom-web`: token
comparison, the per-IP failed-attempt limiter, the in-memory session signer
behind the `carino_session` cookie, and the Flask wiring that installs all of it.
Enforcement only — the *policy* (a token is mandatory off loopback) is enforced
in `config.py`.

**`pacs/web.py`** — Flask app: a thin REST layer over `PacsServer` plus the
static dashboard and the bundled editor. Also carries the cross-site write guard
(every non-GET under `/api` must present `X-Carino: 1`, which forces a preflight
no foreign origin passes). `/dicom-web` and everything under it is **exempt**,
because a conforming DICOMweb client cannot be told to send a custom header and
STOW-RS would be dead on arrival; what stands in its place there is that STOW
accepts only `multipart/related`, which is not a CORS-safelisted content type,
so a cross-site POST already needs a preflight — and that preflight is answered
only for the origins in `dicomweb.cors_origins`, which is empty by default.

**`pacs/logbuf.py`** — one thread-safe ring buffer every component logs through,
so the dashboard can poll a single stream. Also appends to a dated file per day,
`<logs_dir>/YYYY-MM-DD.log` in UTC.

**`pacs/state.py`**, **`pacs/dicomfs.py`**, **`pacs/tlsutil.py`** — small shared
helpers: persistent per-file send state; `is_dicom()` (DICM magic at offset 128,
extension-agnostic) and `safe_within()`; and the `ssl.SSLContext` builders for
DICOM-TLS on both the server and client sides.

**`pacs/web/`** — the dashboard front end. Vanilla JS, no build step, no bundler,
no framework, nothing from a CDN. `index.html`, `app.js`, `styles.css`,
`i18n.js`, plus the shared fleet scripts (`carino-navbar.js`, `carino-lang.js`,
`carino-bridge.js`) and the bundled DICOM editor under `web/editor/`.

**`desktop/`** — the Electron tray app. **`packaging/`** — the PyInstaller spec
and entry point, plus the systemd unit and installer for a Linux service
deployment. **`docker/`**, `Dockerfile`, `docker-compose.yml` — the container
image. Remember that a container binds `0.0.0.0` inherently, so anything you
change there must keep `web.auth_token` mandatory. **`docs/`** — the project
website (GitHub Pages), including
`ris-emergency-design.md`, which is the design record for the RIS and failover
state machine and is worth reading before touching either.

---

## Running the tests

Tests use no runner-specific features, so they work under pytest or standalone:

```bash
./.venv/bin/python -m pytest tests/ -v       # if you have pytest
./.venv/bin/python tests/test_index.py       # no pytest needed
./.venv/bin/python test_print.py             # end-to-end print SCP, binds a real port
```

Every suite also runs from its own `__main__` and prints its own totals, so
none are quoted here to go stale:

```bash
./.venv/bin/python tests/test_auth.py tests/test_deid.py tests/test_dicomweb.py \
                   tests/test_index.py tests/test_qr.py tests/test_routing.py \
                   tests/test_web_auth.py          # one at a time, or under pytest
node pacs/web/tests/i18n-parity.mjs               # four locales at parity
node pacs/web/tests/dashboard-auth.e2e.mjs        # the login flow, in a real DOM
node pacs/web/tests/stuck-panel.e2e.mjs
node pacs/web/editor/tests/pn-roundtrip.e2e.mjs   # PN survives the bundled editor
node docs/tests/check-i18n.js                     # the project website's own locales
```

Most of `tests/` needs no network: the index, the auth and web-auth guards,
DICOMweb, de-identification (`test_deid.py` also re-parses the bundled editor's
`deid-profile.js` and fails if the Python and JS profiles drift apart), and the
bulk of the routing decisions, where the folder watcher is driven end to end
against a recording C-STORE stub — send state, retry, the archive gate, the
de-identification hold.

Three suites open real sockets, and two of them can be blocked by a squatter:
`tests/test_qr.py` (from 11401) and `test_print.py` at the repo root (from
11211) walk fixed base ports upward. `test_print.py` is the oldest end-to-end
one — it drives real pynetdicom Print SCUs against a live `PrintSCP` and checks
the film lands in the pending queue and approves into DICOM. `tests/test_routing.py`
also binds, in the cases where the wire is the only acceptable evidence: they
stand up a real `pacs.scp.StorageSCP`, forward to it, and read back the
instances that landed on its disk — which is what settles "the held study did
not leave" and "the copy that left was scrubbed". Those take an ephemeral port
from the kernel, so nothing can squat on them.

The Node checks are not optional extras: the dashboard has no build step, so a
renamed English string silently reverts four languages to English and only
`i18n-parity.mjs` says so.

The thin end is the **HL7 listener (`pacs/ris.py`) and the Modality Worklist
(`pacs/mwl.py`)**, which have no automated suite at all, and the failover
monitor (`pacs/emergency.py`), which has one regression test inside the web-auth
suite and none of its own. That is the single most useful place to contribute. A
pull request that is *only* tests for an existing module is welcome and will get
reviewed faster than a feature. Two notes if you write some:

- Prefer the pure layers — the HL7 parsing in `ris.py`, worklist matching in
  `mwl.py`, `config.py` validation — because they need no sockets.
- If you must bind a port, take an ephemeral one from the kernel rather than
  picking a number — `tests/test_routing.py`'s `_free_port()` binds
  `("127.0.0.1", 0)` and reads the port back, which cannot collide with a
  running dev instance or with another suite. The fixed base ports in
  `test_print.py` and `tests/test_qr.py` predate that and are the reason those
  two can fail on a busy box. Always tear the listener down in a `finally`.

---

## House conventions

These are the ones that are non-obvious and have each caused a real bug. They
are documented in the code; this is a summary, and the code is the authority.

### The safety rule

Restated because it is a review criterion, not a preamble: nothing is dropped,
failures retry, failures stay visible. See [above](#the-rule-that-outranks-everything).

### CSS: three classes of value, three treatments — and never `break-all`

`pacs/web/styles.css` states a rendering policy for every value shown in the
dashboard's key/value strips, and it is a correctness rule, not a taste one:

- **ATOMIC** — identifiers a human matches character-for-character against a
  modality's configuration: `bind:port`, AE titles, `HL7 / MLLP`. **A wrapped
  identifier is a misread identifier.** These never break: they ellipsise
  (`white-space: nowrap; overflow: hidden; text-overflow: ellipsis`) and `app.js`
  mirrors the full value into a `title` attribute.
- **PATHS** — get the whole row (`.wide`) at a smaller size, and are the *one*
  place where breaking mid-token is the right answer, because a filesystem path
  has no other break points.
- **PROSE** — everything else wraps at spaces: `word-break: normal` plus
  `overflow-wrap: break-word`.

**Do not use `word-break: break-all`, and do not use `overflow-wrap: anywhere`
outside the `.path` class.** Beyond cutting identifiers mid-token, `anywhere`
shrinks min-content sizing, which silently collapses a grid track and reintroduces
the mid-word cutting somewhere else on the page. Grid tracks that hold values use
`minmax(0, 1fr)`, never a bare `1fr`, so the track itself has no min-content
floor.

Related, and equally load-bearing: cards use container queries
(`container-type: inline-size`), not viewport media queries, because a card's
width is decided by the sidebar and panel padding rather than the window. And
`html[lang="ru"]` / `html[lang="ja"]` drop uppercasing and wide letter-spacing on
labels, because all-caps Cyrillic at wide tracking is materially harder to scan
and Japanese gains nothing from uppercase.

### i18n: the English string *is* the key, and four locales must stay at parity

`pacs/web/i18n.js` follows the fleet convention: **English source strings are the
dictionary keys.** A missing entry falls back to the English literal, so nothing
ever renders blank — but it also means changing an English string is renaming a
key, and every locale silently reverts to English until you update it too.

There are four translated locales — **`es`, `pt-BR`, `ja`, `ru`** — and they must
stay at parity. If you add a user-visible string:

1. Add it to all four blocks in `pacs/web/i18n.js` (and `desktop/i18n.js` if the
   string is in the Electron shell).
2. If it carries a count, it goes in `PLURALS`, not `I18N`, and it needs the
   right number of forms per language: 1 for `ja`, 2 for `en`/`es`/`pt-BR`, **3
   for `ru`**. Use `TN()`.
3. Respect the width budgets written in the comments next to each section — card
   labels ≤ 12 chars, Start/Stop ≤ 6, and so on. A translation that busts its
   budget does not wrap prettily, it changes a card's height in one language
   only.
4. Run `node pacs/web/tests/i18n-parity.mjs`. It catches a half-translated key,
   a key pasted twice into one block, an orphan left behind by a renamed English
   literal, and a plural entry with the wrong number of forms — and it is the
   only thing that will, because every one of those still renders.

Markup uses `data-i18n` (textContent), `data-i18n-html`, `data-i18n-title`,
`data-i18n-placeholder`, `data-i18n-aria-label`. Dynamic strings in `app.js` go
through `T()` / `TF()` / `TN()`. Rows cloned from a `<template>` are built
outside the document, so call `window.applyI18nIn(clone)` on each one.

Some strings are **deliberately untranslated** because they are protocol
identifiers a technologist matches against equipment configuration: `DICOM`,
`PACS`, `AE`, `SCP`, `SCU`, `MWL`, `RIS`, `HL7`, `MLLP`, `TLS`, `mTLS`,
`C-FIND`, `C-ECHO`, `ORM^O01`, port numbers, AE titles. A missing entry or an
identity entry both mean "leave it alone" — do not "fix" either. There are two
documented exceptions in `ru` (РИС, and `MWL` for the Worklist chip); both are
intentional and explained in the file header.

Log lines and API messages come from the Python engine and stay in the server's
language. Do not add a translation layer to the backend.

### A worker's `stop()` must `join()` its thread

Every background worker in this codebase follows the same shape: a
`threading.Event` to signal, a `daemon=True` thread, and a `stop()` that sets the
event **and then joins the thread with a timeout**, guarding against joining the
current thread:

```python
def stop(self) -> None:
    self._stop.set()
    t = self._thread
    if t and t.is_alive() and t is not threading.current_thread():
        t.join(timeout=5)
    self._thread = None
```

Skipping the join is the bug. `apply_config()` stops a worker and immediately
restarts it, and a stop that returns before the old thread has released the
socket makes the restart fail with `EADDRINUSE` — intermittently, under timing
that differs per machine, which is the worst possible failure mode to debug. The
`is_alive()` and `current_thread()` guards matter too: a worker whose own loop
calls `stop()` must not deadlock on itself.

### A new config key with no dashboard field needs a `loadedX` snapshot

This one bites everybody once. `apply_config()` merges the posted config over
`DEFAULTS`, so **any key the dashboard does not send back is reset to its
default.** The dashboard's Save collects values from form fields, so a key with
no form field would be wiped on every Save.

`pacs/web/app.js` solves this by keeping a snapshot of each loaded section —
`loadedScp`, `loadedScu`, `loadedPrint`, `loadedRis`, `loadedMwl`, `loadedQr`,
`loadedEmg`, `loadedWeb`, `loadedDicomweb`, `loadedIndex`, `loadedRouting`,
`loadedDeid`, plus the top-level `loadedSetup` and `loadedLogsDir` — and
spreading it into the object it posts. Grep for `loaded` there rather than
trusting this list; a section added since is a section this sentence has not
caught up with, and the failure mode is silent. So: **if you add a config key that has no
dashboard form field, you must also carry it through the snapshot**, or every
Save will silently reset it and the user will report a setting that "doesn't
stick".

The corollary, learned the hard way: after a server-side action rewrites config
(the setup chooser calls `/api/setup`), **re-read the config with `loadConfig()`**
rather than hand-assigning the fields you think changed. Hand-assignment is what
created this class of bug, and the next field added silently reintroduces it. If
the re-read fails, that must be surfaced loudly — the next Save would otherwise
post a stale snapshot.

### Comments explain *why*

The code is dense with comments and almost none of them restate what the line
does. They record the reasoning, the failure that motivated the choice, and what
not to "fix". Match that. A comment saying "increment the counter" will be asked
to justify itself; a comment saying "260px resolved to a cell one character too
narrow for `0.0.0.0:11112`" is the house style.

Plain, direct voice. No marketing language, no exclamation marks.

---

## Making a change

### Before you start

- For anything more than a bug fix, **open an issue first.** A day of your work
  declined on scope is worse for you than a paragraph declined on scope.
- Check that the change does not need a new runtime dependency. The dependency
  list is short on purpose (`pynetdicom`, `pydicom`, `flask`, `pillow`,
  `psutil`), because every addition is a thing that has to keep working inside a
  PyInstaller freeze on three operating systems. A new dependency needs a
  justification in the issue.

### While you work

- **Do not edit `.venv/`, `desktop/node_modules/`, or anything under
  `desktop/engine`, `desktop/dist` or `build/`.** All are generated.
- `config.json` at the repo root is gitignored local runtime config. If you add
  a config key, add it to **`DEFAULTS` in `pacs/config.py`** and to
  **`config.example.json`**, and validate it in `validate()`.
- If your change is user-visible, add the strings to all four locales.
- Test on more than one OS if you touch paths, sockets, or process handling.
  This runs on Windows, macOS and Linux, and the differences are real — Windows'
  cp1252 stdout, for instance, is why `_force_utf8_output()` exists.

### Commits and pull requests

- Branch from `main`, and open a pull request against `main`.
- **Commit messages are imperative, sentence case, and describe the effect a
  user would notice** — not the mechanics. Real examples from the history:
  *"Stop the service cards shredding text, and say what each one does"*,
  *"Ship the shell dictionary in the packaged app"*, *"Ask which services this
  PC should run, and show what it is doing"*. No prefixes, no ticket numbers, no
  conventional-commits scopes.
- **Do not add AI or tool attribution** to commits, code comments, or docs. No
  `Co-Authored-By` lines for assistants, no "generated with" trailers. Using a
  tool to help write a patch is fine; the commit history is a record of human
  authorship and stays that way.
- Keep pull requests focused. One behaviour change per PR gets reviewed; a PR
  that also reformats three files gets queued behind everything else.
- Say **how you tested it** in the PR description, and against what — a real
  modality, `storescu`, `dcmtk`, the bundled tests, a specific viewer. For DICOM
  changes especially, "which equipment did this actually talk to" is the most
  useful sentence in the whole description.

### Security-sensitive changes

Some parts of this codebase have a security contract that is not obvious from
reading a single function. If you touch any of these, say so explicitly in the
PR:

- **`pacs/config.py` `validate()`** — an empty `web.auth_token` is permitted
  **only** when `web.host` is loopback. A non-loopback host with an empty token
  is a hard startup error, and `is_loopback_host()` fails closed: anything it
  cannot parse as a loopback address is treated as reachable. Do not relax
  either half.
- **`pacs/auth.py`** — token comparison is `hmac.compare_digest` on bytes;
  session cookies carry an HMAC over a per-process secret and a keyed
  fingerprint of the token, never the token itself; the rate limiter is capacity
  bound so a botnet cannot grow it until the process runs out of memory; and
  client identity is `remote_addr` only, because `X-Forwarded-For` is
  attacker-controlled when there is no proxy in front.
- **`pacs/web.py`** — every non-GET to `/api` requires the `X-Carino: 1` header.
  That is what forces a CORS preflight and stops a page the operator has open
  from firing a cross-site write at their own loopback. `/api/portcheck` is a
  POST for exactly that reason. **`/dicom-web` is exempt** — a conforming
  DICOMweb client cannot send a custom header, so STOW-RS would be dead on
  arrival; its substitute guard is the `multipart/related` content type, which
  is not CORS-safelisted and therefore needs a preflight the blueprint answers
  only for the origins in `dicomweb.cors_origins`. Do not narrow that pair
  without replacing it, and do not widen the exemption past `/dicom-web`.
- **`pacs/dicomfs.py` `safe_within()`** — every destructive path operation is
  gated through it. It is realpath-based, so it defeats both `..` traversal and
  symlink escapes. Do not add a delete or move path that bypasses it.
- **`pacs/routing.py` — the de-identification hold.** Three things here are a
  contract, not an implementation detail. `usable_deidentifier()` asks the
  de-identifier OBJECT whether it will actually rewrite anything, because a
  de-identifier built for the `off` profile forwards identity exactly as surely
  as none at all. `Decision.honoured_by(deider)` is the only supported way to
  settle a route against the de-identifier a sender holds, and every sender must
  call it before sending — the open-coded alternative silently sends in the
  clear the destinations it drops. And `Decision.hold_cause` /
  `Decision.hold_message()` exist so that no surface has to guess why a hold
  happened: a message that names the wrong cause pushes an operator toward the
  edit that forwards the study identified. Do not add a code path that narrows
  `deid_dests` without widening `held`, and do not print a hold explanation that
  is not branched on `hold_cause`.

Anything that would make it *easier* to run an unauthenticated PACS reachable
from a network is the change most likely to be rejected outright. That includes
defaults, examples, docs and container images.

Found an actual vulnerability? Do not open a pull request. See
[SECURITY.md](SECURITY.md).

---

## Licensing

Carino PACS is licensed **GNU Affero General Public License v3.0 or later**
(AGPL-3.0-or-later). In plain terms, and stated for contributors specifically:

- **Your contribution is licensed under the same terms.** By opening a pull
  request you are offering your changes under AGPL-3.0-or-later. There is no
  CLA and no copyright assignment — you keep your copyright, the project just
  receives a licence under the same terms everyone else gets.
- **The network clause is the point.** AGPL section 13 means anyone who lets
  users interact with a modified version *over a network* must offer those users
  the corresponding source of their modified version. Since this software is
  normally used over a network — a dashboard, DICOMweb, DIMSE listeners — a
  hospital or vendor that modifies it and exposes it to its users owes those
  users the source. Merely *running* an unmodified copy inside your own
  institution triggers no obligation to anyone outside it, and using it on your
  own patient data creates no obligation to publish anything about that data.
- **It is copyleft, and that reaches derived works.** Combining this code into a
  larger product means that product is distributed under the AGPL too. If that
  is incompatible with your plans, the honest answer is to use a
  permissively-licensed PACS rather than to ask for a relicence.
- **There is no warranty.** The licence disclaims it, and given what this
  software does, take that seriously. Whoever deploys it in a clinical setting
  owns the validation.
- Keep the licence headers and the copyright notice in files that carry them,
  and do not add code you do not have the right to contribute — no snippets
  lifted from a GPL-incompatible or proprietary codebase.

If you are unsure whether something you want to reuse is compatible, ask in an
issue before writing it.
