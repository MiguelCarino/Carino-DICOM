// The page at phone width (390x844), in a same-origin iframe of that size, since run.sh's window
// is 1280x720 and #selftest's is whatever the visitor has. Oracle: the frame's own geometry.
// `html, body { overflow: hidden }` means anything past the right edge cannot be scrolled to, so
// "reachable" is "laid out inside the viewport" (and inside any clipping ancestor), not "exists".
(window.SUITES || (window.SUITES = {})).phone = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const frames = [];
  // ?lang= is stored in this origin's localStorage, which the visitor's own page shares.
  let prevLang = null;
  try { prevLang = localStorage.getItem('carino_lang'); } catch (_) { /* private mode */ }

  const open = async (W, H, lang) => {
    const frame = document.createElement('iframe');
    frame.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px;border:0;visibility:hidden`;
    frames.push(frame);
    await new Promise((res, rej) => {
      frame.onload = res; frame.onerror = rej;
      frame.src = `index.html${lang ? '?lang=' + lang : ''}#sample=ct`;
      document.body.appendChild(frame);
    });
    const win = frame.contentWindow;
    // `files` is a top-level let: a global binding, but not a property of the window.
    const loaded = () => win.eval('typeof files !== "undefined" && files.length > 0');
    for (let i = 0; i < 200 && !loaded(); i++) await new Promise(r => setTimeout(r, 50));
    return { win, doc: frame.contentDocument, loaded: loaded() };
  };

  // Inside the viewport and inside every ancestor that clips (the tab strip scrolls sideways).
  const reach = ({ win, doc }, el) => {
    if (!el) return 'missing';
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return 'not displayed';
    if (r.left < -0.5 || r.right > win.innerWidth + 0.5) return `x ${Math.round(r.left)}..${Math.round(r.right)}`;
    for (let p = el.parentElement; p && p !== doc.body; p = p.parentElement) {
      if (win.getComputedStyle(p).overflowX === 'visible') continue;
      const q = p.getBoundingClientRect();
      if (r.left < q.left - 0.5 || r.right > q.right + 0.5) return `clipped by .${p.className.split(' ')[0]}`;
    }
    return '';
  };

  try {
    const f = await open(390, 844);
    const $ = id => f.doc.getElementById(id);
    ok('phone: the CT sample loaded in the 390px frame', f.loaded);

    for (const [tab, btn] of [['overview', 'overviewTabBtn'], ['editor', 'editorTabBtn'],
                              ['extractor', 'extractorTabBtn'], ['create', 'createTabBtn']]) {
      $(btn).click();
      await new Promise(r => setTimeout(r, 30));
      const app = f.doc.querySelector('.app');
      ok(`phone: ${tab}: .app is no wider than the screen`, app.scrollWidth <= f.win.innerWidth, `${app.scrollWidth} > ${f.win.innerWidth}`);
      for (const id of ['createTabBtn', 'diagToggle']) {
        const why = reach(f, $(id));
        ok(`phone: ${tab}: #${id} is on screen`, !why, why);
      }
      if (tab === 'editor') for (const id of ['downloadOneBtn', 'searchInput']) {
        const why = reach(f, $(id));
        ok(`phone: ${tab}: #${id} is on screen`, !why, why);
      }
    }

    // Edit, stacked: Value is the only editable column, and the tag table scrolls sideways, so an
    // input past the wrap's edge is reachable only by a scroll nobody expects on a phone.
    const editNarrow = async (g, W, lang) => {
      const $g = id => g.doc.getElementById(id);
      $g('editorTabBtn').click();
      g.win.eval('revealImgEditCard()');
      await new Promise(r => setTimeout(r, 30));
      const inputs = [...g.doc.querySelectorAll('#tagBody .val-input')].filter(el => el.getBoundingClientRect().width);
      const tag = lang ? `${W}px ${lang}` : `${W}px`;
      if (W >= 360) {
        const bad = inputs.map(el => [el.dataset.tag, reach(g, el)]).filter(([, why]) => why);
        ok(`phone: ${tag} edit: every tag value input is on screen (${inputs.length})`, inputs.length && !bad.length,
           bad.slice(0, 3).map(([t, why]) => `${t} ${why}`).join('; ') || 'no inputs');
        // Description breaks anywhere; ja's short header once let it shrink to a letter per line.
        const narrow = Math.min(...[...g.doc.querySelectorAll('#tagBody .desc-cell')].map(el => el.parentElement.getBoundingClientRect().width || Infinity));
        ok(`phone: ${tag} edit: the Description column keeps at least 78px`, narrow >= 77.5, `${Math.round(narrow)}px`);
      } else {
        // Four columns at 320 would leave Value a sliver; the scroll it keeps has to lead somewhere readable.
        const thin = inputs.filter(el => el.getBoundingClientRect().width < 80);
        ok(`phone: ${tag} edit: every tag value input is at least 80px wide (${inputs.length})`, inputs.length && !thin.length,
           thin.slice(0, 3).map(el => `${el.dataset.tag} ${Math.round(el.getBoundingClientRect().width)}px`).join('; ') || 'no inputs');
      }
      if (lang) return;
      for (const id of ['imgRedact', 'folderBtn', 'filesBtn', 'applyPrefixBtn']) {
        const why = reach(g, $g(id));
        ok(`phone: ${tag} edit: #${id} is on screen`, !why, why);
      }
    };
    await editNarrow(f, 390);
    // Compare's two value columns and copy arrows would be crushed to nothing, so they keep the floor.
    $('cmpHeadB').classList.remove('hidden');
    const cmpW = f.doc.querySelector('#tableWrap table').getBoundingClientRect().width;
    $('cmpHeadB').classList.add('hidden');
    ok('phone: compare keeps the 640px table and scrolls sideways', cmpW >= 639.5, `${Math.round(cmpW)}px`);
    // ru's VALUE header is the widest minimum of any locale, ja's Description header the narrowest.
    for (const [W, lang] of [[360], [360, 'ru'], [390, 'ja'], [320]]) {
      const g = await open(W, 700, lang);
      if (g.loaded) await editNarrow(g, W, lang);
      else ok(`phone: ${W}px ${lang || ''} edit: sample loaded`, false);
    }

    // The tabs get their own full-width row under brand and controls.
    const nav = f.doc.querySelector('.tab-nav').getBoundingClientRect();
    const right = f.doc.querySelector('.header-right').getBoundingClientRect();
    ok('phone: the tab strip sits on its own row below the header controls', nav.top >= right.bottom - 0.5,
       `${Math.round(nav.top)} < ${Math.round(right.bottom)}`);

    // ru has the longest tab labels. 660 is in the old 641-700 band where the one-row strip clipped
    // Create, 701 is one row again, 320 is the narrowest tab row.
    for (const W of [320, 660, 701]) {
      const g = await open(W, 700, 'ru');
      const why = g.loaded ? reach(g, g.doc.getElementById('createTabBtn')) : 'sample did not load';
      ok(`phone: ${W}px ru: #createTabBtn is not clipped by the tab strip`, !why, why);
    }
  } catch (e) {
    ok('suite ran to completion', false, (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  } finally {
    for (const frame of frames) frame.remove();
    try {
      if (prevLang === null) localStorage.removeItem('carino_lang');
      else localStorage.setItem('carino_lang', prevLang);
    } catch (_) { /* private mode */ }
  }

  return out;
};

// Two callers: tests/run.sh injects this file alone and scrapes the <pre> below;
// index.html#selftest sets window.SELFTEST and awaits the returned lines instead.
if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.phone()).join('\n');
  document.body.appendChild(pre);
});
