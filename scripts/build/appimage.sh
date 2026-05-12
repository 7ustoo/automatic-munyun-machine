#!/usr/bin/env bash
# Linux .AppImage builder.
#
# Output: dist/amm-vX.Y.Z-x86_64.AppImage — single-file executable that
# extracts to /tmp at run time. Bundles a Node 20 runtime so the AppImage
# works on minimal distros without system Node.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
VERSION="${AMM_VERSION:-$(node -p "require('$ROOT/package.json').version")}"
OUT="${AMM_OUT:-$ROOT/dist}"
ARCH="${ARCH:-x86_64}"
APPIMAGE_NAME="amm-v${VERSION}-${ARCH}.AppImage"
STAGE="$OUT/.stage-appimage"
APPDIR="$STAGE/AppDir"

mkdir -p "$OUT"
rm -rf "$STAGE"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/lib/automatic-munyun-machine"

# 1. Pull a portable Node runtime. Node.js tarballs use "x64"/"arm64", not
# the kernel uname "x86_64"/"aarch64", so map ARCH explicitly.
NODE_VERSION="${NODE_VERSION:-20.18.0}"
case "$ARCH" in
  x86_64|amd64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) NODE_ARCH="$ARCH" ;;
esac
NODE_TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
if [[ ! -f "$STAGE/$NODE_TARBALL" ]]; then
  echo "→ Downloading Node v$NODE_VERSION (linux-${NODE_ARCH})…"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}" -o "$STAGE/$NODE_TARBALL"
fi
echo "→ Extracting Node runtime…"
tar -xf "$STAGE/$NODE_TARBALL" -C "$STAGE/"
NODE_DIR="$STAGE/node-v${NODE_VERSION}-linux-${NODE_ARCH}"
cp "$NODE_DIR/bin/node" "$APPDIR/usr/bin/node"

# 2. Stage the project source
echo "→ Staging source…"
rsync -a \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'data/' \
  --exclude '/dist/' \
  --exclude '.env' \
  --exclude 'config.json' \
  --exclude 'cv.*' \
  --exclude '.planning/' \
  --exclude '.claude/' \
  "$ROOT/" "$APPDIR/usr/lib/automatic-munyun-machine/"

# v1.2: build the wrapper if absent
if [[ ! -x "$APPDIR/usr/lib/automatic-munyun-machine/wrapper/dist/amm-tray" ]]; then
  if command -v go >/dev/null 2>&1; then
    (cd "$ROOT/wrapper" && make build-linux)
    mkdir -p "$APPDIR/usr/lib/automatic-munyun-machine/wrapper/dist"
    cp "$ROOT/wrapper/dist/amm-tray" "$APPDIR/usr/lib/automatic-munyun-machine/wrapper/dist/" 2>/dev/null || true
  fi
fi

# 3. AppRun + .desktop + icon (minimal — AppImage spec requirements)
cat > "$APPDIR/AppRun" <<'EOF'
#!/usr/bin/env bash
HERE="$(dirname "$(readlink -f "$0")")"
export PATH="$HERE/usr/bin:$PATH"
INSTALL_DIR="$HERE/usr/lib/automatic-munyun-machine"
TRAY_BIN="$INSTALL_DIR/wrapper/dist/amm-tray"
case "${1:-}" in
  setup)   exec node "$INSTALL_DIR/scripts/setup-wizard.mjs" ;;
  daily)   exec node "$INSTALL_DIR/scripts/daily-batch.mjs" ;;
  bot)     exec node "$INSTALL_DIR/scripts/telegram-bot.mjs" ;;
  tray)
    if [[ -x "$TRAY_BIN" ]]; then exec "$TRAY_BIN"; else exec node "$INSTALL_DIR/scripts/telegram-bot.mjs"; fi ;;
  login)   exec node "$INSTALL_DIR/scripts/login-once.mjs" ;;
  uninstall) exec node "$INSTALL_DIR/scripts/uninstall.mjs" --mode="${2:-pause}" ;;
  *)
    # No subcommand → launch the tray wrapper (default app behavior).
    # Falls back to wizard on first run if tray binary is missing.
    if [[ -x "$TRAY_BIN" ]]; then exec "$TRAY_BIN"; else exec node "$INSTALL_DIR/scripts/setup-wizard.mjs"; fi ;;
esac
EOF
chmod +x "$APPDIR/AppRun"

cat > "$APPDIR/automatic-munyun-machine.desktop" <<EOF
[Desktop Entry]
Name=Automatic Munyun Machine
Exec=AppRun
Type=Application
Icon=automatic-munyun-machine
Categories=Utility;
Terminal=true
EOF

# 1x1 transparent PNG as a placeholder icon (real icon would replace this).
# Generated as: printf '\x89PNG\r\n\x1a\n...' — easier to just write a static base64.
python3 -c "
import base64
data = base64.b64decode(b'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=')
open('$APPDIR/automatic-munyun-machine.png', 'wb').write(data)
" 2>/dev/null || {
  # Fallback if python3 unavailable: use printf with the raw bytes
  printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x04\x00\x00\x00\xb5\x1c\x0c\x02\x00\x00\x00\x0bIDATx\xdac````\x00\x00\x00\x06\x00\x02\x30\x81\xd0\x40\x00\x00\x00\x00IEND\xaeB`\x82' > "$APPDIR/automatic-munyun-machine.png"
}

# 4. Pull appimagetool if not present
APPTOOL="$STAGE/appimagetool-${ARCH}.AppImage"
if [[ ! -f "$APPTOOL" ]]; then
  echo "→ Downloading appimagetool…"
  curl -fsSL "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-${ARCH}.AppImage" -o "$APPTOOL"
  chmod +x "$APPTOOL"
fi

echo "→ Building AppImage…"
ARCH_AI="$ARCH" "$APPTOOL" --no-appstream "$APPDIR" "$OUT/$APPIMAGE_NAME"

echo "✓ Built: $OUT/$APPIMAGE_NAME ($(du -h "$OUT/$APPIMAGE_NAME" | cut -f1))"
