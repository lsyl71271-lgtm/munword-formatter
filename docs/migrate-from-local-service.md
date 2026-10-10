# 从旧版本机服务换到桌面安装包

桌面安装包出现之前，本程序用 `首次安装.command`（macOS）或 `Windows 首次安装.bat` 安装：它们装一个 Python 运行环境，在后台常驻一个本机服务（`127.0.0.1:8000`），再用浏览器打开页面。现在的桌面安装包（DMG / EXE）不需要 Python，也没有后台服务，断网可用，界面和排版结果与网页版完全一样。

换装不影响你的 DOCX 文件：旧版只把程序装在下面列出的目录里，从不移动或修改你的文档。

**顺序：Windows 请先删旧版、再装新版。** 旧版卸载时会删除桌面上名为「PKUNMUN 2026 文件排版系统」的快捷方式，而新版的桌面快捷方式同名；先装新版再卸旧版，新版的快捷方式会被一起删掉（程序本身不受影响，从开始菜单仍能打开）。macOS 两个版本互不影响，顺序随意。

## 1. 删除旧版

见下面「删除旧版的具体步骤」，按你的系统操作。

## 2. 装新版

到下载页（<https://github.com/lsyl71271-lgtm/munword-formatter/releases/latest>）下载 macOS 的 DMG 或 Windows 的 EXE，按安装教程（同一页面的「安装教程（先看这个）.txt」）安装、打开，用一份文件试一下。

## 删除旧版的具体步骤

### Windows

旧版装在 `%LOCALAPPDATA%\PKUNMUN2026Formatter`（新版在 `%LOCALAPPDATA%\Programs\PKUNMUN2026Formatter`，两者不同）。

- 开始菜单 →「PKUNMUN 2026」文件夹 →「卸载」，按提示确认即可：会停止后台服务、删除快捷方式、删除 Python 运行环境和程序文件。
- 开始菜单里找不到「卸载」时：打开当初解压的发布包文件夹，在地址栏输入 `powershell -NoProfile -ExecutionPolicy Bypass -File windows\uninstall.ps1` 回车。
- 注意不要误点新版的卸载：新版的卸载在「设置 → 应用」里，名称同样是「PKUNMUN 2026 文件排版系统」，版本号为 2.0.0 或更高。

### macOS

旧版是登录后自动启动的后台服务（`org.pkunmun.formatter.2026.local`），程序在「~/Library/Application Support/PKUNMUN2026Formatter」。打开「终端」，逐行粘贴：

```sh
launchctl bootout "gui/$(id -u)/org.pkunmun.formatter.2026.local" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/org.pkunmun.formatter.2026.local.plist"
rm -rf "$HOME/Library/Application Support/PKUNMUN2026Formatter"
```

第一行停止后台服务，第二行取消登录自启动，第三行删除程序和 Python 运行环境。新版装在「应用程序」里，不受影响。

## 3. 确认

- 浏览器打开 `http://127.0.0.1:8000`，应当打不开了（旧服务已停止）。
- 新版从「应用程序」（macOS）或桌面快捷方式（Windows）打开，页脚显示 2.0.0 或更高的版本号。

## 仍想继续用旧版

旧版的安装脚本仍保留在仓库里（开发者也用它跑 Python 兼容引擎），但不再随版本更新提供新功能的安装包；它与新版界面相同，排版结果一致。普通用户请使用桌面安装包或网页版。
