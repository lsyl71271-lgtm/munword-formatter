# 桌面安装包（macOS DMG / Windows EXE）

给普通用户的一键安装版。运行时完全在本机，不联网、不需要 Python 或任何运行环境。
下载与安装说明见仓库根目录 README 的「下载桌面版」一节，成品放在 `downloads/`。

## 工作方式

- **同一套界面和引擎**：安装包里的页面就是 Cloudflare Pages 使用的 `pnpm build:static` 产物。脚本逐个核对构建记录里的 SHA-256 后才复制，不另建界面或排版流程。
- **离线页面**：`desktop/build-desktop.mjs` 只改 `index.html`：
  - 把资源路径改成相对路径，使页面能从 `file://` 打开；
  - 写入 `Content-Security-Policy`；
  - 用一段 ES3 写的加载脚本代替 `<script src="app.js">`；
  - 修改 `<noscript>` 提示语。
- **旧浏览器**：加载脚本先检查 `Array.prototype.findLast` 和 CSS 层叠层（Chrome/Edge 99、Safari 15.4、Firefox 104 起都有），满足才加载 `app.js`。否则在页面里用中文说明该装哪个浏览器，IE 也能显示，不会白屏或样式错乱。
- **禁止联网**：`Content-Security-Policy` 设为 `connect-src 'none'`，禁止 fetch/XHR/WebSocket、远程图片和字体，也禁止表单提交。即使页面代码尝试联网，浏览器也会拒绝。`desktop/offline-smoke.mjs` 专门验证这一点。
- **macOS**：
  - 程序入口 `Contents/MacOS/PKUNMUN2026` 是 `macos/launcher-stub.c` 编译的通用二进制（arm64 + x86_64，x86_64 支持 10.11 起）。只用纯脚本做入口时，Apple 芯片会把程序当成 Intel 程序，没装 Rosetta 的 Mac 会先要求安装 Rosetta。
  - 入口只负责用系统自带的 bash 运行 `Contents/Resources/launcher.sh`。脚本与 bash 3.2 兼容，也能在 zsh 下运行。
  - 脚本打开 `Contents/Resources/site/index.html`：
    - 有 Chrome、Edge、Brave、Vivaldi 或 Chromium 时，以 `--app` 独立窗口打开；
    - 否则用 Safari；Safari 早于 15.4（macOS 10.14 及以前）且装有 Firefox 时，改用 Firefox。
  - 不启动服务，不常驻后台，也不写用户目录。
  - 整个 `.app` 做 ad-hoc 签名，封存全部资源（`Contents/_CodeSignature`）。原因有二：Apple 芯片只运行已签名的原生代码；签名没覆盖资源的程序会被报告为“已损坏”。ad-hoc 签名没有开发者身份，所以第一次打开时仍是 macOS 对网上下载程序的常规确认（见根目录 README）。有证书时可改用 Developer ID 签名并公证，见下文“签名与公证”。
  - 磁盘映像里的 `直接用浏览器打开.html` 就是完整的排版页面：构建时把 `styles.css` 和 `app.js` 内嵌进同一个网页（`singleFilePage`），复制到桌面或任何文件夹都能直接用浏览器打开。它不运行任何程序，所以不需要 Gatekeeper 授权。它不再跳转到 `/Applications` 里的程序：从访达打开网页时，Safari 的沙盒只允许该网页读取它所在的文件夹，复制到桌面的跳转页在 Safari 里会找不到程序（macOS 15 + Safari 26.6.1 上实测）。
  - 包文件夹名用 ASCII，Finder 通过 `InfoPlist.strings` 显示中文名。磁盘映像是 HFS+、zlib 压缩（UDZO），macOS 10.11 起都能直接打开。
- **Windows**：NSIS 安装程序（`windows/installer.nsi`）按当前用户安装到 `%LOCALAPPDATA%\Programs\PKUNMUN2026Formatter`，无需管理员权限。
  - 在桌面和开始菜单创建快捷方式，并在“应用和功能”中登记卸载项。支持 `/S` 静默安装。
  - 安装程序和启动器都是 32 位 Unicode 程序，可运行于 32/64 位 Windows 7–11 和 ARM 电脑。它们声明支持高 DPI，在高分屏上不模糊。
  - 快捷方式指向 `windows/launcher.nsi` 编译出的小程序。它用 `windows/browsers.nsh` 选浏览器：
    - 先看默认浏览器，是 Edge、Chrome、Brave、Vivaldi 或 Firefox 就用它；
    - 否则通过 App Paths（两个注册表视图）和常见安装目录查找这几个浏览器；
    - 读取浏览器文件版本，低于页面要求的只在别无选择时使用。
  - Chromium 系以 `--app` 窗口打开，并带 `--no-first-run`，未用过的 Edge/Chrome 不会先弹欢迎页；Firefox 开新窗口；都没有时交给默认浏览器。
  - 安装完成页同样检查一遍。没有找到够新的浏览器时，提示 Windows 7/8.1 可装 Chrome 109 或 Firefox ESR 115。
  - 安装路径超过 200 个字符时拒绝安装，免得深层文件超出 Windows 的路径长度限制。
  - 安装和运行过程都不下载任何东西。

