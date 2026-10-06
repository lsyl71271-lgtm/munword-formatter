// Offline desktop packaging: page transform, macOS launcher behaviour, installer scripts, published installers.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { BROWSER_PAGE, DESKTOP_CSP, OUTDATED_BROWSER_MESSAGE, offlineIndex } from "../desktop/build-desktop.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const VERSION = readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
// The launcher must work under the bash 3.2 that macOS ships; MUNWORD_TEST_SHELLS adds e.g. a built bash-3.2 and zsh.
const SHELLS = (process.env.MUNWORD_TEST_SHELLS || "/bin/bash").split(path.delimiter).filter(Boolean);

function sampleIndex() {
  return readFileSync(path.join(ROOT, "local_web", "index.html"), "utf8")
    .replace('/styles.css"', '/styles.css?v=abc123"').replace('/app.js"', '/app.js?v=def456"');
}

test("offline page loads its assets relatively and forbids network connections", () => {
  const html = sampleIndex();
  const out = offlineIndex(html);
  assert.match(out, /href="styles\.css"/);
  assert.match(out, /script\.src = "app\.js"/);
  assert.match(out, /href="favicon\.svg"/);
  assert.doesNotMatch(out, /(src|href)="\//);
  assert.ok(out.includes(`content="${DESKTOP_CSP}"`));
  for (const directive of ["connect-src 'none'", "form-action 'none'", "object-src 'none'"]) assert.ok(DESKTOP_CSP.includes(directive), directive);
  assert.doesNotMatch(DESKTOP_CSP, /https?:|\*/, "no remote source may be allowed");
  assert.throws(() => offlineIndex(html.replace('href="/favicon.svg"', 'href="/other.svg"')), /root-absolute/);
});

test("the page loader only starts the app in a browser new enough for it, in syntax old browsers parse", () => {
  const out = offlineIndex(sampleIndex());
  const loader = out.slice(out.indexOf("<script>") + 8, out.indexOf("</script>"));
  // Internet Explorer and old Safari must be able to parse it to show the explanation.
  assert.doesNotMatch(loader, /=>|`|\blet\b|\bconst\b|\?\.|\?\?|\bclass\b|\.\.\./);
  const run = (modern) => {
    const dom = new JSDOM(out, {
      runScripts: "dangerously",
      beforeParse(window) {
        if (modern) window.CSSLayerBlockRule = function CSSLayerBlockRule() {};
        else delete window.Array.prototype.findLast;
      },
    });
    const { document } = dom.window;
    return { scripts: [...document.querySelectorAll("script[src]")].map((node) => node.getAttribute("src")), root: document.getElementById("root").textContent };
  };
  const modern = run(true);
  assert.deepEqual(modern.scripts, ["app.js"]);
  assert.doesNotMatch(modern.root, /太旧/);
  const outdated = run(false);
  assert.deepEqual(outdated.scripts, [], "an outdated browser never runs app.js");
  assert.ok(outdated.root.includes(OUTDATED_BROWSER_MESSAGE));
  for (const browser of ["Microsoft Edge", "Chrome 109", "Firefox ESR 115", "Safari（15.4"]) assert.ok(outdated.root.includes(browser), browser);
});

function launcherCase({ shell = SHELLS[0], browsers = [], safari = null, safariFails = false, defaultFails = false, removePage = false } = {}) {
  const work = mkdtempSync(path.join(tmpdir(), "munword-launcher-"));
  // Bundle path with spaces and Chinese, as after dragging into /Applications under a Chinese name.
  const contents = path.join(work, "应用 程序", "PKUNMUN2026.app", "Contents");
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  mkdirSync(path.join(contents, "Resources", "site"), { recursive: true });
  const script = path.join(contents, "Resources", "launcher.sh");
  cpSync(path.join(ROOT, "desktop", "macos", "launcher.sh"), script);
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
  // defaults(1) stand-in: the Safari version, or failure as when Safari is missing.
  const defaults = path.join(work, "defaults");
  writeFileSync(defaults, safari ? `#!/bin/sh\n[ "$2" = "${apps}/Safari.app/Contents/Info" ] && [ "$3" = CFBundleShortVersionString ] && echo "${safari}"\n` : "#!/bin/sh\nexit 1\n");
  chmodSync(defaults, 0o755);
  // Started like the native stub does it: <shell> .../Contents/MacOS/../Resources/launcher.sh
  const result = spawnSync(shell, [path.join(contents, "MacOS", "..", "Resources", "launcher.sh")], {
    env: { PATH: process.env.PATH, HOME: home, MUNWORD_OPEN: stub, MUNWORD_DEFAULTS: defaults, MUNWORD_APPLICATIONS: apps, MUNWORD_ALERT: alerts }, encoding: "utf8",
  });
  const read = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []);
  const page = path.join(contents, "Resources", "site", "index.html");
  const expectedUrl = "file://" + page.split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())).join("/");
  return { status: result.status, stderr: result.stderr, calls: read(log), alerts: read(alerts), page, expectedUrl, apps };
}

