"""Strict content check: formatting may change how content looks, never what it is.

A paragraph's *signature* is a sequence of typed tokens:

* ``("t", ch)``  one character of visible text (``w:t``);
* ``("dt", s)``  deleted revision text (``w:delText``);
* ``("s", tag, attrs)`` / ``("e", tag)``  start / end of every other node,
  with its full namespaced tag and all attributes (namespaced), so field
  codes, hyperlinks and their relationship ids, bookmarks, footnote and
  comment references, tracked changes, drawings, tabs and breaks count;
* ``("x", s)``  text held by a non-text node (a field code).

Formatting (``pPr`` / ``rPr`` / table properties) and run boundaries are left
out; Word's revision-save ids (``rsid*``, ``paraId``, ``textId``) are ignored.
Tokens are tuples, never a mixed string, so text that looks like markup
cannot be confused with structure.

The formatter logs every deliberate edit with the exact result it is
authorized to produce.  A paragraph whose signature changed without a logged
edit, or whose result differs from the authorized one, is a content change:
the output is withheld and the paragraph is named.  Package-level checks
compare every relationship (``Id`` → ``Target``, ``TargetMode``, ``Type``)
and every embedded resource byte for byte.
"""

from __future__ import annotations

from .field_policy import is_plain_field
from .numbering import apply_native_rules, valid_marker_change

import difflib
import hashlib
import json
import re
import zipfile
from collections import Counter
from dataclasses import dataclass
from io import BytesIO
from .errors import InvalidDocxError

from lxml import etree
from docx.oxml.ns import qn
from .countries import plan_countries, split_country_names, valid_country_field_change
from .semantic_policy import TREATIES

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_W = f"{{{W_NS}}}"
_FORMATTING = frozenset(_W + tag for tag in ("pPr", "rPr", "tblPr", "trPr", "tcPr", "tblGrid", "sectPr", "tblPrEx"))
_RUN = _W + "r"
_TEXT = _W + "t"
_DELETED_TEXT = _W + "delText"
_IGNORED_ATTRIBUTES = re.compile(r"(?:}|^)(?:rsid\w*|paraId|textId)$")
_ENDING_CHARS = frozenset("，,；;。.:：、 \t")
_LEADING_MARKER_RE = re.compile(r"^(\s*)(\d+)\s*[.、．)）]\s*\t?")


def _attributes(node) -> tuple:
    return tuple(sorted((key, value) for key, value in node.attrib.items() if not _IGNORED_ATTRIBUTES.search(key)))


def _tokens(node, out: list) -> None:
    for child in node:
        tag = child.tag
        if not isinstance(tag, str) or tag in _FORMATTING:
            continue
        if tag == _RUN:
            _tokens(child, out)
        elif tag == _TEXT:
            out.extend(("t", ch) for ch in (child.text or ""))
        elif tag == _DELETED_TEXT:
            out.append(("dt", child.text or ""))
        else:
            out.append(("s", tag, _attributes(child)))
            # The node's own text nodes (a field code).  ``child.text`` is not
            # used: python-docx element classes override it (a hyperlink's
            # ``.text`` is its visible text, which is not structure).
            own = "".join(child.xpath("text()"))
            if own.strip():
                out.append(("x", own))
            _tokens(child, out)
            out.append(("e", tag))


def signature(element) -> tuple:
    tokens: list = []
    _tokens(element, tokens)
    return tuple(tokens)


def element_text(element) -> str:
    """Visible text of a paragraph (deleted revisions excluded)."""

    parts = []
    for node in element.iter(_TEXT, _W + "tab", _W + "br", _W + "cr"):
        ancestor = node.getparent()
        hidden = False
        while ancestor is not None and ancestor is not element:
            if ancestor.tag in (_W + "del", _W + "moveFrom"):
                hidden = True
                break
            ancestor = ancestor.getparent()
        if hidden:
            continue
        parts.append(node.text or "" if node.tag == _TEXT else ("\t" if node.tag == _W + "tab" else "\n"))
    return "".join(parts)


