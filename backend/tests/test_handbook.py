"""Output layout follows the PKUNMUN 2026 Academic Standard Handbook samples.

Each case feeds the text of a handbook sample, typed without any formatting,
through the pipeline and checks the layout measured from the handbook page.
"""

import sys
import unittest
from io import BytesIO
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.docx_view import visible_runs, visible_text  # noqa: E402
from app.pipelines import PIPELINES  # noqa: E402

TEMPLATES = ROOT / "templates" / "pkunmun2026"


def _source(lines) -> bytes:
    document = Document()
    for text in lines:
        document.add_paragraph(text)
    stream = BytesIO()
    document.save(stream)
    return stream.getvalue()


def _run(document_type, content):
    result = PIPELINES[document_type](TEMPLATES).run(content)
    return result, Document(BytesIO(result.content))


def _lines(document):
    """Visible text per paragraph, "" for the handbook's empty lines."""

    return [visible_text(paragraph) for paragraph in document.paragraphs]


def _styled(paragraph, **flags):
    return "".join(run.text for run in visible_runs(paragraph) if all(bool(getattr(run, key)) == value for key, value in flags.items()))


class ChineseResolutionTests(unittest.TestCase):
    """页41–43."""

    @classmethod
    def setUpClass(cls):
        cls.result, cls.document = _run("draft-resolution", _source([
            "决议草案1.2",
            "联合国大会",
            "1947巴勒斯坦问题",
            "起草国：大不列颠及北爱尔兰联合王国、黎巴嫩共和国、南非联邦、伊朗国",
            "附议国：阿富汗王国、埃及王国、埃塞俄比亚帝国、波兰共和国、南斯拉夫社会主义联邦共和国、沙特阿拉伯国、土耳其共和国、暹罗王国",
            "联合国大会",
            "注意到委任统治国对委任统治放弃的意愿",
            "深切关注巴勒斯坦问题给该地区人民造成的痛苦",
            "第一条 支持在巴勒斯坦地区成立一个统一的国家",
            "第二条 申明结束委任统治有关事宜",
            "（一）英国对巴勒斯坦地区委任统治的结束是开展托管理事会工作的前提",
            "（二）委任统治国应立即停止其委任统治",
        ]))

    def test_no_errors(self):
        self.assertEqual([item.code for item in self.result.validations if item.status == "error"], [])

    def test_empty_lines_and_signature_lines(self):
        self.assertEqual(_lines(self.document), [
            "决议草案1.2",
            "联合国大会",
            "1947巴勒斯坦问题",
            "",
            "起草国：大不列颠及北爱尔兰联合王国、黎巴嫩共和国、南非联邦、伊朗国",
            "",
            "附议国：阿富汗王国、埃及王国、埃塞俄比亚帝国、波兰共和国、",
            "",
            "南斯拉夫社会主义联邦共和国、沙特阿拉伯国、土耳其共和国、暹罗王国",
            "",
            "联合国大会，",
            "",
            "注意到委任统治国对委任统治放弃的意愿，",
            "深切关注巴勒斯坦问题给该地区人民造成的痛苦，",
            "",
            "第一条 支持在巴勒斯坦地区成立一个统一的国家；",
            "第二条 申明结束委任统治有关事宜：",
            "（一）英国对巴勒斯坦地区委任统治的结束是开展托管理事会工作的前提；",
            "（二）委任统治国应立即停止其委任统治。",
        ])

    def test_header_and_country_emphasis(self):
        paragraphs = self.document.paragraphs
        for paragraph in paragraphs[:3]:
            self.assertEqual(_styled(paragraph, bold=True, italic=False), visible_text(paragraph))
        self.assertEqual(_styled(paragraphs[4], bold=True, italic=False), "起草国：")
        self.assertEqual(_styled(paragraphs[8], bold=True, italic=True), visible_text(paragraphs[8]))
        self.assertEqual(_styled(paragraphs[10], bold=True, italic=True), "联合国大会，")

    def test_clause_emphasis_and_geometry(self):
        paragraphs = self.document.paragraphs
        preamble = paragraphs[12]
        self.assertEqual(_styled(preamble, underline=True), "注意到")
        # 页42: preambulatory clauses 18 pt apart, operative ones 15.5 pt; exact for text.
        self.assertAlmostEqual(preamble.paragraph_format.line_spacing.pt, 18.0, places=2)
        self.assertEqual(preamble.paragraph_format.line_spacing_rule, WD_LINE_SPACING.EXACTLY)
        article = paragraphs[15]
        self.assertAlmostEqual(article.paragraph_format.line_spacing.pt, 15.5, places=2)
        self.assertEqual(_styled(article, italic=True), "支持")
        self.assertEqual((article.paragraph_format.left_indent.pt, article.paragraph_format.first_line_indent.pt), (0, 0))
        subclause = paragraphs[17]
        self.assertEqual(_styled(subclause, italic=True), "")
        self.assertEqual((subclause.paragraph_format.left_indent.pt, subclause.paragraph_format.first_line_indent.pt), (48, -36))
        self.assertEqual(subclause.alignment, WD_ALIGN_PARAGRAPH.JUSTIFY)
        self.assertEqual(paragraphs[0].alignment, WD_ALIGN_PARAGRAPH.LEFT)

    def test_page_and_size(self):
        section = self.document.sections[0]
        self.assertEqual(
            (round(section.page_width.mm, 1), round(section.page_height.mm, 1), round(section.left_margin.mm, 2), round(section.top_margin.mm, 1)),
            (210.0, 297.0, 31.75, 25.4),
        )
        sizes = {run.font.size.pt for paragraph in self.document.paragraphs for run in visible_runs(paragraph) if run.text.strip()}
        self.assertEqual(sizes, {12})


