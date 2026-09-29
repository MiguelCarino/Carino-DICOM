// Pixel preview: frame decoders (RLE, JPEG, J2K, JPEG-LS), stored pixels, window/level and fullscreen.
// ---- Frame helpers ----
function lookupTag(d, tag8) {
  const lo = tag8.toLowerCase();
  return d['x' + lo] || d[lo] ||
    d[Object.keys(d).find(k => k.replace(/^x/i,'').toLowerCase() === lo) || ''];
}

// JPEG / J2K fragments of encapsulated Pixel Data, sorted by magic bytes.
function collectEncapsulatedFrames(px) {
  const jpeg = [], j2k = [];
  for (const v of (px.Value || [])) {
    let buf = v;
    if (ArrayBuffer.isView(buf)) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 4) continue;
    const b = new Uint8Array(buf, 0, 4);
    if (b[0] === 0xFF && b[1] === 0xD8) { jpeg.push(buf); continue; }
    if ((b[0] === 0xFF && b[1] === 0x4F) || (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x00 && b[3] === 0x0C)) { j2k.push(buf); }
  }
  return { jpeg, j2k };
}

// Every fragment of encapsulated Pixel Data. Zero-length entries (empty Basic Offset Table) are dropped.
function encapsulatedFragments(px) {
  const out = [];
  for (const v of (px.Value || [])) {
    let buf = v;
    if (ArrayBuffer.isView(buf)) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    if (buf instanceof ArrayBuffer && buf.byteLength) out.push(buf);
  }
  return out;
}

function concatBuffers(bufs) {
  const total = bufs.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of bufs) { out.set(new Uint8Array(b), o); o += b.byteLength; }
  return out.buffer;
}

// PackBits (PS3.5 Annex G): n>=0 copies n+1 literals, -1..-127 repeats the next byte 1-n times, -128 no-op.
// A short segment leaves the rest of the plane zero rather than throwing.
function unpackBits(src, outLen) {
  const out = new Uint8Array(outLen);
  let i = 0, o = 0;
  while (i < src.length && o < outLen) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) {
      for (let k = 0; k <= n && o < outLen && i < src.length; k++) out[o++] = src[i++];
    } else if (n !== -128) {
      const v = src[i++];
      for (let k = 0; k < 1 - n && o < outLen; k++) out[o++] = v;
    }
  }
  return out;
}

// RLE Lossless (1.2.840.10008.1.2.5) to raw interleaved little-endian bytes. Segments are byte planes
// per sample, most significant byte first, so byte order within a sample is reversed.
function rleToRaw(buf, framePixels, spp, bytesPerSample) {
  if (buf.byteLength < 64) throw new Error('frame is shorter than the RLE header');
  const dv = new DataView(buf);
  const nSeg = dv.getUint32(0, true);
  const want = spp * bytesPerSample;
  if (nSeg !== want) throw new Error(`${nSeg} segments for ${spp} sample(s) of ${bytesPerSample} byte(s)`);

  const src = new Uint8Array(buf);
  const out = new Uint8Array(framePixels * want);
  for (let s = 0; s < nSeg; s++) {
    const start = dv.getUint32(4 + s * 4, true);
    const next  = s + 1 < nSeg ? dv.getUint32(8 + s * 4, true) : 0;
    if (start < 64 || start >= src.length) throw new Error(`segment ${s} starts outside the frame`);
    const end = next > start && next <= src.length ? next : src.length;
    const plane = unpackBits(src.subarray(start, end), framePixels);
    const sample = Math.floor(s / bytesPerSample);
    const at = sample * bytesPerSample + (bytesPerSample - 1 - (s % bytesPerSample));
    for (let i = 0; i < framePixels; i++) out[i * want + at] = plane[i];
  }
  return out.buffer;
}

// Window cached floats to RGBA, so W/L can change without re-decoding. `invert` is MONOCHROME1's
// photometric inversion (PS3.3 C.7.6.3.1.2), not the viewer's Invert button, which composes on top.
function applyWindowToFloats(raw, framePixels, wcVal, wwVal, mn, mx, invert = false) {
  let lo, hi;
  if (wwVal != null && wcVal != null) {
    lo = wcVal - 0.5 - (wwVal - 1) / 2;
    hi = wcVal - 0.5 + (wwVal - 1) / 2;
  } else { lo = mn; hi = mx; }
  const range = (hi - lo) || 1;
  const out = new Uint8ClampedArray(framePixels * 4);
  for (let i = 0; i < framePixels; i++) {
    const v = raw[i];
    let g = v <= lo ? 0 : v >= hi ? 255 : Math.round(((v - lo) / range) * 255);
    if (invert) g = 255 - g;
    const p = i * 4;
    out[p] = out[p+1] = out[p+2] = g; out[p+3] = 255;
  }
  return out;
}

// One Palette Color LUT as a 0..255 ramp. Descriptor = [entries (0 = 65536), first mapped value,
// bits per entry]; 16-bit tables keep the high byte (PS3.3 C.7.6.3.1.5). null if missing/short.
function readPaletteLut(d, descTag, dataTag, bigEndian) {
  const desc = lookupTag(d, descTag)?.Value;
  const el = lookupTag(d, dataTag);
  if (!desc || desc.length < 3 || !el) return null;

  let buf = el.Value?.[0];
  if (!buf && typeof el.InlineBinary === 'string') { try { buf = b64ToAB(el.InlineBinary); } catch (_) {} }
  if (ArrayBuffer.isView(buf)) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (!(buf instanceof ArrayBuffer)) return null;

  const count = (desc[0] | 0) || 65536;
  const first = desc[1] | 0;
  const lut = new Uint8Array(count);

  if ((desc[2] | 0) === 16 && buf.byteLength >= count * 2) {
    const dv = new DataView(buf);
    for (let i = 0; i < count; i++) lut[i] = dv.getUint16(i * 2, !bigEndian) >> 8;
  } else {
    const u8 = new Uint8Array(buf);
    if (u8.length < count) return null;
    lut.set(u8.subarray(0, count));
  }
  return { lut, first, count };
}

