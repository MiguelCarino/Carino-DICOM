/* Wire-up on DOMContentLoaded, boot, and the address-bar (#panel/tab) router. */
"use strict";
// ---- Wire up ----
document.addEventListener("DOMContentLoaded", () => {
  mountServiceChips();      // navbar has self-injected by now (renderStatus re-tries if not)
  $("killSvc").addEventListener("click", killService);
  $("rxToggle").addEventListener("click", (e) => toggle("receiver", e.target));
  $("wxToggle").addEventListener("click", (e) => toggle("watcher", e.target));
  $("pxToggle").addEventListener("click", (e) => {
    // Starting from a card also sets its "start on launch" flag (toggle() saves config first).
    if (e.target.dataset.on !== "true") $("prnEnabled").checked = true;
    toggle("printer", e.target);
  });
  $("rsToggle").addEventListener("click", (e) => {
    if (e.target.dataset.on !== "true") $("risEnabled").checked = true;
    toggle("ris", e.target);
  });
  $("mwToggle").addEventListener("click", (e) => {
    if (e.target.dataset.on !== "true") $("mwlEnabled").checked = true;
    toggle("mwl", e.target);
  });
  $("qrToggle").addEventListener("click", (e) => {
    if (e.target.dataset.on !== "true") $("qrEnabled").checked = true;
    toggle("qr", e.target);
  });
  $("emgActivate").addEventListener("click", () => emergencyAction("activate"));
  $("emgDismiss").addEventListener("click", () => emergencyAction("dismiss"));
  $("addDest").addEventListener("click", () => addDestRow({ enabled: true }));
  $("saveCfg").addEventListener("click", () => saveConfig());
  $("saveDests").addEventListener("click", async () => {
    if (await saveConfig()) refreshRuleDests();   // a renamed node must show up in the rules
  });
  $("clearLog").addEventListener("click", () => { $("log").innerHTML = ""; });
  wireDropZones();

  // Sign-in gate. bind() tolerates missing elements, since some builds omit parts of the markup.
  const bind = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  $("authLogin").addEventListener("click", () => doLogin($("authLogin")));
  ["authToken", "authPassword", "authName", "authName2"].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin($("authLogin")); });
  });
  bind("authUseToken", "click", () => setGateMode("token"));
  bind("authPwBack", "click", () => {
    picked = null;
    show($("authPwWrap"), false);
    setAuthMsg("", false);
    renderPicker();
  });
  bind("signOut", "click", doLogout);

  // People.
  bind("peopleSeed", "click", async (e) => {
    if (!window.confirm(T("Turn on profiles? Everyone will sign in as themselves from now on, and this browser will be signed in as the Administrator. The access token keeps working."))) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await post("/api/profiles/seed", {});
      peopleState = Object.assign({}, peopleState, r);
      profilesOn = true;
      renderPeople();
      // The seed response set an admin session; the status poll reports who we now are.
      await pollStatus();
      flashNote(T("Profiles are on. You are signed in as Administrator."), true);
    } catch (err) {
      flashNote(err.message, false);
    } finally { btn.disabled = false; }
  });
  bind("peopleAdd", "click", () => {
    // New profiles start disabled with nothing granted, so a half-filled form is never a live account.
    peopleState.profiles = (peopleState.profiles || []).concat([{
      id: "", name: T("New profile"), role: "", enabled: false, admin: false,
      locked: false, email: "", capabilities: [], phi_visible: [],
    }]);
    renderPeople();
  });
  bind("peopleListing", "change", async (e) => {
    try {
      await post("/api/profiles/listing", { list_profiles: e.currentTarget.checked });
    } catch (err) {
      flashNote(err.message, false);
      e.currentTarget.checked = !e.currentTarget.checked;
    }
  });

  // Audit.
  bind("auditVerify", "click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api("/api/audit/verify");
      const v = r.verify || {};
      flashNote(v.ok
        ? TF("Intact — {n} records, every one matching its digest.", { n: v.records || 0 })
        : TF("BROKEN at record {n}: {why}", { n: v.broken_at || "?", why: v.reason || "" }),
        !!v.ok);
      renderAudit([], r.audit || {});
      loadAudit();
    } catch (err) { flashNote(err.message, false); }
    finally { btn.disabled = false; }
  });
  bind("auditExport", "click", () => {
    // Plain navigation: a file download, with the session cookie attached.
    window.location.href = "/api/audit/export";
  });
  $("authLogout").addEventListener("click", doLogout);
  $("authRotateBtn").addEventListener("click", openRotate);
  $("authRotateCancel").addEventListener("click", cancelRotate);
  $("authApply").addEventListener("click", () => applyToken("set"));
  $("authClearBtn").addEventListener("click", () => applyToken("clear"));
  $("authGen").addEventListener("click", () => {
    const tok = generateToken();
    if (!tok) { flashNote(T("This browser cannot generate a token — paste one instead."), false); return; }
    const f = $("authNewToken");
    f.value = tok;
    f.type = "text";                  // readable so it can be copied; shown only once
    flashNote(T("Copy the token now — it is not shown again once it is applied."), true);
  });
  $("authShow").addEventListener("click", () => {
    const f = $("authNewToken");
    f.type = f.type === "password" ? "text" : "password";
  });

  // Routing.
  $("rtAdd").addEventListener("click", addRule);
  $("rtSave").addEventListener("click", () => saveConfig());
  $("rtTest").addEventListener("click", () => testRoute($("rtTest")));
  $("idxRescanNow").addEventListener("click", () => rescanIndex($("idxRescanNow")));

  // Service chooser entry points (all optional markup).
  const setupOpen = $("setupOpen");
  if (setupOpen) setupOpen.addEventListener("click", enterSetup);
  const setupFromSettings = $("setupFromSettings");
  if (setupFromSettings) setupFromSettings.addEventListener("click", () => { showPanelInternal("dlgServices"); enterSetup(); });
  const ovSetupOpen = $("ovSetupOpen");
  if (ovSetupOpen) ovSetupOpen.addEventListener("click", () => { showPanelInternal("dlgServices"); enterSetup(); });
  const setupCancel = $("setupCancel");
  if (setupCancel) setupCancel.addEventListener("click", exitSetup);
  const setupApply = $("setupApply");
  if (setupApply) setupApply.addEventListener("click", () => applySetup(setupApply));
  document.querySelectorAll(".pick-box").forEach((b) =>
    b.addEventListener("change", () => {
      const card = b.closest(".card");
      if (card) card.classList.toggle("chosen", b.checked);
      updateSetupCount();
    }));
  // One delegated handler for every [data-panel] (+ optional data-tab) jump: nav, badges, tiles, remedies.
  document.addEventListener("click", (e) => {
    const j = e.target.closest("[data-panel]");
    if (!j || !j.dataset.panel) return;
    if (j.dataset.forbidden === "1" || j.classList.contains("ov-inert")) return;
    goTo(j.dataset.panel, j.dataset.tab || null);
  });

  // Panel tab strips only (.panel-tabs [data-tab]); Orders (data-ostatus) and History (data-group) differ.
  document.querySelectorAll(".panel-tabs .hist-tab[data-tab]").forEach((tab) =>
    tab.addEventListener("click", () => {
      const panel = tab.closest(".workpanel");
      if (panel) { selectTab(panel.id, tab.dataset.tab); writeHash(); }
    }));
  // Arrow keys move along a strip; selectTab owns the roving tabindex.
  document.querySelectorAll(".panel-tabs .hist-tabs").forEach((strip) =>
    strip.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      const tabs = [...strip.querySelectorAll(".hist-tab[data-tab]:not([hidden])")];
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const next = tabs[(i + step + tabs.length) % tabs.length];
      const panel = next.closest(".workpanel");
      if (panel) { selectTab(panel.id, next.dataset.tab); writeHash(); next.focus(); }
    }));

  // History Received/Sent, inside the Studies History pane.
  document.querySelectorAll("#dlgHistory .hist-tab[data-group]").forEach((tab) =>
    tab.addEventListener("click", () => {
      setHistGroup(tab.dataset.group);
    }));
  $("histRefresh").addEventListener("click", loadHistory);
  $("histDeleteAll").addEventListener("click", histDeleteAll);
  // RIS orders: Open/Closed sub-tabs + form + actions.
  document.querySelectorAll("#dlgOrders .hist-tab[data-ostatus]").forEach((tab) =>
    tab.addEventListener("click", () => selectOrderTab(tab.dataset.ostatus)));
  // Arrow keys here too: the generic handler skips this strip, and the roving tabindex
  // would otherwise leave the unselected tab unreachable by keyboard.
  const ordStrip = document.querySelector("#dlgOrders .hist-tabs");
  if (ordStrip) ordStrip.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    const tabs = [...ordStrip.querySelectorAll(".hist-tab[data-ostatus]")];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = tabs[(i + step + tabs.length) % tabs.length];
    selectOrderTab(next.dataset.ostatus);
    next.focus();
  });
  $("ordAdd").addEventListener("click", () => addOrder($("ordAdd")));
  $("ordTest").addEventListener("change", (e) => applyTestDefaults(e.target.checked));
  $("caughtRefresh").addEventListener("click", loadCaught);
  $("caughtClear").addEventListener("click", async () => {
    if (!confirm(T("Clear every probe round? They are a record of what the other RIS said."))) return;
    const r = await post("/api/worklist/caught/clear", {});
    flashNote(r.message || "", r.ok !== false);
    loadCaught();
  });
  $("addMod").addEventListener("click", () => { addModRow({}); const e = $("modEmpty"); if (e) e.hidden = true; });
  // Saves the whole config, so the server's validator judges the registry.
  $("saveMods").addEventListener("click", async () => {
    // The registry drives both order-form targeting lists.
    if (await saveConfig()) { loadedModalities = collectMods(); refreshTargetChoices(); }
  });
  // Arrival-beep mute toggle; unmuting arms the audio context on this same click.
  $("ordBeep").addEventListener("click", () => {
    // While it reads "Arm sound" the click is the user gesture autoplay needs, so it arms rather
    // than mutes, unless audio has already failed (then it falls through to the toggle).
    if (beepOn() && !audioReady() && !audioFailed) { armAudio(); return; }
    const on = !beepOn();
    setBeepOn(on);
    if (on) armAudio();
    paintBeepBtn();
  });
  // Picking a room prefills its registered modality, only into a blank field and only with an offered code.
  const ordStation = $("ordStationSel");
  if (ordStation) ordStation.addEventListener("change", () => {
    const mod = $("ordMod"), code = ordStation.selectedOptions[0] && ordStation.selectedOptions[0].dataset.modality;
    if (!mod || mod.value || !code) return;
    if ([...mod.options].some((o) => o.value === code)) mod.value = code;
  });
  $("ordRefresh").addEventListener("click", loadOrders);
  $("ordPurge").addEventListener("click", purgeClosedOrders);
  $("pendRefresh").addEventListener("click", loadPending);
  $("stuckRefresh").addEventListener("click", loadStuck);
  $("stuckRetryAll").addEventListener("click", () => retryStuck(null, $("stuckRetryAll")));
  // Dev peer nav needs no wiring (delegated [data-panel] handler).
  $("dpCreate").addEventListener("click", () => devPeerAction("create", $("dpCreate")));
  $("dpDiscard").addEventListener("click", () => devPeerAction("discard", $("dpDiscard")));

  // Language switch: i18n.js retranslates static markup; everything the dashboard rendered is redrawn here.
  window.addEventListener("carino:langchange", () => {
    relabelServiceChips();
    // Repaint the Overview ticker/lines now; i18n.js just reset them to placeholders.
    paintTicker();
    if (lastStatus) renderOverview(lastStatus);
    paintDesktopUpdate();
    retitleWatcherWarn();
    renderAuthState();
    // Label depends on mute state, so it is JS-written.
    paintBeepBtn();
    // Both targeting lists (selection preserved).
    refreshTargetChoices();
    // Subtitles are built from the (just retranslated) tab labels.
    Object.keys(PANEL_TABS).forEach(writeTabSub);
    // The static pass writes token-mode wording into the gate heading; re-apply the actual mode.
    if (gateOpen) setGateMode(gateMode);
    if (lastStatus) {
      renderIndex(lastStatus.index || {});
      renderDicomweb(lastStatus.dicomweb || {});
      renderDeidState(lastStatus.deid || {});
    }
    if (gateOpen) return;      // behind the prompt there is nothing to refetch
    pollStatus();
    // Rows the dashboard drew (history, stuck, orders, people, audit…) are redrawn by the active loader.
    runActiveLoader();
  });

  // popstate resolves Back; hashchange only covers hand-edited fragments (pushState fires neither).
  window.addEventListener("popstate", () => resolveHash(location.hash));
  window.addEventListener("hashchange", () => {
    if (location.hash === currentHash()) return;
    resolveHash(location.hash);
  });
  retitleWatcherWarn();
  // Independent of auth: reads nothing from the engine.
  initDesktopShell();
  // Auth first: GET /api/auth is public; every other /api route may 401.
  boot();
});

