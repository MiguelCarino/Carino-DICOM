// Editor features: undo/redo, file browser and series sorting, window/level, image edits,
// redaction workspace, add tag, JSON/CSV export, shortcuts and Create DICOM.

// ---- State ----
let currentFileIdx  = 0;
let editHistory     = [];
let editFuture      = [];
let editDebounceTimer = null;
let preEditSnapshot   = null;
let wcOriginal = null;
let wwOriginal = null;

// ---- Loading overlay ----
const loadOverlay = $('loadOverlay');
const loadText    = $('loadText');
function showLoading(visible, text = 'Loading…', progress, count) {
  loadOverlay.classList.toggle('visible', visible);
  if (text) loadText.textContent = T(text);
  const bw = $('loadBarWrap'), b = $('loadBar'), c = $('loadCount');
  if (bw && b) {
    if (visible && typeof progress === 'number') {
      bw.style.display = 'block';
      b.style.width = Math.max(0, Math.min(100, Math.round(progress * 100))) + '%';
    } else {
      bw.style.display = 'none';
    }
  }
  if (c) c.textContent = (visible && count) ? count : '';
}

// ---- Confirm dialog for destructive actions ----
// opts.safeDefault: Cancel has the focus and Enter means Cancel (a grant that is remembered must
// never be given by a stray Enter in a freshly focused window).
function confirmDanger(message, onConfirm, confirmLabel = 'Confirm', onCancel, opts = {}) {
  const ov = $('confirmOverlay');
  const ok = $('confirmOk');
  const cancel = $('confirmCancel');
  // Most callers pass T() text already; this catches the ones that pass the English key.
  $('confirmMsg').textContent = T(message);
  ok.textContent = T(confirmLabel);
  const close = () => {
    ov.classList.remove('visible');
    ok.onclick = null; cancel.onclick = null;
    document.removeEventListener('keydown', onKey);
  };
  // Cancel/Escape calls onCancel so an awaiting caller always gets an answer.
  const dismiss = () => { close(); onCancel?.(); };
  const onKey = e => {
    if (e.key === 'Escape') dismiss();
    else if (e.key === 'Enter') { e.preventDefault(); if (opts.safeDefault) dismiss(); else { close(); onConfirm(); } }
  };
  ok.onclick = () => { close(); onConfirm(); };
  cancel.onclick = dismiss;
  document.addEventListener('keydown', onKey);
  ov.classList.add('visible');
  (opts.safeDefault ? cancel : ok).focus();
}

// ---- Toast ----
let _toastEl = null;
let _toastTimer = null;
function toast(msg, ms = 2400) {
  if (_toastEl) _toastEl.remove();
  _toastEl = document.createElement('div');
  _toastEl.className = 'toast';
  _toastEl.textContent = T(msg);
  document.body.appendChild(_toastEl);
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { _toastEl?.remove(); _toastEl = null; }, ms);
}

// ---- Undo / Redo ----
const undoBtn = $('undoBtn');
const redoBtn = $('redoBtn');

function snapshotEdits() { return new Map(pendingEdits); }
function applySnapshot(snap) {
  pendingEdits.clear();
  snap.forEach((v, k) => pendingEdits.set(k, v));
}
function pushHistory() {
  editHistory.push(snapshotEdits());
  if (editHistory.length > 30) editHistory.shift();
  editFuture = [];
  datasetDirty = true;          // batch mutation (anonymize / randomize / remap)
  updateHistoryBtns();
  try { renderTechRow(); } catch (_) {}
}
// The undo stack holds whole working copies of the open file. After a batch rewrite (anonymize,
// randomize, swap, UID prefix), a pixel edit or a file switch, an older snapshot would stamp stale
// values (another file's identity, pre-rewrite UIDs, pre-rotation Rows/Columns) back, so it ends.
function resetEditHistory() {
  editHistory = []; editFuture = [];
  clearTimeout(editDebounceTimer); preEditSnapshot = null;
  updateHistoryBtns();
}
function updateHistoryBtns() {
  undoBtn.disabled = editHistory.length === 0;
  redoBtn.disabled = editFuture.length === 0;
}
function performUndo() {
  if (!editHistory.length) return;
  editFuture.push(snapshotEdits());
  applySnapshot(editHistory.pop());
  renderTable();
  if (dict) drawPreview(dict, currentFrame);
  updateHistoryBtns();
  toast(T('Undo'));
}
function performRedo() {
  if (!editFuture.length) return;
  editHistory.push(snapshotEdits());
  applySnapshot(editFuture.pop());
  renderTable();
  if (dict) drawPreview(dict, currentFrame);
  updateHistoryBtns();
  toast(T('Redo'));
}
undoBtn.addEventListener('click', performUndo);
redoBtn.addEventListener('click', performRedo);

// Debounced snapshot: groups rapid typing into one undo step.
function trackEditStart() {
  if (!datasetDirty) { datasetDirty = true; try { renderTechRow(); } catch (_) {} }
  if (preEditSnapshot === null) preEditSnapshot = snapshotEdits();
  clearTimeout(editDebounceTimer);
  editDebounceTimer = setTimeout(() => {
    if (preEditSnapshot !== null) {
      editHistory.push(preEditSnapshot);
      if (editHistory.length > 30) editHistory.shift();
      editFuture = [];
      preEditSnapshot = null;
      updateHistoryBtns();
    }
  }, 1500);
}

// ---- File browser ----
const fileBrowserRow = $('fileBrowserRow');
// Vertical wheel scrolls the horizontal series strip.
fileBrowserRow?.addEventListener('wheel', (e) => {
  if (!e.deltaY) return;
  e.preventDefault();
  fileBrowserRow.scrollLeft += e.deltaY;
}, { passive: false });

