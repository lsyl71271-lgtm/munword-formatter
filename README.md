# Munword — PKUNMUN 2026 DOCX Formatter

当前版本 **v1.8.5**。将内容已完成、格式混乱的模拟联合国 DOCX 转换为可继续编辑的标准化文档。提供实际页面预览、结构诊断、独立模板新建、本机批处理，以及明确国家字段的正式全称展开。本机日常界面与网页版共用同一组件、样式和浏览器引擎，Python API/批处理保留兼容。普通用户请直接下载下面的桌面安装包；源码开发与旧脚本安装方式另外保留。

## 下载桌面版（一键安装，纯本机离线）

| 系统 | 下载 | 安装 |
|---|---|---|
| macOS 10.11 及以上，Intel 与 Apple 芯片通用 | [PKUNMUN2026-Formatter-macOS.dmg](downloads/PKUNMUN2026-Formatter-macOS.dmg) | 双击打开，把「PKUNMUN 2026 文件排版系统」拖进「应用程序」 |
| Windows 7 / 8.1 / 10 / 11，32 位与 64 位 | [PKUNMUN2026-Formatter-Windows-Setup.exe](downloads/PKUNMUN2026-Formatter-Windows-Setup.exe) | 双击运行，点「安装」；桌面出现快捷方式 |

- 打开后是一个独立窗口（借用本机 Edge、Chrome、Brave 或 Vivaldi 的应用窗口；没有时用 Safari、Firefox 或默认浏览器）。界面和排版引擎与网页版完全相同。
- **浏览器要求**：Edge / Chrome 99+、Firefox 104+ 或 Safari 15.4+。
  - Windows 7 / 8.1 可用 Chrome 109 或 Firefox ESR 115；
  - macOS 10.11–10.14 请装 Chrome 或 Firefox；
  - 浏览器过旧时，页面会说明该装哪个，不会白屏。
- **纯本机**：页面从本机文件打开，安全策略禁止一切网络连接；不需要 Python、账号或网络，不常驻后台。生成的 DOCX 保存在「下载」文件夹。
- 安装包都不到 1 MB。
  - Windows：安装到当前用户，不需要管理员权限，可在“设置 → 应用”中卸载；
  - macOS：程序是原生通用版，Apple 芯片不需要 Rosetta。
- **首次打开提示**：安装包没有付费的开发者签名。
  - macOS 15 及以后：先双击一次，再到「系统设置 → 隐私与安全性」点「仍要打开」。
  - macOS 14 及以前：按住 Control 点按应用 → 打开。
  - 不想改任何设置：双击磁盘映像里的「直接用浏览器打开.html」，用浏览器打开同一个页面，不需要授权。
  - Windows SmartScreen：点「更多信息 → 仍要运行」。
  - 每台电脑只需一次。
- 校验值见 [downloads/SHA256SUMS.txt](downloads/SHA256SUMS.txt)；安装包由 `pnpm build:desktop` 从同一提交可逐字节复现。构建方法见 [desktop/README.md](desktop/README.md)。

### 另一套安装器：Munword（自带 Python 运行环境）

