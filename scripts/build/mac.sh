#!/usr/bin/env bash
# macOS installer builder (v8.1 — real .app bundle + drag-and-drop .dmg).
#
# Before v8.1 the dmg held a plain folder of source code: the user dragged it
# somewhere themselves, then double-clicked a .command that ran npm install and
# a Terminal wizard — and none of that worked without Node already installed.
# There was no drag-to-Applications window because there was no .app.
#
# Now it produces a self-contained bundle that installs like any Mac app:
#
#   AMM.app/Contents/MacOS/AMM               universal Go binary (arm64 + x86_64)
#   AMM.app/Contents/Resources/app/          JS payload with node_modules preinstalled
#   AMM.app/Contents/Resources/node/bin/node universal Node runtime
#   AMM.app/Contents/Resources/AMM.icns      the green $ mark
#
# Nothing is required on the user's Mac — no Node, no npm, no Terminal. That's
# the same guarantee the Windows installer already made by shipping node.exe.
#
# Usage:  bash scripts/build/mac.sh
# Env:    AMM_VERSION (default: package.json), AMM_OUT (default: dist),
#         AMM_NODE_VERSION (default: 22.14.0 — Node LTS),
#         APPLE_SIGN_IDENTITY (optional Developer ID)

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
VERSION="${AMM_VERSION:-$(node -p "require('$ROOT/package.json').version")}"
OUT="${AMM_OUT:-$ROOT/dist}"
NODE_VERSION="${AMM_NODE_VERSION:-22.14.0}"
DMG_NAME="amm-v$VERSION.dmg"
STAGE="$OUT/.stage-mac"
APP="$STAGE/AMM.app"
RES="$APP/Contents/Resources"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "❌ This script must run on macOS (uname=$(uname -s))" >&2
  exit 1
fi

rm -rf "$STAGE"
mkdir -p "$OUT" "$APP/Contents/MacOS" "$RES/app"

# ---------------------------------------------------------------- Go binary
echo "→ Building wrapper (arm64 + amd64)…"
(cd "$ROOT/wrapper" && make build-mac)

echo "→ Merging into a universal binary…"
lipo -create \
  "$ROOT/wrapper/dist/AMM-darwin-arm64" \
  "$ROOT/wrapper/dist/AMM-darwin-amd64" \
  -output "$APP/Contents/MacOS/AMM"
chmod +x "$APP/Contents/MacOS/AMM"

# ------------------------------------------------------------ Node runtime
# Both slices are downloaded and lipo'd so one bundle runs natively on Apple
# Silicon and Intel. Without this the app would need Rosetta on one of them.
echo "→ Fetching Node $NODE_VERSION (arm64 + x64)…"
NODE_TMP="$STAGE/.node"
mkdir -p "$NODE_TMP"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$NODE_TMP/SHASUMS256.txt"
for arch in arm64 x64; do
  tarball="node-v$NODE_VERSION-darwin-$arch.tar.gz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$tarball" -o "$NODE_TMP/$tarball"
  # Verify against the release's published checksums before unpacking.
  ( cd "$NODE_TMP" && grep " $tarball\$" SHASUMS256.txt | shasum -a 256 -c - )
  mkdir -p "$NODE_TMP/$arch"
  tar -xzf "$NODE_TMP/$tarball" -C "$NODE_TMP/$arch" --strip-components=1
done

mkdir -p "$RES/node/bin"
lipo -create "$NODE_TMP/arm64/bin/node" "$NODE_TMP/x64/bin/node" -output "$RES/node/bin/node"
chmod +x "$RES/node/bin/node"
echo "  node: $("$RES/node/bin/node" -v) (universal)"

# ------------------------------------------------------------- JS payload
echo "→ Staging JS payload…"
rsync -a \
  --exclude '.git/' --exclude 'node_modules/' --exclude 'data/' \
  --exclude '/dist/' --exclude '.env' --exclude 'config.json' \
  --exclude 'cv.*' --exclude '.planning/' --exclude '.claude/' \
  --exclude 'dev/' --exclude '.github/' \
  "$ROOT/" "$RES/app/"

