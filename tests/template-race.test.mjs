// Exercise the real component; delay only its lazy-module loader.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const compiled = await build({
  stdin: { contents: `import React from "react"; import {createRoot} from "react-dom/client"; import Panel from "./app/template-panel.tsx";
    function App(){const [type,setType]=React.useState("working-paper");window.changeType=setType;return <Panel type={type} onGenerated={()=>window.downloads.push(1)}/>;}
    createRoot(document.getElementById("root")).render(<App/>);`, resolveDir: process.cwd(), loader: "tsx" },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: {"process.env.NODE_ENV": '"production"'},
  plugins: [{ name: "delay-module", setup(builder) {
    builder.onLoad({filter: /template-panel\.tsx$/}, async ({path}) => ({contents: (await readFile(path,"utf8")).replace('await import("./template-generator")','await window.__loadTemplateForTest()'), loader:"tsx"}));
  }}],
});
const settle = () => new Promise(resolve => setTimeout(resolve, 40));
for (const kind of ["field", "type", "type roundtrip"]) test(`template ${kind} edits discard an obsolete lazy-loaded result`, async () => {
  const dom = new JSDOM('<div id="root"></div>', {runScripts:"outside-only"});
  const {window} = dom; window.downloads = []; let release;
  window.__loadTemplateForTest = () => new Promise(resolve => {release = resolve;});
  window.eval(compiled.outputFiles[0].text); await settle();
  window.document.querySelector("button").click(); await settle();
  if (kind.startsWith("type")) window.changeType("position-paper");
  else {
    const element = window.document.querySelector("input");
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set.call(element,"changed");
    element.dispatchEvent(new window.Event("input",{bubbles:true}));
  }
  await settle();
  if (kind === "type roundtrip") { window.changeType("working-paper"); await settle(); }
  release({generateFromTemplate: () => ({blob: {}, filename: "stale.docx"})}); await settle();
  assert.equal(window.downloads.length,0);
  assert.equal(window.document.querySelector("button").disabled,false);
  window.close();
});
