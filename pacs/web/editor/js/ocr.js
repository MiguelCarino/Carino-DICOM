// Find burned-in text: on-device OCR that proposes boxes for the redaction workspace.
// Nothing here writes pixels. It reads every frame, marks the words that match this file's
// own identifying attributes, and hands the boxes to redactUI; Apply still goes through
// applyRedaction(), so the pixel write, the retagging and the undo are the ones Redact has.

// Loaded on the first Find, never at page load: the engine and model are ~8 MB.
// Every path is given explicitly and same-origin. The bundles carry CDN defaults for each
// one, and an omitted option is exactly how they would be reached (vendor/README.md).
const OCR_DIR = 'vendor/tesseract/';
// Upscale small frames so overlay glyphs reach the height the LSTM model was trained on
// (a 256-px US frame burns text ~7 px tall); capped so a large CR is not made larger.
const OCR_MAX_SIDE = 2048;
const OCR_MAX_SCALE = 3;
// Unmatched words are noise unless the engine is sure: anatomy texture reads as letters.
const OCR_TEXT_MIN_CONF = 60;
const OCR_PHI_MIN_CONF = 20;

// wasm-feature-detect's SIMD probe (v128 ops). The worker has its own check, but it would
// pick the relaxed-SIMD build, which is not shipped, so the choice is made here.
function ocrSimdSupported() {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
      3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch (_) { return false; }
}

async function createOcrWorker() {
  await loadVendorScript('./' + OCR_DIR + 'tesseract.min.js');
  if (typeof window.Tesseract?.createWorker !== 'function') throw new Error('Tesseract did not load');
  const dir = new URL(OCR_DIR, location.href).href;
  const worker = await window.Tesseract.createWorker('eng', 1 /* OEM LSTM_ONLY */, {
    workerPath: dir + 'worker.min.js',
    corePath: dir + (ocrSimdSupported() ? 'tesseract-core-simd-lstm.js' : 'tesseract-core-lstm.js'),
    langPath: dir.replace(/\/$/, ''),       // fetches <langPath>/eng.traineddata.gz
    gzip: true,
    cacheMethod: 'none',                    // no copy of the model left in IndexedDB
    workerBlobURL: false,
  });
  // PSM 11, sparse text: overlays are scattered fragments, not a page of paragraphs.
  await worker.setParameters({ tessedit_pageseg_mode: '11' });
  return worker;
}

// ---- Matching ----
// Compared after folding case, accents, separators and the glyphs OCR confuses, both sides
// through the same map, so "D0E^J0HN", "doe john" and "DOEAJOHN" all meet "DOE^JOHN".
const OCR_CONFUSABLE = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
function ocrNorm(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[|!]/g, '1').replace(/[^A-Z0-9]/g, '')
    .replace(/[OQDILSBZG]/g, (c) => OCR_CONFUSABLE[c]);
}

// PS3.15 Table E.1-1 attributes a modality burns into the banner. The label is what the
// review UI and the log name a match by.
const OCR_PHI_TAGS = [
  ['00100010', 'PN', 'Patient Name'],
  ['00101001', 'PN', 'Other Patient Names'],
  ['00100020', 'ID', 'Patient ID'],
  ['00101000', 'ID', 'Other Patient IDs'],
  ['00100030', 'DA', 'Birth Date'],
  ['00080050', 'ID', 'Accession Number'],
  ['00080080', 'TEXT', 'Institution Name'],
  ['00080090', 'PN', 'Referring Physician'],
  ['00081070', 'PN', "Operators' Name"],
  ['00081050', 'PN', "Performing Physician's Name"],
  ['00081048', 'PN', 'Physician(s) of Record'],
  ['00200010', 'ID', 'Study ID'],
  ['00101010', 'AS', "Patient's Age"],
  ['00081010', 'TEXT', 'Station Name'],
  ['00080020', 'DA', 'Study Date'],
  ['00080021', 'DA', 'Series Date'],
  ['00080022', 'DA', 'Acquisition Date'],
  ['00080023', 'DA', 'Content Date'],
  ['0008002A', 'DT', 'Acquisition DateTime'],
  ['00080030', 'TM', 'Study Time'],
  ['00080031', 'TM', 'Series Time'],
  ['00080032', 'TM', 'Acquisition Time'],
  ['00080033', 'TM', 'Content Time'],
];
const OCR_MONTHS = [
  ['JAN', 'ENE'], ['FEB'], ['MAR'], ['APR', 'ABR'], ['MAY'], ['JUN'],
  ['JUL'], ['AUG', 'AGO'], ['SEP', 'SET'], ['OCT', 'OUT'], ['NOV'], ['DEC', 'DIC', 'DEZ'],
];