def structure_of(element) -> tuple:
    """Everything in a paragraph's content except its visible characters."""

    return _structure_only(signature(element))


def rewrite_keeps_structure(kind: str, old: tuple, new: tuple) -> bool:
    """True when a rewrite of ``kind`` left every non-text node in place.

    A marker rewrite may turn "1. " into "1、⇥"; the tab it adds is part of
    the marker, not new structure.
    """

    if kind == "marker":
        return _structure_only(_normalize_marker(old)) == _structure_only(_normalize_marker(new))
    return _structure_only(old) == _structure_only(new)


_REVISIONS = frozenset(_W + tag for tag in ("ins", "del", "moveFrom", "moveTo"))


def _structure_only(sig: tuple) -> tuple:
    """Non-text tokens, plus every character inside a tracked revision.

    Text a reviewer inserted or deleted belongs to the revision: an edit that
    adds a label to it, drops a word from it or moves a character across its
    boundary rewrites the revision itself, so it counts as structure.
    """

    kept = []
    depth = 0
    for token in sig:
        if token[0] == "s" and token[1] in _REVISIONS:
            depth += 1
        elif token[0] == "e" and token[1] in _REVISIONS:
            depth -= 1
        if token[0] != "t" or depth:
            kept.append(token)
    return tuple(kept)


_WHITESPACE_NODES = frozenset({("s", _W + "tab", ()), ("e", _W + "tab"), ("s", _W + "br", ()), ("e", _W + "br"),
                               ("s", _W + "cr", ()), ("e", _W + "cr")})


def is_whitespace(sig: tuple) -> bool:
    """Only spaces, tabs and line breaks: an empty line, not content."""

    return all((token[0] == "t" and token[1].isspace()) or token in _WHITESPACE_NODES for token in sig)


def _is_plain(sig: tuple) -> bool:
    return all(token[0] == "t" for token in sig)


_BLOCKS = (_W + "p", _W + "tbl")
_WRAPPERS = frozenset(_W + tag for tag in ("sdt", "sdtContent", "customXml"))


def _blocks_in(container) -> list:
    out = []
    for child in container:
        if child.tag in _BLOCKS:
            out.append(child)
        elif child.tag in _WRAPPERS:
            out.extend(_blocks_in(child))
    return out


def body_blocks(document) -> list:
    """Paragraphs and tables of the body, through content controls and custom XML.

    A content control's paragraphs are running text: checking only the body's
    direct children let any change inside one pass unnoticed.
    """

    return _blocks_in(document.element.body)


def _wrappers(document) -> list:
    """Each block-level wrapper with its own properties (not its content)."""

    out = []
    for element in document.element.body.iter(*_WRAPPERS):
        if element.tag == _W + "sdtContent":
            continue
        own = [child for child in element if child.tag not in _WRAPPERS and child.tag not in _BLOCKS]
        out.append((element.tag, _attributes(element), tuple(signature(child) for child in own)))
    return out


@dataclass
class Snapshot:
    order: list
    signatures: dict
    texts: dict
    numbering: dict
    wrappers: list

    @classmethod
    def take(cls, document) -> "Snapshot":
        order = body_blocks(document)
        return cls(
            order, {el: signature(el) for el in order}, {el: element_text(el) for el in order},
            {el: _list_membership(el) for el in order}, _wrappers(document),
        )


def _list_membership(element):
    result = []
    for paragraph in ([element] if element.tag == qn("w:p") else element.iter(qn("w:p"))):
        num = paragraph.find(f"{qn('w:pPr')}/{qn('w:numPr')}")
        identifier = num.find(qn("w:numId")) if num is not None else None
        identifier = identifier.get(qn("w:val")) if identifier is not None else None
        level = num.find(qn("w:ilvl")) if num is not None else None
        result.append((identifier, level.get(qn("w:val")) if level is not None else "0") if identifier not in (None, "0") else None)
    return tuple(result)


