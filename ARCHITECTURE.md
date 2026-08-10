# Architecture

Carino PACS is a DICOM gateway with a store-and-forward core and a set of
optional listeners around it: a Storage SCP that files what arrives, a folder
watcher that forwards what is put in front of it, and — each off unless somebody
turned it on — a virtual film printer, a Modality Worklist SCP, a Query/Retrieve
SCP, DICOMweb, an HL7 order listener and a failover monitor. One JSON document
configures all of it. One local dashboard drives all of it.

`CONTRIBUTING.md`'s "Where things live" is the module map: what each file under
`pacs/` is for, and which one to open. This document is the other half. It
describes the **four paths that actually run** — an image arriving and leaving,
a question being answered, an order coming in and a worklist going out, and the
control plane that configures the other three — and, for each, what owns what,
which thread it runs on, and what happens when it fails. Where a module is best
understood by reading it, this points at it rather than paraphrasing it.

Two invariants explain most of the design and are worth fixing before anything
else.

**Every service that opens a port ships disabled.** `DEFAULTS` sets
`enabled: False` on `scp`, `scu`, `print`, `mwl`, `ris`, `qr`, `dicomweb`,
`notify` and the routing rules; enrolment is a deliberate act through the
dashboard's setup chooser or a CLI flag for one run. Exactly two flags default
true — `index.enabled` and `audit.enabled` — and they are the two subsystems
that bind nothing. A fresh install is a process listening on loopback and
holding no ports open into the department.

