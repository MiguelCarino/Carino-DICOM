// Compression detection (js/compression.js) and the way back to uncompressed.
//
// The codestreams below were encoded once, outside the app, from a synthetic 32x32 signed "CT" slice
// (-2000 padding outside a circle, as scanners write it; no patient ever existed):
//   JLS_S16        CharLS via pyjpegls, NEAR = 0, the signed samples' bit patterns as 16-bit (MAXVAL 65535)
//   JLS_S16_NEAR3  same, NEAR = 3
//   J2K_U16_LOSSY  OpenJPEG via pylibjpeg-openjpeg, 9/7 irreversible wavelet, 8:1, of the slice + 2000
//   LJ_PT0 / LJ_PT2  libjpeg-turbo 3.1 `cjpeg -precision 16 -lossless 1[,2]` of an unsigned 32x32 ramp,
//                  ((x*97 + y*61) % 4000) + 7: without and with point transform Pt = 2
// SIGNED_REF_B64 is the slice itself (little-endian int16), the oracle for "decompress gives back
// exactly the original values".
(window.SUITES || (window.SUITES = {})).compression = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const $ = (id) => document.getElementById(id);
  const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
  const b64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const ROOT = '1.2.826.0.1.3680043.10.99999.72.';
  const JLS_S16 = '/9j/9wALEAAgACABAREA//gADQH//wASAEMBFABA/9oACAEBAAAAAA89ACAIAgEAgEAgICAgICAgICBAgQIECBAgQIECBAgQIAf/dBBvNJJJJJIAAAAAAACMMXIQVwFgNACAIAgEAgEAAI0QwAAAAAAAIw2cGB+AcBIBAQEBAQEBAQECAGHKEAAAAXe7AzAUCBAgQIECBAgQIECBADD4AAABe7MCcBQIIIIIIIIIIIIIIIIAxAAAT/VgNgEEEEEEEEEEEEEEEEEEIAxCAAUHRgHgEIQhCEIQhCEIQhCEIQBiIAAofCAEIQhCEIQhCIiIiIiIgEAu2AGAREAAAAAAAAhG/ACAIAgABwYYYYYYYYYYYYYYBiMAAou4AhhhgIBsQBDDDDDDDDDDDDDDAQDaX+4BGMYCAXEAjGMYxjGMYxjGAESQEj6gEYxjAQG1AIxjGMYxjGMYxmAgNxAJmZgIDagJmZmZmZmZmYEBeICZmYCOuC0FoLQDATMzMzMzMzMwICcQE2222222222222BAPiAtttttttttttt+BAPiA/9//3/wAAAAAAAQjOgLAMLegggggQD4gIIIIIIQhCEIQhCECZEATAQhCBAPmAhCEIQhCEIQhCEAMAFQIQgAAAAAAAEYnIAzAiIiIiIiIiIgDABUCIgUA+IERERERERERAFGOTYWN+AEgAAAGVgGIEkkkkkkkgFGbAiCoAkgSAPMCSSSSSSqqoACjYBqBVVVVVVAAULANwKr/3AAn2AeED//QI6wHKB/8AAAAAAAEYcoAQGkCCgoKChQoQAAAAAAAIwyQBAf4P/Z';
  const JLS_S16_NEAR3 = '/9j/9wALEAAgACABAREA//gADQH//wAbAFIBKQBA/9oACAEBAAMAABPIBAQIEEEEEEIQhCEIQiIiIiIiIiAf/1Bd6iIqQAAAAAAABDfOTdYDAIAUAwAYBGAgAAAAAAAAhv3AXOBgICAQCgECAgQCAiAAAACHmLnAggQQIFAIIIKAYAMIAAQ+hc4CCEEIIKAQggoCEAcIAAQ+W4wVAQhCCgIQiICEQBwwABDgEBAgU3GBEQEIhEQIhEQIREA4QAAh8QIhQIiIiBERECIiICAdtvgxDosAgEBAB/YBgEREgRIkBwwCDggsCRIEA5AiRIkgiRGAYAxt8EiQQBBBBAIFoCSSQSSSA4YBC5BJJBAOIJEEkQSSSQQDiCSSCA1BIgkiCASSSCAQiCSSCiwkJBQIpEEoggKIKEBhEEogkCiCiCiAYCBRBQgGIQUQkFEKIUQkFEKEAxCCiEgohRCgAAAjAYAYUpChAMQhRBhSFISn0FhIUIDCwpCQpCkKEAyEhAAAAAAAAIcNBsKQkMhkMCAYhIQIBiChIYhiGBQTEhQ4BgAAAAngxBQYZDIaAKDBQoCEQEA7haMQxDELRAAAACWDqGioYjEURACFg7iioxGIYgYOHxFUVGIoGBh6hRUVAAAAAAAACHAQCH4RFRIv0BKEP/D/2Q==';
  const J2K_U16_LOSSY = '/0//UQApAAAAAAAgAAAAIAAAAAAAAAAAAAAAIAAAACAAAAAAAAAAAAABDwEB/1IADAAAAAEABQQEAAD/XAAjQrcgtvC28LbArwCvAK7gp1CnUKdokAWQBZBHl9OX05di/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS4y/5AACgAAAAAAhQAB/5PH/lAGCfSrwD6QUA+kFAB/YCAC9wL8BbjAPjCQD4BIA+AMCliamwumUQIDlGHAdFgPiEQD4CAgP4Ei9hqhCyAWnHgqJFKFygFeqNXA+AuB8BQ5Zps2QzG0u9Bwp03Csy13cfcx8imgOnCnbi6Jr9kiIVI3JfGwJ//Z';
  const LJ_PT0 = '/9j/4AAQSkZJRgABAQAAAQABAAD/wwALEAAgACABAREA/8QAFwABAQEBAAAAAAAAAAAAAAAABwYMD//aAAgBAQABAADgAMwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCw3rCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLDesLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsN6wsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCw3rCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLDesLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsN6wsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCw3rCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLDesLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsN6wsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCw3rCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLDesLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsN6wsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCw3rCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLDesLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsN6wsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCw3rCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLDesLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCw4MC9YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWHBgMN6wsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsODAYb1hYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhwYDCw3rCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLDgwGFhvWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYcGAwsLDesLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLDgwGFhYWG9YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWHBgMLCwsN6wsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCw4MBhYWFhYb1hYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWHBgMLCwsLCw3rCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsODAYWFhYWFhvWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhwYDCwsLCwsLDesLCwsLCwsLCwsLCwsLCwsLCwsLCwsODAYWFhYWFhYWG9YWFhYWFhYWFhYWFhYWFhYWFhYWFhYcGAwsLCwsLCwsN6wsLCwsLCwsLCwsLCwsLCwsLCwsLDgwGFhYWFhYWFhYf/9k=';
  const LJ_PT2 = '/9j/4AAQSkZJRgABAQAAAQABAAD/wwALEAAgACABAREA/8QAFwABAQEBAAAAAAAAAAAAAAAABQQKDf/aAAgBAQABAALgADLDDDLDDDLDDDLDDDLDDDLDDDLDDDLDCDDDDLDDDLDDDLDDDLDDDLDDDLDDDLDDF7DDLDDDLDDDLDDDLDDDLDDDLDDDLDDDN7DLDDDLDDDLDDDLDDDLDDDLDDDLDDDLF7LDDDLDDDLDDDLDDDLDDDLDDDLDDDLDCDDDDLDDDLDDDLDDDLDDDLDDDLDDDLDDF7DDLDDDLDDDLDDDLDDDLDDDLDDDLDDDN7DLDDDLDDDLDDDLDDDLDDDLDDDLDDDLF7LDDDLDDDLDDDLDDDLDDDLDDDLDDDLDCDDDDLDDDLDDDLDDDLDDDLDDDLDDDLDDF7DDLDDDLDDDLDDDLDDDLDDDLDDDLDDDN7DLDDDLDDDLDDDLDDDLDDDLDDDLDDDLF7LDDDLDDDLDDDLDDDLDDDLDDDLDDDLDCDDDDLDDDLDDDLDDDLDDDLDDDLDDDLDDF7DDLDDDLDDDLDDDLDDDLDDDLDDDLDDDN7DLDDDLDDDLDDDLDDDLDDDLDDDLDDDLF7LDDDLDDDLDDDLDDDLDDDLDDDLDDDLDCDDDDLDDDLDDDLDDDLDDDLDDDLDDDLDGC+9hhlhhhlhhhlhhhlhhhlhhhlhhhlhjBezewywwwywwwywwwywwwywwwywwwywwxgwYvZYYYZYYYZYYYZYYYZYYYZYYYZYYYwYMMIMMMMsMMMsMMMsMMMsMMMsMMMsMMM4L2GL2GGWGGGWGGGWGGGWGGGWGGGWGGGcF7DDN7DLDDDLDDDLDDDLDDDLDDDLDDDOC9hhli9lhhhlhhhlhhhlhhhlhhhlhhhljBewywwgwwwywwwywwwywwwywwwywwwyxgvYZYYYvYYZYYYZYYYZYYYZYYYZYYYZYwXsMsMMM3sMsMMMsMMMsMMMsMMMsMMMsMYL2WGGGWL2WGGGWGGGWGGGWGGGWGGGWGMF7LDDDLDCDDDDLDDDLDDDLDDDLDDDLDGC9lhhhlhhi9hhlhhhlhhhlhhhlhhhlhhjBgwwwywwwzewywwwywwwywwwywwwywwxgwYYYZYYYZY//2Q==';
  const SIGNED_REF_B64 = 'MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPhMBE8EUgRVBFgEWwReBGEEMPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPhGBEkETARPBFIEVQRYBFsEXgRhBGQEZwQw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPhABEMERgRJBEwETwRSBFUEWARbBF4EYQRkBGcEagRtBDD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+D0EQARDBEYESQRMBE8EUgRVBFgEWwReBGEEZARnBGoEbQRwBDD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4OgQ9BEAEQwRGBEkETARPBFIEVQRYBFsEXgRhBGQEZwRqBG0EcARzBDD4MPgw+DD4MPgw+DD4MPgw+DD4MPg3BDoEPQRABEMERgRJBEwETwRSBFUEWARbBF4EYQRkBGcEagRtBHAEcwR2BDD4MPgw+DD4MPgw+DD4MPgw+DQENwQ6BD0EQARDBEYESQRMBE8EUgRVBFgEWwReBGEEZARnBGoEbQRwBHMEdgR5BDD4MPgw+DD4MPgw+DD4MPg0BDcEOgQ9BEAEQwRGBEkETARPBFIEVQRYBFsEXgRhBGQEZwRqBG0EcARzBHYEeQQw+DD4MPgw+DD4MPgw+DEENAQ3BDoEPQSwCLAIsAiwCLAITwRSBFUEWARbBF4EYQRkBGcEagRtBHAEcwR2BHkEfAQw+DD4MPgw+DD4MPgxBDQENwQ6BD0EsAiwCLAIsAiwCE8EUgRVBFgEWwReBGEEZARnBGoEbQRwBHMEdgR5BHwEMPgw+DD4MPgw+C4EMQQ0BDcEOgQ9BLAIsAiwCLAIsAhPBFIEVQRYBFsEXgRhBGQEZwRqBG0EcARzBHYEeQR8BH8EMPgw+DD4MPguBDEENAQ3BDoEPQSwCLAIsAiwCLAITwRSBFUEWARbBF4EYQRkBGcEagRtBHAEcwR2BHkEfAR/BDD4MPgw+DD4LgQxBDQENwQ6BD0EsAiwCLAIsAiwCE8EUgRVBFgEWwReBGEEZARnBGoEbQRwBHMEdgR5BHwEfwQw+DD4MPgw+C4EMQQ0BDcEOgQ9BEAEQwRGBEkETARPBFIEVQRYBFsEXgRhBGQEZwRqBG0EcARzBHYEeQR8BH8EMPgw+DD4MPguBDEENAQ3BDoEPQRABEMERgRJBEwETwRSBFUEWARbBF4EYQRkBGcEagRtBHAEcwR2BHkEfAR/BDD4MPgw+DD4LgQxBDQENwQ6BD0EQARDBEYESQRMBE8EUgRVBFgEWwReBGEEZARnBGoEbQRwBHMEdgR5BHwEfwQw+DD4MPgw+C4EMQQ0BDcEOgQ9BEAEQwRGBEkETARPBFIEVQRYBFsEXgRhBGQEAAAAAAAAcARzBHYEeQR8BH8EMPgw+DD4MPguBDEENAQ3BDoEPQRABEMERgRJBEwETwRSBFUEWARbBF4EYQQAAAAAAAAAAAAAcwR2BHkEfAR/BDD4MPgw+DD4MPgxBDQENwQ6BD0EQARDBEYESQRMBE8EUgRVBFgEWwReBGEEAAAAAAAAAAAAAHMEdgR5BHwEMPgw+DD4MPgw+DD4MQQ0BDcEOgQ9BEAEQwRGBEkETARPBFIEVQRYBFsEXgRhBAAAAAAAAAAAAABzBHYEeQR8BDD4MPgw+DD4MPgw+DD4NAQ3BDoEPQRABEMERgRJBEwETwRSBFUEWARbBF4EYQRkBAAAAAAAAHAEcwR2BHkEMPgw+DD4MPgw+DD4MPgw+DQENwQ6BD0EQARDBEYESQRMBE8EUgRVBFgEWwReBGEEZARnBGoEbQRwBHMEdgR5BDD4MPgw+DD4MPgw+DD4MPgw+DcEOgQ9BEAEQwRGBEkETARPBFIEVQRYBFsEXgRhBGQEZwRqBG0EcARzBHYEMPgw+DD4MPgw+DD4MPgw+DD4MPgw+DoEPQRABEMERgRJBEwETwRSBFUEWARbBF4EYQRkBGcEagRtBHAEcwQw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+D0EQARDBEYESQRMBE8EUgRVBFgEWwReBGEEZARnBGoEbQRwBDD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+EAEQwRGBEkETARPBFIEVQRYBFsEXgRhBGQEZwRqBG0EMPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4RgRJBEwETwRSBFUEWARbBF4EYQRkBGcEMPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPhMBE8EUgRVBFgEWwReBGEEMPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPgw+DD4MPg=';

  const ref = new Int16Array(b64(SIGNED_REF_B64).buffer);
  const ct = (cfg) => Forge.build({ rows: 32, cols: 32, pi: 'MONOCHROME2', ba: 16, bs: 16, hb: 15, pr: 1,
    modality: 'CT', sopClass: '1.2.840.10008.5.1.4.1.1.2', intercept: -1024, slope: 1,
    studyUID: ROOT + '1', seriesUID: ROOT + '1.1', sopInstance: ROOT + '1.1.' + (cfg.n || 1), instance: cfg.n || 1, ...cfg });
  const load = async (...list) => { await handleFiles(list.map((b, i) => new File([b], `c${i}.dcm`))); return files; };
  const reread = (entry) => { const u = buildEditedBytes(entry); const m = DicomMessage.readFile(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)); normBin(m.dict); return m; };
  const ts = (m) => String(m.meta['00020010']?.Value?.[0] || '').trim();
  const samples = (d) => { const v = lookupTag(d, '7fe00010').Value[0]; const b = v.buffer ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v; return new Int16Array(b, 0, 32 * 32); };

  try {
    // ---- detection ---------------------------------------------------------
    await load(
      ct({ n: 1, ts: '1.2.840.10008.1.2.4.80', encapsulated: [b64(JLS_S16)] }),
      ct({ n: 2, ts: '1.2.840.10008.1.2.4.81', encapsulated: [b64(JLS_S16_NEAR3)] }),
      ct({ n: 3, ts: '1.2.840.10008.1.2.4.81', encapsulated: [b64(JLS_S16)] }),
      ct({ n: 4, ts: '1.2.840.10008.1.2.4.91', pr: 0, intercept: -3024, encapsulated: [b64(J2K_U16_LOSSY)] }),
      ct({ n: 5, pixels: ref, wc: 40, ww: 400 }),
    );
    const by = (n) => files.find(f => String(lookupTag(f.dict, '00200013')?.Value?.[0]) === String(n));
    const i1 = compressionInfo(by(1)), i2 = compressionInfo(by(2)), i3 = compressionInfo(by(3)),
          i4 = compressionInfo(by(4)), i5 = compressionInfo(by(5));
    ok('JPEG-LS Lossless is detected as compressed and lossless', i1.compressed && i1.lossless === true, compressionLabel(i1));
    ok('JPEG-LS .81 with NEAR = 3 in the codestream is lossy', i2.lossless === false && i2.why.some(w => /3/.test(w)), compressionLabel(i2));
    ok('JPEG-LS .81 with NEAR = 0 in the codestream is lossless (the syntax only allows loss)', i3.lossless === true, compressionLabel(i3));
    ok('JPEG 2000 .91 with the 9/7 wavelet is lossy', i4.lossless === false, compressionLabel(i4));
    ok('uncompressed is not compressed and lossless', !i5.compressed && i5.lossless === true, compressionLabel(i5));
    ok('a compression ratio is computed for encapsulated data', i1.ratio > 1, String(i1.ratio));
    ok('signed compressed pixels warn about viewers that misread them', i1.warnings.some(w => /white surround/.test(w)));
    ok('no Window Center/Width is warned about', i1.warnings.some(w => /Window Center/.test(w)));
    ok('uncompressed with a window has no warnings', i5.warnings.length === 0, i5.warnings.join(' | '));
    ok('the label names the syntax, the verdict and the ratio', /^JPEG-LS Lossless · lossless · \d+\.\d:1$/.test(compressionLabel(i1)), compressionLabel(i1));

    // (0028,2110) = 01 on a lossless-stored file means it was lossy once.
    const once = by(5);
    setTag(once.dict, '00282110', 'CS', '01');
    ok('Lossy Image Compression = 01 is reported as previously lossy', /previously lossy/.test(compressionLabel(compressionInfo(once))));
    delTag(once.dict, '00282110');

    // ---- compare: same pixels, different encoding --------------------------
    const cmp = await comparePixels(by(1), by(5));
    ok('compare: JPEG-LS and uncompressed copies have identical decoded pixels', cmp.same === true, JSON.stringify(cmp));
    const cmpLossy = await comparePixels(by(2), by(5));
    ok('compare: the NEAR = 3 copy differs by at most 3', !cmpLossy.same && cmpLossy.max <= 3 && cmpLossy.max > 0, JSON.stringify(cmpLossy));

    // ---- Compare bar and its report ----------------------------------------
    {
      await switchFile(files.indexOf(by(1)));
      compareIdx = files.indexOf(by(5));
      renderCompareUI();
      for (let i = 0; i < 40 && !/identical|differ/.test($('cmpPixels').textContent); i++) await tick(50);
      ok('compare bar: decoded pixels are reported identical', /identical after decoding/.test($('cmpPixels').textContent), $('cmpPixels').textContent);
      const rows = [...$('cmpComp').rows].map(r => r.cells[0].textContent);
      ok('compare bar: the differing compression facts are listed', !$('cmpComp').classList.contains('hidden')
         && rows.includes('Transfer syntax') && rows.includes('Ratio') && rows.includes('Pixel Data stored'), rows.join(', '));
      ok('compare bar: facts that agree are left out', !rows.includes('Pixel Representation'), rows.join(', '));
      const tsRow = [...$('cmpComp').rows].find(r => r.cells[0].textContent === 'Transfer syntax');
      ok('compare bar: each side names its syntax', /JPEG-LS Lossless/.test(tsRow?.cells[1].textContent) && /Explicit VR Little Endian/.test(tsRow?.cells[2].textContent));

      const realPrint = window.carinoBrandedPrint;
      let printed = null;
      window.carinoBrandedPrint = arg => { printed = arg; };
      try { printCompareReport(); } finally { window.carinoBrandedPrint = realPrint; }
      const body = printed?.body || '';
      ok('report: has a pixel data & compression section', /Pixel data &amp; compression/.test(body));
      ok('report: carries the decoded-pixel verdict', /identical after decoding/.test(body));
      ok('report: names both encodings and marks the differing rows', /JPEG-LS Lossless/.test(body) && /Explicit VR Little Endian/.test(body) && /class="c-diff"/.test(body));

      // Same encoding on both sides: no rows, one line saying so.
      await switchFile(files.indexOf(by(2))); compareIdx = files.indexOf(by(3)); renderCompareUI();
      for (let i = 0; i < 40 && !/identical|differ/.test($('cmpPixels').textContent); i++) await tick(50);
      ok('compare bar: two near-lossless copies list only what differs', [...$('cmpComp').rows].every(r => r.cells[0].textContent !== 'Transfer syntax'),
         [...$('cmpComp').rows].map(r => r.cells[0].textContent).join(', '));
      compareIdx = null; renderCompareUI();
    }

    // ---- decompress --------------------------------------------------------
    const e1 = by(1), uid1 = String(lookupTag(e1.dict, '00080018').Value[0]);
    const r1 = await decompressDicom(e1);
    ok('decompress: succeeds', !r1.error, r1.error);
    const m1 = reread(e1);
    ok('decompress: exported as Explicit VR Little Endian', ts(m1) === '1.2.840.10008.1.2.1', ts(m1));
    const got = samples(m1.dict);
    ok('decompress: every signed value comes back exactly (padding stays -2000)', got.every((v, i) => v === ref[i]) && got[0] === -2000, `${got[0]} ${got[512]}`);
    ok('decompress: same SOP Instance UID (an encoding change is not a new image)', String(lookupTag(m1.dict, '00080018').Value[0]) === uid1);
    ok('decompress: Pixel Representation stays signed', lookupTag(m1.dict, '00280103').Value[0] === 1);
    ok('decompress: a lossless source is not flagged lossy', !lookupTag(m1.dict, '00282110'));
    ok('decompress: the result is no longer compressed', !compressionInfo(e1).compressed);
    ok('decompress: running it again is refused (already uncompressed)', !!(await decompressDicom(e1)).error);

    const e2 = by(2);
    const r2 = await decompressDicom(e2);
    const m2 = reread(e2);
    ok('decompress lossy: succeeds and reports the lossy source', !r2.error && r2.lossless === false, r2.error);
    ok('decompress lossy: (0028,2110) Lossy Image Compression = 01', String(lookupTag(m2.dict, '00282110')?.Value?.[0]).trim() === '01');
    ok('decompress lossy: (0028,2114) method ISO_14495_1', String(lookupTag(m2.dict, '00282114')?.Value?.[0]).trim() === 'ISO_14495_1');

    // Undo restores the compressed original.
    ok('undo: the image-edit undo brings the JPEG-LS file back', undoPixelTransform(e2) && compressionInfo(e2).ts === '1.2.840.10008.1.2.4.81'
       && !lookupTag(e2.dict, '00282110'));

    // ---- UI ----------------------------------------------------------------
    await switchFile(files.indexOf(by(3)));
    syncImgEditCard();
    ok('card: the compression line names the encoding', /JPEG-LS/.test($('imgCompName').textContent), $('imgCompName').textContent);
    ok('card: Decompress is offered for a compressed file', !$('imgDecompress').classList.contains('hidden') && !$('imgDecompress').disabled);
    ok('card: "All" counts the files that can be converted', /\b3\b/.test($('imgDecompressAll').textContent), $('imgDecompressAll').textContent);
    $('imgDecompressAll').click(); $('confirmOk').click();
    for (let i = 0; i < 50 && files.some(f => compressionInfo(f).compressed); i++) await tick(50);
    ok('card: Decompress all converts every compressed file', files.every(f => !compressionInfo(f).compressed),
       files.map(f => compressionInfo(f).name).join(', '));

    // ---- syntaxes known by name only ---------------------------------------
    {
      const as = (uid) => ({ dict: by(5).dict, meta: { '00020010': { vr: 'UI', Value: [uid] } } });
      const kinds = {
        '1.2.840.10008.1.2.4.110': 'lossless', '1.2.840.10008.1.2.4.111': 'lossy', '1.2.840.10008.1.2.4.112': 'either',
        '1.2.840.10008.1.2.4.102.1': 'video', '1.2.840.10008.1.2.4.106.1': 'video', '1.2.840.10008.1.2.4.108': 'video',
        '1.2.840.10008.1.2.1.98': 'none', '1.2.840.10008.1.2.8.1': 'lossless',
        '1.2.840.10008.1.2.4.94': 'referenced', '1.2.840.10008.1.2.4.205': 'referenced',
        '1.2.840.10008.1.2.4.53': 'lossy', '1.2.840.10008.1.2.4.58': 'lossless', '1.2.840.10008.1.2.4.65': 'either',
        '1.2.840.113619.5.2': 'private', '1.3.46.670589.33.1.4.1': 'private',
      };
      const wrong = Object.entries(kinds).filter(([u, k]) => compressionInfo(as(u)).kind !== k)
        .map(([u, k]) => `${u}: ${compressionInfo(as(u)).kind} ≠ ${k}`);
      ok('newer, fragmentable, retired and private syntaxes are known by kind', !wrong.length, wrong.join('; '));
      ok('JPEG XL JPEG Recompression is lossy (the JPEG it repacks was)', compressionInfo(as('1.2.840.10008.1.2.4.111')).lossless === false);
      ok('JPIP says the pixels are not in the file', compressionInfo(as('1.2.840.10008.1.2.4.94')).why.some(w => /not in this file/.test(w)));
      ok('GE private syntax warns about big-endian pixels', compressionInfo(as('1.2.840.113619.5.2')).warnings.some(w => /big-endian/.test(w)));
      const refuse = (u, re) => { const r = decompressSupport(as(u)); return !r.ok && re.test(r.why) ? '' : `${u}: ${r.ok ? 'ok' : r.why}`; };
      const bad = [refuse('1.2.840.10008.1.2.4.110', /JPEG XL/), refuse('1.2.840.10008.1.2.4.104.1', /H\.264/),
                   refuse('1.2.840.10008.1.2.4.94', /JPIP/), refuse('1.2.840.113619.5.2', /Private/),
                   refuse('1.2.840.10008.1.2.8.1', /Deflated Image Frame/), refuse('1.2.840.10008.1.2.4.62', /retired/)].filter(Boolean);
      ok('decompress refuses undecodable syntaxes with a reason naming them', !bad.length, bad.join('; '));
    }

    // ---- JPEG Lossless point transform -------------------------------------
    {
      const ramp = Uint16Array.from({ length: 1024 }, (_, i) => (((i % 32) * 97 + Math.floor(i / 32) * 61) % 4000) + 7);
      const lj = (cfg) => ct({ pr: 0, intercept: 0, ts: '1.2.840.10008.1.2.4.57', wc: 2000, ww: 4000, ...cfg });
      await load(lj({ n: 11, encapsulated: [b64(LJ_PT0)] }), lj({ n: 12, encapsulated: [b64(LJ_PT2)] }));
      const p0 = compressionInfo(by(11)), p2 = compressionInfo(by(12));
      ok('JPEG Lossless with Pt = 0 is lossless', p0.lossless === true, compressionLabel(p0));
      ok('JPEG Lossless with Pt = 2 is lossy and says why', p2.lossless === false && p2.why.some(w => /Pt = 2/.test(w)), p2.why.join(' | '));
      const pc = await comparePixels(by(11), by(12));
      ok('point transform: values differ by at most 3 (two dropped bits)', !pc.same && pc.max === 3, JSON.stringify(pc));
      const r = await decompressDicom(by(12));
      const v = new Uint16Array(samples(reread(by(12)).dict).buffer, 0, 1024);
      ok('decompress Pt = 2: the decoder output is shifted back (low two bits zero, rest exact)',
         !r.error && v.every((x, i) => x === ((ramp[i] >> 2) << 2)), r.error || `${v[1]} vs ${ramp[1]}`);
      ok('decompress Pt = 2: flagged lossy with method ISO_10918_1',
         String(lookupTag(by(12).dict, '00282110')?.Value?.[0]).trim() === '01'
         && String(lookupTag(by(12).dict, '00282114')?.Value?.[0]).trim() === 'ISO_10918_1');
      await decompressDicom(by(11));
      const v0 = new Uint16Array(samples(reread(by(11)).dict).buffer, 0, 1024);
      ok('decompress Pt = 0: every value exact', v0.every((x, i) => x === ramp[i]));
    }

    // ---- JPEG 2000 signedness vs Pixel Representation ----------------------
    {
      await load(ct({ n: 13, ts: '1.2.840.10008.1.2.4.91', pr: 1, encapsulated: [b64(J2K_U16_LOSSY)] }));
      ok('J2K unsigned codestream with signed Pixel Representation warns', compressionInfo(by(13)).warnings.some(w => /says the samples are unsigned/.test(w)));
      ok('J2K signedness that agrees does not warn', !compressionInfo(by(4)).warnings.some(w => /JPEG 2000 codestream says/.test(w)));
    }

    // ---- rendered or reduced copies ----------------------------------------
    {
      const S2 = ROOT + '2.1';
      const flat8 = new Uint8Array(32 * 32).fill(128);
      await load(
        ct({ n: 14, seriesUID: S2, pixels: ref, wc: 40, ww: 400 }),
        ct({ n: 15, seriesUID: S2, rows: 16, cols: 16, pixels: ref.slice(0, 256), wc: 40, ww: 400 }),
        ct({ n: 16, seriesUID: ROOT + '3.1', ba: 8, bs: 8, hb: 7, pr: 0, intercept: 0, pixels: flat8, wc: 128, ww: 256 }),
        ct({ n: 17, seriesUID: ROOT + '4.1', sopClass: '1.2.840.10008.5.1.4.1.1.7', pixels: ref, wc: 40, ww: 400 }),
      );
      ok('an image smaller than the rest of its series warns', compressionInfo(by(15)).warnings.some(w => /16×16, smaller than others in its series \(32×32\)/.test(w)),
         compressionInfo(by(15)).warnings.join(' | '));
      ok('the full-size image of that series does not', !compressionInfo(by(14)).warnings.some(w => /smaller than others/.test(w)));
      ok('an 8-bit CT warns it is a rendered picture', compressionInfo(by(16)).warnings.some(w => /CT image with only 8-bit pixels/.test(w)));
      ok('a Secondary Capture of a CT warns', compressionInfo(by(17)).warnings.some(w => /Secondary Capture of a CT/.test(w)));
      ok('a normal CT has none of these warnings', compressionInfo(by(14)).warnings.length === 0, compressionInfo(by(14)).warnings.join(' | '));
      const labels = (a, b) => compressionCompareRows(a, b).filter(r => r[3]).map(r => r[0]);
      ok('compare rows: a smaller copy differs in Image size', labels(by(14), by(15)).includes('Image size'), labels(by(14), by(15)).join(', '));
      ok('compare rows: an 8-bit copy differs in Bits Stored', labels(by(14), by(16)).includes('Bits Stored'));
      ok('compare rows: a Secondary Capture differs in SOP Class', labels(by(14), by(17)).includes('SOP Class')
         && /Secondary Capture/.test(compressionCompareRows(by(14), by(17)).find(r => r[0] === 'SOP Class')[2]));
    }

    // ---- Encapsulated Uncompressed (.98) -----------------------------------
    {
      const rawLE = new Uint8Array(ref.buffer.slice(0));
      await load(ct({ n: 18, seriesUID: ROOT + '5.1', ts: '1.2.840.10008.1.2.1.98', encapsulated: [rawLE], wc: 40, ww: 400 }));
      const e = by(18);
      ok('.98 loads and is named', compressionInfo(e).name === 'Encapsulated Uncompressed Explicit VR Little Endian', compressionInfo(e).name);
      const r = await decompressDicom(e);
      ok('.98 unwraps to plain Explicit VR LE with every value exact', !r.error && ts(reread(e)) === '1.2.840.10008.1.2.1'
         && samples(reread(e).dict).every((x, i) => x === ref[i]), r.error);
    }
  } catch (e) {
    ok('compression suite ran without throwing', false, e.stack || e.message);
  }
  return out;
};

if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.compression()).join('\n');
  document.body.appendChild(pre);
}, { once: true });
