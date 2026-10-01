import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { zipSync, unzipSync } from "fflate";
import { generateFromTemplate } from "../app/template-generator.ts";
import { parseDocxInBrowser } from "../app/docx-browser.ts";
import { preparePreview } from "../app/preview-safety.ts";
import { buildDiagnosticReport } from "../app/diagnostics.ts";

const dom = new JSDOM(""); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer;
const types = ["position-paper", "working-paper", "draft-directive", "draft-resolution", "friendly-amendment", "unfriendly-amendment"];
for (const type of types) for (const language of ["zh", "en"]) {
  test(`template generation uses the protected engine: ${type}/${language}`, async () => {
    const input = { language, committee: language === "zh" ? "联合国大会" : "General Assembly", topic: language === "zh" ? "环境合作" : "Environmental cooperation", country: language === "zh" ? "日本国" : "Japan", delegate: "Sample Delegate", sponsors: "Japan, Canada", signatories: "France", body: language === "zh" ? "回顾现有合作，\n第一条 要求各方提交报告；\n（一）明确核验方法；\n第二条 决定继续协商。" : "Recalling existing cooperation,\n1. Requests all parties to submit reports;\n(a) Identifies verification methods;\n2. Decides to continue consultations." };
    const result = generateFromTemplate(type, input);
    assert.ok(result.validations.every(item => item.status !== "error"));
    const bytes = await result.blob.arrayBuffer(), model = parseDocxInBrowser(bytes, type);
    assert.equal(model.committee, input.committee);
    assert.ok(model.paragraphs.some(text => text.includes(language === "zh" ? "提交报告" : "submit reports")));
    assert.ok(model.paragraphs.every(text => !text.includes("{@bodyXml}")));
    const parts = unzipSync(new Uint8Array(bytes));
    const xml = new DOMParser().parseFromString(new TextDecoder().decode(parts["word/document.xml"]), "application/xml");
    const sizes = [...xml.getElementsByTagNameNS("*", "sz")].map(node => node.getAttribute("w:val"));
    assert.ok(sizes.length && sizes.every(size => size === "24"));
    if (process.env.MUNWORD_TEMPLATE_QA_DIR) {
      await mkdir(process.env.MUNWORD_TEMPLATE_QA_DIR, { recursive: true });
      await writeFile(`${process.env.MUNWORD_TEMPLATE_QA_DIR}/${type}-${language}.docx`, new Uint8Array(bytes));
    }
  });
}
test("template text is escaped, never interpreted as XML or template code", async () => {
  const body = '1. Requests A & B <w:r> {committee} to remain literal.';
  const result = generateFromTemplate("working-paper", { language: "en", committee: "Assembly", topic: "Safety", country: "", delegate: "", sponsors: "Japan", signatories: "", body });
  const model = parseDocxInBrowser(await result.blob.arrayBuffer(), "working-paper");
  assert.ok(model.paragraphs.some(text => text.includes("A & B <w:r> {committee}")));
  assert.throws(() => generateFromTemplate("working-paper", { language: "en", body: "", committee: "", topic: "", country: "", delegate: "", sponsors: "", signatories: "" }), /正文/);
});
test("preview strips external relationships without changing the downloadable input", () => {
  const encoder = new TextEncoder();
  const original = zipSync({ "[Content_Types].xml": encoder.encode("<Types/>"), "word/document.xml": encoder.encode('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'), "word/_rels/document.xml.rels": encoder.encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" TargetMode="External" Target="https://example.invalid/tracker.png"/><Relationship Id="rId2" Target="media/image.png"/></Relationships>') }).buffer;
  const copy = new Uint8Array(original.slice(0));
  const prepared = unzipSync(new Uint8Array(preparePreview(original)));
  assert.ok(!new TextDecoder().decode(prepared["word/_rels/document.xml.rels"]).includes("tracker"));
  assert.ok(new TextDecoder().decode(prepared["word/_rels/document.xml.rels"]).includes("rId2"));
  assert.deepEqual(new Uint8Array(original), copy);
  assert.throws(() => preparePreview(new Uint8Array([1, 2, 3]).buffer), /校验|损坏/);
});
test("diagnostics never claim visual compliance and don't mutate recognized content", async () => {
  const data = await readFile(new URL("../examples/acceptance-inputs/08_English_Draft_Resolution.docx", import.meta.url));
  const model = parseDocxInBrowser(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), "draft-resolution");
  const original = JSON.stringify(model), report = buildDiagnosticReport(model);
  assert.equal(report.visual_status, "not_run"); assert.equal(report.structure_status, "not_run");
  assert.equal(JSON.stringify(model), original);
  assert.ok(report.clauses.every(item => item.paragraph >= 1 && item.reason));
});
