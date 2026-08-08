/* Landing-page i18n guard —  node docs/tests/check-i18n.js
 *
 * The page's translation mechanism uses the English source string AS the key,
 * which means a missing translation degrades silently to English: the page
 * still renders, still looks finished, and only a reader of that language ever
 * notices. That failure mode is exactly why this file exists — pt-BR is the
 * locale people forget, and nothing else in the build would catch it.
 *
 * Checks, in order of what they would have caught:
 *   1. every locale carries the same key set (no locale short of the others)
 *   2. every [data-i18n] key in index.html exists in every locale
 *   3. no orphan keys: a locale entry that matches nothing on the page is
 *      either a typo or a leftover, and both are invisible at runtime
 *   4. no [data-i18n] element has child elements — applyStaticI18n() writes
 *      textContent, so a translated element with markup inside would have that
 *      markup destroyed on the first language switch
 *   5. every RICH selector resolves in index.html and carries all four locales
 *   6. the banned `word-break: break-all` appears in no stylesheet under docs/
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DOCS = path.resolve(__dirname, '..');
const LOCALES = ['es', 'pt-BR', 'ja', 'ru'];

// Keys that app.js builds at runtime for the #version line. They never appear
// as [data-i18n] in the markup, so the orphan check has to know about them.
// '#version' starts as plain text and is translated by applyVersionPlaceholder,
// so it carries no data-i18n attribute either.
const RUNTIME_KEYS = ['Version', 'Checking for the latest version…'];
// Greetings belong to the shared navbar (carino-navbar.js), not to this page.
const NAVBAR_KEYS = ['Late shift.', 'Good morning.', 'Good afternoon.', 'Good evening.'];

const failures = [];
function check(ok, msg) { if (!ok) failures.push(msg); }

// ---- load the dictionaries out of i18n.js -------------------------------
// i18n.js is a browser script with no module system; run it against the
// smallest stubs that let its top-level statements execute.
function loadDicts() {
    const src = fs.readFileSync(path.join(DOCS, 'i18n.js'), 'utf8');
    const stub = {
        window: { addEventListener() {}, CarinoLang: null },
        document: { documentElement: {}, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null },
    };
    const fn = new Function('window', 'document', src + '\nreturn { I18N, RICH };');
    return fn(stub.window, stub.document);
}

// ---- pull [data-i18n] keys out of index.html ----------------------------
function decode(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function pageKeys(html) {
    const re = /<([a-z0-9]+)\b[^>]*\sdata-i18n(?:=["'][^"']*["'])?[^>]*>([\s\S]*?)<\/\1>/gi;
    const keys = [];
    let m;
    while ((m = re.exec(html)) !== null) {
        const inner = m[2];
        check(!/<[a-z]/i.test(inner),
            `[data-i18n] element contains markup, which applyStaticI18n() would destroy: ${inner.slice(0, 60)}`);
        keys.push(decode(inner).trim());
    }
    return keys;
}

const { I18N, RICH } = loadDicts();
const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
const used = pageKeys(html);

check(used.length > 0, 'no [data-i18n] elements found in index.html — did the extractor break?');

// 1. locale key parity
const reference = Object.keys(I18N[LOCALES[0]]).sort();
for (const loc of LOCALES) {
    check(I18N[loc] !== undefined, `locale ${loc} is missing from I18N entirely`);
    if (!I18N[loc]) continue;
    const here = Object.keys(I18N[loc]).sort();
    const missing = reference.filter((k) => !(k in I18N[loc]));
    const extra = here.filter((k) => !(k in I18N[LOCALES[0]]));
    check(missing.length === 0, `locale ${loc} is missing ${missing.length} key(s): ${JSON.stringify(missing.slice(0, 5))}`);
    check(extra.length === 0, `locale ${loc} has ${extra.length} key(s) no other locale has: ${JSON.stringify(extra.slice(0, 5))}`);
}

// 2. every key the page uses is translated everywhere
for (const key of used) {
    for (const loc of LOCALES) {
        check(I18N[loc] && key in I18N[loc], `key not translated in ${loc}: ${JSON.stringify(key)}`);
    }
}

// 3. no orphans
const known = new Set([...used, ...RUNTIME_KEYS, ...NAVBAR_KEYS]);
for (const key of Object.keys(I18N[LOCALES[0]])) {
    check(known.has(key), `orphan key in the dictionaries (nothing on the page uses it): ${JSON.stringify(key)}`);
}

// 5. RICH selectors
for (const sel of Object.keys(RICH)) {
    const id = sel.startsWith('#') ? `id="${sel.slice(1)}"` : null;
    const cls = sel.startsWith('.') ? `class="${sel.slice(1)}"` : null;
    check(html.includes(id || cls), `RICH selector ${sel} matches nothing in index.html`);
    for (const loc of LOCALES) {
        check(typeof RICH[sel][loc] === 'string' && RICH[sel][loc].length > 0,
            `RICH ${sel} has no ${loc} translation`);
    }
}

// 6. the banned break
function cssFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return cssFiles(p);
        return e.name.endsWith('.css') ? [p] : [];
    });
}
for (const f of cssFiles(DOCS)) {
    // Comments are stripped first: both stylesheets document the ban by naming
    // the thing they ban, and a policy note must not read as a violation.
    const css = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    check(!/word-break\s*:\s*break-all/.test(css),
        `${path.relative(DOCS, f)} uses the banned word-break: break-all`);
}

// ---- report -------------------------------------------------------------
if (failures.length) {
    console.error(`FAIL — ${failures.length} problem(s):`);
    for (const f of failures) console.error('  • ' + f);
    process.exit(1);
}
console.log(`OK — ${used.length} page keys × ${LOCALES.length} locales, ` +
    `${Object.keys(I18N[LOCALES[0]]).length} dictionary keys, ` +
    `${Object.keys(RICH).length} rich blocks, all at parity.`);
