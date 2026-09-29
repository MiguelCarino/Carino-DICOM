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
  if (po && Array.isArray(po.Value) && po.Value.length >= 2) {
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
  const overlays = Object.keys(d).some(t => /^(60[0-9A-F]{2})(3000|0010|0011|0050)$/i.test(canonTag(t)));
  if (overlays) out.push('Overlay planes (60xx,3000)');
  if (getTag(d, '00186011')) out.push('Sequence of Ultrasound Regions (0018,6011)');
  if (getTag(d, '00700001')) out.push('Graphic Annotation Sequence (0070,0001)');
  return out;
}

// Tags a transform replaces (for session undo): the redaction set plus geometry.
const PIXEL_EDIT_RESTORE_TAGS = REDACT_RESTORE_TAGS.concat(
  ['00280010', '00280011', '00280030', '00181164', '00182010', '00280034',
   '00200037', '00200032', '00200020']);
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

  const moved = transformStoredFrames(src, opKey);

  const bytesPerSample = Math.ceil(src.ba / 8);
  const frameBytes = moved.rows * moved.cols * src.spp * bytesPerSample;
  const total = frameBytes * moved.frames.length + ((frameBytes * moved.frames.length) % 2);
  const outBuf = new ArrayBuffer(total);
  const o8 = new Uint8Array(outBuf);
  moved.frames.forEach((fr, i) =>
    o8.set(new Uint8Array(fr.buffer, fr.byteOffset, fr.byteLength), i * frameBytes));

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

  entry.pending = seedPending(entry.dict);
  if (files[currentFileIdx] === entry) usePendingOf(entry);
  datasetDirty = true;

  return { op: opKey, frames: moved.frames.length, rows: moved.rows, cols: moved.cols,
           converts: !src.raw, depthLoss: !!src.depthLoss, unmoved: report };
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

  setTag(d, '00080018', 'UI', newUID());
}

// One-step, session-only undo (not a stack): restores the file as of one edit ago.
function undoPixelTransform(entry) {
  const b = entry?.pixelBackup;
  if (!b) return false;
  const d = entry.dict;
  delTag(d, '7FE00010');
  if (b.px) d['7FE00010'] = b.px;
  for (const [t, el] of Object.entries(b.tags)) { delTag(d, t); if (el) d[canonTag(t)] = el; }
  for (const [t, el] of Object.entries(b.seqs)) { delTag(d, t); if (el) d[canonTag(t)] = el; }
  if (b.retagged) {
    if (b.tsEl) entry.meta['00020010'] = b.tsEl; else delete entry.meta['00020010'];
  }
  entry.pixelBackup = null;
  entry.pending = seedPending(d);
  if (files[currentFileIdx] === entry) usePendingOf(entry);
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
  setTag(d, '00280004', 'CS', next);
  entry.pending = seedPending(d);
  if (files[currentFileIdx] === entry) usePendingOf(entry);
  datasetDirty = true;
  return { pi: next };
}

// ---- Anonymize / randomize / UID remap ----
function anonymize(d) {
  // Read before the profile pass zeroes it. Not the PS3.15 Retain Patient Characteristics
  // option (rtnPatCharsOpt): a deliberate usability default that keeps original sex and
  // writes a dummy age, neither of which identifies anyone.
  const sex = String(getTag(d, '00100040')?.Value?.[0] || '').toUpperCase();
  const keepChars = deidOptions.has('rtnPatCharsOpt');

  remPrivate(d);       // remove all private (odd-group) attributes, recursively
  applyProfile(d);     // full PS3.15 Basic Profile, recursively (UIDs remapped by remapUIDs())

  // Usability layer, applied on top of the compliant pass:
  setTag(d, '00100010', 'PN', ANON_NAME);
  // With rtnPatCharsOpt on, the real sex/age were kept (K); don't overwrite them.
  if (!keepChars) {
    setTag(d, '00100040', 'CS', sex || 'O');
    setTag(d, '00101010', 'AS', '000Y');
  }

  addDeidMeta(d);
}

function randomize(d) {
  const sex = randFrom(['M', 'F', 'O']);
  setTag(d, 'x00100010', 'PN', randName(sex));
  setTag(d, 'x00100020', 'LO', randDigits(8));
  setTag(d, 'x00100030', 'DA', `${1950 + Math.floor(Math.random() * 60)}${String(1 + Math.floor(Math.random() * 12)).padStart(2,'0')}${String(1 + Math.floor(Math.random() * 28)).padStart(2,'0')}`);
  setTag(d, 'x00100040', 'CS', sex);
  setTag(d, 'x00101010', 'AS', `${String(Math.floor(Math.random() * 90) + 1).padStart(3,'0')}Y`);
  for (const t of DATES) setTag(d, t, 'DA', nowDA());
  for (const t of TIMES) setTag(d, t, 'TM', nowTM());
  setTag(d, 'x00200010', 'SH', randDigits(6));
  setTag(d, 'x00080050', 'SH', randDigits(9));
}

function remapUIDs() {
  const map = new Map();
  for (const f of files) {
    walkEls(f.dict, (t, el) => {
      if (el.vr !== 'UI' || !el.Value) return;
      // Honour an option's explicit K (e.g. Retain Device Identity keeps (0018,1002) and
      // (0018,100B)). Not resolveAction: it returns null for unlisted tags, and private or
      // vendor UIDs must still be remapped.
      if (optionRetains(canonTag(t))) return;
      el.Value = el.Value.map(v => {
        const s = String(v || '').trim();
        if (!s) return s;
        // Standard UIDs (root 1.2.840.10008: SOP Class, Transfer Syntax) are not patient
        // data; remapping them corrupts the file. Only instance UIDs are remapped.
        if (s.startsWith('1.2.840.10008')) return s;
        if (!map.has(s)) map.set(s, newUID());
        return map.get(s);
      });
    });
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

