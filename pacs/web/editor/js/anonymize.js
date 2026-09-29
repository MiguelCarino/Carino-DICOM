// Tag helpers, anonymize/randomize data, the PS3.15 Basic Confidentiality Profile and pixel redaction.

// ---- Anonymize & randomize ----
// Identity/PHI attributes from PS3.15 Annex E, Table E.1-1 (Basic Application Level
// Confidentiality Profile). Not exhaustive; covers identity, contact and free-text comments.
const PHI = [
  // ---- Patient identity & demographics (group 0010) ----
  'x00100010','x00100020','x00100021','x00100024','x00100030','x00100032',
  'x00100040','x00100050','x00100101','x00100102',
  'x00101000','x00101001','x00101002','x00101005','x00101010','x00101020',
  'x00101030','x00101040','x00101060','x00101080','x00101081','x00101090',
  'x00102000','x00102110','x00102150','x00102160','x00102180',
  'x001021a0','x001021b0','x001021c0','x001021d0','x001021f0',
  'x00102201','x00102203','x00102297','x00102298','x00102299','x00104000',
  // ---- Study / referring physician / institution (group 0008) ----
  'x00080050','x00080080','x00080081','x00080082','x00080090','x00080092',
  'x00080094','x00080096','x00081010','x00081030','x0008103e','x00081040',
  'x00081048','x00081049','x00081050','x00081052','x00081060','x00081062',
  'x00081070','x00081072','x00081080','x00081084','x00081090',
  // ---- Equipment identifiers (group 0018) ----
  'x00181000','x00181002','x00181004','x00181005','x00181007','x00181008',
  'x00181030',
  // ---- Relationship / image comments (group 0020) ----
  'x00200010','x00204000',
  // ---- Procedure / visit / scheduling (groups 0032, 0038, 0040) ----
  'x00321032','x00321033','x00321060','x00324000',
  'x00380010','x00380011','x00380050','x00380060','x00380062','x00380300',
  'x00380400','x00380500','x00384000',
  'x00400006','x00400241','x00400242','x00400243','x00400253','x00400254',
  'x00401001','x00401002','x00401004','x00401005','x00401400','x00402008',
  'x00402009','x00402010','x00402400','x0040a073','x0040a075','x0040a078',
  'x0040a123','x0040a730',
  // ---- Content creator (group 0070) ----
  'x00700084',
];
const DATES = ['x00080012','x00080020','x00080021','x00080022','x00080023',
               'x00400244','x00400250'];
const TIMES = ['x00080013','x00080030','x00080031','x00080032','x00080033',
               'x00400245','x00400251'];

function nowDA() { const t = new Date(); return `${t.getFullYear()}${String(t.getMonth()+1).padStart(2,'0')}${String(t.getDate()).padStart(2,'0')}`; }
function nowTM() { const t = new Date(); return `${String(t.getHours()).padStart(2,'0')}${String(t.getMinutes()).padStart(2,'0')}${String(t.getSeconds()).padStart(2,'0')}`; }
function randDigits(n) { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10); return s; }
function randFrom(a) { return a[Math.floor(Math.random() * a.length)]; }

