/* Conditional routing: rules editor (saved via POST /api/config) and the dry-run test. */
"use strict";
// ---- Conditional routing ----
// A rule naming a renamed/disabled/deleted destination keeps it ticked and flagged:
// dropping it would silently narrow routing on the next Save. Unknown keys are spread back untouched.
const MATCH_FIELDS = ["modality", "calling_aet", "station", "patient_id", "study_desc"];
// Aliases the engine also accepts (routing._ALIASES), normalised so a condition is never posted twice.
const MATCH_ALIASES = {
  source_aet: "calling_aet", calling_ae: "calling_aet",
  station_name: "station", study_description: "study_desc",
};

// Enabled rows of the destination table as currently on screen, not a load-time copy.
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
    // The engine skips a rule with an unknown match key (never "matches anything").
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

// Re-offer the current node list without disturbing what each rule has ticked.
function refreshRuleDests() {
  const box = $("rtRules");
  if (!box) return;
  [...box.querySelectorAll(".rt-rule")].forEach((node) => {
    const picked = [...node.querySelectorAll(".rt-dests input:checked")].map((c) => c.value);
    fillRuleDests(node, picked);
  });
  // Fresh checkboxes are born enabled; a read-only view (no config.read) must stay read-only.
  if (configReadOnly) setConfigReadOnly(true);
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
      // Comma-separated = any of these globs; a single value stays a string so hand-written config round-trips.
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
  // Unfiltered on purpose: the engine refuses a nameless rule by number rather than it vanishing here.
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
    // The rules as they are on screen (C7), so a draft can be tried before it is saved.
    renderRouteResult(await post("/api/routing/test", { attributes: attrs, rules: collectRules(), routing_enabled: $("rtEnabled").checked }));
  } catch (e) {
    flashNote(e.message, false);
  } finally { btn.disabled = false; }
}

/* The dry run is answered in pacs/web.py by a bare Router, which cannot see the
   "no de-identifier can be built" hold. Apply the engine's settled hold_cause from the
   status poll (server.py _settled_deid) so a held node is not drawn as "de-identified for". */
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
  // `sendable`, not `destinations`: a held destination is in the decision but not dialled.
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
    // Name the real cause, as the de-identification panel does; blaming a profile that is on misleads.
    hz.textContent = d.hold_cause === "no-deidentifier"
      ? TF("HELD — not sent to {dests}: a rule asks for de-identification, the profile is on, and no de-identifier can be built from these settings, so nothing can be scrubbed.", { dests: held.join(", ") })
      : d.hold_cause === "profile-off"
        ? TF("HELD — not sent to {dests}: a rule asks for de-identification and the profile is off, so nothing can be scrubbed.", { dests: held.join(", ") })
        : TF("HELD — not sent to {dests}: a rule asks for de-identification and nothing can be scrubbed.", { dests: held.join(", ") });
    box.appendChild(hz);
  }
  const why = document.createElement("p");
  why.className = "rt-reason";
  // Engine wording (same string as the log), so it stays in the server's language.
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
    // Check the decision's held set, not row.held: the engine's row copy misses the
    // no-de-identifier hold applied by settledRoute().
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
      // Add only the hold the engine's action text could not know about.
      + (blocked.length && !(row.held || []).length
        ? " — " + TF("HELD, not sent to {dests}", { dests: blocked.join(", ") }) : "");
    // Each field with the study's value and the patterns it was tested against.
    el.querySelector(".rt-trace-why").textContent = (row.fields || []).map((f) =>
      f.field + "=" + (f.value || T("(empty)")) + " " + (f.matched ? "✓" : "✗") + " " + (f.patterns || []).join(" | ")
    ).join("   ·   ");
    box.appendChild(el);
  });
}
