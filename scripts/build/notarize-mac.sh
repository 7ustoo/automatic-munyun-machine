#!/usr/bin/env bash
# macOS notarizer + stapler.
# Reads APPLE_ID / APPLE_TEAM_ID / APPLE_APP_PASSWORD from env.
#
# Usage:
#   bash scripts/build/notarize-mac.sh path/to/amm-vX.Y.Z.dmg

set -euo pipefail

DMG="${1:-}"
if [[ -z "$DMG" ]]; then
  echo "Usage: $0 path/to/amm.dmg" >&2
  exit 1
fi
if [[ ! -f "$DMG" ]]; then
  echo "❌ File not found: $DMG" >&2
  exit 1
fi

# Skip-and-warn if secrets aren't set. Symmetric to the Windows signer:
# unsigned dmg still works (Gatekeeper "unverified developer" prompt only).
required=(APPLE_ID APPLE_TEAM_ID APPLE_APP_PASSWORD)
for var in "${required[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    echo "[skip notarization — \$$var not set]" >&2
    echo "[unsigned .dmg will still install but Gatekeeper will warn]" >&2
    exit 0
  fi
done

if ! command -v xcrun >/dev/null 2>&1; then
  echo "❌ xcrun not found — is this actually a macOS box with Xcode CLT?" >&2
  exit 1
fi

echo "→ Submitting $DMG to Apple notary service…"
xcrun notarytool submit "$DMG" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_PASSWORD" \
  --wait

echo "→ Stapling notarization ticket…"
xcrun stapler staple "$DMG"

echo "→ Verifying with spctl…"
spctl --assess --type install --verbose "$DMG" || {
  echo "⚠️ spctl assess failed — but stapling succeeded. Verify on a clean Mac."
  exit 0
}

echo "✓ Notarized + stapled: $DMG"
