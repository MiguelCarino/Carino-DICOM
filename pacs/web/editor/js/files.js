// File loading (files and folders), SHA-256 integrity, and building/saving edited files.

// ---- File integrity (SHA-256) ----
// Hash of the ORIGINAL loaded bytes (matches `sha256sum file.dcm`) for chain of custody.
// Edits never change it; the UI shows a "working copy edited" note when dirty.
const SHA_AUTO_LIMIT = 64 * 1024 * 1024;   // hash on load below this; button above
let datasetDirty = false;                  // any edit/anonymize/randomize this session
let studyRewritten = false;                // a whole-study rewrite (randomize, swap, UID root) this session

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('');
}

// `buf` may be passed to avoid re-reading the file.
async function computeEntrySha(entry, buf) {
  if (!entry || entry.shaState === 'computing') return;
  entry.shaState = 'computing';
  if (typeof renderOverview === 'function' && files[currentFileIdx] === entry) { try { renderTechRow(); } catch (_) {} }
  try {
    const data = buf || (entry.file ? await entry.file.arrayBuffer() : null);
    entry.sha = data ? await sha256Hex(data) : null;
    entry.shaState = entry.sha ? 'done' : 'unavailable';
  } catch (_) { entry.sha = null; entry.shaState = 'unavailable'; }
  if (files[currentFileIdx] === entry) { try { renderTechRow(); } catch (_) {} }
}
// Re-render just the Technical card (defined inside the overview IIFE).
function renderTechRow() { if (typeof window.__ovRenderTech === 'function') window.__ovRenderTech(); }

// Called by the "compute hash" button shown for large (deferred) files.
window.__computeSha = function () { computeEntrySha(files[currentFileIdx]); };

// ---- Folder loading ----
// CD/PACS exports are trees of extensionless files plus a DICOMDIR and other junk,
// so files are identified by content, never by name.
const MAX_SCAN_FILES = 20000;  // past this a "folder" is a mistake, not a study
const LARGE_STUDY    = 400;    // past this we ask before spending the memory

// Deliberately NOT async: the browser empties dataTransfer.items once the drop handler
// returns, so items must be read synchronously before any await.
// Returns null for an empty drop, else a Promise of { items: [{file, path}], fromFolder, truncated }.
function collectDropped(dt) {
  if (!dt) return null;
  const flat = Array.from(dt.files || []).map(f => ({ file: f, path: f.webkitRelativePath || f.name }));
  const entries = [];
  for (const it of Array.from(dt.items || [])) {
    if (it.kind !== 'file') continue;
    const e = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
    if (e) entries.push(e);
  }
  // Scripted DataTransfers (tests, synthetic drops) return null entries; this path is required.
  if (!entries.length) {
    return flat.length ? Promise.resolve({ items: flat, fromFolder: false, truncated: false }) : null;
  }
  return (async () => {
    const out = [];
    for (const e of entries) await walkEntry(e, '', out);
    return { items: out, fromFolder: entries.some(e => e.isDirectory), truncated: out.length >= MAX_SCAN_FILES };
  })();
}

// readEntries returns partial batches (100 in Chrome); call until it returns none.
async function readAllEntries(reader) {
  const all = [];
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch || !batch.length) return all;
    all.push(...batch);
    if (all.length >= MAX_SCAN_FILES) return all;
  }
}

// Depth-first walk; carries the path so each file keeps its series folder.
async function walkEntry(entry, prefix, out) {
  if (!entry || out.length >= MAX_SCAN_FILES) return;
  if (entry.isFile) {
    try {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + entry.name });
    } catch (_) { /* unreadable file: skip */ }
    return;
  }
  if (!entry.isDirectory) return;
  const kids = await readAllEntries(entry.createReader());
  for (const k of kids) {
    if (out.length >= MAX_SCAN_FILES) return;
    await walkEntry(k, prefix + entry.name + '/', out);
  }
}

// "DICM" at offset 128 (PS3.10 7.1): the same check dcmjs readFile makes, so this rejects
// exactly what the parser would, at the cost of 4 bytes instead of a whole file.
async function isDicomFile(file) {
  if (!file || file.size < 132) return false;
  try {
    const b = new Uint8Array(await file.slice(128, 132).arrayBuffer());
    return b[0] === 0x44 && b[1] === 0x49 && b[2] === 0x43 && b[3] === 0x4D;
  } catch (_) { return false; }
}

