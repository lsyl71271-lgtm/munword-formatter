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
from app.errors import InvalidDocxError, ProtectedContentError  # noqa: E402
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


def package(body: str, *, numbering: str | None = None, styles: str | None = None, footnotes: str | None = None,
            rels: str = "", extra: dict | None = None) -> bytes:
    overrides = ['<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>']
    relations = []
    files = {}
    for part, root, content in (("numbering", "numbering", numbering), ("styles", "styles", styles), ("footnotes", "footnotes", footnotes)):
        if content is None:
            continue
        overrides.append(f'<Override PartName="/word/{part}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.{part}+xml"/>')
        relations.append(f'<Relationship Id="rId{part}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{part}" Target="{part}.xml"/>')
        files[f"word/{part}.xml"] = f'<w:{root} xmlns:w="{W}">{content}</w:{root}>'
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


class TrailingBreakTests(unittest.TestCase):
    def test_a_clause_ending_before_a_page_or_line_break_is_normalized_and_the_break_kept(self):
        for kind, br in (("page", '<w:br w:type="page"/>'), ("line", "<w:br/>")):
            with self.subTest(kind=kind):
                clause = "<w:p>" + run("第一条 决定继续审议此问题。") + f"<w:r>{br}</w:r></w:p>"
                result = format_("draft-resolution", package(lines(ZH_DR) + clause + line("第二条 请秘书长提交报告。")))
                self.assertEqual(errors(result), [])
                first = paragraph(body(result.content), "第一条")
                self.assertEqual(text_of(first), "第一条 决定继续审议此问题；")
                breaks = list(first.iter(q("br")))
                self.assertEqual([b.get(q("type")) for b in breaks], ["page" if kind == "page" else None])
                self.assertFalse([w for w in warnings(result) if "已保留原样" in w])


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


def shown(element) -> str:
    """Visible text with line breaks and tabs, as a reader sees it."""

    out = []
    for node in element.iter(q("t"), q("br"), q("tab")):
        if any(a.tag == q("del") for a in node.iterancestors()):
            continue
        out.append(node.text or "" if node.tag == q("t") else "\n" if node.tag == q("br") else "\t")
    return "".join(out)


def shown_from(content: bytes, start: str) -> list[str]:
    texts = [shown(p) for p in body(content).iter(q("p")) if shown(p).strip()]
    return texts[next(index for index, text in enumerate(texts) if text.startswith(start)):]


def warnings(result) -> list[str]:
    return [item.detail for item in result.validations if item.status == "warning"]


FLATTENED = "第一条 决定设立工作组：（一）调查网络攻击：（子）收集证据；（丑）提交报告；（二）提出建议。"
SPLIT = ["第一条 决定设立工作组：\n（一）调查网络攻击：", "（子）收集证据；", "（丑）提交报告；", "（二）提出建议"]


