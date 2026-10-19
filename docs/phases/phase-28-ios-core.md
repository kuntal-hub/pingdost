# Phase 28 — iOS: build pipeline, native crypto, core chat parity (DEFERRED)

**Depends on:** 27 · **Platforms:** iOS · **Status:** ⏸ until the user has the means for iOS builds and testing

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
- [ ] Build the Rust crate for `aarch64-apple-ios` and `aarch64-apple-ios-sim` via ubrn (xcframework). Make the EAS or CI macOS build compile it, or vendor a prebuilt artifact built in CI.
- [ ] SQLCipher + secure store (Keychain) on iOS; check the access-group and backup-exclusion flags.
- [ ] Run the crypto conformance suite on device.
- [ ] Platform adapters: Google Sign-In iOS config, file system, pickers, compression, permissions copy (Info.plist usage strings).
- [ ] Parity testing for Phases 7, 10, 11, 13, 15, 16 (phone side), 18 and 19 on iPhone ↔ Android ↔ web.
- [ ] TestFlight internal build.

## Done when
An iPhone chats E2EE with Android and web, sends attachments, pairs a browser and restores from a backup.

## Handoff notes
**From Phase 7 (ADR 0009):** add the `@react-native-google-signin/google-signin` config plugin with `iosUrlScheme` (the reversed iOS client ID) to `app.json`. Android needs no plugin, and adding it without options would apply Firebase `google-services`. SecureStore items already use `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
