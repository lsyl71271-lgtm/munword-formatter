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
  - 整个 `.app` 做 ad-hoc 签名，封存全部资源（`Contents/_CodeSignature`）。原因有二：Apple 芯片只运行已签名的原生代码；签名没覆盖资源的程序会被报告为“已损坏”。ad-hoc 签名没有开发者身份，所以第一次打开时仍是 macOS 对网上下载程序的常规确认（见根目录 README）。
  - 磁盘映像里的 `直接用浏览器打开.html` 是一个普通网页，按顺序跳转到旁边程序包里的页面、`~/Applications` 或 `/Applications` 中已安装的页面。它不运行任何程序，所以不需要 Gatekeeper 授权。
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
  - 安装和运行过程都不下载任何东西。

## 构建

```sh
pnpm install --frozen-lockfile
pnpm build:desktop          # = node desktop/build-desktop.mjs --publish
```

依次执行 `scripts/build-static.mjs`，生成 `dist/desktop/site/`，然后输出：

- `dist/desktop/PKUNMUN2026-Formatter-macOS.dmg`
- `dist/desktop/PKUNMUN2026-Formatter-Windows-Setup.exe`

加 `--publish` 时会把两个安装包复制到 `downloads/`，并更新 `SHA256SUMS.txt`。只调试一种安装包时用 `--only site|mac|win`。

所需工具：

| 产物 | macOS 上 | Linux 上 |
|---|---|---|
| DMG | 系统自带 `codesign`、`hdiutil` | 见下方列表 |
| EXE | `brew install makensis` | `apt install nsis`（NSIS 3）。脚本会自动以 UTF-8 语言环境运行它，否则 makensis 遇到中文文件名会崩溃。Windows 上可 `choco install nsis`。 |

Linux 上构建 DMG 需要：

- `rcodesign`（`cargo install apple-codesign`，用 `RCODESIGN=` 指定路径）：ad-hoc 签名。
- `mkfs.hfsplus`（apt `hfsprogs`）：建 HFS+ 卷。
- [libdmg-hfsplus](https://github.com/mozilla/libdmg-hfsplus) 的 `hfsplus` 与 `dmg`（用 `HFSPLUS_TOOL=`、`DMG_TOOL=` 指定路径）。Firefox 在 Linux 上制作 macOS 镜像也走这条路。
  - 上游 `hfsplus` 逐字节复制文件名，中文名在 Finder 里会成乱码。先打 `macos/libdmg-hfsplus-utf8-names.patch`（针对 ec23959）再 `cmake -B build && cmake --build build`。
  - 构建脚本会检查卷里的中文名，没打补丁会直接报错。
- `libfaketime`（apt `faketime`）：固定卷内时间戳；没有时镜像照样可用，只是不能逐字节复现。

时间戳固定为最近一次修改 `VERSION` 的提交时间，HFS+ 卷标识由版本号派生，所以同一份源码可以逐字节复现同样的安装包；`downloads/SHA256SUMS.txt` 可用来核对。版本号变化后，`tests/desktop.test.mjs` 会提示重新运行 `pnpm build:desktop`。

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
  - 通用入口程序的两个架构；
  - 安装脚本的关键设置；
  - 已发布安装包的校验和与版本号。
- **离线冒烟测试**：真实浏览器从 `file://` 打开页面，走完整流程（选类型 → 上传 → 识别 → 预览 → 生成下载）。期间出现任何网络请求即失败，并确认页面自身的 CSP 会拒绝 fetch 和远程图片。

发布前的完整检查记录见提交说明。其中包括：

- 用 Wine（32 位 Windows 7 与 64 位 Windows 10 环境）安装、按多种浏览器组合启动、卸载 EXE；
- 用 Apple 的 bash 3.2.57 源码编译出的 shell 运行 macOS 启动脚本；
- 用独立脚本核对 ad-hoc 签名的每个哈希；
- 用 `fsck.hfsplus` 和 7-Zip 检查 HFS+ 卷与中文文件名。

## 未签名的说明

两个安装包都没有付费的代码签名（macOS 只有 ad-hoc 签名），第一次打开时系统会提示一次，处理方法见根目录 README。

如果以后取得 Apple Developer ID 或 Windows 代码签名证书，可以在构建后签名，并对 DMG 做公证。公证后 macOS 不再提示：

- macOS：`codesign --force --options runtime --sign "Developer ID Application: …" PKUNMUN2026.app`，然后 `xcrun notarytool submit … --wait` 和 `xcrun stapler staple`；在 Linux 上可用 `rcodesign sign --p12-file …` 与 `rcodesign notary-submit --staple`。
- Windows：`osslsigncode sign -pkcs12 … -t http://timestamp.digicert.com`，安装程序与启动器都要签。

签名不需要改动本目录的任何设计。
