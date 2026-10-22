// Pixel edits (rotate/flip/invert written into the file) plus anonymize, randomize and UID remap actions.

// ---- Rotate / flip ----
// Unlike the Overview viewer's view-only rotate, these permute the stored samples and
// rewrite the geometry, so every other reader opens the result the right way up.
// Pixels come through decodeStoredFrames (same decoder and refusals as redaction).
// Every op is a pure permutation of whole samples, so it is lossless for any depth or PI.
// sx/sy map a DESTINATION pixel to its source pixel (w/h = source Columns/Rows); two
// functions rather than one returning a pair to avoid a per-pixel allocation.
const PIXEL_OPS = {
  rot90:  { label: 'Rotate 90° clockwise',         swap: true,  inverse: 'rot270',
            sx: (x, y, w, h) => y,         sy: (x, y, w, h) => h - 1 - x },
  rot270: { label: 'Rotate 90° counter-clockwise', swap: true,  inverse: 'rot90',
            sx: (x, y, w, h) => w - 1 - y, sy: (x, y, w, h) => x },
  rot180: { label: 'Rotate 180°',                  swap: false, inverse: 'rot180',
            sx: (x, y, w, h) => w - 1 - x, sy: (x, y, w, h) => h - 1 - y },
  flipH:  { label: 'Flip horizontal',              swap: false, inverse: 'flipH',
            sx: (x, y, w, h) => w - 1 - x, sy: (x, y, w, h) => y },
  flipV:  { label: 'Flip vertical',                swap: false, inverse: 'flipV',
            sx: (x, y, w, h) => x,         sy: (x, y, w, h) => h - 1 - y },
};

// Frames keep their typed-array type and planar configuration (not normalised).
function transformStoredFrames(src, opKey) {
  const op = PIXEL_OPS[opKey];
  const { rows, cols, spp, planar } = src;
  const nRows = op.swap ? cols : rows, nCols = op.swap ? rows : cols;
  const framePixels = rows * cols;
  const { sx, sy } = op;
  const frames = src.frames.map(fr => {
    const out = new fr.constructor(fr.length);
    for (let y = 0; y < nRows; y++) {
      for (let x = 0; x < nCols; x++) {
        const si = sy(x, y, cols, rows) * cols + sx(x, y, cols, rows);
        const di = y * nCols + x;
        if (spp === 1) { out[di] = fr[si]; continue; }
        for (let s = 0; s < spp; s++) {
          out[planar === 1 ? s * framePixels + di : di * spp + s] =
            fr[planar === 1 ? s * framePixels + si : si * spp + s];
        }
      }
    }
    return out;
  });
  return { frames, rows: nRows, cols: nCols };
}

// ---- Geometry ----
// (0020,0037) Image Orientation (Patient) = [row dir, column dir] (PS3.3 C.7.6.2.1.1).
// Permuting pixels permutes/negates these vectors exactly; no trigonometry, no rounding.
const IOP_MAP = {
  rot90:  (r, c) => [...c.map(v => -v), ...r],
  rot270: (r, c) => [...c, ...r.map(v => -v)],
  rot180: (r, c) => [...r.map(v => -v), ...c.map(v => -v)],
  flipH:  (r, c) => [...r.map(v => -v), ...c],
  flipV:  (r, c) => [...r, ...c.map(v => -v)],
};

// (0020,0020) Patient Orientation follows IOP_MAP, with "negate" = opposite letter.
// Multi-letter values ('AL') reverse each letter.
const ANAT_OPPOSITE = { A: 'P', P: 'A', L: 'R', R: 'L', H: 'F', F: 'H' };
function opposeOrientation(code) {
  const s = String(code || '').trim().toUpperCase();
  if (!s || [...s].some(ch => !ANAT_OPPOSITE[ch])) return null;
  return [...s].map(ch => ANAT_OPPOSITE[ch]).join('');
}

// DS value within 16 bytes and without float noise (0.30000000000000004).
function dsStr(v) {
  if (!isFinite(v)) return '0';
  if (Object.is(v, -0)) v = 0;
  let s = String(Math.abs(v) < 1e6 ? Number(v.toFixed(8)) : Number(v.toPrecision(12)));
  if (s.length > 16) s = Number(v.toPrecision(9)).toString();
  if (s.length > 16) s = v.toExponential(6);
  return s.slice(0, 16);
}

