#!/usr/bin/env bash
#
# Install TrayPoc for the current user: copies the AppImage into ~/.local/bin,
# registers a menu entry, and drops a launcher icon on the Desktop.
#
# Usage:
#   packaging/linux/install.sh [/path/to/TrayPoc-x.y.z-x86_64.AppImage]
#
# If no path is given, the newest TrayPoc-*.AppImage next to this script is used.
set -euo pipefail

APP_NAME="TrayPoc"
ID="traypoc"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Locate the AppImage.
APPIMAGE="${1:-}"
if [ -z "$APPIMAGE" ]; then
  APPIMAGE="$(ls -1 "$SCRIPT_DIR"/${APP_NAME}-*.AppImage 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -z "$APPIMAGE" ] || [ ! -f "$APPIMAGE" ]; then
  echo "error: no AppImage found. Usage: $0 /path/to/${APP_NAME}-*.AppImage" >&2
  exit 1
fi
APPIMAGE="$(readlink -f "$APPIMAGE")"

# 2. Target locations (XDG user dirs).
BIN_DIR="$HOME/.local/bin"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
APPS_DIR="$HOME/.local/share/applications"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
mkdir -p "$BIN_DIR" "$ICON_DIR" "$APPS_DIR" "$DESKTOP_DIR"

INSTALLED="$BIN_DIR/${APP_NAME}.AppImage"
echo ">> Installing AppImage -> $INSTALLED"
install -m 0755 "$APPIMAGE" "$INSTALLED"

# 3. Icon: extract from the AppImage (works for a downloaded artifact), with a
#    repo-asset fallback when running from a source checkout.
ICON_PNG="$ICON_DIR/${ID}.png"
TMP="$(mktemp -d)"
if ( cd "$TMP" && "$INSTALLED" --appimage-extract "${ID}.png" >/dev/null 2>&1 ) && [ -f "$TMP/squashfs-root/${ID}.png" ]; then
  cp "$TMP/squashfs-root/${ID}.png" "$ICON_PNG"
elif [ -f "$SCRIPT_DIR/../../apps/desktop/Assets/tray-icon-256.png" ]; then
  cp "$SCRIPT_DIR/../../apps/desktop/Assets/tray-icon-256.png" "$ICON_PNG"
fi
rm -rf "$TMP"
echo ">> Installed icon  -> $ICON_PNG"

# 4. Desktop entry (use the absolute icon path so the Desktop launcher always renders).
make_desktop() {
  cat > "$1" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=${APP_NAME}
GenericName=Avalonia Tray POC
Comment=Avalonia cross-platform system-tray proof of concept
Exec=${INSTALLED}
Icon=${ICON_PNG}
Terminal=false
Categories=Utility;
StartupNotify=true
StartupWMClass=${APP_NAME}
Keywords=avalonia;tray;dotnet;
EOF
}

# Menu entry.
make_desktop "$APPS_DIR/${ID}.desktop"
chmod +x "$APPS_DIR/${ID}.desktop"
update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
echo ">> Menu entry      -> $APPS_DIR/${ID}.desktop"

# Desktop launcher (GNOME/Zorin needs it executable + trusted to show as an icon).
make_desktop "$DESKTOP_DIR/${ID}.desktop"
chmod +x "$DESKTOP_DIR/${ID}.desktop"
gio set "$DESKTOP_DIR/${ID}.desktop" metadata::trusted true >/dev/null 2>&1 || true
echo ">> Desktop icon    -> $DESKTOP_DIR/${ID}.desktop"

echo ">> Done. Launch '${APP_NAME}' from the menu or the desktop icon."
