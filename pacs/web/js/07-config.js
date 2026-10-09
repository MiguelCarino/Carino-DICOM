/* Config load/populate, web.auth_token handling, modality registry, order-form targeting and collectConfig. */
"use strict";
// ---- Config load / populate ----
// Snapshots spread back by collectConfig so keys without a form input survive a Save.
function rememberLoadedSections(c) {
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
}

// Section fillers: one settings card each, called by loadConfig in page order.
function fillScpForm(scp) {
  $("scpEnabled").checked = !!scp.enabled;
  $("scpAet").value = scp.aet;
  $("scpBind").value = scp.bind;
  $("scpPort").value = scp.port;
  $("scpDir").value = scp.storage_dir;
  $("scpOrganize").checked = !!scp.organize;
  $("scpMinFree").value = scp.min_free_gb != null ? scp.min_free_gb : 2;
  $("scpAllowed").value = (scp.allowed_aets || []).join(", ");
  $("scpTls").checked = !!scp.tls;
  $("scpTlsCert").value = scp.tls_cert || "";
  $("scpTlsKey").value = scp.tls_key || "";
  $("scpTlsCa").value = scp.tls_ca || "";
}

function fillScuForm(scu) {
  $("scuEnabled").checked = !!scu.enabled;
  $("scuAet").value = scu.aet;
  $("scuDir").value = scu.watch_dir;
  $("scuPoll").value = scu.poll_interval;
  $("scuMode").value = scu.on_success;
  $("scuSent").value = scu.sent_dir;
  $("scuTlsVerify").checked = scu.tls_verify !== false;
  $("scuTlsCa").value = scu.tls_ca || "";
  $("scuTlsCert").value = scu.tls_cert || "";
  $("scuTlsKey").value = scu.tls_key || "";
}

function fillPrintForm(pr) {
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
}

function fillRisForm(ri) {
  $("risEnabled").checked = !!ri.enabled;
  $("risBind").value = ri.bind || "0.0.0.0";
  $("risPort").value = ri.port != null ? ri.port : 2575;
  $("risDir").value = ri.store_dir || "./ris";
  $("risMatch").value = ri.match_on === "accession_or_patient" ? "accession_or_patient" : "accession";
  $("risAutoClose").checked = ri.auto_close !== false;
  $("risHosts").value = (ri.allowed_hosts || []).join(", ");
  buildModalityPicker($("risModPicker"), ri.modalities || []);
}

function fillMwlForm(mi) {
  $("mwlEnabled").checked = !!mi.enabled;
  $("mwlAet").value = mi.aet || "CARINOMWL";
  $("mwlBind").value = mi.bind || "0.0.0.0";
  $("mwlPort").value = mi.port != null ? mi.port : 11114;
  $("mwlAllowed").value = (mi.allowed_aets || []).join(", ");
  $("mwlTls").checked = !!mi.tls;
  $("mwlTlsCert").value = mi.tls_cert || "";
  $("mwlTlsKey").value = mi.tls_key || "";
  $("mwlTlsCa").value = mi.tls_ca || "";
}

function fillEmergencyForm(eg) {
  $("emgArmed").checked = !!eg.armed;
  $("emgProbe").value = eg.probe_interval_sec != null ? eg.probe_interval_sec : 30;
  $("emgThreshold").value = eg.offline_threshold_sec != null ? eg.offline_threshold_sec : 120;
  $("emgRecovery").value = eg.recovery_successes != null ? eg.recovery_successes : 2;
  $("emgAuto").checked = !!eg.auto_activate;
  $("emgHold").checked = eg.hold_and_forward !== false;
}

function fillQrForm(qc) {
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
}