// ---- Codec loaders ----
// JPEG Lossless decoder: a local vendored ES module, loaded with dynamic import. Never a CDN —
// the Carino DICOM build runs on air-gapped networks and promises no unconfigured outbound traffic.
const JPEG_LOSSLESS_MODULE = '../vendor/lossless-min.js';
let _jpegLosslessDecoder = null;
async function loadJpegLossless() {
  if (_jpegLosslessDecoder) return _jpegLosslessDecoder;
  const mod = await import(JPEG_LOSSLESS_MODULE);
  _jpegLosslessDecoder = mod.Decoder;
  return _jpegLosslessDecoder;
}

// JPEG 2000 / JPEG-LS bundles are UMD: import() resolves silently to an empty namespace. Only a
// <script> tag makes them publish OpenJPEGWASM / CharLSWASM. Do not switch these to import().
const _vendorScripts = new Map();
function loadVendorScript(src) {
  if (_vendorScripts.has(src)) return _vendorScripts.get(src);
  const p = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(el);
  });
  // Don't cache failures, so one bad fetch doesn't disable the codec for the session.
  _vendorScripts.set(src, p.catch((e) => { _vendorScripts.delete(src); throw e; }));
  return _vendorScripts.get(src);
}

// locateFile points emscripten at vendor/*.wasm (else resolved against the page). print/printErr
// are silenced because OpenJPEG logs several [INFO] lines per decoded frame.
let _openJpeg = null;
async function loadOpenJpeg() {
  if (_openJpeg) return _openJpeg;
  await loadVendorScript('./vendor/openjpegwasm_decode.js');
  if (typeof window.OpenJPEGWASM !== 'function') throw new Error('OpenJPEGWASM did not load');
  _openJpeg = await window.OpenJPEGWASM({ locateFile: (p) => 'vendor/' + p, print() {}, printErr() {} });
  return _openJpeg;
}

let _charls = null;
async function loadCharls() {
  if (_charls) return _charls;
  await loadVendorScript('./vendor/charlswasm_decode.js');
  if (typeof window.CharLSWASM !== 'function') throw new Error('CharLSWASM did not load');
  _charls = await window.CharLSWASM({ locateFile: (p) => 'vendor/' + p, print() {}, printErr() {} });
  return _charls;
}

// Decode one fragment with 'j2k' or 'jls'. Returns { bytes, info, planar }; throws if the module
// fails to load or rejects the stream. bytes is a copy: the decoder's view into the wasm heap is
// invalidated by delete() and can detach on heap growth.
async function wasmDecodeFrame(kind, frag) {
  const src = ArrayBuffer.isView(frag)
    ? new Uint8Array(frag.buffer, frag.byteOffset, frag.byteLength)
    : new Uint8Array(frag);
  const mod = kind === 'j2k' ? await loadOpenJpeg() : await loadCharls();
  const dec = kind === 'j2k' ? new mod.J2KDecoder() : new mod.JpegLSDecoder();
  try {
    dec.getEncodedBuffer(src.length).set(src);
    dec.decode();
    const fi = dec.getFrameInfo();
    // CharLS interleave mode 0 = whole planes (DICOM Planar Configuration 1). OpenJPEG always interleaves.
    const planar = kind === 'jls' ? (dec.getInterleaveMode() === 0 ? 1 : 0) : 0;
    const out = dec.getDecodedBuffer();
    return {
      bytes: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
      info: { width: fi.width | 0, height: fi.height | 0, bitsPerSample: fi.bitsPerSample | 0,
              componentCount: fi.componentCount | 0, isSigned: !!fi.isSigned },
      planar,
    };
  } finally { dec.delete(); }
}

// Error text if a decoded frame disagrees with the header (Rows, Columns, Bits Allocated, Samples
// per Pixel), else null. OpenJPEG returns empty output instead of throwing on bad input, and later
// code indexes samples by the header's numbers, so a mismatch would otherwise render as noise.
function codecFrameMismatch(info, bytes, rows, cols, ba, spp) {
  if (info.width !== cols || info.height !== rows)
    return `${T('The decoded image does not match Rows and Columns in the header')} (${info.width}x${info.height})`;
  if (!info.componentCount)
    return `${bytes.byteLength} decoded byte(s), expected ${rows * cols}`;
  const decodedBits = info.bitsPerSample > 8 ? 16 : 8;
  if (ba != null && decodedBits !== (ba > 8 ? 16 : 8))
    return `${T('The decoded image does not match Bits Allocated in the header')} ` +
           `(${info.bitsPerSample} vs ${ba})`;
  if (spp != null && info.componentCount !== spp)
    return `${T('The decoded image does not match Samples per Pixel in the header')} ` +
           `(${info.componentCount} vs ${spp})`;
  const want = rows * cols * info.componentCount * (decodedBits / 8);
  if (bytes.byteLength !== want)
    return `${bytes.byteLength} decoded byte(s), expected ${want}`;
  return null;
}

