// Offline desktop packaging: page transform, macOS launcher behaviour, installer scripts, published installers.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DESKTOP_CSP, offlineIndex } from "../desktop/build-desktop.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const VERSION = readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();

test("offline page loads its assets relatively and forbids network connections", () => {
  const html = readFileSync(path.join(ROOT, "local_web", "index.html"), "utf8")
    .replace('/styles.css"', '/styles.css?v=abc123"').replace('/app.js"', '/app.js?v=def456"');
  const out = offlineIndex(html);
  assert.match(out, /href="styles\.css"/);
  assert.match(out, /src="app\.js"/);
  assert.match(out, /href="favicon\.svg"/);
  assert.doesNotMatch(out, /(src|href)="\//);
  assert.ok(out.includes(`content="${DESKTOP_CSP}"`));
  for (const directive of ["connect-src 'none'", "form-action 'none'", "object-src 'none'"]) assert.ok(DESKTOP_CSP.includes(directive), directive);
  assert.doesNotMatch(DESKTOP_CSP, /https?:|\*/, "no remote source may be allowed");
  assert.throws(() => offlineIndex(html.replace('href="/favicon.svg"', 'href="/other.svg"')), /root-absolute/);
});

function launcherCase({ browsers = [], safariFails = false, defaultFails = false, removePage = false } = {}) {
  const work = mkdtempSync(path.join(tmpdir(), "munword-launcher-"));
  // Bundle path with spaces and Chinese, as after dragging into /Applications under a Chinese name.
  const contents = path.join(work, "应用 程序", "PKUNMUN2026.app", "Contents");
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  mkdirSync(path.join(contents, "Resources", "site"), { recursive: true });
  cpSync(path.join(ROOT, "desktop", "macos", "launcher.sh"), path.join(contents, "MacOS", "PKUNMUN2026"));
  chmodSync(path.join(contents, "MacOS", "PKUNMUN2026"), 0o755);
  if (!removePage) writeFileSync(path.join(contents, "Resources", "site", "index.html"), "<!doctype html>");
  const apps = path.join(work, "Applications"), home = path.join(work, "home");
  mkdirSync(apps); mkdirSync(home);
  for (const name of browsers) mkdirSync(path.join(apps, `${name}.app`));
  const log = path.join(work, "open.log"), alerts = path.join(work, "alerts.log");
  const stub = path.join(work, "open");
  writeFileSync(stub, `#!/bin/bash\nprintf '%s\\n' "$*" >> "${log}"\n` +
    (safariFails ? `[[ "$1 $2" == "-a Safari" ]] && exit 1\n` : "") +
    (defaultFails ? `[[ $# -eq 1 ]] && exit 1\n` : "") + "exit 0\n");
  chmodSync(stub, 0o755);
  const result = spawnSync("/bin/bash", [path.join(contents, "MacOS", "PKUNMUN2026")], {
    env: { PATH: process.env.PATH, HOME: home, MUNWORD_OPEN: stub, MUNWORD_APPLICATIONS: apps, MUNWORD_ALERT: alerts }, encoding: "utf8",
  });
  const read = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []);
  const page = path.join(contents, "Resources", "site", "index.html");
  const expectedUrl = "file://" + page.split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())).join("/");
  return { status: result.status, calls: read(log), alerts: read(alerts), page, expectedUrl, apps };
}

test("macOS launcher prefers a Chromium app window and percent-encodes the page URL", { skip: process.platform === "win32" }, () => {
  const run = launcherCase({ browsers: ["Microsoft Edge", "Google Chrome"] });
  assert.equal(run.status, 0);
  assert.deepEqual(run.calls, [`-na ${run.apps}/Google Chrome.app --args --app=${run.expectedUrl}`]);
  assert.match(run.expectedUrl, /%E5%BA%94%E7%94%A8%20%E7%A8%8B%E5%BA%8F/);
  assert.deepEqual(run.alerts, []);
});

test("macOS launcher falls back to Safari, then the default app, then explains", { skip: process.platform === "win32" }, () => {
  const safari = launcherCase();
  assert.equal(safari.status, 0);
  assert.deepEqual(safari.calls, [`-a Safari ${safari.page}`]);
  const fallback = launcherCase({ safariFails: true });
  assert.equal(fallback.status, 0);
  assert.deepEqual(fallback.calls, [`-a Safari ${fallback.page}`, fallback.page]);
  const none = launcherCase({ safariFails: true, defaultFails: true });
  assert.equal(none.status, 1);
  assert.match(none.alerts.join(), /没有找到可用的浏览器/);
  const broken = launcherCase({ removePage: true, browsers: ["Google Chrome"] });
  assert.equal(broken.status, 1);
  assert.deepEqual(broken.calls, []);
  assert.match(broken.alerts.join(), /程序文件不完整/);
});

test("macOS bundle template and Windows installer scripts keep the offline, per-user design", () => {
  const plist = readFileSync(path.join(ROOT, "desktop", "macos", "Info.plist"), "utf8");
  for (const key of ["CFBundleExecutable</key>\n  <string>PKUNMUN2026", "CFBundleIconFile</key>\n  <string>AppIcon", "__VERSION__", "LSHasLocalizedDisplayName"]) assert.ok(plist.includes(key), key);
  assert.equal(readFileSync(path.join(ROOT, "desktop", "macos", "AppIcon.icns")).subarray(0, 4).toString(), "icns");
  const installer = readFileSync(path.join(ROOT, "desktop", "windows", "installer.nsi"), "utf8");
  for (const needle of ["RequestExecutionLevel user", '$LOCALAPPDATA\\Programs\\', "WriteUninstaller", "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "SimpChinese", "MUI_FINISHPAGE_RUN"]) assert.ok(installer.includes(needle), needle);
  assert.doesNotMatch(installer, /RequestExecutionLevel admin|HKLM|inetc|NSISdl/, "no admin rights and no downloads during install");
  const launcher = readFileSync(path.join(ROOT, "desktop", "windows", "launcher.nsi"), "utf8");
  for (const needle of ["SilentInstall silent", "msedge.exe", "chrome.exe", "--app=", 'ExecShell "open"']) assert.ok(launcher.includes(needle), needle);
});

test("published installers match VERSION and their checksums", { skip: !existsSync(path.join(ROOT, "downloads", "SHA256SUMS.txt")) }, () => {
  const sums = readFileSync(path.join(ROOT, "downloads", "SHA256SUMS.txt"), "utf8").trim().split("\n");
  assert.match(sums[0], new RegExp(`文件排版系统 ${VERSION.replaceAll(".", "\\.")} `), "rebuild with node desktop/build-desktop.mjs --publish after a version bump");
  const entries = sums.slice(1).map((line) => line.split(/\s+/));
  assert.deepEqual(entries.map(([, name]) => name).sort(), ["PKUNMUN2026-Formatter-Windows-Setup.exe", "PKUNMUN2026-Formatter-macOS.dmg"]);
  for (const [digest, name] of entries) assert.equal(createHash("sha256").update(readFileSync(path.join(ROOT, "downloads", name))).digest("hex"), digest, name);
});

test("the build script's page transform is what the offline smoke test exercises", () => {
  const script = readFileSync(path.join(ROOT, "desktop", "build-desktop.mjs"), "utf8");
  assert.match(script, /scripts", "build-static\.mjs"/, "desktop apps reuse the Pages build, not a second UI");
  assert.ok(execFileSync(process.execPath, ["--check", path.join(ROOT, "desktop", "offline-smoke.mjs")]).length === 0);
});
