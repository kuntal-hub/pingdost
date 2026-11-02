# Phase 28 — iOS: build pipeline, native crypto, core chat parity (DEFERRED)

**Depends on:** 27 · **Platforms:** iOS · **Status:** 🔄 groundwork done (2026-11-03, ADR 0031); the rest waits for the user's Apple account, an iPhone and a macOS build

## Prerequisites (ask the user)
- An Apple Developer Program membership (**$99/yr**) to install builds on an iPhone or use TestFlight.
- Build path: EAS Build free tier (about 15 iOS builds/month, low priority) **or** GitHub Actions macOS runners (minutes count 10× on private repos; free for public repos) **or** a Mac.
- At least one iPhone for testing.

## Goal
The iOS app reaches parity with Android for accounts, 1:1 and group chat, attachments, web pairing (as primary) and backup/restore.

## Read first
- REQ §4.1, §7.1 (iOS), §11.5 (iOS notes)
- ARCHITECTURE A5, A6, A12
- The native-binding ADR (Phase 3)
- **Load skills `expo:expo-overview`, `expo:eas-app-stores`**

## Tasks (outline)
Status 2026-11-03 (ADR 0031): no-cost groundwork done from Windows; everything that needs a Mac, an iPhone or the Apple account is open.
- [x] The Rust crate compiles for `aarch64-apple-ios` and `aarch64-apple-ios-sim` (clippy `-D warnings`, also in CI).
- [x] ubrn iOS config and `pnpm --filter @pingdost/crypto-native build:ios` (`ios/pingdost_crypto.xcframework`, git-ignored, vendored by `CryptoNative.podspec`).
- [ ] Build it: `.github/workflows/ios.yml` (manual, macOS runner, free on a public repo) builds the xcframework, checks the bindings, prebuilds and builds an unsigned simulator app. **Written, not run** (push first). Device builds: EAS with a custom xcframework step, or a signed archive from CI (after the Apple account).
- [x] Expo config for iOS verified by `expo prebuild --platform ios` in a Linux container: SQLCipher on, iOS 16.4, usage strings name calls, no Face ID string. JS bundle: `npx expo export --platform ios` builds.
- [ ] SQLCipher + Keychain on a device; **exclude the database and the attachment vault from iCloud/iTunes backups** (`NSURLIsExcludedFromBackupKey`, a small native step; ADR 0003 forbids restoring Olm state) and check the Keychain access group. SecureStore items already use `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
- [ ] Run the crypto conformance suite on device.
- [x] Platform adapters, part 1: video module optional (iOS sends videos uncompressed ≤ 100 MB, refuses larger with a clear message); Google Sign-In on iOS behind `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` + the plugin's `iosUrlScheme` (app.config.js); nearby/calls modules already optional.
- [ ] Platform adapters, part 2: AVFoundation `PingdostMedia` (`videoInfo`, `videoFrame`, `compressVideo` + progress/cancel); the iOS Google OAuth client (Google Cloud console, free); export compliance (`ITSAppUsesNonExemptEncryption`, the user's call).
- [ ] Parity testing for Phases 7, 10, 11, 13, 15, 16 (phone side), 18 and 19 on iPhone ↔ Android ↔ web.
- [ ] TestFlight internal build (needs the US$99/yr account).
## Done when
An iPhone chats E2EE with Android and web, sends attachments, pairs a browser and restores from a backup.

## Handoff notes
**From Phase 7 (ADR 0009):** add the `@react-native-google-signin/google-signin` config plugin with `iosUrlScheme` (the reversed iOS client ID) to `app.json`. Android needs no plugin, and adding it without options would apply Firebase `google-services`. SecureStore items already use `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.

**From Phase 15 (ADR 0018):** the local `PingdostMedia` module (`apps/mobile/modules/pingdost-media`) is Android-only (Media3). iOS needs `videoInfo` / `videoFrame` / `compressVideo` with `onCompressProgress` and `cancelCompression` on AVFoundation (`AVAssetExportSession` or `AVAssetWriter`). The expo-audio and expo-image-picker plugins also need iOS usage strings.