// A PN arrives as a string in the raw dict, or as {Alphabetic, ...} when naturalised.
function ocrValues(el) {
  return (el?.Value || []).flatMap((v) => v && typeof v === 'object'
    ? [v.Alphabetic, v.Ideographic, v.Phonetic] : [v]).filter((v) => v != null && String(v).trim());
}

// The spellings a DA value is burned in as: ISO, day-first, month-first, two-digit year,
// unpadded, and with a month abbreviation. Separators are already folded away by ocrNorm.
function ocrDateForms(da) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(da).trim());
  if (!m) return [];
  const [, y, mo, d] = m, yy = y.slice(2), ud = String(+d), um = String(+mo);
  const out = [y + mo + d, d + mo + y, mo + d + y, d + mo + yy, mo + d + yy, yy + mo + d,
               ud + um + y, um + ud + y];
  for (const mon of OCR_MONTHS[+mo - 1] || []) {
    out.push(d + mon + y, ud + mon + y, mon + d + y, mon + ud + y, d + mon + yy, y + mon + d);
  }
  return out;
}

// TM is HHMMSS.FFFFFF with seconds optional (PS3.5 6.2); banners show HH:MM:SS or HH:MM,
// so a stored HHMM is also looked for with :00 seconds.
function ocrTimeForms(tm) {
  const m = /^(\d{2})(\d{2})(\d{2})?/.exec(String(tm).trim());
  if (!m) return [];
  return [m[1] + m[2] + (m[3] || '00'), m[1] + m[2]];
}

// AS is nnnD/W/M/Y (PS3.5 6.2); a banner drops the leading zeros: "045Y" shows as "45Y".
function ocrAgeForms(as) {
  const m = /^0*(\d+)([DWMY])$/i.exec(String(as).trim());
  return m ? [String(as).trim(), m[1] + m[2]] : [];
}

// Every normalised term this file's identity could be burned in as, with the attribute it
// came from. Short terms (< 5 chars) only ever match whole words; see ocrMatchLine.
function ocrPhiTerms(d) {
  const terms = new Map();
  const add = (raw, field) => {
    const norm = ocrNorm(raw);
    if (norm.length >= 2 && !terms.has(norm)) terms.set(norm, { norm, field, short: norm.length < 5 });
  };
  const fromTag = (node, tag, kind, field) => {
    for (const v of ocrValues(getTag(node, tag))) {
      const s = String(v).trim();
      if (kind === 'PN') {
        // Family^Given^Middle^Prefix^Suffix (PS3.5 6.2.1); "=" separates the representations.
        const parts = s.split(/[\^=\s,]+/).filter(Boolean);
        parts.forEach((p) => add(p, field));
        add(s, field);
        if (parts.length >= 2) add(parts[1] + parts[0], field);   // "John Doe" order
      } else if (kind === 'DA') {
        ocrDateForms(s).forEach((f) => add(f, field));
      } else if (kind === 'TM') {
        ocrTimeForms(s).forEach((f) => add(f, field));
      } else if (kind === 'AS') {
        ocrAgeForms(s).forEach((f) => add(f, field));
      } else if (kind === 'DT') {
        ocrDateForms(s.slice(0, 8)).forEach((f) => add(f, field));
        ocrTimeForms(s.slice(8)).forEach((f) => add(f, field));
      } else {
        add(s, field);
        // An institution is burned in whole or as its distinctive words.
        if (kind === 'TEXT') s.split(/\s+/).filter((w) => w.length >= 4).forEach((w) => add(w, field));
      }
    }
  };
  for (const [tag, kind, field] of OCR_PHI_TAGS) fromTag(d, tag, kind, field);
  // Other Patient IDs Sequence (0010,1002): each item carries its own Patient ID.
  for (const item of getTag(d, '00101002')?.Value || []) {
    if (item && typeof item === 'object') fromTag(item, '00100020', 'ID', 'Other Patient IDs');
  }
  return [...terms.values()];
}

