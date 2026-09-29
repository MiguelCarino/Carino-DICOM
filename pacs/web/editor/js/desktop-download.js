// Desktop-app download offer (public site only) and desktop-shell update notice.

  // ---- Download offer ----
  // Security: this file is also served by Carino DICOM appliances (/editor/) and inside the
  // desktop app (app://). The exact-hostname guard keeps the api.github.com request unreachable
  // from a clinical network by construction; on GitHub Pages GitHub already saw the visit.
  // Fetched rather than hardcoded so the card stays hidden until a release exists.
  (function () {
    if (location.hostname !== 'dcm.carino.systems') return;

    const T = (k) => (window.t || String)(k);
    const card = document.getElementById('ovGet');
    const primary = document.getElementById('ovGetLink');
    const meta = document.getElementById('ovGetMeta');
    const others = document.getElementById('ovGetOthers');
    if (!card || !primary || !meta || !others) return;

    // Android is tested separately below (its UA contains 'linux'). `owns` only says whether an
    // asset is for this OS; architecture is resolved separately since a release has several builds.
    const PLATFORMS = [
      { id: 'macos', name: 'macOS', is: (s) => s.indexOf('mac') >= 0 || s.indexOf('darwin') >= 0, owns: (n) => n.endsWith('.dmg') },
      { id: 'windows', name: 'Windows', is: (s) => s.indexOf('win') >= 0, owns: (n) => n.endsWith('.exe') },
      { id: 'linux', name: 'Linux', is: (s) => s.indexOf('linux') >= 0 || s.indexOf('x11') >= 0, owns: (n) => n.endsWith('.appimage') },
    ];
    const ua = ((navigator.userAgentData && navigator.userAgentData.platform) ||
                navigator.platform || navigator.userAgent || '').toLowerCase();
    // Android is read off the full userAgent: Firefox for Android reports platform "Linux aarch64"
    // and has no userAgentData, so testing `ua` alone would offer it a desktop AppImage.
    const isAndroid = /android/i.test(navigator.userAgent || '') || ua.indexOf('android') >= 0;
    const mine = isAndroid ? null : PLATFORMS.find((p) => p.is(ua)) || null;

    // Each arch is a set of spellings: electron-builder respells ${arch} per package format
    // (x64 -> x86_64 in AppImage, amd64 in .deb; arm64 -> aarch64 in .rpm). 'universal' is not
    // built today but would be the right asset for every Mac, so it ranks first if it appears.
    const ARCHS = [
      { id: 'universal', name: 'Universal', re: /(^|[-_.])universal($|[-_.])/ },
      { id: 'arm64', name: 'ARM64', re: /(^|[-_.])(arm64|aarch64)($|[-_.])/ },
      { id: 'x64', name: 'x86-64', re: /(^|[-_.])(x64|x86[-_]?64|amd64)($|[-_.])/ },
    ];
    const archOf = (n) => ARCHS.find((a) => a.re.test(n)) || null;

    // Machine names stay untranslated in all locales, like the version number.
    const archName = (p, a) => !a ? null
      : a.id === 'universal' ? a.name
      : p.id === 'macos' ? (a.id === 'arm64' ? 'Apple Silicon' : 'Intel')
      : a.name;

    // Read navigator.platform directly, not `ua`: userAgentData.platform never carries an arch.
    // Windows on ARM runs the x64 installer, so x64 is safe there. Macs get no guess: Chrome under
    // Rosetta reports x86 on Apple Silicon, and an arm64 build won't launch on Intel.
    const uaArch = (navigator.platform || navigator.userAgent || '').toLowerCase();
    const preferred = (p) => p.id === 'windows' ? 'x64'
      : p.id === 'linux' ? (/aarch64|arm64/.test(uaArch) ? 'arm64' : /x86_64|amd64/.test(uaArch) ? 'x64' : null)
      : null;

    const RELEASES = 'https://github.com/MiguelCarino/Carino-DICOM-Editor/releases/latest';
    const mb = (n) => Math.round(Number(n) / 1048576) + ' MB';

    fetch('https://api.github.com/repos/MiguelCarino/Carino-DICOM-Editor/releases/latest',
          { credentials: 'omit', headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((rel) => {
        if (!rel || !rel.tag_name) return;            // no release yet — stay hidden
        const assets = Array.isArray(rel.assets) ? rel.assets : [];

        // Ranked list per platform (the button shows the head): universal, then the reader's own
        // arch, then the platform's majority build (arm64 on Mac, x64 elsewhere). All are listed.
        const lead = (p) => p.id === 'macos' ? 'arm64' : 'x64';
        const rank = (p, e) => !e.arch ? 4
          : e.arch.id === 'universal' ? 0
          : e.arch.id === preferred(p) ? 1
          : e.arch.id === lead(p) ? 2 : 3;
        const assetsFor = (p) => {
          const list = assets
            .filter((a) => a && typeof a.name === 'string' &&
                    typeof a.browser_download_url === 'string' && p.owns(a.name.toLowerCase()))
            .map((a) => ({ asset: a, arch: archOf(a.name.toLowerCase()) }));
          // electron-builder's default artifactName omits the arch for x64, so a lone untokened
          // asset beside tokened siblings is the x64 build. With no tokens at all it stays unknown.
          const blanks = list.filter((e) => !e.arch);
          if (list.length > 1 && blanks.length === 1 && !list.some((e) => e.arch && e.arch.id === 'x64')) {
            blanks[0].arch = ARCHS.find((a) => a.id === 'x64');
          }
          return list.sort((x, y) => rank(p, x) - rank(p, y));
        };

        // Undetected platform gets the plain list; a platform with no installer links the releases page.
        const hits = mine ? assetsFor(mine) : [];
        const hit = hits[0] || null;
        primary.textContent = mine ? T('Download for {os}').replace('{os}', mine.name) : T('All downloads');
        primary.href = hit ? hit.asset.browser_download_url : RELEASES;

        // Version and arch are data (not translated); size matters on metered connections. Naming
        // the arch here tells the reader to check the sibling build below.
        const version = String(rel.tag_name).replace(/^v/, '');
        const line = [version];
        const an = hit ? archName(mine, hit.arch) : null;
        if (an) line.push(an);
        if (hit) line.push(mb(hit.asset.size));
        meta.textContent = line.join(' · ');

        // Security: names and URLs come from the network, so textContent/createElement only, never innerHTML.
        others.textContent = '';
        const add = (text, url, title) => {
          const a = document.createElement('a');
          a.textContent = text;
          a.href = url;
          a.target = '_blank'; a.rel = 'noopener';
          if (title) a.title = title;
          others.appendChild(a);
        };
        // The other architecture for this OS comes first: a wrong arch guess is the only failure
        // that yields an app that will not start.
        hits.slice(1).forEach((e) => {
          const n = archName(mine, e.arch) || mine.name;
          add(n, e.asset.browser_download_url, mine.name + ' · ' + n + ' · ' + mb(e.asset.size));
        });
        PLATFORMS.filter((p) => !mine || p.id !== mine.id).forEach((p) => {
          const own = assetsFor(p);
          if (!own.length) { add(p.name, RELEASES, null); return; }
          // Another OS with several builds lists each; we cannot detect a machine we are not running on.
          own.forEach((e) => {
            const n = own.length > 1 ? archName(p, e.arch) : null;
            const label = n ? p.name + ' ' + n : p.name;
            add(label, e.asset.browser_download_url, label + ' · ' + mb(e.asset.size));
          });
        });
        const all = document.createElement('a');
        all.textContent = T('All downloads');
        all.href = RELEASES; all.target = '_blank'; all.rel = 'noopener';
        others.appendChild(all);

        card.hidden = false;
        card.classList.remove('hidden');
      })
      .catch(() => { /* offline, rate-limited, blocked — the offer is not made */ });
  })();

  // ---- Desktop update notice ----
  // window.carinoDesktop exists only under the Electron preload, so on the web and in the PACS
  // bundle this returns immediately. The update check itself runs in the main process.
  (function () {
    const desk = window.carinoDesktop;
    if (!desk) return;
    const el = document.getElementById('deskUpdate');
    if (!el) return;
    const reveal = (u) => {
      if (!u || !u.version) return;
      // Version stays in the title, not on the pill, so locale widths are unaffected.
      el.title = 'Carino DICOM Editor ' + u.version;
      el.href = u.url;
      el.hidden = false;
      el.classList.remove('hidden');
    };
    // openReleasePage is the sanctioned way out of app://; href keeps link semantics.
    el.addEventListener('click', (e) => { e.preventDefault(); desk.openReleasePage(); });
    // The update may already be known or arrive later; handle both (revealing twice is harmless).
    reveal(desk.getUpdate());
    desk.onUpdate(reveal);
  })();