// ---- Stored pixels (redaction, rotate/flip) ----
// Pixel rewrites need stored values, not display pixels (decodeDicomPixels inverts MONOCHROME1 and
// converts YBR); re-encoding display pixels would write a negative of every MONOCHROME1 image.
const REDACT_RAW_TS = new Set(['', '1.2.840.10008.1.2', '1.2.840.10008.1.2.1',
                               '1.2.840.10008.1.2.1.99', '1.2.840.10008.1.2.2']);
const REDACT_RLE_TS = '1.2.840.10008.1.2.5';
const REDACT_MAX_BYTES = 512 * 1024 * 1024;   // uncompressed pixels, all frames
const REDACT_JPEG_LOSSLESS_TS = new Set(['1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70']);
const REDACT_JPEG_BITMAP_TS = new Set(['1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51']);
const REDACT_J2K_TS = new Set(['1.2.840.10008.1.2.4.90', '1.2.840.10008.1.2.4.91']);
const REDACT_JPEG_LS_TS = new Set(['1.2.840.10008.1.2.4.80', '1.2.840.10008.1.2.4.81']);
// Syntaxes refused by name. To add a codec, remove its row here and handle it in decodeStoredFrames.
const REDACT_NO_CODEC = {
  '1.2.840.10008.1.2.4.201': 'High-Throughput JPEG 2000', '1.2.840.10008.1.2.4.202': 'High-Throughput JPEG 2000',
  '1.2.840.10008.1.2.4.100': 'MPEG-2', '1.2.840.10008.1.2.4.101': 'MPEG-2',
  '1.2.840.10008.1.2.4.102': 'MPEG-4 AVC/H.264', '1.2.840.10008.1.2.4.103': 'MPEG-4 AVC/H.264',
  '1.2.840.10008.1.2.4.104': 'MPEG-4 AVC/H.264', '1.2.840.10008.1.2.4.105': 'MPEG-4 AVC/H.264',
  '1.2.840.10008.1.2.4.106': 'MPEG-4 AVC/H.264', '1.2.840.10008.1.2.4.107': 'HEVC/H.265',
};

function metaTS(meta) {
  return String(meta?.['00020010']?.Value?.[0] ?? meta?.TransferSyntaxUID?.Value?.[0] ?? '').trim();
}

// Whether a pixel rewrite is possible, from the transfer syntax alone (so buttons can be disabled
// before decoding). `converts` = output is decompressed Explicit VR LE.
function redactionSupport(meta) {
  const ts = metaTS(meta);
  if (REDACT_RAW_TS.has(ts)) return { ok: true, ts, converts: false, depthLoss: false };
  // J2K and JPEG-LS (incl. lossy .91/.81) decode at full precision, so no depth loss.
  if (ts === REDACT_RLE_TS || REDACT_JPEG_LOSSLESS_TS.has(ts)
      || REDACT_J2K_TS.has(ts) || REDACT_JPEG_LS_TS.has(ts))
    return { ok: true, ts, converts: true, depthLoss: false };
  if (REDACT_JPEG_BITMAP_TS.has(ts)) return { ok: true, ts, converts: true, depthLoss: true };
  return { ok: false, ts, converts: false, depthLoss: false,
           codec: REDACT_NO_CODEC[ts] || ts || 'unknown transfer syntax' };
}