async function loadConfig() {
  // Without config.read the document is not ours to see; Destinations/Routing come from the
  // routing.read view instead (read-only), and nothing else needs the config.
  if (!can("config.read")) {
    if (can("routing.read")) await loadRoutingReadOnly();
    return;
  }
  let etag = "";
  const c = await api("/api/config", { onResponse: (res) => { etag = res.headers.get("ETag") || ""; } });
  configEtag = etag;
  loadedRaw = c;
  setConfigReadOnly(false);
  showStale(false);
  loadedModalities = Array.isArray(c.modalities) ? c.modalities : [];
  loadedWorklistSource = c.worklist_source || {};
  $("wsHost").value = loadedWorklistSource.host || "";
  $("wsPort").value = loadedWorklistSource.port || 105;
  $("wsAet").value = loadedWorklistSource.aet || "";
  $("wsTls").checked = !!loadedWorklistSource.tls;
  renderMods(loadedModalities);
  // The config copy of the registry is richer than the status one: rebuild targeting from it.
  refreshTargetChoices();
  rememberLoadedSections(c);
  readWebSection(c.web || {});
  $("webEditorUrl").value = (c.web && c.web.editor_url) || "";
  $("webUpdateCheck").checked = !!(c.web && c.web.update_check === true);
  fillScpForm(c.scp);
  fillScuForm(c.scu);
  fillPrintForm(c.print || {});
  fillRisForm(c.ris || {});
  fillMwlForm(c.mwl || {});
  fillEmergencyForm(c.emergency || {});
  fillQrForm(c.qr || {});
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
  syncTlsFields();
  settingsDirty = false;
}

/* GET /api/routing (routing.read): the rules and the ENABLED destination names, nothing else. Shown
   so a profile that may read routing sees the real rules, not an empty editor and a 403 toast. */
async function loadRoutingReadOnly() {
  const r = await api("/api/routing");
  renderDests((r.destinations || []).map((name) => ({ name, enabled: true })));
  $("rtEnabled").checked = !!r.enabled;
  renderRules(r.rules || []);
  setConfigReadOnly(true);
}

// Read-only Destinations/Routing: every editing control disabled; the routing test stays usable.
let configReadOnly = false;
function setConfigReadOnly(ro) {
  configReadOnly = ro;
  const note = $("cfgReadOnly");
  if (note) note.hidden = !ro;
  ["#dlgDests input", "#dlgDests .del", "#dlgDests .echo", "#rtRules input", "#rtRules button", "#rtEnabled"]
    .forEach((sel) => document.querySelectorAll(sel).forEach((el) => { el.disabled = ro; }));
}

// TLS certificate/key/CA fields show only while their TLS box is ticked.
function syncTlsFields() {
  document.querySelectorAll(".tls-fields[data-tls-for]").forEach((box) => {
    const cb = $(box.dataset.tlsFor);
    box.hidden = !(cb && cb.checked);
  });
}

// Unsaved Settings edits, so "Re-run service setup" can warn before it reloads the form.
let settingsDirty = false;

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
  tr.querySelector(".del").addEventListener("click", () => { tr.remove(); checkDestPorts(); });
  tr.querySelector(".echo").addEventListener("click", () => echoRow(tr));
  [".d-name", ".d-host", ".d-port", ".d-aet", ".d-en"].forEach((sel) =>
    tr.querySelector(sel).addEventListener("input", checkDestPorts));
  $("destBody").appendChild(tr);
  checkDestPorts();
}

