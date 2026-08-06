/* Dictionary parity for the dashboard.  node pacs/web/tests/i18n-parity.mjs
 *
 * English source strings ARE the keys, so a missing entry does not crash — it
 * silently renders English in the middle of a Japanese screen, and nobody
 * notices until an operator does. There is no build step to catch that, so this
 * is the check: every key used by index.html or app.js must be translated in
 * ALL FOUR locales or in none of them (a protocol identifier like 'Print SCP'
 * is deliberately left alone in every language — half a set is the bug).
 *
 * It runs in BOTH directions, because the failure that hurts is silent in the
 * forward one. Edit an English literal in app.js and the old key is still in
 * all four dictionaries — perfect parity, nothing half-translated — while the
 * new literal is in none of them, which the "all or nothing" rule reads as a
 * deliberate protocol identifier. Four languages regress and the guard reports
 * green. So the dictionaries are also checked back against the source: an entry
 * nobody can reach any more is reported as an orphan, and a used string with no
 * entry anywhere has to be named in UNTRANSLATED below to be allowed.
 *
 * It parses the source rather than executing it: only the source knows whether
 * a key is absent or present-and-identical, and only the source can show a key
 * that was pasted twice into one block, where the second copy silently wins.
 *
 * Pass a directory as argv[2] to check a copy of pacs/web/ instead of the real
 * one — that is how you prove the guard still fails on a break without editing
 * files the checkout needs to keep working. */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const WEB = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(WEB, f), "utf8");
const I18N_SRC = read("i18n.js");
const LOCALES = ["es", "'pt-BR'", "ja", "ru"];
const PLURAL_LOCALES = ["en", "es", "'pt-BR'", "ja", "ru"];

/* Strings the UI uses that deliberately carry NO entry in any locale block.
 * They are protocol identifiers a technologist matches character-for-character
 * against the modality's config, so t() falls through to the English literal
 * everywhere (see the i18n.js header).
 *
 * They have to be enumerated here rather than inferred, because absence from
 * every dictionary is exactly what a freshly added and not-yet-translated
 * string looks like — the two are indistinguishable to the parser, and the one
 * that must not pass quietly is the second. An entry present in all four
 * locales with the value identical to the key means the same thing and needs no
 * line here: writing it out four times IS the declaration. */
const UNTRANSLATED = new Set([
  "DICOMweb",
  "MWL SCP",
  "Print SCP",
  "Q/R SCP",
  "mTLS",
  "{moves} C-MOVE · {gets} C-GET",
  "→ SC",
]);

let failures = 0;
const fail = (msg) => { failures += 1; console.log("  FAIL  " + msg); };
const pass = (msg) => console.log("  ok    " + msg);

/* A dictionary block is `    <name>: {` at four spaces of indent, closed by
   `\n    },` — the same shape every block in the file has. */
function blockBody(src, name, from = 0) {
  const head = "\n    " + name + ": {";
  const start = src.indexOf(head, from);
  if (start < 0) throw new Error("no '" + name + "' block");
  const end = src.indexOf("\n    },", start);
  if (end < 0) throw new Error("unterminated '" + name + "' block");
  return src.slice(start + head.length, end);
}

// Keys are the only quoted strings that start a line and are followed by ':'.
function keysOf(body) {
  const out = [];
  const re = /^\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*:/gm;
  let m;
  while ((m = re.exec(body))) out.push(unquote(m[1]));
  return out;
}

/* key → value, for the identity check only. A value this does not match (an
   array, a concatenation) is simply absent from the map, which reads as "a real
   translation" — the direction that cannot invent a failure. */
function entriesOf(body) {
  const out = new Map();
  const re = /^\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,?/gm;
  let m;
  while ((m = re.exec(body))) out.set(unquote(m[1]), unquote(m[2]));
  return out;
}

function unquote(q) {
  const inner = q.slice(1, -1);
  const json = q[0] === "'" ? inner.replace(/\\'/g, "'").replace(/"/g, '\\"') : inner;
  return JSON.parse('"' + json + '"');
}

