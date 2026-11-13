/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Change report: what this session did to the loaded files, as a PDF that names each source file and
// the file the download writes from it.
//
// Two records, kept apart on purpose. The actions (noteChange) are what the user asked for, in order:
// compress, rotate, redact, anonymize... They say why. The tag differences are what the written file
// actually differs from the one loaded: the source is read again from its File, the output is the
// bytes buildEditedBytes writes (the same bytes a download saves) read back. They are the evidence,
// and they hold whatever path an edit took (typed, Undo, a W/L drag, a swap, a UID root).

// ---- The action log ----
// kind groups an action with its undo: an undone rotate or redaction drops its own last entry,
// so the log never claims a change the file no longer has.
function noteChange(entry, kind, text) {
  if (!entry) return;
  (entry.changes || (entry.changes = [])).push({ kind, text, at: new Date() });
}
function unnoteChange(entry, kind) {
  const list = entry?.changes;
  if (!list) return;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].kind === kind) { list.splice(i, 1); return; }
}
function noteChangeAll(list, kind, text) { for (const f of list) noteChange(f, kind, text); }

// ---- Reading both sides ----
const CHG_TS_NAME = ts => (typeof TS_COMPRESSION !== 'undefined' && TS_COMPRESSION[ts]?.[0]) || ts || '—';
const chgVal = (d, tag) => String(getTag(d || {}, tag)?.Value?.[0] ?? '').replace(/[\0 ]+$/, '');

// The file as loaded, parsed as parseEntry parses it. null when there is no File behind the entry.
async function changeSource(entry) {
  if (!entry?.file) return null;
  const buf = await entry.file.arrayBuffer();
  const msg = DicomMessage.readFile(definedLengthUN(buf));
  normBin(msg.dict);
  if (metaTS(msg.meta) === '1.2.840.10008.1.2') fixImplicitSignedXS(msg.dict);
  if (!entry.sha) { try { entry.sha = await sha256Hex(buf); entry.shaState = 'done'; } catch (_) {} }
  return { dict: msg.dict, meta: msg.meta || {}, size: buf.byteLength, sha: entry.sha || null };
}

// The file a download writes, read back. { error } when it cannot be written.
async function changeOutput(entry) {
  let bytes;
  try { bytes = buildEditedBytes(entry); }
  catch (e) { return { error: (e && e.message) || String(e) }; }
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const msg = DicomMessage.readFile(buf);
  normBin(msg.dict);
  return { dict: msg.dict, meta: msg.meta || {}, size: buf.byteLength, sha: await sha256Hex(buf),
           name: entry.deid ? `${exportBaseName(entry)}.dcm` : `${exportBaseName(entry)}.edited.dcm` };
}

// File Meta that names the program that wrote the file, which every write sets to this editor.
const CHG_WRITER_META = new Set(['00020001', '00020012', '00020013', '00020016']);

// Every element of both sides (sequences walked, File Meta included), compared by path.
// Pixel Data is reported apart; group lengths are never written, so they are not differences.
function changeDiff(src, out) {
  const flat = side => {
    const m = new Map();
    for (const r of flattenTags(tagsOf({ dict: side.dict, meta: side.meta }))) {
      const leaf = leafTag(r.path).replace(/^x/, '').toUpperCase();
      if (leaf.slice(4) === '0000' || leaf === '7FE00010' || CHG_WRITER_META.has(leaf)) continue;
      m.set(r.path, r);
    }
    return m;
  };
  const a = flat(src), b = flat(out);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x.localeCompare(y));
  const rows = [];
  for (const path of paths) {
    const ra = a.get(path), rb = b.get(path);
    const va = ra ? shownValue(path, ra.el, null) : null, vb = rb ? shownValue(path, rb.el, null) : null;
    if (va === vb) continue;
    rows.push({ path, tag: (ra || rb).tag, vr: (rb || ra).el?.vr || '', before: va, after: vb,
                kind: va == null ? 'added' : vb == null ? 'removed' : 'changed' });
  }
  const px = side => binaryDigest(getTag(side.dict, '7FE00010')) || '';
  return { rows, pixels: px(src) === px(out) ? 'same' : (px(src) && px(out) ? 'changed' : px(out) ? 'added' : 'removed') };
}

// A value that can name the patient: any attribute the PS3.15 Basic Profile acts on, and private tags.
function changeIdentifying(path) {
  const leaf = leafTag(path).replace(/^x/, '').toUpperCase();
  if (parseInt(leaf.slice(0, 4), 16) % 2 === 1) return true;
  return !!window.DEID_PROFILE?.[leaf];
}

