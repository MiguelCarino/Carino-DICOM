// Softcopy Presentation States (PS3.3 A.33, PS3.4 N.2): which loaded PR refers to which image, and
// its grayscale pipeline (Modality LUT, VOI window, Presentation LUT shape) or Palette Color LUT.
// Spatial and annotation parts (displayed area, rotation, graphics) are not applied.

const PR_CLASSES = {
  '1.2.840.10008.5.1.4.1.1.11.1': { kind: 'grayscale', supported: true },
  '1.2.840.10008.5.1.4.1.1.11.2': { kind: 'color', supported: false },
  '1.2.840.10008.5.1.4.1.1.11.3': { kind: 'pseudo-color', supported: true },
  '1.2.840.10008.5.1.4.1.1.11.4': { kind: 'blending', supported: false },
  '1.2.840.10008.5.1.4.1.1.11.5': { kind: 'XA/XRF grayscale', supported: false },
};

const prText = (d, tag) => String(lookupTag(d, tag)?.Value?.[0] ?? '').trim();
const prItems = (d, tag) => (lookupTag(d, tag)?.Value || []).filter(it => it && typeof it === 'object');
// Referenced Frame Number (0008,1160) is 1-based; absent means every frame.
const prFrames = (it) => {
  const v = lookupTag(it, '00081160')?.Value;
  return v?.length ? new Set(v.map(n => parseInt(n, 10)).filter(Number.isFinite)) : null;
};

function prClassOf(d) { return PR_CLASSES[prText(d, '00080016')] || null; }

// Every image the PR applies to, from Referenced Series Sequence (0008,1115).
// [{ sop, series, frames: Set | null }]
function prReferences(d) {
  const out = [];
  for (const s of prItems(d, '00081115')) {
    const series = prText(s, '0020000e');
    for (const im of prItems(s, '00081140'))
      out.push({ sop: prText(im, '00081155'), series, frames: prFrames(im) });
  }
  return out.filter(r => r.sop);
}

// An item whose Referenced Image Sequence is absent applies to every image the PR references.
function prItemApplies(it, sop, frame1) {
  const refs = prItems(it, '00081140');
  if (!refs.length) return true;
  return refs.some(r => prText(r, '00081155') === sop && (!prFrames(r) || prFrames(r).has(frame1)));
}

// Window from the Softcopy VOI LUT Sequence (0028,3110) item for this image and frame. Only the
// first window is used; a VOI LUT Sequence (table) item is skipped. null if none applies.
function prWindowFor(d, sop, frame1) {
  for (const it of prItems(d, '00283110')) {
    if (!prItemApplies(it, sop, frame1)) continue;
    const wc = parseFloat(lookupTag(it, '00281050')?.Value?.[0]);
    const ww = parseFloat(lookupTag(it, '00281051')?.Value?.[0]);
    if (Number.isFinite(wc) && Number.isFinite(ww) && ww > 0) return { wc, ww };
  }
  return null;
}

// The PR's Modality LUT replaces the image's (PS3.4 N.2.1). Rescale only; null if absent.
function prRescale(d) {
  const slope = parseFloat(lookupTag(d, '00281053')?.Value?.[0]);
  const inter = parseFloat(lookupTag(d, '00281052')?.Value?.[0]);
  if (!Number.isFinite(slope) && !Number.isFinite(inter)) return null;
  return { slope: Number.isFinite(slope) ? slope : 1, inter: Number.isFinite(inter) ? inter : 0 };
}

function prPalette(d, bigEndian) {
  const r = readPaletteLut(d, '00281101', '00281201', bigEndian);
  const g = readPaletteLut(d, '00281102', '00281202', bigEndian);
  const b = readPaletteLut(d, '00281103', '00281203', bigEndian);
  return r && g && b ? { r, g, b } : null;
}

