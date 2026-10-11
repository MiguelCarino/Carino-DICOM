// Main UI event wiring (drop, pickers, bulk actions, compare, search) and tab switching.
// ---- Events ----
window.addEventListener('dragover', e => { e.preventDefault(); body.classList.add('dragging'); });
window.addEventListener('dragleave', () => body.classList.remove('dragging'));
window.addEventListener('drop', e => {
  e.preventDefault();
  body.classList.remove('dragging');
  // No files.length guard: a dropped directory appears in dataTransfer.files, and only the
  // entry API (collectDropped) can tell it from a file.
  const r = collectDropped(e.dataTransfer);
  if (!r) return;
  if (activeTab === 'create') r.then(res => addCreateImages(res.items.map(it => it.file)));
  else if (activeTab === 'extractor') r.then(res => addExtractorFiles(res.items));
  else r.then(openStudy);
});

dropZone.addEventListener('click', () => fileInput.click());
// Reset value so picking the same file twice still fires change.
fileInput.addEventListener('change', e => {
  const items = Array.from(e.target.files || []);
  e.target.value = '';
  openStudy({ items, fromFolder: false });
});

// One hidden webkitdirectory input serves all folder buttons, so remember which opened it.
// (webkitdirectory rather than showDirectoryPicker: it recurses and works in every engine.)
let folderTarget = 'study';
function openFolder(target) { folderTarget = target; folderInput.value = ''; folderInput.click(); }
folderInput.addEventListener('change', e => {
  const items = Array.from(e.target.files || []).map(f => ({ file: f, path: f.webkitRelativePath || f.name }));
  e.target.value = '';
  if (!items.length) return;
  if (folderTarget === 'extract') addExtractorFiles(items);
  else openStudy({ items, fromFolder: true, truncated: false });
});
// These buttons sit inside drop zones that open the file picker on click; stop propagation.
$('filesBtn')?.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
$('folderBtn')?.addEventListener('click', e => { e.stopPropagation(); openFolder('study'); });
$('extractorFolderBtn')?.addEventListener('click', e => { e.stopPropagation(); openFolder('extract'); });

downloadAllBtn.addEventListener('click', () => downloadRange(0, files.length));

applyPrefixBtn.addEventListener('click', () => {
  const p = uidPrefixInput.value.trim();
  if (p && p !== sharedUIDPrefix) applyPrefixToAll(p);
});

anonymizeBtn.addEventListener('click', () => {
  if (!files.length) return;
  // Read the box, not deidOptions: that is only refreshed once the user confirms.
  const keepUIDs = document.querySelector('#deidOptionsRow [data-opt="rtnUIDsOpt"]')?.checked;
  confirmDanger(T(keepUIDs
    ? 'Anonymize all {n} loaded file(s)? This overwrites patient identifiers. UIDs are kept (Retain UIDs).'
    : 'Anonymize all {n} loaded file(s)? This overwrites patient identifiers and remaps UIDs.').replace('{n}', files.length), () => {
    pushHistory?.();
    if (!window.DEID_PROFILE) log('⚠ deid-profile.js failed to load — only private tags and core identifiers will be removed.');
    readDeidOptions();
    files.forEach(f => anonymize(f.dict));
    // remapUIDs ignores the profile table, so skipping it is what implements Retain UIDs.
    if (!deidOptions.has('rtnUIDsOpt')) remapUIDs();
    reseedAllPending();
    syncToUI();
    // Burned-in pixel identity needs per-image judgement, so point at Redact instead of guessing.
    const burned = files.filter(f => /^YES/i.test(String(getTag(f.dict, '00280301')?.Value?.[0] || '')));
    if (burned.length) log(`⚠ ${burned.length} file(s) have Burned In Annotation = YES: identity may remain in the image pixels. Use Redact in the Image edits card to overwrite it.`);
    const n = window.DEID_PROFILE_META?.attributes || 0;
    const opts = [...deidOptions].map(o => DEID_OPTION_CODES[o][1]);
    log(`Anonymized all files — DICOM PS3.15 Basic Profile${n ? ` (${n} attributes)` : ''}`
        + (opts.length ? ` + ${opts.join(' + ')}` : ''));
    toast?.(burned.length
      ? T('Burned In Annotation = YES — identity may be burned into the pixels. Use Redact in the Edit tab.')
      : T('All files anonymized'));
  }, 'Anonymize');
});

