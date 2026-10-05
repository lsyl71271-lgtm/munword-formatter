# First-time install and update for Windows.
#
# Copies the engine to %LOCALAPPDATA%\PKUNMUN2026Formatter, builds a private
# Python environment there, creates the shortcuts and opens the page.  Re-run
# it after unpacking a newer package to update; dependencies are reinstalled
# only when the requirements change.

. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'shortcuts.ps1')

$SourceRoot = Split-Path $PSScriptRoot -Parent
$Requirements = Join-Path (Join-Path $SourceRoot 'backend') 'requirements-windows.txt'
$RequirementsStamp = Join-Path $InstallRoot '.requirements.sha256'
$MinimumPython = [version]'3.9'
# Tried when the default package index is unreachable, which is common on
# campus networks in mainland China.
$MirrorIndex = 'https://pypi.tuna.tsinghua.edu.cn/simple'
$PythonHelp = "未找到可用的 Python（需要 3.9 或更高版本）。`n`n请从 https://www.python.org/downloads/windows/ 下载安装 Python，安装时勾选`“Add python.exe to PATH`”，然后重新运行本安装程序。"

function Write-Step([string]$Text) { Write-Host "`n>> $Text" -ForegroundColor Cyan }

function Find-Python {
    # The py launcher comes with the python.org installer and picks the newest
    # version; "python" may instead be the Microsoft Store placeholder, which
    # prints nothing useful and fails.
    $candidates = @(@('py', '-3'), @('python'), @('python3'))
    foreach ($candidate in $candidates) {
        $exe = $candidate[0]
        $prefix = @($candidate | Select-Object -Skip 1)
        if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
        try {
            $output = & $exe @prefix -c 'import sys; print("%d.%d|%s" % (sys.version_info[0], sys.version_info[1], sys.executable))' 2>$null
        } catch { continue }
        if ($LASTEXITCODE -ne 0 -or -not $output) { continue }
        $parts = ([string]($output | Select-Object -Last 1)).Trim().Split('|')
        if ($parts.Count -lt 2) { continue }
        if ([version]$parts[0] -ge $MinimumPython) {
            return @{ Version = $parts[0]; Executable = $parts[1] }
        }
    }
    return $null
}

function Copy-Runtime {
    # Only what the local engine serves: the Python backend, the local page,
    # its stylesheet (app/globals.css), icons, rules and these scripts.
    foreach ($item in @('backend', 'local_web', 'app', 'public', 'templates', 'shared', 'windows')) {
        $target = Join-Path $InstallRoot $item
        if (Test-Path $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        Copy-Item -LiteralPath (Join-Path $SourceRoot $item) -Destination $target -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path $SourceRoot 'VERSION') -Destination (Join-Path $InstallRoot 'VERSION') -Force
    Get-ChildItem -LiteralPath $InstallRoot -Recurse -Filter '__pycache__' -Directory -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    if ($OnWindows) {
        # Files unpacked from a downloaded zip carry a "from the internet" mark.
        Get-ChildItem -LiteralPath $InstallRoot -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
    }
}

function Test-VenvHealthy {
    $python = Get-VenvPython
    if (-not (Test-Path $python)) { return $false }
    try {
        & $python -c 'import sys' 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}

function Install-Requirements {
    $python = Get-VenvPython
    $hash = (Get-FileHash -Algorithm SHA256 $Requirements).Hash
    if ((Test-Path $RequirementsStamp) -and ((Get-Content $RequirementsStamp -Raw).Trim() -eq $hash)) {
        Write-Host '依赖已是最新。'
        return
    }
    & $python -m pip install --disable-pip-version-check -r $Requirements
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n默认下载源失败，改用清华大学镜像重试……" -ForegroundColor Yellow
        & $python -m pip install --disable-pip-version-check -i $MirrorIndex -r $Requirements
    }
    if ($LASTEXITCODE -ne 0) {
        throw '运行组件下载失败。请确认网络连接后重新运行安装程序；若仍失败，可改装 Python 3.12 或 3.13 再试。'
    }
    Set-Content -Path $RequirementsStamp -Value $hash -Encoding ASCII
}

try {
    Write-Host "$AppName · Windows 安装" -ForegroundColor Green
    Write-Host '将安装到当前用户目录，DOCX 只在本机处理，不会上传。首次安装需要联网下载运行组件（约 30 MB）。'

    Write-Step '检查 Python'
    $found = Find-Python
    if (-not $found) {
        Show-Message $PythonHelp 'Warning'
        exit 1
    }
    Write-Host "使用 Python $($found.Version)：$($found.Executable)"

    Write-Step '停止正在运行的旧版本'
    if ((Get-EngineState) -eq 'ours') {
        # Continuing would leave the old engine serving the old program.
        if (-not (Stop-Engine)) { throw '无法停止正在运行的旧版排版引擎（它可能不是从安装目录启动的）。请先关闭它或重启电脑，再重新运行安装程序。' }
    }

    Write-Step "复制程序到 $InstallRoot"
    New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
    Copy-Runtime

    Write-Step '准备 Python 运行环境'
    if (-not (Test-VenvHealthy)) {
        if (Test-Path $VenvDir) { Remove-Item -LiteralPath $VenvDir -Recurse -Force }
        Remove-Item -LiteralPath $RequirementsStamp -Force -ErrorAction SilentlyContinue
        & $found.Executable -m venv $VenvDir
        if ($LASTEXITCODE -ne 0) { throw '无法创建 Python 运行环境。' }
    }
    Install-Requirements

    Write-Step '创建桌面和开始菜单快捷方式'
    try { New-AppShortcuts } catch { Write-Host "快捷方式创建失败（不影响使用）：$($_.Exception.Message)" -ForegroundColor Yellow }

    Write-Step '启动排版引擎'
    & (Join-Path (Join-Path $InstallRoot 'windows') 'start.ps1')
    if ($LASTEXITCODE -ne 0) { exit 1 }

    Show-Message "安装完成，排版系统已在浏览器中打开。`n`n以后双击桌面上的`“$AppName`”即可使用。"
    exit 0
} catch {
    Show-Message "安装未完成：$($_.Exception.Message)" 'Error'
    exit 1
}
