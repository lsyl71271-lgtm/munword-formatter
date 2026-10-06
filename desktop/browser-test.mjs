// Full shared UI against the packaged host; block every non-loopback request.
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
const moduleName = process.env.MUNWORD_PLAYWRIGHT_MODULE || "playwright";
const api = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const browserType = process.env.MUNWORD_TEST_BROWSER || "chromium";
const origin = process.env.MUNWORD_SMOKE_ORIGIN;
assert.equal(new URL(origin).hostname, "127.0.0.1");
await mkdir("output/desktop-browser", {recursive:true});
const browser = await api[browserType].launch({headless:true});
const errors = [], external = [];
try {
  const context = await browser.newContext({acceptDownloads:true, viewport:{width:1440,height:1000}});
  await context.route("**/*", async route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && new URL(url).origin !== origin) { external.push(url); await route.abort(); }
    else await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const cases = [
    ["立场文件", "01_中文立场文件"], ["工作文件", "03_中文工作文件"], ["指令草案", "05_中文指令草案"],
    ["决议草案", "07_中文决议草案"], ["友好修正案", "09_中文友好修正案"], ["非友好修正案", "10_中文非友好修正案"],
    ["决议草案", "08_English_Draft_Resolution"],
  ];
  for (const [type, source] of cases) {
    await page.goto(origin, {waitUntil:"networkidle"});
    await page.locator(".typeCard").filter({has:page.locator("b", {hasText:new RegExp("^" + type + "$")})}).click();
    await page.locator('input[type="file"]').setInputFiles("examples/acceptance-inputs/" + source + ".docx");
    await page.getByRole("button", {name:/识别文件结构/}).click();
    await page.getByRole("heading", {name:"确认识别结果"}).waitFor();
    // Verify the real editable review step exists; leave auto-recognition intact.
    assert.ok(await page.locator(".reviewSection input").count());
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", {name:/生成并下载 DOCX/}).click();
    const download = await downloadPromise;
    const target = path.resolve("output/desktop-browser/" + source + ".docx");
    await download.saveAs(target);
    const parts = unzipSync(new Uint8Array(await readFile(target)));
    assert.ok(parts["word/document.xml"].length > 100);
    await page.getByRole("button", {name:"查看实际 DOCX 页面"}).click();
    await page.frameLocator('iframe[title="原稿页面"]').locator("section.docx").first().waitFor();
    await page.frameLocator('iframe[title="生成后的 DOCX 页面"]').locator("section.docx").first().waitFor();
  }
  await page.screenshot({path:"output/desktop-browser/" + browserType + "-preview.png",fullPage:true});
  await page.getByText("从规范模板新建文件", {exact:true}).click();
  const template = page.locator(".templatePanel");
  await template.locator("textarea").fill("第一条 要求建立合作机制。\n第二条 决定继续协商。");
  const downloadPromise = page.waitForEvent("download");
  await template.getByRole("button", {name:"生成规范 DOCX"}).click();
  await (await downloadPromise).saveAs(path.resolve("output/desktop-browser/template.docx"));
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log("PASS packaged " + browserType + ": seven fixtures, editable review, DOCX export/readback, both previews, new template; external requests blocked");
} finally { await browser.close(); }
