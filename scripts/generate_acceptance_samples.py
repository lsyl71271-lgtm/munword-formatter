from __future__ import annotations

import sys
from pathlib import Path

from docx import Document


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.pipelines import PIPELINES  # noqa: E402


CASES = {
    "01_中文立场文件": (
        "position-paper",
        ["立场文件", "委员会：联合国环境大会", "议题：塑料污染治理", "国家/席位：日本国", "代表：示例代表", "塑料污染跨越国界，需要多边合作与可执行的时间表。", "日本支持兼顾环境目标、技术可行性与发展差异的全球安排。"],
    ),
    "02_English_Position_Paper": (
        "position-paper",
        ["Position Paper", "Committee: United Nations Environment Assembly", "Topic: Plastic Pollution", "Country: Japan", "Delegate: Sample Delegate", "Plastic pollution crosses borders and requires practical multilateral cooperation.", "Japan supports an ambitious framework that remains technically achievable."],
    ),
    "03_中文工作文件": (
        "working-paper",
        ["工作文件 [编号]", "委员会：联合国环境大会", "议题：塑料污染治理", "起草国：日本国，中国，巴西联邦共和国", "1. 建立技术交流平台", "(a) 汇总可复制的减塑实践", "(i) 每半年提交一次进展说明", "2. 鼓励自愿资金支持"],
    ),
    "04_English_Working_Paper": (
        "working-paper",
        ["WORKING PAPER [number]", "Committee: United Nations Environment Assembly", "Topic: Plastic Pollution", "Sponsors: Japan, Brazil, Canada", "1. Establishes a technical exchange platform", "(a) Collects replicable practices", "(i) Reports progress every six months", "2. Encourages voluntary financial support"],
    ),
    "05_中文指令草案": (
        "draft-directive",
        ["指令草案 [编号]", "委员会：安全理事会", "起草国：日本国，法国，巴西联邦共和国", "附议国：加拿大，澳大利亚", "安全理事会，", "1. 要求秘书长在四十八小时内提交局势报告", "2. 决定设立临时协调机制"],
    ),
    "06_English_Draft_Directive": (
        "draft-directive",
        ["Draft Directive [number]", "Committee: Security Council", "Sponsors: Japan, France, Brazil", "Signatories: Canada, Australia", "The Committee,", "1. Requests the Secretary-General to report within forty-eight hours", "2. Decides to establish a temporary coordination mechanism"],
    ),
    "07_中文决议草案": (
        "draft-resolution",
        ["决议草案 [编号]", "委员会：联合国大会", "议题：塑料污染治理", "起草国：日本国，中国，巴西联邦共和国", "附议国：加拿大，澳大利亚", "联合国大会，", "回顾大会关于海洋环境保护的相关决议，", "注意到塑料污染对沿海社区造成的影响，", "第一条 要求各会员国制定可衡量的国家行动计划；", "（一）鼓励在计划中列明阶段性目标；", "（子）建议明确阶段性目标的核验方法；", "（甲）要求每年提交一次执行说明；", "第二条 决定在现有资源范围内建立信息共享机制。"],
    ),
    "08_English_Draft_Resolution": (
        "draft-resolution",
        ["DRAFT RESOLUTION [number]", "Committee: General Assembly", "Topic: Plastic Pollution", "Sponsors: Japan, Brazil, Canada", "Signatories: Australia, France", "The General Assembly,", "Recalling its relevant resolutions on marine protection,", "Recognizing the effects of plastic pollution on coastal communities,", "1. Requests Member States to adopt measurable national action plans;", "(a) Encourages the inclusion of interim targets;", "2. Decides to establish an information-sharing mechanism within existing resources."],
    ),
    "09_中文友好修正案": (
        "friendly-amendment",
        ["友好修正案 [编号]", "委员会：联合国大会", "议题：塑料污染治理", "起草国：日本国，巴西联邦共和国", "附议国：加拿大", "1. 加入“在现有资源范围内”作为第二条的限定语。"],
    ),
    "10_中文非友好修正案": (
        "unfriendly-amendment",
        ["非友好修正案 [编号]", "委员会：联合国大会", "议题：塑料污染治理", "起草国：法国", "附议国：加拿大，澳大利亚", "1. 修改第二条，将“每年”改为“每两年”。"],
    ),
    "11_English_Amendment": (
        "friendly-amendment",
        ["Friendly Amendment [number]", "Committee: General Assembly", "Topic: Plastic Pollution", "Sponsors: Japan", "Signatories: Canada", "1. Add the phrase “within existing resources” to operative clause 2."],
    ),
    # Three parties in the title, two representatives in the signature block: the third is added.
    "12_中文外交协定": (
        "diplomatic-agreement",
        ["日本国、巴西联邦共和国与加拿大关于海洋塑料污染监测合作的协定", "",
         "鉴于塑料污染跨越国界，日本国、巴西联邦共和国与加拿大（以下简称“三方”）愿意加强监测合作，达成协议如下：",
         "第一章 合作范围", "第一条 三方共同建立海洋塑料污染监测数据交换机制；", "第二条 三方每年共同发布一次监测报告。",
         "第二章 生效与期限", "第三条 本协定自三方完成各自国内程序并相互通知之日起生效，有效期五年。",
         "本协定于2026年5月1日签订，一式三份，每份均以中文、英文和葡萄牙文写成，三种文本同等作准。", "",
         "日本国代表        巴西联邦共和国代表", "示例甲        示例乙"],
    ),
    # Four parties over a two-line title and no signature block: two rows of two, names left blank.
    "13_中文联合声明": (
        "joint-statement",
        ["日本国、法兰西共和国、巴西联邦共和国、加拿大", "就海洋塑料污染治理的联合声明",
         "2026年5月1日，四方在东京举行会谈，共同声明如下：", "四方重申对《联合国海洋法公约》的承诺。",
         "“各国有保护和保全海洋环境的义务。”", "四方同意每年举行一次部长级会议。"],
    ),
    "14_English_Joint_Statement": (
        "joint-statement",
        ["Joint Statement of Japan, Trinidad and Tobago and Canada on Ocean Plastic Monitoring",
         "The parties hereby declare as follows:", "The parties will share monitoring data every quarter.",
         "The parties will publish a joint report each year.",
         "Representative of Japan    Representative of Canada", "Sample Delegate A    Sample Delegate B"],
    ),
}


def make_docx(paragraphs: list[str], path: Path) -> None:
    document = Document()
    for text in paragraphs:
        document.add_paragraph(text)
    document.save(path)


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--outputs-only", action="store_true", help="Keep the checked-in input bytes unchanged")
    parser.add_argument("--only", nargs="*", default=None, help="Write only these inputs (names without .docx); the others keep their bytes")
    args = parser.parse_args()
    inputs = ROOT / "examples" / "acceptance-inputs"
    outputs = ROOT / "examples" / "acceptance-outputs"
    inputs.mkdir(parents=True, exist_ok=True)
    outputs.mkdir(parents=True, exist_ok=True)
    template_dir = ROOT / "templates" / "pkunmun2026"
    for name, (document_type, paragraphs) in CASES.items():
        source = inputs / f"{name}.docx"
        if args.only is not None and name not in args.only:
            continue
        if not args.outputs_only:
            make_docx(paragraphs, source)
        content = source.read_bytes()
        result = PIPELINES[document_type](template_dir).run(content, submitting_country="日本国", version="v1")
        (outputs / result.filename.replace(".docx", f"_{name}.docx")).write_bytes(result.content)
    print(f"Generated {len(CASES) if args.only is None else len(args.only)} input and output DOCX samples.")


if __name__ == "__main__":
    main()
