/* Studies: transaction history, dev peer, pending imports and the stuck list. */
"use strict";

// ---- Shared helpers (Studies and Orders) ----

// Shared list placeholders (Loading… / load error), used by every panel.
function listLoading(el) { el.innerHTML = ""; el.appendChild(emptyNote(T("Loading…"))); }
function listError(el, msg) { el.innerHTML = ""; el.appendChild(emptyNote(TF("Could not load: {err}", { err: msg }))); }
function emptyNote(text) {
  const d = document.createElement("div");
  d.className = "hist-empty";
  d.textContent = text;
  return d;
}

/* POST helpers that keep what api() drops: the C9 `field` a refusal names and the 403
   `forbidden.capability`, so the form can outline the field and say which permission is missing. */
async function readReply(res) {
  let body = {};
  try { body = await res.json(); } catch (e) { /* empty */ }
  if (!res.ok) {
    const err = new Error(body.error || body.message || res.statusText);
    err.status = res.status;
    err.code = body.code || "";
    err.field = body.field || "";
    err.forbidden = body.forbidden || null;
    err.auth = (body.auth && body.auth.required) ? body.auth : null;
    if (err.auth) onAuthRejected(err.auth);
    throw err;
  }
  return body;
}
// X-Carino on every write, as post() does (web.py's cross-site guard).
const studyPost = (url, data) => fetch(url, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Carino": "1" }, body: JSON.stringify(data || {}),
}).then(readReply);
const studyForm = (url, fd) => fetch(url, { method: "POST", headers: { "X-Carino": "1" }, body: fd }).then(readReply);

// A refusal for a missing permission names it, in the operator's language; anything else is the engine's text.
function failText(e) {
  const cap = e && e.forbidden && e.forbidden.capability;
  if (cap) return TF("Your profile may not do this — it needs the “{cap}” permission. Ask an administrator.", { cap });
  if (e && e.status === 403 && /not permitted/i.test(e.message || "")) {
    return T("Your profile may not do this. Ask an administrator.");
  }
  return (e && e.message) || "";
}

// {name} placeholders on an already-translated string (TN output carries its own).
const fillIn = (s, vals) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vals && vals[k] != null ? vals[k] : m));

/* Buttons built from templates (or static markup outside the nav) follow their data-cap like the nav
   does. A hint only: the server enforces every one of these. Tabs are left to normalizeTabs(). */
function capGate(root) {
  if (!root) return;
  root.querySelectorAll("[data-cap]:not(.hist-tab), [data-cap-all]:not(.hist-tab)").forEach((b) => { b.hidden = !capAllowed(b); });
}

// "JANE DOE · ID 123 · ACC A1": the identity a confirm or an aria-label names.
function whoOf(x) {
  return [
    (x && (x.patient || x.patient_name)) || T("(no name)"),
    x && x.patient_id ? TF("ID {id}", { id: x.patient_id }) : "",
    x && x.accession ? TF("ACC {acc}", { acc: x.accession }) : "",
  ].filter(Boolean).join(" · ");
}
// Screen readers otherwise hear N identical "Send" buttons: the label carries the row's identity.
function ariaWho(btn, who) {
  if (btn) btn.setAttribute("aria-label", (btn.textContent || "").trim() + " — " + who);
}

/* Times. HL7 TS (YYYYMMDD[HHMM[SS]][+ZZZZ]) without a zone is the sender's local time; ISO with
   "Z" or an offset is absolute; a bare YYYY-MM-DD is a calendar day (new Date() would read it as UTC). */
function parseWhen(raw) {
  if (raw == null || raw === "") return null;
  if (raw instanceof Date) return { date: raw, dateOnly: false };
  if (typeof raw === "number") return { date: new Date(raw < 1e12 ? raw * 1000 : raw), dateOnly: false };
  const s = String(raw).trim();
  let m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})?(\d{2})?(?:\.\d+)?)?([+-]\d{4})?$/.exec(s);
  if (m) {
    const [, y, mo, d, h, mi, se, tz] = m;
    if (tz && h) {
      return { date: new Date(`${y}-${mo}-${d}T${h}:${mi || "00"}:${se || "00"}${tz.slice(0, 3)}:${tz.slice(3)}`), dateOnly: false };
    }
    return { date: new Date(+y, +mo - 1, +d, +(h || 0), +(mi || 0), +(se || 0)), dateOnly: !h };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return { date: new Date(+m[1], +m[2] - 1, +m[3]), dateOnly: true };
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return { date: new Date(s.replace(" ", "T")), dateOnly: false };
  return null;
}
function uiLocale() {
  const lang = document.documentElement.lang || undefined;
  try { new Intl.DateTimeFormat(lang); return lang; } catch (e) { return undefined; }
}
// "Today 09:30", "Yesterday 18:02", "12 Mar 09:30"; unparseable input is shown as it came.
function fmtWhen(raw) {
  const p = parseWhen(raw);
  if (!p || isNaN(p.date.getTime())) return raw == null ? "" : String(raw);
  const lang = uiLocale();
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(p.date) - day(new Date())) / 86400000);
  const sameYear = p.date.getFullYear() === new Date().getFullYear();
  const dayWord = diff === 0 ? T("Today") : diff === -1 ? T("Yesterday") : diff === 1 ? T("Tomorrow")
    : p.date.toLocaleDateString(lang, sameYear ? { day: "numeric", month: "short" }
                                               : { day: "numeric", month: "short", year: "numeric" });
  if (p.dateOnly) return dayWord;
  return dayWord + " " + p.date.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
}

// "Open folder" runs on the ENGINE's machine, so it is offered only where that is this machine.
function dashboardIsLocal() {
  if (window.carinoDesktop) return true;
  const h = String(location.hostname || "").replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\./.test(h) || /\.localhost$/.test(h);
}

// Clipboard needs a secure context; plain http on a LAN address falls back to a selectable prompt.
async function copyStudyText(text, promptLabel) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      flashNote(TF("Copied: {path}", { path: text }), true);
      return;
    }
  } catch (e) { /* fall through to the prompt */ }
  window.prompt(promptLabel, text);
}

/* Row "⋯" menus are <details>: Enter/Space open them from the keyboard for free. One open at a
   time; Escape or a click elsewhere closes it, and choosing an item closes it too. */
function closeRowMenus(except) {
  document.querySelectorAll("details.row-menu[open]").forEach((d) => { if (d !== except) d.open = false; });
}
document.addEventListener("click", (e) => {
  const inMenu = e.target.closest && e.target.closest("details.row-menu");
  closeRowMenus(inMenu);
  if (inMenu && e.target.closest(".row-menu-pop button")) inMenu.open = false;
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = e.target.closest && e.target.closest("details.row-menu[open]");
  if (!open) return;
  open.open = false;
  const s = open.querySelector("summary");
  if (s) s.focus();
});

