"""The three ways a request can fail, reported differently to the user.

* ``InvalidDocxError`` — the upload is not a readable DOCX (damaged,
  encrypted, unsafe package).  The file's fault.  ``InvalidRequestError``
  likewise marks malformed step-03 fields.
* ``ProtectedContentError`` — a requested change would have to rewrite a
  paragraph holding content that cannot be edited safely (image, field,
  tracked change).  Nothing is output; the paragraph and reason are named.
* Anything else raised while processing a valid DOCX is a program defect and
  is reported as such, never disguised as a "complex file".
"""

from __future__ import annotations


class InvalidDocxError(ValueError):
    """The upload cannot be read as a DOCX package."""


class InvalidRequestError(ValueError):
    """The step-03 fields sent with a request are malformed."""


class ProtectedContentError(Exception):
    """A required rewrite was refused to protect a paragraph's content."""

    def __init__(self, paragraph_number: int, reason: str):
        self.paragraph_number = paragraph_number
        self.reason = reason
        super().__init__(f"第 {paragraph_number} 段：{reason}")
