// Browser self-test (#selftest): runs tests/suites in the visitor's browser and reports
// which transfer syntaxes / photometric interpretations this browser decodes.
// Page-load route only: suites mutate session state, so it never runs over an open study
// and exits by reload. Suites register on window.SUITES, so ./tests/run.sh shares them.

// Must match tests/suites (a browser cannot glob it); tests/suites/selftest.js checks this.
// Ordered parse -> decode -> display -> edit -> export, not alphabetically.
const SELFTEST_SUITES = ['boot', 'loading', 'folder', 'pixels', 'viewer', 'render', 'phone',
                         'sequences', 'series', 'edits', 'imgedit', 'compare', 'deid',
                         'redact', 'samples', 'zip'];

// PS3.6 Annex A names, kept in English so bug reports stay searchable.
const TS_NAMES = {
  '1.2.840.10008.1.2':        'Implicit VR Little Endian',
  '1.2.840.10008.1.2.1':      'Explicit VR Little Endian',
  '1.2.840.10008.1.2.1.99':   'Deflated Explicit VR Little Endian',
  '1.2.840.10008.1.2.2':      'Explicit VR Big Endian',
  '1.2.840.10008.1.2.5':      'RLE Lossless',
  '1.2.840.10008.1.2.4.50':   'JPEG Baseline (Process 1)',
  '1.2.840.10008.1.2.4.51':   'JPEG Extended (Process 2 & 4)',
  '1.2.840.10008.1.2.4.57':   'JPEG Lossless, Non-Hierarchical (Process 14)',
  '1.2.840.10008.1.2.4.70':   'JPEG Lossless, First-Order Prediction (Process 14 SV1)',
  '1.2.840.10008.1.2.4.80':   'JPEG-LS Lossless',
  '1.2.840.10008.1.2.4.81':   'JPEG-LS Near-Lossless',
  '1.2.840.10008.1.2.4.90':   'JPEG 2000 Lossless Only',
  '1.2.840.10008.1.2.4.91':   'JPEG 2000',
  '1.2.840.10008.1.2.4.100':  'MPEG2 Main Profile / Main Level',
  '1.2.840.10008.1.2.4.201':  'High-Throughput JPEG 2000 Lossless Only',
  '1.2.840.10008.1.2.4.202':  'High-Throughput JPEG 2000 with RPCL, Lossless Only',
  '1.2.840.10008.1.2.4.203':  'High-Throughput JPEG 2000',
};
function tsName(uid) { return TS_NAMES[uid] || (uid ? uid : 'unreadable file meta'); }

function selftestScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => res();
    s.onerror = () => rej(new Error(src + ' could not be loaded'));
    document.head.appendChild(s);
  });
}

// Assertions are named "<case id>: ..." in tests/suites. The trailing colon is required and the
// leading boundary excludes '-', so "jls-rgb" does not match "jls-rgb-planar".
function selftestMentions(name, id) {
  return new RegExp('(^|[^A-Za-z0-9-])' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':').test(name);
}

// Read TS/PI from the bytes, not the case config: malformed cases may not match their recipe.
function selftestDescribe(bytes) {
  try {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const msg = DicomMessage.readFile(buf);
    const ts  = msg.meta && getTag(msg.meta, '00020010');
    const pi  = getTag(msg.dict, '00280004');
    return {
      ts: String((ts && ts.Value && ts.Value[0]) || '').trim(),
      pi: String((pi && pi.Value && pi.Value[0]) || '').trim(),
    };
  } catch (_) {
    return { ts: '', pi: '' };
  }
}

