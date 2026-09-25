# Emergency RIS + Worklist — design

Status: **built and serving**. This began as a proposal and is now the feature's
published spec: somebody reads it instead of the code, so where the two disagree
it is a defect in one of them. Steps 1–4 of the build order at the end are
done — the extended order model, the use-case-B capture bridge, the MWL SCP
(`pacs/mwl.py`), and the health monitor plus emergency state machine
(`pacs/emergency.py`) with hold-and-forward — as is the alert that tells the room
a hand-keyed order arrived. What is *not* built is marked where it appears:
HL7-out, MPPS, and the service regroup. Delivery for use case A was decided as
**both** MWL (pull) and HL7-out (push); only the pull half exists, and the push
half has since been decoupled from the emergency protocol altogether (below).

---

## The two use cases

**A — RIS platform is DOWN → Carino is the emergency order *source*.**
A tech hand-keys the patient + order into Carino, and the order must reach the
modalities so the exam can proceed. Carino stands in for the RIS/worklist
originator.

**B — Modality has NO DICOM license → Carino runs on that station as a *gateway*.**
A live RIS sends the order *in* (HL7), it shows on screen, the tech performs the
study in a legacy/non-DICOM program, exports a PDF/image (or prints), and Carino
wraps it as DICOM and forwards it to the real PACS.

Note the asymmetry: **A = order OUT of Carino, RIS absent. B = order INTO Carino,
RIS present.** They share the order store but move data in opposite directions.

---

## The load-bearing insight: modalities PULL, they are not PUSHED

In DICOM you cannot push an order onto a modality. A modality learns its
schedule by **querying a Modality Worklist (MWL)** and pulling matching items.
So "send orders to specific destinations (modalities, AE titles)" becomes:

> Carino runs an **MWL SCP** (worklist provider). Each modality is configured to
> query Carino by AE title and pulls the hand-keyed order, filtered to itself by
> its **Scheduled Station AE Title**. That AE title *is* the "destination".

Consequences:
1. **Hard limit:** a modality that cannot be reconfigured to query Carino as its
   worklist source cannot receive the order — there is no DICOM fallback. This
   must be stated to operators.
2. **HL7-out was to be the other half of "both":** for destinations that speak
   HL7 (a broker or a second RIS), Carino would send an `ORM^O01` over MLLP.
   *Not built, and decoupled from the emergency protocol* (below) — it would not
   reach bare modalities anyway, only HL7-capable systems.

---

## Shared order model (the backbone)

Everything revolves around one `OrderStore`. An order began as:
`accession, patient_id, patient_name, patient, study_desc, modality,
scheduled_dt, referring, priority` + `id/status/source/created/closed`.

For MWL conformance and both use cases it gained the following, and all of them
are in `ris.ORDER_FIELDS` now — plus `origin`, which says who created the order
and therefore who is allowed to end it:

| New field | Maps to (DICOM) | Why |
|---|---|---|
| `patient_birthdate` | PatientBirthDate (0010,0030) | MWL patient identification |
| `patient_sex` | PatientSex (0010,0040) | MWL patient identification |
| `station_aet` | ScheduledStationAETitle (0040,0001) | **the "destination" for A**; MWL filter key |
| `station_name` | ScheduledStationName (0040,0010) | optional display |
| `placer_order_number` | ORC-2 (HL7) | order identity — what makes a second message about this order recognisable |
| `filler_order_number` | ORC-3 (HL7) | ditto; often assigned only on the second message, so both are kept |
| `sps_id` | ScheduledProcedureStepID (0040,0009) | MWL procedure step |
| `procedure_id` | RequestedProcedureID (0040,1001) | MWL requested procedure |
| `study_uid` | StudyInstanceUID (0020,000D) | **generated at order creation** so the exam burns the right UID and reconciliation is exact |

`study_uid` generated up front is the linchpin: it makes both the returned-study
match (A) and the wrapped-export identity (B) exact instead of fuzzy.

### Lifecycle

```
                 (MWL C-FIND pulls it)        (study returns / capture bound + sent)
 SCHEDULED ───────────────────────────▶ [IN_PROGRESS?] ─────────────────────────▶ COMPLETED
    │                                        (optional, via MPPS)
    └───────────────────────────────────────────────────────────────────────────▶ CANCELLED
```

The plan was to keep the stored `status` as `open | closed` and add `state`
(`scheduled|in_progress|completed|cancelled`) beside it. **`state` was not
built** and is not missed: the store carries `status` plus `close_reason`
(matched, captured, cancelled here, cancelled by the RIS), which is every
distinction
anything currently asks for, and IN_PROGRESS is only reachable with MPPS, which
is deferred. Read the lifecycle above as the shape of the feature, not as fields
on the record.

---

## Use case A — the EMERGENCY FAILOVER protocol (revised)

Revised framing: A is not "tell the RIS." The RIS is **dead** and we don't care
what it thinks. A is an **automatic failover state** whose only goal is *keep
imaging flowing and lose nothing*. When the primary system is unreachable too
long, Carino takes over the local roles, and back-fills the real PACS when it
returns.

Operator flow (manual only where it has to be):
1. Reception **creates** the order in Carino — the panel during an outage, HL7
   when the RIS is alive.
2. There is **no publish step**: an open order *is* a worklist item, so it is
   available to a modality the moment it exists.
3. Modality performs the study → **C-STOREs it back to Carino**, which stores it
   and, while the emergency is active, queues it for the primary.
4. The study **reconciles itself** to the order — Study UID first, then
   accession, then patient ID — and closes it. With `ris.auto_close` off it stays
   open for somebody to relate by hand; the use-case-B capture is the other way
   an order reaches closed.
5. When the primary is verified back, the held studies are **forwarded** to it.

Two DICOM capabilities underlie this, and **they are independent switches**
(see reach below):