class SplitTests(unittest.TestCase):
    """B11: one splitting rule for both engines (shared policy ``embeddedSubclause``)."""

    def assertSplit(self, result, expected, start="第一条"):
        """Paragraphs read ``expected``; an item without its ending may gain one punctuation mark."""

        self.assertEqual(errors(result), [])
        texts = shown_from(result.content, start)[: len(expected)]
        self.assertEqual(len(texts), len(expected), texts)
        for text, wanted in zip(texts, expected):
            self.assertTrue(text == wanted or (text[:-1] == wanted and not wanted.endswith(("：", "；", "。"))), texts)

    def test_level_one_marker_after_a_deeper_subclause_starts_its_own_paragraph(self):
        content = package(lines(ZH_DR + [FLATTENED, "第二条 决定继续审议此问题。"]))
        result = format_("draft-resolution", content)
        self.assertSplit(result, SPLIT)
        self.assertTrue(shown_from(result.content, "第一条")[4].startswith("第二条"))
        again = format_("draft-resolution", result.content)
        self.assertEqual(shown_from(again.content, "第一条"), shown_from(result.content, "第一条"))

    def test_links_and_revisions_wholly_inside_one_subclause_do_not_block_the_split(self):
        rels = '<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.un.org/" TargetMode="External"/>'
        link = f'<w:hyperlink r:id="rIdLink">{run("联合国网站")}</w:hyperlink>'
        linked = "<w:p>" + run("第一条 决定设立工作组：（一）调查网络攻击：（子）收集证据，参见") + link + run("；（丑）提交报告；（二）提出建议。") + "</w:p>"
        result = format_("draft-resolution", package(lines(ZH_DR) + linked, rels=rels))
        self.assertSplit(result, [SPLIT[0], "（子）收集证据，参见联合国网站；", *SPLIT[2:]])
        self.assertEqual(len(list(body(result.content).iter(q("hyperlink")))), 1)
        insertion = f'<w:ins w:id="21" w:author="A" w:date="2026-01-01T00:00:00Z">{run("（子）收集证据；")}</w:ins>'
        revised = "<w:p>" + run("第一条 决定设立工作组：（一）调查网络攻击：") + insertion + run("（丑）提交报告；（二）提出建议。") + "</w:p>"
        result = format_("draft-resolution", package(lines(ZH_DR) + revised))
        self.assertSplit(result, SPLIT)
        self.assertEqual(len(list(body(result.content).iter(q("ins")))), 1)

    def test_working_papers_and_directives_split_by_the_same_rule(self):
        header = ["委员会：安全理事会", "议题：网络安全", "起草国：德国、法国"]
        result = format_("working-paper", package(lines(["工作文件", *header, "1. 呼吁各国加强合作：（子）建立信息共享机制；（丑）定期举行会议。"])))
        self.assertSplit(result, ["1. 呼吁各国加强合作：", "（子）建立信息共享机制；", "（丑）定期举行会议"], "1.")
        result = format_("draft-directive", package(lines(["指令草案", *header, "1. 要求各部门：（一）提交报告；（二）说明进展。"])))
        self.assertSplit(result, ["1. 要求各部门：", "（一）提交报告；", "（二）说明进展"], "1.")

    def test_markers_outside_a_clause_or_in_a_field_paragraph_are_reported_not_split(self):
        prose = "回顾其以往决议：（一）第1号决议；（二）第2号决议，"
        result = format_("draft-resolution", package(lines(ZH_DR[:-1] + [prose, "第一条 决定继续审议此问题。"])))
        self.assertEqual(errors(result), [])
        self.assertEqual(shown_from(result.content, "回顾")[0], prose)
        self.assertTrue(any("第 7 段" in item and "未拆分" in item for item in warnings(result)), warnings(result))
        field = '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>'
        clause = "<w:p>" + run("第一条 决定设立工作组：（子）收集证据；参见第") + field + run("页。") + "</w:p>"
        result = format_("draft-resolution", package(lines(ZH_DR) + clause))
        self.assertEqual(errors(result), [])
        self.assertTrue(shown_from(result.content, "第一条")[0].startswith("第一条 决定设立工作组：（子）收集证据；"))
        self.assertTrue(any("第 8 段" in item and "域" in item and "未拆分" in item for item in warnings(result)), warnings(result))

    def test_a_section_break_moves_to_the_last_split_paragraph(self):
        section = '<w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr>'
        clause = f"<w:p>{section}{run('第一条 决定设立工作组：（子）收集证据；（丑）提交报告。')}</w:p>"
        result = format_("draft-resolution", package(lines(ZH_DR) + clause + line("第二条 决定继续审议此问题。")))
        self.assertEqual(errors(result), [])
        breaks = [p for p in body(result.content).iter(q("p")) if p.find(f"{q('pPr')}/{q('sectPr')}") is not None]
        self.assertEqual([shown(p) for p in breaks], ["（丑）提交报告；"])

    def test_link_across_an_embedded_marker_is_kept_and_reported(self):
        rels = '<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.un.org/" TargetMode="External"/>'
        link = f'<w:hyperlink r:id="rIdLink">{run("收集证据；（丑）提交报告")}</w:hyperlink>'
        content = package(lines(ZH_DR) + "<w:p>" + run("第一条 决定设立工作组：（一）调查网络攻击：（子）") + link + run("；（二）提出建议。") + "</w:p>" + line("第二条 决定继续审议此问题。"), rels=rels)
        result = format_("draft-resolution", content)
        self.assertEqual(errors(result), [])
        root = body(result.content)
        self.assertEqual(len(list(root.iter(q("hyperlink")))), 1)
        self.assertTrue(any("未" in item.detail and "拆分" in item.detail for item in result.validations if item.status == "warning"))


