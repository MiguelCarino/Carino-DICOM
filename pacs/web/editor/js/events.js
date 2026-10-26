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

const isYes = (d, tag) => /^YES/i.test(String(getTag(d, tag)?.Value?.[0] || '').trim());
const burnedIn = () => files.filter(f => isYes(f.dict, '00280301'));

anonymizeBtn.addEventListener('click', () => {
  if (!files.length) return;
  // Without the table nothing would be de-identified, yet (0012,0062) YES / 113100 would be
  // written: refuse instead of claiming a profile that was not applied.
  if (!window.DEID_PROFILE) { log('✗ ' + T(DEID_MISSING)); toast?.(T(DEID_MISSING), 8000); return; }
  // Read the box, not deidOptions: that is only refreshed once the user confirms.
  const keepUIDs = document.querySelector('#deidOptionsRow [data-opt="rtnUIDsOpt"]')?.checked;
  // Said before the irreversible step: Find burned-in text matches the file's own tags, which
  // are gone afterwards.
  const nb = burnedIn().length;
  const msg = [T(keepUIDs
    ? 'Anonymize all {n} loaded file(s)? This overwrites patient identifiers. UIDs are kept (Retain UIDs).'
    : 'Anonymize all {n} loaded file(s)? This overwrites patient identifiers and remaps UIDs.').replace('{n}', files.length),
    nb && T('Burned In Annotation = YES in {b} of {n} file(s): redact those first, because Find burned-in text stops working once the tags are anonymized.')
      .replace('{b}', nb).replace('{n}', files.length),
    T('Undo cannot reverse this.')].filter(Boolean).join(' ');
  confirmDanger(msg, () => {
    // An undo step across the rewrite would put one file back on its old identity and UIDs while
    // (0012,0062) still says YES, so the history ends here (as Swap and UID prefix do).
    resetEditHistory?.(); datasetDirty = true;
    try { renderTechRow(); } catch (_) {}
    readDeidOptions();
    const notes = {};
    try {
      files.forEach(f => {
        const r = anonymize(f.dict);
        if (r?.embeddedOverlay) notes.embeddedOverlay = (notes.embeddedOverlay || 0) + 1;
        if (r?.opaqueSequences) notes.opaqueSequences = (notes.opaqueSequences || 0) + r.opaqueSequences;
        f.deid = true;                  // export names stop carrying the source path
      });
    } catch (err) { log('✗ ' + (err.message || err)); toast?.(err.message || String(err), 8000); return; }
    // remapUIDs ignores the profile table, so skipping it is what implements Retain UIDs.
    if (!deidOptions.has('rtnUIDsOpt')) remapUIDs();
    reseedAllPending();
    syncToUI();
    // Burned-in pixel identity needs per-image judgement, so point at Redact instead of guessing.
    const burned = burnedIn();
    if (burned.length) log('⚠ ' + TF('{n} file(s) have Burned In Annotation = YES: identity may remain in the image pixels. Use Redact in the Image edits card to overwrite it.', { n: burned.length }));
    const faces = files.filter(f => isYes(f.dict, '00280302'));
    if (faces.length) log('⚠ ' + TF('{n} file(s) have Recognizable Visual Features = YES: the pixels themselves (e.g. a face reconstructed from a head scan) may identify the patient. This tool does not deface images.', { n: faces.length }));
    if (notes.embeddedOverlay) log('⚠ ' + TF('{n} file(s) described a retired overlay stored in Pixel Data bits; the overlay group was removed, but those bits may still hold it.', { n: notes.embeddedOverlay }));
    if (notes.opaqueSequences) log('⚠ ' + TF('{n} sequence(s) stored as unknown (UN) bytes could not be inspected and were removed.', { n: notes.opaqueSequences }));
    const n = window.DEID_PROFILE_META?.attributes || 0;
    const opts = [...deidOptions].map(o => DEID_OPTION_CODES[o][1]);
    log(T('Anonymized all files — DICOM PS3.15 Basic Profile') + (n ? ' ' + TF('({n} attributes)', { n }) : '')
        + (opts.length ? ` + ${opts.join(' + ')}` : ''));
    toast?.(burned.length
      ? T('Burned In Annotation = YES — identity may be burned into the pixels. Use Redact in the Edit tab.')
      : T('All files anonymized'), burned.length ? 8000 : undefined);
  }, 'Anonymize');
});

