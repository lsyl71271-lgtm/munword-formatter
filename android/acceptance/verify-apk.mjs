// The published APK (downloads/PKUNMUN2026-Formatter-Android.apk) is what this source builds, signed by the pinned
// key, and declares what the app is meant to: rebuilds the unsigned APK, compares every entry with the published
// one (all but its signature files), verifies the v1/v2/v3 signatures and the certificate pin, reads the manifest
// back with aapt, and checks downloads/SHA256SUMS.txt and the install guide.
//
//   node android/acceptance/verify-apk.mjs <out dir>     (after the page's inputs exist: pnpm build:local-tools)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APK_NAME, MIN_SDK, TARGET_SDK, VERSION_CODE, VERSION_NAME, buildApk, contentEntries, signingCertificate } from "../build-apk.mjs";

const out = path.resolve(process.argv[2] || "output/android");
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const published = path.join(ROOT, "downloads", APK_NAME);
mkdirSync(out, { recursive: true });
const report = { apk: APK_NAME, passed: false, checks: [] };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) report.failed = true;
};

try {
  delete process.env.MUNWORD_ANDROID_KEYSTORE; // the comparison is with the unsigned build
  const built = await buildApk();
  const mine = contentEntries(readFileSync(built.unsigned)), theirs = contentEntries(readFileSync(published));
  const names = Object.keys(mine);
  const differing = names.filter((name) => !theirs[name] || !Buffer.from(theirs[name]).equals(Buffer.from(mine[name])));
  const extra = Object.keys(theirs).filter((name) => !mine[name]);
  check("published APK has exactly the entries this source builds", !differing.length && !extra.length,
    differing.length || extra.length ? `differ: ${differing.join(", ")}; only published: ${extra.join(", ")}` : `${names.length} entries`);

  const { output, certificate } = signingCertificate(published);
  for (const scheme of ["v1", "v2", "v3"]) check(`signed with the ${scheme} scheme`, new RegExp(`Verified using ${scheme} scheme \\(.*\\): true`).test(output));
  const pinned = readFileSync(path.join(ROOT, "android", "signing-cert.sha256"), "utf8").trim();
  check("signed by the pinned certificate (android/signing-cert.sha256)", certificate === pinned, certificate);
  report.certificate = certificate;
  report.versionName = VERSION_NAME;
  report.versionCode = VERSION_CODE;

  const badging = execFileSync(process.env.AAPT || "aapt", ["dump", "badging", published], { encoding: "utf8" });
  check("package, version", badging.includes(`package: name='org.pkunmun.formatter2026' versionCode='${VERSION_CODE}' versionName='${VERSION_NAME}'`));
  check(`Android 5.0+ (API ${MIN_SDK}), target API ${TARGET_SDK}`, badging.includes(`sdkVersion:'${MIN_SDK}'`) && badging.includes(`targetSdkVersion:'${TARGET_SDK}'`));
  const permissions = [...badging.matchAll(/^uses-permission: name='([^']+)'(?: maxSdkVersion='(\d+)')?/gm)].map(([, name, max]) => `${name}${max ? `≤${max}` : ""}`);
  check("no network permission; storage only up to Android 9", permissions.every((p) => /EXTERNAL_STORAGE≤28$/.test(p)), permissions.join(", "));
  check("launcher label", badging.includes("application-label:'PKUNMUN 排版'"));

  const bytes = readFileSync(published);
  report.sha256 = createHash("sha256").update(bytes).digest("hex");
  report.bytes = bytes.length;
  const sums = readFileSync(path.join(ROOT, "downloads", "SHA256SUMS.txt"), "utf8");
  check("downloads/SHA256SUMS.txt lists it", sums.includes(`${report.sha256}  ${APK_NAME}`), report.sha256);
  const guide = readFileSync(path.join(ROOT, "downloads", "PKUNMUN2026-Install-Guide.txt"), "utf8");
  check("the install guide names its checksum", guide.includes(report.sha256));
  report.passed = !report.failed;
} catch (error) {
  check("verification ran", false, String(error.stack || error));
}
writeFileSync(path.join(out, "apk.json"), JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
