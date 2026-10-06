"""Stage the GitHub Release of the offline installers from one workflow run, only if everything passed.

    python desktop/acceptance/stage_release.py --artifacts <downloaded artifacts> --out <dir> --run-url <url> --commit <sha> --repo <owner/name>

Refuses to stage anything unless the published files match downloads/SHA256SUMS.txt, the Linux rebuild
matched them, the oldest-Chromium check passed, both Wine prefixes passed every scenario, and every native
Windows and macOS acceptance report says passed. Writes the installers, SHA256SUMS.txt, a verification ZIP
(all reports, logs and screenshots) and notes.md for the release body.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
DMG = "PKUNMUN2026-Formatter-macOS.dmg"
EXE = "PKUNMUN2026-Formatter-Windows-Setup.exe"
NATIVE = {
    "acceptance-windows-2022": ("windows.json", "Windows Server 2022 x64"),
    "acceptance-windows-11-arm": ("windows.json", "Windows 11 ARM"),
    "acceptance-macos-14": ("macos.json", "macOS 14 Apple 芯片"),
    "acceptance-macos-15": ("macos.json", "macOS 15 Apple 芯片"),
    "acceptance-macos-15-intel": ("macos.json", "macOS 15 Intel"),
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--run-url", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--repo", required=True, help="owner/name, for links to other releases")
    args = parser.parse_args()
    problems = []

    sums = {}
    for line in (ROOT / "downloads" / "SHA256SUMS.txt").read_text(encoding="utf-8").splitlines()[1:]:
        digest, name = line.split()
        sums[name] = digest
    if sorted(sums) != sorted([DMG, EXE]):
        problems.append(f"SHA256SUMS.txt lists {sorted(sums)}")
    for name, digest in sums.items():
        if sha256(ROOT / "downloads" / name) != digest:
            problems.append(f"downloads/{name} does not match SHA256SUMS.txt")
        rebuilt = args.artifacts / "linux-rebuild-and-page" / "dist" / "desktop" / name
        if not rebuilt.is_file() or sha256(rebuilt) != digest:
            problems.append(f"the Linux rebuild of {name} differs from the published file")

    floor_file = next((args.artifacts / "linux-rebuild-and-page").rglob("browser-floor.json"), None)
    floor = json.loads(floor_file.read_text(encoding="utf-8")) if floor_file else []
    if len(floor) != 3 or not all(row.get("passed") for row in floor):
        problems.append("the oldest-Chromium check did not pass")

    wine = {}
    for flavor in ("win7", "win10"):
        log = args.artifacts / "wine-scenarios" / f"{flavor}.txt"
        last = log.read_text(encoding="utf-8").strip().splitlines()[-1] if log.is_file() else ""
        wine[flavor] = last
        if not last.endswith("failed 0"):
            problems.append(f"Wine {flavor}: {last or 'no result'}")

    native = {}
    for artifact, (report_name, label) in NATIVE.items():
        report_file = args.artifacts / artifact / report_name
        report = json.loads(report_file.read_text(encoding="utf-8")) if report_file.is_file() else {}
        native[label] = report
        if report.get("passed") is not True:
            problems.append(f"{label}: {report.get('error', 'no acceptance report')}")

    if problems:
        print("Not publishing:\n  " + "\n  ".join(problems))
        return 1

    args.out.mkdir(parents=True, exist_ok=True)
    for name in (DMG, EXE, "SHA256SUMS.txt"):
        shutil.copyfile(ROOT / "downloads" / name, args.out / name)
    with zipfile.ZipFile(args.out / f"PKUNMUN2026-{VERSION}-Verification.zip", "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(args.artifacts.rglob("*")):
            if path.is_file() and path.suffix in (".json", ".txt", ".png") and "dist" not in path.parts:
                bundle.write(path, "evidence/" + path.relative_to(args.artifacts).as_posix())
        bundle.writestr("build-provenance.json", json.dumps({"version": VERSION, "commit": args.commit, "run": args.run_url, "sha256": sums}, indent=2))

    def browsers(report):
        names = {"edge": "Edge", "chrome": "Chrome", "firefox": "Firefox", "safari": "Safari"}
        rows = [f"{names.get(name, name)} {data.get('version')}" for name, data in (report.get("browsers") or {}).items() if data.get("passed")]
        return "、".join(rows) or "—"

    native_rows = "\n".join(f"| {label} | {browsers(report)} |" for label, report in native.items())
    floor_rows = "；".join(f"Chromium {row['milestone']} {'显示升级说明' if row['expect'] == 'notice' else '完整跑通'}" for row in floor)
    notes = f"""## 下载

