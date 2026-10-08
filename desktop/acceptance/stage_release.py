"""Stage the GitHub Release of the offline installers from one workflow run, only if everything passed.

    python desktop/acceptance/stage_release.py --artifacts <downloaded artifacts> --out <dir> --run-url <url> --commit <sha> --repo <owner/name>

Refuses to stage anything unless the published files match downloads/SHA256SUMS.txt, the Linux rebuild
matched them (DMG and EXE byte for byte, the APK's contents and pinned signature), the oldest-Chromium checks
passed (desktop page and Android page), both Wine prefixes passed every scenario, and every native Windows and
macOS acceptance report and every Android emulator report says passed. Writes the installers, SHA256SUMS.txt,
a verification ZIP (all reports, logs and screenshots) and notes.md for the release body.
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
APK = "PKUNMUN2026-Formatter-Android.apk"
GUIDE = "PKUNMUN2026-Install-Guide.txt"  # step-by-step install guide for end users
NATIVE = {
    "acceptance-windows-2022": ("windows.json", "Windows Server 2022 x64"),
    "acceptance-windows-11-arm": ("windows.json", "Windows 11 ARM"),
    "acceptance-macos-14": ("macos.json", "macOS 14 Apple 芯片"),
    "acceptance-macos-15": ("macos.json", "macOS 15 Apple 芯片"),
    "acceptance-macos-15-intel": ("macos.json", "macOS 15 Intel"),
}
# Android emulators (the android-devices matrix in offline-installers.yml): API level → release.
ANDROID = {21: "5.0", 23: "6.0", 26: "8.0", 28: "9", 29: "10", 30: "11", 31: "12", 33: "13", 34: "14", 35: "15"}


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
    if sorted(sums) != sorted([APK, DMG, EXE]):
        problems.append(f"SHA256SUMS.txt lists {sorted(sums)}")
    for name, digest in sums.items():
        if sha256(ROOT / "downloads" / name) != digest:
            problems.append(f"downloads/{name} does not match SHA256SUMS.txt")
        if name == APK:
            continue
        rebuilt = args.artifacts / "linux-rebuild-and-page" / "dist" / "desktop" / name
        if not rebuilt.is_file() or sha256(rebuilt) != digest:
            problems.append(f"the Linux rebuild of {name} differs from the published file")

    android_dir = args.artifacts / "android-build" / "output" / "android"
    apk_report = json.loads((android_dir / "apk.json").read_text(encoding="utf-8")) if (android_dir / "apk.json").is_file() else {}
    if apk_report.get("passed") is not True or apk_report.get("sha256") != sums.get(APK):
        failed = [c["name"] for c in apk_report.get("checks", []) if not c.get("ok")]
        problems.append(f"the APK rebuild and signature check did not pass: {failed or 'no report'}")
    webview_file = android_dir / "webview-floor" / "webview-floor.json"
    webview_floor = json.loads(webview_file.read_text(encoding="utf-8")) if webview_file.is_file() else []
    if len(webview_floor) < 8 or not all(row.get("passed") for row in webview_floor) or not any(row.get("expect") == "notice" for row in webview_floor):
        problems.append("the Android page's Chromium check did not pass")
    devices = {}
    for api, release in ANDROID.items():
        report_file = args.artifacts / f"android-api{api}" / "emulator.json"
        report = json.loads(report_file.read_text(encoding="utf-8")) if report_file.is_file() else {}
        devices[api] = report
        if report.get("passed") is not True:
            problems.append(f"Android {release} (API {api}): {str(report.get('error', 'no emulator report')).splitlines()[0]}")

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

    guide = ROOT / "downloads" / GUIDE
    if not guide.is_file() or VERSION not in guide.read_text(encoding="utf-8-sig") or any(d not in guide.read_text(encoding="utf-8-sig") for d in sums.values()):
        problems.append(f"downloads/{GUIDE} is missing or does not name version {VERSION} and the current checksums")

    if problems:
        print("Not publishing:\n  " + "\n  ".join(problems))
        return 1

    args.out.mkdir(parents=True, exist_ok=True)
    for name in (DMG, EXE, APK, "SHA256SUMS.txt", GUIDE):
        shutil.copyfile(ROOT / "downloads" / name, args.out / name)
    with zipfile.ZipFile(args.out / f"PKUNMUN2026-{VERSION}-Verification.zip", "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(args.artifacts.rglob("*")):
            if path.is_file() and path.suffix in (".json", ".txt", ".png") and "dist" not in path.parts:
                bundle.write(path, "evidence/" + path.relative_to(args.artifacts).as_posix())
        bundle.writestr("build-provenance.json", json.dumps({"version": VERSION, "commit": args.commit, "run": args.run_url, "sha256": sums, "android_certificate": apk_report.get("certificate")}, indent=2))

    def browsers(report):
        names = {"edge": "Edge", "chrome": "Chrome", "firefox": "Firefox", "safari": "Safari"}
        rows = [f"{names.get(name, name)} {data.get('version')}" + ("（全流程经本机 http 地址）" if str(data.get("page_url", "")).startswith("http") else "")
                for name, data in (report.get("browsers") or {}).items() if data.get("passed")]
        return "、".join(rows) or "—"

    native_rows = "\n".join(f"| {label} | {browsers(report)} |" for label, report in native.items())
    floor_rows = "；".join(f"Chromium {row['milestone']} {'显示升级说明' if row['expect'] == 'notice' else '完整跑通'}" for row in floor)
    webview_rows = "、".join(str(row["milestone"]) for row in webview_floor if row.get("expect") == "flow")
    webview_notice = "、".join(str(row["milestone"]) for row in webview_floor if row.get("expect") == "notice")
    device_rows = "\n".join(
        f"| Android {ANDROID[api]}（API {api}） | {report.get('webview')} | "
        + (f"全部 {len(report.get('cases', []))} 份原稿完整跑通；保存到「下载」、打开方式与分享传入" if report.get("mode") == "app" else "显示「更新系统 WebView」说明；保存到「下载」、打开方式与分享传入")
        + ("；存储权限弹窗" if any(step.get("name") == "storage permission prompt shown and allowed" for step in report.get("steps", [])) else "") + " |"
        for api, report in devices.items())
    notes = f"""## 下载

