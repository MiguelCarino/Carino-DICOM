// A study is a stack, not a pile of files.
//
// Three things had to become true at once for the viewer to behave like the
// PACS viewers people arrive here from. Files have to arrive in series/instance
// order, because a wheel that pages through interleaved acquisitions is worse
// than no wheel at all. The wheel has to page rather than zoom, and it has to
// do that WITHOUT throwing away the window/level the reader just dialled in —
// which the Overview's render path used to reset unconditionally on every file
// change. And a multi-frame file has to play, which turns loadImage's existing
// out-of-order-paint race from an occasional slider glitch into something that
// happens thirty times a second.
//
// The oracle here is the drop order itself: the suite hands the real handler a
// deliberately scrambled study and checks what comes back out.
(window.SUITES || (window.SUITES = {})).series = async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ' :: ' + extra : ''}`);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // Almost everything here is kicked off by a fire-and-forget loadImage(), so
  // poll for the condition rather than guessing how long a decode takes.
  const settle = async (cond, ms = 3000) => {
    for (let i = 0; i * 10 < ms; i++) { if (cond()) return true; await sleep(10); }
    return !!cond();
  };
  const tag = (d, t) => { const e = lookupTag(d, t); return e ? elToString(e).trim() : ''; };
  const $ = (id) => document.getElementById(id);

  const realDecode = window.decodeDicomPixels;

  try {
    const STUDY = '1.2.826.0.1.3680043.10.99999.12.1';
    const px = (seed) => {
      const n = Forge.W * Forge.H;
      const a = new Uint16Array(n);
      for (let k = 0; k < n; k++) a[k] = (k + seed * 211) & 0xFFF;
      return a;
    };
    // One slice of series `s`, instance `i`. `extra` is merged last by Forge, so
    // a case can blank out a number the builder always writes.
    const slice = (s, i, cfg = {}) => Forge.build({
      rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
      wc: 2048, ww: 4096, modality: 'CT',
      studyUID: cfg.studyUID || STUDY,
      seriesUID: cfg.seriesUID || `${STUDY}.${s}`,
      instance: i,
      sopInstance: cfg.sopInstance || `${STUDY}.${s}.${i}`,
      pixels: px(s * 10 + i),
      extra: Object.assign({ '00200011': { vr: 'IS', v: [String(s)] } }, cfg.extra || {}),
    });

    // ---- the sort on load ---------------------------------------------------
    // Dropped in the worst plausible order: the second series first, and the
    // last instance of each series ahead of the rest of it.
    const scrambled = [
      ['s2-i3.dcm', slice(2, 3)], ['s2-i1.dcm', slice(2, 1)], ['s2-i2.dcm', slice(2, 2)],
      ['s1-i3.dcm', slice(1, 3)], ['s1-i1.dcm', slice(1, 1)], ['s1-i2.dcm', slice(1, 2)],
    ];
    await handleFiles(scrambled.map(([n, b]) => new File([b], n)));

    ok('the scrambled study loads', files.length === 6, String(files.length));
    const order = files.map(f => `${tag(f.dict, '00200011')}/${tag(f.dict, '00200013')}`).join(',');
    ok('a study is sorted by series number, then instance number',
       order === '1/1,1/2,1/3,2/1,2/2,2/3', order);
    ok('and the first image of the first series is the one on screen',
       currentFileIdx === 0 && tag(dict, '00080018') === `${STUDY}.1.1`, tag(dict, '00080018'));

    // ---- grouping, after the sort ------------------------------------------
    {
      const series = groupSeries();
      ok('the two series are still two series', series.length === 2, String(series.length));
      ok('and each one is now a contiguous run of indices',
         series.every(s => s.indices.every((v, i, a) => i === 0 || v === a[i - 1] + 1)),
         series.map(s => s.indices.join('')).join(' | '));
      ok('one study groups as one study', groupStudies().length === 1, String(groupStudies().length));
    }

    // ---- the study-aware counter -------------------------------------------
    {
      // Through t(), not against the English: this suite also runs inside
      // index.html#selftest, in whatever language the visitor is reading in.
      const T = window.t || String;
      const label = $('ovStudyIdx').textContent;
      ok('the Overview counter names the series and the image within it',
         label.includes(`${T('Series')} 1 / 2`) && label.includes(`${T('Image')} 1 / 3`), label);
      ok('and it does not name a study when there is only one',
         !label.includes(T('Study')), label);
    }

    // ---- two studies in one drop -------------------------------------------
    {
      const OTHER = '1.2.826.0.1.3680043.10.99999.12.9';
      await handleFiles([
        new File([slice(1, 1, { studyUID: OTHER, seriesUID: OTHER + '.1', sopInstance: OTHER + '.1.1' })], 'b.dcm'),
        new File([slice(1, 1)], 'a.dcm'),
      ]);
      ok('two studies group as two', groupStudies().length === 2, String(groupStudies().length));
      const label = $('ovStudyIdx').textContent;
      ok('and the counter says which study is on screen',
         label.includes(`${(window.t || String)('Study')} 1 / 2`), label);
    }

    // ---- the fallbacks ------------------------------------------------------
    // Nothing numbered at all: a PACS export whose only ordering information is
    // the counter in the filename. img9 must not sort after img10.
    {
      const bare = (name) => new File([slice(1, 1, {
        sopInstance: `${STUDY}.0.${name}`,
        extra: { '00200011': { vr: 'IS', v: [''] }, '00200013': { vr: 'IS', v: [''] } },
      })], name);
      await handleFiles([bare('img10.dcm'), bare('img9.dcm'), bare('img1.dcm')]);
      ok('unnumbered files fall back to a natural filename sort',
         files.map(f => f.name).join(',') === 'img1.dcm,img9.dcm,img10.dcm',
         files.map(f => f.name).join(','));
    }

    // Stable: files that tie on all three keys keep the order they were dropped
    // in, so a re-sort can never shuffle a study that was already right.
    {
      const same = (n) => new File([slice(1, 1, { sopInstance: `${STUDY}.7.${n}` })], 'same.dcm');
      await handleFiles([same(3), same(1), same(2)]);
      ok('a three-way tie keeps drop order',
         files.map(f => tag(f.dict, '00080018').split('.').pop()).join(',') === '3,1,2',
         files.map(f => tag(f.dict, '00080018').split('.').pop()).join(','));
    }

    // ---- paging the stack ---------------------------------------------------
    await handleFiles(scrambled.map(([n, b]) => new File([b], n)));
    const V = window.ovView.view;

    {
      ovStackStep(1);
      ok('a stack step moves to the next image of the series', currentFileIdx === 1, String(currentFileIdx));
      ovStackStep(-1);
      ok('and back again', currentFileIdx === 0, String(currentFileIdx));
      ovStackStep(-1);
      ok('the first image of a series is a floor', currentFileIdx === 0, String(currentFileIdx));

      // The one that matters: a flick at the end of a series must not carry the
      // reader into a different acquisition without them noticing.
      switchFile(2);
      await settle(() => $('ovCanvas').width === Forge.W);
      ovStackStep(1);
      ok('a stack step does not walk off the end of its series into the next',
         currentFileIdx === 2, String(currentFileIdx));
      ok('and the second series is still reachable another way',
         groupSeries()[1].indices[0] === 3, groupSeries()[1].indices.join(','));
    }

    // ---- what a stack step keeps, and what a file change resets -------------
    {
      switchFile(0);
      await settle(() => $('ovCanvas').width === Forge.W);
      V.wc = 1234; V.ww = 999; V.zoom = 3; V.invert = true; V.cmap = 'hot';
      ovStackStep(1);
      await settle(() => currentFileIdx === 1);
      await sleep(60);
      ok('paging within a series keeps the window/level the reader set',
         V.wc === 1234 && V.ww === 999, `${V.wc}/${V.ww}`);
      ok('and the zoom, the inversion and the colormap with it',
         V.zoom === 3 && V.invert === true && V.cmap === 'hot',
         `${V.zoom}/${V.invert}/${V.cmap}`);

      // Anything that is not a stack step is still a new file, and still starts
      // clean — otherwise a CT window would follow the reader onto an ultrasound.
      switchFile(3);
      await settle(() => $('ovCanvas').width === Forge.W && V.wc !== 1234);
      ok('moving to another series resets the view',
         V.zoom === 1 && V.invert === false && V.cmap === 'gray',
         `${V.zoom}/${V.invert}/${V.cmap}`);
      ok('and re-derives the window from the new file',
         V.wc === 2048 && V.ww === 4096, `${V.wc}/${V.ww}`);
    }

    // ---- the Edit tab catches up -------------------------------------------
    // The light path deliberately skips renderTable, which is the expensive half
    // of a file switch and is behind a hidden tab. It has to be caught up before
    // that tab is shown, or the table would describe the slice scrolled away from.
    {
      switchFile(0);
      await settle(() => $('ovCanvas').width === Forge.W);
      switchTab('editor');
      switchTab('overview');
      ovStackStep(1);
      // Values live in the row inputs, not in the table's text.
      const tableHas = (v) => [...tagBody.querySelectorAll('input')].some(i => i.value === v);
      ok('a stack step marks the tag table stale', editorStale === true, String(editorStale));
      ok('and leaves it showing the file it was drawn for',
         tableHas(`${STUDY}.1.1`) && !tableHas(`${STUDY}.1.2`), 'table already redrawn');
      switchTab('editor');
      ok('opening the Edit tab redraws it for the current file',
         editorStale === false && tableHas(`${STUDY}.1.2`), String(editorStale));
      switchTab('overview');
    }

    // ---- the wheel ----------------------------------------------------------
    {
      const viewer = $('ovViewer');
      const wheel = (opts) => viewer.dispatchEvent(new WheelEvent('wheel', Object.assign({ bubbles: true, cancelable: true }, opts)));
      // Bare-wheel paging is deferred to the next animation frame, and headless
      // Chromium under --virtual-time-budget never produces one (measured: zero
      // rAF callbacks in a second of virtual time), so the flush is driven here.
      const flick = (n, dy) => { for (let i = 0; i < n; i++) wheel({ deltaY: dy }); window.ovWheelFlush(); };

      switchFile(0);
      await settle(() => $('ovCanvas').width === Forge.W);
      const zoomBefore = V.zoom;
      wheel({ deltaY: -120, ctrlKey: true });
      ok('ctrl+wheel still zooms', V.zoom > zoomBefore, `${zoomBefore} -> ${V.zoom}`);
      ok('and does not page the stack', currentFileIdx === 0, String(currentFileIdx));
      const zoomAfter = V.zoom;
      wheel({ deltaY: -120, metaKey: true });
      ok('cmd+wheel zooms too, so a trackpad pinch does', V.zoom > zoomAfter, `${zoomAfter} -> ${V.zoom}`);

      flick(1, 120);
      ok('a bare wheel pages the stack', currentFileIdx === 1, String(currentFileIdx));
      ok('and leaves the zoom alone while doing it', V.zoom > 1, String(V.zoom));
      flick(1, -120);
      ok('and pages back', currentFileIdx === 0, String(currentFileIdx));

      // A trackpad flick is dozens of events; they coalesce into one apply per
      // animation frame instead of dozens of decodes queued behind each other.
      flick(20, 40);
      ok('a burst of wheel events coalesces into one clamped step',
         currentFileIdx === 2, String(currentFileIdx));
      flick(20, -40);
      ok('and a burst the other way comes back to the start of the series',
         currentFileIdx === 0, String(currentFileIdx));
    }

    // ---- cine ---------------------------------------------------------------
    const C = window.ovCine.state;
    const F = 6;
    {
      const n = Forge.W * Forge.H;
      const frames = new Uint16Array(n * F);
      for (let f = 0; f < F; f++) for (let k = 0; k < n; k++) frames[f * n + k] = (k + f * 400) & 0xFFF;
      const multi = Forge.build({
        rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
        wc: 2048, ww: 4096, modality: 'XA', frames: F, pixels: frames,
      });
      await handleFiles([new File([multi], 'cine.dcm')]);
      await settle(() => $('ovCanvas').width === Forge.W);

      ok('a multi-frame file shows the frame nav',
         !$('ovFrameNav').classList.contains('hidden'), $('ovFrameNav').className);

      // Inside a multi-frame file the wheel pages FRAMES, not files.
      ovStackStep(1);
      ok('a stack step inside a multi-frame file steps the frame',
         V.frame === 1 && currentFileIdx === 0, `${V.frame}/${currentFileIdx}`);
      ok('and the frame label follows it', $('ovFrameLabel').textContent === '2/6', $('ovFrameLabel').textContent);
      ovStackStep(99);
      ok('the last frame is a ceiling', V.frame === F - 1, String(V.frame));

      // Playback with loop off is the deterministic case: it runs to the end and
      // parks there.
      V.frame = 0; C.loop = false; C.fps = 30;
      window.ovCine.start();
      ok('playback marks itself playing', C.playing === true, String(C.playing));
      const ran = await settle(() => !C.playing, 4000);
      ok('cine without loop plays to the last frame and stops',
         ran && V.frame === F - 1, `${V.frame} playing=${C.playing}`);
      ok('and leaves no timer behind', C.timer === null, String(C.timer));

      // With loop on it wraps rather than stopping.
      V.frame = F - 1; C.loop = true; C.fps = 12;
      window.ovCine.start();
      const wrapped = await settle(() => V.frame === 0, 4000);
      ok('cine loops back to the first frame', wrapped, String(V.frame));
      window.ovCine.stop();
      await sleep(80);
      const held = V.frame;
      await sleep(300);
      ok('stopping cine really stops it', V.frame === held && !C.playing, `${held} -> ${V.frame}`);

      // Reaching for the slider is a request to look at one frame.
      window.ovCine.start();
      const fs = $('ovFrame');
      fs.value = '2';
      fs.dispatchEvent(new Event('input', { bubbles: true }));
      ok('dragging the frame slider stops playback', C.playing === false, String(C.playing));

      // Leaving the tab must not leave a decode loop running behind it.
      window.ovCine.start();
      switchTab('editor');
      ok('leaving the Overview stops playback', C.playing === false, String(C.playing));
      switchTab('overview');
    }

    // ---- the frame rate the file asks for -----------------------------------
    {
      const rated = async (extra) => {
        const b = Forge.build({
          rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 8, bs: 8, hb: 7, pr: 0,
          modality: 'XA', pixels: new Uint8Array(Forge.W * Forge.H), extra,
        });
        await handleFiles([new File([b], 'rate.dcm')]);
        await settle(() => $('ovCanvas').width === Forge.W);
        return window.ovCine.rate();
      };
      ok('Recommended Display Frame Rate is honoured',
         await rated({ '00082144': { vr: 'IS', v: ['20'] } }) === 20);
      ok('Frame Time in milliseconds becomes a rate',
         await rated({ '00181063': { vr: 'DS', v: ['40'] } }) === 25);
      ok('Cine Rate is honoured', await rated({ '00180040': { vr: 'IS', v: ['12'] } }) === 12);
      ok('a file that states no rate plays at the default 15', await rated({}) === 15);
      // PS3.3 C.7.6.5: the recommended display rate is what the acquisition
      // states for playback, so it wins over the per-frame duration.
      ok('Recommended Display Frame Rate outranks Frame Time',
         await rated({ '00082144': { vr: 'IS', v: ['20'] }, '00181063': { vr: 'DS', v: ['40'] } }) === 20);
      // Nothing in DICOM stops a file asking for 500 fps.
      ok('an absurd rate is clamped', await rated({ '00082144': { vr: 'IS', v: ['500'] } }) === 60);
      ok('and the fps box is seeded from the file',
         $('ovCineFps').value === '60', $('ovCineFps').value);

      // An emptied fps box must not become a NaN interval, which setTimeout
      // treats as 0 — a busy loop decoding frames as fast as it can.
      const fps = $('ovCineFps');
      fps.value = '';
      fps.dispatchEvent(new Event('change', { bubbles: true }));
      ok('an emptied fps box falls back to the default', C.fps === 15 && fps.value === '15', `${C.fps}/${fps.value}`);
      fps.value = '900';
      fps.dispatchEvent(new Event('change', { bubbles: true }));
      ok('and a typed-in absurdity is clamped', C.fps === 60 && fps.value === '60', `${C.fps}/${fps.value}`);
    }

    // ---- the out-of-order paint --------------------------------------------
    // Two decodes in flight, the earlier one slower. Without the generation
    // guard the stale frame lands last and the viewer shows the frame the user
    // scrolled PAST. Cine only made this constant; the slider could already do it.
    {
      const n = Forge.W * Forge.H;
      const flat = new Uint16Array(n * 4);
      const src = Forge.build({
        rows: Forge.H, cols: Forge.W, pi: 'MONOCHROME2', ba: 16, bs: 12, hb: 11, pr: 0,
        wc: 2048, ww: 4096, modality: 'XA', frames: 4, pixels: flat,
      });
      await handleFiles([new File([src], 'race.dcm')]);
      await settle(() => $('ovCanvas').width === Forge.W);

      // A decoder whose latency depends on the frame, so "slow early frame" is
      // reproducible instead of a matter of luck.
      const SLOW = 1, FAST = 3;
      window.decodeDicomPixels = async (d, frame, opts) => {
        await sleep(frame === SLOW ? 400 : 5);
        return { rawFloats: new Float32Array(n).fill(frame * 100), rows: Forge.H, cols: Forge.W,
                 mn: 0, mx: 400, wcTag: 200, wwTag: 400, invert: false, numFrames: 4 };
      };
      // Fix the window so the painted grey depends only on the frame.
      V.wc = 200; V.ww = 400; V.invert = false; V.cmap = 'gray'; V.zoom = 1;

      const fs = $('ovFrame');
      const pick = (f) => { fs.value = String(f); fs.dispatchEvent(new Event('input', { bubbles: true })); };
      const grey = () => $('ovCanvas').getContext('2d').getImageData(0, 0, 1, 1).data[0];

      pick(SLOW); await sleep(600);
      const greySlow = grey();
      pick(FAST); await sleep(200);
      const greyFast = grey();
      ok('the two frames paint differently to begin with', greySlow !== greyFast, `${greySlow} vs ${greyFast}`);

      // Now both at once: the slow frame is asked for first and answers last.
      pick(SLOW);
      pick(FAST);
      await sleep(800);
      ok('a slow earlier frame cannot paint over a fast later one',
         grey() === greyFast, `${grey()} want ${greyFast}`);
    }
  } catch (e) {
    ok('suite ran to completion', false, (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  } finally {
    window.decodeDicomPixels = realDecode;
  }

  return out;
};

// Two callers: tests/run.sh injects this file alone and scrapes the <pre> below;
// index.html#selftest sets window.SELFTEST and awaits the returned lines instead.
if (!window.SELFTEST) window.addEventListener('load', async () => {
  const pre = document.createElement('pre');
  pre.id = 'TESTOUT';
  pre.textContent = (await window.SUITES.series()).join('\n');
  document.body.appendChild(pre);
});
