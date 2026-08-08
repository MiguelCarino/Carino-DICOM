// Burned-in pixel redaction: does the box actually cover the name, in every
// frame, in the file's own numbers?
//
// The oracle is tests/dicom-forge.js throughout. Two questions are asked of
// every case, and they are different questions: INSIDE the box the decoded
// image must be the darkest thing that photometric interpretation can express
// — which is 0 for MONOCHROME2, the MAXIMUM stored value for MONOCHROME1,
// -(1<<(bs-1)) for signed data, (0,128,128) for YBR_FULL and a searched index
// for PALETTE COLOR — and OUTSIDE it the picture must still be the picture, byte
// for byte wherever the codec was lossless. Both are then asked again of the
// file that comes back out of buildEditedFile, because a redaction that only
// exists in memory is not a redaction.
(window.SUITES || (window.SUITES = {})).redact = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  try {
    const cases = await Forge.corpus();
    const byId = Object.fromEntries(cases.map(c => [c.id, c]));
    const BOX = { x: 3, y: 0, w: 20, h: 5 };

    const bytesOf = (b) => b.buffer ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b;

    // Through the real loader, so the entry carries the working copy the
    // pendingEdits trap depends on.
    async function install(bytes, name) {
      await handleFiles([new File([bytesOf(bytes)], name || 'redact.dcm', { type: 'application/dicom' })]);
      return files[0];
    }

    const decode = (entry, frame = 0) => decodeDicomPixels(entry.dict, frame, { meta: entry.meta });

    async function roundTrip(entry) {
      const msg = DicomMessage.readFile(await buildEditedFile(entry).arrayBuffer());
      normBin(msg.dict);
      return { dict: msg.dict, meta: msg.meta || {}, name: entry.name };
    }

    const tagOf = (d, t) => lookupTag(d, t)?.Value?.[0];
    const tsOf  = (m) => String(m?.['00020010']?.Value?.[0] ?? m?.TransferSyntaxUID?.Value?.[0] ?? '');
    const inBox = (x, y, b) => x >= Math.floor(b.x) && x < Math.ceil(b.x + b.w)
                            && y >= Math.floor(b.y) && y < Math.ceil(b.y + b.h);

    // Every pixel under a box must be exactly `want`. Reported as a count, not a
    // boolean, so a one-row or one-column slip reads as "20 px" rather than "no".
    function boxIs(pixels, w, h, boxes, want) {
      if (!pixels) return 'nothing decoded';
      let bad = 0, firstAt = -1, sample = '';
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!boxes.some(b => inBox(x, y, b))) continue;
        const p = (y * w + x) * 4;
        if (pixels[p] !== want[0] || pixels[p+1] !== want[1] || pixels[p+2] !== want[2]) {
          bad++;
          if (firstAt < 0) { firstAt = y * w + x; sample = `${pixels[p]},${pixels[p+1]},${pixels[p+2]}`; }
        }
      }
      return bad ? `${bad} px inside the box are not ${want.join(',')} (first at ${firstAt}, got ${sample})` : null;
    }

    // Same comparison Forge.compare makes, with the redacted region skipped.
    function outsideMatches(pixels, want, w, h, boxes, tol) {
      if (!pixels) return 'nothing decoded';
      tol = tol || 0;
      let bad = 0, worst = 0, firstAt = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (boxes.some(b => inBox(x, y, b))) continue;
        const p = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const dv = Math.abs(pixels[p + c] - want[p + c]);
          if (dv > tol) { bad++; if (dv > worst) worst = dv; if (firstAt < 0) firstAt = y * w + x; break; }
        }
      }
      return bad ? `${bad} px outside the box changed, worst ${worst}, first at ${firstAt}` : null;
    }

    // ---- what the transfer syntax alone decides -----------------------------
    const mkMeta = (ts) => ({ '00020010': { vr: 'UI', Value: [ts] } });
    for (const [ts, label, wantOk, wantConv] of [
      ['1.2.840.10008.1.2.1', 'Explicit VR LE', true, false],
      ['1.2.840.10008.1.2', 'Implicit VR LE', true, false],
      ['1.2.840.10008.1.2.2', 'Explicit VR BE', true, false],
      ['1.2.840.10008.1.2.5', 'RLE Lossless', true, true],
      ['1.2.840.10008.1.2.4.70', 'JPEG Lossless', true, true],
      ['1.2.840.10008.1.2.4.50', 'JPEG Baseline', true, true],
      ['1.2.840.10008.1.2.4.90', 'JPEG 2000 Lossless', true, true],
      ['1.2.840.10008.1.2.4.91', 'JPEG 2000', true, true],
      ['1.2.840.10008.1.2.4.80', 'JPEG-LS Lossless', true, true],
      ['1.2.840.10008.1.2.4.81', 'JPEG-LS Near-Lossless', true, true],
    ]) {
      const s = redactionSupport(mkMeta(ts));
      ok(`support: ${label} can be redacted`, s.ok === wantOk && s.converts === wantConv,
         `ok=${s.ok} converts=${s.converts}`);
    }
    for (const [ts, label, namePat] of [
      ['1.2.840.10008.1.2.4.201', 'High-Throughput JPEG 2000', /High-Throughput/],
      ['1.2.840.10008.1.2.4.202', 'High-Throughput JPEG 2000 RPCL', /High-Throughput/],
      ['1.2.840.10008.1.2.4.100', 'MPEG-2', /MPEG-2/],
      ['1.2.840.10008.1.2.4.102', 'MPEG-4', /MPEG-4/],
    ]) {
      const s = redactionSupport(mkMeta(ts));
      ok(`support: ${label} is refused by name`, !s.ok && namePat.test(s.codec || ''), s.codec || 'no codec name');
    }
    ok('support: JPEG Baseline warns that depth drops to 8 bits',
       redactionSupport(mkMeta('1.2.840.10008.1.2.4.50')).depthLoss === true);
    ok('support: RLE does not claim to lose depth',
       redactionSupport(mkMeta('1.2.840.10008.1.2.5')).depthLoss === false);

    // ---- the black each photometric interpretation actually needs ------------
    // PALETTE COLOR's darkest colour is worked out here from the LUT the forge
    // built, not assumed to be index 0 — that palette puts (0,255,128) there.
    let paletteDark = [0, 0, 0], paletteIndexZero = [0, 255, 128];
    {
      let best = 0, bestScore = Infinity;
      for (let i = 0; i < 256; i++) {
        const r = i, g = 255 - i, b = 128;
        const s = r*r + g*g + b*b;
        if (s < bestScore) { bestScore = s; best = i; }
      }
      paletteDark = [best, 255 - best, 128];
    }

    const RAW_CASES = [
      ['mono2-u8', [0, 0, 0]],
      ['mono2-u16-b12', [0, 0, 0]],
      ['mono2-u16-b16', [0, 0, 0]],
      ['mono2-s16-b12', [0, 0, 0]],
      ['mono2-s16-b16', [0, 0, 0]],
      ['mono1-u16', [0, 0, 0]],
      ['rgb-planar0', [0, 0, 0]],
      ['rgb-planar1', [0, 0, 0]],
      ['ybr-full', [0, 0, 0]],
      ['palette-color', paletteDark],
      ['implicit-vr', [0, 0, 0]],
      ['big-endian', [0, 0, 0]],
    ];

    for (const [id, black] of RAW_CASES) {
      const c = byId[id];
      const entry = await install(c.bytes, id + '.dcm');
      const res = await applyRedaction(entry, [BOX], { fill: 'black' });
      if (res.error) {
        ok(`${id}: redaction applies`, false, res.error);
        continue;
      }
      ok(`${id}: redaction applies without converting the syntax`, !res.converts, `converts=${res.converts}`);

      const want = Forge.expected(c.ref, c.w, c.h);
      const live = await decode(entry);
      if (!live || live.error) { ok(`${id}: still decodes after redaction`, false, live ? live.error : 'null'); continue; }
      ok(`${id}: the box is filled with this image's black`,
         !boxIs(live.pixels, c.w, c.h, [BOX], black), boxIs(live.pixels, c.w, c.h, [BOX], black) || '');
      ok(`${id}: the rest of the image is untouched`,
         !outsideMatches(live.pixels, want, c.w, c.h, [BOX], c.tol),
         outsideMatches(live.pixels, want, c.w, c.h, [BOX], c.tol) || '');

      const rt = await roundTrip(entry);
      const back = await decode(rt);
      if (!back || back.error) { ok(`${id}: the written file decodes`, false, back ? back.error : 'null'); continue; }
      ok(`${id}: the box survives buildEditedFile`,
         !boxIs(back.pixels, c.w, c.h, [BOX], black), boxIs(back.pixels, c.w, c.h, [BOX], black) || '');
      ok(`${id}: and so does everything around it`,
         !outsideMatches(back.pixels, want, c.w, c.h, [BOX], c.tol),
         outsideMatches(back.pixels, want, c.w, c.h, [BOX], c.tol) || '');
    }

    // PALETTE COLOR again, stated the other way round: the fill must not be the
    // colour index 0 happens to hold, which in this palette is bright cyan.
    {
      const c = byId['palette-color'];
      const entry = await install(c.bytes, 'palette2.dcm');
      await applyRedaction(entry, [BOX], { fill: 'black' });
      const live = await decode(entry);
      const p = (2 * c.w + 5) * 4;   // inside the box
      ok('palette-color: the fill is the darkest LUT entry, not index 0',
         !!live && live.pixels[p] === paletteDark[0] && live.pixels[p+1] === paletteDark[1],
         live ? `${live.pixels[p]},${live.pixels[p+1]},${live.pixels[p+2]} (index 0 would be ${paletteIndexZero.join(',')})` : 'null');
    }

    // ---- the stored numbers, not the painted ones ---------------------------
    // MONOCHROME1 is the one that goes wrong silently: filling 0 there paints a
    // white rectangle over the mammogram it was meant to hide.
    {
      const c = byId['mono1-u16'];
      const entry = await install(c.bytes, 'mono1.dcm');
      await applyRedaction(entry, [BOX], { fill: 'black' });
      const px = new Uint16Array(lookupTag(entry.dict, '7fe00010').Value[0]);
      ok('mono1-u16: black is stored as the MAXIMUM value, not zero',
         px[0 * c.w + 4] === 4095, String(px[0 * c.w + 4]));
      const white = await install(byId['mono1-u16'].bytes, 'mono1w.dcm');
      await applyRedaction(white, [BOX], { fill: 'white' });
      const wpx = new Uint16Array(lookupTag(white.dict, '7fe00010').Value[0]);
      ok('mono1-u16: white is stored as zero', wpx[0 * c.w + 4] === 0, String(wpx[0 * c.w + 4]));
      const wres = await decode(white);
      ok('mono1-u16: and a white fill paints white',
         !!wres && !boxIs(wres.pixels, c.w, c.h, [BOX], [255, 255, 255]),
         wres ? (boxIs(wres.pixels, c.w, c.h, [BOX], [255, 255, 255]) || '') : 'null');
    }
    {
      const c = byId['mono2-s16-b12'];
      const entry = await install(c.bytes, 'signed.dcm');
      await applyRedaction(entry, [BOX], { fill: 'black' });
      const res = await decode(entry);
      ok('mono2-s16-b12: the fill decodes back as -2048, the bottom of the range',
         !!res && res.rawFloats && res.rawFloats[0 * c.w + 4] === -2048,
         res && res.rawFloats ? String(res.rawFloats[0 * c.w + 4]) : 'no rawFloats');
    }
    {
      const c = byId['ybr-full'];
      const entry = await install(c.bytes, 'ybr.dcm');
      await applyRedaction(entry, [BOX], { fill: 'black' });
      const px = new Uint8Array(lookupTag(entry.dict, '7fe00010').Value[0]);
      const at = (0 * c.w + 4) * 3;
      ok('ybr-full: black is stored as Y=0, Cb=128, Cr=128',
         px[at] === 0 && px[at+1] === 128 && px[at+2] === 128,
         `${px[at]},${px[at+1]},${px[at+2]}`);
    }
    {
      // Planar Configuration 1 keeps each channel as a whole plane; three
      // consecutive bytes written into it land on three different pixels.
      const c = byId['rgb-planar1'];
      const entry = await install(c.bytes, 'planar1.dcm');
      await applyRedaction(entry, [BOX], { fill: 'black' });
      const px = new Uint8Array(lookupTag(entry.dict, '7fe00010').Value[0]);
      const n = c.w * c.h, i = 0 * c.w + 4;
      ok('rgb-planar1: the fill goes into all three planes',
         px[i] === 0 && px[n + i] === 0 && px[2 * n + i] === 0,
         `${px[i]},${px[n+i]},${px[2*n+i]}`);
      ok('rgb-planar1: Planar Configuration is left as it was',
         tagOf(entry.dict, '00280006') === 1, String(tagOf(entry.dict, '00280006')));
    }
    {
      // High Bit is not always Bits Stored - 1. A file that top-aligns its
      // 12 bits inside 16 needs the fill shifted up to where the decoder looks.
      const n = Forge.W * Forge.H;
      const s = new Uint16Array(n);
      const p = Forge.pattern(Forge.W, Forge.H);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 4095) << 4;
      const bytes = Forge.build({ rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16,
                                  bs: 12, hb: 15, pr: 0, wc: 2048, ww: 4096, pixels: s });
      const entry = await install(bytes, 'topaligned.dcm');
      await applyRedaction(entry, [BOX], { fill: 'white' });
      const px = new Uint16Array(lookupTag(entry.dict, '7fe00010').Value[0]);
      ok('high bit 15: a white fill is shifted into the top 12 bits',
         px[0 * Forge.W + 4] === 4095 << 4, String(px[0 * Forge.W + 4]));
      const res = await decode(entry);
      ok('high bit 15: and decodes back as 4095',
         !!res && res.rawFloats && res.rawFloats[0 * Forge.W + 4] === 4095,
         res && res.rawFloats ? String(res.rawFloats[0 * Forge.W + 4]) : 'no rawFloats');
    }

    // ---- the box covers exactly the box -------------------------------------
    {
      const c = byId['mono2-u16-b12'];
      const entry = await install(c.bytes, 'exact.dcm');
      const full = { x: 0, y: 0, w: c.w, h: 5 };
      // The pattern has zeros of its own (column 0, and the dark bottom-right
      // block), so count them first rather than guess at the total.
      const before = await decode(entry);
      let ownZeros = 0;
      for (let y = 5; y < c.h; y++) for (let x = 0; x < c.w; x++)
        if (before.rawFloats[y * c.w + x] === 0) ownZeros++;
      await applyRedaction(entry, [full], { fill: 'black' });
      const res = await decode(entry);
      let zeros = 0;
      for (let i = 0; i < res.rawFloats.length; i++) if (res.rawFloats[i] === 0) zeros++;
      ok('a five-row box blanks exactly five rows',
         zeros === c.w * 5 + ownZeros, `${zeros} zero samples, expected ${c.w * 5 + ownZeros}`);
      ok('the row under the box is untouched', res.rawFloats[5 * c.w + 10] !== 0,
         String(res.rawFloats[5 * c.w + 10]));
    }

    // ---- every frame, always ------------------------------------------------
    {
      const c = byId['multiframe-mono'];
      const entry = await install(c.bytes, 'mf-mono.dcm');
      const res = await applyRedaction(entry, [BOX], { fill: 'black' });
      ok('multiframe-mono: redaction reports all four frames', res.frames === 4, String(res.frames));
      const rt = await roundTrip(entry);
      for (let f = 0; f < c.frames; f++) {
        const live = await decode(rt, f);
        const want = Forge.expected(c.frameRef(f), c.w, c.h);
        ok(`multiframe-mono: frame ${f} is blanked under the box`,
           !!live && !boxIs(live.pixels, c.w, c.h, [BOX], [0, 0, 0]),
           live ? (boxIs(live.pixels, c.w, c.h, [BOX], [0, 0, 0]) || '') : 'null');
        ok(`multiframe-mono: frame ${f} is otherwise itself`,
           !!live && !outsideMatches(live.pixels, want, c.w, c.h, [BOX], c.tol),
           live ? (outsideMatches(live.pixels, want, c.w, c.h, [BOX], c.tol) || '') : 'null');
      }
    }
    {
      const c = byId['multiframe-rgb'];
      const entry = await install(c.bytes, 'mf-rgb.dcm');
      await applyRedaction(entry, [BOX], { fill: 'black' });
      const rt = await roundTrip(entry);
      for (let f = 0; f < c.frames; f++) {
        const live = await decode(rt, f);
        ok(`multiframe-rgb: frame ${f} is blanked under the box`,
           !!live && !boxIs(live.pixels, c.w, c.h, [BOX], [0, 0, 0]),
           live ? (boxIs(live.pixels, c.w, c.h, [BOX], [0, 0, 0]) || '') : 'null');
      }
    }

    // ---- big endian ---------------------------------------------------------
    // The untouched half of this assertion fails on an unmodified round trip
    // today: ensureMeta relabels the file Explicit VR LE and nothing swaps the
    // sample bytes, so 4095 comes back as 3855. Redaction has to swap anyway.
    {
      const c = byId['big-endian'];
      const entry = await install(c.bytes, 'be.dcm');
      await applyRedaction(entry, [BOX], { fill: 'black' });
      ok('big-endian: the file is relabelled little endian once its bytes are',
         tsOf(entry.meta) === '1.2.840.10008.1.2.1', tsOf(entry.meta));
      const rt = await roundTrip(entry);
      const back = await decode(rt);
      const want = Forge.expected(c.ref, c.w, c.h);
      ok('big-endian: the written file still holds the original picture',
         !!back && !outsideMatches(back.pixels, want, c.w, c.h, [BOX], c.tol),
         back ? (outsideMatches(back.pixels, want, c.w, c.h, [BOX], c.tol) || '') : 'null');
      ok('big-endian: and the box is black in it',
         !!back && !boxIs(back.pixels, c.w, c.h, [BOX], [0, 0, 0]),
         back ? (boxIs(back.pixels, c.w, c.h, [BOX], [0, 0, 0]) || '') : 'null');
    }

    // ---- encapsulated: decompress, redact, rewrite as Explicit VR LE ---------
    // RLE and JPEG Lossless are lossless both ways, so tolerance zero: anything
    // that moves outside the box is a bug in the rewrite, not in a codec.
    // JPEG 2000 and JPEG-LS join them for the same reason: both decode to the
    // stored samples at their own precision, so a redacted mammogram keeps
    // every bit it had outside the boxes.
    for (const [id, tol] of [['rle-mono16', 0], ['rle-rgb', 0], ['jpeg-lossless-rgb', 0],
                             ['jpeg-lossless-mono16', 0], ['j2k-mono16-b12', 0],
                             ['j2k-rgb-rct', 0], ['jls-mono16-b12', 0], ['jls-rgb', 0],
                             ['jls-rgb-planar', 0], ['jpeg-baseline', null],
                             ['mono1-jpeg', null]]) {
      const c = byId[id];
      const entry = await install(c.bytes, id + '.dcm');
      const res = await applyRedaction(entry, [BOX], { fill: 'black' });
      if (res.error) { ok(`${id}: redaction applies`, false, res.error); continue; }
      ok(`${id}: reports that it converted the transfer syntax`, res.converts === true);
      ok(`${id}: the file is now Explicit VR Little Endian`,
         tsOf(entry.meta) === '1.2.840.10008.1.2.1', tsOf(entry.meta));
      const px = lookupTag(entry.dict, '7fe00010');
      ok(`${id}: Pixel Data is one native buffer, not fragments`,
         px.Value.length === 1 && px.Value[0] instanceof ArrayBuffer,
         `${px.Value.length} value(s)`);
      const spp = tagOf(entry.dict, '00280002') || 1;
      ok(`${id}: Planar Configuration matches the new layout`,
         spp === 3 ? tagOf(entry.dict, '00280006') === 0 : tagOf(entry.dict, '00280006') === undefined,
         String(tagOf(entry.dict, '00280006')));

      const rt = await roundTrip(entry);
      const back = await decode(rt);
      const want = Forge.expected(c.ref, c.w, c.h);
      const useTol = tol === null ? c.tol : tol;
      if (!back || back.error) { ok(`${id}: the written file decodes`, false, back ? back.error : 'null'); continue; }
      ok(`${id}: the box is black in the written file`,
         !boxIs(back.pixels, c.w, c.h, [BOX], [0, 0, 0]), boxIs(back.pixels, c.w, c.h, [BOX], [0, 0, 0]) || '');
      ok(`${id}: the rest survives the round trip`,
         !outsideMatches(back.pixels, want, c.w, c.h, [BOX], useTol),
         outsideMatches(back.pixels, want, c.w, c.h, [BOX], useTol) || '');
    }

    // OpenJPEG inverts the multi-component transform on the way out, so what we
    // write back is RGB — and the file has to say RGB, or the next reader
    // converts colour that was already converted.
    {
      const entry = await install(byId['j2k-rgb-rct'].bytes, 'j2krct2.dcm');
      const res = await applyRedaction(entry, [BOX], { fill: 'black' });
      ok('j2k-rgb-rct: redaction applies', !res.error, res.error || '');
      ok('j2k-rgb-rct: YBR_RCT becomes RGB in the written file',
         String(tagOf(entry.dict, '00280004')).trim() === 'RGB', String(tagOf(entry.dict, '00280004')));
    }
    // The planar JPEG-LS stream is the one that would be written back as three
    // vertical bands: decodeStoredFrames promises interleaved samples and
    // applyRedaction writes (0028,0006) = 0 on the strength of that promise.
    {
      const c = byId['jls-rgb-planar'];
      const entry = await install(c.bytes, 'jlsplanar2.dcm');
      await applyRedaction(entry, [BOX], { fill: 'black' });
      ok('jls-rgb-planar: the written file claims interleaved samples',
         tagOf(entry.dict, '00280006') === 0, String(tagOf(entry.dict, '00280006')));
      const back = await decode(await roundTrip(entry));
      ok('jls-rgb-planar: and the samples really are interleaved',
         !!back && !outsideMatches(back.pixels, Forge.expected(c.ref, c.w, c.h), c.w, c.h, [BOX], 0),
         back ? (outsideMatches(back.pixels, Forge.expected(c.ref, c.w, c.h), c.w, c.h, [BOX], 0) || back.error || '') : 'null');
    }
    // Bit depth is the whole point of decoding these rather than refusing them:
    // a 12-in-16 mammogram must not come back 8 bits shallower the way a
    // baseline JPEG does.
    {
      const entry = await install(byId['j2k-mono16-b12'].bytes, 'j2kdepth.dcm');
      const res = await applyRedaction(entry, [BOX], { fill: 'black' });
      ok('j2k-mono16-b12: no depth is lost', res.depthLoss === false, String(res.depthLoss));
      ok('j2k-mono16-b12: Bits Allocated/Stored are unchanged',
         tagOf(entry.dict, '00280100') === 16 && tagOf(entry.dict, '00280101') === 12,
         `${tagOf(entry.dict, '00280100')}/${tagOf(entry.dict, '00280101')}`);
    }

    // MONOCHROME1 inside a JPEG is the case that catches re-encoding from
    // DISPLAY pixels: those are already inverted, so storing them back would
    // make the whole image a photographic negative of itself.
    {
      const entry = await install(byId['mono1-jpeg'].bytes, 'mono1jpeg2.dcm');
      await applyRedaction(entry, [BOX], { fill: 'black' });
      ok('mono1-jpeg: the photometric interpretation stays MONOCHROME1',
         String(tagOf(entry.dict, '00280004')).trim() === 'MONOCHROME1',
         String(tagOf(entry.dict, '00280004')));
    }
    // Converting a JPEG to raw monochrome hands it to a decoder that windows;
    // an image that had no Window Center would otherwise come out restretched
    // between its own min and max, i.e. with different contrast outside the box.
    {
      const entry = await install(byId['jpeg-baseline'].bytes, 'voi.dcm');
      ok('jpeg-baseline: the case has no Window Center to start with',
         tagOf(entry.dict, '00281050') === undefined);
      await applyRedaction(entry, [BOX], { fill: 'black' });
      ok('jpeg-baseline: an identity 8-bit VOI is stated so the greys do not move',
         String(tagOf(entry.dict, '00281050')).trim() === '128' &&
         String(tagOf(entry.dict, '00281051')).trim() === '256',
         `${tagOf(entry.dict, '00281050')}/${tagOf(entry.dict, '00281051')}`);
    }
    {
      // A file that already carries a window keeps it — we are not restating
      // someone else's presentation decision.
      const n = Forge.W * Forge.H;
      const gray = new Uint8Array(n);
      for (let i = 0; i < n; i++) gray[i] = (i * 7) & 0xFF;
      const c2 = document.createElement('canvas');
      c2.width = Forge.W; c2.height = Forge.H;
      const cx = c2.getContext('2d');
      const im = cx.createImageData(Forge.W, Forge.H);
      for (let i = 0; i < n; i++) { im.data[i*4] = im.data[i*4+1] = im.data[i*4+2] = gray[i]; im.data[i*4+3] = 255; }
      cx.putImageData(im, 0, 0);
      const blob = await new Promise(r => c2.toBlob(r, 'image/jpeg', 1));
      const jpg = await blob.arrayBuffer();
      const bytes = Forge.build({ ts: '1.2.840.10008.1.2.4.50', rows: Forge.H, cols: Forge.W,
                                  pi: 'MONOCHROME2', ba: 8, bs: 8, hb: 7, pr: 0,
                                  wc: 100, ww: 200, encapsulated: [jpg] });
      const entry = await install(bytes, 'voikeep.dcm');
      await applyRedaction(entry, [BOX], { fill: 'black' });
      ok('a JPEG that already had a window keeps it',
         String(tagOf(entry.dict, '00281050')).trim() === '100', String(tagOf(entry.dict, '00281050')));
    }
    // Three JPEG fragments, three frames: the frame the user is looking at is
    // not the only one carrying the banner.
    {
      const c = byId['jpeg-multiframe'];
      const entry = await install(c.bytes, 'jpeg-mf.dcm');
      const res = await applyRedaction(entry, [BOX], { fill: 'black' });
      ok('jpeg-multiframe: all three frames are redacted', res.frames === 3, res.error || String(res.frames));
      const rt = await roundTrip(entry);
      for (let f = 0; f < c.frames; f++) {
        const live = await decode(rt, f);
        ok(`jpeg-multiframe: frame ${f} is blanked under the box`,
           !!live && !boxIs(live.pixels, c.w, c.h, [BOX], [0, 0, 0]),
           live ? (boxIs(live.pixels, c.w, c.h, [BOX], [0, 0, 0]) || live.error || '') : 'null');
      }
    }
    // A YBR_FULL_422 JPEG comes back from the browser as RGB, and the file has
    // to say so or every later reader converts colour that is already converted.
    {
      const c = byId['ybr-422-jpeg'];
      const entry = await install(c.bytes, 'ybr422.dcm');
      const res = await applyRedaction(entry, [BOX], { fill: 'black' });
      ok('ybr-422-jpeg: redaction applies', !res.error, res.error || '');
      ok('ybr-422-jpeg: the photometric interpretation becomes RGB',
         String(tagOf(entry.dict, '00280004')).trim() === 'RGB', String(tagOf(entry.dict, '00280004')));
      const back = await decode(await roundTrip(entry));
      ok('ybr-422-jpeg: the written file still shows the same colours',
         !!back && !outsideMatches(back.pixels, Forge.expected(c.ref, c.w, c.h), c.w, c.h, [BOX], c.tol),
         back ? (outsideMatches(back.pixels, Forge.expected(c.ref, c.w, c.h), c.w, c.h, [BOX], c.tol) || back.error || '') : 'null');
    }
    // Three fragments, one frame: only the first carries the SOI marker.
    {
      const c = byId['jpeg-split-fragments'];
      const entry = await install(c.bytes, 'split.dcm');
      const res = await applyRedaction(entry, [BOX], { fill: 'black' });
      ok('jpeg-split-fragments: a fragmented frame is reassembled before redacting',
         !res.error && res.frames === 1, res.error || `frames=${res.frames}`);
      const back = await decode(await roundTrip(entry));
      ok('jpeg-split-fragments: and the whole picture comes back',
         !!back && !outsideMatches(back.pixels, Forge.expected(c.ref, c.w, c.h), c.w, c.h, [BOX], c.tol),
         back ? (outsideMatches(back.pixels, Forge.expected(c.ref, c.w, c.h), c.w, c.h, [BOX], c.tol) || '') : 'null');
    }
    // Multi-frame RLE: the ultrasound loop shape, one fragment per frame.
    {
      const c = byId['rle-multiframe'];
      const entry = await install(c.bytes, 'rle-mf.dcm');
      const res = await applyRedaction(entry, [BOX], { fill: 'black' });
      ok('rle-multiframe: all three frames are redacted', res.frames === 3, String(res.frames));
      ok('rle-multiframe: Number of Frames is left alone',
         parseInt(tagOf(entry.dict, '00280008')) === 3, String(tagOf(entry.dict, '00280008')));
      const rt = await roundTrip(entry);
      for (let f = 0; f < c.frames; f++) {
        const live = await decode(rt, f);
        const want = Forge.expected(c.frameRef(f), c.w, c.h);
        ok(`rle-multiframe: frame ${f} is blanked under the box`,
           !!live && !boxIs(live.pixels, c.w, c.h, [BOX], [0, 0, 0]),
           live ? (boxIs(live.pixels, c.w, c.h, [BOX], [0, 0, 0]) || live.error || '') : 'null');
        ok(`rle-multiframe: frame ${f} is otherwise byte-identical`,
           !!live && !outsideMatches(live.pixels, want, c.w, c.h, [BOX], 0),
           live ? (outsideMatches(live.pixels, want, c.w, c.h, [BOX], 0) || '') : 'null');
      }
    }

    // ---- refusals -----------------------------------------------------------
    // A codec we cannot read must leave the dataset exactly as it found it. Half
    // a redaction on an image nobody can decode is worse than a clear refusal.
    {
      const jls = Forge.build({ ts: '1.2.840.10008.1.2.4.80', rows: Forge.H, cols: Forge.W,
                                pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
                                encapsulated: [new Uint8Array([0xFF, 0xD8, 0xFF, 0xF7, 0, 0, 0, 0]).buffer] });
      // The first three now reach a decoder and fail inside it; only HTJ2K and
      // MPEG are refused on the transfer syntax alone. Both shapes have to leave
      // the dataset exactly as they found it.
      for (const [id, bytes, pat] of [
        ['jpeg2000-unsupported', byId['jpeg2000-unsupported'].bytes, /JPEG 2000/],
        ['j2k-truncated', byId['j2k-truncated'].bytes, /JPEG 2000/],
        ['htj2k-unsupported', byId['htj2k-unsupported'].bytes, /High-Throughput/],
        ['mpeg2-unsupported', byId['mpeg2-unsupported'].bytes, /MPEG-2/],
        ['jpeg-ls', jls, /JPEG-LS/],
      ]) {
        const entry = await install(bytes, id + '.dcm');
        const before = lookupTag(entry.dict, '7fe00010');
        const beforeBytes = before.Value.map(v => new Uint8Array(v).join(',')).join('|');
        const res = await applyRedaction(entry, [BOX], { fill: 'black' });
        ok(`${id}: refuses, and says which codec`, !!res.error && pat.test(res.error), res.error || 'no error');
        const after = lookupTag(entry.dict, '7fe00010');
        ok(`${id}: Pixel Data is untouched`,
           after.Value.map(v => new Uint8Array(v).join(',')).join('|') === beforeBytes);
        ok(`${id}: no de-identification claim is made`,
           tagOf(entry.dict, '00280301') === undefined && tagOf(entry.dict, '00120064') === undefined,
           `0028,0301=${tagOf(entry.dict, '00280301')}`);
        ok(`${id}: nothing is left to undo`, !entry.redactBackup);
      }
    }
    {
      const entry = await install(byId['mono2-u8'].bytes, 'nobox.dcm');
      const res = await applyRedaction(entry, [], { fill: 'black' });
      ok('no boxes: refuses rather than rewriting the file for nothing', !!res.error, res.error || 'no error');
    }

    // ---- the tag side -------------------------------------------------------
    {
      const extra = {
        '00280301': { vr: 'CS', v: ['YES'] },
        '00282110': { vr: 'CS', v: ['01'] },
        '00282112': { vr: 'DS', v: ['4.5'] },
        '00282114': { vr: 'CS', v: ['ISO_10918_1'] },
      };
      const n = Forge.W * Forge.H;
      const s = new Uint16Array(n);
      const p = Forge.pattern(Forge.W, Forge.H);
      for (let i = 0; i < n; i++) s[i] = Math.round(p[i] * 4095);
      const bytes = Forge.build({ rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16,
                                  bs: 12, hb: 11, pr: 0, wc: 2048, ww: 4096, pixels: s, extra });
      const entry = await install(bytes, 'tags.dcm');
      const sopBefore = tagOf(entry.dict, '00080018');
      ok('the case starts out marked Burned In Annotation = YES',
         tagOf(entry.dict, '00280301') === 'YES', String(tagOf(entry.dict, '00280301')));

      await applyRedaction(entry, [BOX], { fill: 'black' });
      const rt = await roundTrip(entry);

      ok('(0028,0301) Burned In Annotation becomes NO',
         String(tagOf(rt.dict, '00280301')).trim() === 'NO', String(tagOf(rt.dict, '00280301')));
      const seq = lookupTag(rt.dict, '00120064')?.Value || [];
      const codes = seq.map(it => String(it?.['00080100']?.Value?.[0] || it?.['x00080100']?.Value?.[0] || ''));
      ok('(0012,0064) gains code 113101', codes.includes('113101'), codes.join(','));
      const clean = seq.find(it => String(it?.['00080100']?.Value?.[0] || '') === '113101');
      ok('and it is DCM 113101 "Clean Pixel Data Option"',
         String(clean?.['00080102']?.Value?.[0]) === 'DCM' &&
         String(clean?.['00080104']?.Value?.[0]) === 'Clean Pixel Data Option',
         JSON.stringify(clean || null).slice(0, 120));
      ok('(0012,0063) records the method',
         /redacted/i.test(String(tagOf(rt.dict, '00120063') || '')), String(tagOf(rt.dict, '00120063')));
      ok('(0008,0018) is a fresh SOP Instance UID',
         tagOf(rt.dict, '00080018') !== sopBefore && !!tagOf(rt.dict, '00080018'),
         `${sopBefore} -> ${tagOf(rt.dict, '00080018')}`);
      ok('(0002,0003) follows it', String(rt.meta['00020003']?.Value?.[0]) === String(tagOf(rt.dict, '00080018')),
         String(rt.meta['00020003']?.Value?.[0]));
      const it = lookupTag(rt.dict, '00080008')?.Value || [];
      ok('(0008,0008) Image Type value 1 is DERIVED', String(it[0]).trim() === 'DERIVED', it.join('\\'));
      ok('(0008,0008) keeps its other values', String(it[1] || '').trim() === 'SECONDARY', it.join('\\'));
      ok('(0008,2111) Derivation Description says what was done',
         /redacted/i.test(String(tagOf(rt.dict, '00082111') || '')), String(tagOf(rt.dict, '00082111')));
      // Lossy Image Compression describes the pixel data's HISTORY. Redaction
      // does not restore what a lossy codec threw away, so clearing it would
      // assert something false.
      ok('(0028,2110) Lossy Image Compression is left as it was',
         String(tagOf(rt.dict, '00282110')).trim() === '01', String(tagOf(rt.dict, '00282110')));
      ok('(0028,2112) Lossy Image Compression Ratio is left as it was',
         String(tagOf(rt.dict, '00282112')).trim() === '4.5', String(tagOf(rt.dict, '00282112')));
      ok('(0028,2114) Lossy Image Compression Method is left as it was',
         String(tagOf(rt.dict, '00282114')).trim() === 'ISO_10918_1', String(tagOf(rt.dict, '00282114')));

      // THE trap: buildEditedFile replays entry.pending over the dataset, so a
      // working copy that still says YES puts YES back into the exported file.
      ok('the working copy was reseeded, so the export is not marked YES again',
         String(entry.pending.get(editKey('00280301'))?.valueString || '').trim() === 'NO',
         String(entry.pending.get(editKey('00280301'))?.valueString));
    }
    {
      // A file with no Lossy Image Compression tag must not acquire one.
      const entry = await install(byId['mono2-u8'].bytes, 'nolossy.dcm');
      await applyRedaction(entry, [BOX], { fill: 'black' });
      ok('(0028,2110) is not invented on a file that never had it',
         tagOf(entry.dict, '00282110') === undefined, String(tagOf(entry.dict, '00282110')));
    }
    {
      // Anonymize first, then redact: both claims are true of the file and both
      // codes have to be in the sequence.
      const entry = await install(byId['mono2-u8'].bytes, 'anonthen.dcm');
      anonymize(entry.dict);
      reseedAllPending();
      const methodBefore = String(tagOf(entry.dict, '00120063') || '');
      await applyRedaction(entry, [BOX], { fill: 'black' });
      const rt = await roundTrip(entry);
      const codes = (lookupTag(rt.dict, '00120064')?.Value || [])
        .map(it => String(it?.['00080100']?.Value?.[0] || ''));
      ok('anonymize then redact: both 113100 and 113101 are recorded',
         codes.includes('113100') && codes.includes('113101'), codes.join(','));
      ok('anonymize then redact: the earlier method note is kept',
         String(tagOf(rt.dict, '00120063') || '').startsWith(methodBefore.slice(0, 20)),
         String(tagOf(rt.dict, '00120063')));
      ok('anonymize then redact: Patient Identity Removed still says YES',
         String(tagOf(rt.dict, '00120062')).trim() === 'YES', String(tagOf(rt.dict, '00120062')));
    }
    {
      // Redacting twice must not stack a second 113101 item.
      const entry = await install(byId['mono2-u8'].bytes, 'twice.dcm');
      await applyRedaction(entry, [BOX], { fill: 'black' });
      await applyRedaction(entry, [{ x: 0, y: 20, w: 10, h: 4 }], { fill: 'black' });
      const codes = (lookupTag(entry.dict, '00120064')?.Value || [])
        .map(it => String(it?.['00080100']?.Value?.[0] || ''));
      ok('redacting twice records 113101 once', codes.filter(c => c === '113101').length === 1, codes.join(','));
      const res = await decode(entry);
      ok('redacting twice keeps both boxes',
         !!res && !boxIs(res.pixels, Forge.W, Forge.H, [BOX, { x: 0, y: 20, w: 10, h: 4 }], [0, 0, 0]),
         res ? (boxIs(res.pixels, Forge.W, Forge.H, [BOX, { x: 0, y: 20, w: 10, h: 4 }], [0, 0, 0]) || '') : 'null');
    }

    // ---- undo, within the session -------------------------------------------
    {
      const c = byId['rle-mono16'];
      const entry = await install(c.bytes, 'undo.dcm');
      const sopBefore = tagOf(entry.dict, '00080018');
      await applyRedaction(entry, [BOX], { fill: 'black' });
      ok('undo: a backup is kept after redacting', !!entry.redactBackup);

      // Exporting sits between redacting and undoing in real use, and the writer
      // is handed the redacted dataset itself now rather than a deep copy of it.
      // The elements applyRedaction set aside are the ones it replaced, so they
      // are not in that dataset at all — but if saving ever started writing
      // through the dataset it is given, the undo below would put back something
      // the export had already changed.
      const savedOnce = DicomMessage.readFile(await buildEditedFile(entry).arrayBuffer());
      ok('undo: the exported file carries the redaction',
         tagOf(savedOnce.dict, '00280301') === 'NO', String(tagOf(savedOnce.dict, '00280301')));
      ok('undo: saving does not consume the backup', !!entry.redactBackup);
      ok('undo: saving does not re-tag the dataset a second time',
         String(tagOf(entry.dict, '00082111') || '').split('Carino DICOM-editor').length === 2,
         String(tagOf(entry.dict, '00082111')));

      ok('undo: restores the file', undoRedaction(entry) === true);
      ok('undo: the transfer syntax goes back to RLE',
         tsOf(entry.meta) === '1.2.840.10008.1.2.5', tsOf(entry.meta));
      ok('undo: the SOP Instance UID goes back', tagOf(entry.dict, '00080018') === sopBefore);
      ok('undo: Burned In Annotation is not left claiming NO',
         tagOf(entry.dict, '00280301') === undefined, String(tagOf(entry.dict, '00280301')));
      const back = await decode(entry);
      ok('undo: the original pixels are back',
         !!back && !Forge.compare(back.pixels, Forge.expected(c.ref, c.w, c.h), c.tol),
         back ? (back.error || Forge.compare(back.pixels, Forge.expected(c.ref, c.w, c.h), c.tol) || '') : 'null');
      ok('undo: there is nothing left to undo twice', undoRedaction(entry) === false);
    }

    // ---- screen -> image, through zoom, pan, rotate and flip -----------------
    // A non-square image, so a transposed axis fails loudly rather than looking
    // right. The forward map here is built from view state by hand — it does not
    // ask the DOM for the matrix — so it is an independent check of the app's
    // inverse, not the same arithmetic run twice.
    {
      switchTab('overview');
      const W2 = 64, H2 = 48, n2 = W2 * H2;
      const s = new Uint16Array(n2);
      for (let i = 0; i < n2; i++) s[i] = (i * 3) & 0xFFF;
      const bytes = Forge.build({ rows: H2, cols: W2, pi: 'MONOCHROME2', ba: 16, bs: 12,
                                  hb: 11, pr: 0, wc: 2048, ww: 4096, pixels: s });
      await install(bytes, 'geometry.dcm');
      const canvas = document.getElementById('ovCanvas');
      for (let i = 0; i < 160 && (canvas.width !== W2 || canvas.height !== H2); i++) await sleep(25);

      const R = window.ovRedaction;
      // Measured ONCE, with the transform at identity, and never asked of the
      // app again: a CSS transform does not move the layout box, so this rect is
      // the frame every orientation is relative to. Reusing the app's own
      // measurement here would make the round trip self-consistent and let the
      // classic mistake through — getBoundingClientRect() on a rotated element
      // reports the bounds of the ROTATED shape, which is wider than the
      // element and no longer centred on it.
      Object.assign(R.view, { rotate: 0, flipH: false, flipV: false, zoom: 1, panX: 0, panY: 0 });
      R.applyTransform();
      const b0 = canvas.getBoundingClientRect();

      const forward = (v, b, ix, iy) => {
        let x = ix * b.width / canvas.width - b.width / 2;
        let y = iy * b.height / canvas.height - b.height / 2;
        if (v.flipH) x = -x;
        if (v.flipV) y = -y;
        const a = v.rotate * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
        const rx = x * cs - y * sn, ry = x * sn + y * cs;
        return { x: b.left + b.width / 2 + rx * v.zoom + v.panX,
                 y: b.top + b.height / 2 + ry * v.zoom + v.panY };
      };
      const probes = [[0, 0], [W2, H2], [W2 / 2, H2 / 2], [7, 41], [W2 - 1, 1]];

      ok('geometry: the 64x48 image reached the overview canvas',
         canvas.width === W2 && canvas.height === H2, `${canvas.width}x${canvas.height}`);

      for (const rotate of [0, 90, 180, 270]) {
        for (const [flipH, flipV] of [[false, false], [true, false], [false, true], [true, true]]) {
          Object.assign(R.view, { rotate, flipH, flipV, zoom: 1, panX: 0, panY: 0 });
          R.applyTransform();
          let worst = 0;
          for (const [ix, iy] of probes) {
            const scr = forward(R.view, b0, ix, iy);
            const got = R.screenToImage(scr.x, scr.y);
            if (!got) { worst = Infinity; break; }
            worst = Math.max(worst, Math.abs(got.x - ix), Math.abs(got.y - iy));
          }
          ok(`geometry: rotate ${rotate}, flipH ${flipH}, flipV ${flipV}`, worst < 0.5,
             `worst error ${worst.toFixed(4)} px`);
        }
      }
      // Zoom and pan on top of a rotation — the combination that hides an
      // origin mistake behind a plausible-looking box at rotate 0.
      Object.assign(R.view, { rotate: 90, flipH: true, flipV: false, zoom: 2.75, panX: 37, panY: -21 });
      R.applyTransform();
      {
        let worst = 0;
        for (const [ix, iy] of probes) {
          const scr = forward(R.view, b0, ix, iy);
          const got = R.screenToImage(scr.x, scr.y);
          worst = got ? Math.max(worst, Math.abs(got.x - ix), Math.abs(got.y - iy)) : Infinity;
        }
        ok('geometry: rotate 90 + flipH + zoom 2.75 + pan', worst < 0.5, `worst error ${worst.toFixed(4)} px`);
      }
      Object.assign(R.view, { rotate: 0, flipH: false, flipV: false, zoom: 1, panX: 0, panY: 0 });
      R.applyTransform();
    }
    {
      // A large image is clamped by max-height:460px, so layout pixels and image
      // pixels are on different scales and the scale is not a whole number.
      switchTab('overview');
      const W3 = 1024, H3 = 768, n3 = W3 * H3;
      const s = new Uint8Array(n3);
      for (let i = 0; i < n3; i++) s[i] = i & 0xFF;
      const bytes = Forge.build({ rows: H3, cols: W3, pi: 'MONOCHROME2', ba: 8, bs: 8, hb: 7,
                                  pr: 0, wc: 128, ww: 256, pixels: s });
      await install(bytes, 'clamped.dcm');
      const canvas = document.getElementById('ovCanvas');
      for (let i = 0; i < 200 && (canvas.width !== W3 || canvas.height !== H3); i++) await sleep(25);
      const R = window.ovRedaction;
      Object.assign(R.view, { rotate: 0, flipH: false, flipV: false, zoom: 1, panX: 0, panY: 0 });
      R.applyTransform();
      const b = canvas.getBoundingClientRect();
      ok('geometry: a 1024x768 canvas is laid out smaller than its pixels',
         b.width > 0 && b.width < W3, `${b.width.toFixed(2)}x${b.height.toFixed(2)}`);
      let worst = 0;
      for (const [ix, iy] of [[0, 0], [1024, 768], [512, 384], [900, 60]]) {
        const got = R.screenToImage(b.left + ix * b.width / W3, b.top + iy * b.height / H3);
        worst = got ? Math.max(worst, Math.abs(got.x - ix), Math.abs(got.y - iy)) : Infinity;
      }
      ok('geometry: the layout-to-image scale is exact on a clamped canvas', worst < 0.5,
         `worst error ${worst.toFixed(4)} px`);
    }

    // ---- the overlay must never reach an export -----------------------------
    // printOverview() ships the live canvas through toDataURL. A preview
    // rectangle drawn while redaction is off would put red boxes in the PDF.
    {
      const c = byId['mono2-u8'];
      await install(c.bytes, 'overlay.dcm');
      const canvas = document.getElementById('ovCanvas');
      for (let i = 0; i < 160 && (canvas.width !== c.w || canvas.height !== c.h); i++) await sleep(25);
      const R = window.ovRedaction;
      R.state.boxes = [{ x: 0, y: 0, w: 20, h: 10 }];
      R.redraw();
      const px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] > px[i+1] + 30) red++;
      ok('no red overlay is drawn while redaction is off', red === 0, `${red} reddish px`);

      R.setMode(true);
      R.redraw();
      const px2 = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let red2 = 0;
      for (let i = 0; i < px2.length; i += 4) if (px2[i] > px2[i+1] + 30) red2++;
      ok('and it is drawn once redaction is on', red2 > 0, `${red2} reddish px`);
      R.setMode(false);
      const px3 = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let red3 = 0;
      for (let i = 0; i < px3.length; i += 4) if (px3[i] > px3[i+1] + 30) red3++;
      ok('leaving redaction repaints the image clean', red3 === 0, `${red3} reddish px`);
    }

    // ---- drawing a box with a pointer, and pressing the button --------------
    // Everything above calls applyRedaction directly. This drives the surface a
    // user touches: the mode toggle, the drag, the delete, and the click that
    // writes the pixels.
    {
      switchTab('overview');
      const c = byId['mono2-u8'];
      const entry = await install(c.bytes, 'interactive.dcm');
      const canvas = document.getElementById('ovCanvas');
      const viewer = document.getElementById('ovViewer');
      for (let i = 0; i < 160 && (canvas.width !== c.w || canvas.height !== c.h); i++) await sleep(25);
      const R = window.ovRedaction;
      Object.assign(R.view, { rotate: 0, flipH: false, flipV: false, zoom: 1, panX: 0, panY: 0 });
      R.applyTransform();

      document.getElementById('ovRedact').click();
      ok('clicking Redact opens the panel',
         R.state.active === true &&
         !document.getElementById('ovRedactPanel').classList.contains('hidden'));

      const b = canvas.getBoundingClientRect();   // identity transform, so this is the layout box
      const at = (ix, iy) => ({ x: b.left + ix * b.width / canvas.width,
                                y: b.top + iy * b.height / canvas.height });
      const send = (type, p) => viewer.dispatchEvent(new PointerEvent(type, {
        clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, pointerId: 1 }));

      send('pointerdown', at(4, 2));
      send('pointermove', at(24, 12));
      send('pointerup', at(24, 12));
      ok('a drag leaves one box behind', R.state.boxes.length === 1, String(R.state.boxes.length));
      const drawn = R.state.boxes[0] || {};
      ok('and it is where it was drawn',
         Math.abs(drawn.x - 4) < 0.5 && Math.abs(drawn.y - 2) < 0.5 &&
         Math.abs(drawn.w - 20) < 0.5 && Math.abs(drawn.h - 10) < 0.5,
         `${drawn.x},${drawn.y} ${drawn.w}x${drawn.h}`);
      ok('the box counter agrees', document.getElementById('ovRedactCount').textContent === '1');
      ok('dragging a box does not pan the image', R.view.panX === 0 && R.view.panY === 0,
         `${R.view.panX},${R.view.panY}`);

      // A click with no movement is not a box.
      send('pointerdown', at(30, 30));
      send('pointerup', at(30, 30));
      ok('a click that does not move creates nothing', R.state.boxes.length === 1,
         String(R.state.boxes.length));

      // The pointer handlers listen on the viewer, which is far wider than the
      // picture, so a drag can happen entirely in the empty margin beside it.
      // clampBox used to clamp the origin and then re-derive the extent from it,
      // which slid such a box onto the image and stretched it to the full width:
      // a gesture that never touched the picture redacted all of it.
      {
        const vb = viewer.getBoundingClientRect();
        const margin = b.left - vb.left;
        const y = b.top + b.height / 2;
        send('pointerdown', { x: vb.left + 2, y });
        send('pointermove', { x: vb.left + margin - 4, y: y + 20 });
        send('pointerup',   { x: vb.left + margin - 4, y: y + 20 });
        ok('a drag entirely beside the picture creates no box',
           margin > 12 && R.state.boxes.length === 1,
           `${margin.toFixed(0)}px margin, ${R.state.boxes.length} box(es): ${JSON.stringify(R.state.boxes)}`);
      }

      // Starting inside and dragging off the left edge should keep only the part
      // that is over the picture.
      {
        R.state.boxes.length = 0;
        send('pointerdown', at(8, 8));
        send('pointermove', { x: b.left - 60, y: at(8, 20).y });
        send('pointerup',   { x: b.left - 60, y: at(8, 20).y });
        const box = R.state.boxes[0];
        ok('a drag off the edge keeps only the part over the picture',
           R.state.boxes.length === 1 && box.x === 0 && Math.abs(box.w - 8) < 0.5,
           JSON.stringify(box || null));
        R.state.boxes.length = 0;
        send('pointerdown', at(4, 2));
        send('pointermove', at(24, 12));
        send('pointerup', at(24, 12));
      }

      // Grab the box by its middle and move it.
      send('pointerdown', at(14, 7));
      send('pointermove', at(20, 15));
      send('pointerup', at(20, 15));
      ok('dragging inside a box moves it rather than drawing another',
         R.state.boxes.length === 1 && Math.abs(R.state.boxes[0].x - 10) < 0.5,
         `${R.state.boxes.length} box(es), x=${R.state.boxes[0] && R.state.boxes[0].x}`);

      viewer.dispatchEvent(new MouseEvent('dblclick', {
        clientX: at(15, 12).x, clientY: at(15, 12).y, bubbles: true, cancelable: true }));
      ok('double-clicking a box deletes it', R.state.boxes.length === 0, String(R.state.boxes.length));

      document.getElementById('ovRedactTop').click();
      ok('"Cover top rows" covers a tenth of the height across the full width',
         R.state.boxes.length === 1 && R.state.boxes[0].w === c.w &&
         R.state.boxes[0].h === Math.round(c.h * 0.10),
         JSON.stringify(R.state.boxes[0] || null));
      document.getElementById('ovRedactClear').click();
      ok('"Clear boxes" empties the list', R.state.boxes.length === 0);

      // Draw one more and press Apply. An uncompressed file needs no
      // confirmation, so the click goes straight through.
      send('pointerdown', at(4, 0));
      send('pointermove', at(24, 5));
      send('pointerup', at(24, 5));
      document.getElementById('ovRedactApply').click();
      for (let i = 0; i < 200 && String(tagOf(entry.dict, '00280301') || '') !== 'NO'; i++) await sleep(25);

      ok('Apply writes the pixels through the button',
         String(tagOf(entry.dict, '00280301') || '') === 'NO', String(tagOf(entry.dict, '00280301')));
      const after = await decode(entry);
      ok('Apply blanked what was drawn',
         !!after && !boxIs(after.pixels, c.w, c.h, [{ x: 4, y: 0, w: 20, h: 5 }], [0, 0, 0]),
         after ? (boxIs(after.pixels, c.w, c.h, [{ x: 4, y: 0, w: 20, h: 5 }], [0, 0, 0]) || '') : 'null');
      ok('Apply leaves redaction mode', R.state.active === false);
      ok('Apply offers the session undo',
         !document.getElementById('ovRedactUndo').classList.contains('hidden'));

      document.getElementById('ovRedactUndo').click();
      for (let i = 0; i < 200 && tagOf(entry.dict, '00280301') !== undefined; i++) await sleep(25);
      const restored = await decode(entry);
      ok('the Undo button puts the picture back',
         !!restored && !Forge.compare(restored.pixels, Forge.expected(c.ref, c.w, c.h), c.tol),
         restored ? (Forge.compare(restored.pixels, Forge.expected(c.ref, c.w, c.h), c.tol) || '') : 'null');
    }

    // ---- the controls -------------------------------------------------------
    for (const id of ['ovRedact', 'ovRedactUndo', 'ovRedactPanel', 'ovRedactFill', 'ovRedactTop',
                      'ovRedactClear', 'ovRedactApply', 'ovRedactCancel', 'ovRedactCount']) {
      ok(`#${id} exists`, !!document.getElementById(id));
    }
    {
      await install(byId['mono2-u8'].bytes, 'btn-ok.dcm');
      ok('the Redact button is enabled on an uncompressed file',
         document.getElementById('ovRedact').disabled === false);
      await install(byId['j2k-mono16-b12'].bytes, 'btn-j2k.dcm');
      ok('and enabled on JPEG 2000, now that it decodes',
         document.getElementById('ovRedact').disabled === false);
      await install(byId['htj2k-unsupported'].bytes, 'btn-no.dcm');
      const b = document.getElementById('ovRedact');
      ok('and disabled on High-Throughput JPEG 2000', b.disabled === true);
      ok('with a title that says why', /High-Throughput/.test(b.title), b.title);
    }
    {
      // The panel has to say that every frame is covered — a de-identification
      // tool that redacts only the visible frame of a cine is a trap.
      const panel = document.getElementById('ovRedactPanel');
      // The whole sentence through t(), not the English words in it: this suite
      // also runs inside index.html#selftest, in the visitor's own language.
      ok('the panel states that every frame is covered',
         panel.textContent.includes((window.t || String)('Redaction covers every frame of this image.')),
         panel.textContent.replace(/\s+/g, ' ').trim().slice(0, 80));
    }

    // ---- a redaction that covers nothing must not claim to have redacted ----
    // The worst outcome this code has: identity still burned into the pixels and
    // a file that now says (0028,0301) = NO. It is not reachable through the UI
    // now that boxes are clipped rather than relocated, but applyRedaction is
    // called with whatever it is given.
    {
      const c = byId['mono2-u8'];
      const entry = await install(c.bytes, 'missed.dcm');
      const before = String(tagOf(entry.dict, '00280301') ?? '');
      const res = await applyRedaction(entry, [{ x: 1000, y: 1000, w: 50, h: 50 }]);
      ok('a box that misses the image is refused', !!(res && res.error), JSON.stringify(res));
      ok('and the file is not marked as redacted',
         String(tagOf(entry.dict, '00280301') ?? '') === before,
         `${before} -> ${tagOf(entry.dict, '00280301')}`);
      ok('and its pixels are left alone',
         !Forge.compare((await decode(entry)).pixels, Forge.expected(c.ref, c.w, c.h), c.tol || 0));
    }

    // ---- i18n ---------------------------------------------------------------
    {
      const NEW_STRINGS = [
        'Redact', 'Redact burned-in annotation', 'Undo redaction',
        'Drag a box over any burned-in text. Drag a box to move it; double-click to delete it.',
        'Redaction covers every frame of this image.',
        'Redaction cannot be undone once the file is exported.',
        'Fill', 'Black', 'White', 'Cover top rows', 'Clear boxes', 'Apply redaction',
        'Boxes', 'Redact pixels', 'Draw at least one box first.',
        'Redacted {n} region(s) across {m} frame(s) — pixels overwritten.',
        'Redaction undone (this session only).',
        'This image cannot be redacted: its pixel data uses a compression this browser cannot decode.',
        'Redacting decompresses this image to uncompressed Explicit VR Little Endian. The file will be larger and its Transfer Syntax will change. Continue?',
        'This image was compressed with lossy JPEG; redacting it will store 8 bits per sample.',
        'Burned In Annotation = YES — identity may be burned into the pixels. Use Redact on the Overview tab.',
      ];
      for (const loc of ['es', 'pt-BR', 'ja', 'ru']) {
        const missing = NEW_STRINGS.filter(s => !I18N[loc] || !I18N[loc][s]);
        ok(`i18n: every new string is translated into ${loc}`, missing.length === 0,
           missing.join(' | ').slice(0, 160));
      }
      ok('i18n: the Redact button title is in ATTR_I18N',
         ATTR_I18N.some(([id, attr]) => id === 'ovRedact' && attr === 'title'));
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
  pre.textContent = (await window.SUITES.redact()).join('\n');
  document.body.appendChild(pre);
});
