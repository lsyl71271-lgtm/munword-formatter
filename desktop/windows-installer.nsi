Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"

Name "Munword 本机排版 ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Munword"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ManifestDPIAware true
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "Munword 本机排版"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "FileDescription" "完全离线 · 无需 Python/Node · 当前用户安装"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\app\Munword.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即打开本机排版程序"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "本安装包需要 Windows 10 或更新系统。Windows 7/8 与 Internet Explorer 未通过验收，请勿作为兼容版本使用。"
    Abort
  ${EndIf}
  !if "${ARCH}" == "x64"
    ${IfNot} ${RunningX64}
      MessageBox MB_ICONSTOP "这是 64 位安装包。32 位 Windows 请下载 x86 安装包。"
      Abort
    ${EndIf}
  !endif
  SetShellVarContext current
FunctionEnd

Section "安装"
  StrLen $0 $INSTDIR
  ${If} $0 > 160
    MessageBox MB_ICONSTOP "安装路径过长。请改用较短的用户目录或安装路径（最多 160 个字符）。"
    Abort
  ${EndIf}
  IfFileExists "$INSTDIR\app\Munword.exe" 0 +3
    ExecWait '"$INSTDIR\app\Munword.exe" --quit' $0
    Sleep 2000
  SetOutPath "$INSTDIR\app"
  ClearErrors
  File /r "${BUNDLE}\*"
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "程序文件无法写入。请先关闭旧版程序，再重新运行安装包。"
    Abort
  ${EndIf}
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Munword"
  CreateShortcut "$SMPROGRAMS\Munword\Munword 本机排版.lnk" "$INSTDIR\app\Munword.exe"
  CreateShortcut "$DESKTOP\Munword 本机排版.lnk" "$INSTDIR\app\Munword.exe"
  CreateShortcut "$SMPROGRAMS\Munword\卸载.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Munword" "DisplayName" "Munword 本机排版"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Munword" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Munword" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Munword" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Munword" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Munword" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  ExecWait '"$INSTDIR\app\Munword.exe" --quit' $0
  Sleep 2000
  RMDir /r "$INSTDIR\app"
  Delete "$DESKTOP\Munword 本机排版.lnk"
  RMDir /r "$SMPROGRAMS\Munword"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Munword"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  ; User documents/downloads are never in the installation folder; runtime
  ; logs/state are preserved in LOCALAPPDATA\Munword for troubleshooting.
SectionEnd
