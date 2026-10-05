// Final audit: regression cases independent of the formatter's own validators.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { zipSync } from "fflate";
import { readPackage } from "../app/docx-safety.ts";
import { verifyPackage } from "../app/content-guard.ts";
import { parseDocxInBrowser, formatDocxInBrowser } from "../app/docx-browser.ts";

const dom = new JSDOM("");
globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer;
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/package/2006/relationships";
const enc = new TextEncoder();
const line = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const pack = (extra = {}) => zipSync({
  "[Content_Types].xml": enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
  "word/document.xml": enc.encode(`<w:document xmlns:w="${W}"><w:body>${["工作文件", "委员会：大会", "议题：合作", "起草国：中国", "1. 支持合作。"].map(line).join("")}<w:sectPr/></w:body></w:document>`),
  ...extra,
}, { level: 0 });

test("invalid XML UTF-8 is rejected, never silently replaced by U+FFFD", () => {
  const bytes = enc.encode(`<w:document xmlns:w="${W}"><w:body/></w:document>`);
  bytes[bytes.length - 2] = 255;
  assert.throws(() => readPackage(pack({ "word/document.xml": bytes }).buffer), /编码/);
});

test("local ZIP encryption flags cannot disagree with the central directory", () => {
  const bytes = pack(), view = new DataView(bytes.buffer);
  view.setUint16(6, view.getUint16(6, true) | 1, true);
  assert.throws(() => readPackage(bytes.buffer), /加密|不一致/);
});

test("prefixed relationship targets are protected as strictly as default-namespace targets", () => {
  const rel = target => enc.encode(`<r:Relationships xmlns:r="${R}"><r:Relationship Id="x" Type="hyperlink" Target="${target}" TargetMode="External"/></r:Relationships>`);
  assert.ok(verifyPackage(pack({ "word/_rels/document.xml.rels": rel("https://www.un.org/") }), pack({ "word/_rels/document.xml.rels": rel("https://example.invalid/") })).length);
});

test("duplicate relationship IDs cannot overwrite an earlier protected target", () => {
  const rel = enc.encode(`<Relationships xmlns="${R}"><Relationship Id="x" Target="old"/><Relationship Id="x" Target="same"/></Relationships>`);
  assert.throws(() => verifyPackage(pack({ "word/_rels/document.xml.rels": rel }), pack()), /重复/);
});

test("invalid step-03 XML characters are input errors, not invalid generated DOCX", () => {
  const bytes = pack().buffer, model = parseDocxInBrowser(bytes, "working-paper");
  for (const value of ["A\0B", "A\uffffB", "A\ud800B"]) {
    assert.throws(() => formatDocxInBrowser(bytes, { ...model, topic: value }, {sessionLabel:"",submittingCountry:"",version:"v1"}), /字段|字符/);
  }
});
