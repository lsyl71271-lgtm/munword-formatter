#!/usr/bin/env python3
"""Doxent 本地 API 客户端，并负责按需唤醒 Doxent CLI。"""

import argparse
import contextlib
import glob
import hashlib
import importlib.util
import io
import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


# 鸿蒙模块按需加载，已有平台不依赖该附加文件，也不触发额外运行时探测。
_openharmony = None


def is_openharmony():
    """只识别明确平台标识；Python 报告 Linux 的鸿蒙由宿主显式声明。"""
    system = platform.system().lower()
    if system in ("windows", "darwin"):
        return False
    aliases = ("openharmony", "ohos", "harmonyos")
    if system in aliases or sys.platform.lower() in aliases:
        return True
    override = os.environ.get("DOXENT_CLI_PLATFORM", "").strip().lower()
    return override in aliases


def openharmony_module():
    """从当前 Skill 同级文件加载，避免修改宿主 sys.path 或依赖项目 cwd。"""
    global _openharmony
    if _openharmony is None:
        spec = importlib.util.spec_from_file_location(
            "doxent_openharmony", os.path.join(os.path.dirname(os.path.abspath(__file__)), "doxent_openharmony.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _openharmony = module
    return _openharmony


DEFAULT_LOCAL_PORT = 46588
DEFAULT_TIMEOUT_SECONDS = 10
HEALTH_CHECK_TIMEOUT_SECONDS = 1.5
SERVICE_READY_TIMEOUT_SECONDS = 15
SERVICE_READY_INTERVAL_SECONDS = 0.5
SYNC_WAIT_TIMEOUT_SECONDS = 300
APP_LAUNCH_FILE_NAME = "app_launch.json"
PARTIAL_READ_WARNING = "首次全量同步尚未完成，当前查询仅基于已同步到本地的部分数据，结果可能缺失或不是最新；CLI 将继续分批同步。"
PARTIAL_WRITE_WARNING = "首次全量同步尚未完成，本次写操作将基于已同步到本地的数据执行；CLI 将继续分批同步。"
SYNC_GATE_BLOCKED = "blocked"
SYNC_GATE_READY = "ready"
SYNC_GATE_PARTIAL = "partial"
SYNC_GATE_PARTIAL_WRITE = "partial_write"
CLI_REQUEST_NEXT_INITIAL_NOTE_BATCH_FLAG = "--doxent-cli-request-next-initial-note-batch"
# note/office 的服务端路由包含 `.all()`，因此不能把所有 GET 都视为只读。这里使用
# “方法 + 精确路径”双重白名单，新增接口在明确审查前默认失败关闭。
PARTIAL_READ_ONLY_PATHS = frozenset((
    "/open-model-note/health",
    "/open-model-note/list",
    "/open-model-note/fileList",
    "/open-model-note/search",
    "/open-model-note/file/content",
    "/open-model-office/health",
    "/open-model-office/list",
    "/open-model-office/document/content",
    "/open-model-schedule/health",
    "/open-model-schedule/overview",
    "/open-model-schedule/item",
    "/open-model-schedule/nimble/list",
    "/open-model-schedule/nimble/detail",
    "/open-model-book/health",
))
# 已知业务写接口统一使用 POST；单独维护精确白名单，避免把 .all() 路由的 GET
# 当作只读请求并触发补批。整轮写操作后的显式同步也走 POST 白名单，运行中仍等待。
PARTIAL_WRITE_PATHS = frozenset((
    "/open-model-note/file/create",
    "/open-model-note/file/rename",
    "/open-model-note/file/move",
    "/open-model-note/file/delete",
    "/open-model-note/folder/create",
    "/open-model-note/folder/rename",
    "/open-model-note/folder/move",
    "/open-model-note/folder/delete",
    "/open-model-office/document/rename",
    "/open-model-office/document/move",
    "/open-model-office/document/delete",
    "/open-model-office/folder/create",
    "/open-model-office/folder/rename",
    "/open-model-office/folder/move",
    "/open-model-office/folder/delete",
    "/open-model-schedule/create",
    "/open-model-schedule/update",
    "/open-model-schedule/delete",
    "/open-model-schedule/operate",
    "/open-model-book/file/upload",
    "/open-model/sync",
))
DOXENT_CLI_NAMES = ("doxent-cli", "doxent-cli.exe", "doxent-cli.bat", "doxent-cli.cmd", "doxent-cli.js")
# macOS 只发布一个同时支持 arm64/x64 的 universal 包；配置表必须与真实发布物一一对应，
# 不为同一文件维护重复架构键。Linux 产物包含架构门禁，仍需严格按当前 CPU 分流。
DOXENT_CLI_DOWNLOAD_URLS = {
    "windows-x64": "https://download.iflyink.com/apk/doxent-cli.exe?attname=doxent-cli.exe",
    "darwin-universal": "https://download.iflyink.com/apk/doxent-mac-universal-cli?attname=doxent-cli",
    "linux-arm64": "https://download.iflyink.com/apk/doxent-linux-arm64-cli?attname=doxent-cli",
    "linux-x64": "https://download.iflyink.com/apk/doxent-linux-x64-cli?attname=doxent-cli",
    "openharmony-arm64": "https://download.iflyink.com/apk/doxent-cli-openharmony-arm64.tar.gz?attname=doxent-cli.tar.gz",
    "openharmony-x64": "https://download.iflyink.com/apk/doxent-cli-openharmony-x64.tar.gz?attname=doxent-cli.tar.gz",
}
MIN_CLI_BYTES = 500000
VERSION_CHECK_TTL_SECONDS = 3600


def normalized_machine():
    """把系统架构名收敛为发布文件使用的 arm64/x64，拒绝猜测未知芯片。"""
    machine = platform.machine().lower()
    if machine in ("arm64", "aarch64"):
        return "arm64"
    if machine in ("x86_64", "amd64"):
        return "x64"
    return ""


def cli_download_url():
    """按当前系统选择上传产物；macOS 默认使用跨 arm64/x64 的 universal 单文件。"""
    generic_override = normalize_path(os.environ.get("DOXENT_CLI_DOWNLOAD_URL"))
    if generic_override:
        return generic_override
    if is_openharmony():
        arch = normalized_machine()
        if not arch and platform.machine().lower() == "x64":
            arch = "x64"
        if not arch:
            raise RuntimeError("OpenHarmony CLI 不支持当前 CPU 架构：" + platform.machine())
        return (normalize_path(os.environ.get("DOXENT_OPENHARMONY_{}_CLI_DOWNLOAD_URL".format(arch.upper())))
                or DOXENT_CLI_DOWNLOAD_URLS["openharmony-" + arch])
    system = platform.system().lower()
    arch = normalized_machine()
    if system == "windows":
        return normalize_path(os.environ.get("DOXENT_WINDOWS_CLI_DOWNLOAD_URL")) or DOXENT_CLI_DOWNLOAD_URLS["windows-x64"]
    if system == "darwin":
        if arch not in ("arm64", "x64"):
            raise RuntimeError("当前 macOS CPU 架构没有可用的 Doxent CLI：{}".format(platform.machine()))
        return normalize_path(os.environ.get("DOXENT_MAC_CLI_DOWNLOAD_URL")) or DOXENT_CLI_DOWNLOAD_URLS["darwin-universal"]
    if system == "linux" and arch:
        environment_name = "DOXENT_LINUX_{}_CLI_DOWNLOAD_URL".format(arch.upper())
        return normalize_path(os.environ.get(environment_name)) or DOXENT_CLI_DOWNLOAD_URLS["linux-" + arch]
    raise RuntimeError("当前系统或 CPU 架构没有可用的 Doxent CLI 下载产物：{} {}".format(system, platform.machine()))


def write_console(text, stream=None):
    """以 UTF-8 写出结果，避免 Windows 控制台默认 GBK 无法承载中文响应。"""
    target = stream or sys.stdout
    payload = str(text).encode("utf-8", errors="replace")
    buffer = getattr(target, "buffer", None)
    if buffer is not None:
        buffer.write(payload)
        buffer.write(b"\n")
        buffer.flush()
        return
    target.write(payload.decode("utf-8", errors="replace") + "\n")
    target.flush()


def unique(items):
    result = []
    seen = set()
    for item in items:
        if item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


def resolve_timeout(url):
    # 搜索接口可能需要较长时间，保持原有的无超时约定；其余请求避免永久挂起。
    return None if "/search" in str(url or "").lower() else DEFAULT_TIMEOUT_SECONDS


def config_paths(file_name):
    home = (os.environ.get("HOME") or os.path.expanduser("~") or "").strip()
    appdata = (os.environ.get("APPDATA") or "").strip()
    xdg = (os.environ.get("XDG_CONFIG_HOME") or "").strip()
    paths = []
    if appdata:
        paths.extend([
            os.path.join(appdata, "doxent", file_name),
            os.path.join(appdata, "Doxent", "config", file_name),
        ])
    if home:
        paths.extend([
            os.path.join(home, "Library", "Application Support", "doxent", file_name),
            os.path.join(xdg or os.path.join(home, ".config"), "doxent", file_name),
            os.path.join(home, "doxent", file_name),
        ])
    return unique(paths)


def configured_port():
    for path in config_paths("open_model_config.json"):
        try:
            with open(path, "r", encoding="utf-8-sig") as handle:
                port = int((json.load(handle) or {}).get("port") or 0)
            if 0 < port <= 65535:
                return port
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            # 配置文件可能尚未生成或正在更新，此时继续使用其他候选入口。
            continue
    return DEFAULT_LOCAL_PORT


def running_cli_ports():
    """从当前用户的 Doxent daemon 命令行发现实际端口，修复旧配置未随 --port 更新的问题。"""
    if platform.system().lower() != "windows":
        return []
    command = [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='SilentlyContinue'; "
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'doxent-cli\\.js' -and $_.CommandLine -match '--doxent-cli-daemon' } | "
        "ForEach-Object { $_.CommandLine }",
    ]
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            creationflags=hidden_creation_flags(),
            text=False,
            timeout=5,
            shell=False,
        )
        output = result.stdout.decode("utf-8", errors="replace")
        ports = []
        for value in re.findall(r"--port\s+(\d+)", output, re.IGNORECASE):
            port = int(value)
            if 0 < port <= 65535:
                ports.append(port)
        return unique(ports)
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return []


