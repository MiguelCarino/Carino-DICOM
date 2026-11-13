/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Report preview: every report is shown before it is written, as Topo's report dialog does.
// The frame holds the very document the file is made from (carinoReportHtml), laid out at the
// paper's printable width on a sheet with its margins (REPORT_PAGE, the report's own @page rule),
// with a dashed line where each PDF page will end. The switch above the file name picks the
// file, PDF or HTML (CarinoPdf.formatSwitch, remembered for this site); Download writes it from
// the report as previewed and the dialog stays open. ✕, Esc and the backdrop close it, saving nothing.
//
// cfg: { build(values, progress) -> report opts | Promise, options?: [{ id, type: 'check'|'radio',
// label, value, choices?: [[value, label]] }] }. A change to an option builds the report again.
const RP_MM_PX = 96 / 25.4;                                                  // CSS px per mm
const RP_CSS_W = (REPORT_PAGE.w - 2 * REPORT_PAGE.margin) * RP_MM_PX;        // the printable width
const RP_CSS_H = (REPORT_PAGE.h - 2 * REPORT_PAGE.margin) * RP_MM_PX;        // one page's content height
const RP_MARGIN_PX = Math.round(REPORT_PAGE.margin * RP_MM_PX);              // the sheet's margin
const RP_PAGE_PX = Math.ceil(RP_CSS_W) + 2 * RP_MARGIN_PX + 32;              // the sheet and the grey around it
const _rp = { seq: 0, cfg: null, values: {}, built: null, back: null, pages: 0, busy: false, sw: null };

function rpStatus(text) { const el = $('rpStatus'); if (el) el.textContent = text || ''; }
function rpPagesText() { return _rp.pages ? TF(_rp.pages === 1 ? '1 page' : '{n} pages', { n: _rp.pages }) : ''; }

// The chosen format: the switch's, or the one remembered when the switch is not drawn yet.
function rpFormat() {
  if (_rp.sw) return _rp.sw.get();
  return (window.CarinoPdf && CarinoPdf.remembered && CarinoPdf.remembered()) || 'pdf';
}

// File  PDF | HTML, just above the file name and outside the scrolling options. Made on the first
// open: carino-pdf.js loads deferred, after this script.
function rpEnsureSwitch() {
  if (_rp.sw || !window.CarinoPdf || !$('rpName')) return;
  _rp.sw = CarinoPdf.formatSwitch({ onChange: rpShowFormat });
  _rp.sw.el.id = 'rpFormat';
  $('rpName').before(_rp.sw.el);
}

// The file name and the Download label follow the switch.
function rpShowFormat() {
  const fmt = rpFormat();
  const dl = $('rpDownload');
  if (dl) dl.textContent = window.CarinoPdf ? CarinoPdf.label(fmt) : T(fmt === 'html' ? 'Download HTML' : 'Download PDF');
  $('rpName').textContent = _rp.built ? reportFileName(_rp.built, fmt) : '';
}

function rpRenderOptions() {
  const box = $('rpOpts');
  if (!box) return;
  const opts = _rp.cfg?.options || [];
  box.hidden = !opts.length;
  box.replaceChildren(...opts.map(o => {
    const wrap = document.createElement(o.type === 'radio' ? 'fieldset' : 'label');
    if (o.type === 'radio') {
      const lg = document.createElement('legend');
      lg.textContent = T(o.label);
      wrap.append(lg, ...o.choices.map(([v, l]) => {
        const lab = document.createElement('label');
        const r = document.createElement('input');
        r.type = 'radio'; r.name = 'rp-' + o.id; r.value = v; r.checked = _rp.values[o.id] === v;
        r.addEventListener('change', () => { if (r.checked) { _rp.values[o.id] = v; rpRefresh(); } });
        const s = document.createElement('span'); s.textContent = T(l);
        lab.append(r, s);
        return lab;
      }));
    } else {
      const c = document.createElement('input');
      c.type = 'checkbox'; c.checked = !!_rp.values[o.id];
      c.addEventListener('change', () => { _rp.values[o.id] = c.checked; rpRefresh(); });
      const s = document.createElement('span'); s.textContent = T(o.label);
      wrap.append(c, s);
    }
    return wrap;
  }));
}

