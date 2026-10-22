// Presentation states in the Overview viewer, and the study checks that explain "one series shows
// in one viewer and another in the next".
//
// The case behind it: a Siemens perfusion series stored as one Enhanced MR object plus a
// Pseudo-Color Presentation State holding the colour map, which a CD export had turned into two
// series (16 grey legacy MR images and 16 RGB Secondary Captures) under one Series Number.
//
// Oracle: every expected pixel is worked out here from the forged sample values, window and
// palette (PS3.3 C.11.2.1.2 linear window, the window's output spread over the palette's
// entries), never read back from the app.
(window.SUITES || (window.SUITES = {})).presentation = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const settle = async (cond, ms = 3000) => {
    for (let i = 0; i * 10 < ms; i++) { if (cond()) return true; await sleep(10); }
    return !!cond();
  };
  const $ = (id) => document.getElementById(id);
  const T = window.t || String;

  try {
    const STUDY = '1.2.826.0.1.3680043.10.99999.31.1';
    const MR_SERIES = STUDY + '.2', MR_SOP = STUDY + '.2.1';
    const W = Forge.W, H = Forge.H, N = W * H;
    // Two frames: frame 1 ramps 0..N-1, frame 2 the same ramp backwards.
    const px = new Uint16Array(N * 2);
    for (let k = 0; k < N; k++) { px[k] = k; px[N + k] = N - 1 - k; }

    const mr = Forge.build({
      rows: H, cols: W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0, frames: 2,
      modality: 'MR', sopClass: '1.2.840.10008.5.1.4.1.1.4.1',
      studyUID: STUDY, seriesUID: MR_SERIES, sopInstance: MR_SOP, pixels: px,
      extra: { '00200011': { vr: 'IS', v: ['5047'] }, '0008103e': { vr: 'LO', v: ['TESTPERFU'] } },
    });

    // A 256-entry, 16-bit palette: red rises, green holds, blue falls.
    const lut = (f) => { const a = new Uint16Array(256); for (let i = 0; i < 256; i++) a[i] = f(i) << 8; return a; };
    const voi = (frame, wc, ww) => ({
      '00081140': { vr: 'SQ', items: [{
        '00081150': { vr: 'UI', v: ['1.2.840.10008.5.1.4.1.1.4.1'] },
        '00081155': { vr: 'UI', v: [MR_SOP] },
        '00081160': { vr: 'IS', v: [String(frame)] } }] },
      '00281050': { vr: 'DS', v: [String(wc)] },
      '00281051': { vr: 'DS', v: [String(ww)] },
    });
    const refSeries = { vr: 'SQ', items: [{
      '0020000e': { vr: 'UI', v: [MR_SERIES] },
      '00081140': { vr: 'SQ', items: [{
        '00081150': { vr: 'UI', v: ['1.2.840.10008.5.1.4.1.1.4.1'] },
        '00081155': { vr: 'UI', v: [MR_SOP] },
        '00081160': { vr: 'IS', v: ['1', '2'] } }] } }] };
    const WIN = { 1: [512, 1024], 2: [300, 400] };
    const prBase = (cls, sop, num, extra) => Forge.build({
      noImage: true, sopClass: cls, modality: 'PR', studyUID: STUDY,
      seriesUID: `${STUDY}.${num}`, sopInstance: sop,
      extra: Object.assign({
        '00200011': { vr: 'IS', v: [String(num)] }, '0008103e': { vr: 'LO', v: ['TESTPERFU'] },
        '00081115': refSeries,
        '00283110': { vr: 'SQ', items: [voi(1, ...WIN[1]), voi(2, ...WIN[2])] },
      }, extra) });
    const pseudo = prBase('1.2.840.10008.5.1.4.1.1.11.3', STUDY + '.9.1', 5049, {
      '00281101': { vr: 'US', v: [256, 0, 16] }, '00281102': { vr: 'US', v: [256, 0, 16] }, '00281103': { vr: 'US', v: [256, 0, 16] },
      '00281201': { vr: 'OW', v: lut(i => i) }, '00281202': { vr: 'OW', v: lut(() => 128) }, '00281203': { vr: 'OW', v: lut(i => 255 - i) },
    });
    const gray = prBase('1.2.840.10008.5.1.4.1.1.11.1', STUDY + '.8.1', 5048, { '20500020': { vr: 'CS', v: ['INVERSE'] } });
    const color = prBase('1.2.840.10008.5.1.4.1.1.11.2', STUDY + '.7.1', 5050, {});

    await handleFiles([['mr.dcm', mr], ['pr-pseudo.dcm', pseudo], ['pr-gray.dcm', gray], ['pr-color.dcm', color]]
      .map(([n, b]) => new File([b], n)));
    ok('the image and its three presentation states load', files.length === 4, String(files.length));
    const at = (sop) => files.findIndex(f => String(lookupTag(f.dict, '00080018')?.Value?.[0]).trim() === sop);
    switchTab('overview');
    if (currentFileIdx !== at(MR_SOP)) switchFile(at(MR_SOP));
    renderOverview();
    const canvas = $('ovCanvas'), sel = $('ovPres');
    await settle(() => canvas.width === W);

    // ---- the picker ---------------------------------------------------------
    const opts = [...sel.options];
    ok('the presentation menu shows for an image that loaded PRs refer to', !sel.classList.contains('hidden'));
    ok('it offers the image as stored plus each PR', opts.length === 4, opts.map(o => o.textContent).join(' | '));
    ok('and starts on the image as stored', sel.value === '-1' && opts[0].textContent === T('Image as stored'));
    const colorOpt = opts.find(o => +o.value === at(STUDY + '.7.1'));
    ok('a colour PR is listed but cannot be chosen', colorOpt && colorOpt.disabled, colorOpt?.textContent);

    const pixels = () => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const stored = pixels();
    let grey = true;
    for (let i = 0; i < N * 4; i += 4) if (stored[i] !== stored[i + 1] || stored[i] !== stored[i + 2]) { grey = false; break; }
    ok('as stored, the image is grey', grey);

    const choose = async (sop) => {
      sel.value = String(at(sop));
      sel.dispatchEvent(new Event('change'));
      await sleep(200);
    };
    // Expected display value t (0..1) for sample v under this frame's PR window.
    const t = (v, [wc, ww]) => {
      const lo = wc - 0.5 - (ww - 1) / 2, hi = wc - 0.5 + (ww - 1) / 2;
      return v <= lo ? 0 : v >= hi ? 1 : (v - lo) / (hi - lo);
    };
    const worst = (want) => {
      const got = pixels();
      let bad = 0, first = '';
      for (let k = 0; k < N; k++) {
        const w = want(k), q = k * 4;
        for (let c = 0; c < 3; c++) if (Math.abs(got[q + c] - w[c]) > 1) { if (!bad++) first = `px ${k}: got ${got[q]},${got[q+1]},${got[q+2]} want ${w}`; break; }
      }
      return { bad, first };
    };

    // ---- pseudo-colour ------------------------------------------------------
    await choose(STUDY + '.9.1');
    {
      const r = worst(k => { const i = Math.round(t(px[k], WIN[1]) * 255); return [i, 128, 255 - i]; });
      ok('pseudo-colour PR: frame 1 is windowed by its own VOI item and coloured by its palette', !r.bad, r.bad ? `${r.bad} px; ${r.first}` : '');
      ok('pseudo-colour PR: the window sliders show the PR window', +$('ovWCval').textContent === WIN[1][0] && +$('ovWWval').textContent === WIN[1][1],
         `${$('ovWCval').textContent}/${$('ovWWval').textContent}`);
      ok('pseudo-colour PR: the colormap menu is off while a PR draws the colour', $('ovColormap').disabled);
    }
    ovStackStep(1);
    await settle(() => +$('ovWCval').textContent === WIN[2][0]);
    {
      const r = worst(k => { const i = Math.round(t(px[N + k], WIN[2]) * 255); return [i, 128, 255 - i]; });
      ok('pseudo-colour PR: frame 2 takes frame 2\'s window', !r.bad, r.bad ? `${r.bad} px; ${r.first}` : '');
    }

    // ---- grayscale with INVERSE ---------------------------------------------
    ovStackStep(-1);
    await choose(STUDY + '.8.1');
    await settle(() => +$('ovWCval').textContent === WIN[1][0]);
    {
      const r = worst(k => { const g = 255 - Math.round(t(px[k], WIN[1]) * 255); return [g, g, g]; });
      ok('grayscale PR: its window and INVERSE Presentation LUT Shape are applied', !r.bad, r.bad ? `${r.bad} px; ${r.first}` : '');
    }

    // ---- back to the file ---------------------------------------------------
    await choose('-1');
    {
      const got = pixels();
      let same = true;
      for (let i = 0; i < got.length; i++) if (got[i] !== stored[i]) { same = false; break; }
      ok('choosing the image as stored draws exactly what it drew before', same);
      ok('and gives the colormap back', !$('ovColormap').disabled);
    }

    // ---- a PR file itself ---------------------------------------------------
    switchFile(at(STUDY + '.9.1'));
    renderOverview();
    ok('a PR file shows no presentation menu of its own', sel.classList.contains('hidden'));

    // ---- validator ----------------------------------------------------------
    const parse = (b) => { const m = DicomMessage.readFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); normBin(m.dict); return m; };
    const study = (...bs) => bs.map((b, i) => ({ dict: parse(b).dict, name: `f${i}.dcm` }));
    const has = (issues, sev, tag, re) => issues.some(i => i.sev === sev && i.tag.toLowerCase() === tag && re.test(i.msg));

    {
      const m = parse(mr), s = study(mr, pseudo, gray, color);
      const iss = validateDicom(m.dict, m.meta, s);
      ok('validator: an image says which loaded PR refers to it', has(iss, 'info', '00080018', /PR 5049 · TESTPERFU.*pseudo-color/));
      ok('validator: and that a colour PR cannot be applied here', has(iss, 'info', '00080018', /color\).*cannot apply/));
      const p = parse(pseudo);
      ok('validator: a PR whose image is loaded says so', has(validateDicom(p.dict, p.meta, s), 'info', '00081115', /1 loaded image/));
      ok('validator: a PR whose image is missing warns', has(validateDicom(p.dict, p.meta, study(pseudo)), 'warning', '00081115', /1 of them are not among the loaded/));
      ok('validator: without the study, none of the cross-file checks run',
         !validateDicom(m.dict, m.meta).some(i => ['00080018', '00081115', '00200011'].includes(i.tag.toLowerCase())));
    }

    // The CD's two copies: one Series Number, two Series Instance UIDs, both converted.
    const cdCopy = (n, extra) => Forge.build({
      rows: H, cols: W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0, modality: 'MR',
      studyUID: STUDY, seriesUID: `${STUDY}.${n}`, sopInstance: `${STUDY}.${n}.1`, pixels: px.subarray(0, N),
      extra: Object.assign({
        '00200011': { vr: 'IS', v: ['5047001'] }, '0008103e': { vr: 'LO', v: ['TESTPERFU'] },
        '00209172': { vr: 'SQ', items: [{
          '00081150': { vr: 'UI', v: ['1.2.840.10008.5.1.4.1.1.4.1'] },
          '00081155': { vr: 'UI', v: [MR_SOP] },
          '00081160': { vr: 'IS', v: ['1'] } }] },
      }, extra) });
    const grayCopy = cdCopy(20, {
      '00281101': { vr: 'US', v: [256, 0, 16] }, '00281201': { vr: 'OW', v: lut(i => i) } });
    const otherCopy = cdCopy(21, {});
    {
      const m = parse(grayCopy), s = study(grayCopy, otherCopy);
      const iss = validateDicom(m.dict, m.meta, s);
      ok('validator: two series under one Series Number warn', has(iss, 'warning', '00200011', /5047001 is also used by another series.*TESTPERFU/));
      ok('validator: a converted copy names its source', has(iss, 'info', '00209172', /Converted from Enhanced MR Image Storage \(frame 1\)/));
      ok('validator: and says the source is not loaded', has(iss, 'info', '00209172', /source is not among the loaded files/));
      ok('validator: or that it is', has(validateDicom(m.dict, m.meta, study(grayCopy, mr)), 'info', '00209172', /source is loaded: f1\.dcm/));
      ok('validator: a MONOCHROME2 image with a palette and no Pixel Presentation warns',
         has(validateDicom(m.dict, m.meta), 'warning', '00281201', /Pixel Presentation \(0008,9205\) is absent/));
      const mixed = parse(cdCopy(22, { '00089205': { vr: 'CS', v: ['MIXED'] },
        '00281101': { vr: 'US', v: [256, 0, 16] }, '00281201': { vr: 'OW', v: lut(i => i) } }));
      ok('validator: but not when Pixel Presentation is MIXED', !validateDicom(mixed.dict, mixed.meta).some(i => i.tag.toLowerCase() === '00281201'));
      const lone = parse(otherCopy);
      ok('validator: one series alone has no Series Number clash',
         !validateDicom(lone.dict, lone.meta, study(otherCopy)).some(i => i.tag.toLowerCase() === '00200011'));
    }

    // ---- burn the PR in as a colour series ----------------------------------
    {
      const entries = files.map(f => ({ dict: f.dict, meta: f.meta, name: f.name }));
      const r = await burnPresentationSeries(entries, at(STUDY + '.9.1'));
      ok('burn: one Secondary Capture per covered frame', r.files?.length === 2, r.error || String(r.files?.length));
      const sc = (r.files || []).map(f => parse(f.bytes));
      const v = (m, t) => String(lookupTag(m.dict, t)?.Value?.[0] ?? '').trim();
      ok('burn: RGB Secondary Capture Image Storage, 8-bit',
         sc.every(m => v(m, '00080016') === '1.2.840.10008.5.1.4.1.1.7' && v(m, '00280004') === 'RGB' && v(m, '00280100') === '8'));
      ok('burn: one new series in the same study, beside the source',
         sc.every(m => v(m, '0020000d') === STUDY && v(m, '0020000e') === r.series.uid) && r.series.uid !== MR_SERIES);
      ok('burn: its Series Number traces to the source and clashes with nothing loaded',
         sc.every(m => v(m, '00200011') === '504799'), v(sc[0], '00200011'));
      ok('burn: described as the colour copy', v(sc[0], '0008103e') === 'TESTPERFU COLOR', v(sc[0], '0008103e'));
      ok('burn: instances numbered in frame order', sc.map(m => v(m, '00200013')).join() === '1,2');
      ok('burn: patient copied from the source', v(sc[0], '00100010') === 'Forge^Test' && v(sc[0], '00100020') === 'FORGE-001');
      ok('burn: marked DERIVED with a derivation description naming the PR',
         /^DERIVED/.test(elToString(lookupTag(sc[0].dict, '00080008'))) && v(sc[0], '00082111').includes(STUDY + '.9.1'));
      const src = (m) => lookupTag(m.dict, '00082112')?.Value?.[0] || {};
      ok('burn: Source Image Sequence points at the source image and frame',
         sc.every((m, i) => v({ dict: src(m) }, '00081155') === MR_SOP && v({ dict: src(m) }, '00081160') === String(i + 1)));
      for (const [i, m] of sc.entries()) {
        const res = await decodeDicomPixels(m.dict, 0, { meta: m.meta });
        let bad = 0;
        for (let k = 0; k < N && res?.pixels; k++) {
          const want = Math.round(t(px[i * N + k], WIN[i + 1]) * 255);
          const q = k * 4;
          if (Math.abs(res.pixels[q] - want) > 1 || Math.abs(res.pixels[q + 1] - 128) > 1 || Math.abs(res.pixels[q + 2] - (255 - want)) > 1) bad++;
        }
        ok(`burn: frame ${i + 1} pixels are the PR rendering`, res?.pixels && !bad, res?.error || `${bad} px off`);
      }
      const all = entries.concat(sc.map((m, i) => ({ dict: m.dict, name: `sc${i}.dcm` })));
      const errs = validateDicom(sc[0].dict, sc[0].meta, all).filter(i => i.sev === 'error');
      ok('burn: the validator finds no errors in the result', !errs.length, errs.map(i => i.tag + ' ' + i.msg).join(' | '));
      const gr = await burnPresentationSeries(entries, at(STUDY + '.7.1'));
      ok('burn: a colour PR is refused', !!gr.error, gr.error);
      const lone = await burnPresentationSeries([entries[at(STUDY + '.9.1')]], 0);
      ok('burn: a PR without its images loaded is refused', !!lone.error, lone.error);
    }

    // The button: shown only while a PR is chosen; one archive for a multi-image series.
    {
      const realSave = window.saveBlob, saved = [];
      window.saveBlob = (blob, name) => saved.push({ blob, name });
      try {
        switchFile(at(MR_SOP));
        renderOverview();
        await settle(() => canvas.width === W);
        const btn = $('ovPresBurn');
        ok('burn button: hidden while the image is shown as stored', btn.classList.contains('hidden'));
        await choose(STUDY + '.9.1');
        ok('burn button: shown once a PR is chosen', !btn.classList.contains('hidden'));
        btn.click();
        await settle(() => saved.length > 0);
        ok('burn button: saves one archive for the two images', saved.length === 1 && /^series-504799-color-.*\.zip$/.test(saved[0]?.name || ''), saved.map(s => s.name).join());
        await choose('-1');
      } finally { window.saveBlob = realSave; }
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
  pre.textContent = (await window.SUITES.presentation()).join('\n');
  document.body.appendChild(pre);
});
