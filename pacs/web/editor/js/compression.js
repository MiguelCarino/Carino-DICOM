// Compression: what a file's Pixel Data is encoded with, whether that encoding lost anything, what
// can go wrong in other viewers, and a way back to plain uncompressed pixels (Explicit VR LE).
//
// Lossless is judged from three places, strongest first: the codestream itself (JPEG-LS NEAR,
// JPEG Lossless point transform, JPEG 2000 wavelet), the transfer syntax (PS3.5 Table A-1), and the Lossy Image Compression flag
// (0028,2110), which records that the pixels were EVER lossy-compressed (PS3.3 C.7.6.1.1.5), even
// if this copy is stored losslessly.

// kind: 'none' uncompressed, 'deflate' whole dataset zipped (pixels exact), 'lossless', 'lossy',
// 'either' (the codestream decides), 'video' (lossy, frames are not separable), 'referenced'
// (JPIP: the pixels live on a server, not in the file), 'private' (a vendor syntax, not in PS3.5).
const TS_COMPRESSION = {
  '1.2.840.10008.1.2':        ['Implicit VR Little Endian', 'none'],
  '1.2.840.10008.1.2.1':      ['Explicit VR Little Endian', 'none'],
  '1.2.840.10008.1.2.2':      ['Explicit VR Big Endian', 'none'],
  '1.2.840.10008.1.2.1.99':   ['Deflated Explicit VR Little Endian', 'deflate'],
  '1.2.840.10008.1.2.5':      ['RLE Lossless', 'lossless'],
  '1.2.840.10008.1.2.4.50':   ['JPEG Baseline', 'lossy'],
  '1.2.840.10008.1.2.4.51':   ['JPEG Extended', 'lossy'],
  '1.2.840.10008.1.2.4.57':   ['JPEG Lossless', 'lossless'],
  '1.2.840.10008.1.2.4.70':   ['JPEG Lossless SV1', 'lossless'],
  '1.2.840.10008.1.2.4.80':   ['JPEG-LS Lossless', 'lossless'],
  '1.2.840.10008.1.2.4.81':   ['JPEG-LS Near-Lossless', 'either'],
  '1.2.840.10008.1.2.4.90':   ['JPEG 2000 Lossless', 'lossless'],
  '1.2.840.10008.1.2.4.91':   ['JPEG 2000', 'either'],
  '1.2.840.10008.1.2.4.92':   ['JPEG 2000 Multi-component Lossless', 'lossless'],
  '1.2.840.10008.1.2.4.93':   ['JPEG 2000 Multi-component', 'either'],
  '1.2.840.10008.1.2.4.201':  ['HTJ2K Lossless', 'lossless'],
  '1.2.840.10008.1.2.4.202':  ['HTJ2K Lossless RPCL', 'lossless'],
  '1.2.840.10008.1.2.4.203':  ['HTJ2K', 'either'],
  '1.2.840.10008.1.2.1.98':   ['Encapsulated Uncompressed Explicit VR Little Endian', 'none'],
  '1.2.840.10008.1.2.8.1':    ['Deflated Image Frame Compression', 'lossless'],
  // JPEG XL (Sup 232). .111 losslessly repacks a JPEG: exact to that JPEG, which was itself lossy.
  '1.2.840.10008.1.2.4.110':  ['JPEG XL Lossless', 'lossless'],
  '1.2.840.10008.1.2.4.111':  ['JPEG XL JPEG Recompression', 'lossy'],
  '1.2.840.10008.1.2.4.112':  ['JPEG XL', 'either'],
  '1.2.840.10008.1.2.4.94':   ['JPIP Referenced', 'referenced'],
  '1.2.840.10008.1.2.4.95':   ['JPIP Referenced Deflate', 'referenced'],
  '1.2.840.10008.1.2.4.204':  ['JPIP HTJ2K Referenced', 'referenced'],
  '1.2.840.10008.1.2.4.205':  ['JPIP HTJ2K Referenced Deflate', 'referenced'],
  // Big-endian pixel data behind an implicit little-endian header (GE Signa/LightSpeed era).
  '1.2.840.113619.5.2':       ['GE Private Implicit VR Big Endian', 'private'],
};
for (const ts of ['100', '100.1', '101', '101.1', '102', '102.1', '103', '103.1', '104', '104.1',
                  '105', '105.1', '106', '106.1', '107', '108'])
  TS_COMPRESSION['1.2.840.10008.1.2.4.' + ts] = ['MPEG / H.264 / HEVC video', 'video'];
