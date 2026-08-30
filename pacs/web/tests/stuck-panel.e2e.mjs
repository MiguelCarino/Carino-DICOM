/* End-to-end: the Stuck panel against a REAL engine, in all five states.
 *   node pacs/web/tests/stuck-panel.e2e.mjs
 *
 * GET /api/stuck grew a second list — `orphaned`, files routed to a name that
 * is no longer an enabled destination — and stuck_count() started counting it,
 * so status.stuck (the ⚠ badge) went non-zero while the panel it opens still
 * rendered only `destinations` and said "Nothing stuck — every forward is up to
 * date." A badge over a panel that denies it is worse than no badge: the
 * operator learns to ignore the warning, and these are the files nothing will
 * ever retry.
 *
 * Then it grew a THIRD — `held`, destinations a rule asks to de-identify for
 * while the de-identifier cannot run — and the identical defect came back
 * verbatim: badge non-zero, panel saying every forward is up to date. This file
 * asserted the invariant already ("no 'Nothing stuck' note while the badge is
 * non-zero") and still passed, because every state it drove was a state the
 * renderer happened to handle: the assertion is only ever as wide as the states
 * below it. So the states now cover each list ALONE, and the per-state checks
 * are derived from the payload rather than from a hand-written expectation —
 * every array the engine returns has to reach the screen as rows, and every
 * *_files count has to be reconcilable with the badge. A fourth list added to
 * /api/stuck and rendered nowhere fails here without anyone editing this file.
 *
 * So the check is agreement, driven live in every state a site can be in:
 *   1. nothing stuck, nothing orphaned, nothing held
 *   2. only backoff-stuck            (the node is still configured)
 *   3. only orphaned                 (pinned — a hold-and-forward promise)
 *   4. only held                     (a scrub was asked for and cannot happen)
 *   5. all three at once, ONE file in every list — the badge must count it once
 *
 * A hold now has TWO causes, and they take OPPOSITE remedies: deid.profile is
 * 'off' (turn it on), or the profile is on and no de-identifier can be built
 * (do NOT turn it off — repair the settings). Every read-only surface used to
 * assert the first over both, which at a site in the second state prescribes an
 * edit that does nothing and leaves "take de-identify off the rule" as the only
 * remaining move — i.e. releases the study by forwarding it IDENTIFIED to the
 * one node a rule exists to scrub for. So states 6-8 drive the SECOND cause
 * against a real engine (a hand-edited config with a JSON number in deid.prefix
 * — Config.load does not validate, so the file runs and nothing can be built
 * from it) and then the repaired state:
 *   6. held for cause two, both causes on screen at once, each with its own row
 *   7. the config-refused banner, which is the other engine field nothing drew
 *   8. repaired: no hold, no banner, nothing stuck
 *
 * The states are real, not stubbed: a send-state file with recorded routes and
 * failures, plus files appearing in the outgoing folder and a destination being
 * disabled through POST /api/config while the engine runs. The watcher stays
 * off (scu.enabled false) so nothing rewrites the state underneath the test.
 *
 * Drives headless Chromium over the DevTools protocol (no puppeteer, no npm:
 * node 22 has a WebSocket client built in). Needs python3 with flask/pydicom/
 * pynetdicom on PATH and a chromium binary; set CHROME= to point at one. */

import { spawn, spawnSync } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let failures = 0;
const ok = (m) => console.log("  ok    " + m);
const bad = (m) => { failures += 1; console.log("  FAIL  " + m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePorts(n) {
  const servers = [];
  const one = () => new Promise((res, rej) => {
    const srv = net.createServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => { servers.push(srv); res(srv.address().port); });
  });
  return (async () => {
    const ports = [];
    for (let i = 0; i < n; i += 1) ports.push(await one());
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    return ports;
  })();
}

function findChrome() {
  const names = [process.env.CHROME, "chromium-browser", "chromium", "google-chrome", "google-chrome-stable"];
  for (const n of names) {
    if (!n) continue;
    const r = spawnSync("sh", ["-c", "command -v " + n]);
    if (r.status === 0) return r.stdout.toString().trim();
  }
  throw new Error("no chromium binary found — set CHROME=/path/to/chromium");
}

/* ---- the smallest CDP client that can drive a page ------------------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.session = null; this.errors = []; }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("cdp connect failed")); });
    const cdp = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      // An uncaught exception in renderStuck() leaves the panel showing the
      // PREVIOUS state while the badge moves on, which is the exact disagreement
      // this file exists to catch — so every one of them is collected.
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails || {};
        cdp.errors.push((d.exception && d.exception.description) || d.text || "exception");
        return;
      }
      const w = cdp.waiting.get(msg.id);
      if (!w) return;
      cdp.waiting.delete(msg.id);
      msg.error ? w.rej(new Error(msg.error.message)) : w.res(msg.result);
    };
    return cdp;
  }

  send(method, params = {}, sessionId = this.session) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      setTimeout(() => { if (this.waiting.delete(id)) rej(new Error("CDP timeout: " + method)); }, 30000);
    });
  }

  async open() {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" }, null);
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true }, null);
    this.session = sessionId;
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    return targetId;
  }

  async goto(url) {
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete'", 15000);
  }

  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("page error: " + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
    return r.result.value;
  }

  async waitFor(expr, timeout = 10000, label = expr) {
    const deadline = Date.now() + timeout;
    for (;;) {
      let v = false;
      try { v = await this.eval("!!(" + expr + ")"); } catch (e) { /* mid-navigation */ }
      if (v) return true;
      if (Date.now() > deadline) throw new Error("timed out waiting for: " + label);
      await sleep(150);
    }
  }
}

