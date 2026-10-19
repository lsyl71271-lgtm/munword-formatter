// The mini program pages, run in a simulated WeChat logic layer: a bare
// JavaScript context with App/Page/getApp/wx and a CommonJS require, as the
// WeChat runtime provides them. The tests pick the committed samples "from a
// chat", walk the four steps through the page's own handlers, and require the
// written .docx to equal what the web page produces for the same choices. The
// view layer (WXML) is checked statically: every handler and data name it uses
// must exist on its page.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import path from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import * as web from "../app/docx-browser.ts";
import { generateFromTemplate as webTemplate } from "../app/template-generator.ts";
import { samePackage } from "./support/package-compare.mjs";

const window = new JSDOM("").window;
globalThis.DOMParser = window.DOMParser;
globalThis.XMLSerializer = window.XMLSerializer;

const ROOT = fileURLToPath(new URL("../miniprogram/", import.meta.url));
const fixtures = fileURLToPath(new URL("../examples/acceptance-inputs/", import.meta.url));
const samples = readdirSync(fixtures).filter(name => name.endsWith(".docx")).sort();
const pageSource = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const templateSource = readFileSync(new URL("../app/template-panel.tsx", import.meta.url), "utf8");
const TYPES = ["position-paper", "working-paper", "draft-directive", "draft-resolution", "friendly-amendment", "unfriendly-amendment", "diplomatic-agreement", "joint-statement"];
const USER_DATA_PATH = "wxfile://usr";
const SET_DATA_LIMIT = 1024 * 1024;

const plain = value => JSON.parse(JSON.stringify(value));
const outcome = fn => { try { return { value: fn() }; } catch (error) { return { error: error.message }; } };
const sampleBytes = name => { const bytes = readFileSync(path.join(fixtures, name)); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); };