// Retired JPEG processes (PS3.5 Table A-1, retired): DCT ones are lossy, process 15 is lossless,
// hierarchical ones may end on a lossless stage.
for (const ts of ['52', '53', '54', '55', '56'])
  TS_COMPRESSION['1.2.840.10008.1.2.4.' + ts] = ['JPEG (retired process)', 'lossy'];
TS_COMPRESSION['1.2.840.10008.1.2.4.58'] = ['JPEG Lossless, arithmetic (retired)', 'lossless'];
for (const ts of ['59', '60', '61', '62', '63', '64', '65', '66'])
  TS_COMPRESSION['1.2.840.10008.1.2.4.' + ts] = ['JPEG Hierarchical (retired)', 'either'];
// Syntaxes whose detail is in a JPEG Lossless SOS header (point transform).
const JPEG_LOSSLESS_TS = new Set(['1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.58', '1.2.840.10008.1.2.4.70']);

// (0028,2114) Lossy Image Compression Method defined terms (PS3.3 C.7.6.1.1.5.1).
const LOSSY_METHOD = { jls: 'ISO_14495_1', j2k: 'ISO_15444_1', jpeg: 'ISO_10918_1' };

// JPEG-LS (ISO 14495-1): SOF55 gives precision, SOS carries NEAR (0 = lossless).
function jlsHeader(buf) {
  const b = new Uint8Array(buf), out = {};
  for (let i = 2; i + 4 <= b.length;) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xD8 || m === 0x01 || m === 0xFF || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3], s = i + 4;
    if (m === 0xF7) out.precision = b[s];
    if (m === 0xDA) { const ns = b[s]; out.near = b[s + 1 + 2 * ns]; return out; }
    i += 2 + len;
  }
  return out;
}

// JPEG Lossless (ISO 10918-1 H.1.2): the SOS Al nibble is the point transform. Pt > 0 means the
// encoder dropped the Pt lowest bits of every sample, so the stream is lossy whatever the syntax says.
function jpegLosslessHeader(buf) {
  const b = new Uint8Array(buf), out = {};
  for (let i = 2; i + 4 <= b.length;) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xD8 || m === 0x01 || m === 0xFF || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3], s = i + 4;
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) out.precision = b[s];
    if (m === 0xDA) { const ns = b[s]; out.pt = b[s + 3 + 2 * ns] & 0x0F; out.predictor = b[s + 1 + 2 * ns]; return out; }
    i += 2 + len;
  }
  return out;
}

// JPEG 2000 (ISO 15444-1 A.5.1, A.6.1): SIZ's first Ssiz byte gives the samples' sign (bit 7) and
// depth; the COD marker's last SPcod byte is the wavelet, 0 = 9-7 irreversible (lossy),
// 1 = 5-3 reversible (lossless unless the encoder dropped layers).
function j2kHeader(buf) {
  const b = new Uint8Array(buf), out = {};
  let i = 0;
  while (i + 1 < b.length && !(b[i] === 0xFF && b[i + 1] === 0x4F)) i++;   // SOC, past any JP2 boxes
  for (i += 2; i + 4 <= b.length;) {
    if (b[i] !== 0xFF) return out;
    const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0x51 && i + 40 < b.length) {                       // Rsiz, 8 x 32-bit sizes, Csiz, then Ssiz
      out.signed = (b[i + 40] & 0x80) !== 0;
      out.precision = (b[i + 40] & 0x7F) + 1;
    }
    if (m === 0x52) { out.reversible = b[i + 4 + 9] === 1; return out; }   // Scod, SGcod(4), levels, cbw, cbh, cbstyle, transform
    if (m === 0x90 || m === 0x93) return out;                    // SOT/SOD: main header ended without COD
    i += 2 + len;
  }
  return out;
}

// Modalities whose original pixels always carry more than 8 bits (Hounsfield units, MR signal,
// counts, detector values): an 8-bit copy of one is a rendered picture of it, not the measured
// values. XA, RF, NM, IO and US are left out: their originals are often 8-bit.
const DEEP_MODALITIES = new Set(['CT', 'MR', 'PT', 'MG', 'CR', 'DX']);
const SC_SOP_PREFIX = '1.2.840.10008.5.1.4.1.1.7';

