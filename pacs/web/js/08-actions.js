/* Actions: echo, toasts, access-token rotation, save/toggle, folder drag-and-drop, service shutdown. */
"use strict";
  // ---- Actions ----
  async function echoRow(tr) {
    const dest = {
      name: tr.querySelector(".d-name").value.trim(),
      host: tr.querySelector(".d-host").value.trim(),
      port: parseInt(tr.querySelector(".d-port").value, 10),
      aet: tr.querySelector(".d-aet").value.trim(),
    };
    const btn = tr.querySelector(".echo");
    if (!dest.host || !dest.port || !dest.aet) { flashNote(T("Fill host, port and AE first"), false); return; }
    const old = btn.textContent; btn.textContent = "…"; btn.disabled = true;
    try {
      const r = await post("/api/echo", dest);
      flashNote(`${dest.host}: ${r.message}`, r.ok);
    } catch (e) {
      flashNote(`${dest.host}: ${e.message}`, false);
    } finally { btn.textContent = old; btn.disabled = false; }
  }

  /* A toast: `ok` = green/red. `opts.warn` = must-not-miss: announced assertively (role="alert",
     so it interrupts #ordAlertLive), never times out. The role is set BEFORE the text because
     several screen readers skip text that arrives together with its live region. */
  let noteGen = 0;
  function flashNote(msg, ok, opts) {
    // The token prompt owns its own message line; don't stack 401 toasts behind it.
    if (gateOpen) return;
    const t = $("toast");
    const warn = !!(opts && opts.warn);
    const gen = ++noteGen;
    clearTimeout(flashNote._t);
    t.textContent = "";
    t.className = "toast " + (ok ? "ok" : "bad");
    if (warn) { t.setAttribute("role", "alert"); t.setAttribute("aria-live", "assertive"); }
    else { t.removeAttribute("role"); t.removeAttribute("aria-live"); }
    t.hidden = false;
    const paint = () => {
      if (gen !== noteGen) return;      // a newer toast landed inside the gap
      t.textContent = msg;
      if (warn) t.append(" ", dismissNote());
    };
    if (warn) setTimeout(paint, 60); else paint();
    // A warning stays until dismissed or replaced: what it reports stays true until acted on.
    if (!warn) flashNote._t = setTimeout(() => { t.hidden = true; }, 5000);
  }

  // Keyboard-reachable close button for a warning toast; the name lives on aria-label, not the glyph.
  function dismissNote() {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn ghost tiny";
    b.textContent = "✕";
    b.setAttribute("aria-label", T("Dismiss this warning"));
    b.addEventListener("click", () => {
      const t = $("toast");
      t.hidden = true;
      t.textContent = "";
      t.removeAttribute("role");
      t.removeAttribute("aria-live");
    });
    return b;
  }

  function webSection() {
    return { ...loadedWeb, editor_url: $("webEditorUrl").value.trim() };
  }

  // ---- Access token: state line and rotation ----
  function renderAuthState() {
    const el = $("authState");
    if (!el) return;
    el.textContent = tokenSet
      ? T("A token is set. The dashboard exchanges it for a session cookie at sign-in and never stores the token itself, so it cannot show you the one on file.")
      : T("No token set. The dashboard is unauthenticated, which is only allowed while it is bound to this machine.");
    el.classList.toggle("warn-note", !tokenSet);
    const rot = $("authRotate");
    const logout = $("authLogout");
    if (logout) logout.hidden = !authRequired;
    // No token yet: nothing to remove or prove (how the first one is set from loopback).
    const clear = $("authClearBtn");
    if (clear) clear.hidden = !tokenSet;
    const proof = $("authProofWrap");
    if (proof) proof.hidden = !tokenSet;
    const note = $("authProofNote");
    if (note) note.hidden = !tokenSet;
    const change = $("authRotateBtn");
    if (change) change.hidden = !!(rot && !rot.hidden);
  }

  // 32 CSPRNG bytes, base64url: same shape as the engine's secrets.token_urlsafe(32).
  function generateToken() {
    const c = window.crypto;
    if (!c || !c.getRandomValues) return "";
    const bytes = new Uint8Array(32);
    c.getRandomValues(bytes);
    let s = "";
    bytes.forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function openRotate() {
    const box = $("authRotate");
    if (!box) return;
    box.hidden = false;
    clearRotateFields(false);
    renderAuthState();
    const f = $(tokenSet ? "authCurToken" : "authNewToken");
    if (f) f.focus();
  }

  // Typed tokens live only in these fields (never a variable or storage) and are wiped after use.
  function clearRotateFields(hide) {
    ["authCurToken", "authNewToken"].forEach((id) => {
      const f = $(id);
      if (f) { f.value = ""; f.type = "password"; }
    });
    if (hide !== false) { const box = $("authRotate"); if (box) box.hidden = true; }
  }

  function cancelRotate() {
    clearRotateFields(true);
    renderAuthState();
  }

  /* POST /api/auth/token is the ONLY way to change the token. It proves the current token in a
     header, not the session cookie (a cookie able to replace its own secret would be that secret).
     web.py refuses a token in POST /api/config. */
  async function applyToken(action) {
    const cur = (($("authCurToken") || {}).value || "").trim();
    const next = (($("authNewToken") || {}).value || "").trim();
    if (tokenSet && !cur) {
      flashNote(T("Type the current token first — changing it is proof of holding it."), false);
      $("authCurToken").focus();
      return;
    }
    if (action === "set" && !next) {
      flashNote(T("Enter or generate the new token first."), false);
      $("authNewToken").focus();
      return;
    }
    if (action === "clear" && !confirm(T("Remove the access token?\n\nThe dashboard and DICOMweb stop asking for one. The engine refuses this while the dashboard is bound to anything other than this machine."))) return;
    const headers = { "Content-Type": "application/json", "X-Carino": "1" };
    // Sent once, for this request only.
    if (cur) headers["X-Carino-Token"] = cur;
    const btn = $("authApply");
    if (btn) btn.disabled = true;
    // Not through api(): a 401 here means the typed proof was wrong, not the session,
    // so the global 401 handler must not sign the dashboard out.
    let res, body = {};
    try {
      res = await fetch("/api/auth/token", {
        method: "POST", headers,
        body: JSON.stringify(action === "clear" ? { action: "clear" } : { action: "set", token: next }),
      });
      try { body = await res.json(); } catch (e) { /* empty */ }
    } catch (e) {
      flashNote(e.message, false);
      return;
    } finally {
      if (btn) btn.disabled = false;
    }
    if (!res.ok) {
      const a = body.auth || {};
      // Wrong proofs share the login failed-attempt budget, so a 429 says how long to wait.
      flashNote(res.status === 429
        ? TF("Too many failed attempts — try again in {n}s.", { n: a.retry_after || 30 })
        : (res.status === 401 || res.status === 403)
          ? T("That is not the current token — the change was refused.")
          : (body.error || body.message || res.statusText), false);
      return;
    }
    clearRotateFields(true);
    tokenSet = action !== "clear";
    authRequired = tokenSet;
    renderAuthState();
    if (!tokenSet) {
      flashNote(body.message || T("Token removed — this dashboard no longer asks for one."), true);
      pollStatus();
      return;
    }
    // All sessions (this one too) were signed with the old token; prompt now with an explanation.
    authed = false;
    stopPollers();
    showAuthGate();
    setAuthMsg(T("Token changed — sign in with the new one."), true);
  }

  async function saveConfig() {
    try {
      await post("/api/config", collectConfig());
      flashNote(T("Saved."), true);
      pollStatus();
      return true;
    } catch (e) { flashNote(e.message, false); return false; }
  }

  async function toggle(kind, btn) {
    const action = btn.dataset.on === "true" ? "stop" : "start";
    btn.disabled = true;
    try {
      // Persist current edits before starting so workers use them.
      if (action === "start") await post("/api/config", collectConfig()).catch(() => {});
      await post("/api/" + kind, { action });
    } catch (e) { flashNote(e.message, false); }
    finally { btn.disabled = false; pollStatus(); }
  }

  // ---- Drag & drop a folder onto the Receiver / Auto-send cards ----
  function droppedFolder(e) {
    // In the desktop app, File.path gives the real absolute path (browsers hide it).
    let isDir = true;
    const items = e.dataTransfer.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
      const entry = items[0].webkitGetAsEntry();
      if (entry) isDir = entry.isDirectory;
    }
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    return { path: f && f.path, isDir: isDir };
  }

  function wireDropZones() {
    // Stop the browser from navigating if a folder is dropped anywhere.
    ["dragover", "drop"].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));
    const zones = [
      { el: $("receiverCard"), input: "scpDir", label: "Storage" },
      { el: $("watcherCard"), input: "scuDir", label: "Watched" },
    ];
    zones.forEach((z) => {
      if (!z.el) return;
      z.el.addEventListener("dragover", (e) => { e.preventDefault(); z.el.classList.add("drop-active"); });
      z.el.addEventListener("dragleave", (e) => { if (!z.el.contains(e.relatedTarget)) z.el.classList.remove("drop-active"); });
      z.el.addEventListener("drop", async (e) => {
        e.preventDefault();
        z.el.classList.remove("drop-active");
        const info = droppedFolder(e);
        if (!info.path) { flashNote(T("Folder drop needs the desktop app (browsers hide the path)."), false); return; }
        if (info.isDir === false) { flashNote(T("Please drop a folder, not a file."), false); return; }
        $(z.input).value = info.path;
        await saveConfig();
        flashNote(TF("{label} folder → {path}", { label: T(z.label), path: info.path }), true);
      });
    });
  }

  // ---- Shut down the service ----
  async function killService() {
    if (!confirm(T("Shut down Carino DICOM?\n\nThe receiver and auto-send stop and the engine process exits."))) return;
    $("killSvc").disabled = true;
    post("/api/shutdown", {}).catch(() => {});   // process may exit before responding
    stopPollers();
    // Session ends: drop pending announcements/tones (the overlay covers a still-live DOM).
    dropSessionAlerts();
    setDot($("rxDot"), false);
    setDot($("wxDot"), false);
    const ov = document.createElement("div");
    ov.className = "stopped-overlay";
    const box = document.createElement("div");
    const h = document.createElement("h2");
    h.textContent = T("Carino DICOM has shut down");
    const p = document.createElement("p");
    p.textContent = T("The service stopped. You can close this window, or restart it from your terminal / the desktop app.");
    box.append(h, p);
    ov.appendChild(box);
    document.body.appendChild(ov);
  }

