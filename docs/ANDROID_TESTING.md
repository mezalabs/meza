# Testing on a Physical Android Device

## Prerequisites

1. **Android Studio** — install from [developer.android.com](https://developer.android.com/studio)
2. **Android phone** with USB cable
3. **Developer Options** enabled on your phone (see below)

### Add Android SDK to your PATH

Android Studio installs `adb` and other tools but doesn't add them to your shell. Add this to `~/.zshrc`:

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/tools:$PATH"
```

Then run `source ~/.zshrc` or open a new terminal tab.

### Enable Developer Options on your phone

1. Open **Settings > About phone**
2. Tap **Build number** 7 times — you'll see "You are now a developer"
3. Go back to **Settings > Developer options**
4. Enable **USB debugging**

When you plug in the phone, tap **Allow** on the USB debugging prompt.

---

## Quick Start

```bash
# 1. Build web assets and sync to the Android project
task build:mobile

# 2. Open in Android Studio
task open:android
```

In Android Studio, select your physical device from the device dropdown (top toolbar), then click **Run** (green play button).

---

## Live Reload (Recommended for Development)

Live reload lets you see changes instantly without rebuilding the native app each time.

```bash
# 1. Start dev server and sync Capacitor (auto-detects your local IP)
task dev:mobile

# 2. Run the app from Android Studio (select your device, click Run)
```

Your phone and Mac must be on the same Wi-Fi network. Changes to web code will hot-reload on the device.

---

## Chrome DevTools (Remote Debugging)

When running with `CAPACITOR_DEV_SERVER` set, WebView debugging is enabled automatically (see `capacitor.config.ts`).

1. Open Chrome on your Mac
2. Navigate to `chrome://inspect/#devices`
3. Your device and WebView will appear — click **inspect**

You get the full Chrome DevTools experience: console, network tab, element inspector, etc.

---

## Common Commands

| Command | What it does |
|---|---|
| `task build:mobile` | Build web + sync to native projects |
| `task open:android` | Open Android Studio |
| `npx cap sync` | Sync web assets without rebuilding |
| `npx cap run android` | Build and install on connected device |
| `npx cap run android -l --external` | Run with live reload |
| `adb devices` | Verify your phone is connected |
| `adb logcat \| grep -i capacitor` | View Capacitor logs |

---

## Troubleshooting

**Phone not detected**
- Run `adb devices` — it should list your device
- Try a different USB cable (some are charge-only)
- Revoke and re-authorize USB debugging on the phone

**App installs but shows blank screen**
- Make sure you ran `task build:mobile` first (web assets must be built)
- Check `adb logcat` for errors

**Live reload not connecting**
- Confirm both devices are on the same Wi-Fi network
- Check your IP is correct: `ipconfig getifaddr en0`
- Make sure port 4080 isn't blocked by a firewall
- Verify the dev server is running (`task dev:web`)

**Gradle build fails**
- Open Android Studio and let it sync Gradle (banner at top)
- Check that your Android SDK version matches `variables.gradle` (compileSdk: 35)
