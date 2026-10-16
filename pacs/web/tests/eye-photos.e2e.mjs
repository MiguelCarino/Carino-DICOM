/* End-to-end: Orders → 👁 Add eye photos, against a REAL engine and the bundled editor.
 *   node pacs/web/tests/eye-photos.e2e.mjs
 *
 * Three pages have to agree for this to work, and no unit test sees all three:
 * the dashboard hands the editor the order over the Carino Bridge, the editor's
 * Create makes Ophthalmic Photography files from a camera JPEG, and the files
 * come back to the dashboard by postMessage, which files them with its own
 * session. So this drives the real thing:
 *
 *   1. an OP order is queued; its row offers Add eye photos, a CT order's does not
 *   2. the button opens /editor/ in Create → Eye photo, filled with the order
 *   3. a JPEG named …_OD is added and Create and send back is pressed
 *   4. the order is closed as captured and one OP image, right eye, in the
 *      ordered study, is in the outgoing folder
 *
 * Needs a Python with pynetdicom and pydicom (set PYTHON=, default python3) and
 * a chromium binary (set CHROME=). */

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

/* The smallest CDP client that can drive two pages (as in connections-panel.e2e.mjs, plus
   a session per page: the editor is a pop-up the dashboard opens). */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.errors = []; }
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
  send(method, params = {}, sessionId = null) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      setTimeout(() => { if (this.waiting.delete(id)) rej(new Error("CDP timeout: " + method)); }, 30000);
    });
  }
  async page(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    await this.send("Page.enable", {}, sessionId);
    await this.send("Runtime.enable", {}, sessionId);
    const cdp = this;
    return {
      async eval(expr, gesture = false) {
        const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true,
                                                       userGesture: gesture }, sessionId);
        if (r.exceptionDetails) throw new Error("page error: " + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
        return r.result.value;
      },
      async waitFor(expr, timeout = 10000, label = expr) {
        const deadline = Date.now() + timeout;
        for (;;) {
          let v = false;
          try { v = await this.eval("!!(" + expr + ")"); } catch (e) { /* mid-navigation */ }
          if (v) return true;
          if (Date.now() > deadline) throw new Error("timed out waiting for: " + label);
          await sleep(150);
        }
      },
    };
  }
}