// ---- Address bar router ----
// One writer (writeHash, via silent pushState), one form: #panel or #panel/tab, using button words
// (readable over the phone). Legacy #dlgXxx ids still resolve for manuals and bookmarks.
const HASH_NAME = {
  dlgOverview: "overview", dlgServices: "services", dlgStudies: "studies",
  dlgOrders: "orders", dlgConfig: "configuration", dlgActivity: "activity",
  dlgDevPeer: "devpeer",
};
const PANEL_BY_HASH = {};
Object.entries(HASH_NAME).forEach(([id, name]) => { PANEL_BY_HASH[name] = id; });
// Absorbed panel ids map to their panel/tab (e.g. #dlgStuck -> Studies/stuck).
const LEGACY_HASH = { dlgOverview: ["dlgOverview"], dlgServices: ["dlgServices"], dlgOrders: ["dlgOrders"] };
Object.entries(PANEL_TABS).forEach(([panelId, tabs]) =>
  Object.entries(tabs).forEach(([tabId, paneId]) => { LEGACY_HASH[paneId] = [panelId, tabId]; }));
LEGACY_HASH.dlgStudies = ["dlgStudies"];
LEGACY_HASH.dlgConfig = ["dlgConfig"];
LEGACY_HASH.dlgActivity = ["dlgActivity"];

