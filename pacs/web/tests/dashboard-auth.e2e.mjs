/* End-to-end: the dashboard against a REAL engine with a token configured.
 *   node pacs/web/tests/dashboard-auth.e2e.mjs
 *
 * Everything here was once "obviously fine" and was not:
 *   1. with a token set, the dashboard rendered its shell and then 401'd every
 *      tile forever, because there was no login UI at all;
 *   2. POST /api/login is a write, so it needs the X-Carino header; without it
 *      web.py answers 403 and the operator is told their token is wrong;
 *   3. a Settings Save posted only the sections the form knew about, and
 *      Config.replace() merges over DEFAULTS — so saving deleted every routing
 *      rule and switched DICOMweb and Q/R off. That one loses images.
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
const TOKEN = "e2e-token-" + Math.random().toString(36).slice(2, 10);
// Rotated part-way through the run, so the header helper reads it live.
let token = TOKEN;
const WRONG = "definitely-not-the-token";

let failures = 0;
const ok = (m) => console.log("  ok    " + m);
const bad = (m) => { failures += 1; console.log("  FAIL  " + m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Allocate n distinct free ports at once: the sockets are held open until all
// of them are known, so two calls cannot come back with the same number.
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
      // An uncaught exception in a poller is invisible on screen — the tile
      // just stops updating — so every one of them is collected and failed on.
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

  async open(url) {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" }, null);
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true }, null);
    this.session = sessionId;
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    return { targetId, url };
  }

  // Count every /api/* request the page makes, from before the first script
  // runs — that is how "the pollers do not hammer a closed door" is measured.
  async installRequestCounter() {
    await this.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__apiCalls = [];
               window.__lastConfigPost = null;
               const _f = window.fetch;
               window.fetch = function (u, o) {
                 window.__apiCalls.push(String(u));
                 // Keep the body of the last config Save: the sections it leaves
                 // out are the ones the engine resets to defaults.
                 if (String(u).indexOf('/api/config') >= 0 && o && String(o.method).toUpperCase() === 'POST') {
                   try { window.__lastConfigPost = JSON.parse(o.body); } catch (e) { /* not ours */ }
                 }
                 return _f.apply(this, arguments);
               };`,
    });
  }

  async goto(url) {
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete'", 15000);
  }

  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("page error: " + (r.exceptionDetails.exception || {}).description);
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

/* ---- fixture: a real engine, a real token, a distinctive config ------ */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "carino-dicom-e2e-"));
const cfgPath = path.join(tmp, "config.json");
const [webPort, scpPort, qrPort, devPort, openPort] = await freePorts(5);

// Every one of these five blocks has no snapshot in the dashboard's older
// collectConfig(), which is exactly what makes them the test.
const CONFIG = {
  scp: { enabled: false, aet: "E2EPACS", bind: "127.0.0.1", port: scpPort, storage_dir: path.join(tmp, "received") },
  scu: { enabled: false, watch_dir: path.join(tmp, "outgoing"), sent_dir: path.join(tmp, "sent"), pending_dir: path.join(tmp, "pending") },
  qr: { enabled: false, aet: "E2EQR", bind: "127.0.0.1", port: qrPort, allowed_aets: ["WORKSTATION9"],
        move_destinations: { WORKSTATION9: { host: "127.0.0.1", port: 104, aet: "WORKSTATION9" } } },
  dicomweb: { enabled: true, allow_stow: false, cors_origins: ["https://viewer.example.org"] },
  index: { enabled: true, path: path.join(tmp, "index.db"), rescan_on_start: false },
  routing: {
    enabled: true,
    rules: [{ name: "CT to the archive", match: { modality: "CT" }, destinations: ["Example PACS"], deidentify: true, stop: true }],
  },
  deid: { profile: "strict", keep_private: false, keep_dates: true, prefix: "E2E" },
  destinations: [{ name: "Example PACS", host: "127.0.0.1", port: 11199, aet: "REMOTE", enabled: true }],
  web: { host: "127.0.0.1", port: webPort, editor_url: "/editor/", auth_token: TOKEN },
  logs_dir: path.join(tmp, "logs"),
  setup_completed: "2026-01-01T00:00:00Z",
};
fs.writeFileSync(cfgPath, JSON.stringify(CONFIG, null, 2));

const BASE = "http://127.0.0.1:" + webPort;
const authed = (extra = {}) => ({ "X-Carino-Token": token, "X-Carino": "1", ...extra });
const getConfig = async () => (await fetch(BASE + "/api/config", { headers: authed() })).json();

let engine = null, chrome = null, cdp = null;

async function waitForEngine() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(BASE + "/api/auth");
      if (r.ok) return r.json();
    } catch (e) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("engine did not come up on " + BASE);
}

async function main() {
  engine = spawn("python3", ["-m", "pacs", "-c", cfgPath, "serve"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  engine.stdout.on("data", () => {});
  engine.stderr.on("data", (d) => { if (process.env.VERBOSE) process.stderr.write(d); });
  const auth = await waitForEngine();
  check(auth.auth && auth.auth.required === true && auth.auth.authenticated === false,
        "GET /api/auth is public and reports required=true, authenticated=false");
  check((await fetch(BASE + "/api/status")).status === 401, "GET /api/status without a credential is 401");

  // The single most likely integration bug: /api/login is a POST, so web.py's
  // cross-site write guard applies to it too.
  const noHeader = await fetch(BASE + "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: TOKEN }) });
  check(noHeader.status === 403, "POST /api/login without X-Carino is 403 (why post() must send the header)");

  const cfgBefore = await getConfig();

  // The wipe, demonstrated against the live engine so the regression below is
  // not testing a rule nobody enforces: this body is exactly the shape the
  // dashboard used to post — every section it had a snapshot for, and none of
  // the five it did not. Config.replace() merges it over DEFAULTS, so the
  // absent sections come back as defaults: routing.rules EMPTIED, dicomweb and
  // Q/R switched off, the de-identification profile reset.
  const oldShape = {};
  for (const k of ["scp", "scu", "print", "mwl", "emergency", "ris", "destinations", "web", "setup_completed", "logs_dir"]) {
    if (cfgBefore[k] !== undefined) oldShape[k] = cfgBefore[k];
  }
  const wiped = await (await fetch(BASE + "/api/config", {
    method: "POST", headers: authed({ "Content-Type": "application/json" }), body: JSON.stringify(oldShape) })).json();
  check((wiped.config.routing.rules || []).length === 0 && wiped.config.dicomweb.enabled === false
        && wiped.config.deid.profile === "basic",
        "control: a save that omits the five sections DOES wipe them (rules deleted, DICOMweb off)");
  // Put it back before the browser ever sees it.
  await fetch(BASE + "/api/config", {
    method: "POST", headers: authed({ "Content-Type": "application/json" }), body: JSON.stringify(cfgBefore) });
  check(JSON.stringify(await getConfig()) === JSON.stringify(cfgBefore), "fixture config restored after the control");

  // ---- browser ----
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
  await cdp.installRequestCounter();
  await cdp.goto(BASE + "/");

  /* (a) the prompt is rendered INSTEAD of the dashboard */
  await cdp.waitFor("document.getElementById('authGate') && !document.getElementById('authGate').hidden",
                    10000, "the token prompt");
  ok("token prompt is up on load");
  check(await cdp.eval("document.getElementById('rxAet').textContent") === "—",
        "no status data is on screen behind the prompt");
  check(await cdp.eval("!!document.getElementById('authToken')"), "the prompt has a token field");

  /* the pollers must not hammer a door they cannot open */
  await sleep(4000);            // > 2 status polls and > 2 log polls
  const calls = await cdp.eval("window.__apiCalls.filter((u) => u.indexOf('/api/') >= 0).length");
  check(calls <= 2, "unauthenticated page made " + calls + " API call(s) in 4s — the 2s/1.5s pollers are stopped");
  check(await cdp.eval("document.getElementById('toast').hidden"), "no error toast stacked up behind the prompt");

  /* (c) a WRONG token is told apart from an expired session */
  await cdp.eval(`(() => { const i = document.getElementById('authToken');
                           i.value = ${JSON.stringify(WRONG)};
                           document.getElementById('authLogin').click(); })()`);
  await cdp.waitFor("document.getElementById('authMsg') && !document.getElementById('authMsg').hidden "
                    + "&& /correct|correcto|correto|正しく|неверен/.test(document.getElementById('authMsg').textContent)",
                    10000, "the wrong-token message");
  ok("a wrong token says the token is wrong: " + JSON.stringify(await cdp.eval("document.getElementById('authMsg').textContent")));
  check(!(await cdp.eval("document.getElementById('authGate').hidden")), "the prompt stays up after a wrong token");

  /* (b) the right token signs in and the tiles fill */
  await cdp.eval(`(() => { const i = document.getElementById('authToken');
                           i.value = ${JSON.stringify(TOKEN)};
                           document.getElementById('authLogin').click(); })()`);
  await cdp.waitFor("document.getElementById('authGate').hidden", 10000, "the prompt to close");
  ok("the correct token signs in");
  await cdp.waitFor("document.getElementById('rxAet').textContent === 'E2EPACS'", 10000, "the receiver tile");
  ok("tiles populate after sign-in (rxAet = E2EPACS)");
  check(await cdp.eval("document.getElementById('qrAet').textContent") === "E2EQR",
        "the Query/Retrieve card is on screen and reads its AE title from status");
  check(await cdp.eval("document.getElementById('authToken').value") === "",
        "the token is not left sitting in the field after sign-in");

  /* the new surfaces exist and carry real values */
  check(await cdp.eval("document.getElementById('rtRules').querySelectorAll('.rt-rule').length") === 1,
        "the routing panel rendered the configured rule");
  check(await cdp.eval("document.querySelector('#rtRules .rt-name').value") === "CT to the archive",
        "the rule's name is in the editor");
  check(await cdp.eval("document.querySelector('#rtRules .rt-dests input:checked').value") === "Example PACS",
        "the rule's destination is ticked");
  // The status-fed readouts are only painted while Settings is open (the poll
  // skips shut panels), so open it before reading them.
  await cdp.eval("document.querySelector('.navbtn[data-panel=\"dlgConfig\"]').click(); document.querySelector('#dlgConfig .panel-tabs .hist-tab[data-tab=\"settings\"]').click()");
  check((await cdp.eval("document.getElementById('dwUrl').value")).endsWith("/dicom-web"),
        "the DICOMweb base URL is shown absolute for pasting into a viewer");
  check(await cdp.eval("document.getElementById('deidProfile').value") === "strict",
        "the de-identification profile is loaded");
  check(await cdp.eval("document.getElementById('idxPath').value") === JSON.stringify(CONFIG.index.path).slice(1, -1)
        || (await cdp.eval("document.getElementById('idxPath').value")) === CONFIG.index.path,
        "the index database path is loaded");
  check(/CARINOQR|C-MOVE/.test(await cdp.eval("document.querySelector('#qrCard .drop-hint').textContent")),
        "the Q/R card warns that C-MOVE calls out as CARINOQR");
  check(/[0-9]/.test(await cdp.eval("document.getElementById('idxInstances').textContent")),
        "the instance-index readout is populated from the status poll");

  /* the routing explain view */
  await cdp.eval(`(() => { document.getElementById('rtModality').value = 'CT';
                           document.getElementById('rtTest').click(); })()`);
  await cdp.waitFor("!document.getElementById('rtResult').hidden", 10000, "the routing test result");
  const decision = await cdp.eval("document.querySelector('#rtResult .rt-decision').textContent");
  check(decision.indexOf("Example PACS") >= 0, "routing test explains the decision: " + JSON.stringify(decision));
  const trace = await cdp.eval("document.querySelector('#rtResult .rt-trace .rt-trace-act').textContent");
  check(/matched/.test(trace), "routing test shows the per-rule trace: " + JSON.stringify(trace));

  /* the index panel's one action */
  // The toast is cleared first every time: it lives for 5s, so "a toast is
  // showing" would otherwise be satisfied by the previous action's.
  await cdp.eval("document.getElementById('toast').hidden = true");
  await cdp.eval("document.getElementById('idxRescanNow').click()");
  await cdp.waitFor("!document.getElementById('toast').hidden", 10000, "the rescan toast");
  ok("Rescan now reaches POST /api/index/rescan: "
     + JSON.stringify(await cdp.eval("document.getElementById('toast').textContent")));

  /* (d) the config-wipe regression */
  await cdp.eval("document.querySelector('.navbtn[data-panel=\"dlgConfig\"]').click(); document.querySelector('#dlgConfig .panel-tabs .hist-tab[data-tab=\"settings\"]').click()");
  await cdp.eval("document.getElementById('toast').hidden = true");
  await cdp.eval("document.getElementById('saveCfg').click()");
  await cdp.waitFor("!document.getElementById('toast').hidden", 10000, "the save toast");
  const toast = await cdp.eval("document.getElementById('toast').textContent");
  check(/Saved|Guardado|Salvo|保存|Сохранено/.test(toast), "Settings Save reported success: " + JSON.stringify(toast));
  await sleep(500);
  const after = await getConfig();
  // Forward-looking: the next config section somebody adds to the engine has to
  // appear in collectConfig() too, or saving deletes it. Comparing the posted
  // body's top-level keys against the engine's own is the whole check.
  const posted = Object.keys(await cdp.eval("JSON.stringify(window.__lastConfigPost)").then(JSON.parse)).sort();
  const known = Object.keys(after).sort();
  // `users` is the one section this Save must NOT carry, and the exemption is
  // load-bearing rather than an oversight. POST /api/config re-asserts the
  // stored profile list and refuses a body that tries to change it, because a
  // caller holding config.write would otherwise be able to post themselves an
  // admin row — and config.write is a capability IT holds. Being exempt from
  // "post it back" therefore means it must be protected some other way, which
  // is what the check below actually proves.
  const CARRIED_BY_THE_SERVER = ["users"];
  const dropped = known.filter((k) => posted.indexOf(k) < 0
                                      && CARRIED_BY_THE_SERVER.indexOf(k) < 0);
  check(dropped.length === 0, "the Save posts back every config section the engine knows about"
        + (dropped.length ? " — missing: " + dropped.join(", ") : ""));
  // The other half: not being posted must not mean being reset. If this ever
  // fails, every profile on the appliance is deleted by a Settings Save and
  // access control silently switches itself off.
  const usersBefore = JSON.stringify(cfgBefore.users);
  const usersAfter = JSON.stringify(after.users);
  check(usersBefore === usersAfter,
        "a Save that does not carry `users` leaves the profile list untouched"
        + (usersBefore === usersAfter ? "" : "\n          before " + usersBefore
                                             + "\n          after  " + usersAfter));
  for (const section of ["qr", "dicomweb", "routing", "index", "deid", "audit", "notify"]) {
    const a = JSON.stringify(cfgBefore[section]);
    const b = JSON.stringify(after[section]);
    check(a === b, "a Settings Save left cfg." + section + " intact" + (a === b ? "" : "\n          before " + a + "\n          after  " + b));
  }
  check(after.web.auth_token === TOKEN || after.web.auth_token === undefined,
        "a Settings Save did not overwrite web.auth_token");
  check(await cdp.eval("(document.getElementById('authState').textContent || '').indexOf('" + TOKEN + "') < 0",
        ), "the stored token is never printed into the page");

  /* Rotation. The token is redacted out of GET /api/config and refused by
     POST /api/config, so it changes only through POST /api/auth/token — which
     wants the CURRENT token in a header, not the session cookie. The dashboard
     does not have it, so the operator types it: that is the affordance. */
  check(cfgBefore.web.auth_token === undefined && cfgBefore.web.auth_token_set === true,
        "GET /api/config redacts the token and reports web.auth_token_set instead");
  await cdp.eval("document.getElementById('authRotateBtn').click()");
  await cdp.waitFor("!document.getElementById('authRotate').hidden", 5000, "the rotation box");
  check(await cdp.eval("document.getElementById('authNewToken').value") === ""
        && await cdp.eval("document.getElementById('authCurToken').value") === "",
        "the rotation fields are empty, never pre-filled with the stored token");
  check(!(await cdp.eval("document.getElementById('authProofWrap').hidden")),
        "a token being set means the current one has to be typed in as proof");

  // Wrong proof is told apart from every other failure.
  await cdp.eval("document.getElementById('toast').hidden = true");
  await cdp.eval(`(() => { document.getElementById('authCurToken').value = ${JSON.stringify(WRONG)};
                           document.getElementById('authNewToken').value = 'not-going-to-be-used-token';
                           document.getElementById('authApply').click(); })()`);
  await cdp.waitFor("!document.getElementById('toast').hidden && /current token|actual|atual|現在|текущий/i"
                    + ".test(document.getElementById('toast').textContent)", 10000, "the wrong-proof message");
  ok("a wrong current token is refused with its own message: "
     + JSON.stringify(await cdp.eval("document.getElementById('toast').textContent")));
  check((await fetch(BASE + "/api/status", { headers: { "X-Carino-Token": token } })).ok,
        "the refused rotation changed nothing — the old token still works");

  await cdp.eval("document.getElementById('authGen').click()");
  const generated = await cdp.eval("document.getElementById('authNewToken').value");
  check(/^[A-Za-z0-9_-]{40,}$/.test(generated), "Generate mints a URL-safe 32-byte token");
  await cdp.eval(`(() => { document.getElementById('authCurToken').value = ${JSON.stringify(token)};
                           document.getElementById('authApply').click(); })()`);
  await cdp.waitFor("!document.getElementById('authGate').hidden", 10000, "the prompt after rotation");
  ok("applying a new token signs this browser out and says so: "
     + JSON.stringify(await cdp.eval("document.getElementById('authMsg').textContent")));
  check(await cdp.eval("document.getElementById('authCurToken').value") === ""
        && await cdp.eval("document.getElementById('authNewToken').value") === "",
        "both typed tokens are wiped out of the DOM once they have been used");
  const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  check(onDisk.web.auth_token === generated, "the generated token is what the engine now holds");
  check((await fetch(BASE + "/api/status", { headers: { "X-Carino-Token": token } })).status === 401,
        "the old token stops working the moment the new one is applied");
  token = generated;
  check((await fetch(BASE + "/api/status", { headers: { "X-Carino-Token": token } })).ok, "the new token works");
  const afterRotate = await getConfig();
  for (const section of ["qr", "dicomweb", "routing", "index", "deid"]) {
    check(JSON.stringify(afterRotate[section]) === JSON.stringify(cfgBefore[section]),
          "the rotation left cfg." + section + " intact");
  }
  await cdp.eval(`(() => { document.getElementById('authToken').value = ${JSON.stringify(generated)};
                           document.getElementById('authLogin').click(); })()`);
  await cdp.waitFor("document.getElementById('authGate').hidden", 10000, "sign-in with the rotated token");
  ok("signing in with the rotated token works");

  /* A service restart drops every session — the cookie is signed with a
     per-process secret. It must read as "sign in again", not as a fault, and
     not as "your token is wrong": the token did not change. */
  engine.kill("SIGKILL");
  await sleep(600);
  engine = spawn("python3", ["-m", "pacs", "-c", cfgPath, "serve"], { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"] });
  await waitForEngine();
  await cdp.waitFor("!document.getElementById('authGate').hidden", 15000, "the prompt after a restart");
  const restartMsg = await cdp.eval("document.getElementById('authMsg').textContent");
  check(/no longer signed in|restart|sesión|sessão|再起動|перезапущ/i.test(restartMsg),
        "a restarted service says the session ended, not that the token is wrong: " + JSON.stringify(restartMsg));
  check(await cdp.eval("document.getElementById('dlgConfig').hidden === false && document.getElementById('dlgSettings').hidden === false"),
        "the operator's place is kept behind the prompt across a restart");
  await cdp.eval(`(() => { document.getElementById('authToken').value = ${JSON.stringify(token)};
                           document.getElementById('authLogin').click(); })()`);
  await cdp.waitFor("document.getElementById('authGate').hidden", 10000, "sign-in after the restart");
  await cdp.waitFor("document.getElementById('rxAet').textContent === 'E2EPACS'", 10000, "tiles after the restart");
  ok("signing in again after a restart brings the dashboard straight back");

  /* The Q/R card's Start actually binds the SCP. Last of the config-touching
     steps on purpose: like the printer and RIS cards it also flips the "start
     on launch" flag, so it changes qr.enabled and every intact-config check
     above has already run. */
  await cdp.eval("document.querySelector('.navbtn[data-panel=\"dlgServices\"]').click()");
  await cdp.eval("document.getElementById('qrToggle').click()");
  await cdp.waitFor("document.getElementById('qrDot').classList.contains('on')", 15000, "the Q/R service to start");
  const qrLive = await (await fetch(BASE + "/api/status", { headers: authed() })).json();
  check(qrLive.qr.running === true && qrLive.qr.port === qrPort,
        "the Q/R card's Start bound the SCP on port " + qrPort);
  check(await cdp.eval("document.getElementById('qrToggle').textContent") !== "Start",
        "the toggle flipped to Stop");
  await cdp.eval("document.getElementById('qrToggle').click()");
  await cdp.waitFor("!document.getElementById('qrDot').classList.contains('on')", 15000, "the Q/R service to stop");
  ok("the Q/R card's Stop takes it down again");

  /* a later 401 re-raises the prompt without losing the operator's place */
  await cdp.eval("document.getElementById('authLogout').click()");
  await cdp.waitFor("!document.getElementById('authGate').hidden", 10000, "the prompt after logout");
  ok("logging out raises the prompt again");
  check(await cdp.eval("document.getElementById('dlgServices').hidden === false"),
        "the panel the operator was on (Services) is still the open one behind the prompt");

  /* The default deployment — loopback, no token — must be untouched by all of
     the above: no prompt, no sign-in, no Log out button to confuse anyone. */
  engine.kill("SIGKILL");
  await sleep(600);
  const openCfg = { ...CONFIG, web: { ...CONFIG.web, port: openPort, auth_token: "" } };
  const openPath = path.join(tmp, "config-open.json");
  fs.writeFileSync(openPath, JSON.stringify(openCfg, null, 2));
  engine = spawn("python3", ["-m", "pacs", "-c", openPath, "serve"], { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"] });
  const openBase = "http://127.0.0.1:" + openPort;
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(openBase + "/api/auth")).ok) break; } catch (e) { await sleep(200); }
  }
  await cdp.goto(openBase + "/");
  await cdp.waitFor("document.getElementById('rxAet').textContent === 'E2EPACS'", 15000, "tiles with no token");
  check(await cdp.eval("document.getElementById('authGate').hidden"), "no token configured: the prompt never appears");
  check(await cdp.eval("document.getElementById('authLogout').hidden"), "no token configured: no Log out button");
  // `.settings label { display: flex }` outranks the UA's [hidden] rule, so
  // this is measured, not assumed: the proof field must really be gone, or the
  // dashboard asks for a "current token" that does not exist yet.
  await cdp.eval("document.getElementById('authRotateBtn').click()");
  await cdp.waitFor("!document.getElementById('authRotate').hidden", 5000, "the rotation box");
  check(await cdp.eval("getComputedStyle(document.getElementById('authProofWrap')).display") === "none",
        "no token configured: the current-token proof field is not asked for");
  check(await cdp.eval("document.getElementById('authClearBtn').hidden"),
        "no token configured: nothing to remove");
  ok("the loopback / no-token deployment is unchanged");

  /* Every string this work added has to exist in all four locales. The parity
     script proves the dictionaries match; this proves the wiring — switch the
     page to Russian and read the new surfaces back. */
  await cdp.eval("window.CarinoLang.set('ru')");
  await sleep(400);
  const ru = await cdp.eval(`JSON.stringify({
    nav: document.querySelector('.navbtn[data-panel="dlgConfig"] span:last-child').textContent,
    tab: document.querySelector('#dlgConfig .panel-tabs .hist-tab[data-tab="routing"] span').textContent,
    card: document.querySelector('#qrCard .card-title span:last-child').textContent,
    idx: document.querySelector('#idxRescanNow').textContent,
    deid: document.querySelector('#deidProfile option[value="strict"]').textContent })`);
  const ruv = JSON.parse(ru);
  check(/[А-Яа-я]/.test(ruv.nav) && /[А-Яа-я]/.test(ruv.tab) && /[А-Яа-я]/.test(ruv.card) && /[А-Яа-я]/.test(ruv.idx) && /[А-Яа-я]/.test(ruv.deid),
        "the new surfaces translate: " + ru);
  await cdp.eval("window.CarinoLang.set('ja')");
  await sleep(400);
  const ja = await cdp.eval("document.querySelector('#qrCard .card-desc').textContent");
  check(/[぀-ヿ一-鿿]/.test(ja), "the Q/R card description translates to Japanese: " + JSON.stringify(ja));
  await cdp.eval("window.CarinoLang.set('pt-BR')");
  await sleep(400);
  const pt = await cdp.eval("document.getElementById('rtAdd').textContent");
  check(/regra/i.test(pt), "pt-BR is not forgotten: Add rule reads " + JSON.stringify(pt));
  await cdp.eval("window.CarinoLang.set('en')");

  /* Rate limiting. Eight wrong tokens inside a minute buy a 30-second block,
     and the engine answers 429 with a Retry-After. The prompt has to say how
     long instead of reading as a generic failure, or the operator answers it by
     hammering the button and keeps the block alive. Last, on a fresh engine, so
     the block it leaves behind delays nothing else. */
  engine.kill("SIGKILL");
  await sleep(600);
  engine = spawn("python3", ["-m", "pacs", "-c", cfgPath, "serve"], { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"] });
  await waitForEngine();
  await cdp.goto(BASE + "/");
  await cdp.waitFor("!document.getElementById('authGate').hidden", 10000, "the prompt on the fresh engine");
  for (let i = 0; i < 8; i += 1) {
    await cdp.eval(`(() => { document.getElementById('authToken').value = 'wrong-' + ${i};
                             document.getElementById('authLogin').click(); })()`);
    await sleep(250);
  }
  await cdp.waitFor("/\\d+/.test(document.getElementById('authMsg').textContent) "
                    + "&& /attempts|intentos|tentativas|失敗|попыток/.test(document.getElementById('authMsg').textContent)",
                    10000, "the rate-limit countdown");
  ok("a 429 shows the wait, not a generic failure: "
     + JSON.stringify(await cdp.eval("document.getElementById('authMsg').textContent")));
  check(await cdp.eval("document.getElementById('authLogin').disabled"),
        "the sign-in button is disabled while the block lasts");

  check(cdp.errors.length === 0, "no uncaught JavaScript exception during the whole run"
        + (cdp.errors.length ? ":\n          " + cdp.errors.slice(0, 3).join("\n          ") : ""));
}

try {
  await main();
} catch (e) {
  bad("threw: " + (e && e.stack ? e.stack : e));
} finally {
  try { if (cdp) cdp.ws.close(); } catch (e) { /* ignore */ }
  if (chrome) chrome.kill("SIGKILL");
  if (engine) engine.kill("SIGKILL");
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? "\n" + failures + " FAILURE(S)" : "\nAll dashboard auth / config-wipe checks passed.");
process.exit(failures ? 1 : 0);
