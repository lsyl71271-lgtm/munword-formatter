import { zipSync } from "fflate";
import { readPackage, visibleText, contentSignature, decodeXml, canCut, breakLineBefore, moveToNewParagraph, Unsplittable } from "./docx-safety.ts";
import { documentTokens, marksKept, paragraphMarks, rewriteKeepsStructure, semanticMarks, signature, takeSnapshot, verifyFormat, verifyMarks, verifyPackage, verifyRepair } from "./content-guard.ts";
import { isPlainField } from "./field-policy.ts";
import type { Edit } from "./content-guard.ts";
import policyData from "../shared/document-policy.json" with { type: "json" };
import regionNames from "../shared/region-names-en.json" with { type: "json" };
import { COUNTRY_DATA_DATE, countryWarnings, planCountries, resolveCountry, splitCountryNames } from "./countries.ts";
import { InvalidRequestError, validateReview } from "./request-validation.ts";

export type BrowserDocumentType =
  | "position-paper"
  | "working-paper"
  | "draft-directive"
  | "draft-resolution"
  | "friendly-amendment"
  | "unfriendly-amendment";

export type BrowserClause = {
  text: string;
  level: number;
  kind: string;
  paragraph_index: number;
  confidence: number;
};

export type BrowserModel = {
  document_type: BrowserDocumentType;
  language: "zh" | "en";
  title: string;
  committee: string;
  topic: string;
  delegate: string;
  country: string;
  sponsors: string[];
  signatories: string[];
  preambulatory_clauses: BrowserClause[];
  operative_clauses: BrowserClause[];
  body_clauses: BrowserClause[];
  max_numbering_level: number;
  warnings: string[];
  paragraphs: string[];
};

export type BrowserValidation = {
  code: string;
  label: string;
  status: "pass" | "warning" | "error";
  detail?: string;
};

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const encoder = new TextEncoder();
// XML parts may be UTF-8 or UTF-16 (OPC); outputs are written as UTF-8.
const decoder = { decode: decodeXml };
const ZH_MARKER = /^[\s\u00a0]*(?:第[一二三四五六七八九十百千]+条|[一二三四五六七八九十]+[、.]|[（(][一二三四五六七八九十子丑寅卯辰巳午未申酉戌亥甲乙丙丁戊己庚辛壬癸]+[）)]|\d+[.、．)]|[甲乙丙丁戊己庚辛壬癸][、.]|[（(][a-zivx]+[）)]|[（(]\d{1,2}[）)]|[a-z][.)）](?=\s|[^\x00-\x7f]))\s*/i;
const SUB_MARKER = /^[\s\u00a0]*(?:[（(][一二三四五六七八九十a-zivx]+[）)]|[甲乙丙丁戊己庚辛壬癸][、.])/i;
type MetadataKey = "committee" | "topic" | "delegate" | "country" | "sponsors" | "signatories";
type DocumentPolicy = {
  unlabeledHeaderFields?: MetadataKey[];
  restoreMissingHeaderLabels?: boolean;
  repairs?: string[];
  emphasis?: Array<{ role: string; marker: "clause" | "top-level"; prefixSet: "preambulatory" | "operative"; style: "bold" | "italic" | "underline" }>;
};
const POLICY = policyData as typeof policyData & { documents: Record<BrowserDocumentType, DocumentPolicy> };
const METADATA_KEYS = Object.keys(POLICY.metadata) as MetadataKey[];
const ENGLISH_REGIONS = new Set(regionNames.map(name => name.toLowerCase()));
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const spacedAlias = (value: string) => [...value].map(escapePattern).join(/^[\u3400-\u9fff]+$/.test(value) ? "\\s*" : "");
const LABELS = Object.fromEntries(METADATA_KEYS.map((key) => [
  key,
  new RegExp(`^(?:${[...POLICY.metadata[key].aliases].sort((a, b) => b.length - a.length).map(spacedAlias).join("|")})\\s*[:：]\\s*([\\s\\S]*)$`, "i"),
])) as Record<MetadataKey, RegExp>;

function parsePackage(content: ArrayBuffer) {
  let parts: Record<string, Uint8Array>;
  try { parts = readPackage(content); } catch (reason) { throw new InvalidDocxError(reason instanceof Error ? reason.message : String(reason)); }
  const xml = decoder.decode(parts["word/document.xml"]);
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.getElementsByTagName("parsererror").length) throw new InvalidDocxError("DOCX 主文档 XML 无法解析。");
  if (document.documentElement.namespaceURI !== WORD_NS || document.documentElement.localName !== "document"
    || !directChild(document.documentElement, "body")) throw new InvalidDocxError("DOCX 主文档缺少有效正文结构。");
  // Lists can live in an inherited paragraph style rather than in w:pPr.
  if (parts["word/styles.xml"]) {
    const styles = new DOMParser().parseFromString(decoder.decode(parts["word/styles.xml"]), "application/xml");
    if (styles.getElementsByTagName("parsererror").length) throw new InvalidDocxError("DOCX 样式 XML 损坏。");
    const index = new Map(elements(styles, "style").map(s => [wordAttribute(s, "styleId"), s]));
    const chain = (id: string | null | undefined) => styleChain(index, id);
    const inherit = (id: string | null | undefined, group: string, property: string): Element | null => {
      for (const [, style] of chain(id)) {
        const props = directChild(style, group), node = props && directChild(props, property);
        if (node) return node;
      }
      return null;
    };
    // The default paragraph style is not copied onto runs: a damaged bold
    // Normal style would otherwise turn a whole document bold (as in Python).
    // Chinese Word names it "a", not "Normal".
    const defaultParagraph = defaultStyleId(styles, "paragraph") || "Normal";
    const defaults = new Set(["Normal", defaultParagraph]);
    const semanticMarks = ["vanish", "webHidden", "specVanish", "strike", "dstrike"];
    const fromStyle = (id: string | null | undefined, property: string): Element | null => {
      for (const [styleId, style] of chain(id)) {
        if (!semanticMarks.includes(property) && defaults.has(styleId)) break;
        const props = directChild(style, "rPr"), node = props && directChild(props, property);
        if (node) return node;
      }
      return null;
    };
    const defaultRun = (() => {
      const root = elements(styles, "docDefaults")[0], rPrDefault = root && directChild(root, "rPrDefault");
      return rPrDefault && directChild(rPrDefault, "rPr");
    })();
    const numbering = parts["word/numbering.xml"] ? new DOMParser().parseFromString(decoder.decode(parts["word/numbering.xml"]), "application/xml") : null;
    for (const p of paragraphElements(document)) {
      const props = ensureChild(p,"pPr",true);
      const paragraphStyle = wordAttribute(directChild(props,"pStyle"),"val");
      const num = !directChild(props,"numPr") && inherit(paragraphStyle || "Normal","pPr","numPr");
      if (num) {
        const copy = document.importNode(num, true) as Element;
        // ECMA-376 §17.9.23: a level that names the paragraph style is that
        // style's level, whatever the style's own numPr says.
        const level = numbering && linkedLevel(numbering, wordAttribute(directChild(copy, "numId"), "val"), chain(paragraphStyle).map(([id]) => id));
        if (level) {
          let ilvl = directChild(copy, "ilvl");
          if (!ilvl) { ilvl = document.createElementNS(WORD_NS, "w:ilvl"); copy.insertBefore(ilvl, copy.firstChild); }
          setWordAttribute(ilvl, "val", level);
        }
        props.appendChild(copy);
      }
      // A text box's paragraphs inherit from their own styles.
      for (const run of elements(p,"r").filter(run => ownParagraph(run) === p)) {
        const rPr = ensureChild(run,"rPr",true), character = wordAttribute(directChild(rPr,"rStyle"),"val");
        for (const name of ["b","i","u","vertAlign", ...semanticMarks]) {
          if (directChild(rPr,name)) continue;
          // Visibility/deletion marks are semantic, including inherited defaults.
          const semantic = semanticMarks.includes(name);
          const inherited = fromStyle(character, name) || (name !== "vertAlign" && fromStyle(paragraphStyle, name))
            || (semantic && (fromStyle(defaultParagraph, name) || (defaultRun && directChild(defaultRun, name))));
          if (inherited) { const target = rChild(rPr,name); for (const attr of Array.from(inherited.attributes)) target.setAttributeNS(attr.namespaceURI,attr.name,attr.value); }
        }
      }
    }
  }
  return { parts, document };
}

const ON = ["1", "true", "on"];
/** The style Word applies when nothing names one (w:default); docx_view.default_style_id. */
function defaultStyleId(styles: Document, kind: string): string | null {
  const style = elements(styles, "style").find(s => wordAttribute(s, "type") === kind && ON.includes(wordAttribute(s, "default") || ""));
  return (style && wordAttribute(style, "styleId")) || null;
}

/** [id, element] for a style and the styles it is based on, nearest first (docx_view.style_chain). */
function styleChain(index: Map<string | null | undefined, Element>, id: string | null | undefined): [string, Element][] {
  const chain: [string, Element][] = [], seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const style = index.get(id);
    if (!style) break;
    chain.push([id, style]);
    id = wordAttribute(directChild(style, "basedOn"), "val");
  }
  return chain;
}

/** w:ilvl of the level whose w:pStyle names one of ``styleIds`` (structure_repair._linked_level). */
function linkedLevel(numbering: Document, numId: string | null | undefined, styleIds: string[]): string | null {
  const num = elements(numbering, "num").find(item => wordAttribute(item, "numId") === numId);
  const reference = num && wordAttribute(directChild(num, "abstractNumId"), "val");
  const abstract = reference != null ? elements(numbering, "abstractNum").find(item => wordAttribute(item, "abstractNumId") === reference) : undefined;
  if (!abstract) return null;
  const linked = new Map<string, string>();
  for (const level of Array.from(abstract.children).filter(child => child.namespaceURI === WORD_NS && child.localName === "lvl")) {
    const style = wordAttribute(directChild(level, "pStyle"), "val");
    if (style && !linked.has(style)) linked.set(style, wordAttribute(level, "ilvl") || "0");
  }
  return styleIds.map(id => linked.get(id)).find(level => level !== undefined) ?? null;
}

/** The paragraph a run belongs to; a text box's runs belong to its own paragraphs. */
function ownParagraph(run: Element): Element | null {
  let node = run.parentElement;
  while (node && !(node.namespaceURI === WORD_NS && node.localName === "p")) node = node.parentElement;
  return node;
}

function elements(parent: Document | Element, localName: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS(WORD_NS, localName));
}

function directChild(parent: Element, localName: string): Element | null {
  return Array.from(parent.children).find((child) => child.namespaceURI === WORD_NS && child.localName === localName) || null;
}

function removeChildren(parent: Element, names: string[]) {
  for (const child of Array.from(parent.children)) if (child.namespaceURI === WORD_NS && names.includes(child.localName)) child.remove();
}

function ensureChild(parent: Element, localName: string, first = false): Element {
  const existing = directChild(parent, localName);
  if (existing) {
    for (const child of Array.from(parent.children)) if (child !== existing && child.namespaceURI === WORD_NS && child.localName === localName) child.remove();
    return existing;
  }
  const node = parent.ownerDocument.createElementNS(WORD_NS, `w:${localName}`);
  if (first && parent.firstChild) parent.insertBefore(node, parent.firstChild);
  else parent.appendChild(node);
  return node;
}

function setWordAttribute(node: Element, name: string, value: string) {
  node.setAttributeNS(WORD_NS, `w:${name}`, value);
}

function removeWordAttribute(node: Element, name: string) {
  node.removeAttributeNS(WORD_NS, name);
  node.removeAttribute(`w:${name}`);
}

/** Read a w: attribute whether it was parsed with its namespace or set by prefix. */
function wordAttribute(node: Element | null | undefined, name: string) {
  return node?.getAttributeNS(WORD_NS, name) || node?.getAttribute(`w:${name}`);
}

/** Write both the Latin and complex-script size (w:sz / w:szCs) in half-points. */
function setSize(properties: Element, sizePt: number) {
  for (const name of ["sz", "szCs"]) setWordAttribute(rChild(properties, name), "val", String(Math.round(sizePt * 2)));
}

function hasAutomaticNumber(paragraph: Element) {
  const num = directChild(paragraph, "pPr")?.getElementsByTagNameNS(WORD_NS, "numPr")[0];
  return Boolean(num) && wordAttribute(num?.getElementsByTagNameNS(WORD_NS, "numId")[0], "val") !== "0";
}

function paragraphText(paragraph: Element): string {
  return visibleText(paragraph);
}

/** Every paragraph, table cells and text boxes included (fonts, sizes, styles). */
function paragraphElements(document: Document): Element[] {
  const body = elements(document, "body")[0];
  return body ? elements(body, "p") : [];
}

const FLOW_CONTAINERS = new Set(["sdt", "sdtContent", "customXml"]);
/** The running text in reading order: body paragraphs and those inside
 * body-level content controls (docx_view.flow_paragraph_elements).  Table
 * cells and text boxes are not clauses or header lines. */
function flowParagraphs(document: Document): Element[] {
  const walk = (container: Element): Element[] => Array.from(container.children).flatMap(child =>
    child.namespaceURI !== WORD_NS ? [] : child.localName === "p" ? [child] : FLOW_CONTAINERS.has(child.localName) ? walk(child) : []);
  const body = elements(document, "body")[0];
  return body ? walk(body) : [];
}

function splitCountries(value: string) {
  return splitCountryNames(value);
}

function looksLikeCountryContinuation(text: string) {
  if (/[：:。！？!?；;\d]/.test(text) || text.trimEnd().endsWith(".")) return false;
  const values = splitCountries(text.replace(/[、，,\s]+$/, ""));
  return Boolean(values.length) && values.every((value) => /[\u3400-\u9fff]/.test(value)
    ? value.length <= 24 && ["国", "联邦", "联盟", "教廷"].some((ending) => value.endsWith(ending))
    : value.length <= 80 && (ENGLISH_REGIONS.has(value.replace(/^The\s+/i," ").trim().toLowerCase())
      || /^(?:The\s+)?(?:.*?\b(?:Republic|Kingdom|Federation|States?|Emirates)\b.*)$/i.test(value)));
}

function field(text: string, key: MetadataKey): string {
  const match = text.trim().match(LABELS[key]);
  return match ? (match[1] || "").trim() : "";
}

function labeledField(text: string): { key: MetadataKey; value: string; labelLength: number } | null {
  const trimmed = text.trim();
  for (const key of METADATA_KEYS) {
    const match = trimmed.match(LABELS[key]);
    if (!match) continue;
    const labelLength = Math.max(0, trimmed.length - (match[1] || "").length);
    return { key, value: (match[1] || "").trim(), labelLength };
  }
  return null;
}

/** A labeled line, a clause marker, a subject line, a clause or prose ends a
 * multi-line country list (parser._collect_multiline_countries). */