/* A destination receives images. A worklist, Q/R, print or HL7 port answers on the network too, and
   a worklist even answers C-ECHO, so a row aimed at one looks fine until every study sent there
   fails. Flag the rows whose host:port is one of those, while they are being typed. */
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1", "0.0.0.0"];
function destPortProblem(host, port) {
  if (!host || !port) return "";
  const h = host.trim().toLowerCase();
  const here = LOCAL_HOSTS.includes(h) || (lastStatus ? hostIps(lastStatus) : []).includes(h);
  const ours = [
    [loadedMwl.port, T("this PC's worklist")],
    [loadedQr.port, T("this PC's Query/Retrieve")],
    [loadedPrint.port, T("this PC's print receiver")],
    [loadedRis.port, T("this PC's HL7 order intake")],
  ];
  if (here) {
    const hit = ours.find(([p]) => Number(p) === port);
    if (hit) return hit[1];
  }
  const ws = loadedWorklistSource || {};
  if (ws.host && ws.host.trim().toLowerCase() === h && Number(ws.port) === port) return T("the hospital worklist");
  if (port === 2575) return T("the usual HL7 port");
  // Another Carino DICOM keeps these defaults unless someone changed them — the case that started this.
  if (port === 11114) return T("Carino DICOM's default worklist port");
  if (port === 11115) return T("Carino DICOM's default Query/Retrieve port");
  if (port === 11113) return T("Carino DICOM's default print port");
  return "";
}
function checkDestPorts() {
  const out = [];
  document.querySelectorAll("#destBody tr").forEach((tr) => {
    const host = tr.querySelector(".d-host").value;
    const port = parseInt(tr.querySelector(".d-port").value, 10);
    const what = destPortProblem(host, port);
    tr.classList.toggle("dest-suspect", !!what);
    if (what) {
      const name = tr.querySelector(".d-name").value.trim() || host + ":" + port;
      out.push(TF("{name}: {host}:{port} is {what}, which does not store images. Studies sent there will fail — use the PACS's storage port (often 104 or 11112).",
        { name, host: host.trim(), port, what }));
    }
  });
  const note = $("destWarn");
  if (!note) return;
  note.hidden = !out.length;
  note.textContent = out.join("\n");
}
// A room registered under a code the site does not have: its orders cannot be made from the form.
function flagModRow(tr) {
  const input = tr.querySelector(".m-mod");
  const code = input.value.trim().toUpperCase();
  const site = siteModalities();
  const off = !!code && site.size > 0 && !site.has(code);
  tr.classList.toggle("mod-suspect", off);
  input.title = off
    ? TF("{code} is not one of this site's modalities, so no order can be made for this room. Add it in Settings → Worklist and orders, or fix the code.", { code })
    : T("CT, MR, US, CR… used to prefill an order aimed at this room");
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
  tr.querySelector(".m-mod").addEventListener("input", () => flagModRow(tr));
  flagModRow(tr);
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
    // The answer is a probe round in Activity → Worklist probes: go there and mark the new one.
    if (r.ok) { goTo("dlgActivity", "caught"); loadCaught(true); }
  } catch (e) {
    flashNote(e.message, false);
  } finally {
    btn.textContent = old; btn.disabled = false;
  }
}

// Probe rounds, newest first; each answer shows the here / nobody / elsewhere split, which carries the diagnosis.
async function loadCaught(markNewest) {
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
      q.textContent = probeQuestion(pr);
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
  // Newest first, so the round just asked for is the first one.
  const first = markNewest === true && list.querySelector(".caught-round");
  if (first) { first.classList.add("fresh"); first.scrollIntoView({ block: "nearest" }); }
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
    .filter((m) => m.name || m.aet || m.modality || m.station_name);
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
  // An order being edited keeps its own target even when that room left the registry (or was
  // disabled): rebuilding the list must not quietly turn it into "Any modality".
  const editing = typeof editingOrder !== "undefined" && editingOrder && editingOrder.station_aet;
  if (editing && chosen === editing) addStationOption(sel, chosen);
  if (chosen && [...sel.options].some((o) => o.value === chosen)) sel.value = chosen;
  // Drop typed text the picker rejected, or it would resurface if the registry ever emptied.
  else txt.value = "";
  sel.hidden = false; txt.hidden = true;
}

/* Order-form modality as a closed list of DICOM codes: worklist matching is exact, so free text
   ("ct head") reaches no modality-filtered console. Every Defined Term of Modality (0008,0060) in
   PS3.3 C.7.3.1.1.1, in the standard's order and with its own wording; codes are never translated,
   the descriptions are. A constant, so reception (no config.read) gets it too. */