## 构建

```sh
pnpm install --frozen-lockfile
pnpm build:desktop          # = node desktop/build-desktop.mjs --publish
```

依次执行 `scripts/build-static.mjs`，生成 `dist/desktop/site/`，然后输出：

- `dist/desktop/PKUNMUN2026-Formatter-macOS.dmg`
- `dist/desktop/PKUNMUN2026-Formatter-Windows-Setup.exe`

加 `--publish` 时会把两个安装包复制到 `downloads/`，并更新 `SHA256SUMS.txt` 里它们的两行（APK 那一行由 `android/build-apk.mjs --publish` 维护）。只调试一种安装包时用 `--only site|mac|win`。

所需工具：

| 产物 | macOS 上 | Linux 上 |
|---|---|---|
| DMG | 系统自带 `codesign`、`hdiutil` | 见下方列表 |
| EXE | `brew install makensis` | `apt install nsis`（NSIS 3）。脚本会自动以 UTF-8 语言环境运行它，否则 makensis 遇到中文文件名会崩溃。Windows 上可 `choco install nsis`。 |

Linux 上构建 DMG 需要：

- `rcodesign`（`cargo install apple-codesign --version 0.29.0 --locked`，用 `RCODESIGN=` 指定路径）：签名。
- `mkfs.hfsplus`（apt `hfsprogs`）：建 HFS+ 卷。
- [libdmg-hfsplus](https://github.com/mozilla/libdmg-hfsplus) 的 `hfsplus` 与 `dmg`（用 `HFSPLUS_TOOL=`、`DMG_TOOL=` 指定路径）。Firefox 在 Linux 上制作 macOS 镜像也走这条路。
  - 先在 ec23959 上打 `macos/libdmg-hfsplus.patch`，再 `cmake -B build && cmake --build build`。补丁修两处：
    - 上游逐字节复制文件名，中文名在 Finder 里会成乱码；
    - 上游按目录读取顺序写入，不同文件系统做出的镜像字节不同。
  - 构建脚本会检查卷里的中文名，没打补丁会直接报错。
- `libfaketime`（apt `faketime`）：固定卷内时间戳；没有时镜像照样可用，只是不能逐字节复现。

时间戳固定为最近一次修改 `VERSION` 的提交时间，HFS+ 卷标识由版本号派生，目录按名称排序，所以同一份源码在任何 Linux 机器上都做出同样字节的安装包。CI 每次都重建一遍，并与 `downloads/SHA256SUMS.txt` 逐字节比对。版本号变化后，`tests/desktop.test.mjs` 会提示重新运行 `pnpm build:desktop`。

改动图标、安装程序侧边图或 macOS 入口程序后：

```sh
node desktop/icons/make-icons.mjs        # 重新生成 AppIcon.icns 与 sidebar.bmp（需要 Playwright 与 ImageMagick）
python3 desktop/macos/make-dmg-layout.py # 重新生成 DMG 窗口布局（需要 pip 包 ds_store）
desktop/macos/build-stub.sh              # 重新编译 launcher-stub（macOS 用 clang；Linux 用 zig + llvm-lipo）
```

## 验证

```sh
pnpm test:desktop
MUNWORD_TEST_SHELLS=/path/to/bash-3.2:/bin/zsh:/bin/bash node --test tests/desktop.test.mjs   # 启动脚本在多种 shell 下的测试
```

包含两部分：

- **单元测试**：
  - 页面改写与 CSP；
  - 加载脚本：用 jsdom 模拟新旧浏览器，并检查旧浏览器能解析它的语法；
  - macOS 启动脚本：用替身命令检验浏览器选择、Safari 版本判断、含空格和中文路径的 URL 编码、各级回退与报错；
  - 通用入口程序：两个架构，以及从 Mach-O 读出的真实最低系统版本与 `Info.plist` 一致；
  - 安装脚本的关键设置与签名接口；
  - 已发布安装包的校验和与版本号。
- **离线冒烟测试**：真实浏览器从 `file://` 打开页面，11 份验收原稿（六种文书、中英文）逐份走完整流程，最后用模板新建一份：
  - 流程：选类型 → 上传 → 识别 → 确认第三步可编辑（测试不代填）→ 生成下载并读回 ZIP → 原稿与成稿预览；
  - 期间出现任何网络请求即失败，并确认页面自身的 CSP 会拒绝 fetch 和远程图片；
  - 另外检查旧浏览器看到的说明，以及磁盘映像里网页入口的跳转。

### 原生系统验收（GitHub Actions）

`.github/workflows/offline-installers.yml` 在 GitHub 的托管虚拟机上检查 `downloads/` 里已发布的两个安装包，结果和截图保存为构建产物。仓库公开，托管机器不收费。

| 作业 | 机器 | 检查内容 |
|---|---|---|
| 重建比对 | Ubuntu 24.04 | 从源码重建两个安装包，与 `SHA256SUMS.txt` 逐字节一致；Playwright Chromium 跑全部原稿；Chromium 98 必须看到说明，99 与 109（Win7 最后版本）必须完整跑通，成品与新版逐部件相同（`acceptance/browser-floor.mjs`） |
| Wine | Ubuntu 24.04 | 32 位 Windows 7 与 64 位 Windows 10 前缀，31 项：静默安装、11 种浏览器组合、含空格/中文/#/% 的路径、卸载（`acceptance/wine/scenarios.sh`） |
| Windows | Windows Server 2022 x64、Windows 11 ARM | 先装 1.8.4 再升级、快捷方式与卸载项、启动器真的拉起浏览器独立窗口且 URL 转义正确、系统自带的 Edge/Chrome/Firefox 跑全部原稿和模板、卸载（`acceptance/windows.py`） |
| macOS | macOS 14 Apple 芯片、macOS 15 Apple 芯片、macOS 15 Intel | `hdiutil verify`；中文文件名；Apple `codesign --verify --deep --strict` 通过（即不会“已损坏”）；记录 Gatekeeper 在有无下载隔离属性时的判定；原生运行入口程序；通过 LaunchServices 真实打开；Chrome/Firefox 跑全部原稿和模板，再跑复制到桌面的单文件页面；Safari 跑全部原稿和模板（见下）；Safari 像用户那样从访达打开程序、磁盘映像里的网页和复制到桌面的网页，并通过辅助功能读取 Safari 实际显示的内容（`acceptance/macos.py`） |

浏览器全流程由 `acceptance/browser_flow.py`（Selenium）驱动机器上真实安装的浏览器，不是测试工具自带的浏览器。各浏览器的文件选择框无法统一自动化，所以原稿通过 DataTransfer 交给页面，成品从下载链接背后的 Blob 读回。

Safari 26 的自动化驱动（safaridriver）拒绝打开任何 file:// 网页（“outside the sandbox”），不论文件在临时文件夹还是 `/Applications`。所以 Safari 的全流程在同一份已安装页面上进行，页面经 `http://127.0.0.1` 提供；file:// 这条用户实际路径另由 LaunchServices 打开、辅助功能读回来验证（类型卡片已渲染、地址是对应的本机文件）。

这些机器不能代表所有硬件和系统版本：

- 没有真正的 32 位 Windows 7 硬件，Win7 只在 Wine 里验证；
- 也没有 macOS 10.11–13，旧 macOS 的支持依据二进制的最低版本和 Safari/Chrome 的版本门槛。

## 签名与公证

两个安装包默认没有付费的代码签名（macOS 只有 ad-hoc 签名），第一次打开时系统会提示一次，处理方法见根目录 README。

取得证书后，构建时设置环境变量即可，不需要改动本目录的设计。证书、私钥和密码不要写进仓库或安装包。

| 用途 | macOS 上构建 | Linux 上构建 |
|---|---|---|
| Developer ID 签名（开启 hardened runtime） | `MUNWORD_MAC_SIGN_IDENTITY="Developer ID Application: …"` | `MUNWORD_MAC_P12=… MUNWORD_MAC_P12_PASSWORD_FILE=…` |
| 公证并装订（之后 macOS 不再提示） | `MUNWORD_NOTARY_PROFILE=<notarytool 钥匙串配置>` | `MUNWORD_NOTARY_API_KEY=<App Store Connect API 密钥 JSON>` |
| Windows Authenticode（启动器、安装程序、卸载程序） | — | `MUNWORD_WIN_PFX=… MUNWORD_WIN_PFX_PASSWORD_FILE=…`，可选 `MUNWORD_WIN_TIMESTAMP_URL`；需要 `osslsigncode` |

签名过的安装包带签名时间，不再逐字节可复现。Linux 上的两条签名路径已用自签名测试证书验证：

- `osslsigncode verify` 通过；
- rcodesign 写入了 hardened runtime 和证书签名。

公证需要真实的 Apple 账号，没有验证过。