function endsCountryList(text: string) {
  const lower = text.trim().toLowerCase();
  return Boolean(labeledField(text)) || ZH_MARKER.test(text) || SUB_MARKER.test(text) || PART.test(text.trim())
    || isCommitteeSubject(text, "") || CLAUSE_WORDS.some(word => lower.startsWith(word)) || !looksLikeCountryContinuation(text);
}

/** Shared policy ``language`` (parser.detect_language): a few quoted Chinese
 * characters do not make an English document Chinese. */
function detectLanguage(text: string): "zh" | "en" {
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length, latin = (text.match(/[A-Za-z]/g) || []).length;
  return cjk >= Math.max(POLICY.language.minCjk, Math.floor(latin / POLICY.language.latinPerCjk)) ? "zh" : "en";
}

const BOUNDARY = POLICY.headerBoundary;
const BODY_MARKER = new RegExp(BOUNDARY.bodyMarker, "i"), SENTENCE_END = new RegExp(BOUNDARY.sentenceEnd);
const numberedParagraph = (p: Element) => {
  const pPr = directChild(p, "pPr"), numPr = pPr && directChild(pPr, "numPr");
  const numId = numPr && wordAttribute(directChild(numPr, "numId"), "val");
  return Boolean(numId) && numId !== "0";
};

/** The first paragraph of the body (shared policy headerBoundary; semantic_policy.starts_body). */
function startsBody(text: string, numbered = false): boolean {
  const trimmed = text.trim();
  if (!trimmed || labeledField(trimmed)) return false;
  if ((numbered && BOUNDARY.nativeNumbering) || BODY_MARKER.test(trimmed) || SENTENCE_END.test(trimmed)) return true;
  return trimmed.endsWith(".") && trimmed.split(/\s+/).length >= BOUNDARY.englishSentenceWords;
}

/** Index of the first body paragraph after the title: header fields lie before it.
 * A body paragraph that starts like "议题：" is the author's text; reading it as
 * metadata replaced the real topic and the label drop deleted its words. */
function headerEnd(texts: string[], titleIndex: number, numbered: (index: number) => boolean = () => false): number {
  for (let index = Math.max(titleIndex, -1) + 1; index < texts.length; index++) if (startsBody(texts[index], numbered(index))) return index;
  return texts.length;
}

/** headerEnd for a document's running text, with the title found as the parser finds it. */
function headerLimit(paragraphs: Element[], type: BrowserDocumentType, language: "zh" | "en"): number {
  const texts = paragraphs.map(p => paragraphText(p).trim());
  const title = texts.map((text, index) => ({ text, index })).filter(item => item.text).slice(0, 8).find(item => matchesTypeTitle(item.text, type, language));
  return headerEnd(texts, title?.index ?? -1, index => numberedParagraph(paragraphs[index]));
}

function collectListField(paragraphs: string[], key: "sponsors" | "signatories", limit = paragraphs.length) {
  for (let index = 0; index < limit; index += 1) {
    const labeled = labeledField(paragraphs[index]);
    if (labeled?.key !== key) continue;
    const values = [labeled.value];
    for (let next = index + 1; next < paragraphs.length; next += 1) {
      const continuation = paragraphs[next].trim();
      if (!continuation) continue;
      if (endsCountryList(continuation)) break;
      values.push(continuation);
    }
    return splitCountries(values.join("、"));
  }
  return [];
}

function markerLevel(text: string): number {
  const value = text.trim();
  if (/^(?:第[一二三四五六七八九十百]+条|[一二三四五六七八九十]+[、.]|\d+[.、．)])/.test(value)) return 0;
  if (/^[（(][子丑寅卯辰巳午未申酉戌亥]{2,3}[）)]/.test(value)) return 3;
  if (/^[（(][子丑寅卯辰巳午未申酉戌亥][）)]/.test(value)) return 2;
  if (/^[（(][甲乙丙丁戊己庚辛壬癸]+[）)]/.test(value)) return 3;
  if (isRomanItem(value, null)) return 2;
  if (/^[（(](?:[一二三四五六七八九十a-z]+|\d{1,2})[）)]/i.test(value)) return 1;
  if (/^[ivx]{2,}[.)]/i.test(value)) return 3;
  if (/^[a-z][.)]/i.test(value)) return 1;
  if (/^[甲乙丙丁戊己庚辛壬癸][、.]/.test(value)) return 2;
  return 0;
}

function isMetadata(text: string) {
  return labeledField(text) !== null;
}

function typeTitle(type: BrowserDocumentType, language: "zh" | "en") {
  return POLICY.titles[type][language];
}

function matchesTypeTitle(text: string, type: BrowserDocumentType, language: "zh" | "en") {
  return [typeTitle(type, language), POLICY.handbook.outputTitles[type][language]].some(title => isTitle(text, title));
}

export function parseDocxInBrowser(content: ArrayBuffer, documentType: BrowserDocumentType): BrowserModel {
  return recognize(parsePackage(content).document, documentType);
}

/** Recognition on an already parsed main document; reads it, never changes it. */
function recognize(document: Document, documentType: BrowserDocumentType): BrowserModel {
  const sourceParagraphs = flowParagraphs(document);
  const paragraphs = sourceParagraphs.map(paragraphText);
  const nonEmpty = paragraphs.map((text, index) => ({ text: text.trim(), index })).filter((item) => item.text);
  const joined = nonEmpty.map((item) => item.text).join("\n");
  const language = detectLanguage(joined);
  const expectedTitle = typeTitle(documentType, language);
  const titleItem = nonEmpty.slice(0, 8).find((item) => matchesTypeTitle(item.text, documentType, language));
  // Labels after the first body paragraph are the author's text.
  const limit = headerLimit(sourceParagraphs, documentType, language);
  const isHeaderMetadata = (item: { text: string; index: number }) => item.index < limit && isMetadata(item.text);
  const values = { committee: "", topic: "", delegate: "", country: "", sponsors: collectListField(paragraphs, "sponsors", limit), signatories: collectListField(paragraphs, "signatories", limit) };
  for (const item of nonEmpty.filter(entry => entry.index < limit)) {
    values.committee ||= field(item.text, "committee");
    values.topic ||= field(item.text, "topic");
    values.delegate ||= field(item.text, "delegate");
    values.country ||= field(item.text, "country");
  }
  const title = titleItem?.text || expectedTitle;
  const profile = POLICY.documents[documentType];
  const inferredHeaderIndices = new Set<number>();
  if (titleItem && profile.unlabeledHeaderFields?.length) {
    const firstLabeled = nonEmpty.find((item) => item.index > (titleItem?.index ?? -1) && isHeaderMetadata(item));
    // Read one contiguous header block. Never skip a name that resembles a
    // marker and take a later body heading as the missing metadata value.
    // Header lines end where the body starts (shared headerBoundary): a
    // numbered section heading is never a missing header value.
    const header = nonEmpty.filter(item => item.index > (titleItem?.index ?? -1) && item.index < limit
      && item.index < (firstLabeled?.index ?? Number.POSITIVE_INFINITY)).slice(0, profile.unlabeledHeaderFields.length);
    const candidates = header.every((item, index) => (
      item.index > (titleItem?.index ?? -1)
      && item.index < (firstLabeled?.index ?? Number.POSITIVE_INFINITY)
      && (profile.unlabeledHeaderFields![index] === "delegate" || (!ZH_MARKER.test(item.text) && !SUB_MARKER.test(item.text)))
      && item.text.length <= 80 && !/[。！？!?；;]/.test(item.text) && !/[,，]$/.test(item.text)
      && !POLICY.prefixes[language].preambulatory.some(prefix => item.text.toLowerCase().startsWith(prefix.toLowerCase()))
    )) ? header : [];
    const singleCommittee = candidates.length === 1 && firstLabeled && /(?:委员会|理事会|大会|议会|\b(?:committee|council|assembly|commission)\b)/i.test(candidates[0].text);
    if (candidates.length === profile.unlabeledHeaderFields.length || (documentType === "draft-directive" && candidates.length === 1) || singleCommittee) candidates.forEach((candidate, index) => {
      const key = profile.unlabeledHeaderFields![index];
      if (key === "sponsors" || key === "signatories") return;
      values[key] ||= candidate.text.replace(/^\s*[:：]\s*/, "").trim();
      inferredHeaderIndices.add(candidate.index);
    });
  }
  const clauses: BrowserClause[] = nonEmpty
    .filter((item) => !isHeaderMetadata(item) && item.text !== title && !inferredHeaderIndices.has(item.index))
    .map((item) => ({ text: item.text, level: hasAutomaticNumber(sourceParagraphs[item.index]) ? Number(wordAttribute(directChild(directChild(sourceParagraphs[item.index], "pPr")!, "numPr")?.getElementsByTagNameNS(WORD_NS, "ilvl")[0], "val") || 0) : markerLevel(item.text), kind: "body", paragraph_index: item.index, confidence: ZH_MARKER.test(item.text) ? 0.99 : 0.88 }));
  let preambulatory: BrowserClause[] = [];
  let operative: BrowserClause[] = [];
  let body = clauses;
  if (documentType === "draft-resolution") {
    let boundary = clauses.findIndex((item) => item.level === 0 && (ZH_MARKER.test(item.text)
      || hasAutomaticNumber(sourceParagraphs[item.paragraph_index])));
    // A missing first article is recoverable only when an action is followed by a subclause.
    const inferred = clauses.findIndex((item, index) => index < boundary && !ZH_MARKER.test(item.text)
      && POLICY.prefixes[language].operative.some(word => item.text.toLowerCase().startsWith(word.toLowerCase()))
      && clauses[index + 1]?.level === 1 && ZH_MARKER.test(clauses[index + 1].text));
    if (inferred >= 0) boundary = inferred;
    if (boundary >= 0) {
      preambulatory = clauses.slice(0, boundary).map((item) => ({ ...item, kind: "preambulatory" }));
      operative = clauses.slice(boundary).map((item) => ({ ...item, kind: "operative" }));
      body = [];
    }
  } else if (documentType === "draft-directive") {
    operative = clauses.map((item) => ({ ...item, kind: "operative" }));
    body = [];
  }
  const warnings: string[] = [];
  if (!values.committee) warnings.push("未可靠识别委员会；可在第 03 步人工确认。");
  if (!values.topic && documentType !== "draft-directive") warnings.push("未可靠识别议题；可在第 03 步人工确认。");
  if (documentType !== "position-paper" && !values.sponsors.length) warnings.push("未可靠识别起草国；可在第 03 步人工确认。");
  if (!["position-paper","working-paper"].includes(documentType) && !values.signatories.length) warnings.push("未可靠识别附议国；可在第 03 步人工确认。");
  const firstSecond = nonEmpty.findIndex((item) => /^[\s]*[（(]二[）)]/.test(item.text));
  const firstOne = nonEmpty.findIndex((item) => /^[\s]*[（(]一[）)]/.test(item.text));
  if (documentType === "position-paper" && firstSecond >= 0 && (firstOne < 0 || firstOne > firstSecond)) {
    warnings.push("检测到第二部分但缺少“（一）”；仅在能够定位第一节标题时尝试补齐，请复核结果。");
  }
  return {
    document_type: documentType, language, title, ...values,
    preambulatory_clauses: preambulatory, operative_clauses: operative, body_clauses: body,
    max_numbering_level: clauses.reduce((max, item) => Math.max(max, item.level), 0), warnings, paragraphs,
  };
}
// Shared policy embeddedSubclause (structure_repair._split_embedded_subclauses).
const SUBCLAUSE = POLICY.embeddedSubclause;
const SUBCLAUSE_MARKER = new RegExp(SUBCLAUSE.marker, "g"), FIRST_LEVEL = new RegExp(SUBCLAUSE.firstLevel);
const ARTICLE = new RegExp(SUBCLAUSE.article), CLAUSE = new RegExp(SUBCLAUSE.clause);
const UNSPLIT_NOTES = {
  context: "疑似含有合并进同一段的子条款标记，但所在段落不是条款",
  field: "含域或内容控件，其中嵌入的子条款",
  wrapper: "含链接或修订痕迹，其中嵌入的子条款",
};
/** Embedded subclauses left as written, by paragraph number in the upload. */
let unsplit: { number: number; reason: keyof typeof UNSPLIT_NOTES }[] = [];
function normalizeEmbeddedSubclauses(document: Document, documentType: BrowserDocumentType) {
  unsplit = [];
  if (!SUBCLAUSE.documentTypes.includes(documentType)) return false;
  let changed = false;
  flowParagraphs(document).forEach((original, index) => {
    let current = original, position = 0;
    while (true) {
      const text = paragraphText(current);
      SUBCLAUSE_MARKER.lastIndex = position;
      const match = SUBCLAUSE_MARKER.exec(text);
      if (!match) break;
      const marker = match[3], markerStart = match.index + match[0].length - marker.length;
      // Tabs and manual line breaks are deliberate visible structure; a later
      // marker in the same paragraph can still be flattened.
      if (/[\t\n]/.test(match[2])) { position = match.index + match[0].length; continue; }
      const keep = text.slice(0, markerStart).trimEnd().length;
      // An automatically numbered clause is a clause even though its marker is not part of the text.
      if (!CLAUSE.test(text) && !activeNumbering(current)) { unsplit.push({ number: index + 1, reason: "context" }); break; }
      if (!canCut(current)) { unsplit.push({ number: index + 1, reason: "field" }); break; }
      try {
        if (FIRST_LEVEL.test(marker) && current === original && ARTICLE.test(text)) {
          // First-level subclauses begin on a new line inside the article paragraph.
          breakLineBefore(current, keep, markerStart);
          position = keep + 1 + marker.length;
        } else {
          current = moveToNewParagraph(current, keep, markerStart);
          position = 0;
        }
        changed = true;
      } catch (reason) {
        if (!(reason instanceof Unsplittable)) throw reason;
        unsplit.push({ number: index + 1, reason: "wrapper" });
        break;
      }
    }
  });
  return changed;
}

function setRunFormat(run: Element, eastAsia: string, latin: string, sizePt: number) {
  const rPr = ensureChild(run, "rPr", true);
  const fonts = rChild(rPr, "rFonts"); // schema order (CT_RPr)
  for (const key of ["asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme", "csTheme"]) removeWordAttribute(fonts, key);
  setWordAttribute(fonts, "ascii", latin);
  setWordAttribute(fonts, "hAnsi", latin);
  setWordAttribute(fonts, "eastAsia", eastAsia);
  setWordAttribute(fonts, "cs", latin);
  setSize(rPr, sizePt);
}

function setEmphasis(run: Element, kind: "bold" | "italic" | "underline", enabled = true) {
  const names = { bold: "b", italic: "i", underline: "u" } as const;
  // Schema order (CT_RPr): appending put u after lang, which strict readers reject.
  const rPr = ensureChild(run, "rPr", true);
  setWordAttribute(rChild(rPr, names[kind]), "val", kind === "underline" ? (enabled ? "single" : "none") : (enabled ? "1" : "0"));
  if (kind !== "underline") setWordAttribute(rChild(rPr, kind === "bold" ? "bCs" : "iCs"), "val", enabled ? "1" : "0");
}