// The loaded PRs that refer to this SOP Instance, in load order. entries: [{ dict, name }].
// [{ index, dict, label, kind, supported, frames }]
function presentationStatesFor(entries, sop) {
  if (!sop) return [];
  const out = [];
  entries.forEach((e, index) => {
    const cls = e?.dict && prClassOf(e.dict);
    if (!cls) return;
    const ref = prReferences(e.dict).find(r => r.sop === sop);
    if (!ref) return;
    const num = prText(e.dict, '00200011'), desc = prText(e.dict, '0008103e') || prText(e.dict, '00700080');
    out.push({ index, dict: e.dict, kind: cls.kind, supported: cls.supported, frames: ref.frames,
               label: [num && `PR ${num}`, desc].filter(Boolean).join(' · ') || e.name || 'PR' });
  });
  return out;
}

// What the viewer needs to draw one frame through a PR, or null if the PR does not cover it.
// imgRescale is the image's own { slope, inter }, already applied to the decoded floats.
function presentationFor(pr, sop, frame1, imgRescale, bigEndian) {
  if (pr.frames && !pr.frames.has(frame1)) return null;
  const pal = pr.kind === 'pseudo-color' ? prPalette(pr.dict, bigEndian) : null;
  if (pr.kind === 'pseudo-color' && !pal) return null;
  return {
    window: prWindowFor(pr.dict, sop, frame1),
    rescale: prRescale(pr.dict),
    imgRescale,
    inverse: /^INVERSE$/i.test(prText(pr.dict, '20500020')),
    palette: pal,
  };
}

// Decoded floats (image rescale applied) re-expressed in the PR's Modality LUT units.
function prRescaleFloats(raw, p) {
  if (!p.rescale) return raw;
  const { slope: si, inter: ii } = p.imgRescale, { slope: sp, inter: ip } = p.rescale;
  if (si === sp && ii === ip) return raw;
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = ((raw[i] - ii) / (si || 1)) * sp + ip;
  return out;
}

// One frame to RGBA: linear window (PS3.3 C.11.2.1.2), then either the Palette Color LUT, with the
// window's output range spread over the table's input range (PS3.4 N.2.4), or gray (INVERSE flips).
function applyPresentationToFloats(raw, n, wc, ww, mn, mx, p) {
  let lo, hi;
  if (Number.isFinite(wc) && Number.isFinite(ww)) {
    lo = wc - 0.5 - (ww - 1) / 2;
    hi = wc - 0.5 + (ww - 1) / 2;
  } else { lo = mn; hi = mx; }
  const range = (hi - lo) || 1;
  const out = new Uint8ClampedArray(n * 4);
  const pal = p.palette;
  const last = pal ? Math.min(pal.r.count, pal.g.count, pal.b.count) - 1 : 255;
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    const t = v <= lo ? 0 : v >= hi ? 1 : (v - lo) / range;
    const q = i * 4;
    if (pal) {
      const k = Math.round(t * last);
      out[q] = pal.r.lut[k]; out[q + 1] = pal.g.lut[k]; out[q + 2] = pal.b.lut[k];
    } else {
      const g = Math.round(t * 255);
      out[q] = out[q + 1] = out[q + 2] = p.inverse ? 255 - g : g;
    }
    out[q + 3] = 255;
  }
  return out;
}

// ---- Burn a PR in as a colour series ----
// For viewers that ignore presentation states: every frame the PR covers, drawn through the PR
// as it is defined (its windows, not the viewer's sliders), as single-frame RGB Secondary
// Capture (PS3.3 A.8.1) in one new series of the same study.
const SC_SOP_UID = '1.2.840.10008.5.1.4.1.1.7';
const BURN_MAX_BYTES = 512 * 1024 * 1024;   // RGB output, all frames
// Copied from the source as they are: patient, study, request and the series' own context.
const BURN_COPY_TAGS = ['00080005', '00080020', '00080030', '00080050', '00080090', '00081030',
  '00080023', '00080033', '00080060', '00080080', '00081010', '00100010', '00100020', '00100021',
  '00100030', '00100040', '00101010', '00101020', '00101030', '0020000D', '00200010', '00200060',
  '00321032', '00321060', '00400275'];

// A Series Number for the new series that no loaded series of this study uses: source number
// followed by 99 (5047 -> 504799, an easy-to-trace sibling), else one past the highest.
function burnSeriesNumber(entries, studyUID, srcNum) {
  const used = new Set(entries.filter(e => e.dict && prText(e.dict, '0020000d') === studyUID)
                              .map(e => parseInt(prText(e.dict, '00200011'), 10)).filter(Number.isFinite));
  const n = parseInt(srcNum, 10);
  let c = Number.isFinite(n) && n >= 0 && n < 1e9 ? n * 100 + 99 : Math.max(0, ...used) + 1;
  while (used.has(c)) c++;
  return c;
}

