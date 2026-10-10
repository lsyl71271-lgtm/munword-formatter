/**
 * Strict content check for the browser engine; mirrors backend/app/content_guard.py.
 *
 * A paragraph's signature is a list of typed tokens:
 *   ["t", ch]                 one character of visible text (w:t)
 *   ["dt", text]              deleted revision text (w:delText)
 *   ["s", "{ns}tag", attrs]   start of any other node, full namespace, all attributes
 *   ["e", "{ns}tag"]          its end
 *   ["x", text]               text held by a non-text node (a field code)
 * Formatting (pPr / rPr / table properties) and run boundaries are left out,
 * as are Word's revision-save ids.  Tokens are arrays, never a mixed string,
 * so text that looks like markup cannot be confused with structure.
 */
import { unzipSync } from "fflate";
import { decodeXml } from "./docx-safety.ts";
import { planCountries, splitCountryNames, validCountryFieldChange } from "./countries.ts";
import type { CountryLanguage } from "./countries.ts";
import { isPlainField } from "./field-policy.ts";
import { applyNativeRules, validMarkerChange } from "./numbering.ts";
import type { NativeRule } from "./numbering.ts";
import policy from "../shared/document-policy.json" with { type: "json" };

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const FORMATTING = new Set(["pPr", "rPr", "tblPr", "trPr", "tcPr", "tblGrid", "sectPr", "tblPrEx"]);
const IGNORED_ATTRIBUTE = /^(?:rsid\w*|paraId|textId)$/;
const ENDING_CHARS = new Set([..."，,；;。.:：、 \t"]);
const LEADING_MARKER = /^(\s*)(\d+)\s*[.、．)）]\s*\t?/;

export type Token = [string, string] | [string, string, string];
export type Edit = { kind: string; key?: string; expected?: string | null; created?: boolean; country?: { language: CountryLanguage; preserveOrder: boolean; manual: boolean } };

const clark = (node: Element) => `{${node.namespaceURI || ""}}${node.localName}`;

function attributes(node: Element): string {
  const items: [string, string][] = [];
  for (const attr of Array.from(node.attributes)) {
    if (IGNORED_ATTRIBUTE.test(attr.localName)) continue;
    if (attr.name === "xmlns" || attr.name.startsWith("xmlns:")) continue;
    items.push([`{${attr.namespaceURI || ""}}${attr.localName}`, attr.value]);
  }
  items.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(items);
}

function collect(node: Element, out: Token[]) {
  for (const child of Array.from(node.children)) {
    const isW = child.namespaceURI === W_NS;
    if (isW && FORMATTING.has(child.localName)) continue;
    if (isW && child.localName === "r") collect(child, out);
    else if (isW && child.localName === "t") for (const ch of child.textContent || "") out.push(["t", ch]);
    else if (isW && child.localName === "delText") out.push(["dt", child.textContent || ""]);
    else {
      out.push(["s", clark(child), attributes(child)]);
      const own = Array.from(child.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent || "").join("");
      if (own.trim()) out.push(["x", own]);
      collect(child, out);
      out.push(["e", clark(child)]);
    }
  }
}

export function signature(element: Element): Token[] {
  const out: Token[] = [];
  collect(element, out);
  return out;
}

const key = (sig: Token[]) => JSON.stringify(sig);

/** Visible text of a paragraph (deleted revisions excluded). */
export function elementText(element: Element): string {
  let text = "";
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (child.namespaceURI === W_NS) {
        if (["del", "moveFrom", "txbxContent", ...FORMATTING].includes(child.localName)) continue;
        if (child.localName === "t") { text += child.textContent || ""; continue; }
        if (child.localName === "tab") { text += "\t"; continue; }
        if (["br", "cr"].includes(child.localName)) { text += "\n"; continue; }
      }
      walk(child);
    }
  };
  walk(element);
  return text;
}

const REVISIONS = new Set(["ins", "del", "moveFrom", "moveTo"].map(tag => `{${W_NS}}${tag}`));
/** Non-text tokens, plus every character inside a tracked revision: text a
 * reviewer inserted or deleted belongs to the revision, so an edit that adds a
 * label to it or drops a word from it rewrites the revision itself. */
