#!/usr/bin/env bash
#
# Build a Linux AppImage for TrayPoc.
#
# Usage:
#   packaging/linux/build-appimage.sh [version] [rid]
#
# Defaults: version=1.0.0  rid=linux-x64
#
# Works locally and in CI. appimagetool is run with --appimage-extract-and-run
# so no FUSE kernel module is required (handy on CI runners and containers).
set -euo pipefail

VERSION="${1:-1.0.0}"
RID="${2:-linux-x64}"

# Map .NET RID -> AppImage arch string.
case "$RID" in
  linux-x64)   APPIMAGE_ARCH="x86_64" ;;
  linux-arm64) APPIMAGE_ARCH="aarch64" ;;
  *) echo "Unsupported RID: $RID" >&2; exit 1 ;;
esac

# Resolve repo paths relative to this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJECT="$REPO_ROOT/src/TrayPoc/TrayPoc.csproj"
ASSETS="$REPO_ROOT/src/TrayPoc/Assets"

BUILD_DIR="$SCRIPT_DIR/AppDir"
PUBLISH_DIR="$REPO_ROOT/publish/$RID"
DIST_DIR="$REPO_ROOT/dist"
OUTPUT="$DIST_DIR/TrayPoc-${VERSION}-${APPIMAGE_ARCH}.AppImage"

echo ">> Publishing $RID (self-contained)…"
rm -rf "$PUBLISH_DIR"
dotnet publish "$PROJECT" \
  -c Release -r "$RID" --self-contained true \
  -p:Version="$VERSION" \
  -o "$PUBLISH_DIR"

echo ">> Assembling AppDir…"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/usr/bin" \
         "$BUILD_DIR/usr/share/applications" \
         "$BUILD_DIR/usr/share/icons/hicolor/256x256/apps"

cp -r "$PUBLISH_DIR/." "$BUILD_DIR/usr/bin/"

# Desktop entry (top-level copy is required by the AppImage spec).
cp "$SCRIPT_DIR/traypoc.desktop" "$BUILD_DIR/traypoc.desktop"
cp "$SCRIPT_DIR/traypoc.desktop" "$BUILD_DIR/usr/share/applications/traypoc.desktop"

# Icon (top-level + hicolor theme path). Name must match the desktop Icon= key.
cp "$ASSETS/tray-icon-256.png" "$BUILD_DIR/traypoc.png"
cp "$ASSETS/tray-icon-256.png" "$BUILD_DIR/usr/share/icons/hicolor/256x256/apps/traypoc.png"

# AppRun entrypoint.
cp "$SCRIPT_DIR/AppRun" "$BUILD_DIR/AppRun"
chmod +x "$BUILD_DIR/AppRun" "$BUILD_DIR/usr/bin/TrayPoc"

echo ">> Fetching appimagetool…"
TOOL="$SCRIPT_DIR/appimagetool-${APPIMAGE_ARCH}.AppImage"
if [ ! -x "$TOOL" ]; then
  curl -fsSL -o "$TOOL" \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${APPIMAGE_ARCH}.AppImage"
  chmod +x "$TOOL"
fi

echo ">> Building AppImage…"
mkdir -p "$DIST_DIR"
# ARCH env is required by appimagetool; extract-and-run avoids needing FUSE.
ARCH="$APPIMAGE_ARCH" "$TOOL" --appimage-extract-and-run "$BUILD_DIR" "$OUTPUT"

# Ship the installer helpers next to the AppImage so a downloaded artifact can
# create a Desktop icon + menu entry without the source tree.
cp "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/uninstall.sh" "$DIST_DIR/"
chmod +x "$DIST_DIR/install.sh" "$DIST_DIR/uninstall.sh"

echo ">> Done: $OUTPUT"
ls -lh "$OUTPUT" "$DIST_DIR/install.sh"
