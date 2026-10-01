"""Behaviour shared by several, but not all, document types.

These used to be reached through an inheritance chain
(``DraftResolution → DraftDirective → WorkingPaper → Base``) whose members had
to call ``BaseFormatter._format_document(self, ...)`` directly to skip their
parents.  Each concrete formatter now opts into exactly the pieces it uses.
"""

from __future__ import annotations

from docx.document import Document as DocumentObject

from ..docx_view import visible_text
from ..models import IntermediateDocument
from ..parser import MANUAL_NUMBER_RE
from ..semantic_policy import clause_prefixes
from .base import longest_prefix


class OperativeClausesMixin:
    """Common roles and the operative-verb check.

    Used by draft directives, and by English draft resolutions.  Layout,
    emphasis and clause endings come from the handbook pass.
    """

    def _format_operative_document(
        self,
        document: DocumentObject,
        model: IntermediateDocument,
        preserve_country_order: bool,
        normalize_punctuation: bool,
    ) -> None:
        self._apply_common_roles(document, model, preserve_country_order)
        # Clause numbers stay as the author wrote them: typed markers remain
        # text and Word lists keep their own values, starts and restarts.
        self._check_operative_verbs(document, model)

    def _check_operative_verbs(self, document: DocumentObject, model: IntermediateDocument) -> None:
        """Warn about top-level clauses that do not open with an operative verb."""

        phrases = clause_prefixes(model.language)[1]
        operative = sorted(
            model.operative_clauses + [clause for clause in model.body_clauses if clause.kind != "heading"],
            key=lambda clause: clause.paragraph_index,
        )
        for clause in operative:
            paragraph = self._paragraph_at(document, clause.paragraph_index)
            if paragraph is None or clause.level != 0:
                continue
            text = visible_text(paragraph)
            marker = MANUAL_NUMBER_RE.match(text)
            start = marker.end() if marker else len(text) - len(text.lstrip())
            if not longest_prefix(text[start:], phrases, casefold=True):
                model.warnings.append(f"第 {clause.paragraph_index + 1} 段疑似缺少行动动词。")
