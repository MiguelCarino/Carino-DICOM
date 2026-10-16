/* Log timestamps and log polling. */
"use strict";
// ---- Log timestamps ----
// Formatted by the navbar clock (Local/UTC/Epoch/TAI/.beats); isoFallback only if it isn't loaded.
function fmtLogTs(ms, isoFallback) {
  if (window.CarinoClock && typeof window.CarinoClock.format === "function" && !isNaN(ms)) {
    return window.CarinoClock.format(ms);
  }
  return String(isoFallback || "").replace("T", " ").replace(/(\+00:00|Z)$/, "");
}
// Re-render already-drawn log lines when the clock mode changes.
document.addEventListener("carino-clock-change", () => {
  document.querySelectorAll("#log .t[data-ms], #ovTicker .t[data-ms]").forEach((t) => {
    t.textContent = fmtLogTs(Number(t.dataset.ms));
  });
});

// ---- Log polling ----
let logSeq = 0, firstLog = true;
// Last ticker line, so the langchange handler can restore it after the i18n pass
// overwrites #ovTickerMsg with its "Nothing has happened yet." placeholder.
let lastTick = null;
function paintTicker() {
  if (!lastTick) return;
  const ts = $("ovTickerTs"), msg = $("ovTickerMsg");
  if (ts) {
    if (!isNaN(lastTick.ms)) ts.dataset.ms = lastTick.ms;
    ts.textContent = fmtLogTs(lastTick.ms, lastTick.ts);
  }
  if (msg) msg.textContent = lastTick.message;
}
/* ---- Log view filters ----
   Applied to the lines already drawn, which hold the engine's whole ring (the first poll asks for
   since=0), so filtering is instant and needs no request; the day's file covers anything older. */
// A chip is a service, and a service writes under more than one engine kind: the receiver's
// refusals are "scp" while its stored files are "store", and Auto-send's routing and scrubbing
// lines are its own too. A deep link may name a chip or any one kind.
const LOG_GROUPS = {
  receiver: ["scp", "store"], send: ["send", "watch", "route", "deid"], print: ["print"],
  ris: ["ris"], mwl: ["mwl"], qr: ["qr"], echo: ["echo"], index: ["index"],
  emergency: ["emergency"], config: ["config", "auth", "audit"],
};
const LOG_KINDS = Object.keys(LOG_GROUPS);
const kindsOf = (k) => LOG_GROUPS[k] || [k];
const LOG_CHIP_LABEL = {
  receiver: "Receiver", send: "Auto-send", print: "Printing", ris: "Emergency RIS", mwl: "Worklist",
  qr: "Query/Retrieve", echo: "Echo", index: "Instance index", emergency: "Failover", config: "Configuration",
};
const LOG_CAP = 2000;                 // matches the engine ring; older lines are in the day's file
const logFilter = { kind: "", errOnly: false, q: "" };

