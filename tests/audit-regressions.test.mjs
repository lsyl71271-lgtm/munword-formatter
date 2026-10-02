// Regressions from the independent v1.7.1 audit (2026-10), browser engine.
// Each case failed before its fix.  Expectations are read back with plain DOM
// calls (own text, run properties, indents), not with engine helpers.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { zipSync, unzipSync } from "fflate";
import { parseDocxInBrowser, formatDocxInBrowser } from "../app/docx-browser.ts";
import { readPackage } from "../app/docx-safety.ts";
import { preparePreview } from "../app/preview-safety.ts";

const dom = new JSDOM(""); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer;
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const enc = new TextEncoder(), dec = new TextDecoder();
const nodes = (parent, name) => [...parent.getElementsByTagNameNS(W, name)];
const run = (text, props = "") => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const line = (text, props = "") => `<w:p>${run(text, props)}</w:p>`;
const ZH_DR = ["决议草案", "委员会：安全理事会", "议题：网络安全", "起草国：德国、法国", "附议国：美国、中国", "安全理事会，", "认识到网络安全的重要性，"].map(t => line(t)).join("");

function archive(body, extra = {}) {
  return zipSync({
    "[Content_Types].xml": enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "word/document.xml": enc.encode(`<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}<w:sectPr/></w:body></w:document>`),
    ...extra,
  }).buffer;
}
const format = (input, type, overrides = {}) => formatDocxInBrowser(input, { ...parseDocxInBrowser(input, type), ...overrides }, { sessionLabel: "", submittingCountry: "", version: "v1" });
async function documentOf(result) {
  const parts = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  return new DOMParser().parseFromString(dec.decode(parts["word/document.xml"]), "application/xml");
}
const textOf = p => nodes(p, "t").filter(t => !t.closest("del")).map(t => t.textContent).join("");
const errors = result => result.validations.filter(v => v.status === "error");
const on = (r, tag) => { const n = nodes(r, tag)[0]; return Boolean(n) && !["0", "false", "off"].includes(n.getAttributeNS(W, "val") || ""); };
/** Characters of the document that carry a property, in order. */
const marked = (xml, tag) => nodes(xml, "r").filter(r => on(r, tag)).map(r => nodes(r, "t").map(t => t.textContent).join("")).join("");
const paragraph = (xml, start) => nodes(xml, "p").find(p => textOf(p).startsWith(start));

// ---------------------------------------------------------------- B1 hidden / struck text

test("a whole hidden clause stays hidden when its ending would be normalized", async () => {
  const input = archive(ZH_DR + line("第一条 决定继续审议此问题。") + line("第二条 内部备注：此条暂不公开，待磋商后再议。", "<w:vanish/>") + line("第三条 请秘书长提交报告。"));
  const result = format(input, "draft-resolution");
  assert.deepEqual(errors(result), []);
  const xml = await documentOf(result);
  assert.ok(marked(xml, "vanish").startsWith("第二条 内部备注：此条暂不公开，待磋商后再议"));
});

test("a whole struck clause keeps its strikethrough", async () => {
  const input = archive(ZH_DR + line("第一条 决定继续审议此问题。") + line("第二条 呼吁各国立即停止一切网络攻击。", "<w:strike/>") + line("第三条 请秘书长提交报告。"));
  const result = format(input, "draft-resolution");
  assert.deepEqual(errors(result), []);
  assert.ok(marked(await documentOf(result), "strike").includes("各国立即停止一切网络攻击"));
});

test("a struck or hidden name in a country list is never turned into a plain name", async () => {
  const signatories = `<w:p>${run("附议国：")}${run("中国、")}${run("日本", "<w:strike/>")}${run("、美国、")}${run("巴西", "<w:vanish/>")}</w:p>`;
  const input = archive(["决议草案", "委员会：安全理事会", "议题：网络安全", "起草国：法国、德国"].map(t => line(t)).join("") + signatories + line("安全理事会，") + line("认识到网络安全的重要性，") + line("第一条 决定继续审议此问题。"));
  const result = format(input, "draft-resolution");
  assert.deepEqual(errors(result), []);
  const xml = await documentOf(result);
  assert.equal(marked(xml, "strike"), "日本");
  assert.equal(marked(xml, "vanish"), "巴西");
  assert.ok(result.validations.some(v => v.code === "content-protected"));
});