function setRunText(run: Element, text: string) {
  for (const child of Array.from(run.childNodes)) {
    if (child.nodeType !== 1 || (child as Element).localName !== "rPr") run.removeChild(child);
  }
  const textNode = run.ownerDocument.createElementNS(WORD_NS, "w:t");
  if (/^\s|\s$/.test(text)) textNode.setAttribute("xml:space", "preserve");
  textNode.textContent = text;
  run.appendChild(textNode);
}

function styleTextRange(paragraph: Element, start: number, end: number, styles: { bold?: boolean; italic?: boolean; underline?: boolean }) {
  if (end <= start) return;
  // Isolate control/drawing/field nodes before splitting text runs. Every node survives once.
  for (const run of [...elements(paragraph, "r")]) {
    const children = Array.from(run.children).filter(child => child.localName !== "rPr");
    if (children.length < 2 || children.every(child => child.namespaceURI === WORD_NS && child.localName === "t")) continue;
    for (const child of children) {
      const clone = run.cloneNode(false) as Element;
      const properties = directChild(run, "rPr");
      if (properties) clone.appendChild(properties.cloneNode(true));
      clone.appendChild(child.cloneNode(true));
      run.parentNode!.insertBefore(clone, run);
    }
    run.remove();
  }
  let offset = 0;
  for (const original of [...elements(paragraph, "r")]) {
    const text = paragraphText(original);
    const runStart = offset;
    const runEnd = offset + text.length;
    offset = runEnd;
    if (Array.from(original.children).some(child => child.namespaceURI !== WORD_NS || !["rPr", "t"].includes(child.localName))) continue;
    const overlapStart = Math.max(start, runStart);
    const overlapEnd = Math.min(end, runEnd);
    if (overlapEnd <= overlapStart || !original.parentNode) continue;
    const localStart = overlapStart - runStart;
    const localEnd = overlapEnd - runStart;
    const pieces = [text.slice(0, localStart), text.slice(localStart, localEnd), text.slice(localEnd)].filter((piece) => piece.length);
    const parent = original.parentNode;
    for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
      const piece = pieces[pieceIndex];
      const clone = original.cloneNode(true) as Element;
      setRunText(clone, piece);
      const styledPiece = (localStart === 0 ? pieceIndex === 0 : pieceIndex === 1);
      if (styledPiece) {
        if (styles.bold !== undefined) setEmphasis(clone, "bold", styles.bold);
        if (styles.italic !== undefined) setEmphasis(clone, "italic", styles.italic);
        if (styles.underline !== undefined) setEmphasis(clone, "underline", styles.underline);
      }
      parent.insertBefore(clone, original);
    }
    parent.removeChild(original);
  }
}

function isTitle(text: string, expected: string) {
  return new RegExp(`^${escapePattern(expected)}(?:\\s*(?:[\\d.．]+|\\[(?:编号|number)\\]))?(?:\\s*(?:终|最终稿|Final))?$`, "i").test(text.trim());
}

function handbookNotes(parts: Record<string, Uint8Array>, eastAsia: string) {
  for (const path of ["word/footnotes.xml", "word/endnotes.xml"]) {
    if (!parts[path]) continue;
    const notes = new DOMParser().parseFromString(decoder.decode(parts[path]), "application/xml");
    if (notes.getElementsByTagName("parsererror").length) throw new Error("脚注 XML 损坏，已中止输出。");
    const before = contentSignature(notes);
    for (const run of elements(notes, "r")) setRunFormat(run, eastAsia, "Times New Roman", POLICY.handbook.noteSizePt);
    if (contentSignature(notes) !== before) throw new Error("脚注内容校验未通过，已中止输出。");
    parts[path] = encoder.encode(new XMLSerializer().serializeToString(notes));
  }
}

/** Office theme defaults out of the font table and theme; the Song face declared
 * with its macOS name (fonts.normalize_font_parts).  The math font is kept:
 * Times New Roman has no math table. */
const FORBIDDEN_FONTS = ["Aptos Display", "Calibri Light", "Calibri", "Cambria", "Aptos"];
function normalizeFontParts(parts: Record<string, Uint8Array>, language: "zh" | "en") {
  if (parts["word/fontTable.xml"]) {
    const table = new DOMParser().parseFromString(decoder.decode(parts["word/fontTable.xml"]), "application/xml");
    if (!table.getElementsByTagName("parsererror").length) {
      const root = table.documentElement;
      for (const font of elements(table, "font")) if (FORBIDDEN_FONTS.includes(wordAttribute(font, "name") || "")) font.remove();
      if (language === "zh") {
        let font = elements(table, "font").find(node => wordAttribute(node, "name") === "SimSun");
        if (!font) { font = table.createElementNS(WORD_NS, "w:font"); setWordAttribute(font, "name", "SimSun"); root.insertBefore(font, root.firstChild); }
        setWordAttribute(ensureChild(font, "altName", true), "val", "Songti SC");
      }
      parts["word/fontTable.xml"] = encoder.encode(new XMLSerializer().serializeToString(table));
    }
  }
  if (parts["word/theme/theme1.xml"]) {
    const theme = new DOMParser().parseFromString(decoder.decode(parts["word/theme/theme1.xml"]), "application/xml");
    if (!theme.getElementsByTagName("parsererror").length) {
      for (const node of Array.from(theme.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "*"))) {
        if (FORBIDDEN_FONTS.includes(node.getAttribute("typeface") || "")) node.setAttribute("typeface", "Times New Roman");
      }
      parts["word/theme/theme1.xml"] = encoder.encode(new XMLSerializer().serializeToString(theme));
    }
  }
  if (language === "zh" && parts["word/settings.xml"]) {
    parts["word/settings.xml"] = encoder.encode(decoder.decode(parts["word/settings.xml"]).split('w:eastAsia="ja-JP"').join('w:eastAsia="zh-CN"'));
  }
}

function applyPageProfile(document: Document) {
  const page = POLICY.handbook.page;
  const sections = elements(document, "sectPr");
  if (!sections.length) sections.push(ensureChild(elements(document, "body")[0], "sectPr"));
  for (const sectPr of sections) {
  const size = ensureChild(sectPr, "pgSz");
  removeWordAttribute(size, "orient");
  setWordAttribute(size, "w", String(page.widthTwips));
  setWordAttribute(size, "h", String(page.heightTwips));
  const margins = ensureChild(sectPr, "pgMar");
  for (const [key, value] of Object.entries({
    top: page.topTwips, bottom: page.bottomTwips, left: page.leftTwips, right: page.rightTwips,
    header: page.headerTwips, footer: page.footerTwips,
  })) setWordAttribute(margins, key, String(value));
  setWordAttribute(ensureChild(sectPr, "cols"), "num", "1");
  removeChildren(sectPr, ["docGrid"]);
  }
}

function repairMissingFirstSection(document: Document, documentType: BrowserDocumentType, original: BrowserModel) {
  if (!POLICY.documents[documentType].repairs?.includes("missing-first-section")) return false;
  const paragraphs = flowParagraphs(document);
  const secondIndex = paragraphs.findIndex((p) => /^[\s]*[（(]二[）)]/.test(paragraphText(p)));
  if (secondIndex < 0) return false;
  if (paragraphs.slice(0, secondIndex).some((p) => /^[\s]*[（(]一[）)]/.test(paragraphText(p)))) return false;
  const headerValues = [original.committee, original.topic, original.country, original.delegate].filter(Boolean);
  const headerEnd = paragraphs.slice(0, 8).reduce((end, p, index) => {
    const text = paragraphText(p).trim().replace(/^[:：]\s*/, "");
    return labeledField(text) || headerValues.includes(text) ? index : end;
  }, 0);
  const target = paragraphs.slice(0, secondIndex).findLast((paragraph) => {
    const text = paragraphText(paragraph).trim();
    if (!text || text.length > 30 || /[。；;！？!?：:]$/.test(text) || labeledField(text)
      || Object.values(POLICY.titles).some(title => isTitle(text, title.zh) || isTitle(text, title.en))) return false;
    const absoluteIndex = paragraphs.indexOf(paragraph);
    if (absoluteIndex <= headerEnd) return false;
    const next = paragraphs.slice(absoluteIndex + 1).find((item) => paragraphText(item).trim());
    return Boolean(next && paragraphText(next).trim().length > 30);
  });
  if (!target) return false;
  const backup = Array.from(target.childNodes).map(node => node.cloneNode(true));
  const before = signature(target);
  const expected = `（一）${paragraphText(target).trim()}`;
  if (!editVisibleText(target, expected) || !rewriteKeepsStructure("repair", before, signature(target))) {
    for (const child of Array.from(target.childNodes)) target.removeChild(child);
    for (const child of backup) target.appendChild(child);
    return false;
  }
  return true;
}

function outputFilename(model: BrowserModel, session: string, submitting: string, version: string) {
  const country = submitting || model.country || model.sponsors[0] || "待填写国家";
  return [typeTitle(model.document_type, model.language), session, country, version || "v1"]
    .filter(Boolean).join(" ").replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "-").slice(0, 180) + ".docx";
}

// ===================================================================== format
// The browser engine mirrors backend/app/formatters (base.py + handbook_pass.py)
// step for step, reading the same shared/document-policy.json.

export class InvalidDocxError extends Error {}
export class ProtectedContentError extends Error {
  constructor(paragraphNumber: number, reason: string) { super(`第 ${paragraphNumber} 段：${reason}`); }
}
class ContentCheckError extends Error {}

type Spec = {
  pages: string; headerFields: "bold" | "label-bold"; committeeTopicLabels: "keep" | "drop"; countryLabelItalic: boolean;
  subject: { bold: boolean; italic: boolean } | null; proseFirstLinePt: number; listIndentsPt: number[][];
  topLevelVerbItalic: boolean; preambleVerbUnderline: boolean; clearClauseEmphasis: boolean; signatureLines: boolean;
  blankAfter: string[]; blankBetweenProse: boolean; blankBeforeOperative: boolean; clausePunctuation: boolean;
};
const HB = POLICY.handbook as unknown as Omit<typeof POLICY.handbook, "types"> & { types: Record<string, Record<string, Spec>> };
const LATIN = HB.fonts.latin;
const BODY_PT = HB.bodySizePt, NOTE_PT = HB.noteSizePt;
const kindOf = (type: BrowserDocumentType) => type.includes("amendment") ? "amendment" : type;
const specFor = (type: BrowserDocumentType, language: "zh" | "en") => HB.types[kindOf(type)][language];
const eastAsianFont = (type: BrowserDocumentType, language: "zh" | "en") => language !== "zh" ? HB.fonts.en : kindOf(type) === "amendment" ? HB.fonts.amendmentZh : HB.fonts.zh;
function rolePitch(type: BrowserDocumentType, language: "zh" | "en", role: "body" | "preamble" | "signature") {
  const p = HB.lineSpacing.pitchPt;
  if (language !== "zh") return p.en;
  if (role === "preamble" && type === "draft-resolution") return p.preambleZh;
  if (role === "signature" && kindOf(type) === "amendment") return p.amendmentZhSignature;
  return kindOf(type) === "amendment" ? p.amendmentZh : p.zh;
}
const TITLE_WORDS = (type: BrowserDocumentType) => [...new Set([...Object.values(POLICY.titles[type]), ...Object.values(HB.outputTitles[type])])];
const HANDBOOK_MARKER = /^\s*(?:第[一二三四五六七八九十百]+条|[0-9]+[.、．)]|[0-9]+(?=\s{2,})|[a-z][.)）](?=\s|[^\x00-\x7f])|[（(][a-zivx]+[）)]|[（(][0-9]{1,2}[）)]|[（(][一二三四五六七八九十子丑寅卯辰巳午未申酉戌亥甲乙丙丁戊己庚辛壬癸]+[）)])\s*/i;
const PP_LEVELS = [/^\s*\d+\s*[.、．)]/, /^\s*(?:[a-h]|[j-u]|[w-z])\s*[.)]/i, /^\s*[ivx]+\s*[.)]/i];
const PART = /^(?:PART\s+[IVXLC]+\b|第[一二三四五六七八九十]+部分)/i;
const BARE_ARTICLE = /^\s*第[一二三四五六七八九十百]+条\s*$/;
const ENDING_STRIP = /[，,；;。.:：、 \t]+$/;
const ENDING_PUNCTUATION = /[，,；;。.:：、]+$/;
const REFERENCE_START = /^\s*\[1\]/;
const HEADER_ROLES = ["title", "committee", "topic", "country", "delegate", "sponsors", "signatories", "header"];
const BODY_ROLES = ["preamble", "item", "prose", "reference"];
const KEEP_WITH_NEXT = [...HEADER_ROLES, "subject", "part"];
const PARAGRAPH_CLEAN = ["pStyle", "bidi", "textDirection", "shd", "pBdr", "framePr", "contextualSpacing", "snapToGrid", "tabs", "outlineLvl", "textAlignment"];
// Never what a reader sees or what it means: hidden text stays hidden and
// strikethrough stays struck (base.RUN_NOISE_TAGS).
const RUN_NOISE = ["outline", "shadow", "emboss", "imprint", "highlight", "shd", "bdr", "effect", "glow", "reflection", "spacing", "kern", "color", "rStyle", "caps", "smallCaps", "em", "fitText", "eastAsianLayout", "w", "position"];
const MARKER_NOISE = ["strike", "dstrike", "shd", "highlight", "position", "spacing", "w", "caps", "smallCaps", "color"];
const RPR_ORDER = ["rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath"];
const PPR_ORDER = ["pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl", "numPr", "suppressLineNumbers", "pBdr", "shd", "tabs", "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd", "snapToGrid", "spacing", "ind", "contextualSpacing", "mirrorIndents", "suppressOverlap", "jc", "textDirection", "textAlignment", "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr", "sectPr", "pPrChange"];
const SEQUENCES: [RegExp, (value: string) => number | null][] = [
  [/^\s*第([一二三四五六七八九十百]+)条/, chineseNumber],
  [/^\s*[（(]([子丑寅卯辰巳午未申酉戌亥])[）)]/, v => "子丑寅卯辰巳午未申酉戌亥".indexOf(v) + 1 || null],
  [/^\s*[（(]([甲乙丙丁戊己庚辛壬癸])[）)]/, v => "甲乙丙丁戊己庚辛壬癸".indexOf(v) + 1 || null],
  [/^\s*[（(]([一二三四五六七八九十]+)[）)]/, chineseNumber],
  [/^\s*[（(](\d{1,2})[）)]/, v => Number(v)],
  [/^\s*(\d{1,3})[.、．)）]/, v => Number(v)],
  [/^\s*[（(]([a-hj-uw-z])[）)]/, v => "abcdefghjklmnopqrstuwxyz".indexOf(v.toLowerCase()) + 1 || null],
  [/^\s*([a-hj-uw-z])[.)）]/, v => "abcdefghjklmnopqrstuwxyz".indexOf(v.toLowerCase()) + 1 || null],
];
const SEQUENCE_NAMES = ["article", "zodiac", "stem", "paren-chinese", "decimal", "paren-letter", "letter"];