// Every frame's stored samples: interleaved little endian, except raw files keep their stored layout
// so they can be written straight back. Returns { frames, ... } or { error }.
async function decodeStoredFrames(d, meta) {
  const rows = lookupTag(d, '00280010')?.Value?.[0];
  const cols = lookupTag(d, '00280011')?.Value?.[0];
  const spp  = lookupTag(d, '00280002')?.Value?.[0] || 1;
  const pi   = String(lookupTag(d, '00280004')?.Value?.[0] || '').trim();
  const ba   = lookupTag(d, '00280100')?.Value?.[0] || 16;
  const bs   = lookupTag(d, '00280101')?.Value?.[0] || ba;
  const hb   = lookupTag(d, '00280102')?.Value?.[0] || bs - 1;
  const pr   = lookupTag(d, '00280103')?.Value?.[0] || 0;
  const planar = lookupTag(d, '00280006')?.Value?.[0] || 0;
  const numFrames = parseInt(lookupTag(d, '00280008')?.Value?.[0] || '1') || 1;
  if (!rows || !cols) return { error: 'This file has no Rows/Columns, so its stored pixels cannot be rewritten.' };
  // Only 8/16-bit samples can be rewritten.
  if (ba !== 8 && ba !== 16) return { error: `Bits Allocated ${ba} is not something this tool can rewrite.` };

  const px = lookupTag(d, '7fe00010');
  if (px && typeof px.InlineBinary === 'string' && !px.Value?.[0]) {
    try { px.Value = [b64ToAB(px.InlineBinary)]; } catch (_) {}
  }
  if (!px || !px.Value?.length) return { error: 'This file has no Pixel Data to rewrite.' };

  const ts = metaTS(meta);
  const framePixels = rows * cols;
  const bytesPerSample = Math.ceil(ba / 8);
  const frameBytes = framePixels * spp * bytesPerSample;
  // Cap memory: decompressed pixels are held several times over (buildEditedFile structuredClones).
  if (frameBytes * numFrames > REDACT_MAX_BYTES)
    return { error: `Rewriting this image would need ${Math.round(frameBytes * numFrames / (1024 * 1024))} MB of uncompressed pixels, more than this tool will hold in a browser tab.` };
  const asSamples = (buf) => ba === 16 ? new (pr ? Int16Array : Uint16Array)(buf) : new Uint8Array(buf);
  const base = { rows, cols, spp, ba, bs, hb, pr, pi, planar, numFrames, ts };

  // Raw
  if (REDACT_RAW_TS.has(ts)) {
    const bytes = new Uint8Array(concatBuffers(px.Value.map(v =>
      ArrayBuffer.isView(v) ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v)));
    if (ts === '1.2.840.10008.1.2.2' && ba === 16) {
      // dcmjs writes Explicit VR LE and ensureMeta relabels the syntax, so swap big-endian samples to match.
      for (let i = 0; i + 1 < bytes.length; i += 2) { const t = bytes[i]; bytes[i] = bytes[i + 1]; bytes[i + 1] = t; }
    }
    if (bytes.length < frameBytes * numFrames)
      return { error: `Pixel Data holds ${bytes.length} bytes, short of the ${frameBytes * numFrames} this header describes.` };
    const frames = [];
    for (let f = 0; f < numFrames; f++)
      frames.push(asSamples(bytes.buffer.slice(f * frameBytes, (f + 1) * frameBytes)));
    return { ...base, frames, raw: true, swapped: ts === '1.2.840.10008.1.2.2' && ba === 16 };
  }

  // Usually one fragment per frame; a single frame may also span several fragments, so join them.
  const frags = encapsulatedFragments(px);
  let perFrame = frags;
  if (numFrames === 1 && frags.length > 1) perFrame = [concatBuffers(frags)];
  if (perFrame.length < numFrames)
    return { error: `Pixel Data holds ${perFrame.length} fragment(s) for ${numFrames} frame(s).` };
  perFrame = perFrame.slice(0, numFrames);

  // RLE Lossless
  if (ts === REDACT_RLE_TS) {
    const frames = [];
    for (const frag of perFrame) {
      try { frames.push(asSamples(rleToRaw(frag, framePixels, spp, bytesPerSample))); }
      catch (e) { return { error: `RLE decode failed: ${e.message}` }; }
    }
    return { ...base, frames, planar: 0, raw: false };
  }

  // JPEG Lossless
  if (REDACT_JPEG_LOSSLESS_TS.has(ts)) {
    let Decoder;
    try { Decoder = await loadJpegLossless(); }
    catch (e) { return { error: `JPEG Lossless decoder unavailable: ${e.message}` }; }
    const frames = [];
    for (const frag of perFrame) {
      try {
        const o = new Decoder().decode(frag, 0, frag.byteLength, ba === 16 ? 2 : 1);
        frames.push(asSamples(o.buffer.slice(o.byteOffset, o.byteOffset + o.byteLength)));
      } catch (e) { return { error: `JPEG Lossless decode failed: ${e.message}` }; }
    }
    return { ...base, frames, planar: 0, raw: false };
  }

  // JPEG 2000 / JPEG-LS: full precision and sign kept. OpenJPEG undoes the YBR_RCT/ICT transform,
  // so colour J2K is written back as RGB.
  if (REDACT_J2K_TS.has(ts) || REDACT_JPEG_LS_TS.has(ts)) {
    const kind = REDACT_J2K_TS.has(ts) ? 'j2k' : 'jls';
    const label = T(kind === 'j2k' ? 'JPEG 2000 decode failed' : 'JPEG-LS decode failed');
    const frames = [];
    for (const frag of perFrame) {
      let dec;
      try { dec = await wasmDecodeFrame(kind, frag); }
      catch (e) { return { error: `${label}: ${e.message}` }; }
      const bad = codecFrameMismatch(dec.info, dec.bytes, rows, cols, ba, spp);
      if (bad) return { error: `${label}: ${bad}` };
      let bytes = dec.bytes;
      if (dec.planar === 1 && spp === 3) {
        // applyRedaction writes (0028,0006) = 0, so re-interleave CharLS planar output.
        const src = asSamples(bytes), out = new (src.constructor)(src.length);
        for (let c = 0; c < 3; c++)
          for (let i = 0; i < framePixels; i++) out[i * 3 + c] = src[c * framePixels + i];
        bytes = out.buffer;
      }
      frames.push(asSamples(bytes));
    }
    return { ...base, frames, planar: 0, raw: false,
             pi: (kind === 'j2k' && spp === 3) ? 'RGB' : pi };
  }

  // Baseline / extended JPEG: browser decode is 8-bit only, so 12-bit data loses depth across the
  // whole image (depthLoss; the caller must warn). No MONOCHROME1 inversion: these are stored values.
  if (REDACT_JPEG_BITMAP_TS.has(ts)) {
    const frames = [];
    for (const frag of perFrame) {
      let img;
      try {
        const bitmap = await createImageBitmap(new Blob([frag], { type: 'image/jpeg' }));
        const c = document.createElement('canvas');
        c.width = bitmap.width; c.height = bitmap.height;
        const cx = c.getContext('2d');
        if (!cx) { bitmap.close(); return { error: 'Canvas 2D context unavailable' }; }
        cx.drawImage(bitmap, 0, 0);
        bitmap.close();
        if (c.width !== cols || c.height !== rows)
          return { error: `The JPEG is ${c.width}x${c.height} but the header says ${cols}x${rows}.` };
        img = cx.getImageData(0, 0, c.width, c.height).data;
      } catch (e) { return { error: `JPEG decode failed: ${e.message}` }; }
      const o = new Uint8Array(framePixels * (spp === 3 ? 3 : 1));
      if (spp === 3) for (let i = 0; i < framePixels; i++) { o[i*3] = img[i*4]; o[i*3+1] = img[i*4+1]; o[i*3+2] = img[i*4+2]; }
      else for (let i = 0; i < framePixels; i++) o[i] = img[i * 4];
      frames.push(o);
    }
    // The browser converted YBR to RGB, so the written photometric interpretation must say RGB.
    return { ...base, frames, ba: 8, bs: 8, hb: 7, pr: 0, planar: 0, raw: false,
             pi: spp === 3 ? 'RGB' : pi, depthLoss: true, bitmap: true };
  }

  const codec = REDACT_NO_CODEC[ts] || ts || 'unknown transfer syntax';
  return { error: T('This image cannot be redacted: its pixel data uses a compression this browser cannot decode.') + ` (${codec})` };
}