function modalityChoices() {
  return [
    ["ANN", T("Annotation")],
    ["AR", T("Autorefraction")],
    ["ASMT", T("Content Assessment Results")],
    ["AU", T("Audio")],
    ["BDUS", T("Bone Densitometry (ultrasound)")],
    ["BI", T("Biomagnetic imaging")],
    ["BMD", T("Bone Densitometry (X-Ray)")],
    ["CFM", T("Confocal Microscopy")],
    ["CR", T("Computed Radiography")],
    ["CT", T("Computed Tomography")],
    ["CTPROTOCOL", T("CT Protocol (Performed)")],
    ["DMS", T("Dermoscopy")],
    ["DG", T("Diaphanography")],
    ["DOC", T("Document")],
    ["DX", T("Digital Radiography")],
    ["ECG", T("Electrocardiography")],
    ["EEG", T("Electroencephalography")],
    ["EMG", T("Electromyography")],
    ["EOG", T("Electrooculography")],
    ["EPS", T("Cardiac Electrophysiology")],
    ["ES", T("Endoscopy")],
    ["FID", T("Fiducials")],
    ["GM", T("General Microscopy")],
    ["HC", T("Hard Copy")],
    ["HD", T("Hemodynamic")],
    ["IO", T("Intra-Oral Radiography")],
    ["IOL", T("Intraocular Lens Data")],
    ["IVOCT", T("Intravascular Optical Coherence Tomography")],
    ["IVUS", T("Intravascular Ultrasound")],
    ["KER", T("Keratometry")],
    ["KO", T("Key Object Selection")],
    ["LEN", T("Lensometry")],
    ["LS", T("Laser surface scan")],
    ["MG", T("Mammography")],
    ["MR", T("Magnetic Resonance")],
    ["M3D", T("Model for 3D Manufacturing")],
    ["NM", T("Nuclear Medicine")],
    ["OAM", T("Ophthalmic Axial Measurements")],
    ["OCT", T("Optical Coherence Tomography (non-Ophthalmic)")],
    ["OP", T("Ophthalmic Photography")],
    ["OPM", T("Ophthalmic Mapping")],
    ["OPT", T("Ophthalmic Tomography")],
    ["OPTBSV", T("Ophthalmic Tomography B-scan Volume Analysis")],
    ["OPTENF", T("Ophthalmic Tomography En Face")],
    ["OPV", T("Ophthalmic Visual Field")],
    ["OSS", T("Optical Surface Scan")],
    ["OT", T("Other")],
    ["PA", T("Photoacoustic")],
    ["PLAN", T("Plan")],
    ["POS", T("Position Sensor")],
    ["PR", T("Presentation State")],
    ["PT", T("Positron emission tomography (PET)")],
    ["PX", T("Panoramic X-Ray")],
    ["REG", T("Registration")],
    ["RESP", T("Respiratory")],
    ["RF", T("Radio Fluoroscopy")],
    ["RG", T("Radiographic imaging (conventional film/screen)")],
    ["RTDOSE", T("Radiotherapy Dose")],
    ["RTIMAGE", T("Radiotherapy Image")],
    ["RTINTENT", T("Radiotherapy Intent")],
    ["RTPLAN", T("Radiotherapy Plan")],
    ["RTRAD", T("RT Radiation")],
    ["RTRECORD", T("RT Treatment Record")],
    ["RTSEGANN", T("Radiotherapy Segment Annotation")],
    ["RTSTRUCT", T("Radiotherapy Structure Set")],
    ["RWV", T("Real World Value Map")],
    ["SEG", T("Segmentation")],
    ["SM", T("Slide Microscopy")],
    ["SMR", T("Stereometric Relationship")],
    ["SR", T("SR Document")],
    ["SRF", T("Subjective Refraction")],
    ["STAIN", T("Automated Slide Stainer")],
    ["TEXTUREMAP", T("Texture Map")],
    ["TG", T("Thermography")],
    ["US", T("Ultrasound")],
    ["VA", T("Visual Acuity")],
    ["XA", T("X-Ray Angiography")],
    ["XAPROTOCOL", T("XA Protocol (Performed)")],
    ["XC", T("External-camera Photography")],
  ];
}
// "US - Ultrasound": the code first, because it is what the console and the worklist match on.
const modalityLabel = (code, label) => (label ? code + " - " + label : code);

/* "Modalities at this site" (ris.modalities): [] means every code. Read from /api/status, so the
   reception profile (orders.read, no config.read) gets the same narrowed order form. */
