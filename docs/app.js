/* Carino DICOM landing page — detect the visitor's OS, highlight their download,
   and wire per-platform links to the latest GitHub release (fallback: Releases). */
(function () {
  "use strict";

  // The repository's real name, not the old one behind GitHub's redirect: this
  // string is used for an api.github.com call, and the API does not follow the
  // rename redirect the way the website does. Left stale, the latest-release
  // lookup below fails quietly and the page keeps serving the pinned v1.0.0
  // links for ever.
  var REPO = "MiguelCarino/Carino-DICOM";
  var RELEASES = "https://github.com/" + REPO + "/releases";

  // Pinned v1.1.0 assets — the default links, and the only ones a reader with
  // no JS, no network or a rate-limited API ever sees. They are transcribed from
  // the `expect` manifests in .github/workflows/desktop-build.yml rather than
  // guessed, which is why they do not all look alike: only the nsis target
  // carries an artifactName override in desktop/package.json, so the dmg and the
  // AppImage take electron-builder's default naming, and that default omits the
  // arch token from the x64 build. That override spells the Windows name with
  // hyphens rather than the spaces electron-builder's own default would use,
  // precisely so this line can be transcribed: GitHub rewrites every space in an
  // uploaded asset to a dot, so a spaced name is one thing on the build machine
  // and another in the URL, and the only way to get it right here would be to
  // read it back off a release that does not exist yet.
  // Read all three off the real release the day the tag is cut. A 404 here is
  // invisible in ordinary use — the fetch below repairs it for everyone whose
  // browser can reach api.github.com — and that is exactly what makes it worth
  // checking by hand.
  // macOS ships two builds and this line holds one. arm64 is the pin because it
  // is what every Mac sold since 2020 is; the note under the buttons names the
  // Intel build, and the fetch below turns that chip into two links.
  var PINNED_TAG = "v1.1.0";
  var PINNED = {
    windows: RELEASES + "/download/v1.1.0/Carino-DICOM-Setup-1.1.0-x64.exe",
    macos: RELEASES + "/download/v1.1.0/Carino-DICOM-1.1.0-arm64.dmg",
    linux: RELEASES + "/download/v1.1.0/Carino-DICOM-1.1.0.AppImage",
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
    // Android first, and read off the FULL user-agent rather than off s. A phone
    // answers to every Linux test below — navigator.platform on Firefox for
    // Android is literally "Linux aarch64" — so it used to be handed the desktop
    // Linux chip, marked as the recommended download. Now that arm64 AppImages
    // ship too it would be handed an arm64 one, which looks even more like the
    // right answer and is just as unrunnable. There is no Android build, so the
    // honest result is no recommendation at all: the three chips stay as they
    // are and none is singled out.
    if (/android/i.test(navigator.userAgent || "") || s.indexOf("android") >= 0) return null;
    if (s.indexOf("win") >= 0) return "windows";
    if (s.indexOf("mac") >= 0 || s.indexOf("darwin") >= 0 || s.indexOf("iphone") >= 0 || s.indexOf("ipad") >= 0) return "macos";
    if (s.indexOf("linux") >= 0 || s.indexOf("x11") >= 0) return "linux";
    return null;
  }

  var os = detectOS();
  if (os && cards[os]) cards[os].classList.add("recommended");

  // ---- reading an asset name ----------------------------------------------
  // An asset name has to answer two questions now, not one: which OS, and which
  // architecture. The second is new at 1.1.0, when the desktop matrix started
  // building x64 and arm64 as separate runners for macOS and Linux, and it is
  // why an extension-only match had to go: two dmgs in one release are the same
  // asset to a matcher that reads only the suffix, and whichever one the API
  // happened to list last silently won.
  function matchOS(name) {
    var n = name.toLowerCase();
    if (n.slice(-4) === ".exe") return "windows";
    if (n.slice(-4) === ".dmg") return "macos";
    if (n.slice(-9) === ".appimage") return "linux";
    // Release zips are named <product>-<runner>-v<version>.zip, and the
    // product half changed at the rename, so match on the runner half. Only
    // 1.0.0 shipped installers in that shape; the macOS zip the current build
    // still produces is named with "-mac" rather than "macos", so it does not
    // land here and cannot displace the dmg.
    if (n.slice(-4) === ".zip") {
      if (n.indexOf("windows") >= 0) return "windows";
      if (n.indexOf("macos") >= 0 || n.indexOf("darwin") >= 0) return "macos";
      if (n.indexOf("linux") >= 0 || n.indexOf("ubuntu") >= 0) return "linux";
    }
    return null;
  }

  // Each architecture is a SET of spellings, not one string, and no amount of
  // tidying in desktop/package.json makes it one: electron-builder expands
  // ${arch} in the artifactName and THEN respells the token to whatever the
  // package format calls it — x64 becomes x86_64 in an AppImage and amd64 in a
  // .deb, arm64 becomes aarch64 in an .rpm. Matching a single spelling is how a
  // picker passes on the machine it was written on and quietly offers nothing
  // at all to Linux.
  // null is a real answer rather than a failure: every release before 1.1.0
  // carries no arch token, and an asset whose architecture the filename does not
  // state is offered under its format alone rather than under a claim.
  var ARCHES = [
    { id: "x64", re: /(^|[-_.])(x64|x86[-_]?64|amd64)($|[-_.])/ },
    { id: "arm64", re: /(^|[-_.])(arm64|aarch64)($|[-_.])/ },
  ];
  function matchArch(name) {
    var n = name.toLowerCase();
    for (var i = 0; i < ARCHES.length; i++) if (ARCHES[i].re.test(n)) return ARCHES[i].id;
    return null;
  }

  // Machine names, deliberately untranslated. "Apple Silicon", "Intel", "ARM64"
  // and "x86-64" stay in Latin script in all five languages this page speaks —
  // the same call the version number gets, and the reason this whole change adds
  // no dictionary key. docs/tests/check-i18n.js fails the CI lint gate on an
  // orphan key and on a runtime string missing from its hand-kept RUNTIME_KEYS
  // list, so a translated arch name would be a build change as well as a
  // translation one.
  function archLabel(k, arch) {
    if (!arch) return null;
    if (k === "macos") return arch === "arm64" ? "Apple Silicon" : "Intel";
    return arch === "arm64" ? "ARM64" : "x86-64";
  }

  // Where a guess is safe it is made, and where it is not it is refused.
  // Linux states it outright — navigator.platform is "Linux x86_64" or
  // "Linux aarch64" — so reading it is not a guess. Windows on ARM runs an x64
  // installer under emulation, so x64 is the answer that always works and being
  // wrong costs speed rather than function. macOS has no honest answer at all:
  // the browser can only report ITS OWN architecture, and a universal Chrome
  // under Rosetta answers x86 on an Apple Silicon machine — confidently wrong in
  // the one direction that matters, because an Intel build on Apple Silicon is
  // merely slower while an arm64 build on an Intel Mac does not launch. So a Mac
  // gets no default: both builds are named and the reader picks.
  function guessArch(k) {
    if (k === "windows") return "x64";
    if (k === "linux") {
      var s = (navigator.platform || navigator.userAgent || "").toLowerCase();
      if (s.indexOf("aarch64") >= 0 || s.indexOf("arm64") >= 0) return "arm64";
      if (s.indexOf("x86_64") >= 0 || s.indexOf("x86-64") >= 0 || s.indexOf("amd64") >= 0) return "x64";
    }
    return null;
  }

  // Order, which on macOS is presentation and nothing more. Apple Silicon leads
  // there because it is the majority and because Apple's own download pages lead
  // with it, not because this page knows anything: both are named, and the Intel
  // link is a sibling rather than a fallback.
  function archOrder(k) {
    var want = guessArch(k);
    if (want) return [want, want === "x64" ? "arm64" : "x64"];
    return ["arm64", "x64"];
  }

  function extOf(name) {
    var i = name.lastIndexOf(".");
    return i > 0 ? name.slice(i) : name;
  }

  // One asset renders exactly what it rendered before this change: the chip is
  // the link, and the format slot says what you are getting. The arch joins that
  // slot when the filename states one, because a release that built only arm64
  // must not look like a release that runs anywhere.
  function setOne(btn, k, a) {
    btn.href = a.url;
    btn.title = a.name;
    var slot = btn.querySelector(".fmt");
    if (!slot) return;
    var label = archLabel(k, a.arch);
    slot.textContent = label ? extOf(a.name) + " · " + label : extOf(a.name);
  }

  // Two builds for one OS means two links, and HTML has no such thing as a link
  // inside a link: the chip stops being an <a> and becomes a plain box whose
  // format slot carries one anchor per architecture. Everything else is MOVED
  // across rather than rebuilt, so the emoji, the OS name and the translated
  // "recommended" badge survive untouched — this file has no business owning
  // strings that i18n.js owns, and a rebuilt chip is how it would end up doing
  // exactly that.
  function setSplit(btn, k, list) {
    var box = document.createElement("div");
    box.className = btn.className;
    box.setAttribute("data-os", k);
    while (btn.firstChild) box.appendChild(btn.firstChild);
    var slot = box.querySelector(".fmt");
    if (!slot) {
      slot = document.createElement("span");
      slot.className = "fmt";
      box.appendChild(slot);
    }
    slot.textContent = "";
    list.forEach(function (a, i) {
      // Names and URLs arrive over the network: textContent and createElement
      // throughout, never innerHTML, even though we own the repository.
      if (i) slot.appendChild(document.createTextNode(" · "));
      var link = document.createElement("a");
      link.href = a.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.title = a.name;
      link.textContent = archLabel(k, a.arch) || extOf(a.name);
      slot.appendChild(link);
    });
    btn.parentNode.replaceChild(box, btn);
    cards[k] = box;
  }

  function setDownload(k, list) {
    var btn = cards[k];
    if (!btn) return;
    if (list.length === 1) setOne(btn, k, list[0]);
    else setSplit(btn, k, list);
  }

  // The fetch worked and this release simply carries nothing for this OS.
  // Leaving the pinned URL is worse than a dead link: the version line above has
  // already been rewritten to the new tag, so the page would hand over an older
  // installer under a number that says otherwise. A listing is honest; a stale
  // pin under a fresh label is not. The format slot loses its claim with it —
  // this chip no longer knows what it is handing you.
  function setListing(k) {
    var btn = cards[k];
    if (!btn) return;
    btn.href = RELEASES;
    btn.removeAttribute("title");
    var slot = btn.querySelector(".fmt");
    if (slot) slot.textContent = "GitHub →";
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
      // Built rather than interpolated. shownTag is rel.tag_name straight off
      // api.github.com, and a git ref name may legally contain < and >, so the
      // obvious innerHTML concatenation would put a remote string into a markup
      // position. Nobody but the repository owner can create a tag here, which
      // is why this was never urgent — but "the only person who can attack this
      // is me" is an argument that stops holding the moment the repo gains a
      // second maintainer, and the DOM version costs three lines.
      var strong = document.createElement('strong');
      strong.textContent = String(shownTag).replace(/^v/, '');
      vEl.textContent = tt('Version') + ' ';
      vEl.appendChild(strong);
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
      // Collected per OS first, then rendered, because a chip cannot decide
      // whether it is one link or two until every asset has been read. Assets
      // are ranked while they are collected: an installer beats a zip for the
      // same OS and architecture, so a mac zip that ever starts looking like a
      // dmg to matchOS still cannot take the dmg's place.
      var byOS = {};
      (rel.assets || []).forEach(function (a) {
        // `a` itself is checked, not just its fields. This loop is inside a
        // .then, so a TypeError on a null entry is caught by the outer .catch
        // and looks exactly like being offline: every button silently keeps its
        // pinned URL and the version line keeps the pinned tag. One malformed
        // entry would therefore discard the whole live release, and nothing on
        // the page would say so. The editor's card guards this the same way.
        if (!a || typeof a.name !== "string" || typeof a.browser_download_url !== "string") return;
        var k = matchOS(a.name);
        if (!k) return;
        var arch = matchArch(a.name);
        var rank = a.name.toLowerCase().slice(-4) === ".zip" ? 1 : 0;
        var list = byOS[k] || (byOS[k] = []);
        var seen = null;
        list.forEach(function (e) { if (e.arch === arch) seen = e; });
        if (seen) {
          if (rank < seen.rank) { seen.name = a.name; seen.url = a.browser_download_url; seen.rank = rank; }
          return;
        }
        list.push({ name: a.name, url: a.browser_download_url, arch: arch, rank: rank });
      });

      // The token the filename does not carry. electron-builder's DEFAULT
      // artifactName omits the arch from the DEFAULT arch, which is x64, and
      // only a hand-written pattern turns that stripping off — so a two-arch
      // release names the arm64 build and leaves the x64 one looking exactly
      // like a release from before any of this mattered. Inside one OS the
      // ambiguity resolves itself: if a sibling in the SAME release carries a
      // token, the untokened one is the default arch by construction, and the
      // default arch is x64. With no token anywhere in that OS's list there is
      // nothing to reason from and the architecture stays unknown, which is the
      // honest answer for every release before 1.1.0.
      // This is here rather than in matchArch because it is a fact about a
      // release read as a whole, not about a filename read on its own.
      Object.keys(byOS).forEach(function (k) {
        var list = byOS[k];
        var blanks = list.filter(function (e) { return !e.arch; });
        if (list.length < 2 || blanks.length !== 1 || blanks.length === list.length) return;
        if (list.some(function (e) { return e.arch === "x64"; })) return;
        blanks[0].arch = "x64";
      });

      // A release with no installers at all leaves everything alone: the pins
      // are a known-good older build, and that beats three chips pointing at a
      // listing under a version number nothing on this page can honour.
      var served = Object.keys(byOS);
      if (!served.length) { showVersion(PINNED_TAG); return; }

      Object.keys(cards).forEach(function (k) {
        var list = byOS[k];
        if (!list || !list.length) { setListing(k); return; }
        var order = archOrder(k);
        list.sort(function (a, b) {
          var ai = order.indexOf(a.arch), bi = order.indexOf(b.arch);
          return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi);
        });
        setDownload(k, list);
      });
      showVersion(rel.tag_name);
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