// Numeric values or null. DS arrives as string or number depending on dcmjs version.
function numsOf(el) {
  const v = el?.Value;
  if (!Array.isArray(v) || !v.length) return null;
  const n = v.map(x => typeof x === 'number' ? x : parseFloat(String(x).trim()));
  return n.some(x => !isFinite(x)) ? null : n;
}

// Swap the first two values (Pixel Spacing [row, col], Aspect Ratio [v, h]) on a quarter
// turn, or non-square pixels measure wrong downstream.
function swapPairTag(node, tag) {
  const el = getTag(node, tag);
  const v = el?.Value;
  if (!Array.isArray(v) || v.length < 2) return false;
  setTag(node, tag, el.vr, [v[1], v[0], ...v.slice(2)]);
  return true;
}

// Only functional-group sequences follow the pixels; other sequences carrying geometry
// (Referenced Image, Original Attributes) describe OTHER instances and are left alone.
const GEOM_SEQS = new Set(['52009229', '52009230',    // Shared / Per-Frame Functional Groups
                           '00209113', '00209116',    // Plane Position / Plane Orientation
                           '00289110']);              // Pixel Measures

function eachGeomItem(node, fn) {
  for (const [t, el] of Object.entries(node)) {
    if (!el || el.vr !== 'SQ' || !Array.isArray(el.Value)) continue;
    if (!GEOM_SEQS.has(canonTag(t))) continue;
    el.Value.forEach(item => { if (item && typeof item === 'object') fn(item); });
  }
}

// The subtree's own value, else the first one found in its functional groups.
function findGeomValue(node, tag) {
  const own = numsOf(getTag(node, tag));
  if (own) return own;
  let found = null;
  eachGeomItem(node, item => { if (!found) found = findGeomValue(item, tag); });
  return found;
}

// `ctx` holds PRE-transform Rows/Columns, orientation and spacing, resolved before any
// write: Plane Orientation and Plane Position are sibling sequences, so reading after
// writing would use the already-turned orientation.
function retagGeometry(node, opKey, ctx) {
  const op = PIXEL_OPS[opKey];
  const here = {
    ...ctx,
    iop: findGeomValue(node, '00200037') || ctx.iop,
    ps:  findGeomValue(node, '00280030') || ctx.ps,
  };

  if (op.swap) {
    swapPairTag(node, '00280030');    // Pixel Spacing
    swapPairTag(node, '00181164');    // Imager Pixel Spacing
    swapPairTag(node, '00182010');    // Nominal Scanned Pixel Spacing
    swapPairTag(node, '00280034');    // Pixel Aspect Ratio
    // In-plane Phase Encoding Direction is relative to the image axes (PS3.3 C.8.3.1).
    const pe = getTag(node, '00181312');
    const pev = String(pe?.Value?.[0] ?? '').trim().toUpperCase();
    if (pev === 'ROW' || pev === 'COL') setTag(node, '00181312', 'CS', pev === 'ROW' ? 'COL' : 'ROW');
  }

  const iop = numsOf(getTag(node, '00200037'));
  if (iop && iop.length >= 6) {
    setTag(node, '00200037', 'DS',
           IOP_MAP[opKey](iop.slice(0, 3), iop.slice(3, 6)).map(dsStr));
  }

  // Image Position (Patient) is the centre of the first pixel; the new first pixel is the
  // source pixel the op maps to (0,0), reached along the OLD row/column vectors.
  const ipp = numsOf(getTag(node, '00200032'));
  if (ipp && ipp.length >= 3) {
    const { rows, cols } = here;
    const r = (here.iop || []).slice(0, 3), c = (here.iop || []).slice(3, 6);
    const ps = here.ps || [];
    if (r.length === 3 && c.length === 3 && ps.length >= 2) {
      const x0 = op.sx(0, 0, cols, rows), y0 = op.sy(0, 0, cols, rows);
      setTag(node, '00200032', 'DS',
             ipp.slice(0, 3).map((v, i) => dsStr(v + r[i] * ps[1] * x0 + c[i] * ps[0] * y0)));
    } else {
      // Missing vectors or spacing: report rather than guess.
      here.report?.push('(0020,0032) Image Position (Patient)');
    }
  }

  const po = getTag(node, '00200020');
  const poBlank = po && Array.isArray(po.Value) && po.Value.every(v => !String(v ?? '').trim());
  if (po && Array.isArray(po.Value) && po.Value.length === 1 && !poBlank) here.report?.push('(0020,0020) Patient Orientation');
  if (po && Array.isArray(po.Value) && po.Value.length >= 2 && !poBlank) {
    const rowDir = String(po.Value[0]), colDir = String(po.Value[1]);
    const flip = { rot90:  [opposeOrientation(colDir), rowDir],
                   rot270: [colDir, opposeOrientation(rowDir)],
                   rot180: [opposeOrientation(rowDir), opposeOrientation(colDir)],
                   flipH:  [opposeOrientation(rowDir), colDir],
                   flipV:  [rowDir, opposeOrientation(colDir)] }[opKey];
    if (flip && flip.every(Boolean)) setTag(node, '00200020', po.vr || 'CS', flip);
    else here.report?.push('(0020,0020) Patient Orientation');
  }

  eachGeomItem(node, item => retagGeometry(item, opKey, here));
}

