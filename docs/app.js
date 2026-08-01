/* Carino PACS landing page — detect the visitor's OS, highlight their download,
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
    // Release zips are named carinopacs-<runner>-v<version>.zip
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
  fetch("https://api.github.com/repos/" + REPO + "/releases/latest",
    { headers: { Accept: "application/vnd.github+json" } })
    .then(function (res) { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
    .then(function (rel) {
      var found = 0;
      (rel.assets || []).forEach(function (a) {
        var k = matchOS(a.name);
        if (k) { setDownload(k, a.browser_download_url, a.name); found++; }
      });
      if (vEl) {
        vEl.innerHTML = found
          ? tt('Latest release:') + ' <strong>' + rel.tag_name + '</strong> · <a href="' + RELEASES + '">' + tt('all versions & notes') + '</a>'
          : tt('Latest release') + ' <strong>' + rel.tag_name + '</strong> ' + tt('has no installers yet —') + ' <a href="' + RELEASES + '">' + tt('see releases') + '</a>.';
      }
    })
    .catch(function () {
      if (vEl) vEl.innerHTML = tt('Version') + ' <strong>' + PINNED_TAG + '</strong> · <a href="' + RELEASES + '">' + tt('all versions & notes') + '</a>';
    });
})();