function lineVisible(line) {
  if (logFilter.kind && kindsOf(logFilter.kind).indexOf(line.dataset.kind) < 0) return false;
  if (logFilter.errOnly && line.dataset.level !== "warn" && line.dataset.level !== "error") return false;
  if (logFilter.q && line.textContent.toLowerCase().indexOf(logFilter.q) < 0) return false;
  return true;
}
function applyLogFilter() {
  const box = $("log");
  if (!box) return;
  let shown = 0;
  [...box.children].forEach((line) => { line.hidden = !lineVisible(line); if (!line.hidden) shown += 1; });
  const count = $("logCount");
  if (count) count.textContent = TF("{shown} of {total} lines", { shown, total: box.childElementCount });
  document.querySelectorAll("#logKinds .log-chip").forEach((c) =>
    c.setAttribute("aria-pressed", String((c.dataset.kind || "") === logFilter.kind)));
  const errs = $("logErrOnly");
  if (errs) errs.checked = logFilter.errOnly;
}
// Also the deep link: #activity/logs?kind=print, and a card's "See the log".
function setLogFilter(f) {
  if ("kind" in f) {
    const k = String(f.kind || "");
    const chip = LOG_KINDS.find((g) => g === k || LOG_GROUPS[g].indexOf(k) >= 0);
    logFilter.kind = chip || "";
  }
  if ("errOnly" in f) logFilter.errOnly = !!f.errOnly;
  if ("q" in f) { logFilter.q = String(f.q || "").toLowerCase(); const q = $("logQuery"); if (q && q.value.toLowerCase() !== logFilter.q) q.value = f.q || ""; }
  applyLogFilter();
}
function openLogs(kind) {
  setLogFilter({ kind: kind || "", errOnly: false, q: "" });
  goTo("dlgActivity", "logs");
}
function buildLogKinds() {
  const box = $("logKinds");
  if (!box) return;
  box.textContent = "";
  [""].concat(LOG_KINDS).forEach((k) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "log-chip";
    b.dataset.kind = k;
    b.textContent = k ? T(LOG_CHIP_LABEL[k] || k) : T("All");
    if (k) b.title = kindsOf(k).join(", ");   // the tags those lines carry
    b.addEventListener("click", () => setLogFilter({ kind: k }));
    box.appendChild(b);
  });
  applyLogFilter();
}
function copyVisibleLog() {
  const box = $("log");
  const text = [...box.children].filter((l) => !l.hidden).map((l) => l.textContent).join("\n");
  if (!text) { flashNote(T("Nothing to copy."), false); return; }
  navigator.clipboard.writeText(text)
    .then(() => flashNote(T("Copied the visible lines."), true))
    .catch(() => flashNote(T("This browser would not copy (the clipboard needs https or localhost) — use Download instead."), false));
}
// GET /api/log/days → the days that have a file; the select offers them, newest first.
async function loadLogDays() {
  requestAnimationFrame(logToNewest);   // after the pane is shown and has a height again
  const sel = $("logDay");
  if (!sel || !can("logs.read")) return;
  let days = [];
  try { const r = await api("/api/log/days"); days = (r.days || []).slice().sort().reverse(); } catch (e) { days = []; }
  const keep = sel.value;
  sel.textContent = "";
  days.forEach((d) => { const o = document.createElement("option"); o.value = d; o.textContent = d; sel.appendChild(o); });
  if (keep && days.indexOf(keep) >= 0) sel.value = keep;
  sel.hidden = !days.length;
  const dl = $("logDownload");
  if (dl) dl.hidden = !days.length;
}
function downloadLogDay() {
  const sel = $("logDay");
  if (!sel || !sel.value) return;
  // Plain navigation: an attachment download, with the session cookie attached.
  window.location.href = "/api/log/file?day=" + encodeURIComponent(sel.value);
}

/* Follow the newest line unless the operator scrolled up to read. Measured on the operator's own
   scrolls, not per poll: a hidden pane measures 0 tall, which read as "scrolled up" and left the
   log parked on its oldest line for good. */
let logFollow = true;
function logScrolled() {
  const box = $("log");
  if (!box || !box.clientHeight) return;
  logFollow = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
}
function logToNewest() {
  const box = $("log");
  if (box && logFollow) box.scrollTop = box.scrollHeight;
}

