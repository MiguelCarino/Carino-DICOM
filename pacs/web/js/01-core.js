/* Dashboard core: DOM/i18n helpers, the api()/post() wrappers and the shared loaded-config and poll state. */
"use strict";

  const $ = (id) => document.getElementById(id);

  /* AE titles, bind:port and paths render as .atomic/.path (CSS ellipsis), so the
     full value is mirrored into title= to keep the hidden tail recoverable. */
  const dash = (v) => (v == null || v === "" ? "—" : v);
  function setAtomic(id, value) { const el = $(id); if (!el) return; el.textContent = dash(value); el.title = dash(value); }
  function setPath(id, p) { const el = $(id); if (!el) return; el.textContent = dash(p); el.title = dash(p); }

  // ---- i18n ----
  /* JS-rendered text is translated at render time (i18n.js handles [data-i18n] markup):
       T(s) plain · TF(s, vals) {named} placeholders · TN(n, s) plural-aware {n}
       I18N_IN(root) translates a <template> clone, which i18n.js cannot see.
     All fall back to English if i18n.js is missing; engine messages (r.message) stay untranslated. */
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
      // Machine-readable outcome code, so callers can show a translated rejection
      // instead of the engine's English err.message.
      err.code = body.code || "";
      // Test auth.required, not ok:false (every API error is ok:false). See pacs/auth.py.
      err.auth = (body.auth && body.auth.required) ? body.auth : null;
      // Prompt here so every caller (including polls after a restart) shares one recovery path.
      if (err.auth) onAuthRejected(err.auth);
      throw err;
    }
    return body;
  };
  // Every write (including POST /api/login) needs X-Carino: 1, or web.py's
  // cross-site guard answers 403 before the credential is even checked.
  const post = (url, data) =>
    api(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Carino": "1" }, body: JSON.stringify(data || {}) });

  // Full loaded config sections, posted back on Save so keys without a form input
  // survive: apply_config merges over DEFAULTS, so an omitted section is RESET
  // (routing loses every rule, dicomweb/qr switch off). Every engine section needs one.
  let loadedScp = {}, loadedScu = {}, loadedPrint = {}, loadedRis = {}, loadedMwl = {}, loadedEmg = {};
  let loadedQr = {}, loadedDicomweb = {}, loadedRouting = {}, loadedIndex = {}, loadedDeid = {};
  // audit/notify have no form fields but must be carried or a Save resets them.
  // `users` is deliberately absent: the server ignores it here so config.write cannot grant admin.
  let loadedAudit = {}, loadedNotify = {};
  // Posted back verbatim by a Save from other tabs, or apply_config resets it to []. See collectConfig.
  let loadedModalities = [];
  /* Station registry from /api/status (ungated: room names and AE titles only, no
     PHI), since reception lacks config.read. Empty on older engines -> free-text AE field. */
  let statusModalities = [];
  let loadedWorklistSource = {};
  let loadedWeb = { host: "127.0.0.1", port: 8042 };
  // Top-level onboarding stamp; carried through Save or the setup chooser reappears.
  let loadedSetup = "";
  let loadedLogsDir = "";   // no form field; cfg.replace merges over DEFAULTS, so a Save would reset it
  let statusTimer = null, logTimer = null;
  let editorUrl = "";                                // DICOM-editor base URL (from status); "" hides ✎ Edit
  let devPeerAvailable = false;                      // --dev-peer was given AND we may see it (the status block is gated)
  let lastStatus = null;                             // newest /api/status, for the panels that render on demand

  /* Emergency-RIS order baselines, adopted from the first status payload so a reload never announces history.
       lastCreatedSeq   ris.created_seq, bumped once per created order (diffed, never shown)
       lastOrderCounts  "open/closed/total"; moves on create, every close path and cancel -> repaints Orders */
  let lastCreatedSeq = null;   // null = no baseline yet
  let lastOrderCounts = null;  // null = no baseline yet