// Natural sort ("img9" before "img10") for files without instance numbers.
function natCmp(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

// PACS order: study (first seen), Series Number (0020,0011), series (first seen), Instance
// Number (0020,0013), then name. Study and series ranks keep each study and each series
// contiguous, so paging never steps from one patient into another.
// Safe to reorder: nothing downstream reads files[] positionally.
function sortFiles() {
  if (files.length < 2) return;
  const num = (d, tag) => {
    const v = parseInt(String(lookupTag(d, tag)?.Value?.[0] ?? '').trim(), 10);
    return Number.isFinite(v) ? v : Infinity;   // unnumbered sorts after numbered
  };
  const uidOf = (d, tag, i) => String(lookupTag(d, tag)?.Value?.[0] ?? '').trim() || ('__none_' + i);
  const studyRank = new Map(), seriesRank = new Map();
  const rank = (m, k) => { if (!m.has(k)) m.set(k, m.size); return m.get(k); };
  // Precompute keys once; lookupTag is too slow to call inside the comparator.
  const keys = new Map();
  files.forEach((f, i) => keys.set(f, {
    st: rank(studyRank, uidOf(f.dict, '0020000d', i)),
    s: num(f.dict, '00200011'),
    se: rank(seriesRank, uidOf(f.dict, '0020000e', i)),
    n: num(f.dict, '00200013'), i }));
  const cmp = (x, y) => x === y ? 0 : (x < y ? -1 : 1);   // not x - y: Infinity - Infinity is NaN
  files.sort((a, b) => {
    const A = keys.get(a), B = keys.get(b);
    return cmp(A.st, B.st) || cmp(A.s, B.s) || cmp(A.se, B.se) || cmp(A.n, B.n) || natCmp(a.name, b.name) || (A.i - B.i);
  });
}

// Group files by Study Instance UID in first-seen order (used by the Overview counter).
function groupStudies() {
  const map = new Map(), order = [];
  files.forEach((f, i) => {
    const uid = String(lookupTag(f.dict, '0020000d')?.Value?.[0] ?? '').trim() || ('__nostudy_' + i);
    let s = map.get(uid);
    if (!s) { s = { indices: [] }; map.set(uid, s); order.push(s); }
    s.indices.push(i);
  });
  return order;
}

// Group files by Series Instance UID in first-seen order.
function groupSeries() {
  const map = new Map(), order = [];
  files.forEach((f, i) => {
    const uid = (lookupTag(f.dict, '0020000e')?.Value?.[0]) || ('__noseries_' + i);
    let s = map.get(uid);
    if (!s) {
      s = {
        indices: [],
        desc: String(lookupTag(f.dict, '0008103e')?.Value?.[0] || '').trim(),
        modality: String(lookupTag(f.dict, '00080060')?.Value?.[0] || '').trim(),
        num: String(lookupTag(f.dict, '00200011')?.Value?.[0] || '').trim(),
      };
      map.set(uid, s); order.push(s);
    }
    s.indices.push(i);
  });
  return order;
}

// One tile per series (not per file); a tile jumps to its first image.
// Prev/next buttons and arrow keys still step one image at a time.
function renderFileBrowser() {
  if (!fileBrowserRow) return;
  if (files.length <= 1) { fileBrowserRow.classList.add('hidden'); updatePreviewNav?.(); return; }
  fileBrowserRow.classList.remove('hidden');
  fileBrowserRow.innerHTML = '';
  const mk = (cls, txt) => { const el = document.createElement('span'); el.className = cls; el.textContent = txt; return el; };
  for (const s of groupSeries()) {
    const active = s.indices.includes(currentFileIdx);
    const tile = document.createElement('button');
    tile.className = 'series-tile' + (active ? ' active' : '');
    const head = (s.modality || 'IMG') + (s.num ? ' · #' + s.num : '');
    const count = active
      ? (s.indices.indexOf(currentFileIdx) + 1) + ' / ' + s.indices.length
      : T('Images: {n}').replace('{n}', s.indices.length);
    tile.append(mk('st-head', head), mk('st-desc', s.desc || T('Series')), mk('st-count', count));
    tile.title = (s.desc || T('Series')) + ' — ' + T('Images: {n}').replace('{n}', s.indices.length);
    tile.addEventListener('click', () => { if (!s.indices.includes(currentFileIdx)) switchFile(s.indices[0]); });
    fileBrowserRow.appendChild(tile);
  }
  fileBrowserRow.querySelector('.series-tile.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  updatePreviewNav?.();
}

// `light` (Overview wheel paging) skips the costly tag-table rebuild and keeps the
// view's W/L; editorStale makes the Edit tab catch up when opened.
function switchFile(idx, opts) {
  if (idx === currentFileIdx || !files[idx]) return;
  // Boxes drawn on one image must never be applied to another.
  if (typeof redactUI !== 'undefined' && redactUI.active) closeRedactWorkspace?.();
  // The undo stack is the previous file's; replaying it here would write that file's values.
  resetEditHistory();
  currentFileIdx = idx;
  dict  = files[idx].dict;
  meta  = files[idx].meta;
  currentFrame = 0;
  previewImageData = null;
  previewRawData   = null;
  renderFileBrowser();
  if (opts && opts.light) {
    usePendingOf(files[idx]);
    editorStale = true;
    if (typeof updateDiag === 'function') updateDiag();
    if (typeof renderOverview === 'function') renderOverview({ hardReset: false });
    return;
  }
  syncToUI();
}

// ---- Window / Level ----
const wlSection    = $('wlSection');
const wcSlider     = $('wcSlider');
const wwSlider     = $('wwSlider');
const wcNum        = $('wcNum');
const wwNum        = $('wwNum');
const wcDisplay    = $('wcDisplay');
const wwDisplay    = $('wwDisplay');
const wlPreset     = $('wlPreset');
const wlResetBtn   = $('wlResetBtn');
const wlToggle     = $('wlToggle');
const wlSummary    = $('wlSummary');

// Collapsed by default; the open/closed choice persists per browser.
const WL_OPEN_KEY = 'carino_dicom_wl_open';
const wlOpenStored = () => { try { return localStorage.getItem(WL_OPEN_KEY) === '1'; } catch (_) { return false; } };

function setWLOpen(open) {
  wlSection?.classList.toggle('collapsed', !open);
  wlToggle?.setAttribute('aria-expanded', String(!!open));
  try { localStorage.setItem(WL_OPEN_KEY, open ? '1' : '0'); } catch (_) { /* private mode */ }
}

wlToggle?.addEventListener('click', () => setWLOpen(wlSection.classList.contains('collapsed')));
setWLOpen(wlOpenStored());

function initWLSliders() {
  if (!wlSection) return;
  // lookupTag is case-insensitive on keys (x7FE00010 vs x7fe00010).
  if (!lookupTag(dict, '7fe00010')) { wlSection.classList.add('hidden'); return; }

  // Hide for colour: Window Center/Width apply to MONOCHROME1/2 only (PS3.3 C.11.2.1.2.2).
  const piWL = String(lookupTag(dict, '00280004')?.Value?.[0] || 'MONOCHROME2').trim().toUpperCase();
  if (piWL !== 'MONOCHROME1' && piWL !== 'MONOCHROME2') { wlSection.classList.add('hidden'); return; }
  // A Window Center of 0 is a value, not a missing one.
  const fin = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  wcOriginal = fin(lookupTag(dict, '00281050')?.Value?.[0]);
  wwOriginal = fin(lookupTag(dict, '00281051')?.Value?.[0]);

  // Prefer pending edits if W/L was already changed this session.
  const wc = parseFloat(pendingEdits.get(editKey('00281050'))?.valueString ?? wcOriginal ?? 40);
  const ww = Math.max(1, parseFloat(pendingEdits.get(editKey('00281051'))?.valueString ?? wwOriginal ?? 400));

  setWL(wc, ww, false);
  wlSection.classList.remove('hidden');
}

function setWL(wc, ww, updatePending = true) {
  wc = Math.round(wc);
  ww = Math.max(1, Math.round(ww));
  // Extend slider range to fit the value.
  if (wc < parseInt(wcSlider.min)) wcSlider.min = wc;
  if (wc > parseInt(wcSlider.max)) wcSlider.max = wc;
  if (ww > parseInt(wwSlider.max)) wwSlider.max = ww;

  wcSlider.value    = wc;
  wwSlider.value    = ww;
  wcNum.value       = wc;
  wwNum.value       = ww;
  wcDisplay.textContent = wc;
  wwDisplay.textContent = ww;
  // Summary stays visible while the section is collapsed.
  if (wlSummary) wlSummary.textContent = `${wc} / ${ww}`;

  if (updatePending) {
    pendingEdits.set(editKey('00281050'), { vr: 'DS', valueString: wlValue('00281050', wc) });
    pendingEdits.set(editKey('00281051'), { vr: 'DS', valueString: wlValue('00281051', ww) });
    const wcInp = tagBody.querySelector(`[data-tag="${editKey('00281050')}"]`);
    const wwInp = tagBody.querySelector(`[data-tag="${editKey('00281051')}"]`);
    if (wcInp) wcInp.value = String(wc);
    if (wwInp) wwInp.value = String(ww);
    showDownload();
    if (dict) drawPreview(dict, currentFrame);
  }
}

// Window Center/Width may be multi-valued pairs with (0028,1055) explanations of the same count
// (PS3.3 C.11.2.1.2.2): the sliders set pair 1 and leave the others alone.
function wlValue(tag, v) {
  const cur = pendingEdits.get(editKey(tag))?.valueString ?? elToString(lookupTag(dict || {}, tag));
  const parts = String(cur ?? '').split('\\');
  if (parts.length < 2) return String(v);
  parts[0] = String(v);
  return parts.join('\\');
}
function _applyWLInput(wc, ww) {
  trackEditStart();
  pendingEdits.set(editKey('00281050'), { vr: 'DS', valueString: wlValue('00281050', wc) });
  pendingEdits.set(editKey('00281051'), { vr: 'DS', valueString: wlValue('00281051', ww) });
  const wcInp = tagBody.querySelector(`[data-tag="${editKey('00281050')}"]`);
  const wwInp = tagBody.querySelector(`[data-tag="${editKey('00281051')}"]`);
  if (wcInp) wcInp.value = String(wc);
  if (wwInp) wwInp.value = String(ww);
  showDownload();
  // Fast redraw from cached raw pixels; full decode only if there is no cache.
  if (!redrawWL(wc, ww) && dict) drawPreview(dict, currentFrame);
}

// The other control's value comes from its number box, which is never clamped to the slider's
// range or step (a typed 6000 or 40.5 stays what it is).
const WL_MAX = 1e15;           // keeps String(v) within DS's 16 characters
const wlNum = (el, fallback) => { const n = Number(el.value); return Number.isFinite(n) ? n : fallback; };
wcSlider.addEventListener('input', () => {
  const v = parseInt(wcSlider.value);
  wcNum.value = v; wcDisplay.textContent = v;
  _applyWLInput(v, Math.max(1, wlNum(wwNum, parseInt(wwSlider.value))));
});
wwSlider.addEventListener('input', () => {
  const v = Math.max(1, parseInt(wwSlider.value));
  wwNum.value = v; wwDisplay.textContent = v;
  _applyWLInput(wlNum(wcNum, parseInt(wcSlider.value)), v);
});
wcNum.addEventListener('input', () => {
  const v = Number(wcNum.value);
  if (!Number.isFinite(v) || Math.abs(v) > WL_MAX) return;
  if (v < parseInt(wcSlider.min)) wcSlider.min = v;
  if (v > parseInt(wcSlider.max)) wcSlider.max = v;
  wcSlider.value = v; wcDisplay.textContent = v;
  _applyWLInput(v, Math.max(1, wlNum(wwNum, parseInt(wwSlider.value))));
});
wwNum.addEventListener('input', () => {
  const v = Math.max(1, Number(wwNum.value));
  if (!Number.isFinite(v) || v > WL_MAX) return;
  if (v > parseInt(wwSlider.max)) wwSlider.max = v;
  wwSlider.value = v; wwDisplay.textContent = v;
  _applyWLInput(wlNum(wcNum, parseInt(wcSlider.value)), v);
});
wlPreset.addEventListener('change', () => {
  const val = wlPreset.value;
  if (!val) return;
  const [wc, ww] = val.split(',').map(Number);
  pushHistory();
  setWL(wc, ww);
  wlPreset.value = '';
});
wlResetBtn.addEventListener('click', () => {
  if (wcOriginal == null && wwOriginal == null) return;
  pushHistory();
  setWL(wcOriginal ?? 40, wwOriginal ?? 400);
  // Back to the file: a tag the file never had is not invented, and the file's own strings
  // (multi-valued, fractional) come back as they were.
  for (const t of ['00281050', '00281051']) {
    const el = lookupTag(dict, t);
    if (el) pendingEdits.set(editKey(t), { vr: el.vr || 'DS', valueString: elToString(el) });
    else pendingEdits.delete(editKey(t));
  }
  renderTable();
  if (dict) drawPreview(dict, currentFrame);
  toast(T('Window / Level reset to file values'));
});


// ---- Image edits (rotate / flip / invert, written into the pixels) ----
// Undecodable codecs disable the buttons with the reason in the title, as Redact does.
const imgEditCard = $('imgEditCard');
const imgEditUndo = $('imgEditUndo');
const IMG_EDIT_BUTTONS = { imgRotCW: 'rot90', imgRotCCW: 'rot270', imgRot180: 'rot180',
                           imgFlipH: 'flipH', imgFlipV: 'flipV' };

function syncImgEditCard() {
  if (!imgEditCard) return;
  const entry = files[currentFileIdx];
  const has = !!entry && !!lookupTag(entry.dict || {}, '7fe00010');
  imgEditCard.style.display = has ? 'block' : 'none';
  if (!has) return;
  const sup = redactionSupport(entry.meta);
  const why = sup.ok ? '' :
    `${T('This image cannot be redacted: its pixel data uses a compression this browser cannot decode.')} (${sup.codec})`;
  for (const [id, opKey] of Object.entries(IMG_EDIT_BUTTONS)) {
    const b = $(id);
    if (!b) continue;
    b.disabled = !sup.ok;
    // Enabled titles are translated via ATTR_I18N; only the refusal reason is set here.
    b.title = sup.ok ? T(PIXEL_OPS[opKey].label) : why;
  }
  const inv = $('imgInvert');
  if (inv) {
    const pi = String(lookupTag(entry.dict, '00280004')?.Value?.[0] || '').trim().toUpperCase();
    inv.disabled = pi !== 'MONOCHROME1' && pi !== 'MONOCHROME2';
  }
  // Redaction uses the same decoder, so it has the same availability and reason.
  const rb = $('imgRedact');
  if (rb) {
    rb.disabled = !sup.ok;
    rb.title = sup.ok ? T('Redact burned-in annotation') : why;
  }
  $('imgRedactUndo')
    ?.classList.toggle('hidden', !entry.redactBackup);
  // Undo names its op in the title, not the label (static i18n markup, would wrap).
  const b = entry.pixelBackup;
  imgEditUndo.classList.toggle('hidden', !b);
  if (b) imgEditUndo.title = T(b.op === 'decompress' ? 'Decompress' : PIXEL_OPS[b.op].label);
  syncCompressionRow(entry);
}

// Compression line: encoding + verdict, why, viewer warnings, and the way back to uncompressed.
function syncCompressionRow(entry) {
  const can = decompressSupport(entry);
  $('imgCompName').textContent = compressionLabel(can.info);
  $('imgCompName').title = can.info.ts;
  const notes = $('imgCompNotes');
  // The why-lines matter only when there is something to explain; plain uncompressed needs none.
  const why = can.info.compressed || can.info.everLossy ? can.info.why : [];
  notes.replaceChildren(...why.concat(can.info.warnings).map((t, i) => {
    const li = document.createElement('li');
    li.textContent = t;
    if (i >= why.length) li.className = 'warn';
    return li;
  }));
  const one = $('imgDecompress');
  one.classList.toggle('hidden', !can.info.compressed);
  one.disabled = !can.ok;
  one.title = can.ok ? T("Rewrite this file's pixels uncompressed (Explicit VR Little Endian)") : can.why;
  const n = files.filter(f => decompressSupport(f).ok).length;
  const all = $('imgDecompressAll');
  all.classList.toggle('hidden', n < 2);
  all.textContent = T('All {n}').replace('{n}', n);
  all.title = T('Decompress every loaded file that is compressed');
}

// Decompress one file or all; files that cannot be converted are listed in the log, not fatal.
async function runDecompress(list) {
  const go = async () => {
    let done = 0, before = 0, after = 0;
    for (const entry of list) {
      const res = await decompressDicom(entry);
      if (res.error) { log(`✗ ${entry.name}: ${res.error}`); continue; }
      done++; before += res.before; after += res.after;
      log(`⇲ ${entry.name}: ${res.from} → Explicit VR Little Endian` + (res.lossless === false ? ` (${T('lossy source: lost detail stays lost')})` : ''));
    }
    const mb = n => (n / 1048576).toFixed(1);
    toast(`${T('Decompressed')} ${done}/${list.length} · ${mb(before)} → ${mb(after)} MB`);
    renderTable();
    if (typeof renderOverview === 'function') renderOverview();
    if (dict) await drawPreview(dict, currentFrame);
    syncImgEditCard();
    showDownload();
  };
  const lossy = list.some(f => decompressSupport(f).info.lossless === false);
  const msg = [T('The pixels are rewritten uncompressed (Explicit VR Little Endian), so every viewer reads the values directly. Files get larger; the SOP Instance UID stays the same.')];
  if (lossy) msg.push(T('Some of these were lossy-compressed: decompressing cannot bring back what was discarded, and (0028,2110) Lossy Image Compression stays 01.'));
  confirmDanger(msg.join('\n\n'), go, 'Decompress');
}
$('imgDecompress')?.addEventListener('click', () => {
  const entry = files[currentFileIdx];
  if (entry) runDecompress([entry]);
});
$('imgDecompressAll')?.addEventListener('click', () => runDecompress(files.filter(f => decompressSupport(f).ok)));

// Decode, transform, retag, then redraw everything that reads the dataset; logged like redaction.
async function runImgEdit(opKey) {
  const entry = files[currentFileIdx];
  if (!entry) return;
  const sup = redactionSupport(entry.meta);
  if (!sup.ok) { toast(`${T('This image cannot be redacted: its pixel data uses a compression this browser cannot decode.')} (${sup.codec})`); return; }

  const go = async () => {
    const res = await applyPixelTransform(entry, opKey);
    if (res.error) { log(`✗ ${entry.name}: ${res.error}`); toast(res.error); return; }
    const label = T(PIXEL_OPS[opKey].label);
    log(`⟳ ${entry.name}: ${label} — ${res.cols}×${res.rows}, ${res.frames} frame(s)`);
    if (res.unmoved?.length)
      log(`⚠ ${T('Not moved with the pixels:')} ${res.unmoved.join(', ')}`);
    toast(label);
    // Reset the Overview's view rotate/flip, or it would compose with the baked-in transform.
    const ov = window.ovView;
    if (ov?.view) {
      ov.view.rotate = 0; ov.view.flipH = false; ov.view.flipV = false;
      $('ovFlipH')?.classList.remove('active');
      $('ovFlipV')?.classList.remove('active');
      ov.applyTransform?.();
    }
    renderTable();
    if (typeof renderOverview === 'function') renderOverview();
    if (dict) await drawPreview(dict, 0);
    currentFrame = 0;
    syncImgEditCard();
    showDownload();
  };

  // Confirm irreversible side effects (decompression, bit-depth loss, misaligned tags) in one dialog.
  const warn = [];
  if (sup.converts) warn.push(T('This image will be decompressed to uncompressed Explicit VR Little Endian: the file will be larger and its Transfer Syntax will change.'));
  if (sup.depthLoss) warn.push(T('This image was compressed with lossy JPEG; rewriting it will store 8 bits per sample.'));
  const unmoved = unmovedByTransform(entry.dict);
  if (unmoved.length) warn.push(T('These are not moved with the pixels and will no longer line up:') + ' ' + unmoved.join(', '));
  if (warn.length) confirmDanger(warn.join('\n\n'), go, 'Apply');
  else go();
}

for (const [id, opKey] of Object.entries(IMG_EDIT_BUTTONS))
  $(id)?.addEventListener('click', () => runImgEdit(opKey));

$('imgInvert')?.addEventListener('click', () => {
  const entry = files[currentFileIdx];
  if (!entry) return;
  const res = invertPhotometric(entry);
  if (res.error) { toast(res.error); return; }
  log(`◐ ${entry.name}: (0028,0004) → ${res.pi}`);
  renderTable();
  if (typeof renderOverview === 'function') renderOverview();
  if (dict) drawPreview(dict, currentFrame);
  syncImgEditCard();
  showDownload();
});

imgEditUndo?.addEventListener('click', () => {
  const entry = files[currentFileIdx];
  if (!entry || !undoPixelTransform(entry)) return;
  log(`↺ ${entry.name}: ${T('image edit undone (this session only).')}`);
  renderTable();
  if (typeof renderOverview === 'function') renderOverview();
  if (dict) drawPreview(dict, 0);
  currentFrame = 0;
  syncImgEditCard();
});

// Scroll to and highlight the card (it may be below the fold, or already visible
// where a bare scroll would look like nothing happened).
window.revealImgEditCard = function () {
  if (!imgEditCard || imgEditCard.style.display === 'none') return;
  imgEditCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  imgEditCard.classList.remove('card-called-out');
  void imgEditCard.offsetWidth;                 // restart the animation on a repeat click
  imgEditCard.classList.add('card-called-out');
};

// ---- Redaction workspace (burned-in PHI, written into the pixels) ----
// Uses the fullscreen overlay canvas: large enough to draw on, and untransformed, so
// screen->image is a single scale. Boxes are in IMAGE coordinates, as applyRedaction() expects.
const redactPanel    = $('redactPanel');
const fullscreenHint = $('fullscreenHint');
const imgRedactUndo  = $('imgRedactUndo');

// US and secondary-capture devices burn a patient banner into the top strip of the frame.
const TOP_BANNER_FRACTION = 0.10;
const MIN_BOX = 2;   // image pixels; smaller is a click, not a drag

const redactUI = { active: false, boxes: [], drag: null, metrics: null, fill: 'black', base: null };

function redactDraw() {
  if (!redactUI.active || !redactUI.base) return;
  const ctx = fullscreenCanvas.getContext('2d');
  ctx.putImageData(redactUI.base, 0, 0);
  const live = redactUI.drag && redactUI.drag.mode === 'new' ? [redactUI.drag.box] : [];
  const lw = Math.max(1, fullscreenCanvas.width / 300);
  ctx.lineWidth = lw;
  for (const b of redactUI.boxes.concat(live)) {
    // Found text left unselected (b.on === false) is outlined only: it will not be filled.
    const off = b.on === false;
    ctx.setLineDash(off ? [lw * 3, lw * 2] : []);
    if (!off) {
      ctx.fillStyle = 'rgba(220, 38, 38, .35)';
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
    ctx.strokeStyle = off ? '#eab308' : '#ef4444';
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  }
  ctx.setLineDash([]);
}

// What Apply will fill: drawn boxes, plus found text the user left selected.
const redactSelected = () => redactUI.boxes.filter(b => b.on !== false);

function redactPointToImage(clientX, clientY, box) {
  const c = fullscreenCanvas;
  if (!c.width || !c.height) return null;
  const b = box || c.getBoundingClientRect();
  if (!b.width || !b.height) return null;
  return { x: (clientX - b.left) * c.width  / b.width,
           y: (clientY - b.top)  * c.height / b.height };
}

// Intersect with the image bounds, never relocate: captured pointers can drag outside
// the canvas, and only the part over the image should be kept.
function redactClamp(b) {
  const w = fullscreenCanvas.width, h = fullscreenCanvas.height;
  if (b.w < 0) { b.x += b.w; b.w = -b.w; }
  if (b.h < 0) { b.y += b.h; b.h = -b.h; }
  const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y);
  const x1 = Math.min(w, b.x + b.w), y1 = Math.min(h, b.y + b.h);
  b.x = x0; b.y = y0;
  b.w = Math.max(0, x1 - x0); b.h = Math.max(0, y1 - y0);
  return b;
}

function redactBoxAt(pt) {
  for (let i = redactUI.boxes.length - 1; i >= 0; i--) {
    const b = redactUI.boxes[i];
    if (pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h) return b;
  }
  return null;
}

function redactUpdateCount() {
  const el = $('redactCount');
  if (el) el.textContent = String(redactSelected().length);
}

function openRedactWorkspace() {
  const entry = files[currentFileIdx];
  if (!entry) return;
  if (!previewImageData) { toast(T('The image could not be decoded for preview, so there is nothing to draw on.')); return; }
  const sup = redactionSupport(entry.meta);
  if (!sup.ok) {
    toast(`${T('This image cannot be redacted: its pixel data uses a compression this browser cannot decode.')} (${sup.codec})`);
    return;
  }
  redactUI.active = true;
  redactUI.entry = entry;        // Apply targets the file the boxes were drawn on
  redactUI.drag = null;
  redactUI.boxes = [];
  redactUI.metrics = null;
  redactUI.fill = $('redactFill')?.value || redactUI.fill;
  if (typeof ocrResetWorkspace === 'function') ocrResetWorkspace();
  // Background is the previewed frame; redaction still applies to every frame.
  redactUI.base = previewImageData.data;
  fullscreenCanvas.width  = previewImageData.width;
  fullscreenCanvas.height = previewImageData.height;
  redactUpdateCount();
  redactPanel?.classList.remove('hidden');
  fullscreenHint?.classList.add('hidden');
  fullscreenOverlay.classList.add('redacting');
  fullscreenOverlay.classList.add('visible');
  fitRedactCanvas();
  redactDraw();
}

// The CSS box (full height, at most the width) does not keep a wide image's aspect ratio on its
// own, so shrink it to the image's shape inside that box. Pointer mapping scales each axis from
// the drawn rect, so it stays exact either way.
function fitRedactCanvas() {
  const c = fullscreenCanvas;
  c.style.width = c.style.height = '';
  if (!redactUI.active || !c.width || !c.height) return;
  const r = c.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const k = Math.min(r.width / c.width, r.height / c.height);
  c.style.width = (c.width * k) + 'px';
  c.style.height = (c.height * k) + 'px';
}
window.addEventListener('resize', () => { if (redactUI.active) fitRedactCanvas(); });

function closeRedactWorkspace() {
  if (typeof ocrResetWorkspace === 'function') ocrResetWorkspace();
  redactUI.active = false;
  redactUI.entry = null;
  redactUI.drag = null;
  redactUI.boxes = [];
  redactUI.base = null;
  redactUpdateCount();
  redactPanel?.classList.add('hidden');
  fullscreenHint?.classList.remove('hidden');
  fullscreenOverlay.classList.remove('redacting');
  fullscreenOverlay.classList.remove('visible');
  fullscreenCanvas.style.width = fullscreenCanvas.style.height = '';
}

$('imgRedact')?.addEventListener('click', openRedactWorkspace);
$('redactCancel')?.addEventListener('click', closeRedactWorkspace);
$('redactClear')?.addEventListener('click', () => {
  redactUI.boxes = []; redactUpdateCount(); redactDraw();
});
$('redactFill')?.addEventListener('change', e => { redactUI.fill = e.target.value; });
$('redactTop')?.addEventListener('click', () => {
  if (!redactUI.active) return;
  redactUI.boxes.push({ x: 0, y: 0, w: fullscreenCanvas.width,
                        h: Math.max(1, Math.round(fullscreenCanvas.height * TOP_BANNER_FRACTION)) });
  redactUpdateCount(); redactDraw();
});

// Canvas rect is measured once per drag (at pointerdown) to avoid a layout per move.
fullscreenCanvas.addEventListener('pointerdown', e => {
  if (!redactUI.active) return;
  if (e.button !== 0) return;               // primary button / touch / pen only
  const metrics = fullscreenCanvas.getBoundingClientRect();
  const pt = redactPointToImage(e.clientX, e.clientY, metrics);
  if (!pt) return;
  redactUI.metrics = metrics;
  const hit = redactBoxAt(pt);
  redactUI.drag = hit
    ? { mode: 'move', box: hit, dx: pt.x - hit.x, dy: pt.y - hit.y, cx: e.clientX, cy: e.clientY }
    : { mode: 'new', box: { x: pt.x, y: pt.y, w: 0, h: 0 }, ox: pt.x, oy: pt.y };
  try { fullscreenCanvas.setPointerCapture(e.pointerId); } catch (_) {}
});
fullscreenCanvas.addEventListener('pointermove', e => {
  if (!redactUI.active || !redactUI.drag) return;
  const pt = redactPointToImage(e.clientX, e.clientY, redactUI.metrics);
  if (!pt) return;
  const dr = redactUI.drag;
  if (dr.mode === 'new') {
    dr.box.x = Math.min(dr.ox, pt.x); dr.box.y = Math.min(dr.oy, pt.y);
    dr.box.w = Math.abs(pt.x - dr.ox); dr.box.h = Math.abs(pt.y - dr.oy);
    redactClamp(dr.box);
  } else {
    // A move keeps the box's size: clamp its position so it stays on the image.
    const W = fullscreenCanvas.width, H = fullscreenCanvas.height;
    dr.box.x = Math.min(Math.max(0, pt.x - dr.dx), Math.max(0, W - dr.box.w));
    dr.box.y = Math.min(Math.max(0, pt.y - dr.dy), Math.max(0, H - dr.box.h));
  }
  redactDraw();
});
const endRedactDrag = (e) => {
  const dr = redactUI.drag;
  redactUI.drag = null;
  if (!dr) return;
  // Size-check AFTER clipping so stray clicks and off-image drags don't leave empty boxes.
  if (dr.mode === 'new') {
    const box = redactClamp(dr.box);
    if (box.w >= MIN_BOX && box.h >= MIN_BOX) redactUI.boxes.push(box);
  } else if (dr.box.w < MIN_BOX || dr.box.h < MIN_BOX) {
    redactUI.boxes.splice(redactUI.boxes.indexOf(dr.box), 1);
  } else if (dr.box.ocr && e?.type === 'pointerup' && Math.hypot(e.clientX - dr.cx, e.clientY - dr.cy) < 4) {
    // A click (not a drag) on found text selects or unselects it.
    dr.box.on = dr.box.on === false;
  }
  redactUpdateCount(); redactDraw();
};
fullscreenCanvas.addEventListener('pointerup', endRedactDrag);
fullscreenCanvas.addEventListener('pointercancel', endRedactDrag);
fullscreenCanvas.addEventListener('dblclick', e => {
  if (!redactUI.active) return;
  const pt = redactPointToImage(e.clientX, e.clientY);
  const hit = pt && redactBoxAt(pt);
  if (!hit) return;
  redactUI.boxes.splice(redactUI.boxes.indexOf(hit), 1);
  redactUpdateCount(); redactDraw();
});

// Esc and Cancel are the only exits; a backdrop click is a missed box, not a close.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !redactUI.active) return;
  // Escape on a confirm over the workspace answers the confirm, not the workspace.
  if ($('confirmOverlay')?.classList.contains('visible')) return;
  e.preventDefault(); closeRedactWorkspace();
});

