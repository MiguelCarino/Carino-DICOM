// A DICOM dataset is a tree, and the Edit table has to be one too.
//
// A sequence used to render as a single row holding a run of backslashes, with
// everything inside it — codes, referenced instances, and after Anonymize the
// de-identification method itself — unreachable by the table, the search box,
// the export and the printed dump. This suite forges a file with a two-item
// sequence, a sequence nested inside one of its items, and an Icon Image
// Sequence carrying its own pixel data, then checks that the tree is visible,
// addressable, editable, and that a nested edit lands on the nested element and
// nowhere else.
(window.SUITES || (window.SUITES = {})).sequences = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);

  // Rows are addressed by their path, never by their tag code: a nested
  // (0010,0010) is a perfectly legal thing for a file to contain, and matching on
  // the code alone would find the wrong row. Case-insensitive because the key
  // form a dataset comes back in belongs to dcmjs, not to this suite.
  const rowByPath = (p) => [...tagBody.querySelectorAll('tr')].find(
    tr => (tr.dataset.path || '').toLowerCase() === p.toLowerCase());
  const realPath = (p) => rowByPath(p)?.dataset.path;
  const toggle = (p) => rowByPath(p)?.querySelector('.seq-toggle')?.click();
  const inputOf = (p) => rowByPath(p)?.children[3].querySelector('input');
  const padOf = (p) => parseInt(rowByPath(p)?.querySelector('.tag-cell')?.style.paddingLeft || '0', 10);
  const type = (p, v) => { const i = inputOf(p); i.value = v; i.dispatchEvent(new Event('input')); };
  // The app's own resolver, so a written file reads back the same way the app
  // would read it whichever key form it used.
  const at = (node, t) => (node ? lookupTag(node, t) : null);

  try {
    const n = Forge.W * Forge.H;
    const px = new Uint16Array(n);
    for (let i = 0; i < n; i++) px[i] = i & 0xFFF;

    // A 4x4 16-bit icon, so the Icon Image Sequence carries real pixel data and
    // the read-only rule has something to be wrong about.
    const icon = new Uint16Array(16);
    for (let i = 0; i < 16; i++) icon[i] = i * 17;
    const iconSeq = { vr: 'SQ', items: [{
      '00280002': { vr: 'US', v: [1] },
      '00280004': { vr: 'CS', v: ['MONOCHROME2'] },
      '00280010': { vr: 'US', v: [4] },
      '00280011': { vr: 'US', v: [4] },
      '00280100': { vr: 'US', v: [16] },
      '00280101': { vr: 'US', v: [16] },
      '00280102': { vr: 'US', v: [15] },
      '00280103': { vr: 'US', v: [0] },
      '7fe00010': { vr: 'OW', v: icon },
    }] };

    // Item 0 carries a nested Purpose of Reference Code Sequence two levels down,
    // and a PN — a nested tag that is also a top-level tag, on purpose.
    const refItem = (uid, name) => ({
      '00081150': { vr: 'UI', v: ['1.2.840.10008.5.1.4.1.1.7'] },
      '00081155': { vr: 'UI', v: [uid] },
      '00100010': { vr: 'PN', v: [name] },
      '00400555': { vr: 'SQ', items: [{
        '00080100': { vr: 'SH', v: ['NESTED1'] },
        '00080102': { vr: 'SH', v: ['CARINO'] },
        '00080104': { vr: 'LO', v: ['Deep code meaning'] },
      }] },
    });
    const plainItem = (uid) => ({
      '00081150': { vr: 'UI', v: ['1.2.840.10008.5.1.4.1.1.7'] },
      '00081155': { vr: 'UI', v: [uid] },
    });

    const base = {
      rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
      wc: 2048, ww: 4096, modality: 'CT',
      studyUID: '1.2.826.0.1.3680043.10.99999.9.1',
      seriesUID: '1.2.826.0.1.3680043.10.99999.9.2',
      pixels: px,
    };
    const a = Forge.build({ ...base, instance: 1, sopInstance: '1.2.826.0.1.3680043.10.99999.9.3.1',
      extra: {
        '00081140': { vr: 'SQ', items: [
          refItem('1.2.826.0.1.3680043.10.99999.9.4.1', 'Nested^One'),
          plainItem('1.2.826.0.1.3680043.10.99999.9.4.2'),
        ] },
        '00880200': iconSeq,
      } });
    // The same sequence with one more item, so the two files differ in a way that
    // only shows up if a sequence has a comparable value at all.
    const b = Forge.build({ ...base, instance: 2, sopInstance: '1.2.826.0.1.3680043.10.99999.9.3.2',
      extra: {
        '00081140': { vr: 'SQ', items: [
          refItem('1.2.826.0.1.3680043.10.99999.9.4.1', 'Nested^Two'),
          plainItem('1.2.826.0.1.3680043.10.99999.9.4.2'),
          plainItem('1.2.826.0.1.3680043.10.99999.9.4.3'),
        ] },
        '00880200': iconSeq,
      } });

    await handleFiles([new File([a], 'seq-a.dcm'), new File([b], 'seq-b.dcm')]);
    ok('a forged file with sequences loads at all', files.length === 2, String(files.length));
    const SEQ = at(files[0].dict, '00081140');
    ok('the forged sequence parses as a sequence with its items',
       !!SEQ && SEQ.vr === 'SQ' && SEQ.Value.length === 2,
       SEQ ? SEQ.vr + '/' + (SEQ.Value || []).length : 'missing');

    // ---- closed by default ---------------------------------------------------
    ok('a sequence renders one row', !!rowByPath('00081140'),
       Object.keys(files[0].dict).filter(k => /81140/i.test(k)).join(',') || 'no key');
    ok('and no children until it is opened', !rowByPath('00081140/0') && !rowByPath('00081140/1'));
    const seqRow = rowByPath('00081140');
    ok('the sequence row shows its item count, not a run of backslashes',
       seqRow?.querySelector('.seq-count')?.textContent === '2',
       JSON.stringify(seqRow?.querySelector('.seq-count')?.textContent));
    ok('and offers no value to type into', !seqRow?.querySelector('input'));
    // Stringifying a sequence gives one backslash per item boundary, which made
    // any two sequences of the same size read as identical no matter what was in
    // them. The count is the only thing about a sequence that compares.
    ok('a sequence compares by item count, not by stringifying its items',
       shownValue('00081140', SEQ, null) === '2',
       JSON.stringify(shownValue('00081140', SEQ, null)));
    ok('a sequence stays read-only', seqRow?.classList.contains('readonly-row'));

    // ---- opening -------------------------------------------------------------
    toggle('00081140');
    ok('opening a sequence reveals its items',
       !!rowByPath('00081140/0') && !!rowByPath('00081140/1'));
    ok('an item row says which item it is',
       rowByPath('00081140/0')?.querySelector('.seq-item-badge')?.textContent === '1 / 2',
       rowByPath('00081140/0')?.querySelector('.seq-item-badge')?.textContent);
    ok('but its contents wait for the item to be opened too',
       !rowByPath('00081140/0/00081155'));

    toggle('00081140/0');
    ok('opening an item reveals its elements', !!rowByPath('00081140/0/00081155'));
    ok('depth 2 works', !!rowByPath('00081140/0/00400555'));
    ok('a nested tag keeps its own description',
       rowByPath('00081140/0/00081155')?.querySelector('.desc-cell')?.textContent
         === descFor('00081155'),
       rowByPath('00081140/0/00081155')?.querySelector('.desc-cell')?.textContent);

    // A code sequence almost always holds exactly one item; two clicks to see one
    // row is the kind of friction that makes people stop expanding things.
    toggle('00081140/0/00400555');
    ok('a single-item sequence opens all the way in one click',
       !!rowByPath('00081140/0/00400555/0/00080100'));
    ok('depth 4 renders its value',
       inputOf('00081140/0/00400555/0/00080100')?.value === 'NESTED1',
       inputOf('00081140/0/00400555/0/00080100')?.value);
    ok('nested rows are indented by depth',
       padOf('00081140/0/00400555/0/00080100') > padOf('00081140/0/00400555'),
       padOf('00081140/0/00400555') + ' -> ' + padOf('00081140/0/00400555/0/00080100'));
    ok('and a top-level row is not indented at all', padOf('00100020') === 0,
       String(padOf('00100020')));

    toggle('00081140');
    ok('collapsing a sequence takes its whole subtree with it',
       !rowByPath('00081140/0') && !rowByPath('00081140/0/00400555/0/00080100'));

    // ---- search and filters reach the whole tree -----------------------------
    seqOpen.clear();
    renderTable();
    ok('nothing is open to start the search from', !rowByPath('00081140/0'));
    const openedBefore = seqOpen.size;

    searchQuery = 'NESTED1';
    renderTable();
    ok('search reaches a value four levels down',
       !!rowByPath('00081140/0/00400555/0/00080100'), String(tagBody.children.length));
    ok('and brings every ancestor with it as context',
       !!rowByPath('00081140') && !!rowByPath('00081140/0') && !!rowByPath('00081140/0/00400555')
       && !!rowByPath('00081140/0/00400555/0'));
    ok('while unrelated top-level rows go away', !rowByPath('00100020'));
    ok('and an unrelated sequence goes away too', !rowByPath('00880200'));

    searchQuery = '';
    renderTable();
    ok('search auto-expands without touching the open set',
       seqOpen.size === openedBefore && !rowByPath('00081140/0'),
       seqOpen.size + ' open');

    activeCat = 'patient';
    renderTable();
    ok('a category filter reaches nested values too',
       !!rowByPath('00081140/0/00100010') && !!rowByPath('00081140/0'),
       String(tagBody.children.length));
    ok('and still excludes what does not belong to it', !rowByPath('00081140/0/00081155'));
    activeCat = 'all';
    renderTable();

    // ---- nested binary stays read-only --------------------------------------
    toggle('00880200');
    ok('a single-item Icon Image Sequence opens in one click',
       !!rowByPath('00880200/0/00280010'), String(tagBody.children.length));
    const pxPath = [...tagBody.querySelectorAll('tr')]
      .map(tr => tr.dataset.path)
      .find(p => p && p.toLowerCase().startsWith('00880200/0/') && /7fe00010$/i.test(p));
    ok('the icon\'s own pixel data shows up as a row', !!pxPath, String(pxPath));
    ok('and is not editable', inputOf(pxPath || 'none')?.disabled === true);
    ok('nor does typing at it create a working-copy entry',
       ![...pendingEdits.keys()].some(k => /7fe00010$/i.test(k)),
       [...pendingEdits.keys()].filter(k => k.includes('/')).join(' '));
    toggle('00880200');

    // ---- editing a nested value ---------------------------------------------
    toggle('00081140');
    toggle('00081140/0');
    toggle('00081140/0/00400555');
    const NAME = realPath('00081140/0/00100010');
    const CODE = realPath('00081140/0/00400555/0/00080100');
    ok('a nested row is editable', inputOf(NAME)?.disabled === false);
    type(NAME, 'Edited^Nested');
    type(CODE, 'DEEPEDIT');
    ok('a nested edit is keyed by its path',
       pendingEdits.get(NAME)?.valueString === 'Edited^Nested', NAME);
    ok('and so is a two-deep one',
       pendingEdits.get(CODE)?.valueString === 'DEEPEDIT', CODE);
    ok('the top-level Patient Name is untouched by the nested one of the same tag',
       pendingEdits.get(editKey('00100010'))?.valueString === 'Forge^Test',
       pendingEdits.get(editKey('00100010'))?.valueString);

    // Item 1, so we can prove one item's edit does not bleed into another's.
    toggle('00081140/1');
    const UID1 = realPath('00081140/1/00081155');
    type(UID1, '1.2.826.0.1.3680043.10.99999.9.4.99');

    const wrote = DicomMessage.readFile(await buildEditedFile(files[0]).arrayBuffer());
    normBin(wrote.dict);
    const wseq = at(wrote.dict, '00081140');
    // The regression guard, first because everything below it depends on it.
    // dcmjs's Tag.fromString stops at the '/', so a path key reaching the plain
    // d[t] assignment writes (0008,1140) as the leaf element and the whole
    // sequence disappears from the file — silently, without throwing. The VR is
    // the tell: the write leaves a PN or a UI where the SQ used to be.
    ok('and the parent sequence is not overwritten by its own leaf',
       wseq?.vr === 'SQ', wseq ? wseq.vr : 'missing');
    ok('a path edit never becomes a top-level element',
       !Object.keys(wrote.dict).some(k => k.includes('/')),
       Object.keys(wrote.dict).filter(k => k.includes('/')).join(' '));
    ok('the written file still has all of the sequence\'s items',
       wseq?.Value?.length === 2, String(wseq?.Value?.length));

    const item0 = wseq?.Value?.[0], item1 = wseq?.Value?.[1];
    const deep = at(item0, '00400555')?.Value?.[0];
    ok('a nested edit lands on the nested element',
       elToString(at(item0, '00100010')).trim() === 'Edited^Nested',
       elToString(at(item0, '00100010')));
    ok('a two-deep nested edit lands too',
       elToString(at(deep, '00080100')).trim() === 'DEEPEDIT',
       elToString(at(deep, '00080100')));
    ok('its siblings inside the same item survive',
       elToString(at(deep, '00080104')).trim() === 'Deep code meaning',
       elToString(at(deep, '00080104')));
    ok('an edit to one item does not touch the other',
       elToString(at(item1, '00081155')).trim() === '1.2.826.0.1.3680043.10.99999.9.4.99' &&
       elToString(at(item0, '00081155')).trim() === '1.2.826.0.1.3680043.10.99999.9.4.1',
       elToString(at(item0, '00081155')) + ' | ' + elToString(at(item1, '00081155')));
    ok('the top-level tag of the same name is written from the top level',
       elToString(at(wrote.dict, '00100010')).trim() === 'Forge^Test',
       elToString(at(wrote.dict, '00100010')));
    ok('the pixel data still made it out',
       (at(wrote.dict, '7fe00010')?.Value?.[0]?.byteLength || 0) > 0,
       String(at(wrote.dict, '7fe00010')?.Value?.[0]?.byteLength));
    ok('and so did the icon inside the sequence',
       (at(at(wrote.dict, '00880200')?.Value?.[0], '7fe00010')?.Value?.[0]?.byteLength || 0) === 32,
       String(at(at(wrote.dict, '00880200')?.Value?.[0], '7fe00010')?.Value?.[0]?.byteLength));

    // isReadOnly is the last thing a path key passes before it is written, so it
    // has to answer about the element, not about the string it arrived in.
    ok('isReadOnly judges the leaf of a path, not the path',
       isReadOnly('00081140/0/7fe00010', '') === true &&
       isReadOnly('00081140/0/00080100', 'SH') === false,
       String(isReadOnly('00081140/0/7fe00010', '')));

    // A path can go stale — the item it named is gone because the file was
    // anonymised or reloaded under the working copy. That must cost nothing.
    pendingEdits.set('00081140/9/00100010', { vr: 'PN', valueString: 'Ghost^Item' });
    pendingEdits.set('0040a730/0/00080100', { vr: 'SH', valueString: 'NoSuchSeq' });
    const stale = DicomMessage.readFile(await buildEditedFile(files[0]).arrayBuffer());
    ok('a stale path is a silent no-op, not a corrupted file',
       at(stale.dict, '00081140')?.Value?.length === 2 && !at(stale.dict, '0040a730'),
       String(at(stale.dict, '00081140')?.Value?.length));
    pendingEdits.delete('00081140/9/00100010');
    pendingEdits.delete('0040a730/0/00080100');

    // ---- the export and the printed dump carry the tree ---------------------
    // flattenTags is what the printed tag dump walks too; before this it stopped
    // at the top level, so a printed dump of an SR was headers and no content.
    const flat = flattenTags(tagsOf(files[0]));
    ok('the flattener descends into sequences',
       flat.some(r => r.path.toLowerCase() === '00081140/0/00400555/0/00080100'),
       flat.filter(r => r.path.includes('/')).length + ' nested');
    ok('and reports how deep each row is',
       flat.find(r => r.path.toLowerCase() === '00081140/0/00400555/0/00080100')?.depth === 2,
       String(flat.find(r => r.path.toLowerCase() === '00081140/0/00400555/0/00080100')?.depth));

    const exported = getExportRows();
    ok('the tag export reaches nested values',
       exported.some(r => r.tag === '(0008,1140)[0].(0040,0555)[0].(0008,0100)'),
       exported.filter(r => r.tag.includes('[')).length + ' nested rows');
    ok('and shows the edited nested value, not the loaded one',
       exported.find(r => r.tag === '(0008,1140)[0].(0010,0010)')?.value === 'Edited^Nested',
       exported.find(r => r.tag === '(0008,1140)[0].(0010,0010)')?.value);
    ok('a sequence exports its item count instead of backslashes',
       exported.find(r => r.tag === '(0008,1140)')?.value === '2',
       JSON.stringify(exported.find(r => r.tag === '(0008,1140)')?.value));
    ok('and the top-level rows are unchanged in shape',
       exported.some(r => r.tag === '(0002,0010)') && exported.some(r => r.tag === '(0010,0010)'));

    // ---- comparing ----------------------------------------------------------
    document.getElementById('compareWith').value = '1';
    document.getElementById('compareWith').dispatchEvent(new Event('change'));
    ok('the comparison opens', compareEntry() === files[1]);

    seqOpen.clear();
    renderTable();
    const collapsedStats = document.getElementById('cmpStatRow').textContent;
    ok('a differing sequence no longer reads as a match',
       rowByPath('00081140')?.classList.contains('cmp-diff'), rowByPath('00081140')?.className);
    ok('the sequence row counts each side\'s items',
       rowByPath('00081140')?.children[3].querySelector('.seq-count')?.textContent === '2' &&
       rowByPath('00081140')?.children[4].querySelector('.seq-count')?.textContent === '3',
       rowByPath('00081140')?.children[4].querySelector('.seq-count')?.textContent);

    toggle('00081140');
    toggle('00081140/0');
    const nested = rowByPath('00081140/0/00100010');
    ok('nested rows are shown while comparing', !!nested);
    ok('and coloured by what they are', nested?.classList.contains('cmp-diff'), nested?.className);
    ok('but not editable on either side',
       nested?.children[3].querySelector('input')?.disabled === true &&
       nested?.children[4].querySelector('input')?.disabled === true);
    ok('and carry no copy arrows — copying one would have to invent items',
       !nested?.querySelector('.cmp-copy-btn'));
    ok('an item row keeps the comparison\'s cell count',
       rowByPath('00081140/0')?.children.length === 6,
       String(rowByPath('00081140/0')?.children.length));
    ok('the compare tally counts top level only',
       document.getElementById('cmpStatRow').textContent === collapsedStats,
       collapsedStats + ' -> ' + document.getElementById('cmpStatRow').textContent);

    document.getElementById('cmpClose').click();

    // ---- paging through a series keeps the tree where you left it -----------
    seqOpen.clear();
    renderTable();
    toggle('00081140');
    toggle('00081140/0');
    ok('something is open before the switch', !!rowByPath('00081140/0/00081155'));
    switchFile(1);
    ok('the slices of one series share a structure, so it stays open',
       !!rowByPath('00081140/0/00081155'), String(seqOpen.size));
    ok('and the values shown are the file we switched to\'s',
       inputOf('00081140/0/00100010')?.value === 'Nested^Two',
       inputOf('00081140/0/00100010')?.value);
    switchFile(0);

    // ---- a new study is a new tree ------------------------------------------
    ok('something is open before the reload', seqOpen.size > 0, String(seqOpen.size));
    await handleFiles([new File([a], 'again.dcm')]);
    ok('loading a new study forgets what was open', seqOpen.size === 0, String(seqOpen.size));
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
  pre.textContent = (await window.SUITES.sequences()).join('\n');
  document.body.appendChild(pre);
});
