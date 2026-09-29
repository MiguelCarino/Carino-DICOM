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

    // Capabilities: hidden for admins, who hold everything by definition.
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

    // Password button reflects its state: none / set / change or remove.
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
      // Server refusals (last admin, open write profile on a network bind) say what to do; show as-is.
      flashNote(e.message, false);
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Audit trail ----
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

