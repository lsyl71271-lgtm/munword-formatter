// Regressions from the independent v1.7.0 review (Claude), browser engine.
// Each case failed before its fix.  Expectations are read back with plain DOM
// calls here (own text, italic attribute, numPr), not with engine helpers.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { zipSync, unzipSync } from "fflate";
import { parseDocxInBrowser, formatDocxInBrowser } from "../app/docx-browser.ts";
import { takeSnapshot, verifyFormat } from "../app/content-guard.ts";
import { readPackage } from "../app/docx-safety.ts";
import { preparePreview } from "../app/preview-safety.ts";
import { generateFromTemplate } from "../app/template-generator.ts";

const dom = new JSDOM(""); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer;
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const V = "urn:schemas-microsoft-com:vml";
const enc = new TextEncoder(), dec = new TextDecoder();
const nodes = (parent, name) => [...parent.getElementsByTagNameNS(W, name)];
const run = text => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const line = text => `<w:p>${run(text)}</w:p>`;
const HEADER = ["决议草案1.0", "联合国大会", "测试议题", "起草国：法兰西共和国、日本国", "附议国：大韩民国", "联合国大会，", "回顾以往决议，"].map(line).join("");

function archive(body, documentXml) {
  return zipSync({
    "[Content_Types].xml": enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "word/document.xml": documentXml ?? enc.encode(`<w:document xmlns:w="${W}" xmlns:v="${V}"><w:body>${body}<w:sectPr/></w:body></w:document>`),
  }).buffer;
}
const format = input => formatDocxInBrowser(input, parseDocxInBrowser(input, "draft-resolution"), { sessionLabel: "", submittingCountry: "", version: "v1" });
async function documentOf(result) {
  const parts = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  return new DOMParser().parseFromString(dec.decode(parts["word/document.xml"]), "application/xml");
}
/** Text of a paragraph without paragraphs nested in its text boxes. */
function ownText(p) {
  return nodes(p, "t").filter(t => {
    for (let a = t.parentElement; a && a !== p; a = a.parentElement) if (a.namespaceURI === W && ["p", "del"].includes(a.localName)) return false;
    return true;
  }).map(t => t.textContent).join("");
}
function italicText(p) {
  return nodes(p, "r").filter(r => r.parentElement === p || r.parentElement.localName === "hyperlink").filter(r => {
    const i = nodes(r, "i")[0];
    return i && !["0", "false"].includes(i.getAttributeNS(W, "val"));
  }).map(r => nodes(r, "t").map(t => t.textContent).join("")).join("");
}
const errors = result => result.validations.filter(v => v.status === "error");

test("the ending of a paragraph holding a text box is not a content change", async () => {
  const box = `<w:r><w:pict><v:shape style="width:120pt;height:40pt"><v:textbox><w:txbxContent>${line("（一）文本框内容，")}</w:txbxContent></v:textbox></v:shape></w:pict></w:r>`;
  const result = format(archive(HEADER + `<w:p>${run("第一条 要求各国合作，见右框")}${box}</w:p>` + line("第二条 决定继续审议。")));
  assert.deepEqual(errors(result), []);
  const xml = await documentOf(result);
  const boxed = nodes(xml, "p").filter(p => p.parentElement.localName === "txbxContent");
  assert.deepEqual(boxed.map(ownText), ["（一）文本框内容，"]);
  assert.equal(ownText(nodes(xml, "p").find(p => ownText(p).startsWith("第一条"))), "第一条 要求各国合作，见右框；");
});