// DICOMDIR is the disc index (no pixels) and would sort first as files[0]; the walk already
// found every file it references. Kept only if it is the only file.
function withoutDiscIndex(items) {
  const rest = items.filter(it => !/^DICOMDIR$/i.test(it.file.name));
  return rest.length ? rest : items;
}

// Folder loads are filtered to DICOM here; explicitly picked files go straight to
// handleFiles so any failure shows in its per-file banner.
async function loadStudy(res) {
  if (!res || !res.items || !res.items.length) return;
  if (!res.fromFolder) return handleFiles(res.items);

  const all = withoutDiscIndex(res.items);
  const skippedIndex = res.items.length - all.length;

  const keep = [];
  showLoading?.(true, 'Scanning folder…', 0, `0 / ${all.length}`);
  for (let i = 0; i < all.length; i++) {
    if (await isDicomFile(all[i].file)) keep.push(all[i]);
    // Update progress every 25 files; per-file repaint costs more than the sniff.
    if (i % 25 === 24 || i === all.length - 1) {
      showLoading?.(true, 'Scanning folder…', (i + 1) / all.length, `${i + 1} / ${all.length}`);
    }
  }
  showLoading?.(false);

  const junk = all.length - keep.length;
  if (!keep.length) { toast?.(T('No DICOM files in that folder')); return; }

  // Ask before handleFiles: once anything parses it replaces files, edits and history.
  if (keep.length > LARGE_STUDY) {
    const go = await new Promise(resolve => confirmDanger(
      T('This folder holds {n} DICOM files. Loading all of them may take a while and use a lot of memory.').replace('{n}', keep.length),
      () => resolve(true), 'Load all', () => resolve(false)));
    if (!go) return;
  }

  await handleFiles(keep);

  // Logged after handleFiles, which clears the log.
  if (skippedIndex) log(T('Skipped DICOMDIR (the disc index, not an image)'));
  // Non-DICOM files go to the log, not the failure banner (reserved for real parse failures).
  if (junk) log(TF('Skipped {n} non-DICOM file(s) in the folder', { n: junk }));
  if (res.truncated) {
    log(TF('Folder scan stopped at {n} files', { n: MAX_SCAN_FILES }));
    toast?.(T('Only the first {n} files in that folder were scanned.').replace('{n}', MAX_SCAN_FILES));
  }
}

// Open means replace, so ask first when that would lose work. W/L presets and copy-to-B
// write the working copy without marking the dataset dirty, hence the comparison.
function hasUnsavedWork() {
  if (datasetDirty || editHistory.length) return true;
  return files.some(f => {
    if (!f.pending) return false;
    const seed = seedPending(f.dict);
    for (const [k, v] of f.pending) if (seed.get(k)?.valueString !== v.valueString) return true;
    return false;
  });
}
// One file's edits, for handing that file on (Open in Files): datasetDirty and the
// undo stack are study-wide, so an edit to file A must not make file B look edited.
// A dict rewrite (pixel edits, redaction, compression) goes through reseedKeepingEdits,
// which marks its entry; a de-identified file says so; typed edits differ from the seed.
function entryHasEdits(entry) {
  if (!entry) return false;
  if (studyRewritten || entry.deid || entry.rewritten) return true;
  if (entry === files[currentFileIdx] && (editHistory.length || preEditSnapshot !== null)) return true;
  if (!entry.pending) return false;
  const seed = seedPending(entry.dict);
  for (const [k, v] of entry.pending) if (seed.get(k)?.valueString !== v.valueString) return true;
  return false;
}
// Every UI path that opens a study comes through here. handleFiles and loadStudy never
// ask: deep links and the test suites call them directly.
function openStudy(res) {
  if (!res?.items?.length) return Promise.resolve();
  if (!hasUnsavedWork()) return loadStudy(res);
  return new Promise(resolve => confirmDanger(
    T('Opening these files replaces the study you have open. Any edits you have not exported will be discarded.'),
    () => resolve(loadStudy(res)), 'Discard and open', () => resolve()));
}
// Set by a reload the user has already confirmed (the self-test link). A finished
// self-test (window.SELFTEST) holds only its own files.
let unloadConfirmed = false;
// Skipped under Electron, which cancels the close without showing any prompt.
window.addEventListener('beforeunload', e => {
  if (window.carinoDesktop || window.SELFTEST || unloadConfirmed || !hasUnsavedWork()) return;
  e.preventDefault();
  e.returnValue = '';
});

