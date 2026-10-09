/* RIS orders: list, Open/Closed tabs, order form submit, capture and reconciliation actions. */
"use strict";
// ---- RIS orders (emergency RIS: intake + reconciliation) ----
let orderStatus = "open";
// Poll and clicks can race: each load carries its tab + sequence; superseded answers are dropped.
let ordersReq = 0;
let ordersCache = [];          // the loaded tab's orders, so the search box filters without a fetch
let editingOrder = null;       // the manual order the form is editing, or null for a new one

// Depends on the CLOSED count, which moves whenever a study arrives, so the status poll calls it too.
function paintOrdPurge(closed) {
  const btn = $("ordPurge");
  if (!btn) return;
  btn.hidden = orderStatus !== "closed" || !closed || !capAllowed(btn);
}

/* Tablist: aria-selected and the roving tabindex must move with the class (screen readers read the
   former; the latter makes the other tab reachable). Every tab change goes through here. */
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
  // The form is static markup outside the nav sweep, so it follows its data-cap here.
  const form = $("orderNew");
  if (form) form.hidden = !capAllowed(form);
  // Only show "Loading…" on an empty list; blanking a populated one would flicker.
  if (!list.querySelector(".order-row")) listLoading(list);
  try {
    const data = await api("/api/ris/orders?status=" + want);
    if (req !== ordersReq || want !== orderStatus) return;   // a newer load owns the list
    ordersCache = data.orders || [];
    const c = data.counts || {};
    setTabCount("tab_ordOpen", c.open, true);
    setTabCount("tab_ordClosed", c.closed, true);
    renderOrders();
    paintOrdPurge(c.closed);
  } catch (e) {
    if (req !== ordersReq || want !== orderStatus) return;
    listError(list, failText(e));
  }
}

// HL7 sends "S" (OBR-27.6 / ORC-7); a typed or ISO-style "STAT" means the same.
const isStat = (o) => /^(S|STAT)$/i.test(String((o && o.priority) || "").trim());
const whenMs = (raw) => { const p = parseWhen(raw); return p && !isNaN(p.date.getTime()) ? p.date.getTime() : Infinity; };

function orderMatches(o, q) {
  if (!q) return true;
  return [o.accession, o.patient, o.patient_name, o.patient_id, o.study_desc, o.referring, o.station_aet, o.modality]
    .some((v) => String(v || "").toLowerCase().indexOf(q) >= 0);
}