test("restoring a position-paper label does not reveal a hidden delegate name", async () => {
  const input = archive(["立场文件", "安全理事会", "网络安全问题", "法兰西共和国"].map(t => line(t)).join("") + line("张三", "<w:vanish/>")
    + line("（一）问题背景") + line("网络安全已经成为国际社会共同面对的重要挑战，各国应当加强合作，共同应对风险。"));
  const result = format(input, "position-paper");
  assert.deepEqual(errors(result), []);
  assert.ok(marked(await documentOf(result), "vanish").includes("张三"));
});

test("hidden trailing text does not take the clause ending", async () => {
  const input = archive(ZH_DR + `<w:p>${run("第一条 决定继续审议此问题。")}${run("（内部备注：待定）", "<w:vanish/>")}</w:p>` + line("第二条 请秘书长提交报告。"));
  const result = format(input, "draft-resolution");
  assert.deepEqual(errors(result), []);
  const xml = await documentOf(result);
  assert.equal(marked(xml, "vanish"), "（内部备注：待定）");
  assert.ok(result.validations.some(v => v.code === "content-protected" && v.detail.includes("隐藏")));
});

// ---------------------------------------------------------------- B9 endings inside fields and links

test("a clause ending is written after a cross-reference field, not into its result", async () => {
  const field = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> REF _Ref1 \\r \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>第一条</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const simple = '<w:fldSimple w:instr=" REF _Ref1 \\r \\h "><w:r><w:t>第一条</w:t></w:r></w:fldSimple>';
  const link = '<w:hyperlink w:anchor="_Ref1"><w:r><w:t>第一条</w:t></w:r></w:hyperlink>';
  const input = archive(ZH_DR + `<w:p><w:bookmarkStart w:id="1" w:name="_Ref1"/>${run("第一条 决定设立工作组。")}<w:bookmarkEnd w:id="1"/></w:p>`
    + `<w:p>${run("第二条 请各国参照")}${field}</w:p>` + `<w:p>${run("第三条 要求工作组执行")}${simple}</w:p>` + `<w:p>${run("第四条 决定继续审议")}${link}</w:p>`);
  const result = format(input, "draft-resolution");
  assert.deepEqual(errors(result), []);
  const xml = await documentOf(result);
  for (const container of [...nodes(xml, "fldSimple"), ...nodes(xml, "hyperlink")]) assert.equal(textOf(container), "第一条");
  const complex = paragraph(xml, "第二条");
  const runs = nodes(complex, "r"), endIndex = runs.findIndex(r => nodes(r, "fldChar").some(f => f.getAttributeNS(W, "fldCharType") === "end"));
  assert.equal(runs.slice(0, endIndex).map(r => nodes(r, "t").map(t => t.textContent).join("")).join(""), "第二条 请各国参照第一条");
  assert.equal(textOf(complex), "第二条 请各国参照第一条；");
  assert.equal(textOf(paragraph(xml, "第四条")), "第四条 决定继续审议第一条。");
});

// ---------------------------------------------------------------- B3 / B4 recognition

test("a subject line naming States Parties is not read as a signatory", async () => {
  const input = archive(["DRAFT RESOLUTION", "Committee: Assembly of States Parties", "Topic: Complementarity", "Sponsors: France, Germany", "Signatories: Brazil, Japan",
    "The Assembly of States Parties,", "Recalling the Rome Statute,", "1. Decides to remain seized of the matter."].map(t => line(t)).join(""));
  assert.deepEqual(parseDocxInBrowser(input, "draft-resolution").signatories, ["Brazil", "Japan"]);
  const xml = await documentOf(format(input, "draft-resolution"));
  assert.ok(paragraph(xml, "The Assembly of States Parties,"));
});

test("an English document quoting one Chinese term stays English", async () => {
  const input = archive(["DRAFT RESOLUTION", "Committee: General Assembly", "Topic: Connectivity", "Sponsors: France, Germany", "Signatories: Brazil, Japan", "The General Assembly,",
    "Recalling the Belt and Road Initiative (一带一路) and other connectivity frameworks,", "1. Encourages Member States to strengthen regional cooperation;", "2. Requests the Secretary-General to report on progress."].map(t => line(t)).join(""));
  assert.equal(parseDocxInBrowser(input, "draft-resolution").language, "en");
  const xml = await documentOf(format(input, "draft-resolution"));
  assert.ok(paragraph(xml, "DRAFT RESOLUTION"));
  assert.ok(paragraph(xml, "2. Requests").textContent.endsWith("."));
});

test("a Chinese document is still recognized as Chinese", () => {
  assert.equal(parseDocxInBrowser(archive(ZH_DR + line("第一条 决定继续审议此问题。")), "draft-resolution").language, "zh");
});

// ---------------------------------------------------------------- B12 nesting

