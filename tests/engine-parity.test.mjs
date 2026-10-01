import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { parseDocxInBrowser } from "../app/docx-browser.ts";

// The backend writes its recognition of every sample to this fixture
// (scripts/export_engine_parity_fixture.py); both engines must agree on it.
const dom = new JSDOM("");
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;

const fixture = JSON.parse(await readFile(new URL("./fixtures/engine-parity.json", import.meta.url), "utf8"));

for (const [sample, byType] of Object.entries(fixture.cases)) {
  test(`browser and backend recognize the same metadata in ${sample}`, async () => {
    const bytes = await readFile(new URL(`../examples/acceptance-inputs/${sample}`, import.meta.url));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    for (const [documentType, expected] of Object.entries(byType)) {
      const model = parseDocxInBrowser(buffer, documentType);
      const actual = Object.fromEntries(fixture.fields.map((field) => [field, model[field]]));
      assert.deepEqual(actual, expected, `${sample} as ${documentType}`);
    }
  });
}
