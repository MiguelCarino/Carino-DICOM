// Loading a study reads ahead of the parser, and nothing may fall out of order.
//
// handleFiles used to read one file, parse it, and only then ask the disk for
// the next — the CPU idle for every round trip. It now keeps a few reads in
// flight. That is a concurrency change on the one path every file in the app
// enters through, so what this suite pins down is that the concurrency is
// bounded, that it is bounded by bytes as well as by count, and above all that
// it changed nothing a user can see: same files, same order, same per-file
// failure handling.
//
// The files here are fakes rather than real File objects, on purpose. A fake can
// say it is 100 MB while holding four kilobytes, which is the only way to reach
// the byte cap without asking a test runner for 100 MB, and it can record the
// moment its read begins — which is what makes "did it actually run ahead?"
// something to measure rather than something to assume.
(window.SUITES || (window.SUITES = {})).loading = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const tag = (d, t) => { const e = lookupTag(d, t); return e ? elToString(e).trim() : ''; };

  // Reads are logged as they start; parses are logged with the number of reads
  // that had started by then. The gap between the two is the read-ahead depth.
  let reads = [];
  let parses = [];

  const slice = (i) => {
    const n = Forge.W * Forge.H;
    const px = new Uint16Array(n);
    for (let k = 0; k < n; k++) px[k] = (k + i * 97) & 0xFFF;
    return Forge.build({
      rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
      modality: 'CT', instance: i + 1,
      studyUID: '1.2.826.0.1.3680043.10.99999.11.1',
      seriesUID: '1.2.826.0.1.3680043.10.99999.11.2',
      sopInstance: `1.2.826.0.1.3680043.10.99999.11.3.${i + 1}`,
      pixels: px,
    });
  };

  // `claimedSize` is what handleFiles budgets with; `bytes` is what it gets.
  // `fail` makes the read itself reject, which is a different failure from a
  // buffer that turns out not to be DICOM and has to be handled just as locally.
  const fake = (name, bytes, { claimedSize, fail } = {}) => ({
    file: {
      name,
      size: claimedSize != null ? claimedSize : (bytes ? bytes.byteLength : 0),
      arrayBuffer() {
        reads.push(name);
        return fail ? Promise.reject(new Error('read failed')) : Promise.resolve(bytes);
      },
    },
    path: name,
  });

  const realReadFile = DicomMessage.readFile;
  const instrument = () => {
    reads = []; parses = [];
    DicomMessage.readFile = function (buf) { parses.push(reads.length); return realReadFile.call(this, buf); };
  };
  const restore = () => { DicomMessage.readFile = realReadFile; };

  try {
    // ---- twelve ordinary files ------------------------------------------------
    const N = 12;
    const bufs = [];
    for (let i = 0; i < N; i++) {
      const u = slice(i);
      bufs.push(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength));
    }

    instrument();
    await handleFiles(bufs.map((b, i) => fake(`s${i}.dcm`, b)));
    restore();

    ok('every file loads', files.length === N, String(files.length));
    ok('and in the order they were handed over',
       files.map(f => f.name).join(',') === bufs.map((_, i) => `s${i}.dcm`).join(','),
       files.map(f => f.name).join(','));
    // The failure a read-ahead invites: entry i built from entry i+1's buffer.
    // Every slice carries its own SOP Instance UID, so a swap is visible.
    const sops = files.map(f => tag(f.dict, '00080018'));
    const wantSops = bufs.map((_, i) => `1.2.826.0.1.3680043.10.99999.11.3.${i + 1}`);
    ok('and each one is built from its own bytes', sops.join(',') === wantSops.join(','),
       sops.map((s, i) => (s === wantSops[i] ? '.' : s)).join(','));

    ok('every file was read exactly once', reads.length === N, String(reads.length));
    ok('and read in order', reads.join(',') === bufs.map((_, i) => `s${i}.dcm`).join(','), reads.join(','));

    // parses[i] is how many reads had been issued when file i was parsed, so
    // parses[i] - i - 1 is how many files were already read and waiting. With no
    // read-ahead that is zero every time — the loop asking for one file at a time
    // — so anything above it is the disk and the parser overlapping.
    const depths = parses.map((r, i) => r - i - 1);
    ok('the reader runs ahead of the parser', depths[0] > 1, `${depths[0]} file(s) waiting at the first parse`);
    ok('but never by more than four files', Math.max(...depths) <= 4, depths.join(','));
    ok('and it keeps running ahead to the end of the list',
       parses[parses.length - 1] === N, `${parses[parses.length - 1]} of ${N}`);

    // ---- a file that claims to be enormous ------------------------------------
    // Depth alone is not a bound: four half-gigabyte cines in flight is a gigabyte
    // of heap held before one of them is parsed. The queue is capped by summed
    // size too, and the file at the head is admitted however big it is so one
    // oversized file cannot wedge the loop.
    const HUGE = 100 * 1024 * 1024;
    instrument();
    await handleFiles([
      fake('small0.dcm', bufs[0]),
      fake('huge.dcm', bufs[1], { claimedSize: HUGE }),
      fake('small2.dcm', bufs[2]),
      fake('small3.dcm', bufs[3]),
      fake('small4.dcm', bufs[4]),
      fake('small5.dcm', bufs[5]),
    ]);
    restore();

    const bigDepths = parses.map((r, i) => r - i - 1);
    ok('the oversized file loads with the rest of them', files.length === 6, String(files.length));
    ok('nothing queues up behind a file bigger than the budget', bigDepths[0] === 1,
       `${bigDepths[0]} file(s) waiting at the first parse`);
    ok('the oversized file is read anyway, alone in the queue',
       reads[1] === 'huge.dcm' && files[1].name === 'huge.dcm', reads.slice(0, 3).join(','));
    // One parse later, not immediately: the budget counts the file currently
    // being parsed, because its buffer is every bit as resident as a queued one.
    // Releasing it at the shift instead would let the queue refill around a
    // hundred megabytes the loop is still holding, and the cap would be a cap on
    // everything except the largest thing in memory.
    ok('the queue stays shut while the oversized buffer is still in hand', bigDepths[1] === 1,
       bigDepths.join(','));
    ok('and refills as soon as it is released', bigDepths[2] === 3, bigDepths.join(','));

    // ---- one bad file in the middle -------------------------------------------
    // Each file has its own try/catch and the loop carries on. A read-ahead makes
    // that easy to lose: a rejected read sits in the queue for a while before
    // anyone awaits it, and an unhandled rejection would take the whole load down.
    const junk = new Uint8Array(64).buffer;
    await handleFiles([
      fake('good0.dcm', bufs[0]),
      fake('unreadable.dcm', null, { fail: true }),
      fake('notdicom.dcm', junk),
      fake('good3.dcm', bufs[3]),
      fake('good4.dcm', bufs[4]),
    ]);

    ok('the good files still load', files.length === 3, files.map(f => f.name).join(','));
    ok('and they are the good ones', files.map(f => f.name).join(',') === 'good0.dcm,good3.dcm,good4.dcm',
       files.map(f => f.name).join(','));
    ok('a read that never resolves is reported, not swallowed',
       /unreadable\.dcm/.test(errorBanner.textContent || ''), errorBanner.textContent || '(no banner)');
    ok('and so is a buffer that is not DICOM',
       /notdicom\.dcm/.test(errorBanner.textContent || ''), errorBanner.textContent || '(no banner)');
    ok('the banner counts both of them', /2 files failed/.test(errorBanner.textContent || ''),
       (errorBanner.textContent || '').split('\n')[0]);

    // ---- the degenerate lists -------------------------------------------------
    ok('handleFiles returns how many files it loaded', (await handleFiles([fake('only.dcm', bufs[7])])) === 1);
    ok('a single file still loads', files.length === 1 && tag(files[0].dict, '00080018').endsWith('.8'),
       tag(files[0].dict, '00080018'));

    // The read-ahead is primed before the loop, so the empty list is the case
    // where it has to prime nothing and the loop has to not run at all.
    const open = files[0];
    ok('an empty list loads nothing and throws nothing', (await handleFiles([])) === 0);
    ok('and leaves the open study alone', files.length === 1 && files[0] === open, String(files.length));

    // ---- a drop that holds nothing readable --------------------------------------
    // The study used to be wiped before the first parse, so a stray JPEG dropped
    // on the page threw away the study, its edits and the undo history, and on
    // Overview (the banner lives on Edit) nothing said so.
    {
      pendingEdits.set('00100010', { vr: 'PN', valueString: 'Kept^Edit' });
      editHistory.push(new Map());
      document.querySelector('.toast')?.remove();
      const jpeg = fake('photo.JPG', new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]).buffer);
      const realToast = window.toast;
      let toastMs;
      window.toast = (msg, ms) => { toastMs = ms; return realToast(msg, ms); };
      let n;
      try { n = await handleFiles([jpeg]); } finally { window.toast = realToast; }
      ok('nothing parsed: handleFiles returns 0', n === 0, String(n));
      ok('and the open study is still the one on screen', files.length === 1 && files[0] === open && dict === open.dict);
      ok('with its edits', pendingEdits.get('00100010')?.valueString === 'Kept^Edit');
      ok('and its undo history', editHistory.length === 1, String(editHistory.length));
      const t = document.querySelector('.toast')?.textContent || '';
      ok('a toast says so on any tab', /photo\.JPG could not be read as DICOM/.test(t) && /open study is unchanged/.test(t), t);
      ok('and points images at Create', /Create/.test(t), t);
      // Three sentences can't be read in the default 2.4 s.
      ok('and stays up long enough to read', toastMs >= 6000, String(toastMs));
      ok('the banner names the image and the Create tab',
         errorBanner.className === 'error-banner' && /photo\.JPG: an image, not DICOM: use Create/.test(errorBanner.textContent),
         errorBanner.textContent);
      ok('and says the study under it is unchanged', /open study is unchanged/.test(errorBanner.textContent), errorBanner.textContent);
      // Named by MIME alone: a pasted image has no useful extension.
      const pasted = fake('clipboard', new Uint8Array(8).buffer);
      pasted.file.type = 'image/png';
      await handleFiles([pasted, fake('junk.bin', new Uint8Array(8).buffer)]);
      const t2 = document.querySelector('.toast')?.textContent || '';
      ok('several unreadable files are counted', /None of the 2 files could be read/.test(t2), t2);
      ok('an image is known by its MIME type too', /clipboard: an image, not DICOM/.test(errorBanner.textContent)
         && !/junk\.bin: an image/.test(errorBanner.textContent), errorBanner.textContent);
      ok('and the study still stands', files[0] === open);
      editHistory.length = 0;
    }

    // ---- one good file among bad ones -------------------------------------------
    {
      const n = await handleFiles([fake('bad.png', new Uint8Array(8).buffer), fake('good.dcm', bufs[2])]);
      ok('the good file replaces the study', n === 1 && files.length === 1 && files[0].name === 'good.dcm', String(n));
      ok('and the edits that belonged to the old one go with it', !editHistory.length && pendingEdits === files[0].pending);
      const t = document.querySelector('.toast')?.textContent || '';
      ok('the toast counts the failure', /1 of 2 files could not be read/.test(t) && !/unchanged/.test(t), t);
      ok('and the banner does not claim the study is unchanged', !/unchanged/.test(errorBanner.textContent), errorBanner.textContent);
    }

    const NEW_STRINGS = [
      'an image, not DICOM: use Create →',
      '{n} of {m} files could not be read as DICOM.',
      '{name} could not be read as DICOM.',
      'None of the {n} files could be read as DICOM.',
      'Images go in Create →, which turns them into DICOM.',
      'The open study is unchanged.',
    ];
    for (const loc of ['es', 'pt-BR', 'ja', 'ru']) {
      const missing = NEW_STRINGS.filter(s => !I18N[loc] || !I18N[loc][s]);
      ok(`i18n: every load-failure string is translated into ${loc}`, missing.length === 0,
         missing.join(' | ').slice(0, 160));
    }
  } catch (e) {
    restore();
    ok('suite ran to completion', false, (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  }

  return out;
};

// Two callers: tests/run.sh injects this file alone and scrapes the <pre> below;
// index.html#selftest sets window.SELFTEST and awaits the returned lines instead.
if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.loading()).join('\n');
  document.body.appendChild(pre);
});
