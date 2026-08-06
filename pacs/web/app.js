/* Carino PACS dashboard front-end — vanilla JS over the REST API. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /* Card values that can never be shortened — AE titles, bind:port, paths — are
     rendered by CSS as .atomic (nowrap + ellipsis) or .path. The ellipsis hides
     the tail, so mirror the value into title= and nothing is ever unrecoverable. */
  const dash = (v) => (v == null || v === "" ? "—" : v);
  function setAtomic(id, value) { const el = $(id); if (!el) return; el.textContent = dash(value); el.title = dash(value); }
  function setPath(id, p) { const el = $(id); if (!el) return; el.textContent = dash(p); el.title = dash(p); }

  /* ── i18n ────────────────────────────────────────────────────────
     Dictionaries and the [data-i18n] markup pass live in i18n.js, which is
     deferred and loaded before this file. Everything below is rendered by JS,
     so it is wrapped at render time instead:
       T(s)            plain string
       TF(s, vals)     string with {named} placeholders — keeps word order
                       translatable rather than concatenating fragments
       TN(n, s)        count-aware string ({n} placeholder); the dictionary
                       supplies the plural forms, which matters for Russian
       I18N_IN(root)   translate a <template> clone (template content is inert
                       to document.querySelectorAll, so i18n.js never sees it)
     All four fall back to the English literal when no dictionary is loaded, so
     the dashboard still works if i18n.js is missing. Messages sent by the
     engine (r.message) stay in the server's language on purpose. */
  const T = (s) => (window.t || String)(s);
  const TF = (s, vals) => T(s).replace(/\{(\w+)\}/g, (m, k) => (vals && vals[k] != null ? vals[k] : m));
  const TN = (n, s) => (window.tn ? window.tn(n, s) : String(s).replace(/\{n\}/g, n));
  const I18N_IN = (root) => { if (window.applyI18nIn) window.applyI18nIn(root); return root; };

  const api = async (url, opts) => {
    const res = await fetch(url, opts);
    let body = {};
    try { body = await res.json(); } catch (e) { /* empty */ }
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  };
  const post = (url, data) =>
    api(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Carino": "1" }, body: JSON.stringify(data || {}) });

  // Full loaded config sections — kept so a Save preserves any key that has no
  // form input (min_free_gb, pending_dir, …); apply_config merges over DEFAULTS,
  // so an omitted key would otherwise silently reset.
  let loadedScp = {}, loadedScu = {}, loadedPrint = {}, loadedRis = {}, loadedMwl = {}, loadedEmg = {};
  let loadedWeb = { host: "127.0.0.1", port: 8042 };
  // The onboarding stamp has no form input at all, and it is TOP-LEVEL: without
  // carrying it through a Save, apply_config's merge over DEFAULTS would reset it
  // to "" and the chooser would be offered again after every Settings save.
  let loadedSetup = "";
  let loadedLogsDir = "";   // no form field; cfg.replace merges over DEFAULTS, so a Save would reset it
  let statusTimer = null, logTimer = null;
  let editorUrl = "";                                // DICOM-editor base URL (from status); "" hides ✎ Edit
  let lastStatus = null;                             // newest /api/status, for the panels that render on demand

  /* ── Status polling ──────────────────────────────────────────── */
  function renderStatus(s) {
    const rx = s.receiver, wx = s.watcher, px = s.printer || {}, rs = s.ris || {}, mw = s.mwl || {};
    lastStatus = s;
    mountServiceChips();      // self-heals if the navbar mounted after us

    // This machine's network identity (what remote nodes send to).
    const ni = $("netInfo");
    if (ni) {
      ni.textContent = "";
      // Compact, since this now lives in the top navbar. First IP + count, and
      // the receiver AE:port (what a modality connects to).
      const ips = (s.host_ips && s.host_ips.length) ? s.host_ips : (s.host_ip ? [s.host_ip] : []);
      if (ips.length) {
        ni.classList.remove("offline");
        const v = (t) => { const el = document.createElement("span"); el.className = "v"; el.textContent = t; return el; };
        ni.append(v(ips[0]));
        if (ips.length > 1) ni.append(" +" + (ips.length - 1));
        ni.append(" · ", v(rx.aet + ":" + rx.port));
      } else {
        ni.classList.add("offline");
        ni.textContent = T("offline");
      }
    }

    editorUrl = (s.editor_url || "").trim();

    // Pending-imports badge on the 📎 button.
    const badge = $("pendingBadge");
    if (badge) {
      const n = s.pending || 0;
      badge.textContent = String(n);
      badge.hidden = n === 0;
    }

    // Stuck-sends badge on the ⚠ button.
    const sBadge = $("stuckBadge");
    if (sBadge) {
      const n = s.stuck || 0;
      sBadge.textContent = String(n);
      sBadge.hidden = n === 0;
    }

    // Open-orders badge on the 📋 button.
    const oBadge = $("ordersBadge");
    if (oBadge) {
      const n = (rs.counts && rs.counts.open) || 0;
      oBadge.textContent = String(n);
      oBadge.hidden = n === 0;
    }

    // Low-disk warning banner (only when the storage volume is below the floor).
    const dw = $("diskWarn");
    if (dw) {
      const d = s.disk || {};
      if (d.low) {
        dw.hidden = false;
        dw.textContent = TF(
          "⚠ Low disk space — {free} free (below the {floor} GB floor). New incoming studies will be refused until space is freed.",
          { free: (d.free_gb != null ? d.free_gb + " GB" : "?"), floor: d.floor_gb });
      } else {
        dw.hidden = true;
      }
    }

    setDot($("rxDot"), rx.running);
    setAtomic("rxAet", rx.aet);
    setAtomic("rxAddr", `${rx.bind}:${rx.port}`);
    setPath("rxDir", rx.storage_dir);
    $("rxCount").textContent = rx.received;
    $("rxErr").textContent = rx.errors;
    $("rxTls").textContent = rx.tls ? (rx.tls_mutual ? T("mTLS") : "TLS") : T("plaintext");
    setToggle($("rxToggle"), rx.running);
    setChip("rx", rx.running);

    setDot($("wxDot"), wx.running);
    setPath("wxDir", wx.watch_dir);
    setAtomic("wxAet", wx.aet);
    $("wxMode").textContent = T(wx.on_success);
    $("wxSent").textContent = wx.sent;
    $("wxFailed").textContent = wx.failed;
    $("wxLast").textContent = wx.last_activity || "—";
    setToggle($("wxToggle"), wx.running);
    setChip("wx", wx.running);

    setDot($("pxDot"), px.running);
    setAtomic("pxAet", px.aet || "—");
    setAtomic("pxAddr", `${px.bind || "0.0.0.0"}:${px.port}`);
    $("pxMode").textContent = (px.color ? T("gray + color") : T("grayscale")) +
      " · " + (px.layout === "image" ? T("→ SC") : T("→ PDF"));
    $("pxCount").textContent = px.printed || 0;
    $("pxErr").textContent = px.errors || 0;
    $("pxTls").textContent = px.tls ? "TLS" : T("plaintext");
    setToggle($("pxToggle"), px.running);
    setChip("px", px.running);

    setDot($("rsDot"), rs.running);
    setAtomic("rsAddr", `${rs.bind || "0.0.0.0"}:${rs.port || "—"}`);
    $("rsMatch").textContent = rs.match_on === "accession_or_patient" ? T("accession / patient ID") : T("accession");
    $("rsOpen").textContent = (rs.counts && rs.counts.open) || 0;
    $("rsRecv").textContent = rs.received || 0;
    $("rsErr").textContent = rs.errors || 0;
    setToggle($("rsToggle"), rs.running);
    setChip("rs", rs.running);

    setDot($("mwDot"), mw.running);
    setAtomic("mwAet", mw.aet || "—");
    setAtomic("mwAddr", `${mw.bind || "0.0.0.0"}:${mw.port || "—"}`);
    $("mwQueries").textContent = mw.queries || 0;
    $("mwMatches").textContent = mw.matches || 0;
    $("mwTls").textContent = mw.tls ? "TLS" : T("plaintext");
    setToggle($("mwToggle"), mw.running);
    setChip("mw", mw.running);

    renderEmergency(s.emergency || {}, rs, mw);

    // Enrolled and running are two different facts. The border says "this PC is
    // supposed to run it" (the persisted flag), the dot says "the socket is bound
    // right now" — so a service that was enrolled but never came up is visible
    // instead of looking like one that was simply never asked for.
    setCardState("receiverCard", rx.enabled, rx.running);
    setCardState("watcherCard", wx.enabled, wx.running);
    setCardState("printerCard", px.enabled, px.running);
    setCardState("risCard", rs.enabled, rs.running);
    // The worklist has a second enrolment axis: a destination flagged no_ris
    // makes it permanent whatever the flag says (sync_services drives it from
    // worklist_wanted()). Painting the border from mwl.enabled alone left the
    // operator who unticked it looking at a running service with no highlight
    // and nothing anywhere saying why.
    setCardState("mwlCard", mw.enabled || mw.wanted, mw.running);

    if (setupActive) {
      // Entered before the first status landed (boot #setup): seed now.
      if (!setupSeeded) seedSetup(s);
    } else if (!setupDismissed && s.setup && s.setup.needed) {
      // Door 1 — nothing has ever been chosen on this machine.
      showPanel("dlgServices");
      enterSetup();
    }

    renderOverview(s);
  }

  /* ── Emergency failover: banner, activation pop-up, card visibility ──── */
  let emgPromptShown = false;
  function renderEmergency(emg, rs, mw) {
    // The Worklist + Emergency-RIS cards are advanced/emergency services — keep
    // them off the normal dashboard unless they're running, enrolled or failover
    // is armed. Enrolled counts: a service that is meant to run but did not come
    // up must be visible, or its warning has nowhere to appear.
    const rsCard = $("risCard"), mwCard = $("mwlCard");
    // The chooser needs all five cards regardless, so setupActive forces both
    // visible below. It clears the ATTRIBUTE rather than leaning on the CSS
    // un-hide: hidden is what a screen reader and every el.hidden test read, and
    // RIS and Worklist are exactly the two services a first-time operator has
    // never seen. The next poll after exitSetup() restores the normal rule.
    const rsShow = !!((rs && (rs.running || rs.enabled)) || emg.armed || setupActive);
    // Worklist card shows when running, enrolled, armed, or a no_ris destination makes it permanent.
    const mwShow = !!((mw && (mw.running || mw.enabled || mw.wanted)) || emg.armed || setupActive);
    if (rsCard) rsCard.hidden = !rsShow;
    if (mwCard) mwCard.hidden = !mwShow;
    // Keep the navbar chips for these advanced services in step with their cards.
    showChip("rs", rsShow);
    showChip("mw", mwShow);

    const banner = $("emgBanner");
    const state = emg.state || "off";
    const who = emg.trigger_dest || "primary";
    if (state === "triggered" || state === "active" || state === "recovering") {
      banner.hidden = false;
      banner.className = "emg-banner " + state;
      let text, actions;
      if (state === "active") {
        text = TF("🚨 EMERGENCY ACTIVE — '{who}' unreachable. Worklist is serving; received studies are held for forward.", { who });
        actions = [[T("Resume normal"), "resume", "btn"]];
      } else if (state === "recovering") {
        text = TF("↩ '{who}' is back — flushing held studies to it. Click Resume when done.", { who });
        actions = [[T("Resume normal"), "resume", "btn"]];
      } else {  // triggered (prompt may be dismissed)
        text = TF("⚠ Primary '{who}' is unreachable — emergency RIS not activated.", { who });
        actions = [[T("Activate"), "activate", "btn"], [T("Disarm"), "disarm", "btn ghost"]];
      }
      $("emgBannerText").textContent = text;
      const wrap = $("emgBannerActions");
      wrap.innerHTML = "";
      actions.forEach(([label, action, cls]) => {
        const b = document.createElement("button");
        b.className = cls + " tiny";
        b.textContent = label;
        b.addEventListener("click", () => emergencyAction(action));
        wrap.appendChild(b);
      });
    } else {
      banner.hidden = true;
    }

    // The activation pop-up — only while triggered and not dismissed.
    const prompt = $("emgPrompt");
    if (emg.prompt) {
      if (!emgPromptShown) {
        $("emgPromptMsg").textContent =
          TF("The primary PACS '{who}' has been unreachable past the failover threshold.", { who });
        prompt.hidden = false;
        emgPromptShown = true;
      }
    } else {
      prompt.hidden = true;
      emgPromptShown = false;
    }
  }

  async function emergencyAction(action) {
    try {
      const r = await post("/api/emergency", { action });
      flashNote(r.message || TF("Emergency: {action}", { action }), r.ok !== false);
      $("emgPrompt").hidden = true;
      emgPromptShown = false;
      pollStatus();
    } catch (e) { flashNote(e.message, false); }
  }
  function setToggle(btn, on) {
    btn.dataset.on = String(on);
    btn.textContent = on ? T("Stop") : T("Start");
  }
  function setDot(el, on) {
    el.classList.toggle("on", on);
    el.classList.toggle("off", !on);
  }

  /* ── Service chooser: #dlgServices wearing its "setup" state ─────
     Not a second screen — the same five cards, plus a checkbox each, switched by
     one class. Which services this PC runs is a persisted decision (scp.enabled,
     scu.enabled, print.enabled, ris.enabled, mwl.enabled); the chooser writes all
     five in ONE post because apply_config() stops and restarts the receiver on
     every save, so doing it a service at a time would take the receiver down five
     times over. Selection stays local until Apply for the same reason. */
  const SETUP_CARDS = [
    { svc: "receiver", card: "receiverCard", pick: "pickRx", port: "portRx", label: "Receiver",       block: "receiver" },
    { svc: "watcher",  card: "watcherCard",  pick: "pickWx", port: "",       label: "Auto-send",      block: "watcher" },
    { svc: "printer",  card: "printerCard",  pick: "pickPx", port: "portPx", label: "Print receiver", block: "printer" },
    { svc: "ris",      card: "risCard",      pick: "pickRs", port: "portRs", label: "Emergency RIS",  block: "ris" },
    { svc: "mwl",      card: "mwlCard",      pick: "pickMw", port: "portMw", label: "Worklist",       block: "mwl" },
  ];
  // setupDismissed is deliberately in memory only: "Not now" must silence the 2s
  // poll for this page-load, but a reload should offer the chooser again while
  // the machine still has no services chosen.
  let setupActive = false, setupSeeded = false, setupDismissed = false;
  const labelFor = (svc) => (SETUP_CARDS.find((c) => c.svc === svc) || {}).label || svc;

  function setCardState(id, enabled, running) {
    const card = $(id);
    if (!card) return;
    // While the chooser is open the checkbox owns the highlight — otherwise the
    // 2s poll would paint over a tick the operator made half a second ago.
    if (!setupActive) card.classList.toggle("chosen", !!enabled);
    card.classList.toggle("stalled", !!enabled && !running);
  }

  // The five cards share one .card-warn, and it tells the operator to check the
  // port — but the watcher binds no port at all (that is why its card has no
  // .card-port), so on that one card the only instruction it gives is impossible
  // to follow and points away from the real causes, a missing watched folder or
  // a thread that never started. Dropping the clause leaves exactly the sentence
  // the Overview boxes already use, so it costs no extra string. It is retitled
  // from JS rather than in the markup because the language pass keys on the
  // element's own text and would put the shared sentence back on every switch.
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
    // Un-hide the two advanced cards for real, now rather than on the next poll —
    // renderEmergency() keeps them shown while setupActive, and restores the
    // normal rule after exitSetup().
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

  // Seed the boxes from the persisted flags ONCE per chooser session; after that
  // the operator owns them until Apply or Cancel.
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
    // Zero is a legitimate choice (it stops everything and still records that the
    // question was answered), so it gets a sentence rather than a blocked button.
    el.textContent = n ? TN(n, "{n} selected") : T("Nothing selected — this PC will not receive or send anything.");
  }

  // validate() proves the ports are distinct and in range, never that they are
  // free — so until now the only way to learn 11112 was taken was to start the
  // receiver and read the log. Fired once on entering the chooser, not polled.
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
      // No answer is rendered as no answer — never as a guess about the port.
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
      // Three different facts, three different sentences. "mine" is not "free" —
      // check_ports skipped the bind because this process already holds the
      // port — and only an address-in-use errno (98 Linux, 48 BSD/macOS, 10048
      // Windows) is the clash the friendly sentence describes. "port must be
      // 1..65535" is an answer about the configuration and EACCES on 104 is an
      // answer about privileges; both are shown in the engine's own words, like
      // every other engine message, rather than recast as a clash on this PC.
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
      // The server has just rewritten all five enabled flags and the onboarding
      // stamp, but this file's snapshot of the config still predates the chooser
      // — and EVERY later POST /api/config re-asserts that snapshot verbatim
      // (collectConfig() spreads loadedScp/loadedScu, reads #prnEnabled /
      // #risEnabled / #mwlEnabled, and carries loadedSetup). A Settings Save or
      // any card's Start would therefore undo the whole enrolment and re-offer
      // the chooser forever. Re-read the config instead of hand-assigning the
      // six fields the chooser touched: hand-assignment is what created this
      // class of bug, and a seventh field would silently reintroduce it. The
      // cost is that unsaved Settings edits are replaced by what was persisted,
      // which is the correct direction to be wrong in — the server's config is
      // the thing the next Save has to be built on.
      let resyncErr = null;
      await loadConfig().catch((e) => { resyncErr = e; });
      flashNote(TN(n, "{n} services enabled"), true);
      // A service that failed to bind is not a failed request — it is the
      // "enabled but not running" state the cards now show, so name each one
      // instead of failing the whole apply.
      (res.results || []).filter((r) => r.ok === false).forEach((r) => {
        flashNote(TF("{svc} did not start: {err}", { svc: T(labelFor(r.service)), err: r.error || "" }), false);
      });
      // A snapshot that could not be re-read is the one state that must not pass
      // quietly — the next Save would post the pre-chooser config — so it is
      // flashed last, over the success toast.
      if (resyncErr) flashNote(TF("Load failed: {err}", { err: resyncErr.message }), false);
      exitSetup();
    } catch (e) {
      flashNote(e.message, false);
    } finally { btn.disabled = false; }
  }

  /* ── Overview ────────────────────────────────────────────────────
     One screen of facts about this machine, drawn entirely from polls that are
     already running: renderStatus() feeds the tiles and boxes, pollLog() feeds
     the ticker. No fetch, no timer, and nothing is drawn while the panel is
     closed. Nothing here is inferred — a peer is only "reachable" when its last
     probe actually succeeded, and an empty box says whether the service behind
     it is idle or stopped rather than leaving the operator to guess. */
  function renderOverview(s) {
    const panel = $("dlgOverview");
    if (!panel || panel.hidden) return;         // badges keep updating; the DOM work is skipped
    const txt = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    const rx = s.receiver || {}, wx = s.watcher || {}, px = s.printer || {}, rs = s.ris || {}, mw = s.mwl || {};
    const setup = s.setup || {};

    txt("ovServices", [rx, wx, px, rs, mw].filter((b) => b.running).length + "/5");
    txt("ovReceived", rx.received || 0);
    txt("ovSent", wx.sent || 0);
    txt("ovStuck", s.stuck || 0);
    txt("ovPending", s.pending || 0);
    txt("ovOpenOrders", (rs.counts && rs.counts.open) || 0);
    const disk = s.disk || {};
    txt("ovFree", disk.free_gb != null ? disk.free_gb + " GB" : "—");
    // Only Received and Sent are counters; Stuck, Pending, Open orders and Free
    // space are current-state figures with no window at all (open orders outlive
    // the process entirely), so the line names the two it actually covers.
    // The origin is the NEWEST the payload offers: the receiver object is rebuilt
    // — and its counters zeroed — on every config save, so borrowing the
    // process's start instant would claim a window the tile never counted.
    // Two origins, not one: the receiver object is rebuilt — and its counters
    // zeroed — on every config save, while the watcher survives it. Averaging or
    // max-ing them would caption one tile with the other tile's instant, which
    // is the same lie in smaller print. They collapse to one line only when the
    // two really are the same moment.
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
    // The AE:port is what a tech points a modality at, so it may only be printed
    // as an address when something is actually bound to it — a stopped receiver
    // says so on the same line instead of sending them to a dead port.
    setAtomic("ovAetPort", rx.aet
      ? rx.aet + ":" + rx.port + (rx.running ? "" : " · " + T("not listening"))
      : "");
    txt("ovVersion", dash(s.version));
    setPath("ovConfigPath", setup.config_path || s.config_path);
    setPath("ovStorageDir", rx.storage_dir);
    setPath("ovLogsDir", s.logs_dir);

    renderOvDests(s);
    renderOvLast(s);
  }

  function renderOvDests(s) {
    const box = $("ovDestList"), empty = $("ovDestEmpty"), tpl = $("ovDestRowTpl");
    if (!box || !tpl) return;
    const list = (s.destinations || []).filter((d) => d.enabled !== false);
    if (empty) empty.hidden = !!list.length;
    box.innerHTML = "";
    // Only 🚨-flagged destinations are probed, and only while failover is armed,
    // so most installs have no evidence about most peers. Absence of evidence is
    // rendered as "Not checked" — never as a green dot nothing stands behind.
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
        // `online` is NOT "the last probe succeeded": it stays true for
        // offline_threshold_sec after probes start failing (that debounce is the
        // failover state machine's, and it stays untouched), while last_probe is
        // stamped on every tick whatever the outcome. Green here would therefore
        // mean "failing for under two minutes" and carry a fresh timestamp
        // behind it. last_error is the per-tick fact — the engine clears it on a
        // successful probe — so it is what the green state is gated on.
        // Three outcomes, because the engine reports three. probe_ok is the
        // C-ECHO itself; last_error also carries "forward failing", which is set
        // when the node ANSWERED but its send queue is backed up. Calling that
        // unreachable sends the operator to check a network that is fine.
        const answered = p.probe_ok !== false;
        const up = answered && !p.last_error;
        state.classList.add(up ? "ok" : (answered ? "warn" : "bad"));
        state.textContent = up ? T("Reachable")
          : answered ? T("Sends failing") : T("Unreachable");
        // The engine's own words for the failure, untranslated, without spending
        // row width: the badge carries them as its tooltip.
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

  // The three "last thing that happened" boxes. Each is null until this process
  // has actually done that thing — but "nothing yet" and "this service is not
  // running" are different instructions: the first says wait, the second says go
  // and turn it on. Both flags ride in the same payload, so the empty line says
  // which of the two it is instead of always reading as idle.
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
    // The engine's own words, untranslated, like every other engine message.
    txt("ovTxError", t && t.ok === false ? t.error || "" : "");

    const ris = s.ris || {};
    const o = ris.last_order, c = ris.last_closed;
    // A closed order is still evidence that orders exist, so the empty line is
    // for the box with nothing in it at all — and then it says whether the HL7
    // feed is down, since orders can also be typed in by hand with it stopped.
    // Orders can be typed in by hand with the HL7 listener stopped, so this box
    // must not say the feature is off — only that the intake is.
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

  /* ── Service chips in the top navbar ─────────────────────────────
     Each service is mirrored as a chip in the navbar: gold when running,
     black-and-white when stopped. Clicking a chip just re-fires the matching
     card toggle button, so the "start on launch" flag + config-persist logic
     lives in exactly one place and card ⇄ navbar stay in lock-step. */
  const NAV_SERVICES = [
    { key: "rx", label: "Receiver",  toggle: "rxToggle" },
    { key: "wx", label: "Auto-send", toggle: "wxToggle" },
    { key: "px", label: "Printer",   toggle: "pxToggle" },
    { key: "rs", label: "RIS",       toggle: "rsToggle" },
    { key: "mw", label: "Worklist",  toggle: "mwToggle" },
  ];
  function mountServiceChips() {
    const nav = document.getElementById("carinoNav");
    if (!nav) return false;                       // navbar not injected yet
    if (document.getElementById("svcNav")) return true;   // already mounted
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
      chip.title = TF("{svc} — click to start/stop", { svc: T(svc.label) });
      const dot = document.createElement("span"); dot.className = "svc-chip-dot";
      const lab = document.createElement("span"); lab.className = "svc-chip-label"; lab.textContent = T(svc.label);
      chip.append(dot, lab);
      chip.addEventListener("click", () => { const b = $(svc.toggle); if (b) b.click(); });
      box.appendChild(chip);
    });
    right.insertBefore(box, right.firstChild);
    return true;
  }
  // Re-label the already-mounted chips after a language switch.
  function relabelServiceChips() {
    NAV_SERVICES.forEach((svc) => {
      const chip = document.getElementById("nav_" + svc.key);
      if (!chip) return;
      chip.title = TF("{svc} — click to start/stop", { svc: T(svc.label) });
      const lab = chip.querySelector(".svc-chip-label");
      if (lab) lab.textContent = T(svc.label);
    });
  }
  function setChip(key, on) {
    const chip = document.getElementById("nav_" + key);
    if (!chip) return;
    chip.dataset.on = String(!!on);
    chip.classList.toggle("on", !!on);
  }
  function showChip(key, show) {
    const chip = document.getElementById("nav_" + key);
    if (chip) chip.hidden = !show;
  }
  // Amber activity blink (like an ethernet link/activity LED); only while running.
  function blink(el) {
    if (!el || !el.classList.contains("on")) return;
    el.classList.remove("act");
    void el.offsetWidth;              // restart the CSS animation
    el.classList.add("act");
  }
  // Fire the navbar chip's transmit pulse (gold ring + dot flash) for a service
  // that just moved data. Only while running; restart trick lets it retrigger
  // on every poll that saw traffic, so sustained transfers pulse continuously.
  function pulseChip(key) {
    const chip = document.getElementById("nav_" + key);
    if (!chip || !chip.classList.contains("on")) return;
    chip.classList.remove("tx");
    void chip.offsetWidth;
    chip.classList.add("tx");
  }
  async function pollStatus() {
    try { renderStatus(await api("/api/status")); } catch (e) { /* keep last */ }
  }

  /* ── Log timestamps ──────────────────────────────────────────────
     Rendered through the shared navbar clock so toggling it (Local / UTC /
     Epoch / TAI / .beats) re-expresses every log line at once. `ms` is the
     epoch-millis of the entry; `isoFallback` is used only if the clock module
     isn't loaded (offline edge). */
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

  /* ── Log polling ─────────────────────────────────────────────── */
  let logSeq = 0, firstLog = true;
  // #ovTickerMsg ships with a data-i18n placeholder, so the language pass writes
  // "Nothing has happened yet." back over the live engine line every time the
  // language changes — a false statement on a machine that has been logging all
  // day. The last line drawn is kept here so the langchange handler can restore
  // it at once instead of leaving it wrong until the next log poll.
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
    try {
      const data = await api("/api/log?since=" + logSeq);
      const box = $("log");
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
      let sawStore = false, sawSend = false, sawPrint = false, sawRis = false, sawMwl = false;
      for (const e of data.entries) {
        logSeq = e.seq;
        if (e.kind === "store") sawStore = true;   // a file was received
        if (e.kind === "send") sawSend = true;      // a file was forwarded
        if (e.kind === "print") sawPrint = true;    // a print job / event
        if (e.kind === "ris") sawRis = true;        // an HL7 order / match event
        if (e.kind === "mwl") sawMwl = true;        // a worklist query
        const line = document.createElement("div");
        line.className = "line";
        const t = document.createElement("span");
        t.className = "t";
        // Keep the raw instant on the node so a clock-mode toggle can re-express
        // every line (Local / UTC / Epoch / TAI / .beats) without re-polling.
        const ms = e.epoch ? e.epoch * 1000 : Date.parse(e.ts || "");
        if (!isNaN(ms)) t.dataset.ms = ms;
        t.textContent = fmtLogTs(ms, e.ts);
        const m = document.createElement("span");
        m.className = e.level;
        m.textContent = e.message;
        line.append(t, m);
        box.appendChild(line);
      }
      // Overview's ticker is the last line of whatever this poll drew — the first
      // poll asks since=0 and gets the whole backlog, so it is right from the
      // first tick after a reload without a second request.
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
      }
      firstLog = false;
    } catch (e) { /* ignore */ }
  }

  /* ── Config load / populate ──────────────────────────────────── */
  async function loadConfig() {
    const c = await api("/api/config");
    loadedScp = c.scp || {};
    loadedScu = c.scu || {};
    loadedPrint = c.print || {};
    loadedRis = c.ris || {};
    loadedMwl = c.mwl || {};
    loadedEmg = c.emergency || {};
    loadedWeb = c.web || loadedWeb;
    loadedSetup = c.setup_completed || "";
    loadedLogsDir = c.logs_dir || "";
    $("webEditorUrl").value = (c.web && c.web.editor_url) || "";
    $("scpAet").value = c.scp.aet;
    $("scpBind").value = c.scp.bind;
    $("scpPort").value = c.scp.port;
    $("scpDir").value = c.scp.storage_dir;
    $("scpOrganize").checked = !!c.scp.organize;
    $("scpMinFree").value = c.scp.min_free_gb != null ? c.scp.min_free_gb : 2;
    $("scpAllowed").value = (c.scp.allowed_aets || []).join(", ");
    $("scpTls").checked = !!c.scp.tls;
    $("scpTlsCert").value = c.scp.tls_cert || "";
    $("scpTlsKey").value = c.scp.tls_key || "";
    $("scpTlsCa").value = c.scp.tls_ca || "";
    $("scuAet").value = c.scu.aet;
    $("scuDir").value = c.scu.watch_dir;
    $("scuPoll").value = c.scu.poll_interval;
    $("scuMode").value = c.scu.on_success;
    $("scuSent").value = c.scu.sent_dir;
    $("scuTlsVerify").checked = c.scu.tls_verify !== false;
    $("scuTlsCa").value = c.scu.tls_ca || "";
    $("scuTlsCert").value = c.scu.tls_cert || "";
    $("scuTlsKey").value = c.scu.tls_key || "";
    const pr = c.print || {};
    $("prnEnabled").checked = !!pr.enabled;
    $("prnAet").value = pr.aet || "CARINOPRINT";
    $("prnBind").value = pr.bind || "0.0.0.0";
    $("prnPort").value = pr.port != null ? pr.port : 11113;
    $("prnLayout").value = (pr.layout === "image" || pr.layout === "secondary_capture") ? "image" : "pdf";
    $("prnColor").checked = !!pr.color;
    $("prnAllowed").value = (pr.allowed_aets || []).join(", ");
    $("prnTls").checked = !!pr.tls;
    $("prnTlsCert").value = pr.tls_cert || "";
    $("prnTlsKey").value = pr.tls_key || "";
    $("prnTlsCa").value = pr.tls_ca || "";
    const ri = c.ris || {};
    $("risEnabled").checked = !!ri.enabled;
    $("risBind").value = ri.bind || "0.0.0.0";
    $("risPort").value = ri.port != null ? ri.port : 2575;
    $("risDir").value = ri.store_dir || "./ris";
    $("risMatch").value = ri.match_on === "accession_or_patient" ? "accession_or_patient" : "accession";
    $("risAutoClose").checked = ri.auto_close !== false;
    $("risHosts").value = (ri.allowed_hosts || []).join(", ");
    const mi = c.mwl || {};
    $("mwlEnabled").checked = !!mi.enabled;
    $("mwlAet").value = mi.aet || "CARINOMWL";
    $("mwlBind").value = mi.bind || "0.0.0.0";
    $("mwlPort").value = mi.port != null ? mi.port : 11114;
    $("mwlAllowed").value = (mi.allowed_aets || []).join(", ");
    $("mwlTls").checked = !!mi.tls;
    $("mwlTlsCert").value = mi.tls_cert || "";
    $("mwlTlsKey").value = mi.tls_key || "";
    $("mwlTlsCa").value = mi.tls_ca || "";
    const eg = c.emergency || {};
    $("emgArmed").checked = !!eg.armed;
    $("emgProbe").value = eg.probe_interval_sec != null ? eg.probe_interval_sec : 30;
    $("emgThreshold").value = eg.offline_threshold_sec != null ? eg.offline_threshold_sec : 120;
    $("emgRecovery").value = eg.recovery_successes != null ? eg.recovery_successes : 2;
    $("emgAuto").checked = !!eg.auto_activate;
    $("emgHold").checked = eg.hold_and_forward !== false;
    renderDests(c.destinations || []);
    reflowActive();
  }

  function renderDests(list) {
    const body = $("destBody");
    body.innerHTML = "";
    list.forEach(addDestRow);
    if (!list.length) addDestRow({});
  }
  function addDestRow(d) {
    const tpl = I18N_IN($("destRowTpl").content.cloneNode(true));
    const tr = tpl.querySelector("tr");
    tr.querySelector(".d-en").checked = d.enabled !== false;
    tr.querySelector(".d-name").value = d.name || "";
    tr.querySelector(".d-host").value = d.host || "";
    tr.querySelector(".d-port").value = d.port || "";
    tr.querySelector(".d-aet").value = d.aet || "";
    tr.querySelector(".d-tls").checked = !!d.tls;
    tr.querySelector(".d-noris").checked = !!d.no_ris;
    tr.querySelector(".d-emg").checked = !!d.emergency_trigger;
    tr.querySelector(".del").addEventListener("click", () => tr.remove());
    tr.querySelector(".echo").addEventListener("click", () => echoRow(tr));
    $("destBody").appendChild(tr);
  }
  function collectDests() {
    return [...$("destBody").querySelectorAll("tr")]
      .map((tr) => ({
        enabled: tr.querySelector(".d-en").checked,
        name: tr.querySelector(".d-name").value.trim(),
        host: tr.querySelector(".d-host").value.trim(),
        port: parseInt(tr.querySelector(".d-port").value, 10),
        aet: tr.querySelector(".d-aet").value.trim(),
        tls: tr.querySelector(".d-tls").checked,
        no_ris: tr.querySelector(".d-noris").checked,
        emergency_trigger: tr.querySelector(".d-emg").checked,
      }))
      .filter((d) => d.host && d.aet && d.port);
  }

  function collectConfig() {
    const allowed = $("scpAllowed").value.split(",").map((s) => s.trim()).filter(Boolean);
    // Spread the loaded section first so keys without a form input (min_free_gb,
    // pending_dir, …) survive; the form fields below override the visible ones.
    return {
      scp: {
        ...loadedScp,
        aet: $("scpAet").value.trim(),
        bind: $("scpBind").value.trim() || "0.0.0.0",
        port: parseInt($("scpPort").value, 10),
        storage_dir: $("scpDir").value.trim(),
        organize: $("scpOrganize").checked,
        min_free_gb: parseFloat($("scpMinFree").value) || 0,
        allowed_aets: allowed,
        tls: $("scpTls").checked,
        tls_cert: $("scpTlsCert").value.trim(),
        tls_key: $("scpTlsKey").value.trim(),
        tls_ca: $("scpTlsCa").value.trim(),
      },
      scu: {
        ...loadedScu,
        aet: $("scuAet").value.trim(),
        watch_dir: $("scuDir").value.trim(),
        poll_interval: parseFloat($("scuPoll").value) || 3,
        on_success: $("scuMode").value,
        sent_dir: $("scuSent").value.trim(),
        tls_verify: $("scuTlsVerify").checked,
        tls_ca: $("scuTlsCa").value.trim(),
        tls_cert: $("scuTlsCert").value.trim(),
        tls_key: $("scuTlsKey").value.trim(),
      },
      print: {
        ...loadedPrint,
        enabled: $("prnEnabled").checked,
        aet: $("prnAet").value.trim() || "CARINOPRINT",
        bind: $("prnBind").value.trim() || "0.0.0.0",
        port: parseInt($("prnPort").value, 10),
        layout: $("prnLayout").value,
        color: $("prnColor").checked,
        allowed_aets: $("prnAllowed").value.split(",").map((s) => s.trim()).filter(Boolean),
        tls: $("prnTls").checked,
        tls_cert: $("prnTlsCert").value.trim(),
        tls_key: $("prnTlsKey").value.trim(),
        tls_ca: $("prnTlsCa").value.trim(),
      },
      mwl: {
        ...loadedMwl,
        enabled: $("mwlEnabled").checked,
        aet: $("mwlAet").value.trim() || "CARINOMWL",
        bind: $("mwlBind").value.trim() || "0.0.0.0",
        port: parseInt($("mwlPort").value, 10),
        allowed_aets: $("mwlAllowed").value.split(",").map((s) => s.trim()).filter(Boolean),
        tls: $("mwlTls").checked,
        tls_cert: $("mwlTlsCert").value.trim(),
        tls_key: $("mwlTlsKey").value.trim(),
        tls_ca: $("mwlTlsCa").value.trim(),
      },
      emergency: {
        ...loadedEmg,
        armed: $("emgArmed").checked,
        probe_interval_sec: parseInt($("emgProbe").value, 10) || 30,
        offline_threshold_sec: parseInt($("emgThreshold").value, 10) || 0,
        recovery_successes: parseInt($("emgRecovery").value, 10) || 1,
        auto_activate: $("emgAuto").checked,
        hold_and_forward: $("emgHold").checked,
      },
      ris: {
        ...loadedRis,
        enabled: $("risEnabled").checked,
        bind: $("risBind").value.trim() || "0.0.0.0",
        port: parseInt($("risPort").value, 10),
        store_dir: $("risDir").value.trim() || "./ris",
        match_on: $("risMatch").value,
        auto_close: $("risAutoClose").checked,
        allowed_hosts: $("risHosts").value.split(",").map((s) => s.trim()).filter(Boolean),
      },
      destinations: collectDests(),
      web: { ...loadedWeb, editor_url: $("webEditorUrl").value.trim() },
      // Top-level, no form input: carried through so a Save cannot wipe the
      // onboarding stamp and re-offer the chooser forever.
      setup_completed: loadedSetup,
      logs_dir: loadedLogsDir,
    };
  }

  /* ── Actions ─────────────────────────────────────────────────── */
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

  function flashNote(msg, ok) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast " + (ok ? "ok" : "bad");
    t.hidden = false;
    clearTimeout(flashNote._t);
    flashNote._t = setTimeout(() => { t.hidden = true; }, 5000);
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

  /* ── Drag & drop a folder onto the Receiver / Auto-send cards ──── */
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

  /* ── Kill the whole service ──────────────────────────────────── */
  async function killService() {
    if (!confirm(T("Shut down Carino PACS?\n\nThe receiver and auto-send stop and the engine process exits."))) return;
    $("killSvc").disabled = true;
    post("/api/shutdown", {}).catch(() => {});   // process may exit before responding
    if (statusTimer) clearInterval(statusTimer);
    if (logTimer) clearInterval(logTimer);
    setDot($("rxDot"), false);
    setDot($("wxDot"), false);
    const ov = document.createElement("div");
    ov.className = "stopped-overlay";
    const box = document.createElement("div");
    const h = document.createElement("h2");
    h.textContent = T("Carino PACS has shut down");
    const p = document.createElement("p");
    p.textContent = T("The service stopped. You can close this window, or restart it from your terminal / the desktop app.");
    box.append(h, p);
    ov.appendChild(box);
    document.body.appendChild(ov);
  }

  /* ── Transaction history ─────────────────────────────────────── */
  let histGroup = "received";

  // Shared list placeholders (Loading… / load error) — same shape in every panel.
  function listLoading(el) { el.innerHTML = ""; el.appendChild(emptyNote(T("Loading…"))); }
  function listError(el, msg) { el.innerHTML = ""; el.appendChild(emptyNote(TF("Could not load: {err}", { err: msg }))); }
  function emptyNote(text) {
    const d = document.createElement("div");
    d.className = "hist-empty";
    d.textContent = text;
    return d;
  }

  async function loadHistory() {
    const list = $("histList");
    listLoading(list);
    try {
      const data = await api("/api/studies?group=" + histGroup);
      renderHistory(data.studies || []);
      reflowActive();
    } catch (e) {
      listError(list, e.message);
    }
  }

  function renderHistory(studies) {
    const list = $("histList");
    list.innerHTML = "";
    if (!studies.length) {
      list.appendChild(emptyNote(histGroup === "sent" ? T("No archived studies yet.") : T("No received studies yet.")));
      return;
    }
    studies.forEach((s) => {
      const row = I18N_IN($("histRowTpl").content.cloneNode(true)).querySelector(".hist-row");
      row.querySelector(".hist-patient").textContent =
        (s.patient || T("(no name)")) + (s.patient_id ? "  ·  " + s.patient_id : "");
      const meta = [
        s.study_date || T("no date"),
        s.study_desc || T("(no study description)"),
        s.modality,
        TN(s.instances, "{n} images"),
      ].filter(Boolean).join("  ·  ");
      row.querySelector(".hist-meta").textContent = meta;

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

      const sendBtn = row.querySelector(".hist-send");
      sendBtn.textContent = histGroup === "sent" ? T("Resend") : T("Send");
      sendBtn.addEventListener("click", () => histAction("send", s, sendBtn));
      row.querySelector(".hist-attach").addEventListener("click", () => histAttach(s));
      const editBtn = row.querySelector(".hist-edit");
      if (editorUrl) {
        editBtn.hidden = false;
        editBtn.addEventListener("click", () => histEdit(s));
      }
      row.querySelector(".hist-open").addEventListener("click", () => histAction("reveal", s));
      row.querySelector(".hist-del").addEventListener("click", () => histDelete(s));
      list.appendChild(row);
    });
  }

  async function histAction(action, s, btn) {
    const old = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    try {
      const r = await post("/api/studies/" + action, { group: histGroup, path: s.path });
      flashNote(r.message || T("OK"), r.ok !== false);
    } catch (e) {
      flashNote(e.message, false);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old; }
    }
  }

  async function histDelete(s) {
    if (!confirm(T("Delete this study from disk?") + "\n\n" + (s.patient || T("(no name)")) +
                 "\n" + (s.study_desc || "") + "  —  " + TN(s.instances, "{n} images"))) return;
    try {
      const r = await post("/api/studies/delete", { group: histGroup, path: s.path });
      flashNote(r.message || T("Deleted"), r.ok !== false);
      loadHistory();
    } catch (e) { flashNote(e.message, false); }
  }

  async function histDeleteAll() {
    const msg = histGroup === "sent"
      ? T("Delete ALL archived studies?\n\nThis permanently removes every study in the archived folder from disk.")
      : T("Delete ALL received studies?\n\nThis permanently removes every study in the received folder from disk.");
    if (!confirm(msg)) return;
    try {
      const r = await post("/api/studies/delete-all", { group: histGroup });
      flashNote(r.message || TF("Removed {n}", { n: r.removed || 0 }), r.ok !== false);
      loadHistory();
    } catch (e) { flashNote(e.message, false); }
  }

  // Open a study in DICOM-editor over the CARINO BRIDGE (carino-bridge.js). A
  // remote HTTPS editor cannot fetch our http://localhost API (mixed content —
  // hard-blocked in Safari), so instead WE fetch the DICOM from our own origin
  // (http→http, fine) and hand the bytes to the editor window by postMessage,
  // which is not subject to mixed-content rules. Works in every browser.
  function histEdit(s) {
    if (!editorUrl) return;
    // Resolve relative ("/editor/" = the bundled same-origin editor) or absolute URLs alike.
    let editorAbs;
    try { editorAbs = new URL(editorUrl, location.origin).href; }
    catch (e) { flashNote(T("Editor URL is not valid"), false); return; }
    if (!window.CarinoBridge) { flashNote(T("Bridge script missing — reload the page"), false); return; }
    const manifestUrl = "/api/studies/files?group=" + encodeURIComponent(histGroup) + "&path=" + encodeURIComponent(s.path);

    // The study is read only once the editor says it is listening: a window the
    // browser blocked, or one the user closed again, costs us nothing.
    CarinoBridge.send(editorAbs, async () => {
      const man = await api(manifestUrl);                   // same-origin fetch (http→http)
      const entries = man.files || [];
      if (!entries.length) throw new Error(man.message || T("no DICOM files in study"));
      const files = [];
      for (const e of entries) {
        const r = await fetch(e.url);
        if (r.ok) files.push({ name: e.name, buf: await r.arrayBuffer() });
      }
      if (!files.length) throw new Error(T("could not read any DICOM file"));
      return files;
    }, { legacy: true })                                    // editors older than the bridge
      .then((res) => flashNote(TN(res.count, "Opened {n} files in the editor"), true))
      .catch((err) => flashNote(
        /pop-up/i.test(err.message) ? T("Pop-up blocked — allow pop-ups to open the editor")
                                    : TF("Editor hand-off failed: {err}", { err: err.message }), false));
  }

  // Attach a PDF/image to an existing study (inherits its identity, new series).
  function histAttach(s) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,.jpg,.jpeg,.png,application/pdf,image/*";
    input.addEventListener("change", async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      const fd = new FormData();
      fd.append("group", histGroup);
      fd.append("path", s.path);
      fd.append("file", f);
      try {
        const res = await fetch("/api/studies/attach", { method: "POST", headers: { "X-Carino": "1" }, body: fd });
        let body = {}; try { body = await res.json(); } catch (e) { /* empty */ }
        flashNote(body.message || (res.ok ? T("Attached") : T("Attach failed")), res.ok && body.ok !== false);
        if (res.ok) loadHistory();
      } catch (e) { flashNote(e.message, false); }
    });
    input.click();
  }

  /* ── Pending imports (non-DICOM review queue) ────────────────── */
  function fmtDate(raw) {
    const s = String(raw || "");
    return (s.length === 8 && /^\d+$/.test(s)) ? s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8) : s;
  }

  function fmtWait(secs) {
    const n = Math.max(0, Number(secs) || 0);
    if (n <= 0) return T("due now");
    if (n < 60) return TF("retry in {n}s", { n });
    if (n < 3600) return TF("retry in {n}m", { n: Math.round(n / 60) });
    return TF("retry in {n}h", { n: Math.round(n / 3600) });
  }

  async function loadStuck() {
    const list = $("stuckList");
    listLoading(list);
    try {
      const data = await api("/api/stuck");
      renderStuck(data.destinations || []);
      reflowActive();
    } catch (e) {
      listError(list, e.message);
    }
  }

  function renderStuck(dests) {
    const list = $("stuckList");
    list.innerHTML = "";
    if (!dests.length) {
      list.appendChild(emptyNote(T("Nothing stuck — every forward is up to date.")));
      return;
    }
    dests.forEach((d) => {
      const row = I18N_IN($("stuckRowTpl").content.cloneNode(true)).querySelector(".stuck-row");
      row.querySelector(".stuck-dest").textContent = d.name || T("(destination)");
      row.querySelector(".stuck-meta").textContent =
        TN(d.instances, "{n} instances waiting") + "  ·  " + TN(d.attempts, "{n} attempts");
      row.querySelector(".stuck-err").textContent = d.last_error ? TF("last error: {err}", { err: d.last_error }) : "";
      row.querySelector(".stuck-next").textContent = fmtWait(d.next_in);
      const btn = row.querySelector(".stuck-retry");
      btn.addEventListener("click", () => retryStuck(d.name, btn));
      list.appendChild(row);
    });
  }

  async function retryStuck(dest, btn) {
    const old = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    try {
      const r = await post("/api/stuck/retry", dest ? { dest } : {});
      flashNote(r.message || T("Retrying…"), r.ok !== false);
      loadStuck();
      pollStatus();
    } catch (e) {
      flashNote(e.message, false);
      if (btn) { btn.disabled = false; btn.textContent = old; }
    }
  }

  async function loadPending() {
    const list = $("pendingList");
    listLoading(list);
    try {
      const data = await api("/api/pending");
      renderPending(data.items || []);
      reflowActive();
    } catch (e) {
      listError(list, e.message);
    }
  }

  function renderPending(items) {
    const list = $("pendingList");
    list.innerHTML = "";
    if (!items.length) {
      list.appendChild(emptyNote(T("Nothing waiting for review.")));
      return;
    }
    items.forEach((it) => {
      const row = I18N_IN($("pendingRowTpl").content.cloneNode(true)).querySelector(".pend-row");
      const kind = row.querySelector(".pend-kind");
      kind.textContent = it.kind === "pdf" ? "PDF" : "IMAGE";
      kind.classList.add(it.kind === "pdf" ? "k-pdf" : "k-img");
      row.querySelector(".pend-file").textContent = it.filename || T("(file)");
      row.querySelector(".pend-preview").href = "/api/pending/preview?id=" + encodeURIComponent(it.id);
      row.querySelector(".pf-patient").value = it.patient || "";
      row.querySelector(".pf-pid").value = it.patient_id || "";
      row.querySelector(".pf-acc").value = it.accession || "";
      row.querySelector(".pf-date").value = fmtDate(it.study_date);
      row.querySelector(".pf-sdesc").value = it.study_desc || "";
      row.querySelector(".pf-serdesc").value = it.series_desc || "";
      row.querySelector(".pend-src").textContent = it.source ? TF("from {src}", { src: it.source }) : "";
      const appBtn = row.querySelector(".pend-approve");
      appBtn.addEventListener("click", () => approvePending(it.id, row, appBtn));
      row.querySelector(".pend-discard").addEventListener("click", () => discardPending(it.id, it));
      list.appendChild(row);
    });
  }

  async function approvePending(id, row, btn) {
    const edits = {
      id: id,
      patient: row.querySelector(".pf-patient").value.trim(),
      patient_id: row.querySelector(".pf-pid").value.trim(),
      accession: row.querySelector(".pf-acc").value.trim(),
      study_date: row.querySelector(".pf-date").value.trim(),
      study_desc: row.querySelector(".pf-sdesc").value.trim(),
      series_desc: row.querySelector(".pf-serdesc").value.trim(),
    };
    const old = btn.textContent; btn.disabled = true; btn.textContent = "…";
    try {
      const r = await post("/api/pending/approve", edits);
      flashNote(r.message || T("Approved"), r.ok !== false);
      loadPending();
      pollStatus();
    } catch (e) {
      flashNote(e.message, false);
      btn.disabled = false; btn.textContent = old;
    }
  }

  async function discardPending(id, it) {
    if (!confirm(T("Discard this file?") + "\n\n" + (it.filename || "") +
                 "\n\n" + T("It is permanently deleted without importing."))) return;
    try {
      const r = await post("/api/pending/discard", { id });
      flashNote(r.message || T("Discarded"), r.ok !== false);
      loadPending();
      pollStatus();
    } catch (e) { flashNote(e.message, false); }
  }

  /* ── RIS orders (emergency RIS: intake + reconciliation) ─────── */
  let orderStatus = "open";

  async function loadOrders() {
    const list = $("ordersList");
    listLoading(list);
    try {
      const data = await api("/api/ris/orders?status=" + orderStatus);
      renderOrders(data.orders || []);
      $("ordPurge").hidden = orderStatus !== "closed" || !(data.counts && data.counts.closed);
      reflowActive();
    } catch (e) {
      listError(list, e.message);
    }
  }

  function renderOrders(orders) {
    const list = $("ordersList");
    list.innerHTML = "";
    if (!orders.length) {
      list.appendChild(emptyNote(orderStatus === "open"
        ? T("No open orders. Send an ORM over HL7/MLLP or add one above.")
        : T("No closed orders yet.")));
      return;
    }
    orders.forEach((o) => {
      const row = I18N_IN($("orderRowTpl").content.cloneNode(true)).querySelector(".order-row");
      const acc = row.querySelector(".order-acc");
      acc.textContent = o.accession ? TF("ACC {acc}", { acc: o.accession }) : T("no accession");
      if (!o.accession) acc.classList.add("order-noacc");
      row.querySelector(".order-patient").textContent = o.patient || o.patient_name || T("(no patient)");
      row.querySelector(".hist-meta").textContent = [
        o.patient_id ? TF("ID {id}", { id: o.patient_id }) : "",
        [fmtDate(o.patient_birthdate), o.patient_sex].filter(Boolean).join(" "),
        o.modality || "",
        o.station_aet ? "→ " + o.station_aet : "",
        o.study_desc || T("(no study description)"),
        o.scheduled_dt ? "@ " + String(o.scheduled_dt).replace("T", " ") : "",
      ].filter(Boolean).join("  ·  ");
      const sub = row.querySelector(".order-sub");
      const bits = [TF("via {src}", { src: o.source || "?" }), TF("queued {ts}", { ts: fmtStamp(o.created) })];
      if (o.status === "closed") {
        bits.push(o.close_reason === "matched"
          ? TF("✓ matched {ts}", { ts: fmtStamp(o.closed) })
          : TF("cancelled {ts}", { ts: fmtStamp(o.closed) }));
      }
      if (o.referring) bits.push(TF("ref: {who}", { who: o.referring }));
      sub.textContent = bits.join("  ·  ");
      const captureBtn = row.querySelector(".order-capture");
      const cancelBtn = row.querySelector(".order-cancel");
      if (o.status === "closed") {
        captureBtn.hidden = true;
        cancelBtn.hidden = true;
      } else {
        captureBtn.addEventListener("click", () => captureForOrder(o, captureBtn));
        cancelBtn.addEventListener("click", () => orderAction("cancel", o, T("Cancel this order? It moves to Closed (kept for the audit trail).")));
      }
      row.querySelector(".order-del").addEventListener("click", () =>
        orderAction("delete", o, T("Delete this order permanently? This removes it from the audit trail.")));
      list.appendChild(row);
    });
  }

  function fmtStamp(iso) {
    if (!iso) return "";
    return String(iso).replace("T", " ").replace("Z", "");
  }

  async function addOrder(btn) {
    const fields = {
      accession: $("ordAcc").value.trim(),
      patient: $("ordPatient").value.trim(),
      patient_id: $("ordPid").value.trim(),
      patient_birthdate: $("ordDob").value.trim(),
      patient_sex: $("ordSex").value,
      modality: $("ordMod").value.trim(),
      station_aet: $("ordStation").value.trim(),
      study_desc: $("ordDesc").value.trim(),
      scheduled_dt: $("ordWhen").value.trim(),
      referring: $("ordRef").value.trim(),
    };
    if (!fields.accession && !fields.patient && !fields.patient_id) {
      flashNote(T("An order needs at least an accession, patient name or ID"), false);
      return;
    }
    const old = btn.textContent; btn.disabled = true; btn.textContent = "…";
    try {
      const r = await post("/api/ris/orders", fields);
      flashNote(r.message || T("Order queued"), r.ok !== false);
      if (r.ok !== false) {
        ["ordAcc", "ordPatient", "ordPid", "ordDob", "ordSex", "ordMod", "ordStation", "ordDesc", "ordWhen", "ordRef"].forEach((id) => { $(id).value = ""; });
        orderStatus = "open";
        document.querySelectorAll("#dlgOrders .hist-tab").forEach((t) => t.classList.toggle("active", t.dataset.ostatus === "open"));
        loadOrders();
        pollStatus();
      }
    } catch (e) {
      flashNote(e.message, false);
    } finally { btn.disabled = false; btn.textContent = old; }
  }

  async function orderAction(action, o, confirmMsg) {
    if (confirmMsg && !confirm(confirmMsg + "\n\n" + (o.patient || T("(no patient)")) +
        (o.accession ? "  ·  " + TF("ACC {acc}", { acc: o.accession }) : ""))) return;
    try {
      const r = await post("/api/ris/orders/" + action, { id: o.id });
      flashNote(r.message || T("Done"), r.ok !== false);
      loadOrders();
      pollStatus();
    } catch (e) { flashNote(e.message, false); }
  }

  // Use-case-B bridge: pick an exported PDF/image and relate it to this order.
  // The server wraps it as DICOM (inheriting the order's identity + Study UID),
  // queues it to outgoing, and closes the order.
  function captureForOrder(o, btn) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,.jpg,.jpeg,.png,application/pdf,image/*";
    input.addEventListener("change", async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      const fd = new FormData();
      fd.append("id", o.id);
      fd.append("file", f);
      const old = btn.textContent; btn.disabled = true; btn.textContent = "…";
      try {
        const res = await fetch("/api/ris/orders/capture", { method: "POST", headers: { "X-Carino": "1" }, body: fd });
        let body = {}; try { body = await res.json(); } catch (e) { /* empty */ }
        flashNote(body.message || (res.ok ? T("Study created") : T("Capture failed")), res.ok && body.ok !== false);
        if (res.ok) { loadOrders(); pollStatus(); }
      } catch (e) {
        flashNote(e.message, false);
      } finally { btn.disabled = false; btn.textContent = old; }
    });
    input.click();
  }

  async function purgeClosedOrders() {
    if (!confirm(T("Delete ALL closed orders?\n\nThis permanently clears the closed-order audit trail."))) return;
    try {
      const r = await post("/api/ris/orders/purge", {});
      flashNote(r.message || T("Purged"), r.ok !== false);
      loadOrders();
      pollStatus();
    } catch (e) { flashNote(e.message, false); }
  }

  /* ── Sidebar workspace: each nav button expands its panel in the pane ──
     Every panel renders inline in the viewport-bound workspace and scrolls its
     own content; there is no popup/backdrop anymore. */
  // Overview leads the list (hash routing + sidebar order match) but Services
  // stays the landing panel: the unattended screen must not show patient names.
  const PANELS = ["dlgOverview", "dlgServices", "dlgHistory", "dlgOrders", "dlgPending", "dlgStuck", "dlgDests", "dlgSettings", "dlgLogs"];
  const loaders = { dlgHistory: loadHistory, dlgOrders: loadOrders, dlgPending: loadPending, dlgStuck: loadStuck };
  let activePanel = "dlgServices";

  function showPanel(id) {
    if (!PANELS.includes(id)) return;
    activePanel = id;
    PANELS.forEach((pid) => { const p = $(pid); if (p) p.hidden = pid !== id; });
    document.querySelectorAll(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.panel === id));
    if (loaders[id]) loaders[id]();
    // Overview has no loader — it is drawn by the status poll — so redraw it from
    // the last poll on open instead of showing a blank panel for up to 2s.
    if (id === "dlgOverview" && lastStatus) renderOverview(lastStatus);
  }
  function reflowActive() { /* no-op: panels scroll internally now (kept for callers) */ }

  /* ── Wire up ─────────────────────────────────────────────────── */
  document.addEventListener("DOMContentLoaded", () => {
    mountServiceChips();      // navbar has self-injected by now (renderStatus re-tries if not)
    $("killSvc").addEventListener("click", killService);
    $("rxToggle").addEventListener("click", (e) => toggle("receiver", e.target));
    $("wxToggle").addEventListener("click", (e) => toggle("watcher", e.target));
    $("pxToggle").addEventListener("click", (e) => {
      // Starting from the card also flips the "start on launch" flag so it
      // survives a restart (toggle() persists the config before starting).
      if (e.target.dataset.on !== "true") $("prnEnabled").checked = true;
      toggle("printer", e.target);
    });
    $("rsToggle").addEventListener("click", (e) => {
      // Starting from the card also flips the "start on launch" flag (toggle()
      // persists the config before starting, like the printer card).
      if (e.target.dataset.on !== "true") $("risEnabled").checked = true;
      toggle("ris", e.target);
    });
    $("mwToggle").addEventListener("click", (e) => {
      if (e.target.dataset.on !== "true") $("mwlEnabled").checked = true;
      toggle("mwl", e.target);
    });
    $("emgActivate").addEventListener("click", () => emergencyAction("activate"));
    $("emgDismiss").addEventListener("click", () => emergencyAction("dismiss"));
    $("addDest").addEventListener("click", () => addDestRow({ enabled: true }));
    $("saveCfg").addEventListener("click", () => saveConfig());
    $("saveDests").addEventListener("click", () => saveConfig());
    $("clearLog").addEventListener("click", () => { $("log").innerHTML = ""; });
    wireDropZones();

    // Service chooser. Three of the four doors are buttons (the fourth is the
    // first status that says nothing has ever been chosen); every one of them is
    // optional markup as far as this file is concerned, so nothing is assumed.
    const setupOpen = $("setupOpen");
    if (setupOpen) setupOpen.addEventListener("click", enterSetup);
    const setupFromSettings = $("setupFromSettings");
    if (setupFromSettings) setupFromSettings.addEventListener("click", () => { showPanel("dlgServices"); enterSetup(); });
    const ovSetupOpen = $("ovSetupOpen");
    if (ovSetupOpen) ovSetupOpen.addEventListener("click", () => { showPanel("dlgServices"); enterSetup(); });
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
    // Overview tiles and the ticker each carry data-panel: every figure on the
    // panel leads to the screen that owns the thing it counts.
    document.querySelectorAll("#dlgOverview [data-panel]").forEach((b) =>
      b.addEventListener("click", () => showPanel(b.dataset.panel)));

    // Sidebar: each button expands its panel in the right-hand pane.
    document.querySelectorAll(".navbtn").forEach((b) =>
      b.addEventListener("click", () => showPanel(b.dataset.panel)));

    // History Received/Sent sub-tabs.
    document.querySelectorAll(".hist-tab").forEach((tab) =>
      tab.addEventListener("click", () => {
        document.querySelectorAll(".hist-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        histGroup = tab.dataset.group;
        loadHistory();
      }));
    $("histRefresh").addEventListener("click", loadHistory);
    $("histDeleteAll").addEventListener("click", histDeleteAll);
    // RIS orders: Open/Closed sub-tabs + form + actions.
    document.querySelectorAll("#dlgOrders .hist-tab").forEach((tab) =>
      tab.addEventListener("click", () => {
        document.querySelectorAll("#dlgOrders .hist-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        orderStatus = tab.dataset.ostatus;
        loadOrders();
      }));
    $("ordAdd").addEventListener("click", () => addOrder($("ordAdd")));
    $("ordRefresh").addEventListener("click", loadOrders);
    $("ordPurge").addEventListener("click", purgeClosedOrders);
    $("pendRefresh").addEventListener("click", loadPending);
    $("stuckRefresh").addEventListener("click", loadStuck);
    $("stuckRetryAll").addEventListener("click", () => retryStuck(null, $("stuckRetryAll")));

    // Language switch: i18n.js retranslates the static markup; everything this
    // file rendered (status cards, list rows, navbar chips) is redrawn here.
    window.addEventListener("carino:langchange", () => {
      relabelServiceChips();
      // i18n.js has just re-applied the static markup, which includes two live
      // elements it seeded with placeholders — the Overview ticker and the three
      // empty lines. Repaint them from what is already in hand, synchronously,
      // so the placeholder never gets to stand as a statement about this machine
      // while the next poll is in flight.
      paintTicker();
      if (lastStatus) renderOverview(lastStatus);
      retitleWatcherWarn();
      pollStatus();
      if (loaders[activePanel]) loaders[activePanel]();
    });

    loadConfig().catch((e) => flashNote(TF("Load failed: {err}", { err: e.message }), false));
    // Deep-link: #dlgSettings etc. opens that panel; default is the cards.
    // #setup is not a panel but a state of the cards, so it is branched BEFORE
    // the fallback — that line would otherwise swallow it as an unknown hash.
    const fromHash = (location.hash || "").replace("#", "");
    if (fromHash === "setup") {
      showPanel("dlgServices");
      enterSetup();
    } else {
      showPanel(PANELS.includes(fromHash) ? fromHash : "dlgServices");
    }
    // Persist the panel in the hash so a reload comes back where the operator
    // was — except Overview. #dlgOverview stays deep-linkable (someone who asks
    // for it by URL gets it), but it must never become the panel an UNATTENDED
    // screen restores to: it prints a patient name and an accession, and a
    // reload, an Electron restart that keeps the fragment or a kiosk recovery
    // would all land on it after a single visit. Not persisting is the option
    // that keeps both halves: the deliberate link works, the accident does not.
    document.querySelectorAll(".navbtn").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.dataset.panel === "dlgOverview") return;
        try { history.replaceState(null, "", "#" + b.dataset.panel); } catch (e) {}
      }));
    retitleWatcherWarn();
    pollStatus();
    pollLog();
    statusTimer = setInterval(pollStatus, 2000);
    logTimer = setInterval(pollLog, 1500);
  });
})();
