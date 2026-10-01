import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JSDOM } from "jsdom";
import { unzipSync } from "fflate";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const outputDir = process.env.MUNWORD_REGRESSION_OUTPUT || path.join(os.tmpdir(), "munword-browser-regression");
const dom = new JSDOM("");
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;

const { parseDocxInBrowser, formatDocxInBrowser } = await import("../app/docx-browser.ts");
const { visibleText } = await import("../app/docx-safety.ts");
// Optional fixture relocation; never used by the production formatting engine.
const fixtureRoot = process.env.MUNWORD_FIXTURE_ROOT;
const fixturePath = value => {
  if (!fixtureRoot) throw new Error("请通过 MUNWORD_FIXTURE_ROOT 指定外部回归样例目录。");
  return path.join(fixtureRoot, value);
};
const fixtures = [
  {
    name: "position-paper-corruption",
    type: "position-paper",
    input: "pp/瑞典立场文件-坏.docx",
    reference: "pp/瑞典立场文件_副本.docx",
  },
  {
    name: "working-paper-corruption",
    type: "working-paper",
    input: "wp/工作文件5.2 (1)-坏.docx",
    reference: "wp/工作文件5.2.docx",
  },
  {
    name: "draft-resolution-corruption",
    type: "draft-resolution",
    input: "dr/决议草案6.1-坏.docx",
    reference: "dr/决议草案6.1_副本.docx",
  },
  {
    name: "unfriendly-amendment-corruption",
    type: "unfriendly-amendment",
    input: "非友好修正案/非友好修正案1.3.2-坏.docx",
    reference: "非友好修正案/非友好修正案1.3.2_副本.docx",
  },
];
const cleanStressFixtures = [
  ["working-paper", "用所选项目新建的文件夹/工作文件1.6 (1).docx"],
  ["working-paper", "用所选项目新建的文件夹/工作文件1.7 (1).docx"],
  ["working-paper", "用所选项目新建的文件夹/工作文件1.8 (1).docx"],
  ["draft-resolution", "用所选项目新建的文件夹/决议草案1.2 终.docx"],
  ["draft-resolution", "用所选项目新建的文件夹/决议草案1.3终.docx"],
  ["friendly-amendment", "用所选项目新建的文件夹/友好修正案1.3.3.docx"],
];

const elements = (parent, name) => [...parent.getElementsByTagNameNS(WORD_NS, name)];
const direct = (parent, name) => parent ? [...parent.children].find((child) => child.namespaceURI === WORD_NS && child.localName === name) || null : null;
const attr = (node, name) => node?.getAttributeNS(WORD_NS, name) || node?.getAttribute(`w:${name}`) || "";
const text = visibleText;
const enabled = (run, name) => {
  const value = attr(direct(direct(run, "rPr"), name), "val");
  return value === "1" || value === "true" || value === "single";
};

function documentXml(bytes) {
  const parts = unzipSync(bytes);
  const document = new DOMParser().parseFromString(new TextDecoder().decode(parts["word/document.xml"]), "application/xml");
  assert.equal(document.getElementsByTagName("parsererror").length, 0, "输出 document.xml 必须可解析");
  return { parts, document, paragraphs: elements(elements(document, "body")[0], "p") };
}

function visibleLines(bytes) {
  return documentXml(bytes).paragraphs.map((paragraph) => text(paragraph).trim()).filter(Boolean);
}

function assertAllRuns(paragraph, predicate, message) {
  const runs = elements(paragraph, "r").filter((run) => text(run).trim());
  assert.ok(runs.length, `${message}：缺少可见文本片段`);
  assert.ok(runs.every(predicate), message);
}

function assertMetadataValue(paragraphs, label, { bold, italic }) {
  const paragraph = paragraphs.find((item) => text(item).trim().startsWith(label));
  assert.ok(paragraph, `缺少元数据字段：${label}`);
  const valueRuns = elements(paragraph, "r").filter((run) => !text(run).includes(label) && text(run).trim());
  assert.ok(valueRuns.length, `${label} 标签和值必须可分别排版`);
  assert.ok(valueRuns.every((run) => enabled(run, "b") === bold && enabled(run, "i") === italic), `${label} 值的粗斜体不符合策略`);
}