/** A fresh WeChat logic layer with the mini program loaded. */
function boot() {
  const chat = new Map(), disk = new Map(), calls = [];
  let nextChoice = null, loading = 0;
  const async = (options, run) => setTimeout(() => {
    let result;
    try { result = run(); } catch (error) { if (options.fail) options.fail({ errMsg: error.message }); return; }
    if (options.success) options.success(result);
  }, 0);
  const fs = {
    readFile(options) { async(options, () => { if (!chat.has(options.filePath)) throw new Error(`readFile:fail no such file ${options.filePath}`); return { data: chat.get(options.filePath).slice(0) }; }); },
    writeFile(options) { async(options, () => { assert.ok(options.filePath.startsWith(`${USER_DATA_PATH}/`), "only the app's own folder is writable"); disk.set(options.filePath, new Uint8Array(options.data.slice(0))); return {}; }); },
    rmdirSync(dir) { const keys = [...disk.keys()].filter(key => key.startsWith(`${dir}/`)); if (!keys.length) throw new Error("rmdirSync:fail no such file or directory"); keys.forEach(key => disk.delete(key)); },
    mkdirSync() {},
  };
  const record = name => options => { calls.push({ name, options }); async(options, () => ({})); };
  const wx = {
    env: { USER_DATA_PATH },
    getFileSystemManager: () => fs,
    chooseMessageFile(options) {
      calls.push({ name: "chooseMessageFile", options });
      const choice = nextChoice;
      nextChoice = null;
      async(options, () => { if (!choice) throw new Error("chooseMessageFile:fail cancel"); return { tempFiles: [choice] }; });
    },
    showLoading() { loading += 1; },
    hideLoading() { loading = Math.max(0, loading - 1); },
    openDocument: record("openDocument"),
    shareFileMessage: record("shareFileMessage"),
    saveFileToDisk: record("saveFileToDisk"),
    pageScrollTo: record("pageScrollTo"),
    navigateTo: record("navigateTo"),
    setNavigationBarTitle: record("setNavigationBarTitle"),
  };

  const definitions = {};
  let app = null, current = "";
  const context = vm.createContext({ console, setTimeout, clearTimeout, wx,
    App: definition => { app = definition; },
    Page: definition => { definitions[current] = definition; },
    getApp: () => app,
  });
  const cache = new Map();
  const load = file => {
    if (cache.has(file)) return cache.get(file).exports;
    const cjs = { exports: {} };
    cache.set(file, cjs);
    const require = request => {
      assert.ok(request.startsWith("."), `only relative requires exist in a mini program: ${request}`);
      return load(path.resolve(path.dirname(file), request));
    };
    vm.runInContext(`(function (require, module, exports) {${readFileSync(file, "utf8")}\n})`, context, { filename: file })(require, cjs, cjs.exports);
    return cjs.exports;
  };
  load(path.join(ROOT, "app.js"));
  // Record what the pages hand the engine, so options that leave a sample unchanged are still checked.
  const formats = [], engineOf = app.engine.bind(app);
  let recorded = null;
  app.engine = () => recorded || (recorded = Object.create(engineOf(), { formatDocxInBrowser: { value(bytes, model, options) {
    formats.push(plain({ model, options }));
    return engineOf().formatDocxInBrowser(bytes, model, options);
  } } }));
  for (const page of JSON.parse(readFileSync(path.join(ROOT, "app.json"), "utf8")).pages) {
    current = page;
    load(path.join(ROOT, `${page}.js`));
  }

  /** A page instance the way the framework makes one: the definition's methods, its own data, setData. */
  function open(route, query = {}) {
    const definition = definitions[route];
    assert.ok(definition, `${route} registered a page`);
    const page = Object.assign({}, definition, { data: plain(definition.data), route, sizes: [] });
    page.setData = patch => {
      const json = JSON.stringify(patch);
      assert.ok(json !== undefined, "setData takes plain data");
      page.sizes.push(Buffer.byteLength(json));
      assert.ok(Buffer.byteLength(json) < SET_DATA_LIMIT, `setData under 1 MB (was ${Buffer.byteLength(json)} bytes)`);
      for (const [key, value] of Object.entries(JSON.parse(json))) {
        const parts = key.split(".");
        let target = page.data;
        for (const part of parts.slice(0, -1)) target = target[part] = target[part] && typeof target[part] === "object" ? target[part] : {};
        target[parts.at(-1)] = value;
      }
      // Fields set to undefined are dropped by the real setData too; JSON drops them here.
    };
    if (page.onLoad) page.onLoad(query);
    return page;
  }

  return {
    open, calls, disk, formats, context, engine: () => app.engine(),
    get loading() { return loading; },
    pick(name, bytes, size = bytes.byteLength) {
      const filePath = `wxfile://tmp/${calls.length}-${name}`;
      chat.set(filePath, bytes);
      nextChoice = { path: filePath, name, size, type: "file" };
    },
  };
}

