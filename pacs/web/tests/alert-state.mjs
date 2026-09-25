/* The emergency-RIS arrival alert, driven as a state machine.
 *   node pacs/web/tests/alert-state.mjs
 *
 * During a RIS outage the front desk types orders into the Emergency RIS panel
 * and imaging staff have to be TOLD, or the order sits on a list nobody opens
 * until somebody asks why the patient is still in the corridor. The decision to
 * tell them — and, just as important, the decision to stay quiet — lives
 * entirely in app.js: the created_seq diff, the live region, the deferred tone,
 * the in-flight watermark on the status poll. Every one of those is a repair
 * for a failure that was found by driving it, and until this file existed not
 * one of them was asserted anywhere. Three of the repairs could be reverted at
 * once and `node --check`, i18n-parity and the whole 746-test pytest suite
 * stayed green, because the only half of this feature Python can reach is the
 * payload: the server's job ends at `created_seq`, and everything that turns a
 * number going up into a sound in a room is here.
 *
 * So this is the browser half's regression gate. It does not launch a browser —
 * the arrival decision needs no rendering, only a clock, a store and a speaker,
 * and a headless Chromium would make the one gate that must run everywhere the
 * one gate that needs a binary. Instead it reads app.js, cuts out the regions
 * that make the decision, and runs THOSE — not a paraphrase of them, which is
 * the trap a hand-written model of this logic would fall into: a model agrees
 * with the source on the day it is written and silently stops agreeing on the
 * day the source is edited, which is precisely the day a gate has to speak up.
 * If a region cannot be found, or the extracted text no longer assembles, that
 * is a failure and not a skip.
 *
 * What the fakes supply is everything app.js does not own: a clock whose
 * timers fire only when the test says so, an AudioContext that records what it
 * was asked to play instead of playing it, a localStorage, a DOM thin enough to
 * hold a live region's textContent. The wall clock and the monotonic clock are
 * separate and independently steppable, because the difference between them is
 * itself one of the repairs under test.
 *
 * Pass a directory as argv[2] to run against a copy of pacs/web/ instead of the
 * real one. That is how the "it fails when a repair is reverted" claim is
 * checked — sabotage the copy, not the checkout — and i18n-parity.mjs takes the
 * same argument for the same reason. */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const WEB = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_SRC = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

let failures = 0;
const ok = (m) => console.log("  ok    " + m);
const bad = (m) => { failures += 1; console.log("  FAIL  " + m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

/* ── Cutting the decision out of app.js ──────────────────────────────
   A brace counter is enough to lift a function out of a file, but only if it
   knows what a brace is: `TN(total, "{n} new orders")` is one of the strings
   this very feature added, and a naive counter closes announceArrival() in the
   middle of it. So the scanner tracks quotes, template literals and both
   comment forms. It deliberately does NOT try to understand regex literals —
   none of the extracted regions contains one, and if a later edit puts one
   there the assembly below fails loudly rather than extracting nonsense. */
function blockAfter(src, from) {
  const open = src.indexOf("{", from);
  if (open < 0) return -1;
  let depth = 0, i = open;
  let quote = null, line = false, block = false;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (line) { if (c === "\n") line = false; i += 1; continue; }
    if (block) { if (c === "*" && d === "/") { block = false; i += 2; continue; } i += 1; continue; }
    if (quote) {
      if (c === "\\") { i += 2; continue; }
      if (c === quote) quote = null;
      i += 1; continue;
    }
    if (c === "/" && d === "/") { line = true; i += 2; continue; }
    if (c === "/" && d === "*") { block = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; i += 1; continue; }
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) return i + 1; }
    i += 1;
  }
  return -1;
}

const missing = [];
/* `anchor` is matched against the source and must match EXACTLY once: an
   anchor that matches twice is an anchor that has stopped naming one thing,
   and quietly taking the first hit is how a gate ends up testing the wrong
   region. "line" takes the rest of the line (a declaration), "block" takes the
   anchor plus the braced body that follows it (a function, or a statement whose
   body is the thing under test). */
