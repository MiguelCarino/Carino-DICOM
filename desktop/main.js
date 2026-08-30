/* ============================================================
   Carino DICOM desktop — Electron tray agent.
   ------------------------------------------------------------
   Runs the Python DICOM engine (`pacs serve`) as a background child
   process and shows a tray icon. Which DICOM services come up is the
   config's business — the dashboard's setup chooser writes those enabled
   flags, and the shell must not override them from here. The window shows a
   loading screen immediately, then the dashboard once the engine is up
   (or an error page pointing at the engine log). On first run it asks
   where to store data (~/CarinoDICOM, or an existing ~/CarinoPACS), creates
   the folders, and starts the service. Closing the window hides it to the
   tray; Quit (or the dashboard "Shut down service") stops the engine and
   exits.

   Dev run:   cd desktop && npm install && npm start
   ============================================================ */
"use strict";

const { app, BrowserWindow, Tray, Menu, dialog, nativeImage, shell, ipcMain } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const os = require("os");
// Shell-side dictionary (dialogs, tray, engine-failed page). The dashboard and
// the bundled editor translate themselves in the renderer; nothing here can.
// Loaded defensively: every other layer falls back to English when its
// dictionary is absent, and a missing translation file must never be the
// reason the app won't start. If the module is left out of build.files the
// shell just stays English (and this is why it is listed there).
let initI18n = () => {};
let t = (s, vals) => (vals ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vals[k] != null ? vals[k] : m)) : s);
try {
  const i18n = require("./i18n");
  initI18n = i18n.init;
  t = i18n.t;
} catch (e) { /* no dictionary shipped → English */ }

const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(__dirname, "assets");

let tray = null;
let win = null;
let py = null;
let dataDir = defaultDataDir();   // resolved at startup
let serverUrl = "http://127.0.0.1:8042/";

// ---- data folder / first run -------------------------------------------
// The same three-branch order as pacs/config.py's default_dir(), for the same
// reason: a stale ~/CarinoPACS beside a migrated ~/CarinoDICOM must not win, or
// the shell offers the user an archive they already left. The two copies have
// no shared source of truth — change one and you must change the other.
function defaultDataDir() {
  const home = os.homedir();
  const current = path.join(home, "CarinoDICOM");
  const legacy = path.join(home, "CarinoPACS");
  try { if (fs.statSync(current).isDirectory()) return current; } catch (e) {}
  try { if (fs.statSync(legacy).isDirectory()) return legacy; } catch (e) {}
  return current;
}
// The rename moved Electron's userData, so the folder an upgrading user chose
// is recorded in a directory this build never looks at. Read it anyway, from
// the sibling the old name would have produced. defaultDataDir()'s fallback
// only rescues someone who kept the default: a user who picked a folder of
// their own has neither ~/CarinoDICOM nor ~/CarinoPACS, so first run would
// offer them an empty new default and "Use default" is the one click that
// starts the engine on an empty archive with the real one still on disk and
// nothing pointing at it. It matters more here than for the CLI because
// engineCommand() passes --config explicitly, so pacs/config.py's resolver
// never runs for a desktop install and this is the only guard. The three
// spellings are what Electron derives from package.json across the
// generations of this build — the same list reset.sh sweeps.
const LEGACY_USERDATA = ["Carino PACS", "Carino-PACS", "carino-pacs-desktop"];

function locationFile() { return path.join(app.getPath("userData"), "location.json"); }

function readLocation(file) {
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); if (j && j.dir) return j.dir; } catch (e) {}
  return null;
}

function loadSavedDataDir() {
  const own = readLocation(locationFile());
  if (own) return own;
  const siblings = path.dirname(app.getPath("userData"));
  for (const name of LEGACY_USERDATA) {
    const dir = readLocation(path.join(siblings, name, "location.json"));
    // A folder an uninstalled build recorded may be gone, or on a volume that
    // is not mounted; adopting it would start the engine on a path that has to
    // be created from nothing, which is the failure this is here to avoid.
    if (dir && fs.existsSync(dir)) {
      saveDataDir(dir);   // written forward, so the old directory is read once
      return dir;
    }
  }
  return null;   // null → never configured (first run)
}
function saveDataDir(dir) {
  try {
    fs.mkdirSync(path.dirname(locationFile()), { recursive: true });
    fs.writeFileSync(locationFile(), JSON.stringify({ dir }));
  } catch (e) { /* non-fatal */ }
}
function ensureFolders(base) {
  ["", "received", "outgoing", "sent", "logs"].forEach((s) => {
    try { fs.mkdirSync(path.join(base, s), { recursive: true }); } catch (e) {}
  });
}

