import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { JSDOM } from "jsdom";
import { zipSync, unzipSync } from "fflate";
import { resolveCountry, planCountries, countryWarnings, validCountryFieldChange } from "../app/countries.ts";
import { parseDocxInBrowser, formatDocxInBrowser } from "../app/docx-browser.ts";
import { takeSnapshot, verifyFormat } from "../app/content-guard.ts";

const data = JSON.parse(readFileSync(new URL("../shared/country-names.json", import.meta.url), "utf8"));
const dom = new JSDOM(""); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer;
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main", enc = new TextEncoder();
const run = text => `<w:r><w:t>${text}</w:t></w:r>`;
const line = text => `<w:p>${run(text)}</w:p>`;
const xml = body => `<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr/></w:body></w:document>`;
const archive = body => zipSync({ "[Content_Types].xml": enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'), "word/document.xml": enc.encode(xml(body)), "word/media/preserved.dat": new Uint8Array([1,3,5,7]) }).buffer;
const options = { sessionLabel: "", submittingCountry: "", version: "v1" };
async function formatted(input, type, overrides = {}, extra = {}) {
  const result = formatDocxInBrowser(input, {...parseDocxInBrowser(input, type), ...overrides}, {...options, ...extra});
  const bytes = await result.blob.arrayBuffer(), parts = unzipSync(new Uint8Array(bytes));
  const document = new DOMParser().parseFromString(new TextDecoder().decode(parts["word/document.xml"]), "application/xml");
  const texts = [...document.getElementsByTagNameNS(W,"p")].map(p => [...p.getElementsByTagNameNS(W,"t")].map(t => t.textContent).join(""));
  return { result, bytes, parts, document, texts };
}

test("UNTERM table has stable IDs, sources and 193 members; no inferred names", () => {
  assert.equal(data.records.filter(item => item.kind === "member-state").length,193);
  assert.equal(data.records.length,197); assert.equal(new Set(data.records.map(item=>item.id)).size,197);
  for (const item of data.records) {
    assert.ok(item.formal.zh && item.formal.en && item.source && item.checked_on);
    assert.equal(item.formal.zh,item.source_formal.zh);
    assert.equal(item.formal.en,item.source_formal.en.replace(/^the /,""));
    for (const language of ["zh","en"]) assert.equal(resolveCountry(item.formal[language],language).display,item.formal[language]);
  }
});

test("whole-name resolution, language selection, formal forms and safe ambiguity", () => {
  assert.equal(resolveCountry("中国","zh").display,"中华人民共和国");
  assert.equal(resolveCountry("China","en").display,"People's Republic of China");
  assert.equal(resolveCountry("中华人民共和国","en").display,"People's Republic of China");
  assert.equal(resolveCountry("the People's Republic of China","en").display,"the People's Republic of China");
  assert.equal(resolveCountry("ｕｋ","zh").display,"大不列颠及北爱尔兰联合王国");
  assert.equal(resolveCountry("日本国","zh").display,"日本国");
  assert.equal(resolveCountry("Nepal","en").display,"Nepal");
  for (const value of ["刚果","Congo","Korea","苏联","南非联邦","未知共和国","中国与美国","新西兰中的新","英国的盟友"]) {
    assert.notEqual(resolveCountry(value,"zh").status,"resolved");
    assert.equal(resolveCountry(value,"zh").display,value); assert.ok(countryWarnings([value],"zh").length);
  }
  for (const value of ["巴勒斯坦","罗马教廷","欧盟","联合国"]) assert.equal(resolveCountry(value,"zh").status,"entity");
  assert.equal(resolveCountry("韩国","zh").display,"大韩民国");
  assert.equal(resolveCountry("刚果（金）","zh").display,"刚果民主共和国");
});

test("country identity deduplicates and sorts independently of alias spelling; idempotent", () => {
  const raw = ["美国","中国","China","中华人民共和国","日本","韩国","美国"];
  const plan = planCountries(raw,"zh");
  assert.equal(plan.removedDuplicates,3);
  assert.deepEqual(plan.values,["大韩民国","美利坚合众国","日本国","中华人民共和国"]);
  assert.deepEqual(planCountries(plan.values,"zh").values,plan.values);
  assert.deepEqual(planCountries(raw,"zh",true).values,["美利坚合众国","中华人民共和国","日本国","大韩民国"]);
  assert.deepEqual(planCountries(["China","Japan","中华人民共和国"],"en").values,["Japan","People's Republic of China"]);
  assert.deepEqual(planCountries(["刚果","刚果"],"zh").values,["刚果","刚果"]);
});

test("Python and browser agree for EVERY official name and alias, in both languages", () => {
  const names = data.records.flatMap(item => [...Object.values(item.formal),...Object.values(item.source_formal),...Object.values(item.short),...item.aliases]);
  names.push(...data.policy.ambiguous,...data.policy.historical,...data.policy.organizations,"未知国家","𠀀国","\uE000国","France\uFEFF","\u0085China","China\u200B");
  const source = `import json,sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path.cwd()/"backend"))\nfrom app.countries import resolve_country,plan_countries\nv=json.load(sys.stdin)\nprint(json.dumps({"resolutions":[resolve_country(n,l) for l in ("zh","en") for n in v],"plans":[plan_countries(v,l,p) for l in ("zh","en") for p in (False,True)]},ensure_ascii=False))`;
  const python = JSON.parse(execFileSync(process.env.MUNWORD_PYTHON || "python3",["-c",source],{input:JSON.stringify(names),maxBuffer:16*1024*1024,encoding:"utf8"}));
  assert.deepEqual(python.resolutions,["zh","en"].flatMap(l=>names.map(n=>resolveCountry(n,l))));
  assert.deepEqual(python.plans,["zh","en"].flatMap(l=>[false,true].map(p=>planCountries(names,l,p))));
});

test("DOCX fields expand with unchanged body, delegates, quotes and resources; repeat is unchanged", async () => {
  const body = "中国支持韩国。引文：中国与美国。";
  const input = archive(["立场文件","委员会：联合国大会","议题：国家合作","代表国家：中国","代表：中国",body,"国家：中国不是可替换的正文标签。"].map(line).join(""));
  const first = await formatted(input,"position-paper");
  assert.ok(first.texts.includes("国家：中华人民共和国"));
  assert.ok(first.texts.includes("代表：中国")); assert.ok(first.texts.includes(body));
  assert.ok(first.texts.includes("国家：中国不是可替换的正文标签。"));
  assert.deepEqual(first.parts["word/media/preserved.dat"],new Uint8Array([1,3,5,7]));
  assert.ok(first.result.validations.some(v=>v.code==="country_names" && v.detail.includes("UN-M49-156")));
  const second = await formatted(first.bytes,"position-paper"); assert.deepEqual(second.texts,first.texts);
});

test("automatic lists deduplicate without step 03, even with order/punctuation normalization disabled", async () => {
  const input = archive(["工作文件1.1","委员会：联合国大会","议题：合作","提案国：中国、China、中华人民共和国、美国","附议国：韩国、刚果、苏联、欧盟","第一条 要求中国与美国继续合作。"].map(line).join(""));
  const first = await formatted(input,"working-paper",{}, {preserveCountryOrder:true,normalizePunctuation:false});
  assert.ok(first.texts.join("").includes("起草国：中华人民共和国、美利坚合众国"));
  assert.ok(first.texts.join("").includes("大韩民国、刚果、苏联、欧盟"));
  assert.ok(first.texts.includes("1. 要求中国与美国继续合作。"),"WP marker changes, but countries in the body are not expanded");
  assert.equal(first.result.validations.filter(v=>v.code==="country-review").length,3);
  assert.deepEqual((await formatted(first.bytes,"working-paper",{}, {preserveCountryOrder:true,normalizePunctuation:false})).texts,first.texts);
});

test("complex country fields and lists are retained, with reasons; no hidden/revision text rewritten", async () => {
  for (const wrapper of [text=>`<w:hyperlink r:id="rIdCountry">${run(text)}</w:hyperlink>`,text=>`<w:ins w:id="3" w:author="Reviewer">${run(text)}</w:ins>`,text=>`<w:r><w:fldChar w:fldCharType="begin"/><w:t>${text}</w:t></w:r>`]) {
    const input = archive(["立场文件","委员会：联合国大会","议题：合作"].map(line).join("")+`<w:p>${run("国家：")}${wrapper("中国")}</w:p>`+line("代表：甲")+line("中国支持继续合作。"));
    const result = await formatted(input,"position-paper"); assert.ok(result.texts.includes("国家：中国"));
    assert.ok(result.result.validations.some(v=>v.code==="content-protected"));
    assert.equal(result.result.validations.some(v=>v.code==="country_names"),false);
  }
});

test("guard independently rejects guessed or arbitrary country changes, even with matching expected text", () => {
  assert.equal(validCountryFieldChange("国家：中国","国家：中华人民共和国","zh"),true);
  assert.equal(validCountryFieldChange("国家：刚果","国家：刚果共和国","zh"),false);
  assert.equal(validCountryFieldChange("国家：中国","国家：美利坚合众国","zh"),false);
  const document = new DOMParser().parseFromString(xml(line("国家：中国")),"application/xml");
  const p=document.getElementsByTagNameNS(W,"p")[0], before=takeSnapshot(document);
  p.getElementsByTagNameNS(W,"t")[0].textContent="国家：美利坚合众国";
  const log=new Map([[p,{kind:"country-name",key:"country",expected:"国家：美利坚合众国",country:{language:"zh",preserveOrder:false,manual:false}}]]);
  assert.ok(verifyFormat(before,document,log,[],[]).length);
  const list = new DOMParser().parseFromString(xml(line("起草国：中国")),"application/xml");
  const paragraph=list.getElementsByTagNameNS(W,"p")[0], listBefore=takeSnapshot(list);
  paragraph.getElementsByTagNameNS(W,"t")[0].textContent="起草国：中华人民共和国、美国";
  assert.ok(verifyFormat(listBefore,list,new Map([[paragraph,{kind:"countries",key:"sponsors",expected:"起草国：中华人民共和国、美国"}]]),[],[]).length);
});

test("duplicate header fields are retained for manual confirmation, not overwritten with one inferred value",async()=>{
  const input=archive(["立场文件","委员会：联合国大会","议题：合作","国家：中国","国家：日本","代表：甲","正文应保持不变。"].map(line).join(""));
  const result=await formatted(input,"position-paper");
  assert.ok(result.texts.includes("国家：中国") && result.texts.includes("国家：日本"));
  assert.ok(result.result.validations.some(v=>v.code==="content-protected" && v.detail.includes("多个同名")));
});

test("plain field separators expand safely, including manual edits, and repeat unchanged", async () => {
  for (const separator of ["<w:tab/>","<w:br/>","<w:cr/>",'<w:br w:type="textWrapping"/>']) {
    for (const language of ["zh","en"]) {
      const prefix = language === "zh" ? ["工作文件1.1","委员会：联合国大会","议题：合作"] : ["Working Paper 1.1","Committee: General Assembly","Topic: Cooperation"];
      const label = language === "zh" ? "起草国：" : "Sponsors: ";
      const names = language === "zh" ? ["中国","美国"] : ["China","USA"];
      const body = language === "zh" ? "第一条 要求继续合作。" : "1. Calls for continued cooperation;";
      const input = archive(prefix.map(line).join("") + `<w:p>${run(label)}<w:r>${separator}</w:r>${run(names[0])}<w:r>${separator}</w:r>${run(names[1])}</w:p>` + line(body));
      for (const overrides of [{}, {sponsors: language === "zh" ? ["日本","中国"] : ["Japan","China"]}]) {
        const first = await formatted(input,"working-paper",overrides);
        assert.ok(first.texts.join("").includes(language === "zh" ? "中华人民共和国" : "People's Republic of China"));
        assert.equal(first.result.validations.some(v=>v.code==="content-protected"),false);
        assert.deepEqual((await formatted(first.bytes,"working-paper")).texts,first.texts);
      }
    }
  }
});

test("page/column breaks and links are not plain field separators", async () => {
  for (const separator of ['<w:br w:type="page"/>','<w:br w:type="column"/>','<w:br w:clear="all"/>']) {
    const input = archive(["立场文件","委员会：联合国大会","议题：合作"].map(line).join("")+`<w:p>${run("国家：")}<w:r>${separator}</w:r>${run("中国")}</w:p>`+line("代表：甲")+line("正文不变。"));
    const result=await formatted(input,"position-paper");
    assert.ok(result.texts.includes("国家：中国"));
    assert.ok(result.result.validations.some(v=>v.code==="content-protected"));
    assert.throws(()=>formatDocxInBrowser(input,{...parseDocxInBrowser(input,"position-paper"),country:"日本"},options),/不能安全改写/);
  }
});

test("missing manual fields explicitly report that the entered value was not written", async () => {
  const input = archive(["立场文件","委员会：联合国大会","国家：中国","正文：这个内容必须保持不变。"].map(line).join(""));
  const result=await formatted(input,"position-paper",{delegate:"新增代表",topic:"新增议题"});
  const warnings=result.result.validations.filter(v=>v.code==="manual-field-unwritten");
  assert.equal(warnings.length,2);
  assert.ok(warnings.every(v=>v.status==="warning" && v.detail.includes("未写入")));
  assert.equal(result.texts.join("").includes("新增"),false);
  const listInput = archive(["工作文件1.1","委员会：联合国大会","议题：合作","第一条 正文不变。"].map(line).join(""));
  const list = await formatted(listInput,"working-paper",{sponsors:["中国"]});
  assert.ok(list.result.validations.some(v=>v.code==="manual-field-unwritten" && v.detail.includes("起草国")));
  assert.equal(list.texts.join("").includes("中华人民共和国"),false);
});

test("manual list authorization cannot bypass the independent structure guard", () => {
  for (const manual of [true,false]) {
    const document = new DOMParser().parseFromString(xml(`<w:p>${run("起草国：中国")}<w:r><w:br w:type="page"/></w:r></w:p>`),"application/xml");
    const p=document.getElementsByTagNameNS(W,"p")[0], before=takeSnapshot(document);
    while(p.firstChild) p.removeChild(p.firstChild);
    const replacement=new DOMParser().parseFromString(xml(line("起草国：中华人民共和国")),"application/xml").getElementsByTagNameNS(W,"p")[0];
    for(const node of [...replacement.children]) p.appendChild(document.importNode(node,true));
    const edit={kind:"countries",key:"sponsors",expected:"起草国：中华人民共和国",country:{language:"zh",preserveOrder:false,manual}};
    assert.ok(verifyFormat(before,document,new Map([[p,edit]]),[],[]).some(reason=>reason.includes("复杂结构")));
  }
});

test("formal names and aliases use the same country label policy with a trace", async () => {
  for(const name of ["法国","法兰西共和国"]) {
    const input=archive(["立场文件","委员会：联合国大会","议题：合作",`国家/席位：${name}`,"代表：甲","正文不变。"].map(line).join(""));
    const first=await formatted(input,"position-paper");
    assert.ok(first.texts.includes("国家：法兰西共和国"));
    assert.ok(first.result.validations.some(v=>v.code==="country_names" && v.detail.includes("统一国家标签")));
    assert.deepEqual((await formatted(first.bytes,"position-paper")).texts,first.texts);
  }
});
