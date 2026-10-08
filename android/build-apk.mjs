// Builds the Android app: the same page as the website and the desktop apps (android/build-site.mjs) in a
// WebView activity (android/src). No Gradle and no Android Studio: the Ubuntu/Debian packages
//   aapt (aapt2)  dalvik-exchange (dx)  zipalign  apksigner  libandroid-23-java (android.jar)  a JDK (javac)
// are enough. Each can be overridden: AAPT2, DX, ZIPALIGN, APKSIGNER, JAVAC, ANDROID_JAR.
//
//   node android/build-apk.mjs [--skip-site] [--publish]
//
// Output (dist/android/):
// - PKUNMUN2026-Formatter-Android-unsigned.apk: aligned, unsigned. Entries in a fixed order with a fixed date, so
//   the same source gives the same entries; the published APK's entries (apart from its signature) must match.
// - PKUNMUN2026-Formatter-Android.apk: signed (v1 for Android 5–6, v2 + v3 for 7+) when a key is given with
//   MUNWORD_ANDROID_KEYSTORE, MUNWORD_ANDROID_KEYSTORE_PASSWORD and MUNWORD_ANDROID_KEY_ALIAS (key password
//   MUNWORD_ANDROID_KEY_PASSWORD, default: the keystore password). The key never enters the repository; its
//   certificate's SHA-256 is pinned in android/signing-cert.sha256 and checked here.
// --publish (needs the key) copies the signed APK to downloads/ and updates its line in downloads/SHA256SUMS.txt.
// Requires pnpm build:local-tools first (the shared stylesheet the page is built from).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { unzipSync } from "fflate";
import { buildAndroidSite } from "./build-site.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "dist", "android");
const WORK = path.join(OUT, "build");
const VERSION = readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
export const APK_NAME = "PKUNMUN2026-Formatter-Android.apk";
export const UNSIGNED_NAME = "PKUNMUN2026-Formatter-Android-unsigned.apk";
export const MIN_SDK = 21; // Android 5.0
export const TARGET_SDK = 34; // Android 14
const [major, minor, patch] = VERSION.split(".").map(Number);
// Android-only updates of the same program version (the first 1.8.5 APK was versionCode 10805, revision 1): each
// raises the revision, so phones install it over the previous APK. Back to 1 with the next VERSION.
export const ANDROID_REVISION = 2;
export const VERSION_CODE = (major * 10000 + minor * 100 + patch) * 100 + ANDROID_REVISION;
export const VERSION_NAME = ANDROID_REVISION > 1 ? `${VERSION}.${ANDROID_REVISION}` : VERSION;
const ANDROID_JAR = process.env.ANDROID_JAR || "/usr/lib/android-sdk/platforms/android-23/android.jar";
const tool = (name, fallback) => process.env[name] || fallback;
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...options });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? files(full, base) : [path.relative(base, full).split(path.sep).join("/")];
}).sort();

// A plain ZIP: entries in the given order, all dated 2008-01-01 00:00 (DOS time, as Android's own reproducible
// builds do), no extra fields. Entries listed in `stored` are kept uncompressed (resources.arsc must be, for
// Android 11+); zipalign then puts them on 4-byte boundaries.
const DOS_TIME = 0, DOS_DATE = ((2008 - 1980) << 9) | (1 << 5) | 1;
function writeZip(entries, stored) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const store = stored(name);
    const body = store ? Buffer.from(data) : deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(store ? 0 : 8, 8); local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(store ? 0 : 8, 10); central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// The APK's entries without its v1 signature files: what the source determines, for comparing builds.
