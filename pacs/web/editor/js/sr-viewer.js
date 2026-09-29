// Structured Report viewer and preview navigation enhancements.
// ---- SR viewer ----

const SR_SOP_UIDS = new Set([
  '1.2.840.10008.5.1.4.1.1.88.11','1.2.840.10008.5.1.4.1.1.88.22',
  '1.2.840.10008.5.1.4.1.1.88.33','1.2.840.10008.5.1.4.1.1.88.34',
  '1.2.840.10008.5.1.4.1.1.88.35','1.2.840.10008.5.1.4.1.1.88.50',
  '1.2.840.10008.5.1.4.1.1.88.59','1.2.840.10008.5.1.4.1.1.88.65',
  '1.2.840.10008.5.1.4.1.1.88.67','1.2.840.10008.5.1.4.1.1.88.68',
  '1.2.840.10008.5.1.4.1.1.88.69','1.2.840.10008.5.1.4.1.1.88.70',
  '1.2.840.10008.5.1.4.1.1.88.72','1.2.840.10008.5.1.4.1.1.88.73',
]);

const srToggleBtn = $('srToggleBtn');
const srView      = $('srView');
let   srMode      = false;

function detectSR(d) {
  const sopUID = lookupTag(d,'00080016')?.Value?.[0]||'';
  return SR_SOP_UIDS.has(sopUID);
}

function renderSRNode(item, depth=0) {
  const el = document.createElement('div');
  el.className = 'sr-node';
  const vt  = item['0040a040']?.Value?.[0] || item.ValueType?.Value?.[0] || '';
  const cnSeq = item['0040a043']?.Value || item.ConceptNameCodeSequence?.Value || [];
  const label = cnSeq[0]?.['00080104']?.Value?.[0] || cnSeq[0]?.CodeMeaning?.Value?.[0] || '';

  const lEl = document.createElement('div');
  lEl.className = 'sr-label';
  lEl.textContent = label || vt;
  el.appendChild(lEl);

  const vEl = document.createElement('div');
  vEl.className = 'sr-value';

  switch (vt.toUpperCase()) {
    case 'TEXT': {
      const v = item['0040a160']?.Value?.[0] || item.TextValue?.Value?.[0] || '';
      vEl.textContent = v; break;
    }
    case 'NUM': {
      const ms = item['0040a300']?.Value || item.MeasuredValueSequence?.Value || [];
      const mv = ms[0]; const val = mv?.['0040a30a']?.Value?.[0]??mv?.NumericValue?.Value?.[0]??'';
      const unit = mv?.['004008ea']?.Value?.[0]?.['00080104']?.Value?.[0] || '';
      vEl.className = 'sr-value num'; vEl.textContent = val + (unit ? ' ' + unit : ''); break;
    }
    case 'CODE': {
      const cs = item['0040a168']?.Value || item.ConceptCodeSequence?.Value || [];
      const cv = cs[0]?.['00080104']?.Value?.[0] || cs[0]?.CodeMeaning?.Value?.[0] || '';
      vEl.className = 'sr-value code'; vEl.textContent = cv; break;
    }
    case 'DATETIME': case 'DATE': case 'TIME': {
      const v = item['0040a120']?.Value?.[0] || item['0040a121']?.Value?.[0] || item['0040a122']?.Value?.[0] || '';
      vEl.className = 'sr-value datetime'; vEl.textContent = v; break;
    }
    case 'PNAME': {
      const pn = item['0040a123']?.Value?.[0] || item.PersonName?.Value?.[0] || {};
      vEl.textContent = typeof pn==='object' ? (pn.Alphabetic||'') : String(pn||''); break;
    }
    case 'CONTAINER': vEl.remove(); break;
    default: break;
  }

  if (vEl.parentElement || vt.toUpperCase()!=='CONTAINER') el.appendChild(vEl);

  const children = item['0040a730']?.Value || item.ContentSequence?.Value || [];
  if (children.length) {
    const cont = document.createElement('div');
    cont.className = 'sr-container';
    children.forEach(child => cont.appendChild(renderSRNode(child, depth+1)));
    el.appendChild(cont);
  }
  return el;
}

function renderSR(d) {
  srView.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'sr-section-title';
  const sopUID = lookupTag(d,'00080016')?.Value?.[0]||'';
  const sopName = SOP_ATTRS[sopUID]?.name || 'Structured Report';
  title.textContent = sopName;
  srView.appendChild(title);

  const root = lookupTag(d,'0040a730')?.Value || [];
  if (!root.length) {
    const msg = document.createElement('p');
    msg.style.cssText='color:var(--text-muted);font-size:12px;margin-top:8px';
    msg.textContent=T('No content items found in Content Sequence.');
    srView.appendChild(msg);
    return;
  }
  root.forEach(item => srView.appendChild(renderSRNode(item)));
}

srToggleBtn?.addEventListener('click', () => {
  srMode = !srMode;
  srToggleBtn.classList.toggle('active', srMode);
  srView.classList.toggle('hidden', !srMode);
  previewBox.classList.toggle('hidden', srMode);
  if (srMode && dict) renderSR(dict);
});


// ---- Preview enhancements: pixel hover + file navigation ----

const pxHover     = $('pxHover');
const previewNav  = $('previewNav');
const prevFileBtn = $('prevFileBtn');
const nextFileBtn = $('nextFileBtn');
const previewNavInfo = $('previewNavInfo');

// Pixel value on hover
previewBox?.addEventListener('mousemove', e => {
  if (!previewImageData || !pxHover) return;
  const rect = previewCanvas.getBoundingClientRect();
  const scaleX = previewImageData.width  / rect.width;
  const scaleY = previewImageData.height / rect.height;
  const px = Math.floor((e.clientX - rect.left) * scaleX);
  const py = Math.floor((e.clientY - rect.top)  * scaleY);
  if (px < 0 || py < 0 || px >= previewImageData.width || py >= previewImageData.height) return;
  const idx = (py * previewImageData.width + px) * 4;
  const r = previewImageData.data.data[idx];
  pxHover.textContent = `(${px}, ${py})  val: ${r}`;
});
previewBox?.addEventListener('mouseleave', () => { if(pxHover) pxHover.textContent='—'; });

// File navigation (prev/next through loaded files)
function updatePreviewNav() {
  if (!previewNav) return;
  const multi = files.length > 1;
  previewNav.classList.toggle('hidden', !multi);
  if (!multi) return;
  prevFileBtn.disabled = currentFileIdx <= 0;
  nextFileBtn.disabled = currentFileIdx >= files.length - 1;
  previewNavInfo.textContent = `${currentFileIdx + 1} / ${files.length}`;
}

prevFileBtn?.addEventListener('click', () => { if (currentFileIdx > 0) switchFile(currentFileIdx - 1); });
nextFileBtn?.addEventListener('click', () => { if (currentFileIdx < files.length - 1) switchFile(currentFileIdx + 1); });

// Keyboard navigation
document.addEventListener('keydown', e => {
  if (activeTab !== 'editor' || !files.length) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft'  && currentFileIdx > 0)               switchFile(currentFileIdx - 1);
  if (e.key === 'ArrowRight' && currentFileIdx < files.length - 1) switchFile(currentFileIdx + 1);
});

