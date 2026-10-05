import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { zipSync, unzipSync } from "fflate";
import { parseDocxInBrowser, formatDocxInBrowser } from "../app/docx-browser.ts";
import { contentSignature, readPackage } from "../app/docx-safety.ts";

const dom = new JSDOM("");
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const enc = new TextEncoder();
const dec = new TextDecoder();
const p = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const archive = (body, extra = {}) => zipSync({
  "[Content_Types].xml": enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
  "word/document.xml": enc.encode(`<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`), ...extra,
}, { level: 0 }).buffer;
const parseXml = bytes => new DOMParser().parseFromString(dec.decode(bytes), "application/xml");
const xml = buffer => parseXml(unzipSync(new Uint8Array(buffer))["word/document.xml"]);
const nodes = (parent, name) => [...parent.getElementsByTagNameNS(W, name)];
async function format(input, type = "working-paper", overrides = {}) {
  const model = { ...parseDocxInBrowser(input, type), ...overrides };
  const result = formatDocxInBrowser(input, model, { sessionLabel: "", submittingCountry: "", version: "v1" });
  return { result, buffer: await result.blob.arrayBuffer() };
}

test("metadata aliases do not swallow prose or partial English words", () => {
  const model = parseDocxInBrowser(archive(p("工作文件") + p("国家应当加强合作。") + p("Delegates support cooperation.")), "working-paper");
  assert.equal(model.country, "");
  assert.equal(model.delegate, "");
  assert.equal(model.body_clauses.length, 2);
});

test("missing title does not invent unlabeled metadata", () => {
  const model = parseDocxInBrowser(archive(p("保护文化") + p("共同协商")), "position-paper");
  assert.equal(model.committee, "");
  assert.equal(model.body_clauses.length, 2);
});

test("formatting preserves breaks tabs fields images bookmarks and hyperlinks", async () => {
  const body = p("工作文件") + '<w:p><w:bookmarkStart w:id="1" w:name="test"/><w:r><w:t>1. 要求</w:t><w:tab/><w:t>合作</w:t><w:br/><w:t>继续</w:t><w:drawing/><w:footnoteReference w:id="1"/></w:r><w:hyperlink w:anchor="test"><w:r><w:t>链接</w:t></w:r></w:hyperlink><w:r><w:fldChar w:fldCharType="begin"/><w:instrText> PAGE </w:instrText><w:fldChar w:fldCharType="end"/></w:r><w:bookmarkEnd w:id="1"/></w:p>';
  const input = archive(body, { "word/media/test.bin": new Uint8Array([1, 2, 3]) });
  const { buffer } = await format(input);
  assert.equal(contentSignature(xml(buffer)), contentSignature(xml(input)));
  assert.deepEqual(unzipSync(new Uint8Array(buffer))["word/media/test.bin"], new Uint8Array([1, 2, 3]));
});

test("metadata edits cannot bypass protection of complex paragraphs", async () => {
  const input = archive(p("工作文件") + '<w:p><w:r><w:t>国家：甲国</w:t><w:drawing/></w:r></w:p>');
  await assert.rejects(format(input, "working-paper", { country: "乙国" }), /中止/);
});

test("explicitly clearing a recognized field works", async () => {
  const { buffer } = await format(archive(p("工作文件") + p("国家：甲国")), "working-paper", { country: "" });
  assert.ok(nodes(xml(buffer), "t").some(node => node.textContent === "国家："));
});

test("resolution verbs spanning fragmented runs gain italics", async () => {
  const input = archive(p("决议草案") + '<w:p><w:r><w:t>第一条 要</w:t></w:r><w:r><w:t>求</w:t></w:r><w:r><w:t>共同合作。</w:t></w:r></w:p>');
  const { buffer } = await format(input, "draft-resolution");
  for (const character of ["要", "求"]) {
    const run = nodes(xml(buffer), "r").find(r => nodes(r, "t").map(t => t.textContent).join("") === character);
    assert.equal(nodes(run, "i")[0]?.getAttributeNS(W, "val"), "1");
    assert.equal(nodes(run, "iCs")[0]?.getAttributeNS(W, "val"), "1");
  }
});

test("symbol bullets retain their font while all numbering sizes normalize", async () => {
  const numbering = enc.encode(`<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:rPr><w:rFonts w:ascii="Wingdings"/><w:sz w:val="2"/></w:rPr></w:lvl></w:abstractNum></w:numbering>`);
  const { buffer } = await format(archive(p("工作文件") + p("1. 要求合作。"), { "word/numbering.xml": numbering }));
  const document = parseXml(unzipSync(new Uint8Array(buffer))["word/numbering.xml"]);
  assert.equal(nodes(document, "rFonts")[0].getAttributeNS(W, "ascii"), "Wingdings");
  assert.equal(nodes(document, "sz")[0].getAttributeNS(W, "val"), "24");
  assert.equal(nodes(document, "szCs")[0].getAttributeNS(W, "val"), "24");
});

test("nested clause repair preserves tabs elsewhere and is idempotent", async () => {
  const input = archive(p("工作文件") + '<w:p><w:r><w:t>1. 要求落实</w:t><w:tab/><w:t>如下：（子）建立合作机制。</w:t></w:r></w:p>');
  const first = await format(input);
  assert.equal(nodes(xml(first.buffer), "tab").length, 1);
  assert.equal(nodes(xml(first.buffer), "p").length, 3);
  const second = await format(first.buffer);
  assert.equal(new XMLSerializer().serializeToString(xml(first.buffer)), new XMLSerializer().serializeToString(xml(second.buffer)));
});