def part(content: bytes, name: str):
    return etree.fromstring(zipfile.ZipFile(BytesIO(content)).read(name))


def switched_on(run_, tag: str) -> bool:
    node = run_.find(f"{q('rPr')}/{q(tag)}")
    return node is not None and node.get(q("val")) not in ("0", "false", "off", "none")


NORMAL = '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
TEXT_BOX = (
    '<w:r><w:drawing><wp:anchor xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">'
    '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>'
    '<wp:extent cx="1000000" cy="300000"/><wp:wrapNone/><wp:docPr id="1" name="Box"/>'
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">'
    '<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:cNvSpPr txBox="1"/><wps:spPr/><wps:txbx><w:txbxContent>'
    '<w:p><w:r><w:t>框内普通说明</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>'
)


class StyleInheritanceTests(unittest.TestCase):
    """Formatting resets paragraph and run styles, so what they meant is made direct first."""

    def test_a_default_style_with_another_id_is_cleared_like_normal(self):
        # Chinese Word names the default paragraph style "a"; hiding it hides the whole document.
        for style_id in ("Normal", "a"):
            with self.subTest(style_id=style_id):
                styles = f'<w:style w:type="paragraph" w:default="1" w:styleId="{style_id}"><w:name w:val="Normal"/><w:rPr><w:vanish/></w:rPr></w:style>'
                result = format_("draft-resolution", package(lines(ZH_DR + ["第一条 决定继续审议此问题。"]), styles=styles))
                self.assertEqual(errors(result), [])
                self.assertEqual(list(part(result.content, "word/styles.xml").iter(q("vanish"))), [])
                self.assertEqual(list(body(result.content).iter(q("vanish"))), [])

    def test_text_box_text_does_not_take_the_outer_paragraph_style(self):
        bold = '<w:style w:type="paragraph" w:styleId="Bold"><w:name w:val="Bold"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:u w:val="single"/></w:rPr></w:style>'
        clause = '<w:p><w:pPr><w:pStyle w:val="Bold"/></w:pPr>' + run("第一条 决定继续审议此问题。") + TEXT_BOX + "</w:p>"
        result = format_("draft-resolution", package(lines(ZH_DR) + clause, styles=NORMAL + bold))
        self.assertEqual(errors(result), [])
        boxed = next(r for r in body(result.content).iter(q("r")) if "".join(t.text or "" for t in r.findall(q("t"))) == "框内普通说明")
        self.assertFalse(switched_on(boxed, "b") or switched_on(boxed, "u"))

    def test_list_level_comes_from_the_level_linked_to_the_style(self):
        # ECMA-376 §17.9.23: a level naming a paragraph style is that style's level.
        numbering = (
            '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="ListA"/><w:lvlText w:val="%1."/></w:lvl>'
            '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:pStyle w:val="ListB"/><w:lvlText w:val="(%2)"/></w:lvl></w:abstractNum>'
            '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
        )
        styles = NORMAL + "".join(
            f'<w:style w:type="paragraph" w:styleId="{sid}"><w:name w:val="{sid}"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>'
            for sid in ("ListA", "ListB")
        )
        en = ["DRAFT RESOLUTION", "Committee: Security Council", "Topic: Cyber Security", "Sponsors: France, Germany", "Signatories: China, Japan", "The Security Council,", "Recognizing the importance of cyber security,"]
        clauses = [("ListA", "Decides to establish a working group:"), ("ListB", "Collect evidence;"), ("ListB", "Submit a report;"), ("ListA", "Decides to remain seized of the matter.")]
        source = lines(en) + "".join(f'<w:p><w:pPr><w:pStyle w:val="{sid}"/></w:pPr>{run(text)}</w:p>' for sid, text in clauses)
        result = format_("draft-resolution", package(source, numbering=numbering, styles=styles))
        self.assertEqual(errors(result), [])
        levels = {}
        for p in body(result.content).iter(q("p")):
            level = p.find(f"{q('pPr')}/{q('numPr')}/{q('ilvl')}")
            levels[text_of(p)[:8]] = level.get(q("val")) if level is not None else "0"
        self.assertEqual([levels[text[:8]] for _, text in clauses], ["0", "1", "1", "0"])

    def test_a_damaged_bold_default_style_does_not_reach_text_through_a_style_based_on_it(self):
        styles = ('<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>'
                  '<w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/><w:basedOn w:val="Normal"/></w:style>')
        source = lines(["立场文件", "委员会：安全理事会", "议题：网络安全", "国家：法国", "代表：张三", "（一）问题背景"])
        source += f'<w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr>{run("网络安全关系到各国的共同利益。")}</w:p>'
        result = format_("position-paper", package(source, styles=styles))
        self.assertEqual(errors(result), [])
        prose = next(r for r in body(result.content).iter(q("r")) if "共同利益" in text_of(r))
        self.assertFalse(switched_on(prose, "b"))

    def test_clearing_whole_document_damage_keeps_styles_the_body_does_not_use(self):
        texts = ZH_DR + ["第一条 决定继续审议此问题。"]
        hidden_body = "".join(f"<w:p>{run(text, '<w:vanish/>')}</w:p>" for text in texts)
        secret = '<w:style w:type="character" w:styleId="Secret"><w:name w:val="Secret"/><w:rPr><w:vanish/></w:rPr></w:style>'
        notes = '<w:footnote w:id="1"><w:p><w:r><w:t xml:space="preserve">Public source. </w:t></w:r><w:r><w:rPr><w:rStyle w:val="Secret"/></w:rPr><w:t>Private drafting note.</w:t></w:r></w:p></w:footnote>'
        result = format_("draft-resolution", package(hidden_body, styles=NORMAL + secret, footnotes=notes))
        self.assertEqual(errors(result), [])
        self.assertEqual(list(body(result.content).iter(q("vanish"))), [])
        kept = next(s for s in part(result.content, "word/styles.xml").iter(q("style")) if s.get(q("styleId")) == "Secret")
        self.assertIsNotNone(kept.find(f"{q('rPr')}/{q('vanish')}"))


