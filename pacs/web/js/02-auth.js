/* Authentication: profiles, capability gating, the sign-in gate, login/logout and app start/stop. */
"use strict";
// ---- Authentication ----
// The shell is public; every /api route 401s until signed in. GET /api/auth (public) picks
// dashboard vs. prompt; POST /api/login swaps the token for an HttpOnly SameSite=Strict cookie
// so JS never holds it. The cookie dies with the process: a restart is a plain 401 and re-prompts.
let authRequired = false;      // the engine wants a credential at all
let authed = false;            // this browser is holding a good credential
let gateOpen = false;
let booted = false;            // has the dashboard ever been started in this page-load?
let retryTimer = null;         // rate-limit countdown

// ---- Profiles ----
// `me` comes from every /api/status. Its capabilities are a RENDERING HINT only: the server
// enforces each one, and hiding a button must never be the only thing preventing an action.
let me = null;                 // {id,name,role,admin,capabilities,phi_visible}
let profilesOn = false;        // the appliance runs with profiles at all
let pickList = [];             // the picker's rows, from GET /api/profiles
let picked = null;             // the profile chosen at the gate, awaiting a password
let gateMode = "token";        // token | pick | name | offline (engine unreachable: no fields, auto-retry)
let offlineTimer = null;       // the offline gate's next reconnect attempt

function can(cap) {
  // Without profiles, holding the credential means holding every capability.
  if (!profilesOn) return true;
  if (!me) return false;
  return me.admin === true || (me.capabilities || []).indexOf(cap) >= 0;
}

/* Nav follows each element's data-cap: a space-separated OR-list (no data-cap = always shown).
   A panel row shows if ANY matches; its tabs are then gated individually, or a Radiologist
   (routing.read) would reach the Settings tab with shutdown and the API token. */
// data-cap is an OR-list; data-cap-all an AND-list, for actions the engine checks twice.
function capAllowed(el) {
  const cap = (el.dataset.cap || "").trim();
  const all = (el.dataset.capAll || "").trim();
  if (cap && !cap.split(/\s+/).some((c) => can(c))) return false;
  if (all && !all.split(/\s+/).every((c) => can(c))) return false;
  return true;                                 // common ground when neither is set
}
function applyCapabilities() {
  document.querySelectorAll(".navbtn").forEach((b) => { b.hidden = !capAllowed(b); });
  // Dev peer also needs the --dev-peer launch flag. It must be applied here, after the loop
  // above resets `hidden`, or a permission change would re-show the row.
  const dp = document.querySelector('.navbtn[data-panel="dlgDevPeer"]');
  if (dp) dp.hidden = dp.hidden || !devPeerAvailable;
  // Badges lead to a tab, so they follow the tab's capability, not the row's.
  document.querySelectorAll(".navrow .badge[data-panel]").forEach((b) => {
    b.dataset.forbidden = capAllowed(b) ? "" : "1";
  });
  // Overview tiles/ticker pointing at forbidden panels become inert readouts, not dead clicks.
  document.querySelectorAll("#dlgOverview [data-panel]").forEach((t) => {
    t.classList.toggle("ov-inert", !capAllowed(t));
  });
  // The first-run chooser sits on the ungated Overview; only services.control may open it.
  const ovSetup = $("ovSetupOpen");
  if (ovSetup) ovSetup.hidden = !can("services.control");
  // Permissions may have narrowed mid-session: repair tab strips, then leave a now-forbidden panel.
  normalizeTabs();
  const activeBtn = document.querySelector('.navbtn[data-panel="' + activePanel + '"]');
  if (activeBtn && activeBtn.hidden) showPanel(firstAllowedPanel());
  const whoEl = $("whoami");
  if (whoEl) {
    whoEl.hidden = !profilesOn || !me;
    if (me) {
      // The token's identity is the engine's English ("API token · service"); a person's name and role
      // are what an administrator typed, and stay as typed.
      whoEl.textContent = me.service ? T("Access token") : me.name + (me.role ? " · " + me.role : "");
      whoEl.title = me.service
        ? T("Signed in with the access token, which acts as an administrator.")
        : TF("Signed in as {name}", { name: me.name });
    }
  }
  // Sign out only when there is a credential; otherwise it would show a gate nobody can satisfy.
  const out = $("signOut");
  if (out) out.hidden = !authRequired;
  // The header chips stay visible for everyone and lose only their click.
  chipAuthority();
  // Write controls (Save, Add, Shut down, audit export...) carry data-cap + .cap-btn: hidden, not
  // dead, without the capability. The server still refuses; this only stops offering a 403.
  // data-cap-all is an AND-list, for writes the engine checks twice (config.write + routing.write).
  document.querySelectorAll(".cap-btn").forEach((b) => {
    const all = (b.dataset.capAll || "").trim();
    b.hidden = !capAllowed(b) || (!!all && !all.split(/\s+/).every((c) => can(c)));
  });
}