function renderOrders() {
  const list = $("ordersList");
  const q = (($("ordFilter") || {}).value || "").trim().toLowerCase();
  let orders = ordersCache.filter((o) => orderMatches(o, q));
  // Open orders are a work queue: STAT first, then by when the exam is due. Closed keep the engine's order.
  if (orderStatus === "open") {
    orders = orders.slice().sort((a, b) =>
      (isStat(b) - isStat(a)) || (whenMs(a.scheduled_dt) - whenMs(b.scheduled_dt)));
  }
  list.innerHTML = "";
  if (!ordersCache.length) {
    list.appendChild(emptyNote(orderStatus === "open"
      ? T("No open orders. Send an ORM over HL7/MLLP or add one above.")
      : T("No closed orders yet.")));
    return;
  }
  if (!orders.length) { list.appendChild(emptyNote(T("Nothing matches the filter."))); return; }
  orders.forEach((o) => {
    const row = I18N_IN($("orderRowTpl").content.cloneNode(true)).querySelector(".order-row");
    const acc = row.querySelector(".order-acc");
    acc.textContent = o.accession ? TF("ACC {acc}", { acc: o.accession }) : T("no accession");
    if (!o.accession) acc.classList.add("order-noacc");
    row.querySelector(".order-patient").textContent = o.patient || o.patient_name || T("(no patient)");
    row.querySelector(".order-stat").hidden = !isStat(o);
    row.querySelector(".hist-meta").textContent = [
      o.patient_id ? TF("ID {id}", { id: o.patient_id }) : "",
      o.patient_birthdate ? TF("DOB {d}", { d: fmtDate(o.patient_birthdate) }) : "",
      o.patient_sex ? TF("Sex {s}", { s: o.patient_sex }) : "",
      o.modality || "",
      o.station_aet ? "→ " + o.station_aet : "",
      o.study_desc || T("(no study description)"),
      o.scheduled_dt ? "@ " + fmtWhen(o.scheduled_dt) : "",
    ].filter(Boolean).join("  ·  ");
    // Origin decides what may be done to the order, so it is tagged on the row.
    const originTag = row.querySelector(".order-origin");
    // The span ships hidden (no empty pill); both branches must un-hide it.
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
      // Four distinct endings: study arrived, film captured, RIS withdrew, withdrawn here.
      bits.push(
        o.close_reason === "matched" ? TF("✓ matched {ts}", { ts: fmtStamp(o.closed) })
        : o.close_reason === "captured" ? TF("✓ captured {ts}", { ts: fmtStamp(o.closed) })
        : o.close_reason === "cancelled-by-ris" ? TF("cancelled by the RIS {ts}", { ts: fmtStamp(o.closed) })
        : TF("cancelled here {ts}", { ts: fmtStamp(o.closed) }));
    }
    if (o.referring) bits.push(TF("ref: {who}", { who: o.referring }));
    sub.textContent = bits.join("  ·  ");
    // Gated first; the status rules below only ever hide more.
    capGate(row);
    const who = whoOf(o);
    const captureBtn = row.querySelector(".order-capture");
    const cancelBtn = row.querySelector(".order-cancel");
    const editBtn = row.querySelector(".order-edit");
    const delBtn = row.querySelector(".order-del");
    if (o.status === "closed") {
      captureBtn.hidden = true;
      cancelBtn.hidden = true;
      editBtn.hidden = true;
    } else {
      captureBtn.addEventListener("click", () => captureForOrder(o, captureBtn));
      // The RIS owns its orders: only it may cancel or edit one (the server refuses a cancel too),
      // and an open one is not deleted here either — the RIS would still think it is scheduled.
      if (o.origin === "ris") {
        cancelBtn.hidden = true;
        editBtn.hidden = true;
        delBtn.hidden = true;
      } else {
        cancelBtn.addEventListener("click", () => orderAction("cancel", o, T("Cancel this order? It moves to Closed.")));
        editBtn.addEventListener("click", () => editOrder(o));
      }
    }
    delBtn.addEventListener("click", () =>
      orderAction("delete", o, o.status === "closed"
        ? T("Delete this order permanently? It is removed from the Closed list.")
        : T("Delete this order permanently? It is removed from this list and from the worklist.")));
    [captureBtn, cancelBtn, editBtn, delBtn].forEach((b) => ariaWho(b, who));
    list.appendChild(row);
  });
}

// queued/closed stamps are UTC ("…Z"); fmtWhen shows them in local time.
const fmtStamp = (iso) => (iso ? fmtWhen(iso) : "");

/* Queued-order outcome, localised here from the engine's code (see ORDER_QUEUED_MESSAGES):
   it is often the only warning that an order reaches no scanner. Unknown codes fall back to
   the engine's English, then a neutral confirmation. */
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
    // Worklist is serving, but no registered console has this AE title (API clients, or the
    // free-text fallback on an appliance without a station registry).
    case "order_queued_station_unknown":
      return T("Order queued, but no station registered here answers to that AE title, so a console that filters by station will not see it. Pick the room from the list, or leave the target blank to show the order on every worklist.");
    case "test_order_queued_station_unknown":
      return T("Test order queued, but no station registered here answers to that AE title, so a console that filters by station will not see it. Pick the room from the list, or leave the target blank to show the order on every worklist.");
    default:
      return (r && r.message) || T("Order queued");
  }
}

// Codes meaning the order reaches nobody (red, sticky). Enumerated, not pattern-matched:
// an unknown code is never assumed to be bad news.
const ORDER_UNREACHED = new Set([
  "order_queued_mwl_stopped", "test_order_queued_mwl_stopped",
  "order_queued_mwl_failed", "test_order_queued_mwl_failed",
  "order_queued_no_mwl", "test_order_queued_no_mwl",
  // Narrower (consoles sending no station key still see it), but the target room misses it.
  "order_queued_station_unknown", "test_order_queued_station_unknown",
]);

