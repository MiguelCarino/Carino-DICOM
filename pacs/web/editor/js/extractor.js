// Extractor tab: render DICOM files to PNG images.
// ---- Extractor ----
// Files dropped here. The open study is not copied in: extractorItems() reads it fresh, so its
// redactions and pending tag edits (a saved window, a photometric fix) reach the PNG.
let extractorFiles = [];
let extractorRenderGen = 0;

const extractorAddBtn    = $('extractorAddBtn');
const extractorFileInput = $('extractorFileInput');
const extractorGridWrap  = $('extractorGridWrap');
const extractorGrid         = $('extractorGrid');
const extractorCount        = $('extractorCount');
const clearExtractorBtn     = $('clearExtractorBtn');
const extractAllBtn         = $('extractAllBtn');
const extractSelectedBtn    = $('extractSelectedBtn');
const extractorSideAddBtn   = $('extractorSideAddBtn');
const extractorDropZone     = $('extractorDropZone');
const extractorLogCard      = $('extractorLogCard');
const extractorLogArea      = $('extractorLogArea');
const extractorSource       = $('extractorSource');

function extractorItems() {
  const study = (typeof files !== 'undefined' ? files : []).map(f => ({
    name: f.name, path: f.path || f.name, dict: withPendingEdits(f), meta: f.meta || {}, fromStudy: true,
  }));
  return study.concat(extractorFiles);
}

function extractorLog(msg) {
  extractorLogCard.style.display = 'block';
  extractorLogArea.textContent += msg + '\n';
  extractorLogArea.scrollTop = extractorLogArea.scrollHeight;
}

extractorAddBtn.addEventListener('click', () => extractorFileInput.click());
// Stop propagation: the enclosing drop zone's click opens the same picker.
extractorSideAddBtn.addEventListener('click', e => { e.stopPropagation(); extractorFileInput.click(); });
extractorFileInput.addEventListener('change', e => { if (e.target.files?.length) addExtractorFiles(e.target.files); });
clearExtractorBtn.addEventListener('click', () => {
  extractorFiles = [];
  extractorLogCard.style.display = 'none';
  extractorLogArea.textContent = '';
  renderExtractorGrid();
  toast?.('Cleared the added files');
});

// Sidebar drop zone
extractorDropZone.addEventListener('click', () => extractorFileInput.click());
extractorDropZone.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); extractorDropZone.style.borderColor = 'var(--accent)'; });
extractorDropZone.addEventListener('dragleave', () => extractorDropZone.style.borderColor = '');
extractorDropZone.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); extractorDropZone.style.borderColor = ''; collectDropped(e.dataTransfer)?.then(r => addExtractorFiles(r.items)); });

// Main grid drop zone
extractorGridWrap.addEventListener('click', () => extractorFileInput.click());
extractorGridWrap.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); extractorGridWrap.classList.add('drag-over'); });
extractorGridWrap.addEventListener('dragleave', () => extractorGridWrap.classList.remove('drag-over'));
extractorGridWrap.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); extractorGridWrap.classList.remove('drag-over'); collectDropped(e.dataTransfer)?.then(r => addExtractorFiles(r.items)); });

async function addExtractorFiles(fileList) {
  const arr = withoutDiscIndex(Array.from(fileList || []).map(x => (x instanceof Blob) ? { file: x, path: x.webkitRelativePath || x.name } : x));
  const skipped = [];
  for (const { file: f, path } of arr) {
    // Detect by content, not extension: PACS exports use names like IM000001.
    if (!(await isDicomFile(f))) continue;
    const buf = await f.arrayBuffer();
    try {
      const msg = DicomMessage.readFile(buf);
      normBin(msg.dict);
      extractorFiles.push({ name: f.name, path, dict: msg.dict, meta: msg.meta || {} });
    } catch(e) {
      skipped.push(path);
      console.warn('[extractor] failed to parse', path, e);
    }
  }
  if (skipped.length) log(`Extractor: ${skipped.length} file(s) skipped (parse error): ${skipped.join(', ')}`);
  renderExtractorGrid();
}

