// DOM handles, global state, per-file working copies, tag/path helpers and UID prefix detection.
// ---- Elements ----
const $ = (id) => document.getElementById(id);
const T = (s) => (window.t || String)(s);   // i18n.js loads deferred, so resolve per call
// Translate a {name} template, then fill it: TF('Skipped {n} files', { n: 3 }).
const TF = (s, vars = {}) => Object.entries(vars).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), T(s));
// The pill keeps its count so i18n.js can redo the text on a language switch.
const setCountPill = (el, n) => { el.dataset.i18nN = n; el.textContent = T(el.dataset.i18nKey).replace('{n}', n); };
const body = document.body;
const dropZone = $('dropZone');
const fileInput = $('fileInput');
const folderInput = $('folderInput');
const tagBody = $('tagBody');
const tagHead = $('tagHead');
const fileNamePill = $('fileNamePill');
const fileCountPill = $('fileCountPill');
const anonymizeBtn = $('anonymizeBtn');
const randomizeBtn = $('randomizeBtn');
const swapPatientsBtn = $('swapPatientsBtn');
const previewCard = $('previewCard');
const previewBox = $('previewBox');
const previewCanvas = $('preview');
const fullscreenOverlay = $('fullscreenOverlay');
const fullscreenCanvas = $('fullscreenCanvas');
const downloadAllBtn = $('downloadAllBtn');
const batchButtonsContainer = $('batchButtons');
const logCard = $('logCard');
const logArea = $('logArea');
const uidPattern = $('uidPattern');
const uidPrefixInput = $('uidPrefixInput');
const uidPatternDisplay = $('uidPatternDisplay');
const applyPrefixBtn = $('applyPrefixBtn');
const searchInput = $('searchInput');
const filterBtns = document.querySelectorAll('.filter-btn');
const errorBanner = $('errorBanner');
const frameNav = $('frameNav');
const frameSlider = $('frameSlider');
const frameLabel = $('frameLabel');

const { DicomMessage, DicomMetaDictionary, DicomDict } = dcmjs.data;

// ---- State ----
let files = [];
let dict = null;
let meta = null;
// Working copy of tag values for the file on screen. Each file keeps its own map
// (entry.pending); this only points at it, so no file is written with another's values.
let pendingEdits = new Map();
// Index into files[] of the file compared beside the current one, or null. Both sides are editable.
let compareIdx = null;
let cmpDiffOnly = false;
let sharedUIDPrefix = '';
let detectedPattern = '';
let activeCat = 'all';
// Open sequences/items in the table, by path ('00081140' = sequence, '00081140/0' = its first item).
let seqOpen = new Set();
let searchQuery = '';
let previewImageData = null;
let currentFrame = 0;
let totalFrames = 1;

