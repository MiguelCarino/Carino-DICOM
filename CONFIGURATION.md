# Configuration reference

Every setting the appliance has lives in one JSON file. `pacs init` scaffolds it
from [config.example.json](config.example.json); by default it is
**`~/CarinoPACS/config.json`**, and under Docker it is `/data/config.json`.

Relative paths inside it resolve against **the directory holding `config.json`**,
never against the working directory, and `~` is expanded. So `./received` under
`~/CarinoPACS/config.json` is `~/CarinoPACS/received` whether the process was
started by systemd from `/`, by a tray app from the desktop, or by hand from
anywhere else. Absolute paths are taken as written.

Anything changed in the dashboard is written back to this same file, and
anything written into the file by hand shows up in the dashboard. Invalid
combinations are refused at save time with an explanation rather than accepted
and half-applied.

**Every service ships disabled.** A fresh `config.json` binds no DICOM port, runs
no HL7 listener and forwards nothing until somebody enrols a service — through
the setup chooser, the dashboard, or by editing this file. And an existing
`config.json` keeps working unchanged across an upgrade: missing keys are filled
from the defaults, so a file written before a feature existed deep-merges to the
behaviour it had before that feature existed.

---

## How to read this reference

**"Default"** means the value `pacs/config.py` applies when the key is absent
from `config.json` — not what `config.example.json` happens to ship. The two
agree almost everywhere; where they do not, the entry says so.

**Merging.** The file is deep-merged over the defaults, so an absent key is the
default and a partial section is legal. Lists are the exception: a list is
replaced wholesale, never merged into. Writing `"routing": {"enabled": true}`
and nothing else gives you `rules: []` from the defaults, not the rules that were
in the file before.

**Validation runs on the write path only** — the dashboard's Save, the setup
chooser and the CLI. `Config.load()` deliberately does not validate, because a
PACS that refuses to start is a PACS the operator cannot fix. A hand-edited
`config.json` therefore runs whether or not it would have been accepted, and the
complaint appears in the Activity log at startup instead:
*would be REFUSED if it were saved from the dashboard: … — it is being used as it
stands.* That is why several entries below describe a value that validation would
have refused and that the code still has to survive.

**Keys beginning with `_`** are not read by anything. `config.example.json` uses
`_comment` in a few sections; validation ignores them and the merge preserves
them, so they survive a dashboard Save and stay where an operator reading the
file will find them.

---

## Rules that apply across sections

Six services carry near-identical key sets. The shared behaviour is described
once here; the per-section entries below cover only what is particular to them.

### `enabled` is enrolment, not a run switch

For `scp`, `scu`, `print`, `mwl`, `ris` and `qr`, this flag says the service is
enrolled on this machine. A save that turns it **on** starts the service without
a restart. A plain save that turns it **off** does *not* stop a service that is
already running — the setup chooser (an enforcing save) and the Stop button on
the service card are what enforce the flag.

The CLI runs a service for one run without writing anything: `pacs serve
--receive --watch --print --ris --mwl --qr`, or the single-service commands
`pacs receive`, `pacs send`, `pacs print`, `pacs ris`, `pacs mwl`, `pacs qr`.

Two flags are not covered by that pattern. `index.enabled` starts on its own
because it binds nothing. `emergency` has no `enabled` key at all — `armed` is
its switch.

### Booleans, strings, and the quoted `"false"`

Every field the defaults declare as a boolean must arrive as a real JSON boolean,
and the message says why:

```
deid.keep_private must be true or false, not str ('false'). A quoted "false" is
a non-empty string, which reads as TRUE — this would turn deid.keep_private on.
```

Every reader in the code is a plain truthiness test, so `"false"` does not
misbehave subtly — it means the opposite of what was typed. Same shape for
strings: a field declared as a string is *read* by calling a string method on it,
so a JSON number does not misbehave either, it raises, far from the edit that
made it (`deid.prefix must be a string, not int (5)…`).

Both checks are driven off the defaults and reach **one level down from a
section**. That is why they cover `notify.enabled` but not
`notify.webhook.enabled`, and why they cannot reach inside `destinations`,
`modalities`, `users.profiles` or `routing.rules` — those are lists, and the
entries that need type checks there get them by hand.

### `bind`

`scp`, `print`, `mwl`, `qr` and `ris` each take one. `0.0.0.0` is every interface
on the machine, which is correct for something modalities must reach and is the
reason the firewall matters: allow inbound TCP only on the ports you enabled, and
only from the modality subnet.

Nothing validates the address beyond its type. An address this machine does not
own is discovered when `ae.start_server()` (or the MLLP socket) fails to bind:
the service does not come up, the error is logged on that service's channel, and
the dashboard shows it enabled and not running.

### Ports, and the collision check

Every listener port is validated as a JSON integer in 1..65535
(`scp.port must be 1..65535`), and each is checked against the others so two
enabled listeners cannot claim the same number:

```
scp.port and print.port are both 11112 — every enabled listener needs its own port
```

The check skips services that are switched off, with one exception: **`scp.port`
is reserved whether or not the receiver is enabled**, so enrolling the receiver
later can never fail to bind against a service the operator already had running.
`scp.port` itself is range-checked unconditionally for the same reason.