function assertPolicyStyles(type, paragraphs) {
  const title = paragraphs.find((paragraph) => text(paragraph).includes({
    "position-paper": "立场文件",
    "working-paper": "工作文件",
    "draft-resolution": "决议草案",
    "unfriendly-amendment": "非友好修正案",
  }[type]));
  assert.ok(title, `${type} 标题缺失`);
  assertAllRuns(title, (run) => enabled(run, "b"), `${type} 标题必须加粗`);

  if (type === "position-paper") {
    assert.ok(paragraphs.some((paragraph) => text(paragraph).startsWith("委员会：")), "立场文件必须恢复委员会标签");
    assert.ok(paragraphs.some((paragraph) => text(paragraph).startsWith("（一）")), "立场文件必须恢复缺失的第一分节");
    assertMetadataValue(paragraphs, "国家", { bold: false, italic: false });
  }
  if (type === "working-paper") {
    const committee = paragraphs.find((paragraph) => text(paragraph).startsWith("委员会"));
    assert.ok(committee, "工作文件委员会字段缺失");
    assertAllRuns(committee, (run) => enabled(run, "b") && !enabled(run, "i"), "工作文件委员会整行必须加粗且不斜体");
    assertMetadataValue(paragraphs, "起草国", { bold: true, italic: true });
    const verbs = ["鼓励", "明确", "加强"];
    for (const verb of verbs) {
      const run = paragraphs.flatMap((paragraph) => elements(paragraph, "r")).find((item) => text(item) === verb);
      assert.ok(run && enabled(run, "i"), `工作文件顶层动作词“${verb}”必须斜体`);
    }
  }
  if (type === "draft-resolution") {
    assertMetadataValue(paragraphs, "起草国", { bold: true, italic: true });
    assertMetadataValue(paragraphs, "附议国", { bold: true, italic: true });
    const continuations = paragraphs.filter((paragraph) => /^(法兰西共和国|意大利共和国)/.test(text(paragraph).trim()));
    assert.ok(continuations.length >= 2, "决议草案跨行国家字段缺失");
    for (const paragraph of continuations) assertAllRuns(paragraph, (run) => enabled(run, "b") && enabled(run, "i"), "决议草案跨行国家字段必须为粗斜体");
  }
  if (type === "unfriendly-amendment") {
    assertAllRuns(title, (run) => enabled(run, "b") && enabled(run, "i") && attr(direct(direct(run, "rPr"), "sz"), "val") === "28", "修正案标题必须为 14 磅粗斜体");
    for (const label of ["起草国", "附议国"]) {
      const paragraph = paragraphs.find((item) => text(item).trim().startsWith(label));
      assert.ok(paragraph, `修正案缺少${label}`);
      assertAllRuns(paragraph, (run) => enabled(run, "b") && enabled(run, "i") && attr(direct(direct(run, "rPr"), "sz"), "val") === "28", `修正案${label}整行必须为 14 磅粗斜体`);
    }
    const body = paragraphs.find((paragraph) => text(paragraph).trim() && paragraph !== title && !/^(起草国|附议国)/.test(text(paragraph).trim()));
    assert.ok(body, "修正案正文缺失");
    assertAllRuns(body, (run) => attr(direct(direct(run, "rPr"), "sz"), "val") === "21", "修正案正文必须为 10.5 磅");
  }
}

async function formatFile(inputPath, type) {
  const input = await readFile(fixturePath(inputPath));
  const inputBuffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  const model = parseDocxInBrowser(inputBuffer, type);
  const result = formatDocxInBrowser(inputBuffer, model, { sessionLabel: "", submittingCountry: "", version: "v1" });
  assert.ok(result.validations.every((item) => item.status !== "error"), `${inputPath} 存在失败校验：${JSON.stringify(result.validations)}`);
  return { model, result, bytes: new Uint8Array(await result.blob.arrayBuffer()) };
}

await mkdir(outputDir, { recursive: true });
const report = [];
for (const fixture of fixtures) {
  const formatted = await formatFile(fixture.input, fixture.type);
  const reference = await readFile(fixturePath(fixture.reference));
  assert.deepEqual(visibleLines(formatted.bytes), visibleLines(reference), `${fixture.name} 输出的可见段落必须与正确版本一致`);
  const parsed = documentXml(formatted.bytes);
  assertPolicyStyles(fixture.type, parsed.paragraphs);
  const outputPath = path.join(outputDir, `${fixture.name}.docx`);
  await writeFile(outputPath, formatted.bytes);
  report.push({ name: fixture.name, outputPath, validations: formatted.result.validations });
}

for (const [type, sourcePath] of cleanStressFixtures) {
  const input = await readFile(fixturePath(sourcePath));
  const formatted = await formatFile(sourcePath, type);
  assert.deepEqual(visibleLines(formatted.bytes), visibleLines(input), `正确文件重复处理后不得改变可见内容：${sourcePath}`);
  report.push({ name: path.basename(sourcePath), cleanIdempotency: true });
}

console.log(JSON.stringify({ outputDir, cases: report }, null, 2));
