#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! /usr/bin/osascript -e 'display dialog "将把 PKUNMUN 2026 文件排版系统安装到当前用户，并设置为登录后自动启动。DOCX 只在本机处理。" buttons {"取消", "开始安装"} default button "开始安装" cancel button "取消" with title "PKUNMUN 2026"' >/dev/null; then
  exit 0
fi

if "$PROJECT_DIR/scripts/setup.sh"; then
  /usr/bin/osascript -e 'display notification "安装完成，排版系统已打开。" with title "PKUNMUN 2026"'
else
  /usr/bin/osascript -e 'display alert "安装未完成" message "请确认已安装 Python 3，并保持网络连接后重试。" as critical'
  exit 1
fi