def local_url_candidates(url):
    parsed = urllib.parse.urlsplit(str(url or "").strip())
    if parsed.scheme not in ("http", "https") or (parsed.hostname or "").lower() not in ("127.0.0.1", "localhost"):
        return [url]
    host = parsed.hostname or "127.0.0.1"
    ports = unique([parsed.port or DEFAULT_LOCAL_PORT, configured_port()] + running_cli_ports())
    return [urllib.parse.urlunsplit((parsed.scheme, "{}:{}".format(host, port), parsed.path, parsed.query, parsed.fragment)) for port in ports]


def is_local_api_url(url):
    """Doxent 开放接口只允许回环地址，防止 token 或真实数据被转发到第三方主机。"""
    parsed = urllib.parse.urlsplit(str(url or "").strip())
    return parsed.scheme == "http" and (parsed.hostname or "").lower() in ("127.0.0.1", "localhost")


def health_url(url):
    parsed = urllib.parse.urlsplit(url)
    path = parsed.path or ""
    if path.startswith("/open-model-schedule"):
        path = "/open-model-schedule/health"
    # Office 接口可能在笔记能力关闭时单独启用；不能回退探测 note health，
    # 否则脚本会把 Office 服务可用性误判为笔记模块的状态。
    elif path.startswith("/open-model-office"):
        path = "/open-model-office/health"
    elif path.startswith("/open-model-book"):
        path = "/open-model-book/health"
    elif path.startswith("/open-model-common"):
        path = "/open-model-common/health"
    else:
        path = "/open-model-note/health"
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def service_ready(url):
    try:
        request = urllib.request.Request(health_url(url), method="GET")
        with urllib.request.urlopen(request, timeout=HEALTH_CHECK_TIMEOUT_SECONDS):
            return True
    except urllib.error.HTTPError as error:
        # 只有鉴权拒绝能证明这是目标 Core；404 可能只是同端口上的其他本地服务。
        return error.code in (401, 403)
    except (OSError, urllib.error.URLError):
        return False


def sync_status_url(url):
    """把任意本地 Core 地址转换为仅返回同步状态的协调接口。"""
    parsed = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/sync/status", "", ""))


def request_next_initial_note_batch():
    """经既有 CLI daemon 控制通道尽力唤醒下一批，不扩展通用 Core HTTP 接口。"""
    for executable, _ in launch_info():
        if not executable or not os.path.isfile(executable):
            continue
        try:
            if is_openharmony():
                if openharmony_module().request_next_batch(executable, cli_install_path(), CLI_REQUEST_NEXT_INITIAL_NOTE_BATCH_FLAG, HEALTH_CHECK_TIMEOUT_SECONDS):
                    return True
                continue
            result = subprocess.run(
                cli_command(executable, [CLI_REQUEST_NEXT_INITIAL_NOTE_BATCH_FLAG]),
                shell=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=cli_environment(),
                creationflags=hidden_creation_flags(),
                timeout=HEALTH_CHECK_TIMEOUT_SECONDS,
            )
            if result.returncode == 0:
                return True
        except (OSError, subprocess.SubprocessError):
            continue
    write_console("Doxent CLI 后台补批唤醒失败，将按原计划继续同步。", sys.stderr)
    return False


def sync_warning_message(status):
    """把同步完成后的非阻断异常收敛为固定提示，避免向用户暴露内部 noteId 或堆栈。"""
    warning = status.get("syncWarning") if isinstance(status, dict) else ""
    if isinstance(warning, str) and warning.strip():
        return warning.strip()
    if isinstance(status, dict) and status.get("lastSyncSucceeded") is False:
        return "存在部分同步异常，结果可能不完整"
    return ""