// ---- The report ----
const CHG_CSS = `<style>
  .chg-tally{display:flex;gap:18px;flex-wrap:wrap;font:600 12px ui-monospace,Menlo,Consolas,monospace;margin:0 0 6px;}
  .t-chg{color:#b45309;} .t-add{color:#127a2f;} .t-rem{color:#a03000;} .t-same{color:var(--muted);}
  table.io th{width:22%;} table.io thead th{color:var(--muted);font-size:10px;text-transform:uppercase;}
  table.io td{width:39%;}
  .fhead{font-family:'Red Hat Display','IBM Plex Sans',sans-serif;font-size:14px;font-weight:800;margin:20px 0 8px;color:var(--ink);word-break:break-all;}
  ol.acts{margin:0;padding-left:18px;font-size:11px;} ol.acts li{margin:0 0 2px;} ol.acts .at{font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--muted);margin-right:6px;}
  td.k-added{color:#127a2f;} td.k-removed{color:#a03000;} td.k-changed{color:#b45309;}
  table.tags.chg .c-kind{width:58px;font-family:'IBM Plex Sans',sans-serif;font-size:10px;}
  table.tags.chg .c-desc{width:22%;}
  .masked{color:#9aa0a8;font-family:'IBM Plex Sans',sans-serif;font-style:italic;}
  .err{color:#a03000;font-weight:600;}
</style>`;

