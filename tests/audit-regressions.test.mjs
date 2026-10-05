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

test("a clause ending before a page or line break is normalized and the break kept", async () => {
  for (const [kind, br] of [["page", '<w:br w:type="page"/>'], ["line", "<w:br/>"]]) {
    const clause = `<w:p>${run("第一条 决定继续审议此问题。")}<w:r>${br}</w:r></w:p>`;
    const result = format(archive(ZH_DR + clause + line("第二条 请秘书长提交报告。")), "draft-resolution");
    assert.deepEqual(errors(result), []);
    const first = paragraph(await documentOf(result), "第一条");
    assert.equal(textOf(first), "第一条 决定继续审议此问题；", kind);
    assert.deepEqual(nodes(first, "br").map(b => b.getAttributeNS(W, "type") || null), [kind === "page" ? "page" : null], kind);
    assert.ok(!result.validations.some(v => v.status === "warning" && v.detail.includes("已保留原样")), kind);
  }
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

// ---------------------------------------------------------------- B11 embedded subclauses

/** Visible text with line breaks and tabs, as a reader sees it. */
const shown = p => [...p.getElementsByTagNameNS(W, "*")].filter(n => ["t", "br", "tab"].includes(n.localName) && !n.closest("del"))
  .map(n => n.localName === "t" ? n.textContent : n.localName === "br" ? "\n" : "\t").join("");
const shownFrom = (xml, start) => { const texts = nodes(xml, "p").map(shown).filter(t => t.trim()); return texts.slice(texts.findIndex(t => t.startsWith(start))); };
const warningsOf = result => result.validations.filter(v => v.status === "warning").map(v => v.detail);
/** Paragraphs read ``expected``; an item without its ending may gain one punctuation mark. */
async function assertSplit(result, expected, start = "第一条") {
  assert.deepEqual(errors(result), []);
  const texts = shownFrom(await documentOf(result), start).slice(0, expected.length);
  assert.equal(texts.length, expected.length, JSON.stringify(texts));
  texts.forEach((text, index) => assert.ok(text === expected[index] || (text.slice(0, -1) === expected[index] && !/[：；。]$/.test(expected[index])), JSON.stringify(texts)));
}
const FLATTENED = "第一条 决定设立工作组：（一）调查网络攻击：（子）收集证据；（丑）提交报告；（二）提出建议。";
const SPLIT = ["第一条 决定设立工作组：\n（一）调查网络攻击：", "（子）收集证据；", "（丑）提交报告；", "（二）提出建议"];

test("a level-one marker after a deeper subclause starts its own paragraph", async () => {
  const result = format(archive(ZH_DR + line(FLATTENED) + line("第二条 决定继续审议此问题。")), "draft-resolution");
  await assertSplit(result, SPLIT);
  const first = await documentOf(result);
  assert.ok(shownFrom(first, "第一条")[4].startsWith("第二条"));
  const again = format((await result.blob.arrayBuffer()), "draft-resolution");
  assert.deepEqual(shownFrom(await documentOf(again), "第一条"), shownFrom(first, "第一条"));
});

test("links and revisions wholly inside one subclause do not block the split", async () => {
  const rels = enc.encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.un.org/" TargetMode="External"/></Relationships>');
  const linked = `<w:p>${run("第一条 决定设立工作组：（一）调查网络攻击：（子）收集证据，参见")}<w:hyperlink r:id="rIdLink">${run("联合国网站")}</w:hyperlink>${run("；（丑）提交报告；（二）提出建议。")}</w:p>`;
  let result = format(archive(ZH_DR + linked, { "word/_rels/document.xml.rels": rels }), "draft-resolution");
  await assertSplit(result, [SPLIT[0], "（子）收集证据，参见联合国网站；", ...SPLIT.slice(2)]);
  assert.equal(nodes(await documentOf(result), "hyperlink").length, 1);
  const revised = `<w:p>${run("第一条 决定设立工作组：（一）调查网络攻击：")}<w:ins w:id="21" w:author="A" w:date="2026-01-01T00:00:00Z">${run("（子）收集证据；")}</w:ins>${run("（丑）提交报告；（二）提出建议。")}</w:p>`;
  result = format(archive(ZH_DR + revised), "draft-resolution");
  await assertSplit(result, SPLIT);
  assert.equal(nodes(await documentOf(result), "ins").length, 1);
});

test("working papers and directives split by the same rule", async () => {
  const header = ["委员会：安全理事会", "议题：网络安全", "起草国：德国、法国"];
  let result = format(archive(["工作文件", ...header, "1. 呼吁各国加强合作：（子）建立信息共享机制；（丑）定期举行会议。"].map(t => line(t)).join("")), "working-paper");
  await assertSplit(result, ["1. 呼吁各国加强合作：", "（子）建立信息共享机制；", "（丑）定期举行会议"], "1.");
  result = format(archive(["指令草案", ...header, "1. 要求各部门：（一）提交报告；（二）说明进展。"].map(t => line(t)).join("")), "draft-directive");
  await assertSplit(result, ["1. 要求各部门：", "（一）提交报告；", "（二）说明进展"], "1.");
});

test("markers outside a clause or in a field paragraph are reported, not split", async () => {
  const prose = "回顾其以往决议：（一）第1号决议；（二）第2号决议，";
  const preamble = ["决议草案", "委员会：安全理事会", "议题：网络安全", "起草国：德国、法国", "附议国：美国、中国", "安全理事会，"].map(t => line(t)).join("");
  let result = format(archive(preamble + line(prose) + line("第一条 决定继续审议此问题。")), "draft-resolution");
  assert.deepEqual(errors(result), []);
  assert.equal(shownFrom(await documentOf(result), "回顾")[0], prose);
  assert.ok(warningsOf(result).some(w => w.includes("第 7 段") && w.includes("未拆分")), JSON.stringify(warningsOf(result)));
  const field = '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>';
  result = format(archive(ZH_DR + `<w:p>${run("第一条 决定设立工作组：（子）收集证据；参见第")}${field}${run("页。")}</w:p>`), "draft-resolution");
  assert.deepEqual(errors(result), []);
  assert.ok(shownFrom(await documentOf(result), "第一条")[0].startsWith("第一条 决定设立工作组：（子）收集证据；"));
  assert.ok(warningsOf(result).some(w => w.includes("第 8 段") && w.includes("域") && w.includes("未拆分")), JSON.stringify(warningsOf(result)));
});

test("a section break moves to the last split paragraph", async () => {
  const section = '<w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr>';
  const result = format(archive(ZH_DR + `<w:p>${section}${run("第一条 决定设立工作组：（子）收集证据；（丑）提交报告。")}</w:p>` + line("第二条 决定继续审议此问题。")), "draft-resolution");
  assert.deepEqual(errors(result), []);
  const breaks = nodes(await documentOf(result), "p").filter(p => [...p.children].some(c => c.localName === "pPr" && [...c.children].some(d => d.localName === "sectPr")));
  assert.deepEqual(breaks.map(shown), ["（丑）提交报告；"]);
});

// ---------------------------------------------------------------- C1/C3–C5 style inheritance

const stylesPart = body => enc.encode(`<w:styles xmlns:w="${W}">${body}</w:styles>`);
async function partOf(result, name) {
  const parts = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  return new DOMParser().parseFromString(dec.decode(parts[name]), "application/xml");
}
const NORMAL = '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>';
const TEXT_BOX = '<w:r><w:drawing><wp:anchor xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">'
  + '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>'
  + '<wp:extent cx="1000000" cy="300000"/><wp:wrapNone/><wp:docPr id="1" name="Box"/>'
  + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">'
  + '<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:cNvSpPr txBox="1"/><wps:spPr/><wps:txbx><w:txbxContent>'
  + '<w:p><w:r><w:t>框内普通说明</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
const switchedOn = (r, tag) => { const n = [...r.children].find(c => c.localName === "rPr")?.getElementsByTagNameNS(W, tag)[0]; return Boolean(n) && !["0", "false", "off", "none"].includes(n.getAttributeNS(W, "val") || ""); };

test("a default style with another id is cleared like Normal", async () => {
  // Chinese Word names the default paragraph style "a"; hiding it hides the whole document.
  for (const id of ["Normal", "a"]) {
    const styles = stylesPart(`<w:style w:type="paragraph" w:default="1" w:styleId="${id}"><w:name w:val="Normal"/><w:rPr><w:vanish/></w:rPr></w:style>`);
    const result = format(archive(ZH_DR + line("第一条 决定继续审议此问题。"), { "word/styles.xml": styles }), "draft-resolution");
    assert.deepEqual(errors(result), []);
    assert.equal(nodes(await partOf(result, "word/styles.xml"), "vanish").length, 0, id);
    assert.equal(nodes(await documentOf(result), "vanish").length, 0, id);
  }
});

test("text-box text does not take the outer paragraph style", async () => {
  const bold = '<w:style w:type="paragraph" w:styleId="Bold"><w:name w:val="Bold"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:u w:val="single"/></w:rPr></w:style>';
  const clause = `<w:p><w:pPr><w:pStyle w:val="Bold"/></w:pPr>${run("第一条 决定继续审议此问题。")}${TEXT_BOX}</w:p>`;
  const result = format(archive(ZH_DR + clause, { "word/styles.xml": stylesPart(NORMAL + bold) }), "draft-resolution");
  assert.deepEqual(errors(result), []);
  const boxed = nodes(await documentOf(result), "r").find(r => [...r.children].filter(c => c.localName === "t").map(t => t.textContent).join("") === "框内普通说明");
  assert.ok(!switchedOn(boxed, "b") && !switchedOn(boxed, "u"));
});

test("a list level comes from the level linked to the style", async () => {
  // ECMA-376 §17.9.23: a level naming a paragraph style is that style's level.
  const numbering = enc.encode(`<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="ListA"/><w:lvlText w:val="%1."/></w:lvl>`
    + `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:pStyle w:val="ListB"/><w:lvlText w:val="(%2)"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
  const styles = stylesPart(NORMAL + ["ListA", "ListB"].map(id => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>`).join(""));
  const en = ["DRAFT RESOLUTION", "Committee: Security Council", "Topic: Cyber Security", "Sponsors: France, Germany", "Signatories: China, Japan", "The Security Council,", "Recognizing the importance of cyber security,"].map(t => line(t)).join("");
  const clauses = [["ListA", "Decides to establish a working group:"], ["ListB", "Collect evidence;"], ["ListB", "Submit a report;"], ["ListA", "Decides to remain seized of the matter."]];
  const source = en + clauses.map(([id, text]) => `<w:p><w:pPr><w:pStyle w:val="${id}"/></w:pPr>${run(text)}</w:p>`).join("");
  const result = format(archive(source, { "word/numbering.xml": numbering, "word/styles.xml": styles }), "draft-resolution");
  assert.deepEqual(errors(result), []);
  const xml = await documentOf(result);
  const levels = clauses.map(([, text]) => nodes(paragraph(xml, text.slice(0, 8)), "ilvl")[0]?.getAttributeNS(W, "val") || "0");
  assert.deepEqual(levels, ["0", "1", "1", "0"]);
});

test("a damaged bold default style does not reach text through a style based on it", async () => {
  const styles = stylesPart('<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/><w:basedOn w:val="Normal"/></w:style>');
  const source = ["立场文件", "委员会：安全理事会", "议题：网络安全", "国家：法国", "代表：张三", "（一）问题背景"].map(t => line(t)).join("") + `<w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr>${run("网络安全关系到各国的共同利益。")}</w:p>`;
  const result = format(archive(source, { "word/styles.xml": styles }), "position-paper");
  assert.deepEqual(errors(result), []);
  const prose = nodes(await documentOf(result), "r").find(r => r.textContent.includes("共同利益"));
  assert.ok(!switchedOn(prose, "b"));
});

test("clearing whole-document damage keeps styles the body does not use", async () => {
  const body = [...["决议草案", "委员会：安全理事会", "议题：网络安全", "起草国：德国、法国", "附议国：美国、中国", "安全理事会，", "认识到网络安全的重要性，"], "第一条 决定继续审议此问题。"].map(t => line(t, "<w:vanish/>")).join("");
  const secret = '<w:style w:type="character" w:styleId="Secret"><w:name w:val="Secret"/><w:rPr><w:vanish/></w:rPr></w:style>';
  const notes = enc.encode(`<w:footnotes xmlns:w="${W}"><w:footnote w:id="1"><w:p><w:r><w:t xml:space="preserve">Public source. </w:t></w:r><w:r><w:rPr><w:rStyle w:val="Secret"/></w:rPr><w:t>Private drafting note.</w:t></w:r></w:p></w:footnote></w:footnotes>`);
  const result = format(archive(body, { "word/styles.xml": stylesPart(NORMAL + secret), "word/footnotes.xml": notes }), "draft-resolution");
  assert.deepEqual(errors(result), []);
  assert.equal(nodes(await documentOf(result), "vanish").length, 0);
  const kept = nodes(await partOf(result, "word/styles.xml"), "style").find(s => s.getAttributeNS(W, "styleId") === "Secret");
  assert.equal(nodes(kept, "vanish").length, 1);
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

test("XML nested deeper than lxml accepts is a file problem in the browser too", () => {
  const nested = depth => enc.encode('<?xml version="1.0"?><!-- c --><a>' + "<b x='>'>".repeat(depth - 1) + "<c/>" + "</b>".repeat(depth - 1) + "</a>");
  assert.doesNotThrow(() => readPackage(archive(ZH_DR, { "word/custom.xml": nested(256) })));
  assert.throws(() => readPackage(archive(ZH_DR, { "word/custom.xml": nested(257) })), /嵌套层级过深/);
  let inner = line("第一条 决定继续审议。");
  for (let index = 0; index < 300; index++) inner = `<w:sdt><w:sdtPr><w:id w:val="${index}"/></w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`;
  const deep = archive(line("决议草案") + inner);
  assert.throws(() => parseDocxInBrowser(deep, "draft-resolution"), /嵌套层级过深/);
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

// ---------------------------------------------------------------- clause words (shared policy prefixes)

/** Text of a paragraph's own runs that carry a switched-on property. */
const emphasized = (p, tag) => nodes(p, "r").filter(r => ownRun(r, p) && switchedOn(r, tag)).map(r => [...r.children].filter(c => c.localName === "t").map(t => t.textContent).join("")).join("");
const ownRun = (r, p) => { let a = r.parentElement; while (a && a.localName !== "p") a = a.parentElement; return a === p; };

test("added Chinese clause words take the preamble underline and the operative italics", async () => {
  const source = ["决议草案", "委员会：安全理事会", "议题：网络安全", "起草国：德国、法国", "附议国：美国、中国", "安全理事会，",
    "深切关切网络攻击日益增多，", "深表关切关键基础设施面临的风险，", "进一步回顾其以往的相关决议，",
    "第一条 促请各国加强信息共享；", "第二条 进一步呼吁各方开展能力建设；", "第三条 进一步回顾其所作的承诺。"].map(t => line(t)).join("");
  const result = format(archive(source), "draft-resolution");
  assert.deepEqual(errors(result), []);
  const xml = await documentOf(result);
  for (const word of ["深切关切", "深表关切", "进一步回顾"]) {
    const p = paragraph(xml, word);
    assert.equal(emphasized(p, "u"), word, word);
    assert.equal(emphasized(p, "i"), "", word);
  }
  // A word in both lists follows the clause's place: "进一步回顾" in an article is operative.
  for (const [start, word] of [["第一条", "促请"], ["第二条", "进一步呼吁"], ["第三条", "进一步回顾"]]) {
    const p = paragraph(xml, start);
    assert.equal(emphasized(p, "i"), word, word);
    assert.equal(emphasized(p, "u"), "", word);
  }
});

// ---------------------------------------------------------------- hidden / struck characters outside the BMP

const NON_BMP_HIDDEN = "（备注😀𠀀）", NON_BMP_STRUCK = "删去𠀁词😀";

test("hidden and struck characters outside the BMP pass the guard unchanged and fail it when exposed", async () => {
  const { semanticMarks, verifyMarks } = await import("../app/content-guard.ts");
  const xml = new DOMParser().parseFromString(`<w:document xmlns:w="${W}"><w:body><w:p>${run("可见")}${run(NON_BMP_HIDDEN, "<w:vanish/>")}${run(NON_BMP_STRUCK, "<w:strike/>")}</w:p></w:body></w:document>`, "application/xml");
  const before = semanticMarks(xml);
  assert.deepEqual(verifyMarks(before, xml), []);
  nodes(xml, "vanish")[0].remove();
  assert.equal(verifyMarks(before, xml).length, 1);
  nodes(xml, "strike")[0].remove();
  assert.equal(verifyMarks(before, xml).length, 2);
});

test("a clause with hidden and struck characters outside the BMP formats with its marks intact", async () => {
  const clause = `<w:p>${run("第一条 决定继续审议此问题")}${run(NON_BMP_HIDDEN, "<w:vanish/>")}${run("并")}${run(NON_BMP_STRUCK, "<w:strike/>")}${run("请秘书长提交报告。")}</w:p>`;
  const result = format(archive(ZH_DR + clause + line("第二条 决定继续处理此案。")), "draft-resolution");
  assert.deepEqual(errors(result), []);
  const xml = await documentOf(result);
  assert.equal(marked(xml, "vanish"), NON_BMP_HIDDEN);
  assert.equal(marked(xml, "strike"), NON_BMP_STRUCK);
});
