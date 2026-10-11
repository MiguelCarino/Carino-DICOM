// Swap patients: two studies trade their patient and keep everything else.
//
// The case this exists for is two patients whose images were filed under each other,
// re-uploaded to a PACS that hides studies instead of deleting them. So the suite checks
// what a wrong swap would get wrong: group 0010 moves as a whole (a tag only one patient
// had must not stay behind), the acquisition does not move (dates, times, description,
// pixels), Accession Number moves only when asked, and new UIDs keep each study whole
// while sharing nothing with the originals. Everything goes through the real button and
// dialog, and the exported bytes are read back.
(window.SUITES || (window.SUITES = {})).swap = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const $ = (id) => document.getElementById(id);
  const str = (d, t) => { const e = lookupTag(d, t); return e ? elToString(e).trim() : undefined; };
  const bytes = (d) => {
    const v = lookupTag(d, '7fe00010')?.Value?.[0];
    return v ? new Uint8Array(ArrayBuffer.isView(v) ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v) : null;
  };
  const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

  try {
    const ROOT = '1.2.826.0.1.3680043.10.99999.21';
    const PATIENT_A = {
      '00100010': { vr: 'PN', v: ['SIBAJA ARREOLA^ALBERTO EMILIO'] },
      '00100020': { vr: 'LO', v: ['27957260'] },
      '00100030': { vr: 'DA', v: ['20260525'] },
      '00100040': { vr: 'CS', v: ['M'] },
      '00101010': { vr: 'AS', v: ['004M'] },
      '00104000': { vr: 'LT', v: ['only patient A has comments'] },
    };
    const PATIENT_B = {
      // Accents on purpose: the name has to survive the move and the export.
      '00100010': { vr: 'PN', v: ['NÚÑEZ ARREOLA^ISABELLA ANELISSE'] },
      '00100020': { vr: 'LO', v: ['27957371'] },
      '00100030': { vr: 'DA', v: ['20260524'] },
      '00100040': { vr: 'CS', v: ['F'] },
      '00101010': { vr: 'AS', v: ['004M'] },
    };
    const study = (patient, acc, time) => Object.assign({}, patient, {
      // Latin-1, like the CR files this was written for: the forge writes text one byte per
      // character, and dcmjs re-encodes to UTF-8 on export.
      '00080005': { vr: 'CS', v: ['ISO_IR 100'] },
      '00080050': { vr: 'SH', v: [acc] },
      '00080020': { vr: 'DA', v: ['20261008'] },
      '00080030': { vr: 'TM', v: [time] },
    });
    const px = (seed) => { const p = new Uint16Array(Forge.W * Forge.H); for (let k = 0; k < p.length; k++) p[k] = (k * seed) & 0xFFF; return p; };
    const make = (st, se, inst, extra, desc, seed) => new File([Forge.build({
      rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
      wc: 2048, ww: 4096, modality: 'CR', title: desc,
      studyUID: `${ROOT}.${st}`, seriesUID: `${ROOT}.${st}.${se}`, sopInstance: `${ROOT}.${st}.${se}.${inst}`,
      instance: inst, pixels: px(seed), extra,
    })], `${desc}-${se}-${inst}.dcm`);
    const A = study(PATIENT_A, '9L6205-8097', '073020');
    const B = study(PATIENT_B, '9L6206-8097', '081420');
    // Study 1 has two series, so new UIDs must keep two series inside one study.
    const fileSet = () => [
      make(1, 1, 1, A, 'Study A', 3), make(1, 2, 1, A, 'Study A', 5),
      make(2, 1, 1, B, 'Study B', 7),
    ];
    const ORIGINAL_UIDS = new Set();
    for (const st of [1, 2]) { ORIGINAL_UIDS.add(`${ROOT}.${st}`); for (const se of [1, 2]) { ORIGINAL_UIDS.add(`${ROOT}.${st}.${se}`); ORIGINAL_UIDS.add(`${ROOT}.${st}.${se}.1`); } }

    // Files are re-sorted on load, so find each study by what a swap must not touch.
    const byStudy = () => {
      const a = [], b = [];
      files.forEach(f => (str(f.dict, '00081030') === 'Study A' ? a : b).push(f));
      return { a, b };
    };
    const load = async (list) => { await handleFiles(list || fileSet()); };
    const openDialog = () => { $('swapPatientsBtn').click(); return $('swapOverlay').classList.contains('visible'); };

    // ---- when the button is offered ----------------------------------------
    {
      await handleFiles([fileSet()[0]]);
      ok('one study: Swap patients is disabled', $('swapPatientsBtn').disabled === true);
      await load([...fileSet(), make(3, 1, 1, B, 'Study C', 9)]);
      ok('three studies: still disabled (no telling which two)', $('swapPatientsBtn').disabled === true);
      await load();
      ok('two studies: enabled', $('swapPatientsBtn').disabled === false);
    }

    // ---- the dialog previews before anything is written ---------------------
    {
      await load();
      ok('the button opens the swap dialog', openDialog());
      const rows = [...$('swapRows').querySelectorAll('tr')];
      const cells = (label) => {
        const r = rows.find(tr => tr.querySelector('th').textContent.replace(/^⇄ /, '') === T(label));
        return r ? [...r.querySelectorAll('td')].map(td => td.textContent) : [];
      };
      const sides = cells('Patient ID').sort().join(' | ');
      ok('it shows both patient IDs', sides === '27957260 | 27957371', sides);
      ok('dates are written out', cells('Date of Birth').includes('2026-05-25'), cells('Date of Birth').join(' | '));
      ok('and the file count per study', cells('Files').sort().join(',') === '1,2', cells('Files').join(','));
      const marked = rows.filter(tr => tr.classList.contains('swap-moves')).map(tr => tr.querySelector('th').textContent);
      ok('only the five patient rows are marked ⇄ by default', marked.length === 5 && marked.every(t => t.startsWith('⇄ ')), marked.join(' | '));
      ok('Accession Number is off by default', $('swapAccession').checked === false);
      ok('new UIDs are on by default', $('swapNewUIDs').checked === true);
      $('swapAccession').click();
      const acc = [...$('swapRows').querySelectorAll('tr.swap-moves th')].some(th => th.textContent === '⇄ ' + T('Accession Number'));
      ok('ticking Accession marks its row', acc);
      ok('no warning for two different patients', $('swapWarn').classList.contains('hidden'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      ok('Escape closes it', !$('swapOverlay').classList.contains('visible'));
      const { a } = byStudy();
      ok('and nothing was swapped', str(a[0].dict, '00100020') === '27957260', str(a[0].dict, '00100020'));
      openDialog();
      $('swapCancel').click();
      ok('Cancel closes it too, without swapping', !$('swapOverlay').classList.contains('visible') && str(byStudy().a[0].dict, '00100020') === '27957260');
    }

    // ---- default swap: patient moves, acquisition stays, new UIDs ------------
    {
      await load();
      const before = byStudy();
      const pixA = before.a.map(f => bytes(f.dict)), pixB = before.b.map(f => bytes(f.dict));
      // An edit typed into the table but not exported yet must travel with the swap, not vanish.
      const nameKey = [...pendingOf(before.b[0]).keys()].find(k => canonTag(k) === '00100010');
      pendingOf(before.b[0]).set(nameKey, { vr: 'PN', valueString: 'NÚÑEZ ARREOLA^ISABELLA' });
      const descKey = [...pendingOf(before.a[0]).keys()].find(k => canonTag(k) === '00081030');
      pendingOf(before.a[0]).set(descKey, { vr: 'LO', valueString: 'Study A' });   // same value: keeps byStudy working
      const seriesKey = [...pendingOf(before.a[1]).keys()].find(k => canonTag(k) === '0008103E');
      if (seriesKey) pendingOf(before.a[1]).set(seriesKey, { vr: 'LO', valueString: 'kept edit' });
      else pendingOf(before.a[1]).set('0008103E', { vr: 'LO', valueString: 'kept edit' });

      openDialog();
      $('swapOk').click();
      const { a, b } = byStudy();
      ok('the dialog closes on Swap', !$('swapOverlay').classList.contains('visible'));
      ok("study A's files now carry patient B (with the unexported name edit)",
         a.every(f => str(f.dict, '00100020') === '27957371' && str(f.dict, '00100010') === 'NÚÑEZ ARREOLA^ISABELLA'
                   && str(f.dict, '00100030') === '20260524' && str(f.dict, '00100040') === 'F'),
         a.map(f => `${str(f.dict, '00100020')} ${str(f.dict, '00100010')}`).join(' | '));
      ok("study B's file now carries patient A",
         b.every(f => str(f.dict, '00100020') === '27957260' && str(f.dict, '00100010') === 'SIBAJA ARREOLA^ALBERTO EMILIO' && str(f.dict, '00100040') === 'M'),
         b.map(f => str(f.dict, '00100010')).join(' | '));
      ok("a tag only patient A had leaves with patient A", a.every(f => lookupTag(f.dict, '00104000') == null) &&
         b.every(f => str(f.dict, '00104000') === 'only patient A has comments'));
      ok('Accession Number stays with its images', a.every(f => str(f.dict, '00080050') === '9L6205-8097') && b.every(f => str(f.dict, '00080050') === '9L6206-8097'));
      ok('study time stays with its images', a.every(f => str(f.dict, '00080030') === '073020') && b.every(f => str(f.dict, '00080030') === '081420'));
      ok('an unrelated unexported edit survives', str(before.a[1].dict, '0008103E') === 'kept edit', str(before.a[1].dict, '0008103E'));
      ok('pixels are byte-for-byte unchanged', a.every((f, i) => same(bytes(f.dict), pixA[i])) && b.every((f, i) => same(bytes(f.dict), pixB[i])));

      const uidsOf = (fs, t) => new Set(fs.map(f => str(f.dict, t)));
      const all = [...a, ...b];
      ok('no original study, series or SOP UID remains',
         all.every(f => ['0020000D', '0020000E', '00080018'].every(t => !ORIGINAL_UIDS.has(str(f.dict, t)))));
      ok('each study still has exactly one Study Instance UID', uidsOf(a, '0020000D').size === 1 && uidsOf(b, '0020000D').size === 1);
      ok('and the two studies stay apart', [...uidsOf(a, '0020000D')][0] !== [...uidsOf(b, '0020000D')][0]);
      ok('study A keeps two distinct series', uidsOf(a, '0020000E').size === 2);
      ok('the SOP Class UID is a standard UID and is left alone', all.every(f => str(f.dict, '00080016') === '1.2.840.10008.5.1.4.1.1.7'));
      ok('Undo is cleared, since it cannot reverse a swap', $('undoBtn').disabled === true && editHistory.length === 0);
      const toastEl = document.querySelector('.toast');
      ok('it toasts', toastEl && toastEl.textContent === T('Patients swapped'), toastEl && toastEl.textContent);

      // What a PACS receives: the exported bytes, read back by dcmjs.
      const back = DicomMessage.readFile(await buildEditedFile(a[0]).arrayBuffer());
      ok('the exported file carries patient B, accents intact', str(back.dict, '00100010') === 'NÚÑEZ ARREOLA^ISABELLA', str(back.dict, '00100010'));
      ok("and its File Meta SOP Instance UID matches the new SOP Instance UID",
         String(back.meta['00020003']?.Value?.[0]) === str(back.dict, '00080018'));
      ok('and its pixels match the original', same(bytes(back.dict), pixA[0]));
    }

    // ---- Accession on, new UIDs off ----------------------------------------
    {
      await load();
      openDialog();
      $('swapAccession').click();
      $('swapNewUIDs').click();
      $('swapOk').click();
      const { a, b } = byStudy();
      ok('with the box ticked, Accession Number moves with the patient',
         a.every(f => str(f.dict, '00080050') === '9L6206-8097') && b.every(f => str(f.dict, '00080050') === '9L6205-8097'));
      ok('with new UIDs off, the original UIDs are kept',
         a.every(f => str(f.dict, '0020000D') === `${ROOT}.1`) && b.every(f => str(f.dict, '0020000D') === `${ROOT}.2`));
      ok('the patient still moves', str(a[0].dict, '00100020') === '27957371' && str(b[0].dict, '00100020') === '27957260');
    }

    // ---- same patient on both sides: warn, do not block ----------------------
    {
      const twin = Object.assign({}, B, { '00100010': { vr: 'PN', v: ['NÚÑEZ^ARREOLA^ISABELLA^ANELISSE'] } });
      await load([make(1, 1, 1, A, 'Study A', 3), make(1, 2, 1, Object.assign({}, A, PATIENT_B), 'Study A', 5), make(2, 1, 1, twin, 'Study B', 7)]);
      openDialog();
      const warn = [...$('swapWarn').querySelectorAll('li')].map(li => li.textContent);
      ok('mixed patient IDs inside one study are flagged', warn.some(w => w === T("Study {n} holds files with different Patient IDs. Every file in it gets the other study's patient.").replace('{n}', '1')), warn.join(' | '));
      $('swapCancel').click();
      await load([make(1, 1, 1, B, 'Study A', 3), make(2, 1, 1, twin, 'Study B', 7)]);
      openDialog();
      const w2 = [...$('swapWarn').querySelectorAll('li')].map(li => li.textContent);
      ok('the same Patient ID on both sides is flagged', !$('swapWarn').classList.contains('hidden') && w2.some(w => w.includes('27957371')), w2.join(' | '));
      ok('but Swap stays available', $('swapOk').disabled === false);
      $('swapOk').click();
      const spelled = byStudy().a.map(f => str(f.dict, '00100010')).join(' | ');
      ok('and only the name spelling moves', spelled === 'NÚÑEZ^ARREOLA^ISABELLA^ANELISSE', spelled);
      const back = DicomMessage.readFile(await buildEditedFile(byStudy().a[0]).arrayBuffer());
      ok('a Latin-1 name exports intact', str(back.dict, '00100010') === 'NÚÑEZ^ARREOLA^ISABELLA^ANELISSE', str(back.dict, '00100010'));
    }

    // ---- i18n ----------------------------------------------------------------
    {
      const NEW_STRINGS = [
        '⇄ Swap patients', 'Swap the patient details between two loaded studies. Load exactly two studies.',
        'Swap patients between two studies',
        "Each study keeps its images, dates, times and description, and takes the other study's patient. Rows marked ⇄ are swapped.",
        'Study 1', 'Study 2', 'Also swap Accession Number', 'Give both studies new UIDs',
        'New UIDs stop a PACS that hides studies instead of deleting them from merging the upload into the old study.',
        'Undo cannot reverse a swap. Nothing is saved until you download.', '⇄ Swap', 'Study Time', 'Files',
        'Both studies already have Patient ID {id}, so only the way the details are written will change.',
        "Study {n} holds files with different Patient IDs. Every file in it gets the other study's patient.",
        'Patients swapped',
        'Patient Name', 'Patient ID', 'Date of Birth', 'Sex', 'Age', 'Accession Number', 'Study Date', 'Study Description',
      ];
      for (const loc of ['es', 'pt-BR', 'ja', 'ru']) {
        const missing = NEW_STRINGS.filter(s => !I18N[loc] || !I18N[loc][s] ||
          ['{n}', '{id}'].some(p => s.includes(p) && !I18N[loc][s].includes(p)));
        ok(`i18n: every Swap patients string is translated into ${loc}`, missing.length === 0, missing.join(' | ').slice(0, 160));
      }
      ok('the button title is translated', ATTR_I18N.some(([id, attr]) => id === 'swapPatientsBtn' && attr === 'title'));
    }
  } catch (e) {
    ok('suite ran to completion', false, (e && e.stack) || String(e));
  }
  return out;
};

// Two callers: tests/run.sh injects this file alone and scrapes the <pre> below;
// index.html#selftest sets window.SELFTEST and awaits the returned lines instead.
if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.swap()).join('\n');
  document.body.appendChild(pre);
});
