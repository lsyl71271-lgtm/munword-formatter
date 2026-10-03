import { unzipSync } from "fflate";

const MAX_UPLOAD = 20 * 1024 * 1024;
const MAX_EXPANDED = 100 * 1024 * 1024;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function entryChecksums(data: Uint8Array): number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || view.getUint32(end, true) !== 0x06054b50 || end + 22 + view.getUint16(end + 20, true) !== data.length) throw new Error("ZIP 目录损坏");
  const count = view.getUint16(end + 10, true);
  if (view.getUint32(end + 4, true) !== 0 || count !== view.getUint16(end + 8, true) || count > 5000) throw new Error("不支持分卷或 ZIP64 文件");
  let offset = view.getUint32(end + 16, true);
  const directoryEnd = offset + view.getUint32(end + 12, true);
  if (directoryEnd !== end) throw new Error("ZIP 目录边界异常");
  const checksums: number[] = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) throw new Error("ZIP 部件目录损坏");
    if (view.getUint16(offset + 8, true) & 1) throw new Error("不支持加密的 DOCX 部件");
    checksums.push(view.getUint32(offset + 16, true));
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  if (offset !== directoryEnd) throw new Error("ZIP 部件数量异常");
  return checksums;
}

/** A DTD or entity declaration in either encoding OPC allows (docx_package.declares_dtd).
 * Decoding UTF-16 as UTF-8 hid "<\0!\0D\0..." from the search. */
/** Text of an XML part in either encoding OPC allows (UTF-8 or UTF-16, with or without a BOM). */
export function decodeXml(bytes: Uint8Array): string {
  const [a, b, c, d] = bytes;
  if ((a === 0 && b === 0 && c === 0xfe && d === 0xff) || (a === 0xff && b === 0xfe && c === 0 && d === 0)) throw new Error("XML 部件使用了不支持的编码");
  const big = (a === 0xfe && b === 0xff) || (a === 0 && b === 0x3c);
  const little = (a === 0xff && b === 0xfe) || (a === 0x3c && b === 0);
  return new TextDecoder(big ? "utf-16be" : little ? "utf-16le" : "utf-8").decode(bytes);
}

export function declaresDtd(bytes: Uint8Array): boolean {
  const text = decodeXml(bytes);
  // Leading whitespace may hide BOM-less UTF-16 from the encoding sniff.
  // Declaration syntax is ASCII; removing NUL separators covers both orders.
  return /<!\s*(?:DOCTYPE|ENTITY)/i.test(text.replace(/\0/g, ""));
}

/** True when elements nest deeper than libxml2 accepts (256 levels), found without building a tree.
 * The Python engine refuses such parts while parsing; here deep recursion
 * overflowed the stack and was reported as an internal error. */
export function nestsTooDeep(text: string, limit = 256): boolean {
  let depth = 0;
  for (let at = text.indexOf("<"); at !== -1; at = text.indexOf("<", at + 1)) {
    const next = text[at + 1];
    if (next === "?" || next === "!") {
      const close = next === "?" ? "?>" : text.startsWith("<!--", at) ? "-->" : text.startsWith("<![CDATA[", at) ? "]]>" : ">";
      at = text.indexOf(close, at + 2);
      if (at === -1) return false;
      continue;
    }
    if (next === "/") { depth--; continue; }
    // A start tag ends at the first ">" outside quotes; attribute values may contain ">".
    let end = at + 1, quote = "";
    for (; end < text.length; end++) {
      const ch = text[end];
      if (quote) { if (ch === quote) quote = ""; } else if (ch === '"' || ch === "'") quote = ch; else if (ch === ">") break;
    }
    if (text[end - 1] !== "/" && ++depth > limit) return true;
    at = end;
  }
  return false;
}

