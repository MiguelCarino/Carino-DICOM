/* Status polling render, emergency failover, Settings readouts (index/DICOMweb/de-id) and the config-problem banner. */
"use strict";
// ---- Status polling ----
// Auth state rides every status payload, so token changes elsewhere apply without a reload.
function syncStatusAuth(auth) {
  authRequired = !!auth.required;
  profilesOn = !!auth.profiles;
  // Re-read every poll so an admin's permission change reaches the nav at once
  // (instead of buttons that now 403); redrawn only when it changed.
  const nextWho = auth.who || null;
  if (JSON.stringify(nextWho) !== JSON.stringify(me)) {
    me = nextWho;
    applyCapabilities();
  }
}

// This machine's addresses: every IP, never "+1" alone — on a two-NIC box the second may be the one a modality needs.
function hostIps(s) {
  return (s.host_ips && s.host_ips.length) ? s.host_ips : (s.host_ip ? [s.host_ip] : []);
}

// This machine's network identity (what remote nodes send to).
function renderNetInfo(s, rx) {
  const ni = $("netInfo");
  if (!ni) return;
  ni.textContent = "";
  // Compact navbar form: first IP + count, then the receiver AE:port; the tooltip lists them all.
  const ips = hostIps(s);
  if (ips.length) {
    ni.classList.remove("offline");
    const v = (t) => { const el = document.createElement("span"); el.className = "v"; el.textContent = t; return el; };
    ni.append(v(ips[0]));
    if (ips.length > 1) ni.append(" +" + (ips.length - 1));
    ni.append(" · ", v(rx.aet + ":" + rx.port));
    ni.title = ips.join(" · ") + " — " + rx.aet + ":" + rx.port;
  } else {
    ni.classList.add("offline");
    ni.textContent = T("offline");
    ni.title = "";
  }
}

// Each badge has its own glyph and spoken name so two counts on one row stay distinguishable.
// TN() takes a literal at each call site: the i18n-parity check greps for literals.
function renderStatusBadges(s, rs) {
  const nPend = s.pending || 0, nStuck = s.stuck || 0, nOrd = (rs.counts && rs.counts.open) || 0;
  setBadge("pendingBadge", nPend, "📎", TN(nPend, "{n} pending imports"));
  setBadge("stuckBadge", nStuck, "⚠", TN(nStuck, "{n} stuck sends"));
  setBadge("ordersBadge", nOrd, "", TN(nOrd, "{n} open orders"));
}

/* Orders list repaints on any ris.counts change (create, every close path, cancel).
   Known gap: an HL7 amendment moves no count, so it shows only after the next change or ↻ Refresh. */
function syncOrderCounts(c) {
  if (!c) return;
  const sig = c.open + "/" + c.closed + "/" + c.total;
  if (lastOrderCounts === null) lastOrderCounts = sig;   // adopt: opening the panel fetches anyway
  else if (sig !== lastOrderCounts) {
    lastOrderCounts = sig;
    // Only while visible; openPanel loads it fresh anyway.
    if (!gateOpen && activePanel === "dlgOrders") loadOrders();
  }
  // The purge button depends on the closed count, which changes without this panel open.
  paintOrdPurge(c.closed);
}

// Low-disk warning banner (only when the storage volume is below the floor).
function renderDiskWarn(d) {
  const dw = $("diskWarn");
  if (!dw) return;
  if (d.low) {
    dw.hidden = false;
    dw.textContent = TF(
      "⚠ Low disk space — {free} free (below the {floor} GB floor). New incoming studies will be refused until space is freed.",
      { free: (d.free_gb != null ? d.free_gb + " GB" : "?"), floor: d.floor_gb });
  } else {
    dw.hidden = true;
  }
}

// ---- Service cards: one readout per listener ----
/* "Point the modality at: AE · IP · port". A specific bind address is the only address that works;
   0.0.0.0 means every address this machine has, so all of them are listed. Stopped = "not listening". */
