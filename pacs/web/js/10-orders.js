/* RIS orders: list, Open/Closed tabs, order form submit, capture and reconciliation actions. */
"use strict";
  // ---- RIS orders (emergency RIS: intake + reconciliation) ----
  let orderStatus = "open";
  // Poll and clicks can race: each load carries its tab + sequence; superseded answers are dropped.
  let ordersReq = 0;

  // Depends on the CLOSED count, which moves whenever a study arrives, so the status poll calls it too.
  function paintOrdPurge(closed) {
    const btn = $("ordPurge");
    if (!btn) return;
    btn.hidden = orderStatus !== "closed" || !closed;
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
    // Only show "Loading…" on an empty list; blanking a populated one would flicker.
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
      const captureBtn = row.querySelector(".order-capture");
      const cancelBtn = row.querySelector(".order-cancel");
      if (o.status === "closed") {
        captureBtn.hidden = true;
        cancelBtn.hidden = true;
      } else {
        captureBtn.addEventListener("click", () => captureForOrder(o, captureBtn));
        // Only the RIS may cancel a RIS order (the server refuses it too), so no button.
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
        const test = $("ordTest");
        if (test && test.checked) { test.checked = false; applyTestDefaults(false); }
        ["ordAcc", "ordPatient", "ordPid", "ordDob", "ordSex", "ordMod", "ordStation", "ordDesc", "ordWhen", "ordRef"].forEach((id) => { $(id).value = ""; });
        // Station is not sticky: an inherited one would send the next order to the previous room.
        const sel = $("ordStationSel");
        if (sel) sel.value = "";
        // Back to Open via the tab helper so ARIA state follows.
        selectOrderTab("open");
        pollStatus();
      }
    } catch (e) {
      // Known engine refusals are localised (red, sticky); anything else keeps the engine's English.
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

  // Use-case-B bridge: attach an exported PDF/image to this order; the server wraps it as DICOM
  // (order identity + Study UID), queues it to outgoing, and closes the order.
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

