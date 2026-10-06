"""Stage the already accepted v1.8.5 installers for a public GitHub Release."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

SOURCE_SHA = "05bf3b9ee360b69fb486afbb6f3693da807c9e7a"
RUN_ID = 37433489421
PACKAGES = {
    "Munword-macos-14-arm64": ("Munword-1.8.5-macOS-arm64.dmg", "08bece5860820a1dc442d697ed261a92f865638ebb3b53d715cbbb799aee39c1"),
    "Munword-macos-15-intel-x64": ("Munword-1.8.5-macOS-x64.dmg", "decc67d5a9c835f4bb7c6a8f26d7665f6f5831641b5a4c72a4dfbdd2a43380e8"),
    "Munword-windows-2022-x64": ("Munword-1.8.5-Windows-x64-Setup.exe", "6f07c7ea2ba62d7acac5cf2fafde919103009608a61ca10ba9bb0b4f2b6e04c8"),
    "Munword-windows-2022-x86": ("Munword-1.8.5-Windows-x86-Setup.exe", "a8f2884806c0d0a2b28cfadf4ec7714fff40e038fb4ee266d4ad5ea41408bffd"),
}


def unique(root, name):
    matches = list(root.rglob(name))
    if len(matches) != 1:
        raise ValueError("Expected exactly one " + name)
    return matches[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    checksums = []
    reports = {}
    # Validate everything before copying or publishing any installer.
    for artifact, (name, expected) in PACKAGES.items():
        folder = args.artifacts / artifact
        binary = unique(folder, name)
        actual = hashlib.sha256(binary.read_bytes()).hexdigest()
        sidecar = unique(folder, name + ".sha256").read_text().split()[0]
        if actual != expected or sidecar != expected:
            raise ValueError("Installer differs from the accepted build: " + name)
        report = json.loads(unique(folder, name + ".acceptance.json").read_text())
        if report.get("passed") is not True or report.get("version") != "1.8.5" or report.get("installer") != name:
            raise ValueError("Missing successful native acceptance: " + name)
        if name.endswith(".exe") and "reinstall-upgrade-while-old-app-running" not in report["installation_checks"]:
            raise ValueError("Missing Windows upgrade acceptance")
        if name.endswith(".dmg"):
            rows = json.loads(unique(folder, "macos-binary-minimums.json").read_text())
            if len(rows) != 45 or any(tuple(map(int, v.split(".")[:2])) > (11, 0) for row in rows for v in row["minimum"]):
                raise ValueError("macOS deployment floor differs from the accepted build")
        reports[artifact] = report
        checksums.append(actual + "  " + name)
    arm = json.loads(unique(args.artifacts / "Munword-Windows-11-ARM-compatibility",
                            "Munword-1.8.5-Windows-x64-Setup.exe.Windows-11-ARM.acceptance.json").read_text())
    if arm.get("passed") is not True or arm.get("sha256") != reports["Munword-windows-2022-x64"]["sha256"]:
        raise ValueError("Windows 11 ARM did not accept the same executable")
    if not "Windows-11" in arm.get("platform", ""):
        raise ValueError("Windows 11 acceptance platform mismatch")
    args.output.mkdir(parents=True, exist_ok=True)
    for artifact, (name, _) in PACKAGES.items():
        shutil.copyfile(unique(args.artifacts / artifact, name), args.output / name)
    (args.output / "SHA256SUMS.txt").write_text("\n".join(sorted(checksums)) + "\n", encoding="utf-8")
    with zipfile.ZipFile(args.output / "Munword-1.8.5-Verification.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        def put(name, data):
            # Stable ZIP metadata allows interrupted publication to resume safely.
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 6, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)

        for path in sorted(args.artifacts.rglob("*")):
            if path.is_file() and path.suffix in (".json", ".sha256", ".png"):
                put("evidence/" + path.relative_to(args.artifacts).as_posix(), path.read_bytes())
        put("SHA256SUMS.txt", (args.output / "SHA256SUMS.txt").read_bytes())
        put("Installation-and-verification.md", (Path(__file__).resolve().parents[1] / "docs/desktop-installers.md").read_bytes())
        put("build-provenance.json", json.dumps({"commit": SOURCE_SHA, "run_id": RUN_ID,
            "url": "https://github.com/lsyl71271-lgtm/munword-formatter/actions/runs/" + str(RUN_ID)}, indent=2).encode())
    print("Verified four installers and five native acceptance records; staged six release assets")


if __name__ == "__main__":
    main()