// Counts on tab labels as a data attribute (drawn by CSS), so the language pass and the
// panel subtitle, which both read textContent, never see the number.
function setTabCount(id, n, showZero) {
  const t = $(id);
  if (!t) return;
  if (n == null || (!n && !showZero)) t.removeAttribute("data-n");
  else t.setAttribute("data-n", String(n));
}

// ---- Transaction history ----
let histGroup = "received";
let histStudies = [], histTotal = 0, histTruncated = false;
const histMods = new Set();           // modality chips switched on; empty = every modality
let histReq = 0;

async function loadHistory() {
  const list = $("histList");
  // Received/Sent is a two-button toggle: aria-pressed follows whichever group is loading.
  document.querySelectorAll("#dlgHistory .hist-tab[data-group]").forEach((t) =>
    t.setAttribute("aria-pressed", t.dataset.group === histGroup ? "true" : "false"));
  capGate($("dlgHistory"));
  // An empty maintenance menu is not offered.
  const delAll = $("histDeleteAll");
  if (delAll) delAll.closest("details").hidden = delAll.hidden;
  const req = ++histReq;
  listLoading(list);
  try {
    const data = await api("/api/studies?group=" + histGroup);
    if (req !== histReq) return;
    histStudies = data.studies || [];
    histTotal = Number(data.total != null ? data.total : histStudies.length);
    histTruncated = !!data.truncated;
    renderHistMods();
    renderHistory();
  } catch (e) {
    if (req === histReq) listError(list, failText(e));
  }
}

const studyMods = (s) => String(s.modality || "").split(",").map((m) => m.trim()).filter((m) => m && m !== "?");

function renderHistMods() {
  const box = $("histMods");
  if (!box) return;
  const all = [...new Set(histStudies.flatMap(studyMods))].sort();
  [...histMods].forEach((m) => { if (all.indexOf(m) < 0) histMods.delete(m); });
  box.innerHTML = "";
  box.hidden = all.length < 2;          // one modality filters nothing
  all.forEach((m) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mod-chip" + (histMods.has(m) ? " on" : "");
    b.textContent = m;
    b.setAttribute("aria-pressed", histMods.has(m) ? "true" : "false");
    b.addEventListener("click", () => {
      histMods.has(m) ? histMods.delete(m) : histMods.add(m);
      renderHistMods();
      renderHistory();
    });
    box.appendChild(b);
  });
}

function histMatches(s, q) {
  if (histMods.size && !studyMods(s).some((m) => histMods.has(m))) return false;
  if (!q) return true;
  return [s.patient, s.patient_name, s.patient_id, s.accession, s.study_desc]
    .some((v) => String(v || "").toLowerCase().indexOf(q) >= 0);
}

function renderHistory() {
  const list = $("histList");
  const q = (($("histFilter") || {}).value || "").trim().toLowerCase();
  const shown = histStudies.filter((s) => histMatches(s, q));
  const count = $("histCount");
  if (count) {
    const bits = [];
    if (histTruncated) bits.push(TF("Showing the newest {n} of {total} studies", { n: histStudies.length, total: histTotal }));
    if (q || histMods.size) bits.push(TF("{shown} of {n} match", { shown: shown.length, n: histStudies.length }));
    count.textContent = bits.join(" · ");
    count.hidden = !bits.length;
  }
  list.innerHTML = "";
  if (!histStudies.length) {
    list.appendChild(emptyNote(histGroup === "sent" ? T("No archived studies yet.") : T("No received studies yet.")));
    return;
  }
  if (!shown.length) { list.appendChild(emptyNote(T("Nothing matches the filter."))); return; }
  shown.forEach((s) => list.appendChild(histRow(s)));
}

function histRow(s) {
  const row = I18N_IN($("histRowTpl").content.cloneNode(true)).querySelector(".hist-row");
  const who = whoOf(s);
  row.querySelector(".hist-patient").textContent =
    (s.patient || T("(no name)")) + (s.patient_id ? "  ·  " + s.patient_id : "");
  row.querySelector(".hist-meta").textContent = [
    s.study_date || T("no date"),
    s.accession ? TF("ACC {acc}", { acc: s.accession }) : "",
    s.study_desc || T("(no study description)"),
    s.modality,
    TN(s.instances, "{n} images"),
  ].filter(Boolean).join("  ·  ");
  // When it landed here and who sent it: the first two questions about a study that "did not arrive".
  const src = s.source_ae || s.calling_aet || s.source || "";
  const when = s.received_at || s.mtime;
  row.querySelector(".hist-recv").textContent = [
    !when ? "" : histGroup === "sent" ? TF("archived {ts}", { ts: fmtWhen(when) }) : TF("received {ts}", { ts: fmtWhen(when) }),
    src ? TF("from {src}", { src }) : "",
  ].filter(Boolean).join("  ·  ");

  const ser = row.querySelector(".hist-series");
  (s.series || []).slice(0, 8).forEach((se) => {
    const chip = document.createElement("span");
    chip.className = "hist-chip";
    chip.textContent = (se.desc || se.modality || T("series")) + " (" + se.count + ")";
    ser.appendChild(chip);
  });
  if ((s.series || []).length > 8) {
    const more = document.createElement("span");
    more.className = "hist-chip more";
    more.textContent = TF("+{n} more", { n: s.series.length - 8 });
    ser.appendChild(more);
  }

  // Gated here: rows are built after applyCapabilities' sweep.
  capGate(row);
  const sendBtn = row.querySelector(".hist-send");
  sendBtn.textContent = histGroup === "sent" ? T("Resend") : T("Send");
  ariaWho(sendBtn, who);
  sendBtn.addEventListener("click", () => histSend(s, sendBtn));
  const menu = row.querySelector(".row-menu summary");
  menu.setAttribute("aria-label", TF("More actions for {who}", { who }));
  row.querySelector(".hist-attach").addEventListener("click", () => histAttach(s));
  const editBtn = row.querySelector(".hist-edit");
  if (editorUrl && capAllowed(editBtn)) {
    editBtn.hidden = false;
    editBtn.addEventListener("click", () => histEdit(s, row, editBtn));
  } else {
    editBtn.hidden = true;
  }
  const copyBtn = row.querySelector(".hist-copy");
  copyBtn.title = s.path || "";
  copyBtn.addEventListener("click", () => copyStudyText(s.path || "", T("Path of this study on the server:")));
  const openBtn = row.querySelector(".hist-open");
  openBtn.hidden = !dashboardIsLocal();
  openBtn.addEventListener("click", () => histReveal(s));
  row.querySelector(".hist-del").addEventListener("click", () => histDelete(s));
  return row;
}