let redactBusy = false;
$('redactApply')?.addEventListener('click', () => {
  const entry = redactUI.entry || files[currentFileIdx];
  if (!entry || redactBusy) return;
  if (entry !== files[currentFileIdx]) { closeRedactWorkspace(); return; }
  if (!redactSelected().length) {
    // Find's proposals may all be unselected (a de-identified file, or the user's clicks).
    toast(T(redactUI.boxes.some(b => b.ocr) ? 'Click a yellow box to select it, or draw a box.'
                                            : 'Draw at least one box first.'));
    return;
  }
  const sup = redactionSupport(entry.meta);
  // Copy now: closeRedactWorkspace() empties the array while applyRedaction is async.
  const boxes = redactSelected().map(({ x, y, w, h }) => ({ x, y, w, h }));
  // Read the control, not only its change event: a browser-restored select fires none.
  const fill = $('redactFill')?.value || redactUI.fill;
  const go = async () => {
    if (redactBusy) return;
    redactBusy = true;
    const applyBtn = $('redactApply');
    if (applyBtn) applyBtn.disabled = true;
    try {
    if (sup.depthLoss) {
      log(`⚠ ${T('This image was compressed with lossy JPEG; redacting it will store 8 bits per sample.')}`);
    }
    let res;
    try { res = await applyRedaction(entry, boxes, { fill }); }
    catch (err) { res = { error: err.message || String(err) }; }
    if (res.error) { log(`✗ ${entry.name}: ${res.error}`); toast(res.error); return; }
    const msg = T('Redacted {n} region(s) across {m} frame(s) — pixels overwritten.')
      .replace('{n}', res.boxes).replace('{m}', res.frames);
    log(`▣ ${entry.name}: ${msg}`);
    toast(msg);
    closeRedactWorkspace();
    renderTable();
    if (typeof renderOverview === 'function') renderOverview();   // re-decodes from the new pixels
    if (dict) await drawPreview(dict, currentFrame);
    syncImgEditCard();
    } finally {
      redactBusy = false;
      if (applyBtn) applyBtn.disabled = false;
    }
  };
  if (sup.converts) {
    confirmDanger(T('Redacting decompresses this image to uncompressed Explicit VR Little Endian. The file will be larger and its Transfer Syntax will change. Continue?'), go, 'Redact pixels');
  } else go();
});

