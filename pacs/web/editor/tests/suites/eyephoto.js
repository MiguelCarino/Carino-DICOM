// Create → Eye photo: camera JPEGs and PNGs become Ophthalmic Photography 8 Bit images.
//
// What a wrong converter gets wrong, and so what this checks: the SOP class and Modality (OP,
// not Secondary Capture), Image Laterality on every image (and no file at all until each photo
// has one), the camera's JPEG bytes filed as they are rather than decoded and re-encoded, the
// ophthalmic modules' mandatory attributes, and an order handed over by a worklist landing in
// the right study. The encapsulated bytes are found by a reader written here, not by dcmjs, so
// a writer and parser that agree on a mistake still fail; the file is then opened by the app's
// own parser and decoder, the way a dropped file would be.
(window.SUITES || (window.SUITES = {})).eyephoto = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const $ = (id) => document.getElementById(id);
  const str = (d, t) => { const e = lookupTag(d, t); return e ? elToString(e).trim() : undefined; };
  const tick = () => new Promise(r => setTimeout(r, 0));
  const change = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };

  // A small made-up "fundus": orange-red field, darker rim, a bright disc on the right.
  const picture = (w = 96, h = 64) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    grad.addColorStop(0, '#d0602a'); grad.addColorStop(1, '#3a0d05');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffe9a8'; g.beginPath(); g.arc(w * 0.72, h * 0.5, h * 0.12, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#7a1a10'; g.fillRect(w * 0.2, h * 0.45, w * 0.5, 2);
    return c;
  };
  const blobOf = (c, type, q) => new Promise(r => c.toBlob(r, type, q));
  const jpegBytes = async () => new Uint8Array(await (await blobOf(picture(), 'image/jpeg', 0.9)).arrayBuffer());
  const jpegFile = async (name, bytes) => new File([bytes || await jpegBytes()], name, { type: 'image/jpeg' });
  const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

  // The one fragment after the empty Basic Offset Table, read straight from the Part 10 bytes:
  // (7FE0,0010) OB with undefined length, the Basic Offset Table item, then the frame's item.
  const firstFragment = (buf) => {
    const u = new Uint8Array(buf);
    const sig = [0xE0, 0x7F, 0x10, 0x00, 0x4F, 0x42, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF];
    let p = -1;
    for (let i = u.length - sig.length; i >= 132; i--) if (sig.every((b, k) => u[i + k] === b)) { p = i; break; }
    if (p < 0) return null;
    const dv = new DataView(u.buffer, u.byteOffset);
    let q = p + sig.length;
    const item = () => { const tag = dv.getUint32(q, true); const len = dv.getUint32(q + 4, true); q += 8; return { tag, len }; };
    const bot = item();
    if (bot.tag !== 0xE000FFFE) return null;
    const offsets = [];
    for (let k = 0; k < bot.len; k += 4) offsets.push(dv.getUint32(q + k, true));
    q += bot.len;
    const fr = item();
    if (fr.tag !== 0xE000FFFE) return null;
    const bytes = u.slice(q, q + fr.len);
    q += fr.len;
    const next = item();
    return { bytes, offsets, endsAfterOne: next.tag === 0xE0DDFFFE };
  };

  // EXIF APP1 (little-endian TIFF) with Orientation and DateTimeOriginal, put after SOI.
  const withExif = (jpeg, orientation, taken) => {
    const t = [];
    const u16 = v => t.push(v & 255, v >> 8), u32 = v => t.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24);
    t.push(0x49, 0x49); u16(42); u32(8);
    u16(2);                                           // IFD0 at 8: two entries
    u16(0x0112); u16(3); u32(1); u16(orientation); u16(0);
    u16(0x8769); u16(4); u32(1); u32(38);             // Exif IFD at 8 + 2 + 24 + 4 = 38
    u32(0);
    u16(1);                                           // Exif IFD: one entry
    u16(0x9003); u16(2); u32(20); u32(56);            // string at 38 + 2 + 12 + 4 = 56
    u32(0);
    for (const ch of taken + '\0') t.push(ch.charCodeAt(0));
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...t];
    const seg = [0xFF, 0xE1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
    return new Uint8Array([0xFF, 0xD8, ...seg, ...jpeg.subarray(2)]);
  };

  const reset = () => {
    $('clearCreateBtn').click();
    createOrder = {}; renderCreateOrder();
    $('cdAccession').value = $('cdReferring').value = '';
    setCreateKind('general');
    showCreateBlock('');
  };
  const outputs = async () => { const all = []; for await (const o of createDicomOutputs()) all.push(o); return all; };

  // Downloads are counted, not saved: an anchor click is how Create hands a file over.
  const realClick = HTMLAnchorElement.prototype.click;
  let downloads = [];
  HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push(this.download); else realClick.call(this); };
  const prevFov = (() => { try { return localStorage.getItem('dcm-create-fov'); } catch (_) { return null; } })();

  try {
    // ---- which eye, from the file name -----------------------------------------
    {
      const cases = [
        ['patient_OD.jpg', 'R'], ['1234-os-20260101.jpg', 'L'], ['scan OU.png', 'B'],
        ['RIGHT eye.jpg', 'R'], ['ojo_izquierdo.jpg', 'L'], ['Derecho.JPG', 'R'],
        ['fundus_L1.jpg', 'L'], ['paciente_OI.jpg', 'L'], ['olho-OE.jpeg', 'L'], ['ambos ojos.png', 'B'],
        ['IMG_0042.jpg', null], ['photos.jpg', null], ['Rosa.jpg', null], ['macOS shot.png', null],
        ['od_and_os.jpg', null], ['Fotografía derecha.jpg', 'R'],
      ];
      const wrong = cases.filter(([n, e]) => eyeFromFilename(n) !== e).map(([n, e]) => `${n}: ${eyeFromFilename(n)} not ${e}`);
      ok('the file name gives the eye when it names one, and only then', wrong.length === 0, wrong.join(' | '));
    }

    // ---- the mode ------------------------------------------------------------------
    {
      reset();
      ok('Create starts as a plain picture', $('cdKind').value === 'general' && $('cdEyeCard').classList.contains('hidden'));
      change($('cdKind'), 'eye');
      ok('Eye photo shows the eye card', !$('cdEyeCard').classList.contains('hidden'));
      ok('and fixes Modality to OP', $('cdModality').value === 'OP' && $('cdModality').disabled);
      change($('cdKind'), 'general');
      ok('back to a picture frees Modality again', !$('cdModality').disabled && $('cdModality').value === 'OT', $('cdModality').value);
      change($('cdModality'), 'OP');
      ok('choosing Modality OP switches to Eye photo', createKind === 'eye' && $('cdKind').value === 'eye');
    }

    // ---- the picker, and no file until every photo has an eye ----------------------
    const src = await jpegBytes();
    {
      reset();
      change($('cdKind'), 'eye');
      addCreateImages([await jpegFile('clinic_OD.jpg', src), await jpegFile('IMG_0007.jpg')]);
      const sels = [...document.querySelectorAll('#createImgGrid .img-thumb-eye')];
      ok('each eye photo gets a Right / Left / Both picker', sels.length === 2, `${sels.length}`);
      ok('filled from the file name', sels[0]?.value === 'R' && !sels[0].classList.contains('unset'));
      ok('and left unset, and marked, when the name says nothing', sels[1]?.value === '' && sels[1].classList.contains('unset'));
      ok('the picker offers exactly R, L and B', [...sels[0].options].map(o => o.value).join(',') === ',R,L,B');

      downloads = [];
      $('createDicomBtn').click();
      await tick();
      ok('Create with an eye unset writes nothing', downloads.length === 0, downloads.join(','));
      ok('and says why beside the button', !$('cdBlock').classList.contains('hidden') &&
         $('cdBlock').textContent === T('Choose Right, Left or Both on every eye photo first. {n} still need one.').replace('{n}', 1),
         $('cdBlock').textContent);

      // Removing the unlabelled photo unblocks Create; the message must not outlive the reason.
      const extra = await jpegFile('IMG_0008.jpg');
      addCreateImages([extra]);
      ok('adding another unset photo updates the count', $('cdBlock').textContent ===
         T('Choose Right, Left or Both on every eye photo first. {n} still need one.').replace('{n}', 2), $('cdBlock').textContent);
      document.querySelectorAll('#createImgGrid .img-thumb-remove')[2].click();
      ok('and removing it puts the count back', $('cdBlock').textContent ===
         T('Choose Right, Left or Both on every eye photo first. {n} still need one.').replace('{n}', 1), $('cdBlock').textContent);

      $('cdEyeFov').value = '45';
      const sels2 = [...document.querySelectorAll('#createImgGrid .img-thumb-eye')];
      change(sels2[1], 'L');
      ok('choosing the eye clears the message', $('cdBlock').classList.contains('hidden'), $('cdBlock').textContent);
      ok('and records it on the photo', createImages[1].eye === 'L');

      $('cdEyeDevice').value = 'fundus';
      $('cdEyeFov').value = '';
      $('createDicomBtn').click();
      await tick();
      ok('a fundus photo without a field of view is blocked too', downloads.length === 0 &&
         $('cdBlock').textContent === T("Enter the camera's field of view in degrees. Fundus photos need it to record the pixel size."),
         $('cdBlock').textContent);
      $('cdEyeFov').value = '45';
      $('createDicomBtn').click();
      for (let i = 0; i < 150 && (downloads.length < 2 || $('createDicomBtn').disabled); i++) await new Promise(r => setTimeout(r, 20));
      ok('with both eyes and a field of view it writes both files', downloads.join(',') === 'clinic_OD.dcm,IMG_0007.dcm', downloads.join(','));
      $('cdEyeDevice').value = 'slitlamp';
      $('cdEyeFov').value = '';
      ok('a slit-lamp photo needs no field of view', createBlockReason() === '', createBlockReason());
      $('cdEyeDevice').value = 'fundus';
      $('cdEyeFov').value = '45';
    }

    // ---- the file: JPEG kept as it is -----------------------------------------------
    let opBuf = null;
    {
      $('cdPatientName').value = 'OJEDA^ROSA';
      $('cdPatientID').value = 'EYE-1';
      $('cdEyeBurnedIn').checked = true;
      const res = await outputs();
      ok('two outputs, no errors', res.length === 2 && res.every(r => r.buf), res.map(r => r.error).filter(Boolean).join(' | '));
      opBuf = res[0].buf;
      const msg = DicomMessage.readFile(opBuf);
      const d = msg.dict, m = msg.meta;
      const other = DicomMessage.readFile(res[1].buf).dict;
      ok('SOP Class is Ophthalmic Photography 8 Bit Image Storage', str(d, '00080016') === '1.2.840.10008.5.1.4.1.1.77.1.5.1' &&
         str(m, '00020002') === '1.2.840.10008.5.1.4.1.1.77.1.5.1', str(d, '00080016'));
      ok('transfer syntax is JPEG Baseline', str(m, '00020010') === '1.2.840.10008.1.2.4.50', str(m, '00020010'));
      ok('Modality is OP', str(d, '00080060') === 'OP');
      ok('Image Laterality is per image: R, then L', str(d, '00200062') === 'R' && str(other, '00200062') === 'L');
      ok('no series-level Laterality, since one series holds both eyes', lookupTag(d, '00200060') === undefined || lookupTag(d, '00200060') === null);
      ok('Photometric Interpretation YBR_FULL_422, 3 samples, colour-by-pixel',
         str(d, '00280004') === 'YBR_FULL_422' && str(d, '00280002') === '3' && str(d, '00280006') === '0');
      ok('rows and columns come from the JPEG', str(d, '00280010') === '64' && str(d, '00280011') === '96');
      ok('8 bits allocated, 8 stored, high bit 7 (A.41.4.1)',
         str(d, '00280100') === '8' && str(d, '00280101') === '8' && str(d, '00280102') === '7' && str(d, '00280103') === '0');
      ok('Lossy Image Compression 01, method ISO_10918_1', str(d, '00282110') === '01' && str(d, '00282114') === 'ISO_10918_1');
      const ratio = Number(str(d, '00282112'));
      ok('and a compression ratio from the real sizes', Math.abs(ratio - 96 * 64 * 3 / src.length) < 0.01, `${ratio}`);

      const frag = firstFragment(opBuf);
      // PS3.5 A.4: the offset table may be empty or list the one frame at offset 0.
      ok('the pixel data is one fragment, after an offset table that is empty or [0]',
         !!frag && frag.offsets.every(o => o === 0) && frag.offsets.length <= 1 && frag.endsAfterOne,
         frag ? `offsets ${frag.offsets.join(',')}, ends after one: ${frag.endsAfterOne}` : 'none');
      const exact = frag && (same(frag.bytes, src) ||
        (src.length % 2 === 1 && frag.bytes.length === src.length + 1 && frag.bytes[src.length] === 0 && same(frag.bytes.subarray(0, src.length), src)));
      ok('the fragment is the camera JPEG byte for byte (plus at most the pad byte)', exact,
         frag ? `${frag.bytes.length} vs ${src.length}` : 'no fragment found');

      const code = (seq) => { const it = lookupTag(d, seq)?.Value?.[0]; return it ? `${str(it, '00080102')}:${str(it, '00080100')}:${str(it, '00080104')}` : ''; };
      ok('Acquisition Device Type is CID 4202 Fundus Camera', code('00220015') === 'SCT:409898007:Fundus Camera', code('00220015'));
      ok('Anatomic Region is CID 4209 Retina', code('00082218') === 'SCT:5665001:Retina', code('00082218'));
      const ps = str(d, '00280030');
      const want = 45 * 0.288 / 96;
      ok('a fundus image carries a nominal Pixel Spacing from its field of view',
         !!ps && ps.split('\\').length === 2 && ps.split('\\').every(v => Math.abs(Number(v) - want) < 1e-6), ps);
      ok('and the field of view itself', Number(str(d, '0022000C')) === 45, str(d, '0022000C'));
      ok('Image Type ORIGINAL\\PRIMARY', str(d, '00080008') === 'ORIGINAL\\PRIMARY', str(d, '00080008'));
      ok('one frame, Frame Increment Pointer at Frame Time = 0',
         str(d, '00280008') === '1' && lookupTag(d, '00280009')?.Value?.[0] === 0x00181063 && Number(str(d, '00181063')) === 0);
      ok('Synchronization: no trigger, not time-synchronized, one UID for the batch',
         str(d, '0018106A') === 'NO TRIGGER' && str(d, '00181800') === 'N' &&
         !!str(d, '00200200') && str(d, '00200200') === str(other, '00200200'));
      ok('Burned In Annotation follows the tick box', str(d, '00280301') === 'YES');
      ok('Acquisition DateTime is set, as ORIGINAL requires', /^\d{14}$/.test(str(d, '0008002A') || ''), str(d, '0008002A'));
      ok('Patient Eye Movement Commanded is present (Type 2)', lookupTag(d, '00220005') != null);
      ok('both files: one study, one series, instances 1 and 2',
         str(d, '0020000D') === str(other, '0020000D') && str(d, '0020000E') === str(other, '0020000E') &&
         str(d, '00200013') === '1' && str(other, '00200013') === '2');
      ok('the patient made it in', str(d, '00100010') === 'OJEDA^ROSA' && str(d, '00100020') === 'EYE-1');

      const issues = validateDicom(d, m);
      const errs = issues.filter(i => i.sev === 'error');
      ok('the editor\'s own validator finds no errors', errs.length === 0, errs.map(i => `${i.tag} ${i.msg}`).join(' | ').slice(0, 300));
      ok('and knows the SOP class', !issues.some(i => i.tag === '00080016'), issues.filter(i => i.tag === '00080016').map(i => i.msg).join());
      const missing = issues.filter(i => /^Missing/.test(i.msg));
      ok('and no missing Type 1 or 2 attribute', missing.length === 0, missing.map(i => `${i.tag} ${i.msg}`).join(' | ').slice(0, 300));
      const noLat = { ...d }; delete noLat['00200062'];
      ok('the validator flags an OP image with no laterality', validateDicom(noLat, m).some(i => i.sev === 'error' && i.tag === '00200062'));
      const uLat = { ...d, '00200062': { vr: 'CS', Value: ['U'] } };
      ok('and one marked U (OP allows only R, L or B)', validateDicom(uLat, m).some(i => i.sev === 'error' && i.tag === '00200062'));

      // Through the app, as a dropped file.
      const n = await handleFiles([new File([opBuf], 'clinic_OD.dcm', { type: 'application/dicom' })]);
      ok('the app parses it', n === 1 && files.length === 1);
      const shown = await decodeDicomPixels(files[0].dict, 0, { meta: files[0].meta });
      const ref = await previewBitmapPixels(new Blob([src], { type: 'image/jpeg' }));
      ok('and decodes it', !!shown && !shown.error && shown.rows === 64 && shown.cols === 96, shown && (shown.error || `${shown.rows}x${shown.cols}`));
      let diff = 0;
      if (shown?.pixels) for (let i = 0; i < ref.imgData.data.length; i++) diff = Math.max(diff, Math.abs(shown.pixels[i] - ref.imgData.data[i]));
      ok('to the same pixels as the original JPEG', !!shown?.pixels && diff === 0, `max difference ${diff}`);
    }

    // ---- PNG: uncompressed RGB, never lossy ------------------------------------------
    {
      reset();
      change($('cdKind'), 'eye');
      $('cdEyeDevice').value = 'external';
      const c = picture(40, 30);
      const png = new File([await blobOf(c, 'image/png')], 'face_left.png', { type: 'image/png' });
      addCreateImages([png]);
      ok('a PNG named "left" is a left eye', createImages[0]?.eye === 'L');
      const [res] = await outputs();
      const msg = DicomMessage.readFile(res.buf);
      const d = msg.dict;
      ok('PNG: Explicit VR Little Endian, RGB', str(msg.meta, '00020010') === '1.2.840.10008.1.2.1' && str(d, '00280004') === 'RGB');
      ok('PNG: Lossy Image Compression 00 and no ratio', str(d, '00282110') === '00' && lookupTag(d, '00282112') == null);
      ok('external camera: CID 4202 External Camera, region Eye',
         str(lookupTag(d, '00220015').Value[0], '00080100') === '409903006' && str(lookupTag(d, '00082218').Value[0], '00080100') === '81745001');
      ok('no Pixel Spacing off a fundus camera', lookupTag(d, '00280030') == null);
      const px = new Uint8Array(lookupTag(d, '7fe00010').Value[0]);
      const rgba = c.getContext('2d').getImageData(0, 0, 40, 30).data;
      let bad = 0;
      for (let i = 0; i < 40 * 30; i++) for (let k = 0; k < 3; k++) if (px[i * 3 + k] !== rgba[i * 4 + k]) bad++;
      ok('PNG: the pixels are the picture\'s', bad === 0, `${bad} samples differ`);
      ok('PNG: the validator finds no errors', !validateDicom(d, msg.meta).some(i => i.sev === 'error'));
    }

    // ---- what a camera adds around the picture stays out of the file -------------------
    {
      // EXIF (Orientation 1, so it is kept), a comment, and a second picture after EOI the way
      // phones append MPF previews. The fragment must be the canvas JPEG again, exactly.
      const comment = [...'Dr. Who, room 4'].map(c => c.charCodeAt(0));
      const exif = withExif(src, 1, '2026:03:04 05:06:07');
      const tagged = new Uint8Array([0xFF, 0xD8, 0xFF, 0xFE, 0, comment.length + 2, ...comment, ...exif.subarray(2),
        0xFF, 0xD8, 0xFF, 0xDB, 0, 2, 0x12, 0x34, 0xFF, 0xD9]);
      reset();
      change($('cdKind'), 'eye');
      $('cdEyeDevice').value = 'slitlamp';
      addCreateImages([await jpegFile('tagged_OD.jpg', tagged)]);
      const [res] = await outputs();
      const msg = DicomMessage.readFile(res.buf);
      ok('a tagged baseline JPEG is still kept as JPEG Baseline', str(msg.meta, '00020010') === '1.2.840.10008.1.2.4.50');
      const frag = firstFragment(res.buf);
      const body = frag && (frag.bytes.length === src.length + 1 ? frag.bytes.subarray(0, src.length) : frag.bytes);
      ok('without its EXIF, comment or trailing picture: the scan bytes unchanged', same(body, src),
         frag ? `${frag.bytes.length} vs ${src.length}` : 'no fragment found');
      const has = (u, txt) => { const t = [...txt].map(c => c.charCodeAt(0)); return u.some((_, i) => t.every((b, k) => u[i + k] === b)); };
      ok('no Exif and no comment text left anywhere in the file', !has(new Uint8Array(res.buf), 'Exif\0') && !has(new Uint8Array(res.buf), 'room 4'));
      ok('the EXIF capture time was still read first', str(msg.dict, '0008002A') === '20260304050607', str(msg.dict, '0008002A'));
      const ratio = Number(str(msg.dict, '00282112'));
      ok('the ratio counts only the bytes kept', Math.abs(ratio - 96 * 64 * 3 / src.length) < 0.01, `${ratio}`);
    }

    // ---- JPEGs that cannot be kept as they are ---------------------------------------
    {
      const sof = src.findIndex((b, i) => b === 0xFF && src[i + 1] === 0xC0);
      const prog = src.slice(); prog[sof + 1] = 0xC2;
      ok('the canvas JPEG is baseline, as expected', jpegKeepProblem(inspectJpeg(src)) === '');
      ok('a progressive JPEG is not filed as JPEG Baseline', jpegKeepProblem(inspectJpeg(prog)) !== '');
      const rgbCoded = src.slice();
      for (let i = sof + 10, k = 0; k < 3; i += 3, k++) rgbCoded[i] = [82, 71, 66][k];
      ok('nor an RGB-coded one (OP lossy colour must be YBR_FULL_422)', jpegKeepProblem(inspectJpeg(rgbCoded)) !== '');
      ok('a PNG is not a JPEG at all', inspectJpeg(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0, 0])) === null);

      const turned = withExif(src, 6, '2026:03:04 05:06:07');
      const j = inspectJpeg(turned);
      ok('EXIF Orientation and capture time are read', j.orientation === 6 && j.taken === '20260304050607', `${j.orientation} ${j.taken}`);
      ok('a JPEG turned only by EXIF is not kept (viewers ignore EXIF)', jpegKeepProblem(j) !== '');
      reset();
      change($('cdKind'), 'eye');
      $('cdEyeDevice').value = 'slitlamp';
      addCreateImages([await jpegFile('turned_OS.jpg', turned)]);
      const [res] = await outputs();
      const msg = DicomMessage.readFile(res.buf);
      const d = msg.dict;
      ok('it is stored decoded, upright', str(msg.meta, '00020010') === '1.2.840.10008.1.2.1' &&
         str(d, '00280010') === '96' && str(d, '00280011') === '64', `${str(d, '00280010')}x${str(d, '00280011')}`);
      ok('and still says it was lossy once', str(d, '00282110') === '01' && str(d, '00282114') === 'ISO_10918_1');
      ok('the camera\'s capture time becomes Acquisition DateTime', str(d, '0008002A') === '20260304050607' &&
         str(d, '00080022') === '20260304' && str(d, '00080032') === '050607', str(d, '0008002A'));
    }

    // ---- prefill from the URL hash ----------------------------------------------------
    {
      reset();
      ok('an unrelated hash is not an order', parseCreateHash('#sample=ct') === null && parseCreateHash('#selftest') === null);
      ok('"#create" alone is one', !!parseCreateHash('#create'));
      ok('a query string is not (it reaches the server log)', parseCreateHash('?create=eye&patient_id=1') === null);
      const UID = '1.2.826.0.1.3680043.10.743.9.1';
      const p = parseCreateHash('#create=eye&patient_name=DOE%5EJANE&patient_id=P-77&patient_birthdate=1980-01-02' +
        '&patient_sex=F&accession=ACC123&study_desc=Fundus%20photos&procedure_id=RP9&sps_id=SPS9' +
        `&study_uid=${UID}&referring=HOUSE%5EGREG`);
      switchTab('overview');
      applyCreatePrefill(p);
      ok('the order opens Create', activeTab === 'create');
      ok('in Eye photo mode', createKind === 'eye' && !$('cdEyeCard').classList.contains('hidden'));
      ok('with the patient filled in', $('cdPatientName').value === 'DOE^JANE' && $('cdPatientID').value === 'P-77' &&
         $('cdPatientDOB').value === '1980-01-02' && $('cdPatientSex').value === 'F',
         [$('cdPatientName').value, $('cdPatientID').value, $('cdPatientDOB').value, $('cdPatientSex').value].join(' | '));
      ok('and the study', $('cdAccession').value === 'ACC123' && $('cdStudyDesc').value === 'Fundus photos' &&
         $('cdReferring').value === 'HOUSE^GREG');
      ok('and says it is adding to an ordered study', !$('cdOrder').classList.contains('hidden') && $('cdOrderUID').textContent === UID);
      ok('the ordered patient\'s name and ID cannot be typed over', $('cdPatientName').readOnly && $('cdPatientID').readOnly);
      $('cdEyeDevice').value = 'external';
      addCreateImages([await jpegFile('x_OU.jpg', src)]);
      const [res] = await outputs();
      const d = DicomMessage.readFile(res.buf).dict;
      ok('the photo joins the ordered study', str(d, '0020000D') === UID, str(d, '0020000D'));
      ok('with its accession and referring physician', str(d, '00080050') === 'ACC123' && str(d, '00080090') === 'HOUSE^GREG');
      const rq = lookupTag(d, '00400275')?.Value?.[0];
      ok('and the order in Request Attributes', !!rq && str(rq, '00401001') === 'RP9' && str(rq, '00400009') === 'SPS9' &&
         str(rq, '00321060') === 'Fundus photos' && str(rq, '00080050') === 'ACC123');
      ok('both eyes from "OU"', str(d, '00200062') === 'B');

      $('cdOrderClear').click();
      ok('"Make a new study instead" drops the order', $('cdOrder').classList.contains('hidden') &&
         !$('cdPatientName').readOnly && !$('cdPatientID').readOnly);
      const [again] = await outputs();
      const d2 = DicomMessage.readFile(again.buf).dict;
      ok('and the next file starts a new study', str(d2, '0020000D') !== UID && lookupTag(d2, '00400275') == null);

      // Anonymize or Randomize is another patient: nothing of the order may follow.
      for (const btn of ['cdAnonymizeBtn', 'cdRandomizeBtn']) {
        applyCreatePrefill(p);
        $(btn).click();
        const [r] = await outputs();
        const da = DicomMessage.readFile(r.buf).dict;
        ok(`${btn}: the order is dropped`, $('cdOrder').classList.contains('hidden') && str(da, '0020000D') !== UID &&
           lookupTag(da, '00400275') == null && !str(da, '00080050') && !str(da, '00080090'),
           [str(da, '0020000D'), str(da, '00080050'), str(da, '00080090')].join(' | '));
      }

      applyCreatePrefill(parseCreateHash('#create=eye&patient_id=P-78&sps_id=SPS7'));
      const [sp] = await outputs();
      const rs = lookupTag(DicomMessage.readFile(sp.buf).dict, '00400275')?.Value?.[0];
      ok('an order with only an SPS ID still names a Requested Procedure ID (1C), as the worklist does',
         !!rs && str(rs, '00401001') === 'SPS7' && str(rs, '00400009') === 'SPS7', rs && str(rs, '00401001'));

      applyCreatePrefill(parseCreateHash('#create&referring=HOUSE%5EGREG&study_uid=1.02.3'));
      ok('a referring physician without a valid order is shown, and can be changed',
         $('cdOrder').classList.contains('hidden') && $('cdReferring').value === 'HOUSE^GREG' && !$('cdReferring').readOnly);

      const bad = applyCreatePrefill(parseCreateHash('#create&patient_id=' + 'X'.repeat(65) +
        '&patient_sex=X&patient_birthdate=1980-13&study_uid=1.02.3&accession=OK1'));
      ok('values that do not fit are dropped, not cut', !('patient_id' in bad) && !('patient_sex' in bad) &&
         !('patient_birthdate' in bad) && !('study_uid' in bad) && bad.accession === 'OK1', JSON.stringify(bad));
      ok('so the form shows none of them', $('cdPatientID').value === '' && $('cdPatientSex').value === '' && $('cdOrder').classList.contains('hidden'));
      ok('"#create" without =eye keeps the current mode', createKind === 'eye');
    }

    // ---- prefill over the Carino Bridge ------------------------------------------------
    {
      reset();
      const order = new File([JSON.stringify({ carinoCreate: 1, kind: 'eye', patient_id: 'B-1', study_uid: '1.2.3.4' })],
        'visit.carino-create.json', { type: 'application/json' });
      const took = await takeCreateHandoff([order, await jpegFile('left_eye_OS.jpg', src)]);
      ok('a bridge delivery with an order is taken by Create', took === true);
      ok('the order fills the form', $('cdPatientID').value === 'B-1' && createOrder.studyUID === '1.2.3.4' && createKind === 'eye');
      ok('the photos beside it are added, eye from the name', createImages.length === 1 && createImages[0].eye === 'L');
      ok('a delivery of DICOM files is left to the editor',
         await takeCreateHandoff([new File([opBuf], 'study.dcm', { type: 'application/dicom' })]) === false);
      let threw = false;
      try { await takeCreateHandoff([new File(['{"kind":"eye"}'], 'x.carino-create.json')]); } catch (_) { threw = true; }
      ok('an order without the carinoCreate marker is refused', threw);
    }

    // ---- the files go back to the worklist that sent the order ------------------------
    // A stand-in worklist in a same-origin frame plays window.opener: it answers what Create
    // posts the way Carino DICOM's dashboard does, ok or refused.
    {
      reset();
      const frame = document.createElement('iframe');
      frame.style.display = 'none';
      frame.srcdoc = '<script>window.got = []; window.answer = { ok: true };' +
        'addEventListener("message", (e) => { const d = e.data; if (!d || d.carinoCreate !== "files") return;' +
        ' got.push({ origin: e.origin, d }); setTimeout(() => parent.postMessage({ carinoCreate: "stored",' +
        ' reply: d.reply, ok: answer.ok, message: answer.message }, "*"), 20); });<\/script>';
      document.body.appendChild(frame);
      await new Promise(r => { frame.onload = r; });
      const worklist = frame.contentWindow;
      const realOpener = window.opener;
      window.opener = worklist;
      const UID = '1.2.826.0.1.3680043.10.743.9.2';
      const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
      const orderFile = (extra) => new File([JSON.stringify({ carinoCreate: 1, kind: 'eye', patient_id: 'W-1',
        patient_name: 'DOE^JANE', study_uid: UID, ...extra })], 'o.carino-create.json', { type: 'application/json' });
      const press = async () => {
        createDicomBtn.click();
        await tick();
        for (let i = 0; i < 400 && createDicomBtn.disabled; i++) await new Promise(r => setTimeout(r, 10));
      };
      try {
        await takeCreateHandoff([orderFile({ reply: TOKEN })]);
        ok('without the bridge\'s origin there is no way back', createReturn === null);
        await takeCreateHandoff([orderFile({ reply: 'short' })], { origin: location.origin });
        ok('a malformed reply token is ignored', createReturn === null);
        await takeCreateHandoff([orderFile({ reply: TOKEN, study_uid: '' })], { origin: location.origin });
        ok('a reply without an ordered study is ignored (it would send a new study back)', createReturn === null);

        await takeCreateHandoff([orderFile({ reply: TOKEN }), await jpegFile('W1_OS.jpg', src)], { origin: location.origin });
        $('cdEyeDevice').value = 'external';
        ok('an order with a reply token sends its files back', !!createReturn && createReturn.token === TOKEN &&
           !$('cdReturn').classList.contains('hidden'));
        ok('and the button says so', createDicomBtn.dataset.i18nKey === '⬆ Create and send back');
        downloads = [];
        // A message with the right token from anyone but the worklist is not its answer.
        setTimeout(() => window.postMessage({ carinoCreate: 'stored', reply: TOKEN, ok: false, message: 'forged' }, '*'), 5);
        await press();
        const got = worklist.got;
        ok('Create posts the files to the worklist, nothing is downloaded', got.length === 1 && downloads.length === 0,
           `${got.length} posted, ${downloads.length} downloaded`);
        const sent = got[0] && got[0].d;
        ok('with the token, at this page\'s origin only', !!sent && sent.reply === TOKEN && got[0].origin === location.origin);
        const f = sent && sent.files && sent.files[0];
        // The frame's own ArrayBuffer (structured clone), so not instanceof this page's.
        const sd = f && Object.prototype.toString.call(f.body) === '[object ArrayBuffer]' ? DicomMessage.readFile(f.body.slice(0)).dict : null;
        ok('each file is a named Part 10 buffer in the ordered study', !!sd && /\.dcm$/.test(f.name) &&
           f.type === 'application/dicom' && str(sd, '0020000D') === UID && str(sd, '00100020') === 'W-1' &&
           str(sd, '00200062') === 'L', f && `${f.name} ${f.type} ${sd && str(sd, '0020000D')}`);
        ok('a forged answer from another window is ignored', $('cdBlock').classList.contains('hidden'));
        ok('once filed, the order is let go', createReturn === null && $('cdOrder').classList.contains('hidden') &&
           createDicomBtn.dataset.i18nKey === '⬇ Create DICOM');

        // Refused (signed out, order closed): nothing downloaded, said beside the button, retry possible.
        await takeCreateHandoff([orderFile({ reply: TOKEN })], { origin: location.origin });
        worklist.answer = { ok: false, message: 'order is already closed' };
        downloads = [];
        await press();
        ok('a refusal is said beside the button', !$('cdBlock').classList.contains('hidden') &&
           $('cdBlock').textContent.includes('order is already closed'), $('cdBlock').textContent);
        ok('and keeps the way back for a retry', !!createReturn && downloads.length === 0);

        // The worklist window is gone: the files are downloaded as they would be without it.
        frame.remove();
        downloads = [];
        await press();
        ok('a closed worklist window means a download instead', downloads.length === 1 && createReturn === null,
           `${downloads.length} downloaded`);
      } finally {
        window.opener = realOpener;
        frame.remove();
        reset();
      }
      const RETURN_STRINGS = ['⬆ Create and send back',
        'The files go back to the worklist that sent this order instead of being downloaded.',
        'The worklist refused the files.', 'No answer from the worklist window.',
        'The worklist window was closed, so the files were downloaded instead.', 'Sending…',
        'Sent {n} file(s) back to the worklist.', 'Not sent: {err}. Press the button again to try again.'];
      for (const loc of ['es', 'pt-BR', 'ja', 'ru']) {
        const missing = RETURN_STRINGS.filter(k => !I18N[loc] || !I18N[loc][k] ||
          ['{n}', '{err}'].some(ph => k.includes(ph) && !I18N[loc][k].includes(ph)));
        ok(`i18n: the send-back strings are translated into ${loc}`, missing.length === 0, missing.join(' | '));
      }
    }

    // ---- every new string in all four locales -----------------------------------------
    {
      const NEW_STRINGS = [
        'File type', 'Picture (Secondary Capture)', 'Eye photo (Ophthalmic Photography)', 'Eye photos', 'Camera',
        'Fundus camera', 'Slit lamp', 'External eye camera', 'Field of view (degrees)',
        'Printed on the camera or in its manual, often 45 or 50. Fundus photos need it.',
        "The photos show the patient's name or the date",
        'Choose Right, Left or Both on every photo. A file name with OD, OS, OU, right or left fills it in.',
        'Accession Number', 'Referring Physician', 'Adding to an ordered study', 'Make a new study instead',
        'Which eye?', 'Right (OD)', 'Left (OS)', 'Both (OU)',
        'Choose Right, Left or Both on every eye photo first. {n} still need one.',
        "Enter the camera's field of view in degrees. Fundus photos need it to record the pixel size.",
        'The order sent to Create could not be read.',
      ];
      for (const loc of ['es', 'pt-BR', 'ja', 'ru']) {
        const missing = NEW_STRINGS.filter(s => !I18N[loc] || !I18N[loc][s] || (s.includes('{n}') && !I18N[loc][s].includes('{n}')));
        ok(`i18n: every eye-photo string is translated into ${loc}`, missing.length === 0, missing.join(' | ').slice(0, 160));
      }
      ok('Japanese says PC if it says computer at all',
         !NEW_STRINGS.some(s => /コンピューター/.test(I18N.ja[s] || '')));
    }
  } catch (e) {
    ok('suite ran to completion', false, (e && e.stack) || String(e));
  } finally {
    HTMLAnchorElement.prototype.click = realClick;
    try { if (prevFov === null) localStorage.removeItem('dcm-create-fov'); else localStorage.setItem('dcm-create-fov', prevFov); } catch (_) {}
    try { reset(); } catch (_) {}
  }
  return out;
};

// Two callers: tests/run.sh injects this file alone and scrapes the <pre> below;
// index.html#selftest sets window.SELFTEST and awaits the returned lines instead.
if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.eyephoto()).join('\n');
  document.body.appendChild(pre);
});
