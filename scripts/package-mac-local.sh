#!/bin/bash
# Build an unsigned macOS DMG for local use.
# No Apple Developer certificate or Tauri updater key is required.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> [1/3] Build web frontend"
npm run build:web

echo "==> [2/3] Bundle the Node server"
npm run bundle:server

echo "==> [3/3] Build unsigned DMG"
npm -w @termany/desktop run tauri -- build \
  --bundles dmg \
  --no-sign \
  --config '{"bundle":{"createUpdaterArtifacts":false}}'

echo
echo "==> Done. Local unsigned DMG:"
ls -lh apps/desktop/src-tauri/target/release/bundle/dmg/*.dmg