### A1. MWL SCP — `pacs/mwl.py` — the *worklist source*

- `pynetdicom` AE supporting `ModalityWorklistInformationFind` / `EVT_C_FIND`,
  same start/stop/counter/TLS/allowed-AET shape as `StorageSCP` / `PrintSCP`.
- On C-FIND: match **open** orders against the query keys — PatientID,
  PatientName, AccessionNumber and StudyInstanceUID at the top level, Modality,
  ScheduledStationAETitle and SPS start date (ranges included) inside the
  Scheduled Procedure Step Sequence, with universal, wildcard and multi-valued
  keys honoured — and yield one worklist item per match (patient level +
  Scheduled Procedure Step Sequence).
- Every **other** key the SCU fills in is treated as a return key, which can only
  ever *widen* the answer: a modality is shown items it did not ask for, never
  deprived of one it did. That is the right way round for an emergency worklist,
  and it is the first place to look when a list is too long.
- Config `mwl` section; reuses `OrderStore` unchanged — open orders *are* the worklist.

### A2. Hold-and-forward — the *store target* substitute

- Studies C-STORE'd into Carino during the outage are **stored and queued** for
  the primary PACS, then auto-forwarded on recovery.
- **This is mostly the existing machinery**: the folder watcher + stuck-send
  retry with backoff already "keep trying every destination until it accepts,
  nothing dropped." What the emergency adds is that *received* studies
  **auto-enter the forward queue**, which outside an outage is a manual Send:
  while the state is active (and `emergency.hold_and_forward`, on by default)
  every received instance is copied into the watch folder, independently of
  whether it reconciles to an order.
- The copy is **pinned** to the primary destinations on the watcher's send state
  rather than left to the rule engine. A pin only ever widens a route; without
  one, a single `{"destinations": ["Teaching"], "stop": true}` rule could mark a
  held study fully sent — and let it be archived or deleted — having never
  reached the primary, which is the entire reason hold-and-forward exists. With
  no enabled destination flagged `emergency_trigger` there is no primary to hold
  *for*, and that is warned about once per process rather than held silently.

### HL7-out — DECOUPLED / deferred

Sending `ORM` back to the RIS is pointless when the RIS is dead, so HL7-out is
**not part of the emergency protocol**. Keep it as a separate, optional, manual
feature for HL7-capable brokers — or drop it entirely for now. (Open question.)

### Closing an A order

Study returns to Carino → `_reconcile_study` matches (prefer `study_uid`) or the
operator relates it manually → order closes. Reused by B verbatim.

### Naming the modality — a closed list, never a typed word

Matching on Modality is exact and case-insensitive, and **lenient means blank,
not wrong**. An order that names no modality is shown to every console; an order
that says `CT` is shown to the CT; an order that says anything else is shown to
nobody. While the field was free text, that last case was the easy one to
produce — `CT HEAD`, `Chest CT`, `Ultrasound`, and, since the appliance ships in
four languages, `TAC` or `ECO`. Each of those is an order that reaches no
modality-filtered worklist query at all, while reception is told *"the Modality
Worklist is serving it"*, the tick moves, every dashboard holding `orders.read`
flashes and beeps, and the row sits on the Open tab: four surfaces agreeing about
an order no scanner will ever pull. Typing **more** than the code made the
patient less visible, not more, and the only order that reached every console was
the one where nobody typed a modality at all. That is not a rule a receptionist
mid-outage can be expected to know, so the field no longer lets her express it.

`#ordMod` is **a closed list of DICOM modality codes** — built in `app.js`
(`modalityChoices()` / `fillModalityChoices()`), not written into the HTML,
because the codes are DICOM's and are never translated while the words naming
each exam are. Every value the panel can submit is a code a scanner can ask for.
Three properties of the list carry as much weight as the constraint itself:

- **"Not stated" is first, is the default, and is a real answer** rather than a
  validation failure to nag about. It is the lenient branch — the order shows on
  every worklist — which is the right outcome when reception does not yet know
  which room the patient is going to, and far better than making them guess.
- **The list is a constant, not the configuration.** The station picker beside
  it has to be built from the registry — a room's AE title is not something a
  constant can know — and getting that list to reception without `config.read`
  needed its own endpoint (see the next section). The modality list needs
  neither: DICOM's codes are the same in every department, so building it from
  the configuration would have bought nothing and cost the one profile that
  types these orders its choices on any appliance whose registry is thin or
  whose status poll has not landed. The set is what this fleet plausibly
  schedules, and anything outside it is `OT` — which is what the write path
  would have chosen anyway. What the registry IS used for is the reach check
  above: the list stays constant, and the *warning* about a code nothing here
  answers to is where the department's own equipment gets a say.
- **It is the intake that is constrained, not the store.** An order arriving over
  HL7 carries whatever the RIS put in OBR-24, and the API takes the field it is
  given; the wire-side rules below are what stand between such a value and an
  illegal element. The panel is where the value is *invented by a human*, and
  that is where a closed list belongs.

The appliance could already *diagnose* this after the event — the worklist probe
asks, in as many words, whether "the MODALITY key is the problem"
(`server._probe_verdict`) — but that panel is behind `config.read`, it runs only
once somebody has already complained, and by then the exam did not happen. A
diagnosis is not a substitute for a field that cannot be filled in wrongly.

**A closed list is not the same as a list of codes that reach anybody here.**
Two of the sixteen are `CR` and `DX` — computed and digital radiography, both of
them "an X-ray" to the person booking one, and exactly one of them is what a
given department's X-ray room answers to. Picking the other is a legal DICOM
code, a legal element, and an order no console pulls. So the dashboard checks
the chosen code against the department's own registry
(`modalityReachGap()` / `configuredModalityCodes()` in `app.js`, built from the
station list described below) and replaces "the Modality Worklist is serving it"
with a sentence naming the code nothing here answers to. It is **silent when the
registry is unknown and when the field was left blank** — an empty registry is
"not written down", never "none", and blank is the choice that shows the order
on *every* worklist. This half lives in the dashboard rather than the engine
because the registry is already on the page and the check costs no request;
that asymmetry with the station check below is noted in "Still open".