/* ---- fixture --------------------------------------------------------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "carino-dicom-stuck-"));
const cfgPath = path.join(tmp, "config.json");
const outgoing = path.join(tmp, "outgoing");
fs.mkdirSync(outgoing, { recursive: true });
const [webPort, scpPort, devPort, qrPort] = await freePorts(4);

// "Ward PACS" stays enabled all the way through — it is the node that is still
// configured, i.e. the backoff half. "Teaching" is switched OFF part-way, which
// is precisely how a route becomes orphaned in the field: nobody deletes the
// queued files, the destination just stops existing. "Research" is the held
// half: a rule routes to it with deidentify, deid.profile is 'off', so no copy
// can be scrubbed and the engine refuses to send it in the clear. The config
// below is the whole hold — nothing is stubbed, this site would hold on its
// next Auto-send pass.
const CONFIG = {
  scp: { enabled: false, aet: "STUCKPACS", bind: "127.0.0.1", port: scpPort, storage_dir: path.join(tmp, "received") },
  scu: { enabled: false, watch_dir: outgoing, sent_dir: path.join(tmp, "sent"), pending_dir: path.join(tmp, "pending") },
  destinations: [
    { name: "Ward PACS", host: "127.0.0.1", port: 11199, aet: "WARD", enabled: true },
    { name: "Teaching", host: "127.0.0.1", port: 11198, aet: "TEACH", enabled: true },
    { name: "Research", host: "127.0.0.1", port: 11197, aet: "RESEARCH", enabled: true },
  ],
  routing: {
    enabled: true,
    rules: [{ name: "Everything to Research, de-identified", match: {},
              destinations: ["Research"], deidentify: true }],
  },
  deid: { profile: "off" },
  web: { host: "127.0.0.1", port: webPort },
  logs_dir: path.join(tmp, "logs"),
  setup_completed: "2026-01-01T00:00:00Z",
};
fs.writeFileSync(cfgPath, JSON.stringify(CONFIG, null, 2));

const F = {
  stuck: path.join(outgoing, "backing-off.dcm"),   // routed to Ward PACS, failed
  orphan: path.join(outgoing, "held-for-teaching.dcm"), // routed+PINNED to Teaching
  held: path.join(outgoing, "awaiting-scrub.dcm"), // held for Research, never routed to it
  all: path.join(outgoing, "owes-everyone.dcm"),   // failed on Ward PACS, routed to Teaching, held for Research
  // Held the OTHER way: the profile is on and nothing can be built to scrub
  // with. Only used from state 6, where the engine is running the hand-edited
  // config that produces it.
  noScrubber: path.join(outgoing, "awaiting-a-scrubber.dcm"),
};
const soon = Math.floor(Date.now() / 1000) + 900;
const failed = { attempts: 4, last_error: "Association rejected: connection refused", next_try: soon };
// SendState is keyed by absolute path and loaded once, at construction — so it
// is written before the engine starts, and from then on the STATE of the world
// is which of these files exist on disk (stuck_sends() skips entries whose file
// is gone). No restart needed to move between the four states.
// A held destination is kept OUT of entry["route"] on purpose (record_route
// refuses to record a delivery nobody is allowed to attempt), so a held entry
// is `route` without it and `held` with it — which is exactly why neither list
// above can see one and why the panel has to read a third field.
// `hold_cause` is stamped beside `held` by record_route, and it is what the row
// branches on: without it the panel is back to guessing which of the two causes
// it is looking at, which is the defect. These two are held the first way — the
// config above has deid.profile 'off' — and they say so.
const STATE = {
  [F.stuck]: { sent: [], size: 3, mtime: 1, route: ["Ward PACS"], fail: { "Ward PACS": failed } },
  [F.orphan]: { sent: [], size: 3, mtime: 1, route: ["Teaching"], pin: ["Teaching"] },
  [F.held]: { sent: [], size: 3, mtime: 1, route: [], held: ["Research"], hold_cause: "profile-off" },
  [F.all]: { sent: [], size: 3, mtime: 1, route: ["Ward PACS", "Teaching"],
             held: ["Research"], hold_cause: "profile-off", fail: { "Ward PACS": failed } },
};
fs.writeFileSync(path.join(tmp, ".carinopacs_state.json"), JSON.stringify(STATE));

const BASE = "http://127.0.0.1:" + webPort;
const wr = { "Content-Type": "application/json", "X-Carino": "1" };
const getJSON = async (p) => (await fetch(BASE + p)).json();

function present(...paths) {
  for (const p of Object.values(F)) {
    if (paths.includes(p)) fs.writeFileSync(p, "DCM");
    else if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

async function setTeaching(enabled) {
  const cfg = await getJSON("/api/config");
  cfg.destinations = cfg.destinations.map((d) => (d.name === "Teaching" ? { ...d, enabled } : d));
  const r = await fetch(BASE + "/api/config", { method: "POST", headers: wr, body: JSON.stringify(cfg) });
  if (!r.ok) throw new Error("config POST failed: " + (await r.text()));
}

let engine = null, chrome = null, cdp = null;

async function waitForEngine() {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(BASE + "/api/status")).ok) return; } catch (e) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("engine did not come up on " + BASE);
}

function startEngine() {
  engine = spawn("python3", ["-m", "pacs", "-c", cfgPath, "serve"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  engine.stdout.on("data", () => {});
  engine.stderr.on("data", (d) => { if (process.env.VERBOSE) process.stderr.write(d); });
  return waitForEngine();
}

async function stopEngine() {
  if (!engine) return;
  engine.kill("SIGTERM");
  for (let i = 0; i < 50 && engine.exitCode === null; i += 1) await sleep(100);
  if (engine.exitCode === null) engine.kill("SIGKILL");
  engine = null;
  await sleep(200);
}

/* Restart on a config and a send state written from OUTSIDE the dashboard.
   Both have to be: the second hold cause is only reachable from a config the
   dashboard would refuse to save (that is the whole point of it — Config.load
   does not validate, so the file runs and the de-identifier cannot be built from
   it), and SendState is read once at construction. */