// ---- Per-file edits ----
// A working copy holds every editable tag at its current value, not just the changed ones.
function seedPending(d) {
  const m = new Map();
  if (d) for (const [t, el] of Object.entries(d)) {
    if (el && el.vr !== 'SQ' && !isBinaryVR(el.vr)) m.set(t, { vr: el.vr, valueString: elToString(el) });
  }
  return m;
}
// A file's own map, built on first use. Does not move pendingEdits, so safe for off-screen files.
function pendingOf(entry) {
  if (!entry) return new Map();
  if (!entry.pending) entry.pending = seedPending(entry.dict);
  return entry.pending;
}
function usePendingOf(entry) {
  pendingEdits = pendingOf(entry);
  return pendingEdits;
}
// dcmjs keys a dataset "00281050" or "x00281050" depending on version. Resolve the form this
// file uses; writing the other one would add a bogus second entry instead of editing the tag.
// dcmjs keys a dataset "00281050" (8 UPPERCASE hex, no 'x'). Resolve the key this file and its
// working copy already use; otherwise the canonical form, never a lowercase one (that would add a
// second element with the same tag instead of editing it).
function editKey(tag8) {
  const up = String(tag8).replace(/^x/i, '').toUpperCase();
  for (const k of [up, up.toLowerCase(), 'x' + up.toLowerCase(), 'x' + up])
    if (pendingEdits.has(k) || (dict && k in dict)) return k;
  return up;
}
// After anonymize/randomize/UID remap rewrite every dataset in place, all working copies are stale.
// Dropping nested edits too is intended: they could re-apply a value the anonymiser just removed.
// Privacy: a batch rewrite also ends the session undo of redaction / rotate, whose backups hold
// pre-rewrite pixels, UIDs and private tags that would otherwise come back under (0012,0062) YES.
function reseedAllPending() {
  for (const f of files) { f.pending = seedPending(f.dict); f.redactBackup = null; f.pixelBackup = null; }
  usePendingOf(files[currentFileIdx]);
  try { syncImgEditCard?.(); } catch (_) {}
}
// Re-seed one file's working copy from its dataset after an operation (redaction, rotate,
// invert) rewrote it, keeping every value the user typed but has not exported yet. A typed value
// survives unless the operation itself changed that tag (then the operation's value wins: a
// stale Burned In Annotation = YES must not be written back over redacted pixels).
function reseedKeepingEdits(entry) {
  const old = entry.pending;
  const before = entry._seedBefore;
  const fresh = seedPending(entry.dict);
  if (old && before) {
    old.forEach((v, k) => {
      const seeded = before.get(k);
      const isEdit = !seeded || seeded.valueString !== v.valueString || seeded.vr !== v.vr;
      if (!isEdit) return;
      if (k.includes('/')) { fresh.set(k, v); return; }
      const now = fresh.get(k);
      const untouched = seeded ? (now && now.valueString === seeded.valueString && now.vr === seeded.vr) : !now;
      if (untouched) fresh.set(k, v);
    });
  }
  delete entry._seedBefore;
  entry.rewritten = true;          // its dict changed: entryHasEdits
  entry.pending = fresh;
  if (files[currentFileIdx] === entry) usePendingOf(entry);
}
// Call before an operation that will reseedKeepingEdits(), so edits can be told from seeds.
function markSeed(entry) { entry._seedBefore = seedPending(entry.dict); }

