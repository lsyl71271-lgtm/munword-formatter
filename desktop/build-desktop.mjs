// Offline desktop apps built from the SAME static build that Pages serves (scripts/build-static.mjs):
// no second UI or engine, no Python, no local server. The page runs from file:// and its
// Content-Security-Policy forbids every network connection.
//
//   node desktop/build-desktop.mjs [--only site|mac|win] [--skip-static] [--publish]
//
//   dist/desktop/site/                                   offline page (relative paths, CSP)
//   dist/desktop/PKUNMUN2026-Formatter-macOS.dmg         drag-to-Applications disk image
//   dist/desktop/PKUNMUN2026-Formatter-Windows-Setup.exe per-user installer (no admin rights)
//   --publish copies both into downloads/ and updates their lines in SHA256SUMS.txt
//
// Tools: macOS image → codesign + hdiutil (built into macOS), or on Linux rcodesign (apple-codesign) +
// mkfs.hfsplus + hfsplus/dmg (libdmg-hfsplus, the route Firefox uses for its Linux-built macOS images).
// Windows installer → makensis (NSIS 3).
//
// Optional release signing; the default build needs no certificate (ad-hoc signed app, unsigned EXE):
//   macOS app   MUNWORD_MAC_SIGN_IDENTITY ("Developer ID Application: …", keychain identity, on a Mac)
//               or MUNWORD_MAC_P12 + MUNWORD_MAC_P12_PASSWORD_FILE (rcodesign, on Linux; Apple's
//               time-stamp server unless MUNWORD_MAC_TIMESTAMP_URL says otherwise, "none" for tests)
//   notarize    MUNWORD_NOTARY_PROFILE (notarytool keychain profile, on a Mac)
//               or MUNWORD_NOTARY_API_KEY (App Store Connect API key JSON for rcodesign, on Linux)
//   Windows     MUNWORD_WIN_PFX + MUNWORD_WIN_PFX_PASSWORD_FILE (osslsigncode; launcher, installer and
//               uninstaller are signed), MUNWORD_WIN_TIMESTAMP_URL optional
// Signed builds carry signing times, so only unsigned builds are byte-for-byte reproducible.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, lstatSync, lutimesSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "desktop");
const OUT = path.join(ROOT, "dist", "desktop");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const want = (part) => !only || only === part;
const VERSION = readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
const APP_NAME = "PKUNMUN 2026 文件排版系统";
const DMG_NAME = "PKUNMUN2026-Formatter-macOS.dmg";
const EXE_NAME = "PKUNMUN2026-Formatter-Windows-Setup.exe";
const VOLUME_NAME = "PKUNMUN 2026";
export const BROWSER_PAGE = "直接用浏览器打开.html";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: "inherit", ...opts });
const has = (cmd) => { try { execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }); return true; } catch { return false; } };
// Fixed timestamps (the commit that set VERSION) make the installers byte-for-byte reproducible.
const EPOCH = Number(process.env.SOURCE_DATE_EPOCH || execFileSync("git", ["log", "-1", "--format=%ct", "--", "VERSION"], { cwd: ROOT }).toString().trim());

// The page may not connect anywhere: no fetch/XHR/WebSocket, no remote images or fonts, no form posts.
// Scripts and styles keep the browser default so the bundle loads identically in Safari, Chrome and Edge.
export const DESKTOP_CSP = "connect-src 'none'; img-src file: data: blob:; font-src file: data: blob:; media-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