function chineseNumber(text: string): number | null {
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text === "百") return 100;
  if (text.includes("十")) {
    const [tens, ones] = text.split("十");
    if ((tens && !(tens in digits)) || (ones && !(ones in digits))) return null;
    return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0);
  }
  return digits[text] ?? null;
}

/** ``w:<tag>`` child of a property element, created in its schema position. */
function orderedChild(parent: Element, tag: string, order: string[]): Element {
  const existing = directChild(parent, tag);
  if (existing) return existing;
  const node = parent.ownerDocument.createElementNS(WORD_NS, `w:${tag}`);
  const rank = order.indexOf(tag);
  const after = Array.from(parent.children).find(child => order.indexOf(child.localName) > rank);
  if (after) parent.insertBefore(node, after); else parent.appendChild(node);
  return node;
}
const rChild = (rPr: Element, tag: string) => orderedChild(rPr, tag, RPR_ORDER);
const pChild = (pPr: Element, tag: string) => orderedChild(pPr, tag, PPR_ORDER);
function pPrOf(paragraph: Element): Element {
  const existing = directChild(paragraph, "pPr");
  if (existing) return existing;
  const node = paragraph.ownerDocument.createElementNS(WORD_NS, "w:pPr");
  paragraph.insertBefore(node, paragraph.firstChild);
  return node;
}
function rPrOf(run: Element): Element {
  const existing = directChild(run, "rPr");
  if (existing) return existing;
  const node = run.ownerDocument.createElementNS(WORD_NS, "w:rPr");
  run.insertBefore(node, run.firstChild);
  return node;
}

function houseFonts(fonts: Element, eastAsia: string, language: "zh" | "en") {
  for (const slot of ["asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme", "csTheme"]) removeWordAttribute(fonts, slot);
  for (const slot of ["ascii", "hAnsi", "cs"]) setWordAttribute(fonts, slot, LATIN);
  setWordAttribute(fonts, "eastAsia", eastAsia);
  setWordAttribute(fonts, "hint", language === "zh" ? "eastAsia" : "default");
}

function formatRun(run: Element, ctx: Ctx, emphasis: { bold?: boolean; italic?: boolean; underline?: boolean } = {}, sizePt = BODY_PT) {
  const rPr = rPrOf(run);
  removeChildren(rPr, RUN_NOISE);
  houseFonts(rChild(rPr, "rFonts"), ctx.eastAsia, ctx.language);
  for (const tag of ["sz", "szCs"]) setWordAttribute(rChild(rPr, tag), "val", String(Math.round(sizePt * 2)));
  if (emphasis.bold !== undefined) for (const tag of ["b", "bCs"]) setWordAttribute(rChild(rPr, tag), "val", emphasis.bold ? "1" : "0");
  if (emphasis.italic !== undefined) for (const tag of ["i", "iCs"]) setWordAttribute(rChild(rPr, tag), "val", emphasis.italic ? "1" : "0");
  if (emphasis.underline !== undefined) setWordAttribute(rChild(rPr, "u"), "val", emphasis.underline ? "single" : "none");
}

/** Hiding or striking every character is damage; hiding or striking some is
 * the author's (a private note, an amendment's deletion) (base._strip_uniform_damage). */
const UNIFORM_DAMAGE = ["vanish", "webHidden", "specVanish", "strike", "dstrike"];
const HIDDEN_MARKS = ["vanish", "webHidden", "specVanish"];
/** A direct run property that is switched on (properties inherited from styles were made direct by parsePackage). */
function runHas(run: Element, tag: string) {
  const rPr = directChild(run, "rPr"), node = rPr && directChild(rPr, tag);
  return Boolean(node) && !["0", "false", "off"].includes(wordAttribute(node, "val") || "");
}
/** True when some of the paragraph's text is hidden or struck through.
 * Rebuilding such a paragraph as one new run would show hidden text and erase
 * deletion marks, so rewrites edit it in place or leave it alone. */
function carriesSemanticMarks(paragraph: Element) {
  return visibleRuns(paragraph).some(run => paragraphText(run).length > 0 && UNIFORM_DAMAGE.some(tag => runHas(run, tag)));
}
/** True when rewriting the paragraph to ``kept`` (its trailing visible part) would delete hidden or struck characters (ooxml_edit.removes_marked_text). */
function removesMarkedText(paragraph: Element, kept: string): boolean {
  const runs = visibleRuns(paragraph).map(run => [run, paragraphText(run)] as const);
  const full = runs.map(([, text]) => text).join(""), start = full.lastIndexOf(kept);
  if (start < 0) return carriesSemanticMarks(paragraph);
  const end = start + kept.length;
  let offset = 0;
  return runs.some(([run, text]) => {
    const first = offset, last = offset + text.length;
    offset = last;
    return (Math.min(last, start) > first || last > Math.max(first, end)) && UNIFORM_DAMAGE.some(tag => runHas(run, tag));
  });
}
function stripUniformDamage(document: Document, parts: Record<string, Uint8Array>): string[] {
  const on = runHas;
  const every = elements(document, "p").flatMap(p => visibleRuns(p)), runs = every.filter(run => paragraphText(run).trim());
  if (!runs.length) return [];
  const cleared = UNIFORM_DAMAGE.filter(tag => runs.every(run => on(run, tag)));
  for (const tag of cleared) for (const run of every) removeChildren(rPrOf(run), [tag]);
  // Removing direct properties alone lets a damaged Normal/docDefault style
  // immediately hide/strike the text again when Word opens the output.
  // A style only footnotes or headers use keeps it: their hidden notes are
  // not part of the damage (formatters/base._styles_applied_to_body).
  if (cleared.length && parts["word/styles.xml"]) {
    const styles = new DOMParser().parseFromString(decoder.decode(parts["word/styles.xml"]), "application/xml");
    for (const root of stylesAppliedToBody(document, styles)) for (const tag of cleared) for (const node of elements(root, tag)) node.remove();
    parts["word/styles.xml"] = encoder.encode(new XMLSerializer().serializeToString(styles));
  }
  // Told, not shown or kept silently.
  return paragraphElements(document).flatMap((p, index) => {
    const kept = visibleRuns(p).filter(run => paragraphText(run).trim());
    const hidden = kept.some(run => HIDDEN_MARKS.some(tag => on(run, tag))), struck = kept.some(run => on(run, "strike") || on(run, "dstrike"));
    if (!hidden && !struck) return [];
    const what = hidden && !struck ? "隐藏文字" : struck && !hidden ? "删除线文字" : "隐藏文字和删除线文字";
    return [`第 ${index + 1} 段含${what}，已保留原稿的显示、打印或删除标记，请确认是否需要。`];
  });
}

/** Document defaults and every style the body text can take, with the styles they are based on. */
function stylesAppliedToBody(document: Document, styles: Document): Element[] {
  const index = new Map(elements(styles, "style").map(s => [wordAttribute(s, "styleId"), s]));
  const body = elements(document, "body")[0];
  const named = new Set<string | null>(["pStyle", "rStyle", "tblStyle"].flatMap(tag => body ? elements(body, tag).map(node => wordAttribute(node, "val") || null) : []));
  for (const kind of ["character", "table"]) named.add(defaultStyleId(styles, kind));
  named.add(defaultStyleId(styles, "paragraph") || "Normal");
  const applied = new Set<Element>([...named].flatMap(id => styleChain(index, id).map(([, style]) => style)));
  return [...elements(styles, "docDefaults"), ...applied];
}

/** Runs whose text the reader sees (not deleted revisions or text boxes). */
function visibleRuns(paragraph: Element): Element[] {
  return elements(paragraph, "r").filter(run => {
    let node = run.parentElement;
    while (node && node !== paragraph) {
      if (node.namespaceURI === WORD_NS && ["del", "moveFrom", "txbxContent"].includes(node.localName)) return false;
      node = node.parentElement;
    }
    return true;
  });
}

function formatRuns(paragraph: Element, ctx: Ctx, emphasis: { bold?: boolean; italic?: boolean; underline?: boolean }) {
  for (const run of visibleRuns(paragraph)) formatRun(run, ctx, emphasis);
}

const COMPLEX_RUN_CHILDREN = new Set(["rPr", "t", "tab", "br", "cr"]);
/** A page or column break (or one that clears floats) is not a plain line break; rebuilding the run would turn it into one. */
const typedBreak = (node: Element) => node.localName === "br" && Array.from(node.attributes).some(a => a.localName !== "type" || a.value !== "textWrapping");
function hasComplexContent(paragraph: Element) {
  return Array.from(paragraph.children).some(child => child.localName !== "pPr" && (child.localName !== "r"
    || Array.from(child.children).some(node => !COMPLEX_RUN_CHILDREN.has(node.localName) || typedBreak(node))));
}

function flatteningIsLossless(paragraph: Element) {
  if (hasComplexContent(paragraph) || carriesSemanticMarks(paragraph)) return false;
  const properties = new Set<string>();
  for (const run of elements(paragraph, "r")) {
    if (!elements(run, "t").some(t => t.textContent)) continue;
    const rPr = directChild(run, "rPr");
    properties.add(rPr ? new XMLSerializer().serializeToString(rPr) : "");
    if (properties.size > 1) return false;
  }
  return true;
}

/** Visible text nodes with their offsets; tabs and breaks count one character. */
function textNodes(paragraph: Element) {
  const nodes: { node: Element; start: number; end: number }[] = [];
  let offset = 0;
  for (const run of visibleRuns(paragraph)) for (const child of Array.from(run.children)) {
    if (["tab", "br", "cr"].includes(child.localName)) { offset += 1; continue; }
    if (child.localName !== "t") continue;
    const text = child.textContent || "";
    if (text) { nodes.push({ node: child, start: offset, end: offset + text.length }); offset += text.length; }
  }
  return nodes;
}

