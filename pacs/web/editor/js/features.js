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
function confirmDanger(message, onConfirm, confirmLabel = 'Confirm', onCancel) {
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
    else if (e.key === 'Enter') { close(); onConfirm(); }
  };
  ok.onclick = () => { close(); onConfirm(); };
  cancel.onclick = dismiss;
  document.addEventListener('keydown', onKey);
  ov.classList.add('visible');
  ok.focus();
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

// PACS order: Series Number (0020,0011), then Instance Number (0020,0013), then name.
// Safe to reorder: nothing downstream reads files[] positionally.
function sortFiles() {
  if (files.length < 2) return;
  const num = (d, tag) => {
    const v = parseInt(String(lookupTag(d, tag)?.Value?.[0] ?? '').trim(), 10);
    return Number.isFinite(v) ? v : Infinity;   // unnumbered sorts after numbered
  };
  // Precompute keys once; lookupTag is too slow to call inside the comparator.
  const keys = new Map();
  files.forEach((f, i) => keys.set(f, { s: num(f.dict, '00200011'), n: num(f.dict, '00200013'), i }));
  const cmp = (x, y) => x === y ? 0 : (x < y ? -1 : 1);   // not x - y: Infinity - Infinity is NaN
  files.sort((a, b) => {
    const A = keys.get(a), B = keys.get(b);
    return cmp(A.s, B.s) || cmp(A.n, B.n) || natCmp(a.name, b.name) || (A.i - B.i);
  });
}

// Group files by Study Instance UID in first-seen order (used by the Overview counter).
function groupStudies() {
  const map = new Map(), order = [];
  files.forEach((f, i) => {
    const uid = (lookupTag(f.dict, '0020000d')?.Value?.[0]) || ('__nostudy_' + i);
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

  wcOriginal = parseFloat(lookupTag(dict, '00281050')?.Value?.[0]) || null;
  wwOriginal = parseFloat(lookupTag(dict, '00281051')?.Value?.[0]) || null;

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
    pendingEdits.set(editKey('00281050'), { vr: 'DS', valueString: String(wc) });
    pendingEdits.set(editKey('00281051'), { vr: 'DS', valueString: String(ww) });
    const wcInp = tagBody.querySelector(`[data-tag="${editKey('00281050')}"]`);
    const wwInp = tagBody.querySelector(`[data-tag="${editKey('00281051')}"]`);
    if (wcInp) wcInp.value = String(wc);
    if (wwInp) wwInp.value = String(ww);
    showDownload();
    if (dict) drawPreview(dict, currentFrame);
  }
}

function _applyWLInput(wc, ww) {
  trackEditStart();
  pendingEdits.set(editKey('00281050'), { vr: 'DS', valueString: String(wc) });
  pendingEdits.set(editKey('00281051'), { vr: 'DS', valueString: String(ww) });
  const wcInp = tagBody.querySelector(`[data-tag="${editKey('00281050')}"]`);
  const wwInp = tagBody.querySelector(`[data-tag="${editKey('00281051')}"]`);
  if (wcInp) wcInp.value = String(wc);
  if (wwInp) wwInp.value = String(ww);
  showDownload();
  // Fast redraw from cached raw pixels; full decode only if there is no cache.
  if (!redrawWL(wc, ww) && dict) drawPreview(dict, currentFrame);
}

wcSlider.addEventListener('input', () => {
  const v = parseInt(wcSlider.value);
  wcNum.value = v; wcDisplay.textContent = v;
  _applyWLInput(v, parseInt(wwSlider.value));
});
wwSlider.addEventListener('input', () => {
  const v = Math.max(1, parseInt(wwSlider.value));
  wwNum.value = v; wwDisplay.textContent = v;
  _applyWLInput(parseInt(wcSlider.value), v);
});
wcNum.addEventListener('input', () => {
  const v = parseInt(wcNum.value);
  if (isNaN(v)) return;
  if (v < parseInt(wcSlider.min)) wcSlider.min = v;
  if (v > parseInt(wcSlider.max)) wcSlider.max = v;
  wcSlider.value = v; wcDisplay.textContent = v;
  _applyWLInput(v, parseInt(wwSlider.value));
});
wwNum.addEventListener('input', () => {
  const v = Math.max(1, parseInt(wwNum.value));
  if (isNaN(v)) return;
  if (v > parseInt(wwSlider.max)) wwSlider.max = v;
  wwSlider.value = v; wwDisplay.textContent = v;
  _applyWLInput(parseInt(wcSlider.value), v);
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
  if (b) imgEditUndo.title = T(PIXEL_OPS[b.op].label);
}

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
  ctx.lineWidth = Math.max(1, fullscreenCanvas.width / 300);
  for (const b of redactUI.boxes.concat(live)) {
    ctx.fillStyle = 'rgba(220, 38, 38, .35)';
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = '#ef4444';
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  }
}

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
  if (el) el.textContent = String(redactUI.boxes.length);
}

