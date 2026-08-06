# Carino PACS

Carino PACS is a **DICOM gateway and continuity appliance**: one box, in one
department, that keeps imaging moving when something upstream breaks — and that
talks to the equipment nothing else will talk to.

It receives studies and forwards them, captures modalities that can only
*print*, serves a worklist, takes HL7 orders and reconciles them to the studies
that come back, answers Query/Retrieve and DICOMweb, and takes over when the
primary PACS goes unreachable. It is configured through one JSON file and a
local dashboard, by a technologist or an IT generalist rather than a PACS
engineer.

<img width="1160" height="868" alt="image" src="https://github.com/user-attachments/assets/9e30ba10-e34b-42f0-a97c-96eaf5a67ddb" />

> Before deploying it anywhere near patients, read
> **[Regulatory and safety](#regulatory-and-safety)**. It is not a medical
> device, and it is not for primary diagnosis.

---

## Who this is for

Three situations, all of them unglamorous and all of them common:

- **The modality that can only print.** Film is the only output it has, and no
  archive will take it. Carino pretends to be the laser imager, captures the film,
  and turns it into a PDF or a Secondary Capture object you can identify and
  forward like any other study.
- **The department typing accessions by hand.** No RIS feed, or the feed is
  down, so the technologist keys the accession into the console. Carino takes
  HL7 orders when there are any, lets you hand-key them when there are not,
  serves them to the modality as a worklist, and matches the study back to the
  order when it arrives.
- **The primary that just went down.** Carino watches it, notices, offers to
  take over the worklist so scanning continues, holds every study received
  during the outage, and back-fills the primary once it answers again.

If none of those describe your problem, the next section probably does.

## When to use something else

**[Orthanc](https://www.orthanc-server.com/) and
[dcm4chee](https://www.dcm4che.org/) are excellent, free, mature and
better-supported archives, and this project does not try to beat them.** Use
one of them, not this, if you want:

- a **long-term archive** — tiering, storage commitment, retention policies,
  clustering, replication;
- **user accounts, roles or a per-user audit trail** — Carino has none of the
  three (see [Regulatory and safety](#regulatory-and-safety));
- a **plugin ecosystem**, a REST API other products already integrate with, or
  a viewer in the box;
- **certification, a support contract, or someone to call**;
- anything that must survive the person who installed it leaving.

Carino is worth reaching for when the failure you are solving is *operational*:
a link is down, a modality is old, an order never arrived, and images are
sitting still because of it. It is a small piece of infrastructure that
degrades gracefully, not an archive.

The two are not mutually exclusive, and the usual deployment is not either/or:
Carino sits in front of Orthanc or dcm4chee as the gateway, and the archive
stays the archive.

---

## Quick start

Both paths get you to a Storage SCP accepting C-STORE. Pick one, then run the
two-minute proof below.

### Docker

The container is the fastest path and needs nothing on the host but Docker.

```bash
git clone https://github.com/MiguelCarino/Carino-PACS.git
cd Carino-PACS

# The container never runs as root, so ./data has to be writable by your uid.
mkdir -p data
echo "PACS_UID=$(id -u)" >> .env
echo "PACS_GID=$(id -g)" >> .env

docker compose up -d --build
docker compose logs -f pacs        # the dashboard token is printed once, on first boot
```

Then open <http://127.0.0.1:8042/> and paste the token when the dashboard asks
for it.

What you get out of the box: the dashboard on `127.0.0.1:8042`, the Storage SCP
on `127.0.0.1:11112`, a generated 256-bit token, and nothing published to your
network. `docker-compose.yml` is written to be read — every default in it is the
conservative one, and the comments say what to change and what it costs. The
first things you will want are `PACS_BIND` (so modalities can reach the DICOM
port) and `PACS_SERVICES` (which listeners to enrol on first boot).

Podman works too: build with `podman build --format docker` if you want the
image-level healthcheck to survive, and uncomment `userns_mode: keep-id` in the
compose file.

### From source

```bash
./setup.sh          # creates .venv and installs dependencies
./run.sh init       # writes ~/CarinoPACS/config.json and creates the folders
./run.sh serve      # dashboard at http://127.0.0.1:8042
```

Windows (PowerShell):

```powershell
.\setup.ps1
.\run.ps1 init
.\run.ps1 serve
```

Requires **Python 3.10+**. On Debian/Ubuntu also install `python3-venv`
(`sudo apt install python3-venv`); Fedora and macOS ship what is needed.
`./run.sh <cmd>` is only a wrapper around `python -m pacs <cmd>` in the venv —
if the dependencies are already on your system Python, `python3 -m pacs serve`
does the same thing.

A fresh config enables **no listener at all**. The dashboard opens a setup
chooser that asks which ones this machine should run; tick Receiver (and
anything else) and it writes the enabled flags for you. Nothing binds a DICOM
port until you say so.

### Prove it works, in two minutes

You do not need a modality to test this. `pynetdicom` — already a dependency —
ships the DICOM client tools, and `pydicom` ships a sample CT image.

```bash
# 1. Start the receiver. Under Docker it is already running; from source, tick
#    Receiver in the dashboard, or run it head-less in its own terminal:
./run.sh receive --port 11112

# 2. In another terminal: is it alive?
python3 -m pynetdicom echoscu 127.0.0.1 11112 -v

# 3. Send it a real DICOM object.
DCM=$(python3 -c "from pydicom.data import get_testdata_file; print(get_testdata_file('CT_small.dcm'))")
python3 -m pynetdicom storescu 127.0.0.1 11112 "$DCM" -v
```

A successful store looks like this, and the study appears in the dashboard's
Received list immediately:

```
I: Association Accepted
I: Sending Store Request: MsgID 1, (CT)
I: Received Store Response (Status: 0x0000 - Success)
```

On disk it lands under the storage directory, organised by patient / study /
series:

```
~/CarinoPACS/received/1CT1/1.3.6.1.4.1.5962.1.2.1.20040119072730.12322/…/….dcm
```

Running under Docker, aim the same commands at the published port, or run them
inside the container if you have no `pynetdicom` on the host:

```bash
docker compose exec pacs python -m pynetdicom echoscu 127.0.0.1 11112 -v
```

Once the instance index has it, the query side works the same way — enable
Query/Retrieve, then:

```bash
python3 -m pynetdicom findscu 127.0.0.1 11115 -S \
  -k QueryRetrieveLevel=STUDY -k PatientName= -k StudyInstanceUID= -v
```

---

## What it does

Every service that opens a port is **off by default**, listens on its own port,
and can be run from the dashboard or head-less from the CLI. The one thing that
starts on its own is the instance index (`index.enabled` defaults to `true`) —
it is a local sqlite cache and it binds nothing.

| Service | Default port | Default AE | Config section |
|---|---|---|---|
| Dashboard + DICOMweb | 8042 (loopback) | — | `web`, `dicomweb` |
| Storage SCP (C-STORE / C-ECHO) | 11112 | `CARINOPACS` | `scp` |
| Virtual print receiver | 11113 | `CARINOPRINT` | `print` |
| Modality Worklist SCP | 11114 | `CARINOMWL` | `mwl` |
| Query/Retrieve SCP | 11115 | `CARINOQR` | `qr` |
| Emergency RIS (HL7 over MLLP) | 2575 | — | `ris` |
| Auto-send (outbound, no listener) | — | `CARINOSCU` | `scu` |

### Receive and store

A Storage SCP that accepts every storage SOP class with every transfer syntax
pynetdicom knows, so compressed objects (JPEG, JPEG-LS, JPEG2000, RLE) are
stored **as received** — there is no transcoding anywhere in this project, and
nothing silently rewrites pixel data. Files are organised by
Patient / Study / Series when `scp.organize` is on, `allowed_aets` filters
calling AE titles, and a disk-space guard (`scp.min_free_gb`, default 2 GB)
refuses new instances rather than filling the volume.

### Forward, with rules

The auto-send watcher polls a folder and C-STOREs anything new to your
destinations.

- A file is only sent once it is **stable** (size unchanged between two scans,
  and non-zero), so half-written files never leave.
- Delivery is tracked **per destination**; the file counts as done only when
  every destination it was routed to has accepted it. Failures retry with
  exponential backoff, capped at five minutes.
- Progress is persisted next to the config, so a restart does not re-forward the
  archive.
- Files are recognised by the `DICM` marker, so extension-less DICOM works.
- After success: `keep`, `move` to a sent folder, or `delete`.

**Conditional routing** (`routing.rules`) decides *which* destinations a study
goes to, matching on modality, calling AE, station name, patient ID or study
description — case-insensitive globs, all fields optional. A rule can also mark
the copy for de-identification, and `stop` ends rule evaluation. The rule that
outranks the rest of the design: **a study must never end up going nowhere.**
Routing off, no rule matched, an unreadable header, a rule naming a destination
that no longer exists — every one of those falls back to *every enabled
destination*. Over-sending is an annoyance; under-sending is a lost image. The
dashboard has an "Explain route" button that tells you which rule a given study
would hit and why.

**The one exception is the de-identification hold**, and it is the same rule
seen from the other side: a promise to deliver is not a permission to disclose.
See [Held, not sent](#held-not-sent).

### De-identify on forward

The archived original is never rewritten — the copy that *leaves* is the one
that gets de-identified. Profiles are `off`, `basic` (PS3.15 Annex E Basic
Application Level Confidentiality Profile, with the Retain options it applied
declared in the object so a recipient can see exactly what was kept) and
`strict` (device and institution identity dropped, private tags removed
regardless). Generated values are HMAC-derived, so the same patient maps to the
same pseudonym across runs with no lookup table to lose — set `deid.secret` or
that mapping is a pure function of the input and guessable.

**It does not touch pixels.** Burned-in demographics survive every profile, and
narrative text inside Structured Reports is not read for identifiers. A human
has to look at the images. This is stated at length in
[SECURITY.md](SECURITY.md) and it is the single most likely way data leaves a
site with a name still on it.

#### Held, not sent

A rule's `deidentify` says *which* destinations get a scrubbed copy; the
de-identification settings say whether a scrub can actually be performed. When a
rule asks for one that cannot happen, Carino resolves it one way, every time:

> **A destination a rule asks to de-identify for is not sent to at all unless
> the scrub can actually be performed.** It is *held*, not forwarded identified.

This is the single deliberate exception to "a study must never end up going
nowhere", and it exists to keep the promise the operator actually made. The
alternative is not a delivery, it is a disclosure — identity arriving at a node
whose owner was told it receives none — and no later edit undoes it.

##### Two causes, two remedies

The outcome is identical and the causes are not. Every surface that reports a
hold — the log, `/api/stuck`, the stuck panel, "Explain route" — carries a
`hold_cause` saying which, because a message that guesses is how a hold was once
reported as "the profile is off" at sites whose profile was on.

| `hold_cause` | What is wrong | What to do |
| --- | --- | --- |
| `profile-off` | A rule asks for de-identification and `deid.profile` is `off`, so no copy can be scrubbed. | Turn the profile on (`basic` or `strict`), **or** take `deidentify` off the rule. |
| `no-deidentifier` | A rule asks for de-identification, the profile is **on**, and no de-identifier could be built from the current settings — so no copy can be scrubbed. | Fix the de-identification settings until one can be built; the failure that stopped it is in the log on the send channel. |

The second one is the trap. **Turning the profile off does not release a
`no-deidentifier` hold** — it releases nothing and only changes which half is
stopping the scrub. And taking `deidentify` off the rule does release either
hold, but it releases them as **identified** copies, which is the one outcome
the hold exists to prevent; it is the right edit only when you no longer want
that destination scrubbed at all.

##### The study is not lost, and none of this is silent

- it **stays in the outgoing folder**, is never archived and never deleted, so
  it is still there to send the moment the hold is released;
- **every other destination on the same study still receives it** — only the
  de-identified route is held;
- the activity log says so as an **error**, naming the study, the destination
  and the cause, and the dashboard's de-identification panel says so in its
  loudest state;
- the ⚠ **Stuck** badge counts the file, and `/api/stuck` reports held
  destinations as their own list — apart from backing-off and orphaned sends,
  because the remedy is different and each row carries its own;
- **"Explain route"** marks the rule that caused the hold, so the trace cannot
  read as a delivery.

Nothing releases a hold on its own: no timer runs it down and nothing retries
it. Whichever edit you make, the next watcher pass sends what has been waiting.

So when studies stop reaching one destination while every other destination
keeps receiving them, look here first: open Settings → De-identification. If the
profile reads *Off* while a routing rule still has de-identify ticked, that is
the `profile-off` hold. If the profile reads *Basic* or *Strict* and the
destination is still held, it is the other one — read the send channel in the
log for the failure that stopped a de-identifier being built. Either way the
stuck panel names the destinations it is holding and the remedy for the cause it
recorded.

### Query/Retrieve (C-FIND / C-MOVE / C-GET)

The half of a PACS that old equipment can actually use. Patient Root and Study
Root information models at PATIENT, STUDY, SERIES and IMAGE level, answered out
of the sqlite instance index — so the query results and the dashboard's own
study list cannot drift apart. C-MOVE destinations come from
`qr.move_destinations`, falling back to the configured destination list.

A retrieve never invents an instance list: anything the index knows about but
cannot be read off disk right now is counted as a **failed sub-operation** and
named in the Failed SOP Instance UID List. A C-MOVE that reports success while
sending fewer images than it matched is the worst failure this software could
have, and it will not do that quietly.

### DICOMweb (QIDO-RS / WADO-RS / STOW-RS)

Served under `/dicom-web` on the dashboard port, for viewers like OHIF and
Weasis that speak HTTP and never negotiate an association. Queries come from the
index, retrievals stream off disk, and a STOW-RS store goes through the *same*
filing path as a C-STORE, so a study posted by a viewer is indistinguishable
from one pushed by a modality. `dicomweb.allow_stow` makes it read-only;
`dicomweb.cors_origins` is an **exact-match** allow-list — it is empty by
default, nothing is reflected back to an origin that is not in it, and there is
no pattern syntax. A literal `"*"` in the list *is* honoured, and it is honoured
only because the operator typed it: from then on every origin is reflected, so
any page they happen to have open can read the whole archive off localhost.
Name the viewer instead.

Deliberately not implemented, and answered `406` rather than faked: `/rendered`,
`/thumbnail`, bulkdata URIs, and transcoding between transfer syntaxes.

### Virtual print receiver

For modalities that will only print to a laser imager. Carino answers Basic
Grayscale Print Management (and Color, optionally), reassembles each film sheet
from the image boxes, and renders it to a **PDF** or a **Secondary Capture**
image (`print.layout`). It also answers the Basic Annotation Box and Print Job
SOP classes so a fuller-featured print SCU negotiates cleanly.

A film carries burned-in pixels, not a structured PatientID — so captured film
lands in the **pending review queue** for an operator to identify and approve,
and is **never auto-forwarded**. Guessing an identity here would be worse than
asking.

### Emergency RIS (HL7 order intake and reconciliation)

For testing a RIS→PACS feed without a live RIS, and as a fallback when the real
one is down:

- receives HL7 `ORM^O01` orders over **MLLP** (port 2575) — *and* lets you
  hand-key orders in the dashboard when nothing upstream is alive;
- open orders show the **accession number** the technologist types into the
  modality;
- when the study is stored, it is matched to its order by accession number
  (patient ID as an optional fallback) and the order is closed and archived —
  never erased;
- **image delivery is never gated on a match.** A study with no matching order
  is still stored and forwarded; the order simply stays open for manual
  reconciliation.

The parser is deliberately lenient, because real `ORM^O01` messages vary
wildly. The listener has no TLS and no authentication of any kind — bind it to a
trusted segment and set `ris.allowed_hosts`.

### Modality Worklist

The flip side: Carino serves those orders to modalities as a DICOM worklist
(C-FIND). Point a modality at the worklist AE/port and it pulls every open
order. An order's **target modality AE** steers it to one station (blank = every
station sees it), and the order's pre-generated Study Instance UID is burned
into the exam, so the study that comes back reconciles to the order exactly. If
a destination PACS simply *has no RIS*, tick its "No RIS" box and Carino runs
the worklist for it permanently.

### Emergency failover

Rather than run the worklist all the time, Carino can watch your primary PACS
and offer to take over when it fails. Mark a destination as a primary, arm the
monitor, and it C-ECHOes that node periodically (and watches for forward
failures). If it stays unreachable past the threshold you get a prompt —
*"Primary PACS unreachable — activate emergency RIS?"* — and activating starts
the local worklist so techs keep scanning, **holds** every study received during
the outage, and **auto-forwards** them once the primary is back. Set *Activate
automatically* to skip the prompt.

Held studies are pinned to the primary in the send state: a routing rule may
widen that delivery but can never revoke it, so a held copy cannot be marked
"sent" by reaching somewhere else.

This "held" and the de-identification hold above are different mechanisms that
share a word. A failover hold is waiting on a *node* and clears itself when the
node answers; a de-identification hold is waiting on a *configuration* and
clears only when someone edits it. The stuck panel lists them separately for
that reason.

### Non-DICOM ingest

PDFs and JPEG/PNG images become **real** DICOM objects — Encapsulated PDF
Storage and Secondary Capture Storage respectively, not an invented private SOP
class. Identity is the hard part and it is never guessed: convertible files
found beside a study are siphoned into the pending queue with identity
pre-filled from a sibling header, and the dashboard's Attach action inherits
identity straight from the target study, so a report can be added to an
already-sent study and re-sent.

### Instance index

A sqlite row per stored file, aggregated into patient / study / series answers.
It is what makes Query/Retrieve and QIDO-RS fast enough to be usable. It is a
**cache, never the source of truth** — every row points at a file that is still
on disk, and losing the database costs a rescan, never an image.

### Bundled DICOM tag editor

A `dcmjs` tag editor and de-identifier is served from the dashboard at
`/editor/`, entirely client-side and entirely offline — the vendored copy is in
the repo, every script, font and module it loads resolves to a path this server
serves, and nothing is fetched from a CDN at runtime (versions and licences:
[`pacs/web/editor/vendor/README.md`](pacs/web/editor/vendor/README.md)). The
"Edit tags" action hands a study to
it over the shared Carino Bridge. Its de-identification profile is kept in step
with the Python one by a test that re-parses the JavaScript and fails if the two
drift apart. It is a tag editor, **not a diagnostic viewer**.

### Dashboard, CLI, packaging

Every function has a head-less command; the dashboard is optional. The interface
is available in **English, Spanish, Portuguese (Brazil), Japanese and Russian**.
Deployment shapes: Docker/compose, systemd units
([packaging/README.md](packaging/README.md)), and an Electron tray app for a
clinician's workstation ([BUILDING.md](BUILDING.md)).

---

## Maturity

Honest status, so you can decide what to lean on:

| Area | Status |
|---|---|
| Storage SCP, auto-send | Original core, the most exercised code here |
| Virtual print receiver | End-to-end automated tests drive real print SCUs against a live listener |
| De-identification | Well covered; pixel data explicitly out of scope |
| Instance index, routing, auth, DICOMweb, Query/Retrieve | Newer, each with its own automated suite |
| Folder watcher and delivery | Driven end to end by the routing suite — send state, retry, the archive gate, the de-identification hold — mostly against a recording C-STORE stub, and in the cases where the wire is the evidence against a real Storage SCP on loopback whose disk is then read back |
| Failover monitor | One regression test in the web-auth suite; no suite of its own |
| HL7 listener, Modality Worklist | Working, but exercised by hand only — no automated suite at all, and the thinnest coverage in the project |
| Desktop tray app | Runs; installers are unsigned unless you supply signing secrets |

**No part of this project has been validated against clinical equipment by
anyone.** It is developed against `pynetdicom`'s own SCU/SCP tools and synthetic
studies. That is enough to prove protocol conformance and not enough to promise
your 2009 CR reader will negotiate cleanly. If it works with your modality, that
is a useful report — please open an issue saying so, including the ones that
fail.

Known interop caveats that are already documented in the code: the print SCP
relies on the print SCU supplying Film Session / Film Box UIDs (pynetdicom's own
SCU and most modalities do), and DICOMweb answers `406` for anything needing a
rendering or transcoding pipeline rather than approximating it.

---

## Regulatory and safety

Read this before it matters.

- **This is not a medical device.** It is not CE-marked, not FDA-cleared, not
  certified by anyone, and nothing in it has been validated for clinical use.
  Whoever deploys it owns that validation.
- **It is not for primary diagnosis.** The bundled editor is a tag editor, not a
  reading workstation. Nothing here is calibrated, and no image it displays or
  produces should be read from.
- **There is no encryption at rest.** Studies are ordinary DICOM files on disk,
  the index holds patient names and identifiers in the clear, orders are JSON,
  captured print jobs are PDFs, and `config.json` holds both the dashboard token
  and `deid.secret` — the HMAC key behind every pseudonym this box has ever
  issued — in plaintext. Anyone with filesystem access to the data directory has
  everything, including the ability to re-link studies already exported as
  "anonymised".
  Put it on full-disk or filesystem-level encryption — LUKS, BitLocker,
  FileVault — and restrict the directory to the account that runs the service.
- **There is no user management.** No accounts, no usernames, no roles, no
  permissions. The token is a single shared secret, and everyone holding it can
  read every study, change every setting, and shut the server down.
- **There is no per-user audit trail.** The log records what happened —
  associations, stores, forwards, order matches, rejected tokens — with
  timestamps and peer addresses. It cannot record *who* did it, because the
  software has no concept of a who. Logs are plain text with no tamper
  protection: an operational record, not evidence.
- **De-identification does not remove burned-in patient data.** See above.
- **The HL7 MLLP listener is unauthenticated and unencrypted.** Anyone who can
  open a TCP connection to it can inject orders that appear on the worklist.
- **The dashboard speaks plain HTTP.** No built-in TLS for the web layer; put a
  reverse proxy in front of it if it leaves loopback.

The design does hold one safety line consistently, and it is the reason several
of the behaviours above look paranoid: **an image that silently never arrives is
worse than a visible failure.** Routing falls back to every destination rather
than dropping a study, retrieves report failed sub-operations rather than
under-counting, indexing failures cost a query result and never an image, and a
listener that cannot bind leaves the dashboard up so you can see the error.

One delivery is deliberately not made, and it is held to the same standard: a
destination a rule asks to de-identify for is **held** whenever the scrub cannot
actually be performed — either because `deid.profile` is `off`, or because the
profile is on and no de-identifier could be built from the current settings. See
[Held, not sent](#held-not-sent), which sets out both causes and their two
different remedies. Nothing is discarded, the study waits on disk, and the log
and the dashboard both say why — naming the cause rather than assuming one,
because the failure this prevents (identity leaving for a node the operator
believes receives none) is the one no later edit can undo, and misreporting
which half is broken sends the operator to the wrong screen.

The AGPL disclaims warranty in the strongest terms the law allows, and that
disclaimer is meant literally.

---

## Security

Full posture, including a private disclosure route: **[SECURITY.md](SECURITY.md)**.
Please report vulnerabilities privately rather than in a public issue.

The headline rule, because it is the one that decides whether a deployment is
safe:

> **The dashboard is loopback-only unless you set a token — and it refuses to
> start otherwise.**

`web.host` at `127.0.0.1` needs no token: only a process on this machine can
reach the API. The moment it binds anything else, the same API hands any network
neighbour the study list, the storage paths, the DICOM bytes and the shutdown
endpoint — so an empty `web.auth_token` there is a hard startup error, checked
before anything binds:

```
Refusing to serve the dashboard on '0.0.0.0': it is reachable from the network
and web.auth_token is empty.
  Set a token:  python -m pacs -c ~/CarinoPACS/config.json init --token
  Or keep it on this machine only:  --host 127.0.0.1
```

The same gate stops the config being *saved* with that combination, and the
container — which necessarily binds `0.0.0.0` inside its namespace — generates a
token on first boot and prints it once.

Around that: credentials are accepted as `Authorization: Bearer`, an
`X-Carino-Token` header, or a session cookie that carries an HMAC rather than
the token itself and dies with the process; failed attempts are rate-limited per
IP while a *correct* token is always honoured (locking the only operator out of
a running PACS is the worse failure); state-changing calls to `/api` require an
`X-Carino` header, and `/dicom-web` is exempt from it because no conforming
DICOMweb client can send one — STOW-RS's `multipart/related` body forces the
preflight there instead; the config file is written `0600` and log files `0640`,
because those lines carry patient names. Every DICOM listener can serve over
TLS, with client certificates for mutual authentication, and `allowed_aets` /
`allowed_hosts` filter peers.

---

## No telemetry, and the licence

**Carino PACS collects nothing and sends nothing.** No analytics, no crash
reporting, no update checks, no usage counters, no remote logging, no license
server, and no third-party script fetched at runtime — everything the dashboard
needs, fonts included, is vendored in this repository. The only outbound
connections it ever makes are the DICOM associations and HL7 acknowledgements
you configured, to the peers you named. Patient data never leaves the machines
you pointed it at.

That is a guarantee, not a preference: a change adding an outbound call to
anything else would be treated as a vulnerability, and
[CONTRIBUTING.md](CONTRIBUTING.md) says such a patch will be rejected on sight.

**Licensed under the GNU Affero General Public License v3.0 or later** — see
[LICENSE](LICENSE). Copyright © 2026 Miguel Carino.

Because this is a network server, AGPL §13 applies: if you run a modified
version as a service, you must offer its users the modified source. Practically,
that means you can run it, read every line of it, change it, and never be
metered, phoned home to, or told your licence expired — and neither can anyone
who hands you a modified copy. Bundled dependencies
([`pynetdicom`](https://github.com/pydicom/pynetdicom),
[`pydicom`](https://github.com/pydicom/pydicom), `dcmjs`) keep their own
permissive licences.

> Planned relicense: the AGPL protection is intended for the pre-1.0 → 1.x
> development window. A future **2.0.0** may relicense to MPL-2.0 for wider
> clinical adoption. Contributions are accepted on the understanding that they
> may be included in that relicense.

---

## Configuration

One JSON file drives everything. `pacs init` scaffolds it from
[config.example.json](config.example.json), which is commented section by
section and is the reference for every key. The sections are `scp`, `scu`,
`print`, `mwl`, `ris`, `qr`, `dicomweb`, `index`, `routing`, `deid`,
`emergency`, `destinations`, `web` and `logs_dir` — plus `setup_completed`,
which the setup chooser stamps and nobody edits by hand.

By default everything lives in **`~/CarinoPACS/`** — the config, the `received` /
`outgoing` / `sent` / `pending` folders, the sqlite index and a dated log file
per day. Relative paths resolve against the config file's own directory and `~`
is expanded, so a fresh install keeps itself in one visible place; set absolute
paths to put them elsewhere. Under Docker that directory is `/data`.

Anything you change in the dashboard is written back to the same file, and
anything you write into the file by hand shows up in the dashboard. Invalid
combinations are refused at save time with an explanation rather than accepted
and half-applied.

---

## CLI

The dashboard is optional — every function has a head-less command:

```bash
./run.sh serve [--receive] [--watch] [--print] [--ris] [--mwl] [--qr] [--host H] [--port P]
                     # web dashboard; the flags start a service for THIS run only,
                     # without enrolling it in the config
./run.sh receive [--port 11112] [--aet CARINOPACS] [--out ./received]
./run.sh send [--watch-dir ./outgoing]
./run.sh print [--port 11113] [--aet CARINOPRINT]
./run.sh ris [--port 2575]
./run.sh mwl [--port 11114] [--aet CARINOMWL]
./run.sh qr [--port 11115] [--aet CARINOQR]
./run.sh echo --name "Example PACS"
./run.sh echo --host 10.0.0.5 --port 104 --aet REMOTEPACS
./run.sh init [--token]        # scaffold config + folders; --token mints the API token
```

All commands accept `-c / --config <path>` (default `~/CarinoPACS/config.json`),
which is a *global* option and goes **before** the subcommand —
`python -m pacs -c /path/config.json serve`. They all
stop cleanly on both Ctrl+C and SIGTERM, so `systemctl stop` and
`docker stop` shut the DICOM listeners down instead of cutting associations
mid-transfer.

---

## TLS

Both sides can use TLS, toggled independently, on every DICOM listener —
receiver, print, worklist and Query/Retrieve. The HL7 MLLP listener has no TLS
option at all; see [Regulatory and safety](#regulatory-and-safety).

- **Receiving:** tick *Serve DICOM over TLS* and supply a certificate and
  private key (PEM). Add a client-cert CA to require and verify client
  certificates (mutual TLS).
- **Sending:** tick TLS on a destination row. The client-side material lives in
  the auto-send settings: verify on/off, an optional trusted CA bundle (blank =
  system trust store), and an optional client certificate for mutual TLS.

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout server.key -out server.crt \
  -subj "/CN=your-host" -addext "subjectAltName=IP:10.0.0.5"
```

TLS uses the **same port** — a plaintext peer cannot talk to a TLS listener, and
vice versa. With verification on, the remote certificate must be valid for the
host or IP you dial. TLS authenticates the *transport*, not the DICOM
*application*: combine it with `allowed_aets` or mutual TLS for real access
control.

---

## Notes and caveats

- **Ports.** DICOM's registered port is 104, which is privileged on Linux and
  macOS. The defaults here are all above 1024 to avoid that; under Docker,
  publish `104:11112` on the host rather than remapping inside the container.
- **Firewall.** Allow inbound TCP only on the ports you enabled, and only from
  the modality subnet. Every DICOM listener binds `0.0.0.0` by default — correct
  for something modalities must reach, and the reason the firewall matters.
- **`allowed_aets` is empty by default**, which means "accept from anyone".
- **Compressed objects are forwarded as-is.** A destination that refuses the
  object's transfer syntax is reported as a failure rather than being handed
  silently altered data.
- **Back up the storage directories.** The index is a cache and can be rebuilt;
  the images cannot.

---

## Documentation

| Document | What is in it |
|---|---|
| [SECURITY.md](SECURITY.md) | Threat model, what is and is not protected, private disclosure |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev environment, house conventions, the safety rule, how to test |
| [packaging/README.md](packaging/README.md) | Running it as a systemd service on a headless box |
| [BUILDING.md](BUILDING.md) | Desktop tray app, PyInstaller engine, installers, code signing |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Ground rules for participating |
| [CHANGELOG.md](CHANGELOG.md) | What changed, and when |

Part of the [carino.systems](https://carino.systems/) workshop.