/** Change visible text in place, touching only the text nodes that change. */
function editVisibleText(paragraph: Element, next: string): boolean {
  const old = paragraphText(paragraph);
  if (old === next) return true;
  const nodes = textNodes(paragraph);
  if (!nodes.length) return false;
  const limit = Math.min(old.length, next.length);
  let prefix = 0; while (prefix < limit && old[prefix] === next[prefix]) prefix++;
  let suffix = 0; while (suffix < limit - prefix && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  const start = prefix, end = old.length - suffix, replacement = next.slice(prefix, next.length - suffix);
  const targets: { node: Element; start: number }[] = [];
  let covered = 0;
  for (const item of nodes) {
    const overlap = Math.min(end, item.end) - Math.max(start, item.start);
    if (overlap > 0) { covered += overlap; targets.push(item); }
    else if (start === end && item.start <= start && start <= item.end && !targets.length) targets.push(item);
  }
  if (covered !== end - start || !targets.length) return false;
  let written = false;
  for (const target of targets) {
    const text = target.node.textContent || "";
    const localStart = Math.min(Math.max(start - target.start, 0), text.length);
    const localEnd = Math.min(Math.max(end - target.start, 0), text.length);
    const updated = text.slice(0, localStart) + (written ? "" : replacement) + text.slice(localEnd);
    written = true;
    target.node.textContent = updated;
    if (/^\s|\s$/.test(updated)) target.node.setAttribute("xml:space", "preserve");
  }
  return paragraphText(paragraph) === next;
}

function appendRun(paragraph: Element, text: string): Element {
  const run = paragraph.ownerDocument.createElementNS(WORD_NS, "w:r");
  // Tabs and line breaks are elements, as python-docx's add_run writes them.
  const parts = text.split(/([\t\n])/);
  parts.forEach(part => {
    if (part === "\t" || part === "\n") { run.appendChild(paragraph.ownerDocument.createElementNS(WORD_NS, part === "\t" ? "w:tab" : "w:br")); return; }
    if (!part) return;
    const node = paragraph.ownerDocument.createElementNS(WORD_NS, "w:t");
    if (/^\s|\s$/.test(part)) node.setAttribute("xml:space", "preserve");
    node.textContent = part;
    run.appendChild(node);
  });
  paragraph.appendChild(run);
  return run;
}

function clearParagraph(paragraph: Element) {
  for (const child of Array.from(paragraph.childNodes)) if (child.nodeType !== 1 || (child as Element).localName !== "pPr") paragraph.removeChild(child);
}

type Block = { p: Element; role: string; level: number; group: string; operative: boolean };
type Ctx = {
  document: Document; parts: Record<string, Uint8Array>; model: BrowserModel; recognized: BrowserModel; original: BrowserModel;
  type: BrowserDocumentType; language: "zh" | "en"; spec: Spec; eastAsia: string;
  normalizePunctuation: boolean; preserveCountryOrder: boolean; changed: Set<string>;
  editLog: Map<Element, Edit>; source: Element[]; warnings: string[]; protectedNotes: string[]; countryChanges: string[];
  /** Flow-paragraph index of the first body paragraph (see headerEnd). */
  headerEnd: number;
};

const attached = (b: Block) => Boolean(b.p.parentNode);
const sourceNumber = (ctx: Ctx, p: Element) => ctx.source.indexOf(p) + 1;

function logEdit(ctx: Ctx, p: Element, kind: string, key = "", expected: string | null = null, created = false) {
  const previous = ctx.editLog.get(p);
  if (kind === "label-restore" && previous?.kind === "country-name") kind = "country-name";
  ctx.editLog.set(p, { kind, key, expected, created: created || Boolean(previous?.created),
    country: kind === "countries" || kind === "country-name" ? { language: ctx.language, preserveOrder: ctx.preserveCountryOrder, manual: ctx.changed.has(key as MetadataKey) } : undefined });
}

function protect(ctx: Ctx, p: Element, reason: string) {
  ctx.protectedNotes.push(`第 ${sourceNumber(ctx, p) || "?"} 段：${reason}。`);
}

/** Rewrite text without destroying content: flatten only when lossless, else edit in place. */
function setText(ctx: Ctx, p: Element, text: string): boolean {
  if (paragraphText(p) === text) return true;
  if (flatteningIsLossless(p)) {
    clearParagraph(p);
    formatRun(appendRun(p, text), ctx, { bold: false, italic: false, underline: false });
    return true;
  }
  if (editVisibleText(p, text)) return true;
  protect(ctx, p, "该段包含图片、域或复杂结构，已保留原样未改写");
  return false;
}

/** An allowed edit, recorded with its exact result where it has one (see content-guard.ts). */
function rewriteLogged(ctx: Ctx, p: Element, text: string, kind: string, key = ""): boolean {
  if (paragraphText(p) === text) return true;
  const previous = ctx.editLog.get(p);
  const backup = Array.from(p.childNodes).map(node => node.cloneNode(true));
  const before = signature(p), marks = paragraphMarks(p);
  const restore = (reason: string) => {
    // Restore in place (the element keeps its identity for the content check).
    for (const child of Array.from(p.childNodes)) p.removeChild(child);
    for (const child of backup) p.appendChild(child);
    protect(ctx, p, reason);
    return false;
  };
  const written = setText(ctx, p, text);
  const exact = paragraphText(p) === text;
  if (written && (!exact || !rewriteKeepsStructure(kind, before, signature(p)))) return restore("改写会改变该段中的链接、域、书签或修订结构，已保留原样");
  // Any automatic rewrite (title word, label, marker, ending) that would delete
  // hidden or struck characters, or drop their mark, is undone here, for this
  // paragraph only; the final guard stays strict.
  if (written && !marksKept(marks, p)) return restore("改写会删除隐藏或删除线文字或去掉其标记，已保留原样");
  if (!exact) return false;
  let expected: string | null = ["label-restore", "field"].includes(kind) ? text : null;
  if (previous?.kind === "field" && ["label-drop", "title"].includes(kind)) { kind = "field"; key = previous.key || ""; expected = text; }
  logEdit(ctx, p, kind, key, expected);
  return true;
}

// -------------------------------------------------------------- page & styles

function configurePage(document: Document) {
  applyPageProfile(document);
  for (const sectPr of elements(document, "sectPr")) {
    removeChildren(sectPr, ["cols", "lnNumType", "pgBorders", "docGrid"]);
    setWordAttribute(ensureChild(sectPr, "pgMar"), "gutter", "0");
  }
}

function configureStyles(parts: Record<string, Uint8Array>, ctx: Ctx) {
  if (!parts["word/styles.xml"]) return;
  const styles = new DOMParser().parseFromString(decoder.decode(parts["word/styles.xml"]), "application/xml");
  if (styles.getElementsByTagName("parsererror").length) throw new InvalidDocxError("DOCX 样式 XML 损坏。");
  const defaults = elements(styles, "docDefaults")[0];
  if (defaults) {
    for (const node of elements(defaults, "pPrDefault")) node.remove();
    for (const holder of elements(defaults, "rPrDefault")) houseFonts(rChild(ensureChild(holder, "rPr"), "rFonts"), ctx.eastAsia, ctx.language);
  }
  for (const style of elements(styles, "style")) {
    const id = wordAttribute(style, "styleId") || "", name = wordAttribute(directChild(style, "name"), "val") || "";
    const isNormal = id === "Normal" || (wordAttribute(style, "type") === "paragraph" && wordAttribute(style, "default") === "1");
    const note = /^(footnote|endnote) text$/i.test(name);
    if (!isNormal && !note && !["Title", "Subtitle", "Heading1", "Heading2", "Heading3"].includes(id)) continue;
    const rPr = ensureChild(style, "rPr");
    removeChildren(rPr, ["color"]);
    houseFonts(rChild(rPr, "rFonts"), ctx.eastAsia, ctx.language);
    for (const tag of ["sz", "szCs"]) setWordAttribute(rChild(rPr, tag), "val", String(Math.round((note ? NOTE_PT : BODY_PT) * 2)));
    if (isNormal) {
      for (const tag of ["b", "bCs", "i", "iCs"]) setWordAttribute(rChild(rPr, tag), "val", "0");
      setWordAttribute(rChild(rPr, "u"), "val", "none");
      const pPr = ensureChild(style, "pPr", true);
      const spacing = pChild(pPr, "spacing");
      for (const [name, value] of Object.entries({ before: "0", after: "0", line: "240", lineRule: "auto" })) setWordAttribute(spacing, name, value);
    }
  }
  parts["word/styles.xml"] = encoder.encode(new XMLSerializer().serializeToString(styles));
}

// ------------------------------------------------------------------- metadata

function labelValueText(key: MetadataKey, value: string, language: "zh" | "en") {
  const label = POLICY.metadata[key].output[language];
  return language === "en" ? `${label}: ${value}` : `${label}：${value}`;
}

function countryOrder(ctx: Ctx, values: string[]) {
  return planCountries(values, ctx.language, ctx.preserveCountryOrder).values;
}

function recordCountryNames(ctx: Ctx, p: Element, key: string, values: string[]) {
  const plan = planCountries(values, ctx.language, true);
  for (const item of plan.resolutions.filter(item => item.changed)) ctx.countryChanges.push(`第 ${sourceNumber(ctx, p)} 段 ${key}：国家名称“${item.input}” → “${item.display}”（${item.id}；UNTERM 核对 ${COUNTRY_DATA_DATE}）。`);
  if (plan.removedDuplicates) ctx.countryChanges.push(`第 ${sourceNumber(ctx, p)} 段 ${key}：按国家标识去重 ${plan.removedDuplicates} 项（不合并未知或歧义名称）。`);
}

function scalarCountry(ctx: Ctx, p: Element, labeled: boolean) {
  const resolution = resolveCountry(ctx.model.country, ctx.language);
  const target = labeled ? labelValueText("country", resolution.display, ctx.language) : resolution.display;
  if (!ctx.changed.has("country") && (!resolution.changed && (!labeled || resolution.status !== "resolved" || paragraphText(p) === target))) return;
  const reason = fieldProtectionReason(p);
  if (reason) {
    if (ctx.changed.has("country")) throw new ProtectedContentError(sourceNumber(ctx, p), `第 03 步修改的国家字段${reason}，不能安全改写`);
    protect(ctx, p, `国家字段${reason}，未自动展开全称`); return;
  }
  if (setText(ctx, p, target)) {
    logEdit(ctx, p, ctx.changed.has("country") ? "field" : "country-name", "country", target);
    recordCountryNames(ctx, p, "country", [ctx.model.country]);
    if (labeled) ctx.countryChanges.push(`第 ${sourceNumber(ctx, p)} 段 country：按共用字段策略统一国家标签与分隔符。`);
  }
}

function formatMetadata(ctx: Ctx, paragraphs: Element[]) {
  const texts = paragraphs.map(p => paragraphText(p).trim());
  const repeated = new Set(["country", "sponsors", "signatories"].filter(key => texts.slice(0, ctx.headerEnd).filter(text => labeledField(text)?.key === key).length > 1));
  // Step-03 values for header lines printed without a label.
  for (const key of ["committee", "topic", "country", "delegate"] as const) {
    if ((key !== "country" && !ctx.changed.has(key)) || !ctx.original[key]) continue;
    // Only an unlabeled header line: a labeled one is rewritten below, and a
    // body paragraph that happens to repeat the old value is the author's text.
    if (texts.some((text, i) => i < ctx.headerEnd && labeledField(text)?.key === key)) continue;
    const index = texts.findIndex((text, i) => i < ctx.headerEnd && !labeledField(text) && text === ctx.original[key]);
    if (index < 0) continue;
    if (key === "country") { scalarCountry(ctx, paragraphs[index], false); continue; }
    const reason = fieldProtectionReason(paragraphs[index]);
    if (reason) throw new ProtectedContentError(index + 1, `第 03 步修改了${POLICY.metadata[key].output[ctx.language]}，但该段${reason}，不能安全改写`);
    if (setText(ctx, paragraphs[index], ctx.model[key])) logEdit(ctx, paragraphs[index], "field", key, ctx.model[key]);
  }
  restoreMissingLabels(ctx, paragraphs, texts);
  // Only the header: a body paragraph that starts like "议题：" is the author's text.
  for (let index = 0; index < Math.min(paragraphs.length, ctx.headerEnd); index++) {
    const labeled = labeledField(texts[index]);
    if (!labeled) continue;
    const p = paragraphs[index];
    if (repeated.has(labeled.key)) {
      if (ctx.changed.has(labeled.key)) throw new ProtectedContentError(index + 1, "页首存在多个同名国家字段，不能确定第 03 步修改的目标，请先在原稿中确认");
      protect(ctx, p, "页首存在多个同名国家字段，未自动展开或合并，请人工确认"); continue;
    }
    if (labeled.key === "sponsors" || labeled.key === "signatories") {
      const continuations: Element[] = [];
      for (let next = index + 1; next < paragraphs.length; next++) {
        if (!texts[next]) continue;
        if (endsCountryList(texts[next])) break;
        continuations.push(paragraphs[next]);
      }
      formatCountryField(ctx, p, continuations, labeled.key);
    } else if (labeled.key === "country") {
      scalarCountry(ctx, p, true);
    } else if (ctx.changed.has(labeled.key)) {
      const reason = fieldProtectionReason(p);
      if (reason) throw new ProtectedContentError(index + 1, `第 03 步修改的元数据段${reason}，不能安全改写`);
      const target = labelValueText(labeled.key, ctx.model[labeled.key] as string, ctx.language);
      clearParagraph(p);
      formatRun(appendRun(p, target), ctx, { bold: false, italic: false, underline: false });
      logEdit(ctx, p, "field", labeled.key, target);
    }
  }
}

function restoreMissingLabels(ctx: Ctx, paragraphs: Element[], texts: string[]) {
  const profile = POLICY.documents[ctx.type];
  if (!profile.restoreMissingHeaderLabels) return;
  const titleIndex = texts.findIndex(text => TITLE_WORDS(ctx.type).some(word => isTitle(text, word)));
  if (titleIndex < 0) return;
  const candidates = texts.map((text, index) => ({ text, index })).filter(item => item.index > titleIndex && item.index < ctx.headerEnd && item.text && !labeledField(item.text));
  ((profile.unlabeledHeaderFields || []) as MetadataKey[]).forEach((key, position) => {
    const item = candidates[position];
    if (!item || key === "sponsors" || key === "signatories") return;
    const value = key === "country" ? resolveCountry(ctx.model.country, ctx.language).display : ctx.recognized[key] as string;
    if (!value || paragraphText(paragraphs[item.index]).replace(/^\s*[:：]\s*/, "").trim() !== value) return;
    const target = labelValueText(key, value, ctx.language);
    rewriteLogged(ctx, paragraphs[item.index], target, "label-restore", key);
  });
}

function countryLineText(key: "sponsors" | "signatories", values: string[], language: "zh" | "en") {
  const label = POLICY.metadata[key].output[language];
  return (language === "en" ? `${label}: ` : `${label}：`) + values.join(HB.signatureLines.separator[language]);
}

function formatCountryField(ctx: Ctx, p: Element, continuations: Element[], key: "sponsors" | "signatories") {
  const source = ctx.changed.has(key) ? ctx.model[key] : ctx.recognized[key];
  const values = countryOrder(ctx, source);
  const reordered = values.length !== source.length || values.some((value, index) => value !== source[index]);
  const expected = countryLineText(key, values, ctx.language);
  const differs = values.length > 0 && (ctx.normalizePunctuation || reordered) && (
    reordered || continuations.some(c => paragraphText(c).trim()) || paragraphText(p).trim() !== expected.trim());
  if (ctx.changed.has(key) || differs) {
    const complexPart = [p, ...continuations].find(part => fieldProtectionReason(part));
    if (!complexPart) {
      clearParagraph(p);
      appendRun(p, expected);
      logEdit(ctx, p, "countries", key, expected);
      for (const c of continuations) { clearParagraph(c); logEdit(ctx, c, "countries", key, expected); }
      styleCountryLine(ctx, p, true);
      recordCountryNames(ctx, p, key, source);
      return;
    }
    const reason = fieldProtectionReason(complexPart);
    if (ctx.changed.has(key)) throw new ProtectedContentError(sourceNumber(ctx, complexPart), `第 03 步修改了国家名单，但${reason}，不能安全改写`);
    protect(ctx, complexPart, `国家列表${reason}，未重写`);
  }
  styleCountryLine(ctx, p, true);
  for (const c of continuations) formatRuns(c, ctx, { bold: true, italic: true, underline: false });
}

function fieldProtectionReason(p: Element): string | null {
  if (carriesSemanticMarks(p)) return "含隐藏或删除线文字";
  if (hasComplexContent(p)) return "含图片、链接、域、书签或修订结构";
  return isPlainField(signature(p)) ? null : "含分页符、分栏符或其他不能作为普通分隔符的记号";
}

function styleCountryLine(ctx: Ctx, p: Element, labeled: boolean) {
  const text = paragraphText(p);
  const match = labeled ? text.match(/^(\s*[^:：]{1,20}[:：]\s*)/) : null;
  formatRuns(p, ctx, {});
  if (!match) { formatRuns(p, ctx, { bold: true, italic: true, underline: false }); return; }
  // The label run includes the space after the colon (as in the Python engine).
  styleTextRange(p, 0, match[1].length, { bold: true, italic: ctx.spec.countryLabelItalic, underline: false });
  styleTextRange(p, match[1].length, text.length, { bold: true, italic: true, underline: false });
}

// ---------------------------------------------------------------- repair

const LIST_ITEM_END = /[；;。.]$/;

/** Layout cannot prove a missing number. Adding membership shifts existing references. */
function suspectedMissingListItems(document: Document, type: BrowserDocumentType): number[] {
  if (!["draft-resolution", "working-paper"].includes(type)) return [];
  const paragraphs = flowParagraphs(document);
  const nonempty = paragraphs.map((p, index) => ({ p, index })).filter(item => paragraphText(item.p).trim()).map(item => item.index);
  const suspects: number[] = [];
  for (let position = 1; position < nonempty.length - 1; position++) {
    const p = paragraphs[nonempty[position]], text = paragraphText(p).trim();
    if (activeNumbering(p) || HANDBOOK_MARKER.test(text) || !LIST_ITEM_END.test(text)) continue;
    if (!/[：:]$/.test(paragraphText(paragraphs[nonempty[position - 1]]).trim())) continue;
    const following = paragraphs[nonempty[position + 1]], list = activeNumbering(following);
    if (!list) continue;
    const level = Number(list.ilvl);
    const earlier = paragraphs.slice(0, nonempty[position]).reverse().find(q => activeNumbering(q)?.numId === list.numId);
    if (earlier && Number(activeNumbering(earlier)!.ilvl) >= level) continue;
    suspects.push(nonempty[position] + 1);
  }
  return suspects;
}

// -------------------------------------------------------------- position paper

function positionPaperMarkers(ctx: Ctx, paragraphs: Element[], bodyStart: number) {
  for (const p of paragraphs.slice(bodyStart)) {
    const text = paragraphText(p).trim();
    const match = text.match(/^\s*(\d+)[.、)]\s*(?:\t\s*)?([\s\S]*)$/);
    if (!match) continue;
    if (activeNumbering(p)) { protect(ctx, p, "该段同时含手动标记和原生编号，已保留原条号，请人工确认"); continue; }
    const expected = `${match[1]}${ctx.language === "zh" ? "、" : "."}\t${match[2]}`;
    if (paragraphText(p) !== expected) rewriteLogged(ctx, p, expected, "marker");
  }
  const texts = paragraphs.map(p => paragraphText(p));
  const start = texts.findIndex((text, index) => index >= bodyStart && REFERENCE_START.test(text));
  if (start < 0) return;
  for (const p of paragraphs.slice(start)) for (const run of visibleRuns(p)) formatRun(run, ctx, { bold: false, italic: false }, NOTE_PT);
}

// ------------------------------------------------------------------- roles

