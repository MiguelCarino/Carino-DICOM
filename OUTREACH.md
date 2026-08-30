# Outreach

Copy-paste material for listing and announcing Carino DICOM. The listings
themselves need a human to post, so everything below is written to be used as-is
rather than as notes to rewrite.

Two ground rules run through all of it, and they are not stylistic:

1. **Do not oversell.** This is medical imaging. A department that adopts this
   because a Reddit post implied it was an archive, and then loses a study,
   does not file a bug — it stops trusting the project, permanently, and tells
   its peers. Every claim below is one the README already backs up.
2. **Lead with what it is not.** Not a medical device, not for primary
   diagnosis, no user accounts, no per-user audit trail, no encryption at rest.
   Saying this first costs a few readers and buys the only kind of credibility
   that matters in this field.

**Before posting anywhere, run [the five-minute check](#the-five-minute-check).**
Not because anything is known to be broken — the two defects this section used
to list (a claimed Python floor of 3.8, and a `requirements.txt` that pinned
pydicom and pynetdicom to 2.x while the code used 3.x APIs) are both fixed — but
because they are the things a sceptical reader verifies first, and they rot
quietly. A stale install instruction costs more credibility in this audience
than any missing feature.

---

## The five-minute check

Do this on a clean clone, on the day you post, and post only if all four pass.
Each one is something a technically literate reader hits inside five minutes,
and each one has been wrong here at least once.

1. **The stated Python floor matches what the dependencies allow.** README.md,
   BUILDING.md and CONTRIBUTING.md say **3.10+**; `pydicom` and `pynetdicom`
   both declare `Requires-Python >=3.10`. If either library moves its floor,
   three documents and the CI matrix move with it.
2. **`pip install -r requirements.txt` produces a working environment.** The
   manifest declares `pydicom>=3.0` and `pynetdicom>=3.0` — the majors whose
   APIs the code actually uses. CI installs from this file rather than from a
   list of its own, so a regression here turns the build red instead of being
   discovered by a stranger.
3. **The test suite is green from that environment**, including the suites that
   bind real sockets. `pytest` collects the root `test_print.py` as well as
   `tests/`; see `pytest.ini`.
4. **`docker compose up -d --build` gets you a dashboard**, since that is the
   command both Reddit drafts below promise.

---

## Descriptions

Three lengths, all consistent with the repositioning: a **DICOM gateway and
continuity appliance**, not a small PACS. The differentiator is degraded-mode
operation and the equipment nothing else will talk to — print-only modalities
and hand-keyed accessions.

### One line

> A DICOM gateway and continuity appliance: it keeps imaging moving when the
> link is down, and talks to the modalities nothing else will talk to.

Shorter variant, where a single clause is all that fits:

> A DICOM gateway that keeps imaging moving when the primary PACS goes down.

### Three sentences

> Carino DICOM is a DICOM gateway and continuity appliance: one box in one
> department that receives and forwards studies, serves a worklist, takes HL7
> orders, and answers Query/Retrieve and DICOMweb. What it is actually for is
> the unglamorous case — the modality that can only print film, the department
> hand-keying accessions because the RIS feed is down, and the hour after the
> primary archive stops answering, when scanning has to continue anyway. It is
> not an archive and does not try to replace Orthanc or dcm4chee; it sits in
> front of one as the gateway, and is configured from a single JSON file and a
> local dashboard by a technologist rather than a PACS engineer.

### Paragraph

> Most imaging problems that stop a department are not storage problems. They
> are operational: a link is down, an order never arrived, a modality is twenty
> years old and its only output is film. Carino DICOM is a DICOM gateway and
> continuity appliance built for exactly those hours. It receives and forwards
> studies with conditional routing and optional de-identification, pretends to
> be a laser imager so a print-only modality's film can be captured as a PDF or
> Secondary Capture object and forwarded like any other study, takes HL7 orders
> over MLLP and lets you hand-key them when there is no feed, serves them back
> as a Modality Worklist, and answers C-FIND/C-MOVE/C-GET and DICOMweb. When it
> notices the primary archive has stopped answering it can take over the
> worklist so scanning continues, hold every study received during the outage,
> and back-fill the primary once it responds again. It is deliberately not an
> archive — no tiering, no retention policy, no clustering, no user accounts —
> and the usual deployment puts it in front of Orthanc or dcm4chee rather than
> instead of one. It is not a medical device, is not certified by anyone, and
> is not for primary diagnosis. The one design line it holds everywhere is that
> an image which silently never arrives is worse than a visible failure:
> routing falls back to every destination rather than dropping a study,
> retrieves report failed sub-operations rather than under-counting, and a
> listener that cannot bind leaves the dashboard up so you can see why.

---

## awesome-selfhosted

> **The project is not eligible yet.** awesome-selfhosted requires that the
> software's first release be **more than four months old**. `v1.0.0` is dated
> **2026-07-09**, so the earliest defensible submission date is
> **2026-11-09**. Submitting before then wastes a maintainer's time and gets
> the entry closed. Everything below is ready to file on that date.

Contributions go to the **`awesome-selfhosted-data`** repository, not to the
rendered `awesome-selfhosted` list — the README there is generated. Add one new
file, `software/carino-dicom.yml`:

```yaml
name: Carino DICOM
website_url: https://dicom.carino.systems/
description: DICOM gateway and continuity appliance for imaging departments. Receives and forwards studies, captures modalities that can only print film, serves a modality worklist, takes HL7 orders, and keeps scanning when the primary archive is unreachable.
licenses:
  - AGPL-3.0
platforms:
  - Python
  - Docker
tags:
  - Health and Fitness
source_code_url: https://github.com/MiguelCarino/Carino-PACS
```

Notes on the fields, because each one has a rule behind it:

- `description` is **246 characters**, inside the 250-character limit, in
  sentence case. It deliberately omits "open-source", "free" and "self-hosted",
  which the contributing guide calls redundant on that list.
- `licenses` uses the SPDX identifier `AGPL-3.0`, which is present in that
  repository's `licenses.yml`.
- `platforms` uses `Python` and `Docker`, both of which exist in `platforms/`.
- `tags` is the weak point. **`Health and Fitness` is the only health-adjacent
  tag that exists**, and it is aimed at personal fitness trackers and medical
  record managers rather than clinical imaging infrastructure. Expect a
  maintainer to push back or re-tag. `Miscellaneous` is the fallback. It is
  worth opening the PR with a one-line note acknowledging this rather than
  letting a reviewer discover it.
- Do **not** hand-write `stargazers_count`, `updated_at`, `archived`,
  `current_release` or `commit_history`. Those are filled in automatically;
  including them marks the entry as machine-generated.
- `depends_3rdparty` is omitted, which means `false` — correct here, since the
  project calls out that it has no telemetry and no external service
  dependencies.

Also confirm before filing: the project must be actively maintained, and the
guide explicitly bans LLM-generated contributions that ignore the guidelines.
Read the current `CONTRIBUTING.md` at submission time; the rules move.

---

## Reddit

> **Verify the sidebar rules before you post.** Reddit could not be reached
> from the environment these drafts were written in, so the rules below are
> from general knowledge of the two subreddits and not from a live read of
> their current rule text. Flair names and karma/age thresholds in particular
> do change. Check both, then post.

### r/selfhosted

What that subreddit actually punishes: undisclosed self-promotion, marketing
voice, screenshot-only posts, missing licence or source link, and anything that
turns out not to be self-hostable. What it rewards: a plain description of what
the thing does, why it exists, an honest comparison against the incumbent, and
a maintainer who answers comments.

- **Flair:** use the self-promotion/project flair — on r/selfhosted this is
  normally **`Software Offering`**. Unflaired posts get removed automatically.
- **Disclose authorship in the first line.** Non-negotiable there.
- Post it yourself, from an account with some history in the sub. A brand-new
  account posting a project reads as spam regardless of the project.

**Title:**

> Software Offering: Carino DICOM — a DICOM gateway for the hour your imaging
> archive is down (AGPL, Python, Docker)

**Body:**

> I wrote this and I maintain it, so treat this as self-promotion.
>
> Carino DICOM is a DICOM gateway and continuity appliance. It is **not** an
> archive and it is not trying to replace Orthanc or dcm4chee — both are more
> mature, better supported, and the right answer if you want storage. This sits
> *in front* of one of them and handles the operational failures instead.
>
> Three problems it exists for:
>
> - **The modality that can only print.** Old kit whose only output is film,
>   that no archive will accept. Carino pretends to be the laser imager,
>   captures the film, and turns it into a PDF or Secondary Capture object you
>   can identify and forward like any other study.
> - **No RIS feed, or the feed is down.** It takes HL7 orders over MLLP when
>   there are any, lets you hand-key an accession when there are not, serves
>   them to the modality as a worklist, and reconciles the study back to the
>   order when it arrives.
> - **The primary went down.** It watches the primary, notices, can take over
>   the worklist so scanning continues, holds every study received during the
>   outage, and back-fills once the primary answers again.
>
> Also does the ordinary things: Storage SCP, conditional routing, optional
> de-identification on forward, C-FIND/C-MOVE/C-GET, DICOMweb (QIDO/WADO/STOW),
> a sqlite instance index, and a bundled DICOM tag editor. One JSON file and a
> local dashboard; no accounts to provision, no database to stand up.
>
> `docker compose up -d --build` gets you a Storage SCP on 11112 and a
> dashboard on 127.0.0.1:8042, with a generated token and nothing published to
> your network.
>
> **The honest limitations, because this is medical imaging:**
>
> - Not a medical device. Not CE-marked, not FDA-cleared, not validated by
>   anyone for clinical use. Not for primary diagnosis.
> - No user accounts, no roles, no per-user audit trail. The dashboard token is
>   a single shared secret.
> - No encryption at rest — studies are ordinary files on disk. Put it on LUKS
>   or BitLocker.
> - The HL7 listener is unauthenticated. Anyone who can reach the port can
>   inject orders onto the worklist.
> - It has never been tested against real clinical equipment. It is developed
>   against pynetdicom's own SCU/SCP tools and synthetic studies. If it works
>   with your modality — or especially if it doesn't — that's a genuinely
>   useful issue to open.
>
> AGPL-3.0, Python, no telemetry.
> Source: https://github.com/MiguelCarino/Carino-PACS
>
> Happy to answer anything, including "why not just use Orthanc", which is
> usually the right question.

### r/HealthIT

A different and much harder room: hospital IT staff, integration analysts, HIM
and PACS administrators. It is small, professional, and hostile to anything
resembling vendor marketing — several of its rules exist specifically to keep
product pitches out. A post that reads as a launch will be removed.

Post it as a practitioner sharing a free tool and asking for critique, not as
an announcement. Expect the first three replies to be about HIPAA, audit
logging and validation — which is why those come before the feature list here,
not after.

- **Flair:** check the current list; use a discussion/resource flair rather
  than anything promotional if one exists.
- **Do not post a bare link.** Lead with the operational problem.
- Answer the compliance questions directly and without spin. "It cannot do
  that" is a better answer there than any qualifier.

**Title:**

> Open-source DICOM gateway for downtime procedures and print-only modalities —
> looking for criticism from people who run this for real

**Body:**

> Disclosure: I wrote this. It is AGPL and free, there is no product and
> nothing to buy, and I am posting because the people who would find the holes
> in it are in this sub.
>
> Up front, so nobody wastes their time: **this is not a medical device**, it
> is not certified by anyone, it has not been validated for clinical use, and
> it is not for primary diagnosis. It has **no user accounts, no roles and no
> per-user audit trail** — the log records what happened, with timestamps and
> peer addresses, but it cannot record *who*, because the software has no
> concept of a user. That alone disqualifies it from a lot of environments, and
> I would rather say so in the first paragraph than in a reply.
>
> The problem I built it for is downtime and old equipment, not storage:
>
> - A modality whose only output is film, that the archive will not accept. It
>   presents as a print SCP, captures the film session, and emits a PDF or
>   Secondary Capture object with the identity scraped from the print job, which
>   can then be routed like a normal study.
> - Departments hand-keying accessions because there is no RIS feed or it is
>   down. It takes HL7 orders over MLLP where they exist, allows manual order
>   entry where they don't, serves MWL to the modality, and reconciles the
>   returned study to the order.
> - Primary archive unreachable. It monitors, takes over the worklist so
>   scanning continues, holds received studies for the duration, and forwards
>   them once the primary answers.
>
> It also does Storage SCP, conditional routing, de-identification on forward,
> Q/R and DICOMweb, but those are table stakes and Orthanc and dcm4chee do them
> better. The intended deployment is in front of one of those, not instead.
>
> What I am actually asking:
>
> 1. For those of you with a written downtime procedure for imaging — what does
>    it currently say, and does a box like this help or just add a thing to
>    validate?
> 2. The reconciliation logic (HL7 order to returned study) is the part I am
>    least confident in. If you do integration work, that is where I would most
>    value a look.
> 3. It has never been run against real clinical equipment — only against
>    pynetdicom's own tools and synthetic studies. Conformance is proven;
>    interoperability with your 2009 CR reader is not. Reports either way are
>    useful.
>
> Other known gaps: no encryption at rest, the HL7 listener is unauthenticated,
> and the dashboard is plain HTTP unless you front it with a proxy. All
> documented in the README's regulatory section rather than buried.
>
> https://github.com/MiguelCarino/Carino-PACS

---

## pydicom / pynetdicom discussion boards

Framed as "built with your library", because that is what it is. These are the
maintainers' own boards; an advert would be rude and would land badly.

- **pydicom:** GitHub Discussions has a **`Show and tell`** category — exactly
  the right home. https://github.com/pydicom/pydicom/discussions
- **pynetdicom:** Discussions are enabled but there is no *Show and tell*
  category; the categories are `Associating`, `General`, `Q&A`-style
  `Query/Retrieve`, and `Polls`. Use **`General`**.
  https://github.com/pydicom/pynetdicom/discussions

Post it once, in one of the two, and link across rather than duplicating.
pynetdicom is the better fit given how much of the project is association
handling.

**Title:**

> Built with pynetdicom: a DICOM gateway for print-only modalities and PACS
> downtime

**Body:**

> This is a thank-you and a report from the field rather than a pitch.
>
> I've been building Carino DICOM, a DICOM gateway and continuity appliance, on
> top of pydicom and pynetdicom. It is AGPL and non-commercial. The whole DICOM
> layer is pynetdicom: Storage SCP, a virtual print SCP, Modality Worklist,
> C-FIND/C-MOVE/C-GET, plus the SCU side for forwarding.
>
> Three things that might be useful to you or to others reading:
>
> - **The N-CREATE/N-SET print classes are usable for something other than
>   printing.** I use them to capture film from modalities whose only output is
>   a laser imager, and re-emit it as Encapsulated PDF or Secondary Capture.
>   The one fragile assumption is that the print SCU supplies Film Session and
>   Film Box UIDs — pynetdicom's own SCU and, so far, every modality I've read
>   about do, but the spec lets an SCU be vaguer than that.
> - **SCP/SCU role negotiation for C-GET on the same association** worked
>   first try once I found the right example, but it is the piece I see people
>   struggle with most in this board's history. Happy to contribute a worked
>   example if that would be welcome.
> - **Everywhere the wire is the thing being tested, the test stands up a real
>   SCP on loopback and drives a real association against it** rather than
>   mocking one. The print suite drives pynetdicom's own Print SCU against a
>   live Print SCP; the Q/R suite associates against a live C-FIND/C-MOVE/C-GET
>   SCP; the routing suite ends in cases that forward to a live Storage SCP and
>   then read back the instances that actually landed on its disk — which is the
>   only evidence that settles "was this copy de-identified before it left".
>   Decision logic above the socket is tested against a recording stub, because
>   there the socket would only add seconds. Four hundred-odd tests at the time
>   of writing. `pynetdicom` made the real-SCP half straightforward enough that
>   mocking it never seemed worth it, which I don't think is true of most
>   protocol libraries.
>
> Caveats so nobody takes this as a recommendation to deploy: not a medical
> device, not validated for clinical use, not for primary diagnosis, and never
> yet run against real clinical equipment.
>
> Source: https://github.com/MiguelCarino/Carino-PACS — and thanks for the
> libraries; the print SCP in particular would not have been a weekend's work
> without them.

---

## Where else to submit, and where not to

### Worth it

| Venue | Why | Caveat |
|---|---|---|
| **r/PACS** | The single most on-target audience anywhere: PACS administrators who have personally lived the print-only modality and the downtime procedure. Small but concentrated. | Small sub; check whether self-promotion is allowed at all. |
| **Aunt Minnie forums** (PACS/informatics boards) | Where working imaging-informatics professionals actually talk. High-quality critique. | Long-standing community, allergic to drive-by posting. Participate first. |
| **Orthanc community forum** (Discourse) | The project positions itself as a gateway *in front of* Orthanc. That is a complement, not a competitor, and is genuinely useful to that community. | Must be framed as integration, never as an alternative. |
| **dcm4che Google Group** | Same reasoning as Orthanc. | Same caveat. |
| **pydicom / pynetdicom Discussions** | Drafted above. Upstream, appropriate, low-risk. | — |
| **`selfh.st` newsletter** | Accepts submissions, reaches the self-hosting audience without Reddit's promotion rules. | — |
| **Hacker News (Show HN)** | The failover and print-capture angles are genuinely interesting to a general technical audience. | Show HN rewards a working demo and punishes overstatement. Lead with the limitations. |
| **AlternativeTo** | Cheap listing, steady long-tail discovery. | Low value on its own. |
| **awesome-open-source-healthcare / awesome-digital-health lists** | Directly on-topic, and generally less strict than awesome-selfhosted about project age. | Check each list's own age/maintenance rules. |
| **SIIM community channels** | Imaging informatics professionals; the exact readership. | Professional body — approach as a member, not a vendor. |

### Currently a bad idea

| Venue | Why it fails today |
|---|---|
| **awesome-selfhosted** | **Fails the 4-month-since-first-release rule.** `v1.0.0` is 2026-07-09; eligible from ~2026-11-09. Entry above is ready to file then. |
| **Any "HIPAA-compliant" or compliance-focused directory** | The project has no user accounts, no per-user audit trail and no encryption at rest. It cannot support a compliance claim, and listing it as though it could is the fastest way to lose trust permanently. |
| **Medical device / clinical software registries** | Not a medical device, not certified, not validated. Listing it beside cleared software invites exactly the misuse the README warns against. |
| **r/medicine, r/radiology and clinical subreddits** | Clinician audiences, near-total bans on software promotion, and the wrong readers — the people who would deploy this are IT, not physicians. |
| **lobste.rs** | Invite-only, and self-promotion by a new user is poorly received. |
| **Product Hunt / "launch" aggregators** | Framing is wrong in a way that actively harms the project. There is no product, and a launch-day audience cannot evaluate a DICOM gateway. |

### Not yet, but soon

- **awesome-selfhosted** — November 2026, as above.
- **Anything that turns on real-world validation** — the single highest-value
  thing outreach could produce right now is not users, it is *one report from
  someone who pointed a real modality at it*. Both Reddit drafts and the
  pynetdicom post ask for exactly that on purpose. Until that exists, the
  Maturity table's "no part of this project has been validated against clinical
  equipment by anyone" has to stay in every post.
