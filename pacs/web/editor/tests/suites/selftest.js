// The suites, run in the visitor's browser.
//
// index.html#selftest loads every file in this directory into the live page and
// prints what came back as a support matrix: which transfer syntax and which
// photometric interpretation this browser got right, which it refused, and which
// it got wrong. That report is the artefact — somebody will paste it into a bug
// report and somebody else will read it as a conformance claim — so the numbers
// in it have to be checked as carefully as the decoder is.
//
// This suite therefore does not run the other thirteen. It checks the machinery
// that turns their output into the report: how an assertion is attributed to a
// file, how files are grouped into encodings, which encodings count towards the
// headline, and what the copied text says. Those are pure functions, so they are
// fed known input and compared against a hand-computed answer. The one thing
// that cannot be faked — that the harness really can drive a real suite in a
// live page — is done once, for real, with the cheapest suite there is.
(window.SUITES || (window.SUITES = {})).selftest = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const $ = (id) => document.getElementById(id);

  try {
    const ST = window.__selftest;
    ok('the self-test exposes its pieces for testing', !!ST && typeof ST.summarize === 'function');

    // ---- the page it lives in ----------------------------------------------
    {
      ok('the overlay is in the markup', !!$('selftest'));
      ok('and is hidden in an ordinary session', $('selftest').classList.contains('hidden'));
      ok('it is not inside the app shell it has to cover',
         !document.querySelector('.app')?.contains($('selftest')));
      for (const id of ['stStatus', 'stBarFill', 'stResult', 'stBack']) {
        ok(`the overlay carries #${id}`, !!$(id));
      }
      const link = $('selftestLink');
      ok('the Info dropdown offers the self-test', !!link && link.getAttribute('href') === '#selftest',
         link ? link.getAttribute('href') : 'no link');
      ok('and it sits in the Test corpus section beside the gallery',
         !!link && !!$('diagBox') && $('diagBox').contains(link));
    }

    // ---- the route's guards -------------------------------------------------
    // Written as one predicate precisely so they can be asked about here: the
    // route itself only ever runs once, on load, before any test exists.
    {
      ok('#selftest with nothing loaded runs', ST.wanted('#selftest', 0) === true);
      ok('a query string spelling works too', ST.wanted('?selftest', 0) === true);
      ok('#selftest with a study open does not', ST.wanted('#selftest', 3) === false);
      ok('a PACS hand-off beats it', ST.wanted('#selftest&load=https://x/y.json', 0) === false);
      ok('and it does not fire on some other hash', ST.wanted('#case=rle-mono16', 0) === false);
      ok('nor on a hash that merely starts the same way', ST.wanted('#selftesting', 0) === false);
    }

    // ---- the link asks before it throws a session away ----------------------
    {
      const link = $('selftestLink');
      const realReload = ST.reload;
      let reloads = 0;
      ST.reload = () => { reloads++; };

      const hashBefore = location.hash;
      link.click();
      ok('with nothing open the link goes straight there', reloads === 1, String(reloads));
      ok('and it never navigates by href, which would only move the hash',
         location.hash === hashBefore, location.hash);

      // Now with a study open. This is the whole reason the self-test is a route
      // and not a button: the suites behind it call handleFiles().
      await handleFiles([new File([Forge.build({ rows: 8, cols: 8, pi: 'MONOCHROME2', ba: 8, bs: 8, hb: 7, pr: 0,
                                                 pixels: new Uint8Array(64) })], 'open.dcm')]);
      reloads = 0;
      link.click();
      const ov = $('confirmOverlay');
      ok('with a study open it asks first', ov.classList.contains('visible') && reloads === 0,
         `visible=${ov.classList.contains('visible')} reloads=${reloads}`);
      ok('and the question says what will be lost',
         $('confirmMsg').textContent === (window.t || String)('The self-test loads test files of its own. The study you have open, and any edits you have not exported, will be discarded.'),
         $('confirmMsg').textContent.slice(0, 60));
      $('confirmOk').click();
      ok('answering yes is what starts it', reloads === 1, String(reloads));

      ST.reload = realReload;
      files.length = 0;
    }

    // ---- attributing an assertion to a file ---------------------------------
    // Every suite names its assertions "<case id>: what it checks". That naming
    // is load-bearing now, so the edges of the rule are pinned down here.
    {
      ok('a bare assertion belongs to its case', ST.mentions('jls-rgb: colours match', 'jls-rgb'));
      ok('so does a prefixed one', ST.mentions('overview jls-rgb: renders', 'jls-rgb'));
      ok('a longer id is not swallowed by a shorter one',
         !ST.mentions('jls-rgb-planar: colours match', 'jls-rgb'));
      ok('nor is a shorter id caught inside a longer word',
         !ST.mentions('xjls-rgb: colours match', 'jls-rgb'));
      ok('the colon is required', !ST.mentions('jls-rgb decodes', 'jls-rgb'));
      ok('and a dotted id is matched literally, not as a wildcard',
         !ST.mentions('axb: something', 'a.b'));
    }

    // ---- reading an encoding back out of the bytes --------------------------
    {
      const cases = await Forge.corpus();
      const byId = Object.fromEntries(cases.map(c => [c.id, c]));
      const missing = cases.filter(c => !/^1\.2\.840\.10008\.1\.2/.test(ST.describe(c.bytes).ts));
      ok('every case reports a transfer syntax', missing.length === 0,
         missing.map(c => c.id).join(', '));

      // Against the reference the forge computed, not against another read of
      // the same element: the point is that the report describes the file.
      const wrong = cases.filter(c => c.ref && c.ref.pi && ST.describe(c.bytes).pi !== c.ref.pi);
      ok('and the photometric interpretation the forge built into it',
         wrong.length === 0, wrong.map(c => `${c.id}: ${ST.describe(c.bytes).pi} want ${c.ref.pi}`).join(' | '));

      const spot = [['big-endian', '1.2.840.10008.1.2.2'], ['implicit-vr', '1.2.840.10008.1.2'],
                    ['rle-mono16', '1.2.840.10008.1.2.5'], ['jls-rgb', '1.2.840.10008.1.2.4.80']];
      for (const [id, ts] of spot) {
        ok(`${id} is read as ${ts}`, ST.describe(byId[id].bytes).ts === ts, ST.describe(byId[id].bytes).ts);
      }
      ok('a transfer syntax gets the standard\'s own name',
         ST.tsName('1.2.840.10008.1.2.5') === 'RLE Lossless', ST.tsName('1.2.840.10008.1.2.5'));
      ok('and one nobody has named prints as its UID',
         ST.tsName('1.2.3.4') === '1.2.3.4', ST.tsName('1.2.3.4'));
      ok('an unreadable file meta says so rather than showing an empty cell',
         /unreadable/i.test(ST.tsName('')), ST.tsName(''));
    }

    // ---- the summary, on input whose right answer is known ------------------
    // Four hand-built specimens: two encodings that must be decoded, one that is
    // unsupported by design, and one nothing asserts on at all.
    const mk = (over) => Forge.build(Object.assign({
      rows: 8, cols: 8, pi: 'MONOCHROME2', ba: 8, bs: 8, hb: 7, pr: 0, pixels: new Uint8Array(64),
    }, over));
    const specimens = [
      { id: 'sp-mono', bytes: mk({}) },
      { id: 'sp-mono2', bytes: mk({}) },                              // same encoding as sp-mono
      { id: 'sp-rgb', bytes: mk({ pi: 'RGB', spp: 3, pixels: new Uint8Array(64 * 3) }) },
      // Encapsulated, because that is what an unsupported syntax actually looks
      // like: a bitstream in Pixel Data with no decoder behind it.
      { id: 'sp-nope', broken: true,
        bytes: Forge.build({ rows: 8, cols: 8, pi: 'YBR_PARTIAL_420', spp: 3, ba: 8, bs: 8, hb: 7, pr: 0,
                             ts: '1.2.840.10008.1.2.4.100',
                             encapsulated: [new Uint8Array([0, 0, 1, 0xB3, 0, 0, 0, 0]).buffer] }) },
      { id: 'sp-quiet', bytes: mk({ pi: 'MONOCHROME1' }) },
    ];
    const runs = [
      { name: 'alpha', ms: 10, lines: ['PASS :: sp-mono: decodes', 'PASS :: sp-mono2: decodes',
                                       'PASS :: sp-nope: is refused', 'PASS :: something unrelated'] },
      { name: 'beta',  ms: 30, lines: ['FAIL :: sp-rgb: colours match :: 12 px differ',
                                       'PASS :: sp-rgb: geometry survives'] },
    ];
    const sum = ST.summarize(runs, specimens);
    const LE = '1.2.840.10008.1.2.1';
    const row = (ts, pi) => sum.rows.find(r => r.ts === ts && r.pi === pi);

    ok('one row per transfer syntax and photometric interpretation',
       sum.rows.length === 4, sum.rows.map(r => `${r.ts}/${r.pi}`).join(' '));
    ok('two files in the same encoding share a row',
       row(LE, 'MONOCHROME2').specs.map(s => s.id).join(',') === 'sp-mono,sp-mono2',
       row(LE, 'MONOCHROME2').specs.map(s => s.id).join(','));
    ok('a row all of whose assertions passed is a pass', row(LE, 'MONOCHROME2').status === 'pass');
    ok('a row with a failing assertion is a failure', row(LE, 'RGB').status === 'fail');
    ok('and it carries the assertion that failed',
       row(LE, 'RGB').failed.length === 1 && row(LE, 'RGB').failed[0].suite === 'beta',
       JSON.stringify(row(LE, 'RGB').failed.map(f => f.name)));
    ok('a file nothing asserts on is not counted as a pass',
       row(LE, 'MONOCHROME1').status === 'skip', row(LE, 'MONOCHROME1').status);

    ok('the headline counts encodings a browser is meant to decode',
       sum.decodable.length === 2, sum.decodable.map(r => r.pi).join(','));
    ok('and only the ones that came back clean',
       sum.good.length === 1 && sum.good[0] === row(LE, 'MONOCHROME2'), String(sum.good.length));
    ok('an encoding no browser has a codec for is counted separately',
       sum.refused.length === 1 && sum.refusedOk.length === 1 && sum.refused[0].designed === true,
       `${sum.refused.length}/${sum.refusedOk.length}`);
    ok('a deliberately unsupported file is never counted as a decode',
       !sum.decodable.some(r => r.designed));
    ok('assertions are counted across every suite', sum.assertions === 6, String(sum.assertions));
    ok('failures are collected across every suite',
       sum.failures.length === 1 && sum.failures[0].suite === 'beta', String(sum.failures.length));
    ok('an assertion naming no case still counts towards the total',
       sum.assertions - sum.rows.reduce((n, r) => n + r.total, 0) === 1);
    ok('the time is the sum of the suites', sum.ms === 40, String(sum.ms));

    // A mixed row — a malformed file sitting in an encoding that also has good
    // files in it — is an encoding the browser does decode, and must not be
    // demoted to "unsupported by design".
    {
      const mixed = ST.summarize(
        [{ name: 'a', ms: 1, lines: ['PASS :: sp-mono: decodes', 'PASS :: sp-bad: is refused'] }],
        [{ id: 'sp-mono', bytes: mk({}) }, { id: 'sp-bad', bytes: mk({}), broken: true }]);
      ok('one broken file does not make its whole encoding unsupported',
         mixed.rows.length === 1 && mixed.rows[0].designed === false && mixed.decodable.length === 1);
      // …but it must not be reported as though all of them decoded either. The
      // JPEG 2000 MONOCHROME2 row really does hold one real image, a truncated
      // codestream and a High-Throughput stream, and a bare "Decoded correctly"
      // over the three claims two decodes that were never meant to happen.
      ok('and a mixed row counts what actually decoded',
         mixed.rows[0].decodedCount === 1 && mixed.rows[0].brokenCount === 1,
         `${mixed.rows[0].decodedCount} decoded / ${mixed.rows[0].brokenCount} broken`);
      const host = document.createElement('div');
      ST.render(host, mixed);
      ok('and says so rather than claiming both decoded',
         /1 .*1/.test(host.textContent) && !/✓ Decoded correctly/.test(host.textContent),
         (host.textContent.match(/✓[^✓]{0,40}/) || [''])[0]);
      ok('a row with nothing broken in it still reads plainly',
         /Decoded correctly/.test((() => { const h = document.createElement('div'); ST.render(h, sum); return h.textContent; })()));
    }

    // ---- the copied report --------------------------------------------------
    {
      const text = ST.reportText(sum);
      ok('the report is plain text, not markup', !/[<>]/.test(text), text.slice(0, 60));
      ok('it names the tool', /browser self-test/i.test(text));
      ok('it carries the user agent, so two reports can be told apart',
         text.includes(navigator.userAgent));
      ok('it carries the URL and the date', text.includes(location.href) && /\d{4}-\d\d-\d\dT/.test(text));
      ok('it leads with the headline numbers', /Encodings decoded correctly: 1 of 2/.test(text),
         (text.match(/Encodings decoded correctly.*/) || [''])[0]);
      ok('it says how many assertions ran', /Assertions passed:\s+5 of 6/.test(text),
         (text.match(/Assertions passed.*/) || [''])[0]);
      ok('every encoding is listed with its UID',
         text.includes('1.2.840.10008.1.2.1') && text.includes('1.2.840.10008.1.2.4.100'));
      ok('a refused encoding is marked as refused, not as a failure',
         /\[refused\].*MPEG2/.test(text), (text.match(/\[refused\].*/) || [''])[0]);
      ok('the failing encoding is marked as failed', /\[FAILED\].*RGB/.test(text),
         (text.match(/\[FAILED\].*/) || [''])[0]);
      ok('and the failure itself is quoted in full, with its suite',
         text.includes('beta :: sp-rgb: colours match :: 12 px differ'));
      ok('a clean run says so instead of printing an empty list',
         /FAILURES \(0\)\n  none/.test(ST.reportText(ST.summarize([], []))));
    }

    // ---- the rendered report ------------------------------------------------
    {
      const host = document.createElement('div');
      document.body.appendChild(host);
      ST.render(host, sum);
      ok('the report renders a headline', /1 of 2/.test(host.querySelector('.st-headline').textContent),
         host.querySelector('.st-headline').textContent);
      ok('one table row per encoding, plus the header',
         host.querySelectorAll('.st-table tbody tr').length === 4 + 2,   // encodings + suites
         String(host.querySelectorAll('.st-table tbody tr').length));
      ok('the failing encoding is marked in the table', !!host.querySelector('.st-fail'));
      ok('and the failing assertion is named where a reader will look',
         /sp-rgb: colours match/.test(host.textContent));
      ok('the refused encoding is not dressed up as a failure',
         /Correctly refused/.test(host.textContent));
      ok('there is a copy button', !!host.querySelector('#stCopy'));
      ok('and somewhere to send it', !!host.querySelector('a[href*="github.com"]'));
      host.remove();
    }

    // ---- the list of suites -------------------------------------------------
    {
      const listed = ST.suites;
      ok('the self-test knows about some suites', listed.length >= 10, String(listed.length));
      ok('and not about itself, which would run forever', !listed.includes('selftest'));
      ok('no suite is listed twice', new Set(listed).size === listed.length);

      const present = await Promise.all(listed.map(n =>
        fetch('tests/suites/' + n + '.js', { method: 'GET' }).then(r => r.ok).catch(() => false)));
      ok('every suite it lists exists', present.every(Boolean),
         listed.filter((_, i) => !present[i]).join(', '));

      // run.sh globs the directory and this list cannot, so they drift silently.
      // A plain HTTP file server answers a directory request with an index; a
      // static host does not, so the check only runs where it can.
      let index = '';
      try { const r = await fetch('tests/suites/'); if (r.ok) index = await r.text(); } catch (_) { /* static host */ }
      const onDisk = [...index.matchAll(/href="([\w-]+)\.js"/g)].map(m => m[1]).filter(n => n !== 'selftest');
      if (onDisk.length) {
        const absent = onDisk.filter(n => !listed.includes(n));
        ok('and it lists every suite in the directory', absent.length === 0, absent.join(', '));
      } else {
        ok('and it lists every suite in the directory', true, 'no directory index served here');
      }
    }

    // ---- a deployment with tests/ pruned ------------------------------------
    // The app depends on files under tests/ for this and for the sample buttons.
    // Somebody will eventually ship without them, and the failure has to be a
    // sentence rather than an overlay that never fills in.
    {
      const wasFlagged = window.SELFTEST;
      const nothing = await ST.run(['no-such-suite-at-all']);
      ok('a suite file that will not load stops the run', nothing === null, JSON.stringify(nothing));
      ok('and the overlay says where the suites were expected to be',
         /tests\//.test($('stStatus').textContent), $('stStatus').textContent.slice(0, 90));
      window.SELFTEST = wasFlagged;
    }

    // ---- and it really can drive one -----------------------------------------
    // Everything above is arithmetic on made-up input. This is the one assertion
    // that proves the harness loads a suite file into the live page, runs the
    // function it registered, and gets real lines back. boot is the cheapest one
    // there is and touches no app state.
    {
      const wasFlagged = window.SELFTEST;
      const real = await ST.run(['boot']);
      ok('a real suite runs through the harness', !!real && real.assertions > 0,
         real ? String(real.assertions) : 'nothing came back');
      ok('and every one of its assertions passed in this browser',
         !!real && real.failures.length === 0,
         real ? real.failures.map(f => f.name).join(' | ') : '');
      ok('the report is on screen afterwards',
         !$('selftest').classList.contains('hidden') && !$('stResult').classList.contains('hidden'));
      ok('the progress bar ran to the end', $('stBarFill').style.width === '100%', $('stBarFill').style.width);
      ok('and then got out of the way',
         $('stBar').classList.contains('hidden') && $('stStatus').classList.contains('hidden'));
      ok('so did the progress line', $('stStatus').textContent === '', $('stStatus').textContent);

      // Put the page back the way it was found: nothing after this expects an
      // overlay across it, and the flag would stop a later suite self-starting.
      $('selftest').classList.add('hidden');
      $('stBar').classList.remove('hidden');
      $('stStatus').classList.remove('hidden');
      $('stResult').replaceChildren();
      window.SELFTEST = wasFlagged;
    }

    // ---- i18n ---------------------------------------------------------------
    {
      const NEW_STRINGS = [
        'Browser self-test →', 'Browser self-test', 'Back to the editor',
        'The same conformance suites this project runs before a release, executed here, in your browser. Every test file is built in this page from a synthetic phantom, so what is being measured is whether this browser decodes each DICOM encoding correctly. Nothing is uploaded and nothing is downloaded.',
        'Loading the test suites…',
        'The test suites could not be loaded. They are served from tests/, which this deployment may have pruned.',
        'Running {n}…', 'Building the report…',
        'Your browser decoded {n} of {total} DICOM encodings correctly.',
        'Encodings that no browser can decode: {k} — every one of them was refused with an explanation, as it should be.',
        'Encodings that should have been refused but were not: {j} of {k}.',
        '{p} of {n} assertions passed, in {ms} ms.',
        'Transfer syntax support', 'Photometric interpretation', 'Test files', 'Result',
        'Not covered', '{n} assertion(s) failed', 'Correctly refused', 'Decoded correctly', '{n} decoded, {k} correctly refused',
        'Suites', 'Suite', 'Assertions', 'Failures', 'Copy report', 'Report a problem →',
        'Report copied to the clipboard.',
        'The self-test loads test files of its own. The study you have open, and any edits you have not exported, will be discarded.',
        'Run the self-test',
      ];
      for (const loc of ['es', 'pt-BR', 'ja', 'ru']) {
        const missing = NEW_STRINGS.filter(s => !I18N[loc] || !I18N[loc][s]);
        ok(`i18n: every new string is translated into ${loc}`, missing.length === 0,
           missing.join(' | ').slice(0, 160));
      }
      // A placeholder that survives translation into one locale and not another
      // is a report that reads "{n} of {total}" to a Spanish speaker.
      const holders = { 'Running {n}…': ['{n}'],
                        'Your browser decoded {n} of {total} DICOM encodings correctly.': ['{n}', '{total}'],
                        '{p} of {n} assertions passed, in {ms} ms.': ['{p}', '{n}', '{ms}'],
                        'Encodings that should have been refused but were not: {j} of {k}.': ['{j}', '{k}'] };
      const lost = [];
      for (const loc of ['es', 'pt-BR', 'ja', 'ru']) {
        for (const [key, ph] of Object.entries(holders)) {
          const v = I18N[loc] && I18N[loc][key];
          if (v && ph.some(p => !v.includes(p))) lost.push(`${loc}: ${key.slice(0, 24)}`);
        }
      }
      ok('i18n: every placeholder survives translation', lost.length === 0, lost.join(' | '));

      // The transfer syntax names are data, not chrome: leaving them English is
      // the fleet rule, and a translation of one would break every search for it.
      const translated = ['es', 'pt-BR', 'ja', 'ru'].filter(loc => I18N[loc] && I18N[loc]['RLE Lossless']);
      ok('i18n: transfer syntax names are left in English', translated.length === 0, translated.join(','));
    }
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
  pre.textContent = (await window.SUITES.selftest()).join('\n');
  document.body.appendChild(pre);
});