// Describe a file's pixel encoding. Synchronous: reads headers and the first codestream only.
function compressionInfo(entry) {
  const d = entry?.dict || {};
  const ts = metaTS(entry?.meta);
  // A UID outside the DICOM root is a vendor's own syntax, whatever it holds.
  const [name, kind] = TS_COMPRESSION[ts]
    || (ts && !ts.startsWith('1.2.840.10008.') ? [`Private transfer syntax`, 'private'] : [ts || 'unknown', 'unknown']);
  const px = lookupTag(d, '7fe00010');
  const pm = readPixelModuleAttrs(d);
  const info = { ts, name, kind, hasPixels: !!px, compressed: !['none', 'deflate', 'referenced', 'private'].includes(kind),
                 lossless: null, why: [], warnings: [], ratio: null, storedBytes: 0, rawBytes: 0,
                 everLossy: String(lookupTag(d, '00282110')?.Value?.[0] ?? '').trim() === '01' };
  if (kind === 'referenced')
    info.why.push(T('JPIP referenced: the pixels are not in this file, only a link to them on a server ((0028,7FE0) Pixel Data Provider URL). Without that server there is no image.'));
  if (kind === 'private') {
    info.why.push(T('Private transfer syntax: a vendor encoding outside the DICOM standard. Most viewers cannot read its pixels, or read them wrongly.'));
    if (ts === '1.2.840.113619.5.2')
      info.warnings.push(T('GE private syntax: the header is little-endian but the pixel bytes are big-endian. Viewers that miss this show noise instead of the image.'));
  }
  rendered(info, d, pm, entry);
  if (!px) return info;

  info.rawBytes = (pm.rows || 0) * (pm.cols || 0) * pm.spp * Math.ceil(pm.ba / 8) * pm.numFrames;
  const frags = info.compressed ? encapsulatedFragments(px) : [];
  info.storedBytes = info.compressed ? frags.reduce((n, f) => n + f.byteLength, 0) : info.rawBytes;
  if (info.compressed && info.storedBytes && info.rawBytes) info.ratio = info.rawBytes / info.storedBytes;

  const first = frags[0];
  if (kind === 'private' || kind === 'referenced') {
    // Said above; nothing in the bytes is ours to judge.
  } else if (first && JPEG_LOSSLESS_TS.has(ts)) {
    const h = jpegLosslessHeader(first);
    if (h.pt > 0) {
      info.lossless = false;
      info.why.push(T('JPEG Lossless with point transform Pt = {n}: the encoder dropped the {n} lowest bits of every value, so it is lossy despite its name.').replaceAll('{n}', h.pt));
    } else {
      info.lossless = true;
      info.why.push(T('The transfer syntax only allows lossless compression: decoding gives back every value exactly.'));
    }
  } else if (ts === '1.2.840.10008.1.2.4.111') {
    info.lossless = false;
    info.why.push(T('JPEG XL repacking of a JPEG: exact to that JPEG, but the JPEG itself was lossy.'));
  } else if (kind === 'none' || kind === 'deflate') {
    info.lossless = true;
    info.why.push(T('Stored uncompressed: the pixel values are exactly what was written.'));
  } else if (kind === 'lossless') {
    info.lossless = true;
    info.why.push(T('The transfer syntax only allows lossless compression: decoding gives back every value exactly.'));
  } else if (kind === 'lossy' || kind === 'video') {
    info.lossless = false;
    info.why.push(T('The transfer syntax is lossy: some detail was discarded and cannot be recovered.'));
  } else if (first && ts.startsWith('1.2.840.10008.1.2.4.8')) {
    const h = jlsHeader(first);
    if (h.near === 0) { info.lossless = true; info.why.push(T('JPEG-LS with NEAR = 0 in the codestream: lossless.')); }
    else if (h.near > 0) { info.lossless = false; info.why.push(`${T('JPEG-LS with NEAR =')} ${h.near}: ${T('each value may be off by up to that much.')}`); }
  } else if (first && /^1\.2\.840\.10008\.1\.2\.4\.(9[0-3]|20[1-3])$/.test(ts)) {
    const h = j2kHeader(first);
    if (h.reversible === true) { info.lossless = true; info.why.push(T('JPEG 2000 with the reversible 5/3 wavelet: lossless, unless the encoder truncated quality layers.')); }
    else if (h.reversible === false) { info.lossless = false; info.why.push(T('JPEG 2000 with the irreversible 9/7 wavelet: lossy.')); }
  }
  if (info.lossless === null && info.compressed) info.why.push(T('The codestream does not say whether it is lossless.'));
  if (info.everLossy) info.why.push(T('(0028,2110) Lossy Image Compression = 01: these pixels were lossy-compressed at some point, even if stored losslessly now.'));

  // What makes the same pixels look different from one viewer to the next.
  const mono = /^MONOCHROME/i.test(String(pm.pi || '').trim());
  if (info.compressed && pm.pr === 1)
    info.warnings.push(T('Signed pixel values in compressed form: some viewers decode them as positive numbers, so negative values (such as CT padding outside the scan circle) become the brightest: a white surround, and a washed-out image when the viewer sets contrast automatically. Decompressing gives every viewer the values directly.'));
  // J2K records signedness itself; when it disagrees with (0028,0103) decoders differ on which to believe.
  if (first && /^1\.2\.840\.10008\.1\.2\.4\.(9[0-3]|20[1-3])$/.test(ts)) {
    const h = j2kHeader(first);
    if (h.signed !== undefined && h.signed !== (pm.pr === 1))
      info.warnings.push((h.signed
        ? T('The JPEG 2000 codestream says the samples are signed, but Pixel Representation (0028,0103) says unsigned.')
        : T('The JPEG 2000 codestream says the samples are unsigned, but Pixel Representation (0028,0103) says signed.'))
        + ' ' + T('Viewers disagree on which to trust, so dark and bright areas can swap or wrap between viewers.'));
  }
  if (mono && !lookupTag(d, '00281050')?.Value?.length)
    info.warnings.push(T('No Window Center/Width: each viewer picks its own contrast, so the same pixels can look different from one viewer to another.'));
  return info;
}