// ---- Display decoder ----
// One frame as display RGBA. opts: { meta, wcOvr, wwOvr }.
// Returns {pixels, rows, cols, numFrames, ...}, {error, numFrames}, or null.
async function decodeDicomPixels(d, frameIndex = 0, { meta = null, wcOvr, wwOvr } = {}) {
  const rows = lookupTag(d, '00280010')?.Value?.[0];
  const cols = lookupTag(d, '00280011')?.Value?.[0];
  const spp  = lookupTag(d, '00280002')?.Value?.[0] || 1;
  const pi   = lookupTag(d, '00280004')?.Value?.[0];
  const ba   = lookupTag(d, '00280100')?.Value?.[0] || 16;
  const bs   = lookupTag(d, '00280101')?.Value?.[0] || ba;
  const hb   = lookupTag(d, '00280102')?.Value?.[0] || bs - 1;
  const pr   = lookupTag(d, '00280103')?.Value?.[0] || 0;
  const pc   = lookupTag(d, '00280006')?.Value?.[0] || 0;
  const wc   = lookupTag(d, '00281050')?.Value?.[0];
  const ww   = lookupTag(d, '00281051')?.Value?.[0];
  const numFrames = parseInt(lookupTag(d, '00280008')?.Value?.[0] || '1') || 1;

  // Rescale Slope/Intercept to output units (e.g. HU) before windowing, since Window Center/Width
  // are in those units. Done only here so every view agrees.
  const slopeTag = parseFloat(lookupTag(d, '00281053')?.Value?.[0]);
  const interTag = parseFloat(lookupTag(d, '00281052')?.Value?.[0]);
  const slope = isFinite(slopeTag) ? slopeTag : 1;
  const inter = isFinite(interTag) ? interTag : 0;

  const isMono1 = /^MONOCHROME1$/i.test(pi || '');
  const isMonochrome = /^MONOCHROME[12]$/i.test(pi || '');
  const isPalette = /^PALETTE\s*COLOR$/i.test(pi || '');
  // Which YBR variants can be converted depends on the transfer syntax; decided below.
  const isYBR = /^YBR_/i.test(pi || '') && spp === 3;
  const isRGB = (/^RGB$/i.test(pi || '') && spp === 3) || isYBR;
  if (!rows || !cols || (!isMonochrome && !isRGB && !isPalette)) return null;

  const px = lookupTag(d, '7fe00010');
  if (!px) return null;
  if (typeof px.InlineBinary === 'string' && !px.Value?.[0]) {
    try { px.Value = [b64ToAB(px.InlineBinary)]; } catch (e) {}
  }
  if (!px.Value?.length) return null;

  const fi = Math.max(0, Math.min(frameIndex, numFrames - 1));
  const framePixels = rows * cols;
  const bytesPerPixel = Math.ceil(ba / 8) * spp;
  const frameByteSize = framePixels * bytesPerPixel;

  // dcmjs may key the transfer syntax as camelCase or plain hex
  const tsEl = meta?.['00020010'] ?? meta?.TransferSyntaxUID;
  const ts = (tsEl?.Value?.[0] ?? '').trim();

  const UNCOMPRESSED_TS = new Set([
    '', '1.2.840.10008.1.2', '1.2.840.10008.1.2.1',
    '1.2.840.10008.1.2.1.99', '1.2.840.10008.1.2.2',
  ]);
  // JPEG Lossless shares baseline JPEG's SOI marker but needs its own decoder
  const JPEG_LOSSLESS_TS = new Set([
    '1.2.840.10008.1.2.4.57',  // JPEG Lossless, Non-Hierarchical
    '1.2.840.10008.1.2.4.70',  // JPEG Lossless, Non-Hierarchical, First-Order Prediction (most common)
  ]);
  const JPEG_LS_TS = new Set([
    '1.2.840.10008.1.2.4.80',  // JPEG-LS Lossless
    '1.2.840.10008.1.2.4.81',  // JPEG-LS Near-Lossless
  ]);
  const RLE_TS = '1.2.840.10008.1.2.5';
  const isRawTS = UNCOMPRESSED_TS.has(ts);
  const isJ2kTS = ts === '1.2.840.10008.1.2.4.90' || ts === '1.2.840.10008.1.2.4.91';
  // HTJ2K (Part 15) shares J2K's magic but OpenJPEG 2.x can't decode it; refuse it by name.
  const isHtj2kTS = ts === '1.2.840.10008.1.2.4.201' || ts === '1.2.840.10008.1.2.4.202';

  // Scan for encapsulated frames only when compressed: raw data starting 0xFF 0xD8 would look like JPEG.
  const { jpeg: jpegFrames, j2k: j2kFrames } = !isRawTS
    ? collectEncapsulatedFrames(px)
    : { jpeg: [], j2k: [] };

  // Regular <canvas>, not OffscreenCanvas (throws "object no longer usable" in Firefox).
  async function bitmapToPixels(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close(); throw new Error('Canvas 2D context unavailable'); }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return { imgData: ctx.getImageData(0, 0, canvas.width, canvas.height), w: canvas.width, h: canvas.height };
  }

  // Browser-decoded bitmaps are already RGB; only MONOCHROME1 inversion remains.
  function fromBitmap({ imgData, w, h }) {
    const out = new Uint8ClampedArray(imgData.data.buffer.slice(0));
    if (isMono1) {
      for (let i = 0; i < out.length; i += 4) {
        out[i] = 255 - out[i]; out[i + 1] = 255 - out[i + 1]; out[i + 2] = 255 - out[i + 2];
      }
    }
    return { pixels: out, rows: h, cols: w, numFrames };
  }

  // Monochrome windowing. rawFloats are rescaled output units (same scale as the WL sliders) and are
  // returned for caching: { pixels, rawFloats, mn, mx }.
  function applyMonochromeWindowing(data) {
    const mask  = bs < 16 ? (1 << bs) - 1 : 0xFFFF;
    const shift = hb - bs + 1;
    const raw   = new Float32Array(framePixels);
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < framePixels; i++) {
      let v = data[i];
      if (ba === 16) {
        if (pr) {
          // Int16Array is already signed: shift arithmetically, and re-sign only when bs < 16
          // (at bs 16 it would sign-extend twice).
          if (shift > 0) v >>= shift;
          if (bs < 16) {
            v &= mask;
            const sb = 1 << (bs - 1);
            if (v & sb) v -= sb << 1;
          }
        } else {
          v >>>= 0;
          if (shift > 0) v >>>= shift;
          if (bs < 16) v &= mask;
        }
      }
      if (slope !== 1 || inter !== 0) v = v * slope + inter;
      raw[i] = v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const pixels = applyWindowToFloats(raw, framePixels, wcOvr ?? wc, wwOvr ?? ww, mn, mx, isMono1);
    return { pixels, rawFloats: raw, mn, mx };
  }

  // Codecs that yield raw-layout bytes set this and continue through the shared uncompressed path.
  let preDecoded = null;
  // preDecodedRGB: codec already did the colour transform. preDecodedPlanar: codec's sample layout,
  // which overrides (0028,0006).
  let preDecodedRGB = false;
  let preDecodedPlanar = null;

  if (jpegFrames.length) {
    // A single frame split across fragments: only the first has SOI, so join them all.
    const allFrags = encapsulatedFragments(px);
    const buf = (numFrames === 1 && allFrags.length > jpegFrames.length)
      ? concatBuffers(allFrags)
      : jpegFrames[Math.min(fi, jpegFrames.length - 1)];

    // JPEG Lossless (1.2.840.10008.1.2.4.57 / .70)
    if (JPEG_LOSSLESS_TS.has(ts)) {
      try {
        const LosslessDecoder = await loadJpegLossless();
        const decoder = new LosslessDecoder();
        // Output is interleaved raw samples, so route it through the raw path (handles colour too).
        const decoded = decoder.decode(buf, 0, buf.byteLength, ba === 16 ? 2 : 1);
        preDecoded = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
      } catch (e) {
        return { error: `JPEG Lossless decode failed: ${e.message}`, numFrames };
      }
    } else if (JPEG_LS_TS.has(ts)) {

      // JPEG-LS (1.2.840.10008.1.2.4.80 / .81). Its FF D8 FF F7 start put it in jpegFrames.
      const label = T('JPEG-LS decode failed');
      let dec;
      try { dec = await wasmDecodeFrame('jls', buf); }
      catch (e) { return { error: `${label}: ${e.message}`, numFrames }; }
      const bad = codecFrameMismatch(dec.info, dec.bytes, rows, cols, ba, spp);
      if (bad) return { error: `${label}: ${bad}`, numFrames };
      preDecoded = dec.bytes;
      preDecodedPlanar = dec.planar;

    } else {

      // Baseline / extended JPEG: browser-native decode
      try {
        return fromBitmap(await bitmapToPixels(new Blob([buf], { type: 'image/jpeg' })));
      } catch (e) {
        return { error: `JPEG decode failed: ${e.message}`, numFrames };
      }
    }
  }

  // Before the J2K branch: HTJ2K has the same FF 4F FF 51 magic and is already in j2kFrames.
  if (isHtj2kTS) {
    return { error: T('High-Throughput JPEG 2000 (1.2.840.10008.1.2.4.201/202) is not supported'), numFrames };
  }

  if (j2kFrames.length || isJ2kTS) {
    const label = T('JPEG 2000 decode failed');
    // Same split-frame rule as JPEG (only the first fragment has SOC).
    const allFrags = encapsulatedFragments(px);
    const buf = (numFrames === 1 && allFrags.length > j2kFrames.length)
      ? concatBuffers(allFrags)
      : j2kFrames[Math.min(fi, j2kFrames.length - 1)];
    if (!buf) return { error: `${label}: no pixel fragment for this frame`, numFrames };
    let dec;
    try { dec = await wasmDecodeFrame('j2k', buf); }
    catch (e) { return { error: `${label}: ${e.message}`, numFrames }; }
    const bad = codecFrameMismatch(dec.info, dec.bytes, rows, cols, ba, spp);
    if (bad) return { error: `${label}: ${bad}`, numFrames };
    preDecoded = dec.bytes;
    // OpenJPEG undoes YBR_RCT/YBR_ICT and returns interleaved RGB.
    preDecodedRGB = dec.info.componentCount === 3;
    preDecodedPlanar = 0;
  }

  // RLE Lossless: decoded to raw layout, then shares the uncompressed path.
  if (ts === RLE_TS) {
    const frags = encapsulatedFragments(px);
    const frag = frags[Math.min(fi, frags.length - 1)];
    if (!frag) return { error: 'RLE Lossless: no pixel fragment for this frame', numFrames };
    try {
      preDecoded = rleToRaw(frag, framePixels, spp, Math.ceil(ba / 8));
    } catch (e) {
      return { error: `RLE decode failed: ${e.message}`, numFrames };
    }
  }

  // Raw (uncompressed) pixel data
  const isBigEndian = ts === '1.2.840.10008.1.2.2';

  let pxBuf = preDecoded || px.Value[0];
  if (ArrayBuffer.isView(pxBuf)) pxBuf = pxBuf.buffer.slice(pxBuf.byteOffset, pxBuf.byteOffset + pxBuf.byteLength);
  if (!(pxBuf instanceof ArrayBuffer)) return null;

  if (!preDecoded && numFrames > 1 && fi > 0 && px.Value.length === 1) {
    pxBuf = pxBuf.slice(fi * frameByteSize, (fi + 1) * frameByteSize);
  }

  // Mislabelled transfer syntax: probe for an undeclared JPEG
  if (!isRawTS && !preDecoded && pxBuf.byteLength >= 4) {
    const probe = new Uint8Array(pxBuf, 0, 4);
    if (probe[0] === 0xFF && probe[1] === 0xD8) {
      try {
        return fromBitmap(await bitmapToPixels(new Blob([pxBuf], { type: 'image/jpeg' })));
      } catch (_) {}
    }
    // Undeclared J2K/JP2: report it rather than guess at a file that misstates its encoding.
    if ((probe[0] === 0xFF && probe[1] === 0x4F) || (probe[0] === 0x00 && probe[1] === 0x00 && probe[2] === 0x00 && probe[3] === 0x0C)) {
      return { error: `${ts || 'This file'} contains a JPEG 2000 codestream its transfer syntax does not declare`, numFrames };
    }
  }

  // Compressed and not decoded: report unsupported rather than draw noise. Exception: a buffer of exactly
  // raw size means the syntax is mislabelled and the data is raw.
  if (!isRawTS && !preDecoded &&
      pxBuf.byteLength !== frameByteSize && pxBuf.byteLength !== frameByteSize * numFrames) {
    return { error: `${ts || 'This'} is a compressed transfer syntax this viewer cannot decode`, numFrames };
  }

  if (isBigEndian && ba === 16) {
    const src = new Uint8Array(pxBuf);
    const dst = new Uint8Array(src.length);
    for (let i = 0; i + 1 < src.length; i += 2) { dst[i] = src[i + 1]; dst[i + 1] = src[i]; }
    pxBuf = dst.buffer;
  }

  // PALETTE COLOR: one index per pixel into three LUTs
  if (isPalette) {
    const r = readPaletteLut(d, '00281101', '00281201', isBigEndian);
    const g = readPaletteLut(d, '00281102', '00281202', isBigEndian);
    const b = readPaletteLut(d, '00281103', '00281203', isBigEndian);
    if (!r || !g || !b) return { error: 'PALETTE COLOR without a readable lookup table', numFrames };
    const idx = ba === 16 ? new Uint16Array(pxBuf) : new Uint8Array(pxBuf);
    const out = new Uint8ClampedArray(framePixels * 4);
    // Out-of-range indices clamp to the first/last entry (PS3.3 C.7.6.3.1.5).
    const pick = (t, v) => { const i = v - t.first; return t.lut[i < 0 ? 0 : i >= t.count ? t.count - 1 : i]; };
    for (let i = 0; i < framePixels; i++) {
      const v = idx[i], p = i * 4;
      out[p] = pick(r, v); out[p+1] = pick(g, v); out[p+2] = pick(b, v); out[p+3] = 255;
    }
    return { pixels: out, rows, cols, numFrames };
  }

  if (isRGB) {
    // Raw subsampled YBR needs chroma upsampling (unsupported); codec-converted RGB passes.
    if (isYBR && !preDecodedRGB && !/^YBR_FULL$/i.test(pi)) {
      return { error: `${pi} is only supported inside a compressed transfer syntax`, numFrames };
    }
    const raw = new Uint8Array(pxBuf);
    const out = new Uint8ClampedArray(framePixels * 4);
    // Don't convert YBR_FULL twice if the codec already did.
    const ycc = /^YBR_FULL$/i.test(pi) && !preDecodedRGB;
    // ?? not ||: a codec's 0 (interleaved) must override the file's Planar Configuration 1.
    const pcEff = preDecodedPlanar ?? pc;
    for (let i = 0; i < framePixels; i++) {
      // Planar Configuration 1 = one whole plane per channel.
      const s0 = pcEff === 1 ? raw[i]                  : raw[i * 3];
      const s1 = pcEff === 1 ? raw[framePixels + i]    : raw[i * 3 + 1];
      const s2 = pcEff === 1 ? raw[framePixels * 2 + i] : raw[i * 3 + 2];
      const p = i * 4;
      if (ycc) {
        // Full-range YCbCr to RGB (PS3.3 C.7.6.3.1.2); Uint8ClampedArray clips.
        const cb = s1 - 128, cr = s2 - 128;
        out[p]     = s0 + 1.402 * cr;
        out[p + 1] = s0 - 0.344136 * cb - 0.714136 * cr;
        out[p + 2] = s0 + 1.772 * cb;
      } else {
        out[p] = s0; out[p + 1] = s1; out[p + 2] = s2;
      }
      out[p + 3] = 255;
    }
    return { pixels: out, rows, cols, numFrames };
  }

  const data = ba === 16 ? new (pr ? Int16Array : Uint16Array)(pxBuf) :
               ba === 8  ? new Uint8Array(pxBuf) : null;
  if (!data) return null;

  const { pixels, rawFloats, mn, mx } = applyMonochromeWindowing(data);
  return { pixels, rawFloats, mn, mx, wcTag: wc, wwTag: ww, invert: isMono1, rows, cols, numFrames };
}

