"""One formatter per document type.

``base``            shared pipeline, page/font/metadata handling and validation
``mixins``          adaptive body size; operative-clause numbering and punctuation
``position_paper``  立场文件 / Position Paper
``working_paper``   工作文件 / Working Paper
``draft_directive`` 指令草案 / Draft Directive
``draft_resolution`` 决议草案 / Draft Resolution
``amendment``       友好 / 非友好修正案
``treaty``          外交协定 / 联合声明
"""

from .amendment import AmendmentFormatter, FriendlyAmendmentFormatter, UnfriendlyAmendmentFormatter
from .base import BaseFormatter, Layout
from .draft_directive import DraftDirectiveFormatter
from .draft_resolution import DraftResolutionFormatter
from .position_paper import PositionPaperFormatter
from .treaty import DiplomaticAgreementFormatter, JointStatementFormatter, TreatyFormatter
from .working_paper import WorkingPaperFormatter

__all__ = [
    "AmendmentFormatter",
    "BaseFormatter",
    "DraftDirectiveFormatter",
    "DiplomaticAgreementFormatter",
    "DraftResolutionFormatter",
    "FriendlyAmendmentFormatter",
    "JointStatementFormatter",
    "Layout",
    "PositionPaperFormatter",
    "TreatyFormatter",
    "UnfriendlyAmendmentFormatter",
    "WorkingPaperFormatter",
]