function renderConnect(pfx, blk, ips) {
  const line = $(pfx + "Connect");
  if (!line) return;
  const bind = blk.bind || "0.0.0.0";
  const addrs = (bind === "0.0.0.0" || bind === "::") ? (ips.length ? ips : [bind]) : [bind];
  const aet = $(pfx + "Aet");
  if (aet) { aet.textContent = dash(blk.aet); aet.title = dash(blk.aet); }
  $(pfx + "Ips").textContent = addrs.join(" / ");
  $(pfx + "CPort").textContent = dash(blk.port);
  const off = $(pfx + "Off");
  if (off) off.hidden = !!blk.running;
  line.classList.toggle("off", !blk.running);
  // Copy text is plain and complete: what gets pasted into an engineer's notes or a ticket.
  line.dataset.copyText = [blk.aet, addrs.join(" / "), blk.port].filter((v) => v != null && v !== "").join(" · ");
}

// Security row only when TLS is on: "plaintext" on every card repeated a default as news.
function renderTlsRow(pfx, blk) {
  const row = $(pfx + "TlsRow");
  if (row) row.hidden = !blk.tls;
  const el = $(pfx + "Tls");
  if (el) el.textContent = blk.tls ? (blk.tls_mutual ? T("mTLS") : "TLS") : "";
}

/* last_problem {message, at} of a listener: the reason a modality only ever sees as a status code.
   `newerThan` (seconds) hides a problem that a later success has already answered. */
function renderProblem(pfx, pb, newerThan) {
  const line = $(pfx + "Problem");
  if (!line) return;
  const show = !!(pb && pb.message && (!newerThan || pb.at > newerThan));
  line.hidden = !show;
  if (!show) return;
  line.querySelector(".cp-text").textContent =
    TF("Last problem ({ts}): {msg}", { ts: fmtLogTs(pb.at * 1000), msg: pb.message });
  const link = line.querySelector(".cp-log");
  if (link) link.hidden = !can("logs.read");
}

function renderReceiverCard(rx, ips) {
  setDot($("rxDot"), rx.running);
  renderConnect("rx", rx, ips);
  setPath("rxDir", rx.storage_dir);
  $("rxCount").textContent = rx.received;
  // `refused` = stores turned away below the free-space floor (the low-disk banner only shows
  // the current state). Shown as a marker beside errors; the explanation is in the tooltip.
  const rxErr = $("rxErr");
  rxErr.textContent = rx.refused ? rx.errors + " ⛔" + rx.refused : rx.errors;
  rxErr.title = rx.refused
    ? TF("{n} incoming studies were REFUSED for low disk space and never arrived. Nothing retries them from this side — the sender has to send them again once there is space.", { n: rx.refused })
    : "";
  renderTlsRow("rx", rx);
  renderProblem("rx", rx.last_problem);
  setToggle($("rxToggle"), rx.running, "Receiver");
  setChip("rx", rx.running);
}

function renderWatcherCard(wx) {
  setDot($("wxDot"), wx.running);
  setPath("wxDir", wx.watch_dir);
  setAtomic("wxAet", wx.aet);
  $("wxSent").textContent = wx.sent;
  $("wxFailed").textContent = wx.failed;
  $("wxLast").textContent = wx.last_activity || "—";
  setToggle($("wxToggle"), wx.running, "Auto-send");
  setChip("wx", wx.running);
}

function renderPrinterCard(px, ips) {
  setDot($("pxDot"), px.running);
  renderConnect("px", px, ips);
  $("pxMode").textContent = (px.color ? T("gray + color") : T("grayscale")) +
    " · " + (px.layout === "image" ? T("→ SC") : T("→ PDF"));
  // Nothing is printed: each job is captured into Pending, so the counter says so.
  $("pxCount").textContent = px.printed || 0;
  $("pxErr").textContent = px.errors || 0;
  renderTlsRow("px", px);
  // Last film that arrived, and the last thing that went wrong if it is newer:
  // a modality only ever shows a status code, so this is where the reason is.
  const lp = px.last_print;
  $("pxLast").textContent = lp
    ? TF("{n} film(s) from {src}, {ts}", { n: lp.films, src: lp.source, ts: fmtLogTs(lp.at * 1000) })
    : "—";
  renderProblem("px", px.last_problem, lp ? lp.at : 0);
  const since = $("pxSince");
  if (since) since.textContent = px.since ? TF("Counted since {ts}", { ts: fmtLogTs(px.since * 1000) }) : "";
  setToggle($("pxToggle"), px.running, "Print receiver");
  setChip("px", px.running);
}