// One SC file around rgb (rows*cols*3 bytes). src is the image the pixels came from.
function buildBurnedSC(src, rgb, rows, cols, o) {
  const sop = newUID();
  const d = {};
  for (const t of BURN_COPY_TAGS) {
    const el = getTag(src, t);
    if (el) d[t] = structuredClone(el);
  }
  const srcRef = {
    '00081150': { vr: 'UI', Value: [prText(src, '00080016')] },
    '00081155': { vr: 'UI', Value: [prText(src, '00080018')] },
    '0040A170': { vr: 'SQ', Value: [{   // CID 7202: source image for image processing operation
      '00080100': { vr: 'SH', Value: ['121322'] }, '00080102': { vr: 'SH', Value: ['DCM'] },
      '00080104': { vr: 'LO', Value: ['Source image for image processing operation'] } }] },
  };
  if (o.numFrames > 1) srcRef['00081160'] = { vr: 'IS', Value: [o.frame1] };
  Object.assign(d, {
    '00080008': { vr: 'CS', Value: ['DERIVED', 'SECONDARY'] },
    '00080012': { vr: 'DA', Value: [o.date] },
    '00080013': { vr: 'TM', Value: [o.time] },
    '00080016': { vr: 'UI', Value: [SC_SOP_UID] },
    '00080018': { vr: 'UI', Value: [sop] },
    '00080021': { vr: 'DA', Value: [o.date] },
    '00080031': { vr: 'TM', Value: [o.time] },
    '00080064': { vr: 'CS', Value: ['WSD'] },          // Conversion Type, Type 1 (C.8.6.1)
    '0008103E': { vr: 'LO', Value: [o.description] },
    '00082111': { vr: 'ST', Value: [o.derivation] },
    '00082112': { vr: 'SQ', Value: [srcRef] },
    '0020000E': { vr: 'UI', Value: [o.seriesUID] },
    '00200011': { vr: 'IS', Value: [o.seriesNumber] },
    '00200013': { vr: 'IS', Value: [o.instance] },
    '00200020': { vr: 'CS', Value: [] },               // Patient Orientation, Type 2C
    '00280002': { vr: 'US', Value: [3] },
    '00280004': { vr: 'CS', Value: ['RGB'] },
    '00280006': { vr: 'US', Value: [0] },
    '00280010': { vr: 'US', Value: [rows] },
    '00280011': { vr: 'US', Value: [cols] },
    '00280100': { vr: 'US', Value: [8] },
    '00280101': { vr: 'US', Value: [8] },
    '00280102': { vr: 'US', Value: [7] },
    '00280103': { vr: 'US', Value: [0] },
    '00280301': { vr: 'CS', Value: ['NO'] },
    '7FE00010': { vr: 'OB', Value: [rgb.buffer] },
  });
  if (!d['00080060']) d['00080060'] = { vr: 'CS', Value: ['OT'] };
  const fileMeta = {
    '00020001': { vr: 'OB', Value: [new Uint8Array([0, 1]).buffer] },
    '00020002': { vr: 'UI', Value: [SC_SOP_UID] },
    '00020003': { vr: 'UI', Value: [sop] },
    '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] },
    '00020012': { vr: 'UI', Value: ['1.2.826.0.1.3680043.10.743'] },
  };
  const dd = new DicomDict(fileMeta);
  dd.dict = d;
  const out = dd.write();
  return new Uint8Array(out.buffer || out);
}

