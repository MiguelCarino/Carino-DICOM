// DICOM validator: SOP-class required attributes, UID/VR format, pixel size and PHI audit.

// ---- VR rules ----
const VR_RULES = {
  DA: { re: /^\d{8}$|^$/, maxLen: 8,  hint: 'YYYYMMDD' },
  TM: { re: /^\d{2}(\d{2}(\d{2}(\.\d{1,6})?)?)?$|^$/, maxLen: 16, hint: 'HHMMSS.FFFFFF' },
  DT: { re: /^\d{4,14}(\.\d{1,6})?([+-]\d{4})?$|^$/, maxLen: 26, hint: 'YYYYMMDDHHmmss.FFFFFF±HHMM' },
  UI: { re: /^[0-9.]{0,64}$/, maxLen: 64, hint: 'max 64 chars, digits and dots only' },
  CS: { re: /^[A-Z0-9 _]*$/, maxLen: 16, hint: 'uppercase, max 16 chars' },
  LO: { maxLen: 64 },
  SH: { maxLen: 16 },
  ST: { maxLen: 1024 },
  LT: { maxLen: 10240 },
  DS: { re: /^[+\-]?\d*\.?\d+([Ee][+\-]?\d+)?$|^$/, maxLen: 16, hint: 'decimal string' },
  IS: { re: /^[+\-]?\d+$|^$/, maxLen: 12, hint: 'integer string' },
  AS: { re: /^\d{3}[DWMY]$|^$/, maxLen: 4, hint: 'nnnD, nnnW, nnnM, or nnnY' },
};

// ---- Enumerated values for CS tags ----
const CS_ENUMS = {
  'x00100040': new Set(['M','F','O','']),
  'x00280103': new Set(['0','1']),
  'x00280006': new Set(['0','1']),
  'x00280004': new Set(['MONOCHROME1','MONOCHROME2','PALETTE COLOR','RGB','YBR_FULL',
                         'YBR_FULL_422','YBR_PARTIAL_420','YBR_PARTIAL_422','YBR_ICT','YBR_RCT']),
  'x00080060': new Set(['CR','CT','MR','US','OT','BI','CD','DD','DG','DX','ECG','EPS',
                         'ES','GM','HC','HD','IO','IVUS','KER','KO','LEN','LS','MG','NM',
                         'OAM','OCT','OP','OPM','OPR','OPT','OPV','OSS','PET','PF','PR',
                         'PT','PX','REG','RESP','RF','RG','RTDOSE','RTIMAGE','RTPLAN',
                         'RTRECORD','RTSTRUCT','RWV','SEG','SM','SMR','SR','SRF','STAIN',
                         'TG','US','VA','XA','XC']),
  'x00400a040': new Set(['TEXT','NUM','CODE','DATETIME','DATE','TIME','UIDREF','PNAME',
                          'COMPOSITE','IMAGE','WAVEFORM','SCOORD','SCOORD3D','TCOORD','CONTAINER']),
};

