from __future__ import annotations

from .base import BaseFormatter
from .mixins import OperativeClausesMixin


class DraftDirectiveFormatter(OperativeClausesMixin, BaseFormatter):
    document_type = "draft-directive"
    title_zh = "指令草案"
    title_en = "Draft Directive"

    def _format_document(self, document, model, preserve_country_order, normalize_punctuation):
        self._format_operative_document(document, model, preserve_country_order, normalize_punctuation)
