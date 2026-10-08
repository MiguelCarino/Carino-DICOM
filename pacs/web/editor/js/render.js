// Rendering: branded print/PDF, file compare, the tag table and dataset walk/normalize helpers.
// ---- Branded print / PDF ----
// Shared Carino report layout. Self-contained (system fonts, inline CSS, logo as data URI) so it prints offline.
const _pesc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
let CARINO_LOGO_URI = '';
(function loadCarinoLogo() {
  try {
    fetch('logo.webp').then(r => r.ok ? r.blob() : null).then(b => {
      if (!b) return; const fr = new FileReader();
      fr.onload = () => { CARINO_LOGO_URI = fr.result; }; fr.readAsDataURL(b);
    }).catch(() => {});
  } catch (_) {}
})();

// Print a branded document around a body-HTML fragment.
function carinoBrandedPrint({ title, subtitle, meta, body }) {
  const logo = CARINO_LOGO_URI ? `<img class="ph-logo" src="${CARINO_LOGO_URI}" alt="Carino Systems">` : '';
  const metaHtml = meta ? `<div class="ph-meta">${meta}</div>` : '';
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${_pesc(title)}</title><style>
    :root{ --primary:#b45309; --ink:#1f2937; --muted:#6b7280; --border:#e5e7eb; }
    html{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    *{box-sizing:border-box;} body{font:12px/1.5 'IBM Plex Sans',-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);margin:24px;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .ph{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;border-bottom:2px solid var(--primary);padding-bottom:16px;margin-bottom:20px;}
    .ph h1{font-family:'Red Hat Display','IBM Plex Sans',sans-serif;font-weight:900;font-size:20px;letter-spacing:.01em;margin:0;color:var(--primary);}
    .ph-date{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--muted);margin:6px 0 0;}
    .ph-r{text-align:right;flex-shrink:0;}
    .ph-logo{height:52px;width:auto;display:inline-block;}
    .ph-meta{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:var(--muted);margin-top:8px;line-height:1.5;}
    .ov-shot{display:block;max-width:340px;max-height:340px;margin:0 auto 18px;border:1px solid var(--border);background:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    section{margin-bottom:16px;break-inside:avoid;}
    /* Long tag table must be allowed to flow across pages (else the whole
       break-inside:avoid section is pushed to page 2, leaving page 1 blank). */
    section.tagsec{break-inside:auto;}
    table.tags thead{display:table-header-group;} table.tags tr{break-inside:avoid;}
    h2{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--primary);border-bottom:1px solid var(--border);padding-bottom:5px;margin:0 0 8px;}
    table{width:100%;border-collapse:collapse;}
    th{text-align:left;font-weight:600;color:#374151;vertical-align:top;padding:3px 10px 3px 0;font-size:11px;word-break:break-word;}
    td{vertical-align:top;padding:3px 8px 3px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;word-break:break-word;color:var(--ink);}
    td.empty{color:#b8bcc4;}
    /* KV (label/value) sections */
    table.kv th{width:38%;}
    /* Full tag table */
    table.tags{margin-top:2px;} table.tags thead th{border-bottom:2px solid var(--border);text-transform:uppercase;letter-spacing:.05em;font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:9.5px;color:var(--muted);padding:5px 8px 5px 0;}
    table.tags tbody td{border-bottom:1px solid #f0f0f0;padding:3px 8px 3px 0;}
    table.tags .c-tag{white-space:nowrap;color:var(--primary);width:96px;}
    table.tags .c-vr{color:var(--muted);width:34px;text-align:center;}
    table.tags .c-desc{font-family:'IBM Plex Sans',sans-serif;color:#374151;}
    .ed{font-family:sans-serif;font-size:9px;color:#127a2f;border:1px solid #9ad3aa;border-radius:3px;padding:0 4px;margin-left:5px;}
    .ok{color:#127a2f;font-weight:600;} .valcounts{font-size:11px;color:var(--muted);margin:0 0 6px;}
    .valtable th{width:70px;text-transform:uppercase;font-size:10px;color:#a03000;}
    .adv{border:1px solid var(--border);border-left-width:4px;padding:8px 12px;margin:0 0 16px;font-size:11px;border-radius:4px;}
    .adv-info{border-left-color:#2b8fce;background:#eff8ff;} .adv-warn{border-left-color:#d99000;background:#fff8e8;} .adv-danger{border-left-color:#cc2b2b;background:#fdeeee;}
    footer{margin-top:22px;padding-top:8px;border-top:1px solid var(--border);font-size:10px;color:#9aa0a8;}
    @media print{body{margin:0;} @page{margin:15mm;}}
  </style></head><body>
    <header class="ph"><div class="ph-l"><h1>${_pesc(title)}</h1>${subtitle ? `<p class="ph-date">${_pesc(subtitle)}</p>` : ''}</div>
      <div class="ph-r">${logo}${metaHtml}</div></header>
    ${body}
    <footer>Generated locally by Carino Systems — no data left this device.</footer>
  </body></html>`;

  const ifr = document.createElement('iframe');
  ifr.setAttribute('aria-hidden', 'true');
  ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(ifr);
  const w = ifr.contentWindow, d = w.document;
  d.open(); d.write(doc); d.close();
  const cleanup = () => setTimeout(() => { try { ifr.remove(); } catch (_) {} }, 500);
  w.onafterprint = cleanup;
  const go = () => { try { w.focus(); w.print(); } catch (_) { cleanup(); } };
  const img = d.querySelector('img.ov-shot');
  if (img && !img.complete) { img.onload = go; img.onerror = go; }
  else setTimeout(go, 60);
}
window.carinoBrandedPrint = carinoBrandedPrint;

// Print every tag (meta + dataset, sequences walked) of the current file.
function printAllTags() {
  if (!dict) { if (window.toast) toast(T('Open a DICOM file first')); return; }
  const entries = flattenTags(tagsOf(files[currentFileIdx] || { dict, meta }));

  const rows = entries.map(({ path, tag, depth, el }) => {
    const vr = el.vr || vrForTag(tag) || '';
    const desc = descFor(tag) || 'Unknown tag';
    // pendingEdits holds every tag, so "edited" means the value differs from the loaded one.
    const orig = shownValue(path, el, null) ?? '';
    const val = pendingEdits.has(path) ? pendingEdits.get(path).valueString : orig;
    const edited = val !== orig;
    const v = val === '' ? '<span class="empty">—</span>' : _pesc(val);
    const pad = depth ? ` style="padding-left:${depth * 10}px"` : '';
    return `<tr><td class="c-tag"${pad}>${_pesc(fmtPath(path))}</td><td class="c-desc">${_pesc(desc)}</td><td class="c-vr">${_pesc(vr)}</td><td>${v}${edited ? '<span class="ed">edited</span>' : ''}</td></tr>`;
  }).join('');

  const fileName = files[currentFileIdx]?.name || 'DICOM file';
  const now = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = now.getFullYear() + '-' + p2(now.getMonth()+1) + '-' + p2(now.getDate()) + ' ' + p2(now.getHours()) + ':' + p2(now.getMinutes());
  const body = `<section class="tagsec"><h2>All DICOM tags — ${entries.length}</h2>
    <table class="tags"><thead><tr><th class="c-tag">Tag</th><th class="c-desc">Description</th><th class="c-vr">VR</th><th>Value</th></tr></thead>
    <tbody>${rows}</tbody></table></section>`;
  carinoBrandedPrint({ title: 'DICOM Tag Dump', subtitle: `${fileName} · ${entries.length} tags · generated ${stamp}`, meta: 'Carino DICOM Editor', body });
}
window.printAllTags = printAllTags;
$('printTagsBtn')?.addEventListener('click', printAllTags);

// ---- Compare ----
// The compared file, or null. Guarded because files[] is rebuilt when a new study is dropped.
function compareEntry() {
  if (compareIdx == null || compareIdx === currentFileIdx) return null;
  return files[compareIdx] || null;
}

function renderCompareStats(n) {
  const row = $('cmpStatRow');
  if (!row) return;
  row.innerHTML =
    `<span class="cmp-stat s-match">${n.match} ${T('match')}</span>` +
    `<span class="cmp-stat s-diff">${n.diff} ${T('differ')}</span>` +
    `<span class="cmp-stat s-only">${n.onlyA} ${T('only here')}</span>` +
    `<span class="cmp-stat s-only">${n.onlyB} ${T('only there')}</span>`;
}

// Thumbnail of the compared file.
async function drawCompareThumb() {
  const other = compareEntry();
  const cv = $('previewB');
  if (!other || !cv) return;
  try {
    const res = await decodeDicomPixels(other.dict, 0, { meta: other.meta });
    if (!res || res.error || !res.pixels) { cv.width = cv.height = 1; return; }
    cv.width = res.cols; cv.height = res.rows;
    const img = cv.getContext('2d').createImageData(res.cols, res.rows);
    img.data.set(res.pixels);
    cv.getContext('2d').putImageData(img, 0, 0);
  } catch (_) { cv.width = cv.height = 1; }
}

// Sync picker, bar, extra columns and thumbnail with compareIdx. Safe to call any time.
function renderCompareUI() {
  const sel = $('compareWith');
  const bar = $('cmpBar');
  if (!sel || !bar) return;

  if (compareIdx != null && (compareIdx === currentFileIdx || !files[compareIdx])) compareIdx = null;
  sel.classList.toggle('hidden', files.length < 2);

  sel.replaceChildren(new Option(T('Compare with…'), ''));
  files.forEach((f, i) => { if (i !== currentFileIdx) sel.appendChild(new Option(f.name, String(i))); });
  sel.value = compareIdx == null ? '' : String(compareIdx);

  const on = compareEntry() != null;
  bar.classList.toggle('hidden', !on);
  document.querySelectorAll('.cmp-col').forEach(el => el.classList.toggle('hidden', !on));

  const head  = $('cmpHeadB');
  const title = $('cmpBarTitle');
  if (head)  head.textContent = on ? files[compareIdx].name : '';
  if (title) title.textContent = on ? `${files[currentFileIdx]?.name || ''} ↔ ${files[compareIdx].name}` : '';
  $('cmpPreviews')?.classList.toggle('on', on);
  [['previewABadge', currentFileIdx], ['previewBBadge', compareIdx]].forEach(([id, i]) => {
    const badge = $(id);
    if (badge) badge.textContent = badge.title = on ? files[i]?.name || '' : '';
  });
  if (on) drawCompareThumb();
}

// Copy every differing top-level value one way; tags missing on the receiving side are created.
function cmpApplyAll(toOther) {
  const other = compareEntry();
  if (!other) return;
  const src = toOther ? { tags: tagsOf(files[currentFileIdx]), pend: pendingEdits }
                      : { tags: tagsOf(other), pend: pendingOf(other) };
  const dst = toOther ? { tags: tagsOf(other), pend: pendingOf(other) }
                      : { tags: tagsOf(files[currentFileIdx]), pend: pendingEdits };
  let n = 0;
  for (const [tag, el] of src.tags) {
    const vr = el.vr || '';
    if (isReadOnly(tag, vr)) continue;
    const from = shownValue(tag, el, src.pend);
    const to   = shownValue(tag, dst.tags.get(tag), dst.pend);
    if (from !== null && from !== to) { dst.pend.set(tag, { vr, valueString: from }); n++; }
  }
  if (!toOther) trackEditStart?.();
  renderTable();
  showDownload();
  toast?.(`${T('Copied')} ${n}`);
}

// Every tag of a file (File Meta + dataset), keyed as the file keys them. Dataset wins on collision.
function tagsOf(entry) {
  const isHex = t => t.startsWith('x') || /^[0-9a-f]{8}$/i.test(t);
  const m = new Map();
  if (!entry) return m;
  for (const [t, el] of Object.entries(entry.meta || {})) if (isHex(t)) m.set(t, el);
  for (const [t, el] of Object.entries(entry.dict || {})) if (isHex(t)) m.set(t, el);
  return m;
}

// The value a side shows: its edit, else the loaded value. null = tag absent (distinct from '').
function shownValue(tag, el, pend) {
  if (pend && pend.has(tag)) return pend.get(tag).valueString;
  if (!el) return null;
  // Compare sequences by item count; stringifying one yields only backslashes.
  if (el.vr === 'SQ') return String(seqItems(el).length);
  return elToString(el);
}

// One node per possible row (element or sequence-item header). Only open items are descended,
// except while filtering, when the whole tree is walked because a match may be nested.
function rowTree(mine, theirs, prefix, depth, filtering, oPend) {
  const nodes = [];
  const tags = [...new Set([...mine.keys(), ...theirs.keys()])].sort((a, b) => a.localeCompare(b));
  for (const tag of tags) {
    const elA = mine.get(tag), elB = theirs.get(tag);
    const path = prefix ? prefix + '/' + tag : tag;
    const vr = (elA || elB)?.vr || '';
    const node = { kind: 'el', path, tag, depth, elA, elB, vr, kids: [],
                   valA: shownValue(path, elA, pendingEdits),
                   valB: oPend ? shownValue(path, elB, oPend) : undefined };
    nodes.push(node);
    if (vr !== 'SQ') continue;
    const itemsA = seqItems(elA), itemsB = seqItems(elB);
    node.nItems = Math.max(itemsA.length, itemsB.length);
    if (!filtering && !seqOpen.has(path)) continue;
    for (let i = 0; i < node.nItems; i++) {
      const itemPath = path + '/' + i;
      const item = { kind: 'item', path: itemPath, tag, depth: depth + 1, index: i, of: node.nItems, kids: [] };
      node.kids.push(item);
      if (!filtering && !seqOpen.has(itemPath)) continue;
      item.kids = rowTree(itemMap(itemsA[i]), itemMap(itemsB[i]), itemPath, depth + 2, filtering, oPend);
    }
  }
  return nodes;
}

// Flatten depth-first to the rows that pass the filters. While filtering, item and sequence
// rows are kept as context for any matching descendant.
function pruneRows(nodes, hit, filtering, out = []) {
  for (const node of nodes) {
    const kids = pruneRows(node.kids, hit, filtering, []);
    if (!((node.kind === 'item' ? !filtering : hit(node)) || kids.length)) continue;
    out.push(node, ...kids);
  }
  return out;
}

// Sequences and items share one toggle and one open set.
function toggleSeq(path) {
  if (seqOpen.has(path)) seqOpen.delete(path); else seqOpen.add(path);
  renderTable();
}
function seqToggle(open, run) {
  const b = document.createElement('button');
  b.className = 'seq-toggle';
  b.textContent = open ? '▾' : '▸';
  b.title = T(open ? 'Collapse sequence' : 'Expand sequence');
  b.addEventListener('click', run);
  return b;
}
// Blank (not '0') when absent, so "no sequence" differs from "empty sequence".
function seqCount(el, T) {
  const s = document.createElement('span');
  s.className = 'seq-count';
  s.textContent = el ? String(seqItems(el).length) : '';
  s.title = T('Sequence items');
  return s;
}

// ---- Tag table ----

// A row's compare class; '' when not comparing.
function tableRowCmpClass(node, other) {
  if (!other) return '';
  if (node.valA !== null && node.valB !== null) return node.valA === node.valB ? 'cmp-match' : 'cmp-diff';
  return node.valA !== null ? 'cmp-only-a' : 'cmp-only-b';
}

// Tally the whole file before filtering, top level only (nested values cannot be copied across).
function tallyCompareRows(tree, other) {
  const tally = { match: 0, diff: 0, onlyA: 0, onlyB: 0 };
  if (other) for (const node of tree) {
    const c = tableRowCmpClass(node, other);
    tally[c === 'cmp-match' ? 'match' : c === 'cmp-diff' ? 'diff' : c === 'cmp-only-a' ? 'onlyA' : 'onlyB']++;
  }
  return tally;
}

// Category, differences-only and search filters for one row.
function tableRowHit(node, q, other) {
  if (activeCat !== 'all' && catFor(node.tag, node.vr) !== activeCat) return false;
  if (other && cmpDiffOnly && tableRowCmpClass(node, other) === 'cmp-match') return false;
  if (q && !`${fmtTag(node.tag)} ${descFor(node.tag) || ''} ${node.valA ?? ''} ${node.valB ?? ''}`.toLowerCase().includes(q)) return false;
  return true;
}

// Sequence item header row
function buildSeqItemRow(node, ctx) {
  const path = node.path;
  const tr = document.createElement('tr');
  tr.className = 'seq-item-row';
  tr.dataset.path = path;
  tr.innerHTML = `<td><div class="tag-cell"><span class="seq-item-badge"></span></div></td>
      <td><span class="desc-cell"></span></td>
      <td></td>
      <td></td>${ctx.other ? '<td></td><td></td>' : ''}`;
  const cell = tr.querySelector('.tag-cell');
  cell.style.paddingLeft = Math.min(node.depth, 4) * 14 + 'px';
  cell.prepend(seqToggle(ctx.filtering || seqOpen.has(path), () => toggleSeq(path)));
  tr.querySelector('.seq-item-badge').textContent = `${node.index + 1} / ${node.of}`;
  tr.querySelector('.desc-cell').textContent = T('Sequence item');
  return tr;
}

// Sequence row: item count and toggle, no value
function buildSeqRowCells(tr, node, ctx) {
  const path = node.path, elA = node.elA, elB = node.elB;
  const open = ctx.filtering || seqOpen.has(path);
  tr.querySelector('.tag-cell').prepend(seqToggle(open, () => {
    // Single-item sequences (typical code sequences) open their item too.
    if (!seqOpen.has(path) && seqItems(elA || elB).length === 1) seqOpen.add(path + '/0');
    toggleSeq(path);
  }));
  tr.children[3].appendChild(seqCount(elA, T));
  if (ctx.other) tr.children[4].appendChild(seqCount(elB, T));
}

// Mirror a window centre/width edit into the viewer controls.
function syncWindowFromEdit(path, value) {
  // Match the full path: a nested (0028,1050) is not the displayed window level.
  if (editKey('00281050') === path) { const v = parseFloat(value); if (!isNaN(v) && wcSlider) { wcSlider.value = v; if (wcNum) wcNum.value = Math.round(v); if (wcDisplay) wcDisplay.textContent = Math.round(v); } }
  if (editKey('00281051') === path) { const v = parseFloat(value); if (!isNaN(v) && wwSlider) { wwSlider.value = Math.max(1,v); if (wwNum) wwNum.value = Math.round(Math.max(1,v)); if (wwDisplay) wwDisplay.textContent = Math.round(Math.max(1,v)); } }
}

// This file's value input
function buildValueInputA(node, frozen, binary) {
  const path = node.path, vr = node.vr, valA = node.valA;
  const inp = document.createElement('input');
  inp.className = 'val-input' + (binary ? ' binary' : '');
  inp.value = valA ?? '';
  if (valA === null) inp.placeholder = '— not present —';
  inp.dataset.tag = path;
  inp.disabled = frozen || !node.elA;
  if (!inp.disabled) {
    inp.addEventListener('input', () => {
      trackEditStart?.();
      pendingEdits.set(path, { vr, valueString: inp.value });
      syncWindowFromEdit(path, inp.value);
      showDownload();
      if (files.length === 1 && dict) drawPreview(dict, currentFrame);
    });
  }
  return inp;
}

function cmpCopyBtn(label, title, run) {
  const b = document.createElement('button');
  b.className = 'cmp-copy-btn';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', run);
  return b;
}

// Compared file's value input plus the copy-across buttons.
function appendCompareCells(tr, node, ctx, frozen, binary) {
  const path = node.path, vr = node.vr, valA = node.valA, valB = node.valB, oPend = ctx.oPend;
  const inpB = document.createElement('input');
  inpB.className = 'val-input' + (binary ? ' binary' : '');
  inpB.value = valB ?? '';
  if (valB === null) inpB.placeholder = '— not present —';
  inpB.disabled = frozen || !node.elB;
  if (!inpB.disabled) {
    inpB.addEventListener('input', () => { oPend.set(path, { vr, valueString: inpB.value }); showDownload(); });
  }
  tr.children[4].appendChild(inpB);

  const acts = document.createElement('div');
  acts.className = 'cmp-actions-cell';
  if (!frozen && valA !== null) {
    acts.appendChild(cmpCopyBtn('→', 'Copy this value to the other file', () => {
      oPend.set(path, { vr, valueString: valA });
      renderTable(); showDownload();
    }));
  }
  if (!frozen && valB !== null) {
    acts.appendChild(cmpCopyBtn('←', 'Copy the other file\'s value to this one', () => {
      trackEditStart?.();
      pendingEdits.set(path, { vr, valueString: valB });
      renderTable(); showDownload();
      if (files.length === 1 && dict) drawPreview(dict, currentFrame);
    }));
  }
  tr.children[5].appendChild(acts);
}

// Element row: tag, description, VR, then value cells (or the sequence toggle).
function buildTagRow(node, ctx) {
  const other = ctx.other;
  const path = node.path, tag = node.tag, vr = node.vr;
  const desc = descFor(tag);
  const cat  = catFor(tag, vr);
  const ro   = isReadOnly(tag, vr);
  const cls  = tableRowCmpClass(node, other);

  const tr = document.createElement('tr');
  tr.className = [ro ? 'readonly-row' : '', cls].filter(Boolean).join(' ');
  tr.dataset.path = path;
  tr.innerHTML = `
      <td><div class="tag-cell"><span class="tag-cat" data-cat="${cat}"></span><span class="tag-code">${fmtTag(tag)}</span></div></td>
      <td><span class="${desc ? 'desc-cell' : 'desc-cell desc-unknown'}">${desc || 'Unknown tag'}</span></td>
      <td><span class="vr-badge">${vr}</span></td>
      <td></td>${other ? '<td></td><td></td>' : ''}`;
  tr.querySelector('.tag-cell').style.paddingLeft = Math.min(node.depth, 4) * 14 + 'px';

  if (vr === 'SQ') { buildSeqRowCells(tr, node, ctx); return tr; }

  const binary = (node.elA || node.elB)?.InlineBinary || isBinaryVR(vr);
  // While comparing, nested rows are read-only: copying them would need items the other side may lack.
  const frozen = ro || (other && node.depth > 0);
  tr.children[3].appendChild(buildValueInputA(node, frozen, binary));
  if (other) appendCompareCells(tr, node, ctx, frozen, binary);
  return tr;
}

// opts.datasetsUnchanged (search box / category filter only) skips the costly UID-pattern scan
// over every loaded file. Omitting it is always correct.
function renderTable(opts) {
  if (!dict) { tagBody.innerHTML = ''; return; }

  // Compare mode is this same table with a second value column.
  const other = compareEntry();
  const mine  = tagsOf(files[currentFileIdx] || { dict, meta });
  const theirs = tagsOf(other);
  const oPend = other ? pendingOf(other) : null;

  const q = searchQuery.toLowerCase();
  // Search and category filters must reach nested values, so they walk the whole tree.
  // Differences-only deliberately does not: it only filters the rows already enumerated.
  const filtering = q !== '' || activeCat !== 'all';
  const tree = rowTree(mine, theirs, '', 0, filtering, oPend);
  const tally = tallyCompareRows(tree, other);

  const ctx = { other, oPend, filtering };
  const rows = pruneRows(tree, node => tableRowHit(node, q, other), filtering)
    .map(node => node.kind === 'item' ? buildSeqItemRow(node, ctx) : buildTagRow(node, ctx));

  tagBody.replaceChildren(...rows);
  if (other) renderCompareStats(tally);
  showDownload();
  if (!opts?.datasetsUnchanged) detectUIDPattern();
}

function showDownload() {
  const has  = files.length > 0;
  const many = files.length > 1;
  // "Download All" only with 2+ files; the per-file button is primary while it is the only one.
  downloadAllBtn.classList.toggle('hidden', !many);
  const one = $('downloadOneBtn');
  one?.classList.toggle('hidden', !has);
  one?.classList.toggle('primary', has && !many);
  batchButtonsContainer.classList.toggle('hidden', !has || files.length <= 10);
  if (files.length > 10) rebuildBatch();
}

function rebuildBatch() {
  batchButtonsContainer.innerHTML = '';
  const n = files.length;
  const sz = n > 1000 ? 500 : n > 200 ? 100 : n > 50 ? 50 : 10;

  const lbl = document.createElement('span');
  lbl.style.cssText = 'font-size:11px;color:var(--text-muted);white-space:nowrap';
  lbl.textContent = T('Range:');

  const sel = document.createElement('select');
  sel.className = 'batch-select';
  for (let i = 0; i < n; i += sz) {
    const end = Math.min(i + sz, n);
    const opt = document.createElement('option');
    opt.value = `${i},${end}`;
    opt.textContent = `${i + 1}–${end}`;
    sel.appendChild(opt);
  }

  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = T('⬇ Range');
  btn.onclick = () => {
    const [s, e] = sel.value.split(',').map(Number);
    downloadRange(s, e);
  };

  batchButtonsContainer.appendChild(lbl);
  batchButtonsContainer.appendChild(sel);
  batchButtonsContainer.appendChild(btn);
}


// ---- Walk & normalize ----
function walkEls(node, fn) {
  if (!node || typeof node !== 'object') return;
  for (const [t, el] of Object.entries(node)) {
    if (!el || typeof el !== 'object') continue;
    fn(t, el, node);
    if (el.vr === 'SQ' && Array.isArray(el.Value)) {
      el.Value.forEach(item => walkEls(item, fn));
    }
  }
}

function b64ToAB(b) {
  b = b.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4;
  if (pad) b += '='.repeat(4 - pad);
  const bin = atob(b);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function normBin(node) {
  const bins = new Set(['OB','OW','OF','UN','OD','OL']);
  walkEls(node, (t, el) => {
    if (typeof el.InlineBinary === 'string') {
      try { el.Value = [b64ToAB(el.InlineBinary)]; delete el.InlineBinary; } catch (e) {}
    }
    const isPx = t.toLowerCase() === 'x7fe00010' || t === '7fe00010';
    if (isPx || bins.has(el.vr)) {
      let arr = el.Value || [];
      if (!Array.isArray(arr)) arr = [arr];
      const norm = arr.map(v =>
        v instanceof ArrayBuffer ? v :
        ArrayBuffer.isView(v) ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) :
        null
      ).filter(Boolean);
      // Write only if something changed: buildEditedBytes passes a shallow copy, so these element
      // objects belong to the open file, and a needless rewrite could drop values this map can't represent.
      if (!Array.isArray(el.Value) || norm.length !== el.Value.length ||
          norm.some((v, i) => v !== el.Value[i])) el.Value = norm;
    }
  });
}

function ensureMeta(denat, fm) {
  const m = fm && typeof fm === 'object' ? {...fm} : {};

  // Copy SOP Class/Instance UIDs into meta (0002,0002)/(0002,0003). Keys may be x-prefixed per dcmjs version.
  const sopC = (denat['00080016'] ?? denat['x00080016'])?.Value?.[0];
  const sopI = (denat['00080018'] ?? denat['x00080018'])?.Value?.[0];

  // DicomDict.write() reads meta by plain hex key only; camelCase keys are silently ignored.
  if (!(m['00020001'] ?? m.FileMetaInformationVersion))
    m['00020001'] = { vr:'OB', Value:[new Uint8Array([0,1]).buffer] };
  if (sopC) m['00020002'] = { vr:'UI', Value:[sopC] };
  if (sopI) m['00020003'] = { vr:'UI', Value:[sopI] };

  // dcmjs always writes Explicit VR Little Endian, so an uncompressed source syntax (e.g. Implicit VR)
  // must be rewritten to 1.2.840.10008.1.2.1 or readers misparse every tag offset.
  const tsEl = m['00020010'] ?? m.TransferSyntaxUID;
  const ts = (tsEl?.Value?.[0] ?? '').trim();
  const uncompressedTS = new Set(['', '1.2.840.10008.1.2', '1.2.840.10008.1.2.1',
                                   '1.2.840.10008.1.2.2', '1.2.840.10008.1.2.1.99']);
  if (uncompressedTS.has(ts)) {
    m['00020010'] = { vr:'UI', Value:['1.2.840.10008.1.2.1'] };
    delete m.TransferSyntaxUID; // remove any stale camelCase copy
  }
  if (!m['00020010'] && !m.TransferSyntaxUID)
    m['00020010'] = { vr:'UI', Value:['1.2.840.10008.1.2.1'] };
  if (!m['00020012'] && !m.ImplementationClassUID)
    m['00020012'] = { vr:'UI', Value:['1.2.826.0.1.3680043.10.743'] };

  return m;
}

