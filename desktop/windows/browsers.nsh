; PKUNMUN 2026 文件排版系统 — finds a browser that can run the offline page (used by launcher.nsi and
; installer.nsi). The page needs Chromium 99 or Firefox 104 or later, i.e. any up-to-date Edge, Chrome or
; Firefox, including the last releases for Windows 7 / 8.1 (Chrome and Edge 109, Firefox ESR 115).
;
; Order: the user's default browser when it is one of those below, then Edge, Chrome, Brave, Vivaldi,
; Chromium and Firefox via App Paths (both registry views) and their usual folders. A browser that is
; too old is kept only when nothing newer exists; the page then explains what to update.
;
;   Call FindBrowser  →  $Browser        full path of the browser, "" when none was found
;                        $BrowserKind    "chromium" (opens an --app window) or "firefox"
;                        $BrowserCurrent 1 when $Browser is new enough for the page
; Uses $R0–$R9.

!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "WordFunc.nsh"
!include "x64.nsh"

Var Browser
Var BrowserKind
Var BrowserCurrent

; $R9 path, $R8 kind, $R7 oldest major version that runs the page (0: the version number says nothing).
Function _BrowserConsider
  ${IfNot} ${FileExists} "$R9"
    Return
  ${EndIf}
  StrCpy $R6 1
  ${If} $R7 != 0
    ClearErrors
    GetDLLVersion "$R9" $R5 $R4
    ${IfNot} ${Errors}
      IntOp $R5 $R5 >> 16
      ${If} $R5 < $R7
        StrCpy $R6 0
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $R6 == 1
  ${OrIf} $Browser == ""
    StrCpy $Browser "$R9"
    StrCpy $BrowserKind "$R8"
    StrCpy $BrowserCurrent $R6
  ${EndIf}
FunctionEnd

!macro _BrowserConsider PATH KIND MIN
  ${If} $BrowserCurrent != 1
    StrCpy $R9 "${PATH}"
    StrCpy $R8 "${KIND}"
    StrCpy $R7 "${MIN}"
    Call _BrowserConsider
  ${EndIf}
!macroend

; Executable of the browser named by a registry value: App Paths store a plain or quoted path.
!macro _BrowserAppPath EXE KIND MIN
  ${If} $BrowserCurrent != 1
    ReadRegStr $R3 HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${EXE}" ""
    ${If} $R3 == ""
      ReadRegStr $R3 HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\${EXE}" ""
    ${EndIf}
    ${WordReplace} "$R3" '"' "" "+" $R3
    ${If} $R3 != ""
      !insertmacro _BrowserConsider "$R3" "${KIND}" "${MIN}"
    ${EndIf}
  ${EndIf}
!macroend

Function _BrowserAppPaths
  !insertmacro _BrowserAppPath "msedge.exe" chromium 99
  !insertmacro _BrowserAppPath "chrome.exe" chromium 99
  ; Brave and Vivaldi number their releases independently of Chromium.
  !insertmacro _BrowserAppPath "brave.exe" chromium 0
  !insertmacro _BrowserAppPath "vivaldi.exe" chromium 0
  !insertmacro _BrowserAppPath "firefox.exe" firefox 104
FunctionEnd

; The default web browser: UserChoice names a ProgId whose open command starts with the executable,
; quoted ("C:\…\chrome.exe" --single-argument %1) or not. The ProgId is registered per user or per
; machine; both are read directly rather than through the merged HKCR view.
Function _BrowserDefault
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice" "ProgId"
  ${If} $R0 == ""
    Return
  ${EndIf}
  ReadRegStr $R1 HKCU "Software\Classes\$R0\shell\open\command" ""
  ${If} $R1 == ""
    ReadRegStr $R1 HKLM "Software\Classes\$R0\shell\open\command" ""
  ${EndIf}
  ${If} $R1 == ""
    ReadRegStr $R1 HKCR "$R0\shell\open\command" ""
  ${EndIf}
  StrCpy $R2 $R1 1
  ${If} $R2 == '"'
    StrCpy $R1 $R1 "" 1
    StrCpy $R3 '"'
  ${Else}
    StrCpy $R3 " "
  ${EndIf}
  StrCpy $R2 0
  ${Do}
    StrCpy $R4 $R1 1 $R2
    ${If} $R4 == $R3
    ${OrIf} $R4 == ""
      ${ExitDo}
    ${EndIf}
    IntOp $R2 $R2 + 1
  ${Loop}
  StrCpy $R1 $R1 $R2
  ${GetFileName} "$R1" $R2
  ${If} $R2 == "msedge.exe"
  ${OrIf} $R2 == "chrome.exe"
    !insertmacro _BrowserConsider "$R1" chromium 99
  ${ElseIf} $R2 == "brave.exe"
  ${OrIf} $R2 == "vivaldi.exe"
    !insertmacro _BrowserConsider "$R1" chromium 0
  ${ElseIf} $R2 == "firefox.exe"
    !insertmacro _BrowserConsider "$R1" firefox 104
  ${EndIf}
FunctionEnd

Function FindBrowser
  StrCpy $Browser ""
  StrCpy $BrowserKind ""
  StrCpy $BrowserCurrent ""
  Call _BrowserDefault
  ${If} ${RunningX64}
    SetRegView 64
    Call _BrowserAppPaths
    SetRegView 32
  ${EndIf}
  Call _BrowserAppPaths
  ; Usual folders, for installs without an App Paths entry ($PROGRAMFILES64 is the 32-bit folder on 32-bit Windows).
  !insertmacro _BrowserConsider "$PROGRAMFILES32\Microsoft\Edge\Application\msedge.exe" chromium 99
  !insertmacro _BrowserConsider "$PROGRAMFILES64\Microsoft\Edge\Application\msedge.exe" chromium 99
  !insertmacro _BrowserConsider "$LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe" chromium 99
  !insertmacro _BrowserConsider "$PROGRAMFILES64\Google\Chrome\Application\chrome.exe" chromium 99
  !insertmacro _BrowserConsider "$PROGRAMFILES32\Google\Chrome\Application\chrome.exe" chromium 99
  !insertmacro _BrowserConsider "$LOCALAPPDATA\Google\Chrome\Application\chrome.exe" chromium 99
  !insertmacro _BrowserConsider "$PROGRAMFILES64\BraveSoftware\Brave-Browser\Application\brave.exe" chromium 0
  !insertmacro _BrowserConsider "$LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe" chromium 0
  !insertmacro _BrowserConsider "$LOCALAPPDATA\Vivaldi\Application\vivaldi.exe" chromium 0
  !insertmacro _BrowserConsider "$LOCALAPPDATA\Chromium\Application\chrome.exe" chromium 99
  !insertmacro _BrowserConsider "$PROGRAMFILES64\Mozilla Firefox\firefox.exe" firefox 104
  !insertmacro _BrowserConsider "$PROGRAMFILES32\Mozilla Firefox\firefox.exe" firefox 104
  !insertmacro _BrowserConsider "$LOCALAPPDATA\Mozilla Firefox\firefox.exe" firefox 104
FunctionEnd
