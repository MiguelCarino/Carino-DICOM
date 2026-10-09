/* electron-builder afterPack hook.
 *
 * Ad-hoc signs the macOS app when there is no real signing identity.
 *
 * Without a "Developer ID Application" certificate electron-builder skips
 * signing altogether, but by then it has already renamed the Electron binary,
 * rewritten Info.plist and copied the engine into Resources — so the signature
 * Electron shipped with no longer matches the bundle. On Apple Silicon that app
 * does not run, and clearing the quarantine attribute does not change it: macOS
 * either calls it "damaged" or kills it at launch. An ad-hoc signature ("-")
 * makes the bundle internally consistent again. It identifies nobody, so the
 * first launch still needs Open Anyway or the xattr command in BUILDING.md, but
 * after that the app runs.
 *
 * With CSC_LINK / CSC_NAME set this does nothing: electron-builder signs with
 * the real identity right after this hook, over the top of anything done here.
 */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MACHO = new Set(["feedfacf", "cffaedfe", "cafebabe", "bebafeca"]);

function isMachO(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(4);
    return fs.readSync(fd, head, 0, 4, 0) === 4 && MACHO.has(head.toString("hex"));
  } finally {
    fs.closeSync(fd);
  }
}

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(p);
    else if (entry.isFile()) yield p;
  }
}

const sign = (target) => execFileSync("codesign", ["--force", "--sign", "-", target], { stdio: "inherit" });

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  // The PyInstaller engine sits in Resources, where `codesign --deep` does not
  // look for code. Sign each of its binaries first, so the child process the
  // app spawns carries a valid signature of its own.
  const engine = path.join(app, "Contents", "Resources", "engine");
  let n = 0;
  if (fs.existsSync(engine)) {
    for (const f of files(engine)) {
      if (isMachO(f)) { sign(f); n++; }
    }
  }
  console.log(`[adhoc-sign] ${n} engine binaries signed`);

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
  console.log(`[adhoc-sign] ${path.basename(app)} ad-hoc signed and verified`);
};
