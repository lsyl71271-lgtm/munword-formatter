// Diplomatic agreements and joint statements (shared/document-policy.json → treaties): the parties come from
// the title, the signature block gets one representative per party, and the layouts follow the two references.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { unzipSync, zipSync } from "fflate";
import { formatDocxInBrowser, parseDocxInBrowser, treatyParties } from "../app/docx-browser.ts";
import { takeSnapshot, verifyFormat } from "../app/content-guard.ts";
import { generateFromTemplate } from "../app/template-generator.ts";

const dom = new JSDOM("");
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const encoder = new TextEncoder(), decoder = new TextDecoder();
const escape = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const docx = (lines) => zipSync({
  "[Content_Types].xml": encoder.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
  "word/document.xml": encoder.encode(`<w:document xmlns:w="${W}"><w:body>${lines.map(line => `<w:p><w:r><w:t xml:space="preserve">${escape(line)}</w:t></w:r></w:p>`).join("")}<w:sectPr/></w:body></w:document>`),
});
const buffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const sample = async (name) => buffer(await readFile(new URL(`../examples/acceptance-inputs/${name}.docx`, import.meta.url)));
const text = (p) => Array.from(p.getElementsByTagNameNS(W, "*")).map(node => node.localName === "t" ? node.textContent : node.localName === "tab" && node.parentNode.localName === "r" ? "\t" : "").join("");
const attr = (p, tag, name) => p.getElementsByTagNameNS(W, tag)[0]?.getAttributeNS(W, name) ?? null;

async function format(content, type, overrides = {}, options = {}) {
  const model = { ...parseDocxInBrowser(content, type), ...overrides };
  const result = formatDocxInBrowser(content, model, { sessionLabel: "", submittingCountry: "", version: "v1", ...options });
  const xml = new DOMParser().parseFromString(decoder.decode(unzipSync(new Uint8Array(await result.blob.arrayBuffer()))["word/document.xml"]), "application/xml");
  return { model, result, paragraphs: Array.from(xml.getElementsByTagNameNS(W, "p")) };
}
const signatureRows = (paragraphs) => paragraphs.filter(p => p.getElementsByTagNameNS(W, "tabs").length).map(text);

test("parties come from the title; a separator inside a known name does not split it", () => {
  assert.deepEqual(treatyParties(["日本国、巴西联邦共和国与加拿大关于海洋合作的协定"], "zh"), ["日本国", "巴西联邦共和国", "加拿大"]);
  assert.deepEqual(treatyParties(["中华人民共和国、法兰西共和国、大不列颠及北爱尔兰联合王国和德意志联邦共和国关于搜救的协定"], "zh"),
    ["中华人民共和国", "法兰西共和国", "大不列颠及北爱尔兰联合王国", "德意志联邦共和国"]);
  assert.deepEqual(treatyParties(["日本国、法兰西共和国、加拿大", "就海洋治理的联合声明"], "zh"), ["日本国", "法兰西共和国", "加拿大"]);
  assert.deepEqual(treatyParties(["日本国、法兰西共和国和加拿大联合声明"], "zh"), ["日本国", "法兰西共和国", "加拿大"]);
  assert.deepEqual(treatyParties(["Joint Statement of Japan, Trinidad and Tobago and Canada on Ocean Monitoring"], "en"), ["Japan", "Trinidad and Tobago", "Canada"]);
  assert.deepEqual(treatyParties(["Agreement between Japan and Canada on Fisheries"], "en"), ["Japan", "Canada"]);
  // A title without a treaty word names no parties.
  assert.deepEqual(treatyParties(["工作文件 [编号]"], "zh"), []);
});

test("diplomatic agreement: reference layout, and the missing representative is added with the names kept", async () => {
  const { model, result, paragraphs } = await format(await sample("12_中文外交协定"), "diplomatic-agreement");
  assert.deepEqual(model.sponsors, ["日本国", "巴西联邦共和国", "加拿大"]);
  assert.ok(result.validations.every(item => item.status !== "error"));
  const [title] = paragraphs;
  assert.deepEqual([attr(title, "jc", "val"), attr(title, "spacing", "line"), attr(title, "spacing", "lineRule"), attr(title, "sz", "val"), attr(title, "b", "val")], ["center", "624", "exact", "32", "1"]);
  const chapter = paragraphs.find(p => text(p) === "第一章 合作范围");
  assert.deepEqual([attr(chapter, "jc", "val"), attr(chapter, "b", "val"), attr(chapter, "sz", "val")], ["center", "1", "24"]);
  const article = paragraphs.find(p => text(p).startsWith("第一条"));
  assert.deepEqual([attr(article, "jc", "val"), attr(article, "spacing", "line"), attr(article, "ind", "firstLine")], ["both", "468", "480"]);
  // Empty paragraphs between the title and the signature block are dropped.
  assert.equal(paragraphs.filter(p => !text(p).trim()).length, 0);
  assert.deepEqual(signatureRows(paragraphs), ["\t日本国代表\t巴西联邦共和国代表\t加拿大代表", "\t示例甲\t示例乙\t"]);
  assert.match(result.validations.find(item => item.code === "structural_edits").detail, /补上：加拿大代表/);
});

