/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reports download as PDF or HTML files; nothing opens the print dialog. Every report button shows
// the report first (js/report-preview.js); the File PDF | HTML switch picks the file and Download
// writes it.
//
// The PDF is made by the fleet's shared engine (carino-pdf.js, CarinoPdf.pdf), which lays the report
// out at the paper's width, cuts it into A4 pages and draws each with html2canvas. What is worth
// holding here: the bytes are a PDF a reader can walk (every xref offset lands on its object), one
// picture per page, the HTML file is the previewed document itself, the preview's page lines never
// cut through a table row, and each of the three report buttons ends in a download named after the
// file, in the format the switch chose.
(window.SUITES || (window.SUITES = {})).pdf = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const $ = (id) => document.getElementById(id);
  const latin1 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return s; };
  const wait = async (cond, ms = 30000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 50)); return cond(); };

  const realSave = window.saveBlob;
  const saved = [];
  window.saveBlob = (blob, name) => saved.push({ blob, name });
  // Resolves with the next download, or null after ms.
  const nextSave = (ms = 30000) => new Promise(res => {
    const n = saved.length, t0 = Date.now();
    (function poll() { if (saved.length > n) res(saved[n]); else if (Date.now() - t0 > ms) res(null); else setTimeout(poll, 50); })();
  });

  try {
    ok('the shared PDF engine is loaded', !!window.CarinoPdf && typeof CarinoPdf.pdf === 'function');
    ok('the app no longer carries its own PDF writer',
       ['buildPdf', 'reportToPdf', 'pdfSpellOutText', 'pdfPageBreaks', 'pdfPageImage', 'carinoPdfDownload'].every(f => typeof window[f] === 'undefined'));

    // ---- a long report straight through carinoReportDownload ------------------
    const rows = Array.from({ length: 260 }, (_, i) =>
      `<tr><td class="c-tag">(0010,${String(i).padStart(4, '0')})</td><td class="c-desc">Row ${i}</td><td class="c-vr">PN</td><td>山田^太郎 · Иванов ${i}</td></tr>`).join('');
    const body = `<section class="tagsec"><h2>All DICOM tags — 260</h2><table class="tags">
      <thead><tr><th>Tag</th><th>Description</th><th>VR</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    const long = { title: 'DICOM Tag Dump', subtitle: 'test · 260 tags', meta: 'Carino DICOM Editor', body, fileBase: 'CT 患者 01' };
    const pending = nextSave();
    const res = await carinoReportDownload(long, 'pdf');
    const got = await pending;
    ok('a report becomes a download, not a print dialog', !!got && res.ok, res && res.error);
    if (got) {
      ok('the download is a PDF', got.blob.type === 'application/pdf', got.blob.type);
      ok('named after the file and the report: letters of any script kept, spaces made safe',
         got.name === 'CT-患者-01_DICOM-Tag-Dump.pdf', got.name);
      const bytes = new Uint8Array(await got.blob.arrayBuffer()), s = latin1(bytes);
      ok('starts with a PDF header and ends with %%EOF', s.startsWith('%PDF-1.4\n') && s.endsWith('%%EOF\n'), s.slice(0, 9));
      const count = +(s.match(/\/Type \/Pages \/Count (\d+)/) || [])[1];
      const images = (s.match(/\/Subtype \/Image/g) || []).length;
      ok('260 rows make several pages, one picture each', count >= 3 && images === count, `${count} pages, ${images} images`);
      const xrefAt = +s.match(/startxref\n(\d+)/)[1];
      const entries = s.slice(xrefAt).split('\n').slice(2).filter(l => / n $/.test(l)).map(l => +l.slice(0, 10));
      const bad = entries.map((o, i) => [i + 1, o]).filter(([n, o]) => !s.startsWith(`${n} 0 obj`, o));
      ok('every cross-reference offset lands on its object', entries.length === 3 + count * 3 && bad.length === 0,
         `${entries.length} entries; bad ${JSON.stringify(bad.slice(0, 3))}`);
      const w = +(s.match(/\/Subtype \/Image \/Width (\d+)/) || [])[1];
      ok('pages are drawn sharp enough to print', w >= 1300, `${w}px across`);
      ok('the page is A4', /\/MediaBox \[0 0 595\.2\d 841\.8\d\]/.test(s));
      ok('the title is stored as UTF-16, so any script survives', /\/Title <FEFF0044004900430/.test(s));
    }

    // ---- the same report as HTML: the previewed document itself -----------------
    {
      const p = nextSave();
      const r = await carinoReportDownload(long, 'html');
      const h = await p;
      ok('the HTML download is an HTML file named like the PDF', r.ok && h && h.name === 'CT-患者-01_DICOM-Tag-Dump.html' &&
         /^text\/html/.test(h.blob.type), h && h.name);
      const text = h ? await h.blob.text() : '';
      ok('and it is the report document byte for byte (no script, nothing fetched when opened)',
         text === carinoReportHtml(long) && !/<script/i.test(text));
    }

    // ---- the three buttons, on a loaded file -----------------------------------
    const n = Forge.W * Forge.H, px = new Uint16Array(n);
    for (let i = 0; i < n; i++) px[i] = i & 0xFFF;
    const base = { rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
      wc: 2048, ww: 4096, modality: 'CT', pixels: px,
      studyUID: '1.2.826.0.1.3680043.10.99999.9.1', seriesUID: '1.2.826.0.1.3680043.10.99999.9.2' };
    await handleFiles([
      new File([Forge.build({ ...base, instance: 1, sopInstance: '1.2.826.0.1.3680043.10.99999.9.3.1' })], 'first.dcm'),
      new File([Forge.build({ ...base, instance: 2, sopInstance: '1.2.826.0.1.3680043.10.99999.9.3.2' })], 'second.dcm'),
    ]);
    ok('two files load', files.length === 2, String(files.length));

    // A button opens the preview with nothing saved; the switch picks the file; Download saves it and
    // the preview stays open.
    const fmtBtn = f => $('rpFormat')?.querySelector(`[data-format="${f}"]`);
    const previewThenSave = async (label, click, want) => {
      const n0 = saved.length;
      click();
      await wait(() => !$('rpOverlay').hidden && !$('rpDownload').disabled, 20000);
      const fr = $('rpFrame').contentDocument;
      ok(`${label} opens the preview first, saving nothing`, !$('rpOverlay').hidden && saved.length === n0);
      ok(`${label}: the preview shows the report`, !!fr?.querySelector('header.ph h1'));
      ok(`${label}: the preview counts its pages`, /\d/.test($('rpStatus').textContent), $('rpStatus').textContent);
      // The preview's page lines never cut a row.
      const lines = [...fr.querySelectorAll('.rp-break')].map(l => l.getBoundingClientRect().top);
      const rowsAt = [...fr.querySelectorAll('tbody > tr')].map(tr => tr.getBoundingClientRect());
      const cut = lines.filter(y => rowsAt.some(r => r.top + 0.5 < y && y < r.bottom - 0.5));
      ok(`${label}: no page line runs through a row`, cut.length === 0, cut.join(','));

      fmtBtn('pdf').click();
      ok(`${label}: PDF names a .pdf and labels Download for it`,
         $('rpName').textContent === `${want}.pdf` && $('rpDownload').textContent === T('Download PDF'), $('rpName').textContent);
      let p = nextSave();
      $('rpDownload').click();
      ok(`${label}: Download is off while the PDF is made`, $('rpDownload').disabled && $('rpStatus').textContent === T('Creating the PDF…'),
         $('rpStatus').textContent);
      let r = await p;
      ok(`${label} downloads ${want}.pdf`, r && r.name === `${want}.pdf` && r.blob.type === 'application/pdf', r && r.name);
      await wait(() => !$('rpDownload').disabled, 5000);
      ok(`${label}: the preview stays open and Download comes back`, !$('rpOverlay').hidden && !$('rpDownload').disabled &&
         /\d/.test($('rpStatus').textContent), $('rpStatus').textContent);

      fmtBtn('html').click();
      ok(`${label}: HTML names a .html and labels Download for it`,
         $('rpName').textContent === `${want}.html` && $('rpDownload').textContent === T('Download HTML'), $('rpName').textContent);
      p = nextSave();
      $('rpDownload').click();
      r = await p;
      ok(`${label} downloads ${want}.html`, r && r.name === `${want}.html` && /^text\/html/.test(r.blob.type), r && r.name);
      fmtBtn('pdf').click();
      $('rpClose').click();
      ok(`${label}: ✕ closes the preview`, $('rpOverlay').hidden);
    };
    await previewThenSave('Export ▸ PDF', () => $('printTagsBtn').click(), 'first_DICOM-Tag-Dump');
    // The switch sits in the column above the file name, outside the scrolling options.
    const sw = $('rpFormat');
    ok('the File PDF | HTML switch sits just above the file name, outside the options',
       !!sw && sw.nextElementSibling === $('rpName') && !$('rpOpts').contains(sw) && sw.getAttribute('role') === 'radiogroup');
    ok('the actions are Print, then Download last',
       [...document.querySelectorAll('#rpOverlay .rpv-actions button')].map(b => b.id).join() === 'rpPrint,rpDownload');
    await previewThenSave('the Overview\'s PDF', () => $('ovPrintBtn').click(), 'first_DICOM-Study-Report');
    $('compareWith').value = '1';
    $('compareWith').dispatchEvent(new Event('change'));
    if (compareEntry()) {
      await previewThenSave('the Comparison report', () => $('cmpReport').click(), 'first_vs_second_DICOM-Comparison-Report');
    } else {
      ok('a comparison could be opened for the report button', false);
    }
    ok('no button reached the print dialog', !document.querySelector('iframe[aria-hidden="true"]'));
  } catch (e) {
    ok('the PDF suite ran', false, (e && e.stack) || String(e));
  } finally {
    window.saveBlob = realSave;
    try { closeReportPreview(); } catch (_) {}
  }
  return out;
};

// Two callers: tests/run.sh injects this file alone and scrapes the <pre> below;
// index.html#selftest sets window.SELFTEST and awaits the returned lines instead.
if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.pdf()).join('\n');
  document.body.appendChild(pre);
});
