# Remove the engine, its Python environment and the shortcuts.
# The extracted folder the user downloaded is left alone.

. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'shortcuts.ps1')

try {
    if (-not (Confirm-Choice "将删除本机安装的排版引擎、Python 运行环境和快捷方式。`n用户自己的 DOCX 文件不受影响。是否继续？")) { exit 0 }
    Stop-Engine | Out-Null
    Remove-AppShortcuts
    # This script lives inside the folder being removed; hand the deletion to
    # a separate process so it is not holding its own files open.
    $cleanup = "Start-Sleep -Seconds 2; Remove-Item -LiteralPath '$($InstallRoot.Replace("'", "''"))' -Recurse -Force"
    if ($OnWindows) {
        Start-Process powershell.exe -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-Command', $cleanup) -WindowStyle Hidden
    } else {
        Remove-Item -LiteralPath $InstallRoot -Recurse -Force
    }
    Show-Message '已卸载。'
} catch {
    Show-Message "卸载失败：$($_.Exception.Message)" 'Error'
    exit 1
}
