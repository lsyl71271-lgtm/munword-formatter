import rules from "../shared/workflow-policy.json" with { type: "json" };
import type { BrowserModel, BrowserValidation } from "./docx-browser.ts";

/** Read-only explanation of the existing engine result, not a second classifier. */
export function buildDiagnosticReport(model: BrowserModel, validations: BrowserValidation[] = []) {
  const clauses = [...model.preambulatory_clauses, ...model.operative_clauses, ...model.body_clauses]
    .sort((a, b) => a.paragraph_index - b.paragraph_index);
  const missing = rules.requiredFields[model.document_type].filter(key => {
    const value = model[key as keyof BrowserModel];
    return !value || (Array.isArray(value) && !value.length);
  });
  return {
    schema_version: rules.schemaVersion,
    document_type: model.document_type,
    language: model.language,
    paragraph_count: model.paragraphs.filter(text => text.trim()).length,
    missing_fields: missing.map(key => ({ field: key, label: rules.fieldLabels[key as keyof typeof rules.fieldLabels] })),
    warnings: model.warnings,
    clauses: clauses.map(clause => ({
      paragraph: clause.paragraph_index + 1, role: clause.kind, level: clause.level,
      confidence: clause.confidence, text: clause.text,
      reason: rules.roleReasons[clause.kind as keyof typeof rules.roleReasons] || rules.roleReasons.unknown,
    })),
    validations,
    structure_status: validations.length ? (validations.some(item => item.status === "error") ? "failed" : "checked") : "not_run",
    visual_status: "not_run",
    limitations: rules.limitations,
  };
}
