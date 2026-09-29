/* Studies: transaction history, dev peer, pending imports and the stuck list. */
"use strict";
  // ---- Transaction history ----
  let histGroup = "received";

  // Shared list placeholders (Loading… / load error), used by every panel.
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

  // Open a study in DICOM-editor via carino-bridge.js. An HTTPS editor cannot fetch our http API
  // (mixed content), so we fetch same-origin and hand the bytes over by postMessage.
  function histEdit(s) {
    if (!editorUrl) return;
    // Relative ("/editor/" = bundled same-origin editor) or absolute.
    let editorAbs;
    try { editorAbs = new URL(editorUrl, location.origin).href; }
    catch (e) { flashNote(T("Editor URL is not valid"), false); return; }
    if (!window.CarinoBridge) { flashNote(T("Bridge script missing — reload the page"), false); return; }
    const manifestUrl = "/api/studies/files?group=" + encodeURIComponent(histGroup) + "&path=" + encodeURIComponent(s.path);

    // Files are read only once the editor is listening, so a blocked or closed window costs nothing.
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

  // ---- Dev peer (disposable second archive) ----
  // Only with --dev-peer: otherwise the engine omits the dev_peer block and the nav row stays hidden.
  async function loadDevPeer() {
    try { renderDevPeer((await api("/api/dev-peer")).dev_peer || null); }
    catch (e) { $("dpState").textContent = e.message; }
  }

  function renderDevPeer(p) {
    const running = !!(p && p.running);
    setAtomic("dpAet", running ? p.aet : "");
    setAtomic("dpScpPort", running ? p.scp_port : "");
    setAtomic("dpQrPort", running ? p.qr_port : "");
    // Counts only: this block carries no patient data and must not grow a place for any.
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
      // Restore on success too, not only on error.
      if (btn) { btn.textContent = old; btn.disabled = false; }
    }
  }

  // ---- Pending imports (non-DICOM review queue) and stuck list ----
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

  /* GET /api/stuck returns three lists, rendered as separate sections:
       destinations  node configured but refusing/timing out; retries itself (Retry now skips the wait)
       orphaned      routed to a name no longer enabled; nothing retries; engine `message` shown verbatim
       held          rule asks to de-identify and nothing can be scrubbed; no timer releases it
     Only destinations get Retry. Any new list in the response must be rendered here too
     (stuck-panel.e2e.mjs checks). The summary uses attention_files, which counts each file once. */
  function renderStuck(data) {
    const d = data || {};
    const dests = d.destinations || [];
    const orphans = d.orphaned || [];
    const holds = d.held || [];
    const list = $("stuckList");
    list.innerHTML = "";
    // Retry all only clears backoff timers, so it is disabled when no destination is backing off.
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

  // The ⚠ badge's number; the note appears only when sections overlap (the caller must sum every
  // section's files, held_files included, to detect that).
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
    // Pinned = held for this node while it was offline; flag it explicitly.
    const pin = row.querySelector(".orphan-pin");
    pin.hidden = !o.pinned;
    if (o.pinned) pin.title = T("At least one of these was held for this node while it was offline.");
    row.querySelector(".stuck-meta").textContent = TN(o.instances, "{n} instances waiting");
    fileChips(row.querySelector(".orphan-files"), o);
    // The engine's sentence verbatim: only it knows what happens to pinned copies.
    row.querySelector(".orphan-msg").textContent = o.message || "";
    return row;
  }

  function heldRow(h) {
    const row = I18N_IN($("heldRowTpl").content.cloneNode(true)).querySelector(".stuck-row");
    row.querySelector(".held-name").textContent = h.name || T("(destination)");
    // Cause tag beside the name (the two causes need opposite remedies); none when cause is "" (mixed).
    const tag = { "profile-off": T("profile off"), "no-deidentifier": T("no de-identifier") }[h.cause];
    if (tag) {
      const chip = document.createElement("span");
      chip.className = "held-cause";
      chip.textContent = tag;
      row.querySelector(".stuck-dest").appendChild(chip);
    }
    row.querySelector(".stuck-meta").textContent = TN(h.instances, "{n} instances waiting");
    fileChips(row.querySelector(".held-files"), h);
    // `message` (reason + remedy) taken whole from the engine, like the orphan sentence.
    row.querySelector(".held-msg").textContent = h.message || "";
    // Gated here: these rows are built after applyCapabilities' sweep.
    row.querySelectorAll(".held-jump [data-cap]").forEach((b) => { b.hidden = !capAllowed(b); });
    return row;
  }

  // A sample of file names (bounded by the engine); the rest counted in `more`.
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
      // Restore on success too: Retry all is static markup the redraw never replaces.
      // renderStuck() has the last word on `disabled`.
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

