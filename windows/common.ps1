# Shared settings for the Windows install / start / stop scripts.
# Written for Windows PowerShell 5.1 (built into Windows 10/11): no ?., ??,
# ternaries or && chains.

$ErrorActionPreference = 'Stop'

$AppName = 'PKUNMUN 2026 文件排版系统'
$ServiceId = 'pkunmun-2026-formatter'
# PKUNMUN_PORT only exists for testing; the engine itself always listens on 8000.
$Port = 8000
if ($env:PKUNMUN_PORT) { $Port = [int]$env:PKUNMUN_PORT }
$EngineUrl = "http://127.0.0.1:$Port"

$InstallRoot = Join-Path $env:LOCALAPPDATA 'PKUNMUN2026Formatter'
$VenvDir = Join-Path $InstallRoot 'venv'
$PidFile = Join-Path $InstallRoot 'engine.pid'
$LogFile = Join-Path $InstallRoot 'backend.log'
$OutLogFile = Join-Path $InstallRoot 'backend.out.log'
$MaxLogBytes = 5MB

$OnWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or $IsWindows

function Get-VenvPython {
    $windowsPython = Join-Path $VenvDir 'Scripts\python.exe'
    if (Test-Path $windowsPython) { return $windowsPython }
    # Lets the scripts be exercised on macOS/Linux during development.
    $posixPython = Join-Path $VenvDir 'bin/python'
    if (Test-Path $posixPython) { return $posixPython }
    return $windowsPython
}

function Show-Message {
    param([string]$Text, [string]$Kind = 'Information')
    if ($OnWindows) {
        try {
            Add-Type -AssemblyName PresentationFramework
            [void][System.Windows.MessageBox]::Show($Text, $AppName, 'OK', $Kind)
            return
        } catch { }
    }
    Write-Host $Text
}

function Confirm-Choice {
    param([string]$Text)
    if ($OnWindows) {
        try {
            Add-Type -AssemblyName PresentationFramework
            return ([System.Windows.MessageBox]::Show($Text, $AppName, 'YesNo', 'Question') -eq 'Yes')
        } catch { }
    }
    return ((Read-Host "$Text [y/N]") -match '^[yY]')
}

function Get-InstalledVersion {
    $versionFile = Join-Path $InstallRoot 'VERSION'
    if (Test-Path $versionFile) { return (Get-Content $versionFile -Raw).Trim() }
    return ''
}

# 'ours'  - our engine answers on the port (in the expected version, if one is given)
# 'stale' - our engine answers, but in another version (as the macOS launcher checks)
# 'other' - something else holds the port
# 'none'  - the port is free
function Get-EngineState {
    param([string]$ExpectedVersion = '')
    try {
        $health = Invoke-RestMethod -Uri "$EngineUrl/api/health" -TimeoutSec 2 -UseBasicParsing
        if ($health.service -eq $ServiceId) {
            if ($ExpectedVersion -and ("$($health.version)" -ne $ExpectedVersion)) { return 'stale' }
            return 'ours'
        }
        return 'other'
    } catch { }
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { return 'other' }
    }
    return 'none'
}

function Test-EngineProcess {
    param([int]$ProcessId)
    # A venv python.exe on Windows is a small redirector; the process that
    # actually listens is the base interpreter.  Both carry our run.py path on
    # their command line, which is what identifies the engine.
    $marker = Join-Path $InstallRoot 'backend'
    $commandLine = ''
    if ($OnWindows) {
        $info = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
        if ($info) { $commandLine = "$($info.CommandLine)" }
    } else {
        $commandLine = "$(& ps -o command= -p $ProcessId 2>$null)"
    }
    return $commandLine.Contains($marker)
}

function Stop-Engine {
    # Only ever stops the engine this installer started, never whatever else
    # might have reused the process id or taken the port.
    if (Test-Path $PidFile) {
        $enginePid = [int](Get-Content $PidFile -Raw)
        if (Test-EngineProcess $enginePid) {
            Stop-Process -Id $enginePid -Force -ErrorAction SilentlyContinue
        }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        foreach ($connection in @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
            if (Test-EngineProcess $connection.OwningProcess) {
                Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        }
    }
    for ($i = 0; $i -lt 20; $i++) {
        if ((Get-EngineState) -ne 'ours') { return $true }
        Start-Sleep -Milliseconds 250
    }
    return $false
}
