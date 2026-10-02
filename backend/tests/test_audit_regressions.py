"""Regressions from the independent v1.7.1 audit (2026-10), Python engine.

Each case failed before its fix.  Inputs are small synthetic packages built
here; expectations are read back with plain lxml, not with engine helpers.
"""

from __future__ import annotations

import sys
import unittest
import zipfile
from io import BytesIO
from pathlib import Path
from xml.sax.saxutils import escape

from lxml import etree

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app import content_guard  # noqa: E402
from app.docx_package import validate_docx_package  # noqa: E402
from app.errors import InvalidDocxError  # noqa: E402
from app.pipelines import PIPELINES  # noqa: E402

TEMPLATES = ROOT / "templates" / "pkunmun2026"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
ZH_DR = ["决议草案", "委员会：安全理事会", "议题：网络安全", "起草国：德国、法国", "附议国：美国、中国", "安全理事会，", "认识到网络安全的重要性，"]


def q(tag: str) -> str:
    return f"{{{W}}}{tag}"


def run(text: str, props: str = "") -> str:
    rpr = f"<w:rPr>{props}</w:rPr>" if props else ""
    return f'<w:r>{rpr}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def line(text: str, props: str = "", ppr: str = "") -> str:
    return f"<w:p>{f'<w:pPr>{ppr}</w:pPr>' if ppr else ''}{run(text, props)}</w:p>"


def lines(texts) -> str:
    return "".join(line(text) for text in texts)


def package(body: str, *, numbering: str | None = None, rels: str = "", extra: dict | None = None) -> bytes:
    overrides = ['<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>']
    relations = []
    files = {}
    if numbering is not None:
        overrides.append('<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>')
        relations.append('<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>')
        files["word/numbering.xml"] = f'<w:numbering xmlns:w="{W}">{numbering}</w:numbering>'
    files.update({
        "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + "".join(overrides) + "</Types>",
        "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/_rels/document.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + "".join(relations) + rels + "</Relationships>",
        "word/document.xml": f'<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{body}<w:sectPr/></w:body></w:document>',
        **(extra or {}),
    })
    stream = BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data if isinstance(data, bytes) else data.encode("utf-8"))
    return stream.getvalue()


def format_(document_type: str, content: bytes, overrides=None):
    return PIPELINES[document_type](TEMPLATES).run(content, overrides=overrides or {})


def errors(result):
    return [f"{item.label}: {item.detail}" for item in result.validations if item.status == "error"]


def body(content: bytes):
    return etree.fromstring(zipfile.ZipFile(BytesIO(content)).read("word/document.xml"))


def text_of(element) -> str:
    return "".join(node.text or "" for node in element.iter(q("t")) if not any(a.tag == q("del") for a in node.iterancestors()))


def marked(element, tag: str) -> str:
    """Characters carrying a switched-on run property, in order."""

    out = []
    for run_ in element.iter(q("r")):
        node = run_.find(f"{q('rPr')}/{q(tag)}")
        if node is not None and node.get(q("val")) not in ("0", "false", "off"):
            out.append("".join(t.text or "" for t in run_.iter(q("t"))))
    return "".join(out)


def paragraph(root, start: str):
    return next(p for p in root.iter(q("p")) if text_of(p).startswith(start))