function setAuthMsg(msg, isNote) {
  const el = $("authMsg");
  if (!el) return;
  el.textContent = msg || "";
  el.hidden = !msg;
  el.classList.toggle("note", !!isNote);
}

/* Gate modes: pick (profiles listed as buttons), name (profiles, unlisted: type name + password),
   token (no profiles). The token field stays reachable in every mode as the lock-out recovery path. */
function setGateMode(mode) {
  gateMode = mode;
  const pick = mode === "pick";
  const name = mode === "name";
  const token = mode === "token";
  // Unreachable is not a credential problem: no fields to fill, just a reconnect in progress.
  const offline = mode === "offline";
  show($("authPickWrap"), pick);
  show($("authNameWrap"), name);
  show($("authTokenWrap"), token);
  show($("authAltWrap"), !token && !offline);
  show($("authHelp"), token);
  show($("authActions"), !offline);
  const title = $("authTitle");
  if (title) {
    title.textContent = offline ? T("Can't reach the PACS engine — retrying…")
                      : token ? T("This PACS needs its access token")
                              : T("Who is using this station?");
  }
  const lede = $("authLede");
  if (lede) {
    lede.textContent = offline
      ? T("This page connects by itself as soon as the engine answers. If it does not, check that the Carino DICOM service is running on the PACS machine and that this computer can reach it.")
      : token ? T("Nothing is shown until you sign in. The dashboard reads and writes patient studies, storage paths and the shutdown control, so it is not served to an unauthenticated browser.")
              : T("Pick your profile to sign in. What you can see and do here follows the profile you choose, and everything you do is recorded against it.");
  }
  if (offline) {
    setAuthMsg("", false);
    clearTimeout(offlineTimer);
    offlineTimer = setTimeout(() => { offlineTimer = null; if (gateOpen && gateMode === "offline") boot(); }, 3000);
  }
  if (pick) renderPicker();
  setGateInert(true);
  setTimeout(() => {
    const focusOn = token ? $("authToken") : (name ? $("authName") : (offline ? $("authTitle") : null));
    if (focusOn) focusOn.focus();
  }, 0);
}

/* A modal is only modal if what is behind it cannot be reached: the dashboard (and navbar) go inert
   while the gate is up, so Tab cannot wander into a panel the prompt is meant to cover. */
function setGateInert(on) {
  const wrap = document.querySelector("main.wrap");
  // Closing the gate must not free the dashboard while the emergency prompt is still up.
  const emg = $("emgPrompt");
  if (wrap) wrap.inert = !!on || !!(emg && !emg.hidden);
  const nav = $("carinoNav");
  if (nav) nav.inert = !!on;
}

function show(el, on) { if (el) el.hidden = !on; }

function renderPicker() {
  const wrap = $("authPeople");
  if (!wrap) return;
  wrap.textContent = "";
  pickList.forEach((p) => {
    const b = document.createElement("button");
    b.className = "person" + (picked && picked.id === p.id ? " chosen" : "");
    b.type = "button";
    const nm = document.createElement("b");
    nm.textContent = p.name;
    b.appendChild(nm);
    if (p.role) {
      const r = document.createElement("span");
      r.className = "person-role";
      r.textContent = p.role;
      b.appendChild(r);
    }
    // Padlock: shows before the click whether a password will be asked.
    const lock = document.createElement("span");
    lock.className = "person-lock";
    lock.textContent = p.locked ? "🔒" : "";
    lock.title = p.locked ? T("Needs a password") : T("No password");
    b.appendChild(lock);
    b.addEventListener("click", () => choosePerson(p));
    wrap.appendChild(b);
  });
}

