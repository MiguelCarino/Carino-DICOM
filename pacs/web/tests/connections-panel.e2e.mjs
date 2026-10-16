/* End-to-end: Activity → Connections and a destination's "What it accepts",
 * against a REAL engine.
 *   node pacs/web/tests/connections-panel.e2e.mjs
 *
 * The engine diagnoses a failed association in a code and its blanks, and the
 * dashboard says the sentence itself so it can be said in the operator's
 * language (js/06-logs.js CONN_TEXT). That split is only worth having if the
 * sentence actually reaches the screen, in English and translated, with the
 * blanks filled — a missing code, an unfilled {dest} or a row that renders
 * nothing all look fine to every Python test. So this drives real refusals:
 *
 *   1. a destination Test against a closed port            (outgoing, refused)
 *   2. a modality whose AE title is not in the allowed list (incoming, rejected)
 *   3. "What it accepts" against this PC's own receiver     (the check, in Destinations)
 *
 * and reads the rows back in en, es, ru and ja, with the same no-sideways-scroll
 * check the Stuck panel uses.
 *
 * Needs a Python with pynetdicom (set PYTHON=, default python3) and a chromium
 * binary (set CHROME=). */

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "carino-dicom-conn-"));
const cfgPath = path.join(tmp, "config.json");
const [webPort, scpPort, devPort, deadPort] = await freePorts(4);
const CONFIG = {
  // CARINOSCU is allowed so "What it accepts" against this PC's own receiver
  // gets as far as the presentation contexts; US_ROOM2 is not.
  scp: { enabled: true, aet: "CONNPACS", bind: "127.0.0.1", port: scpPort,
         storage_dir: path.join(tmp, "received"), allowed_aets: ["CT01", "CARINOSCU"] },
  scu: { enabled: false, aet: "CARINOSCU", watch_dir: path.join(tmp, "outgoing"),
         sent_dir: path.join(tmp, "sent"), pending_dir: path.join(tmp, "pending") },
  index: { enabled: false },
  destinations: [
    { name: "Closed node", host: "127.0.0.1", port: deadPort, aet: "NOBODY", enabled: true },
    { name: "Self", host: "127.0.0.1", port: scpPort, aet: "CONNPACS", enabled: true },
  ],
  web: { host: "127.0.0.1", port: webPort },
  logs_dir: path.join(tmp, "logs"),
  setup_completed: "2026-01-01T00:00:00Z",
};
fs.writeFileSync(cfgPath, JSON.stringify(CONFIG, null, 2));
const BASE = "http://127.0.0.1:" + webPort;
const wr = { "Content-Type": "application/json", "X-Carino": "1" };

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

const ROWS = `(function () {
  return [].slice.call(document.querySelectorAll('#connList .conn-row')).map((r) => ({
    badge: (r.querySelector('.conn-badge') || {}).textContent || '',
    who: (r.querySelector('.conn-who') || {}).textContent || '',
    say: [].slice.call(r.querySelectorAll('.conn-say')).map((e) => e.textContent),
    fix: [].slice.call(r.querySelectorAll('.conn-fix')).map((e) => e.textContent),
  }));
})()`;

async function rowsIn(lang, want) {
  await cdp.eval(`window.CarinoLang.set('${lang}')`);
  await cdp.waitFor(`document.documentElement.lang === '${lang}'`, 5000, "the switch to " + lang);
  await cdp.waitFor(`[].slice.call(document.querySelectorAll('#connList .conn-say')).some((e) => e.textContent.indexOf(${JSON.stringify(want)}) >= 0)`,
                    8000, lang + " sentence " + want);
  return cdp.eval(ROWS);
}