/** Inspect every entry before allowing fflate to allocate any expanded buffers. */
export function readPackage(content: ArrayBuffer): Record<string, Uint8Array> {
  const data = new Uint8Array(content);
  if (data.length < 22 || data.length > MAX_UPLOAD) throw new Error("DOCX 文件为空、损坏或超过 20 MB。");
  let total = 0;
  const names = new Set<string>();
  try {
    const checksums = entryChecksums(data);
    const sizes = new Map<string, number>();
    const expectedCrc = new Map<string, number>();
    unzipSync(data, { filter(entry) {
      const { name, size, originalSize, compression } = entry;
      total += originalSize;
      if (names.has(name) || name === "__proto__" || name.includes("\\") || name.startsWith("/") || name.split("/").includes("..")) {
        throw new Error("内部路径重复或不安全");
      }
      names.add(name);
      sizes.set(name, originalSize);
      expectedCrc.set(name, checksums[names.size - 1]);
      if (names.size > 5000 || total > MAX_EXPANDED || originalSize > Math.max(size, 1) * 250 || ![0, 8].includes(compression)) {
        throw new Error("解压体积、压缩比例或压缩方法异常");
      }
      return false;
    } });
    if (!names.has("[Content_Types].xml") || !names.has("word/document.xml")) throw new Error("缺少必要的 Word 部件");
    const parts = unzipSync(data);
    for (const [name, bytes] of Object.entries(parts)) {
      if (bytes.length !== sizes.get(name) || crc32(bytes) !== expectedCrc.get(name)) throw new Error("部件长度或 CRC 校验失败");
      // Any case: Word reads "header1.XML" as XML too.
      if (/\.(?:xml|rels)$/i.test(name)) {
        // DOCX parts do not need DTDs. Disallow entity declarations in both engines.
        if (bytes.length > 16 * 1024 * 1024) throw new Error("XML 部件过大，请拆分文档");
        if (declaresDtd(bytes)) throw new Error("不支持 XML 实体或 DTD");
        if (nestsTooDeep(decodeXml(bytes).replace(/\0/g, ""))) throw new Error("XML 嵌套层级过深（超过 256 层）");
      }
    }
    return parts;
  } catch (reason) {
    throw new Error(`DOCX 压缩包校验失败：${reason instanceof Error ? reason.message : "文件损坏"}`);
  }
}

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** Include controls in text offsets, but never count text-box paragraphs twice.
 *
 * Property elements are skipped: a paragraph's tab-stop definitions
 * (w:pPr/w:tabs/w:tab) are not text, and counting them shifted every offset
 * in the paragraph by one.
 */
const PROPERTIES = new Set(["pPr", "rPr", "tblPr", "trPr", "tcPr", "sectPr"]);
export function visibleText(element: Element): string {
  if (element.namespaceURI === W) {
    if (PROPERTIES.has(element.localName)) return "";
    if (element.localName === "t") return element.textContent || "";
    if (element.localName === "tab") return "\t";
    if (["br", "cr"].includes(element.localName)) return "\n";
    if (element.localName === "p" && element.parentElement?.closest("p")) return "";
  }
  return Array.from(element.children).filter(child => !(child.namespaceURI === W && child.localName === "p"))
    .map(visibleText).join("");
}

/** True when the paragraph holds only runs whose children are all in ``runContent``. */
function onlyRunsOf(paragraph: Element, runContent: string[]): boolean {
  return Array.from(paragraph.children).every(child => child.namespaceURI === W && (
    child.localName === "pPr" || (child.localName === "r" && Array.from(child.children).every(
      node => node.namespaceURI === W && runContent.includes(node.localName)
    ))
  ));
}

/** Structural rewrites are only safe for plain paragraphs. Complex content stays intact. */
export function isPlainParagraph(paragraph: Element): boolean {
  return onlyRunsOf(paragraph, ["rPr", "t"]);
}

/** The split point falls inside a link, a tracked change or another wrapper that is not copied. */
export class Unsplittable extends Error {}

const isWord = (node: Element, name: string) => node.namespaceURI === W && node.localName === name;
// Inline wrappers a split may cut through; the cut copies the wrapper.  A link
// or a tracked change is not cut: a copied hyperlink or revision is new
// structure the repair check refuses (structure_repair._SPLITTABLE).
const SPLITTABLE = new Set(["smartTag", "customXml"]);
const UNCUTTABLE = ["fldChar", "instrText", "fldSimple", "sdt"];

/** Fields and content controls span runs in ways a text cut would break. */
export function canCut(paragraph: Element): boolean {
  return UNCUTTABLE.every(name => !paragraph.getElementsByTagNameNS(W, name).length);
}

/** Cut a run at ``offset``; the second half becomes a new run right after it. */
function splitRun(run: Element, offset: number): Element {
  const tail = run.ownerDocument.createElementNS(W, "w:r");
  const properties = Array.from(run.children).find(child => isWord(child, "rPr"));
  if (properties) tail.appendChild(properties.cloneNode(true));
  let position = 0, moving = false;
  for (const child of Array.from(run.children)) {
    if (isWord(child, "rPr")) continue;
    if (moving) { tail.appendChild(child); continue; }
    const length = visibleText(child).length;
    if (position + length <= offset) {
      position += length;
      if (position === offset) moving = true;
      continue;
    }
    // The cut falls inside this text node.
    const text = child.textContent || "", cut = offset - position;
    const rest = child.cloneNode(false) as Element;
    rest.textContent = text.slice(cut);
    rest.setAttribute("xml:space", "preserve");
    child.textContent = text.slice(0, cut);
    child.setAttribute("xml:space", "preserve");
    tail.appendChild(rest);
    moving = true;
  }
  run.parentNode!.insertBefore(tail, run.nextSibling);
  return tail;
}