function choosePerson(p) {
  picked = p;
  renderPicker();
  show($("authPwWrap"), !!p.locked);
  const nameEl = $("authPwName");
  if (nameEl) nameEl.textContent = p.name;
  setAuthMsg("", false);
  if (p.locked) {
    const pw = $("authPassword");
    if (pw) { pw.value = ""; pw.focus(); }
  } else {
    // An open profile signs in on the click itself.
    doLogin($("authLogin"));
  }
}

async function loadPicker() {
  try {
    const r = await api("/api/profiles");
    profilesOn = !!r.enabled;
    pickList = r.profiles || [];
    if (!r.enabled) return "token";
    return r.listed ? "pick" : "name";
  } catch (e) {
    // The picker is public: no answer at all means the engine is unreachable, which no token fixes.
    // No answer, or a proxy saying the engine behind it is down: that is not a token problem.
    return (!e.status || e.status === 502 || e.status === 503 || e.status === 504) ? "offline" : "token";
  }
}

function showAuthGate() {
  const gate = $("authGate");
  if (!gate) return;
  gateOpen = true;
  // Undelivered session alerts are stale once the prompt is up (see dropSessionAlerts).
  dropSessionAlerts();
  gate.hidden = false;
  picked = null;
  show($("authPwWrap"), false);
  loadPicker().then(setGateMode);
}

function hideAuthGate() {
  const gate = $("authGate");
  gateOpen = false;
  if (gate) gate.hidden = true;
  setGateInert(false);
  clearTimeout(offlineTimer);
  offlineTimer = null;
  setAuthMsg("", false);
  clearInterval(retryTimer);
  retryTimer = null;
  const btn = $("authLogin");
  if (btn) btn.disabled = false;
}

// One 401 ends the session for every in-flight request: collapse them into a single prompt.
function onAuthRejected(a) {
  const wasAuthed = authed;
  authRequired = true;
  authed = false;
  stopPollers();
  showAuthGate();
  if (a.reason === "rate_limited") { startRetryCountdown(a.retry_after); return; }
  if (a.reason === "expired") {
    setAuthMsg(T("Your session has expired — sign in again."), true);
  } else if (wasAuthed) {
    // A restart discards the session secret, so a good cookie reads "invalid": don't say the token is wrong.
    // Worded for both gate modes: it may be showing the profile picker, not the token field.
    setAuthMsg(T("This browser is no longer signed in — the service was probably restarted. Sign in again."), true);
  }
}

// 429 carries the wait; showing it stops the operator hammering the button and extending the block.
function startRetryCountdown(secs) {
  let n = Math.max(0, parseInt(secs, 10) || 0);
  const btn = $("authLogin");
  clearInterval(retryTimer);
  retryTimer = null;
  if (!n) { if (btn) btn.disabled = false; return; }
  if (btn) btn.disabled = true;
  const tick = () => {
    if (n <= 0) {
      clearInterval(retryTimer);
      retryTimer = null;
      if (btn) btn.disabled = false;
      setAuthMsg(T("You can try again now."), true);
      return;
    }
    setAuthMsg(TF("Too many failed attempts — try again in {n}s.", { n }), false);
    n -= 1;
  };
  tick();
  retryTimer = setInterval(tick, 1000);
}

// POST /api/login body for the current gate mode, or null after telling the operator what is missing.
function loginBody() {
  if (gateMode === "pick") {
    if (!picked) { setAuthMsg(T("Choose your profile to continue."), true); return null; }
    const pw = $("authPassword");
    const value = (pw && pw.value) || "";
    if (picked.locked && !value) {
      setAuthMsg(T("Enter your password to continue."), true);
      if (pw) pw.focus();
      return null;
    }
    // No password key at all for an open profile: the server refuses a password (even "") offered to one.
    return picked.locked ? { profile: picked.id, password: value }
                         : { profile: picked.id };
  }
  if (gateMode === "name") {
    const nameEl = $("authName");
    const pwEl = $("authName2");
    const name = ((nameEl && nameEl.value) || "").trim();
    if (!name) { setAuthMsg(T("Enter your name to continue."), true); if (nameEl) nameEl.focus(); return null; }
    // Resolve the name to an id if listed; otherwise send it as typed and let the server decide.
    const match = pickList.filter((p) => p.name.toLowerCase() === name.toLowerCase())[0];
    return { profile: match ? match.id : name, password: (pwEl && pwEl.value) || "" };
  }
  const input = $("authToken");
  const token = ((input && input.value) || "").trim();
  if (!token) { setAuthMsg(T("Enter the token to continue."), true); if (input) input.focus(); return null; }
  return { token };
}

