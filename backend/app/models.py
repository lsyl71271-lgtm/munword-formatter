from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal


DocumentType = Literal[
    "position-paper",
    "working-paper",
    "draft-directive",
    "draft-resolution",
    "friendly-amendment",
    "unfriendly-amendment",
    "diplomatic-agreement",
    "joint-statement",
]


@dataclass
class Clause:
    text: str
    level: int = 0
    kind: Literal["body", "preambulatory", "operative", "heading", "unknown"] = "body"
    paragraph_index: int = 0
    confidence: float = 1.0


@dataclass
class IntermediateDocument:
    document_type: DocumentType
    language: Literal["zh", "en"]
    title: str = ""
    committee: str = ""
    topic: str = ""
    delegate: str = ""
    country: str = ""
    sponsors: list[str] = field(default_factory=list)
    signatories: list[str] = field(default_factory=list)
    preambulatory_clauses: list[Clause] = field(default_factory=list)
    operative_clauses: list[Clause] = field(default_factory=list)
    body_clauses: list[Clause] = field(default_factory=list)
    max_numbering_level: int = 0
    warnings: list[str] = field(default_factory=list)
    paragraphs: list[str] = field(default_factory=list)
    header_paragraph_indices: dict[str, int] = field(default_factory=dict)
    metadata_paragraph_indices: dict[str, list[int]] = field(default_factory=dict)
    repair_actions: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ValidationItem:
    code: str
    label: str
    status: Literal["pass", "warning", "error"]
    detail: str = ""

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass
class FormatResult:
    content: bytes
    filename: str
    model: IntermediateDocument
    validations: list[ValidationItem]
    content_before: str
    content_after: str