async function restartWith(cfg, state) {
  await stopEngine();
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(tmp, ".carinopacs_state.json"), JSON.stringify(state));
  await startEngine();
}

/* Everything the panel says, in one read. Deliberately includes the badge: the
   two are compared in the same tick so a "they agreed eventually" cannot pass
   for "they agree". */
const SNAP = `(function () {
  const l = document.getElementById('stuckList');
  const b = document.getElementById('stuckBadge');
  const all = (s) => [].slice.call(l.querySelectorAll(s));
  const one = (s) => { const e = l.querySelector(s); return e ? e.textContent.trim() : null; };
  return {
    empty: one('.hist-empty'),
    summary: one('.stuck-summary-n'),
    overlap: one('.stuck-summary-sub'),
    groups: all('.stuck-group-t').map((e) => e.textContent.trim()),
    groupCounts: all('.stuck-group-n').map((e) => e.textContent.trim()),
    // Every row on screen, however it is classed: a category rendered under a
    // class this file has never heard of still has to show up in this number,
    // which is what makes the "nothing the engine returns is invisible" check
    // below survive the next list being added.
    rows: all('.stuck-row').length,
    stuckRows: all('.stuck-row:not(.orphan-row):not(.held-row)').length,
    orphanRows: all('.orphan-row').length,
    heldRows: all('.held-row').length,
    // Retry clears a backoff timer. It is honest on a backing-off row and a lie
    // anywhere else, so the count is taken over the WHOLE panel.
    retryButtons: all('.stuck-retry').length,
    messages: all('.orphan-msg').map((e) => e.textContent.trim()),
    heldMessages: all('.held-msg').map((e) => e.textContent.trim()),
    // WHICH hold, per row. Two causes, opposite remedies, and a row that wears
    // the wrong one sends the operator to an edit that discloses.
    heldCauses: all('.held-row').map((r) => {
      const c = r.querySelector('.held-cause');
      return c ? c.textContent.trim() : '';
    }),
    pins: all('.orphan-pin').map((e) => !e.hidden),
    chips: all('.orphan-files .hist-chip').map((e) => e.textContent.trim()),
    heldChips: all('.held-files .hist-chip').map((e) => e.textContent.trim()),
    // The badge reads "⚠ 1" now — the glyph is what tells it apart from the
    // pending badge beside it, so the number is read out of it.
    badge: b.hidden ? null : b.textContent.replace(/[^0-9]/g, ''),
    retryAllDisabled: document.getElementById('stuckRetryAll').disabled,
  };
})()`;

async function refreshPanel(want) {
  await cdp.eval("document.getElementById('stuckRefresh').click()");
  const l = "document.getElementById('stuckList')";
  // A panel that never reaches the expected shape is the FAILURE, not a broken
  // harness: the wait is bounded and then the assertions below report what is
  // actually on screen, so a regression reads as "the badge says 1 and the
  // panel says nothing is stuck" instead of a stack trace three states early.
  try {
    await cdp.waitFor(
      `${l}.querySelectorAll('.stuck-row:not(.orphan-row):not(.held-row)').length === ${want.destRows}`
      + ` && ${l}.querySelectorAll('.orphan-row').length === ${want.orphanRows}`
      + ` && ${l}.querySelectorAll('.held-row').length === ${want.heldRows || 0}`
      + ` && (${want.attention} > 0 || (${l}.querySelector('.hist-empty') || {}).textContent !== 'Loading…')`,
      8000, "the panel to settle on " + JSON.stringify(want));
  } catch (e) {
    bad("the panel never settled on " + JSON.stringify(want) + " — what follows is what it drew instead");
  }
  return cdp.eval(SNAP);
}

// The badge is fed by the 2s status poll, the panel by its own fetch, so the
// badge is given time to catch up with the world before they are compared.
async function badgeSettled(n) {
  const b = "document.getElementById('stuckBadge')";
  // textContent is "⚠ 1" — the glyph is what distinguishes this badge from the
  // pending one sharing the Studies row, so match on the number inside it.
  await cdp.waitFor(n === 0 ? `${b}.hidden` : `!${b}.hidden && ${b}.textContent.replace(/[^0-9]/g, '') === '${n}'`,
                    12000, "the ⚠ badge to read " + n);
}

/* The lists /api/stuck answers with, discovered from the payload rather than
   named here. `held` was added to the engine and to this response while this
   file still only knew two names, and everything that only knew two names
   agreed with itself perfectly. */
const rowLists = (api) => Object.keys(api).filter((k) => Array.isArray(api[k]));

