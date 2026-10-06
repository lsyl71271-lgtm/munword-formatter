; PKUNMUN 2026 文件排版系统 — Windows launcher (PKUNMUN2026Formatter.exe, installed next to site\).
; Opens the offline page site\index.html straight from disk: Microsoft Edge or Google Chrome shows it
; as its own app window, otherwise the default browser opens it. No server is started and nothing
; goes online; the page's Content-Security-Policy forbids every network connection.
; Built by desktop/build-desktop.mjs: makensis -DVERSION=x.y.z -DVERSION4=x.y.z.0 launcher.nsi
Unicode true
SilentInstall silent
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "LogicLib.nsh"
!include "WordFunc.nsh"
!include "x64.nsh"

Name "PKUNMUN 2026 文件排版系统"
OutFile "PKUNMUN2026Formatter.exe"
Icon "app.ico"
VIProductVersion "${VERSION4}"
VIAddVersionKey /LANG=2052 "ProductName" "PKUNMUN 2026 文件排版系统"
VIAddVersionKey /LANG=2052 "FileDescription" "PKUNMUN 2026 文件排版系统（本机离线版）"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "PKUNMUN 2026"

Var page
Var url
Var browser

!macro TryAppPath ROOT EXE
  ${If} $browser == ""
    ReadRegStr $0 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\App Paths\${EXE}" ""
    ${WordReplace} $0 '"' "" "+" $0
    ${If} $0 != ""
    ${AndIf} ${FileExists} "$0"
      StrCpy $browser "$0"
    ${EndIf}
  ${EndIf}
!macroend

!macro TryFile FILE
  ${If} $browser == ""
  ${AndIf} ${FileExists} "${FILE}"
    StrCpy $browser "${FILE}"
  ${EndIf}
!macroend

Function FindBrowser
  StrCpy $browser ""
  ; Both registry views: a 64-bit Windows keeps some App Paths entries outside WOW6432Node.
  ${If} ${RunningX64}
    SetRegView 64
    !insertmacro TryAppPath HKCU "msedge.exe"
    !insertmacro TryAppPath HKLM "msedge.exe"
    SetRegView 32
  ${EndIf}
  !insertmacro TryAppPath HKCU "msedge.exe"
  !insertmacro TryAppPath HKLM "msedge.exe"
  !insertmacro TryFile "$PROGRAMFILES32\Microsoft\Edge\Application\msedge.exe"
  !insertmacro TryFile "$PROGRAMFILES64\Microsoft\Edge\Application\msedge.exe"
  !insertmacro TryFile "$LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
  ${If} ${RunningX64}
    SetRegView 64
    !insertmacro TryAppPath HKCU "chrome.exe"
    !insertmacro TryAppPath HKLM "chrome.exe"
    SetRegView 32
  ${EndIf}
  !insertmacro TryAppPath HKCU "chrome.exe"
  !insertmacro TryAppPath HKLM "chrome.exe"
  !insertmacro TryFile "$PROGRAMFILES64\Google\Chrome\Application\chrome.exe"
  !insertmacro TryFile "$PROGRAMFILES32\Google\Chrome\Application\chrome.exe"
  !insertmacro TryFile "$LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
FunctionEnd

Section
  StrCpy $page "$EXEDIR\site\index.html"
  ${IfNot} ${FileExists} "$page"
    MessageBox MB_OK|MB_ICONSTOP "程序文件不完整，请重新运行安装程序。"
    Quit
  ${EndIf}
  ; file:/// URL; the browser encodes Chinese user names itself, URL syntax characters are escaped here.
  ${WordReplace} "$page" "%" "%25" "+" $url
  ${WordReplace} "$url" "\" "/" "+" $url
  ${WordReplace} "$url" " " "%20" "+" $url
  ${WordReplace} "$url" "#" "%23" "+" $url
  StrCpy $url "file:///$url"
  Call FindBrowser
  ${If} $browser != ""
    ClearErrors
    Exec '"$browser" --app="$url"'
    ${IfNot} ${Errors}
      Quit
    ${EndIf}
  ${EndIf}
  ClearErrors
  ExecShell "open" "$page"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "没有找到可用的浏览器。请安装或更新 Microsoft Edge 或 Chrome 后重试。"
  ${EndIf}
SectionEnd