// Oldest browsers that run the bundle and its styles: Array.prototype.findLast (Chrome/Edge 97, Safari 15.4,
// Firefox 104) and CSS cascade layers (Chrome/Edge 99, Safari 15.4, Firefox 97). An older browser (IE, Chrome
// on an unpatched Windows 7, Safari on macOS 10.14) would show a blank or unstyled page, so this ES3 loader
// explains which browser to install instead of loading app.js.
export const OUTDATED_BROWSER_MESSAGE = "这个浏览器版本太旧，无法运行排版系统。";
const COMPAT_LOADER = `<script>
    (function () {
      var root = document.getElementById("root");
      var box = '<div style="max-width:560px;margin:48px auto;padding:24px 28px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;color:#1d2939;font:15px/1.75 sans-serif">';
      if (typeof Array.prototype.findLast === "function" && typeof window.CSSLayerBlockRule !== "undefined") {
        var script = document.createElement("script");
        script.src = "app.js";
        script.onerror = function () {
          root.innerHTML = box + "<b>程序文件不完整。</b><br>请重新运行安装程序（macOS 请重新把程序拖进「应用程序」）。</div>";
        };
        document.body.appendChild(script);
        return;
      }
      root.innerHTML = box + "<b>${OUTDATED_BROWSER_MESSAGE}</b><br>" +
        "请安装或更新以下任一浏览器，然后重新打开本程序（程序本身不联网，排版仍在本机完成）：<br>" +
        "· Windows 10 / 11：Microsoft Edge 或 Google Chrome 最新版<br>" +
        "· Windows 7 / 8.1：Google Chrome 109 或 Firefox ESR 115<br>" +
        "· macOS 10.15 及以上：系统更新后的 Safari（15.4 或更高）<br>" +
        "· macOS 10.11–10.14：Google Chrome 或 Firefox</div>";
    })();
  </script>`;