imgRedactUndo?.addEventListener('click', () => {
  const entry = files[currentFileIdx];
  if (!entry || !undoRedaction(entry)) return;
  const msg = T('Redaction undone (this session only).');
  log(`↺ ${entry.name}: ${msg}`);
  toast(msg);
  renderTable();
  if (typeof renderOverview === 'function') renderOverview();
  if (dict) drawPreview(dict, currentFrame);
  syncImgEditCard();
});

// Test handle for the module-local redaction state and geometry.
window.imgRedaction = { pointToImage: redactPointToImage, open: openRedactWorkspace,
                        close: closeRedactWorkspace, redraw: redactDraw, state: redactUI };

// Single-file download (actions row, beside Download All).
$('downloadOneBtn')?.addEventListener('click', () => {
  const entry = files[currentFileIdx];
  if (entry) downloadOne(entry);
});

// ---- De-identification options ----
// A disclosure panel, not a dialog, so the options stay set between runs.
const deidOptsBtn = $('deidOptsBtn');
const deidOptionsRow = $('deidOptionsRow');
deidOptsBtn?.addEventListener('click', () => {
  deidOptionsRow.classList.toggle('hidden');
  deidOptsBtn.classList.toggle('active', !deidOptionsRow.classList.contains('hidden'));
});
// The count keeps ticked options visible while the panel is closed.
function updateDeidOptsCount() {
  const n = deidOptionsRow.querySelectorAll('input[type="checkbox"][data-opt]:checked').length;
  $('deidOptsCount').textContent = n ? ` · ${n}` : '';
}
deidOptionsRow?.addEventListener('change', updateDeidOptsCount);
updateDeidOptsCount();   // Firefox restores ticked boxes on reload without a change event

