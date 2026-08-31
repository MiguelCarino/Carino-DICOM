// Person Name survives a round trip through the editor.
//
// This suite exists because of one bug, and the bug is worth stating because it
// is invisible from the code: the editor seeds `pendingEdits` with the WHOLE
// dataset at load, and `downloadRange()` re-writes every entry in it through
// `parseByVR()`. So anything `parseByVR()` gets wrong is written into every
// study the operator opens, whether or not they touched a single field. It once
// built PN as the naturalised `{Alphabetic, …}` object, which dcmjs's raw-dict
// writer stringifies — and every PatientName, ReferringPhysicianName and
// PerformingPhysicianName that passed through this editor became the literal
// "[object Object]". Silently. On save. With nothing edited.
//
// A unit test could not have caught it. Calling dcmjs directly round-trips
// clean; the corruption only appears once the page's own tag-table sync is in
// the loop. So this runs the real page in a real browser, from a real file load
// to a real download, and re-parses the bytes that came out.
//
// Requires Chromium and nothing else — no fixture file, no Python, no network.
// The study under test is inlined below. If Chromium is absent the suite says
// so and exits 0: a clinical box has no browser, and a loud skip there is
// honest, where a hard failure would only teach people to ignore this file.
//
//   node pacs/web/editor/tests/pn-roundtrip.e2e.mjs
//
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDITOR_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// A CT instance carrying five PN tags chosen to cover the shapes that break:
// five components, empty middle components with a trailing caret, a plain pair,
// a MULTI-VALUED name (two names in one element), and one with Ideographic and
// Phonetic component groups so the "=" separators are exercised too.
const FIXTURE_B64 =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABESUNNAgAAAFVMBADyAAAA' +
  'AgABAE9CAAACAAAAAAECAAIAVUkaADEuMi44NDAuMTAwMDguNS4xLjQuMS4xLjIAAgADAFVJQAAxLjIuODI2LjAuMS4zNjgw' +
  'MDQzLjguNDk4Ljg4OTU0OTg1ODIxNjcwMDgxNjM4MzU0MTk1Mjc0MTgxMzgzNDY2AgAQAFVJFAAxLjIuODQwLjEwMDA4LjEu' +
  'Mi4xAAIAEgBVSUAAMS4yLjgyNi4wLjEuMzY4MDA0My44LjQ5OC4yMzgxMjc2NjIwOTYwMDEwMjAxMDM5NDI3NTc4NjA2NDky' +
  'ODU2OAIAEwBTSA4AUFlESUNPTSAzLjAuMiAIAAUAQ1MKAElTT19JUiAxOTIIABYAVUkaADEuMi44NDAuMTAwMDguNS4xLjQu' +
  'MS4xLjIACAAYAFVJQAAxLjIuODI2LjAuMS4zNjgwMDQzLjguNDk4Ljg4OTU0OTg1ODIxNjcwMDgxNjM4MzU0MTk1Mjc0MTgx' +
  'MzgzNDY2CAAgAERBCAAyMDI0MDEwMggAMABUTQYAMTAxMTEyCABQAFNICABBQ0MwMDAxIAgAYABDUwIAQ1QIAIAATE8OAFBy' +
  'b29mIEhvc3BpdGFsCACQAFBOEABTbWl0aF5BbGljZV5eRHJeCAAwEExPDABQcm9vZiBzdHVkeSAIAFAQUE4KAEpvbmVzXkJv' +
  'YiAIAGAQUE4uAFlhbWFkYV5UYXJvdT3lsbHnlLBe5aSq6YOOPeOChOOBvuOBoF7jgZ/jgo3jgYYIAHAQUE4OAE9wXk9uZVxP' +
  'cF5Ud28gEAAQAFBOEgBEb2VeSm9obl5RXkRyXlBoRCAQACAATE8KAFBJRC0xMjM0NSAQADAAREEIADE5ODAwMTAxEABAAENT' +
  'AgBNICAADQBVSUAAMS4yLjgyNi4wLjEuMzY4MDA0My44LjQ5OC43NTI1MjgwNDI4OTkzNDg4MjQyNTE4MjA0MzA1MTk2Nzkx' +
  'NjgxOSAADgBVSUAAMS4yLjgyNi4wLjEuMzY4MDA0My44LjQ5OC44MTg2ODk5ODU5NTEwNTYyNTUzMDkzMDcxNDQ4MTczODc4' +
  'NDA3MSAAEABTSAQAU1QxICAAEQBJUwIAMSAgABMASVMCADEgKAACAFVTAgABACgABABDUwwATU9OT0NIUk9NRTIgKAAQAFVT' +
  'AgAIACgAEQBVUwIACAAoAAABVVMCABAAKAABAVVTAgAQACgAAgFVUwIADwAoAAMBVVMCAAAAKABQEERTAgA0MCgAURBEUwQA' +
  'NDAwICgAUhBEUwIAMCAoAFMQRFMCADEg4H8QAE9XAACAAAAAAAABAAIAAwAEAAUABgAHAAgACQAKAAsADAANAA4ADwAQABEA' +
  'EgATABQAFQAWABcAGAAZABoAGwAcAB0AHgAfACAAIQAiACMAJAAlACYAJwAoACkAKgArACwALQAuAC8AMAAxADIAMwA0ADUA' +
  'NgA3ADgAOQA6ADsAPAA9AD4APwA=';