// ---- Utilities ----
function isBinaryVR(vr) { return ['OB','OW','OF','UN','OD','OL'].includes(vr); }
function isReadOnly(tag, vr) {
  // Judge the leaf of a nested path, or pixel data inside an Icon Image Sequence would be
  // editable. This is also the last guard a path key passes before buildEditedFile.
  const t = leafTag(String(tag).toLowerCase());
  const hex = t.startsWith('x') ? t.slice(1) : t;
  if (hex.startsWith('0002')) return true;   // File Meta Information — shown for reference, not editable via dataset save
  if (t === 'x7fe00010' || t === '7fe00010') return true;
  if (vr === 'SQ') return true;
  return isBinaryVR(vr);
}
function fmtTag(t) {
  const s = t.startsWith('x') ? t.slice(1) : t;
  return '(' + s.slice(0,4).toUpperCase() + ',' + s.slice(4,8).toUpperCase() + ')';
}
// ---- Sequence paths ----
// 'tag/index/tag/index/tag' names a nested element; it is both its working-copy key and
// buildEditedFile's write path. fmtTag/descFor/catFor/dictEntry take the leaf, never the path.
function isHexTag(t) { return t.startsWith('x') || /^[0-9a-f]{8}$/i.test(t); }
function seqItems(el) { return el && el.vr === 'SQ' && Array.isArray(el.Value) ? el.Value : []; }
function leafTag(path) { return path.slice(path.lastIndexOf('/') + 1); }
// Elements of one sequence item, keyed as plain 8-hex like the top level.
function itemMap(item) {
  const m = new Map();
  if (item) for (const [t, el] of Object.entries(item)) if (isHexTag(t) && el && typeof el === 'object') m.set(t, el);
  return m;
}
// Human-readable path, e.g. '(0008,1140)[0].(0008,0100)', for exports and printed dumps.
function fmtPath(path) {
  return path.split('/').map((p, i) => i % 2 ? '[' + p + ']' : (i ? '.' : '') + fmtTag(p)).join('');
}
// Every element with sequences walked, in display order — the flat list for dumping a whole file.
function flattenTags(map, prefix = '', depth = 0, out = []) {
  for (const tag of [...map.keys()].sort((a, b) => a.localeCompare(b))) {
    const el = map.get(tag);
    const path = prefix ? prefix + '/' + tag : tag;
    out.push({ path, tag, depth, el });
    seqItems(el).forEach((item, i) => flattenTags(itemMap(item), path + '/' + i, depth + 1, out));
  }
  return out;
}
// AT values are tags (PS3.5 Table 6.2-1), read by dcmjs as one packed number: show (gggg,eeee).
const fmtAT = n => { const h = (Number(n) >>> 0).toString(16).toUpperCase().padStart(8, '0'); return `(${h.slice(0, 4)},${h.slice(4)})`; };
function elToString(el) {
  if (!el) return '';
  if (el.InlineBinary) return '<binary>';
  const v = el.Value;
  if (v == null) return '';
  if (el.vr === 'AT' && Array.isArray(v)) return v.map(x => typeof x === 'number' ? fmtAT(x) : String(x ?? '')).join('\\');
  if (Array.isArray(v)) return v.map(x => {
    if (x == null) return '';
    if (typeof x === 'object' && x !== null) {
      // PersonName stored as {Alphabetic, Ideographic, Phonetic}
      const parts = [x.Alphabetic || '', x.Ideographic, x.Phonetic].filter(c => c != null);
      return parts.join('=').replace(/=+$/, '');
    }
    return String(x);
  }).join('\\');
  return String(v);
}
// `sample` is the element's current value. PN must keep its existing shape: the vendored dcmjs
// reads PN as a string and stringifies what it writes, so an {Alphabetic} object would be
// saved as "[object Object]". Default to a string.
// Returns null for a value the VR cannot hold (out of range, not a number, not a tag): callers
// keep the element as it was rather than write a silently wrapped or zeroed number.
const INT_RANGE = { US: [0, 0xFFFF], SS: [-0x8000, 0x7FFF], UL: [0, 0xFFFFFFFF], SL: [-0x80000000, 0x7FFFFFFF] };
function parseByVR(vr, str, sample) {
  if (str == null) return [];
  // LT / ST / UT are single-valued and their leading spaces are significant (PS3.5 6.2).
  if (vr === 'LT' || vr === 'ST' || vr === 'UT') return [String(str)];
  const parts = String(str).split('\\').map(s => s.trim());
  // A cleared numeric field is a zero-length element, not a 0.
  if (/^(US|UL|SS|SL|FL|FD|AT)$/.test(vr) && !String(str).trim()) return [];
  switch (vr) {
    case 'US': case 'UL': case 'SS': case 'SL': {
      const [lo, hi] = INT_RANGE[vr];
      const out = parts.map(x => /^[+-]?\d+$/.test(x) ? Number(x) : NaN);
      return out.every(n => Number.isInteger(n) && n >= lo && n <= hi) ? out : null;
    }
    case 'FL': case 'FD': {
      const out = parts.map(x => /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(x) ? Number(x) : NaN);
      return out.every(Number.isFinite) ? out : null;
    }
    case 'AT': {
      const out = parts.map(x => {
        const m = /^\(?\s*([0-9a-f]{4})\s*,?\s*([0-9a-f]{4})\s*\)?$/i.exec(x) || /^0x([0-9a-f]{4})([0-9a-f]{4})$/i.exec(x);
        return m ? parseInt(m[1] + m[2], 16) : NaN;
      });
      return out.every(Number.isFinite) ? out : null;
    }
    case 'DS':
      // dcmjs only shortens a DS that is a number; an over-long string (some vendors write 17+
      // characters) would make the writer throw, so hand those over as numbers.
      return parts.map(x => x.length > 16 && x !== '' && Number.isFinite(Number(x)) ? Number(x) : x);
    case 'PN':
      if (!sample || typeof sample !== 'object') return parts;
      return parts.map(s => {
        const [a = '', i = '', p = ''] = s.split('=');
        const obj = { Alphabetic: a };
        if (i) obj.Ideographic = i;
        if (p) obj.Phonetic = p;
        return obj;
      });
    default: return parts;
  }
}

