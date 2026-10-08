// The Android app's own pieces, without Android tools: the page variant for older WebViews (stylesheet fallbacks,
// built-ins, the ES5 parts that must run in any WebView), the manifest's promises, and the published APK's
// checksum and certificate pin. The APK itself is rebuilt and compared by android/acceptance/verify-apk.mjs, and
// run on Android 5 to 15 by android/acceptance/emulator.mjs (both in CI).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { autoMarginSelectors, legacyCss, ANDROID_CSP } from "../android/build-site.mjs";
import { contentEntries, updateChecksums } from "../android/build-apk.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const espree = createRequire(require.resolve("eslint"))("espree");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

test("older WebViews get plain fallbacks; current engines keep every rule", () => {
  const css = legacyCss(`@layer base { *, ::file-selector-button { margin: 0 } }
.a:where(.b), .c { color: red }
.d { inset: 0; margin-inline: auto; padding-inline: 4px 8px; width: min(1280px, calc(100% - 64px)); font-size: clamp(30px, 5vw, 58px) }
.e { overflow-wrap: anywhere; display: flex; justify-content: end; align-items: start; gap: 8px }`, postcss);
  assert.doesNotMatch(css, /@layer/, "layers unwrapped (an engine without them drops the block)");
  assert.match(css, /\*\s*\{\s*margin: 0/, "the reset survives without ::file-selector-button beside it");
  assert.match(css, /::file-selector-button\s*\{\s*margin: 0/);
  assert.match(css, /\.c\s*\{\s*color: red/, "a selector list with :where() becomes one rule per selector");
  for (const pattern of [/top: 0;\s*right: 0;\s*bottom: 0;\s*left: 0;\s*inset: 0/, /margin-left: auto;\s*margin-right: auto;\s*margin-inline: auto/,
    /padding-left: 4px;\s*padding-right: 8px;\s*padding-inline: 4px 8px/, /width: calc\(100% - 64px\);\s*width: min\(/, /font-size: 30px;\s*font-size: clamp\(/,
    /word-wrap: break-word;\s*overflow-wrap: anywhere/, /justify-content: flex-end/, /align-items: flex-start/]) assert.match(css, pattern);
  assert.doesNotMatch(css, /justify-content: end|align-items: start/, "Chromium 69 parses start/end in flex but ignores them");
  assert.deepEqual(autoMarginSelectors(".x { margin: 0 auto } .y { margin-left: 4px } .z::before { margin: auto }", postcss), [".x"]);
});

test("built-ins the page needs are supplied only when missing, and behave like the real ones", () => {
  const context = vm.createContext({});
  vm.runInContext(`delete Array.prototype.at; delete Array.prototype.findLast; delete Array.prototype.findLastIndex;
    delete String.prototype.replaceAll; delete String.prototype.at; delete Object.hasOwn; delete Object.fromEntries;
    delete Promise.allSettled; var self = this;`, context);
  vm.runInContext(read("android/polyfills.js"), context);
  const results = vm.runInContext(`({
    at: [[1, 2, 3].at(-1), "abc".at(-1), new Uint8Array([4, 5]).at(0)],
    findLast: [[1, 2, 3, 4].findLast((n) => n % 2), [1, 2, 3, 4].findLastIndex((n) => n > 9)],
    replaceAll: ["a.b.a".replaceAll(".", "$&$&"), "x-y-z".replaceAll("-", () => "+"), "aaa".replaceAll(/a/g, "b")],
    throws: (() => { try { "a".replaceAll(/a/, "b"); return false; } catch (error) { return error instanceof TypeError; } })(),
    hasOwn: [Object.hasOwn({ k: 1 }, "k"), Object.hasOwn({}, "toString")],
    fromEntries: Object.fromEntries(new Map([["a", 1], ["b", 2]])),
    enumerable: Object.keys(Array.prototype).length,
  })`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(results)), {
    at: [3, "c", 4], findLast: [3, -1], replaceAll: ["a..b..a", "x+y+z", "bbb"], throws: true,
    hasOwn: [true, false], fromEntries: { a: 1, b: 2 }, enumerable: 0,
  });
});

test("what must run in any WebView is ES5: the bridge and the loader that shows the update notice", async () => {
  espree.parse(read("android/bridge.js"), { ecmaVersion: 5 });
  const { androidIndex } = await import("../android/build-site.mjs");
  const html = androidIndex(read("android/bridge.js"));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, code]) => code);
  assert.equal(scripts.length, 2);
  for (const code of scripts) espree.parse(code, { ecmaVersion: 5 });
  assert.ok(html.includes(`content="${ANDROID_CSP}"`) && ANDROID_CSP.includes("connect-src 'none'"), "the page cannot connect anywhere");
  assert.match(html, /需要 69 或更高/);
});

test("the manifest: no network, storage only up to Android 9, exported only where it must be", () => {
  const manifest = read("android/AndroidManifest.xml");
  assert.doesNotMatch(manifest, /android\.permission\.INTERNET/);
  assert.match(manifest, /WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28"/);
  assert.match(manifest, /READ_EXTERNAL_STORAGE" android:maxSdkVersion="28"/, "Android 8.0 refuses writes to Download without the read permission");
  assert.match(manifest, /android:name=".MainActivity"\s+android:exported="true"/);
  assert.match(manifest, /android:name=".SavedFiles"[\s\S]*?android:exported="false"[\s\S]*?android:grantUriPermissions="true"/);
  assert.match(manifest, /MetricsOptOut" android:value="true"/);
  assert.match(manifest, /android:allowBackup="false"/);
  for (const action of ["VIEW", "SEND"]) assert.match(manifest, new RegExp(`intent\\.action\\.${action}"[\\s\\S]*?wordprocessingml\\.document`));
  assert.match(manifest, /<queries>\s*<intent>\s*<action android:name="android\.intent\.action\.VIEW" \/>\s*<data android:mimeType="application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document" \/>/,
    "Android 11+ lets the app see DOCX viewers only when it declares them");
  const activity = read("android/src/org/pkunmun/formatter2026/MainActivity.java");
  assert.match(activity, /setAllowFileAccess\(false\)/);
  assert.match(activity, /setWebContentsDebuggingEnabled\(devtoolsRequested\(\)\)/, "remote debugging only when asked for over adb");
  assert.doesNotMatch(activity, /->/, "no lambdas: the Debian dx converts Java 8 class files without them");
  // The app accepts DOCX itself (to format it): a saved result must go to a viewer, not back to the app.
  assert.match(activity, /getPackageName\(\)\.equals\(info\.activityInfo\.packageName\)\) continue;/);
  assert.match(activity, /"android\.intent\.extra\.EXCLUDE_COMPONENTS", new ComponentName\[\] \{new ComponentName\(this, MainActivity\.class\)\}/);
  assert.match(activity, /catch \(ActivityNotFoundException \| SecurityException e\)/);
});

test("checksum lines: each build replaces only its own", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sums-"));
  writeFileSync(path.join(dir, "SHA256SUMS.txt"), `# header\n${"a".repeat(64)}  PKUNMUN2026-Formatter-macOS.dmg\n${"b".repeat(64)}  PKUNMUN2026-Formatter-Windows-Setup.exe\n`);
  updateChecksums(dir, { "PKUNMUN2026-Formatter-Android.apk": "c".repeat(64) });
  const lines = readFileSync(path.join(dir, "SHA256SUMS.txt"), "utf8").trim().split("\n");
  assert.match(lines[0], /^# PKUNMUN 2026 文件排版系统 \S+ — offline installers$/);
  assert.deepEqual(lines.slice(1), [`${"c".repeat(64)}  PKUNMUN2026-Formatter-Android.apk`, `${"b".repeat(64)}  PKUNMUN2026-Formatter-Windows-Setup.exe`, `${"a".repeat(64)}  PKUNMUN2026-Formatter-macOS.dmg`]);
});

const APK = path.join(ROOT, "downloads", "PKUNMUN2026-Formatter-Android.apk");
test("the published APK: listed checksum, a real APK, signature files apart from its contents", { skip: !existsSync(APK) }, () => {
  const bytes = readFileSync(APK);
  const sums = read("downloads/SHA256SUMS.txt");
  assert.ok(sums.includes(`${createHash("sha256").update(bytes).digest("hex")}  PKUNMUN2026-Formatter-Android.apk`));
  const entries = contentEntries(bytes);
  for (const name of ["AndroidManifest.xml", "classes.dex", "resources.arsc", "assets/site/index.html", "assets/site/app.js", "assets/site/styles.css"]) assert.ok(entries[name], name);
  assert.ok(!Object.keys(entries).some((name) => name.startsWith("META-INF/") && /\.(SF|RSA|MF)$/.test(name)));
  assert.match(read("android/signing-cert.sha256").trim(), /^[0-9a-f]{64}$/);
  const version = JSON.parse(Buffer.from(entries["assets/site/version.json"]).toString("utf8"));
  assert.equal(version.version, read("VERSION").trim(), "rebuild the APK after a version bump (node android/build-apk.mjs --publish)");
});
