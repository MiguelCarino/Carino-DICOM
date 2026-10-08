// Overview tab: navbar diagnostics, summary cards, image viewer (W/L, colormap, cine, pan/zoom), actions and print report.
(function () {

  // ---- Navbar diag clock + greeting ----
  // The header clock itself is carino-clock.js; this only feeds the dropdown's local time and the greeting.
  function tick() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const local = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    const dc = $('diagClock'); if (dc) dc.textContent = local;
    const g = $('greeting'); if (g) { const h = d.getHours(); g.textContent = T(h < 5 ? 'Late shift.' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.'); }
  }
  tick(); setInterval(tick, 1000);

  // ---- Diagnostics dropdown ----
  const diagToggle = $('diagToggle'), diagBox = $('diagBox');
  if (diagToggle && diagBox) {
    diagToggle.addEventListener('click', e => { e.stopPropagation(); diagBox.classList.toggle('open'); diagToggle.setAttribute('aria-expanded', diagBox.classList.contains('open') ? 'true' : 'false'); });
    document.addEventListener('click', e => { if (diagBox.classList.contains('open') && !diagBox.contains(e.target) && !diagToggle.contains(e.target)) { diagBox.classList.remove('open'); diagToggle.setAttribute('aria-expanded', 'false'); } });
  }

  // The self-test runs on page load, so a same-page href would do nothing; reload instead,
  // confirming first because the suites replace the loaded study.
  $('selftestLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    const go = () => window.__selftest.reload();
    if (files.length) {
      confirmDanger(T('The self-test loads test files of its own. The study you have open, and any edits you have not exported, will be discarded.'),
                    go, 'Run the self-test');
    } else go();
  });

  // ---- Tag readers ----
  function txt(tag8)     { try { const e = getTag(dict, tag8); return e ? elToString(e).trim() : ''; } catch (_) { return ''; } }
  function metaTxt(tag8) { const e = meta && (meta[tag8] || meta[tag8.toUpperCase()]); return e && e.Value ? String(e.Value[0] ?? '').trim() : ''; }
  function fmtDate(s)    { s = (s || '').trim(); return /^\d{8}$/.test(s) ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : s; }
  function esc(s)        { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

  window.updateDiag = function () {
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('diagCount', files.length);
    set('diagName', dict ? (files[currentFileIdx]?.name || '—') : '—');
    if (!dict) { ['diagModality','diagDims','diagFrames','diagTs'].forEach(i => set(i, '—')); return; }
    set('diagModality', txt('00080060') || '—');
    const r = lookupTag(dict,'00280010')?.Value?.[0], c = lookupTag(dict,'00280011')?.Value?.[0];
    set('diagDims', r && c ? `${c}×${r}` : '—');
    set('diagFrames', lookupTag(dict,'00280008')?.Value?.[0] || '1');
    set('diagTs', metaTxt('00020010') || '—');
  };

  // ---- Key/value rows ----
  function kvRow(k, v) {
    const empty = !v;
    return `<div class="ov-kv-row"><span class="ov-kv-k">${esc(k)}</span><span class="ov-kv-v${empty ? ' empty' : ''}">${empty ? '—' : esc(v)}</span></div>`;
  }

  // Patient-name visibility persists across reloads.
  const PN_KEY = 'dicom-ov-show-patient';
  const patientShown = () => localStorage.getItem(PN_KEY) === '1';

  function renderCore() {
    const core = $('ovCore'); if (!core) return;
    const name = txt('00100010'), shown = patientShown();
    let nameCell;
    if (!name) {
      nameCell = `<span class="ov-kv-v empty">—</span>`;
    } else {
      const val = shown ? esc(name) : '••••••••';
      nameCell = `<span class="ov-kv-v${shown ? '' : ' hidden-val'}">${val}<button class="ov-reveal" id="ovPnToggle">${T(shown ? 'Hide' : 'Show')}</button></span>`;
    }
    core.innerHTML =
      `<div class="ov-kv-row"><span class="ov-kv-k">${T('Patient Name')}</span>${nameCell}</div>` +
      kvRow(T('Patient ID'), txt('00100020')) +
      kvRow(T('Sex'), txt('00100040')) +
      kvRow(T('Age'), txt('00101010')) +
      kvRow(T('Modality'), txt('00080060')) +
      kvRow(T('Study Description'), txt('00081030')) +
      kvRow(T('Study Date'), fmtDate(txt('00080020'))) +
      kvRow(T('Series Description'), txt('0008103E')) +
      kvRow(T('Body Part'), txt('00180015'));
    const tgl = $('ovPnToggle');
    if (tgl) tgl.addEventListener('click', () => { localStorage.setItem(PN_KEY, patientShown() ? '0' : '1'); renderCore(); });
  }

  // SHA-256 of the file as loaded, not the edited dataset.
  // shaState: idle | computing | done | deferred | unavailable.
  function shaRowHtml() {
    const entry = files[currentFileIdx];
    let cell;
    if (!entry || entry.shaState === 'unavailable' || (!entry.file && !entry.sha)) {
      cell = `<span class="ov-kv-v empty">unavailable</span>`;
    } else if (entry.shaState === 'computing') {
      cell = `<span class="ov-kv-v">computing…</span>`;
    } else if (entry.shaState === 'deferred') {
      const mb = (entry.size / 1048576).toFixed(1);
      cell = `<span class="ov-kv-v"><button class="ov-reveal" onclick="window.__computeSha()">Compute — ${mb} MB</button></span>`;
    } else if (entry.sha) {
      const note = (typeof datasetDirty !== 'undefined' && datasetDirty)
        ? ` <span class="ov-sha-stale" title="You have edited the working copy this session. This hash is still the ORIGINAL file's — an exported/edited file will hash differently.">working copy edited</span>` : '';
      cell = `<span class="ov-kv-v ov-sha">${esc(entry.sha)}${note}</span>`;
    } else {
      cell = `<span class="ov-kv-v empty">—</span>`;
    }
    return `<div class="ov-kv-row"><span class="ov-kv-k">SHA-256 <span class="ov-kv-sub">file as loaded</span></span>${cell}</div>`;
  }

  function renderTech() {
    const tech = $('ovTech'); if (!tech) return;
    const r = lookupTag(dict,'00280010')?.Value?.[0], c = lookupTag(dict,'00280011')?.Value?.[0];
    tech.innerHTML =
      kvRow('SOP Instance UID', txt('00080018')) +
      kvRow('Transfer Syntax UID', metaTxt('00020010')) +
      kvRow('Photometric Interpretation', txt('00280004')) +
      kvRow('Image Position (Patient)', txt('00200032')) +
      kvRow('Pixel Spacing', txt('00280030')) +
      kvRow('Window Center', txt('00281050')) +
      kvRow('Window Width', txt('00281051')) +
      kvRow('Specific Character Set', txt('00080005')) +
      kvRow('Rows × Columns', r && c ? `${r} × ${c}` : '') +
      shaRowHtml();
  }
  // Lets files.js refresh just this card when a hash resolves.
  window.__ovRenderTech = function () { if (dict) renderTech(); };

  // ---- Equipment / manufacturer ----
  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#060606"/><g fill="none" stroke="#333" stroke-width="3"><rect x="22" y="30" width="76" height="50" rx="4"/><circle cx="60" cy="55" r="14"/><rect x="40" y="86" width="40" height="6" rx="3"/></g><text x="60" y="108" fill="#555" font-family="monospace" font-size="9" text-anchor="middle">no image</text></svg>');

  function renderMfr() {
    const brand = txt('00080070'), model = txt('00081090'), img = $('ovMfrImg');
    $('ovMfrBrand').textContent = brand || T('Unknown manufacturer');
    $('ovMfrModel').textContent = model || '';
    if (img) {
      if (brand || model) {
        const s = slug(`${brand}-${model}`) || slug(brand) || slug(model);
        img.onerror = () => { img.onerror = null; img.src = PLACEHOLDER; };
        img.src = `models/${s}.png`;
      } else { img.onerror = null; img.src = PLACEHOLDER; }
    }
    $('ovMfrExtra').innerHTML =
      kvRow(T('Station Name'), txt('00081010')) +
      kvRow(T('Institution'), txt('00080080')) +
      kvRow(T('Software Versions'), txt('00181020')) +
      kvRow(T('Device Serial'), txt('00181000'));
  }

  // ---- RIS / workflow ----
  // Some workflow attributes live only in Request Attributes Sequence (0040,0275) or
  // Scheduled Procedure Step Sequence (0040,0100); read top-level first, then those.
  function firstSeqItem(tag8) { try { const e = getTag(dict, tag8); const it = e?.Value?.[0]; return it && typeof it === 'object' ? it : null; } catch (_) { return null; } }
  function subTxt(item, tag8) { if (!item) return ''; try { const e = getTag(item, tag8); return e ? elToString(e).trim() : ''; } catch (_) { return ''; } }
  function risVal(top, sub) {
    let v = txt(top); if (v) return v;
    v = subTxt(firstSeqItem('00400275'), sub || top); if (v) return v;
    return subTxt(firstSeqItem('00400100'), sub || top);
  }

  function renderRis() {
    const el = $('ovRis'); if (!el) return;
    el.innerHTML =
      kvRow(T('Accession Number'), risVal('00080050')) +
      kvRow(T('Study ID'), txt('00200010')) +
      kvRow(T('Referring Physician'), txt('00080090')) +
      kvRow(T('Requesting Physician'), txt('00321032')) +
      kvRow(T('Requesting Service'), txt('00321033')) +
      kvRow(T('Requested Procedure ID'), risVal('00401001')) +
      kvRow(T('Requested Procedure Desc.'), txt('00321060')) +
      kvRow(T('Scheduled Step ID'), risVal('00400009')) +
      kvRow(T('Scheduled Step Desc.'), risVal('00400007')) +
      kvRow(T('Performed Step ID'), txt('00400253')) +
      kvRow(T('Reason for Request'), txt('00401002') || txt('00321030')) +
      kvRow(T('Admission ID'), txt('00380010')) +
      kvRow(T('Performing Physician'), txt('00081050')) +
      kvRow(T('Operators'), txt('00081070'));
  }

  // ---- Validation / conformance (read-only) ----
  function renderOvValidation() {
    const summary = $('ovValSummary'), list = $('ovValIssues');
    if (!summary || !list) return;
    if (!dict) { summary.style.display = 'none'; summary.innerHTML = ''; list.innerHTML = ''; return; }

    let issues = [];
    try { issues = validateDicom(dict, meta) || []; } catch (_) { issues = []; }

    const cnt = sev => issues.filter(i => i.sev === sev).length;
    const errors = cnt('error'), warnings = cnt('warning'), phi = cnt('phi'), info = cnt('info');

    if (!issues.length) {
      summary.style.display = '';
      summary.innerHTML = `<div class="val-badge" style="color:var(--ok,#2ecc71)">${T('✓ No conformance issues found')}</div>`;
      list.innerHTML = '';
      return;
    }

    summary.style.display = '';
    summary.innerHTML =
      `<div class="val-badge error">● ${errors} Error${errors!==1?'s':''}</div>` +
      `<div class="val-badge warning">● ${warnings} Warning${warnings!==1?'s':''}</div>` +
      `<div class="val-badge phi">● ${phi} PHI Flag${phi!==1?'s':''}</div>` +
      `<div class="val-badge info">● ${info} Info</div>`;

    const CAP = 60;
    const shown = issues.slice(0, CAP);
    const rows = shown.map(iss => `<div class="val-issue"><div class="val-dot ${iss.sev}"></div>
        <div class="val-issue-body">
          <div class="val-issue-tag">${fmtTag('x'+iss.tag.toLowerCase())} ${esc(iss.desc)}</div>
          ${iss.sev !== 'phi' ? `<div class="val-issue-msg">${esc(iss.msg)}</div>` : ''}
          ${iss.val ? `<div class="val-issue-val">${iss.sev==='phi'?'':'Current: '}${esc(iss.val.slice(0,120))}${iss.val.length>120?'…':''}</div>` : ''}
        </div></div>`).join('');
    const more = issues.length > CAP ? `<div class="val-issue-msg" style="padding:6px 4px;opacity:.7">+${issues.length - CAP} more issue${issues.length - CAP !== 1 ? 's' : ''}…</div>` : '';
    list.innerHTML = `<div class="val-issues">${rows}${more}</div>`;
  }

  // ---- Image viewer ----
  const viewer = $('ovViewer'), canvas = $('ovCanvas'), ctx = canvas ? canvas.getContext('2d') : null;
  let ovRaw = null, ovFrames = 1;
  // Decode generation: decode time varies by codec, so a stale slower decode must not
  // paint over a newer one (slider drags, cine).
  let loadSeq = 0;
  const view = { wc: null, ww: null, invert: false, cmap: 'gray', rotate: 0, flipH: false, flipV: false, zoom: 1, panX: 0, panY: 0, frame: 0 };
  const cine = { playing: false, timer: null, fps: 15, loop: true };

  const LUT = (function () {
    const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v | 0;
    const gray = new Uint8Array(768), hot = new Uint8Array(768), jet = new Uint8Array(768), bone = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      gray[i*3] = gray[i*3+1] = gray[i*3+2] = i;
      hot[i*3] = clamp(i*3); hot[i*3+1] = clamp(i*3-255); hot[i*3+2] = clamp(i*3-510);
      bone[i*3] = clamp(i*0.9); bone[i*3+1] = clamp(i*0.92); bone[i*3+2] = clamp(i+20);
      const v = i/255;
      jet[i*3]   = clamp(255*Math.min(Math.max(1.5-Math.abs(4*v-3),0),1));
      jet[i*3+1] = clamp(255*Math.min(Math.max(1.5-Math.abs(4*v-2),0),1));
      jet[i*3+2] = clamp(255*Math.min(Math.max(1.5-Math.abs(4*v-1),0),1));
    }
    return { gray, hot, jet, bone };
  })();

  function applyTransform() {
    if (canvas) canvas.style.transform =
      `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom}) rotate(${view.rotate}deg) scaleX(${view.flipH ? -1 : 1}) scaleY(${view.flipV ? -1 : 1})`;
  }

  function paint() {
    if (!ovRaw || !ctx) return;
    const { rows, cols } = ovRaw, n = rows * cols;
    canvas.width = cols; canvas.height = rows;
    const out = new Uint8ClampedArray(n * 4), lut = LUT[view.cmap] || LUT.gray;
    if (ovRaw.rgb) {
      const src = ovRaw.rgb;
      for (let i = 0; i < n; i++) { const p = i*4; let r = src[p], g = src[p+1], b = src[p+2]; if (view.invert) { r = 255-r; g = 255-g; b = 255-b; } out[p] = r; out[p+1] = g; out[p+2] = b; out[p+3] = 255; }
    } else {
      // ovRaw.invert = MONOCHROME1, view.invert = toolbar button; they compose.
      const win = applyWindowToFloats(ovRaw.rawFloats, n, view.wc ?? ovRaw.wcTag, view.ww ?? ovRaw.wwTag, ovRaw.mn, ovRaw.mx, ovRaw.invert);
      for (let i = 0; i < n; i++) { let g = win[i*4]; if (view.invert) g = 255 - g; const p = i*4, q = g*3; out[p] = lut[q]; out[p+1] = lut[q+1]; out[p+2] = lut[q+2]; out[p+3] = 255; }
    }
    ctx.putImageData(new ImageData(out, cols, rows), 0, 0);
    applyTransform();
  }


  function setupWL() {
    const wc = $('ovWC'), ww = $('ovWW');
    if (view.wc < +wc.min) wc.min = Math.floor(view.wc);
    if (view.wc > +wc.max) wc.max = Math.ceil(view.wc);
    if (view.ww > +ww.max) ww.max = Math.ceil(view.ww);
    wc.value = view.wc; ww.value = Math.max(1, view.ww);
    $('ovWCval').textContent = Math.round(view.wc);
    $('ovWWval').textContent = Math.round(view.ww);
  }

  // ---- Cine ----
  // NaN (emptied fps box) falls back to 15; a NaN interval would busy-loop setTimeout.
  const clampFps = (r) => Number.isFinite(r) ? Math.min(60, Math.max(1, Math.round(r))) : 15;

  // Precedence (PS3.3 C.7.6.5): Recommended Display Frame Rate (0008,2144), then
  // Frame Time (0018,1063), then Cine Rate (0018,0040); default 15 fps.
  function tagFrameRate() {
    const rec = parseFloat(txt('00082144'));
    if (Number.isFinite(rec) && rec > 0) return clampFps(rec);
    const ft = parseFloat(txt('00181063'));          // milliseconds per frame
    if (Number.isFinite(ft) && ft > 0) return clampFps(1000 / ft);
    const cr = parseFloat(txt('00180040'));
    if (Number.isFinite(cr) && cr > 0) return clampFps(cr);
    return 15;
  }

  function syncFrameUI() {
    const fs = $('ovFrame'); if (fs) fs.value = view.frame;
    const lbl = $('ovFrameLabel'); if (lbl) lbl.textContent = `${view.frame + 1}/${ovFrames}`;
  }

  function syncCineBtn() {
    const b = $('ovCinePlay'); if (!b) return;
    b.textContent = cine.playing ? '⏸' : '▶';
    b.classList.toggle('active', cine.playing);
    const label = T(cine.playing ? 'Pause cine' : 'Play cine');
    b.title = label; b.setAttribute('aria-label', label);
  }

  function stopCine() {
    if (cine.timer) { clearTimeout(cine.timer); cine.timer = null; }
    cine.playing = false;
    syncCineBtn();
  }

  // Chained timeouts, not setInterval: a slow decode delays the next frame instead of
  // queueing callbacks behind it.
  async function cineStep() {
    cine.timer = null;
    if (!cine.playing) return;
    let next = view.frame + 1;
    if (next >= ovFrames) {
      if (!cine.loop) { stopCine(); return; }
      next = 0;
    }
    view.frame = next;
    syncFrameUI();
    await loadImage();
    if (!cine.playing) return;
    cine.timer = setTimeout(cineStep, Math.max(1, Math.round(1000 / cine.fps)));
  }

  function startCine() {
    if (cine.playing || ovFrames <= 1) return;
    cine.playing = true;
    syncCineBtn();
    cine.timer = setTimeout(cineStep, Math.max(1, Math.round(1000 / cine.fps)));
  }

  // Page the stack: next frame in a multi-frame file, else next image in the SAME
  // series (clamped at the series boundary).
  function ovStackStep(delta) {
    delta = Math.trunc(delta) || 0;
    if (!delta) return;
    if (ovFrames > 1) {
      const next = Math.min(ovFrames - 1, Math.max(0, view.frame + delta));
      if (next === view.frame) return;
      stopCine();
      view.frame = next;
      syncFrameUI();
      loadImage();
      return;
    }
    if (files.length < 2) return;
    const series = groupSeries().find(s => s.indices.includes(currentFileIdx));
    if (!series) return;
    const at = series.indices.indexOf(currentFileIdx);
    const next = Math.min(series.indices.length - 1, Math.max(0, at + delta));
    if (next === at) return;
    switchFile(series.indices[next], { light: true });
  }
  window.ovStackStep = ovStackStep;
  window.ovStopCine = stopCine;
  // Only handle on cine state from outside this IIFE (used by tests).
  window.ovCine = { state: cine, start: startCine, stop: stopCine, rate: tagFrameRate };

  async function loadImage() {
    if (!canvas) return;
    const noimg = $('ovNoImg'), tools = $('ovTools');
    const my = ++loadSeq;
    let res = null;
    try { res = await decodeDicomPixels(dict, view.frame, { meta }); } catch (e) { res = null; }
    // A newer request overtook this one; drop the stale result entirely.
    if (my !== loadSeq) return;
    if (!res || res.error) {
      ovRaw = null; canvas.style.display = 'none'; noimg.classList.remove('hidden');
      noimg.textContent = res && res.error ? res.error : 'No renderable pixel data in this file.';
      $('ovWL').classList.add('hidden'); $('ovFrameNav').classList.add('hidden'); stopCine(); if (tools) tools.style.display = 'none';
      return;
    }
    canvas.style.display = ''; noimg.classList.add('hidden'); if (tools) tools.style.display = 'flex';
    if (res.rawFloats) {
      // rawFloats already has Rescale Slope/Intercept applied (in decodeDicomPixels).
      ovRaw = { rawFloats: res.rawFloats, rows: res.rows, cols: res.cols, mn: res.mn, mx: res.mx,
                wcTag: res.wcTag, wwTag: res.wwTag, invert: res.invert };
      if (view.wc == null) view.wc = res.wcTag ?? Math.round((res.mn + res.mx) / 2);
      if (view.ww == null) view.ww = res.wwTag ?? Math.max(1, res.mx - res.mn);
      setupWL(); $('ovWL').classList.remove('hidden'); $('ovColormap').disabled = false;
    } else {
      ovRaw = { rgb: res.pixels, rows: res.rows, cols: res.cols };
      $('ovWL').classList.add('hidden'); $('ovColormap').disabled = true;
    }
    ovFrames = res.numFrames || 1;
    const fn = $('ovFrameNav');
    if (ovFrames > 1) { fn.classList.remove('hidden'); $('ovFrame').max = ovFrames - 1; syncFrameUI(); }
    else { fn.classList.add('hidden'); stopCine(); }
    paint();
  }

  // ---- Viewer controls ----
  if (canvas) {
    $('ovInvert').addEventListener('click', () => { view.invert = !view.invert; $('ovInvert').classList.toggle('active', view.invert); paint(); });
    $('ovColormap').addEventListener('change', e => { view.cmap = e.target.value; paint(); });
    $('ovRotate').addEventListener('click', () => { view.rotate = (view.rotate + 90) % 360; applyTransform(); });
    $('ovFlipH').addEventListener('click', () => { view.flipH = !view.flipH; $('ovFlipH').classList.toggle('active', view.flipH); applyTransform(); });
    $('ovFlipV').addEventListener('click', () => { view.flipV = !view.flipV; $('ovFlipV').classList.toggle('active', view.flipV); applyTransform(); });
    $('ovResetView').addEventListener('click', () => { view.zoom = 1; view.panX = 0; view.panY = 0; view.rotate = 0; view.flipH = false; view.flipV = false; $('ovFlipH').classList.remove('active'); $('ovFlipV').classList.remove('active'); applyTransform(); });
    $('ovWC').addEventListener('input', e => { view.wc = +e.target.value; $('ovWCval').textContent = view.wc; paint(); });
    $('ovWW').addEventListener('input', e => { view.ww = Math.max(1, +e.target.value); $('ovWWval').textContent = view.ww; paint(); });
    $('ovPreset').addEventListener('change', e => { if (!e.target.value) return; const [c, w] = e.target.value.split(',').map(Number); view.wc = c; view.ww = w; setupWL(); paint(); });
    // Using the frame slider stops cine.
    $('ovFrame').addEventListener('input', e => { stopCine(); view.frame = +e.target.value; $('ovFrameLabel').textContent = `${view.frame + 1}/${ovFrames}`; loadImage(); });
    $('ovCinePlay').addEventListener('click', () => { cine.playing ? stopCine() : startCine(); });
    $('ovCineFps').addEventListener('change', e => { cine.fps = clampFps(parseFloat(e.target.value)); e.target.value = cine.fps; });
    $('ovCineLoop').addEventListener('change', e => { cine.loop = !!e.target.checked; });

    // Wheel pages the stack (PACS convention, as in OHIF/Weasis); Ctrl/Cmd+wheel zooms,
    // which also covers trackpad pinch. preventDefault blocks the browser's page zoom.
    let wheelPending = 0, wheelRAF = 0;
    function flushWheel() {
      wheelRAF = 0;
      const d = wheelPending; wheelPending = 0;
      ovStackStep(d);
    }
    // Exposed for tests: requestAnimationFrame never fires in the headless harness.
    window.ovWheelFlush = flushWheel;
    viewer.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        view.zoom = Math.min(12, Math.max(0.2, view.zoom * f));
        applyTransform();
        return;
      }
      // Coalesce wheel events and step once per animation frame to avoid queueing decodes.
      wheelPending += e.deltaY > 0 ? 1 : -1;
      if (wheelRAF) return;
      wheelRAF = requestAnimationFrame(flushWheel);
    }, { passive: false });
    let dragging = false, sx = 0, sy = 0;
    // Drag always pans here; redaction boxes are drawn in the Edit tab.
    viewer.addEventListener('pointerdown', e => { dragging = true; sx = e.clientX - view.panX; sy = e.clientY - view.panY; viewer.classList.add('panning'); try { viewer.setPointerCapture(e.pointerId); } catch (_) {} });
    viewer.addEventListener('pointermove', e => { if (!dragging) return; view.panX = e.clientX - sx; view.panY = e.clientY - sy; applyTransform(); });
    const endPan = () => { dragging = false; viewer.classList.remove('panning'); };
    viewer.addEventListener('pointerup', endPan); viewer.addEventListener('pointercancel', endPan);
  }

  // ---- Drop zone (reuses #fileInput -> handleFiles) ----
  const ovDrop = $('ovDrop');
  if (ovDrop) {
    // No keydown handler: keyboard users use the buttons inside, which would otherwise fire twice.
    ovDrop.addEventListener('click', () => fileInput.click());
    ovDrop.addEventListener('dragover', e => { e.preventDefault(); ovDrop.classList.add('drag'); });
    ovDrop.addEventListener('dragleave', () => ovDrop.classList.remove('drag'));
    // stopPropagation: otherwise the window drop handler loads it again and the two
    // handleFiles runs race, doubling the study.
    ovDrop.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); ovDrop.classList.remove('drag'); collectDropped(e.dataTransfer)?.then(openStudy); });
  }

  // ---- Sample studies ----
  // Built in-browser by tests/dicom-forge.js (the same forge the test suites use), loaded
  // lazily on first click. Deployments must keep tests/ or these buttons break.
  let forgeP = null;
  const loadForge = () => forgeP || (forgeP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'tests/dicom-forge.js';
    s.onload = () => window.Forge ? res(window.Forge) : rej(new Error('the forge did not register'));
    // Clear the cached promise on failure so a later click can retry.
    s.onerror = () => { forgeP = null; rej(new Error('tests/dicom-forge.js could not be loaded')); };
    document.head.appendChild(s);
  }));

  async function loadSamples(which) {
    const btns = [...document.querySelectorAll('.ov-sample-btn')];
    btns.forEach(b => { b.disabled = true; });
    try {
      showLoading?.(true, T('Building sample…'));
      const forge = await loadForge();
      const all = forge.samples();
      const pick = which === '*' ? all : all.filter(s => s.id === which);
      if (!pick.length) throw new Error('no sample called ' + which);
      // Same path as a real drop, no special casing.
      await handleFiles(pick.map(s => new File([s.bytes], s.file, { type: 'application/dicom' })));
    } catch (err) {
      showLoading?.(false);
      toast?.(T('Could not build the sample files.') + ' ' + (err.message || err));
    } finally {
      btns.forEach(b => { b.disabled = false; });
    }
  }
  document.querySelectorAll('.ov-sample-btn').forEach(b =>
    b.addEventListener('click', () => loadSamples(b.dataset.sample)));

  // Used by the #sample= / #case= deep links outside this closure.
  window.__loadSample = loadSamples;
  window.__loadForge  = loadForge;

  // ---- Study switcher + action launcher ----
  $('ovPrevStudy')?.addEventListener('click', () => { if (currentFileIdx > 0) switchFile(currentFileIdx - 1); });
  $('ovNextStudy')?.addEventListener('click', () => { if (currentFileIdx < files.length - 1) switchFile(currentFileIdx + 1); });
  // Compare is a mode of the editor table: open it with the next file already selected.
  document.querySelectorAll('.ov-act').forEach(b => b.addEventListener('click', () => {
    switchTab(b.dataset.tab);
    if (b.id === 'ovActCompare' && files.length > 1) {
      compareIdx = (currentFileIdx + 1) % files.length;
      renderCompareUI();
      renderTable();
    }
    // The Image edits card sits at the bottom of a scrollable sidebar; scroll to and highlight it.
    if (b.id === 'ovActImage') window.revealImgEditCard?.();
  }));

  // Both sit inside #ovDrop, whose background click also opens the file picker.
  $('ovFilesBtn')?.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
  $('ovFolderBtn')?.addEventListener('click', e => { e.stopPropagation(); openFolder('study'); });

  // Open another file at any time (button, or drop anywhere on the loaded overview).
  $('ovOpenBtn')?.addEventListener('click', () => fileInput.click());
  const ovContent = $('ovContent');
  if (ovContent) {
    ovContent.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); ovContent.classList.add('ov-dragover'); });
    ovContent.addEventListener('dragleave', e => { if (!ovContent.contains(e.relatedTarget)) ovContent.classList.remove('ov-dragover'); });
    // stopPropagation prevents a double load by the window drop handler.
    ovContent.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); ovContent.classList.remove('ov-dragover'); collectDropped(e.dataTransfer)?.then(openStudy); });
  }

  // ---- Print / export as PDF ----
  // Light-theme report of the overview data via the browser print dialog; works offline.
  function ovReportSections() {
    const r = lookupTag(dict,'00280010')?.Value?.[0], c = lookupTag(dict,'00280011')?.Value?.[0];
    const name = txt('00100010');
    const pn = name ? (patientShown() ? name : '•••••••• (hidden on screen)') : '';
    return [
      { title: 'Featured — clinical', rows: [
        ['Patient Name', pn], ['Patient ID', txt('00100020')], ['Sex', txt('00100040')],
        ['Age', txt('00101010')], ['Modality', txt('00080060')], ['Study Description', txt('00081030')],
        ['Study Date', fmtDate(txt('00080020'))], ['Series Description', txt('0008103E')], ['Body Part', txt('00180015')]
      ]},
      { title: 'Technical', rows: [
        ['SOP Instance UID', txt('00080018')], ['Transfer Syntax UID', metaTxt('00020010')],
        ['Photometric Interpretation', txt('00280004')], ['Image Position (Patient)', txt('00200032')],
        ['Pixel Spacing', txt('00280030')], ['Window Center', txt('00281050')], ['Window Width', txt('00281051')],
        ['Specific Character Set', txt('00080005')], ['Rows × Columns', r && c ? `${r} × ${c}` : ''],
        ['SHA-256 (file as loaded)', (() => {
          const e = files[currentFileIdx];
          if (!e || !e.sha) return e && e.shaState === 'deferred' ? '(not computed — large file)' : '';
          return e.sha + ((typeof datasetDirty !== 'undefined' && datasetDirty) ? '  — note: working copy edited this session; an exported file will differ' : '');
        })()]
      ]},
      { title: 'RIS / Workflow', rows: [
        ['Accession Number', risVal('00080050')], ['Study ID', txt('00200010')],
        ['Referring Physician', txt('00080090')], ['Requesting Physician', txt('00321032')],
        ['Requesting Service', txt('00321033')], ['Requested Procedure ID', risVal('00401001')],
        ['Requested Procedure Desc.', txt('00321060')], ['Scheduled Step ID', risVal('00400009')],
        ['Scheduled Step Desc.', risVal('00400007')], ['Performed Step ID', txt('00400253')],
        ['Reason for Request', txt('00401002') || txt('00321030')], ['Admission ID', txt('00380010')],
        ['Performing Physician', txt('00081050')], ['Operators', txt('00081070')]
      ]},
      { title: 'Equipment', rows: [
        ['Manufacturer', txt('00080070')], ['Model', txt('00081090')], ['Station Name', txt('00081010')],
        ['Institution', txt('00080080')], ['Software Versions', txt('00181020')], ['Device Serial', txt('00181000')]
      ]}
    ];
  }

  function printOverview() {
    if (!dict) { if (window.toast) toast(T('Open a DICOM file first')); return; }
    const fileName = files[currentFileIdx]?.name || 'DICOM study';
    const now = new Date();
    const stamp = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0') +
                  ' ' + String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');

    // Current canvas as PNG, if an image is rendered.
    let imgTag = '';
    try { if (ovRaw && canvas && canvas.width) imgTag = `<img class="ov-shot" src="${canvas.toDataURL('image/png')}" alt="DICOM image">`; } catch (_) {}

    const sectionHtml = ovReportSections().map(sec => {
      const rows = sec.rows.map(([k, v]) =>
        `<tr><th>${esc(k)}</th><td${v ? '' : ' class="empty"'}>${v ? esc(v) : '—'}</td></tr>`).join('');
      return `<section><h2>${esc(sec.title)}</h2><table class="kv">${rows}</table></section>`;
    }).join('');

    let valHtml = '';
    try {
      const issues = validateDicom(dict, meta) || [];
      if (!issues.length) {
        valHtml = `<section><h2>Validation</h2><p class="ok">✓ No conformance issues found</p></section>`;
      } else {
        const cnt = s => issues.filter(i => i.sev === s).length;
        const badges = `<p class="valcounts">${cnt('error')} error(s) · ${cnt('warning')} warning(s) · ${cnt('phi')} PHI flag(s) · ${cnt('info')} info</p>`;
        const list = issues.slice(0, 60).map(iss =>
          `<tr><th>${esc(iss.sev.toUpperCase())}</th><td>${esc(fmtTag('x'+iss.tag.toLowerCase()))} ${esc(iss.desc)}${iss.msg && iss.sev!=='phi' ? ' — '+esc(iss.msg) : ''}</td></tr>`).join('');
        const more = issues.length > 60 ? `<tr><th></th><td>+${issues.length-60} more…</td></tr>` : '';
        valHtml = `<section><h2>Validation</h2>${badges}<table class="valtable">${list}${more}</table></section>`;
      }
    } catch (_) {}

    const body = `${imgTag}${sectionHtml}${valHtml}`;
    carinoBrandedPrint({
      title: 'DICOM Study Overview',
      subtitle: `${fileName} · generated ${stamp}`,
      meta: 'Carino DICOM Editor',
      body
    });
  }
  $('ovPrintBtn')?.addEventListener('click', printOverview);
  window.printOverview = printOverview;

  // Position as Study / Series / Image, printing only levels with more than one member.
  function studyIdxLabel() {
    const studies = groupStudies(), series = groupSeries();
    const cur = series.find(s => s.indices.includes(currentFileIdx));
    const bits = [];
    if (studies.length > 1) {
      const si = studies.findIndex(s => s.indices.includes(currentFileIdx));
      bits.push(`${T('Study')} ${si + 1} / ${studies.length}`);
    }
    if (series.length > 1) bits.push(`${T('Series')} ${series.indexOf(cur) + 1} / ${series.length}`);
    if (cur && cur.indices.length > 1) bits.push(`${T('Image')} ${cur.indices.indexOf(currentFileIdx) + 1} / ${cur.indices.length}`);
    return bits.join(' · ') || `${currentFileIdx + 1} / ${files.length}`;
  }

  // ---- Render entry point ----
  let renderedIdx = -1;
  // `hardReset: false` (wheel paging within a series) keeps W/L, zoom, pan and colormap;
  // every other caller resets the view.
  window.renderOverview = function (opts) {
    const hardReset = !(opts && opts.hardReset === false);
    const empty = $('ovEmpty'), content = $('ovContent');
    if (!dict) { renderedIdx = -1; stopCine(); empty?.classList.remove('hidden'); content?.classList.add('hidden'); return; }
    empty?.classList.add('hidden'); content?.classList.remove('hidden');
    const multi = files.length > 1;
    $('ovStudyName').textContent = files[currentFileIdx]?.name || '—';
    $('ovStudyIdx').textContent = multi ? studyIdxLabel() : '';
    $('ovPrevStudy').classList.toggle('hidden', !multi);
    $('ovNextStudy').classList.toggle('hidden', !multi);
    if (multi) { $('ovPrevStudy').disabled = currentFileIdx <= 0; $('ovNextStudy').disabled = currentFileIdx >= files.length - 1; }
    // Nothing to compare against until a second file is loaded.
    const cmpAct = $('ovActCompare');
    if (cmpAct) cmpAct.disabled = !multi;
    renderCore(); renderTech(); renderRis(); renderMfr(); renderOvValidation();
    // Always reset: the old frame index may be out of range for the new file.
    view.frame = 0;
    stopCine();
    if (hardReset) {
      view.wc = null; view.ww = null; view.invert = false; view.cmap = 'gray';
      view.rotate = 0; view.flipH = false; view.flipV = false; view.zoom = 1; view.panX = 0; view.panY = 0;
      $('ovInvert')?.classList.remove('active'); $('ovFlipH')?.classList.remove('active'); $('ovFlipV')?.classList.remove('active');
      const cm = $('ovColormap'); if (cm) cm.value = 'gray';
    }
    // Seed cine rate from the new file's tags; a user-typed rate lasts until the next file change.
    cine.fps = tagFrameRate();
    const fpsBox = $('ovCineFps'); if (fpsBox) fpsBox.value = cine.fps;
    renderedIdx = currentFileIdx;
    loadImage();
  };

  // Called by switchTab: render if the current file hasn't been drawn here yet.
  window.ovEnsureRendered = function () { if (dict && renderedIdx !== currentFileIdx) renderOverview(); };

  // Viewport-only handle for outside this IIFE (image edits reset orientation after rotating the file).
  window.ovView = { view, applyTransform };
})();