function region(label, anchor, kind = "block") {
  const all = new RegExp(anchor.source, anchor.flags.includes("g") ? anchor.flags : anchor.flags + "g");
  const hits = [...APP_SRC.matchAll(all)];
  if (hits.length !== 1) {
    missing.push(label + " (" + hits.length + " matches for " + anchor + ")");
    return "";
  }
  const start = hits[0].index;
  if (kind === "line") {
    const nl = APP_SRC.indexOf("\n", start);
    return APP_SRC.slice(start, nl < 0 ? APP_SRC.length : nl);
  }
  const end = blockAfter(APP_SRC, start);
  if (end < 0) { missing.push(label + " (unterminated block)"); return ""; }
  // A trailing `);` belongs to the statement, not to the block: an
  // addEventListener call has to be put back together to be re-registered.
  const tail = APP_SRC.slice(end, end + 2);
  return APP_SRC.slice(start, end) + (tail === ");" ? ");" : "");
}

const DECLS = [
  region("lastCreatedSeq", /^ {2}let lastCreatedSeq = .*$/m, "line"),
  region("lastOrderCounts", /^ {2}let lastOrderCounts = .*$/m, "line"),
  region("arrival timers", /^ {2}let arrivalClear = .*$/m, "line"),
  region("hiddenArrivals", /^ {2}let hiddenArrivals = 0;$/m, "line"),
  region("audio context state", /^ {2}let actx = null, audioFailed = false, beepFreeAt = 0;$/m, "line"),
  region("monoNow", /^ {2}const monoNow = .*$/m, "line"),
  region("beepDueBy", /^ {2}let beepDueBy = 0;$/m, "line"),
  region("beepOwed", /^ {2}let beepOwed = 0;$/m, "line"),
  region("armListening", /^ {2}let armListening = false;$/m, "line"),
  region("BEEP_KEY", /^ {2}const BEEP_KEY = .*$/m, "line"),
  region("statusReq", /^ {2}let statusReq = 0;.*$/m, "line"),
  region("statusSeen", /^ {2}let statusSeen = 0;.*$/m, "line"),
];

/* The arrival decision itself is not a function — it is a stretch of
   renderStatus() — so it is lifted by its first statement and re-hosted in a
   renderStatus of this file's own, which does nothing else but count paints.
   Everything it reads (`rs`) and everything it calls (onOrderArrived) is
   supplied around it. */
const ARRIVAL = region("the created_seq arrival decision", /^ {4}const seq = rs\.created_seq;$/m, "block");