function openRedactWorkspace() {
  const entry = files[currentFileIdx];
  if (!entry || !previewImageData) return;
  const sup = redactionSupport(entry.meta);
  if (!sup.ok) {
    toast(`${T('This image cannot be redacted: its pixel data uses a compression this browser cannot decode.')} (${sup.codec})`);
    return;
  }
  redactUI.active = true;
  redactUI.drag = null;
  redactUI.boxes = [];
  redactUI.metrics = null;
  // Background is the previewed frame; redaction still applies to every frame.
  redactUI.base = previewImageData.data;
  fullscreenCanvas.width  = previewImageData.width;
  fullscreenCanvas.height = previewImageData.height;
  redactUpdateCount();
  redactPanel?.classList.remove('hidden');
  fullscreenHint?.classList.add('hidden');
  fullscreenOverlay.classList.add('redacting');
  fullscreenOverlay.classList.add('visible');
  redactDraw();
}

function closeRedactWorkspace() {
  redactUI.active = false;
  redactUI.drag = null;
  redactUI.boxes = [];
  redactUI.base = null;
  redactUpdateCount();
  redactPanel?.classList.add('hidden');
  fullscreenHint?.classList.remove('hidden');
  fullscreenOverlay.classList.remove('redacting');
  fullscreenOverlay.classList.remove('visible');
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
  const metrics = fullscreenCanvas.getBoundingClientRect();
  const pt = redactPointToImage(e.clientX, e.clientY, metrics);
  if (!pt) return;
  redactUI.metrics = metrics;
  const hit = redactBoxAt(pt);
  redactUI.drag = hit
    ? { mode: 'move', box: hit, dx: pt.x - hit.x, dy: pt.y - hit.y }
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
  } else {
    dr.box.x = pt.x - dr.dx; dr.box.y = pt.y - dr.dy;
  }
  redactClamp(dr.box);
  redactDraw();
});
const endRedactDrag = () => {
  const dr = redactUI.drag;
  redactUI.drag = null;
  if (!dr) return;
  // Size-check AFTER clipping so stray clicks and off-image drags don't leave empty boxes.
  if (dr.mode === 'new') {
    const box = redactClamp(dr.box);
    if (box.w >= MIN_BOX && box.h >= MIN_BOX) redactUI.boxes.push(box);
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
  if (e.key === 'Escape' && redactUI.active) { e.preventDefault(); closeRedactWorkspace(); }
});

$('redactApply')?.addEventListener('click', () => {
  const entry = files[currentFileIdx];
  if (!entry) return;
  if (!redactUI.boxes.length) { toast(T('Draw at least one box first.')); return; }
  const sup = redactionSupport(entry.meta);
  // Copy now: closeRedactWorkspace() empties the array while applyRedaction is async.
  const boxes = redactUI.boxes.map(b => ({ ...b }));
  const go = async () => {
    if (sup.depthLoss) {
      log(`⚠ ${T('This image was compressed with lossy JPEG; redacting it will store 8 bits per sample.')}`);
    }
    const res = await applyRedaction(entry, boxes, { fill: redactUI.fill });
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
  const key = 'x' + raw.toLowerCase();
  const vr  = addTagVR.value;
  const val = addTagVal.value.trim();
  pushHistory();
  dict[key] = { vr, Value: parseByVR(vr, val, dict[key]?.Value?.[0]) };
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
  a.download = (files[currentFileIdx]?.name || 'dicom').replace(/\.[^.]+$/, '') + '_tags.json';
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
  a.download = (files[currentFileIdx]?.name || 'dicom').replace(/\.[^.]+$/, '') + '_tags.csv';
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

  const studyDate = ($('cdStudyDate').value || '').replace(/-/g, '') || nowDA();
  const commonMeta = {
    patientName:      $('cdPatientName').value.trim() || 'UNKNOWN',
    patientID:        $('cdPatientID').value.trim(),
    patientDOB:       ($('cdPatientDOB').value || '').replace(/-/g, ''),
    patientSex:       $('cdPatientSex').value,
    studyUID:         newUID(),
    studyDate,
    studyTime:        nowTM(),
    studyDescription: $('cdStudyDesc').value.trim(),
    modality:         $('cdModality').value || 'OT',
  };

  // Each series gets its own Series Instance UID.
  const seriesMetaMap = {};
  for (const s of createSeries) {
    seriesMetaMap[s.id] = { ...commonMeta, seriesUID: newUID(), seriesDescription: s.description };
  }

  createDicomBtn.disabled = true;
  createDicomBtn.textContent = T('Creating…');

  const instanceCount = {};
  for (const s of createSeries) instanceCount[s.id] = 0;

  for (let i = 0; i < createImages.length; i++) {
    const img = createImages[i];
    const seriesId = img.series || createSeries[0].id;
    const meta = seriesMetaMap[seriesId] || seriesMetaMap[createSeries[0].id];
    instanceCount[seriesId] = (instanceCount[seriesId] || 0) + 1;
    try {
      const buf  = await buildDicomFromImage(img.file, meta, instanceCount[seriesId]);
      const blob = new Blob([buf], { type: 'application/dicom' });
      const a    = document.createElement('a');
      a.href     = URL.createObjectURL(blob);
      a.download = img.file.name.replace(/\.[^.]+$/, '') + '.dcm';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    } catch (e) {
      alert(`Failed for ${img.file.name}: ${e.message || e}`);
    }
  }

  createDicomBtn.disabled = false;
  createDicomBtn.textContent = T('⬇ Create DICOM');
});

