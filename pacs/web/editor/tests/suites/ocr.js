// @realtime: the OCR engine runs in a Web Worker, which headless Chromium's virtual clock does
// not wait for, so run.sh hands this suite to tests/realtime.py (which also checks that no
// request, the worker's included, leaves the origin). Not in #selftest: see SELFTEST_SKIPPED.
//
// Find burned-in text: does it propose the patient's identity, leave the measurement alone,
// and put its boxes where the text really is? The oracle is the raster this suite draws: each
// line of text is rendered into its own mask, so the exact pixels of the name, the ID and the
// measurement are known without asking the app. The matcher is checked first on its own, with
// hand-written OCR output, because the engine's misreads are not reproducible on demand.
(window.SUITES || (window.SUITES = {})).ocr = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // The script tag, not the resource timeline: a custom scheme (the desktop app's app://)
  // does not put its requests in performance.getEntriesByType('resource').
  const tesseractFetched = () => !!document.querySelector('script[src*="vendor/tesseract/"]') ||
                                 typeof window.Tesseract !== 'undefined';

  try {
    // ---- lazy ----------------------------------------------------------------
    ok('lazy: the OCR engine is not loaded with the page', !tesseractFetched());

    const O = window.imgOcr;
    ok('the OCR module exposes its pieces for testing', !!O && typeof O.matchLine === 'function');

    // ---- matching, on hand-written OCR output ---------------------------------
    {
      const dict = {
        '00100010': { vr: 'PN', Value: ['Doe^John'] },
        '00100020': { vr: 'LO', Value: ['12345678'] },
        '00100030': { vr: 'DA', Value: ['19600314'] },
        '00080050': { vr: 'SH', Value: ['A99887'] },
        '00080020': { vr: 'DA', Value: ['20260101'] },
        '00080030': { vr: 'TM', Value: ['120000'] },
        '00101002': { vr: 'SQ', Value: [{ '00100020': { vr: 'LO', Value: ['MRN-55501'] } }] },
      };
      const terms = O.terms(dict);
      const line = (...ws) => O.matchLine(ws.map(text => ({ text })), terms);
      const cases = [
        ['the name as stored', ['DOE^JOHN'], [true]],
        ['the name with O read as 0', ['D0E', 'JOHN'], [true, true]],
        ['the name with ^ read as A, run together', ['DOEAJOHN'], [true]],
        ['given name first', ['John', 'Doe'], [true, true]],
        ['the ID with 1 read as l', ['ID', 'l2345678'], [false, true]],
        ['the ID with one digit misread', ['12346678'], [true]],
        ['birth date day-first with dots', ['DOB', '14.03.1960'], [false, true]],
        ['birth date month-first', ['03/14/1960'], [true]],
        ['birth date with a month name, split', ['14', 'MAR', '1960'], [true, true, true]],
        ['study date ISO', ['2026-01-01'], [true]],
        ['study time HH:MM', ['12:00'], [true]],
        ['accession', ['ACC', 'A99887'], [false, true]],
        ['an ID from Other Patient IDs Sequence', ['MRN55501'], [true]],
        ['a measurement', ['12.3', 'mm'], [false, false]],
        ['a marker', ['L'], [false]],
        ['a different 8-digit number', ['87654321'], [false]],
      ];
      for (const [label, words, want] of cases) {
        const got = line(...words).map(Boolean);
        ok(`match: ${label}`, JSON.stringify(got) === JSON.stringify(want), `${words.join(' ')} -> ${JSON.stringify(got)}`);
      }
      const hit = line('ID', '12345678');
      ok('match: a hit names the attribute it came from', hit[1] === 'Patient ID', String(hit[1]));

      // Short names only match whole words; a name inside another word is not the name.
      const t2 = O.terms({ '00100010': { vr: 'PN', Value: ['Li^Ann'] } });
      const l2 = (...ws) => O.matchLine(ws.map(text => ({ text })), t2).map(Boolean);
      ok('match: a two-letter surname matches as a word', l2('LI')[0] === true);
      ok('match: but not inside LIVER', l2('LIVER')[0] === false);
      ok('match: a name in the middle of a word is not it', l2('SCANNER')[0] === false);
      // Accents are folded on the tag side; the English model reads them plain.
      const t3 = O.terms({ '00100010': { vr: 'PN', Value: [{ Alphabetic: 'Muñoz^José' }] } });
      ok('match: an accented, naturalised PN meets plain OCR',
         O.matchLine([{ text: 'MUNOZ' }, { text: 'JOSE' }], t3).every(Boolean));
      ok('match: an empty dataset proposes nothing', O.terms({}).length === 0);

      // A label run into its value is one OCR word; the value must still be found. And the
      // banner attributes beyond name/ID/dates, and a TM stored without seconds.
      const t4 = O.terms({
        '00100010': { vr: 'PN', Value: ['Doe^John'] },
        '00100020': { vr: 'LO', Value: ['A12'] },
        '00081050': { vr: 'PN', Value: ['House^Gregory'] },
        '00081048': { vr: 'PN', Value: ['Wilson^James'] },
        '00200010': { vr: 'SH', Value: ['S4471'] },
        '00101010': { vr: 'AS', Value: ['045Y'] },
        '00081010': { vr: 'SH', Value: ['USROOM3'] },
        '00080032': { vr: 'TM', Value: ['1430'] },
      });
      const l4 = (...ws) => O.matchLine(ws.map(text => ({ text })), t4).map(Boolean);
      const cases4 = [
        ['a label and a long name run together', ['Patient:DOE^JOHN'], [true]],
        ['a label and a short name run together', ['PT:DOE'], [true]],
        ['a label and a short ID run together', ['ID:A12'], [true]],
        ['a label alone', ['PATIENT:'], [false]],
        ['a short ID inside a longer word is not it', ['A123'], [false]],
        ['performing physician', ['HOUSE'], [true]],
        ['physician of record', ['Dr', 'Wilson'], [false, true]],
        ['study ID', ['STUDY', 'S4471'], [false, true]],
        ["patient's age without its leading zero", ['AGE', '45Y'], [false, true]],
        ['station name', ['USROOM3'], [true]],
        ['a TM stored as HHMM shown with seconds', ['14:30:00'], [true]],
      ];
      for (const [label, words, want] of cases4) {
        const got = l4(...words);
        ok(`match: ${label}`, JSON.stringify(got) === JSON.stringify(want), `${words.join(' ')} -> ${JSON.stringify(got)}`);
      }
    }

    // ---- merging --------------------------------------------------------------
    {
      const W = 100, H = 50;
      const m = O.merge([
        { x: 10, y: 10, w: 20, h: 8, text: 'DOE', field: 'Patient Name' },
        { x: 10.5, y: 10, w: 19, h: 8, text: 'D0E', field: null },          // same word, other pass
        { x: 33, y: 10, w: 24, h: 8, text: 'JOHN', field: 'Patient Name' },  // next word on the line
        { x: 70, y: 40, w: 25, h: 8, text: 'mm', field: null },
      ], W, H);
      ok('merge: the same word read twice and its neighbour become one PHI box',
         m.length === 2 && m.filter(b => b.phi).length === 1, JSON.stringify(m.map(b => [b.x, b.y, b.w, b.h, b.phi])));
      const phi = m.find(b => b.phi), other = m.find(b => !b.phi);
      ok('merge: the PHI box covers both words, padded',
         !!phi && phi.x < 10 && phi.y < 10 && phi.x + phi.w > 57 && phi.y + phi.h > 18);
      ok('merge: PHI is selected, other text is not', !!phi && phi.on === true && !!other && other.on === false);
      ok('merge: padding never leaves the image', m.every(b => b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H),
         JSON.stringify(other));
    }

    // ---- end to end, through the real engine ----------------------------------
    // 320x200, so an x/y swap or a lost upscale factor (3 here) misplaces every box.
    const W = 320, H = 200;
    await document.fonts.load('600 14px "IBM Plex Mono"');
    // Each line is drawn into its own mask; the frame burns the mask in at full white.
    function mask(text, x, y) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const cx = c.getContext('2d');
      cx.fillStyle = '#fff';
      cx.font = '600 14px "IBM Plex Mono", monospace';
      cx.textBaseline = 'top';
      cx.fillText(text, x, y);
      const a = cx.getImageData(0, 0, W, H).data;
      const m = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) m[i] = a[i * 4 + 3];
      return m;
    }
    const LINES = {
      name:  { text: 'DOE^JOHN',       x: 8,   y: 6,   frames: [0, 1], phi: true },
      id:    { text: 'ID 12345678',    x: 8,   y: 26,  frames: [0, 1], phi: true },
      dob:   { text: 'DOB 14.03.1960', x: 8,   y: 46,  frames: [0, 1], phi: true },
      acc:   { text: 'ACC A99887',     x: 200, y: 6,   frames: [1],    phi: true },
      meas:  { text: '12.3 mm',        x: 236, y: 178, frames: [0, 1], phi: false },
    };
    for (const l of Object.values(LINES)) l.mask = mask(l.text, l.x, l.y);
    // Only the value is identity; "ID", "DOB" and "ACC" are labels and need not be covered.
    LINES.id.valueMask = mask('   12345678', 8, 26);
    LINES.dob.valueMask = mask('    14.03.1960', 8, 46);
    LINES.acc.valueMask = mask('    A99887', 200, 6);

    const frames = [0, 1].map(f => {
      const px = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        // A dim gradient and a mid-grey ellipse: something to read past, not a blank page.
        let v = 18 + Math.round(30 * x / W);
        const u = (x - W / 2) / 90, w = (y - H / 2) / 55;
        if (u * u + w * w < 1) v = 110 + ((x * 7 + y * 3 + f * 5) % 23);
        px[y * W + x] = v;
      }
      for (const l of Object.values(LINES)) {
        if (!l.frames.includes(f)) continue;
        for (let i = 0; i < W * H; i++) if (l.mask[i]) px[i] = Math.max(px[i], l.mask[i]);
      }
      return px;
    });
    const all = new Uint8Array(W * H * 2);
    all.set(frames[0], 0); all.set(frames[1], W * H);
    const bytes = Forge.build({
      rows: H, cols: W, pi: 'MONOCHROME2', ba: 8, bs: 8, hb: 7, pr: 0, frames: 2,
      wc: 128, ww: 256, pixels: all, modality: 'US',
      extra: {
        '00100010': { vr: 'PN', v: ['DOE^JOHN'] },
        '00100020': { vr: 'LO', v: ['12345678'] },
        '00100030': { vr: 'DA', v: ['19600314'] },
        '00080050': { vr: 'SH', v: ['A99887'] },
        '00280301': { vr: 'CS', v: ['YES'] },
      },
    });

    switchTab('editor');
    await handleFiles([new File([bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes],
                                'ocr.dcm', { type: 'application/dicom' })]);
    const entry = files[0];
    for (let i = 0; i < 200 && !(previewImageData && previewImageData.width === W); i++) await sleep(25);
    const R = window.imgRedaction;
    R.open();
    ok('the workspace opened on the forged image', R.state.active === true);
    ok('lazy: opening the workspace does not load the engine either', !tesseractFetched());

    // Stop, straight after Find: nothing is added and the engine goes away.
    document.getElementById('redactFind').click();
    ok('Find shows Stop while it runs', !document.getElementById('redactFindStop').classList.contains('hidden'));
    document.getElementById('redactFindStop').click();
    await R.state.finding;
    ok('Stop: no boxes were added', R.state.boxes.length === 0, String(R.state.boxes.length));
    ok('Stop: Find is ready again', !document.getElementById('redactFind').disabled &&
       document.getElementById('redactFindStop').classList.contains('hidden'));
    ok('Stop: the status says so', document.getElementById('redactFindStatus').textContent === t('Stopped. No boxes were added.'),
       document.getElementById('redactFindStatus').textContent);

    // A box drawn by hand survives a Find.
    R.state.boxes.push({ x: 150, y: 90, w: 10, h: 10 });

    const t0 = performance.now();
    document.getElementById('redactFind').click();
    await R.state.finding;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    ok('lazy: Find loaded the engine from vendor/tesseract/', tesseractFetched());
    ok('the engine is torn down after the run', window.imgOcr.run.worker === null && !window.imgOcr.run.busy);

    const found = R.state.boxes.filter(b => b.ocr);
    ok('the hand-drawn box is still there', R.state.boxes.some(b => !b.ocr && b.x === 150), `${secs} s`);
    ok('Find proposed boxes', found.length >= 2, `${found.length} box(es) in ${secs} s: ` +
       found.map(b => `${b.on ? '+' : '-'}${b.text}`).join(' | '));

    // Coverage in stored pixels: the share of a mask's pixels that selected (or unselected)
    // boxes cover, with the boxes taken exactly as applyRedaction will (floor / ceil).
    const covered = (m, boxes) => {
      let n = 0, hit = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (m[y * W + x] < 64) continue;
        n++;
        if (boxes.some(b => x >= Math.floor(b.x) && x < Math.ceil(b.x + b.w) &&
                            y >= Math.floor(b.y) && y < Math.ceil(b.y + b.h))) hit++;
      }
      return n ? hit / n : 0;
    };
    const on = found.filter(b => b.on), off = found.filter(b => !b.on);
    for (const key of ['name', 'id', 'dob', 'acc']) {
      const l = LINES[key];
      const share = covered(l.valueMask || l.mask, on);
      ok(`find: ${key} ("${l.text}") is proposed and selected`, share === 1, `${(share * 100).toFixed(1)}% covered`);
    }
    ok('find: text only on frame 2 was read too', covered(LINES.acc.valueMask, on) === 1);
    const measOn = covered(LINES.meas.mask, on), measOff = covered(LINES.meas.mask, off);
    ok('find: the measurement is found', measOff > 0.9, `${(measOff * 100).toFixed(1)}% outlined`);
    ok('find: and is not selected', measOn === 0, `${(measOn * 100).toFixed(1)}% under selected boxes`);
    ok('find: the boxes lie inside the image', found.every(b => b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H));
    ok('find: the count shows what Apply will fill',
       document.getElementById('redactCount').textContent === String(R.state.boxes.filter(b => b.on !== false).length));
    ok('find: the status names what was found',
       /\d/.test(document.getElementById('redactFindStatus').textContent), document.getElementById('redactFindStatus').textContent);

    // A click on a found box switches it, through the real pointer handlers.
    {
      const canvas = document.getElementById('fullscreenCanvas');
      const b = canvas.getBoundingClientRect();
      const m = off[0];
      const p = { x: b.left + (m.x + m.w / 2) * b.width / canvas.width, y: b.top + (m.y + m.h / 2) * b.height / canvas.height };
      const send = (type) => canvas.dispatchEvent(new PointerEvent(type, {
        clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, pointerId: 1 }));
      send('pointerdown'); send('pointerup');
      ok('a click selects found text', m.on === true);
      send('pointerdown'); send('pointerup');
      ok('a second click unselects it', m.on === false);
    }

    // After Anonymize the tags hold placeholders; the status must say so rather than imply
    // that unselected text is safe. Run on the same file with (0012,0062) set, then restored.
    {
      const msg = t('This file is already de-identified, so its tags no longer hold the patient details to match. Select the boxes yourself.');
      const status = () => document.getElementById('redactFindStatus').textContent;
      ok('de-identified: an ordinary file does not carry the de-identified note', !status().includes(msg));
      const saved = R.state.boxes.slice();
      entry.dict['00120062'] = { vr: 'CS', Value: ['YES'] };
      document.getElementById('redactFind').click();
      await R.state.finding;
      delete entry.dict['00120062'];
      ok('de-identified: the status says the tags can no longer be matched', status().includes(msg), status());
      R.state.boxes = saved;
    }

    // A frame that does not decode is not read; the status must say which, and a file with
    // no readable frame is an error, not "No text found". decodeDicomPixels is a global
    // function declaration, so js/ocr.js picks up the stub through the global object.
    {
      const status = () => document.getElementById('redactFindStatus').textContent;
      const realDecode = window.decodeDicomPixels, saved = R.state.boxes.slice();
      try {
        window.decodeDicomPixels = (d, f, o) => f === 1 ? Promise.resolve({ error: 'broken fragment' }) : realDecode(d, f, o);
        document.getElementById('redactFind').click();
        await R.state.finding;
        const note = t('Frame(s) {list} could not be read; check them yourself.').replace('{list}', '2');
        ok('undecodable frame: the status names it', status().includes(note), status());
        ok('undecodable frame: the frame that did decode was still read',
           R.state.boxes.some(b => b.ocr && b.phi), String(R.state.boxes.filter(b => b.ocr).length));
        window.decodeDicomPixels = () => Promise.resolve(null);
        document.getElementById('redactFind').click();
        await R.state.finding;
        ok('no frame decodes: an error, not "No text found"',
           status() === t('Text could not be read: {e}').replace('{e}', t('No frame of this image could be decoded.')), status());
      } finally { window.decodeDicomPixels = realDecode; }
      R.state.boxes = saved;
    }

    // Proposals on screen but none selected: the hint points at the boxes, not at drawing.
    {
      const saved = R.state.boxes.slice();
      R.state.boxes = saved.filter(b => b.ocr).map(b => ({ ...b, on: false }));
      document.getElementById('redactApply').click();
      const toastEl = document.querySelector('.toast');
      ok('apply with nothing selected: says to click a yellow box',
         !!toastEl && toastEl.textContent === t('Click a yellow box to select it, or draw a box.'), toastEl && toastEl.textContent);
      R.state.boxes = saved;
    }

    // Apply goes through the existing redaction: same retagging, same undo.
    const before = frames.map(f => f.slice());
    document.getElementById('redactApply').click();
    for (let i = 0; i < 400 && String(lookupTag(entry.dict, '00280301')?.Value?.[0] || '') !== 'NO'; i++) await sleep(25);
    ok('apply: Burned In Annotation is now NO', String(lookupTag(entry.dict, '00280301')?.Value?.[0]) === 'NO');
    const px = new Uint8Array(lookupTag(entry.dict, '7fe00010').Value[0]);
    for (const f of [0, 1]) {
      const fr = px.subarray(f * W * H, (f + 1) * W * H);
      for (const key of ['name', 'id', 'dob']) {
        const m = LINES[key].valueMask || LINES[key].mask;
        let left = 0;
        for (let i = 0; i < W * H; i++) if (m[i] >= 64 && fr[i] !== 0) left++;
        ok(`apply: frame ${f + 1}: ${key} pixels are black`, left === 0, `${left} px left`);
      }
      let changed = 0;
      for (let i = 0; i < W * H; i++) if (LINES.meas.mask[i] && fr[i] !== before[f][i]) changed++;
      ok(`apply: frame ${f + 1}: the measurement is untouched`, changed === 0, `${changed} px changed`);
    }
    ok('apply: the session undo is offered', !!entry.redactBackup &&
       !document.getElementById('imgRedactUndo').classList.contains('hidden'));

    // ---- the fallback core ------------------------------------------------------
    // This browser has SIMD, so the run above used the SIMD build. The other one is what a
    // browser without it gets, so it is read with once here, configured as js/ocr.js does.
    {
      const dir = new URL('vendor/tesseract/', location.href).href;
      let text = '';
      try {
        const w = await Tesseract.createWorker('eng', 1, {
          workerPath: dir + 'worker.min.js', corePath: dir + 'tesseract-core-lstm.js',
          langPath: dir.replace(/\/$/, ''), gzip: true, cacheMethod: 'none', workerBlobURL: false });
        const c = document.createElement('canvas');
        c.width = 240; c.height = 60;
        const cx = c.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, 240, 60);
        cx.fillStyle = '#000'; cx.font = '600 28px "IBM Plex Mono", monospace'; cx.fillText('A99887', 12, 42);
        text = (await w.recognize(c)).data.text;
        await w.terminate();
      } catch (e) { text = 'error: ' + (e && e.message || e); }
      ok('core: the non-SIMD fallback build reads text too', /A99887/.test(text), JSON.stringify(text));
    }

    // ---- nothing left the origin, as far as the page can see -------------------
    // The page's own timeline; tests/realtime.py adds the worker's requests.
    const away = performance.getEntriesByType('resource').map(e => e.name)
      .filter(u => !/^(data|blob):/.test(u) && new URL(u).origin !== location.origin);
    ok('privacy: every request the page made stayed on this origin', away.length === 0, away.slice(0, 3).join(' | '));

    // ---- copy -----------------------------------------------------------------
    const NEW_STRINGS = [
      'Find burned-in text', 'Stop',
      'Find burned-in text reads every frame on this device; nothing is uploaded. It can miss text, so check the whole image before you apply.',
      'Text that matches this patient (name, ID, dates, accession) is selected in red. Other text, such as measurements and markers, is outlined in yellow and left alone. Click a box to select or unselect it.',
      'Loading the text reader…', 'Reading frame {i} of {n}…', 'Text could not be read: {e}',
      'Found {n} piece(s) of text; {m} match this patient and are selected. Check the whole image: text can be missed.',
      'No text found. Check the whole image yourself: text can be missed.',
      'Stopped. No boxes were added.',
      'This file is already de-identified, so its tags no longer hold the patient details to match. Select the boxes yourself.',
      'No frame of this image could be decoded.', 'Frame(s) {list} could not be read; check them yourself.',
      'Click a yellow box to select it, or draw a box.',
    ];
    for (const loc of ['es', 'pt-BR', 'ja', 'ru']) {
      const missing = NEW_STRINGS.filter(s => !I18N[loc] || !I18N[loc][s]);
      ok(`i18n: every new string is translated into ${loc}`, missing.length === 0, missing.join(' | ').slice(0, 160));
    }
    ok('i18n: the Japanese copy says PC', /PC/.test(I18N.ja[NEW_STRINGS[2]]));
  } catch (e) {
    ok('suite ran to completion', false, (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' / ') : String(e)));
  }

  return out;
};

// Two callers: tests/run.sh injects this file alone and scrapes the <pre> below;
// index.html#selftest sets window.SELFTEST and awaits the returned lines instead.
if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.ocr()).join('\n');
  document.body.appendChild(pre);
});
