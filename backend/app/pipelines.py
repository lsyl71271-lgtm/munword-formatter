from __future__ import annotations

import re
from collections import Counter
from io import BytesIO
from pathlib import Path

from docx import Document

from .formatters import (
    DiplomaticAgreementFormatter,
    DraftDirectiveFormatter,
    DraftResolutionFormatter,
    FriendlyAmendmentFormatter,
    JointStatementFormatter,
    PositionPaperFormatter,
    UnfriendlyAmendmentFormatter,
    WorkingPaperFormatter,
)
from . import content_guard
from .errors import InvalidRequestError
from .docx_package import validate_docx_package
from .models import FormatResult, IntermediateDocument, ValidationItem
from .parser import DocxParser
from .structure_repair import repair_structure_with_report
from .treaty import is_treaty


# Fields the step-03 review screen may change.
OVERRIDABLE_FIELDS = ("language", "title", "committee", "topic", "delegate", "country", "sponsors", "signatories")
FILENAME_PREFIXES = {
    "position-paper": {"zh": "立场文件", "en": "Position Paper"},
    "working-paper": {"zh": "工作文件", "en": "WP"},
    "draft-directive": {"zh": "指令草案", "en": "Draft Directive"},
    "draft-resolution": {"zh": "决议草案", "en": "Draft Resolution"},
    "friendly-amendment": {"zh": "友好修正案", "en": "Friendly Amendment"},
    "unfriendly-amendment": {"zh": "非友好修正案", "en": "Unfriendly Amendment"},
    "diplomatic-agreement": {"zh": "外交协定", "en": "Diplomatic Agreement"},
    "joint-statement": {"zh": "联合声明", "en": "Joint Statement"},
}
_UNSAFE_FILENAME_RE = re.compile(r"[\\/:*?\"<>|\x00-\x1f\x7f]")