// ---- Add Tag ----
const addTagBtn     = $('addTagBtn');
const addTagRow     = $('addTagRow');
const addTagCode    = $('addTagCode');
const addTagVR      = $('addTagVR');
const addTagVal     = $('addTagVal');
const addTagConfirm = $('addTagConfirm');
const addTagCancel  = $('addTagCancel');

addTagBtn.addEventListener('click', () => {
  addTagRow.classList.toggle('hidden');
  if (!addTagRow.classList.contains('hidden')) addTagCode.focus();
});
addTagCancel.addEventListener('click', () => addTagRow.classList.add('hidden'));
addTagCode.addEventListener('keydown', e => { if (e.key === 'Enter') addTagConfirm.click(); });
addTagVal.addEventListener('keydown',  e => { if (e.key === 'Enter') addTagConfirm.click(); });

addTagConfirm.addEventListener('click', () => {
  if (!dict) { toast(T('No file loaded')); return; }
  const raw = addTagCode.value.trim().replace(/[()]/g, '').replace(',', '').replace(/\s/g, '');
  if (!/^[0-9a-fA-F]{8}$/.test(raw)) { toast(T('Invalid code — use format (GGGG,EEEE)')); return; }
  // The dcmjs key form (8 UPPERCASE hex, no 'x'): any other spelling is written under the wrong
  // tag (Tag.fromString('x00181030') is (0008,1030)). editKey finds the tag if it already exists,
  // so an add of an existing tag edits it instead of duplicating it (PS3.5 7.1).
  const key = editKey(raw);
  const g = parseInt(raw.slice(0, 4), 16);
  // Groups 0000-0007 are command / file meta / directory / reserved (PS3.5 7.1, PS3.10 7.1), and
  // Pixel Data is not a text value: neither belongs in a dataset edit.
  if (g <= 0x0007 || canonTag(raw) === '7FE00010') { toast(T('That tag cannot be added here.')); return; }
  // Prefer the dictionary's VR for a known tag (PN for Patient Name, not the default LO).
  const known = vrForTag(raw);
  const vr  = (known && /^[A-Z]{2}$/.test(known) && known !== 'SQ') ? known : addTagVR.value;
  if (isReadOnly(key, vr)) { toast(T('That tag cannot be added here.')); return; }
  const val = addTagVal.value.trim();
  pushHistory();
  // Working copy only: withPendingEdits writes it on export, and Undo removes it again.
  pendingEdits.set(key, { vr, valueString: val });
  addTagRow.classList.add('hidden');
  addTagCode.value = '';
  addTagVal.value  = '';
  renderTable();
  toast(T('Tag {tag} added').replace('{tag}', fmtTag(key)));
});