export function contentEntries(apkBytes) {
  const entries = unzipSync(new Uint8Array(apkBytes));
  return Object.fromEntries(Object.entries(entries)
    .filter(([name]) => !/^META-INF\/([^/]+\.(SF|RSA|DSA|EC)|MANIFEST\.MF)$/.test(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function signingCertificate(apk) {
  const output = run(tool("APKSIGNER", "apksigner"), ["verify", "--verbose", "--print-certs", "--min-sdk-version", String(MIN_SDK), apk]);
  const certificate = /Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})/.exec(output);
  if (!certificate) throw new Error(`apksigner printed no certificate for ${apk}:\n${output}`);
  return { output, certificate: certificate[1] };
}

export async function buildApk({ skipSite = false } = {}) {
  const site = skipSite ? path.join(OUT, "site") : await buildAndroidSite();
  if (!existsSync(path.join(site, "index.html"))) throw new Error(`${site} has no index.html: build the Android page first`);
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  // Resources and manifest.
  run(tool("AAPT2", "aapt2"), ["compile", "--no-crunch", "--dir", path.join(HERE, "res"), "-o", path.join(WORK, "res.zip")]);
  const assets = path.join(WORK, "assets");
  cpSync(site, path.join(assets, "site"), { recursive: true });
  run(tool("AAPT2", "aapt2"), ["link", "-o", path.join(WORK, "base.apk"), "-I", ANDROID_JAR, "--manifest", path.join(HERE, "AndroidManifest.xml"),
    "--min-sdk-version", String(MIN_SDK), "--target-sdk-version", String(TARGET_SDK),
    "--version-code", String(VERSION_CODE), "--version-name", VERSION_NAME, "-A", assets, path.join(WORK, "res.zip")]);

  // Code: Java 8 class files (no lambdas, so the Debian dx can convert them), then one classes.dex.
  const javac = tool("JAVAC", "javac");
  const stubs = path.join(WORK, "stubs"), classes = path.join(WORK, "classes");
  const stubSources = files(path.join(HERE, "stubs")).map((file) => path.join(HERE, "stubs", file));
  run(javac, ["-source", "8", "-target", "8", "-Xlint:-options", "-encoding", "UTF-8", "-bootclasspath", ANDROID_JAR, "-d", stubs, ...stubSources]);
  const sources = files(path.join(HERE, "src")).map((file) => path.join(HERE, "src", file));
  run(javac, ["-source", "8", "-target", "8", "-Xlint:all,-options", "-Werror", "-encoding", "UTF-8", "-bootclasspath", ANDROID_JAR,
    "-classpath", stubs, "-implicit:none", "-d", classes, ...sources]);
  run(tool("DX", "dalvik-exchange"), ["--dex", `--min-sdk-version=${MIN_SDK}`, `--output=${path.join(WORK, "classes.dex")}`, ...files(classes)], { cwd: classes });

  // Package: manifest, code, resource table, resources, assets; fixed order and date.
  const base = unzipSync(new Uint8Array(readFileSync(path.join(WORK, "base.apk"))));
  base["classes.dex"] = new Uint8Array(readFileSync(path.join(WORK, "classes.dex")));
  const rank = (name) => (name === "AndroidManifest.xml" ? 0 : name === "classes.dex" ? 1 : name === "resources.arsc" ? 2 : name.startsWith("res/") ? 3 : 4);
  const order = Object.keys(base).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  writeFileSync(path.join(WORK, "unaligned.apk"), writeZip(order.map((name) => [name, base[name]]), (name) => name === "resources.arsc" || name.endsWith(".png")));
  const unsigned = path.join(OUT, UNSIGNED_NAME);
  run(tool("ZIPALIGN", "zipalign"), ["-f", "-p", "4", path.join(WORK, "unaligned.apk"), unsigned]);
  run(tool("ZIPALIGN", "zipalign"), ["-c", "-p", "4", unsigned]);

  const result = { version: VERSION, versionName: VERSION_NAME, versionCode: VERSION_CODE, minSdk: MIN_SDK, targetSdk: TARGET_SDK, unsigned, entries: order.length };
  if (process.env.MUNWORD_ANDROID_KEYSTORE) {
    const signed = path.join(OUT, APK_NAME);
    const password = process.env.MUNWORD_ANDROID_KEYSTORE_PASSWORD;
    if (!password || !process.env.MUNWORD_ANDROID_KEY_ALIAS) throw new Error("MUNWORD_ANDROID_KEYSTORE_PASSWORD and MUNWORD_ANDROID_KEY_ALIAS are needed with the keystore");
    run(tool("APKSIGNER", "apksigner"), ["sign", "--ks", process.env.MUNWORD_ANDROID_KEYSTORE, "--ks-pass", "env:MUNWORD_ANDROID_KEYSTORE_PASSWORD",
      "--ks-key-alias", process.env.MUNWORD_ANDROID_KEY_ALIAS, "--key-pass", `env:${process.env.MUNWORD_ANDROID_KEY_PASSWORD ? "MUNWORD_ANDROID_KEY_PASSWORD" : "MUNWORD_ANDROID_KEYSTORE_PASSWORD"}`,
      "--min-sdk-version", String(MIN_SDK), "--v1-signing-enabled", "true", "--v2-signing-enabled", "true", "--v3-signing-enabled", "true",
      "--out", signed, unsigned]);
    const { output, certificate } = signingCertificate(signed);
    for (const scheme of ["v1", "v2", "v3"]) {
      if (!new RegExp(`Verified using ${scheme} scheme \\(.*\\): true`).test(output)) throw new Error(`${APK_NAME} is not signed with the ${scheme} scheme:\n${output}`);
    }
    const pinned = readFileSync(path.join(HERE, "signing-cert.sha256"), "utf8").trim();
    if (certificate !== pinned) throw new Error(`${APK_NAME} is signed by ${certificate}, android/signing-cert.sha256 pins ${pinned}`);
    Object.assign(result, { signed, certificate, sha256: sha256(readFileSync(signed)), bytes: statSync(signed).size });
  }
  return result;
}

// downloads/SHA256SUMS.txt lists every installer; each build updates only its own lines.
export function updateChecksums(downloads, updates) {
  const file = path.join(downloads, "SHA256SUMS.txt");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => /^[0-9a-f]{64}  /.test(line)) : [];
  const sums = new Map(lines.map((line) => [line.slice(66), line.slice(0, 64)]));
  for (const [name, digest] of Object.entries(updates)) sums.set(name, digest);
  const ordered = [...sums].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  writeFileSync(file, `# PKUNMUN 2026 文件排版系统 ${VERSION} — offline installers\n${ordered.map(([name, digest]) => `${digest}  ${name}`).join("\n")}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const result = await buildApk({ skipSite: args.includes("--skip-site") });
  console.log(`Android ${result.versionName} (versionCode ${result.versionCode}, Android 5.0+ / API ${result.minSdk}, target API ${result.targetSdk}): ${result.entries} entries`);
  console.log(`  unsigned: ${result.unsigned}`);
  if (result.signed) console.log(`  signed:   ${result.signed} (${(result.bytes / 1048576).toFixed(2)} MB, sha256 ${result.sha256}, certificate ${result.certificate})`);
  if (args.includes("--publish")) {
    if (!result.signed) throw new Error("--publish needs the signing key (MUNWORD_ANDROID_KEYSTORE…)");
    const downloads = path.join(ROOT, "downloads");
    copyFileSync(result.signed, path.join(downloads, APK_NAME));
    updateChecksums(downloads, { [APK_NAME]: result.sha256 });
    console.log(`Published ${APK_NAME} to downloads/`);
  }
}