async function main() {
  await startEngine();

  // 1. outgoing: the destination Test against a port nothing listens on.
  const echo = await (await fetch(BASE + "/api/echo", { method: "POST", headers: wr,
    body: JSON.stringify(CONFIG.destinations[0]) })).json();
  check(echo.ok === false, "the Test against a closed port fails");
  // 2. incoming: a modality that is not on the allowed list.
  const py = spawnSync(PY, ["-c", `
from pynetdicom import AE
from pynetdicom.sop_class import Verification
ae = AE(ae_title="US_ROOM2"); ae.add_requested_context(Verification)
a = ae.associate("127.0.0.1", ${scpPort}, ae_title="CONNPACS")
print("rejected" if a.is_rejected else "other")
`], { cwd: ROOT });
  check(String(py.stdout).trim() === "rejected", "the receiver turned US_ROOM2 away");

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

  console.log("\n── Activity → Connections ──");
  await cdp.goto(BASE + "/#activity/connections");
  await cdp.waitFor("!document.getElementById('dlgConnections').hidden", 10000, "the Connections tab");
  const en = await rowsIn("en", "Nothing is listening at 127.0.0.1:" + deadPort + ".");
  const out = en.find((r) => r.who.indexOf("Closed node") >= 0);
  check(out && out.badge === "Nothing listening", "the refused Test is a row with its badge: " + JSON.stringify(out && out.badge));
  check(out && out.fix[0].indexOf("Check that Closed node is running") === 0,
        "its fix names the destination: " + JSON.stringify(out && out.fix[0]));
  const inc = en.find((r) => r.who.indexOf("US_ROOM2") === 0);
  check(inc && inc.say[0] === "US_ROOM2 at 127.0.0.1 was turned away: its AE title is not in the allowed list.",
        "the refused modality is a row in plain words: " + JSON.stringify(inc && inc.say[0]));
  check(inc && inc.fix[0].indexOf("Configuration → Settings → This PACS → Accept only these AEs") >= 0,
        "its fix points at the setting that exists");
  check(en.every((r) => r.say.concat(r.fix).every((t) => t.indexOf("{") < 0)), "no blank is left unfilled");
  if (process.env.SHOT) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    fs.writeFileSync(process.env.SHOT, Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    ok("screenshot written to " + process.env.SHOT);
  }

  const es = await rowsIn("es", "No hay nada escuchando en 127.0.0.1:" + deadPort + ".");
  const esIn = es.find((r) => r.who.indexOf("US_ROOM2") === 0);
  check(esIn && esIn.fix[0].indexOf("Configuración → Ajustes → Este PACS → Aceptar solo estos AE") >= 0,
        "es: the Settings group in the fix is translated too: " + JSON.stringify(esIn && esIn.fix[0]));

  for (const [lang, want] of [["ru", "На 127.0.0.1:" + deadPort + " никто не слушает."],
                              ["ja", "127.0.0.1:" + deadPort + " では何も待ち受けていません。"]]) {
    await rowsIn(lang, want);
    const fits = await cdp.eval(`(function () {
      const d = document.documentElement, l = document.getElementById('connList');
      return d.scrollWidth <= d.clientWidth && l.scrollWidth <= l.clientWidth + 1;
    })()`);
    check(fits, lang + ": neither the page nor the list scrolls sideways");
  }

  console.log("\n── Destinations → What it accepts ──");
  await cdp.eval("window.CarinoLang.set('en')");
  await cdp.waitFor("document.documentElement.lang === 'en'", 5000, "back to en");
  await cdp.eval("goTo('dlgConfig', 'destinations')");
  await cdp.waitFor("document.querySelectorAll('#destBody tr').length === 2", 10000, "the destination rows");
  await cdp.eval(`(function () {
    const tr = [].slice.call(document.querySelectorAll('#destBody tr')).find((r) => r.querySelector('.d-name').value === 'Self');
    tr.querySelector('.accepts').click();
  })()`);
  await cdp.waitFor("!document.getElementById('destCheck').hidden && document.querySelector('#destCheck .conn-check-head')", 20000, "the check result");
  const head = await cdp.eval("document.querySelector('#destCheck .conn-check-head').textContent");
  // This engine runs with the index off: the archive was not read, and the page must not call it empty.
  check(head === "Self accepts the common image types",
        "with the index off, the common image types are asked about: " + JSON.stringify(head));
  const note = await cdp.eval("(document.querySelector('#destCheck .conn-finding.info') || {}).textContent || ''");
  check(note === "The instance index is off, so only the common image types were asked about.",
        "and it says why: " + JSON.stringify(note));
  const cols = await cdp.eval("[].map.call(document.querySelectorAll('#destCheck .conn-pairs th'), (t) => t.textContent)");
  check(cols.indexOf("Stored") < 0 && cols.length === 3, "no Stored column without the index: " + JSON.stringify(cols));
  const pairs = await cdp.eval("document.querySelectorAll('#destCheck .conn-pairs tbody tr.good').length");
  check(pairs === 6, "all six are listed as accepted: " + pairs);
  if (process.env.SHOT) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 1100, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    fs.writeFileSync(process.env.SHOT.replace(/\.png$/, "") + "-check.png",
                     Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await cdp.send("Emulation.clearDeviceMetricsOverride");
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
console.log(failures ? "\n" + failures + " FAILURE(S)" : "\nAll connection-panel checks passed.");
process.exit(failures ? 1 : 0);
