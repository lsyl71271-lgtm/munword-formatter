from __future__ import annotations

from .base import BaseFormatter



class AmendmentFormatter(BaseFormatter):
    """Title and role rules shared by friendly and unfriendly amendments.

    The header is set at body size like the rest of the document (页52–53);
    the operation verb of each instruction is italic (handbook pass).
    """

    title_zh = "修正案"
    title_en = "Amendment"


class FriendlyAmendmentFormatter(AmendmentFormatter):
    document_type = "friendly-amendment"
    title_zh = "友好修正案"
    title_en = "Friendly Amendment"

    def _format_document(self, document, model, preserve_country_order, normalize_punctuation):
        # Operation numbers ("1.") stay as typed; the handbook pass indents
        # them and italicizes the operation verb after the number.
        self._apply_common_roles(document, model, preserve_country_order)


class UnfriendlyAmendmentFormatter(AmendmentFormatter):
    document_type = "unfriendly-amendment"
    title_zh = "非友好修正案"
    title_en = "Unfriendly Amendment"

    def _format_document(self, document, model, preserve_country_order, normalize_punctuation):
        self._apply_common_roles(document, model, preserve_country_order)
