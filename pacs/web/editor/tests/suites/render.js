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
