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
async function pollLog() {
  if (gateOpen) return;
  try {
    const data = await api("/api/log?since=" + logSeq);
    const box = $("log");
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
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
      const t = document.createElement("span");
      t.className = "t";
      // Raw instant kept on the node so a clock-mode change can re-render it.
      const ms = e.epoch ? e.epoch * 1000 : Date.parse(e.ts || "");
      if (!isNaN(ms)) t.dataset.ms = ms;
      t.textContent = fmtLogTs(ms, e.ts);
      const m = document.createElement("span");
      m.className = e.level;
      m.textContent = e.message;
      line.append(t, m);
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
    while (box.childElementCount > 400) box.removeChild(box.firstChild);
    if (atBottom) box.scrollTop = box.scrollHeight;
    if (!firstLog) {                 // don't blink for the backlog on first load
      if (sawStore) { blink($("rxDot")); pulseChip("rx"); }
      if (sawSend) { blink($("wxDot")); pulseChip("wx"); }
      if (sawPrint) { blink($("pxDot")); pulseChip("px"); }
      if (sawRis) { blink($("rsDot")); pulseChip("rs"); }
      if (sawMwl) { blink($("mwDot")); pulseChip("mw"); }
      if (sawQr) { blink($("qrDot")); pulseChip("qr"); }
    }
    firstLog = false;
  } catch (e) { /* ignore */ }
}

