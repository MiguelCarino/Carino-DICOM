# Security Policy

Carino PACS handles patient data. This document describes what it actually
protects and what it does not, so you can decide where it is safe to deploy it —
and how to report a problem privately if you find one.

Everything below is the **current** posture. Nothing here is aspirational; where
a protection does not exist, it says so plainly.

---

## Supported versions

| Version | Supported |
|---|---|
| Latest release on `main` | Yes |
| Anything older | No |

This is a single-maintainer project with no long-term support branches. Fixes
land on `main` and go out in the next release. If you are running an older
build, the upgrade path is the fix.

---

## Reporting a vulnerability

**Please do not open a public issue, and please do not open a pull request with
the fix as the first disclosure.** Either one publishes the problem to everyone
running the software before there is anything to upgrade to.

Report privately by either route:

1. **GitHub private vulnerability reporting** — on
   <https://github.com/MiguelCarino/Carino-PACS>, go to the *Security* tab and
   choose *Report a vulnerability*. This is the preferred route: it creates a
   private thread, keeps the history with the project, and needs no key
   exchange.
2. **Email** — `miguel.carino1994@outlook.com`, with `Carino PACS security` in
   the subject line.

Useful things to include, roughly in order of value:

- What an attacker gains, and what position they need to be in to get it
  (unauthenticated on the LAN, an operator's browser, a modality that can open a
  DICOM association, local filesystem access…).
- The version, the OS, and how it was installed.
- Which listeners were enabled and what `web.host` was set to.
- A reproduction — a request, a config, a crafted DICOM object, or a short
  script.
- **Redact patient data.** If a real study or a real HL7 message is what
  triggered it, describe the structure or send a synthetic object that has the
  same shape. Do not paste PHI into an issue, an email, or a log excerpt.

### What to expect

Be realistic about what one person can promise. There is no security team, no
on-call rotation, and no SLA:

- **Acknowledgement within about a week.** If you have heard nothing after two
  weeks, send a reminder — assume the message was missed rather than ignored.
- **An assessment within about two weeks** of acknowledgement: whether it is
  reproducible, how serious it looks, and roughly when a fix is likely.
- **Fix timelines depend on severity.** Something that exposes patient data or
  allows unauthenticated control of a running instance is the priority and gets
  worked immediately. A hardening improvement may sit for a while, and you will
  be told if that is the case rather than left waiting.
- **Coordinated disclosure, with a default of 90 days.** If a fix is taking
  longer than that, the sensible thing is usually to publish an advisory
  describing the mitigation even before the fix ships — being able to change a
  config is better than not knowing.
- **Credit** in the release notes and the advisory if you want it, and no credit
  if you would rather not be named. Say which.

There is no bug bounty. This is an unpaid project under a copyleft licence, and
there is no money to pay one from.

---

## What is protected

### The dashboard and DICOMweb API

The Flask app serves the dashboard, `/api/*`, and DICOMweb under `/dicom-web`.

- **Token authentication.** When `web.auth_token` is set, every request under
  `/api` and `/dicom-web` must present it — as `Authorization: Bearer <token>`,
  as `X-Carino-Token`, or via the session cookie issued by `POST /api/login`.
  Tokens are compared with a constant-time comparison. Generate one with
  `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`; that is about
  256 bits, which is not guessable over a network.
- **An empty token is allowed only on loopback.** Config validation **refuses to
  start** if `web.host` is anything reachable from the network while
  `web.auth_token` is empty. The loopback check fails closed: an address it
  cannot confidently classify as loopback is treated as reachable. This is the
  single most important safety property in the deployment story — **a container
  binds `0.0.0.0` by definition, so a containerised deployment must set a
  token.**
- **The default is loopback with no token.** `web.host` defaults to `127.0.0.1`,
  where the operating system is the access control and only a process on that
  machine can reach the API. This is deliberate: it is frictionless for the
  single-workstation case that most installs are, and it becomes impossible the
  moment the operator points it at the network.