function renderRisCard(rs, ips) {
  setDot($("rsDot"), rs.running);
  renderConnect("rs", rs, ips);
  $("rsOpen").textContent = (rs.counts && rs.counts.open) || 0;
  $("rsRecv").textContent = rs.received || 0;
  $("rsErr").textContent = rs.errors || 0;
  renderProblem("rs", rs.last_problem);
  setToggle($("rsToggle"), rs.running, "Emergency RIS");
  setChip("rs", rs.running);
}

function renderMwlCard(mw, ips) {
  setDot($("mwDot"), mw.running);
  renderConnect("mw", mw, ips);
  $("mwQueries").textContent = mw.queries || 0;
  $("mwMatches").textContent = mw.matches || 0;
  renderTlsRow("mw", mw);
  renderProblem("mw", mw.last_problem);
  setToggle($("mwToggle"), mw.running, "Worklist");
  setChip("mw", mw.running);
}

function renderQrCard(qr, ips) {
  setDot($("qrDot"), qr.running);
  renderConnect("qr", qr, ips);
  $("qrQueries").textContent = qr.queries || 0;
  $("qrMatches").textContent = qr.matches || 0;
  const qrSent = $("qrSent");
  qrSent.textContent = qr.sent || 0;
  // C-MOVE / C-GET breakdown in the tooltip.
  qrSent.title = TF("{moves} C-MOVE · {gets} C-GET", { moves: qr.moves || 0, gets: qr.gets || 0 });
  $("qrFailed").textContent = qr.move_failures || 0;
  $("qrErr").textContent = qr.errors || 0;
  renderTlsRow("qr", qr);
  renderProblem("qr", qr.last_problem);
  // qr.aet is editable, so the hint names the one actually in use.
  const hint = $("qrHint");
  if (hint) hint.textContent = TF("C-MOVE calls out as {aet} — allow that AE there", { aet: qr.aet || "CARINOQR" });
  setToggle($("qrToggle"), qr.running, "Query/Retrieve");
  setChip("qr", qr.running);
}

// Border = enrolled (persisted flag), dot = running, so an enrolled service that failed to start is visible.
function paintServiceCardStates(rx, wx, px, rs, mw, qr) {
  setCardState("receiverCard", rx.enabled, rx.running);
  setCardState("watcherCard", wx.enabled, wx.running);
  setCardState("printerCard", px.enabled, px.running);
  setCardState("risCard", rs.enabled, rs.running);
  // A no_ris destination also enrols the worklist (worklist_wanted() in sync_services).
  setCardState("mwlCard", mw.enabled || mw.wanted, mw.running);
  setCardState("qrCard", qr.enabled, qr.running);
}

function offerFirstRunSetup(s) {
  if (setupActive) {
    // Entered before the first status landed (boot #setup): seed now.
    if (!setupSeeded) seedSetup(s);
  } else if (!setupDismissed && s.setup && s.setup.needed && can("services.control")) {
    // Door 1: nothing chosen yet on this machine. Only with services.control, or the
    // appliance wedges in setup with no chooser shown; showPanelInternal skips entitlement checks.
    showPanelInternal("dlgServices");
    enterSetup();
  }
}

let lastSiteModSig = "";