@dataclass(frozen=True)
class Edit:
    """One authorized edit: its kind and, where it has one, the exact result."""

    kind: str
    key: str = ""
    expected: str | None = None
    created: bool = False
    country: dict | None = None


def verify_format(before: Snapshot, document, edit_log: dict, *, allowed_titles: tuple, labels: tuple) -> list:
    """Problems comparing ``before`` with the formatted document, as user-facing text."""

    after_order = body_blocks(document)
    after_set = set(after_order)
    before_set = set(before.order)
    number = {el: index + 1 for index, el in enumerate(before.order)}
    problems: list = []
    if _wrappers(document) != before.wrappers:
        problems.append("内容控件或自定义 XML 容器发生变化")
    country_groups: dict = {}
    signature_block: dict = {"removed": [], "created": [], "expected": None}

    def group_of(edit):
        return country_groups.setdefault(edit.key, {"before": [], "after": [], "expected": edit.expected, "country": edit.country})

    for el in before.order:
        edit = edit_log.get(el)
        if edit and edit.kind == "countries":
            group = group_of(edit)
            group["before"].append(el)
            if el in after_set:
                group["after"].append(el)
        if edit and edit.kind == "signature" and el not in after_set:
            signature_block["removed"].append(el)
            continue
        if el not in after_set:
            removable = (edit and edit.kind == "countries") or (
                edit and edit.kind == "empty-line" and is_whitespace(before.signatures[el])
            )
            if before.signatures[el] and not removable:
                problems.append(f"第 {number[el]} 段被删除：{before.texts[el][:30]}")
            continue
        if before.numbering[el] != _list_membership(el):
            problems.append(f"第 {number[el]} 段的原生列表归属或层级发生变化，可能改变条号及交叉引用")
        old, new = before.signatures[el], signature(el)
        if old == new:
            continue
        if edit is None:
            problems.append(f"第 {number[el]} 段内容发生未经许可的变化：{_short_diff(before.texts[el], element_text(el))}")
            continue
        reason = _check_edit(edit, old, new, before.texts[el], element_text(el), allowed_titles, labels)
        if reason:
            problems.append(f"第 {number[el]} 段（{edit.kind}）{reason}")

    for el in after_order:
        if el in before_set:
            continue
        edit = edit_log.get(el)
        if edit is None or not edit.created:
            problems.append(f"输出中出现来源不明的段落：{element_text(el)[:30]}")
        elif edit.kind == "blank":
            if signature(el):
                problems.append("新增空行含有内容")
        elif edit.kind == "countries":
            group_of(edit)["after"].append(el)
        elif edit.kind == "signature":
            signature_block["created"].append(el)
            signature_block["expected"] = edit.expected
        else:
            problems.append(f"输出中新增段落的类型不被允许：{edit.kind}")
    if signature_block["removed"] or signature_block["created"]:
        problems.extend(_check_signature_block(before, signature_block["removed"], signature_block["created"], signature_block["expected"]))

    position = {el: index for index, el in enumerate(after_order)}
    for key, group in country_groups.items():
        after_group = sorted(group["after"], key=position.__getitem__)
        changed = [el for el in after_group if el not in before_set or signature(el) != before.signatures[el]]
        for el in changed:
            if not _is_plain(signature(el)):
                problems.append(f"{key} 名单段落含有文字以外的内容")
        new_text = "".join(element_text(el) for el in after_group)
        if any(not is_plain_field(before.signatures[el]) for el in group["before"]):
            problems.append(f"{key} 原名单含复杂结构，不能授权名称替换")
        country = group["country"]
        if country and not country["manual"]:
            originals = _country_name_list([before.texts[el] for el in group["before"]])
            permitted = plan_countries(originals, country["language"], country["preserveOrder"])["values"]
            if _country_name_list([new_text]) != permitted:
                problems.append(f"{key} 名单包含无法由原字段和共用国家表证明的名称变更、删除或排序")
        elif not country and _country_names([before.texts[el] for el in group["before"]]) != _country_names([new_text]):
            problems.append(f"{key} 名单名称变化缺少国家表证明或第 03 步人工授权")
        if group["expected"] is not None:
            # A rewritten list must read exactly as authorized: the label and
            # the recognized (or step-03 confirmed) names, nothing else.
            if _squash(new_text) != _squash(group["expected"]):
                problems.append(f"{key} 名单文字与预期不符：{new_text[:40]}")
        else:
            old_names = _country_names([before.texts[el] for el in group["before"]])
            new_names = _country_names([element_text(el) for el in after_group])
            if old_names != new_names:
                missing = list((old_names - new_names).elements())
                added = list((new_names - old_names).elements())
                problems.append(f"{key} 名单与原文不一致：缺少 {missing[:5]}，多出 {added[:5]}")

    survivors = [el for el in after_order if el in before_set]
    if survivors != [el for el in before.order if el in after_set]:
        problems.append("段落顺序发生变化")
    return problems


