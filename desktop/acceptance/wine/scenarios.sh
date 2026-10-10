#!/bin/bash
# Windows installer and launcher scenarios in Wine: 32-bit Windows 7 and 64-bit Windows 10 prefixes.
#   desktop/acceptance/wine/scenarios.sh <work dir> <win7|win10> [setup.exe]
# Stand-in browsers (stand-in-browser.nsi) record how the launcher starts them, so the browser choice is
# checked for: no browser (default .html handler), Edge, Chrome via App Paths, too-old Chrome with
# Firefox, the default browser (Firefox, per-user Chrome, an unknown one), per-user Brave and Vivaldi, a
# too-old Firefox. Also silent install, shortcuts, the uninstall entry, a folder with spaces, Chinese, "#"
# and "%", and silent uninstall. Needs wine (with wine32 for the 32-bit prefix), makensis and iconv.
set -u
# Wine's shell (ShellExecute, the default .html handler) needs a display; use a virtual one if none.
if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null; then exec xvfb-run -a "$0" "$@"; fi
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WORK="$1"; FLAVOR="$2"; SETUP="${3:-$ROOT/downloads/PKUNMUN2026-Formatter-Windows-Setup.exe}"
WINE="${WINE:-$(command -v wine || echo /usr/lib/wine/wine)}"
WINESERVER="${WINESERVER:-$(command -v wineserver || echo /usr/lib/wine/wineserver)}"
export LC_ALL=C.UTF-8 WINEDEBUG=-all WINEDLLOVERRIDES="mscoree,mshtml="
export WINEPREFIX="$WORK/prefix-$FLAVOR"
if [ ! -d "$WINEPREFIX" ]; then
  if [ "$FLAVOR" = win7 ]; then WINEARCH=win32 "$WINE" wineboot -i >/dev/null 2>&1; "$WINE" winecfg -v win7 >/dev/null 2>&1
  else WINEARCH=win64 "$WINE" wineboot -i >/dev/null 2>&1; "$WINE" winecfg -v win10 >/dev/null 2>&1; fi
  "$WINESERVER" -w
fi
FAKE="$WORK/stand-ins"
if [ ! -f "$FAKE/default.exe" ]; then
  mkdir -p "$FAKE"
  for spec in msedge:120.0.2210.91 chrome:109.0.5414.120 chrome-old:80.0.3987.163 firefox:115.6.0.8778 firefox-old:91.0.0.0 brave:131.1.73.89 vivaldi:6.5.3206.48 default:1.0.0.0; do
    (cd "$HERE" && makensis -V1 -DOUT="$FAKE/${spec%%:*}.exe" -DVER="${spec#*:}" stand-in-browser.nsi) >/dev/null
  done
fi
W() { "$WINE" "$@" 2>/dev/null; }
wait_wine() { "$WINESERVER" -w; }
C=$WINEPREFIX/drive_c
WUSER="$(id -un)"   # Wine names the Windows profile after the Unix user
U=$C/users/$WUSER
INST="$U/AppData/Local/Programs/PKUNMUN2026Formatter"
PF64="$C/Program Files"; PF32="$C/Program Files"; [ -d "$C/Program Files (x86)" ] && PF32="$C/Program Files (x86)"
LOG=$C/browser-args.txt
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS $1"; pass=$((pass+1)); else echo "  FAIL $1"; echo "       want: $3"; echo "       got:  $2"; fail=$((fail+1)); fi; }
contains() { case "$2" in *"$3"*) echo "  PASS $1"; pass=$((pass+1));; *) echo "  FAIL $1"; echo "       want substring: $3"; echo "       got: $2"; fail=$((fail+1));; esac; }

