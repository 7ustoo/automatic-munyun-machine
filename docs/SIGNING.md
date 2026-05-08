# Code Signing — AMM v1.1

This is the maintainer-facing playbook for signing release artifacts on each
platform. End users don't need to read this. The release build (`.github/
workflows/release.yml`) calls these scripts automatically once secrets are
configured; you can also sign locally for ad-hoc testing.

> **Trust budget reality check:** signed installers reduce Windows SmartScreen
> warnings, satisfy macOS Gatekeeper, and let Linux distros verify package
> integrity. They do **not** make the bot more secure for the user — they
> just remove the "unknown publisher" friction at install time. AMM is a
> hobby tool; if you skip signing, the only cost is one extra "More info →
> Run anyway" click per OS.

---

## Windows — `.exe` installer signing

### One-time cert acquisition

**Recommended: Microsoft Trusted Signing** (~$9.99/month, no hardware token).

1. Sign in to Azure Portal → "Trusted Signing" → "Create resource."
2. Pick "Public Trust" identity verification (~1-3 business days).
3. Create a Certificate Profile (one per signing identity). Note the
   **Account Name** + **Certificate Profile Name**.
4. Generate an Azure service principal with `Trusted Signing Certificate
   Profile Signer` role: gives `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
   `AZURE_CLIENT_SECRET`.

**Alternative: DigiCert / Sectigo OV cert** (~$300/year, USB hardware token).
Slower flow; only worth it if you can't use Azure.

### Local signing (manual)

After the Inno Setup build produces `installer/dist/amm-setup-vX.Y.Z.exe`:

```powershell
# One-time install of the signing tool
dotnet tool install --global azuresigntool

# Sign
$env:AZURE_CLIENT_ID = "..."
$env:AZURE_TENANT_ID = "..."
$env:AZURE_CLIENT_SECRET = "..."
bash scripts/build/sign-windows.ps1 installer/dist/amm-setup-v1.1.0.exe
```

### CI signing

Add the three Azure secrets to the GitHub repo (`AZURE_CLIENT_ID`,
`AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`) plus `AZURE_TS_ACCOUNT` and
`AZURE_TS_PROFILE` (your account + profile names). The release workflow
picks these up automatically.

### Cert renewal

Microsoft Trusted Signing renews automatically as long as the Azure
subscription is paid. If billing fails, signing fails — keep the
subscription alive.

---

## macOS — `.dmg` notarization

### One-time setup

1. Apple Developer Program enrollment ($99/year). Account verification
   takes 1-3 business days (Apple may call to confirm identity).
2. In Xcode, generate a Developer ID Application certificate.
3. Generate an app-specific password at https://appleid.apple.com/ →
   Sign-In and Security → App-Specific Passwords. **NOT your Apple ID
   password** — Apple requires the app-specific one for `notarytool`.

### Local signing (manual)

After `scripts/build/mac.sh` produces `dist/amm-v1.1.0.dmg`:

```bash
export APPLE_ID="you@example.com"
export APPLE_TEAM_ID="ABC1234567"
export APPLE_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"
bash scripts/build/notarize-mac.sh dist/amm-v1.1.0.dmg
```

The script:
1. Submits the dmg to Apple's notary service (`xcrun notarytool submit --wait`)
2. Waits for "Accepted" (typically 1-5 minutes)
3. Staples the notarization ticket onto the dmg (`xcrun stapler staple`)
4. Verifies (`spctl --assess --type install`)

### CI signing

Add to GitHub secrets: `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`,
plus `APPLE_DEVELOPER_ID_CERT_P12_BASE64` (base64-encoded .p12 export of
the Developer ID Application cert) and `APPLE_DEVELOPER_ID_CERT_PASSWORD`.

### Cert renewal

Apple Developer ID Application certs are valid for 5 years; renew via
Xcode before they expire. Apple Developer Program subscription is
annual — don't let it lapse or notarization fails.

---

## Linux — `.deb` and `.AppImage` signing

Light-touch: GPG self-signed, no commercial CA needed. Users verify
against the `keys/amm-release.gpg` published alongside releases.

### One-time setup

```bash
# Generate a signing key (interactive — pick "RSA and RSA", 4096 bits,
# never expires, real name "AMM Release Key", email like "release@..."
gpg --full-generate-key

# Export public key for distribution
gpg --armor --export "AMM Release Key" > keys/amm-release.gpg

# Note the key ID (8 hex chars) — used by the signing scripts
gpg --list-keys --keyid-format SHORT
```

Commit `keys/amm-release.gpg` to the repo. **Do NOT commit the secret key.**

### Local signing (manual)

After `scripts/build/deb.sh` and `scripts/build/appimage.sh` produce
artifacts:

```bash
export GPG_KEY_ID="A1B2C3D4"
bash scripts/build/sign-linux.sh dist/amm-v1.1.0.deb dist/amm-v1.1.0.AppImage
```

### CI signing

Add to GitHub secrets: `GPG_PRIVATE_KEY` (base64-encoded `gpg --export-secret-keys`)
and `GPG_PASSPHRASE`. The release workflow imports the key, signs, and
exports the public key alongside the release assets.

### User verification

Document on the README:
```bash
# Import once
curl -fsSL https://raw.githubusercontent.com/7ustoo/automatic-munyun-machine/main/keys/amm-release.gpg | gpg --import

# Verify a downloaded .deb
dpkg-sig --verify amm-v1.1.0.deb

# Verify an AppImage
gpg --verify amm-v1.1.0.AppImage.sig amm-v1.1.0.AppImage
```

---

## Verification

After a signed release ships, sanity-check each platform:

| Platform | Check | Expected |
|---|---|---|
| Windows | Right-click `.exe` → Properties → Digital Signatures tab | "Signed by [your identity]" |
| Windows | Run `.exe` (fresh box, no prior install) | SmartScreen says "Microsoft Defender SmartScreen prevented an unrecognized app from starting" — but with **less aggressive wording** than unsigned. After your reputation builds (~10-20 installs), it disappears entirely. |
| macOS | `spctl --assess --type install /path/to/amm.dmg` | `accepted: source=Notarized Developer ID` |
| macOS | Open `.dmg` on a fresh Mac | Gatekeeper says "AMM was downloaded from the Internet. Are you sure you want to open it?" — note the **absence** of "unverified developer" |
| Linux | `dpkg-sig --verify amm-vX.Y.Z.deb` | `GOODSIG <key-id>` |
| Linux | `gpg --verify amm-vX.Y.Z.AppImage.sig` | `Good signature from "AMM Release Key"` |

---

## What if signing fails on CI?

The release workflow is configured to **continue without signing** if
secrets are missing — you'll get unsigned artifacts (still functional,
just with the warnings described above). Look for `[skip signing — secrets
not configured]` in the release log to confirm. Add the secrets when
ready and re-run the release.

This is intentional: a missing-secrets failure shouldn't block a release.
Hobby projects don't always have signing keys; the artifacts still work.