randomizeBtn.addEventListener('click', () => {
  if (!files.length) return;
  // randomize() touches only the patient block, dates and two IDs; say what it leaves.
  confirmDanger(T('Give all {n} loaded file(s) a made-up patient name, IDs, birth date and study dates? This is NOT de-identification: institution, device, physician, private tags and burned-in text are kept.').replace('{n}', files.length)
      + ' ' + T('Undo cannot reverse this.'), () => {
    resetEditHistory?.(); datasetDirty = true;
    try { renderTechRow(); } catch (_) {}
    randomizeAll(files);
    // Not de-identification, so a ticked Retain UIDs (left from an earlier Anonymize) does not
    // apply: a fake patient must never share the real study's UIDs.
    remapUIDs({ honourOptions: false });
    reseedAllPending();
    syncToUI();
    log(T('Randomized all files'));
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
  if ([...ia, ...ib].some(i => isYes(files[i].dict, '00280301')))
    warn.push(T('A file in these studies is marked Burned In Annotation = YES: its pixels still show the old patient. Redact it after the swap.'));
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
  // A folded edit (a retyped Study Instance UID) can change which file belongs to which study;
  // the swap must move what the files now say, so re-check the grouping and stop if it moved.
  const now = groupStudies().map(g => g.indices.join(','));
  if (now.length !== 2 || !now.includes(ia.join(',')) || !now.includes(ib.join(','))) {
    reseedAllPending(); syncToUI();
    toast?.(T('Swap cancelled: unexported edits change which files belong to which study.'), 7000);
    return;
  }
  swapPatients(ia, ib, withAcc);
  if (newUIDs) remapUIDs({ honourOptions: false });
  reseedAllPending();
  syncToUI();
  if ([...ia, ...ib].some(i => isYes(files[i].dict, '00280301')))
    log('⚠ ' + T('Burned In Annotation = YES in a swapped file: its pixels still show the previous patient. Use Redact.'));
  log(TF('Swapped patients between 2 studies ({a} + {b} files)', { a: ia.length, b: ib.length })
      + (withAcc ? T(', Accession Number included') : '') + (newUIDs ? T(', new UIDs') : ''));
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
// Toolbar menus: close after a pick, on an outside click and on Escape; opening one closes the other.
for (const menu of document.querySelectorAll('.actions-row .tb-menu')) {
  menu.querySelector('.tb-menu-list')?.addEventListener('click', e => { if (e.target.closest('button')) menu.open = false; });
  menu.addEventListener('toggle', () => {
    if (menu.open) document.querySelectorAll('.actions-row .tb-menu[open]').forEach(m => { if (m !== menu) m.open = false; });
  });
  document.addEventListener('click', e => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); } });
}
// Tools ▸ UID root… toggles the panel under the toolbar.
$('uidPatternBtn')?.addEventListener('click', () => {
  uidPatternOpen = !uidPatternOpen;
  showUIDPattern(!!sharedUIDPrefix);
  if (uidPatternOpen) uidPrefixInput.focus();
});
$('cmpReport')?.addEventListener('click', () => printCompareReport());
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
  $('catSelect').value = activeCat;
  renderTable({ datasetsUnchanged: true });
}));

// The phone's menu drives the chips, so both stay one control.
$('catSelect').addEventListener('change', e => {
  [...filterBtns].find(b => b.dataset.cat === e.target.value)?.click();
});

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

// Each module is linkable as #<module>, extra parameters after "&" (#edit&sample=ct, read by
// js/deeplink.js). The hash names differ from the internal tab ids, which tests and the log use.
const TAB_HASH = { overview: 'overview', editor: 'edit', extractor: 'extract', create: 'create' };
let slicer = null;   // CarinoUI.slices handle, set on DOMContentLoaded (carino-ui.js is deferred)

function switchTab(tab, fromRoute) {
  activeTab = tab;
  // A switch made in code (a button, a hand-off) writes the hash too, so Back and a reload agree
  // with the screen. The router's own call (fromRoute) must not write it back.
  if (!fromRoute && slicer) {
    const cur = location.hash.replace(/^#/, '').split('&')[0];
    if (cur !== TAB_HASH[tab]) {
      try { history.pushState(null, '', location.pathname + location.search + '#' + TAB_HASH[tab]); } catch (_) {}
      slicer.route();
    }
  }
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

// The slice bar's router. An empty or unknown first part (#sample=…, #case=…, #carino-bridge,
// #selftest) is the Overview; deeplink.js reads those parameters itself, after this has run.
document.addEventListener('DOMContentLoaded', () => {
  if (!window.CarinoUI) return;
  const tabOf = id => Object.keys(TAB_HASH).find(k => TAB_HASH[k] === id);
  slicer = CarinoUI.slices({
    menu: $('moduleMenu'),
    collapsed: true,
    onRoute(id) {
      const tab = tabOf(id) || (id ? null : 'overview');
      if (tab && tab !== activeTab) switchTab(tab, true);
      // CarinoUI marks only a named module; an empty hash is still the Overview.
      for (const [t, btn] of ALL_TABS) btn.classList.toggle('active', t === activeTab);
    },
  });
});