// A stage narrower than a sheet shows the sheet scaled down, as it will print, rather than the
// report reflowed to a phone's width. Only the frame element is scaled.
function rpFit() {
  const frame = $('rpFrame'), stage = $('rpStage');
  if (!frame || !stage) return;
  Object.assign(frame.style, { width: '', height: '', transform: '' });
  const w = stage.clientWidth;
  if (!w || w >= RP_PAGE_PX) return;
  const k = w / RP_PAGE_PX;
  Object.assign(frame.style, { width: `${RP_PAGE_PX}px`, height: `${Math.round(stage.clientHeight / k)}px`,
                               transform: `scale(${k})`, transformOrigin: '0 0' });
}

// The sheet around the report, for the screen only: printing from the preview leaves the page to the
// report's own @page rule, so its margins are not doubled.
function rpPreviewHtml(html) {
  const fonts = new URL('fonts/carino-fonts.css', document.baseURI).href;
  const css = `<link rel="stylesheet" href="${_pesc(fonts)}"><style>
    html{background:#d6d8dc;}
    body{box-sizing:content-box;width:${RP_CSS_W.toFixed(2)}px;padding:${RP_MARGIN_PX}px;margin:16px auto 24px;position:relative;box-shadow:0 1px 6px rgba(0,0,0,.28);}
    .rp-break{position:absolute;left:0;right:0;height:0;border-top:1.5px dashed #9aa0a8;pointer-events:none;}
    .rp-break span{position:absolute;left:8px;top:3px;font:10px 'IBM Plex Mono',monospace;color:#6b7280;}
    @media print{html{background:#fff;}body{margin:0;padding:0;width:auto;box-shadow:none;}.rp-break{display:none!important;}}
  </style></head>`;
  return html.replace('</head>', css);
}

// Where the PDF's pages end, in CSS px from the top of the report's content, from a measure of the
// laid-out sheet ({ ends, keeps, forced } in document px) whose content starts at top0 and is
// height tall. The cut itself is CarinoPdf.pageBreaks, the PDF's own rule.
function rpPageCuts(m, top0, height, pageH) {
  const shift = v => v - top0;
  return CarinoPdf.pageBreaks(m.ends.map(shift), m.keeps.map(k => [shift(k[0]), shift(k[1])]),
                              m.forced.map(shift), height, pageH || RP_CSS_H);
}

// The sheet measured as the PDF measures it. CarinoPdf.measure/spellOut are used when the shared
// engine exposes them; until then the same rules, for the elements these reports are made of.
function rpMeasure(d) {
  if (typeof CarinoPdf.spellOut === 'function') CarinoPdf.spellOut(d);
  if (typeof CarinoPdf.measure === 'function') return CarinoPdf.measure(d);
  const view = d.defaultView, sy = view.scrollY || 0;
  const ends = [], keeps = [], forced = [];
  for (const el of d.body.querySelectorAll('header, section, table, thead, tbody, tr, p, div, img, footer, h1, h2, h3')) {
    const r = el.getBoundingClientRect();
    if (!r.height || el.classList.contains('rp-break')) continue;
    const top = r.top + sy, bottom = r.bottom + sy, cs = view.getComputedStyle(el);
    const heading = /^(H[1-6]|THEAD)$/.test(el.tagName);
    if (!heading) ends.push(bottom);
    if (/avoid/.test(cs.breakInside) || el.matches('tr, img')) keeps.push([top, bottom]);
    if (/^H[1-6]$/.test(el.tagName)) {
      const next = el.nextElementSibling;
      keeps.push([top, Math.max(bottom, next ? Math.min(next.getBoundingClientRect().bottom + sy, top + 120) : bottom)]);
    }
    if (/page|always/.test(cs.breakBefore)) forced.push(top);
    if (/page|always/.test(cs.breakAfter)) forced.push(bottom);
  }
  return { ends, keeps, forced };
}