// First-run: show the default folder, let the user keep or change it, create it.
async function firstRunSetup() {
  const def = defaultDataDir();
  const r = await dialog.showMessageBox({
    type: "question",
    title: t("Carino DICOM — choose data folder"),
    message: t("Where should Carino DICOM store its data?"),
    detail: t("Received images, the outgoing queue and logs are saved here:\n\n{dir}\n\nUse this default, or choose another folder.", { dir: def }),
    buttons: [t("Use default"), t("Choose another…"), t("Quit")],
    defaultId: 0, cancelId: 2, noLink: true,
  });
  if (r.response === 2) return null;   // Quit
  let base = def;
  if (r.response === 1) {
    const pick = await dialog.showOpenDialog({
      title: t("Choose the Carino DICOM data folder"),
      defaultPath: os.homedir(),
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: t("Use this folder"),
    });
    if (!pick.canceled && pick.filePaths[0]) base = pick.filePaths[0];
  }
  ensureFolders(base);
  saveDataDir(base);
  return base;
}

// ---- engine ------------------------------------------------------------
function configPath() { return path.join(dataDir, "config.json"); }

function webConfig() {
  let host = "127.0.0.1", port = 8042;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (cfg.web && cfg.web.port) port = cfg.web.port;
    if (cfg.web && cfg.web.host && cfg.web.host !== "0.0.0.0") host = cfg.web.host;
  } catch (e) { /* first run / no config yet → defaults */ }
  return { host, port };
}

// A bundled PyInstaller binary in a packaged app, or `python -m pacs` in dev.
function engineCommand(host, port) {
  const isWin = process.platform === "win32";
  // NB: --config is a global flag, so it must precede the `serve` subcommand.
  // No --receive/--watch: those are headless overrides, and forcing them here
  // would silently undo every "off" the user picks in the setup chooser.
  const common = ["--config", configPath(), "serve", "--host", host, "--port", String(port)];
  if (app.isPackaged) {
    const bin = path.join(process.resourcesPath, "engine", "pacs-engine", isWin ? "pacs-engine.exe" : "pacs-engine");
    return { cmd: bin, args: common, cwd: dataDir };
  }
  const venv = isWin ? path.join(ROOT, ".venv", "Scripts", "python.exe") : path.join(ROOT, ".venv", "bin", "python");
  const runner = fs.existsSync(venv) ? venv : (isWin ? "python" : "python3");
  return { cmd: runner, args: ["-m", "pacs", ...common], cwd: dataDir };
}

