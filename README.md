# PKUNMUN 2026 文件自动排版系统（Munword）

当前版本 **v1.9.0**。

把内容已经写好、格式却乱七八糟的模联文件交给它，它会按《PKUNMUN2026 学术标准手册》把文件排成规范格式：字体字号、缩进行距、条款编号、国家名单和签字空行一次到位。**正文一个字都不改**，生成的 DOCX 仍能在 Word / WPS 里继续编辑。

- 八种文书：立场文件、工作文件、指令草案、决议草案、友好修正案、非友好修正案、外交协定、联合声明，中英文都支持。
- 四步完成：选择类型 → 上传原稿 → 确认识别 → 生成下载。
- 文件只在你自己的电脑或手机上处理，不上传，不需要账号，也不用 AI 改写内容。

## 四种用法

四种用法是同一套界面、同一个排版引擎，处理结果完全一样。

| 用法 | 适合 | 入口 |
|---|---|---|
| 网页版 | 有网络、不想安装 | [munword-formatter.pages.dev](https://munword-formatter.pages.dev/) |
| macOS 版 | macOS 10.11 及以上，Intel 与 Apple 芯片通用 | [PKUNMUN2026-Formatter-macOS.dmg](https://github.com/lsyl71271-lgtm/munword-formatter/releases/latest/download/PKUNMUN2026-Formatter-macOS.dmg) |
| Windows 版 | Windows 7 / 8.1 / 10 / 11，32 位与 64 位，ARM 也可 | [PKUNMUN2026-Formatter-Windows-Setup.exe](https://github.com/lsyl71271-lgtm/munword-formatter/releases/latest/download/PKUNMUN2026-Formatter-Windows-Setup.exe) |
| 安卓版 | Android 5.0 及以上的手机、平板 | [PKUNMUN2026-Formatter-Android.apk](https://github.com/lsyl71271-lgtm/munword-formatter/releases/latest/download/PKUNMUN2026-Formatter-Android.apk) |

- 网页版打开就能用。排版在你的浏览器里完成，服务器只负责把网页发给你。
- 桌面版和安卓版装好后完全离线，断网也能用，适合会场网络不稳定的时候。iPhone / iPad 请用网页版。
- 第一次安装请先看 **[安装教程](https://github.com/lsyl71271-lgtm/munword-formatter/releases/latest/download/PKUNMUN2026-Install-Guide.txt)**：Mac、Windows 与安卓手机的手把手步骤、弹窗怎么处理、系统或浏览器太旧时怎么更新。
- 所有安装文件都在 **[下载页（GitHub Releases）](https://github.com/lsyl71271-lgtm/munword-formatter/releases/latest)**，仓库的 [downloads/](downloads/) 目录里也有一份。

## 下载桌面版

| 系统 | 安装 |
|---|---|
| macOS | 双击 DMG，把「PKUNMUN 2026 文件排版系统」拖进「应用程序」 |
| Windows | 双击 EXE，点「安装」；桌面会出现快捷方式 |

- **打开方式**：程序借用本机浏览器显示一个独立窗口。优先用 Edge、Chrome、Brave 或 Vivaldi，没有时用 Safari、Firefox 或默认浏览器。
- **浏览器要求**：Edge / Chrome 99+、Firefox 104+ 或 Safari 15.4+。
  - Windows 7 / 8.1 可用 Chrome 109 或 Firefox ESR 115；
  - macOS 10.11–10.14 请装 Chrome 或 Firefox；
  - 浏览器太旧时，页面会说明该装哪个，不会白屏。
- **纯本机**：页面从本机文件打开，安全策略禁止一切网络连接。不需要 Python、账号或网络，不在后台常驻。生成的 DOCX 保存在「下载」文件夹。
- **体积小**：两个安装包都不到 1 MB。
  - Windows 版装到当前用户，不需要管理员权限，可在“设置 → 应用”中卸载；
  - macOS 版是原生通用程序，Apple 芯片不需要 Rosetta。
- **第一次打开的提示**：安装包没有付费的开发者签名，每台电脑会提示一次。
  - macOS 15 及以后：先双击一次，再到「系统设置 → 隐私与安全性」点「仍要打开」。
  - macOS 14 及以前：按住 Control 点按应用 → 打开。
  - 不想改任何设置：双击磁盘映像里的「直接用浏览器打开.html」。它就是完整的排版页面，不需要授权，可以拖到桌面长期使用。
  - Windows SmartScreen：点「更多信息 → 仍要运行」。
- **可验证**：校验值见 [downloads/SHA256SUMS.txt](downloads/SHA256SUMS.txt)。
  - 安装包可以用 `pnpm build:desktop` 从源码逐字节复现；
  - 每次相关改动后，[`offline-installers`](.github/workflows/offline-installers.yml) 工作流都会从源码重建并比对，再在真实系统上安装、打开、跑完全部样例、升级、卸载：Windows Server 2022 x64、Windows 11 ARM、macOS 14 / 15（Apple 芯片）、macOS 15（Intel），Wine 里的 32 位 Windows 7，以及旧版 Chromium 98 / 99 / 109。
- 构建方法、验收范围和签名方式见 [desktop/README.md](desktop/README.md)。

## 下载安卓版

- **安装**：在手机浏览器里下载 APK，点开安装；系统提示「安装未知应用」时，按提示允许本次来源。华为、小米等手机的额外风险提示，安装教程里逐一说明了怎么处理。
- **用法**：和网页版完全一样的界面。可以在应用里选文件，也可以在微信、QQ 或文件管理里对 DOCX 选「其他应用打开 → PKUNMUN 排版」。成品保存到手机的「下载」文件夹，弹窗里可以直接用 WPS / Word 打开或分享。
- **纯本机**：应用没有联网权限，页面从应用自带的文件打开，安全策略禁止一切网络连接；只在 Android 6–9 第一次保存时请求存储权限。
- **兼容**：Android 5.0 及以上（API 21），需要系统 WebView 69 或更高（2018 年起的版本；Android 7 以上的手机一般早已自动更新）。WebView 太旧时页面会说明去哪里更新，不会白屏。旧 WebView 缺少的新语法、内置函数和样式由手机版页面补齐，排版结果与电脑上逐部件相同。鸿蒙 HarmonyOS NEXT 不能安装安卓应用，请用网页版。
- **体积小**：约 0.4 MB。签名证书指纹登记在 [`android/signing-cert.sha256`](android/signing-cert.sha256)，升级安装时系统会核对同一把签名密钥。
- **可验证**：CI 从源码重建 APK，与发布文件逐项比对内容并核对签名；手机版页面在 Chromium 67（应显示说明）到最新版里跑完全部样例；APK 在 Android 5.0、5.1、6.0、7.0、7.1、8.0、8.1、9、10、11、12、12L（平板尺寸屏幕）、13（字体 1.3 倍、深色模式）、14、15、16 的模拟器上安装运行（用各系统自带、未更新的 WebView），检查覆盖安装上一版、保存到「下载」、存储权限的允许与拒绝、打开方式与分享传入、分享面板不列本应用、页面不超出屏幕宽度，以及新到能运行的 WebView 上的全部样例流程、文件选择器和页面进程崩溃后的恢复。
- 构建方法和验收细节见 [android/README.md](android/README.md)。

## 它会做什么，不会做什么

**会做**

- 按学标统一字体、字号、行距、缩进、页边距和强调：标题、页首字段、主体句、序言动词下划线、行动动词斜体等。
- 按学标六种文书各自的编号体系纠正编号写法和层级。序号数值、跳号、重启和交叉引用都保留。
- 外交协定和联合声明按范例版式排版，从标题自动识别签署方（三方就是三方，四方就是四方），签字栏按签署方补齐「XX代表」；原稿已写的代表和姓名保留，缺的姓名留空供签字。
- 决议草案的成稿沿用上传文件的原名，不再询问会期、提交国家和版本号。
- 起草国、附议国按拼音或字母排序、去重，展开为联合国正式全称，只在完整国名之间断行，并留出签字空行。
- 生成前后逐段核对：文字、图片、链接、域、书签、脚注、修订、隐藏文字和删除线一样都不能少。

**不会做**

- 不改正文，不补缺号，不猜错字，不给条款排序，不改正文里的国名。
- 拿不准的层级、编号或国名一律保留原样，标出 △ 请你确认。
- 识别不出的委员会、议题、国家等字段，由你在第 03 步填写。程序和自动化测试都不会代填。
- 任何一项安全校验不通过，就不给文件，并说明原因。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/README.md](docs/README.md) | 全部文档的导航 |
| [实现与需求规格](docs/IMPLEMENTATION_SPEC.md) | 每一处逻辑怎么实现、界面长什么样、本机应用怎么打包；足以从零复原本程序 |
| [网页版承载力与稳定性](docs/website-capacity.md) | 网页版能扛多少人、慢在哪里、什么情况下会出问题 |
| [架构导航](docs/architecture.md) · [统一界面决策](docs/adr-0001-shared-daily-interface.md) | 模块边界与执行步骤 |
| [学标对照](docs/handbook-alignment.md) | 每条规则对应手册哪一页 |
| [版本说明 v1.9.0](docs/release-1.9.0.md) | 当前版本的改动与核查记录（更早的版本见 docs/） |
| [desktop/README.md](desktop/README.md) | 桌面安装包的构建、验收与签名 |
| [android/README.md](android/README.md) | 安卓安装包的构建、兼容性、验收与签名 |

## 开发

### 环境

- Node.js 22.13 以上（建议 24）、pnpm 11.19.0、Python 3.12。
- Node 依赖由 `pnpm-lock.yaml` 锁定；Python requirements 固定了直接依赖。
- 现有 Node 测试直接导入 TypeScript。

### 网页源码

```sh
pnpm install --frozen-lockfile
cp .openai/hosting.example.json .openai/hosting.json   # Windows：Copy-Item .openai/hosting.example.json .openai/hosting.json
pnpm dev                                               # 开发服务器，地址以终端输出为准
pnpm build && pnpm start                               # 生产构建与本机预览
```

- `.openai/hosting.json` 是构建必需的输入，但已被忽略。示例只含空绑定，不含账户或线上项目 ID。
- 默认不需要 `.env`。要让页面连本机 Python API，复制 `.env.example` 为 `.env.local` 并设置 `NEXT_PUBLIC_API_URL`。`NEXT_PUBLIC_*` 会进入客户端，绝不能填写秘密。

### 网页部署（Cloudflare）

```sh
pnpm build:static    # 生成 static-site/
pnpm test:static
pnpm deploy:cloudflare
```

- **Pages**（[munword-formatter.pages.dev](https://munword-formatter.pages.dev/)）：Git 导入仓库 `lsyl71271-lgtm/munword-formatter`，生产分支 `main`，框架预设“无”，根目录 `/`，构建命令 `pnpm build:static`，输出目录 `static-site`。推送 `main` 后自动更新。
- **Workers**：现有 `munword-formatter` Worker 的构建命令为 `pnpm build:static`，部署命令为 `pnpm deploy:cloudflare`。预览分支可用 `pnpm exec wrangler versions upload --config wrangler.static.json`。
- `static-site/` 只包含页面、共用 JS/CSS、图标、许可证和版本摘要。构建采用白名单，不公开源码、Python API、原稿、`.env` 或托管配置。
- 保持免费计划；GitHub 授权与 Cloudflare 发布凭据只由平台管理，不写进仓库。
- 大陆不同运营商对 `pages.dev` / `workers.dev` 的连通性需要实测，不能保证所有网络都可达；详见 [网页版承载力与稳定性](docs/website-capacity.md)。

### 桌面安装包

```sh
pnpm build:desktop   # 重建 DMG 与 EXE，写入 downloads/ 和 SHA256SUMS.txt
pnpm test:desktop
```

- 改动界面、引擎或共享规则后要重新运行 `pnpm build:desktop` 并提交新的安装包，否则 CI 的逐字节复现检查会失败。
- 所需工具（NSIS、rcodesign、libdmg-hfsplus 等）见 [desktop/README.md](desktop/README.md)。

### 安卓安装包

```sh
sudo apt-get install aapt dalvik-exchange zipalign apksigner libandroid-23-java openjdk-21-jdk-headless
pnpm build:local-tools
node android/build-apk.mjs              # 未签名 APK，写入 dist/android/
MUNWORD_ANDROID_KEYSTORE=… MUNWORD_ANDROID_KEYSTORE_PASSWORD=… MUNWORD_ANDROID_KEY_ALIAS=… node android/build-apk.mjs --publish
```

- 不需要 Gradle 或 Android Studio，Ubuntu / Debian 的软件包就够了。
- 改动界面、引擎或共享规则后，要用签名密钥重新运行 `--publish` 并提交新的 APK，否则 CI 的内容比对会失败。签名密钥不在仓库里，见 [android/README.md](android/README.md)。

### Python 兼容引擎、API 与批处理

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt      # Windows 用 backend/requirements-windows.txt
.venv/bin/python backend/run.py                                  # http://127.0.0.1:8000，API 文档 /docs，健康检查 GET /api/health
```

- 从源码启动本机页面前，先运行 `pnpm build:local-tools`。缺少离线构建时，`/app.js`、`/styles.css` 明确返回 503。
- 服务只监听 `127.0.0.1:8000`，不能作为无认证的公网 API 部署。
- 批处理不填写第 03 步、不覆盖原文件，同名输出默认拒绝：

```sh
.venv/bin/python backend/cli.py /path/to/docx-folder --type working-paper --output-dir output/batch
.venv/bin/python backend/cli.py /path/to/input.docx --type draft-resolution --output-dir output/diagnosis --diagnose-only
```

- 源码发布包：`pnpm build:local-tools && .venv/bin/python scripts/package-release.py --desktop --output output/Munword-1.9.0-desktop-source.zip`。包内有校验清单和依赖许可证，不含 `.env`、部署配置、缓存或用户文档。
- 可选视觉验收：`docker compose -f deploy/visual-qa.compose.yaml up -d` 启动只监听本机的 Gotenberg，再运行 `scripts/visual-qa.py`；需要 `backend/requirements-qa.txt` 和 Poppler。它只报告字号、斜体与像素差异，不代表学标要求已全部自动验收。

**旧版本机服务**（桌面安装包出现之前的安装方式，仍然保留）：

- 根目录的 `首次安装.command`（macOS）和 `Windows 首次安装.bat` 会安装 Python 依赖，并配置持续运行的本机服务（127.0.0.1:8000）。
- 页面和排版同样在浏览器里完成。普通用户请改用上面的桌面安装包。

### 测试与持续集成

```sh
pnpm build:static
pnpm test:unit
.venv/bin/python -m unittest discover -s backend/tests -v
pnpm build
node --test tests/rendered-html.test.mjs
pnpm test:static
pnpm typecheck
pnpm lint
python3 scripts/audit-source.py
```

- [`source-checks`](.github/workflows/source-checks.yml) 在每次推送和每个 PR 上运行以上全部检查。
- [`offline-installers`](.github/workflows/offline-installers.yml) 在安装包（DMG / EXE / APK）或其页面来源改动时运行。
- 标准测试只用仓库里的 14 份合成验收原稿和 `tests/fixtures/engine-parity.json`，不需要私人文件或云端凭据。
- 自动化验收只检查第 03 步“可以编辑”，从不代填字段来掩盖识别错误。
- 其他压力与比对脚本在 `scripts/`。需要私人样例的脚本通过 `MUNWORD_FIXTURE_ROOT` 定位，这些样例不随仓库分享。

### 国家名称资料

- 唯一资料表是 `shared/country-names.json`。它在 2026-10-05 下载并核对 [UNTERM 官方国家表](https://unterm.un.org/unterm2/en/country)，用 [联合国 UNGEGN](https://ungegn.un.org/dashboard/countries) 的 M49 号关联固定标识。
- 193 个会员国、2 个观察员国家、2 个专门机构成员分别分类。中文正式名直接采用 UNTERM；英文展开省略开头的语法冠词 the。
- 只做整名匹配。歧义、历史、未知和组织名称原样保留，提示到第 03 步确认。
- 更新资料时，下载表中 `sources` 指定的两个官方源，然后运行：

```sh
python3 scripts/import-country-names.py --unterm-export /path/to/unterm-countries.xlsx --ungegn-json /path/to/ungegn-countries.json --checked-on YYYY-MM-DD
```

- 提交前必须审查新旧差异和官方来源，不能用“共和国”等词语猜测名称。

## 目录结构

```text
app/                    界面 page.tsx、浏览器排版引擎、内容保护、样式
local_web/              离线 / 本机页面外壳（直接挂载 app/page.tsx）
shared/                 两个引擎共用的规则：学标版式、编号、国家名表、包安全上限
backend/                Python 兼容引擎、FastAPI 服务、CLI 与测试
desktop/                桌面安装包的构建脚本、启动器、验收脚本
android/                安卓应用（Java 外壳、旧 WebView 兼容层）、构建与验收脚本
downloads/              已发布的 DMG、EXE、APK、校验值与安装教程
tests/                  Node 测试与引擎一致性基线
examples/               11 份合成验收原稿；D1 示例（平台脚手架）
scripts/                构建、打包、审计、压力与比对脚本，旧版本机服务安装脚本
windows/                旧版本机服务的 Windows 脚本
docs/                   规格、架构、学标对照、版本说明、审计记录
worker/ build/ db/ drizzle/   vinext / Cloudflare 入口与保留的数据库脚手架（未启用）
```

当前主流程不使用认证和数据库脚手架，不能据此认为应用实现了云端鉴权或数据库存储。

## 已知限制

- 严重破损或语义缺失的原稿无法保证自动恢复；有风险的变化一律提示或中止。
- 不支持旧版 `.doc`、PDF 或 OCR。
- 处理在浏览器里同步进行：普通文件不到 1 秒，极大的文件可能让页面停顿几秒。
- Word、WPS、LibreOffice 与字体替代会带来分页和视觉差异；结构校验不能代替实际渲染检查。
- 浏览器版与 Python 版是两份实现，靠一致性测试保持同步；复杂 OOXML、特殊编号和修订仍需真实文档检验。
- 包安全上限统一来自 `shared/package-policy.json`：
  - 上传 20 MiB、解压后合计 100 MiB、单个 XML 16 MiB；
  - 最多 5000 个部件、压缩比 250、XML 深度 256；
  - 不支持加密或非 STORE / DEFLATE 压缩的部件；
  - Python API 在解析 multipart 前限制请求合计 21 MiB。
- Python 本机服务的跨域来源是公开的兼容配置，不是秘密。公开部署后端前必须单独审查安全边界。
- 依赖审计仍有一项开发工具链 `braces` 公告，官方尚无修复版本；原稿内容不会进入 glob 模式。
- Python 3.9 仅为旧安装兼容保留，它能用的依赖版本仍有无法消除的公告；新安装请用 Python 3.12+。

## 许可与隐私

- 本仓库未附加开源许可证，也不改变授权范围；当前为公开仓库。第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 仓库不包含真实用户文档、学标 PDF 或部署凭据。请不要提交真实文档、秘密、生成产物或账号专属配置。