| 系统 | 文件 | 安装 |
|---|---|---|
| macOS 10.11 及以上，Intel 与 Apple 芯片通用 | `{DMG}` | 双击打开，把「PKUNMUN 2026 文件排版系统」拖进「应用程序」 |
| Windows 7 / 8.1 / 10 / 11，32 位、64 位与 ARM | `{EXE}` | 双击运行，点「安装」；桌面出现快捷方式 |
| Android 5.0 及以上手机、平板（系统 WebView 69 或更高） | `{APK}` | 在手机上下载后点开安装，按提示允许「安装未知应用」 |
| 安装教程（先看这个） | `{GUIDE}` | 苹果电脑、Windows 与安卓手机的手把手安装步骤、弹窗处理、系统、浏览器和 WebView 过旧时怎么更新 |

DMG 约 0.8 MB，EXE 约 0.5 MB，APK 约 0.4 MB。排版完全在本机完成：不联网、不上传文件，不需要 Python、账号或管理员权限，也没有后台进程。Android 版没有联网权限；成品保存到手机的「下载」文件夹，可直接用 WPS 或 Word 打开、分享；也可以在微信、QQ 或文件管理里对 DOCX 选「其他应用打开」→「PKUNMUN 排版」。浏览器需要 Edge/Chrome 99、Firefox 104 或 Safari 15.4 以上（Windows 7/8.1 可用 Chrome 109 或 Firefox ESR 115）；浏览器过旧时页面会说明该装哪个。

**第一次打开**：安装包没有付费的开发者签名。
- macOS 15 及以后：先双击一次，再到「系统设置 → 隐私与安全性」点「仍要打开」。
- macOS 14 及以前：按住 Control 点按程序 → 打开。
- 不想改任何设置：双击磁盘映像里的「直接用浏览器打开.html」，不需要任何授权。它就是完整的排版页面（单个网页文件），可拖到桌面长期使用。
- Windows SmartScreen：点「更多信息 → 仍要运行」。
- Android：系统会提示「安装未知应用」，按提示允许本次来源（浏览器或文件管理）后安装；部分手机还会显示「未经检测的应用」，选「继续安装」。

## 验收（本次构建）

[工作流记录]({args.run_url})，源码提交 `{args.commit}`。

- 从源码在 Linux 上重建，两个安装包与发布文件逐字节一致。
- 11 份验收原稿（六种文书、中英文）逐份上传、识别、确认第三步可编辑、生成、读回、预览，外加模板新建；页面零网络请求。
- 浏览器门槛实测：{floor_rows}。
- Wine：Windows 7 32 位、Windows 10 64 位各 {wine['win7'].split('passed ')[-1].split(',')[0]} 项场景全部通过（浏览器选择、安装路径、卸载）。
- Android：从源码重建 APK，内容与发布文件逐项一致，签名证书与仓库登记的指纹一致（`android/signing-cert.sha256`）。手机页面在 Chromium {webview_rows} 中跑通全部原稿、成品与新版逐部件相同；Chromium {webview_notice} 显示「更新 WebView」说明。

| 原生系统 | 跑通全部原稿的系统浏览器 |
|---|---|
{native_rows}

| Android 模拟器（系统自带、未更新的 WebView） | WebView | 结果 |
|---|---|---|
{device_rows}

Windows 上还验证了从 1.8.4 升级、启动器拉起浏览器独立窗口、卸载。macOS 上还验证了 `hdiutil verify`、Apple `codesign --verify --deep --strict`、原生入口程序和 LaunchServices 打开；单文件网页「直接用浏览器打开.html」单独复制后在 Chrome、Firefox 里跑通。Safari 的自动化驱动不允许打开本机文件，所以 Safari 的全流程经本机 http 地址进行；另外像用户那样从访达打开程序、磁盘映像里的网页和复制到桌面的网页，由辅助功能读回 Safari 实际显示的页面。详细记录和截图见 `PKUNMUN2026-{VERSION}-Verification.zip`。

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
