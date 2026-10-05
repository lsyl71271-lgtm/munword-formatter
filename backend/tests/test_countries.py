"""Country normalization is field-scoped and re-proven by the content guard."""
import sys
import unittest
from io import BytesIO
from pathlib import Path

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.countries import COUNTRY_DATA, plan_countries, resolve_country, country_warnings
from app import content_guard
from app.pipelines import PIPELINES


def source(lines):
    doc = Document()
    for text in lines:
        doc.add_paragraph(text)
    stream = BytesIO(); doc.save(stream)
    return stream.getvalue()


def process(content, kind="position-paper", **options):
    result = PIPELINES[kind](ROOT / "templates" / "pkunmun2026").run(content, **options)
    errors = [item for item in result.validations if item.status == "error"]
    if errors:
        raise AssertionError(errors)
    return result, [paragraph.text for paragraph in Document(BytesIO(result.content)).paragraphs]


class CountryTests(unittest.TestCase):
    def test_page_breaks_preserved_and_manual_bypass_rejected(self):
        doc = Document(BytesIO(source(["立场文件", "委员会：联合国大会", "议题：合作", "国家：中国", "代表：甲", "正文不变。"])))
        node = OxmlElement("w:br"); node.set(qn("w:type"), "page")
        doc.paragraphs[3].add_run()._r.append(node)
        stream = BytesIO(); doc.save(stream)
        result, texts = process(stream.getvalue())
        self.assertTrue(any(v.code == "content-protected" for v in result.validations))
        self.assertIn("国家：中国", "".join(texts))
        with self.assertRaisesRegex(Exception, "不能安全改写"):
            process(stream.getvalue(), overrides={"country": "日本"})
        before = content_guard.Snapshot.take(doc)
        doc.paragraphs[3].clear(); doc.paragraphs[3].add_run("国家：中华人民共和国")
        log = {doc.paragraphs[3]._p: content_guard.Edit("field", "country", "国家：中华人民共和国")}
        self.assertTrue(content_guard.verify_format(before, doc, log, allowed_titles=(), labels=()))

    def test_plain_field_separators_and_manual_edits(self):
        for separator in ("tab", "br", "cr", "textWrapping"):
            for language in ("zh", "en"):
                prefix = ["工作文件1.1", "委员会：联合国大会", "议题：合作"] if language == "zh" else ["Working Paper 1.1", "Committee: General Assembly", "Topic: Cooperation"]
                doc = Document(BytesIO(source(prefix)))
                p = doc.add_paragraph("起草国：" if language == "zh" else "Sponsors: ")
                for name in (["中国", "美国"] if language == "zh" else ["China", "USA"]):
                    node = OxmlElement("w:br" if separator == "textWrapping" else "w:" + separator)
                    if separator == "textWrapping":
                        node.set(qn("w:type"), "textWrapping")
                    p.add_run()._r.append(node)
                    p.add_run(name)
                doc.add_paragraph("第一条 要求继续合作。" if language == "zh" else "1. Calls for continued cooperation;")
                stream = BytesIO(); doc.save(stream)
                for overrides in ({}, {"sponsors": ["日本", "中国"] if language == "zh" else ["Japan", "China"]}):
                    result, texts = process(stream.getvalue(), "working-paper", overrides=overrides)
                    self.assertIn("中华人民共和国" if language == "zh" else "People's Republic of China", "".join(texts))
                    self.assertFalse(any(v.code == "content-protected" for v in result.validations))
                    self.assertEqual(process(result.content, "working-paper")[1], texts)

    def test_missing_manual_fields_are_reported(self):
        result, texts = process(source(["立场文件", "委员会：联合国大会", "国家：中国", "正文：这个内容必须保持不变。"]), overrides={"delegate": "新增代表", "topic": "新增议题"})
        warnings = [v for v in result.validations if v.code == "manual-field-unwritten"]
        self.assertEqual(len(warnings), 2)
        self.assertTrue(all(v.status == "warning" and "未写入" in v.detail for v in warnings))
        self.assertNotIn("新增", "".join(texts))
        result, texts = process(source(["工作文件1.1", "委员会：联合国大会", "议题：合作", "第一条 正文不变。"]), "working-paper", overrides={"sponsors": ["中国"]})
        self.assertTrue(any(v.code == "manual-field-unwritten" and "起草国" in v.detail for v in result.validations))
        self.assertNotIn("中华人民共和国", "".join(texts))

    def test_all_records_and_formal_forms(self):
        self.assertEqual(len(COUNTRY_DATA["records"]), 197)
        self.assertEqual(sum(item["kind"] == "member-state" for item in COUNTRY_DATA["records"]), 193)
        for record in COUNTRY_DATA["records"]:
            for lang in ("zh", "en"):
                self.assertEqual(resolve_country(record["formal"][lang], lang)["display"], record["formal"][lang])
                self.assertTrue(record["source"] and record["checked_on"])

    def test_names_identity_language_dedup_sort_and_ambiguity(self):
        self.assertEqual(resolve_country("中国", "zh")["display"], "中华人民共和国")
        self.assertEqual(resolve_country("中国", "en")["display"], "People's Republic of China")
        self.assertEqual(resolve_country("the People's Republic of China", "en")["display"], "the People's Republic of China")
        plan = plan_countries(["美国", "中国", "China", "中华人民共和国", "日本", "韩国", "美国"], "zh")
        self.assertEqual(plan["values"], ["大韩民国", "美利坚合众国", "日本国", "中华人民共和国"])
        self.assertEqual(plan["removedDuplicates"], 3)
        self.assertEqual(plan_countries(plan["values"], "zh")["values"], plan["values"])
        for value in ("刚果", "Korea", "苏联", "未知共和国", "中国与美国", "联合国", "巴勒斯坦"):
            self.assertEqual(resolve_country(value, "zh")["display"], value)
            self.assertTrue(country_warnings([value], "zh"))

    def test_field_scope_manual_entrance_and_idempotence(self):
        content = source(["立场文件", "委员会：联合国大会", "议题：合作", "代表国家：中国", "代表：中国", "中国支持韩国。引文：中国与美国。", "国家：中国不是可替换的正文标签。"])
        result, texts = process(content)
        self.assertIn("国家：中华人民共和国", texts)
        self.assertIn("代表：中国", texts)
        self.assertIn("中国支持韩国。引文：中国与美国。", texts)
        self.assertIn("国家：中国不是可替换的正文标签。", texts)
        self.assertTrue(any(item.code == "country_names" and "UN-M49-156" in item.detail for item in result.validations))
        self.assertEqual(process(result.content)[1], texts)
        edited, texts = process(content, overrides={"country": "美国"})
        self.assertIn("国家：美利坚合众国", texts)
        self.assertTrue(any(item.code == "structural_edits" and "人工确认" in item.detail for item in edited.validations))

    def test_lists_without_manual_filling_and_unknowns_preserved(self):
        content = source(["工作文件1.1", "委员会：联合国大会", "议题：合作", "提案国：中国、China、中华人民共和国、美国", "附议国：韩国、刚果、苏联、欧盟", "第一条 要求中国与美国继续合作。"])
        result, texts = process(content, "working-paper", preserve_country_order=True, normalize_punctuation=False)
        self.assertIn("起草国：中华人民共和国、美利坚合众国", "".join(texts))
        self.assertIn("大韩民国、刚果、苏联、欧盟", "".join(texts))
        self.assertIn("1. 要求中国与美国继续合作。", texts)  # WP marker changes; body country names do not.
        self.assertEqual(process(result.content, "working-paper", preserve_country_order=True, normalize_punctuation=False)[1], texts)

    def test_complex_fields_preserved_not_flattened(self):
        doc = Document(BytesIO(source(["立场文件", "委员会：联合国大会", "议题：合作", "国家：", "代表：甲", "中国支持合作。"])))
        p = doc.paragraphs[3]._p
        insertion = OxmlElement("w:ins"); insertion.set(qn("w:id"), "3"); insertion.set(qn("w:author"), "Reviewer")
        r, t = OxmlElement("w:r"), OxmlElement("w:t"); t.text = "中国"; r.append(t); insertion.append(r); p.append(insertion)
        out = BytesIO(); doc.save(out)
        result, _ = process(out.getvalue())
        output = Document(BytesIO(result.content))
        self.assertEqual(output.paragraphs[3]._p.find(qn("w:ins")).find(qn("w:r")).find(qn("w:t")).text, "中国")
        self.assertTrue(any(item.code == "content-protected" for item in result.validations))
        self.assertFalse(any(item.code == "country_names" for item in result.validations))

    def test_guard_does_not_trust_arbitrary_expected_country(self):
        doc = Document(BytesIO(source(["国家：中国"])))
        before = content_guard.Snapshot.take(doc); p = doc.paragraphs[0]; p.text = "国家：美利坚合众国"
        edit = content_guard.Edit("country-name", "country", p.text, False, {"language": "zh", "preserveOrder": False, "manual": False})
        self.assertTrue(content_guard.verify_format(before, doc, {p._p: edit}, allowed_titles=(), labels=()))

    def test_duplicate_field_is_not_guessed(self):
        content = source(["立场文件", "委员会：联合国大会", "议题：合作", "国家：中国", "国家：日本", "代表：甲", "正文应保持不变。"])
        result, texts = process(content)
        self.assertIn("国家：中国", texts); self.assertIn("国家：日本", texts)
        self.assertTrue(any(item.code == "content-protected" and "多个同名" in item.detail for item in result.validations))
