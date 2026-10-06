#!/bin/bash
# PKUNMUN 2026 文件排版系统 — macOS offline launcher (Contents/Resources/launcher.sh, started by the
# native Contents/MacOS/PKUNMUN2026, see launcher-stub.c).
# Opens the page bundled at Contents/Resources/site/index.html straight from disk. Nothing is
# installed, no server is started, and the page's Content-Security-Policy forbids every network
# connection. A Chromium browser (Chrome, Edge, Brave, Vivaldi, Chromium) shows it as its own app
# window; otherwise Safari opens it, or Firefox when Safari is too old for the page (before 15.4,
# i.e. macOS 10.14 and earlier). Written for the bash 3.2 that ships with macOS (and runs under zsh).
# Test hooks (unset in normal use): MUNWORD_OPEN, MUNWORD_DEFAULTS, MUNWORD_APPLICATIONS, MUNWORD_ALERT.
set -u

OPEN="${MUNWORD_OPEN:-/usr/bin/open}"
DEFAULTS="${MUNWORD_DEFAULTS:-/usr/bin/defaults}"
APPLICATIONS="${MUNWORD_APPLICATIONS:-/Applications}"
CONTENTS="$(cd "$(dirname "$0")/.." && pwd)"
PAGE="$CONTENTS/Resources/site/index.html"

alert() {
  if [[ -n "${MUNWORD_ALERT:-}" ]]; then
    printf '%s\n' "$1" >> "$MUNWORD_ALERT"
    return
  fi
  /usr/bin/osascript -e "display alert \"PKUNMUN 2026 文件排版系统\" message \"$1\" as critical buttons {\"好\"} default button \"好\"" >/dev/null 2>&1
}

# file:// URL for a path with spaces or Chinese characters: percent-encode every byte that is
# not unreserved (od works byte by byte, independent of the user's locale).
url_encode_path() {
  local out="" byte
  for byte in $(printf '%s' "$1" | /usr/bin/od -An -v -tx1); do
    case "$byte" in
      2[def]|3[0-9]|4[1-9a-f]|5[0-9a]|6[1-9a-f]|7[0-9a]|5f|7e) out="$out$(printf "\\x$byte")" ;;
      *) out="$out%$(printf '%s' "$byte" | /usr/bin/tr 'a-f' 'A-F')" ;;
    esac
  done
  printf '%s' "$out"
}

# Safari 15.4 is the oldest Safari that runs the page. An unreadable version counts as current: the
# page itself explains what to update if it is not.
safari_is_current() {
  local version major minor
  version="$("$DEFAULTS" read "$APPLICATIONS/Safari.app/Contents/Info" CFBundleShortVersionString 2>/dev/null)" || return 0
  major="${version%%.*}"
  minor="${version#"$major"}"
  minor="${minor#.}"
  minor="${minor%%.*}"
  case "$major" in ''|*[!0-9]*) return 0 ;; esac
  case "$minor" in ''|*[!0-9]*) minor=0 ;; esac
  [[ "$major" -gt 15 || ( "$major" -eq 15 && "$minor" -ge 4 ) ]]
}

if [[ ! -f "$PAGE" ]]; then
  alert "程序文件不完整，请重新下载并安装。"
  exit 1
fi
URL="file://$(url_encode_path "$PAGE")"

for browser in "Google Chrome" "Microsoft Edge" "Brave Browser" "Vivaldi" "Chromium"; do
  for dir in "$APPLICATIONS" "$HOME/Applications"; do
    if [[ -d "$dir/$browser.app" ]] && "$OPEN" -na "$dir/$browser.app" --args --app="$URL"; then
      exit 0
    fi
  done
done
old_safari=""
if safari_is_current; then
  "$OPEN" -a Safari "$PAGE" && exit 0
else
  old_safari=1
fi
for dir in "$APPLICATIONS" "$HOME/Applications"; do
  if [[ -d "$dir/Firefox.app" ]] && "$OPEN" -a "$dir/Firefox.app" "$PAGE"; then
    exit 0
  fi
done
# An old Safari still opens the page, which then names the browsers to install; last, the default app.
if [[ -n "$old_safari" ]] && "$OPEN" -a Safari "$PAGE"; then
  exit 0
fi
if ! "$OPEN" "$PAGE"; then
  alert "没有找到可用的浏览器。请安装或更新 Safari、Chrome、Edge 或 Firefox 后重试。"
  exit 1
fi