test("joint statement: four parties make two rows of two; the opening stays unnumbered and a quotation is set apart", async () => {
  const { model, paragraphs } = await format(await sample("13_中文联合声明"), "joint-statement");
  assert.equal(model.sponsors.length, 4);
  const texts = paragraphs.map(text);
  assert.ok(texts.includes("2026年5月1日，四方在东京举行会谈，共同声明如下："));
  assert.ok(texts.includes("1. 四方重申对《联合国海洋法公约》的承诺。") && texts.includes("2. 四方同意每年举行一次部长级会议。"));
  const quote = paragraphs.find(p => text(p).startsWith("“"));
  assert.deepEqual([attr(quote, "ind", "left"), attr(quote, "i", "val")], ["240", "1"]);
  const body = paragraphs.find(p => text(p).startsWith("1. "));
  assert.deepEqual([attr(body, "spacing", "before"), attr(body, "spacing", "after"), attr(body, "spacing", "line"), attr(body, "jc", "val")], ["340", "330", "240", "left"]);
  assert.deepEqual(signatureRows(paragraphs), ["\t日本国代表\t法兰西共和国代表", "\t\t", "\t巴西联邦共和国代表\t加拿大代表", "\t\t"]);
});

test("English joint statement: long labels wrap to another row; step 03 parties decide the block", async () => {
  const content = await sample("14_English_Joint_Statement");
  const { paragraphs } = await format(content, "joint-statement");
  assert.deepEqual(signatureRows(paragraphs), [
    "\tRepresentative of Japan\tRepresentative of Trinidad and Tobago", "\tSample Delegate A\t",
    "\tRepresentative of Canada", "\tSample Delegate B",
  ]);
  const edited = await format(content, "joint-statement", { sponsors: ["Japan", "Canada"] });
  assert.deepEqual(signatureRows(edited.paragraphs), ["\tRepresentative of Japan\tRepresentative of Canada", "\tSample Delegate A\tSample Delegate B"]);
});

test("fewer than two parties: no signature block is invented, and step 03 is asked for", async () => {
  const { model, result, paragraphs } = await format(buffer(docx(["工作文件 [编号]", "正文一段。"])), "diplomatic-agreement");
  assert.deepEqual(model.sponsors, []);
  assert.deepEqual(signatureRows(paragraphs), []);
  assert.ok(result.validations.some(item => /至少两个签署方/.test(item.detail)));
});

test("the guard refuses a signature block that drops a name or a statement number that changes the text", () => {
  const document = new DOMParser().parseFromString(decoder.decode(unzipSync(docx(["甲国与乙国关于合作的协定", "各方同意合作。", "甲国代表    乙国代表", "张三    李四"]))["word/document.xml"]), "application/xml");
  const before = takeSnapshot(document);
  const [, body, labels, names] = Array.from(document.getElementsByTagNameNS(W, "p"));
  const log = new Map();
  const rebuilt = (line) => {
    const p = document.createElementNS(W, "w:p"), run = p.appendChild(document.createElementNS(W, "w:r"));
    for (const part of line.split("\t")) {
      if (run.childNodes.length) run.appendChild(document.createElementNS(W, "w:tab"));
      run.appendChild(document.createElementNS(W, "w:t")).textContent = part;
    }
    labels.parentNode.insertBefore(p, labels);
    log.set(p, { kind: "signature", key: "signature", expected: JSON.stringify(["甲国代表", "乙国代表"]), created: true });
  };
  rebuilt("\t甲国代表\t乙国代表");
  rebuilt("\t张三\t");
  for (const p of [labels, names]) { log.set(p, { kind: "signature", key: "signature" }); p.remove(); }
  body.getElementsByTagNameNS(W, "t")[0].textContent = "1. 各方同意合作！";
  log.set(body, { kind: "statement-number", expected: "1. 各方同意合作！" });
  const problems = verifyFormat(before, document, log, [], []).join("；");
  assert.match(problems, /签字栏的姓名被删除、改写或新增/);
  assert.match(problems, /编号以外的内容发生变化/);
});

test("a draft resolution is saved under the uploaded file's own name; the other types keep the house name", async () => {
  const resolution = await format(await sample("07_中文决议草案"), "draft-resolution", {}, { sourceName: "我的决议草案 第三稿.docx" });
  assert.equal(resolution.result.filename, "我的决议草案 第三稿.docx");
  const agreement = await format(await sample("12_中文外交协定"), "diplomatic-agreement", {}, { sourceName: "随便的名字.docx" });
  assert.equal(agreement.result.filename, "外交协定 日本国 v1.docx");
});

test("new treaty documents from the template get a title and a signature block for every party", async () => {
  const result = generateFromTemplate("joint-statement", { language: "zh", committee: "", topic: "海洋治理", country: "", delegate: "", sponsors: "甲国、乙国、丙国", signatories: "", body: "各方声明如下：\n各方支持合作。" });
  const xml = new DOMParser().parseFromString(decoder.decode(unzipSync(new Uint8Array(await result.blob.arrayBuffer()))["word/document.xml"]), "application/xml");
  const paragraphs = Array.from(xml.getElementsByTagNameNS(W, "p"));
  assert.deepEqual(paragraphs.slice(0, 2).map(text), ["甲国、乙国、丙国", "就海洋治理的联合声明"]);
  assert.deepEqual(signatureRows(paragraphs), ["\t甲国代表\t乙国代表\t丙国代表", "\t\t\t"]);
  assert.throws(() => generateFromTemplate("diplomatic-agreement", { language: "zh", committee: "", topic: "", country: "", delegate: "", sponsors: "", signatories: "", body: "正文" }), /签署方/);
});
