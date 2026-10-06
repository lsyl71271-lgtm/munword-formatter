// The oldest Chromium the page supports, measured instead of assumed. Downloads Chromium snapshots
// (Linux x64) and opens the offline page in each over DevTools:
//   M98 (has findLast, lacks CSS cascade layers) → the "browser too old" notice, app.js never loads;
//   M99 (both)                                   → the full flow, same DOCX as current Chromium;
//   M109 (last Chrome for Windows 7 / 8.1)       → the full flow.
//   node desktop/acceptance/browser-floor.mjs <site dir> <work dir>
// MUNWORD_PLAYWRIGHT_MODULE points at playwright's index.mjs when it is not resolvable from here.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";

const [site, work] = process.argv.slice(2).map((p) => path.resolve(p));
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const playwright = await import(process.env.MUNWORD_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.MUNWORD_PLAYWRIGHT_MODULE).href : "playwright");
const { chromium } = playwright.chromium ? playwright : playwright.default;
const BUILDS = [
  { position: 948003, milestone: 98, expect: "notice" },
  { position: 961612, milestone: 99, expect: "flow" },
  { position: 1070002, milestone: 109, expect: "flow" },
];
const reference = path.join(ROOT, "output", "desktop-smoke", "08_English_Draft_Resolution.docx");
const results = [];
let failed = false;
for (const [index, build] of BUILDS.entries()) {
  const dir = path.join(work, String(build.position));
  const binary = path.join(dir, "chrome-linux", "chrome");
  if (!existsSync(binary)) {
    mkdirSync(dir, { recursive: true });
    execFileSync("curl", ["-sSfL", "-o", path.join(dir, "chrome-linux.zip"), `https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/${build.position}/chrome-linux.zip`]);
    execFileSync("unzip", ["-q", "-o", "chrome-linux.zip"], { cwd: dir });
  }
  const port = 9600 + index;
  const child = spawn(binary, ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(dir, "profile")}`, "about:blank"], { stdio: "ignore", env: { ...process.env, LC_ALL: "C.UTF-8" } });
  const result = { milestone: build.milestone, position: build.position, expect: build.expect };
  try {
    let browser;
    for (let attempt = 0; attempt < 40 && !browser; attempt++) {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => new Promise((resolve) => setTimeout(() => resolve(undefined), 500)));
    }
    if (!browser) throw new Error("DevTools did not come up");
    const page = await browser.contexts()[0].newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(pathToFileURL(path.join(site, "index.html")).href, { waitUntil: "load" });
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    if (build.expect === "notice") {
      await page.getByText("这个浏览器版本太旧").waitFor({ timeout: 20000 });
      result.appLoaded = await page.evaluate(() => [...document.scripts].some((s) => /app\.js$/.test(s.src)));
      if (result.appLoaded) throw new Error("app.js was loaded in a browser below the floor");
    } else {
      await page.getByRole("button", { name: /决议草案/ }).click();
      await page.locator('input[type="file"]').setInputFiles(path.join(ROOT, "examples", "acceptance-inputs", "08_English_Draft_Resolution.docx"));
      await page.getByRole("button", { name: /识别文件结构/ }).click();
      await page.getByRole("heading", { name: "确认识别结果" }).waitFor();
      await page.getByRole("button", { name: "查看实际 DOCX 页面" }).click();
      await page.frameLocator('iframe[title="原稿页面"]').locator("section.docx").first().waitFor();
      await page.evaluate(() => {
        window.__blobs = [];
        const create = URL.createObjectURL;
        URL.createObjectURL = (blob) => { window.__blobs.push(blob); return create.call(URL, blob); };
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute("download")) { window.__download = this.getAttribute("download"); return; } return click.call(this); };
      });
      await page.getByRole("button", { name: /生成并下载 DOCX/ }).click();
      await page.waitForFunction(() => window.__download);
      await page.frameLocator('iframe[title="生成后的 DOCX 页面"]').locator("section.docx").first().waitFor();
      const bytes = Buffer.from(await page.evaluate(async () => Array.from(new Uint8Array(await window.__blobs.filter((b) => b.size > 1000).pop().arrayBuffer()))));
      result.bytes = bytes.length;
      // Same document parts as current Chromium's output (the ZIP itself carries its creation time).
      if (existsSync(reference)) {
        const mine = unzipSync(new Uint8Array(bytes)), theirs = unzipSync(new Uint8Array(readFileSync(reference)));
        const names = Object.keys(theirs).sort();
        result.sameAsCurrentChromium = JSON.stringify(Object.keys(mine).sort()) === JSON.stringify(names) && names.every((name) => Buffer.from(mine[name]).equals(Buffer.from(theirs[name])));
      }
      if (result.sameAsCurrentChromium === false) throw new Error("generated DOCX differs from current Chromium's");
    }
    result.errors = errors;
    if (errors.length) throw new Error(errors.join("; "));
    await page.screenshot({ path: path.join(work, `chromium-${build.milestone}.png`) });
    await browser.close().catch(() => {});
    result.passed = true;
  } catch (error) {
    result.passed = false;
    result.error = String(error && error.message || error);
    failed = true;
  } finally {
    child.kill("SIGKILL");
  }
  console.log(`Chromium ${build.milestone}: ${result.passed ? "PASS" : "FAIL"} (${build.expect}${result.error ? " — " + result.error : ""})`);
  results.push(result);
}
writeFileSync(path.join(work, "browser-floor.json"), JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