// Edit distance between a and b is at most 1 (one character misread, dropped or added).
function ocrWithinOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  const ra = a.slice(i + 1), rb = b.slice(i + 1);
  return a.length === b.length ? ra === rb
       : a.length > b.length ? ra === b.slice(i) : a.slice(i) === rb;
}

// Which words of one OCR line belong to a term. The line is searched as one folded string,
// so a name split over two words, or two words OCR ran together ("DOE^JOHN" read as
// "DOEAJOHN"), still matches. A match must start or end on a word boundary, and a short term
// must be whole words. A word counts only if the match covers most of it: "JOHN" claims
// "JOHNSON", but a stray character does not drag the label "ID" in with the ID after it.
// A banner with no space after its label is read as one word ("PT:DOE", "ID:A12"), so the
// label separators split a word into parts that are matched as words of their own; a hit on
// any part claims the whole word. Terms of 7+ characters forgive one misread, dropped or
// extra character.
function ocrMatchLine(words, terms) {
  let s = '';
  const owner = [], len = [], wordOf = [], starts = new Set(), ends = new Set();
  words.forEach((w, i) => {
    for (const part of String(w.text ?? '').split(/[:=#]/)) {
      const n = ocrNorm(part);
      if (!n) continue;
      const p = len.length;
      len.push(n.length); wordOf.push(i);
      starts.add(s.length);
      s += n;
      for (let k = 0; k < n.length; k++) owner.push(p);
      ends.add(s.length);
    }
  });
  const hit = new Array(words.length).fill(null);
  for (const t of terms) {
    const L = t.norm.length, fuzzy = L >= 7;
    for (const n of fuzzy ? [L, L - 1, L + 1] : [L]) {
      for (let i = 0; i + n <= s.length; i++) {
        const aS = starts.has(i), aE = ends.has(i + n);
        if (t.short ? !(aS && aE) : !(aS || aE)) continue;
        const span = s.slice(i, i + n);
        if (span !== t.norm && !(fuzzy && ocrWithinOne(span, t.norm))) continue;
        const got = new Map();
        for (let k = i; k < i + n; k++) got.set(owner[k], (got.get(owner[k]) || 0) + 1);
        for (const [p, c] of got) if (c * 2 > len[p]) hit[wordOf[p]] = hit[wordOf[p]] || t.field;
      }
    }
  }
  return hit;
}

// ---- Boxes ----
const ocrOverlap = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};
const ocrUnion = (a, b) => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
function ocrAbsorb(into, from) {
  Object.assign(into, ocrUnion(into, from));
  into.phi = into.phi || from.phi;
  from.fields.forEach((f) => into.fields.add(f));
  from.texts.forEach((t) => into.texts.add(t));
}

// Word detections (from every read of every frame) -> review boxes. The same word read
// twice, or in the same place on every frame, collapses into one; neighbouring words of the
// same kind on a line join; text under a PHI box becomes part of it. Padded, because OCR
// boxes hug the glyphs and anti-aliased edges would survive the fill.
function ocrMergeBoxes(dets, cols, rows) {
  const out = [];
  for (const d of dets) {
    const c = { x: d.x, y: d.y, w: d.w, h: d.h, phi: !!d.field,
                fields: new Set(d.field ? [d.field] : []), texts: new Set([d.text]) };
    const same = out.find((o) => ocrOverlap(o, c) > 0.5 * Math.min(o.w * o.h, c.w * c.h));
    if (same) ocrAbsorb(same, c); else out.push(c);
  }
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length && !merged; j++) {
        const a = out[i], b = out[j];
        const vOver = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        const gap = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
        const sameLine = vOver >= 0.5 * Math.min(a.h, b.h) && gap <= 0.8 * Math.max(a.h, b.h);
        const touching = ocrOverlap(a, b) > 0;
        if ((a.phi === b.phi && sameLine) || (a.phi !== b.phi && touching)) {
          ocrAbsorb(a, b); out.splice(j, 1); merged = true;
        }
      }
    }
  }
  return out.map((c) => {
    const pad = Math.max(2, Math.round(c.h * 0.2));
    const x0 = Math.max(0, c.x - pad), y0 = Math.max(0, c.y - pad);
    const x1 = Math.min(cols, c.x + c.w + pad), y1 = Math.min(rows, c.y + c.h + pad);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, ocr: true, phi: c.phi, on: c.phi,
             fields: [...c.fields], text: [...c.texts].join(' ') };
  });
}

