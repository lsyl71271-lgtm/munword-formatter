// What the shared formatting engine expects from a browser, for the WeChat mini
// program's JavaScript runtime, which has no DOM, no Blob and (on older base
// libraries) no TextEncoder/TextDecoder. esbuild injects these names into the
// bundle in place of the globals (see build.mjs), so the
// engine source in app/ stays exactly the one the web, desktop and Android
// clients run.
import * as xmldom from "@xmldom/xmldom";

const { Node, NodeList, LiveNodeList, NamedNodeMap } = xmldom;

// --- DOM conveniences the engine uses that xmldom does not implement ---

const iterate = function* () { for (let i = 0; i < this.length; i++) yield this.item(i); };
for (const list of [NodeList, LiveNodeList, NamedNodeMap]) {
  if (list && !list.prototype[Symbol.iterator]) list.prototype[Symbol.iterator] = iterate;
}

const isElement = node => !!node && node.nodeType === 1;
// xmldom 0.9 has parentElement and children itself; the rest are added here.
const getter = (name, get) => { if (!(name in xmldom.Element.prototype)) Object.defineProperty(Node.prototype, name, { get, configurable: true }); };
getter("parentElement", function () { return isElement(this.parentNode) ? this.parentNode : null; });
getter("children", function () {
  const elements = [];
  for (let node = this.firstChild; node; node = node.nextSibling) if (isElement(node)) elements.push(node);
  elements.item = index => elements[index] ?? null;
  return elements;
});
getter("firstElementChild", function () { let node = this.firstChild; while (node && !isElement(node)) node = node.nextSibling; return node || null; });
getter("lastElementChild", function () { let node = this.lastChild; while (node && !isElement(node)) node = node.previousSibling; return node || null; });
getter("nextElementSibling", function () { let node = this.nextSibling; while (node && !isElement(node)) node = node.nextSibling; return node || null; });
getter("previousElementSibling", function () { let node = this.previousSibling; while (node && !isElement(node)) node = node.previousSibling; return node || null; });
getter("childElementCount", function () { return this.children.length; });

const closestNamed = (start, name) => {
  for (let node = start; node; node = node.parentNode) if (isElement(node) && node.localName === name) return node;
  return null;
};
const toNodes = (anchor, items) => items.map(item => typeof item === "string" ? anchor.ownerDocument.createTextNode(item) : item);
Object.assign(Node.prototype, {
  remove() { if (this.parentNode) this.parentNode.removeChild(this); },
  before(...items) { const parent = this.parentNode; if (!parent) return; for (const node of toNodes(this, items)) parent.insertBefore(node, this); },
  after(...items) {
    const parent = this.parentNode; if (!parent) return;
    const next = this.nextSibling;
    for (const node of toNodes(this, items)) parent.insertBefore(node, next);
  },
  replaceWith(...items) {
    const parent = this.parentNode; if (!parent) return;
    const next = this.nextSibling, nodes = toNodes(this, items);
    parent.removeChild(this);
    for (const node of nodes) parent.insertBefore(node, next);
  },
  append(...items) { for (const node of toNodes(this.ownerDocument ? this : this.documentElement, items)) this.appendChild(node); },
  // Only the plain type selectors the engine passes ("p"): in an XML document a
  // CSS type selector with no namespace prefix matches that local name in any namespace.
  closest(selector) {
    if (!/^[A-Za-z][\w-]*$/.test(selector)) throw new Error(`closest() supports a plain element name only, not "${selector}"`);
    return closestNamed(this, selector);
  },
});

// Browsers return a document holding a <parsererror> element when the XML is not
// well formed, and the engine checks for that element; xmldom reports through a
// callback instead. Errors and fatal errors are treated alike, as browsers do.
const PARSER_ERROR_NS = "http://www.mozilla.org/newlayout/xml/parsererror.xml";
export class DOMParser {
  parseFromString(source, mimeType) {
    const failures = [];
    let document;
    try {
      document = new xmldom.DOMParser({ onError: (level, message) => { if (level !== "warning") failures.push(message); } }).parseFromString(String(source), mimeType);
    } catch (error) {
      failures.push(error?.message || String(error));
    }
    if (!failures.length && document?.documentElement) return document;
    const report = new xmldom.DOMImplementation().createDocument(PARSER_ERROR_NS, "parsererror", null);
    report.documentElement.appendChild(report.createTextNode(failures[0] || "XML parsing failed"));
    return report;
  }
}