/* Where a study would go, from the same dry run the Routing tab uses (read-only, logs nothing).
   null = cannot tell (no routing.read, or the engine refused); the caller then says so plainly. */
async function routeFor(body) {
  try {
    const r = await post("/api/routing/test", body);
    if (!r || r.ok === false) return null;
    let d = r.decision || {};
    if (typeof settledRoute === "function") d = settledRoute(d);
    return { sendable: d.sendable || d.destinations || [], held: d.held || [] };
  } catch (e) { return null; }
}
function routeText(route) {
  let s = route.sendable.join(", ");
  if (route.held.length) s += (s ? " " : "") + TF("(held, not sent: {names})", { names: route.held.join(", ") });
  return s;
}

async function histSend(s, btn) {
  const who = whoOf(s);
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "…";
  try {
    const route = await routeFor({ group: histGroup, path: s.path });
    const ask = !route ? TF("Send {who} to its routed destinations?", { who })
      : route.sendable.length ? TF("Send {who} to: {dests}?", { who, dests: routeText(route) })
      : TF("No enabled destination would receive {who} right now. Queue it anyway?", { who });
    if (!confirm(ask)) return;
    const r = await studyPost("/api/studies/send", { group: histGroup, path: s.path });
    flashNote(r.message || T("OK"), r.ok !== false);
  } catch (e) {
    flashNote(failText(e), false);
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

async function histReveal(s) {
  try {
    const r = await studyPost("/api/studies/reveal", { group: histGroup, path: s.path });
    flashNote(r.message || T("OK"), r.ok !== false);
  } catch (e) { flashNote(failText(e), false); }
}

async function histDelete(s) {
  if (!confirm(T("Delete this study from disk?") + "\n\n" + (s.patient || T("(no name)")) +
               "\n" + (s.study_desc || "") + "  —  " + TN(s.instances, "{n} images"))) return;
  try {
    const r = await studyPost("/api/studies/delete", { group: histGroup, path: s.path });
    flashNote(r.message || T("Deleted"), r.ok !== false);
    loadHistory();
  } catch (e) { flashNote(failText(e), false); }
}

// Typed confirmation: the operator types the number of studies that will go.
async function histDeleteAll() {
  const n = histTotal || histStudies.length;
  if (!n) { flashNote(histGroup === "sent" ? T("No archived studies yet.") : T("No received studies yet."), false); return; }
  const ask = histGroup === "sent"
    ? TF("Delete ALL {n} archived studies from disk? This cannot be undone.\n\nType {n} to confirm.", { n })
    : TF("Delete ALL {n} received studies from disk? This cannot be undone.\n\nType {n} to confirm.", { n });
  const typed = window.prompt(ask, "");
  if (typed == null) return;
  if (typed.trim() !== String(n)) { flashNote(T("Nothing deleted — the number did not match."), false); return; }
  try {
    const r = await studyPost("/api/studies/delete-all", { group: histGroup });
    flashNote(r.message || TF("Removed {n}", { n: r.removed || 0 }), r.ok !== false);
    loadHistory();
  } catch (e) { flashNote(failText(e), false); }
}

// Open a study in DICOM-editor via carino-bridge.js. An HTTPS editor cannot fetch our http API
// (mixed content), so we fetch same-origin and hand the bytes over by postMessage.
function histEdit(s, row, btn) {
  if (!editorUrl) return;
  // Relative ("/editor/" = bundled same-origin editor) or absolute.
  let editorAbs;
  try { editorAbs = new URL(editorUrl, location.origin).href; }
  catch (e) { flashNote(T("Editor URL is not valid"), false); return; }
  if (!window.CarinoBridge) { flashNote(T("Bridge script missing — reload the page"), false); return; }
  const manifestUrl = "/api/studies/files?group=" + encodeURIComponent(histGroup) + "&path=" + encodeURIComponent(s.path);
  const busy = row.querySelector(".hist-busy");
  const failed = [];
  btn.disabled = true;

  // Files are read only once the editor is listening, so a blocked or closed window costs nothing.
  CarinoBridge.send(editorAbs, async () => {
    const man = await api(manifestUrl);                   // same-origin fetch (http→http)
    const entries = man.files || [];
    if (!entries.length) throw new Error(man.message || T("no DICOM files in study"));
    const files = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      busy.textContent = TF("Copying {i}/{n}", { i: i + 1, n: entries.length });
      try {
        const r = await fetch(e.url);
        if (r.ok) files.push({ name: e.name, buf: await r.arrayBuffer() });
        else failed.push(e.name);
      } catch (err) { failed.push(e.name); }
    }
    if (!files.length) throw new Error(T("could not read any DICOM file"));
    return files;
  }, { legacy: true })                                    // editors older than the bridge
    .then((res) => {
      if (!failed.length) { flashNote(TN(res.count, "Opened {n} files in the editor"), true); return; }
      // A partial study in the editor looks complete, so the gap is said and stays on screen.
      flashNote(TN(res.count, "Opened {n} files in the editor") + " — " +
                TN(failed.length, "{n} files could not be read") + ": " +
                failed.slice(0, 5).join(", ") + (failed.length > 5 ? " …" : ""), false, { warn: true });
    })
    .catch((err) => flashNote(
      /pop-up/i.test(err.message) ? T("Pop-up blocked — allow pop-ups to open the editor")
                                  : TF("Editor hand-off failed: {err}", { err: err.message }), false))
    .finally(() => { busy.textContent = ""; btn.disabled = false; });
}

// A one-shot file picker; `then` receives the chosen File.
function pickDocument(then) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".pdf,.jpg,.jpeg,.png,application/pdf,image/*";
  input.addEventListener("change", () => { const f = input.files && input.files[0]; if (f) then(f); });
  input.click();
}

// Add a PDF/image to an existing study (inherits its identity, new series). Confirmed first:
// the file is converted and stored the moment it is posted.
function histAttach(s) {
  pickDocument(async (f) => {
    if (!confirm(TF("Add “{file}” to {who} as a new series?", { file: f.name, who: whoOf(s) }))) return;
    const fd = new FormData();
    fd.append("group", histGroup);
    fd.append("path", s.path);
    fd.append("file", f);
    try {
      const body = await studyForm("/api/studies/attach", fd);
      flashNote(body.message || T("Attached"), body.ok !== false);
      loadHistory();
    } catch (e) { flashNote(failText(e) || T("Attach failed"), false); }
  });
}

