"""Stage the already accepted v1.8.5 installers for a public GitHub Release."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

SOURCE_SHA = "8f7a3a98319e35a1c8534ae991d455a46f9431de"
RUN_ID = 37464684956
PACKAGES = {
    "Munword-macos-14-arm64": ("Munword-1.8.5-macOS-arm64.dmg", "60693bd1d404ceaf5d96533388ffd5bd49c15c57a4caa7184a50eccb8b564386"),
    "Munword-macos-15-intel-x64": ("Munword-1.8.5-macOS-x64.dmg", "747610fcdc59282d29962007a034c6cc99c04e2adae0e866a01db0ac1a118621"),
    "Munword-windows-2022-x64": ("Munword-1.8.5-Windows-x64-Setup.exe", "399d68dc82d8ef4158e95516696383ec5f35ecc256489f225bb040bbe912cba1"),
    "Munword-windows-2022-x86": ("Munword-1.8.5-Windows-x86-Setup.exe", "44029499778a82fb5430915c04c50a0090b2b2389f675ce3a8137b8b35a891df"),
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
            required = {"installed-copy-signature-flags-and-library-team-consistency", "launchservices-default-browser-start-and-quit"}
            if not required.issubset(report["installation_checks"]):
                raise ValueError("Missing installed signature or LaunchServices acceptance")
            for metadata in ("macos-signature-policy.json", "macos-installed-signature-policy.json"):
                policy = json.loads(unique(folder, metadata).read_text())
                if policy.get("identity_mode") != "ad-hoc" or len(policy.get("binaries", [])) != 45:
                    raise ValueError("Unexpected macOS signing policy")
                for signature in [policy["main"], *policy["binaries"]]:
                    if signature.get("hardened_runtime") or not signature.get("ad_hoc") or signature.get("team") != "not set":
                        raise ValueError("Ad-hoc library-validation startup regression")
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
