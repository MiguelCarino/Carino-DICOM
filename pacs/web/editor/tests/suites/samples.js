// The demo study on the empty state.
//
// "Load a sample" is the first thing a visitor with no DICOM file can do, and
// the files behind it are forged by tests/dicom-forge.js — the same oracle the
// rest of this directory is built on. That is the whole reason the samples live
// there rather than in index.html: it means the front door can be held to the
// same standard as a test fixture instead of being a picture nobody checks.
//
// So this suite asks three things. Do the five files decode to the reference
// image the forge computed for them, on the real canvas, through the real drop
// path? Does each one carry a complete enough header that the Overview's own
// Conformance card comes back clean — because a demo that opens with three red
// errors is worse than no demo? And do the deep links that turn a gallery card
// into a URL actually reach the right file?
(window.SUITES || (window.SUITES = {})).samples = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const settle = async (cond, ms = 4000) => {
    for (let i = 0; i * 10 < ms; i++) { if (cond()) return true; await sleep(10); }
    return !!cond();
  };
  const $ = (id) => document.getElementById(id);
  const pixelsOf = (cv) => cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;

  try {
    const samples = Forge.samples();
    const byId = Object.fromEntries(samples.map(s => [s.id, s]));
    const IDS = ['ct', 'cr', 'us', 'cine', 'burn'];

    function parse(bytes) {
      const msg = DicomMessage.readFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      normBin(msg.dict);
      return { dict: msg.dict, meta: msg.meta || {} };
    }
    const str = (d, t) => { const e = lookupTag(d, t); return e ? elToString(e).trim() : ''; };

    // ---- the list itself ----------------------------------------------------
    ok('samples() returns the five the empty state offers',
       samples.length === 5 && IDS.every(id => byId[id]),
       samples.map(s => s.id).join(','));
    ok('every sample has its own file name',
       new Set(samples.map(s => s.file)).size === samples.length);
    ok('every sample carries a reference image', samples.every(s => s.ref));
    for (const s of samples) {
      const b = s.bytes;
      const magic = String.fromCharCode(b[128], b[129], b[130], b[131]);
      ok(`${s.id}: is a Part 10 file`, magic === 'DICM', magic);
    }

    // Built twice, byte for byte the same. The reference image is derived from
    // the raster, so a sample that varied between calls would be a picture with
    // no oracle behind it — and a #sample= link would stop reproducing.
    {
      const again = Forge.samples();
      let same = true, which = '';
      for (let i = 0; i < samples.length && same; i++) {
        const a = samples[i].bytes, c = again[i].bytes;
        if (a.length !== c.length) { same = false; which = samples[i].id + ' length'; break; }
        for (let k = 0; k < a.length; k++) if (a[k] !== c[k]) { same = false; which = `${samples[i].id} @${k}`; break; }
      }
      ok('samples() is deterministic', same, which);
    }

    // ---- one patient, one study, five series --------------------------------
    {
      const parsed = samples.map(s => parse(s.bytes));
      const studies = new Set(parsed.map(p => str(p.dict, '0020000d')));
      const series = new Set(parsed.map(p => str(p.dict, '0020000e')));
      ok('the five samples are one study', studies.size === 1, [...studies].join(','));
      ok('and five separate series', series.size === 5);
      ok('with series numbers 1..5',
         parsed.map(p => str(p.dict, '00200011')).sort().join(',') === '1,2,3,4,5');
      ok('and identity that is obviously synthetic',
         parsed.every(p => str(p.dict, '00100010') === 'Sample^Phantom' && str(p.dict, '00100020') === 'SAMPLE-001'));
    }

    // ---- what each one is for ------------------------------------------------
    {
      const ct = parse(byId.ct.bytes).dict;
      ok('ct: rescales to Hounsfield units',
         str(ct, '00281052') === '-1024' && str(ct, '00281053') === '1', str(ct, '00281052'));
      ok('ct: is windowed in those units', str(ct, '00281050') === '40' && str(ct, '00281051') === '400');
      ok('ct: is signed', str(ct, '00280103') === '1');

      const cr = parse(byId.cr.bytes).dict;
      ok('cr: is MONOCHROME1', str(cr, '00280004') === 'MONOCHROME1', str(cr, '00280004'));

      const us = parse(byId.us.bytes).dict;
      ok('us: is interleaved RGB',
         str(us, '00280004') === 'RGB' && str(us, '00280002') === '3' && str(us, '00280006') === '0');

      const cine = parse(byId.cine.bytes).dict;
      ok('cine: has sixteen frames', str(cine, '00280008') === '16', str(cine, '00280008'));
      ok('cine: states a display frame rate', str(cine, '00082144') === '30');

      const burn = parse(byId.burn.bytes).dict;
      ok('burn: declares burned-in annotation', str(burn, '00280301') === 'YES', str(burn, '00280301'));
    }

    // The banner is drawn in pure white; nothing else in the sector reaches 255,
    // so counting saturated pixels in the top band counts text and only text.
    {
      const b = byId.burn;
      const img = Forge.expected(b.ref, b.w, b.h);
      let white = 0;
      for (let y = 0; y < Math.round(b.h * 0.25); y++) {
        for (let x = 0; x < b.w; x++) {
          const o = (y * b.w + x) * 4;
          if (img[o] === 255 && img[o + 1] === 255 && img[o + 2] === 255) white++;
        }
      }
      ok('burn: there really is text in the pixels', white > 200, `${white} saturated px`);
    }

    // ---- through the real drop path onto the real canvas ---------------------
    const ovCanvas = $('ovCanvas');
    for (const s of samples) {
      let err = '';
      try {
        await handleFiles([new File([s.bytes], s.file, { type: 'application/dicom' })]);
        await settle(() => ovCanvas.width === s.w && ovCanvas.height === s.h);
      } catch (e) { err = (e && e.message) || String(e); }
      if (err || ovCanvas.width !== s.w) {
        ok(`${s.id}: renders in the Overview`, false, err || `canvas is ${ovCanvas.width}x${ovCanvas.height}`);
        continue;
      }
      const diff = Forge.compare(pixelsOf(ovCanvas), Forge.expected(s.ref, s.w, s.h), s.tol);
      ok(`${s.id}: ${s.title}`, !diff, diff || '');
    }

    // Every frame of the cine, not just the first: a sample whose play button
    // showed the same picture sixteen times would advertise nothing.
    {
      const c = byId.cine;
      await handleFiles([new File([c.bytes], c.file)]);
      await settle(() => ovCanvas.width === c.w);
      const slider = $('ovFrame');
      let bad = '';
      for (const f of [0, 5, 11, 15]) {
        slider.value = String(f);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        await settle(() => ovCanvas.width === c.w, 2000);
        await sleep(60);
        const diff = Forge.compare(pixelsOf(ovCanvas), Forge.expected(c.frameRef(f), c.w, c.h), c.tol);
        if (diff) { bad = `frame ${f}: ${diff}`; break; }
      }
      ok('cine: every frame shows its own picture', !bad, bad);
      ok('cine: plays at the rate the file asks for', window.ovCine.rate() === 30, String(window.ovCine.rate()));
    }

    // ---- the header is complete enough for the demo's own conformance card ---
    // This is what stops "Load a sample" opening with a wall of red. It is an
    // assertion about the samples, not about the validator: if SOP_ATTRS grows
    // a requirement, this is what says the samples have to grow with it.
    for (const s of samples) {
      const { dict: d, meta: m } = parse(s.bytes);
      const errors = validateDicom(d, m).filter(i => i.sev === 'error');
      ok(`${s.id}: no conformance errors`, !errors.length,
         errors.map(e => `${e.tag} ${e.msg}`).join(' | '));
    }
    for (const s of samples) {
      const { dict: d, meta: m } = parse(s.bytes);
      const warn = validateDicom(d, m).filter(i => i.sev === 'warning');
      ok(`${s.id}: no conformance warnings`, !warn.length,
         warn.map(e => `${e.tag} ${e.msg}`).join(' | '));
    }

    // ---- validateDicom looked up its tags in the wrong case ------------------
    // dcmjs keys datasets in UPPERCASE 8-hex; the validator asked for
    // d['x0020000d'] and d['0020000d']. Every tag whose hex contains a letter
    // A-F therefore came back "Missing", on every file the app has ever opened.
    {
      const { dict: d, meta: m } = parse(byId.ct.bytes);
      const issues = validateDicom(d, m);
      const missing = (tag) => issues.some(i => i.tag.toLowerCase() === tag && /Missing/i.test(i.msg));
      ok('Study Instance UID is not reported missing when it is present', !missing('0020000d'));
      ok('Series Instance UID is not reported missing when it is present', !missing('0020000e'));
      ok('Pixel Data is not reported missing when it is present', !missing('7fe00010'));
    }
    // …and the control that proves the fix did not simply blind it. A tag whose
    // hex has letters in it, genuinely removed from the parsed dataset.
    {
      const { dict: d, meta: m } = parse(byId.ct.bytes);
      for (const k of Object.keys(d)) if (k.toLowerCase() === '0020000e' || k.toLowerCase() === 'x0020000e') delete d[k];
      const issues = validateDicom(d, m);
      ok('a Series Instance UID that really is absent is still reported',
         issues.some(i => i.tag.toLowerCase() === '0020000e' && /Missing/i.test(i.msg)));
    }
    {
      // And a Type 2 the forge never writes, on a file with no sample header.
      const bare = Forge.build({
        rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 8, bs: 8, hb: 7, pr: 0,
        pixels: new Uint8Array(Forge.W * Forge.H),
      });
      const { dict: d, meta: m } = parse(bare);
      ok('a missing Type 2 attribute is still reported',
         validateDicom(d, m).some(i => i.tag.toLowerCase() === '00100030' && /Missing/i.test(i.msg)));
    }

    // ---- the buttons on the empty state --------------------------------------
    {
      const btns = [...document.querySelectorAll('.ov-sample-btn')];
      ok('the empty state offers one button per sample plus "all"',
         btns.length === 6 && btns.map(b => b.dataset.sample).join(',') === 'ct,cr,us,cine,burn,*',
         btns.map(b => b.dataset.sample).join(','));
      // A button nested inside #ovDrop would pop the OS file dialog on every
      // click, because #ovDrop is itself a click-to-browse target.
      ok('and none of them is inside the drop zone',
         btns.every(b => !$('ovDrop').contains(b)));
      ok('the gallery is linked from the empty state',
         !!document.querySelector('.ov-samples-note a[href$="gallery.html"]'));
      ok('and from the Info dropdown',
         !!document.querySelector('#diagBox a[href$="gallery.html"]'));
    }

    {
      files = [];
      const btn = document.querySelector('.ov-sample-btn[data-sample="us"]');
      btn.click();
      await settle(() => files.length === 1 && ovCanvas.width === byId.us.w);
      ok('clicking a sample button loads that sample',
         files.length === 1 && files[0].name === byId.us.file, files.map(f => f.name).join(','));
      ok('and the empty state gives way to the study',
         $('ovEmpty').classList.contains('hidden') && !$('ovContent').classList.contains('hidden'));
    }

    {
      files = [];
      document.querySelector('.ov-sample-btn[data-sample="*"]').click();
      await settle(() => files.length === 5, 8000);
      ok('"load all" loads the whole study', files.length === 5, String(files.length));
      // sortFiles() orders by Series Number, so the study arrives in the order
      // the buttons are listed in rather than the order the promises resolved.
      ok('in series order', files.map(f => f.name).join(',') === samples.map(s => s.file).join(','),
         files.map(f => f.name).join(','));
    }

    // ---- the deep links ------------------------------------------------------
    // #case= and #sample= are what turn a gallery card into a URL somebody can
    // paste into a bug report. They run from the page's load listener, but the
    // work they do is these two exported helpers.
    {
      ok('the sample loader is reachable from the load listener', typeof window.__loadSample === 'function');
      ok('so is the forge loader', typeof window.__loadForge === 'function');

      files = [];
      await window.__loadSample('cr');
      await settle(() => files.length === 1);
      ok('#sample= reaches the named sample', files.length === 1 && files[0].name === byId.cr.file,
         files.map(f => f.name).join(','));

      files = [];
      const forge = await window.__loadForge();
      const c = (await forge.corpus()).find(x => x.id === 'rle-mono16');
      await handleFiles([new File([c.bytes], c.id + '.dcm')]);
      await settle(() => ovCanvas.width === c.w);
      const diff = Forge.compare(pixelsOf(ovCanvas), Forge.expected(c.ref, c.w, c.h), c.tol);
      ok('#case= reaches a corpus case and it still renders', !diff, diff || '');

      // Every card in tests/gallery.html builds its link from the case id, so an
      // id the URL pattern cannot express is a card with a dead button.
      const idRe = /^[\w.*-]+$/;
      const badIds = (await forge.corpus()).map(x => x.id).concat(samples.map(s => s.id))
                     .filter(id => !idRe.test(id));
      ok('every case id survives the deep-link pattern', !badIds.length, badIds.join(','));
    }

    // A sample the forge has never heard of has to surface as a toast, not as a
    // spinner that sits there forever. Same failure shape as the forge script
    // itself 404ing, which is the one way these buttons can break in the wild.
    {
      files = [];
      await window.__loadSample('not-a-sample');
      const t = [...document.querySelectorAll('.toast')].pop();
      ok('an unknown sample id is reported rather than swallowed',
         !!t && /sample/i.test(t.textContent), t ? t.textContent : '(no toast)');
      ok('and the loading overlay is taken back down',
         !$('loadOverlay').classList.contains('visible'), $('loadOverlay').className);
      ok('and the buttons are usable again',
         [...document.querySelectorAll('.ov-sample-btn')].every(b => !b.disabled));
    }

    // ---- the burned-in sample is redactable ----------------------------------
    // It exists to give the Redact tool something to do on first run, which it
    // cannot if its transfer syntax has no codec behind it.
    {
      const { meta: m } = parse(byId.burn.bytes);
      const sup = redactionSupport(m);
      ok('burn: the redaction tool can rewrite it', sup.ok && !sup.converts, JSON.stringify(sup));
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
  pre.textContent = (await window.SUITES.samples()).join('\n');
  document.body.appendChild(pre);
});