// ---- Dev peer (disposable second archive) ----
// Only with --dev-peer: otherwise the engine omits the dev_peer block and the nav row stays hidden.
async function loadDevPeer() {
  try { renderDevPeer((await api("/api/dev-peer")).dev_peer || null); }
  catch (e) { $("dpState").textContent = failText(e); }
}

function renderDevPeer(p) {
  const running = !!(p && p.running);
  setAtomic("dpAet", running ? p.aet : "");
  setAtomic("dpScpPort", running ? p.scp_port : "");
  setAtomic("dpQrPort", running ? p.qr_port : "");
  // Counts only: this block carries no patient data and must not grow a place for any.
  setAtomic("dpReceived", running ? p.received : "");
  setPath("dpDir", running ? p.storage_dir : "");
  // The destinations it added, so nobody has to hunt for them in a long list.
  setAtomic("dpDests", running ? (p.destinations || []).join(", ") : "");
  const open = $("dpOpenDests");
  if (open) open.hidden = !running || !(p.destinations || []).length || !can("routing.read");
  $("dpState").textContent = running ? "" : T("No peer is running.");
  $("dpCreate").disabled = running;
  $("dpDiscard").hidden = !running;
}

async function devPeerAction(action, btn) {
  if (action === "discard" &&
      !confirm(T("Stop the dev peer and delete its archive? Everything it received is deleted with it."))) return;
  const old = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    const r = await studyPost("/api/dev-peer", { action: action });
    flashNote(r.message || (action === "create" ? T("Peer created.") : T("Peer discarded.")), r.ok !== false);
    renderDevPeer(r.dev_peer || null);
    pollStatus();
    // Create/discard add and remove destinations: reload so Destinations is not stale (and a later
    // Save does not post the old list back). Profiles without config.read simply skip this.
    if (can("config.read")) loadConfig().catch(() => {});
  } catch (e) {
    flashNote(failText(e), false);
  } finally {
    // Restore on success too, not only on error.
    if (btn) { btn.textContent = old; btn.disabled = false; }
  }
}

// ---- Pending imports (non-DICOM review queue) and stuck list ----
function fmtDate(raw) {
  const s = String(raw || "");
  return (s.length === 8 && /^\d+$/.test(s)) ? s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8) : s;
}

function fmtWait(secs) {
  const n = Math.max(0, Number(secs) || 0);
  if (n <= 0) return T("due now");
  if (n < 60) return TF("retry in {n}s", { n: Math.round(n) });
  if (n < 3600) return TF("retry in {n}m", { n: Math.round(n / 60) });
  return TF("retry in {n}h", { n: Math.round(n / 3600) });
}
// "retry in" counts down locally between loads; the deadline is stamped on each row.
setInterval(() => {
  document.querySelectorAll("#stuckList .stuck-next[data-due]").forEach((el) => {
    el.textContent = fmtWait((Number(el.dataset.due) - Date.now()) / 1000);
  });
}, 5000);

let stuckReq = 0;
async function loadStuck(opts) {
  const list = $("stuckList");
  const quiet = opts && opts.quiet;
  capGate($("dlgStuck"));
  const req = ++stuckReq;
  // A background refresh does not blank a populated list (no flicker).
  if (!quiet || !list.querySelector(".stuck-row")) listLoading(list);
  try {
    const data = await api("/api/stuck");
    if (req === stuckReq) renderStuck(data);
  } catch (e) {
    if (req === stuckReq) listError(list, failText(e));
  }
}

/* GET /api/stuck returns three lists, rendered as separate sections:
     destinations  node configured but refusing/timing out; retries itself (Retry now skips the wait)
     orphaned      routed to a name no longer enabled; nothing retries; engine `message` shown verbatim
     held          rule asks to de-identify and nothing can be scrubbed; no timer releases it
   Only destinations get Retry; orphaned and held get Send to… / Remove from queue.
   Any new list in the response must be rendered here too (stuck-panel.e2e.mjs checks).
   The summary uses attention_files, which counts each file once. */
function renderStuck(data) {
  const d = data || {};
  const dests = d.destinations || [];
  const orphans = d.orphaned || [];
  const holds = d.held || [];
  const list = $("stuckList");
  list.innerHTML = "";
  // Retry all only clears backoff timers, so it is disabled when no destination is backing off.
  const all = $("stuckRetryAll");
  if (all) all.disabled = !dests.length;
  if (!dests.length && !orphans.length && !holds.length) {
    list.appendChild(emptyNote(T("Nothing stuck — every forward is up to date.")));
    return;
  }
  const attention = Number(d.attention_files || 0);
  if (attention) {
    list.appendChild(stuckSummary(
      attention,
      Number(d.files || 0) + Number(d.orphaned_files || 0) + Number(d.held_files || 0) > attention));
  }
  if (dests.length) {
    list.appendChild(stuckGroup(
      T("Retrying automatically"), Number(d.files || 0),
      T("Clears itself when the node answers — Retry now only skips the wait.")));
    dests.forEach((x) => list.appendChild(stuckRow(x)));
  }
  if (orphans.length) {
    list.appendChild(stuckGroup(
      T("No destination left to retry"), Number(d.orphaned_files || 0),
      T("Routed to a name that is no longer an enabled destination — nothing retries these."),
      "orphan"));
    orphans.forEach((x) => list.appendChild(orphanRow(x)));
  }
  if (holds.length) {
    list.appendChild(stuckGroup(
      T("Held — nothing is being sent"), Number(d.held_files || 0),
      T("A rule asks for a de-identified copy that cannot be made — one edit releases them."),
      "held"));
    holds.forEach((x) => list.appendChild(heldRow(x)));
  }
}

// The ⚠ badge's number; the note appears only when sections overlap (the caller must sum every
// section's files, held_files included, to detect that).
function stuckSummary(n, overlaps) {
  const box = document.createElement("div");
  box.className = "stuck-summary";
  const head = document.createElement("div");
  head.className = "stuck-summary-n";
  head.textContent = TN(n, "{n} files need attention");
  box.appendChild(head);
  if (overlaps) {
    const sub = document.createElement("div");
    sub.className = "stuck-summary-sub";
    sub.textContent = T("Some files are in more than one list; each file is counted once.");
    box.appendChild(sub);
  }
  return box;
}