async function pollLog() {
  if (gateOpen) return;
  try {
    const data = await api("/api/log?since=" + logSeq);
    const box = $("log");
    let sawStore = false, sawSend = false, sawPrint = false, sawRis = false, sawMwl = false, sawQr = false;
    for (const e of data.entries) {
      logSeq = e.seq;
      if (e.kind === "store") sawStore = true;   // a file was received
      if (e.kind === "send") sawSend = true;      // a file was forwarded
      if (e.kind === "print") sawPrint = true;    // a print job / event
      if (e.kind === "ris") sawRis = true;        // an HL7 order / match event
      if (e.kind === "mwl") sawMwl = true;        // a worklist query
      if (e.kind === "qr") sawQr = true;          // a C-FIND / C-MOVE / C-GET
      const line = document.createElement("div");
      line.className = "line";
      line.dataset.kind = e.kind || "";
      line.dataset.level = e.level || "";
      const t = document.createElement("span");
      t.className = "t";
      // Raw instant kept on the node so a clock-mode change can re-render it.
      const ms = e.epoch ? e.epoch * 1000 : Date.parse(e.ts || "");
      if (!isNaN(ms)) t.dataset.ms = ms;
      t.textContent = fmtLogTs(ms, e.ts);
      // Which service said it: the engine's kind code, untranslated (it is what the filter matches).
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = e.kind || "";
      const m = document.createElement("span");
      m.className = e.level;
      m.textContent = e.message;
      line.append(t, k, m);
      line.hidden = !lineVisible(line);
      box.appendChild(line);
    }
    // Overview ticker = last line drawn (the first poll, since=0, gets the backlog).
    if (data.entries.length) {
      const last = data.entries[data.entries.length - 1];
      lastTick = {
        ms: last.epoch ? last.epoch * 1000 : Date.parse(last.ts || ""),
        ts: last.ts,
        message: last.message,
      };
      paintTicker();
    }
    while (box.childElementCount > LOG_CAP) box.removeChild(box.firstChild);
    if (data.entries.length) applyLogFilter();
    logToNewest();
    if (!firstLog) {                 // don't blink for the backlog on first load
      if (sawStore) { blink($("rxDot")); pulseChip("rx"); }
      if (sawSend) { blink($("wxDot")); pulseChip("wx"); }
      if (sawPrint) { blink($("pxDot")); pulseChip("px"); }
      if (sawRis) { blink($("rsDot")); pulseChip("rs"); }
      if (sawMwl) { blink($("mwDot")); pulseChip("mw"); }
      if (sawQr) { blink($("qrDot")); pulseChip("qr"); }
    }
    firstLog = false;
  } catch (e) { /* the status poll reports lost contact; this one just tries again */ }
}

// ---- Connections (Activity → Connections) ----
/* Recent DICOM associations both ways (pacs/connections.py), each with what went wrong and the fix.
   The engine sends a code and its blanks; the sentences are said here so they can be translated.
   Same table as connections._TEXT — tests/test_connections.py fails if the two drift. */
