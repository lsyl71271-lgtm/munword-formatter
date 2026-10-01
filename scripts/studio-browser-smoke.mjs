// Optional real-browser test. Does not fill step-03 fields or use private inputs.
import { mkdir } from "node:fs/promises";
import path from "node:path";
const { chromium } = await import(process.env.MUNWORD_PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.MUNWORD_SMOKE_ORIGIN || "http://127.0.0.1:5177";
const url = new URL(origin);
if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Use a local test server");
await mkdir("output/browser-smoke", { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.MUNWORD_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MUNWORD_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (new URL(request.url()).origin !== url.origin && /^https?:/.test(request.url())) external.push(request.url()); });
  await page.goto(origin, { waitUntil: "networkidle" });
  if (process.env.MUNWORD_SMOKE_LOCAL_API === "1") {
    await page.locator('#fileInput').setInputFiles("examples/acceptance-inputs/08_English_Draft_Resolution.docx");
    await page.locator('#parseButton').click();
    await page.locator('#reviewSection:not(.hidden)').waitFor();
    const download = page.waitForEvent("download");
    await page.locator('#generateButton').click();
    await (await download).saveAs(path.resolve("output/browser-smoke/local-generated.docx"));
    await page.getByText("诊断报告与实际页面", { exact: true }).click();
    await page.locator('#showActualPages').click();
    for (const title of ["原稿页面", "成稿页面"]) await page.frameLocator(`iframe[title="${title}"]`).locator("section.docx").waitFor();
    if (!await page.getByText(/视觉核验：尚未执行/).count()) throw new Error("Missing local diagnostic status");
    await page.getByText("从规范模板新建文件", { exact: true }).click();
    await page.locator('#new_body').fill("第一条 要求建立合作机制。\n第二条 决定继续协商。");
    const template = page.waitForEvent("download");
    await page.locator('#newDocumentGenerate').click();
    await (await template).saveAs(path.resolve("output/browser-smoke/local-template.docx"));
    await page.screenshot({ path: "output/browser-smoke/local-desktop.png", fullPage: true });
    if (errors.length || external.length) throw new Error(JSON.stringify({ errors, external }));
    console.log("PASS local API upload → download → previews; diagnostics; independent template; no external document requests");
    process.exitCode = 0;
  } else {
  await page.getByRole("button", { name: /决议草案/ }).click();
  await page.locator('input[type="file"]').setInputFiles("examples/acceptance-inputs/08_English_Draft_Resolution.docx");
  await page.getByRole("button", { name: /识别文件结构/ }).click();
  await page.getByRole("heading", { name: "确认识别结果" }).waitFor();
  await page.getByRole("button", { name: "查看实际 DOCX 页面" }).click();
  await page.frameLocator('iframe[title="原稿页面"]').locator("section.docx").waitFor();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /生成并下载 DOCX/ }).click();
  const download = await downloadPromise;
  await download.saveAs(path.resolve("output/browser-smoke/generated.docx"));
  await page.frameLocator('iframe[title="生成后的 DOCX 页面"]').locator("section.docx").waitFor();
  await page.getByText("识别依据与诊断报告", { exact: true }).click();
  if (!await page.getByText(/视觉核验：尚未执行/).count()) throw new Error("Missing truthful visual status");
  await page.screenshot({ path: "output/browser-smoke/desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2)) throw new Error("Mobile horizontal overflow");
  await page.screenshot({ path: "output/browser-smoke/mobile.png", fullPage: true });
  await page.getByText("从规范模板新建文件", { exact: true }).click();
  const template = page.locator(".templatePanel");
  await template.locator("textarea").fill("第一条 要求建立合作机制。\n第二条 决定继续协商。");
  const newPromise = page.waitForEvent("download");
  await template.getByRole("button", { name: "生成规范 DOCX" }).click();
  await (await newPromise).saveAs(path.resolve("output/browser-smoke/new-template.docx"));
  if (errors.length || external.length) throw new Error(JSON.stringify({ errors, external }));
  console.log("PASS upload → auto recognition → download → actual preview; new template; mobile; no external document requests");
  }
} finally { await browser.close(); }