class PackageTests(unittest.TestCase):
    def test_upper_case_xml_part_with_dtd_is_refused(self):
        content = package(lines(ZH_DR), extra={"word/header1.XML": f'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><w:hdr xmlns:w="{W}"/>'})
        with self.assertRaises(InvalidDocxError):
            validate_docx_package(content)


def emphasized(paragraph_element, tag: str) -> str:
    """Text of a paragraph's own runs that carry a switched-on property."""

    out = []
    for run_ in paragraph_element.iter(q("r")):
        owner = run_.getparent()
        while owner is not None and owner.tag != q("p"):
            owner = owner.getparent()
        if owner is paragraph_element and switched_on(run_, tag):
            out.append("".join(t.text or "" for t in run_.findall(q("t"))))
    return "".join(out)


class ClauseWordTests(unittest.TestCase):
    def test_added_chinese_clause_words_take_the_preamble_underline_and_the_operative_italics(self):
        source = lines([
            "决议草案", "委员会：安全理事会", "议题：网络安全", "起草国：德国、法国", "附议国：美国、中国", "安全理事会，",
            "深切关切网络攻击日益增多，", "深表关切关键基础设施面临的风险，", "进一步回顾其以往的相关决议，",
            "第一条 促请各国加强信息共享；", "第二条 进一步呼吁各方开展能力建设；", "第三条 进一步回顾其所作的承诺。",
        ])
        result = format_("draft-resolution", package(source))
        self.assertEqual(errors(result), [])
        root = body(result.content)
        for word in ("深切关切", "深表关切", "进一步回顾"):
            with self.subTest(word=word):
                p = paragraph(root, word)
                self.assertEqual(emphasized(p, "u"), word)
                self.assertEqual(emphasized(p, "i"), "")
        # A word in both lists follows the clause's place: "进一步回顾" in an article is operative.
        for start, word in (("第一条", "促请"), ("第二条", "进一步呼吁"), ("第三条", "进一步回顾")):
            with self.subTest(word=word):
                p = paragraph(root, start)
                self.assertEqual(emphasized(p, "i"), word)
                self.assertEqual(emphasized(p, "u"), "")


NON_BMP_HIDDEN = "（备注😀𠀀）"
NON_BMP_STRUCK = "删去𠀁词😀"


