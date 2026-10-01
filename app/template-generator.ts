import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import { zipSync } from "fflate";
import policy from "../shared/document-policy.json" with { type: "json" };
import { parseDocxInBrowser, formatDocxInBrowser } from "./docx-browser.ts";
import type { BrowserDocumentType } from "./docx-browser.ts";

export type TemplateInput = {
  language: "zh" | "en"; committee: string; topic: string; country: string;
  delegate: string; sponsors: string; signatories: string; body: string;
};
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const paragraph = (value: string) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:p>`;

/** New documents only. Uploaded originals never pass through this generator. */
export function generateFromTemplate(type: BrowserDocumentType, input: TemplateInput) {
  if (!["zh", "en"].includes(input.language)) throw new Error("请选择有效语言。");
  if (Object.values(input).some(value => typeof value !== "string" || value.length > 100_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))) throw new Error("输入过长或包含无效字符。");
  if (!input.body.trim()) throw new Error("请先填写正文；程序不会替你编写内容。");
  const labels = input.language === "zh"
    ? { committee: "委员会", topic: "议题", country: "国家/席位", delegate: "代表", sponsors: "起草国", signatories: "附议国" }
    : { committee: "Committee", topic: "Topic", country: "Country", delegate: "Delegate", sponsors: "Sponsors", signatories: "Signatories" };
  const keys: Array<keyof typeof labels> = ["committee"];
  if (type !== "draft-directive") keys.push("topic");
  if (type === "position-paper") keys.push("country", "delegate");
  else {
    keys.push("sponsors");
    if (type !== "working-paper") keys.push("signatories");
  }
  const header = paragraph("{title}") + keys.filter(key => input[key].trim()).map(key => paragraph(`${labels[key]}${input.language === "zh" ? "：" : ": "}{${key}}`)).join("");
  const encoder = new TextEncoder();
  const bytes = zipSync({
    "[Content_Types].xml": encoder.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": encoder.encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml": encoder.encode(`<w:document xmlns:w="${W}"><w:body>${header}${paragraph("{@bodyXml}")}<w:sectPr/></w:body></w:document>`),
  });
  const template = new Docxtemplater(new PizZip(bytes), { paragraphLoop: true, linebreaks: true });
  template.render({ ...input, title: policy.handbook.outputTitles[type][input.language], bodyXml: input.body.split(/\r\n|\r|\n/).map(paragraph).join("") });
  const content = template.getZip().generate({ type: "uint8array" }).slice().buffer as ArrayBuffer;
  const model = parseDocxInBrowser(content, type);
  // Detection is content based; generation language is an explicit user choice.
  model.language = input.language;
  return formatDocxInBrowser(content, model, { sessionLabel: "", submittingCountry: "", version: "v1", normalizePunctuation: true });
}
