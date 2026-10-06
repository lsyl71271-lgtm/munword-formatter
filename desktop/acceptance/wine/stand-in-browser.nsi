; Stand-in browser for the Wine scenarios: records how it was started (C:\browser-args.txt), then exits.
;   makensis -DOUT=chrome.exe -DVER=109.0.5414.120 stand-in-browser.nsi
Unicode true
SilentInstall silent
RequestExecutionLevel user
OutFile "${OUT}"
VIProductVersion "${VER}"
VIAddVersionKey /LANG=1033 "FileVersion" "${VER}"
VIAddVersionKey /LANG=1033 "ProductName" "stand-in browser"
VIAddVersionKey /LANG=1033 "FileDescription" "stand-in browser"
Section
  FileOpen $0 "C:\browser-args.txt" a
  FileSeek $0 0 END
  FileWriteUTF16LE $0 "$EXEPATH|$CMDLINE$\r$\n"
  FileClose $0
SectionEnd
