// The web page's rules for the four steps (app/page.tsx and app/template-panel.tsx),
// kept free of wx so tests/miniprogram-pages.test.mjs can check them against the web code.

const DOCUMENT_TYPES = [
  { id: "position-paper", zh: "立场文件", en: "Position Paper", badge: "PP" },
  { id: "working-paper", zh: "工作文件", en: "Working Paper", badge: "WP" },
  { id: "draft-directive", zh: "指令草案", en: "Draft Directive", badge: "DD" },
  { id: "draft-resolution", zh: "决议草案", en: "Draft Resolution", badge: "DR" },
  { id: "friendly-amendment", zh: "友好修正案", en: "Friendly Amendment", badge: "FA" },
  { id: "unfriendly-amendment", zh: "非友好修正案", en: "Unfriendly Amendment", badge: "UA" },
  { id: "diplomatic-agreement", zh: "外交协定", en: "Diplomatic Agreement", badge: "DA" },
  { id: "joint-statement", zh: "联合声明", en: "Joint Statement", badge: "JS" },
];

const LANGUAGES = [{ id: "zh", label: "中文" }, { id: "en", label: "English" }];

const typeInfo = id => DOCUMENT_TYPES.find(type => type.id === id) || DOCUMENT_TYPES[3];
const isTreatyType = id => id === "diplomatic-agreement" || id === "joint-statement";
// A draft resolution keeps the uploaded file's name, so session, country and version are not asked for.
const keepsSourceName = id => id === "draft-resolution";

/** Step 03 fields, in the web page's order and wording. */
function reviewFields(type) {
  if (isTreatyType(type)) return [{ key: "sponsors", label: "签署方（逗号分隔，签字栏按此生成）", list: true }];
  const fields = [{ key: "committee", label: "委员会" }, { key: "topic", label: "议题" }];
  if (type === "position-paper") fields.push({ key: "country", label: "国家 / 席位" }, { key: "delegate", label: "代表" });
  else fields.push({ key: "sponsors", label: "起草国（逗号分隔）", list: true });
  if (type !== "position-paper" && type !== "working-paper") fields.push({ key: "signatories", label: "附议国（逗号分隔）", list: true });
  return fields;
}

/** Fields of "从规范模板新建文件" for a type. */
function templateFields(type) {
  if (isTreatyType(type)) {
    return [{ key: "sponsors", label: "签署方（逗号分隔）" },
      { key: "topic", label: type === "joint-statement" ? "事由（如：海洋塑料污染治理）" : "事由（如：海上搜救合作）" }];
  }
  const fields = [{ key: "committee", label: "委员会" }];
  if (type !== "draft-directive") fields.push({ key: "topic", label: "议题" });
  if (type === "position-paper") fields.push({ key: "country", label: "国家 / 席位" }, { key: "delegate", label: "代表" });
  else {
    fields.push({ key: "sponsors", label: "起草国（逗号分隔）" });
    if (type !== "working-paper") fields.push({ key: "signatories", label: "附议国（逗号分隔）" });
  }
  return fields;
}

const emptyTemplateInput = () => ({ language: "zh", committee: "", topic: "", country: "", delegate: "", sponsors: "", signatories: "", body: "" });

/** Same checks and messages as the web upload box. */
function checkFile(file, maxBytes) {
  if (!file || !/\.docx$/i.test(file.name || "")) return "请上传 .docx 文件。旧版 .doc、PDF 和纯文本将在后续版本支持。";
  if (file.size > maxBytes) return "文件超过 20 MB，请精简图片后重试。";
  return "";
}

/** The options the web page passes to formatDocxInBrowser. */
function formatOptions(type, options, sourceName) {
  const common = { normalizePunctuation: options.normalizePunctuation, preserveCountryOrder: options.preserveOrder, sourceName };
  if (keepsSourceName(type)) return Object.assign({ sessionLabel: "", submittingCountry: "", version: "" }, common);
  return Object.assign({ sessionLabel: options.sessionLabel, submittingCountry: options.submittingCountry, version: options.version }, common);
}

/** What the web page shows above the step-03 fields about country names. */
function countryReview(engine, model, preserveOrder) {
  if (!model || engine.isTreaty(model.document_type)) return null;
  const changes = [];
  for (const key of ["country", "sponsors", "signatories"]) {
    const values = key === "country" ? [model.country] : model[key];
    const plan = engine.planCountries(values, model.language, preserveOrder);
    for (const item of plan.resolutions) if (item.changed) changes.push(`${item.input} → ${item.display}`);
    if (plan.removedDuplicates) changes.push(`${key === "sponsors" ? "起草国" : "附议国"}将按国家标识合并 ${plan.removedDuplicates} 个重复项`);
  }
  const warnings = engine.countryWarnings([model.country].concat(model.sponsors, model.signatories), model.language);
  return { changes, warnings, show: changes.length > 0 || warnings.length > 0 };
}

const clausesOf = model => model.preambulatory_clauses.concat(model.operative_clauses, model.body_clauses)
  .sort((a, b) => a.paragraph_index - b.paragraph_index);

const clipped = (text, limit) => text.length > limit ? `${text.slice(0, limit)}…` : text;

/** The parts of a parsed model the page shows. Kept small: setData sends everything to the view layer. */
function reviewView(engine, model, preserveOrder) {
  const diagnostic = engine.buildDiagnosticReport(model, []);
  const treaty = engine.isTreaty(model.document_type);
  const zh = model.language === "zh";
  const summary = [];
  if (model.committee) summary.push({ label: zh ? "委员会：" : "Committee: ", value: model.committee });
  if (model.topic) summary.push({ label: zh ? "议题：" : "Topic: ", value: model.topic });
  if (model.country) summary.push({ label: zh ? "国家/席位：" : "Country: ", value: model.country });
  if (model.sponsors.length) summary.push({ label: treaty ? (zh ? "签署方：" : "Parties: ") : zh ? "起草国：" : "Sponsors: ", value: model.sponsors.join(zh ? "；" : "; ") });
  if (model.signatories.length) summary.push({ label: zh ? "附议国：" : "Signatories: ", value: model.signatories.join(zh ? "；" : "; ") });
  return {
    title: model.title || typeInfo(model.document_type).zh,
    summary,
    warnings: model.warnings,
    countries: countryReview(engine, model, preserveOrder),
    paragraphCount: diagnostic.paragraph_count,
    missing: diagnostic.missing_fields.map(item => item.label).join("、"),
    clauses: clausesOf(model).slice(0, 300).map((clause, index) => ({
      key: `${clause.paragraph_index}-${index}`,
      mark: clause.kind === "preambulatory" ? "P" : clause.kind === "operative" ? "O" : "·",
      kind: clause.kind, level: Math.min(clause.level, 3),
      text: clipped(clause.text, 300), confidence: Math.round(clause.confidence * 100),
      paragraph: clause.paragraph_index + 1, reason: diagnostic.clauses[index] ? diagnostic.clauses[index].reason : "",
    })),
    clauseTotal: diagnostic.clauses.length,
  };
}

const validationView = validations => validations.map((item, index) => ({
  key: `${item.code}-${index}`, status: item.status, label: item.label, detail: item.detail || "",
  icon: item.status === "pass" ? "✓" : item.status === "warning" ? "△" : "×",
}));

const sizeText = bytes => `${(bytes / 1024).toFixed(1)} KB`;

module.exports = {
  DOCUMENT_TYPES, LANGUAGES, typeInfo, isTreatyType, keepsSourceName, reviewFields, templateFields, emptyTemplateInput,
  checkFile, formatOptions, countryReview, clausesOf, reviewView, validationView, sizeText,
};