// Folder loads can hold same-named slices in different series folders; the series prefix keeps
// PNG names distinct (download names cannot contain a slash).
function extractorBase(item) {
  return (item.path || item.name).replace(/\.[^.]+$/, '').replace(/[\\/]/g, '_');
}

// Archive entry name: here a slash is a folder, so the tree is kept.
function extractorZipBase(item) {
  return (item.path || item.name).replace(/\\/g, '/').replace(/\.[^./]+$/, '');
}

// toBlob, not toDataURL: avoids the base64 round-trip (+33% size) to get raw bytes.
async function canvasPngBytes(canvas) {
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

// Multiple PNGs go into a zip, like Download All: rapid anchor clicks drop files or trigger the
// browser's "download multiple files?" prompt.
function savePngZip(pngs, base) {
  if (!pngs.length) return;
  if (pngs.length === 1) {
    saveBlob(new Blob([pngs[0].bytes], { type: 'image/png' }), pngs[0].name.replace(/[\\/]/g, '_'));
    return;
  }
  const { saved, archives } = saveArchives(pngs, base, 'image/png', extractorLog);
  extractorLog(`⬇ ${saved} image(s) → ${archives === 1 ? 'one archive' : `${archives} archives`}`);
}

async function renderDcmToCanvas(dict, canvas, meta = null) {
  const result = await decodeDicomPixels(dict, 0, { meta });
  if (!result || result.error) {
    if (result?.error) {
      canvas.width = 160; canvas.height = 160;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#080808';
      ctx.fillRect(0, 0, 160, 160);
      ctx.fillStyle = '#f87171';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      const words = result.error.split(' ');
      let line = '', y = 65;
      for (const w of words) {
        if ((line + w).length > 18) { ctx.fillText(line.trim(), 80, y); line = ''; y += 14; }
        line += w + ' ';
      }
      if (line.trim()) ctx.fillText(line.trim(), 80, y);
      return false;
    }
    return false;
  }
  const { pixels, rows, cols } = result;
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(cols, rows);
  imgData.data.set(pixels);
  ctx.putImageData(imgData, 0, 0);
  return true;
}

// Re-run on every visit to the tab; a newer call abandons an older one mid-loop, so two quick
// visits never leave the grid with every card twice.
async function renderExtractorGrid() {
  const gen = ++extractorRenderGen;
  const items = extractorItems();
  const nStudy = items.length - extractorFiles.length;
  setCountPill(extractorCount, items.length);
  extractorSource.hidden = !nStudy;
  extractorSource.textContent = T('Includes the open study ({n}), with your edits').replace('{n}', nStudy);
  clearExtractorBtn.hidden = !extractorFiles.length;
  if (items.length === 0) {
    extractorGrid.className = '';
    extractorGridWrap.classList.remove('has-files');
    extractorGrid.innerHTML = `<div class="img-empty"><div class="img-empty-icon">🩻</div><span>${T('Drop .dcm files here or click to browse')}</span><span class="img-empty-hint">${T('Renders DICOM pixel data as PNG images')}</span></div>`;
    return;
  }
  extractorGrid.className = 'extractor-grid';
  extractorGridWrap.classList.add('has-files');
  extractorGrid.innerHTML = '';
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'dcm-card';
    // Only worth saying when both kinds are on screen.
    if (!item.fromStudy && nStudy) {
      card.classList.add('dcm-card-added');
      card.title = T('Added here: edits made in the Edit tab do not apply to this copy');
    }

    const canvas = document.createElement('canvas');
    const ok = await renderDcmToCanvas(item.dict, canvas, item.meta || null);
    if (gen !== extractorRenderGen) return;
    if (!ok && canvas.width === 0) {
      canvas.width = 160; canvas.height = 160;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#080808';
      ctx.fillRect(0, 0, 160, 160);
      ctx.fillStyle = '#555';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No image data', 80, 80);
    }

    const nf = parseInt(lookupTag(item.dict, '00280008')?.Value?.[0] || '1') || 1;
    const info = document.createElement('div');
    info.className = 'dcm-card-info';
    const label = item.path || item.name;
    info.textContent = nf > 1 ? `${label} [${nf} frames]` : label;
    info.title = label;

    const dl = document.createElement('button');
    dl.className = 'dcm-card-dl';
    dl.textContent = T('\u2193 Save PNG');
    dl.addEventListener('click', e => {
      e.stopPropagation();
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = extractorBase(item) + '.png';
      a.click();
    });
    card.addEventListener('click', e => e.stopPropagation());

    card.appendChild(canvas);
    card.appendChild(info);
    card.appendChild(dl);
    extractorGrid.appendChild(card);
  }
}