// Display pixels (RGBA, stored-pixel geometry) -> upscaled greyscale canvases for two reads:
//   * the brightest pixels alone, dark on white: consoles burn text at full white, so this
//     lifts it off bright anatomy it overlaps (and LSTM Tesseract reads dark-on-light best);
//   * as shown, for everything else. No separate inverted read: Tesseract retries a line
//     inverted by itself when it reads poorly (tessedit_do_invert), and a third pass read
//     the same words again at a third more time per frame.
function* ocrInputs(rgba, cols, rows) {
  const scale = Math.max(1, Math.min(OCR_MAX_SCALE, Math.floor(OCR_MAX_SIDE / Math.max(cols, rows))));
  const n = cols * rows, grey = new Uint8ClampedArray(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    grey[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
    if (grey[i] > max) max = grey[i];
  }
  const bright = Math.max(128, max * 0.9);
  // A generator, so only one full-size canvas is alive at a time.
  for (const map of [(v) => v >= bright ? 0 : 255, (v) => v]) {
    const g = new ImageData(cols, rows);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      g.data[p] = g.data[p + 1] = g.data[p + 2] = map(grey[i]); g.data[p + 3] = 255;
    }
    const src = document.createElement('canvas');
    src.width = cols; src.height = rows;
    src.getContext('2d').putImageData(g, 0, 0);
    if (scale === 1) { yield { canvas: src, scale }; continue; }
    const c = document.createElement('canvas');
    c.width = cols * scale; c.height = rows * scale;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(src, 0, 0, c.width, c.height);
    yield { canvas: c, scale };
  }
}

// Lines of words, in IMAGE pixels (the engine's boxes divided back by the upscale).
function ocrLines(data, scale) {
  const lines = [];
  for (const b of data?.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const words = (l.words || []).map((w) => ({
      text: w.text, conf: w.confidence,
      x: w.bbox.x0 / scale, y: w.bbox.y0 / scale,
      w: (w.bbox.x1 - w.bbox.x0) / scale, h: (w.bbox.y1 - w.bbox.y0) / scale,
    })).filter((w) => ocrNorm(w.text) && w.w > 0 && w.h > 0);
    if (words.length) lines.push(words);
  }
  return lines;
}

