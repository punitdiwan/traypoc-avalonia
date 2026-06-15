#!/usr/bin/env bash
# Usage: ./deploy/deploy.sh user@your-vps-ip
set -euo pipefail

VPS="${1:?usage: deploy.sh user@vps-ip}"
REMOTE_DIR=/opt/time-tracker-api

echo "==> Building for Linux amd64..."
cd "$(dirname "$0")/.."
GOOS=linux GOARCH=amd64 go build -o bin/server ./cmd/server

echo "==> Copying binary to $VPS:$REMOTE_DIR ..."
ssh "$VPS" "sudo mkdir -p $REMOTE_DIR && sudo chown \$USER:$REMOTE_DIR $REMOTE_DIR" 2>/dev/null || true
scp bin/server "$VPS:/tmp/server"
ssh "$VPS" "sudo mv /tmp/server $REMOTE_DIR/server && sudo chmod +x $REMOTE_DIR/server"

echo "==> Restarting service..."
ssh "$VPS" "sudo systemctl restart time-tracker-api && sudo systemctl status time-tracker-api --no-pager"

echo "==> Done."