extractAllBtn.addEventListener('click', async () => {
  const items = extractorItems();
  if (!items.length) return;
  const pngs = [];
  showLoading?.(true, 'Extracting frames…', 0, `0 / ${items.length}`);
  try {
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const nf = parseInt(lookupTag(item.dict, '00280008')?.Value?.[0] || '1') || 1;
      const base = extractorZipBase(item);
      for (let fi = 0; fi < nf; fi++) {
        showLoading?.(true, `Extracting: ${item.name} [${fi + 1}/${nf}]`,
                      (idx + (fi + 1) / nf) / items.length, `${idx + 1} / ${items.length}`);
        const result = await decodeDicomPixels(item.dict, fi, { meta: item.meta || null });
        if (!result || result.error) continue;
        const { pixels, rows, cols } = result;
        const canvas = document.createElement('canvas');
        canvas.width = cols; canvas.height = rows;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(cols, rows);
        imgData.data.set(pixels);
        ctx.putImageData(imgData, 0, 0);
        const suffix = nf > 1 ? `_${String(fi + 1).padStart(3, '0')}` : '';
        const bytes = await canvasPngBytes(canvas);
        if (bytes) pngs.push({ name: base + suffix + '.png', bytes });
      }
    }
    showLoading?.(true, 'Packing files…', 1, `${pngs.length} / ${pngs.length}`);
    savePngZip(pngs, 'dicom-frames');
  } catch (e) {
    extractorLog(`✗ ${e.message || e}`);
  } finally {
    showLoading?.(false);
  }
});

extractSelectedBtn.addEventListener('click', async () => {
  const items = extractorItems();
  if (!items.length) return;
  const pngs = [];
  showLoading?.(true, 'Extracting frame 1 of each file…', 0, `0 / ${items.length}`);
  try {
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      showLoading?.(true, `Extracting: ${item.name}`, (idx + 1) / items.length, `${idx + 1} / ${items.length}`);
      const result = await decodeDicomPixels(item.dict, 0, { meta: item.meta || null });
      if (!result || result.error) { extractorLog(`✗ ${item.name}: ${result?.error ?? 'no image data'}`); continue; }
      const { pixels, rows, cols } = result;
      const canvas = document.createElement('canvas');
      canvas.width = cols; canvas.height = rows;
      const ctx = canvas.getContext('2d');
      const imgData = ctx.createImageData(cols, rows);
      imgData.data.set(pixels);
      ctx.putImageData(imgData, 0, 0);
      const bytes = await canvasPngBytes(canvas);
      if (bytes) pngs.push({ name: extractorZipBase(item) + '.png', bytes });
      extractorLog(`✓ ${item.name}`);
    }
    showLoading?.(true, 'Packing files…', 1, `${pngs.length} / ${pngs.length}`);
    savePngZip(pngs, 'dicom-first-frames');
  } catch (e) {
    extractorLog(`✗ ${e.message || e}`);
  } finally {
    showLoading?.(false);
  }
});

