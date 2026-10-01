@echo off
rem Runs the PowerShell installer; the script itself explains every step.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\install.ps1"
echo.
pause