class EnglishAmendmentTests(unittest.TestCase):
    """页53."""

    def test_layout(self):
        result, document = _run("friendly-amendment", _source([
            "Amendment 1.1.1",
            "The European Commission",
            "European Energy Security under the Russia-Ukraine Crisis",
            "Sponsors: Croatia, Cyprus, Italy, Malta, Slovenia",
            "Signatories: France, Germany, Spain",
            "1. Add as the operative clause 3 (b): “Encourages Energy Cooperation”",
        ]))
        self.assertEqual([item.code for item in result.validations if item.status == "error"], [])
        self.assertEqual(_lines(document), [
            "Amendment 1.1.1", "",
            "The European Commission", "",
            "European Energy Security under the Russia-Ukraine Crisis", "",
            "Sponsors: Croatia, Cyprus, Italy, Malta, Slovenia", "",
            "Signatories: France, Germany, Spain", "",
            "1. Add as the operative clause 3 (b): “Encourages Energy Cooperation”",
        ])
        operation = document.paragraphs[-1]
        self.assertIsNone(operation._p.pPr.numPr)  # typed number kept as written
        self.assertEqual(_styled(operation, italic=True), "Add")
        self.assertEqual((operation.paragraph_format.left_indent.pt, operation.paragraph_format.first_line_indent.pt), (0, 0))
        self.assertEqual(_styled(document.paragraphs[2], bold=True), "The European Commission")