// Positional content this tool does not move; named in the confirm dialog so the user
// knows it will no longer line up.
function unmovedByTransform(d) {
  const out = [];
  // Overlay planes are the even groups 6000-601E (PS3.3 C.9.2); odd 60xx groups are private.
  const overlays = Object.keys(d).some(t => /^60[0-9A-F][02468ACE](3000|0010|0011|0050)$/i.test(canonTag(t)));
  if (overlays) out.push('Overlay planes (60xx,3000)');
  if (getTag(d, '00186011')) out.push('Sequence of Ultrasound Regions (0018,6011)');
  if (getTag(d, '00700001')) out.push('Graphic Annotation Sequence (0070,0001)');
  return out;
}

// Tags a transform replaces (for session undo): the redaction set plus geometry.
const PIXEL_EDIT_RESTORE_TAGS = REDACT_RESTORE_TAGS.concat(
  ['00280010', '00280011', '00280030', '00181164', '00182010', '00280034',
   '00200037', '00200032', '00200020', '00181312']);
const PIXEL_EDIT_RESTORE_SEQS = ['52009229', '52009230'];

// Eager on click (like applyRedaction): decoding may be async, but buildEditedFile must
// stay synchronous. Returns { op, frames, rows, cols, converts, depthLoss } or { error }.
async function applyPixelTransform(entry, opKey) {
  if (!entry || !entry.dict) return { error: 'No file to edit.' };
  if (!PIXEL_OPS[opKey]) return { error: `Unknown image edit: ${opKey}` };
  const d = entry.dict;
  const meta = entry.meta || (entry.meta = {});

  const src = await decodeStoredFrames(d, meta);
  if (src.error) return { error: src.error };

  const sizeBad = frameSizeProblem(src.frames, src.rows * src.cols * src.spp * Math.ceil(src.ba / 8));
  if (sizeBad) return { error: sizeBad };
  const moved = transformStoredFrames(src, opKey);

  const bytesPerSample = Math.ceil(src.ba / 8);
  const frameBytes = moved.rows * moved.cols * src.spp * bytesPerSample;
  const total = frameBytes * moved.frames.length + ((frameBytes * moved.frames.length) % 2);
  const outBuf = new ArrayBuffer(total);
  const o8 = new Uint8Array(outBuf);
  moved.frames.forEach((fr, i) =>
    o8.set(new Uint8Array(fr.buffer, fr.byteOffset, fr.byteLength), i * frameBytes));

  markSeed(entry);
  entry.pixelBackup = {
    op: opKey,
    px: getTag(d, '7FE00010'),
    tags: Object.fromEntries(PIXEL_EDIT_RESTORE_TAGS.map(t => [t, getTag(d, t)])),
    seqs: Object.fromEntries(PIXEL_EDIT_RESTORE_SEQS.map(t => {
      const el = getTag(d, t);
      // Cloned because the items are rewritten in place (pixels are kept by reference).
      return [t, el ? structuredClone(el) : undefined];
    })),
    tsEl: meta['00020010'],
    retagged: !src.raw || src.swapped,
  };
  // Privacy: undoing a transform must never restore pre-redaction pixels.
  entry.redactBackup = null;

  if (src.swapped) entry.pixelBackup.whole = convertBigEndianDict(d);
  // The thumbnail is not turned with the image; drop it rather than leave it misoriented.
  entry.pixelBackup.icons = stripIcons(d);
  setTag(d, '7FE00010', src.ba <= 8 ? 'OB' : 'OW', outBuf);
  setTag(d, '00280010', 'US', moved.rows);
  setTag(d, '00280011', 'US', moved.cols);

  const report = [];
  retagGeometry(d, opKey, { rows: src.rows, cols: src.cols,
                            iop: findGeomValue(d, '00200037'),
                            ps:  findGeomValue(d, '00280030'), report });

  if (!src.raw) {
    // Same pixel-module rewrite as redaction: the element now holds uncompressed interleaved samples.
    setTag(d, '00280100', 'US', src.ba);
    setTag(d, '00280101', 'US', src.bs);
    setTag(d, '00280102', 'US', src.hb);
    setTag(d, '00280103', 'US', src.pr);
    setTag(d, '00280004', 'CS', src.pi);
    if (src.spp === 3) setTag(d, '00280006', 'US', 0); else delTag(d, '00280006');
    delTag(d, '7FE00001'); delTag(d, '7FE00002');   // Extended Offset Table
    if (src.bitmap && src.spp === 1 && !lookupTag(d, '00281050')?.Value?.length) {
      setTag(d, '00281050', 'DS', String(1 << (src.bs - 1)));
      setTag(d, '00281051', 'DS', String(1 << src.bs));
    }
  }
  if (!src.raw || src.swapped) meta['00020010'] = { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] };

  retagDerived(d, `${PIXEL_OPS[opKey].label} — Carino DICOM Editor`);

  reseedKeepingEdits(entry);
  if (files[currentFileIdx] === entry) resetEditHistory?.();
  datasetDirty = true;

  return { op: opKey, frames: moved.frames.length, rows: moved.rows, cols: moved.cols,
           converts: !src.raw, depthLoss: !!src.depthLoss, unmoved: [...new Set(report)] };
}

