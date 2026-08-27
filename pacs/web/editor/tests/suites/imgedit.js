// Rotate and flip written into the stored pixels: does the picture actually
// turn, in every frame, in the file's own numbers — and does the geometry that
// describes it turn with it?
//
// Two things are asked of every case, and they are different questions. The
// PIXELS must be a permutation: every sample that was in the image is still in
// the image, at the one place the op maps it to, with nothing resampled and
// nothing rounded — checked against tests/dicom-forge.js's reference image
// rather than against the app's own idea of the picture. The GEOMETRY must
// still describe the same patient: Rows and Columns exchanged, Pixel Spacing
// with them, and (0020,0037) / (0020,0032) recomputed so that the pixel which
// moved to the top-left is the one (0020,0032) now names. That second question
// is asked against numbers worked out by hand in the comments below, because a
// rotation that renumbers the geometry to agree with itself would pass any test
// that only compared the app against the app.
//
// Both are then asked again of the file that comes back out of buildEditedFile:
// a rotation that only exists in memory is not a rotation.
(window.SUITES || (window.SUITES = {})).imgedit = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);

  try {
    const cases = await Forge.corpus();
    const byId = Object.fromEntries(cases.map(c => [c.id, c]));
    const bytesOf = (b) => b.buffer ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b;

    async function install(bytes, name) {
      await handleFiles([new File([bytesOf(bytes)], name || 'imgedit.dcm', { type: 'application/dicom' })]);
      return files[0];
    }
    const decode = (entry, frame = 0) => decodeDicomPixels(entry.dict, frame, { meta: entry.meta });
    async function roundTrip(entry) {
      const msg = DicomMessage.readFile(await buildEditedFile(entry).arrayBuffer());
      normBin(msg.dict);
      return { dict: msg.dict, meta: msg.meta || {}, name: entry.name };
    }
    const tagOf  = (d, t) => lookupTag(d, t)?.Value?.[0];
    const listOf = (d, t) => (lookupTag(d, t)?.Value || []).map(v => Number(v));
    const strsOf = (d, t) => (lookupTag(d, t)?.Value || []).map(v => String(v));
    const tsOf   = (m) => String(m?.['00020010']?.Value?.[0] ?? m?.TransferSyntaxUID?.Value?.[0] ?? '');
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const sameNums = (got, want) => got.length === want.length && got.every((v, i) => near(v, want[i]));

    // The whole point of the exercise, stated once: a destination pixel must
    // hold exactly the source pixel the op maps to it. Compared against the
    // forge's reference RGBA, so a decoder that is wrong in the same way the
    // rotation is wrong still fails.
    function movedMatches(pixels, want, w, h, opKey, tol) {
      if (!pixels) return 'nothing decoded';
      const op = PIXEL_OPS[opKey];
      const nW = op.swap ? h : w, nH = op.swap ? w : h;
      tol = tol || 0;
      let bad = 0, worst = 0, firstAt = -1;
      for (let y = 0; y < nH; y++) for (let x = 0; x < nW; x++) {
        const s = (op.sy(x, y, w, h) * w + op.sx(x, y, w, h)) * 4;
        const p = (y * nW + x) * 4;
        for (let c = 0; c < 3; c++) {
          const dv = Math.abs(pixels[p + c] - want[s + c]);
          if (dv > tol) { bad++; if (dv > worst) worst = dv; if (firstAt < 0) firstAt = y * nW + x; break; }
        }
      }
      return bad ? `${bad} of ${nW * nH} px are not the pixel that should have moved there, worst ${worst}, first at ${firstAt}` : null;
    }

    // ---- the mapping, on every raw encoding ---------------------------------
    // One op per case rather than five, to keep the run short; the op cycles so
    // every one of them is exercised across the list, and the arithmetic that
    // could differ per encoding is the addressing, not the op.
    const OPS = ['rot90', 'rot270', 'rot180', 'flipH', 'flipV'];
    const RAW_CASES = ['mono2-u8', 'mono2-u16-b12', 'mono2-u16-b16', 'mono2-s16-b12',
                       'mono1-u16', 'rgb-planar0', 'rgb-planar1', 'ybr-full',
                       'palette-color', 'implicit-vr', 'big-endian'];
    for (let i = 0; i < RAW_CASES.length; i++) {
      const id = RAW_CASES[i], opKey = OPS[i % OPS.length];
      const c = byId[id];
      const entry = await install(c.bytes, id + '.dcm');
      const res = await applyPixelTransform(entry, opKey);
      if (res.error) { ok(`${id}: ${opKey} applies`, false, res.error); continue; }

      const want = Forge.expected(c.ref, c.w, c.h);
      const live = await decode(entry);
      if (!live || live.error) { ok(`${id}: still decodes after ${opKey}`, false, live ? live.error : 'null'); continue; }
      const miss = movedMatches(live.pixels, want, c.w, c.h, opKey, c.tol);
      ok(`${id}: ${opKey} moves every pixel to where it belongs`, !miss, miss || '');

      const rt = await roundTrip(entry);
      const back = await decode(rt);
      if (!back || back.error) { ok(`${id}: the written file decodes`, false, back ? back.error : 'null'); continue; }
      const missBack = movedMatches(back.pixels, want, c.w, c.h, opKey, c.tol);
      ok(`${id}: and buildEditedFile writes that image out`, !missBack, missBack || '');
    }

    // ---- compressed in, uncompressed out ------------------------------------
    // Same door redaction goes through, so the same conversion is expected: the
    // pixels come back at their own precision and the file says Explicit VR LE.
    for (const id of ['rle-mono16', 'rle-rgb', 'jpeg-lossless-mono16', 'j2k-mono16-b12', 'jls-mono16-b12']) {
      const c = byId[id];
      if (!c) { ok(`${id}: case exists in the corpus`, false, 'missing'); continue; }
      const entry = await install(c.bytes, id + '.dcm');
      const res = await applyPixelTransform(entry, 'rot90');
      if (res.error) { ok(`${id}: rot90 applies`, false, res.error); continue; }
      ok(`${id}: rot90 converts the transfer syntax`, res.converts === true, `converts=${res.converts}`);
      ok(`${id}: the file now says Explicit VR Little Endian`,
         tsOf(entry.meta) === '1.2.840.10008.1.2.1', tsOf(entry.meta));
      const want = Forge.expected(c.ref, c.w, c.h);
      const live = await decode(entry);
      const miss = live && !live.error ? movedMatches(live.pixels, want, c.w, c.h, 'rot90', c.tol) : (live ? live.error : 'null');
      ok(`${id}: and the picture is the turned picture`, !miss, miss || '');
    }

    // ---- a codec with no decoder is refused before anything is written ------
    {
      const entry = await install(byId['mpeg2-unsupported'].bytes, 'mpeg.dcm');
      const before = tagOf(entry.dict, '00280010');
      const res = await applyPixelTransform(entry, 'rot90');
      ok('mpeg2: rot90 is refused rather than half-done', !!res.error, res.error || 'no error');
      ok('mpeg2: and Rows is left alone', tagOf(entry.dict, '00280010') === before);
      ok('mpeg2: the buttons know before the click', redactionSupport(entry.meta).ok === false);
    }

    // ---- every frame, not just the one on screen ----------------------------
    for (const id of ['multiframe-mono', 'multiframe-rgb', 'rle-multiframe']) {
      const c = byId[id];
      const entry = await install(c.bytes, id + '.dcm');
      const res = await applyPixelTransform(entry, 'rot270');
      if (res.error) { ok(`${id}: rot270 applies`, false, res.error); continue; }
      const frames = res.frames;
      ok(`${id}: every frame is accounted for`, frames === (c.frames || 1), `${frames} vs ${c.frames}`);
      let worstFrame = null;
      for (let f = 0; f < frames; f++) {
        const want = Forge.expected(c.frameRef ? c.frameRef(f) : c.ref, c.w, c.h);
        const live = await decode(entry, f);
        const miss = live && !live.error ? movedMatches(live.pixels, want, c.w, c.h, 'rot270', c.tol)
                                         : (live ? live.error : 'null');
        if (miss && !worstFrame) worstFrame = `frame ${f}: ${miss}`;
      }
      ok(`${id}: and each one is turned`, !worstFrame, worstFrame || '');
    }

    // ---- a non-square image, where Rows and Columns can actually be wrong ---
    // The corpus is 32x32 on purpose, which is exactly the shape that hides a
    // Rows/Columns mix-up. This one is 6 wide and 4 high, with every sample
    // distinct, so the assertion below is about addressing and nothing else.
    const GW = 6, GH = 4;
    const gPixels = new Uint8Array(GW * GH);
    for (let i = 0; i < GW * GH; i++) gPixels[i] = i + 1;        // 1..24, all distinct
    const geoExtra = () => ({
      '00200020': { vr: 'CS', v: ['L', 'F'] },                   // Patient Orientation
      '00200032': { vr: 'DS', v: ['-10', '-20', '5'] },          // Image Position (Patient)
      '00200037': { vr: 'DS', v: ['1', '0', '0', '0', '1', '0'] },
      '00280030': { vr: 'DS', v: ['0.5', '0.25'] },              // [between rows, between columns]
      '00280034': { vr: 'IS', v: ['2', '1'] },                   // Pixel Aspect Ratio
    });
    const geoBytes = () => Forge.build({
      rows: GH, cols: GW, pi: 'MONOCHROME2', ba: 8, bs: 8, hb: 7, pr: 0,
      wc: 128, ww: 256, pixels: gPixels, extra: geoExtra(),
    });
    const storedOf = (entry) => new Uint8Array(lookupTag(entry.dict, '7fe00010').Value[0]);

    // Worked out by hand from PS3.3 C.7.6.2.1.1, with the old row vector
    // r = (1,0,0), the old column vector c = (0,1,0), 0.25 mm between columns
    // and 0.5 mm between rows:
    //   rot90  the pixel at (0, 3) becomes the top-left → IPP + c·0.5·3
    //   rot270 the pixel at (5, 0) becomes the top-left → IPP + r·0.25·5
    //   rot180 (5, 3) → both shifts; flipH (5, 0); flipV (0, 3)
    const GEO = {
      rot90:  { rows: 6, cols: 4, ps: [0.25, 0.5], par: [1, 2],
                iop: [0, -1, 0, 1, 0, 0], ipp: [-10, -18.5, 5], po: ['H', 'L'] },
      rot270: { rows: 6, cols: 4, ps: [0.25, 0.5], par: [1, 2],
                iop: [0, 1, 0, -1, 0, 0], ipp: [-8.75, -20, 5], po: ['F', 'R'] },
      rot180: { rows: 4, cols: 6, ps: [0.5, 0.25], par: [2, 1],
                iop: [-1, 0, 0, 0, -1, 0], ipp: [-8.75, -18.5, 5], po: ['R', 'H'] },
      flipH:  { rows: 4, cols: 6, ps: [0.5, 0.25], par: [2, 1],
                iop: [-1, 0, 0, 0, 1, 0], ipp: [-8.75, -20, 5], po: ['R', 'F'] },
      flipV:  { rows: 4, cols: 6, ps: [0.5, 0.25], par: [2, 1],
                iop: [1, 0, 0, 0, -1, 0], ipp: [-10, -18.5, 5], po: ['L', 'H'] },
    };

    for (const opKey of OPS) {
      const want = GEO[opKey];
      const entry = await install(geoBytes(), `geo-${opKey}.dcm`);
      const res = await applyPixelTransform(entry, opKey);
      if (res.error) { ok(`geometry ${opKey}: applies`, false, res.error); continue; }

      const d = entry.dict;
      ok(`geometry ${opKey}: Rows/Columns are ${want.rows}x${want.cols}`,
         tagOf(d, '00280010') === want.rows && tagOf(d, '00280011') === want.cols,
         `${tagOf(d, '00280010')}x${tagOf(d, '00280011')}`);
      ok(`geometry ${opKey}: Pixel Spacing follows the axes`,
         sameNums(listOf(d, '00280030'), want.ps), listOf(d, '00280030').join('\\'));
      ok(`geometry ${opKey}: Pixel Aspect Ratio follows them too`,
         sameNums(listOf(d, '00280034'), want.par), listOf(d, '00280034').join('\\'));
      ok(`geometry ${opKey}: Image Orientation (Patient) is exact`,
         sameNums(listOf(d, '00200037'), want.iop), listOf(d, '00200037').join('\\'));
      ok(`geometry ${opKey}: Image Position (Patient) names the pixel that moved to (0,0)`,
         sameNums(listOf(d, '00200032'), want.ipp), listOf(d, '00200032').join('\\'));
      ok(`geometry ${opKey}: Patient Orientation is turned with the axes`,
         strsOf(d, '00200020').join('\\') === want.po.join('\\'), strsOf(d, '00200020').join('\\'));

      // The samples themselves, addressed by hand rather than through the app's
      // decoder — this is the assertion that a Rows/Columns mix-up fails.
      const px = storedOf(entry);
      const op = PIXEL_OPS[opKey];
      let bad = null;
      for (let y = 0; y < want.rows && !bad; y++) for (let x = 0; x < want.cols; x++) {
        const src = gPixels[op.sy(x, y, GW, GH) * GW + op.sx(x, y, GW, GH)];
        if (px[y * want.cols + x] !== src) { bad = `at (${x},${y}) got ${px[y * want.cols + x]}, want ${src}`; break; }
      }
      ok(`geometry ${opKey}: every stored sample is where the op puts it`, !bad, bad || '');

      // And the geometry survives the writer, which is the only form of it
      // anyone downstream will ever see.
      const rt = await roundTrip(entry);
      ok(`geometry ${opKey}: the exported file carries Rows/Columns`,
         tagOf(rt.dict, '00280010') === want.rows && tagOf(rt.dict, '00280011') === want.cols,
         `${tagOf(rt.dict, '00280010')}x${tagOf(rt.dict, '00280011')}`);
      ok(`geometry ${opKey}: and the exported orientation`,
         sameNums(listOf(rt.dict, '00200037'), want.iop), listOf(rt.dict, '00200037').join('\\'));
    }

    // ---- which way is clockwise ---------------------------------------------
    // Every assertion above addresses the moved pixels through PIXEL_OPS, which
    // means none of them can tell a clockwise turn from a counter-clockwise one:
    // swap the two definitions and they all still pass. This one is written by
    // hand. Turning a picture clockwise carries its top-left corner to the top
    // RIGHT, and the pixel that was beside it comes to rest under it.
    for (const [opKey, land, second] of [
      ['rot90',  [3, 0], [3, 1]],   // 6x4 → 4x6: top-left to the top-right column
      ['rot270', [0, 5], [0, 4]],   //            top-left to the bottom-left
      ['rot180', [5, 3], [4, 3]],
      ['flipH',  [5, 0], [4, 0]],
      ['flipV',  [0, 3], [1, 3]],
    ]) {
      const entry = await install(geoBytes(), `handed-${opKey}.dcm`);
      const res = await applyPixelTransform(entry, opKey);
      const px = storedOf(entry), w = tagOf(entry.dict, '00280011');
      ok(`${opKey}: the top-left sample lands at (${land.join(',')})`,
         !res.error && px[land[1] * w + land[0]] === gPixels[0],
         res.error || `got ${px[land[1] * w + land[0]]}, want ${gPixels[0]}`);
      ok(`${opKey}: and the sample beside it at (${second.join(',')})`,
         !res.error && px[second[1] * w + second[0]] === gPixels[1],
         res.error || `got ${px[second[1] * w + second[0]]}, want ${gPixels[1]}`);
    }

    // ---- four quarter turns are the identity --------------------------------
    // Nothing is resampled, so this is not "close enough": the bytes have to be
    // the bytes, and the geometry has to be the geometry.
    {
      const entry = await install(geoBytes(), 'fourturns.dcm');
      const before = Array.from(storedOf(entry));
      for (let i = 0; i < 4; i++) await applyPixelTransform(entry, 'rot90');
      const after = Array.from(storedOf(entry));
      ok('four turns of 90° restore every stored byte',
         after.length === before.length && after.every((v, i) => v === before[i]));
      ok('four turns restore Rows and Columns',
         tagOf(entry.dict, '00280010') === GH && tagOf(entry.dict, '00280011') === GW,
         `${tagOf(entry.dict, '00280010')}x${tagOf(entry.dict, '00280011')}`);
      ok('four turns restore Image Position (Patient)',
         sameNums(listOf(entry.dict, '00200032'), [-10, -20, 5]), listOf(entry.dict, '00200032').join('\\'));
      ok('four turns restore Image Orientation (Patient)',
         sameNums(listOf(entry.dict, '00200037'), [1, 0, 0, 0, 1, 0]), listOf(entry.dict, '00200037').join('\\'));
      ok('four turns restore Patient Orientation',
         strsOf(entry.dict, '00200020').join('\\') === 'L\\F', strsOf(entry.dict, '00200020').join('\\'));
    }
    {
      // A flip is its own inverse, and rot90 undoes rot270.
      const entry = await install(geoBytes(), 'inverses.dcm');
      const before = Array.from(storedOf(entry));
      await applyPixelTransform(entry, 'flipH');
      await applyPixelTransform(entry, 'flipH');
      ok('flipping twice is the identity',
         Array.from(storedOf(entry)).every((v, i) => v === before[i]));
      await applyPixelTransform(entry, 'rot90');
      await applyPixelTransform(entry, 'rot270');
      ok('a turn and its opposite are the identity',
         Array.from(storedOf(entry)).every((v, i) => v === before[i]));
      ok('and the geometry comes back with them',
         sameNums(listOf(entry.dict, '00200032'), [-10, -20, 5]) &&
         sameNums(listOf(entry.dict, '00200037'), [1, 0, 0, 0, 1, 0]),
         listOf(entry.dict, '00200032').join('\\') + ' / ' + listOf(entry.dict, '00200037').join('\\'));
    }

    // ---- enhanced multi-frame: the geometry lives in functional groups ------
    // Plane Orientation is shared, Plane Position is per-frame, and the two sit
    // in sibling sequences — so the orientation has to be read before the
    // position that needs it is turned.
    {
      const two = new Uint8Array(GW * GH * 2);
      for (let i = 0; i < two.length; i++) two[i] = (i % (GW * GH)) + 1;
      const bytes = Forge.build({
        rows: GH, cols: GW, pi: 'MONOCHROME2', ba: 8, bs: 8, hb: 7, pr: 0,
        wc: 128, ww: 256, frames: 2, pixels: two,
        extra: {
          '52009229': { vr: 'SQ', items: [{
            '00209116': { vr: 'SQ', items: [{ '00200037': { vr: 'DS', v: ['1', '0', '0', '0', '1', '0'] } }] },
            '00289110': { vr: 'SQ', items: [{ '00280030': { vr: 'DS', v: ['0.5', '0.25'] } }] },
          }] },
          '52009230': { vr: 'SQ', items: [
            { '00209113': { vr: 'SQ', items: [{ '00200032': { vr: 'DS', v: ['-10', '-20', '5'] } }] } },
            { '00209113': { vr: 'SQ', items: [{ '00200032': { vr: 'DS', v: ['-10', '-20', '7'] } }] } },
          ] },
        },
      });
      const entry = await install(bytes, 'enhanced.dcm');
      const res = await applyPixelTransform(entry, 'rot90');
      ok('enhanced: rot90 applies', !res.error, res.error || '');
      const shared = lookupTag(entry.dict, '52009229')?.Value?.[0];
      const perFrame = lookupTag(entry.dict, '52009230')?.Value || [];
      const nums = (item, seq, tag) => (item?.[seq]?.Value?.[0]?.[tag]?.Value || []).map(Number);
      ok('enhanced: the shared Plane Orientation is turned',
         sameNums(nums(shared, '00209116', '00200037'), [0, -1, 0, 1, 0, 0]),
         nums(shared, '00209116', '00200037').join('\\'));
      ok('enhanced: the shared Pixel Measures follow the axes',
         sameNums(nums(shared, '00289110', '00280030'), [0.25, 0.5]),
         nums(shared, '00289110', '00280030').join('\\'));
      ok('enhanced: every per-frame Plane Position is moved with its own frame',
         perFrame.length === 2 &&
         sameNums(nums(perFrame[0], '00209113', '00200032'), [-10, -18.5, 5]) &&
         sameNums(nums(perFrame[1], '00209113', '00200032'), [-10, -18.5, 7]),
         perFrame.map(it => nums(it, '00209113', '00200032').join('\\')).join(' | '));
      ok('enhanced: Rows and Columns are exchanged at the top level',
         tagOf(entry.dict, '00280010') === GW && tagOf(entry.dict, '00280011') === GH,
         `${tagOf(entry.dict, '00280010')}x${tagOf(entry.dict, '00280011')}`);
    }

    // ---- geometry that belongs to another instance is left alone ------------
    // A Referenced Image Sequence carrying a position is describing some other
    // file. Rewriting it would be a lie about an image this tool never touched.
    {
      const bytes = Forge.build({
        rows: GH, cols: GW, pi: 'MONOCHROME2', ba: 8, bs: 8, hb: 7, pr: 0,
        wc: 128, ww: 256, pixels: gPixels,
        extra: Object.assign(geoExtra(), {
          '00081140': { vr: 'SQ', items: [{ '00200032': { vr: 'DS', v: ['1', '2', '3'] } }] },
        }),
      });
      const entry = await install(bytes, 'referenced.dcm');
      await applyPixelTransform(entry, 'rot90');
      const ref = lookupTag(entry.dict, '00081140')?.Value?.[0];
      const got = (ref?.['00200032']?.Value || []).map(Number);
      ok('a position inside Referenced Image Sequence is not rewritten',
         sameNums(got, [1, 2, 3]), got.join('\\'));
    }

    // ---- what the tool will not move, named rather than left silent ---------
    {
      const bytes = Forge.build({
        rows: GH, cols: GW, pi: 'MONOCHROME2', ba: 8, bs: 8, hb: 7, pr: 0,
        wc: 128, ww: 256, pixels: gPixels,
        extra: { '60003000': { vr: 'OW', v: new Uint8Array(4) } },
      });
      const entry = await install(bytes, 'overlay.dcm');
      const named = unmovedByTransform(entry.dict);
      ok('an overlay plane is named before the turn is applied',
         named.some(s => /Overlay/i.test(s)), named.join(', ') || 'nothing named');
      ok('and a file with none of that says so',
         unmovedByTransform((await install(geoBytes(), 'clean.dcm')).dict).length === 0);
    }

    // ---- what the instance says about itself afterwards ---------------------
    {
      const entry = await install(geoBytes(), 'derived.dcm');
      const sopBefore = tagOf(entry.dict, '00080018');
      await applyPixelTransform(entry, 'rot90');
      ok('Image Type value 1 becomes DERIVED',
         strsOf(entry.dict, '00080008')[0] === 'DERIVED', strsOf(entry.dict, '00080008').join('\\'));
      ok('Derivation Description says what was done',
         /rotat/i.test(String(tagOf(entry.dict, '00082111') || '')), String(tagOf(entry.dict, '00082111')));
      // Nothing writes (0008,0005), so the value is in the default repertoire.
      // The op's own label has a degree sign in it; the description must not.
      ok('Derivation Description stays inside the default character repertoire',
         !/[^\x20-\x7E]/.test(String(tagOf(entry.dict, '00082111') || '')),
         String(tagOf(entry.dict, '00082111')));
      ok('a fresh SOP Instance UID is assigned', tagOf(entry.dict, '00080018') !== sopBefore);
      const rt = await roundTrip(entry);
      ok('and the exported file carries all three',
         strsOf(rt.dict, '00080008')[0] === 'DERIVED' &&
         /rotat/i.test(String(tagOf(rt.dict, '00082111') || '')) &&
         tagOf(rt.dict, '00080018') === tagOf(entry.dict, '00080018'));
      ok('exporting does not re-tag the dataset a second time',
         String(tagOf(entry.dict, '00082111') || '').split('Carino DICOM-editor').length === 2,
         String(tagOf(entry.dict, '00082111')));
      // Two edits, two lines: the description is an audit trail, not a label.
      await applyPixelTransform(entry, 'flipV');
      ok('a second edit is appended rather than replacing the first',
         String(tagOf(entry.dict, '00082111') || '').split('Carino DICOM-editor').length === 3,
         String(tagOf(entry.dict, '00082111')));
    }

    // ---- undo -------------------------------------------------------------
    {
      const entry = await install(geoBytes(), 'undo.dcm');
      const before = Array.from(storedOf(entry));
      const sopBefore = tagOf(entry.dict, '00080018');
      await applyPixelTransform(entry, 'rot90');
      ok('undo: a backup is kept after an edit', !!entry.pixelBackup);
      // Exporting sits between editing and undoing in real use, and the writer
      // is handed the dataset itself rather than a deep copy of it.
      await buildEditedFile(entry);
      ok('undo: saving does not consume the backup', !!entry.pixelBackup);
      ok('undo: restores the file', undoPixelTransform(entry) === true);
      ok('undo: every stored byte comes back',
         Array.from(storedOf(entry)).every((v, i) => v === before[i]));
      ok('undo: Rows and Columns come back',
         tagOf(entry.dict, '00280010') === GH && tagOf(entry.dict, '00280011') === GW,
         `${tagOf(entry.dict, '00280010')}x${tagOf(entry.dict, '00280011')}`);
      ok('undo: the geometry comes back',
         sameNums(listOf(entry.dict, '00200032'), [-10, -20, 5]) &&
         sameNums(listOf(entry.dict, '00200037'), [1, 0, 0, 0, 1, 0]) &&
         sameNums(listOf(entry.dict, '00280030'), [0.5, 0.25]),
         listOf(entry.dict, '00200032').join('\\') + ' / ' + listOf(entry.dict, '00280030').join('\\'));
      ok('undo: the SOP Instance UID goes back', tagOf(entry.dict, '00080018') === sopBefore);
      ok('undo: it is one step deep and does not repeat', undoPixelTransform(entry) === false);
    }
    {
      // A compressed file that was decompressed to be turned goes back to the
      // codec it arrived in, not to a raw file that merely looks the same.
      const entry = await install(byId['rle-mono16'].bytes, 'undo-rle.dcm');
      await applyPixelTransform(entry, 'rot180');
      undoPixelTransform(entry);
      ok('undo: the transfer syntax goes back to RLE',
         tsOf(entry.meta) === '1.2.840.10008.1.2.5', tsOf(entry.meta));
      const live = await decode(entry);
      const c = byId['rle-mono16'];
      const want = Forge.expected(c.ref, c.w, c.h);
      let bad = 0;
      if (live && live.pixels) for (let i = 0; i < c.w * c.h * 4; i += 4)
        if (Math.abs(live.pixels[i] - want[i]) > (c.tol || 0)) bad++;
      ok('undo: and the original picture decodes again', bad === 0, `${bad} px differ`);
    }

    // ---- undo must never be a way back past a redaction ---------------------
    // Both directions, because both would leak: turning after a redaction must
    // not leave a button that restores the un-redacted pixels, and redacting
    // after a turn must not leave one either.
    {
      const entry = await install(byId['mono2-u8'].bytes, 'order1.dcm');
      await applyRedaction(entry, [{ x: 0, y: 0, w: 8, h: 4 }], { fill: 'black' });
      ok('order: a redaction leaves its own undo', !!entry.redactBackup);
      await applyPixelTransform(entry, 'rot90');
      ok('order: turning afterwards gives up the redaction undo', !entry.redactBackup);
      ok('order: and offers only its own', !!entry.pixelBackup);
      undoPixelTransform(entry);
      const live = await decode(entry);
      ok('order: undoing the turn leaves the redaction in place',
         !!live && live.pixels[0] === 0 && live.pixels[4] === 0,
         live ? `${live.pixels[0]},${live.pixels[4]}` : 'null');
    }
    {
      const entry = await install(byId['mono2-u8'].bytes, 'order2.dcm');
      await applyPixelTransform(entry, 'rot90');
      ok('order: a turn leaves its own undo', !!entry.pixelBackup);
      await applyRedaction(entry, [{ x: 0, y: 0, w: 8, h: 4 }], { fill: 'black' });
      ok('order: redacting afterwards gives up the turn undo', !entry.pixelBackup);
      ok('order: and offers only its own', !!entry.redactBackup);
    }

    // ---- invert, which is one CS value and no pixels at all -----------------
    {
      const entry = await install(byId['mono2-u8'].bytes, 'invert.dcm');
      const pxBefore = Array.from(storedOf(entry));
      const res = invertPhotometric(entry);
      ok('invert: MONOCHROME2 becomes MONOCHROME1', res.pi === 'MONOCHROME1', res.pi || res.error);
      ok('invert: not one sample is touched',
         Array.from(storedOf(entry)).every((v, i) => v === pxBefore[i]));
      ok('invert: the exported file carries it',
         tagOf((await roundTrip(entry)).dict, '00280004') === 'MONOCHROME1');
      ok('invert: and it is its own inverse', invertPhotometric(entry).pi === 'MONOCHROME2');
      const rgb = await install(byId['rgb-planar0'].bytes, 'invert-rgb.dcm');
      ok('invert: colour is refused rather than mangled', !!invertPhotometric(rgb).error);
    }

    // ---- the surface the buttons are wired to -------------------------------
    {
      ok('the Edit sidebar carries the image edit card', !!document.getElementById('imgEditCard'));
      for (const id of ['imgRotCW', 'imgRotCCW', 'imgRot180', 'imgFlipH', 'imgFlipV',
                        'imgInvert', 'imgRedact', 'imgRedactUndo', 'imgEditUndo',
                        'downloadOneBtn']) {
        ok(`the card carries #${id}`, !!document.getElementById(id));
      }
      ok('the card is inside the editor tab, not the overview',
         document.getElementById('editorTab')?.contains(document.getElementById('imgEditCard')) === true);

      // The card used to pass every assertion above while being invisible: it
      // was in the DOM, its own style.display was 'block', and a media query
      // three ancestors up set display:none on the whole sidebar below 1000px.
      // Nothing here can resize the window, so the rule itself is the subject —
      // a narrow layout may move a sidebar, stack it or scroll it, but it may
      // not delete it, on any of the three tabs that have one.
      {
        const HOMES = ['sidebar', 'create-sidebar', 'extractor-sidebar', 'val-sidebar'];
        const offenders = [];
        for (const sheet of Array.from(document.styleSheets)) {
          let rules;
          try { rules = Array.from(sheet.cssRules || []); } catch (_) { continue; }
          for (const rule of rules) {
            if (!(rule.media && rule.cssRules)) continue;
            if (!/max-width/.test(rule.conditionText || rule.media.mediaText || '')) continue;
            for (const inner of Array.from(rule.cssRules)) {
              if (!inner.selectorText || !inner.style) continue;
              const gone = inner.style.getPropertyValue('display').trim() === 'none';
              if (!gone) continue;
              for (const home of HOMES)
                if (new RegExp(`\\.${home}(\\s|,|$)`).test(inner.selectorText + ' '))
                  offenders.push(`${rule.conditionText || rule.media.mediaText} { ${inner.selectorText} }`);
            }
          }
        }
        ok('no media query hides a sidebar outright', offenders.length === 0,
           offenders.join(' | ').slice(0, 200));
      }

      // Existing is not the same as winning. A media query adds nothing to
      // specificity, so `@media { .left-panel { overflow: visible } }` written
      // above `.left-panel { overflow: hidden }` is a tie that the later base
      // rule takes — the narrow layout then goes to one column while keeping the
      // two-column height constraints, which collapsed the tag table to 78px and
      // painted the panel over the sidebar. The rule that undoes a property must
      // come after every rule that sets it for the same selector.
      {
        const WATCH = {
          '.left-panel': ['overflow', 'min-height'],
          '.sidebar': ['overflow', 'min-height'],
          '.create-left': ['overflow', 'min-height'],
          '.extractor-left': ['overflow', 'min-height'],
          '.table-wrap': ['flex', 'max-height'],
          '.img-grid-wrap': ['flex', 'max-height'],
          '.extractor-grid-wrap': ['flex', 'max-height'],
          '.preview-box': ['max-width'],
        };
        // Flatten the sheet to (index, selector, style), descending into media
        // rules so a nested rule keeps the position of its parent block.
        const flat = [];
        for (const sheet of Array.from(document.styleSheets)) {
          let rules;
          try { rules = Array.from(sheet.cssRules || []); } catch (_) { continue; }
          rules.forEach((rule, i) => {
            if (rule.selectorText && rule.style) flat.push({ i, sel: rule.selectorText, style: rule.style, media: false });
            else if (rule.cssRules)
              for (const inner of Array.from(rule.cssRules))
                if (inner.selectorText && inner.style) flat.push({ i, sel: inner.selectorText, style: inner.style, media: true });
          });
        }
        const hits = (sel, prop) => flat.filter(r =>
          r.sel.split(',').some(s => s.trim() === sel) && r.style.getPropertyValue(prop) !== '');

        const losers = [];
        for (const [sel, props] of Object.entries(WATCH)) {
          for (const prop of props) {
            const all = hits(sel, prop);
            const inMedia = all.filter(r => r.media);
            if (!inMedia.length) continue;                 // not overridden here at all
            const lastBase = Math.max(-1, ...all.filter(r => !r.media).map(r => r.i));
            const lastMedia = Math.max(...inMedia.map(r => r.i));
            if (lastMedia < lastBase) losers.push(`${sel} { ${prop} } @${lastMedia} < base @${lastBase}`);
          }
        }
        ok('every narrow-layout override comes after the rule it undoes',
           losers.length === 0, losers.join(' | ').slice(0, 240));
      }

      // And at whatever width the runner happens to use, the card is really on
      // screen rather than merely present: offsetParent is null for an element
      // inside a display:none ancestor, which style.display cannot see.
      switchTab('editor');
      ok('the card is laid out, not just present',
         document.getElementById('imgEditCard').offsetParent !== null ||
         document.getElementById('imgEditCard').style.display === 'none');

      // ---- what the download buttons offer, and when ----------------------
      // "Download All" is named for a batch, so it only belongs on screen when
      // there is more than one file for "all" to mean. It used to be the button
      // shown for a single file — while the per-file button, which described
      // what would actually happen, was the one hidden.
      {
        const all = () => document.getElementById('downloadAllBtn');
        const one = () => document.getElementById('downloadOneBtn');
        const shown = (el) => !el.classList.contains('hidden');

        await handleFiles([]);          // nothing loaded
        files.length = 0; showDownload();
        ok('no files: neither download button is offered', !shown(all()) && !shown(one()));

        await install(geoBytes(), 'dl-one.dcm');
        ok('one file: Download All is not offered', !shown(all()));
        ok('one file: the per-file download is', shown(one()));
        ok('and it carries the primary styling while it is the only one',
           one().classList.contains('primary'));

        // The Image edits card used to carry a second "Download this file"
        // wired to the same downloadOne() call. Two buttons running one line
        // read as a choice between them, and there was none to make.
        ok('and it is the only download control on screen',
           [...document.querySelectorAll('button')]
             .filter(b => b.offsetParent && /download|this file/i.test(b.textContent))
             .map(b => b.id).join(',') === 'downloadOneBtn',
           [...document.querySelectorAll('button')]
             .filter(b => b.offsetParent && /download|this file/i.test(b.textContent))
             .map(b => b.id).join(','));
        ok('the image tools no longer carry one of their own',
           document.getElementById('imgEditDownload') === null);

        // A drop target squeezed to nothing cannot be aimed at, and nothing on
        // screen then says files may be dropped at all. It keeps its height
        // while the picture and the Log give theirs up.
        {
          const dz = document.getElementById('dropZone');
          const sb = document.querySelector('.sidebar');
          ok('the drop zone is in the sidebar proper, not the shrinking tail',
             !document.querySelector('.sidebar-rest')?.contains(dz) && sb.contains(dz));
          ok('and it has a real height with a file loaded',
             dz.getBoundingClientRect().height > 20,
             `${dz.getBoundingClientRect().height.toFixed(0)}px`);
        }

        await handleFiles(['a', 'b', 'c'].map((n, i) =>
          new File([bytesOf(geoBytes())], `dl-${n}.dcm`, { type: 'application/dicom' })));
        ok('several files: Download All is offered', shown(all()) && files.length > 1,
           `${files.length} file(s)`);
        ok('several files: the per-file download still is', shown(one()));
        ok('and it gives the primary styling back to Download All',
           !one().classList.contains('primary'));
        // Not a behaviour change, just the reason the swap costs nothing:
        // a range of one never builds an archive.
        ok('a one-file range downloads the file rather than an archive of one',
           /downloadOne\(/.test(String(downloadRange)));
      }

      // The controls sit above the picture they act on, and both sit above
      // everything else in the column — they are the two things you had to
      // scroll for. Order in the DOM, so it holds before anything is laid out.
      {
        const sb = document.querySelector('.sidebar');
        const kids = [...sb.children];
        const at = (sel) => kids.findIndex(e => e.matches(sel));
        ok('the image tools come before the preview in the sidebar',
           at('#imgEditCard') >= 0 && at('#imgEditCard') < at('#previewCard'),
           `tools@${at('#imgEditCard')} preview@${at('#previewCard')}`);
        ok('and both come before Load Files and the Log',
           at('#previewCard') < at('#loadFilesCard') &&
           at('#loadFilesCard') < at('.sidebar-rest'),
           `preview@${at('#previewCard')} load@${at('#loadFilesCard')} rest@${at('.sidebar-rest')}`);
        // Only the Log may be squeezed away — it is a transcript of what already
        // happened. The drop zone is a target and has to stay aimable.
        ok('the Log is the only thing in the scrolling tail',
           !!document.querySelector('.sidebar-rest #logCard') &&
           !document.querySelector('.sidebar-rest #loadFilesCard'));
        // The card is a flex column at runtime, not the display:block the JS
        // used to set — the picture cannot give up height inside a block.
        const entry = files[currentFileIdx];
        if (entry) {
          ok('the preview card is a flex column when shown',
             getComputedStyle(document.getElementById('previewCard')).flexDirection === 'column' &&
             document.getElementById('previewCard').style.display !== 'block',
             document.getElementById('previewCard').style.display);
        }
      }
      ok('every op the buttons name is an op the code has',
         ['rot90', 'rot270', 'rot180', 'flipH', 'flipV'].every(k => !!PIXEL_OPS[k] && !!PIXEL_OPS[k].inverse));
      ok('and every op names its own inverse correctly',
         Object.entries(PIXEL_OPS).every(([k, op]) => PIXEL_OPS[op.inverse].inverse === k));

      const entry = await install(geoBytes(), 'card.dcm');
      syncImgEditCard();
      ok('the card shows for a file with pixels', document.getElementById('imgEditCard').style.display === 'block');
      ok('the undo button hides until there is something to undo',
         document.getElementById('imgEditUndo').classList.contains('hidden'));
      await applyPixelTransform(entry, 'rot90');
      syncImgEditCard();
      ok('and appears afterwards', !document.getElementById('imgEditUndo').classList.contains('hidden'));
      ok('naming what it would undo',
         /90/.test(document.getElementById('imgEditUndo').title || ''),
         document.getElementById('imgEditUndo').title);

      // The click, not the function behind it: a handler wired to the wrong id
      // or an op key that does not exist is invisible to every assertion above.
      // Raw pixels and nothing that needs a dialog, so this path runs straight
      // through.
      const clicked = await install(geoBytes(), 'clicked.dcm');
      document.getElementById('imgRotCW').click();
      for (let i = 0; i < 60 && tagOf(clicked.dict, '00280010') !== GW; i++)
        await new Promise(r => setTimeout(r, 25));
      ok('clicking ⟳ 90° turns the file',
         tagOf(clicked.dict, '00280010') === GW && tagOf(clicked.dict, '00280011') === GH,
         `${tagOf(clicked.dict, '00280010')}x${tagOf(clicked.dict, '00280011')}`);
      ok('and the preview beside the buttons is redrawn at the new shape',
         previewCanvas.width === GH && previewCanvas.height === GW,
         `${previewCanvas.width}x${previewCanvas.height}`);
      document.getElementById('imgEditUndo').click();
      for (let i = 0; i < 60 && tagOf(clicked.dict, '00280010') !== GH; i++)
        await new Promise(r => setTimeout(r, 25));
      ok('and the undo button turns it back',
         tagOf(clicked.dict, '00280010') === GH && tagOf(clicked.dict, '00280011') === GW,
         `${tagOf(clicked.dict, '00280010')}x${tagOf(clicked.dict, '00280011')}`);

      const mpeg = await install(byId['mpeg2-unsupported'].bytes, 'card-mpeg.dcm');
      syncImgEditCard();
      ok('a file no codec here can read disables the buttons with the reason on them',
         document.getElementById('imgRotCW').disabled === true &&
         /MPEG/i.test(document.getElementById('imgRotCW').title || ''),
         document.getElementById('imgRotCW').title);
      void mpeg;
    }

    // ---- i18n ---------------------------------------------------------------
    {
      const NEW_STRINGS = [
        'Image edits',
        'Applied to the stored pixels of this file, every frame. Rows, Columns, Pixel Spacing and the patient geometry follow.',
        '↺ Undo last image edit',
        '⬇ Download this file',
        '⬇ This file',
        'Rotate 90° clockwise',
        'Rotate 90° counter-clockwise',
        'Rotate 180°',
        'Invert (MONOCHROME1 ⇄ MONOCHROME2)',
        "Download the file on screen, with this session's edits",
        'Only MONOCHROME1 and MONOCHROME2 images can be inverted this way.',
        'Not moved with the pixels:',
        'These are not moved with the pixels and will no longer line up:',
        'This image will be decompressed to uncompressed Explicit VR Little Endian: the file will be larger and its Transfer Syntax will change.',
        'This image was compressed with lossy JPEG; rewriting it will store 8 bits per sample.',
        'image edit undone (this session only).',
      ];
      for (const loc of ['es', 'pt-BR', 'ja', 'ru']) {
        const missing = NEW_STRINGS.filter(s => !I18N[loc] || !I18N[loc][s]);
        ok(`i18n: every new string is translated into ${loc}`, missing.length === 0,
           missing.join(' | ').slice(0, 160));
      }
      // Every op's label is a key, because syncImgEditCard writes it onto a title.
      for (const loc of ['es', 'pt-BR', 'ja', 'ru']) {
        const missing = Object.values(PIXEL_OPS).map(o => o.label).filter(s => !I18N[loc][s]);
        ok(`i18n: every op label is translated into ${loc}`, missing.length === 0, missing.join(' | '));
      }
      for (const id of ['imgRotCW', 'imgRotCCW', 'imgRot180', 'imgFlipH', 'imgFlipV', 'imgInvert'])
        ok(`i18n: #${id}'s title is in ATTR_I18N`,
           ATTR_I18N.some(([i, attr]) => i === id && attr === 'title'));
    }
  } catch (e) {
    ok('suite ran to completion', false, (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  }

  return out;
};

// Two callers: tests/run.sh injects this file alone and scrapes the <pre> below;
// index.html#selftest sets window.SELFTEST and awaits the returned lines instead.
if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.imgedit()).join('\n');
  document.body.appendChild(pre);
});
