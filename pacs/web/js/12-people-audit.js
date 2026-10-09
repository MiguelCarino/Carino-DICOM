/* People (profile editor) and the audit trail. */
"use strict";
// ---- People ----
// Admin profile editor; the capability list comes from the engine, not hard-coded here.
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
  renderPeopleCount();

  const list = $("peopleList");
  if (!list) return;
  list.textContent = "";
  (peopleState.profiles || []).forEach((p) => list.appendChild(personCard(p)));
}

function renderPeopleCount() {
  const count = $("peopleCount");
  if (count) {
    const rows = peopleState.profiles || [];
    const open = rows.filter((p) => !p.locked && p.enabled).length;
    count.textContent = open
      ? TF("{n} profiles. {open} of them have no password.", { n: rows.length, open })
      : TF("{n} profiles.", { n: rows.length });
    count.classList.toggle("warn", open > 0);
  }
}

// Name + role header row and the email row; returns both rows plus the three inputs for the save body.
function personIdentityFields(p) {
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

  const meta = document.createElement("div");
  meta.className = "person-meta";
  const email = document.createElement("input");
  email.type = "email";
  email.value = p.email || "";
  email.placeholder = T("email for emergency alerts");
  meta.appendChild(email);
  return { head, meta, name, role, email };
}

/* The engine names each capability and identifier in English (users.py); these are the same words,
   so the dashboard can say them in the operator's language. Kept equal to users.py by
   tests/test_dashboard_globals.py; a name missing here falls back to the engine's own text. */
const PERSON_TEXT = {
  "studies.read": "See stored studies and the receive history",
  "studies.send": "Forward a stored study to a destination",
  "studies.delete": "Delete stored studies",
  "orders.read": "See emergency RIS orders",
  "orders.write": "Create, edit, close and cancel orders",
  "routing.read": "See the routing rules",
  "routing.write": "Edit the routing rules",
  "destinations.write": "Add, edit and remove destinations",
  "services.control": "Start and stop the receiver, printer, worklist and Q/R",
  "devpeer.manage": "Create and discard the disposable test archive",
  "emergency.activate": "Activate or stand down emergency failover",
  "logs.read": "Read the operational log",
  "audit.read": "Read and export the audit trail",
  "config.read": "See the configuration document",
  "config.write": "Change the configuration",
  "system.shutdown": "Shut the engine down from the dashboard",
  "auth.manage": "Create and edit profiles, and set what they may do",
  "deid.manage": "Change the de-identification profile and site key",
  "patient_name": "Patient name",
  "patient_id": "Patient ID",
  "patient_birthdate": "Date of birth",
  "patient_sex": "Sex",
  "accession": "Accession number",
  "study_desc": "Study description",
  "referring": "Referring physician",
};

/* Capabilities by area, so the ~18 boxes read as a few decisions instead of the engine's key order.
   Keyed by the capability's prefix; anything new lands under "Other" rather than disappearing. */
const CAP_AREAS = [
  ["Studies", ["studies"]],
  ["Orders", ["orders"]],
  ["Routing and destinations", ["routing", "destinations"]],
  ["Services", ["services", "devpeer", "emergency", "system"]],
  ["Activity", ["logs", "audit"]],
  ["Configuration", ["config"]],
  ["Security", ["auth", "deid"]],
];
function capArea(name) {
  const head = String(name).split(".")[0];
  const hit = CAP_AREAS.find(([, heads]) => heads.indexOf(head) >= 0);
  return hit ? hit[0] : "Other";
}

// One checkbox per engine-provided item ({name, description}), ticked when its name is in `granted`.
// `grouped` sorts capabilities under their area headings; PHI fields stay one flat list.
function personCheckboxGroup(items, granted, grouped) {
  const el = document.createElement("div");
  el.className = "person-caps";
  const boxes = {};
  const add = (parent, it) => {
    const box = chk(T(PERSON_TEXT[it.name] || it.description), (granted || []).indexOf(it.name) >= 0);
    box.label.title = it.name;
    boxes[it.name] = box.input;
    parent.appendChild(box.label);
  };
  if (!grouped) {
    (items || []).forEach((it) => add(el, it));
    return { el, boxes };
  }
  el.className = "person-capgroups";
  CAP_AREAS.map(([area]) => area).concat(["Other"]).forEach((area) => {
    const mine = (items || []).filter((it) => capArea(it.name) === area);
    if (!mine.length) return;
    const g = document.createElement("div");
    g.className = "cap-group";
    const h = document.createElement("h5");
    h.textContent = T(area);
    const list = document.createElement("div");
    list.className = "person-caps";
    mine.forEach((it) => add(list, it));
    g.append(h, list);
    el.appendChild(g);
  });
  return { el, boxes };
}

