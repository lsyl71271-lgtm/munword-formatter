// Compares two .docx packages part by part. XML parts are compared as trees, not
// text: the mini program serializes with xmldom, the web engine with the browser's
// serializer, and the two may write the same document with different attribute order.
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { unzipSync } from "fflate";

const window = new JSDOM("").window;
const decoder = new TextDecoder();

export function xmlTree(text) {
  const document = new window.DOMParser().parseFromString(text, "application/xml");
  assert.equal(document.getElementsByTagName("parsererror").length, 0, "output must be well-formed XML");
  const walk = node => node.nodeType === 3 || node.nodeType === 4 ? { text: node.data }
    : node.nodeType !== 1 ? null
    : { ns: node.namespaceURI, name: node.localName,
      attrs: [...node.attributes].filter(a => a.namespaceURI !== "http://www.w3.org/2000/xmlns/").map(a => `${a.namespaceURI}|${a.localName}=${a.value}`).sort(),
      children: [...node.childNodes].map(walk).filter(Boolean) };
  return walk(document.documentElement);
}

const bytesOf = async value => new Uint8Array(value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? value : await value.arrayBuffer());

/** `expected` and `actual` are Blobs, ArrayBuffers or byte arrays. */
export async function samePackage(expected, actual, label) {
  const a = unzipSync(await bytesOf(expected));
  const b = unzipSync(await bytesOf(actual));
  assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort(), `${label}: same parts`);
  for (const name of Object.keys(a)) {
    if (/\.(xml|rels)$/.test(name)) assert.deepEqual(xmlTree(decoder.decode(b[name])), xmlTree(decoder.decode(a[name])), `${label}: ${name}`);
    else assert.deepEqual(Buffer.from(b[name]), Buffer.from(a[name]), `${label}: ${name} bytes`);
  }
}