reset_browsers() {
  rm -rf "$PF32/Microsoft/Edge" "$PF64/Microsoft/Edge" "$PF64/Google" "$PF32/Google" "$PF64/Mozilla Firefox" "$PF32/Mozilla Firefox" \
    "$U/AppData/Local/Google" "$U/AppData/Local/Microsoft/Edge" "$U/AppData/Local/BraveSoftware" "$U/AppData/Local/Vivaldi" "$C/fake"
  for view in 32 64; do
    for exe in msedge.exe chrome.exe brave.exe vivaldi.exe firefox.exe; do
      W reg delete "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$exe" /f /reg:$view >/dev/null
      W reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$exe" /f /reg:$view >/dev/null
    done
  done
  W reg delete "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /f >/dev/null
  rm -f "$LOG"
  # Default handler for .html pages: a stand-in, so "open with the default browser" is observable
  # (Wine's HKCR shows only machine-wide classes).
  mkdir -p "$C/fake"; cp "$FAKE/default.exe" "$C/fake/default.exe"
  W reg add "HKLM\\Software\\Classes\\.html" /ve /d htmlfile /f >/dev/null
  W reg add "HKLM\\Software\\Classes\\htmlfile\\shell\\open\\command" /ve /d '"C:\fake\default.exe" "%1"' /f >/dev/null
}
put() { mkdir -p "$(dirname "$2")"; cp "$FAKE/$1" "$2"; }
launch() { rm -f "$LOG"; W "$INST/PKUNMUN2026Formatter.exe"; wait_wine; sleep 0.5; [ -f "$LOG" ] && iconv -f UTF-16LE -t UTF-8 "$LOG" | tr -d '\r' | sed 's/^\xEF\xBB\xBF//' | head -1 || echo "(nothing started)"; }
URL="file:///C:/users/$WUSER/AppData/Local/Programs/PKUNMUN2026Formatter/site/index.html"
APPFLAGS="--app=\"$URL\" --no-first-run --no-default-browser-check"

echo "== [$FLAVOR] $(W cmd /c ver | tr -d '\r' | grep -v '^$')"
echo "-- silent install"
W "$SETUP" /S; wait_wine
for f in site/index.html site/app.js site/version.json PKUNMUN2026Formatter.exe uninstall.exe app.ico 使用说明.txt; do [ -f "$INST/$f" ] && check "installed $f" ok ok || check "installed $f" missing ok; done
check "desktop shortcut" "$(ls "$U/Desktop/" | grep -c 'PKUNMUN 2026 文件排版系统.lnk')" 1
check "start menu shortcut" "$(ls "$U/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/" | grep -c 'PKUNMUN 2026 文件排版系统.lnk')" 1
W reg export "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PKUNMUN2026Formatter" 'C:\uninstall-key.reg' /y >/dev/null
REG=$(iconv -f UTF-16LE -t UTF-8 "$C/uninstall-key.reg" | tr -d '\r'); rm -f "$C/uninstall-key.reg"
contains "uninstall entry name" "$REG" '"DisplayName"="PKUNMUN 2026 文件排版系统"'
contains "uninstall entry version" "$REG" "\"DisplayVersion\"=\"$(cat "$ROOT/VERSION")\""
check "no machine-wide uninstall entry" "$(W reg query "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PKUNMUN2026Formatter" >/dev/null && echo present || echo absent)" absent
check "site version" "$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$INST/site/version.json")" "$(cat "$ROOT/VERSION")"

echo "-- browser scenarios"
reset_browsers
check "S1 no browser: default .html handler gets the page" "$(launch)" "C:\\fake\\default.exe|\"C:\\fake\\default.exe\" \"C:\\users\\$WUSER\\AppData\\Local\\Programs\\PKUNMUN2026Formatter\\site\\index.html\""

reset_browsers; put msedge.exe "$PF32/Microsoft/Edge/Application/msedge.exe"
check "S2 Edge (default folder): app window + first-run flags" "$(launch)" "C:\\Program Files$( [ "$PF32" != "$PF64" ] && echo ' (x86)')\\Microsoft\\Edge\\Application\\msedge.exe|\"C:\\Program Files$( [ "$PF32" != "$PF64" ] && echo ' (x86)')\\Microsoft\\Edge\\Application\\msedge.exe\" $APPFLAGS"

reset_browsers; put chrome.exe "$PF64/Google/Chrome/Application/chrome.exe"
W reg add "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve /d '"C:\Program Files\Google\Chrome\Application\chrome.exe"' /f /reg:64 >/dev/null
check "S3 Chrome 109 via App Paths (native registry view, quoted)" "$(launch)" "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe|\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\" $APPFLAGS"

reset_browsers; put chrome-old.exe "$PF64/Google/Chrome/Application/chrome.exe"; put firefox.exe "$PF64/Mozilla Firefox/firefox.exe"
check "S4 Chrome 80 (too old) + Firefox 115: Firefox" "$(launch)" "C:\\Program Files\\Mozilla Firefox\\firefox.exe|\"C:\\Program Files\\Mozilla Firefox\\firefox.exe\" -new-window \"$URL\""

reset_browsers; put chrome-old.exe "$PF64/Google/Chrome/Application/chrome.exe"
check "S5 only Chrome 80: still used (page then explains)" "$(launch)" "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe|\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\" $APPFLAGS"