function renderStatus(s) {
  const rx = s.receiver, wx = s.watcher, px = s.printer || {}, rs = s.ris || {}, mw = s.mwl || {};
  const qr = s.qr || {};
  lastStatus = s;
  if (s.auth) syncStatusAuth(s.auth);
  mountServiceChips();      // self-heals if the navbar mounted after us
  renderNetInfo(s, rx);
  const ips = hostIps(s);

  editorUrl = (s.editor_url || "").trim();

  /* Order-form targets follow the ungated `modalities` registry (see _STATUS_GATES in web.py).
     Rebuilt only on change, so a <select> is never refilled under an operator using it. */
  if (Array.isArray(s.modalities)) statusModalities = s.modalities;
  if (registryChanged()) refreshTargetChoices();
  // Same rule for "Modalities at this site": the order form and the room checks follow the saved list.
  const siteSig = JSON.stringify(s.site_modalities || []);
  if (siteSig !== lastSiteModSig) {
    lastSiteModSig = siteSig;
    fillModalityChoices();
    document.querySelectorAll("#modBody tr").forEach(flagModRow);
  }

  // Gated sections are dropped (not blanked) for profiles without the capability, so absent
  // means "off or not yours"; applyCapabilities only runs when `me` changes, so redraw here.
  const nextPeer = !!(s.dev_peer && s.dev_peer.available);
  if (nextPeer !== devPeerAvailable) { devPeerAvailable = nextPeer; applyCapabilities(); }
  if (activePanel === "dlgDevPeer") renderDevPeer(s.dev_peer || null);

  renderStatusBadges(s, rs);
  syncStudyCounts(s);       // Pending/Stuck tab counts + refresh of the visible pane (js/09-studies.js)

  /* Order arrival, edge-triggered off ris.created_seq (rises once per created order).
     After the badge repaint so number and flash agree. Without orders.read the ris
     block is absent (_STATUS_GATES), so the typeof check is the capability gate.
     Kept inline: tests/alert-state.mjs lifts this block out of renderStatus by its first line. */
  const seq = rs.created_seq;
  if (typeof seq === "number") {
    if (lastCreatedSeq === null || seq < lastCreatedSeq) {
      /* First poll after load/sign-in: adopt silently. The tick is persisted (pacs/ris.py),
         so going backwards means it lost its base (old/restored orders.json) — adopt, don't invent arrivals. */
      lastCreatedSeq = seq;
    } else if (seq > lastCreatedSeq) {
      const n = seq - lastCreatedSeq;
      lastCreatedSeq = seq;   // advance BEFORE announcing: once per arrival, not once per poll
      onOrderArrived(n);
    }
  }

  syncOrderCounts(rs.counts);
  renderDiskWarn(s.disk || {});

  // Config.load() deliberately doesn't refuse a bad config (so the PACS still starts);
  // the engine publishes the verdict as status.config_problem and it must be shown.
  renderConfigProblem(s.config_problem || "", s.config_path || "");

  renderReceiverCard(rx, ips);
  renderWatcherCard(wx);
  renderPrinterCard(px, ips);
  renderRisCard(rs, ips);
  renderMwlCard(mw, ips);
  renderQrCard(qr, ips);

  renderEmergency(s.emergency || {}, rs, mw);
  renderIndex(s.index || {});
  renderDicomweb(s.dicomweb || {});
  renderDeidState(s.deid || {});
  renderDeidKeyBox(s.deid || {});
  renderSettingsStates(s, ips);
  renderSetupDone(s, ips);

  paintServiceCardStates(rx, wx, px, rs, mw, qr);
  offerFirstRunSetup(s);
  renderOverview(s);
}

