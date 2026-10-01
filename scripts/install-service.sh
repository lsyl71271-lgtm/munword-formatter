#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_LABEL="org.pkunmun.formatter.2026.local"
SERVICE_DOMAIN="gui/$(id -u)"
PLIST_TARGET="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
INSTALL_ROOT="$HOME/Library/Application Support/PKUNMUN2026Formatter"
PYTHON_BIN="$INSTALL_ROOT/venv/bin/python"
REQUIREMENTS_STAMP="$INSTALL_ROOT/.requirements.sha256"
CURRENT_REQUIREMENTS_SHA="$(shasum -a 256 "$PROJECT_DIR/backend/requirements.txt" | awk '{print $1}')"

mkdir -p "$HOME/Library/LaunchAgents" "$INSTALL_ROOT"
if [[ ! -x "$PYTHON_BIN" ]]; then
  /usr/bin/python3 -m venv "$INSTALL_ROOT/venv"
fi
if [[ ! -f "$REQUIREMENTS_STAMP" ]] || [[ "$(cat "$REQUIREMENTS_STAMP")" != "$CURRENT_REQUIREMENTS_SHA" ]]; then
  "$PYTHON_BIN" -m pip install --disable-pip-version-check -r "$PROJECT_DIR/backend/requirements.txt"
  printf '%s\n' "$CURRENT_REQUIREMENTS_SHA" > "$REQUIREMENTS_STAMP"
fi

mkdir -p "$INSTALL_ROOT/app" "$INSTALL_ROOT/backend" "$INSTALL_ROOT/local_web" "$INSTALL_ROOT/templates" "$INSTALL_ROOT/public" "$INSTALL_ROOT/shared"
rsync -a --delete "$PROJECT_DIR/app/" "$INSTALL_ROOT/app/"
rsync -a --delete "$PROJECT_DIR/backend/" "$INSTALL_ROOT/backend/"
rsync -a --delete "$PROJECT_DIR/local_web/" "$INSTALL_ROOT/local_web/"
rsync -a --delete "$PROJECT_DIR/templates/" "$INSTALL_ROOT/templates/"
rsync -a --delete "$PROJECT_DIR/public/" "$INSTALL_ROOT/public/"
rsync -a --delete "$PROJECT_DIR/shared/" "$INSTALL_ROOT/shared/"
install -m 0644 "$PROJECT_DIR/VERSION" "$INSTALL_ROOT/.bundle-version"
install -m 0644 "$PROJECT_DIR/VERSION" "$INSTALL_ROOT/VERSION"

launchctl bootout "$SERVICE_DOMAIN/$SERVICE_LABEL" >/dev/null 2>&1 || true
/usr/bin/plutil -create xml1 "$PLIST_TARGET"
/usr/bin/plutil -insert Label -string "$SERVICE_LABEL" "$PLIST_TARGET"
/usr/bin/plutil -insert ProgramArguments -json "[\"$PYTHON_BIN\", \"$INSTALL_ROOT/backend/run.py\"]" "$PLIST_TARGET"
/usr/bin/plutil -insert WorkingDirectory -string "$INSTALL_ROOT/backend" "$PLIST_TARGET"
/usr/bin/plutil -insert RunAtLoad -bool true "$PLIST_TARGET"
/usr/bin/plutil -insert KeepAlive -bool true "$PLIST_TARGET"
/usr/bin/plutil -insert ProcessType -string Background "$PLIST_TARGET"
/usr/bin/plutil -insert ThrottleInterval -integer 5 "$PLIST_TARGET"
/usr/bin/plutil -insert EnvironmentVariables -json '{"PYTHONUNBUFFERED":"1"}' "$PLIST_TARGET"
/usr/bin/plutil -insert StandardOutPath -string "$INSTALL_ROOT/backend.log" "$PLIST_TARGET"
/usr/bin/plutil -insert StandardErrorPath -string "$INSTALL_ROOT/backend.log" "$PLIST_TARGET"
/bin/chmod 0644 "$PLIST_TARGET"
for attempt in {1..20}; do
  if launchctl bootstrap "$SERVICE_DOMAIN" "$PLIST_TARGET" >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" -eq 20 ]]; then
    echo "后台服务载入失败。" >&2
    exit 1
  fi
  sleep 0.25
done
launchctl kickstart -k "$SERVICE_DOMAIN/$SERVICE_LABEL"

echo "已安装并启动：$SERVICE_LABEL"
