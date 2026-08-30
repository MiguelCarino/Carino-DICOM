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
| `openjpegwasm_decode.js` | [@cornerstonejs/codec-openjpeg](https://github.com/cornerstonejs/codecs) | 1.3.0 | MIT | `LICENSE-codec-openjpeg.txt` |
| `openjpegwasm_decode.wasm` | [@cornerstonejs/codec-openjpeg](https://github.com/cornerstonejs/codecs) | 1.3.0 | MIT | `LICENSE-codec-openjpeg.txt` |
| `charlswasm_decode.js` | [@cornerstonejs/codec-charls](https://github.com/cornerstonejs/codecs) | 1.2.3 | MIT | `LICENSE-codec-charls.txt` |
| `charlswasm_decode.wasm` | [@cornerstonejs/codec-charls](https://github.com/cornerstonejs/codecs) | 1.2.3 | MIT | `LICENSE-codec-charls.txt` |

The two `*wasm_decode.*` pairs are the JPEG 2000 and JPEG-LS decoders. They are
WebAssembly, they are loaded lazily — nothing fetches either one until a study of
that transfer syntax is opened — and they are **decode-only** builds on purpose:
the full builds carry encoders this editor never calls, for 112 KB and 72 KB more
of binary. Do not rename the four files; `locateFile` is what resolves a `.wasm`
beside its loader, and upstream's names are what keep a refresh diffable.

A `.wasm` has to be served as `application/wasm` or the streaming compiler will
not take it. `pacs/web.py` registers that MIME type at import rather than trusting
the host to know it: Python reads `/etc/mime.types` on Linux and the registry on
Windows, and `.wasm` is frequently absent from the latter.

Those MIT notices cover the emscripten wrappers only. The C libraries compiled
*into* the `.wasm` are separate works under separate terms, and shipping a
compiled binary inside an installer and a container image is exactly what their
notice clauses are about:

| Compiled inside the `.wasm` | Licence | Text |
| --- | --- | --- |
| [OpenJPEG](https://github.com/uclouvain/openjpeg) (inside `openjpegwasm_decode.wasm`) | BSD 2-Clause | `LICENSE-openjpeg.txt` |
| [CharLS](https://github.com/team-charls/charls) (inside `charlswasm_decode.wasm`) | BSD 3-Clause | `LICENSE-charls.txt` |

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

    npm pack @cornerstonejs/codec-openjpeg@<version>
    tar xzf cornerstonejs-codec-openjpeg-<version>.tgz
    cp package/dist/openjpegwasm_decode.js package/dist/openjpegwasm_decode.wasm .
    cp package/LICENSE LICENSE-codec-openjpeg.txt

    npm pack @cornerstonejs/codec-charls@<version>
    tar xzf cornerstonejs-codec-charls-<version>.tgz
    cp package/dist/charlswasm_decode.js package/dist/charlswasm_decode.wasm .
    cp package/LICENSE LICENSE-codec-charls.txt

The two BSD texts are not in either tarball — the wrappers ship their own MIT
licence and not the licence of the code they compiled. Take them from the
libraries themselves:

    curl -o LICENSE-openjpeg.txt https://raw.githubusercontent.com/uclouvain/openjpeg/master/LICENSE
    curl -o LICENSE-charls.txt   https://raw.githubusercontent.com/team-charls/charls/master/LICENSE.md

Then re-read the new bundle for anything that points off-origin before shipping
it. Minifiers append a `//# sourceMappingURL=` comment, CDN builds sometimes
carry an absolute one, and a map URL is a real request the moment a browser has
devtools open. The maps we ship are named relatively or root-relatively, so they
resolve against the operator's own engine and 404 there rather than leaving the
building; keep it that way.

## If you are syncing from upstream DICOM-editor

The editor is a vendored copy of https://github.com/MiguelCarino/Carino-DICOM-Editor.
Upstream is where the self-hosting was done — the fonts and all four bundles are
already local there, so nothing has to move to make this copy offline-clean.

**Two things exist only here**, and a careless `cp -r` from upstream deletes
both:

1. **The licensing and provenance in this directory** — this README and the nine
   `LICENSE-*.txt` files here, plus the two in `../fonts/`. Carino DICOM
   redistributes these bundles inside a shipped binary and a container image,
   which upstream (a static site users visit) does not; that is why the
   obligation lands here, and why this file is not upstream's with the paths
   changed. Upstream has its own; do not overwrite either with the other.
2. **`../tests/pn-roundtrip.e2e.mjs`** — the Person Name round-trip check.

       node pacs/web/editor/tests/pn-roundtrip.e2e.mjs

   Run it after any dcmjs bump. dcmjs's read and write shapes for `PersonName`
   are not symmetric, and a version that starts returning objects from
   `readBytes` changes what `parseByVR` has to do.

Two deviations that used to live here are gone, both fixed upstream instead —
which was always the better answer and is why this section is shorter than it
was:

* The **`JPEG_LOSSLESS_CDN` rename** is upstream now. The constant is
  `JPEG_LOSSLESS_MODULE` in both trees. It was never a CDN reference, but the
  name was enough for a security review to conclude it was, and that misreading
  costs more here than upstream because here it contradicts a documented
  guarantee.
* The **PN fix in `parseByVR()`** is upstream now, and in a better form than the
  deletion this copy carried. Upstream used to build every Person Name as
  `{Alphabetic, Ideographic, Phonetic}` — the shape of a *naturalised* dcmjs
  dataset — while the raw dict this editor holds carries PN as a plain string in
  both directions in dcmjs 0.29.8, so the writer stringified it to the literal
  `[object Object]` on every PN tag of every saved file. This copy dropped the
  `case 'PN'` entirely; upstream now follows whichever shape the element is
  already in, which handles both and is covered by `tests/suites/edits.js`
  there as well as by the suite above here.

**One thing is new, and it is not optional.** `index.html` now loads
`tests/dicom-forge.js` for the sample studies on the empty state, and
`tests/suites/*.js` for the in-browser self-test at `/editor/#selftest`. Both
are lazy, so pruning `tests/` does not break loading a study — the buttons
report that the files are missing instead of hanging — but it does remove two
features an operator can see. The self-test in particular is worth keeping: it
answers "does the browser on this reading-room workstation decode our studies
correctly", in that browser, with the failures named. `tests/run.sh`,
`tests/README.md` and `tests/fixtures/` are development-only and are
deliberately not vendored.

Everything else should be copied verbatim. The two trees are meant to be
byte-identical: a divergence here is a divergence in what a hospital is running.
