// Edits belong to the file they were made on.
//
// The working copy of a dataset is seeded with every editable tag at its current
// value, so it is not a list of changes — it is a whole second dataset. One of
// those shared between files is not a stale-UI problem, it is a file that gets
// written with another file's identity. This suite loads a small study through
// the real drop handler and checks that each file keeps its own.
(window.SUITES || (window.SUITES = {})).edits = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  // The app's own formatter, so a PN element reads the same here as it does in
  // the working copy we are comparing against.
  const tag = (d, t) => { const e = lookupTag(d, t); return e ? elToString(e).trim() : ''; };

  // A whole-dataset fingerprint, deep enough that nothing can change without it
  // showing: every element's VR, every value, the bytes behind every buffer, and
  // the same again for every item of every sequence. FNV-1a because the point is
  // to notice a difference, not to resist anyone.
  const fnv = (bytes) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16);
  };
  const fingerprint = (node) => {
    const parts = [];
    const walk = (obj, prefix) => {
      for (const k of Object.keys(obj).sort()) {
        const el = obj[k];
        if (!el || typeof el !== 'object') { parts.push(`${prefix}${k}=${String(el)}`); continue; }
        const vals = Array.isArray(el.Value) ? el.Value : (el.Value === undefined ? [] : [el.Value]);
        parts.push(`${prefix}${k}|${el.vr}|n=${vals.length}`);
        if (typeof el.InlineBinary === 'string') parts.push(`${prefix}${k}|inline=${el.InlineBinary.length}`);
        vals.forEach((v, i) => {
          const at = `${prefix}${k}[${i}]`;
          if (v instanceof ArrayBuffer) parts.push(`${at}=ab:${v.byteLength}:${fnv(new Uint8Array(v))}`);
          else if (ArrayBuffer.isView(v)) parts.push(`${at}=view:${v.byteLength}:${fnv(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))}`);
          else if (v && typeof v === 'object') walk(v, at + '/');
          else parts.push(`${at}=${String(v)}`);
        });
      }
    };
    walk(node || {}, '');
    return parts.join('\n');
  };
  // Every buffer in a dataset, by reference and in traversal order. Equal bytes
  // are not the point here — the point of the shallow copy is that the pixels
  // are never duplicated, so what has to hold is that these are literally the
  // same objects afterwards.
  const buffersOf = (node) => {
    const seen = [];
    const walk = (obj) => {
      for (const k of Object.keys(obj).sort()) {
        const el = obj[k];
        if (!el || typeof el !== 'object') continue;
        const vals = Array.isArray(el.Value) ? el.Value : (el.Value === undefined ? [] : [el.Value]);
        for (const v of vals) {
          if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) seen.push(v);
          else if (v && typeof v === 'object') walk(v);
        }
      }
    };
    walk(node || {});
    return seen;
  };
  // Where two fingerprints first disagree, so a failure names the tag instead of
  // making someone diff two thousand lines by eye.
  const firstDiff = (a, b) => {
    const la = a.split('\n'), lb = b.split('\n');
    for (let i = 0; i < Math.max(la.length, lb.length); i++)
      if (la[i] !== lb[i]) return `${la[i] ?? '(missing)'} -> ${lb[i] ?? '(missing)'}`;
    return '';
  };

  try {
    // A three-slice series: one study, one series, three instances that differ
    // only in the ways slices of a real series differ.
    const studyUID = '1.2.826.0.1.3680043.10.99999.7.1';
    const seriesUID = '1.2.826.0.1.3680043.10.99999.7.2';
    const slices = [0, 1, 2].map((i) => {
      const n = Forge.W * Forge.H;
      const px = new Uint16Array(n);
      for (let k = 0; k < n; k++) px[k] = (k + i * 500) & 0xFFF;
      return Forge.build({
        rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
        wc: 2048, ww: 4096, modality: 'CT',
        studyUID, seriesUID, instance: i + 1,
        sopInstance: `1.2.826.0.1.3680043.10.99999.7.3.${i + 1}`,
        pixels: px,
      });
    });

    // Through the real handler, not a hand-built files[] — the seeding lives there.
    await handleFiles(slices.map((b, i) => new File([b], `slice${i + 1}.dcm`, { type: 'application/dicom' })));

    ok('three files load', files.length === 3, String(files.length));
    ok('each file carries its own working copy',
       files.length === 3 && new Set(files.map(f => f.pending)).size === 3 && files.every(f => f.pending instanceof Map),
       files.map(f => (f.pending ? f.pending.size : 'none')).join(','));
    ok('pendingEdits points at the file on screen', pendingEdits === files[0].pending);

    // ---- an edit on one file stays on that file ------------------------------
    // editKey resolves whichever key form this dcmjs build produced.
    const NAME = editKey('00100010');
    ok('the working copy is keyed the same way the dataset is',
       files[0].pending.has(NAME), NAME);
    pendingEdits.set(NAME, { vr: 'PN', valueString: 'Edited^SliceOne' });

    switchFile(1);
    ok('switching files moves the pointer', pendingEdits === files[1].pending);
    ok('the edit does not follow the switch',
       pendingEdits.get(NAME).valueString === 'Forge^Test', pendingEdits.get(NAME).valueString);

    switchFile(0);
    ok('and it is still there when we come back',
       pendingEdits.get(NAME).valueString === 'Edited^SliceOne', pendingEdits.get(NAME).valueString);

    // ---- what actually gets written -----------------------------------------
    const written = [];
    for (const f of files) {
      const buf = await buildEditedFile(f).arrayBuffer();
      const msg = DicomMessage.readFile(buf);
      normBin(msg.dict);
      written.push(msg.dict);
    }

    ok('the edited file is the one that was edited',
       tag(written[0], '00100010') === 'Edited^SliceOne', tag(written[0], '00100010'));
    for (let i = 1; i < 3; i++) {
      ok(`slice ${i + 1} is not overwritten with slice 1's name`,
         tag(written[i], '00100010') === 'Forge^Test', tag(written[i], '00100010'));
    }

    // PersonName is its own shape in DICOM, and the writer used to be handed an
    // object it stringified — putting the text "[object Object]" in the file as
    // the patient's name while the editor kept displaying it correctly.
    ok('an edited PersonName is not stringified into the file',
       !/\[object/.test(tag(written[0], '00100010')), tag(written[0], '00100010'));

    // The one that corrupts a series: every slice writing slice 1's identity.
    const sops = written.map(d => tag(d, '00080018'));
    ok('every slice keeps its own SOP Instance UID', new Set(sops).size === 3, sops.join(' | '));
    const nums = written.map(d => tag(d, '00200013'));
    ok('every slice keeps its own Instance Number', nums.join(',') === '1,2,3', nums.join(','));
    ok('they still share one Series Instance UID',
       new Set(written.map(d => tag(d, '0020000e'))).size === 1);

    // ---- saving must not disturb the file being saved ------------------------
    // The writer is handed a SHALLOW copy of entry.dict, which keeps a second
    // copy of PixelData out of memory on every download but rests entirely on
    // dcmjs treating the dataset it is given as read-only. Nothing else in this
    // app would notice that breaking: the exported file would still look right,
    // and the file the user still has open would be the one that quietly changed.
    switchFile(0);
    const beforeFP = fingerprint(files[0].dict);
    const beforeMetaFP = fingerprint(files[0].meta);
    const beforeBufs = buffersOf(files[0].dict).concat(buffersOf(files[0].meta));
    const firstOut = new Uint8Array(await buildEditedFile(files[0]).arrayBuffer());
    const afterFP = fingerprint(files[0].dict);
    ok('writing a file does not disturb the file', afterFP === beforeFP, firstDiff(beforeFP, afterFP));
    ok('and does not disturb its File Meta either',
       fingerprint(files[0].meta) === beforeMetaFP,
       firstDiff(beforeMetaFP, fingerprint(files[0].meta)));

    const afterBufs = buffersOf(files[0].dict).concat(buffersOf(files[0].meta));
    ok('and leaves every buffer in it exactly where it was',
       beforeBufs.length > 0 && afterBufs.length === beforeBufs.length &&
       afterBufs.every((b, i) => b === beforeBufs[i]),
       `${beforeBufs.length} before, ${afterBufs.length} after`);

    // The saving is the point, not only the correctness, and "no copy was made"
    // cannot be seen from outside — so borrow the writer for one call and look at
    // the dataset it is actually handed. A deep copy would hand it a second set
    // of buffers, which is a second copy of the image per file per download.
    const realWrite = DicomDict.prototype.write;
    let handed = null;
    DicomDict.prototype.write = function (...a) { handed = this.dict; return realWrite.apply(this, a); };
    try { buildEditedBytes(files[0]); } finally { DicomDict.prototype.write = realWrite; }
    const handedBufs = buffersOf(handed || {}), ownBufs = buffersOf(files[0].dict);
    ok('the writer gets the file\'s own buffers rather than copies of them',
       ownBufs.length > 0 && handedBufs.length === ownBufs.length &&
       handedBufs.every((b, i) => b === ownBufs[i]),
       `${ownBufs.length} in the file, ${handedBufs.length} handed over`);

    // Aliasing that survives one write shows up on the second, which would be
    // built on top of whatever the first one left behind.
    const secondOut = new Uint8Array(await buildEditedFile(files[0]).arrayBuffer());
    ok('saving the same file twice gives the same bytes',
       secondOut.length === firstOut.length && secondOut.every((b, i) => b === firstOut[i]),
       `${firstOut.length} vs ${secondOut.length}`);

    // ---- bulk rewrites reseed every working copy, not just the visible one ----
    switchFile(0);
    const beforeIds = files.map(f => tag(f.dict, '00100020'));
    files.forEach(f => anonymize(f.dict));
    reseedAllPending();
    const stale = files.filter(f => f.pending.get(editKey('00100020'))?.valueString !== tag(f.dict, '00100020'));
    ok('anonymizing refreshes every file\'s working copy', stale.length === 0,
       stale.map(f => f.name).join(','));
    ok('anonymize actually changed the identifiers',
       files.every((f, i) => tag(f.dict, '00100020') !== beforeIds[i]),
       files.map(f => tag(f.dict, '00100020')).join(','));

    // ---- Anonymize places a placeholder; Randomize invents a patient ---------
    // These are two buttons and they have to differ where a reader looks first.
    // Anonymize used to write a placeholder drawn from a random culture, so it
    // produced a plausible person — the same thing Randomize produces — and it
    // drew that culture inside the per-file loop, so one patient's five slices
    // came back under four different names. A study keyed to one PatientID and
    // naming four people is not one any reader will reassemble.
    {
      const nameOf = (f) => String(tag(f.dict, '00100010') || '');
      const names = files.map(nameOf);
      ok('anonymize writes the ANONYMOUS placeholder, not a person',
         names.every(n => n === 'ANONYMOUS'), names.join(' | '));
      ok('and writes the same one to every file of the study',
         new Set(names).size === 1, `${new Set(names).size} distinct across ${names.length} files`);

      files.forEach(f => randomize(f.dict));
      const rnd = files.map(nameOf);
      ok('randomize invents a plausible patient instead',
         rnd.every(n => /^[A-Z]+\^[A-Z]+$/.test(n)), rnd.join(' | '));
      ok('so the two buttons do not produce the same thing',
         rnd.every(n => n !== 'ANONYMOUS'), rnd.join(' | '));
      // Restore the anonymized state for whatever runs after this.
      files.forEach(f => anonymize(f.dict));
      reseedAllPending();
    }

    // ---- the Window/Level sliders write the tag, not a lookalike -------------
    // setWL used to store a hard-coded "x0028105x" key. On a dataset keyed
    // without the prefix that added a second entry the writer then emitted
    // alongside the real Window Center, and the slider never read its own value
    // back. Both symptoms come from the same mismatch.
    switchFile(0);
    setWL(275, 850);
    const wcKey = editKey('00281050'), wwKey = editKey('00281051');
    ok('the slider edits the Window Center already in the file',
       files[0].pending.get(wcKey)?.valueString === '275', String(files[0].pending.get(wcKey)?.valueString));
    const strays = [...files[0].pending.keys()].filter(k => !files[0].dict[k]);
    ok('and does not invent a second key for it', strays.length === 0, strays.join(','));

    const back = DicomMessage.readFile(await buildEditedFile(files[0]).arrayBuffer());
    normBin(back.dict);
    ok('the written file carries the new window', tag(back.dict, '00281050') === '275',
       tag(back.dict, '00281050'));
    ok('the written file has one Window Center, not two',
       Object.keys(back.dict).filter(k => /00281050$/i.test(k)).length === 1,
       Object.keys(back.dict).filter(k => /00281050$/i.test(k)).join(','));

    // ---- and the panel they live in folds away --------------------------------
    // Expanded it is a preset box and two slider rows, taller than the picture it
    // adjusts in a column a third of the window wide, and it is reached
    // occasionally rather than constantly. Collapsed is the default; the header
    // keeps the reading, so folding it hides the controls and not the numbers.
    {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const sec = document.getElementById('wlSection');
      const body = document.getElementById('wlBody');
      const tgl = document.getElementById('wlToggle');
      const sum = document.getElementById('wlSummary');
      ok('the Window/Level body is a separate element from its header',
         !!sec && !!body && !!tgl && sec.contains(body) && sec.contains(tgl));
      ok('the header reads the current window while the body is folded',
         sum.textContent === '275 / 850', sum.textContent);

      // This suite otherwise runs on the Overview, where the whole Edit panel is
      // display:none and every element in it measures zero. Layout questions
      // have to be asked with the tab it lives on actually open.
      const wasTab = activeTab;
      switchTab('editor');
      for (let i = 0; i < 200 && sec.classList.contains('hidden'); i++) await sleep(25);
      ok('the section is on screen at all with an image loaded',
         !sec.classList.contains('hidden'));

      setWLOpen(false);
      ok('collapsed: the body is not laid out', body.offsetParent === null);
      ok('collapsed: the header still is', tgl.offsetParent !== null);
      ok('collapsed: aria-expanded says so', tgl.getAttribute('aria-expanded') === 'false');
      const foldedH = sec.getBoundingClientRect().height;

      tgl.click();
      ok('clicking the header opens it', body.offsetParent !== null &&
         tgl.getAttribute('aria-expanded') === 'true');
      ok('and opening it costs real height', sec.getBoundingClientRect().height > foldedH + 60,
         `${foldedH.toFixed(0)}px folded vs ${sec.getBoundingClientRect().height.toFixed(0)}px open`);
      ok('the sliders are the ones that were there all along',
         document.getElementById('wcSlider').value === '275' &&
         document.getElementById('wwSlider').value === '850');

      tgl.click();
      ok('clicking again folds it', body.offsetParent === null);
      // Folding must not be a way to lose a window the user set.
      setWL(300, 900);
      ok('a window set while folded still reaches the file',
         files[0].pending.get(wcKey)?.valueString === '300',
         String(files[0].pending.get(wcKey)?.valueString));
      ok('and the folded header shows it', sum.textContent === '300 / 900', sum.textContent);
      setWL(275, 850);
      switchTab(wasTab);
    }
    // ---- saving must not destroy an encapsulated image -----------------------
    // The file in front of a user is often one this app wrote. Compressed pixel
    // data lives in fragments rather than one run of bytes, so a writer that
    // flattens them produces a file that loads and then will not render.
    for (const [id, ts, make] of [
      ['jpeg-lossless', '1.2.840.10008.1.2.4.70',
       (rgb, w, h) => Forge.jpegLossless(rgb, w, h, 3, 8)],
      ['rle', '1.2.840.10008.1.2.5',
       (rgb, w, h) => Forge.rleFrame([0, 1, 2].map(c => {
         const pl = new Uint8Array(w * h);
         for (let i = 0; i < w * h; i++) pl[i] = rgb[i * 3 + c];
         return pl;
       }))],
    ]) {
      const w = Forge.W, h = Forge.H;
      const rgb = Forge.colorPattern(w, h);
      const file = Forge.build({ ts, rows: h, cols: w, pi: 'RGB', spp: 3, ba: 8, bs: 8,
                                 hb: 7, pr: 0, planar: 0, modality: 'XC',
                                 encapsulated: [make(rgb, w, h)] });
      await handleFiles([new File([file], `${id}.dcm`)]);
      const want = Forge.expected({ kind: 'rgb', rgb }, w, h);

      const before = await decodeDicomPixels(files[0].dict, 0, { meta: files[0].meta });
      ok(`${id}: renders as loaded`, !!before && !before.error &&
         !Forge.compare(before.pixels, want, 0),
         before ? (before.error || Forge.compare(before.pixels, want, 0) || '') : 'null');

      // Encapsulated pixel data is an array of fragment buffers rather than one,
      // which is the shape the shallow copy has the least excuse to get right.
      const encFP = fingerprint(files[0].dict);
      const round = DicomMessage.readFile(await buildEditedFile(files[0]).arrayBuffer());
      ok(`${id}: writing it leaves the fragments alone`,
         fingerprint(files[0].dict) === encFP, firstDiff(encFP, fingerprint(files[0].dict)));
      normBin(round.dict);
      const after = await decodeDicomPixels(round.dict, 0, { meta: round.meta });
      ok(`${id}: still renders after being saved`, !!after && !after.error &&
         !Forge.compare(after.pixels, want, 0),
         after ? (after.error || Forge.compare(after.pixels, want, 0) || '') : 'null');
    }

    // ---- an edit two levels down goes into the export, not into the file ----
    // A nested edit is written by walking the outgoing dataset down to the item
    // that holds it. That dataset is a shallow copy, so the walk has to duplicate
    // the sequence and the item on the way rather than write through the ones the
    // loaded file is still using — otherwise exporting a study would edit it, and
    // a second export would be built on top of the first.
    {
      const n = Forge.W * Forge.H;
      const px = new Uint16Array(n);
      for (let k = 0; k < n; k++) px[k] = k & 0xFFF;
      const nested = Forge.build({
        rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
        modality: 'CT', pixels: px,
        extra: {
          '00081140': { vr: 'SQ', items: [{
            '00081150': { vr: 'UI', v: ['1.2.840.10008.5.1.4.1.1.7'] },
            '00100010': { vr: 'PN', v: ['Nested^Original'] },
            '0040a170': { vr: 'SQ', items: [{
              '00080100': { vr: 'SH', v: ['121322'] },
              '00080104': { vr: 'LO', v: ['Deeper^Original'] },
            }] },
          }] },
        },
      });
      await handleFiles([new File([nested], 'nested.dcm')]);

      const keyOf = (node, t) => Object.keys(node).find(k => k.replace(/^x/i, '').toLowerCase() === t);
      const seqKey = keyOf(files[0].dict, '00081140');
      const item0 = files[0].dict[seqKey].Value[0];
      const nameKey = keyOf(item0, '00100010');
      const innerKey = keyOf(item0, '0040a170');
      const deepKey = keyOf(item0[innerKey].Value[0], '00080104');
      ok('the nested fixture loaded with a sequence inside a sequence',
         !!(seqKey && nameKey && innerKey && deepKey), [seqKey, nameKey, innerKey, deepKey].join('/'));

      pendingEdits.set(`${seqKey}/0/${nameKey}`, { vr: 'PN', valueString: 'Nested^Edited' });
      pendingEdits.set(`${seqKey}/0/${innerKey}/0/${deepKey}`, { vr: 'LO', valueString: 'Deeper^Edited' });

      const nestedFP = fingerprint(files[0].dict);
      const outMsg = DicomMessage.readFile(await buildEditedFile(files[0]).arrayBuffer());
      ok('a nested edit does not leak back into the loaded dataset',
         fingerprint(files[0].dict) === nestedFP, firstDiff(nestedFP, fingerprint(files[0].dict)));

      const outItem = lookupTag(outMsg.dict, '00081140').Value[0];
      ok('the nested edit reached the exported file',
         tag(outItem, '00100010') === 'Nested^Edited', tag(outItem, '00100010'));
      ok('and so did the one two levels down',
         tag(lookupTag(outItem, '0040a170').Value[0], '00080104') === 'Deeper^Edited',
         tag(lookupTag(outItem, '0040a170').Value[0], '00080104'));
      ok('the item that was not on the edit path came through untouched',
         tag(outItem, '00081150') === '1.2.840.10008.5.1.4.1.1.7', tag(outItem, '00081150'));
    }

    // ---- the exported tag list has to answer "why will this not render?" ----
    switchFile(0);
    const exported = getExportRows();
    ok('the tag export carries the Transfer Syntax UID',
       exported.some(r => r.tag === '(0002,0010)'),
       exported.filter(r => r.tag.startsWith('(0002')).length + ' File Meta rows');
    ok('and still carries the dataset',
       exported.some(r => r.tag === '(0010,0010)'), String(exported.length));
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
  pre.textContent = (await window.SUITES.edits()).join('\n');
  document.body.appendChild(pre);
});