const settle = async (page, done = () => !page.data.busy) => {
  const until = Date.now() + 120_000;
  await new Promise(resolve => setTimeout(resolve, 0));
  while (!done()) {
    assert.ok(Date.now() < until, "the page finished in time");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await new Promise(resolve => setTimeout(resolve, 0));
};
const event = (dataset, value) => ({ currentTarget: { dataset }, detail: { value } });

/** Steps 01 and 02 through the page's handlers. */
async function upload(runtime, page, type, name) {
  page.onSelectType(event({ type }));
  runtime.pick(name, sampleBytes(name));
  page.onChooseFile();
  await settle(page, () => page.data.file || page.data.error);
  assert.equal(page.data.file && page.data.file.name, name);
  page.onParse();
  await settle(page);
}

// What the web page passes for the same choices (app/page.tsx formatAndDownload).
const webOptions = (type, model, name, typed = {}) => type === "draft-resolution"
  ? { sessionLabel: "", submittingCountry: "", version: "", normalizePunctuation: true, preserveCountryOrder: false, sourceName: name }
  : { sessionLabel: typed.sessionLabel || "", submittingCountry: typed.submittingCountry ?? (model.country || model.sponsors[0] || ""), version: typed.version || "v1",
    normalizePunctuation: true, preserveCountryOrder: false, sourceName: name };

test("the project is complete and fits the main package", () => {
  const app = JSON.parse(readFileSync(path.join(ROOT, "app.json"), "utf8"));
  for (const page of app.pages) for (const ext of ["js", "json", "wxml", "wxss"]) assert.ok(statSync(path.join(ROOT, `${page}.${ext}`)).isFile(), `${page}.${ext}`);
  assert.ok(statSync(path.join(ROOT, app.sitemapLocation)).isFile());
  const config = JSON.parse(readFileSync(path.join(ROOT, "project.config.json"), "utf8"));
  assert.ok(config.appid && config.libVersion);
  let total = 0;
  const walk = dir => { for (const name of readdirSync(dir)) { const file = path.join(dir, name); if (statSync(file).isDirectory()) walk(file); else if (!config.packOptions.ignore.some(rule => rule.value === name)) total += statSync(file).size; } };
  walk(ROOT);
  assert.ok(total < 2 * 1024 * 1024, `main package is ${total} bytes; the limit is 2 MB`);
});

test("page code uses only what the mini program runtime has", () => {
  for (const file of ["app.js", "utils/flow.js", "utils/files.js", ...["index", "template", "about"].map(page => `pages/${page}/${page}.js`)]) {
    const code = readFileSync(path.join(ROOT, file), "utf8").replace(/\/\/.*$/gm, "");
    for (const name of ["window", "document", "localStorage", "fetch", "process", "Buffer", "eval", "Function", "import"]) {
      assert.doesNotMatch(code, new RegExp(`\\b${name}\\b\\s*[.(\\[]`), `${file} uses ${name}`);
    }
  }
});

test("the type list, step-03 fields, template fields and messages are the web page's", () => {
  const runtime = boot();
  const page = runtime.open("pages/index/index");
  const webTypes = [...pageSource.matchAll(/\{ id: "([^"]+)", zh: "([^"]+)", en: "([^"]+)", badge: "([^"]+)" \}/g)].map(([, id, zh, en, badge]) => ({ id, zh, en, badge }));
  assert.equal(webTypes.length, 8);
  assert.deepEqual(page.data.types, webTypes);
  for (const message of ["请上传 .docx 文件。旧版 .doc、PDF 和纯文本将在后续版本支持。", "文件超过 20 MB，请精简图片后重试。", "文件识别失败，请检查 DOCX 后重试。"]) {
    assert.ok(pageSource.includes(message), message);
  }
  const template = runtime.open("pages/template/template");
  for (const [index, type] of TYPES.entries()) {
    template.onTypeChange(event({}, String(index)));
    const keys = template.data.fields.map(field => field.key);
    for (const field of template.data.fields) assert.ok(templateSource.includes(`"${field.label}"`), `${type}: template label ${field.label}`);
    const treaty = type === "diplomatic-agreement" || type === "joint-statement";
    // The conditions of app/template-panel.tsx, read off its source above.
    const expected = treaty ? ["sponsors", "topic"]
      : ["committee", ...(type !== "draft-directive" ? ["topic"] : []), ...(type === "position-paper" ? ["country", "delegate"] : ["sponsors", ...(type !== "working-paper" ? ["signatories"] : [])])];
    assert.deepEqual(keys, expected, `${type}: template fields`);
  }
});

test("step 03 shows the web page's fields for every type and sample", async () => {
  const runtime = boot();
  const page = runtime.open("pages/index/index");
  for (const name of samples) for (const type of TYPES) {
    await upload(runtime, page, type, name);
    const expected = outcome(() => web.parseDocxInBrowser(sampleBytes(name), type));
    if (expected.error) {
      assert.equal(page.data.error, expected.error, `${name} as ${type}: same error`);
      assert.equal(page.data.view, null);
      continue;
    }
    const model = expected.value, treaty = web.isTreaty(type);
    assert.equal(page.data.error, "", `${name} as ${type}`);
    assert.equal(page.data.stage, "review");
    // app/page.tsx: a draft resolution keeps the uploaded name, so it asks for no session, country or version.
    assert.equal(page.data.keepsSourceName, type === "draft-resolution", `${type}: file name options`);
    assert.equal(page.data.treaty, treaty);
    const labels = page.data.fields.map(field => field.label);
    for (const label of labels) assert.ok(pageSource.includes(`${label}<input`), `${type}: label ${label} is the web page's`);
    // The conditions of app/page.tsx step 03.
    const keys = treaty ? ["sponsors"] : ["committee", "topic", ...(type === "position-paper" ? ["country", "delegate"] : ["sponsors"]), ...(!["position-paper", "working-paper"].includes(type) ? ["signatories"] : [])];
    assert.deepEqual(page.data.fields.map(field => field.key), keys, `${type}: step-03 fields`);
    assert.equal(page.data.values.sponsors, model.sponsors.join("，"));
    assert.equal(page.data.values.signatories, model.signatories.join("，"));
    assert.equal(page.data.values.committee, model.committee);
    assert.equal(page.data.languageIndex, model.language === "en" ? 1 : 0);
    assert.equal(page.data.options.submittingCountry, model.country || model.sponsors[0] || "");
    assert.deepEqual(page.data.view.warnings, model.warnings);
    const clauses = [...model.preambulatory_clauses, ...model.operative_clauses, ...model.body_clauses].sort((a, b) => a.paragraph_index - b.paragraph_index);
    assert.equal(page.data.view.clauseTotal, clauses.length);
    assert.deepEqual(page.data.view.clauses.map(clause => clause.paragraph), clauses.slice(0, 300).map(clause => clause.paragraph_index + 1));
    assert.equal(page.data.view.countries === null, treaty);
    assert.equal(runtime.loading, 0, "the loading toast is closed");
  }
  assert.ok(Math.max(...page.sizes) < 256 * 1024, `largest setData was ${Math.max(...page.sizes)} bytes`);
});

// Each sample through all four steps under the type it was written as. Which type
// a sample is does not reach the page: the page only sees what the test taps.
const AS_WRITTEN = ["position-paper", "position-paper", "working-paper", "working-paper", "draft-directive", "draft-directive", "draft-resolution", "draft-resolution",
  "friendly-amendment", "unfriendly-amendment", "friendly-amendment", "diplomatic-agreement", "joint-statement", "joint-statement"];

for (const [index, name] of samples.entries()) {
  const type = AS_WRITTEN[index];
  test(`${name}: the four steps write the document the web page writes`, async () => {
    const runtime = boot();
    const page = runtime.open("pages/index/index");
    await upload(runtime, page, type, name);
    const model = web.parseDocxInBrowser(sampleBytes(name), type);
    const typed = type === "draft-resolution" ? {} : { sessionLabel: "第二会期" };
    if (typed.sessionLabel) page.onOptionInput(event({ key: "sessionLabel" }, typed.sessionLabel));
    page.onGenerate();
    await settle(page);
    assert.equal(page.data.error, "");
    assert.equal(page.data.stage, "done");
    const expected = web.formatDocxInBrowser(sampleBytes(name), model, webOptions(type, model, name, typed));
    assert.deepEqual(runtime.formats.map(call => call.options), [webOptions(type, model, name, typed)]);
    assert.equal(page.data.result.filename, expected.filename);
    if (type === "draft-resolution") assert.equal(page.data.result.filename, name, "a draft resolution keeps the uploaded name");
    assert.deepEqual(page.data.validations.map(item => [item.status, item.label, item.detail]), expected.validations.map(item => [item.status, item.label, item.detail || ""]));
    assert.deepEqual([...runtime.disk.keys()], [page.data.result.path]);
    await samePackage(expected.blob, runtime.disk.get(page.data.result.path), `${name} as ${type}`);
    assert.equal(runtime.loading, 0);

    page.onOpenResult();
    page.onShareResult();
    page.onSaveResult();
    await settle(page);
    const by = name => runtime.calls.filter(call => call.name === name).map(call => call.options);
    assert.deepEqual(plain(by("openDocument")).map(options => [options.filePath, options.fileType, options.showMenu]), [[page.data.result.path, "docx", true]]);
    assert.deepEqual(by("shareFileMessage").map(options => [options.filePath, options.fileName]), [[page.data.result.path, page.data.result.filename]]);
    assert.deepEqual(by("saveFileToDisk").map(options => options.filePath), [page.data.result.path]);
  });
}

test("step-03 edits are kept as typed and reach the document", async () => {
  const runtime = boot();
  const page = runtime.open("pages/index/index");
  const name = "09_中文友好修正案.docx", type = "friendly-amendment";
  await upload(runtime, page, type, name);
  page.onFieldInput(event({ key: "committee" }, "联合国大会第一委员会"));
  page.onFieldInput(event({ key: "sponsors" }, "法国，日本，"));
  page.onFieldInput(event({ key: "signatories" }, "巴西"));
  page.onLanguageChange(event({}, "0"));
  page.onOptionInput(event({ key: "submittingCountry" }, "法国"));
  page.onOptionInput(event({ key: "version" }, "v3"));
  page.onOptionSwitch(event({ key: "normalizePunctuation" }, false));
  page.onOptionSwitch(event({ key: "preserveOrder" }, true));
  assert.equal(page.data.values.sponsors, "法国，日本，", "the text box keeps the trailing separator");
  assert.ok(page.data.view.summary.some(item => item.value.includes("法国") && item.value.includes("日本")));
  page.onGenerate();
  await settle(page);
  const model = { ...web.parseDocxInBrowser(sampleBytes(name), type), committee: "联合国大会第一委员会", sponsors: ["法国", "日本"], signatories: ["巴西"], language: "zh" };
  const options = { sessionLabel: "", submittingCountry: "法国", version: "v3", normalizePunctuation: false, preserveCountryOrder: true, sourceName: name };
  assert.deepEqual(runtime.formats.map(call => call.options), [options]);
  assert.deepEqual(runtime.formats[0].model, plain(model));
  const expected = web.formatDocxInBrowser(sampleBytes(name), model, options);
  assert.equal(page.data.result.filename, expected.filename);
  await samePackage(expected.blob, runtime.disk.get(page.data.result.path), "edited");

  page.onFieldInput(event({ key: "topic" }, "外空"));
  assert.equal(page.data.result, null, "a changed field drops the earlier result");
  assert.deepEqual(page.data.validations, []);
  assert.equal(page.data.stage, "review");
});

test("a change while generating discards that result", async () => {
  const runtime = boot();
  const page = runtime.open("pages/index/index");
  await upload(runtime, page, "working-paper", "03_中文工作文件.docx");
  page.onGenerate();
  assert.equal(page.data.busy, true);
  page.onFieldInput(event({ key: "topic" }, "新议题"));
  assert.equal(page.data.busy, false);
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal(page.data.result, null);
  assert.equal(runtime.disk.size, 0, "nothing was written");
  assert.equal(runtime.loading, 0);
  page.onSelectType(event({ type: "position-paper" }));
  assert.equal(page.data.file, null, "a new type starts over");
});

test("choosing a file: wrong type, too large, cancelled", async () => {
  const runtime = boot();
  const page = runtime.open("pages/index/index");
  const choose = async (name, size) => {
    if (name) runtime.pick(name, new ArrayBuffer(8), size);
    page.onChooseFile();
    await settle(page, () => runtime.calls.filter(call => call.name === "chooseMessageFile").length && true);
    await new Promise(resolve => setTimeout(resolve, 20));
  };
  await choose("旧稿.doc", 100);
  assert.equal(page.data.error, "请上传 .docx 文件。旧版 .doc、PDF 和纯文本将在后续版本支持。");
  assert.equal(page.data.file, null);
  await choose("大文件.DOCX", 20 * 1024 * 1024 + 1);
  assert.equal(page.data.error, "文件超过 20 MB，请精简图片后重试。");
  await choose("正常.docx", 2048);
  assert.equal(page.data.error, "");
  assert.equal(page.data.file.sizeText, "2.0 KB");
  await choose(null);
  assert.equal(page.data.error, "", "cancelling the picker is not an error");
  assert.equal(page.data.file.name, "正常.docx", "and keeps the file");
  assert.deepEqual(plain(runtime.calls.find(call => call.name === "chooseMessageFile").options.extension), ["docx"]);
  page.onParse();
  await settle(page);
  assert.equal(page.data.error, outcome(() => web.parseDocxInBrowser(new ArrayBuffer(8), "draft-resolution")).error, "an unreadable file shows the web engine's message");
  assert.equal(runtime.loading, 0);
});

test("the template page writes the web template for every type and language", async () => {
  const runtime = boot();
  const page = runtime.open("pages/template/template", { type: "joint-statement" });
  assert.equal(page.data.typeIndex, TYPES.indexOf("joint-statement"));
  const values = { committee: "联合国大会第三委员会", topic: "数字时代的儿童保护", country: "日本国", delegate: "示例代表", sponsors: "日本国，巴西联邦共和国，加拿大", signatories: "法兰西共和国" };
  for (const [index, type] of TYPES.entries()) for (const language of [0, 1]) {
    page.onTypeChange(event({}, String(index)));
    page.onLanguageChange(event({}, String(language)));
    for (const field of page.data.fields) page.onInput(event({ key: field.key }, values[field.key]));
    page.onInput(event({ key: "body" }, "注意到数字技术的发展，\n1. 呼吁各国加强合作；\n2. 决定继续审议该问题。"));
    page.onGenerate();
    await settle(page);
    assert.equal(page.data.error, "", `${type}/${language}`);
    const input = plain(page.data.input);
    const expected = webTemplate(type, input);
    assert.equal(page.data.result.filename, expected.filename);
    await samePackage(expected.blob, runtime.disk.get(page.data.result.path), `template ${type}/${language}`);
    assert.equal(runtime.disk.size, 1, "the previous result is replaced");
  }
  page.onInput(event({ key: "body" }, "   "));
  assert.equal(page.data.result, null);
  page.onGenerate();
  await settle(page);
  assert.match(page.data.error, /请先填写正文/);
  assert.equal(runtime.loading, 0);
});

test("other pages open from the first page", () => {
  const runtime = boot();
  const page = runtime.open("pages/index/index");
  page.onSelectType(event({ type: "position-paper" }));
  page.onOpenTemplate();
  page.onOpenAbout();
  assert.deepEqual(runtime.calls.filter(call => call.name === "navigateTo").map(call => call.options.url), ["/pages/template/template?type=position-paper", "/pages/about/about"]);
  const about = runtime.open("pages/about/about");
  assert.equal(about.data.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.equal(typeof page.onShareAppMessage().path, "string");
});

// The view layer: what each WXML file binds must exist on its page.
const KEYWORDS = new Set(["item", "index", "true", "false", "null", "undefined"]);
for (const route of ["pages/index/index", "pages/template/template", "pages/about/about"]) {
  test(`${route}.wxml is well-formed and binds only what the page has`, () => {
    const wxml = readFileSync(path.join(ROOT, `${route}.wxml`), "utf8");
    const expressions = [...wxml.matchAll(/\{\{([\s\S]*?)\}\}/g)].map(match => match[1]);
    // As XML: expressions blanked, the wx: prefix declared, and wx:else (always written bare) given a value.
    const xml = wxml.replace(/\{\{[\s\S]*?\}\}/g, "x").replace(/ wx:else(?=[\s/>])/g, ' wx:else=""');
    const document = new window.DOMParser().parseFromString(`<root xmlns:wx="wx">${xml}</root>`, "application/xml");
    assert.equal(document.getElementsByTagName("parsererror").length, 0, "WXML tags are balanced");
    const runtime = boot();
    const page = runtime.open(route);
    for (const [, handler] of wxml.matchAll(/\b(?:bind|catch)[a-z]+="([^"]+)"/g)) assert.equal(typeof page[handler], "function", `${route}: handler ${handler}`);
    for (const expression of expressions) {
      const names = expression.replace(/'[^']*'|"[^"]*"/g, "").match(/(?<![.\w$])[A-Za-z_$][\w$]*/g) || [];
      for (const name of names) if (!KEYWORDS.has(name)) assert.ok(name in page.data, `${route}: {{${expression}}} uses ${name}, which the page's data lacks`);
    }
    for (const input of document.getElementsByTagName("input")) assert.equal(input.getAttribute("maxlength"), "-1", "no 140-character input limit");
    for (const input of document.getElementsByTagName("textarea")) assert.equal(input.getAttribute("maxlength"), "-1", "no 140-character textarea limit");
  });
}

test("styles avoid what older WeChat clients do not support", () => {
  for (const file of ["app.wxss", "pages/index/index.wxss", "pages/template/template.wxss", "pages/about/about.wxss"]) {
    const css = readFileSync(path.join(ROOT, file), "utf8");
    assert.doesNotMatch(css, /(^|[;{\s])(row-|column-)?gap\s*:/m, `${file}: flex gap needs iOS 14.5`);
    assert.doesNotMatch(css, /:has\(|@container|\bclamp\(/, file);
  }
});
