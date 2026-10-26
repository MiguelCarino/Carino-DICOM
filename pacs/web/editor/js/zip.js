// Store-only ZIP writer and multi-file download helpers.

// ---- Store-only ZIP ----
// Browsers silently drop automatic downloads after about ten, so multi-file downloads go
// out as one archive. Method 0 (stored): DICOM pixels are already compressed or noise.
const ZIP_MAX_ENTRIES = 0xFFFF;       // the EOCD entry counts are 16-bit
const ZIP_MAX_BYTES   = 0xFFFFFFFF;   // as are all the sizes and offsets, at 32

let CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[i] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// MS-DOS date/time: packed 16-bit pair, 2-second resolution, year 0 = 1980.
function dosDateTime(d = new Date()) {
  const year = Math.max(0, Math.min(127, d.getFullYear() - 1980));
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31),
    date: (year << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

// Keeps folder structure (it disambiguates same-named slices) but strips drive letters
// and '.'/'..' so the archive cannot write outside the extraction folder (zip-slip).
function zipSafeName(p) {
  const clean = String(p == null ? '' : p)
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:/, '')
    .split('/')
    .filter(s => s && s !== '.' && s !== '..')
    .join('/');
  return clean || 'file';
}

// Duplicate names get _2, _3… before the extension (extractors overwrite or refuse duplicates).
// Keyed case- and normalisation-insensitively: macOS file systems treat NFC and NFD as one name.
function zipUniqueNames(names) {
  const taken = new Set();
  const key = s => s.normalize('NFC').toLowerCase();
  return names.map(n => {
    let out = n, i = 1;
    while (taken.has(key(out))) {
      i++;
      const dot = n.lastIndexOf('.');
      out = dot > n.lastIndexOf('/') ? `${n.slice(0, dot)}_${i}${n.slice(dot)}` : `${n}_${i}`;
    }
    taken.add(key(out));
    return out;
  });
}

// Split entries into groups that each fit a non-ZIP64 archive (more archives, not more
// per-file downloads, which would hit the browser's download limit).
const zipEnc = new TextEncoder();
function zipChunks(entries) {
  const out = [];
  let cur = [], bytes = 0;
  for (const e of entries) {
    // Local header + central record + the UTF-8 name twice (as zipStore writes it, plus room for
    // a _NN de-duplication suffix), plus the end record: safe, not tight.
    const nb = zipEnc.encode(zipSafeName(e.name)).length;
    const cost = e.bytes.length + 76 + 2 * (nb + 4) + 22;
    if (cur.length && (cur.length >= ZIP_MAX_ENTRIES || bytes + cost > ZIP_MAX_BYTES)) {
      out.push(cur); cur = []; bytes = 0;
    }
    cur.push(e); bytes += cost;
  }
  if (cur.length) out.push(cur);
  return out;
}

// Save as few archives as 32-bit ZIP allows; returns how many entries were actually saved.
// A lone entry too big for any archive is saved as itself.
function saveArchives(entries, base, mime, logFn) {
  // A chunk the writer refuses is halved until every part fits; only a lone entry too big for any
  // archive is saved as itself. The counts are of what was actually written.
  const groups = [];
  const fit = (chunk) => {
    const parts = zipStore(chunk);
    if (parts) { groups.push({ chunk, parts }); return; }
    if (chunk.length === 1) { groups.push({ chunk, parts: null }); return; }
    const mid = chunk.length >> 1;
    fit(chunk.slice(0, mid)); fit(chunk.slice(mid));
  };
  zipChunks(entries).forEach(fit);
  const n = groups.filter(g => g.parts).length;
  let saved = 0, archives = 0, loose = 0;
  for (const g of groups) {
    if (g.parts) {
      archives++;
      saveBlob(new Blob(g.parts, { type: 'application/zip' }),
               zipStamp(n === 1 ? base : `${base}-${archives}of${n}`));
      saved += g.chunk.length;
    } else {
      saveBlob(new Blob([g.chunk[0].bytes], { type: mime }), g.chunk[0].name.replace(/[\\/]/g, '_'));
      saved += 1; loose++;
    }
  }
  if (loose) logFn(`⚠ ${T('Too large for one archive — saving the files one at a time.')}`);
  return { saved, archives, loose };
}

