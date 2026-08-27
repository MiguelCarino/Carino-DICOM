# Changelog

All notable changes to Carino PACS. Versions follow [Semantic Versioning](https://semver.org/).
Licensed under **AGPL-3.0-or-later** (see [LICENSE](LICENSE)).

## [1.1.0] — unreleased

Everything added on top of the upstream **1.0.0** store-and-forward baseline.
Existing configs keep working and the defaults are unchanged — every new
listener is off until it is enabled (the instance index is the one exception:
it defaults to on, because it is a local cache and nothing reaches the network),
and a file with no routing rules is still forwarded to every enabled
destination. What is no longer true is the "store only" description: this
release also queries, retrieves, routes and de-identifies.

### Added
- **Modality registry** — `modalities` is a config list (name, AE title,
  modality, optional station name, enabled) with its own Configuration tab
  beside Destinations. An order's target is picked from it rather than typed.
  The typo that removes fails two opposite ways, and which one you get is the
  vendor's choice rather than yours: a modality that queries the worklist with
  its own AE title in `ScheduledStationAETitle` never sees an order aimed at a
  typo, while one that queries with the key empty — equally conformant — sees
  that order on *every* station. The validator refuses a blank name or AE
  title, an AE title over the DICOM limit of 16 or carrying a space or
  backslash, a quoted `"false"` for `enabled`, and two stations sharing an AE
  title case-insensitively, since the worklist compares them that way and
  those are one station to it and two to the operator. Until a modality is
  registered the field stays free text: an order that cannot be keyed in
  during an outage is worse than one aimed at a typo. Registry and
  destinations stay separate lists — a modality *pulls* a worklist from this
  appliance, a destination *receives* studies from it, and one AE title may
  legitimately appear in both. (`pacs/config.py`)
- **Worklist probe** — asks another RIS what it would hand one of your
  modalities, using that modality's own AE title, and reports where a broken
  worklist is broken. Borrowing the AE title is the point: a provider may
  answer differently depending on who asks, and that is usually the fault
  being chased. It is also why the scanner must be off the network first,
  which this code cannot verify and does not pretend to — so it is a button
  somebody presses, never a timer, it says so in the confirmation, and it is
  audited under the actor who pressed it. Five questions are asked with **one
  key relaxed at a time**, because a single answer does not locate a fault and
  a count lies: an order carrying no `ScheduledStationAETitle` reaches every
  modality, so a scanner can look scheduled while only ever seeing the orders
  nobody addressed. Each answer is split into addressed-to-this-station,
  addressed-to-nobody and addressed-elsewhere, and the verdict never reports
  "working" on a count alone. Results are a **record, not a queue**, in a
  store of their own: `pacs/mwl.py` serves every open order in the
  `OrderStore` as a worklist item, so a caught order filed there would be
  handed straight back out to this department's modalities — another
  hospital's orders, on your scanners, with no step in between that anybody
  chose. `pacs/caught.py` therefore has no status, no UID minting, no
  reconciliation and no worklist path; a flag on a shared store would only
  have made that unlikely, and only until the next change to the query reading
  it. Read-only, bounded, and shown under Activity → Caught behind
  `config.read` rather than `orders.read`: these are another system's
  patients, and the people who diagnose infrastructure are not the people who
  key orders in. The operational log carries accessions and counts, never a
  name — it is read by more people than that pane and gets pasted into support
  threads. One worklist address for the whole appliance, in Settings; blank
  means no probing. (`pacs/caught.py`, `pacs/scu.py`)
- **Test orders fill themselves in** — ticking *Test order* completes the form
  and locks what it filled: the same invented patient every time, a fresh
  `TEST-<stamp>` accession so two test orders can never collide on identity,
  and a referring of "Carino PACS". Modality, scheduled time and target
  modality stay the operator's, being the three things a test actually varies.
  Unticking restores what was there before.
- **Profiles, capabilities and per-field identifier visibility** — optional and
  **off by default**, so an existing install behaves exactly as it did. Turning
  them on gives each person a sign-in, a set of capabilities and their own name
  in the audit trail, seeded with four editable presets (Administrator, IT,
  Radiologist, Reception). Capabilities are enforced at every endpoint, never in
  the browser: `GET /api/status` is *composed* per profile rather than filtered,
  so a receptionist's browser never receives the destination table or the storage
  paths. Identifier visibility is per field — an administrator decides which of
  patient name, ID, date of birth, sex, accession, study description and
  referring physician each profile may see, and withheld values arrive as `***`
  rather than blank. The shared `web.auth_token` keeps working as an
  administrator, so no machine client breaks. (`pacs/users.py`)
- **Audit trail** — append-only, hash-chained records of who did what, to what,
  from where, and whether it worked, with `GET /api/audit/verify` reporting the
  first break in the chain and `GET /api/audit/export` producing a verifiable
  copy. Separate from the operational log by design. Recording reads is opt-in
  (`audit.log_reads`). On by default. (`pacs/audit.py`)
- **Emergency notification** — optional outbound webhook (HMAC-signed over the
  exact bytes sent) and SMTP to per-profile addresses, so an outage reaches
  somebody who does not have the dashboard open. The message is written for its
  reader's role, and detail is gated on what that reader could have seen in the
  dashboard anyway. Off by default; no patient identifiers are ever sent.
  (`pacs/notify.py`)
- **Emergency activation authority** — `emergency.activate_by` names who may
  answer a failover (a role, one person, or nobody because `auto_activate` is
  on), and `emergency.notify` separately names who is told. Config validation
  refuses a policy nobody matching can act on.
- **Emergency RIS** — HL7 `ORM^O01` order intake over MLLP (default port
  `2575`), plus hand-keyed orders in the dashboard. Arriving studies are matched
  to open orders by Accession Number (Patient ID fallback) and archived for
  audit; image delivery is never gated on a match. (`pacs/ris.py`)
- **Modality Worklist (MWL)** — serves open orders to modalities via C-FIND
  (default AE/port `CARINOMWL` / `11114`), burning each order's Study Instance UID into the
  exam so the returned study reconciles exactly. Per-destination *No RIS* mode
  runs the worklist permanently. (`pacs/mwl.py`)
- **Emergency failover** — monitors a primary PACS by periodic C-ECHO and
  forward-failure watch; on sustained outage, prompts (or auto-activates) the
  local worklist, holds studies received during the outage, and auto-forwards
  them once the primary returns. (`pacs/emergency.py`)
- **Virtual print receiver** — answers Basic Grayscale (and Color) Print
  Management for modalities that can only print, and renders each film to a PDF
  or a Secondary Capture image (`print.layout`). Captured film lands in the
  pending review queue for an operator to identify, never auto-forwarded: a film
  carries burned-in pixels, not a PatientID. (`pacs/print_scp.py`)
- **Embedded DICOM editor** — bundled `dcmjs` tag editor / de-identifier served
  from the dashboard. Everything it loads is vendored and resolves on-origin —
  no CDN, so it works on an air-gapped network — with the third-party versions
  and licence texts recorded beside the bundles in
  `pacs/web/editor/vendor/README.md`. (`pacs/web/editor/`)

  Resynced from upstream. What is new to an operator: **burned-in pixel
  redaction**, which draws boxes over the patient banner an ultrasound or
  secondary capture writes into the image, overwrites the stored samples in
  every frame and records the PS3.15 Clean Pixel Data code — the one hole the
  de-identification story admitted to; **the PS3.15 optional profiles** (Retain
  UIDs, Device Identity, Institution Identity, Patient Characteristics, Full
  Dates) as toggles beside Anonymize, each asserting its own CID 7050 code;
  **JPEG 2000 and JPEG-LS decoding** through vendored WebAssembly, loaded only
  when a study of that syntax is opened; **nested sequences** browsable and
  editable in the tag table, where an SQ used to render as one blank row;
  **whole-study folder loading** by drop or picker, including the extensionless
  files a PACS export is made of; and **one archive instead of many downloads**
  — the old per-file loop was silently losing five files in six past ten,
  because browsers stop honouring automatic downloads.

  A later resync adds **image edits written into the stored pixels** — rotate 90°
  either way, rotate 180°, flip, and invert `MONOCHROME1` ⇄ `MONOCHROME2` — so a
  slice a modality stored on its side comes out of Download the right way up for
  every other reader, with Rows, Columns, Pixel Spacing and the patient geometry
  following the samples and a one-step undo. It also **moves redaction to the
  Edit tab**, beside those edits rather than on the Overview: the Overview is
  the tab that rewrites nothing, and redaction is the most destructive thing the
  editor does. Redaction now opens a full-screen workspace instead of working in
  a 280-pixel sidebar preview — the images that carry a burned-in banner are
  usually 256 square, and a box could not be placed over two lines of text
  accurately at that size. The Overview's ⟳ ⇋ ⇅ are unchanged and still move
  only the picture on screen, but they now say so: they sit behind a **View**
  label, because they are the same glyphs as the ones in the Edit tab that move
  the file.

  Three fixes an operator would have hit on a smaller screen: below 1000px the
  editor **dropped a whole sidebar** rather than reflowing it, which on the Edit
  tab took away Load Files, the preview, Window/Level and the image edits with
  nothing left on screen to say they existed, on Create took away every field
  the tab has, and on Extract took away the buttons that write the PNGs. The
  Edit sidebar also clipped anything below the fold with no scrollbar, so on a
  1400×900 laptop the image edits were unreachable at full width too.
  **Window/Level** now folds away and starts folded, with the current window
  kept on its header, since expanded it was taller than the image it adjusts.
  And **Download All** appears only when more than one file is loaded; with a
  single file it was the only download button on screen, named for a batch that
  did not exist.

  Also serves `.wasm` as `application/wasm` explicitly (`pacs/web.py`), because
  Python resolves MIME types from the Windows registry on Windows and `.wasm`
  is frequently absent from it.

  **This sync also restored 38 attributes to the de-identification profile.**
  Upstream had regenerated `deid-profile.js` from a source tracking an older
  edition of PS3.15 Annex E and lost them — the patient pronoun and
  gender-identity block, the alternative-calendar birth dates, the four
  diagnosis code sequences, both SR observer names and the capture-device
  identifiers, thirty-five of them marked *remove*. The copy bundled here was
  the correct one and is what upstream was repaired from, so no Carino PACS
  release ever shipped the short table. (`pacs/web/editor/deid-profile.js`)
- **Podman, natively** — `packaging/podman/carino-pacs.container`, a Quadlet
  unit that runs the same image rootless under systemd, with no compose provider
  involved. `podman compose` is a shim over `podman-compose` or Docker's own
  `docker-compose` and neither ships with Podman, so on a stock Fedora, RHEL or
  Rocky box — the distributions that ship Podman as the default engine — the
  compose path fails before it reads a line of the file. Three things are better
  on this path than on the Docker one, not merely different: `keep-id:uid=1000,
  gid=1000` maps the invoking account onto the image's baked one, so the data
  directory comes out owned by whoever ran it and the `PUID`/`PGID` build
  arguments stop mattering; `Notify=healthy` holds the unit in *activating*
  until the Storage SCP is genuinely accepting associations, so `systemctl
  start` returning means the gateway is up rather than that a process exists;
  and the logs go to the journal beside everything else on the machine. The one
  thing that is worse is that rootless cannot publish below port 1024, so
  classic DICOM port 104 needs `net.ipv4.ip_unprivileged_port_start` lowered
  machine-wide — documented rather than worked around. Verified end to end on
  Podman 5.8.4: dashboard, API, bundled editor and its WebAssembly decoders,
  a real `pynetdicom` C-ECHO on 11112, graceful stop, and data surviving a
  restart. (`packaging/podman/`, `packaging/README.md`)
- **Disk-space guard** — refuses ingest below a free-space threshold
  (`scp.min_free_gb`), on C-STORE and on STOW-RS alike, measured with
  `shutil.disk_usage` so it needs no extra dependency. (`pacs/scp.py`,
  `pacs/dicomweb.py`, and the dashboard's own reading in `pacs/server.py`)
- **Report attachment by accession** — a PDF, JPEG or PNG is wrapped in a
  standard SOP class (Encapsulated PDF / Secondary Capture) and inherits the
  identity of the study carrying that Accession Number, rather than becoming a
  dummy object. The kind is decided by magic bytes, with the extension only as a
  fallback. (`pacs/ingest.py`)
- Interface redesign and shared Carino navbar/clock.
- **Query/Retrieve SCP** — C-FIND, C-MOVE and C-GET over Patient Root and Study
  Root at PATIENT / STUDY / SERIES / IMAGE level (default AE/port
  `CARINOQR` / `11115`), answered out of the instance index so query results and
  the dashboard's study list cannot disagree. A retrieve never invents an
  instance list: anything the index knows about that cannot be read off disk is
  counted as a failed sub-operation and named in the Failed SOP Instance UID
  List. Head-less as `pacs qr`. (`pacs/qr.py`)
- **DICOMweb** — QIDO-RS, WADO-RS and STOW-RS under `/dicom-web` on the
  dashboard port, for viewers that never negotiate an association. STOW stores
  through the same filing path as a C-STORE, disk-space floor included;
  `dicomweb.allow_stow` makes it read-only and `dicomweb.cors_origins` is an
  exact-match allow-list — nothing is reflected by default, and a literal `*`
  is honoured only because the operator typed it there. `/rendered`, `/thumbnail`, bulkdata URIs and transcoding are
  answered `406` rather than approximated. (`pacs/dicomweb.py`)
- **SQLite instance index** — one row per stored file, aggregated into
  patient / study / series answers; it is what makes Q/R and QIDO usable. A
  cache, never the record: losing it costs a rescan, never an image. Fed from
  the C-STORE path and rescanned on start. (`pacs/index.py`)
- **Conditional routing** — per-study rules choosing which destinations a file
  is forwarded to, matched on modality, calling AE, station, patient ID or
  study description (case-insensitive globs, every field optional), with
  `deidentify` and `stop` per rule. Every failure path — routing off, no rule
  matched, unreadable header, a rule naming a destination that no longer exists
  — falls back to every enabled destination, because a study must never end up
  going nowhere. The one exception is the de-identification hold below.
  "Explain route" in the dashboard says which rule a given study
  would hit. (`pacs/routing.py`)
- **The de-identification hold** — a rule's `deidentify` and whether a scrub can
  actually be performed are two halves of one decision, and `routing.Decision`
  is now the only place they are put together: `destinations` is what the rules
  picked, `deid_dests` is what will actually be scrubbed, `held` is what must
  not be dialled, `sendable` is what a sender walks. When a rule asks to
  de-identify for a destination and the scrub cannot happen, that destination is
  **held — not sent to at all, rather than forwarded identified.** It is the
  single deliberate exception to "a study must never end up going nowhere", and
  it is the same safety rule from the other side: a promise to deliver is not a
  permission to disclose, and a disclosure is the one outcome no later edit can
  undo. Nothing is lost — the study stays in the outgoing folder, is never
  archived and never deleted, every other destination on the same study still
  receives it, the log raises an error naming study and destination, the
  de-identification panel says so, and the stuck panel lists held destinations
  in their own section (a held node is never dialled, so it never fails and the
  backoff list could not see it). Before this, the two halves were read in two
  different places — routing reported "de-identified" to the dashboard and to
  `/api/status` while the senders, finding no de-identifier, forwarded the study
  **identified**. Being told the scrub happened is what stopped anyone checking.
  (`pacs/routing.py`, `pacs/watcher.py`, `pacs/server.py`)
- **A hold now says WHICH of its two causes it has** — `Decision.hold_cause`,
  carried through `record_route` into the send state and out through
  `/api/stuck`, the log and "Explain route". `profile-off` is a rule asking for
  de-identification while `deid.profile` is `off`. `no-deidentifier` is a rule
  asking for it while the profile is **on** and no de-identifier could be built
  from the current settings — added with `Decision.honoured_by(deider)`, which is
  now the only supported way to settle a route against the de-identifier a
  sender actually holds. Same outcome, different remedy, and that is the whole
  point of separating them: the previous single message told every held site to
  "turn the de-identification profile on", which at a site whose profile was
  already on is advice that cannot work, and whose obvious substitute — taking
  `deidentify` off the rule — forwards the study identified. Surfaces that
  explain a hold branch on the cause and never assume one; a decision whose
  instances do not agree on a cause says so rather than picking one.
  (`pacs/routing.py`, `pacs/watcher.py`, `pacs/server.py`, `pacs/web/app.js`)
- **De-identify on forward** — PS3.15 Annex E Basic Application Level
  Confidentiality Profile applied to the copy that *leaves*, never to the stored
  original, with the retain options actually applied declared in (0012,0064).
  `basic` and `strict` profiles; HMAC-derived values, so pseudonyms are stable
  with no lookup table to lose. The site key is `deid.secret` — set through
  `POST /api/deid/secret` and redacted from `/api/config` like the dashboard
  token, because holding it turns an exported "ANON-…" set back into a lookup
  table. It does not touch pixels and does not read narrative SR text —
  burned-in demographics survive every profile. Setting the profile to `off`
  while a rule still asks for de-identification does not send those studies
  identified; it holds them (see the de-identification hold above) — as does a
  profile that is on but from which no de-identifier can be built.
  (`pacs/deid.py`)
- **Token authentication** for the dashboard API and DICOMweb — `Authorization:
  Bearer`, `X-Carino-Token`, or a session cookie carrying an HMAC rather than
  the token, with a per-IP failed-attempt limiter that never refuses a *correct*
  token (locking the only operator out of a running PACS is the worse failure).
  `pacs init --token` mints one; the dashboard can rotate it.
  (`pacs/auth.py`)
- **Docker** — two-stage image running as a non-root uid, `docker-compose.yml`
  written to be read (loopback-only publishing, `cap_drop: ALL`, read-only
  root filesystem, healthcheck), an entrypoint that prepares `/data/config.json`
  on first boot and generates the dashboard token, and a healthcheck that asks
  the dashboard for a real answer rather than checking the process is alive.
  (`Dockerfile`, `docker/`)
- **systemd packaging** — unit, sysusers and tmpfiles files plus an installer
  that provisions the service account and `/var/lib/carino-pacs`, and
  deliberately does not start the service. (`packaging/systemd/`,
  [packaging/README.md](packaging/README.md))
- **Emergency hold-and-forward pinning** — studies held during an outage are
  pinned to the primary in the send state. A routing rule may widen that
  delivery but can never revoke it, so a held copy cannot be marked delivered by
  reaching somewhere else. (`pacs/state.py`)
- **Project documentation** — [CONTRIBUTING.md](CONTRIBUTING.md),
  [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), issue
  templates and a pull-request template.
- **Test suites** — `tests/` covering auth, de-identification, DICOMweb, the
  index, Q/R, routing and delivery, the web auth layer, HL7 order intake and
  identity, the modality registry's validation rules, and the worklist probe,
  alongside the existing end-to-end print suite at the repo root. Every suite
  runs from its own `__main__` and prints its own totals —
  `python3 tests/test_auth.py`, and
  so on — so no counts are quoted here to go stale. The de-identification suite
  re-parses the bundled editor's `deid-profile.js` and fails if the Python and
  JavaScript profiles drift apart. Node checks live beside what they check: the
  dashboard's login flow, its stuck panel and its translation parity in
  `pacs/web/tests/`, the documentation site's own translations in `docs/tests/`.
- Dashboard: Query/Retrieve card, routing panel with "Explain route", DICOMweb
  settings, index status and rescan, and a token login prompt — all translated
  into the five shipped languages.

### Fixed
- **A config save no longer fails because something was reading the file.**
  Windows refuses to move a file onto a destination anything else holds open,
  and CPython's `open()` never asks for `FILE_SHARE_DELETE` — so an ordinary
  reader was enough to fail the operator's Save with "Access is denied": another
  `pacs serve` starting up and reading the config, a backup agent, a virus
  scanner, a text editor. POSIX renames over an open file without noticing, so
  this was invisible on seven of the nine CI cells and intermittent on the other
  two. The move is now waited out for a bounded moment, which is nothing on
  POSIX (there is no transient to wait for) and the difference between a working
  Save and a failed one on Windows. A permission problem that is real rather
  than transient still raises, after the same short delay. (`pacs/config.py`)
- **Downloading a DICOM file no longer answers a profile that may not see the
  identifiers.** `/api/studies/file` and its manifest were gated on
  `studies.read` alone. Everything the dashboard *shows* passes through the
  identifier withholding first, so a narrowed profile reads `***` where a name
  would be — but these two routes hand over the file itself, the identifiers are
  inside its own header, and nothing on the way out can rewrite them. A profile
  configured to see only the accession number could therefore download a file
  carrying the patient's name, ID and birth date. Both routes now need every
  identifier field, refusing with the capability named. Same structural reason
  as the audit export, which already refused on those grounds: what cannot be
  redacted cannot be narrowed, so the only honest gate is the whole of it.
  (`pacs/web.py`)
- **An IPv6 wildcard bind was probed on the IPv4 loopback.** `netclaim` turns a
  wildcard into a loopback address to confirm that something is really listening
  before it refuses a port, and mapped `"::"` to `127.0.0.1` — the wrong stack.
  An IPv6-bound listener was never found, the probe reported the port empty and
  the bind was allowed, which is the silent double-bind the module exists to
  stop, reached through the module itself. A dual-stack listener hid it, because
  the IPv4 loopback reaches one anyway; an IPv6-only listener is what tells them
  apart, and is what the test uses. (`pacs/netclaim.py`)
- **One instance that could not be sent stopped all forwarding, permanently and
  silently.** pynetdicom *raises* rather than answering with a status for an
  instance it cannot put on the wire — no `(0008,0018)`, file meta carrying no
  transfer syntax, an element that will not re-encode — and an over-long UI
  value raises out of `add_requested_context` before that. All of them pass
  `is_dicom()` and `dcmread()`, and the outgoing folder is the one place third
  parties are invited to drop files. `c_store` let the exception out, against
  its own docstring, and it unwound the watcher's entire pass. That is far
  worse than it sounds: `_note_failure` is never reached, so nothing is recorded
  as failed, nothing enters backoff, the stuck panel stays empty and the
  counters stay at zero — while every file queued behind the bad one is never
  dialled again, on a three-second loop, for as long as it sits there. One
  malformed instance now costs one instance. The watcher also guards its own
  send call, so a future raise from that path cannot end a pass either.
  (`pacs/scu.py`, `pacs/watcher.py`)
- **A C-MOVE or C-GET was matched on every key the identifier carried.** PS3.4
  C.4.2.1.4.1 says a retrieve selects on the Unique Keys of its level;
  `_retrieve_rows` used them only as a presence check and then filtered on the
  lot. C-FIND answers once per study with one arbitrary value for a study-level
  attribute, so an SCU that echoes that reply into its C-MOVE sends the
  attribute back — and a study whose series disagree on it (an amended study,
  one assembled from two sources, later instances carrying a corrected name;
  nothing on the receive path normalises them) then matched only some of its own
  instances. The SCU got part of a study with a final status of Success, and the
  only log line named the harmless dropped key. The sibling WADO-RS path already
  selected on UIDs alone. A retrieve now selects on the level's unique keys and
  logs what it ignored. (`pacs/qr.py`)
- **A wildcard in a retrieve Unique Key shipped everything it matched.** The
  index sends a UID holding `*` or `?` to `GLOB`, and nothing checked the value,
  so a single malformed identifier retrieved every study it matched and reported
  Success. Refused now through the same path as an identifier with no usable
  key. Only the level's unique keys are checked — a pattern on a key that is no
  longer a filter cannot widen anything, and refusing those would reject
  retrieves that work today. (`pacs/qr.py`)
- **One non-UTF-8 byte in `audit.jsonl` stopped the engine starting.** The trail
  is read with strict UTF-8 and a bad byte raises `UnicodeDecodeError` — a
  `ValueError`, so the `except OSError` guarding the read missed it. It left
  `open()`, left `PacsServer.__init__` and left `main()`, which catches neither:
  nothing bound and every modality got connection refused, because one byte in a
  log file went bad. That is the exact inverse of the invariant stated at the
  call site — the PACS keeps running and the trail reports that it stopped
  recording. The same class escaped `read_all()`, so the verify endpoint failed
  instead of reporting the corruption it exists to report. (`pacs/audit.py`)
- **The dashboard's audit view read the entire trail to show one screenful.**
  `tail()` built every record that ever happened into a list and sliced the end
  off it. Rotation caps a file, not the trail, so the cost had no ceiling: a
  couple of years of it is hundreds of megabytes, seconds of wall clock and
  gigabytes of peak memory to render a few hundred rows — and on this appliance
  the largest process is the one holding the receiver open. It now walks
  backwards a file at a time and stops when the limit is filled. Output is
  unchanged, asserted against the previous implementation across a rotated trail
  and every filter combination. (`pacs/audit.py`)
- **A rescan that lost its database connection stopped filling the index and
  still reported a clean run.** The set of paths a rescan has walked lives in a
  SQLite temp table, and a temp table belongs to the connection that made it —
  while `_write` retries on a fresh connection after an error, and `_conn()`
  swaps connections when the database file is replaced underneath it. On either
  path the table was gone, so *every remaining batch* of that rescan failed on
  it: one transient error (a filling disk, a busy database, any IO fault) cost
  not one batch but all of them. Nothing said so. `added` is counted during the
  walk rather than by the write that stores it, and the summary line did not
  mention errors at all, so the Activity log read "Index rescan: N new" over an
  index that had quietly stopped filling — and C-FIND then answered with no
  matches, and C-MOVE Success with zero sub-operations, for studies plainly on
  disk. The seen set is now re-made on whichever connection the batch lands on,
  the purge is suppressed when it had to be re-made (it holds only what was
  walked after that point, so pruning against it would delete rows for files
  that are still there), and a run that lost batches says so and warns.
  (`pacs/index.py`)
- **The audit trail reported "intact" about files it could not read.**
  `read_all()` and the chain-head lookup both answered an unreadable file with
  `except OSError: continue`. Three things followed. `verify()` walked the
  records it could reach and returned `ok` — so the dashboard's audit banner
  stayed green while an archive full of records was invisible to it. The export
  endpoint handed an inspector a silently short trail with a 200, which is the
  one reader who cannot tell. And at startup the head could be taken from an
  older archive, or from genesis, while the live file was unreadable, so the
  next record chained to the wrong link and `verify()` afterwards reported
  tampering on a trail nobody had touched. An unreadable file is now a finding
  carried through `read_all()` like an unparseable line: `verify()` stops and
  can never return `ok` past it, the export refuses rather than emitting a hole,
  and a head that cannot be established leaves the trail shut and saying so
  instead of guessing — which heals by itself, since `record()` retries the open
  every time. Rare on Linux; on Windows a scanner or backup agent holding the
  file open is an ordinary Tuesday. (`pacs/audit.py`, `pacs/web.py`)
- **Two instances could hold one DICOM port on Windows, silently.** Winsock's
  `SO_REUSEADDR` does not mean what the POSIX constant of that name means: it
  means *sharing permitted*, and Microsoft documents a second `SO_REUSEADDR`
  bind over a first one as succeeding, across user accounts, after which "the
  behavior for all sockets bound to that port is indeterminate". Every listener
  here sets it — the four DIMSE SCPs through pynetdicom's `server_bind`, the
  HL7 listener by hand, the dashboard through Werkzeug — so on Windows all of
  them opted out of the protection the platform would otherwise have given
  them. Two engines could therefore bind 11112 together, each reporting a
  healthy receiver, with each incoming association going to whichever Winsock
  picked: a study landing in one instance's storage folder, or split across
  two, with nothing anywhere saying why. Every listener now claims its port
  exclusively before binding it, and refuses to start if something already
  holds it (`pacs/netclaim.py`). The service chooser's probe was wrong the same
  way and reported such a port as free. On POSIX none of this changes anything:
  `bind()` already refuses an occupied port, and being strict there would refuse
  a service its own restart through `TIME_WAIT`.
- **Arming emergency failover had no rollback.** The config lock around it stops
  a concurrent Save from splitting memory and file; it does nothing about a save
  that *raises*, which reaches the same split — armed in memory, not armed in
  `config.json`, and `start()` re-reads the file. The operator was then told
  failover was armed while nothing was watching the primary, which is the state
  the function's own docstring names as the thing to prevent. (`pacs/emergency.py`)
- **A failed config save left a plaintext copy of the config on disk.** The
  scratch file `save()` writes before `os.replace` carries the dashboard
  `auth_token`, `deid.secret` and the SMTP password. If the replace failed —
  read-only mount, full disk, a sharing violation — it stayed beside the config
  until the age-gated sweep removed it, unmentioned. It is now removed on the
  way out. (`pacs/config.py`)
- **C-MOVE and C-GET now check that a file is inside a storage folder before
  reading it.** Every retrieval answers from a row in the sqlite index, and the
  index is a cache rather than an authority — a stale or wrong row still names
  a path this process has the rights to open. DICOMweb had re-checked
  containment since it was written; the DIMSE side never had, so `_yield_instances`
  read whatever path the row named while a WADO retrieve of the very same
  instance refused it. Both paths now share one definition of the check
  (`dicomfs.within_roots`) over one definition of the folders
  (`Config.storage_roots`), which is the part that stops the difference coming
  back. A row pointing elsewhere is refused and reported to the SCU in the
  Failed SOP Instance UID List rather than skipped, so a short study is never
  handed back looking complete, and it is logged apart from "cannot read"
  because a containment refusal is a stale index rather than a disk fault. A
  Q/R SCP that was never told which folders are its own now serves nothing and
  says so, where the previous default was to serve any path the index named.
  Found by reading the code closely enough to document it, not by a report.

### Changed
- **An order now has an identity, and ORC-1 is read.** Every `ORM` created a
  new order: nothing read the order control code, and nothing recognised a
  message as being about an order already here, so a repeat, an amendment and
  a cancellation all landed as duplicates. Seeding the manual's demo with
  three orders four times produced twelve open orders, which is how it was
  found. Untidy on an emergency trickle; on a live feed it is the failure this
  codebase is written against — two open orders for one accession carry two
  different Study Instance UIDs, the modality burns whichever the worklist
  handed it into the exam, and reconciliation then closes one order and
  orphans the other permanently. An order is identified by placer order number
  (ORC-2), filler order number (ORC-3) or accession, tried in that order and
  matched *independently* rather than as one composite key, because the filler
  number is routinely absent from the first message and present in the second
  and a composite would make that pair look like two orders. `CA`, `OC`, `CR`,
  `DC` and `OD` cancel; **everything else, including codes never seen before,
  upserts** — an unrecognised code treated as an upsert leaves an extra open
  order, which is visible and can be cancelled by hand, while treated as a
  cancel it would close a live order silently and the exam would simply never
  be performed. Four things an amendment must not do, each now a test: re-mint
  the Study Instance UID, which the modality may already have stamped into an
  exam; blank a field it does not carry, since a status message is nearly
  empty and writing its blanks over a full order erases the demographics the
  technologist is reading (the HL7 path takes non-empty values only; the
  dashboard's edit still clears, because an operator removing a wrong target
  modality has to be able to); wipe `station_aet`, which no `ORM` carries and
  whose loss sends the order back to every station; or reopen a closed order.
  A cancel for an order this PACS never received creates nothing — a phantom
  row would be a fact about the feed rather than about this department — but
  it is logged and counted, so a feed that is all no-ops does not read as
  silence. `/api/status` gains `orders_amended`, `orders_cancelled` and
  `orders_noop` beside `orders_in`, which now counts creations only.
  (`pacs/ris.py`)
- **Carino ends only the orders it created.** Provenance is the authority
  boundary: it may complete and withdraw what it created, while an order the
  real RIS created belongs to the RIS — this appliance serves it on a worklist
  and notices its study arriving, but does not decide the exam is off, and an
  order the RIS never completes is the RIS's business rather than a fault
  here. `origin` is an explicit field (`ris`, `carino-manual`, `carino-test`)
  instead of a prefix match on the `source` display string, which was doing
  load-bearing work it was never meant to; orders written before the field
  existed are stamped from their source on load, once. `close_order()` refuses
  an order of RIS origin and says where to cancel it instead. Relaying an
  ORC-1 cancel the RIS itself sent stays allowed — that is repeating the
  owner's decision rather than making one — and is recorded as
  `cancelled-by-ris` so the panel never credits it here. The close reasons are
  now constants (`matched`, `captured`, `cancelled-by-ris`, `cancelled-here`),
  because a study that arrived and somebody giving up both used to render as
  "cancelled", and a view that cannot separate those cannot be used to
  troubleshoot anything. Test orders are their own origin rather than sharing
  the manual one: a test order behaves identically all the way through, which
  is the point of testing with it, so the only thing separating it from a real
  patient's exam is a tag — and during an outage that tag is the most
  important thing on the row. Delete stays available on a RIS order, being
  housekeeping on this appliance's copy rather than a claim about the exam;
  cancelling asserts the exam is not happening, which is the only thing here
  that was ever the RIS's to say. (`pacs/ris.py`)
- **The dashboard's twelve sidebar rows are six.** Nine of the twelve were
  three questions about one pile of files, four things you set at
  commissioning and two ledgers; they are now Studies (History | Pending |
  Stuck), Configuration (Destinations | Routing | Settings | Modalities |
  People) and Activity (Logs | Audit | Caught), with Overview, Services and
  Orders unchanged. The nav needed 745px of column and got 674px at 1366×768 —
  an ordinary clinic resolution — so Audit and Sign out sat below a fold
  nothing announced. `data-cap` became a space-separated OR-list, and both
  halves are load-bearing: a merged row appears if the profile holds *any*
  capability its tabs need, and each tab is then gated on its own, because a
  Radiologist holds `routing.read` and the Settings pane behind that row
  carries the shutdown control and the API token. The absorbed panels keep
  their ids on the panes, so `#dlgStuck` still resolves. The URL tracks panel
  and tab (`#studies/stuck`) with `pushState`, so Back works and old `#dlgXxx`
  spellings still resolve. Count badges are real buttons beside the row rather
  than spans inside it, so a keyboard can reach them. Overview tiles leading
  to a forbidden panel render as plain readouts instead of dead clicks. The
  `.wrap` cap went 1180px → 1400px, since on the 1920px wall screens this
  appliance is sold for, 39% of the glass stayed dark. (`pacs/web/`)
- **The service chips are disabled rather than hidden for a profile without
  `services.control`.** Service state is not privileged — receiver, watcher,
  printer, mwl and qr are deliberately absent from `_STATUS_GATES` in
  `pacs/web.py`, so they reach every profile — and these chips are the only
  always-on-screen sign that the receiver died, for the two people standing
  nearest the modality. What was wrong was the click: six unconfirmed service
  stops in the permanent chrome, which the server then refuses with a 403
  anyway. Keep the dot, take the switch.
- **The manuals are re-shot for the six-panel dashboard**, all fifty-one
  figures captured from a live instance, with every passage that told a reader
  to click a sidebar row that is now a tab rewritten in three languages at the
  same anchors. The prose gained a description of the dashboard's actual
  shape, which the manuals never had. A verification pass found the alt text
  was describing the *previous* screenshots — the failure mode that directory
  exists to prevent — and it was corrected against the new images by opening
  them.
- **The landing page fits on one screen.** It was 2.5 screens at 1080p and 3.6
  on a 1366×768 laptop, which is the size the laptop in a reading room
  actually is. Everything below the fold is a `<dialog>` opened from a row of
  buttons: nothing was deleted and nothing is fetched, so it is still one
  Ctrl-F and still indexed. Twenty-four of twenty-five language-and-viewport
  combinations fit in one screen; Russian at 1280×720 needs 27px more and
  scrolls. Nothing forbids scrolling — no `overflow:hidden`, no fixed `100vh`,
  no `justify-content:center` on the hero, each of which would clip content
  for a reader at 200% zoom. The page is *sized* to fit and degrades into an
  ordinary scrolling page when it cannot.
- **The sign-in gate keeps its question when the language changes.**
  `#authTitle` and `#authLede` carry the token wording in the markup, and
  `setGateMode()` overwrites them at runtime for whichever shape the gate is
  in — so the language pass, which rewrites every `data-i18n` node from the
  markup, put the token question back over a screen showing no token field:
  "This PACS needs its access token" above four profile buttons. Anyone
  switching language at the gate saw it, which is the one moment a reader is
  most likely to.
- **One mark instead of two.** The favicon was a hand-drawn face and the
  desktop icon a concentric aperture, so the product shipped two unrelated
  logos. Both are now the same bold C: legible at 16px, which is the only size
  the mark is really seen at, and gold rather than black, so it survives a
  dark tab strip. `make_icon.py` draws it from constants rather than tracing a
  bitmap and now writes the mac and windows bundles itself — not for tidiness,
  but because ImageMagick writes a bare PNG under an `.icns` name: it exits
  clean, `identify` reads it, and macOS loads nothing. The `.icns` written
  here carries the same eight member types as the one that shipped before,
  every payload decodes at the size its type code promises, and the `.ico`
  gained six sizes while losing 11KB, the `auto-resize` path having emitted
  uncompressed BMP entries. (`desktop/assets/make_icon.py`)
- **The emergency prompt is acknowledged per person, not globally.** It was one
  flag, so a receptionist clearing a pop-up they could do nothing about took it
  off the radiologist's screen and off IT's at the same time — and the
  radiologist was the one who was going to forward the study somewhere it could
  be read. Each person is now asked, and answers, for themselves; the prompt
  text follows their role.
- **A restricted profile is refused DICOMweb and the audit export** rather than
  served identifiers it may not see. QIDO answers in DICOM tag keys and WADO-RS
  in raw Part 10 bytes, so the redactor cannot reach either; an audit export has
  to carry records exactly as written or the chain cannot be checked against it.
  Both refusals name what they would take. Unrestricted profiles and the access
  token are unaffected.
- **`POST /api/config` no longer accepts the profile list**, and re-checks
  `deid.manage` against what a save actually changes. Both are escalation paths
  out of `config.write`, which the IT preset holds: without the first, posting a
  document with an extra admin row would be a two-line path to full control.
- **Documentation corrected where it had become false.** README and SECURITY.md
  claimed no user management and no per-user audit trail; both now describe what
  exists and, more importantly, what it still does not do — the audit chain
  cannot detect truncation of its own tail, and there is still no encryption at
  rest. SECURITY.md gained *Why encryption at rest is deferred*, which argues
  for full-disk encryption underneath rather than an application-level scheme
  whose key would sit on the same disk as the data.
- **Carino Bridge** — the ✎ *Edit tags* hand-off to DICOM-editor now goes
  through the shared `carino-bridge.js` used across the fleet, instead of a
  hand-rolled exchange on each side. The bundled same-origin editor behaves as
  before; an editor on another origin (`web.editor_url` pointing at a public
  build) now names the sending host and asks the operator once before loading
  a study, since the editor previously accepted files from any page that
  opened it. Older builds on either side keep working — the two ends settle on
  the old message format when one of them only speaks that. The editor now
  reports what it managed to parse rather than what it was handed, so a study
  `dcmjs` cannot read no longer announces itself as loaded.
- Description updated from "store-only PACS" to "store-and-reconcile PACS."
- Desktop package license corrected from **MIT** to **AGPL-3.0-or-later** to
  match the repository LICENSE.
- `__version__` bumped `1.0.0` → `1.1.0`.
- **The dashboard refuses to start off loopback with no token.** `web.host` at
  `127.0.0.1` still needs no credential; anything reachable from the network
  with an empty `web.auth_token` is now a hard startup error, checked before
  anything binds, and the same combination is refused at config-save time and by
  the container entrypoint. That address is the one mistake that publishes
  patient studies, storage paths and `/api/shutdown` to the LAN.
- **SIGTERM now unwinds the way Ctrl+C does.** Without a handler the process
  died where it stood: listeners never stopped, associations cut mid-transfer,
  the index writer's backlog dropped — and SIGTERM is what `docker stop` and
  `systemctl stop` send. Measured after the fix, both signals stop a running
  engine in about half a second, exit `0`, and end the log with the receiver
  stopping. The systemd unit's `KillSignal=SIGINT` was the workaround for the
  old behaviour and has been removed, so every supervisor now takes one shutdown
  path; drop the line from any local copy of the unit. The signal-converting
  wrapper the macOS notes used to require is likewise no longer needed.
- **README rewritten.** It described a store-only PACS that no longer exists.
  It now says what the project is for (degraded-mode operation: print-only
  modalities, hand-keyed accessions, a primary that went down), when to use
  Orthanc or dcm4chee instead, what has and has not been verified, and what it
  does not do — no encryption at rest, no user management, no per-user audit
  trail, not a medical device.
- `config.json` is written atomically at `0600` (`O_EXCL` + `O_NOFOLLOW`) and
  log files are created at `0640`: both carry patient identifiers, and the log
  files also carry the AE titles of every node the box talks to. Each save
  writes its own scratch file — `config.json.tmp.<pid>.<random>`, swept when
  stale — instead of the single shared `config.json.tmp` two concurrent savers
  used to fight over, one unlinking the other's file mid-write and leaving a
  config that would not load. The service account therefore needs write access
  to the *directory* holding `config.json`, not just to the file.
- Boolean config values are type-checked on load. A JSON `"false"` string read
  as **true** everywhere, which silently enabled things nobody enabled.
- Duplicate destination names are rejected. The name is the join key for routing,
  send state, retry backoff and the archive gate, so two destinations sharing one
  collapsed into a single entry — the study was marked delivered when *one* of
  them got it and the other node silently never received the images.
- The bundled editor's PS3.15 Table E.1-1 was regenerated from the standard as
  published: 617 → 656 attributes. The previous extract tracked an older edition
  and was short 35 rows, including the whole (0010,0011)–(0010,0047)
  pronoun/gender-identity block and the four diagnosis code sequences. The three
  alternative-calendar birth/death dates are now removed as well — their VR is
  LO/CS rather than DA, so a full date of birth survived anything keying off the
  table or the VR.
- The archive gate only judges files the current pass actually routed. A route
  recorded under yesterday's destination list is evidence about yesterday's
  config, and archiving on it is how a study reaches nobody and is deleted for
  it.

### Verification

- The automated suites listed above pass, and cover the index, routing, auth,
  de-identification, DICOMweb, Q/R and the print SCP end to end. The routing
  suite drives the real folder watcher — send state, retry, the archive gate,
  emergency pinning, the de-identification hold — mostly against a recording
  C-STORE stub, and where the wire is the evidence it forwards to a real Storage
  SCP on loopback and reads back the instances that landed on its disk. That is
  what settles "the held study did not leave" and "the copy that left was
  scrubbed"; a decision object asserting either proves nothing.
- HL7 order intake now has a suite of its own, covering identity, the ORC-1
  control codes, what an amendment must not overwrite, provenance and the
  cancel authority, the concurrency case a thread-per-connection listener
  makes real, and one pass through the MLLP handler itself. The Modality
  Worklist has no suite of its own, but its C-FIND serving is now genuinely
  exercised: the worklist-probe suite stands up a real `MwlSCP` over a socket
  and queries it, rather than mocking an answer that would only agree with
  itself. That coverage is incidental — shaped by what the probe needs to ask,
  not by what MWL needs proved — so treat it as evidence the wire works and
  not as a conformance suite. The failover monitor still has one regression
  test in the web-auth suite and none of its own, and remains the part of this
  release exercised by hand only.
- The mac and windows icon bundles are verified **structurally, not by loading
  them**: the `.icns` carries the same eight member types as the one that
  shipped in 1.0.0 and every payload decodes at its declared size, but nothing
  has opened either file on macOS or Windows. Tagging a release runs
  `desktop-build.yml` on all three runners, which is the first real test of
  both.
- **Nothing here has been validated against clinical equipment by anyone.**
  Development and testing use `pynetdicom`'s own SCU/SCP tools and synthetic
  studies, which proves protocol conformance and promises nothing about a
  specific modality.
- The Docker image, the compose file and the systemd units are Linux-only and
  are new in this release; treat a first deployment as something to watch rather
  than something proven. Nothing in this release has been through a formal
  validation of any kind, and none of it is a medical device.

## [1.0.0] — 2026-07-09

Upstream baseline. Store-and-forward only.

### Added
- **Storage SCP** — accepts C-STORE / C-ECHO and files studies to disk,
  optionally organised by Patient / Study / Series.
- **Auto-send watcher** — forwards new `.dcm` files to N remote nodes via
  C-STORE with per-host retry.
- Single `config.json`, head-less CLI, and local web dashboard.
- Optional TLS transport (TLS 1.2+), `allowed_aets` calling-AE filter.
- Cross-platform desktop packaging (Windows / macOS / Linux) via Electron +
  PyInstaller.
