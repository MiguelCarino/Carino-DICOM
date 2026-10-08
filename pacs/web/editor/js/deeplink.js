// Deep-link loader: open a study from Carino DICOM (PACS) or a forged sample/test case.
//  (A) Carino Bridge (#carino-bridge): for an HTTPS editor and an http://localhost PACS, where
//      mixed content blocks fetching; the PACS posts the bytes instead.
//  (B) Direct fetch (#load=<manifestUrl>): same-origin / localhost editor.
// Security: same-origin (the editor bundled in the PACS) is trusted; any other origin must be
// approved by the user, or any web page could fill this editor with files of its choosing.
window.addEventListener('load', () => {
  const hash = location.hash || location.search || '';

  // ---- (A) Carino Bridge ----
  let giveUp = null;
  const armed = window.CarinoBridge && CarinoBridge.receive({
    legacy: true,                 // PACS builds older than the bridge still speak carino-pacs-*
    allow: ['same-origin',        // the editor Carino DICOM serves itself
            'https://media.carino.systems'],   // and the fleet's file screen
    otherwise: 'ask',             // anyone else: shown to the user, by origin
    remember: true,               // and only asked about once per browser
    ask: (origin, count) => new Promise(resolve => {
      clearTimeout(giveUp);
      showLoading?.(false);       // the spinner has nothing to say over a question
      confirmDanger(
        T('{host} wants to open {n} file(s) in this editor.').replace('{host}', new URL(origin).host).replace('{n}', count),
        () => resolve(true), 'Load files', () => resolve(false));
    }),
    onFiles: async (incoming, info) => {
      clearTimeout(giveUp);
      showLoading?.(true, 'Copying study from Carino DICOM…');
      try {
        const n = await handleFiles(incoming);   // shows its own per-image progress
        // Label by actual origin: a user-approved origin is still not the bundled PACS.
        const from = info.origin === location.origin ? 'Carino DICOM' : new URL(info.origin).host;
        // Count parsed files, not received ones (files[] may still hold the previous
        // study); handleFiles already reports the failures.
        if (!n) { toast?.(T('Nothing from {from} could be read as DICOM').replace('{from}', from)); return; }
        switchTab('editor');
        toast?.(T('Loaded {n} image(s) from {from}').replace('{n}', n).replace('{from}', from));
      } catch (err) { showLoading?.(false); toast?.(T('PACS hand-off failed:') + ' ' + (err.message || err)); }
    },
  });
  if (armed) {
    showLoading?.(true, 'Copying study from Carino DICOM…');       // spinner until the bytes arrive
    giveUp = setTimeout(() => { showLoading?.(false); toast?.('No response from Carino DICOM'); }, 60000);
    return;
  }

  // ---- (A1b) Browser self-test ----
  // Same guards as the deep links; also requires an empty page since the suites load files.
  if (selftestWanted(hash, files.length)) { runSelfTest(); return; }

  // ---- (A2) Forged deep links ----
  // #sample=<id> (empty-state samples) or #case=<id> (test corpus): reproducible bug-report URLs.
  // Never alongside #load= or over open files: handleFiles() wipes files, edits and history.
  const deep = /[#&?](case|sample)=([\w.*-]+)/.exec(hash);
  if (deep && !/[#&?]load=/.test(hash) && !files.length) {
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
  const m = /[#&?]load=([^&]+)/.exec(hash);
  if (!m) return;
  let manifestUrl;
  try { manifestUrl = decodeURIComponent(m[1]); } catch { return; }
  (async () => {
    try {
      showLoading?.(true, 'Copying study from Carino DICOM…');
      const res = await fetch(manifestUrl, { credentials: 'omit' });
      if (!res.ok) throw new Error('manifest HTTP ' + res.status);
      const data = await res.json();
      const entries = (data && data.files) || [];
      if (!entries.length) throw new Error(data && data.message || 'no DICOM files in study');
      const loaded = [];
      for (let n = 0; n < entries.length; n++) {
        const e = entries[n];
        showLoading?.(true, 'Copying study from Carino DICOM…', n / entries.length, `${n + 1} / ${entries.length}`);
        try {
          const r = await fetch(new URL(e.url, manifestUrl).href, { credentials: 'omit' });
          if (!r.ok) continue;
          loaded.push(new File([await r.blob()], e.name || 'study.dcm'));
        } catch { /* skip a file that won't fetch */ }
      }
      if (!loaded.length) throw new Error('could not fetch any DICOM file');
      const n = await handleFiles(loaded);
      if (!n) throw new Error('no file could be read as DICOM');
      switchTab('editor');
      toast?.(T('Loaded {n} image(s) from {from}').replace('{n}', n).replace('{from}', 'Carino DICOM'));
    } catch (err) {
      showLoading?.(false);
      toast?.(T('PACS deep-link failed:') + ' ' + (err.message || err));
    }
  })();
});

