/* End-to-end: Activity → Worklist queries against a REAL engine.
 *   node pacs/web/tests/worklist-asks.e2e.mjs
 *
 * A modality pulls the worklist with a query that asks for attributes this
 * appliance does not send (Patient Weight, Allergies, Admission ID). The tab
 * must list them first as "not sent", say how many were filled, translate, fit
 * without sideways scrolling, and never show a patient value — only names of
 * attributes are recorded (pacs/mwlasks.py).
 *
 * Needs a Python with pynetdicom (set PYTHON=, default python3) and a chromium
 * binary (set CHROME=). Harness copied from connections-panel.e2e.mjs. */

import { spawn, spawnSync } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PY = process.env.PYTHON || "python3";

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

/* The smallest CDP client that can drive a page (as in stuck-panel.e2e.mjs). */
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "carino-dicom-asks-"));
const cfgPath = path.join(tmp, "config.json");
const [webPort, mwlPort, devPort] = await freePorts(3);
const CONFIG = {
  scp: { enabled: false, aet: "ASKSPACS", bind: "127.0.0.1", port: mwlPort + 1, storage_dir: path.join(tmp, "received") },
  scu: { enabled: false, aet: "CARINOSCU", watch_dir: path.join(tmp, "outgoing"),
         sent_dir: path.join(tmp, "sent"), pending_dir: path.join(tmp, "pending") },
  mwl: { enabled: true, aet: "ASKSMWL", bind: "127.0.0.1", port: mwlPort },
  ris: { store_dir: path.join(tmp, "ris") },
  index: { enabled: false },
  web: { host: "127.0.0.1", port: webPort },
  logs_dir: path.join(tmp, "logs"),
  setup_completed: "2026-01-01T00:00:00Z",
};
fs.writeFileSync(cfgPath, JSON.stringify(CONFIG, null, 2));
const BASE = "http://127.0.0.1:" + webPort;
const wr = { "Content-Type": "application/json", "X-Carino": "1" };
const PATIENT = "SYNTHETIC^PERSONA";

let engine = null, chrome = null, cdp = null;

