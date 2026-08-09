/* End-to-end: profiles, capabilities, identifier redaction and the audit trail,
 * against a REAL engine in a REAL browser.
 *   node pacs/web/tests/profiles.e2e.mjs
 *
 * The claim being tested is the one the whole feature rests on, and it is not
 * "the right buttons are hidden". Hiding a button is courtesy; it proves
 * nothing, because a browser is not where access control happens. What has to
 * be true is that the SERVER never sends what the profile may not have — so
 * every check below reads the network payload as well as the screen, and a
 * pass requires both: the panel is gone AND the data behind it never arrived.
 *
 * That distinction is the whole reason this file exists rather than a unit test
 * on can(). A regression that leaves the destination table in the receptionist's
 * /api/status while hiding the nav button would look perfect on screen and would
 * be one devtools tab away from being a disclosure.
 *
 * Driven in order, because each state is built by the previous one:
 *   1. token-only appliance — the People panel offers to turn profiles on
 *   2. seeding does not lock out the person who did it
 *   3. Reception: order intake, no destinations, no routing, no settings —
 *      and no destination host reaches the browser at all
 *   4. IT: the technical surface, with patient names and dates of birth
 *      REDACTED on screen and in the payload, accession and ID still readable
 *   5. a password is set, and the picker asks for it
 *   6. the audit trail names who did each of the above, and verifies intact
 *   7. pt-BR, the locale everybody forgets
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

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.session = null; this.errors = []; }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("cdp connect failed")); });
    const cdp = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "carino-pacs-profiles-"));
const cfgPath = path.join(tmp, "config.json");
const received = path.join(tmp, "received");
fs.mkdirSync(received, { recursive: true });
const [webPort, scpPort, devPort] = await freePorts(3);

// No token: this is the loopback appliance the feature is aimed at, and it is
// also the harder case — turning profiles on is what makes a credential
// mandatory, so there is nothing to fall back on if seeding logs the operator
// out. State 2 is exactly that.
const CONFIG = {
  scp: { enabled: false, aet: "PROFPACS", bind: "127.0.0.1", port: scpPort, storage_dir: received },
  scu: { enabled: false, watch_dir: path.join(tmp, "outgoing") },
  destinations: [
    { name: "Ward PACS", host: "10.99.0.5", port: 11199, aet: "WARDAET", enabled: true },
  ],
  ris: { enabled: false, store_dir: path.join(tmp, "ris") },
  web: { host: "127.0.0.1", port: webPort },
  audit: { enabled: true, dir: path.join(tmp, "audit") },
  logs_dir: path.join(tmp, "logs"),
  setup_completed: "2026-01-01T00:00:00Z",
};
fs.writeFileSync(cfgPath, JSON.stringify(CONFIG, null, 2));

// One order, carrying every identifier class the redactor classifies. It is the
// material the whole "IT is not blind and is not reading the notes" rule is
// about, so it has to be real data in a real store rather than a fixture the
// renderer is handed.
const ORDER = {
  accession: "ACC-77421",
  patient: "Ana Ruiz",
  patient_name: "Ruiz^Ana",
  patient_id: "P-99120",
  patient_birthdate: "19800114",
  patient_sex: "F",
  study_desc: "Head CT without contrast",
  referring: "Dr Solano",
  modality: "CT",
};

// A real stored study carrying the same identifiers, written with pydicom so
// the history browser reads it exactly as it reads a received instance. The
// redaction assertions are made against THIS rather than against a hand-built
// JSON fixture: the whole risk being tested is that a field reaches the browser
// under a spelling nobody classified, and only a real header has the real
// spellings.
const STUDY_UID = "1.2.826.0.1.3680043.10.1337.1";
const mk = spawnSync("python3", ["-c", `
import os, sys
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

ds = Dataset()
ds.PatientName = "Ruiz^Ana"
ds.PatientID = "P-99120"
ds.PatientBirthDate = "19800114"
ds.PatientSex = "F"
ds.AccessionNumber = "ACC-77421"
ds.StudyDescription = "Head CT without contrast"
ds.ReferringPhysicianName = "Solano^Dr"
ds.Modality = "CT"
ds.StudyDate = "20260801"
ds.StudyInstanceUID = ${JSON.stringify(STUDY_UID)}
ds.SeriesInstanceUID = generate_uid()
ds.SOPInstanceUID = generate_uid()
ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.2"
ds.file_meta = FileMetaDataset()
ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
out = os.path.join(${JSON.stringify(received)}, "P-99120", ${JSON.stringify(STUDY_UID)}, "s1")
os.makedirs(out, exist_ok=True)
from pacs.dicomfs import save_dicom
save_dicom(ds, os.path.join(out, "inst.dcm"))
print("ok")
`], { cwd: ROOT, encoding: "utf8" });
if (mk.status !== 0) {
  console.log("  FAIL  could not write the fixture study: " + (mk.stderr || "").trim());
  process.exit(1);
}

const BASE = "http://127.0.0.1:" + webPort;
const wr = { "Content-Type": "application/json", "X-Carino": "1" };

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

/* Sign in as somebody, from a clean page. Returns the profile row it used.
   Goes through the real gate — clicking the real button — rather than posting
   to /api/login, because half of what is being tested is that the gate renders
   the right shape and wires the right body. */