// ---- Emergency failover: banner, activation pop-up, card visibility ----
let emgPromptShown = false;
function renderEmergency(emg, rs, mw) {
  // Worklist + Emergency-RIS cards show only when running, enrolled or failover is armed.
  const rsCard = $("risCard"), mwCard = $("mwlCard");
  // Setup shows every card; clearing the hidden attribute (not CSS) keeps screen readers in step.
  const rsShow = !!((rs && (rs.running || rs.enabled)) || emg.armed || setupActive);
  const mwShow = !!((mw && (mw.running || mw.enabled || mw.wanted)) || emg.armed || setupActive);
  if (rsCard) rsCard.hidden = !rsShow;
  if (mwCard) mwCard.hidden = !mwShow;
  showChip("rs", rsShow);
  showChip("mw", mwShow);

  const banner = $("emgBanner");
  const state = emg.state || "off";
  const who = emg.trigger_dest || "primary";
  // may_activate is absent without profiles, where anyone may answer.
  const allowed = emg.may_activate !== false;
  if (state === "triggered" || state === "active" || state === "recovering") {
    banner.hidden = false;
    banner.className = "emg-banner " + state;
    let text, actions;
    if (state === "active") {
      // Report the engine's worklist_serving; absent (older engine) reads as serving.
      text = emg.worklist_serving === false
        ? TF("🚨 EMERGENCY ACTIVE — '{who}' unreachable. The worklist is NOT serving, so orders will not reach the modalities; received studies are held for forward.", { who })
        : TF("🚨 EMERGENCY ACTIVE — '{who}' unreachable. Worklist is serving; received studies are held for forward.", { who });
      actions = [[T("Resume normal"), "resume", "btn"]];
    } else if (state === "recovering") {
      text = TF("↩ '{who}' is back — flushing held studies to it. Click Resume when done.", { who });
      // held_remaining (when the engine can count it cheaply) says when "done" is.
      if (typeof emg.held_remaining === "number") {
        text += " " + (emg.held_remaining
          ? TF("{n} held studies still to send.", { n: emg.held_remaining })
          : T("Every held study has been sent."));
      }
      actions = [[T("Resume normal"), "resume", "btn"]];
    } else {  // triggered (prompt may be dismissed)
      text = TF("⚠ Primary '{who}' is unreachable — emergency RIS not activated.", { who });
      actions = [[T("Activate"), "activate", "btn"], [T("Disarm"), "disarm", "btn ghost"]];
    }
    $("emgBannerText").textContent = text;
    const wrap = $("emgBannerActions");
    wrap.innerHTML = "";
    // Only someone who may answer gets the buttons; the others would click into a refusal.
    (allowed ? actions : []).forEach(([label, action, cls]) => {
      const b = document.createElement("button");
      b.className = cls + " tiny";
      b.textContent = label;
      b.addEventListener("click", () => {
        if (action === "disarm" && !confirm(T("Disarm failover? Nothing watches the primary archive until it is armed again in Settings."))) return;
        emergencyAction(action);
      });
      wrap.appendChild(b);
    });
  } else {
    banner.hidden = true;
  }

  const prompt = $("emgPrompt");
  if (emg.prompt) {
    if (!emgPromptShown) {
      $("emgPromptMsg").textContent =
        TF("The primary PACS '{who}' has been unreachable past the failover threshold.", { who });
      renderEmergencyGuidance(emg);
      openEmgPrompt();
    }
  } else if (emgPromptShown) {
    closeEmgPrompt();
  }
}

/* Role-specific failover guidance (role is admin-typed; unknown roles get none).
   Activate follows emergency.activate_by (server-enforced); others see who can answer. */
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
  // may_activate is absent without profiles, where anyone may answer.
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
  // Dismissal silences the modal only for this user.
  if (dismiss) dismiss.textContent = allowed ? T("Not now") : T("I have seen this");
}

// A real modal: the dashboard behind it goes inert and focus lands on the first action.
function openEmgPrompt() {
  const prompt = $("emgPrompt");
  prompt.hidden = false;
  emgPromptShown = true;
  const wrap = document.querySelector("main.wrap");
  if (wrap && !gateOpen) wrap.inert = true;
  const act = $("emgActivate");
  const first = (act && !act.hidden) ? act : $("emgDismiss");
  if (first) setTimeout(() => first.focus(), 0);
}
function closeEmgPrompt() {
  const prompt = $("emgPrompt");
  if (prompt) prompt.hidden = true;
  emgPromptShown = false;
  const wrap = document.querySelector("main.wrap");
  if (wrap && !gateOpen) wrap.inert = false;
}

async function emergencyAction(action) {
  try {
    const r = await post("/api/emergency", { action });
    flashNote(r.message || TF("Emergency: {action}", { action }), r.ok !== false);
    closeEmgPrompt();
    syncArmedFlag();
    pollStatus();
  } catch (e) {
    flashNote(e.message, false);
    // A refused "I have seen this" must not leave the whole dashboard locked behind the prompt.
    if (action === "dismiss") closeEmgPrompt();
  }
}

