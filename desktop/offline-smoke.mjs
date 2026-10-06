// Real-browser check of the offline desktop page (dist/desktop/site) opened from file://.
// Fails if the page makes ANY non-file request, throws, or cannot finish the whole flow:
// select type → upload → recognize → preview → generate/download. Also checks that an outdated browser
// gets the explanation instead of the app, and that the disk image's browser page reaches the app page.
//   node desktop/offline-smoke.mjs [site-dir]
// MUNWORD_PLAYWRIGHT_MODULE / MUNWORD_CHROMIUM_EXECUTABLE as in scripts/studio-browser-smoke.mjs.
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.resolve(process.argv[2] || path.join(ROOT, "dist", "desktop", "site"));
const out = path.join(ROOT, "output", "desktop-smoke");
mkdirSync(out, { recursive: true });
const playwright = await import(process.env.MUNWORD_PLAYWRIGHT_MODULE || "playwright");
const { chromium } = playwright.chromium ? playwright : playwright.default;
const browser = await chromium.launch({ headless: true, ...(process.env.MUNWORD_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MUNWORD_CHROMIUM_EXECUTABLE } : {}) });
const network = [], errors = [], csp = [];
try {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
  // Anything that is not the local page itself is recorded and refused.
  await context.route(/^(?!file:|data:|blob:|about:)/, (route) => { network.push(route.request().url()); return route.abort(); });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) csp.push(message.text()); });
  await page.goto(pathToFileURL(path.join(site, "index.html")).href, { waitUntil: "load" });
  await page.getByRole("button", { name: /决议草案/ }).click();
  await page.locator('input[type="file"]').setInputFiles(path.join(ROOT, "examples", "acceptance-inputs", "08_English_Draft_Resolution.docx"));
  await page.getByRole("button", { name: /识别文件结构/ }).click();
  await page.getByRole("heading", { name: "确认识别结果" }).waitFor();
  await page.getByRole("button", { name: "查看实际 DOCX 页面" }).click();
  await page.frameLocator('iframe[title="原稿页面"]').locator("section.docx").waitFor();
  const generated = page.waitForEvent("download");
  await page.getByRole("button", { name: /生成并下载 DOCX/ }).click();
  const download = await generated;
  const docx = path.join(out, "generated.docx");
  await download.saveAs(docx);
  await page.frameLocator('iframe[title="生成后的 DOCX 页面"]').locator("section.docx").waitFor();
  await page.getByText("成品已下载").waitFor();
  if (readFileSync(docx).subarray(0, 2).toString() !== "PK") throw new Error("Download is not a DOCX package");
  const header = await page.locator(".headerMeta").innerText();
  if (!header.includes("浏览器本地处理")) throw new Error(`Page is not in local mode: ${header}`);
  await page.screenshot({ path: path.join(out, "offline-page.png"), fullPage: false });
  // The page's own policy must refuse connections even if code tried (not just this test's router).
  const before = network.length, cspBefore = csp.length;
  const probe = await page.evaluate(async () => {
    const results = [];
    try { await fetch("https://example.com/munword-probe"); results.push("fetch-allowed"); } catch { results.push("fetch-refused"); }
    results.push(await new Promise((resolve) => { const img = new Image(); img.onload = () => resolve("image-allowed"); img.onerror = () => resolve("image-refused"); img.src = "https://example.com/munword-probe.png"; }));
    return results;
  });
  await page.waitForTimeout(300);
  if (probe.join() !== "fetch-refused,image-refused" || network.length !== before || csp.length < cspBefore + 2) throw new Error(`CSP did not refuse the probes: ${probe} network=${network.length - before} csp=${csp.length - cspBefore}`);
  csp.length = cspBefore;

  // An outdated browser (simulated by removing Array.prototype.findLast) gets the explanation, not the app.
  const old = await context.newPage();
  const oldScripts = [];
  old.on("request", (request) => { if (/\/app\.js$/.test(request.url())) oldScripts.push(request.url()); });
  await old.addInitScript(() => { delete Array.prototype.findLast; });
  await old.goto(pathToFileURL(path.join(site, "index.html")).href, { waitUntil: "load" });
  await old.getByText("这个浏览器版本太旧").waitFor();
  if (oldScripts.length) throw new Error("An outdated browser still loaded app.js");
  await old.close();

  // 直接用浏览器打开.html at the root of the disk image opens the page inside the app bundle.
  const volume = mkdtempSync(path.join(tmpdir(), "munword-volume-"));
  cpSync(path.join(ROOT, "desktop", "macos", "直接用浏览器打开.html"), path.join(volume, "直接用浏览器打开.html"));
  cpSync(site, path.join(volume, "PKUNMUN2026.app", "Contents", "Resources", "site"), { recursive: true });
  const opener = await context.newPage();
  opener.on("pageerror", (error) => errors.push(error.message));
  await opener.goto(pathToFileURL(path.join(volume, "直接用浏览器打开.html")).href);
  await opener.waitForURL(/PKUNMUN2026\.app\/Contents\/Resources\/site\/index\.html$/);
  await opener.getByRole("button", { name: /决议草案/ }).waitFor();
  await opener.close();
  // Copied somewhere without the app (and none installed): it says what to do.
  const lone = mkdtempSync(path.join(tmpdir(), "munword-lone-"));
  cpSync(path.join(ROOT, "desktop", "macos", "直接用浏览器打开.html"), path.join(lone, "直接用浏览器打开.html"));
  const stray = await context.newPage();
  await stray.goto(pathToFileURL(path.join(lone, "直接用浏览器打开.html")).href);
  await stray.getByText("没有找到程序文件").waitFor();
  await stray.close();
  console.log(JSON.stringify({ site, download: download.suggestedFilename(), header, network, errors, csp }));
} finally {
  await browser.close();
}
if (network.length || errors.length || csp.length) {
  console.error("Offline page is not self-contained", { network, errors, csp });
  process.exit(1);
}
console.log("offline desktop page: full flow passed from file:// with zero network requests; outdated-browser notice and disk-image browser page work");
