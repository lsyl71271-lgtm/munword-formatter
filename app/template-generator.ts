import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import { zipSync } from "fflate";
import policy from "../shared/document-policy.json" with { type: "json" };
import { isTreaty, parseDocxInBrowser, formatDocxInBrowser } from "./docx-browser.ts";
import type { BrowserDocumentType } from "./docx-browser.ts";
import { validXmlText } from "./request-validation.ts";

export type TemplateInput = {
  language: "zh" | "en"; committee: string; topic: string; country: string;
  delegate: string; sponsors: string; signatories: string; body: string;
};
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const paragraph = (value: string) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:p>`;

const splitParties = (value: string) => value.split(/[,，、;；\n]/).map(party => party.trim()).filter(Boolean);
const listParties = (parties: string[], language: "zh" | "en") => parties.length < 2 ? parties.join("")
  : language === "zh" ? `${parties.slice(0, -1).join("、")}与${parties[parties.length - 1]}` : `${parties.slice(0, -1).join(", ")} and ${parties[parties.length - 1]}`;

/** Title paragraphs of a diplomatic agreement or joint statement, phrased like the two reference documents:
 * "甲、乙与丙关于……协定"; "甲、乙、丙" + "就……的联合声明"; "Agreement between …", "Joint Statement of … on …". */
export function treatyTitle(type: "diplomatic-agreement" | "joint-statement", parties: string[], subject: string, language: "zh" | "en"): string[] {
  const topic = subject.trim();
  if (language === "en") {
    const lead = type === "diplomatic-agreement" ? "Agreement between" : "Joint Statement of";
    return [`${lead} ${listParties(parties, "en")}${topic ? ` on ${topic.replace(/^on\s+/i, "")}` : ""}`];
  }
  if (type === "diplomatic-agreement") {
    const about = !topic || /^(?:关于|就|有关)/.test(topic) ? topic : `关于${topic}`;
    return [`${listParties(parties, "zh")}${about}${/(?:协定|协议)$/.test(about) ? "" : "协定"}`];
  }
  const about = !topic || /^(?:就|关于|有关)/.test(topic) ? topic : `就${topic}`;
  return [parties.join("、"), `${about}${/声明$/.test(about) ? "" : about ? "的联合声明" : "联合声明"}`];
}

/** New documents only. Uploaded originals never pass through this generator. */
export function generateFromTemplate(type: BrowserDocumentType, input: TemplateInput) {
  if (!["zh", "en"].includes(input.language)) throw new Error("请选择有效语言。");
  if (Object.values(input).some(value => typeof value !== "string" || value.length > 100_000 || !validXmlText(value))) throw new Error("输入过长或包含无效字符。");
  if (!input.body.trim()) throw new Error("请先填写正文；程序不会替你编写内容。");
  if (isTreaty(type)) return generateTreaty(type, input);
  const labels = Object.fromEntries(Object.entries(policy.metadata).map(([key, value]) => [key, value.output[input.language]])) as Record<keyof typeof policy.metadata, string>;
  const keys: Array<keyof typeof labels> = ["committee"];
  if (type !== "draft-directive") keys.push("topic");
  if (type === "position-paper") keys.push("country", "delegate");
  else {
    keys.push("sponsors");
    if (type !== "working-paper") keys.push("signatories");
  }
  const header = paragraph("{title}") + keys.filter(key => input[key].trim()).map(key => paragraph(`${labels[key]}${input.language === "zh" ? "：" : ": "}{${key}}`)).join("");
  return render(type, input, header, { title: policy.handbook.outputTitles[type][input.language] });
}

/** A diplomatic agreement or joint statement: the parties ("sponsors") and subject ("topic") make the title;
 * the formatter adds one representative per party in the signature block. */
function generateTreaty(type: "diplomatic-agreement" | "joint-statement", input: TemplateInput) {
  const parties = splitParties(input.sponsors);
  if (!parties.length) throw new Error("请填写签署方；签字栏按签署方生成。");
  const titles = treatyTitle(type, parties, input.topic, input.language);
  return render(type, input, titles.map((_, index) => paragraph(`{title${index}}`)).join(""), Object.fromEntries(titles.map((title, index) => [`title${index}`, title])), parties);
}

function render(type: BrowserDocumentType, input: TemplateInput, header: string, values: Record<string, string>, parties?: string[]) {
  const encoder = new TextEncoder();
  // A styles part, so both engines (and Word) start from the house fonts rather
  // than their own different built-in defaults: without one, Python added
  // python-docx's default styles and the browser none, and they rendered apart.
  const eastAsia = input.language === "zh" ? policy.handbook.fonts.zh : policy.handbook.fonts.en;
  const styles = `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman" w:eastAsia="${eastAsia}"/>`
    + `<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  const bytes = zipSync({
    "[Content_Types].xml": encoder.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'),
    "_rels/.rels": encoder.encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/_rels/document.xml.rels": encoder.encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
    "word/styles.xml": encoder.encode(styles),
    "word/document.xml": encoder.encode(`<w:document xmlns:w="${W}"><w:body>${header}${paragraph("{@bodyXml}")}<w:sectPr/></w:body></w:document>`),
  });
  const template = new Docxtemplater(new PizZip(bytes), { paragraphLoop: true, linebreaks: true });
  template.render({ ...input, ...values, bodyXml: input.body.split(/\r\n|\r|\n/).map(paragraph).join("") });
  const content = template.getZip().generate({ type: "uint8array" }).slice().buffer as ArrayBuffer;
  const model = parseDocxInBrowser(content, type);
  // Detection is content based; generation language is an explicit user choice.
  model.language = input.language;
  if (parties) model.sponsors = parties;
  return formatDocxInBrowser(content, model, { sessionLabel: "", submittingCountry: "", version: "v1", normalizePunctuation: true });
}