### Aiming the order at a room — and the capability that shaped the field

`ScheduledStationAETitle` is matched by the same rule as Modality — exact
equality, and **lenient means blank, not wrong** (`mwl.py`,
`_match_text(..., lenient_blank_order=True)`). So the field labelled *Target
modality* has three outcomes and only three: left empty, and every console sees
the order; an AE title a console really answers to, and that console sees it;
anything else, and no station-filtered query sees it at all. A room's NAME is
the natural thing to type — `SALA CT`, `CT room 1`, `Somatom` — and every one of
those is the third outcome.

**The field is a picker now, and the reason it was not one before is a
capability.** The station list lived in the configuration, `GET /api/config` is
gated on `config.read`, and Reception holds `orders.read` + `orders.write` +
`studies.read` and not `config.read`. The picker therefore populated for
administrators and fell back to a text box for the one profile that types these
orders — which is the same trap the modality field was in, one label further
down. The fix is not to widen `config.read`: it is to publish what an
order is actually addressed to, on its own, under the capability the person
addressing it already holds. `PacsServer.station_list()` is that projection —
name, AE title, modality code, enabled, and nothing else from the entry — and
it is served in two places:

- inside `/api/status` (`modalities`, gated on `orders.read`), so the form
  rebuilds itself as rooms are registered or renamed; and
- at `GET /api/ris/orders/stations` (`orders.read`), because the form needs the
  list before the first status poll lands. This one is `usable_only`: it is
  feeding a picker, and a picker should not offer equipment out of service. The
  form applies the same filter to either list, so the two agree on screen.

A projection and never the config entry itself: an entry may grow a field that
is the administrator's business, and a list an unprivileged profile reads must
not widen because something upstream did.

The control follows the registry (`fillStationChoices()`): rooms registered, and
it is a `<select>` whose first choice is *"Any modality — shows on every
worklist"*; nothing registered, and the text input stays, because an appliance
with an empty registry that refused to accept a station would leave an order
unaimable during the outage it exists for. The target is deliberately **not
sticky** across orders — an inherited station sends the next patient's order to
the previous patient's room — and a value typed before the registry arrived and
not offered by it is dropped rather than hidden, so it cannot come back on the
next order.

**And the engine still judges the value, because the dashboard is not the only
client.** `message` is what curl, a script and any browser too old to know the
code keep, so "the Modality Worklist is serving it" may not be true there and
false on screen. `PacsServer._station_is_unknown()` decides, and
`_worklist_outcome()` asks it **only** on the serving branch — the other three
outcomes are about a worklist that is not there at all, and they say it better
than this can. Three deliberate silences, each a case where a warning is worse
than none:

- **blank** is the lenient branch and the form's default — "show it everywhere",
  never a miss;
- an **empty registry** means nothing has been written down, and most installs
  start that way; checking against it would warn on every order ever typed,
  which is how a safety sentence stops being read;
- a registered room that is **switched off** still answers to its AE title —
  `enabled` governs what this appliance *sends to*, not what pulls a worklist.

The last one makes the picker offer strictly fewer rooms than the check accepts
(`station_list(usable_only=True)` for the form, `station_list()` for the check),
and that asymmetry is the right way round: the picker is choosing on somebody's
behalf and should not offer equipment out of service, while the check is judging
a choice already made, possibly by another client on another day. The comparison
is upper-cased, which is how `mwl.py` matches the key and how `config.py`
already refuses two rooms the same AE title — an order that *will* reach its
console must never be warned about over a difference the matcher does not make.

The order is **never refused** for any of this. An outage is not the moment to
reject a patient over an AE title, and the registry is evidence of what somebody
wrote down, not of what exists. What changes is the sentence.

### The item a modality gets — every value legal for the element it lands in

Leniency decides which orders a scanner is *shown*; validity decides whether the
item it is shown **survives the trip**. They are separate failures, and they cost
the same thing: an order that matches and then arrives as an item the console
rejects is as absent as one that never matched. So every value written into a
worklist item is checked against the VR of the element it lands in, and there is
**one table of those rules** (`_VR_SINGLE_VALUE_RULES` in `pacs/mwl.py`) rather
than a rule per call site — the length cap, the character repertoire, and, where
the VR has one beyond its repertoire, the grammar as well (`1.02.3` is spelled
entirely in legal UID characters and is not a UID).

**The check runs on both sides, because an item is built from two sources.** The
*order side* is what the receptionist typed or what HL7 sent. The *query-echo
side* is the answer this module owes a scanner for a key it matched **leniently**:
the order left the field blank, the SCU asked for a specific value, and the
attribute is Type 1 — it may not come back empty, and it may not come back
contradicting the key the SCU matched on, so the queried value is the only answer
that satisfies both (and it is the true one: the item is being offered to that
scanner, for that scanner to perform). Echoing exists to stop a strict SCU
dropping the item, and **an SCU strict enough to drop a zero-length CS is strict
enough to drop an illegally-valued one** — so the queried value goes through the
same table before it is written (`_echoable`), plus the one rule that belongs to
echoing alone: a wildcard is refused, because `CT*` is a perfectly legal CS value
and still not a Modality any IOD defines.

**Identifiers and prose get opposite dispositions, on purpose.** A value its VR
cannot carry is dropped whole when it *identifies* something (`_vr_value`) — a
clipped accession names a different order and a clipped patient ID a different
person — and the attribute falls through to its documented stand-in instead.
Prose is clipped and stripped (`_vr_text`): a description cut at LO's
sixty-fourth character still describes the same exam, and a backslash inside a
typed description is a typist's slash, not a request for a second value.