- **Session cookies do not contain the token.** The cookie carries an HMAC over
  a secret generated at startup and held only in memory, plus a keyed
  fingerprint of the token that was presented at login. Consequences worth
  knowing: a restart logs everyone out, and rotating `web.auth_token`
  invalidates every outstanding session immediately — including a rotation that
  races a dashboard Save, which is worth stating explicitly because it was once
  not true. `POST /api/auth/token` reads, writes and persists the token inside
  one `cfg.mutate()` critical section, so a `POST /api/config` landing in the
  middle can no longer write the old token back underneath a rotation that
  already answered `ok: true`. Re-measured: 40 rotations against four
  continuously hammering Savers, none reverted on disk or in memory, and a live
  session cookie stopped being accepted on the next request after each one. The
  cookie is `HttpOnly`
  and `SameSite=Strict`, and `Secure` only when the request arrived over HTTPS —
  because a `Secure` cookie on a plain-HTTP LAN deployment is silently never
  sent, which presents as a login that appears to work and then fails every
  request.
- **The two secrets in `config.json` never come back out of the API.**
  `GET /api/config` replaces `web.auth_token` and `deid.secret` with booleans
  saying only whether each one is set, and neither can be written through a
  config Save: each has its own endpoint (`POST /api/auth/token`,
  `POST /api/deid/secret`) that requires the *current* token in an
  `Authorization: Bearer` or `X-Carino-Token` header, because a session cookie
  proves a browser was once logged in, not that its holder knows the secret it
  is about to replace. The token leaves the server exactly once — in the
  response to the call that mints it.
- **Failed attempts are rate limited per client IP**, with a short fixed block
  rather than escalating or permanent bans. Locking the only operator out of a
  running PACS is a worse failure than a slow brute force. The tracking table is
  capacity bound so it cannot be grown until the process runs out of memory, and
  the client is identified by the socket's remote address only — `X-Forwarded-For`
  is attacker-controlled when there is no proxy in front, and there is not.
- **Cross-site write protection.** Every non-GET request to `/api` must carry
  the header `X-Carino: 1`. This forces a CORS preflight that no foreign origin
  passes, so a page the operator happens to have open cannot fire a write at
  their own loopback API. Endpoints that would leak information via a bare GET —
  `/api/portcheck`, which probes local ports — are POST for the same reason.
  **`/dicom-web` is exempt**, because a conforming DICOMweb client cannot be
  told to send a custom header and STOW-RS would be dead on arrival. What stands
  in its place there: STOW accepts only `multipart/related`, which is not a
  CORS-safelisted content type, so a cross-site POST to it already needs a
  preflight — and that preflight is answered only for the origins listed in
  `dicomweb.cors_origins`, which is empty by default.
- **The static dashboard is served without a credential, on purpose.** It
  contains no patient data and no configuration; every byte of both arrives over
  `/api/*`, which refuses without a credential. Gating the static files would
  make the token prompt itself unreachable — a browser cannot render a login
  form it was not allowed to download — and auth that cannot be satisfied is an
  outage. In medical software that is the wrong failure. The bundled DICOM
  editor under `/editor/` is served the same way and for the same reason: it is
  static code that reads whatever the operator's own browser hands it, and it
  reaches no study on its own.
- **Destructive filesystem operations are gated** to the configured storage
  roots by a realpath-based containment check, which defeats both `..` traversal
  and symlink escapes.

### Profiles, capabilities and identifier visibility

Optional, off by default, and additive: an appliance that never turns them on
behaves exactly as it did before they existed.

- **A profile is a row, not a type.** Name, role, an optional password, a set of
  capabilities, and a set of identifier fields it may be shown. The four presets
  — Administrator, IT, Radiologist, Reception — are seed data written on first
  use and ordinary rows afterwards. Nothing in the software looks a profile up
  by name or branches on its role, so renaming or deleting any of them is safe.
- **Capabilities are enforced at the endpoint, never in the browser.** The
  dashboard derives which panels to draw from the capabilities the server tells
  it about, but that is a rendering hint: every one of the ~44 API routes checks
  for itself, and `GET /api/status` is *composed* per profile rather than
  filtered afterwards — the sections a profile has no capability for are never
  assembled into the response, so a receptionist's browser never receives the
  destination table, the storage paths or the config file location.
- **Identifier visibility is per field, not a single flag.** An administrator
  chooses which of patient name, patient ID, date of birth, sex, accession
  number, study description and referring physician each profile may see.
  Anything withheld is replaced with `***` — never blanked, because an empty
  accession means "this study has no accession" and the two must not be
  confused. The IT preset ships seeing the accession number and patient ID and
  nothing else: enough to trace a study through the routing engine at 3am,
  not enough to read somebody's chart.