function siteModalities() {
  const list = lastStatus && Array.isArray(lastStatus.site_modalities) ? lastStatus.site_modalities : [];
  return new Set(list.map((c) => String(c).toUpperCase()));
}
// The usual imaging rooms first; the rest of the 79 sit behind "Show all codes".
const COMMON_MODALITIES = ["US", "CT", "MR", "CR", "DX", "MG", "XA", "RF", "NM", "PT"];
function buildModalityPicker(el, selected) {
  if (!el) return;
  const chosen = new Set((selected || []).map((c) => String(c).toUpperCase()));
  el.textContent = "";
  const all = modalityChoices();
  const box = ([code, label]) => {
    const l = document.createElement("label");
    l.className = "mod-chip";
    l.title = label;
    const i = document.createElement("input");
    i.type = "checkbox";
    i.value = code;
    i.checked = chosen.has(code);
    l.append(i, " " + modalityLabel(code, label));
    return l;
  };
  const common = document.createElement("div");
  common.className = "mod-chips";
  all.filter(([c]) => COMMON_MODALITIES.includes(c)).forEach((m) => common.appendChild(box(m)));
  const more = document.createElement("details");
  more.className = "mod-more";
  const sum = document.createElement("summary");
  sum.textContent = T("Show all codes");
  const rest = document.createElement("div");
  rest.className = "mod-chips";
  all.filter(([c]) => !COMMON_MODALITIES.includes(c)).forEach((m) => rest.appendChild(box(m)));
  // A saved code from the long list is open on arrival, so nobody saves over it unseen.
  more.open = [...chosen].some((c) => !COMMON_MODALITIES.includes(c));
  more.append(sum, rest);
  el.append(common, more);
}
function pickerValue(el) {
  if (!el) return [];
  const on = new Set([...el.querySelectorAll("input:checked")].map((i) => i.value));
  return modalityChoices().map(([c]) => c).filter((c) => on.has(c));   // standard order, stable diffs
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
    o.textContent = modalityLabel(code, label);
    parent.appendChild(o);
  };
  /* With a known registry, group registered codes ahead of the rest (e.g. CR vs DX for one X-ray room).
     Marks, never removes: an unregistered code stays choosable and addOrder() warns. Unknown registry = flat list. */
  // Narrowed to the site's own codes when Settings names them. A code the order being edited already
  // carries stays offered, or opening that order would silently change its modality.
  const site = siteModalities();
  const allowed = (rows) => !site.size ? rows : rows.filter(([c]) => site.has(c) || c === chosen);
  const choices = allowed(modalityChoices());
  const here = configuredModalityCodes();
  if (here.size) {
    const mine = document.createElement("optgroup");
    mine.label = T("Registered here — a console asks for these");
    const rest = document.createElement("optgroup");
    rest.label = T("Not registered here — no console asks for these");
    choices.forEach(([code, label]) => add(here.has(code) ? mine : rest, code, label));
    // Registered codes outside the built-in list are offered too, as the bare code.
    // A vendor's private code is offered as the bare code, unless the site list leaves it out.
    const named = new Set(modalityChoices().map(([code]) => code));
    [...here].filter((code) => !named.has(code) && (!site.size || site.has(code)))
      .sort().forEach((code) => add(mine, code, ""));
    if (mine.children.length) sel.appendChild(mine);
    if (rest.children.length) sel.appendChild(rest);
  } else {
    choices.forEach(([code, label]) => add(sel, code, label));
  }
  // select.options is flat across optgroups, so grouping does not affect this.
  if (chosen && [...sel.options].some((o) => o.value === chosen)) sel.value = chosen;
  // One modality at this site: it is the answer, so it is chosen already.
  else if (site.size === 1 && choices.length === 1) sel.value = choices[0][0];
  fillModalityCodeList();
}
// The same codes as suggestions on the Modalities tab, whose field stays free text: a vendor's
// private code has to remain typeable.
function fillModalityCodeList() {
  const list = $("modalityCodes");
  if (!list) return;
  list.textContent = "";
  const site = siteModalities();
  modalityChoices().filter(([c]) => !site.size || site.has(c)).forEach(([code, label]) => {
    const o = document.createElement("option");
    o.value = code;
    o.label = modalityLabel(code, label);
    list.appendChild(o);
  });
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
// A station the registry does not list (removed, renamed or disabled), offered under its own AE title.
function addStationOption(sel, aet) {
  if (!aet || [...sel.options].some((o) => o.value === aet)) return;
  const o = document.createElement("option");
  o.value = aet;
  o.textContent = TF("{aet} — not in the modality list", { aet });
  sel.appendChild(o);
}

// What a probe asked, in the operator's language. Rounds filed before the keys were stored keep the
// engine's English label.
function probeQuestion(pr) {
  if (!pr.calling_key) return pr.label || "";
  return [
    TF("as {aet}", { aet: pr.calling_key }),
    pr.station_key ? TF("station {aet}", { aet: pr.station_key }) : T("any station"),
    pr.date_key ? fmtDate(pr.date_key) : T("any date"),
    pr.modality_key || T("any modality"),
  ].join(", ");
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
    // Only a completely blank row is ignored; a partly filled one is refused by validateRows()
    // before the Save, instead of vanishing with the node it was meant to be.
    .filter((d) => d.name || d.host || d.aet || !isNaN(d.port));
}

const csv = (id) => $(id).value.split(",").map((s) => s.trim()).filter(Boolean);

// Section readers: one settings card each, called by collectConfig in page order.
// Spread each loaded section first so keys without a form input survive the save.
function collectScpForm() {
  const allowed = csv("scpAllowed");
  return {
    ...loadedScp,
    aet: $("scpAet").value.trim(),
    bind: $("scpBind").value.trim() || "0.0.0.0",
    enabled: $("scpEnabled").checked,
    port: parseInt($("scpPort").value, 10),
    storage_dir: $("scpDir").value.trim(),
    organize: $("scpOrganize").checked,
    min_free_gb: parseFloat($("scpMinFree").value) || 0,
    allowed_aets: allowed,
    tls: $("scpTls").checked,
    tls_cert: $("scpTlsCert").value.trim(),
    tls_key: $("scpTlsKey").value.trim(),
    tls_ca: $("scpTlsCa").value.trim(),
  };
}

function collectScuForm() {
  return {
    ...loadedScu,
    enabled: $("scuEnabled").checked,
    aet: $("scuAet").value.trim(),
    watch_dir: $("scuDir").value.trim(),
    poll_interval: parseFloat($("scuPoll").value) || 3,
    on_success: $("scuMode").value,
    sent_dir: $("scuSent").value.trim(),
    tls_verify: $("scuTlsVerify").checked,
    tls_ca: $("scuTlsCa").value.trim(),
    tls_cert: $("scuTlsCert").value.trim(),
    tls_key: $("scuTlsKey").value.trim(),
  };
}

function collectPrintForm() {
  return {
    ...loadedPrint,
    enabled: $("prnEnabled").checked,
    aet: $("prnAet").value.trim() || "CARINOPRINT",
    bind: $("prnBind").value.trim() || "0.0.0.0",
    port: parseInt($("prnPort").value, 10),
    layout: $("prnLayout").value,
    color: $("prnColor").checked,
    allowed_aets: csv("prnAllowed"),
    tls: $("prnTls").checked,
    tls_cert: $("prnTlsCert").value.trim(),
    tls_key: $("prnTlsKey").value.trim(),
    tls_ca: $("prnTlsCa").value.trim(),
  };
}

function collectMwlForm() {
  return {
    ...loadedMwl,
    enabled: $("mwlEnabled").checked,
    aet: $("mwlAet").value.trim() || "CARINOMWL",
    bind: $("mwlBind").value.trim() || "0.0.0.0",
    port: parseInt($("mwlPort").value, 10),
    allowed_aets: csv("mwlAllowed"),
    tls: $("mwlTls").checked,
    tls_cert: $("mwlTlsCert").value.trim(),
    tls_key: $("mwlTlsKey").value.trim(),
    tls_ca: $("mwlTlsCa").value.trim(),
  };
}

function collectEmergencyForm() {
  return {
    ...loadedEmg,
    armed: $("emgArmed").checked,
    probe_interval_sec: parseInt($("emgProbe").value, 10) || 30,
    offline_threshold_sec: parseInt($("emgThreshold").value, 10) || 0,
    recovery_successes: parseInt($("emgRecovery").value, 10) || 1,
    auto_activate: $("emgAuto").checked,
    hold_and_forward: $("emgHold").checked,
  };
}

function collectRisForm() {
  return {
    ...loadedRis,
    enabled: $("risEnabled").checked,
    bind: $("risBind").value.trim() || "0.0.0.0",
    port: parseInt($("risPort").value, 10),
    store_dir: $("risDir").value.trim() || "./ris",
    match_on: $("risMatch").value,
    auto_close: $("risAutoClose").checked,
    allowed_hosts: csv("risHosts"),
    modalities: pickerValue($("risModPicker")),
  };
}

function collectQrForm() {
  return {
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
  };
}

function collectConfig() {
  return {
    scp: collectScpForm(),
    scu: collectScuForm(),
    print: collectPrintForm(),
    mwl: collectMwlForm(),
    emergency: collectEmergencyForm(),
    ris: collectRisForm(),
    qr: collectQrForm(),
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


/* ---- Checks made before a Save is posted ----
   The engine validates too; these catch what it would otherwise reject in config-key jargon, or what
   the old code silently dropped (a destination row missing its port vanished on Save). Each returns
   the first problem as {tab, el, msg} so saveConfig can show it where it is. */
function rowProblem(tab, bodyId, fields) {
  const rows = [...$(bodyId).querySelectorAll("tr")];
  for (let i = 0; i < rows.length; i++) {
    const tr = rows[i];
    tr.classList.remove("row-bad");
    const vals = fields.map(([cls]) => tr.querySelector(cls).value.trim());
    if (vals.every((v) => !v)) continue;                  // a blank starter row is fine
    const miss = fields.findIndex(([, , required], k) => required && !vals[k]);
    const bad = fields.findIndex(([cls]) => !tr.querySelector(cls).checkValidity());
    const k = miss >= 0 ? miss : bad;
    if (k < 0) continue;
    tr.classList.add("row-bad");
    const msg = miss >= 0
      ? TF("Row {n}: {field} is missing", { n: i + 1, field: T(fields[k][1]) })
      : TF("Row {n}: {field} is not valid", { n: i + 1, field: T(fields[k][1]) });
    return { tab, el: tr.querySelector(fields[k][0]), msg };
  }
  return null;
}
function rulesProblem() {
  const rules = [...document.querySelectorAll("#rtRules .rt-rule")];
  for (let i = 0; i < rules.length; i++) {
    for (const inp of rules[i].querySelectorAll('.rt-f[data-field="modality"], .rt-f[data-field="calling_aet"]')) {
      const long = inp.value.split(",").map((x) => x.trim()).filter((x) => x.length > 16)[0];
      if (long) return { tab: "routing", el: inp, msg: TF("Rule {n}: {value} is longer than 16 characters", { n: i + 1, value: long }) };
    }
  }
  return null;
}
/* HTML5 constraints (required ports, 1..65535, maxlength) on the Settings form. Not stepMismatch:
   step="1" is a spinner hint, and a hand-written 2.5 s poll interval is a value the engine accepts. */
function settingsProblem() {
  const broken = (v) => v.valueMissing || v.rangeUnderflow || v.rangeOverflow || v.tooLong || v.badInput || v.typeMismatch;
  const bad = [...document.querySelectorAll("#dlgSettings input, #dlgSettings select")]
    .find((el) => !el.disabled && broken(el.validity));
  return bad ? { tab: "settings", el: bad, msg: bad.validationMessage } : null;
}
function configProblem() {
  return rowProblem("destinations", "destBody", [[".d-name", "Name", false], [".d-host", "Host", true], [".d-port", "Port", true], [".d-aet", "AE title", true]])
    || (modsOpen() ? rowProblem("modalities", "modBody", [[".m-name", "Name", true], [".m-aet", "AE title", true], [".m-mod", "Modality", false]]) : null)
    || rulesProblem()
    || settingsProblem();
}

/* Dotted engine key (C12 `field`) -> the input that holds it. Keys not listed still open the right
   tab from their first segment. */
const FIELD_INPUT = {
  "scp.aet": "scpAet", "scp.bind": "scpBind", "scp.port": "scpPort", "scp.storage_dir": "scpDir",
  "scp.min_free_gb": "scpMinFree", "scp.allowed_aets": "scpAllowed", "scp.tls": "scpTls",
  "scp.tls_cert": "scpTlsCert", "scp.tls_key": "scpTlsKey", "scp.tls_ca": "scpTlsCa",
  "scu.aet": "scuAet", "scu.watch_dir": "scuDir", "scu.poll_interval": "scuPoll", "scu.on_success": "scuMode",
  "scu.sent_dir": "scuSent", "scu.tls_ca": "scuTlsCa", "scu.tls_cert": "scuTlsCert", "scu.tls_key": "scuTlsKey",
  "print.aet": "prnAet", "print.bind": "prnBind", "print.port": "prnPort", "print.layout": "prnLayout",
  "print.allowed_aets": "prnAllowed", "print.tls": "prnTls", "print.tls_cert": "prnTlsCert",
  "print.tls_key": "prnTlsKey", "print.tls_ca": "prnTlsCa",
  "mwl.aet": "mwlAet", "mwl.bind": "mwlBind", "mwl.port": "mwlPort", "mwl.allowed_aets": "mwlAllowed",
  "mwl.tls": "mwlTls", "mwl.tls_cert": "mwlTlsCert", "mwl.tls_key": "mwlTlsKey", "mwl.tls_ca": "mwlTlsCa",
  "ris.bind": "risBind", "ris.port": "risPort", "ris.store_dir": "risDir", "ris.allowed_hosts": "risHosts", "ris.modalities": "risModPicker",
  "qr.aet": "qrAetIn", "qr.bind": "qrBind", "qr.port": "qrPort", "qr.allowed_aets": "qrAllowed",
  "qr.tls": "qrTlsIn", "qr.tls_cert": "qrTlsCert", "qr.tls_key": "qrTlsKey", "qr.tls_ca": "qrTlsCa",
  "emergency.probe_interval_sec": "emgProbe", "emergency.offline_threshold_sec": "emgThreshold",
  "emergency.recovery_successes": "emgRecovery",
  "worklist_source.host": "wsHost", "worklist_source.port": "wsPort", "worklist_source.aet": "wsAet",
  "dicomweb.cors_origins": "dwCors", "index.path": "idxPath", "deid.prefix": "deidPrefix",
  "deid.profile": "deidProfile", "web.editor_url": "webEditorUrl", "web.update_check": "webUpdateCheck",
};
const FIELD_TAB = { destinations: "destinations", routing: "routing", modalities: "modalities" };
function problemForField(field, msg) {
  const head = String(field).split(".")[0];
  const tab = FIELD_TAB[head] || "settings";
  let el = FIELD_INPUT[field] ? $(FIELD_INPUT[field]) : null;
  // "destinations.2.port" / "modalities.0.aet": the nth row's matching input.
  const m = /^(destinations|modalities)\.(\d+)\.(\w+)$/.exec(field);
  if (m) {
    const tr = $(m[1] === "destinations" ? "destBody" : "modBody").querySelectorAll("tr")[+m[2]];
    const cls = { name: "name", host: "host", port: "port", aet: "aet", modality: "mod", station_name: "station" }[m[3]];
    if (tr && cls) el = tr.querySelector("." + (m[1] === "destinations" ? "d-" : "m-") + cls);
  }
  return { tab, el, msg };
}

// Show a problem where it is: its tab, its group opened, the input outlined, the reason under it.
function showFieldProblem(p) {
  clearFieldProblems();
  goTo("dlgConfig", p.tab);
  if (!p.el) { flashNote(p.msg, false); return; }
  const group = p.el.closest("details");
  if (group) group.open = true;
  const tlsBox = p.el.closest(".tls-fields");
  if (tlsBox) tlsBox.hidden = false;
  p.el.classList.add("field-bad");
  const err = document.createElement("p");
  err.className = "field-err";
  err.setAttribute("role", "alert");
  err.textContent = p.msg;
  const host = p.el.closest("label") || p.el.closest("td") || p.el.parentNode;
  host.appendChild(err);
  p.el.scrollIntoView({ block: "center" });
  p.el.focus({ preventScroll: true });
  // Cleared as soon as the operator edits it.
  p.el.addEventListener("input", clearFieldProblems, { once: true });
}
function clearFieldProblems() {
  document.querySelectorAll(".field-err").forEach((e) => e.remove());
  document.querySelectorAll(".field-bad").forEach((e) => e.classList.remove("field-bad"));
}

// The 409 banner: persistent, because the edits on screen were not saved.
function showStale(on) {
  const b = $("cfgStale");
  if (b) b.hidden = !on;
}