/* Arm/Disarm persist emergency.armed. Mirror it into the Settings form and its snapshot, and adopt
   the new version tag, or the next Save posts the stale flag back (re-arming) or reads as a 409. */
async function syncArmedFlag() {
  if (!can("config.read") || !loadedRaw) return;
  let fresh;
  try { fresh = await api("/api/config"); } catch (e) { return; }
  const armed = !!(fresh.emergency && fresh.emergency.armed);
  if (!!loadedEmg.armed === armed) return;
  loadedEmg.armed = armed;
  const box = $("emgArmed");
  if (box) box.checked = armed;
  refreshEtagAfterOwnWrite((doc, old) => { if (doc.emergency && old.emergency) doc.emergency.armed = old.emergency.armed; });
}
// ---- Settings readouts: instance index, DICOMweb, de-identification ----
// Drawn from the status poll; skipped when their markup is absent.
function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}

// Skipped while Settings is closed; showPanel repaints from the last poll.
const settingsOpen = () => { const p = $("dlgSettings"); return !!p && !p.hidden; };

function renderIndex(ix) {
  if (!settingsOpen()) return;
  const txt = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  txt("idxInstances", ix.instances != null ? ix.instances : "—");
  txt("idxStudies", ix.studies != null ? ix.studies : "—");
  txt("idxPatients", ix.patients != null ? ix.patients : "—");
  txt("idxQueued", ix.queued != null ? ix.queued : "—");
  // last_write (last row written) shows whether the index keeps up; a rescan time would not.
  txt("idxLast", ix.last_write ? fmtLogTs(ix.last_write * 1000) : T("never"));
  setPath("idxDbPath", ix.path ? ix.path + (ix.db_bytes ? "  ·  " + fmtSize(ix.db_bytes) : "") : "—");
  const note = $("idxNote");
  if (note) {
    // `rebuilt`: a schema change dropped the index empty, so Q/R and DICOMweb answer
    // "no such study" until a rescan. Shown only while still empty so it self-clears.
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
    // Absolute: it gets pasted into a viewer on another machine.
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

// Page-wide "config would be refused" banner beside the low-disk one; created once, then updated.
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
  // Engine's sentence (untranslated) inside a translated frame.
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
  // From the engine (status.deid), not the form: `destinations` will be scrubbed for;
  // `held` want scrubbing that cannot be performed, so nothing is sent to them.
  const held = dd.held || [];
  // Advice must match the engine's hold_cause: wrong advice here ("take de-identify off
  // the rule") would release studies IDENTIFIED to a node meant to get scrubbed data.
  const cause = dd.hold_cause || "";
  st.textContent = !held.length
    ? (dests.length
      ? TF("Rules de-identify for: {dests}", { dests: dests.join(", ") })
      : T("No routing rule asks for de-identification, so nothing is being scrubbed."))
    : cause === "no-deidentifier"
      ? TF("Rules ask to de-identify for {dests}. The profile is on, but no de-identifier can be built from these settings, so nothing can be scrubbed and those studies are HELD in the outgoing folder instead of being sent. Repair the de-identification settings below: turning the profile off does NOT release them, and taking de-identify off the rule releases them identified.", { dests: held.join(", ") })
      : cause === "profile-off"
        ? TF("Rules ask to de-identify for {dests}, but the de-identification profile is off. Nothing can be scrubbed, so those studies are HELD in the outgoing folder instead of being sent. Turn a profile on, or take de-identify off the rule.", { dests: held.join(", ") })
        // Unknown cause: state the facts rather than guess one of the two.
        : TF("Rules ask to de-identify for {dests}, and nothing can be scrubbed, so those studies are HELD in the outgoing folder instead of being sent. Check the profile below: if it is off, turn it on; if it is on, nothing could be built to scrub with and the log says why.", { dests: held.join(", ") });
  // Red only when deliveries are held: the operator must act before anything moves.
  st.classList.toggle("bad-note", !!held.length);
  st.classList.remove("warn-note");
  // Site key status (the key itself is always redacted). Without one, pseudonyms are
  // reproducible by anyone with this software. Only relevant while a profile is on.
  if ((dd.profile || "off") !== "off") {
    const key = document.createElement("span");
    key.className = "deid-key" + (dd.secret_set ? "" : " warn");
    key.textContent = dd.secret_set
      ? T("A site key is set — pseudonyms and date shifts cannot be reproduced without it.")
      : T("No site key is set — pseudonyms are derived from the study alone, so anyone with this software can reverse them. Set one below.");
    st.appendChild(key);
  }
  // `retrieval_raw`: open retrieval services (C-MOVE, C-GET, WADO-RS) serve stored files
  // unscrubbed — de-id applies to forwarding only. Warned only when a scrub is configured.
  const doors = dd.retrieval_raw || [];
  if (doors.length && (dests.length || held.length)) {
    const via = document.createElement("span");
    via.className = "deid-key warn";
    // Protocol names stay untranslated, to match the other node's configuration.
    const label = { qr: "Q/R (C-MOVE · C-GET)", dicomweb: "DICOMweb (WADO-RS)" };
    via.textContent = TF("De-identification applies to FORWARDING only. {doors} are open, and they serve stored studies exactly as they were received — a node allowed to pull from this PACS gets the identified originals whatever the rules scrub for on the way out.",
                         { doors: doors.map((d) => label[d] || d).join(" · ") });
    st.appendChild(via);
  }
  // deid.superseded_sends: sends in flight when settings changed; the rest of each study was held.
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
    // Re-enable; the poll disables it again while the rescan runs.
    btn.disabled = false;
    pollStatus();
  }
}

