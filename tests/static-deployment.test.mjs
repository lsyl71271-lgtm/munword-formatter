// Run after build:static: exercise the exact deployment artifact, not a mock UI.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { unzipSync, strFromU8 } from "fflate";

const root = new URL("../static-site/", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
const script = await readFile(new URL("app.js", root), "utf8");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

test("static assets are the shared build and an explicit public-only allowlist", async () => {
  const files = (await readdir(root, { recursive: true })).sort();
  const info = JSON.parse(await readFile(new URL("version.json", root), "utf8"));
  assert.deepEqual(files, ["_headers", "index.html", "version.json", "licenses", ...Object.keys(info.assets)].sort());
  for (const [name, hash] of Object.entries(info.assets)) assert.equal(digest(await readFile(new URL(name, root))), hash, name);
  assert.equal(script, await readFile(new URL("../public/local-app.js", import.meta.url), "utf8"));
  assert.equal(await readFile(new URL("styles.css", root), "utf8"), await readFile(new URL("../public/local-styles.css", import.meta.url), "utf8"));
  assert.match(html, /app\.js\?v=[a-f0-9]{64}/);
  assert.match(html, /styles\.css\?v=[a-f0-9]{64}/);
  assert.equal(info.version, (await readFile(new URL("../VERSION", import.meta.url), "utf8")).trim());
});

const waitFor = async (predicate, message = () => "UI completed the operation") => {
  const end = Date.now() + 5000;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(predicate(), message());
};
test("published bundle recognizes and downloads DOCX without API calls or step 03 edits", async () => {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://munword.example/" });
  const { window } = dom;
  try {
    const source = await readFile(new URL("../examples/acceptance-inputs/07_中文决议草案.docx", import.meta.url));
    const downloads = [], requests = [];
    // Node's encoder returns Node Uint8Arrays. Keep the polyfills in one realm
    // so fflate's Uint8Array check matches a real browser's native objects.
    window.Uint8Array = Uint8Array;
    window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder; window.Blob = Blob;
    window.URL.createObjectURL = blob => { downloads.push(blob); return "blob:example"; };
    window.URL.revokeObjectURL = () => {};
    window.HTMLElement.prototype.scrollIntoView = () => {};
    window.HTMLAnchorElement.prototype.click = () => {};
    window.fetch = async (...args) => { requests.push(args); throw new Error("Unexpected network request"); };
    window.File.prototype.arrayBuffer = async () => source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    window.eval(script);
    await waitFor(() => window.document.querySelector('input[type="file"]'));
    assert.equal(window.document.querySelectorAll(".typeCard").length, 8);
    const button = text => [...window.document.querySelectorAll("button")].find(el => el.textContent.includes(text));
    const picker = window.document.querySelector('input[type="file"]');
    Object.defineProperty(picker, "files", { value: [new window.File([source], "sample.docx")] });
    picker.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => !button("识别文件结构").disabled);
    button("识别文件结构").click();
    await waitFor(() => window.document.querySelector(".reviewSection input"), () => window.document.body.textContent);
    assert.ok(button("下载诊断报告"));
    assert.ok(window.document.querySelector(".templatePanel"));
    window.document.querySelector("button.generate").click();
    await waitFor(() => downloads.length === 1, () => window.document.body.textContent);
    const archive = unzipSync(new Uint8Array(await downloads[0].arrayBuffer()));
    assert.match(strFromU8(archive["word/document.xml"]), /决议草案/);
    assert.equal(requests.length, 0, "user document never leaves the browser");
    assert.ok(!window.document.querySelector('[role="alert"]'), "no deployment-only error");
  } finally { window.close(); }
});