class HiddenAndStruckTextTests(unittest.TestCase):
    def test_whole_hidden_clause_stays_hidden(self):
        content = package(lines(ZH_DR) + line("第一条 决定继续审议此问题。") + line("第二条 内部备注：此条暂不公开，待磋商后再议。", "<w:vanish/>") + line("第三条 请秘书长提交报告。"))
        result = format_("draft-resolution", content)
        self.assertEqual(errors(result), [])
        self.assertTrue(marked(body(result.content), "vanish").startswith("第二条 内部备注：此条暂不公开，待磋商后再议"))

    def test_whole_struck_clause_keeps_strike(self):
        content = package(lines(ZH_DR) + line("第一条 决定继续审议此问题。") + line("第二条 呼吁各国立即停止一切网络攻击。", "<w:strike/>") + line("第三条 请秘书长提交报告。"))
        result = format_("draft-resolution", content)
        self.assertEqual(errors(result), [])
        self.assertIn("各国立即停止一切网络攻击", marked(body(result.content), "strike"))

    def test_struck_or_hidden_country_is_not_made_plain(self):
        signatories = "<w:p>" + run("附议国：") + run("中国、") + run("日本", "<w:strike/>") + run("、美国、") + run("巴西", "<w:vanish/>") + "</w:p>"
        content = package(lines(["决议草案", "委员会：安全理事会", "议题：网络安全", "起草国：法国、德国"]) + signatories + lines(["安全理事会，", "认识到网络安全的重要性，", "第一条 决定继续审议此问题。"]))
        result = format_("draft-resolution", content)
        self.assertEqual(errors(result), [])
        root = body(result.content)
        self.assertEqual(marked(root, "strike"), "日本")
        self.assertEqual(marked(root, "vanish"), "巴西")
        self.assertTrue(any(item.code == "content-protected" for item in result.validations))

    def test_hidden_trailing_text_does_not_take_the_ending(self):
        content = package(lines(ZH_DR) + "<w:p>" + run("第一条 决定继续审议此问题。") + run("（内部备注：待定）", "<w:vanish/>") + "</w:p>" + line("第二条 请秘书长提交报告。"))
        result = format_("draft-resolution", content)
        self.assertEqual(errors(result), [])
        self.assertEqual(marked(body(result.content), "vanish"), "（内部备注：待定）")
        self.assertTrue(any(item.code == "content-protected" and "隐藏" in item.detail for item in result.validations))

    def test_guard_reports_lost_marks(self):
        root = etree.fromstring(f'<w:document xmlns:w="{W}"><w:body><w:p>{run("可见")}{run("隐藏", "<w:vanish/>")}{run("删除", "<w:strike/>")}</w:p></w:body></w:document>')

        class Doc:  # the guard only needs ``element.body``
            class element:  # noqa: N801
                pass
        Doc.element.body = root.find(q("body"))
        before = content_guard.semantic_marks(Doc)
        self.assertEqual(content_guard.verify_marks(before, Doc), [])
        for tag in ("vanish", "strike"):
            node = next(root.iter(q(tag)))
            node.getparent().remove(node)
        self.assertEqual(len(content_guard.verify_marks(before, Doc)), 2)


class EndingPlacementTests(unittest.TestCase):
    def test_ending_goes_after_fields_and_links(self):
        field = ('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> REF _Ref1 \\r \\h </w:instrText></w:r>'
                 '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>第一条</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>')
        simple = '<w:fldSimple w:instr=" REF _Ref1 \\r \\h "><w:r><w:t>第一条</w:t></w:r></w:fldSimple>'
        link = '<w:hyperlink w:anchor="_Ref1"><w:r><w:t>第一条</w:t></w:r></w:hyperlink>'
        content = package(lines(ZH_DR) + '<w:p><w:bookmarkStart w:id="1" w:name="_Ref1"/>' + run("第一条 决定设立工作组。") + '<w:bookmarkEnd w:id="1"/></w:p>'
                          + f"<w:p>{run('第二条 请各国参照')}{field}</w:p><w:p>{run('第三条 要求工作组执行')}{simple}</w:p><w:p>{run('第四条 决定继续审议')}{link}</w:p>")
        result = format_("draft-resolution", content)
        self.assertEqual(errors(result), [])
        root = body(result.content)
        for container in [*root.iter(q("fldSimple")), *root.iter(q("hyperlink"))]:
            self.assertEqual(text_of(container), "第一条")
        complex_ = paragraph(root, "第二条")
        runs = list(complex_.iter(q("r")))
        end = next(i for i, r in enumerate(runs) if any(f.get(q("fldCharType")) == "end" for f in r.iter(q("fldChar"))))
        self.assertEqual("".join(text_of(r) for r in runs[:end]), "第二条 请各国参照第一条")
        self.assertEqual(text_of(complex_), "第二条 请各国参照第一条；")
        self.assertEqual(text_of(paragraph(root, "第四条")), "第四条 决定继续审议第一条。")


NUMBERING = ('<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="第%1条"/></w:lvl></w:abstractNum>'
             '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>')


def numbered(text: str) -> str:
    return line(text, ppr='<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')


