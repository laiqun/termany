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

# Self-update artifacts (Termany.app.tar.gz + .sig) are signed with the Tauri
# updater key — separate from Apple signing. Falls back to the local key file
# generated with `tauri signer generate` (no password).
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  UPDATER_KEY="$HOME/.tauri/termany-updater.key"
  [ -f "$UPDATER_KEY" ] || { echo "missing TAURI_SIGNING_PRIVATE_KEY (or $UPDATER_KEY)" >&2; exit 1; }
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$UPDATER_KEY")"
  export TAURI_SIGNING_PRIVATE_KEY
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

RES="apps/desktop/src-tauri/resources/server"
ENT="apps/desktop/src-tauri/entitlements.plist"

# A stale mounted Termany volume (from a previous install/test) makes Tauri's
# bundle_dmg.sh fail — detach any before building.
for v in /Volumes/Termany*; do
  [ -d "$v" ] && hdiutil detach "$v" -force -quiet && echo "==> detached stale volume $v"
done

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
# tauri.macos.conf.json is auto-merged on macOS, so no --config is needed.
npm -w @termany/desktop run tauri -- build \
  --target aarch64-apple-darwin

DMG=$(ls apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg)

echo "==> [5/5] Notarize + staple the DMG itself (so it opens clean too)"
xcrun notarytool submit "$DMG" \
  --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
xcrun stapler staple "$DMG"

# Give the updater artifacts the versioned Termany_<ver>_<arch> names that
# `gh release create` uploads and the site's publish-release.sh recognizes.
VERSION=$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")
MACOS_BUNDLE="apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos"
UPDATER_TGZ="$MACOS_BUNDLE/Termany_${VERSION}_aarch64.app.tar.gz"
cp "$MACOS_BUNDLE/Termany.app.tar.gz" "$UPDATER_TGZ"
cp "$MACOS_BUNDLE/Termany.app.tar.gz.sig" "$UPDATER_TGZ.sig"

echo
echo "==> Done. Distributable DMG (signed + notarized + stapled):"
ls -lh "$DMG"
echo "==> Self-update artifacts (publish BOTH alongside the DMG):"
ls -lh "$UPDATER_TGZ" "$UPDATER_TGZ.sig"
