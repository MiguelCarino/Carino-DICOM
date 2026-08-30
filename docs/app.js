/* Carino DICOM landing page — detect the visitor's OS, highlight their download,
   and wire per-platform links to the latest GitHub release (fallback: Releases). */
(function () {
  "use strict";

  var REPO = "MiguelCarino/Carino-PACS";
  var RELEASES = "https://github.com/" + REPO + "/releases";

  // Pinned v1.0.0 assets — the default links; the latest-release fetch below
  // replaces them when a newer release with matching assets exists.
  var PINNED_TAG = "v1.0.0";
  var PINNED = {
    windows: RELEASES + "/download/v1.0.0/carinopacs-windows-v.1.0.0.zip",
    macos: RELEASES + "/download/v1.0.0/carinopacs-macos-v.1.0.0.zip",
    linux: RELEASES + "/download/v1.0.0/carinopacs-ubuntu-latest-v1.0.0.zip",
  };

  var cards = {
    windows: document.querySelector('.dl-btn[data-os="windows"]'),
    macos: document.querySelector('.dl-btn[data-os="macos"]'),
    linux: document.querySelector('.dl-btn[data-os="linux"]'),
  };

  // Works even before JS / before the API call resolves.
  Object.keys(cards).forEach(function (k) { if (cards[k]) cards[k].href = PINNED[k]; });

  function detectOS() {
    var s = ((navigator.userAgentData && navigator.userAgentData.platform) ||
      navigator.platform || navigator.userAgent || "").toLowerCase();
    if (s.indexOf("win") >= 0) return "windows";
    if (s.indexOf("mac") >= 0 || s.indexOf("darwin") >= 0 || s.indexOf("iphone") >= 0 || s.indexOf("ipad") >= 0) return "macos";
    if (s.indexOf("linux") >= 0 || s.indexOf("x11") >= 0 || s.indexOf("android") >= 0) return "linux";
    return null;
  }

  var os = detectOS();
  if (os && cards[os]) cards[os].classList.add("recommended");

  function matchOS(name) {
    var n = name.toLowerCase();
    if (n.slice(-4) === ".exe") return "windows";
    if (n.slice(-4) === ".dmg") return "macos";
    if (n.slice(-9) === ".appimage") return "linux";
    // Release zips are named <product>-<runner>-v<version>.zip, and the
    // product half changed at the rename, so match on the runner half.
    if (n.slice(-4) === ".zip") {
      if (n.indexOf("windows") >= 0) return "windows";
      if (n.indexOf("macos") >= 0 || n.indexOf("darwin") >= 0) return "macos";
      if (n.indexOf("linux") >= 0 || n.indexOf("ubuntu") >= 0) return "linux";
    }
    return null;
  }

  function setDownload(k, url, name) {
    var btn = cards[k];
    if (!btn) return;
    btn.href = url;
    btn.title = name;
  }

  var vEl = document.getElementById("version");
  // i18n.js (deferred) defines window.t; guard in case it hasn't run yet.
  var tt = function (s) { return (typeof window.t === "function") ? window.t(s) : s; };

  // The line reads what the BUTTONS will hand you, which is not always the
  // newest tag: a release that carries no installers leaves the buttons on the
  // pinned assets, and a version label that moved without the links moving
  // would be a label that lies. The link to every version lives under the
  // buttons in the markup, so this element is only ever the one number.
  // Shown without the tag's leading v: "Version 1.0.0" is how a person says it,
  // and the v belongs to git rather than to the reader. The links still carry
  // the real tag.
  // The tag is remembered because this line is the one piece of translated text
  // on the page that JS writes rather than markup: i18n.js re-applies every
  // [data-i18n] element on carino:langchange, and this element carries none —
  // it cannot, the number has to come from the network. Without the listener
  // below the word 'Version' stayed in whatever language the page loaded in
  // while everything around it switched, which reads as a missing translation
  // rather than as the wiring gap it is.
  var shownTag = null;
  function showVersion(tag) {
    if (tag != null) shownTag = tag;
    if (vEl && shownTag != null) {
      vEl.innerHTML = tt('Version') + ' <strong>' + String(shownTag).replace(/^v/, '') + '</strong>';
    }
  }
  // Order against i18n.js's own listener does not matter: t() resolves the
  // locale through window.CarinoLang.current on every call, and carino-lang.js
  // has already written it by the time the event is dispatched. Whichever
  // listener runs first reads the new language.
  window.addEventListener('carino:langchange', function () { showVersion(null); });

  fetch("https://api.github.com/repos/" + REPO + "/releases/latest",
    { headers: { Accept: "application/vnd.github+json" } })
    .then(function (res) { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
    .then(function (rel) {
      var found = 0;
      (rel.assets || []).forEach(function (a) {
        var k = matchOS(a.name);
        if (k) { setDownload(k, a.browser_download_url, a.name); found++; }
      });
      showVersion(found ? rel.tag_name : PINNED_TAG);
    })
    .catch(function () { showVersion(PINNED_TAG); });

  // ---- the manual, in the language on screen -----------------------------
  // Every fleet language has a manual of its own now, so each entry points at
  // its own directory and nobody is sent to a translation they cannot read.
  // The fallback below is still live wiring, for a language that reaches this
  // page before its manual is written: add the directory here and the borrowed
  // marking stops on its own.
  var MANUALS = {
    en: "manual/", es: "manual/es/", "pt-BR": "manual/pt-BR/",
    ja: "manual/ja/", ru: "manual/ru/",
  };
  var manualLink = document.getElementById("manualLink");
  function pointManual(lang) {
    if (!manualLink) return;
    manualLink.href = MANUALS[lang] || MANUALS.en;
    // Say where it actually goes when that is not the language being read. This
    // is the only route to the manual on the page, so a reader pressing a label
    // in their own language and landing in English has to be told before the
    // click, not after: `soon` appends "· EN", and hreflang tells a screen
    // reader the same thing. Both come off by themselves the day MANUALS gains
    // the entry — every language in the map today takes the false branch.
    var fallback = !MANUALS[lang] || MANUALS[lang] === MANUALS.en;
    var borrowed = !!lang && lang !== "en" && fallback;
    manualLink.classList.toggle("soon", borrowed);
    if (borrowed) manualLink.setAttribute("hreflang", "en");
    else manualLink.removeAttribute("hreflang");
  }
  // On DOMContentLoaded, not now. This file is a classic non-deferred script, so
  // it runs while the document is still parsing — before carino-lang.js, which is
  // deferred and is what resolves the language. Reading CarinoLang here gets
  // undefined, and carino:langchange only fires when somebody actively switches,
  // never on the initial resolution. Between the two, every reader who ARRIVED in
  // a language — ?lang=es, a stored choice, a browser default — was handed the
  // English manual and nothing said so. Deferred scripts have all run by
  // DOMContentLoaded, which is the first moment the answer exists.
  function initManual() {
    pointManual((window.CarinoLang && window.CarinoLang.current) || document.documentElement.lang);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initManual);
  else initManual();
  window.addEventListener("carino:langchange", function (e) { pointManual(e.detail && e.detail.lang); });

  // ---- sheets --------------------------------------------------------------
  // Every chip and the Server button open a <dialog> the same way, so the wiring
  // is one delegated listener rather than one per sheet. Backdrop dismissal is
  // the only part <dialog> does not give us: a click anywhere in the dialog's
  // box, padding included, reports the dialog itself as the target, so the hit
  // has to be tested against the box.
  function openSheet(id, focusClass) {
    var dlg = document.getElementById(id);
    if (!dlg || typeof dlg.showModal !== "function") return false;
    dlg.showModal();
    if (focusClass) {
      var el = dlg.querySelector("." + focusClass);
      if (el) el.scrollIntoView({ block: "start" });
    }
    return true;
  }
  document.querySelectorAll("[data-sheet]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      openSheet(btn.dataset.sheet, btn.dataset.focus);
    });
  });
  document.querySelectorAll("dialog.modal").forEach(function (dlg) {
    dlg.addEventListener("click", function (e) {
      if (e.target !== dlg) return;
      var r = dlg.getBoundingClientRect();
      var inside = e.clientX >= r.left && e.clientX <= r.right &&
                   e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) dlg.close();
    });
  });

  // ---- server chooser ----------------------------------------------------
  // <dialog> brings the focus trap, Escape, the backdrop and an inert
  // background with it. The only things left to do by hand are the aria-expanded
  // bookkeeping and dismissing on a backdrop click, which the element does not
  // do on its own — a click anywhere in the dialog's box, padding included,
  // reports the dialog itself as the target, so compare against the box.
  var srvBtn = document.getElementById("serverBtn");
  var srvDlg = document.getElementById("serverDialog");
  if (srvBtn && srvDlg && typeof srvDlg.showModal === "function") {
    var setExpanded = function (v) { srvBtn.setAttribute("aria-expanded", v ? "true" : "false"); };
    srvBtn.addEventListener("click", function () { srvDlg.showModal(); setExpanded(true); });
    srvDlg.addEventListener("close", function () { setExpanded(false); srvBtn.focus(); });
  } else if (srvBtn) {
    // No <dialog> support: send them to the deployment guide rather than leave a
    // button that does nothing. There is no longer a section on this page to
    // scroll to — the dialog is the only copy of these instructions.
    srvBtn.addEventListener("click", function () {
      window.open("https://github.com/" + REPO + "/blob/main/packaging/README.md", "_blank", "noopener");
    });
  }
})();