function showPreviewError(msg, numFrames, frameIndex) {
  previewCanvas.width = 260; previewCanvas.height = 70;
  const ctx = previewCanvas.getContext('2d');
  ctx.fillStyle = '#080808';
  ctx.fillRect(0, 0, 260, 70);
  ctx.fillStyle = '#f87171';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(msg, 130, 38);
  previewCard.style.display = 'flex';
  syncImgEditCard?.();
  previewImageData = null;
  totalFrames = numFrames || 1;
  if (numFrames > 1) {
    frameNav.classList.remove('hidden');
    frameSlider.max = numFrames - 1;
    frameSlider.value = frameIndex;
    frameLabel.textContent = `${frameIndex + 1}/${numFrames}`;
  } else {
    frameNav.classList.add('hidden');
  }
}

// ---- Canvas, W/L cache, fullscreen ----
// Raw pixel cache so W/L sliders re-window without re-decoding
let previewRawData = null;

function _paintPixels(pixels, rows, cols) {
  previewCanvas.width = cols;
  previewCanvas.height = rows;
  const ctx = previewCanvas.getContext('2d');
  const imgData = ctx.createImageData(cols, rows);
  imgData.data.set(pixels);
  ctx.putImageData(imgData, 0, 0);
  previewImageData = { width: cols, height: rows, data: imgData };
}