reset_browsers; put msedge.exe "$PF32/Microsoft/Edge/Application/msedge.exe"; put firefox.exe "$PF64/Mozilla Firefox/firefox.exe"
W reg add "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId /d FirefoxURL-308046B0AF4A39CB /f >/dev/null
W reg add "HKCU\\Software\\Classes\\FirefoxURL-308046B0AF4A39CB\\shell\\open\\command" /ve /d '"C:\Program Files\Mozilla Firefox\firefox.exe" -osint -url "%1"' /f >/dev/null
check "S6 default browser Firefox wins over Edge" "$(launch)" "C:\\Program Files\\Mozilla Firefox\\firefox.exe|\"C:\\Program Files\\Mozilla Firefox\\firefox.exe\" -new-window \"$URL\""

reset_browsers; put msedge.exe "$PF32/Microsoft/Edge/Application/msedge.exe"; put chrome.exe "$U/AppData/Local/Google/Chrome/Application/chrome.exe"
W reg add "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId /d ChromeHTML /f >/dev/null
W reg add "HKCU\\Software\\Classes\\ChromeHTML\\shell\\open\\command" /ve /d "\"C:\\users\\$WUSER\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe\" --single-argument %1" /f >/dev/null
check "S7 default browser per-user Chrome wins over Edge" "$(launch)" "C:\\users\\$WUSER\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe|\"C:\\users\\$WUSER\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe\" $APPFLAGS"

reset_browsers; put msedge.exe "$PF32/Microsoft/Edge/Application/msedge.exe"
W reg add "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId /d 360seURL /f >/dev/null
W reg add "HKCU\\Software\\Classes\\360seURL\\shell\\open\\command" /ve /d 'C:\fake\default.exe -- "%1"' /f >/dev/null
contains "S8 unknown default browser: Edge app window instead" "$(launch)" "msedge.exe\" $APPFLAGS"

reset_browsers; put brave.exe "$U/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe"
contains "S9 Brave (per-user install only)" "$(launch)" "BraveSoftware\\Brave-Browser\\Application\\brave.exe\" $APPFLAGS"

reset_browsers; put vivaldi.exe "$U/AppData/Local/Vivaldi/Application/vivaldi.exe"
contains "S10 Vivaldi (per-user install only)" "$(launch)" "Vivaldi\\Application\\vivaldi.exe\" $APPFLAGS"

reset_browsers; put firefox-old.exe "$PF64/Mozilla Firefox/firefox.exe"; put msedge.exe "$U/AppData/Local/Microsoft/Edge/Application/msedge.exe"
contains "S11 Firefox 91 (too old) + per-user Edge: Edge" "$(launch)" "Microsoft\\Edge\\Application\\msedge.exe\" $APPFLAGS"

reset_browsers
echo "-- silent uninstall"
W "$INST/uninstall.exe" /S; wait_wine; sleep 2; wait_wine
check "install folder removed" "$([ -e "$INST" ] && echo present || echo absent)" absent
check "desktop shortcut removed" "$(ls "$U/Desktop/" | grep -c 'PKUNMUN.*\.lnk')" 0
check "start menu shortcut removed" "$(ls "$U/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/" | grep -c 'PKUNMUN.*\.lnk')" 0
check "uninstall entry removed" "$(W reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PKUNMUN2026Formatter" >/dev/null && echo present || echo absent)" absent

echo "-- custom folder with space, Chinese, # and %"
W cmd /c "Z:$(echo "$SETUP" | tr / '\\\\') /S /D=C:\\测试 目录#1%\\App"; wait_wine
CUSTOM="$C/测试 目录#1%/App"
check "installed into custom folder" "$([ -f "$CUSTOM/site/index.html" ] && echo ok)" ok
reset_browsers; put msedge.exe "$PF32/Microsoft/Edge/Application/msedge.exe"
rm -f "$LOG"; W "$CUSTOM/PKUNMUN2026Formatter.exe"; wait_wine; sleep 0.5
GOT=$(iconv -f UTF-16LE -t UTF-8 "$LOG" | tr -d '\r' | sed 's/^\xEF\xBB\xBF//' | head -1)
contains "URL escapes space, # and %, keeps Chinese" "$GOT" '--app="file:///C:/测试%20目录%231%25/App/site/index.html"'
W "$CUSTOM/uninstall.exe" /S; wait_wine; sleep 2; wait_wine
check "custom folder uninstalled" "$([ -e "$CUSTOM" ] && echo present || echo absent)" absent
reset_browsers
echo "== [$FLAVOR] passed $pass, failed $fail"
[ "$fail" -eq 0 ]