export function offlineIndex(html) {
  let out = html
    .replace(/href="\/favicon\.svg"/, 'href="favicon.svg"')
    .replace(/href="\/styles\.css(\?v=[0-9a-f]+)?"/, 'href="styles.css"')
    .replace(/<script src="\/app\.js(\?v=[0-9a-f]+)?" defer><\/script>/, () => COMPAT_LOADER)
    .replace("本站与本机版使用同一界面", "本机离线版与网页版使用同一界面")
    .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${DESKTOP_CSP}">`);
  // Any root-absolute reference left would point at the disk root under file://.
  if (/(src|href)="\//.test(out)) throw new Error("Offline page still has a root-absolute asset reference");
  for (const needle of ['href="styles.css"', 'script.src = "app.js"', "Content-Security-Policy"]) if (!out.includes(needle)) throw new Error(`Offline page is missing ${needle}`);
  return out;
}

// 直接用浏览器打开.html on the disk image: the same page with styles.css and app.js inlined, so it is one
// self-contained file that works from wherever it is opened or copied, in any browser. Opened from Finder,
// Safari's sandbox lets a page read only its own folder: a page that loaded the app's files from
// /Applications would fail once copied to the Desktop.
export function singleFilePage(site) {
  const html = readFileSync(path.join(site, "index.html"), "utf8");
  const css = readFileSync(path.join(site, "styles.css"), "utf8");
  const js = readFileSync(path.join(site, "app.js"), "utf8");
  if (/<\/style/i.test(css)) throw new Error("styles.css cannot be inlined: it contains </style");
  // The bundle travels as a string literal with no "<" in it, so the HTML parser cannot end the script early.
  const literal = JSON.stringify(js).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const icon = `data:image/svg+xml;base64,${readFileSync(path.join(site, "favicon.svg")).toString("base64")}`;
  const out = html
    .replace('<link rel="icon" href="favicon.svg" type="image/svg+xml">', () => `<link rel="icon" href="${icon}" type="image/svg+xml">`)
    .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${css}\n</style>`)
    .replace("  <script>\n    (function () {", () => `  <script>window.__munwordApp = ${literal};</script>\n  <script>\n    (function () {`)
    .replace('script.src = "app.js";', () => "script.text = window.__munwordApp;\n        window.__munwordApp = null;");
  for (const needle of ["window.__munwordApp = null", "<style>", "Content-Security-Policy", OUTDATED_BROWSER_MESSAGE, icon]) {
    if (!out.includes(needle)) throw new Error(`Single-file page is missing ${needle.slice(0, 40)}`);
  }
  if (/(src|href)="(?!data:)[^"]*"/.test(out.replace(literal, ""))) throw new Error("Single-file page still references a file");
  return out;
}

function buildSite() {
  if (!args.includes("--skip-static")) run(process.execPath, [path.join(ROOT, "scripts", "build-static.mjs")], { cwd: ROOT });
  const src = path.join(ROOT, "static-site");
  const provenance = JSON.parse(readFileSync(path.join(src, "version.json"), "utf8"));
  if (provenance.version !== VERSION) throw new Error(`static-site is ${provenance.version}, VERSION is ${VERSION}; rebuild it`);
  const site = path.join(OUT, "site");
  rmSync(site, { recursive: true, force: true });
  mkdirSync(site, { recursive: true });
  for (const [name, digest] of Object.entries(provenance.assets)) {
    const bytes = readFileSync(path.join(src, name));
    if (sha256(bytes) !== digest) throw new Error(`static-site/${name} does not match its build record`);
    mkdirSync(path.dirname(path.join(site, name)), { recursive: true });
    writeFileSync(path.join(site, name), bytes);
  }
  writeFileSync(path.join(site, "index.html"), offlineIndex(readFileSync(path.join(src, "index.html"), "utf8")));
  writeFileSync(path.join(site, "version.json"), JSON.stringify({ version: VERSION, kind: "desktop-offline", assets: provenance.assets }, null, 2) + "\n");
  return site;
}

function stamp(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) stamp(full);
    if (entry.isSymbolicLink()) lutimesSync(full, EPOCH, EPOCH);
    else utimesSync(full, EPOCH, EPOCH);
  }
  utimesSync(dir, EPOCH, EPOCH);
}

// Disk image as Finder makes it: HFS+ with the drag-to-Applications layout, zlib-compressed (UDZO) so
// every macOS from 10.11 mounts it without a "damaged" warning. On Linux the volume is written with
// mkfs.hfsplus (hfsprogs) and the hfsplus/dmg tools of libdmg-hfsplus, the route Firefox's macOS builds
// take; libfaketime pins the volume dates so the image is reproducible.
function buildMac(site) {
  const stage = path.join(OUT, "mac");
  rmSync(stage, { recursive: true, force: true });
  // ASCII bundle folder; Finder shows the localized Chinese name (no encoding surprises on disk images).
  const app = path.join(stage, "PKUNMUN2026.app", "Contents");
  mkdirSync(path.join(app, "MacOS"), { recursive: true });
  mkdirSync(path.join(app, "Resources"), { recursive: true });
  writeFileSync(path.join(app, "Info.plist"), readFileSync(path.join(DESKTOP, "macos", "Info.plist"), "utf8").replaceAll("__VERSION__", VERSION));
  writeFileSync(path.join(app, "PkgInfo"), "APPL????");
  // Native universal entry point (no Rosetta prompt on Apple silicon) that runs Resources/launcher.sh.
  copyFileSync(path.join(DESKTOP, "macos", "launcher-stub"), path.join(app, "MacOS", "PKUNMUN2026"));
  chmodSync(path.join(app, "MacOS", "PKUNMUN2026"), 0o755);
  copyFileSync(path.join(DESKTOP, "macos", "launcher.sh"), path.join(app, "Resources", "launcher.sh"));
  chmodSync(path.join(app, "Resources", "launcher.sh"), 0o755);
  copyFileSync(path.join(DESKTOP, "macos", "AppIcon.icns"), path.join(app, "Resources", "AppIcon.icns"));
  for (const lproj of ["Base.lproj", "en.lproj", "zh-Hans.lproj", "zh_CN.lproj"]) {
    mkdirSync(path.join(app, "Resources", lproj), { recursive: true });
    writeFileSync(path.join(app, "Resources", lproj, "InfoPlist.strings"), `"CFBundleDisplayName" = "${APP_NAME}";\n"CFBundleName" = "${APP_NAME}";\n`);
  }
  cpSync(site, path.join(app, "Resources", "site"), { recursive: true });
  signApp(path.join(stage, "PKUNMUN2026.app"));
  copyFileSync(path.join(DESKTOP, "macos", "安装说明.txt"), path.join(stage, "安装说明.txt"));
  // The whole page in one file: opens in the default browser without launching the app, so no Gatekeeper
  // approval is needed, and keeps working when copied to the Desktop.
  writeFileSync(path.join(stage, BROWSER_PAGE), singleFilePage(site));
  symlinkSync("/Applications", path.join(stage, "Applications"));
  // Finder layout of the mounted image: app left, Applications right (desktop/macos/make-dmg-layout.py).
  copyFileSync(path.join(DESKTOP, "macos", "dmg-layout.DS_Store"), path.join(stage, ".DS_Store"));
  stamp(stage);
  const dmg = path.join(OUT, DMG_NAME);
  rmSync(dmg, { force: true });
  if (process.platform === "darwin") {
    run("hdiutil", ["create", "-volname", VOLUME_NAME, "-srcfolder", stage, "-fs", "HFS+", "-format", "UDZO", "-imagekey", "zlib-level=9", "-ov", dmg]);
    notarize(dmg);
    return dmg;
  }
  const hfsplus = process.env.HFSPLUS_TOOL || "hfsplus", dmgTool = process.env.DMG_TOOL || "dmg";
  for (const tool of ["mkfs.hfsplus", hfsplus, dmgTool]) {
    if (!has(tool) && !existsSync(tool)) throw new Error(`Linux DMG build needs mkfs.hfsplus (apt hfsprogs) and the hfsplus and dmg tools of libdmg-hfsplus (set HFSPLUS_TOOL= and DMG_TOOL=); missing ${tool}`);
  }
  const faketime = ["/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1", "/usr/lib/aarch64-linux-gnu/faketime/libfaketime.so.1", "/usr/lib/faketime/libfaketime.so.1"].find(existsSync);
  if (!faketime) console.warn("libfaketime not found (apt faketime): the DMG works but is not byte-for-byte reproducible");
  const env = { ...process.env, TZ: "UTC", ...(faketime ? { LD_PRELOAD: faketime, FAKETIME: new Date(EPOCH * 1000).toISOString().slice(0, 19).replace("T", " ") } : {}) };
  const img = path.join(OUT, "macOS-uncompressed.hfs");
  // Room for the files, their 4 KiB blocks and the catalog; free space compresses to nothing.
  const MiB = 1048576;
  writeFileSync(img, "");
  truncateSync(img, Math.ceil((treeSize(stage) * 1.25 + 8 * MiB) / MiB) * MiB);
  run("mkfs.hfsplus", ["-v", VOLUME_NAME, img], { env, stdio: ["ignore", "ignore", "inherit"] });
  pinVolumeId(img);
  // HFS+ stores names as decomposed UTF-16; these names have no decomposable characters.
  for (const name of readdirSync(stage, { recursive: true })) if (name.normalize("NFD") !== name) throw new Error(`${name}: use a name without accented letters on the disk image`);
  run(hfsplus, [img, "addall", stage, "/", "--symlinks", "clone_link"], { env, stdio: ["ignore", "ignore", "inherit"] });
  // Upstream hfsplus copies names byte by byte, which turns Chinese names into garbage in Finder.
  // The catalog key of a root-level file: parent folder 2, name length in UTF-16 units, UTF-16BE name.
  const readme = Buffer.from("安装说明.txt", "utf16le").swap16();
  if (!readFileSync(img).includes(Buffer.concat([Buffer.from([0, 0, 0, 2, 0, readme.length / 2]), readme]))) throw new Error("hfsplus wrote the Chinese file names incorrectly; build it with desktop/macos/libdmg-hfsplus.patch");
  run(dmgTool, ["--compression", "zlib", "--level", "9", "build", img, dmg], { env, stdio: ["ignore", "ignore", "inherit"] });
  rmSync(img, { force: true });
  notarize(dmg);
  return dmg;
}

// Apple silicon runs only signed native code, and an app whose signature does not cover its resources is
// reported as "damaged". Without a certificate an ad-hoc signature seals the whole bundle
// (Contents/_CodeSignature) without a developer identity, so macOS shows only its usual first-open
// confirmation for apps from the internet. With a Developer ID the hardened runtime is enabled for notarization.
function signApp(bundle) {
  const identity = process.env.MUNWORD_MAC_SIGN_IDENTITY;
  if (process.platform === "darwin") {
    run("codesign", ["--force", "--sign", identity || "-", ...(identity ? ["--options", "runtime", "--timestamp"] : ["--timestamp=none"]), bundle]);
    run("codesign", ["--verify", "--strict", "--verbose=2", bundle]);
    return;
  }
  const rcodesign = process.env.RCODESIGN || "rcodesign";
  if (!has(rcodesign) && !existsSync(rcodesign)) throw new Error("Signing the macOS app on Linux needs rcodesign (cargo install apple-codesign; set RCODESIGN=/path/to/rcodesign)");
  if (identity) throw new Error("MUNWORD_MAC_SIGN_IDENTITY names a keychain identity, which only exists on a Mac; on Linux use MUNWORD_MAC_P12");
  const p12 = process.env.MUNWORD_MAC_P12;
  const certificate = p12 ? ["--p12-file", p12, "--p12-password-file", process.env.MUNWORD_MAC_P12_PASSWORD_FILE || "", "--code-signature-flags", "runtime", ...(process.env.MUNWORD_MAC_TIMESTAMP_URL ? ["--timestamp-url", process.env.MUNWORD_MAC_TIMESTAMP_URL] : [])] : [];
  run(rcodesign, ["sign", ...certificate, bundle], { stdio: ["ignore", "ignore", "inherit"] });
  if (!existsSync(path.join(bundle, "Contents", "_CodeSignature", "CodeResources"))) throw new Error("rcodesign did not seal the bundle resources");
}

// Notarization removes the first-open warning entirely; it needs a Developer ID signature.
function notarize(dmg) {
  if (process.platform === "darwin" && process.env.MUNWORD_NOTARY_PROFILE) {
    if (!process.env.MUNWORD_MAC_SIGN_IDENTITY) throw new Error("Notarization needs MUNWORD_MAC_SIGN_IDENTITY (Developer ID Application)");
    run("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", process.env.MUNWORD_NOTARY_PROFILE, "--wait"]);
    run("xcrun", ["stapler", "staple", dmg]);
    run("xcrun", ["stapler", "validate", dmg]);
  } else if (process.platform !== "darwin" && process.env.MUNWORD_NOTARY_API_KEY) {
    if (!process.env.MUNWORD_MAC_P12) throw new Error("Notarization needs a Developer ID certificate (MUNWORD_MAC_P12)");
    run(process.env.RCODESIGN || "rcodesign", ["notary-submit", "--api-key-file", process.env.MUNWORD_NOTARY_API_KEY, "--staple", dmg]);
  }
}

function treeSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? treeSize(full) + 4096 : Math.ceil(lstatSync(full).size / 4096) * 4096 + 4096;
  }
  return total;
}

// mkfs.hfsplus writes a random 64-bit volume identifier (Finder info words 6–7) into the volume header
// and its backup copy; a value derived from the version keeps the image reproducible.
function pinVolumeId(img) {
  const id = createHash("sha256").update(`PKUNMUN2026 ${VERSION}`).digest().subarray(0, 8);
  const size = statSync(img).size;
  const fd = openSync(img, "r+");
  try {
    for (const header of [1024, size - 1024]) {
      const signature = Buffer.alloc(2);
      readSync(fd, signature, 0, 2, header);
      if (signature.toString("latin1") !== "H+") throw new Error("mkfs.hfsplus did not write an HFS+ volume header");
      writeSync(fd, id, 0, 8, header + 104);
    }
  } finally {
    closeSync(fd);
  }
}

function buildWin(site) {
  if (!has("makensis")) throw new Error("Windows installer needs makensis (NSIS 3): apt install nsis / brew install makensis / choco install nsis");
  const stage = path.join(OUT, "win");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(site, path.join(stage, "site"), { recursive: true });
  copyFileSync(path.join(ROOT, "windows", "app.ico"), path.join(stage, "app.ico"));
  copyFileSync(path.join(DESKTOP, "windows", "sidebar.bmp"), path.join(stage, "sidebar.bmp"));
  // Windows Notepad reads the readme correctly with a UTF-8 BOM and CRLF.
  writeFileSync(path.join(stage, "使用说明.txt"), "﻿" + readFileSync(path.join(DESKTOP, "windows", "使用说明.txt"), "utf8").replace(/\r?\n/g, "\r\n"));
  for (const nsi of ["browsers.nsh", "launcher.nsi", "installer.nsi"]) copyFileSync(path.join(DESKTOP, "windows", nsi), path.join(stage, nsi));
  stamp(stage);
  const version4 = `${VERSION.split(".").concat(["0", "0", "0"]).slice(0, 3).join(".")}.0`;
  const defs = [`-DVERSION=${VERSION}`, `-DVERSION4=${version4}`, "-INPUTCHARSET", "UTF8", "-V2"];
  if (process.env.MUNWORD_WIN_PFX) {
    if (!has("osslsigncode")) throw new Error("MUNWORD_WIN_PFX is set but osslsigncode is missing (apt install osslsigncode)");
    defs.push(`-DSIGN=${path.join(DESKTOP, "windows", "sign.sh")}`);
  }
  // makensis on Linux crashes on the Chinese readme name unless the locale is UTF-8.
  const env = { ...process.env, ...(process.platform === "linux" && !/UTF-?8/i.test(process.env.LC_ALL || process.env.LANG || "") ? { LC_ALL: "C.UTF-8" } : {}) };
  run("makensis", [...defs, "launcher.nsi"], { cwd: stage, env });
  utimesSync(path.join(stage, "PKUNMUN2026Formatter.exe"), EPOCH, EPOCH);
  run("makensis", [...defs, `-DOUTFILE=${EXE_NAME}`, "installer.nsi"], { cwd: stage, env });
  const exe = path.join(OUT, EXE_NAME);
  copyFileSync(path.join(stage, EXE_NAME), exe);
  return exe;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  mkdirSync(OUT, { recursive: true });
  const site = buildSite();
  const outputs = [];
  if (want("mac")) outputs.push(buildMac(site));
  if (want("win")) outputs.push(buildWin(site));
  const sums = outputs.map((file) => `${sha256(readFileSync(file))}  ${path.basename(file)}`);
  for (const line of sums) console.log(line);
  if (args.includes("--publish")) {
    if (only) throw new Error("--publish needs both installers; run without --only");
    const downloads = path.join(ROOT, "downloads");
    mkdirSync(downloads, { recursive: true });
    for (const file of outputs) copyFileSync(file, path.join(downloads, path.basename(file)));
    // The other installers' lines (the Android APK, from android/build-apk.mjs --publish) stay as they are.
    const sumsFile = path.join(downloads, "SHA256SUMS.txt");
    const kept = existsSync(sumsFile) ? readFileSync(sumsFile, "utf8").split("\n").filter((line) => /^[0-9a-f]{64} {2}/.test(line) && !outputs.some((file) => line.endsWith(`  ${path.basename(file)}`))) : [];
    const lines = [...kept, ...sums].sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1));
    writeFileSync(sumsFile, `# PKUNMUN 2026 文件排版系统 ${VERSION} — offline installers\n${lines.join("\n")}\n`);
    console.log(`Published ${outputs.length} installers for ${VERSION} to downloads/ (${outputs.map((f) => `${path.basename(f)} ${(statSync(f).size / 1048576).toFixed(1)} MB`).join(", ")})`);
  }
}