def _check_edit(edit: Edit, old, new, old_text, new_text, allowed_titles, labels) -> str:
    """Empty when ``old`` → ``new`` is exactly what ``edit`` authorizes."""

    kind = edit.kind
    if kind == "ending":
        return "" if _without_ending(old) == _without_ending(new) else "句末以外的内容发生变化"
    if kind == "marker":
        return "" if _normalize_marker(old) == _normalize_marker(new) else "编号以外的内容发生变化"
    if kind in ('dr-marker','list-marker'):
        return '' if _is_plain(old) and _is_plain(new) and valid_marker_change(old_text,new_text) else '编号转换改变了条号数值、正文或受保护结构'
    if kind in ("countries", "signature"):
        return ""  # checked per list / per block in ``verify_format``
    if kind == "statement-number":
        ok = (edit.expected is not None and new_text == edit.expected and _STATEMENT_NUMBER.match(new_text)
              and _STATEMENT_NUMBER.sub("", new_text, count=1) == old_text and _structure_only(old) == _structure_only(new))
        return "" if ok else "编号以外的内容发生变化"
    if kind == "country-name":
        return "" if is_plain_field(old) and _is_plain(new) and edit.country and not edit.country["manual"] and valid_country_field_change(old_text, new_text, edit.country["language"]) else "国家全称变更不能由共用名称表从原字段证明"
    if not (kind == "field" and is_plain_field(old) and _is_plain(new)) and _structure_only(old) != _structure_only(new):
        return "图片、域、链接或修订等内容结构发生变化"
    if kind == "title":
        old_word = _longest_prefix(old_text.strip(), allowed_titles)
        new_word = _longest_prefix(new_text.strip(), allowed_titles)
        if old_word is None or new_word is None or old_text.strip()[len(old_word):] != new_text.strip()[len(new_word):]:
            return "标题编号或其他文字发生变化"
        return ""
    if kind == "label-drop":
        match = re.match(rf"^\s*(?:{'|'.join(map(re.escape, labels))})\s*[:：]\s*(.*)$", old_text, re.S)
        return "" if match and match.group(1).strip() == new_text.strip() else "删除标签时正文发生变化"
    if kind in ("label-restore", "field"):
        # The authorized result is exact: the label and the recognized value
        # (label-restore) or the value confirmed in step 03 (field).
        if edit.expected is None or new_text.strip() != edit.expected.strip():
            return f"改写结果与授权值不符：应为“{(edit.expected or '')[:30]}”"
        if kind == "field" and not _is_plain(new):
            return "改写后的元数据段含有文字以外的内容"
        if kind == "label-restore" and not edit.expected.strip().endswith(old_text.strip().lstrip(":： ")):
            return "补标签时原有文字发生变化"
        return ""
    return f"未知的编辑类型 {kind}"