**Nothing goes out empty, and each stand-in says something true**: `OT` for a
modality nobody stated (the standard's own defined term for "equipment class not
stated"), `UNASSIGNED` for a step addressed to no room, `TMP-` + the order id for
a patient with no ID, `UNSPECIFIED - SEE ORDER` for the two description
attributes — Type 1C with no code-sequence alternative on the items this module
builds, so a blank there costs what a blank Type 1 costs — and a derived Study
Instance UID where the stored one is not a UID. Dates and times are checked
against the calendar and the clock rather than against a character set, because
eight digits is the *form* of a DA and `20260231` is not a day.

**A multi-valued match key means "any of these", and is read as several values.**
A shared CT/MR console sends `Modality=CT\MR` and is entitled to the CT orders
*and* the MR ones. pydicom hands that key back as a `MultiValue`; read as one
long string it is the Python repr `['CT', 'MR']`, which equals no order's
modality and matched nothing — hiding from that console precisely the orders on
which the receptionist *did* name the modality, while the untargeted ones still
appeared on the lenient branch. The key is asked by **type**, not by "can I
iterate this": `PatientName` comes back as a `PersonName`, which iterates over
its characters, so `DOE^JANE` read that way would be eight one-character values
and match nobody. Empty members are dropped — a trailing `CT\` is one console's
punctuation, not a request for every order on the appliance — a key whose members
are *all* empty is the universal query it looks like, and a multi-valued key is
never echoed back into the item, because the step is not "CT and MR": that item
carries the stand-in.

### Telling reception whether the order is going anywhere

Pressing **Queue order** used to answer the wrong question. "Order queued" says
the order reached a file on this box; reception cares whether the tech at the
modality will see it, and that only happens if a Modality Worklist is actually
serving. So the confirmation names which of **four** situations the order just
queued is in: the worklist is serving it; the worklist is serving it but the
order was **aimed at a station nothing here answers to**; the worklist is
enabled but not running; the worklist **failed to start**; or no worklist is
enabled at all.

Three of those five were added one at a time, and each addition moved the
sentence one step closer to the question reception is actually asking — *will
the tech see this?* — rather than the one the box can answer most easily. The
failed-start case separated "no worklist" from "a worklist that lost a race for
its port": an emergency brings its own worklist up whether or not `mwl.enabled`
is set, so on that appliance the strictly-configured predicate is False and
reception was being told *"no Modality Worklist is enabled — Enable MWL"* — the
wrong cause, and a remedy that cannot work, since enabling MWL binds the very
port something else is already holding. (The appliance knew better the whole
time: `emergency.mwl_error` is on the status payload the dashboard is already
polling.) The station case separates "a worklist is serving" from "a worklist is
serving this order *to somebody*". The order the questions are asked in is the
repair, not an accident of how the branches were typed: failed-start before
merely-configured, and the station asked only inside the serving branch, because
the three sentences about a missing worklist say what is wrong better than it
can.

**This is the one engine string that is translated, and the exception is
deliberate.** Engine text — log lines, API errors, the cause of a failed start —
is English in this codebase because of *who* reads it: the person who can act on
it, who is reading the log anyway. Four of these five sentences are not that.
A receptionist reads them mid-outage, and they are the only place anybody is
told that the order just typed is reaching no scanner: there is no banner for
it, no badge, no LED. The appliance ships in es, pt-BR, ja and ru, and a safety
warning the person at the desk cannot read is not a warning. The response
therefore carries a **code** — `order_queued_serving`, `…_station_unknown`,
`…_mwl_stopped`, `…_mwl_failed`, `…_no_mwl`, each with a `test_order_queued_…`
twin — which the dashboard maps to the sentence and says through `T()`, so it
sits in the four locale blocks like every other user-facing string. The English
stays on `message` regardless: curl, the tests and any client that is not the
dashboard keep exactly what they had. A dashboard too old to know a code falls
back to that English (still true), and then to the bare "Order queued", which is
at least not a claim about propagation.

**The contract, and the gate that holds it.** The code is built in `add_order`
as one of two prefixes plus a tail returned by `_worklist_outcome()`; the
English lives in `PacsServer.ORDER_QUEUED_MESSAGES`; the dashboard has a `case`
per code in `orderQueuedText()`; and each sentence appears in all four locale
blocks of `i18n.js`. That is one fact spread over three files, and the end that
rots silently is the far one — rename a tail and `add_order` raises `KeyError`
on the one call reception makes mid-outage; add an outcome and the dashboard
falls back to engine English in front of a Japanese front desk. Neither pytest
on the engine nor `i18n-parity.mjs` on the web files can see either, because
both halves stay internally consistent and the only thing wrong is between them.
Two tests in `tests/test_emergency_worklist.py` walk it in both directions: one
from the sentences outward to the `case` and the four locales, and one from what
`_worklist_outcome()` can actually **return** — read out of its source rather
than listed by hand, so a fifth outcome enrols itself — inward to the dict, the
`case`, and the code the product really answers with when asked in each of those
states. The pairing is asserted too: every outcome is said for a real order
*and* for a test one, because a warning that exists for real orders and not for
rehearsals makes the rehearsal of that exact situation the run that says
nothing.

**And how loudly, which is half of the message.** All five confirmations used to
be painted the same green and gone in five seconds — so the one sentence on this
page that says an emergency order will not reach a scanner looked exactly like
the one that says it will, and differed only in words, which is the difference a
front desk mid-outage does not read. The four that say the order is reaching
nobody now get the treatment this dashboard gives every other piece of bad news,
and three properties of it are load-bearing:

- **Red, not green.** `flashNote(..., ok=false)` → `.toast.bad`, `var(--bad)`,
  the same colour as a failed save.
- **Announced.** `#toast` normally carries no `role` and no `aria-live`, so a
  screen reader never hears a toast; a warning sets `role="alert"` +
  `aria-live="assertive"`, and the next ordinary toast (or the dismiss button)
  strips both again — which is what keeps the routine green ones from
  interrupting somebody mid-sentence. The text is
  appended a tick later (60 ms) rather than in the same frame the attributes
  are set, because a live region populated in the breath it is created in is
  not reliably announced. The arrival alert's own region (`#ordAlertLive`,
  `role="status"`, polite) is a different surface for a different event, and
  the two do not compete: one says an order arrived, the other says the order
  you just typed is going nowhere.
