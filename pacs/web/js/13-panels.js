/* Sidebar workspace: panels, tab strips, loaders and showPanel/selectTab. */
"use strict";
  // Each panel renders inline in the viewport-bound workspace and scrolls its own content.
  // Overview leads the nav, but Services is the landing panel: an unattended screen must not show patient names.
  // dlgDevPeer is not in LANDING_ORDER: a bench tool is never a landing panel, and the hidden-nav
  // refusal in showPanel also blocks a #devpeer deep link on builds without the flag.
  const PANELS = ["dlgOverview", "dlgServices", "dlgStudies", "dlgOrders", "dlgConfig", "dlgActivity",
                  "dlgDevPeer"];
  // Absorbed panels survive as PANE ids so old #dlgStuck-style bookmarks and id-scoped CSS still resolve.
  const PANEL_TABS = {
    dlgStudies:  { history: "dlgHistory", pending: "dlgPending", stuck: "dlgStuck" },
    dlgConfig:   { destinations: "dlgDests", routing: "dlgRouting", settings: "dlgSettings",
                   modalities: "dlgModalities", people: "dlgPeople" },
    dlgActivity: { logs: "dlgLogs", audit: "dlgAudit", caught: "dlgCaught" },
  };
  // Configuration opens on Destinations, not Settings (densest pane, holds the shutdown control).
  const DEFAULT_TAB = { dlgStudies: "history", dlgConfig: "destinations", dlgActivity: "logs" };
  // Last tab per panel; written only by selectTab.
  const activeTab = Object.assign({}, DEFAULT_TAB);

  // Panels without tabs. Keyed by panel id.
  const loaders = {
    dlgOrders: loadOrders,
    dlgDevPeer: loadDevPeer,
  };
  // Keyed by PANE id.
  const tabLoaders = {
    dlgHistory: loadHistory, dlgPending: loadPending, dlgStuck: loadStuck,
    // Rules arrive with the config; re-offer the current destination list.
    dlgRouting: refreshRuleDests,
    // No fetch: these readouts ride on the status poll, which skips them while the pane is shut.
    dlgSettings: () => {
      if (!lastStatus) return;
      renderIndex(lastStatus.index || {});
      renderDicomweb(lastStatus.dicomweb || {});
      renderDeidState(lastStatus.deid || {});
    },
    dlgPeople: loadPeople,
    dlgAudit: loadAudit,
    // No fetch: registry comes with the config; redraw in case another tab's Save rewrote it.
    dlgModalities: () => renderMods(loadedModalities),
    dlgCaught: loadCaught,
  };
  let activePanel = "dlgServices";

  /* Landing panel by explicit order, not DOM order: Studies lists every patient's name/ID/DOB and
     Overview prints a patient name, so neither leads. Orders is early for front-desk intake. */
  const LANDING_ORDER = ["dlgServices", "dlgOrders", "dlgStudies", "dlgActivity", "dlgConfig", "dlgOverview"];
  function firstAllowedPanel() {
    for (const id of LANDING_ORDER) {
      const b = document.querySelector('.navbtn[data-panel="' + id + '"]');
      if (b && !b.hidden) return id;
    }
    return "dlgOverview";
  }
  function tabStrip(panelId) {
    const p = $(panelId);
    return p ? p.querySelector(".panel-tabs") : null;
  }
  function tabButton(panelId, tabId) {
    const strip = tabStrip(panelId);
    return strip ? strip.querySelector('.hist-tab[data-tab="' + tabId + '"]') : null;
  }
  function firstAllowedTab(panelId) {
    const strip = tabStrip(panelId);
    const b = strip && strip.querySelector(".hist-tab[data-tab]:not([hidden])");
    return b ? b.dataset.tab : null;
  }

  /* opts.load:false lets applyCapabilities() repair strips in CLOSED panels without firing their
     loaders (most carry no can() guard); fetching belongs to opening a panel or clicking a tab. */
  function selectTab(panelId, tabId, opts) {
    const tabs = PANEL_TABS[panelId];
    if (!tabs) return;
    const load = !opts || opts.load !== false;
    // Refuse a forbidden tab like showPanel refuses a panel: every tab is a deep link
    // (e.g. #configuration/settings would expose the shutdown control).
    const wanted = tabButton(panelId, tabId);
    if (!wanted || wanted.hidden) tabId = firstAllowedTab(panelId);
    if (!tabId) return;                       // no tab in this panel is allowed
    activeTab[panelId] = tabId;
    const strip = tabStrip(panelId);
    if (strip) {
      strip.querySelectorAll(".hist-tab[data-tab]").forEach((b) => {
        const on = b.dataset.tab === tabId;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;             // roving tabindex: one stop per strip
      });
    }
    Object.entries(tabs).forEach(([tid, paneId]) => {
      const pane = $(paneId);
      if (pane) pane.hidden = tid !== tabId;
    });
    if (load) runActiveLoader();
  }

  // Repair every strip unconditionally (covers a forbidden active tab and a missing one). Silent: no loads, no hash write.
  function normalizeTabs() {
    Object.keys(PANEL_TABS).forEach((panelId) => {
      const strip = tabStrip(panelId);
      if (!strip) return;
      strip.querySelectorAll(".hist-tab[data-tab]").forEach((b) => { b.hidden = !capAllowed(b); });
      const current = tabButton(panelId, activeTab[panelId]);
      const want = (current && !current.hidden) ? activeTab[panelId] : firstAllowedTab(panelId);
      if (want) selectTab(panelId, want, { load: false });
      writeTabSub(panelId);
    });
  }
  // Subtitle under a merged panel's title, built from the VISIBLE tabs only.
  const TAB_SUB = { dlgStudies: "studiesSub", dlgConfig: "configSub", dlgActivity: "activitySub" };
  function writeTabSub(panelId) {
    const el = $(TAB_SUB[panelId]);
    const strip = tabStrip(panelId);
    if (!el || !strip) return;
    const names = [...strip.querySelectorAll(".hist-tab[data-tab]:not([hidden])")]
      .map((b) => (b.textContent || "").trim().toLowerCase());
    el.textContent = names.join(" · ");
  }

  /* Refresh what is on screen. Used after a 401 and a language switch (i18n.js's static pass
     leaves JS-rendered rows in the old language until this runs). */
  function runActiveLoader() {
    const tabs = PANEL_TABS[activePanel];
    if (tabs) {
      const paneId = tabs[activeTab[activePanel]];
      if (paneId && tabLoaders[paneId]) tabLoaders[paneId]();
      return;
    }
    if (loaders[activePanel]) loaders[activePanel]();
  }

  function showPanel(id, opts) {
    if (!PANELS.includes(id)) return;
    // A forbidden panel redirects to the first allowed one; the first-run chooser passes
    // allowForbidden because setup runs before any capabilities exist.
    const btn = document.querySelector('.navbtn[data-panel="' + id + '"]');
    if (btn && btn.hidden && !(opts && opts.allowForbidden)) id = firstAllowedPanel();
    activePanel = id;
    PANELS.forEach((pid) => { const p = $(pid); if (p) p.hidden = pid !== id; });
    document.querySelectorAll(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.panel === id));
    if (PANEL_TABS[id]) {
      // Reconcile before painting so the pane never disagrees with the strip.
      selectTab(id, (opts && opts.tab) || activeTab[id], { load: false });
    }
    runActiveLoader();
    // Overview is drawn by the status poll; repaint from the last one instead of blank for up to 2s.
    if (id === "dlgOverview" && lastStatus) renderOverview(lastStatus);
    if (!(opts && opts.silent)) writeHash();
  }
  // The first-run chooser reaches Services before capabilities mean anything.
  function showPanelInternal(id) { showPanel(id, { allowForbidden: true }); }

  // Every jump (nav rows, badges, Overview tiles, ticker, inline remedies) goes through here so
  // strip highlight and content never disagree.
  function goTo(panelId, tabId) {
    if (!PANELS.includes(panelId)) {
      // A pane id: translate through the legacy-hash table.
      const legacy = LEGACY_HASH[panelId];
      if (!legacy) return;
      panelId = legacy[0];
      tabId = tabId || legacy[1] || null;
    }
    if (tabId === "received" || tabId === "sent") {
      showPanel(panelId, { tab: "history", silent: true });
      setHistGroup(tabId);
      writeHash();
      return;
    }
    showPanel(panelId, { tab: tabId });
  }
  // The one writer of histGroup, so the strip and the list cannot disagree.
  function setHistGroup(group) {
    histGroup = group;
    document.querySelectorAll("#dlgHistory .hist-tab[data-group]").forEach((t) =>
      t.classList.toggle("active", t.dataset.group === group));
    loadHistory();
  }
  function reflowActive() { /* no-op: panels scroll internally now (kept for callers) */ }

