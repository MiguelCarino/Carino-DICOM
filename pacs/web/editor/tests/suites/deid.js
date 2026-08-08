// A de-identification option has to be worth the code it writes into the file.
//
// PS3.15 Table E.1-1 carries a column per optional profile, and every option a
// tool offers gets asserted in (0012,0064) De-identification Method Code
// Sequence. That sequence is a claim: a recipient reading 113110 believes the
// UIDs in front of them are the original ones, and a recipient reading 113105
// believes somebody scrubbed the free text. So this suite checks two different
// things about every option — that ticking it changes exactly the attributes
// the standard says it changes, and that the codes recorded afterwards describe
// what actually happened rather than what was asked for.
//
// The oracle is the generated table itself (deid-profile.js, straight from the
// Innolitics machine-readable standard) plus the CID 7050 code values from
// PS3.16. Every subject file is forged carrying the tags the option under test
// covers, run through the real Anonymize button, and read back.
(window.SUITES || (window.SUITES = {})).deid = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const $ = (id) => document.getElementById(id);
  // The raw first value, not the app's display formatting: "did this UID come
  // back byte for byte" is the whole question for Retain UIDs.
  const raw  = (d, t) => { const e = lookupTag(d, t); return e && e.Value ? e.Value[0] : undefined; };
  const vals = (d, t) => { const e = lookupTag(d, t); return e && Array.isArray(e.Value) ? e.Value.map(v => String(v).trim()) : []; };
  const str  = (d, t) => { const e = lookupTag(d, t); return e ? elToString(e).trim() : undefined; };
  const has  = (d, t) => lookupTag(d, t) !== undefined && lookupTag(d, t) !== null;

  try {
    const STUDY  = '1.2.826.0.1.3680043.10.99999.13.1';
    const SERIES = STUDY + '.1';
    const SOP    = STUDY + '.1.1';
    // Numeric on purpose: dcmjs sanitizes a UI value down to digits and dots on
    // read, so a UID with letters in it would not survive the parse to be compared.
    const FOR    = STUDY + '.9.7';

    // Every attribute any of the five options touches, in one subject, so a
    // single run can be read for both what the option kept and what it did not.
    const SUBJECT = {
      '00080021': { vr: 'DA', v: ['20260102'] },        // Series Date          full-dates K, basic X/D
      '00080022': { vr: 'DA', v: ['20260103'] },        // Acquisition Date     full-dates K, basic X/Z
      '00080023': { vr: 'DA', v: ['20260104'] },        // Content Date         full-dates K, basic Z/D
      '00080055': { vr: 'AE', v: ['FORGE_STN'] },       // Station AE Title     device C, basic X
      '00080080': { vr: 'LO', v: ['Forge General'] },   // Institution Name     institution K, basic X/Z/D
      '00080081': { vr: 'ST', v: ['1 Test Way'] },      // Institution Address  institution K, basic X
      '00081010': { vr: 'SH', v: ['CT01'] },            // Station Name         device K, basic X/Z/D
      '00081040': { vr: 'LO', v: ['Radiology'] },       // Inst. Dept. Name     institution K, basic X
      '00100030': { vr: 'DA', v: ['19700301'] },        // Patient's Birth Date no option, basic Z
      '00100040': { vr: 'CS', v: ['F'] },               // Patient's Sex        patchars K, basic Z
      '00101010': { vr: 'AS', v: ['056Y'] },            // Patient's Age        patchars K, basic X
      '00101020': { vr: 'DS', v: ['1.62'] },            // Patient's Size       patchars K, basic X
      '00101030': { vr: 'DS', v: ['61.5'] },            // Patient's Weight     patchars K, basic X
      '00102160': { vr: 'SH', v: ['TEST'] },            // Ethnic Group         patchars K, basic X
      '00120031': { vr: 'LO', v: ['Site Alpha'] },      // Clinical Trial Site  institution K, basic Z
      '00181000': { vr: 'LO', v: ['SN-4711'] },         // Device Serial Number device K, basic X/Z/D
      '00181002': { vr: 'UI', v: [STUDY + '.77.1'] },   // Device UID           device K, basic U
      '0018100B': { vr: 'UI', v: [STUDY + '.77.2'] },   // Mfr Device Class UID device K, basic U
      '00200052': { vr: 'UI', v: [FOR] },               // Frame of Reference   UIDs K, basic U
      '00380500': { vr: 'LO', v: ['ambulatory'] },      // Patient State        patchars C, basic X
      '00400010': { vr: 'SH', v: ['CT01-SCHED'] },      // Sched. Station Name  device K, basic X
      '21000140': { vr: 'AE', v: ['DEST_AE'] },         // Destination AE       device C, basic D
    };
    const px = new Uint16Array(Forge.W * Forge.H);
    for (let k = 0; k < px.length; k++) px[k] = (k * 7) & 0xFFF;
    const subject = () => Forge.build({
      rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
      wc: 2048, ww: 4096, modality: 'CT',
      studyUID: STUDY, seriesUID: SERIES, sopInstance: SOP, instance: 1,
      pixels: px, extra: SUBJECT,
    });

    // Drive the real controls: the checkbox panel, the Anonymize button and the
    // confirmation it puts up. The option set is deliberately read inside that
    // click handler, and the Retain-UIDs guard around remapUIDs() lives there
    // too, so a test that called anonymize() by hand would test neither.
    const boxes = () => [...document.querySelectorAll('#deidOptionsRow input[type="checkbox"][data-opt]')];
    const setOpts = (list) => boxes().forEach(cb => { cb.checked = list.indexOf(cb.dataset.opt) >= 0; });
    const run = async (list) => {
      await handleFiles([new File([subject()], 'subject.dcm')]);
      setOpts(list);
      $('anonymizeBtn').click();
      $('confirmOk').click();
      return files[0].dict;
    };

    // ---- the generated table is the oracle everything else leans on ---------
    {
      const O = window.DEID_OPTIONS || {};
      const names = Object.keys(O);
      ok('deid-profile.js ships the ten optional-profile columns', names.length === 10, names.join(','));
      const bad = [];
      for (const n of names) for (const t of Object.keys(O[n])) if (O[n][t] !== 'K' && O[n][t] !== 'C') bad.push(`${n}/${t}=${O[n][t]}`);
      ok('every option value is one of the standard\'s K or C', bad.length === 0, bad.slice(0, 5).join(','));
      const count = (n, v) => Object.values(O[n] || {}).filter(x => x === v).length;
      ok('rtnUIDsOpt is 59 attributes, all keep',
         count('rtnUIDsOpt', 'K') === 59 && count('rtnUIDsOpt', 'C') === 0,
         `${count('rtnUIDsOpt', 'K')}K/${count('rtnUIDsOpt', 'C')}C`);
      ok('rtnInstIdOpt is 10 attributes, all keep',
         count('rtnInstIdOpt', 'K') === 10 && count('rtnInstIdOpt', 'C') === 0,
         `${count('rtnInstIdOpt', 'K')}K/${count('rtnInstIdOpt', 'C')}C`);
      ok('rtnLongFullDatesOpt is 165 attributes, all keep',
         count('rtnLongFullDatesOpt', 'K') === 165 && count('rtnLongFullDatesOpt', 'C') === 0,
         `${count('rtnLongFullDatesOpt', 'K')}K/${count('rtnLongFullDatesOpt', 'C')}C`);
      ok('rtnDevIdOpt is 46 keep and 11 clean',
         count('rtnDevIdOpt', 'K') === 46 && count('rtnDevIdOpt', 'C') === 11,
         `${count('rtnDevIdOpt', 'K')}K/${count('rtnDevIdOpt', 'C')}C`);
      ok('rtnPatCharsOpt is 9 keep and 4 clean',
         count('rtnPatCharsOpt', 'K') === 9 && count('rtnPatCharsOpt', 'C') === 4,
         `${count('rtnPatCharsOpt', 'K')}K/${count('rtnPatCharsOpt', 'C')}C`);
      // The four wholly-C options are the ones deliberately NOT offered.
      const pureC = ['cleanDescOpt', 'cleanStructContOpt', 'cleanGraphOpt', 'rtnLongModifDatesOpt']
        .filter(n => count(n, 'K') === 0 && count(n, 'C') > 0);
      ok('the four clean-only options have no keep rows at all', pureC.length === 4, pureC.join(','));
      ok('and none of them is offered in the UI',
         pureC.every(n => !(n in DEID_OPTION_CODES)) && !('rtnSafePrivOpt' in DEID_OPTION_CODES),
         Object.keys(DEID_OPTION_CODES).join(','));
      ok('the offered options are exactly the five with keep rows',
         Object.keys(DEID_OPTION_CODES).every(n => count(n, 'K') > 0) &&
         names.filter(n => count(n, 'K') > 0).length === Object.keys(DEID_OPTION_CODES).length,
         Object.keys(DEID_OPTION_CODES).join(','));
      // A count is exactly what failed to catch this. Adding the optional-profile
      // columns meant regenerating from the Innolitics extract, which tracks an
      // older edition of Annex E than the Basic Profile column here does, and 38
      // attributes went out of the table — 35 of them X. Anonymize stopped
      // removing the patient pronoun and gender-identity block, the four
      // diagnosis code sequences, two SR observer names and the waveform
      // annotator, and nothing failed, because the assertion that was supposed to
      // guard the table had been written from the regenerated file and pinned the
      // new, shorter number.
      //
      // So this names rows instead of counting them, and the floor is a floor:
      // the table may grow, and any regeneration that shrinks it fails here.
      const MUST_REMOVE = [
        '00081301', '00081302', '00081303', '00081304',       // diagnosis code sequences
        '00100011', '00100012', '00100013', '00100014', '00100015', '00100016',
        '00100033', '00100034', '00100035',                   // alternative-calendar birth date
        '00100041', '00100042', '00100043', '00100044', '00100045', '00100046', '00100047',
        '00102161', '00102162',                               // pronouns / gender identity
        '00181010', '00181011',                               // capture / hardcopy device id
        '003A0203', '003A020C',                               // waveform annotator
        '0040A034', '0040A035', '0040B034', '0040B036',        // SR observer / participant
        '0040E012', '00400556',
      ];
      const absent = MUST_REMOVE.filter(t => !window.DEID_PROFILE?.[t]);
      ok('the Basic Profile still removes every attribute a regeneration once dropped',
         absent.length === 0, absent.join(' '));
      ok('and none of them was downgraded to something that keeps a value',
         MUST_REMOVE.every(t => /^X/.test(window.DEID_PROFILE?.[t] || '')),
         MUST_REMOVE.filter(t => !/^X/.test(window.DEID_PROFILE?.[t] || ''))
           .map(t => `${t}=${window.DEID_PROFILE[t]}`).join(' '));
      ok('the table is at least as large as the edition it was curated from',
         Object.keys(window.DEID_PROFILE).length >= 656 &&
         window.DEID_PROFILE_META?.attributes === Object.keys(window.DEID_PROFILE).length,
         `${Object.keys(window.DEID_PROFILE || {}).length} attributes, meta says ${window.DEID_PROFILE_META?.attributes}`);
      ok('and it still carries the hand-added (0002,0013)',
         window.DEID_PROFILE['00020013'] === 'D', String(window.DEID_PROFILE['00020013']));
      // Verified against PS3.16 CID 7050 (UID 1.2.840.10008.6.1.925).
      const CID7050 = {
        rtnUIDsOpt: '113110', rtnDevIdOpt: '113109', rtnInstIdOpt: '113112',
        rtnPatCharsOpt: '113108', rtnLongFullDatesOpt: '113106',
      };
      ok('every offered option carries its CID 7050 code value',
         Object.keys(CID7050).every(k => DEID_OPTION_CODES[k] && DEID_OPTION_CODES[k][0] === CID7050[k]),
         Object.keys(DEID_OPTION_CODES).map(k => `${k}=${DEID_OPTION_CODES[k][0]}`).join(' '));
      ok('and the code meaning PS3.16 prints for it',
         DEID_OPTION_CODES.rtnLongFullDatesOpt[1] === 'Retain Longitudinal Temporal Information Full Dates Option' &&
         DEID_OPTION_CODES.rtnPatCharsOpt[1] === 'Retain Patient Characteristics Option',
         DEID_OPTION_CODES.rtnLongFullDatesOpt[1]);
    }

    // ---- the panel itself ---------------------------------------------------
    {
      const row = $('deidOptionsRow');
      ok('the options panel starts hidden', row.classList.contains('hidden'));
      $('deidOptsBtn').click();
      ok('the ⚙ button opens it', !row.classList.contains('hidden'));
      $('deidOptsBtn').click();
      ok('and closes it again', row.classList.contains('hidden'));
      ok('it offers one checkbox per exposed option', boxes().length === 5, String(boxes().length));
      ok('and every checkbox names an option the table knows',
         boxes().every(cb => cb.dataset.opt in DEID_OPTION_CODES && cb.dataset.opt in window.DEID_OPTIONS),
         boxes().map(cb => cb.dataset.opt).join(','));
      ok('all of them default to off, so the Basic Profile alone is the default',
         boxes().every(cb => !cb.checked));
    }

    // ---- no options: today's behaviour, unchanged ---------------------------
    {
      const d = await run([]);
      ok('the Basic Profile alone still says Patient Identity Removed = YES', str(d, '00120062') === 'YES', str(d, '00120062'));
      const seq = lookupTag(d, '00120064')?.Value || [];
      ok('and records exactly one method code', seq.length === 1, String(seq.length));
      ok('which is DCM 113100 Basic Application Confidentiality Profile',
         String(seq[0]?.['00080100']?.Value?.[0]) === '113100' &&
         String(seq[0]?.['00080102']?.Value?.[0]) === 'DCM' &&
         String(seq[0]?.['00080104']?.Value?.[0]) === 'Basic Application Confidentiality Profile',
         JSON.stringify(seq[0] || null).slice(0, 120));
      ok('(0012,0063) carries the single method value it always did',
         vals(d, '00120063').length === 1 && vals(d, '00120063')[0] === 'Carino DICOM-editor — DICOM PS3.15 Basic Profile',
         vals(d, '00120063').join(' | '));
      ok('UIDs are remapped by default', raw(d, '0020000D') !== STUDY && raw(d, '0020000E') !== SERIES &&
         raw(d, '00080018') !== SOP && raw(d, '00200052') !== FOR,
         [raw(d, '0020000D'), raw(d, '00080018')].join(' '));
      ok('institution identity is gone by default',
         str(d, '00080080') === '' && !has(d, '00080081') && !has(d, '00081040') && str(d, '00120031') === '',
         `${str(d, '00080080')}|${has(d, '00080081')}|${has(d, '00081040')}|${str(d, '00120031')}`);
      ok('device identity is gone by default',
         str(d, '00081010') === '' && str(d, '00181000') === '' && !has(d, '00400010'),
         `${str(d, '00081010')}|${str(d, '00181000')}|${has(d, '00400010')}`);
      ok('patient characteristics are gone by default',
         !has(d, '00101020') && !has(d, '00101030') && !has(d, '00102160'),
         `${has(d, '00101020')}|${has(d, '00101030')}|${has(d, '00102160')}`);
      // X/D is a dummy, not a removal, and dummyFor never fabricates a date —
      // so an emptied Series Date is what "gone" looks like here.
      ok('dates are zeroed by default', str(d, '00080020') === '' && str(d, '00080030') === '' &&
         str(d, '00080021') === '' && str(d, '00080022') === '' && str(d, '00080023') === '',
         `${str(d, '00080020')}|${str(d, '00080021')}|${str(d, '00080023')}`);
      // The usability layer, which is NOT the Retain Patient Characteristics
      // option and is documented as staying on: readable dummy name, original
      // sex, dummy age.
      ok('the readable dummy name is still applied', /\^/.test(String(raw(d, '00100010') || '')) &&
         String(raw(d, '00100010')) !== 'Forge^Test', String(raw(d, '00100010')));
      ok('the original sex is still kept for usability', str(d, '00100040') === 'F', str(d, '00100040'));
      ok('and the age is the 000Y dummy', str(d, '00101010') === '000Y', str(d, '00101010'));
      ok('the birth date is still zeroed', str(d, '00100030') === '', str(d, '00100030'));
    }

    // ---- Retain UIDs (113110) ----------------------------------------------
    {
      const d = await run(['rtnUIDsOpt']);
      ok('Retain UIDs keeps the Study Instance UID byte for byte', raw(d, '0020000D') === STUDY, String(raw(d, '0020000D')));
      ok('Retain UIDs keeps the Series Instance UID', raw(d, '0020000E') === SERIES, String(raw(d, '0020000E')));
      ok('Retain UIDs keeps the SOP Instance UID', raw(d, '00080018') === SOP, String(raw(d, '00080018')));
      // remapUIDs() rewrites every non-standard UI element regardless of the
      // profile table, so the option is only real because the click handler
      // skips that call. Frame of Reference is the one that catches a miss.
      ok('and the Frame of Reference UID, which remapUIDs would have rewritten',
         raw(d, '00200052') === FOR, String(raw(d, '00200052')));
      ok('Retain UIDs is not a bypass — the patient is still anonymized',
         String(raw(d, '00100010')) !== 'Forge^Test' && str(d, '00100020') === '',
         `${raw(d, '00100010')}|${str(d, '00100020')}`);
      const codes = (lookupTag(d, '00120064')?.Value || []).map(it => String(it?.['00080100']?.Value?.[0] || ''));
      ok('and (0012,0064) records 113100 then 113110', codes.join(',') === '113100,113110', codes.join(','));
      ok('(0012,0063) gains "Retain UIDs Option" as its own value',
         vals(d, '00120063').length === 2 && vals(d, '00120063')[1] === 'Retain UIDs Option',
         vals(d, '00120063').join(' | '));
    }

    // ---- Retain Institution Identity (113112) ------------------------------
    {
      const d = await run(['rtnInstIdOpt']);
      ok('Retain institution identity keeps Institution Name', str(d, '00080080') === 'Forge General', str(d, '00080080'));
      ok('and Institution Address, which the Basic Profile removes outright', str(d, '00080081') === '1 Test Way', str(d, '00080081'));
      ok('and Institutional Department Name', str(d, '00081040') === 'Radiology', str(d, '00081040'));
      ok('and Clinical Trial Site Name', str(d, '00120031') === 'Site Alpha', str(d, '00120031'));
      ok('but not the institution\'s patients — the UIDs still move',
         raw(d, '00080018') !== SOP, String(raw(d, '00080018')));
      const codes = (lookupTag(d, '00120064')?.Value || []).map(it => String(it?.['00080100']?.Value?.[0] || ''));
      ok('and (0012,0064) records 113112', codes.join(',') === '113100,113112', codes.join(','));
    }

    // ---- Retain Device Identity (113109) -----------------------------------
    {
      const d = await run(['rtnDevIdOpt']);
      ok('Retain device identity keeps Station Name', str(d, '00081010') === 'CT01', str(d, '00081010'));
      ok('and Device Serial Number', str(d, '00181000') === 'SN-4711', str(d, '00181000'));
      ok('and Scheduled Station Name', str(d, '00400010') === 'CT01-SCHED', str(d, '00400010'));
      // The eleven rows this option marks C are all AE Titles. Cleaning one
      // means replacing it with a value of similar meaning that identifies
      // nobody, which this tool cannot do — so they keep the Basic Profile
      // action. That removes more than the option promises, never less.
      ok('but the AE Titles it marks "clean" still follow the Basic Profile',
         !has(d, '00080055'), String(str(d, '00080055')));
      ok('including the one the Basic Profile dummies rather than deletes',
         str(d, '21000140') === 'ANONYMIZED', str(d, '21000140'));
      // PS3.15 marks Device UID and Manufacturer's Device Class UID K under this
      // option, but they are also U in the Basic Profile — and the UID remap is a
      // separate pass that walks every UI element in the file. It used to replace
      // both while the file went out asserting 113109, which is the one thing an
      // option's code must never do: claim something the file does not show.
      ok('and the two device UIDs it also marks keep', raw(d, '00181002') === STUDY + '.77.1',
         String(raw(d, '00181002')));
      ok('including Manufacturer\'s Device Class UID', raw(d, '0018100B') === STUDY + '.77.2',
         String(raw(d, '0018100B')));
      const codes = (lookupTag(d, '00120064')?.Value || []).map(it => String(it?.['00080100']?.Value?.[0] || ''));
      ok('and (0012,0064) records 113109', codes.join(',') === '113100,113109', codes.join(','));
    }

    // Without the option, the same two UIDs must still be remapped — the guard
    // has to be the option, not the tag.
    {
      const d = await run([]);
      ok('without the option the device UIDs are remapped like any other',
         raw(d, '00181002') !== STUDY + '.77.1' && !!raw(d, '00181002'), String(raw(d, '00181002')));
    }

    // ---- Retain Patient Characteristics (113108) ---------------------------
    {
      const d = await run(['rtnPatCharsOpt']);
      ok('Retain patient characteristics keeps the real Patient\'s Age, not 000Y',
         str(d, '00101010') === '056Y', str(d, '00101010'));
      ok('and Patient\'s Size', str(d, '00101020') === '1.62', str(d, '00101020'));
      ok('and Patient\'s Weight', str(d, '00101030') === '61.5', str(d, '00101030'));
      ok('and Ethnic Group', str(d, '00102160') === 'TEST', str(d, '00102160'));
      ok('and Patient\'s Sex', str(d, '00100040') === 'F', str(d, '00100040'));
      ok('but Patient State, which it marks "clean", is still removed', !has(d, '00380500'), String(str(d, '00380500')));
      // Birth date is an identifier, not a characteristic: it is in no option
      // column at all, so no combination of checkboxes can bring it back.
      ok('and the birth date is not a patient characteristic', str(d, '00100030') === '', str(d, '00100030'));
      ok('the name is still a dummy', String(raw(d, '00100010')) !== 'Forge^Test', String(raw(d, '00100010')));
      const codes = (lookupTag(d, '00120064')?.Value || []).map(it => String(it?.['00080100']?.Value?.[0] || ''));
      ok('and (0012,0064) records 113108', codes.join(',') === '113100,113108', codes.join(','));
    }

    // ---- Retain Longitudinal Temporal Information Full Dates (113106) ------
    {
      const d = await run(['rtnLongFullDatesOpt']);
      ok('Retain full dates keeps Study Date', str(d, '00080020') === '20260101', str(d, '00080020'));
      ok('and Study Time', str(d, '00080030') === '120000', str(d, '00080030'));
      ok('and Series Date, which the Basic Profile dummies away', str(d, '00080021') === '20260102', str(d, '00080021'));
      ok('and Acquisition Date', str(d, '00080022') === '20260103', str(d, '00080022'));
      ok('and Content Date', str(d, '00080023') === '20260104', str(d, '00080023'));
      ok('but not the birth date — that is identity, not longitudinal timing',
         str(d, '00100030') === '', str(d, '00100030'));
      const codes = (lookupTag(d, '00120064')?.Value || []).map(it => String(it?.['00080100']?.Value?.[0] || ''));
      ok('and (0012,0064) records 113106', codes.join(',') === '113100,113106', codes.join(','));
    }

    // ---- two at once, and the order the codes come out in -------------------
    {
      const d = await run(['rtnInstIdOpt', 'rtnUIDsOpt']);
      const codes = (lookupTag(d, '00120064')?.Value || []).map(it => String(it?.['00080100']?.Value?.[0] || ''));
      ok('two options give three method items in a fixed order',
         codes.join(',') === '113100,113110,113112', codes.join(','));
      ok('and both effects hold at once',
         raw(d, '00080018') === SOP && str(d, '00080080') === 'Forge General',
         `${raw(d, '00080018')}|${str(d, '00080080')}`);
      const meanings = vals(d, '00120063');
      ok('(0012,0063) is multi-valued rather than one long string', meanings.length === 3, meanings.join(' | '));
      // LO is 64 characters per value. 'Retain Longitudinal Temporal
      // Information Full Dates Option' is 57 of them on its own, so joining the
      // meanings would overflow the VR the moment two options were ticked.
      ok('and every value fits inside LO\'s 64 characters',
         meanings.every(v => v.length <= 64), meanings.map(v => v.length).join(','));
      ok('Patient Identity Removed is still YES with options on', str(d, '00120062') === 'YES', str(d, '00120062'));
    }

    // ---- all five ----------------------------------------------------------
    {
      const d = await run(['rtnUIDsOpt', 'rtnDevIdOpt', 'rtnInstIdOpt', 'rtnPatCharsOpt', 'rtnLongFullDatesOpt']);
      const codes = (lookupTag(d, '00120064')?.Value || []).map(it => String(it?.['00080100']?.Value?.[0] || ''));
      ok('all five options record six method items',
         codes.join(',') === '113100,113110,113109,113112,113108,113106', codes.join(','));
      ok('every item is DCM-coded',
         (lookupTag(d, '00120064')?.Value || []).every(it => String(it?.['00080102']?.Value?.[0]) === 'DCM'));
      ok('and every item carries a code meaning',
         (lookupTag(d, '00120064')?.Value || []).every(it => String(it?.['00080104']?.Value?.[0] || '').length > 10));
      // What no option can bring back: the direct identifiers.
      ok('the patient is still de-identified with everything ticked',
         String(raw(d, '00100010')) !== 'Forge^Test' && str(d, '00100020') === '' && str(d, '00100030') === '',
         `${raw(d, '00100010')}|${str(d, '00100020')}|${str(d, '00100030')}`);
    }

    // ---- unticking has to turn the option back off --------------------------
    {
      const d = await run([]);
      ok('clearing the boxes puts UID remapping back',
         raw(d, '00080018') !== SOP && raw(d, '00200052') !== FOR,
         `${raw(d, '00080018')}|${raw(d, '00200052')}`);
      ok('and the method sequence drops back to the Basic Profile alone',
         (lookupTag(d, '00120064')?.Value || []).length === 1,
         String((lookupTag(d, '00120064')?.Value || []).length));
    }

    // ---- redaction on top must not eat the option values --------------------
    // retagRedacted appends to (0012,0063). It used to read value 1 and write a
    // single concatenated string back, which would have silently dropped every
    // option meaning addDeidMeta had just recorded.
    {
      const d = await run(['rtnUIDsOpt']);
      retagRedacted(d, 1, 1);
      const meanings = vals(d, '00120063');
      ok('a redaction after anonymize keeps the option meanings',
         meanings.length === 3 && meanings[1] === 'Retain UIDs Option', meanings.join(' | '));
      ok('and appends its own note as a further value',
         meanings[2] === 'Burned-in annotation redacted', meanings.join(' | '));
      const codes = (lookupTag(d, '00120064')?.Value || []).map(it => String(it?.['00080100']?.Value?.[0] || ''));
      ok('and 113101 joins the profile codes rather than replacing them',
         codes.join(',') === '113100,113110,113101', codes.join(','));
    }

    // ---- resolveAction, directly --------------------------------------------
    {
      const before = new Set(deidOptions);
      deidOptions = new Set(['rtnUIDsOpt']);
      ok('resolveAction returns null for a tag the enabled option keeps', resolveAction('0020000D') === null, String(resolveAction('0020000D')));
      ok('and the Basic Profile action for one it does not', resolveAction('00100010') === 'Z', String(resolveAction('00100010')));
      deidOptions = new Set(['rtnDevIdOpt']);
      ok('a "clean" row falls through to the Basic Profile action', resolveAction('00080055') === 'X', String(resolveAction('00080055')));
      deidOptions = new Set();
      ok('with nothing enabled it is the Basic Profile table verbatim',
         resolveAction('0020000D') === 'U' && resolveAction('00080080') === 'X/Z/D',
         `${resolveAction('0020000D')}|${resolveAction('00080080')}`);
      ok('and an unknown tag has no action at all', resolveAction('99991234') === null, String(resolveAction('99991234')));
      deidOptions = before;
    }

    // ---- readDeidOptions only trusts options the table knows ----------------
    {
      const row = $('deidOptionsRow');
      const bogus = document.createElement('input');
      bogus.type = 'checkbox'; bogus.checked = true; bogus.dataset.opt = 'rtnSafePrivOpt';
      row.appendChild(bogus);
      setOpts([]);
      bogus.checked = true;
      const got = readDeidOptions();
      ok('a checkbox naming an option we do not implement is ignored',
         !got.has('rtnSafePrivOpt') && got.size === 0, [...got].join(','));
      row.removeChild(bogus);
      readDeidOptions();
    }
  } catch (e) {
    ok('suite ran to completion', false, (e && e.message) || String(e));
  }
  return out;
};

// Two callers: tests/run.sh injects this file alone and scrapes the <pre> below;
// index.html#selftest sets window.SELFTEST and awaits the returned lines instead.
if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.deid()).join('\n');
  document.body.appendChild(pre);
});
