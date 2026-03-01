# Code Signing Setup

This guide covers obtaining and configuring the certificates needed for the desktop release workflow (`.github/workflows/desktop-release.yml`).

## Overview

| Platform | What you need | GitHub Secret | Cost |
|----------|--------------|---------------|------|
| macOS | Apple Developer certificate + notarization credentials | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | $99/year |
| Windows | Code signing certificate (.pfx) | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | ~$70-400/year |
| Linux | None required | — | Free |

## macOS

### 1. Enroll in Apple Developer Program

- Go to https://developer.apple.com/programs/
- Enroll as an individual or organization ($99/year)
- Organization enrollment requires a D-U-N-S number (free, takes ~1 week)

### 2. Create a Developer ID Application certificate

This is the certificate type used for distributing apps outside the Mac App Store.

**Option A: Via Xcode (easiest)**

1. Open Xcode → Settings → Accounts → Manage Certificates
2. Click `+` → "Developer ID Application"
3. Xcode creates the certificate and installs it in your Keychain

**Option B: Via Apple Developer portal**

1. Go to https://developer.apple.com/account/resources/certificates/list
2. Click `+` → "Developer ID Application"
3. Create a Certificate Signing Request (CSR):
   - Open Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority
   - Enter your email, select "Saved to disk"
4. Upload the CSR to the portal
5. Download the `.cer` file and double-click to install in Keychain

### 3. Export as .p12

1. Open Keychain Access
2. Find your "Developer ID Application: ..." certificate under "My Certificates"
3. Right-click → Export
4. Choose `.p12` format
5. Set a strong password — this becomes `MAC_CSC_KEY_PASSWORD`

### 4. Base64-encode for GitHub

```bash
base64 -i developer-id-application.p12 | pbcopy
```

The clipboard contents become `MAC_CSC_LINK`.

### 5. Create an app-specific password for notarization

Apple notarization requires an app-specific password (your regular Apple ID password won't work with CI).

1. Go to https://appleid.apple.com/account/manage
2. Sign in → App-Specific Passwords → Generate
3. Name it "Meza Desktop CI" or similar
4. Copy the generated password — this becomes `APPLE_APP_SPECIFIC_PASSWORD`

### 6. Find your Team ID

1. Go to https://developer.apple.com/account → Membership Details
2. Copy the Team ID (10-character alphanumeric string)
3. This becomes `APPLE_TEAM_ID`

### 7. Set GitHub secrets

```
MAC_CSC_LINK          = <base64-encoded .p12>
MAC_CSC_KEY_PASSWORD  = <password you set when exporting .p12>
APPLE_ID              = <your Apple ID email>
APPLE_APP_SPECIFIC_PASSWORD = <app-specific password from step 5>
APPLE_TEAM_ID         = <10-char Team ID>
```

Set these at: GitHub repo → Settings → Secrets and variables → Actions → New repository secret

## Windows

### 1. Choose a certificate provider

Code signing certificates for Windows must come from a trusted Certificate Authority. Options:

| Provider | Type | Approx. cost | Notes |
|----------|------|-------------|-------|
| SSL.com | OV code signing | ~$70/year | Cheapest option, USB token or cloud signing |
| Sectigo (Comodo) | OV code signing | ~$180/year | Well-known CA |
| DigiCert | EV code signing | ~$400/year | Highest trust, required for kernel drivers |

**OV (Organization Validation)** is sufficient for Electron apps. EV provides higher SmartScreen reputation but costs more and requires a hardware token.

> **Note:** As of June 2023, all new code signing certificates must be stored on hardware (USB token or HSM). Some CAs offer cloud-based HSM signing as an alternative. SSL.com's eSigner is one cloud option that works with CI.

### 2. Purchase and validate

1. Purchase an OV code signing certificate from your chosen CA
2. Complete organization validation (business documents, phone verification)
3. Validation typically takes 1-5 business days

### 3. Export as .pfx

If you receive a USB token:

1. Install the CA's tools/drivers
2. Export the certificate + private key as a `.pfx` file
3. Set a strong password — this becomes `WIN_CSC_KEY_PASSWORD`

If using cloud signing (e.g., SSL.com eSigner):

1. Follow the CA's CI integration guide
2. You may need different env vars — check electron-builder docs for your CA

### 4. Base64-encode for GitHub

```bash
base64 -i code-signing.pfx | tr -d '\n'
```

The output becomes `WIN_CSC_LINK`.

### 5. Set GitHub secrets

```
WIN_CSC_LINK         = <base64-encoded .pfx>
WIN_CSC_KEY_PASSWORD = <password set when exporting .pfx>
```

## Verification

### Test locally (macOS)

After building a signed app:

```bash
# Check code signature
codesign --verify --deep --strict /path/to/Meza.app

# Check notarization
spctl --assess --verbose /path/to/Meza.app
# Expected: "accepted, source=Notarized Developer ID"

# Check entitlements
codesign -d --entitlements - /path/to/Meza.app
```

### Test locally (Windows)

```powershell
# Check Authenticode signature
Get-AuthenticodeSignature .\Meza-Setup-0.1.0.exe
# Expected: Status = Valid
```

### Test via CI

1. Push a test tag: `git tag desktop-v0.0.1-test && git push --tags`
2. Check the GitHub Actions run for signing/notarization logs
3. Download artifacts and verify signatures locally
4. Delete the test tag and draft release when done:
   ```bash
   git tag -d desktop-v0.0.1-test
   git push --delete origin desktop-v0.0.1-test
   gh release delete desktop-v0.0.1-test --yes
   ```

## Without certificates

The workflow runs fine without signing secrets configured — electron-builder produces unsigned builds. The tradeoffs:

| | Signed | Unsigned |
|---|--------|----------|
| **macOS** | Opens normally | Gatekeeper blocks; user must right-click → Open, or `xattr -d com.apple.quarantine Meza.app` |
| **Windows** | Opens normally (after SmartScreen reputation builds) | SmartScreen warns "Windows protected your PC" |
| **Linux** | N/A | No difference |

For internal testing, unsigned builds are fine. For public distribution, signing is required for a good user experience.

## Checklist

- [ ] Enroll in Apple Developer Program ($99/year)
- [ ] Create Developer ID Application certificate
- [ ] Export .p12, base64-encode, set `MAC_CSC_LINK` + `MAC_CSC_KEY_PASSWORD`
- [ ] Create app-specific password, set `APPLE_APP_SPECIFIC_PASSWORD`
- [ ] Set `APPLE_ID` and `APPLE_TEAM_ID`
- [ ] Purchase Windows OV code signing certificate (~$70-400/year)
- [ ] Export .pfx, base64-encode, set `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`
- [ ] Run a test build to verify signing and notarization