const CULTURES = {
  english: {
    surnames:   ['DOE','SMITH','JONES','BROWN','TAYLOR','WILSON','DAVIS','MOORE','THOMAS','JACKSON','HARRIS','CLARK'],
    first_m:    ['JOHN','JAMES','WILLIAM','ROBERT','CHARLES','HENRY','GEORGE','MICHAEL','EDWARD','THOMAS','RICHARD','DAVID'],
    first_f:    ['JANE','MARY','ELIZABETH','ALICE','HELEN','MARGARET','SARAH','EMMA','DOROTHY','RUTH','GRACE','FRANCES'],
  },
  french: {
    surnames:   ['DUPONT','MARTIN','BERNARD','THOMAS','PETIT','RICHARD','DURAND','MOREAU','LEROY','SIMON','MICHEL','LEFEBVRE'],
    first_m:    ['JEAN','PIERRE','LOUIS','MARC','PAUL','NICOLAS','HENRI','FRANCK','LUC','CLAUDE','RENE','DIDIER'],
    first_f:    ['MARIE','ANNE','CLAIRE','SOPHIE','JULIE','ISABELLE','HELENE','CAMILLE','LUCIE','LAURENCE','EMILIE','CECILE'],
  },
  russian: {
    surnames_m: ['IVANOV','PETROV','SIDOROV','SMIRNOV','KUZNETSOV','POPOV','NOVIKOV','VOLKOV','SOKOLOV','MOROZOV'],
    surnames_f: ['IVANOVA','PETROVA','SIDOROVA','SMIRNOVA','KUZNETSOVA','POPOVA','NOVIKOVA','VOLKOVA','SOKOLOVA','MOROZOVA'],
    first_m:    ['IVAN','ALEKSANDR','DMITRI','NIKOLAI','SERGEI','MIKHAIL','ANDREI','PAVEL','ALEKSEI','VLADIMIR'],
    first_f:    ['ANNA','NATALIA','IRINA','ELENA','MARINA','OLGA','TATIANA','EKATERINA','SVETLANA','YULIA'],
  },
  hispanic: {
    surnames:   ['GARCIA','RODRIGUEZ','MARTINEZ','HERNANDEZ','LOPEZ','GONZALEZ','PEREZ','SANCHEZ','RAMIREZ','TORRES','FLORES','REYES'],
    first_m:    ['JUAN','JOSE','CARLOS','MIGUEL','PEDRO','ANTONIO','FRANCISCO','LUIS','JAVIER','MANUEL','RAFAEL','SERGIO'],
    first_f:    ['MARIA','ANA','ROSA','CARMEN','ELENA','LUCIA','ISABEL','PATRICIA','LAURA','CLAUDIA','ANGELA','MONICA'],
  },
  chinese: {
    surnames:   ['ZHANG','WANG','LI','ZHAO','CHEN','LIU','YANG','HUANG','ZHOU','WU','XU','SUN'],
    first_m:    ['WEI','LEI','MING','HAO','JUN','YANG','TAO','CHAO','PENG','FENG','GANG','HUI'],
    first_f:    ['FANG','LI','NA','JING','HONG','MEI','YING','XIA','YAN','LAN','PING','HUA'],
  },
  japanese: {
    surnames:   ['YAMADA','TANAKA','SUZUKI','ITO','SATO','WATANABE','KOBAYASHI','KATO','YOSHIDA','YAMAMOTO','NAKAMURA','HAYASHI'],
    first_m:    ['TARO','KENJI','HIROSHI','TAKASHI','DAISUKE','NAOKI','RYO','SHOTA','YUTA','KAZUYA','MAKOTO','KENICHI'],
    first_f:    ['HANAKO','YUKI','SAKURA','AKIKO','MICHIKO','KAZUKO','YOKO','HARUKO','MIKI','NANA','AI','EMI'],
  },
  korean: {
    surnames:   ['KIM','LEE','PARK','CHOI','JUNG','KANG','CHO','YOON','JANG','LIM','OH','SHIN'],
    first_m:    ['GILDONG','MINJUN','JUNHO','HYUNJIN','SEONGMIN','JAEHO','TAEYONG','DONGHYUN','SANGWOO','JIHO','JIHOON','MINHO'],
    first_f:    ['YOUNGHEE','MINJUNG','JIYEON','SOYEON','HYEWON','EUNHEE','SOHEE','JIEUN','YUNA','SEOYEON','CHAEYOUNG','DAYEON'],
  },
};
const CULTURE_KEYS = Object.keys(CULTURES);

function randName(sex) {
  const culture = CULTURES[randFrom(CULTURE_KEYS)];
  const isFemale = sex === 'F';
  const surname = isFemale && culture.surnames_f
    ? randFrom(culture.surnames_f)
    : randFrom(culture.surnames || culture.surnames_m);
  const first = isFemale ? randFrom(culture.first_f) : randFrom(culture.first_m);
  return `${surname}^${first}`;
}

// Fixed dummy name: distinguishes anonymized files from randomized ones and keeps every
// slice of a study under one name. A DICOM value, not UI text (PS3.15: (0010,0010) is Z/D).
const ANON_NAME = 'ANONYMOUS';