- **A restricted profile is refused DICOMweb rather than served identifiers.**
  QIDO answers in DICOM tag keys and WADO-RS in raw Part 10 bytes, so the
  redactor cannot reach either — de-identification in this appliance happens on
  *forward*, driven by a routing rule, and there is no scrub on the retrieval
  path at all. Rather than let the policy be true on one surface and false on
  another, a profile that may not see every identifier gets a 403 that says so.
  The same rule applies to the audit export, which has to carry records exactly
  as written or the chain cannot be checked against it, and — since v1.1.0 — to
  the dashboard's own study-file download and its manifest. Those hand over a
  Part 10 file whose identifiers live in its own header, so withholding a field
  on the way out is not possible there either; before v1.1.0 they were gated on
  `studies.read` alone, and a profile narrowed to the accession number could
  download a file carrying the name, ID and date of birth.
- **Two capabilities are separated because either can grant the rest.**
  `auth.manage` edits profiles; `deid.manage` changes what gets scrubbed.
  Neither is in any preset except Administrator, and `POST /api/config` — which
  IT can reach — refuses to touch the profile list at all and re-checks
  `deid.manage` against what a save actually changes.
- **Passwords are optional per profile, and that is bounded.** An open profile
  is a reasonable thing on a loopback appliance or for a read-only waiting-room
  display. Config validation refuses an open profile that can change anything
  when `web.host` is reachable from the network.
- **Sessions bind to the credential that opened them.** Changing one profile's
  password ends that profile's sessions and nobody else's; disabling or deleting
  a profile takes effect on its next request, because the lookup happens per
  request rather than being cached in the cookie.
- **The shared token still works, as an administrator.** It is what every
  machine client holds, and the audit trail records its actions as a service
  rather than attributing them to a person who was not there.

### The audit trail

Separate from the operational log, which is a 500-entry ring buffer answering
"what is this box doing". This answers "who did that".

- **Append-only and hash-chained.** Each record covers the previous one's
  digest, so an edit, a deletion from the middle or a reorder breaks every
  digest after it, and `GET /api/audit/verify` reports the first break with its
  record number and cause.
- **Attributed.** Every record names the profile that caused it, with the
  action, the target, the source address and whether it succeeded. Refusals are
  recorded too — "who kept trying to reach what they are not allowed to reach"
  is a question only an audit trail can answer.
- **Written on deliberate actions, fsynced by default.** A record still in the
  page cache when the machine loses power is a record that did not happen.
- **Recording reads is opt-in** (`audit.log_reads`). "Who viewed this patient"
  is required in some jurisdictions and multiplies the size of the file by how
  often somebody refreshes a dashboard, so it is the operator's decision.
- Read the limits in *What is not protected* below before relying on it as
  evidence.

### DICOM transport

- **DICOM TLS is supported on both sides.** Every DIMSE listener (Storage SCP,
  Print SCP, Modality Worklist SCP, Query/Retrieve SCP) can be configured with
  `tls`, `tls_cert`, `tls_key` and `tls_ca`; supplying a CA on a listener turns
  on **mutual TLS** — client certificates are then required and verified. The
  outbound side (Storage SCU) can verify the remote against a CA or the system
  trust store, present its own certificate for mutual TLS, or — for self-signed
  test setups — skip verification, which you should not do on a real network.
  TLS 1.2 is the enforced floor.
- **Calling AE title allow-lists.** Each DIMSE listener accepts an
  `allowed_aets` list; when it is non-empty, associations from any other calling AE are
  rejected. Treat this as a configuration guard, not a security boundary: an AE
  title is an unauthenticated string that any peer can claim. Only TLS client
  certificates actually authenticate a peer.
- **Retrieval is confined to the configured storage folders.** Every retrieval
  — C-MOVE, C-GET and every DICOMweb read — answers from a row in the sqlite
  index, and the index is a cache rather than an authority. Before any file is
  opened, its path is re-checked against the storage folders (the receiver's
  `storage_dir`, and the auto-send `sent_dir` and `watch_dir`), resolved through
  `realpath` so `..` and symlinks cannot escape. A row that names anything else
  is refused and reported to the requester as a failed sub-operation rather than
  read out. A listener that has not been told which folders are its own serves
  nothing. Both retrieval paths share one definition of the check; until
  v1.1.0 the DICOMweb side made it and the DIMSE side did not.
- **A retrieve selects on the Unique Keys of its level, and nothing else.**
  PS3.4 C.4.2.1.4.1. A C-MOVE or C-GET identifier often carries more than that —
  an SCU that echoes a C-FIND reply back sends the study-level attributes with
  it — and until v1.1.0 every one of those was applied as a filter, so a study
  whose series disagreed on one came back short with a final status of Success.
  A Unique Key carrying a wildcard is refused outright rather than expanded:
  the index would otherwise match it as a pattern and retrieve every study it
  hit, again reporting Success.
