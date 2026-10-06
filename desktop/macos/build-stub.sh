#!/bin/sh
# Rebuild desktop/macos/launcher-stub, the universal (arm64 + x86_64) entry point of the macOS app.
#   macOS: Xcode command line tools (clang).
#   Linux: zig (python3 -m pip install ziglang, then ZIG="python3 -m ziglang") and llvm-lipo (apt llvm).
# x86_64 runs on macOS 10.11 and later, arm64 on every Apple silicon Mac (macOS 11 and later).
set -eu
cd "$(dirname "$0")"
work="$(mktemp -d)"
# Header room for the code signature added when the app is signed (ld64 reserves it by default, zig does not).
pad="-Wl,-headerpad,0x1000"
trap 'rm -rf "$work"' EXIT
if [ "$(uname -s)" = Darwin ]; then
  clang -Os $pad -arch x86_64 -mmacosx-version-min=10.11 -o "$work/x86_64" launcher-stub.c
  clang -Os $pad -arch arm64 -mmacosx-version-min=11.0 -o "$work/arm64" launcher-stub.c
  lipo -create "$work/x86_64" "$work/arm64" -output launcher-stub
else
  ${ZIG:-zig} cc -Os $pad -target x86_64-macos.10.11 -o "$work/x86_64" launcher-stub.c
  ${ZIG:-zig} cc -Os $pad -target aarch64-macos.11.0 -o "$work/arm64" launcher-stub.c
  ${LIPO:-llvm-lipo} -create "$work/x86_64" "$work/arm64" -output launcher-stub
fi
chmod 755 launcher-stub
echo "built launcher-stub ($(wc -c < launcher-stub) bytes)"