// ---- File handling ----
// Wipes the loaded study, pending edits, undo history and the per-study UI.
function resetStudyState() {
  files = [];
  dict = meta = null;
  currentFileIdx = 0;
  compareIdx = null;
  cmpDiffOnly = false;
  pendingEdits = new Map();
  // Cleared per study, not per switchFile, so open sequences stay open while paging slices.
  seqOpen.clear();
  tagBody.innerHTML = '';
  previewCard.style.display = 'none';
  syncImgEditCard?.();
  logArea.textContent = '';
  logCard.style.display = 'none';
  previewImageData = null;
  previewRawData   = null;
  currentFrame = 0;
  totalFrames = 1;
  errorBanner.className = 'hidden';
  editHistory = [];
  editFuture  = [];
  datasetDirty = false;
  studyRewritten = false;
  dropZone.classList.remove('compact');
}

// Accepts a FileList/File[] or folder-walk {file, path} items; normalize to the latter.
function toLoadItems(list) {
  return Array.from(list || []).map(x => (x instanceof Blob) ? { file: x, path: x.webkitRelativePath || x.name } : x);
}

// Read ahead so disk reads overlap parsing (modest gain; more on slow shares).
// Bounded by count AND bytes; the head file always passes so one huge file can't deadlock.
// The file being parsed stays in queuedBytes until release(slot).
function createReadAheadQueue(arr) {
  const READ_AHEAD = 4, READ_AHEAD_BYTES = 64 * 1024 * 1024;
  const queue = [];
  let queuedBytes = 0, nextRead = 0;
  const fillQueue = () => {
    while (nextRead < arr.length && queue.length < READ_AHEAD &&
           (!queue.length || queuedBytes + (arr[nextRead]?.file?.size || 0) <= READ_AHEAD_BYTES)) {
      const f = arr[nextRead++]?.file;
      const size = f?.size || 0;
      let p;
      // Avoid an unhandled rejection; the await in handleFiles re-throws into the per-file catch.
      try { p = f.arrayBuffer(); } catch (e) { p = Promise.reject(e); }
      p.catch(() => {});
      queuedBytes += size;
      queue.push({ p, size });
    }
  };
  fillQueue();
  return {
    // Takes the head slot and tops the queue back up.
    next() { const slot = queue.shift(); fillQueue(); return slot; },
    release(slot) { queuedBytes -= slot.size; },
  };
}

// Parses one read buffer into a files[] entry; throws on a bad file.
function parseEntry(file, path, buf) {
  // The hash below is of the file as loaded, so only the parser sees the normalised copy.
  const msg = DicomMessage.readFile(definedLengthUN(buf));
  normBin(msg.dict);
  if (metaTS(msg.meta) === '1.2.840.10008.1.2') fixImplicitSignedXS(msg.dict);
  // Keep the File handle (not bytes) for on-demand hashing. `name` stays the basename
  // because downloadOne uses it as a.download (no slashes); `path` is display-only.
  const entry = { name: file.name, path, dict: msg.dict, meta: msg.meta || {}, pending: seedPending(msg.dict), file, size: file.size, sha: null, shaState: file.size <= SHA_AUTO_LIMIT ? 'idle' : 'deferred' };
  if (entry.shaState === 'idle') computeEntrySha(entry, buf);   // fire-and-forget
  return entry;
}