test("text in a table cell is not turned into a clause", async () => {
  const table = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:tcPr/>${line("第一条 表格中的条款；")}</w:tc><w:tc><w:tcPr/><w:p/></w:tc></w:tr></w:tbl>`;
  const result = format(archive(HEADER + table + line("第二条 决定继续审议。")));
  assert.deepEqual(errors(result), []);
  const xml = await documentOf(result);
  assert.deepEqual(nodes(xml, "tc").map(cell => nodes(cell, "p").map(ownText)), [["第一条 表格中的条款；"], [""]]);
  for (const cell of nodes(xml, "tc")) for (const p of nodes(cell, "p")) assert.equal(nodes(p, "numPr").length, 0);
});

const CONTROL = HEADER + `<w:sdt><w:sdtPr><w:alias w:val="正文"/></w:sdtPr><w:sdtContent>${line("第一条 要求各国合作，")}${line("第二条 决定继续审议")}</w:sdtContent></w:sdt>`;

test("articles in a content control follow the handbook like body articles", async () => {
  const result = format(archive(CONTROL));
  assert.deepEqual(errors(result), []);
  const xml = await documentOf(result);
  const inside = nodes(xml, "p").filter(p => p.parentElement.localName === "sdtContent" && ownText(p));
  assert.deepEqual(inside.map(ownText), ["第一条 要求各国合作；", "第二条 决定继续审议。"]);
  assert.deepEqual(inside.map(italicText), ["要求", "决定"]);
  assert.equal(nodes(xml, "sdt").length, 1);
});

test("a second pass adds nothing inside a content control", async () => {
  const first = format(archive(CONTROL));
  const second = format(await first.blob.arrayBuffer());
  const texts = async result => nodes(await documentOf(result), "p").map(ownText);
  assert.deepEqual(await texts(second), await texts(first));
});

test("the guard sees an unlogged change inside a content control", () => {
  const xml = new DOMParser().parseFromString(`<w:document xmlns:w="${W}"><w:body>${CONTROL}<w:sectPr/></w:body></w:document>`, "application/xml");
  const before = takeSnapshot(xml);
  nodes(xml, "t").find(t => t.textContent.startsWith("第二条")).textContent = "第二条 决定停止审议";
  assert.ok(verifyFormat(before, xml, new Map(), [], []).length > 0);
});

test("a UTF-16 part with a DTD is refused before parsing", () => {
  const text = `﻿<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE w:document [<!ENTITY a "x">]><w:document xmlns:w="${W}"><w:body>${line("第一条 &a;")}</w:body></w:document>`;
  const utf16 = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index++) { utf16[index * 2] = text.charCodeAt(index) & 255; utf16[index * 2 + 1] = text.charCodeAt(index) >> 8; }
  assert.throws(() => readPackage(archive("", utf16)), /DTD/);
});

const LABEL_IN_BODY = ["决议草案1.0", "联合国大会", "测试议题", "起草国：法兰西共和国", "联合国大会，", "回顾以往决议，", "第一条 决定设立工作组；", "议题：后续安排如下，", "第二条 决定继续审议。"].map(line).join("");

test("a body paragraph that starts like a header label is neither metadata nor dropped", async () => {
  const input = archive(LABEL_IN_BODY);
  assert.equal(parseDocxInBrowser(input, "draft-resolution").topic, "测试议题");
  const result = format(input);
  assert.deepEqual(errors(result), []);
  const xml = await documentOf(result);
  // The label stays; the clause ending follows the punctuation rule.
  assert.ok(nodes(xml, "p").map(ownText).some(text => text.startsWith("议题：后续安排如下")));
  assert.equal(italicText(nodes(xml, "p").find(p => ownText(p).startsWith("第一条"))), "决定");
});

test("a step-03 topic never rewrites a body paragraph", async () => {
  const input = archive(LABEL_IN_BODY);
  const result = formatDocxInBrowser(input, { ...parseDocxInBrowser(input, "draft-resolution"), topic: "新议题" }, { sessionLabel: "", submittingCountry: "", version: "v1" });
  assert.deepEqual(errors(result), []);
  const texts = nodes(await documentOf(result), "p").map(ownText);
  assert.ok(texts.includes("新议题") && texts.some(text => text.startsWith("议题：后续安排如下")));
});

test("an English subject line after the signatories is not a country (parity with Python)", async () => {
  const input = archive(["Draft Directive 1.1", "Committee: General Assembly", "Sponsors: Japan, France", "Signatories: Canada, Republic of Korea",
    "The Executive Council,", "1. Requests all Member States to submit annual reports;", "2. Decides to remain seized of the matter."].map(line).join(""));
  assert.deepEqual(parseDocxInBrowser(input, "draft-directive").signatories, ["Canada", "Republic of Korea"]);
  const result = formatDocxInBrowser(input, parseDocxInBrowser(input, "draft-directive"), { sessionLabel: "", submittingCountry: "", version: "v1" });
  const texts = nodes(await documentOf(result), "p").map(ownText);
  assert.ok(texts.includes("Signatories: Canada, Republic of Korea") && texts.includes("The Executive Council,"));
});

const indentOf = p => { const ind = nodes(p, "ind")[0]; return ind ? Object.fromEntries([...ind.attributes].map(a => [a.localName, a.value])) : {}; };
const typed = (type, input) => formatDocxInBrowser(input, parseDocxInBrowser(input, type), { sessionLabel: "", submittingCountry: "", version: "v1" });

test("a subject line named with 'The' is recognized, keeps its comma and is italic", async () => {
  const input = archive(["Draft Resolution 2.1", "Committee: Security Council", "Topic: Maritime security", "Sponsors: France, Japan", "Signatories: Canada",
    "The Security Council,", "Recalling its previous resolutions,", "1. Requests all States to cooperate;", "2. Decides to remain seized of the matter."].map(line).join(""));
  const result = typed("draft-resolution", input);
  assert.deepEqual(errors(result), []);
  const subject = nodes(await documentOf(result), "p").find(p => ownText(p).startsWith("The Security"));
  assert.equal(ownText(subject), "The Security Council,");
  assert.equal(italicText(subject), "The Security Council,");
});

const DAMAGED_LIST = ["工作文件2.1", "联合国教科文组织", "文物保护", "起草国：法兰西共和国", "1.建立文物登记制度；", "2.明确预防和打击文物走私的处理办法："].map(line).join("")
  + `<w:p><w:pPr><w:ind w:left="420"/></w:pPr>${run("建立国际文物数据库，加强海关识别能力；")}</w:p>` + line("3.鼓励各国交流。");

test("a damaged item is nested and a second pass changes nothing", async () => {
  const first = typed("working-paper", archive(DAMAGED_LIST));
  const second = typed("working-paper", await first.blob.arrayBuffer());
  const read = async result => nodes(await documentOf(result), "p").map(p => [ownText(p), indentOf(p)]);
  assert.deepEqual(await read(second), await read(first));
  const item = nodes(await documentOf(first), "p").find(p => ownText(p).startsWith("建立国际"));
  assert.equal(indentOf(item).left, "840");
});

test("a stray indent outside a list is not a level", async () => {
  const input = archive(["工作文件2.1", "联合国教科文组织", "文物保护", "起草国：法兰西共和国"].map(line).join("")
    + `<w:p><w:pPr><w:ind w:left="840" w:hanging="420"/></w:pPr>${run("各代表团就文物保护展开讨论，形成以下建议")}</w:p>` + line("1.建立文物登记制度；") + line("2.鼓励各国交流。"));
  const result = typed("working-paper", input);
  assert.deepEqual(errors(result), []);
  assert.equal(indentOf(nodes(await documentOf(result), "p").find(p => ownText(p).startsWith("各代表团"))).hanging, undefined);
});

test("the preview copy drops pictures whose relationship it stripped (no <img src=null> request)", () => {
  const D = "http://schemas.openxmlformats.org/drawingml/2006/main", RN = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const body = `<w:p><w:r><w:drawing><a:blip xmlns:a="${D}" r:link="rIdOut"/></w:drawing></w:r><w:r><w:t>保留文字</w:t></w:r></w:p>`
    + `<w:p><w:hyperlink r:id="rIdWeb"><w:r><w:t>链接文字</w:t></w:r></w:hyperlink></w:p>`;
  const input = zipSync({
    "[Content_Types].xml": enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "word/document.xml": enc.encode(`<w:document xmlns:w="${W}" xmlns:r="${RN}"><w:body>${body}</w:body></w:document>`),
    "word/_rels/document.xml.rels": enc.encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdOut" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://evil.invalid/i.png"/><Relationship Id="rIdWeb" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://evil.invalid/" TargetMode="External"/></Relationships>'),
  }).buffer;
  const prepared = unzipSync(new Uint8Array(preparePreview(input)));
  const xml = new DOMParser().parseFromString(dec.decode(prepared["word/document.xml"]), "application/xml");
  assert.equal(nodes(xml, "drawing").length, 0);
  assert.equal(nodes(xml, "hyperlink")[0].getAttributeNS(RN, "id"), null);
  assert.deepEqual(nodes(xml, "t").map(t => t.textContent), ["保留文字", "链接文字"]);
});

const MARKERS = ["工作文件3.1", "联合国教科文组织", "文物保护", "起草国：法兰西共和国", "5．建立地区互助机制，明确其运行方式：", "（a）决策一国一票；", "（b）资金透明；",
  "（c）尊重主权；", "（d）定期报告；", "（i）按年度提交；", "（ii）公开发布；", "6. 鼓励各国交流。"].map(line).join("");
async function markerIndents() {
  const result = typed("working-paper", archive(MARKERS));
  assert.deepEqual(errors(result), []);
  return Object.fromEntries(nodes(await documentOf(result), "p").filter(p => ownText(p)).map(p => [ownText(p).slice(0, 4), indentOf(p)]));
}

test("letters that are also numerals follow their sequence", async () => {
  const indents = await markerIndents();
  assert.deepEqual(new Set(["(a)决", "(b)资", "(c)尊", "(d)定"].map(key => indents[key].left)), new Set([indents["(a)决"].left]));
  assert.ok(Number(indents["(i)按"].left) > Number(indents["(d)定"].left));
  assert.deepEqual(indents["(i)按"], indents["(ii)"]);
});

test("a full-width period marks a numbered item", async () => {
  const indents = await markerIndents();
  assert.deepEqual(indents["5.建立"], indents["6. 鼓"]);
});

test("parenthesized digits nest under the item that introduces them", async () => {
  const input = archive(["工作文件3.2", "联合国环境大会", "塑料污染", "起草国：日本国", "1. 建立技术交流平台：", "（1）汇总可复制的减塑实践；", "（2）每半年提交进展说明；", "2. 鼓励自愿资金支持。"].map(line).join(""));
  const result = typed("working-paper", input);
  assert.deepEqual(errors(result), []);
  const indents = Object.fromEntries(nodes(await documentOf(result), "p").filter(p => ownText(p)).map(p => [ownText(p).slice(0, 3), indentOf(p)]));
  assert.deepEqual(indents["(a)"], indents["(b)"]);
  assert.ok(Number(indents["(a)"].left) > Number(indents["1. "].left));
  assert.deepEqual(indents["1. "], indents["2. "]);
});

const runProps = async (result, needle) => {
  const r = nodes(await documentOf(result), "r").find(r => nodes(r, "t").map(t => t.textContent).join("").includes(needle));
  return new Set([...(nodes(r, "rPr")[0]?.children ?? [])].map(child => child.localName));
};

test("a hidden note stays hidden and is reported", async () => {
  const input = archive(HEADER + `<w:p>${run("第一条 决定继续审议")}<w:r><w:rPr><w:vanish/></w:rPr><w:t>（内部备注：勿公开）</w:t></w:r>${run("。")}</w:p>`);
  const result = format(input);
  assert.deepEqual(errors(result), []);
  assert.ok((await runProps(result, "内部备注")).has("vanish"));
  assert.ok(result.validations.some(v => v.code === "hidden-text"));
});

test("an amendment's strikethrough is kept", async () => {
  const input = archive(["非友好修正案1.3.2", "联合国大会", "修正案测试", "起草国：法兰西共和国", "附议国：日本国"].map(line).join("")
    + `<w:p>${run("将第二条修改为：“决定")}<w:r><w:rPr><w:strike/></w:rPr><w:t>立即</w:t></w:r>${run("继续审议此问题。”")}</w:p>`);
  const result = typed("unfriendly-amendment", input);
  assert.deepEqual(errors(result), []);
  assert.ok((await runProps(result, "立即")).has("strike"));
});

test("font table, theme and settings match the Python engine; equations keep their font", async () => {
  const input = zipSync({
    "[Content_Types].xml": enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "word/document.xml": enc.encode(`<w:document xmlns:w="${W}"><w:body>${HEADER}${line("第一条 决定继续审议。")}<w:sectPr/></w:body></w:document>`),
    "word/settings.xml": enc.encode(`<w:settings xmlns:w="${W}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:mathPr><m:mathFont m:val="Cambria Math"/></m:mathPr><w:themeFontLang w:val="en-US" w:eastAsia="ja-JP"/></w:settings>`),
    "word/theme/theme1.xml": enc.encode('<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:theme>'),
    "word/fontTable.xml": enc.encode(`<w:fonts xmlns:w="${W}"><w:font w:name="Calibri"/><w:font w:name="Times New Roman"/></w:fonts>`),
  }).buffer;
  const result = format(input);
  assert.deepEqual(errors(result), []);
  const parts = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  const settings = dec.decode(parts["word/settings.xml"]), theme = dec.decode(parts["word/theme/theme1.xml"]), table = dec.decode(parts["word/fontTable.xml"]);
  assert.match(settings, /m:val="Cambria Math"/);
  assert.match(settings, /w:eastAsia="zh-CN"/);
  assert.ok(!theme.includes("Calibri") && !theme.includes("Times New Roman Light"));
  assert.ok(!table.includes('w:name="Calibri"'));
  assert.match(table, /w:name="SimSun"><w:altName w:val="Songti SC"\/>/);
});

