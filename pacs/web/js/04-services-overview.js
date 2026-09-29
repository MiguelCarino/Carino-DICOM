/* Service chooser (setup), Overview panel, desktop-shell update notice, navbar service chips and nav badges. */
"use strict";
// ---- Service chooser (#dlgServices in its "setup" state) ----
/* Same cards plus a checkbox each. All *.enabled flags are written in ONE post, since
   apply_config() restarts the receiver on every save; picks stay local until Apply. */
const SETUP_CARDS = [
  { svc: "receiver", card: "receiverCard", pick: "pickRx", port: "portRx", label: "Receiver",       block: "receiver" },
  { svc: "watcher",  card: "watcherCard",  pick: "pickWx", port: "",       label: "Auto-send",      block: "watcher" },
  { svc: "printer",  card: "printerCard",  pick: "pickPx", port: "portPx", label: "Print receiver", block: "printer" },
  { svc: "ris",      card: "risCard",      pick: "pickRs", port: "portRs", label: "Emergency RIS",  block: "ris" },
  { svc: "mwl",      card: "mwlCard",      pick: "pickMw", port: "portMw", label: "Worklist",       block: "mwl" },
  { svc: "qr",       card: "qrCard",       pick: "pickQr", port: "portQr", label: "Query/Retrieve", block: "qr" },
];
// setupDismissed is in-memory only: "Not now" lasts this page-load; a reload re-offers the chooser.
let setupActive = false, setupSeeded = false, setupDismissed = false;
const labelFor = (svc) => (SETUP_CARDS.find((c) => c.svc === svc) || {}).label || svc;

function setCardState(id, enabled, running) {
  const card = $(id);
  if (!card) return;
  // In setup the checkbox owns the highlight, so the poll doesn't overwrite a fresh tick.
  if (!setupActive) card.classList.toggle("chosen", !!enabled);
  card.classList.toggle("stalled", !!enabled && !running);
}

// The shared .card-warn says "check the port", but the watcher binds none. Set from JS
// because the i18n pass keys on the markup text and would restore the shared sentence.
function retitleWatcherWarn() {
  const card = $("watcherCard");
  const warn = card && card.querySelector(".card-warn");
  if (warn) warn.textContent = T("Enabled but not running — check the log.");
}

function enterSetup() {
  const panel = $("dlgServices");
  if (!panel) return;
  setupActive = true;
  setupSeeded = false;
  panel.classList.add("setup");
  // Show the advanced cards now; renderEmergency() keeps them shown while setupActive.
  const rsCard = $("risCard"), mwCard = $("mwlCard");
  if (rsCard) rsCard.hidden = false;
  if (mwCard) mwCard.hidden = false;
  const intro = $("setupIntro"), foot = $("setupFoot");
  if (intro) intro.hidden = false;
  if (foot) foot.hidden = false;
  if (lastStatus) seedSetup(lastStatus);
  else updateSetupCount();  // no status yet (boot #setup) — the next poll seeds it
}

function exitSetup() {
  const panel = $("dlgServices");
  setupActive = false;
  setupDismissed = true;
  if (panel) panel.classList.remove("setup");
  const intro = $("setupIntro"), foot = $("setupFoot");
  if (intro) intro.hidden = true;
  if (foot) foot.hidden = true;
  pollStatus();             // the poll is the truth: it repaints highlights and card visibility
}

// Seed from persisted flags once per chooser session; then the operator owns them.
function seedSetup(s) {
  setupSeeded = true;
  SETUP_CARDS.forEach((c) => {
    const on = !!((s[c.block] || {}).enabled);
    const box = $(c.pick);
    if (box) box.checked = on;
    const card = $(c.card);
    if (card) card.classList.toggle("chosen", on);
  });
  updateSetupCount();
  probePorts(s);
}

function pickedServices() {
  const out = {};
  document.querySelectorAll(".pick-box").forEach((b) => { out[b.dataset.svc] = b.checked; });
  return out;
}

function updateSetupCount() {
  const el = $("setupCount");
  if (!el) return;
  const picks = pickedServices();
  const n = Object.keys(picks).filter((k) => picks[k]).length;
  // Zero is a valid choice (stops everything, still records the answer).
  el.textContent = n ? TN(n, "{n} selected") : T("Nothing selected — this PC will not receive or send anything.");
}