- **It does not time out.** Five seconds is not enough to read a sentence
  nobody was expecting, and the fact it carries stays true until somebody acts
  on it, so it goes when it is dismissed or when the next toast replaces it.
  The way out is a real ✕ **button** with a translated `aria-label`, not a
  click anywhere on the box — the reader it stays up for may be on the
  keyboard.

**Which outcomes count as bad news is a list of codes, not a pattern.**
`ORDER_UNREACHED` enumerates the eight non-serving codes explicitly, so a code
this build has never heard of is *not* assumed to be bad news: an engine that
adds an outcome gets the neutral treatment until the dashboard learns it, which
fails towards a green toast with true English text rather than towards a red one
about something nobody can name. The dashboard's own modality-registry check
flips the same switch, so the two paths to "this order reaches nobody" — the
engine's verdict and the local one — are said in one voice.

### Telling the room an order arrived

Step 1 of the operator flow has a hole: reception types the order, and nobody in
imaging knows. The Orders panel does not refresh itself, and a receptionist
cannot walk to the modality every time. So an arriving order **alerts** — a
sound plus a visible flash on the dashboard of everyone who can see orders.

**The signal is a tick, not a number.** `/api/status` gains one integer in the
`ris` block:

> `ris.created_seq` — orders **created** for a real patient, counted for the
> life of the **store** rather than of the process. Manual entry and HL7 both,
> nothing else. Monotonic, and **persisted in `orders.json`** next to the
> orders, so a restart carries on counting instead of starting over.

It is stamped in `OrderStore._add_locked`, which is the single place an order
comes into existence (`add()` serves the panel, `apply()` serves HL7), and it
skips `carino-test` orders so the test generator can exercise the whole chain in
silence. It is read off the **store**, not off the listener: the store is live
with HL7 intake stopped, and that is precisely the emergency this feature is
for.

The client keeps the last value it saw and alerts on an increase. First value
after a load or a sign-in is **adopted, never announced** (a refresh must not
beep), and a value that went *down* no longer means "the engine restarted" — a
restart keeps its count now. What is left in that arm is the tick **losing its
base**: an `orders.json` written before the counter was persisted (the one
upgrade restart), one restored from a backup, or a store directory repointed.
The number then means nothing this page can diff against, so it re-baselines
silently rather than inventing an arrival count out of it. Five orders between
two polls read as one alert saying five.

**Why the tick is persisted, and not stamped with a boot identity.** The
counter was process-lifetime by design at first, the restart-to-zero being read
by every dashboard as "re-baseline, announce nothing". That was wrong in the
one direction that matters: a restart is not an empty moment. The HL7 listener
accepts before the web server answers its first poll, and reception keeps
typing throughout, so a dashboard that has been up all shift sees the smaller
value only *after* the new process has already created orders — and those
orders are inside the value it adopts in silence. A nightly restart followed by
the RIS flushing three STAT orders produced no beep, no flash and no
announcement: exactly the failure this feature exists to prevent.

The obvious alternative was to leave the counter in memory and pair it with a
boot identity (a process UUID, or the start time) so the client could tell
"restarted, re-baseline" from "went backwards, something is wrong". It was
rejected because it does not fix the defect above — the dashboard would still
re-baseline across the restart, and still swallow the orders taken while the
service was coming back. It also costs a second field in the payload that has
to stay in step with the first, and a second branch on the client that only the
restart path exercises. Persisting keeps the tick monotonic across the restart
instead, so those orders read as the arrivals they are; it costs one integer in
a file that is rewritten in full on every change anyway; and a restart on its
own still moves the tick by nothing, which is the property the process-lifetime
design was actually protecting. The residual gap — a file that carries no count
at all — costs one restart rather than every restart, and lands in the
re-baseline arm above.

Three fields already in the payload were considered first and each is wrong:

| Candidate | Why not |
|---|---|
| `ris.orders_in` | Counts what the HL7 **listener** created. Structurally zero for a hand-keyed order — the listener is down, that is why reception is typing. |
| `ris.counts.total` | Falls when closed orders are purged. A client diffing a number that fell cannot tell that from "nothing happened", and then misses the next real order. |
| `ris.last_order` | The newest **open** order, so its id moves backwards when that order closes; `created` is second-resolution, so two orders in one second tie. |

**The list refresh is a separate rule** and rides `ris.counts`: while the Orders
panel is open, any change to `open/closed/total` refetches the list. That covers
a create *and* all three close paths (C-STORE, STOW-RS, capture), so a row stops
showing as Open on its own. Known gap, stated rather than papered over: an HL7
amendment moves no count, so an amended row stays stale until the next counted
change or a manual refresh.

**Who is alerted.** The `ris` block is gated on `orders.read`, so the audience is
Reception, Radiologist and Administrator — the people waiting for the exam. An
**IT profile has no `orders.read`, never receives the block, and is never
alerted**; nothing else gates this, because a second gate would be one more
thing to keep in sync with the first.