/* Engine said "serving", but no registered room asks for this modality code (e.g. CR order,
   only a DX room). "" = no gap (blank field, or a room matches) OR cannot tell (registry
   unknown: configuredModalityCodes() is empty). Only a real gap returns a sentence. */
function modalityReachGap(code) {
  const want = String(code || "").trim().toUpperCase();
  const here = configuredModalityCodes();
  if (!want || !here.size || here.has(want)) return "";
  return TF("Order queued, but no modality registered here answers to {code}, so a console that filters by modality will not see it. Pick the code the room is registered as, or hand the details to the tech.", { code: want });
}

// Localised refusal for the two fields the form can write; other codes (e.g. a bad Study
// Instance UID) return "" so the engine's English is shown.
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

/* Client-side mirror of pacs/mwl.py _vr_value (the engine still enforces it): a refusal before the
   POST reads as a rule, not a fault. Empty is fine; else within the cap, no backslash (DICOM value
   delimiter) and no control chars (SH/LO). Length in code points, as Python counts. */
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
  // Refuse, never shorten (a shortened accession names a different order); keep the form as typed.
  const badId = unrepresentableOrderId(fields);
  if (badId) {
    flashNote(orderRefusedText(badId), false, { warn: true });
    const box = $(badId === "order_refused_accession" ? "ordAcc" : "ordPid");
    if (box) box.focus();
    return;
  }
  if (editingOrder) { await saveOrderEdit(btn, fields); return; }
  const old = btn.textContent; btn.disabled = true; btn.textContent = "…";
  try {
    const r = await post("/api/ris/orders", fields);
    // Unreached outcomes are red and sticky. Only an engine "serving" verdict is second-guessed
    // against the local registry; the other outcomes already name their reason.
    const gap = (r && (r.code === "order_queued_serving" || r.code === "test_order_queued_serving"))
      ? modalityReachGap(fields.modality) : "";
    const unreached = !!(gap || (r && ORDER_UNREACHED.has(r.code)));
    flashNote(gap || orderQueuedText(r), !unreached && r.ok !== false, { warn: unreached });
    if (r.ok !== false) {
      // Untick "Test order" FIRST: its fields are readOnly while on, and releasing the lock
      // restores pre-test values, so it must run before the clear below.
      clearOrderForm();
      // Back to Open via the tab helper so ARIA state follows.
      selectOrderTab("open");
      pollStatus();
    }
  } catch (e) {
    // Known engine refusals are localised (red, sticky); anything else keeps the engine's English.
    const said = orderRefusedText(e.code);
    flashNote(said || failText(e), false, { warn: !!said });
  } finally { btn.disabled = false; btn.textContent = old; }
}

function clearOrderForm() {
  // Untick "Test order" FIRST: its fields are readOnly while on, and releasing the lock
  // restores pre-test values, so it must run before the clear below.
  const test = $("ordTest");
  if (test && test.checked) { test.checked = false; applyTestDefaults(false); }
  ["ordAcc", "ordPatient", "ordPid", "ordDob", "ordSex", "ordMod", "ordStation", "ordDesc", "ordWhen", "ordRef"].forEach((id) => { $(id).value = ""; });
  // Station is not sticky: an inherited one would send the next order to the previous room.
  const sel = $("ordStationSel");
  if (sel) sel.value = "";
}