// What the fixture holds, by dcmjs dict key (uppercase hex, no "x").
const PN = {
  '00100010': ['Doe^John^Q^Dr^PhD'],
  '00080090': ['Smith^Alice^^Dr^'],
  '00081050': ['Jones^Bob'],
  '00081070': ['Op^One', 'Op^Two'],
  '00081060': ['Yamada^Tarou=山田^太郎=やまだ^たろう'],
};

// ─────────────────────────────────────────────────── static host for the editor
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.woff2': 'font/woff2', '.webp': 'image/webp',
};

function serve() {
  const srv = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/' || p.endsWith('/')) p += 'index.html';
    // The editor is served under a path prefix by the engine; here it is the
    // root, but a "..' must still not escape the directory.
    const abs = join(EDITOR_DIR, normalize(p));
    if (!abs.startsWith(EDITOR_DIR)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(abs);
      res.writeHead(200, { 'content-type': MIME[extname(abs)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r([srv, srv.address().port])));
}

// ──────────────────────────────────────────────────────────── CDP, hand-rolled
// Node 22 ships a WebSocket client, so driving Chromium needs no dependency.
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function chromium(port, profile) {
  for (const bin of ['/usr/bin/chromium-browser', '/usr/bin/chromium',
                     '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    try {
      const proc = spawn(bin, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
        `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
        '--remote-allow-origins=*', 'about:blank',
      ], { stdio: 'ignore' });
      for (let i = 0; i < 60; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/json/version`);
          if (r.ok) return [proc, await r.json()];
        } catch { /* not up yet */ }
        if (proc.exitCode !== null) break;
        await sleep(250);
      }
      proc.kill();
    } catch { /* try the next binary */ }
  }
  return [null, null];
}

function attach(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    const slot = m.id != null && pending.get(m.id);
    if (!slot) return;
    pending.delete(m.id);
    m.error ? slot.rej(new Error(JSON.stringify(m.error))) : slot.res(m.result);
  });
  return (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

// ──────────────────────────────────────────────────── the script the page runs
// Everything below the `(async () => {` runs INSIDE the editor page, with the
// page's own globals (handleFiles, downloadRange, files, pendingEdits) in scope.
const pageScript = (b64, scenario) => `(async () => {
  const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
  const captured = [];
  const real = URL.createObjectURL;
  URL.createObjectURL = function (b) { captured.push(b); return real.call(URL, b); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rowFor = t => document.querySelector('input.val-input[data-tag="' + t + '"]')
                   || document.querySelector('input.val-input[data-tag="x' + t.toLowerCase() + '"]');
  const typeInto = (t, v) => {
    const inp = rowFor(t);
    if (!inp) throw new Error('no editable row for ' + t);
    inp.value = v;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const out = { scenario: ${JSON.stringify(scenario)} };
  await handleFiles([new File([bytes], 'proof.dcm', { type: 'application/dicom' })]);
  await sleep(400);
  out.loaded = files.length;
  out.seeded = pendingEdits.size;

  if (out.scenario === 'edit-nonpn')  typeInto('00081030', 'EDITED DESCRIPTION');
  if (out.scenario === 'edit-pn')     typeInto('00100010', 'Nieuw^Naam^X^Mr^MD');
  if (out.scenario === 'anonymize') {
    document.getElementById('anonymizeBtn').click();
    await sleep(100);
    document.getElementById('confirmOk').click();
    await sleep(400);
  }

  downloadRange(0, 1);
  await sleep(500);
  const blob = captured[captured.length - 1];
  if (!blob) throw new Error('the page never produced a download');
  const buf = await blob.arrayBuffer();
  const got = new Uint8Array(buf);
  out.identical = got.byteLength === bytes.byteLength && got.every((v, i) => v === bytes[i]);

  // Re-parse the bytes that actually left the page, not the in-memory dict.
  const msg = dcmjs.data.DicomMessage.readFile(buf);
  out.tags = {};
  for (const t of ['00100010','00080090','00081050','00081070','00081060','00081030','00100020']) {
    const el = msg.dict[t];
    out.tags[t] = el ? { vr: el.vr, Value: el.Value } : null;
  }
  return out;
})()`;

// ───────────────────────────────────────────────────────────────────── asserts
let failures = 0;
const ok = m => console.log('  ok    ' + m);
const fail = m => { failures++; console.log('  FAIL  ' + m); };
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  g === w ? ok(label) : fail(`${label} — got ${g}, want ${w}`);
};
// The corruption this suite exists for, named so a failure reads as itself.
const noObjectObject = (label, tags) => {
  const bad = Object.entries(tags)
    .filter(([, el]) => el && (el.Value || []).some(v => String(v).includes('[object Object]')))
    .map(([t]) => t);
  bad.length ? fail(`${label} — "[object Object]" written into ${bad.join(', ')}`)
             : ok(label);
};

