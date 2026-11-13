/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The change report: what a session did to the loaded files, source against output.
//
// What has to hold: a typed edit, an image action and an untouched file each land where they
// belong (tag differences, actions, the Unchanged list); the output side is what a download
// writes (its name and its bytes' hash); an undone action leaves the log; values that can name
// the patient can be hidden; and the Export menu's button goes through the preview, as every
// report does, before anything is saved.
(window.SUITES || (window.SUITES = {})).changes = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const $ = (id) => document.getElementById(id);
  const wait = async (cond, ms = 20000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 40)); return cond(); };
  const realSave = window.saveBlob;
  const saved = [];
  window.saveBlob = (blob, name) => saved.push({ blob, name });
  try {
    const n = Forge.W * Forge.H, px = new Uint16Array(n);
    for (let i = 0; i < n; i++) px[i] = i & 0xFFF;
    const base = { rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
      wc: 2048, ww: 4096, modality: 'CT', pixels: px,
      studyUID: '1.2.826.0.1.3680043.10.99999.7.1', seriesUID: '1.2.826.0.1.3680043.10.99999.7.2' };
    await handleFiles([
      new File([Forge.build({ ...base, instance: 1, sopInstance: '1.2.826.0.1.3680043.10.99999.7.3.1' })], 'first.dcm'),
      new File([Forge.build({ ...base, instance: 2, sopInstance: '1.2.826.0.1.3680043.10.99999.7.3.2' })], 'second.dcm'),
    ]);
    ok('two files load', files.length === 2, String(files.length));
    if (currentFileIdx !== 0) switchFile(0);
    const first = files[0];

    // A typed edit and an image action on the first file; the second is left alone.
    pendingOf(first).set('00100010', { vr: 'PN', valueString: 'Changed^Name' });
    $('imgInvert').click();
    $('imgRotCW').click();
    await wait(() => (first.changes || []).some(c => c.kind === 'pixel'));
    $('imgEditUndo').click();
    await wait(() => !(first.changes || []).some(c => c.kind === 'pixel'), 3000);

    const r = await buildChangeReport({ scope: 'all', originals: true });
    const doc = new DOMParser().parseFromString(`<body>${r.body}</body>`, 'text/html');
    const text = doc.body.textContent;
    ok('one of two files is changed', r.counts.files === 2 && r.counts.changed === 1, JSON.stringify(r.counts));
    ok('the source and the output file are named', /first\.dcm/.test(text) && /first\.edited\.dcm/.test(text));
    ok('the invert is listed as an action', /Inverted: \(0028,0004\)/.test(text));
    ok('an undone rotate is not', !/Rotate 90/.test(text));
    const rowOf = (tag) => [...doc.querySelectorAll('table.chg tbody tr')].find(tr => tr.cells[0].textContent === tag);
    const pn = rowOf('(0010,0010)'), pi = rowOf('(0028,0004)');
    ok('the typed Patient Name is a changed tag, before and after',
       pn && pn.cells[3].textContent === 'changed' && pn.cells[4].textContent === 'Forge^Test' && pn.cells[5].textContent === 'Changed^Name',
       pn && pn.textContent);
    ok('Photometric Interpretation reads MONOCHROME2 → MONOCHROME1',
       pi && pi.cells[4].textContent === 'MONOCHROME2' && pi.cells[5].textContent === 'MONOCHROME1', pi && pi.textContent);
    ok('the untouched file is in the Unchanged list', /Unchanged — 1/.test(text) && /second\.edited\.dcm/.test(text));
    // The output's hash is the hash of the bytes a download writes.
    const bytes = buildEditedBytes(first);
    const sha = await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    ok('the output SHA-256 is that of the file a download writes', text.includes(sha), sha);
    ok('and the source SHA-256 is that of the file as loaded', !!first.sha && text.includes(first.sha), first.sha);

    const hidden = await buildChangeReport({ scope: 'current', originals: false });
    const hd = new DOMParser().parseFromString(`<body>${hidden.body}</body>`, 'text/html');
    const hpn = [...hd.querySelectorAll('table.chg tbody tr')].find(tr => tr.cells[0].textContent === '(0010,0010)');
    const hpi = [...hd.querySelectorAll('table.chg tbody tr')].find(tr => tr.cells[0].textContent === '(0028,0004)');
    ok('hidden originals: the old Patient Name is not printed', hpn && hpn.cells[4].textContent === 'hidden' && !hd.body.textContent.includes('Forge^Test'));
    ok('but a value that names no one still is', hpi && hpi.cells[4].textContent === 'MONOCHROME2');
    ok('"This file only" reports one file', hidden.counts.files === 1 && hidden.fileBase === 'first', `${hidden.counts.files} ${hidden.fileBase}`);

    // The button: preview first, its options rebuild it, Download saves.
    const n0 = saved.length;
    $('changeReportBtn').click();
    await wait(() => !$('rpOverlay').hidden && !$('rpDownload').disabled);
    ok('Export ▸ Change report opens the preview, saving nothing', !$('rpOverlay').hidden && saved.length === n0);
    $('rpFormat')?.querySelector('[data-format="pdf"]')?.click();   // a visitor's remembered HTML choice aside
    ok('the preview offers the scope and the originals switch',
       $('rpOpts').querySelectorAll('input[type=radio]').length === 2 && $('rpOpts').querySelectorAll('input[type=checkbox]').length === 1);
    ok('named for all the files', $('rpName').textContent === 'dicom-edited_DICOM-Change-Report.pdf', $('rpName').textContent);
    ok('the preview frame shows the report', /DICOM Change Report/.test($('rpFrame').contentDocument?.body?.textContent || ''));
    $('rpOpts').querySelector('input[value=current]').click();
    await wait(() => $('rpName').textContent === 'first_DICOM-Change-Report.pdf' && !$('rpDownload').disabled);
    ok('choosing This file only rebuilds it for the one file', $('rpName').textContent === 'first_DICOM-Change-Report.pdf', $('rpName').textContent);
    $('rpDownload').click();
    await wait(() => saved.length > n0, 30000);
    const got = saved[n0];
    ok('Download saves the PDF the preview named', got && got.name === 'first_DICOM-Change-Report.pdf' && got.blob.type === 'application/pdf', got && got.name);
    await wait(() => !$('rpDownload').disabled, 5000);
    ok('and the preview stays open, ready again', !$('rpOverlay').hidden && !$('rpDownload').disabled);

    // Close drops it without saving.
    $('rpClose').click();
    ok('Close saves nothing', $('rpOverlay').hidden && saved.length === n0 + 1);
  } catch (e) {
    ok('the changes suite ran', false, (e && e.stack) || String(e));
  } finally {
    window.saveBlob = realSave;
    try { closeReportPreview(); } catch (_) {}
  }
  return out;
};

if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.changes()).join('\n');
  document.body.appendChild(pre);
});