/* ---- fixture --------------------------------------------------------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "carino-dicom-eye-"));
const cfgPath = path.join(tmp, "config.json");
const outDir = path.join(tmp, "outgoing");
const [webPort, devPort] = await freePorts(2);
const CONFIG = {
  scp: { enabled: false, storage_dir: path.join(tmp, "received") },
  scu: { enabled: false, watch_dir: outDir, sent_dir: path.join(tmp, "sent"), pending_dir: path.join(tmp, "pending") },
  index: { enabled: false },
  web: { host: "127.0.0.1", port: webPort, editor_url: "/editor/" },
  logs_dir: path.join(tmp, "logs"),
  setup_completed: "2026-01-01T00:00:00Z",
};
fs.writeFileSync(cfgPath, JSON.stringify(CONFIG, null, 2));
const BASE = "http://127.0.0.1:" + webPort;
const wr = { "Content-Type": "application/json", "X-Carino": "1" };

let engine = null, chrome = null;

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

async function order(fields) {
  const r = await (await fetch(BASE + "/api/ris/orders", { method: "POST", headers: wr, body: JSON.stringify(fields) })).json();
  if (r.ok === false) throw new Error("order not queued: " + r.message);
  const list = (await (await fetch(BASE + "/api/ris/orders?status=open")).json()).orders;
  return list.find((o) => o.accession === fields.accession);
}

async function main() {
  await startEngine();
  const eye = await order({ accession: "EYE-1", patient: "DOE^JANE", patient_id: "P-77", patient_birthdate: "1980-01-02",
                            patient_sex: "F", modality: "OP", study_desc: "Fundus photos" });
  await order({ accession: "CT-1", patient: "ROE^RICHARD", patient_id: "P-78", modality: "CT", study_desc: "Head CT" });

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
  const cdp = await CDP.attach(wsUrl);
  const { targetId } = await cdp.send("Target.createTarget", { url: BASE + "/#orders" });
  const dash = await cdp.page(targetId);

  console.log("\n── the order row ──");
  await dash.waitFor("document.querySelectorAll('#ordersList .order-row').length === 2", 15000, "both order rows");
  const offered = await dash.eval(`[].map.call(document.querySelectorAll('#ordersList .order-row'), (r) =>
    [r.querySelector('.order-acc').textContent, !r.querySelector('.order-eye').hidden])`);
  check(JSON.stringify(offered.find((x) => /EYE-1/.test(x[0]))) === JSON.stringify(["ACC EYE-1", true]),
        "the OP order offers Add eye photos: " + JSON.stringify(offered));
  check(offered.some((x) => /CT-1/.test(x[0]) && x[1] === false), "the CT order does not");

  console.log("\n── the editor, opened on the order ──");
  await dash.eval(`[].find.call(document.querySelectorAll('#ordersList .order-row'),
    (r) => /EYE-1/.test(r.querySelector('.order-acc').textContent)).querySelector('.order-eye').click()`, true);
  let edId = null;
  for (let i = 0; i < 100 && !edId; i += 1) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const t = targetInfos.find((x) => x.type === "page" && x.url.indexOf("/editor/") >= 0);
    if (t) edId = t.targetId; else await sleep(150);
  }
  if (!edId) throw new Error("the editor window never opened");
  const ed = await cdp.page(edId);
  await ed.waitFor("typeof createReturn !== 'undefined' && createReturn !== null", 20000, "the order and its way back");
  const form = await ed.eval(`({ id: $('cdPatientID').value, name: $('cdPatientName').value, dob: $('cdPatientDOB').value,
    acc: $('cdAccession').value, uid: $('cdOrderUID').textContent, kind: createKind, tab: activeTab,
    button: createDicomBtn.dataset.i18nKey, url: location.href })`);
  check(form.tab === "create" && form.kind === "eye", "Create opens in Eye photo mode");
  check(form.id === "P-77" && form.name === "DOE^JANE" && form.dob === "1980-01-02" && form.acc === "EYE-1",
        "filled with the order's patient: " + JSON.stringify(form));
  check(form.uid === eye.study_uid, "joining the ordered study");
  check(form.button === "⬆ Create and send back", "the button says where the files go");
  check(form.url.indexOf("P-77") < 0 && form.url.indexOf("DOE") < 0, "no patient detail in the editor's address");

  console.log("\n── Create and send back ──");
  await ed.eval(`(async () => {
    const c = document.createElement('canvas'); c.width = 96; c.height = 64;
    const g = c.getContext('2d'); g.fillStyle = '#c0502a'; g.fillRect(0, 0, 96, 64);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    addCreateImages([new File([blob], 'visit_OD.jpg', { type: 'image/jpeg' })]);
    $('cdEyeDevice').value = 'external';
    $('cdEyeDevice').dispatchEvent(new Event('change'));
    createDicomBtn.click();
  })()`, true);
  await ed.waitFor("createReturn === null && !createDicomBtn.disabled", 30000, "the worklist's answer");
  const block = await ed.eval("$('cdBlock').classList.contains('hidden') ? '' : $('cdBlock').textContent");
  check(block === "", "the editor reports no refusal: " + JSON.stringify(block));

  const closed = (await (await fetch(BASE + "/api/ris/orders?status=closed")).json()).orders.find((o) => o.id === eye.id);
  check(closed && closed.close_reason === "captured", "the order is closed as captured: " + JSON.stringify(closed && closed.close_reason));
  const files = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((n) => n.endsWith(".dcm")) : [];
  check(files.length === 1, "one file in the outgoing folder: " + JSON.stringify(files));
  if (files.length === 1) {
    const py = spawnSync(PY, ["-c", `
import json, sys
from pydicom import dcmread
d = dcmread(sys.argv[1])
print(json.dumps([d.SOPClassUID, d.Modality, d.ImageLaterality, d.StudyInstanceUID, d.PatientID, d.AccessionNumber,
                  d.file_meta.TransferSyntaxUID]))
`, path.join(outDir, files[0])], { cwd: ROOT });
    const got = JSON.parse(String(py.stdout || "null"));
    check(got && got[0] === "1.2.840.10008.5.1.4.1.1.77.1.5.1" && got[1] === "OP" && got[2] === "R",
          "an Ophthalmic Photography 8 Bit image of the right eye: " + JSON.stringify(got));
    check(got && got[3] === eye.study_uid && got[4] === "P-77" && got[5] === "EYE-1", "in the ordered study, for its patient");
    check(got && got[6] === "1.2.840.10008.1.2.4.50", "the camera JPEG kept as JPEG Baseline");
  }
  await dash.waitFor("document.querySelectorAll('#ordersList .order-row').length === 1", 10000, "the order leaving Open");

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
console.log(failures ? "\n" + failures + " FAILURE(S)" : "\nAll eye-photo checks passed.");
process.exit(failures ? 1 : 0);
