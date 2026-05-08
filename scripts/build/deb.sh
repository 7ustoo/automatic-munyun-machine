#!/usr/bin/env bash
# Linux .deb builder.
#
# Output: dist/amm_X.Y.Z_all.deb installing into /opt/automatic-munyun-machine
# with a postinst hook that prompts the user to run `amm setup` to start
# the wizard.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
VERSION="${AMM_VERSION:-$(node -p "require('$ROOT/package.json').version")}"
OUT="${AMM_OUT:-$ROOT/dist}"
DEB_NAME="amm_${VERSION}_all.deb"
STAGE="$OUT/.stage-deb"

if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "❌ dpkg-deb required (apt install dpkg-dev)" >&2
  exit 1
fi

mkdir -p "$OUT"
rm -rf "$STAGE"
mkdir -p "$STAGE/DEBIAN" "$STAGE/opt/automatic-munyun-machine" "$STAGE/usr/local/bin"

echo "→ Staging source tree under /opt…"
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
  "$ROOT/" "$STAGE/opt/automatic-munyun-machine/"

# /usr/local/bin/amm wrapper — proxies to the install dir.
cat > "$STAGE/usr/local/bin/amm" <<'EOF'
#!/usr/bin/env bash
INSTALL_DIR="/opt/automatic-munyun-machine"
case "${1:-}" in
  setup)   exec node "$INSTALL_DIR/scripts/setup-wizard.mjs" ;;
  daily)   exec node "$INSTALL_DIR/scripts/daily-batch.mjs" ;;
  bot)     exec node "$INSTALL_DIR/scripts/telegram-bot.mjs" ;;
  login)   exec node "$INSTALL_DIR/scripts/login-once.mjs" ;;
  uninstall) exec node "$INSTALL_DIR/scripts/uninstall.mjs" --mode="${2:-pause}" ;;
  *)       echo "Usage: amm {setup|daily|bot|login|uninstall [--mode=pause|wipe]}" ; exit 2 ;;
esac
EOF
chmod 755 "$STAGE/usr/local/bin/amm"

# control file
cat > "$STAGE/DEBIAN/control" <<EOF
Package: automatic-munyun-machine
Version: $VERSION
Section: utils
Priority: optional
Architecture: all
Depends: nodejs (>= 18), git, ca-certificates
Recommends: zenity | kdialog
Maintainer: Justin Williams <noreply@example.com>
Homepage: https://github.com/7ustoo/automatic-munyun-machine
Description: Daily 100-job Telegram batch ranked by CV match
 Automatic Munyun Machine scrapes hiring.cafe daily, ranks the top 100
 jobs against your CV, and pushes them to Telegram. Local-first, free,
 no cloud, no third-party APIs beyond hiring.cafe / open-meteo /
 Telegram. Run 'amm setup' after install to configure.
EOF

# postinst — runs npm install + playwright install (no wizard; user runs `amm setup` interactively)
cat > "$STAGE/DEBIAN/postinst" <<'EOF'
#!/usr/bin/env bash
set -e
INSTALL_DIR="/opt/automatic-munyun-machine"
echo ""
echo "=== Automatic Munyun Machine installed ==="
echo "Run 'amm setup' to configure (Telegram bot token, CV, etc.)"
echo "Or invoke npm in $INSTALL_DIR for advanced flows."
echo ""
EOF
chmod 755 "$STAGE/DEBIAN/postinst"

echo "→ Building $DEB_NAME…"
dpkg-deb --build --root-owner-group "$STAGE" "$OUT/$DEB_NAME"
echo "✓ Built: $OUT/$DEB_NAME ($(du -h "$OUT/$DEB_NAME" | cut -f1))"