function stuckGroup(title, count, sub, cls) {
  const box = document.createElement("div");
  box.className = "stuck-group" + (cls ? " " + cls : "");
  const head = document.createElement("div");
  head.className = "stuck-group-head";
  const t = document.createElement("span");
  t.className = "stuck-group-t";
  t.textContent = title;
  const n = document.createElement("span");
  n.className = "stuck-group-n";
  n.textContent = TN(count, "{n} files");
  head.append(t, n);
  const p = document.createElement("div");
  p.className = "stuck-group-sub";
  p.textContent = sub;
  box.append(head, p);
  return box;
}

function stuckRow(d) {
  const row = I18N_IN($("stuckRowTpl").content.cloneNode(true)).querySelector(".stuck-row");
  row.querySelector(".stuck-dest").textContent = d.name || T("(destination)");
  row.querySelector(".stuck-meta").textContent =
    TN(d.instances, "{n} instances waiting") + "  ·  " + TN(d.attempts, "{n} attempts");
  const err = row.querySelector(".stuck-err");
  err.textContent = d.last_error ? TF("last error: {err}", { err: d.last_error }) : "";
  // The line clips; the whole error is in the tooltip and one click unclips it.
  err.title = d.last_error || "";
  err.addEventListener("click", () => err.classList.toggle("open"));
  fileChips(row.querySelector(".stuck-files"), d);
  const next = row.querySelector(".stuck-next");
  next.textContent = fmtWait(d.next_in);
  next.dataset.due = String(Date.now() + Math.max(0, Number(d.next_in) || 0) * 1000);
  capGate(row);
  const btn = row.querySelector(".stuck-retry");
  ariaWho(btn, d.name || "");
  btn.addEventListener("click", () => retryStuck(d.name, btn));
  return row;
}

function orphanRow(o) {
  const row = I18N_IN($("orphanRowTpl").content.cloneNode(true)).querySelector(".stuck-row");
  row.querySelector(".orphan-name").textContent = o.name || T("(destination)");
  // Pinned = held for this node while it was offline; flag it explicitly.
  const pin = row.querySelector(".orphan-pin");
  pin.hidden = !o.pinned;
  if (o.pinned) pin.title = T("At least one of these was held for this node while it was offline.");
  row.querySelector(".stuck-meta").textContent = TN(o.instances, "{n} instances waiting");
  const names = fileChips(row.querySelector(".orphan-files"), o);
  // The engine's sentence verbatim: only it knows what happens to pinned copies.
  row.querySelector(".orphan-msg").textContent = o.message || "";
  wireStuckFix(row, o, names);
  return row;
}

/* The engine's held sentences (reason, remedy) by cause, so the row can be read in the operator's
   language. tests/test_dashboard_globals.py keeps them equal to server.py's _HELD_REASON/_HELD_REMEDY. */
const HELD_TEXT = {
  "profile-off": [
    "Nothing is being sent to {name}: a routing rule asks for de-identification and deid.profile is 'off', so no copy can be scrubbed. The instances wait in the outgoing folder — never archived, never deleted — and nothing retries them; no timer releases a hold.",
    "Turn the de-identification profile on, or take 'deidentify' off the rule that routes to {name}. Either edit releases them on the next Auto-send pass, and the studies are all still there."],
  "no-deidentifier": [
    "Nothing is being sent to {name}: a routing rule asks for de-identification, the profile is ON, and no de-identifier could be built from the current settings — so no copy can be scrubbed. The instances wait in the outgoing folder — never archived, never deleted — and nothing retries them; no timer releases a hold.",
    "Do NOT turn the profile off — that does not release anything, it only changes which half is stopping the scrub. Fix the de-identification settings until one can be built (the failure is in the log, on the send channel) and the next Auto-send pass releases them, studies and all. Taking 'deidentify' off the rule that routes to {name} also releases them — as IDENTIFIED copies, which is the one outcome this hold exists to prevent."],
  "": [
    "Nothing is being sent to {name}: a routing rule asks for de-identification and no copy can be scrubbed. These instances do not all carry the same recorded cause, so this row does not claim one. The instances wait in the outgoing folder — never archived, never deleted — and nothing retries them; no timer releases a hold.",
    "Look at the de-identification profile. If it is 'off', turning it on releases them; if it is on, nothing could be built to scrub with and the send channel carries that failure. Either way the next Auto-send pass re-records these rows with the cause. Taking 'deidentify' off the rule that routes to {name} releases them too — as IDENTIFIED copies."],
};

function heldRow(h) {
  const row = I18N_IN($("heldRowTpl").content.cloneNode(true)).querySelector(".stuck-row");
  row.querySelector(".held-name").textContent = h.name || T("(destination)");
  // Cause tag beside the name (the two causes need opposite remedies); none when cause is "" (mixed).
  const tag = { "profile-off": T("profile off"), "no-deidentifier": T("no de-identifier") }[h.cause];
  if (tag) {
    const chip = document.createElement("span");
    chip.className = "held-cause";
    chip.textContent = tag;
    row.querySelector(".stuck-dest").appendChild(chip);
  }
  row.querySelector(".stuck-meta").textContent = TN(h.instances, "{n} instances waiting");
  const names = fileChips(row.querySelector(".held-files"), h);
  const text = HELD_TEXT[h.cause in HELD_TEXT ? h.cause : ""];
  const vals = { name: h.name || T("(destination)") };
  row.querySelector(".held-msg").textContent = TF(text[0], vals) + " " + TF(text[1], vals);
  wireStuckFix(row, h, names);
  return row;
}

/* File names (a sample bounded by the engine; the rest counted in `more`), grouped by study using
   the per-file `items` [{file, rel, patient, patient_id, accession, study_desc, study_uid}]; older
   engines send bare names in `files`. Returns the listed files' `rel` paths, which is what
   /api/stuck/send and /api/stuck/discard take (empty without items: no exits offered). */
function fileChips(box, r) {
  const rels = [];
  if (!box) return rels;
  const groups = new Map();
  const entries = Array.isArray(r.items) && r.items.length ? r.items : (r.files || []).map((f) => ({ file: f }));
  entries.forEach((o) => {
    o = o || {};
    const name = o.file || "";
    if (!name) return;
    if (o.rel) rels.push(o.rel);
    const id = [o.study_uid || "", o.patient || "", o.patient_id || "", o.accession || "", o.study_desc || ""];
    const key = id.join("\u0001");
    if (!groups.has(key)) groups.set(key, { o, files: [] });
    groups.get(key).files.push(name);
  });
  groups.forEach((g, key) => {
    const known = key.replace(/\u0001/g, "") !== "";
    let chips = box;
    if (known) {
      const study = document.createElement("div");
      study.className = "stuck-study";
      const head = document.createElement("div");
      head.className = "stuck-study-who";
      head.textContent = [whoOf(g.o), g.o.study_desc || ""].filter(Boolean).join(" · ");
      chips = document.createElement("div");
      chips.className = "stuck-study-files";
      study.append(head, chips);
      box.appendChild(study);
    }
    g.files.forEach((f) => {
      const chip = document.createElement("span");
      chip.className = "hist-chip";
      chip.textContent = f;
      chip.title = f;                     // ATOMIC: the chip ellipsises, the name stays reachable
      chips.appendChild(chip);
    });
  });
  if (Number(r.more) > 0) {
    const chip = document.createElement("span");
    chip.className = "hist-chip more";
    chip.textContent = TF("+{n} more", { n: r.more });
    box.appendChild(chip);
  }
  return rels;
}

