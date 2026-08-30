/* ============================================================
   Carino DICOM desktop — the renderer bridge.
   ------------------------------------------------------------
   The dashboard this shell displays is the very same page any browser gets
   from 127.0.0.1, and it has to keep working there, so nothing below may be
   something the page depends on. It publishes one fact the shell knows and a
   served page cannot — whether a newer release of the app exists — plus the
   single action that fact needs. app.js feature-detects window.carinoDesktop
   and, finding nothing, draws exactly what it drew before.

   Deliberately NOT exposed: ipcRenderer itself, require, anything from node,
   anything that touches the filesystem, and any channel the page could name.
   contextIsolation stays on and this is the entire surface, so a dashboard
   that is somehow XSS'd gains a version string and a link to github.com.
   ============================================================ */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/* The bundled editor opens in a child window created through the main window's
   setWindowOpenHandler, and such a window inherits the embedder's
   webPreferences — this preload among them, depending on how Electron merges
   the override the handler supplies. The editor is a separate product with its
   own version and its own releases, so publishing the PACS's update state into
   it would print a wrong notice in the wrong app, and print it silently.
   main.js writes that child's preload out explicitly; this is the half of the
   guard that does not depend on merge semantics holding. */
const isEditor = /^\/editor(\/|$)/.test(location.pathname);

// main.js passes this as a command-line switch precisely so the bridge can
// answer without an IPC round trip: the renderer wants it while it is drawing.
const APP_VERSION = (() => {
  // Defensively, because process.argv in a SANDBOXED preload is a polyfill
  // rather than the real Node one and how much of it survives has moved between
  // Electron majors. An unguarded .find() on a non-array throws at preload load
  // time, which does not fail loudly — it means contextBridge never runs, the
  // whole bridge is absent, and the update notice silently stops existing.
  const flag = "--carino-app-version=";
  try {
    const argv = Array.isArray(process.argv) ? process.argv : [];
    const arg = argv.find((a) => typeof a === "string" && a.startsWith(flag));
    if (arg) return arg.slice(flag.length);
  } catch (e) { /* fall through to empty */ }
  return "";
})();

let update = null;               // { version } once the shell has found one
const listeners = [];

/* The shell announces on every page load as well as on every discovery, so
   this channel is the only source of truth and a reload cannot leave the page
   holding a stale one. */
ipcRenderer.on("carino:update", (_e, u) => {
  update = u && u.version ? { version: String(u.version) } : null;
  listeners.forEach((fn) => { try { fn(update); } catch (e) { /* one bad listener must not stop the rest */ } });
});

if (!isEditor) {
  contextBridge.exposeInMainWorld("carinoDesktop", {
    appVersion: APP_VERSION,
    // A fresh object each call: the page must not end up holding a reference it
    // can mutate into this module's own state.
    getUpdate: () => (update ? { version: update.version } : null),
    onUpdate: (cb) => { if (typeof cb === "function") listeners.push(cb); },
    openReleasePage: () => ipcRenderer.send("carino:open-release-page"),
  });
}
