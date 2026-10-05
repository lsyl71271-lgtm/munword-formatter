// Desktop renders app/page.tsx: exercise its race protection, not a duplicate UI.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { zipSync } from "fflate";

const bundle = await build({entryPoints:["local_web/main.tsx"],bundle:true,write:false,format:"iife",platform:"browser",jsx:"automatic",define:{"process.env.NODE_ENV":'"production"',"process.env.NEXT_PUBLIC_API_URL":'""'}});
const script = bundle.outputFiles[0].text;
const html = await readFile(new URL("../local_web/index.html",import.meta.url),"utf8");
const W="http://schemas.openxmlformats.org/wordprocessingml/2006/main", enc=new TextEncoder();
const source=zipSync({"[Content_Types].xml":enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),"word/document.xml":enc.encode(`<w:document xmlns:w="${W}"><w:body>${["决议草案","委员会：联合国大会","议题：旧议题","起草国：中国","第一条 决定合作。"].map(t=>`<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join("")}<w:sectPr/></w:body></w:document>`) }).buffer;
const settle=()=>new Promise(resolve=>setTimeout(resolve,50));
async function waitFor(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await settle();
  assert.ok(predicate(), message);
}
const button=(window,text)=>text === "生成" ? window.document.querySelector("button.generate") : [...window.document.querySelectorAll("button")].find(el=>el.textContent.includes(text));
function input(window,label) { return [...window.document.querySelectorAll(".reviewSection label")].find(el=>el.textContent.startsWith(label))?.querySelector("input"); }
function change(window,element,value) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set.call(element,value);
  element.dispatchEvent(new window.Event("input",{bubbles:true}));
}
async function page() {
  const dom=new JSDOM(html,{runScripts:"outside-only",url:"http://127.0.0.1:8000/"});
  const {window}=dom, downloads=[], requests=[];
  window.TextEncoder=TextEncoder; window.TextDecoder=TextDecoder;
  window.URL.createObjectURL=()=>{downloads.push(1);return "blob:example";}; window.URL.revokeObjectURL=()=>{};
  window.HTMLElement.prototype.scrollIntoView=()=>{}; window.HTMLAnchorElement.prototype.click=()=>{};
  window.fetch=async (...args)=>{ requests.push(args);throw new Error("No network required by the shared browser engine"); };
  window.File.prototype.arrayBuffer=async()=>source.slice(0);
  window.eval(script); await waitFor(()=>window.document.querySelector('input[type="file"]'),"shared UI mounted");
  const choose=name=>{
    const picker=window.document.querySelector('input[type="file"]');
    Object.defineProperty(picker,"files",{configurable:true,value:[new window.File(["PK"],name)]});
    picker.dispatchEvent(new window.Event("change",{bubbles:true}));
  };
  choose("a.docx"); await waitFor(()=>!button(window,"识别文件结构")?.disabled,"file accepted");
  button(window,"识别文件结构").click(); await waitFor(()=>input(window,"议题"),"recognized fields rendered");
  assert.ok(input(window,"议题"),"step 03 remains editable");
  return {window,downloads,requests,choose};
}

for(const [label,edit] of [
  ["recognized field",window=>change(window,input(window,"议题"),"新议题")],
  ["generation option",window=>window.document.querySelector('input[type="checkbox"]').click()],
]) test(`changing a ${label} during generation discards the stale result`,async()=>{
  const {window,downloads}=await page();let release;
  window.File.prototype.arrayBuffer=()=>new Promise(resolve=>{release=resolve;});
  button(window,"生成").click();await settle();edit(window);await settle();
  release(source.slice(0));await settle();
  assert.equal(downloads.length,0);assert.equal(button(window,"生成").disabled,false);
  window.close();
});

test("choosing another file during generation resets the generate button",async()=>{
  const {window,downloads,choose}=await page();let release;
  window.File.prototype.arrayBuffer=()=>new Promise(resolve=>{release=resolve;});
  button(window,"生成").click();await settle();choose("b.docx");await settle();release(source.slice(0));await settle();
  assert.equal(downloads.length,0);assert.ok(button(window,"识别文件结构"));window.close();
});

test("desktop uses the same browser engine, expands names without requests, and invalidates old results",async()=>{
  const {window,downloads,requests}=await page();
  button(window,"生成").click();
  await waitFor(()=>window.document.body.textContent.includes("UN-M49-156"),"conversion results rendered");
  assert.equal(downloads.length,1);assert.equal(requests.length,0);
  assert.ok(window.document.body.textContent.includes("UN-M49-156"),window.document.querySelector(".validationSection")?.textContent);
  window.document.querySelector('input[type="checkbox"]').click();await settle();
  assert.ok(!window.document.body.textContent.includes("DOCX 包结构"),"old validation results must clear");
  window.close();
});
