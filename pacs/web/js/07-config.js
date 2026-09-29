/* Config load/populate, web.auth_token handling, modality registry, order-form targeting and collectConfig. */
"use strict";
  // ---- Config load / populate ----
  async function loadConfig() {
    const c = await api("/api/config");
    loadedModalities = Array.isArray(c.modalities) ? c.modalities : [];
    loadedWorklistSource = c.worklist_source || {};
    $("wsHost").value = loadedWorklistSource.host || "";
    $("wsPort").value = loadedWorklistSource.port || 105;
    $("wsAet").value = loadedWorklistSource.aet || "";
    $("wsTls").checked = !!loadedWorklistSource.tls;
    renderMods(loadedModalities);
    // The config copy of the registry is richer than the status one: rebuild targeting from it.
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
    // The C-MOVE map has no form control and is saved untouched; just show what it resolves.
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
    // After the destination table: rule checkboxes are built from the rows on screen.
    $("rtEnabled").checked = !!(c.routing && c.routing.enabled);
    renderRules((c.routing && c.routing.rules) || []);
    renderAuthState();
    reflowActive();
  }

  // ---- web.auth_token ----
  // GET /api/config redacts it and POST refuses it; it changes only via applyToken(). Never post
  // a redaction back as the value: that would replace a working credential and lock the operator out.
  const AUTH_FLAG_KEYS = ["auth_token_set", "auth_token_present", "has_auth_token", "auth_token_redacted"];
  const REDACTED_RE = /^(?:[*•·●]{3,}|\(set\)|<redacted>|redacted)$/i;
  let tokenSet = false;        // does the engine hold a token at all?

  function readWebSection(w) {
    loadedWeb = { ...w };
    delete loadedWeb.auth_token;
    AUTH_FLAG_KEYS.forEach((k) => delete loadedWeb[k]);
    const raw = w.auth_token;
    // Keep it only if it is plainly a real token; anything else (absent, mask, boolean) is omitted
    // so the engine keeps what it has.
    const real = typeof raw === "string" && raw.trim() !== "" && !REDACTED_RE.test(raw.trim());
    if (real) loadedWeb.auth_token = raw;
    // Whether a token exists comes from the engine's flag, not from the redacted value.
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
    // Set by the dev peer, which deletes these rows on discard; a Save must return it unchanged
    // (the whole-document-save hazard in CONTRIBUTING.md).
    tr.dataset.ephemeral = d.ephemeral ? "1" : "";
    if (d.ephemeral) {
      // Flag it visibly so nobody turns it into a real destination; it stays editable for the demo recipe.
      const why = T("Created by the dev peer — this row is deleted when the peer is discarded. Do not reuse it for a real node.");
      tr.classList.add("dest-ephemeral");
      tr.querySelector(".d-name").title = why;
      tr.querySelector(".d-host").title = why;
    }
    tr.querySelector(".del").addEventListener("click", () => tr.remove());
    tr.querySelector(".echo").addEventListener("click", () => echoRow(tr));
    $("destBody").appendChild(tr);
  }
  // ---- Modality registry ----
  // Same shape as the destinations table, but these peers pull a worklist; destinations receive studies.
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
  // Ask the other RIS what it would give one modality. Confirmed first: it borrows the scanner's AE title.
  async function probeModality(tr, btn) {
    const aet = tr.querySelector(".m-aet").value.trim().toUpperCase();
    const name = tr.querySelector(".m-name").value.trim() || aet;
    if (!aet) { flashNote(T("Give the modality an AE title first"), false); return; }
    // One literal, not a concatenation: i18n-parity extracts the string inside TF().
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

  // Probe rounds, newest first; each answer shows the here / nobody / elsewhere split, which carries the diagnosis.
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
          // Never a bare count: orders addressed to nobody reach every modality.
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
        // Upper-cased: rows differing only in case are duplicates the config validator refuses.
        aet: tr.querySelector(".m-aet").value.trim().toUpperCase(),
        modality: tr.querySelector(".m-mod").value.trim().toUpperCase(),
        station_name: tr.querySelector(".m-station").value.trim(),
      }))
      .filter((m) => m.name && m.aet);
  }

  // Whether the Modalities rows exist to collect from; if absent, the loaded snapshot is used.
  function modsOpen() { return !!$("modBody"); }

  /* Registered equipment from whichever copy this profile may have: the config (config.read)
     or the status payload (e.g. reception), so the order form is a closed list at the front desk. */
  function knownModalities() {
    const src = (loadedModalities && loadedModalities.length) ? loadedModalities : statusModalities;
    return (src || []).filter((m) => m && m.enabled !== false && m.aet);
  }

  /* Modality codes some registered console answers to. An EMPTY set means "not known", never
     "none": the code is optional in config.py, so one room without a code makes the answer empty.
     `enabled` is ignored (as in server _station_is_unknown): it governs sending, not worklist queries. */
  function configuredModalityCodes() {
    // Same source choice as knownModalities(), but unfiltered (includes disabled rooms).
    const rows = (loadedModalities && loadedModalities.length) ? loadedModalities : statusModalities;
    const out = new Set();
    for (const m of (rows || [])) {
      if (!m) continue;
      const code = String(m.modality || "").trim().toUpperCase();
      // One blank code makes the whole answer "not known".
      if (!code) return new Set();
      out.add(code);
    }
    return out;
  }

  // Both order-form targeting controls come from the registry, so they are refilled together.
  function refreshTargetChoices() {
    registryChanged();          // adopt the signature, so the next poll does not redo this
    fillStationChoices();
    fillModalityChoices();
  }

  // renderStatus asks every poll; rebuild only on change, since a rebuild closes an open <select>.
  let registrySig = null;
  function registryChanged() {
    const sig = JSON.stringify(knownModalities().map((m) => [m.aet, m.modality || "", m.name || ""]));
    if (sig === registrySig) return false;
    registrySig = sig;
    return true;
  }

  /* Order-form target (ScheduledStationAETitle), matched by exact string in mwl.py, so with a
     registry it is a closed list of AE titles, blank ("every worklist") first. With no registry
     it stays free text: an order that cannot be aimed is worse than a typo. */
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
    // No target = shows on EVERY worklist; offered as a named choice, not an empty-field accident.
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
    // Drop typed text the picker rejected, or it would resurface if the registry ever emptied.
    else txt.value = "";
    sel.hidden = false; txt.hidden = true;
  }

  /* Order-form modality as a closed list of DICOM codes: worklist matching is exact, so free text
     ("ct head") reaches no modality-filtered console. Codes are never translated; the exam words are.
     A constant, so reception (no config.read) gets it too; anything else is OT. */
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
    // Keep the selection: this re-runs on carino:langchange.
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
    /* With a known registry, group registered codes ahead of the rest (e.g. CR vs DX for one X-ray room).
       Marks, never removes: an unregistered code stays choosable and addOrder() warns. Unknown registry = flat list. */
    const here = configuredModalityCodes();
    if (here.size) {
      const mine = document.createElement("optgroup");
      mine.label = T("Registered here — a console asks for these");
      const rest = document.createElement("optgroup");
      rest.label = T("Not registered here — no console asks for these");
      modalityChoices().forEach(([code, label]) => add(here.has(code) ? mine : rest, code, label));
      // Registered codes outside the built-in list are offered too, as the bare code.
      const named = new Set(modalityChoices().map(([code]) => code));
      [...here].filter((code) => !named.has(code)).sort().forEach((code) => add(mine, code, ""));
      if (mine.children.length) sel.appendChild(mine);
      if (rest.children.length) sel.appendChild(rest);
    } else {
      modalityChoices().forEach(([code, label]) => add(sel, code, label));
    }
    // select.options is flat across optgroups, so grouping does not affect this.
    if (chosen && [...sel.options].some((o) => o.value === chosen)) sel.value = chosen;
  }

  // "Test order" fills a fixed invented patient (recognisable among real orders); the operator
  // still chooses modality and time, the two things a chain test varies.
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
    // Fresh accession each time: two open orders must never share one.
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
    const note = $("ordTestNote");
    if (note) note.hidden = !on;
  }

  // The station the operator picked, whichever control is on screen.
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
    // Spread each loaded section first so keys without a form input survive the save.
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
      // apply_config merges over DEFAULTS, so an omitted key is reset (CONTRIBUTING): send the snapshot if the tab is absent.
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
      // Redacted secrets stay redacted; the server keeps the stored webhook key and SMTP password.
      notify: { ...loadedNotify },
      // No form input: carried through so a Save cannot wipe the onboarding stamp.
      setup_completed: loadedSetup,
      logs_dir: loadedLogsDir,
    };
  }

