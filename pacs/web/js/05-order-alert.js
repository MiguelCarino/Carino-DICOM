/* Emergency-RIS order arrival alert: announcement, arrival beep (WebAudio) and the status poll. */
"use strict";
  // ---- Order arrival ----
  /* Announced on several surfaces: nav row + badge flash, RIS LED/chip (only while HL7 runs),
     a polite live region, the beep, and an Orders repaint. Not flashNote(), which is reserved
     for the outcome of the operator's own click. */

  // Restart-animation trick as in blink()/pulseChip(), without a "running" guard.
  function pulseAlert(id) {
    const el = $(id);
    if (!el || el.hidden) return;
    el.classList.remove("alert");
    void el.offsetWidth;
    el.classList.add("alert");
  }

  let arrivalClear = null, arrivalPaint = null, arrivalPending = 0;
  /* #ordAlertLive has no data-i18n so the language pass can't overwrite it. Emptied, then
     written 50 ms later, because NVDA/JAWS skip an identical repeated sentence. setTimeout,
     not rAF, which pauses in background tabs. Cleared after 5 s. */
  function announceArrival(n) {
    const el = $("ordAlertLive");
    if (!el) return;
    clearTimeout(arrivalClear);
    el.textContent = "";
    // Arrivals within the blank window add up rather than replace each other.
    arrivalPending += n;
    if (arrivalPaint) return;
    arrivalPaint = setTimeout(() => {
      const total = arrivalPending;
      arrivalPending = 0;
      arrivalPaint = null;
      el.textContent = TN(total, "{n} new orders");
      arrivalClear = setTimeout(() => { el.textContent = ""; }, 5000);
    }, 50);
  }

  // Arrivals while the tab was hidden (the CSS flash plays unseen); re-flashed on return.
  let hiddenArrivals = 0;

  function onOrderArrived(n) {
    // Nobody to tell behind the sign-in prompt (baselines are dropped too).
    if (gateOpen) return;
    if (document.hidden) hiddenArrivals += n;
    // Flash the nav row too: the badge hides at zero, e.g. an order created and matched within one poll.
    pulseAlert("navOrders");
    pulseAlert("ordersBadge");
    blink($("rsDot"));
    pulseChip("rs");
    announceArrival(n);
    beepNewOrder();
  }

  /* On return to the tab: poll at once (Chrome throttles hidden-tab timers to 1/min after
     5 min), then re-flash arrivals that landed unseen. No second beep: it already played. */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    pollStatus();
    const n = hiddenArrivals;
    hiddenArrivals = 0;
    if (!n || gateOpen) return;
    pulseAlert("navOrders");
    pulseAlert("ordersBadge");
    announceArrival(n);
  });

  // ---- Arrival beep ----
  /* Per-workstation preference in localStorage: the roles that need it lack config.read.
     As in carino-lang.js: store only the deviation, try/catch every access (private mode throws). */
  const BEEP_KEY = "carino_pacs_order_beep";
  function beepOn() {
    // Unreadable storage defaults to sound ON: an alert must fail loud.
    try { return localStorage.getItem(BEEP_KEY) !== "off"; } catch (e) { return true; }
  }
  function setBeepOn(on) {
    try { on ? localStorage.removeItem(BEEP_KEY) : localStorage.setItem(BEEP_KEY, "off"); } catch (e) { /* private mode */ }
  }

  /* Synthesised with WebAudio (no sound file to lose). Not the Notification API: over plain HTTP
     non-localhost pages are insecure contexts, where notifications are unavailable. */
  let actx = null, audioFailed = false, beepFreeAt = 0;
  /* beepDueBy: deadline for a tone owed while the context wasn't running (0 = none). Monotonic
     clock: the audio clock may be stopped and the wall clock may step (NTP/RTC). */
  const monoNow = () => (window.performance && performance.now ? performance.now() : Date.now());
  let beepDueBy = 0;
  // Number of owed tones (two arrivals = two chirps); the deadline follows the newest arrival.
  let beepOwed = 0;

  // Can a tone play right now? A "suspended" context (awaiting a gesture) cannot.
  function audioReady() { return !!(actx && actx.state === "running"); }

  function armAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        audioFailed = true;                   // no WebAudio: silent, but the button says so
      } else {
        // Chromium closes the context when the output device disappears (USB speaker
        // unplugged); a closed context can't resume, so build a fresh one.
        if (!actx || actx.state === "closed") {
          actx = new AC();
          // New context's currentTime starts at 0; a stale beepFreeAt would drop every beep.
          beepFreeAt = 0;
          // Repaint the button as soon as the context stops (or starts) being able to play.
          actx.onstatechange = afterArm;
        }
        audioFailed = false;
        // resume() settles later. Older Safari's webkitAudioContext returns no promise,
        // so check for one; onstatechange covers those browsers.
        if (actx.state === "suspended") {
          const p = actx.resume();
          if (p && typeof p.then === "function") p.then(afterArm, afterArm);
        }
      }
    } catch (e) {
      // Never break the poll. Only a context that couldn't be built means "no sound";
      // keep a live context if something after the constructor threw.
      if (!actx || actx.state === "closed") {
        actx = null;
        audioFailed = true;
      }
    }
    afterArm();
  }
  // Gesture listeners stay bound while audio is not ready, so a context that dies later
  // can be re-armed by the next click anywhere.
  let armListening = false;
  function listenForGesture(on) {
    if (on === armListening) return;
    armListening = on;
    if (on) {
      window.addEventListener("pointerdown", armAudio);
      window.addEventListener("keydown", armAudio);
    } else {
      window.removeEventListener("pointerdown", armAudio);
      window.removeEventListener("keydown", armAudio);
    }
  }
  function afterArm() {
    listenForGesture(!audioReady());
    /* Pay tones owed while the context was suspended (iOS/sleep suspend it; resume() succeeds
       off sticky activation). Past the deadline they are dropped as stale. The mute is re-read
       here because another tab may have changed it since. */
    if (beepOwed) {
      if (monoNow() > beepDueBy || !beepOn()) { beepOwed = 0; beepDueBy = 0; }
      else if (audioReady()) {
        // Clear the debt before queueing so it can't be paid twice.
        const owed = beepOwed;
        beepOwed = 0;
        beepDueBy = 0;
        for (let i = 0; i < owed; i++) emitBeep();
      }
    }
    paintBeepBtn();
  }
  // The sign-in click (or the first click anywhere) arms audio; doLogin needs no special case.
  listenForGesture(true);
  /* Also tried at load for unattended kiosks/reloads: succeeds where autoplay policy allows,
     otherwise the context stays "suspended" and the button says so. */
  armAudio();

  function beepNewOrder() {
    try {
      if (!beepOn()) return;
      if (!audioReady()) {
        // Owe the tone for 4 s and try to resume; afterArm() pays it if the context wakes.
        // Otherwise it expires (the flash and live region already fired).
        beepOwed += 1;
        beepDueBy = monoNow() + 4000;
        armAudio();
        return;
      }
      emitBeep();
    } catch (e) { /* a hostile audio stack must never take the poll loop down */ }
  }

  // Play one tone. Callers have checked the preference and that the context is running.
  function emitBeep() {
    try {
      /* No time floor: each call is a separate arrival (bursts within a poll already collapse).
         Beeps queue on the audio clock so two read as two; a queue >2 s deep is dropped. */
      const now = actx.currentTime;
      const t0 = Math.max(now + 0.01, beepFreeAt);
      if (t0 - now > 2) return;
      beepFreeAt = t0 + 0.34;                     // 0.31 of tone plus a gap, so two are two
      // Two rising sine chirps, A5 -> D6 ("arrived", not "failed"); peak 0.09 kept low on purpose.
      [[880, 0], [1174.66, 0.18]].forEach(([hz, at]) => {
        const osc = actx.createOscillator(), g = actx.createGain();
        osc.type = "sine";                        // no harmonics to go shrill on cheap PC speakers
        osc.frequency.value = hz;
        const s = t0 + at;
        // Ramped to avoid clicks; exponential ramps cannot target 0.
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.09, s + 0.010);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.12);
        osc.connect(g); g.connect(actx.destination);
        osc.start(s); osc.stop(s + 0.13);
        osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch (e) {} };
      });
    } catch (e) { /* a hostile audio stack must never take the poll loop down */ }
  }

  /* #ordBeep label is JS-owned (no data-i18n); repainted on arm attempts and language change.
     Three states: Muted / Sound (can play) / Arm sound (preference on but audio not ready).
     aria-pressed mirrors MUTED. */
  function paintBeepBtn() {
    const btn = $("ordBeep");
    if (!btn) return;
    const on = beepOn();
    const ready = audioReady();
    let label, tip;
    if (!on) {
      label = T("🔕 Muted");
      tip = T("New orders are silent on this PC — click to unmute");
    } else if (ready) {
      label = T("🔔 Sound");
      tip = T("New orders beep on this PC — click to mute");
    } else {
      label = T("🔔 Arm sound");
      tip = audioFailed
        ? T("This PC cannot play sound — new orders still flash on screen")
        : T("Sound is not armed on this PC — click to enable the order beep");
    }
    btn.textContent = label;
    btn.title = tip;
    btn.setAttribute("aria-label", tip);
    btn.setAttribute("aria-pressed", on ? "false" : "true");
  }
  /* Keep the label in sync when another tab changes the (per-workstation) preference.
     A null key means localStorage.clear(). Muting elsewhere also drops owed tones. */
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== BEEP_KEY) return;
    if (!beepOn()) { beepOwed = 0; beepDueBy = 0; }
    paintBeepBtn();
  });

  /* Drop every pending/deferred alert when the sign-in prompt goes up (they would announce
     history afterwards). Any new deferred alert must be cleared here too. */
  function dropSessionAlerts() {
    // No baseline -> the first poll back adopts the backlog silently.
    lastCreatedSeq = null;
    lastOrderCounts = null;
    hiddenArrivals = 0;
    // Owed tones: the prompt's own pointerdown would otherwise pay them.
    beepOwed = 0;
    beepDueBy = 0;
    // Pending live-region text: the gate is only an overlay, so it would be read over the prompt.
    clearTimeout(arrivalPaint);
    clearTimeout(arrivalClear);
    arrivalPaint = null;
    arrivalClear = null;
    arrivalPending = 0;
    // Emptying a live region announces nothing.
    const live = $("ordAlertLive");
    if (live) live.textContent = "";
  }

  /* Status requests can resolve out of order; a stale created_seq would regress the baseline
     and re-announce an order. So drop any response older than one already rendered.
     The gate is re-checked after the await: an in-flight response must not re-adopt a
     baseline showAuthGate() just cleared. */
  let statusReq = 0;     // issued
  let statusSeen = 0;    // the newest one that has actually been RENDERED
  async function pollStatus() {
    if (gateOpen) return;          // nothing to poll for while the prompt is up
    const req = ++statusReq;
    try {
      const s = await api("/api/status");
      /* Compare with the rendered watermark, not the issue counter: when responses take >2 s
         (e.g. a slow NAS storage_dir) there is always a newer request in flight, and the
         dashboard would never repaint. */
      if (req <= statusSeen || gateOpen) return;
      statusSeen = req;
      renderStatus(s);
    } catch (e) { /* keep last */ }
  }