// ---- Tag access ----
// dcmjs keys are 8-char UPPERCASE hex without 'x' ("0008103E"). An 'x'-prefixed key parses
// to NaN and is silently dropped on write, so always canonicalise and delete stale variants.
function canonTag(t) { return (t[0] === 'x' ? t.slice(1) : t).toUpperCase(); }
function tagVariants(t) { const h = canonTag(t); return [h, h.toLowerCase(), 'x' + h, 'x' + h.toLowerCase()]; }
function findTagKey(d, t) { for (const k of tagVariants(t)) if (k in d) return k; return null; }
function getTag(d, t) { const k = findTagKey(d, t); return k ? d[k] : undefined; }
function delTag(d, t) { for (const k of tagVariants(t)) delete d[k]; }
function setTag(d, t, vr, val) {
  const canon = canonTag(t);
  for (const k of tagVariants(t)) if (k !== canon) delete d[k]; // kill duplicate variants
  d[canon] = { vr, Value: Array.isArray(val) ? val : [val] };
}
function remPrivate(node) {
  walkEls(node, (t, el, parent) => {
    const g = parseInt((t.startsWith('x') ? t.slice(1) : t).slice(0,4), 16);
    if (g % 2 === 1) delete parent[t];
  });
}
function newUID() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  a[6] = (a[6] & 0x0f) | 0x40;
  a[8] = (a[8] & 0x3f) | 0x80;
  let n = 0n;
  for (const b of a) n = (n << 8n) + BigInt(b);
  return `2.25.${n.toString(10)}`;
}

// ---- PS3.15 Basic Confidentiality Profile ----
// Driven by window.DEID_PROFILE (deid-profile.js, PS3.15 Table E.1-1); applied recursively
// so PHI nested in sequences is cleaned too.

// Dummy value for the VR (actions D / X/D).
function dummyFor(vr) {
  if (/^(DA|DT|TM)$/.test(vr)) return '';                              // never fabricate temporal data
  if (/^(IS|DS|US|UL|SS|SL|FL|FD|SV|UV|OB|OW|OF|OD|UN)$/.test(vr)) return ''; // numeric/binary → empty
  if (vr === 'PN') return 'ANON^ANON';
  if (vr === 'SQ') return [];                                          // empty sequence
  return 'ANONYMIZED';
}

// ---- PS3.15 optional profiles ----
// Only the options whose columns are mostly 'K' (keep) are offered (window.DEID_OPTIONS).
// The 'C' (clean) options are not implemented, so offering them would write a false claim
// into (0012,0064). Values are CID 7050 codes and meanings, verified against PS3.16.
const DEID_OPTION_CODES = {
  rtnUIDsOpt:          ['113110', 'Retain UIDs Option'],
  rtnDevIdOpt:         ['113109', 'Retain Device Identity Option'],
  rtnInstIdOpt:        ['113112', 'Retain Institution Identity Option'],
  rtnPatCharsOpt:      ['113108', 'Retain Patient Characteristics Option'],
  rtnLongFullDatesOpt: ['113106', 'Retain Longitudinal Temporal Information Full Dates Option'],
};
const DEID_OPTION_ORDER = Object.keys(DEID_OPTION_CODES);   // fixed, so output is stable
let deidOptions = new Set();

// Read at the moment Anonymize runs, not on every checkbox change.
function readDeidOptions() {
  deidOptions = new Set();
  document.querySelectorAll('#deidOptionsRow input[type="checkbox"][data-opt]').forEach(cb => {
    if (cb.checked && DEID_OPTION_CODES[cb.dataset.opt]) deidOptions.add(cb.dataset.opt);
  });
  return deidOptions;
}

// Effective action for `tag` given the enabled options; null = leave alone.
// A 'C' row falls through to the Basic action: we cannot clean, so we remove.
function resolveAction(tag) {
  if (optionRetains(tag)) return null;
  return (window.DEID_PROFILE && window.DEID_PROFILE[tag]) || null;
}

// True only for an explicit K (resolveAction's null also means "not in the table").
function optionRetains(tag) {
  for (const opt of DEID_OPTION_ORDER) {
    if (!deidOptions.has(opt)) continue;
    if (window.DEID_OPTIONS?.[opt]?.[tag] === 'K') return true;
  }
  return false;
}

