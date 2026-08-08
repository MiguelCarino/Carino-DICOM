// A study is a folder, not a tidy list of *.dcm.
//
// What comes off a burned CD or out of a PACS export is a tree of extensionless
// files with a DICOMDIR index and whatever else the disc author left behind.
// This suite covers the parts of that path a page script can reach: the DICM
// sniff, the entry-tree walk (against duck-typed FileSystemEntry fakes, because
// a real folder drop cannot be synthesised from script), the DataTransfer
// snapshot, the drop routing, and what loadStudy keeps and throws away.
(window.SUITES || (window.SUITES = {})).folder = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);

  // Duck-typed FileSystemEntry. Chrome's real reader hands back a partial batch
  // and expects to be asked again, so the fake does the same — a reader that
  // answered everything at once would let the batching bug through.
  const BATCH = 100;
  const dirEntry = (name, kids) => ({
    isFile: false, isDirectory: true, name,
    createReader() {
      let i = 0;
      return { readEntries(cb) { const b = kids.slice(i, i + BATCH); i += b.length; cb(b); } };
    },
  });
  const fileEntry = (name, file) => ({ isFile: true, isDirectory: false, name, file(cb) { cb(file); } });
  // Enough for the sniff and for dcmjs; the bytes are never DICM.
  const junkFile = (name) => new File([new Uint8Array(300).fill(0x41)], name);

  // Counted in turns of the event loop, not in milliseconds: the suites run under
  // --virtual-time-budget, where the clock leaps forward whenever the queue drains
  // and a wall-clock deadline expires before the work it is waiting on has run.
  const settle = async (pred, tries = 3000) => {
    for (let i = 0; i < tries && !pred(); i++) await new Promise(r => setTimeout(r, 0));
    return pred();
  };

  try {
    const slice = (i) => {
      const n = Forge.W * Forge.H;
      const px = new Uint16Array(n);
      for (let k = 0; k < n; k++) px[k] = (k + i * 300) & 0xFFF;
      return Forge.build({
        rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
        wc: 2048, ww: 4096, modality: 'CT',
        studyUID: '1.2.826.0.1.3680043.10.99999.8.1',
        seriesUID: '1.2.826.0.1.3680043.10.99999.8.2',
        instance: i + 1, sopInstance: `1.2.826.0.1.3680043.10.99999.8.3.${i + 1}`,
        pixels: px,
      });
    };
    const dcm = (name, i) => new File([slice(i)], name);

    // ---- the sniff ----------------------------------------------------------
    ok('DICM magic identifies a forged file with no extension',
       await isDicomFile(dcm('IM000001', 0)) === true);
    ok('a file with no preamble is not DICOM',
       await isDicomFile(junkFile('README.TXT')) === false);
    let threw = false, shortAnswer = null;
    try { shortAnswer = await isDicomFile(new File([new Uint8Array(64)], 'x')); } catch (_) { threw = true; }
    ok('a file shorter than 132 bytes is not DICOM, and does not throw',
       !threw && shortAnswer === false, threw ? 'threw' : String(shortAnswer));
    // A .dcm that is not one is exactly the case the extension test got wrong in
    // the other direction.
    ok('an extension does not make a file DICOM',
       await isDicomFile(junkFile('mislabelled.dcm')) === false);

    // ---- draining readEntries ----------------------------------------------
    {
      const kids = Array.from({ length: 200 }, (_, i) => fileEntry(`f${i}`, junkFile(`f${i}`)));
      const all = await readAllEntries(dirEntry('d', kids).createReader());
      ok('readEntries is drained, not sampled', all.length === 200, String(all.length));
    }

    // ---- the walk -----------------------------------------------------------
    // The shape a PACS export actually has, including the two-deep file the
    // scout confirmed a real Chromium drop reaches.
    const tree = dirEntry('study', [
      fileEntry('IM000001', dcm('IM000001', 0)),
      fileEntry('DICOMDIR', dcm('DICOMDIR', 9)),
      fileEntry('README.TXT', junkFile('README.TXT')),
      fileEntry('thumb.jpg', junkFile('thumb.jpg')),
      dirEntry('SER001', [
        fileEntry('I0000001', dcm('I0000001', 1)),
        fileEntry('I0000002', dcm('I0000002', 2)),
      ]),
      dirEntry('SER002', [
        dirEntry('sub', [fileEntry('00000123', dcm('00000123', 3))]),
      ]),
    ]);

    {
      const walked = [];
      await walkEntry(tree, '', walked);
      ok('nested subdirectories are walked', walked.length === 7, String(walked.length));
      const paths = walked.map(w => w.path);
      ok('a file two directories down keeps its whole path',
         paths.includes('study/SER002/sub/00000123'), paths.join(' '));
      ok('a file one directory down keeps its series folder',
         paths.includes('study/SER001/I0000002'), paths.join(' '));
      ok('a file at the root of the drop keeps just its name',
         paths.includes('study/IM000001'));
    }

    // ---- the scan cap -------------------------------------------------------
    {
      const tiny = junkFile('t');
      const many = dirEntry('huge', Array.from({ length: MAX_SCAN_FILES + 5000 }, (_, i) => fileEntry('f' + i, tiny)));
      const res = await collectDropped({ items: [{ kind: 'file', webkitGetAsEntry: () => many }], files: [] });
      ok('the scan cap holds', res.items.length === MAX_SCAN_FILES, String(res.items.length));
      ok('a capped scan says so', res.truncated === true);
    }

    // ---- the DataTransfer snapshot -----------------------------------------
    {
      const f = dcm('flat.dcm', 0);
      // Every DataTransfer built in script answers null from webkitGetAsEntry
      // even with items and files intact, so this fallback carries every
      // programmatic drop there is — including the two dispatched below.
      const res = await collectDropped({ items: [{ kind: 'file', webkitGetAsEntry: () => null }], files: [f] });
      ok('a synthetic DataTransfer falls back to the flat file list',
         res.items.length === 1 && res.items[0].file === f, String(res.items.length));
      ok('a flat drop is not a folder', res.fromFolder === false);
      ok('an empty drop collects nothing at all', collectDropped({ items: [], files: [] }) === null);
      const dirDrop = await collectDropped({ items: [{ kind: 'file', webkitGetAsEntry: () => tree }], files: [] });
      ok('a dropped directory is recognised as one', dirDrop.fromFolder === true);
    }

    // ---- what a folder load keeps ------------------------------------------
    await loadStudy(await collectDropped({ items: [{ kind: 'file', webkitGetAsEntry: () => tree }], files: [] }));

    ok('a folder load keeps only what parses as DICOM', files.length === 4, String(files.length));
    ok('DICOMDIR is left out of a folder load',
       !files.some(f => /DICOMDIR/i.test(f.name)), files.map(f => f.name).join(','));
    ok('junk in a folder does not raise the failure banner',
       errorBanner.className === 'hidden', errorBanner.className);
    ok('each loaded file carries the folder it came from',
       files.map(f => f.path).includes('study/SER002/sub/00000123'),
       files.map(f => f.path).join(' '));
    ok('the download name stays a basename',
       files.every(f => !f.name.includes('/')), files.map(f => f.name).join(','));
    ok('each walked file keeps its own working copy',
       new Set(files.map(f => f.pending)).size === 4,
       String(new Set(files.map(f => f.pending)).size));

    // A disc that holds nothing but its index is the one case where dropping
    // DICOMDIR would leave the user with nothing.
    {
      const only = dirEntry('idx', [fileEntry('DICOMDIR', dcm('DICOMDIR', 5))]);
      await loadStudy(await collectDropped({ items: [{ kind: 'file', webkitGetAsEntry: () => only }], files: [] }));
      ok('a folder holding only a DICOMDIR still loads it', files.length === 1, String(files.length));
    }

    // ---- what an explicitly named file still reports ------------------------
    {
      await loadStudy({ items: [{ file: junkFile('junk.bin'), path: 'junk.bin' }], fromFolder: false });
      ok('an explicitly picked non-DICOM still reports',
         errorBanner.className === 'error-banner' && errorBanner.textContent.includes('junk.bin'),
         errorBanner.className);
    }

    // ---- routing ------------------------------------------------------------
    // Bug (ii): the window drop handler only had branches for 'create' and
    // 'editor', so a drop on the Overview background did nothing whatsoever.
    {
      activeTab = 'overview';
      const f = dcm('routed.dcm', 0);
      const ev = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: { items: [{ kind: 'file', webkitGetAsEntry: () => null }], files: [f] } });
      files = [];
      window.dispatchEvent(ev);
      ok('a drop on the Overview background loads the file',
         await settle(() => files.length === 1), String(files.length));
      ok('and it is the file that was dropped', files[0]?.name === 'routed.dcm', files[0]?.name);
    }
    {
      activeTab = 'overview';
      const ev = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: { items: [{ kind: 'file', webkitGetAsEntry: () => tree }], files: [] } });
      files = [];
      window.dispatchEvent(ev);
      ok('a folder dropped on the Overview background loads the study',
         await settle(() => files.length === 4), String(files.length));
    }
    // The drop card sits inside the background that now also listens, so without
    // stopPropagation both handlers run and two handleFiles calls reset files[]
    // out from under each other — the study arrives doubled.
    {
      activeTab = 'overview';
      const ev = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: { items: [{ kind: 'file', webkitGetAsEntry: () => tree }], files: [] } });
      files = [];
      document.getElementById('ovDrop').dispatchEvent(ev);
      await settle(() => files.length >= 4);
      await settle(() => false, 60);   // let a second, racing load arrive if there is one
      ok('a drop on the card is not loaded twice', files.length === 4, String(files.length));
    }

    // ---- the large-study gate ----------------------------------------------
    // The confirm has to come before handleFiles, which wipes files, edits and
    // history at its top: a cancelled load that had already got there would have
    // destroyed the study the user was looking at.
    {
      const keep = files.slice();
      // Only the four bytes at offset 128 decide the gate, and the load is
      // cancelled before anything is parsed, so a 200-byte stub stands in for
      // four hundred CT slices.
      const stub = new Uint8Array(200);
      stub.set([0x44, 0x49, 0x43, 0x4D], 128);
      const tiny = new File([stub], 'IM000001');
      const big = dirEntry('big', Array.from({ length: LARGE_STUDY + 1 }, (_, i) => fileEntry('IM' + i, tiny)));
      const p = loadStudy(await collectDropped({ items: [{ kind: 'file', webkitGetAsEntry: () => big }], files: [] }));
      const overlay = document.getElementById('confirmOverlay');
      ok('a large folder asks before loading',
         await settle(() => overlay.classList.contains('visible')),
         overlay.className);
      ok('the question names the count',
         document.getElementById('confirmMsg').textContent.includes(String(LARGE_STUDY + 1)),
         document.getElementById('confirmMsg').textContent);
      document.getElementById('confirmCancel').click();
      await p;
      ok('cancelling a large folder leaves the open study alone',
         files.length === keep.length && files[0] === keep[0], String(files.length));
    }

    // ---- the Extract tab ----------------------------------------------------
    // Bug (iii): addExtractorFiles filtered on ['dcm','dicom'], so relaxing the
    // picker alone would still have thrown every PACS slice away in silence.
    {
      extractorFiles = [];
      await addExtractorFiles([
        { file: dcm('IM000001', 0), path: 'study/SER001/IM000001' },
        { file: junkFile('README.TXT'), path: 'study/README.TXT' },
      ]);
      ok('an extensionless file reaches the Extract tab',
         extractorFiles.length === 1, String(extractorFiles.length));
      // A DICOMDIR card would render "No image data" at the head of the grid.
      extractorFiles = [];
      await addExtractorFiles([
        { file: dcm('DICOMDIR', 9), path: 'study/DICOMDIR' },
        { file: dcm('IM000001', 0), path: 'study/IM000001' },
      ]);
      ok('the Extract tab leaves the disc index out too',
         extractorFiles.length === 1 && extractorFiles[0].name === 'IM000001',
         extractorFiles.map(x => x.name).join(','));
      extractorFiles = [];
      await addExtractorFiles([
        { file: dcm('IM000001', 0), path: 'study/SER001/IM000001' },
      ]);
      ok('and junk beside it does not',
         !extractorFiles.some(x => /README/.test(x.name)));
      ok('the extract entry keeps its folder path',
         extractorFiles[0]?.path === 'study/SER001/IM000001', extractorFiles[0]?.path);
      ok('a PNG export name has no slashes in it',
         extractorBase(extractorFiles[0]) === 'study_SER001_IM000001',
         extractorBase(extractorFiles[0]));
      extractorFiles = [];
      // A plain File[] is what the picker and the old callers hand over.
      await addExtractorFiles([dcm('plain.dcm', 0)]);
      ok('addExtractorFiles still accepts a plain File list',
         extractorFiles.length === 1 && extractorFiles[0].name === 'plain.dcm',
         String(extractorFiles.length));
      extractorFiles = [];
    }

    // ---- the picker markup --------------------------------------------------
    {
      const fi = document.getElementById('fileInput');
      ok('the file picker no longer filters by extension', !fi.hasAttribute('accept'));
      ok('the extract picker no longer filters by extension',
         !document.getElementById('extractorFileInput').hasAttribute('accept'));
      const dir = document.getElementById('folderInput');
      ok('there is a directory picker', !!dir && dir.hasAttribute('webkitdirectory') && dir.multiple);
      ok('every tab that loads files can open a folder',
         !!document.getElementById('ovFolderBtn') && !!document.getElementById('folderBtn') &&
         !!document.getElementById('extractorFolderBtn'));

      // Files and folders are one panel, not a panel and a button beside it.
      // The folder picker used to be kept outside the drop card because the card
      // was role="button" and swallowed the click; it is inside now, and what
      // has to hold instead is that pressing it opens ONE dialog. A folder
      // button that also fires the drop zone's own click gives the user the file
      // dialog stacked behind the folder one.
      for (const [btn, zone] of [['ovFolderBtn', 'ovDrop'], ['folderBtn', 'dropZone'],
                                 ['extractorFolderBtn', 'extractorDropZone']]) {
        ok(`${btn} sits inside its drop zone`,
           document.getElementById(zone).contains(document.getElementById(btn)));
      }
      {
        const opened = [];
        const realFile = fileInput.click.bind(fileInput);
        const realDir  = folderInput.click.bind(folderInput);
        fileInput.click   = () => opened.push('files');
        folderInput.click = () => opened.push('folder');
        try {
          document.getElementById('ovFolderBtn').click();
          ok('and opening a folder does not also open the file picker',
             opened.join(',') === 'folder', opened.join(',') || '(nothing opened)');
          opened.length = 0;
          document.getElementById('ovFilesBtn').click();
          ok('and the files button opens only the file picker',
             opened.join(',') === 'files', opened.join(',') || '(nothing opened)');
        } finally {
          fileInput.click = realFile;
          folderInput.click = realDir;
        }
      }
      // A container that holds buttons cannot itself be one — a screen reader
      // has no way to describe a button inside a button.
      ok('the drop card is not a button now that it holds two',
         document.getElementById('ovDrop').getAttribute('role') !== 'button' &&
         !document.getElementById('ovDrop').hasAttribute('tabindex'));
    }
  } catch (e) {
    ok('suite ran to completion', false, (e && e.message) || String(e));
    console.error(e);
  }

  return out;
};

// Two callers: tests/run.sh injects this file alone and scrapes the <pre> below;
// index.html#selftest sets window.SELFTEST and awaits the returned lines instead.
if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.folder()).join('\n');
  document.body.appendChild(pre);
});
