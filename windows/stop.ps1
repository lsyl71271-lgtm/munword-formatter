# Stop the local engine started by start.ps1.

. (Join-Path $PSScriptRoot 'common.ps1')

try {
    if ((Get-EngineState) -ne 'ours') {
        Show-Message '排版引擎当前没有运行。'
        exit 0
    }
    if (Stop-Engine) {
        Show-Message '排版引擎已停止。'
        exit 0
    }
    Show-Message '未能停止排版引擎，请重启电脑后再试。' 'Warning'
    exit 1
} catch {
    Show-Message "停止失败：$($_.Exception.Message)" 'Error'
    exit 1
}