// `name` is the English service label: four identical "Stop" buttons say nothing to a screen reader.
function setToggle(btn, on, name) {
  btn.dataset.on = String(on);
  btn.textContent = on ? T("Stop") : T("Start");
  if (name) btn.setAttribute("aria-label", on ? TF("Stop {svc}", { svc: T(name) }) : TF("Start {svc}", { svc: T(name) }));
}
function setDot(el, on) {
  el.classList.toggle("on", on);
  el.classList.toggle("off", !on);
}


// ---- Lost contact with the engine ----
/* Fed by api() for every status poll (js/01-core.js). Three misses in a row (~6 s at the 2 s poll)
   raise a page-wide banner and grey out every live indicator; the poll keeps running, and the
   first answer clears it. A 401 is contact (the gate takes over), so it never counts. */
let contactFails = 0, contactLostAt = 0;
function noteContact(ok) {
  if (ok) {
    if (contactFails >= 3) paintContact(false);
    contactFails = 0;
    contactLostAt = 0;
    return;
  }
  if (!contactFails) contactLostAt = Date.now();
  contactFails += 1;
  if (contactFails === 3) paintContact(true);
}
function paintContact(lost) {
  document.body.classList.toggle("contact-lost", lost);
  const el = $("lostContact");
  if (!el) return;
  el.hidden = !lost;
  el.textContent = lost
    ? TF("Lost contact with the PACS engine at {time} — what you see is frozen. Retrying…",
         { time: new Date(contactLostAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })
    : "";
}

// ---- Settings: live state beside each group heading ----
const GROUP_SERVICES = {
  sgThisPacs: [["receiver", "Receiver"]],
  sgSending: [["watcher", "Auto-send"]],
  sgWorklist: [["mwl", "Worklist"], ["ris", "Emergency RIS"]],
  sgPrinting: [["printer", "Print receiver"]],
  sgQuery: [["qr", "Query/Retrieve"], ["dicomweb", "DICOMweb"]],
};
function renderSettingsStates(s, ips) {
  if (!settingsOpen()) return;
  Object.keys(GROUP_SERVICES).forEach((gid) => {
    const el = $(gid + "State");
    if (!el) return;
    el.textContent = "";
    GROUP_SERVICES[gid].forEach(([key, label], i) => {
      const blk = s[key] || {};
      // DICOMweb has no listener of its own: "running" is whether it is switched on.
      const on = key === "dicomweb" ? !!blk.enabled : !!blk.running;
      const span = document.createElement("span");
      span.className = on ? "on" : "off";
      span.textContent = on ? TF("{svc}: running", { svc: T(label) }) : TF("{svc}: stopped", { svc: T(label) });
      if (i) el.append(" · ");
      el.appendChild(span);
    });
  });
  const fo = $("sgFailoverState");
  if (fo) {
    const emg = s.emergency || {};
    fo.textContent = emg.armed ? T("Failover armed") : T("Failover not armed");
  }
  const pv = $("sgPrivacyState");
  if (pv) {
    const prof = (s.deid || {}).profile || "off";
    pv.textContent = TF("De-identification: {profile}", { profile: prof });
  }
  // The print section repeats the card's connect line: the engineer configuring the modality is here.
  const pc = $("prnConnect");
  if (pc) {
    const px = s.printer || {};
    const bind = px.bind || "0.0.0.0";
    const addrs = (bind === "0.0.0.0" || bind === "::") ? (ips.length ? ips : [bind]) : [bind];
    pc.textContent = TF("Give the modality: AE {aet} · IP {ip} · port {port}", { aet: px.aet || "—", ip: addrs.join(" / "), port: px.port || "—" })
      + (px.running ? "" : " · " + T("not listening"));
  }
}

// ---- De-identification site key (POST /api/deid/secret) ----
function renderDeidKeyBox(dd) {
  const clear = $("deidKeyClear");
  if (clear) clear.hidden = !dd.secret_set;
  const set = $("deidKeySet");
  if (set) set.textContent = dd.secret_set ? T("Replace site key") : T("Set site key");
  // The engine wants the access token itself; without one configured there is nothing to prove.
  const proof = $("deidKeyProofWrap");
  if (proof) proof.hidden = !authRequired;
}

/* Not through api(): the token travels in a header for this request only, and a 401/403 here means
   the typed proof was wrong, which must not sign the dashboard out. */
async function applyDeidKey(action) {
  const tokenEl = $("deidKeyToken"), keyEl = $("deidKeyNew");
  const tok = ((tokenEl && tokenEl.value) || "").trim();
  const key = ((keyEl && keyEl.value) || "").trim();
  const isSet = !!(lastStatus && lastStatus.deid && lastStatus.deid.secret_set);
  if (action === "set" && !key) { flashNote(T("Enter or generate the new site key first."), false); if (keyEl) keyEl.focus(); return; }
  if (authRequired && !tok) { flashNote(T("Type the current access token first — changing the site key needs it."), false); if (tokenEl) tokenEl.focus(); return; }
  if (action === "set" && isSet && !confirm(T("Replace the site key? Everything exported from now on gets different pseudonyms and date shifts, so it will no longer line up with what was exported before."))) return;
  if (action === "clear" && !confirm(T("Remove the site key? Pseudonyms are then derived from the study alone, and anyone with this software can reverse them."))) return;
  const headers = { "Content-Type": "application/json", "X-Carino": "1" };
  if (tok) headers["X-Carino-Token"] = tok;
  let res, body = {};
  try {
    res = await fetch("/api/deid/secret", {
      method: "POST", headers,
      body: JSON.stringify(action === "clear" ? { action: "clear" } : { action: "set", secret: key }),
    });
    try { body = await res.json(); } catch (e) { /* empty */ }
  } catch (e) { flashNote(e.message, false); return; }
  if (!res.ok) { flashNote(body.error || body.message || res.statusText, false); return; }
  if (tokenEl) tokenEl.value = "";
  if (keyEl) { keyEl.value = ""; keyEl.type = "password"; }
  flashNote(body.message || (action === "clear" ? T("Site key removed.") : T("Site key set.")), true);
  // The key is part of the stored config: adopt the new version tag, or the next Save reads as stale.
  refreshEtagAfterOwnWrite((doc, old) => { if (doc.deid && old.deid) doc.deid.secret_set = old.deid.secret_set; });
  pollStatus();
}