async function state(label, want) {
  console.log("\n── " + label + " ──");
  const api = await getJSON("/api/stuck");
  const status = await getJSON("/api/status");
  check((api.destinations || []).length === want.destRows
        && (api.orphaned || []).length === want.orphanRows
        && (api.held || []).length === (want.heldRows || 0)
        && api.attention_files === want.attention,
        `engine: ${want.destRows} backoff row(s), ${want.orphanRows} orphan row(s), `
        + `${want.heldRows || 0} held row(s), attention_files=${api.attention_files}`);
  check(status.stuck === api.attention_files,
        "status.stuck === attention_files (" + status.stuck + ") — the badge's own number");

  await badgeSettled(want.attention);
  const s = await refreshPanel(want);

  const badgeN = s.badge === null ? 0 : Number(s.badge);
  check(badgeN === want.attention, "badge shows " + (s.badge === null ? "nothing" : s.badge));
  // The defect, stated as a test: a non-zero badge over an empty panel.
  check(!(badgeN > 0 && s.empty), "no 'Nothing stuck' note while the badge is non-zero");
  check(!(badgeN === 0 && (s.stuckRows || s.orphanRows)), "no rows while the badge is hidden");
  if (want.attention === 0) {
    check(s.empty === "Nothing stuck — every forward is up to date.", "panel says everything is up to date");
    check(s.summary === null && !s.groups.length, "no summary and no section headers in the quiet state");
  } else {
    check(s.summary !== null && s.summary.indexOf(String(want.attention)) >= 0,
          "panel summary carries the badge's number: " + JSON.stringify(s.summary));
  }
  check(s.stuckRows === want.destRows && s.orphanRows === want.orphanRows
        && s.heldRows === (want.heldRows || 0),
        `panel drew ${s.stuckRows} backoff row(s), ${s.orphanRows} orphan row(s)`
        + ` and ${s.heldRows} held row(s)`);
  /* Derived from the response, not from `want`: EVERY list the engine answers
     with reaches the screen as rows, and every non-empty one gets a header.
     This is the check that would have caught `held` on the day it shipped, and
     the one that catches the fourth list on the day it does — no edit here. */
  const lists = rowLists(api);
  const engineRows = lists.reduce((n, k) => n + api[k].length, 0);
  check(s.rows === engineRows,
        "every row the engine returned is on screen: " + engineRows + " in "
        + JSON.stringify(lists) + " → " + s.rows + " rendered");
  check(s.groups.length === lists.filter((k) => api[k].length).length,
        "one header per non-empty list: " + JSON.stringify(s.groups));
  /* Same shape for the counts: the badge is attention_files, and every other
     *_files field is a subset of it, so their sum can only exceed it when a
     file is in more than one list — which is exactly when the panel owes the
     operator the "counted once" line. Nothing here names `held_files`. */
  const fileCounts = Object.keys(api).filter((k) => /_files$/.test(k) && k !== "attention_files");
  const summed = fileCounts.reduce((n, k) => n + Number(api[k] || 0), 0);
  check(fileCounts.every((k) => Number(api[k] || 0) <= api.attention_files),
        "no per-list file count exceeds the badge: " + JSON.stringify(fileCounts));
  check(!!s.overlap === (summed > api.attention_files),
        (summed > api.attention_files
          ? "the counted-once note is shown (" + summed + " across the lists, badge " + api.attention_files + ")"
          : "no counted-once note (" + summed + " across the lists, badge " + api.attention_files + ")"));
  check(!!s.overlap === !!want.overlap,
        want.overlap ? "…and that is the state this step set up"
                     : "…and no overlap was set up in this step");
  // POST /api/stuck/retry only clears a backoff timer. On an orphan row there
  // is no node left to dial and on a held row no timer is what is holding it,
  // so the button belongs to the backoff section alone.
  check(s.retryButtons === want.destRows,
        "Retry appears on backoff rows and nowhere else: " + s.retryButtons
        + " button(s) over " + s.rows + " row(s)");
  check(s.retryAllDisabled === (want.destRows === 0),
        "Retry all now is " + (want.destRows ? "live" : "disabled") + " — it has "
        + (want.destRows ? "backoff to clear" : "nothing to clear"));
  if (want.orphanRows) {
    const server = (api.orphaned || []).map((o) => o.message.trim());
    check(JSON.stringify(s.messages) === JSON.stringify(server),
          "orphan rows render the ENGINE's message verbatim (nothing recomposed from the fields)");
    check(JSON.stringify(s.pins) === JSON.stringify((api.orphaned || []).map((o) => !!o.pinned)),
          "the hold-and-forward flag matches `pinned`: " + JSON.stringify(s.pins));
    const names = [].concat(...(api.orphaned || []).map((o) => o.files));
    check(JSON.stringify(s.chips) === JSON.stringify(names),
          "every named file is on screen: " + JSON.stringify(s.chips));
  }
  if (want.heldRows) {
    // Same rule as the orphan message and for a stronger reason: `message` is
    // the engine's reason AND the one edit that releases the hold, and a second
    // copy composed in the browser from `reason`/`remedy` is free to drift from
    // the profile the engine is actually reading.
    const server = (api.held || []).map((h) => h.message.trim());
    check(JSON.stringify(s.heldMessages) === JSON.stringify(server),
          "held rows render the ENGINE's message verbatim (reason AND remedy, nothing recomposed)");
    check(server.every((m, i) => m.includes((api.held[i].reason || "").trim())
                                 && m.includes((api.held[i].remedy || "").trim())),
          "…and that message is the only field carrying both halves");
    const names = [].concat(...(api.held || []).map((h) => h.files));
    check(JSON.stringify(s.heldChips) === JSON.stringify(names),
          "every held file is named on screen: " + JSON.stringify(s.heldChips));
  }
  return s;
}

