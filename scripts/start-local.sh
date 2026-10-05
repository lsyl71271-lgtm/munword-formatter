#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT="$HOME/Library/Application Support/PKUNMUN2026Formatter"
PYTHON_BIN="$INSTALL_ROOT/venv/bin/python"
SERVER_SCRIPT="$INSTALL_ROOT/backend/run.py"

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "缺少 Python 环境。请先运行 scripts/setup.sh"
  exit 1
fi

is_ours() {
  curl -fsS --max-time 1 http://127.0.0.1:8000/api/health 2>/dev/null |
    "$PYTHON_BIN" -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("service") == "pkunmun-2026-formatter" else 1)' 2>/dev/null
}

if is_ours; then
  echo "PKUNMUN 2026 排版系统已在运行：http://127.0.0.1:8000"
  open http://127.0.0.1:8000
  exit 0
fi

cleanup() {
  kill "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd "$INSTALL_ROOT/backend"
"$PYTHON_BIN" "$SERVER_SCRIPT" &
BACKEND_PID=$!

for _ in {1..60}; do
  if is_ours; then
    echo "PKUNMUN 2026 排版系统已启动：http://127.0.0.1:8000"
    open http://127.0.0.1:8000
    wait "$BACKEND_PID"
    exit $?
  fi
  sleep 0.15
done

echo "本机服务启动失败。"
exit 1
