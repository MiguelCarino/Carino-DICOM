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
  else r.then(loadStudy);
});

dropZone.addEventListener('click', () => fileInput.click());
// Reset value so picking the same file twice still fires change.
fileInput.addEventListener('change', e => { if (e.target.files?.length) handleFiles(e.target.files); e.target.value = ''; });

// One hidden webkitdirectory input serves all folder buttons, so remember which opened it.
// (webkitdirectory rather than showDirectoryPicker: it recurses and works in every engine.)
let folderTarget = 'study';
function openFolder(target) { folderTarget = target; folderInput.value = ''; folderInput.click(); }
folderInput.addEventListener('change', e => {
  const items = Array.from(e.target.files || []).map(f => ({ file: f, path: f.webkitRelativePath || f.name }));
  e.target.value = '';
  if (!items.length) return;
  if (folderTarget === 'extract') addExtractorFiles(items);
  else loadStudy({ items, fromFolder: true, truncated: false });
});
// These buttons sit inside drop zones that open the file picker on click; stop propagation.
$('filesBtn')?.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
$('folderBtn')?.addEventListener('click', e => { e.stopPropagation(); openFolder('study'); });
$('extractorFolderBtn')?.addEventListener('click', e => { e.stopPropagation(); openFolder('extract'); });

downloadAllBtn.addEventListener('click', () => downloadRange(0, files.length));

applyPrefixBtn.addEventListener('click', () => {
  const p = uidPrefixInput.value.trim();
  if (p && p !== sharedUIDPrefix) { pushHistory?.(); applyPrefixToAll(p); }
});

anonymizeBtn.addEventListener('click', () => {
  if (!files.length) return;
  confirmDanger(`Anonymize all ${files.length} loaded file${files.length>1?'s':''}? This overwrites patient identifiers and remaps UIDs.`, () => {
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
      : 'All files anonymized');
  }, 'Anonymize');
});

randomizeBtn.addEventListener('click', () => {
  if (!files.length) return;
  confirmDanger(`Randomize all ${files.length} loaded file${files.length>1?'s':''}? This replaces identifying tags with random values.`, () => {
    pushHistory?.();
    files.forEach(f => randomize(f.dict));
    remapUIDs();
    reseedAllPending();
    syncToUI();
    log('Randomized all files');
    toast?.('All files randomized');
  }, 'Randomize');
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
  confirmDanger(`Copy every differing value onto ${other.name}? This overwrites its values.`,
                () => cmpApplyAll(true), 'Copy →');
});
$('cmpApplyToA')?.addEventListener('click', () => {
  const other = compareEntry(); if (!other) return;
  confirmDanger(`Copy every differing value from ${other.name} onto this file? This overwrites its values.`,
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
}

for (const [id, btn] of ALL_TABS) btn.addEventListener('click', () => switchTab(id));