class BasePipeline:
    formatter_class = PositionPaperFormatter
    document_type = "position-paper"

    def __init__(self, template_dir: Path):
        self._repair_problems: list[str] = []
        self.parser = DocxParser()
        self.formatter = self.formatter_class(template_dir)

    def parse(self, content: bytes) -> IntermediateDocument:
        return self._analyze(content)[1]

    def _analyze(self, content: bytes) -> tuple[bytes, IntermediateDocument]:
        """Repair high-confidence structural loss, then parse the repaired bytes."""

        validate_docx_package(content)
        if is_treaty(self.document_type):
            # No clause structure to repair: the title and signature block are read as written.
            self._repair_problems = []
            return content, self.parser.parse(content, self.document_type)
        repair = repair_structure_with_report(content, self.document_type)
        model = self.parser.parse(repair.content, self.document_type)
        model.repair_actions = [action.to_dict() for action in repair.actions]
        model.warnings.extend(repair.warnings)
        self._repair_problems = self._verify_repair(content, repair)
        return repair.content, model

    @staticmethod
    def _verify_repair(content: bytes, repair) -> list[str]:
        """Strict check of the structure-repair step (see ``content_guard.verify_repair``)."""

        if repair.content == content:
            return []
        inserted = []
        for action in repair.actions:
            if action.applied:
                added = Counter(action.after) - Counter(action.before)
                inserted.append("".join(added.elements()))
        before = content_guard.document_tokens(Document(BytesIO(content)))
        after = content_guard.document_tokens(Document(BytesIO(repair.content)))
        return content_guard.verify_repair(before, after, inserted)

    def run(
        self,
        content: bytes,
        overrides: dict | None = None,
        preserve_country_order: bool = False,
        normalize_punctuation: bool = True,
        session_label: str = "",
        submitting_country: str = "",
        version: str = "v1",
        source_name: str = "",
    ) -> FormatResult:
        effective_content, model = self._analyze(content)
        original_fields = {key: getattr(model, key) for key in OVERRIDABLE_FIELDS}
        self._apply_overrides(model, {} if overrides is None else overrides)
        changed_fields = {key for key, value in original_fields.items() if getattr(model, key) != value}
        output, validations, before, after = self.formatter.format(
            effective_content,
            model,
            preserve_country_order=preserve_country_order,
            normalize_punctuation=normalize_punctuation,
            changed_fields=changed_fields,
        )
        applied = [action["code"] for action in model.repair_actions if action.get("applied")]
        if applied:
            notes = {"自动编号首项丢失": "恢复被删除的自动编号首项", "立场文件缺失首节序号": "补齐（一）标记"}
            record = next((item for item in validations if item.code == "structural_edits"), None)
            if record is not None:
                extra = list(dict.fromkeys(notes.get(code, "拆分嵌套条款" if "条款标记" in code else code) for code in applied))
                record.detail = "；".join(extra + ([record.detail] if record.status == "warning" else []))
                record.status = "warning"
        if self._repair_problems:
            validations.append(ValidationItem(
                "repair-content", "结构修复严格内容校验", "error", "；".join(self._repair_problems[:6])
            ))
        filename = self.filename(model, session_label, submitting_country, version, source_name)
        return FormatResult(output, filename, model, validations, before, after)

    @staticmethod
    def _apply_overrides(model: IntermediateDocument, overrides: dict) -> None:
        if not isinstance(overrides, dict):
            raise InvalidRequestError("识别结果必须是 JSON 对象。")
        for key, value in overrides.items():
            if not isinstance(key, str):
                raise InvalidRequestError("字段名必须是字符串。")
            snake_key = re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower()
            if snake_key not in OVERRIDABLE_FIELDS:
                raise InvalidRequestError(f"不允许修改字段：{key}")
            if snake_key in {"sponsors", "signatories"}:
                if not isinstance(value, list) or len(value) > 300 or any(not isinstance(item, str) or len(item) > 200 for item in value):
                    raise InvalidRequestError(f"{key} 必须是国家名称字符串列表。")
            elif not isinstance(value, str) or len(value) > 5000:
                raise InvalidRequestError(f"{key} 必须是不超过 5000 字符的文本。")
            if snake_key == "language" and value not in {"zh", "en"}:
                raise InvalidRequestError("语言只能为 zh 或 en。")
            if any(re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]", item) for item in (value if isinstance(value, list) else [value])):
                raise InvalidRequestError(f"{key} 含有 XML 不支持的字符，请删除无效字符后重试。")
            setattr(model, snake_key, value)

    def filename(self, model: IntermediateDocument, session_label: str, submitting_country: str, version: str, source_name: str = "") -> str:
        # A draft resolution keeps the name of the uploaded file (browser ``outputFilename``).
        source = re.sub(r"\.docx$", "", source_name.strip(), flags=re.I)
        if self.document_type == "draft-resolution" and _UNSAFE_FILENAME_RE.sub("-", source).strip()[:180]:
            return _UNSAFE_FILENAME_RE.sub("-", source).strip()[:180] + ".docx"
        country = re.sub(r"^the\s+", "", submitting_country or model.country or (model.sponsors[0] if model.sponsors else "待填写国家"), flags=re.I)
        parts = [FILENAME_PREFIXES[self.document_type]["zh" if model.language == "zh" else "en"]]
        if session_label:
            parts.append(session_label)
        parts.extend([country, version or "v1"])
        return _UNSAFE_FILENAME_RE.sub("-", " ".join(parts)).strip()[:180] + ".docx"


class PositionPaperPipeline(BasePipeline):
    formatter_class = PositionPaperFormatter
    document_type = "position-paper"


class WorkingPaperPipeline(BasePipeline):
    formatter_class = WorkingPaperFormatter
    document_type = "working-paper"


class DraftDirectivePipeline(BasePipeline):
    formatter_class = DraftDirectiveFormatter
    document_type = "draft-directive"


class DraftResolutionPipeline(BasePipeline):
    formatter_class = DraftResolutionFormatter
    document_type = "draft-resolution"


class FriendlyAmendmentPipeline(BasePipeline):
    formatter_class = FriendlyAmendmentFormatter
    document_type = "friendly-amendment"


class UnfriendlyAmendmentPipeline(BasePipeline):
    formatter_class = UnfriendlyAmendmentFormatter
    document_type = "unfriendly-amendment"


class DiplomaticAgreementPipeline(BasePipeline):
    formatter_class = DiplomaticAgreementFormatter
    document_type = "diplomatic-agreement"


class JointStatementPipeline(BasePipeline):
    formatter_class = JointStatementFormatter
    document_type = "joint-statement"


PIPELINES = {
    "position-paper": PositionPaperPipeline,
    "working-paper": WorkingPaperPipeline,
    "draft-directive": DraftDirectivePipeline,
    "draft-resolution": DraftResolutionPipeline,
    "friendly-amendment": FriendlyAmendmentPipeline,
    "unfriendly-amendment": UnfriendlyAmendmentPipeline,
    "diplomatic-agreement": DiplomaticAgreementPipeline,
    "joint-statement": JointStatementPipeline,
}
