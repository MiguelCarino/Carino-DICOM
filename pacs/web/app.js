/* Carino DICOM dashboard front-end — vanilla JS over the REST API. */
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
    if (!res.ok) {
      const err = new Error(body.error || body.message || res.statusText);
      err.status = res.status;
      /* The engine's machine-readable outcome, where it sent one. A rejection
         is exactly as likely to be read by a receptionist as an acceptance is —
         an order refused for an accession a worklist cannot carry is the case
         this was added for — so the code has to survive the throw, or the only
         sentence left to show is the engine's English. Callers that know the
         code translate it; the rest keep using err.message exactly as before. */
      err.code = body.code || "";
      // auth.required is the flag to test, not a bare ok:false — every other
      // error in this API is also ok:false, and "wrong input" and "you are not
      // signed in" have nothing in common as recoveries. See pacs/auth.py.
      err.auth = (body.auth && body.auth.required) ? body.auth : null;
      // Raise the prompt HERE so every caller inherits one recovery path
      // instead of fifty of them, and so a poll that lands after a service
      // restart re-prompts instead of failing silently forever.
      if (err.auth) onAuthRejected(err.auth);
      throw err;
    }
    return body;
  };
  // Every write carries X-Carino: 1 — including POST /api/login, which is a
  // write like any other. Without it web.py's cross-site guard answers 403
  // before the credential is ever looked at, and the operator is told the token
  // is wrong when it is not.
  const post = (url, data) =>
    api(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Carino": "1" }, body: JSON.stringify(data || {}) });

  // Full loaded config sections — kept so a Save preserves any key that has no
  // form input (min_free_gb, pending_dir, …); apply_config merges over DEFAULTS,
  // so an omitted key would otherwise silently reset. EVERY section the engine
  // knows about needs one: a section this file forgets is not left alone, it is
  // reset to the defaults — which for routing means every forwarding rule is
  // deleted, and for dicomweb/qr means the service switches itself off.
  let loadedScp = {}, loadedScu = {}, loadedPrint = {}, loadedRis = {}, loadedMwl = {}, loadedEmg = {};
  let loadedQr = {}, loadedDicomweb = {}, loadedRouting = {}, loadedIndex = {}, loadedDeid = {};
  // audit and notify have no form fields in this file yet, and that is exactly
  // why they need carrying: without them a Settings Save resets the audit trail
  // to its defaults (moving where it writes, and re-enabling read logging) and
  // switches every notification channel back off. `users` is NOT here — the
  // server refuses to take a profile list from this endpoint at all and
  // re-asserts the stored one, because config.write must not be a way to grant
  // yourself admin.
  let loadedAudit = {}, loadedNotify = {};
  // No form field outside its own tab, so a Save from elsewhere must post this
  // back verbatim or apply_config resets it to []. See collectConfig.
  let loadedModalities = [];
  /* The same station registry, arriving the other way round. /api/config is
     behind config.read, which reception does not hold, so the list the order
     form's target field is built from also rides in on the status payload,
     ungated there because it is this department's own room names and AE titles
     — no address, no PHI, and nothing reception could not already type by hand.
     Left empty by an appliance whose status predates that list, and the target
     field then degrades to the free-text AE title it has always had. */
  let statusModalities = [];
  let loadedWorklistSource = {};
  let loadedWeb = { host: "127.0.0.1", port: 8042 };
  // The onboarding stamp has no form input at all, and it is TOP-LEVEL: without
  // carrying it through a Save, apply_config's merge over DEFAULTS would reset it
  // to "" and the chooser would be offered again after every Settings save.
  let loadedSetup = "";
  let loadedLogsDir = "";   // no form field; cfg.replace merges over DEFAULTS, so a Save would reset it
  let statusTimer = null, logTimer = null;
  let editorUrl = "";                                // DICOM-editor base URL (from status); "" hides ✎ Edit
  let devPeerAvailable = false;                      // --dev-peer was given AND we may see it (the status block is gated)
  let lastStatus = null;                             // newest /api/status, for the panels that render on demand

  /* Emergency-RIS order arrival. Both are BASELINES, not counters: each is
     adopted from the first status payload this page (or this sign-in) sees and
     only ever compared against, so a reload never announces history.
       lastCreatedSeq   ris.created_seq — a tick the engine raises once per
                        order actually CREATED (hand-keyed or HL7). Diffed, never
                        displayed.
       lastOrderCounts  "open/closed/total" from ris.counts, the one signal that
                        moves on a create AND on all three close paths (C-STORE,
                        STOW-RS, capture) and on a cancel, which is what makes
                        the Orders list repaint itself. */
  let lastCreatedSeq = null;   // null = no baseline yet
  let lastOrderCounts = null;  // null = no baseline yet

  /* ── Authentication ──────────────────────────────────────────────
     web.auth_token is mandatory for every non-loopback bind and is generated on
     first boot in a container, so "the dashboard needs a token" is the normal
     case for anything that is not this machine. The engine serves the shell to
     anyone — a login form the browser was never allowed to download is an
     outage — and 401s every /api route until a credential arrives, so this file
     owns the whole client half:

       * GET /api/auth (public) decides, before anything else is fetched,
         whether to render the dashboard or the token prompt;
       * POST /api/login exchanges the token for an HttpOnly SameSite=Strict
         cookie, so the token itself never lives in JS where an injected script
         or an extension could read it;
       * that cookie is per-process and in memory, so a service restart signs
         every browser out. That is expected, not an error, and it comes back as
         a plain 401 — handled by re-raising this prompt where the operator was;
       * while the prompt is up the pollers are STOPPED, so a closed door is
         knocked on once, not thirty times a minute.  */
  let authRequired = false;      // the engine wants a credential at all
  let authed = false;            // this browser is holding a good credential
  let gateOpen = false;
  let booted = false;            // has the dashboard ever been started in this page-load?
  let retryTimer = null;         // rate-limit countdown

  /* Profiles.
     `me` is who this browser is signed in as, straight from the server on every
     /api/status. Its `capabilities` list is a RENDERING HINT and nothing more —
     every one of them is enforced at the endpoint, and this file must never be
     the only thing standing between somebody and an action. Hiding a button the
     server would refuse anyway is courtesy; hiding a button INSTEAD of the
     server refusing would be the whole feature undone. */
  let me = null;                 // {id,name,role,admin,capabilities,phi_visible}
  let profilesOn = false;        // the appliance runs with profiles at all
  let pickList = [];             // the picker's rows, from GET /api/profiles
  let picked = null;             // the profile chosen at the gate, awaiting a password
  let gateMode = "token";        // token | pick | name

  function can(cap) {
    // No profiles means no capability model, which is the pre-profiles world
    // where holding the credential means holding everything. Answering true is
    // what keeps every existing dashboard rendering exactly as it did.
    if (!profilesOn) return true;
    if (!me) return false;
    return me.admin === true || (me.capabilities || []).indexOf(cap) >= 0;
  }

  function seesPhi(field) {
    if (!profilesOn || !me) return true;
    return (me.phi_visible || []).indexOf(field) >= 0;
  }

  /* Nav follows capability. Derived from data-cap on each button rather than a
     table in here, so the markup and the rule cannot drift; a button with no
     data-cap is common ground and always shown.

     data-cap holds a SPACE-SEPARATED OR-LIST since the merge: Configuration
     answers to config.read, routing.read or auth.manage, because it holds one
     tab for each. A row appears if the profile holds ANY of them; the tabs
     inside it are then gated one at a time on their own single capability.
     Both halves are needed. The row alone would show a Radiologist a
     Configuration button (they hold routing.read) whose Settings tab carries
     the shutdown control and the API-token field. */
  function capAllowed(el) {
    const cap = (el.dataset.cap || "").trim();
    if (!cap) return true;                       // common ground
    return cap.split(/\s+/).some((c) => can(c));
  }
  function applyCapabilities() {
    document.querySelectorAll(".navbtn").forEach((b) => { b.hidden = !capAllowed(b); });
    // The Dev peer row answers to a launch argument as well as a capability,
    // and a capability check cannot express one. This must live INSIDE
    // applyCapabilities: the loop above re-asserts `hidden` on every .navbtn
    // from data-cap alone, so a flag applied anywhere else would be undone the
    // next time somebody's permissions changed — and the row would reappear on
    // an appliance that never passed the flag.
    const dp = document.querySelector('.navbtn[data-panel="dlgDevPeer"]');
    if (dp) dp.hidden = dp.hidden || !devPeerAvailable;
    // Badges lead to a tab, so they follow the tab's capability, not the row's.
    document.querySelectorAll(".navrow .badge[data-panel]").forEach((b) => {
      b.dataset.forbidden = capAllowed(b) ? "" : "1";
    });
    // Overview is common ground, but two of its tiles and the ticker point at
    // panels a restricted profile cannot hold. Left as buttons they would be
    // dead clicks — and a button that does nothing reads as broken software to
    // somebody working an outage. Demote them to the plain readout the markup
    // already uses for Free space, which counts something and leads nowhere.
    document.querySelectorAll("#dlgOverview [data-panel]").forEach((t) => {
      t.classList.toggle("ov-inert", !capAllowed(t));
    });
    // The first-run chooser lives on the ungated Overview, so every profile can
    // see it; only one that may work the services should be able to open it.
    const ovSetup = $("ovSetupOpen");
    if (ovSetup) ovSetup.hidden = !can("services.control");
    // Somebody whose permissions just narrowed — an administrator edited them
    // mid-session — could be left staring at a panel they can no longer load.
    // Repair the tab strips first (silently: see normalizeTabs), then move them
    // somewhere they can actually be.
    normalizeTabs();
    const activeBtn = document.querySelector('.navbtn[data-panel="' + activePanel + '"]');
    if (activeBtn && activeBtn.hidden) showPanel(firstAllowedPanel());
    const whoEl = $("whoami");
    if (whoEl) {
      whoEl.hidden = !profilesOn || !me;
      if (me) {
        whoEl.textContent = me.name + (me.role ? " · " + me.role : "");
        whoEl.title = me.service
          ? T("Signed in with the access token, which acts as an administrator.")
          : TF("Signed in as {name}", { name: me.name });
      }
    }
    // Sign out appears only when there is a session to end. On an appliance
    // with no credential at all it would put up a button that signs you out of
    // nothing and then shows a gate you cannot satisfy.
    const out = $("signOut");
    if (out) out.hidden = !authRequired;
    // The header chips stay visible for everyone and lose only their click.
    chipAuthority();
  }

  function setAuthMsg(msg, isNote) {
    const el = $("authMsg");
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
    el.classList.toggle("note", !!isNote);
  }

  /* The gate has three shapes and picks one from what the server said:

       pick   profiles are on and the operator publishes the list — buttons
       name   profiles are on and they do not — type a name and a password
       token  no profiles: the shared access token, exactly as before

     The token field survives in all three, folded away in the first two. It is
     the recovery path when somebody has locked themselves out of a profile, and
     removing it would mean the only way back into a misconfigured appliance is
     editing config.json by hand. */
  function setGateMode(mode) {
    gateMode = mode;
    const pick = mode === "pick";
    const name = mode === "name";
    const token = mode === "token";
    show($("authPickWrap"), pick);
    show($("authNameWrap"), name);
    show($("authTokenWrap"), token);
    show($("authAltWrap"), !token);
    show($("authHelp"), token);
    const title = $("authTitle");
    if (title) {
      title.textContent = token ? T("This PACS needs its access token")
                                : T("Who is using this station?");
    }
    const lede = $("authLede");
    if (lede && !token) {
      lede.textContent = T("Pick your profile to sign in. What you can see and do here follows the profile you choose, and everything you do is recorded against it.");
    }
    if (pick) renderPicker();
    setTimeout(() => {
      const focusOn = token ? $("authToken") : (name ? $("authName") : null);
      if (focusOn) focusOn.focus();
    }, 0);
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
      // A padlock, so somebody reaching a shared machine knows before they
      // click whether they are about to be asked for anything.
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
      // An open profile signs in on the click itself. Making them press a
      // second button to confirm a choice that needs no credential is friction
      // at the one place this design is trying not to have any.
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
      // The picker is public, so a failure here is the engine being
      // unreachable rather than an access problem. Falling back to the token
      // field gives the operator something that can still work.
      return "token";
    }
  }

  function showAuthGate() {
    const gate = $("authGate");
    if (!gate) return;
    gateOpen = true;
    // Every alert this session had decided on but not yet delivered goes with
    // it. They are dropped in one named place rather than one at a time here —
    // see dropSessionAlerts() for which they are and why each of them is
    // history the moment this prompt goes up.
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
    setAuthMsg("", false);
    clearInterval(retryTimer);
    retryTimer = null;
    const btn = $("authLogin");
    if (btn) btn.disabled = false;
  }

  // One 401 ends the session for every request in flight, so this collapses
  // them into a single prompt rather than a stack of toasts.
  function onAuthRejected(a) {
    const wasAuthed = authed;
    authRequired = true;
    authed = false;
    stopPollers();
    showAuthGate();
    if (a.reason === "rate_limited") { startRetryCountdown(a.retry_after); return; }
    if (a.reason === "expired") {
      setAuthMsg(T("Your session has expired — enter the token again."), true);
    } else if (wasAuthed) {
      // A restarted service throws its session secret away, so a perfectly
      // good cookie comes back "invalid". Telling the operator their token is
      // wrong there would send them hunting for a problem that does not exist.
      setAuthMsg(T("This browser is no longer signed in — the service was probably restarted. Enter the token again."), true);
    }
  }

  // 429 carries the seconds to wait; showing it beats a generic failure the
  // operator answers by hammering the button and extending the block.
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

  /* Builds the body for POST /api/login out of whichever shape the gate is in,
     or returns null with the operator already told what is missing. */
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
      // An open profile is sent with no password field at all rather than with
      // an empty one: the server refuses a password offered to a profile that
      // has none, and sending "" would trip that on every click.
      return picked.locked ? { profile: picked.id, password: value }
                           : { profile: picked.id };
    }
    if (gateMode === "name") {
      const nameEl = $("authName");
      const pwEl = $("authName2");
      const name = ((nameEl && nameEl.value) || "").trim();
      if (!name) { setAuthMsg(T("Enter your name to continue."), true); if (nameEl) nameEl.focus(); return null; }
      // The name is resolved to an id here, from the list the server gave us.
      // When the picker is hidden that list is empty, so the id cannot be
      // found — and the server is the one that must decide, so an unmatched
      // name is sent as typed and comes back as an ordinary failed sign-in.
      const match = pickList.filter((p) => p.name.toLowerCase() === name.toLowerCase())[0];
      return { profile: match ? match.id : name, password: (pwEl && pwEl.value) || "" };
    }
    const input = $("authToken");
    const token = ((input && input.value) || "").trim();
    if (!token) { setAuthMsg(T("Enter the token to continue."), true); if (input) input.focus(); return null; }
    return { token };
  }

  function clearGateInputs() {
    // Nothing typed at the gate is kept once the cookie exists — not in a
    // variable, not in a field, not in storage.
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
      } else setAuthMsg(e.message, false);
    } finally {
      if (!retryTimer && btn) btn.disabled = false;
    }
  }

  async function doLogout() {
    // The cookie is cleared server-side; if the request itself fails the
    // browser is signed out of this page all the same, so the prompt goes up
    // either way rather than leaving a half-signed-out dashboard polling.
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
    // Clearing the timers stops the NEXT request; it does nothing about one
    // already on the wire. Bumping the token retires those responses instead of
    // an AbortController, which would have to be threaded through api() for
    // every caller: the response is allowed to arrive and is then ignored,
    // which is all this needs. Every caller here is ending the session or the
    // process — a 401, a logout, a rotated token, a shutdown — and a late
    // render would paint live status over the prompt (re-adopting the arrival
    // baseline the prompt just dropped) or over the shutdown overlay.
    // The rendered watermark is dragged up to the same place, because the
    // watermark is what pollStatus() now tests against: leaving it behind would
    // let a response issued before the session ended still count as "newer than
    // anything drawn" and paint over the prompt.
    statusReq += 1;
    statusSeen = statusReq;
  }

  // Everything that must not run before there is a credential lives here.
  async function startApp() {
    if (gateOpen) return;
    paintBeepBtn();        // the button ships with no label; it must never be blank
    /* The modality codes are a constant, so the list is filled here rather than
       waiting on anything: reception usually has no config.read, and that is
       precisely the profile that needs a closed list. Both targeting lists are
       rebuilt the moment the station registry arrives — from loadConfig() below
       for whoever may read it, from the status payload for everyone else —
       which is also when the codes can be marked against the rooms that
       actually answer to them. */
    fillModalityChoices();
    await loadConfig().catch((e) => flashNote(TF("Load failed: {err}", { err: e.message }), false));
    if (!booted) {
      booted = true;
      openInitialPanel();
    } else {
      // Coming back from a 401: the operator's place was never lost, so the
      // pane they were on is what gets refreshed. runActiveLoader, not a bare
      // loaders[] lookup — three of the six panels have no entry there.
      runActiveLoader();
    }
    pollStatus();
    pollLog();
    startPollers();
  }

  /* Show the Manual link only if this build actually carries the manual.
     Asked with a HEAD rather than declared in /api/auth, whose docstring says
     it answers one question — is a token required — and which has no business
     knowing what documentation was packaged. The probe is same-origin and
     costs one request at boot; the manual routes are public, so the answer is
     the same before and after login.

     Failure leaves the link hidden. A source checkout served without docs/, or
     a future build that drops it, then shows nothing rather than a link that
     404s — and the 404 body still names the published copy for anyone who
     reaches it by typing the path. */
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
      // /api/auth is public, so a failure here is the engine being unreachable
      // — asking for a token would be the wrong instruction entirely.
      showAuthGate();
      setAuthMsg(TF("Cannot reach the service: {err}", { err: e.message }), false);
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

  /* ── Status polling ──────────────────────────────────────────── */
  function renderStatus(s) {
    const rx = s.receiver, wx = s.watcher, px = s.printer || {}, rs = s.ris || {}, mw = s.mwl || {};
    const qr = s.qr || {};
    lastStatus = s;
    // The engine reports whether it wants a token on every status payload, so a
    // token set from another browser (or removed) is picked up without a reload.
    if (s.auth) {
      authRequired = !!s.auth.required;
      profilesOn = !!s.auth.profiles;
      // Re-read on every poll, not just at sign-in. An administrator who
      // changes what somebody may do — or disables them — has it take effect on
      // that person's next request server-side, and the nav has to follow
      // within the same two seconds or they are left looking at buttons that
      // now 403. Only redrawn when it actually changed, because this runs
      // every poll.
      const nextWho = s.auth.who || null;
      if (JSON.stringify(nextWho) !== JSON.stringify(me)) {
        me = nextWho;
        applyCapabilities();
      }
    }
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

    /* The order form's two targeting fields follow the station registry, and
       this poll is where reception receives it: `modalities` is common ground
       on the status payload (see _STATUS_GATES in web.py — named rooms and AE
       titles carry no address and no identifier), while /api/config is not.
       Rebuilt only when the registry actually moved, because this runs every
       two seconds and re-filling a <select> underneath an operator who is
       choosing from it is its own small failure. */
    if (Array.isArray(s.modalities)) statusModalities = s.modalities;
    if (registryChanged()) refreshTargetChoices();

    // A gated section is DROPPED, not blanked, for a profile without the
    // capability (see _STATUS_GATES), so "absent" covers both "the flag was
    // never given" and "not yours to see" — and the panel is hidden either way.
    // applyCapabilities runs only when `me` changes, so a flag that turned out
    // to be there has to ask for the redraw itself.
    const nextPeer = !!(s.dev_peer && s.dev_peer.available);
    if (nextPeer !== devPeerAvailable) { devPeerAvailable = nextPeer; applyCapabilities(); }
    if (activePanel === "dlgDevPeer") renderDevPeer(s.dev_peer || null);

    // The two counts that share the Studies row, and the one on Orders. Each
    // carries its own glyph and its own spoken name: two bare numbers on one
    // row cannot say which is which, and when one is hidden at zero the
    // survivor is ambiguous with nothing but colour to tell them apart.
    // TN() is called with the literal at each site, not with a key threaded
    // through setBadge: i18n-parity greps for the literal inside a TN(), and a
    // key held in a variable is a key it cannot see.
    const nPend = s.pending || 0, nStuck = s.stuck || 0, nOrd = (rs.counts && rs.counts.open) || 0;
    setBadge("pendingBadge", nPend, "📎", TN(nPend, "{n} pending imports"));
    setBadge("stuckBadge", nStuck, "⚠", TN(nStuck, "{n} stuck sends"));
    setBadge("ordersBadge", nOrd, "", TN(nOrd, "{n} open orders"));

    /* An order arrived. Edge-triggered off ris.created_seq — the engine's
       count of orders CREATED (hand-keyed at the front desk or delivered over
       HL7), which only ever rises. It rides the status poll that is already
       running, so there is no new timer and no new request, and it sits here so
       the Orders badge above has already been repainted from the same payload:
       the number and the flash agree in one paint.
       `typeof seq === "number"` is the whole capability check. A profile
       without orders.read never receives the ris block at all (_STATUS_GATES),
       so `rs` is {} and this is simply inert for them — no second gate to keep
       in step with the server's. */
    const seq = rs.created_seq;
    if (typeof seq === "number") {
      if (lastCreatedSeq === null || seq < lastCreatedSeq) {
        /* First poll after load or sign-in: adopt the value, never announce it.
           A value that has gone BACKWARDS lands here too, and it no longer
           means "the engine restarted" — the tick is persisted with the orders
           now (pacs/ris.py), precisely so that a restart keeps counting and the
           orders taken while the service was coming back are announced instead
           of being swallowed by the adoption. What is left here is the tick
           losing its base altogether: an orders.json written before it was
           persisted, or one restored from a backup, or a store directory
           repointed. The number then means nothing this page can diff against,
           so it is adopted in silence rather than turned into an arrival count
           that would be invented. */
        lastCreatedSeq = seq;
      } else if (seq > lastCreatedSeq) {
        const n = seq - lastCreatedSeq;
        lastCreatedSeq = seq;   // advance BEFORE announcing: once per arrival, not once per poll
        onOrderArrived(n);
      }
    }

    /* The Orders list repaints itself. Driven by ris.counts rather than by the
       arrival above, because counts moves on everything the list draws: a
       create raises open+total, and a close lowers open / raises closed
       whichever path closed it (C-STORE, STOW-RS or a capture), as does a
       cancel — so a row stops showing as actionable Open on its own.
       Known gap, stated rather than papered over: an HL7 amendment moves no
       count, so an amended row stays stale until the next counted change or a
       manual ↻ Refresh. */
    const c = rs.counts;
    if (c) {
      const sig = c.open + "/" + c.closed + "/" + c.total;
      if (lastOrderCounts === null) lastOrderCounts = sig;   // adopt: opening the panel fetches anyway
      else if (sig !== lastOrderCounts) {
        lastOrderCounts = sig;
        // Only while the panel is on screen: repainting a hidden list would be
        // a wasted request every time anything happens, and openPanel already
        // runs the loader, so a freshly opened panel is current.
        if (!gateOpen && activePanel === "dlgOrders") loadOrders();
      }
      // Cheap, and it is the half of loadOrders() that used to go stale: the
      // purge button's reason to exist is the CLOSED count, which changes
      // without anybody touching this panel.
      paintOrdPurge(c.closed);
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

    // The config in force, judged. Config.load() does not validate on purpose —
    // "a PACS that refuses to start is a PACS the operator cannot fix" — and the
    // whole price of that decision is meant to be paid by SAYING so: the engine
    // validates what it loaded and publishes the verdict as status.config_problem.
    // Nothing rendered it. One log line scrolled past at boot and from then on
    // the screen showed a healthy PACS running a file it would refuse to save,
    // which is not a cosmetic gap — deid.prefix as a JSON number is exactly such
    // a file, and it holds every de-identified forward on this machine.
    renderConfigProblem(s.config_problem || "", s.config_path || "");

    setDot($("rxDot"), rx.running);
    setAtomic("rxAet", rx.aet);
    setAtomic("rxAddr", `${rx.bind}:${rx.port}`);
    setPath("rxDir", rx.storage_dir);
    $("rxCount").textContent = rx.received;
    // `errors` is a store that failed; `refused` is one this receiver turned
    // away before writing a byte, because the volume was below the free-space
    // floor. The engine has counted refusals since the floor existed and nothing
    // drew the number: the low-disk banner covers only what is true RIGHT NOW,
    // so a burst that stopped when somebody freed space left the card reading
    // "Received 0, Errors 0" over studies that never arrived. Beside the errors
    // rather than in a cell of its own — the markup is not this lane's to change
    // — and a marker plus the count keeps a numeric cell numeric in every
    // language, with the sentence in the tooltip.
    const rxErr = $("rxErr");
    rxErr.textContent = rx.refused ? rx.errors + " ⛔" + rx.refused : rx.errors;
    rxErr.title = rx.refused
      ? TF("{n} incoming studies were REFUSED for low disk space and never arrived. Nothing retries them from this side — the sender has to send them again once there is space.", { n: rx.refused })
      : "";
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

    setDot($("qrDot"), qr.running);
    setAtomic("qrAet", qr.aet || "—");
    setAtomic("qrAddr", `${qr.bind || "0.0.0.0"}:${qr.port || "—"}`);
    $("qrQueries").textContent = qr.queries || 0;
    $("qrMatches").textContent = qr.matches || 0;
    const qrSent = $("qrSent");
    qrSent.textContent = qr.sent || 0;
    // C-MOVE and C-GET both end in instances sent, but they fail in different
    // places; the breakdown rides in the tooltip rather than costing two cells.
    qrSent.title = TF("{moves} C-MOVE · {gets} C-GET", { moves: qr.moves || 0, gets: qr.gets || 0 });
    $("qrFailed").textContent = qr.move_failures || 0;
    $("qrErr").textContent = qr.errors || 0;
    $("qrTls").textContent = qr.tls ? (qr.tls_mutual ? T("mTLS") : "TLS") : T("plaintext");
    setToggle($("qrToggle"), qr.running);
    setChip("qr", qr.running);

    renderEmergency(s.emergency || {}, rs, mw);
    renderIndex(s.index || {});
    renderDicomweb(s.dicomweb || {});
    renderDeidState(s.deid || {});

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
    setCardState("qrCard", qr.enabled, qr.running);

    if (setupActive) {
      // Entered before the first status landed (boot #setup): seed now.
      if (!setupSeeded) seedSetup(s);
    } else if (!setupDismissed && s.setup && s.setup.needed && can("services.control")) {
      // Door 1 — nothing has ever been chosen on this machine. Only for
      // somebody who may actually choose: opening the chooser for a profile
      // without services.control would set setupActive on a panel their nav row
      // does not offer, and leave the appliance wedged in a setup state with no
      // chooser on screen. showPanelInternal because the chooser predates
      // anything there is to be entitled to.
      showPanelInternal("dlgServices");
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
        /* Ask the engine whether the worklist is actually serving instead of
           asserting it. A worklist that failed to start (or has since died) is
           the one thing that stops an emergency order reaching the scanner, and
           the banner used to claim it was serving regardless — so the tech
           pulled an empty worklist while the dashboard said everything was
           fine. Absent reads as serving: an appliance whose status predates the
           field must not be accused of an outage it may not have. */
        text = emg.worklist_serving === false
          ? TF("🚨 EMERGENCY ACTIVE — '{who}' unreachable. The worklist is NOT serving, so orders will not reach the modalities; received studies are held for forward.", { who })
          : TF("🚨 EMERGENCY ACTIVE — '{who}' unreachable. Worklist is serving; received studies are held for forward.", { who });
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
        renderEmergencyGuidance(emg);
        prompt.hidden = false;
        emgPromptShown = true;
      }
    } else {
      prompt.hidden = true;
      emgPromptShown = false;
    }
  }

  /* What the person reading this modal should actually DO about it, and what
     they are able to do.

     The three people this appliance wakes up have three different jobs — key
     orders in by hand, push a study to an alternate node, correct an address —
     and a single generic paragraph serves none of them. The text follows the
     ROLE, which is a label an administrator typed, so an unrecognised one gets
     the neutral wording rather than nothing.

     The Activate button follows emergency.activate_by, which the server also
     enforces: someone who may not answer sees why and who can, instead of a
     button that fails when pressed. */
  const EMG_GUIDANCE = {
    receptionist: "Orders are not reaching the modalities. Key new orders in here (Orders → New order) and give the technologist the accession number to type into the modality.",
    radiologist: "Studies arriving now are held on this appliance. If a read cannot wait, forward that study to an alternate destination from History. Nothing is lost — held studies back-fill when the primary returns.",
    it: "The primary is failing its health probe. If the address changed rather than the node going down, correct the destination and the monitor clears on the next probe.",
    admin: "Activating starts the local worklist and holds incoming studies for the primary. Dismissing leaves this appliance receiving and queueing, but serving no worklist.",
  };

  function renderEmergencyGuidance(emg) {
    const hint = $("emgRoleHint");
    if (hint) {
      const key = (me && me.role || "").toLowerCase();
      hint.textContent = EMG_GUIDANCE[key] ? T(EMG_GUIDANCE[key]) : "";
      hint.hidden = !hint.textContent;
    }
    const act = $("emgActivate");
    const why = $("emgWhoCan");
    // may_activate is absent on an appliance without profiles, where everyone
    // at the dashboard decides — so undefined has to read as allowed.
    const allowed = emg.may_activate !== false;
    if (act) act.hidden = !allowed;
    if (why) {
      const named = (emg.activate_by || []).join(", ");
      why.textContent = allowed ? ""
        : (named ? TF("Failover on this appliance is answered by {who}.", { who: named })
                 : T("Your profile can see this alert but not answer it."));
      why.hidden = !why.textContent;
    }
    const dismiss = $("emgDismiss");
    // "Not now" means "I have seen this", and it only ever silences the modal
    // for the person who pressed it. Saying so matters on a shared machine,
    // where the old single flag meant one person's click silenced everyone.
    if (dismiss) dismiss.textContent = allowed ? T("Not now") : T("I have seen this");
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
  /* ── Instance index, DICOMweb, de-identification (Settings readouts) ────
     All three are drawn from the status poll that is already running, like the
     Overview panel: no extra request, and nothing is drawn when the markup is
     not there (a packaged build could ship without one of these fieldsets). */
  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }

  // All three are drawn from the 2s status poll, so they skip the DOM work
  // while Settings is closed — same rule as the Overview panel — and showPanel
  // repaints them from the last poll when it opens.
  const settingsOpen = () => { const p = $("dlgSettings"); return !!p && !p.hidden; };

  function renderIndex(ix) {
    if (!settingsOpen()) return;
    const txt = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    txt("idxInstances", ix.instances != null ? ix.instances : "—");
    txt("idxStudies", ix.studies != null ? ix.studies : "—");
    txt("idxPatients", ix.patients != null ? ix.patients : "—");
    txt("idxQueued", ix.queued != null ? ix.queued : "—");
    // last_write is when the index last actually wrote a row — the honest
    // answer to "is it keeping up", which a rescan timestamp alone is not.
    txt("idxLast", ix.last_write ? fmtLogTs(ix.last_write * 1000) : T("never"));
    setPath("idxDbPath", ix.path ? ix.path + (ix.db_bytes ? "  ·  " + fmtSize(ix.db_bytes) : "") : "—");
    const note = $("idxNote");
    if (note) {
      // Three different states, three different sentences: a disabled index is
      // not an idle one, and a running rescan is not a finished one.
      // `rebuilt` is the fourth, and it was published and drawn nowhere: the
      // schema moved, the table was dropped EMPTY on purpose (everything in it
      // is re-derivable from the files) and the engine logged "a rescan is
      // needed" once, at boot. Until that rescan runs, Q/R and DICOMweb answer
      // from an empty index — a C-FIND for a study that is on this disk comes
      // back "no such study" — and this panel showed 0 instances with no
      // sentence next to it. Gated on the index still being empty so it clears
      // itself the moment the rescan lands, rather than standing for the life of
      // the process.
      note.textContent = !ix.enabled ? T("Index off — Query/Retrieve and DICOMweb have nothing to answer from.")
        : ix.scanning ? T("Rescanning the storage folders…")
        : (ix.rebuilt && !ix.instances)
          ? T("The index was rebuilt empty after a version change and nothing has been scanned into it since — press Rescan now, or Query/Retrieve and DICOMweb keep answering as though this PACS held nothing.")
        : ix.errors ? TN(ix.errors, "{n} index errors — see the log")
        : "";
      note.classList.toggle("bad", !ix.enabled || !!ix.errors || !!(ix.rebuilt && !ix.instances));
    }
    const btn = $("idxRescanNow");
    if (btn) btn.disabled = !ix.enabled || !!ix.scanning;
  }

  function renderDicomweb(dw) {
    if (!settingsOpen()) return;
    const url = $("dwUrl");
    if (url) {
      // Absolute, because the point of this field is that it is pasted into a
      // viewer running somewhere else.
      let abs = dw.url || "/dicom-web";
      try { abs = new URL(abs, location.origin).href; } catch (e) { /* keep it relative */ }
      url.value = abs;
      url.title = abs;
    }
    const st = $("dwState");
    if (!st) return;
    st.textContent = !dw.enabled
      ? T("DICOMweb is off — a viewer pointed at that URL gets 503.")
      : TF("On · {q} queries · {r} retrieved · {s} stored", { q: dw.queries || 0, r: dw.retrieved || 0, s: dw.stored || 0 })
        + (dw.allow_stow ? "" : "  ·  " + T("read-only (STOW off)"));
    st.classList.toggle("warn-note", !dw.enabled);
  }

  /* The standing "this config would be refused" banner, beside the low-disk one
     at the top of the page: it is a fact about the whole install, not about the
     panel that happens to be open, and every panel's numbers are being produced
     by that config. Created here rather than in index.html because the markup is
     not this lane's to edit; it is inserted once and then only updated. */
  let cfgWarnEl = null;
  function renderConfigProblem(problem, path) {
    const anchor = $("diskWarn");
    if (!anchor || !anchor.parentNode) return;
    if (!cfgWarnEl) {
      cfgWarnEl = document.createElement("div");
      cfgWarnEl.className = "cfg-warn";
      cfgWarnEl.id = "cfgWarn";
      cfgWarnEl.hidden = true;
      anchor.parentNode.insertBefore(cfgWarnEl, anchor.nextSibling);
    }
    cfgWarnEl.hidden = !problem;
    // The engine's own sentence, in the engine's language, inside a frame that
    // says what it means — the same division every other engine message on this
    // dashboard keeps.
    cfgWarnEl.textContent = problem
      ? TF("⚠ This configuration would be REFUSED if it were saved from this dashboard, and it is being used exactly as it stands: {problem} Fix it in Settings — no Save will go through until you do — or in the file at {path}.",
           { problem, path })
      : "";
  }

  function renderDeidState(dd) {
    if (!settingsOpen()) return;
    const st = $("deidState");
    if (!st) return;
    const dests = dd.destinations || [];
    // Both halves come from the engine's settled routing answer (status.deid),
    // never from the rules in the form: `destinations` are the nodes that WILL
    // be scrubbed for, `held` the nodes a rule asks to scrub while nothing can
    // perform it — those are not sent to at all.
    const held = dd.held || [];
    // WHICH of the two ways it cannot be performed, straight from the engine.
    // The sentence below used to assert the first one over both, which made the
    // panel's only instruction ("turn a profile on") a no-op at the sites in the
    // second state — their profile IS on — leaving them the other half of the
    // sentence, "take de-identify off the rule", as the one thing left to try.
    // That releases the studies by forwarding them IDENTIFIED to the node a rule
    // exists to scrub for. Wrong advice on this panel is not a wrong label; it
    // is the disclosure itself, arrived at by an operator doing as they were told.
    const cause = dd.hold_cause || "";
    // Which nodes a rule would actually scrub for is the one thing worth
    // checking before a research forward goes out; "nothing" is also an answer.
    st.textContent = !held.length
      ? (dests.length
        ? TF("Rules de-identify for: {dests}", { dests: dests.join(", ") })
        : T("No routing rule asks for de-identification, so nothing is being scrubbed."))
      : cause === "no-deidentifier"
        ? TF("Rules ask to de-identify for {dests}. The profile is on, but no de-identifier can be built from these settings, so nothing can be scrubbed and those studies are HELD in the outgoing folder instead of being sent. Repair the de-identification settings below: turning the profile off does NOT release them, and taking de-identify off the rule releases them identified.", { dests: held.join(", ") })
        : cause === "profile-off"
          ? TF("Rules ask to de-identify for {dests}, but the de-identification profile is off. Nothing can be scrubbed, so those studies are HELD in the outgoing folder instead of being sent. Turn a profile on, or take de-identify off the rule.", { dests: held.join(", ") })
          // No cause the engine will name: say what is true and where the answer
          // is, rather than picking one of the two and being wrong half the time.
          : TF("Rules ask to de-identify for {dests}, and nothing can be scrubbed, so those studies are HELD in the outgoing folder instead of being sent. Check the profile below: if it is off, turn it on; if it is on, nothing could be built to scrub with and the log says why.", { dests: held.join(", ") });
    // The colour used to be keyed on "no rule scrubs while a profile is on",
    // which is the HARMLESS state — a profile configured ahead of the rule that
    // will use it — and left the dangerous one (rules scrubbing, profile off,
    // deliveries held) in the ordinary muted note colour. Loud belongs on the
    // state that stops studies arriving, and it is red rather than amber: an
    // operator has to act before anything moves.
    st.classList.toggle("bad-note", !!held.length);
    st.classList.remove("warn-note");
    // deid.secret_set is the whole of what the engine will say about the site
    // key (the key itself is redacted from every payload), and nothing rendered
    // it — so an install with no key looked exactly like one with a key while
    // its pseudonyms were a pure function of the input, reproducible by anyone
    // holding this software. Only shown when a profile is actually on: with the
    // profile off nothing is scrubbed and the key is not a fact about today.
    if ((dd.profile || "off") !== "off") {
      const key = document.createElement("span");
      key.className = "deid-key" + (dd.secret_set ? "" : " warn");
      key.textContent = dd.secret_set
        ? T("A site key is set — pseudonyms and date shifts cannot be reproduced without it.")
        : T("No site key is set — pseudonyms are derived from the study alone, so anyone with this software can reverse them. Set one with POST /api/deid/secret.");
      st.appendChild(key);
    }
    // The other door. `retrieval_raw` is the engine's list of retrieval services
    // that are OPEN right now, and none of them scrubs: de-identify-on-forward
    // happens in the sender, on a temp copy, on the way to a destination a rule
    // names — C-MOVE, C-GET and WADO-RS all serve the stored file exactly as it
    // was received. That is a defensible design and a dangerous thing to leave
    // unsaid three lines under "Rules de-identify for: Research", because the
    // operator reading it is the one deciding whether to let Research pull.
    // Only while a scrub is actually configured: with no rule asking for one
    // there is no promise for a retrieval to undercut, and the line would be
    // noise on every install that never de-identifies anything.
    const doors = dd.retrieval_raw || [];
    if (doors.length && (dests.length || held.length)) {
      const via = document.createElement("span");
      via.className = "deid-key warn";
      // Protocol identifiers, deliberately untranslated — they are what an
      // operator matches against the other node's configuration.
      const label = { qr: "Q/R (C-MOVE · C-GET)", dicomweb: "DICOMweb (WADO-RS)" };
      via.textContent = TF("De-identification applies to FORWARDING only. {doors} are open, and they serve stored studies exactly as they were received — a node allowed to pull from this PACS gets the identified originals whatever the rules scrub for on the way out.",
                           { doors: doors.map((d) => label[d] || d).join(" · ") });
      st.appendChild(via);
    }
    // Sends that were in flight when these settings moved. The engine keeps the
    // list (deid.superseded_sends) precisely because such a send finishes under
    // the settings it started with — so the answer ABOVE is already the new one
    // while part of a study is still being withheld under the old — and nothing
    // rendered it, which left the operator with a study that stopped halfway and
    // a panel with no explanation for it.
    const stale = dd.superseded_sends || [];
    if (stale.length) {
      const sup = document.createElement("span");
      sup.className = "deid-key warn";
      sup.textContent = TF("The de-identification settings changed while these studies were being sent, so the rest of each was held rather than sent under settings you have already replaced: {studies}. Press Send again on each to deliver it under the current ones.",
                           { studies: stale.map((r) => r.study).join(", ") });
      st.appendChild(sup);
    }
  }

  async function rescanIndex(btn) {
    btn.disabled = true;
    try {
      const r = await post("/api/index/rescan", {});
      flashNote(r.message || T("Rescanning…"), r.ok !== false);
    } catch (e) {
      flashNote(e.message, false);
    } finally {
      // The poll re-disables it while the walk runs; leaving it disabled here
      // would strand the button if the request itself failed.
      btn.disabled = false;
      pollStatus();
    }
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
    { svc: "qr",       card: "qrCard",       pick: "pickQr", port: "portQr", label: "Query/Retrieve", block: "qr" },
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
    const qr = s.qr || {};
    const setup = s.setup || {};

    // Six services now: the denominator is the enrollable set (SETUP_CARDS), so
    // adding one here without adding it there would print a tile that can never
    // reach its own total.
    const services = [rx, wx, px, rs, mw, qr];
    txt("ovServices", services.filter((b) => b.running).length + "/" + services.length);
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
    txt("ovVersionV", dash(s.version));
    setPath("ovConfigPath", setup.config_path || s.config_path);
    setPath("ovStorageDir", rx.storage_dir);
    setPath("ovLogsDir", s.logs_dir);

    renderOvDests(s);
    renderOvLast(s);
  }

  /* ── The desktop shell's update notice ───────────────────────────
     The Electron shell publishes window.carinoDesktop (its preload.js); a
     browser has nothing there, none of this runs, and the <a> stays hidden
     exactly as it was served. That is the whole compatibility story — one
     feature test, no fallback, no polling, nothing to strip for the web build.

     It is a suffix on the Version row and nowhere else: no toast, no banner, no
     startup modal, nothing that moves the layout or has to be dismissed. The
     shell announces on every page load as well as on every discovery, so this
     never has to ask twice. */
  let desktopUpdate = null;

  function paintDesktopUpdate() {
    const a = $("ovVersionUpd");
    if (!a) return;
    if (!desktopUpdate) { a.hidden = true; a.textContent = ""; return; }
    // Reads "1.1.0 · 1.2.0 available ↗". The separator and the arrow are
    // punctuation between two values and stay out of the dictionary; only the
    // sentence is translated, as one literal so i18n-parity can see it.
    a.textContent = "· " + TF("{v} available", { v: desktopUpdate.version }) + " ↗";
    a.hidden = false;
  }

  function initDesktopShell() {
    const d = window.carinoDesktop;
    if (!d || typeof d.onUpdate !== "function") return;
    const a = $("ovVersionUpd");
    if (a) {
      a.addEventListener("click", (ev) => {
        // The shell opens it in the user's real browser. preventDefault stops
        // the anchor from also navigating, which would open the page twice; the
        // href stays in the markup so the link is a real one — hoverable,
        // focusable, and still correct if it is ever middle-clicked instead.
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
    // "Q/R" is the protocol's own abbreviation and stays untranslated in every
    // locale — the chip is ~10 characters wide and the Russian noun is not.
    { key: "qr", label: "Q/R",       toggle: "qrToggle" },
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
      // Born disabled. This runs at DOMContentLoaded, before boot()'s
      // GET /api/auth has resolved, and can() answers true for everyone until
      // profilesOn is known — so starting enabled would arm six service
      // switches for a receptionist for the length of that round-trip.
      // applyCapabilities() enables them a moment later if the profile holds
      // services.control.
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
  /* Who may WORK the chips — not who may see them.
     Service state is not privileged: web.py's _STATUS_GATES withholds
     destinations, routing, disk, pending, stuck, ris, audit and notify from a
     profile that lacks the capability, and deliberately does not withhold
     receiver / watcher / printer / mwl / qr. Every profile already gets live
     service state on the 2s poll, and the ungated Overview prints it as the
     "Services on" tile. So hiding these chips would take the department's only
     always-on-screen "the receiver is dead" indicator away from the two people
     standing nearest the modality while disclosing nothing.
     The defect is the chip's CLICK — six unconfirmed service stops in the
     permanent chrome, which the server then refuses with a 403 for anyone
     without services.control. Disable the button, keep the dot.
     Re-asserted from applyCapabilities() on every poll rather than at mount,
     because mountServiceChips() returns early once #svcNav exists and a
     mount-time assignment would run exactly once. */
  function chipAuthority() {
    const allowed = can("services.control");
    NAV_SERVICES.forEach((svc) => {
      const chip = document.getElementById("nav_" + svc.key);
      if (!chip) return;
      chip.disabled = !allowed;
      chip.title = chipTitle(svc, chip, allowed);
    });
  }
  /* A count badge beside a nav row. Hidden at zero — a badge that reads "0" is
     an alarm that is always on — and named for a screen reader, since the glyph
     and the colour are the only things a sighted reader has to tell two badges
     on one row apart. */
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
    // Read-only: say what it IS, since the reader can no longer ask it to change.
    return chip.dataset.on === "true"
      ? TF("{svc} — running", { svc: name })
      : TF("{svc} — stopped", { svc: name });
  }
  // Re-label the already-mounted chips after a language switch.
  function relabelServiceChips() {
    NAV_SERVICES.forEach((svc) => {
      const chip = document.getElementById("nav_" + svc.key);
      if (!chip) return;
      chip.title = chipTitle(svc, chip, can("services.control"));
      const lab = chip.querySelector(".svc-chip-label");
      if (lab) lab.textContent = T(svc.label);
    });
  }
  function setChip(key, on) {
    const chip = document.getElementById("nav_" + key);
    if (!chip) return;
    chip.dataset.on = String(!!on);
    chip.classList.toggle("on", !!on);
    // The read-only title names the state, so it has to follow the state.
    if (chip.disabled) {
      const svc = NAV_SERVICES.find((s) => s.key === key);
      if (svc) chip.title = chipTitle(svc, chip, false);
    }
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

  /* ── An order arrived ────────────────────────────────────────────
     During an outage the front desk types orders straight into this dashboard,
     and the people who have to act on one are not looking at the screen when it
     lands. So an arrival is announced on four surfaces at once, and three of
     them are silent: the nav row and its badge flash, the RIS card's LED and
     the navbar chip pulse (only while the HL7 listener is running — which is
     exactly why they cannot be the primary signal, since a hand-keyed order
     during an outage is routinely queued with that listener stopped), a polite
     live region speaks it, and the Orders list repaints if it is open.
     Deliberately NOT flashNote(): that toast is the outcome of a click the
     operator just made, and an unattended toast every time HL7 fires teaches
     people to ignore the one control that means "your click did something". */

  // The same restart trick blink() and pulseChip() use, on an element that has
  // no "running" state to guard on.
  function pulseAlert(id) {
    const el = document.getElementById(id);
    if (!el || el.hidden) return;
    el.classList.remove("alert");
    void el.offsetWidth;
    el.classList.add("alert");
  }

  let arrivalClear = null, arrivalPaint = null, arrivalPending = 0;
  /* #ordAlertLive ships EMPTY and carries no data-i18n, so the language pass
     cannot write a stale placeholder over a live announcement (the #ovTickerMsg
     trap). Cleared after a few seconds so the region is quiet again before the
     next arrival, and the pending clear is cancelled first — two arrivals in a
     row must not cut each other's sentence short.

     The region is emptied and rewritten a tick later rather than overwritten in
     place. Two single-order arrivals inside the same window produce the
     identical sentence, and screen readers that diff a live region against what
     it last held (NVDA and JAWS both do) treat "1 new order" → "1 new order" as
     no change and say nothing for the second one. The blank in between is what
     makes the second announcement a change. A timer, not rAF: a backgrounded
     tab pauses animation frames, and this is the one surface that still works
     for somebody who cannot see the flash. */
  function announceArrival(n) {
    const el = $("ordAlertLive");
    if (!el) return;
    clearTimeout(arrivalClear);
    el.textContent = "";
    // A second arrival inside that blank window is ADDED to the sentence still
    // waiting to be written rather than replacing it. The gap exists to make
    // the next announcement a change the screen reader will speak; it must not
    // become a way to drop a count on the floor.
    arrivalPending += n;
    if (arrivalPaint) return;
    arrivalPaint = setTimeout(() => {
      const total = arrivalPending;
      arrivalPending = 0;
      arrivalPaint = null;
      el.textContent = TN(total, "{n} new orders");
      arrivalClear = setTimeout(() => { el.textContent = ""; }, 5000);
    }, 50);
  }

  /* Arrivals announced while the document was hidden, waiting to be shown
     again. The flash is a CSS animation on the document timeline, and that
     timeline keeps running for a tab nobody is looking at while nothing is
     being painted — so an order that lands in a background tab spends its
     three pulses invisibly and there is nothing left on screen by the time the
     operator switches over. The badge count is the only residue, and it is
     hidden at zero, so a create matched by a C-STORE in the same stretch leaves
     literally nothing. Counted here and re-shown on return. */
  let hiddenArrivals = 0;

  function onOrderArrived(n) {
    // Same reason flashNote() bails: behind the prompt there is nobody to tell,
    // and the baselines have been dropped anyway.
    if (gateOpen) return;
    if (document.hidden) hiddenArrivals += n;
    // The badge alone is not enough — it is hidden at zero on purpose, so an
    // order created and matched inside one 2 s poll would leave nothing on
    // screen. The nav row is always there for anyone with orders.read.
    pulseAlert("navOrders");
    pulseAlert("ordersBadge");
    blink($("rsDot"));
    pulseChip("rs");
    announceArrival(n);
    beepNewOrder();
  }

  /* Coming back to a tab that was in the background. Two separate repairs, and
     they are separate because a hidden tab fails the alert twice over.

     The poll first. Chrome clamps timers in a hidden page and, past five
     minutes hidden, throttles them intensively to once a minute — so the 2 s
     interval at startPollers() can be up to a minute late in noticing an order
     that is already queued. Polling on the way back collapses that to the
     moment somebody looks, which is the only moment it matters.

     Then the flash, re-fired for whatever landed while nobody could see it. The
     alert is deliberately not gated on document.hidden — it exists for a screen
     nobody is watching, and the beep does reach the room from a background tab
     — but the VISIBLE half is spent on an empty screen, and a front desk whose
     sound is muted or not yet armed had nothing else. Deliberately not a second
     beep: the tone, if it was ever going to play, already played at the real
     arrival, and chirping at somebody who has just clicked into the page says
     "something just arrived" about something that did not. */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    pollStatus();
    const n = hiddenArrivals;
    hiddenArrivals = 0;
    // Same bail as onOrderArrived: behind the prompt there is nobody to tell.
    if (!n || gateOpen) return;
    pulseAlert("navOrders");
    pulseAlert("ordersBadge");
    announceArrival(n);
  });

  /* ── The arrival beep ────────────────────────────────────────────
     Per workstation, and stored in localStorage rather than in the server
     config, because the people this alert is FOR cannot reach the server
     config: Reception holds orders.read/orders.write/studies.read and the
     radiologist holds studies.read/studies.send/orders.read — neither holds
     config.read, and GET /api/config is gated on it. A web.* toggle would be
     settable only by the one role that never receives the ris block at all.
     Per-workstation is also the right answer on its own: a shared reception PC
     and a tech's reading screen want different things.
     app.js writes no other browser storage, so this is a precedent inside this
     file; it follows carino-lang.js exactly — store only the deviation, clear
     the key to return to the default, and try/catch every access because a
     private-mode window throws on the property itself. */
  const BEEP_KEY = "carino_pacs_order_beep";
  function beepOn() {
    // Unreadable storage falls back to SOUND ON. A reception PC that silently
    // lost its preference must fail loud: an alert that defaults to silent is
    // not an alert.
    try { return localStorage.getItem(BEEP_KEY) !== "off"; } catch (e) { return true; }
  }
  function setBeepOn(on) {
    try { on ? localStorage.removeItem(BEEP_KEY) : localStorage.setItem(BEEP_KEY, "off"); } catch (e) { /* private mode */ }
  }

  /* The tone is SYNTHESISED, not shipped. This appliance installs offline and
     runs from a packaged folder, so an alert that depends on a sound file is an
     alert somebody can delete; a generated one costs zero bytes in the package
     and cannot go missing. WebAudio and not the Notification API: the dashboard
     is served over plain HTTP, so every workstation that is not localhost is a
     non-secure context, where notifications are unavailable by spec — WebAudio
     is not secure-context gated and works there. */
  let actx = null, audioFailed = false, beepFreeAt = 0;
  /* Deadline for a tone that was asked for while the context was not running,
     and 0 for "nothing owed". Not the audio clock, on purpose: the whole point
     of the debt is that the audio clock may be stopped. Not the wall clock
     either, though it was at first — performance.now() is monotonic and is a
     different clock from the audio one, so it costs nothing to be right here.
     An appliance PC does see its wall clock step: an RTC correction or an NTP
     step inside the four seconds either pays a tone twenty minutes after the
     order it claims to be announcing (a step backwards) or silences a real
     arrival (a step forwards), and both are exactly what the deadline exists to
     prevent. The fallback keeps a browser without performance.now() working on
     the wall clock rather than owing a tone forever. */
  const monoNow = () => (window.performance && performance.now ? performance.now() : Date.now());
  let beepDueBy = 0;
  /* HOW MANY arrivals are owed a tone, not merely whether any is. The debt used
     to be the deadline alone, which is one flag: two orders landing seconds
     apart into a suspended context — the receptionist queueing one by hand
     while the reconnecting RIS flushes another, which is exactly the pair
     emitBeep() refuses to collapse — bought a single chirp between them,
     because the second arrival overwrote the first's debt instead of adding to
     it. The deadline stays a single value and is carried by the newest arrival:
     it answers a different question, "is this news still fresh enough to chirp
     about at all", and the newest arrival is the one that settles it. How many
     of the owed tones actually reach the speaker is then emitBeep()'s decision
     as it is for every other arrival — it spaces them so that two read as two,
     and drops a queue deeper than two seconds as history. */
  let beepOwed = 0;

  /* The one question the rest of this file asks about audio, and the one the
     button is painted from: can a tone actually be produced right now? A
     context that exists but is "suspended" answers no — the browser is still
     waiting for a gesture — and saying otherwise is how the control ends up
     claiming the alert is on while the page is structurally incapable of
     making a sound. */
  function audioReady() { return !!(actx && actx.state === "running"); }

  function armAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        audioFailed = true;                   // no WebAudio here: stay silent, stay visible, SAY SO
      } else {
        // A CLOSED context counts as no context, and that is not a theoretical
        // state: close() is never called in this file, but the user agent is
        // allowed to close one on its own and Chromium does when the output
        // device goes away — the front desk's USB speaker being unplugged
        // mid-shift is the whole scenario. A closed context can never be
        // resumed, so treating it as "already have one" left the page
        // permanently silent with a button that kept inviting a click which
        // did nothing. Building a fresh one is the only recovery there is.
        if (!actx || actx.state === "closed") {
          actx = new AC();
          // The queue clock belongs to the context that is going away: a fresh
          // AudioContext starts its currentTime at zero, so a beepFreeAt left
          // over from a context that had been running for minutes sits far in
          // the new one's future and every later arrival is dropped by the
          // "queue deeper than two seconds" guard — permanently silent, with
          // the button still promising sound.
          beepFreeAt = 0;
          // The context tells us when it stops being able to play, which is
          // the only way the button learns it without waiting for the next
          // arrival or the next click. Without this the control goes on
          // reading "🔔 Sound" for however long it takes something else to
          // repaint it — the exact lie the three-state label exists to stop.
          actx.onstatechange = afterArm;
        }
        audioFailed = false;
        // resume() settles a turn later, so the button cannot be painted from
        // its result synchronously — it is repainted again when it does. The
        // promise is checked for rather than assumed: the prefixed
        // webkitAudioContext of an older Safari takes a callback and returns
        // nothing, and reaching for .then on that throws out of this whole
        // function. onstatechange above is what covers those browsers instead,
        // since the transition to "running" repaints either way.
        if (actx.state === "suspended") {
          const p = actx.resume();
          if (p && typeof p.then === "function") p.then(afterArm, afterArm);
        }
      }
    } catch (e) {
      // Never let audio break a status poll — but only a context that could not
      // be BUILT means this PC cannot play sound. A throw from anything after
      // the constructor (resume() on a legacy implementation is the realistic
      // one) must not discard a context that is alive and running, because
      // doing so paints "This PC cannot play sound" over a working speaker and
      // sends the operator looking for a fault that is not there.
      if (!actx || actx.state === "closed") {
        actx = null;
        audioFailed = true;
      }
    }
    afterArm();
  }
  /* The gesture listeners are bound to READINESS rather than bound once and
     dropped on the first success. Dropping them was already an improvement on
     { once: true }, but it made success a one-way door: a context that was
     running and then died — device removed, renderer reclaimed it — could no
     longer be re-armed by the operator's next click anywhere, because there was
     nothing left listening for it. The only paths back were the next arrival
     (too late for that arrival) and the mute button itself. So they go back on
     whenever sound stops being possible, and come off again as soon as it is.
     The flag is not there to make this idempotent — addEventListener already
     ignores a duplicate registration — but to state what is bound, since this
     now runs on every gesture and on every state change the context reports. */
  let armListening = false;
  function listenForGesture(on) {
    if (on === armListening) return;
    armListening = on;
    if (on) {
      window.addEventListener("pointerdown", armAudio);
      window.addEventListener("keydown", armAudio);
    } else {
      window.removeEventListener("pointerdown", armAudio);
      window.removeEventListener("keydown", armAudio);
    }
  }
  function afterArm() {
    listenForGesture(!audioReady());
    /* The arrival that found the context asleep still gets its tone. A context
       can be running when the page is armed and suspended by the time an order
       lands — iOS suspends one whenever the tab goes to the background, and a
       machine coming back from sleep does the same — and resume() then succeeds
       a turn later off the page's sticky activation, with nobody having done
       anything. Dropping the beep for that arrival meant the FIRST order after
       every backgrounding was silent, repeatably. The deadline is what keeps
       this from becoming a delayed surprise: if sound only becomes possible
       minutes later, because the operator finally clicked, the order is old news
       and they are already looking at the screen — chirping then would say
       "something just arrived" about something that did not.

       The mute is re-read HERE rather than trusted from when the debt was
       taken on. beepNewOrder() checked the preference at the arrival, but the
       preference lives in localStorage and is shared by every tab on the
       workstation, so it can change between owing the tone and paying it: a
       backgrounded tab owes a chirp, the operator mutes at the tab in front of
       them, and this tab then comes forward and beeps at a workstation whose
       control says silent. A debt is an intention to beep, not a licence. */
    if (beepOwed) {
      if (monoNow() > beepDueBy || !beepOn()) { beepOwed = 0; beepDueBy = 0; }
      else if (audioReady()) {
        // Cleared before the tones are queued rather than after, so nothing
        // that runs while they are being scheduled can find the debt still
        // standing and pay it a second time.
        const owed = beepOwed;
        beepOwed = 0;
        beepDueBy = 0;
        for (let i = 0; i < owed; i++) emitBeep();
      }
    }
    paintBeepBtn();
  }
  // Signing in is a pointerdown, so a gated appliance is armed by the very
  // click that opens the dashboard, and an ungated one by the operator's first
  // click anywhere — no special case in doLogin is needed.
  listenForGesture(true);
  /* Tried once at load as well, because the workstation this alert exists for
     is the one nobody is sitting at: a kiosk autostart, a restored session or
     an F5 (the keypress landed on the PREVIOUS page) reaches a dashboard that
     never receives a gesture at all, and the loopback appliance opens with no
     sign-in prompt to click through. Where the browser's autoplay policy allows
     it — a kiosk switch, or a site the operator has used all shift — this
     succeeds outright and the alert is armed with nobody present. Where it does
     not, the context still gets built, state stays "suspended", and the button
     tells the operator the truth instead of a comfortable lie. */
  armAudio();

  function beepNewOrder() {
    try {
      if (!beepOn()) return;
      if (!audioReady()) {
        // Ask again — a context can be suspended long after it was armed (the
        // browser reclaims one on some platforms, and iOS suspends one for
        // every backgrounded tab) — and repaint, so the moment sound stops
        // being possible is the moment the button stops promising it. The tone
        // is not abandoned: it is owed for the next few seconds, and afterArm()
        // pays it the instant the context runs, which for a resume off sticky
        // activation is a turn later and inaudibly soon. If nothing can wake
        // the context the debt expires and this arrival is silent — the flash
        // and the live region already fired, which is exactly why they are not
        // optional.
        // Counted and not flagged: a second arrival inside this window is a
        // second order, and the floor owes it a second tone.
        beepOwed += 1;
        beepDueBy = monoNow() + 4000;
        armAudio();
        return;
      }
      emitBeep();
    } catch (e) { /* a hostile audio stack must never take the poll loop down */ }
  }

  /* The tone itself, split from the decision to make one so that afterArm() can
     pay a debt beepNewOrder() could not. Every caller has already established
     that sound is wanted and that the context is running. */
  function emitBeep() {
    try {
      /* No time floor. The floor that used to live here claimed to stop a burst
         machine-gunning, but a burst between two polls ALREADY collapses into a
         single onOrderArrived(n) through the created_seq diff, so it never once
         suppressed the case it was written for. Every call that reaches this
         line is a separate arrival detected by a separate status response — the
         HL7 order that lands while the receptionist is queueing one by hand is
         precisely the pair the floor was eating, and it is precisely the pair
         that must both be heard.
         What is left worth preventing is two chirps landing on top of each
         other and reading as noise rather than as two orders. So a beep is
         QUEUED on the audio clock instead of being dropped: it starts when the
         previous one has finished, which costs a third of a second and loses
         nothing. The one thing that is dropped is a queue already more than two
         seconds deep — past that the speaker would be reporting history, and a
         flood of that size has the badge count and the list to speak for it. */
      const now = actx.currentTime;
      const t0 = Math.max(now + 0.01, beepFreeAt);
      if (t0 - now > 2) return;
      beepFreeAt = t0 + 0.34;                     // 0.31 of tone plus a gap, so two are two
      // Two short rising sine chirps, A5 -> D6. Rising reads as "something
      // arrived", not "something failed", and two notes survive a noisy front
      // desk in a way one does not. Peak 0.09 is deliberately low: the
      // workstation's volume is unknown and this repeats all shift.
      [[880, 0], [1174.66, 0.18]].forEach(([hz, at]) => {
        const osc = actx.createOscillator(), g = actx.createGain();
        osc.type = "sine";                        // no harmonics to go shrill on cheap PC speakers
        osc.frequency.value = hz;
        const s = t0 + at;
        // Ramped, not switched: a bare start/stop on a non-zero gain clicks.
        // Never ramp exponentially to literal 0.
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.09, s + 0.010);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.12);
        osc.connect(g); g.connect(actx.destination);
        osc.start(s); osc.stop(s + 0.13);
        osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch (e) {} };
      });
    } catch (e) { /* a hostile audio stack must never take the poll loop down */ }
  }

  /* #ordBeep ships with no text and no data-i18n: its label, title and spoken
     name all depend on the state, so they are written here instead. Called at
     startup, whenever arming is attempted, and again on a language change,
     since the static pass cannot reach a label JS owns. aria-pressed mirrors
     MUTED — the button is a mute.

     THREE states, not two, because the preference is only half the answer.
     "Sound is on" and "sound can play" are different facts: the localStorage
     preference says nothing about whether this page ever received the gesture
     the browser demands, and a workstation that was never touched has the
     preference ON and no audio context at all. Painting the preference alone is
     how the button came to read "🔔 Sound" on a page that could not beep for
     anything. The unarmed state is a distinct label so it is visible across the
     room, and the two reasons for it — waiting for a click, versus a browser
     with no usable audio at all — differ in the tooltip, because the first is
     something the operator can fix in one click and the second is not. */
  function paintBeepBtn() {
    const btn = $("ordBeep");
    if (!btn) return;
    const on = beepOn();
    const ready = audioReady();
    let label, tip;
    if (!on) {
      label = T("🔕 Muted");
      tip = T("New orders are silent on this PC — click to unmute");
    } else if (ready) {
      label = T("🔔 Sound");
      tip = T("New orders beep on this PC — click to mute");
    } else {
      label = T("🔔 Arm sound");
      tip = audioFailed
        ? T("This PC cannot play sound — new orders still flash on screen")
        : T("Sound is not armed on this PC — click to enable the order beep");
    }
    btn.textContent = label;
    btn.title = tip;
    btn.setAttribute("aria-label", tip);
    btn.setAttribute("aria-pressed", on ? "false" : "true");
  }
  /* The preference is localStorage, so it belongs to the WORKSTATION and not to
     this tab — and a front desk really does keep two open, the orders list on
     one screen and the queue on the other. Every other reader of it re-reads at
     the moment it matters (beepNewOrder() at the arrival, the click handler at
     the click), so the only thing that can fall out of date is the label. Mute
     in one tab and the other went on reading "🔔 Sound" while beeping; unmute
     and it read "🔕 Muted" while beeping. The control has to describe what the
     machine does, and one tab over it was describing the opposite.

     The event only ever fires in the OTHER tabs, never the one that wrote, so
     this cannot race the click handler's own paint. A null key is a
     localStorage.clear(), which returns the preference to its ON default and
     must repaint too. Anything owed by a tab that has just been muted elsewhere
     is dropped here as well as at the payment, so the debt does not sit around
     looking like a pending beep. */
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== BEEP_KEY) return;
    if (!beepOn()) { beepOwed = 0; beepDueBy = 0; }
    paintBeepBtn();
  });

  /* Everything this session is still OWED, dropped together, because the prompt
     going up is the moment all of it stops being true. Each one of these is an
     alert that has been decided on and not yet delivered, and by the time
     somebody answers the prompt they all say the same wrong thing: the orders
     behind them are already on the list in front of whoever signs back in, so
     delivering them then is announcing history.

     One function rather than a run of assignments at the prompt, because a run
     of assignments is what let this drift: the two baselines were dropped
     first, the hidden-arrival count was added beside them later, the deferred
     tone later still, and the live region's pending sentence was missed
     altogether — it is written from a 50 ms timer, and a status response
     carrying an arrival genuinely does land milliseconds before a 401 at a
     token expiry, so the region spoke behind the prompt. That announcement is
     the only one the order would ever get, since the first poll after signing
     back in adopts the backlog in silence by design. The next deferred alert
     anybody adds belongs in here, where the whole list of them is in one place
     and cannot be forgotten again. */
  function dropSessionAlerts() {
    // The arrival baselines: with no baseline the first poll back ADOPTS the
    // backlog instead of announcing it.
    lastCreatedSeq = null;
    lastOrderCounts = null;
    // The arrivals a hidden tab was holding on to so it could flash for them
    // when somebody came back to it.
    hiddenArrivals = 0;
    // The tones owed by a context that was asleep when they arrived. Answering
    // this prompt is a pointerdown, so it arms the audio and afterArm() would
    // pay the debt right there — a chirp announcing "an order just arrived" to
    // somebody who is still typing their token.
    beepOwed = 0;
    beepDueBy = 0;
    // The live region's pending sentence, and the clear scheduled behind it.
    // The gate is only a fixed overlay painted over the dashboard — nothing
    // marks the page inert or aria-hidden — so a polite region that is written
    // now is read out over the sign-in prompt.
    clearTimeout(arrivalPaint);
    clearTimeout(arrivalClear);
    arrivalPaint = null;
    arrivalClear = null;
    arrivalPending = 0;
    // Emptying a live region is not itself an announcement, so this is safe to
    // do to a sentence that was already spoken, and it leaves nothing for the
    // language pass or the next arrival to find.
    const live = $("ordAlertLive");
    if (live) live.textContent = "";
  }

  /* The status poll carries the arrival edge, so it needs the same in-flight
     token loadOrders() has — and for a sharper reason. Two /api/status requests
     are genuinely in flight at once: the 2 s interval runs alongside the dozen
     imperative pollStatus() calls that follow a click, and the engine serves
     them on separate threads, so a slow one can land after a fast one. An
     out-of-order payload carries a STALE created_seq, which renderStatus reads
     as `seq < lastCreatedSeq` — the engine-restart branch — and quietly
     regresses the baseline; the next poll then announces the same order a
     second time. Nothing in the payload distinguishes a stale response from a
     restarted engine, so the ordering has to be decided here, where it is
     known. A superseded response is simply dropped — but "superseded" means
     something newer has been DRAWN, not merely issued (see the watermark
     below), because a request that is issued is not a promise that anything
     will ever be painted.

     The gate is re-checked AFTER the await as well as before. stopPollers()
     cancels the timers but cannot cancel a request already on the wire, so a
     response issued while somebody was signed in can resolve after the prompt
     went up — and showAuthGate() has just nulled the baselines precisely so
     that the backlog which accumulates behind the prompt is never announced.
     Letting that response render would re-adopt the pre-prompt baseline and
     hand the whole backlog to the first poll after sign-in. */
  let statusReq = 0;     // issued
  let statusSeen = 0;    // the newest one that has actually been RENDERED
  async function pollStatus() {
    if (gateOpen) return;          // nothing to poll for while the prompt is up
    const req = ++statusReq;
    try {
      const s = await api("/api/status");
      /* Superseded by something already DRAWN, or the session ended.
         Compared against the rendered watermark and not against the issue
         counter, which is the difference between dropping a stale payload and
         starving: the interval issues a poll every 2 s whatever the engine is
         doing, so the moment a response takes longer than that there is always
         a newer request in flight and `req !== statusReq` was true for every
         single one of them — forever. A NAS holding scp.storage_dir going
         unresponsive (shutil.disk_usage and idx.stats() are on this path for
         every profile, gated out of the payload but not out of the work) left
         the dashboard permanently unpainted: no arrival edge, no badges, no
         Orders repaint, and no error either, because api() neither times out
         nor rejects. Against the watermark the newest response to LAND always
         renders and the older ones are still dropped, so the ordering repair
         keeps its whole effect and the failure mode is gone.
         There is deliberately no time floor anywhere near this: two arrivals
         one second apart are two arrivals, and the created_seq diff below
         already collapses a burst inside one poll into a single announcement
         carrying the right count. */
      if (req <= statusSeen || gateOpen) return;
      statusSeen = req;
      renderStatus(s);
    } catch (e) { /* keep last */ }
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
        if (sawQr) { blink($("qrDot")); pulseChip("qr"); }
      }
      firstLog = false;
    } catch (e) { /* ignore */ }
  }

  /* ── Config load / populate ──────────────────────────────────── */
  async function loadConfig() {
    const c = await api("/api/config");
    loadedModalities = Array.isArray(c.modalities) ? c.modalities : [];
    loadedWorklistSource = c.worklist_source || {};
    $("wsHost").value = loadedWorklistSource.host || "";
    $("wsPort").value = loadedWorklistSource.port || 105;
    $("wsAet").value = loadedWorklistSource.aet || "";
    $("wsTls").checked = !!loadedWorklistSource.tls;
    renderMods(loadedModalities);
    // The richer of the two copies of the registry has just landed, so both
    // targeting controls are rebuilt from it rather than from the status
    // payload's copy they were holding.
    refreshTargetChoices();
    loadedScp = c.scp || {};
    loadedScu = c.scu || {};
    loadedPrint = c.print || {};
    loadedRis = c.ris || {};
    loadedMwl = c.mwl || {};
    loadedEmg = c.emergency || {};
    loadedQr = c.qr || {};
    loadedDicomweb = c.dicomweb || {};
    loadedRouting = c.routing || {};
    loadedIndex = c.index || {};
    loadedDeid = c.deid || {};
    loadedAudit = c.audit || {};
    loadedNotify = c.notify || {};
    loadedSetup = c.setup_completed || "";
    loadedLogsDir = c.logs_dir || "";
    readWebSection(c.web || {});
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
    const qc = c.qr || {};
    $("qrEnabled").checked = !!qc.enabled;
    $("qrAetIn").value = qc.aet || "CARINOQR";
    $("qrBind").value = qc.bind || "0.0.0.0";
    $("qrPort").value = qc.port != null ? qc.port : 11115;
    $("qrAllowed").value = (qc.allowed_aets || []).join(", ");
    $("qrTlsIn").checked = !!qc.tls;
    $("qrTlsCert").value = qc.tls_cert || "";
    $("qrTlsKey").value = qc.tls_key || "";
    $("qrTlsCa").value = qc.tls_ca || "";
    // The C-MOVE map is carried through a save untouched (no form control), so
    // the only thing owed to the operator here is what it currently resolves.
    const moves = Object.keys(qc.move_destinations || {});
    $("qrMoveDests").textContent = moves.length
      ? TF("C-MOVE destinations resolved by AE title: {aets}", { aets: moves.join(", ") })
      : T("No C-MOVE destinations configured — a C-MOVE naming an unknown AE title is refused.");
    const dw = c.dicomweb || {};
    $("dwEnabled").checked = !!dw.enabled;
    $("dwStow").checked = dw.allow_stow !== false;
    $("dwCors").value = (dw.cors_origins || []).join(", ");
    const ic = c.index || {};
    $("idxEnabled").checked = ic.enabled !== false;
    $("idxPath").value = ic.path || "./index.db";
    $("idxRescan").checked = ic.rescan_on_start !== false;
    const dd = c.deid || {};
    $("deidProfile").value = ["off", "basic", "strict"].indexOf(dd.profile) >= 0 ? dd.profile : "basic";
    $("deidKeepPrivate").checked = !!dd.keep_private;
    $("deidKeepDates").checked = !!dd.keep_dates;
    $("deidPrefix").value = dd.prefix || "ANON";
    renderDests(c.destinations || []);
    // After the destination table, so a rule's checkboxes are built from the
    // node list that is actually on screen.
    $("rtEnabled").checked = !!(c.routing && c.routing.enabled);
    renderRules((c.routing && c.routing.rules) || []);
    renderAuthState();
    reflowActive();
  }

  /* ── web.auth_token is not a config field the dashboard can write ──
     GET /api/config redacts it (it answers with web.auth_token_set, a boolean)
     and POST /api/config refuses a token outright — the secret leaves the
     server only in the reply to the call that mints it. So a Save NEVER carries
     one: the snapshot drops the key and the read-only mirror beside it, and the
     token changes only through applyToken() below.
     Sending a redaction back as if it were the value would replace a working
     credential with punctuation and lock the operator out of their own PACS, so
     the rule is the narrow one: post it only if it is plainly the token itself,
     which after the redaction landed is never. */
  const AUTH_FLAG_KEYS = ["auth_token_set", "auth_token_present", "has_auth_token", "auth_token_redacted"];
  const REDACTED_RE = /^(?:[*•·●]{3,}|\(set\)|<redacted>|redacted)$/i;
  let tokenSet = false;        // does the engine hold a token at all?

  function readWebSection(w) {
    loadedWeb = { ...w };
    delete loadedWeb.auth_token;
    AUTH_FLAG_KEYS.forEach((k) => delete loadedWeb[k]);
    const raw = w.auth_token;
    // The rule is one line: post the token back ONLY when what we were handed
    // is plainly the token itself. Anything else — absent, empty, a mask, a
    // boolean — is left out, and the engine keeps what it has. That does not
    // depend on recognising the redaction's shape, which is the part that would
    // rot: a flag we failed to recognise would otherwise read as "no token" and
    // a Save would wipe a working credential.
    const real = typeof raw === "string" && raw.trim() !== "" && !REDACTED_RE.test(raw.trim());
    if (real) loadedWeb.auth_token = raw;
    // Whether one EXISTS is a different question, and the engine answers it
    // directly (GET /api/auth, and every /api/status after it), so the state
    // line never has to infer it from a value it cannot see.
    const flag = AUTH_FLAG_KEYS.filter((k) => k in w)[0];
    tokenSet = flag !== undefined ? !!w[flag] : (real || authRequired);
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
    // Not an input: the dev peer writes this flag and removes it again. A Save
    // has to hand it back exactly as it arrived, or discarding the peer would
    // leave two destinations aimed at an archive that no longer exists — the
    // whole-document-save hazard CONTRIBUTING.md describes, one level down
    // inside a list where the loadedX snapshots cannot reach.
    tr.dataset.ephemeral = d.ephemeral ? "1" : "";
    if (d.ephemeral) {
      // ...but handing it back INVISIBLY is how an operator ends up editing
      // this row into a real destination and losing it at the next discard.
      // The flag means "the dev peer wrote this and will delete it again", so
      // the row says so. Still fully editable: enabling the black hole is
      // exactly what the demo recipe asks for.
      const why = T("Created by the dev peer — this row is deleted when the peer is discarded. Do not reuse it for a real node.");
      tr.classList.add("dest-ephemeral");
      tr.querySelector(".d-name").title = why;
      tr.querySelector(".d-host").title = why;
    }
    tr.querySelector(".del").addEventListener("click", () => tr.remove());
    tr.querySelector(".echo").addEventListener("click", () => echoRow(tr));
    $("destBody").appendChild(tr);
  }
  /* The modality registry. Same shape as the destinations table on purpose —
     they are both "a list of DICOM peers" and an operator who has edited one
     should not have to learn the other — but they are different lists: these
     pull a worklist from us, those receive studies from us. */
  function renderMods(list) {
    const body = $("modBody");
    body.innerHTML = "";
    (list || []).forEach(addModRow);
    if (!(list || []).length) addModRow({});
    const empty = $("modEmpty");
    if (empty) empty.hidden = (list || []).length > 0;
  }
  function addModRow(m) {
    const tr = I18N_IN($("modRowTpl").content.cloneNode(true)).querySelector("tr");
    tr.querySelector(".m-en").checked = m.enabled !== false;
    tr.querySelector(".m-name").value = m.name || "";
    tr.querySelector(".m-aet").value = m.aet || "";
    tr.querySelector(".m-mod").value = m.modality || "";
    tr.querySelector(".m-station").value = m.station_name || "";
    tr.querySelector(".del").addEventListener("click", () => tr.remove());
    const probe = tr.querySelector(".probe");
    if (probe) probe.addEventListener("click", () => probeModality(tr, probe));
    $("modBody").appendChild(tr);
  }
  /* Ask the other RIS what it would give one modality. The confirmation is not
     ceremony: this borrows the scanner's AE title, and two devices answering to
     one name on a network is a real conflict that nothing here can detect. */
  async function probeModality(tr, btn) {
    const aet = tr.querySelector(".m-aet").value.trim().toUpperCase();
    const name = tr.querySelector(".m-name").value.trim() || aet;
    if (!aet) { flashNote(T("Give the modality an AE title first"), false); return; }
    // One literal, not a concatenation: i18n-parity extracts the string inside
    // TF() and a joined expression reaches it as a fragment.
    if (!confirm(TF("Ask the other RIS as {aet}? Take {name} off the network first — this borrows its AE title, and two devices answering to one name will confuse the RIS.", { aet: aet, name: name }))) return;
    const old = btn.textContent; btn.textContent = "…"; btn.disabled = true;
    try {
      const r = await post("/api/worklist/probe", { station_aet: aet });
      flashNote(r.message || (r.ok ? T("Probe done") : T("Probe failed")), r.ok !== false);
      if (r.ok) loadCaught();
    } catch (e) {
      flashNote(e.message, false);
    } finally {
      btn.textContent = old; btn.disabled = false;
    }
  }

  /* What came back, newest round first. Each round is the four questions; the
     per-question split into addressed-here / addressed-to-nobody /
     addressed-elsewhere is the part that carries the diagnosis, so it is on the
     row rather than behind the item list. */
  async function loadCaught() {
    const list = $("caughtList");
    if (!list) return;
    let data;
    try {
      data = await api("/api/worklist/caught");
    } catch (e) {
      list.textContent = ""; list.appendChild(emptyNote(e.message)); return;
    }
    list.textContent = "";
    const rounds = (data && data.rounds) || [];
    if (!rounds.length) {
      list.appendChild(emptyNote(T("No probes yet.")));
      return;
    }
    rounds.forEach((rnd) => {
      const box = document.createElement("div");
      box.className = "caught-round";
      const head = document.createElement("div");
      head.className = "caught-head";
      head.textContent = TF("asked as {aet} · {host}:{port} ({called}) · {ts}", {
        aet: rnd.station_aet, host: (rnd.source || {}).host || "?",
        port: (rnd.source || {}).port || "?", called: (rnd.source || {}).aet || "?",
        ts: fmtStamp(rnd.at),
      });
      box.appendChild(head);
      (rnd.probes || []).forEach((pr) => {
        const row = document.createElement("div");
        row.className = "caught-probe" + (pr.ok ? "" : " bad");
        const q = document.createElement("span");
        q.className = "caught-q";
        q.textContent = pr.label;
        const a = document.createElement("span");
        a.className = "caught-a";
        if (!pr.ok) {
          a.textContent = pr.message;
          a.classList.add("bad");
        } else if (!pr.count) {
          a.textContent = T("nothing");
        } else {
          // Never a bare count: an order addressed to nobody reaches every
          // modality, so "3 back" can mean "nothing is scheduled here".
          const bits = [TN(pr.count, "{n} orders")];
          if (pr.for_this_station) bits.push(TF("{n} for this station", { n: pr.for_this_station }));
          if (pr.for_nobody) bits.push(TF("{n} for nobody", { n: pr.for_nobody }));
          if (pr.for_someone_else) bits.push(TF("{n} for another station", { n: pr.for_someone_else }));
          a.textContent = bits.join(" · ");
          if (pr.for_this_station) a.classList.add("good");
        }
        row.append(q, a);
        box.appendChild(row);
      });
      list.appendChild(box);
    });
  }

  function collectMods() {
    return [...$("modBody").querySelectorAll("tr")]
      .map((tr) => ({
        enabled: tr.querySelector(".m-en").checked,
        name: tr.querySelector(".m-name").value.trim(),
        // Upper-cased here rather than at the server: DICOM AE titles are
        // compared case-insensitively by the worklist but stored verbatim, and
        // two rows differing only in case are the duplicate the config
        // validator refuses. Normalising as it is typed avoids the refusal.
        aet: tr.querySelector(".m-aet").value.trim().toUpperCase(),
        modality: tr.querySelector(".m-mod").value.trim().toUpperCase(),
        station_name: tr.querySelector(".m-station").value.trim(),
      }))
      .filter((m) => m.name && m.aet);
  }

  // Whether the Modalities tab's inputs are the current truth. If the operator
  // has never opened it this session the rows were still drawn from the loaded
  // config, so either source is the same — but if the pane is absent entirely
  // (a profile without config.read) the snapshot is the only one there is.
  function modsOpen() { return !!document.getElementById("modBody"); }

  /* This department's registered equipment, from whichever copy of it the
     person at this keyboard is allowed to have.

     There are two and they carry the same rooms. loadConfig() fills
     loadedModalities for a profile with config.read, and the Modalities tab
     edits that copy in place, so it is the fresher of the two for whoever can
     see it. Everyone else — reception above all, who holds orders.read and
     nothing resembling config.read — receives the same list on the status
     payload. Asking here rather than at each call site is what lets the order
     form's target field be a closed list at the front desk, which is the one
     place it has to be one. */
  function knownModalities() {
    const src = (loadedModalities && loadedModalities.length) ? loadedModalities : statusModalities;
    return (src || []).filter((m) => m && m.enabled !== false && m.aet);
  }

  /* The DICOM modality codes some console on this appliance actually answers
     to — or nothing at all, whenever the registry is not in a position to say.

     An empty set means "not known" and never "none". Four situations arrive
     here looking identical: no registry at all, a status payload older than the
     station list, a registry of rooms that carry an AE title and no code, and a
     registry where even ONE room is missing its code. Every caller has to read
     empty as "do not judge the operator's choice" rather than as an accusation.

     That last situation is why this reads the rows itself instead of going
     through knownModalities(), and it is worth being exact about. The modality
     code is OPTIONAL in config.py — the validator demands a name and an AE
     title and nothing else — so a room may be registered by the two fields that
     make it reachable and never by the one that says what it is. A registry
     like that cannot support the sentence "no console here answers to CT",
     because the console that answers to CT may be precisely the room whose code
     was never filled in. Half a registry is not a smaller registry; it is a
     registry that cannot answer this question, and answering anyway turns a
     correct order into a red warning. A safety sentence that cries wolf is
     wrong twice — now, and on the day it is right and nobody reads it.

     `enabled` is deliberately ignored, for the same reason the server asks
     station_list() rather than station_list(usable_only=True) in
     _station_is_unknown(): the flag governs what this appliance SENDS studies
     to, not what pulls a worklist, so a room switched off still answers to its
     own code when its console queries. Filtering on it would raise the warning
     over the department whose only CT is ticked out of service for the
     afternoon — the shift that can least afford a wrong order. */
  function configuredModalityCodes() {
    /* The same two copies knownModalities() chooses between, and chosen the
       same way, because the reason is the same: an administrator has the
       config, reception has only the status payload, and both carry every
       registered room including the disabled ones (server.station_list()). */
    const rows = (loadedModalities && loadedModalities.length) ? loadedModalities : statusModalities;
    const out = new Set();
    for (const m of (rows || [])) {
      if (!m) continue;
      const code = String(m.modality || "").trim().toUpperCase();
      // One room whose code was left blank, and the whole set goes back empty:
      // "cannot tell" has to travel as "not known", never as a shorter list of
      // what is known, which is what would accuse the operator of the gap.
      if (!code) return new Set();
      out.add(code);
    }
    return out;
  }

  /* Both targeting controls are built from that registry, so they are refilled
     together: the station list offers the rooms, and the modality list marks
     which codes those rooms answer to. */
  function refreshTargetChoices() {
    registryChanged();          // adopt the signature, so the next poll does not redo this
    fillStationChoices();
    fillModalityChoices();
  }

  /* Has the registry moved since the form was last built? renderStatus asks
     every two seconds, and rebuilding a <select> is not free — an operator with
     the list open would have it shut under them, and a rebuild is also the only
     moment their half-made choice has to be carried across. */
  let registrySig = null;
  function registryChanged() {
    const sig = JSON.stringify(knownModalities().map((m) => [m.aet, m.modality || "", m.name || ""]));
    if (sig === registrySig) return false;
    registrySig = sig;
    return true;
  }

  /* The order form's target field.

     ScheduledStationAETitle is matched on the wire by exact string — mwl.py's
     lenient rule is lenient about a BLANK order, not about a wrong one — so
     this is the modality field above it wearing a different name, and it fails
     the same way: a room called "SALA CT" typed where an AE title goes produces
     an order every station-filtered console misses, while reception is told the
     Modality Worklist is serving it. So with a registry in hand the field
     cannot express anything but an AE title a console answers to, and the blank
     choice — the one that shows the order on every worklist — stays first.

     It is built from knownModalities(), which is what makes it reachable at the
     front desk at all: the copy in /api/config is behind config.read and the
     copy on the status payload is not.

     With NO registry it stays the free-text AE title it has always been,
     because an order that cannot be aimed at all is worse than one aimed at a
     typo — and that is also how this degrades on an appliance whose status
     payload does not carry the station list yet. */
  function fillStationChoices() {
    const sel = $("ordStationSel"), txt = $("ordStation");
    if (!sel || !txt) return;
    const mods = knownModalities();
    if (!mods.length) {
      sel.hidden = true; txt.hidden = false;
      return;
    }
    const chosen = sel.value || txt.value;
    sel.textContent = "";
    // An order with no target appears on EVERY worklist. That is right during
    // an outage and wrong when testing one room, so it is offered as a named
    // choice rather than left as the accident of an empty field.
    const any = document.createElement("option");
    any.value = ""; any.textContent = T("Any modality — shows on every worklist");
    sel.appendChild(any);
    mods.forEach((m) => {
      const o = document.createElement("option");
      o.value = m.aet;
      o.textContent = m.modality ? m.name + " · " + m.modality + " · " + m.aet : m.name + " · " + m.aet;
      o.dataset.modality = m.modality || "";
      sel.appendChild(o);
    });
    if (chosen && [...sel.options].some((o) => o.value === chosen)) sel.value = chosen;
    // Whatever was typed before the registry arrived and is not one of these AE
    // titles is dropped rather than kept out of sight. The picker has just
    // refused it; leaving it in the hidden box would put it back on the next
    // order if the registry ever emptied.
    else txt.value = "";
    sel.hidden = false; txt.hidden = true;
  }

  /* The order form's modality field, as a closed list.

     A worklist query names a modality by its DICOM code and the match is exact,
     so anything reception types that is not a code — "ct head", "Ultrasound",
     "TAC" — produces an order that reaches no modality-filtered console, while
     every surface here reports it queued and the worklist serving it. Typing
     more than the code makes the patient less visible, not more, which is not a
     rule a receptionist during an outage can be expected to know. So the field
     cannot express it: every value it can submit is a code a scanner can ask
     for, and the blank first choice is the one that shows up everywhere.

     The codes are never translated — a technologist matches them
     character-for-character against the console's configuration — but the words
     naming the exam are, because the person choosing is at the front desk.
     Shape follows fillStationChoices(): a named blank choice, then `words ·
     CODE`.

     Unlike the station list this is built from a constant rather than from the
     configuration, and that is the point: reception rarely has config.read, so
     a list that only appeared for administrators would leave exactly the
     profile that types these orders with the free text that caused the trouble.
     The set is the one this fleet plausibly schedules; anything else is OT,
     which is also what the write path would have chosen. */
  function modalityChoices() {
    return [
      ["CT", T("Computed tomography")],
      ["MR", T("Magnetic resonance")],
      ["US", T("Ultrasound")],
      ["CR", T("Computed radiography (X-ray)")],
      ["DX", T("Digital radiography (X-ray)")],
      ["XA", T("Angiography")],
      ["RF", T("Fluoroscopy")],
      ["MG", T("Mammography")],
      ["NM", T("Nuclear medicine")],
      ["PT", T("Positron emission tomography")],
      ["BMD", T("Bone density")],
      ["ES", T("Endoscopy")],
      ["OP", T("Eye photography")],
      ["PX", T("Panoramic dental X-ray")],
      ["ECG", T("Electrocardiogram")],
      ["OT", T("Other — anything not on this list")],
    ];
  }
  function fillModalityChoices() {
    const sel = $("ordMod");
    if (!sel) return;
    // Keep whatever is selected across a language switch: this runs again on
    // carino:langchange, and a half-typed order must not lose its modality
    // because somebody changed the interface language.
    const chosen = sel.value;
    sel.textContent = "";
    const none = document.createElement("option");
    none.value = ""; none.textContent = T("Not stated — shows on every worklist");
    sel.appendChild(none);
    const add = (parent, code, label) => {
      const o = document.createElement("option");
      o.value = code;
      o.textContent = label ? label + " · " + code : code;
      parent.appendChild(o);
    };
    /* Where the appliance knows its own equipment, say which codes it is.
       "Computed radiography (X-ray) · CR" and "Digital radiography (X-ray) ·
       DX" are one exam to a front desk booking a chest film, and in a
       department that registered a single X-ray room exactly one of them
       reaches a console — so the two groups put the codes some room here
       answers to ahead of the ones no room does, and name the difference
       instead of leaving the operator to guess between two adjacent lines.

       It MARKS rather than removes. A registry can be incomplete, a console can
       be added between the config save and the outage, and an order refused at
       the front desk during an outage is the one outcome this panel exists to
       prevent — so an unregistered code is still choosable, and addOrder() says
       plainly what it will and will not reach. When the registry is unknown
       (see configuredModalityCodes) nothing is claimed at all and the list is
       the flat one it has always been. */
    const here = configuredModalityCodes();
    if (here.size) {
      const mine = document.createElement("optgroup");
      mine.label = T("Registered here — a console asks for these");
      const rest = document.createElement("optgroup");
      rest.label = T("Not registered here — no console asks for these");
      modalityChoices().forEach(([code, label]) => add(here.has(code) ? mine : rest, code, label));
      /* A code an administrator registered that this list has never heard of —
         a department with a console outside the set below — belongs in the form
         all the same, or a closed list would be unable to express the one room
         the appliance is most certain about. It carries no words because there
         are none to translate: it is whatever the registry says, matched
         character-for-character by the console that asks. */
      const named = new Set(modalityChoices().map(([code]) => code));
      [...here].filter((code) => !named.has(code)).sort().forEach((code) => add(mine, code, ""));
      if (mine.children.length) sel.appendChild(mine);
      if (rest.children.length) sel.appendChild(rest);
    } else {
      modalityChoices().forEach(([code, label]) => add(sel, code, label));
    }
    // select.options is flat across optgroups, so this (and the station
    // prefill's guard, which asks the same question) is unaffected by the
    // grouping above.
    if (chosen && [...sel.options].some((o) => o.value === chosen)) sel.value = chosen;
  }

  // The station the operator picked, whichever control is on screen.
  /* Ticking "Test order" fills the form in and gets out of the way. A test
     order exists to prove the chain — order out, worklist, study back — so the
     only two answers that change what is being tested are WHICH modality and
     WHEN. Everything else is the same invented patient every time, which is
     also what makes a test order recognisable at a glance in a list of real
     ones during an outage. */
  const TEST_PATIENT = {
    patient: "Carino Test",
    patient_birthdate: "1994-09-05",
    patient_sex: "M",
    study_desc: "Chain check — worklist to study",
  };
  function applyTestDefaults(on) {
    const lock = (id, value) => {
      const el = $(id);
      if (!el) return;
      if (on) { el.dataset.wasValue = el.value; el.value = value; }
      else if ("wasValue" in el.dataset) { el.value = el.dataset.wasValue; delete el.dataset.wasValue; }
      el.readOnly = on;
      el.classList.toggle("autofilled", on);
    };
    // A fresh accession each time: two open orders sharing one are the exact
    // collision the identity work removed, and a test must not manufacture it.
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 12);
    lock("ordAcc", on ? "TEST-" + stamp : "");
    lock("ordPid", on ? "CARINO-TEST" : "");
    lock("ordPatient", TEST_PATIENT.patient);
    lock("ordDob", TEST_PATIENT.patient_birthdate);
    lock("ordDesc", TEST_PATIENT.study_desc);
    lock("ordRef", on ? "Carino DICOM" : "");
    const sex = $("ordSex");
    if (sex) {
      if (on) { sex.dataset.wasValue = sex.value; sex.value = TEST_PATIENT.patient_sex; }
      else if ("wasValue" in sex.dataset) { sex.value = sex.dataset.wasValue; delete sex.dataset.wasValue; }
      sex.disabled = on;
      sex.classList.toggle("autofilled", on);
    }
    // Modality and scheduled time stay the operator's: they are the two things
    // a test is actually varying.
    const note = $("ordTestNote");
    if (note) note.hidden = !on;
  }

  function chosenStation() {
    const sel = $("ordStationSel");
    return (sel && !sel.hidden) ? sel.value.trim() : $("ordStation").value.trim();
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
        ephemeral: tr.dataset.ephemeral === "1",
      }))
      .filter((d) => d.host && d.aet && d.port);
  }

  const csv = (id) => $(id).value.split(",").map((s) => s.trim()).filter(Boolean);

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
      qr: {
        ...loadedQr,
        enabled: $("qrEnabled").checked,
        aet: $("qrAetIn").value.trim() || "CARINOQR",
        bind: $("qrBind").value.trim() || "0.0.0.0",
        port: parseInt($("qrPort").value, 10),
        allowed_aets: csv("qrAllowed"),
        tls: $("qrTlsIn").checked,
        tls_cert: $("qrTlsCert").value.trim(),
        tls_key: $("qrTlsKey").value.trim(),
        tls_ca: $("qrTlsCa").value.trim(),
      },
      dicomweb: {
        ...loadedDicomweb,
        enabled: $("dwEnabled").checked,
        allow_stow: $("dwStow").checked,
        cors_origins: csv("dwCors"),
      },
      index: {
        ...loadedIndex,
        enabled: $("idxEnabled").checked,
        path: $("idxPath").value.trim() || "./index.db",
        rescan_on_start: $("idxRescan").checked,
      },
      // The rules come off the panel, not off the snapshot: the panel is
      // rendered on every config load, so it is always the current truth.
      routing: {
        ...loadedRouting,
        enabled: $("rtEnabled").checked,
        rules: collectRules(),
      },
      deid: {
        ...loadedDeid,
        profile: $("deidProfile").value,
        keep_private: $("deidKeepPrivate").checked,
        keep_dates: $("deidKeepDates").checked,
        prefix: $("deidPrefix").value.trim() || "ANON",
      },
      destinations: collectDests(),
      // Carried explicitly for the reason CONTRIBUTING spells out: apply_config
      // merges over DEFAULTS, so a key the dashboard does not post back is
      // reset. `modalities` has form fields only on its own tab, so a Save from
      // anywhere else has to send the loaded snapshot rather than nothing.
      modalities: modsOpen() ? collectMods() : loadedModalities,
      worklist_source: {
        ...loadedWorklistSource,
        host: $("wsHost").value.trim(),
        port: parseInt($("wsPort").value, 10) || 105,
        aet: $("wsAet").value.trim(),
        tls: $("wsTls").checked,
      },
      web: webSection(),
      audit: { ...loadedAudit },
      // Posted back with the redacted secrets still redacted — the server
      // re-asserts the stored webhook key and SMTP password and refuses any
      // attempt to set them from here, so the "_set" mirrors it stripped on the
      // way out are simply not sent back.
      notify: { ...loadedNotify },
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

  /* A toast. `ok` picks the colour — green for a thing that worked, red for one
     that did not — and `opts.warn` marks the messages on this page that must
     not be missed.

     Nothing is invented for it. The colour is this function's own red, the same
     one a failed save gets; the persistence is the emergency banner's, which
     stays on screen while the thing it describes is still true rather than
     timing out. What `warn` adds is that the toast is also SAID. #toast carries
     no role of its own, so the three "this order reaches no modality" sentences
     were shown to a sighted reader for five seconds and to a screen reader
     never — while #ordAlertLive, a few lines below it in the markup, politely
     announced "1 new order" about the very same order at the very same moment.
     role="alert" is assertive, so the warning interrupts that instead of
     queueing behind it; and the role is set BEFORE the text so the sentence
     lands as a change inside a live region rather than arriving together with
     the region, which several screen readers do not announce at all. */
  let noteGen = 0;
  function flashNote(msg, ok, opts) {
    // While the token prompt is up it owns the screen and its own message line.
    // Anything still in flight when a 401 lands would otherwise pile a stack of
    // "authentication required" toasts behind a modal nobody can read them
    // through, once per poll.
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
    /* A warning does not time out. Five seconds is not enough to read a
       sentence nobody was expecting, and the fact it carries — the order is not
       reaching a scanner — stays true until somebody acts on it. It goes when
       it is dismissed, or when the next toast replaces it. */
    if (!warn) flashNote._t = setTimeout(() => { t.hidden = true; }, 5000);
  }

  /* The way out of a toast that does not time out. A real button rather than a
     click anywhere on the box: the reader this stays up for may be working from
     the keyboard. ✕ reads the same in every language this dashboard speaks, so
     the name of the control is on the aria-label instead of in the glyph. */
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

  /* ── Access token: state line and the rotation affordance ─────── */
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
    // Nothing to remove, and nothing to prove, before the first token exists —
    // which is how the first one gets set from a loopback dashboard.
    const clear = $("authClearBtn");
    if (clear) clear.hidden = !tokenSet;
    const proof = $("authProofWrap");
    if (proof) proof.hidden = !tokenSet;
    const note = $("authProofNote");
    if (note) note.hidden = !tokenSet;
    const change = $("authRotateBtn");
    if (change) change.hidden = !!(rot && !rot.hidden);
  }

  // A fresh token generated in the browser: 32 bytes of CSPRNG, URL-safe, the
  // same shape and strength as the engine's own secrets.token_urlsafe(32).
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

  // The typed tokens live in these two fields and nowhere else — not in a
  // variable, not in storage — and they are wiped the moment they are used.
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

  /* POST /api/auth/token — the ONLY path that changes the token, and it wants
     the current one in a header rather than the session cookie, because a
     cookie that could replace the secret it was issued from would be that
     secret. Nothing here goes through a config Save: web.py refuses a token in
     POST /api/config outright. */
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
    // Deliberately NOT through api(): this is the one request that carries its
    // own credential in a header, so a rejection is about the token that was
    // typed and never about the session cookie — which is still perfectly good.
    // Letting the global 401 handler see it would punish a typo in the proof
    // field with a full sign-out of a dashboard that was never signed out.
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
      // A wrong proof counts against the same failed-attempt budget as a wrong
      // login, so the 429 has to say how long rather than read as a fault.
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
    // Every session was signed with the old token's fingerprint, including this
    // browser's, so it is already dead. Raise the prompt deliberately rather
    // than let the next poll 401 into it with no explanation.
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
    if (!confirm(T("Shut down Carino DICOM?\n\nThe receiver and auto-send stop and the engine process exits."))) return;
    $("killSvc").disabled = true;
    post("/api/shutdown", {}).catch(() => {});   // process may exit before responding
    stopPollers();
    // The same debts the sign-in prompt drops, for the same reason: this is the
    // other way a session ends. The overlay below is only a painted sheet over
    // a live DOM, so the pending live-region sentence would still be read out
    // and an owed tone would still be paid by the operator's next click —
    // announcing an arrival to somebody looking at "Carino DICOM has shut
    // down", about an engine that is no longer there to serve it.
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

  /* ── Dev peer (the disposable second archive) ─────────────────
     Only reachable in a process started with --dev-peer: the engine omits the
     whole dev_peer status block otherwise, and the nav row stays hidden. */
  async function loadDevPeer() {
    try { renderDevPeer((await api("/api/dev-peer")).dev_peer || null); }
    catch (e) { $("dpState").textContent = e.message; }
  }

  function renderDevPeer(p) {
    const running = !!(p && p.running);
    setAtomic("dpAet", running ? p.aet : "");
    setAtomic("dpScpPort", running ? p.scp_port : "");
    setAtomic("dpQrPort", running ? p.qr_port : "");
    // Counts, never identities: the engine sends no patient data in this block
    // and this panel must not invent a place to put any.
    setAtomic("dpReceived", running ? p.received : "");
    setPath("dpDir", running ? p.storage_dir : "");
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
      const r = await post("/api/dev-peer", { action: action });
      flashNote(r.message || (action === "create" ? T("Peer created.") : T("Peer discarded.")), r.ok !== false);
      renderDevPeer(r.dev_peer || null);
      pollStatus();
    } catch (e) {
      flashNote(e.message, false);
    } finally {
      // Restored here, not only on the error path: a successful click that
      // leaves "…" on the button is a bug this file has shipped once already.
      if (btn) { btn.textContent = old; btn.disabled = false; }
    }
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
      renderStuck(await api("/api/stuck"));
      reflowActive();
    } catch (e) {
      listError(list, e.message);
    }
  }

  /* GET /api/stuck answers with THREE lists, and they are not the same problem:
       destinations — the node is still configured and is refusing or timing
                      out. These retry themselves; Retry now only skips the wait.
       orphaned     — the name they were routed to is not an enabled destination
                      any more. There is no node left to dial, so NOTHING retries
                      them; the remedy is a human restoring the node under the
                      same name or accepting the loss. What happens if nobody
                      does differs between a pinned hold-and-forward copy and an
                      ordinary outgrown route, and the engine's per-row `message`
                      is the only copy that knows which — hence verbatim, below.
       held         — a routing rule asks to de-identify for that destination and
                      no copy can be scrubbed, so the engine sends nothing there
                      rather than sending it identified. Nothing retries these
                      either, and no timer releases them: the remedy is one
                      config edit, which the row carries.
     They are rendered as three sections, not one list, because a Retry button
     on an orphan or a held row would promise a retry that no endpoint performs.

     This list is added last and it is the third time this defect has shipped:
     the panel rendered exactly the fields it had been written for, the engine
     grew a category, and the ⚠ badge counted it while the panel underneath said
     every forward was up to date — work correctly withheld, reported as fine.
     Anything added to that response after this belongs here on the same day,
     and stuck-panel.e2e.mjs now fails on any list it does not find on screen.

     The ⚠ badge counts FILES needing attention (attention_files), where a file
     owing three dead nodes is one file and a file that is backing off AND
     orphaned AND held is also one — so the summary line reads that same field
     rather than adding the section counts up, which would double-count the
     overlap. */
  function renderStuck(data) {
    const d = data || {};
    const dests = d.destinations || [];
    const orphans = d.orphaned || [];
    const holds = d.held || [];
    const list = $("stuckList");
    list.innerHTML = "";
    // Retry all now clears backoff timers, nothing else. With no destination in
    // backoff there is no timer to clear, and a live button above a list of
    // orphaned or held rows reads as an offer the endpoint cannot honour.
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
        T("The node is still configured and has refused or timed out. These clear themselves as soon as it answers — Retry now only skips the wait.")));
      dests.forEach((x) => list.appendChild(stuckRow(x)));
    }
    if (orphans.length) {
      list.appendChild(stuckGroup(
        T("No destination left to retry"), Number(d.orphaned_files || 0),
        T("Routed to a name that is no longer an enabled destination. There is no node left to dial, so nothing retries them — each row says what happens next."),
        "orphan"));
      orphans.forEach((x) => list.appendChild(orphanRow(x)));
    }
    if (holds.length) {
      list.appendChild(stuckGroup(
        T("Held — nothing is being sent"), Number(d.held_files || 0),
        T("A rule asks to de-identify for these and no copy can be scrubbed, so they are held back rather than sent identified. No timer releases a hold — each row carries the one edit that does."),
        "held"));
      holds.forEach((x) => list.appendChild(heldRow(x)));
    }
  }

  // The one number the ⚠ badge shows, printed where the operator can see what
  // it is made of. The second line only appears when the sections overlap,
  // because that is the only state where their counts do not add up to it —
  // and every section counts, so the caller adds `held_files` in too. Leaving
  // one out is not a cosmetic slip: it silently claims the arithmetic on screen
  // is sound on exactly the day it is not.
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
    row.querySelector(".stuck-err").textContent = d.last_error ? TF("last error: {err}", { err: d.last_error }) : "";
    row.querySelector(".stuck-next").textContent = fmtWait(d.next_in);
    const btn = row.querySelector(".stuck-retry");
    btn.addEventListener("click", () => retryStuck(d.name, btn));
    return row;
  }

  function orphanRow(o) {
    const row = I18N_IN($("orphanRowTpl").content.cloneNode(true)).querySelector(".stuck-row");
    row.querySelector(".orphan-name").textContent = o.name || T("(destination)");
    // A pin is a promise somebody already made on this study's behalf while a
    // node was down, so it is flagged rather than left to be read out of prose.
    const pin = row.querySelector(".orphan-pin");
    pin.hidden = !o.pinned;
    if (o.pinned) pin.title = T("At least one of these was held for this node while it was offline.");
    row.querySelector(".stuck-meta").textContent = TN(o.instances, "{n} instances waiting");
    fileChips(row.querySelector(".orphan-files"), o);
    // The engine's sentence, verbatim and never recomposed from the fields
    // beside it: it is the only copy that knows whether these were pinned, and
    // a second copy here would be free to drift away from it.
    row.querySelector(".orphan-msg").textContent = o.message || "";
    return row;
  }

  function heldRow(h) {
    const row = I18N_IN($("heldRowTpl").content.cloneNode(true)).querySelector(".stuck-row");
    row.querySelector(".held-name").textContent = h.name || T("(destination)");
    // The cause, as a tag beside the name, because the two causes take opposite
    // remedies and the sentence carrying them is four lines long: an operator
    // scanning a panel of rows has to be able to see at a glance that these two
    // rows are not the same problem. Only when the engine names one — a row
    // whose instances disagree carries `cause: ""`, and no tag is the honest
    // rendering of that.
    const tag = { "profile-off": T("profile off"), "no-deidentifier": T("no de-identifier") }[h.cause];
    if (tag) {
      const chip = document.createElement("span");
      chip.className = "held-cause";
      chip.textContent = tag;
      row.querySelector(".stuck-dest").appendChild(chip);
    }
    row.querySelector(".stuck-meta").textContent = TN(h.instances, "{n} instances waiting");
    fileChips(row.querySelector(".held-files"), h);
    // `message` is `reason` + `remedy`, and it is taken whole for the same
    // reason the orphan sentence is: the engine knows which profile it is
    // actually reading and which rule asked for the scrub. Composing the line
    // here from the two halves would put a second, stale explanation of a
    // withheld study on the one screen the operator trusts.
    row.querySelector(".held-msg").textContent = h.message || "";
    // Gated at clone time: these rows are built after applyCapabilities has
    // run, so they never pass under its sweep. A Radiologist holds routing.read
    // but not config.read and gets one of the two jumps, which is exactly the
    // half of the remedy they can actually perform.
    row.querySelectorAll(".held-jump [data-cap]").forEach((b) => { b.hidden = !capAllowed(b); });
    return row;
  }

  // The named files on an orphan or held row, bounded by the engine to a sample
  // with the rest carried in `more`.
  function fileChips(box, r) {
    (r.files || []).forEach((f) => {
      const chip = document.createElement("span");
      chip.className = "hist-chip";
      chip.textContent = f;
      chip.title = f;                       // ATOMIC: the chip ellipsises, the name stays reachable
      box.appendChild(chip);
    });
    if (Number(r.more) > 0) {
      const chip = document.createElement("span");
      chip.className = "hist-chip more";
      chip.textContent = TF("+{n} more", { n: r.more });
      box.appendChild(chip);
    }
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
    } finally {
      // Retry all now is static markup: the redraw above replaces the per-row
      // buttons but never touches that one, so restoring it only on the error
      // path left a SUCCESSFUL click reading "…" and disabled until the next
      // language switch. renderStuck() has the last word on `disabled`.
      if (btn) { btn.textContent = old; btn.disabled = false; }
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
  /* This list is now repainted by the status poll as well as by a click, so two
     responses can be in flight at once — and the Open tab's slow answer landing
     after the Closed tab's fast one would paint the wrong rows under the
     wrong tab. Every request carries the tab it was made for and a sequence
     number; anything superseded is dropped instead of drawn. */
  let ordersReq = 0;

  /* The purge button's only reason to exist is the number of CLOSED orders, and
     that number moves whenever a study arrives — on any of the three close
     paths — without anybody touching this panel. Deciding it only inside
     loadOrders() is what left it stale, so it is a function the status poll can
     call too. */
  function paintOrdPurge(closed) {
    const btn = $("ordPurge");
    if (!btn) return;
    btn.hidden = orderStatus !== "closed" || !closed;
  }

  /* The Open/Closed strip is a tablist in the markup — role=tab, aria-selected
     and a roving tabindex — so the selection has to move in the DOM and not
     only in a class: aria-selected is what a screen reader reads out, and the
     roving tabindex is the only reason the unselected tab is reachable at all.
     Both callers go through here (the click handler and addOrder(), which snaps
     back to Open after queueing) so the two can never drift apart. */
  function selectOrderTab(status) {
    orderStatus = status;
    const list = $("ordersList");
    document.querySelectorAll("#dlgOrders .hist-tab[data-ostatus]").forEach((t) => {
      const on = t.dataset.ostatus === status;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      // One pane serves both tabs, so it is named by whichever is selected.
      if (on && list && t.id) list.setAttribute("aria-labelledby", t.id);
    });
    loadOrders();
  }

  async function loadOrders() {
    const list = $("ordersList");
    const req = ++ordersReq;
    const want = orderStatus;
    // Only say "Loading…" when there is nothing on screen. Blanking a populated
    // list on every create or close would flicker the row somebody is reading.
    if (!list.querySelector(".order-row")) listLoading(list);
    try {
      const data = await api("/api/ris/orders?status=" + want);
      if (req !== ordersReq || want !== orderStatus) return;   // a newer load owns the list
      renderOrders(data.orders || []);
      paintOrdPurge(data.counts && data.counts.closed);
      reflowActive();
    } catch (e) {
      if (req !== ordersReq || want !== orderStatus) return;
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
      // Where the order came from decides what may be done to it, so it is
      // named on the row rather than left to the `via …` free text.
      const originTag = row.querySelector(".order-origin");
      // The span ships hidden so a row with no tag has no empty pill; both
      // branches below have to un-hide it, not only fill it.
      originTag.hidden = o.origin !== "carino-test" && o.origin !== "ris";
      if (o.origin === "carino-test") {
        originTag.textContent = T("TEST");
        originTag.title = T("Generated here to exercise the chain — not a patient's exam.");
        originTag.classList.add("test");
      } else if (o.origin === "ris") {
        originTag.textContent = T("from the RIS");
        originTag.title = T("The RIS owns this order. It can be completed here when the study arrives, but only the RIS can cancel it.");
      }
      const sub = row.querySelector(".order-sub");
      const bits = [TF("via {src}", { src: o.source || "?" }), TF("queued {ts}", { ts: fmtStamp(o.created) })];
      if (o.status === "closed") {
        // Four different endings, and telling them apart is the point: a study
        // that arrived, film captured against it, the RIS withdrawing it, and
        // somebody here withdrawing one of ours.
        bits.push(
          o.close_reason === "matched" ? TF("✓ matched {ts}", { ts: fmtStamp(o.closed) })
          : o.close_reason === "captured" ? TF("✓ captured {ts}", { ts: fmtStamp(o.closed) })
          : o.close_reason === "cancelled-by-ris" ? TF("cancelled by the RIS {ts}", { ts: fmtStamp(o.closed) })
          : TF("cancelled here {ts}", { ts: fmtStamp(o.closed) }));
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
        // An order the RIS created is the RIS's to withdraw. The server refuses
        // it either way; not offering the button is the honest half of that.
        if (o.origin === "ris") {
          cancelBtn.hidden = true;
        } else {
          cancelBtn.addEventListener("click", () => orderAction("cancel", o, T("Cancel this order? It moves to Closed (kept for the audit trail).")));
        }
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

  /* What reception is told when the order lands, in the language they read.

     Every other call site on this page renders r.message verbatim, because
     engine text is read by whoever can act on it — a log line, a start
     failure's cause — and that person is reading the log anyway. These
     sentences are the exception the engine itself documents next to
     ORDER_QUEUED_MESSAGES: they are read by a receptionist, in the middle of an
     outage, and every outcome but "serving it" is the ONLY place anybody is
     told that the order just typed is reaching no scanner, or is reaching no
     scanner that will ask for it — no banner, no badge, no LED carries that. A
     safety warning in a language the person at the desk does not read is not a
     warning, so the engine sends a code and the sentence is said here, where
     there are four languages to say it in. Which of them are warnings rather
     than confirmations is ORDER_UNREACHED, below; flashNote paints those red
     and makes them stay.

     A code this build does not know — an appliance newer than the dashboard
     served with it — falls back to the engine's English, which is still true,
     and then to the old bare confirmation, which is at least not a claim about
     propagation. */
  function orderQueuedText(r) {
    switch (r && r.code) {
      case "order_queued_serving":
        return T("Order queued — the Modality Worklist is serving it");
      case "test_order_queued_serving":
        return T("Test order queued — the Modality Worklist is serving it");
      case "order_queued_mwl_stopped":
        return T("Order queued, but the Modality Worklist is NOT running, so no modality can query it. It is enabled — start it, or check the log for why it stopped.");
      case "test_order_queued_mwl_stopped":
        return T("Test order queued, but the Modality Worklist is NOT running, so no modality can query it. It is enabled — start it, or check the log for why it stopped.");
      case "order_queued_mwl_failed":
        return T("Order queued, but the Modality Worklist failed to start, so the order will not reach any modality. Check the log for the cause — usually its port is already in use — and hand the details to the tech.");
      case "test_order_queued_mwl_failed":
        return T("Test order queued, but the Modality Worklist failed to start, so the order will not reach any modality. Check the log for the cause — usually its port is already in use — and hand the details to the tech.");
      case "order_queued_no_mwl":
        return T("Order queued, but no Modality Worklist is enabled, so the order will not reach any modality. Enable MWL, or hand the details to the tech.");
      case "test_order_queued_no_mwl":
        return T("Test order queued, but no Modality Worklist is enabled, so the order will not reach any modality. Enable MWL, or hand the details to the tech.");
      /* The fifth outcome is about the ORDER, not about the service: a worklist
         really is serving it and the AE title it was aimed at belongs to no
         console this appliance has heard of. The target field above is a closed
         list now, so reception should not be able to reach this — but an API
         client can, and so can the free-text fallback on an appliance with no
         registry, which is exactly where this sentence has to be right. */
      case "order_queued_station_unknown":
        return T("Order queued, but no station registered here answers to that AE title, so a console that filters by station will not see it. Pick the room from the list, or leave the target blank to show the order on every worklist.");
      case "test_order_queued_station_unknown":
        return T("Test order queued, but no station registered here answers to that AE title, so a console that filters by station will not see it. Pick the room from the list, or leave the target blank to show the order on every worklist.");
      default:
        return (r && r.message) || T("Order queued");
    }
  }

  /* Which of those outcomes mean the order is reaching nobody.

     Three of the engine's four say so in words, and until now all four were
     painted the same green and gone in five seconds — so the one sentence on
     this page that says an emergency order will not reach a scanner looked
     exactly like the one that says it will. Enumerated by code rather than
     matched by pattern, for the same reason orderQueuedText has eight cases: a
     code this build has never heard of is not assumed to be bad news, and an
     engine that adds one gets the neutral treatment until this list learns it. */
  const ORDER_UNREACHED = new Set([
    "order_queued_mwl_stopped", "test_order_queued_mwl_stopped",
    "order_queued_mwl_failed", "test_order_queued_mwl_failed",
    "order_queued_no_mwl", "test_order_queued_no_mwl",
    // Narrower than the three above — a console that sends no station key
    // still sees the order — and still here, because the confirmation it
    // replaces was the strongest sentence this appliance owns, and the room
    // the patient is actually walking to is the one that misses it.
    "order_queued_station_unknown", "test_order_queued_station_unknown",
  ]);

  /* The gap the engine cannot see from where it stands. It answered "the
     Modality Worklist is serving it", which is true, about a modality code no
     console on this appliance asks for, which is also true: a CR-tagged order
     in a department whose only X-ray room is registered DX sits on the worklist
     and reaches nobody, and "serving it" is the wrong thing to tell the person
     who just typed it. The registry is the same one the target field is built
     from, so this costs no request.

     There are three answers here, not two, and the empty string carries two of
     them:

     * NO GAP — the field was left blank, which is the choice that shows the
       order on every worklist and is therefore never a miss; or some room here
       is registered as exactly this code.
     * CANNOT TELL — the registry is unknown or incomplete, which
       configuredModalityCodes() hands over as an empty set. Nothing is said
       about propagation, so addOrder() leaves the engine's own verdict
       standing: the Modality Worklist really is serving the order, which is all
       anybody on this appliance is in a position to claim. The doubt is not
       swallowed, it is simply shown where it can still be acted on rather than
       after the fact — fillModalityChoices() drops its two groups and offers
       the flat list, so the codes stop being sorted into "a console asks for
       these" and "no console asks for these" in the one place that sorting
       would be a guess. Saying it twice, once as a claim the picker cannot
       support and once as a red alert on a correct order, is how an operator
       learns to click past this warning before the day it is real.
     * A GAP — the registry answered, and it answered that nothing here asks for
       this code. Only this one returns a sentence, and only this one is painted
       red and made to stay. */
  function modalityReachGap(code) {
    const want = String(code || "").trim().toUpperCase();
    const here = configuredModalityCodes();
    if (!want || !here.size || here.has(want)) return "";
    return TF("Order queued, but no modality registered here answers to {code}, so a console that filters by modality will not see it. Pick the code the room is registered as, or hand the details to the tech.", { code: want });
  }

  /* The other half of orderQueuedText: what reception is told when the order
     was NOT queued at all.

     Only the two fields the order form can actually write are said here. The
     engine refuses a third (an illegal Study Instance UID) that no field on
     this page produces, and that one falls through to the default below and is
     shown in the engine's English — the same rule orderQueuedText uses for a
     code this build has never heard of, and for the same reason: a sentence
     this page cannot say honestly is better said badly than guessed at. */
  function orderRefusedText(code) {
    switch (code) {
      case "order_refused_accession":
        return T("Order NOT queued — a Modality Worklist cannot carry that accession number. It must be at most 16 characters and must not contain a backslash. Shorten or retype it, or leave it blank — a shortened accession names a different order, so this appliance will not shorten it for you.");
      case "order_refused_patient_id":
        return T("Order NOT queued — a Modality Worklist cannot carry that patient ID. It must be at most 64 characters and must not contain a backslash. Shorten or retype it, or leave it blank and the order will carry a temporary ID naming itself.");
      default:
        return "";
    }
  }

  /* The same refusal, decided here, before the POST.

     It is not a substitute for the engine's gate — an API client never reaches
     this file, and this file is served from an appliance that may be older or
     newer than the engine answering it — it is a duplicate on purpose, because
     of WHEN it fires. The round trip is not the cost; the cost is that a
     refusal arriving as a thrown 400 reads like a fault of the appliance, while
     the same sentence raised before anything is sent reads like what it is: the
     value in the box in front of you will not fit, here is the rule.

     Mirrors pacs/mwl.py's _vr_value for the two VRs the form can write: trimmed
     to nothing is fine (an order is allowed to carry neither), otherwise inside
     the cap, no backslash — DICOM's value delimiter, which would turn one
     accession into two — and no control character, which SH and LO do not
     admit. Counted in CODE POINTS, because the engine counts Python characters
     and a name carrying an emoji or an astral character would otherwise be
     refused here and accepted there, which is the one direction of disagreement
     the operator cannot act on. */
  const ID_VR_MAX = { accession: 16, patient_id: 64 };   // mwl.SH_MAX, mwl.LO_MAX
  function idFits(value, max) {
    const v = String(value || "").trim();
    if (!v) return true;
    if ([...v].length > max) return false;
    return ![...v].some((c) => {
      const n = c.codePointAt(0);
      return c === "\\" || n < 0x20 || (n >= 0x7F && n <= 0x9F);
    });
  }
  function unrepresentableOrderId(fields) {
    for (const [field, max] of Object.entries(ID_VR_MAX)) {
      if (!idFits(fields[field], max)) return "order_refused_" + field;
    }
    return "";
  }

  async function addOrder(btn) {
    const fields = {
      accession: $("ordAcc").value.trim(),
      patient: $("ordPatient").value.trim(),
      patient_id: $("ordPid").value.trim(),
      patient_birthdate: $("ordDob").value.trim(),
      patient_sex: $("ordSex").value,
      modality: $("ordMod").value.trim(),
      station_aet: chosenStation(),
      study_desc: $("ordDesc").value.trim(),
      scheduled_dt: $("ordWhen").value.trim(),
      referring: $("ordRef").value.trim(),
      test: $("ordTest").checked,
    };
    if (!fields.accession && !fields.patient && !fields.patient_id) {
      flashNote(T("An order needs at least an accession, patient name or ID"), false);
      return;
    }
    /* Refused here rather than shortened for them. An accession the worklist
       cannot carry used to be accepted, confirmed green, and then dropped on
       the wire, so the study came back with nothing to match the order on and
       the order never closed — invisible to everyone until somebody read the
       open list days later. Red and sticky, like every other piece of bad news
       on this page, and the form is left exactly as typed so the value can be
       corrected rather than retyped. */
    const badId = unrepresentableOrderId(fields);
    if (badId) {
      flashNote(orderRefusedText(badId), false, { warn: true });
      const box = $(badId === "order_refused_accession" ? "ordAcc" : "ordPid");
      if (box) box.focus();
      return;
    }
    const old = btn.textContent; btn.disabled = true; btn.textContent = "…";
    try {
      const r = await post("/api/ris/orders", fields);
      /* What reception is told, and how loudly. A confirmation that the order
         is NOT reaching a scanner is delivered the way this page delivers every
         other piece of bad news — flashNote's red, not its green — and, alone
         among the toasts, it stays up and announces itself (see flashNote).
         The engine's own verdict comes first: only an outcome it called serving
         is second-guessed against the local registry, because every outcome
         that already names a reason — no worklist, a stopped one, a failed
         start, an unknown station — says it better than this can. */
      const gap = (r && (r.code === "order_queued_serving" || r.code === "test_order_queued_serving"))
        ? modalityReachGap(fields.modality) : "";
      const unreached = !!(gap || (r && ORDER_UNREACHED.has(r.code)));
      flashNote(gap || orderQueuedText(r), !unreached && r.ok !== false, { warn: unreached });
      if (r.ok !== false) {
        /* Untick "Test order" FIRST. Its fields are readOnly and filled with the
           invented test patient while it is on, so leaving it ticked leaves a
           form that cannot be typed into — and applyTestDefaults(false) has to
           run before the clear below, because releasing the lock restores each
           field's pre-test value. */
        const test = $("ordTest");
        if (test && test.checked) { test.checked = false; applyTestDefaults(false); }
        ["ordAcc", "ordPatient", "ordPid", "ordDob", "ordSex", "ordMod", "ordStation", "ordDesc", "ordWhen", "ordRef"].forEach((id) => { $(id).value = ""; });
        /* The target station is NOT sticky. An inherited station sends the next
           patient's order to the previous patient's room, where it sits on a
           worklist nobody is reading — back to "Any modality", which is the
           answer that shows up everywhere rather than nowhere. */
        const sel = $("ordStationSel");
        if (sel) sel.value = "";
        // Back to Open, where the order just queued actually is — through the
        // same helper the tabs use, so aria-selected and the roving tabindex
        // follow the class instead of being left pointing at the old tab.
        selectOrderTab("open");
        pollStatus();
      }
    } catch (e) {
      /* A refusal the engine made and this build knows how to say is said in
         the operator's language, red and sticky like the rest of this page's
         bad news; anything else keeps the engine's English, which is what every
         other catch here shows. The pre-check above normally gets there first —
         this is the path for an API-shaped value the rule here has not learned,
         and for a dashboard served by an engine newer than itself. */
      const said = orderRefusedText(e.code);
      flashNote(said || e.message, false, { warn: !!said });
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

  /* ── Conditional routing ─────────────────────────────────────────
     The rules are config, so this panel edits them and saves through the same
     POST /api/config as everything else — there is no separate rules endpoint
     to drift from. Two things are load-bearing here and neither is cosmetic:

       * a rule may name a destination that has since been renamed, disabled or
         deleted. That name is KEPT, kept ticked and flagged. Quietly dropping
         it would rewrite the operator's routing on their behalf, and the next
         Save would make the narrowing permanent;
       * keys this form has no control for (a "_comment", a field a later
         version adds) are spread back untouched, for the same reason the other
         sections keep their snapshots. */
  const MATCH_FIELDS = ["modality", "calling_aet", "station", "patient_id", "study_desc"];
  // Spellings the engine also accepts (routing._ALIASES). A rule written by
  // hand with one of them is normalised into its canonical field here, so the
  // form does not end up posting the same condition twice under two names.
  const MATCH_ALIASES = {
    source_aet: "calling_aet", calling_ae: "calling_aet",
    station_name: "station", study_description: "study_desc",
  };

  // Destination names a rule may pick from: the enabled rows of the table the
  // operator is looking at, not a copy from load time.
  function destNames() {
    const body = $("destBody");
    if (!body) return [];
    return [...body.querySelectorAll("tr")]
      .filter((tr) => tr.querySelector(".d-en").checked)
      .map((tr) => tr.querySelector(".d-name").value.trim())
      .filter(Boolean);
  }

  function renderRules(rules) {
    const box = $("rtRules");
    if (!box) return;
    box.innerHTML = "";
    (rules || []).filter((r) => r && typeof r === "object").forEach((r) => box.appendChild(ruleRow(r)));
    numberRules();
  }

  function ruleRow(rule) {
    const node = I18N_IN($("rtRuleTpl").content.cloneNode(true)).querySelector(".rt-rule");
    const match = (rule.match && typeof rule.match === "object" && !Array.isArray(rule.match)) ? rule.match : {};
    node._rule = rule;
    node._matchExtra = {};
    const canon = {};
    Object.keys(match).forEach((k) => {
      const low = String(k).toLowerCase();
      const key = MATCH_ALIASES[low] || low;
      if (MATCH_FIELDS.indexOf(key) >= 0) canon[key] = match[k];
      else node._matchExtra[k] = match[k];      // preserved, and reported below
    });
    node.querySelector(".rt-name").value = rule.name || "";
    node.querySelectorAll(".rt-f").forEach((inp) => {
      const v = canon[inp.dataset.field];
      inp.value = Array.isArray(v) ? v.join(", ") : (v == null ? "" : String(v));
    });
    node.querySelector(".rt-deid").checked = !!rule.deidentify;
    node.querySelector(".rt-stop").checked = !!rule.stop;
    fillRuleDests(node, (rule.destinations || []).filter((d) => typeof d === "string" && d.trim()));
    const extra = Object.keys(node._matchExtra).filter((k) => !k.startsWith("_"));
    if (extra.length) {
      // The engine skips a rule with an unknown match key rather than treating
      // it as "matches anything", so this is why a rule never fires.
      node.querySelector(".rt-warn").textContent =
        TF("Unknown match field {keys} — the engine skips this rule entirely.", { keys: extra.join(", ") });
    }
    node.querySelector(".rt-del").addEventListener("click", () => { node.remove(); numberRules(); });
    node.querySelector(".rt-up").addEventListener("click", () => moveRule(node, -1));
    node.querySelector(".rt-down").addEventListener("click", () => moveRule(node, 1));
    return node;
  }

  function fillRuleDests(node, picked) {
    const box = node.querySelector(".rt-dests");
    box.innerHTML = "";
    const names = destNames();
    const all = names.slice();
    picked.forEach((p) => { if (all.indexOf(p) < 0) all.push(p); });
    if (!all.length) {
      const e = document.createElement("span");
      e.className = "rt-dests-empty";
      e.textContent = T("No destinations configured yet.");
      box.appendChild(e);
      return;
    }
    all.forEach((n) => {
      const gone = names.indexOf(n) < 0;
      const lab = document.createElement("label");
      lab.className = "rt-dest" + (gone ? " missing" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = n;
      cb.checked = picked.indexOf(n) >= 0;
      const sp = document.createElement("span");
      sp.textContent = n;                       // ATOMIC: ellipsised, full name in title
      sp.title = gone ? TF("{name} — not an enabled destination, so this rule cannot deliver to it", { name: n }) : n;
      lab.append(cb, sp);
      box.appendChild(lab);
    });
  }

  // The destination table can change while the rules are on screen; re-offer the
  // current node list without disturbing what each rule has ticked.
  function refreshRuleDests() {
    const box = $("rtRules");
    if (!box) return;
    [...box.querySelectorAll(".rt-rule")].forEach((node) => {
      const picked = [...node.querySelectorAll(".rt-dests input:checked")].map((c) => c.value);
      fillRuleDests(node, picked);
    });
  }

  function numberRules() {
    const box = $("rtRules");
    if (!box) return;
    const rows = [...box.querySelectorAll(".rt-rule")];
    rows.forEach((node, i) => {
      node.querySelector(".rt-rule-n").textContent = "#" + (i + 1);
      node.querySelector(".rt-up").disabled = i === 0;
      node.querySelector(".rt-down").disabled = i === rows.length - 1;
    });
    const empty = $("rtEmpty");
    if (empty) empty.hidden = rows.length > 0;
  }

  function moveRule(node, dir) {
    const sib = dir < 0 ? node.previousElementSibling : node.nextElementSibling;
    if (!sib) return;
    if (dir < 0) node.parentNode.insertBefore(node, sib);
    else node.parentNode.insertBefore(sib, node);
    numberRules();
  }

  function collectRules() {
    const box = $("rtRules");
    if (!box) return loadedRouting.rules || [];
    return [...box.querySelectorAll(".rt-rule")].map((node) => {
      const match = { ...(node._matchExtra || {}) };
      node.querySelectorAll(".rt-f").forEach((inp) => {
        // Comma-separated means "any of these" — the engine takes a list of
        // globs for a field. One value stays a plain string so a hand-written
        // config round-trips unchanged.
        const parts = inp.value.split(",").map((s) => s.trim()).filter(Boolean);
        if (parts.length === 1) match[inp.dataset.field] = parts[0];
        else if (parts.length > 1) match[inp.dataset.field] = parts;
      });
      return {
        ...(node._rule || {}),
        name: node.querySelector(".rt-name").value.trim(),
        match: match,
        destinations: [...node.querySelectorAll(".rt-dests input:checked")].map((c) => c.value),
        deidentify: node.querySelector(".rt-deid").checked,
        stop: node.querySelector(".rt-stop").checked,
      };
    });
    // Deliberately unfiltered: a rule with no name is refused by the engine with
    // its number in the message. Dropping it here instead would silently delete
    // something the operator typed.
  }

  function addRule() {
    const box = $("rtRules");
    if (!box) return;
    box.appendChild(ruleRow({ name: "", match: {}, destinations: [] }));
    numberRules();
    const last = box.lastElementChild;
    if (last) last.querySelector(".rt-name").focus();
  }

  async function testRoute(btn) {
    const attrs = {
      modality: $("rtModality").value.trim(),
      calling_aet: $("rtCallingAet").value.trim(),
      station: $("rtStation").value.trim(),
      patient_id: $("rtPatientId").value.trim(),
      study_desc: $("rtStudyDesc").value.trim(),
    };
    btn.disabled = true;
    try {
      renderRouteResult(await post("/api/routing/test", { attributes: attrs }));
    } catch (e) {
      flashNote(e.message, false);
    } finally { btn.disabled = false; }
  }

  /* One /api/routing/test decision with the half that endpoint cannot see
     folded in — the LAST place a held node can still be drawn as "de-identified
     for", and the one this lane could not close in the engine.
   *
   * The dry run posts `attributes` (a hypothetical study), and that branch is
   * answered in pacs/web.py by a bare Router: rules plus deid.profile, with no
   * de-identifier anywhere near it. So it reports the config-half answer, which
   * is right for "the profile is off" and wrong for "the profile is on and
   * nothing can be built" — the second cause is invisible to a Router, and that
   * branch is not this lane's file to change.
   *
   * What is corrected here is NOT re-derived here: `hold_cause` is the engine's
   * own settled answer off the status poll (server.py `_settled_deid`, the same
   * Decision.honoured_by every sender goes through), and "no de-identifier can
   * be built" is a fact about the CONFIG, not about the file — it holds every
   * destination any rule scrubs for, hypothetical or not. This applies that one
   * fact; it never asks the scrub question a second time. */
  function settledRoute(d) {
    const live = (lastStatus && lastStatus.deid) || {};
    const asks = d.deidentify || [];
    if (!asks.length || live.hold_cause !== "no-deidentifier") return d;
    return Object.assign({}, d, {
      deidentify: [],
      held: (d.held || []).concat(asks).sort(),
      hold_cause: live.hold_cause,
      sendable: (d.sendable || d.destinations || []).filter((n) => asks.indexOf(n) < 0),
    });
  }

  function renderRouteResult(r) {
    const box = $("rtResult");
    if (!box) return;
    box.innerHTML = "";
    box.hidden = false;
    const d = settledRoute(r.decision || {});
    // `sendable`, not `destinations`: a held destination is in the decision but
    // is not dialled, and drawing it as an arrow said the study went there.
    const dests = d.sendable || d.destinations || [];
    const held = d.held || [];
    const head = document.createElement("div");
    head.className = "rt-decision " + (dests.length ? (d.fallback ? "fallback" : "routed") : "fallback");
    head.textContent = dests.length ? "→ " + dests.join(", ")
      : held.length ? T("→ nowhere: every destination is held.")
                    : T("→ nowhere: there is no enabled destination at all.");
    box.appendChild(head);
    if (held.length) {
      const hz = document.createElement("p");
      hz.className = "rt-reason rt-held";
      // Same branch as the de-identification panel, and for the same reason: a
      // dry run that blames a profile which is on teaches the operator to go and
      // turn something on that is already on, and then to take the scrub off the
      // rule when that does nothing.
      hz.textContent = d.hold_cause === "no-deidentifier"
        ? TF("HELD — not sent to {dests}: a rule asks for de-identification, the profile is on, and no de-identifier can be built from these settings, so nothing can be scrubbed.", { dests: held.join(", ") })
        : d.hold_cause === "profile-off"
          ? TF("HELD — not sent to {dests}: a rule asks for de-identification and the profile is off, so nothing can be scrubbed.", { dests: held.join(", ") })
          : TF("HELD — not sent to {dests}: a rule asks for de-identification and nothing can be scrubbed.", { dests: held.join(", ") });
      box.appendChild(hz);
    }
    const why = document.createElement("p");
    why.className = "rt-reason";
    // The decision's reason is the engine's own wording — the same string the
    // log uses — so it stays in the server's language, like every engine message.
    why.textContent = d.reason || "";
    box.appendChild(why);
    if ((d.deidentify || []).length) {
      const dz = document.createElement("p");
      dz.className = "rt-reason";
      dz.textContent = TF("De-identified for: {dests}", { dests: d.deidentify.join(", ") });
      box.appendChild(dz);
    }
    (d.unresolved || []).forEach((u) => {
      const w = document.createElement("p");
      w.className = "rt-reason";
      w.style.color = "var(--warn)";
      w.textContent = TF("Names a destination that does not exist or is disabled: {what}", { what: u });
      box.appendChild(w);
    });
    const rows = r.rules || [];
    if (!rows.length) {
      box.appendChild(emptyNote(r.routing_enabled === false
        ? T("Routing is off — every study goes to every enabled destination.")
        : T("No rules were evaluated.")));
      return;
    }
    const heldNow = held.slice();
    rows.forEach((row) => {
      const el = I18N_IN($("rtTraceTpl").content.cloneNode(true)).querySelector(".rt-trace");
      const hit = !!row.matched && (row.destinations || []).length > 0;
      // Against the decision's held set rather than the row's own copy of it:
      // the engine fills row.held for the hold IT can see, and a rule whose
      // delivery is held for the cause it cannot would otherwise stay green and
      // arrowed — "matched → Research" over a study going nowhere is the same
      // reassurance, one panel further down.
      const blocked = (row.destinations || []).filter((n) => heldNow.indexOf(n) >= 0);
      // Held outranks hit: the rule matched, and nothing is being delivered.
      const cls = blocked.length ? "held"
        : hit ? "hit" : ((row.unknown_match_keys || []).length ? "skip" : "");
      if (cls) el.classList.add(cls);
      el.querySelector(".rt-trace-n").textContent = "#" + row.index;
      const nm = el.querySelector(".rt-trace-name");
      nm.textContent = row.name || "";
      nm.title = row.name || "";
      el.querySelector(".rt-trace-act").textContent =
        (row.action || "") + ((row.destinations || []).length ? " → " + row.destinations.join(", ") : "")
        // The engine's own action text already carries its hold; this adds the
        // one it could not know about, and never a second copy of the first.
        + (blocked.length && !(row.held || []).length
          ? " — " + TF("HELD, not sent to {dests}", { dests: blocked.join(", ") }) : "");
      // Field by field, with the study's value and the pattern it was tested
      // against: "did not match" without saying against what is not an answer.
      el.querySelector(".rt-trace-why").textContent = (row.fields || []).map((f) =>
        f.field + "=" + (f.value || T("(empty)")) + " " + (f.matched ? "✓" : "✗") + " " + (f.patterns || []).join(" | ")
      ).join("   ·   ");
      box.appendChild(el);
    });
  }

  /* ── Sidebar workspace: each nav button expands its panel in the pane ──
     Every panel renders inline in the viewport-bound workspace and scrolls its
     own content; there is no popup/backdrop anymore. */
  // Overview leads the list (hash routing + sidebar order match) but Services
  // stays the landing panel: the unattended screen must not show patient names.
  /* ── People ──────────────────────────────────────────────────────
     The administrator's editor. Every control draws what the server already
     enforces — the capability list comes from the engine rather than being
     duplicated here, so a capability added in a later version appears in this
     screen without this file being touched. */
  let peopleState = { profiles: [], capabilities: [], phi_fields: [], in_use: false };

  async function loadPeople() {
    if (!can("auth.manage")) return;
    try {
      const r = await api("/api/profiles/manage");
      peopleState = r;
      renderPeople();
    } catch (e) {
      flashNote(TF("Load failed: {err}", { err: e.message }), false);
    }
  }

  function renderPeople() {
    const on = !!peopleState.in_use;
    show($("peopleOff"), !on);
    show($("peopleOn"), on);
    const add = $("peopleAdd");
    if (add) add.hidden = !on;
    if (!on) return;

    const listing = $("peopleListing");
    if (listing) listing.checked = peopleState.list_profiles !== false;
    const count = $("peopleCount");
    if (count) {
      const rows = peopleState.profiles || [];
      const open = rows.filter((p) => !p.locked && p.enabled).length;
      count.textContent = open
        ? TF("{n} profiles. {open} of them have no password.", { n: rows.length, open })
        : TF("{n} profiles.", { n: rows.length });
      count.classList.toggle("warn", open > 0);
    }

    const list = $("peopleList");
    if (!list) return;
    list.textContent = "";
    (peopleState.profiles || []).forEach((p) => list.appendChild(personCard(p)));
  }

  function personCard(p) {
    const card = document.createElement("div");
    card.className = "person-card" + (p.enabled ? "" : " off");

    const head = document.createElement("div");
    head.className = "person-head";
    const name = document.createElement("input");
    name.type = "text";
    name.value = p.name;
    name.className = "person-name";
    head.appendChild(name);
    const role = document.createElement("input");
    role.type = "text";
    role.value = p.role || "";
    role.className = "person-rolein";
    role.placeholder = T("role");
    head.appendChild(role);
    card.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "person-meta";
    const email = document.createElement("input");
    email.type = "email";
    email.value = p.email || "";
    email.placeholder = T("email for emergency alerts");
    meta.appendChild(email);
    card.appendChild(meta);

    const flags = document.createElement("div");
    flags.className = "person-flags";
    const enabled = chk(T("Enabled"), p.enabled);
    const admin = chk(T("Administrator (everything, including future permissions)"), p.admin);
    flags.appendChild(enabled.label);
    flags.appendChild(admin.label);
    card.appendChild(flags);

    // Capabilities. Hidden behind the admin flag, because an administrator
    // holds everything by definition, and a full column of ticked, disabled
    // boxes reads as a list somebody could edit.
    const caps = document.createElement("div");
    caps.className = "person-caps";
    const capBoxes = {};
    (peopleState.capabilities || []).forEach((c) => {
      const box = chk(c.description, (p.capabilities || []).indexOf(c.name) >= 0);
      box.label.title = c.name;
      capBoxes[c.name] = box.input;
      caps.appendChild(box.label);
    });
    const capsWrap = section(T("Can do"), caps);
    card.appendChild(capsWrap);

    const phi = document.createElement("div");
    phi.className = "person-caps";
    const phiBoxes = {};
    (peopleState.phi_fields || []).forEach((f) => {
      const box = chk(f.description, (p.phi_visible || []).indexOf(f.name) >= 0);
      box.label.title = f.name;
      phiBoxes[f.name] = box.input;
      phi.appendChild(box.label);
    });
    const phiWrap = section(T("Can see"), phi);
    const phiHint = document.createElement("p");
    phiHint.className = "hint";
    phiHint.textContent = T("Anything unticked is shown as *** wherever it would appear. Someone tracing a study through the routing engine usually needs the accession number and not the name.");
    phiWrap.appendChild(phiHint);
    card.appendChild(phiWrap);

    const syncAdmin = () => {
      const isAdmin = admin.input.checked;
      capsWrap.hidden = isAdmin;
      phiWrap.hidden = isAdmin;
    };
    admin.input.addEventListener("change", syncAdmin);
    syncAdmin();

    // Password. Three states, and the button says which one it is in rather
    // than making the administrator remember: no password / set one / change
    // or remove the one there is.
    const pwRow = document.createElement("div");
    pwRow.className = "person-pw";
    const pwState = document.createElement("span");
    pwState.className = "pw-state";
    pwState.textContent = p.locked ? T("Password set") : T("No password — anyone can pick this profile");
    pwState.classList.toggle("warn", !p.locked);
    pwRow.appendChild(pwState);
    const pwInput = document.createElement("input");
    pwInput.type = "password";
    pwInput.autocomplete = "new-password";
    pwInput.placeholder = p.locked ? T("new password") : T("set a password");
    pwRow.appendChild(pwInput);
    let clearPw = false;
    if (p.locked) {
      const rm = document.createElement("button");
      rm.className = "btn ghost tiny";
      rm.textContent = T("Remove password");
      rm.addEventListener("click", () => {
        clearPw = true;
        pwState.textContent = T("Password will be removed when you save");
        pwState.classList.add("warn");
      });
      pwRow.appendChild(rm);
    }
    card.appendChild(pwRow);

    const actions = document.createElement("div");
    actions.className = "person-actions";
    const save = document.createElement("button");
    save.className = "btn tiny";
    save.textContent = T("Save");
    save.addEventListener("click", async () => {
      const body = {
        id: p.id,
        name: name.value.trim(),
        role: role.value.trim(),
        email: email.value.trim(),
        enabled: enabled.input.checked,
        admin: admin.input.checked,
        capabilities: Object.keys(capBoxes).filter((k) => capBoxes[k].checked),
        phi_visible: Object.keys(phiBoxes).filter((k) => phiBoxes[k].checked),
      };
      if (pwInput.value) body.password = { action: "set", value: pwInput.value };
      else if (clearPw) body.password = { action: "clear" };
      await savePerson(save, body);
    });
    actions.appendChild(save);

    const del = document.createElement("button");
    del.className = "btn ghost tiny danger";
    del.textContent = T("Delete");
    del.addEventListener("click", async () => {
      if (!window.confirm(TF("Delete {name}? Their entries in the audit trail stay — the trail is append-only and names them by id, so past actions keep resolving to this person.", { name: p.name }))) return;
      try {
        const r = await post("/api/profiles/delete", { id: p.id });
        peopleState = Object.assign({}, peopleState, r);
        renderPeople();
        flashNote(TF("{name} removed.", { name: p.name }), true);
      } catch (e) { flashNote(e.message, false); }
    });
    actions.appendChild(del);
    card.appendChild(actions);
    return card;
  }

  function section(title, body) {
    const wrap = document.createElement("div");
    wrap.className = "person-section";
    const h = document.createElement("h4");
    h.textContent = title;
    wrap.appendChild(h);
    wrap.appendChild(body);
    return wrap;
  }

  function chk(text, checked) {
    const label = document.createElement("label");
    label.className = "chk";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!checked;
    label.appendChild(input);
    const span = document.createElement("span");
    span.textContent = text;
    label.appendChild(span);
    return { label, input };
  }

  async function savePerson(btn, body) {
    btn.disabled = true;
    try {
      const r = await post("/api/profiles/save", body);
      peopleState = Object.assign({}, peopleState, r);
      renderPeople();
      flashNote(T("Saved."), true);
    } catch (e) {
      // The server's refusals here are the interesting ones — the last
      // administrator, an open profile with write access on a network bind —
      // and each names what to do about it. Shown as-is rather than replaced
      // with a generic failure.
      flashNote(e.message, false);
    } finally {
      btn.disabled = false;
    }
  }

  /* ── Audit trail ─────────────────────────────────────────────── */
  async function loadAudit() {
    if (!can("audit.read")) return;
    try {
      const r = await api("/api/audit?limit=300");
      renderAudit(r.records || [], r.audit || {});
    } catch (e) {
      flashNote(TF("Load failed: {err}", { err: e.message }), false);
    }
  }

  function renderAudit(rows, stats) {
    const state = $("auditState");
    if (state) {
      state.textContent = "";
      state.classList.remove("bad");
      if (stats.broken) {
        // The one message on this screen that must never be quiet: a trail that
        // stopped recording looks exactly like a week in which nothing
        // happened.
        state.textContent = TF("The audit trail is NOT being written: {err}", { err: stats.broken });
        state.classList.add("bad");
      } else if (!stats.enabled) {
        state.textContent = T("The audit trail is switched off — nothing is being recorded about who does what.");
        state.classList.add("bad");
      } else {
        state.textContent = TF("{files} file(s), {kb} KB. Chain head {head}.",
          { files: stats.files || 0, kb: Math.round((stats.bytes || 0) / 1024), head: (stats.head || "").slice(0, 12) });
      }
    }
    const list = $("auditList");
    if (!list) return;
    list.textContent = "";
    if (!rows.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = T("Nothing recorded yet.");
      list.appendChild(p);
      return;
    }
    rows.forEach((r) => {
      const row = document.createElement("div");
      row.className = "audit-row " + (r.outcome === "ok" ? "ok" : (r.outcome === "denied" ? "denied" : "failed"));
      row.appendChild(cell("audit-ts", (r.ts || "").replace("T", " ").replace("+00:00", "")));
      const actor = (r.actor || {});
      const who = cell("audit-who", actor.name || "—");
      if (actor.service) who.title = T("The shared access token, not a person.");
      row.appendChild(who);
      row.appendChild(cell("audit-act", r.action || ""));
      row.appendChild(cell("audit-target", r.target || ""));
      row.appendChild(cell("audit-out", r.outcome || ""));
      list.appendChild(row);
    });
  }

  function cell(cls, text) {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    return d;
  }

  // dlgDevPeer is a PANEL but deliberately NOT in LANDING_ORDER below: a bench
  // tool must never be somebody's landing panel, and showPanel's hidden-nav
  // refusal then also blocks a #devpeer deep link on a build that never passed
  // the flag.
  const PANELS = ["dlgOverview", "dlgServices", "dlgStudies", "dlgOrders", "dlgConfig", "dlgActivity",
                  "dlgDevPeer"];
  /* Three of the six hold a tab strip, and the absorbed panels survive as the
     PANE ids inside them. Keeping dlgHistory / dlgStuck / dlgSettings / … as
     real element ids is not sentiment: it is what lets the old #dlgStuck
     bookmarks in the manuals resolve to something that exists, and what keeps
     every id-scoped rule in styles.css bound to the markup it was written for. */
  const PANEL_TABS = {
    dlgStudies:  { history: "dlgHistory", pending: "dlgPending", stuck: "dlgStuck" },
    dlgConfig:   { destinations: "dlgDests", routing: "dlgRouting", settings: "dlgSettings",
                   modalities: "dlgModalities", people: "dlgPeople" },
    dlgActivity: { logs: "dlgLogs", audit: "dlgAudit", caught: "dlgCaught" },
  };
  // Where a bare panel id lands when nothing else says otherwise. Configuration
  // opens on Destinations rather than Settings: Settings is the densest pane in
  // the app and holds the shutdown control, and it should be somewhere you went
  // deliberately, not somewhere you arrive.
  const DEFAULT_TAB = { dlgStudies: "history", dlgConfig: "destinations", dlgActivity: "logs" };
  // Remembered per panel, so coming back to Configuration returns you to the tab
  // you were working in. Written only by selectTab.
  const activeTab = Object.assign({}, DEFAULT_TAB);

  // Routing needs no fetch — its rules arrive with the config — but the
  // destination table may have gained or lost a node since they were drawn, so
  // opening the panel re-offers the current list without losing a tick.
  const loaders = {
    dlgOrders: loadOrders,
    dlgDevPeer: loadDevPeer,
  };
  // Keyed by PANE id, because that is the granularity that now decides what is
  // on screen.
  const tabLoaders = {
    dlgHistory: loadHistory, dlgPending: loadPending, dlgStuck: loadStuck,
    dlgRouting: refreshRuleDests,
    // No fetch either: the index / DICOMweb / de-identification readouts ride
    // on the status poll, which skips them while the pane is shut.
    dlgSettings: () => {
      if (!lastStatus) return;
      renderIndex(lastStatus.index || {});
      renderDicomweb(lastStatus.dicomweb || {});
      renderDeidState(lastStatus.deid || {});
    },
    dlgPeople: loadPeople,
    dlgAudit: loadAudit,
    // No fetch: the registry rides in with the config. Redrawn on open so the
    // table reflects a config another tab's Save just rewrote.
    dlgModalities: () => renderMods(loadedModalities),
    dlgCaught: loadCaught,
  };
  let activePanel = "dlgServices";

  /* Which panel a profile lands on. An explicit order, NOT the first visible
     row in DOM order: that would put Reception — who holds studies.read — on
     Studies, whose first tab is a list of every stored patient's name, ID and
     date of birth. Overview is skipped for the same reason it is never
     persisted in the hash (it prints one patient name), and Orders comes early
     because order intake is what the front desk is doing during the outage this
     appliance exists for. */
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

  /* Selection and loading are separate arguments on purpose.

     applyCapabilities() has to repair every strip in the app on any poll where
     the profile changed, including strips inside CLOSED panels. If repairing
     also loaded, narrowing a Radiologist's permissions would fire GET /api/
     studies, /api/stuck and /api/pending for a Studies panel that is not on
     screen — five of the seven loaders carry no can() guard of their own. So
     the repair pass passes load:false and only moves `hidden` and `.active`
     around; fetching belongs to opening a panel and to clicking a tab. */
  function selectTab(panelId, tabId, opts) {
    const tabs = PANEL_TABS[panelId];
    if (!tabs) return;
    const load = !opts || opts.load !== false;
    // Refuse a tab the profile may not hold, exactly as showPanel refuses a
    // panel. Without this, #configuration/people hands a Radiologist the People
    // pane and #configuration/settings hands them the shutdown control — the
    // panel-level gate says nothing about tabs, and every tab is a deep link.
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

  /* Repair every strip, unconditionally — not "if the active tab is hidden".
     A strip whose active tab was just forbidden and a strip that never had an
     active marker are the same problem, and only the unconditional form fixes
     both. Silent: no loads, no hash write. */
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
  /* The line under a merged panel's title, listing what is inside it. Built
     from the tabs that are actually VISIBLE: a fixed subtitle would promise a
     Radiologist "settings · destinations · routing · people" above a strip
     holding two of them. */
  const TAB_SUB = { dlgStudies: "studiesSub", dlgConfig: "configSub", dlgActivity: "activitySub" };
  function writeTabSub(panelId) {
    const el = $(TAB_SUB[panelId]);
    const strip = tabStrip(panelId);
    if (!el || !strip) return;
    const names = [...strip.querySelectorAll(".hist-tab[data-tab]:not([hidden])")]
      .map((b) => (b.textContent || "").trim().toLowerCase());
    el.textContent = names.join(" · ");
  }

  /* The one place that decides what "refresh what is on screen" means. Every
     caller used to write `loaders[activePanel]` inline; after the merge three of
     the six panels have no entry there, and those bare lookups would silently
     become no-ops on the two paths that matter most — coming back from a 401,
     and repainting after a language switch (i18n.js's static pass runs first and
     leaves every JS-rendered row in the old language until this runs). */
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
    // A panel whose nav row the profile cannot hold is not somewhere to be.
    // Internal callers (the first-run chooser) pass allowForbidden, because the
    // setup door opens before there is anything to be entitled to.
    const btn = document.querySelector('.navbtn[data-panel="' + id + '"]');
    if (btn && btn.hidden && !(opts && opts.allowForbidden)) id = firstAllowedPanel();
    activePanel = id;
    PANELS.forEach((pid) => { const p = $(pid); if (p) p.hidden = pid !== id; });
    document.querySelectorAll(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.panel === id));
    if (PANEL_TABS[id]) {
      // Reconcile before painting: opening a panel must never show a pane the
      // strip disagrees with.
      selectTab(id, (opts && opts.tab) || activeTab[id], { load: false });
    }
    runActiveLoader();
    // Overview has no loader — it is drawn by the status poll — so redraw it from
    // the last poll on open instead of showing a blank panel for up to 2s.
    if (id === "dlgOverview" && lastStatus) renderOverview(lastStatus);
    if (!(opts && opts.silent)) writeHash();
  }
  // The first-run chooser reaches Services before capabilities mean anything.
  function showPanelInternal(id) { showPanel(id, { allowForbidden: true }); }

  /* Every jump goes through here — nav rows, count badges, Overview tiles, the
     ticker, the inline remedies on a held-back row. One function so a jump can
     never leave a strip's highlight disagreeing with what is on screen, which
     is the failure the Received/Sent strip had when a tile set histGroup behind
     its back and the strip went on saying "Received". */
  function goTo(panelId, tabId) {
    if (!PANELS.includes(panelId)) {
      // A pane id: the caller is naming what it wants to see, not where it
      // lives. Translate through the same table the legacy hashes use.
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
    $("qrToggle").addEventListener("click", (e) => {
      // Like the printer and RIS cards: starting from the card also flips the
      // "start on launch" flag, because toggle() persists the config first.
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

    // Token prompt.
    // Every listener below goes through this: the dashboard is packaged in a
    // few shapes and a build that ships without one of these elements must not
    // take the whole wiring block down with a TypeError on the first missing id.
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

    // People
    bind("peopleSeed", "click", async (e) => {
      if (!window.confirm(T("Turn on profiles? Everyone will sign in as themselves from now on, and this browser will be signed in as the Administrator. The access token keeps working."))) return;
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const r = await post("/api/profiles/seed", {});
        peopleState = Object.assign({}, peopleState, r);
        profilesOn = true;
        renderPeople();
        // The seed response carries the administrator session it just issued,
        // so the next status poll is what tells this page who it now is.
        await pollStatus();
        flashNote(T("Profiles are on. You are signed in as Administrator."), true);
      } catch (err) {
        flashNote(err.message, false);
      } finally { btn.disabled = false; }
    });
    bind("peopleAdd", "click", () => {
      // A new entry starts disabled, with nothing granted and nothing visible.
      // Every other default would mean a half-filled form is briefly a real
      // account, and the moment where it is real is the moment it has no
      // password.
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

    // Audit
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
      // A plain navigation, not a fetch: the response is a file download and
      // the session cookie rides along with it.
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
      f.type = "text";                  // it has to be readable to be copied — it is shown once
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

    // Service chooser. Three of the four doors are buttons (the fourth is the
    // first status that says nothing has ever been chosen); every one of them is
    // optional markup as far as this file is concerned, so nothing is assumed.
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
    /* One door for everything that jumps somewhere: nav rows, the count badges
       beside them, the Overview tiles, the ticker, and the inline remedies in a
       held-back row. They all carry data-panel and may carry data-tab, so one
       handler covers the lot and a new jump target needs no new wiring. */
    document.addEventListener("click", (e) => {
      const j = e.target.closest("[data-panel]");
      if (!j || !j.dataset.panel) return;
      if (j.dataset.forbidden === "1" || j.classList.contains("ov-inert")) return;
      goTo(j.dataset.panel, j.dataset.tab || null);
    });

    /* Panel-level tab strips (Studies / Configuration / Activity). Scoped to
       .panel-tabs and to [data-tab]: the Orders strip is keyed on data-ostatus
       and the History strip on data-group, and neither is a panel tab. */
    document.querySelectorAll(".panel-tabs .hist-tab[data-tab]").forEach((tab) =>
      tab.addEventListener("click", () => {
        const panel = tab.closest(".workpanel");
        if (panel) { selectTab(panel.id, tab.dataset.tab); writeHash(); }
      }));
    // Arrow keys along a strip, as a tablist is expected to behave. selectTab
    // owns the roving tabindex, so the moved-to tab is the one focus lands on.
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
    /* Arrow keys along this strip too. The generic handler above is scoped to
       .panel-tabs and deliberately does not match here, and without this the
       roving tabindex would make the unselected tab unreachable by keyboard
       entirely — a strip that is worse to use than the plain buttons it
       replaced. */
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
    // Same route as Save destinations: the whole config document, so the
    // server's own validator is what decides a registry is acceptable.
    $("saveMods").addEventListener("click", async () => {
      // A saved registry changes which rooms the order form offers AND which
      // modality codes it marks as answered, so both are rebuilt.
      if (await saveConfig()) { loadedModalities = collectMods(); refreshTargetChoices(); }
    });
    // Mute toggle for the arrival beep. Unmuting also arms the audio context on
    // this very click, so a receptionist who turns the sound back on does not
    // have to click a second time somewhere else to hear the next order.
    $("ordBeep").addEventListener("click", () => {
      // While the button reads "Arm sound" the click in front of it is a
      // request to ARM, not to mute — and it is itself the user gesture the
      // browser was holding out for, which is why this branch exists rather
      // than a second control. The exception is a browser with no usable audio
      // at all: retrying there would leave the operator pressing a button that
      // visibly does nothing, so the click falls through to the mute toggle and
      // an unmute retries the arming anyway.
      if (beepOn() && !audioReady() && !audioFailed) { armAudio(); return; }
      const on = !beepOn();
      setBeepOn(on);
      if (on) armAudio();
      paintBeepBtn();
    });
    /* Picking the room fills in the modality, which is what the Modalities tab
       has been telling operators the registered code is for ("used to prefill
       an order aimed at this room") without anything doing it. Only ever into a
       blank field — an operator who chose a modality outranks the registry —
       and only for a code this list actually offers, so the prefill cannot
       reintroduce a value no scanner asks for. The select shows the answer, so
       nothing is decided behind the operator's back. */
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
    // The nav row itself needs no wiring — the delegated [data-panel] handler
    // covers it, and carino:langchange re-runs loadDevPeer through
    // runActiveLoader().
    $("dpCreate").addEventListener("click", () => devPeerAction("create", $("dpCreate")));
    $("dpDiscard").addEventListener("click", () => devPeerAction("discard", $("dpDiscard")));

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
      // Its own element, so renderOverview does not reach it — and it can be on
      // screen with no poll pending at all.
      paintDesktopUpdate();
      retitleWatcherWarn();
      // Rendered by this file, so the language pass does not reach them.
      renderAuthState();
      // Its label, title and spoken name are written by JS because they depend
      // on the mute state, so the static pass has nothing to retranslate.
      paintBeepBtn();
      /* Both targeting lists were written by this file too — the static pass
         only reaches the one blank option that ships in the markup, and that
         one has already been replaced. The station list is here as well as the
         modality list now that it is the control reception actually sees: its
         blank choice and the two group headings beside the codes are sentences,
         not protocol identifiers, and a half-Spanish dropdown is exactly what
         the language pass exists to prevent. Each carries its selection across,
         so a half-typed order survives the switch. */
      refreshTargetChoices();
      // The tab strips DID just get retranslated by the static pass, so the
      // subtitles built from their labels are now a sentence in two languages.
      Object.keys(PANEL_TABS).forEach(writeTabSub);
      // The gate's heading and lede are the opposite problem: they DO carry
      // data-i18n, so the language pass writes the token wording back over
      // whichever shape the gate is actually in. Switch language in front of
      // the profile picker and it starts asking for an access token that is
      // not on screen. Re-applying the mode restores both lines.
      if (gateOpen) setGateMode(gateMode);
      if (lastStatus) {
        renderIndex(lastStatus.index || {});
        renderDicomweb(lastStatus.dicomweb || {});
        renderDeidState(lastStatus.deid || {});
      }
      if (gateOpen) return;      // behind the prompt there is nothing to refetch
      pollStatus();
      // i18n.js's static data-i18n pass has already run (it registers at script
      // eval, this handler inside DOMContentLoaded), so everything app.js drew
      // itself — every history, stuck, pending, order, person and audit row —
      // is still in the old language until this repaints it.
      runActiveLoader();
    });

    // Back, and the address bar. popstate is the ONLY resolver: pushState is
    // silent, so a programmatic panel change cannot re-enter through hashchange.
    // hashchange exists solely for somebody editing the fragment by hand, and
    // short-circuits when it already matches what is rendered.
    window.addEventListener("popstate", () => resolveHash(location.hash));
    window.addEventListener("hashchange", () => {
      if (location.hash === currentHash()) return;
      resolveHash(location.hash);
    });
    retitleWatcherWarn();
    // Independent of auth: it reads nothing from the engine, and behind the gate
    // there is no Overview panel to see it in anyway.
    initDesktopShell();
    // Auth before anything else. With a token configured every /api route 401s,
    // so loading the config or starting the pollers first would just knock on a
    // closed door — GET /api/auth is public precisely so this decision can be
    // made before a single protected request is made.
    boot();
  });

  /* ── The address bar ─────────────────────────────────────────────
     One writer, one canonical form. showPanel() and selectTab() go through
     writeHash(), which pushes with history.pushState — silent, so it fires
     neither hashchange nor popstate and a transition can never write twice.
     The form is always #panel or #panel/tab, so there are not two spellings of
     one state to ping-pong between.

     Names are the words on the buttons, not the element ids: #studies/stuck is
     something you can read out over a phone during an outage, which is the
     situation this dashboard is for. The old #dlgXxx spellings still resolve —
     the manuals and any bookmark made in the last year use them. */
  const HASH_NAME = {
    dlgOverview: "overview", dlgServices: "services", dlgStudies: "studies",
    dlgOrders: "orders", dlgConfig: "configuration", dlgActivity: "activity",
    dlgDevPeer: "devpeer",
  };
  const PANEL_BY_HASH = {};
  Object.entries(HASH_NAME).forEach(([id, name]) => { PANEL_BY_HASH[name] = id; });
  // Every absorbed panel id resolves to the panel/tab that swallowed it, so a
  // bookmarked #dlgStuck still lands on the stuck list.
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
  /* Overview is deep-linkable but never persisted. Someone who asks for it by
     URL gets it; it must never become the panel an UNATTENDED screen restores
     to, because it prints a patient name and an accession and a reload, an
     Electron restart that keeps the fragment, or a kiosk recovery would all
     land there after a single visit. */
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
  /* Run once, when the dashboard actually starts: behind the token prompt there
     is no panel to open yet. An unrecognised fragment is LEFT ALONE here rather
     than overwritten — at boot it may belong to something other than this
     router, and clobbering it would destroy the parameter before its owner
     could read it. Every later panel change writes normally. */
  function openInitialPanel() {
    if (resolveHash(location.hash)) return;
    showPanel(firstAllowedPanel(), { silent: !!location.hash });
  }
})();