// One recognised pass -> detections: matched words whatever the engine's confidence in them
// (a miss costs a patient's name), unmatched words only when it is sure.
function ocrClassify(lines, terms, frame) {
  const dets = [];
  for (const words of lines) {
    const hits = ocrMatchLine(words, terms);
    words.forEach((w, i) => {
      const field = hits[i];
      if (field ? w.conf < OCR_PHI_MIN_CONF : w.conf < OCR_TEXT_MIN_CONF) return;
      dets.push({ x: w.x, y: w.y, w: w.w, h: w.h, text: w.text, field, frame });
    });
  }
  return dets;
}

// ---- The run ----
// One at a time. `job` is bumped by Stop and by closing the workspace; a run that finds its
// number changed throws its results away rather than adding boxes to a closed workspace.
// Terminating the worker does not settle a recognize() already sent to it, so every wait is
// raced against `stopped`, which Stop resolves.
const ocrRun = { job: 0, worker: null, busy: false, stop: null };

function ocrStop() {
  ocrRun.job++;
  ocrRun.stop?.();
  const w = ocrRun.worker;
  ocrRun.worker = null;
  if (w) w.terminate().catch(() => {});
}

// Reads every frame of `entry`. Returns { boxes, frames, skipped, words, deidentified } with
// boxes in stored-pixel coordinates and skipped the 0-based frames that could not be decoded,
// { cancelled: true }, or { error } (also when no frame decoded: "no text" would be a lie).
// onProgress(i, n) runs before each frame.
async function findBurnedInText(entry, onProgress) {
  if (!entry?.dict) return { error: 'No file to read.' };
  const job = ++ocrRun.job;
  const live = () => job === ocrRun.job;
  const d = entry.dict, meta = entry.meta;
  const { rows, cols, numFrames } = readPixelModuleAttrs(d);
  const terms = ocrPhiTerms(d);
  // The window the user is looking at, as drawPreview uses it (pending edits are per file).
  const pend = files[currentFileIdx] === entry ? pendingEdits : pendingOf(entry);
  const wcP = pend.get(editKey('00281050')), wwP = pend.get(editKey('00281051'));
  const opts = { meta, wcOvr: wcP ? parseFloat(wcP.valueString) : undefined,
                 wwOvr: wwP ? parseFloat(wwP.valueString) : undefined };
  const stopped = new Promise((r) => { ocrRun.stop = r; });
  const unlessStopped = (p) => Promise.race([p, stopped]);
  try {
    onProgress?.(0, numFrames);
    const starting = createOcrWorker();
    const worker = await unlessStopped(starting);
    if (!live()) { starting.then((w) => w.terminate()).catch(() => {}); return { cancelled: true }; }
    ocrRun.worker = worker;
    const dets = [], skipped = [];
    let words = 0;
    for (let f = 0; f < numFrames; f++) {
      onProgress?.(f + 1, numFrames);
      const img = await unlessStopped(decodeDicomPixels(d, f, opts));
      if (!live()) return { cancelled: true };
      // Boxes are applied in stored geometry; a decode that disagrees with Rows/Columns
      // would put them in the wrong place, so that frame is not read at all.
      if (!img || img.error || img.rows !== rows || img.cols !== cols) { skipped.push(f); continue; }
      for (const { canvas, scale } of ocrInputs(img.pixels, cols, rows)) {
        const res = await unlessStopped(worker.recognize(canvas, {}, { blocks: true, text: false }));
        if (!live()) return { cancelled: true };
        const lines = ocrLines(res.data, scale);
        lines.forEach((l) => { words += l.length; });
        dets.push(...ocrClassify(lines, terms, f));
      }
    }
    // After Anonymize the tags hold placeholders, not the identity in the pixels (PS3.15
    // E.1: Patient Identity Removed (0012,0062) = YES), so nothing real can be matched.
    const deidentified = /^YES$/i.test(String(getTag(d, '00120062')?.Value?.[0] || '').trim());
    if (skipped.length === numFrames) return { error: T('No frame of this image could be decoded.') };
    return { boxes: ocrMergeBoxes(dets, cols, rows), frames: numFrames, skipped, words, deidentified };
  } catch (e) {
    if (!live()) return { cancelled: true };
    return { error: String(e?.message || e) };
  } finally {
    if (live()) {
      const w = ocrRun.worker;
      ocrRun.worker = null;
      // The worker holds the model and a wasm heap (~100 MB); a later Find starts a new one.
      if (w) await w.terminate().catch(() => {});
    }
  }
}