for (const shell of SHELLS) {
  const skip = process.platform === "win32" || !existsSync(shell);
  test(`macOS launcher prefers a Chromium app window and percent-encodes the page URL (${shell})`, { skip }, () => {
    const run = launcherCase({ shell, browsers: ["Microsoft Edge", "Google Chrome", "Firefox"] });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.calls, [`-na ${run.apps}/Google Chrome.app --args --app=${run.expectedUrl}`]);
    assert.match(run.expectedUrl, /%E5%BA%94%E7%94%A8%20%E7%A8%8B%E5%BA%8F/);
    assert.deepEqual(run.alerts, []);
    const vivaldi = launcherCase({ shell, browsers: ["Vivaldi"] });
    assert.deepEqual(vivaldi.calls, [`-na ${vivaldi.apps}/Vivaldi.app --args --app=${vivaldi.expectedUrl}`]);
  });

  test(`macOS launcher uses Safari 15.4+, Firefox when Safari is older, and explains failures (${shell})`, { skip }, () => {
    for (const safari of [null, "15.4", "15.6.1", "16", "26.0"]) {
      const run = launcherCase({ shell, safari, browsers: ["Firefox"] });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(run.calls, [`-a Safari ${run.page}`], `Safari ${safari}`);
    }
    for (const safari of ["15.3", "14.1.2", "13.1"]) {
      const run = launcherCase({ shell, safari, browsers: ["Firefox"] });
      assert.deepEqual(run.calls, [`-a ${run.apps}/Firefox.app ${run.page}`], `Safari ${safari}`);
    }
    // An old Safari without Firefox still opens the page, which then names the browsers to install.
    const oldOnly = launcherCase({ shell, safari: "12.1.2" });
    assert.deepEqual(oldOnly.calls, [`-a Safari ${oldOnly.page}`]);
    const fallback = launcherCase({ shell, safariFails: true });
    assert.equal(fallback.status, 0);
    assert.deepEqual(fallback.calls, [`-a Safari ${fallback.page}`, fallback.page]);
    const none = launcherCase({ shell, safariFails: true, defaultFails: true });
    assert.equal(none.status, 1);
    assert.match(none.alerts.join(), /没有找到可用的浏览器/);
    const broken = launcherCase({ shell, removePage: true, browsers: ["Google Chrome"] });
    assert.equal(broken.status, 1);
    assert.deepEqual(broken.calls, []);
    assert.match(broken.alerts.join(), /程序文件不完整/);
  });
}

// Deployment target of every slice of a Mach-O file, read from LC_VERSION_MIN_MACOSX / LC_BUILD_VERSION.
function machoMinimums(bytes) {
  const slices = bytes.readUInt32BE(0) === 0xcafebabe
    ? Array.from({ length: bytes.readUInt32BE(4) }, (_, i) => ({ cpu: bytes.readUInt32BE(8 + i * 20), offset: bytes.readUInt32BE(16 + i * 20) }))
    : [{ cpu: bytes.readUInt32LE(4), offset: 0 }];
  const version = (v) => `${v >>> 16}.${(v >> 8) & 0xff}`;
  return Object.fromEntries(slices.map(({ cpu, offset }) => {
    assert.equal(bytes.readUInt32LE(offset), 0xfeedfacf, "64-bit Mach-O slice");
    let at = offset + 32, minimum = null;
    for (let i = 0; i < bytes.readUInt32LE(offset + 16); i++) {
      const cmd = bytes.readUInt32LE(at), size = bytes.readUInt32LE(at + 4);
      if (cmd === 0x24) minimum = version(bytes.readUInt32LE(at + 8));
      if (cmd === 0x32) minimum = version(bytes.readUInt32LE(at + 12));
      at += size;
    }
    return [{ 0x01000007: "x86_64", 0x0100000c: "arm64" }[cpu], minimum];
  }));
}