function numberingIndex(parts: Record<string, Uint8Array>) {
  const levels = new Map<string, { fmt: string; text: string }>();
  if (!parts["word/numbering.xml"]) return levels;
  const numbering = new DOMParser().parseFromString(decoder.decode(parts["word/numbering.xml"]), "application/xml");
  const abstracts = new Map(elements(numbering, "abstractNum").map(a => [wordAttribute(a, "abstractNumId") || "", a]));
  for (const num of elements(numbering, "num")) {
    const abstract = abstracts.get(wordAttribute(directChild(num, "abstractNumId"), "val") || "");
    if (!abstract) continue;
    for (const lvl of elements(abstract, "lvl")) levels.set(`${wordAttribute(num, "numId")}:${wordAttribute(lvl, "ilvl")}`, {
      fmt: wordAttribute(directChild(lvl, "numFmt"), "val") || "", text: wordAttribute(directChild(lvl, "lvlText"), "val") || "" });
  }
  return levels;
}

function activeNumbering(p: Element): { numId: string; ilvl: string } | null {
  const numPr = directChild(pPrOf(p), "numPr");
  const numId = numPr && wordAttribute(directChild(numPr, "numId"), "val");
  if (!numPr || !numId || numId === "0") return null;
  return { numId, ilvl: wordAttribute(directChild(numPr, "ilvl"), "val") || "0" };
}

/** Handbook level of a paragraph (mirrors parser.infer_level). */
/** (left, hanging) in twips of each handbook list level (parser.handbook_list_indents). */
const listIndentsOf = (spec: Spec) => spec.listIndentsPt.map(([left, hanging]) => [Math.round(left * 20), Math.round(hanging * 20)]);

/** The letters of a parenthesized marker ("（c）" → "c"), or null (parser.paren_token). */
const parenToken = (text: string) => /^\s*[（(]([a-z]{1,4})[）)]/i.exec(text)?.[1].toLowerCase() ?? null;
const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
function romanValue(token: string): number | null {
  if (!token || [...token].some(ch => !(ch in ROMAN))) return null;
  return [...token].reduce((total, ch, index) => total + (ROMAN[ch] < (ROMAN[token[index + 1]] ?? 0) ? -ROMAN[ch] : ROMAN[ch]), 0);
}
/** "(c)" after "(b)" is a letter, "(v)" after "(iv)" a numeral (parser.is_roman_item). */
function isRomanItem(text: string, previousToken: string | null) {
  const token = parenToken(text);
  if (token === null || romanValue(token) === null) return false;
  if (token.length > 1) return true;
  if (token === "i") return previousToken !== "h";
  const previous = romanValue(previousToken ?? "");
  return previous !== null && previous + 1 === romanValue(token);
}

/** "（1）" items: one level under the item that introduces them (parser.PAREN_DIGIT_RE). */
const PAREN_DIGIT = /^\s*[（(]\d{1,2}[）)]/;

/** A list context for the next paragraph: an item, or a clause that introduces items. */
function opensOrContinuesList(text: string, p: Element, level: number) {
  return level > 0 || activeNumbering(p) !== null || parenToken(text) !== null || PAREN_DIGIT.test(text) || LEVEL_MARKERS.some(([pattern]) => pattern.test(text)) || /[：:]$/.test(text);
}

const LEVEL_MARKERS: [RegExp, number][] = [
  [/^\s*(?:第[一二三四五六七八九十百]+条|\d+[.、．])/, 0], [/^\s*[（(](?:[a-z]|[一二三四五六七八九十]+)[）)]/i, 1],
  [/^\s*[a-hj-uw-z][.)）]/i, 1], [/^\s*[（(][子丑寅卯辰巳午未申酉戌亥]{2,3}[）)]/, 3], [/^\s*[（(][子丑寅卯辰巳午未申酉戌亥][）)]/, 2],
  [/^\s*(?:[ivxlcdm]+\.|[（(][甲乙丙丁戊己庚辛壬癸]+[）)])/i, 3],
];

