"""Read-only explanations sharing the browser report policy; never changes a model."""
from __future__ import annotations

import json
from pathlib import Path

from .models import IntermediateDocument, ValidationItem

POLICY = json.loads((Path(__file__).resolve().parents[2] / "shared" / "workflow-policy.json").read_text(encoding="utf-8"))


def build_diagnostic_report(model: IntermediateDocument, validations: list[ValidationItem] | None = None) -> dict:
    validations = [] if validations is None else validations
    clauses = sorted(model.preambulatory_clauses + model.operative_clauses + model.body_clauses, key=lambda item: item.paragraph_index)
    return {
        "schema_version": POLICY["schemaVersion"],
        "document_type": model.document_type, "language": model.language,
        "paragraph_count": sum(bool(text.strip()) for text in model.paragraphs),
        "missing_fields": [{"field": key, "label": POLICY["fieldLabels"][key]} for key in POLICY["requiredFields"][model.document_type] if not getattr(model, key)],
        "warnings": model.warnings,
        "clauses": [{"paragraph": item.paragraph_index + 1, "role": item.kind, "level": item.level,
                     "confidence": item.confidence, "text": item.text,
                     "reason": POLICY["roleReasons"].get(item.kind, POLICY["roleReasons"]["unknown"])} for item in clauses],
        "validations": [item.to_dict() for item in validations],
        "structure_status": ("failed" if any(item.status == "error" for item in validations) else "checked") if validations else "not_run",
        "visual_status": "not_run", "limitations": POLICY["limitations"],
        "repair_actions": model.repair_actions,
    }