const FUNCS = [
  region("announceArrival", /^ {2}function announceArrival\(n\) \{/m),
  region("onOrderArrived", /^ {2}function onOrderArrived\(n\) \{/m),
  region("visibilitychange", /^ {2}document\.addEventListener\("visibilitychange"/m),
  region("audioReady", /^ {2}function audioReady\(\)/m),
  region("armAudio", /^ {2}function armAudio\(\) \{/m),
  region("listenForGesture", /^ {2}function listenForGesture\(on\) \{/m),
  region("afterArm", /^ {2}function afterArm\(\) \{/m),
  region("beepOn", /^ {2}function beepOn\(\) \{/m),
  region("setBeepOn", /^ {2}function setBeepOn\(on\) \{/m),
  region("beepNewOrder", /^ {2}function beepNewOrder\(\) \{/m),
  region("emitBeep", /^ {2}function emitBeep\(\) \{/m),
  region("dropSessionAlerts", /^ {2}function dropSessionAlerts\(\) \{/m),
  region("showAuthGate", /^ {2}function showAuthGate\(\) \{/m),
  region("stopPollers", /^ {2}function stopPollers\(\) \{/m),
  region("pollStatus", /^ {2}async function pollStatus\(\) \{/m),
];

if (missing.length) {
  missing.forEach((m) => bad("could not extract from app.js: " + m
    + " — the alert moved or was renamed, and this gate is now testing nothing"));
  console.log("\n" + failures + " FAILURE(S)");
  process.exit(1);
}
ok("all " + (DECLS.length + FUNCS.length + 1) + " alert regions extracted from app.js");

/* ── The world app.js thinks it is running in ────────────────────────
   Named stubs, not a framework: every one of them is something the extracted
   code calls and this file has an opinion about. The ones that record (pulse,
   TN, the oscillators) are the assertions' only windows into a decision that
   otherwise leaves no trace; the ones that do nothing are surfaces whose
   behaviour is not what is under test here. */
const FACTORY_SRC = `
  "use strict";
  const { doc, win, store, clock, audio, wall, log } = env;
  // Shadowed so the extracted code cannot reach the real ones. Node has a real
  // global performance and a real Date; monoNow() reads both by their bare
  // names, and the whole point of several cases below is to move those two
  // clocks independently.
  const document = doc, window = win, localStorage = store;
  const performance = win.performance;
  const Date = { now: () => wall.now() };
  const setTimeout = clock.setTimeout, clearTimeout = clock.clearTimeout;
  const setInterval = clock.setInterval, clearInterval = clock.clearInterval;

  let gateOpen = false, picked = null, retryTimer = null;
  let statusTimer = null, logTimer = null;

  const $ = (id) => doc.getElementById(id);
  const show = () => {};
  const setGateMode = () => {};
  const setAuthMsg = () => {};
  const loadPicker = () => Promise.resolve("token");
  const T = (s) => s;
  const TN = (n, s) => { log.spoken.push(s.replace("{n}", n)); return s.replace("{n}", n); };
  const pulseAlert = (id) => log.flashed.push(id);
  const pulseChip = (id) => log.flashed.push("chip:" + id);
  const blink = () => {};
  const paintBeepBtn = () => { log.paints += 1; };
  const api = (url) => env.api(url);

  // renderStatus() does a great deal this file has no opinion about. What it
  // does that matters here is run the arrival decision, so that is all this
  // stands in for — plus a count, which is what the starvation case reads.
  function renderStatus(s) {
    log.renders.push(s && s.ris ? s.ris.created_seq : null);
    const rs = (s && s.ris) || {};
${DECLS.map(() => "").join("")}
    ${ARRIVAL.split("\n").join("\n  ")}
  }

${DECLS.join("\n")}

${FUNCS.join("\n\n")}

  return {
    pollStatus, showAuthGate, stopPollers, onOrderArrived, announceArrival,
    afterArm, armAudio, beepNewOrder, dropSessionAlerts, setBeepOn, renderStatus,
    openGate: () => { gateOpen = true; },
    closeGate: () => { gateOpen = false; },
    probe: () => ({
      gateOpen, lastCreatedSeq, lastOrderCounts, hiddenArrivals,
      beepOwed, beepDueBy, beepFreeAt, arrivalPending,
      statusReq, statusSeen, audioFailed,
      armed: !!(actx && actx.state === "running"),
    }),
  };
`;

let factory;
try {
  factory = new Function("env", FACTORY_SRC);
} catch (e) {
  bad("the extracted alert regions no longer assemble: " + e.message);
  console.log("\n" + failures + " FAILURE(S)");
  process.exit(1);
}
ok("the extracted regions assemble and run");

/* A clock the tests own outright. Timers fire only inside advance(), in
   deadline order, and the "now" they see is their own deadline rather than the
   end of the jump — announceArrival() chains a 5 s clear behind a 50 ms paint,
   and a clock that fired both at the same instant would hide the ordering bug
   this feature already had once. */
function makeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { timers.set(++seq, { at: now + (ms || 0), fn }); return seq; },
    setInterval(fn, ms) { timers.set(++seq, { at: now + (ms || 0), fn, every: ms }); return seq; },
    clearTimeout(id) { timers.delete(id); },
    clearInterval(id) { timers.delete(id); },
    pending: () => timers.size,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let pick = null;
        for (const [id, t] of timers) {
          if (t.at > target) continue;
          if (!pick || t.at < pick.t.at || (t.at === pick.t.at && id < pick.id)) pick = { id, t };
        }
        if (!pick) break;
        timers.delete(pick.id);
        now = Math.max(now, pick.t.at);
        pick.t.fn();
      }
      now = target;
    },
  };
}

/* A speaker that writes down what it was asked to play. emitBeep() schedules
   two oscillators per tone — one chirp is a RISING PAIR, A5 then D6 — so the
   tones are the onsets of the lower note of each pair, and their spacing is
   what proves two arrivals read as two rather than as noise. Counting bare
   start times instead would report every single chirp as two.  */
function makeAudio(clock) {
  const starts = [];
  const self = {
    starts,
    ctx: null,
    builds: 0,
    blocked: false,          // the autoplay policy refusing to resume
    tones: () => {
      if (!starts.length) return [];
      const lo = Math.min(...starts.map((s) => s.hz));
      return starts.filter((s) => s.hz === lo).map((s) => s.at).sort((a, b) => a - b);
    },
    AC: function AudioContext() {
      self.builds += 1;
      const ctx = {
        state: "suspended",
        destination: {},
        onstatechange: null,
        get currentTime() { return clock.now() / 1000; },
        resume() {
          return Promise.resolve().then(() => {
            if (ctx.state === "closed" || self.blocked) return;
            ctx.state = "running";
          });
        },
        createOscillator() {
          const osc = {
            type: "", frequency: { value: 0 },
            connect() {}, disconnect() {},
            start(t) { starts.push({ hz: osc.frequency.value, at: Math.round(t * 1000) / 1000 }); },
            stop() {},
          };
          return osc;
        },
        createGain() {
          return {
            gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
            connect() {}, disconnect() {},
          };
        },
      };
      self.ctx = ctx;
      return ctx;
    },
  };
  return self;
}

function makeEl() {
  return {
    textContent: "", hidden: false, disabled: false, title: "", offsetWidth: 0,
    classList: { add() {}, remove() {} },
    setAttribute() {}, click() {},
  };
}

/* One dashboard, fresh state, nothing carried over from the last case. */
function boot(opts = {}) {
  const clock = makeClock();
  const audio = makeAudio(clock);
  let wallT = 1_700_000_000_000;
  const els = new Map();
  const listeners = new Map();
  const log = { spoken: [], flashed: [], renders: [], paints: 0 };
  const pending = [];

  const env = {
    clock, audio, log,
    wall: { now: () => wallT, step: (ms) => { wallT += ms; } },
    store: {
      map: new Map(),
      getItem(k) { return this.map.has(k) ? this.map.get(k) : null; },
      setItem(k, v) { this.map.set(k, String(v)); },
      removeItem(k) { this.map.delete(k); },
    },
    doc: {
      hidden: false,
      getElementById(id) {
        if (!els.has(id)) els.set(id, makeEl());
        return els.get(id);
      },
      querySelectorAll: () => [],
      addEventListener(type, fn) { (listeners.get(type) || listeners.set(type, []).get(type)).push(fn); },
    },
    win: {
      performance: { now: () => clock.now() },
      addEventListener() {}, removeEventListener() {},
      get AudioContext() { return opts.noAudio ? undefined : audio.AC; },
      webkitAudioContext: undefined,
    },
    // /api/status, deferred: the test decides when each response lands, which
    // is the only way to put two of them in flight at once the way a 2 s
    // interval and a slow engine really do.
    api: () => new Promise((res, rej) => pending.push({ res, rej })),
  };
  env.doc.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };

  const app = factory(env);
  return {
    app, env, clock, audio, log, els, pending,
    el: (id) => env.doc.getElementById(id),
    fire: (type) => (listeners.get(type) || []).forEach((fn) => fn()),
    // Let every already-settled promise continuation run. setImmediate is a
    // real macrotask, so it drains the microtask queue behind it — including
    // the resume() chain that pays a deferred tone.
    flush: () => new Promise((r) => setImmediate(r)),
    land: (i, payload) => pending[i].res(payload),
    status: (seq, counts) => ({ ris: { created_seq: seq, counts: counts || { open: 1, closed: 0, total: 1 } } }),
  };
}

/* Arm the speaker the way the operator's first click does, and settle the
   resume() promise so afterArm() has actually run. */
async function armFor(h) {
  h.app.armAudio();
  await h.flush();
}

/* ── The cases ───────────────────────────────────────────────────── */
const CASES = [];
const test = (name, fn) => CASES.push({ name, fn });

test("the first poll adopts the backlog in silence", async () => {
  const h = boot();
  await armFor(h);
  h.app.pollStatus();
  h.land(0, h.status(9));
  await h.flush();
  h.clock.advance(100);
  check(h.app.probe().lastCreatedSeq === 9, "the baseline is adopted from the first payload");
  check(h.log.spoken.length === 0, "nothing is announced for orders that were already there");
  check(h.audio.tones().length === 0, "and nothing is played: " + JSON.stringify(h.audio.tones()));
  check(h.el("ordAlertLive").textContent === "", "the live region is still empty");
});

test("one new order announces exactly once, and says one", async () => {
  const h = boot();
  await armFor(h);
  h.app.pollStatus(); h.land(0, h.status(9)); await h.flush();
  h.app.pollStatus(); h.land(1, h.status(10)); await h.flush();
  h.clock.advance(100);
  check(h.log.spoken.join("|") === "1 new orders", "one announcement, count 1: " + JSON.stringify(h.log.spoken));
  check(h.el("ordAlertLive").textContent === "1 new orders", "…and it reached the live region");
  check(h.audio.tones().length === 1, "one tone: " + JSON.stringify(h.audio.tones()));
  // The same payload again is the same order, not a second one: the diff
  // advances the baseline BEFORE announcing, so a re-poll of an unchanged tick
  // is silent.
  h.app.pollStatus(); h.land(2, h.status(10)); await h.flush();
  h.clock.advance(6000);
  check(h.log.spoken.length === 1, "re-polling the same tick announces nothing further");
  check(h.el("ordAlertLive").textContent === "", "and the region goes quiet again after its five seconds");
});

test("a burst between two polls is one announcement carrying the right n", async () => {
  const h = boot();
  await armFor(h);
  h.app.pollStatus(); h.land(0, h.status(4)); await h.flush();
  // Five orders — the RIS coming back and flushing what it queued — land
  // between one poll and the next.
  h.app.pollStatus(); h.land(1, h.status(9)); await h.flush();
  h.clock.advance(100);
  check(h.log.spoken.join("|") === "5 new orders", "one sentence, n=5: " + JSON.stringify(h.log.spoken));
  check(h.audio.tones().length === 1, "one tone for one poll's worth of arrivals");
});

test("two arrivals inside the live region's blank window are added, not dropped", async () => {
  const h = boot();
  await armFor(h);
  h.app.pollStatus(); h.land(0, h.status(1)); await h.flush();
  // The region is emptied and rewritten 50 ms later so a screen reader hears
  // the second identical sentence as a change. A second arrival inside that
  // window must join the sentence rather than be swallowed by it.
  h.app.pollStatus(); h.land(1, h.status(2)); await h.flush();
  h.clock.advance(20);
  h.app.pollStatus(); h.land(2, h.status(4)); await h.flush();
  h.clock.advance(100);
  check(h.log.spoken.join("|") === "3 new orders", "one sentence, all three counted: " + JSON.stringify(h.log.spoken));
});

test("a tick that has gone backwards is adopted, never announced", async () => {
  const h = boot();
  await armFor(h);
  h.app.pollStatus(); h.land(0, h.status(40)); await h.flush();
  // An orders.json restored from a backup, or a store directory repointed: the
  // number means nothing this page can diff against, so inventing an arrival
  // count from it would be inventing orders.
  h.app.pollStatus(); h.land(1, h.status(3)); await h.flush();
  h.clock.advance(100);
  check(h.app.probe().lastCreatedSeq === 3, "the lower value becomes the new baseline");
  check(h.log.spoken.length === 0, "and nothing is announced on the way down");
  // …and the very next real order off the new base still announces, once.
  h.app.pollStatus(); h.land(2, h.status(4)); await h.flush();
  h.clock.advance(100);
  check(h.log.spoken.join("|") === "1 new orders", "the first order after the reset is announced: "
        + JSON.stringify(h.log.spoken));
});

test("a superseded response cannot regress the baseline or re-announce", async () => {
  const h = boot();
  await armFor(h);
  h.app.pollStatus(); h.land(0, h.status(5)); await h.flush();
  // Two polls in flight at once — the 2 s interval alongside a click's
  // imperative poll — served on separate threads. The SLOW one was issued
  // first and carries the older tick.
  h.app.pollStatus();            // req 2, slow, seq 5
  h.app.pollStatus();            // req 3, fast, seq 6
  h.land(2, h.status(6)); await h.flush();
  h.clock.advance(100);
  const afterFast = h.app.probe().lastCreatedSeq;
  h.land(1, h.status(5)); await h.flush();
  h.clock.advance(100);
  check(afterFast === 6, "the newer response rendered");
  check(h.app.probe().lastCreatedSeq === 6,
        "the stale one did not drag the baseline back to 5 (which would re-announce order 6)");
  check(h.log.spoken.join("|") === "1 new orders", "exactly one announcement for the one order: "
        + JSON.stringify(h.log.spoken));
});

test("the watermark tracks what was DRAWN, and advances with it", async () => {
  const h = boot();
  h.app.pollStatus(); h.app.pollStatus(); h.app.pollStatus();
  check(h.app.probe().statusReq === 3 && h.app.probe().statusSeen === 0,
        "three issued, none drawn yet");
  h.land(1, h.status(2)); await h.flush();
  check(h.app.probe().statusSeen === 2, "drawing the second response moves the watermark to it");
  h.land(0, h.status(1)); await h.flush();
  check(h.app.probe().statusSeen === 2 && h.log.renders.length === 1,
        "the first response, landing last, is dropped and the watermark stays");
  h.land(2, h.status(3)); await h.flush();
  check(h.app.probe().statusSeen === 3 && h.log.renders.length === 2,
        "the third still renders — it is newer than anything drawn");
});

test("a status slower than the poll period does not starve the dashboard", async () => {
  const h = boot();
  await armFor(h);
  // The engine is answering in ~2.2 s while the interval fires every 2 s, so
  // there is ALWAYS a newer request in flight when a response lands. Against
  // the issue counter every single response is discarded and the dashboard
  // never paints again — no badges, no arrival edge, no error either.
  h.app.pollStatus();
  for (let i = 0; i < 7; i += 1) {
    h.app.pollStatus();
    h.land(i, h.status(10 + i));
    await h.flush();
    h.clock.advance(2000);
  }
  check(h.log.renders.length === 7, "all seven landed responses rendered, got " + h.log.renders.length);
  check(h.app.probe().lastCreatedSeq === 16, "and the arrival edge kept up: "
        + h.app.probe().lastCreatedSeq);
  check(h.log.spoken.length === 6, "six arrivals after the adopted first: " + JSON.stringify(h.log.spoken));
});

test("the sign-in prompt drops every alert this session was still owed", async () => {
  const h = boot();
  await armFor(h);
  h.app.pollStatus(); h.land(0, h.status(1)); await h.flush();
  // The tab is in the background and the speaker has gone back to sleep — so
  // an arrival now owes a tone, owes a flash for when somebody looks, and has
  // a sentence sitting in the 50 ms window before the live region speaks.
  h.env.doc.hidden = true;
  h.audio.ctx.state = "suspended";
  h.audio.blocked = true;
  h.app.pollStatus(); h.land(1, h.status(3)); await h.flush();
  const owed = h.app.probe();
  // One tone for the poll (a burst inside one poll is one arrival by design),
  // two orders held for the flash, two counted into the pending sentence.
  check(owed.beepOwed === 1 && owed.hiddenArrivals === 2 && owed.arrivalPending === 2,
        "the arrivals are owed a tone, a flash and a sentence: " + JSON.stringify(
          [owed.beepOwed, owed.hiddenArrivals, owed.arrivalPending]));
  // A 401 at a token expiry, landing inside that window.
  h.app.showAuthGate();
  const gone = h.app.probe();
  check(gone.beepOwed === 0 && gone.beepDueBy === 0, "the tone debt goes with the session");
  check(gone.hiddenArrivals === 0, "so does the hidden-tab flash");
  check(gone.arrivalPending === 0, "so does the live region's pending sentence");
  check(gone.lastCreatedSeq === null && gone.lastOrderCounts === null, "and both baselines");
  // The click that answers the prompt is a gesture: it arms the audio, and
  // afterArm() must find nothing left to pay.
  h.clock.advance(10000);
  await armFor(h);
  h.env.doc.hidden = false;
  h.fire("visibilitychange");
  h.clock.advance(100);
  check(h.log.spoken.length === 0, "nothing speaks behind the prompt: " + JSON.stringify(h.log.spoken));
  check(h.audio.tones().length === 0, "nothing chirps at somebody typing a token: "
        + JSON.stringify(h.audio.tones()));
  check(h.el("ordAlertLive").textContent === "", "the region is blank, not holding a stale sentence");
  // And the first poll of the new session adopts the backlog silently, which is
  // what makes dropping the alerts honest rather than a loss.
  h.app.closeGate();
  h.app.pollStatus(); h.land(2, h.status(11)); await h.flush();
  h.clock.advance(100);
  check(h.log.spoken.length === 0 && h.app.probe().lastCreatedSeq === 11,
        "the backlog behind the prompt is adopted, not announced");
});

test("a response in flight when the session ended cannot paint over the prompt", async () => {
  const h = boot();
  h.app.pollStatus();                       // on the wire when the 401 lands
  h.app.stopPollers();
  h.app.showAuthGate();
  h.land(0, h.status(77));
  await h.flush();
  check(h.log.renders.length === 0, "the late response rendered nothing");
  check(h.app.probe().lastCreatedSeq === null,
        "and it did not re-adopt a baseline the prompt had just dropped");
});

test("two arrivals into a sleeping speaker buy two tones", async () => {
  const h = boot();
  await armFor(h);
  h.app.pollStatus(); h.land(0, h.status(1)); await h.flush();
  // The context is asleep — a backgrounded tab, or a machine back from
  // suspend — and cannot be resumed yet.
  h.audio.ctx.state = "suspended";
  h.audio.blocked = true;
  h.app.pollStatus(); h.land(1, h.status(2)); await h.flush();
  check(h.app.probe().beepOwed === 1, "the first arrival is owed a tone");
  h.clock.advance(500);
  h.app.pollStatus(); h.land(2, h.status(3)); await h.flush();
  check(h.app.probe().beepOwed === 2, "the second arrival is owed one too, not folded into the first: "
        + h.app.probe().beepOwed);
  // The speaker comes back inside the deadline.
  h.audio.blocked = false;
  await armFor(h);
  const tones = h.audio.tones();
  check(tones.length === 2, "both owed tones are paid: " + JSON.stringify(tones));
  check(tones.length === 2 && Math.abs((tones[1] - tones[0]) - 0.34) < 0.001,
        "…and spaced so two read as two, not as noise: " + JSON.stringify(tones));
});

test("the owed-tone deadline is on the monotonic clock, not the wall clock", async () => {
  const h = boot();
  await armFor(h);
  h.app.pollStatus(); h.land(0, h.status(1)); await h.flush();
  h.audio.ctx.state = "suspended";
  h.audio.blocked = true;
  h.app.pollStatus(); h.land(1, h.status(2)); await h.flush();
  check(h.app.probe().beepOwed === 1, "a tone is owed");
  // An NTP correction or an RTC fix-up while the tone is owed. Half a second of
  // real time has passed, which is well inside the four-second deadline; the
  // wall clock has jumped twenty minutes.
  h.clock.advance(500);
  h.env.wall.step(20 * 60 * 1000);
  h.audio.blocked = false;
  await armFor(h);
  check(h.audio.tones().length === 1,
        "the order still chirps: a clock correction is not news going stale: "
        + JSON.stringify(h.audio.tones()));

  // The other direction: real time really has passed, so the debt really has
  // expired — even though a wall clock stepped BACKWARDS would say otherwise.
  const g = boot();
  await armFor(g);
  g.app.pollStatus(); g.land(0, g.status(1)); await g.flush();
  g.audio.ctx.state = "suspended";
  g.audio.blocked = true;
  g.app.pollStatus(); g.land(1, g.status(2)); await g.flush();
  g.clock.advance(5000);
  g.env.wall.step(-60 * 60 * 1000);
  g.audio.blocked = false;
  await armFor(g);
  check(g.audio.tones().length === 0,
        "and a five-second-old debt is dropped rather than announcing history: "
        + JSON.stringify(g.audio.tones()));
  check(g.app.probe().beepOwed === 0, "the expired debt is cleared, not left to fire later");
});

test("a muted workstation owes nothing, and a mute elsewhere cancels the debt", async () => {
  const h = boot();
  await armFor(h);
  h.app.pollStatus(); h.land(0, h.status(1)); await h.flush();
  h.app.setBeepOn(false);
  h.audio.ctx.state = "suspended";
  h.audio.blocked = true;
  h.app.pollStatus(); h.land(1, h.status(2)); await h.flush();
  h.clock.advance(100);
  check(h.app.probe().beepOwed === 0, "a muted PC takes on no debt at all");
  check(h.log.spoken.join("|") === "1 new orders", "but the order is still announced and still flashes");
  check(h.log.flashed.includes("navOrders"), "…on the nav row, which is never hidden at zero");
  // Owed while unmuted, muted at the other tab before the speaker comes back:
  // a debt is an intention to beep, not a licence.
  const g = boot();
  await armFor(g);
  g.app.pollStatus(); g.land(0, g.status(1)); await g.flush();
  g.audio.ctx.state = "suspended";
  g.audio.blocked = true;
  g.app.pollStatus(); g.land(1, g.status(2)); await g.flush();
  check(g.app.probe().beepOwed === 1, "the tone is owed while sound was on");
  g.app.setBeepOn(false);
  g.audio.blocked = false;
  await armFor(g);
  check(g.audio.tones().length === 0, "and is not paid to a workstation that has since gone silent: "
        + JSON.stringify(g.audio.tones()));
});

test("a hidden tab keeps the flash for when somebody looks, and does not re-chirp", async () => {
  const h = boot();
  await armFor(h);
  h.app.pollStatus(); h.land(0, h.status(1)); await h.flush();
  h.env.doc.hidden = true;
  h.app.pollStatus(); h.land(1, h.status(3)); await h.flush();
  h.clock.advance(100);
  check(h.app.probe().hiddenArrivals === 2, "two arrivals are held for the return");
  check(h.audio.tones().length === 1, "the tone played at the real arrival — a background tab is still audible");
  const spokenAtArrival = h.log.spoken.length;
  h.env.doc.hidden = false;
  h.fire("visibilitychange");
  h.clock.advance(100);
  check(h.log.spoken.length === spokenAtArrival + 1, "the return re-announces what was missed");
  check(h.log.spoken[h.log.spoken.length - 1] === "2 new orders", "…with the right count: "
        + JSON.stringify(h.log.spoken));
  check(h.audio.tones().length === 1, "and does not chirp again for orders that already chirped");
  check(h.app.probe().hiddenArrivals === 0, "the held count is spent, not spent twice");
});

test("a profile without orders.read is inert, not broken", async () => {
  const h = boot();
  await armFor(h);
  // The ris block is gated out of /api/status server-side for a profile with no
  // orders.read, so created_seq is simply absent. That must be silence, not a
  // NaN arrival count.
  for (let i = 0; i < 4; i += 1) {
    h.app.pollStatus();
    h.land(i, { ris: {} });
    await h.flush();
    h.clock.advance(2000);
  }
  check(h.log.renders.length === 4, "the dashboard still renders every poll");
  check(h.app.probe().lastCreatedSeq === null, "no baseline is ever adopted");
  check(h.log.spoken.length === 0 && h.audio.tones().length === 0, "and nothing is ever announced");
});

test("a workstation with no WebAudio at all still flashes and still speaks", async () => {
  const h = boot({ noAudio: true });
  await armFor(h);
  check(h.app.probe().audioFailed === true, "the page knows this PC cannot play sound");
  h.app.pollStatus(); h.land(0, h.status(1)); await h.flush();
  h.app.pollStatus(); h.land(1, h.status(2)); await h.flush();
  h.clock.advance(100);
  check(h.log.spoken.join("|") === "1 new orders", "the order is announced: " + JSON.stringify(h.log.spoken));
  check(h.log.flashed.includes("navOrders"), "and flashed");
  // The debt is still taken on — nothing here can know the next gesture will
  // not produce a working context — but it expires on its deadline and is
  // never paid, so the alert degrades to the visible half instead of queueing
  // a chirp forever against a speaker that will never exist.
  h.clock.advance(5000);
  await armFor(h);
  check(h.audio.tones().length === 0, "and never chirps: " + JSON.stringify(h.audio.tones()));
  check(h.app.probe().beepOwed === 0 && h.app.probe().beepDueBy === 0,
        "with the expired debt cleared rather than left standing");
});

/* ── Run ─────────────────────────────────────────────────────────── */
for (const c of CASES) {
  console.log("\n" + c.name);
  try {
    await c.fn();
  } catch (e) {
    bad("threw: " + (e && e.stack ? e.stack : e));
  }
}

console.log(failures ? "\n" + failures + " FAILURE(S)" : "\nAll " + CASES.length + " alert-state cases passed.");
process.exit(failures ? 1 : 0);
