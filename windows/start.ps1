# Start the local engine if needed, then open the page.
# The desktop shortcut runs this hidden, so every problem is reported in a
# message box rather than on a console nobody can see.

. (Join-Path $PSScriptRoot 'common.ps1')

function Open-Page {
    $version = 'current'
    $versionFile = Join-Path $InstallRoot 'VERSION'
    if (Test-Path $versionFile) { $version = (Get-Content $versionFile -Raw).Trim() }
    if ($env:PKUNMUN_NO_BROWSER) { return }
    Start-Process "$EngineUrl/?v=$version"
}

try {
    $state = Get-EngineState
    if ($state -eq 'ours') {
        Open-Page
        exit 0
    }
    if ($state -eq 'other') {
        Show-Message "端口 $Port 已被其他程序占用（常见于开发服务器）。请先退出该程序，再重新打开本应用。" 'Warning'
        exit 1
    }

    $python = Get-VenvPython
    $server = Join-Path (Join-Path $InstallRoot 'backend') 'run.py'
    if (-not (Test-Path $python) -or -not (Test-Path $server)) {
        Show-Message "尚未安装运行环境。请在解压后的文件夹中双击`“Windows 首次安装.bat`”。" 'Warning'
        exit 1
    }

    # Keep one previous log instead of growing without bound.
    foreach ($log in @($LogFile, $OutLogFile)) {
        if ((Test-Path $log) -and ((Get-Item $log).Length -gt $MaxLogBytes)) {
            Move-Item $log "$log.old" -Force
        }
    }

    $options = @{
        FilePath               = $python
        ArgumentList           = @("`"$server`"")
        WorkingDirectory       = (Split-Path $server)
        RedirectStandardOutput = $OutLogFile
        RedirectStandardError  = $LogFile
        PassThru               = $true
    }
    if ($OnWindows) { $options.WindowStyle = 'Hidden' }
    $process = Start-Process @options
    Set-Content -Path $PidFile -Value $process.Id -Encoding ASCII

    # A cold start imports lxml and FastAPI; allow up to 30 s.
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Milliseconds 250
        if ((Get-EngineState) -eq 'ours') {
            Open-Page
            exit 0
        }
        if ($process.HasExited) { break }
    }
    Show-Message "排版引擎未能启动。请把以下日志文件发给维护者：`n$LogFile" 'Error'
    exit 1
} catch {
    Show-Message "启动失败：$($_.Exception.Message)" 'Error'
    exit 1
}