// validate() only checks range/uniqueness; this asks the server if ports are free. Once per chooser entry.
async function probePorts(s) {
  const items = [];
  SETUP_CARDS.forEach((c) => {
    const el = c.port && $(c.port);
    const blk = s[c.block] || {};
    if (!el || blk.port == null) return;      // the watcher binds nothing at all
    el.textContent = T("Checking ports…");
    el.classList.remove("bad");
    items.push({ service: c.svc, bind: blk.bind || "0.0.0.0", port: blk.port });
  });
  if (!items.length) return;
  let res;
  try {
    res = await post("/api/portcheck", { ports: items });
  } catch (e) {
    // No answer -> show nothing, never a guess.
    SETUP_CARDS.forEach((c) => { const el = c.port && $(c.port); if (el) { el.textContent = ""; el.classList.remove("bad"); } });
    return;
  }
  const by = {};
  (res.results || []).forEach((r) => { by[r.service] = r; });
  SETUP_CARDS.forEach((c) => {
    const el = c.port && $(c.port);
    if (!el) return;
    const r = by[c.svc];
    if (!r) { el.textContent = ""; el.classList.remove("bad"); return; }
    const free = !!(r.free || r.mine);        // a port we are already listening on is ours, not a clash
    // Only EADDRINUSE (98 Linux, 48 BSD/macOS, 10048 Windows) is a clash; other errors
    // (range, EACCES) are shown in the engine's own words.
    const clash = /\[(?:Errno|WinError) (?:98|48|10048)\]/.test(r.error || "");
    el.textContent = r.mine ? TF("Port {port} is in use by this app", { port: r.port })
                   : free   ? TF("Port {port} is free", { port: r.port })
                   : (r.error && !clash) ? r.error
                            : TF("Port {port} is already in use on this PC", { port: r.port });
    el.classList.toggle("bad", !free);
  });
}

async function applySetup(btn) {
  const picks = pickedServices();
  const n = Object.keys(picks).filter((k) => picks[k]).length;
  btn.disabled = true;
  try {
    const res = await post("/api/setup", { services: picks });
    // Re-read the config: every later POST /api/config re-asserts the loaded snapshot
    // (see collectConfig), so a stale one would undo this enrolment. Unsaved Settings edits are dropped.
    let resyncErr = null;
    await loadConfig().catch((e) => { resyncErr = e; });
    flashNote(TN(n, "{n} services enabled"), true);
    // A service that failed to bind is reported individually, not as a failed apply.
    (res.results || []).filter((r) => r.ok === false).forEach((r) => {
      flashNote(TF("{svc} did not start: {err}", { svc: T(labelFor(r.service)), err: r.error || "" }), false);
    });
    // Flashed last: a failed re-read means the next Save would post the pre-chooser config.
    if (resyncErr) flashNote(TF("Load failed: {err}", { err: resyncErr.message }), false);
    exitSetup();
  } catch (e) {
    flashNote(e.message, false);
  } finally { btn.disabled = false; }
}