const CONN_TEXT = {
  in_ok: [
    "{calling} at {peer} connected and was accepted.",
    ""],
  in_ae_swapped: [
    "{peer} called in as {calling}, which is this PACS's own AE title, and asked for {called}.",
    "The two AE titles are swapped on that device: its own AE title goes in the local (calling) field, and {calling} goes in the remote (called) field."],
  in_not_allowed: [
    "{calling} at {peer} was turned away: its AE title is not in the allowed list.",
    "If {calling} should be able to connect, add it under Configuration → Settings → {group} → Accept only these AEs."],
  in_busy: [
    "{calling} at {peer} was turned away for now: too many connections at once.",
    "Nothing to change if it is rare — the sender retries. If it keeps happening, the sender may be leaving connections open."],
  in_rejected: [
    "{calling} at {peer} was turned away: {reason}.",
    ""],
  in_wrong_port: [
    "{calling} tried to send images to port {port}, which is not where this PACS receives images.",
    "On {calling}, set the storage destination to port {rx_port} with AE title {rx_aet}."],
  in_wrong_port_off: [
    "{calling} tried to send images to port {port}, which is not where this PACS receives images.",
    "Turn the receiver on under Services, then point {calling} at its port."],
  in_other_port: [
    "{calling} asked port {port} for {sops}, which this PACS offers on another port.",
    "On {calling}, set that service's port to {right_port} with AE title {right_aet}."],
  in_other_port_off: [
    "{calling} asked port {port} for {sops}, which this PACS offers on another port.",
    "That service is not running here. Turn it on under Services, then point {calling} at its port."],
  in_sop_refused: [
    "{calling} offered {sops}, which this service does not accept.",
    "This PACS has no setting to accept it. Ask the vendor whether {calling} can send it as a standard object (for example Secondary Capture), or send it to a system that takes it."],
  in_ts_refused: [
    "{calling} offered {sop} only as {tss}, which this PACS does not accept.",
    "This PACS has no setting to add a transfer syntax. On {calling}, choose an uncompressed (Explicit VR Little Endian) or JPEG Lossless export for it."],
  in_called_mismatch: [
    "{calling} calls this PACS {called}, but its AE title is {aet}. It works only because this PACS does not check the called AE title.",
    "On {calling}, set the remote AE title to {aet}."],
  in_aborted: [
    "{calling} at {peer} dropped the connection part-way through.",
    "Usually a network drop or a transfer cancelled on {calling}; check its queue for that study."],
  out_ok: [
    "{dest} ({called} at {host}:{port}) accepted the connection.",
    ""],
  out_refused: [
    "Nothing is listening at {host}:{port}.",
    "Check that {dest} is running and that its port is right under Configuration → Destinations (a PACS usually receives on 104 or 11112)."],
  out_unreachable: [
    "{host}:{port} did not answer: the machine is off, unreachable, or a firewall is dropping the connection.",
    "Check the address of {dest}, and that any firewall between the two allows port {port}."],
  out_tls_failed: [
    "The TLS handshake with {dest} at {host}:{port} failed.",
    "Check the certificates under Configuration → Settings → Sending, and that {dest} expects TLS on port {port}. If it does not, untick TLS on its row under Destinations."],
  out_maybe_tls: [
    "{dest} at {host}:{port} took the connection and dropped it without answering.",
    "That is what a TLS-only port does with a plain connection. If {dest} uses DICOM-TLS, tick TLS on its row under Configuration → Destinations."],
  out_dropped: [
    "{dest} at {host}:{port} took the connection and dropped it without answering.",
    "Check the log on {dest}: it may not trust this PC's certificate."],
  out_no_answer: [
    "{dest} at {host}:{port} took the connection but never answered the association request.",
    "{dest} may be overloaded or hung. Check that it is working, then try again."],
  out_ae_swapped: [
    "{dest} refused the connection, and the AE titles look swapped: the destination is set to {called}, which is an AE title of this PACS.",
    "Under Configuration → Destinations, set {dest}'s AE title to the remote's own AE title. This PACS calls as {calling}; that is the title {dest} must accept."],
  out_calling_refused: [
    "{dest} does not accept calls from {calling}, the AE title this PACS sends as.",
    "On {dest}, add {calling} (at this PC's address) to the AE titles it accepts."],
  out_called_unknown: [
    "{dest} does not answer to the AE title {called}.",
    "Check {dest}'s AE title under Configuration → Destinations: it must match what {dest} calls itself, exactly, including case."],
  out_busy: [
    "{dest} turned the connection away for now: it is busy.",
    "Nothing to change here — sends are retried. If it keeps happening, ask whoever runs {dest} to allow more connections."],
  out_rejected: [
    "{dest} refused the connection: {reason}.",
    ""],
  out_not_storage: [
    "{dest} answers C-ECHO but accepts none of the image types offered — it is probably a worklist or query port.",
    "Check the port under Configuration → Destinations; a PACS usually receives images on 104 or 11112."],
  out_sop_refused: [
    "{dest} does not accept {sops}.",
    "Check that {host}:{port} is the right service on {dest}. If it is, ask whoever runs it to enable this, or stop routing these images to {dest} (Configuration → Routing)."],
  out_ts_only_uncompressed: [
    "{dest} accepts {sop} only uncompressed; images stored here as {tss} are refused.",
    "This PACS sends each image exactly as it was received and cannot convert it, so these cannot be sent as they are. Enable {tss} on {dest}, or have the modality send uncompressed images."],
  out_ts_refused: [
    "{dest} accepts {sop}, but not as {tss}.",
    "This PACS sends each image exactly as it was received and cannot convert it, so it cannot be sent as it is. Enable {tss} on {dest}, or have the modality send it in a transfer syntax {dest} accepts."],
  out_ctx_refused: [
    "{dest} refused {sops} ({reason}).",
    ""],
};
// Blanks that are themselves dashboard words (a Settings group's title), translated like a label.
const CONN_T_VARS = ["group"];
const CONN_OUTCOME = {
  accepted: "Accepted", none_accepted: "Nothing in common", rejected: "Turned away",
  aborted: "Dropped", refused: "Nothing listening", unreachable: "No reply", tls: "TLS failed",
  no_answer: "No answer", error: "Error",
};
const CONN_SERVICE = {
  receiver: "Receiver", printer: "Printer", worklist: "Worklist", qr: "Query/Retrieve",
  send: "Send", echo: "Test", check: "What it accepts", "worklist-probe": "Worklist probes",
};
// One finding as two lines: the sentence, then the fix (if there is one), in the operator's language.
function connFinding(f) {
  const text = CONN_TEXT[f.code];
  const vals = Object.assign({}, f.vars || {});
  CONN_T_VARS.forEach((k) => { if (vals[k]) vals[k] = T(vals[k]); });
  const box = document.createElement("div");
  box.className = "conn-finding " + (f.level || "error");
  const say = document.createElement("div");
  say.className = "conn-say";
  // An engine newer than this page may send a code it does not know: show the engine's English.
  say.textContent = text ? TF(text[0], vals) : (f.say || f.code);
  box.appendChild(say);
  const fixText = text ? (text[1] ? TF(text[1], vals) : "") : (f.fix || "");
  if (fixText) {
    const fix = document.createElement("div");
    fix.className = "conn-fix";
    fix.textContent = fixText;
    box.appendChild(fix);
  }
  return box;
}
let connPeerTimer = null;
async function loadConnections() {
  const list = $("connList");
  if (!list || !can("logs.read")) return;
  const peer = (($("connPeer") || {}).value || "").trim();
  let data;
  try {
    data = await api("/api/connections" + (peer ? "?peer=" + encodeURIComponent(peer) : ""));
  } catch (e) {
    list.textContent = ""; list.appendChild(emptyNote(e.message)); return;
  }
  list.textContent = "";
  const rows = (data && data.entries) || [];
  if (!rows.length) {
    list.appendChild(emptyNote(peer ? T("No connections match.") : T("No connections yet.")));
    return;
  }
  rows.forEach((e) => list.appendChild(connRow(e)));
}
function connRow(e) {
  const worst = (e.findings || [])[0] || { level: "ok" };
  const row = document.createElement("div");
  row.className = "conn-row " + (worst.level || "error");
  const head = document.createElement("div");
  head.className = "conn-head";
  const badge = document.createElement("span");
  badge.className = "conn-badge " + (worst.level || "error");
  badge.textContent = T(CONN_OUTCOME[e.outcome] || e.outcome);
  const dir = document.createElement("span");
  dir.className = "conn-dir";
  dir.textContent = e.direction === "in" ? T("Incoming") : T("Outgoing");
  const svc = document.createElement("span");
  svc.className = "conn-svc";
  svc.textContent = T(CONN_SERVICE[e.service] || e.service);
  // Who called whom, as the wire said it: the AE titles are what both sides' settings are matched on.
  const who = document.createElement("span");
  who.className = "conn-who";
  const where = e.direction === "in" ? e.peer : (e.dest ? e.dest + " · " : "") + e.peer + ":" + e.port;
  who.textContent = (e.calling || "?") + " → " + (e.called || "?") + " · " + where;
  const when = document.createElement("span");
  when.className = "conn-when";
  when.textContent = fmtLogTs(e.last * 1000, "") + (e.count > 1 ? " · ×" + e.count : "");
  head.append(badge, dir, svc, who, when);
  row.appendChild(head);
  (e.findings || []).forEach((f) => { if (f.level !== "ok") row.appendChild(connFinding(f)); });
  if ((e.contexts || []).length) row.appendChild(connContexts(e.contexts));
  return row;
}
// What was offered and what came back, per presentation context — what a vendor's support line asks for.
const CONN_RESULT = { 0: "accepted", 1: "refused by the remote", 2: "no reason given",
                      3: "kind of object not supported", 4: "transfer syntax not supported" };
function connContexts(ctx) {
  const d = document.createElement("details");
  d.className = "conn-ctx";
  const s = document.createElement("summary");
  s.textContent = TN(ctx.length, "{n} presentation contexts");
  d.appendChild(s);
  ctx.forEach((c) => {
    const line = document.createElement("div");
    line.className = "conn-ctx-line" + (c.result === 0 ? " good" : (c.result == null ? "" : " bad"));
    const ts = c.result === 0 ? c.accepted_name : (c.proposed_names || []).join(", ");
    const res = c.result == null ? "—" : T(CONN_RESULT[c.result] || String(c.result));
    line.textContent = (c.sop_name || c.sop) + " · " + ts + " — " + res;
    line.title = c.sop + "\n" + (c.proposed || []).join("\n");
    d.appendChild(line);
  });
  return d;
}