// Password button reflects its state: none / set / change or remove.
function personPasswordRow(p) {
  const pw = { row: document.createElement("div"), input: null, clear: false };
  pw.row.className = "person-pw";
  const pwState = document.createElement("span");
  pwState.className = "pw-state";
  pwState.textContent = p.locked ? T("Password set") : T("No password — anyone can pick this profile");
  pwState.classList.toggle("warn", !p.locked);
  pw.row.appendChild(pwState);
  pw.input = document.createElement("input");
  pw.input.type = "password";
  pw.input.autocomplete = "new-password";
  pw.input.placeholder = p.locked ? T("new password") : T("set a password");
  pw.row.appendChild(pw.input);
  if (p.locked) {
    const rm = document.createElement("button");
    rm.className = "btn ghost tiny";
    rm.textContent = T("Remove password");
    rm.addEventListener("click", () => {
      pw.clear = true;
      pwState.textContent = T("Password will be removed when you save");
      pwState.classList.add("warn");
    });
    pw.row.appendChild(rm);
  }
  return pw;
}

/* Save gathers the form through `collectBody` at click time and redraws only its own card, so edits
   pending on the other cards survive. Delete confirms; a profile never saved is only on this screen,
   so it is removed here without asking the engine. */
function personActionsRow(p, collectBody, card) {
  const actions = document.createElement("div");
  actions.className = "person-actions";
  const save = document.createElement("button");
  save.className = "btn tiny";
  save.textContent = T("Save");
  save.addEventListener("click", async () => {
    await savePerson(save, collectBody(), card, p);
  });
  actions.appendChild(save);

  const del = document.createElement("button");
  del.className = "btn ghost tiny danger";
  del.textContent = T("Delete");
  del.addEventListener("click", async () => {
    if (!p.id) {
      peopleState.profiles = (peopleState.profiles || []).filter((x) => x !== p);
      card.remove();
      renderPeopleCount();
      return;
    }
    if (!window.confirm(TF("Delete {name}? Their entries in the audit trail stay — the trail is append-only and names them by id, so past actions keep resolving to this person.", { name: p.name }))) return;
    try {
      const r = await post("/api/profiles/delete", { id: p.id });
      // Keep any unsaved new cards: the engine's list does not have them.
      const drafts = (peopleState.profiles || []).filter((x) => !x.id);
      peopleState = Object.assign({}, peopleState, r);
      peopleState.profiles = (peopleState.profiles || []).concat(drafts);
      card.remove();
      renderPeopleCount();
      adoptOwnUsersWrite();
      flashNote(TF("{name} removed.", { name: p.name }), true);
    } catch (e) { flashNote(e.message, false); }
  });
  actions.appendChild(del);
  return actions;
}