// Returns true if the element was removed (caller then skips recursing into it).
function applyAction(node, key, el, action) {
  const vr = el.vr || 'LO';
  switch (action) {
    case 'X':                                   // remove
      delete node[key]; return true;
    case 'U':                                   // UID → remapped later by remapUIDs()
    case 'X/Z/U*':                              // keep so nested UIDs remap, preserving references
      return false;
    case 'D': case 'X/D':                       // dummy value
      setTag(node, key, vr, dummyFor(vr)); return false;
    case 'Z': case 'Z/D': case 'X/Z': case 'X/Z/D':  // zero-length (never drops a maybe-required attr)
      setTag(node, key, vr, []); return false;
    default:
      return false;
  }
}
function applyProfile(node) {
  if (!node || typeof node !== 'object') return;
  for (const key of Object.keys(node)) {
    const el = node[key];
    if (!el || typeof el !== 'object') continue;
    const tag = canonTag(key);                             // 8-char UPPERCASE hex
    const group = parseInt(tag.slice(0, 4), 16);
    const elem  = tag.slice(4);
    // Repeating-group attributes not in the flat table:
    if (group >= 0x5000 && group <= 0x50ff) { delete node[key]; continue; }   // Curve Data (retired)
    if (group >= 0x6000 && group <= 0x60ff && (elem === '3000' || elem === '4000')) {
      delete node[key]; continue;                          // Overlay Data / Overlay Comments
    }
    const action = resolveAction(tag);
    const removed = action ? applyAction(node, key, el, action) : false;
    if (!removed && el.vr === 'SQ' && Array.isArray(el.Value)) {
      el.Value.forEach(item => applyProfile(item));        // clean nested attributes
    }
  }
}
// PS3.15 (0012,0062/0063/0064): one (0012,0064) item per profile applied (Basic + enabled
// options). (0012,0063) is LO VM 1-n: one value per meaning, since joining overflows 64 chars.
function addDeidMeta(d) {
  setTag(d, '00120062', 'CS', 'YES');                      // Patient Identity Removed
  const codes = [['113100', 'Basic Application Confidentiality Profile']];
  for (const opt of DEID_OPTION_ORDER) if (deidOptions.has(opt)) codes.push(DEID_OPTION_CODES[opt]);

  setTag(d, '00120063', 'LO',
    ['Carino DICOM Editor — DICOM PS3.15 Basic Profile'].concat(codes.slice(1).map(c => c[1])));
  delTag(d, '00120064');
  d['00120064'] = { vr: 'SQ', Value: codes.map(([value, meaning]) => ({
    '00080100': { vr: 'SH', Value: [value] },              // Code Value
    '00080102': { vr: 'SH', Value: ['DCM'] },              // Coding Scheme Designator
    '00080104': { vr: 'LO', Value: [meaning] },            // Code Meaning
  })) };
}

// CID 7050 113101 (Clean Pixel Data). Appended beside 113100, not replacing it: a file
// can be both anonymized and redacted.
function noteCleanPixelData(d) {
  const CODE = {
    '00080100': { vr: 'SH', Value: ['113101'] },
    '00080102': { vr: 'SH', Value: ['DCM'] },
    '00080104': { vr: 'LO', Value: ['Clean Pixel Data Option'] },
  };
  const el = getTag(d, '00120064');
  const items = (el && el.vr === 'SQ' && Array.isArray(el.Value)) ? el.Value.slice() : [];
  if (items.some(it => String(it?.['00080100']?.Value?.[0] || '') === '113101')) return;
  items.push(CODE);
  delTag(d, '00120064');
  d['00120064'] = { vr: 'SQ', Value: items };
}