// No (0008,0005) Specific Character Set is written, so per PS3.5 6.1.2.3 text must be in
// the default repertoire (ASCII); non-ASCII would read back as mojibake.
function asciiOnly(s) {
  return String(s)
    .replace(/[\u2014\u2013]/g, '-')       // em / en dash
    .replace(/\u00B0/g, ' deg')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x20-\x7E]/g, '?');
}

// PS3.3 for changed pixels: Image Type value 1 DERIVED (C.7.6.1.1.2), a Derivation
// Description, and a new SOP Instance UID.
function retagDerived(d, what) {
  what = asciiOnly(what);
  const it = (getTag(d, '00080008')?.Value || []).map(v => String(v));
  if (!it.length) setTag(d, '00080008', 'CS', ['DERIVED', 'SECONDARY']);
  else if (it[0] !== 'DERIVED') { it[0] = 'DERIVED'; setTag(d, '00080008', 'CS', it); }

  const prev = String(getTag(d, '00082111')?.Value?.[0] || '').trim();
  // ST max is 1024 chars; keep the old text rather than let it be truncated mid-sentence.
  const next = prev ? `${prev}; ${what}` : what;
  setTag(d, '00082111', 'ST', next.length <= 1024 ? next : prev || what.slice(0, 1024));

  // Enhanced multi-frame: Frame Type value 1 must agree with Image Type when every frame changed
  // (PS3.3 C.8.16.1), and every frame was rewritten.
  for (const fg of ['52009229', '52009230']) {
    for (const item of seqItems(getTag(d, fg))) walkEls(item, (t, el, parent) => {
      if (canonTag(t) !== '00089007' || !Array.isArray(el.Value) || !el.Value.length) return;
      if (String(el.Value[0]).trim() !== 'DERIVED') parent[t] = { ...el, Value: ['DERIVED', ...el.Value.slice(1)] };
    });
  }

  setTag(d, '00080018', 'UI', newUID());
}

