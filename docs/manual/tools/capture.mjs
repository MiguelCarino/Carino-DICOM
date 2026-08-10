/* Capture the dashboard figures the manual shows, in one language per run.
 *
 *   node capture.mjs <lang> <outDir> [baseUrl] [token] [mode]
 *
 * mode: "panels" (default) — every figure the dashboard holds, and the bundled
 *                            editor. The dashboard is six nav rows now, and
 *                            most of these figures are a tab inside one of
 *                            them, so a figure is a row click and then a tab
 *                            click (see open() below).
 *       "setup"            — the token gate and the first-run service chooser,
 *                            which only exist on an appliance that has never
 *                            been set up (see README.md)
 *       "people"           — the People tab of Configuration and the profile
 *                            picker, which only exist on one that has. Run this
 *                            LAST: it is the one that leaves the instance
 *                            changed.
 *
 * Drives headless Chromium over CDP with node's built-in WebSocket, so this has
 * no dependencies at all — no puppeteer, no npm install, nothing to keep in step
 * with a browser version. It needs `chromium-browser` on PATH (override with
 * CHROMIUM=/path/to/chrome).
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LANG = process.argv[2] || 'en';
const OUT = process.argv[3];
const BASE = process.argv[4] || 'http://127.0.0.1:8145/';
const TOKEN = process.argv[5] || 'manual-screenshots-token';
const MODE = process.argv[6] || 'panels';
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium-browser';

if (!OUT) {
  console.error('usage: node capture.mjs <lang> <outDir> [baseUrl] [token] [mode]');
  process.exit(2);
}

// 1440×900 at 2×: the manual's column is 820px, so this is a little over 2×
// device pixels once it is scaled down — enough that a reader who zooms into a
// port number or an AE title still reads it. It is also wide enough for the
// three-column form of Settings, which is what the wider wrap buys and what the
// manual's figure of it is expected to show; a narrower window photographs two
// columns and makes the pane look twice as long as it is.
const W = 1440, H = 900, SCALE = 2;
const PORT = 9400 + (process.pid % 400);
// A fresh profile every run, deliberately: a session cookie left in the profile
// signs the browser straight in, and the gate would never be drawn at all.
const PROFILE = join(tmpdir(), `carino-manual-${LANG}-${MODE}-${process.pid}`);

await mkdir(OUT, { recursive: true });
const chrome = spawn(CHROMIUM, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--window-size=${W},${H}`,
  '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  '--force-prefers-reduced-motion',        // the EKG and the spinners hold still
  `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let target = null;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(250);
  try {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
    target = list.find(t => t.type === 'page');
  } catch { /* not up yet */ }
}
if (!target) { chrome.kill(); throw new Error('chromium did not come up'); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise(res => {
  const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description || JSON.stringify(ex));
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
  console.log(`  ${name}.png`);
};
// The fleet language switcher writes a cookie on .carino.systems, which has
// nowhere to land on 127.0.0.1 — so drive its API directly instead of clicking.
const setLang = async () => {
  await evaluate(`window.CarinoLang && window.CarinoLang.set(${JSON.stringify(LANG)}); 1`);
  await sleep(900);
};
const signIn = async () => evaluate(`(async () => {
  const alt = document.getElementById('authUseToken');   // present once profiles exist
  if (alt && alt.offsetParent !== null) { alt.click(); await new Promise(r => setTimeout(r, 600)); }
  const t = document.getElementById('authToken');
  t.value = ${JSON.stringify(TOKEN)};
  t.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('authLogin').click();
  await new Promise(r => setTimeout(r, 3000));
  return document.getElementById('authGate').hidden;
})()`).then(hidden => { if (!hidden) throw new Error('sign-in did not dismiss the gate'); });

/* Put a figure on screen: click the nav ROW that owns it, then the TAB inside
 * that row's panel. The sidebar is six rows now, and most of what the manual
 * photographs no longer has a nav button of its own: History, Pending and Stuck
 * are tabs of Studies; Destinations, Routing, Settings and People are tabs of
 * Configuration; Logs and Audit are tabs of Activity. The old one-click form
 * looked for buttons that eight of these figures no longer have.
 *
 * Both the panel and the pane are checked, because a pane's `hidden` no longer
 * says anything about whether its panel is open: the tab strips are reconciled
 * even inside closed panels, so an un-hidden pane can easily be the selected
 * tab of a panel nobody opened. A pass on the pane alone would photograph
 * whatever panel happened to be on screen and name the file after this one.
 *
 * The pane id comes from the tab button's aria-controls rather than a table
 * kept here, so a tab that is renamed or moved to another panel is followed
 * automatically instead of silently capturing the wrong pane.
 */
const open = (panel, tab) => evaluate(`(async () => {
  const row = document.querySelector('.navbtn[data-panel="${panel}"]');
  if (!row) return 'no nav row';
  if (row.hidden) return 'nav row hidden for this profile';
  row.click();
  await new Promise(r => setTimeout(r, 1200));
  const p = document.getElementById('${panel}');
  if (!p || p.hidden) return 'panel stayed hidden';
${tab ? `  const t = p.querySelector('.panel-tabs .hist-tab[data-tab="${tab}"]');
  if (!t) return 'no tab button';
  if (t.hidden) return 'tab hidden for this profile';
  t.click();
  await new Promise(r => setTimeout(r, 1600));
  const pane = document.getElementById(t.getAttribute('aria-controls'));
  if (!pane || pane.hidden) return 'pane stayed hidden';
` : ''}  return 'ok';
})()`);

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride',
  { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
await send('Page.navigate', { url: BASE });
await sleep(2500);
await setLang();

if (MODE === 'setup') {
  await shot('gate');
  await signIn();
  await sleep(2500);
  await shot('first-run');

} else if (MODE === 'people') {
  await shot('gate-people');
  await signIn();
  await sleep(2000);
  // People is the fourth tab of Configuration. Thrown rather than named: this
  // mode captures one figure, so there is nothing left to salvage by going on,
  // and 'tab hidden for this profile' here means the token this run signed in
  // with does not hold auth.manage.
  const ok = await open('dlgConfig', 'people');
  if (ok !== 'ok') throw new Error(`people: ${ok}`);
  await sleep(1500);
  await shot('people');

} else {
  await signIn();
  await sleep(2500);

  // Nav row, tab within it, figure name. The names are what every manual
  // references, so they stay as they are however the dashboard is rearranged —
  // only the route to each one moves. Overview, Services and Orders have no tab
  // strip and take null.
  const FIGURES = [
    ['dlgOverview', null,           'overview'],
    ['dlgServices', null,           'services'],
    ['dlgStudies',  'history',      'history'],
    ['dlgOrders',   null,           'orders'],
    ['dlgStudies',  'pending',      'pending'],
    ['dlgStudies',  'stuck',        'stuck'],
    ['dlgConfig',   'destinations', 'destinations'],
    ['dlgConfig',   'routing',      'routing'],
    ['dlgConfig',   'settings',     'settings'],
    ['dlgActivity', 'logs',         'logs'],
    ['dlgActivity', 'audit',        'audit'],
  ];
  for (const [panel, tab, name] of FIGURES) {
    const ok = await open(panel, tab);
    // Named rather than thrown: one figure that would not open should not cost
    // the other ten, and a silent gap in the output is how a missing figure
    // gets shipped.
    if (ok !== 'ok') { console.log(`  ! ${name}: ${ok}`); continue; }
    await shot(name);
  }

  // The editor, with its own synthetic phantoms — the one set of images in this
  // manual that were never anybody's, because it builds them in the browser.
  await send('Page.navigate', { url: new URL('editor/', BASE).href });
  await sleep(3500);
  await setLang();
  await evaluate(`(async () => {
    document.querySelector('.ov-sample-btn[data-sample="*"]').click();
    await new Promise(r => setTimeout(r, 6000));
    return 1;
  })()`);
  await sleep(1500);
  await shot('editor');
  await evaluate(`(async () => {
    document.getElementById('editorTabBtn').click();
    await new Promise(r => setTimeout(r, 2500));
    return 1;
  })()`);
  await sleep(1200);
  await shot('editor-tags');
}

ws.close();
chrome.kill();
// Wait for the process to actually go before deleting its profile: kill() only
// sends the signal, and chromium still has files open in there for a moment
// after. Deleting underneath it throws ENOTEMPTY even with force:true, which
// exits non-zero AFTER every figure has been written — so a `for L in en es
// pt-BR ja ru` loop under `set -e` stops on a run that in fact succeeded.
await new Promise((r) => { chrome.on('exit', r); setTimeout(r, 3000); });
try {
  await rm(PROFILE, { recursive: true, force: true });
} catch {
  // A throwaway directory in the temp dir. Not worth failing a capture over.
}
process.exit(0);