// ---- Known SOP Class UIDs ----
const KNOWN_SOP_UIDS = new Set([
  '1.2.840.10008.5.1.4.1.1.1','1.2.840.10008.5.1.4.1.1.1.1','1.2.840.10008.5.1.4.1.1.1.1.1',
  '1.2.840.10008.5.1.4.1.1.1.2','1.2.840.10008.5.1.4.1.1.1.2.1',
  '1.2.840.10008.5.1.4.1.1.2','1.2.840.10008.5.1.4.1.1.2.1','1.2.840.10008.5.1.4.1.1.2.2',
  '1.2.840.10008.5.1.4.1.1.3.1','1.2.840.10008.5.1.4.1.1.4','1.2.840.10008.5.1.4.1.1.4.1',
  '1.2.840.10008.5.1.4.1.1.4.2','1.2.840.10008.5.1.4.1.1.4.3','1.2.840.10008.5.1.4.1.1.4.4',
  '1.2.840.10008.5.1.4.1.1.6.1','1.2.840.10008.5.1.4.1.1.6.2',
  '1.2.840.10008.5.1.4.1.1.7','1.2.840.10008.5.1.4.1.1.7.1','1.2.840.10008.5.1.4.1.1.7.2',
  '1.2.840.10008.5.1.4.1.1.7.3','1.2.840.10008.5.1.4.1.1.7.4',
  '1.2.840.10008.5.1.4.1.1.9.1.1','1.2.840.10008.5.1.4.1.1.9.1.2','1.2.840.10008.5.1.4.1.1.9.1.3',
  '1.2.840.10008.5.1.4.1.1.9.2.1','1.2.840.10008.5.1.4.1.1.9.3.1','1.2.840.10008.5.1.4.1.1.9.4.1',
  '1.2.840.10008.5.1.4.1.1.11.1','1.2.840.10008.5.1.4.1.1.11.2','1.2.840.10008.5.1.4.1.1.11.3',
  '1.2.840.10008.5.1.4.1.1.11.4','1.2.840.10008.5.1.4.1.1.11.5',
  '1.2.840.10008.5.1.4.1.1.12.1','1.2.840.10008.5.1.4.1.1.12.1.1','1.2.840.10008.5.1.4.1.1.12.2',
  '1.2.840.10008.5.1.4.1.1.12.2.1',
  '1.2.840.10008.5.1.4.1.1.20','1.2.840.10008.5.1.4.1.1.66','1.2.840.10008.5.1.4.1.1.66.1',
  '1.2.840.10008.5.1.4.1.1.66.2','1.2.840.10008.5.1.4.1.1.66.3','1.2.840.10008.5.1.4.1.1.66.4',
  '1.2.840.10008.5.1.4.1.1.66.5',
  '1.2.840.10008.5.1.4.1.1.77.1','1.2.840.10008.5.1.4.1.1.77.1.1','1.2.840.10008.5.1.4.1.1.77.1.2',
  '1.2.840.10008.5.1.4.1.1.77.1.3','1.2.840.10008.5.1.4.1.1.77.1.4','1.2.840.10008.5.1.4.1.1.77.1.5',
  '1.2.840.10008.5.1.4.1.1.77.1.6',
  '1.2.840.10008.5.1.4.1.1.88.11','1.2.840.10008.5.1.4.1.1.88.22','1.2.840.10008.5.1.4.1.1.88.33',
  '1.2.840.10008.5.1.4.1.1.88.34','1.2.840.10008.5.1.4.1.1.88.35','1.2.840.10008.5.1.4.1.1.88.50',
  '1.2.840.10008.5.1.4.1.1.88.59','1.2.840.10008.5.1.4.1.1.88.65','1.2.840.10008.5.1.4.1.1.88.67',
  '1.2.840.10008.5.1.4.1.1.88.68','1.2.840.10008.5.1.4.1.1.88.69','1.2.840.10008.5.1.4.1.1.88.70',
  '1.2.840.10008.5.1.4.1.1.88.71','1.2.840.10008.5.1.4.1.1.88.72','1.2.840.10008.5.1.4.1.1.88.73',
  '1.2.840.10008.5.1.4.1.1.128','1.2.840.10008.5.1.4.1.1.128.1','1.2.840.10008.5.1.4.1.1.130',
  '1.2.840.10008.5.1.4.1.1.131',
  '1.2.840.10008.5.1.4.1.1.481.1','1.2.840.10008.5.1.4.1.1.481.2','1.2.840.10008.5.1.4.1.1.481.3',
  '1.2.840.10008.5.1.4.1.1.481.4','1.2.840.10008.5.1.4.1.1.481.5','1.2.840.10008.5.1.4.1.1.481.6',
  '1.2.840.10008.5.1.4.1.1.481.7','1.2.840.10008.5.1.4.1.1.481.8','1.2.840.10008.5.1.4.1.1.481.9',
]);