def is_partial_read_request(url, method):
    """只允许经过审查的精确 GET 路径使用首次同步部分数据。"""
    parsed = urllib.parse.urlsplit(str(url or "").strip())
    path = (parsed.path or "/").rstrip("/") or "/"
    return str(method or "GET").upper() == "GET" and path in PARTIAL_READ_ONLY_PATHS


def is_partial_write_request(url, method):
    """首次批次空闲时仅放行已知 POST 写接口，不扩大到未知路径或其它方法。"""
    parsed = urllib.parse.urlsplit(str(url or "").strip())
    path = (parsed.path or "/").rstrip("/") or "/"
    return str(method or "GET").upper() == "POST" and path in PARTIAL_WRITE_PATHS


def validate_initial_sync_status(status):
    """校验新版 CLI 首次同步字段；旧 CLI 完全缺字段时返回 None 并保持原严格门禁。"""
    has_phase = "initialSyncPhase" in status
    has_partial_usable = "partialReadUsable" in status
    if not has_phase and not has_partial_usable:
        return None
    if not has_phase or not has_partial_usable:
        raise ValueError("首次同步状态字段不完整")

    phase = status.get("initialSyncPhase")
    partial_usable = status.get("partialReadUsable")
    if phase not in ("not_started", "running", "partial_idle", "complete") or not isinstance(partial_usable, bool):
        raise ValueError("首次同步状态字段类型无效")
    next_sync_at = status.get("nextInitialSyncAt")
    if not isinstance(next_sync_at, (int, float)) or isinstance(next_sync_at, bool) or next_sync_at < 0:
        raise ValueError("下一批同步时间无效")

    running = status["running"]
    startup_pending = status["startupSyncPending"]
    if startup_pending:
        # 首次同步期间只接受三种互斥状态。运行中绝不允许读取；部分空闲必须同时证明
        # 既有总同步契约尚未完成，避免矛盾字段绕过门禁。
        if status.get("syncFinished") is not False or status.get("syncUsable") is not False:
            valid = False
        elif running:
            valid = phase == "running" and partial_usable is False
        elif phase == "partial_idle":
            valid = partial_usable is True
        else:
            valid = phase == "not_started" and partial_usable is False
    else:
        # 首次全量完成后，后续增量即使正在运行也仍属于 complete 阶段；是否等待由 running
        # 和 syncFinished 的原门禁决定，不能复用部分读取分支。
        valid = phase == "complete" and partial_usable is False
    if not valid:
        raise ValueError("首次同步状态组合无效")
    return phase


def wait_for_sync_gate(url, method="GET"):
    """返回同步门禁阶段；首次批次间隙按读写白名单放行，只有读取触发补批。"""
    deadline = time.time() + SYNC_WAIT_TIMEOUT_SECONDS
    announced = False
    status_url = sync_status_url(url)
    while time.time() < deadline:
        try:
            request = urllib.request.Request(status_url, method="GET")
            with urllib.request.urlopen(request, timeout=HEALTH_CHECK_TIMEOUT_SECONDS) as response:
                payload = json.loads(response.read().decode("utf-8"))
            status = payload.get("data") if isinstance(payload, dict) else {}
            if not isinstance(status, dict) or not isinstance(status.get("running"), bool) or not isinstance(status.get("startupSyncPending"), bool):
                write_console("Doxent 同步状态响应无效，本次请求已停止；请检查或更新 CLI 后重试。", sys.stderr)
                return SYNC_GATE_BLOCKED
            try:
                initial_phase = validate_initial_sync_status(status)
            except ValueError:
                # 状态来自本机 CLI，但仍不能相信互相矛盾的组合；统一失败关闭且不打印原始
                # payload，避免未来字段意外携带用户数据后进入终端日志。
                write_console("Doxent 同步状态响应无效，本次请求已停止；请检查或更新 CLI 后重试。", sys.stderr)
                return SYNC_GATE_BLOCKED

            if initial_phase == "partial_idle":
                if is_partial_read_request(url, method):
                    write_console(PARTIAL_READ_WARNING, sys.stderr)
                    return SYNC_GATE_PARTIAL
                if is_partial_write_request(url, method):
                    write_console(PARTIAL_WRITE_WARNING, sys.stderr)
                    # 使用独立阶段值，成功、HTTP 错误和地址重试均不会沿用只读补批分支。
                    return SYNC_GATE_PARTIAL_WRITE
                write_console("首次全量同步尚未完成，本次请求不在读写白名单内，已停止；请等待 CLI 继续分批同步。", sys.stderr)
                return SYNC_GATE_BLOCKED
            # 新版 CLI 会显式给出 syncFinished；旧版 CLI 没有该字段时仍按 running/startup
            # 判断是否结束。这样可以兼容已安装旧 CLI，同时保留新版“HTTP 已就绪但同步未结算”
            # 的等待门禁，避免同步刚启动前读到启动前缓存。
            active = status["running"] or status["startupSyncPending"] or status.get("syncFinished") is False
            if not active:
                if status.get("syncUsable") is False:
                    write_console("Doxent 同步状态显示数据暂不可用，本次请求已停止；请稍后重试。", sys.stderr)
                    return SYNC_GATE_BLOCKED
                warning = sync_warning_message(status)
                if warning:
                    write_console("Doxent 数据同步已完成，但{}；本次查询将继续执行。".format(warning), sys.stderr)
                return SYNC_GATE_READY
            if not announced:
                write_console("Doxent 正在同步数据，请稍候；同步完成后再返回最新数据。")
                announced = True
            time.sleep(SERVICE_READY_INTERVAL_SECONDS)
        except urllib.error.HTTPError as error:
            # 没有状态接口就无法证明启动同步已经完成。继续返回缓存会把旧数据误报为最新数据，
            # 因此要求更新 CLI，而不是沿用旧版的静默降级行为。
            if error.code == 404:
                write_console("当前 Doxent CLI 不支持同步状态检查，本次请求已停止；请等待自动更新后重试。", sys.stderr)
                return SYNC_GATE_BLOCKED
            write_console("Doxent 同步状态接口返回 HTTP {}，本次请求已停止。".format(error.code), sys.stderr)
            return SYNC_GATE_BLOCKED
        except (ValueError, TypeError, json.JSONDecodeError):
            write_console("Doxent 同步状态无法解析，本次请求已停止；请检查 CLI 日志后重试。", sys.stderr)
            return SYNC_GATE_BLOCKED
        except (OSError, urllib.error.URLError) as error:
            write_console("Doxent 同步状态接口不可用：{}。本次请求已停止。".format(error), sys.stderr)
            return SYNC_GATE_BLOCKED
    write_console("Doxent 同步等待已超时，本次请求已停止；请稍后重试。", sys.stderr)
    return SYNC_GATE_BLOCKED


def wait_for_sync(url, method="GET"):
    """兼容既有调用方的布尔门禁；新主流程使用阶段值决定是否发送补批信号。"""
    return wait_for_sync_gate(url, method) != SYNC_GATE_BLOCKED