function inferLevel(text: string, p: Element, previous: number, numbering: Map<string, { fmt: string; text: string }>, inList = true, indents: number[][] = [], previousToken: string | null = null, previousParenDigit = false): number {
  if (isRomanItem(text, previousToken)) return previous >= 1 ? 2 : 1;
  if (PAREN_DIGIT.test(text)) return previousParenDigit ? previous : inList ? Math.min(3, previous + 1) : 0;
  for (const [pattern, level] of LEVEL_MARKERS) if (pattern.test(text)) return level;
  const active = activeNumbering(p);
  if (active) {
    const level = numbering.get(`${active.numId}:${active.ilvl}`);
    if (level) {
      if (level.fmt === "ideographZodiac") return 2;
      if (level.fmt === "ideographTraditional") return 3;
      if (level.fmt === "lowerRoman") return /^[（(]/.test(level.text) ? 2 : 3;
      if (level.text.includes("第%") && level.text.includes("条")) return 0;
      if (/^[（(]%/.test(level.text)) return 1;
    }
    return Number(active.ilvl) || 0;
  }
  const ind = directChild(pPrOf(p), "ind");
  const left = Number(wordAttribute(ind, "left") || wordAttribute(ind, "start") || 0), hanging = Number(wordAttribute(ind, "hanging") || 0);
  // Indentation nests only inside a list (parser.infer_level).
  if (!inList) return 0;
  // The handbook's own list indent for a level reads back as that level, so a
  // second pass changes nothing (the inches rule read 42 pt as level 2).
  const own = indents.findIndex(([listLeft, listHanging], level) => level > 0 && left === listLeft && hanging === listHanging);
  if (own > 0) return own;
  // An indent beyond the damage threshold (96 pt) is noise, not nesting.
  return left > 0 && left <= 96 * 20 ? Math.min(3, Math.max(0, Math.round(left / 1440 / 0.3))) : 0;
}

/** "The Security Council," and "Security Council" name the same organ (parser._organ_name). */
const organName = (value: string) => value.trim().replace(/[，,]+$/, "").trim().replace(/^(?:the\s+|联合国)/i, "").toLowerCase();
const SUBJECT_LINES = POLICY.subjectLine.patterns.map(pattern => new RegExp(`^(?:${pattern})$`));
const CLAUSE_WORDS = (["zh", "en"] as const).flatMap(language => [...POLICY.prefixes[language].preambulatory, ...POLICY.prefixes[language].operative]).map(word => word.toLowerCase());

/** A body named before the clauses even when the committee field is written
 * differently (shared policy subjectLine; parser.is_subject_line). */
function isSubjectLine(text: string) {
  const lower = text.toLowerCase();
  return !CLAUSE_WORDS.some(word => lower.startsWith(word)) && SUBJECT_LINES.some(pattern => pattern.test(text));
}

function isCommitteeSubject(text: string, committee: string) {
  const clean = text.replace(/[，,]+$/, "").trim().toLowerCase();
  if (committee && organName(clean) === organName(committee)) return true;
  if (["联合国大会", "the committee", "the general assembly"].includes(clean)) return true;
  return /^The [A-Z][A-Z\s]*,$/.test(text.trim()) || isSubjectLine(text.trim());
}

function handbookBlocks(ctx: Ctx, paragraphs: Element[], numbering: Map<string, { fmt: string; text: string }>): Block[] {
  const texts = paragraphs.map(p => paragraphText(p).trim());
  const roles = new Map<number, Block>();
  const assign = (index: number | undefined, role: string, extra: Partial<Block> = {}) => {
    if (index === undefined || index < 0 || index >= paragraphs.length || !texts[index]) return;
    roles.set(index, { p: paragraphs[index], role, level: 0, group: "", operative: false, ...extra });
  };
  const titleWords = TITLE_WORDS(ctx.type);
  const title = texts.slice(0, 40).findIndex(text => text && (text === ctx.model.title || titleWords.some(word => isTitle(text, word))));
  if (title >= 0) assign(title, "title");
  for (let index = 0; index < Math.min(texts.length, ctx.headerEnd); index++) {
    const labeled = labeledField(texts[index]);
    if (!labeled) continue;
    if (labeled.key === "sponsors" || labeled.key === "signatories") {
      assign(index, labeled.key, { group: labeled.key });
      for (let next = index + 1; next < texts.length; next++) {
        if (!texts[next]) continue;
        if (endsCountryList(texts[next])) break;
        assign(next, "header", { group: labeled.key });
      }
    } else if (!roles.has(index)) assign(index, labeled.key);
  }
  if (title >= 0) {
    const fieldIndices = [...roles.entries()].filter(([, b]) => b.role !== "title").map(([i]) => i);
    const firstField = fieldIndices.length ? Math.min(...fieldIndices) : title + 1;
    const used = new Set([...roles.values()].map(b => b.role));
    const free = ["committee", "topic"].filter(key => !used.has(key));
    const preamble = POLICY.prefixes[ctx.language].preambulatory;
    for (let index = title + 1; index < firstField && free.length; index++) {
      const text = texts[index];
      if (!text || roles.has(index) || HANDBOOK_MARKER.test(text) || text.length > 80 || /[。！？!?；;]/.test(text) || /[,，]$/.test(text)
        || preamble.some(word => text.toLowerCase().startsWith(word.toLowerCase()))) continue;
      assign(index, free.shift()!);
    }
  }
  const headerEnd = Math.max(-1, ...roles.keys()) + 1;
  const operativeType = ["draft-directive", "draft-resolution"].includes(ctx.type) || ctx.type.includes("amendment");
  if (ctx.type === "position-paper") {
    const start = texts.findIndex((text, index) => index >= headerEnd && REFERENCE_START.test(text));
    if (start >= 0) for (let index = start; index < texts.length; index++) assign(index, "reference");
  }
  const preambleIndices = new Set(ctx.recognized.preambulatory_clauses.map(c => c.paragraph_index));
  let previous = 0, inList = false, previousToken: string | null = null, previousParenDigit = false;
  const indents = listIndentsOf(ctx.spec);
  for (let index = 0; index < texts.length; index++) {
    const p = paragraphs[index], text = texts[index];
    if (!text && !roles.has(index)) { if (carriesHiddenStructure(p)) roles.set(index, { p, role: "object", level: 0, group: "", operative: false }); continue; }
    if (!text) continue;
    if (roles.has(index)) { inList = roles.get(index)!.role === "item" || /[：:]$/.test(text); previousToken = parenToken(text) ?? previousToken; previousParenDigit = PAREN_DIGIT.test(text); continue; }
    if (index < headerEnd) { assign(index, "header"); continue; }
    const placed = PART.test(text) ? "part" : ctx.spec.subject && isCommitteeSubject(text, ctx.model.committee) ? "subject"
      : ctx.type === "draft-resolution" && preambleIndices.has(index) ? "preamble" : "";
    if (placed) { assign(index, placed); inList = /[：:]$/.test(text); continue; }
    if (ctx.type === "position-paper") {
      const level = PP_LEVELS.findIndex(pattern => pattern.test(text));
      assign(index, level < 0 ? "prose" : "item", { level: Math.max(level, 0) });
      inList = level >= 0 || /[：:]$/.test(text);
      continue;
    }
    previous = inferLevel(text, p, previous, numbering, inList, indents, previousToken, previousParenDigit);
    inList = opensOrContinuesList(text, p, previous);
    previousToken = parenToken(text) ?? previousToken;
    previousParenDigit = PAREN_DIGIT.test(text);
    const isItem = previous > 0 || activeNumbering(p) !== null || HANDBOOK_MARKER.test(text);
    assign(index, isItem ? "item" : "prose", { level: previous, operative: operativeType && (isItem || ctx.type !== "working-paper") });
  }
  nestUnmarkedItems(roles, texts);
  return [...roles.keys()].sort((a, b) => a - b).map(index => roles.get(index)!);
}

function nestUnmarkedItems(roles: Map<number, Block>, texts: string[]) {
  const listLevels = new Map<string, number>();
  let parentLevel: number | null = null, parentKey: string | null = null;
  for (const index of [...roles.keys()].sort((a, b) => a - b)) {
    const block = roles.get(index)!;
    if (block.role !== "item") { parentLevel = null; parentKey = null; continue; }
    const active = activeNumbering(block.p);
    const key = active ? `${active.numId}:${active.ilvl}` : null;
    if (active && !HANDBOOK_MARKER.test(texts[index])) {
      if (listLevels.has(key!)) block.level = listLevels.get(key!)!;
      // The next item of the clause's own list and level is its sibling, not
      // its subclause: a colon alone does not prove the subclauses exist.
      else if (parentLevel !== null && key !== parentKey) { block.level = parentLevel + 1; listLevels.set(key!, block.level); }
    }
    const opens = /[：:]$/.test(texts[index]);
    parentLevel = opens ? block.level : null;
    parentKey = opens ? key : null;
  }
}

const INLINE_OBJECTS = new Set(["drawing", "pict", "object", "txbxContent", "oMath", "oMathPara"]);
function holdsInlineObject(p: Element) {
  return Array.from(p.getElementsByTagName("*")).some(node => INLINE_OBJECTS.has(node.localName));
}

function carriesHiddenStructure(p: Element) {
  const pPr = directChild(p, "pPr");
  if (pPr && directChild(pPr, "sectPr")) return true;
  const inline = new Set(["drawing", "pict", "object", "hyperlink", "footnoteReference", "endnoteReference", "commentReference", "fldSimple", "instrText", "bookmarkStart", "ins", "del"]);
  return Array.from(p.getElementsByTagName("*")).some(node => node.namespaceURI === WORD_NS && (inline.has(node.localName)
    || (node.localName === "br" && ["page", "column"].includes(wordAttribute(node, "type") || ""))));
}

// ---------------------------------------------------------------- the pass

function headerText(ctx: Ctx, blocks: Block[]) {
  for (const block of blocks) {
    const text = paragraphText(block.p).trim();
    if (block.role === "title") {
      const source = ctx.changed.has("title") ? ctx.model.title : text;
      const word = [...TITLE_WORDS(ctx.type)].sort((a, b) => b.length - a.length).find(w => isTitle(source, w) && source.trim().toLowerCase().startsWith(w.toLowerCase()));
      if (!word) continue;
      const target = HB.outputTitles[ctx.type][ctx.language] + source.trim().slice(word.length);
      if (target === text) continue;
      if (!ctx.changed.has("title")) rewriteLogged(ctx, block.p, target, "title");
      else if (!rewriteLogged(ctx, block.p, target, "field", "title"))
        throw new ProtectedContentError(sourceNumber(ctx, block.p), "第 03 步修改了标题，但标题含链接、域、修订、隐藏或删除线文字，不能安全改写");
    } else if ((block.role === "committee" || block.role === "topic") && ctx.spec.committeeTopicLabels === "drop") {
      const labeled = labeledField(text);
      if (labeled && (labeled.key === "committee" || labeled.key === "topic") && labeled.value) {
        // Dropping the label would delete hidden or struck words.
        if (removesMarkedText(block.p, labeled.value)) protect(ctx, block.p, "委员会/议题标签含隐藏或删除线文字，未按范例删除标签");
        else rewriteLogged(ctx, block.p, labeled.value, "label-drop");
      }
    }
  }
}

function endingInRevision(p: Element) {
  const texts = elements(p, "t").filter(t => t.textContent);
  for (const node of texts.reverse()) {
    let ancestor = node.parentElement, inRevision = false;
    while (ancestor && ancestor !== p) { if (["ins", "del", "moveTo", "moveFrom"].includes(ancestor.localName)) { inRevision = true; break; } ancestor = ancestor.parentElement; }
    if (inRevision) return true;
    if ((node.textContent || "").replace(ENDING_STRIP, "")) return false;
  }
  return false;
}

/** Text nodes from the end of the paragraph back to the last one with words in it. */
function endingTail(p: Element): Element[] {
  const tail: Element[] = [];
  for (const node of visibleRuns(p).flatMap(run => Array.from(run.children).filter(child => child.namespaceURI === WORD_NS && child.localName === "t")).reverse()) {
    if (!node.textContent) continue;
    tail.push(node);
    if (node.textContent.replace(ENDING_STRIP, "")) break;
  }
  return tail;
}

/** The run closing the complex field whose result holds ``run``, or null. */
function fieldResultEnd(p: Element, run: Element): Element | null {
  const stack: string[] = [];
  let inside = false;
  for (const candidate of elements(p, "r")) {
    if (candidate === run) inside = stack.includes("result");
    for (const mark of elements(candidate, "fldChar")) {
      const type = wordAttribute(mark, "fldCharType");
      if (type === "begin") stack.push("code");
      else if (type === "separate" && stack.length) stack[stack.length - 1] = "result";
      else if (type === "end") { stack.pop(); if (inside && !stack.length) return candidate; }
    }
  }
  return null;
}

/** A field result or link holding ``node``: the element after which new text must go. */
function endingContainer(p: Element, node: Element): Element | null {
  for (let ancestor = node.parentElement; ancestor && ancestor !== p; ancestor = ancestor.parentElement) {
    if (ancestor.namespaceURI === WORD_NS && ["hyperlink", "fldSimple"].includes(ancestor.localName)) return ancestor;
  }
  return node.parentElement ? fieldResultEnd(p, node.parentElement) : null;
}

function setEnding(ctx: Ctx, p: Element, ending: string) {
  const text = paragraphText(p);
  // Only the final punctuation is replaced: trailing spaces at the very end
  // go, but a space inside the sentence (before a field or a link) stays.
  // Line and page breaks after the sentence stay after its new ending.
  const stripped = text.replace(/[ \t\n]+$/, "").replace(ENDING_PUNCTUATION, "");
  const breaks = "\n".repeat((text.slice(text.replace(/[ \t\n]+$/, "").length).match(/\n/g) || []).length);
  if (!stripped.trim() || text === stripped + ending + breaks) return;
  if (endingInRevision(p)) { protect(ctx, p, "句末标点位于修订痕迹中，未自动规范"); return; }
  const tail = endingTail(p);
  // Hidden or struck words are not what the reader sees end the sentence.
  if (tail.some(node => node.parentElement && UNIFORM_DAMAGE.some(tag => runHas(node.parentElement!, tag)))) {
    protect(ctx, p, "句末文字为隐藏或删除线文字，未自动规范标点"); return;
  }
  const container = tail.length ? endingContainer(p, tail[0]) : null;
  if (container) {
    // A field result is regenerated by Word and a link's text is the link:
    // punctuation goes after them, and nothing inside them is changed.
    if (text.replace(/\n+$/, "") !== stripped) { protect(ctx, p, "句末位于域结果或超链接中，未自动规范标点"); return; }
    const source = tail[0].parentElement!, added = p.ownerDocument.createElementNS(WORD_NS, "w:r");
    const properties = directChild(source, "rPr");
    if (properties) { const copy = properties.cloneNode(true) as Element; removeChildren(copy, ["rStyle"]); added.appendChild(copy); }
    const node = added.appendChild(p.ownerDocument.createElementNS(WORD_NS, "w:t"));
    node.textContent = ending;
    container.parentNode!.insertBefore(added, container.nextSibling);
    logEdit(ctx, p, "ending");
    return;
  }
  rewriteLogged(ctx, p, stripped + ending + breaks, "ending");
}

function punctuation(ctx: Ctx, blocks: Block[]) {
  const zh = ctx.language === "zh";
  for (const block of blocks) if (block.role === "subject" || block.role === "preamble") setEnding(ctx, block.p, zh ? "，" : ",");
  const clauses = blocks.filter(b => b.operative && (b.role === "item" || b.role === "prose") && !BARE_ARTICLE.test(paragraphText(b.p)));
  clauses.forEach((block, position) => {
    const following = clauses[position + 1];
    const ending = following && following.level > block.level ? (zh ? "：" : ":") : !following ? (zh ? "。" : ".") : (zh ? "；" : ";");
    setEnding(ctx, block.p, ending);
  });
}

function blockPitch(ctx: Ctx, block: Block) {
  const role = block.role === "preamble" ? "preamble" : block.group || block.role === "sponsors" || block.role === "signatories" ? "signature" : "body";
  return rolePitch(ctx.type, ctx.language, role);
}

function applyPitch(p: Element, pitch: number) {
  const spacing = pChild(pPrOf(p), "spacing");
  for (const name of ["beforeAutospacing", "afterAutospacing", "beforeLines", "afterLines"]) removeWordAttribute(spacing, name);
  setWordAttribute(spacing, "before", "0"); setWordAttribute(spacing, "after", "0");
  setWordAttribute(spacing, "line", String(Math.round(pitch * 20)));
  setWordAttribute(spacing, "lineRule", holdsInlineObject(p) ? "atLeast" : "exact");
}

function geometry(ctx: Ctx, block: Block) {
  if (!attached(block)) return;
  const pPr = pPrOf(block.p);
  removeChildren(pPr, PARAGRAPH_CLEAN);
  for (const [tag, value] of Object.entries({ pageBreakBefore: "0", keepLines: "0", keepNext: KEEP_WITH_NEXT.includes(block.role) ? "1" : "0" })) setWordAttribute(pChild(pPr, tag), "val", value);
  applyPitch(block.p, blockPitch(ctx, block));
  setWordAttribute(pChild(pPr, "jc"), "val", block.role === "title" ? "left" : "both");
  const ind = pChild(pPr, "ind");
  for (const name of Array.from(ind.attributes).map(a => a.localName)) removeWordAttribute(ind, name);
  setWordAttribute(ind, "right", "0");
  if (block.role === "item") {
    const indents = ctx.spec.listIndentsPt, [left, hanging] = indents[Math.min(block.level, indents.length - 1)];
    setWordAttribute(ind, "left", String(Math.round(left * 20)));
    if (hanging) setWordAttribute(ind, "hanging", String(Math.round(hanging * 20))); else setWordAttribute(ind, "firstLine", "0");
  } else {
    setWordAttribute(ind, "left", "0");
    setWordAttribute(ind, "firstLine", String(Math.round((block.role === "prose" ? ctx.spec.proseFirstLinePt : 0) * 20)));
  }
}

function emphasizeVerb(ctx: Ctx, p: Element, phrases: string[], style: { italic?: boolean; underline?: boolean }) {
  const text = paragraphText(p);
  const marker = text.match(HANDBOOK_MARKER);
  const start = marker ? marker[0].length : text.length - text.trimStart().length;
  const rest = text.slice(start).toLowerCase();
  for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) {
    if (!rest.startsWith(phrase.toLowerCase())) continue;
    const end = start + phrase.length;
    if (ctx.language === "en" && end < text.length && /[a-z]/i.test(text[end])) continue;
    styleTextRange(p, start, end, style);
    return;
  }
}

function emphasis(ctx: Ctx, block: Block) {
  const p = block.p;
  // A page break or picture line: no emphasis on its spaces.
  if (attached(block) && block.role === "object") { formatRuns(p, ctx, { bold: false, italic: false, underline: false }); return; }
  if (!attached(block) || !paragraphText(p).trim()) return;
  const { role, spec } = { role: block.role, spec: ctx.spec };
  if (role === "title") formatRuns(p, ctx, { bold: true, italic: false, underline: false });
  else if (["committee", "topic", "country", "delegate"].includes(role) || (role === "header" && !block.group)) {
    if (spec.headerFields === "bold") formatRuns(p, ctx, { bold: true, italic: false, underline: false });
    else {
      const text = paragraphText(p), match = text.match(/^(\s*.*?[:：]\s*)/);
      formatRuns(p, ctx, { bold: false, italic: false, underline: false });
      if (match) styleTextRange(p, 0, match[1].length, { bold: true, italic: false, underline: false });
      else formatRuns(p, ctx, { bold: true, italic: false, underline: false });
    }
  } else if (role === "sponsors" || role === "signatories") styleCountryLine(ctx, p, true);
  else if (role === "header") formatRuns(p, ctx, { bold: true, italic: true, underline: false });
  else if (role === "subject") formatRuns(p, ctx, { bold: spec.subject?.bold ?? true, italic: spec.subject?.italic ?? false, underline: false });
  else if (role === "part") formatRuns(p, ctx, { bold: true, italic: false, underline: false });
  else if (["preamble", "item", "prose"].includes(role)) {
    if (spec.clearClauseEmphasis) formatRuns(p, ctx, { bold: false, italic: false, underline: false });
    if (role === "preamble" && spec.preambleVerbUnderline) emphasizeVerb(ctx, p, POLICY.prefixes[ctx.language].preambulatory, { underline: true });
    else if (block.operative && block.level === 0 && spec.topLevelVerbItalic) {
      const verbs = kindOf(ctx.type) === "amendment" ? HB.amendmentVerbs[ctx.language] : POLICY.prefixes[ctx.language].operative;
      emphasizeVerb(ctx, p, verbs, { italic: true });
    }
  }
}

function widthEm(text: string) {
  let total = 0;
  for (const ch of text) total += ch.codePointAt(0)! > 0x2e7f ? 1 : /[A-Z]/.test(ch) ? 0.7 : " ,.;:'’-()".includes(ch) ? 0.3 : 0.5;
  return total;
}
const LINE_WIDTH_EM = (HB.page.widthTwips - HB.page.leftTwips - HB.page.rightTwips) / 20 / BODY_PT - 1;

function breakCountryList(label: string, values: string[], language: "zh" | "en"): string[][] {
  const separator = language === "en" ? HB.signatureLines.separator.en.trimEnd() : HB.signatureLines.separator.zh;
  const lines: string[][] = [[label]];
  let width = widthEm(label);
  values.forEach((value, index) => {
    const piece = value + (index < values.length - 1 ? separator : "");
    const lead = language === "en" && width && !(lines[lines.length - 1].length === 1 && lines.length === 1) ? " " : "";
    if (lines[lines.length - 1].length > (lines.length === 1 ? 1 : 0) && width + widthEm(lead + piece) > LINE_WIDTH_EM) {
      lines.push([piece]); width = widthEm(piece); return;
    }
    lines[lines.length - 1].push(lead + piece); width += widthEm(lead + piece);
  });
  return lines;
}

function signatureLines(ctx: Ctx, blocks: Block[]): Block[] {
  const result = [...blocks];
  for (const key of ["sponsors", "signatories"] as const) {
    const group = blocks.filter(b => b.group === key && attached(b));
    const source = ctx.changed.has(key) ? ctx.model[key] : ctx.recognized[key];
    const values = countryOrder(ctx, source);
    if (!group.length || group[0].role !== key || !values.length) continue;
    const expected = countryLineText(key, values, ctx.language);
    const written = group.map(b => paragraphText(b.p)).join("");
    if (written.replace(/\s+/g, "") !== expected.replace(/\s+/g, "") || group.some(b => hasComplexContent(b.p) || carriesSemanticMarks(b.p))) continue;
    const label = expected.slice(0, expected.length - values.join(HB.signatureLines.separator[ctx.language]).length);
    const lines = breakCountryList(label, values, ctx.language);
    if (lines.length === 1 && group.length === 1) continue;
    const first = group[0].p;
    for (const block of group.slice(1)) { clearParagraph(block.p); logEdit(ctx, block.p, "countries", key, expected); }
    logEdit(ctx, first, "countries", key, expected);
    const added: Block[] = [];
    let anchor = first;
    lines.forEach((pieces, number) => {
      let p = first;
      if (number) {
        p = first.ownerDocument.createElementNS(WORD_NS, "w:p");
        const pPr = directChild(first, "pPr");
        if (pPr) p.appendChild(pPr.cloneNode(true));
        anchor.parentNode!.insertBefore(p, anchor.nextSibling);
        logEdit(ctx, p, "countries", key, expected, true);
        added.push({ p, role: "header", level: 0, group: key, operative: false });
      }
      clearParagraph(p);
      pieces.forEach((piece, index) => formatRun(appendRun(p, piece), ctx, { bold: true, italic: number === 0 && index === 0 ? ctx.spec.countryLabelItalic : true, underline: false }));
      anchor = p;
    });
    result.splice(result.indexOf(group[0]) + 1, 0, ...added);
  }
  return result;
}

/** Marker fonts / sizes in every list definition and override; values are never touched. */
function numberingMarkers(ctx: Ctx) {
  const bytes = ctx.parts["word/numbering.xml"];
  if (!bytes) return;
  const numbering = new DOMParser().parseFromString(decoder.decode(bytes), "application/xml");
  if (numbering.getElementsByTagName("parsererror").length) throw new InvalidDocxError("自动编号 XML 损坏。");
  const abstracts = new Map(elements(numbering, "abstractNum").map(a => [wordAttribute(a, "abstractNumId") || "", a]));
  const normalize = (level: Element, base: Element | undefined) => {
    const fmt = directChild(level, "numFmt") || (base && directChild(base, "numFmt"));
    const bullet = wordAttribute(fmt, "val") === "bullet";
    const rPr = directChild(level, "rPr") || level.appendChild(numbering.createElementNS(WORD_NS, "w:rPr"));
    removeChildren(rPr, MARKER_NOISE);
    if (!bullet) {
      houseFonts(rChild(rPr, "rFonts"), ctx.eastAsia, ctx.language);
      for (const tag of ["b", "bCs", "i", "iCs"]) setWordAttribute(rChild(rPr, tag), "val", "0");
      setWordAttribute(rChild(rPr, "u"), "val", "none");
    }
    for (const tag of ["sz", "szCs"]) setWordAttribute(rChild(rPr, tag), "val", String(BODY_PT * 2));
  };
  // Every list defined, used or not: a list pasted in later must not bring back tiny numbers.
  for (const abstract of abstracts.values()) for (const level of elements(abstract, "lvl")) normalize(level, level);
  for (const num of elements(numbering, "num")) {
    const abstract = abstracts.get(wordAttribute(directChild(num, "abstractNumId"), "val") || "");
    const base = new Map(abstract ? elements(abstract, "lvl").map(l => [wordAttribute(l, "ilvl") || "0", l]) : []);
    for (const override of elements(num, "lvlOverride")) for (const level of elements(override, "lvl")) normalize(level, base.get(wordAttribute(level, "ilvl") || "0"));
  }
  ctx.parts["word/numbering.xml"] = encoder.encode(new XMLSerializer().serializeToString(numbering));
}

function continuity(ctx: Ctx, blocks: Block[]) {
  const last = new Map<string, number>();
  const findings: string[] = [];
  for (const block of blocks) {
    if (!["item", "prose", "preamble"].includes(block.role) || !attached(block)) continue;
    const text = paragraphText(block.p);
    for (const [index, [pattern, valueOf]] of SEQUENCES.entries()) {
      const match = text.match(pattern);
      if (!match) continue;
      const value = valueOf(match[1]);
      if (value === null) break;
      const previous = last.get(SEQUENCE_NAMES[index]);
      if (previous !== undefined && value !== 1 && value !== previous + 1) findings.push(`第 ${sourceNumber(ctx, block.p)} 段“${match[0].trim()}”（前一个为第 ${previous} 项）`);
      last.set(SEQUENCE_NAMES[index], value);
      break;
    }
  }
  if (findings.length) ctx.warnings.push(`编号不连续，已保留原文、未自动改号，请确认：${findings.slice(0, 8).join("；")}${findings.length > 8 ? "……" : ""}`);
}

function blankParagraph(ctx: Ctx, pitch: number) {
  const p = ctx.document.createElementNS(WORD_NS, "w:p");
  const pPr = p.appendChild(ctx.document.createElementNS(WORD_NS, "w:pPr"));
  const spacing = pChild(pPr, "spacing");
  for (const [name, value] of Object.entries({ before: "0", after: "0", line: String(Math.round(pitch * 20)), lineRule: "exact" })) setWordAttribute(spacing, name, value);
  const rPr = pChild(pPr, "rPr");
  houseFonts(rChild(rPr, "rFonts"), ctx.eastAsia, ctx.language);
  for (const tag of ["sz", "szCs"]) setWordAttribute(rChild(rPr, tag), "val", String(BODY_PT * 2));
  return p;
}

function blankLines(ctx: Ctx, blocks: Block[]) {
  const body = elements(ctx.document, "body")[0];
  for (const p of flowParagraphs(ctx.document)) {
    // A content control keeps at least one paragraph.
    if (p.parentElement !== body && p.parentElement?.children.length === 1) continue;
    if (paragraphText(p).trim() || carriesHiddenStructure(p)) continue;
    if (!ctx.editLog.has(p)) logEdit(ctx, p, "empty-line");
    p.remove();
  }
  const live = blocks.filter(b => attached(b) && paragraphText(b.p).trim());
  const after: (Element | null)[] = [];
  const last = (predicate: (b: Block) => boolean) => [...live].reverse().find(predicate)?.p ?? null;
  for (const role of ctx.spec.blankAfter) {
    if (role === "title_block") after.push(last(b => ["title", "committee", "topic"].includes(b.role)));
    else if (role === "header") after.push(last(b => HEADER_ROLES.includes(b.role)));
    else if (role === "sponsors" || role === "signatories") after.push(...live.filter(b => b.group === role).map(b => b.p));
    else after.push(last(b => b.role === role));
  }
  if (ctx.spec.blankBeforeOperative) {
    const first = live.find(b => b.operative && (b.role === "item" || b.role === "prose"));
    if (first) after.push(first.p.previousElementSibling);
  }
  if (ctx.spec.blankBetweenProse) {
    const bodyBlocks = live.filter(b => [...BODY_ROLES, "part"].includes(b.role));
    bodyBlocks.slice(0, -1).forEach((current, index) => {
      const following = bodyBlocks[index + 1];
      if (current.role === following.role && ["item", "reference"].includes(current.role)) return;
      after.push(current.p);
    });
  }
  // An empty line has the body pitch, except a signing line under a country
  // name (as tall as that line, 页52); a blank after the 18 pt preamble is a
  // 15.5 pt line (页42).
  const pitchOf = new Map(live.filter(b => b.group || b.role === "sponsors" || b.role === "signatories").map(b => [b.p, rolePitch(ctx.type, ctx.language, "signature")]));
  const seen = new Set<Element>();
  for (const element of after) {
    if (!element || seen.has(element) || !element.parentNode) continue;
    seen.add(element);
    const blank = blankParagraph(ctx, pitchOf.get(element) ?? rolePitch(ctx.type, ctx.language, "body"));
    element.parentNode.insertBefore(blank, element.nextSibling);
    logEdit(ctx, blank, "blank", "", null, true);
  }
}

// ------------------------------------------------------------ validations

function runSizeIssues(ctx: Ctx) {
  const referenceStart = ctx.type === "position-paper" ? paragraphElements(ctx.document).findIndex(p => REFERENCE_START.test(paragraphText(p))) : -1;
  let issues = 0;
  paragraphElements(ctx.document).forEach((p, index) => {
    const expected = referenceStart >= 0 && index >= referenceStart ? NOTE_PT : BODY_PT;
    for (const run of visibleRuns(p)) {
      if (!paragraphText(run).trim()) continue;
      const raw = wordAttribute(directChild(rPrOf(run), "sz"), "val");
      if (!raw || Math.abs(Number(raw) / 2 - expected) > 0.05) issues++;
    }
  });
  return issues;
}

const EDIT_NOTES: Record<string, string> = {
  title: "按学标统一标题用词", "label-drop": "按范例删除委员会/议题标签", "label-restore": "补齐页首标签",
  countries: "国家名单按顺序排列并按国名断行留签字空行", ending: "按学标统一条款末尾标点", marker: "统一立场文件建议编号写法",
  blank: "按范例调整空行", "empty-line": "按范例调整空行",
  "country-name": "按共用 UNTERM 名称表展开明确国家字段的全称",
};

/** User-facing record of every logged edit (same wording as the Python engine). */
function editSummary(editLog: Map<Element, Edit>, repaired: boolean, split: boolean): string[] {
  const notes: string[] = [];
  if (repaired) notes.push("补齐（一）标记");
  if (split) notes.push("拆分嵌套条款");
  const fields = new Set<string>();
  for (const edit of editLog.values()) {
    if (edit.kind === "field") fields.add(edit.key || "");
    else if (EDIT_NOTES[edit.kind] && !notes.includes(EDIT_NOTES[edit.kind])) notes.push(EDIT_NOTES[edit.kind]);
  }
  if (fields.size) notes.unshift(`应用第 03 步人工确认的修改（${[...fields].map(key => key === "title" ? "标题" : POLICY.metadata[key as MetadataKey]?.output.zh || key).join("、")}）`);
  return notes;
}

export function formatDocxInBrowser(
  content: ArrayBuffer,
  model: BrowserModel,
  options: { sessionLabel: string; submittingCountry: string; version: string; preserveCountryOrder?: boolean; normalizePunctuation?: boolean },
) {
  try {
    validateReview(model);
    return formatInner(content, model, options);
  } catch (reason) {
    if (reason instanceof InvalidRequestError) throw reason;
    if (reason instanceof InvalidDocxError) throw new Error(`文件无法读取：${reason.message}`);
    if (reason instanceof ProtectedContentError) throw new Error(`为保护原有内容已中止输出：${reason.message}`);
    if (reason instanceof ContentCheckError) throw reason;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    throw new Error(`程序内部错误（不是文件本身的问题），请把该文件反馈给维护者。${error.name}: ${error.message.slice(0, 200)}`);
  }
}

function formatInner(
  content: ArrayBuffer,
  model: BrowserModel,
  options: { sessionLabel: string; submittingCountry: string; version: string; preserveCountryOrder?: boolean; normalizePunctuation?: boolean },
) {
  const originalBytes = new Uint8Array(content.slice(0));
  const { parts, document } = parsePackage(content);
  const original = recognize(document, model.document_type);

  // Structure repair, checked on its own: splits and the markers it reports only.
  const repairBefore = documentTokens(document);
  const repaired = repairMissingFirstSection(document, model.document_type, original);
  const split = normalizeEmbeddedSubclauses(document, model.document_type);
  const missingListItems = suspectedMissingListItems(document, model.document_type);
  const unsplitParagraphs = [...unsplit];
  const repairProblems = repaired || split ? verifyRepair(repairBefore, documentTokens(document), repaired ? ["（一）"] : []) : [];
  const recognized = { ...recognize(document, model.document_type), language: model.language };

  const changed = new Set((["title", "committee", "topic", "country", "delegate", "sponsors", "signatories"] as const)
    .filter(key => JSON.stringify(model[key]) !== JSON.stringify(original[key])));
  const ctx: Ctx = {
    document, parts, model, recognized, original, type: model.document_type, language: model.language,
    spec: specFor(model.document_type, model.language), eastAsia: eastAsianFont(model.document_type, model.language),
    normalizePunctuation: options.normalizePunctuation ?? true, preserveCountryOrder: options.preserveCountryOrder ?? false,
    changed, editLog: new Map(), source: flowParagraphs(document), warnings: [...recognized.warnings], protectedNotes: [], countryChanges: [],
    headerEnd: headerLimit(flowParagraphs(document), model.document_type, recognized.language),
  };
  const snapshot = takeSnapshot(document);
  const keptHidden = stripUniformDamage(document, parts);
  // After the whole-document damage is cleared: what stays hidden or struck must stay so.
  const marks = semanticMarks(document);

  configurePage(document);
  configureStyles(parts, ctx);
  for (const p of elements(document, "p")) for (const run of visibleRuns(p)) formatRun(run, ctx);
  const paragraphs = flowParagraphs(document);
  formatMetadata(ctx, paragraphs);
  const numbering = numberingIndex(parts);
  if (ctx.type === "position-paper") {
    const lastLabel = paragraphs.reduce((last, p, index) => index < ctx.headerEnd && labeledField(paragraphText(p).trim()) ? index + 1 : last, 0);
    positionPaperMarkers(ctx, paragraphs, lastLabel);
  }
  let blocks = handbookBlocks(ctx, paragraphs, numbering);
  headerText(ctx, blocks);
  if (ctx.normalizePunctuation && ctx.spec.clausePunctuation) punctuation(ctx, blocks);
  for (const block of blocks) { geometry(ctx, block); emphasis(ctx, block); }
  if (ctx.spec.signatureLines) blocks = signatureLines(ctx, blocks);
  numberingMarkers(ctx);
  continuity(ctx, blocks);
  blankLines(ctx, blocks);
  handbookNotes(parts, ctx.eastAsia);
  normalizeFontParts(parts, ctx.language);

  const problems = [...verifyFormat(snapshot, document, ctx.editLog, TITLE_WORDS(ctx.type), [...POLICY.metadata.committee.aliases, ...POLICY.metadata.topic.aliases]), ...verifyMarks(marks, document)];
  parts["word/document.xml"] = encoder.encode(new XMLSerializer().serializeToString(document));
  const output = zipSync(parts, { level: 6 });
  const packageProblems = verifyPackage(originalBytes, output);
  const sizeIssues = runSizeIssues(ctx);
  const validations: BrowserValidation[] = [
    { code: "docx_package", label: "DOCX 包结构", status: "pass", detail: "必要的 Word 部件完整。" },
    { code: "content", label: "逐段严格内容校验（文字、域、链接、书签、脚注、修订、隐藏与删除线）", status: problems.length ? "error" : "pass", detail: problems.slice(0, 6).join("；") || "只允许句末标点、标题用词、页首标签和国家名单顺序/断行等记录在案的修改。" },
    { code: "package", label: "链接目标、关系与嵌入资源逐项保留", status: packageProblems.length ? "error" : "pass", detail: packageProblems.slice(0, 6).join("；") || "每个关系的目标、类型、模式及每个图片 / 嵌入对象的字节均与原稿一致。" },
    { code: "font_size", label: "正文与编号字号", status: sizeIssues ? "error" : "pass", detail: sizeIssues ? `仍有 ${sizeIssues} 个文本片段未达到规定字号。` : `正文 ${BODY_PT} 磅、参考文献与脚注 ${NOTE_PT} 磅。` },
    { code: "browser_private", label: "本地处理", status: "pass", detail: "文件在当前浏览器中处理，未发送到外部排版服务。" },
  ];
  const edits = editSummary(ctx.editLog, repaired, split);
  for (const key of ctx.changed) {
    const written = [...ctx.editLog.values()].some(edit => edit.key === key && (edit.kind === "field" || edit.country?.manual));
    const label = key === "title" ? "标题" : POLICY.metadata[key as MetadataKey].output.zh;
    validations.push({ code: written ? "manual-field" : "manual-field-unwritten", label: `第 03 步${label}修改结果`, status: written ? "pass" : "warning",
      detail: written ? `${label}已写入，并通过逐段内容校验。` : `${label}未写入：文档中没有可安全替换的${label}字段行。已保留原稿，不自动添加新行；请在原稿补充该字段后重新上传。` });
  }
  for (const detail of [...new Set(ctx.countryChanges)]) validations.push({ code: "country_names", label: "国家全称展开与身份去重记录", status: "pass", detail });
  for (const detail of countryWarnings([model.country, ...model.sponsors, ...model.signatories], ctx.language)) validations.push({ code: "country-review", label: "国家或实体名称待人工确认", status: "warning", detail });
  validations.splice(1, 0, { code: "structural_edits", label: "结构与人工修改记录", status: edits.length ? "warning" : "pass", detail: edits.join("；") || "未改写正文文字。" });
  if (repairProblems.length) validations.push({ code: "repair-content", label: "结构修复严格内容校验", status: "error", detail: repairProblems.slice(0, 6).join("；") });
  for (const note of keptHidden) validations.push({ code: "hidden-text", label: "隐藏文字与删除线按原稿保留", status: "warning", detail: note });
  for (const number of missingListItems) validations.push({ code: "numbering_review", label: "原编号已保留，疑似缺项需人工确认", status: "warning", detail: `第 ${number} 段可能是引言或缺失编号的首项。已保留原样，不自动加入列表，以免后续条号及交叉引用错位。` });
  for (const { number, reason } of unsplitParagraphs) validations.push(reason === "context"
    ? { code: "structure_review", label: "结构识别待确认", status: "warning", detail: `第 ${number} 段${UNSPLIT_NOTES.context}，未拆分，请人工确认。` }
    : { code: "content-protected", label: "为保护原有内容，部分段落未自动改写", status: "warning", detail: `第 ${number} 段${UNSPLIT_NOTES[reason]}未拆分为独立段落，请人工确认。` });
  for (const note of ctx.protectedNotes) validations.push({ code: "content-protected", label: "为保护原有内容，部分段落未自动改写", status: "warning", detail: note });
  for (const detail of ctx.warnings) validations.push({ code: "structure_review", label: "结构识别待确认", status: "warning", detail });
  const errors = validations.filter(item => item.status === "error");
  if (errors.length) throw new ContentCheckError(`安全校验未通过，已中止下载：${errors.map(item => `${item.label}（${item.detail}）`).join("；")}`);
  const outputBuffer = output.slice().buffer as ArrayBuffer;
  return { blob: new Blob([outputBuffer], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), filename: outputFilename(model, options.sessionLabel, options.submittingCountry, options.version), validations };
}