test("run properties are written in schema order (CT_RPr)", async () => {
  const ORDER = ["rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath"];
  const withLang = text => `<w:p><w:r><w:rPr><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const input = archive(["决议草案1.0", "联合国大会", "测试议题", "起草国：法兰西共和国", "附议国：日本国", "联合国大会，", "回顾以往决议，", "第一条 决定继续审议。"].map(withLang).join(""));
  const result = format(input);
  for (const rPr of nodes(await documentOf(result), "rPr")) {
    const ranks = [...rPr.children].map(child => ORDER.indexOf(child.localName));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), [...rPr.children].map(child => child.localName).join(","));
  }
});

test("a generated document carries the house styles, so both engines start from the same defaults", async () => {
  const result = generateFromTemplate("position-paper", { language: "en", committee: "General Assembly", topic: "Marine plastic pollution", country: "Japan", delegate: "Sample Delegate", sponsors: "", signatories: "", body: "Japan supports a practical framework." });
  const parts = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  assert.ok(parts["word/styles.xml"], "styles part");
  const styles = new DOMParser().parseFromString(dec.decode(parts["word/styles.xml"]), "application/xml");
  assert.equal(nodes(nodes(styles, "docDefaults")[0], "rFonts")[0].getAttributeNS(W, "ascii"), "Times New Roman");
});

for (const property of ["vanish", "webHidden", "specVanish", "strike", "dstrike"]) {
  test(`inherited ${property} survives dropping character styles and is reported`, async () => {
    const input = unzipSync(new Uint8Array(archive(HEADER + `<w:p>${run("第一条 决定")}<w:r><w:rPr><w:rStyle w:val="PrivateNote"/></w:rPr><w:t>内部备注</w:t></w:r>${run("继续审议。")}</w:p>`)));
    input["word/styles.xml"] = enc.encode(`<w:styles xmlns:w="${W}"><w:style w:type="character" w:styleId="PrivateNote"><w:name w:val="PrivateNote"/><w:rPr><w:${property}/></w:rPr></w:style></w:styles>`);
    const result = format(zipSync(input).buffer);
    assert.deepEqual(errors(result), []);
    assert.ok((await runProps(result, "内部备注")).has(property));
    assert.ok(result.validations.some(v => v.code === "hidden-text"));
  });
}

test("theme font normalization changes exact faces, not math fonts or theme labels", async () => {
  const input = unzipSync(new Uint8Array(archive(HEADER + line("第一条 决定继续审议。"))));
  input["word/theme/theme1.xml"] = enc.encode('<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Cambria Sample"><a:majorFont><a:latin typeface="Calibri Light"/><a:font script="Math" typeface="Cambria Math"/></a:majorFont></a:theme>');
  const parts = unzipSync(new Uint8Array(await format(zipSync(input).buffer).blob.arrayBuffer()));
  const xml = dec.decode(parts["word/theme/theme1.xml"]);
  assert.match(xml, /typeface="Times New Roman"/);
  assert.match(xml, /typeface="Cambria Math"/);
  assert.match(xml, /name="Cambria Sample"/);
});

test("a BOM-less UTF-16 DTD after leading whitespace is rejected", () => {
  const text = ` \n<!DOCTYPE w:document [<!ENTITY a "x">]><w:document xmlns:w="${W}"><w:body/></w:document>`;
  for (const big of [false, true]) {
    const bytes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) { bytes[i * 2 + Number(big)] = text.charCodeAt(i); }
    assert.throws(() => readPackage(archive("", bytes)), /DTD/);
  }
});

test("whole-document hidden style damage is cleared from defaults as well as runs", async () => {
  const input = unzipSync(new Uint8Array(archive(HEADER + line("第一条 决定继续审议。"))));
  input["word/styles.xml"] = enc.encode(`<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:vanish/></w:rPr></w:style></w:styles>`);
  const result = format(zipSync(input).buffer);
  const parts = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  for (const name of ["word/document.xml", "word/styles.xml"]) {
    const xml = new DOMParser().parseFromString(dec.decode(parts[name]), "application/xml");
    assert.equal(nodes(xml, "vanish").length, 0, name);
  }
});
