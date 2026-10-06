// Offline desktop apps built from the SAME static build that Pages serves (scripts/build-static.mjs):
// no second UI or engine, no Python, no local server. The page runs from file:// and its
// Content-Security-Policy forbids every network connection.
//
//   node desktop/build-desktop.mjs [--only site|mac|win] [--skip-static] [--publish]
//
//   dist/desktop/site/                                   offline page (relative paths, CSP)
//   dist/desktop/PKUNMUN2026-Formatter-macOS.dmg         drag-to-Applications disk image
//   dist/desktop/PKUNMUN2026-Formatter-Windows-Setup.exe per-user installer (no admin rights)
//   --publish copies both into downloads/ with SHA256SUMS.txt
//
// Tools: macOS image → hdiutil (built into macOS), or on Linux xorrisofs + dmg (libdmg-hfsplus,
// the route Bitcoin Core uses for its Linux-built macOS images). Windows installer → makensis (NSIS 3).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, lutimesSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: "inherit", ...opts });
const has = (cmd) => { try { execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }); return true; } catch { return false; } };
// Fixed timestamps (the commit that set VERSION) make the installers byte-for-byte reproducible.
const EPOCH = Number(process.env.SOURCE_DATE_EPOCH || execFileSync("git", ["log", "-1", "--format=%ct", "--", "VERSION"], { cwd: ROOT }).toString().trim());

// The page may not connect anywhere: no fetch/XHR/WebSocket, no remote images or fonts, no form posts.
// Scripts and styles keep the browser default so the bundle loads identically in Safari, Chrome and Edge.
export const DESKTOP_CSP = "connect-src 'none'; img-src file: data: blob:; font-src file: data: blob:; media-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

export function offlineIndex(html) {
  let out = html
    .replace(/href="\/favicon\.svg"/, 'href="favicon.svg"')
    .replace(/href="\/styles\.css(\?v=[0-9a-f]+)?"/, 'href="styles.css"')
    .replace(/src="\/app\.js(\?v=[0-9a-f]+)?"/, 'src="app.js"')
    .replace("本站与本机版使用同一界面", "本机离线版与网页版使用同一界面")
    .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${DESKTOP_CSP}">`);
  // Any root-absolute reference left would point at the disk root under file://.
  if (/(src|href)="\//.test(out)) throw new Error("Offline page still has a root-absolute asset reference");
  for (const needle of ['href="styles.css"', 'src="app.js"', "Content-Security-Policy"]) if (!out.includes(needle)) throw new Error(`Offline page is missing ${needle}`);
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

function buildMac(site) {
  const stage = path.join(OUT, "mac");
  rmSync(stage, { recursive: true, force: true });
  // ASCII bundle folder; Finder shows the localized Chinese name (no encoding surprises on disk images).
  const app = path.join(stage, "PKUNMUN2026.app", "Contents");
  mkdirSync(path.join(app, "MacOS"), { recursive: true });
  mkdirSync(path.join(app, "Resources"), { recursive: true });
  writeFileSync(path.join(app, "Info.plist"), readFileSync(path.join(DESKTOP, "macos", "Info.plist"), "utf8").replaceAll("__VERSION__", VERSION));
  writeFileSync(path.join(app, "PkgInfo"), "APPL????");
  copyFileSync(path.join(DESKTOP, "macos", "launcher.sh"), path.join(app, "MacOS", "PKUNMUN2026"));
  chmodSync(path.join(app, "MacOS", "PKUNMUN2026"), 0o755);
  copyFileSync(path.join(DESKTOP, "macos", "AppIcon.icns"), path.join(app, "Resources", "AppIcon.icns"));
  for (const lproj of ["Base.lproj", "en.lproj", "zh-Hans.lproj", "zh_CN.lproj"]) {
    mkdirSync(path.join(app, "Resources", lproj), { recursive: true });
    writeFileSync(path.join(app, "Resources", lproj, "InfoPlist.strings"), `"CFBundleDisplayName" = "${APP_NAME}";\n"CFBundleName" = "${APP_NAME}";\n`);
  }
  cpSync(site, path.join(app, "Resources", "site"), { recursive: true });
  copyFileSync(path.join(DESKTOP, "macos", "安装说明.txt"), path.join(stage, "安装说明.txt"));
  symlinkSync("/Applications", path.join(stage, "Applications"));
  // Finder layout of the mounted image: app left, Applications right (desktop/macos/make-dmg-layout.py).
  copyFileSync(path.join(DESKTOP, "macos", "dmg-layout.DS_Store"), path.join(stage, ".DS_Store"));
  stamp(stage);
  const dmg = path.join(OUT, DMG_NAME);
  rmSync(dmg, { force: true });
  if (process.platform === "darwin") {
    run("hdiutil", ["create", "-volname", "PKUNMUN 2026", "-srcfolder", stage, "-format", "UDZO", "-imagekey", "zlib-level=9", "-ov", dmg]);
  } else {
    const dmgTool = process.env.DMG_TOOL || "dmg";
    if (!has("xorrisofs") || !(has(dmgTool) || existsSync(dmgTool))) throw new Error("Linux DMG build needs xorrisofs and the dmg tool from libdmg-hfsplus (set DMG_TOOL=/path/to/dmg)");
    const iso = path.join(OUT, "macOS-uncompressed.iso");
    // Rock Ridge keeps the launcher's execute bit and the Applications symlink.
    run("xorrisofs", ["-D", "-l", "-V", "PKUNMUN 2026", "-no-pad", "-r", "-dir-mode", "0755", "-o", iso, stage], { env: { ...process.env, SOURCE_DATE_EPOCH: String(EPOCH) } });
    run(dmgTool, [iso, dmg]);
    rmSync(iso, { force: true });
  }
  return dmg;
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
  for (const nsi of ["launcher.nsi", "installer.nsi"]) copyFileSync(path.join(DESKTOP, "windows", nsi), path.join(stage, nsi));
  stamp(stage);
  const version4 = `${VERSION.split(".").concat(["0", "0", "0"]).slice(0, 3).join(".")}.0`;
  const defs = [`-DVERSION=${VERSION}`, `-DVERSION4=${version4}`, "-INPUTCHARSET", "UTF8", "-V2"];
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
    writeFileSync(path.join(downloads, "SHA256SUMS.txt"), `# PKUNMUN 2026 文件排版系统 ${VERSION} — offline desktop installers\n${sums.join("\n")}\n`);
    console.log(`Published ${outputs.length} installers for ${VERSION} to downloads/ (${outputs.map((f) => `${path.basename(f)} ${(statSync(f).size / 1048576).toFixed(1)} MB`).join(", ")})`);
  }
}