// Report as data, separate from the DOM, so displayed, copied and asserted numbers agree.
function selftestSummarize(runs, specimens) {
  const all = [];
  for (const r of runs) {
    for (const line of r.lines) {
      const rest = line.slice(line.indexOf('::') + 3);
      all.push({ suite: r.name, pass: line.startsWith('PASS ::'), name: rest.split(' :: ')[0], line });
    }
  }

  // One row per (transfer syntax, photometric interpretation): the two axes a decoder fails on.
  const rows = [];
  const byKey = new Map();
  for (const spec of specimens) {
    const d = selftestDescribe(spec.bytes);
    const key = d.ts + '|' + d.pi;
    let row = byKey.get(key);
    if (!row) { row = { ts: d.ts, pi: d.pi, specs: [], total: 0, failed: [] }; byKey.set(key, row); rows.push(row); }
    const mine = all.filter(a => selftestMentions(a.name, spec.id));
    row.specs.push({ id: spec.id, title: spec.title, broken: !!spec.broken, total: mine.length });
    row.total += mine.length;
    for (const a of mine) if (!a.pass) row.failed.push(a);
  }
  for (const row of rows) {
    // broken:true cases pass by being refused with a reason; they are not counted as decodes.
    row.designed = row.specs.every(s => s.broken);
    // A row can mix good and deliberately broken files, so decoded and refused are counted apart.
    row.brokenCount = row.specs.filter(s => s.broken).length;
    row.decodedCount = row.specs.length - row.brokenCount;
    row.status = row.total === 0 ? 'skip' : (row.failed.length ? 'fail' : 'pass');
  }

  const decodable = rows.filter(r => !r.designed && r.status !== 'skip');
  const refused   = rows.filter(r => r.designed && r.status !== 'skip');
  return {
    rows, all, runs,
    decodable, good: decodable.filter(r => r.status === 'pass'),
    refused, refusedOk: refused.filter(r => r.status === 'pass'),
    assertions: all.length,
    failures: all.filter(a => !a.pass),
    ms: runs.reduce((n, r) => n + (r.ms || 0), 0),
  };
}

function selftestEnv() {
  return [
    'URL:        ' + location.href,
    'Date:       ' + new Date().toISOString(),
    'User agent: ' + navigator.userAgent,
    'Screen:     ' + screen.width + 'x' + screen.height + ' @ ' + (window.devicePixelRatio || 1) + 'x',
    'Language:   ' + (navigator.language || '?'),
  ];
}

// Plain text for pasting into a GitHub issue.
function selftestReportText(sum) {
  const L = ['Carino DICOM Editor — browser self-test', ...selftestEnv(), ''];
  L.push(`Encodings decoded correctly: ${sum.good.length} of ${sum.decodable.length}`);
  if (sum.refused.length) L.push(`Encodings correctly refused:  ${sum.refusedOk.length} of ${sum.refused.length}`);
  L.push(`Assertions passed:           ${sum.assertions - sum.failures.length} of ${sum.assertions} (${sum.ms} ms)`, '');

  L.push('ENCODINGS');
  for (const r of sum.rows) {
    const mark = r.status === 'pass' ? (r.designed ? '[refused]' : r.brokenCount ? '[ok+ref] ' : '[ok]     ')
               : r.status === 'fail' ? '[FAILED] ' : '[skipped]';
    L.push(`${mark} ${tsName(r.ts)} · ${r.pi || '—'}`);
    L.push(`          ${r.ts || '(no transfer syntax)'} — ${r.specs.map(s => s.id).join(', ')}`);
  }
  L.push('');

  L.push('SUITES');
  for (const r of sum.runs) {
    const bad = r.lines.filter(l => l.startsWith('FAIL ::')).length;
    L.push(`  ${r.name.padEnd(10)} ${r.lines.length - bad}/${r.lines.length}  ${r.ms} ms`);
  }
  L.push('');

  L.push(`FAILURES (${sum.failures.length})`);
  if (!sum.failures.length) L.push('  none');
  for (const f of sum.failures) L.push(`  ${f.suite} :: ${f.line.slice(f.line.indexOf('::') + 3)}`);
  return L.join('\n');
}

// ---- Report rendering ----
function selftestEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function selftestTable(heads) {
  const wrap = selftestEl('div', 'st-wrap'), tbl = selftestEl('table', 'st-table');
  const thead = document.createElement('thead'), tr = document.createElement('tr');
  heads.forEach(h => tr.appendChild(selftestEl('th', null, h)));
  thead.appendChild(tr); tbl.appendChild(thead);
  const tbody = document.createElement('tbody');
  tbl.appendChild(tbody); wrap.appendChild(tbl);
  return { wrap, tbody };
}