// One-step, session-only undo (not a stack): restores the file as of one edit ago.
function undoPixelTransform(entry) {
  const b = entry?.pixelBackup;
  if (!b) return false;
  const d = entry.dict;
  markSeed(entry);
  if (b.whole) { for (const k of Object.keys(d)) delete d[k]; Object.assign(d, b.whole); }
  delTag(d, '7FE00010');
  if (b.px) d['7FE00010'] = b.px;
  for (const [t, el] of Object.entries(b.tags)) { delTag(d, t); if (el) d[canonTag(t)] = el; }
  for (const [t, el] of Object.entries(b.seqs)) { delTag(d, t); if (el) d[canonTag(t)] = el; }
  for (const [parent, t, el] of b.icons || []) parent[t] = el;
  if (b.retagged) {
    if (b.tsEl) entry.meta['00020010'] = b.tsEl; else delete entry.meta['00020010'];
  }
  entry.pixelBackup = null;
  reseedKeepingEdits(entry);
  if (files[currentFileIdx] === entry) resetEditHistory?.();
  return true;
}

// Swapping MONOCHROME1/2 inverts the display without touching pixels, and is exactly
// reversible. Colour and palette images have no such inverse and are refused.
function invertPhotometric(entry) {
  const d = entry?.dict;
  if (!d) return { error: 'No file to edit.' };
  const pi = String(lookupTag(d, '00280004')?.Value?.[0] || '').trim().toUpperCase();
  const next = pi === 'MONOCHROME1' ? 'MONOCHROME2' : pi === 'MONOCHROME2' ? 'MONOCHROME1' : null;
  if (!next) return { error: T('Only MONOCHROME1 and MONOCHROME2 images can be inverted this way.') };
  markSeed(entry);
  setTag(d, '00280004', 'CS', next);
  // It displays as a different image, so it is a new instance with a derivation record.
  retagDerived(d, `Photometric Interpretation ${pi} -> ${next} - Carino DICOM Editor`);
  // A later Undo of a rotate/flip must not silently revert this invert.
  // It keeps this new instance's UID too: the un-rotated but inverted image is not the original.
  if (entry.pixelBackup) for (const t of ['00280004', '00080018']) entry.pixelBackup.tags[t] = getTag(d, t);
  reseedKeepingEdits(entry);
  // As for rotate/flip: an older tag snapshot would put the pre-invert Photometric
  // Interpretation and SOP Instance UID back over the new instance.
  if (files[currentFileIdx] === entry) resetEditHistory?.();
  datasetDirty = true;
  return { pi: next };
}

// ---- Anonymize / randomize / UID remap ----
// The PS3.15 Basic Profile as the table says, nothing kept or invented on top: Patient's Sex is
// Z and Patient's Age is X unless Retain Patient Characteristics (113108) is ticked, so a file
// claiming 113100 alone carries neither. The only addition is the readable ANONYMOUS name, which
// Z permits (a dummy value instead of zero length). Returns notes for the caller's log.
function anonymize(d) {
  if (!window.DEID_PROFILE) throw new Error(DEID_MISSING);
  remPrivate(d);                // remove all private (odd-group) attributes, recursively
  const notes = applyProfile(d);   // full PS3.15 Basic Profile, recursively (UIDs: remapUIDs())
  setTag(d, '00100010', 'PN', ANON_NAME);
  addDeidMeta(d);
  return notes;
}

// Age in whole years between two DA values, as AS ('nnnY'), or '' when either is unusable.
function ageAt(dob, at) {
  const m1 = /^(\d{4})(\d{2})(\d{2})/.exec(String(dob || '')), m2 = /^(\d{4})(\d{2})(\d{2})/.exec(String(at || ''));
  if (!m1 || !m2) return '';
  let y = +m2[1] - +m1[1];
  if (+m2[2] < +m1[2] || (+m2[2] === +m1[2] && +m2[3] < +m1[3])) y--;
  return y >= 0 && y < 1000 ? String(y).padStart(3, '0') + 'Y' : '';
}

function randDOB() {
  return `${1950 + Math.floor(Math.random() * 60)}${String(1 + Math.floor(Math.random() * 12)).padStart(2,'0')}${String(1 + Math.floor(Math.random() * 28)).padStart(2,'0')}`;
}