| 系统 | 文件 | 安装 |
|---|---|---|
| macOS 10.11 及以上，Intel 与 Apple 芯片通用 | `{DMG}` | 双击打开，把「PKUNMUN 2026 文件排版系统」拖进「应用程序」 |
| Windows 7 / 8.1 / 10 / 11，32 位、64 位与 ARM | `{EXE}` | 双击运行，点「安装」；桌面出现快捷方式 |

每个安装包约 0.5 MB。排版完全在本机浏览器里完成：不联网、不上传文件，不需要 Python、账号或管理员权限，也没有后台进程。浏览器需要 Edge/Chrome 99、Firefox 104 或 Safari 15.4 以上（Windows 7/8.1 可用 Chrome 109 或 Firefox ESR 115）；浏览器过旧时页面会说明该装哪个。

**第一次打开**：安装包没有付费的开发者签名。
- macOS 15 及以后：先双击一次，再到「系统设置 → 隐私与安全性」点「仍要打开」。
- macOS 14 及以前：按住 Control 点按程序 → 打开。
- 不想改任何设置：双击磁盘映像里的「直接用浏览器打开.html」，不需要任何授权。
- Windows SmartScreen：点「更多信息 → 仍要运行」。

## 相对上一版 v1.8.5-desktop 的更新

上一版是另一套自带 Python 运行环境的 Munword 安装包，仍可在 [v1.8.5-desktop](https://github.com/{args.repo}/releases/tag/v1.8.5-desktop) 下载。本版：
- **一个包通用**：macOS 不再分 Apple 芯片/Intel，Windows 不再分 x64/x86；每个约 0.5 MB（上一版 5.9–10.2 MB）。
- **兼容更多系统**：Windows 7、8.1 和 32 位系统可用；macOS 从 10.11 起可用（上一版要求 Windows 10、macOS 11）。
- **浏览器门槛按实测**：Chrome/Edge 99 起可用（上一版要求 111，会拒绝 Windows 7 上能装的最后版本 Chrome 109）。
- **打开即用**：在 Edge/Chrome 里以独立窗口打开，不占端口、不常驻后台、不触发防火墙。
- **macOS 少弹窗**：原生通用程序，Apple 芯片不要求安装 Rosetta；签名覆盖全部资源，不会报“已损坏”；另附免授权的网页入口。
- **中文名称正常**：上一版 Windows 安装包的桌面快捷方式、开始菜单和“应用和功能”里的中文名称显示为乱码（构建时未按 UTF-8 读取安装脚本），本版没有这个问题；源码里的 Munword 构建脚本也已修复。

## 验收（本次构建）

[工作流记录]({args.run_url})，源码提交 `{args.commit}`。

- 从源码在 Linux 上重建，两个安装包与发布文件逐字节一致。
- 11 份验收原稿（六种文书、中英文）逐份上传、识别、确认第三步可编辑、生成、读回、预览，外加模板新建；页面零网络请求。
- 浏览器门槛实测：{floor_rows}。
- Wine：Windows 7 32 位、Windows 10 64 位各 {wine['win7'].split('passed ')[-1].split(',')[0]} 项场景全部通过（浏览器选择、安装路径、卸载）。

| 原生系统 | 跑通全部原稿的系统浏览器 |
|---|---|
{native_rows}

Windows 上还验证了从 1.8.4 升级、启动器拉起浏览器独立窗口、卸载。macOS 上还验证了 `hdiutil verify`、Apple `codesign --verify --deep --strict`、原生入口程序和 LaunchServices 打开。详细记录和截图见 `PKUNMUN2026-{VERSION}-Verification.zip`。

## 校验值

```
{chr(10).join(f'{digest}  {name}' for name, digest in sums.items())}
```
"""
    (args.out / "notes.md").write_text(notes, encoding="utf-8")
    print("Staged:", ", ".join(sorted(p.name for p in args.out.iterdir())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