// Names a stuck file may be sent to: enabled destinations from the status poll, minus the stuck one.
function sendableDestNames(except) {
  const list = ((lastStatus && lastStatus.destinations) || []).filter((d) => d && d.enabled !== false);
  return list.map((d) => d.name).filter((n) => n && n !== except);
}

/* The dead ends get an exit: send the listed files somewhere that exists, or drop them from the
   outgoing queue. Both act on the files named on the row only (the engine lists a sample). */
function wireStuckFix(row, r, names) {
  capGate(row);
  const sendTo = row.querySelector(".stuck-sendto");
  const pick = row.querySelector(".stuck-pick");
  const sel = row.querySelector(".stuck-dest-sel");
  const go = row.querySelector(".stuck-sendgo");
  const drop = row.querySelector(".stuck-discard");
  const label = r.name || "";
  ariaWho(sendTo, label); ariaWho(drop, label);
  if (!names.length) { sendTo.hidden = true; drop.hidden = true; return; }
  const onlyListed = Number(r.more) > 0 ? "\n\n" + T("Only the files listed on this row are affected.") : "";
  sendTo.addEventListener("click", () => {
    const dests = sendableDestNames(r.name);
    if (!dests.length) { flashNote(T("No other enabled destination to send to."), false); return; }
    sel.innerHTML = "";
    dests.forEach((n) => { const o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o); });
    pick.hidden = false;
    sendTo.hidden = true;
    sel.focus();
  });
  go.addEventListener("click", async () => {
    const dest = sel.value;
    if (!dest) return;
    if (!confirm(fillIn(TN(names.length, "Send {n} files to {dest}?"), { dest }) + onlyListed)) return;
    go.disabled = true;
    try {
      const res = await studyPost("/api/stuck/send", { files: names, destination: dest });
      flashNote(res.message || T("OK"), res.ok !== false);
      loadStuck();
      pollStatus();
    } catch (e) { flashNote(failText(e), false); }
    finally { go.disabled = false; }
  });
  drop.addEventListener("click", async () => {
    if (!confirm(TN(names.length, "Remove {n} files from the outgoing queue? They are deleted and never sent.") + onlyListed)) return;
    drop.disabled = true;
    try {
      const res = await studyPost("/api/stuck/discard", { files: names });
      flashNote(res.message || T("OK"), res.ok !== false);
      loadStuck();
      pollStatus();
    } catch (e) { flashNote(failText(e), false); }
    finally { drop.disabled = false; }
  });
}

async function retryStuck(dest, btn) {
  const old = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    const r = await studyPost("/api/stuck/retry", dest ? { dest } : {});
    flashNote(r.message || T("Retrying…"), r.ok !== false);
    loadStuck();
    pollStatus();
  } catch (e) {
    flashNote(failText(e), false);
  } finally {
    // Restore on success too: Retry all is static markup the redraw never replaces.
    // renderStuck() has the last word on `disabled`.
    if (btn) { btn.textContent = old; btn.disabled = false; }
  }
}

/* Status-poll hook (called from renderStatus): tab counts, and a refresh of the Pending or Stuck
   pane when its count moved while it is on screen. `pending`/`stuck` are absent without studies.read. */
let lastPendN = null, lastStuckN = null;
function syncStudyCounts(s) {
  if (!s) return;
  const p = s.pending == null ? null : Number(s.pending);
  const k = s.stuck == null ? null : Number(s.stuck);
  setTabCount("tab_pending", p);
  setTabCount("tab_stuck", k);
  const onScreen = (tab) => !gateOpen && activePanel === "dlgStudies" && activeTab.dlgStudies === tab;
  if (p !== null && lastPendN !== null && p !== lastPendN && onScreen("pending")) loadPending({ merge: true });
  // Not under an operator's hands: a redraw would close an open destination picker.
  if (k !== null && lastStuckN !== null && k !== lastStuckN && onScreen("stuck") &&
      !$("stuckList").contains(document.activeElement)) loadStuck({ quiet: true });
  lastPendN = p; lastStuckN = k;
}

// ---- Pending review ----
/* One row per queued file. Its state lives on the row (row._st) so a refresh can keep what the
   operator typed: { it, order (attached open order or null), saved (field values before it) }. */
const PEND_FIELDS = [
  [".pf-patient", "patient"], [".pf-pid", "patient_id"], [".pf-acc", "accession"],
  [".pf-date", "study_date"], [".pf-sdesc", "study_desc"], [".pf-serdesc", "series_desc"],
];
// The engine's redaction may name the stored key or its patient_name alias.
const PEND_ALIASES = { patient_name: "patient" };
const REDACTED_VALUE = "***";          // users.REDACTED
let openOrdersCache = null;            // { at, orders } — the picker's list, kept for a short while

/* A listing that left before an approve can land after it: ids approved or discarded here stay out
   of the list until the engine stops listing them, and only the newest request may draw. */
const pendGone = new Set();
let pendLoadSeq = 0;

async function loadPending(opts) {
  const list = $("pendingList");
  const merge = opts && opts.merge;
  capGate($("dlgPending"));
  // A full reload rebuilds every row (language, Refresh); what was typed is carried across.
  const drafts = new Map();
  if (!merge) list.querySelectorAll(".pend-row").forEach((r) => drafts.set(r.dataset.id, pendSnapshot(r)));
  if (!merge || !list.querySelector(".pend-row")) listLoading(list);
  try {
    const seq = ++pendLoadSeq;
    const data = await api("/api/pending");
    if (seq !== pendLoadSeq) return;
    const items = data.items || [];
    const listed = new Set(items.map((it) => it.id));
    [...pendGone].forEach((id) => { if (!listed.has(id)) pendGone.delete(id); });
    renderPending(items.filter((it) => !pendGone.has(it.id)), merge ? null : drafts);
  } catch (e) {
    listError(list, failText(e));
  }
}