// One made-up identity per original patient and one Study ID / Accession per original study, so
// the slices of one study stay one patient and one study (PS3.3 C.7.1.1 / C.7.2.1: patient- and
// study-level attributes are identical in every instance). The clock is read once per run.
function randomizeAll(list) {
  const NOW_DA = nowDA(), NOW_TM = nowTM();
  const patients = new Map(), studies = new Map();
  const keyOf = (d, tag) => String(getTag(d, tag)?.Value?.[0] ?? '').trim();
  for (const f of list) {
    const d = f.dict;
    const pk = keyOf(d, '00100020') || elToString(getTag(d, '00100010')).trim() || f;
    if (!patients.has(pk)) {
      const sex = randFrom(['M', 'F', 'O']);
      patients.set(pk, { sex, name: randName(sex), id: randDigits(8), dob: randDOB() });
    }
    const sk = keyOf(d, '0020000D') || f;
    if (!studies.has(sk)) studies.set(sk, { studyId: randDigits(6), accession: randDigits(9) });
    const p = patients.get(pk), st = studies.get(sk);
    setTag(d, '00100010', 'PN', p.name);
    setTag(d, '00100020', 'LO', p.id);
    setTag(d, '00100030', 'DA', p.dob);
    setTag(d, '00100040', 'CS', p.sex);
    // Patient's Age is the age at the study (PS3.3 C.7.2.2), so it follows from the two dates.
    setTag(d, '00101010', 'AS', ageAt(p.dob, NOW_DA) || '000Y');
    // Only dates the file already has are restamped: a missing Acquisition Date stays missing.
    for (const t of DATES) if (getTag(d, t) || t === 'x00080020') setTag(d, t, 'DA', NOW_DA);
    for (const t of TIMES) if (getTag(d, t) || t === 'x00080030') setTag(d, t, 'TM', NOW_TM);
    if (getTag(d, '0008002A')) setTag(d, '0008002A', 'DT', NOW_DA + NOW_TM);
    setTag(d, '00200010', 'SH', st.studyId);
    setTag(d, '00080050', 'SH', st.accession);
  }
}
// Kept for callers that randomize one dataset on its own (each call is its own patient).
function randomize(d) { randomizeAll([{ dict: d }]); }

// ---- Swap patients ----
// The Patient Module (group 0010) belongs to the person; study, series, equipment and pixels
// belong to the acquisition, so a swap trades group 0010 between two studies and nothing else.
// Anatomical Orientation Type (0010,2210) is the exception: it is a General Series attribute
// (PS3.3 C.7.3.1) that describes the acquisition, so it stays with its images.
// Accession Number is opt-in: it names the order, and sometimes the order is what was mixed up.
const SWAP_ACCESSION = ['00080050', '00080051'];
const SWAP_STAYS = ['00102210'];
function isSwappedTag(hex, withAccession) {
  return (hex.startsWith('0010') && hex.slice(4) !== '0000' && !SWAP_STAYS.includes(hex)) ||
         (withAccession && SWAP_ACCESSION.includes(hex));
}
function swappedTagsOf(d, withAccession) {
  const out = {};
  for (const [k, el] of Object.entries(d)) if (isSwappedTag(canonTag(k), withAccession)) out[canonTag(k)] = el;
  return out;
}
function writeSwappedTags(d, tags, withAccession) {
  // Delete first so a tag only the old patient had (e.g. Patient Comments) does not stay behind.
  const oldAcc = String(getTag(d, '00080050')?.Value?.[0] ?? '').trim();
  for (const k of Object.keys(d)) if (isSwappedTag(canonTag(k), withAccession)) delete d[k];
  for (const [hex, el] of Object.entries(tags)) d[hex] = structuredClone(el);
  if (withAccession && oldAcc) {
    // The order is named again inside Request Attributes Sequence items (PS3.3 Table 10-9):
    // move nested copies of the old Accession Number (and its issuer) with the top-level one.
    const acc = tags['00080050'], issuer = tags['00080051'];
    walkEls(d, (t, el, parent) => {
      if (parent === d || canonTag(t) !== '00080050') return;
      if (String(el?.Value?.[0] ?? '').trim() !== oldAcc) return;
      if (acc) parent[t] = structuredClone(acc); else delete parent[t];
      delTag(parent, '00080051');
      if (issuer) parent['00080051'] = structuredClone(issuer);
    });
  }
}
// ia, ib: the file indices of each study (groupStudies()). The first file of a study speaks for
// it, and both blocks are read before either is written.
function swapPatients(ia, ib, withAccession) {
  const a = swappedTagsOf(files[ia[0]].dict, withAccession);
  const b = swappedTagsOf(files[ib[0]].dict, withAccession);
  const writeAll = (idx, tags) => idx.forEach(i => {
    const d = files[i].dict;
    writeSwappedTags(d, tags, withAccession);
    // Patient's Age is the age at THIS study's date, so recompute it rather than move it.
    const age = ageAt(getTag(d, '00100030')?.Value?.[0], getTag(d, '00080020')?.Value?.[0]);
    if (age) setTag(d, '00101010', 'AS', age);
  });
  writeAll(ia, b);
  writeAll(ib, a);
}