function personCard(p) {
  const card = document.createElement("div");
  card.className = "person-card" + (p.enabled ? "" : " off");

  const ident = personIdentityFields(p);
  card.appendChild(ident.head);
  card.appendChild(ident.meta);

  const flags = document.createElement("div");
  flags.className = "person-flags";
  const enabled = chk(T("Enabled"), p.enabled);
  const admin = chk(T("Administrator (everything, including future permissions)"), p.admin);
  flags.appendChild(enabled.label);
  flags.appendChild(admin.label);
  card.appendChild(flags);

  // Capabilities: hidden for admins, who hold everything by definition.
  const caps = personCheckboxGroup(peopleState.capabilities, p.capabilities, true);
  const capsWrap = section(T("Can do"), caps.el);
  card.appendChild(capsWrap);

  const phi = personCheckboxGroup(peopleState.phi_fields, p.phi_visible);
  const phiWrap = section(T("Can see"), phi.el);
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

  const pw = personPasswordRow(p);
  card.appendChild(pw.row);

  card.appendChild(personActionsRow(p, () => {
    const body = {
      id: p.id,
      name: ident.name.value.trim(),
      role: ident.role.value.trim(),
      email: ident.email.value.trim(),
      enabled: enabled.input.checked,
      admin: admin.input.checked,
      capabilities: Object.keys(caps.boxes).filter((k) => caps.boxes[k].checked),
      phi_visible: Object.keys(phi.boxes).filter((k) => phi.boxes[k].checked),
    };
    if (pw.input.value) body.password = { action: "set", value: pw.input.value };
    else if (pw.clear) body.password = { action: "clear" };
    return body;
  }, card));
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

// Profiles live in the config document, so each write here moves its version tag. Adopt it when
// nothing but `users` changed, or the next Settings Save is refused as "someone else saved".
function adoptOwnUsersWrite() {
  refreshEtagAfterOwnWrite((doc, old) => { doc.users = old.users; });
}

async function savePerson(btn, body, card, draft) {
  btn.disabled = true;
  try {
    const r = await post("/api/profiles/save", body);
    // The saved profile as the engine now has it: by id, or for a new one, the id it was just given.
    const before = new Set((peopleState.profiles || []).map((x) => x.id).filter(Boolean));
    const rows = (r && r.profiles) || [];
    const saved = rows.find((x) => body.id ? x.id === body.id : !before.has(x.id)) || null;
    const drafts = (peopleState.profiles || []).filter((x) => !x.id && x !== draft);
    peopleState = Object.assign({}, peopleState, r);
    peopleState.profiles = (peopleState.profiles || []).concat(drafts);
    if (saved && card && card.parentNode) card.replaceWith(personCard(saved));
    else renderPeople();
    renderPeopleCount();
    adoptOwnUsersWrite();
    flashNote(T("Saved."), true);
  } catch (e) {
    // Server refusals (last admin, open write profile on a network bind) say what to do; show as-is.
    flashNote(e.message, false);
  } finally {
    btn.disabled = false;
  }
}

// ---- Audit trail ----
// Readable names for the engine's action codes; an unknown code is shown as it is (its title keeps it).
const AUDIT_ACTIONS = {
  "login": "Signed in", "login.failed": "Sign-in failed", "logout": "Signed out",
  "config.changed": "Changed the configuration", "profile.created": "Created a profile",
  "profile.changed": "Changed a profile", "profile.deleted": "Deleted a profile",
  "password.changed": "Changed a password", "token.rotated": "Changed the access token",
  "deid.changed": "Changed de-identification", "study.sent": "Sent a study",
  "study.deleted": "Deleted a study", "study.read": "Opened a study", "order.changed": "Changed an order",
  "service.changed": "Started or stopped a service", "devpeer.changed": "Changed the dev peer",
  "worklist.probed": "Tested a worklist", "emergency.changed": "Changed emergency failover",
  "shutdown": "Shut the engine down", "denied": "Refused",
  // Endpoints with no named action are recorded as "api." + their path.
  "api.index.rescan": "Rescanned the index", "api.notify.secret": "Changed the notification secret",
  "api.ris.orders.capture": "Captured a study for an order", "api.selftest": "Ran a service test",
  "api.studies.attach": "Attached a file to a study", "api.studies.reveal": "Opened a study's folder",
  "api.worklist.caught.clear": "Cleared the worklist probes",
};
const AUDIT_OUTCOMES = { ok: "Done", failed: "Failed", denied: "Refused" };
let auditRows = [];
const auditFilter = { who: "", act: "", bad: false };
// The integrity check's verdict, kept above the list (not a five-second toast).
let auditVerdict = null;

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
      // Must be loud: a trail that stopped recording looks like a quiet week.
      state.textContent = TF("The audit trail is NOT being written: {err}", { err: stats.broken });
      state.classList.add("bad");
    } else if (!stats.enabled) {
      state.textContent = T("The audit trail is switched off — nothing is being recorded about who does what.");
      state.classList.add("bad");
    } else {
      state.textContent = TF("{files} file(s), {kb} KB. Chain head {head}.",
        { files: stats.files || 0, kb: Math.round((stats.bytes || 0) / 1024), head: (stats.head || "").slice(0, 12) });
    }
    if (auditVerdict) {
      const v = document.createElement("span");
      v.className = auditVerdict.ok ? "verify-ok" : "verify-bad";
      v.textContent = " " + auditVerdict.text;
      state.appendChild(v);
    }
  }
  if (rows) auditRows = rows;
  fillAuditFilters();
  paintAuditList();
}