`desktop/build.py` 与 `.github/workflows/desktop-installers.yml` 构建另一套按芯片/位数分包的安装器（Windows 10/11 x64/x86、macOS 11+ arm64/x64）。它在本机 `127.0.0.1` 随机端口提供同一页面，由 GitHub Actions 在原生 Windows 与 macOS 虚拟机里构建和验收，产物在 Actions 页面下载。详见 [离线桌面安装说明](docs/desktop-installers.md)。两套安装器的比较见 [desktop/README.md](desktop/README.md#两套安装器的比较)。

## 功能与运行模式

- 六种文书：立场文件、工作文件、指令草案、决议草案、友好修正案、非友好修正案；支持中英文。
- 四步流程：选择类型、上传原稿、确认识别、生成下载。第三步人工修改入口保留，自动回归不代填第三步。
- 根据共享规则处理字体、字号、强调、缩进、页边距、名单与条款；六种文种按各自策略检查编号体系，依据明确父子关系纠正表示法与层级；保留编号起始值、跳号、重启和交叉引用，不能确定时保留并提示人工确认。
- ZIP 安全检查、20 MB 上传限制、内容/编号/修订/关系/媒体等保护；无法安全处理时拒绝输出。
- 浏览器版默认在客户端处理原稿，不依赖 Python、账号或 API Key；也可选用本机 FastAPI 引擎。
- 本机服务提供同一网页的离线构建，不再维护独立界面/排版流程；默认只监听 `127.0.0.1:8000`，不能作为无认证公网 API 部署。
- 国家简称、标准短名和正式名按固定 M49 标识匹配、去重；只处理已识别的国家/席位、起草国、附议国字段，正文和代表姓名不替换。

主要规则在 `shared/document-policy.json`。Word 二进制模板不是隐藏依赖；`templates/pkunmun2026/README.md` 解释模板策略。仓库保留 11 个合成 DOCX 输入和引擎对齐基线，不包含用户真实文档、学标 PDF 或本机部署凭据。

## 开发环境

建议 Node.js 24、pnpm 11.19.0、Python 3.12。本次导入使用 Node 24.19.0 / Python 3.12.14；现有 Node 测试直接导入 TypeScript，低版本 Node 可能需要额外设置。Node 使用 `pnpm-lock.yaml` 锁定；Python requirements 固定直接依赖，间接依赖尚未全部锁定。不要在审查前随意升级。

### 网页源码

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
cp .openai/hosting.example.json .openai/hosting.json
pnpm dev
```

Windows PowerShell 复制配置的命令：

```powershell
Copy-Item .openai/hosting.example.json .openai/hosting.json
```

`dev/build/start/typecheck` 均使用 Node 启动器，兼容 Windows；本机 Python 版不要求 WSL。

Vite 启动地址以终端输出为准（通常端口 5173）。生产构建与本机预览：

```sh
pnpm build
pnpm start
```

`.openai/hosting.json` 是现有构建配置的必需输入，但已忽略。复制的示例只含空绑定，可用于本地构建，不包含账户或线上项目 ID，也不能直接代表原网站的发布授权。

默认不需要 `.env`。若需要连接本机 API，可复制 `.env.example` 到 `.env.local`，设置 `NEXT_PUBLIC_API_URL` 后重启/重建网页。`NEXT_PUBLIC_*` 会进入客户端，绝不能填写秘密。本机后端现有跨域白名单保留原兼容行为；任意开发端口不一定被允许，最简后端使用方式是直接打开端口 8000 的本机页面。

### Cloudflare 静态托管（GitHub 自动构建）

Pages 访问入口：[munword-formatter.pages.dev](https://munword-formatter.pages.dev/)。Pages 与现有 Workers、本机版使用同一套界面和浏览器排版引擎，不另建一套程序。Cloudflare Pages 的 Git 导入设置为：仓库 `lsyl71271-lgtm/munword-formatter`，生产分支 `main`，框架预设“无”，根目录 `/`，构建命令 `pnpm build:static`，输出目录 `static-site`；无需填写 Workers 部署命令。后续推送 `main` 自动更新站点。

连通性验收必须区分代理访问与直连：2026-10-05 的本机检查中，Pages 首页、JS、CSS 和版本摘要不经 curl 代理均返回 200，且与发布构建逐字节一致；同期 `workers.dev` 入口直连失败。此结果仅覆盖当时的测试连接，不能承诺所有运营商永久可达。浏览器需另行关闭代理/VPN 验证，不能把构建成功或代理下的 200 当作国内直连成功。官方步骤见 [Pages Git 导入](https://developers.cloudflare.com/pages/get-started/git-integration/) 与 [静态站点部署](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/)；如需自有域名，按 [自定义域名](https://developers.cloudflare.com/pages/configuration/custom-domains/) 配置并重新测试。

复用 `app/page.tsx`、共享样式和浏览器排版引擎，不需要 `.openai/hosting.json`、Python、账号登录或 API Key：

```sh
pnpm install --frozen-lockfile
pnpm build:static
pnpm test:static
pnpm deploy:cloudflare
```

在 Cloudflare 现有 `munword-formatter` Worker 的 Git 构建设置中，生产分支选 `main`，根目录 `/`，构建命令 `pnpm build:static`，部署命令 `pnpm deploy:cloudflare`。预览分支如启用，可用 `pnpm exec wrangler versions upload --config wrangler.static.json`。保持免费计划；GitHub 授权与 Cloudflare 发布凭据仅由平台管理，不写进仓库。配置参考 [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)。

`static-site/` 是自动生成且忽略的发布目录，只包含页面、共用 JS/CSS、图标、许可证和无敏感信息的版本摘要。构建采用资源白名单，不公开源码目录、Python API、原稿、`.env` 或原托管配置。原稿解析、生成、模板和预览仍在浏览器运行；Cloudflare 只提供网页资源。原 Sites 构建与本机兼容 API 不受影响。网站可独立于制作人的电脑运行，但大陆不同运营商对 `workers.dev` 的连通性需实际测试，不能保证所有网络可达。

### Python 本机引擎

macOS/Linux：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
.venv/bin/python backend/run.py
```

Windows PowerShell：

```powershell
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend/requirements-windows.txt
.venv\Scripts\python.exe backend/run.py
```

打开 `http://127.0.0.1:8000/`；API 文档 `/docs`，健康检查使用 **GET** `/api/health`（HEAD 返回 405 不代表故障）。端口被占用时先识别已有服务，不要随意终止其他程序。

从源码启动本机界面前，先安装 Node 依赖并运行 `pnpm build:local-tools`。本机发布包包含共用 React 界面、样式、浏览器引擎及许可，不需要接收者安装 Node；解析、排版、模板新建和预览均在本机浏览器执行。Python 服务仅提供网页资源和兼容 API/批处理。缺少离线构建时 `/app.js`、`/styles.css` 明确返回 503，不退回旧界面。

## 国家名称规则

唯一名称资料表为 `shared/country-names.json`，2026-10-05 下载并核对 [UNTERM 官方国家表](https://unterm.un.org/unterm2/en/country)，用 [联合国 UNGEGN](https://ungegn.un.org/dashboard/countries) 的 M49 号关联固定标识。193 个会员国、2 个观察员国家、2 个专门机构成员分别分类。中文正式名直接采用 UNTERM；英文展开省略词条首部的语法冠词 `the`，不改名称本身，已输入的正式冠词形式也保留。常用别名是显式、保守的项目输入兼容项，不声称是联合国正式名称。

排序键与显示值分开：使用资料表 `sort_name` 正式名的中文拼音/英文字母顺序，英文排序不计开头的语法冠词。保持原顺序选项只关闭排序，不关闭全称展开和已识别国家的去重。歧义、历史、未知和组织/观察员名称原样保留，提示第 03 步确认；不将它们默认为会员国。复杂字段含链接、域、书签、修订、隐藏或删除线时不自动改写。全文/资源校验仍启用，自动转换必须能从原字段和该表独立证明，记录段落、原名、全称、国家 ID 和核对日期。

更新名称资料时，下载表中 `sources` 指定的两个公开官方源，再运行：

```sh
python3 scripts/import-country-names.py --unterm-export /path/to/unterm-countries.xlsx --ungegn-json /path/to/ungegn-countries.json --checked-on YYYY-MM-DD
```

必须审查新旧差异和官方来源后提交，不能添加“共和国”等词语猜测；导入保留已经审查的别名/歧义策略，输入文件不提交。

## v1.7.0 新增工具

- 上传修复后的第三步可查看隔离的原稿/成稿页面，并下载结构诊断 JSON。诊断报告包含原稿文字，请按原稿同样保护；它不声称已完成视觉验收。
- “从规范模板新建文件”是独立入口，使用上方文种、用户填写的正文和现有学标策略。不使用 AI，不把原稿转换成模板数据。
- 批处理不填写第三步字段、不覆盖原文件；同名输出默认拒绝覆盖：

```sh
.venv/bin/python backend/cli.py /path/to/docx-folder --type working-paper --output-dir output/batch
.venv/bin/python backend/cli.py /path/to/input.docx --type draft-resolution --output-dir output/diagnosis --diagnose-only
```

- 安全打包：

```sh
pnpm build:local-tools
.venv/bin/python scripts/verify-local-build.py
.venv/bin/python scripts/package-release.py --desktop --output output/Munword-1.8.5-desktop-source.zip
```

包内包含校验清单及依赖许可证，不包含 `.env`、部署账号配置、缓存或用户文档。仍需 Python 和首次安装联网下载依赖，不是无需运行时的 EXE。

- 可选视觉验收：先安装 `backend/requirements-qa.txt` 和 Poppler。使用自己的本机 `render_docx.py`，或启动仅监听本机的 Gotenberg：

```sh
docker compose -f deploy/visual-qa.compose.yaml up -d
.venv/bin/python scripts/visual-qa.py /path/to/output.docx --gotenberg-url http://127.0.0.1:3000 --output-dir output/visual-qa --require-italic Requests
```

无 Docker 时改用 `--renderer /path/to/render_docx.py`。可设置 `MUNWORD_PDF_RASTERIZER` 指向 `pdftocairo` 或 `pdftoppm`；macOS 的部分 Poppler 后端会丢失 CJK 字形，建议 Cairo。`--reference-pages` 只接受同正文、同字体、同渲染环境的基线，失败返回非零状态。报告记录字号、斜体与像素差异，不代表所有学标要求自动验收完成。此服务不部署到公网网站，不自动上传文件。

第三方许可与使用范围见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，当前版本说明与核查记录见 [v1.8.5](docs/release-1.8.5.md)，此前版本见 [v1.8.4](docs/release-1.8.4.md)、[v1.8.3](docs/release-1.8.3.md)、[v1.8.2](docs/release-1.8.2.md)、[v1.8.1](docs/release-1.8.1.md)、[v1.8.0](docs/release-1.8.0.md)、[v1.7.2](docs/release-1.7.2.md)、[v1.7.1](docs/release-1.7.1.md) 与工具集成 [v1.7.0](docs/release-1.7.0.md)。

六种文种全部执行各自的编号策略检查，策略集中在 `shared/numbering-profiles.json`。只转换能够确认的编号表示法，保留序号数值、跳号、重启和原生列表归属；编号冲突、受保护内容和不可表示的范围提示人工确认。立场文件的章节编号、工作文件的 PART、参考文献及修正案引用/嵌套的目标条款不被套用 DR 格式。样例未覆盖的更深层工作文件/立场文件列表属于项目统一延伸，不能称为手册明文要求。

根目录的 macOS/Windows 一键安装入口仍保留。它们会安装依赖、复制程序并配置持续运行的本机服务，不应由云端审查 agent 当作普通测试运行。macOS `.app` 中的启动器是 Bash 源码，生成的代码签名已排除；重新分发签名安装包是独立工作，不属于本源码仓库的可复现性承诺。

## 测试与检查

完成上面的 Node/Python 依赖安装和示例配置复制后：

```sh
pnpm test:unit
pnpm build:local-tools
.venv/bin/python -m unittest discover -s backend/tests -v
pnpm build
node --test tests/rendered-html.test.mjs
pnpm typecheck
pnpm lint
python3 scripts/audit-source.py
```

`pnpm test` 组合 Node 单元测试、构建与 HTML 测试，但不执行 Python 测试；`typecheck` 依赖先构建生成的 Wrangler 配置。标准测试使用仓库中的合成输入与 `tests/fixtures/engine-parity.json`，不需要私人文件或云端凭据。

`docs/ci.example.yml` 提供可选的 GitHub Actions 配置。需具有 workflow 写入权限的维护者将其放入 `.github/workflows/` 后才会启用；默认发布不要求扩展现有账户权限。

生成可视检查用的验收输出（输出已忽略）：

```sh
.venv/bin/python scripts/generate_acceptance_samples.py --outputs-only
```

其他压力/外部样例脚本在 `scripts/`。需要私人样例的脚本通过 `MUNWORD_FIXTURE_ROOT` 定位，不随仓库分享这些样例。`verify-browser-regressions.mjs` 保留历史字号断言，不是当前版本的发布门禁；不要用历史断言替代标准测试。

可选视觉 QA：安装 `backend/requirements-qa.txt`，自行准备支持 `--output_dir --emit_pdf --dpi` 的 `render_docx.py`、LibreOffice/Poppler 和正确字体，向 `render-handbook-qa.py` 传入 `--renderer` 或设置 `MUNWORD_DOCX_RENDERER`。其他设置见 `.env.example`；这些 Python/安装脚本的环境变量必须在 shell 中设置，不自动读取 dotenv 文件。外部渲染工具不是应用运行依赖。

## 目录结构

```text
app/                    React 网页、浏览器 DOCX 引擎、内容守卫和 CSS
local_web/              离线 React 挂载入口；直接导入 app/page.tsx
backend/app/            FastAPI、解析、中间模型、六类流水线、格式器与保护
backend/tests/          Python 测试
shared/                 共用 UNTERM 国家表、排版/包安全策略、国家拼音与地域数据
templates/pkunmun2026/  模板策略说明
tests/                  Node 单元/HTML 测试与引擎对齐基线
examples/               合成验收输入及原有 D1 示例
scripts/                生成/压力/比对/审计/本机安装工具
worker/, build/         Cloudflare/vinext 入口和构建插件
db/, drizzle/           原有数据库脚手架与迁移
.openai/                不含账户信息的构建配置示例
windows/                Windows 启动与服务安装脚本
docs/                   架构导航、学标对照、版本说明与导入记录
VERSION                 本机后端版本；网页/离线界面统一读 package.json，发布测试核对一致
```

锁文件、TypeScript/Vite/ESLint 配置、macOS 源码启动器和 Windows 入口均保留。当前主流程未使用的认证/数据库脚手架也保留供全仓库审查，不能据此认定应用已实现云端鉴权或数据库存储。

## 核心排版流程

原稿 ZIP/OOXML 安全验证 → 提取元数据与段落/列表结构 → 六类文书对应的中间模型 → 保守结构修复（不推测补齐原文）→ 用户可选确认 → 明确国家字段的全称/身份去重与排序 → 共享排版策略与各文种格式规则 → 内容、编号、修订与部件保护检查 → 打包 DOCX 与校验说明。

日常网页和本机界面均使用 `app/docx-browser.ts`；`backend/app/` 保留兼容 API/CLI。Python 与 TypeScript 共享数据和策略，但并非同一算法源文件。边界见 [统一界面决策](docs/adr-0001-shared-daily-interface.md)、[架构导航](docs/architecture.md) 和 [学标对照](docs/handbook-alignment.md)。

## 已知限制

- 任意严重破损或语义缺失的输入无法保证自动恢复；高风险变化必须提示/中止，测试通过不等于所有文档都与参考文件像素相同。
- 双引擎实现存在维护与一致性风险；复杂 OOXML、作者自定义强调、特殊编号和修订仍需要真实文档审查。
- Word/WPS/LibreOffice、字体缺失与字体替代会导致分页/视觉差异；结构测试不能替代实际渲染验收。
- 不支持旧 `.doc`、PDF/OCR；大文件浏览器同步处理可能短暂阻塞界面。
- Windows 与 macOS 安装器需在真实设备验证；现有历史安装元数据与脚本保留，未借本次导入重构。
- 线上浏览器下载、不同 Safari 版本与外部渲染器依赖，不由普通单元测试完全覆盖。
- 原站点 CORS 来源是公开兼容配置，不是秘密；公开部署后端前必须独立审查安全边界。
- 包安全预算统一来自 `shared/package-policy.json`：上传 20 MiB、展开 100 MiB、单 XML 16 MiB、最多 5000 个部件、压缩比 250、XML 深度 256；兼容 API 在 multipart 解析前限制请求合计 21 MiB。不支持加密或非 STORE/DEFLATE 压缩部件。
- 当前完整依赖审计仍有一项开发工具链 `braces` 公告，官方无已发布修复版；DOCX 原文不进入 glob 模式。详见版本核查记录，不将此风险伪称为已修复。建议 Python 3.12+；Python 3.9 仅保留旧环境兼容，其可用的 multipart/Starlette 等依赖和安装工具仍有无法升级消除的公告，不应作为新安装的安全默认。

本仓库不新增开源许可证或改变授权范围；当前 GitHub 仓库为公开仓库。不要提交真实用户文档、秘密、生成产物或账号专属部署配置。
