// Where the library tags sit, and that the app still sees them.
//
// dcmjs, the de-identification profile and the tag dictionary are 1.4 MB of
// classic, parser-blocking script. In <head> they held the first paint for three
// seconds on a 5 Mbps cold load; below the markup they hold nothing, because
// nothing above them needs them. That is a property of *where the tags are*, and
// nothing else in this directory would notice if they moved back — every other
// suite loads the finished page and would pass just as happily on the slow one.
//
// So this suite asserts the arrangement itself, and the two ways of undoing it
// that look like tidying: putting them back in <head>, or adding `defer` to make
// them non-blocking there. `defer` would run all three *after* the app
// scripts (js/*.js), which destructure dcmjs.data at top level — the page would die on the
// first line of the app with a bare "dcmjs is not defined".
(window.SUITES || (window.SUITES = {})).boot = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);

  try {
    const LIBS = ['vendor/dcmjs.min.js', 'deid-profile.js', 'dicom-dictionary.js'];
    const all = [...document.querySelectorAll('script')];
    const bySrc = s => all.find(el => el.getAttribute('src') === s);
    // The app starts with js/dictionary.js, the first of the js/ files, which
    // opens the tag dictionary. The test runner injects its own <script src> tags
    // after the app, so "the last script" would be the wrong thing to look for.
    const app = bySrc('js/dictionary.js');

    ok('the app script is where it was', !!app);

    // ---- the libraries arrived, in a form the app can use --------------------
    ok('dcmjs loaded', typeof dcmjs === 'object' && !!dcmjs.data);
    ok('the de-identification profile loaded', !!window.DEID_PROFILE);
    ok('the tag dictionary loaded', !!window.DICOM_DICT);
    // This is the line that dies if the tags ever end up below the app script:
    // it is the top-level destructure of dcmjs.data, seen from outside.
    ok('the app destructured dcmjs at parse time',
       typeof DicomMessage === 'function' && typeof DicomDict === 'function');

    // ---- nothing in <head> blocks the paint ---------------------------------
    // Only scripts with a src count: the runner injects a tiny inline error probe
    // into <head>, and an inline script fetches nothing to wait for.
    const headBlocking = [...document.head.querySelectorAll('script[src]')]
      .filter(el => !el.defer && !el.async)
      .map(el => el.getAttribute('src'));
    ok('no parser-blocking script is left in <head>', headBlocking.length === 0, headBlocking.join(','));

    for (const src of LIBS) {
      const el = bySrc(src);
      ok(`${src} is on the page`, !!el);
      if (!el) continue;
      ok(`${src} is below the markup, not in <head>`,
         el.parentNode !== document.head &&
         !!(document.getElementById('fullscreenOverlay')
              .compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
      // defer/async here would reorder them behind the app script; type=module
      // defers implicitly and would do the same.
      ok(`${src} still runs synchronously`,
         !el.defer && !el.async && !el.type,
         [el.defer ? 'defer' : '', el.async ? 'async' : '', el.type].filter(Boolean).join(' '));
      ok(`${src} runs before the app script`,
         !!(el.compareDocumentPosition(app) & Node.DOCUMENT_POSITION_FOLLOWING));
    }

    // Order matters between them only in that the app reads all three; assert it
    // anyway, so a future library that depends on another cannot be reshuffled
    // without someone noticing.
    const order = all.filter(el => LIBS.includes(el.getAttribute('src'))).map(el => el.getAttribute('src'));
    ok('the three keep their original order', order.join(',') === LIBS.join(','), order.join(','));
  } catch (e) {
    ok('suite ran to completion', false, (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  }

  // ---- every string on the page reaches all four locales -------------------
  // Each feature's own suite lists the strings it added, which catches a new
  // string that was never translated. It cannot catch the other direction: a
  // string being rewritten, or a control being replaced by a different one, and
  // the old locale entries left behind while the new markup falls back silently
  // to English. Only the finished page knows what it is actually asking for, so
  // ask the page.
  try {
    const LOCALES = ['es', 'pt-BR', 'ja', 'ru'];
    const keys = new Set();
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const k = el.dataset.i18nKey || el.textContent.trim();
      if (k) keys.add(k);
    });
    ok('the page carries translatable markup at all', keys.size > 100, `${keys.size} keys`);
    for (const loc of LOCALES) {
      const missing = [...keys].filter(k => !I18N[loc] || I18N[loc][k] === undefined);
      ok(`every data-i18n string on the page is translated into ${loc}`, missing.length === 0,
         missing.join(' | ').slice(0, 200));
    }
    const attrMissing = [];
    for (const [id, attr, key] of ATTR_I18N) {
      if (!document.getElementById(id)) { attrMissing.push(`${id} (no such element)`); continue; }
      for (const loc of LOCALES) if (!I18N[loc] || I18N[loc][key] === undefined) attrMissing.push(`${key} @ ${loc}`);
    }
    ok('every ATTR_I18N entry names a real element and a translated string',
       attrMissing.length === 0, attrMissing.join(' | ').slice(0, 200));
    // A loose alarm rather than a real check, and it cannot be more than that:
    // a great many entries are reached from JS through t() at a call site the
    // DOM cannot show us, so an entry missing from the markup is not evidence it
    // is dead. What the number does catch is drift — a dictionary growing while
    // the page does not, which is what happens when controls are rewritten and
    // their old entries are left behind. It was 107 when this was written, 129
    // once the load-failure toasts arrived, 137 with the translated
    // Anonymize/Randomize confirms, 150 once every confirm and toast went
    // through t(), 157 with the Swap patients dialog's rows, warnings and toast,
    // 163 with Create's eye picker and its eye-photo and order messages, 169 with
    // Find burned-in text's progress and result lines, 179 with Create's
    // send-back-to-the-worklist label and outcomes, 194 with the review fixes' confirm
    // sentences, refusals and toasts (de-identification, deep links, export), 227 with the
    // compression line's verdicts, viewer warnings, decompress confirm and Compare's pixel verdict,
    // 245 with the point-transform, J2K-sign, JPIP/private-syntax and rendered-copy warnings,
    // 272 with the presentation-state menu, colour-series burn-in and the Overview cards' own text,
    // 309 with the validator's messages and format hints (shown translated in the Conformance card).
    const jsOwned = new Set(ATTR_I18N.map(([, , k]) => k));
    const unseen = Object.keys(I18N.es).filter(k => !keys.has(k) && !jsOwned.has(k));
    ok('the dictionaries have not drifted far ahead of the page',
       unseen.length < 330, `${unseen.length} keys reached from JS or no longer reached at all`);
  } catch (e) {
    ok('the i18n audit ran', false, (e && e.message) || String(e));
  }

  // ---- under ?lang=ja, a confirm is not asked in English ---------------------
  // An irreversible overwrite approved through an English body is the failure.
  // confirmDanger and toast run their text through t() themselves, so a caller
  // that hands them the English key still reaches the reader's language; the
  // count pills keep their count across the switch. CarinoLang.set stores the
  // choice, so put the visitor's back afterwards.
  const prevLang = CarinoLang.mode === 'manual' ? CarinoLang.current : 'auto';
  const pillWas = fileCountPill.dataset.i18nN;
  try {
    const LOCALES = ['es', 'pt-BR', 'ja', 'ru'];
    const JS_KEYS = ['Copy every differing value onto {name}? This overwrites its values.',
      'Copy every differing value from {name} onto this file? This overwrites its values.',
      '{host} wants to open {n} file(s) in this editor.', 'Loaded {n} image(s) from {from}',
      'Nothing from {from} could be read as DICOM', 'Tag {tag} added', 'Images: {n}', 'Files: {n}',
      'Copy →', 'Copy ←', 'Cleared the added files', 'Cleared all images', 'PACS hand-off failed:',
      'PACS deep-link failed:', 'No response from Carino DICOM'];
    for (const loc of LOCALES) {
      const bad = JS_KEYS.filter(k => !I18N[loc]?.[k] ||
        (k.match(/\{\w+\}/g) || []).some(p => I18N[loc][k].split(p).length !== 2));
      ok(`confirm/toast/pill keys reach ${loc} with each placeholder once`, bad.length === 0, bad.join(' | '));
    }

    CarinoLang.set('ja');
    const KEY = 'The self-test loads test files of its own. The study you have open, and any edits you have not exported, will be discarded.';
    confirmDanger(KEY, () => {}, 'Copy →');
    const msg = $('confirmMsg').textContent;
    ok('?lang=ja: #confirmMsg is not English', msg === I18N.ja[KEY] && !/[a-z]{4}/i.test(msg), msg.slice(0, 60));
    ok('?lang=ja: and neither is its OK button', $('confirmOk').textContent === I18N.ja['Copy →'], $('confirmOk').textContent);
    $('confirmCancel').click();
    toast('Cleared the added files');
    const toastText = document.querySelector('.toast')?.textContent;
    ok('?lang=ja: a toast given the English key is shown in Japanese', toastText === I18N.ja['Cleared the added files'], toastText);
    document.querySelector('.toast')?.remove();

    // fileCountPill, not Create's: a switch redraws Create's grid, which resets its pill to the real count.
    setCountPill(fileCountPill, 3);
    ok('?lang=ja: a count pill is Japanese', fileCountPill.textContent === I18N.ja['Files: {n}'].replace('{n}', 3),
       fileCountPill.textContent);
    CarinoLang.set('en');
    ok('and switching back keeps its count', fileCountPill.textContent === 'Files: 3', fileCountPill.textContent);
  } catch (e) {
    ok('the ?lang=ja confirm check ran', false, (e && e.message) || String(e));
  } finally {
    try { $('confirmCancel').click(); } catch (_) { /* already closed */ }
    CarinoLang.set(prevLang);
    if (pillWas !== undefined) setCountPill(fileCountPill, pillWas);
  }

  // ---- a switch with a file open redraws text built at render time ----------
  // i18n.js re-translates static markup only; the compression notes, the Overview cards and the
  // validator badges are built with T() when drawn, and stayed in the old language (reported on
  // an 8-bit MR whose rendered-picture warning stayed English under "COMPRESIÓN").
  try {
    CarinoLang.set('en');
    const n = Forge.W * Forge.H, px8 = new Uint8Array(n);
    for (let k = 0; k < n; k++) px8[k] = k & 0xFF;
    const mr8 = Forge.build({ rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 8, bs: 8, hb: 7, pr: 0,
      modality: 'MR', sopClass: '1.2.840.10008.5.1.4.1.1.4', pixels: px8 });
    await handleFiles([new File([mr8], 'mr8.dcm')]);
    renderOverview();
    const KEY = 'A {m} image with only {b}-bit pixels: this looks like a rendered picture (a screenshot or JPEG export with the contrast already applied), not the measured values. Nothing can convert it back; ask for the original DICOM.';
    const fill = (s) => s.replace('{m}', 'MR').replace('{b}', '8');
    const warn = () => $('imgCompNotes').querySelector('li.warn')?.textContent || '';
    ok('switch: the 8-bit MR warning is English before the switch', warn() === fill(KEY), warn().slice(0, 60));
    CarinoLang.set('es');
    ok('switch: the compression notes follow the language', warn() === fill(I18N.es[KEY]), warn().slice(0, 60));
    const head = (k) => I18N.es[k].split('{n}')[0];
    const badges = $('ovValSummary').textContent;
    ok('switch: the validator badges follow it', badges.includes(head('Errors: {n}')) && badges.includes(head('Warnings: {n}')), badges);
    ok('switch: and the Overview cards', $('ovTech').textContent.includes(I18N.es['Compression']), $('ovTech').textContent.slice(0, 80));
    const card = $('ovValIssues').textContent;
    ok('switch: and the validator messages', card.includes(I18N.es['Missing — Type 1 required for {iod}'].split('{iod}')[0]), card.slice(0, 80));

    // Every validator message, read from its source: plain push() texts, vMsg() templates and the
    // VR format hints, in each locale with each placeholder once.
    const src = await (await fetch('js/validator.js')).text();
    const unq = (s) => s.replace(/\\(['\\])/g, '$1');
    const vkeys = new Set([
      ...[...src.matchAll(/vMsg\('((?:\\.|[^'\\])*)'/g)].map(m => unq(m[1])),
      ...[...src.matchAll(/push\(\s*'\w+'\s*,\s*[^,'"`]+,\s*'((?:\\.|[^'\\])*)'/g)].map(m => unq(m[1])),
      ...[...src.matchAll(/push\('\w+',\s*'\w+',\s*'((?:\\.|[^'\\])*)'/g)].map(m => unq(m[1])),
      ...Object.values(VR_RULES).map(r => r.hint).filter(h => h && /\s/.test(h)),   // prose; a bare pattern stays as is
    ]);
    ok('validator messages: the source scan found them', vkeys.size >= 30, String(vkeys.size));
    for (const loc of ['es', 'pt-BR', 'ja', 'ru']) {
      const bad = [...vkeys].filter(k => !I18N[loc]?.[k] ||
        (k.match(/\{\w+\}/g) || []).some(p => I18N[loc][k].split(p).length !== 2));
      ok(`validator messages reach ${loc} with each placeholder once`, !bad.length, bad.join(' | ').slice(0, 200));
    }
  } catch (e) {
    ok('the language-switch redraw check ran', false, (e && e.message) || String(e));
  } finally {
    CarinoLang.set(prevLang);
  }

  return out;
};

// Two callers: tests/run.sh injects this file alone and scrapes the <pre> below;
// index.html#selftest sets window.SELFTEST and awaits the returned lines instead.
if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.boot()).join('\n');
  document.body.appendChild(pre);
});
