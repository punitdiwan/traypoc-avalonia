#!/usr/bin/env bash
#
# Remove a user install created by install.sh.
set -euo pipefail

APP_NAME="TrayPoc"
ID="traypoc"

BIN_DIR="$HOME/.local/bin"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
APPS_DIR="$HOME/.local/share/applications"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"

rm -f "$BIN_DIR/${APP_NAME}.AppImage" \
      "$ICON_DIR/${ID}.png" \
      "$APPS_DIR/${ID}.desktop" \
      "$DESKTOP_DIR/${ID}.desktop"

update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
echo ">> Removed TrayPoc user install."