// Signs that this file is a picture of an image rather than the image: a rendered 8-bit export or
// Secondary Capture of a deep modality, or smaller than the rest of its series (a thumbnail, or a
// partial progressive download). The measured values are gone and no conversion brings them back.
function rendered(info, d, pm, entry) {
  const str = t => String(lookupTag(d, t)?.Value?.[0] ?? '').trim();
  const modality = str('00080060').toUpperCase(), sop = str('00080016');
  const sc = sop === SC_SOP_PREFIX || sop.startsWith(SC_SOP_PREFIX + '.');
  if (lookupTag(d, '7fe00010') && DEEP_MODALITIES.has(modality) && pm.bs <= 8)
    info.warnings.push(T('A {m} image with only {b}-bit pixels: this looks like a rendered picture (a screenshot or JPEG export with the contrast already applied), not the measured values. Nothing can convert it back; ask for the original DICOM.')
      .replace('{m}', modality).replace('{b}', pm.bs));
  else if (sc && DEEP_MODALITIES.has(modality))
    info.warnings.push(T('Secondary Capture of a {m} image: a copy made from a screen or another file, which may not hold the original values.').replace('{m}', modality));
  const series = str('0020000E');
  if (!series || !pm.rows || !pm.cols || typeof files === 'undefined') return;
  let big = null;
  for (const f of files) {
    if (f === entry || String(lookupTag(f.dict, '0020000E')?.Value?.[0] ?? '').trim() !== series) continue;
    const r = lookupTag(f.dict, '00280010')?.Value?.[0], c = lookupTag(f.dict, '00280011')?.Value?.[0];
    if (r * c > (big ? big.r * big.c : pm.rows * pm.cols)) big = { r, c };
  }
  if (big && big.r >= pm.rows && big.c >= pm.cols)
    info.warnings.push(T('This image is {a}, smaller than others in its series ({b}): it may be a thumbnail or a partly downloaded copy rather than the original.')
      .replace('{a}', `${pm.cols}×${pm.rows}`).replace('{b}', `${big.c}×${big.r}`));
}

// One-line label: "JPEG-LS Lossless · lossless · 2.4:1".
function compressionLabel(info) {
  if (!info) return '';
  const verdict = info.lossless === true ? T('lossless') : info.lossless === false ? T('lossy') : T('unknown');
  const parts = [info.name];
  if (info.compressed) parts.push(verdict);
  if (info.ratio && info.ratio > 1.05) parts.push(`${info.ratio.toFixed(1)}:1`);
  if (info.everLossy && info.lossless !== false) parts.push(T('previously lossy'));
  return parts.join(' · ');
}

