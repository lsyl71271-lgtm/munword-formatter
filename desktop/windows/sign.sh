#!/bin/sh
# Authenticode-signs one file in place; makensis calls it through !finalize / !uninstfinalize when
# desktop/build-desktop.mjs runs with MUNWORD_WIN_PFX set. Needs osslsigncode.
#   MUNWORD_WIN_PFX                code-signing certificate and key (PKCS#12)
#   MUNWORD_WIN_PFX_PASSWORD_FILE  file holding its password (never pass secrets on the command line)
#   MUNWORD_WIN_TIMESTAMP_URL      optional RFC 3161 time-stamping server
set -eu
file="$1"
osslsigncode sign -pkcs12 "$MUNWORD_WIN_PFX" -readpass "$MUNWORD_WIN_PFX_PASSWORD_FILE" -h sha256 \
  -n "PKUNMUN 2026 文件排版系统" ${MUNWORD_WIN_TIMESTAMP_URL:+-ts "$MUNWORD_WIN_TIMESTAMP_URL"} \
  -in "$file" -out "$file.signed"
mv "$file.signed" "$file"
