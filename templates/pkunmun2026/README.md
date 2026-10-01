# PKUNMUN 2026 排版规则

排版规则只保存在一个地方：`shared/document-policy.json`。浏览器引擎（网页版）和 Python 引擎（本机版）都读取这个文件。

- `handbook` 部分是按《PKUNMUN2026 学术标准手册》各文种范例实测的数值，每个数值都注明了手册页码。
  - `page`：页面与页边距；
  - `bodySizePt`、`noteSizePt`：正文与脚注字号；
  - `fonts`：字体；
  - `lineSpacing`：行距；
  - `signatureLines`：签字留白；
  - `countryOrder`：国家排序；
  - `outputTitles`：标题写法；
  - `types.<文种>.<语言>`：各文种的缩进、强调、空行与标点。
- `prefixes` 部分是序言性、行动性动词表。
- `metadata` 部分是页首标签。

每年更新规则时只改这个 JSON。`backend/tests/test_policy.py` 会校验它的结构和取值范围。本目录只作为安装位置保留，路径由本机引擎传入。
