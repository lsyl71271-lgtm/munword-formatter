// Independent batch readback: defaults only, no step-03 metadata overrides.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { parseDocxInBrowser, formatDocxInBrowser } from "../app/docx-browser.ts";
const dom = new JSDOM("");
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;
const [manifest, directory] = process.argv.slice(2);
if (!manifest || !directory) throw new Error("Usage: node scripts/run-browser-cases.mjs cases.json OUTPUT");
await mkdir(directory, { recursive: true });
const results = {};
for (const item of JSON.parse(await readFile(manifest, "utf8"))) {
  if (typeof item.id !== "string" || !item.id || /[/\\\u0000-\u001f]/.test(item.id) || [".", ".."].includes(item.id)) throw new Error("Invalid case id");
  try {
    const bytes = await readFile(item.path);
    const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const result = formatDocxInBrowser(input, parseDocxInBrowser(input, item.kind), { sessionLabel: "", submittingCountry: "", version: "v1" });
    await writeFile(join(directory, `${item.id}.docx`), new Uint8Array(await result.blob.arrayBuffer()));
    results[item.id] = { errors: result.validations.filter(v => v.status === "error").map(v => v.code), warnings: result.validations.filter(v => v.status === "warning").map(v => v.code) };
  } catch (error) { results[item.id] = { exception: `${error.name}: ${error.message}` }; }
}
await writeFile(join(directory, "results.json"), JSON.stringify(results, null, 2));
const failures = Object.values(results).filter(r => r.exception || r.errors.length).length;
console.log(`${Object.keys(results).length} cases; ${failures} failed`);
if (failures) process.exitCode = 1;
