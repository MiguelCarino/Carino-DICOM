// File loading (files and folders), SHA-256 integrity, and building/saving edited files.

// ---- File integrity (SHA-256) ----
// Hash of the ORIGINAL loaded bytes (matches `sha256sum file.dcm`) for chain of custody.
// Edits never change it; the UI shows a "working copy edited" note when dirty.
const SHA_AUTO_LIMIT = 64 * 1024 * 1024;   // hash on load below this; button above
let datasetDirty = false;                  // any edit/anonymize/randomize this session

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

  // Ask before handleFiles: it wipes files, edits and history immediately.
  if (keep.length > LARGE_STUDY) {
    const go = await new Promise(resolve => confirmDanger(
      T('This folder holds {n} DICOM files. Loading all of them may take a while and use a lot of memory.').replace('{n}', keep.length),
      () => resolve(true), 'Load all', () => resolve(false)));
    if (!go) return;
  }

  await handleFiles(keep);

  // Logged after handleFiles, which clears the log.
  if (skippedIndex) log('Skipped DICOMDIR (the disc index, not an image)');
  // Non-DICOM files go to the log, not the failure banner (reserved for real parse failures).
  if (junk) log(`Skipped ${junk} non-DICOM file(s) in the folder`);
  if (res.truncated) {
    log(`Folder scan stopped at ${MAX_SCAN_FILES} files`);
    toast?.(T('Only the first {n} files in that folder were scanned.').replace('{n}', MAX_SCAN_FILES));
  }
}

// ---- File handling ----
async function handleFiles(list) {
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
  dropZone.classList.remove('compact');

  // Accepts a FileList/File[] or folder-walk {file, path} items; normalize to the latter.
  const arr = Array.from(list || []).map(x => (x instanceof Blob) ? { file: x, path: x.webkitRelativePath || x.name } : x);
  if (!arr.length) return;

  showLoading?.(true, `Loading image${arr.length > 1 ? 's' : ''}…`, 0, `0 / ${arr.length}`);
  log(`Loading ${arr.length} file(s)...`);

  const failures = [];

  // Read ahead so disk reads overlap parsing (modest gain; more on slow shares).
  // Bounded by count AND bytes; the head file always passes so one huge file can't deadlock.
  // The file being parsed stays in queuedBytes until its finally block.
  const READ_AHEAD = 4, READ_AHEAD_BYTES = 64 * 1024 * 1024;
  const queue = [];
  let queuedBytes = 0, nextRead = 0;
  const fillQueue = () => {
    while (nextRead < arr.length && queue.length < READ_AHEAD &&
           (!queue.length || queuedBytes + (arr[nextRead]?.file?.size || 0) <= READ_AHEAD_BYTES)) {
      const f = arr[nextRead++]?.file;
      const size = f?.size || 0;
      let p;
      // Avoid an unhandled rejection; the await below re-throws into the per-file catch.
      try { p = f.arrayBuffer(); } catch (e) { p = Promise.reject(e); }
      p.catch(() => {});
      queuedBytes += size;
      queue.push({ p, size });
    }
  };
  fillQueue();

  let lastYield = performance.now();
  for (let i = 0; i < arr.length; i++) {
    const { file, path } = arr[i];
    showLoading?.(true, `Loading image${arr.length > 1 ? 's' : ''}…`, (i + 1) / arr.length, `${i + 1} / ${arr.length}`);
    // Pre-read buffers resolve as microtasks and never yield a frame; yield a real
    // task every ~100 ms so the progress overlay repaints.
    if (performance.now() - lastYield > 100) {
      await new Promise(r => setTimeout(r));
      lastYield = performance.now();
    }
    const slot = queue.shift();
    fillQueue();
    try {
      const buf = await slot.p;
      const msg = DicomMessage.readFile(buf);
      normBin(msg.dict);
      // Keep the File handle (not bytes) for on-demand hashing. `name` stays the basename
      // because downloadOne uses it as a.download (no slashes); `path` is display-only.
      const entry = { name: file.name, path, dict: msg.dict, meta: msg.meta || {}, pending: seedPending(msg.dict), file, size: file.size, sha: null, shaState: file.size <= SHA_AUTO_LIMIT ? 'idle' : 'deferred' };
      files.push(entry);
      if (entry.shaState === 'idle') computeEntrySha(entry, buf);   // fire-and-forget
      log(`✓ ${path}`);
    } catch (e) {
      const errMsg = e.message || String(e);
      // Path, not name: same-named slices from different series folders stay distinct.
      failures.push({ name: path, error: errMsg });
      log(`✗ ${path}: ${errMsg}`);
    } finally {
      queuedBytes -= slot.size;
    }
  }

  showLoading?.(false);

  if (failures.length) {
    errorBanner.className = 'error-banner';
    errorBanner.innerHTML = `<summary>⚠ ${failures.length} file${failures.length > 1 ? 's' : ''} failed to load — click to expand</summary><ul>${
      failures.map(f => `<li>${f.name}: ${f.error}</li>`).join('')
    }</ul>`;
  }

  if (!files.length) return;

  // Sort before reading files[0] so the first image of the first series is shown.
  sortFiles();

  dict = files[0].dict;
  meta = files[0].meta;

  fileNamePill.textContent = files.length === 1 ? files[0].name : `${files[0].name} (+${files.length - 1})`;
  fileCountPill.textContent = `${files.length} file${files.length > 1 ? 's' : ''}`;
  dropZone.classList.add('compact');

  renderFileBrowser?.();
  syncToUI();
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
  node[leaf] = { vr, Value: parseByVR(vr, valueString, node[leaf]?.Value?.[0]) };
}

// Encode one file with ITS OWN pending edits (not the global pendingEdits, which would
// stamp the current file's values, e.g. SOP Instance UID, onto every file).
function buildEditedBytes(entry) {
  // Shallow copy is safe: changed tags are replaced (never mutated) and DicomDict.write()
  // only reads its input. Guarded by 'writing a file does not disturb the file' in
  // tests/suites/edits.js, which fails if a dcmjs update starts mutating its input.
  const d = { ...entry.dict };
  pendingOf(entry).forEach(({ vr, valueString }, t) => {
    // Path keys must not reach d[t]: dcmjs parses '00081140/0/00100010' as (0008,1140)
    // and would silently replace the whole sequence with the leaf.
    if (t.includes('/')) { assignPath(d, t, vr, valueString); return; }
    if (!isReadOnly(t, vr)) d[t] = { vr, Value: parseByVR(vr, valueString, entry.dict[t]?.Value?.[0]) };
  });
  // Drop group length tags (gggg,0000): stale after any edit, and dcmjs throws on private ones.
  Object.keys(d).forEach(t => {
    const hex = (t.startsWith('x') ? t.slice(1) : t).toLowerCase();
    if (hex.length === 8 && hex.slice(4) === '0000') delete d[t];
  });
  const m = ensureMeta(d, entry.meta);
  normBin(d);
  normBin(m);
  const dd = new DicomDict(m);
  dd.dict = d;
  const out = dd.write();
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