// ---- SOP-class attribute requirements ----
// { tag: type }: 1 = required non-empty, 2 = required may be empty, '1C'/'2C' = conditional.
const COMMON_IMAGE_ATTRS = {
  'x00080016':1,'x00080018':1,
  'x00100010':2,'x00100020':2,'x00100030':2,'x00100040':2,
  'x0020000d':1,'x00200010':2,'x00080020':2,'x00080030':2,'x00080050':2,'x00080090':2,
  'x0020000e':1,'x00200011':2,'x00080060':1,
  'x00200013':2,
  'x00280002':1,'x00280004':1,'x00280010':1,'x00280011':1,
  'x00280100':1,'x00280101':1,'x00280102':1,'x00280103':1,
  'x7fe00010':1,
};
const CROSS_SECTIONAL_ATTRS = {
  'x00200032':'1C','x00200037':'1C','x00200052':'1C','x00280030':'1C',
};
const SOP_ATTRS = {
  // CT
  '1.2.840.10008.5.1.4.1.1.2': {
    name:'CT Image Storage',
    attrs:{ ...COMMON_IMAGE_ATTRS, ...CROSS_SECTIONAL_ATTRS,
      'x00180060':2,'x00180050':2,'x00181160':2,'x00181030':2 }
  },
  '1.2.840.10008.5.1.4.1.1.2.1': {
    name:'Enhanced CT Image Storage',
    attrs:{ ...COMMON_IMAGE_ATTRS, ...CROSS_SECTIONAL_ATTRS,
      'x00180060':2,'x00180050':2,'x00280008':1 }
  },
  // MR
  '1.2.840.10008.5.1.4.1.1.4': {
    name:'MR Image Storage',
    attrs:{ ...COMMON_IMAGE_ATTRS, ...CROSS_SECTIONAL_ATTRS,
      'x00180020':1,'x00180021':1,'x00180023':2,'x00180080':'2C','x00180081':'2C' }
  },
  '1.2.840.10008.5.1.4.1.1.4.1': {
    name:'Enhanced MR Image Storage',
    attrs:{ ...COMMON_IMAGE_ATTRS, ...CROSS_SECTIONAL_ATTRS,
      'x00180020':1,'x00180021':1,'x00280008':1 }
  },
  // CR
  '1.2.840.10008.5.1.4.1.1.1': {
    name:'Computed Radiography Image Storage',
    attrs:{ ...COMMON_IMAGE_ATTRS,
      'x00180015':2,'x00181030':2,'x00280030':'1C' }
  },
  // DX
  '1.2.840.10008.5.1.4.1.1.1.1': {
    name:'Digital X-Ray Image Storage (Presentation)',
    attrs:{ ...COMMON_IMAGE_ATTRS,
      'x00180015':2,'x00181030':2,'x00280030':1,'x00181164':1 }
  },
  '1.2.840.10008.5.1.4.1.1.1.1.1': {
    name:'Digital X-Ray Image Storage (Processing)',
    attrs:{ ...COMMON_IMAGE_ATTRS,
      'x00180015':2,'x00280030':1,'x00181164':1 }
  },
  // Mammography
  '1.2.840.10008.5.1.4.1.1.1.2': {
    name:'Digital Mammography X-Ray (Presentation)',
    attrs:{ ...COMMON_IMAGE_ATTRS,
      'x00185101':1,'x00280030':1,'x00181164':1 }
  },
  // US
  '1.2.840.10008.5.1.4.1.1.6.1': {
    name:'Ultrasound Image Storage',
    attrs:{ ...COMMON_IMAGE_ATTRS }
  },
  '1.2.840.10008.5.1.4.1.1.3.1': {
    name:'Ultrasound Multiframe Image Storage',
    attrs:{ ...COMMON_IMAGE_ATTRS, 'x00280008':1 }
  },
  // Secondary Capture
  '1.2.840.10008.5.1.4.1.1.7': {
    name:'Secondary Capture Image Storage',
    attrs:{ ...COMMON_IMAGE_ATTRS }
  },
  // NM
  '1.2.840.10008.5.1.4.1.1.20': {
    name:'Nuclear Medicine Image Storage',
    attrs:{ ...COMMON_IMAGE_ATTRS,
      'x00540010':'1C','x00541001':2,'x00541002':2,'x00541102':2 }
  },
  // PET
  '1.2.840.10008.5.1.4.1.1.128': {
    name:'PET Image Storage',
    attrs:{ ...COMMON_IMAGE_ATTRS,
      'x00540013':2,'x00541001':2,'x00541002':2,'x00541300':2,'x00541321':2,'x00541322':2 }
  },
  // RT
  '1.2.840.10008.5.1.4.1.1.481.2': {
    name:'RT Dose Storage',
    attrs:{ 'x00080016':1,'x00080018':1,'x0020000d':1,'x0020000e':1,'x00200013':2,
      'x00100010':2,'x00100020':2,'x00080060':1,
      'x30040002':1,'x30040004':1,'x3004000e':1,'x3004000c':'1C','x00280010':1,'x00280011':1 }
  },
  '1.2.840.10008.5.1.4.1.1.481.3': {
    name:'RT Structure Set Storage',
    attrs:{ 'x00080016':1,'x00080018':1,'x0020000d':1,'x0020000e':1,'x00200013':2,
      'x00100010':2,'x00100020':2,'x00080060':1,
      'x30060002':1,'x30060008':2,'x30060009':2,'x30060020':'1C','x30060039':'1C' }
  },
  '1.2.840.10008.5.1.4.1.1.481.5': {
    name:'RT Plan Storage',
    attrs:{ 'x00080016':1,'x00080018':1,'x0020000d':1,'x0020000e':1,'x00200013':2,
      'x00100010':2,'x00100020':2,'x00080060':1,
      'x300a0002':1,'x300a0006':2,'x300a0007':2 }
  },
  // SR
  '1.2.840.10008.5.1.4.1.1.88.11': { name:'Basic Text SR', attrs:{ 'x00080016':1,'x00080018':1,'x0020000d':1,'x0020000e':1,'x00200013':2,'x00100010':2,'x00100020':2,'x00080060':1,'x0040a040':1,'x0040a050':1,'x0040a730':'1C' } },
  '1.2.840.10008.5.1.4.1.1.88.22': { name:'Enhanced SR', attrs:{ 'x00080016':1,'x00080018':1,'x0020000d':1,'x0020000e':1,'x00200013':2,'x00100010':2,'x00100020':2,'x00080060':1,'x0040a040':1,'x0040a050':1,'x0040a730':'1C' } },
  '1.2.840.10008.5.1.4.1.1.88.33': { name:'Comprehensive SR', attrs:{ 'x00080016':1,'x00080018':1,'x0020000d':1,'x0020000e':1,'x00200013':2,'x00100010':2,'x00100020':2,'x00080060':1,'x0040a040':1,'x0040a050':1,'x0040a730':'1C' } },
};

