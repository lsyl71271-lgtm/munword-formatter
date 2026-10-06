; PKUNMUN 2026 文件排版系统 — Windows installer.
; Per-user install (no administrator rights, no UAC prompt) into %LOCALAPPDATA%\Programs, desktop and
; Start-menu shortcuts, an entry in “应用和功能” for uninstalling. Nothing is downloaded while
; installing and the installed program never goes online. Silent install: setup.exe /S
; 32-bit and Unicode: runs on 32- and 64-bit Windows 7 to 11 and on ARM (x86 emulation); sharp at any display scaling.
; Built by desktop/build-desktop.mjs after launcher.nsi (needs PKUNMUN2026Formatter.exe, app.ico, site\).
Unicode true
RequestExecutionLevel user
ManifestDPIAware true
ManifestDPIAwareness "PerMonitorV2,System"
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "browsers.nsh"

!ifdef SIGN
  !finalize '"${SIGN}" "%1"' = 0
  !uninstfinalize '"${SIGN}" "%1"' = 0
!endif

!define APP_NAME "PKUNMUN 2026 文件排版系统"
!define APP_ID "PKUNMUN2026Formatter"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"

Name "${APP_NAME}"
Caption "${APP_NAME} ${VERSION} 安装"
UninstallCaption "卸载 ${APP_NAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP_ID}"
ShowInstDetails nevershow
ShowUninstDetails nevershow
BrandingText "PKUNMUN 2026 · 本机离线版"
VIProductVersion "${VERSION4}"
VIAddVersionKey /LANG=2052 "ProductName" "${APP_NAME}"
VIAddVersionKey /LANG=2052 "FileDescription" "${APP_NAME} 安装程序（本机离线版）"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "PKUNMUN 2026"

!define MUI_ICON "app.ico"
!define MUI_UNICON "app.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEFINISHPAGE_BITMAP "sidebar.bmp"
!define MUI_WELCOMEPAGE_TITLE "安装 ${APP_NAME}"
!define MUI_WELCOMEPAGE_TEXT "将把排版系统安装到当前用户，并在桌面和开始菜单放好快捷方式。$\r$\n$\r$\n· 不需要管理员权限，也不需要 Python 等运行环境$\r$\n· 文件只在本机浏览器里处理，程序不联网、不上传任何内容$\r$\n· 版本 ${VERSION}，安装只需几秒$\r$\n$\r$\n点击「安装」即可。"
!define MUI_PAGE_CUSTOMFUNCTION_SHOW WelcomeShow
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "以后双击桌面上的「${APP_NAME}」即可打开。$\r$\n$\r$\n生成的 DOCX 会保存到「下载」文件夹。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_ID}.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即打开 ${APP_NAME}"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\使用说明.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "查看使用说明"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishShow
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function WelcomeShow
  ; One click: the welcome page's button installs directly.
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:安装"
FunctionEnd

Function FinishShow
  ; An old PC with only Internet Explorer or an outdated browser: say what to install before first use.
  Call FindBrowser
  ${If} $BrowserCurrent != 1
    SendMessage $mui.FinishPage.Text ${WM_SETTEXT} 0 "STR:注意：这台电脑上没有新版 Edge、Chrome 或 Firefox，请先安装其中一个再打开本程序。$\r$\n$\r$\nWindows 7 / 8.1 可用 Chrome 109 或 Firefox ESR 115。"
  ${EndIf}
FunctionEnd

Section "Install"
  ; Leaves room under the 260-character Windows path limit for the deepest file (site\licenses\…).
  StrLen $0 "$INSTDIR"
  ${If} $0 > 200
    MessageBox MB_OK|MB_ICONSTOP "安装位置的路径太长（超过 200 个字符），请换一个较短的位置后重新安装。" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  SetOutPath "$INSTDIR"
  ; An update replaces the previous page completely; nothing from the old version is kept.
  RMDir /r "$INSTDIR\site"
  File /r "site"
  File "${APP_ID}.exe"
  File "app.ico"
  File "使用说明.txt"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_ID}.exe" "" "$INSTDIR\app.ico" 0
  CreateShortcut "$SMPROGRAMS\${APP_NAME}.lnk" "$INSTDIR\${APP_ID}.exe" "" "$INSTDIR\app.ico" 0
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "PKUNMUN 2026"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\app.ico"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" $0
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
  RMDir /r "$INSTDIR\site"
  Delete "$INSTDIR\${APP_ID}.exe"
  Delete "$INSTDIR\app.ico"
  Delete "$INSTDIR\使用说明.txt"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