randomizeBtn.addEventListener('click', () => {
  if (!files.length) return;
  // randomize() touches only the patient block, dates and two IDs; say what it leaves.
  confirmDanger(T('Give all {n} loaded file(s) a made-up patient name, IDs, birth date and study dates? This is NOT de-identification: institution, device, physician, private tags and burned-in text are kept.').replace('{n}', files.length), () => {
    pushHistory?.();
    files.forEach(f => randomize(f.dict));
    remapUIDs();
    reseedAllPending();
    syncToUI();
    log('Randomized all files');
    toast?.(T('All files given a fake patient'));
  }, 'Make fake patient');
});

// ---- Swap patients ----
const SWAP_ROWS = [
  // [label, tag, swapped: true always, 'acc' only with the Accession box, false never]
  ['Patient Name', '00100010', true],
  ['Patient ID', '00100020', true],
  ['Date of Birth', '00100030', true],
  ['Sex', '00100040', true],
  ['Age', '00101010', true],
  ['Accession Number', '00080050', 'acc'],
  ['Study Date', '00080020', false],
  ['Study Time', '00080030', false],
  ['Study Description', '00081030', false],
];
let swapStudies = null;  // [indicesOfStudy1, indicesOfStudy2] while the dialog is open

function swapFmt(tag, s) {
  if (/^\d{8}$/.test(s) && (tag === '00080020' || tag === '00100030')) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  if (/^\d{6}/.test(s) && tag === '00080030') return `${s.slice(0,2)}:${s.slice(2,4)}:${s.slice(4,6)}`;
  return s;
}
// Read through the pending edits, so the preview shows what the swap will actually move.
function swapValue(i, tag) {
  return elToString(lookupTag(withPendingEdits(files[i]), tag)).trim();
}

function renderSwapDialog() {
  const [ia, ib] = swapStudies;
  const withAcc = $('swapAccession').checked;
  const rows = SWAP_ROWS.map(([label, tag, moves]) => {
    const tr = document.createElement('tr');
    const swapped = moves === true || (moves === 'acc' && withAcc);
    tr.classList.toggle('swap-moves', swapped);
    const th = document.createElement('th');
    th.textContent = (swapped ? '⇄ ' : '') + T(label);
    tr.append(th, ...[ia, ib].map(idx => {
      const td = document.createElement('td');
      td.textContent = swapFmt(tag, swapValue(idx[0], tag)) || '—';
      return td;
    }));
    return tr;
  });
  const count = document.createElement('tr');
  const th = document.createElement('th');
  th.textContent = T('Files');
  count.append(th, ...[ia, ib].map(idx => { const td = document.createElement('td'); td.textContent = idx.length; return td; }));
  $('swapRows').replaceChildren(...rows, count);

  // Warn, never block: the same ID with two spellings is still a swap someone may want.
  const warn = [];
  const idA = swapValue(ia[0], '00100020'), idB = swapValue(ib[0], '00100020');
  if (idA && idA === idB) warn.push(T('Both studies already have Patient ID {id}, so only the way the details are written will change.').replace('{id}', () => idA));
  [ia, ib].forEach((idx, k) => {
    if (new Set(idx.map(i => swapValue(i, '00100020'))).size > 1)
      warn.push(T('Study {n} holds files with different Patient IDs. Every file in it gets the other study\'s patient.').replace('{n}', k + 1));
  });
  const ul = $('swapWarn');
  ul.replaceChildren(...warn.map(w => { const li = document.createElement('li'); li.textContent = w; return li; }));
  ul.classList.toggle('hidden', !warn.length);
}

function closeSwapDialog() {
  $('swapOverlay').classList.remove('visible');
  document.removeEventListener('keydown', swapKey);
  swapStudies = null;
}
function swapKey(e) { if (e.key === 'Escape') closeSwapDialog(); }

swapPatientsBtn.addEventListener('click', () => {
  const studies = groupStudies();
  if (studies.length !== 2) return;
  swapStudies = studies.map(s => s.indices);
  $('swapAccession').checked = false;
  $('swapNewUIDs').checked = true;
  renderSwapDialog();
  $('swapOverlay').classList.add('visible');
  document.addEventListener('keydown', swapKey);
  $('swapCancel').focus();
});
$('swapAccession').addEventListener('change', renderSwapDialog);
$('swapCancel').addEventListener('click', closeSwapDialog);
$('swapOk').addEventListener('click', () => {
  const [ia, ib] = swapStudies;
  const withAcc = $('swapAccession').checked, newUIDs = $('swapNewUIDs').checked;
  closeSwapDialog();
  // Undo only restores the open file's pending edits, so an undo step across the swap would
  // put one file back on the old patient and split the study.
  editHistory = []; editFuture = []; datasetDirty = true;
  clearTimeout(editDebounceTimer); preEditSnapshot = null;
  updateHistoryBtns();
  try { renderTechRow(); } catch (_) {}
  // Fold typed-but-unexported edits in first: reseedAllPending would otherwise drop them.
  for (const f of files) Object.assign(f.dict, withPendingEdits(f));
  swapPatients(ia, ib, withAcc);
  if (newUIDs) remapUIDs();
  reseedAllPending();
  syncToUI();
  log(`Swapped patients between 2 studies (${ia.length} + ${ib.length} files)`
      + (withAcc ? ', Accession Number included' : '') + (newUIDs ? ', new UIDs' : ''));
  toast?.(T('Patients swapped'));
});


