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
  index, Q/R, routing and delivery, and the web auth layer, alongside the
  existing end-to-end print suite at the repo root. Every suite runs from its
  own `__main__` and prints its own totals — `python3 tests/test_auth.py`, and
  so on — so no counts are quoted here to go stale. The de-identification suite
  re-parses the bundled editor's `deid-profile.js` and fails if the Python and
  JavaScript profiles drift apart. Node checks live beside what they check: the
  dashboard's login flow, its stuck panel and its translation parity in
  `pacs/web/tests/`, the documentation site's own translations in `docs/tests/`.
- Dashboard: Query/Retrieve card, routing panel with "Explain route", DICOMweb
  settings, index status and rescan, and a token login prompt — all translated
  into the five shipped languages.

### Changed
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
- The HL7 listener and the Modality Worklist have **no automated suite at all**;
  the failover monitor has one regression test in the web-auth suite and no
  suite of its own. That is the part of this release exercised by hand only.
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