/* ---- 1. locale blocks are at exact parity ---------------------------- */
const dicts = {};
const values = {};
for (const name of LOCALES) {
  const body = blockBody(I18N_SRC, name);
  const keys = keysOf(body);
  const seen = new Set();
  const dupes = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
  if (dupes.length) fail(name + " has duplicate keys (the later one wins silently): " + JSON.stringify(dupes.slice(0, 5)));
  dicts[name] = seen;
  values[name] = entriesOf(body);
}
const base = LOCALES[0];
for (const name of LOCALES.slice(1)) {
  const missing = [...dicts[base]].filter((k) => !dicts[name].has(k));
  const extra = [...dicts[name]].filter((k) => !dicts[base].has(k));
  if (missing.length) fail(name + " is missing " + missing.length + " key(s) that " + base + " has: " + JSON.stringify(missing.slice(0, 5)));
  if (extra.length) fail(name + " has " + extra.length + " key(s) " + base + " does not: " + JSON.stringify(extra.slice(0, 5)));
}
if (!failures) pass("four locales at exact parity — " + dicts[base].size + " keys each");

/* ---- 2. plural blocks, and the form count each language needs -------- */
const PLURAL_FORMS = { ja: 1, ru: 3 };            // see RULE in i18n.js
const plurals = {};
const plStart = I18N_SRC.indexOf("const PLURALS = {");
for (const name of PLURAL_LOCALES) {
  const body = blockBody(I18N_SRC, name, plStart);
  plurals[name] = new Set(keysOf(body));
  const want = PLURAL_FORMS[name.replace(/'/g, "")] || 2;
  const re = /^\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*:\s*\[([^\]]*)\]/gm;
  let m;
  while ((m = re.exec(body))) {
    const n = (m[1].match(/(?:^|,)\s*['"]/g) || []).length;
    if (n !== want) fail("PLURALS." + name + " has a " + n + "-form entry where " + want + " are needed: " + m[0].slice(0, 60));
  }
}
for (const name of PLURAL_LOCALES.slice(1)) {
  const missing = [...plurals.en].filter((k) => !plurals[name].has(k));
  if (missing.length) fail("PLURALS." + name + " is missing " + JSON.stringify(missing));
}
pass("plural tables carry every counted string, with the right number of forms");

/* ---- 3. every key the UI actually uses is translated (or none is) ---- */
const used = new Set();

// index.html: the four data-i18n-* attribute forms, keyed exactly the way
// applyI18nIn() keys them (textContent for data-i18n, collapsed innerHTML for
// data-i18n-html, the pre-filled attribute value for the other three).
const html = read("index.html");
const tagRe = /<([a-zA-Z0-9]+)([^>]*?)>/g;
let m;
while ((m = tagRe.exec(html))) {
  const [, tag, attrs] = m;
  if (!/data-i18n/.test(attrs)) continue;
  const close = html.indexOf("</" + tag + ">", tagRe.lastIndex);
  if (/\bdata-i18n(?![-\w])/.test(attrs)) used.add(html.slice(tagRe.lastIndex, close).trim());
  if (/\bdata-i18n-html\b/.test(attrs)) used.add(html.slice(tagRe.lastIndex, close).trim().replace(/\s+/g, " "));
  let a;
  if (/data-i18n-title/.test(attrs) && (a = attrs.match(/\btitle="([^"]*)"/))) used.add(a[1].replace(/&amp;/g, "&"));
  if (/data-i18n-placeholder/.test(attrs) && (a = attrs.match(/\bplaceholder="([^"]*)"/))) used.add(a[1].replace(/&amp;/g, "&"));
  if (/data-i18n-aria-label/.test(attrs) && (a = attrs.match(/\baria-label="([^"]*)"/))) used.add(a[1]);
}

// app.js: T("…") and TF("…", …) literals, plus TN(n, "…") against PLURALS.
const app = read("app.js");
const litRe = /\b(?:T|TF)\(\s*("(?:[^"\\]|\\.)*")/g;
while ((m = litRe.exec(app))) used.add(JSON.parse(m[1]));
const tnRe = /\bTN\(\s*[^,]+?,\s*("(?:[^"\\]|\\.)*")\s*\)/g;
const counted = new Set();
while ((m = tnRe.exec(app))) counted.add(JSON.parse(m[1]));

const partial = [];
for (const key of used) {
  if (!key) continue;
  const have = LOCALES.filter((n) => dicts[n].has(key));
  if (have.length && have.length < LOCALES.length) {
    partial.push(key + "  (only in " + have.join(", ") + ")");
  }
}
if (partial.length) partial.forEach((p) => fail("half-translated: " + p));
else pass(used.size + " keys used by the markup and app.js, none half-translated");

/* A used string with no entry in any locale renders English everywhere. That is
   right for a protocol identifier and wrong for anything else, and only the
   list above can tell them apart. */
const nowhere = [...used].filter((k) => k && !dicts[base].has(k));
const undeclared = nowhere.filter((k) => !UNTRANSLATED.has(k));
if (undeclared.length) {
  undeclared.forEach((k) => fail("no locale has an entry for " + JSON.stringify(k)
    + " — translate it in all four, or add it to UNTRANSLATED if it is a protocol identifier"));
} else {
  pass(nowhere.length + " used string(s) deliberately identical in every language, all declared in UNTRANSLATED");
}
/* A stale exception is the same hole reopened: it stops guarding the string it
   names and nothing says so. */
for (const k of UNTRANSLATED) {
  if (dicts[base].has(k)) fail("UNTRANSLATED lists " + JSON.stringify(k) + " but the locale blocks now translate it — drop the exception");
  else if (!used.has(k)) fail("UNTRANSLATED lists " + JSON.stringify(k) + " but nothing uses it any more — drop the exception");
}

/* ---- 4. and nothing is translated that the UI can no longer reach ---- */
/* The other direction. Renaming an English literal leaves its four translations
   behind, addressed by a key nothing asks for: the dictionaries stay at parity,
   the new literal reads as untranslated-on-purpose, and four languages quietly
   fall back to English. An orphan is the only visible trace of that edit.
 *
 * `used` is too narrow to judge it: app.js also calls T() on values it looked up
 * (T(svc.label), T(wx.on_success)), and carino-navbar.js calls window.t() on the
 * greeting it picked, so those keys are real but never appear inside a T("…").
 * What every one of them does have is the English string sitting somewhere in
 * the source as a quoted literal, so that is the test. A key that survives only
 * inside a comment reads as still used — the cost of not writing a JavaScript
 * parser here, and the harmless direction to be wrong in: a guard that cries
 * wolf over every dynamic key is a guard somebody switches off. */
const JS_SRC = app + "\n" + read("carino-navbar.js");
function mentioned(key) {
  for (const q of ["\"", "'", "`"]) {
    const lit = q + key.replace(/\\/g, "\\\\").split(q).join("\\" + q) + q;
    if (JS_SRC.includes(lit)) return true;
  }
  // The markup forms applyI18nIn() reads: element text, and attribute values
  // (where & is written as an entity).
  if (html.includes(">" + key + "<")) return true;
  const attr = key.replace(/&/g, "&amp;");
  return html.includes('="' + attr + '"') || html.includes("='" + attr + "'");
}

const orphans = [...dicts[base]].filter((k) => !used.has(k) && !mentioned(k));
if (orphans.length) {
  orphans.forEach((k) => fail("orphaned: " + JSON.stringify(k) + " is translated in all four locales but "
    + "no longer appears in index.html or app.js — the English literal was renamed or removed, "
    + "so those four translations are now unreachable"));
} else {
  pass("no orphaned entries — every translated key is still reachable from the source");
}

const plOrphans = [...plurals.en].filter((k) => !counted.has(k));
if (plOrphans.length) plOrphans.forEach((k) => fail("orphaned plural forms: no TN() uses " + JSON.stringify(k)));
else pass("no orphaned plural entries");

for (const key of counted) {
  const missing = PLURAL_LOCALES.filter((n) => !plurals[n].has(key));
  if (missing.length) fail("TN() uses " + JSON.stringify(key) + " but PLURALS." + missing.join("/") + " has no forms for it");
}
if (counted.size) pass(counted.size + " counted string(s) have plural forms in every language");

/* Kept as a note, not a failure: these are the sanctioned ways to say "leave
   this string alone", and reading the list is how the next person notices one
   that should not be on it. */
const identical = [...dicts[base]].filter((k) => LOCALES.every((n) => values[n].get(k) === k));
console.log("  note  " + nowhere.length + " used string(s) carry no entry at all (UNTRANSLATED), and "
            + identical.length + " are entered identically in all four locales:");
[...nowhere, ...identical].sort().forEach((k) => console.log("          " + JSON.stringify(k)));

console.log(failures ? "\n" + failures + " FAILURE(S)" : "\nAll i18n checks passed.");
process.exit(failures ? 1 : 0);