test("intentional line breaks before nested markers are not replaced by paragraphs", async () => {
  const input = archive(p("工作文件") + '<w:p><w:r><w:t>1. 要求如下：</w:t><w:br/><w:t>（子）共同合作。</w:t></w:r></w:p>');
  const { buffer } = await format(input);
  assert.equal(contentSignature(xml(buffer)), contentSignature(xml(input)));
});

test("malformed archives and XML declarations fail closed", () => {
  for (const input of [new ArrayBuffer(0), new ArrayBuffer(21 * 1024 * 1024), archive(p("工作文件"), { "../escape": enc.encode("x") }), archive(p("工作文件"), { "word/styles.xml": enc.encode('<!DOCTYPE x [<!ENTITY a "b">]><x/>') })]) {
    assert.throws(() => readPackage(input));
  }
});

test("decompression budgets are applied before inflation", () => {
  const input = zipSync({ "[Content_Types].xml": enc.encode("x"), "word/document.xml": enc.encode("x".repeat(2_000_000)) }).buffer;
  assert.throws(() => readPackage(input), /压缩比例/);
});

test("independent content signature catches invisible-control loss", () => {
  const first = xml(archive('<w:p><w:r><w:t>A</w:t><w:br/><w:t>B</w:t></w:r></w:p>'));
  const second = xml(archive(p("AB")));
  assert.notEqual(contentSignature(first), contentSignature(second));
});

test("ZIP integrity rejects tampering and encryption before returning a document", () => {
  const base = new Uint8Array(archive(p("工作文件")));
  const damaged = base.slice();
  damaged[31 + new DataView(damaged.buffer).getUint16(26, true)] ^= 1;
  assert.throws(() => readPackage(damaged.buffer), /CRC/);
  const encrypted = base.slice();
  const view = new DataView(encrypted.buffer);
  const central = view.getUint32(encrypted.length - 6, true);
  view.setUint16(central + 8, view.getUint16(central + 8, true) | 1, true);
  assert.throws(() => readPackage(encrypted.buffer), /加密/);
});

test("title edits are applied and reported", async () => {
  const { buffer, result } = await format(archive(p("工作文件1.1") + p("1. 要求合作。")), "working-paper", { title: "工作文件2.1" });
  // The confirmed title is applied as typed (handbook title word + its own number).
  assert.equal(nodes(xml(buffer), "t")[0].textContent, "工作文件2.1");
  assert.match(result.validations.find(v => v.code === "structural_edits").detail, /标题/);
});

test("automatic numbering participates in resolution boundary recognition", () => {
  const model = parseDocxInBrowser(archive(p("决议草案") + p("注意到当前情况，") + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>要求各国合作；</w:t></w:r></w:p>'), "draft-resolution");
  assert.equal(model.preambulatory_clauses.length, 1);
  assert.equal(model.operative_clauses.length, 1);
});

test("40 deterministic fragmentation and extreme-size stress variants preserve content", async () => {
  const text = "第一条 要求共同合作，支持持续保护文化遗产。";
  for (let seed = 1; seed <= 40; seed++) {
    let state = seed;
    const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    let runs = "";
    for (let offset = 0; offset < text.length;) {
      const length = 1 + random() % 5;
      const fragment = text.slice(offset, offset + length);
      offset += length;
      const size = random() % 2 ? 2 + random() % 12 : 80 + random() % 120;
      runs += `<w:r><w:rPr><w:rFonts w:asciiTheme="majorAscii" w:eastAsiaTheme="majorEastAsia"/><w:sz w:val="${size}"/><w:szCs w:val="4"/></w:rPr><w:t xml:space="preserve">${fragment}</w:t></w:r>`;
    }
    const input = archive(p("工作文件") + `<w:p>${runs}</w:p>`);
    const { buffer } = await format(input);
    // WP notation is corrected, but the ordinal and complete body survive.
    assert.equal(nodes(xml(buffer), "p").map(p => nodes(p, "t").map(t => t.textContent).join("")).at(-1), text.replace("第一条", "1."), `seed ${seed}`);
    assert.equal(nodes(xml(buffer), "numPr").length, 0);
    assert.ok(nodes(xml(buffer), "sz").every(node => node.getAttributeNS(W, "val") === "24"));
    assert.ok(nodes(xml(buffer), "szCs").every(node => node.getAttributeNS(W, "val") === "24"));
  }
});

const types = ["position-paper", "position-paper", "working-paper", "working-paper", "draft-directive", "draft-directive", "draft-resolution", "draft-resolution", "friendly-amendment", "unfriendly-amendment", "friendly-amendment"];
const fixtureDir = new URL("../examples/acceptance-inputs/", import.meta.url);
for (const [index, filename] of (await readdir(fixtureDir)).filter(name => name.endsWith(".docx")).sort().entries()) {
  test(`committed fixture ${filename}: text/control preservation and repeat formatting`, async () => {
    const bytes = await readFile(new URL(filename, fixtureDir));
    const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const first = await format(input, types[index]);
    // Compare body text independently of authorized title/metadata/list-marker edits.
    const body = (buffer) => {
      const model = parseDocxInBrowser(buffer, types[index]);
      return [...model.body_clauses, ...model.preambulatory_clauses, ...model.operative_clauses]
        .sort((a,b) => a.paragraph_index-b.paragraph_index).map(c => c.text.replace(/^\s*(?:第[一二三四五六七八九十]+条|\d+[.、)]|[（(][a-z一二三四五六七八九十子丑寅卯辰巳午未申酉戌亥甲乙丙丁戊己庚辛壬癸]+[）)])\s*/i, "").replace(/[，,；;。.:：]+\s*$/, ""));
    };
    assert.deepEqual(body(input), body(first.buffer));
    const second = await format(first.buffer, types[index]);
    assert.equal(new XMLSerializer().serializeToString(xml(first.buffer)), new XMLSerializer().serializeToString(xml(second.buffer)));
  });
}
