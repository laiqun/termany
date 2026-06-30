#!/bin/bash
# Build a distributable, signed + notarized macOS arm64 DMG locally.
#
# Requires these in the environment (already set on the maintainer's machine):
#   APPLE_SIGNING_IDENTITY  e.g. "Developer ID Application: Name (TEAMID)"
#   APPLE_ID, APPLE_PASSWORD (app-specific password), APPLE_TEAM_ID
# and the matching Developer ID Application cert in the login keychain.
#
# Output: apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg
set -euo pipefail
cd "$(dirname "$0")/.."

: "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY}"
: "${APPLE_ID:?set APPLE_ID}"
: "${APPLE_PASSWORD:?set APPLE_PASSWORD}"
: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID}"

RES="apps/desktop/src-tauri/resources/server"
ENT="apps/desktop/src-tauri/entitlements.plist"

echo "==> [1/4] Build web frontend"
npm run build:web

echo "==> [2/4] Bundle the Node server (node + node-pty + server.cjs)"
npm run bundle:server

echo "==> [3/4] Sign the bundled server binaries"
# node needs JIT entitlements under the hardened runtime; the native addons just
# need a hardened-runtime signature.
codesign --force --options runtime --entitlements "$ENT" \
  --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$RES/node"
find "$RES" \( -name "*.node" -o -name "spawn-helper" \) -type f -print0 \
  | while IFS= read -r -d '' f; do
      codesign --force --options runtime --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$f"
    done

echo "==> [4/4] Build, sign & notarize the app (this takes a few minutes)"
npm -w @termany/desktop run tauri -- build \
  --target aarch64-apple-darwin \
  --config src-tauri/tauri.release.conf.json

DMG=$(ls apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg)

echo "==> [5/5] Notarize + staple the DMG itself (so it opens clean too)"
xcrun notarytool submit "$DMG" \
  --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
xcrun stapler staple "$DMG"

echo
echo "==> Done. Distributable DMG (signed + notarized + stapled):"
ls -lh "$DMG"