class NonBmpMarkTests(unittest.TestCase):
    def test_hidden_and_struck_characters_outside_the_bmp_pass_the_guard_unchanged_and_fail_it_when_exposed(self):
        root = etree.fromstring(f'<w:document xmlns:w="{W}"><w:body><w:p>{run("可见")}{run(NON_BMP_HIDDEN, "<w:vanish/>")}{run(NON_BMP_STRUCK, "<w:strike/>")}</w:p></w:body></w:document>')

        class Doc:  # the guard only needs ``element.body``
            class element:  # noqa: N801
                pass
        Doc.element.body = root.find(q("body"))
        before = content_guard.semantic_marks(Doc)
        self.assertEqual(content_guard.verify_marks(before, Doc), [])
        node = next(root.iter(q("vanish")))
        node.getparent().remove(node)
        self.assertEqual(len(content_guard.verify_marks(before, Doc)), 1)
        node = next(root.iter(q("strike")))
        node.getparent().remove(node)
        self.assertEqual(len(content_guard.verify_marks(before, Doc)), 2)

    def test_a_clause_with_hidden_and_struck_characters_outside_the_bmp_formats_with_its_marks_intact(self):
        clause = ("<w:p>" + run("第一条 决定继续审议此问题") + run(NON_BMP_HIDDEN, "<w:vanish/>") + run("并")
                  + run(NON_BMP_STRUCK, "<w:strike/>") + run("请秘书长提交报告。") + "</w:p>")
        result = format_("draft-resolution", package(lines(ZH_DR) + clause + line("第二条 决定继续处理此案。")))
        self.assertEqual(errors(result), [])
        root = body(result.content)
        self.assertEqual(marked(root, "vanish"), NON_BMP_HIDDEN)
        self.assertEqual(marked(root, "strike"), NON_BMP_STRUCK)
        # The ending was normalized: the per-rewrite check did not mistake the characters for lost ones.
        self.assertTrue(text_of(paragraph(root, "第一条")).endswith("请秘书长提交报告；"))


def with_committee(committee: str) -> bytes:
    texts = ["决议草案", None, "议题：网络安全", "起草国：德国、法国", "附议国：美国、中国", "安全理事会，", "认识到网络安全的重要性，", "第一条 决定继续审议此问题。"]
    return package("".join(committee if text is None else line(text) for text in texts))


class MarkedLabelTests(unittest.TestCase):
    def test_a_committee_label_that_is_hidden_or_struck_is_kept_with_a_warning_not_deleted(self):
        for name, committee, hidden, struck in (
            ("whole line hidden", f"<w:p>{run('委员会：安全理事会', '<w:vanish/>')}</w:p>", "委员会：安全理事会", ""),
            ("label hidden", f"<w:p>{run('委员会：', '<w:vanish/>')}{run('安全理事会')}</w:p>", "委员会：", ""),
            ("label struck", f"<w:p>{run('委员会：', '<w:strike/>')}{run('安全理事会')}</w:p>", "", "委员会："),
        ):
            with self.subTest(name=name):
                result = format_("draft-resolution", with_committee(committee))
                self.assertEqual(errors(result), [])
                root = body(result.content)
                self.assertTrue(any(text_of(p).startswith("委员会：") for p in root.iter(q("p"))))
                self.assertEqual(marked(root, "vanish"), hidden)
                self.assertEqual(marked(root, "strike"), struck)
                self.assertTrue(any("第 2 段" in w and "隐藏或删除线" in w for w in warnings(result)), warnings(result))
        # Only the value hidden: the visible label still goes, the value stays hidden.
        result = format_("draft-resolution", with_committee(f"<w:p>{run('委员会：')}{run('安全理事会', '<w:vanish/>')}</w:p>"))
        self.assertEqual(errors(result), [])
        root = body(result.content)
        self.assertFalse(any(text_of(p).startswith("委员会：") for p in root.iter(q("p"))))
        self.assertEqual(marked(root, "vanish"), "安全理事会")

    def test_struck_whitespace_before_a_split_marker_is_kept(self):
        clause = ("<w:p>" + run("第一条 决定") + run("删去", "<w:strike/>") + run("设立工作组：") + run(" ", "<w:strike/>")
                  + run("（子）收集证据") + run("（备注）", "<w:vanish/>") + run("；（丑）提交报告。") + "</w:p>")
        result = format_("draft-resolution", package(lines(ZH_DR) + clause + line("第二条 决定继续审议此问题。")))
        self.assertEqual(errors(result), [])
        texts = shown_from(result.content, "第一条")
        self.assertTrue(texts[1].startswith("（子）收集证据") and texts[2].startswith("（丑）提交报告"), texts)
        root = body(result.content)
        self.assertEqual(marked(root, "strike"), "删去 ")
        self.assertEqual(marked(root, "vanish"), "（备注）")