// ---- Dictionary lookup ----
// Repeating-group masks (50xx, 60xx, 7Fxx, 1000, 1010, 0028,04x0 …) compiled once.
let _dictMaskRe = null;
function dictMasks() {
  if (!_dictMaskRe) {
    _dictMaskRe = (window.DICOM_DICT_MASKS || []).map(
      ([mid, name, vr]) => [new RegExp('^' + mid.replace(/X/g, '[0-9A-F]') + '$'), name, vr]
    );
  }
  return _dictMaskRe;
}
// [name, vr] for a tag from every source, or null if unknown.
function dictEntry(tag) {
  const t = (tag.startsWith('x') ? tag.slice(1) : tag).toUpperCase();   // 8-char UPPERCASE hex
  // 1. Bundled PS3.6 dictionary (incl. retired tags)
  const d = window.DICOM_DICT && window.DICOM_DICT[t];
  if (d) return d;
  // 2. Repeating-group masks
  for (const [re, name, vr] of dictMasks()) if (re.test(t)) return [name, vr];
  // 3. dcmjs fallback — its dictionary is keyed "(gggg,eeee)", not plain hex
  const entry = DicomMetaDictionary.dictionary['(' + t.slice(0, 4) + ',' + t.slice(4) + ')'];
  if (entry && entry.name) return [entry.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim(), entry.vr || ''];
  // 4. Private (odd group) tags that aren't individually registered
  if (parseInt(t.slice(0, 4), 16) % 2 === 1) return ['Private Tag', ''];
  return null;
}
function descFor(tag) { const e = dictEntry(tag); return e ? e[0] : null; }
function vrForTag(tag) { const e = dictEntry(tag); return e ? e[1] : ''; }

function catFor(tag, vr) {
  const t = tag.startsWith('x') ? tag.slice(1) : tag;

  // 1. Listed exceptions (js/dictionary.js)
  const listed = TAG_CAT.get(t.toUpperCase());
  if (listed) return listed;

  if (vr === 'UI') return 'uid';

  // 3. Fall back to the group number
  const group = parseInt(t.slice(0,4), 16);
  if (group % 2 === 1) return 'private'; // Odd groups are private
  
  if (group === 0x0008) return 'study'; // or equipment/series/image mixed
  if (group === 0x0010) return 'patient';
  if (group === 0x0018) return 'series'; // or image/equipment
  if (group === 0x0020) return 'image'; // Relationship
  if (group === 0x0028) return 'image'; // Presentation
  if (group === 0x7FE0) return 'image'; // Pixel Data
  
  return 'other';
}

function log(msg, type = 'info') {
  const ts = new Date().toISOString().slice(11,19);
  logArea.textContent += `[${ts}] ${msg}\n`;
  logCard.style.display = 'block';
  logArea.scrollTop = logArea.scrollHeight;
}

// ---- UID prefix detection ----
// SOP Class, Transfer Syntax and coding-scheme UIDs name what the data is, so a new root must never
// touch them: by root (the standard's 1.2.840.10008) and by tag (a vendor's private SOP Class sits
// under the same root as its instance UIDs). NON_INSTANCE_UID_TAGS lives in image-edits.js.
const isStandardUID = s => /^1\.2\.840\.10008(\.|$)/.test(String(s));
const isInstanceUIDTag = t => !NON_INSTANCE_UID_TAGS.has(canonTag(t));

// The panel is opened from Tools ▸ UID root…; detection only says whether a shared root exists.
let uidPatternOpen = false;
function showUIDPattern(found) {
  uidPattern.style.display = found && uidPatternOpen ? 'flex' : 'none';
  const btn = $('uidPatternBtn');
  if (btn) btn.disabled = !found;
}