// Failures are only known as parse errors; the name or MIME says it was a picture.
// PS3.5 6.2.2 Note 5: in an explicit VR dataset a UN element may have undefined length, and its
// value is then an implicit VR LE sequence ending in a Sequence Delimitation Item. The vendored
// dcmjs parser throws on it ("Offset is outside the bounds"), so the file could not be opened at
// all. Rewrite each such element to the equivalent defined-length UN (same items, delimiter
// dropped, enclosing defined lengths corrected); the app then sees an opaque UN sequence, which
// Anonymize removes. Returns buf itself when there is nothing to do (the usual case: one byte scan).
const UN_UNDEF = [0x55, 0x4E, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF];   // 'UN' 0000 FFFFFFFF
const LONG_VRS = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
function definedLengthUN(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length < 140 || u8[128] !== 0x44 || u8[129] !== 0x49 || u8[130] !== 0x43 || u8[131] !== 0x4D) return buf;
  let hit = false;
  outer: for (let i = 132; i + 8 <= u8.length; i++) {
    if (u8[i] !== 0x55) continue;
    for (let k = 1; k < 8; k++) if (u8[i + k] !== UN_UNDEF[k]) continue outer;
    hit = true; break;
  }
  if (!hit) return buf;
  try {
    const dv = new DataView(buf);
    const U = 0xFFFFFFFF;
    const vrAt = p => String.fromCharCode(u8[p], u8[p + 1]);
    // File Meta (always explicit VR LE): skip it and read the Transfer Syntax.
    let pos = 132, ts = '';
    while (pos + 8 <= u8.length && dv.getUint16(pos, true) === 0x0002) {
      const vr = vrAt(pos + 4), long = LONG_VRS.has(vr);
      const len = long ? dv.getUint32(pos + 8, true) : dv.getUint16(pos + 6, true);
      const hdr = long ? 12 : 8;
      if (dv.getUint16(pos + 2, true) === 0x0010)
        ts = String.fromCharCode(...u8.subarray(pos + hdr, pos + hdr + len)).replace(/[\0 ]+$/, '');
      pos += hdr + len;
    }
    // Explicit VR Little Endian datasets only (big endian and deflated are left to dcmjs).
    if (ts === '1.2.840.10008.1.2' || ts === '1.2.840.10008.1.2.2' || ts === '1.2.840.10008.1.2.1.99') return buf;
    const isTag = (p, e) => dv.getUint16(p, true) === 0xFFFE && dv.getUint16(p + 2, true) === e;
    // Implicit VR LE content of an undefined-length element: returns the offset of its E0DD.
    const implicitSeqEnd = (p) => {
      for (;;) {
        if (isTag(p, 0xE0DD)) return p;
        if (!isTag(p, 0xE000)) throw new Error('not an item');
        const len = dv.getUint32(p + 4, true);
        p = len === U ? implicitItemEnd(p + 8) : p + 8 + len;
      }
    };
    const implicitItemEnd = (p) => {
      for (;;) {
        if (isTag(p, 0xE00D)) return p + 8;
        const len = dv.getUint32(p + 4, true);
        p = len === U ? implicitSeqEnd(p + 8) + 8 : p + 8 + len;
      }
    };
    const head = (p, n) => u8.slice(p, p + n);
    const withLen32 = (bytes, off, len) => { new DataView(bytes.buffer).setUint32(off, len, true); return bytes; };
    const size = parts => parts.reduce((n, b) => n + b.length, 0);
    // Explicit VR elements in [p, end); stops after an Item Delimitation when inItem.
    const elements = (p, end, inItem) => {
      const out = [];
      while (p + 8 <= end) {
        if (inItem && isTag(p, 0xE00D)) { out.push(head(p, 8)); return { out, p: p + 8 }; }
        const vr = vrAt(p + 4), long = LONG_VRS.has(vr);
        const hdr = long ? 12 : 8;
        const len = long ? dv.getUint32(p + 8, true) : dv.getUint16(p + 6, true);
        if (len === U && long) {
          if (vr === 'UN') {
            const stop = implicitSeqEnd(p + 12);
            const body = u8.slice(p + 12, stop);
            out.push(withLen32(head(p, 12), 8, body.length), body);
            p = stop + 8;
          } else if (vr === 'SQ') {
            out.push(head(p, 12));
            p += 12;
            for (;;) {
              if (isTag(p, 0xE0DD)) { out.push(head(p, 8)); p += 8; break; }
              if (!isTag(p, 0xE000)) throw new Error('not an item');
              const ilen = dv.getUint32(p + 4, true);
              if (ilen === U) {
                const sub = elements(p + 8, end, true);
                out.push(head(p, 8), ...sub.out); p = sub.p;
              } else {
                const sub = elements(p + 8, p + 8 + ilen, false);
                out.push(withLen32(head(p, 8), 4, size(sub.out)), ...sub.out); p = p + 8 + ilen;
              }
            }
          } else {
            // Encapsulated Pixel Data: fragments copied as they are.
            let q = p + 12;
            while (!isTag(q, 0xE0DD)) q += 8 + dv.getUint32(q + 4, true);
            out.push(u8.slice(p, q + 8)); p = q + 8;
          }
        } else if (vr === 'SQ') {
          // Defined-length sequence: its items may hold the element being rewritten.
          const stop = Math.min(p + hdr + len, end), items = [];
          let q = p + hdr;
          while (q + 8 <= stop) {
            const ilen = dv.getUint32(q + 4, true);
            if (ilen === U) {
              const sub = elements(q + 8, stop, true);
              items.push(head(q, 8), ...sub.out); q = sub.p;
            } else {
              const sub = elements(q + 8, Math.min(q + 8 + ilen, stop), false);
              items.push(withLen32(head(q, 8), 4, size(sub.out)), ...sub.out); q = q + 8 + ilen;
            }
          }
          out.push(withLen32(head(p, 12), 8, size(items)), ...items); p = stop;
        } else {
          out.push(u8.slice(p, Math.min(p + hdr + len, end))); p += hdr + len;
        }
      }
      if (p < end) out.push(u8.slice(p, end));
      return { out, p };
    };
    const { out } = elements(pos, u8.length, false);
    const parts = [u8.subarray(0, pos), ...out];
    const res = new Uint8Array(size(parts));
    let o = 0;
    for (const b of parts) { res.set(b, o); o += b.length; }
    return res.buffer;
  } catch (_) {
    return buf;               // not the structure expected: let the parser report it
  }
}

