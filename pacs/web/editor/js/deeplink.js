// Deep-link loader: open a study from Carino DICOM (PACS) or a forged sample/test case.
// The hash may name a module first (#edit&sample=ct); js/events.js routes that part, and every
// parser below looks for its own key after a "#" or "&", so either order works.
//  (A) Carino Bridge (#carino-bridge): for an HTTPS editor and an http://localhost PACS, where
//      mixed content blocks fetching; the PACS posts the bytes instead.
//  (B) Direct fetch (#load=<manifestUrl>): same-origin / localhost editor.
// Security: same-origin (the editor bundled in the PACS) and localhost are trusted; any other
// origin must be approved by the user, or any web page could fill this editor with files of its
// choosing. Both paths hold to that.
window.addEventListener('load', () => {
  const hash = location.hash || location.search || '';

  // ---- (A) Carino Bridge ----
  let giveUp = null;
  // A declined or abandoned hand-off must not re-arm on reload (carino-bridge.js only drops the
  // marker once the files are accepted), or a reload spins for 60 s against a sender that is gone.
  const dropBridgeMarker = () => {
    if (/(^|[#&?])carino-bridge\b/.test(location.hash + location.search))
      try { history.replaceState(null, '', location.pathname +
            (/carino-bridge\b/.test(location.search) ? '' : location.search)); } catch (_) {}
  };
  const armed = window.CarinoBridge && CarinoBridge.receive({
    legacy: true,                 // PACS builds older than the bridge still speak carino-pacs-*
    allow: ['same-origin',        // the editor Carino DICOM serves itself
            'https://files.carino.systems'],   // and the fleet's file screen
    otherwise: 'ask',             // anyone else: shown to the user, by origin
    remember: true,               // and only asked about once per browser
    ask: (origin, count) => new Promise(resolve => {
      clearTimeout(giveUp);
      showLoading?.(false);       // the spinner has nothing to say over a question
      // The grant is remembered per browser (remember: true), so the question says so.
      const host = new URL(origin).host;
      confirmDanger(
        T('{host} wants to open {n} file(s) in this editor.').replace('{host}', host).replace('{n}', count)
          + ' ' + T('This browser will remember the choice for {host}.').replace('{host}', host),
        () => resolve(true), 'Load files', () => { dropBridgeMarker(); resolve(false); }, { safeDefault: true });
    }),
    onFiles: async (incoming, info) => {
      clearTimeout(giveUp);
      // An order for Create (js/create.js, "Prefill") rather than a study to open.
      try {
        if (await takeCreateHandoff(incoming, info)) { showLoading?.(false); return; }
      } catch (err) { showLoading?.(false); toast?.(err.message || String(err)); return false; }
      showLoading?.(true, TF('Copying study from {from}…', { from: 'Carino DICOM' }));
      try {
        const n = await handleFiles(incoming);   // shows its own per-image progress
        // Label by actual origin: a user-approved origin is still not the bundled PACS.
        const from = info.origin === location.origin ? 'Carino DICOM' : new URL(info.origin).host;
        // Count parsed files, not received ones (files[] may still hold the previous
        // study); handleFiles already reports the failures.
        // false = 'declined' to the sender, so it does not report a hand-off that did not happen.
        if (!n) { toast?.(T('Nothing from {from} could be read as DICOM').replace('{from}', from)); return false; }
        switchTab('editor');
        toast?.(T('Loaded {n} image(s) from {from}').replace('{n}', n).replace('{from}', from));
      } catch (err) { showLoading?.(false); toast?.(T('PACS hand-off failed:') + ' ' + (err.message || err)); return false; }
    },
  });
  if (armed) {
    showLoading?.(true, TF('Copying study from {from}…', { from: 'Carino DICOM' }));       // spinner until the bytes arrive
    giveUp = setTimeout(() => { dropBridgeMarker(); showLoading?.(false); toast?.(T('No response from Carino DICOM')); }, 60000);
    return;
  }

  // ---- (A1a) Create prefill: #create[=eye]&patient_id=… (format in js/create.js) ----
  // From the hash only (parseCreateHash refuses a query string, which reaches server logs).
  // A bare #create is only the module link (js/events.js has opened it); an order names a kind
  // (#create=eye) or carries a field.
  const order = parseCreateHash(location.hash);
  if (order && (order.kind || Object.keys(order).length > 1)) {
    // Read once, then gone from the address bar and from history; the module stays named.
    try { history.replaceState(null, '', location.pathname + location.search + '#create'); } catch (_) {}
    applyCreatePrefill(order);
    return;
  }

  // ---- (A1b) Browser self-test ----
  // Same guards as the deep links; also requires an empty page since the suites load files.
  if (selftestWanted(hash, files.length)) { runSelfTest(); return; }

  // ---- (A2) Forged deep links ----
  // #sample=<id> (empty-state samples) or #case=<id> (test corpus): reproducible bug-report URLs.
  // Never alongside #load= or over open files: handleFiles() wipes files, edits and history.
  const deep = /[#&?](case|sample)=([\w.*-]+)/.exec(hash);
  if (deep && !/[#&?]load=/.test(location.hash + location.search) && !files.length) {
    (async () => {
      try {
        showLoading?.(true, T('Building sample…'));
        if (deep[1] === 'sample') { await window.__loadSample(deep[2]); return; }
        const forge = await window.__loadForge();
        const c = (await forge.corpus()).find(x => x.id === deep[2]);
        if (!c) throw new Error('no test case called ' + deep[2]);
        await handleFiles([new File([c.bytes], c.id + '.dcm', { type: 'application/dicom' })]);
      } catch (err) {
        showLoading?.(false);
        toast?.(T('Could not build the sample files.') + ' ' + (err.message || err));
      }
    })();
    return;
  }

  // ---- (B) Direct fetch ----
  // From the hash only: a query string reaches server logs (as parseCreateHash refuses it).
  const m = /[#&]load=([^&]+)/.exec(location.hash);
  if (!m) return;
  let manifest;
  try { manifest = new URL(decodeURIComponent(m[1]), location.href); } catch { return; }
  try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {}
  if (manifest.protocol !== 'http:' && manifest.protocol !== 'https:') {
    toast?.(T('PACS deep-link failed:') + ' ' + T('That link is not allowed.'));
    return;
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(manifest.hostname);
  const trusted = manifest.origin === location.origin || local;
  const from = manifest.origin === location.origin ? 'Carino DICOM' : manifest.host;
  const fetchStudy = async () => {
    try {
      showLoading?.(true, T('Copying study from {from}…').replace('{from}', from));
      const res = await fetch(manifest.href, { credentials: 'omit' });
      if (!res.ok) throw new Error('manifest HTTP ' + res.status);
      const data = await res.json();
      const entries = Array.isArray(data?.files) ? data.files.filter(e => e && typeof e.url === 'string') : [];
      if (!entries.length) throw new Error(data && typeof data.message === 'string' ? data.message : 'no DICOM files in study');
      if (entries.length > LARGE_STUDY) {
        showLoading?.(false);
        const go = await new Promise(r => confirmDanger(
          T('This study has {n} files. Loading them all may take a while and use a lot of memory.').replace('{n}', entries.length),
          () => r(true), 'Load all', () => r(false)));
        if (!go) return;
      }
      const loaded = [];
      for (let n = 0; n < entries.length; n++) {
        const e = entries[n];
        showLoading?.(true, T('Copying study from {from}…').replace('{from}', from), n / entries.length, `${n + 1} / ${entries.length}`);
        let url;
        try { url = new URL(e.url, manifest.href); } catch (err) { log?.(`✗ manifest entry ${n + 1}: ${err.message}`); continue; }
        // A manifest names files on its own server, never a third party.
        if (url.origin !== manifest.origin) { log?.(`✗ manifest entry ${n + 1}: not on ${manifest.host}`); continue; }
        try {
          const r = await fetch(url.href, { credentials: 'omit' });
          if (!r.ok) continue;
          const rel = typeof e.name === 'string' && e.name ? e.name.slice(0, 512) : 'study.dcm';
          const base = rel.split(/[\\/]/).pop() || 'study.dcm';
          loaded.push({ file: new File([await r.blob()], base), path: rel });
        } catch { /* skip a file that won't fetch */ }
      }
      if (!loaded.length) throw new Error('could not fetch any DICOM file');
      const n = await handleFiles(loaded);
      if (!n) throw new Error('no file could be read as DICOM');
      switchTab('editor');
      toast?.(T('Loaded {n} image(s) from {from}').replace('{n}', n).replace('{from}', from));
    } catch (err) {
      showLoading?.(false);
      toast?.(T('PACS deep-link failed:') + ' ' + (err.message || err));
    }
  };
  if (trusted) { fetchStudy(); return; }
  // Nothing is fetched from a foreign host until the user says yes.
  confirmDanger(T('A link asks this editor to load files from {host}.').replace('{host}', manifest.host),
                () => fetchStudy(), 'Load files', null, { safeDefault: true });
});

