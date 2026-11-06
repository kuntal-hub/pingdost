# Google Play: account, internal testing, declarations (Phase 27)

> **Costs money:** a Google Play developer account is a **US$25 one-time** fee with a card. Nothing here has been paid or created; do steps 1–2 only when you decide to.

## 1. The developer account (you, once)
1. https://play.google.com/console → sign in with the Google account that will own the app → **Personal** (or Organisation if you have a registered entity; that needs a D-U-N-S number).
2. Pay the US$25 fee, verify your identity (ID document) and a contact phone and email. Verification can take a few days.
3. New personal accounts must run a **closed test with at least 12 testers for 14 days** before production access. Internal testing (below) has no such rule and is what Phase 27 needs.

## 2. Create the app
1. **Create app** → name `PingDost`, default language, **App**, **Free**, accept the declarations.
2. **Setup → App integrity → App signing**: keep **Play App Signing** (Google holds the app signing key; your upload key from `docs/ops/mobile-release.md` signs uploads and can be reset if lost).

## 3. Build the AAB (on this PC)
1. Raise `android.versionCode` in `apps/mobile/app.json` by 1 for every upload (Play refuses a reused code); `version` is SemVer (ADR 0030). The first upload is `0.1.0` / `1`.
2. Staging URLs in `apps/mobile/.env.production` (mobile-release.md §2).
3. Build:
   ```powershell
   $env:JAVA_TOOL_OPTIONS='-Djava.net.preferIPv4Stack=true'
   cd apps/mobile
   npx expo prebuild --platform android --clean
   cd android
   .\gradlew.bat bundleRelease
   ```
   Output: `apps/mobile/android/app/build/outputs/bundle/release/app-release.aab` (64-bit only: arm64-v8a, x86_64; ADR 0005/0030). Without the upload-key properties it is debug-signed and Play rejects it. Built on this PC on 2026-11-03 in 18 minutes: 82 MB (debug-signed). R8 needs the `org.webrtc` keep rules in `app.json` (`expo-build-properties` → `extraProguardRules`); without them the release build fails on `org.webrtc.Dav1dDecoder$Natives`.
4. Optional, before uploading: `bundletool build-apks --connected-device` to install it on your phone.

## 4. Internal testing track
1. **Testing → Internal testing → Create new release** → upload the AAB → release notes → **Save → Review → Roll out**.
2. **Testers** tab → create an email list (up to 100) → copy the **opt-in link** and send it to testers. They accept, then install from Play.
3. Internal releases skip most review and are usually available within minutes.

## 5. App content (Policy → App content)
| Item | Answer |
|---|---|
| Privacy policy URL | A public page with `docs/legal/privacy-policy.md` (after you fill in the bracketed fields), e.g. on `pingdost.com/privacy` or the GitHub-rendered file |
| Ads | No ads |
| App access | Account needed: give reviewers a test username and password (a real account on staging, not yours) |
| Content rating | Questionnaire: messaging app with user-to-user communication; users can share content; no moderation of encrypted content (reports exist) |
| Target audience | 18+ (or 16+/13+ per your terms); not designed for children |
| News app | No |
| Government app | No |
| Financial features | None |
| Health | None |