// ---- Workspace wiring ----
const redactFindBtn  = $('redactFind');
const redactStopBtn  = $('redactFindStop');
const redactFindNote = $('redactFindStatus');

function ocrSetBusy(busy) {
  ocrRun.busy = busy;
  if (redactFindBtn) redactFindBtn.disabled = busy;
  redactStopBtn?.classList.toggle('hidden', !busy);
}
function ocrStatus(msg) { if (redactFindNote) redactFindNote.textContent = msg; }

async function ocrFindInWorkspace() {
  const entry = files[currentFileIdx];
  if (!redactUI.active || !entry || ocrRun.busy) return;
  ocrSetBusy(true);
  ocrStatus(T('Loading the text reader…'));
  const res = await findBurnedInText(entry, (i, n) => {
    if (i) ocrStatus(T('Reading frame {i} of {n}…').replace('{i}', i).replace('{n}', n));
  });
  // Stopped: Stop already reset the controls, and a newer run may own them by now.
  if (res.cancelled) return;
  ocrSetBusy(false);
  if (res.error) {
    ocrStatus(T('Text could not be read: {e}').replace('{e}', res.error));
    log(`✗ ${entry.name}: ${T('Text could not be read: {e}').replace('{e}', res.error)}`);
    return;
  }
  // A second Find replaces the first one's proposals; boxes drawn by hand stay.
  redactUI.boxes = redactUI.boxes.filter((b) => !b.ocr).concat(res.boxes);
  const phi = res.boxes.filter((b) => b.phi).length;
  const msg = res.boxes.length
    ? T('Found {n} piece(s) of text; {m} match this patient and are selected. Check the whole image: text can be missed.')
        .replace('{n}', res.boxes.length).replace('{m}', phi)
    : T('No text found. Check the whole image yourself: text can be missed.');
  let note = res.deidentified
    ? ' ' + T('This file is already de-identified, so its tags no longer hold the patient details to match. Select the boxes yourself.')
    : '';
  // Apply still fills (and retags) frames OCR never saw, so the user must check those.
  if (res.skipped.length) {
    const list = res.skipped.slice(0, 10).map((f) => f + 1).join(', ') + (res.skipped.length > 10 ? ', …' : '');
    note += ' ' + T('Frame(s) {list} could not be read; check them yourself.').replace('{list}', list);
  }
  ocrStatus(msg + note);
  log(`▣ ${entry.name}: ${msg}${note}`);
  redactUpdateCount();
  redactDraw();
}

redactFindBtn?.addEventListener('click', () => {
  redactUI.finding = ocrFindInWorkspace();
});
redactStopBtn?.addEventListener('click', () => {
  if (!ocrRun.busy) return;
  ocrStop();
  ocrSetBusy(false);
  ocrStatus(T('Stopped. No boxes were added.'));
});

// Clear boxes takes the proposals with it, so their summary goes too.
$('redactClear')?.addEventListener('click', () => { if (!ocrRun.busy) ocrStatus(''); });

// Closing the workspace ends any run and clears its note.
function ocrResetWorkspace() {
  if (ocrRun.busy) { ocrStop(); ocrSetBusy(false); }
  ocrStatus('');
}

// Test handle (tests/suites/ocr.js).
window.imgOcr = { terms: ocrPhiTerms, norm: ocrNorm, matchLine: ocrMatchLine,
                  merge: ocrMergeBoxes, find: findBurnedInText, stop: ocrStop, run: ocrRun };