class RecognitionTests(unittest.TestCase):
    def test_natively_numbered_chinese_operative_clauses_are_operative(self):
        content = package(lines(["决议草案", "委员会：联合国大会", "议题：气候变化", "起草国：德国、法国", "附议国：美国、中国", "联合国大会，", "认识到气候变化的紧迫性，"])
                          + numbered("决定设立气候基金；") + numbered("呼吁各国增加投入；") + numbered("希望各方继续对话。"), numbering=NUMBERING)
        result = format_("draft-resolution", content)
        self.assertEqual(errors(result), [])
        root = body(result.content)
        self.assertEqual(text_of(paragraph(root, "呼吁")), "呼吁各国增加投入；")
        self.assertEqual(text_of(paragraph(root, "希望")), "希望各方继续对话。")
        self.assertEqual(marked(paragraph(root, "呼吁"), "i"), "呼吁")

    def test_colon_clause_does_not_demote_its_siblings(self):
        numbering = '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
        content = package(lines(["DRAFT RESOLUTION", "Committee: General Assembly", "Topic: Water", "Sponsors: France, Germany", "Signatories: Brazil, Japan", "The General Assembly,", "Recalling its earlier resolutions,"])
                          + numbered("Decides to establish a working group:") + numbered("Requests the Secretary-General to support the group;") + numbered("Decides to remain seized of the matter."), numbering=numbering)
        result = format_("draft-resolution", content)
        self.assertEqual(errors(result), [])
        root = body(result.content)
        left = lambda start: paragraph(root, start).find(f"{q('pPr')}/{q('ind')}").get(q("left"))  # noqa: E731
        self.assertEqual(left("Requests"), left("Decides to establish"))

    def test_english_position_paper_header_gets_english_labels(self):
        content = package(lines(["Position Paper", "Security Council", "Cyber Security", "France", "John Smith",
                                 "Cyber security has become a shared challenge that requires cooperation among all states and stakeholders."]))
        result = format_("position-paper", content)
        self.assertEqual(errors(result), [])
        texts = [text_of(p) for p in body(result.content).iter(q("p"))]
        self.assertIn("Committee: Security Council", texts)
        self.assertFalse(any("委员会" in text for text in texts))

    def test_numbered_heading_is_not_labeled_as_delegate(self):
        content = package(lines(["立场文件", "安全理事会", "网络安全问题", "法兰西共和国", "一、问题背景", "网络安全已经成为国际社会共同面对的重要挑战，各国应当加强合作。"]))
        result = format_("position-paper", content)
        self.assertEqual(errors(result), [])
        texts = [text_of(p) for p in body(result.content).iter(q("p"))]
        self.assertIn("一、问题背景", texts)
        self.assertNotEqual(result.model.delegate, "一、问题背景")


class StepThreeTests(unittest.TestCase):
    PP = ["立场文件", "委员会：安全理事会", "议题：网络安全", "国家：法兰西共和国", "代表：张三", "（一）问题背景", "网络安全已经成为国际社会共同面对的重要挑战，各国应当加强合作，共同应对风险。"]

    def test_labeled_position_paper_fields_can_be_changed(self):
        for key, value, expected in (("topic", "网络空间安全", "议题：网络空间安全"), ("delegate", "李四", "代表：李四"), ("committee", "联合国大会", "委员会：联合国大会")):
            with self.subTest(key=key):
                result = format_("position-paper", package(lines(self.PP)), {key: value})
                self.assertEqual(errors(result), [])
                self.assertIn(expected, [text_of(p) for p in body(result.content).iter(q("p"))])


class SplitTests(unittest.TestCase):
    def test_link_across_an_embedded_marker_is_kept_and_reported(self):
        rels = '<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.un.org/" TargetMode="External"/>'
        link = f'<w:hyperlink r:id="rIdLink">{run("收集证据；（丑）提交报告")}</w:hyperlink>'
        content = package(lines(ZH_DR) + "<w:p>" + run("第一条 决定设立工作组：（一）调查网络攻击：（子）") + link + run("；（二）提出建议。") + "</w:p>" + line("第二条 决定继续审议此问题。"), rels=rels)
        result = format_("draft-resolution", content)
        self.assertEqual(errors(result), [])
        root = body(result.content)
        self.assertEqual(len(list(root.iter(q("hyperlink")))), 1)
        self.assertTrue(any("未" in item.detail and "拆分" in item.detail for item in result.validations if item.status == "warning"))


class PackageTests(unittest.TestCase):
    def test_upper_case_xml_part_with_dtd_is_refused(self):
        content = package(lines(ZH_DR), extra={"word/header1.XML": f'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><w:hdr xmlns:w="{W}"/>'})
        with self.assertRaises(InvalidDocxError):
            validate_docx_package(content)


if __name__ == "__main__":
    unittest.main()