def normalize_path(value):
    text = str(value or "").strip().strip('"')
    if not text:
        return ""
    if "," in text and not os.path.exists(text):
        text = text.split(",", 1)[0].strip().strip('"')
    return text


def cli_install_path():
    """返回用户级安装路径，避免管理员权限和对桌面应用安装目录的写入。"""
    override = normalize_path(os.environ.get("DOXENT_CLI_INSTALL_DIR"))
    if override:
        filename = "doxent-cli.exe" if platform.system().lower() == "windows" else "doxent-cli"
        return os.path.join(override, filename)
    if platform.system().lower() == "windows":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        return os.path.join(base, "Doxent", "CoreCLI", "doxent-cli.exe")
    # POSIX 入口放入约定的用户级 bin；自解压后的 JS/版本资源由入口自行放到 XDG data 目录。
    return os.path.join(os.path.expanduser("~"), ".local", "bin", "doxent-cli")


def persist_posix_cli_environment(executable):
    """幂等写入登录 shell 配置，使新终端可直接执行统一的 doxent-cli 命令。"""
    home = os.path.expanduser("~")
    system = platform.system().lower()
    profile = os.path.join(home, ".zprofile" if system == "darwin" else ".profile")
    marker_start = "# >>> Doxent CLI >>>"
    marker_end = "# <<< Doxent CLI <<<"
    install_directory = os.path.dirname(executable)
    block = "\n".join([
        marker_start,
        "export DOXENT_CLI_PATH={}".format(shlex.quote(executable)),
        "case \":$PATH:\" in *:{0}:*) ;; *) export PATH={0}:\"$PATH\" ;; esac".format(shlex.quote(install_directory)),
        marker_end,
    ])
    try:
        existing = ""
        if os.path.isfile(profile):
            with open(profile, "r", encoding="utf-8") as handle:
                existing = handle.read()
        pattern = re.compile(re.escape(marker_start) + r"[\s\S]*?" + re.escape(marker_end))
        updated = pattern.sub(block, existing) if pattern.search(existing) else existing.rstrip() + "\n\n" + block + "\n"
        with open(profile, "w", encoding="utf-8") as handle:
            handle.write(updated.lstrip("\n"))
    except OSError:
        # 当前进程已能启动 CLI；配置文件不可写时不破坏已完成的用户级安装。
        pass


def persist_cli_path(executable):
    """保存用户级环境变量，并同步当前进程，后续 Codex/终端可直接发现 CLI。"""
    os.environ["DOXENT_CLI_PATH"] = executable
    install_directory = os.path.dirname(executable)
    current_path = os.environ.get("PATH", "")
    if install_directory not in current_path.split(os.pathsep):
        os.environ["PATH"] = install_directory + os.pathsep + current_path
    if os.environ.get("DOXENT_DISABLE_ENV_PERSISTENCE") == "1":
        return
    if platform.system().lower() != "windows":
        persist_posix_cli_environment(executable)
        return
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, "DOXENT_CLI_PATH", 0, winreg.REG_EXPAND_SZ, executable)
    except (OSError, ImportError):
        # 环境变量持久化失败不应阻断当前会话，当前进程仍已具备正确路径。
        pass


def parse_cli_version(text):
    match = re.search(r"DOXENT CLI\s+v(\d+(?:\.\d+)+)", str(text or ""), re.IGNORECASE)
    if not match:
        return None
    return tuple(int(part) for part in match.group(1).split("."))


def windows_cli_runtime_directory(executable):
    """按包摘要隔离解压目录，更新包不会复用旧 JS，也不会覆盖正在运行的文件。"""
    return os.path.join(os.path.dirname(os.path.abspath(executable)), ".doxent-runtime", file_sha256(executable))


def prepare_windows_cli_runtime(executable):
    """SFX 只负责解压；真实命令直连 Node，避免 NSIS 吞掉标准输出。"""
    directory = windows_cli_runtime_directory(executable)
    script = os.path.join(directory, "doxent-cli.js")
    runtime = os.path.join(directory, "doxent-cli-runtime.exe")
    receipt = os.path.join(directory, ".extracted")
    if not (os.path.isfile(receipt) and os.path.isfile(script) and os.path.isfile(runtime)):
        # /D 必须是最后一个参数。只有成功解压且必要文件齐全才写完成标记，失败可重试。
        result = subprocess.run(
            [executable, "/NO_LAUNCH", "/D=" + directory],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=cli_environment(), creationflags=hidden_creation_flags(),
            timeout=120, shell=False,
        )
        if result.returncode != 0 or not os.path.isfile(script) or not os.path.isfile(runtime):
            raise RuntimeError("Doxent CLI 解压失败或缺少 Node/JS：" + directory)
        with open(receipt, "w", encoding="utf-8") as handle:
            handle.write("ok\n")
    return runtime, script