async function startEngine() {
  engine = spawn(PY, ["-m", "pacs", "-c", cfgPath, "serve"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  engine.stdout.on("data", () => {});
  engine.stderr.on("data", (d) => { if (process.env.VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(BASE + "/api/status")).ok) return; } catch (e) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("engine did not come up on " + BASE);
}

const ROWS = `[].slice.call(document.querySelectorAll('#asksList .asks-table tr')).slice(1)
  .map((r) => [].map.call(r.cells, (c) => c.textContent))`;

async function main() {
  await startEngine();
  const add = await (await fetch(BASE + "/api/ris/orders", { method: "POST", headers: wr,
    body: JSON.stringify({ patient_name: PATIENT, accession: "E2E7731", modality: "CT", study_desc: "CT HEAD" }) })).json();
  check(add.ok !== false, "an order is created: " + JSON.stringify(add.message || ""));
  for (let i = 0; i < 50; i += 1) {
    const st = await (await fetch(BASE + "/api/status")).json();
    if (JSON.stringify(st).indexOf("ASKSMWL") >= 0) break;
    await sleep(200);
  }
  const py = spawnSync(PY, ["-c", `
from pydicom.dataset import Dataset
from pynetdicom import AE
from pynetdicom.sop_class import ModalityWorklistInformationFind as F
ae = AE(ae_title="CT_E2E"); ae.add_requested_context(F)
a = ae.associate("127.0.0.1", ${mwlPort}, ae_title="ASKSMWL")
q = Dataset(); q.PatientName = ""; q.PatientID = ""; q.AccessionNumber = ""
q.PatientWeight = ""; q.Allergies = ""; q.AdmissionID = ""
s = Dataset(); s.Modality = "CT"; s.ScheduledStationAETitle = ""; q.ScheduledProcedureStepSequence = [s]
n = sum(1 for st, ds in a.send_c_find(q, F) if st and st.Status == 0xFF00)
a.release(); print(n)
`], { cwd: ROOT });
  check(String(py.stdout).trim() === "1", "the modality got its one item: " + JSON.stringify(String(py.stdout).trim() || String(py.stderr).slice(-300)));

  const api = await (await fetch(BASE + "/api/worklist/asks")).text();
  check(api.indexOf("CT_E2E") >= 0, "the engine recorded the query");
  check(api.indexOf("SYNTHETIC") < 0 && api.indexOf("E2E7731") < 0, "no patient value in the record");

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

  console.log("\n── Activity → Worklist queries ──");
  await cdp.goto(BASE + "/#activity/asks");
  await cdp.waitFor("!document.getElementById('dlgAsks').hidden && document.querySelector('#asksList .asks-table')", 10000, "the tab and its table");
  const head = await cdp.eval("document.querySelector('#asksList .caught-head').textContent");
  check(head.indexOf("CT_E2E · 127.0.0.1 · 1 queries") === 0, "the station heads its box: " + JSON.stringify(head));
  const sum = await cdp.eval("document.querySelector('#asksList .asks-sum').textContent");
  check(/^Asks for 9 attributes: 6 filled, 0 sent empty, 3 not sent\.$/.test(sum), "the summary counts: " + JSON.stringify(sum));
  const rows = await cdp.eval(ROWS);
  check(rows.slice(0, 3).every((r) => r[3] === "not sent") &&
        rows.slice(0, 3).map((r) => r[0]).sort().join() === "Allergies,AdmissionID,PatientWeight".split(",").sort().join(),
        "missing attributes come first: " + JSON.stringify(rows.slice(0, 3)));
  check(rows.some((r) => r[0] === "ScheduledProcedureStepSequence > Modality" && r[1] === "(0040,0100) > (0008,0060)" && r[2] === "filter"),
        "a sequence attribute is shown as a path, asked as a filter");
  const text = await cdp.eval("document.getElementById('dlgAsks').textContent");
  check(text.indexOf("SYNTHETIC") < 0, "no patient value on the page");
  if (process.env.SHOT) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    fs.writeFileSync(process.env.SHOT, Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    ok("screenshot written to " + process.env.SHOT);
  }
  for (const [lang, want] of [["es", "sin enviar"], ["pt-BR", "não enviado"], ["ja", "未送信"], ["ru", "не отправлен"]]) {
    await cdp.eval(`window.CarinoLang.set('${lang}')`);
    await cdp.waitFor(`document.documentElement.lang === '${lang}'`, 5000, "the switch to " + lang);
    await cdp.eval("loadAsks()");
    await cdp.waitFor(`document.querySelector('#asksList .asks-table td.ask-bad') && document.querySelector('#asksList .asks-table td.ask-bad').textContent === ${JSON.stringify(want)}`,
                      8000, lang + " status " + want);
    const fits = await cdp.eval(`(function () {
      const d = document.documentElement, l = document.getElementById('asksList');
      return d.scrollWidth <= d.clientWidth && l.scrollWidth <= l.clientWidth + 1
        && document.getElementById('dlgAsks').textContent.indexOf('{') < 0;
    })()`);
    check(fits, lang + ": translated, no unfilled blank, no sideways scroll");
  }
  check(cdp.errors.length === 0, "no uncaught page exceptions: " + JSON.stringify(cdp.errors.slice(0, 3)));
}

try {
  await main();
} catch (e) {
  bad(e.message);
} finally {
  try { if (chrome) chrome.kill("SIGKILL"); } catch (e) { /* gone */ }
  if (engine) {
    engine.kill("SIGTERM");
    for (let i = 0; i < 50 && engine.exitCode === null; i += 1) await sleep(100);
    if (engine.exitCode === null) engine.kill("SIGKILL");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? "\n" + failures + " FAILURE(S)" : "\nAll worklist-query checks passed.");
process.exit(failures ? 1 : 0);
