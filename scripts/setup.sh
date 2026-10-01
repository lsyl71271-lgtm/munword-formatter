#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

if ! command -v python3 >/dev/null 2>&1; then
  echo "未找到 Python 3。请先从 python.org 安装 Python 3，再重新运行。"
  exit 1
fi

"$PROJECT_DIR/scripts/install-service.sh"
echo "安装完成。系统已设为登录后自动启动：http://127.0.0.1:8000"
/usr/bin/open http://127.0.0.1:8000
