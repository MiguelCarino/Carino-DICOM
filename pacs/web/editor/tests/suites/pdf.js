// Reports download as PDF files; nothing opens the print dialog.
//
// carinoBrandedPrint lays a report out at the PDF's width, cuts it into A4 pages,
// draws each with html2canvas and writes the PDF itself. What is worth holding:
// the bytes are a PDF a reader can walk (every xref offset lands on its object),
// one picture per page, page ends that never cut through a table row, and each
// of the three report buttons ending in a download named after the file.
(window.SUITES || (window.SUITES = {})).pdf = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const $ = (id) => document.getElementById(id);
  const latin1 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return s; };

  const realSave = window.saveBlob, realBreaks = window.pdfPageBreaks, realToast = window.toast;
  const saved = [], toasts = [];
  let lastBreaks = null;
  window.saveBlob = (blob, name) => saved.push({ blob, name });
  window.toast = (msg, ms) => { toasts.push(String(msg)); return realToast(msg, ms); };
  // Keep each layout's page ends and the rows they were chosen among, to check them against each other.
  window.pdfPageBreaks = (d) => {
    const breaks = realBreaks(d);
    const rows = [...d.querySelectorAll('tbody > tr')].map(tr => tr.getBoundingClientRect());
    lastBreaks = { breaks, rows };
    return breaks;
  };
  // Resolves with the next download, or null after ms.
  const nextSave = (ms = 20000) => new Promise(res => {
    const n = saved.length, t0 = Date.now();
    (function poll() { if (saved.length > n) res(saved[n]); else if (Date.now() - t0 > ms) res(null); else setTimeout(poll, 50); })();
  });

  try {
    // ---- a long report straight through carinoBrandedPrint ----------------------
    const rows = Array.from({ length: 260 }, (_, i) =>
      `<tr><td class="c-tag">(0010,${String(i).padStart(4, '0')})</td><td class="c-desc">Row ${i}</td><td class="c-vr">PN</td><td>山田^太郎 · Иванов ${i}</td></tr>`).join('');
    const body = `<section class="tagsec"><h2>All DICOM tags — 260</h2><table class="tags">
      <thead><tr><th>Tag</th><th>Description</th><th>VR</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    const pending = nextSave();
    await carinoBrandedPrint({ title: 'DICOM Tag Dump', subtitle: 'test · 260 tags', meta: 'Carino DICOM Editor', body, fileBase: 'CT 患者 01' });
    const got = await pending;
    ok('a report becomes a download, not a print dialog', !!got, toasts.join(' | '));
    if (got) {
      ok('the download is a PDF', got.blob.type === 'application/pdf', got.blob.type);
      ok('named after the file and the report: letters of any script kept, spaces made safe',
         got.name === 'CT-患者-01_DICOM-Tag-Dump.pdf', got.name);
      const bytes = new Uint8Array(await got.blob.arrayBuffer()), s = latin1(bytes);
      ok('starts with a PDF header and ends with %%EOF', s.startsWith('%PDF-1.4\n') && s.endsWith('%%EOF\n'), s.slice(0, 9));
      const count = +(s.match(/\/Type \/Pages \/Count (\d+)/) || [])[1];
      const images = (s.match(/\/Subtype \/Image/g) || []).length;
      ok('260 rows make several pages, one picture each', count >= 3 && images === count, `${count} pages, ${images} images`);
      // Every in-use xref entry must point at "<n> 0 obj", or a reader has to rebuild the table.
      const xrefAt = +s.match(/startxref\n(\d+)/)[1];
      const entries = s.slice(xrefAt).split('\n').slice(2).filter(l => / n $/.test(l)).map(l => +l.slice(0, 10));
      const bad = entries.map((o, i) => [i + 1, o]).filter(([n, o]) => !s.startsWith(`${n} 0 obj`, o));
      ok('every cross-reference offset lands on its object', entries.length === 3 + count * 3 && bad.length === 0,
         `${entries.length} entries; bad ${JSON.stringify(bad.slice(0, 3))}`);
      // Pages are drawn at the layout's own scale: about 190 dpi across 180 mm.
      const w = +(s.match(/\/Subtype \/Image \/Width (\d+)/) || [])[1];
      ok('pages are drawn sharp enough to print', w >= 1300, `${w}px across`);
      ok('the title is stored as UTF-16, so any script survives', /\/Title <FEFF0044004900430/.test(s));
    }
    if (lastBreaks) {
      const { breaks, rows: rects } = lastBreaks;
      const inner = breaks.slice(1, -1);
      const cut = inner.filter(b => rects.some(r => r.top + 0.5 < b && b < r.bottom - 0.5));
      ok('no page ends in the middle of a row', inner.length >= 2 && cut.length === 0, `breaks ${inner.join(',')}; cut ${cut.join(',')}`);
      const tall = breaks.slice(1).map((b, i) => b - breaks[i]).filter(h => h > PDF_CSS_H);
      ok('no page is taller than A4 allows', tall.length === 0, tall.join(','));
    }
    ok('no error toast', !toasts.some(t => t.startsWith(T('Could not create the PDF:'))), toasts.join(' | '));

    // ---- text html2canvas would draw differently from the layout ---------------
    // A hash wrapped by word-break is drawn as one line off the page unless the wrap is spelled
    // out; ui-monospace lays out in SF Mono but a canvas cannot name it; CSS capitals with letter
    // spacing overlap. pdfSpellOutText must fix all three without moving anything.
    {
      const hash = '2db2e50cce7e8ae2de2a43bfd93ddc38013f30cd230b9d925196401a0d35fc75';
      const ifr = document.createElement('iframe');
      ifr.style.cssText = 'position:fixed;left:-900px;top:0;width:300px;height:300px;border:0';
      document.body.appendChild(ifr);
      try {
        const d = ifr.contentDocument;
        d.open();
        d.write(`<!DOCTYPE html><body style="margin:0"><p id="h" style="width:150px;font:11px ui-monospace,Menlo,monospace;word-break:break-word">${hash}</p>
          <h2 id="u" style="text-transform:uppercase;letter-spacing:.07em">Clinical</h2></body>`);
        d.close();
        const lines = () => { const r = d.createRange(); r.selectNodeContents(d.getElementById('h')); return new Set([...r.getClientRects()].map(x => Math.round(x.top))).size; };
        const before = lines(), height = d.body.scrollHeight;
        pdfSpellOutText(d);
        const p = d.getElementById('h');
        const spaces = (p.textContent.match(/​/g) || []).length;
        ok('a wrapped hash gets one break per wrap, and only those', before >= 2 && spaces === before - 1,
           `${before} lines, ${spaces} breaks`);
        ok('the hash itself is unchanged', p.textContent.replace(/​/g, '') === hash);
        ok('and the layout did not move', lines() === before && d.body.scrollHeight === height, `${height} → ${d.body.scrollHeight}`);
        ok('font stacks lose the keywords a canvas cannot name', !/ui-monospace/.test(getComputedStyle(p).fontFamily) && /Menlo/.test(p.style.fontFamily),
           d.defaultView.getComputedStyle(p).fontFamily);
        ok('CSS capitals become typed capitals', d.getElementById('u').textContent === 'CLINICAL' &&
           d.getElementById('u').style.textTransform === 'none', d.getElementById('u').textContent);
      } finally { ifr.remove(); }
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

    for (const [label, click, want] of [
      ['Export ▸ PDF', () => $('printTagsBtn').click(), 'first_DICOM-Tag-Dump.pdf'],
      ['the Overview\'s PDF', () => $('ovPrintBtn').click(), 'first_DICOM-Study-Report.pdf'],
    ]) {
      const p = nextSave();
      click();
      const r = await p;
      ok(`${label} downloads ${want}`, r && r.name === want && r.blob.type === 'application/pdf', r && r.name);
    }
    $('compareWith').value = '1';
    $('compareWith').dispatchEvent(new Event('change'));
    if (compareEntry()) {
      const p = nextSave();
      $('cmpReport').click();
      const r = await p;
      ok('the Comparison report downloads first_vs_second_DICOM-Comparison-Report.pdf',
         r && r.name === 'first_vs_second_DICOM-Comparison-Report.pdf', r && r.name);
    } else {
      ok('a comparison could be opened for the report button', false);
    }
    ok('no button reached the print dialog', !document.querySelector('iframe[aria-hidden="true"]'));
  } catch (e) {
    ok('the PDF suite ran', false, (e && e.stack) || String(e));
  } finally {
    window.saveBlob = realSave; window.pdfPageBreaks = realBreaks; window.toast = realToast;
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