// "YYYY-MM-DDTHH:MM" for <input type=datetime-local>, from whatever the order carries.
function localInputValue(raw) {
  const p = parseWhen(raw);
  if (!p || isNaN(p.date.getTime())) return "";
  const d = p.date, pad = (n) => String(n).padStart(2, "0");
  return isoDay(d) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

/* Edit a manual open order in the same form (POST /api/ris/orders/update overwrites every field it
   is given, so the whole form is sent). The Test tick is locked while editing: it fills fields. */
function editOrder(o) {
  const form = $("orderNew");
  clearOrderForm();
  editingOrder = o;
  const set = (id, v) => { const el = $(id); if (el) el.value = v || ""; };
  set("ordAcc", o.accession);
  set("ordPatient", o.patient || o.patient_name);
  set("ordPid", o.patient_id);
  set("ordDob", fmtDate(o.patient_birthdate));
  set("ordSex", o.patient_sex);
  const mod = $("ordMod");
  if (mod && o.modality && ![...mod.options].some((x) => x.value === o.modality)) {
    const extra = document.createElement("option");
    extra.value = extra.textContent = o.modality;
    mod.appendChild(extra);
  }
  set("ordMod", o.modality);
  const sel = $("ordStationSel");
  if (sel && !sel.hidden) {
    // Posting the dropdown's "" for an AE it does not list would retarget the order at every worklist.
    addStationOption(sel, o.station_aet);
    sel.value = o.station_aet || "";
  } else set("ordStation", o.station_aet);
  set("ordDesc", o.study_desc);
  set("ordWhen", localInputValue(o.scheduled_dt));
  set("ordRef", o.referring);
  $("ordTest").disabled = true;
  $("ordAdd").textContent = T("Save changes");
  $("ordEditCancel").hidden = false;
  $("ordEditing").textContent = TF("Editing the order for {who}", { who: whoOf(o) });
  $("ordEditing").hidden = false;
  if (form) { form.open = true; form.scrollIntoView({ block: "nearest" }); }
  $("ordAcc").focus();
}

function endOrderEdit() {
  editingOrder = null;
  clearOrderForm();
  $("ordTest").disabled = false;
  $("ordAdd").textContent = T("Queue order");
  $("ordEditCancel").hidden = true;
  $("ordEditing").hidden = true;
}

async function saveOrderEdit(btn, fields) {
  const o = editingOrder;
  const body = Object.assign({ id: o.id }, fields);
  delete body.test;
  btn.disabled = true;
  try {
    const r = await studyPost("/api/ris/orders/update", body);
    flashNote(T("Order updated"), r.ok !== false);
    endOrderEdit();
    loadOrders();
    pollStatus();
  } catch (e) {
    const said = orderRefusedText(e.code);
    flashNote(said || failText(e), false, { warn: !!said });
  } finally { btn.disabled = false; }
}

async function orderAction(action, o, confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg + "\n\n" + (o.patient || T("(no patient)")) +
      (o.accession ? "  ·  " + TF("ACC {acc}", { acc: o.accession }) : ""))) return;
  try {
    const r = await studyPost("/api/ris/orders/" + action, { id: o.id });
    flashNote(r.message || T("Done"), r.ok !== false);
    if (editingOrder && editingOrder.id === o.id) endOrderEdit();
    loadOrders();
    pollStatus();
  } catch (e) { flashNote(failText(e), false); }
}

// Use-case-B bridge: attach an exported PDF/image to this order; the server wraps it as DICOM
// (order identity + Study UID), queues it to outgoing, and closes the order. Confirmed first:
// there is no reopen.
function captureForOrder(o, btn) {
  pickDocument(async (f) => {
    if (!confirm(TF("Add “{file}” to the order for {who}? It is sent as a new study and the order is closed.",
                    { file: f.name, who: whoOf(o) }))) return;
    const fd = new FormData();
    fd.append("id", o.id);
    fd.append("file", f);
    const old = btn.textContent; btn.disabled = true; btn.textContent = "…";
    try {
      const body = await studyForm("/api/ris/orders/capture", fd);
      flashNote(body.message || T("Study created"), body.ok !== false);
      loadOrders(); pollStatus();
    } catch (e) {
      flashNote(failText(e) || T("Capture failed"), false);
    } finally { btn.disabled = false; btn.textContent = old; }
  });
}

async function purgeClosedOrders() {
  if (!confirm(T("Delete ALL closed orders?\n\nThis permanently empties the Closed list."))) return;
  try {
    const r = await studyPost("/api/ris/orders/purge", {});
    flashNote(r.message || T("Purged"), r.ok !== false);
    loadOrders();
    pollStatus();
  } catch (e) { flashNote(failText(e), false); }
}

// Static controls only this file uses (scripts run after the markup).
(function wireOrdersPanel() {
  const filter = $("ordFilter");
  if (filter) filter.addEventListener("input", renderOrders);
  const cancel = $("ordEditCancel");
  if (cancel) cancel.addEventListener("click", endOrderEdit);
})();