function structureOnly(sig: Token[]): Token[] {
  let depth = 0;
  return sig.filter(t => {
    if (t[0] === "s" && REVISIONS.has(t[1])) depth++;
    else if (t[0] === "e" && REVISIONS.has(t[1])) depth--;
    return t[0] !== "t" || depth > 0;
  });
}
const isPlain = (sig: Token[]) => sig.every(t => t[0] === "t");
const WHITESPACE_NODES = new Set(["tab", "br", "cr"].flatMap(tag => [JSON.stringify(["s", `{${W_NS}}${tag}`, "[]"]), JSON.stringify(["e", `{${W_NS}}${tag}`])]));
export const isWhitespace = (sig: Token[]) => sig.every(t => (t[0] === "t" && /\s/.test(t[1])) || WHITESPACE_NODES.has(JSON.stringify(t)));

const WRAPPERS = new Set(["sdt", "sdtContent", "customXml"]);
const blocksIn = (container: Element): Element[] => Array.from(container.children).flatMap(c =>
  c.namespaceURI !== W_NS ? [] : c.localName === "p" || c.localName === "tbl" ? [c] : WRAPPERS.has(c.localName) ? blocksIn(c) : []);

/** Paragraphs and tables of the body, through content controls and custom XML
 * (content_guard.body_blocks): checking only the body's direct children let
 * any change inside a content control pass unnoticed. */
export function bodyBlocks(document: Document): Element[] {
  const body = document.getElementsByTagNameNS(W_NS, "body")[0];
  return body ? blocksIn(body) : [];
}

/** Each block-level wrapper with its own properties (not its content). */
function wrappers(document: Document): string {
  const body = document.getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) return "[]";
  // One collection per wrapper name: walking every element of the body was
  // quadratic in jsdom (the test environment), though linear in browsers.
  const found = ["sdt", "customXml"].flatMap(name => Array.from(body.getElementsByTagNameNS(W_NS, name)));
  return JSON.stringify(found.map(el => [el.localName, Array.from(el.attributes).map(a => [a.namespaceURI, a.localName, a.value]).sort(),
    Array.from(el.children).filter(c => !(c.namespaceURI === W_NS && (WRAPPERS.has(c.localName) || c.localName === "p" || c.localName === "tbl"))).map(signature)]));
}

function listMembership(element: Element): string {
  const paragraphs = element.localName === "p" ? [element] : Array.from(element.getElementsByTagNameNS(W_NS, "p"));
  return JSON.stringify(paragraphs.map(p => {
    const properties = Array.from(p.children).find(c => c.namespaceURI === W_NS && c.localName === "pPr");
    const num = properties && Array.from(properties.children).find(c => c.namespaceURI === W_NS && c.localName === "numPr");
    const value = (name: string) => num?.getElementsByTagNameNS(W_NS, name)[0]?.getAttributeNS(W_NS, "val");
    const id = value("numId");
    return id && id !== "0" ? [id, value("ilvl") || "0"] : null;
  }));
}

export type Snapshot = { order: Element[]; signatures: Map<Element, Token[]>; texts: Map<Element, string>; numbering: Map<Element, string>; wrappers: string };

export function takeSnapshot(document: Document): Snapshot {
  const order = bodyBlocks(document);
  return { order, signatures: new Map(order.map(el => [el, signature(el)])), texts: new Map(order.map(el => [el, elementText(el)])), numbering: new Map(order.map(el => [el, listMembership(el)])), wrappers: wrappers(document) };
}

export function withoutEnding(sig: Token[]): Token[] {
  const tokens = [...sig];
  // Text of a paragraph nested in a text box is not this paragraph's text.
  const own: number[] = [];
  let depth = 0;
  tokens.forEach((token, position) => {
    if (token[0] === "s" && token[1] === `{${W_NS}}p`) depth++;
    else if (token[0] === "e" && token[1] === `{${W_NS}}p`) depth--;
    else if (token[0] === "t" && depth === 0) own.push(position);
  });
  while (own.length && ENDING_CHARS.has(tokens[own[own.length - 1]][1])) tokens.splice(own.pop()!, 1);
  return tokens;
}