- **Every listener claims its port exclusively before binding it.** This matters
  on Windows and nowhere else. Winsock's `SO_REUSEADDR` means *sharing
  permitted* rather than the POSIX "rebind through TIME_WAIT", and every
  listener here sets it — the DIMSE SCPs through pynetdicom, the HL7 listener
  directly, the dashboard through Werkzeug. Microsoft
  [documents](https://learn.microsoft.com/en-us/windows/win32/winsock/using-so-reuseaddr-and-so-exclusiveaddruse)
  that a second such bind succeeds, across user accounts, and that traffic then
  goes to an undefined one of the sockets — so a second engine, or any other
  process, could come up on 11112 beside a running receiver and take some of the
  studies sent to it. Since v1.1.0 the port is claimed with
  `SO_EXCLUSIVEADDRUSE` first and the service refuses to start if anything
  already holds it. Treat this as a correctness guard on a single-tenant
  appliance, not as isolation between mutually untrusted users: a process that
  wins the race before the real listener starts still wins it.

### De-identification, and the hold

A routing rule's `deidentify` flag says *which* destinations get a scrubbed
copy. The de-identification settings say whether a scrub can actually be
performed. They are edited on two different cards, so "a rule asks for a scrub
that cannot happen" is a state that two perfectly valid saves arrive at, and
something has to decide what that means.

- **A destination a rule asks to de-identify for is not sent to at all unless
  the scrub can actually be performed.** It is *held*. Nothing is forwarded
  identified to a node the operator configured as receiving de-identified data,
  and no status screen, API response or log line ever describes such a study as
  de-identified.
- This is the **only** deliberate exception to the project's governing safety
  rule, that a study must never end up going nowhere — and it is that rule
  applied one level up. A study waiting on disk is recoverable by an edit; a
  name that has arrived at an outside node is not recoverable at all. Delivery
  is deferred, identity is not disclosed.
- **There are two ways the scrub can fail to be possible, and they are reported
  apart** — every hold carries a `hold_cause` and nothing downstream guesses it:
  - `profile-off` — a rule asks for de-identification and `deid.profile` is
    `off`. Released by turning the profile on (`basic` or `strict`).
  - `no-deidentifier` — a rule asks for de-identification, the profile is **on**,
    and no de-identifier could be built from the current settings. Released by
    fixing those settings until one can be built; the failure that stopped it is
    logged on the send channel. **Turning the profile off does not release this
    one** — it releases nothing and only moves which half is stopping the scrub.
  This distinction is a security property, not a usability one. The remedy the
  software prints has to be a remedy that works, because the one edit an
  operator reaches for when told "turn the profile on" — and it already is on —
  is to take `deidentify` off the rule, and that forwards the study identified.
  Advising a cause the software cannot see is how a hold came to be reported as
  "the profile is off" at sites whose profile was on.
- **The study is not lost and the hold is not silent.** It stays in the outgoing
  folder, is never archived and never deleted; every other destination on the
  same study still receives it; the activity log raises it as an *error*, naming
  the study, the withheld destinations and the cause; the dashboard's
  de-identification panel names them, the ⚠ Stuck badge counts the files, and
  `/api/stuck` reports held destinations as their own list with the remedy for
  the recorded cause on each row.
- **Nothing releases a hold on its own** — no timer runs it down, nothing retries
  it — and the next watcher pass after the right edit delivers everything that
  was waiting. Taking `deidentify` off the rule also releases either hold, but it
  releases the studies as **identified** copies, which is precisely the outcome
  the hold exists to prevent; it is the correct edit only when that destination
  is genuinely no longer meant to receive scrubbed data.
- The decision is made in exactly one place (`routing.Decision`) and every
  consumer reads it from there, so the dashboard cannot report a scrub the
  senders did not perform. The previous split — rules read in one module, the
  profile in another — is what let an identified study be forwarded while the
  operator was told it had been de-identified. That combination is worse than a
  plain leak: a silent failure at least leaves an operator suspicious, while a
  false assurance stops them checking.

---

## What is *not* protected

Read this section before deploying anywhere that is not a closed clinical
network you control.

- **Profiles are off until you turn them on.** A fresh install, and every
  install that predates them, runs on the shared token alone — one secret, and
  everyone holding it can do everything. That is still the default, deliberately,
  because switching it silently during an upgrade would break every machine
  client on the site. Until an administrator seeds profiles, everything the old
  version of this bullet said is still true of your appliance. See
  *Profiles, capabilities and identifier visibility* above.
- **The audit trail can be truncated.** It detects a record edited in place, one
  removed from the middle, records reordered, and a file cut mid-line — each
  breaks a digest and `GET /api/audit/verify` says which record and why. It
  cannot detect the last *n* records being deleted, because the remaining prefix
  is a genuinely valid chain, and it cannot detect a wholesale rewrite by
  somebody with write access to the audit directory and a copy of the source.
  Nothing kept beside the data can. **If you need non-repudiation, anchor it**:
  the chain head is published in `GET /api/status` and on the Audit panel, so
  record it somewhere this appliance cannot write and any later truncation
  produces a head that does not match and a record count that went backwards.
- **There is no encryption at rest.** This is the one gap of the four that is
  still open, and it is open by decision rather than by oversight — see
  *Why encryption at rest is deferred* below. Received studies are written to
  disk as ordinary DICOM files, the sqlite index holds patient names and
  identifiers in the clear **and indexes them**, orders are stored as JSON,
  captured film waits in the pending queue as a PDF or an image with the
  demographics printed into the pixels, the audit trail records what was done to
  which study, and `config.json` holds `web.auth_token`, `deid.secret`, the
  webhook signing key, the SMTP password and every profile's password hash.
  Treat the de-identification key as at least as sensitive as the token: the
  token gets you this box, while the key turns every "ANON-…" set this box ever
  exported back into a lookup table — confirm a PatientID, re-link a patient
  across exports, recover the shifted dates. Anyone with filesystem access to
  the data directory has everything, and **no profile or capability changes
  that** — the whole model above is enforced by the process, not by the
  filesystem. If you need encryption at rest, use full-disk or filesystem-level
  encryption underneath — LUKS, BitLocker, FileVault — and set restrictive
  permissions on the data directory.
- **The HL7 MLLP listener has no transport security and no authentication.** It
  is a plain TCP socket speaking MLLP framing; there is no TLS option for it, no
  credential of any kind, and the HL7 parser is deliberately lenient because
  real-world `ORM^O01` messages vary wildly. Its only access control is the
  optional `allowed_hosts` list, which is a peer-address check and therefore
  spoofable on a network you do not control. Anyone who can open a TCP
  connection to that port can inject orders that appear on the modality
  worklist. **Bind it only to a trusted clinical network segment, and firewall
  it.** Default port is 2575; it is disabled by default.
- **The dashboard speaks plain HTTP.** There is no built-in TLS for the web
  layer. If you must expose the dashboard beyond loopback, put it behind a
  reverse proxy that terminates HTTPS — a token sent over cleartext HTTP on a
  shared network is a token you have given away.
- **The DICOM listeners bind `0.0.0.0` by default** (though every listener —
  Storage, Print, MWL, Q/R, HL7 and DICOMweb — is *disabled* by default and must
  be enabled explicitly; the instance index is the only thing that starts on its
  own, and it is a local sqlite cache that opens no socket). That is correct for a
  device that modalities must reach, but it means the listeners are exposed to
  whatever network the host is on. Firewall them to the modality subnet.
- **De-identification does not touch pixels.** The de-identify option implements
  the DICOM PS3.15 Annex E Basic Application Level Confidentiality Profile on
  the copy that leaves, and declares the retain options it applied — but it
  explicitly does **not** claim Clean Pixel Data (113101). **Burned-in patient
  demographics survive every profile**, and that banner printed into an
  ultrasound or a secondary capture is the most common way "anonymised" data
  walks out of a hospital with a name on it. Nothing downstream can detect that
  for you; a human has to look at the images. Narrative text inside Structured
  Reports is likewise not read for identifiers. It is also worth setting
  `deid.secret`: without one, the pseudonym mapping is a pure function of the
  input, so anyone who can guess a patient ID can confirm that patient is
  present in your exported set.
- **This is not a certified medical device**, and nothing in it has been
  validated for clinical use by anyone. Whoever deploys it owns that validation.

---

## Why encryption at rest is deferred

Because doing it badly is worse than not doing it, and most of the ways to do it
on a self-hosted appliance are doing it badly.

An appliance that reboots unattended and comes back receiving studies needs its
key available without a human present. That means the key lives on the same disk
as the data. A page that claims "encrypted at rest" in that posture invites
exactly one question — *where is the key?* — and the honest answer fails an
audit harder than not having made the claim.

So the answer here is the one real deployments use, stated plainly rather than
dressed up: **use full-disk or filesystem-level encryption underneath**. LUKS on
Linux, BitLocker on Windows, FileVault on macOS. That protects the case this
actually defends against — a disk that leaves the building, in a decommissioned
machine, a stolen laptop or an RMA'd drive — which is the same case
application-level encryption with a co-located key would protect, at a fraction
of the complexity and with none of the cost to Q/R and WADO performance.

What it does not protect against is a live box that somebody has compromised.
Neither would the alternative.

If a deployment has a requirement that genuinely needs application-level
encryption — a defined threat model, a key custody arrangement, somebody to type
a passphrase at boot — open an issue describing it. It is a real piece of work
and it should be built against a real requirement rather than against the phrase
"encryption at rest" on a checklist.

---

## No telemetry

Carino PACS collects nothing and sends nothing. No analytics, no crash
reporting, no update checks, no usage counters, no remote logging, no bundled
third-party scripts fetched at runtime. The only outbound network connections it
ever makes are the DICOM associations and HL7 acknowledgements the operator
configured, to the peers the operator named — and, since emergency notification
was added, the webhook URL and SMTP server the operator configured, to the
addresses on the profiles the operator named. Notification is **off by default**
and every part of it is empty until somebody fills it in; nothing is sent
anywhere the operator has not written down. What is sent is the fact of the
outage, its destination name and its state — no patient identifiers, and no
study data. The navbar does carry ordinary
hyperlinks to the project's pages (carino.systems, GitHub, LinkedIn); they are
`target="_blank"` anchors that do nothing until somebody clicks them, and no
script, font or stylesheet is loaded from any of them — everything the dashboard
and the bundled editor render is served from this machine.

The **bundled DICOM editor** under `/editor/` is held to the same line and is
worth stating separately, because it is the largest piece of third-party code
here: every script, stylesheet, font, module and source map it references
resolves to a path this server serves. Its four bundles — `dcmjs`, the
JPEG-lossless decoder, and the OpenJPEG and CharLS **WebAssembly** decoders that
read JPEG 2000 and JPEG-LS — are vendored in `pacs/web/editor/vendor/`, with
their versions and licences listed in `pacs/web/editor/vendor/README.md`; the
fonts are self-hosted under `pacs/web/editor/fonts/`. The two WebAssembly
modules are compiled C libraries, they are fetched lazily from this server the
first time a study of that transfer syntax is opened, and like everything else
here they are fetched from this server or not at all. **Nothing is fetched from a CDN
at runtime**, which also means the editor works unchanged on an air-gapped
network — the deployment where a silent CDN dependency would present as a page
that renders and then refuses to open a study.

This is a deliberate property of the project, and it is treated as a security
guarantee rather than a preference: patient data never leaves the machines you
pointed it at. A change that added an outbound call to anything else would be
treated as a vulnerability, and reporting one is a legitimate use of this
policy.

---

## Deploying it safely

The short version:

- Leave `web.host` at `127.0.0.1` unless you have a concrete reason not to.
- If you bind it anywhere else — including any container, which binds `0.0.0.0`
  inherently — **set `web.auth_token`** to a freshly generated random token. The
  software will refuse to start otherwise, and that refusal is the feature.
- Put HTTPS in front of any non-loopback dashboard.
- Enable only the listeners you actually use; every one of them is off by
  default.
- Firewall the DICOM and MLLP ports to the modality network.
- Encrypt the volume holding the data directory, and restrict its permissions to
  the account that runs the service.
- Use DICOM TLS, with client certificates, wherever the peer supports it.
- Treat `deid.profile` and the rules that ask for de-identification as one
  setting edited in one visit. Turning the profile `off` while a rule still asks
  for a scrub holds those destinations — correctly and on purpose — and their
  studies stop moving until you come back. Deleting `deidentify` from the rule
  is what releases them *as identified copies*, so make that edit only if you
  actually intend that node to receive identity from now on.
- If a destination is held while the profile is **on**, do not "fix" it by
  turning the profile off: that is the `no-deidentifier` hold, it releases
  nothing, and the send channel in the log carries the failure that stopped a
  de-identifier being built. Fix that, and the studies go out scrubbed.
- Keep backups of the storage directories. The sqlite index is a cache and can
  be rebuilt; the images cannot.