// UI attributes that name WHAT the data is (a SOP class, transfer syntax, coding scheme or context
// group), not which instance: Table E.1-1 lists none of them, and rewriting one corrupts the file
// (an unknown SOP Class, a code whose scheme no longer resolves).
const NON_INSTANCE_UID_TAGS = new Set([
  '00020002', '00020010', '00020012',             // file meta: SOP Class, Transfer Syntax, Implementation
  '00080016', '0008001A', '0008001B', '00081150', // SOP Class, Related/Original Specialized, Referenced SOP Class
  '0008010C', '0008010D', '00080117', '00080118', // Coding Scheme, Context Group Extension Creator, Context, Mapping Resource
  '00080062', '0008115A',                         // SOP Classes in Study, SOP Classes Supported
  '00041510', '00041512', '0004151A',             // DICOMDIR referenced class / transfer syntax
  '04000010', '04000510',                         // MAC Calculation / Encrypted Content Transfer Syntax
]);
// Standard root, on a component boundary: 1.2.840.100089 is someone else's root.
const isStandardRoot = s => /^1\.2\.840\.10008(\.|$)/.test(s);

// opts.honourOptions (default true): an explicit K in a ticked de-identification option keeps the
// UID. Randomize and Swap are not de-identification and pass false.
function remapUIDs(opts = {}) {
  const honour = opts.honourOptions !== false;
  const map = new Map();
  const remap = (v) => {
    const s = String(v || '').trim();
    if (!s || isStandardRoot(s)) return s;
    if (!map.has(s)) map.set(s, newUID());
    return map.get(s);
  };
  for (const f of files) {
    walkEls(f.dict, (t, el) => {
      if (el.vr !== 'UI' || !el.Value) return;
      const tag = canonTag(t);
      if (NON_INSTANCE_UID_TAGS.has(tag)) return;
      // Honour an option's explicit K (e.g. Retain Device Identity keeps (0018,1002) and
      // (0018,100B)). Not resolveAction: it returns null for unlisted tags, and private or
      // vendor UIDs must still be remapped.
      if (honour && optionRetains(tag)) return;
      el.Value = el.Value.map(remap);
    });
  }
  // File Meta (0002,0003) is U too: keep the shown copy in step, and give a file whose dataset
  // has no (or an empty) SOP Instance UID (a DICOMDIR) a fresh one rather than the original.
  for (const f of files) {
    const mi = f.meta?.['00020003'];
    if (!mi?.Value) continue;
    const sop = String(getTag(f.dict, '00080018')?.Value?.[0] ?? '').trim();
    mi.Value = mi.Value.map(v => sop || remap(v));
    // An empty (0008,0018) takes the same new UID, so meta and dataset agree (PS3.10 7.1).
    if (!sop && getTag(f.dict, '00080018') && mi.Value[0]) setTag(f.dict, '00080018', 'UI', mi.Value[0]);
  }
}

// ---- Editor sync ----
// Set when a light (wheel-paging) file switch skipped the hidden Edit tab; switchTab
// catches it up before showing it.
let editorStale = false;

// syncToUI minus the Overview.
function syncEditorUI() {
  usePendingOf(files[currentFileIdx]);
  renderCompareUI();
  currentFrame = 0;
  wlSection?.classList.add('hidden');
  updateHistoryBtns?.();
  renderTable();
  if (dict) drawPreview(dict, 0);
  if (typeof updateDiag === 'function') updateDiag();
  // SR toggle visibility
  if (typeof srToggleBtn !== 'undefined' && srToggleBtn) {
    srMode = false;
    srToggleBtn.classList.remove('active');
    srView?.classList.add('hidden');
    previewBox?.classList.remove('hidden');
    srToggleBtn.classList.toggle('hidden', !detectSR?.(dict || {}));
  }
}

function syncToUI() {
  editorStale = false;
  syncEditorUI();
  if (typeof renderOverview === 'function') renderOverview();
}