# Production dependencies only, installed at BUILD time so the user's Mac
# never needs npm. --ignore-scripts keeps postinstall hooks (e.g. Playwright's
# browser fetch) from firing here; Chromium is resolved at runtime by
# scripts/browser-launcher.mjs, which prefers an already-installed Chrome.
echo "→ Installing production dependencies into the bundle…"
( cd "$RES/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error )

# Chromium ships inside the bundle so AMM works on a Mac that only has Safari.
# browser-launcher.mjs still prefers an installed Chrome/Edge at runtime and
# points Playwright here (PLAYWRIGHT_BROWSERS_PATH) only as the fallback.
echo "→ Bundling Chromium…"
( cd "$RES/app" && PLAYWRIGHT_BROWSERS_PATH="$RES/ms-playwright" npx playwright install chromium )
echo "  chromium: $(du -sh "$RES/ms-playwright" | cut -f1)"

# ------------------------------------------------------------------- icon
echo "→ Building AMM.icns…"
ICONSET="$STAGE/AMM.iconset"
mkdir -p "$ICONSET"
for sz in 16 32 64 128 256 512; do
  sips -z $sz $sz "$ROOT/wrapper/logo.png" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null
  sips -z $((sz*2)) $((sz*2)) "$ROOT/wrapper/logo.png" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES/AMM.icns"

# -------------------------------------------------------------- Info.plist
# LSUIElement=1 makes AMM a menu-bar app: it lives in the status bar with no
# Dock icon, which is what the tray wrapper expects.
echo "→ Writing Info.plist…"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>AMM</string>
  <key>CFBundleDisplayName</key><string>Automatic Munyun Machine</string>
  <key>CFBundleIdentifier</key><string>com.munyun.amm</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>AMM</string>
  <key>CFBundleIconFile</key><string>AMM</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# ------------------------------------------------------------------ signing
# A Developer ID makes the app open on a double-click. Without one we still
# ad-hoc sign, which keeps the bundle internally consistent (required for
# universal binaries on Apple Silicon) — Gatekeeper then asks for one
# right-click → Open the first time.
if [[ -n "${APPLE_SIGN_IDENTITY:-}" ]]; then
  echo "→ Signing with $APPLE_SIGN_IDENTITY…"
  codesign --force --deep --options runtime --timestamp \
    --sign "$APPLE_SIGN_IDENTITY" "$APP"
else
  echo "→ No APPLE_SIGN_IDENTITY — ad-hoc signing (users need right-click → Open once)"
  codesign --force --deep --sign - "$APP"
fi
codesign --verify --deep --strict "$APP" && echo "  signature verified"

# --------------------------------------------------------------------- dmg
# The /Applications symlink plus a saved window layout is what produces the
# familiar "drag the app onto the folder" install window.
echo "→ Building drag-and-drop DMG…"
DMGSRC="$STAGE/dmg"
mkdir -p "$DMGSRC"
cp -R "$APP" "$DMGSRC/"
ln -s /Applications "$DMGSRC/Applications"

RW="$STAGE/rw.dmg"
hdiutil create -volname "Automatic Munyun Machine" -srcfolder "$DMGSRC" \
  -ov -format UDRW "$RW" >/dev/null
MOUNT=$(hdiutil attach -readwrite -noverify -noautoopen "$RW" | grep -Eo '/Volumes/.*$' | head -1)

osascript <<'APPLESCRIPT' || echo "  (window layout skipped — cosmetic only)"
tell application "Finder"
  tell disk "Automatic Munyun Machine"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 120, 900, 520}
    set theViewOptions to the icon view options of container window
    set arrangement of theViewOptions to not arranged
    set icon size of theViewOptions to 128
    set position of item "AMM.app" of container window to {180, 200}
    set position of item "Applications" of container window to {520, 200}
    close
    open
    update without registering applications
    delay 2
  end tell
end tell
APPLESCRIPT

# Finder and diskimages-helper can briefly retain the mounted volume after the
# layout AppleScript exits. Give normal detach several chances before falling
# back to a forced detach; otherwise an otherwise-valid release fails randomly
# with hdiutil exit code 16 (Resource busy).
detached=false
for attempt in 1 2 3 4 5; do
  if hdiutil detach "$MOUNT" >/dev/null 2>&1; then
    detached=true
    break
  fi
  echo "  DMG volume is busy; retrying detach ($attempt/5)…"
  sync
  sleep $((attempt * 2))
done
if [[ "$detached" != true ]]; then
  echo "  Normal detach remained busy; forcing detach…"
  hdiutil detach -force "$MOUNT" >/dev/null
fi
hdiutil convert "$RW" -format UDZO -o "$OUT/$DMG_NAME" -ov >/dev/null
rm -f "$RW"

echo "✓ Built: $OUT/$DMG_NAME ($(du -h "$OUT/$DMG_NAME" | cut -f1))"