test("macOS entry point is a universal program whose real deployment targets match Info.plist", () => {
  const stub = readFileSync(path.join(ROOT, "desktop", "macos", "launcher-stub"));
  assert.equal(stub.readUInt32BE(0), 0xcafebabe, "fat Mach-O");
  // The minimum macOS is what the binaries need, not just what the plist claims.
  const minimums = machoMinimums(stub);
  assert.deepEqual(minimums, { x86_64: "10.11", arm64: "11.0" });
  const plist = readFileSync(path.join(ROOT, "desktop", "macos", "Info.plist"), "utf8");
  assert.equal(/LSMinimumSystemVersion<\/key>\s*<string>([\d.]+)</.exec(plist)[1], minimums.x86_64);
  assert.ok(stub.includes(Buffer.from("/../Resources/launcher.sh")) && stub.includes(Buffer.from("/bin/bash")));
  const source = readFileSync(path.join(ROOT, "desktop", "macos", "launcher-stub.c"), "utf8");
  assert.match(source, /_NSGetExecutablePath/);
  const script = readFileSync(path.join(ROOT, "desktop", "build-desktop.mjs"), "utf8");
  assert.match(script, /function signApp\(/, "the bundle is sealed with a signature");
  for (const hook of ["MUNWORD_MAC_SIGN_IDENTITY", "MUNWORD_MAC_P12", "MUNWORD_NOTARY_PROFILE", "MUNWORD_NOTARY_API_KEY", "MUNWORD_WIN_PFX"]) assert.ok(script.includes(hook), hook);
});

test("the disk image's browser page opens the bundled or installed page without starting the app", () => {
  const html = readFileSync(path.join(ROOT, "desktop", "macos", BROWSER_PAGE), "utf8");
  for (const needle of ["PKUNMUN2026.app/Contents/Resources/site/", "file:///Applications/", "Applications/", "favicon.svg", "location.replace"]) assert.ok(html.includes(needle), needle);
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/, "nothing remote");
  const layout = readFileSync(path.join(ROOT, "desktop", "macos", "make-dmg-layout.py"), "utf8");
  assert.ok(layout.includes(BROWSER_PAGE), "positioned in the Finder window");
});

test("macOS bundle template and Windows installer scripts keep the offline, per-user design", () => {
  const plist = readFileSync(path.join(ROOT, "desktop", "macos", "Info.plist"), "utf8");
  for (const key of ["CFBundleExecutable</key>\n  <string>PKUNMUN2026", "CFBundleIconFile</key>\n  <string>AppIcon", "__VERSION__", "LSHasLocalizedDisplayName", "LSMinimumSystemVersion</key>\n  <string>10.11"]) assert.ok(plist.includes(key), key);
  assert.equal(readFileSync(path.join(ROOT, "desktop", "macos", "AppIcon.icns")).subarray(0, 4).toString(), "icns");
  const installer = readFileSync(path.join(ROOT, "desktop", "windows", "installer.nsi"), "utf8");
  for (const needle of ["RequestExecutionLevel user", '$LOCALAPPDATA\\Programs\\', "WriteUninstaller", "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "SimpChinese", "MUI_FINISHPAGE_RUN", '!include "browsers.nsh"', "ManifestDPIAware true", "FinishShow", "StrLen $0 \"$INSTDIR\"", "!uninstfinalize"]) assert.ok(installer.includes(needle), needle);
  assert.doesNotMatch(installer, /RequestExecutionLevel admin|HKLM|inetc|NSISdl/, "no admin rights and no downloads during install");
  const launcher = readFileSync(path.join(ROOT, "desktop", "windows", "launcher.nsi"), "utf8");
  for (const needle of ["SilentInstall silent", '!include "browsers.nsh"', "--app=", "--no-first-run", "-new-window", 'ExecShell "open"', "ManifestDPIAware true"]) assert.ok(launcher.includes(needle), needle);
  const browsers = readFileSync(path.join(ROOT, "desktop", "windows", "browsers.nsh"), "utf8");
  for (const needle of ["UserChoice", "App Paths", "SetRegView 64", "GetDLLVersion", '"msedge.exe" chromium 99', '"chrome.exe" chromium 99', '"brave.exe"', '"vivaldi.exe"', '"firefox.exe" firefox 104']) assert.ok(browsers.includes(needle), needle);
  assert.doesNotMatch(browsers, /WriteReg|DeleteReg/, "finding a browser changes nothing");
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
