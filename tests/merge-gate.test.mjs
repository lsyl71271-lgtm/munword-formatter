// Regressions required by the v1.6.3 acceptance gate agreed with Codex (browser engine).
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { zipSync, unzipSync } from "fflate";
import { parseDocxInBrowser, formatDocxInBrowser } from "../app/docx-browser.ts";
import { visibleText } from "../app/docx-safety.ts";
import { takeSnapshot, verifyFormat, verifyPackage } from "../app/content-guard.ts";

const dom = new JSDOM(""); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer;
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const enc = new TextEncoder(), dec = new TextDecoder();
const nodes = (parent, name) => [...parent.getElementsByTagNameNS(W, name)];
const p = (body, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${body}</w:p>`;
const run = text => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const line = text => p(run(text));
const RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org/a" TargetMode="External"/><Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`;
function archive(body, extra = {}) {
  return zipSync({
    "[Content_Types].xml": enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "word/document.xml": enc.encode(`<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}<w:sectPr/></w:body></w:document>`),
    "word/_rels/document.xml.rels": enc.encode(RELS), ...extra,
  }).buffer;
}
function run2(input, type, options = {}) {
  const result = formatDocxInBrowser(input, parseDocxInBrowser(input, type), { sessionLabel: "", submittingCountry: "", version: "v1", ...options });
  return result;
}
async function out(result) {
  const parts = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  return { parts, xml: new DOMParser().parseFromString(dec.decode(parts["word/document.xml"]), "application/xml") };
}
const texts = xml => nodes(xml, "p").map(q => visibleText(q));
const HEADER = ["决议草案1.2", "联合国大会", "巴勒斯坦问题", "起草国：黎巴嫩共和国", "附议国：伊拉克王国", "联合国大会，", "回顾相关原则，"].map(line).join("");

test("an unnumbered introduction never shifts existing list numbers or references", async () => {
  const numbering = `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="70"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="77"><w:abstractNumId w:val="70"/></w:num></w:numbering>`;
  const numPr = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="77"/></w:numPr>';
  const input = archive(["工作文件1.1", "委员会：联合国大会", "议题：文化", "起草国：中国", "提出以下建议：", "以下若干建议供进一步讨论；"].map(line).join("") + p(run("鼓励合作；"), numPr) + p(run("支持上述第1项建议。"), numPr), { "word/numbering.xml": enc.encode(numbering) });
  const result = run2(input, "working-paper");
  const { xml, parts } = await out(result);
  const introduction = nodes(xml, "p").find(q => visibleText(q).startsWith("以下若干"));
  assert.equal(nodes(introduction, "numId").length, 0);
  assert.equal(nodes(xml, "numId").filter(n => n.getAttributeNS(W, "val") === "77").length, 2);
  assert.ok(texts(xml).includes("支持上述第1项建议。"));
  assert.ok(result.validations.some(v => v.code === "numbering_review"));
  assert.equal(nodes(new DOMParser().parseFromString(dec.decode(parts["word/numbering.xml"]), "application/xml"), "start")[0].getAttributeNS(W, "val"), "1");
});

test("the first section repair excludes all four unlabeled header fields", async () => {
  const input = archive(["立场文件", "联合国大会", "文化保护议题", "测试共和国", "甲、乙", "这是一段足够长的说明正文，用来保证不会把代表姓名误当作第一节标题而改变其身份。", "关于文化", "这是该节的足够长的正文，包含多个完整的句子，程序必须只为短节标题恢复首节标记。", "（二）关于经济"].map(line).join(""));
  const all = texts((await out(run2(input, "position-paper"))).xml);
  assert.ok(all.includes("代表：甲、乙"));
  assert.ok(all.includes("（一）关于文化"));
  assert.ok(!all.some(t => t.includes("（一）甲、乙")));
});

test("restoring a label outside a revision keeps revision text and attributes", async () => {
  const input = archive(line("立场文件") + p(run("联合国") + '<w:ins w:id="1" w:author="A"><w:r><w:t>大会</w:t></w:r></w:ins>') + ["文化保护议题", "测试共和国", "代表甲", "这是一个足够长的正文段落，包含多个完整的句子，不能被误认为元数据，也不能被无故截断。"].map(line).join(""));
  const { xml } = await out(run2(input, "position-paper"));
  assert.ok(texts(xml).includes("委员会：联合国大会"));
  assert.equal(visibleText(nodes(xml, "ins")[0]), "大会");
  assert.equal(nodes(xml, "ins")[0].getAttributeNS(W, "author"), "A");
});

test("the content guard rejects list membership changes even when no text changed", () => {
  const xml = new DOMParser().parseFromString(`<w:document xmlns:w="${W}"><w:body>${line("引言")}</w:body></w:document>`, "application/xml");
  const snapshot = takeSnapshot(xml);
  const paragraph = nodes(xml, "p")[0];
  const numPr = new DOMParser().parseFromString(`<w:pPr xmlns:w="${W}"><w:numPr><w:ilvl w:val="0"/><w:numId w:val="77"/></w:numPr></w:pPr>`, "application/xml").documentElement;
  paragraph.insertBefore(xml.importNode(numPr, true), paragraph.firstChild);
  assert.ok(verifyFormat(snapshot, xml, new Map(), [], []).some(t => t.includes("原生列表")));
});

test("package checks reject numbering-semantic and footnote-text changes", () => {
  for (const name of ["numbering", "footnotes"]) {
    const before = archive(line("正文"), { [`word/${name}.xml`]: enc.encode(`<w:${name} xmlns:w="${W}"><w:start w:val="1"/><w:r><w:t>注释</w:t></w:r></w:${name}>`) });
    const after = archive(line("正文"), { [`word/${name}.xml`]: enc.encode(`<w:${name} xmlns:w="${W}"><w:start w:val="2"/><w:r><w:t>改写</w:t></w:r></w:${name}>`) });
    assert.ok(verifyPackage(new Uint8Array(before), new Uint8Array(after)).some(t => t.includes(name)));
  }
});

test("a typed number after a tab loses no character (工作文件5.2 “1.鼓励” / 1.6 “6. 认为”)", async () => {
  const body = ["工作文件1.6", "《联合国气候变化框架公约》缔约方大会", "气候议题", "起草国：法兰西共和国"].map(line).join("")
    + p(`<w:r><w:t>6.</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>认为教育主权不得妥协；</w:t></w:r>`)
    + p(run("1.鼓励各国合作；"), `<w:tabs><w:tab w:val="left" w:pos="420"/></w:tabs>`);
  const { xml } = await out(run2(archive(body), "working-paper"));
  const all = texts(xml).join("\n");
  assert.ok(all.includes("6.\t认为教育主权不得妥协；"));
  assert.ok(all.includes("1.鼓励各国合作；"));
});

test("tab-stop definitions are not text (visibleText)", () => {
  const document = new DOMParser().parseFromString(`<w:p xmlns:w="${W}"><w:pPr><w:tabs><w:tab w:val="left" w:pos="420"/></w:tabs></w:pPr><w:r><w:t>委员会：甲</w:t></w:r></w:p>`, "application/xml");
  assert.equal(visibleText(document.documentElement), "委员会：甲");
});

test("list markers normalized in definitions and overrides; start values kept", async () => {
  const numbering = `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="70"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:rPr><w:sz w:val="16"/></w:rPr></w:lvl></w:abstractNum>`
    + `<w:num w:numId="77"><w:abstractNumId w:val="70"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:rPr><w:rFonts w:ascii="Arial"/><w:sz w:val="16"/></w:rPr></w:lvl></w:lvlOverride></w:num></w:numbering>`;
  const numbered = text => p(run(text), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="77"/></w:numPr>`);
  const body = ["工作文件1.0", "《联合国气候变化框架公约》缔约方大会", "气候议题", "起草国：法兰西共和国"].map(line).join("") + numbered("鼓励各国合作；") + numbered("呼吁提交报告。");
  const { parts } = await out(run2(archive(body, { "word/numbering.xml": enc.encode(numbering) }), "working-paper"));
  const xml = new DOMParser().parseFromString(dec.decode(parts["word/numbering.xml"]), "application/xml");
  const override = nodes(xml, "lvlOverride")[0];
  assert.equal(nodes(override, "startOverride")[0].getAttributeNS(W, "val"), "5");
  assert.equal(nodes(override, "lvlText")[0].getAttributeNS(W, "val"), "%1.");
  assert.equal(nodes(nodes(override, "lvl")[0], "sz")[0].getAttributeNS(W, "val"), "24");
  assert.equal(nodes(nodes(override, "lvl")[0], "rFonts")[0].getAttributeNS(W, "ascii"), "Times New Roman");
  assert.equal(nodes(nodes(xml, "abstractNum")[0], "sz")[0].getAttributeNS(W, "val"), "24");
});

test("a typed article gap is kept and reported, never filled", async () => {
  const body = HEADER + ["第一条 决定成立委员会；", "第二条 请委员会依照第五条提交报告；", "第五条 决定继续审议。"].map(line).join("");
  const result = run2(archive(body), "draft-resolution");
  const all = texts((await out(result)).xml).join("\n");
  assert.ok(all.includes("第五条 决定继续审议。") && all.includes("依照第五条") && !all.includes("第三条"));
  assert.ok(result.validations.some(v => v.detail?.includes("编号不连续") && v.detail.includes("第五条")));
});

test("numId 0 and a missing numbering part do not fail", async () => {
  const body = HEADER + p(run("第一条 决定成立委员会。"), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>`)
    + p(run("第二条 决定继续审议。"), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="9"/></w:numPr>`);
  const result = run2(archive(body), "draft-resolution");
  assert.equal(result.validations.filter(v => v.status === "error").length, 0);
});

test("a country list holding a tracked insertion is kept whole and reported", async () => {
  const body = ["决议草案1.0", "联合国大会", "议题"].map(line).join("")
    + p(`<w:r><w:t>附议国：</w:t></w:r><w:ins w:id="1" w:author="A"><w:r><w:t>加拿大、澳大利亚、</w:t></w:r></w:ins>`) + line("乍得共和国")
    + ["联合国大会，", "回顾以往决议，", "第一条 决定设立观察团。"].map(line).join("");
  const result = run2(archive(body), "draft-resolution");
  const all = texts((await out(result)).xml).join("\n");
  assert.ok(all.includes("乍得共和国") && all.includes("加拿大"));
  assert.ok(result.validations.some(v => v.code === "content-protected"));
});

test("dropping a label inside a hyperlink keeps the link and its target", async () => {
  const body = line("决议草案1.0") + p(`<w:hyperlink r:id="rIdLink"><w:r><w:t>委员会：联合国大会</w:t></w:r></w:hyperlink>`) + line("议题：测试")
    + ["起草国：日本国", "联合国大会，", "回顾以往决议，", "第一条 决定设立观察团。"].map(line).join("");
  const { xml, parts } = await out(run2(archive(body), "draft-resolution"));
  assert.equal(nodes(xml, "hyperlink").length, 1);
  assert.equal(nodes(xml, "hyperlink")[0].getAttributeNS(R, "id"), "rIdLink");
  assert.match(dec.decode(parts["word/_rels/document.xml.rels"]), /Target="https:\/\/example.org\/a"/);
});

test("field codes survive formatting", async () => {
  const body = HEADER + p(`<w:r><w:t xml:space="preserve">第一条 参见 </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> REF _Ref1 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t>。</w:t></w:r>`);
  const { xml } = await out(run2(archive(body), "draft-resolution"));
  assert.equal(nodes(xml, "instrText")[0].textContent, " REF _Ref1 \\h ");
});

test("a second pass adds no blank lines and changes no text", async () => {
  const body = HEADER + ["第一条 决定成立委员会；", "（一）委员会由五国组成；", "第二条 决定继续审议。"].map(line).join("");
  const first = await run2(archive(body), "draft-resolution").blob.arrayBuffer();
  const second = await run2(first, "draft-resolution").blob.arrayBuffer();
  const third = await run2(second, "draft-resolution").blob.arrayBuffer();
  const read = buffer => texts(new DOMParser().parseFromString(dec.decode(unzipSync(new Uint8Array(buffer))["word/document.xml"]), "application/xml"));
  assert.deepEqual(read(second), read(first));
  assert.deepEqual(read(third), read(first));
});

test("an invalid package is reported as unreadable, a defect as a program error", () => {
  assert.throws(() => run2(new Uint8Array([80, 75, 3, 4, 1, 2, 3]).buffer, "working-paper"), /文件无法读取|DOCX/);
});

const TRACKED_TITLE = p(`<w:ins w:id="100" w:author="Reviewer" w:date="2026-01-01T00:00:00Z"><w:r><w:t>非友好修正案1.3.2</w:t></w:r></w:ins>`)
  + ["起草国：日本国", "在第一条后增加：“决定继续审议。”"].map(line).join("");

test("text inside a tracked revision is never rewritten; the paragraph is named", async () => {
  const result = run2(archive(TRACKED_TITLE), "unfriendly-amendment");
  const { xml } = await out(result);
  const inserted = nodes(xml, "ins")[0];
  assert.equal(visibleText(inserted), "非友好修正案1.3.2");
  assert.equal(inserted.getAttributeNS(W, "author"), "Reviewer");
  assert.ok(result.validations.some(v => v.detail?.includes("第 1 段") && v.detail.includes("修订")));
});

test("a step-03 title change on a tracked revision is refused with the paragraph and reason", () => {
  const input = archive(TRACKED_TITLE);
  const model = parseDocxInBrowser(input, "unfriendly-amendment");
  assert.throws(() => formatDocxInBrowser(input, { ...model, title: "非友好修正案2.1" }, { sessionLabel: "", submittingCountry: "", version: "v1" }),
    error => /第 1 段/.test(error.message) && /修订/.test(error.message));
});
