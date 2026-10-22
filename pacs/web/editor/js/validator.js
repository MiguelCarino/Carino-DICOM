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
// Keys are 'x' + 8 lowercase hex, the form validateElementVr looks up.
const CS_ENUMS = {
  'x00100040': new Set(['M','F','O','']),
  'x00280004': new Set(['MONOCHROME1','MONOCHROME2','PALETTE COLOR','RGB','YBR_FULL',
                         'YBR_FULL_422','YBR_PARTIAL_420','YBR_PARTIAL_422','YBR_ICT','YBR_RCT','XYB']),
  // PS3.3 C.7.3.1.1.1 Defined Terms, current and retired.
  'x00080060': new Set(['ANN','AR','ASMT','AU','BDUS','BI','BMD','CD','CFM','CR','CT','CTPROTOCOL',
                         'DD','DG','DMS','DOC','DX','ECG','EEG','EMG','EOG','EPS','ES','FID','GM',
                         'HC','HD','IO','IOL','IVOCT','IVUS','KER','KO','LEN','LS','M3D','MG','MR',
                         'NM','OAM','OCT','OP','OPM','OPR','OPT','OPTBSV','OPTENF','OPV','OSS','OT',
                         'PA','PLAN','POS','PR','PT','PX','REG','RESP','RF','RG','RTDOSE','RTIMAGE',
                         'RTINTENT','RTPLAN','RTRAD','RTRECORD','RTSEGANN','RTSTRUCT','RWV','SEG',
                         'SM','SMR','SR','SRF','STAIN','TEXTUREMAP','TG','US','VA','XA','XAPROTOCOL','XC']),
  'x00200062': new Set(['R','L','U','B']),
  'x0040a040': new Set(['TEXT','NUM','CODE','DATETIME','DATE','TIME','UIDREF','PNAME',
                         'COMPOSITE','IMAGE','WAVEFORM','SCOORD','SCOORD3D','TCOORD','CONTAINER','TABLE']),
};
// Enumerated values of US attributes (PS3.3 C.7.6.3.1.3 / C.7.6.3.1.4), compared as strings.
const US_ENUMS = {
  'x00280103': new Set(['0','1']),
  'x00280006': new Set(['0','1']),
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
  '1.2.840.10008.5.1.4.1.1.77.1.3','1.2.840.10008.5.1.4.1.1.77.1.4','1.2.840.10008.5.1.4.1.1.77.1.5','1.2.840.10008.5.1.4.1.1.77.1.5.1',
  '1.2.840.10008.5.1.4.1.1.77.1.6',
  // PS3.4 Table B.5-1 classes the list above lacked (16-bit OP, OPT, video, encapsulated, ...).
  '1.2.840.10008.5.1.4.1.1.77.1.5.2','1.2.840.10008.5.1.4.1.1.77.1.5.3','1.2.840.10008.5.1.4.1.1.77.1.5.4',
  '1.2.840.10008.5.1.4.1.1.77.1.5.5','1.2.840.10008.5.1.4.1.1.77.1.5.6','1.2.840.10008.5.1.4.1.1.77.1.5.7',
  '1.2.840.10008.5.1.4.1.1.77.1.5.8','1.2.840.10008.5.1.4.1.1.77.1.7','1.2.840.10008.5.1.4.1.1.77.1.8',
  '1.2.840.10008.5.1.4.1.1.77.1.1.1','1.2.840.10008.5.1.4.1.1.77.1.2.1','1.2.840.10008.5.1.4.1.1.77.1.4.1',
  '1.2.840.10008.5.1.4.1.1.104.1','1.2.840.10008.5.1.4.1.1.104.2','1.2.840.10008.5.1.4.1.1.104.3',
  '1.2.840.10008.5.1.4.1.1.104.4','1.2.840.10008.5.1.4.1.1.104.5',
  '1.2.840.10008.5.1.4.1.1.13.1.3','1.2.840.10008.5.1.4.1.1.13.1.4','1.2.840.10008.5.1.4.1.1.13.1.5',
  '1.2.840.10008.5.1.4.1.1.14.1','1.2.840.10008.5.1.4.1.1.14.2','1.2.840.10008.5.1.4.1.1.80.1',
  '1.2.840.10008.5.1.4.1.1.88.40','1.2.840.10008.5.1.4.1.1.88.74','1.2.840.10008.5.1.4.1.1.88.75',
  '1.2.840.10008.5.1.4.1.1.88.76','1.2.840.10008.5.1.4.1.1.88.77',
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
// Image Plane + Frame of Reference: mandatory modules for CT, MR and PET (PS3.3 Table C.7-10:
// Pixel Spacing, Image Orientation, Image Position Type 1; Frame of Reference UID Type 1).
const CROSS_SECTIONAL_ATTRS = {
  'x00200032':1,'x00200037':1,'x00200052':1,'x00280030':1,
};
// Enhanced (multi-frame) IODs carry plane geometry in the functional groups instead.
const ENHANCED_ATTRS = { 'x00200052':1, 'x52009229':1, 'x52009230':1, 'x00280008':1 };
const SOP_ATTRS = {
  // CT
  '1.2.840.10008.5.1.4.1.1.2': {
    name:'CT Image Storage',
    attrs:{ ...COMMON_IMAGE_ATTRS, ...CROSS_SECTIONAL_ATTRS,
      'x00180060':2,'x00180050':2,'x00281052':1,'x00281053':1 }
  },
  '1.2.840.10008.5.1.4.1.1.2.1': {
    name:'Enhanced CT Image Storage',
    attrs:{ ...COMMON_IMAGE_ATTRS, ...ENHANCED_ATTRS }
  },
  // MR
  '1.2.840.10008.5.1.4.1.1.4': {
    name:'MR Image Storage',
    attrs:{ ...COMMON_IMAGE_ATTRS, ...CROSS_SECTIONAL_ATTRS,
      'x00180020':1,'x00180021':1,'x00180023':2,'x00180080':'2C','x00180081':2 }
  },
  // Scanning Sequence / Sequence Variant belong to the single-frame MR Image Module only.
  '1.2.840.10008.5.1.4.1.1.4.1': {
    name:'Enhanced MR Image Storage',
    attrs:{ ...COMMON_IMAGE_ATTRS, ...ENHANCED_ATTRS }
  },
  // CR
  '1.2.840.10008.5.1.4.1.1.1': {
    name:'Computed Radiography Image Storage',
    attrs:{ ...COMMON_IMAGE_ATTRS,
      'x00180015':2,'x00280030':'1C' }
  },
  // DX
  '1.2.840.10008.5.1.4.1.1.1.1': {
    name:'Digital X-Ray Image Storage (Presentation)',
    attrs:{ ...COMMON_IMAGE_ATTRS,
      'x00180015':2,'x00280030':1,'x00181164':1 }
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
  // Ophthalmic Photography 8 Bit (PS3.3 A.41): its own Type 1/2 attributes, and Image Laterality
  // is Type 1 and R, L or B only (C.8.17.5), so a photo of no particular eye is an error.
  '1.2.840.10008.5.1.4.1.1.77.1.5.1': {
    name:'Ophthalmic Photography 8 Bit Image Storage',
    attrs:{ ...COMMON_IMAGE_ATTRS,
      'x00080008':1,'x00200013':1,'x00080023':1,'x00080033':1,'x0008002a':'1C',
      'x00200200':1,'x0018106a':1,'x00181800':1,'x00080070':2,
      'x00280008':1,'x00280009':1,'x00282110':1,'x00280301':1,
      'x00200062':1,'x00082218':1,
      'x00220005':2,'x0022000c':2,'x0022001b':2,'x0022000a':2,'x0022000b':2,'x0022000d':2,
      'x00220015':1,'x00220016':2,'x00220017':2,'x00220018':2,'x00220019':2,'x00187004':2 },
    enums:{ 'x00080060':['OP'], 'x00200062':['R','L','B'] },
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
    attrs:{ ...COMMON_IMAGE_ATTRS, ...CROSS_SECTIONAL_ATTRS,
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

// 16-bit Ophthalmic Photography has the same module set as 8-bit.
SOP_ATTRS['1.2.840.10008.5.1.4.1.1.77.1.5.2'] = {
  ...SOP_ATTRS['1.2.840.10008.5.1.4.1.1.77.1.5.1'], name: 'Ophthalmic Photography 16 Bit Image Storage' };

// ---- PHI tags (for PHI audit) ----
// Everything the anonymizer itself would remove, zero or dummy (Table E.1-1, non-UID actions),
// plus the short identity list, so the audit never calls clean what Anonymize would still strip.
const PHI_TAGS = new Set([
  ...PHI.map(t => t.replace(/^x/,'').toLowerCase()),
  ...Object.entries(window.DEID_PROFILE || {}).filter(([, a]) => !/U/.test(a)).map(([t]) => t.toLowerCase()),
]);
// Values this tool (or a typical de-identifier) writes in place of identity.
const PHI_PLACEHOLDERS = new Set(['ANON', 'ANONYMOUS', 'ANON^ANON', 'ANONYMIZED', '000Y',
                                  '19000101', '000000', '19000101000000', 'urn:anonymized', 'COERCE', 'UNVERIFIED']);

// ---- Messages ----
// An issue's msg is English (the log, the printed report and the tests read it); the Conformance
// card shows validatorMsg(), translated. A message with values is an English template plus them:
// p fills {name} as data, pt names the values that are words to translate too.
const vMsg = (key, p = {}, pt = []) => ({ key, p, pt });
const fillMsg = (tpl, p) => tpl.replace(/\{(\w+)\}/g, (all, k) => (k in p ? String(p[k]) : all));
function validatorMsg(iss) {
  if (!iss.parts) return T(iss.msg);
  return iss.parts.map(m => {
    const p = { ...m.p };
    for (const k of m.pt) p[k] = T(p[k]);
    return fillMsg(T(m.key), p);
  }).join(' ');
}

// ---- Validation engine ----
// Dataset keys are either 'xGGGGEEEE' or bare 8-hex; anything else (e.g. _vrMap) is not an element.
const validatorIsTagKey = t => t.startsWith('x') || /^[0-9a-f]{8}$/i.test(t);
const validatorStripX = rawTag => rawTag.startsWith('x') ? rawTag.slice(1) : rawTag;

// Shared state for one validateDicom run: the dataset, the issue list and its readers.
function makeValidatorContext(d, meta) {
  const issues = [];
  // msg: plain English (its own translation key), or vMsg() parts, joined by a space.
  const push = (sev, tag, msg, val, fix) => {
    const parts = typeof msg === 'string' ? null : [].concat(msg);
    issues.push({ sev, tag, desc: descFor('x'+tag.toLowerCase()) || 'Unknown',
                  msg: parts ? parts.map(m => fillMsg(m.key, m.p)).join(' ') : msg, parts,
                  val: String(val ?? ''), fix });
  };

  // Use getTag: tags here are lowercase but dcmjs keys are UPPERCASE.
  const getVal = tag => {
    const el = getTag(d, tag);
    if (!el) return null;
    if (el.InlineBinary) return '<binary>';
    const v = el.Value;
    if (!v?.length) return '';
    // OB/OW values are ArrayBuffers; the string mapping below would turn them into ''.
    if (Array.isArray(v) && v.some(x => x instanceof ArrayBuffer || ArrayBuffer.isView(x))) return '<binary>';
    // A sequence with items has a value; the item objects would otherwise read as ''.
    if (el.vr === 'SQ') return '<sequence>';
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
    push('warning','00080016','Unknown SOP Class UID — may be proprietary or private',sopUID,null);
  }
  if (!sopDef) return;
  for (const [rawTag, type] of Object.entries(sopDef.attrs)) {
    const tag = validatorStripX(rawTag);
    const val = getVal(tag);
    if (type === 1) {
      if (val === null) push('error', tag, vMsg('Missing — Type 1 required for {iod}', { iod: sopDef.name }), '', null);
      else if (val === '') push('error', tag, vMsg('Empty — Type 1 must have a value in {iod}', { iod: sopDef.name }), '', null);
    } else if (type === 2) {
      if (val === null) push('warning', tag, vMsg('Missing — Type 2 should be present in {iod}', { iod: sopDef.name }), '', null);
    } else if (type === '1C' || type === '2C') {
      if (val === null) push('info', tag, vMsg('Conditionally required — verify if applicable for {iod}', { iod: sopDef.name }), '', null);
    }
  }
  for (const [rawTag, allowed] of Object.entries(sopDef.enums || {})) {
    const tag = validatorStripX(rawTag);
    const val = getVal(tag)?.trim();
    if (val && !allowed.includes(val)) push('error', tag, vMsg('"{v}" is not allowed in {iod} (only {list})', { v: val, iod: sopDef.name, list: allowed.join(', ') }), val, null);
  }
}

// 2. UID format validation (PS3.5 §9.1: <=64 chars, digits and dots, no leading zeros).
function validateUidFormats({ push, getVal, getEl }) {
  for (const uTag of ['00080016','00080018','0020000d','0020000e','00200052']) {
    const val = getVal(uTag);
    if (val === null || val === '') continue;
    if (val.length > 64) push('error', uTag, vMsg('UID exceeds 64 characters ({n})', { n: val.length }), val, null);
    if (!/^[0-9.]+$/.test(val)) push('error', uTag, 'UID contains invalid characters (only digits and dots allowed)', val, null);
    if (/\.(0\d)/.test(val)) push('warning', uTag, 'UID component has leading zero (e.g. .01)', val, null);
    if (val.endsWith('.')) push('error', uTag, 'UID must not end with a dot', val, null);
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
      push('error', tag, vMsg('{vr} value exceeds max length {max} (got {n})', { vr, max: rule.maxLen, n: v.length }), v, null);
    }
    if (rule.re && v && !rule.re.test(v.trim())) {
      push('warning', tag, vMsg('{vr} value "{v}" does not match expected format: {hint}', { vr, v: v.trim(), hint: rule.hint }, ['hint']), v, null);
    }
  }
  // Trailing spaces (common issue)
  for (const raw of vals) {
    const v = typeof raw === 'string' ? raw : null;
    if (v && v !== v.trimEnd()) {
      push('info', tag, 'Value has trailing whitespace', v, null);
      break;
    }
  }
  // CS enumerated values
  const k = 'x' + tag.toLowerCase();
  if (vr === 'CS' && CS_ENUMS[k]) {
    for (const raw of vals) {
      const v = String(raw ?? '').trim();
      if (v && !CS_ENUMS[k].has(v)) push('warning', tag, vMsg('"{v}" is not a defined value for this CS tag', { v }), v, null);
    }
  }
  if (vr === 'US' && US_ENUMS[k]) {
    for (const raw of vals) {
      const v = String(raw ?? '').trim();
      if (v && !US_ENUMS[k].has(v)) push('warning', tag, vMsg('"{v}" is not a defined value for this attribute', { v }), v, null);
    }
  }
}

// 3. VR format validation over every non-binary element, inside sequences too (an SR's Value
// Types live in its Content Sequence).
function validateVrFormats({ d, push }) {
  walkEls(d, (rawTag, el) => {
    if (!validatorIsTagKey(rawTag)) return;
    const tag = validatorStripX(rawTag);
    const vr = el.vr || '';
    if (!vr || el.InlineBinary || isBinaryVR(vr) || vr === 'SQ') return;
    validateElementVr(push, tag, el, vr);
  });
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
  const pi = String(getVal('00280004')||'').trim().toUpperCase();
  const px = lookupTag(d,'7fe00010');
  if (!(rows && cols && ba && px?.Value?.[0])) return;
  let buf = px.Value[0];
  if (ArrayBuffer.isView(buf)) buf = buf.buffer;
  // Bits Allocated 1 is bit-packed (PS3.5 8.1.1); YBR_FULL_422 stores 2 samples per pixel's
  // worth, not 3 (PS3.3 C.7.6.3.1.2).
  const expected = ba === 1 ? Math.ceil(rows * cols * spp * nf / 8)
                 : rows * cols * Math.ceil(ba/8) * (pi === 'YBR_FULL_422' ? 2 : spp) * nf;
  const actual   = buf instanceof ArrayBuffer ? buf.byteLength : 0;
  if (actual && Math.abs(actual - expected) > 2) {
    push('warning','7fe00010',
      vMsg('Pixel buffer size mismatch — expected {want} bytes, got {got}', { want: expected, got: actual }),
      `${actual} vs ${expected}`, null);
  }
}

// 5. PHI audit — flags populated PHI tags unless they hold a known anonymised placeholder.
// Walks sequence items too (Table E.1-1 applies at any depth: Other Patient IDs, Request
// Attributes, SR content), and flags any private attribute with a value (E.1-1: Private
// Attributes X). Issues found in an item name the top-level element they sit under.
function auditPhiTags({ d, push }) {
  const textOf = (el) => {
    const v = el.Value;
    if (!Array.isArray(v) || !v.length) return '';
    if (v.some(x => x instanceof ArrayBuffer || ArrayBuffer.isView(x))) return '';
    return v.map(x => typeof x === 'object' ? (x?.Alphabetic ?? '') : String(x ?? '')).join('\\').trim();
  };
  const visit = (node, top) => {
    for (const [rawTag, el] of Object.entries(node || {})) {
      if (!validatorIsTagKey(rawTag) || !el || typeof el !== 'object') continue;
      const tag = validatorStripX(rawTag).toLowerCase();
      const at = top || tag;
      if (el.vr === 'SQ') {
        if (Array.isArray(el.Value)) el.Value.forEach(item => visit(item, at));
        continue;
      }
      if (el.InlineBinary || isBinaryVR(el.vr||'')) continue;
      const priv = parseInt(tag.slice(0, 4), 16) % 2 === 1;
      if (!PHI_TAGS.has(tag) && !priv) continue;
      if (priv && /^.{4}00[1-9a-f][0-9a-f]$/.test(tag) && tag.slice(4, 6) === '00') continue;  // Private Creator
      const val = textOf(el);
      if (val && !PHI_PLACEHOLDERS.has(val) && !(el.vr === 'UI' && val.startsWith('2.25.'))) {
        push('phi', at, priv ? 'Private attribute may carry identity' : 'Contains potentially identifying information',
             top ? `${fmtTag(tag)}: ${val}` : val, null);
      }
    }
  };
  visit(d, null);
}

// ---- Derived copies and presentation states ----
// Why one study looks different in two places: a CD export that converted the modality's objects,
// a grayscale image carrying colour tables, a colour map kept in a presentation state.
const vText = (d, tag) => String(lookupTag(d, tag)?.Value?.[0] ?? '').trim();
const vItems = (d, tag) => (lookupTag(d, tag)?.Value || []).filter(it => it && typeof it === 'object');
const sopName = uid => SOP_ATTRS[uid]?.name || (PR_CLASSES[uid] ? `${PR_CLASSES[uid].kind} presentation state` : uid);

// 6. Converted copies: Conversion Source Attributes (0020,9172), or a Related Series item whose
// purpose is "Alternate SOP Class instance" (DCM 121326), name the object this one was made from.
function validateConversion({ d, push }, study) {
  const sources = vItems(d, '00209172').map(it => ({
    tag: '00209172', cls: vText(it, '00081150'), sop: vText(it, '00081155'), frame: vText(it, '00081160') }));
  if (!sources.length) {
    for (const s of vItems(d, '00081250')) {
      const alt = vItems(s, '0040a170').some(c => vText(c, '00080100') === '121326');
      if (alt) for (const im of vItems(s, '00081140'))
        sources.push({ tag: '00081250', cls: vText(im, '00081150'), sop: vText(im, '00081155'), frame: vText(im, '00081160') });
    }
  }
  const src = sources.find(s => s.sop);
  if (!src) return;
  const msg = [src.frame
    ? vMsg('Converted from {cls} (frame {frame}): an export (often a CD) made this copy; it is not the object the modality stored.', { cls: sopName(src.cls), frame: src.frame })
    : vMsg('Converted from {cls}: an export (often a CD) made this copy; it is not the object the modality stored.', { cls: sopName(src.cls) })];
  if (study) {
    const loaded = study.find(e => e.dict && vText(e.dict, '00080018') === src.sop);
    msg.push(loaded
      ? vMsg('The source is loaded: {name}.', { name: loaded.name || src.sop })
      : vMsg('The source is not among the loaded files; the PACS may hold it as one object, not as this series.'));
  }
  push('info', src.tag, msg, src.sop, null);
}

// 7. Palette Color tables on a MONOCHROME image are only meant to be shown with Pixel Presentation
// (0008,9205) COLOR or MIXED (PS3.3 C.8.16.2.1.1.1); without it viewers disagree.
function validateGrayPalette({ d, push }) {
  const pi = vText(d, '00280004').toUpperCase();
  if (!/^MONOCHROME[12]$/.test(pi) || !lookupTag(d, '00281201')) return;
  const pp = vText(d, '00089205').toUpperCase();
  if (pp === 'COLOR' || pp === 'MIXED') return;
  push('warning', '00281201',
    pp ? vMsg('{pi} image carries Palette Color Lookup Tables but Pixel Presentation (0008,9205) is {pp}, not COLOR or MIXED: some viewers show it in colour, others in grey', { pi, pp })
       : vMsg('{pi} image carries Palette Color Lookup Tables but Pixel Presentation (0008,9205) is absent, not COLOR or MIXED: some viewers show it in colour, others in grey', { pi }),
    pp, null);
}

// 8. Cross-file checks, only with the loaded study: another series under the same Series Number,
// a PR whose images are missing, a PR that refers to this image.
function validateAgainstStudy({ d, push }, study) {
  const sop = vText(d, '00080018'), studyUID = vText(d, '0020000d'), seriesUID = vText(d, '0020000e');
  const others = study.filter(e => e.dict && vText(e.dict, '00080018') !== sop);

  const num = vText(d, '00200011');
  if (num && seriesUID) {
    const clash = new Map();
    for (const e of others) {
      const s = vText(e.dict, '0020000e');
      if (s && s !== seriesUID && vText(e.dict, '0020000d') === studyUID && vText(e.dict, '00200011') === num && !clash.has(s))
        clash.set(s, vText(e.dict, '0008103e'));
    }
    if (clash.size) {
      const [uid, desc] = clash.entries().next().value;
      push('warning', '00200011',
        clash.size === 1
          ? vMsg('Series Number {num} is also used by another series in this study{desc}: viewers that group by number may show only one of them', { num, desc: desc ? ` ("${desc}")` : '' })
          : vMsg('Series Number {num} is also used by {n} other series in this study{desc}: viewers that group by number may show only one of them', { num, n: clash.size, desc: desc ? ` ("${desc}")` : '' }),
        uid, null);
    }
  }

  if (PR_CLASSES[vText(d, '00080016')]) {
    const refs = prReferences(d);
    const loaded = new Set(others.map(e => vText(e.dict, '00080018')));
    const missing = refs.filter(r => !loaded.has(r.sop)).length;
    if (!refs.length) push('warning', '00081115', 'This presentation state refers to no images', '', null);
    else if (missing) push('warning', '00081115',
      vMsg('Refers to {n} image(s); {m} of them are not among the loaded files, so it cannot be shown on them', { n: refs.length, m: missing }), '', null);
    else push('info', '00081115',
      vMsg('Refers to {n} loaded image(s); open one of them and choose this presentation state in the viewer', { n: refs.length }), '', null);
    return;
  }

  for (const p of presentationStatesFor(others, sop))
    push('info', '00080018',
      p.supported
        ? vMsg('Presentation state "{label}" ({kind}) refers to this image: choose it under the viewer\'s presentation menu to see it as the modality meant', { label: p.label, kind: p.kind }, ['kind'])
        : vMsg('Presentation state "{label}" ({kind}) refers to this image; this viewer cannot apply that kind', { label: p.label, kind: p.kind }, ['kind']),
      vText(p.dict, '00080018'), null);
}

// study (optional): [{ dict, name }] for every loaded file, the open one included.
function validateDicom(d, meta, study) {
  const ctx = makeValidatorContext(d, meta);
  validateSopConformance(ctx);
  validateUidFormats(ctx);
  validateVrFormats(ctx);
  validatePixelGeometry(ctx);
  auditPhiTags(ctx);
  validateConversion(ctx, study);
  validateGrayPalette(ctx);
  if (study) validateAgainstStudy(ctx, study);
  return ctx.issues;
}

