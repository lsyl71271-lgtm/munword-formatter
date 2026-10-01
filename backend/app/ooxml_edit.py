from __future__ import annotations

from copy import deepcopy

from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from lxml.etree import tostring

from .docx_view import visible_runs, visible_text
from .fonts import rpr_child


def paragraph_text_nodes(paragraph):
    """Return visible text nodes, including runs inside hyperlinks."""

    nodes = []
    offset = 0
    for run in (item._r for item in visible_runs(paragraph)):
        for text_node in run:
            if text_node.tag in {qn("w:tab"), qn("w:br"), qn("w:cr")}:
                offset += 1
                continue
            if text_node.tag != qn("w:t"):
                continue
            text = text_node.text or ""
            if text:
                nodes.append((run, text_node, offset, offset + len(text)))
                offset += len(text)
    return nodes


def style_text_range(paragraph, start: int, end: int, *, bold=None, italic=None, underline=None) -> bool:
    """Style a plain-text range without clearing the paragraph.

    Simple runs are split in-place when the boundary falls inside a run.  Runs
    containing fields, drawings or breaks are left untouched and return False
    so callers can warn instead of destroying unsupported OOXML.
    """

    if start < 0 or end <= start:
        return False
    touched = False
    for run, text_node, node_start, node_end in list(paragraph_text_nodes(paragraph)):
        overlap_start = max(start, node_start)
        overlap_end = min(end, node_end)
        if overlap_start >= overlap_end:
            continue
        local_start = overlap_start - node_start
        local_end = overlap_end - node_start
        text = text_node.text or ""
        if (local_start or local_end != len(text)) and not _is_simple_text_run(run, text_node):
            return False
        if local_start == 0 and local_end == len(text):
            _set_run_emphasis(run, bold=bold, italic=italic, underline=underline)
            touched = True
            continue
        _split_and_style_run(run, text_node, local_start, local_end, bold=bold, italic=italic, underline=underline)
        touched = True
    return touched


def _is_simple_text_run(run, text_node) -> bool:
    content = [child for child in run if child.tag != qn("w:rPr")]
    return len(content) == 1 and content[0] is text_node


def _split_and_style_run(run, text_node, start, end, *, bold, italic, underline) -> None:
    text = text_node.text or ""
    parent = run.getparent()
    insert_at = parent.index(run)
    pieces = ((text[:start], False), (text[start:end], True), (text[end:], False))
    parent.remove(run)
    for piece, selected in pieces:
        if not piece:
            continue
        clone = deepcopy(run)
        clone_text = next(child for child in clone if child.tag == qn("w:t"))
        clone_text.text = piece
        if piece[:1].isspace() or piece[-1:].isspace():
            clone_text.set(qn("xml:space"), "preserve")
        if selected:
            _set_run_emphasis(clone, bold=bold, italic=italic, underline=underline)
        parent.insert(insert_at, clone)
        insert_at += 1


def _set_run_emphasis(run, *, bold, italic, underline) -> None:
    rpr = run.find(qn("w:rPr"))
    if rpr is None:
        rpr = OxmlElement("w:rPr")
        run.insert(0, rpr)
    _set_boolean_property(rpr, "b", bold)
    _set_boolean_property(rpr, "i", italic)
    _set_boolean_property(rpr, "bCs", bold)
    _set_boolean_property(rpr, "iCs", italic)
    if underline is not None:
        rpr_child(rpr, "u").set(qn("w:val"), "single" if underline else "none")


def _set_boolean_property(rpr, name: str, value) -> None:
    if value is None:
        return
    rpr_child(rpr, name).set(qn("w:val"), "1" if value else "0")


def has_complex_content(paragraph) -> bool:
    """True when flattening this paragraph would discard non-text OOXML."""
    return any(child.tag != qn("w:pPr") and (
        child.tag != qn("w:r") or any(node.tag not in {
            qn("w:rPr"), qn("w:t"), qn("w:tab"), qn("w:br"), qn("w:cr")
        } for node in child)
    ) for child in paragraph._p)


def flattening_is_lossless(paragraph) -> bool:
    """True when rebuilding this paragraph as a single run loses nothing.

    Rewriting a paragraph with ``clear()`` + ``add_run()`` is only safe when it
    carries no non-text OOXML *and* every text-bearing run shares the same run
    properties.  Otherwise the rewrite silently drops images, hyperlinks,
    fields or the author's own bold/italic emphasis.
    """

    if has_complex_content(paragraph):
        return False
    signatures = set()
    for run in paragraph._p.iter(qn("w:r")):
        text = "".join(node.text or "" for node in run if node.tag == qn("w:t"))
        if not text:
            continue
        rpr = run.find(qn("w:rPr"))
        signatures.add(b"" if rpr is None else tostring(rpr))
        if len(signatures) > 1:
            return False
    return True


def edit_visible_text(paragraph, new_text: str) -> bool:
    """Change a paragraph's visible text while keeping every other node.

    The edited span is computed as the difference between the old and new
    text, so trailing punctuation normalization or a stripped list marker only
    touches the text nodes that actually change.  Returns ``False`` without
    modifying anything when the change would cross a tab, a line break or a
    non-text node, so callers can warn instead of destroying content.
    """

    old = visible_text(paragraph)
    if old == new_text:
        return True
    nodes = paragraph_text_nodes(paragraph)
    if not nodes:
        return False

    limit = min(len(old), len(new_text))
    prefix = 0
    while prefix < limit and old[prefix] == new_text[prefix]:
        prefix += 1
    suffix = 0
    while suffix < limit - prefix and old[-1 - suffix] == new_text[-1 - suffix]:
        suffix += 1
    start = prefix
    end = len(old) - suffix
    replacement = new_text[prefix : len(new_text) - suffix]

    targets = []
    covered = 0
    for run, text_node, node_start, node_end in nodes:
        overlap_start = max(start, node_start)
        overlap_end = min(end, node_end)
        if overlap_end > overlap_start:
            covered += overlap_end - overlap_start
            targets.append((text_node, node_start))
        elif start == end and node_start <= start <= node_end and not targets:
            targets.append((text_node, node_start))
    if covered != end - start or not targets:
        return False

    written = False
    for text_node, node_start in targets:
        text = text_node.text or ""
        local_start = min(max(start - node_start, 0), len(text))
        local_end = min(max(end - node_start, 0), len(text))
        piece = "" if written else replacement
        written = True
        updated = text[:local_start] + piece + text[local_end:]
        text_node.text = updated
        if updated[:1].isspace() or updated[-1:].isspace():
            text_node.set(qn("xml:space"), "preserve")
    return visible_text(paragraph) == new_text