/* drafts = null merges: rows that still exist are left untouched (focus and typing survive), new
   ones are inserted in order, vanished ones removed. Otherwise every row is rebuilt from drafts. */
function renderPending(items, drafts) {
  const list = $("pendingList");
  const keep = new Map();
  if (!drafts) list.querySelectorAll(".pend-row").forEach((r) => keep.set(r.dataset.id, r));
  [...list.children].forEach((c) => { if (!c.classList.contains("pend-row") || drafts) c.remove(); });
  if (!items.length) {
    list.innerHTML = "";
    list.appendChild(emptyNote(T("Nothing waiting for review.")));
    return;
  }
  const want = new Set(items.map((it) => it.id));
  keep.forEach((r, id) => { if (!want.has(id)) r.remove(); });
  let ref = list.firstElementChild;
  items.forEach((it) => {
    let row = keep.get(it.id);
    if (!row) {
      row = pendingRow(it);
      if (drafts && drafts.has(it.id)) pendRestore(row, drafts.get(it.id));
    }
    if (row === ref) ref = ref.nextElementSibling;
    else list.insertBefore(row, ref);
  });
}

function pendingRow(it) {
  const row = I18N_IN($("pendingRowTpl").content.cloneNode(true)).querySelector(".pend-row");
  const st = { it, order: null, saved: null };
  row._st = st;
  row.dataset.id = it.id;
  const kind = row.querySelector(".pend-kind");
  kind.textContent = it.kind === "pdf" ? "PDF" : T("Image");
  kind.classList.add(it.kind === "pdf" ? "k-pdf" : "k-img");
  row.querySelector(".pend-file").textContent = it.filename || T("(file)");
  row.querySelector(".pend-preview").href = "/api/pending/preview?id=" + encodeURIComponent(it.id);
  row.querySelector(".pend-src").textContent = it.source ? TF("from {src}", { src: it.source }) : "";

  /* Fields the profile may not see arrive as "***". Posting that back wrote "***" into the DICOM,
     so they are locked, shown as hidden, and never sent (the server also drops them). */
  const redacted = new Set((it.redacted || []).map((f) => PEND_ALIASES[f] || f));
  PEND_FIELDS.forEach(([cls, key]) => {
    const inp = row.querySelector(cls);
    const raw = key === "study_date" ? fmtDate(it.study_date) : (it[key] || "");
    if (redacted.has(key) || raw === REDACTED_VALUE) {
      inp.value = "";
      inp.readOnly = true;
      inp.dataset.locked = "1";
      inp.placeholder = T("hidden for your profile");
      inp.classList.add("locked");
      const lock = document.createElement("span");
      lock.className = "pf-lock";
      lock.textContent = "🔒";
      lock.title = T("Hidden for your profile — kept exactly as it is");
      inp.parentElement.querySelector("span").appendChild(lock);
    } else {
      inp.value = raw;
    }
    inp.addEventListener("input", () => { inp.classList.remove("pf-bad"); pendValidate(row); });
  });

  // New study vs the study the file was found beside: asked only once the identity is changed.
  row.querySelectorAll(".pend-choice input[type=radio]").forEach((r) => { r.name = "keep_" + it.id; });

  capGate(row);
  const who = it.filename || "";
  const appBtn = row.querySelector(".pend-approve");
  ariaWho(appBtn, who);
  appBtn.addEventListener("click", () => approvePending(row, appBtn));
  const disc = row.querySelector(".pend-discard");
  ariaWho(disc, who);
  disc.addEventListener("click", () => discardPending(row));

  // Match to an open order: needs orders.read to list them.
  const match = row.querySelector(".pend-match");
  const pick = row.querySelector(".pend-order-pick");
  match.addEventListener("click", () => openOrderPicker(row));
  pick.addEventListener("change", () => {
    const o = (pick._orders || []).find((x) => x.id === pick.value);
    if (o) attachOrder(row, o);
  });
  row.querySelector(".pend-order-clear").addEventListener("click", () => detachOrder(row));
  pendValidate(row);
  return row;
}

async function openOrderPicker(row) {
  const pick = row.querySelector(".pend-order-pick");
  const match = row.querySelector(".pend-match");
  match.disabled = true;
  try {
    if (!openOrdersCache || Date.now() - openOrdersCache.at > 30000) {
      const data = await api("/api/ris/orders?status=open");
      openOrdersCache = { at: Date.now(), orders: data.orders || [] };
    }
  } catch (e) {
    flashNote(failText(e), false);
    return;
  } finally { match.disabled = false; }
  const orders = openOrdersCache.orders;
  pick._orders = orders;
  pick.innerHTML = "";
  const first = document.createElement("option");
  first.value = "";
  first.textContent = orders.length ? T("Choose an open order…") : T("No open orders");
  pick.appendChild(first);
  orders.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o.id;
    opt.textContent = [whoOf(o), o.study_desc || "", o.scheduled_dt ? fmtWhen(o.scheduled_dt) : ""]
      .filter(Boolean).join(" · ");
    pick.appendChild(opt);
  });
  pick.disabled = !orders.length;
  pick.hidden = false;
  match.hidden = true;
  pick.focus();
}

// The order's identity fills the form and is what the engine uses (with its Study UID); the
// identity fields go read-only so nobody edits a value that will not be sent.
function attachOrder(row, o) {
  const st = row._st;
  if (!st.order) st.saved = pendValues(row);
  st.order = o;
  const day = parseWhen(o.scheduled_dt);
  const fill = {
    patient: o.patient || o.patient_name || "",
    patient_id: o.patient_id || "",
    accession: o.accession || "",
    study_date: day && !isNaN(day.date.getTime()) ? isoDay(day.date) : "",
    study_desc: o.study_desc || "",
  };
  PEND_FIELDS.forEach(([cls, key]) => {
    if (!(key in fill)) return;
    const inp = row.querySelector(cls);
    if (inp.dataset.locked) return;
    inp.value = fill[key] === REDACTED_VALUE ? "" : fill[key];
    inp.readOnly = true;
    inp.classList.add("from-order");
    inp.classList.remove("pf-bad");
  });
  row.querySelector(".pend-order-pick").hidden = true;
  row.querySelector(".pend-match").hidden = true;
  row.querySelector(".pend-order-on").hidden = false;
  row.querySelector(".pend-order-txt").textContent = TF("Matched to order {who}", { who: whoOf(o) });
  pendValidate(row);
}