// ---- Overview ----
// Fed by renderStatus() and pollLog() (no own fetch); skipped while closed. Nothing is inferred.
function renderOverview(s) {
  const panel = $("dlgOverview");
  if (!panel || panel.hidden) return;         // badges keep updating; the DOM work is skipped
  const txt = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  const rx = s.receiver || {}, wx = s.watcher || {}, px = s.printer || {}, rs = s.ris || {}, mw = s.mwl || {};
  const qr = s.qr || {};
  const setup = s.setup || {};

  // Must match the enrollable set in SETUP_CARDS.
  const services = [rx, wx, px, rs, mw, qr];
  txt("ovServices", services.filter((b) => b.running).length + "/" + services.length);
  txt("ovReceived", rx.received || 0);
  txt("ovSent", wx.sent || 0);
  txt("ovStuck", s.stuck || 0);
  txt("ovPending", s.pending || 0);
  txt("ovOpenOrders", (rs.counts && rs.counts.open) || 0);
  const disk = s.disk || {};
  txt("ovFree", disk.free_gb != null ? disk.free_gb + " GB" : "—");
  // Only Received/Sent are counters. Each has its own origin: the receiver's counters reset
  // on every config save, the watcher's don't. One line only when both origins match.
  const rxSince = rx.since || s.started_at || 0;
  const wxSince = wx.since || s.started_at || 0;
  txt("ovSince", !rxSince && !wxSince ? ""
    : rxSince === wxSince
      ? TF("Received and sent counted since {ts}", { ts: fmtLogTs(rxSince * 1000) })
      : TF("Received counted since {rx} · sent since {wx}",
           { rx: fmtLogTs(rxSince * 1000), wx: fmtLogTs(wxSince * 1000) }));
  const note = $("ovSetupNote");
  if (note) note.hidden = !setup.needed;

  const ips = (s.host_ips && s.host_ips.length) ? s.host_ips : (s.host_ip ? [s.host_ip] : []);
  setAtomic("ovIp", ips.length ? ips[0] + (ips.length > 1 ? " +" + (ips.length - 1) : "") : "");
  // Flag a stopped receiver so nobody points a modality at a dead port.
  setAtomic("ovAetPort", rx.aet
    ? rx.aet + ":" + rx.port + (rx.running ? "" : " · " + T("not listening"))
    : "");
  txt("ovVersionV", dash(s.version));
  setPath("ovConfigPath", setup.config_path || s.config_path);
  setPath("ovStorageDir", rx.storage_dir);
  setPath("ovLogsDir", s.logs_dir);

  renderOvDests(s);
  renderOvLast(s);
}

// ---- Desktop shell update notice ----
/* Only when the Electron shell exposes window.carinoDesktop (preload.js); in a browser the
   link stays hidden. A quiet suffix on the Version row; the shell re-announces on every load. */
let desktopUpdate = null;

function paintDesktopUpdate() {
  const a = $("ovVersionUpd");
  if (!a) return;
  if (!desktopUpdate) { a.hidden = true; a.textContent = ""; return; }
  // "1.1.0 · 1.2.0 available ↗": only the sentence is translated (one literal for i18n-parity).
  a.textContent = "· " + TF("{v} available", { v: desktopUpdate.version }) + " ↗";
  a.hidden = false;
}

function initDesktopShell() {
  const d = window.carinoDesktop;
  if (!d || typeof d.onUpdate !== "function") return;
  const a = $("ovVersionUpd");
  if (a) {
    a.addEventListener("click", (ev) => {
      // The shell opens the real browser; preventDefault avoids opening it twice (href kept for a11y).
      ev.preventDefault();
      if (d.openReleasePage) d.openReleasePage();
    });
  }
  const seen = (u) => { desktopUpdate = u && u.version ? u : null; paintDesktopUpdate(); };
  try { seen(d.getUpdate && d.getUpdate()); } catch (e) { /* an older shell: wait for the event */ }
  d.onUpdate(seen);
}

function renderOvDests(s) {
  const box = $("ovDestList"), empty = $("ovDestEmpty"), tpl = $("ovDestRowTpl");
  if (!box || !tpl) return;
  const list = (s.destinations || []).filter((d) => d.enabled !== false);
  if (empty) empty.hidden = !!list.length;
  box.innerHTML = "";
  // Only 🚨-flagged destinations are probed (while armed); others show "Not checked", never green.
  const probes = {};
  ((s.emergency || {}).destinations || []).forEach((e) => { probes[e.name] = e; });
  list.forEach((d) => {
    const row = I18N_IN(tpl.content.cloneNode(true)).querySelector(".ov-dest");
    const nm = row.querySelector(".ov-dest-name");
    nm.textContent = d.name || T("(destination)");
    nm.title = nm.textContent;                // ellipsises; keep the full name reachable
    const addr = row.querySelector(".ov-dest-addr");
    addr.textContent = dash([d.host && d.port ? d.host + ":" + d.port : d.host, d.aet].filter(Boolean).join(" · "));
    addr.title = addr.textContent;            // .ov-atomic ellipsises the tail
    const state = row.querySelector(".ov-dest-state");
    const note = row.querySelector(".ov-dest-note");
    const p = probes[d.name];
    if (p && p.checked) {
      // Gate green on last_error (cleared per successful probe), not `online` (debounced by
      // offline_threshold_sec). probe_ok = C-ECHO answered; last_error may also mean sends failing.
      const answered = p.probe_ok !== false;
      const up = answered && !p.last_error;
      state.classList.add(up ? "ok" : (answered ? "warn" : "bad"));
      state.textContent = up ? T("Reachable")
        : answered ? T("Sends failing") : T("Unreachable");
      // Engine's failure text as the tooltip.
      if (p.last_error) state.title = p.last_error;
      note.textContent = p.last_probe
        ? TF("checked {ts}", { ts: fmtLogTs(Date.parse(p.last_probe), p.last_probe) }) : "";
    } else {
      state.classList.add("unknown");
      state.textContent = T("Not checked");
      note.textContent = "";
    }
    box.appendChild(row);
  });
}