function normalizeMarker(sig: Token[]): Token[] {
  const chars: string[] = [];
  let end = 0;
  const tabStart = JSON.stringify(["s", `{${W_NS}}tab`, "[]"]), tabEnd = JSON.stringify(["e", `{${W_NS}}tab`]);
  while (end < sig.length) {
    if (sig[end][0] === "t") { chars.push(sig[end][1]); end++; }
    else if (JSON.stringify(sig[end]) === tabStart && end + 1 < sig.length && JSON.stringify(sig[end + 1]) === tabEnd) { chars.push("\t"); end += 2; }
    else break;
  }
  const normalized = chars.join("").replace(LEADING_MARKER, (_m, lead, digits) => `${lead}${digits}.`);
  return [...[...normalized].map(ch => ["t", ch] as Token), ...sig.slice(end)];
}

/** True when a rewrite of `kind` left every non-text node and all revision
 * text in place (content_guard.rewrite_keeps_structure).  A marker rewrite may
 * turn "1. " into "1、⇥"; the tab it adds belongs to the marker. */
export function rewriteKeepsStructure(kind: string, oldSig: Token[], newSig: Token[]): boolean {
  if (kind === "marker") return key(structureOnly(normalizeMarker(oldSig))) === key(structureOnly(normalizeMarker(newSig)));
  return key(structureOnly(oldSig)) === key(structureOnly(newSig));
}

const squash = (text: string) => text.replace(/\s+/g, "");

function countryNameList(texts: string[]): string[] {
  return texts.flatMap((text, index) => {
    const value = index === 0 || /^\s*[^:：]{1,20}[:：]/.test(text) ? text.replace(/^\s*[^:：]{1,20}[:：]\s*/, "") : text;
    return splitCountryNames(value);
  });
}
function countryNames(texts: string[]): Map<string, number> {
  const names = new Map<string, number>();
  for (const name of countryNameList(texts)) names.set(name, (names.get(name) || 0) + 1);
  return names;
}