That last part is a **known gap, not a feature**. The preset IT profile holds
`services.control` and `config.read` — it is the profile that can start a
worklist that is not running, which is one of the things the queue
confirmation tells reception to go and ask for — and no arriving order will ever
make its dashboard flash. What reaches IT instead is the emergency banner, the
services panel and the log: surfaces about the appliance rather than about a
patient. Closing the gap would mean handing order identity to a profile
deliberately kept away from it (its `phi_visible` is accession and patient ID,
and nothing else), so it stands until there is a signal that carries the arrival
without the patient.

**The mute preference is per-workstation, in `localStorage`
(`carino_pacs_order_beep`), not in config.** It has to be: neither Reception nor
Radiologist holds `config.read`, and `GET /api/config` is gated on it — a
server-side `web.*` toggle would be unreachable by exactly the people it is for.
Per-workstation is also the right semantics, since a shared reception PC and a
tech's reading screen want different answers. Default is **on**: absent,
unreadable or anything but `"off"` means sound, so a private-mode window fails
loud rather than silent.

**The sound is synthesised, not shipped.** The dashboard is served over plain
HTTP (`app.run(...)`, no `ssl_context`), so any workstation that is not
localhost is a **non-secure context and the Notification API is unavailable by
spec — it is not used**. WebAudio is not secure-context gated, so the alert is
two short rising sine chirps built at runtime: an appliance installs offline and
must not depend on an asset somebody can delete.