const _chgSize = n => n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
const _chgTime = d => { const p = v => String(v).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const _chgStamp = (d = new Date()) => { const p = v => String(v).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const PIXEL_WORDS = { same: 'Unchanged', changed: 'Rewritten', added: 'Added', removed: 'Removed' };

// opts: { scope: 'all' | 'current', originals: bool (print values the output no longer has) }.
// onProgress(i, n) while files are read. -> { title, subtitle, meta, body, fileBase, counts }
async function buildChangeReport(opts = {}, onProgress) {
  const list = opts.scope === 'current' ? [files[currentFileIdx]].filter(Boolean) : files.slice();
  const showOld = opts.originals !== false;
  const perFile = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    let src = null, out = null, diff = null, error = null;
    try {
      src = await changeSource(entry);
      out = await changeOutput(entry);
      if (out.error) error = out.error;
      else if (src) diff = changeDiff(src, out);
    } catch (e) { error = (e && e.message) || String(e); }
    perFile.push({ entry, src, out, diff, error, acts: entry.changes || [] });
    onProgress?.(i + 1, list.length);
    if ((i & 7) === 7) await new Promise(r => setTimeout(r, 0));
  }

  const cell = (v, path, kind) => {
    if (v == null) return '<td class="empty">absent</td>';
    if (kind === 'before' && !showOld && changeIdentifying(path)) return '<td><span class="masked">hidden</span></td>';
    return v === '' ? '<td class="empty">—</td>' : `<td>${_pesc(v)}</td>`;
  };
  const changedFile = f => f.error || f.acts.length || (f.diff && (f.diff.rows.length || f.diff.pixels !== 'same'));
  const total = { files: perFile.length, changed: perFile.filter(changedFile).length, tags: 0, added: 0, removed: 0, changedTags: 0, pixels: 0, acts: 0 };
  for (const f of perFile) {
    total.acts += f.acts.length;
    if (!f.diff) continue;
    total.tags += f.diff.rows.length;
    for (const r of f.diff.rows) total[r.kind === 'changed' ? 'changedTags' : r.kind]++;
    if (f.diff.pixels !== 'same') total.pixels++;
  }

  const ioTable = f => {
    const s = f.src, o = f.out && !f.out.error ? f.out : null;
    const sop = side => side ? (chgVal(side.dict, '00080018') || '—') : '—';
    const row = (label, a, b) => `<tr><th>${label}</th><td>${a}</td><td>${b}</td></tr>`;
    // A de-identified file's source path and UIDs are often the patient's (DOE^JOHN_123/IM1).
    const hide = !showOld && f.entry.deid, masked = '<span class="masked">hidden</span>';
    const sopRow = hide ? masked : _pesc(sop(s));
    return `<table class="kv io"><thead><tr><th></th><th>Source</th><th>Output</th></tr></thead><tbody>
      ${row('File', hide ? masked : _pesc(f.entry.path || f.entry.name), o ? _pesc(o.name) : '<span class="err">not written</span>')}
      ${row('Size', _chgSize(s?.size ?? f.entry.size), o ? _chgSize(o.size) : '—')}
      ${row('SHA-256', s?.sha ? _pesc(s.sha) : '—', o ? _pesc(o.sha) : '—')}
      ${row('Transfer syntax', s ? _pesc(CHG_TS_NAME(metaTS(s.meta))) : '—', o ? _pesc(CHG_TS_NAME(metaTS(o.meta))) : '—')}
      ${row('SOP Instance UID', sopRow, o ? _pesc(sop(o)) : '—')}
      ${row('Pixel Data', f.diff ? 'As loaded' : '—', f.diff ? PIXEL_WORDS[f.diff.pixels] : '—')}
    </tbody></table>`;
  };

  const fileSection = f => {
    const name = f.entry.deid && !showOld ? (f.out?.name || f.entry.name) : (f.entry.path || f.entry.name);
    const acts = f.acts.length
      ? `<ol class="acts">${f.acts.map(a => `<li><span class="at">${_chgTime(a.at)}</span>${_pesc(a.text)}</li>`).join('')}</ol>`
      : '<p class="valcounts">No image or batch action. Any differences below are tag edits.</p>';
    let tags = '';
    if (f.error) tags = `<p class="err">${_pesc('The output could not be built: ' + f.error)}</p>`;
    else if (!f.src) tags = '<p class="valcounts">The source file is not available to read again, so tag differences cannot be listed.</p>';
    else if (!f.diff.rows.length) tags = '<p class="ok">✓ No tag differs between source and output.</p>';
    else tags = `<table class="tags chg"><thead><tr><th class="c-tag">Tag</th><th class="c-desc">Description</th><th class="c-vr">VR</th><th class="c-kind">Change</th><th>Before</th><th>After</th></tr></thead><tbody>${
      f.diff.rows.map(r => `<tr><td class="c-tag">${_pesc(fmtPath(r.path))}</td><td class="c-desc">${_pesc(descFor(r.tag) || 'Unknown tag')}</td>` +
        `<td class="c-vr">${_pesc(r.vr)}</td><td class="c-kind k-${r.kind}">${r.kind}</td>${cell(r.before, r.path, 'before')}${cell(r.after, r.path, 'after')}</tr>`).join('')
    }</tbody></table>`;
    return `<div class="fhead">${_pesc(name)}</div>
      <section>${ioTable(f)}</section>
      <section><h2>Actions — ${f.acts.length}</h2>${acts}</section>
      <section class="tagsec"><h2>Tag differences — ${f.diff ? f.diff.rows.length : 0}</h2>${tags}</section>`;
  };

  const changed = perFile.filter(changedFile), same = perFile.filter(f => !changedFile(f));
  const sameList = same.length ? `<section class="tagsec"><h2>Unchanged — ${same.length}</h2>
    <p class="valcounts">These files are written with no tag, pixel or action difference from their source (the File Meta naming the writing program aside, which every write sets).</p>
    <table class="tags"><thead><tr><th>Source</th><th>Output</th></tr></thead><tbody>${
      same.map(f => `<tr><td>${!showOld && f.entry.deid ? '<span class="masked">hidden</span>' : _pesc(f.entry.path || f.entry.name)}</td><td>${_pesc(f.out?.name || '—')}</td></tr>`).join('')}</tbody></table></section>` : '';
  const body = `${CHG_CSS}
    <section><h2>Summary</h2>
      <p class="chg-tally"><span class="t-chg">${total.changed} of ${total.files} file(s) changed</span>
        <span class="t-chg">${total.changedTags} tag(s) changed</span><span class="t-add">${total.added} added</span>
        <span class="t-rem">${total.removed} removed</span><span class="t-same">${total.pixels} with new pixel data</span>
        <span class="t-same">${total.acts} action(s)</span></p>
      <p class="valcounts">Source: each file as it was loaded, read again. Output: the file a download writes now, with every edit of this session, read back. Actions are listed in the order they were taken; the tag differences are what the two files actually differ by (File Meta naming the writing program is left out).${
        showOld ? '' : ' Values the output no longer carries that can identify a patient are hidden.'}</p>
    </section>
    ${changed.map(fileSection).join('')}
    ${sameList}`;

  const first = list[0];
  const what = list.length === 1 ? (first.deid && !showOld ? perFile[0].out?.name || first.name : first.name) : `${list.length} files`;
  return { title: 'DICOM Change Report', subtitle: `${what} · generated ${_chgStamp()}`, meta: 'Carino DICOM Editor', body,
           fileBase: list.length === 1 ? exportBaseName(first) : 'dicom-edited', counts: total };
}

// The Export menu's Change report: a preview with its two questions, then the PDF on Download.
function openChangeReport() {
  if (!files.length) { if (window.toast) toast(T('Open a DICOM file first')); return; }
  const anyDeid = files.some(f => f.deid);
  openReportPreview({
    options: [
      ...(files.length > 1 ? [{ id: 'scope', type: 'radio', label: 'Files', value: 'all',
        choices: [['all', 'All loaded files'], ['current', 'This file only']] }] : []),
      { id: 'originals', type: 'check', label: 'Show the values before each change (may name the patient)', value: !anyDeid },
    ],
    build: (o, progress) => buildChangeReport({ scope: o.scope || 'all', originals: !!o.originals }, progress),
  });
}
window.openChangeReport = openChangeReport;
window.buildChangeReport = buildChangeReport;
$('changeReportBtn')?.addEventListener('click', () => { $('exportMenu')?.removeAttribute('open'); openChangeReport(); });