// Empty-box text for the "last event" boxes: idle vs enabled-but-down vs switched off.
function ovEmptyText(blk, idle) {
  if (blk.running) return T(idle);
  return blk.enabled ? T("Enabled but not running — check the log.")
                     : T("Switched off on this PC.");
}

function renderOvLast(s) {
  const txt = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  // Show the empty line and, while it is showing, own its wording.
  const empty = (id, on, blk, idle) => {
    const el = $(id);
    if (!el) return;
    el.hidden = !on;
    if (on) el.textContent = ovEmptyText(blk, idle);
  };

  const rx = s.receiver || {};
  const l = rx.last;
  empty("ovRxEmpty", !l, rx, "Nothing received yet.");
  txt("ovRxPatient", l ? (l.patient || T("(no name)")) + (l.patient_id ? "  ·  " + l.patient_id : "") : "");
  txt("ovRxMeta", l ? [l.modality, l.file, l.from_aet ? TF("from {src}", { src: l.from_aet }) : ""]
    .filter(Boolean).join("  ·  ") : "");
  txt("ovRxWhen", l ? fmtLogTs(l.epoch * 1000) : "");

  const wx = s.watcher || {};
  const t = wx.last_sent;
  empty("ovTxEmpty", !t, wx, "Nothing sent yet.");
  txt("ovTxFile", t ? t.file || "" : "");
  txt("ovTxDest", t ? "→ " + (t.dest || "") : "");
  txt("ovTxWhen", t ? fmtLogTs(t.epoch * 1000) : "");
  txt("ovTxError", t && t.ok === false ? t.error || "" : "");

  const ris = s.ris || {};
  const o = ris.last_order, c = ris.last_closed;
  // Empty only with no open or closed order; orders can be hand-keyed with HL7 stopped,
  // so it says the intake is stopped, not the feature.
  const oe = $("ovOrderEmpty");
  if (oe) {
    oe.hidden = !(!o && !c);
    if (!oe.hidden) oe.textContent = ris.running ? T("No orders yet.")
                                                 : T("No orders yet — HL7 intake is stopped.");
  }
  txt("ovOrderPatient", o ? (o.patient || T("(no patient)")) +
    (o.accession ? "  ·  " + TF("ACC {acc}", { acc: o.accession }) : "") : "");
  txt("ovOrderMeta", o ? [
    o.patient_id ? TF("ID {id}", { id: o.patient_id }) : "",
    o.modality || "",
    o.study_desc || T("(no study description)"),
    o.source ? TF("from {src}", { src: o.source }) : "",
  ].filter(Boolean).join("  ·  ") : "");
  txt("ovOrderWhen", o && o.created ? TF("queued {ts}", { ts: fmtLogTs(Date.parse(o.created), o.created) }) : "");
  txt("ovOrderClosed", !c ? "" : (c.close_reason === "matched"
    ? TF("✓ matched {ts}", { ts: fmtLogTs(Date.parse(c.closed), c.closed) })
    : TF("cancelled {ts}", { ts: fmtLogTs(Date.parse(c.closed), c.closed) })));
}

