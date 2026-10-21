"use strict";
/* Pure helpers for turning the engine's web.host into (a) what the engine is
   told to bind and (b) the URL this shell's window loads. Kept apart from
   main.js so they can be tested with plain node (tests/test_review_misc.py).

   Two values, never one: an operator who set web.host 0.0.0.0 (plus a token) to
   reach the dashboard from another PC gets exactly that bind, while the window
   always talks to a loopback address of the same family. */

// The window's host: loopback for a wildcard or empty bind, otherwise the
// configured address, trimmed the way pacs/config.py web_host_of() trims it.
function windowHostFor(host) {
  const h = String(host == null ? "" : host).trim();
  if (h === "" || h === "0.0.0.0") return "127.0.0.1";
  if (h === "::" || h === "[::]") return "::1";
  return h.replace(/^\[(.*)\]$/, "$1");
}

// What the engine binds: whatever the config says. Empty means "let the
// engine read it from the config" — no --host argument at all.
function bindHostFor(host) {
  return String(host == null ? "" : host).trim();
}

// A URL that new URL() accepts: IPv6 literals in brackets.
function serverUrlFor(scheme, host, port) {
  const h = windowHostFor(host);
  const shown = h.includes(":") ? `[${h}]` : h;
  const url = `${scheme}://${shown}:${Number(port) || 8042}/`;
  new URL(url);           // throws for anything still unusable; the caller handles it
  return url;
}

// expanduser semantics as Python's os.path.expanduser: "~", "~/x" and
// "~user/x" (approximated as a sibling of this user's home directory).
function expandUser(p, homedir, path) {
  const s = String(p);
  if (!s.startsWith("~")) return s;
  const m = /^~([^\\/]*)(.*)$/.exec(s);
  if (!m) return s;
  const user = m[1];
  const rest = m[2];
  if (!user) return homedir + rest;
  return path.join(path.dirname(homedir), user) + rest;
}

module.exports = { windowHostFor, bindHostFor, serverUrlFor, expandUser };