**Browser autoplay policy is the one thing that can make the tone unavailable,
so the button has three states, not two.** "Sound is on" (a `localStorage`
preference) and "sound can play" (an `AudioContext` in state `running`) are
different facts, and painting only the first is how a control ends up reading
"🔔 Sound" on a page structurally incapable of making one. Arming is attempted
at load *and* on every gesture until one works — the workstation this alert
exists for is the one nobody is sitting at, and a kiosk autostart, a restored
session or an F5 reaches a dashboard that never receives a click. Where the
policy refuses, the button reads **🔔 Arm sound** and says so; the flash and the
live region are unaffected. The listeners follow readiness rather than being
dropped on first success, because success is not permanent: the user agent may
**close** a context on its own when the output device goes away (the front
desk's USB speaker, unplugged mid-shift), and a closed context can never be
resumed — it is rebuilt. `onstatechange` repaints the button the instant any of
this changes, so the control never promises sound the page has stopped being
able to make. An arrival that finds the context asleep is *owed* a tone for four
seconds rather than dropped, since a resume off sticky activation settles a turn
later; past that the debt expires, because a chirp minutes late says "something
just arrived" about something that did not.

**A true kiosk — no keyboard, no mouse, nobody to click — needs
`--autoplay-policy=no-user-gesture-required` on the browser command line.**
Nothing in the page can substitute for it, and without it that screen is a
flash-only alert by the browser's choice, not ours.

**Muted still means visible.** Mute silences the tone only — the Orders nav
button and its badge still flash, the RIS LED still blinks, and a polite live
region still announces the arrival for a screen reader. A muted front desk must
still be able to see that the order landed.

**A background tab is alerted twice.** The alert is deliberately not gated on
`document.hidden`, and the beep does reach the room from a tab nobody is looking
at. The other two surfaces do not: Chrome clamps timers in a hidden page and,
past five minutes hidden, throttles them to once a minute, so an order can go
unnoticed for up to that long; and the flash is a CSS animation on a document
timeline that keeps running while nothing is painted, so it burns its three
pulses on an empty screen. `visibilitychange` therefore polls immediately on the
way back and re-fires the flash and the announcement for whatever landed while
the tab was hidden — but not a second beep, which already played.

---

## Emergency failover — trigger, state machine, and reach

Built as `pacs/emergency.py`. The idea: a **per-destination toggle** marks the
primary PACS; if it is unreachable beyond a threshold, Carino auto-enters
emergency mode.

### The decomposition that keeps it sane

Do **not** treat "emergency" as one monolithic switch. An outage has two
separable failures, and Carino has two separable reactions:

| Primary failure | Carino reaction | Capability |
|---|---|---|
| **Store target down** (PACS won't accept studies) | **Hold & forward** — keep receiving, queue, back-fill on recovery | A2 (the existing watcher, plus the auto-queue) |
| **Worklist source down** (RIS/MWL feed gone) | **Local worklist** — MWL SCP + manual order entry | A1 (`pacs/mwl.py`) |

In your scenario both fail together (combined RIS+PACS outage) so both fire —
but modelling them separately means a store-only outage doesn't needlessly spin
up a worklist, and a worklist-only outage doesn't imply studies are stranded.
Reach is explicit instead of "everything turns on."

### What counts as "offline" (the detection problem)

A passive signal is not enough: if nothing is being sent, nothing fails, so an
outage that starts during a quiet period is invisible until the next study. So:

- **Active probe:** a C-ECHO to each *armed* destination every
  `probe_interval_sec` (30 s by default).
- **Passive signal:** the watcher's stuck sends count too. That signal is per
  destination *name*, by construction — the sender records a name as sent only
  once every node carrying it accepted — so a stuck name marks each of its nodes
  as failing, which is the honest reading: one of them is not taking images.
- A destination is **offline** after `offline_threshold` of continuous failure
  (probe + real sends agreed), with **hysteresis** on the way back (N consecutive
  successes) so a flapping link can't rapidly toggle emergency on/off. **[decided:
  both signals]**
- **Recovery caveat:** C-ECHO success ≠ C-STORE works, and what the monitor can
  ask is C-ECHO. Recovery is therefore judged on probes plus hysteresis, and the
  flush is not a bulk push: it clears the send backoff (`retry_stuck`) and lets
  the ordinary watcher pass try each held instance. A half-broken node that
  accepts an association and refuses the study costs another retry cycle, not
  the backlog — nothing is marked sent until a destination accepted it, which is
  the same guarantee the stuck-send machinery gives outside an emergency.

### Arm, don't surprise-start

Auto-opening listening sockets (MWL/receiver) from a health probe is a big
automatic action. Model it as **arm → trigger**, not silent auto-run:

- Operator **arms** emergency failover once (per destination or globally). This
  is the consent to auto-start servers.
- System **triggers** (enters emergency) when the threshold is crossed, shows a
  loud banner + logs it, and starts the armed reactions (MWL, auto-queue).
- **Exit:** auto-detect recovery and **auto-flush** the held studies, but keep
  MWL running / require a manual **"Resume normal"** to fully stand down — this
  avoids flapping mid-shift. Settled that way; see Decisions below for what
  Resume normal is and is not allowed to stop.

### Global emergency state

```
      arm()           threshold crossed        activate        primary verified back
 OFF ────────▶ IDLE ────────────────────▶ TRIGGERED ────────▶ ACTIVE ────────────────▶ RECOVERING
                 ▲                        (ask, unless          │  (MWL up,                 │ flush
                 │                         auto_activate)       │   receives+queues)        │ held
                 └───────────────── Resume normal ◀─────────────┴───────────────────────────┘
```

Five states, not four: **TRIGGERED** is "a primary is offline and the appliance
is waiting for a person", which is the decision `auto_activate` skips rather than
a state the code does without. A background **health monitor** thread drives the
machine — probes armed destinations, applies threshold + hysteresis, enters and
exits, emits banner and log events — and `status()` is what the dashboard polls:
`armed / state / active / since / trigger_dest`, the per-destination health rows,
`worklist_serving` + `worklist_error`, and three answers about the *person*
asking (`prompt`, `may_activate`, `activate_by`), because holding
`emergency.activate` and being the operator the administrator designated are
different things.

### Data-model additions for this

- **Destination** gains: `emergency_trigger` (bool — "this is a primary; watch
  it"), `offline_threshold_sec`, and runtime health (`last_ok, consecutive_fails,
  online`).
- **Global**: the emergency state above.

### Reach — explicit boundaries (what it does NOT do)

- Does **not** create orders of its own — they come from the panel or from HL7,
  never from the failover.
- Does **not** close an order nothing reconciled to: a study has to match it, or
  a capture be bound to it. `ris.auto_close` decides only whether that match
  closes the order for you or leaves it for somebody to confirm.
- Does **not** mark anything sent to a destination that only half-recovered
  (ECHO ok, STORE failing) — the flush is a retry, and a held instance stays
  queued until a node actually accepts it.
- Does **not** monitor every destination — only ones flagged `emergency_trigger`.
- Does **not** touch the HL7-inbound path (that's case B; RIS alive).
- Emergency = worklist-out + hold-and-forward. It is a *failover*, not a new
  steady-state mode.

---

## Use case B — order IN, capture OUT (built)

Already built: HL7 inbound, Orders display, print/ingest→pending pipeline,
destinations + auto-send.

**The bridge that was missing — bind an exported capture to a displayed order,
so the wrapped DICOM inherits the order's identity instead of being hand-typed —
is built.**

- From an order row: the capture button takes a PDF/image exported from the
  legacy tool, and ingest stamps the DICOM with the order's
  `patient / patient_id / accession / study_uid / study_desc / birthdate / sex`.
- It lands in the outgoing folder for the normal auto-send / hold-and-forward
  pipeline, and the order **closes** with `close_reason = captured` — which is
  how the row reads back as "✓ captured" rather than as another matched study.
- Server surface: one method, `create_study_from_order(order_id, filename,
  data)`, behind `POST /api/ris/capture` (`orders.write`), reusing
  `ingest.build_from_bytes` / `save_instance`.

**Not built:** the **"Assign to order"** picker for print jobs in Pending. A
print job carries no identity, so it is still approved and sent as itself; the
capture path above is the one that inherits an order's.

---

## Reconciliation, unified

An order reaches COMPLETED by one of two routes; matching prefers the strongest
key available:

1. **A route** — study C-STORE'd back → match on `StudyInstanceUID` (exact,
   since we generate it on the order) → else AccessionNumber → else PatientID.
2. **B route** — capture bound to the order → DICOM generated *with* the order's
   identity → sent → closed on send (`close_reason = captured`).

`ris.match_on` stays configurable and decides only the weakest key: `accession`,
or `accession_or_patient` to allow the Patient-ID fallback. The Study UID is
tried first either way — an exact identity is never the wrong answer — and only
**open** orders are candidates.

---

## Config surface (net)

- `ris` (exists) — HL7 **inbound** listener. Unchanged.
- `mwl` (built) — worklist **SCP** for modalities.
- `destinations` (exists) — DICOM outbound (studies). Each gained
  `emergency_trigger` + `offline_threshold_sec`.
- `emergency` (built) — global failover config: `armed`, `probe_interval_sec`
  (30), `offline_threshold_sec` (120), `recovery_successes` (2 — the hysteresis),
  `auto_activate` (off: pop up and ask), `hold_and_forward` (on), and
  `activate_by` / `notify` — who may activate and who is told, which are people
  questions rather than capability ones.
- `hl7_destinations` (new, **optional/deferred**) — HL7-out targets. Not part of
  the emergency protocol.
- Order records carry the fields in the earlier table (store schema, not config).

---

## UI / "distribution" (ties to the earlier redesign question)

Service count is now: Receiver, Auto-send, Print, RIS (HL7 in), **MWL (worklist
out)**, **HL7-out** — the flat card row won't scale. Proposed grouping:

- **Inbound**: Receiver · RIS (HL7 in) · Print
- **Outbound**: Auto-send · MWL (worklist) · HL7-out
- **Orders** as the central workspace (schedule, capture, reconcile)

This is the concrete answer to "UI redesign, distribution-wise": group services
by direction, make Orders the hub.

---

## Decisions (locked)

- **Offline signal:** ✅ **both** — active periodic C-ECHO probe *and* passive
  send-failures, with hysteresis on recovery.
- **Enter mode:** ✅ **arm → auto-trigger** — operator arms failover once; system
  auto-enters on threshold with a loud banner.
- **Recovery:** ✅ **auto-flush, manual full exit** — verified recovery auto-forwards
  the held backlog; MWL stays up until the operator clicks "Resume normal".
  **"Resume normal" stops only the worklist this emergency started.** A worklist
  that configuration wants permanently — `mwl.enabled`, or any enabled
  destination flagged `no_ris` — or one that was already serving when the
  emergency began is left running: `sync_worklist()` runs on launch and on a
  config change, not on a timer, so stopping it would take every modality's
  schedule away with nothing to bring it back. The emergency may undo what it
  did; it may not undo what the hospital configured.
  **Nor may it undo work that is still outstanding.** Resume normal is pressed
  when the PRIMARY is back, which is not the moment the WORK is done: an order
  hand-keyed during the outage exists in this store and nowhere else — it was
  typed *because* the RIS could not be reached, so the RIS that is back was
  never told about it and will never put it on a worklist. While one of those is
  still open the worklist stays up and the log says which reason is holding it.
  **It does come down when they are gone.** All **five** paths that settle such
  an order ask `release_worklist()`: the study arriving and reconciling, an
  operator cancelling, a delete, a purge, and the use-case-B **capture** —
  which is the one an outage is most likely to use, because a site with a
  legacy unit that cannot C-STORE settles every hand-keyed order there. It
  stops a worklist that is bound for orders alone once nothing needs it any
  more, and writes the line answering the one `resume()` left. It is not
  `sync_worklist()` run backwards: it stops only a worklist this appliance
  bound *for* those reasons, never one configuration, an operator or a run-now
  service apply is keeping alive.
  **Which worklist that is, is claimed rather than inferred.** `start_mwl()`
  leaves the worklist belonging to whoever started it, and the two starts that
  ARE reclaimable say so immediately afterwards — `EmergencyController.activate()`
  for the one an outage binds, and `sync_worklist()` for the one a restart
  mid-outage re-binds for orders that exist in this store and nowhere else. The
  opposite default reads better and is wrong: "nothing in the configuration
  wanted this worklist, so it must be the emergency's" is also true of
  `serve --mwl`, the documented run-once override, which then inherited a *may
  be reclaimed* it never asked for — and on a `--mwl` run the first order that
  CLOSED took the worklist down, stranding the orders that were still open and
  logging a stand-down that had not happened. A default every caller but one
  has to undo is a default the next caller forgets to undo, and the next caller
  was a launch flag documented in two manuals. The same "in use" predicate is what
  the config paths read, so an administrator finishing the setup chooser in the
  middle of a failover no longer takes the emergency's only path to the
  modalities down with it.
  Activation reports the worklist honestly too
  (`emergency.worklist_serving` / `worklist_error`, asked of the SCP rather than
  remembered): a start that failed is never announced as "Worklist serving", and
  the same failure is what the queue confirmation names for reception.

## Still open (non-blocking)

- **Primary identity:** PACS, RIS, or combined box? The two-switch decomposition
  supports any, so this doesn't block the build — it just sets defaults.
- **HL7-out:** keep for a broker, or drop? Dead weight in the RIS-is-dead
  scenario; scheduled last, buildable or droppable then.
- **MPPS** — deferred; returned-study match + manual "Mark performed" instead.
- **Where the two reach checks live.** The station check is in the engine
  (`_station_is_unknown`, on the `order_queued_*` code, so every client gets
  it); the modality one is in the dashboard (`modalityReachGap`, off the
  registry already on the page). The split is defensible — the engine's answer
  is the one every client repeats, the dashboard's costs no request — but it
  means an order queued through `POST /api/ris/orders` with a modality code no
  room here answers to is still told "the Modality Worklist is serving it". The
  panel cannot produce that value, so nothing reaches a patient through it
  today; folding the modality check into `_worklist_outcome()` beside the
  station one would close it and make the pair symmetrical.
- **MWL query breadth:** settled at the common set (station AET, modality, SPS
  date, PatientID, PatientName, accession, Study UID); the module lists what it
  honours and states that everything else only widens the answer. Still worth
  asking a site which keys its modalities actually send before widening further.

---

## Build order

1. ✅ **Done** — Extend the order model (fields + `study_uid` on create) + UID-first matching.
2. ✅ **Done** — B bridge: create-study-from-order + close-on-fulfil. Shared by A and B.
3. ✅ **Done** — A1 MWL SCP (`pacs/mwl.py`): C-FIND worklist provider over the open
   orders, lenient matching, station/modality/date filters, Study-UID carried through.
4. ✅ **Done** — Health monitor + emergency state machine (`pacs/emergency.py`) +
   hold-and-forward. Refinement: no permanent emergency card — a monitored
   destination going offline raises a **pop-up asking to activate** (default;
   `auto_activate` skips it). Worklist/Emergency-RIS cards hidden unless running
   or armed. Banner shows triggered/active/recovering with Activate/Resume.
5. ✅ **Done** — Telling the room: the `ris.created_seq` arrival tick, the alert
   (nav flash + polite live region + synthesised chirp + per-workstation mute),
   the list refresh off `ris.counts`, both targeting fields closed against what
   this department actually registered — Modality a closed list of DICOM codes,
   Target modality a picker fed by `station_list()` under `orders.read` — and
   the five-outcome confirmation reception reads when an order is queued, said
   in four languages and, when it is bad news, said in red and announced.
6. **Next** — UI polish: service regroup (inbound/outbound + Orders hub).
7. **HL7-out** — only if kept (optional, last).