// Returns parts for `new Blob(parts)` (no concatenated copy), or null if ZIP64 would be
// needed: a wrapped 32-bit offset yields an archive that silently returns wrong bytes.
function zipStore(entries) {
  if (!entries.length || entries.length > ZIP_MAX_ENTRIES) return null;
  const enc = new TextEncoder();
  const names = zipUniqueNames(entries.map(e => zipSafeName(e.name)));
  const { time, date } = dosDateTime();
  const parts = [];
  const central = [];
  let offset = 0;

  for (let i = 0; i < entries.length; i++) {
    const bytes = entries[i].bytes;
    const nameBytes = enc.encode(names[i]);
    // The name length is a 2-byte field (APPNOTE 4.4.10); a longer name would corrupt the archive.
    if (nameBytes.length > 0xFFFF) return null;
    const size = bytes.length;
    // Size check before the CRC, to bail out without hashing data we will refuse.
    if (offset + 30 + nameBytes.length + size > ZIP_MAX_BYTES) return null;
    const crc = crc32(bytes);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);   // local file header
    lh.setUint16(4, 20, true);           // version needed: 2.0
    lh.setUint16(6, 0x0800, true);       // flag: the name below is UTF-8
    lh.setUint16(8, 0, true);            // method 0 — stored
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);        // compressed size == uncompressed size
    lh.setUint32(22, size, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);           // no extra field
    parts.push(new Uint8Array(lh.buffer), nameBytes, bytes);
    central.push({ crc, size, nameBytes, offset });
    offset += 30 + nameBytes.length + size;
  }

  const cdStart = offset;
  for (const c of central) {
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);   // central directory record
    cd.setUint16(4, 20, true);           // version made by
    cd.setUint16(6, 20, true);           // version needed
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, c.crc, true);
    cd.setUint32(20, c.size, true);
    cd.setUint32(24, c.size, true);
    cd.setUint16(28, c.nameBytes.length, true);
    cd.setUint16(30, 0, true);           // extra length
    cd.setUint16(32, 0, true);           // comment length
    cd.setUint16(34, 0, true);           // disk number
    cd.setUint16(36, 0, true);           // internal attributes
    cd.setUint32(38, 0, true);           // external attributes
    cd.setUint32(42, c.offset, true);    // where its local header is
    parts.push(new Uint8Array(cd.buffer), c.nameBytes);
    offset += 46 + c.nameBytes.length;
  }
  if (offset > ZIP_MAX_BYTES) return null;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);   // end of central directory
  eocd.setUint16(4, 0, true);            // this disk
  eocd.setUint16(6, 0, true);            // disk the directory starts on
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, offset - cdStart, true);
  eocd.setUint32(16, cdStart, true);
  eocd.setUint16(20, 0, true);           // no archive comment
  parts.push(new Uint8Array(eocd.buffer));
  return parts;
}

function zipStamp(base) {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${base}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.zip`;
}

// After Anonymize the source path (often a patient-named folder, e.g. DOE^JOHN_123456/CT/IM0001)
// must not travel with the file: name it by its (remapped) UIDs instead.
const uidOf = (entry, tag) => String(getTag(entry?.dict || {}, tag)?.Value?.[0] ?? '').trim().replace(/[^0-9.]/g, '');
function exportBaseName(entry) {
  if (!entry) return 'dicom';
  if (entry.deid) return uidOf(entry, '00080018') || ('IM' + (files.indexOf(entry) + 1));
  return entry.name.replace(/\.[^.]+$/, '');
}

// Inside the archive, use entry.path (keeps the source folder); entry.name is only a basename.
function zipNameFor(entry) {
  if (entry.deid) return `${uidOf(entry, '0020000E') || 'series'}/${exportBaseName(entry)}.dcm`;
  return (entry.path || entry.name).replace(/\.[^./]+$/, '') + '.edited.dcm';
}

// An anonymized file whose pixels may still show the patient is said so at export time too.
function warnBurnedOnExport(list) {
  const n = list.filter(e => /^YES/i.test(String(getTag(e.dict, '00120062')?.Value?.[0] || '').trim()) &&
                             /^YES/i.test(String(getTag(e.dict, '00280301')?.Value?.[0] || '').trim())).length;
  if (n) log('⚠ ' + TF('{n} exported file(s) are marked Patient Identity Removed = YES but also Burned In Annotation = YES: identity may remain in the pixels.', { n }));
}

function downloadOne(entry) {
  try {
    saveBlob(buildEditedFile(entry), entry.deid ? `${exportBaseName(entry)}.dcm` : `${exportBaseName(entry)}.edited.dcm`);
    log(`⬇ ${entry.deid ? exportBaseName(entry) : entry.name}`);
    warnBurnedOnExport([entry]);
  } catch (e) {
    log(`✗ ${T('Download failed:')} ${entry.name}: ${e.message || e}`);
    toast?.(`${T('Download failed:')} ${e.message || e}`, 7000);
  }
}

let packingRange = false;

async function downloadRange(start, end) {
  if (!files.length) return;
  // Packing yields to the event loop, so guard against a second click starting a duplicate run.
  if (packingRange) return;
  const range = files.slice(Math.max(0, start | 0), Math.min(files.length, end | 0));
  if (!range.length) return;
  // A single file downloads as a plain .dcm, not an archive.
  if (range.length === 1) return downloadOne(range[0]);

  const packed = [];
  packingRange = true;
  showLoading?.(true, 'Packing files…', 0, `0 / ${range.length}`);
  try {
    for (let i = 0; i < range.length; i++) {
      try {
        packed.push({ name: zipNameFor(range[i]), bytes: buildEditedBytes(range[i]) });
      } catch (e) {
        log(`✗ ${T('Download failed:')} ${range[i].name}: ${e.message || e}`);
      }
      showLoading?.(true, 'Packing files…', (i + 1) / range.length, `${i + 1} / ${range.length}`);
      // Yield every 8th file so the progress overlay can paint.
      if ((i & 7) === 7) await new Promise(r => setTimeout(r, 0));
    }
    if (packed.length < range.length)
      toast?.(T('{n} file(s) could not be written and were left out; see the log.').replace('{n}', range.length - packed.length), 7000);
    if (!packed.length) return;
    warnBurnedOnExport(range);
    const { saved, archives, loose } = saveArchives(packed, 'dicom-edited', 'application/dicom', log);
    log('⬇ ' + TF(archives === 1 ? '{n} file(s) → one archive' : '{n} file(s) → {m} archives', { n: saved, m: archives })
        + (loose ? ' ' + TF('+ {n} saved one at a time', { n: loose }) : ''));
  } catch (e) {
    // Archive assembly (e.g. out of memory) has no per-file guard; report it to the log.
    log(`✗ ${T('Download failed:')} ${e.message || e}`);
  } finally {
    packingRange = false;
    showLoading?.(false);
  }
}