// ---- Export JSON / CSV ----
const exportJsonBtn = $('exportJsonBtn');
const exportCsvBtn  = $('exportCsvBtn');

// Same rows as the table, including File Meta (group 0002, e.g. Transfer Syntax).
function getExportRows() {
  if (!dict) return [];
  // Walk into sequences: SR content trees and the de-identification method live there.
  return flattenTags(tagsOf(files[currentFileIdx] || { dict, meta })).map(({ path, tag, el }) => ({
    tag:   fmtPath(path),
    desc:  descFor(tag) || 'Unknown',
    vr:    el.vr || '',
    value: shownValue(path, el, pendingEdits) ?? '',
  }));
}

exportJsonBtn.addEventListener('click', () => {
  if (!dict) { toast(T('No file loaded')); return; }
  const rows = getExportRows();
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = exportBaseName(files[currentFileIdx]) + '_tags.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
  toast(T('Exported JSON'));
});

exportCsvBtn.addEventListener('click', () => {
  if (!dict) { toast(T('No file loaded')); return; }
  const rows = getExportRows();
  const q = v => `"${String(v).replace(/"/g, '""')}"`;
  const csv = ['Tag,Description,VR,Value',
    ...rows.map(r => [q(r.tag), q(r.desc), q(r.vr), q(r.value)].join(','))
  ].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = exportBaseName(files[currentFileIdx]) + '_tags.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
  toast(T('Exported CSV'));
});