// ---- PHI tags (for PHI audit) ----
const PHI_TAGS = new Set(PHI.map(t => t.replace(/^x/,'')));

// ---- Validation engine ----
// Dataset keys are either 'xGGGGEEEE' or bare 8-hex; anything else (e.g. _vrMap) is not an element.
const validatorIsTagKey = t => t.startsWith('x') || /^[0-9a-f]{8}$/i.test(t);
const validatorStripX = rawTag => rawTag.startsWith('x') ? rawTag.slice(1) : rawTag;

// Shared state for one validateDicom run: the dataset, the issue list and its readers.
function makeValidatorContext(d, meta) {
  const issues = [];
  const push = (sev, tag, msg, val, fix) =>
    issues.push({ sev, tag, desc: descFor('x'+tag.toLowerCase()) || 'Unknown', msg, val: String(val ?? ''), fix });

  // Use getTag: tags here are lowercase but dcmjs keys are UPPERCASE.
  const getVal = tag => {
    const el = getTag(d, tag);
    if (!el) return null;
    if (el.InlineBinary) return '<binary>';
    const v = el.Value;
    if (!v?.length) return '';
    // OB/OW values are ArrayBuffers; the string mapping below would turn them into ''.
    if (Array.isArray(v) && v.some(x => x instanceof ArrayBuffer || ArrayBuffer.isView(x))) return '<binary>';
    return Array.isArray(v) ? v.map(x => typeof x === 'object' ? (x?.Alphabetic ?? '') : String(x ?? '')).join('\\') : String(v);
  };
  const getEl = tag => getTag(d, tag);
  return { d, meta, issues, push, getVal, getEl };
}

