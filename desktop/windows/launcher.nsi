; PKUNMUN 2026 文件排版系统 — Windows launcher (PKUNMUN2026Formatter.exe, installed next to site\).
; Opens the offline page site\index.html straight from disk: Edge, Chrome, Brave or Vivaldi show it as
; their own app window, Firefox in a new window, otherwise the default browser opens it (browsers.nsh
; picks one). No server is started and nothing goes online; the page's Content-Security-Policy
; forbids every network connection. 32-bit, so it runs on 32- and 64-bit Windows 7–11 and on ARM.
; Built by desktop/build-desktop.mjs: makensis -DVERSION=x.y.z -DVERSION4=x.y.z.0 launcher.nsi
Unicode true
SilentInstall silent
RequestExecutionLevel user
ManifestDPIAware true
ManifestDPIAwareness "PerMonitorV2,System"
SetCompressor /SOLID lzma

!include "LogicLib.nsh"
!include "WordFunc.nsh"
!include "browsers.nsh"

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
  ${If} $Browser != ""
    ClearErrors
    ${If} $BrowserKind == "firefox"
      Exec '"$Browser" -new-window "$url"'
    ${Else}
      ; First-run flags keep a never-opened Edge or Chrome from showing its welcome pages instead.
      Exec '"$Browser" --app="$url" --no-first-run --no-default-browser-check'
    ${EndIf}
    ${IfNot} ${Errors}
      Quit
    ${EndIf}
  ${EndIf}
  ClearErrors
  ExecShell "open" "$page"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "没有找到可用的浏览器。请安装或更新 Microsoft Edge、Chrome 或 Firefox 后重试。$\r$\n（Windows 7 / 8.1 可用 Chrome 109 或 Firefox ESR 115。）"
  ${EndIf}
SectionEnd