/** Make a child boundary at visible ``offset``; return the first child after it (null at the end). */
function splitAt(parent: Element, offset: number): Element | null {
  let position = 0;
  for (const child of Array.from(parent.children)) {
    if (isWord(child, "pPr") || isWord(child, "rPr")) continue;
    if (position === offset) return child;
    const length = visibleText(child).length;
    if (position < offset && offset < position + length) {
      let tail: Element;
      if (isWord(child, "r")) tail = splitRun(child, offset - position);
      else if (child.namespaceURI === W && SPLITTABLE.has(child.localName)) {
        tail = child.ownerDocument.createElementNS(W, child.tagName);
        for (const attribute of Array.from(child.attributes)) tail.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
        for (let moving = splitAt(child, offset - position); moving;) {
          const next = moving.nextElementSibling;
          tail.appendChild(moving);
          moving = next;
        }
        parent.insertBefore(tail, child.nextSibling);
      } else throw new Unsplittable(child.localName);
      return tail;
    }
    position += length;
  }
  return null;
}

/** Cut at ``keep`` and at ``resumeAt``, dropping plain whitespace runs between; return where ``resumeAt`` starts. */
function cutAtResume(paragraph: Element, keep: number, resumeAt: number): Element | null {
  splitAt(paragraph, resumeAt);
  let middle = splitAt(paragraph, keep);
  const resumed = splitAt(paragraph, resumeAt);
  while (middle && middle !== resumed) {
    const next = middle.nextElementSibling;
    const plain = isWord(middle, "r") && Array.from(middle.children).every(item => isWord(item, "rPr") || isWord(item, "t"));
    if (plain && !visibleText(middle).trim()) middle.remove();
    middle = next;
  }
  return resumed;
}

/** Start the text at ``resumeAt`` on a new line of the same paragraph, in place. */
export function breakLineBefore(paragraph: Element, keep: number, resumeAt: number): void {
  const resumed = cutAtResume(paragraph, keep, resumeAt);
  let anchor = resumed ? resumed.previousElementSibling : paragraph.lastElementChild;
  while (anchor && !isWord(anchor, "r")) anchor = anchor.previousElementSibling;
  const lineBreak = paragraph.ownerDocument.createElementNS(W, "w:r");
  const properties = anchor && Array.from(anchor.children).find(child => isWord(child, "rPr"));
  if (properties) lineBreak.appendChild(properties.cloneNode(true));
  lineBreak.appendChild(paragraph.ownerDocument.createElementNS(W, "w:br"));
  paragraph.insertBefore(lineBreak, resumed);
}

/** Move the text from ``resumeAt`` on into a new paragraph right after this one; return it. */
export function moveToNewParagraph(paragraph: Element, keep: number, resumeAt: number): Element {
  let moving = cutAtResume(paragraph, keep, resumeAt);
  const next = paragraph.ownerDocument.createElementNS(W, "w:p");
  const properties = Array.from(paragraph.children).find(child => isWord(child, "pPr"));
  if (properties) {
    const copy = properties.cloneNode(true) as Element;
    // The split-off text is a deeper subclause: neither the parent's list
    // membership nor its indentation applies to it.
    for (const name of ["numPr", "ind"]) for (const node of Array.from(copy.getElementsByTagNameNS(W, name))) node.remove();
    next.appendChild(copy);
    // A section break belongs to the paragraph that ends the section, now
    // the new one; a copy left behind would start an extra section.
    Array.from(properties.children).find(child => isWord(child, "sectPr"))?.remove();
  }
  while (moving) {
    const following = moving.nextElementSibling;
    if (!isWord(moving, "pPr")) next.appendChild(moving);
    moving = following;
  }
  paragraph.parentNode!.insertBefore(next, paragraph.nextSibling);
  return next;
}

export function contentSignature(document: Document): string {
  // Capture text, tabs, breaks, fields, relationships, images and bookmarks, not formatting.
  const ignored = new Set(["pPr", "rPr", "sectPr", "tblPr", "trPr", "tcPr", "tblGrid"]);
  const copy = document.documentElement.cloneNode(true) as Element;
  for (const tag of ignored) for (const node of Array.from(copy.getElementsByTagNameNS(W, tag))) node.remove();
  for (const run of Array.from(copy.getElementsByTagNameNS(W, "r"))) run.replaceWith(...Array.from(run.childNodes));
  // Adjacent text nodes and multiple w:t elements are equivalent after run splitting.
  for (const text of Array.from(copy.getElementsByTagNameNS(W, "t"))) text.replaceWith(copy.ownerDocument.createTextNode(text.textContent || ""));
  copy.normalize();
  return new XMLSerializer().serializeToString(copy);
}
