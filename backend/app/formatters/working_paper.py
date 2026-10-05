from __future__ import annotations

from .base import BaseFormatter


class WorkingPaperFormatter(BaseFormatter):
    document_type = "working-paper"
    title_zh = "工作文件"
    title_en = "Working Paper"

    def _format_document(self, document, model, preserve_country_order, normalize_punctuation):
        # Never invent signatories, but retain an existing explicitly labeled
        # list for safe normalization. The parser warns that WP normally has none.
        self._apply_common_roles(document, model, preserve_country_order)
        self._clear_formatting_noise(document, model.language, clear_emphasis=True)
        # The cleanup intentionally neutralizes all character emphasis; the
        # title and metadata roles are styled again here and every paragraph's
        # final layout comes from the handbook pass.
        self._format_title(document, model)
        self._format_metadata(document, model, preserve_country_order)
        # Preserve literal markers and any existing OOXML numbering.  Replacing
        # both with a newly generated list changed what WPS displayed and made
        # manually audited numbering impossible to compare.