class EnglishPositionPaperTests(unittest.TestCase):
    """页17–18: a blank line between paragraphs, none between proposals."""

    def test_layout(self):
        source = Document()
        for text in ("Position Paper", "Committee: General Assembly", "Topic: Soft Drugs", "Country: Afghanistan", "Delegate: Li Ying"):
            source.add_paragraph(text)
        source.add_paragraph("Soft drug, defined as non-addictive, is discussed here.")
        proposal = source.add_paragraph("1. Afghanistan ")
        proposal.add_run("suggests").italic = True
        proposal.add_run(" all member states act.")
        source.add_paragraph("2. Afghanistan declares its position.")
        source.add_paragraph("a) Afghanistan recommends domestic measures.")
        source.add_paragraph("Based on the aforementioned, Afghanistan will participate.")
        stream = BytesIO()
        source.save(stream)
        result, document = _run("position-paper", stream.getvalue())
        self.assertEqual([item.code for item in result.validations if item.status == "error"], [])
        self.assertEqual(_lines(document), [
            "Position Paper",
            "Committee: General Assembly",
            "Topic: Soft Drugs",
            "Country: Afghanistan",
            "Delegate: Li Ying",
            "",
            "Soft drug, defined as non-addictive, is discussed here.",
            "",
            "1.\tAfghanistan suggests all member states act.",
            "2.\tAfghanistan declares its position.",
            "a) Afghanistan recommends domestic measures.",
            "",
            "Based on the aforementioned, Afghanistan will participate.",
        ])
        paragraphs = document.paragraphs
        self.assertEqual(_styled(paragraphs[1], bold=True), "Committee: ")  # label run includes the space
        # The author's emphasis is kept in position papers.
        self.assertEqual(_styled(paragraphs[8], italic=True), "suggests")
        geometry = [(paragraph.paragraph_format.left_indent.pt, paragraph.paragraph_format.first_line_indent.pt) for paragraph in paragraphs[8:11]]
        self.assertEqual(geometry, [(21, -21), (21, -21), (42, -21)])


class NestingTests(unittest.TestCase):
    def test_word_numbered_subclauses_after_a_colon_nest_under_it(self):
        document = Document()
        for text in ("决议草案1.0", "委员会：联合国大会", "起草国：日本国", "附议国：法兰西共和国", "联合国大会，", "回顾以往决议，", "第一条 决定下列事项：", "（一）设立基金："):
            document.add_paragraph(text)
        for text in ("一般租借时间为50年；", "期满后自动延长；"):
            paragraph = document.add_paragraph(text)
            num_pr = paragraph._p.get_or_add_pPr().get_or_add_numPr()
            num_pr.get_or_add_ilvl().val = 0
            num_pr.get_or_add_numId().val = 7
            paragraph.paragraph_format.left_indent = Pt(0)
        document.add_paragraph("（二）定期报告。")
        stream = BytesIO()
        document.save(stream)
        _, output = _run("draft-resolution", _with_list_definition(stream.getvalue()))
        def find(prefix):
            return next(paragraph for paragraph in output.paragraphs if visible_text(paragraph).startswith(prefix))

        self.assertEqual(find("（一）").paragraph_format.left_indent.pt, 48)
        self.assertEqual(find("一般租借").paragraph_format.left_indent.pt, 67.5)
        self.assertEqual(find("期满后").paragraph_format.left_indent.pt, 67.5)
        self.assertEqual(find("（二）").paragraph_format.left_indent.pt, 48)
        self.assertTrue(visible_text(find("（一）")).endswith("："))
        self.assertTrue(visible_text(find("期满后")).endswith("；"))


def _with_list_definition(content: bytes) -> bytes:
    """Give numId 7 a numbering definition so Word would show the list."""

    document = Document(BytesIO(content))
    numbering = document.part.numbering_part.element
    abstract = OxmlElement("w:abstractNum")
    abstract.set(qn("w:abstractNumId"), "70")
    level = OxmlElement("w:lvl")
    level.set(qn("w:ilvl"), "0")
    fmt = OxmlElement("w:numFmt")
    fmt.set(qn("w:val"), "decimal")
    text = OxmlElement("w:lvlText")
    text.set(qn("w:val"), "%1.")
    level.extend([fmt, text])
    abstract.append(level)
    num = OxmlElement("w:num")
    num.set(qn("w:numId"), "7")
    ref = OxmlElement("w:abstractNumId")
    ref.set(qn("w:val"), "70")
    num.append(ref)
    numbering.insert(0, abstract)
    numbering.append(num)
    stream = BytesIO()
    document.save(stream)
    return stream.getvalue()


if __name__ == "__main__":
    unittest.main()