**The filesystem is the source of truth and the index is only ever a cache.**
Every row in `index.db` is a pointer at a file on disk rather than a copy of
anything; losing the database costs a rescan, never an image. This is not a
slogan, it is load
bearing in three separate places: the index never serves bytes (it hands back a
path, and the delivery re-opens the file), a schema bump drops and rebuilds
rather than migrating, and every path a DICOMweb read is about to open is
re-validated against the configured storage roots first. The dashboard's study
browser does not use the index at all, for reasons in
[Somebody asking what this appliance holds](#somebody-asking-what-this-appliance-holds).

---

## The shape

```
  modalities · viewers · a real RIS                         operators
        │                                                       │
  ┌─────┴──────────────────────────────────────┐   ┌────────────┴──────────────┐
  │ listeners — every one OFF by default       │   │ dashboard (Flask)         │
  │                                            │   │ loopback by default;      │
  │  11112  Storage SCP     C-STORE / C-ECHO   │   │ a token is mandatory the  │
  │  11113  Print SCP       DIMSE-N, films     │   │ moment it is bound wider  │
  │  11114  Worklist SCP    C-FIND (MWL)       │   │                           │
  │  11115  Query/Retrieve  C-FIND/MOVE/GET    │   │  /api/*      REST         │
  │   2575  RIS listener    HL7 v2 over MLLP   │   │  /dicom-web/*  QIDO/WADO  │
  │                                            │   │                  /STOW   │
  └─────┬──────────────────────────────────────┘   │  /             static UI  │
        │                                          └────────────┬──────────────┘
        └────────────────────────┬──────────────────────────────┘
                                 ▼
                           PacsServer ── owns every worker, the one Config
                                 │        object, the log ring, the audit trail
     ┌───────────────────────────┼───────────────────────────────┐
     ▼                           ▼                               ▼
  received/                  outgoing/ ──▶ pacs-watcher ──▶ remote nodes
  scp.storage_dir            scu.watch_dir      │  poll · wait for stable ·
     │                           ▲              │  route · scrub on a copy ·
     │                           │              │  retry with backoff
     │              THREE writers only          ▼
     │              (nothing bridges         sent/ (scu.sent_dir), or deleted
     │               received/ → outgoing/)     — only once every routed
     │                           │                destination has accepted
     │                      pending/  non-DICOM awaiting review
     │                           └── approve ──▶ outgoing/
     ▼
  index.db  sqlite · one row per stored FILE · a CACHE
     └──▶ answers C-FIND / C-MOVE / C-GET and QIDO-RS / WADO-RS

  ris/orders.json   open orders ARE the worklist ──▶ Worklist SCP
  ris/caught.json   what someone else's RIS answered — a record, never served
  audit/            append-only, attributed, hash-chained
  logs/YYYY-MM-DD.log  + the in-memory ring the dashboard polls
```

### Threads, once

There is no scheduler anywhere in this application, and no queue between
components except the index's write queue. It is a small number of long-lived
threads touching a small number of shared objects. This is the whole inventory;
the path sections below discuss locks and hazards rather than re-listing it.

| Thread | Started by | Owns / does |
|---|---|---|
| main | `cmd_serve` | builds `Config`, `PacsServer` and the Flask app, then blocks in `app.run(threaded=True)` |
| pynetdicom acceptor + one thread per association | `ae.start_server(block=False)`, per listener | `_handle_store`, `_handle_find`, `_handle_move`, `_handle_get`, the print N-services |
| Werkzeug request threads | Flask, one per request | every `/api` call, QIDO/WADO/STOW, the worklist probe |
| `pacs-watcher` | `start_watcher()` | the outgoing and sent folders — the only thing that moves, archives or deletes there |
| `pacs-index` | `start_index()` | every queued sqlite write |
| `pacs-index-scan` | `start_index()` / `rescan_index()` (which `_sync_index()` calls) | the reconciliation walk; writes its batches directly |
| `pacs-ris` | `RisListener.start` | the MLLP accept loop |
| `pacs-ris-conn` | `_serve`, one per connection | one HL7 conversation: parse, apply, ACK |
| `pacs-emergency` | `EmergencyController.start` | probe primaries, drive the failover state machine |
| `pacs-send` | `PacsServer.send_study` | one manual forward from the dashboard |
| `pacs-notify` | lazily, on the first event | webhook / SMTP delivery |

**Nothing supervises any of them.** A thread that dies stays dead, and the
dashboard mostly cannot tell. Only the watcher's `running` is thread liveness
(`self._thread.is_alive()`), so only there does a dead worker show as stopped;
every DIMSE listener reports `running` from its server handle (`self._server is
not None`) and `RisListener` from its socket, both of which outlive the thread
behind them, and a dead emergency monitor is invisible entirely — `status()`
keeps publishing the last state it reached. Recovery is an operator pressing
Start, a Save (which restarts anything enabled and stopped), or the setup
chooser's `sync_services()`. Individual threads defend themselves differently —
the watcher catches per pass, the index writer catches per batch and falls back
to writing inline, the emergency monitor catches per tick — and each section
says where its thread's guard ends.

### The objects every path touches

- **`Config`** is one object per process, never reassigned; `apply_config` swaps
  `cfg.data` underneath it. That is why workers hold the `Config` object rather
  than a copy of their section, and why the watcher re-reads `self.cfg.scu`
  every pass. Its locking and save discipline are in
  [The control plane](#the-control-plane-config-dashboard-auth-audit).
- **`PacsServer`** owns every worker object, and the CLI and the web layer drive
  them through it: every service start, stop, send, delete and rescan is a
  `PacsServer` method. The objects `web.py` touches directly are `cfg`, `log`
  and `audit`, plus `emergency.status()` and the `caught` store, which are the
  two panels with no wrapper on `PacsServer`.
- **`InstanceIndex`** is described once, in
  [Somebody asking what this appliance holds](#somebody-asking-what-this-appliance-holds).
  Everything else on every path only ever *enqueues* to it.
- **`SendState`** is the per-file delivery record and the one genuinely shared
  mutable structure on the forward path; see
  [A study arriving and being forwarded](#a-study-arriving-and-being-forwarded).
- **`LogBuffer`** is a bounded ring every component logs through, with a dated
  file behind it. It is not the audit trail, and the difference is deliberate —
  see [The trail](#the-trail).

---

## A study arriving and being forwarded

This is the path the whole product exists to serve: an instance comes off the
wire, lands on disk, is routed, possibly scrubbed, and is sent on to one or more
remote nodes — after which its folder is archived or deleted. Everything else in
`pacs/` is either feeding this path, watching it, or asking questions about what
it left behind.

Two things to fix in your head before reading the sequence, because they explain
most of the code's shape:

**The receive half and the send half share no state.** The Storage SCP writes
into `scp.storage_dir` (`received/`). The watcher reads `scu.watch_dir`
(`outgoing/`). They are different folders with different owners, no queue and no
handoff between them, and nothing in normal operation moves a received instance
from one to the other. That is not an omission — the appliance is
receive-and-keep by default, and forwarding is something an operator, a rule, or
a failover turns on.

**The route a file takes is per-file, decided fresh, and written down before the
sends.** "Has this study been delivered?" is not answerable from the config
alone the moment routing can send a study to a subset of the nodes, so the
answer lives in a per-file record and the archive gate reads it back.

### From the wire to `received/`

`StorageSCP._handle_store` runs off the main thread, on whichever thread
pynetdicom's non-blocking server gives the association — `StorageSCP.start`
calls `ae.start_server(..., block=False)`. In order:

1. `_space_ok()` compares free space on the storage volume against
   `scp.min_free_gb`. Below the floor the handler returns `0xA700` **before
   touching the disk**, so the modality sees a failure it can retry rather than
   a truncated object. This is the only disk guard in the whole path; the
   outgoing and sent volumes have none.
2. `dest_path()` builds `PatientID/StudyInstanceUID/SeriesInstanceUID/
   SOPInstanceUID.dcm` (each component through `_safe()`) under the storage
   root, or a flat `SOPInstanceUID.dcm` when `scp.organize` is off.
3. `dicomfs.save_dicom` writes the dataset as a complete Part 10 file. It writes
   to the final path — there is no temp-and-rename here.
4. `_store_snapshot` reads a handful of tags for the dashboard's "last
   received". Every read in it is best-effort: telemetry must never be why a
   C-STORE fails.
5. `self.index.enqueue_dataset(ds, path, "received")` — the already-parsed
   dataset, flattened to a row on *this* thread and queued, so the association
   never waits on sqlite. A failure here is caught and logged as a warning; it
   costs a query result, not an image.
6. `on_received(ds, path)` — wired by `PacsServer.start_receiver` to
   `PacsServer._reconcile_study`, which matches the instance against an open RIS
   order and, while emergency failover is active, copies it into the outgoing
   folder. Any exception it raises is swallowed, deliberately: a bookkeeping
   callback may not kill an association.

`pacs/dicomweb.py`'s STOW-RS handler files into the same tree through the same
`scp.dest_path` and the same free-space check, so both protocols produce one
layout.

### How a file reaches `outgoing/`

There is no automatic bridge. A file is in the outgoing folder because one of
these put it there:

- **Emergency hold-and-forward.** `PacsServer._queue_for_forward`, called from
  `_reconcile_study` on the association thread while `emergency.active`, copies
  the received instance into `scu.watch_dir` and then pins the primaries onto
  its send-state entry. Why the pin exists and what it guarantees is in
  [Failover](#failover-what-it-actually-does); what the watcher does with it is
  step 8 below.
- **The review queue.** `ingest.approve_pending` converts a PDF or image into an
  Encapsulated PDF or Secondary Capture instance and writes it *into the watch
  folder* with `ingest.save_instance`, so the ordinary send-and-archive pipeline
  carries it. `PacsServer.create_study_from_order` does the same for a study
  captured against a RIS order.
- **Anything else writing into the folder** — an operator, a modality pointed
  straight at it, a script. The folder is the interface.

`ingest.save_instance` writes in place rather than to a temp name, and says why:
the filename is a freshly generated UID so it cannot collide, and the only thing
watching that folder refuses to forward a file until its size has held steady
across two polls.

### One watcher pass

`FolderWatcher._run` is a single thread that calls `_scan_once` and then waits
`scu.poll_interval`. Polling rather than inotify: identical on every OS and
reliable on network shares, at the cost of up to one interval of latency and a
second pass to clear the stability gate.

`_scan_once`, in order:

1. **`generation = self._config_generation()`** — a JSON fingerprint of the whole
   config object, taken *before* anything else is read off it. The order is
   load-bearing: a save landing between these lines is then seen as a change
   rather than folded into a fingerprint that still matches at the end.
2. Read the pass's working set once: watch/sent/pending dirs, calling AE,
   `on_success`, `Destination.from_dict` over `cfg.enabled_destinations()`, the
   client TLS context, `want` (the live enabled names), and
   `nodes = {name: routing.resolve_all(dests, [name])}` — a name to *list* of
   nodes, never a `{name: node}` map, because a hand-edited config can carry two
   enabled nodes under one name and a dict would silently keep the last.
3. `self.router.update(cfg.routing, [d.name for d in dests])` and
   `deider = self._deidentifier()`. The router is long-lived (it owns the header
   cache and the warn-once memo) and re-pointed each pass; the de-identifier is
   rebuilt only when `cfg.deid` actually changes, and the old one is dropped
   *before* the attempt so a failed rebuild can never leave the pass forwarding
   under settings the operator replaced.
4. `_candidates()` walks the watch tree, skipping dotfiles and skipping the sent
   and pending folders even when they are nested inside it. Membership is
   `dicomfs.is_dicom` — the `DICM` magic at offset 128, not the extension.
5. Per file: `_config_moved(generation)` first (abandon the rest of the pass if
   the operator saved), then the **stability gate** — non-zero size, unchanged
   since the previous pass. A file that passes is added to `evaluated`, which is
   the set the archive gate will later accept as judgeable.
6. `entry = self.state.get(path, size, mtime)` returns the live entry, resetting
   it if the bytes changed. `_reopen_repointed(path, entry, nodes)` then
   un-marks any destination whose *name* now resolves to a different
   host/port/called-AE than the one recorded in `entry["sent_to"]`.
7. **`decision = self.router.route(path).honoured_by(deider)`.** Both halves of
   the de-identification question in one object: `route()` applies the rules and
   the global profile, `honoured_by()` settles it against the de-identifier this
   pass will actually use. `_announce_hold` then says on the send channel what
   is being withheld and why.
8. `routing.record_route(entry, decision)` stamps `route` / `deid` / `held` (and
   `hold_cause`) onto the entry and unions in any pins, then `state.put`. This
   happens **even when nothing is due**: an entry with no `route` is never
   considered fully sent, so an unstamped file would sit in the folder forever.
9. `todo` = names in `entry["route"]` that are still enabled, not yet in
   `entry["sent"]`, and past their backoff deadline. The *recorded* route is
   walked, not `decision.destinations`, so a pinned delivery is due like any
   other.
10. `scrub = {n for n in todo if decision.needs_deid(n)}`. Un-scrubbed names go
    to `_send_to_name(path, path, ...)`; scrubbed ones are sent from a temp copy
    produced by `deid.deidentified_tempfile(path, deider)` — the original is
    opened read-only and stays byte-identical, because rewriting it in place
    would move its size/mtime and `SendState` would read that as a new file and
    forward the whole study again. `_config_moved` is re-checked between every
    single send, including between two sends of the same file.
11. `_send_to_name` calls `scu.c_store` once per node behind the name: one file,
    one destination, one association each. The name is recorded as sent only
    when *every* node behind it accepted, because `entry["sent"]` holds names
    and a partial success cannot be written down. Success → `_note_success`
    appends the name and stamps `entry["sent_to"][name]` with
    `_node_fingerprint(nodes)`. Failure → `_note_failure` bumps `attempts`,
    stores `last_error`, and sets `next_try` from `_backoff()` (base is
    `poll_interval` with a floor, doubling, capped by `_BACKOFF_CAP`). The file
    is not touched either way.
12. `_archive_pass(...)`, then one `state.save()` for the whole pass.

`scu.c_store` reads the file whole — pixels included, because this dataset *is*
the payload — before associating, so an unreadable file is reported without a
socket being opened and the transfer syntax proposed is the one the file
genuinely carries. `0xB000/0xB006/0xB007` count as success: reading a "stored,
with a caveat" as failure would mean the destination is never written down as
done and the study never becomes archivable — a permanent resend loop against a
node that already holds the images.

### The archive pass

`_archive_pass` runs only when `scu.on_success` is `move` or `delete`; `keep`
leaves everything in place. It iterates the **top-level** items of the watch
folder, skips the sent and pending folders, and for each item collects every
DICOM under it with `_dicoms_under`. The item is archived only if *all* of them
satisfy `_fully_sent`:

- the file is in `evaluated` (this pass re-routed it against the live config);
- its live `(size, mtime)` still matches the entry;
- `routing.wanted_from` is non-empty — "owes nobody" is not "delivered to
  everybody";
- nothing in the recorded route dropped out unsent (a name that left the config
  still owing the file blocks the archive and is warned about on a timer);
- and `routing.fully_sent` — every still-enabled routed name is in `sent`, with
  a held name enough on its own to keep the answer False.

Then, immediately before anything destructive, the config fingerprint is
re-checked **per item** — a large study takes time to move, and the item after
it must not run under a config the operator replaced halfway down the list.

`_siphon_pending` moves any PDF or image sitting beside the study into the
pending review queue first (`ingest.stage_pending`, identity pre-filled from a
sibling DICOM header by `_study_identity`), so what follows only handles DICOM
and inert files. Then `shutil.rmtree`/`os.remove` for `delete`, or
`_merge_move`/`shutil.move` with `_dedupe` into `sent/` for `move` — everything
goes, subfolders and non-DICOM alike, so no empty shells are left behind.
Finally `state.drop(f)`, `self._sizes.pop(f)`, `router.cache.forget(f)` and
`index.enqueue_remove(f)` per file, and for a move, `index.enqueue_file(f,
"sent")` over the paths read back *off disk* — `_dedupe` may have renamed one.

### The flow

```
modality ──C-STORE──▶ StorageSCP._handle_store          [association thread]
                        │ _space_ok()  → 0xA700 refused BEFORE any write
                        │ dest_path() → save_dicom()
                        ▼
                  received/  (scp.storage_dir)
                        │ index.enqueue_dataset(ds, path, "received") ─▶ [pacs-index] ─▶ sqlite
                        │ on_received → PacsServer._reconcile_study (RIS match)
                        │
                        │ NO automatic bridge. A file is in outgoing/ because of:
                        │   • _queue_for_forward + state.pin   (emergency hold-and-forward)
                        │   • ingest.approve_pending / create_study_from_order
                        │   • an operator or another tool writing into it
                        ▼
                  outgoing/  (scu.watch_dir)
                        │
   [pacs-watcher]  FolderWatcher._scan_once, every scu.poll_interval
        generation = _config_generation()          ← taken FIRST
        _candidates()      walk; skip sent/ + pending/; is_dicom() only
        stability gate     size non-zero and unchanged  → path joins `evaluated`
        _reopen_repointed  a name that moved machine is owed the study again
        Router.route(path).honoured_by(deider)     ← the ONE de-id answer
        routing.record_route(entry, decision)      → entry: route / deid / held
        todo = route ∩ enabled − sent − backing-off
          ├─ plain  ─▶ _send_to_name(path)      ─▶ scu.c_store ─▶ peer
          └─ scrub  ─▶ deid.deidentified_tempfile(path, deider)   (0600, system temp)
                        └─▶ _send_to_name(tmp)  ─▶ scu.c_store ─▶ peer
        _note_success → entry["sent"] + entry["sent_to"][name] = host:port|aet
        _note_failure → entry["fail"][name] = attempts / last_error / next_try
        held names    → never dialled at all
                        │
        _archive_pass  (only when on_success is move|delete)
          all DICOMs under the item _fully_sent?  AND fingerprint unmoved?
          _siphon_pending ─▶ pending/     then  move ─▶ sent/   or  delete
                        │
                  sent/  (scu.sent_dir)
                        │ index.enqueue_remove(old) + index.enqueue_file(new, "sent")
        SendState.save()   ← once, at the end of the pass
```

### Ownership and locks on this path

The thread inventory is in [The shape](#threads-once). What matters here is
which of those threads may touch which object.

- **Association threads** own the received tree: they are the only writer into
  it apart from STOW-RS. `StorageSCP._lock` guards nothing but the counters and
  `last_stored`, and the snapshot is built outside the lock and assigned inside
  it, so the critical section stays two attribute writes and a reader never sees
  a half-filled dict. Under emergency failover these threads also write into the
  outgoing folder and take `SendState`'s lock through `state.pin`.
- **`pacs-watcher`** owns the outgoing folder and the sent folder. It also owns
  `self._sizes` (the stability map), `self.router` and `self._deider` — none of
  which are locked, because nothing else touches them.
  `FolderWatcher._lock` guards only the dashboard-facing counters
  (`sent_count`, `failed_count`, `last_activity`, `last_sent`), which is what
  `stats()` reads.
- **`SendState`** is the shared one: the watcher rewrites entries every pass,
  association threads pin into it, and Flask worker threads read it
  (`all_entries` for the stuck panel) and write it (`clear_backoff` for Retry).
  Its lock guards **the map** — which paths are known and which entry object
  each holds — and deliberately not the entries: `get()` hands back the live
  entry so the watcher mutates it in place and `put()` writes the same object
  back. `all_entries()` is the exception and deep-copies, because its caller is
  somewhere else entirely. Nothing reaches disk until `save()`, which the
  watcher calls once per pass; `save()` is temp file plus `os.replace`, so a
  reader sees the whole old map or the whole new one, never a half-written
  document that would read as "nothing has been sent".
- **`pacs-send`** is the dashboard's manual forward (`PacsServer.send_study`), a
  second sender over the same decision layer. It reads from the received or sent
  tree, routes per file exactly as the watcher does, writes **no** send state and
  archives nothing, and borrows `watcher._lock` only to move the dashboard's
  counters. It freezes a config view (`_SendConfig`) for its router and
  de-identifier and re-checks the live config before every C-STORE, holding the
  destinations whose de-identification promise moved rather than stopping the
  study's other deliveries mid-flight.

### The decisions

Several of these are recorded in the module docstrings; this is where they sit
relative to each other.

**Polling, not inotify.** Identical on every OS and reliable on network shares.
The price is latency and a mandatory second pass per file.

**A stability gate instead of a lock file or an atomic rename.** The watcher
cannot dictate how files arrive in its folder — a modality, a script and an
operator all write into it differently — so the only property it can rely on is
that a finished file stops growing.

**Routing over-sends and never under-sends.** Every path through
`Router.route()` that fails to produce a destination — routing off, no rule
matched, an unreadable header, a rule naming a node that no longer exists —
falls back to every enabled destination. A matched rule with no destinations is
a filter that drops through, and its `stop` is ignored, because honouring it
would mean "match this study and send it nowhere". An unknown key in a rule's
`match` skips the rule rather than being treated as "matches anything": a typo
must not silently widen a rule to every study in the department.

**The single exception: a scrub that cannot happen holds the delivery.** The
obvious routes were to let the rule win and treat `deid.profile` as a default,
or to reject the combination in config validation. The first makes "off" not
mean off and pushes the same split brain one layer down into every sender. The
second does not apply: the profile is edited on one dashboard card and the rules
on another, so "profile off *and* a rule scrubs" is a state two valid saves
arrive at, not an edit validation can refuse — and refusing it there would mean
a save that turns the profile off is rejected because of a rule the operator is
on their way to deleting. So the destination is held, not dialled at all, and
one edit releases it. A study waiting in the outgoing folder is recoverable;
identity that has arrived at an outside node is not.

**Both halves of that question live in `Decision`, and `honoured_by` is the only
door.** The open-coded alternative — `scrub = {n for n in todo if deider is not
None and decision.needs_deid(n)}` — yields a set narrower than the decision
promised whenever the de-identifier is missing or disabled, and every name in
the gap goes out in the clear while the decision, the log and the dashboard all
call it de-identified. In the shape used now a name can only leave `deid_dests`
by landing in `held`, and a held name is already out of `sendable`, out of the
route `record_route` stamps, and enough to keep `fully_sent` False. Narrowing
what gets scrubbed and narrowing what gets sent became the same edit.

**A hold has two causes and they are not interchangeable.** `HOLD_PROFILE_OFF`
comes out of `Router.route()`; `HOLD_NO_DEIDENTIFIER` comes out of
`Decision.honoured_by`. The remedies are opposite, so `hold_cause` travels with
the names into the send state and out through the stuck panel, and
`Router._emit_warnings` names only the cause it can actually see — the sender's
de-identifier is invisible from inside the router.

**De-identification travels on a copy, and only outward.** The archived original
is never rewritten. Beyond the obvious reason, rewriting in place would move the
file's size and mtime, which `SendState` reads as new content — the whole study
would be forwarded again.

**A pass acts only on the config it began under.** The alternative was
re-reading the router and the de-identifier per file, which keeps throughput but
half-applies a save by construction: one instance of a study ships under the old
settings and its neighbour under the new, with the destination list, the node map
and the TLS context still stale around them because they were resolved before the
loop. Abandoning is one rule for the whole pass and cannot deliver a mixture. It
costs one poll interval, once, per save.

**The recorded route is only trustworthy in the pass that wrote it.** Hence
`evaluated`: the archive gate refuses to judge a file this pass did not
re-route. The first pass after a restart writes no records at all — the
stability map starts empty — which is exactly when the stalest routes would
otherwise be read.

**A destination name is not a machine.** `entry["sent"]` records names, and an
operator can re-point a name at another host, port or called AE. The generation
fingerprint only defers a pass; the staleness is in the *record*, so
`_reopen_repointed` fixes it there, which is also why it works between passes and
not only inside one. A name with no recorded address is adopted rather than
re-sent, so an upgrade does not re-transmit the entire outgoing folder.

**One name may resolve to several nodes.** `config.validate()` refuses duplicate
destination names, but a hand-edited file bypasses it, so `resolve_all` returns
a list and `_send_to_name` sends to all of them, marking the name sent only when
all accepted. That over-delivers on a partial failure; it cannot archive behind a
node that missed out.

### Failure modes

**A peer is down.** `scu.c_store` returns `ok=False` with a message written to
survive being pasted into a support thread — refusal, timeout, a TLS handshake
that fails and a host that is simply off all come back the same way, as a result
rather than an exception. `_note_failure` records attempts, the error and a
backoff deadline; the file is untouched, stays in the outgoing folder, is
retried on the next eligible pass, and appears in the stuck panel's
`destinations` list where an operator can hit Retry (`state.clear_backoff`).
Nothing ever gives up. Sustained failure also feeds `pacs/emergency.py`, which
combines it with an active C-ECHO probe to raise the failover prompt.

**A destination is renamed, deleted or disabled while it still owes a file.**
Nothing retries it — there is no node left to dial — and the watcher will not
archive or delete the study either. It is re-announced on a timer
(`_warn_stale_route`, `_STALE_REWARN`) and listed separately in the stuck panel
as `orphaned`, because the operator action is different and a Retry button would
be a lie on it. This is the one failure here with no self-correcting end: the
outgoing folder grows until someone restores the node or accepts the loss.

**A destination is held.** Never dialled, so it never fails, so the backoff list
cannot see it; and `record_route` keeps it out of `entry["route"]`, so the
orphan list cannot either. It is reported as its own `held` list carrying its
`hold_cause` and the matching remedy. Nothing releases it but an edit.

**The disk fills.** On the receive side `_space_ok` refuses the C-STORE before
writing and the modality gets `0xA700`. Everywhere else there is **no floor at
all**: a full outgoing or sent volume surfaces as an `OSError` out of the
archive move, logged as `Could not move/delete …` and retried next pass; a full
pending volume surfaces as `Could not queue … for review` and leaves the file
where it is. `SendState.save()` swallows a failed write and leaves the map
marked dirty so the next save carries the same change — but if the process dies
first, the deliveries that pass made are re-sent (duplicates, idempotent by SOP
Instance UID, never a lost image).

**A file is corrupt.** Three points, three different answers. Without the `DICM`
magic it is not a candidate at all and the watcher never sees it — though the
archive pass's siphon may still recognise it as a PDF or image and queue it for
review. With the magic but an unparseable header, `HeaderCache._read` returns
`None` and `Router.route` sends it to every enabled destination with a warn-once
line, rather than guessing or dropping it. If `dcmread` fails inside
`scu.c_store` it is a send failure — `unreadable (…)` — which means it retries
forever under backoff, never archives, and pins its whole study in the outgoing
folder. **There is no quarantine folder and nothing eventually gives up on such
a file**; it stays visible in the stuck panel and a human has to remove it.

**A scrub fails mid-pass.** Treated as a send failure for every destination in
the scrub set, never as a skip: the file stays, goes into backoff and shows up
as stuck. Forwarding it unscrubbed would leak exactly the PHI the rule exists to
remove. A de-identifier that cannot even be *built* is contained inside
`_deidentifier()` rather than allowed out of the pass — a watcher that stops
sending is worse than one that stops scrubbing, and everything a scrub was owed
to is held anyway.

**A thread dies.** `FolderWatcher._run` wraps each pass in `try/except
Exception` and logs `Watcher pass failed: …`, so an ordinary error costs one
pass and the loop continues. Anything that escapes that ends the thread, and
nothing supervises it (see [Threads, once](#threads-once));
`EmergencyController` restarts a stopped watcher only when failover activates or
recovers. In the SCP, a handler exception becomes `0xA700` and the association
survives; an `on_received` exception is swallowed entirely.

**The process is killed mid-pass.** `SendState` persists once at the end of a
pass, so deliveries that pass had already made are offered again after the
restart. A file half-written into `received/` by an interrupted `save_dicom`
stays there: nothing detects it, and an index rescan skips it as unparseable. A
file half-written into `outgoing/` never clears the stability gate on its own —
and never leaves either, because nothing ages a file out of that folder.

**The operator saves mid-pass.** `_config_moved` is checked before each file and
before each send, and the archive gate re-checks per item. The pass abandons
what is left of itself with `state.save()`, the files stay in the outgoing
folder with their sizes already in the stability map, and the next pass
re-routes and re-sends them under the config as saved.

---

## Somebody asking what this appliance holds

Two protocols answer that question. An old ultrasound opens a DIMSE association
and sends C-FIND; OHIF sends `GET /dicom-web/studies`. They arrive on different
ports, on different kinds of thread, under different standards with
contradictory rules about what an answer may omit. They meet in one place:
`pacs/index.py`, one SQLite table with one row per stored *file*.

Neither protocol ever serves data out of that table. It hands back a `path`, and
the delivery re-opens the file.

```
  C-FIND / C-MOVE / C-GET               QIDO-RS / WADO-RS / STOW-RS
  DIMSE, one thread per association     HTTP, one thread per request
            |                                        |
        pacs/qr.py                            pacs/dicomweb.py
     query_filters(identifier)              _parse_filters(request.args)
            |                                        |
            +--------------------+-------------------+
                                 |
                   {DICOM keyword: match value}
                                 |
                   pacs/index.py   InstanceIndex
       query_studies() / query_series() / query_instances()
              one table, one row per file on disk
                                 |
                    rows carry `path`, and only `path`
                                 |
            +--------------------+-------------------+
            |                                        |
    dcmread(path) -> C-STORE               open(path) -> one part of a
    sub-operation over a second            multipart/related body,
    association pynetdicom opens           streamed in chunks
```

### The DIMSE path, in order

`PacsServer.start_qr()` refuses to bind at all when `self.index is None`. That
is deliberate and the comment says why: a Q/R port with no index behind it
advertises an archive that reports itself empty to every modality that asks,
which is worse than not answering. So the first link in this chain is a startup
error, not a runtime fallback.

`QrSCP.start()` builds the AE, adds the Find/Move/Get information models at
Patient Root and Study Root plus `Verification`, and adds every storage context
with `scp_role=True, scu_role=False` — that flag pair exists solely so C-GET can
reverse the roles and push instances back down the requestor's own association,
without this port ever advertising itself as somewhere to *push* images. Then
`ae.start_server(block=False)`.

**C-FIND** lands on `QrSCP._handle_find`, a generator running on the
association's thread:

1. `_level(query, model)` normalises `QueryRetrieveLevel` through `_LEVEL_ALIASES`
   (`INSTANCE` and `COMPOSITE` both mean `IMAGE`), and when the identifier
   carries no level at all it assumes the model's root rather than refusing —
   non-conformant but common on old kit. `PATIENT` on a Study Root model returns
   `None`, which is a refusal with `0xC000`.
2. `query_filters(query)` translates the identifier into a filter dict. An
   element with an *empty* value is a return key, not a match key, and is
   dropped — passing it through as `""` would mean "this field is empty" instead
   of "match everything". Anything outside `_MATCH_KEYS`, and any sequence that
   actually carries items, goes into `ignored`.
3. `_find_rows(level, filters)` calls the index: `query_studies`, `query_series`
   or `query_instances`. `PATIENT` is the exception — it asks for every matching
   study with no limit and folds them in `_patient_rows`, because the index has
   no patient table on purpose.
4. Each row goes through `build_response(level, row, query, self.aet)`, which
   returns the response dataset *and* the list of keys it could not answer.
5. Each is yielded as a pending response, `0xFF01` when either `ignored` or
   `unsupported` is non-empty, plain `0xFF00` otherwise. Between rows the
   generator checks `event.is_cancelled` and the per-run `_stopping` event and
   bails with `0xFE00`.

**C-MOVE** lands on `_handle_move`, and the order of the yields is dictated by
pynetdicom: destination first, then the sub-operation count, then one yield per
instance.

1. `resolve_move_destination(event.move_destination)` checks
   `qr.move_destinations`, then falls back to matching an ordinary configured
   destination by AE title — a node the operator already configured and
   echo-tested is a node they trust. No match is a refusal (`yield None, None`);
   a host is never guessed.
2. `_retrieve_rows(query, level)` requires the identifier to carry the level's
   key from `_RETRIEVE_KEYS`. Without one, the request selects the whole
   archive, which is never what anyone meant, so it is refused. With one, it
   calls `index.query_instances(filters=..., limit=0)` — everything, no paging.
3. `_retrieve_contexts(rows)` builds the sub-association's presentation contexts
   straight out of the rows' `sop_class_uid` and `transfer_syntax_uid` columns.
   No file is opened to work out what to propose; the index already knows, and
   pynetdicom does not transcode, so proposing anything else would only produce
   a context the destination cannot use. Capped at `_MAX_CONTEXTS`, which is the
   DICOM ceiling per association.
4. The destination tuple is yielded, with `tls_args` built from
   `PacsServer._scu_tls_context` so an outbound C-MOVE presents exactly the
   client certificate an outbound auto-forward would.
5. `_yield_instances` is shared with C-GET: `dcmread(path)` per row, yield
   `0xFF00` with the dataset. A file that cannot be read is **not skipped** —
   its SOP Instance UID is collected in `broken` and the generator ends with
   `0xA702` (nothing sent) or `0xB000` (some sent) carrying the Failed SOP
   Instance UID List, so the SCU learns exactly which images it did not get.

**C-GET** is `_handle_get`: the same identifier resolution and the same
`_yield_instances` body, minus the destination lookup, with pynetdicom
C-STOREing back over the association that asked.

### The HTTP path, in order

The blueprint is registered unconditionally in `web.py` and gated per request,
so ticking "DICOMweb" in Settings does not require an engine restart — every
other service in this app applies from config live, and this one matches.

A request crosses three gates before it reaches a route: `auth.install()`'s
credential check; `web.py`'s `_guard_dicomweb`, which refuses restricted user
profiles outright because QIDO answers in tag keys and WADO answers raw Part 10
bytes, neither of which the dashboard's identifier redactor can reach (the full
argument is at the function, and the profile model is in
[Who is asking](#who-is-asking-and-what-they-may-do)); and the blueprint's own
`_gate`, which is a 503 when `dicomweb.enabled` is off **or** when
`server.index` is `None`. Same rule as the Q/R port, different mechanism: no
index, no query service.

**QIDO-RS** — every one of the query routes is `_qido(level, ...)`:

1. `Accept` must admit `application/dicom+json`, else 406.
2. `_parse_filters(request.args)` returns filters plus warnings; a key the index
   cannot match is named in a `Warning` header rather than silently ignored,
   because a filter that does nothing returns too *many* studies and looks like
   it worked.
3. `_parse_paging` and `_parse_include`, then the same three index methods
   `qr.py` calls.
4. Each row is built by `_study_object` / `_series_object` / `_instance_object`,
   all three in the same order: seed the level's required attributes blank with
   `_blank()`, write the index row's real values over the top, and only then
   spend a header read on `includefield` extras. The read is last because it is
   the only step that opens a file, and the budget `reads_left` is one mutable
   cell shared by the whole page, not per row — `includefield` is what turns a
   query into file opens, and the cost that has to be capped is the page's.
5. No match is 204 with no body, not 200 with an empty array. Soft problems — a
   dropped matching key, a capped limit — ride in a `Warning` header on an
   otherwise normal response. A row that cannot be rendered is reduced to its
   Study Instance UID and logged, so the study stays retrievable.

**WADO-RS** — `_rows_for()` calls `query_instances(..., limit=0)` and re-sorts
series-then-instance. The index orders instances by InstanceNumber alone, which
at study level interleaves the series; nothing is lost, but a viewer rendering
parts as they arrive shows the study assembling itself out of order for the
whole download. `limit=0` is the load-bearing part: retrieval is the one place
paging must not happen, because a page boundary hands a viewer a study short by
however many instances with a 200 on it.

`_retrieve()` then checks `Accept`, checks each row's stored transfer syntax
against any the client demanded (a mismatch is 406 — this server does not
transcode), and runs every path through `servable()`, which is `safe_within()`
against the three storage roots plus `os.path.isfile`. Files that are gone are
counted and the response becomes 206, the standard's way of saying "this is the
study minus what we could not read". `_multipart_response` streams a generator
with a fresh random boundary per response, because the parts are whole DICOM
files whose bytes are arbitrary and any delimiter fixed in the source is one
that some instance's pixel data eventually contains.

`/metadata` and `/frames` both go to the index for the row and then read the
*file*, not the row — metadata means everything the modality sent, and the index
holds only the columns queries match on.

**STOW-RS** goes the other way and is worth naming here because it is the one
write on this path: `store_instance()` uses `scp.dest_path` and the same
free-space floor as a C-STORE, then writes the index row **synchronously** via
`add_dataset`. Everywhere else the row is queued; here it is not, because a STOW
client routinely queries for what it just posted and a background write would
make that round trip a race.

### `servable()` is the sentence that defines the index

> "The index is a cache, not an authority: a poisoned or stale row must never
> talk us into reading outside the storage roots."

That check belongs to `dicomweb.py` and covers the HTTP path only: QIDO's
`includefield` header reads, every WADO retrieve, `/metadata` and `/frames` all
go through `servable()` — `safe_within()` against the three storage roots plus
`os.path.isfile` — so there the index decides *which* files answer a question
and never *what may be read*. The DIMSE side has no equivalent:
`_yield_instances` opens whatever path the row carries. Both protocols read the
same table, and only one of them re-checks it before opening.

### Who writes the index, and when

| Trigger | Call | Thread it runs on |
| --- | --- | --- |
| C-STORE accepted | `enqueue_dataset(ds, path, "received")` | the association thread — header flattened there, sqlite touched nowhere near it |
| STOW-RS part filed | `add_dataset(...)` | the Werkzeug request thread, synchronously |
| Watcher first sees an outgoing file | `enqueue_file(path, "outgoing")` | the watcher's poll thread |
| Watcher archives after a successful send | `enqueue_remove(f)` then `enqueue_file(f, "sent")` | the watcher's poll thread |
| Ingest capture / pending approval / attachment | `enqueue_file(out, group)` | the API request thread |
| Study or group deleted from the dashboard | `remove_under()` / `remove_group()` | the API request thread, synchronously |
| Startup, when `index.rescan_on_start` | `rescan()` | `pacs-index-scan` |
| Dashboard "Rescan", or a save that repoints the DB | `rescan()` | `pacs-index-scan` |

The groups are `received`, `sent` and `outgoing`, resolved by
`PacsServer._index_roots()` from `scp.storage_dir`, `scu.sent_dir` and
`scu.watch_dir`. The dashboard calls the second one `archived`; `_index_group()`
is the one-line translation, and it exists because the browser and the index
name the same tree differently.

Removals and adds share the single queue on purpose, so a delete can never
overtake the add it is meant to undo — that is the archive step's whole
correctness argument, since it removes the outgoing rows and adds the sent ones
in the same breath.

### Rescan: what makes it safe to run at any time

`rescan(roots, purge=True, stop=event)` walks each root, stats each file, and
skips any whose size and mtime already match its row. Everything it saw goes
into a per-connection TEMP table, `scan_seen`, so the "seen" set stays flat in
memory regardless of archive size.

Three guards decide whether the purge at the end is allowed to run, and each
closes a way of deleting a row for a file that exists:

- **Cancelled walk.** A partial walk cannot tell "gone" from "not reached yet",
  so a cancelled scan purges nothing.
- **A failed batch.** If a write batch failed, those files are missing from
  `scan_seen` too, so the purge is skipped rather than deleting rows for files
  sitting on disk.
- **`indexed_at < started`.** A C-STORE that lands mid-walk writes a row that was
  never eligible for the seen set. The watermark is what stops the purge deleting
  a study that arrived while the scan was running.

The walk offers *every* file to `is_dicom()`, hidden ones included, because the
walk must accept exactly what `add_file` accepts. Anything the walk declined but
`add_file` had indexed would be purged while still on disk. Sidecar files cost
one failed magic-byte read each, which is the cheaper half of that trade.

### Connections and locks

**Connection ownership.** A sqlite connection is not safe to share across
threads with a transaction open, and `check_same_thread=False` only silences the
guard rather than making sharing correct. So each thread gets its own connection
out of a `threading.local`, `check_same_thread` stays **on** for a file index
precisely as proof that the per-thread discipline holds, and WAL lets readers
run while a write is in flight. `:memory:` is the one exception — per-thread
connections there would each get a private empty database, so that mode keeps
one shared connection and serialises *reads* through the lock as well.

`_conn()` stats the database file on every call and compares `(st_dev, st_ino)`
against what this thread's handle was opened on. An open handle keeps working
happily against an unlinked inode, so without that check a deleted or replaced
database file would swallow every subsequent write into a file nobody can read.

**Locks.**

- `InstanceIndex._lock` (an `RLock`) covers every write transaction, so two
  threads can never hold `BEGIN IMMEDIATE` at once; it also covers writer
  start/stop bookkeeping, the rescan's temp-table create and drop, and — in
  `:memory:` mode only — reads. File-index reads take no lock at all; WAL is
  what makes that correct.
- `PacsServer._lock` owns the worker objects and the rescan thread handles.
  `stop_index()` deliberately joins the rescan thread *outside* it, because a
  rescan pass takes the same lock to publish its result and joining under it
  would deadlock.
- `QrSCP._lock` and `StorageSCP._lock` cover counters only. `DicomWebStats` has
  its own.
- `QrSCP._stopping` is a fresh `threading.Event` per run, polled by the retrieve
  generators between instances. `apply_config()` stops and immediately restarts
  the object, so `stop()` must not return while a C-MOVE is still streaming —
  that thread would keep logging and counting against an object the dashboard
  has already replaced. A fresh event per run is also what stops a straggler
  from a timed-out join being un-stopped by the next start.
- `InstanceIndex.start()` allocates a fresh `Event` **and** a fresh `Queue` per
  run, for the same reason one level down: a straggler writer must drain *its*
  queue and see *its* stop flag, never the new run's, or two writers fight over
  one backlog.

**Schema creation is the cold-boot race.** `_ensure_schema` does the whole
sample-drop-create-stamp inside one `BEGIN IMMEDIATE`. Sampling, creating and
stamping as separate autocommitted statements meant a second thread opening its
own connection between the CREATE and the stamp saw version 0, called it an old
layout, and dropped the table the first thread had just built — every query in
flight then died with "no such table: instances". Cold boot is exactly when that
happens: the rescan thread, the writer, a QIDO request and the Q/R SCP all
first-touch the database at once, which is the normal startup sequence. The
schema is applied statement by statement rather than through `executescript`,
because `executescript` commits whatever transaction is open before it runs and
would tear apart the very transaction this needs to hold.

### The decisions

**Matching lives in SQL, once.** The obvious route is to pull rows and filter
them in Python, where wildcards and ranges are easy to read. `qr.py` refuses:
the index already implements DICOM matching — universal, single value, `*`/`?`,
backslash-separated UID lists, `a-b` ranges — so a C-FIND is a translation into
a filter dict and nothing more. Two implementations would drift, and a Q/R that
quietly disagrees with the archive's own study list is how images go missing.
(`mwl.py` matches in Python for the opposite reason, which belongs to worklists
alone — see [Orders, worklist](#orders-worklist-and-standing-in-for-a-ris).)

**One row per file, everything else aggregated.** There is no study table and no
patient table. Study and series answers are `GROUP BY` over the instance rows,
and the Q/R patient level is folded in `_patient_rows` from the same study rows
a STUDY query would return. A stored summary can drift out of step with what it
summarises; a computed one cannot.

**A filter below the query's level becomes a subquery, not a WHERE.** `_build`
pushes anything below the caller's level into `subquery_key IN (SELECT ...)`.
Filtering a study query on Modality must select the study without shrinking that
study's instance count — otherwise a viewer asked to find CT studies is told how
many CT instances they have and calls it the study size.

**Combined date-and-time matching is off by default.** PS3.4 C.2.2.2.5 gives a
DA range paired with a TM range two readings. The default intersects them:
`StudyDate=20060705-20060707` with `StudyTime=100000-180000` means 10:00–18:00
on each of those days, not the single span from the first at 10:00 to the last
at 18:00. The span reading is a negotiated extension, and applying it unasked
silently *widens* every date+time query past what the SCU wrote — the one
direction a query must never drift on its own.

**The two protocols answer "we hold no value for this" in opposite ways, and
that is correct.** PS3.4 C.2.2.1.3 says an SCP shall not return Optional Keys it
does not support, so `build_response` **omits** a key the index cannot answer and
downgrades the pending status to `0xFF01` to say so; returning it zero-length
would claim it looked and found nothing, which is how an SCU concludes a patient
has no birth date rather than that it asked the wrong archive. PS3.18
Table 10.6.1-5 makes the level's required attributes mandatory in *every*
response, so `dicomweb.py` emits exactly those as zero-length via
`_REQUIRED_BLANK`, because a viewer keying on the presence of `Rows` reads an
absent one as a malformed result. Both docstrings say the same thing: two
standards, two rules, do not unify them.

**Paging is fine for a question and forbidden for a delivery.** C-FIND caps at
`_MAX_MATCHES` and says so loudly in the log; QIDO caps at `_QIDO_MAX` and puts
the truncation in a `Warning` header. C-MOVE, C-GET and every WADO retrieve pass
`limit=0`. A short answer to a query is a narrower question; a short delivery is
a missing image.

**Retrieve contexts come from the index, refusals get a fallback set.**
`_retrieve_contexts` reads SOP class and transfer syntax off the rows. But
pynetdicom's move flow makes the SCP open the sub-association *before* it can
answer with a real status, and a refused C-MOVE has no rows and therefore no
contexts. If the destination accepts nothing we propose, the requestor aborts
and pynetdicom reports `0xA801` "Move Destination unknown" — sending the operator
to look at their move-destination configuration instead of at the identifier
they sent. `_fallback_contexts()` proposes Verification plus storage contexts so
that never happens.

**The outgoing watch folder is servable over WADO.** Files waiting there are
indexed, so QIDO already lists them. Dropping them from WADO would answer "here
is your study" and hand back only the copies that happen to have been forwarded
already. Nothing extra is exposed: `servable()` serves only paths the index
holds, and the index holds parsed DICOM.

**No migrations.** Bumping `SCHEMA_VERSION` drops the table and rebuilds it
empty, and the log tells the operator a rescan is needed. Nothing in the index is
irreplaceable, so a migration path would be more code than a rebuild, forever.

**The dashboard's own study browser does not use any of this.**
`PacsServer.list_studies()` calls `history.scan_studies()`, which walks the tree
and reads one header per directory. Serving it from the index was built and taken
back out, and `history.py`'s docstring records why:

- The index *normalises* — SeriesNumber into an INTEGER column, StudyDate to bare
  digits, Modality upper-cased — so a header carrying `003` or `2024.01.15` came
  back different from the two paths, and because the series list sorts on that
  string it came back in a different **order** too.
- The index cannot say whether it is complete. A first rescan halfway through its
  batches reads exactly like a small archive.
- A row left behind by a folder removed out of band becomes a study that is not
  on disk — which widens a multi-folder study's `path` to a common ancestor. That
  ancestor is what the delete button is then pointed at.

The browser groups by **directory**, not by SeriesInstanceUID: one header per
folder stands for the whole folder, so a series stored in two folders is listed
twice and two series sharing a folder are listed once. It describes the shelf,
not the catalogue, and an operator hunting for a study on disk needs the shelf. A
browser whose job is to hand an operator a path to delete has to have looked at
the path.

That is the whole distinction: **the index answers what we hold; the browser
answers what is on this disk right now.** They are allowed to disagree, and when
they do, the disk is right.

### When it is stale, and when it is absent

**Absent.** `index.enabled: false` leaves `PacsServer.index` as `None`. Q/R will
not start (`start_qr` raises), DICOMweb answers 503 at the gate, and everything
that writes to the index is written `if self.index is not None`. Receiving,
forwarding, printing, worklist and the dashboard browser all keep working.
Turning the index off costs the query protocols and nothing else.

**Rebuilt.** A schema bump leaves an empty table, a warning in the log, and
`rebuilt: true` in the dashboard's index block. Until a rescan finishes, both
protocols answer honestly and emptily. `_sync_index()` covers the same hole after
a save that repoints the database or switches it back on: it kicks a rescan
immediately, because an empty index is a PACS that reports itself empty to every
modality that queries it.

**Behind the disk.** Rows that do not exist yet — files copied in behind the
appliance's back, or anything written while the writer was down — are simply not
findable. Nothing detects this on its own. `rescan_on_start` covers the boot
case; `POST /api/index/rescan` covers the rest, and it returns immediately with
the result landing in the Activity log. There is no periodic rescan.

**Ahead of the disk.** A row whose file is gone survives deliberately.
`get_instance_path` skips rows whose file no longer exists but does **not**
delete them — an unmounted share must not empty the index — and the next
rescan's purge is what prunes them. Downstream, a stale row is a failed
sub-operation named in the Failed SOP Instance UID List for C-MOVE, and a 206
(or a 404 when nothing under the resource is readable) for WADO.

### Failure modes

**A C-MOVE destination is down.** Nothing in `qr.py` handles it. The
sub-association is pynetdicom's to open and pynetdicom's to report; the only
accommodation this code makes is `_fallback_contexts`, and that exists to stop a
*context* mismatch masquerading as an unknown destination. Two things follow that
are worth knowing before reading the counters: `sent_count` is incremented when
an instance is handed to pynetdicom, not when the destination acknowledges it,
and `move_failures` is `refused_count + failed_count` — refusals and unreadable
files. A destination that accepts the association and then rejects the stores is
not in either number. The wire status the SCU receives is still correct; it is
the dashboard's tally that is narrower than its name suggests.

**The disk is full.** On the way in, STOW's `_space_ok()` mirrors the Storage
SCP's guard and refuses *before writing*, so the instance comes back in the
FailedSOPSequence with `0xA700` and the response is 202 or 409. It fails open
when the volume cannot be probed. On the index side the picture is different and
worth being blunt about: `_write` retries once on a fresh connection, then
increments `errors`, logs a warning, and `_flush_batch` swallows the exception.
The image is on disk and the log says so, but the row is missing and **nothing
retries it**. That study is unfindable by either protocol until somebody runs a
rescan. The `errors` counter in the dashboard's index block is the only standing
signal.

**A file is corrupt.** `_row_from_file` returns `None` for anything `is_dicom`
rejects or pydicom cannot read — unparseable is skipped, never fatal. A rescan
counts it under `failed` in its log line, and it never enters the index, so no
query can offer it. A file that parsed at index time and cannot be read at
retrieve time is the case both protocols handle explicitly: C-MOVE names it in
the Failed SOP Instance UID List, WADO turns the response into a 206, and a read
that fails *mid-stream* aborts the multipart body unterminated on purpose, so the
client fails loudly rather than quietly receiving a study with an image missing.

**The writer thread dies.** `_drain` catches per batch, so no single bad row can
kill it. If it dies anyway, `_submit` sees `writing` as false and writes inline
on the calling thread: slower, but nothing is lost. The same fallback covers a
full queue (`_QUEUE_MAX`), with a warning. Nothing restarts the thread — `start()`
runs only from `start_index()` and `_sync_index()`. `stop()` drains whatever the
writer did not reach and writes it inline rather than dropping it, because a lost
row is a study that silently stops being findable.

**The rescan thread dies.** `_rescan_run` catches and logs. There is no retry and
no backoff; the index stays exactly as it was and the operator has to press
Rescan.

**The index becomes unavailable mid-request.** QIDO catches its own query
exception, bumps `errors`, logs, and answers 500 "query failed" rather than an
empty result set — an empty 200 would read as "this archive holds nothing".
C-FIND does the same shape with `0xC000` and `error_count`.

**A query arrives while a first rescan is running.** It is answered from whatever
is indexed so far, with no indication that the answer is partial. The index has
no notion of completeness, which is the same limitation that disqualified it from
backing the study browser. `scanning` in the dashboard's index block is the only
place a human can see it.

---

## Orders, worklist, and standing in for a RIS

Two things happen in this subsystem and they move in opposite directions. An
order can come **in** from a live RIS over HL7 and be shown to a technologist who
works in a program that cannot speak DICOM. Or the RIS can be dead, an operator
keys the order **in by hand**, and Carino has to put it **out** to a modality —
which in DICOM means answering a query, because nothing can push an order onto a
scanner. Both directions share one `OrderStore`, one order record, and one
reconciliation path. `docs/ris-emergency-design.md` is the design record for all
of it and is worth reading first; this section is what the code did with it.

### The path an order takes

```
   HL7 ORM^O01                         dashboard "New order"
   over MLLP                                    |
        |                                       |
  RisListener._serve  (accept)                  |
        |  thread per connection                |
  RisListener._handle_conn                      |
        |  drains <VT>…<FS><CR> frames          |
  RisListener._process                          |
        |  HL7Message → parse_order             |
        |             + order_control (ORC-1)   |
  OrderStore.apply_hl7 ──▶ OrderStore.apply     ▼
                              |          PacsServer.add_order
                              |                 |
                   _find_identity_locked        |
                    /      |       \            |
             _add_locked  _update  _close_locked|
                    \      |       /            |
                     ▼     ▼      ▼             ▼
                    ┌──────────────────────────────┐
                    │  OrderStore  (orders.json)   │  study_uid minted in
                    │  open orders ARE the worklist│  _add_locked, once
                    └──────────────────────────────┘
                       ▲                    │
       build_ack ──────┘                    │ get_orders() snapshot
      (same TCP stream)                     ▼
                                   MwlSCP._handle_find
                                     order_matches_query
                                     build_worklist_item
                                            │ C-FIND, one item per open order
                                            ▼
                                       ┌─────────┐
                                       │ modality│  burns the order's Study UID
                                       └─────────┘
                                            │ C-STORE
                                            ▼
                                   StorageSCP._handle_store
                                            │ on_received
                                            ▼
                                 PacsServer._reconcile_study
                          ┌─────────────────┴──────────────────┐
                          │ emergency.active?                  │
                   _queue_for_forward                   OrderStore.match
                   (copy → watch_dir,                   study_uid → accession
                    pin the primary)                    → patient_id (opt-in)
                          │                                    │
                    FolderWatcher pass                  OrderStore.close
                    → primary PACS                      (CLOSE_MATCHED)
```

**Intake.** `RisListener.start()` binds the MLLP port and hands the listening
socket and a fresh stop event to `_serve`, which accepts and spawns
`_handle_conn` per connection. MLLP is a persistent stream, so `_handle_conn`
loops: it drains every complete `<VT>…<FS><CR>` frame already in its buffer,
keeps an incomplete tail for the next `recv`, and ACKs each message on the same
connection. `_process` parses with `HL7Message`, checks the message type against
`accept_types`, and hands the message to `OrderStore.apply_hl7`, which is
`parse_order` plus `order_control` fed into `OrderStore.apply`.

**`apply` is an upsert, not an insert.** It looks the message up with
`_find_identity_locked`, which tries `IDENTITY_FIELDS` in order — filler order
number, placer order number, accession — one at a time rather than as a composite
key, because the filler number is routinely absent from the first message and
present in the second and a composite would make one order look like two. What
comes back decides the branch: `_add_locked` (`created`), `_update_locked` with
`only_nonempty=True` (`updated`), `_close_locked` with `CLOSE_BY_RIS`
(`cancelled`), or one of the three no-ops — `cancel-unknown`, `already-closed`,
`ignored-closed` — which are counted on the listener as `noop_count` so a feed
that is all no-ops does not read as silence.

**The Study Instance UID is minted at order creation**, in `_add_locked` and
nowhere else. That is the linchpin: the modality pulls it on the worklist and
burns it into the exam, a wrapped capture inherits it, and reconciliation is then
an exact UID comparison instead of a guess. `_update_locked` deliberately never
rewrites it, so neither an HL7 amendment nor an operator edit can strand an exam
the modality has already stamped.

**Serving.** `PacsServer.start_mwl` builds `MwlSCP` with
`get_orders=lambda: self.orders.list("open")` — a callable, not a list, so an
order hand-keyed mid-outage is on the next worklist the modality pulls and there
is nothing cached to invalidate. `_handle_find` calls it, **filters for
`status == "open"` again** rather than trusting the caller, runs
`order_matches_query` over the snapshot, and yields `(0xFF00, dataset)` per match
from `build_worklist_item`; returning from the generator is what makes pynetdicom
send Success.

**Return.** `StorageSCP._handle_store` calls `on_received`, which
`PacsServer.start_receiver` wires to `_reconcile_study`. That does two
independent things in order: hold-and-forward (below) if emergency is active,
then `OrderStore.match` on Study UID → accession → patient ID (the last only when
`ris.match_on` is `accession_or_patient`), and `OrderStore.close(...,
CLOSE_MATCHED)` if `ris.auto_close`. Delivery is never gated on the match — the
instance is already on disk before reconciliation is attempted, and a no-match
study simply leaves its order open.

**The other closing route** is `PacsServer.create_study_from_order`: a PDF or
image exported from a legacy tool goes through `ingest.build_from_bytes` /
`ingest.save_instance` stamped with the order's identity *including its
`study_uid`*, lands in the outgoing folder, and the order closes as
`CLOSE_CAPTURED`. Same store, same identity, opposite direction.

### Locks on this path

The threads are in [The shape](#threads-once); `PacsServer` owns `orders`,
`caught`, `watcher` and `emergency`, and every one of them is reached from at
least three of those threads.

**`OrderStore._lock` guards the map and the file, not the entries.** `add`,
`apply`, `update`, `close`, `delete` and `purge_closed` do their
read-modify-write and their `_save_locked` inside it; `_log_action` is
deliberately outside it, because logging is file I/O and a live feed arrives in
bursts. What matters for callers: `match()` and `apply()` hand back copies, while
**`list()` and `get()` hand back the live dicts** — `list()` even sorts outside
the lock. A worklist query, a `/api/ris/orders` render and an HL7 amendment can
therefore be touching the same dict at the same time. Nothing tears in practice
for whole-string field assignment, but the store does not promise a consistent
multi-field read, and any new code that wants one has to copy first. (`SendState`
documents the same choice explicitly and for a stated reason; `OrderStore` does
not, so read this as what the code does rather than as what was intended.)

**`RisListener._lock` and `MwlSCP._lock` guard counters only.** They are taken
around `received_count`/`order_count`/`query_count`/`match_count`, and
`RisListener.stop()` explicitly does not hold `_lock` while joining, because the
connection threads take it.

**`EmergencyController._lock` guards the state machine**: `state`,
`trigger_dest`, `since` and `acknowledged`. `_health` is read under it in
`status()` and cleared under it in `disarm()`, but the monitor thread updates its
records outside it — safe only because that thread is their sole writer. It is
not re-entrant, and
`status()` takes it — which is why `_evaluate` cannot call `activate()` or
`_notify()` from inside its own critical section and instead sets
`_unlocked_activate` / `_unlocked_notify` and acts on them after releasing. Doing
it inline would deadlock the monitor thread at the exact moment the primary went
down, leaving the appliance with no health probe.

**The config lock is a third lock and is held as narrowly as possible.**
`_set_armed` takes `self.server.cfg.mutate()` for the read-modify-write of
`emergency.armed` and the save, because a `POST /api/config` landing in the gap
would otherwise persist the other document and leave the operator told that
failover is armed while `config.json` says it is not — and `start()` re-reads
`armed`, so the monitor would then decline to start. `start()`/`stop()` stay
outside that lock on purpose: `stop()` joins the monitor thread, and holding a
config lock across a join is how this deadlocks against a worker that reads
config.

**Both restartable listeners own their stop event per run.** `RisListener.start`
allocates a fresh `threading.Event` and `EmergencyController.start` a fresh
stop/wake pair; each hands what it made to its own worker, and the workers read
the events they were given rather than `self._stop`. A worker whose join timed
out therefore stays stopped instead of being resurrected alongside its
replacement. `RisListener._serve` serves the
socket it was handed for the same reason, and closes it in its own `finally` so
whoever re-binds the port is not racing an fd it no longer owns.

**Restart ordering.** `apply_config` stops the receiver, printer, RIS, worklist
and Q/R, re-points the live objects, restarts what was running or is newly
enabled, then calls `sync_worklist()` and finally bounces the health monitor with
`emergency.stop()` / `emergency.start()`. The worklist is not in the restart
loop: `worklist_wanted()` decides whether it runs — `mwl.enabled`, **or** any
enabled destination flagged `no_ris` — so `sync_worklist` starts it and the loop
would only fight that.

### Failover: what it actually does

Five states, in `emergency.py`: `OFF` (not armed), `IDLE` (armed, healthy),
`TRIGGERED` (a primary is down, waiting for a person), `ACTIVE` (worklist up,
hold-and-forward on), `RECOVERING` (primary answering again, backlog flushing,
waiting for **Resume normal**). `active` covers `ACTIVE` and `RECOVERING`.

**How it decides a primary is down.** `_tick` walks `_trigger_dests()` — enabled
destinations flagged `emergency_trigger`, and only those — and combines two
signals. The active one is `PacsServer._probe`, a quiet `c_echo` that logs
nothing because it runs every interval and returns `(ok, message)` rather than
raising: to this loop a node being down is ordinary input. The passive one is the
set of destination names in `stuck_sends()["destinations"]`, i.e. forwards that
have really failed and are sitting out their backoff. A destination is `failing`
if either says so. An active probe alone would miss an outage that starts in a
quiet period, since nothing is being sent and therefore nothing fails; failures
alone would miss it for the same reason in reverse.

Failure accumulates as `offline_since`, and `online` only flips false once
`offline_threshold_sec` of *continuous* failure has elapsed — one bad probe is
not an outage. Recovery is hysteretic: `consecutive_ok` must reach
`recovery_successes` before `online` goes back true, so a flapping link cannot
rattle the state machine.

**Health is keyed per node, not per destination name** — `_key` is
`(name, host, port, aet)`. Keyed by name alone, two rows sharing a name shared
one `_Health` and the healthy twin's probe reset `consecutive_fails` and cleared
`offline_since` on every tick: the dead twin's outage never accumulated past the
threshold, `online` never flipped, and the failover never fired while studies
piled up unsent. `validate()` refuses duplicate names, so this is only reachable
from a hand-edited `config.json` — which is exactly the case the send path was
already hardened for. Everything in the key is `str()`'d because a hand-edited
file is also where a port arrives as a dict, and an unhashable key would raise on
every tick.

**Arm, then trigger, then activate.** Opening listening sockets from a health
probe is a large automatic action, so it is split. The operator arms once
(`arm()` persists `emergency.armed` and starts the monitor). `_evaluate` moving
`IDLE → TRIGGERED` does not start anything: it records `trigger_dest`, logs, and
notifies. `status()` computes `prompt` **per request**, and it is true only when
three things hold — the appliance is waiting for a decision, this profile is
someone `emergency.notify` names, and they are not already in `acknowledged`.
`activate()` is what starts `start_mwl()` and, if it is not already running,
`start_watcher()`. `emergency.auto_activate` skips the asking; when it does,
`activated_by` is recorded as "the system", because attributing an automatic
failover to whoever happened to be logged in puts a decision in someone's name
that they did not make.

**Who may press it.** `may_activate` requires both the `emergency.activate`
capability and a match against `emergency.activate_by`. Capability alone ignores
the designation the administrator was asked to make; designation alone would hand
the button to a profile that cannot reach the endpoint. With no profiles
configured, both are true — the pre-profiles appliance, one operator, every
answer yes. `dismiss()` is deliberately not gated and is per profile id:
acknowledging a prompt is saying "I have seen this", which anyone shown it may
say. It used to be one boolean, and the boolean was the bug — a receptionist
clearing a pop-up they could do nothing about took it off the radiologist's
screen and IT's at the same time, and those three people are being asked three
different questions.

**What hold-and-forward means concretely.** While `emergency.active` and
`emergency.hold_and_forward`, `_reconcile_study` calls `_queue_for_forward` for
every received instance: copy it into `scu.watch_dir` so the ordinary auto-send
pipeline picks it up, then **pin** the primaries onto its `SendState` entry via
`watcher.state.pin(dst, primaries)` and `save()` immediately. The save is
immediate because the watcher only persists at the end of a pass, and a crash in
between would leave the copy on disk with the promise gone.

The pin is the whole guarantee. A file dropped in the watch folder alone is
routed by the rule engine, and one `{"destinations": ["Teaching"], "stop": true}`
would send the held copy to a teaching archive, mark it fully sent, and let it be
archived or deleted having never reached the primary — the failover promise
silently void. A pin only widens the route; the rules still add whatever else
they want, and `SendState.get()` dropping the pin when the file's size or mtime
changes is correct, because new content is a new promise.
`_holdforward_primaries` includes `emergency.trigger_dest` even if the flag has
since been cleared: that node is the one the operator is waiting on. If nothing
is flagged `emergency_trigger` at all there is no delivery to promise, and that
is warned exactly once per process.

**How it decides the primary is back.** `ACTIVE → RECOVERING` is decided by the
same two signals as the outage: `_tick` only lets `consecutive_ok` accumulate
when the C-ECHO answers *and* the name is out of `stuck_sends()`, so a primary
whose forwards are still failing keeps the state machine in `ACTIVE`. What the
transition does not do is declare anything delivered. `_flush_once` starts the
watcher if needed and calls `retry_stuck()`, which is `SendState.clear_backoff`
— it zeroes the retry timers so the next watcher pass attempts immediately, and
nothing more. The design note's caveat — a C-ECHO answering is not a C-STORE
succeeding, and a half-broken node must not be allowed to swallow the
backlog — is honoured by the send path rather than by the monitor: a held
instance is only marked sent when the node actually accepts it, and the pin means
it cannot be archived or deleted until then. `RECOVERING` is also terminal until
a person acts: nothing returns the machine to `IDLE` on its own. `resume()` stops
the worklist SCP, clears `trigger_dest` and the acknowledgements, and drops back
to `IDLE` (or `OFF` if disarmed). That is deliberate — auto-exit would stand the
worklist down mid-shift on a link that is merely flapping.

### Asking instead of answering: the worklist probe

The same subsystem run backwards, for the case where **someone else's** worklist
is the thing that is broken. `PacsServer.probe_worklist` borrows a registered
modality's AE title as the *calling* AE and asks the configured
`worklist_source` a series of questions through `scu.c_find_worklist`, relaxing
exactly one variable at a time: station + date + modality, then without modality,
then without date, then without station, then nothing at all. One variable at a
time is the point — an earlier version folded the modality key into the first
question and then blamed the station for its absence, which sends somebody to
edit the wrong field.

A count alone still lies, so `CaughtStore.add_round` splits every answer into
`for_this_station`, `for_nobody` and `for_someone_else` (`_same_ae` compares
case-insensitively and counts an empty AE title as addressed to nobody, never to
this station). `_probe_verdict` reads the rounds narrowest-question-first and
names the key that is wrong in one sentence; it never says "working" on a count
alone, because an order addressed to nobody reaches every modality and a scanner
seeing only that spillover is a scanner that is not being scheduled.

Borrowing the AE title is what makes the answer the scanner's answer rather than
the appliance's, and it means the scanner must be off the network first — two
devices answering to one AE title is a conflict this code cannot detect and does
not pretend to check. The probe runs on the Flask request thread and opens its
associations in sequence, so a dead worklist source holds that request for the
full run of query timeouts.

`CaughtStore` is a **record, not a queue**, and its separation from `OrderStore`
is load-bearing rather than tidy: `mwl.py` serves every open order in the
`OrderStore`, so a caught item filed there would be handed straight back out to
this department's modalities — another hospital's orders on your scanners, with
no step in between that anybody chose. A flag on a shared store would make that
unlikely; a different file makes it impossible. Consequently caught items have no
status, no minted UID, no reconciliation and no worklist path, and the store is
bounded by `MAX_ROUNDS` because probe history is diagnostic exhaust holding other
people's patient identifiers.

### Decisions, and the obvious route not taken

- **"Send the order to the modality"** → an MWL SCP. You cannot push an order
  onto a scanner in DICOM; it pulls. The consequence is a hard limit worth
  telling operators: a modality that cannot be re-pointed at Carino as its
  worklist source cannot be reached at all, and `ScheduledStationAETitle` on the
  order *is* the destination.
- **Strict, conformant MWL matching** → deliberate leniency. An empty query key
  is universal, wildcards work, and an order that leaves modality or station
  blank matches *any* queried value, so an untargeted emergency order appears on
  every worklist. Keys that are not honoured — everything outside PatientID,
  PatientName, AccessionNumber, StudyInstanceUID, and Modality/station/SPS-start-date
  from the *first* SPS item — can therefore only ever widen the answer. A
  modality is shown items it did not ask for, never deprived of one it did. That
  is the right way round when the goal is keeping imaging moving, and it is the
  first place to look when a worklist is too long. It is also why matching here
  is done in Python while `qr.py` delegates to the index: leniency belongs to
  worklists and nowhere else.
- **Every HL7 message is a new order** → upsert keyed on order identity. Two open
  orders for one accession carry two different Study Instance UIDs, so the
  modality can burn the wrong one into the exam and reconciliation then closes one
  and orphans the other for good.
- **Treat unknown ORC-1 codes as cancels** → treat them as upserts. The asymmetry
  is the argument: an unrecognised code read as an upsert leaves an extra open
  order, which is visible and cancellable by hand; read as a cancel it would
  silently close a live order and the exam would never be performed.
- **Carino cancels any order** → `may_cancel_here` allows it only for
  `ORIGIN_MANUAL` and `ORIGIN_TEST`. An order the real RIS created belongs to the
  RIS; Carino will serve it and notice its study arriving but will not decide the
  exam is off. A cancellation the RIS itself sends is relayed and recorded as
  `CLOSE_BY_RIS`, which is a different thing. `origin_of` infers the field for
  rows written before it existed, so old `orders.json` files stay loadable.
- **One `closed` status** → four `close_reason` constants. "The study arrived"
  and "somebody gave up" both used to render as `closed`, and a panel that cannot
  tell them apart cannot be used to troubleshoot anything. (The design note's
  separate `state` enum — `scheduled/in_progress/completed/cancelled` — was not
  built; `status` plus `close_reason` carries the distinction, and there is no
  MPPS in the tree, which is what `in_progress` would have needed.)
- **A monolithic "emergency mode"** → two separable capabilities. A store-only
  outage does not needlessly spin up a worklist, and a worklist-only outage does
  not imply studies are stranded.
- **HL7-out** → still not built. There are no `hl7_destinations` in the tree.
  Sending `ORM` back to a RIS that is dead is the one thing the emergency
  protocol has no use for.

### Failure modes

- **Primary PACS down.** The designed case. Received studies keep landing, get
  copied and pinned, and back-fill when it returns. Nothing is dropped.
- **Primary down and nothing flagged `emergency_trigger`.** Hold-and-forward has
  no primary to hold *for*: the copies go wherever the routing rules send them and
  nothing guarantees a back-fill. Warned once per process, and it is the state a
  fresh install is in.
- **The RIS (HL7 sender) is down.** Nothing happens. Intake is passive — no order
  arrives, and the operator keys orders in instead. A dropped connection is logged
  and the connection thread ends.
- **Malformed HL7.** `_process` answers `MSA|AR` with a parse-error text and
  counts `error_count`; the connection stays up for the next frame. A message type
  outside `accept_types` is ACK'd `AA` and ignored, so the sender is never left
  hanging.
- **`orders.json` cannot be written (disk full, read-only volume).**
  `_save_locked` raises with the order already in the in-memory map. From HL7 the
  exception is caught in `_process`, counted, and answered `MSA|AE` — but the
  order is live in the store and will be served on the worklist, and it is gone on
  the next restart. From the dashboard the exception reaches Flask as a 500. There
  is no retry and no dirty flag: the next successful save is whatever change comes
  after it.
- **`orders.json` is corrupt or truncated.** `_load` absorbs `OSError` and
  `ValueError` and starts empty, so the appliance boots. Every order in that file
  is then invisible, and the next save rewrites the file without them.
  `caught.json` behaves the same way, and there it is the right trade — refusing
  to start a PACS because a diagnostic file will not parse is not a trade worth
  making. For orders it is the one place where a bad file costs data rather than a
  rescan.
- **Disk full on receive.** The Storage SCP refuses with `0xA700` *before*
  writing, so the sender can retry. Nothing reaches `_reconcile_study`, so nothing
  is queued for forward and no order closes — correct, since no image exists.
- **The hold-and-forward copy fails.** `_queue_for_forward` catches `OSError`,
  warns, and returns. The instance is stored and is *not* queued, nothing revisits
  it, and the order may still close as matched. Nothing detects this later.
- **Anything else raising inside `_reconcile_study`.** `scp.py` wraps the
  `on_received` callback in a bare `except Exception: pass` so a callback can never
  kill an association — with no log line. A reconciliation failure that is not an
  `OSError` inside `_queue_for_forward` is therefore invisible.
- **`get_orders()` raises during a C-FIND.** `_handle_find` swallows it and
  continues with an empty list, so the modality is told Success with no items — an
  empty worklist, not an error. `build_worklist_item` failing for one order skips
  that order (logged, `error_count`) and the modality is silently short a row.
- **Duplicate open orders for one accession.** The HL7 path cannot create them.
  The manual path can: nothing checks identity on `add_order`, and `match()` then
  returns whichever open order the store's dict yields first. The MWL leniency
  means both appear on the worklist.
- **The monitor thread dies.** `_loop` wraps `_tick` so a probe error, a
  `stuck_sends()` failure or a notification error cannot end it. The interval read
  — `int(self._cfg.get("probe_interval_sec", 30))` — is *outside* that `try`. A
  value that will not convert (only reachable from a hand-edited file: `validate()`
  refuses it on the dashboard save path, and startup only warns about a config it
  is already using) ends the thread. Nothing notices: `status()` reports `armed`,
  the last state and the last `_health` snapshot, so the dashboard keeps showing a
  reachable primary that is no longer being probed. Only `apply_config` (or
  `arm()`) starts it again.
- **The watcher is not running when emergency activates.** `activate()` and
  `_flush_once` both start it. If it is running and a rule change stops the held
  copies being routed anywhere live, they surface in `stuck_sends()["orphaned"]` as
  **pinned** — routed, never accepted, and no enabled node left to dial. Nothing
  retries those. The outgoing folder grows and only an operator restoring the node
  or accepting the loss ends it.
- **Access control on the worklist.** The AE-title allowlist (plus a CA on the
  listener, if TLS is configured for it) is the whole boundary. A permitted caller
  sees every open order its query matches, and the query is its own to write:
  `station_aet` is a filter for the operator, never a confidentiality boundary.
  That is precisely why caught items from another hospital live in a different
  store with no worklist path at all.

---

## The control plane: config, dashboard, auth, audit

Everything in this appliance that moves pixels — the Storage SCP, the watcher,
the print receiver, the worklist, Q/R — is driven by one JSON document and owned
by one object. The control plane is that document, the object that holds it, the
HTTP layer that lets a human edit it, the two gates that decide who may, and the
append-only record of what they did. It has one property worth stating before any
of the mechanics: **a control-plane failure must never take the imaging path down
with it.** A config that will not save leaves every listener bound and running. A
config that is questionable is used and complained about rather than refused. An
audit record that cannot be written does not roll back the delete it was
recording. Read the rest of this section as consequences of that.

### The document, and why `load()` does not validate

`Config` is one object per process, wrapping one file
(`~/CarinoPACS/config.json` by default). `load()` reads it, `_parse()` refuses
anything that is not a JSON object with a message an operator can act on, and the
result is deep-merged over `DEFAULTS` — so an absent key is the default, and a
section the dashboard does not send back is reset to it. Relative paths
(`./received`) resolve against the config file's own directory, not the working
directory, which is what makes the same document behave identically under a
shell, a systemd unit and a container.

`load()` deliberately does not call `validate()`, and the reasoning is written
where the decision is: `validate()` guards the **write** path, where a refusal
costs one corrected keystroke; on the **read** path a refusal costs the
department its PACS. `pacs serve` would exit, the receiver would never bind,
modalities would get connection refused, and the dashboard — the only tool the
operator has for fixing the config — would be the thing that will not start. What
is not tolerated is a file that is not a document at all: `_parse` raises
`ConfigError` (a `ValueError`, so every existing catch already handles it) instead
of falling back to `DEFAULTS`, because a config that silently lost `scp.enabled`
is a PACS with no receiver reporting itself healthy.

The gap that leaves — a hand-edited file used unvalidated — is closed by *saying
so*, not by refusing. `PacsServer.__init__` runs `validate()` for its side effect
only, stores the complaint in `self.config_problem`, and logs it as a warning:
this config would be refused if it were saved from the dashboard, it is being
used as it stands, fix it in Settings. That warning is the only place the two
halves meet.

Writes go through three functions and nothing else should touch `self.data`:

- `mutate()` returns the config's re-entrant lock, and is the required wrapper for
  any read-modify-write. Any caller that reads a value, changes it and saves — the
  token endpoint, the site-key endpoint, the notifier secrets, the profile
  endpoints, emergency arm/disarm — runs the whole sequence under it, or a
  concurrent `replace()` swaps `self.data` out between the change and the save.
- `replace(new_data)` merges over `DEFAULTS`, validates, assigns and saves, all in
  one critical section, so a second POST arriving mid-way cannot persist a
  document that never existed in memory.
- `save()` serialises to text **under the lock** (dumping straight into the file
  let a concurrent writer change the document halfway through it), sweeps
  abandoned temp files older than an hour, writes a fresh temp named with the pid
  and random bytes, opened `O_EXCL|O_NOFOLLOW` at `0600` — because `os.replace`
  keeps the temp's mode, and this file holds `web.auth_token`, `deid.secret`, the
  webhook key, the SMTP password and every profile's password hash — `fsync`s it,
  `os.replace`s it over the config, and `fsync`s the directory so the rename
  itself survives a power cut.

The coercion helpers carry more weight than their size suggests.
`auth_token_of()`, `deid_secret_of()`, `notify_secrets_of()` and `web_host_of()`
exist so that every reader coerces a value identically. The comment on
`auth_token_of` records what happened when they did not: `str(x)` turned a JSON
`0`/`false`/`null` into a non-empty string that satisfied "you must set a token",
while `str(x or "")` turned the same value into `""` and the guard enforced
nothing. A config existed that satisfied the policy and defeated the enforcement.
One coercion, one answer, and `validate()` rejects a non-string token outright
rather than let it look like one.

`version()` is the last piece: a fingerprint of the stored document, published as
an ETag and accepted back as `If-Match`. Secrets are folded in through a
**keyed** fingerprint (`_VERSION_KEY`, random per process), because the ETag goes
to every holder of a session cookie and a cookie is deliberately not enough to
read the token; a plain digest would have handed exactly that caller an offline
oracle. The cost is that an ETag does not survive a restart, which is the honest
answer anyway.

### The security gate

`validate()` is where policy lives: an empty `web.auth_token` is permitted
**only** when `web.host` is loopback. `is_loopback_host()` fails closed — it
unwraps bracketed IPv6 and IPv4-mapped addresses, and anything it cannot parse,
including `""` and `0.0.0.0`, is reported as network-reachable. A container binds
`0.0.0.0` by definition, so a containerised deployment must set a token.
`SECURITY.md` is the authority on this and says the same thing; nothing in this
section relaxes either half.

`pacs/auth.py` is the **enforcement** half and decides nothing. It reads the
token live off the config (`AuthGuard.token` calls `auth_token_of`, never a local
coercion, so the gate that makes a token mandatory and the guard that enforces it
read the same value out of the same JSON). The CLI carries an independent copy of
the same refusal, because `serve --host` bypasses config validation entirely:
`cmd_serve` checks `is_loopback_host(host) or auth_token_of(cfg.web)` **before
anything binds** and returns 2 with the two commands that fix it. `POST
/api/auth/token` refuses `{"action":"clear"}` while the bind is reachable, for the
same reason from the other direction.

Profiles are the same question one layer down, and `validate()` passes the answer
through: `users.validate_profiles(..., network_reachable=...)` allows an open
(passwordless) profile on loopback, refuses one that can *change* anything
off-box, and refuses a list where nobody is enabled or nobody can manage
profiles. An empty profile list is legal and means token-only — that is what every
config written before profiles existed deep-merges to.

### One request, end to end

This is the path a config change takes. Everything else on `/api` is a shorter
version of it.

```
POST /api/config                         browser tab, or a script holding the token
  |
  |  Flask before_request, in registration order
  +-> auth.install's _require_auth  ......... guard.check()
  |      not required (no token, no profiles) -> pass
  |      OPTIONS, or path not under /api|/dicom-web, or PUBLIC_PATHS -> pass
  |      Authorization: Bearer / X-Carino-Token -> compare_digest -> pass, clear this IP
  |      carino_session cookie -> v1 (signed vs the token) | v2 (names a profile,
  |                                looked up and re-checked on every request)
  |      otherwise -> 401 + WWW-Authenticate    (only FAILURES reach the RateLimiter)
  +-> _require_write_header  ................ writes only (GET/HEAD/OPTIONS pass),
  |                                          not /dicom-web: X-Carino: 1 or 403
  +-> _guard_dicomweb  ...................... /dicom-web only: capability + PHI hard stop
  |
  +-> api_set_config
  |      guard.deny("config.write") -> 403 naming the capability, the profile and the role
  |      reject config_version in the body; strip the read-only *_set mirrors
  |      with _save_lock:                      one apply at a time, whole-bounce wide
  |        server.apply_config(edit=_merge)
  |          with cfg.mutate():                THE critical section
  |            _merge(stored):
  |               If-Match vs cfg.version()             -> 409 stale_config (+ new ETag)
  |               stored token / deid.secret / notify secrets re-asserted, never taken
  |               users.profiles re-asserted; a deid change needs deid.manage -> 403
  |            would_accept(candidate)                  -> ValueError -> 400
  |            previous = deepcopy(cfg.data)
  |            cfg.replace(): merge over DEFAULTS, validate, swap, save()
  |               save(): serialise -> sweep temps -> 0600 O_EXCL|O_NOFOLLOW temp
  |                       -> fsync -> os.replace -> fsync(dir)
  |            on failure: cfg.data = previous; raise ---> EXIT (a): nothing was stopped
  |          ---- the new config is on disk; only exit (b) remains ----
  |          stop receiver, printer, RIS, MWL, QR       each fenced by _apply_step()
  |          _repoint_live_objects(): log dir, order store, index (rebuild + rescan)
  |          start what was running OR is now enabled   bind failure -> logged, not fatal
  |          sync_worklist(); nudge the watcher; emergency stop + start
  |
  +-- after_request: _record_to_audit (actor, target, real status), _withhold_identifiers
  v
 200 + ETag: "<cfg.version()>"
```

Three ordering decisions in that picture are load-bearing.

**Auth is registered before the write guard.** An unauthenticated write must
answer 401-with-a-prompt, not 403-missing-header, or the dashboard shows the
operator the wrong recovery path.

**The secret re-assertion moved inside the config lock.** It used to run at the
top of the handler, reading the stored token outside any lock and re-asserting it
into a document applied later — so a rotation landing in the gap was written back
out of existence while `POST /api/auth/token` had already answered `ok: true`.
The comment records the measurement taken when that shape was restored and the
rotation hammer in the web-auth suite was run against it: 15 and 16 of 40
rotations reverted, over two runs. The `If-Match` check moved in with it, because
a version compared outside the lock is a version the config may no longer have.

**The bounce stays outside the config lock.** It joins service threads, and
holding a config lock across a join is how a `stop()` that waits on a thread
reading config deadlocks the dashboard. It does not need the lock: the new config
is already on disk, and every service is restarted from `self.cfg` whatever a
later save makes of it.

`apply_config()` has exactly two legal exits, written out above the method as an
invariant. Exit (a): it raises having disturbed nothing — old config in memory and
on disk, every service still running. Exit (b): new config in memory and on disk,
and every service the new config wants having been *given* its start; one that
could not bind is logged and shows on the dashboard as enabled-but-not-running,
never stopped in silence. There is no third exit, and the two rules that hold the
line are *nothing is stopped until the new config is on disk* (persisting is the
step that fails for reasons outside this process — a read-only bind mount, a full
disk, ownership changed under a container restart) and *once the bounce has begun,
every path out of it goes through the restart*.

The obvious alternative — validate, stop everything, write, start everything —
was what made an unwritable config directory take the whole PACS down with
nothing left running to bring it back. The other obvious alternative — let a
failed `stop()` propagate — saved the config and left the department mute.

### Who is asking, and what they may do

`AuthGuard` is policy plus per-process state (a `SessionSigner` and a
`RateLimiter`), constructed by `auth.install()` and parked on
`app.extensions["carino_auth"]`; `web.py` holds it in the `create_app` closure.
It reads the token and the profile list **live** from config on every request, so
setting a token, rotating it, seeding profiles or disabling somebody takes effect
on the next request with no restart and no window where a saved policy is not yet
enforced. `required` is true when a token is set **or** profiles are in use —
turning profiles on has to be sufficient by itself, or an operator who seeds
profiles on a loopback box gets a picker anyone can walk past.

Credentials are three and are not interchangeable:

- The **token**, in `Authorization: Bearer` or `X-Carino-Token`, compared with
  `hmac.compare_digest` on bytes. It authenticates as `users.SERVICE_PROFILE` —
  an administrator, named "API token", which the audit trail records as a service
  rather than attributing a script's delete to a person who was not there.
- A **v1 session cookie**, signed over a keyed fingerprint of the token. Rotating
  the token invalidates every one of them without tracking any of them.
- A **v2 session cookie**, which additionally names a profile id and is signed
  over a fingerprint of *that profile's stored password*. Changing one password
  ends that person's sessions and nobody else's. The two formats are parsed apart
  by field count rather than by care, so a v2 value can never drift into the token
  path.

The signing secret is generated at startup and never written anywhere, so a
restart logs everyone out. That is the correct trade for a single-operator
appliance: no session store on disk, nothing to leak, and the worst case is
retyping a token.

`identify()` never returns `None` — `SERVICE_PROFILE` when profiles are off, when
the token was presented, or when a v1 cookie verifies against it; the looked-up
`Profile` for a good v2 cookie; `ANONYMOUS` otherwise — so an endpoint that forgets to check gets a denial from
the capability test rather than an `AttributeError` served as a 500 from a handler
whose whole job at that moment was to refuse. Enforcement is
`guard.deny(capability)` at the point of the decision, deliberately not a
decorator: `POST /api/config` needs `config.write` at the top and `deid.manage`
further down, once the body has been compared against the stored document.

Two more gates sit on the response side rather than the request side. `GET
/api/status` is *composed* per profile against a table of section→capability,
because that one payload carries the last patient's name and ID, every storage
path and every destination's host, port and AE title — hiding a nav button would
leave all of it in the receptionist's browser. And `_withhold_identifiers` is an
`after_request` choke point that redacts withheld identifier fields out of every
JSON response, because the endpoints that carry a patient name are not the obvious
ones and per-handler redaction leaks the day someone adds the next one. Withheld
reads `***`, never `""`, because an empty accession already means "this study has
none".

The rate limiter counts **only evaluated failures**, keyed on `remote_addr` alone
(`X-Forwarded-For` is attacker-controlled when there is no proxy in front, and
there is not). A correct credential is honoured mid-block and clears the client's
history; attempts made during a block are not recorded, so a hammering client
cannot renew its own block forever; the tracking table is capacity-bound so a
botnet cannot grow it until the process runs out of memory. Locking the only
operator out of a running PACS is the worse failure.

The static tree is served without a credential on purpose, and the reasoning is
worth repeating because it looks like a hole: the dashboard shell contains no
patient data and no configuration — every byte of both arrives over `/api/*`,
which 401s — and gating it makes the token prompt unreachable. A browser cannot
render a login form it was not allowed to download, and auth that cannot be
satisfied is an outage.

### The trail

`AuditLog` is not the log, and the distinction is the design. `LogBuffer` is a
bounded ring with dated files behind it answering "what is this box doing right
now"; it drops its oldest line without ceremony and nothing in it names a person.
The audit trail answers "who deleted that study": append-only, attributed,
hash-chained, each record covering the previous record's digest.

It is opened in `PacsServer.__init__` — not lazily on first record, so a
directory that cannot be created is reported at startup next to the config problem
rather than at the moment somebody deletes a study and the one record that
mattered is the one that failed. `open()` recovers the head by reading the last
well-formed record, searching archives when the live file is absent, because a
restart immediately after a rotation would otherwise chain from genesis into a
directory full of archives and make `verify()` report a break in a trail nobody
touched.

One `RLock` covers read-modify-append, because the chain makes each write depend
on the last: two records computed against the same predecessor look valid alone
and break `verify()` together. `record()` never raises — an audit write that threw
would propagate out of whatever it was auditing, and a study delete that
half-happened because recording it failed is worse than a gap. Failures set
`broken`, which `status()` publishes, because a trail that silently stopped
recording is indistinguishable from a quiet week. Rotation happens *before* the
append, so the file overshoots by at most one record, and the archive name carries
a zero-padded sequence because `files()` orders lexically and a bare stamp sorted
after its own `-1` suffix, which once made `verify()` announce tampering on an
intact trail.

Three sinks feed it, and they are separate deliberately. `auth.install()` takes
the audit log as an argument so that login, failed login and logout are recorded
from inside the endpoints that own them — those three have to exist before
anything else can be attributed to anybody. `_record_to_audit` is an
`after_request` hook covering every mutating `/api` call plus every 403, so the
record carries what actually *happened* rather than what was attempted; a trail
that says a study was deleted when the delete returned 400 lies in the direction
of alarming people. And the endpoints that change who may do what — the profile
writes, the picker toggle — record explicitly, with the change described.

What the chain proves is bounded and the module says so: it detects a record
edited in place, one removed from the middle, records reordered, a file cut
mid-line. It does **not** detect truncation at a record boundary (the remaining
prefix is a genuinely valid chain) or a wholesale rewrite by somebody with write
access to the directory and a copy of the source. What closes both is anchoring
the head published in `status()` somewhere this appliance cannot write.
`SECURITY.md` says the same; do not let a summary of this section promise more.

### The locks of the control plane

`PacsServer` is the only object that owns state. The web layer holds a reference
to it and to the `AuthGuard`, and drives the workers through its methods (the
direct reaches are listed in [The objects every path
touches](#the-objects-every-path-touches)). The locks are not one lock, and the
separation is deliberate in each case:

- **`Config._lock`** (re-entrant) covers every read-modify-write of the document.
  Re-entrant because `replace()` calls `save()`, and because a handler holds
  `mutate()` across a `would_accept` + assign + save.
- **`PacsServer._lock`** covers the service objects and the index thread handles;
  see [Connections and locks](#connections-and-locks) for why `stop_index()` joins
  outside it.
- **`web.py`'s `_save_lock`** keeps two whole applies from interleaving. It is
  explicitly *not* what makes the check-and-apply atomic any more — the config
  lock is — but it is what stops a receiver started from one config being stopped
  by another. Nothing else takes it and nothing takes it while holding the config
  lock, so the two cannot deadlock.
- **`AuditLog._lock`** serialises the chain.
- **`LogBuffer`'s two locks** are the sharpest example: `_lock` guards the ring and
  the sequence counter, `_flock` serialises the append to the dated file, and
  `add()` has released the first before taking the second. A log folder that has
  gone slow, full or missing blocks only the thread doing that write. What it costs
  is file *order* — two entries can reach the file in the opposite order to their
  seq — and the dashboard reads the ring instead, where order is guaranteed. A
  receiver blocked behind a full disk would have been the worse half of that trade.
- **`_stale_lock`** exists so a send thread recording a stale-de-identification
  note does not queue behind a service start/stop, and `status()` cannot read the
  list half-written.

Objects that outlive a save are bound to the live `Config` object rather than to a
copy of a section. The watcher's `Router` is bound explicitly at construction for
exactly this reason — unbound, it would assume scrubbing is available and hand back
decisions saying "de-identified" about studies the sender forwards untouched.

### The headless alternative

`pacs/__main__.py` is the other driver of the same objects. `--config` is a
**global** option and must precede the subcommand. Every subcommand builds a
`Config` as its first act, and only `init --token` writes one back on its own — it
mints a token only when there is none, prints it once to stdout, and never to the
log or a URL. Per-command overrides (`--port`, `--aet`, `--out`, `--watch-dir`)
change the loaded document in memory for that process only; `cmd_serve` keeps
`host` and `port` in locals rather than poking them into `cfg.web`, because the
dashboard displays and re-saves whatever is in that document and a `--host` meant
for one run is how a bind address gets changed for good.

The headless commands are an alternative to `serve`, not a companion: they start
the same service objects off the same config sections, so running one beside a
`serve` that already has that service enabled is two processes fighting over one
DICOM port. `serve --receive/--watch/--print/...` starts a service for that run
and deliberately never writes the `enabled` flags — enrolment belongs to the
dashboard's setup chooser, which writes all the flags plus the completion marker
in **one** save, because `apply_config` bounces every bound service each time it
runs and separate posts would mean a window with the receiver down for each one.

Signals: `_install_sigterm()` makes SIGTERM raise `KeyboardInterrupt`, which
Werkzeug catches inside `serve_forever` so `app.run()` returns and `cmd_serve`'s
`finally: server.shutdown()` runs. Without it SIGTERM is the kernel default — the
process dies where it stands, listeners never stopped, associations cut
mid-transfer, the index writer's backlog dropped — and SIGTERM is what
`docker stop` and `systemctl stop` send. The headless commands install their own
flag-setting handler over it and run the shutdown back in ordinary code rather
than inside a handler that could land in the middle of an association or a sqlite
write. `shutdown()` stops the emergency monitor, the watcher and every listener,
and the index **last**, because everything above it is still feeding it until it
is down.

### Failure modes

- **The config file will not parse, or is not readable as UTF-8, or is a
  directory, or the service account cannot read it.** `ConfigError` from
  `_parse`/`load`, caught once in `main()` and printed alone without a traceback,
  naming the file, what is wrong and how to get back. Every subcommand, including
  `serve`. Nothing starts.
- **The config parses but would not validate.** It is used as it stands.
  `PacsServer` logs the exact complaint as a warning and publishes it as
  `config_problem` (gated behind `config.read`); the next dashboard Save is refused
  until it is fixed. The one case this does not cover is a value whose *type* breaks
  a constructor before validation is reported — `int(audit.max_bytes)` on a string,
  for instance, raises while `PacsServer` is being built, and the service does not
  start.
- **The config directory is read-only, or the disk is full, at save time.**
  `_write_temp` raises `OSError`, `replace()` puts the previous document back, and
  `apply_config` takes exit (a): not one service was stopped, all of them still
  running on the config they were started with. The single-value endpoints (token,
  site key, notifier secrets, profiles) roll the in-memory value back explicitly for
  the same reason — a token enforced in memory but not on disk survives until the
  next restart and then reverts, which is the worst of both.
- **Two dashboards save at once.** `_save_lock` serialises the applies and the
  config lock makes each check-and-apply atomic. A client that sends `If-Match`
  gets a 409 with the current ETag and must reload and reapply, never blind-retry.
  A client that does not send it — which `web.py`'s comment says includes the
  shipped dashboard — still gets last-writer-wins, silently. That is a known,
  deliberate gap: a Save that started failing on a header the client does not send
  would be a worse bug than the one being fixed.
- **A service will not bind after a save** (port taken, unreadable TLS cert).
  Logged with the reason, the save stands, the service shows
  enabled-but-not-running on the dashboard, and the remaining services, the
  worklist and the health monitor are still brought up. `sync_services()` reports
  one row per attempted transition.
- **A `stop()` throws during the bounce.** `_apply_step` returns the exception
  instead of raising it, logs it, and the bounce continues to the restart. The
  socket may or may not have closed; the start that follows says so if it did not.
- **The audit directory cannot be created, or the write fails, or rotation
  fails.** `record()` returns `None` and sets `broken`, which `status()` publishes
  and the dashboard renders; rotation failure keeps writing to the oversized file
  rather than stop recording. Nothing that was being audited is rolled back or
  refused. Changing `audit.dir`, `audit.enabled` or `audit.log_reads` in Settings
  does **not** take effect until the engine restarts: the `AuditLog` is built once
  in `PacsServer.__init__` and `_repoint_live_objects()` does not re-aim it.
- **Power is lost mid-append to the trail.** The torn final line is skipped on the
  next `open()` and the chain continues from the last intact record; `verify()`
  reports that file as edited or truncated when it reaches it. Truncation at a
  record boundary is undetectable by design.
- **The log folder is full, missing or slow.** `LogBuffer._write_file` swallows the
  `OSError`: the dated file silently stops, the ring buffer and the dashboard's
  Activity poll keep working, and no logging thread blocks. There is no alarm for
  this.
- **A worker thread dies.** Covered once in [Threads, once](#threads-once):
  nothing supervises them, only the watcher's `running` would show it, and
  recovery is an operator pressing Start, a Save, or `sync_services()`.
- **A peer is down.** Not the control plane's problem: the watcher retries with
  backoff and keeps the file, the emergency monitor probes and raises a prompt,
  `/api/echo` answers on demand. The control plane's only obligation is to keep
  reporting it, which it does through `status()` and the stuck list.
- **`POST /api/shutdown`.** Runs `server.shutdown()` in the request thread, then
  `os._exit(0)` from a short-lived thread after a delay long enough to flush the
  response. Any other request in flight dies with the process; nothing drains them.

---

## Decisions that shaped the whole thing

The four sections above each carry the decisions local to one path. These are the
ones that show up everywhere, and each is evidenced by the code or by an existing
document rather than reconstructed.

**Every service that opens a port is off until somebody turns it on.** The
`enabled: False` defaults, the setup chooser that writes them in one save, and
the CLI flags that start a service for one run without writing anything. An
appliance that ships listening is an appliance that joins a hospital network with
ports open that nobody chose.

**One JSON file, in one place, resolved against itself.** `~/CarinoPACS/` holds
the config, the folders, the logs, the index and the order store, and relative
paths in the document resolve against the document's own directory. The same file
therefore behaves identically under a shell, a systemd unit and a container, and
an operator asking "where is everything" has one answer. `CONFIGURATION.md`
documents every key; `config.py` owns defaults, validation and the security gate.

**Threads, blocking calls, and no supervisor.** The two libraries that own the
sockets are threaded and blocking — pynetdicom spawns a thread per association
behind `ae.start_server(block=False)`, Flask runs `threaded=True` — so every
worker here is a plain named thread doing blocking I/O, with locks that guard
named structures and are documented where they are taken. The consequence is
stated plainly rather than hidden: nothing restarts a thread that dies. Nothing
in the tree records a rationale for rejecting an async runtime, and this document
does not invent one.

**sqlite for the one question that is asked hundreds of times a minute, and flat
JSON for everything else.** `history.scan_studies()` answers "what is on disk" by
walking the tree, which is fine for a dashboard poll and hopeless for a query
protocol — hence the index. But the index is the only thing in the tree that
needs SQL. Orders (`orders.json`), caught worklist items (`caught.json`) and the
send state are small, human-scale, hand-inspectable files that must survive a
restart and nothing more; an emergency RIS that forgets its orders on a crash is
worse than useless, and that is a durability requirement, not a query one. sqlite
also adds no dependency — it ships with Python, and `requirements.txt` carries no
database driver.

**Nothing in the index is irreplaceable, so nothing migrates.** A
`SCHEMA_VERSION` bump drops and rebuilds; the operator is told to rescan. This is
only affordable because the filesystem is the source of truth.

**The dashboard is unauthenticated on loopback, and mandatory-token anywhere
else.** `web.py`'s docstring is the authority: only a process on this machine can
reach a loopback bind, and the `X-Carino` header stops a page the operator already
has open from firing cross-site writes. Bind it wider and `validate()` refuses to
save without a token, `cmd_serve` refuses to start without one, and the token
endpoint refuses to clear one. Auth and the header are two controls and both stay
on — the token says *who* may call, the header says *from where*.

**A control-plane failure never takes the imaging path down.** Load does not
validate; a questionable config is used and complained about; a save that cannot
persist stops nothing; an audit write that fails does not roll back what it was
recording; a log folder that has gone away blocks no thread. Every one of those is
the same trade made in a different module.

**De-identification happens on forward only, and the archived original is never
rewritten.** `CONTRIBUTING.md` calls that asymmetry the module's whole point. It
is also why `Decision` owns both halves of the question, why a scrub that cannot
be honoured holds the delivery rather than sending it in the clear, and why
DICOMweb is refused outright to a restricted profile: there is no scrub on the
retrieval path at all, so a per-field restriction that held on the dashboard and
not on QIDO would be a policy true on one surface and false on another.

---

## Not determined from the code

Stated rather than guessed, because each of these would mislead a reader if left
implicit.

- Whether pointing `scp.storage_dir` at the same folder as `scu.watch_dir` is a
  supported way to build a straight receive-and-forward gateway. `validate()` does
  not refuse it and no document states it either way, so this describes only the
  three code paths that demonstrably write into the outgoing folder.
- What an SCU is told end-to-end when a C-MOVE destination accepts the
  association and then rejects or fails the individual C-STOREs. `qr.py` wraps none
  of it; pynetdicom owns the sub-association and its status accounting.
- Whether `InstanceIndex.count()` was once wired to a QIDO total-count header and
  removed, or has never been wired up. Its docstring says QIDO-RS needs it; no
  caller exists under `pacs/`, and QIDO derives its truncation warning from
  `len(rows) >= limit` instead.
- How a truncated file left in `received/` by an interrupted `save_dicom` is ever
  cleaned up. Nothing detects or removes one; a rescan skips it as unparseable.
- Whether anything outside this process — a systemd unit, the Electron shell, a
  container restart policy — restarts a dead engine. `pacs/` does not supervise its
  own worker threads, and only `pacs/` was read for this document.
- The dashboard front end (`pacs/web/app.js`) was not read. Everything here about
  the dashboard is what the API returns, not what the UI renders with it.
