// The local page must not deliver a result built from values the user has
// since changed (independent review, v1.7.0).  Runs local_web/app.js in jsdom
// with a fetch whose response the test releases by hand.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const html = await readFile(new URL("../local_web/index.html", import.meta.url), "utf8");
const script = await readFile(new URL("../local_web/app.js", import.meta.url), "utf8");
const MODEL = { document_type: "draft-resolution", language: "zh", title: "决议草案1.0", committee: "联合国大会", topic: "旧议题", country: "", delegate: "", sponsors: ["日本国"], signatories: ["法国"], paragraphs: [], preambulatory_clauses: [], operative_clauses: [], body_clauses: [], warnings: [] };

function page() {
  const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, ""), { runScripts: "outside-only", url: "http://127.0.0.1:8000/" });
  const { window } = dom;
  const downloads = [], pending = [];
  window.URL.createObjectURL = () => { downloads.push(Date.now()); return "blob:x"; };
  window.URL.revokeObjectURL = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLAnchorElement.prototype.click = () => {};
  window.fetch = async (url) => {
    if (String(url).includes("/api/health")) return new Response("{}", { status: 200 });
    if (String(url).includes("/api/parse/")) return new Response(JSON.stringify(MODEL), { status: 200 });
    // /api/format: resolved later by the test
    return new Promise(resolve => pending.push(() => resolve(new Response(new Blob(["docx"]), {
      status: 200, headers: { "Content-Disposition": "attachment; filename*=UTF-8''out.docx", "X-PKUNMUN-Validation": "" },
    }))));
  };
  // A strict script keeps its functions in its own scope; expose the three entry points.
  window.eval(`${script}\n;window.acceptFile = acceptFile; window.parseDocument = parseDocument; window.formatAndDownload = formatAndDownload;`);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  return { window, downloads, pending };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

for (const [label, change] of [
  ["a recognized field", window => { const input = window.document.getElementById("modelTopic"); input.value = "新议题"; input.dispatchEvent(new window.Event("input")); }],
  ["a generation option", window => { const box = window.document.getElementById("preserveOrder"); box.checked = !box.checked; box.dispatchEvent(new window.Event("change")); }],
]) {
  test(`changing ${label} while generating discards the stale result`, async () => {
    const { window, downloads, pending } = page();
    window.acceptFile(new window.File(["PK"], "a.docx"));
    await window.parseDocument();
    const generating = window.formatAndDownload();
    await settle();
    change(window);
    pending.shift()();
    await generating;
    await settle();
    assert.equal(downloads.length, 0, "the stale file was downloaded");
    assert.ok(window.document.getElementById("validationSection").classList.contains("hidden"));
    assert.equal(window.document.getElementById("generateButton").disabled, false);
  });
}

test("choosing a new file while generating resets the generate button", async () => {
  const { window, pending } = page();
  window.acceptFile(new window.File(["PK"], "a.docx"));
  await window.parseDocument();
  const generating = window.formatAndDownload();
  await settle();
  window.acceptFile(new window.File(["PK"], "b.docx"));
  pending.shift()();
  await generating;
  assert.doesNotMatch(window.document.getElementById("generateButton").innerHTML, /正在生成/);
});

test("changing options after success clears obsolete validation and preview results", async () => {
  const { window, pending } = page();
  const events = [];
  window.addEventListener("munword:model", event => events.push(event.detail));
  window.acceptFile(new window.File(["PK"], "a.docx"));
  await window.parseDocument();
  const generating = window.formatAndDownload();
  await settle(); pending.shift()(); await generating;
  assert.ok(events.at(-1).output);
  const input = window.document.getElementById("sessionLabel");
  input.value = "第二会期"; input.dispatchEvent(new window.Event("input"));
  assert.equal(events.at(-1).output, undefined);
  assert.ok(window.document.getElementById("validationSection").classList.contains("hidden"));
  assert.ok(window.document.getElementById("successBox").classList.contains("hidden"));
});