// ──────────────────────────────────────────────────────────────────────── main
const profile = mkdtempSync(join(tmpdir(), 'pn-e2e-'));
const [server, port] = await serve();
const [proc, version] = await chromium(9401, profile);

if (!proc) {
  server.close();
  rmSync(profile, { recursive: true, force: true });
  console.log('SKIP — no Chromium on this machine, so the editor cannot be driven.');
  console.log('       Install chromium and re-run before touching parseByVR() or');
  console.log('       refreshing vendor/dcmjs.min.js. See vendor/README.md item 3.');
  process.exit(0);
}

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});
const send = attach(ws);

async function run(scenario) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` }, sessionId);
  await sleep(1500);                                  // load + deferred scripts
  const r = await send('Runtime.evaluate', {
    expression: pageScript(FIXTURE_B64, scenario), awaitPromise: true, returnByValue: true,
  }, sessionId);
  await send('Target.closeTarget', { targetId });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || 'page threw');
  }
  return r.result.value;
}

try {
  // ── 1. Open a study, save it, change nothing. ──────────────────────────────
  console.log('load and save with nothing edited');
  let r = await run('untouched');
  eq('the file loaded', r.loaded, 1);
  if (r.seeded < 10) fail(`pendingEdits was seeded with only ${r.seeded} tags — this suite ` +
                          'assumes the whole-dataset seeding that makes the bug reachable');
  else ok(`pendingEdits seeded with the whole dataset (${r.seeded} tags)`);
  noObjectObject('no PN tag was stringified', r.tags);
  for (const [t, want] of Object.entries(PN)) eq(`${t} survived`, r.tags[t]?.Value, want);
  r.identical ? ok('the saved bytes are identical to the loaded bytes')
              : fail('an untouched save changed the bytes');

  // ── 2. Edit something that is not a name. ──────────────────────────────────
  console.log('edit one non-PN tag and save');
  r = await run('edit-nonpn');
  noObjectObject('no PN tag was stringified', r.tags);
  eq('the edit landed', r.tags['00081030']?.Value, ['EDITED DESCRIPTION']);
  for (const [t, want] of Object.entries(PN)) eq(`${t} untouched`, r.tags[t]?.Value, want);

  // ── 3. Edit a name. ───────────────────────────────────────────────────────
  console.log('edit a PN tag and save');
  r = await run('edit-pn');
  noObjectObject('no PN tag was stringified', r.tags);
  eq('the new name is a plain string', r.tags['00100010']?.Value, ['Nieuw^Naam^X^Mr^MD']);
  eq('the VR is still PN', r.tags['00100010']?.vr, 'PN');
  for (const [t, want] of Object.entries(PN)) {
    if (t !== '00100010') eq(`${t} untouched`, r.tags[t]?.Value, want);
  }

  // ── 4. Anonymize All. ─────────────────────────────────────────────────────
  console.log('anonymize all and save');
  r = await run('anonymize');
  noObjectObject('no PN tag was stringified', r.tags);
  const pn = r.tags['00100010'];
  // What this suite is entitled to assert about the anonymized name is its
  // SHAPE, not its content: a plain string under VR PN, because that pair is
  // exactly what parseByVR() gets wrong and everything above is here to catch.
  // It used to demand a caret as well, from back when Anonymize invented a
  // person-shaped name. The placeholder is deliberately flat now — ANONYMOUS,
  // the same value in every file, chosen so a reader can tell it from Randomize
  // at a glance — and the caret check outlived the behaviour it described,
  // failing on a study the editor had handled correctly. Whether the
  // placeholder is the right string is settled next door in
  // tests/suites/deid.js and tests/suites/edits.js, against the constant
  // itself; asserting it here too would only mean two files to edit.
  if (!pn || pn.vr !== 'PN' || typeof pn.Value?.[0] !== 'string' || !pn.Value[0]) {
    fail(`the dummy patient name is not a plain PN string — got ${JSON.stringify(pn)}`);
  } else ok(`the dummy patient name is a plain PN string (${pn.Value[0]})`);
  eq('the real name is gone', pn?.Value?.[0] === PN['00100010'][0], false);
  eq('the patient ID is cleared', r.tags['00100020']?.Value, ['']);
} catch (e) {
  fail('harness: ' + (e.stack || e));
} finally {
  ws.close();
  proc.kill();
  server.close();
  // Chromium is still flushing its profile as we tear down, so the directory can
  // refill under rmSync. A temp directory we failed to sweep is not a test
  // result — never let it be the thing that reports a failure.
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { /* the OS will reap /tmp */ }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPN round-trips through the editor intact.');
process.exit(failures ? 1 : 0);
