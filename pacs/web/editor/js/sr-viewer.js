// Structured Report viewer and preview navigation enhancements.
// ---- SR viewer ----

// PS3.4 Table B.5-1: every SR Storage SOP Class under 1.2.840.10008.5.1.4.1.1.88.* uses the SR
// Document Content Module this viewer renders, so the whole family is recognised.
const SR_SOP_UIDS = new Set([
  '1.2.840.10008.5.1.4.1.1.88.11','1.2.840.10008.5.1.4.1.1.88.22',
  '1.2.840.10008.5.1.4.1.1.88.33','1.2.840.10008.5.1.4.1.1.88.34',
  '1.2.840.10008.5.1.4.1.1.88.35','1.2.840.10008.5.1.4.1.1.88.40',
  '1.2.840.10008.5.1.4.1.1.88.50','1.2.840.10008.5.1.4.1.1.88.59',
  '1.2.840.10008.5.1.4.1.1.88.65','1.2.840.10008.5.1.4.1.1.88.67',
  '1.2.840.10008.5.1.4.1.1.88.68','1.2.840.10008.5.1.4.1.1.88.69',
  '1.2.840.10008.5.1.4.1.1.88.70','1.2.840.10008.5.1.4.1.1.88.71',
  '1.2.840.10008.5.1.4.1.1.88.72','1.2.840.10008.5.1.4.1.1.88.73',
  '1.2.840.10008.5.1.4.1.1.88.74','1.2.840.10008.5.1.4.1.1.88.75',
  '1.2.840.10008.5.1.4.1.1.88.76','1.2.840.10008.5.1.4.1.1.88.77',
]);

const srToggleBtn = $('srToggleBtn');
const srView      = $('srView');
let   srMode      = false;

function detectSR(d) {
  const sopUID = String(lookupTag(d,'00080016')?.Value?.[0]||'').trim();
  return SR_SOP_UIDS.has(sopUID) || /^1\.2\.840\.10008\.5\.1\.4\.1\.1\.88\.\d+$/.test(sopUID);
}

// Content items are raw dcmjs datasets (keys like '0040A040', UPPERCASE): read every field
// through the case-tolerant lookup, never a literal key.
const srv = (n, t) => n && typeof n === 'object' ? lookupTag(n, t) : undefined;
const srFirst = (n, t) => srv(n, t)?.Value?.[0];
const srItems = (n, t) => { const v = srv(n, t)?.Value; return Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : []; };
const srMeaning = (seqOwner, t) => String(srFirst(srItems(seqOwner, t)[0], '00080104') ?? '');
const srPN = (pn) => pn && typeof pn === 'object' ? (pn.Alphabetic || '') : String(pn ?? '');

function renderSRNode(item, depth=0) {
  const el = document.createElement('div');
  el.className = 'sr-node';
  const vt  = String(srFirst(item, '0040A040') ?? '').trim();
  const label = srMeaning(item, '0040A043');

  const lEl = document.createElement('div');
  lEl.className = 'sr-label';
  lEl.textContent = label || vt;
  el.appendChild(lEl);

  const vEl = document.createElement('div');
  vEl.className = 'sr-value';
  const muted = (s) => { vEl.className = 'sr-value muted'; vEl.textContent = s; };

  switch (vt.toUpperCase()) {
    case 'TEXT':
      vEl.textContent = String(srFirst(item, '0040A160') ?? ''); break;
    case 'NUM': {
      const mv = srItems(item, '0040A300')[0];
      const val = srFirst(mv, '0040A30A');
      const unit = srMeaning(mv, '004008EA');
      vEl.className = 'sr-value num';
      if (val != null && String(val) !== '') vEl.textContent = String(val) + (unit ? ' ' + unit : '');
      else vEl.textContent = srMeaning(item, '0040A301') || '';    // Numeric Value Qualifier
      break;
    }
    case 'CODE':
      vEl.className = 'sr-value code'; vEl.textContent = srMeaning(item, '0040A168'); break;
    case 'DATETIME': case 'DATE': case 'TIME': {
      const v = srFirst(item, '0040A120') ?? srFirst(item, '0040A121') ?? srFirst(item, '0040A122') ?? '';
      vEl.className = 'sr-value datetime'; vEl.textContent = String(v); break;
    }
    case 'PNAME':
      vEl.textContent = srPN(srFirst(item, '0040A123')); break;
    case 'UIDREF':
      vEl.className = 'sr-value datetime'; vEl.textContent = String(srFirst(item, '0040A124') ?? ''); break;
    case 'IMAGE': case 'COMPOSITE': case 'WAVEFORM': {
      const uids = srItems(item, '00081199').map(r => String(srFirst(r, '00081155') ?? '')).filter(Boolean);
      vEl.className = 'sr-value datetime'; vEl.textContent = uids.join(', ') || `[${vt}]`; break;
    }
    case 'SCOORD': case 'SCOORD3D':
      muted(`[${vt} ${String(srFirst(item, '00700023') ?? '').trim()}]`.replace(' ]', ']')); break;
    case 'TCOORD':
      muted(`[TCOORD ${String(srFirst(item, '0040A130') ?? '').trim()}]`.replace(' ]', ']')); break;
    case 'CONTAINER': vEl.remove(); break;
    default: {
      // A by-reference item has no Value Type: name what it points at.
      const ref = srv(item, '0040DB73')?.Value;
      if (!vt && Array.isArray(ref) && ref.length) muted('→ item ' + ref.join('.'));
      else if (vt) muted(`[${vt} not rendered]`);
    }
  }

  if (vEl.parentElement || vt.toUpperCase()!=='CONTAINER') el.appendChild(vEl);

  const children = srItems(item, '0040A730');
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
  const sopUID = String(lookupTag(d,'00080016')?.Value?.[0]||'').trim();
  const sopName = SOP_ATTRS[sopUID]?.name || 'Structured Report';
  title.textContent = sopName;
  srView.appendChild(title);

  const root = srItems(d, '0040A730');
  if (!root.length) {
    const msg = document.createElement('p');
    msg.style.cssText='color:var(--text-muted);font-size:12px;margin-top:8px';
    msg.textContent=T('No content items found in Content Sequence.');
    srView.appendChild(msg);
    return;
  }
  root.forEach(item => srView.appendChild(renderSRNode(item)));
}

// The working copy (with pending edits), as the table and Download show it.
const srDataset = () => files[currentFileIdx] ? withPendingEdits(files[currentFileIdx]) : dict;

srToggleBtn?.addEventListener('click', () => {
  srMode = !srMode;
  srToggleBtn.classList.toggle('active', srMode);
  srView.classList.toggle('hidden', !srMode);
  previewBox.classList.toggle('hidden', srMode);
  if (srMode && dict) renderSR(srDataset());
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
  // Not while redacting or viewing full screen: the boxes belong to the image on screen.
  if (redactUI.active || fullscreenOverlay.classList.contains('visible')) return;
  if (e.key === 'ArrowLeft'  && currentFileIdx > 0)               switchFile(currentFileIdx - 1);
  if (e.key === 'ArrowRight' && currentFileIdx < files.length - 1) switchFile(currentFileIdx + 1);
});

