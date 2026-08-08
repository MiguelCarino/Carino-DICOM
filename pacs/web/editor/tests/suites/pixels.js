// Decoder-level checks: does decodeDicomPixels() get the numbers out of the file?
//
// This suite deliberately stops short of display. For greyscale it asserts on
// rawFloats — the decoder's buffer of values in output units, stored values with
// Rescale Slope/Intercept applied — because sign handling, bit masking, byte
// order, rescale and frame offsets all surface there as a wrong minimum or
// maximum, before any windowing can hide them. What the user finally sees is
// tests/suites/viewer.js.
//
// Colour is different: nothing further is applied to it, so RGB cases are
// compared pixel for pixel against the oracle right here.
(window.SUITES || (window.SUITES = {})).pixels = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);

  try {
    const cases = await Forge.corpus();
    const byId = Object.fromEntries(cases.map(c => [c.id, c]));

    // dcmjs is what the app itself parses with, so parse failures are real failures.
    function parse(c) {
      const b = c.bytes;
      const msg = DicomMessage.readFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      normBin(msg.dict);
      return { dict: msg.dict, meta: msg.meta || {} };
    }

    // Several assertions decode the same case, often frame by frame. Parsing is
    // the expensive half, and decodeDicomPixels does not consume the dict, so
    // parse each file once.
    const parsed = new Map();
    const parseOnce = (c) => {
      if (!parsed.has(c.id)) parsed.set(c.id, parse(c));
      return parsed.get(c.id);
    };

    async function dec(id, frame = 0) {
      const c = byId[id];
      if (!c) throw new Error('no such case: ' + id);
      const { dict, meta } = parseOnce(c);
      return { c, res: await decodeDicomPixels(dict, frame, { meta }) };
    }

    const range = (a) => {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < a.length; i++) { if (a[i] < mn) mn = a[i]; if (a[i] > mx) mx = a[i]; }
      return [mn, mx];
    };
    // rawFloats is the decoder's output-unit buffer: stored values with Rescale
    // Slope/Intercept already applied, which is the scale Window Center/Width
    // are quoted in. So the range we expect is the rescaled one.
    const trueRange = (id) => {
      const ref = byId[id].ref;
      const m = ref.slope != null ? ref.slope : 1, b = ref.intercept != null ? ref.intercept : 0;
      const [mn, mx] = range(ref.samples);
      return [mn * m + b, mx * m + b];
    };

    // ---- every case must at least survive parsing --------------------------
    for (const c of cases) {
      let msg = '';
      try { parse(c); } catch (e) { msg = e.message || String(e); }
      ok(`${c.id}: dcmjs parses the file`, !msg, msg);
    }

    // ---- geometry and frame counts -----------------------------------------
    for (const c of cases) {
      if (c.broken) continue;
      let res = null, err = '';
      try { ({ res } = await dec(c.id)); } catch (e) { err = e.message || String(e); }
      if (err) { ok(`${c.id}: decodes without throwing`, false, err); continue; }
      ok(`${c.id}: returns something renderable`, !!res && !res.error,
         res ? (res.error || '') : 'returned null');
      if (!res || res.error) continue;
      ok(`${c.id}: ${c.w}x${c.h} geometry survives`, res.cols === c.w && res.rows === c.h,
         `${res.cols}x${res.rows}`);
      const want = c.frames || 1;
      ok(`${c.id}: reports ${want} frame(s)`, res.numFrames === want, String(res.numFrames));
    }

    // ---- greyscale: the stored values that came back out --------------------
    const monoCases = ['mono2-u8', 'mono2-u16-b12', 'mono2-u16-b16', 'mono2-s16-b12',
                       'mono2-s16-b16', 'mono1-u16', 'ct-rescale-hu', 'pt-rescale-slope',
                       'mono2-no-window', 'implicit-vr', 'big-endian', 'raw-looks-like-jpeg',
                       'rle-mono16', 'jpeg-lossless-mono16', 'j2k-mono16-b12', 'jls-mono16-b12'];
    for (const id of monoCases) {
      let res = null, err = '';
      try { ({ res } = await dec(id)); } catch (e) { err = e.message || String(e); }
      if (err || !res || res.error || !res.rawFloats) {
        ok(`${id}: recovers the pixel values`, false,
           err || (res ? (res.error || 'no rawFloats — decoded as colour?') : 'null'));
        continue;
      }
      const [wmn, wmx] = trueRange(id);
      const [gmn, gmx] = range(res.rawFloats);
      ok(`${id}: output-unit range is ${wmn}..${wmx}`, gmn === wmn && gmx === wmx, `got ${gmn}..${gmx}`);
    }

    // A ramp is monotonic across a row; a byte-order or masking slip breaks that
    // long before it breaks the min and max.
    for (const id of ['mono2-u16-b12', 'mono2-s16-b12', 'big-endian', 'implicit-vr',
                      'j2k-mono16-b12', 'jls-mono16-b12']) {
      let res = null;
      try { ({ res } = await dec(id)); } catch (_) {}
      if (!res || !res.rawFloats) { ok(`${id}: middle row still ramps upward`, false, 'no data'); continue; }
      const y = 16, w = Forge.W;
      let mono = true, at = -1;
      for (let x = 6; x < w - 6; x++) {
        if (res.rawFloats[y * w + x] < res.rawFloats[y * w + x - 1]) { mono = false; at = x; break; }
      }
      ok(`${id}: middle row still ramps upward`, mono, at >= 0 ? `drops at x=${at}` : '');
    }

    // ---- colour ------------------------------------------------------------
    for (const id of ['rgb-planar0', 'rgb-planar1', 'ybr-full', 'palette-color',
                      'ybr-422-jpeg', 'mono1-jpeg', 'rle-rgb', 'jpeg-split-fragments',
                      'jpeg-lossless-rgb', 'j2k-rgb-rct', 'jls-rgb', 'jls-rgb-planar']) {
      const c = byId[id];
      let res = null, err = '';
      try { ({ res } = await dec(id)); } catch (e) { err = e.message || String(e); }
      if (err || !res || res.error) {
        ok(`${id}: decodes to colour pixels`, false, err || (res ? res.error : 'returned null'));
        continue;
      }
      const want = Forge.expected(c.ref, c.w, c.h);
      const diff = Forge.compare(res.pixels, want, c.tol);
      ok(`${id}: colours match the source image`, !diff, diff || '');
    }

    // ---- frames are actually different from one another ---------------------
    {
      const c = byId['multiframe-mono'];
      const seen = [];
      for (let f = 0; f < c.frames; f++) {
        let res = null;
        try { ({ res } = await dec(c.id, f)); } catch (_) {}
        seen.push(res && res.rawFloats ? range(res.rawFloats).join('..') : 'none');
      }
      ok('multiframe-mono: each frame decodes to its own data',
         new Set(seen).size === c.frames, seen.join(' | '));
      for (let f = 0; f < c.frames; f++) {
        let res = null;
        try { ({ res } = await dec(c.id, f)); } catch (_) {}
        const want = range(c.frameRef(f).samples).join('..');
        ok(`multiframe-mono: frame ${f} holds frame ${f}`,
           !!res && res.rawFloats && range(res.rawFloats).join('..') === want,
           res && res.rawFloats ? range(res.rawFloats).join('..') : 'none');
      }
    }
    {
      const c = byId['multiframe-rgb'];
      for (let f = 0; f < c.frames; f++) {
        let res = null, err = '';
        try { ({ res } = await dec(c.id, f)); } catch (e) { err = e.message || String(e); }
        if (!res || res.error) { ok(`multiframe-rgb: frame ${f} decodes`, false, err || (res && res.error)); continue; }
        const diff = Forge.compare(res.pixels, Forge.expected(c.frameRef(f), c.w, c.h), c.tol);
        ok(`multiframe-rgb: frame ${f} is the ${['red', 'green', 'blue'][f]} one`, !diff, diff || '');
      }
    }
    {
      const c = byId['jpeg-multiframe'];
      for (let f = 0; f < c.frames; f++) {
        let res = null, err = '';
        try { ({ res } = await dec(c.id, f)); } catch (e) { err = e.message || String(e); }
        if (!res || res.error) { ok(`jpeg-multiframe: frame ${f} decodes`, false, err || (res && res.error)); continue; }
        const diff = Forge.compare(res.pixels, Forge.expected(c.frameRef(f), c.w, c.h), c.tol);
        ok(`jpeg-multiframe: frame ${f} is its own fragment`, !diff, diff || '');
      }
    }

    // ---- the FF D8 trap ----------------------------------------------------
    {
      let res = null, err = '';
      try { ({ res } = await dec('raw-looks-like-jpeg')); } catch (e) { err = e.message || String(e); }
      ok('raw-looks-like-jpeg: not mistaken for a JPEG',
         !!res && !res.error && !!res.rawFloats && res.rawFloats[0] === 0xD8FF,
         err || (res && res.error) || (res && res.rawFloats ? `first px ${res.rawFloats[0]}` : 'no rawFloats'));
    }

    // ---- baseline JPEG -----------------------------------------------------
    {
      const c = byId['jpeg-baseline'];
      let res = null, err = '';
      try { ({ res } = await dec(c.id)); } catch (e) { err = e.message || String(e); }
      if (!res || res.error) ok('jpeg-baseline: browser decodes the fragment', false, err || (res && res.error));
      else {
        const diff = Forge.compare(res.pixels, Forge.expected(c.ref, c.w, c.h), c.tol);
        ok('jpeg-baseline: browser decodes the fragment', !diff, diff || '');
      }
    }

    {
      const c = byId['rle-multiframe'];
      for (let f = 0; f < c.frames; f++) {
        let res = null, err = '';
        try { ({ res } = await dec(c.id, f)); } catch (e) { err = e.message || String(e); }
        if (!res || res.error) { ok(`rle-multiframe: frame ${f} decodes`, false, err || (res && res.error)); continue; }
        const diff = Forge.compare(res.pixels, Forge.expected(c.frameRef(f), c.w, c.h), c.tol);
        ok(`rle-multiframe: frame ${f} is its own fragment`, !diff, diff || '');
      }
    }

    // ---- malformed input degrades instead of exploding ----------------------
    for (const id of ['truncated-pixels', 'window-width-zero', 'jpeg2000-unsupported',
                      'j2k-truncated', 'htj2k-unsupported', 'mpeg2-unsupported']) {
      const c = byId[id];
      let res, err = '';
      try { ({ res } = await dec(id)); } catch (e) { err = e.message || String(e); }
      ok(`${id}: does not throw`, !err, err);
      if (c.expectError) {
        ok(`${id}: says why it cannot show the image`,
           !!res && !!res.error && c.expectError.test(res.error),
           res ? (res.error || 'no error reported') : 'null');
      }
    }
    // ---- the codecs that decode, and the ones that must not ----------------
    // decode() answers a truncated or garbage codestream with width 0 and an
    // empty buffer instead of raising, so "no error" here would mean the app
    // fell into the raw path holding nothing and drew whatever it found.
    for (const id of ['jpeg2000-unsupported', 'j2k-truncated', 'htj2k-unsupported']) {
      let res = null;
      try { ({ res } = await dec(id)); } catch (_) {}
      ok(`${id}: refuses rather than returning pixels`,
         !!res && !!res.error && res.pixels === undefined,
         res ? (res.error ? `pixels=${res.pixels === undefined ? 'none' : 'present'}` : 'no error') : 'null');
    }
    {
      // Part 15 has to be refused by transfer syntax. Its codestream carries the
      // same FF 4F FF 51 magic as Part 1, so a magic-byte test would hand it to
      // OpenJPEG, which cannot decode it and does not say so.
      let res = null;
      try { ({ res } = await dec('htj2k-unsupported')); } catch (_) {}
      ok('htj2k-unsupported: names High-Throughput rather than blaming the codestream',
         !!res && /High-Throughput|201/i.test(res.error || ''), res ? res.error : 'null');
    }

    // ---- a codestream that disagrees with its own header --------------------
    // The codec reports the width, depth and component count it actually found;
    // the dataset carries a second copy in Rows, Columns, Bits Allocated and
    // Samples per Pixel; and everything downstream indexes the samples using the
    // dataset's numbers. Checking the codec only against itself is a tautology —
    // a valid twelve-bit codestream under an eight-bit header decoded to noise
    // with nothing to say why. Nonconformant files are the whole point of a tool
    // like this, so the disagreement has to be named.
    {
      const frag = Forge.codestream('J2K_MONO16_B12');
      const jlsFrag = Forge.codestream('JLS_MONO16_B12');
      for (const [label, ts, bytes, want] of [
        ['JPEG 2000', '1.2.840.10008.1.2.4.90', frag, /Bits Allocated/i],
        ['JPEG-LS', '1.2.840.10008.1.2.4.80', jlsFrag, /Bits Allocated/i],
      ]) {
        const file = Forge.build({ ts, rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2',
                                   ba: 8, bs: 8, hb: 7, pr: 0, modality: 'MG',
                                   encapsulated: [bytes] });
        const msg = DicomMessage.readFile(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
        normBin(msg.dict);
        let res = null;
        try { res = await decodeDicomPixels(msg.dict, 0, { meta: msg.meta }); } catch (e) { res = { error: 'threw: ' + e.message }; }
        ok(`${label}: a 12-bit codestream under an 8-bit header is refused, not drawn`,
           !!res && !!res.error && want.test(res.error) && res.pixels === undefined,
           res ? (res.error || `no error, pixels=${res.pixels ? 'present' : 'none'}`) : 'null');
      }

      // The same guard must not fire on a file whose header is right.
      let good = null;
      try { ({ res: good } = await dec('j2k-mono16-b12')); } catch (_) {}
      ok('and a codestream that agrees with its header still decodes',
         !!good && !good.error, good ? (good.error || '') : 'null');
    }

    {
      // Width 0 is illegal, but a viewer that answers with a uniformly black
      // frame has silently lost the picture.
      let res = null;
      try { ({ res } = await dec('window-width-zero')); } catch (_) {}
      let flat = true;
      if (res && res.pixels) {
        const first = res.pixels[0];
        for (let i = 0; i < res.pixels.length; i += 4) if (res.pixels[i] !== first) { flat = false; break; }
      }
      ok('window-width-zero: image is not flattened to one shade', !!res && !res.error && !flat,
         res && res.pixels ? `all pixels ${res.pixels[0]}` : 'no pixels');
    }
  } catch (e) {
    ok('suite ran to completion', false, (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  }

  return out;
};

// Two callers: tests/run.sh injects this file alone and scrapes the <pre> below;
// index.html#selftest sets window.SELFTEST and awaits the returned lines instead.
if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.pixels()).join('\n');
  document.body.appendChild(pre);
});