export class XMLSerializer {
  serializeToString(node) { return new xmldom.XMLSerializer().serializeToString(node); }
}

// --- TextEncoder / TextDecoder (UTF-8 and UTF-16, as the engine needs) ---

export class TextEncoder {
  get encoding() { return "utf-8"; }
  encode(input = "") {
    const text = String(input), bytes = [];
    for (let i = 0; i < text.length; i++) {
      let code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00); i++; }
        else code = 0xfffd;
      } else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | code >> 6, 0x80 | code & 63);
      else if (code < 0x10000) bytes.push(0xe0 | code >> 12, 0x80 | code >> 6 & 63, 0x80 | code & 63);
      else bytes.push(0xf0 | code >> 18, 0x80 | code >> 12 & 63, 0x80 | code >> 6 & 63, 0x80 | code & 63);
    }
    return new Uint8Array(bytes);
  }
}

const LABELS = { "utf-8": "utf-8", utf8: "utf-8", "unicode-1-1-utf-8": "utf-8", "utf-16le": "utf-16le", "utf-16": "utf-16le", "utf-16be": "utf-16be" };
const asBytes = input => input instanceof Uint8Array ? input
  : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  : new Uint8Array(input || new ArrayBuffer(0));

export class TextDecoder {
  constructor(label = "utf-8", options = {}) {
    const encoding = LABELS[String(label).trim().toLowerCase()];
    if (!encoding) throw new RangeError(`The encoding "${label}" is not supported.`);
    this.encoding = encoding;
    this.fatal = !!options.fatal;
    this.ignoreBOM = !!options.ignoreBOM;
  }
  decode(input) {
    const bytes = asBytes(input);
    const out = this.encoding === "utf-8" ? this.#utf8(bytes) : this.#utf16(bytes, this.encoding === "utf-16be");
    return !this.ignoreBOM && out.charCodeAt(0) === 0xfeff ? out.slice(1) : out;
  }
  #bad() { if (this.fatal) throw new TypeError("The encoded data was not valid."); return 0xfffd; }
  #utf8(bytes) {
    const codes = [];
    let text = "";
    for (let i = 0; i < bytes.length;) {
      const first = bytes[i];
      let need = 0, code = 0, lower = 0x80, upper = 0xbf;
      if (first < 0x80) { codes.push(first); i++; }
      else {
        if (first >= 0xc2 && first <= 0xdf) { need = 1; code = first & 0x1f; }
        else if (first >= 0xe0 && first <= 0xef) { need = 2; code = first & 0xf; if (first === 0xe0) lower = 0xa0; if (first === 0xed) upper = 0x9f; }
        else if (first >= 0xf0 && first <= 0xf4) { need = 3; code = first & 0x7; if (first === 0xf0) lower = 0x90; if (first === 0xf4) upper = 0x8f; }
        else { codes.push(this.#bad()); i++; continue; }
        let j = 1;
        for (; j <= need; j++) {
          const next = bytes[i + j];
          if (next === undefined || next < lower || next > upper) break;
          code = code << 6 | next & 0x3f;
          lower = 0x80; upper = 0xbf;
        }
        if (j <= need) { codes.push(this.#bad()); i += j; continue; }
        codes.push(code);
        i += need + 1;
      }
      if (codes.length > 8192) { text += String.fromCodePoint(...codes); codes.length = 0; }
    }
    return text + String.fromCodePoint(...codes);
  }
  #utf16(bytes, bigEndian) {
    const units = [];
    let text = "";
    const end = bytes.length - (bytes.length % 2);
    for (let i = 0; i < end; i += 2) {
      const unit = bigEndian ? bytes[i] << 8 | bytes[i + 1] : bytes[i + 1] << 8 | bytes[i];
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const low = i + 3 < end ? (bigEndian ? bytes[i + 2] << 8 | bytes[i + 3] : bytes[i + 3] << 8 | bytes[i + 2]) : -1;
        if (low >= 0xdc00 && low <= 0xdfff) { units.push(unit, low); i += 2; }
        else units.push(this.#bad());
      } else if (unit >= 0xdc00 && unit <= 0xdfff) units.push(this.#bad());
      else units.push(unit);
      if (units.length > 8192) { text += String.fromCharCode(...units); units.length = 0; }
    }
    if (end !== bytes.length) units.push(this.#bad());
    return text + String.fromCharCode(...units);
  }
}

// --- Blob: the engine returns its output as a Blob; the pages read it back with arrayBuffer() ---

export class Blob {
  #bytes;
  constructor(parts = [], options = {}) {
    const chunks = parts.map(part => part instanceof Blob ? part.#bytes
      : typeof part === "string" ? new TextEncoder().encode(part)
      : asBytes(part));
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    this.#bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { this.#bytes.set(chunk, offset); offset += chunk.byteLength; }
    this.type = String(options.type || "").toLowerCase();
  }
  get size() { return this.#bytes.byteLength; }
  arrayBuffer() { return Promise.resolve(this.#bytes.slice().buffer); }
  text() { return Promise.resolve(new TextDecoder().decode(this.#bytes)); }
  slice(start = 0, end = this.size, type = "") { return new Blob([this.#bytes.slice(start, end)], { type }); }
}

// --- Regular expressions with lookbehind ---
// The treaty party separators in shared/document-policy.json split on 和 but not
// in 共和国: "(?<!共)和(?!平)". iOS before 16.4 cannot compile lookbehind, and
// WeChat's logic layer on iOS is the system JavaScriptCore. The bundle routes the
// engine's new RegExp() calls here (build.mjs): where
// lookbehind works this is plain new RegExp(); where it does not, a negative
// lookbehind of one literal character before one literal character is emulated
// for split() and test() by hiding that character pair behind a placeholder.
const LOOKBEHIND = (() => { try { return new RegExp("(?<!a)b").test("cb"); } catch { return false; } })();
const PAIR = /\(\?<!([^\\^$.|?*+()[\]{}])\)([^\\^$.|?*+()[\]{}])/g;
const PLACEHOLDER = 0xe000;

export function lookbehindFallback(pattern, flags = "") {
  const pairs = [];
  for (let found; (found = PAIR.exec(pattern));) pairs.push({ before: found[1], char: found[2], mark: String.fromCharCode(PLACEHOLDER + pairs.length) });
  const native = new RegExp(pattern.replace(PAIR, "$2"), flags);
  if (/\(\?<[=!]/.test(native.source)) throw new SyntaxError(`Invalid regular expression: /${pattern}/: lookbehind is not supported here`);
  const hide = text => pairs.reduce((value, { before, char, mark }) => value.split(before + char).join(before + mark), String(text));
  const show = text => text === undefined ? text : pairs.reduce((value, { char, mark }) => value.split(mark).join(char), text);
  const usable = text => !pairs.some(({ mark }) => String(text).includes(mark));
  return {
    source: pattern, flags,
    [Symbol.split](text, limit) {
      if (!usable(text)) throw new SyntaxError("lookbehind emulation: placeholder character in input");
      return hide(text).split(native, limit).map(show);
    },
    test(text) { if (!usable(text)) throw new SyntaxError("lookbehind emulation: placeholder character in input"); native.lastIndex = 0; return native.test(hide(text)); },
  };
}

export function __miniRegExp(pattern, flags) {
  if (LOOKBEHIND || typeof pattern !== "string" || !/\(\?<!/.test(pattern)) return flags === undefined ? new RegExp(pattern) : new RegExp(pattern, flags);
  return lookbehindFallback(pattern, flags);
}

// --- Language features newer than the oldest WeChat runtimes ---

if (!Array.prototype.findLast) {
  Object.defineProperty(Array.prototype, "findLast", {
    configurable: true, writable: true,
    value(predicate, thisArg) { for (let i = this.length - 1; i >= 0; i--) if (predicate.call(thisArg, this[i], i, this)) return this[i]; return undefined; },
  });
}