const isImageFile = (file) => /^image\//.test(file?.type || '') ||
  /\.(png|jpe?g|gif|bmp|webp|tiff?|heic|heif|avif)$/i.test(file?.name || '');

// Implicit VR carries no VR, and dcmjs reads the 'US or SS' attributes as US. With Pixel
// Representation 1 they are signed (PS3.3 C.7.6.3 / PS3.6), so a Pixel Padding Value of -2000
// would otherwise be exported as explicit US 63536. LUT Descriptors: only value 2 is signed.
const XS_TAGS = ['00280106', '00280107', '00280108', '00280109', '00280110', '00280111',
                 '00280120', '00280121', '00409211', '00409216'];
const XS_DESCRIPTOR_TAGS = ['00281101', '00281102', '00281103', '00283002'];
function fixImplicitSignedXS(d) {
  if (Number(getTag(d, '00280103')?.Value?.[0]) !== 1) return;
  const signed = v => (typeof v === 'number' && v >= 32768 && v < 65536) ? v - 65536 : v;
  walkEls(d, (t, el, parent) => {
    const tag = canonTag(t);
    if (el.vr !== 'US' || !Array.isArray(el.Value)) return;
    if (XS_TAGS.includes(tag)) parent[t] = { ...el, vr: 'SS', Value: el.Value.map(signed) };
    else if (XS_DESCRIPTOR_TAGS.includes(tag) && el.Value.length >= 2 && el.Value[1] >= 32768 &&
             el.Value.every((v, i) => i === 1 || v < 32768)) {
      // US/SS/US: the first-mapped value is the one that is signed; the element stays US-typed
      // only if it can, so write it SS with the other two (< 32768 in practice) unchanged.
      parent[t] = { ...el, vr: 'SS', Value: el.Value.map((v, i) => i === 1 ? signed(v) : v) };
    }
  });
}

// File names and parser messages come from the file (a folder name, a crafted name, the file's
// own Specific Character Set echoed by dcmjs), so they are only ever text, never markup.
function renderLoadFailures(failures, note) {
  errorBanner.className = 'error-banner';
  const summary = document.createElement('summary');
  summary.textContent = `⚠ ${failures.length} file${failures.length > 1 ? 's' : ''} failed to load — click to expand`;
  const ul = document.createElement('ul');
  for (const f of failures) {
    const li = document.createElement('li');
    li.textContent = `${f.name}: ${f.error}`;
    ul.appendChild(li);
  }
  if (note) { const li = document.createElement('li'); li.textContent = note; ul.appendChild(li); }
  errorBanner.replaceChildren(summary, ul);
}