function startEngine() {
  const { host, port } = webConfig();
  serverUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/`;
  const { cmd, args, cwd } = engineCommand(host, port);
  try { fs.mkdirSync(cwd, { recursive: true }); } catch (e) {}

  // Mirror engine output to a file so packaged-build failures are diagnosable.
  let logStream = null;
  try { logStream = fs.createWriteStream(path.join(dataDir, "desktop-engine.log"), { flags: "a" }); } catch (e) {}
  const write = (d) => { const s = `[pacs] ${d}`; process.stdout.write(s); if (logStream) logStream.write(s); };
  if (logStream) logStream.write(`\n=== launch ${new Date().toISOString()} ===\n${cmd} ${args.join(" ")}\n`);

  try {
    // Force UTF-8 stdio so Windows (cp1252) doesn't crash on chars like → … —.
    const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
    py = spawn(cmd, args, { cwd, env, windowsHide: true });
  } catch (err) {
    showError("Failed to launch the engine:\n" + cmd + "\n\n" + err.message);
    return;
  }
  py.stdout.on("data", write);
  py.stderr.on("data", write);
  py.on("exit", (code) => {
    py = null;
    if (app.isQuitting) return;
    if (code === 0) { app.isQuitting = true; app.quit(); return; }   // clean shutdown → quit
    showError("The DICOM engine stopped unexpectedly (exit code " + code + ").");
  });
  py.on("error", (err) => showError("Could not launch the engine:\n" + cmd + "\n\n" + err.message));
}

function waitForServer(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const probe = () => {
      const req = http.get(serverUrl + "api/status", (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      req.on("error", retry);
      req.setTimeout(1500, () => req.destroy());
    };
    const retry = () => (Date.now() > deadline ? resolve(false) : setTimeout(probe, 400));
    probe();
  });
}

// ---- update check ------------------------------------------------------
/* Check-only, on purpose, and the smallest thing that can work: one GET to the
   GitHub releases API. Nothing is downloaded, nothing is installed, there is no
   updater framework and no code signing to keep alive — a shell that runs on a
   clinical machine has no business rewriting itself behind the operator.

   The repo name is a PINNED LITERAL rather than something derived from
   package.json or the git remote, because api.github.com does NOT follow
   GitHub's rename redirect. Point this at a former name and every request 404s
   forever while the app stays perfectly quiet, which is indistinguishable from
   "you are up to date" — the one failure this feature must not have.

   /releases/latest is the right endpoint precisely because it excludes
   prereleases. Today this build is 1.1.0 while the newest STABLE release is
   v1.0.0, so a correct implementation shows NOTHING; a "the tag differs, say
   so" version would invite a 1.1.0 user to go and install 1.0.0. */
// owner/repo, together, in ONE constant. They were two, and the API path was
// built from the repo half alone — /repos/Carino-DICOM/releases/latest, which
// is a 404. fetchLatestTag treats every non-200 as "no answer" and is silent by
// design, so the notifier could never fire and never said why: exactly the
// indistinguishable-from-up-to-date failure the paragraph above exists to
// prevent. One constant, so the two URLs cannot disagree again.
const UPDATE_SLUG = "MiguelCarino/Carino-DICOM";
const UPDATE_API = "/repos/" + UPDATE_SLUG + "/releases/latest";
const RELEASE_PAGE = "https://github.com/" + UPDATE_SLUG + "/releases/latest";
const DAY_MS = 24 * 60 * 60 * 1000;
// Late enough that the check never competes with the engine starting or the
// dashboard loading. The answer is worth nothing in the first seconds anyway.
const FIRST_CHECK_DELAY_MS = 25000;
// The 24 h rule lives in checkForUpdate(); this ticker only has to be finer
// than a day so a machine that is never restarted still checks about daily.
const CHECK_TICK_MS = 6 * 60 * 60 * 1000;

// enabled: null means never asked (first run), false means the user said no.
// Three fields and nothing else — this file is a preference, not a cache.
let updatePrefs = { enabled: null, lastCheckMs: 0, lastSeenVersion: "" };
let update = null;   // { version } while a newer release is known, null otherwise

function updateFile() { return path.join(app.getPath("userData"), "update.json"); }

function loadUpdatePrefs() {
  try {
    const j = JSON.parse(fs.readFileSync(updateFile(), "utf8"));
    // Read field by field: a truthy check on `enabled` would turn a corrupt
    // file's leftover string into a yes the user never gave.
    if (j && typeof j === "object") {
      updatePrefs = {
        enabled: j.enabled === true ? true : (j.enabled === false ? false : null),
        lastCheckMs: Number(j.lastCheckMs) || 0,
        lastSeenVersion: typeof j.lastSeenVersion === "string" ? j.lastSeenVersion : "",
      };
    }
  } catch (e) { /* absent or unreadable → never asked, which is OFF */ }
}
function saveUpdatePrefs() {
  try {
    fs.mkdirSync(path.dirname(updateFile()), { recursive: true });
    fs.writeFileSync(updateFile(), JSON.stringify(updatePrefs));
  } catch (e) { /* non-fatal: the worst case is being asked once more */ }
}

/* Field-by-field numeric compare, never string inequality: "1.9.0" > "1.10.0"
   is true as text and false as a version, and that single mistake points every
   user at an older release. A tag this cannot parse — a date, "nightly", the
   null an empty repo returns — is treated as "no update", because the only safe
   reading of a version we do not understand is that ours is fine. */
function parseVersion(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag == null ? "" : tag).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function isNewer(remote, local) {
  const a = parseVersion(remote), b = parseVersion(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;   // equal is not newer, and neither is older
}

/* One request, ten seconds, no retry. A failure is SILENT AND FORGOTTEN: no
   dialog, no retry loop, and above all no log line. This app runs on air-gapped
   clinical networks where a daily "couldn't reach GitHub" is noise in the one
   log an operator opens to diagnose a real problem. */
function fetchLatestTag(cb) {
  let done = false;
  const finish = (tag) => { if (!done) { done = true; cb(tag); } };
  let req;
  try {
    req = https.get({
      hostname: "api.github.com",
      path: UPDATE_API,
      headers: {
        Accept: "application/vnd.github+json",
        // Not decoration: GitHub rejects a request that carries no User-Agent,
        // so without this every check would 403 and nothing would ever fire.
        "User-Agent": "Carino-DICOM-desktop",
      },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return finish(null); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        body += d;
        // A release payload is a few kB. Anything past this is not the reply we
        // asked for, and buffering it would be the only unbounded thing here.
        if (body.length > 262144) { req.destroy(); finish(null); }
      });
      res.on("end", () => { try { const j = JSON.parse(body); finish(j && j.tag_name); } catch (e) { finish(null); } });
      res.on("error", () => finish(null));
    });
  } catch (e) { return finish(null); }
  req.on("timeout", () => req.destroy());   // destroy → "error" → finish(null)
  req.on("error", () => finish(null));
}

function checkForUpdate(force) {
  if (updatePrefs.enabled !== true) return;
  const now = Date.now();
  // At most once a day. The stamp is written BEFORE the request goes out, so a
  // network that hangs and a user who restarts cannot together turn this into a
  // request loop against api.github.com.
  if (!force && now - updatePrefs.lastCheckMs < DAY_MS) return;
  updatePrefs.lastCheckMs = now;
  saveUpdatePrefs();
  fetchLatestTag((tag) => {
    // One test covers null, garbage, older and equal — every one of which means
    // there is nothing to say, and saying nothing is the whole design here.
    if (!isNewer(tag, app.getVersion())) return;
    updatePrefs.lastSeenVersion = String(tag).replace(/^v/, "");
    saveUpdatePrefs();
    setUpdate(updatePrefs.lastSeenVersion);
  });
}

/* The notice lives in exactly two places — the tray menu and the dashboard's
   Overview Version row — and both are painted from here, so they can never
   disagree about what this machine knows. */
function setUpdate(version) {
  update = version ? { version } : null;
  refreshTray();
  sendUpdate();
}
function sendUpdate() {
  if (win && !win.isDestroyed()) { try { win.webContents.send("carino:update", update); } catch (e) {} }
}
function openReleasePage() { shell.openExternal(RELEASE_PAGE); }

/* Asked once, in one sentence, and never again: dismissing the dialog is an
   answer and it means no. The default when nothing has ever been recorded is
   OFF, which is what makes this opt-in rather than an announcement with a
   checkbox attached. */
async function askUpdateOptIn() {
  const r = await dialog.showMessageBox({
    type: "question",
    title: t("Carino DICOM — updates"),
    message: t("Should Carino DICOM check GitHub for a newer version?"),
    detail: t("It only looks — nothing is downloaded or installed. A newer version appears in the tray menu and on the Overview panel. You can change this at any time from the tray."),
    buttons: [t("Check for updates"), t("Don't check")],
    defaultId: 0, cancelId: 1, noLink: true,
  });
  setUpdateEnabled(r.response === 0);
}

function setUpdateEnabled(on) {
  updatePrefs.enabled = !!on;
  saveUpdatePrefs();
  // Switching it off retracts the notice as well; leaving it on screen would be
  // the app arguing with the answer it was just given.
  if (!on) { setUpdate(null); return; }
  refreshTray();
  checkForUpdate(true);   // an explicit yes deserves an answer now, not tomorrow
}

// Runs once, well after the window is up.
async function startUpdateChecks() {
  loadUpdatePrefs();
  /* A version found yesterday is worth showing today without needing a network
     at all — that is what lastSeenVersion is for. It is re-tested against THIS
     build's version, so installing the update is what clears it, and nothing
     has to remember to. */
  if (updatePrefs.enabled === true && isNewer(updatePrefs.lastSeenVersion, app.getVersion())) {
    setUpdate(updatePrefs.lastSeenVersion);
  }
  if (updatePrefs.enabled === null) await askUpdateOptIn();
  else refreshTray();   // the tray was built before the file was read
  checkForUpdate(false);
  setInterval(() => checkForUpdate(false), CHECK_TICK_MS);
}

// ---- window + tray -----------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1150, height: 820, show: false,
    title: "Carino DICOM", icon: path.join(ASSETS, "icon.png"),
    backgroundColor: "#050505", autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false,
      // The dashboard is the same page any browser gets from 127.0.0.1, so this
      // bridge only ever ADDS a fact the page feature-detects (see preload.js).
      // It is attached at construction because the window is never recreated —
      // loading.html and the dashboard are two navigations of this same one.
      preload: path.join(__dirname, "preload.js"),
      // Passed as a switch so the bridge can answer synchronously: the renderer
      // reads the shell version while it is drawing, and an IPC round trip there
      // would mean drawing the row once without it.
      additionalArguments: ["--carino-app-version=" + app.getVersion()],
    },
  });
  win.loadFile(path.join(__dirname, "loading.html"));   // never a blank/black window
  // A check can resolve before the dashboard exists, and a send into a page that
  // is not there yet is simply dropped. Re-announcing on every load is what
  // carries the notice across the loading.html → dashboard navigation, and back
  // across a reload.
  win.webContents.on("did-finish-load", sendUpdate);
  win.webContents.setWindowOpenHandler(({ url }) => {
    // The bundled editor opens in its OWN Electron window (not the system
    // browser). action:"allow" keeps window.opener wired, so the PACS→editor
    // postMessage bridge still delivers the study. Everything else (GitHub,
    // LinkedIn, …) opens in the user's browser.
    try {
      const u = new URL(url);
      // Segment test, not a prefix test, and it must stay identical to the one
      // in preload.js: they disagreed, and the set between them —
      // http://127.0.0.1:9999/editorEVIL/ — opened as an in-app Electron window
      // while the preload still published the bridge into it, which is the one
      // combination neither guard is allowed to admit. Protocol and port are
      // checked too: the engine this shell started is at serverUrl and nothing
      // else on this machine is the bundled editor, whatever it calls its path.
      const local = u.protocol === "http:" && u.origin === new URL(serverUrl).origin;
      if (local && /^\/editor(\/|$)/.test(u.pathname)) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: 1200, height: 860,
            title: "Carino DICOM Editor", icon: path.join(ASSETS, "icon.png"),
            backgroundColor: "#000000", autoHideMenuBar: true,
            webPreferences: {
              contextIsolation: true, nodeIntegration: false,
              // Written out rather than left off: a window opened through this
              // handler inherits the embedder's webPreferences and this object
              // is merged OVER them, so omitting the key is not the same as
              // asking for none. The bundled editor is a separate product with
              // its own releases — handing it the PACS's update state would
              // print the wrong version in the wrong app, silently. Whether an
              // undefined actually wins that merge is Electron's business, so
              // preload.js refuses to publish the bridge on /editor as well.
              preload: undefined,
            },
          },
        };
      }
    } catch (_) { /* not a parseable URL — refused below, like any other */ }
    openExternally(url);
    return { action: "deny" };
  });
  // A renderer must not be able to navigate this window away from the engine.
  // It matters more than it did: the window now carries a preload, and a page
  // that reached an attacker origin would keep it attached, so the bridge —
  // and openExternally behind it — would be published to that origin.
  const stayHome = (e, url) => {
    try {
      if (new URL(url).origin === new URL(serverUrl).origin) return;
    } catch (_) { /* unparseable is not our origin either */ }
    e.preventDefault();
    openExternally(url);
  };
  win.webContents.on("will-navigate", stayHome);
  win.webContents.on("will-frame-navigate", (e) => {
    if (!e.isMainFrame) stayHome(e, e.url);
  });
  win.on("close", (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
}

/* Every URL this shell hands to the operating system goes through here.
   shell.openExternal launches whatever handler the OS has registered for a
   scheme, so an unfiltered call is an arbitrary-launcher: file:// opens a local
   application, smb:// posts an NTLM hash to a remote share on Windows, and
   ms-msdt: and friends are a documented command-execution surface. The
   renderer is the least trusted input this process takes — the dashboard is
   plain HTTP on loopback, reachable by any other process on this machine — so
   nothing but a real web link is allowed out. An unparseable string is refused,
   not passed on: `new URL()` throwing is not a reason to trust it more.
   Deliberately not a log line: a refusal here is either a bug of ours or an
   attack, and neither is the operator's to read at 3am. */
function openExternally(url) {
  let u;
  try { u = new URL(String(url)); } catch (_) { return; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return;
  shell.openExternal(u.href);
}

function showError(msg) {
  const logPath = path.join(dataDir, "desktop-engine.log");
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const html = "<!doctype html><meta charset=utf-8><style>" +
    "body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#050505;" +
    "color:#f5f5f5;font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:24px}" +
    ".b{max-width:560px}h2{color:#ef4444;margin:0 0 12px}p{color:#8a8a8a;line-height:1.55}" +
    "code{color:#f5f5f5;background:#111;padding:2px 6px;border-radius:4px;font-size:.85em;word-break:break-all}</style>" +
    "<div class=b><h2>" + esc(t("Carino DICOM couldn't start")) + "</h2><p>" + esc(msg).replace(/\n/g, "<br>") + "</p>" +
    "<p>" + esc(t("Details were written to:")) + "<br><code>" + esc(logPath) + "</code></p></div>";
  if (win && !win.isDestroyed()) {
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    win.show();
  }
}

function showWindow() { if (!win) createWindow(); win.show(); win.focus(); }

/* Built from a live array rather than a constant, because two of these rows
   describe state that changes while the app runs. Every caller goes through
   refreshTray() — a template is a snapshot, and Electron keeps the menu it was
   handed until it is handed another one. */
function buildMenu() {
  const items = [
    { label: t("Open Carino DICOM"), click: showWindow },
    { type: "separator" },
  ];
  // Present only when there is something to say. An always-there row that reads
  // "no updates" is a permanent negative in a menu that is otherwise all verbs,
  // and it would be one more thing to notice on a screen nobody is watching.
  if (update) {
    items.push({ label: t("Update available — {v}", { v: update.version }), click: openReleasePage });
    items.push({ type: "separator" });
  }
  items.push({
    label: t("Start at login"), type: "checkbox",
    checked: app.getLoginItemSettings().openAtLogin,
    click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
  });
  // Unchecked until the first-run question is answered, which is also what it
  // looks like when the answer was no — both are OFF, and OFF is the default.
  items.push({
    label: t("Check for updates"), type: "checkbox",
    checked: updatePrefs.enabled === true,
    click: (item) => setUpdateEnabled(item.checked),
  });
  items.push({ type: "separator" });
  items.push({ label: t("Quit Carino DICOM"), click: quitApp });
  return Menu.buildFromTemplate(items);
}

function refreshTray() { if (tray) tray.setContextMenu(buildMenu()); }

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, "tray.png")));
  tray.setToolTip(t("Carino DICOM — DICOM store"));
  tray.setContextMenu(buildMenu());
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
}

function quitApp() {
  app.isQuitting = true;
  if (py) { try { py.kill(); } catch (e) {} py = null; }
  app.quit();
}

// ---- lifecycle ---------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(async () => {
    // app.getLocale() is only reliable once ready, and everything that draws
    // shell text (first-run dialog, tray, error page) runs after this point.
    initI18n(app);
    Menu.setApplicationMenu(null);
    // The only thing the renderer may ask this process to do. It takes no
    // argument, so there is no URL a compromised page could aim it at.
    ipcMain.on("carino:open-release-page", openReleasePage);

    let base = loadSavedDataDir();
    if (!base) { base = await firstRunSetup(); if (!base) { app.quit(); return; } }
    dataDir = base;
    ensureFolders(dataDir);

    createWindow();   // shows loading.html
    createTray();
    showWindow();     // visible right away — no black screen

    startEngine();
    const up = await waitForServer();
    if (up) win.loadURL(serverUrl);
    else showError("The dashboard did not respond in time. The engine may have failed to start.");

    // Last, and on a timer: whether a newer release exists is the least urgent
    // thing this process knows, and the first-run question must not arrive on
    // top of a window that is still coming up.
    setTimeout(startUpdateChecks, FIRST_CHECK_DELAY_MS);
  });

  app.on("window-all-closed", () => { /* keep running in the tray */ });
  app.on("activate", showWindow);
  app.on("before-quit", () => { app.isQuitting = true; if (py) { try { py.kill(); } catch (e) {} } });
}