async function signInAs(name, password) {
  await cdp.eval("(async () => { try { await fetch('/api/logout', {method:'POST',headers:{'X-Carino':'1'}}); } catch(e){} })()");
  await cdp.goto(BASE + "/");
  await cdp.waitFor("!document.getElementById('authGate').hidden", 15000, "the sign-in gate");
  await cdp.waitFor("document.querySelectorAll('#authPeople .person').length > 0", 10000, "the profile picker");
  const clicked = await cdp.eval(`(function () {
    const b = [].slice.call(document.querySelectorAll('#authPeople .person'))
      .filter((e) => e.querySelector('b').textContent.trim() === ${JSON.stringify(name)})[0];
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!clicked) throw new Error("no picker button for " + name);
  if (password !== undefined) {
    await cdp.waitFor("!document.getElementById('authPwWrap').hidden", 5000, "the password field");
    await cdp.eval(`(function () {
      const i = document.getElementById('authPassword');
      i.value = ${JSON.stringify(password)};
      document.getElementById('authLogin').click();
    })()`);
  }
  await cdp.waitFor("document.getElementById('authGate').hidden", 15000, "the dashboard after sign-in");
  await sleep(600);          // one status poll, so `me` and the nav have settled
}

/* Which nav entries this browser can see, and what the server actually sent.

   Since the twelve panels became six, the row is only half the answer: four of
   the old panels live behind one Configuration row and two behind one Activity
   row, so a profile can legitimately hold the row and none of the tabs that
   matter. `tabs` is therefore captured per panel, and the assertions below name
   both. A row-only check would pass while a Radiologist reads the shutdown
   control. */
const SNAP = `(function () {
  const nav = [].slice.call(document.querySelectorAll('.navbtn[data-panel]'))
    .filter((b) => !b.hidden)
    .map((b) => b.dataset.panel);
  const tabs = {};
  ['dlgStudies', 'dlgConfig', 'dlgActivity'].forEach(function (id) {
    const p = document.getElementById(id);
    if (!p) return;
    tabs[id] = [].slice.call(p.querySelectorAll('.panel-tabs .hist-tab[data-tab]'))
      .filter((b) => !b.hidden)
      .map((b) => b.dataset.tab);
  });
  return { nav, tabs, who: document.getElementById('whoami').textContent.trim() };
})()`;

/* Ask for a pane by URL and report what actually came up. The merge turned every
   tab into a deep link, so this is the shape of the attack the tab gate exists
   to stop: the panel check passes (the profile legitimately holds the row) and
   the tab is where the privilege is. */
async function reachedByHash(hash, paneId) {
  await cdp.eval("location.hash = " + JSON.stringify(hash) + "; 1");
  await sleep(700);
  return cdp.eval("!document.getElementById('" + paneId + "').hidden");
}

async function statusFor() {
  // Read through the PAGE, so it carries the page's session cookie. This is the
  // half that matters: the nav can be wrong and recoverable, the payload cannot.
  return JSON.parse(await cdp.eval("fetch('/api/status').then(r => r.text())"));
}

async function main() {
  await startEngine();
  chrome = spawn(findChrome(), [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=" + devPort,
    "--user-data-dir=" + path.join(tmp, "chrome"),
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  chrome.stderr.on("data", () => {});

  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i += 1) {
    try {
      const r = await fetch("http://127.0.0.1:" + devPort + "/json/version");
      if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl;
    } catch (e) { /* not up yet */ }
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error("chromium devtools did not come up");
  cdp = await CDP.attach(wsUrl);
  await cdp.open();

  /* ---- 1. token-only: the offer ------------------------------------- */
  await cdp.goto(BASE + "/");
  await cdp.waitFor("document.getElementById('authGate').hidden", 15000, "no gate on a token-less appliance");
  ok("a loopback appliance with no token still opens straight into the dashboard");
  await cdp.eval("document.querySelector('.navbtn[data-panel=\"dlgConfig\"]').click(); document.querySelector('#dlgConfig .panel-tabs .hist-tab[data-tab=\"people\"]').click()");
  await sleep(400);
  check(await cdp.eval("!document.getElementById('peopleOff').hidden"),
        "People offers to turn profiles on while the appliance is token-only");
  check(await cdp.eval("document.getElementById('peopleOn').hidden"),
        "…and shows no profile list yet");

  /* ---- 2. seeding must not lock out the person who did it ------------ */
  // Through the API rather than the button, because the button is behind a
  // confirm() that headless Chromium answers false.
  const seeded = await cdp.eval(`fetch('/api/profiles/seed', {method:'POST',headers:{'X-Carino':'1'}}).then(r => r.text())`);
  const seedBody = JSON.parse(seeded);
  check(seedBody.ok === true, "seeding the presets succeeded");
  check((seedBody.profiles || []).length === 4,
        "four presets: " + (seedBody.profiles || []).map((p) => p.name).join(", "));
  const stillIn = await cdp.eval("fetch('/api/status').then(r => r.status)");
  check(stillIn === 200, "the browser that turned profiles on is still signed in (HTTP " + stillIn + ")");
  const seedWho = (await statusFor()).auth.who || {};
  check(seedWho.admin === true, "…as an administrator: " + JSON.stringify(seedWho.name));
  // And a browser that was NOT the one holding the session is now shut out —
  // otherwise "profiles are on" would mean nothing at all.
  const anon = await fetch(BASE + "/api/status");
  check(anon.status === 401, "a browser with no session is now refused (HTTP " + anon.status + ")");

  // One order to look at, posted while we still hold an admin session.
  const made = await cdp.eval(`fetch('/api/ris/orders', {method:'POST',headers:{'Content-Type':'application/json','X-Carino':'1'},body:${JSON.stringify(JSON.stringify(ORDER))}}).then(r => r.text())`);
  check(JSON.parse(made).ok === true, "an order with real demographics is in the store");

  /* ---- 2b. the gate survives a language switch ------------------------
     #authTitle and #authLede carry data-i18n with the TOKEN wording in the
     markup, and setGateMode() overwrites them with the picker wording at
     runtime. So the language pass — which rewrites every data-i18n node from
     the markup — used to put the token question back over a screen that shows
     no token field: "This PACS needs its access token", above four profile
     buttons, in whichever language you had just chosen. Anybody who switches
     language at the gate sees it, which is the one moment a reader most likely
     will. */
  await cdp.eval("(async () => { try { await fetch('/api/logout', {method:'POST',headers:{'X-Carino':'1'}}); } catch(e){} })()");
  await cdp.goto(BASE + "/");
  await cdp.waitFor("document.querySelectorAll('#authPeople .person').length > 0", 10000,
                    "the profile picker");
  const gateEn = await cdp.eval("document.getElementById('authTitle').textContent.trim()");
  check(gateEn === "Who is using this station?",
        "the gate asks who is at the station, not for a token: " + JSON.stringify(gateEn));
  await cdp.eval("window.CarinoLang.set('es'); 1");
  await sleep(700);
  const gateEs = await cdp.eval(`(function () {
    return { title: document.getElementById('authTitle').textContent.trim(),
             picker: document.querySelectorAll('#authPeople .person').length,
             tokenField: !document.getElementById('authTokenWrap').hidden };
  })()`);
  check(gateEs.title === "¿Quién está usando este puesto?",
        "…and still asks it after a language switch: " + JSON.stringify(gateEs.title));
  check(gateEs.picker === 4 && gateEs.tokenField === false,
        "…with the picker still drawn and no token field behind the question");
  await cdp.eval("window.CarinoLang.set('en'); 1");
  await sleep(500);

  /* ---- 3. Reception -------------------------------------------------- */
  await signInAs("Reception");
  const rec = await cdp.eval(SNAP);
  check(rec.who.indexOf("Reception") === 0, "signed in as Reception: " + JSON.stringify(rec.who));
  check(rec.nav.indexOf("dlgOrders") >= 0, "Reception has the Orders panel");
  // Reception holds none of config.read / routing.read / auth.manage, so the
  // whole Configuration row is absent — the OR-list must not let one of the
  // four tabs drag the row into view.
  check(rec.nav.indexOf("dlgConfig") < 0, "Reception has no Configuration row at all");
  check(rec.nav.indexOf("dlgActivity") < 0, "…and no Activity row (neither logs.read nor audit.read)");
  check(rec.nav.indexOf("dlgServices") < 0, "…and no Services row");
  // The landing panel is Orders, not Studies. Studies opens on History, which
  // is every stored patient's name, ID and date of birth — the wrong thing for
  // a front-desk screen to sit on between patients, and order intake is what
  // this profile is actually for.
  check(await cdp.eval("!document.getElementById('dlgOrders').hidden"),
        "Reception lands on Orders, not on a list of patient names");
  // Asking for the forbidden panes by URL must not produce them.
  check(!(await reachedByHash("#configuration/settings", "dlgSettings")),
        "…#configuration/settings does not open the Settings pane for Reception");
  check(!(await reachedByHash("#dlgPeople", "dlgPeople")),
        "…nor does the legacy #dlgPeople bookmark");
  const recStatus = await statusFor();
  // The load-bearing half. A hidden nav button proves nothing; what matters is
  // that the destination's host never reached this browser.
  check(recStatus.destinations === undefined,
        "…and no destination list was sent to it at all");
  check(JSON.stringify(recStatus).indexOf("10.99.0.5") < 0,
        "…the destination's address appears nowhere in the payload");
  check(recStatus.config_path === undefined, "…nor the config file's path");
  // Reception types the demographics in, so they see them.
  check(JSON.stringify(recStatus).indexOf("Ana Ruiz") >= 0,
        "Reception still sees the patient name — they are the ones keying it in");

  /* ---- 4. IT: the technical surface, without the chart ---------------- */
  await signInAs("IT");
  const it = await cdp.eval(SNAP);
  check(it.nav.indexOf("dlgConfig") >= 0, "IT has the Configuration row");
  check(it.tabs.dlgConfig.join() === "destinations,routing,settings,modalities",
        "…with Destinations, Routing, Settings and Modalities: " + JSON.stringify(it.tabs.dlgConfig));
  check(it.tabs.dlgConfig.indexOf("people") < 0, "…and no People tab — IT cannot manage profiles");
  check(!(await reachedByHash("#configuration/people", "dlgPeople")),
        "…which #configuration/people cannot get around either");
  check(it.nav.indexOf("dlgOrders") < 0, "IT has no Orders panel");
  check(it.tabs.dlgActivity.join() === "logs,audit,caught",
        "IT reads the log, the audit trail and the worklist probes: " + JSON.stringify(it.tabs.dlgActivity));
  const itStatus = await statusFor();
  const itRaw = JSON.stringify(itStatus);
  check(itRaw.indexOf("10.99.0.5") >= 0, "IT does get the destination address — they are not blind");
  check(itRaw.indexOf("ACC-77421") < 0,
        "the order store is gated whole — IT holds no orders.read, so none of it is sent");

  // Per-field redaction, read where IT genuinely receives patient data: the
  // stored-study list, which they hold studies.read for. This is the assertion
  // the whole "IT cannot be in the blind either" decision rests on, so it is
  // made against a real DICOM file on disk rather than a fixture handed to a
  // renderer.
  const itStudies = await cdp.eval("fetch('/api/studies?group=received').then(r => r.text())");
  check(itStudies.indexOf("Ana Ruiz") < 0, "the patient's NAME never reaches IT's browser");
  check(itStudies.indexOf("Ruiz^Ana") < 0, "…in either spelling");
  check(itStudies.indexOf("19800114") < 0, "…nor the date of birth");
  check(itStudies.indexOf("Head CT without contrast") < 0, "…nor what the study was for");
  check(itStudies.indexOf("P-99120") >= 0, "…while the patient ID, which IT is granted, is there");
  check(itStudies.indexOf("***") >= 0, "withheld fields arrive as *** — distinguishable from absent");

  // And the same list read by somebody unrestricted, so a pass cannot come
  // from the study simply not being there.
  await signInAs("Radiologist");
  const radStudies = await cdp.eval("fetch('/api/studies?group=received').then(r => r.text())");
  check(radStudies.indexOf("Ana Ruiz") >= 0,
        "a radiologist reading the same list does see the name — the study is really there");
  await signInAs("IT");
  // The refusal has to be a refusal, not a quiet empty list.
  const denied = JSON.parse(await cdp.eval("fetch('/api/ris/orders').then(r => r.status + '')"));
  check(denied === 403, "IT asking for the order list is refused outright (HTTP " + denied + ")");

  // The accession is the field the whole "IT cannot be in the blind either"
  // decision turns on, so it is asserted on a payload that actually carries one.
  // The study list does not (scan_studies never read AccessionNumber, for
  // anybody), so this grants IT orders.read — a real thing an administrator
  // might do — and checks the order arrives with its accession readable and its
  // demographics not. Two capabilities, one identifier policy, both enforced
  // independently: that is the property being tested.
  await signInAs("Administrator");
  const itRow = (await (await fetch(BASE + "/api/profiles")).json()).profiles
    .filter((p) => p.name === "IT")[0];
  const grant = await cdp.eval(`fetch('/api/profiles/save', {method:'POST',headers:{'Content-Type':'application/json','X-Carino':'1'},body:${JSON.stringify(JSON.stringify({ id: itRow.id, capabilities: ["studies.read", "studies.send", "routing.read", "routing.write", "destinations.write", "services.control", "logs.read", "audit.read", "config.read", "config.write", "emergency.activate", "orders.read"] }))}}).then(r => r.text())`);
  check(JSON.parse(grant).ok === true, "an administrator grants IT the order list");
  await signInAs("IT");
  const itOrders = await cdp.eval("fetch('/api/ris/orders').then(r => r.text())");
  check(itOrders.indexOf("ACC-77421") >= 0,
        "IT now reads the accession number, which is how a study is traced");
  check(itOrders.indexOf("Ana Ruiz") < 0 && itOrders.indexOf("Ruiz^Ana") < 0,
        "…on an order whose patient name is still withheld");
  check(itOrders.indexOf("19800114") < 0, "…and whose date of birth still is");
  check(itOrders.indexOf("Dr Solano") < 0 && itOrders.indexOf("Solano") < 0,
        "…and the referring physician with it");
  // DICOMweb would hand over identifiers in DICOM tags the redactor cannot
  // reach, so a restricted profile is refused there rather than served.
  const dw = await cdp.eval("fetch('/dicom-web/studies').then(r => r.status + '')");
  check(dw === "403", "…and DICOMweb refuses a profile that may not see every identifier (HTTP " + dw + ")");

  /* ---- 4b. the Radiologist, who holds a row but not its dangerous tab --

     This is the case the twelve-to-six merge invented, and the reason the tab
     gate exists as well as the row gate. A Radiologist holds routing.read, so
     the Configuration ROW is legitimately theirs — Destinations and Routing are
     things they read during a failover. They do NOT hold config.read, and the
     Settings pane behind that same row carries #killSvc (shut the engine down)
     and #authFs (rotate the API token). A panel-level check alone would let
     them straight in. */
  await signInAs("Radiologist");
  const rad = await cdp.eval(SNAP);
  check(rad.nav.indexOf("dlgConfig") >= 0,
        "the Radiologist does get the Configuration row — they hold routing.read");
  check(rad.tabs.dlgConfig.join() === "destinations,routing",
        "…but only the two tabs routing.read pays for: " + JSON.stringify(rad.tabs.dlgConfig));
  // The modality registry is config, so it follows config.read like Settings.
  // A Radiologist reads which nodes exist and which rules run; they do not
  // decide what a scanner is called.
  check(rad.tabs.dlgConfig.indexOf("modalities") < 0,
        "…and no Modalities tab, which is config like Settings");
  check(!(await reachedByHash("#configuration/modalities", "dlgModalities")),
        "…which #configuration/modalities cannot get around");
  check(await cdp.eval("!document.getElementById('dlgDests').hidden || document.getElementById('dlgConfig').hidden"),
        "…and opening it lands on Destinations, never on the hidden Settings pane");
  check(!(await reachedByHash("#configuration/settings", "dlgSettings")),
        "…#configuration/settings does not open Settings for them");
  check(!(await reachedByHash("#dlgSettings", "dlgSettings")),
        "…nor does the legacy #dlgSettings bookmark");
  check(await cdp.eval("document.getElementById('killSvc').closest('.tabpane').hidden"),
        "…so the shutdown control is inside a pane that stays shut");
  check(rad.tabs.dlgActivity.join() === "logs",
        "Activity gives them the log only — not the audit trail, not the probes: "
        + JSON.stringify(rad.tabs.dlgActivity));
  // A worklist probe borrows a scanner's identity and returns another system's
  // patients. It follows config.read, like the registry it is run from.
  check(!(await reachedByHash("#activity/caught", "dlgCaught")),
        "…and #activity/caught does not open the probe results for them");
  check(!(await reachedByHash("#activity/audit", "dlgAudit")),
        "…and #activity/audit does not open it");
  check(rad.nav.indexOf("dlgServices") < 0, "no Services row without services.control");
  // Requirement B, stated as a test: the chips stay readable and stop being
  // controls. Service state is not privileged — web.py sends it to everyone —
  // and the receptionist and the radiologist are the people nearest the
  // modality when the receiver dies.
  const chips = await cdp.eval(`(function () {
    const c = [].slice.call(document.querySelectorAll('.svc-chip'));
    return { count: c.length, visible: c.filter((x) => !x.hidden).length,
             disabled: c.filter((x) => x.disabled).length };
  })()`);
  check(chips.count === 6, "the six service chips are mounted: " + JSON.stringify(chips));
  // `hidden` on a chip belongs to showChip()/renderEmergency and tracks which
  // services are ENABLED, not who is looking — two are off in this fixture. The
  // invariant capability must not touch is that some are still on screen.
  check(chips.visible > 0,
        "…and the running ones stay on screen for a profile that cannot work them");
  check(chips.disabled === 6, "…with every one of them disabled instead of hidden");

  /* ---- 5. a password, and the picker asking for it -------------------- */
  await signInAs("Administrator");
  const recRow = (await (await fetch(BASE + "/api/profiles")).json()).profiles
    .filter((p) => p.name === "Reception")[0];
  const savedPw = await cdp.eval(`fetch('/api/profiles/save', {method:'POST',headers:{'Content-Type':'application/json','X-Carino':'1'},body:${JSON.stringify(JSON.stringify({ id: recRow.id, password: { action: "set", value: "front-desk-2026" } }))}}).then(r => r.text())`);
  check(JSON.parse(savedPw).ok === true, "a password is set on Reception");
  const listed = (await (await fetch(BASE + "/api/profiles")).json()).profiles
    .filter((p) => p.name === "Reception")[0];
  check(listed.locked === true, "the picker now advertises Reception as needing one");

  await cdp.eval("(async () => { try { await fetch('/api/logout', {method:'POST',headers:{'X-Carino':'1'}}); } catch(e){} })()");
  await cdp.goto(BASE + "/");
  await cdp.waitFor("document.querySelectorAll('#authPeople .person').length > 0", 10000, "the picker");
  await cdp.eval(`[].slice.call(document.querySelectorAll('#authPeople .person'))
    .filter((e) => e.querySelector('b').textContent.trim() === 'Reception')[0].click()`);
  await cdp.waitFor("!document.getElementById('authPwWrap').hidden", 5000, "the password field");
  ok("picking a locked profile asks for a password instead of signing straight in");
  await cdp.eval(`(function () {
    document.getElementById('authPassword').value = 'wrong';
    document.getElementById('authLogin').click();
  })()`);
  await cdp.waitFor("!document.getElementById('authMsg').hidden && !/Checking|Comprobando|Verificando|確認|Проверка/.test(document.getElementById('authMsg').textContent)",
                    8000, "the refusal itself, not the 'Checking…' that precedes it");
  const msg = await cdp.eval("document.getElementById('authMsg').textContent");
  check(!/token/i.test(msg), "a wrong password is reported as a password problem: " + JSON.stringify(msg));
  check(await cdp.eval("!document.getElementById('authGate').hidden"), "…and the gate stays shut");
  await signInAs("Reception", "front-desk-2026");
  ok("the right password gets in");

  /* ---- 6. the audit trail -------------------------------------------- */
  await signInAs("Administrator");
  const trail = JSON.parse(await cdp.eval("fetch('/api/audit?limit=500').then(r => r.text())"));
  const rows = trail.records || [];
  const actions = rows.map((r) => r.action);
  check(actions.indexOf("login") >= 0, "the trail records sign-ins");
  check(actions.indexOf("login.failed") >= 0, "…and the failed one");
  check(actions.indexOf("denied") >= 0, "…and IT being refused the order list");
  check(rows.some((r) => r.action === "profile.changed" || r.action === "profile.created"),
        "…and the profile changes");
  const named = rows.filter((r) => (r.actor || {}).name === "Reception");
  check(named.length > 0, "records name the person, not just the action: "
        + JSON.stringify((named[0] || {}).action));
  const verified = JSON.parse(await cdp.eval("fetch('/api/audit/verify').then(r => r.text())"));
  check(verified.verify && verified.verify.ok === true,
        "the chain verifies intact over " + ((verified.verify || {}).records || 0) + " records");

  // Tamper with it on disk and the same call has to say so. Without this the
  // chain is decoration.
  const auditFile = path.join(tmp, "audit", "audit.jsonl");
  const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n");
  const victim = JSON.parse(lines[1]);
  victim.actor = { id: "u_000000000001", name: "Somebody Else", role: "", service: false };
  lines[1] = JSON.stringify(victim, Object.keys(victim).sort());
  fs.writeFileSync(auditFile, lines.join("\n") + "\n");
  const broken = JSON.parse(await cdp.eval("fetch('/api/audit/verify').then(r => r.text())"));
  check(broken.verify && broken.verify.ok === false,
        "editing one record to blame somebody else is detected");
  check(/altered|missing|reordered/.test((broken.verify || {}).reason || ""),
        "…and named: " + JSON.stringify((broken.verify || {}).reason || ""));

  /* ---- 7. pt-BR, the locale everybody forgets ------------------------- */
  await cdp.eval("localStorage.setItem('carino_lang', 'pt-BR')");
  await cdp.goto(BASE + "/");
  await sleep(900);
  // People is a tab under Configuration now, so the label to read is the tab's.
  const nav = await cdp.eval(`(function () {
    const b = document.querySelector('#dlgConfig .panel-tabs .hist-tab[data-tab="people"] span');
    return b ? b.textContent.trim() : "";
  })()`);
  check(nav === "Pessoas", "the People tab translates to pt-BR: " + JSON.stringify(nav));
  // The row above it is the one new noun the merge minted.
  const row = await cdp.eval(`(function () {
    const b = [].slice.call(document.querySelectorAll('.navbtn[data-panel="dlgConfig"] span'))
      .filter((e) => !e.classList.contains('nav-ico'))[0];
    return b ? b.textContent.trim() : "";
  })()`);
  check(row === "Configuração", "the Configuration row translates to pt-BR: " + JSON.stringify(row));

  check(cdp.errors.length === 0,
        "no uncaught page exceptions" + (cdp.errors.length ? ": " + cdp.errors[0] : ""));
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
console.log(failures ? "\n" + failures + " FAILURE(S)" : "\nAll profile / capability / audit checks passed.");
process.exit(failures ? 1 : 0);