function showLoadedStudy() {
  // Sort before reading files[0] so the first image of the first series is shown.
  sortFiles();

  dict = files[0].dict;
  meta = files[0].meta;

  fileNamePill.textContent = files.length === 1 ? files[0].name : `${files[0].name} (+${files.length - 1})`;
  setCountPill(fileCountPill, files.length);
  dropZone.classList.add('compact');

  renderFileBrowser?.();
  syncToUI();
}

// Parses everything first and replaces the open study only if at least one file
// parsed, so a stray JPEG can't wipe the study, its edits and undo history.
// The old study stays in memory until the swap. Returns the number of files loaded.
async function handleFiles(list) {
  const arr = toLoadItems(list);
  if (!arr.length) return 0;

  const loadingMsg = arr.length > 1 ? 'Loading images…' : 'Loading image…';
  showLoading?.(true, loadingMsg, 0, `0 / ${arr.length}`);

  const parsed = [], failures = [];
  // Logged after the reset below, which clears the log.
  const lines = [TF('Loading {n} file(s)...', { n: arr.length })];
  const reads = createReadAheadQueue(arr);

  let lastYield = performance.now();
  for (let i = 0; i < arr.length; i++) {
    const { file, path } = arr[i];
    showLoading?.(true, loadingMsg, (i + 1) / arr.length, `${i + 1} / ${arr.length}`);
    // Pre-read buffers resolve as microtasks and never yield a frame; yield a real
    // task every ~100 ms so the progress overlay repaints.
    if (performance.now() - lastYield > 100) {
      await new Promise(r => setTimeout(r));
      lastYield = performance.now();
    }
    const slot = reads.next();
    try {
      parsed.push(parseEntry(file, path, await slot.p));
      lines.push(`✓ ${path}`);
    } catch (e) {
      const image = isImageFile(file);
      const errMsg = image ? T('an image, not DICOM: use Create →') : (e.message || String(e));
      // Path, not name: same-named slices from different series folders stay distinct.
      failures.push({ name: path, error: errMsg, image });
      lines.push(`✗ ${path}: ${errMsg}`);
    } finally {
      reads.release(slot);
    }
  }

  showLoading?.(false);

  const kept = !parsed.length && files.length;
  if (parsed.length) { resetStudyState(); files = parsed; }
  lines.forEach(l => log(l));

  if (failures.length) {
    renderLoadFailures(failures, kept && T('The open study is unchanged.'));
    // The banner lives on Edit; the toast reaches whichever tab is open.
    const msg = parsed.length ? T('{n} of {m} files could not be read as DICOM.').replace('{n}', failures.length).replace('{m}', arr.length)
      : failures.length === 1 ? T('{name} could not be read as DICOM.').replace('{name}', failures[0].name)
      : T('None of the {n} files could be read as DICOM.').replace('{n}', failures.length);
    toast?.([msg,
      failures.some(f => f.image) && T('Images go in Create →, which turns them into DICOM.'),
      kept && T('The open study is unchanged.')].filter(Boolean).join(' '), 7000);
  }

  if (!parsed.length) return 0;

  showLoadedStudy();
  return parsed.length;
}


// Write a nested edit at 'tag/index/tag/index/tag'. A path that no longer resolves
// (dataset rebuilt by anonymize/UID remap) is a no-op.
// `d` is a SHALLOW copy, so each sequence/item on the path is copied before writing;
// otherwise the loaded file would be mutated by export. Off-path nodes stay shared.
function assignPath(d, path, vr, valueString) {
  const parts = path.split('/');
  let node = d;
  for (let i = 0; i + 2 < parts.length; i += 2) {
    const seq = node[parts[i]];
    if (!seq || !Array.isArray(seq.Value)) return;
    const idx = Number(parts[i + 1]);
    const item = seq.Value[idx];
    if (!item || typeof item !== 'object') return;
    const seqCopy = { ...seq, Value: seq.Value.slice() };
    const itemCopy = { ...item };
    seqCopy.Value[idx] = itemCopy;
    node[parts[i]] = seqCopy;
    node = itemCopy;
  }
  const leaf = leafTag(path);
  if (isReadOnly(leaf, vr)) return;
  const v = parseByVR(vr, valueString, node[leaf]?.Value?.[0]);
  if (v === null) return;          // not a value this VR can hold: the element stays as it was
  node[leaf] = { vr, Value: v };
}