function detectUIDPattern() {
  const uids = [];
  for (const f of files) {
    walkEls(f.dict, (t, el) => {
      if (el.vr === 'UI' && el.Value && isInstanceUIDTag(t)) {
        el.Value.forEach(v => { v = String(v || '').trim(); if (v && !isStandardUID(v)) uids.push(v); });
      }
    });
  }
  if (!uids.length) {
    sharedUIDPrefix = '';
    showUIDPattern(false);
    return;
  }
  
  // Common prefix, cut back to the last full component
  let p = uids[0] || '';
  for (let i = 1; i < uids.length; i++) {
    let j = 0;
    while (j < p.length && j < uids[i].length && p[j] === uids[i][j]) j++;
    p = p.slice(0, j);
    if (!p) break;
  }
  const k = p.lastIndexOf('.');
  sharedUIDPrefix = k > 0 ? p.slice(0, k) : '';   // no full component in common: no shared root
  // A lone first arc ('1' or '2') is shared by nearly every UID; it says nothing about origin.
  if (!sharedUIDPrefix.includes('.')) sharedUIDPrefix = '';
  
  if (sharedUIDPrefix && uids.length > 0) {
    const suffixes = uids.map(u => u.slice(sharedUIDPrefix.length)).filter(s => s);
    const uniqueSuffixes = [...new Set(suffixes)];
    detectedPattern = `${sharedUIDPrefix}.*`;
    uidPatternDisplay.textContent = detectedPattern;
    uidPrefixInput.value = sharedUIDPrefix;
    showUIDPattern(true);
  } else {
    showUIDPattern(false);
  }
}

function applyPrefixToAll(newP) {
  // ISO/IEC 8824 (PS3.5 9): first arc 0, 1 or 2; under 0 and 1 the second arc is 0-39.
  const arcs = newP.split('.').map(Number);
  if (!/^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))+$/.test(newP) || isStandardUID(newP) ||
      arcs[0] > 2 || (arcs[0] < 2 && arcs[1] > 39)) {
    alert(T('Invalid UID prefix')); return;
  }
  const oldP = sharedUIDPrefix;
  // Only UIDs under the detected root move; anything else keeps its value, so two UIDs never merge.
  const rewrite = v => {
    const s = String(v || '').replace(/[\0 ]+$/, '');
    return oldP && !isStandardUID(s) && s.startsWith(oldP + '.') ? newP + s.slice(oldP.length) : s;
  };
  // Read through each file's unexported edits, which are folded in before the rewrite.
  const views = files.map(f => withPendingEdits(f));
  const moved = new Set();
  let m = 0;
  views.forEach(d => {
    let hit = false;
    walkEls(d, (t, el) => {
      if (el.vr !== 'UI' || !el.Value || !isInstanceUIDTag(t)) return;
      el.Value.forEach(v => { const s = String(v || '').replace(/[\0 ]+$/, ''); if (rewrite(s) !== s) { moved.add(s); hit = true; } });
    });
    if (hit) m++;
  });
  const n = moved.size;
  if (!n) return;
  const tooLong = [...moved].filter(v => rewrite(v).length > 64).length;
  if (tooLong) { alert(T('{n} UIDs would be longer than the 64 characters DICOM allows.').replace('{n}', tooLong)); return; }
  confirmDanger(T('Rewrite {n} UIDs in {m} files to start with {p}? This cannot be undone.').replace('{n}', n).replace('{m}', m).replace('{p}', newP), () => {
    // Undo only restores the open file's pending edits, so any undo step across this rewrite
    // would put that one file back on the old root and split the study.
    editHistory = []; editFuture = []; datasetDirty = true; studyRewritten = true;
    clearTimeout(editDebounceTimer); preEditSnapshot = null;
    updateHistoryBtns();
    try { renderTechRow(); } catch (_) {}
    // Typed-but-unexported edits first: reseedAllPending would otherwise drop them.
    for (const f of files) Object.assign(f.dict, withPendingEdits(f));
    for (const f of files) {
      walkEls(f.dict, (t, el) => { if (el.vr === 'UI' && el.Value && isInstanceUIDTag(t)) el.Value = el.Value.map(rewrite); });
      // Keep the shown File Meta copy of the SOP Instance UID in step; export rebuilds it anyway.
      const mi = f.meta?.['00020003'];
      if (mi?.Value) mi.Value = mi.Value.map(rewrite);
    }
    reseedAllPending();
    sharedUIDPrefix = newP;
    uidPrefixInput.value = newP;
    uidPatternDisplay.textContent = `${newP}.*`;
    renderTable();
    log(TF('Applied UID prefix: {p}', { p: newP }));
  }, 'Rewrite UIDs');
}

