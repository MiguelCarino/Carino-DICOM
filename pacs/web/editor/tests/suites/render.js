// The tag table is rebuilt far more often than it needs to be.
//
// Two things are pinned down here. First, the search box no longer rebuilds the
// table on the keystroke: since the table became a tree a keystroke walks every
// sequence in the dataset, which is a dropped frame per character on a large
// structured report. Second, a render that only moves rows around — search,
// category filter — no longer rescans every loaded file for the shared UID
// prefix, which is work that depends on the datasets and not on the view.
//
// The invariant that constrains both: renderTable itself stays synchronous.
// Callers all over the app, and tests/suites/compare.js in particular, set
// searchQuery and read the rows on the very next line. Only the listener waits.
(window.SUITES || (window.SUITES = {})).render = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const rows = () => tagBody.querySelectorAll('tr').length;
  const type = (s) => { searchInput.value = s; searchInput.dispatchEvent(new Event('input')); };
  const settle = (ms) => new Promise(r => setTimeout(r, ms));

  // The debounce is 120ms; everything here waits well past it so a slow machine
  // does not turn a timing window into a flake.
  const PAST = 400;

  const realRender = window.renderTable;
  const realDetect = window.detectUIDPattern;
  let renders = 0, detects = 0;
  const count = () => {
    renders = detects = 0;
    window.renderTable = function (...a) { renders++; return realRender.apply(this, a); };
    window.detectUIDPattern = function (...a) { detects++; return realDetect.apply(this, a); };
  };
  const uncount = () => { window.renderTable = realRender; window.detectUIDPattern = realDetect; };

  try {
    const n = Forge.W * Forge.H;
    const px = new Uint16Array(n);
    for (let k = 0; k < n; k++) px[k] = k & 0xFFF;
    const study = [0, 1].map(i => Forge.build({
      rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
      modality: 'CT', instance: i + 1,
      studyUID: '1.2.826.0.1.3680043.10.99999.12.1',
      seriesUID: '1.2.826.0.1.3680043.10.99999.12.2',
      sopInstance: `1.2.826.0.1.3680043.10.99999.12.3.${i + 1}`,
      pixels: px,
      extra: { '00081030': { vr: 'LO', v: ['Carino Systems study'] } },
    }));
    await handleFiles(study.map((b, i) => new File([b], `r${i}.dcm`)));

    // A control: hand-wired instrumentation is worth nothing if the wrapper is
    // not the function the app calls.
    count();
    renderTable();
    uncount();
    ok('the suite is watching the function the app actually calls', renders === 1, String(renders));

    searchInput.value = '';
    searchQuery = '';
    renderTable();
    const allRows = rows();
    ok('the table starts with every row', allRows > 5, String(allRows));

    // ---- the keystroke ------------------------------------------------------
    count();
    type('Carino');
    const rowsAtKeystroke = rows();
    ok('the query is stashed on the keystroke', searchQuery === 'Carino', searchQuery);
    ok('but the table is not rebuilt on it', renders === 0 && rowsAtKeystroke === allRows,
       `${renders} render(s), ${rowsAtKeystroke} rows`);

    await settle(PAST);
    uncount();
    ok('it is rebuilt once the typing stops', renders === 1, String(renders));
    ok('and shows what was typed', rows() < allRows && rows() > 0, `${rows()} of ${allRows}`);

    // ---- a burst ------------------------------------------------------------
    // The whole point: eight characters used to be eight full walks of the tree.
    count();
    for (const s of ['C', 'Ca', 'Car', 'Cari', 'Carin', 'Carino', 'Carino ', 'Carino S']) type(s);
    ok('a burst of keystrokes renders nothing while it is happening', renders === 0, String(renders));
    await settle(PAST);
    uncount();
    ok('and rebuilds the table exactly once when it ends', renders === 1, String(renders));
    ok('with the last thing typed, not the first', searchQuery === 'Carino S', searchQuery);

    // ---- renderTable is still synchronous -----------------------------------
    // This is the contract compare.js and a dozen call sites are written to. If
    // the debounce ever migrates into renderTable it breaks here first.
    searchQuery = 'Carino Systems study';
    renderTable();
    const hit = [...tagBody.querySelectorAll('tr')].some(tr =>
      tr.textContent.includes('Carino Systems study') ||
      [...tr.querySelectorAll('input')].some(i => i.value === 'Carino Systems study'));
    ok('a direct renderTable call is finished when it returns', hit,
       `${rows()} row(s) on the line after the call`);

    searchQuery = '';
    searchInput.value = '';
    renderTable();
    ok('clearing the search brings every row back', rows() === allRows, `${rows()} of ${allRows}`);

    // ---- the UID scan -------------------------------------------------------
    // detectUIDPattern walks every element of every loaded file. It depends on
    // files[] and on nothing else, so a render that only reorders rows has no
    // reason to run it — but a render that might follow an edit still must.
    count();
    renderTable();
    ok('an ordinary render still scans the datasets for the UID prefix', detects === 1, String(detects));

    detects = 0;
    renderTable({ datasetsUnchanged: true });
    ok('a render told the datasets are unchanged does not', detects === 0, String(detects));

    detects = 0;
    type('Carino');
    await settle(PAST);
    ok('so typing in the search box never triggers it', detects === 0, String(detects));

    detects = 0;
    const catBtn = [...filterBtns].find(b => b.dataset.cat && b.dataset.cat !== 'all');
    catBtn?.click();
    ok('and neither does picking a category', detects === 0 && !!catBtn, String(detects));

    // Back to a clean view for whatever runs next — under index.html#selftest
    // every suite in this directory runs in one page, and a search box still
    // holding "Carino" hides most of the next suite's table. Then one last check
    // that the panel is still live: the "all" button takes the ordinary path.
    detects = 0;
    searchQuery = '';
    searchInput.value = '';
    [...filterBtns].find(b => b.dataset.cat === 'all')?.click();
    uncount();
    ok('the UID panel still holds the prefix the scan found',
       uidPrefixInput.value.length > 0 && uidPattern.style.display === 'flex',
       `${uidPrefixInput.value} / ${uidPattern.style.display}`);

    // ---- applying a new UID root ----------------------------------------------
    // One click used to turn CT Image Storage into 9.9.840.10008… and break every
    // file: the scan counted standard UIDs into the shared prefix, and a UID
    // outside the prefix kept only its last component, so different UIDs merged.
    {
      const ROOT = '1.2.826.0.1.3680043.10.99999.13';
      const CT = '1.2.840.10008.5.1.4.1.1.2';
      const study = [0, 1].map(i => Forge.build({
        rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
        modality: 'CT', instance: i + 1, sopClass: CT,
        studyUID: `${ROOT}.1`, seriesUID: `${ROOT}.2`, sopInstance: `${ROOT}.3.${i + 1}`,
        pixels: new Uint16Array(Forge.W * Forge.H),
        extra: { '00081140': { vr: 'SQ', items: [{
          '00081150': { vr: 'UI', v: [CT] },
          '00081155': { vr: 'UI', v: [`${ROOT}.3.${2 - i}`] },
        }] } },
      }));
      await handleFiles(study.map((b, i) => new File([b], `u${i}.dcm`)));
      const uidOf = (f, t) => String(getTag(f.dict, t)?.Value?.[0] ?? '');
      const refOf = f => String(getTag(f.dict, '00081140').Value[0]['00081150'].Value[0]);
      const allUIDs = () => { const a = []; files.forEach(f => walkEls(f.dict, (t, el) => { if (el.vr === 'UI') a.push(...el.Value.map(String)); })); return a; };
      const overlay = $('confirmOverlay');
      const apply = (p) => { uidPrefixInput.value = p; applyPrefixBtn.click(); };
      const realAlert = window.alert;
      let alerted = 0, said = '';
      window.alert = (msg) => { alerted++; said = String(msg); };
      try {
        ok('uid: the shared root leaves the standard SOP Class UIDs out', uidPrefixInput.value === ROOT, uidPrefixInput.value);
        const before = allUIDs();

        apply('9.9');
        ok('uid: Apply asks before it rewrites anything', overlay.classList.contains('visible'));
        // Four distinct UIDs: study, series and two instances. The (0008,1155) back-references
        // and the second file's copies of the study and series UID are the same four values.
        ok('uid: and says how many distinct UIDs in how many files, and that it is final',
           $('confirmMsg').textContent === 'Rewrite 4 UIDs in 2 files to start with 9.9? This cannot be undone.',
           $('confirmMsg').textContent);
        ok('uid: and nothing has changed while it asks', allUIDs().join() === before.join());
        $('confirmCancel').click();
        ok('uid: Cancel leaves every UID as it was', allUIDs().join() === before.join() && uidOf(files[0], '0020000d') === `${ROOT}.1`);

        alerted = 0;
        for (const bad of ['1.2.840.10008.9', '1.2.840.10008', '01.2', '9..9']) apply(bad);
        ok('uid: a prefix that is not a valid root, or is the DICOM root, is refused',
           alerted === 4 && said === 'Invalid UID prefix' && !overlay.classList.contains('visible'), `${alerted} ${said}`);
        alerted = 0;
        apply('1.' + '9'.repeat(60));
        ok('uid: a prefix that would push a UID past 64 characters is refused', alerted === 1 && !overlay.classList.contains('visible'));
        ok('uid: and the refusals changed nothing', allUIDs().join() === before.join());

        pushHistory();   // an earlier edit, so there is an undo step to cross
        apply('9.9');
        $('confirmOk').click();
        const f0 = files[0], f1 = files[1];
        ok('uid: the instance UIDs move to the new root',
           uidOf(f0, '0020000d') === '9.9.1' && uidOf(f0, '0020000e') === '9.9.2' && uidOf(f1, '00080018') === '9.9.3.2',
           `${uidOf(f0, '0020000d')} ${uidOf(f0, '0020000e')} ${uidOf(f1, '00080018')}`);
        ok('uid: (0008,0016) SOP Class UID is unchanged', uidOf(f0, '00080016') === CT && uidOf(f1, '00080016') === CT, uidOf(f0, '00080016'));
        ok('uid: so is a standard UID inside a sequence', refOf(f0) === CT && refOf(f1) === CT, refOf(f0));
        const after = allUIDs();
        ok('uid: no two different UIDs end up the same', new Set(after).size === new Set(before).size, `${new Set(before).size} → ${new Set(after).size}`);
        ok('uid: the panel shows the new root', uidPrefixInput.value === '9.9' && sharedUIDPrefix === '9.9', uidPrefixInput.value);
        ok('uid: the shown File Meta SOP Instance UID follows', String(f0.meta['00020003'].Value[0]) === uidOf(f0, '00080018'));

        // Undo restores only the open file's pending edits, so an undo step across the rewrite
        // would put that one file back on the old root and split the study.
        ok('uid: the rewrite leaves no undo step behind', undoBtn.disabled && editHistory.length === 0, String(editHistory.length));
        performUndo();
        const studyRoots = await Promise.all(files.map(async f =>
          String(DicomMessage.readFile(await buildEditedFile(f).arrayBuffer()).dict['0020000D']?.Value?.[0] ?? '')));
        ok('uid: and Undo afterwards leaves every file on the one new root',
           studyRoots.every(u => u === '9.9.1') && uidPrefixInput.value === '9.9' && sharedUIDPrefix === '9.9', studyRoots.join(' '));

        const out = DicomMessage.readFile(await buildEditedFile(f0).arrayBuffer());
        const m = (t) => String(out.meta[t]?.Value?.[0] ?? '');
        const d = (t) => String(out.dict[t]?.Value?.[0] ?? '');
        ok('uid: the exported (0002,0003) equals its (0008,0018)', m('00020003') === d('00080018') && d('00080018') === '9.9.3.1', `${m('00020003')} / ${d('00080018')}`);
        ok('uid: the exported (0002,0010) Transfer Syntax is unchanged', m('00020010') === '1.2.840.10008.1.2.1', m('00020010'));
        ok('uid: the exported (0002,0002) and (0008,0016) are still CT Image Storage', m('00020002') === CT && d('00080016') === CT, `${m('00020002')} / ${d('00080016')}`);
        ok('uid: the exported Implementation Class UID is unchanged', m('00020012') === '1.2.826.0.1.3680043.10.743', m('00020012'));

        // "12.3…" and "13.4…" share the character "1" but no component, so there is no root to offer.
        await handleFiles(['12.3', '13.4'].map((r, i) => new File([Forge.build({
          rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
          modality: 'CT', instance: 1, studyUID: `${r}.1`, seriesUID: `${r}.2`, sopInstance: `${r}.3`,
          pixels: new Uint16Array(Forge.W * Forge.H),
        })], `n${i}.dcm`)));
        ok('uid: UIDs that share no full component get no UID Pattern panel',
           sharedUIDPrefix === '' && uidPattern.style.display === 'none', `${sharedUIDPrefix} / ${uidPattern.style.display}`);
      } finally { window.alert = realAlert; }
    }
  } catch (e) {
    uncount();
    ok('suite ran to completion', false, (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  }

  return out;
};

// Two callers: tests/run.sh injects this file alone and scrapes the <pre> below;
// index.html#selftest sets window.SELFTEST and awaits the returned lines instead.
if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.render()).join('\n');
  document.body.appendChild(pre);
});