// 1. SOP Class conformance: known SOP Class, then its per-IOD Type 1/2/1C attributes.
function validateSopConformance({ push, getVal }) {
  const sopUID = getVal('00080016')?.trim();
  const sopDef = sopUID ? SOP_ATTRS[sopUID] : null;
  if (!sopUID) {
    push('error','00080016','SOP Class UID missing — cannot determine IOD conformance','',null);
  } else if (!KNOWN_SOP_UIDS.has(sopUID)) {
    push('warning','00080016',`Unknown SOP Class UID — may be proprietary or private`,sopUID,null);
  }
  if (!sopDef) return;
  for (const [rawTag, type] of Object.entries(sopDef.attrs)) {
    const tag = validatorStripX(rawTag);
    const val = getVal(tag);
    if (type === 1) {
      if (val === null) push('error', tag, `Missing — Type 1 required for ${sopDef.name}`, '', null);
      else if (val === '') push('error', tag, `Empty — Type 1 must have a value in ${sopDef.name}`, '', null);
    } else if (type === 2) {
      if (val === null) push('warning', tag, `Missing — Type 2 should be present in ${sopDef.name}`, '', null);
    } else if (type === '1C') {
      if (val === null) push('info', tag, `Conditionally required — verify if applicable for ${sopDef.name}`, '', null);
    }
  }
}

// 2. UID format validation (PS3.5 §9.1: <=64 chars, digits and dots, no leading zeros).
function validateUidFormats({ push, getVal, getEl }) {
  for (const uTag of ['00080016','00080018','0020000d','0020000e','00200052']) {
    const val = getVal(uTag);
    if (val === null || val === '') continue;
    if (val.length > 64) push('error', uTag, `UID exceeds 64 characters (${val.length})`, val, () => { getEl(uTag).Value = [val.slice(0,64)]; });
    if (!/^[0-9.]+$/.test(val)) push('error', uTag, 'UID contains invalid characters (only digits and dots allowed)', val, null);
    if (/\.(0\d)/.test(val)) push('warning', uTag, 'UID component has leading zero (e.g. .01)', val, null);
    if (val.endsWith('.')) push('error', uTag, 'UID must not end with a dot', val, () => { getEl(uTag).Value = [val.replace(/\.$/, '')]; });
  }
}

