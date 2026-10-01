# Desktop and Start-menu shortcuts.  The launcher shortcut carries the same
# name as the macOS app, which is what the page's error messages refer to.

function Get-ShortcutPaths {
    return @{
        Desktop   = Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"
        StartMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'PKUNMUN 2026'
    }
}

function New-AppShortcut {
    param([string]$Path, [string]$Script, [string]$Description)
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $InstallRoot "windows\$Script")`""
    $shortcut.WorkingDirectory = $InstallRoot
    $shortcut.WindowStyle = 7
    $shortcut.Description = $Description
    $icon = Join-Path $InstallRoot 'windows\app.ico'
    if (Test-Path $icon) { $shortcut.IconLocation = $icon }
    $shortcut.Save()
}

function New-AppShortcuts {
    if (-not $OnWindows) { return }
    $paths = Get-ShortcutPaths
    New-Item -ItemType Directory -Force -Path $paths.StartMenu | Out-Null
    New-AppShortcut -Path $paths.Desktop -Script 'start.ps1' -Description '打开 PKUNMUN 2026 文件排版系统'
    New-AppShortcut -Path (Join-Path $paths.StartMenu "$AppName.lnk") -Script 'start.ps1' -Description '打开 PKUNMUN 2026 文件排版系统'
    New-AppShortcut -Path (Join-Path $paths.StartMenu '停止排版引擎.lnk') -Script 'stop.ps1' -Description '停止本机排版引擎'
    New-AppShortcut -Path (Join-Path $paths.StartMenu '卸载.lnk') -Script 'uninstall.ps1' -Description '卸载 PKUNMUN 2026 文件排版系统'
}

function Remove-AppShortcuts {
    if (-not $OnWindows) { return }
    $paths = Get-ShortcutPaths
    Remove-Item -LiteralPath $paths.Desktop -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $paths.StartMenu -Recurse -Force -ErrorAction SilentlyContinue
}