function selftestVerdict(row) {
  const el = selftestEl;
  if (row.status === 'skip') return el('span', 'st-skip', T('Not covered'));
  if (row.status === 'fail') return el('span', 'st-fail', '✕ ' + T('{n} assertion(s) failed').replace('{n}', row.failed.length));
  if (row.designed) return el('span', 'st-pass', '✓ ' + T('Correctly refused'));
  if (row.brokenCount) return el('span', 'st-pass', '✓ ' +
    T('{n} decoded, {k} correctly refused').replace('{n}', row.decodedCount).replace('{k}', row.brokenCount));
  return el('span', 'st-pass', '✓ ' + T('Decoded correctly'));
}

function selftestRenderSummary(root, sum) {
  const el = selftestEl;
  root.appendChild(el('div', 'st-headline',
    T('Your browser decoded {n} of {total} DICOM encodings correctly.')
      .replace('{n}', sum.good.length).replace('{total}', sum.decodable.length)));

  const subs = [];
  if (sum.refused.length) {
    subs.push(sum.refusedOk.length === sum.refused.length
      ? T('Encodings that no browser can decode: {k} — every one of them was refused with an explanation, as it should be.').replace('{k}', sum.refused.length)
      : T('Encodings that should have been refused but were not: {j} of {k}.')
          .replace('{j}', sum.refused.length - sum.refusedOk.length).replace('{k}', sum.refused.length));
  }
  subs.push(T('{p} of {n} assertions passed, in {ms} ms.')
    .replace('{p}', sum.assertions - sum.failures.length).replace('{n}', sum.assertions).replace('{ms}', sum.ms));
  root.appendChild(el('div', 'st-sub', subs.join(' ')));
}

function selftestRenderMatrix(root, sum) {
  const el = selftestEl;
  root.appendChild(el('div', 'st-sec', T('Transfer syntax support')));
  const { wrap, tbody } = selftestTable([T('Transfer syntax'), T('Photometric interpretation'), T('Test files'), T('Result')]);
  for (const r of sum.rows) {
    const tr = document.createElement('tr');
    const name = el('td', null, tsName(r.ts));
    name.appendChild(el('span', 'st-uid', r.ts || '—'));
    const files = el('td', null, String(r.specs.length));
    files.appendChild(el('div', 'st-ids', r.specs.map(s => s.id).join(' ')));
    const res = el('td');
    res.appendChild(selftestVerdict(r));
    if (r.failed.length) {
      const ul = el('ul', 'st-fails');
      r.failed.forEach(f => ul.appendChild(el('li', null, f.name)));
      res.appendChild(ul);
    }
    tr.append(name, el('td', null, r.pi || '—'), files, res);
    tbody.appendChild(tr);
  }
  root.appendChild(wrap);
}

function selftestRenderSuites(root, sum) {
  const el = selftestEl;
  root.appendChild(el('div', 'st-sec', T('Suites')));
  const { wrap, tbody } = selftestTable([T('Suite'), T('Assertions'), T('Failures')]);
  for (const r of sum.runs) {
    const bad = r.lines.filter(l => l.startsWith('FAIL ::'));
    const tr = document.createElement('tr');
    const fails = el('td');
    if (bad.length) {
      const ul = el('ul', 'st-fails');
      bad.forEach(l => ul.appendChild(el('li', null, l.slice(l.indexOf('::') + 3))));
      fails.appendChild(ul);
    } else {
      fails.appendChild(el('span', 'st-pass', '—'));
    }
    const count = el('td');
    count.appendChild(el('span', bad.length ? 'st-fail' : 'st-pass',
      `${r.lines.length - bad.length} / ${r.lines.length}`));
    count.appendChild(el('span', 'st-uid', r.ms + ' ms'));
    tr.append(el('td', null, r.name), count, fails);
    tbody.appendChild(tr);
  }
  root.appendChild(wrap);
}