### Data safety (draft answers)
"Collected" = leaves the device to us or a third party; data processed only on the device is not collected. End-to-end encrypted content that we cannot read is **not** declared as collected (Google's guidance), but say "data is encrypted in transit" = **Yes**.

| Data type | Collected? | Shared? | Purpose | Optional? | Notes |
|---|---|---|---|---|---|
| Email address | Yes | No | Account management, security (verification codes) | Required | Sent to the email provider only to deliver codes (service provider, not "sharing") |
| User IDs (username, account ID) | Yes | No | Account management, app functionality | Required | |
| Name (display name) | Yes | No | App functionality | Optional | |
| Photos (profile picture) | Yes | No | App functionality | Optional | Public profile picture on Cloudinary |
| Messages (emails/SMS/other in-app messages) | **No** | No | — | — | End-to-end encrypted; servers hold ciphertext only, temporarily |
| Photos and videos, files, audio (attachments) | **No** | No | — | — | End-to-end encrypted |
| Contacts | No | — | — | — | The app does not read the phone's address book |
| Location | No | — | — | — | `ACCESS_FINE_LOCATION` is declared only up to Android 11 because Bluetooth scanning needs it there; no location is read or sent |
| App activity / interactions | No | — | — | — | No analytics |
| Device or other IDs | Yes | No | App functionality (push delivery), security | Required | FCM push token, PingDost device ID |
| Crash logs, diagnostics | No (by PingDost) | — | — | — | Android vitals is collected by Google, not by the app |
| IP address | Yes (hashed, security events) | No | Security, fraud prevention | Required | |

- Data encrypted in transit: **Yes** (TLS everywhere; messages and files also end-to-end).
- Users can request deletion: **Yes** (fill in the deletion path or email; Play requires an account-deletion URL or in-app path for apps with accounts).
- Independent security review: No (unless you get one).

## 6. Permission and foreground-service declarations
Play Console asks about these when the AAB declares them. Use the wording the app itself shows.

| Permission / type | Why (declaration text) | Where in the app |
|---|---|---|
| `FOREGROUND_SERVICE_CONNECTED_DEVICE` | Keeps the Bluetooth link to nearby PingDost phones alive so messages can move without Internet (nearby messaging and relay, off by default) | Settings → Nearby messaging (`screens/settings/nearby.tsx`) |
| `FOREGROUND_SERVICE_PHONE_CALL` (+ `MICROPHONE`, `CAMERA`) | Keeps an ongoing voice or video call running when the app is in the background | Calls (`modules/pingdost-calls`, ADR 0029) |
| `USE_FULL_SCREEN_INTENT` | Shows the incoming-call screen over the lock screen; PingDost is a calling app | Incoming calls; Calls tab shows the permission state |
| `MANAGE_OWN_CALLS` | Self-managed calling app (audio routing during calls) | Calls |
| `BLUETOOTH_SCAN` / `ADVERTISE` / `CONNECT` (`ACCESS_FINE_LOCATION` ≤ Android 11) | Finding and connecting to nearby PingDost phones; never used for location | Nearby setup screen explains it first |
| `RECEIVE_BOOT_COMPLETED` | Optional reminder notification after a restart that nearby relaying is paused (ADR 0025) | Settings → Nearby relay → "Remind me…" |
| `CAMERA`, `RECORD_AUDIO` | Photos/videos and voice notes you send, QR scanning, calls | Asked at first use |
| `POST_NOTIFICATIONS` | Message and call notifications (content-free) | Asked after sign-in |
| `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE` (≤ Android 12) | Declared by Expo libraries for saving and picking files on old Android versions | — |

Removed in `app.json` (`blockedPermissions`): `READ_MEDIA_IMAGES` (added by expo-screen-capture for screenshot listeners; the app uses only FLAG_SECURE) and `SYSTEM_ALERT_WINDOW` (an Expo template default; calls use a full-screen intent, not an overlay). The release manifest of 2026-11-03 held 29 `android.permission.*` entries, before `DETECT_SCREEN_CAPTURE` was restored on 2026-11-06, so expect one more. Normal permissions that need no declaration: `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `VIBRATE`, `WAKE_LOCK`, `MODIFY_AUDIO_SETTINGS`, `USE_BIOMETRIC`/`USE_FINGERPRINT` (from expo-secure-store; unused), `READ_APP_BADGE`, `DETECT_SCREEN_CAPTURE` (expo-screen-capture needs it on Android 14+ or the app crashes at launch; the app has no screenshot listener). Before each upload, check the list in Play's "App bundle explorer".

## 7. Store listing (draft)
- Short description: "Private, end-to-end encrypted chat that also works nearby without Internet."
- Full description: features (E2EE 1:1 and groups, files, web on your computer by QR, nearby Bluetooth messaging and relay, 1:1 calls) and the honest privacy line: "No permanent server-side chat history. Encrypted messages wait on our server only until delivered, 14 days at most."
- Do not claim "no data ever touches our servers" or "anonymous" (A10).
- Screenshots: phone 16:9 or 9:16, at least 2; a 512×512 icon; a 1024×500 feature graphic.