// ---- Big-endian source ----
// dcmjs parses numeric VRs from Explicit VR Big Endian but keeps word-sized binary values as raw
// big-endian bytes, then writes them unchanged under ensureMeta's little-endian label (PS3.5 7.3).
const BE_WORD_BYTES = { OW: 2, OL: 4, OF: 4, OD: 8, OV: 8 };

function swapWordBytes(v, n) {
  const src = v instanceof ArrayBuffer ? new Uint8Array(v)
            : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null;
  if (!src) return v;
  const out = new Uint8Array(src.length);
  const whole = src.length - (src.length % n);
  for (let i = 0; i < whole; i += n) for (let k = 0; k < n; k++) out[i + k] = src[i + n - 1 - k];
  out.set(src.subarray(whole), whole);
  return out.buffer;
}

// Little-endian copy of a dataset read from big endian; the loaded file is never mutated.
function bigEndianToLE(node) {
  const out = {};
  for (const [t, el] of Object.entries(node)) {
    if (!el || typeof el !== 'object' || !Array.isArray(el.Value)) { out[t] = el; continue; }
    if (el.vr === 'SQ') {
      out[t] = { ...el, Value: el.Value.map(it => (it && typeof it === 'object' ? bigEndianToLE(it) : it)) };
      continue;
    }
    // dcmjs reads VRs it does not know (e.g. OL) as UN; the dictionary still knows the word size.
    const n = BE_WORD_BYTES[el.vr === 'UN' ? vrForTag(t) : el.vr];
    out[t] = n ? { ...el, Value: el.Value.map(v => swapWordBytes(v, n)) } : el;
  }
  return out;
}

// Encode one file with ITS OWN pending edits (not the global pendingEdits, which would
// stamp the current file's values, e.g. SOP Instance UID, onto every file).
// The file as it would be written: the editor's copy (redactions, turns) plus its pending tag
// edits. Shallow copy is safe: changed tags are replaced (never mutated) and DicomDict.write()
// only reads its input. Guarded by 'writing a file does not disturb the file' in
// tests/suites/edits.js, which fails if a dcmjs update starts mutating its input.
function withPendingEdits(entry) {
  const d = { ...entry.dict };
  pendingOf(entry).forEach(({ vr, valueString }, t) => {
    // Path keys must not reach d[t]: dcmjs parses '00081140/0/00100010' as (0008,1140)
    // and would silently replace the whole sequence with the leaf.
    if (t.includes('/')) { assignPath(d, t, vr, valueString); return; }
    if (isReadOnly(t, vr)) return;
    const v = parseByVR(vr, valueString, entry.dict[t]?.Value?.[0]);
    if (v === null) return;          // not a value this VR can hold: the element stays as it was
    // Canonical key (8 UPPERCASE hex): any other spelling is written under the wrong tag, and a
    // second spelling of an existing tag would be a duplicate element.
    const k = /^x?[0-9a-f]{8}$/i.test(t) ? canonTag(t) : t;
    if (k !== t) delete d[t];
    for (const alt of [k.toLowerCase(), 'x' + k.toLowerCase(), 'x' + k]) if (alt !== k) delete d[alt];
    d[k] = { vr, Value: v };
  });
  return d;
}

// Encapsulated transfer syntaxes the vendored dcmjs writer encapsulates (its own list). Any other
// compressed syntax would be written as a single defined-length value holding only the first
// frame, an unreadable file, so it is refused instead (vendor/ stays byte-identical upstream).
const DCMJS_ENCAPSULATED_TS = new Set([
  '1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51', '1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70',
  '1.2.840.10008.1.2.4.80', '1.2.840.10008.1.2.4.81', '1.2.840.10008.1.2.4.90', '1.2.840.10008.1.2.4.91',
  '1.2.840.10008.1.2.4.92', '1.2.840.10008.1.2.4.93', '1.2.840.10008.1.2.4.94', '1.2.840.10008.1.2.4.95',
  '1.2.840.10008.1.2.5', '1.2.840.10008.1.2.6.1', '1.2.840.10008.1.2.4.100', '1.2.840.10008.1.2.4.102',
  '1.2.840.10008.1.2.4.103',
]);
const UNCOMPRESSED_TS = new Set(['', '1.2.840.10008.1.2', '1.2.840.10008.1.2.1',
                                 '1.2.840.10008.1.2.2', '1.2.840.10008.1.2.1.99']);