async function rpRefresh() {
  const seq = ++_rp.seq;
  const frame = $('rpFrame');
  $('rpDownload').disabled = true;
  if ($('rpPrint')) $('rpPrint').disabled = true;
  rpStatus(T('Preparing the report…'));
  let opts;
  try {
    opts = await _rp.cfg.build({ ..._rp.values }, (i, n) => { if (seq === _rp.seq) rpStatus(TF('Reading files… {i} / {n}', { i, n })); });
  } catch (e) {
    console.error(e);
    if (seq === _rp.seq) rpStatus(T('Could not build the report.'));
    return;
  }
  if (seq !== _rp.seq || !_rp.cfg) return;
  _rp.built = opts;
  rpShowFormat();
  await new Promise(done => {
    const shown = () => { frame.onload = null; done(); };
    frame.onload = shown;
    setTimeout(shown, 5000);   // a frame that never says it loaded
    frame.srcdoc = rpPreviewHtml(carinoReportHtml(opts));
  });
  if (seq !== _rp.seq) return;
  _rp.pages = 0;
  try {
    const d = frame.contentDocument;
    if (d.fonts) await d.fonts.ready;
    await Promise.all([...d.images].map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; })));
    if (seq !== _rp.seq) return;
    const r = d.body.getBoundingClientRect(), sy = d.defaultView.scrollY || 0;
    const breaks = rpPageCuts(rpMeasure(d), r.top + sy + RP_MARGIN_PX, r.height - 2 * RP_MARGIN_PX);
    _rp.pages = breaks.length - 1;
    breaks.slice(1, -1).forEach((b, i) => {
      const line = d.createElement('div');
      line.className = 'rp-break';
      line.style.top = `${RP_MARGIN_PX + b}px`;
      const tag = d.createElement('span');
      tag.textContent = TF('Page {n}', { n: i + 2 });
      line.append(tag);
      d.body.append(line);
    });
  } catch (e) { console.warn('Report preview: could not measure the pages.', e); }
  rpFit();
  rpStatus(rpPagesText());
  try { frame.contentDocument.addEventListener('keydown', rpKey); } catch (_) {}   // Esc with focus in the sheet
  $('rpDownload').disabled = false;
  if ($('rpPrint')) $('rpPrint').disabled = false;
}

function openReportPreview(cfg) {
  const ov = $('rpOverlay');
  if (!ov) return Promise.resolve(cfg.build({})).then(o => carinoReportDownload(o));   // a page without the dialog writes straight away
  _rp.cfg = cfg; _rp.built = null; _rp.values = {}; _rp.pages = 0; _rp.busy = false;
  (cfg.options || []).forEach(o => { _rp.values[o.id] = o.value; });
  _rp.back = document.activeElement;
  rpEnsureSwitch();
  rpRenderOptions();
  rpShowFormat();
  ov.hidden = false;
  document.addEventListener('keydown', rpKey);
  $('rpClose')?.focus();
  return rpRefresh();
}

function closeReportPreview() {
  _rp.seq++; _rp.cfg = null; _rp.built = null; _rp.pages = 0;
  const ov = $('rpOverlay');
  if (ov) ov.hidden = true;
  const frame = $('rpFrame');
  if (frame) { frame.onload = null; frame.removeAttribute('srcdoc'); }
  document.removeEventListener('keydown', rpKey);
  try { _rp.back?.focus(); } catch (_) {}
}
function rpKey(e) { if (e.key === 'Escape') closeReportPreview(); }

// Download writes the chosen file from the report as previewed. While a PDF is drawn the button is
// off and the status says so; the dialog stays open, and the page count comes back after.
async function rpDownload() {
  const opts = _rp.built, seq = _rp.seq;
  if (!opts || _rp.busy) return;
  const fmt = rpFormat(), name = reportFileName(opts, fmt);
  const dl = $('rpDownload');
  _rp.busy = true;
  dl.disabled = true;
  if (fmt === 'pdf') rpStatus(T('Creating the PDF…'));
  let failed = false;
  try {
    const blob = await carinoReportFile(opts, fmt);
    if (seq === _rp.seq) saveBlob(blob, name);     // closed meanwhile: save nothing
  } catch (e) {
    console.error(e);
    failed = true;
  }
  _rp.busy = false;
  if (seq !== _rp.seq) return;
  dl.disabled = false;
  rpStatus(failed ? T(fmt === 'pdf' ? 'Could not create the PDF.' : 'Could not create the file.') : rpPagesText());
}

// Print prints the sheet in the frame, the same document the file is made from; the dialog stays open.
function rpPrint() {
  const w = $('rpFrame')?.contentWindow;
  if (!_rp.built || !w) return;
  w.focus();
  w.print();
  $('rpPrint')?.focus();
}

$('rpClose')?.addEventListener('click', closeReportPreview);
$('rpPrint')?.addEventListener('click', rpPrint);
$('rpDownload')?.addEventListener('click', rpDownload);
$('rpOverlay')?.addEventListener('click', e => { if (e.target.id === 'rpOverlay') closeReportPreview(); });
window.addEventListener('resize', () => { if (_rp.cfg) rpFit(); });
window.addEventListener('carino:langchange', () => {
  _rp.sw?.relabel();
  rpShowFormat();
  if (_rp.cfg) { rpRenderOptions(); if (!_rp.busy && $('rpStatus')?.textContent) rpStatus(rpPagesText()); }
});
window.openReportPreview = openReportPreview;
window.closeReportPreview = closeReportPreview;
window.rpPageCuts = rpPageCuts;