async function main() {
  await startEngine();

  chrome = spawn(findChrome(), [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions",
    "--remote-debugging-port=" + devPort, "--user-data-dir=" + path.join(tmp, "chrome"), "about:blank",
  ], { stdio: ["ignore", "ignore", process.env.VERBOSE ? "inherit" : "ignore"] });

  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i += 1) {
    try { wsUrl = (await (await fetch("http://127.0.0.1:" + devPort + "/json/version")).json()).webSocketDebuggerUrl; }
    catch (e) { await sleep(200); }
  }
  if (!wsUrl) throw new Error("chromium did not expose a devtools endpoint");
  cdp = await CDP.attach(wsUrl);
  await cdp.open();

  present();                                  // 1. nothing in the outgoing folder
  await cdp.goto(BASE + "/#dlgStuck");
  await cdp.waitFor("!document.getElementById('dlgStudies').hidden && !document.getElementById('dlgStuck').hidden", 10000, "the Stuck panel");
  await state("nothing stuck, nothing orphaned, nothing held",
              { destRows: 0, orphanRows: 0, heldRows: 0, attention: 0 });

  present(F.stuck);                           // 2. only backoff-stuck
  await state("only backoff-stuck", { destRows: 1, orphanRows: 0, heldRows: 0, attention: 1 });

  present(F.orphan);                          // 3. only orphaned, and pinned
  await setTeaching(false);
  const only = await state("only orphaned (pinned)",
                           { destRows: 0, orphanRows: 1, heldRows: 0, attention: 1 });
  check(only.pins[0] === true, "the pin is flagged — a hold-and-forward promise, not an outgrown route");

  /* 4. Only held. The state that was invisible: no failure, so no backoff row;
     kept out of the route on purpose, so no orphan row. The badge counts it,
     and before this the panel underneath said every forward was up to date. */
  present(F.held);
  const heldOnly = await state("only held (a scrub was asked for and cannot happen)",
                               { destRows: 0, orphanRows: 0, heldRows: 1, attention: 1 });
  check(heldOnly.empty === null,
        "the held-only panel does not claim every forward is up to date");
  check(/deid\.profile is 'off'/.test(heldOnly.heldMessages[0] || ""),
        "the row says WHY it is held: " + JSON.stringify((heldOnly.heldMessages[0] || "").slice(0, 80)));
  check(heldOnly.heldCauses[0] === "profile off",
        "…and wears that cause as its own tag: " + JSON.stringify(heldOnly.heldCauses));
  check(/Turn the de-identification profile on/.test(heldOnly.heldMessages[0] || ""),
        "…and prescribes the edit that releases THIS cause");

  present(F.all);                             // 5. one file in ALL THREE lists
  const both = await state("all three at once, one file in every list",
                           { destRows: 1, orphanRows: 1, heldRows: 1, attention: 1, overlap: true });
  const api = await getJSON("/api/stuck");
  check(api.files === 1 && api.orphaned_files === 1 && api.held_files === 1 && api.attention_files === 1,
        "engine counts the file once for the badge (files=1, orphaned_files=1, held_files=1, attention_files=1)");
  check(both.groupCounts.join(" / ") === "1 file / 1 file / 1 file" && both.summary === "1 file needs attention",
        "the panel prints all three section counts AND the single badge number: "
        + both.groupCounts.join(" / ") + " → " + both.summary);
  check(both.pins[0] === false, "an outgrown route is not flagged as hold-and-forward");

  /* pt-BR, because it is the locale that gets forgotten: the panel is redrawn
     on a language switch, so a missing dictionary entry shows up here as an
     English header in the middle of a Portuguese screen. */
  console.log("\n── the same state in pt-BR ──");
  await cdp.eval("window.CarinoLang.set('pt-BR')");
  await cdp.waitFor("document.documentElement.lang === 'pt-BR'", 5000, "the language switch");
  const REDRAWN = "document.querySelectorAll('#stuckList .orphan-row').length === 1"
                + " && document.querySelectorAll('#stuckList .held-row').length === 1";
  try {
    await cdp.waitFor(REDRAWN, 8000, "the redraw");
  } catch (e) { bad("the panel did not redraw its orphan and held rows after the language switch"); }
  const pt = await cdp.eval(SNAP);
  check(pt.groups.join(" | ")
        === "Tentando automaticamente | Sem destino para tentar | Retido — nada está sendo enviado",
        "section headers are translated: " + pt.groups.join(" | "));
  check(pt.summary === "1 arquivo precisa de atenção", "the summary is translated: " + pt.summary);
  check(pt.stuckRows === 1 && pt.orphanRows === 1 && pt.heldRows === 1 && pt.badge === "1",
        "badge and panel still agree after the language switch");
  check(pt.messages[0] === (api.orphaned || [])[0].message.trim()
        && pt.heldMessages[0] === (api.held || [])[0].message.trim(),
        "the engine's messages are still the engine's, in the engine's language");

  /* Width budget. The orphan and held sections each add prose, a chip row of
     file names and a whole engine sentence — the held one carries two, reason
     and remedy — to a panel that used to hold one line each; and the styles ban
     `word-break: break-all`, so an overlong name has to ellipsise
     rather than force the layout wider. ru is the widest locale and ja the one
     that cannot hyphenate; if either makes the page scroll sideways, it is the
     panel that is wrong, not the language. */
  for (const lang of ["ru", "ja", "en"]) {
    await cdp.eval(`window.CarinoLang.set('${lang}')`);
    await cdp.waitFor(`document.documentElement.lang === '${lang}'`, 5000, "the switch to " + lang);
    await cdp.waitFor(REDRAWN, 8000, "the redraw");
    const fits = await cdp.eval(`(function () {
      const d = document.documentElement, l = document.getElementById('stuckList');
      return { page: d.scrollWidth + '/' + d.clientWidth, list: l.scrollWidth + '/' + l.clientWidth,
               ok: d.scrollWidth <= d.clientWidth && l.scrollWidth <= l.clientWidth + 1 };
    })()`);
    check(fits.ok, lang + ": neither the page nor the Stuck list scrolls sideways"
                 + " (page " + fits.page + ", list " + fits.list + ")");
    // Naming the element that sticks out is the difference between "something
    // is too wide" and a fix: the panel is one of many things on this page.
    if (!fits.ok) {
      console.log("        past the right edge: " + JSON.stringify(await cdp.eval(`(function () {
        const w = document.documentElement.clientWidth, out = [];
        document.querySelectorAll('body *').forEach((e) => {
          const r = e.getBoundingClientRect();
          if (r.width > 0 && r.right > w + 0.5) {
            out.push((e.tagName.toLowerCase() + (e.id ? '#' + e.id : '')
                      + '.' + String(e.className || '').split(' ').filter(Boolean).join('.'))
                     + ' → ' + Math.round(r.right));
          }
        });
        return out.slice(0, 8);
      })()`)));
    }
  }
  if (process.env.SHOT) {
    // Tall enough to hold both sections at once — the whole point of the shot
    // is the two of them side by side, and 600px of headless viewport is not.
    await cdp.send("Emulation.setDeviceMetricsOverride",
                   { width: 1180, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    fs.writeFileSync(process.env.SHOT, Buffer.from(shot.data, "base64"));
    ok("screenshot written to " + process.env.SHOT);
  }

  /* Retry all now: it clears backoff and nothing else, so the panel must come
     back with the orphan row still on it — and the button it was clicked on
     must not be left reading '…' forever. */
  console.log("\n── Retry all now, with an orphan on screen ──");
  try {
    await cdp.waitFor("document.getElementById('stuckRetryAll').disabled === false", 8000, "the button to re-enable");
  } catch (e) { bad("Retry all now never came back — there IS backoff to clear in this state"); }
  await cdp.eval("document.getElementById('stuckRetryAll').click()");
  await sleep(1500);
  const after = await cdp.eval(SNAP);
  check(after.orphanRows === 1 && after.heldRows === 1,
        "the orphan and held rows survive a retry — no timer was what held either");
  const label = await cdp.eval("document.getElementById('stuckRetryAll').textContent.trim()");
  check(label === "↻ Retry all now" && await cdp.eval("!document.getElementById('stuckRetryAll').disabled"),
        "the button came back from '…' after a SUCCESSFUL click: " + JSON.stringify(label));

  /* Found while auditing the dashboard for the same defect class: deid.secret_set
     is in both /api/status and /api/config (the key itself is redacted from
     every payload — that boolean IS the whole readout), and nothing rendered
     it. With no key the pseudonyms are a pure function of the input, so anyone
     holding this software can rebuild the mapping from an export; on screen
     that install looked exactly like one with a key. */
  console.log("\n── de-identification site key ──");
  /* The site key is only a fact about today while a profile is ON — with the
     profile off nothing is scrubbed and the line is deliberately absent — and
     this fixture runs with it off, because that is what holds the Research
     forward above. So turn it on first, which is also the exact remedy the held
     row prescribes: one edit, applied through the API the panel points at. */
  const cfgOn = await getJSON("/api/config");
  cfgOn.deid = Object.assign({}, cfgOn.deid, { profile: "basic" });
  const applied = await fetch(BASE + "/api/config", { method: "POST", headers: wr, body: JSON.stringify(cfgOn) });
  check(applied.ok, "the held row's remedy applies through POST /api/config (deid.profile → basic)");
  await cdp.eval("document.querySelector('.navbtn[data-panel=\"dlgConfig\"]').click(); document.querySelector('#dlgConfig .panel-tabs .hist-tab[data-tab=\"settings\"]').click()");
  await cdp.waitFor("!!document.querySelector('#deidState .deid-key')", 10000, "the site-key line");
  const noKey = await cdp.eval(`(function () {
    const e = document.querySelector('#deidState .deid-key');
    return { text: e.textContent.trim(), warn: e.classList.contains('warn') };
  })()`);
  check(noKey.warn && /No site key is set/.test(noKey.text), "with no key the panel says so, in the warning colour");
  const set = await fetch(BASE + "/api/deid/secret", {
    method: "POST", headers: wr, body: JSON.stringify({ action: "set", secret: "site-key-for-the-e2e" }) });
  check((await set.json()).ok === true, "POST /api/deid/secret set a key");
  await cdp.waitFor("/A site key is set/.test((document.querySelector('#deidState .deid-key') || {}).textContent || '')",
                    10000, "the readout to follow the engine");
  check(!(await cdp.eval("document.querySelector('#deidState .deid-key').classList.contains('warn')")),
        "…and the warning colour goes with it");

  /* ── the SECOND hold cause, end to end ──────────────────────────────────
     The state four rounds of this defect could not see: deid.profile is ON, a
     rule asks for a scrub, and no de-identifier can be built — so nothing is
     scrubbed, exactly as with the profile off, and every read-only surface
     called the node de-identified-for anyway. Reached the way it is reachable in
     production: a hand-edited config.json with a JSON number in deid.prefix.
     Config.load() does not validate ("a PACS that refuses to start is a PACS the
     operator cannot fix"), so the file RUNS, Deidentifier.__init__ dies on
     (5 or "ANON").strip(), and the whole price of that decision is that the
     dashboard has to say so. */
  console.log("\n── held the other way: the profile is on and nothing can be built ──");
  const BROKEN = {
    ...CONFIG,
    // Every node enabled again: Teaching was switched off above, and the two
    // held rows below are about causes, not about departed destinations.
    destinations: CONFIG.destinations.map((d) => ({ ...d, enabled: true })),
    deid: { profile: "basic", prefix: 5 },
  };
  await restartWith(BROKEN, {
    // One row per cause, on screen at once. They are not the same problem and
    // the panel has to stop reading as though they were.
    [F.noScrubber]: { sent: [], size: 3, mtime: 1, route: [], held: ["Research"],
                      hold_cause: "no-deidentifier" },
    [F.held]: { sent: [], size: 3, mtime: 1, route: [], held: ["Teaching"],
                hold_cause: "profile-off" },
  });
  present(F.noScrubber, F.held);
  // A real document load, not a hash change: the page has been talking to an
  // engine that went away and come back, and the fragment it is already on
  // (#dlgSettings, from the site-key step) makes Page.navigate a no-op.
  await cdp.goto("about:blank");
  await cdp.goto(BASE + "/#dlgStuck");
  await cdp.waitFor("!document.getElementById('dlgStudies').hidden && !document.getElementById('dlgStuck').hidden", 10000, "the Stuck panel");

  const st2 = await getJSON("/api/status");
  check(st2.deid.profile === "basic" && st2.deid.hold_cause === "no-deidentifier",
        "the engine settles the config-level answer on the second cause: "
        + JSON.stringify({ profile: st2.deid.profile, hold_cause: st2.deid.hold_cause }));
  check(JSON.stringify(st2.deid.destinations) === "[]" && JSON.stringify(st2.deid.held) === '["Research"]',
        "…and /api/status does NOT call that node de-identified-for: "
        + JSON.stringify({ destinations: st2.deid.destinations, held: st2.deid.held }));

  const two = await state("both hold causes at once, one row each",
                          { destRows: 0, orphanRows: 0, heldRows: 2, attention: 2 });
  check(JSON.stringify(two.heldCauses.slice().sort()) === '["no de-identifier","profile off"]',
        "each row wears its own cause: " + JSON.stringify(two.heldCauses));
  const api2 = await getJSON("/api/stuck");
  const rowFor = (name) => (api2.held || []).find((h) => h.name === name) || {};
  const onScreen = (name) => {
    const i = (api2.held || []).indexOf(rowFor(name));
    return two.heldMessages[i] || "";
  };
  check(/no de-identifier could be built/.test(onScreen("Research")),
        "the Research row states the cause it was stamped with: "
        + JSON.stringify(onScreen("Research").slice(0, 90)));
  check(!/deid\.profile is 'off'/.test(onScreen("Research"))
        && !/Turn the de-identification profile on/.test(onScreen("Research")),
        "…and does NOT prescribe turning on a profile that is already on — the advice "
        + "that leaves 'take de-identify off the rule' as the only move left");
  check(/Do NOT turn the profile off/.test(onScreen("Research"))
        && /IDENTIFIED/.test(onScreen("Research")),
        "…it names the two edits that look like remedies and are not");
  check(/deid\.profile is 'off'/.test(onScreen("Teaching")),
        "the row held the FIRST way still says so, on the same screen");

  /* The cause tag is a nowrap token in a row that already carries a chip row and
     two long sentences, and 'нет деидентификатора' is nearly three times the
     width of 'profile off'. Checked where the widest one is actually on screen —
     the earlier width sweep runs on a state that only has the short one. */
  for (const lang of ["ru", "ja", "en"]) {
    await cdp.eval(`window.CarinoLang.set('${lang}')`);
    await cdp.waitFor(`document.documentElement.lang === '${lang}'`, 5000, "the switch to " + lang);
    await cdp.waitFor("document.querySelectorAll('#stuckList .held-cause').length === 2",
                      8000, "both cause tags after the switch to " + lang);
    const fits = await cdp.eval(`(function () {
      const d = document.documentElement, l = document.getElementById('stuckList');
      return { page: d.scrollWidth + '/' + d.clientWidth, list: l.scrollWidth + '/' + l.clientWidth,
               ok: d.scrollWidth <= d.clientWidth && l.scrollWidth <= l.clientWidth + 1,
               tags: [].slice.call(l.querySelectorAll('.held-cause')).map((e) => e.textContent.trim()) };
    })()`);
    check(fits.ok, lang + ": two cause tags and nothing scrolls sideways (page " + fits.page
                 + ", list " + fits.list + ") — " + JSON.stringify(fits.tags));
  }

  /* The de-identification panel, which is where an operator goes after reading
     the row. Same branch, same danger if it asserts the wrong half. */
  await cdp.eval("document.querySelector('.navbtn[data-panel=\"dlgConfig\"]').click(); document.querySelector('#dlgConfig .panel-tabs .hist-tab[data-tab=\"settings\"]').click()");
  await cdp.waitFor("(document.getElementById('deidState').textContent || '').indexOf('Research') >= 0",
                    10000, "the de-identification panel to name the held node");
  const panel2 = await cdp.eval("document.getElementById('deidState').textContent");
  check(/no de-identifier can be built/.test(panel2),
        "the panel names the true cause: " + JSON.stringify(panel2.slice(0, 120)));
  check(!/the de-identification profile is off/.test(panel2) && !/Turn a profile on/.test(panel2),
        "…and never tells a site whose profile is ON to turn it on");
  check(/does NOT release them/.test(panel2),
        "…and says what turning it off would (not) do");

  /* The config-refused banner: the engine has been publishing config_problem
     since it started validating what it loaded, and nothing drew it. */
  console.log("\n── the configuration this engine is running would be refused ──");
  check(!!st2.config_problem && /deid\.prefix/.test(st2.config_problem),
        "the engine publishes the verdict: " + JSON.stringify((st2.config_problem || "").slice(0, 70)));
  const banner = await cdp.eval(`(function () {
    const e = document.getElementById('cfgWarn');
    return e ? { shown: !e.hidden, text: e.textContent.trim() } : null;
  })()`);
  check(banner && banner.shown, "…and the dashboard draws it");
  check(banner && banner.text.includes(st2.config_problem),
        "…carrying the engine's own sentence verbatim: " + JSON.stringify((banner || {}).text || ""));
  check(banner && banner.text.includes(st2.config_path),
        "…and the file to fix it in");

  /* The dry run. Its `attributes` branch is answered in pacs/web.py by a Router
     with no de-identifier in reach, so it reports the config half only — the
     dashboard settles it against the engine's own hold_cause before drawing it,
     which is the last surface that could still print "De-identified for" over a
     study going nowhere. */
  console.log("\n── Explain route, in the state the endpoint cannot see ──");
  await cdp.eval("document.querySelector('.navbtn[data-panel=\"dlgConfig\"]').click(); document.querySelector('#dlgConfig .panel-tabs .hist-tab[data-tab=\"routing\"]').click()");
  await cdp.eval("document.getElementById('rtTest').click()");
  await cdp.waitFor("!document.getElementById('rtResult').hidden", 10000, "the dry-run result");
  await cdp.waitFor("document.querySelectorAll('#rtResult .rt-held').length === 1", 10000, "the held line");
  const rt = await cdp.eval(`(function () {
    const box = document.getElementById('rtResult');
    return { text: box.textContent, held: (box.querySelector('.rt-held') || {}).textContent || '',
             trace: [].slice.call(box.querySelectorAll('.rt-trace')).map((e) => e.className) };
  })()`);
  check(!/De-identified for/.test(rt.text),
        "the dry run does not call a held node de-identified-for: " + JSON.stringify(rt.text.slice(0, 140)));
  check(/no de-identifier can be built/.test(rt.held),
        "…it states the cause: " + JSON.stringify(rt.held.slice(0, 110)));
  check(rt.trace.some((c) => /held/.test(c)),
        "…and the rule that asked for the scrub is drawn as held, not as a green hit: "
        + JSON.stringify(rt.trace));

  /* ── repaired ───────────────────────────────────────────────────────────
     The remedy the row actually prescribes, applied through the API: a string
     prefix. The profile stays ON throughout — that is the difference from the
     first cause, and the whole reason the two rows cannot share a sentence. */
  console.log("\n── repaired: nothing held, nothing refused, nothing stuck ──");
  const fixed = await getJSON("/api/config");
  fixed.deid = { ...fixed.deid, prefix: "ANON" };
  const ok200 = await fetch(BASE + "/api/config", { method: "POST", headers: wr, body: JSON.stringify(fixed) });
  check(ok200.ok, "the row's remedy applies through POST /api/config (deid.prefix → \"ANON\")");
  present();                                  // and the outgoing folder drains
  const st3 = await getJSON("/api/status");
  check(st3.deid.hold_cause === "" && JSON.stringify(st3.deid.destinations) === '["Research"]',
        "the node is de-identified-for again, with no hold: " + JSON.stringify(st3.deid));
  check(st3.config_problem === "", "the config would be accepted now");
  await cdp.eval("document.querySelector('.navbtn[data-panel=\"dlgConfig\"]').click(); document.querySelector('#dlgConfig .panel-tabs .hist-tab[data-tab=\"settings\"]').click()");
  await cdp.waitFor("/Rules de-identify for/.test(document.getElementById('deidState').textContent || '')",
                    10000, "the panel to go quiet");
  await cdp.waitFor("document.getElementById('cfgWarn').hidden", 10000, "the banner to go away");
  ok("the panel and the banner both follow the repair");

  /* ── the door a scrub does not cover ────────────────────────────────────
     Nothing above is wrong and the screen is still misleading: it now says
     "Rules de-identify for: Research" while Q/R and DICOMweb hand out the
     STORED instances — C-MOVE, C-GET and WADO-RS all serve the file as it was
     received, none of them consults deid.profile or a rule. A research node
     that is a de-identified destination AND is allowed to pull takes the
     identified originals through the other door, and the panel that promises
     the scrub is exactly where an operator decides whether to open it. */
  console.log("\n── retrieval serves what is stored, and the panel says so ──");
  const doors = await getJSON("/api/config");
  doors.qr = { ...(doors.qr || {}), enabled: true, port: qrPort, bind: "127.0.0.1" };
  doors.dicomweb = { ...(doors.dicomweb || {}), enabled: true };
  const opened = await fetch(BASE + "/api/config", { method: "POST", headers: wr, body: JSON.stringify(doors) });
  check(opened.ok, "Q/R and DICOMweb opened through POST /api/config");
  // The panel rides on the 2s status poll, so the caveat is waited FOR rather
  // than read on the next tick — the failure this step exists to catch is "it
  // never appears", not "it appeared a moment later".
  try {
    await cdp.waitFor("/FORWARDING only/.test(document.getElementById('deidState').textContent || '')",
                      10000, "the retrieval caveat");
  } catch (e) { bad("the caveat never appeared while Q/R and DICOMweb were open"); }
  const said = await cdp.eval(`(function () {
    return [].slice.call(document.querySelectorAll('#deidState .deid-key')).map((e) => e.textContent.trim());
  })()`);
  const caveat = said.filter((s) => /FORWARDING only/.test(s));
  check(caveat.length === 1, "the panel carries the caveat once: " + JSON.stringify(caveat));
  check(/C-MOVE/.test(caveat[0] || "") && /WADO-RS/.test(caveat[0] || ""),
        "…naming both open doors: " + JSON.stringify(caveat[0] || ""));
  check(/identified originals/.test(caveat[0] || ""),
        "…and what a node that pulls actually receives");
  await cdp.eval("document.querySelector('.navbtn[data-panel=\"dlgStudies\"]').click(); document.querySelector('#dlgStudies .panel-tabs .hist-tab[data-tab=\"stuck\"]').click()");
  const clean = await state("clean: nothing stuck, nothing orphaned, nothing held",
                            { destRows: 0, orphanRows: 0, heldRows: 0, attention: 0 });
  check(clean.heldCauses.length === 0, "and no cause tags left on screen");

  check(cdp.errors.length === 0, "no uncaught page exceptions" + (cdp.errors.length ? ": " + cdp.errors[0] : ""));
}

try {
  await main();
} catch (e) {
  bad("harness: " + (e && e.stack ? e.stack : e));
} finally {
  try { if (cdp) cdp.ws.close(); } catch (e) { /* already gone */ }
  if (chrome) chrome.kill("SIGKILL");
  await stopEngine();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? "\n" + failures + " FAILURE(S)" : "\nAll stuck-panel checks passed.");
process.exit(failures ? 1 : 0);