// ---- Keyboard shortcuts ----
document.addEventListener('keydown', e => {
  const key = e.key.toLowerCase();
  if (key === 'escape') { hideFullscreen(); return; }
  if (e.ctrlKey || e.metaKey) {
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); performUndo(); return; }
    if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); performRedo(); return; }
    if (key === 'o' && activeTab === 'editor') { e.preventDefault(); fileInput.click(); return; }
    if (key === 's' && files.length) { e.preventDefault(); downloadRange(0, files.length); return; }
  }
});

// ---- Create DICOM from images ----
createDicomBtn.addEventListener('click', async () => {
  if (!createImages.length) { alert(T('No images loaded.')); return; }
  // Said beside the button as well as in a toast: the toast is gone before the photos are fixed.
  const blocked = createBlockReason();
  showCreateBlock(blocked);
  if (blocked) { toast(blocked, 4000); return; }

  createDicomBtn.disabled = true;
  createDicomBtn.textContent = T('Creating…');

  // An order that came with a way back sends its files there; a closed worklist window
  // cannot take them, so they are downloaded as usual.
  const sendBack = !!createReturn;
  const closed = sendBack && !createReturnOpen();
  if (closed) { createReturn = null; renderCreateOrder(); }
  const made = [];
  for await (const out of createDicomOutputs()) {
    if (out.error) { alert(`Failed for ${out.name}: ${out.error}`); continue; }
    if (createReturn) { made.push(out); continue; }
    const blob = new Blob([out.buf], { type: 'application/dicom' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = out.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  if (closed) toast(T('The worklist window was closed, so the files were downloaded instead.'), 5000);

  if (made.length) {
    createDicomBtn.textContent = T('Sending…');
    try {
      await sendCreatedBack(made);
      showCreateBlock('');
      toast(T('Sent {n} file(s) back to the worklist.').replace('{n}', made.length), 4000);
      // The order is filled now; another press would be another study for it.
      createOrder = {};
      renderCreateOrder();
    } catch (err) {
      // Kept, not downloaded: the usual cause (signed out, a refusal) is fixed and retried.
      const msg = T('Not sent: {err}. Press the button again to try again.').replace('{err}', err.message || String(err));
      showCreateBlock(msg);
      toast(msg, 5000);
    }
  }

  createDicomBtn.disabled = false;
  setCreateButtonLabel();
});


// ---- Language switch ----
// i18n.js re-translates static markup (data-i18n, ATTR_I18N); text built at render time keeps the
// language it was drawn in until redrawn, so redraw what is built from T() here. Nothing is reset.
window.addEventListener('carino:langchange', () => {
  renderSeriesPanel(); renderCreateGrid(); renderCreateOrder();
  renderExtractorGrid();
  updateDeidOptsCount();
  if (!dict) return;
  renderFileBrowser();
  syncImgEditCard();          // and the compression row inside it
  renderCompareUI();
  renderTable();
  window.ovRetranslate?.();
});
