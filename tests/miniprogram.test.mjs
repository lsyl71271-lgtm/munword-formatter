// The WeChat mini program runs the shared engine from one bundle,
// miniprogram/lib/munword-engine.js. These tests load that bundle the way the
// mini program does (a bare JavaScript context: no DOM, no Blob, no
// TextEncoder, no Buffer, no window) and require that it reads and writes every
// committed sample exactly as the web engine does.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile, readdir } from "node:fs/promises";
import { JSDOM } from "jsdom";
import * as web from "../app/docx-browser.ts";
import { generateFromTemplate as webTemplate } from "../app/template-generator.ts";
import { bundle, importRuntime, OUTPUT } from "../miniprogram-engine/build.mjs";
import { createRequire } from "node:module";
import { samePackage } from "./support/package-compare.mjs";

const window = new JSDOM("").window;
globalThis.DOMParser = window.DOMParser;
globalThis.XMLSerializer = window.XMLSerializer;

const { lookbehindFallback } = await importRuntime();
const source = await readFile(new URL(`../${OUTPUT}`, import.meta.url), "utf8");

// iOS before 16.4 (WeChat's logic layer there is the system JavaScriptCore) rejects lookbehind.
const OLD_IOS_REGEXP = `const Native = RegExp;
  globalThis.RegExp = function RegExp(pattern, flags) {
    if (/\\(\\?<[=!]/.test(pattern instanceof Native ? pattern.source : String(pattern))) throw new SyntaxError("Invalid regular expression: invalid group specifier name");
    return flags === undefined ? new Native(pattern) : new Native(pattern, flags);
  };
  globalThis.RegExp.prototype = Native.prototype;
  Object.setPrototypeOf(globalThis.RegExp, Native);`;

/** The bundle evaluated in a fresh context holding only the JavaScript built-ins. */
function loadBundle({ oldIos = false } = {}) {
  const context = vm.createContext({ console });
  if (oldIos) vm.runInContext(OLD_IOS_REGEXP, context);
  const cjs = { exports: {} };
  vm.runInContext(`(function (module, exports) {${source}\n})`, context, { filename: OUTPUT })(cjs, cjs.exports);
  return { engine: cjs.exports, context };
}
const { engine: mini, context } = loadBundle();

// Values made inside the vm context have that context's prototypes; compare them as data.
const plain = value => JSON.parse(JSON.stringify(value));
const outcome = fn => { try { return { value: fn() }; } catch (error) { return { error: error.message }; } };

const TYPES = ["position-paper", "working-paper", "draft-directive", "draft-resolution", "friendly-amendment", "unfriendly-amendment", "diplomatic-agreement", "joint-statement"];
const OPTIONS = { sessionLabel: "S1", submittingCountry: "", version: "v1", normalizePunctuation: true, preserveCountryOrder: false };
const fixtures = new URL("../examples/acceptance-inputs/", import.meta.url);
const samples = (await readdir(fixtures)).filter(name => name.endsWith(".docx")).sort();

test("the committed bundle is built from the current engine source", async () => {
  assert.equal(source, await bundle(), "run: node miniprogram-engine/build.mjs");
});

test("the bundle needs none of the browser or Node globals", () => {
  for (const name of ["DOMParser", "XMLSerializer", "TextEncoder", "TextDecoder", "Blob", "Buffer", "window", "document", "process", "require"]) {
    assert.equal(vm.runInContext(`typeof ${name}`, context), "undefined", `${name} must not exist in the test context`);
  }
  for (const name of ["parseDocxInBrowser", "formatDocxInBrowser", "isTreaty", "generateFromTemplate", "buildDiagnosticReport", "planCountries", "countryWarnings", "splitCountryNames"]) {
    assert.equal(typeof mini[name], "function", name);
  }
  assert.equal(mini.MAX_UPLOAD, 20 * 1024 * 1024);
});

for (const sample of samples) {
  test(`${sample}: the mini program engine matches the web engine for all ${TYPES.length} document types`, async () => {
    const bytes = await readFile(new URL(sample, fixtures));
    const input = () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    for (const type of TYPES) {
      const label = `${sample} as ${type}`;
      const a = outcome(() => web.parseDocxInBrowser(input(), type));
      const b = outcome(() => mini.parseDocxInBrowser(input(), type));
      assert.deepEqual(plain(b), plain(a), `${label}: parse`);
      if (a.error) continue;
      const options = { ...OPTIONS, sourceName: sample };
      const x = outcome(() => web.formatDocxInBrowser(input(), a.value, options));
      const y = outcome(() => mini.formatDocxInBrowser(input(), b.value, options));
      assert.equal(y.error, x.error, `${label}: format error`);
      if (x.error) continue;
      assert.equal(y.value.filename, x.value.filename, `${label}: filename`);
      assert.deepEqual(plain(y.value.validations), plain(x.value.validations), `${label}: validations`);
      await samePackage(x.value.blob, y.value.blob, label);
    }
  });
}

