import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { zipSync, unzipSync } from "fflate";
import { parseDocxInBrowser, formatDocxInBrowser } from "../app/docx-browser.ts";
import { visibleText, contentSignature } from "../app/docx-safety.ts";
const dom = new JSDOM(""); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer;
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const enc = new TextEncoder(), dec = new TextDecoder();
const nodes = (p, tag) => [...p.getElementsByTagNameNS(W, tag)];
const val = (p, tag) => nodes(p, tag)[0]?.getAttributeNS(W, "val");
const p = text => `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:ind w:left="8000"/><w:spacing w:line="1000"/></w:pPr>${[...text].map(c => `<w:r><w:rPr><w:rFonts w:ascii="Comic Sans MS"/><w:sz w:val="90"/><w:i/><w:b/><w:u w:val="single"/><w:vanish/></w:rPr><w:t xml:space="preserve">${c}</w:t></w:r>`).join("")}</w:p>`;
const input = lines => zipSync({"[Content_Types].xml": enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'), "word/document.xml": enc.encode(`<w:document xmlns:w="${W}"><w:body>${lines.map(p).join("")}<w:sectPr><w:pgSz w:w="17000" w:h="12000" w:orient="landscape"/></w:sectPr></w:body></w:document>`)}).buffer;
async function format(lines, type) {
  const source = input(lines), model = parseDocxInBrowser(source, type);
  const result = formatDocxInBrowser(source, model, {sessionLabel:"",submittingCountry:"",version:"v1"});
  const buffer = await result.blob.arrayBuffer(), parts = unzipSync(new Uint8Array(buffer));
  const xml = new DOMParser().parseFromString(dec.decode(parts["word/document.xml"]), "application/xml");
  const numbering = parts["word/numbering.xml"] && new DOMParser().parseFromString(dec.decode(parts["word/numbering.xml"]), "application/xml");
  return {buffer,xml,numbering,paragraphs:nodes(xml,"p"),result};
}
const find = (paragraphs, prefix) => paragraphs.find(p => visibleText(p).startsWith(prefix));
const ind = (p, name) => nodes(p, "ind")[0]?.getAttributeNS(W, name);
function assertPrefix(paragraph, word, style) {
  const chars = nodes(paragraph,"r").flatMap(r => [...visibleText(r)].map(c=>({c,r})));
  const start = chars.map(c=>c.c).join("").indexOf(word); assert.ok(start >= 0);
  for (const {r} of chars.slice(start,start+word.length)) assert.equal(val(r,style), style === "u" ? "single" : "1");
  for (const {r} of chars.slice(start+word.length)) assert.equal(val(r,style), style === "u" ? "none" : "0");
}
test("handbook: Chinese resolution hierarchy, signatures, prefixes and typography", async()=>{
  const {xml,paragraphs,result} = await format(["决议草案3.2","委员会：联合国大会","议题：测试议题","起草国：日本国、巴西联邦共和国","附议国：中国","联合国大会，","完全相信共同原则，","第一条 进一步决定建立机制：","（一）提交报告：","（子）保留记录：","（甲）执行检查。"],"draft-resolution");
  // Title keeps its own number; committee / topic lose their labels (页41).
  assert.equal(visibleText(paragraphs[0]),"决议草案3.2"); assert.equal(visibleText(paragraphs[1]),"联合国大会");
  const sponsors = find(paragraphs,"起草国");
  assert.equal(visibleText(sponsors),"起草国：巴西联邦共和国、日本国");
  assert.equal(nodes(sponsors,"spacing")[0].getAttributeNS(W,"line"),"310");
  assert.equal(visibleText(sponsors.nextElementSibling),"", "a signing line follows each country line");
  assert.equal(val(nodes(paragraphs[0],"r")[0],"i"),"0");
  assertPrefix(find(paragraphs,"完全相信"),"完全相信","u"); assertPrefix(find(paragraphs,"第一条"),"进一步决定","i");
  assert.equal(nodes(find(paragraphs,"完全相信"),"spacing")[0].getAttributeNS(W,"line"),"360");
  // Typed markers stay; geometry per level (页42): 0/0, 48/36, 67.5/36, 87/36 pt.
  assert.deepEqual(["第一条","（一）","（子）","（甲）"].map(m=>[ind(find(paragraphs,m),"left"),ind(find(paragraphs,m),"hanging")||"0"]),[["0","0"],["960","720"],["1350","720"],["1740","720"]]);
  assert.equal(nodes(xml,"numPr").length,0);
  assert.ok(nodes(xml,"sz").every(n=>n.getAttributeNS(W,"val")==="24")); assert.equal(nodes(xml,"vanish").length,0);
  assert.equal(nodes(xml,"pgSz")[0].getAttributeNS(W,"w"),"11906");
  assert.equal(result.validations.some(v=>v.status==="error"),false);
});
test("handbook: English longest-prefix and word boundary", async()=>{
  const {paragraphs} = await format(["Draft Resolution 2.1","The European Commission","Energy Security","Sponsors: Spain, France","Signatories: Italy","The European Commission,","Having devoted attention to this issue,","1. Calls upon member states to cooperate;","2. Notes current progress."],"draft-resolution");
  assert.equal(visibleText(paragraphs[0]),"DRAFT RESOLUTION 2.1");
  assertPrefix(find(paragraphs,"Having"),"Having devoted attention","u"); assertPrefix(find(paragraphs,"1. Calls"),"Calls upon","i");
  const {paragraphs: other} = await format(["Draft Resolution","1. Callsign is a noun."],"draft-resolution");
  assert.ok(nodes(other.at(-1),"i").every(n=>n.getAttributeNS(W,"val")==="0"));
});
test("handbook: working paper body is not forcibly italicized; typed numbers kept", async()=>{
  const {paragraphs} = await format(["Working Paper 4.1","Committee: World Health Assembly","Topic: Genetic Engineering","Sponsors: Italy, France","Part I: Cooperation","1. Encourages cooperation;","(a) Provide resources;","Part II: Ethics","1. Supports safe research."],"working-paper");
  assert.equal(visibleText(paragraphs[0]),"WORKING PAPER 4.1");
  const first = find(paragraphs,"1. Encourages");
  assert.ok(nodes(first,"i").every(n=>n.getAttributeNS(W,"val")==="0"));
  assert.equal(val(nodes(find(paragraphs,"Part I"),"r")[0],"b"),"1");
  assert.ok(find(paragraphs,"1. Supports"), "a restarted typed series is kept as written");
  assert.deepEqual([ind(first,"left"),ind(first,"hanging")],["420","420"]);
});
for (const type of ["friendly-amendment","unfriendly-amendment"]) test(`handbook: ${type} uses Amendment header and italic operation only`,async()=>{
  const {paragraphs} = await format([`${type==="friendly-amendment" ? "友好" : "非友好"}修正案1.2.1`,"委员会：联合国大会","议题：测试议题","起草国：日本国","附议国：加拿大","1. 修改第五条第（一）款（子）：保留原有正文。"],type);
  assert.equal(visibleText(paragraphs[0]),"修正案1.2.1");
  assertPrefix(paragraphs.at(-1),"修改","i");
  assert.ok(visibleText(paragraphs.at(-1)).startsWith("1. 修改第五条第（一）款（子）"));
  assert.equal(nodes(paragraphs.at(-1),"rFonts")[0].getAttributeNS(W,"eastAsia"),"Arial Unicode MS");
});
test("handbook: directive subject is italic; English sublist uses a.",async()=>{
  const {paragraphs} = await format(["Draft Directive 4.1","Executive Council of OPCW","Sponsors: United Kingdom","Signatories: Italy","The OPCW,","1. Requests cooperation:","a. Finding out the causes;","2. Urges further cooperation."],"draft-directive");
  assert.equal(val(nodes(find(paragraphs,"The OPCW"),"r")[0],"i"),"1");
  const sub = find(paragraphs,"a. Finding");
  assert.deepEqual([ind(sub,"left"),ind(sub,"hanging")],["990","570"]);
});
test("handbook: normalized package and XML are stable on second pass",async()=>{
  const first=await format(["决议草案1.1","联合国大会","测试议题","起草国：日本国","附议国：加拿大","联合国大会，","回顾原则，","第一条 要求合作。"],"draft-resolution");
  const result=formatDocxInBrowser(first.buffer,parseDocxInBrowser(first.buffer,"draft-resolution"),{sessionLabel:"",submittingCountry:"",version:"v1"});
  const second=unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  assert.equal(contentSignature(first.xml),contentSignature(new DOMParser().parseFromString(dec.decode(second["word/document.xml"]),"application/xml")));
  assert.deepEqual(second["word/document.xml"],unzipSync(new Uint8Array(first.buffer))["word/document.xml"]);
  assert.deepEqual(second["word/numbering.xml"],unzipSync(new Uint8Array(first.buffer))["word/numbering.xml"]);
});

test("handbook: resolution typed numbers and levels across PART; fourth-level i. stays roman",async()=>{
  const {paragraphs}=await format(["Draft Resolution","The European Commission","Energy Security","Sponsors: France","The European Commission,","Recalling cooperation,","PART I Definitions","1. Decides on definitions;","PART II Implementation","2. Calls upon members to cooperate:","(a) Work together:","(i) Keep records:","i. Review records;","3. Urges cooperation."],"draft-resolution");
  assert.deepEqual(["2. Calls","(a) Work","(i) Keep","i. Review"].map(m=>ind(find(paragraphs,m),"left")),["360","720","1080","1440"]);
  assert.ok(find(paragraphs,"3. Urges cooperation."));
});
test("handbook: punctuation affects only formal clause endings",async()=>{
  const {paragraphs,result}=await format(["决议草案","联合国大会","测试议题","起草国：日本国","联合国大会，","回顾原则。","第一条 要求合作。","（一）保留正文内的逗号，不能删除。","第二条 鼓励合作；"],"draft-resolution");
  assert.equal(visibleText(find(paragraphs,"回顾")),"回顾原则，");
  assert.equal(visibleText(find(paragraphs,"第一条")),"第一条 要求合作：");
  assert.equal(visibleText(find(paragraphs,"（一）")),"（一）保留正文内的逗号，不能删除；");
  assert.equal(visibleText(find(paragraphs,"第二条")),"第二条 鼓励合作。");
  assert.match(result.validations.find(v=>v.code==="structural_edits").detail,/标点/);
});
test("handbook: unnumbered amendment operations still receive selective italics",async()=>{
  const {paragraphs}=await format(["Amendment","Sponsors: France","Add a new provision to article 3."],"friendly-amendment");
  assertPrefix(paragraphs.at(-1),"Add","i");
});
test("handbook: human step 03 can edit unlabeled metadata without touching body",async()=>{
  const source=input(["决议草案","联合国大会","测试议题","起草国：日本国","联合国大会，","回顾原则，","第一条 要求合作。"]);
  const model=parseDocxInBrowser(source,"draft-resolution");
  const result=formatDocxInBrowser(source,{...model,topic:"新议题"},{sessionLabel:"",submittingCountry:"",version:"v1"});
  const parts=unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  const xml=new DOMParser().parseFromString(dec.decode(parts["word/document.xml"]),"application/xml");
  assert.equal(visibleText(nodes(xml,"p")[2]),"新议题");
  assert.equal(visibleText(nodes(xml,"p").at(-1)),"第一条 要求合作。");
});
test("handbook: English multiline countries stop before committee subject and prose",async()=>{
  const {paragraphs}=await format(["Draft Directive","Executive Council of OPCW","Sponsors: United Kingdom,","France, Germany","Signatories: Italy,","Canada, Croatia","The OPCW,","1. Requests cooperation."],"draft-directive");
  assert.equal(visibleText(find(paragraphs,"Sponsors")),"Sponsors: Federal Republic of Germany, French Republic,");
  assert.ok(paragraphs.some(p => visibleText(p) === "United Kingdom of Great Britain and Northern Ireland"));
  assert.equal(visibleText(find(paragraphs,"Signatories")),"Signatories: Canada, Republic of Croatia, Republic of Italy");
  assert.equal(val(nodes(find(paragraphs,"The OPCW"),"r")[0],"i"),"1");
});
test("handbook: footnote fonts normalize to nine points without losing citation fields",async()=>{
  const parts=unzipSync(new Uint8Array(input(["立场文件","委员会：联合国大会","议题：测试","国家：中国","代表：甲","正文有引用。"])));
  parts["word/footnotes.xml"]=enc.encode(`<w:footnotes xmlns:w="${W}"><w:footnote w:id="7"><w:p><w:r><w:rPr><w:sz w:val="70"/></w:rPr><w:t>参考来源</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/><w:instrText> HYPERLINK https://example.org </w:instrText><w:fldChar w:fldCharType="end"/></w:r></w:p></w:footnote></w:footnotes>`);
  const source=zipSync(parts).buffer;
  const result=formatDocxInBrowser(source,parseDocxInBrowser(source,"position-paper"),{sessionLabel:"",submittingCountry:"",version:"v1"});
  const updated=unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  const notes=new DOMParser().parseFromString(dec.decode(updated["word/footnotes.xml"]),"application/xml");
  assert.ok(nodes(notes,"sz").every(n=>n.getAttributeNS(W,"val")==="18"));
  assert.equal(nodes(notes,"instrText")[0].textContent," HYPERLINK https://example.org ");
  assert.equal(nodes(notes,"footnote")[0].getAttributeNS(W,"id"),"7");
});
test("handbook: selective character-style emphasis survives cleaning inherited defaults",async()=>{
  const parts=unzipSync(new Uint8Array(input(["Position Paper"])));
  let main=dec.decode(parts["word/document.xml"]);
  main=main.replace("<w:sectPr>",'<w:p><w:r><w:t xml:space="preserve">Keep this </w:t></w:r><w:r><w:rPr><w:rStyle w:val="Strong"/></w:rPr><w:t>important</w:t></w:r><w:r><w:t xml:space="preserve"> policy.</w:t></w:r></w:p><w:sectPr>');
  parts["word/document.xml"]=enc.encode(main);
  parts["word/styles.xml"]=enc.encode(`<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/><w:rPr><w:sz w:val="76"/></w:rPr></w:style><w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style></w:styles>`);
  const source=zipSync(parts).buffer, model=parseDocxInBrowser(source,"position-paper");
  const result=formatDocxInBrowser(source,model,{sessionLabel:"",submittingCountry:"",version:"v1"});
  const output=unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  const xml=new DOMParser().parseFromString(dec.decode(output["word/document.xml"]),"application/xml");
  const runs=nodes(nodes(xml,"p").at(-1),"r");
  assert.deepEqual(runs.map(r=>nodes(r,"b").length>0 && val(r,"b")!=="0"),[false,true,false]);
  assert.ok(runs.every(r=>val(r,"sz")==="24"));
});
