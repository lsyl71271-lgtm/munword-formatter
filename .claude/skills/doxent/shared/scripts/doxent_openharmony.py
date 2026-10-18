"""鸿蒙目录包的安装与更新；只管理发行资源，不读写业务会话和数据库。"""

import contextlib
import base64
import errno
import gzip
import hashlib
import json
import os
import platform
import posixpath
import re
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path, PurePosixPath


MAX_MEMBERS = 20000
MAX_UNPACKED_BYTES = 1024 ** 3
MAX_DOWNLOAD_BYTES = 512 * 1024 ** 2
CHECK_TIMEOUT = 30
LOCK_TIMEOUT = 60
SERVICE_TIMEOUT = 15
CACHE_TTL = 3600
REQUIRED_FILES = ("doxent-cli", "doxent-cli.js", "node-sqlite3-wasm.wasm",
                  "version.json", "runtime-check.cjs", "package-info.json")
REQUIRED_CHECKS = ("runtime", "package-files", "user-directory", "temporary-rename",
                   "uid", "child-process", "loopback")


class RecoveryError(RuntimeError):
    """事务恢复未完成时禁止调用方继续使用可能已被替换的入口。"""


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def version_tuple(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d+(?:\.\d+)+", value):
        raise RuntimeError("鸿蒙包的 CLI 版本无效")
    return tuple(int(part) for part in value.split("."))


def read_json(path):
    try:
        with open(path, encoding="utf-8") as stream:
            result = json.load(stream)
        return result if isinstance(result, dict) else {}
    except (OSError, ValueError):
        return {}


def atomic_bytes(path, content, mode=0o600):
    """临时文件与目标在同一文件系统，缓存/入口不会被读到半写内容。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".doxent-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def atomic_json(path, value):
    atomic_bytes(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def probe_node(executable):
    """只执行运行时元数据探测，不导入 CLI、不触碰登录和生产接口。"""
    try:
        result = subprocess.run(
            [executable, "-e", "console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.versions.node}))"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=5, shell=False,
        )
        data = json.loads(result.stdout.decode("utf-8")) if result.returncode == 0 else {}
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError, subprocess.SubprocessError):
        return {}


def target_arch():
    """鸿蒙架构收敛；包元数据、Node 与宿主必须匹配，不把 x64 当作 ARM64。"""
    machine = platform.machine().lower()
    if machine in ("arm64", "aarch64"):
        return "arm64"
    if machine in ("x64", "x86_64", "amd64"):
        return "x64"
    raise RuntimeError("OpenHarmony CLI 不支持当前 CPU 架构：" + platform.machine())


def artifact(url):
    """只有鸿蒙安装器使用产物描述；架构检查不改变公共 URL 覆盖语义。"""
    return {"platform": "openharmony", "arch": target_arch(), "format": "tar-gzip", "url": url}


def data_root():
    override = os.environ.get("DOXENT_CLI_DATA_DIR", "").strip().strip('"')
    if override:
        return Path(override).expanduser().resolve()
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return (Path(base).expanduser() / "doxent" / "cli" / ("openharmony-" + target_arch())).resolve()


def _relative_path(name):
    # tar 路径使用 POSIX 语义；拒绝规范化前的 ..，避免重复成员通过别名覆盖。
    if not isinstance(name, str) or not name or "\\" in name or "\x00" in name or name.startswith("/"):
        raise RuntimeError("鸿蒙归档路径无效：" + str(name))
    parts = PurePosixPath(name).parts
    if not parts or ".." in parts:
        raise RuntimeError("鸿蒙归档路径越界：" + name)
    return "/".join(parts)


def inspect_archive(archive):
    """先完整验证成员图再写文件；支持线上 npm 链接，但不允许经链接父目录写出。"""
    try:
        # tarfile 读到 tar 结束标记就可能停止，额外流读 gzip EOF 才能验证尾部 CRC/截断。
        expanded = 0
        with gzip.open(archive, "rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                expanded += len(chunk)
                if expanded > MAX_UNPACKED_BYTES + MAX_MEMBERS * 4096:
                    raise RuntimeError("鸿蒙归档展开大小超过限制")
        with tarfile.open(archive, "r:gz") as package:
            entries = {}
            total = 0
            for member in package:
                name = _relative_path(member.name)
                if name in entries or len(entries) >= MAX_MEMBERS:
                    raise RuntimeError("鸿蒙归档成员重复或数量超过限制")
                if not (member.isdir() or member.isfile() or member.issym()):
                    raise RuntimeError("鸿蒙归档含不支持的特殊文件：" + name)
                total += member.size
                if member.size < 0 or total > MAX_UNPACKED_BYTES:
                    raise RuntimeError("鸿蒙归档展开大小超过限制")
                entries[name] = member
            roots = {name.split("/")[0] for name in entries}
            if len(roots) != 1:
                raise RuntimeError("鸿蒙归档必须只有一个包根目录")
            root = roots.pop()
            if root in entries and not entries[root].isdir():
                raise RuntimeError("鸿蒙归档包根不是目录")
            for name, member in entries.items():
                for parent in PurePosixPath(name).parents:
                    ancestor = entries.get(str(parent))
                    if ancestor is not None and not ancestor.isdir():
                        raise RuntimeError("鸿蒙归档成员的父路径不是普通目录：" + name)
                if name == root + "/.install-receipt.json":
                    raise RuntimeError("鸿蒙归档不能包含 Skill 安装收据")
                if member.issym():
                    link = member.linkname
                    if not link or link.startswith("/") or "\\" in link or "\x00" in link:
                        raise RuntimeError("鸿蒙归档链接越界：" + name)
                    target = posixpath.normpath(posixpath.join(posixpath.dirname(name), link))
                    # 首版只接受指向真实普通文件/目录的链接，拒绝链接链、循环和悬空链接。
                    destination = entries.get(target)
                    if not target.startswith(root + "/") or destination is None or destination.issym():
                        raise RuntimeError("鸿蒙归档链接越界或目标无效：" + name)
                    for parent in PurePosixPath(target).parents:
                        ancestor = entries.get(str(parent))
                        if ancestor is not None and not ancestor.isdir():
                            raise RuntimeError("鸿蒙归档链接经过非目录成员")
            for required in REQUIRED_FILES:
                member = entries.get(root + "/" + required)
                if member is None or not member.isfile():
                    raise RuntimeError("鸿蒙归档缺少普通文件：" + required)
            meta_member = entries[root + "/package-info.json"]
            if meta_member.size > 65536:
                raise RuntimeError("鸿蒙包元数据过大")
            metadata = json.load(package.extractfile(meta_member))
            mode, node_path = validate_metadata(metadata)
            if mode == "bundled":
                member = entries.get(root + "/" + node_path)
                if member is None or not member.isfile() or not member.mode & 0o111:
                    raise RuntimeError("内置 OpenHarmony Node 缺失或不可执行")
            elif any(name.startswith(root + "/runtime/") for name in entries):
                raise RuntimeError("external 元数据与内置 runtime 冲突")
            # 部分 Windows 构建归档没有执行位；只允许已知 shell 入口在解包时补权限。
            with package.extractfile(entries[root + "/doxent-cli"]) as launcher:
                if not launcher.read(12).startswith((b"#!/bin/sh\n", b"#!/bin/sh\r\n")):
                    raise RuntimeError("鸿蒙启动器不是受支持的 shell 脚本")
            return metadata, entries, root, total
    except (tarfile.TarError, OSError, EOFError, ValueError, TypeError) as error:
        raise RuntimeError("鸿蒙归档校验失败：{}".format(error)) from error


def validate_metadata(metadata):
    if not isinstance(metadata, dict) or type(metadata.get("schemaVersion")) is not int or metadata["schemaVersion"] != 1:
        raise RuntimeError("不支持的鸿蒙包元数据 schema")
    if metadata.get("targetPlatform") != "openharmony" or metadata.get("targetArch") != target_arch():
        raise RuntimeError("鸿蒙包平台或架构不匹配")
    version_tuple(metadata.get("cliVersion"))
    if not isinstance(metadata.get("coreVersion"), str) or not metadata["coreVersion"]:
        raise RuntimeError("鸿蒙包缺少 Core 版本")
    mode = metadata.get("nodeRuntime")
    # 第一版线上包未声明模式，只对带有完整 Node 标识的旧 schema 做兼容。
    if mode is None and metadata.get("nodeVersion") and metadata.get("nodeBinarySha256"):
        mode = "bundled"
    if mode == "external":
        if any(metadata.get(key) for key in ("nodeVersion", "nodeBinarySha256", "nodePath")):
            raise RuntimeError("external 元数据包含内置 Node 字段")
        return mode, ""
    if mode != "bundled":
        raise RuntimeError("鸿蒙包 Node 运行时模式无效")
    if not re.fullmatch(r"v\d+\.\d+\.\d+", str(metadata.get("nodeVersion", ""))):
        raise RuntimeError("内置 Node 版本无效")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", str(metadata.get("nodeBinarySha256", ""))):
        raise RuntimeError("内置 Node 摘要无效")
    node_path = _relative_path(metadata.get("nodePath") or
                               "runtime/node-{}-openharmony-{}/bin/node".format(metadata["nodeVersion"], metadata["targetArch"]))
    if not node_path.startswith("runtime/"):
        raise RuntimeError("内置 Node 必须位于包内 runtime 目录")
    return mode, node_path


def extract_archive(archive, destination, inspection):
    metadata, entries, root, total = inspection
    if shutil.disk_usage(str(destination)).free < total + 16 * 1024 ** 2:
        raise RuntimeError("磁盘空间不足，无法展开鸿蒙 CLI")
    with tarfile.open(archive, "r:gz") as package:
        for name, member in entries.items():
            if name == root or member.issym():
                continue
            target = destination / name[len(root) + 1:]
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with package.extractfile(member) as source, open(target, "xb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
                # 不继承归档中的 setuid/setgid 和任意用户写权限。
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
        for name, member in entries.items():
            if member.issym():
                target = destination / name[len(root) + 1:]
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(member.linkname)
    # Windows 构建的 x64 归档带 CRLF；仅规范化 shell 入口，不改 JS、WASM 或 Node 字节。
    # 归档摘要仍标识原下载物，安装收据会记录规范化后的入口摘要，避免反复修复。
    launcher = destination / "doxent-cli"
    launcher_bytes = launcher.read_bytes()
    if launcher_bytes.startswith(b"#!/bin/sh\r\n"):
        launcher.write_bytes(launcher_bytes.replace(b"\r\n", b"\n"))
    launcher.chmod(0o755)
    mode, node_path = validate_metadata(metadata)
    if mode == "bundled":
        node = destination / node_path
        with node.open("rb") as stream:
            header = stream.read(20)
        elf_machine = {"arm64": b"\xb7\x00", "x64": b"\x3e\x00"}[metadata["targetArch"]]
        if header[:6] != b"\x7fELF\x02\x01" or header[18:20] != elf_machine:
            raise RuntimeError("内置 Node 不是 ELF64 " + metadata["targetArch"].upper())
        if sha256(node) != metadata["nodeBinarySha256"].lower():
            raise RuntimeError("内置 Node 摘要不匹配")
    if read_json(destination / "version.json").get("ver") != metadata["coreVersion"]:
        raise RuntimeError("鸿蒙包 Core 版本与 version.json 不一致")


def runtime_environment(release):
    metadata = read_json(Path(release) / "package-info.json")
    mode, _ = validate_metadata(metadata)
    environment = os.environ.copy()
    environment.pop("DOXENT_CLI_DEFAULT_CTX_PATH", None)
    if mode == "bundled":
        environment.pop("DOXENT_NODE", None)
    else:
        configured = environment.get("DOXENT_NODE", "").strip().strip('"')
        node = configured or shutil.which("node")
        if not node or not os.path.isfile(node) or not os.access(node, os.X_OK):
            raise RuntimeError("未找到可执行的 OpenHarmony Node；请配置 DOXENT_NODE 或 PATH")
        data = probe_node(node)
        try:
            valid = data.get("platform") == "openharmony" and data.get("arch") == metadata["targetArch"] and int(str(data.get("node", "")).split(".")[0]) >= 18
        except ValueError:
            valid = False
        if not valid:
            raise RuntimeError("DOXENT_NODE/PATH 中的运行时不是 OpenHarmony {} Node.js 18+".format(metadata["targetArch"].upper()))
        environment["DOXENT_NODE"] = os.path.abspath(node)
    return environment


def run_release(release, args, timeout=CHECK_TIMEOUT):
    try:
        return subprocess.run([str(Path(release) / "doxent-cli")] + list(args),
                              env=runtime_environment(release), stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=timeout, shell=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError("鸿蒙 CLI 无法执行（检查目录权限、Node 签名及运行环境）：{}".format(error)) from error


def check_release(release):
    result = run_release(release, ["--check-runtime"])
    detail = (result.stdout + result.stderr).decode("utf-8", errors="replace").strip()
    try:
        report = json.loads(result.stdout.decode("utf-8"))
        checks = report.get("checks", {})
        valid = (report.get("platform") == "openharmony" and report.get("arch") == target_arch()
                 and all(checks.get(key) == "passed" for key in REQUIRED_CHECKS)
                 and all(value == "passed" for value in checks.values()))
    except (ValueError, AttributeError):
        valid = False
    if result.returncode or not valid:
        raise RuntimeError("鸿蒙运行时诊断未通过：" + detail)
    result = run_release(release, ["--help"])
    match = re.search(r"DOXENT CLI\s+v(\d+(?:\.\d+)+)", (result.stdout + result.stderr).decode("utf-8", errors="replace"), re.I)
    if result.returncode or not match or match.group(1) != read_json(Path(release) / "package-info.json").get("cliVersion"):
        raise RuntimeError("鸿蒙 CLI --help 与发行版本不一致")


def control_ports():
    # 与 Core 控制协议一致：只有测试环境允许缩小范围，不提供生产端口覆盖入口。
    if os.environ.get("NODE_ENV") == "test":
        try:
            start = int(os.environ.get("DOXENT_CLI_TEST_CONTROL_PORT_START", ""))
            end = int(os.environ.get("DOXENT_CLI_TEST_CONTROL_PORT_END", ""))
            if 0 < start <= end <= 65535:
                return range(start, end + 1)
        except ValueError:
            pass
    return range(46480, 46500)


def daemon_state():
    """只读 hello 校验协议及同用户身份；不把任意 health 或端口占用当作本 CLI。"""
    if not hasattr(os, "getuid"):
        raise RuntimeError("无法取得稳定 UID，不能检查鸿蒙 daemon")
    user_key = hashlib.sha256(("doxent-cli-control-user-v1\0openharmony\0uid:{}".format(os.getuid())).encode()).hexdigest()[:32]
    hello = {"type": "hello", "service": "doxent-cli-control", "protocolVersion": 1, "userKey": user_key}
    endpoints = [(socket.AF_INET, ("127.0.0.1", port)) for port in control_ports()]
    override = os.environ.get("DOXENT_CLI_CONTROL_ENDPOINT")
    if override:
        endpoints.append((socket.AF_UNIX, override))
    else:
        # 兼容 CLI 的旧 Unix 端点。无法完成 hello 的活动监听者按不确定处理，
        # 不能仅因它没有新版 TCP 控制口就当作没有旧服务。
        key = hashlib.sha256(str(Path.home()).encode()).hexdigest()[:16]
        legacy = str(Path(tempfile.gettempdir()) / ("doxent-cli-" + key + ".sock"))
        if os.path.exists(legacy):
            endpoints.append((socket.AF_UNIX, legacy))
    uncertain = False
    matches = []
    legacy_match = None
    for family, address in endpoints:
        try:
            if family == socket.AF_UNIX:
                endpoint_stat = os.lstat(address)
                if not stat.S_ISSOCK(endpoint_stat.st_mode) or endpoint_stat.st_uid != os.getuid():
                    raise RuntimeError("鸿蒙 CLI Unix 控制端点不是当前用户的 socket")
            with socket.socket(family, socket.SOCK_STREAM) as client:
                client.settimeout(0.3)
                client.connect(address)
                client.sendall((json.dumps(hello) + "\n").encode())
                payload = b""
                while b"\n" not in payload and len(payload) <= 8192:
                    chunk = client.recv(8192)
                    if not chunk:
                        break
                    payload += chunk
                if not payload:
                    uncertain = True
                    continue
                data = json.loads(payload.split(b"\n", 1)[0]) if len(payload) <= 8192 else {}
                if not isinstance(data, dict):
                    continue
                if all(data.get(key) == value for key, value in hello.items()):
                    if type(data.get("pid")) is not int or data["pid"] <= 0 or data.get("coreState") not in ("waiting", "running", "failed"):
                        uncertain = True
                    else:
                        matches.append(data)
                elif family == socket.AF_UNIX:
                    # 旧 CLI 没有 hello，缺少 args 的只读请求会返回固定协议错误。
                    # 结合约定的端点路径与 OS socket 所有者识别它，不发送会启动 Core 的 []。
                    if data == {"ok": False, "message": "CLI 命令格式不正确。"}:
                        legacy_match = {"pid": None, "coreState": "unknown", "legacy": True}
                    else:
                        uncertain = True
        except OSError as error:
            if error.errno not in (errno.ECONNREFUSED, errno.ENOENT):
                uncertain = True
        except (ValueError, UnicodeError):
            pass
    if uncertain or len({state["pid"] for state in matches}) > 1:
        raise RuntimeError("鸿蒙 CLI 控制端点状态不确定，暂不切换版本")
    return matches[0] if matches else legacy_match


def stop_release(release):
    result = run_release(release, ["--stop"], timeout=SERVICE_TIMEOUT)
    if result.returncode:
        raise RuntimeError("鸿蒙旧 daemon 停止失败：" + result.stderr.decode("utf-8", errors="replace"))
    deadline = time.monotonic() + SERVICE_TIMEOUT
    while daemon_state() is not None:
        if time.monotonic() >= deadline:
            raise RuntimeError("鸿蒙 daemon 停止后控制端点仍未退出")
        time.sleep(0.2)


def start_release(release, require_running=False, health_check=None):
    # CLI 自己派生 detached daemon；捕获前台启动输出，失败时给出实际错误。
    result = run_release(release, [], timeout=SERVICE_TIMEOUT)
    if result.returncode:
        raise RuntimeError("鸿蒙 CLI 启动失败：" + result.stderr.decode("utf-8", errors="replace"))
    deadline = time.monotonic() + SERVICE_TIMEOUT
    while time.monotonic() < deadline:
        state = daemon_state()
        if state and state["coreState"] == "failed":
            raise RuntimeError("鸿蒙 CLI Core 启动失败")
        if state and (not require_running or state["coreState"] == "running") and (health_check is None or health_check()):
            return
        time.sleep(0.2)
    raise RuntimeError("鸿蒙 CLI 重启后控制端点或本地服务未就绪")


class HarmonyInstaller:
    """完整版本目录 + 原子 current 指针；收据为事实源，HTTP 缓存可随时重建。"""

    def __init__(self, artifact, entry):
        self.artifact = artifact
        self.entry = Path(entry).expanduser().absolute()
        self.root = data_root()
        self.current = self.root / "current"
        self.cache_path = self.root / "cli-version.json"
        self.journal = self.root / "update-transaction.json"
        self.identity = hashlib.sha256(json.dumps(artifact, sort_keys=True).encode()).hexdigest()

    @contextlib.contextmanager
    def locked(self):
        try:
            import fcntl
        except ImportError as error:
            raise RuntimeError("当前 Python 不支持鸿蒙安装所需的 fcntl 文件锁") from error
        self.root.mkdir(parents=True, exist_ok=True)
        with open(self.root / "install.lock", "a+b") as handle:
            deadline = time.monotonic() + LOCK_TIMEOUT
            while True:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("其他进程正在安装鸿蒙 CLI，请稍后重试")
                    time.sleep(0.1)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def active(self):
        if not self.current.is_symlink():
            return None
        release = self.current.resolve()
        if release.parent != (self.root / "releases").resolve() or not release.is_dir():
            raise RuntimeError("鸿蒙 current 指向无效的发行目录")
        return release

    def receipt(self, release):
        if release is None:
            return {}
        receipt = read_json(release / ".install-receipt.json")
        if receipt.get("schemaVersion") != 1 or receipt.get("releasePath") != str(release):
            return {}
        if not re.fullmatch(r"[0-9a-f]{64}", str(receipt.get("archiveSha256", ""))):
            return {}
        hashes = receipt.get("fileHashes")
        if not isinstance(hashes, dict) or not all(name in hashes for name in REQUIRED_FILES):
            return {}
        try:
            for name, digest in hashes.items():
                if _relative_path(name) != name or sha256(release / name) != digest:
                    return {}
            metadata = read_json(release / "package-info.json")
            mode, node = validate_metadata(metadata)
            if node and node not in hashes:
                return {}
            if receipt.get("cliVersion") != metadata["cliVersion"] or receipt.get("runtimeMode") != mode:
                return {}
            return receipt
        except (OSError, RuntimeError):
            return {}

    def wrapper(self):
        # cd -P 得到实际版本目录，exec 时 $0 不指向 bin/current，避免资源错位。
        return ("#!/bin/sh\nset -eu\n"
                "# Doxent OpenHarmony managed entry\n"
                "RELEASE=$(CDPATH= cd -P -- {} && pwd -P)\n"
                'exec "$RELEASE/doxent-cli" "$@"\n'.format(shlex.quote(str(self.current)))).encode()

    def switch(self, release):
        temporary = self.root / (".current-" + uuid.uuid4().hex)
        try:
            temporary.symlink_to(os.path.relpath(str(release), str(self.root)))
            os.replace(str(temporary), str(self.current))
        finally:
            if temporary.is_symlink():
                temporary.unlink()

    def fingerprint(self):
        try:
            request = urllib.request.Request(self.artifact["url"], method="HEAD", headers={"User-Agent": "Doxent-Skill/1.0", "Cache-Control": "no-cache"})
            with urllib.request.urlopen(request, timeout=15) as response:
                return "|".join(response.headers.get(name, "") for name in ("ETag", "Last-Modified", "Content-Length")).strip("|")
        except (OSError, urllib.error.URLError):
            return ""

    def fetch(self, target):
        request = urllib.request.Request(self.artifact["url"], headers={"User-Agent": "Doxent-Skill/1.0", "Cache-Control": "no-cache"})
        size = 0
        with urllib.request.urlopen(request, timeout=60) as response, open(target, "wb") as output:
            declared = response.headers.get("Content-Length")
            expected_size = int(declared) if declared and declared.isdigit() else None
            if expected_size and (expected_size > MAX_DOWNLOAD_BYTES or shutil.disk_usage(str(target.parent)).free < expected_size + 16 * 1024 ** 2):
                raise RuntimeError("鸿蒙下载包过大或磁盘空间不足")
            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                size += len(chunk)
                if size > MAX_DOWNLOAD_BYTES:
                    raise RuntimeError("鸿蒙下载包超过大小限制")
                output.write(chunk)
            if expected_size is not None and size != expected_size:
                raise RuntimeError("鸿蒙下载包不完整")
        return sha256(target)

    def recover(self, health_check=None):
        """更新进程被中断后按事务记录恢复；失败时保留记录，禁止静默继续切换。"""
        if not self.journal.exists():
            return
        transaction = read_json(self.journal)
        old = transaction.get("old")
        candidate = transaction.get("candidate")
        for value in (old, candidate):
            if value and Path(value).resolve().parent != (self.root / "releases").resolve():
                raise RuntimeError("鸿蒙更新事务记录的目录无效")
        if not candidate or not isinstance(transaction.get("wasRunning"), bool):
            raise RuntimeError("鸿蒙更新事务记录不完整")
        entry_path = transaction.get("entryPath")
        if not isinstance(entry_path, str) or not os.path.isabs(entry_path):
            raise RuntimeError("鸿蒙更新事务缺少原入口路径")
        entry_path = Path(entry_path)
        active = self.active()
        state = daemon_state()
        if state and (not old or active != Path(old)):
            stop_release(Path(candidate))
            state = None
        if old:
            self.switch(Path(old))
            if transaction["wasRunning"] and state is None:
                start_release(Path(old), transaction.get("coreRunning", False), health_check)
        elif self.current.is_symlink():
            self.current.unlink()
        # 切换失败时还原原 bin 入口（包含手工安装的文件/链接），不能只恢复 current。
        entry = transaction.get("entry", {})
        if entry.get("kind") == "file":
            atomic_bytes(entry_path, base64.b64decode(entry["content"], validate=True), entry["mode"])
        elif entry.get("kind") == "link":
            temporary = entry_path.parent / (".doxent-" + uuid.uuid4().hex)
            try:
                temporary.symlink_to(entry["target"])
                os.replace(str(temporary), str(entry_path))
            finally:
                if temporary.is_symlink():
                    temporary.unlink()
        elif entry.get("kind") == "missing":
            if entry_path.is_file() and entry_path.read_bytes() == self.wrapper():
                entry_path.unlink()
        else:
            raise RuntimeError("鸿蒙更新事务缺少入口恢复信息")
        self.journal.unlink()
        return True

    def ensure(self, executable="", health_check=None, expected_sha256=""):
        # 整个事务持锁包括缓存与下载，避免两 Agent 覆盖缓存或下载同一大包。
        # 所有进程退出（含崩溃）都会释放 flock；中断事务在下一次进入时恢复。
        with self.locked():
            try:
                recovered = self.recover(health_check)
            except Exception as error:
                raise RecoveryError("上次鸿蒙更新恢复未完成：{}".format(error)) from error
            old = self.active()
            installed = self.receipt(old)
            if recovered and installed:
                # 本次请求先恢复可用性，不立即重新安装上次失败的包并再次打断旧服务。
                # 下一次独立请求才重新探测远端，避免恢复与重试在同一事务中反复停机。
                atomic_bytes(self.entry, self.wrapper(), 0o755)
                return str(self.entry), False
            manual_version = None
            if executable and Path(executable).absolute() != self.entry:
                manual_root = Path(executable).resolve().parent
                manual_metadata = read_json(manual_root / "package-info.json")
                if manual_metadata:
                    validate_metadata(manual_metadata)
                    manual_version = version_tuple(manual_metadata["cliVersion"])
            fingerprint = self.fingerprint()
            cache = read_json(self.cache_path)
            try:
                age = time.time() - float(cache.get("checkedAt", 0))
            except (TypeError, ValueError):
                age = CACHE_TTL
            valid_cache = (cache.get("artifactKey") == self.identity and
                           ((fingerprint and fingerprint == cache.get("fingerprint")) or
                            (not fingerprint and 0 <= age < CACHE_TTL)))
            if not manual_version and installed and installed.get("artifactKey") == self.identity and valid_cache and installed["archiveSha256"] == cache.get("archiveSha256") and (not expected_sha256 or expected_sha256 == installed["archiveSha256"]):
                # 自定义 bin 路径变化或包装入口被删时可直接修复，不重新下载安装。
                atomic_bytes(self.entry, self.wrapper(), 0o755)
                return str(self.entry), False
            with tempfile.TemporaryDirectory(prefix=".staging-", dir=str(self.root)) as staging:
                archive = Path(staging) / "cli.tar.gz"
                digest = self.fetch(archive)
                if expected_sha256 and digest.lower() != expected_sha256.lower():
                    raise RuntimeError("鸿蒙归档摘要与预期不一致")
                inspection = inspect_archive(archive)
                metadata = inspection[0]
                remote_version = version_tuple(metadata["cliVersion"])
                if manual_version and manual_version > remote_version:
                    return str(executable), False
                if installed and version_tuple(installed["cliVersion"]) > remote_version:
                    atomic_bytes(self.entry, self.wrapper(), 0o755)
                    return str(self.entry), False
                if installed and installed["archiveSha256"] == digest:
                    # 内容相同但源地址变化时同步收据身份，否则后续每次请求都会再次下载。
                    installed["artifactKey"] = self.identity
                    atomic_json(old / ".install-receipt.json", installed)
                    atomic_bytes(self.entry, self.wrapper(), 0o755)
                    self.save_cache(metadata, digest, fingerprint)
                    return str(self.entry), False
                candidate = Path(staging) / "release"
                candidate.mkdir()
                extract_archive(archive, candidate, inspection)
                check_release(candidate)
                mode, node = validate_metadata(metadata)
                hashes = {name: sha256(candidate / name) for name in REQUIRED_FILES + ((node,) if node else ())}
                releases = self.root / "releases"
                releases.mkdir(exist_ok=True)
                target = releases / digest
                # 相同摘要目录损坏时另建修复副本，不覆盖可能仍被进程持有的资源。
                if target.exists():
                    target = releases / (digest + "-" + uuid.uuid4().hex)
                os.replace(str(candidate), str(target))
                atomic_json(target / ".install-receipt.json", {
                    "schemaVersion": 1, "artifactKey": self.identity, "archiveSha256": digest,
                    "cliVersion": metadata["cliVersion"], "coreVersion": metadata["coreVersion"],
                    "runtimeMode": mode, "releasePath": str(target), "fileHashes": hashes,
                    "installedAt": time.time(),
                })
                state = daemon_state()
                # 非受管入口不拥有可回滚的完整资源，已有 daemon 时不能冒险停机迁移。
                if state and not old:
                    raise RuntimeError("已有非受管鸿蒙 daemon；请先显式停止，再安装到用户级目录")
                if old and state and not installed:
                    raise RuntimeError("当前鸿蒙发行资源损坏且 daemon 正在运行，请先停止后修复")
                transaction = {"old": str(old) if old else "", "candidate": str(target),
                               "wasRunning": bool(state), "coreRunning": bool(state and state["coreState"] == "running"),
                               "entryPath": str(self.entry)}
                if self.entry.is_symlink():
                    transaction["entry"] = {"kind": "link", "target": os.readlink(str(self.entry))}
                elif self.entry.is_file():
                    transaction["entry"] = {"kind": "file", "content": base64.b64encode(self.entry.read_bytes()).decode("ascii"),
                                            "mode": self.entry.stat().st_mode & 0o777}
                else:
                    transaction["entry"] = {"kind": "missing"}
                atomic_json(self.journal, transaction)
                try:
                    if state:
                        stop_release(old)
                    self.switch(target)
                    atomic_bytes(self.entry, self.wrapper(), 0o755)
                    if state:
                        start_release(target, transaction["coreRunning"], health_check)
                    self.save_cache(metadata, digest, fingerprint)
                    self.journal.unlink()
                except Exception as error:
                    try:
                        self.recover(health_check)
                    except Exception as recovery_error:
                        raise RecoveryError("鸿蒙更新失败且恢复未完成：{}；{}".format(error, recovery_error)) from error
                    raise RuntimeError("鸿蒙更新失败，已恢复原安装状态：{}".format(error)) from error
                return str(self.entry), True

    def save_cache(self, metadata, digest, fingerprint):
        atomic_json(self.cache_path, {"artifactKey": self.identity, "archiveSha256": digest,
                                    "cliVersion": metadata["cliVersion"], "fingerprint": fingerprint,
                                    "checkedAt": time.time()})


def release_for_executable(executable, entry):
    """Skill 的稳定入口通过 current 定位，手动解包入口直接使用其资源目录。"""
    if Path(executable).absolute() == Path(entry).absolute():
        current = data_root() / "current"
        if current.is_symlink():
            release = current.resolve()
            if release.parent != (data_root() / "releases").resolve():
                raise RuntimeError("鸿蒙发行入口越界")
            return release
    return Path(executable).resolve().parent


def invocation(executable, entry, arguments):
    """鸿蒙命令与环境绑定同一发行目录，避免并发切换 current 时混用资源。"""
    release = release_for_executable(executable, entry)
    return [str(release / "doxent-cli")] + list(arguments), runtime_environment(release)


def command_version(executable, entry):
    try:
        result = run_release(release_for_executable(executable, entry), ["--help"], timeout=15)
        match = re.search(r"DOXENT CLI\s+v(\d+(?:\.\d+)+)",
                          (result.stdout + result.stderr).decode("utf-8", errors="replace"), re.I)
        return version_tuple(match.group(1)) if result.returncode == 0 and match else None
    except RuntimeError:
        return None


def request_next_batch(executable, entry, flag, timeout):
    try:
        return run_release(release_for_executable(executable, entry), [flag], timeout=timeout).returncode == 0
    except RuntimeError:
        return False


def spawn_command(executable, entry, write_console):
    try:
        release = release_for_executable(executable, entry)
        check_release(release)
        # 解析一次实际目录，启动和诊断均使用它；资源在后台进程存续期间不被覆盖。
        subprocess.Popen([str(release / "doxent-cli")], env=runtime_environment(release),
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         close_fds=True, start_new_session=True, shell=False)
        return True
    except (OSError, subprocess.SubprocessError, RuntimeError) as error:
        write_console(str(error), sys.stderr)
        return False


def run_command(executable, entry, argument, write_console):
    try:
        # 只有诊断动作限时；登录和设置保留既有等待用户完成的语义。
        result = run_release(release_for_executable(executable, entry), [argument],
                             timeout=CHECK_TIMEOUT if argument == "--check-runtime" else None)
        if argument in ("--help", "--login", "--login-browser", "--login-status", "--upload-logs", "--settings", "--check-runtime") and result.stdout:
            write_console(result.stdout.decode("utf-8", errors="replace"))
        if result.returncode and result.stderr:
            write_console(result.stderr.decode("utf-8", errors="replace"), sys.stderr)
        return result.returncode
    except RuntimeError as error:
        write_console(str(error), sys.stderr)
        return 127


def diagnose(candidates, entry, write_console):
    for executable, _ in candidates:
        if executable and os.path.isfile(executable):
            return run_command(executable, entry, "--check-runtime", write_console)
    write_console("Doxent CLI 尚未安装，无法检查运行时。", sys.stderr)
    return 1