const sameCounts = (a: Map<string, number>, b: Map<string, number>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

function longestPrefix(text: string, words: string[]) {
  return [...words].sort((a, b) => b.length - a.length).find(word => text.toLowerCase().startsWith(word.toLowerCase())) ?? null;
}

function checkEdit(edit: Edit, oldSig: Token[], newSig: Token[], oldText: string, newText: string, titles: string[], labels: string[]): string {
  const kind = edit.kind;
  if (kind === "ending") return key(withoutEnding(oldSig)) === key(withoutEnding(newSig)) ? "" : "句末以外的内容发生变化";
  if (kind === "marker") return key(normalizeMarker(oldSig)) === key(normalizeMarker(newSig)) ? "" : "编号以外的内容发生变化";
  if (kind === "dr-marker" || kind === "list-marker") return isPlain(oldSig) && isPlain(newSig) && validMarkerChange(oldText,newText) ? "" : "编号转换改变了条号数值、正文或受保护结构";
  if (kind === "countries" || kind === "signature") return "";
  if (kind === "statement-number") return edit.expected != null && newText === edit.expected && STATEMENT_NUMBER.test(newText)
    && newText.replace(STATEMENT_NUMBER, "") === oldText && key(structureOnly(oldSig)) === key(structureOnly(newSig)) ? "" : "编号以外的内容发生变化";
  if (kind === "country-name") return isPlainField(oldSig) && isPlain(newSig) && edit.country && !edit.country.manual
    && validCountryFieldChange(oldText, newText, edit.country.language) ? "" : "国家全称变更不能由共用名称表从原字段证明";
  if (!(kind === "field" && isPlainField(oldSig) && isPlain(newSig)) && key(structureOnly(oldSig)) !== key(structureOnly(newSig))) return "图片、域、链接或修订等内容结构发生变化";
  if (kind === "title") {
    const oldWord = longestPrefix(oldText.trim(), titles), newWord = longestPrefix(newText.trim(), titles);
    return oldWord !== null && newWord !== null && oldText.trim().slice(oldWord.length) === newText.trim().slice(newWord.length) ? "" : "标题编号或其他文字发生变化";
  }
  if (kind === "label-drop") {
    const match = oldText.match(new RegExp(`^\\s*(?:${labels.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*[:：]\\s*([\\s\\S]*)$`));
    return match && match[1].trim() === newText.trim() ? "" : "删除标签时正文发生变化";
  }
  if (kind === "label-restore" || kind === "field") {
    if (edit.expected == null || newText.trim() !== edit.expected.trim()) return `改写结果与授权值不符：应为“${(edit.expected || "").slice(0, 30)}”`;
    if (kind === "field" && !isPlain(newSig)) return "改写后的元数据段含有文字以外的内容";
    if (kind === "label-restore" && !edit.expected.trim().endsWith(oldText.trim().replace(/^[:：\s]+/, ""))) return "补标签时原有文字发生变化";
    return "";
  }
  return `未知的编辑类型 ${kind}`;
}

/** A joint statement paragraph may gain only a leading "N. " (shared/document-policy.json treaties). */
const STATEMENT_NUMBER = /^\d{1,3}\. /;
const SIGNATURE_LABEL = [new RegExp(policy.treaties.signature.labelPattern.zh), new RegExp(policy.treaties.signature.labelPattern.en, "i")];
const isSignatureLabel = (token: string) => SIGNATURE_LABEL.some(pattern => pattern.test(token));
/** Names and labels of a signature line: Chinese splits at any space, other text at tabs or wider gaps (names have single spaces). */
const signatureTokens = (text: string) => (/[\u3400-\u9fff]/.test(text) ? text.split(/[\s\u3000]+/) : text.split(/\t+|\s{2,}|\u3000+/)).map(t => t.trim()).filter(Boolean);
const tally = (values: string[]) => values.reduce((counts, value) => counts.set(value, (counts.get(value) || 0) + 1), new Map<string, number>());
const textAndSpacing = (sig: Token[]) => sig.every(t => t[0] === "t" || WHITESPACE_NODES.has(JSON.stringify(t)));

/** A rebuilt signature block: only the representatives' labels it lists may be added; every name and
 * every label of the original block stays (shared/document-policy.json treaties.signature). */
function checkSignatureBlock(before: Snapshot, removed: Element[], created: Element[], expected: string | null | undefined): string[] {
  const problems: string[] = [];
  let labels: string[] = [];
  try { labels = JSON.parse(expected || "[]"); } catch { problems.push("签字栏授权记录损坏"); }
  if (removed.some(el => !textAndSpacing(before.signatures.get(el)!))) problems.push("签字栏原稿含有文字以外的内容，不能重建");
  if (created.some(el => !textAndSpacing(signature(el)))) problems.push("重建的签字栏含有文字以外的内容");
  const old = removed.flatMap(el => signatureTokens(before.texts.get(el)!));
  const now = created.flatMap(el => elementText(el).split(/[\t\n]/).map(t => t.trim()).filter(Boolean));
  const allowed = new Set(labels);
  const nowLabels = now.filter(t => allowed.has(t)), nowNames = now.filter(t => !allowed.has(t));
  if (JSON.stringify(nowLabels) !== JSON.stringify(labels)) problems.push("签字栏的代表与授权的签署方不一致");
  const oldLabels = tally(old.filter(isSignatureLabel)), kept = tally(nowLabels);
  if ([...oldLabels].some(([label, count]) => (kept.get(label) || 0) < count)) problems.push("签字栏原有的代表被删除或改写");
  if (!sameCounts(tally(old.filter(t => !isSignatureLabel(t))), tally(nowNames))) problems.push("签字栏的姓名被删除、改写或新增");
  return problems;
}

/** Problems comparing the snapshot with the formatted document, as user-facing text. */
export function verifyFormat(before: Snapshot, document: Document, editLog: Map<Element, Edit>, titles: string[], labels: string[]): string[] {
  const afterOrder = bodyBlocks(document), afterSet = new Set(afterOrder), beforeSet = new Set(before.order);
  const number = new Map(before.order.map((el, index) => [el, index + 1]));
  const problems: string[] = [];
  if (wrappers(document) !== before.wrappers) problems.push("内容控件或自定义 XML 容器发生变化");
  const groups = new Map<string, { before: Element[]; after: Element[]; expected: string | null | undefined; country?: Edit["country"] }>();
  const groupOf = (edit: Edit) => {
    const name = edit.key || "";
    if (!groups.has(name)) groups.set(name, { before: [], after: [], expected: edit.expected, country: edit.country });
    return groups.get(name)!;
  };
  const signatureBlock = { removed: [] as Element[], created: [] as Element[], expected: null as string | null | undefined };
  for (const el of before.order) {
    const edit = editLog.get(el);
    if (edit?.kind === "countries") { const group = groupOf(edit); group.before.push(el); if (afterSet.has(el)) group.after.push(el); }
    if (edit?.kind === "signature" && !afterSet.has(el)) { signatureBlock.removed.push(el); continue; }
    if (!afterSet.has(el)) {
      const removable = edit?.kind === "countries" || (edit?.kind === "empty-line" && isWhitespace(before.signatures.get(el)!));
      if (before.signatures.get(el)!.length && !removable) problems.push(`第 ${number.get(el)} 段被删除：${before.texts.get(el)!.slice(0, 30)}`);
      continue;
    }
    const oldSig = before.signatures.get(el)!, newSig = signature(el);
    if (before.numbering.get(el) !== listMembership(el)) problems.push(`第 ${number.get(el)} 段的原生列表归属或层级发生变化，可能改变条号及交叉引用`);
    if (key(oldSig) === key(newSig)) continue;
    if (!edit) { problems.push(`第 ${number.get(el)} 段内容发生未经许可的变化：“${before.texts.get(el)!.slice(0, 20)}” → “${elementText(el).slice(0, 20)}”`); continue; }
    const reason = checkEdit(edit, oldSig, newSig, before.texts.get(el)!, elementText(el), titles, labels);
    if (reason) problems.push(`第 ${number.get(el)} 段（${edit.kind}）${reason}`);
  }
  for (const el of afterOrder) {
    if (beforeSet.has(el)) continue;
    const edit = editLog.get(el);
    if (!edit?.created) problems.push(`输出中出现来源不明的段落：${elementText(el).slice(0, 30)}`);
    else if (edit.kind === "blank") { if (signature(el).length) problems.push("新增空行含有内容"); }
    else if (edit.kind === "countries") groupOf(edit).after.push(el);
    else if (edit.kind === "signature") { signatureBlock.created.push(el); signatureBlock.expected = edit.expected; }
    else problems.push(`输出中新增段落的类型不被允许：${edit.kind}`);
  }
  if (signatureBlock.removed.length || signatureBlock.created.length) problems.push(...checkSignatureBlock(before, signatureBlock.removed, signatureBlock.created, signatureBlock.expected));
  const position = new Map(afterOrder.map((el, index) => [el, index]));
  for (const [name, group] of groups) {
    const after = [...group.after].sort((a, b) => position.get(a)! - position.get(b)!);
    for (const el of after) {
      const changed = !beforeSet.has(el) || key(signature(el)) !== key(before.signatures.get(el)!);
      if (changed && !isPlain(signature(el))) problems.push(`${name} 名单段落含有文字以外的内容`);
    }
    const newText = after.map(elementText).join("");
    if (group.before.some(el => !isPlainField(before.signatures.get(el)!))) problems.push(`${name} 原名单含复杂结构，不能授权名称替换`);
    if (group.country && !group.country.manual) {
      const originals = countryNameList(group.before.map(el => before.texts.get(el)!));
      const actual = countryNameList([newText]);
      const permitted = planCountries(originals, group.country.language, group.country.preserveOrder).values;
      if (JSON.stringify(actual) !== JSON.stringify(permitted)) problems.push(`${name} 名单包含无法由原字段和共用国家表证明的名称变更、删除或排序`);
    } else if (!group.country && !sameCounts(countryNames(group.before.map(el => before.texts.get(el)!)), countryNames([newText]))) {
      problems.push(`${name} 名单名称变化缺少国家表证明或第 03 步人工授权`);
    }
    if (group.expected != null) {
      if (squash(newText) !== squash(group.expected)) problems.push(`${name} 名单文字与预期不符：${newText.slice(0, 40)}`);
    } else if (!sameCounts(countryNames(group.before.map(el => before.texts.get(el)!)), countryNames(after.map(elementText)))) {
      problems.push(`${name} 名单与原文不一致`);
    }
  }
  const survivors = afterOrder.filter(el => beforeSet.has(el));
  const expectedOrder = before.order.filter(el => afterSet.has(el));
  if (survivors.length !== expectedOrder.length || survivors.some((el, i) => el !== expectedOrder[i])) problems.push("段落顺序发生变化");
  return problems;
}

// ------------------------------------------------------- visibility and deletion marks

/** Run properties that change what a reader sees or what the text means.
 * The signatures above leave run properties out, so they are checked here on
 * their own: a hidden note must not become visible, a struck deletion must not
 * lose its strike (content_guard.semantic_marks). */
const HIDDEN = ["vanish", "webHidden", "specVanish"], STRUCK = ["strike", "dstrike"];
const markOn = (run: Element, tags: string[]) => {
  const rPr = Array.from(run.children).find(c => c.namespaceURI === W_NS && c.localName === "rPr");
  return Boolean(rPr) && Array.from(rPr!.children).some(c => c.namespaceURI === W_NS && tags.includes(c.localName)
    && !["0", "false", "off"].includes(c.getAttributeNS(W_NS, "val") || ""));
};
function marksOf(element: Element): [string, string] {
  let hidden = "", struck = "";
  for (const run of Array.from(element.getElementsByTagNameNS(W_NS, "r"))) {
    let deleted = false;
    for (let a = run.parentElement; a && a !== element; a = a.parentElement) if (a.namespaceURI === W_NS && ["del", "moveFrom"].includes(a.localName)) deleted = true;
    if (deleted) continue;
    const text = Array.from(run.children).filter(c => c.namespaceURI === W_NS && c.localName === "t").map(c => c.textContent || "").join("");
    if (markOn(run, HIDDEN)) hidden += text;
    if (markOn(run, STRUCK)) struck += text;
  }
  return [hidden, struck];
}
export type Marks = Map<Element, [string, string]>;
export function semanticMarks(document: Document): Marks {
  return new Map(bodyBlocks(document).map(el => [el, marksOf(el)]));
}
/** ``before`` survives in order inside ``after``, compared by code point (an emoji or a CJK Extension B character is one). */
const keeps = (before: string, after: string) => {
  const wanted = [...before];
  let i = 0;
  for (const ch of after) if (i < wanted.length && ch === wanted[i]) i++;
  return i === wanted.length;
};
const excerpt = (text: string) => [...text].slice(0, 20).join("");
/** [hidden, struck] text of one block, for checking a single rewrite (content_guard.paragraph_marks). */
export const paragraphMarks = (element: Element) => marksOf(element);
/** The hidden and struck characters of ``before`` survive, in order and still marked, in ``element``. */
export function marksKept(before: [string, string], element: Element): boolean {
  const [hidden, struck] = marksOf(element);
  return keeps(before[0], hidden) && keeps(before[1], struck);
}
/** Hidden and struck characters survive, in order, in the same block. */
export function verifyMarks(before: Marks, document: Document): string[] {
  const present = new Set(bodyBlocks(document)), problems: string[] = [];
  let number = 0;
  for (const [el, [hidden, struck]] of before) {
    number++;
    if (!hidden && !struck) continue;
    if (!present.has(el)) { problems.push(`第 ${number} 段含隐藏或删除线文字，但该段被删除`); continue; }
    const [nowHidden, nowStruck] = marksOf(el);
    if (!keeps(hidden, nowHidden)) problems.push(`第 ${number} 段的隐藏文字会变为可见：${excerpt(hidden)}`);
    if (!keeps(struck, nowStruck)) problems.push(`第 ${number} 段的删除线被移除：${excerpt(struck)}`);
  }
  return problems;
}

/** Structure of a paragraph without its visible characters (for rolling back an edit). */
export const structureOf = (element: Element) => key(structureOnly(signature(element)));

// ------------------------------------------------------------------ package

function sameBytes(a: Uint8Array, b: Uint8Array | undefined) {
  if (!b || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function packageRelations(parts: Record<string, Uint8Array>) {
  const relations = new Map<string, Map<string, string>>();
  for (const [name, bytes] of Object.entries(parts)) {
    if (!/\.rels$/i.test(name)) continue;
    const xml = new DOMParser().parseFromString(decodeXml(bytes), "application/xml");
    if (xml.getElementsByTagName("parsererror").length) throw new Error("关系部件 XML 损坏，不能验证链接目标");
    const map = new Map<string, string>();
    for (const rel of Array.from(xml.getElementsByTagNameNS("http://schemas.openxmlformats.org/package/2006/relationships", "Relationship"))) {
      const attrs = Array.from(rel.attributes).filter(a => a.namespaceURI !== "http://www.w3.org/2000/xmlns/")
        .map(a => [`{${a.namespaceURI || ""}}${a.localName}`, a.value]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      if (map.has(rel.getAttribute("Id") || "")) throw new Error("关系部件存在重复标识，不能验证链接目标");
      map.set(rel.getAttribute("Id") || "", JSON.stringify(attrs));
    }
    relations.set(name, map);
  }
  return relations;
}

/** Every relationship keeps its target, type and mode; every resource keeps its bytes. */
export function verifyPackage(before: Uint8Array, after: Uint8Array, nativeRules: NativeRule[] = []): string[] {
  const oldParts = unzipSync(before), newParts = unzipSync(after);
  const oldRels = packageRelations(oldParts), newRels = packageRelations(newParts);
  const problems: string[] = [];
  for (const [part, rels] of oldRels) for (const [id, attrs] of rels) {
    if (newRels.get(part)?.get(id) !== attrs) problems.push(`关系 ${part}#${id} 的目标、类型或模式发生变化`);
  }
  for (const [name, bytes] of Object.entries(oldParts)) {
    if (name.startsWith("word/media/") || name.startsWith("word/embeddings/")) {
      if (!sameBytes(bytes, newParts[name])) problems.push(`资源 ${name} 的内容发生变化`);
    } else if (/^word\/(?:numbering|footnotes|endnotes|comments|header\d+|footer\d+)\.xml$/.test(name)) {
      const parse = (data: Uint8Array) => new DOMParser().parseFromString(decodeXml(data), "application/xml").documentElement;
      const expected = parse(bytes);
      if (name === "word/numbering.xml" && nativeRules.length) applyNativeRules(expected.ownerDocument,nativeRules);
      if (!newParts[name] || key(signature(expected)) !== key(signature(parse(newParts[name])))) problems.push(`部件 ${name} 的内容或编号语义发生变化`);
    }
  }
  return problems;
}

// ------------------------------------------------------------ structure repair

export function documentTokens(document: Document): Token[] {
  const tokens: Token[] = [];
  for (const el of bodyBlocks(document)) { collect(el, tokens); tokens.push(["p", ""]); }
  return tokens;
}

/** Structure repair may split paragraphs and add the markers it reports; nothing else. */
export function verifyRepair(before: Token[], after: Token[], insertedTexts: string[]): string[] {
  const allowed = new Map<string, number>();
  for (const text of insertedTexts) for (const ch of text) allowed.set(ch, (allowed.get(ch) || 0) + 1);
  const ignorable = (t: Token) => t[0] === "p" || (t[0] === "t" && /\s/.test(t[1]))
    || (t[1] === `{${W_NS}}br` && (t[0] === "e" || t[2] === "[]"));
  const a = before.filter(t => !ignorable(t)), b = after.filter(t => !ignorable(t));
  // Walk both sequences; every extra token in ``after`` must be an allowed character.
  const problems: string[] = [];
  let i = 0;
  for (let j = 0; j < b.length; j++) {
    if (i < a.length && key([a[i]]) === key([b[j]])) { i++; continue; }
    const token = b[j];
    if (token[0] === "t" && (allowed.get(token[1]) || 0) > 0) { allowed.set(token[1], allowed.get(token[1])! - 1); continue; }
    problems.push(`结构修复加入了未报告的内容：${token[0] === "t" ? token[1] : token[1].split("}")[1]}`);
    break;
  }
  if (!problems.length && i < a.length) problems.push("结构修复删除了内容");
  return problems;
}
