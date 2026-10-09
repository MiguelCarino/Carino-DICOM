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