// PS3.5 6.1.2.3: without (0008,0005) only the default repertoire (ASCII) is allowed, but dcmjs
// always writes UTF-8. Declare it when a value (swapped in, copied across, typed) needs it.
function hasNonAscii(d) {
  let found = false;
  walkEls(d, (t, el) => {
    if (found || !el || !Array.isArray(el.Value) || isBinaryVR(el.vr) || el.vr === 'SQ') return;
    for (const v of el.Value) {
      const sv = v && typeof v === 'object' ? [v.Alphabetic, v.Ideographic, v.Phonetic].filter(Boolean).join('') : v;
      if (typeof sv === 'string' && /[^\x00-\x7F]/.test(sv)) { found = true; return; }
    }
  });
  return found;
}

// Encapsulated Pixel Data as one value per frame, so the writer emits one fragment per frame and
// a Basic Offset Table entry per frame (PS3.5 A.4; RLE requires exactly one fragment per frame).
function encapsulatedForWrite(d) {
  const key = findTagKey(d, '7FE00010');
  const px = key && d[key];
  if (!px || !Array.isArray(px.Value)) return;
  const n = Math.max(1, parseInt(String(getTag(d, '00280008')?.Value?.[0] ?? '1'), 10) || 1);
  const bufs = px.Value.map(v => ArrayBuffer.isView(v) ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v);
  const grouped = bufs.every(b => b instanceof ArrayBuffer) ? groupFragmentsByFrame(bufs, n) : null;
  if (grouped && grouped.length !== px.Value.length) d[key] = { ...px, Value: grouped };
  // The Extended Offset Table describes the source fragments; the written BOT replaces it.
  delTag(d, '7FE00001'); delTag(d, '7FE00002');
}

function buildEditedBytes(entry) {
  const srcTS = metaTS(entry.meta);
  const encapsulated = !UNCOMPRESSED_TS.has(srcTS);
  if (encapsulated && !DCMJS_ENCAPSULATED_TS.has(srcTS) && findTagKey(entry.dict, '7FE00010'))
    throw new Error(`Pixel Data in transfer syntax ${srcTS} cannot be written back by this editor; refused rather than write an unreadable file.`);
  let d = withPendingEdits(entry);
  // Drop group length tags (gggg,0000): stale after any edit, and dcmjs throws on private ones.
  Object.keys(d).forEach(t => {
    const hex = (t.startsWith('x') ? t.slice(1) : t).toLowerCase();
    if (hex.length === 8 && hex.slice(4) === '0000') delete d[t];
  });
  // Redacted/rotated frames are already swapped, and their meta says LE, so this runs once.
  if (metaTS(entry.meta) === '1.2.840.10008.1.2.2') d = bigEndianToLE(d);
  if (!findTagKey(d, '00080005') && hasNonAscii(d)) d['00080005'] = { vr: 'CS', Value: ['ISO_IR 192'] };
  if (encapsulated) encapsulatedForWrite(d);
  const m = ensureMeta(d, entry.meta);
  normBin(d);
  normBin(m);
  const dd = new DicomDict(m);
  dd.dict = d;
  // Not the default re-split into 20480-byte fragments: one fragment per frame (see above).
  const out = dd.write({ fragmentMultiframe: false });
  // Return a view, not a copy; the ZIP writer and Blob wrapper consume it directly.
  return ArrayBuffer.isView(out) ? new Uint8Array(out.buffer, out.byteOffset, out.byteLength) : new Uint8Array(out);
}

// Blob wrapper used by several callers and tests/suites/edits.js.
function buildEditedFile(entry) {
  return new Blob([buildEditedBytes(entry)], { type: 'application/dicom' });
}

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