// Synchronous W/L redraw from the cache
function redrawWL(wcOvr, wwOvr) {
  if (!previewRawData) return false;
  const { rawFloats, rows, cols, mn, mx, wcTag, wwTag, invert } = previewRawData;
  const pixels = applyWindowToFloats(
    rawFloats, rows * cols,
    wcOvr ?? wcTag, wwOvr ?? wwTag,
    mn, mx, invert
  );
  _paintPixels(pixels, rows, cols);
  return true;
}

async function drawPreview(d, frameIndex = 0) {
  const wcPending = pendingEdits.get(editKey('00281050'));
  const wwPending = pendingEdits.get(editKey('00281051'));
  const wcOvr = wcPending ? parseFloat(wcPending.valueString) : undefined;
  const wwOvr = wwPending ? parseFloat(wwPending.valueString) : undefined;

  const result = await decodeDicomPixels(d, frameIndex, { meta, wcOvr, wwOvr });
  if (!result) {
    previewCard.style.display = 'none';
    syncImgEditCard?.();
    frameNav.classList.add('hidden');
    previewRawData = null;
    return;
  }
  if (result.error) {
    showPreviewError(result.error, result.numFrames, frameIndex);
    previewRawData = null;
    return;
  }
  const { pixels, rows, cols, numFrames } = result;

  if (result.rawFloats) {
    previewRawData = {
      rawFloats: result.rawFloats,
      rows, cols,
      mn: result.mn, mx: result.mx,
      wcTag: result.wcTag, wwTag: result.wwTag,
      invert: result.invert,
    };
  } else {
    previewRawData = null; // RGB / JPEG bitmap — no WL cache possible
  }

  _paintPixels(pixels, rows, cols);
  previewCard.style.display = 'flex';
  syncImgEditCard?.();
  initWLSliders?.();   // safe to call here — pixel data confirmed, dict in scope

  totalFrames = numFrames;
  if (numFrames > 1) {
    frameNav.classList.remove('hidden');
    frameSlider.max = numFrames - 1;
    frameSlider.value = frameIndex;
    frameLabel.textContent = `${frameIndex + 1}/${numFrames}`;
  } else {
    frameNav.classList.add('hidden');
  }
}

// The overlay doubles as the redaction workspace; while active it owns the canvas, so these refuse
// (enlarging would repaint over the boxes). Cancel/Esc exit the workspace.
function showFullscreen() {
  if (!previewImageData || redactUI.active) return;
  fullscreenCanvas.width = previewImageData.width;
  fullscreenCanvas.height = previewImageData.height;
  const ctx = fullscreenCanvas.getContext('2d');
  ctx.putImageData(previewImageData.data, 0, 0);
  fullscreenOverlay.classList.add('visible');
}

function hideFullscreen() {
  if (redactUI.active) return;
  fullscreenOverlay.classList.remove('visible');
}