// Person and action choices come from the records loaded, so every option finds something.
function fillAuditFilters() {
  const fill = (id, values, label, current) => {
    const sel = $(id);
    if (!sel) return;
    sel.textContent = "";
    const all = document.createElement("option");
    all.value = ""; all.textContent = label;
    sel.appendChild(all);
    values.forEach(([v, text]) => { const o = document.createElement("option"); o.value = v; o.textContent = text; sel.appendChild(o); });
    sel.value = values.some(([v]) => v === current) ? current : "";
  };
  const people = [...new Set(auditRows.map((r) => (r.actor || {}).name || "").filter(Boolean))].sort();
  const acts = [...new Set(auditRows.map((r) => r.action || "").filter(Boolean))].sort();
  fill("auditWho", people.map((n) => [n, n]), T("Everyone"), auditFilter.who);
  fill("auditAct", acts.map((a) => [a, auditLabel(a)]), T("Every action"), auditFilter.act);
  const bad = $("auditBad");
  if (bad) bad.checked = auditFilter.bad;
  auditFilter.who = ($("auditWho") || {}).value || "";
  auditFilter.act = ($("auditAct") || {}).value || "";
}
function auditLabel(code) { return AUDIT_ACTIONS[code] ? T(AUDIT_ACTIONS[code]) : code; }

function paintAuditList() {
  const list = $("auditList");
  if (!list) return;
  list.textContent = "";
  const rows = auditRows.filter((r) =>
    (!auditFilter.who || (r.actor || {}).name === auditFilter.who)
    && (!auditFilter.act || r.action === auditFilter.act)
    && (!auditFilter.bad || r.outcome !== "ok"));
  if (!rows.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = auditRows.length ? T("No record matches these filters.") : T("Nothing recorded yet.");
    list.appendChild(p);
    return;
  }
  rows.forEach((r) => {
    const row = document.createElement("div");
    row.className = "audit-row " + (r.outcome === "ok" ? "ok" : (r.outcome === "denied" ? "denied" : "failed"));
    const ts = cell("audit-ts", fmtLogTs(r.epoch ? r.epoch * 1000 : Date.parse(r.ts || ""), r.ts));
    ts.title = r.ts || "";
    row.appendChild(ts);
    const actor = (r.actor || {});
    const engine = actor.role === "system";
    const who = cell("audit-who", engine ? T("The engine") : actor.service ? T("Access token") : (actor.name || "—"));
    if (actor.service) who.title = engine ? T("Something the engine did on its own, not a person.")
                                          : T("The shared access token, not a person.");
    row.appendChild(who);
    const act = cell("audit-act", auditLabel(r.action || ""));
    act.title = r.action || "";
    row.appendChild(act);
    // config.changed carries {sections, destinations_*, rules_*}: name the sections on the row itself.
    const secs = (r.detail && typeof r.detail === "object" && Array.isArray(r.detail.sections)) ? r.detail.sections : [];
    const target = r.target === "api token" ? T("Access token") : (r.target || "");
    row.appendChild(cell("audit-target", target + (secs.length ? " · " + secs.join(", ") : "")));
    row.appendChild(cell("audit-out", AUDIT_OUTCOMES[r.outcome] ? T(AUDIT_OUTCOMES[r.outcome]) : (r.outcome || "")));
    // Everything else the record carries (detail: which sections changed, status, source…), folded.
    const extra = {};
    Object.keys(r).forEach((k) => {
      if (["ts", "epoch", "actor", "action", "target", "outcome", "prev", "hash", "seq"].indexOf(k) < 0) extra[k] = r[k];
    });
    if (Object.keys(extra).length) {
      const d = document.createElement("details");
      d.className = "audit-detail";
      const sm = document.createElement("summary");
      sm.textContent = r.detail ? T("What changed") : T("Details");
      const pre = document.createElement("pre");
      // `detail` is an object for config/stuck actions and a plain sentence for some others.
      pre.textContent = Object.keys(extra).length === 1 && typeof extra.detail === "string"
        ? extra.detail : JSON.stringify(extra, null, 2);
      d.append(sm, pre);
      row.appendChild(d);
    }
    list.appendChild(row);
  });
}

async function verifyAudit(btn) {
  btn.disabled = true;
  try {
    const r = await api("/api/audit/verify");
    const v = r.verify || {};
    auditVerdict = {
      ok: !!v.ok,
      text: v.ok
        ? TF("Intact — {n} records, every one matching its digest.", { n: v.records || 0 })
        : TF("BROKEN at record {n}: {why}", { n: v.broken_at || "?", why: v.reason || "" }),
    };
    renderAudit(null, r.audit || {});
    loadAudit();
  } catch (err) { flashNote(err.message, false); }
  finally { btn.disabled = false; }
}

function cell(cls, text) {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  return d;
}