$('compareWith')?.addEventListener('change', e => {
  compareIdx = e.target.value === '' ? null : Number(e.target.value);
  cmpDiffOnly = false;
  const cb = $('cmpDiffOnly');
  if (cb) cb.checked = false;
  renderCompareUI();
  renderTable();
});
$('cmpClose')?.addEventListener('click', () => {
  compareIdx = null; renderCompareUI(); renderTable();
});
$('cmpDiffOnly')?.addEventListener('change', e => {
  cmpDiffOnly = e.target.checked; renderTable();
});
$('cmpDownloadB')?.addEventListener('click', () => {
  const other = compareEntry(); if (other) downloadOne(other);
});
$('cmpApplyToB')?.addEventListener('click', () => {
  const other = compareEntry(); if (!other) return;
  // A function replacement, so a '$&' in a file name is not read as a pattern.
  confirmDanger(T('Copy every differing value onto {name}? This overwrites its values.').replace('{name}', () => other.name),
                () => cmpApplyAll(true), 'Copy →');
});
$('cmpApplyToA')?.addEventListener('click', () => {
  const other = compareEntry(); if (!other) return;
  confirmDanger(T('Copy every differing value from {name} onto this file? This overwrites its values.').replace('{name}', () => other.name),
                () => cmpApplyAll(false), 'Copy ←');
});

// Store the query immediately, debounce only the re-render (a tree walk can take ~33 ms on a
// large SR). renderTable stays synchronous because callers read rows right after calling it.
let searchDebounceTimer = null;
searchInput.addEventListener('input', e => {
  searchQuery = e.target.value;
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => renderTable({ datasetsUnchanged: true }), 120);
});

filterBtns.forEach(btn => btn.addEventListener('click', () => {
  filterBtns.forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  activeCat = btn.dataset.cat;
  renderTable({ datasetsUnchanged: true });
}));

previewBox.addEventListener('click', showFullscreen);
fullscreenOverlay.addEventListener('click', hideFullscreen);

frameSlider.addEventListener('input', () => {
  currentFrame = parseInt(frameSlider.value);
  frameLabel.textContent = `${currentFrame + 1}/${totalFrames}`;
  if (dict) drawPreview(dict, currentFrame);
});

// ---- Tab switching ----
let activeTab = 'overview';   // Overview is the default landing tab (see static HTML + ALL_TABS)

const editorTabBtn    = $('editorTabBtn');
const createTabBtn    = $('createTabBtn');
const extractorTabBtn = $('extractorTabBtn');
const editorTabPanel    = $('editorTab');
const createTabPanel    = $('createTab');
const extractorTabPanel = $('extractorTab');
const overviewTabBtn    = $('overviewTabBtn');
const overviewTabPanel  = $('overviewTab');

const ALL_TABS = [
  ['overview',  overviewTabBtn,  overviewTabPanel,  'block'],
  ['editor',    editorTabBtn,    editorTabPanel,    'grid'],
  ['create',    createTabBtn,    createTabPanel,    'grid'],
  ['extractor', extractorTabBtn, extractorTabPanel, 'grid'],
];

function switchTab(tab) {
  activeTab = tab;
  for (const [id, btn, panel, display] of ALL_TABS) {
    btn.classList.toggle('active', id === tab);
    panel.style.display = id === tab ? display : 'none';
  }
  // Render Overview on first open if a file is already loaded.
  if (tab === 'overview' && dict && typeof ovEnsureRendered === 'function') ovEnsureRendered();
  // Stop cine decoding behind a hidden tab.
  if (tab !== 'overview' && typeof ovStopCine === 'function') ovStopCine();
  // Wheel-paging in Overview deliberately left the tag table stale; refresh it now.
  if (tab === 'editor' && dict && editorStale) { editorStale = false; syncEditorUI(); }
  // Extract shows the open study as it stands now, edits included.
  if (tab === 'extractor' && typeof renderExtractorGrid === 'function') renderExtractorGrid();
}

for (const [id, btn] of ALL_TABS) btn.addEventListener('click', () => switchTab(id));