// ---- Pixel redaction ----
// Stored value(s) that render black (or white): MONOCHROME1 black is the MAX value, signed
// data bottoms at -(1 << (bs-1)), YBR black is (0, mid, mid), PALETTE COLOR uses the LUT.
// Returns `spp` stored values (one for PALETTE COLOR), or null.
function redactionFill(d, info, mode) {
  const white = mode === 'white';
  const { pi, spp, bs, pr } = info;
  const hi = pr ? Math.pow(2, bs - 1) - 1 : Math.pow(2, bs) - 1;
  const lo = pr ? -Math.pow(2, bs - 1) : 0;
  const dark = white ? hi : lo, light = white ? lo : hi;

  if (/^PALETTE\s*COLOR$/i.test(pi)) {
    const r = readPaletteLut(d, '00281101', '00281201', info.bigEndian);
    const g = readPaletteLut(d, '00281102', '00281202', info.bigEndian);
    const b = readPaletteLut(d, '00281103', '00281203', info.bigEndian);
    if (!r || !g || !b) return null;
    const n = Math.min(r.count, g.count, b.count);
    let best = -1, bestScore = 0;
    for (let i = 0; i < n; i++) {
      const s = r.lut[i] * r.lut[i] + g.lut[i] * g.lut[i] + b.lut[i] * b.lut[i];
      if (best < 0 || (white ? s > bestScore : s < bestScore)) { bestScore = s; best = i; }
    }
    // Index of the darkest (or lightest) LUT colour, not index 0.
    return best < 0 ? null : [best + r.first];
  }
  if (/^MONOCHROME1$/i.test(pi)) return [light];
  if (/^MONOCHROME2$/i.test(pi)) return [dark];
  if (spp === 3 && /^YBR_/i.test(pi)) {
    const neutral = pr ? 0 : Math.pow(2, bs - 1);
    return [dark, neutral, neutral];
  }
  if (spp === 3) return [dark, dark, dark];
  return [dark];
}

// Boxes are in image pixels; floor the origin and ceil the far edge so partial pixels are covered.
function fillRedactionBoxes(frames, boxes, geom, samples) {
  const { rows, cols, spp, bs, hb, planar } = geom;
  const framePixels = rows * cols;
  const mask = Math.pow(2, bs) - 1;
  const shift = hb - bs + 1;
  // Mask to Bits Stored and shift to High Bit (High Bit is not always bs - 1).
  const words = samples.map(v => (v & mask) << (shift > 0 ? shift : 0));
  let painted = 0;
  for (const fr of frames) {
    for (const b of boxes) {
      const x0 = Math.max(0, Math.floor(b.x)), y0 = Math.max(0, Math.floor(b.y));
      const x1 = Math.min(cols, Math.ceil(b.x + b.w)), y1 = Math.min(rows, Math.ceil(b.y + b.h));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * cols + x;
          painted++;
          if (spp === 1) { fr[i] = words[0]; continue; }
          for (let s = 0; s < spp; s++) {
            fr[planar === 1 ? s * framePixels + i : i * spp + s] = words[Math.min(s, words.length - 1)];
          }
        }
      }
    }
  }
  return painted;
}

// Tags PS3.15 and PS3.3 require after the pixels are altered.
function retagRedacted(d, nBoxes, nFrames) {
  setTag(d, '00280301', 'CS', 'NO');                       // Burned In Annotation
  noteCleanPixelData(d);

  // Its own LO value, not concatenated (64-char limit).
  const method = 'Burned-in annotation redacted';
  const prevMethod = (getTag(d, '00120063')?.Value || []).map(v => String(v).trim()).filter(Boolean);
  if (!prevMethod.some(v => v.includes(method)))
    setTag(d, '00120063', 'LO', prevMethod.concat(method));

  // retagDerived (image-edits.js); ensureMeta mirrors (0008,0018) into (0002,0003) on export.
  retagDerived(d, `Burned-in annotation redacted (${nBoxes} region(s), ${nFrames} frame(s)) — Carino DICOM Editor`);

  // (0028,2110) Lossy Image Compression is deliberately kept: per PS3.3 C.7.6.1.1.5 it
  // records past lossy compression, which decompressing does not undo.
}

// Tags backed up for session undo. Kept by reference, not cloned: applyRedaction
// replaces these elements rather than mutating them.
const REDACT_RESTORE_TAGS = ['00280301', '00120063', '00120064', '00080008', '00082111',
                             '00080018', '00280100', '00280101', '00280102', '00280103',
                             '00280004', '00280006', '00281050', '00281051',
                             '7FE00001', '7FE00002'];

