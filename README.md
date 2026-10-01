# Munword — PKUNMUN 2026 DOCX Formatter

当前稳定版 **v1.6.3**。将内容已完成、格式混乱的模拟联合国 DOCX 转换为可继续编辑的标准化文档。此仓库是完整源码导入，便于代码审查；不是包含运行时的免安装程序。发布整理没有改动排版引擎、界面或共享排版规则。

## 功能与运行模式

- 六种文书：立场文件、工作文件、指令草案、决议草案、友好修正案、非友好修正案；支持中英文。
- 四步流程：选择类型、上传原稿、确认识别、生成下载。第三步人工修改入口保留，自动回归不代填第三步。
- 根据共享规则处理字体、字号、强调、缩进、页边距、名单与条款；保留编号起始值、跳号、重启、层级和交叉引用。
- ZIP 安全检查、20 MB 上传限制、内容/编号/修订/关系/媒体等保护；无法安全处理时拒绝输出。
- 浏览器版默认在客户端处理原稿，不依赖 Python、账号或 API Key；也可选用本机 FastAPI 引擎。
- 本机 Python 版提供独立 HTML 界面，默认只监听 `127.0.0.1:8000`，不能作为无认证公网 API 部署。

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

现有 `dev/build/start/typecheck` 使用 POSIX 环境变量语法；Windows 上建议在 WSL 执行网页开发命令。直接使用 Windows Python 本机版不要求 WSL。

Vite 启动地址以终端输出为准（通常端口 5173）。生产构建与本机预览：

```sh
pnpm build
pnpm start
```

`.openai/hosting.json` 是现有构建配置的必需输入，但已忽略。复制的示例只含空绑定，可用于本地构建，不包含账户或线上项目 ID，也不能直接代表原网站的发布授权。

默认不需要 `.env`。若需要连接本机 API，可复制 `.env.example` 到 `.env.local`，设置 `NEXT_PUBLIC_API_URL` 后重启/重建网页。`NEXT_PUBLIC_*` 会进入客户端，绝不能填写秘密。本机后端现有跨域白名单保留原兼容行为；任意开发端口不一定被允许，最简后端使用方式是直接打开端口 8000 的本机页面。

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

根目录的 macOS/Windows 一键安装入口仍保留。它们会安装依赖、复制程序并配置持续运行的本机服务，不应由云端审查 agent 当作普通测试运行。macOS `.app` 中的启动器是 Bash 源码，生成的代码签名已排除；重新分发签名安装包是独立工作，不属于本源码仓库的可复现性承诺。

## 测试与检查

完成上面的 Node/Python 依赖安装和示例配置复制后：

```sh
pnpm test:unit
.venv/bin/python -m unittest discover -s backend/tests -v
pnpm build
node --test tests/rendered-html.test.mjs
pnpm typecheck
pnpm lint
python3 scripts/audit-source.py
```

`pnpm test` 组合 Node 单元测试、构建与 HTML 测试，但不执行 Python 测试；`typecheck` 依赖先构建生成的 Wrangler 配置。标准测试使用仓库中的合成输入与 `tests/fixtures/engine-parity.json`，不需要私人文件或云端凭据。

生成可视检查用的验收输出（输出已忽略）：

```sh
.venv/bin/python scripts/generate_acceptance_samples.py --outputs-only
```

其他压力/外部样例脚本在 `scripts/`。需要私人样例的脚本通过 `MUNWORD_FIXTURE_ROOT` 定位，不随仓库分享这些样例。`verify-browser-regressions.mjs` 保留历史字号断言，不是当前版本的发布门禁；不要用历史断言替代标准测试。

可选视觉 QA：安装 `backend/requirements-qa.txt`，自行准备支持 `--output_dir --emit_pdf --dpi` 的 `render_docx.py`、LibreOffice/Poppler 和正确字体，向 `render-handbook-qa.py` 传入 `--renderer` 或设置 `MUNWORD_DOCX_RENDERER`。其他设置见 `.env.example`；这些 Python/安装脚本的环境变量必须在 shell 中设置，不自动读取 dotenv 文件。外部渲染工具不是应用运行依赖。

## 目录结构

```text
app/                    React 网页、浏览器 DOCX 引擎、内容守卫和 CSS
local_web/              Python 本机版 HTML/JS（CSS 共用 app/globals.css）
backend/app/            FastAPI、解析、中间模型、六类流水线、格式器与保护
backend/tests/          Python 测试
shared/                 共享排版策略、国家拼音与英文地域排序数据
templates/pkunmun2026/  模板策略说明
tests/                  Node 单元/HTML 测试与引擎对齐基线
examples/               合成验收输入及原有 D1 示例
scripts/                生成/压力/比对/审计/本机安装工具
worker/, build/         Cloudflare/vinext 入口和构建插件
db/, drizzle/           原有数据库脚手架与迁移
.openai/                不含账户信息的构建配置示例
windows/                Windows 启动与服务安装脚本
docs/                   架构导航、学标对照、版本说明与导入记录
VERSION                 本机后端版本来源（网页另有可见版本字符串）
```

锁文件、TypeScript/Vite/ESLint 配置、macOS 源码启动器和 Windows 入口均保留。当前主流程未使用的认证/数据库脚手架也保留供全仓库审查，不能据此认定应用已实现云端鉴权或数据库存储。

## 核心排版流程

原稿 ZIP/OOXML 安全验证 → 提取元数据与段落/列表结构 → 六类文书对应的中间模型 → 保守结构修复（不推测补齐原文）→ 用户可选确认 → 共享排版策略与各文种格式规则 → 内容、编号、修订与部件保护检查 → 打包 DOCX 与校验说明。

两套引擎分别在 `app/docx-browser.ts` 与 `backend/app/`，共享 JSON 策略但并非同一实现。详见 [架构导航](docs/architecture.md)、[学标对照](docs/handbook-alignment.md) 和 [v1.6.3 说明](docs/release-1.6.3.md)。

## 已知限制

- 任意严重破损或语义缺失的输入无法保证自动恢复；高风险变化必须提示/中止，测试通过不等于所有文档都与参考文件像素相同。
- 双引擎实现存在维护与一致性风险；复杂 OOXML、作者自定义强调、特殊编号和修订仍需要真实文档审查。
- Word/WPS/LibreOffice、字体缺失与字体替代会导致分页/视觉差异；结构测试不能替代实际渲染验收。
- 不支持旧 `.doc`、PDF/OCR；大文件浏览器同步处理可能短暂阻塞界面。
- Windows 与 macOS 安装器需在真实设备验证；现有历史安装元数据与脚本保留，未借本次导入重构。
- 线上浏览器下载、不同 Safari 版本与外部渲染器依赖，不由普通单元测试完全覆盖。
- 原站点 CORS 来源是公开兼容配置，不是秘密；公开部署后端前必须独立审查安全边界。

本仓库不新增开源许可证或改变授权范围，默认按 Private 仓库管理。不要提交真实用户文档、秘密、生成产物或账号专属部署配置。