// 3a. One element's VR checks: max length / format, trailing whitespace, CS defined terms.
function validateElementVr(push, tag, el, vr) {
  const vals = Array.isArray(el.Value) ? el.Value : (el.Value != null ? [el.Value] : []);
  for (const raw of vals) {
    const v = typeof raw === 'object' ? (raw?.Alphabetic ?? '') : String(raw ?? '');
    const rule = VR_RULES[vr];
    if (!rule) continue;
    if (rule.maxLen && v.length > rule.maxLen) {
      push('error', tag, `${vr} value exceeds max length ${rule.maxLen} (got ${v.length})`, v,
        () => { el.Value = el.Value.map(x => { const s=typeof x==='object'?(x?.Alphabetic??''):String(x??''); return s.slice(0,rule.maxLen); }); });
    }
    if (rule.re && v && !rule.re.test(v.trim())) {
      push('warning', tag, `${vr} value "${v.trim()}" does not match expected format: ${rule.hint}`, v, null);
    }
  }
  // Trailing spaces (common issue)
  for (const raw of vals) {
    const v = typeof raw === 'string' ? raw : null;
    if (v && v !== v.trimEnd()) {
      push('info', tag, 'Value has trailing whitespace', v,
        () => { el.Value = el.Value.map(x => typeof x === 'string' ? x.trimEnd() : x); });
      break;
    }
  }
  // CS enumerated values
  const k = 'x' + tag.toLowerCase();
  if (vr === 'CS' && CS_ENUMS[k]) {
    for (const raw of vals) {
      const v = String(raw ?? '').trim();
      if (v && !CS_ENUMS[k].has(v)) push('warning', tag, `"${v}" is not a defined value for this CS tag`, v, null);
    }
  }
}

// 3. VR format validation over every non-binary, non-sequence element.
function validateVrFormats({ d, push }) {
  for (const [rawTag, el] of Object.entries(d).filter(([t]) => validatorIsTagKey(t))) {
    const tag = validatorStripX(rawTag);
    const vr = el.vr || '';
    if (!vr || el.InlineBinary || isBinaryVR(vr) || vr === 'SQ') continue;
    validateElementVr(push, tag, el, vr);
  }
}

// 4. Pixel data geometry (uncompressed only — encapsulated sizes are not predictable).
function validatePixelGeometry({ d, meta, push, getVal }) {
  const tsEl = meta?.['00020010'] ?? meta?.TransferSyntaxUID;
  const ts = (tsEl?.Value?.[0] ?? '').trim();
  const UNCOMPRESSED = new Set(['','1.2.840.10008.1.2','1.2.840.10008.1.2.1','1.2.840.10008.1.2.1.99','1.2.840.10008.1.2.2']);
  if (!UNCOMPRESSED.has(ts)) return;
  const rows = Number(getVal('00280010')||0), cols = Number(getVal('00280011')||0);
  const ba = Number(getVal('00280100')||0), spp = Number(getVal('00280002')||1);
  const nf = Number(getVal('00280008')||1);
  const px = lookupTag(d,'7fe00010');
  if (!(rows && cols && ba && px?.Value?.[0])) return;
  let buf = px.Value[0];
  if (ArrayBuffer.isView(buf)) buf = buf.buffer;
  const expected = rows * cols * Math.ceil(ba/8) * spp * nf;
  const actual   = buf instanceof ArrayBuffer ? buf.byteLength : 0;
  if (actual && Math.abs(actual - expected) > 2) {
    push('warning','7fe00010',
      `Pixel buffer size mismatch — expected ${expected} bytes, got ${actual}`,
      `${actual} vs ${expected}`, null);
  }
}

// 5. PHI audit — flags populated PHI tags unless they hold a known anonymised placeholder.
function auditPhiTags({ d, push, getVal }) {
  for (const [rawTag, el] of Object.entries(d).filter(([t]) => validatorIsTagKey(t))) {
    const tag = validatorStripX(rawTag).toLowerCase();
    if (!PHI_TAGS.has(tag)) continue;
    if (el.InlineBinary || isBinaryVR(el.vr||'') || el.vr === 'SQ') continue;
    const val = getVal(tag);
    if (val && val !== '' && val !== 'ANON' && val !== 'ANONYMOUS' && val !== '000Y') {
      push('phi', tag, 'Contains potentially identifying information', val, null);
    }
  }
}

function validateDicom(d, meta) {
  const ctx = makeValidatorContext(d, meta);
  validateSopConformance(ctx);
  validateUidFormats(ctx);
  validateVrFormats(ctx);
  validatePixelGeometry(ctx);
  auditPhiTags(ctx);
  return ctx.issues;
}

