#!/usr/bin/env bash
# macOS .dmg builder.
#
# Output: dist/amm-vX.Y.Z.dmg containing a self-extracting source bundle
# + a first-launch AppleScript that runs npm install + playwright install
# + npm run setup. Users drag the AMM folder into ~/Library/Application
# Support/ from the dmg, then double-click the included "Run Setup" app.
#
# Usage:
#   bash scripts/build/mac.sh
#
# Env:
#   AMM_VERSION  override version (default: read from package.json)
#   AMM_OUT      output dir (default: dist)

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
VERSION="${AMM_VERSION:-$(node -p "require('$ROOT/package.json').version")}"
OUT="${AMM_OUT:-$ROOT/dist}"
DMG_NAME="amm-v$VERSION.dmg"
STAGE="$OUT/.stage-mac"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "❌ This script must run on macOS (uname=$(uname -s))" >&2
  exit 1
fi

mkdir -p "$OUT"
rm -rf "$STAGE"
mkdir -p "$STAGE/AMM"

echo "→ Staging source tree…"
# Copy everything except node_modules, data/, .git, dist/. The post-install
# AppleScript will run npm install on first launch.
rsync -a \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'data/' \
  --exclude 'dist/' \
  --exclude '.env' \
  --exclude 'config.json' \
  --exclude 'cv.*' \
  --exclude '.planning/' \
  --exclude '.claude/' \
  "$ROOT/" "$STAGE/AMM/"

echo "→ Writing first-launch installer (.command)…"
cat > "$STAGE/AMM/Run Setup.command" <<'EOF'
#!/usr/bin/env bash
# Double-click target. Shows the user a Terminal window running the wizard.
set -e
cd "$(dirname "$0")"
echo "=== Automatic Munyun Machine — first-launch setup ==="
echo "Installing dependencies…"
npm install --no-audit --no-fund --loglevel=error
echo "Downloading bundled Chromium (~120 MB)…"
npx playwright install chromium
echo ""
echo "Launching the setup wizard. Follow the prompts."
echo ""
exec npm run setup
EOF
chmod +x "$STAGE/AMM/Run Setup.command"

echo "→ Building DMG…"
hdiutil create \
  -volname "Automatic Munyun Machine v$VERSION" \
  -srcfolder "$STAGE/AMM" \
  -ov -format UDZO \
  "$OUT/$DMG_NAME"

echo "✓ Built: $OUT/$DMG_NAME ($(du -h "$OUT/$DMG_NAME" | cut -f1))"