// Whether decompressDicom can run, from headers alone (for buttons).
function decompressSupport(entry) {
  const info = compressionInfo(entry);
  if (info.kind === 'referenced') return { ok: false, info, why: T('The pixels are on a JPIP server, not in this file: there is nothing here to decompress.') };
  if (!info.hasPixels) return { ok: false, info, why: T('This file has no Pixel Data.') };
  if (info.kind === 'private') return { ok: false, info, why: T('Private transfer syntax: this tool has no decoder for it. The vendor\'s own software, or a converter that knows the syntax, has to read it.') };
  if (!info.compressed && info.ts !== '1.2.840.10008.1.2.1.98') return { ok: false, info, why: T('Already uncompressed.') };
  const sup = redactionSupport(entry.meta);
  if (!sup.ok) return { ok: false, info, why: `${T('This browser has no decoder for this compression.')} (${sup.codec})` };
  // Browser JPEG decoding is 8-bit: 12-bit lossy JPEG would come out shallower than it went in.
  if (sup.depthLoss && readPixelModuleAttrs(entry.dict).bs > 8)
    return { ok: false, info, why: T('12-bit JPEG: this browser decodes 8 bits per sample, so converting would lose depth.') };
  return { ok: true, info, bitmap: !!sup.depthLoss };
}

// Rewrite one file's Pixel Data uncompressed (Explicit VR Little Endian). The pixel values are the
// decoder's output, so for a lossless source the file is the original; for a lossy source the lost
// detail stays lost, and (0028,2110) says so. Same SOP Instance UID: a change of transfer syntax is
// not a new image. Undo goes through undoPixelTransform (op 'decompress').
async function decompressDicom(entry) {
  const can = decompressSupport(entry);
  if (!can.ok) return { error: can.why };
  const d = entry.dict;
  const meta = entry.meta || (entry.meta = {});
  const info = can.info;

  const src = await decodeStoredFrames(d, meta);
  if (src.error) return { error: src.error };
  const frameBytes = src.rows * src.cols * src.spp * Math.ceil(src.ba / 8);
  const sizeBad = frameSizeProblem(src.frames, frameBytes);
  if (sizeBad) return { error: sizeBad };

  const total = frameBytes * src.frames.length;
  const o8 = new Uint8Array(total + (total % 2));
  src.frames.forEach((fr, i) => o8.set(new Uint8Array(fr.buffer, fr.byteOffset, fr.byteLength), i * frameBytes));

  markSeed(entry);
  entry.pixelBackup = {
    op: 'decompress',
    px: getTag(d, '7FE00010'),
    tags: Object.fromEntries(DECOMPRESS_RESTORE_TAGS.map(t => [t, getTag(d, t)])),
    seqs: {},
    tsEl: meta['00020010'],
    retagged: true,
  };
  // Same rule as every pixel rewrite: undo must never bring back pre-redaction pixels.
  entry.redactBackup = null;

  setTag(d, '7FE00010', src.ba <= 8 ? 'OB' : 'OW', o8.buffer);
  setTag(d, '00280100', 'US', src.ba);
  setTag(d, '00280101', 'US', src.bs);
  setTag(d, '00280102', 'US', src.hb);
  setTag(d, '00280103', 'US', src.pr);
  setTag(d, '00280004', 'CS', src.pi);
  if (src.spp === 3) setTag(d, '00280006', 'US', 0); else delTag(d, '00280006');
  delTag(d, '7FE00001'); delTag(d, '7FE00002');   // Extended Offset Table describes the old fragments
  if (info.lossless === false || src.bitmap) {
    // Once lossy, always flagged (PS3.3 C.7.6.1.1.5); keep any ratio/method already recorded.
    setTag(d, '00282110', 'CS', '01');
    if (!lookupTag(d, '00282112')?.Value?.length && info.ratio) setTag(d, '00282112', 'DS', info.ratio.toFixed(2));
    const fam = info.ts.startsWith('1.2.840.10008.1.2.4.8') ? 'jls'
              : /^1\.2\.840\.10008\.1\.2\.4\.(9|20)/.test(info.ts) ? 'j2k' : 'jpeg';
    if (!lookupTag(d, '00282114')?.Value?.length) setTag(d, '00282114', 'CS', LOSSY_METHOD[fam]);
  }
  meta['00020010'] = { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] };

  reseedKeepingEdits(entry);
  if (files[currentFileIdx] === entry) resetEditHistory?.();
  datasetDirty = true;
  return { from: info.name, lossless: info.lossless, frames: src.frames.length,
           before: info.storedBytes, after: total, bitmap: !!src.bitmap };
}
const DECOMPRESS_RESTORE_TAGS = ['00280100', '00280101', '00280102', '00280103', '00280004', '00280006',
                                 '7FE00001', '7FE00002', '00282110', '00282112', '00282114'];

