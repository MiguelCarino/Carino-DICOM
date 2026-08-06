# Third-party code bundled with the DICOM tag editor

Everything the editor needs is in this tree. It loads no script, style, font,
map or module from anywhere but its own origin — which is the point: SECURITY.md
promises that the only outbound connections this software makes are the DICOM
associations and HL7 acknowledgements the operator configured, and an editor
that reaches for a CDN would make that promise false. It would also fail
silently on an air-gapped hospital network, which is a normal deployment for
this software rather than an edge case: the page would render and then refuse to
open a study, with nothing on screen naming the internet as the cause.

So the rule for this directory is absolute, and it is worth stating rather than
assuming: **no reference in `pacs/web/editor/` may resolve off-origin.** Not a
`<script src>`, not a `@import`, not a web font, not a worker URL, not a source
map, not a `fetch()` to anything but a path the operator's own engine serves.
The two `fetch()` calls in `index.html` that take a URL are the PACS deep-link
manifest handler; the URL there comes from the operator's own `#load=` link and
points at their own engine.

## What is here, and under what licence

| File | Package | Version | Licence | Text |
| --- | --- | --- | --- | --- |
| `dcmjs.min.js` | [dcmjs](https://github.com/dcmjs-org/dcmjs) | 0.29.8 | MIT | `LICENSE-dcmjs.txt` |
| `lossless-min.js` | [jpeg-lossless-decoder-js](https://github.com/rii-mango/JPEGLosslessDecoderJS) | 2.1.2 | MIT | `LICENSE-jpeg-lossless-decoder-js.txt` |

`dcmjs.min.js` is the jsDelivr build of `dcmjs@0.29.8/build/dcmjs.js`, which is
a bundle: three of its dependencies are compiled into the file we ship, so their
licences travel with it and are reproduced here too.

| Bundled inside `dcmjs.min.js` | Licence | Text |
| --- | --- | --- |
| [pako](https://github.com/nodeca/pako) 2.0.4 | MIT (with zlib-licensed portions) | `LICENSE-pako.txt` |
| [loglevelnext](https://github.com/shellscape/loglevelnext) 3.x | MPL-2.0 | `LICENSE-loglevelnext.txt` |
| [core-js](https://github.com/zloirock/core-js) (via `@babel/runtime-corejs3`) | MIT | `LICENSE-core-js.txt` |

The one that needs a word of explanation is loglevelnext, because MPL-2.0 next
to AGPL-3.0 is the kind of pairing that looks wrong at a glance. It is fine, and
specifically: none of loglevelnext's source files carries the Exhibit B
"Incompatible With Secondary Licenses" notice, so MPL-2.0 §3.3 permits its
distribution as part of a Larger Work under a Secondary License, and the GNU
AGPL v3 is named as a Secondary License in §1.13. The MPL still governs those
files themselves, which is why the full text is here rather than summarised.

The self-hosted web fonts under `../fonts/` are SIL Open Font License 1.1 and
carry their licences beside them — `../fonts/LICENSE-IBMPlex.txt` (IBM Plex Sans
and IBM Plex Mono) and `../fonts/LICENSE-RedHat.txt` (Red Hat Text and Red Hat
Display). The OFL requires the licence to be distributed with the font files, so
those two files are not optional bookkeeping.

## Refreshing a bundle

Fetch the exact version, and take the licence in the same breath — the licence
going stale against the code is the failure mode this table exists to prevent:

    npm pack dcmjs@<version>
    tar xzf dcmjs-<version>.tgz
    cp package/License.txt LICENSE-dcmjs.txt

Then re-read the new bundle for anything that points off-origin before shipping
it. Minifiers append a `//# sourceMappingURL=` comment, CDN builds sometimes
carry an absolute one, and a map URL is a real request the moment a browser has
devtools open. The maps we ship are named relatively or root-relatively, so they
resolve against the operator's own engine and 404 there rather than leaving the
building; keep it that way.

## If you are syncing from upstream DICOM-editor

The editor is a vendored copy of https://github.com/MiguelCarino/DICOM-editor.
Upstream is where the self-hosting was done — the fonts and both bundles are
already local there, so nothing had to move to make this copy offline-clean.

Four things exist only here, and a careless `cp -r` from upstream deletes all
four — the third one silently, and it corrupts studies when it goes:

1. **The licensing and provenance in this directory** — this README, the five
   `LICENSE-*.txt` files here, and the two in `../fonts/`. Carino PACS
   redistributes these bundles inside a shipped binary and a container image,
   which upstream (a static site users visit) does not; that is why the
   obligation lands here.
2. **One rename in `index.html`**: the constant holding the JPEG-lossless module
   path is `JPEG_LOSSLESS_MODULE`, not upstream's `JPEG_LOSSLESS_CDN`. Same
   value, same two lines — but the old name is how a security review concluded
   this editor pulls from a CDN when it does not, and that misreading costs more
   here than upstream because here it contradicts a documented guarantee.
3. **The PN fix in `index.html`'s `parseByVR()`**: upstream builds a Person Name
   as `{Alphabetic, Ideographic, Phonetic}`; here the `case 'PN'` is gone and PN
   falls through to the plain-string default. That object is the shape of a
   *naturalised* dcmjs dataset. The raw dict this editor holds — the one
   `DicomMessage.readFile` returns and `DicomDict.write` consumes — carries PN
   as a string in both directions in dcmjs 0.29.8, so the writer stringified the
   object to the literal `[object Object]`. Because `downloadRange()` rewrites
   every tag in `pendingEdits`, and `pendingEdits` is seeded with the whole
   dataset at load, upstream destroys `PatientName`, `ReferringPhysicianName`
   and every other PN tag on a plain open-and-save with nothing edited. Verified
   in headless Chromium: with the fix, load-and-save-untouched is byte-identical
   to the input, and editing a PN, editing a non-PN and Anonymize All all write
   well-formed names.

   The check is `../tests/pn-roundtrip.e2e.mjs`, which is the fourth thing that
   exists only here:

       node pacs/web/editor/tests/pn-roundtrip.e2e.mjs

   Read dcmjs's `PersonName` value representation before any bundle refresh, and
   run that suite after. Its read and write shapes are not symmetric, and a
   version that starts returning objects from `readBytes` would need the `case`
   back — the suite is how you find that out in a minute instead of from a site
   that reports corrupt names a year later.

Copy the source files, keep these. Or push them upstream, which is better —
number 3 especially, since upstream corrupts every study it saves today.