# A joint statement paragraph may gain only a leading "N. " (shared/document-policy.json treaties).
_STATEMENT_NUMBER = re.compile(r"^\d{1,3}\. ")
_SIGNATURE_LABEL = (
    re.compile(TREATIES["signature"]["labelPattern"]["zh"]),
    re.compile(TREATIES["signature"]["labelPattern"]["en"], re.I),
)


def _is_signature_label(token: str) -> bool:
    return any(pattern.search(token) for pattern in _SIGNATURE_LABEL)


def _signature_tokens(text: str) -> list:
    """Names and labels of a signature line: Chinese splits at any space, other text at tabs or wider gaps (names have single spaces)."""

    parts = re.split(r"[\s\u3000]+", text) if re.search(r"[\u3400-\u9fff]", text) else re.split(r"\t+|\s{2,}|\u3000+", text)
    return [part.strip() for part in parts if part.strip()]


def _text_and_spacing(sig: tuple) -> bool:
    return all(token[0] == "t" or token in _WHITESPACE_NODES for token in sig)


def _check_signature_block(before: Snapshot, removed: list, created: list, expected) -> list:
    """A rebuilt signature block: only the representatives' labels it lists may be added; every name and
    every label of the original block stays (shared/document-policy.json treaties.signature)."""

    problems: list = []
    labels: list = []
    try:
        labels = json.loads(expected or "[]")
    except ValueError:
        problems.append("签字栏授权记录损坏")
    if any(not _text_and_spacing(before.signatures[el]) for el in removed):
        problems.append("签字栏原稿含有文字以外的内容，不能重建")
    if any(not _text_and_spacing(signature(el)) for el in created):
        problems.append("重建的签字栏含有文字以外的内容")
    old = [token for el in removed for token in _signature_tokens(before.texts[el])]
    now = [token.strip() for el in created for token in re.split(r"[\t\n]", element_text(el)) if token.strip()]
    allowed = set(labels)
    now_labels = [token for token in now if token in allowed]
    now_names = [token for token in now if token not in allowed]
    if now_labels != labels:
        problems.append("签字栏的代表与授权的签署方不一致")
    if Counter(token for token in old if _is_signature_label(token)) - Counter(now_labels):
        problems.append("签字栏原有的代表被删除或改写")
    if Counter(token for token in old if not _is_signature_label(token)) != Counter(now_names):
        problems.append("签字栏的姓名被删除、改写或新增")
    return problems


def _longest_prefix(text: str, words):
    return next((word for word in sorted(words, key=len, reverse=True) if text.casefold().startswith(word.casefold())), None)


def _without_ending(sig: tuple) -> tuple:
    """The signature without the trailing punctuation of its visible text.

    The clause ending is the end of the last visible text, which may be
    followed by a picture or a field result.
    """

    tokens = list(sig)
    # Text of a paragraph nested in a text box is not this paragraph's text.
    depth, own = 0, []
    for position, token in enumerate(tokens):
        if token[0] == "s" and token[1] == _W + "p":
            depth += 1
        elif token[0] == "e" and token[1] == _W + "p":
            depth -= 1
        elif token[0] == "t" and depth == 0:
            own.append(position)
    while own and tokens[own[-1]][1] in _ENDING_CHARS:
        del tokens[own.pop()]
    return tuple(tokens)


def _normalize_marker(sig: tuple) -> tuple:
    """"1." / "1、\\t" / "1)" at the start of the visible text read as one marker."""

    # The leading visible text, reading a tab element as "\t" ("1.⇥text").
    chars = []
    end = 0
    while end < len(sig):
        token = sig[end]
        if token[0] == "t":
            chars.append(token[1])
            end += 1
        elif token == ("s", _W + "tab", ()) and end + 1 < len(sig) and sig[end + 1] == ("e", _W + "tab"):
            chars.append("\t")
            end += 2
        else:
            break
    leading = "".join(chars)
    normalized = _LEADING_MARKER_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}.", leading, count=1)
    return tuple(("t", ch) for ch in normalized) + sig[end:]


def _squash(text: str) -> str:
    return re.sub(r"\s+", "", text)