def cli_command(executable, arguments):
    """Windows SFX 仅作安装容器；命令输出直接由 Node 返回调用方。"""
    suffix = os.path.splitext(executable)[1].lower()
    if platform.system().lower() == "windows" and suffix == ".exe":
        runtime, script = prepare_windows_cli_runtime(executable)
        return [runtime, script] + list(arguments)
    if suffix in (".bat", ".cmd"):
        return [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c", executable] + list(arguments)
    if suffix == ".js":
        return [os.environ.get("DOXENT_NODE", "node"), executable] + list(arguments)
    return [executable] + list(arguments)


def hidden_creation_flags(new_process_group=False):
    """返回隐藏控制台所需标记；非 Windows 平台保持为 0。"""
    if platform.system().lower() != "windows":
        return 0
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if new_process_group:
        flags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    return flags


def resolve_node_runtime():
    """优先复用显式/系统 Node，并自动发现 Codex 自带运行时，避免要求用户手工安装配置。"""
    configured = normalize_path(os.environ.get("DOXENT_NODE"))
    if configured and os.path.isfile(configured):
        return configured
    system_node = shutil.which("node")
    if system_node:
        return system_node
    user_profile = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    node_name = "node.exe" if platform.system().lower() == "windows" else "node"
    patterns = [
        os.path.join(user_profile, ".cache", "codex-runtimes", "*", "dependencies", "node", "bin", node_name),
        os.path.join(user_profile, ".codex", "runtimes", "*", "dependencies", "node", "bin", node_name),
    ]
    candidates = sorted((candidate for pattern in patterns for candidate in glob.glob(pattern)), reverse=True)
    return candidates[0] if candidates else ""


def cli_environment(executable=""):
    """把自动发现的 Node 注入子进程环境，使 SFX 和旧 BAT 都能零配置启动。"""
    environment = os.environ.copy()
    if is_openharmony():
        if executable:
            module = openharmony_module()
            return module.runtime_environment(module.release_for_executable(executable, cli_install_path()))
        return environment
    if executable and platform.system().lower() == "windows" and executable.lower().endswith(".exe"):
        # 对齐 BAT 的资源定位约定，不能添加 --ctx-path 参数破坏 login-status 的独立命令校验。
        environment["DOXENT_CLI_DEFAULT_CTX_PATH"] = windows_cli_runtime_directory(executable)
    node_runtime = resolve_node_runtime()
    if node_runtime:
        environment["DOXENT_NODE"] = node_runtime
        node_directory = os.path.dirname(node_runtime)
        environment["PATH"] = node_directory + os.pathsep + environment.get("PATH", "")
    return environment


def cli_version(executable):
    """读取 CLI 帮助首屏中的版本号；旧版没有 --version，因此不能依赖该参数。"""
    if is_openharmony():
        return openharmony_module().command_version(executable, cli_install_path())
    try:
        result = subprocess.run(
            cli_command(executable, ["--help"]),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=cli_environment(executable),
            creationflags=hidden_creation_flags(),
            text=False,
            timeout=15,
            shell=False,
        )
        return parse_cli_version((result.stdout + result.stderr).decode("utf-8", errors="replace"))
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return None


def file_sha256(path):
    """流式计算文件摘要，避免把完整 CLI 载入内存。"""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def version_cache_path():
    return os.path.join(os.path.dirname(cli_install_path()), "cli-version.json")


def load_version_cache():
    try:
        with open(version_cache_path(), "r", encoding="utf-8-sig") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return {}


def save_version_cache(version, fingerprint, remote_sha256="", installed_path="", installed_sha256="", installed_version=None):
    """保存远端与已安装产物身份；版本号相同但构建变化时仍能识别更新。"""
    try:
        os.makedirs(os.path.dirname(version_cache_path()), exist_ok=True)
        cached = load_version_cache()
        payload = {
            "version": ".".join(str(part) for part in version),
            "fingerprint": fingerprint,
            "remoteSha256": remote_sha256 or cached.get("remoteSha256", ""),
            "installedPath": installed_path or cached.get("installedPath", ""),
            "installedSha256": installed_sha256 or cached.get("installedSha256", ""),
            "installedVersion": ".".join(str(part) for part in installed_version) if installed_version else cached.get("installedVersion", ""),
            "checkedAt": time.time(),
        }
        with open(version_cache_path(), "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
    except OSError:
        pass


def remote_cli_metadata():
    """读取远端版本与摘要；云端同版本重新构建时以摘要变化作为更新依据。"""
    cache = load_version_cache()
    fingerprint = ""
    try:
        head = urllib.request.Request(cli_download_url(), method="HEAD", headers={"User-Agent": "Doxent-Skill/1.0"})
        with urllib.request.urlopen(head, timeout=15) as response:
            fingerprint = "|".join([
                response.headers.get("ETag") or "",
                response.headers.get("Last-Modified") or "",
                response.headers.get("Content-Length") or "",
            ]).strip("|")
    except (OSError, urllib.error.URLError):
        pass
    cached_version = parse_cli_version("DOXENT CLI v{}".format(cache.get("version", "")))
    cache_age = time.time() - float(cache.get("checkedAt") or 0)
    cached_sha256 = str(cache.get("remoteSha256") or "")
    if cached_version and cached_sha256 and ((fingerprint and fingerprint == cache.get("fingerprint")) or (not fingerprint and cache_age < VERSION_CHECK_TTL_SECONDS)):
        return {"version": cached_version, "fingerprint": fingerprint or cache.get("fingerprint", ""), "sha256": cached_sha256}
    directory = os.path.dirname(cli_install_path())
    os.makedirs(directory, exist_ok=True)
    suffix = ".exe" if platform.system().lower() == "windows" else ""
    temporary = tempfile.NamedTemporaryFile(prefix="doxent-cli-version-", suffix=suffix, dir=directory, delete=False)
    temporary.close()
    try:
        downloaded = download_cli(temporary.name, persist=False)
        # 云端文件是自解压安装器，直接执行它来读取 --help 会改写正式安装目录。
        # 更新判定以完整文件摘要为准；版本仅复用上次已安装产物确认过的值。
        version = cached_version or (0, 0, 0)
        remote_sha256 = file_sha256(downloaded)
        save_version_cache(version, fingerprint, remote_sha256=remote_sha256)
        return {"version": version, "fingerprint": fingerprint, "sha256": remote_sha256}
    except (OSError, urllib.error.URLError, RuntimeError):
        return None
    finally:
        if os.path.exists(temporary.name):
            os.remove(temporary.name)


def stop_cli_for_update(executable):
    """请求当前 daemon 退出，让 Windows 可以原子替换正在使用的 CLI 文件。"""
    try:
        subprocess.run(
            cli_command(executable, ["--stop"]),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=cli_environment(),
            creationflags=hidden_creation_flags(),
            timeout=15,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        # 后续原子替换仍会给出确定结果；停止命令失败不在这里吞掉安装错误。
        return


def install_staged_cli(staged, target):
    """重试替换，覆盖 daemon 刚退出时 Windows 短暂持有映像文件的窗口。"""
    deadline = time.time() + 15
    while True:
        try:
            os.replace(staged, target)
            return
        except PermissionError:
            if time.time() >= deadline:
                raise
            time.sleep(0.25)


def ensure_cli_current(executable, service_is_running=False):
    """确保用户级 CLI 与云端产物一致，返回“路径、是否更新”。"""
    if is_openharmony():
        module = openharmony_module()
        installer = module.HarmonyInstaller(module.artifact(cli_download_url()), cli_install_path())
        health_check = None
        if service_is_running:
            # 选择更新前实际可用的业务模块，Office-only 用户不能被 note health 阻断。
            endpoint = query_cli_endpoint(executable)
            paths = ["/open-model-{}/health".format(name)
                     for name in ("note", "office", "schedule", "book")]
            healthy = next((path for path in paths if endpoint and service_ready(endpoint + path)), "")
            if healthy:
                def health_check():
                    # 切换版本或恢复旧版本后端口可能改变，必须重新查询 CLI 控制通道。
                    current_endpoint = query_cli_endpoint(executable)
                    return bool(current_endpoint and service_ready(current_endpoint + healthy))
        installed, updated = installer.ensure(executable, health_check=health_check)
        persist_cli_path(installed)
        if updated:
            write_console("Doxent CLI 鸿蒙版本已安装并完成切换。")
        return installed, updated
    local_version = cli_version(executable)
    remote = remote_cli_metadata()
    if not remote:
        return executable, False
    try:
        local_sha256 = file_sha256(executable)
    except OSError:
        local_sha256 = ""
    remote_has_version = remote["version"] != (0, 0, 0)
    if local_version and remote_has_version and local_version > remote["version"]:
        # CDN 尚未上传新构建时绝不能用旧版本覆盖本地新版本；等待远端版本追平后再比较摘要。
        needs_update = False
    else:
        needs_update = local_version is None or (remote_has_version and local_version < remote["version"]) or local_sha256 != remote["sha256"]
    if not needs_update:
        save_version_cache(
            remote["version"],
            remote["fingerprint"],
            remote_sha256=remote["sha256"],
            installed_path=executable,
            installed_sha256=local_sha256,
            installed_version=local_version,
        )
        persist_cli_path(executable)
        return executable, False

    target = cli_install_path()
    os.makedirs(os.path.dirname(target), exist_ok=True)
    staged = target + ".update"
    try:
        download_cli(staged, persist=False, expected_sha256=remote["sha256"])
        if service_is_running:
            stop_cli_for_update(executable)
        install_staged_cli(staged, target)
        persist_cli_path(target)
        installed_sha256 = file_sha256(target)
        installed_version = cli_version(target) or remote["version"]
        save_version_cache(
            remote["version"],
            remote["fingerprint"],
            remote_sha256=remote["sha256"],
            installed_path=target,
            installed_sha256=installed_sha256,
            installed_version=installed_version,
        )
        write_console("Doxent CLI 已自动更新到 v{}。".format(".".join(str(part) for part in installed_version)))
        return target, True
    finally:
        if os.path.exists(staged):
            os.remove(staged)


def download_cli(target=None, persist=True, expected_sha256=""):
    """下载并原子安装当前平台 CLI，校验平台格式后统一落盘为 doxent-cli。"""
    if is_openharmony():
        if not persist:
            raise RuntimeError("鸿蒙归档不支持按单文件暂存安装，请使用完整目录安装流程")
        module = openharmony_module()
        installer = module.HarmonyInstaller(module.artifact(cli_download_url()), target or cli_install_path())
        installed, _ = installer.ensure(expected_sha256=expected_sha256)
        persist_cli_path(installed)
        return installed
    target = target or cli_install_path()
    directory = os.path.dirname(target)
    os.makedirs(directory, exist_ok=True)
    temporary = target + ".download"
    digest = hashlib.sha256()
    try:
        request = urllib.request.Request(cli_download_url(), headers={"User-Agent": "Doxent-Skill/1.0"})
        with urllib.request.urlopen(request, timeout=60) as response, open(temporary, "wb") as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
                digest.update(chunk)
        size = os.path.getsize(temporary)
        with open(temporary, "rb") as handle:
            prefix = handle.read(16384)
        if platform.system().lower() == "windows":
            valid_format = prefix.startswith(b"MZ")
            format_error = "不是完整的 Windows EXE"
        else:
            valid_format = prefix.startswith(b"#!/bin/sh\n") and b"__DOXENT_CLI_PAYLOAD_BELOW__" in prefix
            format_error = "不是完整的 POSIX Doxent CLI 单文件包"
        if size < MIN_CLI_BYTES or not valid_format:
            raise RuntimeError("下载的 CLI 文件校验失败（{}）".format(format_error))
        downloaded_sha256 = digest.hexdigest()
        if expected_sha256 and downloaded_sha256.lower() != expected_sha256.lower():
            raise RuntimeError("下载的 CLI 文件摘要与版本探测结果不一致")
        os.replace(temporary, target)
        if platform.system().lower() != "windows":
            os.chmod(target, 0o755)
        if persist:
            persist_cli_path(target)
        return target
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def launch_info():
    entries = []
    # 显式配置和 Skill 用户级安装目录必须优先于桌面应用残留配置，避免启动旧构建。
    env_path = normalize_path(os.environ.get("DOXENT_CLI_PATH"))
    if env_path:
        entries.append((env_path, ""))
    entries.append((cli_install_path(), ""))

    for path in config_paths(APP_LAUNCH_FILE_NAME):
        try:
            with open(path, "r", encoding="utf-8-sig") as handle:
                data = json.load(handle) or {}
            executable = normalize_path(data.get("exePath") or data.get("appPath") or data.get("path"))
            # app_launch.json 也可能记录桌面端入口；只有明确的 CLI 文件才允许被 skill 唤醒。
            if executable and "doxent-cli" in os.path.basename(executable).lower():
                entries.append((executable, ""))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue

    if platform.system().lower() == "windows":
        for base in (os.environ.get("LOCALAPPDATA"), os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
            if not base:
                continue
            for folder in (os.path.join("Doxent", "CoreCLI"), "Doxent"):
                for name in DOXENT_CLI_NAMES:
                    entries.append((os.path.join(base, folder, name), ""))
    elif platform.system().lower() == "darwin":
        entries.append(("/Applications/Doxent.app/Contents/Resources/app.asar.unpacked/cli/doxent-cli.js", ""))
    result = []
    seen = set()
    for executable, argument in entries:
        key = (executable, argument)
        if key not in seen:
            seen.add(key)
            result.append(key)
    return result


def start_cli(preferred_executable="", check_update=True):
    candidates = [(preferred_executable, "")] if preferred_executable else launch_info()
    existing = next((executable for executable, _ in candidates if executable and os.path.isfile(executable)), "")
    if existing:
        if check_update:
            try:
                existing, _ = ensure_cli_current(existing, service_is_running=False)
            except (OSError, urllib.error.URLError, RuntimeError) as error:
                if is_openharmony() and isinstance(error, openharmony_module().RecoveryError):
                    raise
                write_console("Doxent CLI 更新失败，将继续使用当前版本：{}".format(error), sys.stderr)
        # ensure_service 已经完成更新判断时会传 check_update=False；该分支必须直接启动
        # 既有文件，绝不能误入“未安装”分支再次下载并覆盖刚确认的新版本。
        candidates = [(existing, "")]
    else:
        try:
            installed = download_cli()
            candidates = [(installed, "")]
        except (OSError, urllib.error.URLError, RuntimeError) as error:
            write_console("Doxent CLI 自动下载/安装失败：{}。下载地址：{}".format(error, cli_download_url()), sys.stderr)
            return False
    for executable, extra_argument in candidates:
        if not executable or not os.path.exists(executable):
            continue
        try:
            if is_openharmony():
                return openharmony_module().spawn_command(executable, cli_install_path(), write_console)
            command = cli_command(executable, [])
            # Doxent CLI 无参数即可启动后台 Core，并在无会话时自行打开登录页；
            # 不传不存在的 background 参数，避免把旧版 Ainote 约定误传给 Doxent。
            # CLI 由 Skill 作为后台服务唤醒，不能继承 Codex/Agent 的控制台；登录页由 CLI
            # 自己打开浏览器，控制台窗口对用户没有价值，反而会造成误以为需要手工操作。
            subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, creationflags=hidden_creation_flags(new_process_group=True), env=cli_environment(executable), shell=False)
            return True
        except (OSError, subprocess.SubprocessError):
            # 一个候选入口失败时继续尝试安装目录中的其他入口。
            continue
    return False


def query_cli_endpoint(executable):
    """通过 CLI 控制通道读取真实业务地址，绝不把任意本地 HTTP 服务当成 CLI。"""
    if not executable or not os.path.isfile(executable):
        return None
    try:
        result = subprocess.run(
            cli_command(executable, ["--doxent-cli-endpoint"]),
            shell=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=cli_environment(executable),
            creationflags=hidden_creation_flags(),
            text=False,
            timeout=15,
        )
        if result.returncode != 0:
            return None
        payload = json.loads(result.stdout.decode("utf-8", errors="replace").strip())
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, dict) or data.get("runtime") != "cli" or data.get("coreState") != "running":
            return None
        port = int(data.get("port") or 0)
        base_url = str(data.get("baseUrl") or "").strip()
        instance_id = str(data.get("instanceId") or "").strip()
        parsed = urllib.parse.urlsplit(base_url)
        if not instance_id or parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost") or parsed.port != port:
            return None
        return base_url.rstrip("/")
    except (OSError, ValueError, TypeError, json.JSONDecodeError, subprocess.SubprocessError):
        return None


def cli_endpoint_url(base_url, request_url):
    """保留调用方原始业务路径，只替换为 CLI 控制通道确认的回环基址。"""
    parsed = urllib.parse.urlsplit(str(request_url or ""))
    return urllib.parse.urlunsplit((urllib.parse.urlsplit(base_url).scheme,
                                    urllib.parse.urlsplit(base_url).netloc,
                                    parsed.path,
                                    parsed.query,
                                    parsed.fragment))


def ensure_service(url):
    """确保 CLI daemon 已启动并返回控制通道确认的业务地址。"""
    launch_candidates = launch_info()
    executable = next((item for item, _ in launch_candidates if item and os.path.isfile(item)), "")
    endpoint = query_cli_endpoint(executable)
    ready_candidate = cli_endpoint_url(endpoint, url) if endpoint else ""
    updated = False
    if executable:
        try:
            executable, updated = ensure_cli_current(executable, service_is_running=bool(ready_candidate))
        except (OSError, urllib.error.URLError, RuntimeError) as error:
            if is_openharmony() and isinstance(error, openharmony_module().RecoveryError):
                raise
            # 网络失败时复用仍可工作的本地版本；替换失败则保留原文件，不让一次更新检查打断已有服务。
            write_console("Doxent CLI 更新检查失败，将继续使用当前版本：{}".format(error), sys.stderr)
    else:
        try:
            executable = download_cli()
        except (OSError, urllib.error.URLError, RuntimeError) as error:
            write_console("Doxent CLI 自动下载/安装失败：{}。下载地址：{}".format(error, cli_download_url()), sys.stderr)
            if ready_candidate:
                return ready_candidate
            raise RuntimeError("Doxent CLI 自动下载/安装失败") from error

    # 更新过程可能为了替换 EXE 停止了旧 daemon，因此必须重新探测，不能沿用更新前的健康结论。
    if ready_candidate and not updated and service_ready(ready_candidate):
        return ready_candidate
    endpoint = query_cli_endpoint(executable)
    ready_candidate = cli_endpoint_url(endpoint, url) if endpoint else ""
    if ready_candidate and service_ready(ready_candidate):
        return ready_candidate
    if not start_cli(executable, check_update=False):
        raise RuntimeError("Doxent CLI 进程无法启动")
    deadline = time.time() + SERVICE_READY_TIMEOUT_SECONDS
    while time.time() < deadline:
        endpoint = query_cli_endpoint(executable)
        if endpoint:
            candidate = cli_endpoint_url(endpoint, url)
            if service_ready(candidate):
                return candidate
        time.sleep(SERVICE_READY_INTERVAL_SECONDS)
    raise RuntimeError("Doxent CLI 启动后未在 {} 秒内提供本地服务".format(SERVICE_READY_TIMEOUT_SECONDS))


def run_cli_command(argument):
    candidates = launch_info()
    if argument == "--check-runtime":
        if is_openharmony():
            return openharmony_module().diagnose(candidates, cli_install_path(), write_console)
        write_console("check-runtime 当前仅支持 OpenHarmony CLI。", sys.stderr)
        return 1
    if not any(executable and os.path.isfile(executable) for executable, _ in candidates):
        if argument in ("--stop", "--logout"):
            write_console("Doxent CLI 当前未安装或未运行，无需执行 {}。".format(argument))
            return 0
        if argument == "--login-status":
            # 未找到 CLI 可执行文件时不应为了纯状态查询触发下载安装；没有可用 CLI
            # 也就没有可供本 Skill 使用的完整 CLI 登录会话。
            write_console("未登录")
            return 0
        try:
            candidates = [(download_cli(), "")]
        except (OSError, urllib.error.URLError, RuntimeError) as error:
            write_console("Doxent CLI 自动下载/安装失败：{}。下载地址：{}".format(error, cli_download_url()), sys.stderr)
            return 1
    for executable, _ in candidates:
        if not executable or not os.path.exists(executable):
            continue
        try:
            if argument in ("--settings", "--upload-logs"):
                # 设置页与日志提交都由 CLI 自己完成，不依赖 OpenModel 数据接口。仍执行版本
                # 检查，但不能探测 note health，否则用户的一次独立操作会产生无关本地请求。
                executable, _ = ensure_cli_current(executable, service_is_running=False)
            elif argument == "--login-status":
                # 状态命令由 CLI 直接读取专属会话文件；不得因查询而探测健康接口、更新
                # 二进制或启动 daemon，否则“只返回二值状态”的协议会产生隐藏副作用。
                pass
            elif argument not in ("--stop", "--logout"):
                # 生命周期命令的版本检查也只能依据 CLI 控制通道，不能为了判断是否运行而探测
                # 共享默认端口上的 Electron health。
                executable, _ = ensure_cli_current(executable, service_is_running=bool(query_cli_endpoint(executable)))
            if is_openharmony():
                return openharmony_module().run_command(executable, cli_install_path(), argument, write_console)
            command = cli_command(executable, [argument])
            result = subprocess.run(
                command,
                shell=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=cli_environment(executable),
                # Skill 需要转发远端登录/设置 Markdown、本机页面提示和二值登录状态；
                # 所有动作仍禁止弹出黑色窗口，是否打开页面由调用方选择的显式动作决定。
                creationflags=hidden_creation_flags(),
                text=False,
            )
            if argument in ("--help", "--login", "--login-browser", "--login-status", "--upload-logs", "--settings") and result.stdout:
                write_console(result.stdout.decode("utf-8", errors="replace"))
            if result.returncode != 0 and result.stderr:
                write_console(result.stderr.decode("utf-8", errors="replace"), sys.stderr)
            return result.returncode
        except (OSError, subprocess.SubprocessError):
            continue
    return 127


def recheck_login_status():
    """在数据接口失败后无副作用地复核 CLI 会话状态。

    login-status 只读取 CLI 的专属会话文件，不启动 daemon、不探测 OpenModel
    health，也不会申请新的登录票据。返回值只允许是已登录、未登录或未知。
    """
    stdout = io.StringIO()
    stderr = io.StringIO()
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            run_cli_command("--login-status")
    except Exception:
        return "未知"
    status = stdout.getvalue().strip()
    if "未登录" in status:
        return "未登录"
    if "已登录" in status:
        return "已登录"
    return "未知"


def write_service_failure(message, stream=None):
    """输出服务失败，并把会话复核结果转成可执行的提示。"""
    login_status = recheck_login_status()
    if login_status == "未登录":
        message += " 登录状态复核结果：未登录；请先完成登录后再重试。"
    elif login_status == "已登录":
        message += " 登录状态复核结果：已登录，可能是本地服务启动失败；请稍后重试。"
    else:
        message += " 暂时无法确认登录状态；请先确认已登录后再重试。"
    write_console(message, sys.stderr if stream is None else stream)


def main():
    parser = argparse.ArgumentParser(description="Doxent 本地 API 客户端")
    parser.add_argument("--url", help="完整请求 URL")
    parser.add_argument("--method", default="GET", help="HTTP 方法")
    parser.add_argument("--body-encoded", dest="body_encoded", help="UTF-8 JSON 的 URL 百分号编码字符串")
    parser.add_argument("--body-file", dest="body_file", help="UTF-8 JSON 文件路径")
    parser.add_argument("--body", help="JSON 字符串；Windows PowerShell 5.1 不建议使用")
    parser.add_argument("--token", help="Bearer token")
    parser.add_argument("--no-auto-start", action="store_true", help="服务不可用时不自动启动 Doxent CLI")
    # login 保留默认远端语义；login-status 只查询二值会话状态；upload-logs 由 CLI
    # 直接压缩并提交诊断日志。这些控制动作都不能误走到 OpenModel HTTP 数据请求链路。
    parser.add_argument("--cli-action", choices=("login", "login-status", "login-browser", "logout", "stop", "help", "settings", "upload-logs", "check-runtime"), help="直接控制 Doxent CLI 生命周期、查询登录状态、打开设置页、上传日志或诊断鸿蒙运行时")
    args = parser.parse_args()

    if args.cli_action:
        if is_openharmony():
            try:
                return run_cli_command("--" + args.cli_action)
            except (OSError, RuntimeError) as error:
                write_console(str(error), sys.stderr)
                return 1
        return run_cli_command("--" + args.cli_action)
    if not args.url:
        parser.error("API 请求必须提供 --url")
    if not is_local_api_url(args.url):
        write_console("Doxent API 只允许访问 http://127.0.0.1 或 http://localhost，本次请求已拒绝。", sys.stderr)
        return 2

    data = None
    if args.body_encoded:
        data = urllib.parse.unquote(args.body_encoded, encoding="utf-8").encode("utf-8")
    elif args.body_file:
        with open(args.body_file, "r", encoding="utf-8-sig") as handle:
            data = handle.read().encode("utf-8")
    elif args.body:
        data = args.body.encode("utf-8")

    request_url = ""
    # 每次真实数据脚本都先确保后台 CLI 存活；请求完成后不发送 stop，供后续脚本复用同一 daemon。
    if not args.no_auto_start:
        try:
            request_url = ensure_service(args.url)
        except RuntimeError as error:
            write_service_failure(str(error), sys.stderr)
            return 1
    else:
        # 即使调用方禁止自动启动，也必须先由 CLI 控制通道确认地址；该开关只禁止拉起进程，
        # 不能把业务请求退回默认端口，否则仍可能直接命中 Electron。
        executable = next((item for item, _ in launch_info() if item and os.path.isfile(item)), "")
        endpoint = query_cli_endpoint(executable)
        if not endpoint:
            write_service_failure("无法确认正在运行的 Doxent CLI endpoint。", sys.stderr)
            return 1
        request_url = cli_endpoint_url(endpoint, args.url)
    sync_gate = wait_for_sync_gate(request_url, args.method)
    if sync_gate == SYNC_GATE_BLOCKED:
        # 首次批次间隙仅放行精确读写白名单；其它请求或同步等待失败时不调用业务接口。
        return 2
    request = urllib.request.Request(request_url, data=data, headers={"Content-Type": "application/json; charset=utf-8"}, method=args.method.upper())
    if args.token:
        request.add_header("Authorization", "Bearer " + args.token)
    try:
        timeout = resolve_timeout(request_url)
        response = urllib.request.urlopen(request, **({} if timeout is None else {"timeout": timeout}))
        with response:
            response_text = response.read().decode("utf-8")
        write_console(response_text)
        # 唤醒必须发生在业务响应已完整消费且连接已关闭之后。只有门禁明确判定为
        # partial_idle 的白名单读取才执行；普通完成态、写操作和未知路径永不触发。
        if sync_gate == SYNC_GATE_PARTIAL:
            request_next_initial_note_batch()
        return 0
    except urllib.error.HTTPError as error:
        # HTTPError 仍携带服务端业务响应；先完整消费并关闭，再按同一 partial 标记唤醒。
        # 唤醒结果不得覆盖原 HTTP 状态和退出码。
        with error:
            error_text = error.read().decode("utf-8", errors="replace")
        if error.code in (401, 403):
            write_service_failure("HTTP {}: {}".format(error.code, error_text), sys.stderr)
        else:
            write_console("HTTP {}: {}".format(error.code, error_text), sys.stderr)
        if sync_gate == SYNC_GATE_PARTIAL:
            request_next_initial_note_batch()
        return 1
    except urllib.error.URLError as error:
        if urllib.parse.urlsplit(request_url).path.rstrip("/") == "/open-model/sync":
            # 同步请求可能已被服务端接收；整轮只发起一次，地址变化也不自动重放。
            write_console("同步请求结果未确认：{}；不自动重复调用。".format(error.reason), sys.stderr)
            return 1
        # CLI 可能恰好在更新或重启，旧地址连接失败时重新从控制通道获取一次地址。
        # 只有地址确实变化才重放请求，避免未知写请求结果时盲目重复提交。
        executable = next((item for item, _ in launch_info() if item and os.path.isfile(item)), "")
        endpoint = query_cli_endpoint(executable)
        retry_url = cli_endpoint_url(endpoint, args.url) if endpoint else ""
        if retry_url and retry_url != request_url:
            retry_gate = wait_for_sync_gate(retry_url, args.method)
            if retry_gate != SYNC_GATE_BLOCKED:
                retry_request = urllib.request.Request(retry_url, data=data, headers={"Content-Type": "application/json; charset=utf-8"}, method=args.method.upper())
                if args.token:
                    retry_request.add_header("Authorization", "Bearer " + args.token)
                try:
                    with urllib.request.urlopen(retry_request, **({} if resolve_timeout(retry_url) is None else {"timeout": resolve_timeout(retry_url)})) as retry_response:
                        write_console(retry_response.read().decode("utf-8"))
                    if retry_gate == SYNC_GATE_PARTIAL:
                        request_next_initial_note_batch()
                    return 0
                except urllib.error.HTTPError as retry_error:
                    with retry_error:
                        retry_text = retry_error.read().decode("utf-8", errors="replace")
                    write_console("HTTP {}: {}".format(retry_error.code, retry_text), sys.stderr)
                    return 1
                except urllib.error.URLError:
                    pass
        # 自动安装、路径发现和启动均已在 ensure_service 中完成；连接失败也可能是会话失效。
        # 复核登录状态后给出可执行建议。
        write_service_failure("Doxent CLI 已自动安装并尝试启动，但本地服务仍不可用：{}。".format(error.reason), sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
