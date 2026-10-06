# 桌面安装包（macOS DMG / Windows EXE）

给普通用户的一键安装版。运行时完全在本机，不联网、不需要 Python 或任何运行环境。
下载与安装说明见仓库根目录 README 的「下载桌面版」一节，成品放在 `downloads/`。

## 工作方式

- **同一套界面和引擎**：安装包里的页面就是 Cloudflare Pages 使用的 `pnpm build:static` 产物。脚本逐个核对构建记录里的 SHA-256 后才复制，不另建界面或排版流程。
- **离线页面**：`desktop/build-desktop.mjs` 只做三件事：
  - 把资源路径改成相对路径，使页面能从 `file://` 打开；
  - 写入 `Content-Security-Policy`；
  - 修改 `<noscript>` 提示语。
- **禁止联网**：`Content-Security-Policy` 设为 `connect-src 'none'`，禁止 fetch/XHR/WebSocket、远程图片和字体，也禁止表单提交。即使页面代码尝试联网，浏览器也会拒绝。`desktop/offline-smoke.mjs` 专门验证这一点。
- **macOS**：`PKUNMUN2026.app` 的可执行文件是 `macos/launcher.sh`，与 macOS 自带的 bash 3.2 兼容。
  - 它打开 `Contents/Resources/site/index.html`。已安装 Chrome、Edge、Brave 或 Chromium 时，以 `--app` 独立窗口打开；否则用 Safari。
  - 不启动服务，不常驻后台，也不写用户目录。
  - 包文件夹名用 ASCII，Finder 通过 `InfoPlist.strings` 显示中文名。
- **Windows**：NSIS 安装程序（`windows/installer.nsi`）按当前用户安装到 `%LOCALAPPDATA%\Programs\PKUNMUN2026Formatter`，无需管理员权限。
  - 在桌面和开始菜单创建快捷方式，并在“应用和功能”中登记卸载项。支持 `/S` 静默安装。
  - 快捷方式指向 `windows/launcher.nsi` 编译出的小程序：依次查找 Edge、Chrome，以 `--app` 窗口打开页面；都没有时用默认浏览器。
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
| DMG | 系统自带 `hdiutil` | `xorrisofs`（apt `xorriso`），以及 [libdmg-hfsplus](https://github.com/fanquake/libdmg-hfsplus) 的 `dmg` 工具（`cmake -B build && make -C build`，用 `DMG_TOOL=` 指定路径）。Bitcoin Core 在 Linux 上制作 macOS 镜像也走这条路。 |
| EXE | `brew install makensis` | `apt install nsis`（NSIS 3）。脚本会自动以 UTF-8 语言环境运行它，否则 makensis 遇到中文文件名会崩溃。Windows 上可 `choco install nsis`。 |

时间戳固定为最近一次修改 `VERSION` 的提交时间，同一份源码可以逐字节复现同样的安装包；`downloads/SHA256SUMS.txt` 可用来核对。版本号变化后，`tests/desktop.test.mjs` 会提示重新运行 `pnpm build:desktop`。

改动图标或安装程序侧边图后：

```sh
node desktop/icons/make-icons.mjs        # 重新生成 AppIcon.icns 与 sidebar.bmp（需要 Playwright 与 ImageMagick）
python3 desktop/macos/make-dmg-layout.py # 重新生成 DMG 窗口布局（需要 pip 包 ds_store）
```

## 验证

```sh
pnpm test:desktop
```

包含两部分：

- **单元测试**：页面改写、CSP、macOS 启动器（用替身命令检验浏览器选择、含空格和中文路径的 URL 编码、各级回退与报错）、安装脚本的关键设置，以及已发布安装包的校验和与版本号。
- **离线冒烟测试**：真实浏览器从 `file://` 打开页面，走完整流程（选类型 → 上传 → 识别 → 预览 → 生成下载）。期间出现任何网络请求即失败，并确认页面自身的 CSP 会拒绝 fetch 和远程图片。

发布前已在 Linux 上用 Wine 9（32 位）验证 Windows 安装包：

- 静默安装后文件和快捷方式齐全，卸载项正确；
- 启动器能找到默认位置的 Edge、通过 App Paths 注册的 Chrome，并正确转义含空格、中文和 `#` 的安装路径；
- 静默卸载会删除文件、快捷方式和注册表项；
- 安装向导两页的界面已截图检查。

macOS 安装包的检查：

- 用 xorriso 读回镜像，确认启动器可执行、`Applications` 是符号链接、中文文件名为 UTF-8；
- 启动器逻辑由上述单元测试覆盖。

## 未签名的说明

两个安装包都没有付费的代码签名，第一次打开时系统会提示一次，处理方法见根目录 README。

如果以后取得 Apple Developer ID 或 Windows 代码签名证书，可以在构建后签名，并对 DMG 做公证：

- macOS：`codesign` + `notarytool`，或在 Linux 上用 `rcodesign`；
- Windows：`osslsigncode`。

签名不需要改动本目录的任何设计。
