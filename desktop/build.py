"""Build native DMG/EXE installers on their target OS; never cross-label binaries."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
from importlib.metadata import distribution
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import sysconfig
import struct

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "work" / "desktop"
DIST = ROOT / "dist" / "desktop"


def run(*args, **kwargs):
    subprocess.run([str(arg) for arg in args], cwd=ROOT, check=True, **kwargs)


def prepare_site() -> Path:
    spec = importlib.util.spec_from_file_location("local_build", ROOT / "scripts/verify-local-build.py")
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    verifier.verify(ROOT)
    site = WORK / "site"
    if site.exists():
        shutil.rmtree(site)
    site.mkdir(parents=True)
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    mapping = {
        "/": ("local_web/index.html", "index.html", "text/html; charset=utf-8"),
        "/app.js": ("public/local-app.js", "app.js", "text/javascript; charset=utf-8"),
        "/styles.css": ("public/local-styles.css", "styles.css", "text/css; charset=utf-8"),
        "/favicon.svg": ("public/favicon.svg", "favicon.svg", "image/svg+xml"),
        "/studio-tools.js": ("public/studio-tools.js", "studio-tools.js", "text/javascript; charset=utf-8"),
        "/desktop.js": ("desktop/desktop.js", "desktop.js", "text/javascript; charset=utf-8"),
    }
    for source in sorted((ROOT / "public/licenses").glob("*.txt")):
        mapping["/licenses/" + source.name] = (str(source.relative_to(ROOT)), "licenses/" + source.name, "text/plain; charset=utf-8")
    manifest = {"schema": 1, "version": version, "assets": {}}
    for route, (source, target, mime) in mapping.items():
        data = (ROOT / source).read_bytes()
        if route == "/":
            data = data.replace(b'<script src="/app.js" defer></script>', b'<script src="/desktop.js" defer></script>')
        destination = site / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        manifest["assets"][route] = {"file": target, "mime": mime, "sha256": hashlib.sha256(data).hexdigest()}
    # Runtime and bundler notices are local files too, not remote links.
    candidates = [Path(sys.base_prefix) / "LICENSE.txt", Path(sysconfig.get_path("stdlib")) / "LICENSE.txt"]
    source = next((path for path in candidates if path.is_file()), None)
    if source is None:
        raise ValueError("Python runtime license is missing from the build environment")
    target = "licenses/python.txt"
    data = source.read_bytes()
    (site / target).write_bytes(data)
    manifest["assets"]["/" + target] = {"file": target, "mime": "text/plain; charset=utf-8", "sha256": hashlib.sha256(data).hexdigest()}
    package = distribution("pyinstaller")
    license_file = next(file for file in package.files if str(file).endswith("licenses/COPYING.txt"))
    data = package.locate_file(license_file).read_bytes()
    target = "licenses/pyinstaller.txt"
    (site / target).write_bytes(data)
    manifest["assets"]["/" + target] = {"file": target, "mime": "text/plain; charset=utf-8", "sha256": hashlib.sha256(data).hexdigest()}
    (site / "desktop-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return site


def check_macos_floor(app: Path, minimum="11.0"):
    """Reject a misleading plist: check actual Mach-O deployment versions too."""
    ceiling = tuple(map(int, minimum.split(".")))
    binaries = []
    for path in app.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        with path.open("rb") as stream:
            magic = stream.read(4)
        if magic not in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"):
            continue
        text = subprocess.check_output(["/usr/bin/otool", "-l", str(path)], text=True)
        versions = []
        lines = text.splitlines()
        for index, line in enumerate(lines):
            if "LC_VERSION_MIN_MACOSX" in line or "LC_BUILD_VERSION" in line:
                for detail in lines[index + 1:index + 8]:
                    fields = detail.split()
                    if fields and fields[0] in ("version", "minos"):
                        versions.append(fields[1])
                        break
        if not versions:
            raise ValueError("No deployment version: " + str(path))
        for version in versions:
            parts = tuple(map(int, version.split(".")[:2]))
            if parts > ceiling:
                raise ValueError("Binary requires macOS %s, exceeds %s: %s" % (version, minimum, path))
        binaries.append({"file": str(path.relative_to(app)), "minimum": versions})
    if not binaries:
        raise ValueError("Application has no native binaries")
    (DIST / "macos-binary-minimums.json").write_text(json.dumps(binaries, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arch", choices=("x64", "x86", "arm64"), required=True)
    parser.add_argument("--site-only", action="store_true")
    args = parser.parse_args()
    if sys.platform == "win32" and (args.arch not in ("x64", "x86") or struct.calcsize("P") * 8 != (64 if args.arch == "x64" else 32)):
        raise ValueError("Windows package architecture must match the build Python (x64 or x86)")
    if sys.platform == "darwin" and args.arch not in ("x64", "arm64"):
        raise ValueError("macOS packages support x64/arm64 only")
    site = prepare_site()
    if args.site_only:
        print(site)
        return
    DIST.mkdir(parents=True, exist_ok=True)
    version = (ROOT / "VERSION").read_text().strip()
    flags = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--noupx", "--onedir", "--windowed",
             "--name", "Munword", "--distpath", str(WORK / "bundle"), "--workpath", str(WORK / "pyinstaller"),
             "--specpath", str(WORK), "--add-data", str(site) + os.pathsep + "site"]
    if sys.platform == "darwin":
        flags += ["--osx-bundle-identifier", "org.pkunmun.munword.desktop", "--target-architecture", "x86_64" if args.arch == "x64" else "arm64"]
        identity = os.environ.get("MUNWORD_MAC_SIGN_IDENTITY")
        if identity:
            flags += ["--codesign-identity", identity]
    elif sys.platform == "win32":
        flags += ["--icon", str(ROOT / "windows/app.ico")]
    elif sys.platform != "linux":
        raise ValueError("Unsupported build OS")
    run(*flags, ROOT / "desktop/launcher.py")
    if sys.platform == "darwin":
        app = WORK / "bundle/Munword.app"
        plist_path = app / "Contents/Info.plist"
        info = plistlib.loads(plist_path.read_bytes())
        info.update(CFBundleDisplayName="Munword 本机排版", CFBundleShortVersionString=version,
                    CFBundleVersion=version, LSMinimumSystemVersion="11.0", LSUIElement=True,
                    NSHighResolutionCapable=True)
        plist_path.write_bytes(plistlib.dumps(info))
        check_macos_floor(app)
        identity = os.environ.get("MUNWORD_MAC_SIGN_IDENTITY", "-")
        run("codesign", "--force", "--deep", "--options", "runtime", "--sign", identity, app)
        run("codesign", "--verify", "--deep", "--strict", "--verbose=2", app)
        folder = WORK / "dmg"
        if folder.exists():
            shutil.rmtree(folder)
        folder.mkdir()
        shutil.copytree(app, folder / app.name, symlinks=True)
        (folder / "Applications").symlink_to("/Applications")
        (folder / "安装说明.txt").write_text("将 Munword 拖到 Applications（应用程序），随后双击打开。全部排版组件已内置，安装和使用均无需联网。macOS 11+；需 Safari 16.4+、Chrome 111+ 或 Firefox 128+。\n" +
            ("此构建已使用 Developer ID 签名；公证状态见随包验证记录。\n" if identity != "-" else "此构建为临时签名，尚未 Apple 公证。macOS 可能要求在隐私与安全性中允许打开；不能承诺免安全提示。请勿关闭 Gatekeeper。\n"), encoding="utf-8")
        output = DIST / ("Munword-%s-macOS-%s.dmg" % (version, args.arch))
        output.unlink(missing_ok=True)
        run("hdiutil", "create", "-volname", "Munword " + version, "-srcfolder", folder, "-format", "UDZO", "-ov", output)
        profile = os.environ.get("MUNWORD_NOTARY_PROFILE")
        if profile:
            if identity == "-":
                raise ValueError("Notarization requires Developer ID signing")
            run("xcrun", "notarytool", "submit", output, "--keychain-profile", profile, "--wait")
            run("xcrun", "stapler", "staple", output)
            run("xcrun", "stapler", "validate", output)
    elif sys.platform == "win32":
        output = DIST / ("Munword-%s-Windows-%s-Setup.exe" % (version, args.arch))
        compiler = shutil.which("makensis") or str(Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")) / "NSIS/makensis.exe")
        # The script is UTF-8 without a BOM; without /INPUTCHARSET makensis reads it in the build machine's
        # ANSI code page (1252 on GitHub's runners) and every Chinese string, including the shortcut
        # and uninstall-entry names, ends up as mojibake such as "Munword æœ¬æœºæŽ’ç‰ˆ".
        run(compiler, "/INPUTCHARSET", "UTF8", "/DVERSION=" + version, "/DARCH=" + args.arch, "/DBUNDLE=" + str(WORK / "bundle/Munword"),
            "/DOUTFILE=" + str(output), ROOT / "desktop/windows-installer.nsi")
    else:
        # Linux builds are test tools only; never presented as DMG/EXE.
        output = WORK / "bundle/Munword/Munword"
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    (DIST / (output.name + ".sha256")).write_text(digest + "  " + output.name + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "sha256": digest, "version": version, "architecture": args.arch}))


if __name__ == "__main__":
    main()
