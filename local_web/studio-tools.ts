import { buildDiagnosticReport } from "../app/diagnostics.ts";
import { renderPreview } from "../app/preview-renderer.ts";
import { generateFromTemplate } from "../app/template-generator.ts";
import type { BrowserDocumentType, BrowserModel, BrowserValidation } from "../app/docx-browser.ts";
import type { TemplateInput } from "../app/template-generator.ts";

const byId = (id: string) => document.getElementById(id)!;
let type: BrowserDocumentType = "draft-resolution", current: { model: BrowserModel; file: Blob; output?: Blob; validations?: BrowserValidation[] } | null = null;
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
window.addEventListener("munword:type", event => {
  type = (event as CustomEvent<{ type: BrowserDocumentType }>).detail.type;
  current = null; byId("actualPages").replaceChildren(); byId("diagnosticSummary").textContent = "上传并识别后可查看诊断。";
});
window.addEventListener("munword:model", event => {
  current = (event as CustomEvent<typeof current>).detail;
  byId("actualPages").replaceChildren();
  if (!current) { byId("diagnosticSummary").textContent = "上传并识别后可查看诊断。"; return; }
  const report = buildDiagnosticReport(current.model, current.validations);
  byId("diagnosticSummary").textContent = `${report.paragraph_count} 个非空段落、${report.clauses.length} 个正文或条款；待确认字段：${report.missing_fields.map(item => item.label).join("、") || "无"}。结构校验：${report.structure_status}；视觉核验：尚未执行。规则置信值不是格式正确率。`;
});
byId("diagnosticDownload").addEventListener("click", () => {
  if (current) download(new Blob([JSON.stringify(buildDiagnosticReport(current.model, current.validations), null, 2)], { type: "application/json" }), "Munword_诊断报告.json");
});
byId("showActualPages").addEventListener("click", async () => {
  if (!current) return;
  const selected = current;
  const parent = byId("actualPages"); parent.replaceChildren();
  for (const [label, blob] of [["原稿页面", selected.file], ["成稿页面", selected.output]] as const) {
    if (!blob) continue;
    const article = document.createElement("article"); article.className = "docxPreview";
    const title = document.createElement("h4"); title.textContent = label;
    const frame = document.createElement("iframe"); frame.sandbox.add("allow-same-origin"); frame.title = label;
    article.appendChild(title); article.appendChild(frame); parent.appendChild(article);
    try { await renderPreview(blob, frame, () => current === selected); }
    catch (error) { title.textContent = `${label}：${error instanceof Error ? error.message : "预览失败"}`; }
  }
});
byId("newDocumentGenerate").addEventListener("click", () => {
  try {
    const input = Object.fromEntries(["language", "committee", "topic", "country", "delegate", "sponsors", "signatories", "body"].map(key => [key, (byId("new_" + key) as HTMLInputElement).value])) as TemplateInput;
    const result = generateFromTemplate(type, input);
    download(result.blob, result.filename);
    byId("newDocumentStatus").textContent = "已生成规范文件，请在 Word / WPS 中检查。";
  } catch (error) { byId("newDocumentStatus").textContent = error instanceof Error ? error.message : "生成失败"; }
});
