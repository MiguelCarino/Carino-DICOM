// Regression cases for the October 2026 review: every fix applied from it has an assertion
// here that checks the corrected behaviour (never the old one). Grouped by area; each case
// forges its own file with tests/dicom-forge.js and drives the real code path (the Anonymize
// button, buildEditedBytes, applyRedaction, ...), reading the result back through dcmjs the way
// a receiver would.
(window.SUITES || (window.SUITES = {})).review = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const $ = (id) => document.getElementById(id);
  const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
  const ROOT = '1.2.826.0.1.3680043.10.99999.71.';
  const W = Forge.W, H = Forge.H;
  const px8 = () => { const p = new Uint8Array(W * H); for (let i = 0; i < p.length; i++) p[i] = (i * 3) & 0xFF; return p; };
  const px16 = () => { const p = new Uint16Array(W * H); for (let i = 0; i < p.length; i++) p[i] = (i * 7) & 0xFFF; return p; };
  const mono8 = (cfg = {}) => Forge.build({ rows: H, cols: W, pi: 'MONOCHROME2', ba: 8, bs: 8, hb: 7, pr: 0,
    studyUID: ROOT + '1', seriesUID: ROOT + '1.1', sopInstance: ROOT + '1.1.' + (cfg.n || 1), instance: cfg.n || 1,
    pixels: px8(), ...cfg });
  const file = (bytes, name = 'f.dcm') => new File([bytes], name);
  const load = async (...list) => { await handleFiles(list.map((b, i) => b instanceof File ? b : file(b, `r${i}.dcm`))); return files; };
  const boxes = () => [...document.querySelectorAll('#deidOptionsRow input[type="checkbox"][data-opt]')];
  const anon = (opts = []) => {
    boxes().forEach(cb => { cb.checked = opts.includes(cb.dataset.opt); });
    $('anonymizeBtn').click();
    $('confirmOk').click();
  };
  const bytesOf = (entry) => { const u = buildEditedBytes(entry); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); };
  const reread = (entry) => { const m = DicomMessage.readFile(bytesOf(entry)); normBin(m.dict); return m; };
  const has = (buf, s) => { const b = new Uint8Array(buf); const n = [...s].map(c => c.charCodeAt(0));
    outer: for (let i = 0; i + n.length <= b.length; i++) { for (let k = 0; k < n.length; k++) if (b[i + k] !== n[k]) continue outer; return true; } return false; };
  const v0 = (d, t) => { const e = lookupTag(d, t); return e && Array.isArray(e.Value) ? e.Value[0] : undefined; };
  const s0 = (d, t) => String(v0(d, t) ?? '').trim();
  const allKeys = (d, acc = []) => { walkEls(d, (t) => acc.push(canonTag(t))); return acc; };
  const le32 = (n) => [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >>> 24) & 0xFF];
  // An implicit-VR item holding the given elements, as raw bytes (for UN-encoded sequences).
  const implicitItem = (els) => {
    const inner = [];
    for (const [tag, vr, val] of els) inner.push(...Forge.element(tag, vr, new TextEncoder().encode(val.length % 2 ? val + ' ' : val), { implicit: true }));
    return new Uint8Array([0xFE, 0xFF, 0x00, 0xE0, ...le32(inner.length), ...inner]).buffer;
  };

  try {
    // ======================================================== de-identification ==
    // D on AS writes a legal AS (dcmjs refuses 'ANONYMIZED' in a 4-byte VR), at the top level
    // and inside a Selector item.
    {
      await load(mono8({ extra: {
        '0072005F': { vr: 'AS', v: ['045Y'] },
        '00720400': { vr: 'SQ', items: [{ '0072005F': { vr: 'AS', v: ['045Y'] } }] },
      } }));
      anon();
      let threw = null, m = null;
      try { m = reread(files[0]); } catch (e) { threw = e.message; }
      ok('D on an AS row: the anonymized file exports', !threw, threw);
      ok('and the AS dummy is a 4-byte nnnY at both levels', m && s0(m.dict, '0072005F') === '000Y' &&
         s0(lookupTag(m.dict, '00720400').Value[0], '0072005F') === '000Y', m && s0(m.dict, '0072005F'));
    }

    // D on a UI row: one fresh UID per element, never one shared value.
    {
      const a = mono8({ n: 1, extra: { '006A0002': { vr: 'SQ', items: [
        { '006A0003': { vr: 'UI', v: [ROOT + '100'] } }, { '006A0003': { vr: 'UI', v: [ROOT + '101'] } }] } } });
      const b = mono8({ n: 2, extra: { '006A0002': { vr: 'SQ', items: [{ '006A0003': { vr: 'UI', v: [ROOT + '200'] } }] } } });
      await load(a, b);
      anon();
      const uids = files.flatMap(f => lookupTag(f.dict, '006A0002').Value.map(it => s0(it, '006A0003')));
      ok('every Annotation Group UID is its own fresh UID', uids.length === 3 && new Set(uids).size === 3 &&
         uids.every(u => /^2\.25\.\d+$/.test(u) && u.length <= 64), uids.join(' '));
      await load(a, b);
      anon(['rtnUIDsOpt']);
      const kept = files.flatMap(f => lookupTag(f.dict, '006A0002').Value.map(it => s0(it, '006A0003')));
      ok('with Retain UIDs they are the originals', kept.join(',') === [ROOT + '100', ROOT + '101', ROOT + '200'].join(','), kept.join(' '));
    }

    // Class and scheme UIDs are not instance UIDs: never remapped (Table E.1-1 lists none of them).
    {
      await load(mono8({ sopClass: '1.3.12.2.1107.5.9.1', extra: {
        '00080110': { vr: 'SQ', items: [{ '0008010C': { vr: 'UI', v: ['2.16.840.1.113883.6.96'] } }] },
        '00081140': { vr: 'SQ', items: [{ '00081150': { vr: 'UI', v: ['1.3.12.2.1107.5.9.1'] }, '00081155': { vr: 'UI', v: [ROOT + '9.9'] } }] },
        '0040A124': { vr: 'UI', v: ['1.2.840.100089.5.1'] },
      } }));
      anon();
      const d = files[0].dict, m = reread(files[0]);
      ok('a private SOP Class UID survives Anonymize', s0(d, '00080016') === '1.3.12.2.1107.5.9.1', s0(d, '00080016'));
      ok('and the exported (0002,0002) still equals it', s0(m.meta, '00020002') === '1.3.12.2.1107.5.9.1', s0(m.meta, '00020002'));
      ok('a Coding Scheme UID survives', s0(lookupTag(d, '00080110').Value[0], '0008010C') === '2.16.840.1.113883.6.96');
      const ref = lookupTag(d, '00081140').Value[0];
      ok('a Referenced SOP Class UID survives while its instance UID moves',
         s0(ref, '00081150') === '1.3.12.2.1107.5.9.1' && /^2\.25\./.test(s0(ref, '00081155')), s0(ref, '00081155'));
      ok('instance UIDs are still remapped', /^2\.25\./.test(s0(d, '00080018')) && /^2\.25\./.test(s0(d, '0020000D')));
      ok('a 1.2.840.100089 root is not mistaken for the standard root', /^2\.25\./.test(s0(d, '0040A124')), s0(d, '0040A124'));
      ok('the shown File Meta (0002,0003) follows the remapped SOP Instance UID',
         s0(files[0].meta, '00020003') === s0(d, '00080018'), s0(files[0].meta, '00020003'));
    }

    // The 2026d row, the option cells Innolitics lacked, and the dead file-meta row.
    {
      await load(mono8({ extra: { '3004007F': { vr: 'LO', v: ['Model by Dr Doe'] } } }));
      anon();
      ok('(3004,007F) Dose Calculation Model Name is removed', !lookupTag(files[0].dict, '3004007F'));
      const before = new Set(deidOptions);
      deidOptions = new Set(['rtnDevIdOpt']);
      ok('Retain Device Identity keeps (0018,1010) and (0018,1011)', resolveAction('00181010') === null && resolveAction('00181011') === null);
      deidOptions = new Set(['rtnPatCharsOpt']);
      ok('Retain Patient Characteristics keeps the Sex Parameters and Ethnic Groups rows',
         ['00100043', '00100046', '00100047', '00102161', '00102162'].every(t => resolveAction(t) === null));
      deidOptions = new Set(['rtnLongFullDatesOpt']);
      ok('Retain Full Dates keeps the four SR DateTime rows',
         ['0040A034', '0040A035', '0040B034', '0040B036'].every(t => resolveAction(t) === null));
      deidOptions = new Set();
      ok('without options those rows are removed', ['00181010', '00102162', '0040A034'].every(t => /^X/.test(resolveAction(t) || '')));
      deidOptions = before;
    }

    // File Meta on export: this editor is the writer; nothing of the source's identity travels.
    {
      await load(mono8());
      const e = files[0];
      e.meta['00020013'] = { vr: 'SH', Value: ['VENDORPACS_4_2'] };
      e.meta['00020016'] = { vr: 'AE', Value: ['HOSPITAL_CT1'] };
      e.meta['00020100'] = { vr: 'UI', Value: ['1.2.3.4'] };
      e.meta['00020102'] = { vr: 'OB', Value: [new TextEncoder().encode('MARKER-PRIVATE-INFO-').buffer] };
      e.meta['00020001'] = { vr: 'OB', Value: [new ArrayBuffer(0)] };
      e.meta['00020012'] = { vr: 'UI', Value: [''] };
      anon();
      const buf = bytesOf(e), m = DicomMessage.readFile(buf);
      ok('export names this editor as the implementation',
         s0(m.meta, '00020012') === '1.2.826.0.1.3680043.10.743' && s0(m.meta, '00020013') === 'CARINO_DCM_EDIT', s0(m.meta, '00020013'));
      ok('Source AE Title and Private Information do not travel',
         !lookupTag(m.meta, '00020016') && !lookupTag(m.meta, '00020100') && !lookupTag(m.meta, '00020102') &&
         !has(buf, 'HOSPITAL_CT1') && !has(buf, 'VENDORPACS') && !has(buf, 'MARKER-PRIVATE'));
      const fmv = new Uint8Array(lookupTag(m.meta, '00020001').Value[0]);
      ok('an empty File Meta Information Version is repaired to 00 01', fmv.length === 2 && fmv[1] === 1, String(fmv.length));
      ok('(0002,0003) equals the remapped (0008,0018)', s0(m.meta, '00020003') === s0(m.dict, '00080018') && /^2\.25\./.test(s0(m.dict, '00080018')));
    }

    // A dataset with an empty SOP Instance UID: the original (0002,0003) must not survive.
    {
      await load(mono8({ sopInstance: ROOT + '5.5.5' }));
      setTag(files[0].dict, '00080018', 'UI', []);
      reseedAllPending();
      anon();
      const m = reread(files[0]);
      ok('an empty (0008,0018) gets a fresh UID in meta and dataset alike',
         s0(m.meta, '00020003') !== ROOT + '5.5.5' && s0(m.meta, '00020003') === s0(m.dict, '00080018'), s0(m.meta, '00020003'));
    }

    // Nested PHI three levels deep, and private data at every depth.
    {
      await load(mono8({ extra: {
        '00081140': { vr: 'SQ', items: [{
          '00081155': { vr: 'UI', v: [ROOT + '7.7'] },
          '00400275': { vr: 'SQ', items: [{ '00100010': { vr: 'PN', v: ['NESTED^SECRET'] } }] },
          '00090010': { vr: 'LO', v: ['VENDOR'] }, '00091001': { vr: 'LO', v: ['PRIV-SECRET'] },
          '0040A730': { vr: 'SQ', items: [{ '0040A730': { vr: 'SQ', items: [{
            '00100010': { vr: 'PN', v: ['DEEP^SECRET'] }, '00080090': { vr: 'PN', v: ['REF^SECRET'] } }] } }] },
        }] },
      } }));
      anon();
      const d = files[0].dict, buf = bytesOf(files[0]);
      const item = lookupTag(d, '00081140')?.Value?.[0];
      ok('nested: the reference sequence is kept and its UID remapped', !!item && /^2\.25\./.test(s0(item, '00081155')));
      ok('nested: Request Attributes (X) are gone and Content Sequence (D) is emptied',
         !lookupTag(item, '00400275') && Array.isArray(lookupTag(item, '0040A730')?.Value) && lookupTag(item, '0040A730').Value.length === 0);
      ok('nested: no private element is left at any depth', !allKeys(d).some(t => parseInt(t.slice(0, 4), 16) % 2 === 1));
      ok('nested: none of the identities reaches the exported bytes',
         !has(buf, 'SECRET') && !has(buf, 'VENDOR'));
    }

    // Sequences dcmjs can only read as UN bytes: removed (fail-closed), never exported as-is.
    {
      const seq = Forge.sequence('00121020', [{ '00100010': { vr: 'PN', v: ['LEAKNAME^SECRET'] } }], { implicit: true });
      const base = Forge.build({ ts: '1.2.840.10008.1.2', rows: H, cols: W, pi: 'MONOCHROME2', ba: 8, bs: 8, hb: 7, pr: 0,
        pixels: px8(), extra: { '00080017': { vr: 'UI', v: [ROOT + '13.7'] } } });
      // Splice the defined-length SQ in before Pixel Data (tags stay ascending).
      const at = (() => { for (let i = base.length - 8; i > 132; i--) if (base[i] === 0xE0 && base[i + 1] === 0x7F && base[i + 2] === 0x10 && base[i + 3] === 0x00) return i; })();
      const implicitFile = new Uint8Array([...base.subarray(0, at), ...seq, ...base.subarray(at)]);
      await load(implicitFile);
      ok('implicit VR: the unknown defined-length sequence is read as UN', lookupTag(files[0].dict, '00121020')?.vr === 'UN');
      anon();
      const buf = bytesOf(files[0]);
      ok('implicit VR: its nested name never reaches the export', !has(buf, 'LEAKNAME'));
      ok('implicit VR: a U row dcmjs read as UN ((0008,0017)) is remapped',
         !has(buf, ROOT + '13.7') && /^2\.25\./.test(s0(files[0].dict, '00080017')), s0(files[0].dict, '00080017'));

      await load(mono8({ extra: { '00081140': { vr: 'UN', v: implicitItem([['00100020', 'LO', 'LEAK-MRN-777']]) } } }));
      anon();
      ok('explicit VR: a sequence encoded as UN is removed rather than exported', !has(bytesOf(files[0]), 'LEAK-MRN-777'));

      // PS3.5 6.2.2 Note 5: UN with undefined length (implicit VR items, Sequence Delimitation
      // Item at the end), standard and private, before Pixel Data. dcmjs alone throws on it.
      const enc = (s) => new TextEncoder().encode(s.length % 2 ? s + ' ' : s);
      const UNDEF = [0xFF, 0xFF, 0xFF, 0xFF];
      const undefUN = (tag, els) => {
        const inner = [];
        for (const [t, vr, val] of els) inner.push(...Forge.element(t, vr, enc(val), { implicit: true }));
        const g = parseInt(tag.slice(0, 4), 16), e = parseInt(tag.slice(4), 16);
        return [g & 0xFF, g >> 8, e & 0xFF, e >> 8, 0x55, 0x4E, 0, 0, ...UNDEF,
                0xFE, 0xFF, 0x00, 0xE0, ...UNDEF, ...inner, 0xFE, 0xFF, 0x0D, 0xE0, 0, 0, 0, 0,
                0xFE, 0xFF, 0xDD, 0xE0, 0, 0, 0, 0];
      };
      const ex = mono8();
      const atPx = (() => { for (let i = ex.length - 8; i > 132; i--) if (ex[i] === 0xE0 && ex[i + 1] === 0x7F && ex[i + 2] === 0x10 && ex[i + 3] === 0x00) return i; })();
      const spliced = new Uint8Array([...ex.subarray(0, atPx),
        ...Forge.element('00290010', 'LO', enc('ACME')),
        ...undefUN('00291001', [['00100010', 'PN', 'LEAKPRIV^UNDEF']]),
        ...undefUN('00400275', [['00100020', 'LO', 'LEAK-UNDEF-42']]),
        ...ex.subarray(atPx)]);
      let threwLoad = null;
      try { DicomMessage.readFile(definedLengthUN(spliced.buffer)); } catch (e) { threwLoad = e.message; }
      ok('UN of undefined length: the file parses', !threwLoad, threwLoad);
      await load(spliced);
      ok('and loads, Pixel Data and all', files.length === 1 && !!lookupTag(files[0].dict, '7FE00010') &&
         lookupTag(files[0].dict, '00400275')?.vr === 'UN', files.length + ' ' + lookupTag(files[0].dict, '00400275')?.vr);
      ok('and exports unchanged until anonymized', has(bytesOf(files[0]), 'LEAK-UNDEF-42'));
      anon();
      const undefBuf = bytesOf(files[0]);
      ok('Anonymize removes both UN sequences', !has(undefBuf, 'LEAK-UNDEF-42') && !has(undefBuf, 'LEAKPRIV'));
      ok('and a file without such an element is passed to the parser as is',
         definedLengthUN(ex.buffer) === ex.buffer);
    }

    // No profile, no claim: Anonymize refuses instead of stamping YES / 113100.
    {
      await load(mono8({ extra: { '00080050': { vr: 'SH', v: ['ACC123'] } } }));
      const saved = window.DEID_PROFILE;
      window.DEID_PROFILE = undefined;
      try {
        $('anonymizeBtn').click();
        const asked = $('confirmOverlay').classList.contains('visible');
        if (asked) $('confirmOk').click();
        ok('without deid-profile.js Anonymize refuses and claims nothing',
           !asked && !lookupTag(files[0].dict, '00120062') && s0(files[0].dict, '00080050') === 'ACC123');
        let threw = false;
        try { anonymize({ ...files[0].dict }); } catch (_) { threw = true; }
        ok('and anonymize() itself throws rather than half-run', threw);
      } finally { window.DEID_PROFILE = saved; }
    }

    // (0012,0063)/(0012,0064) are added to, never replaced; ASCII only.
    {
      await load(mono8({ extra: {
        '00120063': { vr: 'LO', v: ['Burned-in annotation redacted'] },
        '00120064': { vr: 'SQ', items: [
          { '00080100': { vr: 'SH', v: ['113101'] }, '00080102': { vr: 'SH', v: ['DCM'] }, '00080104': { vr: 'LO', v: ['Clean Pixel Data Option'] } },
          { '00080100': { vr: 'SH', v: ['113105'] }, '00080102': { vr: 'SH', v: ['DCM'] }, '00080104': { vr: 'LO', v: ['Clean Descriptors Option'] } }] },
      } }));
      anon();
      anon();
      const d = files[0].dict;
      const codes = lookupTag(d, '00120064').Value.map(it => s0(it, '00080100'));
      const meth = lookupTag(d, '00120063').Value.map(v => String(v).trim());
      ok('earlier codes (this tool\'s 113101, another tool\'s 113105) survive Anonymize',
         codes.includes('113101') && codes.includes('113105') && codes.includes('113100'), codes.join(','));
      ok('and running it twice adds no duplicates',
         codes.filter(c => c === '113100').length === 1 && new Set(meth).size === meth.length, codes.join(',') + ' | ' + meth.join(' | '));
      ok('the redaction note is kept', meth.includes('Burned-in annotation redacted'), meth.join(' | '));
      const m = reread(files[0]);
      const back = lookupTag(m.dict, '00120063').Value.map(v => String(v));
      ok('(0012,0063) round-trips byte for byte and is 7-bit ASCII',
         back.every(v => /^[\x20-\x7e]*$/.test(v)) && back.join('|') === meth.join('|'), back.join(' | '));
    }

    // D dummies by VR and the attributes that depend on them.
    {
      await load(mono8({ extra: {
        '0040A121': { vr: 'DA', v: ['20200101'] },          // D
        '00080021': { vr: 'DA', v: ['20200102'] },          // X/D
        '0040A493': { vr: 'CS', v: ['VERIFIED'] },
        '0040A073': { vr: 'SQ', items: [{ '0040A075': { vr: 'PN', v: ['OBS^ERVER'] } }] },
        '04000565': { vr: 'CS', v: ['CORRECT'] },
        '00720071': { vr: 'UR', v: new TextEncoder().encode('https://example.org/selector').buffer },
      } }));
      anon();
      const d = files[0].dict;
      ok('D on a date is a non-zero sentinel, not the original', s0(d, '0040A121') === '19000101', s0(d, '0040A121'));
      ok('X/D on a date is zero-length', s0(d, '00080021') === '', s0(d, '00080021'));
      ok('emptying Verifying Observer Sequence also says UNVERIFIED', s0(d, '0040A493') === 'UNVERIFIED', s0(d, '0040A493'));
      ok('Reason for the Attribute Modification gets a defined term', s0(d, '04000565') === 'COERCE', s0(d, '04000565'));
      ok('a UR dummy is a URI', s0(d, '00720071') === 'urn:anonymized', s0(d, '00720071'));
    }

    // Overlay planes go whole, at every level.
    {
      const ov = { '60000010': { vr: 'US', v: [4] }, '60000011': { vr: 'US', v: [4] }, '60000022': { vr: 'LO', v: ['Overlay by Dr Smith'] },
                   '60000100': { vr: 'US', v: [1] }, '60000102': { vr: 'US', v: [0] }, '60001500': { vr: 'LO', v: ['DOE^JOHN MRN'] },
                   '60023000': { vr: 'OB', v: new Uint8Array(2).buffer } };
      await load(mono8({ extra: { ...ov, '00081140': { vr: 'SQ', items: [{ '60001500': { vr: 'LO', v: ['nested DOE'] } }] } } }));
      anon();
      ok('no overlay-group element survives Anonymize, at any depth',
         !allKeys(files[0].dict).some(t => /^60[0-9A-F]{2}/.test(t) && parseInt(t.slice(0, 4), 16) % 2 === 0));
    }

    // Anonymize ends every session undo that could bring identity back.
    {
      await load(mono8());
      pendingEdits.set(editKey('00100010'), { vr: 'PN', valueString: 'Typed^Name' });
      pushHistory();
      files[0].redactBackup = { px: null, tags: {} };
      anon();
      ok('after Anonymize there is no undo step', editHistory.length === 0 && $('undoBtn').disabled);
      ok('and no pixel-edit backup', files[0].redactBackup === null && files[0].pixelBackup === null);
    }

    // Export names after Anonymize carry nothing of the source path.
    {
      await handleFiles([{ file: file(mono8({ n: 1 }), 'IM0001'), path: 'DOE^JOHN_123456/CT/IM0001' },
                         { file: file(mono8({ n: 2 }), 'IM0002'), path: 'DOE^JOHN_123456/CT/IM0002' }]);
      ok('before Anonymize the archive keeps the folder tree', zipNameFor(files[0]).startsWith('DOE^JOHN_123456/CT/'));
      anon();
      const names = files.map(zipNameFor).concat(files.map(exportBaseName));
      ok('after Anonymize no export name carries the source path', names.every(n => !/DOE|JOHN|IM000/.test(n)) &&
         new Set(files.map(zipNameFor)).size === 2, names.join(' '));
    }

    // Non-ASCII written into a file that declares no character set: declared as ISO_IR 192.
    {
      await load(mono8());
      pendingEdits.set(editKey('00100010'), { vr: 'PN', valueString: 'NÚÑEZ^ISABELLA' });
      const m = reread(files[0]);
      ok('a non-ASCII value exports with (0008,0005) ISO_IR 192 and reads back intact',
         s0(m.dict, '00080005') === 'ISO_IR 192' && elToString(lookupTag(m.dict, '00100010')).trim() === 'NÚÑEZ^ISABELLA',
         elToString(lookupTag(m.dict, '00100010')));
    }

    // ================================================================== randomize ==
    {
      const slice = (n) => mono8({ n, extra: { '00100030': { vr: 'DA', v: ['19700101'] } } });
      await load(slice(1), slice(2), slice(3), slice(4), slice(5));
      boxes().forEach(cb => { cb.checked = cb.dataset.opt === 'rtnUIDsOpt'; });
      readDeidOptions();               // a Retain UIDs left over from an earlier Anonymize
      const sop0 = s0(files[0].dict, '00080018');
      $('randomizeBtn').click(); $('confirmOk').click();
      const one = (t) => new Set(files.map(f => s0(f.dict, t))).size === 1;
      ok('Randomize gives one study one fake patient',
         ['00100010', '00100020', '00100030', '00100040', '00101010', '00200010', '00080050'].every(one),
         files.map(f => s0(f.dict, '00100010')).join(' | '));
      ok('the fake age agrees with the fake birth date', s0(files[0].dict, '00101010') === ageAt(s0(files[0].dict, '00100030'), s0(files[0].dict, '00080020')));
      ok('a stale Retain UIDs does not keep the real UIDs', s0(files[0].dict, '00080018') !== sop0 && /^2\.25\./.test(s0(files[0].dict, '0020000D')));
      ok('dates the file did not have are not invented', !lookupTag(files[0].dict, '00080022') && !lookupTag(files[0].dict, '00400244'));
      ok('Randomize writes no de-identification claim', !lookupTag(files[0].dict, '00120062'));
      ok('and leaves no undo step', editHistory.length === 0);
      boxes().forEach(cb => { cb.checked = false; });
      readDeidOptions();
    }

    // ======================================================================= swap ==
    {
      const pat = (n, study, name, dob, date, extra = {}) => mono8({ n, studyUID: study, seriesUID: study + '.1', sopInstance: study + '.1.' + n,
        extra: { '00100030': { vr: 'DA', v: [dob] }, '00101010': { vr: 'AS', v: ['023Y'] }, '00080020': { vr: 'DA', v: [date] },
                 '00080050': { vr: 'SH', v: ['ACC-' + n] }, ...extra } });
      await load(pat(1, ROOT + '61', 'A', '19800101', '20200101', { '00102210': { vr: 'CS', v: ['QUADRUPED'] },
                       '00400275': { vr: 'SQ', items: [{ '00080050': { vr: 'SH', v: ['ACC-1'] } }] } }),
                 pat(2, ROOT + '62', 'B', '20000101', '20230101'));
      const ia = groupStudies()[0].indices, ib = groupStudies()[1].indices;
      swapPatients(ia, ib, true);
      const a = files[ia[0]].dict;
      ok('swap: Anatomical Orientation Type stays with its images', s0(a, '00102210') === 'QUADRUPED');
      ok('swap: Patient\'s Age is recomputed for the receiving study', s0(a, '00101010') === '020Y', s0(a, '00101010'));
      ok('swap: the nested Accession Number moves with the top-level one',
         s0(lookupTag(a, '00400275').Value[0], '00080050') === s0(a, '00080050') && s0(a, '00080050') === 'ACC-2');
    }

    // ===================================================================== pixels ==
    // Redaction removes the Icon Image Sequence (top level and nested) and Undo restores it.
    {
      const icon = { '00280010': { vr: 'US', v: [2] }, '00280011': { vr: 'US', v: [2] }, '7FE00010': { vr: 'OB', v: new Uint8Array([1, 2, 3, 4]).buffer } };
      await load(mono8({ extra: { '00280301': { vr: 'CS', v: ['YES'] }, '00880200': { vr: 'SQ', items: [icon] },
                                  '00081140': { vr: 'SQ', items: [{ '00880200': { vr: 'SQ', items: [icon] } }] } } }));
      const e = files[0];
      const r = await applyRedaction(e, [{ x: 0, y: 0, w: W, h: 2 }], { fill: 'black' });
      ok('redact: applies', !r.error, r.error);
      ok('redact: no Icon Image Sequence is left at any depth while claiming clean pixels',
         !allKeys(e.dict).includes('00880200') && s0(e.dict, '00280301') === 'NO');
      undoRedaction(e);
      ok('redact: Undo puts both icons back', !!lookupTag(e.dict, '00880200') && !!lookupTag(lookupTag(e.dict, '00081140').Value[0], '00880200'));
    }

    // A typed edit survives a redaction and a rotation, and both end the tag undo stack.
    {
      await load(mono8());
      const e = files[0];
      trackEditStart();
      pendingEdits.set(editKey('00100010'), { vr: 'PN', valueString: 'Edited^BeforeRedact' });
      pushHistory();
      await applyRedaction(e, [{ x: 0, y: 0, w: 4, h: 4 }], { fill: 'black' });
      ok('redact: a typed edit survives', e.pending.get(editKey('00100010'))?.valueString === 'Edited^BeforeRedact');
      ok('redact: and reaches the export', elToString(lookupTag(reread(e).dict, '00100010')).trim() === 'Edited^BeforeRedact');
      ok('redact: but (0028,0301) is the redaction\'s', e.pending.get(editKey('00280301'))?.valueString === 'NO');
      ok('redact: the tag undo stack is gone', editHistory.length === 0);
      await applyPixelTransform(e, 'rot90');
      ok('rotate: the typed edit survives too', e.pending.get(editKey('00100010'))?.valueString === 'Edited^BeforeRedact');
    }

    // Big endian: the relabel to little endian swaps every word-sized element, not only pixels.
    {
      const be = Forge.build({ ts: '1.2.840.10008.1.2.2', rows: H, cols: W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
        pixels: px16(), extra: { '60003000': { vr: 'OW', v: new Uint8Array([0x12, 0x34, 0x56, 0x78]).buffer } } });
      await load(be);
      const e = files[0];
      const r = await applyRedaction(e, [{ x: 0, y: 0, w: 4, h: 4 }], { fill: 'black' });
      const m = reread(e);
      const ow = new Uint8Array(lookupTag(m.dict, '60003000').Value[0]);
      ok('big endian: after a redaction the overlay words are little endian too',
         !r.error && metaTS(m.meta) === '1.2.840.10008.1.2.1' && ow[0] === 0x34 && ow[1] === 0x12 && ow[2] === 0x78 && ow[3] === 0x56,
         [...ow].map(x => x.toString(16)).join(' '));
      undoRedaction(e);
      ok('big endian: Undo is big endian again', metaTS(e.meta) === '1.2.840.10008.1.2.2' &&
         new Uint8Array(lookupTag(e.dict, '60003000').Value[0])[0] === 0x12);
    }

    // A JPEG Lossless codestream that disagrees with the header is refused, not zero-padded.
    {
      const s16 = new Uint8Array(16 * 32);
      const cs = Forge.jpegLossless(s16, 16, 32, 1, 8);
      await load(Forge.build({ ts: '1.2.840.10008.1.2.4.70', rows: 32, cols: 32, pi: 'MONOCHROME2', ba: 8, bs: 8, hb: 7, pr: 0,
        encapsulated: [cs], extra: { '00280301': { vr: 'CS', v: ['YES'] } } }));
      const r = await applyRedaction(files[0], [{ x: 0, y: 0, w: 4, h: 4 }], { fill: 'black' });
      ok('JPEG Lossless: a 16x32 codestream under a 32x32 header is refused', !!r.error && /Rows and Columns/.test(r.error), r.error);
      ok('and the file still says Burned In Annotation = YES', s0(files[0].dict, '00280301') === 'YES');
    }

    // Fragment grouping, palette tables and frame counts.
    {
      const jp = (n) => { const b = new Uint8Array(n); b[0] = 0xFF; b[1] = 0xD8; return b.buffer; };
      const g = groupFragmentsByFrame([jp(8), new ArrayBuffer(6), jp(8)], 2);
      ok('fragments: a split frame is reassembled by its start marker', g && g.length === 2 && g[0].byteLength === 14, g && g.map(b => b.byteLength).join(','));
      ok('fragments: counts that cannot be assigned are refused', groupFragmentsByFrame([jp(8), new ArrayBuffer(6), new ArrayBuffer(6)], 2) === null);
      const lut = (desc, bytes) => ({ '00281101': { vr: 'US', Value: desc }, '00281201': { vr: 'OW', Value: [new Uint8Array(bytes).buffer] } });
      ok('palette: a 16-bit table too short for its descriptor is unreadable', readPaletteLut(lut([9, 0, 16], new Array(16).fill(1)), '00281101', '00281201') === null);
      const padded = []; for (let i = 0; i < 4; i++) padded.push(10 + i, 0);
      const r8 = readPaletteLut(lut([4, 0, 8], padded), '00281101', '00281201');
      ok('palette: 8-bit entries padded to 16 bits are read by word', r8 && [...r8.lut].join(',') === '10,11,12,13', r8 && [...r8.lut].join(','));
      const b8 = readPaletteLut(lut([4, 0, 8], [11, 10, 13, 12]), '00281101', '00281201', true);
      ok('palette: 8-bit entries in big endian are unswapped', b8 && [...b8.lut].join(',') === '10,11,12,13', b8 && [...b8.lut].join(','));
      await load(mono8({ extra: { '00280008': { vr: 'IS', v: ['-2'] } } }));
      const nf = await decodeStoredFrames(files[0].dict, files[0].meta);
      ok('a negative Number of Frames is refused', !!nf.error, nf.error);
    }

    // J2K: only an MCT (YBR_RCT / YBR_ICT) is relabelled RGB.
    {
      const cs = Forge.codestream('J2K_RGB_RCT');
      const mk = (pi) => Forge.build({ ts: '1.2.840.10008.1.2.4.90', rows: 32, cols: 32, pi, spp: 3, ba: 8, bs: 8, hb: 7, pr: 0, encapsulated: [cs] });
      await load(mk('YBR_FULL'));
      const a = await decodeStoredFrames(files[0].dict, files[0].meta);
      await load(mk('YBR_RCT'));
      const b = await decodeStoredFrames(files[0].dict, files[0].meta);
      ok('J2K: YBR_FULL keeps its label, YBR_RCT becomes RGB', a.pi === 'YBR_FULL' && b.pi === 'RGB', `${a.pi} / ${b.pi}`);
    }

    // The display decoder refuses before allocating, and never leaves a stale picture.
    {
      const huge = Forge.build({ rows: 16000, cols: 16000, pi: 'MONOCHROME2', ba: 16, bs: 16, hb: 15, pr: 0, pixels: new Uint16Array(4) });
      await load(huge);
      const t0 = performance.now();
      const r = await decodeDicomPixels(files[0].dict, 0, { meta: files[0].meta });
      ok('a 16000x16000 header with 8 bytes of pixels is refused quickly', !!r?.error && performance.now() - t0 < 2000, r?.error);
      const good = mono8();
      const cut = good.slice(0, good.length - 3);
      await load(cut);
      const t = await decodeDicomPixels(files[0].dict, 0, { meta: files[0].meta });
      ok('a truncated Pixel Data is an error, not garbage', !!t?.error && /truncated/i.test(t.error), t?.error);
    }

    // Rotate / invert retagging.
    {
      await load(mono8({ extra: { '00181312': { vr: 'CS', v: ['ROW'] } } }));
      await applyPixelTransform(files[0], 'rot90');
      ok('rotate: In-plane Phase Encoding Direction follows a quarter turn', s0(files[0].dict, '00181312') === 'COL');
      ok('rotate: private 60xx groups are not overlay planes', unmovedByTransform({ '60013000': {} }).length === 0 &&
         unmovedByTransform({ '601E3000': {} }).length === 1);
      const sop = s0(files[0].dict, '00080018');
      pushHistory();                     // an earlier tag edit, so there is an undo step to end
      const stepsBefore = editHistory.length;
      invertPhotometric(files[0]);
      ok('invert: a new SOP Instance UID and a derivation record',
         s0(files[0].dict, '00080018') !== sop && /Photometric Interpretation/.test(s0(files[0].dict, '00082111')));
      const invSop = s0(files[0].dict, '00080018');
      ok('invert: ends the tag undo stack (an older snapshot holds the pre-invert UID)', stepsBefore > 0 && editHistory.length === 0, `${stepsBefore} -> ${editHistory.length}`);
      undoPixelTransform(files[0]);
      ok('invert: a later Undo of the rotate keeps the invert and its new instance UID',
         s0(files[0].dict, '00280004') === 'MONOCHROME1' && s0(files[0].dict, '00080018') === invSop,
         `${s0(files[0].dict, '00280004')} ${s0(files[0].dict, '00080018') === invSop}`);
      const enh = mono8({ sopClass: '1.2.840.10008.5.1.4.1.1.4.1', extra: { '52009229': { vr: 'SQ', items: [{
        '00189226': { vr: 'SQ', items: [{ '00089007': { vr: 'CS', v: ['ORIGINAL', 'PRIMARY', 'VOLUME', 'NONE'] } }] } }] } } });
      await load(enh);
      await applyRedaction(files[0], [{ x: 0, y: 0, w: 2, h: 2 }], { fill: 'black' });
      const ft = lookupTag(lookupTag(lookupTag(files[0].dict, '52009229').Value[0], '00189226').Value[0], '00089007').Value;
      ok('enhanced: Frame Type value 1 becomes DERIVED with Image Type', ft[0] === 'DERIVED', ft.join('\\'));
    }

    // ================================================================ edit tags ==
    {
      await load(mono8());
      $('addTagBtn').click();
      const add = (code, vr, val) => { $('addTagCode').value = code; $('addTagVR').value = vr; $('addTagVal').value = val; $('addTagConfirm').click(); };
      add('(0018,1030)', 'LO', 'PROTO-NEW');
      add('(0010,0010)', 'LO', 'New^Name');
      add('(0002,0010)', 'UI', '1.2');
      add('(7FE0,0010)', 'LO', 'oops');
      const m = reread(files[0]);
      ok('Add Tag writes the tag that was asked for', s0(m.dict, '00181030') === 'PROTO-NEW' && s0(m.dict, '00081030') === 'Forge test',
         `${s0(m.dict, '00181030')} / ${s0(m.dict, '00081030')}`);
      ok('adding an existing tag edits it (one element, the new value)',
         elToString(lookupTag(m.dict, '00100010')).trim() === 'New^Name' && Object.keys(m.dict).filter(k => /00100010/i.test(k)).length === 1);
      ok('no group 0000-0007 element reaches the dataset', !Object.keys(m.dict).some(k => /^000[0-7]/.test(k)));
      ok('a known tag gets its dictionary VR', m.dict['00100010']?.vr === 'PN', m.dict['00100010']?.vr);
      ok('the table shows the added tag once', [...tagBody.querySelectorAll('tr')].filter(tr => tr.dataset.path === '00181030').length === 1);
      performUndo(); performUndo();
      const m2 = reread(files[0]);
      ok('Undo takes the added tag out again', !lookupTag(m2.dict, '00181030'));
    }

    // Working-copy parsing.
    {
      ok('parse: US out of range is refused, not wrapped', parseByVR('US', '70000') === null && parseByVR('US', '-1') === null);
      ok('parse: non-decimal numbers are refused', parseByVR('US', '0x10') === null && parseByVR('US', 'abc') === null);
      ok('parse: a cleared number is zero-length', parseByVR('US', '').length === 0);
      ok('parse: AT takes (gggg,eeee)', parseByVR('AT', '(0018,1063)')[0] === 0x00181063 && parseByVR('AT', 'nope') === null);
      ok('display: AT shows as a tag', elToString({ vr: 'AT', Value: [0x00181063] }) === '(0018,1063)');
      ok('parse: LT keeps leading spaces and backslashes', parseByVR('LT', '  C:\\scans')[0] === '  C:\\scans');
      ok('parse: an over-long DS goes to the writer as a number', typeof parseByVR('DS', '-0.123456789012345')[0] === 'number');
      await load(mono8());
      ok('editKey resolves a letter-bearing tag to the dataset\'s own key', editKey('0008103e') === '0008103E' || !('0008103e' in dict));
      pendingEdits.set(editKey('00280010'), { vr: 'US', valueString: '70000' });
      ok('an invalid typed value leaves the element as it was', Number(v0(reread(files[0]).dict, '00280010')) === H);
    }

    // ================================================================== SR view ==
    {
      const code = (v, m) => ({ vr: 'SQ', items: [{ '00080100': { vr: 'SH', v: [v] }, '00080102': { vr: 'SH', v: ['DCM'] }, '00080104': { vr: 'LO', v: [m] } }] });
      const sr = Forge.build({ rows: 2, cols: 2, pi: 'MONOCHROME2', ba: 8, pixels: new Uint8Array(4), sopClass: '1.2.840.10008.5.1.4.1.1.88.11', extra: {
        '0040A040': { vr: 'CS', v: ['CONTAINER'] },
        '0040A730': { vr: 'SQ', items: [
          { '0040A040': { vr: 'CS', v: ['TEXT'] }, '0040A043': code('121071', 'Finding'), '0040A160': { vr: 'UT', v: ['Line one.\r\nLine <b id="srxss">two</b>.'] } },
          { '0040A040': { vr: 'CS', v: ['CONTAINER'] }, '0040A043': code('111', 'Section'), '0040A730': { vr: 'SQ', items: [
            { '0040A040': { vr: 'CS', v: ['NUM'] }, '0040A043': code('222', 'Diameter'),
              '0040A300': { vr: 'SQ', items: [{ '0040A30A': { vr: 'DS', v: ['12.5'] }, '004008EA': code('mm', 'millimeter') }] } }] } },
          { '0040A040': { vr: 'CS', v: ['UIDREF'] }, '0040A043': code('333', 'Ref'), '0040A124': { vr: 'UI', v: ['1.2.3'] } },
        ] },
      } });
      await load(sr);
      renderSR(withPendingEdits(files[0]));
      const txt = $('srView').textContent;
      ok('SR: labels, text, nested numbers and UIDREF render', /Finding/.test(txt) && /Line one\./.test(txt) &&
         /Diameter/.test(txt) && /12\.5 millimeter/.test(txt) && /1\.2\.3/.test(txt), txt.slice(0, 160));
      ok('SR: nested containers are walked', $('srView').querySelectorAll('.sr-container').length >= 1);
      ok('SR: a text value is text, never markup', !$('srView').querySelector('#srxss'));
      ok('SR: Text Value keeps its line breaks', getComputedStyle($('srView').querySelector('.sr-value')).whiteSpace === 'pre-wrap');
      ok('SR: every current 88.* SR class is recognised', detectSR({ '00080016': { vr: 'UI', Value: ['1.2.840.10008.5.1.4.1.1.88.76'] } }) &&
         !detectSR({ '00080016': { vr: 'UI', Value: ['1.2.840.10008.5.1.4.1.1.7'] } }));
    }

    // ================================================================ validator ==
    {
      const iss = (extra, cfg = {}) => { const b = mono8({ extra, ...cfg }); const m = DicomMessage.readFile(b.buffer); normBin(m.dict); return validateDicom(m.dict, m.meta); };
      ok('validator: an SR Value Type is enum-checked (the key was 9 hex digits)',
         iss({ '0040A040': { vr: 'CS', v: ['BOGUS'] } }).some(i => i.tag.toLowerCase() === '0040a040' && /defined value/.test(i.msg)));
      ok('validator: Pixel Representation 2 is flagged', iss({ '00280103': { vr: 'US', v: [2] } }).some(i => i.tag.toLowerCase() === '00280103'));
      ok('validator: Enhanced MR does not demand Scanning Sequence',
         !iss({}, { sopClass: '1.2.840.10008.5.1.4.1.1.4.1' }).some(i => i.sev === 'error' && /00180020|00180021/.test(i.tag)));
      ok('validator: 16-bit Ophthalmic Photography is a known SOP class',
         !iss({}, { sopClass: '1.2.840.10008.5.1.4.1.1.77.1.5.2' }).some(i => /Unknown SOP Class/.test(i.msg)));
      ok('validator: Modality AU is a defined term', !iss({}, { modality: 'AU' }).some(i => i.tag === '00080060'));
      ok('validator: a private value is a PHI flag', iss({ '00090010': { vr: 'LO', v: ['V'] }, '00091010': { vr: 'LO', v: ['DOE^JOHN'] } })
         .some(i => i.sev === 'phi' && i.tag.toLowerCase() === '00091010'));
      ok('validator: identity nested in a sequence is a PHI flag',
         iss({ '00101002': { vr: 'SQ', items: [{ '00100020': { vr: 'LO', v: ['MRN-7781234'] } }] } }).some(i => i.sev === 'phi' && /MRN-7781234/.test(i.val)));
      ok('validator: phone numbers (Table E.1-1 X) are PHI', iss({ '00102154': { vr: 'SH', v: ['555-0100'] } }).some(i => i.sev === 'phi'));
      ok('validator: no issue carries a fix that would mutate the dataset', iss({ '00081030': { vr: 'LO', v: ['x'.repeat(70)] } }).every(i => !i.fix));
    }

    // ==================================================================== W / L ==
    {
      await load(mono8({ wc: 0, ww: 100 }));
      await drawPreview(dict, 0);
      setWL(300, 600);
      $('wlResetBtn').click();
      ok('W/L Reset restores a Window Center of 0', pendingEdits.get(editKey('00281050'))?.valueString === '0',
         pendingEdits.get(editKey('00281050'))?.valueString);
      const rgb = Forge.build({ rows: H, cols: W, pi: 'RGB', spp: 3, ba: 8, pixels: new Uint8Array(W * H * 3) });
      await load(rgb);
      await drawPreview(dict, 0);
      ok('W/L is not offered for an RGB image', $('wlSection').classList.contains('hidden'));
    }

    // ================================================================= ordering ==
    {
      const s = (n, study, sn) => mono8({ n, studyUID: study, seriesUID: study + '.1', sopInstance: study + '.1.' + n, instance: n,
                                          extra: { '00200011': { vr: 'IS', v: [String(sn)] } } });
      await load(s(1, ROOT + '81', 1), s(1, ROOT + '82', 1), s(2, ROOT + '81', 1), s(2, ROOT + '82', 1));
      const st = files.map(f => s0(f.dict, '0020000D'));
      ok('two studies with the same Series Number stay contiguous', st[0] === st[1] && st[2] === st[3] && st[1] !== st[2], st.join(' '));
      trackEditStart(); pendingEdits.set(editKey('00100010'), { vr: 'PN', valueString: 'X^Y' }); pushHistory();
      switchFile(1);
      ok('switching files ends the undo stack (it is the previous file\'s)', editHistory.length === 0 && $('undoBtn').disabled);
    }

    // ===================================================================== zip ==
    {
      const nfc = 'é.dcm'.normalize('NFC'), nfd = 'é.dcm'.normalize('NFD');
      const u = zipUniqueNames([nfc, nfd]);
      ok('zip: NFC and NFD spellings of one name are de-duplicated', u[0] !== u[1] && /_2/.test(u[1]), u.join(' '));
      ok('zip: a name over 65535 UTF-8 bytes is refused, not truncated',
         zipStore([{ name: 'd/'.repeat(33000) + 'x.dcm', bytes: new Uint8Array(1) }]) === null);
      const big = 0xFFFFFFFF - 400;
      const ch = zipChunks([0, 1, 2].map(i => ({ name: '患者/シリーズ/画像00' + i + '.dcm', bytes: { length: Math.floor(big / 3) } })));
      ok('zip: multibyte names are costed as UTF-8, so a near-4 GB set is split', ch.length >= 2, String(ch.length));
    }

    // ===================================================================== OCR ==
    {
      const O = window.imgOcr;
      const line = (terms, ...ws) => O.matchLine(ws.map(text => ({ text })), terms).map(Boolean);
      const tm = O.terms({ '00080030': { vr: 'TM', Value: ['103000'] } });
      ok('OCR: a bare HHMM needs a time separator', !line(tm, '10.30', 'cm')[0] && line(tm, '10:30')[0]);
      ok('OCR: Ł folds to L', O.norm('Łódź') === O.norm('LODZ'), O.norm('Łódź'));
      const ls = O.terms({ '00100010': { vr: 'PN', Value: ['Li^So'] } });
      ok('OCR: a short name that folds to digits does not claim numbers', !line(ls, '11', '50', 'mm').some(Boolean) && line(ls, 'LI')[0]);
      const st = O.terms({ '00081010': { vr: 'SH', Value: ['CT'] } });
      ok('OCR: a two-letter Station Name does not claim the modality label', !line(st, 'CT', 'HEAD')[0]);
      const rq = O.terms({ '00321032': { vr: 'PN', Value: ['Smith^Anne'] } });
      ok('OCR: Requesting Physician is derived', line(rq, 'REQ:', 'SMITH')[1]);
      const dets = [{ x: 10, y: 10, w: 30, h: 10, field: 'Patient Name', text: 'DOE' },
                    { x: 39.5, y: 10, w: 20, h: 10, field: null, text: 'size' },
                    { x: 64, y: 10, w: 60, h: 10, field: null, text: '12.3mm' }];
      const key = (bs) => bs.map(b => `${b.on}`).sort().join(',');
      const k1 = key(O.merge(dets.slice(), 300, 200)), k2 = key(O.merge(dets.slice().reverse(), 300, 200));
      ok('OCR: box merging does not depend on detection order', k1 === k2, `${k1} / ${k2}`);
    }

    // ================================================================ security ==
    {
      window.__xss = 0;
      await handleFiles([new File([new Uint8Array(300)], '<img src=x onerror="window.__xss=1">.dcm')]);
      await tick(50);
      ok('XSS: a hostile file name is shown as text', !errorBanner.querySelector('img') && /<img/.test(errorBanner.textContent) && !window.__xss);
      ok('CSP: the page forbids inline script and foreign connections', (() => {
        const m = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
        const c = m && m.getAttribute('content') || '';
        return /script-src[^;]*'self'/.test(c) && !/script-src[^;]*unsafe-inline/.test(c) && /connect-src 'self'/.test(c) && /object-src 'none'/.test(c);
      })());
      await load(mono8({ extra: { '00080070': { vr: 'LO', v: ['SIEMENS'] }, '00081090': { vr: 'LO', v: ['SOMATOM'] } } }));
      if (typeof renderOverview === 'function') renderOverview();
      ok('no request is built from the Manufacturer: the picture is the placeholder', /^data:/.test($('ovMfrImg')?.src || 'data:'));
      const real = Storage.prototype.getItem;
      Storage.prototype.getItem = () => { throw new DOMException('blocked', 'SecurityError'); };
      let threw = null;
      try { renderOverview(); } catch (e) { threw = e.message; } finally { Storage.prototype.getItem = real; }
      ok('blocked storage does not break the Overview', !threw, threw);
    }

    // #load=: foreign hosts are asked about first; non-http schemes and the query string are refused.
    {
      const realFetch = window.fetch, calls = [];
      window.fetch = (u) => { calls.push(String(u)); return Promise.reject(new Error('stubbed')); };
      const deep = async (hash) => {
        history.replaceState(null, '', location.pathname + location.search + hash);
        window.dispatchEvent(new Event('load'));
        await tick(30);
      };
      try {
        await load(mono8());              // an open study: the forged-sample links stand aside
        await deep('#load=' + encodeURIComponent('https://example.invalid/m.json'));
        const asked = $('confirmOverlay').classList.contains('visible') && /example\.invalid/.test($('confirmMsg').textContent);
        ok('#load= from another host asks first, naming it, and fetches nothing yet', asked && calls.length === 0, calls.join(' '));
        $('confirmCancel').click();
        await tick(10);
        ok('declining fetches nothing', calls.length === 0);
        ok('and the link is gone from the address bar', !/load=/.test(location.hash));
        await deep('#load=' + encodeURIComponent('data:application/json,{"files":[]}'));
        ok('a data: manifest is refused without a fetch', calls.length === 0 && !$('confirmOverlay').classList.contains('visible'));
      } finally {
        window.fetch = realFetch;
        if ($('confirmOverlay').classList.contains('visible')) $('confirmCancel').click();
        history.replaceState(null, '', location.pathname + location.search);
      }
    }

    // ================================================================== create ==
    {
      const v = applyCreatePrefill({ patient_name: 'DOE\u007fJANE', patient_id: 'P\u0085X', accession: 12345 });
      ok('Create prefill refuses DEL / C1 controls and non-string values', !v.patient_name && !v.patient_id && !v.accession);
      switchTab('editor');
    }
  } catch (e) {
    ok('suite ran to completion', false, (e && (e.stack || e.message)) || String(e));
  }
  return out;
};

if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.review()).join('\n');
  document.body.appendChild(pre);
}, { once: true });
