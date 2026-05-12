#!/usr/bin/env bash
# Linux .deb + .AppImage GPG signer.
# Reads GPG_KEY_ID from env (or falls back to the only secret key on the
# keyring). For CI: GPG_PRIVATE_KEY (base64) + GPG_PASSPHRASE bring the
# secret key into a fresh agent before this script runs.
#
# Usage:
#   bash scripts/build/sign-linux.sh path/to/amm.deb path/to/amm.AppImage

set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <artifact1> [<artifact2> ...]" >&2
  exit 1
fi

# Skip-and-warn if no signing key is available.
if ! command -v gpg >/dev/null 2>&1; then
  echo "[skip signing — gpg not installed]" >&2
  exit 0
fi
KEY_ID="${GPG_KEY_ID:-$(gpg --list-secret-keys --keyid-format SHORT 2>/dev/null | awk '/^sec/ {gsub(".*/", "", $2); print $2; exit}')}"
if [[ -z "$KEY_ID" ]]; then
  echo "[skip signing — no GPG secret key on keyring + GPG_KEY_ID not set]" >&2
  echo "[unsigned artifacts still install; document SHA256 in release notes]" >&2
  exit 0
fi

for artifact in "$@"; do
  if [[ ! -f "$artifact" ]]; then
    echo "⚠️ Skipping (not found): $artifact" >&2
    continue
  fi
  case "$artifact" in
    *.deb)
      if ! command -v dpkg-sig >/dev/null 2>&1; then
        echo "→ Installing dpkg-sig…"
        sudo apt-get install -y dpkg-sig 2>/dev/null || {
          echo "❌ dpkg-sig not available; skipping $artifact" >&2
          continue
        }
      fi
      echo "→ Signing $artifact (dpkg-sig)…"
      dpkg-sig --sign builder -k "$KEY_ID" "$artifact"
      dpkg-sig --verify "$artifact"
      ;;
    *.AppImage)
      echo "→ Signing $artifact (detached GPG)…"
      gpg --batch --yes --local-user "$KEY_ID" --output "${artifact}.sig" --detach-sign "$artifact"
      gpg --verify "${artifact}.sig" "$artifact"
      echo "  → ${artifact}.sig"
      ;;
    *)
      echo "⚠️ Don't know how to sign: $artifact (must be .deb or .AppImage)" >&2
      ;;
  esac
done

echo "✓ Linux signing pass complete"