def _country_names(texts: list) -> Counter:
    return Counter(_country_name_list(texts))


def _country_name_list(texts: list) -> list:
    names = []
    for index, text in enumerate(texts):
        value = re.sub(r"^\s*[^:：]{1,20}[:：]\s*", "", text) if index == 0 or re.match(r"^\s*[^:：]{1,20}[:：]", text) else text
        names.extend(split_country_names(value))
    return names


def _short_diff(old: str, new: str) -> str:
    matcher = difflib.SequenceMatcher(None, old, new, autojunk=False)
    for op, a0, a1, b0, b1 in matcher.get_opcodes():
        if op != "equal":
            return f"原文“{old[max(0, a0 - 8):a1 + 8]}” → “{new[max(0, b0 - 8):b1 + 8]}”"
    return "文字以外的内容（域、链接、书签、修订或图片）发生变化"


# ------------------------------------------------- visibility and deletion marks

# Run properties that change what a reader sees or what the text means.  The
# signatures above leave run properties out, so they are checked on their
# own: a hidden note must not become visible, a struck deletion must not lose
# its strike (content-guard.ts semanticMarks).
_HIDDEN_MARKS = tuple(_W + tag for tag in ("vanish", "webHidden", "specVanish"))
_STRUCK_MARKS = tuple(_W + tag for tag in ("strike", "dstrike"))


def _mark_on(run, tags) -> bool:
    rpr = run.find(_W + "rPr")
    return rpr is not None and any(child.tag in tags and child.get(_W + "val") not in ("0", "false", "off") for child in rpr)


def _marks_of(element) -> tuple:
    hidden, struck = [], []
    for run in element.iter(_RUN):
        if _deleted(run, element):
            continue
        text = "".join(child.text or "" for child in run if child.tag == _TEXT)
        if _mark_on(run, _HIDDEN_MARKS):
            hidden.append(text)
        if _mark_on(run, _STRUCK_MARKS):
            struck.append(text)
    return "".join(hidden), "".join(struck)


def _deleted(run, root) -> bool:
    node = run.getparent()
    while node is not None and node is not root:
        if node.tag in (_W + "del", _W + "moveFrom"):
            return True
        node = node.getparent()
    return False


def semantic_marks(document) -> dict:
    return {el: _marks_of(el) for el in body_blocks(document)}


def _keeps(before: str, after: str) -> bool:
    remaining = iter(after)
    return all(ch in remaining for ch in before)


def paragraph_marks(element) -> tuple:
    """``(hidden, struck)`` text of one block, for checking a single rewrite."""

    return _marks_of(element)


def marks_kept(before: tuple, element) -> bool:
    """The hidden and struck characters of ``before`` survive, in order and still marked, in ``element``."""

    hidden, struck = _marks_of(element)
    return _keeps(before[0], hidden) and _keeps(before[1], struck)


def verify_marks(before: dict, document) -> list:
    """Hidden and struck characters survive, in order, in the same block."""

    present = set(body_blocks(document))
    problems = []
    for number, (el, (hidden, struck)) in enumerate(before.items(), 1):
        if not hidden and not struck:
            continue
        if el not in present:
            problems.append(f"第 {number} 段含隐藏或删除线文字，但该段被删除")
            continue
        now_hidden, now_struck = _marks_of(el)
        if not _keeps(hidden, now_hidden):
            problems.append(f"第 {number} 段的隐藏文字会变为可见：{hidden[:20]}")
        if not _keeps(struck, now_struck):
            problems.append(f"第 {number} 段的删除线被移除：{struck[:20]}")
    return problems


# ------------------------------------------------------------------ package

_PARSER = etree.XMLParser(resolve_entities=False, no_network=True)