// Eager on click, not inside buildEditedFile: decoding may be async but buildEditedFile
// must stay synchronous. Returns { boxes, frames, converts, depthLoss } or { error }.
async function applyRedaction(entry, boxes, opts = {}) {
  if (!entry || !entry.dict) return { error: 'No file to redact.' };
  if (!boxes || !boxes.length) return { error: T('Draw at least one box first.') };
  const d = entry.dict;
  const meta = entry.meta || (entry.meta = {});

  const src = await decodeStoredFrames(d, meta);
  if (src.error) return { error: src.error };

  const fill = redactionFill(d, { pi: src.pi, spp: src.spp, bs: src.bs, pr: src.pr,
                                  bigEndian: src.ts === '1.2.840.10008.1.2.2' }, opts.fill);
  if (!fill) return { error: `Cannot work out a fill value for ${src.pi || 'this image'}.` };

  // Safety: if no pixel was covered, refuse before writing (0028,0301) = NO over
  // an image that still has the identity burned in.
  if (!fillRedactionBoxes(src.frames, boxes, src, fill))
    return { error: T('Those boxes cover no part of the image — nothing was redacted.') };

  const bytesPerSample = Math.ceil(src.ba / 8);
  const frameBytes = src.rows * src.cols * src.spp * bytesPerSample;
  // Pad to even length ourselves so the element length matches the buffer.
  const total = frameBytes * src.frames.length + ((frameBytes * src.frames.length) % 2);
  const outBuf = new ArrayBuffer(total);
  const o8 = new Uint8Array(outBuf);
  src.frames.forEach((fr, i) =>
    o8.set(new Uint8Array(fr.buffer, fr.byteOffset, fr.byteLength), i * frameBytes));

  entry.redactBackup = {
    px: getTag(d, '7FE00010'),
    tags: Object.fromEntries(REDACT_RESTORE_TAGS.map(t => [t, getTag(d, t)])),
    tsEl: meta['00020010'],
    retagged: !src.raw || src.swapped,
  };
  // Privacy: the rotate/flip undo holds pre-redaction pixels, so drop it.
  entry.pixelBackup = null;

  setTag(d, '7FE00010', src.ba <= 8 ? 'OB' : 'OW', outBuf);

  if (!src.raw) {
    // Pixel module now describes uncompressed interleaved samples (Number of Frames unchanged).
    setTag(d, '00280100', 'US', src.ba);
    setTag(d, '00280101', 'US', src.bs);
    setTag(d, '00280102', 'US', src.hb);
    setTag(d, '00280103', 'US', src.pr);
    setTag(d, '00280004', 'CS', src.pi);
    if (src.spp === 3) setTag(d, '00280006', 'US', 0); else delTag(d, '00280006');
    // Extended Offset Table points into fragments that no longer exist.
    delTag(d, '7FE00001'); delTag(d, '7FE00002');

    // Raw monochrome without a window gets auto-windowed to min..max; write the identity
    // window (e.g. WC 128 / WW 256 for 8 bits) so the ex-JPEG looks as it did.
    if (src.bitmap && src.spp === 1 && !lookupTag(d, '00281050')?.Value?.length) {
      setTag(d, '00281050', 'DS', String(1 << (src.bs - 1)));
      setTag(d, '00281051', 'DS', String(1 << src.bs));
    }
  }
  if (!src.raw || src.swapped) meta['00020010'] = { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] };

  retagRedacted(d, boxes.length, src.frames.length);

  // Required, not a UI refresh: buildEditedFile replays entry.pending on export, and a stale
  // copy would write the pre-redaction (0028,0301) = YES back.
  entry.pending = seedPending(entry.dict);
  if (files[currentFileIdx] === entry) usePendingOf(entry);
  datasetDirty = true;

  return { boxes: boxes.length, frames: src.frames.length, converts: !src.raw,
           depthLoss: !!src.depthLoss, pi: src.pi };
}

// Session-only undo of applyRedaction (does not affect files already exported).
function undoRedaction(entry) {
  const b = entry?.redactBackup;
  if (!b) return false;
  const d = entry.dict;
  delTag(d, '7FE00010');
  if (b.px) d['7FE00010'] = b.px;
  for (const [t, el] of Object.entries(b.tags)) { delTag(d, t); if (el) d[canonTag(t)] = el; }
  if (b.retagged) {
    if (b.tsEl) entry.meta['00020010'] = b.tsEl; else delete entry.meta['00020010'];
  }
  entry.redactBackup = null;
  entry.pending = seedPending(d);
  if (files[currentFileIdx] === entry) usePendingOf(entry);
  return true;
}