`web.port` takes no part in any of this — see [`web.port`](#webport).

Validation proves the number is in range and unique *within this config*.
"Another PACS already owns 11112" is a different question, answered by the setup
chooser's port probe (`/api/check-ports`), not at save time.

DICOM's registered port is 104, which is privileged on Linux and macOS; the
defaults here are all above 1024 to avoid that. Under Docker, publish
`104:11112` on the host rather than remapping inside the container.

### `allowed_aets`

`scp`, `print`, `mwl` and `qr` each take a list of **calling** AE titles permitted
to open an association, passed to pynetdicom's `require_calling_aet`. Blank and
whitespace-only entries are dropped. An empty list means the filter is not applied
at all — any caller is accepted — and that is the shipped default everywhere.

It is a filter, not authentication. DICOM does not authenticate the caller, so an
AE title is a claim, not a credential; combine it with mutual TLS if you need real
access control.

**Only `qr.allowed_aets` is type-checked** (`qr.allowed_aets must be a list`). The
other three are not, and the failure is quiet: a JSON string instead of a list —
`"allowed_aets": "CT1"` — is accepted, then iterated character by character, so the
allow-list becomes `C`, `T`, `1` and the real modality is refused.

### TLS on the DICOM listeners

`scp`, `print`, `mwl` and `qr` each carry the same four keys, with the same
meanings.

| key | type | default | what it does |
| --- | --- | --- | --- |
| `tls` | boolean | `false` | serve DICOM over TLS on this port |
| `tls_cert` | string (path) | `""` | this listener's own certificate, PEM |
| `tls_key` | string (path) | `""` | its private key, PEM |
| `tls_ca` | string (path) | `""` | CA bundle for **client** certificates — setting it turns on mutual TLS |

There is no second, plaintext port. A plaintext peer cannot talk to a TLS listener
and vice versa, so flipping `tls` breaks every modality that has not been
reconfigured. The context is TLS 1.2 minimum, and the startup line reports
`[DICOM-TLS]`, or `[DICOM-TLS (mutual)]` when `tls_ca` is set.

`tls_ca` deserves its own warning on the receiving side: setting it loads the CA
bundle **and** sets `verify_mode` to `CERT_REQUIRED`. From then on a client that
presents no certificate, or one this CA did not sign, cannot associate at all — so
adding a CA silently converts a working TLS listener into one that rejects every
modality not yet issued a client certificate. It has no effect while `tls` is off.

The paths are paths, never contents: the dashboard shows them so a typo is
fixable, and the config carries no key material. Relative paths resolve against
the config file's directory like every other path here.

**What validation covers:** the booleans, and that `tls_cert` / `tls_key` are
non-blank when `tls` is on (`scp.tls is on but tls_cert / tls_key are not set`).
Nothing more. A path that does not exist, a key that does not match its
certificate, an unreadable file, a `tls_ca` pointing at nothing — all of those
fail inside `ssl.load_cert_chain` when the listener starts: the service does not
bind, and the reason is in the Activity log on that service's channel.

With verification on at the far end, the certificate must be valid for the host or
IP the modality dials, which is why the README's generator sets a `subjectAltName`.

**`tls_ca` is in `pacs/config.py` but omitted from `config.example.json`** for the
`print`, `mwl` and `qr` blocks. All four listeners have a field for it in the
dashboard, so it round-trips through a Save.

The sending side is different in kind and is documented once under
[`scu`](#scu-tls) — client certificates, the trusted-CA bundle and the verify
flag are configured for the whole appliance, not per destination.

### Secrets, and what `GET /api/config` returns

Three values are never published by `GET /api/config`. It substitutes a read-only
boolean mirror for each — `web.auth_token_set`, `notify.webhook.secret_set`,
`notify.smtp.password_set` — which is not a config field: `POST /api/config`
strips the mirrors and **refuses** a Save that tries to send the real value. A
Save that merged a redacted document over a config that had a secret would
silently drop it, so each has its own endpoint instead. `deid.secret` is handled
the same way and is not in the defaults at all.

| secret | set it through |
| --- | --- |
| [`web.auth_token`](#webauth_token) | `POST /api/auth/token` |
| [`deid.secret`](#deidsecret) | `POST /api/deid/secret` |
| [`notify.webhook.secret`](#notifywebhooksecret) | `POST /api/notify/secret` |
| [`notify.smtp.password`](#notifysmtppassword) | `POST /api/notify/secret` |

---

## `scp`

The receiver — the "store" half of the PACS. It binds a DICOM port, accepts
C-STORE and C-ECHO, and writes what arrives to a folder on disk.

### `scp.enabled`

`boolean` · default `false`

Enrolment, not a run switch; see [above](#enabled-is-enrolment-not-a-run-switch).
`pacs serve --receive` starts the receiver for one run without writing this flag.

### `scp.aet`

`string` · default `"CARINOPACS"`

The AE title this receiver answers to — what modalities configure as the called
AE. Validation refuses it blank (`scp.aet is required`) and refuses anything over
16 characters (`AE titles must be 16 characters or fewer`), both unconditionally,
even with the receiver disabled.

Not checked: spaces and backslashes. `modalities[].aet` is refused for those
because DICOM does not permit them; `scp.aet` is not, so a stray space here is
saved without complaint and shows up later as associations that fail for no
visible reason.

### `scp.bind`

`string` · default `"0.0.0.0"` · see [`bind`](#bind)

### `scp.port`

`integer` · default `11112` · see [Ports](#ports-and-the-collision-check)

Range-checked and held against the other listeners whether or not the receiver is
enabled.

### `scp.storage_dir`

`string` (path) · default `"./received"`

Where received instances land. Created at receiver start if missing.

It is the archive root for far more than the receiver: the index rescan walks it,
the history browser's "received" group reads it, DICOMweb serves WADO/QIDO out of
it, STOW-RS writes into it through the same layout function, and the dashboard's
disk-headroom readout probes its volume. Move it and all of those follow.

Validation refuses a non-string. It does not check that the folder exists or is
writable; that surfaces as a failed C-STORE.

### `scp.organize`

`boolean` · default `true`

The on-disk layout. On, an instance is filed as
`PatientID/StudyInstanceUID/SeriesInstanceUID/SOPInstanceUID.dcm`, each component
sanitised to `[A-Za-z0-9._-]` and truncated, with fallbacks (`NOID`, `NOSTUDY`,
`NOSERIES`) when the tag is absent. Off, everything is written flat as
`SOPInstanceUID.dcm` in `storage_dir`. The same flag governs STOW-RS uploads, so
both protocols file identically.

Worth knowing before turning it off: the folder layout puts the PatientID in the
path. That is what makes a study browsable, and it is also an identifier in a
filename.

### `scp.min_free_gb`

`number` · default `2` · `0` disables the guard

The free-space floor on the storage volume. Below it the receiver refuses C-STORE
with `0xA700` (Refused: Out of Resources) *before* writing anything, logs
`Refused C-STORE — low disk space (… MB free < … MB floor)`, and counts the
refusal — a clean rejection the sender can retry once space is freed is better
than a half-written object. STOW-RS refuses on the same floor, and the
dashboard's disk card uses it to decide "low".

The guard fails **open**: if the free space cannot be read at all, the instance is
accepted. A probe error is not a reason to reject an image.

Read as `int(float(value or 0) * 1024)`, so fractional gigabytes work and any
value at or below zero switches the guard off entirely. Validation does not check
it: `"two"` is saved happily and then raises inside `start_receiver`, which leaves
the receiver unbound with the error in the log.

### `scp.allowed_aets`

`list of strings` · default `[]` · see [`allowed_aets`](#allowed_aets)

Not type-checked. The startup line says which regime is in force: `(accept: any)`
or the names.

### `scp.tls` / `scp.tls_cert` / `scp.tls_key` / `scp.tls_ca`

See [TLS on the DICOM listeners](#tls-on-the-dicom-listeners). The other half of
mutual TLS lives on the sender: [`scu.tls_cert` / `scu.tls_key`](#scu-tls).

---

## `scu`

The auto-send watcher — the "forward" half. It polls one folder, and for every
file that is stable and readable as DICOM it C-STOREs to the destinations routing
picks, tracks delivery per destination, retries what failed, and then archives or
deletes the study once it has reached everywhere it owes.

This section configures **how** the appliance sends. **Where** it sends is
[`destinations`](#destinations); **which** of them a given study goes to is
[`routing`](#routing).

The watcher never binds a port, so nothing here can collide with another service.
It also reads the live config on every pass, so an edit takes effect without a
restart — with one deliberate exception: a pass that sees the config change
underneath it abandons what is left of itself and lets the next pass re-route the
files under the settings as saved.

### `scu.enabled`

`boolean` · default `false`

Enrolment, exactly as [`scp.enabled`](#scpenabled). `pacs serve --watch` and
`pacs send` start the watcher for one run without writing the flag.

### `scu.aet`

`string` · default `"CARINOSCU"`

The **calling** AE title this appliance presents when it sends. One identity for
every outbound association: the watcher's C-STOREs, the manual Send, the
destination echo test, and the emergency health monitor's probes all use it.
Remote nodes commonly filter on it, so changing it means updating the allow-list
at every destination.

Validation refuses anything over 16 characters. It does **not** refuse blank, and
blank is not the same as absent — the code reads `scu.get("aet", "CARINOSCU")`,
and that fallback only fires when the key is missing. An empty string is passed
straight to pynetdicom, which raises `Invalid 'ae_title' value - must not be an
empty str` on every send; in the watcher that surfaces as `Watcher pass failed: …`
once per poll, forever, with nothing forwarded.

### `scu.watch_dir`

`string` (path) · default `"./outgoing"`

The outgoing folder. Everything under it is walked recursively; dotfiles are
skipped, and `sent_dir` and `pending_dir` are skipped even when they are nested
inside it, which is what makes the shipped defaults safe to keep side by side.

A file is only picked up once it is **stable** — non-zero, and the same size on
two consecutive passes — so a half-written object is never forwarded. Files are
recognised by the `DICM` marker, not by extension.

It is also where several other paths converge: emergency hold-and-forward copies
each received instance in here so the normal retry pipeline back-fills the
primary, an approved review item is converted into here, and the history browser's
"outgoing" group and DICOMweb both read from it.

Validation refuses a non-string. Nothing checks that it exists — it is created at
watcher start — and a `watch_dir` that is not a directory at scan time simply
means the pass returns having done nothing.

### `scu.poll_interval`

`number` (seconds) · default `3`

How long the watcher sleeps between passes. Polling rather than inotify, because
it behaves identically on every OS and across network shares; the cost is up to
one interval of latency, and a file needs two passes to clear the stability gate.

It has a second job that is easy to miss: it is the base for the retry backoff. A
failed destination waits `base`, then `2×`, `4×`… capped at 300 seconds, where
`base` is this value with a floor of 5 seconds. Setting a long interval therefore
slows retries as well as detection.

Validated as a number ≥ 1 (`scu.poll_interval must be a number >= 1`). The check
is `float()`, so the string `"2"` is accepted and works; `"fast"` is refused. The
loop itself also floors the wait at 1 second.

### `scu.on_success`

`string` · default `"keep"` · one of `keep` | `move` | `delete`

What happens to a study once **every** DICOM file in it has been accepted by every
destination it was routed to.

- **`keep`** — nothing happens. Files stay in the outgoing folder, and the archive
  pass returns immediately without listing anything.
- **`move`** — the whole top-level item is moved to `sent_dir`, preserving its path
  relative to `watch_dir`. Everything goes: subfolders, non-DICOM files, the lot,
  so no empty directories are left behind. Name collisions are de-duplicated
  (`study_1`, `study_2`), and the index is re-filed under the path the file
  actually landed on.
- **`delete`** — the whole item is removed.

Validated: `scu.on_success must be keep|move|delete`. Anything else is refused at
save time, and any value other than `move` or `delete` behaves as `keep` at
runtime — so a hand-edited config that bypasses validation degrades to `keep`
rather than erroring.

`delete` is the one setting in this section that can lose images, so the gate in
front of it is deliberately four separate conditions, each of which is a study
that would otherwise be destroyed having reached fewer nodes than the operator
believes: the file must have been routed by *this* pass against the live
destination list; its size and mtime must still match what the delivery was
recorded against; the set of destinations it owes must be non-empty (a study whose
every destination was renamed away reached nobody, and bare set logic reads that
as "delivered to everybody"); and nothing may have dropped out of its route
unsent. On top of that, a destination name that now resolves to a different host,
port or called AE is un-marked and owed the study again, and the archive pass
refuses to act at all if the config changed while the pass was running. A study
that fails any of these stays in the outgoing folder and says so in the stuck
panel.

### `scu.sent_dir`

`string` (path) · default `"./sent"`

The archive folder, used only when `on_success` is `move` — with `keep` or
`delete` it is never touched. It is excluded from the watcher's scan and from the
archive pass even when nested under `watch_dir`, so an archived study is not
re-forwarded.

It is also the history browser's "sent" / "archived" group and one of the roots
DICOMweb serves from, so studies stay queryable after they are filed.

Validation refuses a non-string and nothing more. Pointing it at a volume with no
space, or at the same path as `watch_dir`, is not caught here.

### `scu.pending_dir`

`string` (path) · default `"./pending"`

The review queue for files that are **not** DICOM. It is part of the send pipeline
rather than a separate feature: when a study is archived, any PDF or image sitting
beside it is siphoned into this folder first, pre-filled with the patient and study
identity read from a sibling DICOM header, so the archive or delete only ever
handles DICOM and inert files. Captured print jobs land here too, because a print
carries no trustworthy identity and an operator has to confirm it. An item is only
converted and dropped into `watch_dir` when somebody approves it.

Like `sent_dir`, it is excluded from the scan and from the archive pass even when
nested under `watch_dir`.

Setting it to `""` is accepted by validation and quietly disables the siphon —
reports beside a study are then archived or deleted with it, never queued. It also
breaks print capture, which fails the job with a processing failure and logs
`Failed to render print job…`, because there is no folder to stage into.

<a id="scu-tls"></a>

### `scu.tls_verify`

`boolean` · default `true`

Whether to verify the certificate a remote node presents. On, the certificate is
checked against `scu.tls_ca` if one is set and against the system trust store
otherwise, and it must be valid for the host or IP being dialled. Off, hostname
checking is disabled and `verify_mode` becomes `CERT_NONE` — the link is encrypted
but the peer is unauthenticated, which is fine for a self-signed test rig and is
not access control.

When verification is off, `tls_ca` is ignored entirely; a client certificate, if
configured, is still presented.

The quoted-`"false"` trap matters more here than most: `"false"` reads as TRUE, so
the quoted version turns verification **on**, not off.

### `scu.tls_ca`

`string` (path) · default `""` (system trust store)

The CA bundle used to verify the **remote** node's certificate. This is the mirror
image of `scp.tls_ca` and does the opposite job — on a listener a CA means
"require and verify client certificates"; here it means "this is who I trust to
have signed the server certificate I am about to check". Leave it blank and the
system trust store is used, which is what you want for a publicly-signed peer and
not what you want for a hospital's internal CA.

Validation refuses a non-string. A path that does not exist raises when the context
is built; see [what happens when the context will not
build](#when-the-client-tls-context-will-not-build).

### `scu.tls_cert` / `scu.tls_key`

`string` (path) · default `""` for both

**Our** client certificate and key, presented to nodes that ask for one. This is
the sending half of mutual TLS. Unlike a listener's pair these are optional and
are not validated together: setting only `tls_cert` is accepted, and the key is
then expected to be inside the certificate file — `load_cert_chain` is called with
`keyfile=None`. If it is not there, the context fails to build.

**Mutual TLS, end to end**, since it is spread across two sections. The receiving
appliance needs `scp.tls` on, `scp.tls_cert` / `scp.tls_key` for its own identity,
and `scp.tls_ca` set to the CA that signed the client certificates. The sending
appliance needs `scu.tls_cert` / `scu.tls_key` holding a certificate that CA
signed, and `tls: true` on each destination that should be dialled over TLS. Both
halves are required; either one alone gets you ordinary one-way TLS at best.

**One context for the whole appliance.** These four `scu.tls_*` keys build a single
client context, shared by every destination in a pass and by an outbound C-MOVE
store. There is no per-destination CA, client certificate or verify flag —
[`destinations[].tls`](#destinationstls) only decides *whether* a node is dialled
over TLS, never *how*.

<a id="when-the-client-tls-context-will-not-build"></a>

**When the client TLS context will not build**, the two send paths differ, and the
difference is worth knowing. The manual Send refuses outright and returns
`TLS config error: …`. The watcher logs `TLS config error — sends to TLS nodes will
fail` and carries on with no context, which means the association is then opened
**without TLS**. Against a TLS listener that fails, loudly, which is the normal
outcome. Against a node that also accepts plaintext on that port, the study leaves
unencrypted. A bad `tls_ca` path is enough to reach this state, and nothing refuses
it at save time.

---

## `print`

The virtual film printer. Some modalities can only *print* — they never do a
C-STORE — so this service pretends to be their laser imager, reassembles each film
sheet from the image boxes the modality sends, and stages the render in the review
queue at [`scu.pending_dir`](#scupending_dir). A film carries burned-in pixels, not
a structured PatientID, so captured film is never auto-forwarded: an operator
identifies and approves it, and only then is it converted to DICOM.

The section is called `print` in the file. In the code it is reached as
`cfg.printer`, because `print` is a builtin — grepping for `cfg.print` finds
nothing.

### `print.enabled`

`boolean` · default `false` · see [enrolment](#enabled-is-enrolment-not-a-run-switch)

`pacs print` and `pacs serve --print` start the printer for one run without
writing the flag.

### `print.aet`

`string` · default `"CARINOPRINT"`

The called AE title this listener answers to; the modality's printer entry has to
carry exactly this. Refused above 16 characters (`print.aet must be 16 characters
or fewer`). An empty AE title is **not** refused here, unlike
[`scp.aet`](#scpaet), so a blank one saves and then goes to pynetdicom as an empty
called AE.

### `print.bind`

`string` · default `"0.0.0.0"` · see [`bind`](#bind)

### `print.port`

`integer` · default `11113` · see [Ports](#ports-and-the-collision-check)

### `print.color`

`boolean` · default `false`

Adds Basic Color Print Management to the advertised contexts alongside grayscale.
Leave it off and a colour-only print SCU cannot negotiate at all. Turning it on
changes nothing about grayscale jobs: whether a film box is treated as colour is
decided by which meta context it arrived on, not by this flag.

### `print.layout`

`string` · default `"pdf"`

How a captured film is stored. `"pdf"` renders the whole print as one document,
one page per film sheet, staged with kind `pdf` and converted to Encapsulated PDF
on approval. Anything that lowercases to `"image"`, `"secondary_capture"` or
`"sc"` selects one PNG per film sheet, staged with kind `image` and converted to
Secondary Capture on approval; the runtime treats those three as synonyms. Every
other value silently falls back to PDF at runtime — but a save cannot get one past
validation, which accepts exactly those four spellings and reports the two that
matter: `print.layout must be 'pdf' or 'image'`. Neither
`config.example.json` nor the README mentions the two extra spellings.

### `print.allowed_aets`

`list of strings` · default `[]` · see [`allowed_aets`](#allowed_aets)

Not type-checked.

### `print.tls` / `print.tls_cert` / `print.tls_key` / `print.tls_ca`

See [TLS on the DICOM listeners](#tls-on-the-dicom-listeners). `print.tls_ca` is in
`pacs/config.py` but absent from `config.example.json`.

---

## `mwl`

The Modality Worklist provider. A modality cannot be pushed an order — it queries
(C-FIND) and pulls — so this service answers `ModalityWorklistInformationFind` out
of the shared order store, one worklist item per *open* order. The orders
themselves are the [`ris`](#ris) section's business; everything here is about how
they are served.

Nothing in this section tunes matching. Matching is deliberately lenient in
`pacs/mwl.py` and not configurable: an order that leaves a field blank matches any
queried value for it, so an untargeted order appears on every modality's worklist.
Target one station by setting the order's station AE, not by editing config.

### `mwl.enabled`

`boolean` · default `false`

Unlike every other service flag, this is not the only thing that starts the
worklist. It also runs whenever any *enabled* destination carries
[`no_ris: true`](#destinationsno_ris) — that PACS has no RIS, so this appliance is
its worklist source permanently. `worklist_wanted()` returns true if either holds,
and it is `worklist_wanted()`, not this flag, that the service sync acts on. The
consequence worth knowing: with such a destination configured, `mwl.enabled: false`
will not keep the worklist down, and an enforcing save will restart it. Clear the
destination's flag too.

### `mwl.aet`

`string` · default `"CARINOMWL"`

Called AE title. Refused above 16 characters. Empty is not refused.

### `mwl.bind`

`string` · default `"0.0.0.0"` · see [`bind`](#bind)

### `mwl.port`

`integer` · default `11114` · see [Ports](#ports-and-the-collision-check)

### `mwl.allowed_aets`

`list of strings` · default `[]` · see [`allowed_aets`](#allowed_aets)

Not type-checked. This is the only access control on the worklist port, and the
port carries patient names, accession numbers and birth dates in the clear unless
TLS is on.

### `mwl.tls` / `mwl.tls_cert` / `mwl.tls_key` / `mwl.tls_ca`

See [TLS on the DICOM listeners](#tls-on-the-dicom-listeners). `mwl.tls_ca` is in
`pacs/config.py` but absent from `config.example.json`.

---

## `worklist_source`

`object` · absent from `config.example.json`

The **other** worklist provider — the hospital's real RIS or its broker. Not a
service this appliance runs: an address it asks, on demand, when somebody is
diagnosing a modality that is not seeing its schedule. The worklist probe borrows a
registered modality's AE title as the calling AE, asks this provider the question
that modality would ask, and files what came back into `caught.json` in
[`ris.store_dir`](#risstore_dir). One provider for the whole appliance.

| key | type | default |
| --- | --- | --- |
| `host` | string | `""` |
| `port` | integer | `105` |
| `aet` | string | `""` |
| `tls` | boolean | `false` |

With `host` or `aet` blank the probe declines rather than guessing: *No worklist
source configured. Set the other RIS's host, port and AE title in Settings first.*
The AE title to ask *as* must be one of the registered
[`modalities`](#modalities) — the probe refuses an AE title nobody chose. When
`tls` is on, the probe dials over the shared
[client TLS context](#scu-tls).

Validation refuses a non-object section, a `port` outside 1..65535, an `aet` over
16 characters and a non-boolean `tls`. It does not check `host`.

Nothing about the probe itself is configurable. One run asks a fixed set of
progressively-widened questions — station and date and modality, then the same
without the modality, without the date, without the station — and the number of
past rounds kept in `caught.json` is a constant in the code, not a config key.

---

## `ris`

The HL7/MLLP order intake, and the settings that decide how a stored study is
matched back to the order it was performed for.

Two things are worth knowing before the keys. First, this section configures the
**listener**, not the orders: the order store is opened when the process starts
whatever `ris.enabled` says, so hand-keyed orders, the Modality Worklist and
study↔order reconciliation all work with the HL7 listener switched off. Second,
the listener has no TLS and no credential of any kind — it is a TCP socket with
MLLP framing, and `allowed_hosts` is a peer-address check, which is spoofable.
Anyone who can open a connection to that port can inject orders that appear on a
modality's worklist.

### `ris.enabled`

`boolean` · default `false` · see [enrolment](#enabled-is-enrolment-not-a-run-switch)

`pacs serve --ris` and `pacs ris` start the listener for one run without touching
this key.

The listener accepts `ORM`, `OMG` and `OMI` messages and files them as orders;
anything else is acknowledged and ignored so the sender is not left hanging. That
set is fixed in the code — there is no config key for it.

### `ris.bind`

`string` · default `"0.0.0.0"`

The local address the MLLP listener binds. `0.0.0.0` is every interface, which is
what makes the warning above concrete: on a flat network that is order injection
available to the whole site. Bind it to the one interface facing the RIS segment,
and firewall it. Otherwise as [`bind`](#bind) — the failed bind is an `OSError`
logged on the `ris` channel.

### `ris.port`

`integer` · default `2575`

The TCP port for HL7 over MLLP. 2575 is the IANA-registered one and is deliberately
away from the DICOM ports. Range-checked and part of the [collision
check](#ports-and-the-collision-check); a quoted `"2575"` is a string and is
rejected on that basis rather than coerced.

### `ris.store_dir`

`string` (path) · default `"./ris"`

Where the order store lives. Two files are written here: `orders.json`, which holds
open *and* closed orders — closed ones are kept, because "the study arrived and the
order was closed" is the audit trail — and `caught.json`, the bounded log of
worklist-probe rounds.

The store is read once at startup and rewritten in full on every change. A path
that cannot be *read* loses nothing and starts empty: the load swallows the error,
and an operator who mistypes this key sees an Orders panel that is simply blank
rather than an error. A path that cannot be *written* is the harmful one — the
failure raises out of whatever action tried to change an order.

Changing this key on a running appliance re-points the live order store, but does
not move `orders.json`: the orders already in memory are written to the new folder
on the next change, and the old file stays where it is. The worklist-probe store is
not re-pointed at all — it keeps writing `caught.json` to the folder it was built
with until the process restarts.

Validation only checks that it is a string. Nothing checks that it is writable.

### `ris.match_on`

`string` · default `"accession"` · one of `accession` | `accession_or_patient`

Which keys reconcile an incoming study to an open order.

- `"accession"` — Study Instance UID first, then Accession Number.
- `"accession_or_patient"` — Study Instance UID, then Accession Number, then
  Patient ID.

Study Instance UID is always tried first regardless of this key, and it is the one
exact match: Carino generates the UID when the order is created, the modality burns
it into the exam via the worklist, and a capture wrapped from the order inherits
it. Accession Number is the fallback for the emergency case this feature exists for
— the technologist typed it into the modality by hand.

`accession_or_patient` exists for the case where the tech typed nothing at all, and
it is the setting to be careful with. Patient ID is not unique to an exam. A
patient with more than one open order matches all of them, the first hit wins, and
with `auto_close` on that closes an arbitrary one of the two and leaves the other
open — the study is reconciled to the wrong order, and nothing about the panel says
so. Leave it on `accession` unless the department has accepted that trade.

Nothing is ever gated on a match. A study with no matching order is stored and
forwarded exactly as it would have been; the order stays open for manual
reconciliation.

Validation refuses any other value with `ris.match_on must be 'accession' or
'accession_or_patient'`. An unrecognised value in a hand-edited file falls back to
`"accession"` silently — the narrower of the two, which is the right way round.

### `ris.auto_close`

`boolean` · default `true`

Whether a matched order is closed and archived automatically when its study
arrives. Off, the match still happens and is still logged (*RIS order matched (left
open — auto-close off)*), and the order stays on the open list — which is also the
list the Modality Worklist serves, so the exam keeps appearing on the modality's
schedule after it has been performed. Turn it off only if somebody is closing
orders by hand.

### `ris.allowed_hosts`

`list of strings` · default `[]` (any host)

Source addresses permitted to send HL7. A non-empty list is compared against the
peer's IP address exactly: no CIDR ranges, no hostnames, no wildcards. The listener
is IPv4, so an IPv6 literal here never matches anything.

The failure mode of getting this wrong is total rather than partial — a list that
does not contain the RIS's actual source address refuses every connection, logs
`RIS: refused connection from <peer> (not allowed)`, and the RIS reports a dead
endpoint. Check the log for the address it actually connected from rather than the
one it is supposed to have. The same is true of a list whose entries are not
strings: an entry that arrives as a number can never equal the peer string, so the
list is non-empty and matches nobody.

Validation checks the list itself (`ris.allowed_hosts must be a list`) but not its
entries.

---

## `qr`

Query/Retrieve — C-FIND, C-MOVE and C-GET at PATIENT, STUDY, SERIES and IMAGE
level. This is the half of a PACS that old equipment can talk to. Every query and
every retrieve is answered out of the sqlite instance index, never by walking the
disk, so the Q/R results and the dashboard's own study list cannot drift apart.

Two things this section does not carry, and both matter. There is **no
de-identification on the retrieval path** — a node allowed to C-MOVE gets the
stored bytes, identifiers intact, no matter what [`deid.profile`](#deidprofile) or
a routing rule says about that same node. And `qr.allowed_aets` is the only access
control on the port.

### `qr.enabled`

`boolean` · default `false` · see [enrolment](#enabled-is-enrolment-not-a-run-switch)

Enabling it is not sufficient: `start_qr` refuses outright when the index is
unavailable — `Query/Retrieve needs the instance index — enable index.enabled` —
because binding the port without one would advertise an archive that reports itself
empty to every modality that asks. Config validation does **not** catch
`qr.enabled: true` alongside `index.enabled: false`; the save succeeds and the
failure appears on the `qr` channel at start.

### `qr.aet`

`string` · default `"CARINOQR"`

Called AE title. Refused above 16 characters. Empty is not refused.

### `qr.bind`

`string` · default `"0.0.0.0"` · see [`bind`](#bind)

### `qr.port`

`integer` · default `11115` · see [Ports](#ports-and-the-collision-check)

### `qr.allowed_aets`

`list of strings` · default `[]` · see [`allowed_aets`](#allowed_aets)

The one that **is** type-checked: `qr.allowed_aets must be a list`.

### `qr.move_destinations`

`object` · default `{}`

The C-MOVE phone book, and the reason it has to exist: a C-MOVE request names its
Move Destination by **AE title and nothing else**. There is no host and no port
anywhere on the wire. The SCU says "send it to WORKSTATION1" and the SCP is
expected to already know where WORKSTATION1 is. This map is that knowledge.

```json
"move_destinations": {
  "WORKSTATION1": { "host": "10.0.0.42", "port": 104, "aet": "WORKSTATION1" }
}
```

The key is the Move Destination as it appears on the wire; it is looked up exactly
first, then case-insensitively. `host` and `port` are where the outbound C-STORE
association is opened. `aet` is the called AE title used on that association —
normally the same as the key, but they can differ when a workstation announces
itself with one title and answers to another; if `aet` is empty the requested Move
Destination is used.

Each entry also accepts an optional **`tls`** boolean, absent from
`config.example.json` and not validated. When true, the outbound store association
uses the [SCU-side TLS context](#scu-tls) — the same verify flag, CA and client
certificate an auto-forward uses — so a C-MOVE cannot end up with different trust
settings than a forward to the same node.

If the AE title is not in this map, the ordinary enabled
[`destinations`](#destinations) list is searched by `aet`, so a node already
configured and echo-tested under Destinations does not have to be typed twice. If
neither has it, the move is refused with *Move Destination unknown* and the log
names the AE title and lists the ones it does know (`none configured` when the map
is empty). No host is ever guessed.

Validation refuses, in this order: a non-object map — `qr.move_destinations must be
an object of AE title -> {host, port, aet}`; a non-object entry —
`qr.move_destinations['WORKSTATION1'] must be an object with host / port / aet`; a
missing field — `… missing 'host'`; a port that is not an integer in range — `… has
an invalid port`; and an AE title over 16 characters — `… AE title too long`. What
it does not check is the *content* of `host`: presence is enough, so `"host": ""`
saves cleanly and then fails at resolve time — the entry is skipped, the
destinations list is tried instead, and the C-MOVE is refused if that misses too.

The dashboard has no editor for this map. It is carried through a Save untouched,
and the Q/R fieldset only prints which AE titles it currently resolves. Edit
`config.json` by hand.

### `qr.tls` / `qr.tls_cert` / `qr.tls_key` / `qr.tls_ca`

See [TLS on the DICOM listeners](#tls-on-the-dicom-listeners). This covers the
listening side only; whether an outbound C-MOVE uses TLS is decided by the
destination entry's `tls`. `qr.tls_ca` is in `pacs/config.py` but absent from
`config.example.json`.

---

## `dicomweb`

QIDO-RS, WADO-RS and STOW-RS under `/dicom-web`, for viewers that speak HTTP and
never negotiate an association. This is not a listener of its own: it is a
blueprint on the dashboard's port, so [`web.host`](#webhost),
[`web.port`](#webport) and [`web.auth_token`](#webauth_token) decide who can reach
it and whether a credential is needed. That is why the section has no `bind`,
`port`, `aet` or TLS keys, and why it takes no part in the collision check.

Like Q/R, it answers out of the index and serves stored bytes unscrubbed — there is
no de-identification on the retrieval path.

### `dicomweb.enabled`

`boolean` · default `false`

The blueprint is registered unconditionally and gated per request, so ticking this
takes effect immediately with no engine restart. While off, every request except
`OPTIONS` answers `503` with `DICOMweb is disabled (config: dicomweb.enabled)`;
CORS preflights are still answered so a viewer gets a comprehensible failure rather
than a hang. A second `503` — `the instance index is not available` — is what you
get when the index is off, for the same reason Q/R refuses to start without one.

### `dicomweb.allow_stow`

`boolean` · default `true`

Turn it off for a read-only deployment: `POST /dicom-web/studies` then answers
`403` with `STOW-RS is disabled (config: dicomweb.allow_stow)` while QIDO and WADO
carry on unaffected. The ceiling on a STOW body is a constant in
`pacs/dicomweb.py`, not a config key — there is no setting for it.

### `dicomweb.cors_origins`

`list of strings` · default `[]`

Browser origins allowed to call `/dicom-web` cross-site. Matching is exact string
equality against the browser's `Origin` header — scheme, host and optional port, no
trailing slash, no path, no pattern syntax of any kind. Empty means no CORS headers
are emitted at all, which is what a same-origin viewer and every non-browser client
want. A literal `"*"` in the list is honoured, and only because someone typed it:
from then on every origin is reflected back and any page the operator has open can
read the archive off this machine. Name the viewer instead.

This list carries more weight than a CORS setting usually does, because
`/dicom-web` is exempt from the `X-Carino` write-header guard that protects the
rest of the API — a conforming DICOMweb client cannot send that header and STOW
would be dead on arrival. What stops a cross-site STOW instead is the preflight,
and the preflight is answered only for the origins in this list.

Validation refuses a non-list, and a list holding anything that is not a string:
`dicomweb.cors_origins must be a list of origin strings like
"https://viewer.example" (scheme + host, no path)`. It does **not** check the shape
of the strings. `"https://viewer.example/"` with its trailing slash, or
`"viewer.example"` with no scheme, saves without complaint and then matches nothing
— the viewer fails to load studies and neither the log nor the browser explains
why. When a viewer is being refused, compare the value here against the `Origin`
header the browser actually sends, character for character.

---

## `index`

A local sqlite cache holding one row per stored *file*, from which patient, study
and series answers are aggregated — so a study summary can never drift out of step
with the instances it summarises. It is the query layer behind Query/Retrieve and
DICOMweb, and it is the only thing in the appliance that starts on its own, because
it binds nothing.

The index is a cache, never the source of truth. Every row points at a file that is
still on disk, and losing the database costs a rescan, never an image. It covers
three trees: the receiver's [`scp.storage_dir`](#scpstorage_dir) (group `received`),
[`scu.sent_dir`](#scusent_dir) (`sent`) and [`scu.watch_dir`](#scuwatch_dir)
(`outgoing`).

Validation checks only that the section is an object — `'index' must be an object`.
The per-key type checks below come from the generic boolean and string checks.

### `index.enabled`

`boolean` · default `true` — the one service default that is on

Off means there is no index object at all, and both query services lose their only
data source. Query/Retrieve refuses to start rather than binding a port that would
advertise an empty archive to every modality that asks. Every DICOMweb request
answers `503 the instance index is not available` (an `OPTIONS` preflight is still
answered). Receiving and forwarding are unaffected — the receiver simply has
nowhere to hand its rows.

Switching it on from the dashboard builds a fresh index and kicks a rescan
immediately, without waiting for a restart, because a new database knows nothing
about what is already on disk and an empty index is a PACS that reports itself
empty.

### `index.path`

`string` (path) · default `"./index.db"`

Where the sqlite database lives — beside `config.json` on a default install.

Set it to `""` and you get an in-memory index: the resolver returns an empty string
and the server substitutes `:memory:`. That works, and it silently discards the
whole index on every restart, so each start pays a full rescan and any window with
`rescan_on_start` off is a window where queries answer empty. Validation does not
refuse this, unlike the equivalent case for [`audit.dir`](#auditdir).

Changing the path from the dashboard stops the old index, opens the new one and
starts a rescan; the path is fixed at construction, so a change always means a new
database object.

### `index.rescan_on_start`

`boolean` · default `true`

One reconciliation walk of the three storage roots when the index comes up, on its
own thread so a cold archive taking minutes blocks nothing. It is what finds files
that were added behind the gateway's back — copied in by hand, or stored while the
service was down — and it prunes rows whose files are gone.

Turn it off and the index still records everything that arrives from now on, but it
starts out believing whatever it believed when it was last written. On a fresh or
rebuilt database that means Query/Retrieve and DICOMweb report an archive that is
on disk as empty. The dashboard's rescan button (`POST /api/index/rescan`) is the
manual equivalent, and it returns immediately with the result landing in the
Activity log under `kind=index`.

A schema-version bump rebuilds the table from scratch on the next open — the index
holds nothing that is not re-derivable from the files, so a migration would be more
code than a rebuild — and the log then says a rescan is needed. With this flag off,
nobody performs it.

---

## `routing`

Conditional routing decides *which* destinations a study goes to. It is the
decision half only: `pacs/routing.py` never opens a socket, never writes a file and
never touches config. One rule outranks everything else in it — **a study must
never end up going nowhere** — so every path that fails to produce a destination
(routing off, no rules, no rule matched, an unreadable header, a rule naming a
destination that no longer exists) falls back to every enabled destination, which
is exactly what the gateway did before rules existed. The single deliberate
exception is a de-identification hold; see [`deid`](#deid).

The router is re-pointed at the live config on every watcher pass, so an edit takes
effect on the next poll. Nothing needs restarting.

### `routing.enabled`

`boolean` · default `false`

The master switch. With it off the rules are not evaluated at all and every stable
file fans out to every enabled destination; the decision records the reason as
"routing disabled". Nothing is ever held while routing is off, because a hold can
only come from a rule.

Turning it on with an empty `rules` list changes nothing — the engine reports "no
rules configured" and falls back the same way.

### `routing.rules`

`list of objects` · default `[]`

This differs from `config.example.json`, which ships one worked rule to show the
shape. That example rule sends to `"Example PACS"`, and the example's
`destinations` entry of that name has `"enabled": false` — so the shipped file,
even with routing switched on, has a rule that resolves to nothing and drops
through. That is deliberate for a file meant to be edited, and it is worth knowing
before you conclude the engine is broken.

Rules are evaluated in list order and the results are unioned: a study can be
picked up by several rules, and every destination any of them named is sent to.
Order matters for `stop` and nothing else — the destination list a decision reports
is ordered by the `destinations` array, not by rule order, so two studies that end
at the same nodes always report the same route string.

Validation checks the shape of the list and of each rule, and nothing about whether
the rules make sense together:

- `routing.rules must be a list`
- `routing rule #N must be an object`
- `routing rule #N needs a 'name'` — a rule with no `name`, or a blank one, is
  refused; the number is given because there is no name to identify it by.
- `routing rule 'X' has an invalid 'match' (must be an object)`
- `routing rule 'X' destinations must be a list of destination names`

At runtime the router additionally skips any list entry that is not an object, so a
hand-edited file with a stray string in `rules` degrades rather than crashing.

### The rule object

Every field below is read straight off the rule dict, with the default that
`.get()` supplies. None of them are filled in by the config merge — the merge does
not descend into lists — and neither the boolean nor the string check can reach
inside one.

**`name`** — string, no default (validation requires it). It is what the log, the
"Explain route" trace and the decision's `rules` list call this rule. Purely a
label; it is not matched against anything.

**`match`** — object, default `{}` (matches every study). Every key inside is
optional, and an absent or empty value matches anything. Values are case-insensitive
`fnmatch` globs, or a list of globs meaning "any of these". Within one rule the
fields are ANDed: all of them have to hit.

| key | DICOM source |
| --- | --- |
| `modality` | `Modality` |
| `calling_aet` | file-meta `SourceApplicationEntityTitle`, overridden by the true calling AE from the association when the receiver knows it |
| `station` | `StationName` |
| `patient_id` | `PatientID` |
| `study_desc` | `StudyDescription` |

Four spellings are accepted as aliases so a rule written from memory works:
`source_aet` and `calling_ae` for `calling_aet`, `station_name` for `station`,
`study_description` for `study_desc`. Keys beginning with `_` are ignored, which is
what makes a `_comment` inside `match` safe.

Anything else in `match` is a typo, and a typo is made visible rather than
tolerated: the rule is **skipped entirely** — not treated as "matches anything",
because a typo must not silently widen a rule to every study in the department. The
skip is recorded in the trace as `skipped (unknown match key: ...)`, listed under
`unresolved`, and the Routing tab prints *Unknown match field … — the engine skips
this rule entirely* on the rule itself.

**`destinations`** — list of destination *names*, default `[]`. Names, not inline
peers: each string has to equal the `name` of an entry in the top-level
[`destinations`](#destinations) array, and that entry has to be enabled. Names that
do not resolve are dropped and reported as `unresolved`, and the log says *Routing
rule X -> Y names a destination that does not exist or is disabled — that rule
cannot deliver anything.*

Two cases fall through to the next rule instead of consuming the study, and both
ignore `stop`, because honouring it would mean "match this study and send it
nowhere":

- an empty list — a matched rule with no destinations is a **filter**, not a sink;
- a list where none of the named destinations is currently enabled.

**This is the key to spell correctly, and the reason is that nothing will tell you
if you don't.** The spelling is `destinations`, plural. Config validation checks the
shape of the key it knows and ignores keys it does not, so `"destination"` or
`"dests"` saves clean and loads clean, and the rule then evaluates with an empty
destination list — which the engine reads as a filter, so it drops through to the
next rule and finally to the all-destinations fallback. The install comes up looking
nearly right: studies arrive, the Routing tab lists every rule, each rule reads as
configured, and the Stuck tab is empty — not because holds are working but because
nothing was ever routed anywhere in particular. This is *not* how a misspelled key
inside `match` behaves: that one names itself in the trace and skips the rule. Check
this key before you check anything else. Opening the Routing tab does not repair it
either — the tab renders ticked destinations from `destinations` only, so the
misspelled key survives the save untouched and an empty `destinations` is written
beside it.

**`deidentify`** — flag, default falsy. Says that the destinations this rule
resolved to get a **scrubbed** copy. The union is taken in the safe direction: if
any rule routing to a node asked for scrubbing, that node is scrubbed for, and
another rule routing to the same node without `deidentify` does not buy it an
identified copy.

It is only half of the decision. The other half is [`deid.profile`](#deidprofile),
and when the two contradict each other the destination is **held** — read
[`deid`](#deid) before setting this.

Set it badly and it fails open in the wrong direction: `deidentify` is read as a
plain truthiness test, and because `rules` is a list the boolean check cannot reach
inside it. `"deidentify": "false"` is a non-empty string, which reads as **true**,
and there is no error anywhere. The same is true of `"stop"`.

**`stop`** — flag, default falsy. Ends rule evaluation: rules after this one are not
looked at, and the trace marks them *not evaluated (a previous rule stopped)*. It is
honoured only on a rule that actually contributed destinations — a matched rule that
dropped through (no destinations, or none enabled) does not stop anything.

---

## `deid`

De-identification is applied to the copy that **leaves**. The archived original is
never rewritten; that asymmetry is the point of the module. The profile does not
touch pixels — burned-in demographics survive every setting here — and narrative
text inside Structured Reports is not read for identifiers. Nor is anything scrubbed
on the retrieval path: see [`qr`](#qr) and [`dicomweb`](#dicomweb).

Every generated value is HMAC-derived from a site key, so the same `PatientID` maps
to the same pseudonym across restarts and reinstalls with no lookup table to keep or
lose, and re-sending a study overwrites the recipient's copy instead of growing a
duplicate.

### `deid.profile`

`string` · default `"basic"` · one of `basic` | `strict` | `off`

Decides whether scrubbing happens at all; a routing rule's `deidentify` decides
which destinations get the scrubbed copy. `off` means no de-identifier is built at
all — `Deidentifier.from_config` returns `None` — so the sender installs no
transform and pays nothing.

`basic` is the PS3.15 Annex E Basic Application Level Confidentiality Profile plus
the standard Retain options for temporal information, patient characteristics,
device identity and institution identity, each declared in `(0012,0064)` so the
recipient can read exactly what was kept. `strict` is the same profile with device
and institution identity dropped, and private attributes removed regardless of
`keep_private`.

Setting it to `off` while a routing rule still asks for a scrub does not forward
identified copies — it [**holds**](#held-not-sent--the-two-causes) those
destinations.

Validation refuses anything else: `deid.profile must be 'basic', 'strict' or 'off'`.

### `deid.keep_private`

`boolean` · default `false`

Forwards private attributes unvetted. Private tags routinely carry the patient's
name, so this defeats the confidentiality profile, and the object says so rather
than lying about it: an object produced with `keep_private` carries neither the
`113100` Basic Profile code nor `PatientIdentityRemoved=YES`. It is marked
`PatientIdentityRemoved=NO`, with `PRIVATE ATTRIBUTES RETAINED UNVETTED` in
`DeidentificationMethod`. The coded evidence has to be a true statement about what
was done. There is no honest substitute code — `113111` Retain Safe Private is for
attributes that were *vetted* as safe, and these were not vetted at all.

Under `strict` the flag loses and private attributes are removed anyway; the
de-identifier logs *keep_private ignored under the 'strict' profile* rather than
honouring it quietly. It also warns on construction whenever the flag is on and the
profile is not off.

### `deid.keep_dates`

`boolean` · default `false`

`false` shifts dates rather than blanking them: a whole number of days into the
past, derived per patient, so every interval in the study survives to the second and
clock times land on themselves. The object is coded `113107` Retain Longitudinal
Temporal Information Modified Dates, `LongitudinalTemporalInformationModified=
MODIFIED`, and `DATES SHIFTED WHOLE DAYS PER PATIENT; CLOCK TIMES KEPT` is written
into `DeidentificationMethod` — because a recipient who assumed the clock had moved
too would mis-judge how much re-identification risk is left in the object.

`true` forwards study, series and acquisition dates unshifted and codes `113106`
Full Dates with `LongitudinalTemporalInformationModified=UNMODIFIED`. Real dates
narrow a patient down; keep them only where the recipient is entitled to them.

Date and time values that cannot be parsed are blanked rather than forwarded
unshifted, and the count is logged once per study.

### `deid.prefix`

`string` · default `"ANON"` (an empty string also falls back to `ANON`)

The stem of every generated identity. Both `PatientID` and `PatientName` become the
prefix followed by twelve hex characters of a keyed digest — the same value in
both, because Table E.1-1's zero-length `PatientName` breaks most viewers and makes
a pseudonymised study impossible to group by eye, and the name carries no
information the ID does not.

A non-string here was the measured failure that put the string check into
validation: `POST /api/config` with a JSON number answered 200 and persisted it, and
`Deidentifier.__init__` then died on `(5 or "ANON").strip()` partway through the
first forward that needed a scrub. Validation now refuses it: `deid.prefix must be a
string, not int (5). It is read as text — a number or true/false raises inside the
service that uses it, long after this save was accepted. Quote it, or leave it out
for the default.`

### `deid.secret`

`string` · **default: no site key**

Deliberately absent from both `config.example.json` and the defaults in
`pacs/config.py` — an absent key means "no site key", and writing `""` into the file
is not the same statement, so nothing ever writes an empty one.

The key every pseudonym and every date offset is derived from. With no secret the
mapping is a pure function of the input, which means anyone who can guess a
`PatientID` can confirm that patient is present in your anonymised set. Set one for
anything leaving the building.

Changing it re-pseudonymises everything from that moment on, and the studies you
have already exported stop lining up with the ones that follow. That is why there is
no "rotate" button.

It cannot be set through `POST /api/config`; see
[Secrets](#secrets-and-what-get-apiconfig-returns). A Save that offers a
`deid.secret` different from the stored one is refused with `deid.secret cannot be
set from here — it is redacted from GET /api/config so a Save has nothing to send
back, and changing it re-pseudonymises every future export. Use POST
/api/deid/secret.` That endpoint requires the `deid.manage` capability *and* the
dashboard token itself (a session cookie is not enough to read, replace or discard
the key), and refuses a key shorter than twelve characters — it is attacked offline
against a known Patient ID, not guessed over the network.

Validation refuses a non-string outright, because the value is fed straight into
HMAC and would otherwise raise inside the sender halfway through a forward:
`deid.secret must be a string. It is the site key every pseudonym is derived from —
use "" for none, or a real one: python3 -c "import secrets;
print(secrets.token_urlsafe(32))"`.

### Held, not sent — the two causes

A rule's `deidentify` says which destinations get a scrubbed copy; these settings
say whether a scrub can be performed. When a rule asks for one that cannot happen,
the destination is **not sent to at all**. It is held, not forwarded identified — a
promise to deliver is not a permission to disclose, and a name that has arrived at an
outside node is not recoverable by any later edit.

Nothing is lost by it. The study stays in the outgoing folder, is never archived and
never deleted; every *other* destination on the same study still receives it; the log
raises an error on both the route and the send channels naming what is withheld and
why; the Stuck tab counts it and prints the remedy.

There are two causes, they are reported apart as `hold_cause`, and they need
different fixes:

| `hold_cause` | What is wrong | What releases it |
| --- | --- | --- |
| `profile-off` | `deid.profile` is `off` while a rule asks for a scrub. | Set the profile to `basic` or `strict`. The next auto-send pass releases them. |
| `no-deidentifier` | The profile is **on**, but no de-identifier could be built from these settings. | Fix whatever stopped it being built; the failure is in the log on the send channel. |

The second one is the trap. **Turning the profile off does not release a
`no-deidentifier` hold** — it releases nothing and only changes which half is
stopping the scrub. Taking `deidentify` off the rule releases either hold, but it
releases the studies as **identified** copies, which is the one outcome the hold
exists to prevent; that is the right edit only when the destination is genuinely no
longer meant to receive scrubbed data.

Every documented way to reach `no-deidentifier` is a value validation would have
refused at save time — a `profile` outside the three, a non-string `prefix`, a
non-string `secret`. It is reachable because
[`Config.load()` does not validate](#how-to-read-this-reference): a hand-edited
`config.json` with a JSON number in `deid.prefix` runs, and the de-identifier
constructor dies the first time a rule asks for a scrub.

This is not a state validation could have refused instead. The profile lives on the
Settings card and the rules on the Routing card, so "profile off AND a rule scrubs"
is a state two individually valid saves arrive at, not an edit that can be rejected —
and refusing it there would mean rejecting a save that turns the profile off because
of a rule the operator is on their way to deleting.

---

## `emergency`

Failover: watch the destinations marked as primaries, notice when one stops
answering, and offer — or take — the decision to run the department locally until it
is back. There is no `enabled` key in this section; `armed` is the switch.

Which destinations are watched is not set here. It is the
[`emergency_trigger`](#destinationsemergency_trigger) flag on a destination, and only
*enabled* destinations carrying it are probed. An armed monitor with no such
destination watches nothing, will never trigger, and reports itself armed the whole
time — the arming log line says how many destinations it is monitoring, and that is
the number to read.

Two of these keys, `activate_by` and `notify`, have no field in the dashboard. They
are written into `config.json` by hand and survive a dashboard Save because the Save
re-posts the section it loaded. They also depend on user profiles: with no profiles
configured, the appliance has one operator and both are inert.

### `emergency.armed`

`boolean` · default `false`

Whether the health monitor runs and failover is armed. It is persisted rather than
held in memory: Arm and Disarm on the dashboard write this key back to `config.json`
under the config lock, so an appliance that was armed comes back armed after a
restart — `pacs serve` starts the monitor at launch, and the monitor's start declines
immediately when this is false.

Arming is the consent to auto-start services. It does not by itself start anything:
what it starts is the probing.

### `emergency.probe_interval_sec`

`number` (seconds) · default `30`

Seconds between C-ECHO passes over the watched destinations. The monitor sleeps
`max(5, int(value))`, so anything below 5 is floored at 5 and a fractional value is
truncated.

This is the clock everything else in the section is measured against. Detection
cannot be finer than one interval, and recovery cannot be faster than
`recovery_successes` intervals. A long interval is the quiet way to make
`offline_threshold_sec` decorative: with a five-minute interval, a two-minute
threshold still takes two probes — around five minutes — to fire, because the
threshold is only ever evaluated when a probe runs.

Validation refuses a value below 1 or a non-number with
`emergency.probe_interval_sec must be a number >= 1`. It does **not** refuse `null`,
and `null` is the one value the monitor cannot survive: the sleep is computed outside
the loop's error handling, so `int(None)` raises, the monitor thread exits, and the
appliance is left with no health probe at all while still reporting itself armed. If
you hand-edit this key, give it a number or remove it.

### `emergency.offline_threshold_sec`

`number` (seconds) · default `120`

How long a watched destination must fail *continuously* before it is declared
offline. The clock starts on the first failing probe and is checked on every probe
after it, so the real detection latency is this value rounded up to the next probe
interval.

"Failing" is both signals, deliberately. A C-ECHO that does not answer counts, and so
does the passive one: a destination whose name is in the stuck-send list counts as
failing even while its C-ECHO answers, because a node that accepts associations and
will not take images is not a node the department can use. A purely passive signal
would miss an outage that starts during a quiet period — nothing is being sent, so
nothing fails.

`0` is legal and means the first failing probe declares the primary offline. That
turns one dropped packet or a thirty-second reboot of the primary into a failover
prompt, and with `auto_activate` on, into a failover. Note also that clearing this
field in the dashboard saves `0` rather than restoring the default — the form reads
an empty box as zero. (`probe_interval_sec` falls back to `30` and
`recovery_successes` to `1` the same way.)

Validation refuses a negative value or a non-number with
`emergency.offline_threshold_sec must be a number >= 0`. As with the interval above,
`null` passes validation; here it fails more gracefully — the read is inside the
monitor's error handling, so every pass logs `Emergency monitor error` instead of
killing the thread, and no destination health is ever evaluated.

### `emergency.recovery_successes`

`number` · default `2`

How many consecutive good probes it takes to call an offline destination back. This
is the hysteresis: without it a flapping link rattles the state machine, and with it
a link that comes and goes has to stay up for this many intervals before anything
changes.

Set to `1`, a single C-ECHO ends the outage — and a C-ECHO answering is not the same
as a C-STORE succeeding. A primary that has come back half-way, answering
associations while its storage is still unavailable, is then declared back and the
held backlog is flushed at it. Raising it costs recovery latency and nothing else:
the held studies wait `recovery_successes` × `probe_interval_sec` longer before they
start moving.

Validation refuses a value below 1 or a non-number with
`emergency.recovery_successes must be a number >= 1`, and `null` behaves as under
`offline_threshold_sec` — accepted at save, then logged as a monitor error every pass
with no health tracked.

### `emergency.auto_activate`

`boolean` · default `false`

What happens at the moment a watched destination is declared offline. `false` raises
a prompt and waits for a person: the state goes to `triggered`, the banner appears,
the pop-up asks whoever the policy names. `true` skips the question and activates
from the monitor thread — the local worklist starts, hold-and-forward begins, and the
log, the banner, the audit trail and the notification all attribute the decision to
"the system", because putting an automatic failover in the name of whoever happened
to be logged in would credit a decision to someone who did not make it.

Two consequences of turning it on. Nobody has to be at the dashboard, which is the
point — it is the answer for an appliance that runs unattended, or for a policy that
would otherwise name nobody able to answer. And standing down is still manual:
recovery auto-flushes the held studies, but the state stays `recovering` until
somebody clicks Resume normal. A night of flapping with a low threshold therefore
leaves the appliance active in the morning, which is a recoverable state but not a
quiet one.

It is also the escape hatch the `activate_by` cross-check names: a policy where
nobody can answer the prompt is refused unless this is on.

### `emergency.hold_and_forward`

`boolean` · default `true`

While the failover is active or recovering, every instance the receiver stores is
also copied into the auto-send watch folder, so the normal forward-and-retry pipeline
carries it to the primary and back-fills once the primary answers. It is independent
of whether the study matches an order.

The copy is *pinned* to the primary in the send state rather than left to the rule
engine. That matters: a routing rule of the shape `{"destinations": ["Teaching"],
"stop": true}` would otherwise send the held copy to a teaching archive, mark it fully
sent, and let it be archived or deleted having never reached the primary — which is
the entire reason hold-and-forward exists. A pin only widens the route; the rules
still add whatever else they want.

Off, received studies are stored and nothing is queued: forwarding them to the primary
after the outage is a manual Send, one study at a time. There is no third state where
studies are dropped.

The pin needs something to pin to. If no *enabled* destination carries
`emergency_trigger` — the flag was cleared, or the failover was activated by hand —
held copies go wherever the routing rules send them and nothing guarantees a
back-fill. The log says so once, on the `emergency` channel, rather than every
instance: *Emergency hold-and-forward has no primary to hold FOR …*

### `emergency.activate_by`

`list of principals` · default `[]` (anyone who holds the capability)

Who may make failover decisions on this appliance, declared by the administrator.
Entries are `"role:radiologist"`, a profile id, or `"*"` / `"any"`. Empty means
everyone holding the `emergency.activate` capability, which is the behaviour of every
install that predates the field — an upgrade narrows nothing until somebody decides
to.

Both gates have to hold: the capability says this is the kind of person who makes the
call at all, and this list says the administrator designated them *here*. Somebody the
policy does not name still sees the red banner and is told who can answer it, rather
than being handed a button that fails.

The scope is wider than the name suggests, and this is the failure mode to know: it
gates **arm, disarm, activate and resume**, not activate alone. Naming only
`role:radiologist` takes Arm and Disarm away from IT at the dashboard — they get
*failover decisions on this appliance are for anyone with the radiologist role. Your
profile can see the alert but not answer it.* Dismiss is deliberately not gated;
acknowledging a prompt is saying "I have seen this", which anybody being shown it is
entitled to say.

Validation refuses a non-list, a blank or non-string entry, and a bare name that is
neither a role nor a valid profile id — *Point at a role as "role:&lt;name&gt;", or at
one person by their profile id. A bare name is ambiguous the moment somebody is called
the same thing as a role.* It then refuses, when profiles are actually in use, a
policy that names only people who cannot act: *emergency.activate_by names …, but
nobody matching that can activate failover … As it stands the prompt would appear and
no one could answer it. Grant the capability, name someone else, or set
emergency.auto_activate true.* That check is what stops the policy failing at 3am
instead of at the moment it was written. With no profiles configured there is nobody
to ask, so the check is skipped and the whole key is inert.

### `emergency.notify`

`list of principals` · default `[]` (everyone)

Who is told about the outage. Same spelling as `activate_by`, same
empty-means-everyone rule, and separate from it on purpose: reception needs to know
the RIS is down so they can start keying orders by hand, and must not be the one
deciding to fail over.

This is the appliance's *audience*, not its channels — the delivery settings live in
[`notify`](#notify), and this list has no effect unless one of them is on. It decides
which enabled profiles get an e-mail. The webhook is sent regardless of it, because a
webhook goes to a system rather than to a person.

It also decides something less obvious, and this is the trap: **the activation pop-up
only opens for somebody this list names.** Set it to reception alone and the
radiologist who is the only person `activate_by` allows to press the button never gets
the modal. They still see the banner, with Activate on it, so nothing is lost — but
the 3am pop-up they were meant to get does not appear. If you narrow one of these two
lists, look at the other.

Acknowledgement is per person and is not stored here: clicking *Not now* stops the
modal reopening for that profile and for nobody else, and it is cleared the next time
the state changes.

Validation is the same principal check, reported as `emergency.notify`. There is no
cross-check equivalent to the one on `activate_by`: a `notify` list naming a profile
that has since been deleted is accepted, and because this list is never rendered
anywhere, nothing on the dashboard says the audience is now empty.

---

## `notify`

Reaching people who do not have the dashboard open. The banner is enough for the
operator watching a transfer and useless for the case this exists to serve: the
primary goes down at 03:00 and the radiologist on call is not looking at a screen.

Two things bound what this section does. **The only events it sends are emergency
failover events** — triggered, activated, resolved. Nothing else in the appliance
produces a notification. And **nothing here may delay or crash what it is
reporting**: every send is queued to a worker thread, the queue is bounded (the
oldest is dropped and the drop is counted, because a stale "primary is down"
delivered after recovery is actively misleading), and every exception becomes a
counter and a log line. `status()` publishes sent / failed / dropped / queued and the
last error, so "enabled but nothing has ever been sent" is visible before the outage
that depends on it.

Configuration is read live at send time, so turning a channel on applies without a
restart.

**One type-checking gap to know about.** The blanket boolean and string checks reach
one level down from a section, so `notify.enabled` is type-checked but the keys inside
`notify.webhook` and `notify.smtp` are not. A quoted `"false"` under
`notify.webhook.enabled` is a non-empty string, reads as TRUE at runtime, and is not
refused at save time.

### `notify.enabled`

`boolean` · default `false`

The master switch. Nothing leaves this box until it is on, whatever the two
sub-sections say. Checked live on each event.

### `notify.webhook.enabled`

`boolean` · default `false`

With this off (or `url` empty) the webhook send is a no-op — no error, no counter.

### `notify.webhook.url`

`string` · default `""`

Where the JSON event is POSTed. The body is a compact object — `event`, `at`,
`state`, `destination`, `since`, `activated_by`, `actor` — sent with `Content-Type:
application/json` and `User-Agent: Carino-PACS`.

Validation refuses two things. `enabled: true` with an empty URL: *nothing would be
sent, and the appliance would report notification as configured.* And any non-empty
URL that does not start with `http://` or `https://` — checked even while the webhook
is disabled, so a typo cannot sit in the file waiting for the day somebody switches
it on.

### `notify.webhook.secret`

`string` · default `""`

Shared with the receiver so it can tell a genuine POST from anyone who learned the
URL. When set, an HMAC-SHA256 over the exact bytes sent goes out as
`X-Carino-Signature: sha256=<hex>`. Signing the exact bytes means a proxy that
reformats the JSON invalidates the signature rather than passing an altered body off
as genuine.

Treated as a [secret](#secrets-and-what-get-apiconfig-returns) everywhere: redacted
from `GET /api/config` behind `secret_set`, covered as a keyed fingerprint by the
config version so a Save assembled before a change cannot silently put the old value
back, and refused if a Save tries to send it. Set it through `POST /api/notify/secret`
with `{"field": "webhook", "action": "set"|"clear", "value": "..."}`, which needs
`config.write`. Unlike the de-identification site key it does **not** demand the raw
token — neither of these two secrets can be used to read patient data or reach
anything on the appliance, and requiring the token would mean an administrator cannot
configure notification from the dashboard they are already signed into.

### `notify.webhook.timeout_sec`

`number` (seconds) · default `10`

Per-attempt HTTP timeout. **Not validated.** A zero, a negative or an unreadable value
is coerced back to 10 at send time, deliberately: zero means "never time out" to
`urllib`, which would hang the worker thread on a black-holed host until the process
ends — one unreachable webhook and no notification ever leaves again.

### `notify.webhook.retries`

`integer` · default `2` (so up to three attempts)

Backoff is linear and short — this is an outage alert, and a delivery that finally
succeeds four minutes later is not worth what the wait cost everything behind it in
the queue. A 4xx other than 408 or 429 is not retried: it is the receiver saying the
request itself is wrong, and repeating an unchanged body just makes the same mistake
three times.

Validation refuses anything that is not a whole number `>= 0`, booleans included.

### `notify.smtp.enabled`

`boolean` · default `false`

Validation refuses `enabled: true` with an empty `host`: *no mail would be sent, and
the appliance would report e-mail as configured.*

### `notify.smtp.host`

`string` · default `""`

The mail server. Also the fallback sender domain — with `from` empty, messages are
sent as `carino-pacs@<host>`.

### `notify.smtp.port`

`integer` · default `587`

Validation refuses anything outside 1..65535, booleans included.

### `notify.smtp.tls`

`string` · default `"starttls"` · one of `starttls` | `ssl` | `none`

`ssl` opens an implicit TLS connection; `starttls` upgrades a plain one; `none` sends
in clear — including the login, if a username is set.

Validation refuses anything else, and the message says why the strictness is there:
*An unrecognised value used to mean no encryption, which is not a thing to arrive at
by typo when a password is being sent.* An empty string reaches this check and is
refused; a non-string is refused one step earlier by the type check.

### `notify.smtp.username`

`string` · default `""`

Authentication is attempted only when this is non-empty. An empty username means no
`LOGIN` at all, whatever `password` holds.

### `notify.smtp.password`

`string` · default `""`

Held to the same rules as the webhook signing key: redacted behind `password_set`,
covered by the config version, refused if a Save tries to send it, and set through
`POST /api/notify/secret` with `{"field": "smtp", ...}`. It is the one secret in the
file that is deliberately **not** whitespace-trimmed anywhere — a password whose
leading or trailing space is significant is a password somebody chose, and trimming it
would make the login fail with no explanation anywhere.

### `notify.smtp.from`

`string` · default `""`, which becomes `carino-pacs@<host>`

The envelope and header sender. Worth setting deliberately: a synthesised address on a
domain the server does not own is what SPF-checking recipients reject.

### `notify.smtp.timeout_sec`

`number` (seconds) · default `15`

**This key is in neither `config.example.json` nor the code's defaults**, but the SMTP
sender reads it — and because it is not in the defaults, the blanket type checks never
see it either. Same coercion and same reason as the webhook timeout: zero, negative or
unreadable falls back to 15, because a socket with no timeout hangs the single
notification worker permanently.

### Who actually receives mail

Recipients are profiles, not addresses. A message goes to each enabled profile that
[`emergency.notify`](#emergencynotify) names **and** that has a non-empty
[`email`](#usersprofiles). An appliance with SMTP configured, no profiles and
therefore no addresses sends the webhook and no mail at all, silently — that is the
failure mode to check first when "e-mail is on and nobody was told".

The message body varies by recipient, deliberately. The guidance paragraph is chosen
by role (reception is told to start keying orders by hand; a radiologist is told
studies are being held and how to forward one; IT gets the "correct the address and
the monitor clears" wording). The destination's address and state are included only
for a recipient holding `routing.read` — the same capability the dashboard requires to
show the destination table. An e-mail leaves the appliance and cannot be un-sent, so
it is the last place to be generous with information the reader is not cleared for.

---

## `audit`

The append-only, hash-chained record of who did what. Deliberately not the operational
log: the log is a ring buffer that drops its oldest line without ceremony and names
nobody, which is right for "what is this box doing now" and wrong for "who deleted
that study".

On by default, because "there is no audit trail" is the gap this closes. It is worth
knowing what the chain proves before relying on it: it detects a record edited in
place, a record removed from the middle, records reordered, a torn line and corruption
of any file that is not the newest one. It does not detect truncation at a record
boundary or a wholesale rewrite by somebody with write access to the directory — no
artifact kept beside the data can. What closes that is anchoring the digest `status()`
publishes as `audit.head` somewhere this appliance cannot write.

### `audit.enabled`

`boolean` · default `true`

Off means no records are written at all. **Validation refuses `enabled: true` with an
empty `dir`**, because a trail that looks enabled in Settings and records nothing is
the one failure this feature cannot tolerate quietly:

```
audit.enabled is true but audit.dir is empty — the trail would have nowhere to be
written. Set a folder, or set audit.enabled false and accept that this appliance
keeps no record of who did what.
```

### `audit.dir`

`string` (path) · default `"./audit"`

Holds `audit.jsonl` plus rotated `audit-<UTC stamp>-NNN.jsonl` archives. The directory
is created at startup rather than on first record, so a path that cannot be created is
reported next to the config problem at boot instead of at the moment somebody deletes
a study and the one record that mattered is the one that failed. A write failure never
propagates into the thing being audited — it sets `broken`, which `status()`
publishes, because a trail that silently stopped recording is indistinguishable from a
quiet week.

### `audit.max_bytes`

`integer` (bytes) · default `8388608` (8 MB)

Rotation is by size, not by day: a dated file sounds tidier until an appliance that
receives nothing for a week produces seven empty files, or a busy morning produces one
no editor will open. When the live file reaches this size it is renamed to
`audit-<stamp>-NNN.jsonl` and a fresh one starts; the chain continues across the
boundary and `verify()` walks the archives in name order.

`0` means never rotate. If the rename fails, the appliance keeps writing to the
oversized file rather than stop recording, and says so through `broken`.

Validation refuses anything that is not a whole number `>= 0` (a boolean is not a
number here): *audit.max_bytes must be a whole number of bytes (0 = never rotate).* A
hand-edited config is not validated on load, so a value `int()` cannot read raises
while the engine is being constructed and the service does not start.

### `audit.log_reads`

`boolean` · default `false`

Whether reads are recorded — currently the `study.read` action, raised when somebody
opens a study. Everything else is recorded regardless of this flag.

Off by default because it is a trade the operator has to make, not one this file can
make for them: "who viewed this patient" is a legal requirement in some jurisdictions,
and turning it on multiplies the size of the trail by how often people refresh a
dashboard.

### `audit.fsync`

`boolean` · default `true`

Flush and `fsync` each record before returning. Slow by design and correct for this
file: a record still sitting in the page cache when the machine loses power is a
record that did not happen. The cost is bounded because this file is written on
deliberate actions — a login, a delete, a config change — and not per received
instance.

Turning it off buys throughput this workload does not need and gives up the only
property that makes the trail survive a power cut.

---

## `users`

Who may use the dashboard, and what each of them may do. This section is optional in
the strongest sense: an empty `profiles` list means profiles are not in use,
[`web.auth_token`](#webauth_token) alone governs access, and the appliance behaves
exactly as every install that predates the feature does. Every config file written
before profiles existed deep-merges to precisely that, so upgrading changes nothing
until somebody decides it should.

Turning profiles on is sufficient by itself to make a credential mandatory. With
profiles enabled and no token set, the guard still demands one — otherwise an operator
who seeds profiles on a loopback box (the common case, and the one the feature is for)
would get a picker anyone can walk straight past.

### `users.profiles`

`list of objects` · default `[]` — token-only

Each row is one person. Nothing in the code branches on a row's `role`, and the
presets a fresh install seeds are ordinary rows afterwards: rename them, re-permission
them, delete them.

Row keys:

- `id` — string, generated, never typed: `u_` followed by 12 hex characters. It is
  what the audit trail records, so a name can be corrected without rewriting history
  and a deleted profile's entries still resolve to something specific. Must be unique.
- `name` — string, required, unique case-insensitively, up to 64 characters. It is the
  button in the picker and the name in the trail.
- `role` — string, up to 32 characters, free text. A label for humans and the thing
  [`emergency.activate_by`](#emergencyactivate_by) / [`emergency.notify`](#emergencynotify)
  can point at as `role:<name>`; never a permission.
- `enabled` — boolean, default `true`. A disabled profile cannot log in and holds
  nothing.
- `admin` — boolean, default `false`. Holds every capability, including ones a later
  version invents. It is a flag rather than a stored list of every name precisely so
  that an upgrade cannot leave the administrator locked out of a screen only they
  could fix.
- `capabilities` — list of capability names, ignored while `admin` is true. Valid
  names: `studies.read`, `studies.send`, `studies.delete`, `orders.read`,
  `orders.write`, `routing.read`, `routing.write`, `destinations.write`,
  `services.control`, `emergency.activate`, `logs.read`, `audit.read`, `config.read`,
  `config.write`, `system.shutdown`, `auth.manage`, `deid.manage`. Anything else in the
  list is dropped at read time and refused at save time. `auth.manage` and
  `deid.manage` are the two that can be used to grant everything else — the first by
  editing profiles, the second by switching off the scrub that keeps a research node
  from receiving identified studies.
- `phi_visible` — list of identifier fields this profile may be shown: `patient_name`,
  `patient_id`, `patient_birthdate`, `patient_sex`, `accession`, `study_desc`,
  `referring`. Anything not listed comes back as `***` in every JSON response, not as
  `""` — an empty accession already means "this study has none". A field nobody
  classified is withheld rather than shown.
- `password` — `null` for an open profile, or a stored PBKDF2 record `{"algo":
  "pbkdf2_sha256", "iterations": n, "salt": hex, "hash": hex}`. A plaintext string here
  is refused: it would be stored in clear. Set it from the dashboard. The iteration
  count is stored per record, so raising the project's default later leaves existing
  passwords working.
- `email` — string, default `""`. The address emergency notifications go to. This is
  the only thing that makes SMTP notification reach anybody.
- `locale` — string, default `""`. Stored, published and read by nothing in this
  version. **What it is meant to select is not documented here yet** — the dashboard
  picks its language client-side and the notifier does not consult this field. Treat it
  as inert.

**Validation refuses,** with a message naming the row: a malformed or duplicate `id`; a
blank, over-long or duplicate `name`; an over-long `role`; a non-boolean `enabled` or
`admin`; an unknown capability or PHI field; a password record that is not a
`pbkdf2_sha256` object with hex `salt` and `hash` and a positive `iterations`; an
address with no `@`. It also refuses three whole-list states:

- every row disabled — "so nobody could log in";
- no enabled profile that is `admin` or holds `auth.manage` — somebody has to be able
  to grant access, or the next staff change needs the config file edited by hand;
- while [`web.host`](#webhost) is network-reachable, any enabled profile with no
  password that can change anything: *Profile 'X' has no password but can change things
  (...), and web.host is reachable from the network.* Read-only open profiles stay
  legal off-box, because a waiting-room screen showing a fully redacted queue is a real
  deployment and forcing a password onto it only means the password gets taped to the
  monitor.

**This list cannot be set through `POST /api/config`.** Two reasons, either sufficient:
a caller holding `config.write` could otherwise post themselves an admin row, and a
dashboard Save built from a page-load snapshot does not carry the section at all —
merging that over the defaults would delete every profile on the appliance and turn
access control off. Editing goes through `/api/profiles`, which asks for `auth.manage`.

### `users.list_profiles`

`boolean` · default `true`

Whether the sign-in screen draws the profile buttons before anyone has authenticated.
True is the kiosk case this was built for: a shared front-desk machine where you tap
your name and type a password. It does publish the staff list — names, roles, and
whether each needs a password — to anyone who can reach the port, which is a real
disclosure and not a hypothetical one, so a site that binds off-box and cares about
that sets it false and gets a name-and-password form instead. `GET /api/profiles` then
answers an empty list rather than a filtered one.

It changes nothing about who may do what; it is a display decision only. Disabled
profiles are never listed either way, because a button that cannot log in is a support
call.

The runtime test is `is not False`, so a hand-edited config that got past validation by
never being saved would list profiles for any value except literal `false`.

---

## `destinations`

`list of objects` · default `[]`

The nodes this appliance forwards **to**. A flat list at the top level of the config,
not a section and not a map — order is preserved and matters in one place (the fallback
route, when no rule matches, is the enabled list in config order).

`config.example.json` ships one sample entry with `"enabled": false`; the real default
when the key is absent is an empty list. With no enabled destination the watcher
returns each pass having touched nothing, `pacs send` exits with `No enabled
destinations in config — nothing to send to.`, and the manual Send answers *no enabled
destinations — add one in Destinations first*.

One entry looks like this:

```json
{
  "name": "Example PACS",
  "host": "127.0.0.1",
  "port": 104,
  "aet": "REMOTEPACS",
  "enabled": false,
  "tls": false,
  "no_ris": false,
  "emergency_trigger": false
}
```

There is no credential field anywhere in the sender. DICOM has nowhere to put one, and
TLS is configured once for the whole appliance under [`scu`](#scu-tls).

### `destinations[].name`

`string` · **required** · no default

The label, and also the join key for nearly everything downstream: routing rules name
destinations by this string, per-file send state records it, the retry backoff is keyed
on it, the archive gate asks "has this file reached every name it owes", and emergency
hold-and-forward pins held studies to it.

Validation requires it present and non-blank (`destination #1 has a blank name…`) and
**unique, case-insensitively**. The duplicate message names both rows by index and
address, because `'PACS' and 'PACS'` was useless in the case that matters:

> destinations #1 ('PACS' at 10.0.0.5:104 AE ARCHIVE) and #2 ('PACS' at 10.0.0.9:104 AE
> BACKUP) have the same name. Destination names must be unique (case is not enough to
> tell them apart) — send state and the archive gate key on the name, so duplicates make
> one of them silently never receive its images. Rename one.

That is image loss, which is why it is an invariant rather than a warning. A hand-edited
config bypasses the check; the watcher survives it by sending to *every* node carrying
the name and only recording the name as delivered once all of them accepted, at the cost
of re-sending to the one that already took it.

Renaming a destination is not free either. A rename is a new name as far as send state is
concerned, so files in flight are owed a delivery to it, and the old name — still in their
recorded route with no node behind it — pins them in the outgoing folder and is
re-announced every fifteen minutes: *… still owes X, which is no longer an enabled
destination*. They also appear in the stuck panel under "orphaned". Restore the node or
rename it back.

### `destinations[].host`

`string` · **required** · no default

Hostname or IP. Validation only checks that the key is present — no format check, no
reachability check. Use the C-ECHO button, which is what it is for.

Changing it is a delivery-affecting edit, not a cosmetic one: a name is a label on an
address and the operator can move it, so every study recorded as delivered to that name
would otherwise be recorded as delivered to a machine that has never seen it. The watcher
stamps each accepted name with the `host:port|aet` it was accepted by, and a name whose
address moved is un-marked and owed the study again — *X now points at …, not … —
study.dcm reached the old address only and is owed to the new one*. Re-sending an instance
the receiver already holds is idempotent (same SOP Instance UID); archiving a study on an
address the operator just corrected away is an image that silently never arrives.

### `destinations[].port`

`integer` · **required** · no default

Validated as an integer in 1..65535 (`destination 'X' has an invalid port`). 104 is the
registered DICOM port and is what most remote archives listen on; being privileged is only
a problem for ports this appliance *binds*, not ones it dials.

Part of the address fingerprint above, so changing it re-opens delivery the same way
`host` does.

### `destinations[].aet`

`string` · **required** · no default

The **called** AE title — who this appliance asks for when it associates. Distinct from
[`scu.aet`](#scuaet), which is who it says it is.

Validated at 16 characters or fewer (`destination 'X' AE title too long`). Presence is
checked; blank is not, and neither are spaces or backslashes.

It has a second, non-obvious use: the Q/R server resolves a C-MOVE Move Destination AE
title against [`qr.move_destinations`](#qrmove_destinations) first, and failing that falls
back to matching this field across the destination list — a node the operator has already
configured and echo-tested is a node they clearly trust. No match anywhere means the move
is refused; a host is never guessed.

Also part of the address fingerprint, so re-pointing it re-opens delivery.

### `destinations[].enabled`

`boolean` · default `true` **when the key is absent**

Worth stating plainly because the example file and the code disagree in effect:
`config.example.json` ships `"enabled": false`, but an entry with no `enabled` key at all
counts as enabled — `enabled_destinations()` reads `d.get("enabled", True)`. A hand-added
entry that omits the flag starts receiving studies immediately.

Disabled destinations are invisible to routing, to the watcher, to the manual Send, to the
health monitor and to the C-MOVE fallback. They are not deleted, and they are not the same
as removed: a study already routed to a name that is then disabled is pinned, not dropped
— it waits in the outgoing folder and appears as orphaned until the node is restored or
the operator accepts the loss.

Validated as a boolean here rather than by the generic flag check, because `destinations`
is a list and the generic check cannot reach into one: *destination 'X' has a non-boolean
'enabled' ('false') — it must be true or false; a quoted "false" reads as TRUE.* Same
hazard as everywhere else, higher stakes — a node the operator switched off that keeps
receiving studies.

<a id="destinationstls"></a>

### `destinations[].tls`

`boolean` · default `false`

Dial this node over TLS. It decides *whether*, never *how*: the certificate, the CA and
the verify flag all come from the [`scu.tls_*`](#scu-tls) keys and are shared by every
destination.

Deliberately excluded from the address fingerprint. Turning the link to a node encrypted
changes how we talk to it, not who we are talking to, so it does not re-open a delivery
that already happened.

### `destinations[].no_ris`

`boolean` · default `false`

"This PACS has no RIS of its own, so Carino is its worklist source." Setting it on any
**enabled** destination makes the Modality Worklist a permanent service — see
[`mwl.enabled`](#mwlenabled) for the mechanism and the consequence: with this flag set you
cannot switch the worklist off by clearing `mwl.enabled`, because the destination keeps
asking for it. Clear the flag too.

### `destinations[].emergency_trigger`

`boolean` · default `false`

Marks this node as "the primary" for failover. It means two related things.

The health monitor C-ECHOes every enabled destination carrying this flag, on
[`emergency.probe_interval_sec`](#emergencyprobe_interval_sec), and a continuous failure
lasting [`emergency.offline_threshold_sec`](#emergencyoffline_threshold_sec) is what
triggers the outage.

And while failover is active with
[`emergency.hold_and_forward`](#emergencyhold_and_forward) on, every received instance is
copied into the outgoing folder with these names **pinned** onto its send state, so the
normal retry pipeline back-fills the primary when it returns. The node that actually
triggered the outage stays pinned even if the flag is later cleared, because it is the one
the operator is waiting on.

### A gap in destination validation

Every entry is assumed to be an object without being checked, unlike
[`modalities`](#modalities), which checks. A string in the list produces a usable-if-odd
message (`destination #1 missing 'name'`), but a bare number raises `TypeError: argument
of type 'int' is not a container or iterable` out of `validate()`. That is not a
`ValueError`, so it does not travel the path the dashboard's Save and the CLI catch, and
the operator gets an unhandled error instead of a sentence naming the row.

---

## `modalities`

`list of objects` · default `[]` · absent from `config.example.json`

The equipment this department has — the stations that *pull* a worklist and *push*
studies back, as opposed to `destinations`, which is where studies are forwarded on to.
Each entry is one station:

```json
{ "name": "ER CT", "aet": "CT_ER_01", "modality": "CT", "station_name": "", "enabled": true }
```

An order's target station is chosen from this list rather than typed, and the worklist
probe will only borrow an AE title that appears here. The list itself is published
ungated — it is names and AE titles of this department's own equipment, no address and no
PHI, and the order form needs it to offer a target to the profile with the fewest
capabilities of any.

A mistyped AE title is not a cosmetic error. The worklist matches
`ScheduledStationAETitle` exactly, so the order appears on **no** station for a modality
that queries with its own AE, and on **every** station for one that queries with the key
empty. Same typo, opposite failures, decided by the vendor.

Validation refuses a non-list, an entry that is not an object (`modality #1 must be an
object`), a blank `name` — *it is what the order form shows* — a missing `aet` — *it is
the whole point of the entry: the worklist matches ScheduledStationAETitle against it* —
an `aet` over 16 characters, an `aet` containing a space or a backslash or a
non-printable character, a non-boolean `enabled`, and two entries sharing an AE title
case-insensitively, because the worklist matches on it and an order aimed at one would
appear on both.

`modality` and `station_name` are carried and shown; nothing validates them.

---

## `web`

The dashboard's HTTP listener, and the one secret that decides whether the API is
reachable by strangers.

### `web.auth_token`

`string` · default `""` — no token, no authentication

This is the most important key in the file. Empty means every `/api` and `/dicom-web`
route answers anyone who can reach the port, which is defensible on loopback because the
operating system is then the access control. It is not defensible anywhere else, so
**validation refuses to save a non-loopback `web.host` while this is empty**:

```
web.host is '0.0.0.0', which is reachable from the network, but web.auth_token is empty.
Set a token — generate one with: python3 -c "import secrets; print(secrets.token_urlsafe(32))" —
or set web.host back to 127.0.0.1 to keep the dashboard on this machine only.
```

What the token protects is not a settings page. The API hands out the study list with
patient names and identifiers, the storage paths, the DICOM bytes themselves, and
`/api/shutdown`. An open API on a LAN address gives all of that to any neighbour who can
route to the port, and that change takes ten seconds to make.

The gate is enforced three times over, because a config save is not the only way in.
`pacs serve --host <addr>` bypasses validation entirely, so `cmd_serve` re-checks the same
pair before anything binds and exits rather than serving. The container binds `0.0.0.0` by
construction, so its entrypoint generates a 256-bit token on the boot that first needs one
and prints it in a banner — generated, never generated quietly.

A credential is accepted as `Authorization: Bearer <token>`, as `X-Carino-Token: <token>`,
or as the `carino_session` cookie that `POST /api/login` issues. The cookie never carries
the token, only an HMAC over a per-process secret, which is why a restart signs everyone
out and why rotating the token signs out every open browser at once.

The token is read live from this key on every request, so setting or rotating it applies
with no restart and no window in which a saved token is not yet enforced.

A non-string is refused with its own message rather than the generic one, because a config
carrying `"auth_token": 0` looks to the operator like a token is set while every reader in
the code correctly sees none:

```
web.auth_token must be a string. A JSON number, true/false or null is not a token —
use "" for no token (loopback only), or a real one: ...
```

**How to set it.** Not through `POST /api/config` — that endpoint refuses a token outright
and tells you where to go. `POST /api/auth/token` is the only path that writes it, with
`{"action": "rotate"|"set"|"clear"}`. It requires the current token in a header, not a
session cookie: replacing a secret has to be proof of holding it. A `set` shorter than 12
characters is refused, and a `clear` is refused while `web.host` is non-loopback. `pacs
init --token` writes one at scaffold time and prints it once — it is not in the log, not
in the dated log files, and not in any URL.

### `web.host`

`string` · default `"127.0.0.1"`

The address the dashboard binds. Loopback is the shipped answer and the only one that does
not require a token.

Whether an address counts as loopback is decided by one function that fails closed:
`localhost` and its variants, anything in `127.0.0.0/8`, `::1`, a bracketed `[::1]`, an
IPv6 zone suffix and an IPv4-mapped `::ffff:127.0.0.1` are all loopback; anything that will
not parse — including `""` and `0.0.0.0` — is treated as network-reachable rather than
assumed safe. Same coercion for the gate that demands a token and for the code that binds,
so the two cannot disagree about what "the host" is.

Changing this also changes what [`users.profiles`](#usersprofiles) may look like: an
enabled profile with no password and any write capability is refused outright once the bind
is reachable.

A non-string is refused by the type check. There is no name resolution or interface check —
an address this machine does not have is discovered when Werkzeug fails to bind at startup,
not at save time.

**Under Docker** the entrypoint forces `0.0.0.0` on first boot (or whatever `PACS_WEB_HOST`
says), because a container binding loopback publishes nothing outside its own namespace. A
later edit in the dashboard sticks.

### `web.port`

`integer` · default `8042`

The dashboard's TCP port.

**Validation refuses nothing here.** It is not range-checked, and — unlike the DICOM
listeners and `ris`, which are checked against one another — it is not compared with them,
so a config in which the dashboard and the receiver claim the same number saves cleanly and
fails at bind time. `pacs serve` reads it as `int(...)`, so a value `int()` cannot parse
raises out of the command rather than being reported as a config problem.

### `web.editor_url`

`string` · default `"/editor/"`

Where the ✎ Edit button sends a study. Three meanings:

- `"/editor/"` (or any other relative path) — the bundled, same-origin copy of the DICOM
  editor. No CORS headers are emitted at all, because none are needed.
- a full `http://` or `https://` URL — a separate origin, e.g. a hosted editor. Its scheme
  and host are echoed as `Access-Control-Allow-Origin` (never `*`) on the two GET endpoints
  the deep link uses, `/api/studies/files` and `/api/studies/file`, along with
  `Access-Control-Allow-Private-Network: true` so Chrome's private-network preflight passes
  when a public page fetches this private box.
- `""` — the dashboard hides the Edit button.

Two consequences worth knowing before you point this at a public site.
`Access-Control-Allow-Credentials` is deliberately never sent, so a cross-origin editor can
only read studies while it is deliberately holding the token; and there is no safe way to
hand it one, because a deep-link query string is exactly the URL-logging leak the design
forbids. With a token set, the answer is the bundled `"/editor/"`.

Type only — a non-string is refused, because it is read through `(x or "").strip()` and
would otherwise raise inside a live request. A URL that does not resolve is not detected
here; the button simply goes nowhere.

Note that `GET /api/config` does not answer with this section verbatim: `auth_token` is
removed and replaced by the boolean mirror `auth_token_set`.

---

## `logs_dir`

`string` (path) · default `"./logs"`

Where the dated operational log files go: one file per UTC day, `YYYY-MM-DD.log`. These are
the same lines the dashboard's Activity view shows, which is an in-memory ring — the files
are what survives a restart.

They are created `0640` rather than the `0644` a plain open would give, because these lines
carry patient names, patient IDs, accession numbers and the AE title of every node this box
talks to. On a shared machine that is a patient list any unprivileged account could read.

`""` turns file logging off. The dashboard keeps working and the ring keeps filling; nothing
survives the process. Changing the path takes effect on the next config apply, without a
restart.

**What goes wrong.** A path that cannot be created or written to fails silently: the writer
swallows the `OSError` so a full disk cannot take the log path down with it, which also
means nothing anywhere reports that the dated files stopped being written. The dashboard
looks entirely healthy. If the files matter to you, check that today's file exists after
changing this key.

Validation covers the type only. The path is published in `status()` behind `config.read`.

---

## `setup_completed`

`string` · default `""`

A UTC stamp (`YYYY-MM-DDTHH:MM:SSZ`) written by the run that finished the dashboard's
service chooser, in the same save that enrols the picked services. Nobody edits it by hand.

The marker alone decides whether the chooser is offered: `""` means no run has ever
finished it. Whether a `config.json` exists is reported alongside but is deliberately **not**
part of the decision — a hand-written config has still never been through the chooser, and
treating it as though it had would be a migration by another name. `pacs init` says so out
loud when the marker is blank, because a scaffolded config enables no service and `pacs
serve` would otherwise look dead.

Clearing it re-offers the chooser at the next dashboard load. That changes nothing about
which services are enabled; it only re-opens the screen.

Validation covers the type only. Nothing parses the stamp, so any non-blank string counts as
"done" — which is the property that makes clearing it the way to get the chooser back.

---

## Things that look like settings and are not

Each of these is a constant in the code, deliberately. They are listed because "where is the
key for this?" is a fair question to have asked.

- **Which HL7 message types the RIS listener accepts** — `ORM`, `OMG` and `OMI`, fixed.
- **How leniently the Modality Worklist matches** — a blank field on an order matches any
  queried value. Target one station by setting the order's station AE.
- **What the worklist probe asks, and how much of it is kept** — the set of
  progressively-widened questions one run asks is fixed, and so is the number of past
  rounds `caught.json` retains before dropping the oldest.
- **The ceiling on a STOW-RS request body** — a constant in `pacs/dicomweb.py`.
- **The size of the Activity ring buffer**, and the header cache and write batching inside
  the router and the index — constructor arguments fixed in code, not reachable from
  `config.json`.