let routing = false;              // re-entrancy guard for the resolver
function currentHash() {
  if (activePanel === "dlgOverview") return location.hash;   // never persisted, see below
  const name = HASH_NAME[activePanel];
  if (!name) return location.hash;
  const tab = PANEL_TABS[activePanel] ? activeTab[activePanel] : null;
  return "#" + name + (tab ? "/" + tab : "");
}
// Overview is deep-linkable but never written to the hash: it shows a patient name and accession,
// and an unattended screen must not restore to it after a reload or kiosk recovery.
function writeHash() {
  if (routing) return;
  if (activePanel === "dlgOverview") return;
  const want = currentHash();
  if (!want || want === location.hash) return;
  try { history.pushState(null, "", want); } catch (e) { /* file:// and friends */ }
}
function resolveHash(hash) {
  const raw = (hash || "").replace(/^#/, "");
  if (!raw) return false;
  if (raw === "setup") { showPanelInternal("dlgServices"); enterSetup(); return true; }
  const [head, tail] = raw.split("/");
  let panelId = PANEL_BY_HASH[head];
  let tabId = tail || null;
  if (!panelId && LEGACY_HASH[head]) { panelId = LEGACY_HASH[head][0]; tabId = LEGACY_HASH[head][1] || null; }
  if (!panelId) return false;
  routing = true;                 // the resolver reads the URL; it must not rewrite it
  try { showPanel(panelId, { tab: tabId, silent: true }); } finally { routing = false; }
  return true;
}
// Once, at dashboard start. An unrecognised fragment is left alone (another owner may need it).
function openInitialPanel() {
  if (resolveHash(location.hash)) return;
  showPanel(firstAllowedPanel(), { silent: !!location.hash });
}