test("a natively numbered clause ending in a colon does not demote its siblings", async () => {
  const numbering = `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const item = text => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(text)}</w:p>`;
  const input = archive(["DRAFT RESOLUTION", "Committee: General Assembly", "Topic: Water", "Sponsors: France, Germany", "Signatories: Brazil, Japan", "The General Assembly,", "Recalling its earlier resolutions,"].map(t => line(t)).join("")
    + item("Decides to establish a working group:") + item("Requests the Secretary-General to support the group;") + item("Decides to remain seized of the matter."), { "word/numbering.xml": enc.encode(numbering) });
  const result = format(input, "draft-resolution");
  assert.deepEqual(errors(result), []);
  const xml = await documentOf(result);
  const left = start => nodes(paragraph(xml, start), "ind")[0].getAttributeNS(W, "left");
  assert.equal(left("Requests"), left("Decides to establish"));
});

// ---------------------------------------------------------------- B7 step 03 and the body

test("a step-03 topic change never rewrites a body heading with the old text", async () => {
  const input = archive(["立场文件", "委员会：安全理事会", "议题：网络安全", "国家：法兰西共和国", "代表：张三", "网络安全",
    "网络安全已经成为国际社会共同面对的重要挑战，各国应当加强合作，共同应对风险。"].map(t => line(t)).join(""));
  const result = format(input, "position-paper", { topic: "网络空间安全" });
  assert.deepEqual(errors(result), []);
  const texts = nodes(await documentOf(result), "p").map(textOf).filter(Boolean);
  assert.ok(texts.includes("议题：网络空间安全"));
  assert.ok(texts.includes("网络安全"));
});

test("a numbered section heading after a short header is not taken as the delegate", () => {
  const input = archive(["立场文件", "安全理事会", "网络安全问题", "法兰西共和国", "一、问题背景", "网络安全已经成为国际社会共同面对的重要挑战，各国应当加强合作。"].map(t => line(t)).join(""));
  assert.notEqual(parseDocxInBrowser(input, "position-paper").delegate, "一、问题背景");
});

// ---------------------------------------------------------------- B17–B19 package and preview

test("an upper-case .XML part with a DTD is refused like any XML part", () => {
  const input = archive(ZH_DR, { "word/header1.XML": enc.encode(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><w:hdr xmlns:w="${W}"/>`) });
  assert.throws(() => readPackage(input), /DTD/);
});

test("a UTF-16 main document part is read", () => {
  const xml = `<?xml version="1.0" encoding="UTF-16"?><w:document xmlns:w="${W}"><w:body>${ZH_DR}<w:sectPr/></w:body></w:document>`;
  const bytes = new Uint8Array(2 + xml.length * 2); bytes[0] = 0xff; bytes[1] = 0xfe;
  for (let i = 0; i < xml.length; i++) { bytes[2 + 2 * i] = xml.charCodeAt(i) & 255; bytes[3 + 2 * i] = xml.charCodeAt(i) >> 8; }
  const input = zipSync({ "[Content_Types].xml": enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'), "word/document.xml": bytes }).buffer;
  assert.equal(parseDocxInBrowser(input, "draft-resolution").committee, "安全理事会");
});

test("the preview copy drops pictures whose relationship cannot be resolved", () => {
  const blip = rid => `<w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="${rid}"/></w:drawing></w:r>`;
  const input = archive(ZH_DR + `<w:p>${run("图片：")}${blip("rIdMissing")}${blip("rIdGone")}</w:p>`, {
    "word/_rels/document.xml.rels": enc.encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdGone" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/none.png"/></Relationships>'),
  });
  const parts = unzipSync(new Uint8Array(preparePreview(input)));
  const xml = new DOMParser().parseFromString(dec.decode(parts["word/document.xml"]), "application/xml");
  assert.equal(xml.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "blip").length, 0);
  assert.ok(dec.decode(parts["word/document.xml"]).includes("图片："));
});

test("the guard reports hidden text that became visible and a strike that was removed", async () => {
  const { semanticMarks, verifyMarks } = await import("../app/content-guard.ts");
  const xml = new DOMParser().parseFromString(`<w:document xmlns:w="${W}"><w:body><w:p>${run("可见")}${run("隐藏", "<w:vanish/>")}${run("删除", "<w:strike/>")}</w:p></w:body></w:document>`, "application/xml");
  const before = semanticMarks(xml);
  assert.deepEqual(verifyMarks(before, xml), []);
  for (const tag of ["vanish", "strike"]) nodes(xml, tag)[0].remove();
  assert.equal(verifyMarks(before, xml).length, 2);
});
