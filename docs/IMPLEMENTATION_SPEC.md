# PKUNMUN 2026 文件自动排版系统 · 实现与需求规格

> - 版本基线：v1.8.5（`VERSION`），桌面安装包发布 `v1.8.5-desktop.2`。
> - 读者：要维护、审查或从零复原本程序的程序员与 AI。
> - 目标：只读本文就能理解每一处逻辑为什么存在、怎样实现、界面长什么样、本机应用怎样打包，并能写出行为一致的程序。

## 目录

- [0. 怎样读这份文档](#0-怎样读这份文档)
- [1. 产品定义](#1-产品定义)
- [2. 总体架构](#2-总体架构)
- [3. 界面规格](#3-界面规格)
- [4. 数据模型](#4-数据模型)
- [5. DOCX 包的安全读取（`app/docx-safety.ts`）](#5-docx-包的安全读取appdocx-safetyts)
- [6. 解析与样式继承显式化（`docx-browser.ts:parsePackage`）](#6-解析与样式继承显式化docx-browsertsparsepackage)
- [7. 识别算法（`docx-browser.ts:recognize`）](#7-识别算法docx-browsertsrecognize)
- [8. 排版流水线（`docx-browser.ts:formatDocxInBrowser` → `formatInner`）](#8-排版流水线docx-browsertsformatdocxinbrowser--formatinner)
- [9. 学标版式参数（`shared/document-policy.json` → `handbook`）](#9-学标版式参数shareddocument-policyjson--handbook)
- [10. 编号系统（`app/numbering.ts`，镜像 `backend/app/numbering.py`）](#10-编号系统appnumberingts镜像-backendappnumberingpy)
- [11. 国家名称（`app/countries.ts`、`shared/country-names.json`）](#11-国家名称appcountriestssharedcountry-namesjson)
- [12. 内容保护模型（`app/content-guard.ts`，镜像 `backend/app/content_guard.py`）](#12-内容保护模型appcontent-guardts镜像-backendappcontent_guardpy)
- [13. 校验项代码表](#13-校验项代码表)
- [14. 页面预览（`preview-safety.ts`、`preview-renderer.ts`、`docx-preview.tsx`）](#14-页面预览preview-safetytspreview-renderertsdocx-previewtsx)
- [15. 模板新建（`template-generator.ts`、`template-panel.tsx`）](#15-模板新建template-generatortstemplate-paneltsx)
- [16. 诊断报告](#16-诊断报告)
- [17. Python 兼容引擎、HTTP API 与 CLI（`backend/`）](#17-python-兼容引擎http-api-与-clibackend)
- [18. 本机服务版（旧的 Python 本机安装）](#18-本机服务版旧的-python-本机安装)
- [19. 桌面离线安装包（`desktop/`）](#19-桌面离线安装包desktop)
- [20. 安卓安装包（`android/`）](#20-安卓安装包android)
- [21. 网页部署](#21-网页部署)
- [22. 发布与持续集成](#22-发布与持续集成)
- [23. 测试体系](#23-测试体系)
- [24. 验收标准（复原后的程序应满足）](#24-验收标准复原后的程序应满足)
- [25. 从零复原的建议顺序](#25-从零复原的建议顺序)
- [附录 A：序言与行动动词前缀（`document-policy.json` → `prefixes`）](#附录-a序言与行动动词前缀document-policyjson--prefixes)
- [附录 B：关键正则（逐字）](#附录-b关键正则逐字)
- [附录 C：相关文档](#附录-c相关文档)

## 0. 怎样读这份文档

- **权威来源**：代码和 `shared/*.json` 是唯一事实来源。本文与代码不一致时，以代码为准，并修正本文。
  - 文中的数值、正则和文案都从代码逐字摘录。
  - 引用位置写成 `文件:函数`，方便对照。
- **主引擎**：浏览器引擎 `app/docx-browser.ts` 是日常使用的引擎（网页版、桌面版都用它）。
  - Python 引擎 `backend/app/` 是兼容的 API/CLI，算法逐步镜像浏览器引擎。
  - 本文以浏览器引擎为主线，第 17 章列出 Python 的差异。
- **术语**：

| 术语 | 含义 |
|---|---|
| 学标 / 手册 | 《PKUNMUN2026 学术标准手册》（94 页）。示例页：15–18（立场文件）、31–35（工作文件）、37–38（指令草案）、41–47（决议草案）、52–53（修正案） |
| 原稿 | 用户上传的 `.docx`，内容完整但格式不规范 |
| 成稿 | 程序输出的 `.docx` |
| 段落（flow paragraph） | 正文主流中的 `w:p`，包括内容控件 `w:sdt` 和 `w:customXml` 里的段落；不含表格单元格和文本框里的段落 |
| run | `w:r`，一段格式相同的文字 |
| twip | 1/20 磅。A4 宽 11906 twips |
| 第 03 步 | 界面上的“确认识别结果”，用户可以人工改字段 |
| 签名 | 段落的“内容签名”，一串带类型的记号（第 12 章），用来证明内容没被改动 |

## 1. 产品定义

### 1.1 一句话

把**内容完整、格式混乱**的模拟联合国（MUN）DOCX 文件，按 PKUNMUN 2026 学标自动排成规范格式，并输出**仍可在 Word / WPS 中编辑**的 DOCX。全程不改动作者写的正文。

### 1.2 输入与输出

- **输入**：一份 `.docx`，不超过 20 MiB。
  - 不支持 `.doc`、PDF、纯文本、加密文档。
- **用户选择**：六种文种之一；语言由程序识别，用户可改。
- **输出**：`.docx` 文件，文件名形如 `决议草案 S3 法兰西共和国 v1.docx`。
- **附带结果**：一组校验结果（✓/△/×），和一份可下载的诊断报告 JSON。

### 1.3 六种文种

| 内部 id | 徽标 | 中文 | 英文 | 学标页 |
|---|---|---|---|---|
| `position-paper` | PP | 立场文件 | Position Paper | 15–18 |
| `working-paper` | WP | 工作文件 | Working Paper | 31–35 |
| `draft-directive` | DD | 指令草案 | Draft Directive | 37–38 |
| `draft-resolution` | DR | 决议草案 | Draft Resolution | 41–47（默认选中） |
| `friendly-amendment` | FA | 友好修正案 | Friendly Amendment | 52–53 |
| `unfriendly-amendment` | UA | 非友好修正案 | Unfriendly Amendment | 52–53 |

两种修正案共用一套版式规格（`amendment`）。

### 1.4 设计原则（需求层面的硬约束）

1. **只改格式，不改内容。**
   - 正文文字、图片、链接、域、书签、脚注、批注、修订痕迹、隐藏文字、删除线都必须原样保留。
   - 程序允许的文字改动只有一张白名单（第 12.3 节），每一处都要记入“编辑日志”，并在输出前独立复核。
2. **有证据才改，没证据只提示。**
   - 层级、编号、国家名等凡是不能从原稿证明的，一律保留原样，并在校验结果里给出 △ 提示。
3. **第 03 步人工确认入口必须保留。**
   - 识别不出的字段由用户在界面上填写。
   - 程序和自动化测试都不得“代填”第 03 步来掩盖识别错误。
4. **规则通用，不针对样例。**
   - 不按文件名、国家名、议题或固定文本做特判。
   - 样例只用于回归验证。
5. **本地处理。**
   - 网页版和桌面版都在浏览器里完成解析和排版，原稿不上传。
   - 桌面版的页面用内容安全策略（CSP）禁止一切网络连接。
6. **不用 AI 生成内容。** 模板新建功能也要求用户自己填写正文。
7. **出错就不给文件。** 任何一项校验为“错误”时，中止下载并说明原因，绝不输出可能改坏内容的文件。

### 1.5 不做的事与已知限制

- 不支持 `.doc` / PDF 输入；不做 OCR。
- 不补缺号、不猜错字、不给条款排序、不改正文中的交叉引用。
- HTML 页面预览只是近似，分页与字体以 Word / WPS 为准。
- 处理在浏览器主线程同步完成，大文件处理时页面会短暂无响应。
- 包体积预算：上传 20 MiB；解压后合计 100 MiB；单个 XML 16 MiB；最多 5000 个部件；压缩比不超过 250；XML 嵌套不超过 256 层；只接受 STORE/DEFLATE 压缩；Python 端 multipart 请求体上限 21 MiB。

## 2. 总体架构

### 2.1 运行形态

“一套界面、一个浏览器引擎、多个外壳”（`docs/adr-0001-shared-daily-interface.md`）：

| 形态 | 外壳 | 排版在哪里运行 | 入口 |
|---|---|---|---|
| 网页版 | Cloudflare Pages / Workers 静态托管 | 用户浏览器 | https://munword-formatter.pages.dev/ |
| 桌面离线版（推荐给普通用户） | macOS `.app`（DMG）/ Windows NSIS 安装程序（EXE） | 本机浏览器，从 `file://` 打开 | 双击图标 |
| 安卓版 | Java 写的 WebView 应用（APK，Android 5.0+） | 手机系统的 WebView，从应用自带的文件打开 | 桌面图标，或对 DOCX 选「其他应用打开」 |
| 本机服务版（旧） | Python FastAPI 在 127.0.0.1:8000 提供页面资源 | 仍在浏览器（服务只供资源） | `首次安装.command` / `Windows 首次安装.bat` |
| 开发 / API | vinext（Next.js 兼容）开发服务器；可选 `NEXT_PUBLIC_API_URL` 指向 Python API | 浏览器，或配置了 API 时在 Python | `pnpm dev` |
| 批处理 | Python CLI `backend/cli.py` | Python | 命令行 |

面向用户的形态（网页、桌面、安卓、本机服务）加载的是**同一份**界面和引擎：

- `local_web/main.tsx` 只是把 `app/page.tsx` 的 `<Home/>` 挂到 `#root`；
- 构建出的 `public/local-app.js` 和 `public/local-styles.css` 同时用于静态站点、桌面安装包和本机服务；
- 安卓版把同一个 `local_web/main.tsx` 按 Chromium 69 重新编译，样式表由同一份 `public/local-styles.css` 加旧引擎降级得到（第 20 章）。

### 2.2 目录结构

```
app/                    React 界面与浏览器引擎（TypeScript）
  page.tsx              唯一的界面组件 <Home/>
  globals.css           全部样式（含 Tailwind 4 的 reset）
  layout.tsx            Next/vinext 外壳：<title>、lang="zh-CN"、og 图
  docx-browser.ts       浏览器引擎：解析、识别、排版、校验（约 2000 行）
  docx-safety.ts        ZIP/XML 安全读取、文本切分工具
  content-guard.ts      内容签名、编辑白名单、包级校验
  numbering.ts          编号系列、层级规划、原生编号转换
  countries.ts          国家名称解析、排序、去重
  field-policy.ts       字段分隔符白名单、国家名单切分
  request-validation.ts 第 03 步输入校验
  diagnostics.ts        只读诊断报告
  template-generator.ts 从模板新建文件
  template-panel.tsx    模板新建面板
  preview-safety.ts     预览前剥离外部引用
  preview-renderer.ts   docx-preview 渲染到沙箱 iframe
  docx-preview.tsx      预览组件
  chatgpt-auth.ts       保留的脚手架，未启用
backend/                Python 兼容引擎、FastAPI 服务、CLI
  app/main.py           HTTP 服务
  app/pipelines.py      六个文种的流水线
  app/parser.py         识别
  app/structure_repair.py  结构修复
  app/formatters/       排版（base.py、handbook_pass.py 等）
  app/content_guard.py  内容保护
  cli.py                批处理
  run.py                uvicorn 启动（127.0.0.1:8000）
shared/                 两个引擎共用的策略 JSON（第 2.5 节）
local_web/              本机/静态页面外壳（index.html、main.tsx）
desktop/                桌面离线安装包的构建脚本、启动器、验收脚本
android/                安卓应用（Java 外壳、手机版页面与旧 WebView 兼容层）、构建与验收脚本
downloads/              已发布的 DMG、EXE、APK、SHA256SUMS.txt、安装教程
scripts/                构建、打包、审计、回归脚本
windows/                本机服务版的 PowerShell 安装/启动脚本
templates/pkunmun2026/  Python 流水线的模板目录参数（目前只有说明文件，版式全部来自 shared/）
examples/acceptance-inputs/  11 份验收原稿（六种文种、中英文）
tests/                  Node 测试（*.test.mjs）与引擎一致性夹具
backend/tests/          Python unittest
worker/, build/, db/, drizzle/  vinext/Cloudflare 入口与保留的 D1 脚手架（未启用）
docs/                   架构、ADR、学标对照、版本说明、审计报告
```

### 2.3 技术栈（锁定版本见 `package.json`、`pnpm-lock.yaml`、`backend/requirements.txt`）

- **前端**：
  - React 19.2.8、TypeScript 5.9；
  - vinext 0.0.50（Next.js 16 兼容层，Vite 8 构建，可部署到 Cloudflare Workers）；
  - Tailwind CSS 4.2（只用它的 reset，样式基本是手写的类）。`app/globals.css` 用 `source(none)` 关闭自动扫描，只从 `app/**/*.tsx` 和 `local_web/*.tsx` 生成工具类。
- **浏览器引擎依赖**：
  - `fflate` 0.7.5：ZIP 读写；
  - 浏览器原生 `DOMParser` / `XMLSerializer`：XML；
  - `docx-preview` 0.4.0：页面预览；
  - `docxtemplater` 3.71 + `pizzip` 3.3：模板新建。
- **打包工具**：esbuild 0.28（把 `local_web/main.tsx` 打成单个 IIFE）、PostCSS + `@tailwindcss/postcss`。
- **开发环境**：Node ≥ 22.13（README 推荐 Node 24），pnpm 11.19.0。
- **Python**：3.12+（兼容 3.9 仅为旧安装）。
  - FastAPI 0.142、uvicorn 0.35、python-multipart 0.0.32；
  - python-docx 1.2.0、lxml 6.1.3。
- **桌面打包**：
  - NSIS 3（makensis）；
  - macOS 上用 `codesign` + `hdiutil`；
  - Linux 上用 `rcodesign`（apple-codesign 0.29.0）+ `mkfs.hfsplus` + 打过补丁的 libdmg-hfsplus + libfaketime；
  - 启动器存根用 clang（macOS），或 zig + llvm-lipo（Linux）。

### 2.4 端到端数据流

```
用户选择文种 ──► 拖入/选择 .docx
                    │
                    ▼  file.arrayBuffer()
          parseDocxInBrowser(content, type)
            readPackage  安全解包（第 5 章）
            parsePackage 样式继承显式化（第 6 章）
            recognize    识别字段与条款（第 7 章）
                    │  BrowserModel
                    ▼
        第 03 步：用户核对/修改字段、选项
                    │  model（可能已修改）+ 选项
                    ▼
          formatDocxInBrowser(content, model, options)
            validateReview  输入白名单
            formatInner     重新解包 → 结构修复 → 再识别
                            → 快照 → 21 个排版步骤（第 8 章）
                            → verifyFormat / verifyMarks / zip / verifyPackage
                    │
         ┌──────────┴───────────┐
   有 error 校验项             全部 pass/warning
   抛错，界面显示原因           Blob 下载 + 显示校验结果（第 04 步）
```

### 2.5 共享策略文件 `shared/`

两个引擎都在运行时读取这些 JSON，修改规则只改这里：

| 文件 | 内容 |
|---|---|
| `document-policy.json`（schemaVersion 3） | 学标版式（页面、字号、字体、行距、各文种×语言的规格）、标题词、页首字段别名、序言/行动动词前缀、主体句、语言判定、页首边界、内嵌子条款、各文种的识别/修复开关、修正案动词 |
| `numbering-profiles.json` | 六个文种的编号系列（每级的系列、Word numFmt、显示模板） |
| `dr-numbering-policy.json` | 决议草案编号；中文数字、地支、天干字表；原生 numFmt → 系列映射；各系列默认层级 |
| `workflow-policy.json` | 各文种必填字段、字段中文名、角色名与识别依据说明、限制声明（用于诊断报告） |
| `package-policy.json` | DOCX 包体积与结构上限 |
| `field-edit-policy.json` | 可视为普通分隔符的记号（tab/cr/br）；国家名空白字符集；国家名单分隔符 `,，、;；/\|\n\r\t` |
| `local-build-policy.json` | 离线界面构建的源码清单和产物清单（用于来源校验） |
| `country-names.json` | 197 条国家/实体记录（UNTERM / M49），含正式名、简称、排序名、别名、待确认名单 |
| `country-pinyin.json` | 国名拼音：词组读音 + 单字读音，最长匹配 |
| `region-names-en.json` | 英文地区名（判断英文国家名单续行用） |

## 3. 界面规格

### 3.1 视觉系统

- **风格**：浅蓝玻璃拟态（glassmorphism），学术、克制。
- **颜色变量**（`:root`）：

| 变量 | 值 | 用途 |
|---|---|---|
| `--ink` | `#142b46` | 正文 |
| `--muted` | `#536b83` | 次要文字 |
| `--navy` | `#116ba8` | 深蓝 |
| `--blue` | `#007db8` | 强调蓝 |
| `--line` | `rgba(79,128,164,.18)` | 分隔线 |
| `--success` | `#15745c` | ✓ |
| `--warning` | `#8c5b16` | △ |
| `--error` | `#b13149` | × |
| `--glass` | `rgba(255,255,255,.72)` | 玻璃卡片 |
| `--shadow` | `0 24px 70px -32px #205e8c57, inset 0 1px 0 #fff` | 卡片阴影 |

- **背景**：底色 `#edf5fa`，叠加固定伪元素 `body::before`，由三处径向渐变（`#a8ddf3`、`#d0e6fb`、`#e1f7fa`）和一层 `#f8fcff → #eaf2fa → #f6fbfd` 的线性渐变组成。
- **字体**：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`，16px/1.5。
  - 预览纸面用 `"Songti SC", SimSun, "Times New Roman", serif`，15px/1.9。
- **版心**：页首、主视觉、工作区、页脚都是 `width: min(1280px, 100% - 64px)`，水平居中。
- **工作区卡片**：CSS 背景滤镜做 28px 模糊、125% 饱和度（见 `globals.css` 的 `.workspace`），圆角 30px，白色半透明描边。
- **主按钮**：
  - 背景渐变 `#219ed0 → #076fa9`，圆角 15px，最小 185×48；
  - 悬停时上移 2px；禁用时背景 `#e0eaf1`、文字 `#6d8599`。
- **焦点**：`:focus-visible` 显示 3px `#087db9` 轮廓，偏移 4px。
- **响应式断点**：

| 宽度 | 变化 |
|---|---|
| ≤ 1060px | 文种区与上传区仍是两列，列宽和间距缩小 |
| ≤ 850px | DOCX 预览由两列改为一列 |
| ≤ 820px | 主视觉竖排；文种区和上传区上下排列；文种卡片 3 列；表单 2 列；结构预览、校验结果都改为 1 列 |
| ≤ 520px | 文种卡片 2 列；表单与选项都改为 1 列 |

- **无障碍偏好**：
  - `prefers-reduced-transparency` 时去掉模糊，改为实色 `#f7fbfe`；
  - `prefers-reduced-motion` 时取消所有过渡和动画。

### 3.2 页面线框（桌面宽度）

```
┌──────────────────────────────────────────────────────────────────────┐
│ [P] PKUNMUN 2026                      ● 浏览器本地处理 · 内容不上传云端 │  ← siteHeader
│     DOCUMENT STUDIO                                                    │
├──────────────────────────────────────────────────────────────────────┤
│ ACADEMIC DOCUMENTS / 学术文件                 (保留原文内容)(可编辑 DOCX)│  ← hero
│ 让表达，井然有序。                              (生成前后校验)          │
│ 把内容交给你，把格式交给系统。选择文件类型，上传原稿，开启排版。        │
├──────────────────────────────────────────────────────────────────────┤
│ ╭────────────────────────── workspace（玻璃卡片）──────────────────╮ │
│ │ [01 选择类型] [02 上传原稿] [03 确认识别] [04 生成下载]   ← stepper │ │
│ │ ─────────────────────────────────────────────────────────────── │ │
│ │ 01 选择文件类型                │ 02 上传你的原稿                  │ │
│ │ 为你的文件匹配排版规则          │ 格式交给系统，内容仍由你掌握      │ │
│ │ ┌────────┐ ┌────────┐          │ ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐ │ │
│ │ │PP     ○│ │WP     ○│          │      [文件图标]                  │ │
│ │ │立场文件│ │工作文件│          │ │    将文件拖到这里             │ │ │
│ │ │Position│ │Working │          │      或 浏览本地文件             │ │
│ │ └────────┘ └────────┘          │ │  DOCX 格式 · 最大 20 MB       │ │ │
│ │ ┌────────┐ ┌────────┐          │ └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘ │ │
│ │ │DD     ○│ │DR     ◉│          │ 当前类型                          │ │
│ │ └────────┘ └────────┘          │ 决议草案          [识别文件结构 →]│ │
│ │ ┌────────┐ ┌────────┐          │                                   │ │
│ │ │FA     ○│ │UA     ○│          │                                   │ │
│ │ └────────┘ └────────┘          │                                   │ │
│ │ ▸ 从规范模板新建文件                                    ← details   │ │
│ │ ─────────────────（识别后出现）────────────────────────────────── │ │
│ │ 03 确认识别结果                                                    │ │
│ │ [国家字段将自动使用正式全称…]                    ← countryReview   │ │
│ │ 语言[中文▾]   委员会[____]   议题[____]                             │ │
│ │ 起草国（逗号分隔）[______________]  附议国（逗号分隔）[_________]   │ │
│ │ [需要确认 △ …]                                   ← warningList     │ │
│ │ ▸ 识别依据与诊断报告                                                │ │
│ │ [查看实际 DOCX 页面] [再次下载成稿]  本地 HTML 预览，不发送文件…    │ │
│ │ 识别摘要 / 非页面排版   结构预览                                    │ │
│ │ ┌ 原稿文本 ──────────┐ ┌ 格式化结构 ───── PKUNMUN 2026 ┐           │ │
│ │ │ …                  │ │ 决议草案                      │           │ │
│ │ │                    │ │ 委员会：…  起草国：… P/O 条款 │           │ │
│ │ └────────────────────┘ └───────────────────────────────┘           │ │
│ │ ┌ generationPanel ──────────────────────────────────────────────┐ │ │
│ │ │ 提交会期[__] 提交国家[__] 版本号[v1]                           │ │ │
│ │ │ ☑ 按规则规范条款末尾标点  ☐ 高级：保持国家原顺序 [生成并下载 DOCX ↓]│ │
│ │ └────────────────────────────────────────────────────────────────┘ │ │
│ │ ─────────────────（生成后出现）────────────────────────────────── │ │
│ │ 04 成品已下载                                                      │ │
│ │ [✓ DOCX 包结构] [△ 结构与人工修改记录] [✓ 逐段严格内容校验] …       │ │
│ ╰────────────────────────────────────────────────────────────────────╯ │
│ PKUNMUN 2026  文件自动排版系统 · v1.8.5   依据 PKUNMUN 2026 学标示例排版… │  ← footer
└──────────────────────────────────────────────────────────────────────┘
```

### 3.3 各区域的元素与文案（逐字）

**页首 `siteHeader`**

- 左侧品牌是一个链接，指向 `#top`，`aria-label="回到首页"`。
  - 印章：46×46、圆角 15、渐变 `#5ebadd → #1373af`，白色字母“P”。
  - 文字两行：“PKUNMUN **2026**”（2026 为常规字重，颜色 `#427391`），下面是小号字距 .14em 的“DOCUMENT STUDIO”。
- 右侧状态胶囊：绿点 + 文案。
  - 浏览器模式：“浏览器本地处理 · 内容不上传云端”；
  - 配置了 API：“服务端处理 · 文件将发送至配置的排版服务”。

**主视觉 `hero`（id=top）**

- 眉题：“ACADEMIC DOCUMENTS / 学术文件”。
- 标题 `h1`：“让表达，<em>井然有序。</em>”。
  - 字号 `clamp(32px, 3.8vw, 50px)`；`em` 不倾斜，颜色 `#0d80b8`。
- 副题：“把内容交给你，把格式交给系统。选择文件类型，上传原稿，开启排版。”
- 右侧三枚胶囊：“保留原文内容”“可编辑 DOCX”“生成前后校验”。

**进度条 `stepper`**

- 4 等分格：“01 选择类型”“02 上传原稿”“03 确认识别”“04 生成下载”。
- 点亮规则：
  - `stage==="upload"`：已选文件时点亮前 2 格，否则只亮第 1 格；
  - `stage==="review"`：点亮前 3 格；
  - `stage==="done"`：全部点亮。

**01 选择文件类型（`typePanel`）**

- 标题“选择文件类型”，副题“为你的文件匹配排版规则”。
- 六张卡片排成 2 列。每张卡片是一个 `<button aria-pressed>`，内容：
  - 徽标（PP/WP/…）；
  - 中文名（粗体）和英文名（小字）；
  - 右上角圆形单选标记。
- 选中卡片：浅蓝渐变底、`#62b5d8` 描边、徽标变为蓝底白字、单选标记变实心。
- 点击任意卡片都调用 `resetForType(type)`，清空文件和识别结果（第 3.4 节）。

**02 上传原稿（`uploadPanel`）**

- 标题“上传你的原稿”，副题“格式交给系统，内容仍由你掌握”。
- 拖放区 `dropzone`：
  - 虚线边框 `#92c4dc`，最小高度 294px，可点击、可用 Enter/空格键打开文件选择框。
  - 隐藏的 `<input type=file accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document">`。
  - 未选文件时：文件图标；“将文件拖到这里”；“或 **浏览本地文件**”；“DOCX 格式 · 最大 20 MB”。
  - 已选文件时：显示文件名；“xx.x KB · 点击可重新选择”；“文件已就绪”。边框变实线青色。
  - 拖入时边框变 `#1788bc`。
  - `aria-label` 为“选择或拖入 DOCX 文件”，或“重新选择文件，当前为 {文件名}”。
- 错误框 `errorBox`（`role=alert`），常见文案：
  - 扩展名不是 `.docx`：“请上传 .docx 文件。旧版 .doc、PDF 和纯文本将在后续版本支持。”
  - 超过 20 MiB：“文件超过 20 MB，请精简图片后重试。”
  - 解析或排版抛出的错误原文（第 8.21 节）。
- 操作行：
  - 左侧“当前类型”和文种中文名；
  - 右侧主按钮“识别文件结构 →”。没有文件或正在处理时禁用；处理中文案为“正在识别…”。

**模板新建（`TemplatePanel`，`<details>`）**

- 折叠标题“从规范模板新建文件”。
- 说明：“独立于原稿修复。使用上方所选文种和现有学标规则，不生成或改写正文。每段一行，条款编号请按需要填写。”
- 字段：
  - 语言（中文 / English）；
  - 委员会；
  - 议题（指令草案没有）；
  - 立场文件：国家 / 席位、代表；
  - 其他文种：起草国（逗号分隔）；
  - 工作文件以外：附议国（逗号分隔）；
  - 正文 `textarea`（8 行，占位“填写正文，不会调用 AI 或上传云端”）。
- 按钮“生成规范 DOCX”，处理中显示“正在生成…”。
- 切换文种时组件以 `key={documentType}` 重建，已填内容清空。

**03 确认识别结果（`reviewSection`，仅在已有识别结果时出现）**

- 标题“确认识别结果”，副题“无法可靠判断的字段只提示，由你确认后再生成。”
- 国家提示框 `countryReview`：只在有名称会被展开、有重复会被合并、或有待确认名称时出现。
  - 首行：“国家字段将在生成时自动使用正式全称，无需逐项填写（UNTERM 核对：{日期}）。正文不会替换；复杂字段保留原样。”
  - 然后逐条列出：
    - `原名 → 正式全称`；
    - “起草国/附议国将按国家标识合并 N 个重复项”；
    - 待确认名称的警告（棕色字）。
- 表单（3 列）：
  - 语言 select（中文/English）、委员会、议题；
  - 立场文件另有“国家 / 席位”“代表”；
  - 非立场文件有“起草国（逗号分隔）”（跨 2 列）；
  - 立场文件和工作文件以外，还有“附议国（逗号分隔）”。
- 国家输入框显示用户原样输入的草稿（`countryDrafts`），以免每次按键都重新切分，吞掉刚输入的末尾逗号。
  - 模型里存切分后的数组；
  - 识别完成时，草稿初始化为以“，”连接的识别结果。
- 警告列表“需要确认”：逐条“△ {警告}”。
- 折叠区“识别依据与诊断报告”：
  - 摘要：“已识别 N 个非空段落、M 个正文或条款。结构校验：已检查/尚未执行；视觉核验：尚未执行。规则置信值不是格式正确率。”
  - “待确认字段：…”。
  - 表格三列：原稿段落 | 角色 / 层级 | 识别依据（附正文前 100 字）。
  - 按钮“下载诊断报告”，下载 `Munword_诊断报告.json`；旁注“报告包含原稿文字，只保存到你的电脑。”
- 页面预览工具：
  - 按钮“查看实际 DOCX 页面” / “收起页面预览”；
  - 已生成时还有“再次下载成稿”；
  - 说明“本地 HTML 预览，不发送文件。字体和分页以 Word / WPS 为准；成稿显示上一次生成的版本。”
  - 展开后两列 iframe：“原稿页面”和“生成后的 DOCX 页面”。未生成时右侧显示“生成文件后，此处显示成稿页面。修改字段后请重新生成。”
- 结构预览：
  - 小标题“识别摘要 / 非页面排版”“结构预览”，右侧注“实际字号、编号和签名空间请查看上方 DOCX 页面”。
  - 左纸“原稿文本 · N 段”：逐段显示非空原文。
  - 右纸“格式化结构 · PKUNMUN 2026”，依次显示：
    - 标题；
    - “委员会：”“议题：”“国家/席位：”；
    - 起草国、附议国：以“；”或“; ”连接，粗斜体；
    - 条款：每条前面一个标记（P=序言，O=行动，·=其他），右侧显示置信度百分比；每深一级缩进 15px。
- 生成面板 `generationPanel`：
  - “提交会期”（占位“例如：第三会期 / S3”）；
  - “提交国家”（占位“用于文件名”，识别后默认填 `country || sponsors[0]`）；
  - “版本号”（默认 `v1`）；
  - 复选框“按规则规范条款末尾标点”（默认勾选）、“高级：保持国家原顺序”（默认不勾）；
  - 主按钮“生成并下载 DOCX ↓”，处理中显示“正在生成…”。

**04 校验结果（`validationSection`，有校验结果时出现）**

- 标题：已下载时为“成品已下载”，否则为“格式校验结果”。副题“语义不确定项只给出提示，不自动改写。”
- 卡片排成 2 列，每张：
  - 状态图标：✓ 绿底、△ 黄底、× 红底；
  - 粗体标签和小字详情。

**页脚**

- 左侧“**PKUNMUN 2026** 文件自动排版系统 · v{package.json 的 version}”。
- 右侧“依据 PKUNMUN 2026 学标示例排版；保留正文、图片、引用与可编辑编号。”

**`<head>`**

- `layout.tsx`：标题“PKUNMUN 2026 文件自动排版系统”，`lang="zh-CN"`，带 og 图。
- 本机/静态外壳 `local_web/index.html` 与之相同：
  - 加载 `/styles.css` 和 `/app.js`（defer）；
  - `#root` 里先显示“正在加载 Munword 共用界面…”；
  - `<noscript>` 提示启用 JavaScript。

### 3.4 状态与交互规则

**组件状态（`app/page.tsx` 的 `Home`）**

| 状态 | 初值 | 说明 |
|---|---|---|
| `documentType` | `"draft-resolution"` | 当前文种 |
| `file` | `null` | 当前 `File` |
| `model` | `null` | 识别结果 `BrowserModel` |
| `validations` | `[]` | 校验结果 |
| `stage` | `"upload"` | `upload` / `review` / `done` |
| `busy` | `false` | 正在识别或生成 |
| `dragging` | `false` | 拖放高亮 |
| `error` | `""` | 错误框文字 |
| `preserveOrder` | `false` | 保持国家原顺序 |
| `normalizePunctuation` | `true` | 规范句末标点 |
| `sessionLabel` / `submittingCountry` / `version` | `""` / `""` / `"v1"` | 文件名组成部分 |
| `formatted` | `null` | 上次生成的 `{blob, filename}`，用于“再次下载”和预览 |
| `showPages` | `false` | 是否显示页面预览 |
| `countryDrafts` | `{sponsors:"", signatories:""}` | 国家输入框原文 |
| `operationRef` | `0`（`useRef`） | 操作代号，用于丢弃过期结果 |

**过期结果保护（`operationRef`）**

- 每次开始识别或生成时 `operation = ++operationRef.current`。
- 每个 `await` 之后检查 `operation !== operationRef.current`；不相等说明用户已切换文种、换了文件或改了字段，直接丢弃结果，不更新任何状态。
- `finally` 里只有仍是当前操作时才 `setBusy(false)`。

**`resetForType(type)`**（点击文种卡片时调用，也被 `acceptFile` 调用）

1. 操作代号 +1，`busy=false`；
2. 清空 `<input type=file>` 的值；
3. 设置文种；
4. 清空 `file`、`model`、`validations`、`error`、`formatted`；
5. `stage="upload"`，`showPages=false`。

**`acceptFile(file)`**

1. 先调用 `resetForType(当前文种)`；
2. 扩展名必须是 `.docx`（不分大小写），否则报错；
3. 大小不能超过 `MAX_UPLOAD`（20971520），否则报错；
4. 通过后设置 `file`。

**识别 `parseDocument()`**

1. 新操作代号；`busy=true`；清空错误、模型、结果、校验；`stage="upload"`。
2. API 模式：`POST {API_URL}/api/parse/{type}`，表单字段 `file`，超时 120 s（`AbortSignal.timeout`）。
3. 浏览器模式：`parseDocxInBrowser(await file.arrayBuffer(), type)`。
4. 成功后：
   - 设置模型；
   - 国家草稿 = 识别结果以“，”连接；
   - `submittingCountry = country || sponsors[0] || ""`；
   - `stage="review"`。
5. 失败时：显示错误；默认文案“文件识别失败，请检查 DOCX 后重试。”

**`discardPending()`**

- 第 03 步任何字段或生成选项一改动就调用：
  - 正在处理时作废那次操作（代号 +1，`busy=false`）；
  - 清空 `formatted` 和 `validations`；
  - 有模型时 `stage="review"`。
- 作用：保证**用旧值生成的文件永远不会被交付**。

**生成 `formatAndDownload()`**

- 浏览器模式：
  1. `formatDocxInBrowser(content, model, {sessionLabel, submittingCountry, version, normalizePunctuation, preserveCountryOrder})`；
  2. 设置校验结果和 `formatted`；
  3. 触发下载；
  4. `stage="done"`。
- API 模式：
  1. `POST {API_URL}/api/format/{type}`，表单字段：
     - `file`；
     - `overrides_json`：JSON，含 `language/title/committee/topic/delegate/country/sponsors/signatories`；
     - `preserve_country_order`、`normalize_punctuation`：字符串 `"true"/"false"`；
     - `session_label`、`submitting_country`、`version`。
  2. 非 2xx：尝试从 `detail.validations` 读出校验结果并显示，再抛出 `detail.message` / `detail` 文字。
  3. 成功：
     - 文件名取自 `Content-Disposition` 的 `filename*=UTF-8''…`，缺省为 `PKUNMUN2026_格式化文件.docx`；
     - 校验结果取自响应头 `X-PKUNMUN-Validation`（base64url 编码的 JSON 数组）。

**下载实现**

1. `URL.createObjectURL(blob)`；
2. 临时 `<a download>`，`click()` 后移除；
3. 60 秒后 `revokeObjectURL`。

**第 03 步永不被自动填写**

- 生成时用的就是用户看到的 `model`。
- 程序只在识别时给出初值；测试也只检查第 03 步“可编辑”，从不代填。

## 4. 数据模型

### 4.1 `BrowserModel`（`app/docx-browser.ts`）

```ts
type BrowserModel = {
  document_type: BrowserDocumentType;
  language: "zh" | "en";
  title: string;            // 识别到的标题段原文；没有时为该文种标题词
  committee: string; topic: string; delegate: string; country: string;
  sponsors: string[];       // 起草国（已切分）
  signatories: string[];    // 附议国
  preambulatory_clauses: BrowserClause[];  // 仅决议草案
  operative_clauses: BrowserClause[];      // 决议草案的行动性条款；指令草案的全部条款
  body_clauses: BrowserClause[];           // 其余文种的正文
  max_numbering_level: number;
  warnings: string[];       // 识别阶段的提示
  paragraphs: string[];     // 每个流式段落的可见文字（含空串）
};
type BrowserClause = { text: string; level: number; kind: string; paragraph_index: number; confidence: number };
type BrowserValidation = { code: string; label: string; status: "pass" | "warning" | "error"; detail?: string };
```

Python 的 `IntermediateDocument`（`backend/app/models.py`）字段同名，另外多出：

- `header_paragraph_indices`：页首单值字段所在段号；
- `metadata_paragraph_indices`：国家名单所在段号；
- `repair_actions`：结构修复记录。

### 4.2 第 03 步提交的校验（`app/request-validation.ts:validateReview`）

- `language` 只能是 `zh` 或 `en`。
- 标量字段（title/committee/topic/delegate/country）必须是字符串，不超过 5000 字符。
- `sponsors` / `signatories` 必须是字符串数组，最多 300 项，每项不超过 200 字符。
- 所有文字必须能写进 XML（`validXmlText`）：不得含 `\x00-\x08\x0b\x0c\x0e-\x1f`、孤立代理项、`￾`、`￿`。
- 不合格时抛出 `InvalidRequestError`，界面直接显示：
  - “第 03 步字段 {key} 过长、类型无效或含有 XML 不支持的字符。”
  - “第 03 步语言只能为 zh 或 en。”

### 4.3 编辑日志 `Edit`

排版时，每个被改写的段落元素都映射到一条记录：

```ts
type Edit = {
  kind: string;            // 见第 12.3 节白名单
  key?: string;            // 字段名（committee/sponsors…）
  expected?: string|null;  // 授权的确切结果（field / label-restore / countries）
  created?: boolean;       // 是程序新建的段落（空行、签名续行）
  country?: { language, preserveOrder, manual };  // 国家改写的证明参数
};
```

### 4.4 诊断报告 JSON（`app/diagnostics.ts`，与 Python `diagnostics.py` 同构）

```json
{
  "schema_version": 1,
  "document_type": "draft-resolution",
  "language": "zh",
  "paragraph_count": 23,
  "missing_fields": [{"field": "signatories", "label": "附议国"}],
  "warnings": ["…"],
  "clauses": [{"paragraph": 7, "role": "operative", "level": 0, "confidence": 0.99, "text": "…", "reason": "位于行动性条款区域；…"}],
  "validations": [{"code": "content", "label": "…", "status": "pass", "detail": "…"}],
  "structure_status": "checked | failed | not_run",
  "visual_status": "not_run",
  "limitations": ["规则置信值不是统计概率，也不是格式正确率。", "…"]
}
```

Python 版报告另有 `repair_actions`（结构修复记录）；CLI 生成的报告还有 `source_name`。

- `missing_fields` 按 `workflow-policy.json` 的 `requiredFields[文种]` 计算。
- `reason` 取自 `roleReasons[kind]`。
- `structure_status`：有校验结果时，若含 error 则为 `failed`，否则为 `checked`；没有校验结果时为 `not_run`。
- 报告只读，从不修改模型。

## 5. DOCX 包的安全读取（`app/docx-safety.ts`）

DOCX 是 ZIP 包。程序在解压前后做两层检查，防御畸形包、压缩炸弹和 XML 实体攻击。上限取自 `shared/package-policy.json`：

```json
{ "maxUploadBytes": 20971520, "maxExpandedBytes": 104857600, "maxXmlBytes": 16777216,
  "maxParts": 5000, "maxCompressionRatio": 250, "compressionMethods": [0, 8],
  "maxXmlDepth": 256, "maxMultipartBytes": 22020096 }
```

### 5.1 `readPackage(content)` 的步骤

第 1 步失败时直接抛出“DOCX 文件为空、损坏或超过 20 MB。”；之后任何一步失败都抛出“DOCX 压缩包校验失败：{原因}”。界面上再包一层“文件无法读取：…”。

1. **大小**：字节数在 22 到 20 MiB 之间。
2. **`entryChecksums` 手工解析 ZIP 目录**（不依赖解压库）：
   - 从文件尾向前最多 65557 字节寻找 EOCD 签名 `0x06054b50`。注释长度必须正好延伸到文件末尾。
   - 拒绝分卷（磁盘号不为 0）、拒绝 ZIP64（两个条目数不一致），条目数不得超过 5000。
   - 中央目录必须正好在 EOCD 之前结束。
   - 逐个中央目录项（签名 `0x02014b50`）检查：
     - 加密标志位（bit 0）→ 拒绝；
     - 本地头签名 `0x04034b50` 存在；
     - 本地头与中央目录的标志位、压缩方法一致；
     - 路径长度一致、路径字节一致；
     - 数据区不越过中央目录；
     - 没有使用流式写入（bit 3）时，CRC、压缩大小、原始大小也必须一致。
   - 各条目数据区按起点排序后不得重叠。
   - 返回各条目的 CRC 列表。
3. **预扫描**（`fflate.unzipSync` 的 `filter` 回调，回调返回 false，不真正解压）：
   - 路径不得重复，不得是 `__proto__`，不得含控制字符或反斜杠，不得以 `/` 开头，不得含 `..` 段；
   - 解压后总量不超过 100 MiB；
   - 单项压缩比不超过 250；
   - 压缩方法只能是 0（STORE）或 8（DEFLATE）；
   - 文件名以 `.xml` / `.rels` 结尾（不分大小写）的部件不超过 16 MiB。
4. **必要部件**：`[Content_Types].xml` 与 `word/document.xml`，缺一不可。
5. **真正解压**后逐项复核长度和 CRC32（自带查表实现）。
6. **每个 XML / rels 部件**：
   - `declaresDtd`：解码后去掉 NUL 字符，用 `/<!\s*(?:DOCTYPE|ENTITY)/i` 检查，拒绝 DTD 和实体声明。
   - `nestsTooDeep`：不建树，线性扫描标签深度，超过 256 层拒绝。扫描时：
     - 跳过 `<?…?>`、注释和 CDATA；
     - 正确处理属性值里的 `>`；
     - 自闭合标签不计深度。

### 5.2 `decodeXml(bytes)`

- 支持 OPC 允许的 UTF-8 和 UTF-16（大端/小端，可带或不带 BOM）。
  - 用开头字节判断：`FE FF` / `00 3C` 为大端，`FF FE` / `3C 00` 为小端。
- UTF-32 BOM 直接拒绝。
- 用 `TextDecoder(..., {fatal:true})` 解码，遇到非法字节抛出“XML 部件包含无效编码，不能安全保留原文”。
- 输出一律写成 UTF-8。

### 5.3 文本与切分工具

- **`visibleText(element)`**：读者看到的文字。
  - `w:t` 取文本，`w:tab` 记为 `\t`，`w:br`/`w:cr` 记为 `\n`。
  - 跳过属性元素（pPr/rPr/tblPr/trPr/tcPr/sectPr），跳过嵌在段落里的段落（文本框）。
  - 删除修订里是 `w:delText`，不是 `w:t`，所以自然不计入。
- **`canCut(p)`**：段落里没有 `fldChar`、`instrText`、`fldSimple`、`sdt` 才能切分。
- **`splitAt(parent, offset)`**：在可见文字偏移处制造子节点边界。
  - 普通 run 拆成两个 run，第二个复制原 run 的 rPr。
  - `smartTag` / `customXml` 可以复制外壳后切开。
  - 其他包装（超链接、修订）抛出 `Unsplittable`。
- **`breakLineBefore(p, keep, resumeAt)`**：
  - 在 `keep` 和 `resumeAt` 两处切开；
  - 删掉中间无标记的纯空白 run（隐藏或删除线的空白属于作者，保留）；
  - 插入一个带前一 run 格式的 `<w:r><w:br/></w:r>`。
- **`moveToNewParagraph(p, keep, resumeAt)`**：把 `resumeAt` 之后的内容移到紧随其后的新段落。
  - 新段复制原段的 pPr，但去掉 `numPr` 和 `ind`：拆出来的是更深一级的子条款，不继承原段的列表归属和缩进。
  - 若原段 pPr 里有分节符 `sectPr`，从原段移除；它随段末内容一起归新段，避免多出一节。
- **`contentSignature(doc)`**：
  - 去掉所有属性元素、拆掉 run 外壳、把 `w:t` 换成纯文本并合并相邻文本后，序列化成字符串。
  - 用于证明“只改了格式”，例如脚注部件排版前后必须相同。

## 6. 解析与样式继承显式化（`docx-browser.ts:parsePackage`）

Word 允许列表编号和粗斜体写在**段落样式**里，而不在段落本身。后续步骤会重置样式，如果不先把这些继承属性“抄到”段落和 run 上，编号和强调就会丢失。

1. `readPackage`，然后用 `DOMParser` 解析 `word/document.xml`，命名空间用 `application/xml`。
   - 解析出错或根元素不是 `w:document`（WordprocessingML 命名空间），或没有 `w:body` 时，抛出 `InvalidDocxError`：“DOCX 主文档 XML 无法解析。”/“DOCX 主文档缺少有效正文结构。”
2. 有 `word/styles.xml` 时，建样式索引；`styleChain(id)` 沿 `basedOn` 返回由近到远的样式链，并防止循环。
   - 默认段落样式 = `w:type="paragraph"` 且 `w:default` 为真的样式。中文 Word 里它的 id 是 `a`，不是 `Normal`。
3. **列表编号**：对每个段落（含表格和文本框中的段落）：
   - 收集样式链上所有 `pPr/numPr`。
   - 段落自己的 `numPr` 与继承的逐个子元素合并：自己的优先，缺的子元素从样式补。直接写的 `ilvl` 不会取消样式里的 `numId`。
   - ECMA-376 §17.9.23：若某编号级别的 `w:pStyle` 指向该段落的样式链（`linkedLevel`），且段落没有直接写 `ilvl`，就用那个级别号。
   - 子元素按 `ilvl, numId, numberingChange, ins` 排序，写回段落。
4. **字符强调**：对段落**自己的** run（文本框的 run 属于文本框里的段落）：
   - 逐个检查 `b, i, u, vertAlign, vanish, webHidden, specVanish, strike, dstrike`；run 上已有的不动。
   - 查找顺序：字符样式链 → 段落样式链（`vertAlign` 不从段落样式取）。
   - **默认段落样式不抄**：一个被损坏成整篇粗体的 Normal 样式否则会把全文变粗体。
   - 例外：隐藏和删除线这类语义标记，连默认段落样式和 `docDefaults/rPrDefault` 都要抄。
   - 找到后，把属性节点的所有属性复制到 run 的 rPr（按 schema 顺序插入）。
5. 返回 `{ parts, document }`。`parts` 是部件名到字节的映射，后续直接修改。

## 7. 识别算法（`docx-browser.ts:recognize`）

`recognize` 只读文档，返回 `BrowserModel`。排版时会在结构修复后再调用一次。

### 7.1 流式段落

`flowParagraphs(document)`：从 `w:body` 开始递归，只进入 `sdt`、`sdtContent`、`customXml` 三种容器，收集其中的 `w:p`。表格和文本框中的段落不算条款或页首行。

### 7.2 语言判定 `detectLanguage`

- 把非空段落用换行连起来，统计汉字（`[㐀-鿿]`）数 `cjk` 和拉丁字母数 `latin`。
- `cjk ≥ max(2, floor(latin / 4))` 时为中文，否则为英文。
- 因此英文文件里引用少量汉字（如“一带一路”）仍按英文排版。

### 7.3 标题 `isTitle(text, expected)`

正则：`^{expected}(?:\s*(?:[\d.．]+|\[(?:编号|number)\]))?(?:\s*(?:终|最终稿|Final))?$`，不分大小写。

- 例：“决议草案 1.2 终”“DRAFT RESOLUTION [number]”都算标题。
- `matchesTypeTitle` 同时接受两套标题词：
  - `titles[文种][语言]`（如“Working Paper”）；
  - `outputTitles[文种][语言]`（如“WORKING PAPER”）。
- 识别时只在**前 8 个非空段落**里找标题。

### 7.4 页首边界 `startsBody` / `headerEnd`

页首字段只在标题之后、第一段正文之前识别。正文里以“议题：”开头的句子是作者的正文，不能当字段读，更不能删掉标签。

`startsBody(text, numbered)` 为真的条件：

- 文字非空，且不是带标签的字段；并且满足下列之一：
  - 段落有原生编号（`numbered` 且策略 `nativeNumbering=true`）；
  - 匹配正文标记 `bodyMarker`，例如第X条、一、（一）、1.、1.2.、a)、iv.、(a)、PART I；
  - 以句末标点结尾：`[。！？!?][\s ]*$`；
  - 以英文句点结尾且至少 6 个词。
- 动词开头**不算**正文标志（议题本身可能以“促进”开头）；分号也不算（国家名单续行可能以分号结尾）。

`headerEnd(texts, titleIndex)` 从标题后一段起，返回第一个 `startsBody` 的段号；找不到时为段落总数。`headerLimit` 先按 7.3 找标题，再求 `headerEnd`。

### 7.5 带标签字段

`LABELS[key]` 由 `metadata[key].aliases` 生成：

- 别名按长度降序拼成 `^(?:别名1|别名2…)\s*[:：]\s*([\s\S]*)$`，不分大小写。
- **纯汉字别名的字与字之间允许空白**：“委 员 会：”也能识别。

| key | 别名 | 输出标签（中/英） |
|---|---|---|
| committee | 委员会、Committee | 委员会 / Committee |
| topic | 议题、会议议题、Topic、Agenda | 议题 / Topic |
| country | 国家/席位、代表国家、代表国、国家、席位、Country、Represented country、Delegation country | 国家 / Country |
| delegate | 代表、Delegate | 代表 / Delegate |
| sponsors（多行） | 起草国、提案国、主笔国、Sponsor、Sponsors | 起草国 / Sponsors |
| signatories（多行） | 附议国、联署国、Signatory、Signatories | 附议国 / Signatories |

- `labeledField(text)` 按上表顺序返回第一个匹配的 `{key, value, labelLength}`。
- 只有页首范围（段号 < headerLimit）内的段落才读取标量字段；同一字段取第一个非空值。

### 7.6 多行国家名单

`collectListField(paragraphs, key, limit)`：

1. 在页首范围内找到带 `sponsors` / `signatories` 标签的段落，取其值。
2. 向后逐段（跳过空段）累加续行，直到 `endsCountryList(text)` 为真。
3. 把所有片段用“、”连接后，交给 `splitCountryNames` 切分（第 11 章）。

`endsCountryList(text)` 为真，即名单结束的情况：

- 是带标签的字段；
- 以条款标记开头（`ZH_MARKER` / `SUB_MARKER`）或是 `PART` 行；
- 是主体句（第 7.8 节 `isCommitteeSubject`）；
- 以任何序言或行动动词开头；
- 或者**看起来不像国家名单续行**。

`looksLikeCountryContinuation(text)` 的判断：

- 含 `：:。！？!?；;` 或数字、或以英文句点结尾 → 否。
- 去掉末尾分隔符后切分成名称。每个名称都必须满足：
  - 含汉字：长度 ≤ 24，且以“国 / 联邦 / 联盟 / 教廷”结尾；
  - 英文：长度 ≤ 80，且去掉开头的 The 后是 `region-names-en.json` 中的地区名，或匹配 `(?:The\s+)?.*\b(?:Republic|Kingdom|Federation|States?|Emirates)\b.*`。
- 这样，一行“The Executive Council,”就能正确结束名单，而不会把整段正文吞进附议国。

### 7.7 无标签页首推断

学标示例里委员会、议题常常不带标签。各文种的 `unlabeledHeaderFields`：

- 立场文件：`[committee, topic, country, delegate]`；
- 其余文种：`[committee, topic]`。

规则：

1. 必须先找到标题。
2. 候选行：标题之后、页首边界之前、第一个带标签字段之前的连续非空段，最多取 `fields.length` 个。
3. 候选行**全部**满足下列条件才采纳：
   - 不是条款标记开头（`delegate` 字段除外）；
   - 长度 ≤ 80；
   - 不含 `。！？!?；;`；
   - 不以逗号结尾；
   - 不以序言动词开头。
4. 采纳的条件，满足其一即可：
   - 候选数正好等于字段数；
   - 指令草案只有 1 个候选；
   - 只有 1 个候选、后面有带标签字段，且候选里含“委员会 / 理事会 / 大会 / 议会”或 committee / council / assembly / commission。
5. 采纳时按顺序赋给字段（不覆盖已从标签读到的值），并去掉行首残留的冒号。

### 7.8 条款与层级

**条款集合**：非空段落中，排除以下几类，剩下的都是条款：

- 页首带标签字段；
- 与标题文字相同的段；
- 7.7 节推断出的页首行。

**条款层级 `level`**：

- 有原生编号时取 `numPr/ilvl`；
- 否则按 `markerLevel(text)`：

| 开头 | 层级 |
|---|---|
| 第X条、一、/一.、1. / 1、 / 1．/ 1) | 0 |
| （子子）（2–3 个地支） | 3 |
| （子）（1 个地支） | 2 |
| （甲）…（天干） | 3 |
| 罗马数字项（`isRomanItem`，见下） | 2 |
| （一）（a）（1）等 | 1 |
| ii. / iv) 等两位以上罗马数字 | 3 |
| a. / a) | 1 |
| 甲、/甲. | 2 |
| 其他 | 0 |

- **置信度**：匹配 `ZH_MARKER` 为 0.99，否则为 0.88。界面明确说明这不是正确率。
- **`isRomanItem(text, previousToken)`** 区分“(c) 是字母还是罗马数字”：
  - 括号里是罗马字符组成的 token。多字母（如 iv）一定是罗马数字。
  - `i` 只有紧跟在 `h` 后才是字母。
  - 其他单字母只有恰好是前一个罗马数字的后继（iv → v）才算罗马数字。

**主体句**：`isCommitteeSubject(text, committee)` 为真的情况：

- 去掉尾部逗号后，与委员会字段指同一机构（`organName`：去掉开头的 The 或“联合国”，转小写后比较）；
- 是“联合国大会”“the committee”“the general assembly”之一；
- 匹配 `^The [A-Z][A-Z\s]*,$`（如“The OPCW,”）；
- 或匹配 `subjectLine.patterns`：
  - 英文：`The …机构名…,`，名称里允许 of/on/for/and/the/in/to/de/(缩写)，最多 10 个词；
  - 中文：最多 28 个汉字后接“大会 / 理事会 / 委员会 / 议会 / 组织 / 会议 / 法院”，再接逗号。
- 以序言或行动动词开头的行一律不是主体句。

### 7.9 决议草案的序言 / 行动分界；指令草案

**决议草案**：

1. 分界 = 第一个满足条件的条款：层级 0，且以条款标记开头或带原生编号。
2. **缺第一条时的推断**：某条款在分界之前，没有标记，以行动动词开头，且下一条是层级 1 的带标记子条款，则分界提前到它。这对应“第一条”漏写、而第二条起有“第二条”的情况。
3. 分界之前是 `preambulatory`，之后是 `operative`，`body_clauses` 为空。
4. 找不到分界时，全部留在 `body_clauses`。

**指令草案**：全部条款标为 `operative`。

**其余文种**：全部是 `body`。

### 7.10 识别警告

- 未识别委员会：“未可靠识别委员会；可在第 03 步人工确认。”
- 未识别议题（指令草案除外）：“未可靠识别议题；可在第 03 步人工确认。”
- 立场文件以外缺起草国：“未可靠识别起草国；可在第 03 步人工确认。”
- 立场文件、工作文件以外缺附议国：“未可靠识别附议国；可在第 03 步人工确认。”
- 立场文件出现“（二）”但前面没有“（一）”：“检测到第二部分但缺少“（一）”；仅在能够定位第一节标题时尝试补齐，请复核结果。”

`max_numbering_level` = 条款层级的最大值。`title` = 识别到的标题原文，否则为该文种标题词。

## 8. 排版流水线（`docx-browser.ts:formatDocxInBrowser` → `formatInner`）

### 8.0 总览

`formatDocxInBrowser(content, model, options)`：

1. 先用 `validateReview(model)` 检查第 03 步的输入。
2. 调用 `formatInner`。
3. 把异常映射成用户可读的消息（第 8.21 节）。

`formatInner` 的顺序固定，后一步依赖前一步：

| # | 步骤 | 函数 | 可能产生的编辑类型 |
|---|---|---|---|
| 1 | 重新解包、识别原稿 | `parsePackage`、`recognize` → `original` | — |
| 2 | 结构修复（单独校验） | `repairMissingFirstSection`、`normalizeEmbeddedSubclauses`、`suspectedMissingListItems`、`verifyRepair` | （修复不进编辑日志，由 `verifyRepair` 单独证明） |
| 3 | 再识别；计算第 03 步改了哪些字段 | `recognize` → `recognized`；`changed` | — |
| 4 | 建上下文、内容快照；清除整篇损伤；记录隐藏/删除线 | `takeSnapshot`、`stripUniformDamage`、`semanticMarks` | — |
| 5 | 页面设置 | `configurePage` | — |
| 6 | 样式表 | `configureStyles` | — |
| 7 | 所有 run 的字体、字号、去噪 | `formatRun` | — |
| 8 | 页首字段 | `formatMetadata` | field、country-name、countries、label-restore |
| 9 | 立场文件编号与参考文献 | `positionPaperMarkers` | marker |
| 10 | 角色划分 | `handbookBlocks` | — |
| 11 | 编号体系规划（先不写入） | `documentNumbering` | （第 15 步写入 dr-marker / list-marker） |
| 12 | 标题词、删委员会/议题标签 | `headerText` | title、label-drop、field |
| 13 | 句末标点 | `punctuation` | ending |
| 14 | 写入编号改动 | `listNumbering.apply()` | dr-marker、list-marker |
| 15 | 段落几何、强调 | `geometry`、`emphasis` | — |
| 16 | 国家名单断行 | `signatureLines` | countries（含新建段落） |
| 17 | 编号字体字号 | `numberingMarkers` | — |
| 18 | 编号连续性检查 | `continuity` | — |
| 19 | 空行 | `blankLines` | empty-line（删除）、blank（新建） |
| 20 | 脚注 / 尾注 | `handbookNotes` | — |
| 21 | 字体表、主题、语言设置 | `normalizeFontParts` | — |
| 22 | 校验、打包、输出 | `verifyFormat`、`verifyMarks`、`zipSync`、`verifyPackage`、`runSizeIssues` | — |

`Ctx`（上下文）字段：

- `document`、`parts`；
- `model`（第 03 步的值）、`recognized`（修复后的识别）、`original`（修复前的识别）；
- `type`、`language`、`spec`（第 9 章）、`eastAsia`（东亚字体）；
- `normalizePunctuation`、`preserveCountryOrder`；
- `changed`：第 03 步与 `original` 不同的字段集合，用 `JSON.stringify` 比较 title/committee/topic/country/delegate/sponsors/signatories；
- `editLog`：段落元素 → `Edit`；
- `source`：修复后的流式段落，用于把元素换算成原稿段号；
- `warnings`、`protectedNotes`、`countryChanges`；
- `headerEnd`：页首边界，第 7.4 节。

**东亚字体**：

- 英文文件：Times New Roman；
- 中文修正案：Arial Unicode MS；
- 其余中文文件：SimSun。

### 8.1 结构修复（第 2 步）

修复只处理**高置信度的结构损伤**，不看文件名、国家、议题。修复完立即用 `verifyRepair` 比对修复前后的全文记号（第 12.6 节）：只允许拆段和插入修复报告过的字符。

**(a) 立场文件补“（一）”（`repairMissingFirstSection`）**

- 开关：`documents["position-paper"].repairs` 含 `missing-first-section`。
- 条件：存在以“（二）”开头的段落，且它之前没有“（一）”。
- 页首结束位置：前 8 段中，最后一个“带标签字段”或“等于已识别页首值”的段落。
- 目标段：页首之后、“（二）”之前，**最后一个**满足下列全部条件的段落：
  - 非空，长度 ≤ 30；
  - 不以 `。；;！？!?：:` 结尾；
  - 不是字段，也不是任何文种的标题；
  - 后面第一个非空段长度 > 30（即它像一个小节标题）。
- 写法：用 `editVisibleText` 原位改为 `（一）{原文}`，并要求非文字结构不变（`rewriteKeepsStructure("repair")`）。否则恢复原状、放弃修复。
- 成功后，校验项 `structural_edits` 记“补齐（一）标记”。

**(b) 拆开内嵌子条款（`normalizeEmbeddedSubclauses`）**

- 适用：工作文件、指令草案、决议草案（`embeddedSubclause.documentTypes`）。
- 问题：子条款被粘进了同一段，例如“……如下：（一）……；（二）……”。
- `marker` 正则：`([：:；;])(\s*)([（(](?:[一二三四五六七八九十百]{1,3}|[子丑寅卯辰巳午未申酉戌亥]{1,4}|[甲乙丙丁戊己庚辛壬癸]{1,4})[）)])`，即冒号或分号后紧跟（一）/（子）/（甲）。
  - 不用后行断言，因为旧版 Safari 不支持。
- 对每个流式段落循环匹配：
  - 冒号与标记之间有制表符或换行 → 作者有意排版，跳过这一处，继续找后面的。
  - 段落不是条款 → 记“context”，停止处理该段。条款的判断：
    - 匹配 `clause` 正则：第X条、阿拉伯数字编号、括号标记，或以决定 / 呼吁 / 敦促 / 鼓励 / 建议 / 要求 / 支持 / 希望 / 推动 / 关于 / 申明 / 强调开头；
    - 或者有原生编号。
  - `canCut` 为假（含域或内容控件）→ 记“field”，停止。
  - 标记是一级（`（一）`…）、段落是“第X条”的原段、且还没拆出新段：用 `breakLineBefore` 在同段内换行。
  - 否则用 `moveToNewParagraph` 拆成新段，继续在新段里找。
  - 切点落在超链接或修订里（`Unsplittable`）→ 记“wrapper”，停止。
- 没拆的段落在校验结果里提示：
  - context → `structure_review`：“第 N 段疑似含有合并进同一段的子条款标记，但所在段落不是条款，未拆分，请人工确认。”
  - field / wrapper → `content-protected`：“第 N 段含域或内容控件 / 含链接或修订痕迹，其中嵌入的子条款未拆分为独立段落，请人工确认。”

**(c) 疑似缺项（`suspectedMissingListItems`，只提示）**

- 适用：决议草案、工作文件。
- 条件：某段同时满足以下全部，则提示 `numbering_review`：
  - 没有编号或标记；
  - 以 `；;。.` 结尾；
  - 前一非空段以冒号结尾；
  - 后一段有原生编号；
  - 往前找不到同一列表、层级不低于它的段落。
- 绝不自动加入列表：那会让后面所有条号和交叉引用错位。

### 8.2 再识别与 `changed`

- `recognized = recognize(修复后的文档)`，语言用 `model.language`（用户可能改过）。
- `changed` 只比较用户看到并能修改的字段。
- 后续凡是写第 03 步的值，都只在 `changed.has(key)` 时进行。

### 8.3 快照、整篇损伤与语义标记

1. **`takeSnapshot(document)`**：记录每个正文块（段落、表格，穿过内容控件）的：
   - 元素引用；
   - 内容签名；
   - 可见文字；
   - 原生列表归属 `[numId, ilvl]`；
   - 以及所有 `sdt` / `customXml` 外壳的属性。
2. **`stripUniformDamage`**：
   - 若**全部**有文字的可见 run 都带某个标记（`vanish`、`webHidden`、`specVanish`、`strike`、`dstrike`），这是复制粘贴造成的损伤：
     - 从所有 run 上删除这个标记；
     - 再从正文实际用到的样式（`stylesAppliedToBody`：docDefaults、正文引用的段落/字符/表格样式、各类默认样式及其 basedOn 链）里删除。只用于脚注、页眉的样式不动。
   - 只有**部分**文字带标记，是作者的意图（私人备注、修正案里的删除），保留，并逐段提示：“第 N 段含隐藏文字/删除线文字/隐藏文字和删除线文字，已保留原稿的显示、打印或删除标记，请确认是否需要。”（`hidden-text`）
3. **`semanticMarks(document)`**：在清除整篇损伤之后，记录每个块里“隐藏的文字”和“删除线的文字”。输出时这些字符必须按顺序仍然带着标记（第 12.5 节）。

### 8.4 页面（`configurePage`）

对每个 `w:sectPr`（没有就在 body 末尾建一个）：

- `pgSz`：删除 `orient`，`w=11906`、`h=16838`（A4 纵向）。
- `pgMar`：top=1440、bottom=1440、left=1800、right=1800、header=720、footer=720、gutter=0（上下 25.4 mm，左右 31.75 mm）。
- 删除 `cols`、`lnNumType`、`pgBorders`、`docGrid`，即单栏、无行号、无页面边框、无文档网格。

### 8.5 样式表（`configureStyles`）

- `docDefaults`：删除 `pPrDefault`；`rPrDefault` 的字体设为本文字体（见下）。
- 处理以下样式，其余不动：
  - Normal / 默认段落样式；
  - 名称为“footnote text”“endnote text”的样式；
  - Title、Subtitle、Heading1–3。
- 处理内容：删除颜色；设本文字体；字号脚注/尾注 9 pt，其余 12 pt。
- Normal 另外：
  - `b`、`bCs`、`i`、`iCs` 设为 0，`u` 设为 none；
  - 段落间距 before=0、after=0、line=240、lineRule=auto。

**本文字体（`houseFonts`）**：

- 删除所有主题字体属性：`asciiTheme`、`hAnsiTheme`、`eastAsiaTheme`、`cstheme`、`csTheme`；
- `ascii` / `hAnsi` / `cs` = Times New Roman，`eastAsia` = 东亚字体；
- `hint` = 中文 `eastAsia`，英文 `default`。

### 8.6 所有 run（`formatRun`）

对文档中**所有**段落（含表格、文本框）的可见 run（不在 `w:del`、`w:moveFrom`、`w:txbxContent` 之下）：

1. 删除视觉噪声 `RUN_NOISE`：
   outline、shadow、emboss、imprint、highlight、shd、bdr、effect、glow、reflection、spacing、kern、color、rStyle、caps、smallCaps、em、fitText、eastAsianLayout、w、position。
2. **不删除**隐藏和删除线：它们改变读者看到的内容或文字含义。
3. 设本文字体，`sz` = `szCs` = 24（12 pt）。

所有 rPr / pPr 子元素都按 ECMA-376 的 schema 顺序插入（`RPR_ORDER` / `PPR_ORDER`），否则严格的阅读器会拒绝文件。

### 8.7 页首字段（`formatMetadata`）

只处理页首范围（段号 < `headerEnd`）。若同一国家类字段（country / sponsors / signatories）在页首出现多次：

- 第 03 步改了它 → 抛出 `ProtectedContentError`（无法确定目标）；
- 否则加保护提示，跳过。

**(a) 无标签页首行的第 03 步修改**

- 适用字段：committee、topic、delegate（只在 `changed` 时）和 country（总是检查）。
- 条件：页首里没有该字段的带标签行，并且有一行**无标签**、文字等于 `original[key]` 的段落。
- 处理：
  - country 交给 `scalarCountry`；
  - 其余字段先查 `fieldProtectionReason`：有原因就抛 `ProtectedContentError`，否则 `setText` 改为新值，记 `field`。

**(b) 补标签（`restoreMissingLabels`，仅立场文件）**

- 标题之后、页首范围内的无标签行，按 `unlabeledHeaderFields` 顺序对应 committee、topic、country、delegate。
- 文字（去掉开头冒号后）等于识别值时，改写为“委员会：值”或“Committee: 值”，记 `label-restore`。
- country 用解析后的正式全称作为值。

**(c) 带标签行**

- sponsors / signatories：向后收集续行，直到 `endsCountryList`，然后交给 `formatCountryField`。
- country：交给 `scalarCountry(…, labeled=true)`。
- 其余字段：只在 `changed` 时，清空段落重写为“标签：值”（无强调），记 `field`。
  - 有 `fieldProtectionReason` 时抛出 `ProtectedContentError`。

**`fieldProtectionReason(p)`**：不能安全改写的原因，没有则为 null。

- 含隐藏或删除线文字；
- 含图片、链接、域、书签或修订结构（`hasComplexContent`：段落里有 run 以外的子元素，或 run 里有 rPr/t/tab/br/cr 以外的子元素，或带类型的分页、分栏 br）；
- 含分页符、分栏符或其他不能作为普通分隔符的记号（签名不满足 `isPlainField`，见下）。

`isPlainField`：签名里除文字外只允许成对的 `tab`、`cr`、`br`（无属性或 `type=textWrapping`）。

**`scalarCountry(ctx, p, labeled)`**：

1. `resolveCountry(model.country)`。
2. 目标文字：带标签行为“国家：正式全称”，无标签行为正式全称。
3. 以下情况都不需要改写，直接返回：没在第 03 步修改，名称也不需要展开，并且（无标签行，或解析状态不是 resolved，或文字已经等于目标）。
4. 有 `fieldProtectionReason` 时：
   - 第 03 步改过 → 抛错；
   - 否则提示“国家字段{原因}，未自动展开全称”。
5. 否则 `setText` 改写：
   - 第 03 步改过记 `field`，否则记 `country-name`；
   - 记录名称变化：“第 N 段 country：国家名称“法国” → “法兰西共和国”（UN-M49-250；UNTERM 核对 {日期}）。”
   - 带标签行另记一条“按共用字段策略统一国家标签与分隔符”。

**`formatCountryField(ctx, p, continuations, key)`**：

1. `source` = 第 03 步改过就用 `model[key]`，否则用 `recognized[key]`。
2. `values = planCountries(source, 语言, 保持原顺序)`：解析全称、按国家 id 去重、按拼音或字母排序（第 11 章）。
3. 期望文字 `expected` = “起草国：A、B、C”或“Sponsors: A, B, C”。
4. 需要重写的情况：第 03 步改过；或者名单非空、（规范标点开或顺序有变）、且（顺序有变 / 有续行 / 文字不等于期望）。
5. 重写方式：
   - 名单所有段落都没有 `fieldProtectionReason`：首段清空写入 `expected`，续行段清空（之后会被删除），全部记 `countries`（`expected` 相同）；然后设置样式，并记录名称变化。
   - 有复杂段落：第 03 步改过 → 抛错；否则提示“国家列表{原因}，未重写”。
6. 样式（`styleCountryLine`）：
   - 标签部分（`^\s*[^:：]{1,20}[:：]\s*`，含冒号后的空格）：粗体，斜体与否取 `countryLabelItalic`，无下划线；
   - 名称部分：粗斜体。
   - 续行段整段粗斜体。

### 8.8 立场文件的建议编号与参考文献（`positionPaperMarkers`）

- 范围：最后一个页首带标签字段之后的段落。
- **建议编号**：
  - 跳过“1.5”这类小数或复合编号；
  - 匹配 `^\s*(\d+)[.、)]\s*(?:\t\s*)?([\s\S]*)$` 的段落，统一为“N、⇥正文”（中文）或“N.⇥正文”（英文），⇥ 为制表符；
  - 记 `marker`；
  - 若该段同时有原生编号：提示“该段同时含手动标记和原生编号，已保留原条号，请人工确认”，不改。
- **参考文献**：从第一个以“[1]”开头的段落起到文末，所有可见 run 设为 9 pt，取消粗体和斜体。

### 8.9 角色划分（`handbookBlocks`）

为每个非空段落分配一个“块”`{p, role, level, group, operative, uncertainNumbering?}`。

| 角色 | 如何判定 |
|---|---|
| `title` | 前 40 段中第一个等于 `model.title` 或满足标题词的段落 |
| `committee` `topic` `country` `delegate` | 页首范围内带对应标签的段落 |
| `sponsors` `signatories` | 页首范围内的国家名单首段，`group` 为字段名 |
| `header` | 国家名单续行（`group` 同上）；其余落在页首范围内的段落 |
| `committee` / `topic`（无标签） | 标题与第一个字段之间、未被占用的短行（≤80 字、无句末标点、不以逗号结尾、不以条款标记或序言动词开头），按 committee、topic 顺序分配 |
| `reference` | 立场文件中从“[1]”开始的段落 |
| `part` | 匹配 `^(?:PART\s+[IVXLC]+\b\|第[一二三四五六七八九十]+部分)` |
| `subject` | 规格里 `subject` 非空（指令草案、决议草案），且是主体句 |
| `preamble` | 决议草案中，识别结果里的序言条款 |
| `item` / `prose` | 其余正文：见下 |
| `object` | 空段落但带隐藏结构：分节符、图片、超链接、脚注引用、域、书签、修订、分页或分栏符 |

**item / prose 的判定**：

- 立场文件：
  - 用 `PP_LEVELS` 判断：`^\s*\d+\s*[.、．)]` 为 0 级、字母 `a)` 为 1 级、罗马数字 `ii)` 为 2 级；
  - 匹配到的是 `item`，否则是 `prose`。
- 其余文种：
  - `level = inferLevel(…)`；
  - `level > 0`、有原生编号或匹配 `HANDBOOK_MARKER` 时是 `item`，否则是 `prose`。
  - `operative` 只在指令草案、决议草案、修正案中为真；工作文件始终为假。
- 页首边界在这里重新计算：已分配角色的最大段号 + 1。

**`inferLevel(text, p, previous, numbering, inList, indents, previousToken, previousParenDigit)`**：按顺序判断，先命中先返回。

1. 罗马数字项：前一项层级 ≥ 1 时为 2，否则为 1。
2. “（1）”类：
   - 紧跟另一个“（1）”类时，与前一项同级；
   - 在列表上下文中时，为前一级 + 1（最多 3）；
   - 否则为 0。
   - 它没有固定级别，随引出它的条款而定。
3. `LEVEL_MARKERS` 表：

| 正则 | 层级 |
|---|---|
| `^\s*(?:第[一…百]+条\|\d+[.、．])` | 0 |
| `^\s*[（(](?:[a-z]\|[一…十]+)[）)]` | 1 |
| `^\s*[a-hj-uw-z][.)）]` | 1 |
| `^\s*[（(][子…亥]{2,3}[）)]` | 3 |
| `^\s*[（(][子…亥][）)]` | 2 |
| `^\s*(?:[ivxlcdm]+\.\|[（(][甲…癸]+[）)])` | 3 |

4. 原生编号：按该级别的 numFmt / lvlText 换算：
   - `ideographZodiac` → 2；
   - `ideographTraditional` → 3；
   - `lowerRoman`：带括号为 2，否则为 3；
   - lvlText 含“第%…条” → 0；
   - lvlText 以“（%”开头 → 1；
   - 都不是时取 `ilvl`。
5. 不在列表上下文中 → 0：页首行、普通段落的意外缩进不算嵌套。
6. 缩进正好等于本规格某一级的 (left, hanging) → 那一级。这保证成稿再处理一遍结果不变。
7. 左缩进在 0–96 pt 之间时，层级 = round(left / 1440 / 0.3)，限定在 0–3；超过 96 pt 视为粘贴噪声，记 0。

**列表上下文 `opensOrContinuesList`**：下一段处于列表中的条件，满足其一即可：

- 本段层级 > 0；
- 本段有原生编号、括号标记、“（1）”标记或任一层级标记；
- 本段以冒号结尾。

**`nestUnmarkedItems`**：

- 处理没有可见标记的原生编号段。
- 若前一段以冒号结尾，且本段属于另一个列表（numId:ilvl 不同），它就是前一段的子项，层级 = 父级 + 1。
- 同一列表、同一级别的后续段沿用这个层级。
- 同一列表的下一项是兄弟，不是子项：仅凭冒号不能证明子条款存在。

### 8.10 编号体系（`documentNumbering`）

先规划，后写入（第 14 步 `apply()`），这样标点和编号两种改动能一起接受校验。详细算法见第 10 章，这里是流程：

1. **逐块建 `NumberedItem`**：
   - 段落是否为“章节”行：匹配文种的 `sectionPattern`（立场文件的“（一）”“一、”），且不是 item、没有原生编号。
   - 只有 item 或 prose、且不是章节的块才参与。
   - `marker = markerOf(text, level≥2)`；没有可见标记但有原生编号时，系列取 `nativeFamily`。
   - `top`：系列为 article；或系列为 decimal、文字不以括号开头、且层级为 0。
   - `reset`：非决议草案时，遇到 part 或章节行。
2. **`plan = planHierarchy(items, 语言, 文种)`** 得到每块的目标层级，或一个“不能确定”的原因。
3. **逐块决定**。以下情况都标记 `uncertainNumbering`，保留原样，并写入一条提示（`list-numbering` / `dr-numbering`）：
   - item（或带原生编号的 item/prose）认不出系列 → “编号类型无法可靠识别，保留原样，请人工确认。”
   - `planHierarchy` 给出原因 → “{原因}，保留原编号，请人工确认。”
   - 同时有手打标记和原生编号 → “同时含手打与原生编号，保留原样，请人工确认。”
   - 修正案中层级 > 0 的块：嵌套内容可能是要插入的目标草案条款，编号属于目标草案 → “修正案嵌套内容可能是待新增或引用条款，编号归属目标草案，保留原样，请人工确认。”
   - 其余情况：采用目标层级，`role` 设为 item，再分两种：
     - **有手打标记**：`target = markerText(语言, 层级, 序号值, 文种)`。
       - 无法表示（超出范围）→ 提示。
       - 目标与现有标记不同时，再检查两点：`validMarkerChange` 不通过（字母/罗马数字有歧义）→ 提示；段落含非文字结构或隐藏/删除线 → 保护提示。
       - 都通过，加入待改写列表。
     - **只有原生编号**：按 `numId:ilvl` 归组，成为原生规则候选。
4. **原生规则候选要全部满足以下条件**，否则整组标记为不确定：
   - 该列表实例不被本组以外的段落使用；
   - 不被页眉、页脚、脚注、尾注使用；
   - 组内段落没有复杂结构；
   - 组内只有一种层级；
   - 级别定义完整：有 `numFmt`，没有 `isLgl`，`lvlText` 里只有本级占位符 `%{ilvl+1}`；
   - 地支、天干的 Word 循环格式只到 12 / 10，起始值加段数不得超出（`nativeRangeReason`）。
5. **返回** `{rules, notes, label, checked, apply}`。`apply()` 做两件事：
   - 对待改写段落用 `rewriteLogged` 写入新标记，记 `dr-marker`（决议草案）或 `list-marker`，并写一条“编号“1.” → “第一条”，序号数值不变。”
   - 对 `numbering.xml` 执行 `applyNativeRules`（第 10.6 节）；有变化时写“按当前文种及父子层级纠正原生编号样式；保留列表标识、序号、起始值与重启规则。”

### 8.11 标题词与页首标签（`headerText`）

- **标题**：
  - 找出原标题以哪个标题词开头（最长匹配）；
  - 替换为 `outputTitles[文种][语言]`，**保留其后的编号或“终”字**。例：“Draft Resolution 1.2” → “DRAFT RESOLUTION 1.2”。
  - 没改过标题时记 `title`；第 03 步改过标题时用新标题计算，记 `field`。若段落含链接、域、修订等无法改写，抛出 `ProtectedContentError`。
- **委员会、议题去标签**：规格 `committeeTopicLabels="drop"` 时，“委员会：安理会”改为“安理会”，记 `label-drop`。
  - 删除标签会删掉隐藏或删除线文字时，不改，并提示“委员会/议题标签含隐藏或删除线文字，未按范例删除标签”。

### 8.12 句末标点（`punctuation` / `setEnding`）

开关：界面勾选“按规则规范条款末尾标点”，且规格 `clausePunctuation=true`。只有指令草案、决议草案为真。

- 主体句和序言条款以“，”结尾（英文“,”）。
- 行动性条款：operative 为真、角色为 item/prose、且不是只有“第X条”的空条。逐条看下一条：
  - 下一条层级更深 → “：”（英文“:”）；
  - 没有下一条（最后一条）→ “。”（“.”）；
  - 其他 → “；”（“;”）。
  - 编号不确定（`uncertainNumbering`）的条款跳过。
- `setEnding(p, ending)`：
  1. 去掉末尾空白，再去掉末尾的 `，,；;。.:：、`，得到 `stripped`。句末之后的换行数保留在新标点之后。
  2. 已经正确或去掉后为空 → 不动。
  3. 句末位于修订痕迹中 → 保护提示“句末标点位于修订痕迹中，未自动规范”。
  4. 句末文字是隐藏或删除线 → 保护提示。
  5. 句末位于域结果或超链接中（`endingContainer`）：
     - 除标点外还有别的变化 → 保护提示；
     - 否则在域或链接**之后**插入一个复制了句末 run 格式（去掉 rStyle）的新 run 写标点，记 `ending`。域结果会被 Word 重新计算，链接文字就是链接本身，所以不碰它们内部。
  6. 普通情况：`rewriteLogged(p, stripped + ending + 换行, "ending")`。

### 8.13 段落几何（`geometry`）

对每个仍在文档中的块：

1. 删除段落属性噪声 `PARAGRAPH_CLEAN`：pStyle、bidi、textDirection、shd、pBdr、framePr、contextualSpacing、snapToGrid、tabs、outlineLvl、textAlignment。
2. `pageBreakBefore=0`、`keepLines=0`。`keepNext` 对页首角色、subject、part 为 1（与下一段同页），其余为 0。
3. **行距**：
   - 删除 beforeAutospacing、afterAutospacing、beforeLines、afterLines；
   - before=0、after=0；
   - `line` = 行距磅值 × 20；
   - `lineRule=exact`。段落含图片、VML、OLE 对象、文本框或公式时改为 `atLeast`，以免内容被截断。
   - **行距磅值（`rolePitch`）**：
     - 英文一律 13.8；
     - 中文决议草案的序言条款 18.0；
     - 中文修正案的国家名单行 17.4、其余行 21.0；
     - 其他中文 15.5。
     - 国家名单行（有 group 或角色为 sponsors/signatories）属于“签名行”。
   - 单倍行距（auto 240）在中文正文中渲染成约 21.3 pt，偏离手册的 15.5 pt，所以纯文字段落不用单倍，用实测值的“固定值”。
4. **对齐**：标题左对齐，其余两端对齐。
5. **缩进**：先清空 `ind` 的所有属性，right=0。
   - item：(left, hanging) = `listIndentsPt[min(level, 末级)]` × 20 twips；hanging 为 0 时写 `firstLine=0`。
   - 其他：left=0，`firstLine` 只对 prose 取 `proseFirstLinePt`（中文立场文件 24 pt，即首行缩进两字）。

### 8.14 强调（`emphasis`）

| 角色 | 强调 |
|---|---|
| object | 去掉粗体、斜体、下划线 |
| title | 粗体，非斜体，无下划线 |
| committee / topic / country / delegate / 无组的 header | 规格 `headerFields="bold"`：整段粗体；`"label-bold"`（立场文件）：只有“…：”标签粗体，值不加粗；没有标签时整段粗体 |
| sponsors / signatories | `styleCountryLine`（第 8.7 节） |
| 有组的 header（名单续行） | 粗斜体 |
| subject | 粗体、斜体取规格 `subject.bold/italic`，无下划线 |
| part | 粗体 |
| preamble / item / prose | 规格 `clearClauseEmphasis` 为真时先全部去掉粗斜体和下划线；然后：序言条款且 `preambleVerbUnderline` → 开头的序言动词加下划线；operative、层级 0、`topLevelVerbItalic` → 开头的行动动词（修正案用修正案动词）设为斜体 |

`emphasizeVerb(p, phrases, style)`：

1. 跳过开头的编号标记（`HANDBOOK_MARKER`）或空白。
2. 在剩余文字开头找最长匹配的动词，不分大小写。
3. 英文要求动词后不能紧跟字母（整词匹配）。
4. 用 `styleTextRange` 只给这一段文字加样式：按偏移拆 run；含图片、域等非文字子元素的 run 先拆成单子元素 run，再跳过不处理。

### 8.15 国家名单断行（`signatureLines`）

规格 `signatureLines=true`（指令草案、决议草案、修正案）时：

1. 起草国、附议国各自取同组的所有段落。
2. 条件检查，不满足就跳过：
   - 首段角色是该字段；
   - 名单值非空；
   - 现有文字（去空白）等于期望文字；
   - 都不含复杂内容或语义标记。
3. `breakCountryList(label, values, 语言)` 估算宽度后断行：
   - 每行可用宽度 `LINE_WIDTH_EM` = (11906 − 1800 − 1800) / 20 / 12 − 1 ≈ 33.6 em；
   - 字宽：码位 > U+2E7F（汉字等）记 1 em，大写字母 0.7，`" ,.;:'’-()"` 记 0.3，其余 0.5；
   - 第一行以标签开头；每个国名后带分隔符（中文“、”，英文“,”，最后一个不带）；英文名之间加空格；
   - **只在完整国名之间断行**，国名本身绝不截断。
4. 只有一行、且原来也只有一段时不动。
5. 否则：第一段写第一行；其余各行新建段落（复制首段 pPr），插在后面，记 `countries`、`created=true`，角色为同组的 header；原来多余的续行段清空。
6. 每行的 run 都是粗斜体；第一行的标签斜体与否取 `countryLabelItalic`。
7. 之后第 19 步会在每一行后面插入一行空行，留出签字位置（手册页 41“要留出空白签字处”、页 52）。

### 8.16 编号字体（`numberingMarkers`）

对 `numbering.xml` 中**所有**抽象列表的每一级，以及每个实例的 `lvlOverride/lvl`：

1. 删除 `MARKER_NOISE`：strike、dstrike、shd、highlight、position、spacing、w、caps、smallCaps、color。
2. 非项目符号（numFmt ≠ bullet）：设本文字体；粗体、斜体为 0，下划线为 none。
3. 所有级别：字号 12 pt。
4. 不改编号的数值、格式和文字。未使用的列表也处理，免得以后粘进来的列表带回小号编号。

### 8.17 连续性检查（`continuity`）

- 对 item 块用 `markerOf` 取系列和序号，交给 `sequenceIssues`（第 10.5 节）找跳号和重号。
- 有问题时警告“编号不连续，已保留原文、未自动改号，请确认：第 N 段“3.”（前一个为第 1 项）；……”（最多列 8 处）。
- 只提示，绝不改号。

### 8.18 空行（`blankLines`）

1. **删除原有空段**，条件全部满足才删：
   - 没有可见文字；
   - 没有隐藏结构；
   - 没有原生编号；
   - 没有语义标记；
   - 签名只含空白；
   - 不是内容控件里唯一的段落（容器至少保留一段）。
   - 删除时记 `empty-line`。
2. **按规格插入空行**。插在下列段落之后：
   - `blankAfter` 中的每一项：
     - `title_block` → 标题 / 委员会 / 议题中的最后一段；
     - `header` → 页首角色中的最后一段；
     - `sponsors` / `signatories` → 该组的**每一行**（签字空行）；
     - 其他名称（committee、title、topic、subject）→ 该角色的最后一段。
   - `blankBeforeOperative`（决议草案）→ 第一条行动性条款的前一段。
   - `blankBetweenProse`（英文立场文件）→ 每个正文块（preamble/item/prose/reference/part）之后；但相邻两块都是 item 或都是 reference 时不加。
3. **空行段落本身**：pPr 里 before=0、after=0、行距固定。
   - 行距：签名行之后的空行与签名行等高（中文修正案 17.4），其余为正文行距。
   - pPr/rPr 设本文字体、12 pt。
   - 记 `blank`、`created=true`。

### 8.19 脚注与尾注（`handbookNotes`）

- 对 `word/footnotes.xml`、`word/endnotes.xml` 的所有 run：字体 Times New Roman + 东亚字体，字号 9 pt。
- 前后的 `contentSignature` 必须相同，否则抛错“脚注内容校验未通过，已中止输出。”
- XML 损坏时抛错“脚注 XML 损坏，已中止输出。”

### 8.20 字体部件（`normalizeFontParts`）

- `word/fontTable.xml`：删除 Aptos Display、Calibri Light、Calibri、Cambria、Aptos。
  - 中文文件确保有 SimSun 条目，并设 `altName="Songti SC"`，使 macOS 上能找到宋体。
- `word/theme/theme1.xml`：凡 `typeface` 是上述字体的，改为 Times New Roman。数学字体保留（Times New Roman 没有数学表）。
- 中文文件：`word/settings.xml` 中的 `w:eastAsia="ja-JP"` 改为 `zh-CN`。

### 8.21 校验、打包与输出

1. **`verifyFormat`**（第 12.4 节）与 **`verifyMarks`**（第 12.5 节）得到内容问题列表。
2. 序列化 `document.xml`，用 `zipSync(parts, {level: 6})` 打包。
3. **`verifyPackage`**（第 12.6 节）比较原包与新包。
4. **`runSizeIssues`**：统计字号不对的文字 run。立场文件参考文献之后应为 9 pt，其余 12 pt，误差 0.05。
5. **组装校验结果**（代码表见第 13 章）：
   - `structural_edits` 列出本次所有改动的说明（`EDIT_NOTES`），第 03 步的修改写在最前：“应用第 03 步人工确认的修改（委员会、议题）”。
   - 第 03 步每个改过的字段：
     - 写入成功 → `manual-field` ✓；
     - 文档里没有可安全替换的字段行 → `manual-field-unwritten` △：“…未写入：文档中没有可安全替换的…字段行。已保留原稿，不自动添加新行；请在原稿补充该字段后重新上传。”
6. **存在任何 error** → 抛出 `ContentCheckError`：“安全校验未通过，已中止下载：{标签（详情）；…}”。
7. **否则返回**：
   - `blob`，MIME 为 `application/vnd.openxmlformats-officedocument.wordprocessingml.document`；
   - `filename`；
   - `validations`。

**文件名 `outputFilename`**：

- 组成：`[titles[文种][语言], 提交会期, 国家, 版本号 || "v1"]`，去掉空项，用空格连接。
  - 国家 = 提交国家 || 国家字段 || 第一个起草国 || “待填写国家”。
- 把 `\ / : * ? " < > |` 和控制字符替换为“-”，截到 180 字符，加 `.docx`。
- 例：“决议草案 S3 法兰西共和国 v1.docx”。

**异常映射**（`formatDocxInBrowser`）：

| 异常 | 用户看到的消息 |
|---|---|
| `InvalidRequestError` | 原样（第 03 步输入不合法） |
| `InvalidDocxError` | “文件无法读取：{原因}” |
| `ProtectedContentError` | “为保护原有内容已中止输出：第 N 段：{原因}” |
| `ContentCheckError` | “安全校验未通过，已中止下载：…” |
| 其他 | “程序内部错误（不是文件本身的问题），请把该文件反馈给维护者。{错误名}: {前 200 字}” |

## 9. 学标版式参数（`shared/document-policy.json` → `handbook`）

### 9.1 通用

| 项 | 值 |
|---|---|
| 纸张 | A4 纵向，11906 × 16838 twips |
| 页边距 | 上下 1440、左右 1800、页眉页脚 720（twips） |
| 正文字号 | 12 pt（编号同） |
| 脚注 / 尾注 / 立场文件参考文献 | 9 pt |
| 西文字体 | Times New Roman |
| 中文字体 | SimSun（宋体）；中文修正案为 Arial Unicode MS |
| 行距（固定值） | 中文 15.5；英文 13.8；中文决议草案序言 18.0；中文修正案 21.0；中文修正案名单行 17.4 |
| 国家分隔符 | 中文“、”；英文“, ” |
| 国家排序 | 中文按拼音；英文按字母；可选保持原顺序 |

**输出标题词**：

| 文种 | 中文 | 英文 |
|---|---|---|
| 立场文件 | 立场文件 | Position Paper |
| 工作文件 | 工作文件 | WORKING PAPER |
| 指令草案 | 指令草案 | Draft Directive |
| 决议草案 | 决议草案 | DRAFT RESOLUTION |
| 修正案（两种） | 修正案 | Amendment |

**修正案动词**（修正案每条操作开头，斜体）：

- 中文：加入、增加、添加、增补、插入、删除、删去、修改、修订、替换、改为、调整、合并、移动；
- 英文：Add、Insert、Delete、Remove、Strike、Amend、Modify、Replace、Change、Revise、Merge、Move。

### 9.2 各文种 × 语言的规格

缩进写成 (左缩进, 悬挂) 磅，从 0 级到末级。

| 文种 / 语言 | 页首字段 | 委员会/议题标签 | 名单标签斜体 | 主体句 | 正文首行 | 列表缩进 | 顶层动词斜体 | 序言动词下划线 | 清除条款强调 | 名单断行 | 其后空行 | 正文间空行 | 行动条款前空行 | 规范句末标点 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 立场文件 zh（页15–16） | 仅标签粗 | 保留 | 否 | — | 24 | (45,21)(66,21)(87,21) | 否 | 否 | 否 | 否 | header | 否 | 否 | 否 |
| 立场文件 en（页17–18） | 仅标签粗 | 保留 | 否 | — | 0 | (21,21)(42,21)(63,21) | 否 | 否 | 否 | 否 | header | **是** | 否 | 否 |
| 工作文件 zh（页31–32） | 整段粗 | 删除 | **是** | — | 0 | (21,21)(42,21)(63,21)(84,21) | 否 | 否 | 是 | 否 | — | 否 | 否 | 否 |
| 工作文件 en（页32–35） | 整段粗 | 保留 | 否 | — | 0 | (21,21)(43,18)(64,18)(85,18) | 否 | 否 | 是 | 否 | header | 否 | 否 | 否 |
| 指令草案 zh（页37–38） | 整段粗 | 删除 | 否 | 斜体 | 0 | (0,0)(48,36)(67.5,36)(87,36) | 是 | 否 | 是 | 是 | signatories, sponsors, subject, title_block | 否 | 否 | 是 |
| 指令草案 en（页37–38） | 整段粗 | 删除 | 否 | 斜体 | 0 | (21,21)(49.5,28.5)(70.5,21)(91.5,21) | 是 | 否 | 是 | 是 | 同上 | 否 | 否 | 是 |
| 决议草案 zh（页41–43） | 整段粗 | 删除 | 否 | 粗斜体 | 0 | (0,0)(48,36)(67.5,36)(87,36) | 是 | 是 | 是 | 是 | signatories, sponsors, subject, title_block | 否 | 是 | 是 |
| 决议草案 en（页43–47） | 整段粗 | 删除 | 否 | 斜体 | 0 | (18,18)(36,18)(54,18)(72,18) | 是 | 是 | 是 | 是 | committee, signatories, sponsors, subject, title_block | 否 | 是 | 是 |
| 修正案 zh（页52） | 整段粗 | 删除 | 否 | — | 0 | (18,18)(36,18)(54,18)(72,18) | 是（修正案动词） | 否 | 是 | 是 | signatories, sponsors | 否 | 否 | 否 |
| 修正案 en（页53） | 整段粗 | 删除 | 否 | — | 0 | (0,0)(42,21)(63,21)(84,21) | 是（修正案动词） | 否 | 是 | 是 | committee, signatories, sponsors, title, topic | 否 | 否 | 否 |

## 10. 编号系统（`app/numbering.ts`，镜像 `backend/app/numbering.py`）

核心观点：**编号样式不等于结构**。

- 层级要从父项引出关系（冒号）和同系列的兄弟项推断，不能只看字形。
- 程序只纠正有证据的“表示法”，不补缺号、不改序号数值、不改交叉引用。

### 10.1 编号系列（family）与 `markerOf(text, romanContext)`

| 系列 | 例 | 取值方法 |
|---|---|---|
| `article` | 第一条、第十二条 | 中文数字 1–99 |
| `decimal` | 1. 1、 1) 1） | 阿拉伯数字 |
| `paren-decimal` | (1)（1） | 括号里的阿拉伯数字 |
| `chinese` | （一）（十二） | 中文数字 |
| `zodiac` | （子）（子子） | 地支序列：12 个单字，之后两字组合 |
| `stem` | （甲）（甲甲） | 天干序列：10 个单字，之后两字组合 |
| `letter` | a. (b) c) | 单个英文字母，a=1 |
| `roman` | (iv) | 括号里的罗马数字 |
| `roman-dot` | iv. | 带点的罗马数字 |

规则：

- 以“1.5”“1.2.3”这类小数或复合编号开头 → `null`：它不是单级序号 1，绝不只改第一段数字。
- “第X条”单独匹配；其余用 `^\s*(?:[（(]([^（）()\s]+)[）)]|([0-9]+|[a-zA-Z]+)[.．、)）])` 取出 token。
- token 依次尝试：数字 → 中文数字 → 地支 → 天干 → 单个字母 → 罗马数字。
- `romanContext` 为真（层级 ≥ 2）时，单字母若也是罗马数字（i、v、x…），优先读作罗马数字。
- 取值必须在 1–99 之间。
- 返回 `{family, value, length}`，`length` 是标记的字符长度。

### 10.2 各文种的目标格式（`numbering-profiles.json`、`dr-numbering-policy.json`）

| 文种 | 语言 | 0 级 | 1 级 | 2 级 | 3 级 |
|---|---|---|---|---|---|
| 立场文件 | zh | `%n、` decimal | `%n)` letter | `%n)` roman | — |
| 立场文件 | en | `%n.` decimal | `%n)` letter | `%n)` roman | — |
| 工作文件 | zh/en | `%n.` decimal | `(%n)` letter | `(%n)` roman | `%n.` roman-dot |
| 指令草案 | zh | `%n.` decimal | `（%n）` chinese | `（%n）` zodiac | `（%n）` stem |
| 指令草案 | en | `%n.` decimal | `%n.` letter | `(%n)` roman | `%n.` roman-dot |
| 决议草案 | zh | `第%n条` article | `（%n）` chinese | `（%n）` zodiac | `（%n）` stem |
| 决议草案 | en | `%n.` decimal | `(%n)` letter | `(%n)` roman | `%n.` roman-dot |
| 修正案 | zh | `%n.` decimal | `（%n）` chinese | `（%n）` zodiac | `（%n）` stem |
| 修正案 | en | `%n.` decimal | `(%n)` letter | `(%n)` roman | `%n.` roman-dot |

- 每级还配有 Word 的 numFmt：decimal、lowerLetter、lowerRoman、chineseCounting、ideographZodiac、ideographTraditional。
- 立场文件另有 `sectionPattern`：`^\s*(?:[（(][一二三四五六七八九十百]+[）)]|[一二三四五六七八九十百]+[、.．])`。章节标题和建议列表分开处理，章节编号不动。
- 修正案的嵌套内容属于目标草案，永不自动改号（`amendmentNestedPolicy`）。

**原生 numFmt → 系列**（`nativeFamilies`）：

| numFmt | 系列 |
|---|---|
| chineseCounting、chineseCountingThousand | chinese |
| decimal | decimal（lvlText 以括号开头时为 paren-decimal） |
| lowerLetter、upperLetter | letter |
| lowerRoman、upperRoman | roman（lvlText 不以括号开头时为 roman-dot） |
| ideographZodiac | zodiac |
| ideographTraditional | stem |

lvlText 含“第%…条”时为 article。

**各系列默认层级**（`defaultLevels`）：article 0、decimal 0、paren-decimal 1、letter 1、chinese 1、zodiac 2、stem 3、roman 2、roman-dot 3。

### 10.3 `markerText(language, level, value, type)`

- 取目标格式第 `level` 级，`%n` 换成按系列写出的序号：
  - 中文数字：`chinese(n)`，1–99，如 21 → 二十一；
  - 地支、天干：`series(n, 字表)`，先单字，再两字组合；
  - 字母：1–26；
  - 罗马数字：小写。
- 级别不存在或数值超出范围时返回 `null`。

### 10.4 `planHierarchy(items, language, type)`：层级规划

逐项维护四个状态：

- `ranks`：系列 → 层级；
- `identities`：原生列表 key → 层级；
- `parent`：上一项以冒号结尾时为它的层级，否则为 null；
- `active`：是否已见过顶层条款。

对每一项：

1. `reset`（PART、章节行）→ 清空全部状态。
2. `top`（第X条或 0 级的“1.”）→ 清空并设 `active=true`；层级为 0；`parent` = 本项以冒号结尾 ? 0 : null。
3. 没有系列 → `parent=null`，保持原层级。
4. 计算 `canonical`：
   - 系列在本文种格式表中的位置；
   - 立场文件只有三级，`roman-dot` 记为 2；
   - 都不是时取默认层级。
5. 还没有顶层条款 → 给出原因“无明确顶层条款，不能确定编号层级”。
6. 新系列（或新的原生列表）：
   - 层级 = `ranks` 中已有值 ?? `canonical`；
   - 有父项且 `canonical ≤ 1` → 父级 + 1；
   - 非决议草案且有父项且是新系列 → 父级 + 1；
   - 原生列表且有父项 → 父级 + 1。原生列表有稳定标识，即使导出时都写成 ilvl=0 也能靠上下文分级。
   - 没有父项、是新系列、层级又与已有系列冲突 → 原因“不同编号系列占用同一层级，但缺少明确父子关系”。
7. 已知系列，但父级等于自己的层级 → 原因“相同编号系列既作父项又作子项，层级证据冲突”。
8. 层级超出本文种的级数 → 原因“超过该文种配置的编号层次，不能安全转换”。
9. 中文决议草案、指令草案中，新出现的地支系列而天干已出现 → 原因“地支与天干系列交错，疑似编号错字或层级冲突”。
10. 某系列一旦有原因，后续同系列项都沿用这个原因。
11. 有原因时层级保持原值；`parent` 按本项是否以冒号结尾更新。

### 10.5 `validMarkerChange` 与 `sequenceIssues`

- **`validMarkerChange(before, after)`**：改号的独立复核。
  - 旧标记与新标记的序号值必须相同。新标记会按普通和 romanContext 两种读法各试一次，任一种值相同即可。
  - 去掉标记和句末标点后，正文必须完全相同。
- **`sequenceIssues(items)`**：
  - 按“层级:系列”记录上一个序号；遇到更浅的层级时，清掉更深层级的记录；`reset` 时清空。
  - 序号 ≠ 上一个 + 1 时报告。
  - 例外：序号为 1，且前一项是以冒号结尾的无标记段或更浅一级，算合法重新起号，不报告。

### 10.6 原生编号转换 `applyNativeRules(xml, rules)`

- 只改**实例级**表示：在 `w:num` 下建或找 `w:lvlOverride ilvl=…`，里面放一份原级别定义的副本，只改 `numFmt` 和 `lvlText`。
  - `lvlText` = 目标模板，`%n` 换成 `%{ilvl+1}`。
- 共享的 `abstractNum`、计数器、`startOverride`、重启规则、段落的列表归属和引用标识都不变。
- 规则无法证明（缺 numFmt / lvlText、复合编号、法律编号 `isLgl`）时抛错。
- `verifyPackage` 会在原 `numbering.xml` 上重放同样的规则，再与输出比较（第 12.6 节）。

## 11. 国家名称（`app/countries.ts`、`shared/country-names.json`）

### 11.1 数据

`country-names.json`：

- `schema_version`、`checked_on`（2026-10-05）、`sources`、`policy`、`records`。
- 197 条记录：会员国 193、专门机构成员 2、观察员国 2。

记录示例：

```json
{ "id": "UN-M49-250", "kind": "member-state",
  "formal": {"zh": "法兰西共和国", "en": "French Republic"},
  "source_formal": {"zh": "法兰西共和国", "en": "the French Republic"},
  "short": {"zh": "法国", "en": "France"},
  "sort_name": {"zh": "法兰西共和国", "en": "French Republic"},
  "aliases": ["France"], "source": "https://unterm.un.org/unterm2/en/country", "checked_on": "2026-10-05" }
```

`policy` 有三张待确认名单：

- `ambiguous`：刚果、Congo、Korea、America、美洲……
- `historical`：苏联、USSR、南斯拉夫……
- `organizations`：联合国、UN、欧盟、European Union……

数据由 `scripts/import-country-names.py` 从 UNTERM 导出和 UNGEGN JSON 生成：`--unterm-export … --ungegn-json … --checked-on …`。

`country-pinyin.json`：

- `phrases`：国名或词组 → 空格分隔的拼音；
- `chars`：单字读音，319 个。

### 11.2 解析 `resolveCountry(input, language)`

- **匹配键 `nameKey`**：
  - NFKC 规范化；
  - 弯引号 `’‘` 改为直引号；
  - 各种空白（`field-edit-policy.countryWhitespace`）合成单个空格并去掉首尾；
  - 转小写。
- **索引**：每条记录的 formal、source_formal、short（两种语言）和 aliases 都建键；同一个键可能对应多条记录。
- **状态**：
  - 键在待确认名单中 → 对应的 ambiguous / historical / entity；
  - 匹配到多条 → ambiguous；
  - 没有匹配 → unknown；
  - 唯一匹配且是会员国 → resolved；
  - 唯一匹配但不是会员国 → entity。
- **显示名**：只有 resolved 才展开为 `formal[语言]`。
  - 输入已是 formal 或 source_formal（如带英文冠词 the 的官方形式）时保持原样。
  - 别名和简称展开为不带冠词的正式全称。
- **只做整名匹配**：没有子串匹配、后缀推断，也绝不替换正文里的国名。

### 11.3 排序与去重 `planCountries(values, language, preserveOrder)`

1. 去掉空项，逐个解析。
2. 按 id 去重。没有 id 的（未知、歧义等）一律保留，不能悄悄消失。
3. 不保持原顺序时排序：
   - 英文按 `sort_name` 小写比较；
   - 中文按 `countrySortKey`：对 `sort_name` 最长匹配词组拼音，否则用单字读音，再不行用原字符，得到音节数组。
   - 逐元素按 Unicode 码位比较，与 Python 一致，不按 JS 的 UTF-16 单元。
4. 返回 `{values: 显示名数组, resolutions, removedDuplicates}`。

### 11.4 其他

- **`countryWarnings(values, language)`**：对非 resolved 的名称，提示“{名称}属于称呼有歧义/历史国家或历史名称/组织、观察员或其他非会员国实体/资料表未确认的名称；已保留原输入，请在第 03 步人工确认。”
- **`splitCountryNames(value)`**：
  - 整串本身是一个已知名称（或在待确认名单中）时不切分，例如“Congo (the)”；
  - 否则按 `,，、;；/|\n\r\t` 切分并去掉空白。
- **`validCountryFieldChange(before, after, language)`**：独立复核国家字段改写。
  - 前后都能解析出国家字段值：无标签取全文；有标签时，标签必须是 country 的别名。
  - 原值解析为 resolved，且其显示名正好等于新值。

## 12. 内容保护模型（`app/content-guard.ts`，镜像 `backend/app/content_guard.py`）

### 12.1 内容签名

一个段落或表格的签名是一串带类型的记号：

| 记号 | 含义 |
|---|---|
| `["t", ch]` | 可见文字（`w:t`）中的一个字符 |
| `["dt", text]` | 删除修订的文字（`w:delText`） |
| `["s", "{ns}tag", attrs]` | 任何其他节点的开始：完整命名空间、全部属性（排序后的 JSON） |
| `["e", "{ns}tag"]` | 节点结束 |
| `["x", text]` | 非文字节点自带的文本，如域代码 |

- 格式元素（pPr、rPr、tblPr、trPr、tcPr、tblGrid、sectPr、tblPrEx）和 run 边界不进入签名。
- Word 的修订保存 id 属性（`rsid*`、`paraId`、`textId`）和 xmlns 声明也不进入签名。
- 记号用数组而不是拼接字符串，因此“看起来像标签的文字”不会被误认为结构。

**派生函数**：

- `elementText`：可见文字，跳过 del、moveFrom、txbxContent；tab 记 `\t`，br/cr 记 `\n`。
- `structureOnly(sig)`：只留非文字记号，以及**修订内**的文字记号。修订里插入或删除的字属于修订本身，给它加标签或删字等于改写修订。
- `withoutEnding(sig)`：去掉段落自身（不含文本框内段落）末尾的 `，,；;。.:：、 \t` 字符。
- `normalizeMarker(sig)`：开头的“1. ”“1、⇥”“1)”等统一成“1.”，用于比较 marker 改写。
- `isWhitespace(sig)`：只含空白字符和无属性的 tab/br/cr。

### 12.2 快照

`takeSnapshot(document)`：

- 正文块 = body 下的段落和表格，穿过 sdt / sdtContent / customXml；
- 记录每块的签名、可见文字、列表归属（块内每个段落的 `[numId, ilvl]` 或 null）；
- 以及所有 sdt / customXml 外壳的属性和非内容子元素签名。

### 12.3 允许的编辑（白名单）与 `checkEdit`

| kind | 来源 | 允许的变化 |
|---|---|---|
| `ending` | 句末标点 | 去掉末尾标点后签名完全相同 |
| `marker` | 立场文件编号写法 | `normalizeMarker` 后签名相同 |
| `dr-marker` / `list-marker` | 编号体系 | 前后都是纯文字，且 `validMarkerChange` 通过 |
| `countries` | 国家名单 | 单段不查，由名单组级检查负责（见下） |
| `country-name` | 国家全称展开 | 旧段是普通字段、新段是纯文字、非人工修改，且 `validCountryFieldChange` 通过 |
| `title` | 标题词 | 结构不变；新旧都以某个标题词开头，去掉标题词后的部分完全相同 |
| `label-drop` | 删委员会/议题标签 | 结构不变；旧文本匹配“别名 + 冒号 + 值”，新文本等于值 |
| `label-restore` | 补标签 | 结构不变；新文本等于授权的 `expected`，且以原文字结尾 |
| `field` | 第 03 步修改 | 新段必须是纯文字，新文本等于 `expected`；旧段是普通字段，或结构不变 |
| `blank` | 新建空行 | 只能是新建段落，且签名为空 |
| `empty-line` | 删除原空段 | 原段签名只含空白 |

除 `ending`、`marker`、`dr-marker`、`list-marker`、`countries`、`country-name` 和“普通字段 → 纯文字”的 `field` 外，其余编辑都要求 `structureOnly` 前后相同，即图片、域、链接、修订等结构不变。

**`rewriteLogged(ctx, p, text, kind, key)`** 是所有文字改写的唯一入口：

1. 备份段落子节点、签名和语义标记。
2. 用 `setText` 改写：
   - 段落可以无损扁平化（没有复杂内容、没有语义标记，且所有有字 run 的格式相同）→ 清空后写一个新 run；
   - 否则 `editVisibleText` 原位改：算出新旧文字的公共前缀和后缀，只改覆盖差异的 `w:t`；
   - 都不行 → 保护提示“该段包含图片、域或复杂结构，已保留原样未改写”。
3. 以下情况就地恢复备份（元素身份不变，以便后续比对），并写保护提示，返回 false：
   - 结果不完全等于目标；
   - `rewriteKeepsStructure` 不通过；
   - 会删掉或去掉隐藏/删除线文字（`marksKept` 不通过）。
4. 成功后记入编辑日志。之前已记为 `field` 的段落，后续的 label-drop / title 合并记为 `field`，期望值更新为最终文字。

### 12.4 `verifyFormat(snapshot, document, editLog, titles, labels)`

逐项检查，问题写成用户可读的文字：

1. 内容控件或自定义 XML 外壳发生变化 → 报告。
2. 快照中的每个块：
   - **被删除**：只有 `countries` 段，或签名全空白的 `empty-line` 段可以删除；否则报“第 N 段被删除：…”。
   - **列表归属变化** → 报告（会改变条号和交叉引用）。
   - **签名变化但没有编辑记录** → “第 N 段内容发生未经许可的变化：“…” → “…””。
   - **有编辑记录** → 调用 `checkEdit`，不通过就报告原因。
3. 输出中的新块必须 `created=true`，且只能是：
   - `blank`：签名必须为空；
   - `countries`：签名续行，归入名单组。
4. **名单组**（按 key 分组）：
   - 改动过的段落必须是纯文字；
   - 原名单段必须都是普通字段（`isPlainField`）；
   - 非人工修改：原名单名称经 `planCountries` 得到的允许列表，必须**逐项、按顺序**等于输出的名称列表；
   - 没有国家参数的组：名称多重集合必须相同；
   - 有 `expected` 时，组内文字去空白后必须等于它；否则名称多重集合必须与原文一致。
5. 保留下来的块，相对顺序必须不变。

### 12.5 隐藏与删除线（`verifyMarks`）

- 每块在排版前记录 `[隐藏文字, 删除线文字]`；跳过 del / moveFrom 中的 run。
- 排版后：
  - 原来有标记的块被删除 → 报告；
  - 隐藏文字没有按顺序作为子序列（按码位比较）出现在新的隐藏文字中 → “第 N 段的隐藏文字会变为可见：…”；
  - 删除线同理 → “第 N 段的删除线被移除：…”。

### 12.6 包级校验与结构修复校验

**`verifyPackage(before, after, nativeRules)`**：

1. 所有 `.rels` 中每个关系（按 Id）的全部属性（Target、Type、TargetMode）必须不变；重复 Id 直接报错。
2. `word/media/*`、`word/embeddings/*` 的字节必须完全相同。
3. `numbering`、`footnotes`、`endnotes`、`comments`、`header*`、`footer*` 部件的签名必须相同（格式属性除外）。
   - `numbering.xml` 先在原文件上重放 `nativeRules` 再比较。

**`verifyRepair(beforeTokens, afterTokens, insertedTexts)`**：

- 全文记号逐块拼接，块之间加 `["p",""]`。
- 忽略：块边界、空白字符、无属性的 br（拆段或换行引起）。
- 双指针比对：修复后多出的记号只能是报告过的插入字符（如“（一）”），按次数扣减。
- 原记号没有走完 → “结构修复删除了内容”。

## 13. 校验项代码表

| code | 标签 | 状态 | 何时出现 |
|---|---|---|---|
| `docx_package` | DOCX 包结构 | ✓ | 总是（能走到这一步说明包合法） |
| `structural_edits` | 结构与人工修改记录 | ✓ / △ | 总是；有改动时为 △，详情列出改动说明 |
| `content` | 逐段严格内容校验（文字、域、链接、书签、脚注、修订、隐藏与删除线） | ✓ / × | 总是 |
| `package` | 链接目标、关系与嵌入资源逐项保留 | ✓ / × | 总是 |
| `font_size` | 正文与编号字号 | ✓ / × | 总是 |
| `browser_private` | 本地处理 | ✓ | 浏览器引擎总是出现 |
| `numbering-policy` | {文种}编号规则检查 | ✓ / △ | 总是；详情“已检查 N 个可识别编号段；…” |
| `dr-numbering` / `list-numbering` | {文种}编号体系核查 | △ | 每条编号提示或改号记录 |
| `manual-field` / `manual-field-unwritten` | 第 03 步{字段}修改结果 | ✓ / △ | 第 03 步每个修改过的字段 |
| `country_names` | 国家全称展开与身份去重记录 | ✓ | 每条名称展开或去重 |
| `country-review` | 国家或实体名称待人工确认 | △ | 每个非 resolved 名称 |
| `repair-content` | 结构修复严格内容校验 | × | 结构修复越界 |
| `hidden-text` | 隐藏文字与删除线按原稿保留 | △ | 部分文字隐藏或删除线 |
| `numbering_review` | 原编号已保留，疑似缺项需人工确认 | △ | 第 8.1(c) 节 |
| `structure_review` | 结构识别待确认 | △ | 未拆分的“context”情况、识别警告、编号不连续 |
| `content-protected` | 为保护原有内容，部分段落未自动改写 | △ | 每条保护提示 |

`structural_edits` 的说明文字（`EDIT_NOTES`）：

| kind | 说明 |
|---|---|
| title | 按学标统一标题用词 |
| label-drop | 按范例删除委员会/议题标签 |
| label-restore | 补齐页首标签 |
| countries | 国家名单按顺序排列并按国名断行留签字空行 |
| ending | 按学标统一条款末尾标点 |
| marker | 统一立场文件建议编号写法 |
| blank / empty-line | 按范例调整空行 |
| country-name | 按共用 UNTERM 名称表展开明确国家字段的全称 |
| dr-marker | 按学标纠正决议草案编号表示法（保留序号数值） |
| list-marker | 按当前文种统一编号表示法（保留序号数值） |
| （修复） | 补齐（一）标记；拆分嵌套条款 |

## 14. 页面预览（`preview-safety.ts`、`preview-renderer.ts`、`docx-preview.tsx`）

**目的**：在页面里近似显示原稿和成稿的版面，全程不联网。

**`preparePreview(content)`**：只处理一份预览用的副本，下载的文件不受影响。

1. 先用 `readPackage` 套用同样的包预算。
2. `document.xml` 超过 2 MiB 时放弃预览，提示“文档较大，已跳过页面预览；仍可正常排版和下载。”
3. 删除所有外部关系：`TargetMode=External`，或 Target 带协议（`http:` 等）或以 `//` 开头。
4. 记下每个部件中能解析到包内实际部件的关系 Id。
5. 在每个 `word/*.xml` 部件中：
   - 引用了被删除、缺失或无法解析关系的图片元素（`blip`、`imagedata`、`fill`），连同外层的 `drawing` / `pict` / `object` 整个删除；
   - 引用了已删除关系的其他属性，只删除这个属性。
   - 原因：docx-preview 先在页面自身的文档里建元素，再移入沙箱 iframe，这个阶段 iframe 的 CSP 管不到；找不到来源的图片会变成 `<img src="null">`，向托管站点发请求。
6. 重新打包。

**`renderPreview(blob, frame, isCurrent)`**：

1. 动态 `import("docx-preview")`。
2. 往 iframe 写入一个带 CSP 的空白文档：
   `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`。
3. 拦截 iframe 内的所有点击。
4. `renderAsync` 选项：
   - `useBase64URL: true`、`renderAltChunks: false`、`renderComments: false`；
   - `renderChanges: true`、`ignoreLastRenderedPageBreak: false`；
   - 渲染页眉、页脚、脚注、尾注。
5. 渲染完成时若 `isCurrent()` 为假（用户已换文件），丢弃结果，避免旧文件的预览覆盖新文件。

**`DocxPreview` 组件**：

- 一个标题，加 `sandbox="allow-same-origin"` 的 iframe（不允许脚本）；
- 状态文字“正在读取页面…”；
- 失败时显示错误原文，或“页面预览不可用，仍可下载 DOCX。”

## 15. 模板新建（`template-generator.ts`、`template-panel.tsx`）

**用途**：没有原稿时，按学标生成一份新文件。原稿不会经过这个生成器。

**`generateFromTemplate(type, input)`**：

1. 校验输入：
   - 语言只能是 zh / en；
   - 每个值是字符串，不超过 100000 字符，且能写进 XML；
   - 正文为空时报错“请先填写正文；程序不会替你编写内容。”
2. 页首字段按文种取：
   - 委员会；
   - 议题（指令草案没有）；
   - 立场文件：国家、代表；
   - 其他文种：起草国；工作文件以外再加附议国；
   - 只输出有值的字段，格式“标签：{key}”。
3. 生成一个最小 DOCX：
   - `[Content_Types].xml`、`_rels/.rels`、`word/_rels/document.xml.rels`；
   - `word/styles.xml`：docDefaults 字体为 Times New Roman + 东亚字体，12 pt，段落间距 0/0/240 auto；另有一个 Normal 样式；
   - `word/document.xml`：标题段 `{title}`、页首段、正文占位 `{@bodyXml}`、`<w:sectPr/>`。
   - 自带样式表，是为了让两个引擎和 Word 都从本文字体起步，而不是各自不同的内置默认。
4. 用 docxtemplater（`paragraphLoop`、`linebreaks`）渲染：
   - `title` = 输出标题词；
   - `bodyXml` = 正文按换行拆成多个段落的 XML，文字已转义。
5. 走正常的 `parseDocxInBrowser` → 把 `model.language` 设为用户所选 → `formatDocxInBrowser`（规范标点开）。返回值与正常排版相同。

**面板行为**：

- 每次修改字段都作废进行中的生成（`operation.current++`）；
- 切换文种时组件以 `key` 重建；
- 生成成功后直接触发下载。

## 16. 诊断报告

见第 4.4 节。界面上它是第 03 步的折叠区；Python API 的 `/api/parse` 也在响应里附带它；CLI 的 `--diagnose-only` 只输出它。

## 17. Python 兼容引擎、HTTP API 与 CLI（`backend/`）

### 17.1 模块对应关系

| 浏览器（TypeScript） | Python | 说明 |
|---|---|---|
| `docx-safety.readPackage` | `docx_package.validate_docx_package` | 同一份 `package-policy.json` |
| `parsePackage` 的样式显式化 | `structure_repair._materialize_style_list_format` / `_materialize_style_emphasis` | |
| `recognize` | `parser.DocxParser.parse` | 见 17.4 节差异 |
| `repairMissingFirstSection` / `normalizeEmbeddedSubclauses` / `suspectedMissingListItems` | `structure_repair.repair_structure_with_report` | 另有 `_repair_position_header`、`_restore_dropped_first_list_item`，置信度阈值 0.9 |
| `formatInner` 第 4–19 步 | `formatters/base.py:BaseFormatter.format` + `handbook_pass.py:HandbookPassMixin._apply_handbook` | 步骤顺序一致 |
| `content-guard.ts` | `content_guard.py` | 签名记号相同（Clark 记法的元组） |
| `numbering.ts` | `numbering.py` | |
| `countries.ts` | `countries.py` | 测试保证两边对每个正式名和别名结果一致 |
| `normalizeFontParts` / `handbookNotes` | `fonts.normalize_font_parts` | |
| `diagnostics.ts` | `diagnostics.py` | |
| `field-policy.ts` | `field_policy.py` | |

- **文种格式化类**：`PositionPaperFormatter`、`WorkingPaperFormatter`、`DraftDirectiveFormatter`、`DraftResolutionFormatter`、`FriendlyAmendmentFormatter`、`UnfriendlyAmendmentFormatter`。
  - 它们只决定“共同角色之后再做什么”，例如工作文件先清除全部字符强调，指令草案检查顶层条款是否以行动动词开头。
  - 版式统一由 handbook pass 完成。
- **一致性夹具**：`tests/fixtures/engine-parity.json` 由 `scripts/export_engine_parity_fixture.py` 生成，Node 和 Python 两边的测试都读取它。

### 17.2 流水线 `pipelines.BasePipeline.run`

1. `validate_docx_package` → `repair_structure_with_report` → `parser.parse`。
2. 用 `content_guard.verify_repair` 检查修复：只允许插入修复动作报告过的字符。
3. 应用 overrides。键名支持 camelCase 自动转 snake_case；只允许 `OVERRIDABLE_FIELDS`：language、title、committee、topic、delegate、country、sponsors、signatories。类型、长度、XML 字符的规则与浏览器 `validateReview` 相同。
4. 计算 `changed_fields`，调用 `formatter.format(...)`。
5. 修复动作被应用时，把 `structural_edits` 置为 △，并加上说明：
   - “恢复被删除的自动编号首项”；
   - “补齐（一）标记”；
   - “拆分嵌套条款”。
6. **文件名**用 `FILENAME_PREFIXES`，与浏览器略有不同：
   - 英文工作文件为“WP”；
   - 修正案区分“友好修正案 / 非友好修正案”“Friendly / Unfriendly Amendment”。

### 17.3 HTTP API（`backend/app/main.py`，`python backend/run.py` 在 127.0.0.1:8000 启动）

| 方法与路径 | 作用 | 成功响应 | 失败 |
|---|---|---|---|
| `GET /` | 本机页面 `local_web/index.html`（no-store） | HTML | — |
| `GET /app.js`、`/styles.css` | `public/local-app.js`、`public/local-styles.css` | JS / CSS | 503：“请先运行 pnpm build:local-tools，或使用包含离线界面的本机发布包。” |
| `GET /favicon.svg`、`/studio-tools.js` | 图标；保留的旧资源 | SVG / JS | `studio-tools.js` 缺失时 404 |
| `GET /api/health` | 健康检查 | `{"status":"ok","service":"pkunmun-2026-formatter","version":"1.8.5","pipelines":[六个 id]}` | — |
| `POST /api/parse/{type}` | 表单 `file` | 模型 JSON + `diagnostics` | 404 不支持的文种；415 非 .docx；413 超过 20 MB；422 文件无法读取；500 内部错误 |
| `POST /api/format/{type}` | 表单：`file`、`overrides_json`、`preserve_country_order`、`normalize_punctuation`、`session_label`、`submitting_country`、`version` | DOCX 二进制 | 409：`{"detail":{"message":"格式校验未通过，已中止输出。","validations":[…]}}`；422 / 500 同上 |

成功的 format 响应头：

- `Content-Disposition: attachment; filename*=UTF-8''{URL 编码的文件名}`；
- `X-PKUNMUN-Validation: {base64url(JSON 校验结果数组)}`。

`processing_failure` 的错误分类：

- XML 嵌套过深 → 422 “文件无法读取：XML 嵌套层级过深（超过 256 层）。”
- `InvalidDocxError` / `BadZipFile` / `XMLSyntaxError` → 422 “文件无法读取：…”
- `InvalidRequestError` → 422 “第 03 步提交的字段无效：…”
- `ProtectedContentError` → 422 “为保护原有内容已中止输出：…”
- 其他 → 500 “程序内部错误（不是文件本身的问题）…”

解析和排版放在线程池中运行（`run_in_threadpool`）。版本号读取 `VERSION` 文件。

**安全中间件**，按请求经过的先后（Starlette 中后注册的在外层）：

1. **`refuse_foreign_origins`**：带 Origin 头、发往 `/api/` 的 POST，Origin 不在 CORS 来源或本机页面来源（`http://127.0.0.1:8000` 等）中时，读请求体之前直接 403：“来源网页不在允许列表中，已拒绝请求。”
   - CORS 只能隐藏响应，挡不住别的网页让常驻引擎去解析上传，所以需要这一层。
   - 不带 Origin 的请求（CLI、脚本）不是浏览器请求，放行。
2. **`CORSMiddleware`**：
   - 允许的来源：`http://localhost:3000`、`http://127.0.0.1:3000` 和两个已发布的站点来源（见代码）；
   - 不带凭据；只允许 GET、POST；
   - 暴露 `Content-Disposition`、`X-PKUNMUN-Validation`。
3. **`TrustedHostMiddleware`**：Host 头只允许 `127.0.0.1`、`localhost`、`[::1]`（可带 `:8000`），防御 DNS 重绑定。
4. **`UploadLimitMiddleware`**：在 multipart 解析之前，把请求体限制在 21 MiB（`maxMultipartBytes`），读完后重放给后续处理。

### 17.4 Python 识别的差异

Python 的 `parser.py` 与浏览器逻辑基本相同，主要区别：

- **条款分类 `_classify_clause`**：

| 情况 | 结果 | 置信度 |
|---|---|---|
| 以序言动词开头 | preambulatory | 0.94 |
| 以行动动词开头 | operative | 0.94 |
| 工作文件，无前缀 | body | 0.72 |
| 指令草案、修正案，无前缀 | operative | 0.72 |
| 决议草案，主体句之后仍无前缀 | unknown | 0.35，并警告“第 N 段无法可靠判定条款类型，请确认。” |
| 其他 | body | 0.8 |

- 决议草案找到分界时，分界前后分别为序言 / 行动，置信度均为 0.98。
- 层级推断 `infer_level` 与浏览器 `inferLevel` 一致；`_numbering_semantic_level` 按原生级别定义换算层级。
- 警告文案不同：“未识别到起草国 / Sponsors。”“未识别到附议国 / Signatories。”“工作文件不应包含附议国；系统不会自动生成该字段。”

### 17.5 CLI（`backend/cli.py`）

```
python backend/cli.py <文件或文件夹> --type <文种> --output-dir <目录>
       [--diagnose-only] [--preserve-country-order] [--keep-punctuation] [--overwrite]
```

- 文件夹模式处理其中所有 `.docx`，跳过 Word 的锁文件 `~$*.docx`。
- 每份输入输出 `{名}_formatted.docx` 和 `{名}_diagnostics.json`（报告里有 `source_name`）。
- 不接受第 03 步覆盖，不联网，不安装任何东西。
- 写文件安全：
  - 先写临时文件，再用 `os.link` 原子地“不存在才创建”；`--overwrite` 时用 `replace`。
  - 绝不覆盖输入文件；同一次运行里两个输入不会写到同一个输出名（不分大小写）。
- 有 error 校验项时只写诊断报告，不写 DOCX，记为失败。
- 任一份失败时，退出码为 1。

## 18. 本机服务版（旧的 Python 本机安装）

这是桌面离线版出现之前的本机形态，仍保留在仓库中。页面和排版仍在浏览器里，Python 服务只负责在 8000 端口提供页面资源和兼容 API。

**macOS**：

- **`首次安装.command`**：用 osascript 弹出确认框（“将把 PKUNMUN 2026 文件排版系统安装到当前用户，并设置为登录后自动启动。DOCX 只在本机处理。”），然后运行 `scripts/setup.sh` → `scripts/install-service.sh`。
- **`install-service.sh`**：
  1. 检查发布包完整：有 app、backend、local_web、templates、public、shared 目录，有 `VERSION`，有非空的 `local-app.js` 和 `local-styles.css`。
  2. 寻找 Python 3.12+。
  3. 运行 `verify-local-build.py`。
  4. 在 `~/Library/Application Support/PKUNMUN2026Formatter/venv` 建虚拟环境；`requirements.txt` 的哈希变化时才重装依赖。
  5. 用 rsync 同步各目录。
  6. 用 `plutil` 生成 LaunchAgent `org.pkunmun.formatter.2026.local`：开机运行、保持存活、`ThrottleInterval` 60、日志写到 `backend.log`。
  7. `launchctl bootstrap` 加载，然后 `kickstart -k` 立即启动。
- **根目录 `PKUNMUN 2026 文件排版系统.app` 的启动脚本**：
  1. 安装版本与源码版本不同时，先运行 `install-service.sh` 自动更新。
  2. 用 curl 访问 `/api/health`，核对 service 和 version 都是自己的。
  3. 没有在运行时用 launchctl 启动或重启服务，最多等待 60 × 0.15 秒。
  4. 打开 `http://127.0.0.1:8000/?v={版本}`。
  5. 日志超过 5 MiB 时轮转为 `.old`。

**Windows**（PowerShell 5.1 兼容，`windows/*.ps1`）：

- **`Windows 首次安装.bat`** → `install.ps1`：
  1. 查找 Python 3.9+：依次尝试 `py -3`、`python`、`python3`，避开 Microsoft Store 的占位程序。
  2. 停止正在运行的旧引擎。
  3. 复制运行文件到 `%LOCALAPPDATA%\PKUNMUN2026Formatter`，并解除“来自网络”标记。
  4. 建 venv；pip 失败时改用清华镜像重试。
  5. 创建桌面和开始菜单快捷方式：打开、停止排版引擎、卸载。
- **`start.ps1`**：
  - 状态判断：ours / stale（版本不同，先停止）/ other（端口被别的程序占用）/ none。
  - 隐藏窗口启动 `run.py`，写入 PID 文件，最多等待 30 秒，然后打开页面。
  - 所有错误都用消息框提示，因为快捷方式是隐藏运行的，没有控制台。
- **`stop.ps1`**、**`uninstall.ps1`**：停止引擎、删除快捷方式和安装目录。

## 19. 桌面离线安装包（`desktop/`）

推荐给普通用户：

- 一个通用 DMG（macOS 10.11+，Apple 芯片和 Intel）；
- 一个通用 EXE（Windows 7–11，32/64 位和 ARM）。

运行时**完全在本机**：不联网、不需要 Python、不启动服务、不常驻后台。

### 19.1 构建链

```
pnpm build:desktop  =  node desktop/build-desktop.mjs --publish
  ├─ scripts/build-static.mjs
  │    ├─ scripts/build-local-tools.mjs
  │    │    ├─ esbuild local_web/main.tsx → public/local-app.js（IIFE、minify、es2022、
  │    │    │     NODE_ENV=production、NEXT_PUBLIC_API_URL=""）
  │    │    ├─ esbuild local_web/studio-tools.ts → public/studio-tools.js（保留的旧资源）
  │    │    ├─ PostCSS + @tailwindcss/postcss 编译 app/globals.css → public/local-styles.css
  │    │    ├─ 复制第三方许可证 → public/licenses/*.txt
  │    │    └─ 写 public/local-build.json：
  │    │         {schema:1, version, sources: {源码文件: sha256}, assets: {产物: sha256}}
  │    └─ 按白名单把 app.js、styles.css、favicon.svg、licenses/ 复制到 static-site/：
  │         逐个核对 sha256；index.html 给资源加 ?v=哈希；
  │         写 version.json 与 _headers（no-cache、nosniff、strict-origin-when-cross-origin）
  ├─ buildSite：核对 static-site/version.json 的版本与每个资源的哈希
  │    → dist/desktop/site/（index.html 用 offlineIndex 改写）
  ├─ buildMac → dist/desktop/PKUNMUN2026-Formatter-macOS.dmg
  ├─ buildWin → dist/desktop/PKUNMUN2026-Formatter-Windows-Setup.exe
  └─ --publish：复制到 downloads/，写 SHA256SUMS.txt
```

- `--only site|mac|win` 只构建一部分，不能和 `--publish` 同时使用。
- `--skip-static` 跳过静态构建。
- **来源校验**：
  - `scripts/verify-local-build.py` 核对 `local-build.json` 中的源码哈希（`local-build-policy.json` 规定范围：app/、local_web/、shared/、scripts/、public/ 以及若干配置文件）和产物哈希，防止产物陈旧或被篡改。
  - `build-local-tools` 构建结束时，若发现源码在构建过程中被改动，直接报错。
- **为什么锁定 Tailwind 的扫描范围**：Tailwind 4 默认扫描整个仓库（.gitignore 忽略的除外）来生成工具类，文档或脚本里的一个词就可能多生成一条 CSS，进而改变 `local-styles.css` 和安装包的字节。
  - 因此 `app/globals.css` 写作 `@import "tailwindcss" source(none);`，再用 `@source` 只列出界面文件（`app/**/*.tsx`、`local_web/*.tsx`）。
  - 改为锁定后，16 张界面截图（桌面与手机宽度，四个步骤，两份文档）与改动前逐像素相同。
  - 改动界面、引擎或共享规则后仍要重新运行 `pnpm build:desktop` 并提交新的安装包；CI 的逐字节复现检查会发现遗漏。

### 19.2 离线页面（`offlineIndex`）

在静态站的 `index.html` 上做五处改写：

1. `/favicon.svg`、`/styles.css?v=…` 改为相对路径，使页面能从 `file://` 打开。
2. `<script src="/app.js?v=…" defer>` 换成一段 **ES3 写的兼容加载器**：
   - 浏览器同时具备 `Array.prototype.findLast` 和 `window.CSSLayerBlockRule`（CSS 层叠层）时，才插入 `<script src="app.js">`。门槛约为 Chrome/Edge 99、Safari 15.4、Firefox 104。
   - 加载失败时显示“**程序文件不完整。** 请重新运行安装程序（macOS 请重新把程序拖进「应用程序」）。”
   - 浏览器太旧时显示一个白色说明框（最大宽 560px，圆角 12px）：

     > **这个浏览器版本太旧，无法运行排版系统。**
     > 请安装或更新以下任一浏览器，然后重新打开本程序（程序本身不联网，排版仍在本机完成）：
     > · Windows 10 / 11：Microsoft Edge 或 Google Chrome 最新版
     > · Windows 7 / 8.1：Google Chrome 109 或 Firefox ESR 115
     > · macOS 10.15 及以上：系统更新后的 Safari（15.4 或更高）
     > · macOS 10.11–10.14：Google Chrome 或 Firefox

   - 这样连 IE 也能显示说明，不会白屏或样式错乱。
3. `<noscript>` 文案改为“本机离线版与网页版使用同一界面”。
4. 在 `<meta charset>` 后插入 CSP：
   `connect-src 'none'; img-src file: data: blob:; font-src file: data: blob:; media-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`
   - 禁止 fetch / XHR / WebSocket、远程图片和字体、表单提交。
   - 脚本和样式保持浏览器默认，使 Safari、Chrome、Edge 加载方式一致。
5. 自检：
   - 仍有以 `/` 开头的绝对路径（`src="/…"`、`href="/…"`）就报错；
   - 缺少相对 CSS、加载器或 CSP 也报错。

### 19.3 单文件页面（`singleFilePage`，DMG 里的“直接用浏览器打开.html”）

**为什么需要**：从访达打开网页时，Safari 的沙盒只允许它读取所在文件夹；从“应用程序”加载资源的跳转页，复制到桌面后在 Safari 里会失效（macOS 15 + Safari 26.6.1 实测）。

**做法**：

- `styles.css` 内联进 `<style>`。CSS 中若出现 `</style` 就报错。
- `app.js` 以 JSON 字符串字面量形式放进 `window.__munwordApp`：
  - `<` 转义为 `<`，U+2028 / U+2029 也转义，保证 HTML 解析器不会提前结束 script。
- 加载器把 `script.src = "app.js"` 改为 `script.text = window.__munwordApp; window.__munwordApp = null;`。
- 图标改为 `data:` URI。
- 自检：除了 data: URI，不能再引用任何文件。

**结果**：一个自包含文件，复制到任何位置，用任何浏览器都能打开；不运行程序，所以不需要 Gatekeeper 授权。

### 19.4 macOS 应用与 DMG

**包结构**（文件夹名用 ASCII，Finder 通过本地化显示中文名）：

```
PKUNMUN2026.app/Contents/
  Info.plist            CFBundleExecutable=PKUNMUN2026，Identifier=org.pkunmun.formatter.2026.desktop，
                        LSMinimumSystemVersion=10.11，LSUIElement=true（不在程序坞常驻），
                        LSHasLocalizedDisplayName，版本号由 VERSION 替换
  PkgInfo               "APPL????"
  MacOS/PKUNMUN2026     通用二进制（arm64 + x86_64），由 launcher-stub.c 编译
  Resources/launcher.sh 真正的启动逻辑（bash 3.2 兼容，也能在 zsh 下运行）
  Resources/AppIcon.icns
  Resources/{Base,en,zh-Hans,zh_CN}.lproj/InfoPlist.strings   显示名“PKUNMUN 2026 文件排版系统”
  Resources/site/       离线页面（19.2 节）
  _CodeSignature/       签名封存全部资源
```

**原生入口 `launcher-stub.c`**：

- 用 `_NSGetExecutablePath` 求出 `…/Contents/MacOS/../Resources/launcher.sh`，依次 `execv("/bin/bash")`、`execv("/bin/zsh")`。
- 为什么需要它：入口若是脚本，Apple 芯片会把程序当成 Intel 程序，没装 Rosetta 的 Mac 会先要求安装 Rosetta。
- `desktop/macos/build-stub.sh` 负责编译：x86_64 部分的最低系统为 10.11。

**`launcher.sh`**：

1. 页面不存在 → 弹窗“程序文件不完整，请重新下载并安装。”
2. 把页面路径逐字节百分号编码成 `file://` URL：用 `od` 逐字节处理，与语言环境无关；只保留未保留字符和 `/`。这样含空格、中文的路径也能打开。
3. 依次在 `/Applications` 和 `~/Applications` 中寻找 Chrome、Edge、Brave、Vivaldi、Chromium。找到就 `open -na <浏览器> --args --app=<URL>`，以独立窗口打开，然后退出。
4. 否则检查 Safari 版本（读 `Safari.app/Contents/Info` 的 `CFBundleShortVersionString`；读不到按新版处理）：
   - ≥ 15.4 → `open -a Safari <页面>`；
   - 过旧 → 优先用 Firefox；没有 Firefox 才用旧 Safari 打开（页面会说明该升级什么）。
5. 最后交给默认程序 `open <页面>`。也失败时弹窗“没有找到可用的浏览器。请安装或更新 Safari、Chrome、Edge 或 Firefox 后重试。”
6. 测试钩子：`MUNWORD_OPEN`、`MUNWORD_DEFAULTS`、`MUNWORD_APPLICATIONS`、`MUNWORD_ALERT`，正常使用时不设置。

**签名**：

- 默认对整个 `.app` 做 ad-hoc 签名：macOS 上 `codesign --force --sign - --timestamp=none`，Linux 上 `rcodesign sign`。
  - Apple 芯片只运行已签名的原生代码；签名没有覆盖资源的程序会被报告为“已损坏”。
  - ad-hoc 签名没有开发者身份，所以第一次打开时仍会出现 macOS 对网上下载程序的常规确认。
- 有证书时：
  - macOS：`MUNWORD_MAC_SIGN_IDENTITY`（开启 hardened runtime 和时间戳）；
  - Linux：`MUNWORD_MAC_P12` + `MUNWORD_MAC_P12_PASSWORD_FILE`；
  - 公证：`MUNWORD_NOTARY_PROFILE`（notarytool），或 `MUNWORD_NOTARY_API_KEY`（rcodesign notary-submit --staple）。

**DMG**：

- 卷名“PKUNMUN 2026”；HFS+；zlib 9 级压缩（UDZO），macOS 10.11 起都能直接打开。
- 内容：
  - `PKUNMUN2026.app`；
  - 指向 `/Applications` 的符号链接 `Applications`；
  - `直接用浏览器打开.html`；
  - `安装说明.txt`；
  - `.DS_Store`（窗口布局）。
- 窗口布局（`make-dmg-layout.py`）：图标 112px；程序在左 (170,170)，Applications 在右 (470,170)；网页在 (170,345)，说明在 (470,345)。
- macOS 上用 `hdiutil create -fs HFS+ -format UDZO -imagekey zlib-level=9`。
- Linux 上：
  1. 按内容估算镜像大小；
  2. `mkfs.hfsplus` 建卷；
  3. 把卷标识写成由版本号派生的固定值（`pinVolumeId`，写入主卷头和备份卷头偏移 104 处）；
  4. 打过补丁的 `hfsplus addall` 写入文件，然后在镜像中查找“安装说明.txt”的 UTF-16BE 目录键，确认中文名写对；
  5. `dmg build` 压缩。
- **libdmg-hfsplus 补丁**（`desktop/macos/libdmg-hfsplus.patch`，基于上游提交 ec239599）修两处：
  - 上游逐字节复制文件名，中文名在 Finder 中会成乱码；
  - 上游按目录读取顺序写入，在不同文件系统上做出的镜像字节不同。

### 19.5 Windows 安装程序（NSIS）

**`installer.nsi`**：

- 基本设置：
  - `Unicode true`、`RequestExecutionLevel user`：按当前用户安装，没有 UAC 提示；
  - 声明支持高 DPI（PerMonitorV2）；
  - LZMA 固实压缩。
- 安装目录：`%LOCALAPPDATA%\Programs\PKUNMUN2026Formatter`。
- 页面（简体中文 MUI2），左侧有侧边图 `sidebar.bmp`：
  1. **欢迎页**：标题“安装 PKUNMUN 2026 文件排版系统”。正文说明不需要管理员权限、不需要 Python、不联网、不上传、版本号和“安装只需几秒”。按钮文字改为“安装”，一键直接安装。
  2. **安装进度页**。
  3. **完成页**：标题“安装完成”，“以后双击桌面上的「PKUNMUN 2026 文件排版系统」即可打开。生成的 DOCX 会保存到「下载」文件夹。”
     - 选项“立即打开”默认勾选；“查看使用说明”默认不勾。
     - 若 `FindBrowser` 找不到够新的浏览器，正文改为“注意：这台电脑上没有新版 Edge、Chrome 或 Firefox，请先安装其中一个再打开本程序。Windows 7 / 8.1 可用 Chrome 109 或 Firefox ESR 115。”
- 安装过程：
  1. 安装路径超过 200 字符时报错退出（错误码 2），给最深的 `site\licenses\…` 留出 260 字符路径上限的余量。
  2. 先删除旧的 `site\`，再写入新文件：`site\`、`PKUNMUN2026Formatter.exe`、`app.ico`、`使用说明.txt`（UTF-8 BOM + CRLF，方便记事本阅读）、`uninstall.exe`。
  3. 创建桌面和开始菜单快捷方式，指向启动器。
  4. 在 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\PKUNMUN2026Formatter` 登记 DisplayName、DisplayVersion、Publisher、DisplayIcon、InstallLocation、UninstallString、QuietUninstallString、NoModify、NoRepair、EstimatedSize。
- 支持 `/S` 静默安装；卸载会删除上述全部文件、快捷方式和注册表项。
- 版本资源：`VIProductVersion` 为 x.y.z.0，语言 2052（简体中文）。

**启动器 `launcher.nsi` → `PKUNMUN2026Formatter.exe`**（静默运行的 32 位 NSIS 小程序）：

1. `site\index.html` 不存在 → 消息框“程序文件不完整，请重新运行安装程序。”
2. 构造 `file:///` URL：`%` → `%25`，`\` → `/`，空格 → `%20`，`#` → `%23`。中文用户名由浏览器自行编码。
3. `FindBrowser` 找到浏览器后：
   - Chromium 系：`--app="URL" --no-first-run --no-default-browser-check`，打开独立窗口，且不弹欢迎页；
   - Firefox：`-new-window "URL"`；
   - 成功后退出码设为 0（NSIS 的 `Quit` 默认返回 2）。
4. 否则 `ExecShell open` 交给默认浏览器。再失败时提示安装 Edge / Chrome / Firefox，Win7 / 8.1 可用 Chrome 109 / Firefox ESR 115。

**`browsers.nsh:FindBrowser`** → `$Browser`（路径）、`$BrowserKind`（chromium / firefox）、`$BrowserCurrent`（1 表示够新）：

1. **默认浏览器**：读 `HKCU\…\UrlAssociations\http\UserChoice` 的 ProgId，再依次在 HKCU、HKLM、HKCR 中读它的 `shell\open\command`，解析出 exe（支持带引号和不带引号）。
   - 只接受 msedge、chrome、brave、vivaldi、firefox。
2. **App Paths**：64 位系统先看 64 位注册表视图，再看 32 位视图。顺序：msedge、chrome、brave、vivaldi、firefox。
3. **常见安装目录**：Program Files（32/64）和 LocalAppData 下的 Edge、Chrome、Brave、Vivaldi、Chromium、Firefox。
4. **版本判断**：用 `GetDLLVersion` 读取 exe 的主版本号。
   - Edge / Chrome / Chromium 需要 ≥ 99，Firefox 需要 ≥ 104；Brave、Vivaldi 的版本号独立编排，不判断。
   - 太旧的浏览器只在别无选择时使用，页面会说明该更新什么。

### 19.6 可复现构建

- **时间戳**：所有文件时间固定为最近一次修改 `VERSION` 的提交时间（`git log -1 --format=%ct -- VERSION`，可用 `SOURCE_DATE_EPOCH` 覆盖）。
- **Linux DMG**：libfaketime 固定卷内时间，`TZ=UTC`；卷标识由版本号派生；目录按名称排序（补丁）。
- **结果**：同一份源码在任何 Linux 机器上都做出字节相同的安装包。
  - CI 每次都重建，并与 `downloads/SHA256SUMS.txt` 逐字节比对。
  - 签名过的安装包带签名时间，不再可复现。
- **版本号变化后**，`tests/desktop.test.mjs` 会要求重新运行 `pnpm build:desktop`。

**构建工具**：

| 产物 | macOS 上 | Linux 上 |
|---|---|---|
| DMG | 系统自带 `codesign`、`hdiutil` | `rcodesign`（`cargo install apple-codesign --version 0.29.0 --locked`，`RCODESIGN=`）、`mkfs.hfsplus`（apt hfsprogs）、打过补丁的 libdmg-hfsplus（`HFSPLUS_TOOL=`、`DMG_TOOL=`）、libfaketime（apt faketime） |
| EXE | `brew install makensis` | `apt install nsis`；脚本自动设 `LC_ALL=C.UTF-8`，否则 makensis 遇到中文文件名会崩溃 |
| Windows 签名（可选） | — | `osslsigncode`，`MUNWORD_WIN_PFX` + `MUNWORD_WIN_PFX_PASSWORD_FILE`，可选 `MUNWORD_WIN_TIMESTAMP_URL`；签名启动器、安装程序和卸载程序 |

**图标与布局的再生成**：

- `node desktop/icons/make-icons.mjs`：用 Playwright 和 ImageMagick 生成 AppIcon.icns 与 sidebar.bmp。图标是白色圆角方块上的四块蓝色拼贴（`#68C4FF`、`#0C79D8`、`#2E9EFF`），与 favicon 一致。
- `python3 desktop/macos/make-dmg-layout.py`：重新生成 DMG 窗口布局，需要 pip 包 ds_store。
- `desktop/macos/build-stub.sh`：重新编译启动器存根。

## 20. 安卓安装包（`android/`）

APK 约 0.4 MB：包名 `org.pkunmun.formatter2026`，桌面名称「PKUNMUN 排版」，`minSdk` 21（Android 5.0），`targetSdk` 34，versionName = `VERSION`，versionCode = 主×10000 + 次×100 + 修订（1.8.5 → 10805）。

### 20.1 组成

| 文件 | 内容 |
|---|---|
| `AndroidManifest.xml` | 唯一权限 `WRITE_EXTERNAL_STORAGE`（`maxSdkVersion="28"`），**没有 `INTERNET`**；`<queries>` 声明“VIEW + DOCX”（Android 11+ 才能看到 WPS / Word 等）；`allowBackup=false`；WebView 元数据 `MetricsOptOut=true`、`EnableSafeBrowsing=false`；`MainActivity`（`exported=true`，`singleTask`，`configChanges` 含方向、屏幕尺寸、键盘、uiMode、字号，`adjustResize`），`MAIN/LAUNCHER` 与两个接收 DOCX MIME 的过滤器（`VIEW`、`SEND`）；`SavedFiles` 提供者（`exported=false`，`grantUriPermissions=true`） |
| `res/` | 主题 `Theme.Material.Light.NoActionBar`：窗口背景与页面同色 `#EDF5FA`；Android 5 状态栏用深蓝（只能显示白色图标），6+ 用页面色加深色图标（`values-v23`）；自适应图标（背景渐变 + 矢量四方块，`mipmap-anydpi-v26`），旧版 48dp PNG 五种密度（`make-icons.mjs` 用 Chromium 渲染） |
| `src/…/MainActivity.java` | 见 20.2 |
| `src/…/SavedFiles.java` | 只读 `ContentProvider`：`content://org.pkunmun.formatter2026.files/{downloads|app}/<文件名>` → 公共 Download 或应用自己的 `files/Download`（规范化路径后必须正好在该目录下）；`…/media/<id>/<文件名>` → 本应用的 MediaStore 条目 `content://media/external/downloads/<id>`（转读，不把 MediaStore 地址交给别的应用）；`query` 只答 `DISPLAY_NAME`、`SIZE`；`openFile` 只允许 `"r"` |
| `stubs/android/webkit/RenderProcessGoneDetail.java` | API 26 类的编译期替身，只在 javac 的 classpath 上，不打包 |
| `bridge.js` | 页面一侧的桥，ES5，内联进 `index.html`（见 20.3） |
| `polyfills.js`、`flex-gap.js`、`build-site.mjs` | 手机版页面（见 20.4） |
| `build-apk.mjs`、`signing-cert.sha256` | 打包与签名（见 20.5） |
| `acceptance/` | `verify-apk.mjs`、`webview-floor.mjs`、`emulator.mjs`、`cdp.mjs`（见 20.6） |

### 20.2 `MainActivity`

- **WebView 设置**：JavaScript 开、DOM storage 开、`setAllowFileAccess(false)`（`file:///android_asset/` 不受影响）、内容访问开、不缩放、`textZoom` = 系统字号 × 100（字号变化时在 `onConfigurationChanged` 里更新）；背景 `#EDF5FA`；`addJavascriptInterface(new Bridge(), "MunwordAndroid")`；载入 `file:///android_asset/site/index.html`。
- **只加载自己的文件**：`shouldOverrideUrlLoading` 拒绝一切不以 `file:///android_asset/site/` 开头的导航；`shouldInterceptRequest` 对其他地址（`data:`、`blob:` 除外）返回空响应并记日志。`DownloadListener` 只提示“请重新点击下载按钮”（正常的下载都被桥拦截）。
- **远程调试**：启动时执行 `getprop debug.munword.devtools`，等于 `1` 才 `setWebContentsDebuggingEnabled(true)`；只能从 adb 设置。
- **桥 `MunwordAndroid`**（在 WebView 的 JavaBridge 线程上调用，共享状态加锁）：
  - `begin(name, mime, size) → id`：文件名净化（去掉 `\ / : * ? " < > |` 和控制字符、去掉开头的点、超过 120 字符时截断并保留扩展名，空则 `PKUNMUN2026.docx`）；`size` 超过 200 MB 拒绝；在 `cache/saving/` 建临时文件；
  - `append(id, base64)`：解码写入，出错只记下，`finish` 时报告；
  - `finish(id)`：关闭、核对写入字节数等于 `size`，回到主线程保存；
  - `failed(name, message)`：页面读 Blob 失败时调用，弹出“保存失败”；
  - `openedName()`、`openedSize()`、`openedChunk(offset, length)`（base64，`NO_WRAP`，每次最多 786432 字节）、`openedDone()`（清除）。
- **保存**（后台线程，完成后弹窗）：
  - API 29+：`ContentResolver.insert("content://media/external/downloads", {DISPLAY_NAME, MIME_TYPE, relative_path="Download/", is_pending=1})`，写入后 `is_pending=0`，失败删除该条目；回读系统实际的文件名（重名时系统改名）。
  - API 23–28：没有权限时把任务排队并 `requestPermissions`；允许 → 公共 Download（重名加 “ (1)”、“ (2)”），`MediaScannerConnection.scanFile`；拒绝 → 应用自己的 `files/Download`。
  - API 21–22：直接写公共 Download。
  - 弹窗：标题“已保存”，正文“文件：<名称>\n位置：<位置>。”（DOCX 另加“可以用 WPS Office 或 Microsoft Word 打开。”），按钮「打开」（`ACTION_VIEW` + 读授权；`queryIntentActivities` 后去掉本应用——它自己也接收 DOCX——剩一个就直接打开，多个用 `createChooser` + `EXTRA_INITIAL_INTENTS`，没有就说明安装 WPS / Word；Android 11+ 需要清单里对“VIEW + DOCX”的 `<queries>`）、「分享」（`ACTION_SEND` + `ClipData` + 读授权，系统分享面板，`EXTRA_EXCLUDE_COMPONENTS` 去掉本应用）、「完成」。两者都用 `SavedFiles` 地址（API 29+ 为 `media/<id>/<名称>`），`ActivityNotFoundException` 与 `SecurityException` 都转成提示，不会闪退。
- **选择文件**：`onShowFileChooser` → `ACTION_GET_CONTENT`、`CATEGORY_OPENABLE`、`*/*`，`EXTRA_MIME_TYPES` = DOCX、`application/octet-stream`、`application/zip`；找不到时退到 `ACTION_OPEN_DOCUMENT`；取消时回调 `null`（必须回调，否则输入框不再响应）。
- **打开方式 / 分享传入**：`onCreate` 与 `onNewIntent` 读取 `VIEW` 的 data 或 `SEND` 的 `EXTRA_STREAM`，处理后把 intent 改成 `MAIN`，回到应用时不再重复传入。`file://` 地址在 API 23–28 先请求存储权限。后台线程读 `DISPLAY_NAME` / `SIZE`，超过 25 MB 拒绝，读入内存；页面就绪（`onPageFinished`）后 `evaluateJavascript("window.__munwordReceive && window.__munwordReceive()")`。
- **生命周期**：返回键 `moveTaskToBack(true)`（保留进度）；`onPause/onResume` 转给 WebView；`onRenderProcessGone`（API 26+）销毁并重建 WebView，提示“页面意外关闭，已重新打开”，返回 `true`；Android 8.1+ 白色导航栏与深色按钮（标志位 `0x10`）。

### 20.3 `bridge.js`（页面一侧）

没有 `window.MunwordAndroid` 时什么也不做（同一份页面在桌面 Chromium 里测试时由测试注入替身）。

- 包装 `URL.createObjectURL` / `revokeObjectURL`，记住每个 Blob 地址对应的 Blob。
- 覆盖 `HTMLAnchorElement.prototype.click`：带 `download` 属性、地址是记住的 Blob 时，`FileReader.readAsDataURL` 读出，取逗号后的 base64，按 1048576 字符一块调用 `begin` / `append` / `finish`；读失败调用 `failed`。其他链接照常点击。
- `window.__munwordReceive()`：按 786432 字节一块（3 的倍数，块间没有填充）读回、`atob` 成 `Uint8Array`，调用 `openedDone()`，构造 `File`（DOCX MIME），记为 `held` 并交付。
- 交付：等页面的 `input[type=file]` 出现（每 100 ms，最多 10 秒），`new DataTransfer()` 放入文件，赋给 `input.files`。Chromium 69 等旧版本赋值时自己会派发真实的 `change` 事件，新版本不会：交付期间捕获阶段的监听器记下是否已有 `change`，没有才补派一个。
- 保留：页面在点选文书类型时会清空文件（先选类型、后选文件的设计），而传入的文件先于类型到达。点击 `.typeCard` 后等 `.dropzone.hasFile` 消失（每 50 ms，最多 3 秒）再交付一次 `held`。用户自己选了文件（交付之外的可信 `change` 事件）时清除 `held`。

### 20.4 手机版页面（`build-site.mjs` → `dist/android/site/`）

- 先核对 `public/local-build.json` 的版本和 `public/local-styles.css` 的哈希（需要先运行 `pnpm build:local-tools`）。
- `app.js` = `polyfills.js` + `flex-gap.js`（其中占位符 `/*AUTO_MARGIN_SELECTORS*/[]` 替换为样式表里外边距为 `auto` 的选择器列表）+ esbuild 打包 `local_web/main.tsx`（`target: chrome69`、`format: iife`、`minify`、`jsx: automatic`，`process.env.NODE_ENV="production"`、`NEXT_PUBLIC_API_URL=""`）。
- `styles.css` = `legacyCss(public/local-styles.css)`：
  1. `@layer` 原地展开；
  2. 选择器列表里含 `:where(`、`:is(`、`::file-selector-button`、`::backdrop`、`:focus-visible`、`::marker`、`:has(` 的规则拆成每个选择器一条（关键帧里的除外）；
  3. 单值 `inset` 前加 `top/right/bottom/left`；`margin-inline` / `padding-inline` 前加左右两条；`clamp(a, …)` 前加 `a`；`min()` / `max()` 前加最后一个参数；`overflow-wrap: anywhere` 前加 `word-wrap: break-word`；
  4. `justify-content` / `align-items` / `align-self` / `align-content` 的 `start` / `end` 改成 `flex-start` / `flex-end`（样式表里出现 `reverse` 方向时构建报错）。
- `flex-gap.js`：只在 `<html>` 有 `no-flex-gap` 类时运行。`MutationObserver`（子节点、文字、`class` / `open` / `hidden` 属性）和窗口尺寸变化触发，`requestAnimationFrame` 合并。每次先撤销上次设置的行内外边距，再遍历所有 `display: flex / inline-flex` 且 `row-gap` / `column-gap` 非零的元素：子项为非空文字节点或非 `display:none`、非绝对 / 固定定位的元素；从第二项起，元素在主轴起始边加间距，文字节点则给它前面的元素在主轴末端加间距；换行容器给每个元素加交叉轴末端间距，容器本身减去同样的值。先全部读完计算样式再统一写入；匹配“外边距为 auto”的选择器的元素跳过。
- `index.html`：`<html lang="zh-CN">`；CSP `connect-src 'none'; img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`；视口、标题、图标、`styles.css`；`#root` 占位“正在加载 PKUNMUN 2026 排版系统…”；内联 `bridge.js`；ES5 加载器：
  1. 探测 flex gap：绝对定位的纵向 flex 容器、`row-gap:1px`、两个空子元素，`scrollHeight !== 1` 时给 `<html>` 加 `no-flex-gap`；
  2. `[].flat`、`CSS.supports("display","grid")`、`TextDecoder` 都有 → 加载 `app.js`（加载失败显示“程序文件不完整。请重新安装本应用。”）；
  3. 否则显示“手机的网页组件（WebView）版本太旧，无法运行排版系统。”、当前版本号与“需要 69 或更高”、更新「Android System WebView」（或「系统 WebView」「Chrome」「浏览器内核」）的办法，以及改用网页版或电脑版。
- 另复制 `favicon.svg`、`licenses/`，写 `version.json`（`kind: "android"`、`target: "chrome69"`、各文件哈希）。
- 在当前 Chromium 中，手机版页面与桌面页面的 16 张截图（桌面与手机宽度、四个步骤、两份文档）逐像素相同。

### 20.5 打包与签名（`build-apk.mjs`）

1. 生成手机版页面（`--skip-site` 跳过），复制到 `dist/android/build/assets/site/`。
2. `aapt2 compile --no-crunch --dir android/res` → `aapt2 link -I android.jar(API 23) --manifest … --min-sdk-version 21 --target-sdk-version 34 --version-code … --version-name … -A assets`。
3. `javac -source 8 -target 8 -bootclasspath android.jar`：先编译替身到单独目录，再以它为 classpath 编译 `src/`（`-Xlint:all -Werror -implicit:none`）；代码不用 lambda。
4. `dalvik-exchange --dex --min-sdk-version=21`，在 classes 目录里按排序后的相对路径传入。
5. 自己写 ZIP：顺序为 `AndroidManifest.xml`、`classes.dex`、`resources.arsc`、`res/…`、`assets/…`（各组内按名称），全部日期 2008-01-01 00:00，无扩展字段，`resources.arsc` 与 PNG 不压缩，其余 DEFLATE 9。
6. `zipalign -f -p 4`，再 `zipalign -c` 检查 → `PKUNMUN2026-Formatter-Android-unsigned.apk`。
7. 有密钥（`MUNWORD_ANDROID_KEYSTORE`、`…_KEYSTORE_PASSWORD`、`…_KEY_ALIAS`，可选 `…_KEY_PASSWORD`）时 `apksigner sign --min-sdk-version 21`，v1 + v2 + v3；`apksigner verify --print-certs` 必须三种方案都通过，证书 SHA-256 必须等于 `android/signing-cert.sha256`。
8. `--publish`：复制到 `downloads/`，`SHA256SUMS.txt` 只替换 APK 一行（其余行保留，按文件名排序；`desktop/build-desktop.mjs --publish` 同样只替换自己的两行）。

签名密钥（PKCS12，RSA 3072，SHA256withRSA，有效期 100 年，别名 `munword`）不进仓库。之后的版本必须用同一把密钥签名，用户才能覆盖安装。

### 20.6 验收

- `tests/android.test.mjs`（`node --test`，CI 的 source-checks 单独一步；不进 `test:unit`，因为 `package.json` 的哈希记录在桌面安装包的构建记录里，改它会改变 DMG / EXE）：`legacyCss` 各项降级；在去掉新内置函数的 `vm` 环境里加载 `polyfills.js` 后行为与原生一致、不可枚举；`bridge.js` 与加载器能按 ES5 解析；清单（无联网、存储到 28、导出设置、接收 DOCX）；`MainActivity` 关闭文件访问、调试受 adb 属性控制、没有 lambda；校验值行的更新规则；已发布 APK 的校验值、条目和版本。
- `acceptance/verify-apk.mjs`：从源码重建未签名 APK，与发布 APK 去掉 v1 签名文件后的全部条目逐字节比较；v1/v2/v3 签名与证书固定值；`aapt dump badging` 读回包名、版本、`sdkVersion:'21'`、`targetSdkVersion:'34'`、权限只有存储（≤28）、桌面名称；`SHA256SUMS.txt` 与安装教程含 APK 校验值。写 `apk.json`。
- `acceptance/webview-floor.mjs`：下载 Chromium 快照 67、69、79、83、88、95、99、109（位置号见脚本）加当前 Chromium，以 390×844 手机视口打开手机版页面并注入桥的替身。67 必须显示 WebView 说明且不加载 `app.js`；其余对 11 份原稿：先经 `__munwordReceive` 传入文件，再点选文书类型，确认文件仍在，识别、确认第 03 步可编辑、生成，替身收到的字节数正确，DOCX 与共享页面在当前 Chromium 中的输出（`output/desktop-smoke/`）逐部件相同。写 `webview-floor.json`。
- `acceptance/emulator.mjs`：一台 adb 设备上安装发布的 APK（不带 `-g`），`setprop debug.munword.devtools 1`，经 `/proc/net/unix` 找到 `webview_devtools_remote_<pid>` 并转发，用 DevTools 驱动页面，用 `uiautomator dump` 找原生弹窗按钮并 `input tap`，`adb pull` 读回 Download 里的文件。检查项见 `android/README.md`；写 `emulator.json`、截图和 logcat。

## 21. 网页部署

**`pnpm build:static` → `static-site/`**：

- 文件全部来自白名单：页面、共用 JS/CSS、图标、许可证、`version.json`、`_headers`。
- 不包含源码、Python API、原稿、`.env` 或托管配置。

**Cloudflare Pages**（入口 `munword-formatter.pages.dev`）：

- Git 导入：仓库 `lsyl71271-lgtm/munword-formatter`、生产分支 `main`、框架预设“无”、根目录 `/`；
- 构建命令 `pnpm build:static`，输出目录 `static-site`；
- 推送 main 后自动更新。

**Cloudflare Workers 静态资源**：

- `wrangler.static.json`（name `munword-formatter`，assets 目录 `./static-site`）；
- 部署命令 `pnpm deploy:cloudflare`，即 `wrangler deploy --config wrangler.static.json`。

**开发模式**：

- `pnpm dev` / `build` / `start` 经 `scripts/run-web.mjs` 调用 vinext；
- `worker/index.ts` 是 vinext 的 Worker 入口，带图片优化端点 `/_vinext/image`；
- D1 / Drizzle 和 `app/chatgpt-auth.ts` 是保留的脚手架，不是产品功能。
- 首次需要 `cp .openai/hosting.example.json .openai/hosting.json`。

**连通性**：大陆不同运营商对 `workers.dev` 的连通性需要实测，不能承诺所有网络都可达。

## 22. 发布与持续集成

### 22.0 `.github/workflows/source-checks.yml`

每次推送和每个 PR 都运行，ubuntu-24.04，Node 24、pnpm 11.19.0、Python 3.12：

1. `pnpm install --frozen-lockfile`，安装 `backend/requirements.txt`，复制 `.openai/hosting.example.json`；
2. `pnpm build:static`（同时生成共用离线资产）；
3. `pnpm test:unit`、Python `unittest`、`pnpm build`、`rendered-html`、`pnpm test:static`；
4. `pnpm typecheck`、`pnpm lint`、`scripts/audit-source.py`。

### 22.1 `.github/workflows/offline-installers.yml`

- **触发**：推送中改动了 `desktop/**`、`android/**`、`downloads/**`、`VERSION`、工作流本身，或页面的来源（`app/**`、`local_web/**`、`shared/**`、`public/**`、`package.json`、`pnpm-lock.yaml`、`postcss.config.mjs`、`scripts/build-local-tools.mjs`、`scripts/build-static.mjs`）；或手动触发。
- **作业**：

| 作业 | 机器 | 内容 |
|---|---|---|
| reproduce | ubuntu-24.04 | 安装 NSIS、hfsprogs、faketime、zsh；编译带补丁的 libdmg-hfsplus；安装 rcodesign；用 bash 和 zsh 跑 `tests/desktop.test.mjs`；重建两个安装包，与 `SHA256SUMS.txt` 中 DMG、EXE 两行逐字节比对；Playwright Chromium 从 `file://` 跑全部验收原稿（`offline-smoke.mjs`）；最低浏览器检查（`browser-floor.mjs`）：Chromium 98 必须看到说明，99 和 109 必须完整跑通 |
| wine | ubuntu-24.04 | 32 位 Windows 7 与 64 位 Windows 10 两个 Wine 前缀，31 项场景：静默安装、11 种浏览器组合、含空格/中文/#/% 的路径、卸载（`acceptance/wine/scenarios.sh`） |
| windows | windows-2022、windows-11-arm | 先装 1.8.4 再升级；检查快捷方式和卸载项；启动器真的拉起浏览器独立窗口、URL 转义正确；系统自带的 Edge / Chrome / Firefox 跑全部原稿和模板；卸载（`acceptance/windows.py`，Selenium） |
| macos | macos-14、macos-15、macos-15-intel | `hdiutil verify`；中文文件名；`codesign --verify --deep --strict`；记录 Gatekeeper 判定；原生运行入口；LaunchServices 真实打开；Chrome / Firefox 跑全部原稿和模板，再跑复制到桌面的单文件页面；Safari 经本机 http 跑全流程；Safari 像用户那样从访达打开程序、DMG 里的网页和复制到桌面的网页，并通过辅助功能（pyobjc AX 树）读取 Safari 实际显示的内容（`acceptance/macos.py`） |
| android | ubuntu-24.04 | 从 Ubuntu 安装 aapt、dalvik-exchange、zipalign、apksigner、libandroid-23-java、openjdk-21-jdk-headless；`build-desktop.mjs --only site`；`verify-apk.mjs`；Playwright Chromium 跑共享页面得到参考输出（`offline-smoke.mjs`）；`webview-floor.mjs`（第 20.6 节） |
| android-devices | ubuntu-24.04 ×10 | 开启 KVM；`reactivecircus/android-emulator-runner@v2`（`google_apis`、x86_64、关闭动画、无快照），API 21、23、26、28、29、30、31、33、34、35，各用镜像自带的 WebView；`emulator.mjs` 测发布的 APK，参考输出来自 android 作业 |
| release | ubuntu-24.04 | 仅在以上全部通过，且是 main / 开发分支推送或手动触发时运行，见下 |

**浏览器全流程**（`acceptance/browser_flow.py`）：

- 驱动机器上真实安装的浏览器，不是测试工具自带的浏览器。
- 原稿通过 DataTransfer 交给页面，因为各浏览器的文件选择框无法统一自动化。
- 成品从下载链接背后的 Blob 读回。
- 第 03 步只验证“可编辑”，不代填。

**为什么 Safari 走 http**：Safari 26 的 safaridriver 拒绝打开任何 `file://` 网页（“outside the sandbox”）。所以 file:// 这条用户路径另由 LaunchServices 打开，再用辅助功能读回来验证。

**release 作业**：

1. 下载全部构建产物。
2. 运行 `desktop/acceptance/stage_release.py`：任何一项没有通过就拒绝发布。通过后生成：
   - 三个安装包（DMG、EXE、APK；`stage_release.py` 另要求 APK 校验报告、手机版页面的 Chromium 检查和十个模拟器报告全部通过）；
   - `PKUNMUN2026-Install-Guide.txt`（下载页显示名“安装教程（先看这个）.txt”）；
   - `SHA256SUMS.txt`；
   - `PKUNMUN2026-{版本}-Verification.zip`（全部报告、日志和截图）；
   - 发布说明 `notes.md`。
3. 发布到 tag `v{VERSION}-desktop.2`，标题“v{版本} · 离线安装包（macOS DMG、Windows EXE、Android APK；兼容 macOS 10.11、Windows 7、Android 5.0 起）”，标为 Latest。
   - 同名 release 已存在且校验和相同 → 只替换附件、更新说明；
   - 校验和不同 → 删除旧 release 和 tag 后重建，让 tag 指向通过验证的提交。
4. 需要 `GH_REPO` 环境变量，因为该步骤在 checkout 目录之外运行，gh 无法从 git 读取仓库。

### 22.2 其他发布方式

- **源码包**：`python scripts/package-release.py --output <zip> [--desktop]`：
  - 先运行 `audit-source.py`（扫描密钥、令牌、个人路径、邮箱）；
  - 拒绝未跟踪文件和未暂存的修改；
  - 内容取自 git 索引；`--desktop` 另外附带离线界面产物并校验来源；
  - 固定时间戳 2026-01-01，保留 git 文件权限；
  - 写入 `PACKAGE-MANIFEST.json`，回读 CRC 和哈希，原子地“不存在才创建”。
- **视觉验收（可选）**：`deploy/visual-qa.compose.yaml` 启动 Gotenberg，`scripts/visual-qa.py` 把成稿转成 PDF 后量行距。

## 23. 测试体系

**命令**：

```
pnpm install --frozen-lockfile
pnpm test:unit            # Node 单元与回归测试（下表）
pnpm test                 # test:unit + pnpm build + rendered-html
pnpm typecheck && pnpm lint
pnpm test:static          # 静态站白名单与无 API 全流程
pnpm test:desktop         # 桌面单元测试 + 离线冒烟
python -m unittest discover -s backend/tests -v
python scripts/audit-source.py
```

**Node 测试**（`tests/*.test.mjs`，用 jsdom 提供 DOMParser）：

| 文件 | 覆盖 |
|---|---|
| docx-safety | 包安全；元数据别名不吞正文；格式化后保留换行、制表符、域、图片、书签、链接；复杂段落的保护 |
| engine-parity | 浏览器与 Python 对同一夹具的识别和排版结果一致 |
| handbook | 各文种学标版式：层级、签名、前缀、字体字号、指令草案主体句斜体、英文子列表 a. |
| merge-gate | 无编号引言不移动列表编号；补“（一）”避开页首；补标签保留修订；列表归属变化必报错 |
| studio-tools | 模板文字转义；预览剥离外部关系；诊断报告不声称视觉合规 |
| review-regressions | 文本框段落句末；表格里的文字不当条款；内容控件内的条款；二次处理无变化 |
| local-web-race | 生成中换文件重置按钮；旧结果作废；延迟的 API 错误不恢复旧校验 |
| audit-regressions | 隐藏、删除线在句末规范、补标签、国家名单等路径上都保持 |
| countries | 193 个会员国；整名解析；去重排序幂等；两引擎对所有名称一致 |
| final-audit | 非法 UTF-8；加密标志不一致；带前缀的关系目标；重复关系 Id |
| template-race | 模板生成的竞态 |
| dr-numbering、all-numbering | 六个文种的编号转换、层级规划、原生编号 |
| edge-cases | 边界情况 |
| android | 手机版页面的样式降级与内置函数补丁；桥和加载器是 ES5；清单承诺；校验值行；已发布 APK（第 20.6 节） |
| desktop | 离线页面 CSP 与相对路径；加载器在新旧浏览器中的行为和语法兼容；单文件页面；macOS 入口的架构和最低系统；启动脚本在多种 shell 下的浏览器选择和 URL 编码；安装脚本设置；已发布安装包的校验和与版本 |
| rendered-html | 服务端渲染出产品页，有六个文种 |
| static-deployment | 静态资源白名单；发布包能在不调用 API、不填写第 03 步的情况下识别并下载 |

- **Python 测试**（`backend/tests/test_*.py`）：pipelines、policy、handbook、content_protection、countries、security、local_app、local_build、python39_compatibility 等 22 个文件。
- **验收原稿**：`examples/acceptance-inputs/` 共 11 份。
  - 中英文立场文件、工作文件、指令草案、决议草案；
  - 中文友好修正案、中文非友好修正案、英文修正案。
  - 所有端到端测试都只用规则处理它们，不得写针对样例的代码。
- **其他回归脚本**：`scripts/stress_damage.py`（损伤注入）、`run_resolution_stress_regression.py`、`engine_readback_diff.py`、`docx_compare.py`、`reference_regression.py`。

## 24. 验收标准（复原后的程序应满足）

1. 11 份验收原稿在两种引擎中都能识别、生成，校验结果无 ×；输出能被 Word / WPS / LibreOffice 正常打开。
2. **成稿再处理一遍**（选同一文种）后，没有新的文字改动：幂等。
3. **内容零改动**：对任一输入，除第 12.3 节白名单内的变化外，`verifyFormat`、`verifyMarks`、`verifyPackage` 都不报告问题。人为改动正文必须被拦截。
4. 隐藏文字、删除线、修订、域、超链接、书签、图片、脚注、批注、页眉页脚，排版前后都存在且语义不变。
5. 第 03 步修改的字段被写入；没有可写位置时给出 `manual-field-unwritten` 提示，不新增行。
6. 识别不出的层级、编号、国家名保持原样，并有 △ 提示。
7. 版式符合第 9 章参数：页面、字号、字体、行距、缩进、强调、空行、签名行。
8. 网页版和桌面版处理过程中**没有任何网络请求**；桌面页面的 CSP 能拒绝 fetch 和远程图片。
9. **桌面安装包**：
   - macOS：通过 `codesign --verify --deep --strict`，能原生运行；
   - Windows：无管理员权限即可安装、升级、卸载；
   - 旧浏览器看到中文说明，不白屏。
10. 同一源码重建的安装包字节相同（APK 为条目内容相同，签名证书与登记的指纹相同）。
11. **安卓安装包**：没有联网权限；WebView 69 以上跑完全部原稿、成品与电脑上逐部件相同，以下显示更新说明；保存到「下载」、Android 6–9 存储权限、打开方式与分享传入在 Android 5.0–15 上可用。

## 25. 从零复原的建议顺序

1. **策略文件**：照抄 `shared/*.json`。它们是规则本身，比代码更稳定。
2. **包安全层**：实现 `readPackage`、`decodeXml`、`visibleText` 和切分工具（第 5 章），用畸形 ZIP 测试。
3. **内容签名与守卫**（第 12 章）：先有守卫，再写任何改写逻辑；每加一种改写，就加入白名单和 `checkEdit`。
4. **识别**（第 6、7 章）：用验收原稿对照诊断报告，调到字段和条款都正确。
5. **排版流水线**：按第 8 章的顺序一步步加入，每加一步都跑全部原稿并确认守卫无报错。
   - 推荐顺序：页面 / 样式 / run → 页首字段 → 角色 → 几何 / 强调 → 标点 → 签名行 → 空行 → 编号体系 → 字体部件。
6. **国家名称**（第 11 章）与**编号系统**（第 10 章）作为独立模块，单独写单元测试。
7. **界面**（第 3 章）：先做浏览器模式，再加 API 模式；重点实现 `operationRef` 与 `discardPending`。
8. **预览、模板、诊断**（第 14–16 章）。
9. **静态构建与来源记录**（第 19.1 节），然后做桌面安装包（第 19 章）、安卓安装包（第 20 章）和 CI（第 22 章）。
10. **Python 兼容引擎**（第 17 章）：可选。需要 API 或批处理时，按模块对应表移植，并用一致性夹具对齐。

## 附录 A：序言与行动动词前缀（`document-policy.json` → `prefixes`）

匹配规则：

- 不分大小写，取最长匹配；
- 英文要求整词（动词后不能紧跟字母）；
- 跳过开头的编号标记后再匹配。

**中文序言（47）**：深刻认识到、深刻意识到、完全警惕于、完全认识到、遗憾地看到、欣慰地看到、进一步指出、注意并批准、深切关注、深切关切、深表关切、进一步回顾、深感不安、深感遗憾、震惊于、认识到、考虑到、注意到、铭记、确认、支持、相信、牢记、确信、宣布、深信、希望、强调、期望、满足于、履行、惋惜于、回顾、根据、已采用、已考虑、检查、欣闻、欣见、收到、研究、欢迎、呼吁、关注到、痛心于、完全相信、观察到

**中文行动（62）**：十分遗憾地看到、进一步征求、进一步声明、进一步建议、进一步要求、进一步决定、进一步呼吁、充分调动、强烈反对、呼吁注意、要求、决定、呼吁、敦促、促请、鼓励、建议、授权、邀请、支持、谴责、重申、申明、强调、赞许、同意、认可、铭记、确定、考虑、指定、宣布、注意、断定、指示、督促、关于、希望、推动、明确、加强、建立、提升、优先、针对、通过、采取、确保、加入、修改、删除、阐明、确立、签署、阐明希望、进一步回顾、已经决定、宣告、回顾、牢记、欣慰地看到、深切关注

**英文序言（51）**：Affirming, Alarmed by, Approving, Aware of, Believing, Bearing in mind, Confident, Contemplating, Convinced, Declaring, Deeply concerned, Deeply convinced, Deeply conscious, Deeply disturbed, Deeply regretting, Desiring, Emphasizing, Expecting, Expressing its satisfaction, Fulfilling, Fully alarmed, Fully aware, Fully believing, Further deploring, Further recalling, Guided by, Having adopted, Having considered, Having devoted attention, Having examined, Having heard, Having received, Having studied, Keeping in mind, Noting with regret, Noting with satisfaction, Noting with deep concern, Noting further, Noting with approval, Observing, Realizing, Recalling, Recognizing, Referring, Seeking, Taking into account, Welcoming, Acknowledging, Reaffirming, Considering, Noting

**英文行动（48）**：Accepts, Affirms, Approves, Authorizes, Calls, Calls upon, Condemns, Confirms, Considers, Declares accordingly, Deplores, Designate, Draws attention, Emphasizes, Encourages, Endorses, Expresses its hope, Further invites, Further proclaims, Further recommends, Further reminds, Further requests, Further resolves, Has resolved, Notes, Proclaims, Reaffirms, Recommends, Regrets, Reminds, Requests, Resolves, Solemnly affirms, Supports, Takes note of, Urges, Decides, Defines, Clarifies, Directs, Invites, Promotes, Modifies, Deletes, Adds, Modify, Delete, Add

## 附录 B：关键正则（逐字）

```text
ZH_MARKER   ^[\s ]*(?:第[一二三四五六七八九十百千]+条|[一二三四五六七八九十]+[、.]|[（(][一二三四五六七八九十子丑寅卯辰巳午未申酉戌亥甲乙丙丁戊己庚辛壬癸]+[）)]|\d+[.、．)]|[甲乙丙丁戊己庚辛壬癸][、.]|[（(][a-zivx]+[）)]|[（(]\d{1,2}[）)]|[a-z][.)）](?=\s|[^\x00-\x7f]))\s*      (i)
SUB_MARKER  ^[\s ]*(?:[（(][一二三四五六七八九十a-zivx]+[）)]|[甲乙丙丁戊己庚辛壬癸][、.])      (i)
HANDBOOK_MARKER ^\s*(?:第[一二三四五六七八九十百]+条|[0-9]+[.、．)]|[0-9]+(?=\s{2,})|[a-z][.)）](?=\s|[^\x00-\x7f])|[（(][a-zivx]+[）)]|[（(][0-9]{1,2}[）)]|[（(][一二三四五六七八九十子丑寅卯辰巳午未申酉戌亥甲乙丙丁戊己庚辛壬癸]+[）)])\s*      (i)
PP_LEVELS   ^\s*\d+\s*[.、．)]  |  ^\s*(?:[a-h]|[j-u]|[w-z])\s*[.)]  |  ^\s*[ivx]+\s*[.)]      (i)
PART        ^(?:PART\s+[IVXLC]+\b|第[一二三四五六七八九十]+部分)      (i)
BARE_ARTICLE ^\s*第[一二三四五六七八九十百]+条\s*$
ENDING_PUNCTUATION [，,；;。.:：、]+$
REFERENCE_START ^\s*\[1\]
bodyMarker  ^[\s ]*(?:第[一二三四五六七八九十百千零〇]+条|[一二三四五六七八九十]+[、.]|[（(][一二三四五六七八九十子丑寅卯辰巳午未申酉戌亥甲乙丙丁戊己庚辛壬癸]{1,3}[）)]|\d+(?:\.\d+)*[.、．)）]|[a-z][.)）][\s ]|[ivx]+\.[\s ]|[（(][a-z]{1,4}[）)]|part[\s ]+[ivx\d]+)      (i)
sentenceEnd [。！？!?][\s ]*$
embeddedSubclause.marker   ([：:；;])(\s*)([（(](?:[一二三四五六七八九十百]{1,3}|[子丑寅卯辰巳午未申酉戌亥]{1,4}|[甲乙丙丁戊己庚辛壬癸]{1,4})[）)])
embeddedSubclause.clause   ^\s*(?:第[一二三四五六七八九十百]+条|[0-9]+[.、．)）]|[（(](?:[一二三四五六七八九十百]{1,3}|[子丑寅卯辰巳午未申酉戌亥]{1,4}|[甲乙丙丁戊己庚辛壬癸]{1,4})[）)]|决定|呼吁|敦促|鼓励|建议|要求|支持|希望|推动|关于|申明|强调)
subjectLine (en) The [A-Z][A-Za-z'’.\-]*(?: (?:[A-Z][A-Za-z'’.\-]*|of|on|for|and|the|in|to|de|\([A-Z]+\))){0,9},
subjectLine (zh) [一-鿿·（）()]{0,28}(?:大会|理事会|委员会|议会|组织|会议|法院)[，,]
```

## 附录 C：相关文档

- `docs/architecture.md`：边界与执行步骤
- `docs/adr-0001-shared-daily-interface.md`：一套界面、一个引擎的决策
- `docs/handbook-alignment.md`：逐条对照学标
- `docs/release-*.md`：各版本说明；`docs/audit-2026-*.md`：审计报告
- `desktop/README.md`：桌面安装包的构建与验证
- `downloads/PKUNMUN2026-Install-Guide.txt`：给终端用户的安装教程