function clearGateInputs() {
  // Nothing typed at the gate is kept once the cookie exists.
  ["authToken", "authPassword", "authName2"].forEach((id) => {
    const el = $(id);
    if (el) el.value = "";
  });
}

async function doLogin(btn) {
  const body = loginBody();
  if (!body) return;
  if (btn) btn.disabled = true;
  setAuthMsg(T("Checking…"), true);
  try {
    const r = await post("/api/login", body);
    clearGateInputs();
    authed = true;
    const a = (r && r.auth) || {};
    profilesOn = !!a.profiles;
    me = a.who || null;
    applyCapabilities();
    hideAuthGate();
    await startApp();
  } catch (e) {
    const a = e.auth || {};
    if (a.reason === "rate_limited") startRetryCountdown(a.retry_after);
    else if (e.status === 403) setAuthMsg(T("The sign-in request was rejected as cross-site — reload the page and try again."), false);
    else if (e.status === 401) {
      setAuthMsg(gateMode === "token" ? T("That token is not correct.")
                                      : T("That name or password is not correct."), false);
      const pw = $(gateMode === "pick" ? "authPassword" : "authName2");
      if (pw) { pw.value = ""; pw.focus(); }
    } else if (!e.status || e.status === 502 || e.status === 503 || e.status === 504) setGateMode("offline");
    else setAuthMsg(e.message, false);
  } finally {
    if (!retryTimer && btn) btn.disabled = false;
  }
}

async function doLogout() {
  // Prompt even if the request fails, rather than leave a half-signed-out dashboard polling.
  try { await post("/api/logout", {}); } catch (e) { /* prompt anyway */ }
  authed = false;
  me = null;
  stopPollers();
  showAuthGate();
  setAuthMsg(T("Signed out."), true);
}

function startPollers() {
  if (!statusTimer) statusTimer = setInterval(pollStatus, 2000);
  if (!logTimer) logTimer = setInterval(pollLog, 1500);
}
function stopPollers() {
  if (statusTimer) clearInterval(statusTimer);
  if (logTimer) clearInterval(logTimer);
  statusTimer = null;
  logTimer = null;
  // Retire in-flight status responses too: bump the request counter and the rendered
  // watermark pollStatus() tests, so a late reply cannot paint over the prompt or shutdown overlay.
  statusReq += 1;
  statusSeen = statusReq;
}

// Everything that must wait for a credential.
async function startApp() {
  if (gateOpen) return;
  paintBeepBtn();        // the button ships with no label; it must never be blank
  // Modality codes are a constant, so fill now: reception (no config.read) needs the closed list.
  // Both targeting lists are rebuilt once the station registry arrives.
  fillModalityChoices();
  await loadConfig().catch((e) => flashNote(TF("Load failed: {err}", { err: e.message }), false));
  if (!booted) {
    booted = true;
    openInitialPanel();
  } else {
    // Back from a 401: refresh the pane the operator was on (runActiveLoader covers panels without a loader).
    runActiveLoader();
  }
  pollStatus();
  pollLog();
  startPollers();
}

// Show the Manual link only if a HEAD on the (public) manual/ route succeeds; builds without docs hide it.
async function probeManual() {
  const link = $("manualLink");
  if (!link) return;
  try {
    const res = await fetch("manual/", { method: "HEAD" });
    link.hidden = !res.ok;
  } catch (e) {
    link.hidden = true;
  }
}

async function boot() {
  probeManual();          // not awaited: the dashboard must not wait on a doc link
  let st;
  try {
    st = await api("/api/auth");
  } catch (e) {
    // /api/auth is public, so failure means unreachable, not unauthorised: the gate opens in its
    // offline state (loadPicker fails the same way) and keeps retrying by itself.
    if (gateOpen && gateMode === "offline") { setGateMode("offline"); return; }
    showAuthGate();
    return;
  }
  const a = st.auth || {};
  authRequired = !!a.required;
  authed = !!a.authenticated;
  profilesOn = !!a.profiles;
  me = a.who || null;
  applyCapabilities();
  if (authRequired && !authed) { showAuthGate(); return; }
  hideAuthGate();
  await startApp();
}