// Every loaded image the PR refers to, each covered frame rendered through it. entries as for
// presentationStatesFor; prIndex is the PR's entry. Returns { files: [{ name, bytes }], series }
// or { error }. onProgress(done, total) is called per frame.
async function burnPresentationSeries(entries, prIndex, onProgress) {
  const prEntry = entries[prIndex];
  const cls = prEntry?.dict && prClassOf(prEntry.dict);
  if (!cls || !cls.supported) return { error: T('This presentation state cannot be applied here.') };
  const refs = prReferences(prEntry.dict);
  const targets = [];
  entries.forEach((e, i) => {
    if (i === prIndex || !e.dict) return;
    const ref = refs.find(r => r.sop === prText(e.dict, '00080018'));
    if (ref) targets.push({ e, ref });
  });
  if (!targets.length) return { error: T('None of the images this presentation state refers to are loaded.') };

  const prBE = previewTransferSyntax(prEntry.meta).isBigEndian;
  const jobs = [];
  for (const t of targets) {
    const { rows, cols, numFrames } = readPixelModuleAttrs(t.e.dict);
    for (let f = 1; f <= numFrames; f++) if (!t.ref.frames || t.ref.frames.has(f)) jobs.push({ ...t, f, numFrames, bytes: rows * cols * 3 });
  }
  if (jobs.reduce((n, j) => n + j.bytes, 0) > BURN_MAX_BYTES)
    return { error: T('The colour series would be too large to build in a browser tab.') };

  const first = targets[0].e.dict;
  const pr = { dict: prEntry.dict, kind: cls.kind, frames: null };
  const prLabel = [prText(prEntry.dict, '00200011') && `PR ${prText(prEntry.dict, '00200011')}`,
                   prText(prEntry.dict, '0008103e')].filter(Boolean).join(' ');
  const srcDesc = prText(first, '0008103e');
  const o = {
    date: nowDA(), time: nowTM(), seriesUID: newUID(),
    seriesNumber: burnSeriesNumber(entries, prText(first, '0020000d'), prText(first, '00200011')),
    description: `${srcDesc || prText(prEntry.dict, '0008103e') || 'PR'} ${cls.kind === 'pseudo-color' ? 'COLOR' : 'PR'}`.trim().slice(0, 64),
    derivation: `Rendered through ${cls.kind} presentation state ${prLabel || ''} (${prText(prEntry.dict, '00080018')}): its window and ${cls.kind === 'pseudo-color' ? 'palette' : 'presentation LUT'} applied; annotations, rotation and zoom not drawn.`.replace(/\s+/g, ' ').slice(0, 1024),
  };

  const out = [];
  for (const [k, j] of jobs.entries()) {
    const sop = prText(j.e.dict, '00080018');
    const res = await decodeDicomPixels(j.e.dict, j.f - 1, { meta: j.e.meta });
    if (!res || res.error || !res.rawFloats)
      return { error: `${j.e.name || sop} frame ${j.f}: ${res?.error || 'not a grayscale image this tool can render'}` };
    const p = presentationFor(pr, sop, j.f, readRescale(j.e.dict), prBE);
    if (!p) return { error: `${j.e.name || sop} frame ${j.f}: the presentation state has no usable colour table.` };
    const floats = prRescaleFloats(res.rawFloats, p);
    let mn = res.mn, mx = res.mx;
    if (floats !== res.rawFloats) { mn = Infinity; mx = -Infinity; for (const v of floats) { if (v < mn) mn = v; if (v > mx) mx = v; } }
    const wc = p.window?.wc ?? parseFloat(res.wcTag), ww = p.window?.ww ?? parseFloat(res.wwTag);
    const rgba = applyPresentationToFloats(floats, res.rows * res.cols, wc, ww, mn, mx, p);
    const rgb = new Uint8Array(res.rows * res.cols * 3);
    for (let i = 0, q = 0; q < rgb.length; i += 4, q += 3) { rgb[q] = rgba[i]; rgb[q + 1] = rgba[i + 1]; rgb[q + 2] = rgba[i + 2]; }
    const bytes = buildBurnedSC(j.e.dict, rgb, res.rows, res.cols, { ...o, instance: k + 1, frame1: j.f, numFrames: j.numFrames });
    out.push({ name: `${o.seriesNumber}/IM${String(k + 1).padStart(4, '0')}.dcm`, bytes });
    onProgress?.(k + 1, jobs.length);
    if ((k & 3) === 3) await new Promise(r => setTimeout(r, 0));
  }
  return { files: out, series: { uid: o.seriesUID, number: o.seriesNumber, description: o.description } };
}