def para(*runs) -> str:
    return "<w:p>" + "".join(run(text, props) for text, props in runs) + "</w:p>"


UA_BODY = lines(["委员会：安全理事会", "议题：网络安全", "提交国：法国", "修正条款：第一条", "修改为：决定继续审议此问题。"])
DR_AFTER_COMMITTEE = lines(["议题：网络安全", "起草国：德国、法国", "附议国：美国、中国", "安全理事会，", "认识到网络安全的重要性，", "第一条 决定继续审议此问题。"])


def kept_first(result) -> bool:
    return any("第 1 段" in w and "隐藏或删除线" in w for w in warnings(result))


class MarkedRewriteTests(unittest.TestCase):
    """Automatic rewrites roll back the one paragraph instead of deleting marked characters."""

    def test_a_title_word_partly_hidden_is_kept_with_a_warning(self):
        result = format_("unfriendly-amendment", package(para(("非友好修", "<w:vanish/>"), ("正案1.", ""), ("3.2", "")) + UA_BODY))
        self.assertEqual(errors(result), [])
        root = body(result.content)
        self.assertTrue(any(text_of(p) == "非友好修正案1.3.2" for p in root.iter(q("p"))))
        self.assertEqual(marked(root, "vanish"), "非友好修")
        self.assertTrue(kept_first(result), warnings(result))
        result = format_("working-paper", package(para(("工作文件", ""), ("1.", "<w:vanish/>"), ("8", ""))
                                                  + lines(["委员会：安全理事会", "议题：网络安全", "起草国：法国", "1. 呼吁各国加强合作。"])))
        self.assertEqual(errors(result), [])
        self.assertEqual(marked(body(result.content), "vanish"), "1.")

    def test_a_label_with_a_hidden_middle_or_a_struck_blank_is_kept_with_a_warning(self):
        for name, committee, mark, text in (
            ("hidden middle", para(("委", ""), ("员会", "<w:vanish/>"), ("：安全理事会", "")), "vanish", "员会"),
            ("struck blank", para(("委员会：", ""), (" ", "<w:strike/>"), ("安全理事会", "")), "strike", " "),
        ):
            with self.subTest(name=name):
                result = format_("draft-resolution", package(line("决议草案") + committee + DR_AFTER_COMMITTEE))
                self.assertEqual(errors(result), [])
                root = body(result.content)
                self.assertTrue(any(text_of(p).startswith("委员会：") for p in root.iter(q("p"))))
                self.assertEqual(marked(root, mark), text)
                self.assertTrue(any("第 2 段" in w and "隐藏或删除线" in w for w in warnings(result)), warnings(result))
        # Hidden characters outside the BMP in the value that stays do not stop the label drop.
        result = format_("draft-resolution", package(line("决议草案") + para(("委员会：安全", ""), ("😀𠀀", "<w:vanish/>"), ("理事会", "")) + DR_AFTER_COMMITTEE))
        self.assertEqual(errors(result), [])
        root = body(result.content)
        texts = [text_of(p) for p in root.iter(q("p"))]
        self.assertIn("安全😀𠀀理事会", texts)
        self.assertFalse(any(text.startswith("委员会：") for text in texts))
        self.assertEqual(marked(root, "vanish"), "😀𠀀")
        self.assertFalse(any("第 2 段" in w and "隐藏或删除线" in w for w in warnings(result)))

    def test_a_step_03_title_change_on_a_partly_hidden_title_is_still_refused(self):
        content = package(para(("非友好修", "<w:vanish/>"), ("正案1.", ""), ("3.2", "")) + UA_BODY)
        with self.assertRaisesRegex(ProtectedContentError, "隐藏或删除线"):
            format_("unfriendly-amendment", content, {"title": "非友好修正案2.0"})

if __name__ == "__main__":
    unittest.main()
