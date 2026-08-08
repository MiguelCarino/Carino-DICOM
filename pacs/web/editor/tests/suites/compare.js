// Comparing is a second column in the editor's table, not a second screen.
//
// So the things worth asserting are the ones that only hold if it really is the
// same table: the same filters and search apply, both sides are ordinary loaded
// files with their own editable working copies, and closing the comparison
// leaves the editor exactly as it was.
(window.SUITES || (window.SUITES = {})).compare = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const $ = (id) => document.getElementById(id);
  const rowFor = (tag8) => [...tagBody.querySelectorAll('tr')].find(
    tr => tr.querySelector('.tag-code')?.textContent === fmtTag(tag8));

  try {
    const n = Forge.W * Forge.H;
    const px = new Uint16Array(n);
    for (let i = 0; i < n; i++) px[i] = i & 0xFFF;
    const base = {
      rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
      wc: 2048, ww: 4096, modality: 'CT',
      studyUID: '1.2.826.0.1.3680043.10.99999.8.1',
      seriesUID: '1.2.826.0.1.3680043.10.99999.8.2',
      pixels: px,
    };
    // Same study, one differing value, and one tag on each side the other lacks.
    const a = Forge.build({ ...base, instance: 1, sopInstance: '1.2.826.0.1.3680043.10.99999.8.3.1',
      extra: { '00181030': { vr: 'LO', v: ['HEAD ROUTINE'] } } });
    const b = Forge.build({ ...base, instance: 2, sopInstance: '1.2.826.0.1.3680043.10.99999.8.3.2',
      extra: { '00080080': { vr: 'LO', v: ['Carino Systems'] } } });

    await handleFiles([new File([a], 'first.dcm'), new File([b], 'second.dcm')]);
    ok('two files load', files.length === 2, String(files.length));

    // ---- off by default ------------------------------------------------------
    ok('no comparison until asked for', compareEntry() === null);
    ok('the extra columns stay out of the way',
       [...document.querySelectorAll('.cmp-col')].every(el => el.classList.contains('hidden')));
    ok('the bar is hidden', $('cmpBar').classList.contains('hidden'));
    ok('the picker appeared for a multi-file study', !$('compareWith').classList.contains('hidden'));
    ok('the picker offers the other file, not this one',
       [...$('compareWith').options].map(o => o.value).join(',') === ',1',
       [...$('compareWith').options].map(o => o.textContent).join(' | '));
    const plainCols = rowFor('00100020')?.children.length;
    ok('a row is four cells wide', plainCols === 4, String(plainCols));

    // ---- turn it on through the control the user uses ------------------------
    $('compareWith').value = '1';
    $('compareWith').dispatchEvent(new Event('change'));

    ok('the comparison opens', compareEntry() === files[1]);
    ok('the bar appears', !$('cmpBar').classList.contains('hidden'));
    ok('the columns appear',
       [...document.querySelectorAll('.cmp-col')].every(el => !el.classList.contains('hidden')));
    ok('the second column is named after the file', $('cmpHeadB').textContent === 'second.dcm',
       $('cmpHeadB').textContent);
    ok('a row is now six cells wide', rowFor('00100020')?.children.length === 6,
       String(rowFor('00100020')?.children.length));

    // ---- the four states -----------------------------------------------------
    ok('an identical tag reads as a match',
       rowFor('00100020')?.classList.contains('cmp-match'), rowFor('00100020')?.className);
    ok('a differing tag reads as a difference',
       rowFor('00080018')?.classList.contains('cmp-diff'), rowFor('00080018')?.className);
    ok('a tag only this file has is marked as such',
       rowFor('00181030')?.classList.contains('cmp-only-a'), rowFor('00181030')?.className);
    ok('a tag only the other file has is marked as such',
       rowFor('00080080')?.classList.contains('cmp-only-b'), rowFor('00080080')?.className);
    ok('a missing value says so rather than looking empty',
       rowFor('00080080')?.children[3].querySelector('input')?.placeholder === '— not present —',
       rowFor('00080080')?.children[3].querySelector('input')?.placeholder);
    ok('and its input is not editable on the side that lacks it',
       rowFor('00080080')?.children[3].querySelector('input')?.disabled === true);

    // Through t(), not against the English: this suite also runs inside
    // index.html#selftest, in whatever language the visitor is reading in.
    const T = window.t || String;
    const stats = $('cmpStatRow').textContent;
    ok('the bar reports one difference per differing tag',
       new RegExp(`[123] ${T('differ')}`).test(stats), stats);
    ok('the bar counts one tag on each side alone',
       stats.includes(`1 ${T('only here')}`) && stats.includes(`1 ${T('only there')}`), stats);

    // ---- the editor's own filters still rule the table ------------------------
    searchQuery = 'Carino Systems';         // a value that exists only in the other file
    renderTable();
    ok('search reaches the second column', !!rowFor('00080080'), String(tagBody.children.length));
    searchQuery = '';

    activeCat = 'patient';
    renderTable();
    ok('the category filter still applies while comparing', !rowFor('00080018'));
    activeCat = 'all';

    $('cmpDiffOnly').checked = true;
    $('cmpDiffOnly').dispatchEvent(new Event('change'));
    ok('differences only hides the matching rows', !rowFor('00100020') && !!rowFor('00080018'));
    $('cmpDiffOnly').checked = false;
    $('cmpDiffOnly').dispatchEvent(new Event('change'));

    // ---- both sides are editable, and stay their own -------------------------
    const bInput = rowFor('00100010').children[4].querySelector('input');
    bInput.value = 'Other^Only';
    bInput.dispatchEvent(new Event('input'));
    ok('editing the second column edits the second file',
       files[1].pending.get(editKey('00100010')).valueString === 'Other^Only',
       files[1].pending.get(editKey('00100010')).valueString);
    ok('and leaves the first file alone',
       files[0].pending.get(editKey('00100010')).valueString === 'Forge^Test',
       files[0].pending.get(editKey('00100010')).valueString);

    // ---- copy across ---------------------------------------------------------
    rowFor('00100010').children[5].querySelector('.cmp-copy-btn').click();   // →
    ok('the copy arrow pushes this file\'s value across',
       files[1].pending.get(editKey('00100010')).valueString === 'Forge^Test',
       files[1].pending.get(editKey('00100010')).valueString);
    ok('and the row turns into a match', rowFor('00100010')?.classList.contains('cmp-match'));

    cmpApplyAll(true);
    const stillDiffer = [...tagBody.querySelectorAll('tr.cmp-diff')];
    ok('copy-all settles every editable difference',
       stillDiffer.every(tr => tr.classList.contains('readonly-row')),
       stillDiffer.map(tr => tr.querySelector('.tag-code').textContent).join(' '));
    // File Meta is shown for reference and never written from the dataset, so a
    // difference there is meant to survive a copy-all.
    ok('and leaves File Meta alone',
       stillDiffer.length > 0 && stillDiffer.every(tr => /^\(0002,/.test(tr.querySelector('.tag-code').textContent)),
       stillDiffer.map(tr => tr.querySelector('.tag-code').textContent).join(' '));
    ok('copy-all creates the tags the receiving file lacked',
       rowFor('00181030')?.classList.contains('cmp-match'), rowFor('00181030')?.className);

    // ---- what gets written ---------------------------------------------------
    const wrote = DicomMessage.readFile(await buildEditedFile(files[1]).arrayBuffer());
    normBin(wrote.dict);
    const nameB = elToString(lookupTag(wrote.dict, '00100010')).trim();
    ok('downloading the other file writes the other file', nameB === 'Forge^Test', nameB);

    // ---- closing puts the editor back --------------------------------------
    $('cmpClose').click();
    ok('closing ends the comparison', compareEntry() === null);
    ok('the columns go away again',
       [...document.querySelectorAll('.cmp-col')].every(el => el.classList.contains('hidden')));
    ok('and the rows are four cells wide once more', rowFor('00100020')?.children.length === 4,
       String(rowFor('00100020')?.children.length));

    // ---- the Overview launcher opens this same mode -------------------------
    // Compare stopped being a tab of its own, so its launcher has to land in the
    // editor with a comparison already open. Pointed at a tab that no longer
    // exists it hid every panel and left a blank page.
    switchTab('overview');
    ok('the launcher is live while a second file is loaded', $('ovActCompare').disabled === false);
    $('ovActCompare').click();
    ok('the Overview Compare button opens the editor', activeTab === 'editor', activeTab);
    ok('and brings the other file with it', compareEntry() === files[1],
       compareEntry()?.name || 'none');
    $('cmpClose').click();

    // ---- a file cannot be compared with itself ------------------------------
    compareIdx = 1;
    renderCompareUI();
    switchFile(1);
    ok('switching onto the compared file closes the comparison', compareEntry() === null);
    ok('the picker now offers the file we came from',
       [...$('compareWith').options].map(o => o.textContent).join(',') === `${T('Compare with…')},first.dcm`,
       [...$('compareWith').options].map(o => o.textContent).join(','));
  } catch (e) {
    ok('suite ran to completion', false, (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  }

  return out;
};

// Two callers: tests/run.sh injects this file alone and scrapes the <pre> below;
// index.html#selftest sets window.SELFTEST and awaits the returned lines instead.
if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.compare()).join('\n');
  document.body.appendChild(pre);
});
