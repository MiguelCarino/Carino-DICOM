// Download All has to deliver every file it was asked for.
//
// It used to fire one anchor click per file, and a browser silently stops
// honouring automatic downloads after roughly ten: 60 slices requested, 10
// delivered, no error and no event. Nothing in the page could tell, which is
// why nothing caught it. One archive is one download, so the question this
// suite asks is whether the archive really holds everything.
//
// Everything below is checked against a reader written here, with its own
// CRC-32 table — the same discipline as dicom-forge.js. Reading the archive
// back with the writer's own helpers would only prove the writer agrees with
// itself, and a writer that drops entries agrees with itself perfectly.
(window.SUITES || (window.SUITES = {})).zip = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);

  // ---- an independent CRC-32 ------------------------------------------------
  // Written out longhand from the reversed polynomial rather than reusing the
  // app's table, so a wrong table in the app cannot agree with a wrong table
  // here.
  const TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc = (b) => {
    let c = ~0;
    for (let i = 0; i < b.length; i++) c = TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ ~0) >>> 0;
  };

  // ---- an independent reader ------------------------------------------------
  // Locals are walked forward from byte 0 by signature and by stored size;
  // the central directory is walked separately from the offset the EOCD gives.
  // The two never consult each other, so a disagreement between them shows up
  // as a failure rather than being smoothed over.
  const readZip = (u8) => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const dec = new TextDecoder();
    let eocd = -1;
    for (let i = u8.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('no end-of-central-directory record');
    const z = {
      eocd,
      diskEntries: dv.getUint16(eocd + 8, true),
      totalEntries: dv.getUint16(eocd + 10, true),
      cdSize: dv.getUint32(eocd + 12, true),
      cdOffset: dv.getUint32(eocd + 16, true),
      records: [],
      locals: [],
    };
    let p = z.cdOffset;
    for (let i = 0; i < z.totalEntries; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central record at ' + p);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      z.records.push({
        flag: dv.getUint16(p + 8, true),
        method: dv.getUint16(p + 10, true),
        crc: dv.getUint32(p + 16, true),
        csize: dv.getUint32(p + 20, true),
        usize: dv.getUint32(p + 24, true),
        localOffset: dv.getUint32(p + 42, true),
        name: dec.decode(u8.subarray(p + 46, p + 46 + nlen)),
      });
      p += 46 + nlen + elen + clen;
    }
    let q = 0;
    while (q + 30 <= u8.length && dv.getUint32(q, true) === 0x04034b50) {
      const nlen = dv.getUint16(q + 26, true), elen = dv.getUint16(q + 28, true);
      const size = dv.getUint32(q + 18, true);
      const start = q + 30 + nlen + elen;
      z.locals.push({
        offset: q,
        flag: dv.getUint16(q + 6, true),
        method: dv.getUint16(q + 8, true),
        crc: dv.getUint32(q + 14, true),
        name: dec.decode(u8.subarray(q + 30, q + 30 + nlen)),
        bytes: u8.subarray(start, start + size),
      });
      q = start + size;
    }
    z.sigAt = (off) => u8[off] === 0x50 && u8[off + 1] === 0x4B && u8[off + 2] === 0x03 && u8[off + 3] === 0x04;
    return z;
  };

  // saveBlob is the app's single exit to the disk, and a top-level function
  // declaration in a classic script — so replacing it here intercepts the real
  // download path instead of re-implementing it.
  const realSaveBlob = window.saveBlob;
  let saved = [];
  window.saveBlob = (blob, name) => { saved.push({ blob, name }); };

  const settle = async (pred, tries = 3000) => {
    for (let i = 0; i < tries && !pred(); i++) await new Promise(r => setTimeout(r, 0));
    return pred();
  };
  const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
  const uidOf = (d) => String(getTag(d, '00080018')?.Value?.[0] || '');

  try {
    // ---- a twelve-slice study, two of them sharing a name -------------------
    const N = 12;
    const studyUID = '1.2.826.0.1.3680043.10.99999.9.1';
    const slice = (i) => {
      const n = Forge.W * Forge.H;
      const px = new Uint16Array(n);
      for (let k = 0; k < n; k++) px[k] = (k + i * 137) & 0xFFF;
      return Forge.build({
        rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
        wc: 2048, ww: 4096, modality: 'CT',
        studyUID, seriesUID: `1.2.826.0.1.3680043.10.99999.9.2.${i < 6 ? 1 : 2}`,
        instance: i + 1, sopInstance: `1.2.826.0.1.3680043.10.99999.9.3.${i + 1}`,
        pixels: px,
      });
    };
    // Ten arrive as a folder tree; the last two arrive the way a picker hands
    // over two files that happen to share a name — the collision the archive
    // has to survive, since the folder path is what keeps the other ten apart.
    const items = [];
    for (let i = 0; i < 10; i++) {
      items.push({
        file: new File([slice(i)], `IM${String(i + 1).padStart(6, '0')}`),
        path: `study/SER00${i < 6 ? 1 : 2}/IM${String(i + 1).padStart(6, '0')}`,
      });
    }
    items.push({ file: new File([slice(10)], 'DUPE.dcm'), path: 'DUPE.dcm' });
    items.push({ file: new File([slice(11)], 'DUPE.dcm'), path: 'DUPE.dcm' });

    await handleFiles(items);
    ok('twelve slices load', files.length === N, String(files.length));

    // ---- the whole range leaves as one download -----------------------------
    saved = [];
    await downloadRange(0, files.length);
    ok('a whole study leaves as a single download', saved.length === 1, String(saved.length));
    ok('and it is named as an archive', /\.zip$/.test(saved[0]?.name || ''), saved[0]?.name);
    ok('and it is typed as one', saved[0]?.blob?.type === 'application/zip', saved[0]?.blob?.type);

    const zip = readZip(await bytesOf(saved[0].blob));

    // ---- the archive is a real archive --------------------------------------
    ok('the archive is a real archive', zip.locals.length === N, String(zip.locals.length));
    ok('the EOCD counts what is in the archive',
       zip.totalEntries === N && zip.diskEntries === N, `${zip.diskEntries}/${zip.totalEntries}`);
    ok('the central directory has a record per file', zip.records.length === N, String(zip.records.length));
    ok('the central directory ends where the EOCD begins',
       zip.cdOffset + zip.cdSize === zip.eocd, `${zip.cdOffset}+${zip.cdSize} vs ${zip.eocd}`);
    ok('the central directory offsets point at the local headers',
       zip.records.every(r => zip.sigAt(r.localOffset)),
       zip.records.map(r => r.localOffset).join(','));
    ok('every entry is stored, not deflated',
       zip.locals.every(l => l.method === 0) && zip.records.every(r => r.method === 0));
    ok('every entry is flagged UTF-8',
       zip.locals.every(l => l.flag === 0x0800) && zip.records.every(r => r.flag === 0x0800));

    // ---- the CRCs agree -----------------------------------------------------
    ok('the CRCs agree',
       zip.records.every((r, i) => crc(zip.locals[i].bytes) === r.crc),
       zip.records.map((r, i) => (crc(zip.locals[i].bytes) === r.crc ? 'ok' : 'BAD')).join(','));
    ok('the local headers carry the same CRCs the directory does',
       zip.locals.every((l, i) => l.crc === zip.records[i].crc));
    ok('the recorded sizes are the payload sizes, uncompressed == compressed',
       zip.records.every((r, i) => r.csize === r.usize && r.usize === zip.locals[i].bytes.length));

    // ---- every entry round-trips as DICOM -----------------------------------
    // The assertion that would have caught 50 of 60 files quietly not arriving:
    // it is not enough for twelve entries to exist, each has to be the slice it
    // claims to be.
    {
      let bad = null, n = 0;
      for (let i = 0; i < zip.locals.length; i++) {
        const msg = DicomMessage.readFile(zip.locals[i].bytes.slice().buffer);
        const got = uidOf(msg.dict), want = uidOf(files[i].dict);
        // An empty UID on both sides would make this pass while proving nothing.
        if (!want) { bad = `source slice ${i} has no SOP Instance UID`; break; }
        if (got !== want) { bad = `${zip.locals[i].name}: ${got} != ${want}`; break; }
        n++;
      }
      ok('every entry round-trips as DICOM', n === N && !bad, bad || String(n));
    }
    {
      const uids = new Set();
      for (const l of zip.locals) uids.add(uidOf(DicomMessage.readFile(l.bytes.slice().buffer).dict));
      ok('no slice was written with another slice\'s identity', uids.size === N, [...uids].join(' '));
    }

    // ---- names --------------------------------------------------------------
    const names = zip.locals.map(l => l.name);
    ok('two files with the same name both survive', new Set(names).size === N, names.join(' '));
    ok('the archive keeps the folder the study arrived in',
       names.includes('study/SER001/IM000001.edited.dcm') && names.includes('study/SER002/IM000010.edited.dcm'),
       names.join(' '));
    ok('the colliding pair is numbered, not overwritten',
       names.includes('DUPE.edited.dcm') && names.includes('DUPE.edited_2.dcm'), names.join(' '));
    ok('the central directory names match the local ones',
       zip.records.every((r, i) => r.name === names[i]));
    ok('no entry name could escape the folder it is unpacked into',
       names.every(n => !n.startsWith('/') && !n.split('/').includes('..')), names.join(' '));

    // ---- a lone file is still a lone file -----------------------------------
    {
      saved = [];
      await downloadRange(0, 1);
      ok('one file is still downloaded as one file',
         saved.length === 1 && /\.dcm$/.test(saved[0].name) && saved[0].blob.type === 'application/dicom',
         saved[0]?.name);
      const one = await bytesOf(saved[0].blob);
      ok('and it is not an archive', !(one[0] === 0x50 && one[1] === 0x4B));
    }

    // ---- buildEditedFile still hands back a Blob ----------------------------
    {
      const blob = buildEditedFile(files[0]);
      const viaBlob = new Uint8Array(await blob.arrayBuffer());
      const viaBytes = buildEditedBytes(files[0]);
      ok('buildEditedFile still returns a Blob', blob instanceof Blob);
      ok('the Blob wrapper and the byte form are the same bytes',
         viaBlob.length === viaBytes.length && viaBlob.every((b, i) => b === viaBytes[i]),
         `${viaBlob.length} vs ${viaBytes.length}`);
    }

    // ---- the 32-bit limits --------------------------------------------------
    // Refusing has to be cheaper than trying, so the size guard runs off the
    // declared length before anything walks the bytes — which is what lets a
    // four-gigabyte entry be duck-typed here instead of allocated.
    {
      ok('an archive with no entries is refused', zipStore([]) === null);
      const tiny = new Uint8Array(1);
      const overCount = Array.from({ length: 65536 }, (_, i) => ({ name: 'f' + i, bytes: tiny }));
      ok('more entries than the EOCD can count is refused', zipStore(overCount) === null);
      ok('and one fewer is not', zipStore(overCount.slice(0, 65535)) !== null);
      const huge = { name: 'huge.dcm', bytes: { length: 0xFFFFFFFF } };
      ok('an entry too large for a 32-bit offset is refused', zipStore([huge]) === null);
      ok('and the refusal happens before the payload is read',
         zipStore([{ name: 'a.dcm', bytes: tiny }, huge]) === null);
    }

    // ---- names that are not ASCII, payloads that are not there --------------
    {
      const name = 'estudio/Pacientê Ñ/IM✓.dcm';
      const z = readZip(await bytesOf(new Blob(zipStore([
        { name, bytes: new TextEncoder().encode('hi') },
        { name: 'empty.dcm', bytes: new Uint8Array(0) },
      ]))));
      ok('a non-ASCII name survives the round trip', z.locals[0].name === name, z.locals[0].name);
      ok('an empty payload is still an entry',
         z.totalEntries === 2 && z.locals[1].bytes.length === 0 && z.records[1].crc === 0,
         String(z.records[1]?.crc));
      // The traversal a malicious or merely careless path could otherwise carry.
      const esc = readZip(await bytesOf(new Blob(zipStore([
        { name: '/../../etc/passwd', bytes: new Uint8Array(1) },
        { name: 'C:\\study\\a.dcm', bytes: new Uint8Array(1) },
      ]))));
      ok('a path that climbs out of the folder is flattened',
         esc.locals[0].name === 'etc/passwd', esc.locals[0].name);
      ok('a Windows path becomes a relative one',
         esc.locals[1].name === 'study/a.dcm', esc.locals[1].name);
    }

    // ---- the Extract tab ----------------------------------------------------
    // Same bug, same fix: it used to click once per frame with a 40ms pause,
    // which measured 30 of 60 delivered.
    {
      extractorFiles = [];
      await addExtractorFiles([
        { file: new File([slice(0)], 'IM000001'), path: 'study/SER001/IM000001' },
        { file: new File([slice(1)], 'IM000002'), path: 'study/SER001/IM000002' },
        { file: new File([slice(6)], 'IM000007'), path: 'study/SER002/IM000007' },
      ]);
      ok('three files reach the Extract tab', extractorFiles.length === 3, String(extractorFiles.length));

      saved = [];
      extractAllBtn.click();
      ok('Extract All produces exactly one download',
         await settle(() => saved.length > 0) && saved.length === 1, String(saved.length));
      const png = readZip(await bytesOf(saved[0].blob));
      ok('and the archive holds every frame', png.locals.length === 3 && png.totalEntries === 3,
         String(png.locals.length));
      ok('every extracted frame is a PNG',
         png.locals.every(l => l.bytes[0] === 0x89 && l.bytes[1] === 0x50 && l.bytes[2] === 0x4E && l.bytes[3] === 0x47),
         png.locals.map(l => l.bytes.length).join(','));
      ok('the extracted frames CRC clean too',
         png.records.every((r, i) => crc(png.locals[i].bytes) === r.crc));
      ok('the extracted frames keep their series folder',
         png.locals.map(l => l.name).includes('study/SER002/IM000007.png'),
         png.locals.map(l => l.name).join(' '));

      saved = [];
      extractSelectedBtn.click();
      ok('Extract First Frames produces exactly one download',
         await settle(() => saved.length > 0) && saved.length === 1, String(saved.length));
      const first = readZip(await bytesOf(saved[0].blob));
      ok('and it holds one frame per file', first.locals.length === 3, String(first.locals.length));
      extractorFiles = [];
    }

    // ---- more than one archive beats more than one download -----------------
    // The 32-bit ZIP fields cap an archive at 65535 entries and 4 GB. The first
    // version answered that by going back to one anchor click per file, which is
    // the browser limiter this suite exists because of: it would have turned the
    // rare too-big case straight back into silent loss. Splitting keeps the
    // download count in single figures whatever the range holds.
    {
      const mk = (n, bytes) => Array.from({ length: n }, (_, i) => ({
        name: `part${i}.dcm`, bytes: new Uint8Array(bytes) }));

      const one = zipChunks(mk(5, 16));
      ok('a range that fits stays one archive', one.length === 1 && one[0].length === 5,
         one.map(c => c.length).join(','));

      const many = zipChunks(mk(ZIP_MAX_ENTRIES + 10, 4));
      ok('too many entries split across archives rather than downloads',
         many.length === 2 && many[0].length === ZIP_MAX_ENTRIES && many[1].length === 10,
         many.map(c => c.length).join(','));
      ok('and every entry lands in exactly one of them',
         many.reduce((n, c) => n + c.length, 0) === ZIP_MAX_ENTRIES + 10);

      saved = [];
      const { saved: n, archives } = saveArchives(mk(3, 32), 'split-test', 'application/dicom', () => {});
      ok('saveArchives reports what actually left the page', n === 3 && archives === 1,
         `${n} entries, ${archives} archive(s)`);
      ok('and saved exactly that many blobs', saved.length === 1, String(saved.length));
    }

    // ---- Download All is not re-entrant -------------------------------------
    // Packing yields so the overlay can paint, which leaves a window for a
    // second click. Both runs used to finish and save, giving the user the same
    // archive twice under one second-resolution name, with the first run hiding
    // the overlay while the second still had work to do.
    {
      // Twelve, not six: packing only yields every eighth file, and without a
      // yield the whole run finishes synchronously and there is no window for a
      // second click to land in.
      await handleFiles(Array.from({ length: 12 }, (_, i) => new File([slice(i)], `re${i}.dcm`)));
      saved = [];
      const both = Promise.all([downloadRange(0, files.length), downloadRange(0, files.length)]);
      await both;
      ok('a second Download All while the first is packing is ignored',
         saved.length === 1, `${saved.length} download(s)`);
    }
  } catch (e) {
    ok('suite ran to completion', false, (e && e.message) || String(e));
    console.error(e);
  } finally {
    window.saveBlob = realSaveBlob;
  }

  return out;
};

// Two callers: tests/run.sh injects this file alone and scrapes the <pre> below;
// index.html#selftest sets window.SELFTEST and awaits the returned lines instead.
if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.zip()).join('\n');
  document.body.appendChild(pre);
});