async function selftestCopyReport(sum) {
  const text = selftestReportText(sum);
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    // No clipboard permission or insecure context: fall back to execCommand on a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (__) { /* nothing left to try */ }
    ta.remove();
  }
  toast?.(T('Report copied to the clipboard.'));
}

function selftestRenderActions(root, sum) {
  const el = selftestEl;
  const acts = el('div', 'st-acts');
  const copy = el('button', 'btn primary', T('Copy report'));
  copy.id = 'stCopy';
  copy.addEventListener('click', () => selftestCopyReport(sum));
  const issue = el('a', 'btn', T('Report a problem →'));
  issue.href = 'https://github.com/MiguelCarino/Carino-DICOM-Editor/issues/new';
  issue.target = '_blank'; issue.rel = 'noopener';
  acts.append(copy, issue);
  root.appendChild(acts);
  root.appendChild(el('div', 'st-env', selftestEnv().join('\n')));
}

function renderSelfTest(root, sum) {
  root.replaceChildren();
  root.classList.remove('hidden');
  selftestRenderSummary(root, sum);
  selftestRenderMatrix(root, sum);   // transfer syntax support
  selftestRenderSuites(root, sum);   // per-suite results
  selftestRenderActions(root, sum);  // copy report / file an issue
}

// Route guards (testable without reloading): hash names the self-test, a PACS #load= wins,
// and never over an open study.
function selftestWanted(hash, fileCount) {
  return /[#&?]selftest\b/.test(hash) && !/[#&?]load=/.test(hash) && !fileCount;
}

function runSelfTest(names) {
  names = names || SELFTEST_SUITES;
  const box    = $('selftest');
  const status = $('stStatus');
  const fill   = $('stBarFill');
  const result = $('stResult');
  box.classList.remove('hidden');
  // Exit by reload: the suites have loaded files, switched tabs and stubbed globals.
  $('stBack').onclick =
    () => location.replace(location.pathname + location.search);

  const step = (msg, frac) => { status.textContent = msg; fill.style.width = Math.round(frac * 100) + '%'; };
  // Yield between suites so the progress line repaints.
  const breathe = () => new Promise(r => setTimeout(r, 0));

  return (async () => {
    let forge;
    try {
      step(T('Loading the test suites…'), 0.03);
      window.SELFTEST = true;         // suites register on window.SUITES instead of self-starting
      forge = await window.__loadForge();
      await Promise.all(names.map(n => selftestScript('tests/suites/' + n + '.js')));
    } catch (err) {
      step(T('The test suites could not be loaded. They are served from tests/, which this deployment may have pruned.') +
           ' — ' + ((err && err.message) || err), 0);
      return null;
    }

    const runs = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      step(T('Running {n}…').replace('{n}', name), (i + 0.5) / (names.length + 1));
      await breathe();
      const t0 = performance.now();
      let lines;
      try {
        lines = (await window.SUITES[name]()) || [];
      } catch (err) {
        // A suite that throws still appears in the report.
        lines = ['FAIL :: ' + name + ': the suite ran to completion :: ' + ((err && err.message) || err)];
      }
      runs.push({ name, lines, ms: Math.round(performance.now() - t0) });
    }

    step(T('Building the report…'), 1);
    await breathe();
    const specimens = [...(await forge.corpus()), ...forge.samples()];
    const sum = selftestSummarize(runs, specimens);
    renderSelfTest(result, sum);
    // Hide the finished progress line and bar.
    status.textContent = '';
    status.classList.add('hidden');
    $('stBar').classList.add('hidden');
    return sum;
  })();
}

// Exposed for tests/suites/selftest.js, which checks the report without running every suite.
window.__selftest = {
  run: runSelfTest, summarize: selftestSummarize, reportText: selftestReportText,
  render: renderSelfTest, describe: selftestDescribe, mentions: selftestMentions,
  wanted: selftestWanted, tsName, suites: SELFTEST_SUITES,
  // Indirect so the suite can stub it; location.reload itself cannot be replaced.
  reload: () => { unloadConfirmed = true; location.hash = 'selftest'; location.reload(); },
};