test("step-03 edits reach the output the same way in both engines", async () => {
  const bytes = await readFile(new URL("07_中文决议草案.docx", fixtures));
  const input = () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const edit = model => ({ ...model, committee: "联合国大会第一委员会", topic: "外空军备竞赛", sponsors: ["法国", "日本"], signatories: ["巴西"] });
  const a = edit(web.parseDocxInBrowser(input(), "draft-resolution"));
  const b = edit(plain(mini.parseDocxInBrowser(input(), "draft-resolution")));
  const options = { sessionLabel: "", submittingCountry: "", version: "", normalizePunctuation: false, preserveCountryOrder: true, sourceName: "07_中文决议草案.docx" };
  const x = web.formatDocxInBrowser(input(), a, options), y = mini.formatDocxInBrowser(input(), b, options);
  assert.deepEqual(plain(y.validations), plain(x.validations));
  assert.ok(y.validations.some(item => item.code === "manual-field" && item.label.includes("委员会")), "the committee edit is written");
  await samePackage(x.blob, y.blob, "edited DR");
});

test("templates: both engines generate the same new documents", async () => {
  const base = { language: "zh", committee: "联合国大会第三委员会", topic: "数字时代的儿童保护", country: "日本国", delegate: "示例代表",
    sponsors: "日本国，巴西联邦共和国，加拿大", signatories: "法兰西共和国", body: "注意到数字技术的发展，\n1. 呼吁各国加强合作；\n2. 决定继续审议该问题。" };
  for (const type of TYPES) for (const language of ["zh", "en"]) {
    const input = { ...base, language };
    const x = outcome(() => webTemplate(type, input)), y = outcome(() => mini.generateFromTemplate(type, input));
    assert.equal(y.error, x.error, `${type}/${language}: error`);
    if (x.error) continue;
    assert.equal(y.value.filename, x.value.filename, `${type}/${language}: filename`);
    await samePackage(x.value.blob, y.value.blob, `template ${type}/${language}`);
  }
  assert.throws(() => mini.generateFromTemplate("position-paper", { ...base, body: "  " }), /请先填写正文/);
});

test("no regular expression literal in the bundle uses lookbehind (old iOS could not even load it)", () => {
  const espree = createRequire(createRequire(import.meta.url).resolve("eslint"))("espree");
  const literals = espree.tokenize(source, { ecmaVersion: 2017 }).filter(token => token.type === "RegularExpression");
  assert.ok(literals.length > 100);
  assert.deepEqual(literals.filter(token => /\(\?<[=!]/.test(token.value)).map(token => token.value), []);
});

test("lookbehind emulation splits and tests like the native pattern", () => {
  const separators = "[、，,；;]|以及|及|与|同|(?<!共)和(?!平)";
  const native = new RegExp(`(${separators})`), emulated = lookbehindFallback(`(${separators})`, "");
  const titles = ["中华人民共和国和法兰西共和国关于和平利用核能的协定", "日本国、巴西联邦共和国与加拿大", "大不列颠及北爱尔兰联合王国和中华人民共和国", "共和和共和国和平和", "和", "共和", "",
    "阿拉伯叙利亚共和国，大韩民国；老挝人民民主共和国以及越南社会主义共和国同蒙古国"];
  for (const title of titles) {
    assert.deepEqual(title.split(emulated), title.split(native), title);
    assert.equal(emulated.test(title), native.test(title), title);
  }
  assert.throws(() => lookbehindFallback("(?<=a)b"), SyntaxError);
});

test("on a runtime without lookbehind (old iOS), treaty documents still match the web engine", async () => {
  const { engine: oldIos, context: oldContext } = loadBundle({ oldIos: true });
  assert.throws(() => vm.runInContext('new RegExp("(?<!a)b")', oldContext), { name: "SyntaxError" });
  for (const sample of samples) {
    const bytes = await readFile(new URL(sample, fixtures));
    const input = () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    for (const type of ["diplomatic-agreement", "joint-statement"]) {
      const label = `${sample} as ${type} (old iOS)`;
      const a = outcome(() => web.parseDocxInBrowser(input(), type)), b = outcome(() => oldIos.parseDocxInBrowser(input(), type));
      assert.deepEqual(plain(b), plain(a), `${label}: parse`);
      if (a.error) continue;
      const options = { ...OPTIONS, sourceName: sample };
      const x = outcome(() => web.formatDocxInBrowser(input(), a.value, options)), y = outcome(() => oldIos.formatDocxInBrowser(input(), b.value, options));
      assert.equal(y.error, x.error, `${label}: format error`);
      if (!x.error) await samePackage(x.value.blob, y.value.blob, label);
    }
  }
  const input = { language: "zh", committee: "", topic: "海洋塑料污染治理", country: "", delegate: "", sponsors: "中华人民共和国，法兰西共和国，大韩民国", signatories: "", body: "各方同意加强合作。" };
  for (const type of ["diplomatic-agreement", "joint-statement"]) await samePackage(webTemplate(type, input).blob, oldIos.generateFromTemplate(type, input).blob, `template ${type} (old iOS)`);
});

test("an unreadable upload fails with the web engine's message, not a crash", () => {
  const junk = new TextEncoder().encode("not a docx").buffer;
  const a = outcome(() => web.parseDocxInBrowser(junk, "position-paper"));
  const b = outcome(() => mini.parseDocxInBrowser(junk, "position-paper"));
  assert.ok(a.error && b.error);
  assert.equal(b.error, a.error);
});