// Decoded stored values of two files, compared sample by sample. Tells "same pixels, different
// encoding" apart from "different pixels" — the byte-level tag compare cannot.
async function comparePixels(a, b) {
  const [x, y] = await Promise.all([decodeStoredFrames(a.dict, a.meta || {}), decodeStoredFrames(b.dict, b.meta || {})]);
  if (x.error || y.error) return { error: x.error || y.error };
  if (x.rows !== y.rows || x.cols !== y.cols || x.spp !== y.spp || x.frames.length !== y.frames.length)
    return { same: false, shape: true };
  let diff = 0, max = 0;
  for (let f = 0; f < x.frames.length; f++) {
    const p = x.frames[f], q = y.frames[f], n = Math.min(p.length, q.length);
    for (let i = 0; i < n; i++) { const dv = Math.abs(p[i] - q[i]); if (dv) { diff++; if (dv > max) max = dv; } }
  }
  return { same: diff === 0, diff, max, samples: x.frames.reduce((n, fr) => n + fr.length, 0) };
}

// Side-by-side compression facts for Compare and its report: [label, A, B, differs].
// Labels stay English like the tag table's; values are data (syntax names, numbers, flags).
function compressionCompareRows(a, b) {
  const ia = compressionInfo(a), ib = compressionInfo(b);
  const flag = (e, t) => String(lookupTag(e.dict, t)?.Value?.[0] ?? '').trim();
  const mb = n => !n ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
  const verdict = i => !i.hasPixels ? '—' : !i.compressed ? T('uncompressed')
    : i.lossless === true ? T('lossless') : i.lossless === false ? T('lossy') : T('unknown');
  const size = e => {
    const r = flag(e, '00280010'), c = flag(e, '00280011'), n = parseInt(flag(e, '00280008')) || 1;
    return r && c ? `${c}×${r}${n > 1 ? ` × ${n}` : ''}` : '—';
  };
  const sopLabel = u => !u ? '—' : (u === SC_SOP_PREFIX || u.startsWith(SC_SOP_PREFIX + '.')) ? `Secondary Capture (${u})` : u;
  const rows = [
    ['Transfer syntax', `${ia.name} (${ia.ts || '—'})`, `${ib.name} (${ib.ts || '—'})`],
    ['Compression', verdict(ia), verdict(ib)],
    ['Ratio', ia.ratio ? `${ia.ratio.toFixed(1)}:1` : '—', ib.ratio ? `${ib.ratio.toFixed(1)}:1` : '—'],
    ['Pixel Data stored', mb(ia.storedBytes), mb(ib.storedBytes)],
    ['(0028,2110) Lossy Image Compression', flag(a, '00282110') || '—', flag(b, '00282110') || '—'],
    ['(0028,2112) Lossy Compression Ratio', flag(a, '00282112') || '—', flag(b, '00282112') || '—'],
    ['(0028,2114) Lossy Compression Method', flag(a, '00282114') || '—', flag(b, '00282114') || '—'],
    ['Pixel Representation', flag(a, '00280103') === '1' ? T('signed') : T('unsigned'), flag(b, '00280103') === '1' ? T('signed') : T('unsigned')],
    // A smaller matrix, fewer bits or a Secondary Capture on one side: a rendered or reduced copy.
    ['Image size', size(a), size(b)],
    ['Bits Stored', flag(a, '00280101') || '—', flag(b, '00280101') || '—'],
    ['SOP Class', sopLabel(flag(a, '00080016')), sopLabel(flag(b, '00080016'))],
    ['Viewer warnings', ia.warnings.join(' ') || '—', ib.warnings.join(' ') || '—'],
  ];
  return rows.map(([l, x, y]) => [l, x, y, x !== y]);
}
