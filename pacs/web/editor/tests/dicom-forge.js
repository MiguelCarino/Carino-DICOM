// Forges DICOM Part-10 files in the browser, and renders what each one is
// *supposed* to look like.
//
// The point is to have an oracle the app has never seen. Forge.corpus() hands
// back a list of cases; each one carries the encoded bytes on one side and, on
// the other, an independently computed RGBA buffer derived from the source
// samples — never from the bytes. So a case can only pass if the app's decoder
// and the standard agree; a decoder that is self-consistently wrong still fails.
//
// Used by tests/suites/*.js (assertions) and tests/gallery.html (eyeballs).
(function () {
  'use strict';

  // ---------------------------------------------------------------- writing --

  // Explicit VR keeps the length in 2 bytes for these, 4 (after 2 reserved) for
  // everything else. Getting this wrong shifts every following tag.
  const SHORT_VR = new Set(['AE','AS','AT','CS','DA','DS','DT','FL','FD','IS','LO',
                            'LT','PN','SH','SL','SS','ST','TM','UI','UL','US']);
  const TEXT_VR  = new Set(['AE','AS','CS','DA','DS','DT','IS','LO','LT','PN','SH',
                            'ST','TM','UI','UC','UT']);

  // Text values are byte order agnostic; binary ones are not, so `be` has to
  // reach all the way down here — a big-endian file with little-endian Rows is
  // a file nothing can read.
  function bytesOfValue(vr, v, be) {
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    const arr = Array.isArray(v) ? v : [v];
    if (TEXT_VR.has(vr)) {
      let s = arr.join('\\');
      if (s.length % 2) s += (vr === 'UI' ? '\0' : ' ');   // UI pads with NUL, the rest with space
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
      return out;
    }
    let width;
    if (vr === 'US' || vr === 'SS') width = 2;
    else if (vr === 'UL') width = 4;
    else throw new Error('forge: no encoder for VR ' + vr);
    const out = new Uint8Array(arr.length * width);
    arr.forEach((n, k) => out.set(width === 2 ? u16(n, be) : u32(n, be), k * width));
    return out;
  }

  function concat(chunks) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  function u16(v, be) {
    const a = new Uint8Array(2);
    if (be) { a[0] = (v >> 8) & 0xFF; a[1] = v & 0xFF; }
    else    { a[0] = v & 0xFF; a[1] = (v >> 8) & 0xFF; }
    return a;
  }
  function u32(v, be) {
    const a = new Uint8Array(4);
    if (be) { a[0] = (v >>> 24) & 0xFF; a[1] = (v >>> 16) & 0xFF; a[2] = (v >>> 8) & 0xFF; a[3] = v & 0xFF; }
    else    { a[0] = v & 0xFF; a[1] = (v >>> 8) & 0xFF; a[2] = (v >>> 16) & 0xFF; a[3] = (v >>> 24) & 0xFF; }
    return a;
  }

  // tag is 8 hex chars, "7fe00010". data is already even-length.
  function element(tag, vr, data, { implicit = false, be = false } = {}) {
    const g = parseInt(tag.slice(0, 4), 16), e = parseInt(tag.slice(4), 16);
    const head = [u16(g, be), u16(e, be)];
    if (implicit) return concat([...head, u32(data.length, be), data]);
    const vrb = new Uint8Array([vr.charCodeAt(0), vr.charCodeAt(1)]);
    if (SHORT_VR.has(vr)) return concat([...head, vrb, u16(data.length, be), data]);
    return concat([...head, vrb, new Uint8Array(2), u32(data.length, be), data]);
  }

  // A sequence: defined length, one (FFFE,E000) item per dataset, each item also
  // of defined length. Undefined lengths with (FFFE,E00D)/(FFFE,E0DD) delimiters
  // are equally legal, but defined ones are what a writer emits and they keep the
  // encoder honest — every length here is the real byte count of what follows.
  // `items` is an array of ds objects in build()'s own { tag: {vr, v} } shape, so
  // a nested sequence is just another { vr:'SQ', items:[...] } entry.
  function sequence(tag, items, { be = false, implicit = false } = {}) {
    const body = items.map(ds => {
      const inner = concat(Object.keys(ds).sort().map(t => {
        const e = ds[t];
        return e.vr === 'SQ' ? sequence(t, e.items || [], { be, implicit })
                             : element(t, e.vr, bytesOfValue(e.vr, e.v, be), { implicit, be });
      }));
      return concat([u16(0xFFFE, be), u16(0xE000, be), u32(inner.length, be), inner]);
    });
    return element(tag, 'SQ', concat(body), { implicit, be });
  }

  // Undefined-length OB holding one item per frame, preceded by an empty basic
  // offset table — how every compressed transfer syntax carries its pixels.
  function encapsulate(frames, be) {
    const parts = [
      new Uint8Array([0xFE, 0xFF, 0x00, 0xE0]), u32(0, be),          // (FFFE,E000) empty BOT
    ];
    for (const f of frames) {
      let b = new Uint8Array(f instanceof ArrayBuffer ? f : f.buffer || f);
      if (b.length % 2) b = concat([b, new Uint8Array(1)]);
      parts.push(new Uint8Array([0xFE, 0xFF, 0x00, 0xE0]), u32(b.length, be), b);
    }
    parts.push(new Uint8Array([0xFE, 0xFF, 0xDD, 0xE0]), u32(0, be)); // (FFFE,E0DD)
    return concat(parts);
  }

  // PackBits (PS3.5 Annex G). Control byte n: 0..127 means the next n+1 bytes are
  // literal, -1..-127 means repeat the next byte 1-n times, -128 is a no-op.
  function packBits(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      let run = 1;
      while (i + run < src.length && src[i + run] === src[i] && run < 128) run++;
      if (run >= 2) {
        out.push(257 - run, src[i]);
        i += run;
      } else {
        const start = i;
        while (i < src.length && i - start < 128) {
          if (i > start && i + 1 < src.length && src[i + 1] === src[i]) break;
          i++;
        }
        out.push(i - start - 1);
        for (let k = start; k < i; k++) out.push(src[k]);
      }
    }
    if (out.length % 2) out.push(0);          // segments are padded to even length
    return new Uint8Array(out);
  }

  // One RLE frame: a 64-byte header of segment count and offsets, then the
  // PackBits segments themselves.
  function rleFrame(segments) {
    const packed = segments.map(packBits);
    const header = new Uint32Array(16);
    header[0] = packed.length;
    let off = 64;
    packed.forEach((p, i) => { header[i + 1] = off; off += p.length; });
    const out = new Uint8Array(off);
    out.set(new Uint8Array(header.buffer), 0);
    let o = 64;
    for (const p of packed) { out.set(p, o); o += p.length; }
    return out.buffer;
  }

  // A minimal JPEG Lossless (SOF3) encoder: predictor 1, a single interleaved
  // scan, one flat Huffman table of seventeen five-bit codes. Not competitive
  // compression — the point is a stream that genuinely is 1.2.840.10008.1.2.4.70
  // so the branch that handles it can be tested at all.
  function jpegLossless(samples, w, h, comps, precision) {
    const bytes = [];
    let acc = 0, nbits = 0;
    const putByte = (b) => { bytes.push(b); if (b === 0xFF) bytes.push(0x00); };  // byte stuffing
    const putBits = (code, len) => {
      for (let i = len - 1; i >= 0; i--) {
        acc = ((acc << 1) | ((code >> i) & 1)) & 0xFF;
        if (++nbits === 8) { putByte(acc); acc = 0; nbits = 0; }
      }
    };
    const flush = () => { while (nbits) putBits(1, 1); };

    // Category: how many bits the difference needs. Zero needs none.
    const ssss = (d) => { let a = Math.abs(d), n = 0; while (a) { n++; a >>= 1; } return n; };

    const prev = new Int32Array(w * comps);   // the row above, per component
    const cur  = new Int32Array(w * comps);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < comps; c++) {
          const v = samples[(y * w + x) * comps + c];
          // Predictor 1 is the sample to the left; the first sample of a line
          // takes the one above, and the very first takes half of full scale.
          const pred = x > 0 ? cur[(x - 1) * comps + c]
                     : y > 0 ? prev[c]
                     : 1 << (precision - 1);
          const d = v - pred;
          const n = ssss(d);
          putBits(n, 5);                                   // symbol n, code n
          if (n) putBits(d > 0 ? d : d + (1 << n) - 1, n);
          cur[x * comps + c] = v;
        }
      }
      prev.set(cur);
    }
    flush();

    const out = [];
    const u16be = (v) => out.push((v >> 8) & 0xFF, v & 0xFF);
    out.push(0xFF, 0xD8);                                  // SOI

    out.push(0xFF, 0xC3);                                  // SOF3 — lossless, Huffman
    u16be(8 + 3 * comps);
    out.push(precision);
    u16be(h); u16be(w);
    out.push(comps);
    for (let c = 1; c <= comps; c++) out.push(c, 0x11, 0);  // id, 1x1 sampling, no quant table

    out.push(0xFF, 0xC4);                                  // DHT — seventeen codes, all length 5
    u16be(2 + 1 + 16 + 17);
    out.push(0x00);                                        // DC table 0
    for (let i = 1; i <= 16; i++) out.push(i === 5 ? 17 : 0);
    for (let v = 0; v <= 16; v++) out.push(v);

    out.push(0xFF, 0xDA);                                  // SOS
    u16be(6 + 2 * comps);
    out.push(comps);
    for (let c = 1; c <= comps; c++) out.push(c, 0x00);
    out.push(1, 0, 0);                                     // predictor 1, Se 0, no point transform

    // Spreading the entropy-coded bytes into push() would exceed the argument
    // limit on any real-sized image, so assemble the pieces instead.
    const file = new Uint8Array(out.length + bytes.length + 2);
    file.set(out, 0);
    file.set(bytes, out.length);
    file.set([0xFF, 0xD9], out.length + bytes.length);      // EOI
    return file.buffer;
  }

  let uidSeq = 0;
  const uid = (root) => `1.2.826.0.1.3680043.10.99999.${root}.${++uidSeq}`;

  const IMPLICIT_LE = '1.2.840.10008.1.2';
  const EXPLICIT_LE = '1.2.840.10008.1.2.1';
  const EXPLICIT_BE = '1.2.840.10008.1.2.2';

  /**
   * Build a complete DICOM file.
   *
   * cfg: { ts, rows, cols, pi, spp, ba, bs, hb, pr, planar, frames,
   *        wc, ww, slope, intercept, modality, pixels | encapsulated, extra }
   * `pixels` is a typed array holding every frame back to back.
   * `encapsulated` is an array of one compressed buffer per frame.
   * `extra` is { tag: {vr, v} } merged over the defaults.
   */
  function build(cfg) {
    const ts = cfg.ts || EXPLICIT_LE;
    const implicit = ts === IMPLICIT_LE;
    const be = ts === EXPLICIT_BE;
    const frames = cfg.frames || 1;
    const sopClass = cfg.sopClass || '1.2.840.10008.5.1.4.1.1.7';  // Secondary Capture
    const sopInst = cfg.sopInstance || uid('3');

    const ds = {
      '00080008': { vr: 'CS', v: ['DERIVED', 'SECONDARY'] },
      '00080016': { vr: 'UI', v: [sopClass] },
      '00080018': { vr: 'UI', v: [sopInst] },
      '00080020': { vr: 'DA', v: ['20260101'] },
      '00080030': { vr: 'TM', v: ['120000'] },
      '00080060': { vr: 'CS', v: [cfg.modality || 'OT'] },
      '00081030': { vr: 'LO', v: [cfg.title || 'Forge test'] },
      '00100010': { vr: 'PN', v: ['Forge^Test'] },
      '00100020': { vr: 'LO', v: ['FORGE-001'] },
      '0020000d': { vr: 'UI', v: [cfg.studyUID || uid('1')] },
      '0020000e': { vr: 'UI', v: [cfg.seriesUID || uid('2')] },
      '00200013': { vr: 'IS', v: [String(cfg.instance || 1)] },
      '00280002': { vr: 'US', v: [cfg.spp || 1] },
      '00280004': { vr: 'CS', v: [cfg.pi] },
      '00280010': { vr: 'US', v: [cfg.rows] },
      '00280011': { vr: 'US', v: [cfg.cols] },
      '00280100': { vr: 'US', v: [cfg.ba] },
      '00280101': { vr: 'US', v: [cfg.bs != null ? cfg.bs : cfg.ba] },
      '00280102': { vr: 'US', v: [cfg.hb != null ? cfg.hb : (cfg.bs != null ? cfg.bs : cfg.ba) - 1] },
      '00280103': { vr: 'US', v: [cfg.pr || 0] },
    };
    if ((cfg.spp || 1) > 1) ds['00280006'] = { vr: 'US', v: [cfg.planar || 0] };
    if (frames > 1)         ds['00280008'] = { vr: 'IS', v: [String(frames)] };
    if (cfg.wc != null)     ds['00281050'] = { vr: 'DS', v: [String(cfg.wc)] };
    if (cfg.ww != null)     ds['00281051'] = { vr: 'DS', v: [String(cfg.ww)] };
    if (cfg.intercept != null) ds['00281052'] = { vr: 'DS', v: [String(cfg.intercept)] };
    if (cfg.slope != null)     ds['00281053'] = { vr: 'DS', v: [String(cfg.slope)] };
    Object.assign(ds, cfg.extra || {});

    const body = [];
    for (const tag of Object.keys(ds).sort()) {
      const e = ds[tag];
      body.push(e.vr === 'SQ' ? sequence(tag, e.items || [], { implicit, be })
                              : element(tag, e.vr, bytesOfValue(e.vr, e.v, be), { implicit, be }));
    }

    // Pixel data last: OW for 16-bit raw, OB for 8-bit and for anything
    // encapsulated. Implicit VR carries no VR at all, so the app has to infer.
    if (cfg.encapsulated) {
      const g = parseInt('7fe0', 16), e = parseInt('0010', 16);
      const items = encapsulate(cfg.encapsulated, be);
      const head = implicit
        ? concat([u16(g, be), u16(e, be), u32(0xFFFFFFFF, be)])
        : concat([u16(g, be), u16(e, be), new Uint8Array([0x4F, 0x42]), new Uint8Array(2), u32(0xFFFFFFFF, be)]);
      body.push(concat([head, items]));
    } else {
      let px = cfg.pixels;
      let raw = new Uint8Array(px.buffer ? px.buffer.slice(px.byteOffset, px.byteOffset + px.byteLength) : px);
      if (be && cfg.ba === 16) {                       // big endian stores the high byte first
        const sw = new Uint8Array(raw.length);
        for (let i = 0; i + 1 < raw.length; i += 2) { sw[i] = raw[i + 1]; sw[i + 1] = raw[i]; }
        raw = sw;
      }
      if (raw.length % 2) raw = concat([raw, new Uint8Array(1)]);
      body.push(element('7fe00010', cfg.ba === 16 ? 'OW' : 'OB', raw, { implicit, be }));
    }

    // File meta is always Explicit VR Little Endian, whatever the dataset uses.
    const metaEls = {
      '00020001': { vr: 'OB', v: new Uint8Array([0, 1]) },
      '00020002': { vr: 'UI', v: [sopClass] },
      '00020003': { vr: 'UI', v: [sopInst] },
      '00020010': { vr: 'UI', v: [ts] },
      '00020012': { vr: 'UI', v: ['1.2.826.0.1.3680043.10.743'] },
      '00020013': { vr: 'SH', v: ['CARINO-FORGE'] },
    };
    const metaBody = concat(Object.keys(metaEls).sort().map(
      t => element(t, metaEls[t].vr, bytesOfValue(metaEls[t].vr, metaEls[t].v))));

    const preamble = new Uint8Array(132);
    preamble.set([0x44, 0x49, 0x43, 0x4D], 128);       // "DICM"

    return concat([
      preamble,
      element('00020000', 'UL', bytesOfValue('UL', [metaBody.length])),
      metaBody,
      concat(body),
    ]);
  }

  // ------------------------------------------------------------ the samples --


  // ------------------------------------------------ checked-in codestreams --

  // JPEG 2000 and JPEG-LS are the two syntaxes this file cannot forge itself:
  // the app vendors decode-only WASM, so there is no encoder in the browser to
  // write one with. These five streams were produced out of band, from the very
  // rasters pattern() and colorPattern() build below, by
  // tests/fixtures/make-codec-fixtures.mjs — regenerate them with that script
  // rather than by hand, and read the oracle-strength note in tests/README.md
  // before reading a pass here as proof the codec is correct.
  //
  // That script carries its own copies of pattern() and colorPattern(). The two
  // have to stay in step: the reference image here is computed from this file's
  // copy and never from these bytes, so a drift shows up as every JPEG 2000 and
  // JPEG-LS assertion failing at once, with nothing pointing at the cause.
  const J2K_MONO16_B12 =
    '/0//UQApAAAAAAAgAAAAIAAAAAAAAAAAAAAAIAAAACAAAAAAAAAAAAABCwEB/1IADAACAAEAAwQEAAH/XAANQGBoaHBoaHBo' +
    'aHD/ZAAlAAFDcmVhdGVkIGJ5IE9wZW5KUEVHIHZlcnNpb24gMi41LjD/kAAKAAAAAAEFAAH/k9/gbBLQk+seBDs4vJljM4eR' +
    'gLLB+MlR1t+gL3x4B8P2E4/kRn/gAeAUrUxM+Jytm5qu9RKUi1ralzMvFNcRT7JTOdCIFMSTb/gY37MkzXNuVu1gJzD739Wm' +
    'zYfP8EM/wLw/kRAXXTffquEXzJvipMaIw1tssVIlUQa5wFTAuF+sBlYIKH8Myr3XZ3mvDfMZF0vURpjn0p5O/m9HfxawLrHM' +
    'wnU9Qt7dw0MvYx1/x/JNP8CEH7BYHDx8tCuXvTFdCT9QEUuXAEs8GLKjUDlCL32AXL1wrUBilrxwiD+r6xzDN/c1k1VFJ4pW' +
    'OQE/HoFJ2eIlkM9TbGT/2Q==';
  const J2K_RGB_RCT =
    '/0//UQAvAAAAAAAgAAAAIAAAAAAAAAAAAAAAIAAAACAAAAAAAAAAAAADBwEBBwEBBwEB/1IADAACAAEBAwQEAAH/XAANQEBI' +
    'SFBISFBISFD/ZAAlAAFDcmVhdGVkIGJ5IE9wZW5KUEVHIHZlcnNpb24gMi41LjD/kAAKAAAAAAGsAAH/k8+0RAt1XuBselNc' +
    'HFK0X640h4Af/xiYFN8ncQBDDB0FWT1dO0r92OAax9+AkAZBlIy0Bzbl+LaIOp62XHb/f8PqCofUGwPnEhTZd8xUzlyYOA4U' +
    '1OD3J+AJyAtA5lp/FVbhgDBSc6YPz8AmfgHw+0HAFNl4lR1gjngfFNjnAdzLN5zp9lF9tRJaFVbisfPEt8PqBofUDCIaCGLa' +
    'IgDP1Vy9L8PqDofUHwPnEBe9xJNLMG41wUwWAYDsDxfE93ylGTLCWr0O0xTfFrDGAj/yiD/PwC5+AtD7QgAXvcSTS0V1xai8' +
    'Lw8XxPs4vZ5ZglnPuzj+z+0cBFnNCd8WsMUJxxBqH8HziIPnGDahma5jmSP9PmKirYhuV0rgTGNLw+oTh9QrA+cUIhm8yayO' +
    'I52bCxmI/3X2Dl6XnwN7Xy+EA8sB8Hv3QsAMmJfvaUQfpyQsTNoPsAjmwRXPwCJ+AvD7QQAiGbzJrI6XfyQoBKPBOX+H/ZVW' +
    'Zp24D5kfZ2kgsfShJCxNB8D5BcD5BIBfp8eImBCcdrKpg52WqQEEKAYagf/Z';
  const JLS_MONO16_B12 =
    '/9j/9wALDAAgACABAREA/9oACAEBAAAAAECBBBAAAAAAFSghyDIF/v19vl7vV5vN3u11ulzuVxuFvt9ttlrtVpwPIECCCEIQ' +
    'iIiIiJJJJJIHIJJJKqqqqqqDYKqqqr/+DMP/f/9AgkQXhdBHCR//f/wgf/9//2ED/3//fhB//3//RB//f/9xD/9//3iH/3//' +
    'fEP/f/9+If9//38R/3//fxH/f/9/Ef9//38j/3//fkf/f/98j/9//3kf/3//cj//f/9k/3//f5P/f/9+T/9//3k//3//ZP9/' +
    '/3+T/3//QAAAAAUIQjkKQYR5GMYxjGMYxjGMYxjGMzMzAgcmZmZmZmZmZmZmZmZmCDJmZmZtttttttttggy222222222222w' +
    'hP/Z';
  const JLS_RGB =
    '/9j/9wARCAAgACADAREAAhEAAxEA/9oADAMBAAIAAwAAAgBLCTB5n2AAGwDsPYewtpff38vv6+vv6+vr7+vr/3/X/3//L/9/' +
    'gCkysqrV11kyZ5573ve973ve973/f/54Jd3bu93/f/9//3//f/3EO7u7vd//f/9//3//f92O7u7v/3//f/9//3//fU7u7u//' +
    'f/9//3//f/99Du7u7/9//3//f/9//30O7u7v/3//f/9//3//fwec5znOd/9//3//f/9//0v/f/9//3//f/9//3/z/3//f/9/' +
    '/3//f/9/9f9//3//f/9//3//f/z/f/9//3//f/9//3/+/3//f/9//3//f/9//v9//3//f/9//3//f/7/f/9//3//f/9//3/6' +
    'f/9//3//f/9//3//f3//f/9//3//f/9//39//3//f/9//3//f/9+f/9//3//f/9//3//f3//f/9//3//f/9//35//3//f/9/' +
    '/3//f/9+f/9//3//f/9//3//fn//f/9//3//f/9//35//3//f/9//3//f/9/f/9//3//f/9//3//fn//f/9//3//f/9//35/' +
    '/3//f/9//3//f/9+f/9//3//f/9//3//f3//f/9//3//f/9//37/f/9//3//f/9//3/9/3//f/9//3//f/9/4P/Z';
  const JLS_RGB_PLANAR =
    '/9j/9wARCAAgACADAREAAhEAAxEA/9oACAEBAAAAAIcd47Vr/dvbu1tvtt9t9slf/3//F/9//31//3//X/9//3//f/9//3//' +
    'f/9//3//f/9//3//f/9//3//f/9//3//f/9//3//f/9//3//f/9//3//f/9//3//f/9//3//f/9//3//f/9//3//f/9//3//' +
    'f/9//3//f/9//3//f/9//3//f/9//3//f/9//3//f/9//3/8/9oACAECAAAAAP98B5X/f/94T/9//3kf/3//dn//f/9V/3//' +
    'f0f/f/99H/9//3z/f/9/5/9//38//3//df9//3/P/3//fv9//3/v/3//fv9//3+n/3//f3//f/93/3//fn//f/93/3//fn//' +
    'f/9n/3//fn//f/9n/3//f3//f/9n/3//fn//f/9n/3//f3//f/9v/3//ff9//3//2gAIAQMAAAAASV7/fLnwvBaOjo6OC/y7' +
    '/3//AP/Z';

  // Chromium's atob gives a binary string; the fixtures are stored base64 only
  // because a JS source file cannot carry raw bytes.
  function b64ToBytes(s) {
    const bin = atob(s.replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const W = 32, H = 32;

  // One pattern used everywhere, in 0..1: a left-to-right ramp with a bright
  // block top-left and a dark block bottom-right. The ramp catches windowing
  // errors, the blocks catch flips, transposes and inversions.
  function pattern(w, h) {
    const f = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = x / (w - 1);
        if (x < 5 && y < 5) v = 1;
        if (x >= w - 5 && y >= h - 5) v = 0;
        f[y * w + x] = v;
      }
    }
    return f;
  }

  // A colour pattern in 0..255 — red ramps across, green down, blue is a
  // corner flag. Any channel swap or planar mix-up is obvious at a glance.
  function colorPattern(w, h) {
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        rgb[i] = Math.round(255 * x / (w - 1));
        rgb[i + 1] = Math.round(255 * y / (h - 1));
        rgb[i + 2] = (x < 8 && y < 8) ? 255 : 0;
      }
    }
    return rgb;
  }

  // ----------------------------------------------------------- the reference --

  // DICOM's own windowing formula (PS3.3 C.11.2.1.2), on values already in
  // output units. Identical maths to the app's, deliberately — the disagreements
  // we are hunting are about *what* gets windowed, not how.
  function windowFloats(vals, wc, ww, mn, mx) {
    let lo, hi;
    if (wc != null && ww != null) { lo = wc - 0.5 - (ww - 1) / 2; hi = wc - 0.5 + (ww - 1) / 2; }
    else { lo = mn; hi = mx; }
    const range = (hi - lo) || 1;
    const out = new Uint8ClampedArray(vals.length);
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      out[i] = v <= lo ? 0 : v >= hi ? 255 : Math.round(((v - lo) / range) * 255);
    }
    return out;
  }

  /**
   * What the case should look like, from the samples the case was built from.
   *
   * ref: { kind:'mono', samples (stored values), pi, wc, ww, slope, intercept }
   *   or { kind:'rgb', rgb }  — already display-ready RGB triplets
   * Returns Uint8ClampedArray RGBA.
   */
  function expected(ref, w, h) {
    const n = w * h;
    const out = new Uint8ClampedArray(n * 4);
    if (ref.kind === 'rgb') {
      for (let i = 0; i < n; i++) {
        out[i * 4] = ref.rgb[i * 3]; out[i * 4 + 1] = ref.rgb[i * 3 + 1];
        out[i * 4 + 2] = ref.rgb[i * 3 + 2]; out[i * 4 + 3] = 255;
      }
      return out;
    }
    // Stored value -> output units, before anything else touches it.
    const m = ref.slope != null ? ref.slope : 1, b = ref.intercept != null ? ref.intercept : 0;
    const vals = new Float32Array(n);
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = ref.samples[i] * m + b;
      vals[i] = v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const g = windowFloats(vals, ref.wc, ref.ww, mn, mx);
    // MONOCHROME1 means the smallest value is white (PS3.3 C.7.6.3.1.2).
    const inv = /^MONOCHROME1$/i.test(ref.pi || '');
    for (let i = 0; i < n; i++) {
      const v = inv ? 255 - g[i] : g[i];
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
    }
    return out;
  }

  // --------------------------------------------------------------- the cases --

  // JPEG has to come from the browser, so the corpus is built asynchronously.
  async function jpegOf(gray /* Uint8Array w*h, 0..255 */, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = gray[i];
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 1));
    return blob.arrayBuffer();
  }

  async function jpegOfRgb(rgb /* Uint8Array w*h*3 */, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      img.data[i * 4] = rgb[i * 3]; img.data[i * 4 + 1] = rgb[i * 3 + 1];
      img.data[i * 4 + 2] = rgb[i * 3 + 2]; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 1));
    return blob.arrayBuffer();
  }

  async function corpus() {
    const cases = [];
    const add = (c) => { cases.push(c); return c; };

    const p = pattern(W, H);              // 0..1
    const n = W * H;

    // ---- 8-bit unsigned MONOCHROME2, windowed by the tags -------------------
    {
      const s = new Uint8Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 255);
      add({
        id: 'mono2-u8',
        title: '8-bit MONOCHROME2, WC/WW from the tags',
        note: 'The simplest possible case. If this one is wrong nothing else matters.',
        w: W, h: H,
        bytes: build({ rows: H, cols: W, pi: 'MONOCHROME2', ba: 8, bs: 8, hb: 7, pr: 0,
                       wc: 128, ww: 256, pixels: s }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME2', wc: 128, ww: 256 },
      });
    }

    // ---- 16-bit unsigned, 12 bits stored — the ordinary CR/DX layout --------
    {
      const s = new Uint16Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 4095);
      add({
        id: 'mono2-u16-b12',
        title: '16-bit MONOCHROME2, 12 bits stored',
        note: 'High bit 11, so the top four bits are padding and must be masked off.',
        w: W, h: H,
        bytes: build({ rows: H, cols: W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
                       wc: 2048, ww: 4096, pixels: s }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME2', wc: 2048, ww: 4096 },
      });
    }

    // ---- 16-bit unsigned, all 16 bits stored --------------------------------
    {
      const s = new Uint16Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 65535);
      add({
        id: 'mono2-u16-b16',
        title: '16-bit MONOCHROME2, 16 bits stored',
        w: W, h: H,
        bytes: build({ rows: H, cols: W, pi: 'MONOCHROME2', ba: 16, bs: 16, hb: 15, pr: 0,
                       wc: 32768, ww: 65536, pixels: s }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME2', wc: 32768, ww: 65536 },
      });
    }

    // ---- signed, 12 bits stored --------------------------------------------
    {
      const s = new Int16Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 4095) - 2048;   // -2048..2047
      add({
        id: 'mono2-s16-b12',
        title: '16-bit signed MONOCHROME2, 12 bits stored',
        note: 'Negative stored values, sign bit at bit 11.',
        w: W, h: H,
        bytes: build({ rows: H, cols: W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 1,
                       wc: 0, ww: 4096, pixels: s }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME2', wc: 0, ww: 4096 },
      });
    }

    // ---- signed, all 16 bits stored — what most CT actually ships -----------
    {
      const s = new Int16Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 4000) - 2000;   // -2000..2000
      add({
        id: 'mono2-s16-b16',
        title: '16-bit signed MONOCHROME2, 16 bits stored',
        note: 'Bits stored 16, high bit 15, pixel representation 1 — negatives everywhere.',
        w: W, h: H,
        bytes: build({ rows: H, cols: W, pi: 'MONOCHROME2', ba: 16, bs: 16, hb: 15, pr: 1,
                       wc: 0, ww: 4000, modality: 'CT', pixels: s }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME2', wc: 0, ww: 4000 },
      });
    }

    // ---- MONOCHROME1 — low value is white ----------------------------------
    {
      const s = new Uint16Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 4095);
      add({
        id: 'mono1-u16',
        title: 'MONOCHROME1 (inverted greyscale)',
        note: 'Standard for a lot of CR, DX and mammo. Zero must come out white, not black.',
        w: W, h: H,
        bytes: build({ rows: H, cols: W, pi: 'MONOCHROME1', ba: 16, bs: 12, hb: 11, pr: 0,
                       wc: 2048, ww: 4096, modality: 'CR', pixels: s }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME1', wc: 2048, ww: 4096 },
      });
    }

    // ---- rescale to Hounsfield, window given in Hounsfield -----------------
    {
      const s = new Uint16Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 2000);    // 0..2000 stored
      add({
        id: 'ct-rescale-hu',
        title: 'CT with Rescale Slope/Intercept, soft-tissue window',
        note: 'Stored 0..2000, intercept -1024, so output is -1024..976 HU and the ' +
              'WC 40 / WW 400 window only makes sense after the rescale is applied.',
        w: W, h: H,
        bytes: build({ rows: H, cols: W, pi: 'MONOCHROME2', ba: 16, bs: 16, hb: 15, pr: 0,
                       wc: 40, ww: 400, slope: 1, intercept: -1024, modality: 'CT', pixels: s }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME2', wc: 40, ww: 400,
               slope: 1, intercept: -1024 },
      });
    }

    // ---- rescale with a slope other than 1 ---------------------------------
    {
      const s = new Uint16Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 1000);
      add({
        id: 'pt-rescale-slope',
        title: 'Rescale Slope 2.5 (PET-style scaling)',
        note: 'Slope is not 1, so stored values and output units are on different scales.',
        w: W, h: H,
        bytes: build({ rows: H, cols: W, pi: 'MONOCHROME2', ba: 16, bs: 16, hb: 15, pr: 0,
                       wc: 1250, ww: 2500, slope: 2.5, intercept: 0, modality: 'PT', pixels: s }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME2', wc: 1250, ww: 2500,
               slope: 2.5, intercept: 0 },
      });
    }

    // ---- no window tags at all — fall back to the data's own range ---------
    {
      const s = new Uint16Array(n);
      for (let i = 0; i < n; i++) s[i] = 1000 + Math.round(p[i] * 3000);
      add({
        id: 'mono2-no-window',
        title: 'No Window Center/Width',
        note: 'Nothing to window by, so the full min..max range maps onto 0..255.',
        // The auto-window can land a hair either side of the exact min..max
        // sweep depending on where it rounds; one grey level of slack.
        w: W, h: H, tol: 2,
        bytes: build({ rows: H, cols: W, pi: 'MONOCHROME2', ba: 16, bs: 16, hb: 15, pr: 0,
                       pixels: s }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME2' },
      });
    }

    // ---- RGB, interleaved (planar configuration 0) -------------------------
    {
      const rgb = colorPattern(W, H);
      add({
        id: 'rgb-planar0',
        title: 'RGB, colour-by-pixel (Planar Configuration 0)',
        w: W, h: H,
        bytes: build({ rows: H, cols: W, pi: 'RGB', spp: 3, ba: 8, bs: 8, hb: 7, pr: 0,
                       planar: 0, modality: 'XC', pixels: rgb }),
        ref: { kind: 'rgb', rgb },
      });
    }

    // ---- RGB, planar (planar configuration 1) ------------------------------
    {
      const rgb = colorPattern(W, H);
      const planar = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) {
        planar[i] = rgb[i * 3];
        planar[n + i] = rgb[i * 3 + 1];
        planar[2 * n + i] = rgb[i * 3 + 2];
      }
      add({
        id: 'rgb-planar1',
        title: 'RGB, colour-by-plane (Planar Configuration 1)',
        note: 'All the red, then all the green, then all the blue. Read as interleaved ' +
              'it turns into three coloured bands.',
        w: W, h: H,
        bytes: build({ rows: H, cols: W, pi: 'RGB', spp: 3, ba: 8, bs: 8, hb: 7, pr: 0,
                       planar: 1, modality: 'XC', pixels: planar }),
        ref: { kind: 'rgb', rgb },
      });
    }

    // ---- YBR_FULL — needs a colour-space conversion ------------------------
    {
      const rgb = colorPattern(W, H);
      const ybr = new Uint8Array(n * 3);
      // Cr for pure red comes out at 255.5, and Cb for pure blue likewise, so
      // clamp the way a real encoder does — letting it wrap would produce a
      // file no decoder could get right.
      const c8 = (v) => { v = Math.round(v); return v < 0 ? 0 : v > 255 ? 255 : v; };
      for (let i = 0; i < n; i++) {
        const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
        ybr[i * 3]     = c8( 0.299 * r + 0.587 * g + 0.114 * b);
        ybr[i * 3 + 1] = c8(-0.1687 * r - 0.3313 * g + 0.5 * b + 128);
        ybr[i * 3 + 2] = c8( 0.5 * r - 0.4187 * g - 0.0813 * b + 128);
      }
      add({
        id: 'ybr-full',
        title: 'YBR_FULL',
        note: 'Luminance and two chrominance channels. Copied straight into R, G and B ' +
              'it comes out green and washed out.',
        w: W, h: H,
        tol: 3,                       // the YCbCr round trip is not bit-exact
        bytes: build({ rows: H, cols: W, pi: 'YBR_FULL', spp: 3, ba: 8, bs: 8, hb: 7, pr: 0,
                       planar: 0, modality: 'US', pixels: ybr }),
        ref: { kind: 'rgb', rgb },
      });
    }

    // ---- PALETTE COLOR -----------------------------------------------------
    {
      const s = new Uint8Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 255);
      const lut = (fn) => {
        const a = new Uint16Array(256);
        for (let i = 0; i < 256; i++) a[i] = fn(i) << 8;   // 16-bit LUT entries
        return new Uint8Array(a.buffer);
      };
      const rgb = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) {
        rgb[i * 3] = s[i]; rgb[i * 3 + 1] = 255 - s[i]; rgb[i * 3 + 2] = 128;
      }
      add({
        id: 'palette-color',
        title: 'PALETTE COLOR with an RGB lookup table',
        note: 'Single sample per pixel indexing three LUTs. Common in nuclear medicine ' +
              'and in ultrasound colour overlays.',
        w: W, h: H,
        bytes: build({
          rows: H, cols: W, pi: 'PALETTE COLOR', spp: 1, ba: 8, bs: 8, hb: 7, pr: 0,
          modality: 'NM', pixels: s,
          extra: {
            '00281101': { vr: 'US', v: [256, 0, 16] },
            '00281102': { vr: 'US', v: [256, 0, 16] },
            '00281103': { vr: 'US', v: [256, 0, 16] },
            '00281201': { vr: 'OW', v: lut(i => i) },
            '00281202': { vr: 'OW', v: lut(i => 255 - i) },
            '00281203': { vr: 'OW', v: lut(() => 128) },
          },
        }),
        ref: { kind: 'rgb', rgb },
      });
    }

    // ---- multi-frame greyscale ---------------------------------------------
    {
      const F = 4;
      const s = new Uint16Array(n * F);
      for (let f = 0; f < F; f++) {
        for (let i = 0; i < n; i++) s[f * n + i] = Math.round(p[i] * 1000) + f * 700;
      }
      const frame = (f) => s.subarray(f * n, (f + 1) * n);
      add({
        id: 'multiframe-mono',
        title: 'Four-frame MONOCHROME2 in one buffer',
        note: 'Every frame is the same ramp, shifted brighter. Frame 3 must not look like frame 0.',
        w: W, h: H, frames: 4,
        frameRef: (f) => ({ kind: 'mono', samples: frame(f), pi: 'MONOCHROME2', wc: 1500, ww: 3000 }),
        bytes: build({ rows: H, cols: W, pi: 'MONOCHROME2', ba: 16, bs: 16, hb: 15, pr: 0,
                       frames: F, wc: 1500, ww: 3000, modality: 'XA', pixels: s }),
        ref: { kind: 'mono', samples: frame(0), pi: 'MONOCHROME2', wc: 1500, ww: 3000 },
      });
    }

    // ---- multi-frame colour -------------------------------------------------
    {
      const F = 3;
      const base = colorPattern(W, H);
      const s = new Uint8Array(n * 3 * F);
      const frames = [];
      for (let f = 0; f < F; f++) {
        const fr = new Uint8Array(n * 3);
        for (let i = 0; i < n * 3; i++) fr[i] = (i % 3 === f) ? base[i] : 0;   // isolate one channel
        frames.push(fr);
        s.set(fr, f * n * 3);
      }
      add({
        id: 'multiframe-rgb',
        title: 'Three-frame RGB cine',
        note: 'Frame 0 is red only, frame 1 green only, frame 2 blue only.',
        w: W, h: H, frames: F,
        frameRef: (f) => ({ kind: 'rgb', rgb: frames[f] }),
        bytes: build({ rows: H, cols: W, pi: 'RGB', spp: 3, ba: 8, bs: 8, hb: 7, pr: 0,
                       planar: 0, frames: F, modality: 'US', pixels: s }),
        ref: { kind: 'rgb', rgb: frames[0] },
      });
    }

    // ---- implicit VR little endian -----------------------------------------
    {
      const s = new Uint16Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 4095);
      add({
        id: 'implicit-vr',
        title: 'Implicit VR Little Endian',
        note: 'No VR in the stream, so Pixel Data\'s type has to come from the dictionary.',
        w: W, h: H,
        bytes: build({ ts: IMPLICIT_LE, rows: H, cols: W, pi: 'MONOCHROME2',
                       ba: 16, bs: 12, hb: 11, pr: 0, wc: 2048, ww: 4096, pixels: s }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME2', wc: 2048, ww: 4096 },
      });
    }

    // ---- explicit VR big endian --------------------------------------------
    {
      const s = new Uint16Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 4095);
      add({
        id: 'big-endian',
        title: 'Explicit VR Big Endian (retired, still in the wild)',
        note: 'Bytes within each 16-bit sample are the other way round.',
        w: W, h: H,
        bytes: build({ ts: EXPLICIT_BE, rows: H, cols: W, pi: 'MONOCHROME2',
                       ba: 16, bs: 12, hb: 11, pr: 0, wc: 2048, ww: 4096, pixels: s }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME2', wc: 2048, ww: 4096 },
      });
    }

    // ---- raw pixels that happen to begin FF D8 -----------------------------
    {
      const s = new Uint16Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 4095);
      s[0] = 0xD8FF;                 // little endian: bytes FF D8, i.e. a JPEG SOI
      add({
        id: 'raw-looks-like-jpeg',
        title: 'Uncompressed pixels whose first bytes are FF D8',
        note: 'Stored value 55551 in the first pixel. A magic-byte sniff would call ' +
              'this a JPEG and hand back garbage; the transfer syntax says otherwise.',
        w: W, h: H,
        bytes: build({ rows: H, cols: W, pi: 'MONOCHROME2', ba: 16, bs: 16, hb: 15, pr: 0,
                       wc: 32768, ww: 65536, pixels: s }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME2', wc: 32768, ww: 65536 },
      });
    }

    // ---- encapsulated baseline JPEG ----------------------------------------
    {
      const gray = new Uint8Array(n);
      // Flat 4x4 blocks so the DCT has almost nothing to lose.
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) gray[y * W + x] = ((x >> 2) * 32) & 0xFF;
      }
      const jpg = await jpegOf(gray, W, H);
      const rgb = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) { rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = gray[i]; }
      add({
        id: 'jpeg-baseline',
        title: 'Encapsulated JPEG Baseline',
        note: 'Decoded by the browser, so this one is lossy — compared with a tolerance.',
        w: W, h: H, tol: 12,
        bytes: build({ ts: '1.2.840.10008.1.2.4.50', rows: H, cols: W, pi: 'MONOCHROME2',
                       ba: 8, bs: 8, hb: 7, pr: 0, encapsulated: [jpg] }),
        ref: { kind: 'rgb', rgb },
      });
    }

    // ---- encapsulated multi-frame JPEG -------------------------------------
    {
      const F = 3;
      const grays = [], jpgs = [];
      for (let f = 0; f < F; f++) {
        const g = new Uint8Array(n);
        for (let i = 0; i < n; i++) g[i] = (f * 80 + 20) & 0xFF;   // three flat levels
        grays.push(g);
        jpgs.push(await jpegOf(g, W, H));
      }
      const asRgb = (g) => {
        const rgb = new Uint8Array(n * 3);
        for (let i = 0; i < n; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = g[i];
        return rgb;
      };
      add({
        id: 'jpeg-multiframe',
        title: 'Three-frame encapsulated JPEG',
        note: 'One fragment per frame. Asking for frame 2 must not return frame 0.',
        w: W, h: H, frames: F, tol: 12,
        frameRef: (f) => ({ kind: 'rgb', rgb: asRgb(grays[f]) }),
        bytes: build({ ts: '1.2.840.10008.1.2.4.50', rows: H, cols: W, pi: 'MONOCHROME2',
                       ba: 8, bs: 8, hb: 7, pr: 0, frames: F, encapsulated: jpgs }),
        ref: { kind: 'rgb', rgb: asRgb(grays[0]) },
      });
    }

    // ---- JPEG Lossless, colour ---------------------------------------------
    // What a UIH CT workstation writes its secondary captures as: three
    // components, 8-bit, transfer syntax 1.2.840.10008.1.2.4.70.
    {
      const rgb = colorPattern(W, H);
      add({
        id: 'jpeg-lossless-rgb',
        title: 'JPEG Lossless, 8-bit RGB',
        note: 'Three components in one interleaved scan. Windowed as greyscale it reads ' +
              'one sample per pixel out of a three-sample stream, so every row advances a ' +
              'third as fast as it should and the picture stretches and tears.',
        w: W, h: H,
        bytes: build({ ts: '1.2.840.10008.1.2.4.70', rows: H, cols: W, pi: 'RGB', spp: 3,
                       ba: 8, bs: 8, hb: 7, pr: 0, planar: 0, modality: 'CT',
                       encapsulated: [jpegLossless(rgb, W, H, 3, 8)] }),
        ref: { kind: 'rgb', rgb },
      });
    }

    // ---- JPEG Lossless, 16-bit greyscale -----------------------------------
    {
      const s = new Uint16Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 4095);
      add({
        id: 'jpeg-lossless-mono16',
        title: 'JPEG Lossless, 12 bits in 16',
        note: 'The single-component case, which has to keep working.',
        w: W, h: H,
        bytes: build({ ts: '1.2.840.10008.1.2.4.70', rows: H, cols: W, pi: 'MONOCHROME2',
                       ba: 16, bs: 12, hb: 11, pr: 0, wc: 2048, ww: 4096, modality: 'CR',
                       encapsulated: [jpegLossless(s, W, H, 1, 12)] }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME2', wc: 2048, ww: 4096 },
      });
    }

    // ---- RLE Lossless, colour ----------------------------------------------
    // Secondary captures off CT and ultrasound workstations very often arrive
    // this way. Segments are one byte-plane each, ordered by sample then by
    // byte, most significant first (PS3.5 G.2).
    {
      const rgb = colorPattern(W, H);
      const planes = [0, 1, 2].map(c => {
        const p = new Uint8Array(n);
        for (let i = 0; i < n; i++) p[i] = rgb[i * 3 + c];
        return p;
      });
      add({
        id: 'rle-rgb',
        title: 'RLE Lossless, 8-bit RGB',
        note: 'Read as though it were uncompressed, RLE does not look like noise — it ' +
              'looks like the picture, torn diagonally, because run-length coding keeps ' +
              'bytes near their neighbours.',
        w: W, h: H,
        bytes: build({ ts: '1.2.840.10008.1.2.5', rows: H, cols: W, pi: 'RGB', spp: 3,
                       ba: 8, bs: 8, hb: 7, pr: 0, planar: 0, modality: 'XC',
                       encapsulated: [rleFrame(planes)] }),
        ref: { kind: 'rgb', rgb },
      });
    }

    // ---- RLE Lossless, 16-bit greyscale ------------------------------------
    {
      const s = new Uint16Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 4095);
      const hi = new Uint8Array(n), lo = new Uint8Array(n);
      for (let i = 0; i < n; i++) { hi[i] = s[i] >> 8; lo[i] = s[i] & 0xFF; }
      add({
        id: 'rle-mono16',
        title: 'RLE Lossless, 16-bit MONOCHROME2',
        note: 'Two segments, high byte plane first. Getting the order wrong scales every ' +
              'value by 256 rather than producing anything obviously broken.',
        w: W, h: H,
        bytes: build({ ts: '1.2.840.10008.1.2.5', rows: H, cols: W, pi: 'MONOCHROME2',
                       ba: 16, bs: 12, hb: 11, pr: 0, wc: 2048, ww: 4096, modality: 'CT',
                       encapsulated: [rleFrame([hi, lo])] }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME2', wc: 2048, ww: 4096 },
      });
    }

    // ---- RLE Lossless, multi-frame -----------------------------------------
    {
      const F = 3;
      const base = colorPattern(W, H);
      const frames = [], fragments = [];
      for (let f = 0; f < F; f++) {
        const fr = new Uint8Array(n * 3);
        for (let i = 0; i < n * 3; i++) fr[i] = (i % 3 === f) ? base[i] : 0;
        frames.push(fr);
        fragments.push(rleFrame([0, 1, 2].map(c => {
          const pl = new Uint8Array(n);
          for (let i = 0; i < n; i++) pl[i] = fr[i * 3 + c];
          return pl;
        })));
      }
      add({
        id: 'rle-multiframe',
        title: 'Three-frame RLE Lossless cine',
        note: 'One fragment per frame, as ultrasound loops arrive.',
        w: W, h: H, frames: F,
        frameRef: (f) => ({ kind: 'rgb', rgb: frames[f] }),
        bytes: build({ ts: '1.2.840.10008.1.2.5', rows: H, cols: W, pi: 'RGB', spp: 3,
                       ba: 8, bs: 8, hb: 7, pr: 0, planar: 0, frames: F, modality: 'US',
                       encapsulated: fragments }),
        ref: { kind: 'rgb', rgb: frames[0] },
      });
    }

    // ---- MONOCHROME1 inside a JPEG -----------------------------------------
    {
      const gray = new Uint8Array(n);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) gray[y * W + x] = ((x >> 2) * 32) & 0xFF;
      }
      const jpg = await jpegOf(gray, W, H);
      // The browser hands the fragment back as it was encoded; the inversion
      // MONOCHROME1 asks for is still the viewer's job.
      const rgb = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) {
        rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = 255 - gray[i];
      }
      add({
        id: 'mono1-jpeg',
        title: 'MONOCHROME1 carried by a baseline JPEG',
        note: 'Compression does not change the photometric interpretation — this still ' +
              'has to come out the other way round.',
        w: W, h: H, tol: 12,
        bytes: build({ ts: '1.2.840.10008.1.2.4.50', rows: H, cols: W, pi: 'MONOCHROME1',
                       ba: 8, bs: 8, hb: 7, pr: 0, modality: 'CR', encapsulated: [jpg] }),
        ref: { kind: 'rgb', rgb },
      });
    }

    // ---- YBR_FULL_422 inside a JPEG — the ordinary ultrasound cine ---------
    {
      // Flat colour: JPEG's chroma subsampling has nothing to blur, so any
      // difference left is a channel swap rather than a compression artefact.
      const rgb = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) { rgb[i * 3] = 230; rgb[i * 3 + 1] = 120; rgb[i * 3 + 2] = 40; }
      const jpg = await jpegOfRgb(rgb, W, H);
      add({
        id: 'ybr-422-jpeg',
        title: 'YBR_FULL_422 in a baseline JPEG',
        note: 'What almost every ultrasound cine actually is. The JPEG decoder returns ' +
              'RGB, so the photometric name must not be a reason to refuse the file.',
        w: W, h: H, tol: 6,
        bytes: build({ ts: '1.2.840.10008.1.2.4.50', rows: H, cols: W, pi: 'YBR_FULL_422',
                       spp: 3, ba: 8, bs: 8, hb: 7, pr: 0, planar: 0, modality: 'US',
                       encapsulated: [jpg] }),
        ref: { kind: 'rgb', rgb },
      });
    }

    // ---- YBR_FULL_422 raw, which we genuinely cannot do --------------------
    {
      // Subsampled chroma: two luma samples share one Cb/Cr pair, so the buffer
      // is two thirds the interleaved size.
      const s = new Uint8Array(n * 2);
      for (let i = 0; i < s.length; i++) s[i] = i & 0xFF;
      add({
        id: 'ybr-422-raw',
        title: 'YBR_FULL_422 uncompressed',
        note: 'Needs chroma upsampling we do not do. Refusing it with a reason beats ' +
              'drawing two thirds of an image.',
        w: W, h: H, broken: true, expectError: /YBR_FULL_422/i,
        bytes: build({ rows: H, cols: W, pi: 'YBR_FULL_422', spp: 3, ba: 8, bs: 8, hb: 7,
                       pr: 0, planar: 0, modality: 'US', pixels: s }),
        ref: null,
      });
    }

    // ---- one JPEG frame split across several fragments ---------------------
    {
      const gray = new Uint8Array(n);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) gray[y * W + x] = ((x >> 2) * 32) & 0xFF;
      }
      const jpg = await jpegOf(gray, W, H);
      // Split on even boundaries, as the standard requires of fragments. Only the
      // first piece carries the SOI marker.
      const whole = new Uint8Array(jpg);
      const cut1 = Math.floor(whole.length / 3) & ~1;
      const cut2 = Math.floor(whole.length * 2 / 3) & ~1;
      const parts = [whole.slice(0, cut1), whole.slice(cut1, cut2), whole.slice(cut2)]
        .map(u => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength));
      const rgb = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) { rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = gray[i]; }
      add({
        id: 'jpeg-split-fragments',
        title: 'One JPEG frame split across three fragments',
        note: 'Large single-frame images are often fragmented. Decoding only the piece ' +
              'with the SOI marker gives a third of a picture.',
        w: W, h: H, tol: 12,
        bytes: build({ ts: '1.2.840.10008.1.2.4.50', rows: H, cols: W, pi: 'MONOCHROME2',
                       ba: 8, bs: 8, hb: 7, pr: 0, encapsulated: parts }),
        ref: { kind: 'rgb', rgb },
      });
    }

    // ---- an encapsulated syntax we have no decoder for ---------------------
    {
      // MPEG-2 video in Pixel Data. The bytes are not JPEG, not J2K and not RLE,
      // so nothing recognises them — which is exactly when a viewer is tempted to
      // draw them as pixels.
      const mpeg = new Uint8Array(4096);
      mpeg.set([0x00, 0x00, 0x01, 0xB3], 0);          // MPEG sequence header
      for (let i = 4; i < mpeg.length; i++) mpeg[i] = (i * 37) & 0xFF;
      add({
        id: 'mpeg2-unsupported',
        title: 'MPEG-2 video in Pixel Data',
        note: 'There is no picture to get right here. The only correct behaviour is to ' +
              'say so rather than render the bitstream.',
        w: W, h: H, broken: true, expectError: /compressed transfer syntax/i,
        bytes: build({ ts: '1.2.840.10008.1.2.4.100', rows: H, cols: W, pi: 'YBR_PARTIAL_420',
                       spp: 3, ba: 8, bs: 8, hb: 7, pr: 0, planar: 0, modality: 'US',
                       encapsulated: [mpeg.buffer] }),
        ref: null,
      });
    }

    // ---- pixel data shorter than Rows x Columns ----------------------------
    {
      const s = new Uint16Array(Math.floor(n / 2));
      for (let i = 0; i < s.length; i++) s[i] = Math.round((i / s.length) * 4095);
      add({
        id: 'truncated-pixels',
        title: 'Truncated Pixel Data',
        note: 'Half the pixels the header promises. Should degrade, not throw.',
        w: W, h: H, broken: true,
        bytes: build({ rows: H, cols: W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
                       wc: 2048, ww: 4096, pixels: s }),
        ref: null,
      });
    }

    // ---- window width zero --------------------------------------------------
    {
      const s = new Uint16Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 4095);
      add({
        id: 'window-width-zero',
        title: 'Window Width 0',
        note: 'Illegal but it happens. Must not divide by zero or blank the image.',
        w: W, h: H, broken: true,
        bytes: build({ rows: H, cols: W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
                       wc: 2048, ww: 0, pixels: s }),
        ref: null,
      });
    }

    // ---- JPEG 2000, 12 bits in 16 ------------------------------------------
    {
      const s = new Uint16Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 4095);
      add({
        id: 'j2k-mono16-b12',
        title: 'JPEG 2000 Lossless, 12 bits in 16',
        note: 'The codestream carries 12 bits of real precision, so the decoder hands back ' +
              'two bytes per sample for a picture whose values never exceed 4095. Read at ' +
              'the wrong width it is a picture of noise; read unshifted it is 16 times too dark.',
        w: W, h: H,
        bytes: build({ ts: '1.2.840.10008.1.2.4.90', rows: H, cols: W, pi: 'MONOCHROME2',
                       ba: 16, bs: 12, hb: 11, pr: 0, wc: 2048, ww: 4096, modality: 'MG',
                       encapsulated: [b64ToBytes(J2K_MONO16_B12)] }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME2', wc: 2048, ww: 4096 },
      });
    }

    // ---- JPEG 2000, colour, with the multi-component transform --------------
    // YBR_RCT is what a lossless colour J2K is tagged with, and it is the one
    // photometric interpretation the raw path used to refuse outright. OpenJPEG
    // inverts the transform itself, so what arrives here is already RGB — a
    // second YCbCr conversion, or a refusal, are both silent picture defects.
    {
      const rgb = colorPattern(W, H);
      add({
        id: 'j2k-rgb-rct',
        title: 'JPEG 2000 Lossless, RGB with the reversible colour transform',
        note: 'Tagged YBR_RCT, decoded to RGB. Converting it again gives wrong colours with ' +
              'no error at all, which is the worst way for a viewer to be wrong.',
        w: W, h: H,
        bytes: build({ ts: '1.2.840.10008.1.2.4.90', rows: H, cols: W, pi: 'YBR_RCT', spp: 3,
                       ba: 8, bs: 8, hb: 7, pr: 0, planar: 0, modality: 'XC',
                       encapsulated: [b64ToBytes(J2K_RGB_RCT)] }),
        ref: { kind: 'rgb', rgb },
      });
    }

    // ---- JPEG-LS, 12 bits in 16 ---------------------------------------------
    {
      const s = new Uint16Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 4095);
      add({
        id: 'jls-mono16-b12',
        title: 'JPEG-LS Lossless, 12 bits in 16',
        note: 'Opens FF D8 FF F7, so it arrives down the same branch as a baseline JPEG and ' +
              'has to be told apart by transfer syntax rather than by magic bytes.',
        w: W, h: H,
        bytes: build({ ts: '1.2.840.10008.1.2.4.80', rows: H, cols: W, pi: 'MONOCHROME2',
                       ba: 16, bs: 12, hb: 11, pr: 0, wc: 2048, ww: 4096, modality: 'CR',
                       encapsulated: [b64ToBytes(JLS_MONO16_B12)] }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME2', wc: 2048, ww: 4096 },
      });
    }

    // ---- JPEG-LS, colour, sample interleaved --------------------------------
    {
      const rgb = colorPattern(W, H);
      add({
        id: 'jls-rgb',
        title: 'JPEG-LS Lossless, 8-bit RGB, sample interleaved',
        note: 'The ordinary colour layout: RGBRGB… CharLS applies no colour transform, so ' +
              'the photometric interpretation in the header is still the truth.',
        w: W, h: H,
        bytes: build({ ts: '1.2.840.10008.1.2.4.80', rows: H, cols: W, pi: 'RGB', spp: 3,
                       ba: 8, bs: 8, hb: 7, pr: 0, planar: 0, modality: 'XC',
                       encapsulated: [b64ToBytes(JLS_RGB)] }),
        ref: { kind: 'rgb', rgb },
      });
    }

    // ---- JPEG-LS, colour, component interleaved -----------------------------
    // (0028,0006) says 0 here, as PS3.5 A.4 requires of an encapsulated image,
    // and the codestream is planar anyway. Only the codec knows, which is why
    // its reported interleave mode has to outrank the tag.
    {
      const rgb = colorPattern(W, H);
      add({
        id: 'jls-rgb-planar',
        title: 'JPEG-LS Lossless, 8-bit RGB, component interleaved',
        note: 'Three whole planes in one stream while the tag claims interleaved samples. ' +
              'Believing the tag turns the picture into three vertical bands.',
        w: W, h: H,
        bytes: build({ ts: '1.2.840.10008.1.2.4.80', rows: H, cols: W, pi: 'RGB', spp: 3,
                       ba: 8, bs: 8, hb: 7, pr: 0, planar: 0, modality: 'XC',
                       encapsulated: [b64ToBytes(JLS_RGB_PLANAR)] }),
        ref: { kind: 'rgb', rgb },
      });
    }

    // ---- a JPEG 2000 header with nothing behind it --------------------------
    {
      // A J2K codestream signature and 60 zero bytes. OpenJPEG does not throw on
      // this: it returns a frameInfo of all zeros and an empty buffer, so only an
      // explicit check stands between it and a silently blank frame.
      const j2k = new Uint8Array(64);
      j2k.set([0xFF, 0x4F, 0xFF, 0x51], 0);
      add({
        id: 'jpeg2000-unsupported',
        title: 'JPEG 2000 with an unreadable codestream',
        note: 'The right behaviour is a clear message, not a blank canvas or a crash.',
        w: W, h: H, broken: true, expectError: /2000/i,
        bytes: build({ ts: '1.2.840.10008.1.2.4.90', rows: H, cols: W, pi: 'MONOCHROME2',
                       ba: 16, bs: 12, hb: 11, pr: 0, encapsulated: [j2k.buffer] }),
        ref: null,
      });
    }

    // ---- a JPEG 2000 codestream cut off part-way ----------------------------
    {
      add({
        id: 'j2k-truncated',
        title: 'JPEG 2000 truncated to its first 200 bytes',
        note: 'A valid header over half a picture. The decoder returns width 0 and an empty ' +
              'buffer rather than raising, so this is the case the length guard exists for.',
        w: W, h: H, broken: true, expectError: /2000/i,
        bytes: build({ ts: '1.2.840.10008.1.2.4.90', rows: H, cols: W, pi: 'MONOCHROME2',
                       ba: 16, bs: 12, hb: 11, pr: 0, wc: 2048, ww: 4096,
                       encapsulated: [b64ToBytes(J2K_MONO16_B12).slice(0, 200)] }),
        ref: null,
      });
    }

    // ---- High-Throughput JPEG 2000, which stays refused ---------------------
    // Part 15 shares the FF 4F FF 51 magic with Part 1 but not the block coder,
    // and OpenJPEG 2.x does not implement it. The refusal has to be by transfer
    // syntax; a magic-byte test would hand this straight to the wrong decoder.
    {
      const ht = new Uint8Array(64);
      ht.set([0xFF, 0x4F, 0xFF, 0x51], 0);
      add({
        id: 'htj2k-unsupported',
        title: 'High-Throughput JPEG 2000 (1.2.840.10008.1.2.4.201)',
        note: 'Named in the refusal so the user can tell it apart from ordinary JPEG 2000, ' +
              'which this tool does decode.',
        w: W, h: H, broken: true, expectError: /High-Throughput|201/i,
        bytes: build({ ts: '1.2.840.10008.1.2.4.201', rows: H, cols: W, pi: 'MONOCHROME2',
                       ba: 16, bs: 12, hb: 11, pr: 0, encapsulated: [ht.buffer] }),
        ref: null,
      });
    }

    return cases;
  }

  // ------------------------------------------------------------ demo samples --
  //
  // The corpus above is built to break decoders: 32x32 ramps and corner flags,
  // deliberately malformed files, patterns chosen so a transpose or an off-by-one
  // is unmissable. None of that is any use as the first thing a visitor sees.
  //
  // Forge.samples() is the other audience. It builds a small synthetic study
  // that looks enough like imaging to be worth opening, with a complete header
  // so the Overview's cards fill in and its Conformance check comes back clean.
  // It lives here, beside the corpus, for one reason: every sample carries the
  // same independently computed reference the corpus cases do, so the suites can
  // hold the app's front door to exactly the same standard as its test files. A
  // second copy of this in index.html would be a picture with no oracle behind it.

  // Deterministic value noise in 0..1. Math.random would make a sample that is
  // not the same file twice, and the reference image is derived from this
  // raster — an oracle cannot be built on a picture that changes between runs.
  function noise(x, y, seed) {
    let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  // A 5x7 column-major font, five bytes a glyph, bit 0 the top row. Only the
  // characters a modality's burned-in banner uses — this exists to put plausible
  // identity into pixels for the redaction tool to find, not to typeset.
  const TEXT_CHARS = ' -./:0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ^';
  const TEXT_FONT =
    '0000000000' + '0808080808' + '0060600000' + '2010080402' + '0036360000' +
    '3E5149453E' + '00427F4000' + '4261514946' + '2141454B31' + '1814127F10' +
    '2745454539' + '3C4A494930' + '0171090503' + '3649494936' + '064949291E' +
    '7E1111117E' + '7F49494936' + '3E41414122' + '7F4141221C' + '7F49494941' +
    '7F09090101' + '3E4149497A' + '7F0808087F' + '00417F4100' + '2040413F01' +
    '7F08142241' + '7F40404040' + '7F0204027F' + '7F0408107F' + '3E4141413E' +
    '7F09090906' + '3E4151215E' + '7F09192946' + '4649494931' + '01017F0101' +
    '3F4040403F' + '1F2040201F' + '7F2018207F' + '6314081463' + '0708700807' +
    '6151494543' + '0402010204';

  // Stamps text through a put(x, y) callback, so the same glyphs burn into a
  // greyscale plane and into RGB triplets. A character the font has no glyph for
  // advances as a space rather than throwing.
  function drawText(text, x0, y0, scale, put) {
    for (const [i, ch] of [...String(text).toUpperCase()].entries()) {
      const gi = TEXT_CHARS.indexOf(ch);
      if (gi < 0) continue;
      for (let col = 0; col < 5; col++) {
        const bits = parseInt(TEXT_FONT.substr(gi * 10 + col * 2, 2), 16);
        for (let row = 0; row < 7; row++) {
          if (!(bits & (1 << row))) continue;
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) put(x0 + (i * 6 + col) * scale + dx, y0 + row * scale + dy);
          }
        }
      }
    }
  }

  // An axial abdomen in Hounsfield units. Not anatomy — enough structure at
  // enough different densities that a missing rescale or the wrong window is
  // obvious at a glance, which is the whole point of shipping it as a sample.
  function ctAbdomenHU(w, h) {
    const out = new Float32Array(w * h);
    const cx = w / 2, cy = h * 0.52, rx = w * 0.42, ry = h * 0.34;
    const near = (x, y, px, py, r) => Math.hypot(x - px, y - py) < r;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x - cx) / rx, v = (y - cy) / ry;
        let hu = -1000;                                                  // air
        if (u * u + v * v < 1) {
          hu = (u * u + v * v) > 0.88 ? -95 : 45;                        // fat rind, then soft tissue
          if (near(x, y, cx - w * 0.14, cy - h * 0.14, w * 0.18)) hu = 88;   // liver
          if (near(x, y, cx + w * 0.20, cy - h * 0.13, w * 0.09)) hu = 70;   // spleen
          if (near(x, y, cx - w * 0.23, cy + h * 0.07, w * 0.075)) hu = 30;  // kidneys
          if (near(x, y, cx + w * 0.23, cy + h * 0.07, w * 0.075)) hu = 30;
          if (near(x, y, cx + w * 0.04, cy + h * 0.11, w * 0.032)) hu = 260; // contrast-filled aorta
          if (near(x, y, cx, cy + h * 0.22, w * 0.075)) hu = 420;            // vertebral body
          hu += (noise(x, y, 7) - 0.5) * 16;                                 // quantum noise
        }
        out[y * w + x] = hu;
      }
    }
    return out;
  }

  // A PA chest as TRANSMISSION in 0..1, not density: a lot of X-rays get through
  // lung, almost none through spine. That is what a MONOCHROME1 CR stores, and
  // it is why zero has to come out white. Render this one MONOCHROME2 by mistake
  // and you get a photographic negative — bright lungs, black ribs.
  function crChestTransmission(w, h) {
    const out = new Float32Array(w * h);
    const cx = w / 2;
    const lung = (x, y, sx) => {
      const u = (x - cx - sx * w) / (w * 0.185), v = (y - h * 0.42) / (h * 0.25);
      return u * u + v * v < 1;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const fy = y / h;
        // Outside the torso the beam hits the detector unattenuated, which is
        // the blackest thing on a chest film — without it the whole frame reads
        // as one white slab and there is nothing to judge the inversion by.
        const half = w * (0.30 + 0.13 * Math.min(1, Math.max(0, (fy - 0.05) * 2.2)));
        const inBody = Math.abs(x - cx) <= half && fy >= 0.05 && fy <= 0.93;
        let t = 0.97;
        if (inBody) {
          t = 0.42;                                                      // soft tissue
          const inLung = lung(x, y, -0.21) || lung(x, y, 0.21);
          if (inLung) t = 0.80;
          // Vessels fanning out of the hila; they darken lung, not black it out.
          if (inLung && Math.abs(Math.abs(x - cx) - w * 0.09 - (y - h * 0.34) * 0.30) < w * 0.013) t -= 0.22;
          // Ribs: a family of arcs crossing everything, denser than lung, thinner than spine.
          const rib = (y - h * 0.16) - Math.abs(x - cx) * 0.40;
          if (rib > 0 && rib % (h * 0.105) < h * 0.019 && fy < 0.74) t = Math.min(t, 0.10);
          const hx = (x - cx + w * 0.05) / (w * 0.20), hy = (y - h * 0.60) / (h * 0.16);
          if (hx * hx + hy * hy < 1) t = Math.min(t, 0.22);                                   // heart
          if (fy > 0.75 + 0.05 * Math.cos((x - cx) / w * 5)) t = Math.min(t, 0.20);           // diaphragm
          if (Math.abs(x - cx) < w * 0.035 && fy > 0.10 && fy < 0.86) t = 0.05;               // spine
        }
        out[y * w + x] = Math.max(0.01, Math.min(1, t + (noise(x, y, 11) - 0.5) * 0.035));
      }
    }
    return out;
  }

  // A B-mode sector in 0..1: a wedge out of the top of the frame, speckle inside
  // it, two anechoic chambers and one bright interface. `phase` moves the near
  // structures, so a cine of these has something that visibly beats.
  function usSector(w, h, phase) {
    const g = new Float32Array(w * h);
    const ax = w / 2, ay = -h * 0.10;                                    // apex just above the frame
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - ax, dy = y - ay;
        const ang = Math.atan2(dx, dy), r = Math.hypot(dx, dy);
        let v = 0;
        if (Math.abs(ang) < 0.60 && r > h * 0.13 && r < h * 1.02) {
          v = 0.22 + 0.55 * noise(x, y, 3) * (1.15 - r / (h * 1.1));     // speckle, fading with depth
          if (Math.abs(r - h * (0.60 + 0.05 * Math.sin(phase))) < h * 0.018) v = 0.92;
          if (Math.hypot(x - w * 0.37, y - (h * 0.44 + h * 0.05 * Math.sin(phase))) < w * 0.10) v = 0.04;
          if (Math.hypot(x - w * 0.66, y - h * 0.66) < w * 0.06) v = 0.05;
        }
        g[y * w + x] = Math.max(0, Math.min(1, v));
      }
    }
    return g;
  }

  // The same sector as RGB, with a colour Doppler box laid over it: red towards
  // the probe, blue away. What this sample is really for is that RGB has to come
  // out of the pipeline untouched — no windowing, no inversion, no channel swap.
  function usColorRGB(w, h, phase) {
    const g = usSector(w, h, phase);
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, o = i * 3;
        rgb[o] = rgb[o + 1] = rgb[o + 2] = Math.round(g[i] * 255);
        const inBox = x > w * 0.27 && x < w * 0.73 && y > h * 0.30 && y < h * 0.72;
        if (!inBox || g[i] <= 0.03) continue;
        const flow = Math.sin((x / w) * 14 + phase) * (1 - Math.abs(y / h - 0.50) * 3.2);
        if (flow > 0.35) {
          rgb[o] = 45 + Math.round(flow * 210); rgb[o + 1] = Math.round(flow * 95); rgb[o + 2] = 25;
        } else if (flow < -0.35) {
          rgb[o] = 25; rgb[o + 1] = Math.round(-flow * 105); rgb[o + 2] = 45 + Math.round(-flow * 210);
        }
      }
    }
    return rgb;
  }

  // Identity that is unmistakably fake wherever it surfaces — in a tag, in the
  // pixels, or in a screenshot somebody pastes into a bug report.
  const SAMPLE_STUDY_UID  = '1.2.826.0.1.3680043.10.99999.9.1';
  const SAMPLE_FRAME_UID  = '1.2.826.0.1.3680043.10.99999.9.99';
  // Fixed, not minted from the corpus's uid() counter: the same sample has to
  // come out byte for byte the same on every call, or a #sample= link stops
  // reproducing and the reference image stops being a reference to anything.
  const sampleUID = (series, inst) => `${SAMPLE_STUDY_UID}.${series}` + (inst ? `.${inst}` : '');
  // Kept to 21 characters: at the scale the banner is drawn, that is what fits
  // across a 256-wide frame without running off the edge.
  const SAMPLE_BANNER     = ['SAMPLE^PHANTOM', 'ID SAMPLE-001', '2026/01/01 12:00'];

  // Type 1 and Type 2 attributes every sample shares. Without these the demo's
  // own Conformance card opens red, which is a poor advertisement for a tool
  // whose selling point is that it checks conformance.
  function sampleHeader(series, seriesDesc, bodyPart, spacing) {
    return {
      '00080050': { vr: 'SH', v: ['SAMPLE-ACC'] },                 // Accession Number
      '00080070': { vr: 'LO', v: ['Carino Systems'] },             // Manufacturer
      '00080080': { vr: 'LO', v: ['Carino Systems'] },             // Institution Name
      '00080090': { vr: 'PN', v: ['Sample^Referrer'] },            // Referring Physician
      '0008103e': { vr: 'LO', v: [seriesDesc] },                   // Series Description
      '00081010': { vr: 'SH', v: ['DEMO-01'] },                    // Station Name
      '00081090': { vr: 'LO', v: ['Forge Phantom'] },              // Manufacturer Model Name
      '00100010': { vr: 'PN', v: ['Sample^Phantom'] },
      '00100020': { vr: 'LO', v: ['SAMPLE-001'] },
      '00100030': { vr: 'DA', v: ['19800101'] },                   // Patient Birth Date
      '00100040': { vr: 'CS', v: ['O'] },                          // Patient Sex
      '00101010': { vr: 'AS', v: ['045Y'] },                       // Patient Age
      '00180015': { vr: 'CS', v: [bodyPart] },                     // Body Part Examined
      '00181020': { vr: 'LO', v: ['forge'] },                      // Software Versions
      '00200010': { vr: 'SH', v: ['SAMPLE1'] },                    // Study ID
      '00200011': { vr: 'IS', v: [String(series)] },               // Series Number
      '00280030': { vr: 'DS', v: spacing },                        // Pixel Spacing
    };
  }

  /**
   * A small synthetic study for the app's empty state: five files, one patient,
   * one study, one series each. Same shape as a corpus case, so the suites and
   * the gallery can consume them without knowing which list they came from.
   */
  function samples(size) {
    const w = size || 256, h = size || 256, n = w * h;
    const out = [];
    const add = (c) => { out.push(c); return c; };

    // ---- CT abdomen: rescale to Hounsfield, soft-tissue window --------------
    {
      const hu = ctAbdomenHU(w, h);
      // Stored signed with intercept -1024, which is what CT actually ships:
      // the numbers in the file are meaningless until the rescale is applied.
      const s = new Int16Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.max(0, Math.min(4095, Math.round(hu[i] + 1024)));
      add({
        id: 'ct', name: 'CT abdomen', file: 'sample-ct-abdomen.dcm',
        title: 'Soft-tissue window over real Hounsfield units',
        note: 'Stored signed with intercept -1024, so the numbers in the file mean nothing until '
            + 'the rescale is applied. The WC 40 / WW 400 window is in Hounsfield units.',
        w, h, frames: 1,
        bytes: build({
          rows: h, cols: w, pi: 'MONOCHROME2', ba: 16, bs: 16, hb: 15, pr: 1,
          wc: 40, ww: 400, slope: 1, intercept: -1024, modality: 'CT',
          sopClass: '1.2.840.10008.5.1.4.1.1.2', title: 'SAMPLE CT ABDOMEN',
          studyUID: SAMPLE_STUDY_UID, seriesUID: sampleUID(1), sopInstance: sampleUID(1, 1),
          instance: 1, pixels: s,
          extra: Object.assign(sampleHeader(1, 'AXIAL 5MM', 'ABDOMEN', ['0.7', '0.7']), {
            '00180050': { vr: 'DS', v: ['5.0'] },                  // Slice Thickness
            '00180060': { vr: 'DS', v: ['120'] },                  // KVP
            '00181030': { vr: 'LO', v: ['SAMPLE ABDOMEN'] },       // Protocol Name
            '00181160': { vr: 'SH', v: ['NONE'] },                 // Filter Type
            '00200032': { vr: 'DS', v: ['-89.6', '-89.6', '0'] },  // Image Position (Patient)
            '00200037': { vr: 'DS', v: ['1', '0', '0', '0', '1', '0'] },
            '00200052': { vr: 'UI', v: [SAMPLE_FRAME_UID] },       // Frame of Reference UID
          }),
        }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME2', wc: 40, ww: 400, slope: 1, intercept: -1024 },
      });
    }

    // ---- Chest CR: MONOCHROME1, where zero is white -------------------------
    {
      const t = crChestTransmission(w, h);
      const s = new Uint16Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.round(t[i] * 4095);
      add({
        id: 'cr', name: 'Chest X-ray', file: 'sample-cr-chest.dcm',
        title: 'MONOCHROME1 — the inversion most viewers get wrong',
        note: 'The pixels hold transmission, not density: zero has to come out white. Render it '
            + 'MONOCHROME2 by mistake and you get bright lungs and black ribs.',
        w, h, frames: 1,
        bytes: build({
          rows: h, cols: w, pi: 'MONOCHROME1', ba: 16, bs: 12, hb: 11, pr: 0,
          wc: 2048, ww: 4096, modality: 'CR',
          sopClass: '1.2.840.10008.5.1.4.1.1.1', title: 'SAMPLE CHEST PA',
          studyUID: SAMPLE_STUDY_UID, seriesUID: sampleUID(2), sopInstance: sampleUID(2, 1),
          instance: 1, pixels: s,
          extra: Object.assign(sampleHeader(2, 'PA ERECT', 'CHEST', ['0.14', '0.14']), {
            '00181030': { vr: 'LO', v: ['SAMPLE CHEST PA'] },
          }),
        }),
        ref: { kind: 'mono', samples: s, pi: 'MONOCHROME1', wc: 2048, ww: 4096 },
      });
    }

    // ---- Colour Doppler ultrasound ------------------------------------------
    {
      const rgb = usColorRGB(w, h, 0.9);
      add({
        id: 'us', name: 'Ultrasound (colour)', file: 'sample-us-doppler.dcm',
        title: 'RGB colour Doppler — no window, no inversion, no channel swap',
        note: 'Interleaved RGB, planar configuration 0. Nothing about it should be windowed on '
            + 'the way to the canvas, and red must stay on the same side it started.',
        w, h, frames: 1,
        bytes: build({
          rows: h, cols: w, pi: 'RGB', spp: 3, ba: 8, bs: 8, hb: 7, pr: 0, planar: 0,
          modality: 'US', sopClass: '1.2.840.10008.5.1.4.1.1.6.1', title: 'SAMPLE US DOPPLER',
          studyUID: SAMPLE_STUDY_UID, seriesUID: sampleUID(3), sopInstance: sampleUID(3, 1),
          instance: 1, pixels: rgb,
          extra: sampleHeader(3, 'COLOUR DOPPLER', 'HEART', ['0.25', '0.25']),
        }),
        ref: { kind: 'rgb', rgb },
      });
    }

    // ---- Multi-frame cine ----------------------------------------------------
    {
      const F = 16;
      const s = new Uint8Array(n * F);
      const frames = [];
      for (let f = 0; f < F; f++) {
        const g = usSector(w, h, (f / F) * Math.PI * 2);
        const fr = new Uint8Array(n);
        for (let i = 0; i < n; i++) fr[i] = Math.round(g[i] * 255);
        frames.push(fr);
        s.set(fr, f * n);
      }
      add({
        id: 'cine', name: 'Cine loop', file: 'sample-us-cine.dcm',
        title: 'Sixteen frames at 30 fps — the frame slider and the play button',
        note: 'Carries both a Recommended Display Frame Rate and a Frame Time, so the rate the '
            + 'player picks is the one the standard says it should.',
        w, h, frames: F,
        bytes: build({
          rows: h, cols: w, pi: 'MONOCHROME2', ba: 8, bs: 8, hb: 7, pr: 0, frames: F,
          wc: 128, ww: 256, modality: 'US', sopClass: '1.2.840.10008.5.1.4.1.1.3.1',
          title: 'SAMPLE US CINE', studyUID: SAMPLE_STUDY_UID, seriesUID: sampleUID(4),
          sopInstance: sampleUID(4, 1), instance: 1, pixels: s,
          extra: Object.assign(sampleHeader(4, 'FOUR CHAMBER', 'HEART', ['0.25', '0.25']), {
            // Both rates, because the app prefers the recommended one and falls
            // back to frame time; a sample should exercise the branch it takes.
            '00082144': { vr: 'IS', v: ['30'] },                   // Recommended Display Frame Rate
            '00181063': { vr: 'DS', v: ['33.33'] },                // Frame Time
          }),
        }),
        frameRef: (f) => ({ kind: 'mono', samples: frames[f], pi: 'MONOCHROME2', wc: 128, ww: 256 }),
        ref: { kind: 'mono', samples: frames[0], pi: 'MONOCHROME2', wc: 128, ww: 256 },
      });
    }

    // ---- Burned-in annotation, for the redaction tool ------------------------
    {
      const rgb = usColorRGB(w, h, 2.4);
      // White text at the top left and a footer, exactly where a modality puts
      // it. The reference image is this same raster, so the gallery and the
      // suites see the identity too — a redaction that removed nothing would
      // still match, which is why redact.js compares before and after instead.
      const put = (x, y) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        const o = (y * w + x) * 3;
        rgb[o] = rgb[o + 1] = rgb[o + 2] = 255;
      };
      const scale = Math.max(1, Math.round(w / 170));
      SAMPLE_BANNER.forEach((line, i) => drawText(line, Math.round(w * 0.03), Math.round(h * 0.03) + i * 9 * scale, scale, put));
      drawText('MI 0.9  TIS 0.4', Math.round(w * 0.03), h - 10 * scale, scale, put);
      add({
        id: 'burn', name: 'Burned-in annotation', file: 'sample-burned-in.dcm',
        title: 'Patient identity in the pixels, flagged (0028,0301) = YES',
        note: 'A name, an ID and a date drawn into the image the way a modality console burns '
            + 'them in. Anonymising the tags does not touch it — this is what Redact is for.',
        w, h, frames: 1, burnedIn: true,
        bytes: build({
          rows: h, cols: w, pi: 'RGB', spp: 3, ba: 8, bs: 8, hb: 7, pr: 0, planar: 0,
          modality: 'US', sopClass: '1.2.840.10008.5.1.4.1.1.7', title: 'SAMPLE SCREEN CAPTURE',
          studyUID: SAMPLE_STUDY_UID, seriesUID: sampleUID(5), sopInstance: sampleUID(5, 1),
          instance: 1, pixels: rgb,
          extra: Object.assign(sampleHeader(5, 'SCREEN CAPTURE', 'HEART', ['0.25', '0.25']), {
            '00280301': { vr: 'CS', v: ['YES'] },                  // Burned In Annotation
          }),
        }),
        ref: { kind: 'rgb', rgb },
      });
    }

    return out;
  }

  // -------------------------------------------------------------- comparing --

  // Returns null when the buffers agree, or a description of the first and worst
  // disagreement. Alpha is ignored — nothing here is transparent.
  function compare(got, want, tol) {
    tol = tol || 0;
    if (!got) return 'no pixels at all';
    if (got.length !== want.length) return `length ${got.length}, expected ${want.length}`;
    let worst = 0, worstAt = -1, firstAt = -1, bad = 0;
    for (let i = 0; i < want.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(got[i + c] - want[i + c]);
        if (d > tol) {
          bad++;
          if (firstAt < 0) firstAt = i / 4;
          if (d > worst) { worst = d; worstAt = i / 4; }
          break;
        }
      }
    }
    if (!bad) return null;
    const at = worstAt * 4;
    return `${bad}/${want.length / 4} px differ, worst ${worst} at px ${worstAt} ` +
           `(got ${got[at]},${got[at + 1]},${got[at + 2]} want ${want[at]},${want[at + 1]},${want[at + 2]}), ` +
           `first at px ${firstAt}`;
  }

  // The checked-in codestreams, by name, so a suite can wrap one in a header
  // that deliberately disagrees with it. Nothing else should reach for these —
  // they are reference bytes, not an encoder.
  const CODESTREAMS = { J2K_MONO16_B12, J2K_RGB_RCT, JLS_MONO16_B12, JLS_RGB, JLS_RGB_PLANAR };
  const codestream = (name) => b64ToBytes(CODESTREAMS[name]);

  window.Forge = { build, corpus, samples, expected, compare, pattern, colorPattern,
                   windowFloats, encapsulate, element, sequence, jpegLossless, rleFrame,
                   drawText, codestream, W, H };
})();