// ---- Navbar service chips ----
// Gold when running. A click re-fires the card's toggle so the start/persist logic lives in one place.
const NAV_SERVICES = [
  { key: "rx", label: "Receiver",  toggle: "rxToggle" },
  { key: "wx", label: "Auto-send", toggle: "wxToggle" },
  { key: "px", label: "Printer",   toggle: "pxToggle" },
  { key: "rs", label: "RIS",       toggle: "rsToggle" },
  { key: "mw", label: "Worklist",  toggle: "mwToggle" },
  // "Q/R" stays untranslated: the chip is too narrow for the full noun.
  { key: "qr", label: "Q/R",       toggle: "qrToggle" },
];
function mountServiceChips() {
  const nav = $("carinoNav");
  if (!nav) return false;                       // navbar not injected yet
  if ($("svcNav")) return true;   // already mounted
  const right = nav.querySelector(".cn-right");
  if (!right) return false;
  const box = document.createElement("div");
  box.className = "svc-nav";
  box.id = "svcNav";
  NAV_SERVICES.forEach((svc) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "svc-chip";
    chip.id = "nav_" + svc.key;
    chip.dataset.on = "false";
    chip.dataset.svc = svc.label;               // English key, for retranslation
    // Born disabled: can() is true for everyone until /api/auth resolves.
    // applyCapabilities() enables it if the profile holds services.control.
    chip.disabled = true;
    const dot = document.createElement("span"); dot.className = "svc-chip-dot";
    const lab = document.createElement("span"); lab.className = "svc-chip-label"; lab.textContent = T(svc.label);
    chip.append(dot, lab);
    chip.addEventListener("click", () => { const b = $(svc.toggle); if (b) b.click(); });
    box.appendChild(chip);
  });
  right.insertBefore(box, right.firstChild);
  chipAuthority();
  return true;
}
/* Who may click the chips (everyone may see them: service state is ungated in _STATUS_GATES).
   Without services.control the button is disabled but the dot stays. Called from
   applyCapabilities() each poll, since mountServiceChips() only runs once. */
function chipAuthority() {
  const allowed = can("services.control");
  NAV_SERVICES.forEach((svc) => {
    const chip = $("nav_" + svc.key);
    if (!chip) return;
    chip.disabled = !allowed;
    chip.title = chipTitle(svc, chip, allowed);
  });
}
// Nav-row count badge: hidden at zero, labelled for screen readers.
function setBadge(id, n, glyph, label) {
  const el = $(id);
  if (!el) return;
  el.textContent = glyph ? glyph + " " + n : String(n);
  el.hidden = n === 0;
  el.setAttribute("aria-label", label);
  el.title = label;
}
function chipTitle(svc, chip, allowed) {
  const name = T(svc.label);
  if (allowed) return TF("{svc} — click to start/stop", { svc: name });
  return chip.dataset.on === "true"
    ? TF("{svc} — running", { svc: name })
    : TF("{svc} — stopped", { svc: name });
}
// Re-label the already-mounted chips after a language switch.
function relabelServiceChips() {
  NAV_SERVICES.forEach((svc) => {
    const chip = $("nav_" + svc.key);
    if (!chip) return;
    chip.title = chipTitle(svc, chip, can("services.control"));
    const lab = chip.querySelector(".svc-chip-label");
    if (lab) lab.textContent = T(svc.label);
  });
}
function setChip(key, on) {
  const chip = $("nav_" + key);
  if (!chip) return;
  chip.dataset.on = String(!!on);
  chip.classList.toggle("on", !!on);
  // The read-only title names the state, so update it too.
  if (chip.disabled) {
    const svc = NAV_SERVICES.find((s) => s.key === key);
    if (svc) chip.title = chipTitle(svc, chip, false);
  }
}
function showChip(key, show) {
  const chip = $("nav_" + key);
  if (chip) chip.hidden = !show;
}
// Amber activity blink (like an ethernet link/activity LED); only while running.
function blink(el) {
  if (!el || !el.classList.contains("on")) return;
  el.classList.remove("act");
  void el.offsetWidth;              // restart the CSS animation
  el.classList.add("act");
}
// Navbar chip transmit pulse; restarted each poll with traffic so sustained transfers keep pulsing.
function pulseChip(key) {
  const chip = $("nav_" + key);
  if (!chip || !chip.classList.contains("on")) return;
  chip.classList.remove("tx");
  void chip.offsetWidth;
  chip.classList.add("tx");
}