function detachOrder(row) {
  const st = row._st;
  st.order = null;
  PEND_FIELDS.forEach(([cls, key]) => {
    const inp = row.querySelector(cls);
    if (inp.dataset.locked) return;
    if (st.saved && key in st.saved) inp.value = st.saved[key];
    inp.readOnly = false;
    inp.classList.remove("from-order");
  });
  st.saved = null;
  row.querySelector(".pend-order-on").hidden = true;
  row.querySelector(".pend-match").hidden = !capAllowed(row.querySelector(".pend-match"));
  const pick = row.querySelector(".pend-order-pick");
  pick.hidden = true; pick.value = "";
  pendValidate(row);
}

const isoDay = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

function pendValues(row) {
  const out = {};
  PEND_FIELDS.forEach(([cls, key]) => { out[key] = row.querySelector(cls).value; });
  return out;
}
function pendSnapshot(row) {
  const st = row._st || {};
  const keep = row.querySelector(".pend-choice input[value=keep]");
  return { values: pendValues(row), order: st.order, saved: st.saved, keep: !!(keep && keep.checked) };
}
function pendRestore(row, snap) {
  if (!snap) return;
  if (snap.order) {
    attachOrder(row, snap.order);
    row._st.saved = snap.saved;
    const ser = row.querySelector(".pf-serdesc");
    if (!ser.dataset.locked) ser.value = snap.values.series_desc || "";
  } else {
    PEND_FIELDS.forEach(([cls, key]) => {
      const inp = row.querySelector(cls);
      if (!inp.dataset.locked && key in snap.values) inp.value = snap.values[key];
    });
  }
  const keep = row.querySelector(".pend-choice input[value=keep]");
  if (keep && snap.keep) keep.checked = true;
  pendValidate(row);
}

/* Approve needs a patient name and ID (or an order, which brings both). A locked field counts as
   present: the engine keeps its stored value. Also decides whether the new-study question shows. */
function pendValidate(row) {
  const st = row._st;
  const has = (cls) => { const i = row.querySelector(cls); return !!(i.dataset.locked || i.value.trim()); };
  const ok = !!st.order || (has(".pf-patient") && has(".pf-pid"));
  const btn = row.querySelector(".pend-approve");
  // Typing while an approve is in flight must not re-arm the button: a second press would convert
  // the same file again under whatever identity was typed meanwhile.
  if (st.busy) { btn.disabled = true; return; }
  btn.disabled = !ok;
  btn.title = ok ? T("Convert to DICOM and send") : T("Patient name and ID are needed — or match an order");
  const changed = (cls, key) => {
    const i = row.querySelector(cls);
    return !i.dataset.locked && i.value.trim() !== String(st.it[key] || "").trim();
  };
  const choice = row.querySelector(".pend-choice");
  choice.hidden = !(st.it.study_uid && !st.order && (changed(".pf-patient", "patient") || changed(".pf-pid", "patient_id")));
}

async function approvePending(row, btn) {
  const st = row._st;
  const it = st.it;
  const edits = { id: it.id };
  PEND_FIELDS.forEach(([cls, key]) => {
    const inp = row.querySelector(cls);
    const v = inp.value.trim();
    if (inp.dataset.locked || v === REDACTED_VALUE) return;      // never post a redacted placeholder
    edits[key] = v;
  });
  if (st.order) edits.order_id = st.order.id;
  const choice = row.querySelector(".pend-choice");
  if (!choice.hidden && row.querySelector(".pend-choice input[value=keep]").checked) edits.keep_study = true;

  // One line naming who it becomes and where it goes; nothing can be taken back once it is sent.
  const shown = (key, fallback) => {
    const inp = row.querySelector(PEND_FIELDS.find((f) => f[1] === key)[0]);
    return inp.dataset.locked ? "🔒" : (inp.value.trim() || fallback || "");
  };
  const who = [shown("patient", T("(no name)")),
               shown("patient_id") ? TF("ID {id}", { id: shown("patient_id") }) : "",
               shown("accession") ? TF("ACC {acc}", { acc: shown("accession") }) : ""].filter(Boolean).join(" · ");
  if (st.busy) return;
  st.busy = true;
  const old = btn.textContent; btn.disabled = true; btn.textContent = "…";
  const route = await routeFor({ attributes: {
    modality: it.kind === "pdf" ? "DOC" : "OT",
    patient_id: edits.patient_id || "", study_desc: edits.study_desc || "",
  } });
  const ask = route && route.sendable.length
    ? TF("Send as {who} to: {dests}?", { who, dests: routeText(route) })
    : TF("Send as {who} to its routed destinations?", { who });
  if (!confirm(ask)) { st.busy = false; btn.textContent = old; pendValidate(row); return; }
  try {
    const r = await studyPost("/api/pending/approve", edits);
    flashNote(r.message || T("Approved"), r.ok !== false);
    if (st.order) openOrdersCache = null;           // that order is closed now
    pendGone.add(it.id);
    removePendingRow(row);
    pollStatus();
  } catch (e) {
    // A refusal naming a field outlines it (C9: {error, field}).
    const key = PEND_ALIASES[e.field] || e.field;
    const f = key && PEND_FIELDS.find((x) => x[1] === key);
    const inp = f && row.querySelector(f[0]);
    if (inp) { inp.classList.add("pf-bad"); inp.focus(); }
    // A field this profile cannot see is empty in storage too: nobody here can fill it in.
    if (inp && inp.dataset.locked) flashNote(T("A field hidden from your profile is empty — ask someone who can see it to approve this file, or match an order."), false);
    else flashNote(failText(e), false);
    st.busy = false;
    btn.textContent = old;
    pendValidate(row);
  }
}

// Only this row goes: what was typed into the others stays.
function removePendingRow(row) {
  const list = $("pendingList");
  row.remove();
  if (!list.querySelector(".pend-row")) { list.innerHTML = ""; list.appendChild(emptyNote(T("Nothing waiting for review."))); }
}

async function discardPending(row) {
  const it = row._st.it;
  if (!confirm(T("Discard this file?") + "\n\n" + (it.filename || "") +
               "\n\n" + T("It is permanently deleted without importing."))) return;
  try {
    const r = await studyPost("/api/pending/discard", { id: it.id });
    flashNote(r.message || T("Discarded"), r.ok !== false);
    pendGone.add(it.id);
    removePendingRow(row);
    pollStatus();
  } catch (e) { flashNote(failText(e), false); }
}

// ---- Static controls of the Studies and Dev peer panels (scripts run after the markup) ----
(function wireStudiesPanel() {
  const filter = $("histFilter");
  if (filter) filter.addEventListener("input", renderHistory);
  const openDests = $("dpOpenDests");
  if (openDests) openDests.addEventListener("click", () => goTo("dlgConfig", "destinations"));
})();