def _package(content: bytes):
    relationships: dict = {}
    resources: dict = {}
    protected: dict = {}
    with zipfile.ZipFile(BytesIO(content)) as archive:
        for name in archive.namelist():
            if name.lower().endswith(".rels"):
                root = etree.fromstring(archive.read(name), _PARSER)
                relations = {}
                for child in root.findall("{http://schemas.openxmlformats.org/package/2006/relationships}Relationship"):
                    identifier = child.get("Id")
                    if identifier in relations:
                        raise InvalidDocxError(f"关系部件 {name} 包含重复 ID。")
                    relations[identifier] = tuple(sorted(child.attrib.items()))
                relationships[name] = relations
            elif name.startswith(("word/media/", "word/embeddings/")):
                resources[name] = hashlib.sha256(archive.read(name)).hexdigest()
            elif re.fullmatch(r"word/(?:numbering|footnotes|endnotes|comments|header\d+|footer\d+)\.xml", name):
                protected[name] = signature(etree.fromstring(archive.read(name), _PARSER))
    return relationships, resources, protected


def verify_package(before: bytes, after: bytes, native_rules=()) -> list:
    """Every relationship keeps its target, type and mode; every resource keeps its bytes."""

    old_rels, old_resources, old_protected = _package(before)
    new_rels, new_resources, new_protected = _package(after)
    if native_rules and 'word/numbering.xml' in old_protected:
        with zipfile.ZipFile(BytesIO(before)) as archive:
            expected = etree.fromstring(archive.read('word/numbering.xml'), _PARSER)
        apply_native_rules(expected, native_rules)
        old_protected['word/numbering.xml'] = signature(expected)
    problems = []
    for part, rels in old_rels.items():
        for identifier, attributes in rels.items():
            if new_rels.get(part, {}).get(identifier) != attributes:
                problems.append(f"关系 {part}#{identifier} 的目标、类型或模式发生变化")
    for name, digest in old_resources.items():
        if new_resources.get(name) != digest:
            problems.append(f"资源 {name} 的内容发生变化")
    for name, value in old_protected.items():
        if new_protected.get(name) != value:
            problems.append(f"部件 {name} 的内容或编号语义发生变化")
    return problems


# ------------------------------------------------------------ structure repair

_BOUNDARY = ("p",)
_BREAK_TOKENS = frozenset({("s", _W + "br", ()), ("e", _W + "br")})


def document_tokens(document) -> list:
    tokens: list = []
    for el in body_blocks(document):
        _tokens(el, tokens)
        tokens.append(_BOUNDARY)
    return tokens


def verify_repair(before: list, after: list, inserted_texts: list) -> list:
    """Structure repair may split paragraphs and add the markers and labels it reports; nothing else.

    Allowed insertions: paragraph boundaries, line breaks, whitespace, and the
    characters of ``inserted_texts`` (restored "（一）", restored header
    labels).  Nothing may be deleted or replaced, except whitespace at a split.
    """

    if before == after:
        return []
    allowed: Counter = Counter()
    for text in inserted_texts:
        allowed.update(text)
    problems = []
    matcher = difflib.SequenceMatcher(None, before, after, autojunk=False)
    for op, a0, a1, b0, b1 in matcher.get_opcodes():
        if op == "equal":
            continue
        removed = [t for t in before[a0:a1] if t != _BOUNDARY and not (t[0] == "t" and t[1].isspace())]
        added = [t for t in after[b0:b1] if t != _BOUNDARY and t not in _BREAK_TOKENS and not (t[0] == "t" and t[1].isspace())]
        for token in added:
            if token[0] == "t" and allowed[token[1]] > 0:
                allowed[token[1]] -= 1
            else:
                problems.append(f"结构修复加入了未报告的内容：{_describe(after[b0:b1])}")
                break
        if removed:
            problems.append(f"结构修复删除了内容：{_describe(before[a0:a1])}")
    return problems


def _describe(tokens) -> str:
    parts = []
    for token in tokens:
        if token[0] == "t":
            parts.append(token[1])
        elif token[0] == "s":
            parts.append(f"[{etree.QName(token[1]).localname}]")
    return "".join(parts)[:30]
