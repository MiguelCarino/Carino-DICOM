// What ends up on screen.
//
// tests/suites/pixels.js proves the decoder can recover the numbers. This suite
// asks the harder question: after windowing, rescaling and photometric
// interpretation have all had their turn, does the canvas hold the picture the
// file describes? It drives the two surfaces a user actually looks at — the
// Overview viewer and the editor's preview thumbnail — and compares each canvas
// against Forge's oracle.
//
// The two are checked separately on purpose. They are different code paths, and
// a case that passes in one and fails in the other is exactly the kind of bug
// that gets reported as "the image looks wrong sometimes".
(window.SUITES || (window.SUITES = {})).viewer = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  try {
    const cases = await Forge.corpus();

    function parse(c) {
      const b = c.bytes;
      const msg = DicomMessage.readFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      normBin(msg.dict);
      return { dict: msg.dict, meta: msg.meta || {} };
    }

    // Put a forged file into the app exactly where loadFiles() would have left it.
    function install(c) {
      const p = parse(c);
      files = [{ name: c.id + '.dcm', dict: p.dict, meta: p.meta, file: null,
                 size: c.bytes.length, sha: null, shaState: 'idle' }];
      currentFileIdx = 0;
      dict = p.dict;
      meta = p.meta;
      pendingEdits.clear();
      // Blank both canvases. Every case here is the same size, so a stale
      // picture from the previous one would satisfy settle() instantly and get
      // compared as if it were this case's — the tests would look like they
      // were one file behind.
      for (const el of [document.getElementById('ovCanvas'), document.getElementById('preview')]) {
        if (el) { el.width = 1; el.height = 1; }
      }
      return p;
    }

    // loadImage() is fired and forgotten by renderOverview, and the JPEG cases
    // wait on createImageBitmap, so poll rather than guess a delay.
    async function settle(canvas, w, h, ms = 4000) {
      const until = ms / 25;
      for (let i = 0; i < until; i++) {
        if (canvas.width === w && canvas.height === h) return true;
        await sleep(25);
      }
      return canvas.width === w && canvas.height === h;
    }

    const pixelsOf = (canvas) =>
      canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;

    const ovCanvas = document.getElementById('ovCanvas');
    const ovNoImg = document.getElementById('ovNoImg');

    // ---- the Overview viewer ------------------------------------------------
    for (const c of cases) {
      if (c.broken || !c.ref) continue;
      let err = '';
      try {
        install(c);
        renderOverview();
        await settle(ovCanvas, c.w, c.h);
      } catch (e) { err = (e && e.message) || String(e); }

      if (err) { ok(`overview ${c.id}: renders`, false, err); continue; }

      if (ovCanvas.width !== c.w || ovCanvas.height !== c.h) {
        const why = ovNoImg && !ovNoImg.classList.contains('hidden')
          ? ovNoImg.textContent.trim() : `canvas is ${ovCanvas.width}x${ovCanvas.height}`;
        ok(`overview ${c.id}: renders`, false, why);
        continue;
      }
      const diff = Forge.compare(pixelsOf(ovCanvas), Forge.expected(c.ref, c.w, c.h), c.tol);
      ok(`overview ${c.id}: ${c.title}`, !diff, diff || '');
    }

    // ---- the editor's preview thumbnail --------------------------------------
    const preview = document.getElementById('preview');
    for (const c of cases) {
      if (c.broken || !c.ref) continue;
      let err = '';
      try {
        install(c);
        await drawPreview(dict, 0);
      } catch (e) { err = (e && e.message) || String(e); }

      if (err) { ok(`preview ${c.id}: renders`, false, err); continue; }
      if (preview.width !== c.w || preview.height !== c.h) {
        ok(`preview ${c.id}: renders`, false, `canvas is ${preview.width}x${preview.height}`);
        continue;
      }
      const diff = Forge.compare(pixelsOf(preview), Forge.expected(c.ref, c.w, c.h), c.tol);
      ok(`preview ${c.id}: ${c.title}`, !diff, diff || '');
    }

    // ---- the two surfaces should agree with each other -----------------------
    // Independent of who is right: a file cannot legitimately look like two
    // different images in two panels of the same page.
    for (const c of cases) {
      if (c.broken || !c.ref) continue;
      let a = null, b = null, err = '';
      try {
        install(c);
        renderOverview();
        await settle(ovCanvas, c.w, c.h);
        if (ovCanvas.width === c.w) a = pixelsOf(ovCanvas).slice();
        install(c);
        await drawPreview(dict, 0);
        if (preview.width === c.w) b = pixelsOf(preview).slice();
      } catch (e) { err = (e && e.message) || String(e); }
      if (err || !a || !b) { ok(`${c.id}: overview and preview agree`, false, err || 'one of them drew nothing'); continue; }
      const diff = Forge.compare(a, b, Math.max(2, c.tol || 0));
      ok(`${c.id}: overview and preview agree`, !diff, diff || '');
    }

    // ---- multi-frame navigation on screen ------------------------------------
    for (const id of ['multiframe-mono', 'multiframe-rgb', 'jpeg-multiframe']) {
      const c = cases.find(x => x.id === id);
      const shots = [];
      let err = '';
      try {
        for (let f = 0; f < c.frames; f++) {
          install(c);
          await drawPreview(dict, f);
          shots.push(preview.width === c.w ? pixelsOf(preview).slice() : null);
        }
      } catch (e) { err = (e && e.message) || String(e); }
      if (err || shots.some(s => !s)) { ok(`preview ${id}: every frame draws`, false, err || 'a frame drew nothing'); continue; }
      ok(`preview ${id}: every frame draws`, true);
      for (let f = 0; f < c.frames; f++) {
        const diff = Forge.compare(shots[f], Forge.expected(c.frameRef(f), c.w, c.h), c.tol);
        ok(`preview ${id}: frame ${f} shows frame ${f}`, !diff, diff || '');
      }
    }

    // ---- files the viewer cannot show must say so ----------------------------
    for (const c of cases.filter(x => x.broken)) {
      let err = '';
      try {
        install(c);
        renderOverview();
        await sleep(300);
      } catch (e) { err = (e && e.message) || String(e); }
      ok(`overview ${c.id}: survives a malformed file`, !err, err);
      if (c.expectError) {
        const shown = ovNoImg && !ovNoImg.classList.contains('hidden') ? ovNoImg.textContent.trim() : '';
        ok(`overview ${c.id}: explains itself to the user`, c.expectError.test(shown), shown || '(nothing shown)');
      }
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
  pre.textContent = (await window.SUITES.viewer()).join('\n');
  document.body.appendChild(pre);
});
