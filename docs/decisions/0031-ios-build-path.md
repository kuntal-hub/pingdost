# 0031 — iOS build path without a Mac, and iOS gaps until the device work

- **Status:** Accepted (groundwork; device steps blocked on the Apple Developer Program)
- **Date:** 2026-11-03
- **Phase:** 28
- **Approved by user:** n.a. Nothing paid. The US$99/yr Apple Developer Program, an iPhone, and the choice between macOS CI and EAS for device builds are the user's decisions.

## Context
Phase 28 brings the app to iOS (REQ §4.1, §7.1 iOS gate, A12). The user has no Mac and no iPhone (A12). The native crypto binding is ubrn `jsi2` (ADR 0005), which supports iOS through an xcframework that only Xcode can build. Three Android-only local modules exist (`nearby`, `pingdost-calls`, `pingdost-media`). Google Sign-In on iOS needs an iOS OAuth client and a URL scheme.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| **GitHub Actions macOS runner** (`ios.yml`, manual) | Real Xcode; builds the xcframework and an unsigned simulator app; no Apple account | No device install without signing; slow (~30–60 min) | — | Free for public repos (10× minutes on private) |
| EAS Build (free tier) | Managed; can sign with an Apple account | ~15 iOS builds/month, queue; the crypto xcframework must be built in the EAS job too (custom build steps) or vendored | — | Free tier; device builds need the US$99 account |
| Expo prebuild in a Linux container | Runs here; proves every config plugin applies to iOS and shows the Info.plist | Cannot compile or run anything | — | Free |
| A Mac (borrowed/rented cloud Mac) | Everything, including debugging on a device | Not available | — | Rental costs money |

## Decision
1. **Compile checks everywhere:** CI clippy now covers `aarch64-apple-ios` and `aarch64-apple-ios-sim` (the crate compiles for both, checked on Windows 2026-11-03).
2. **macOS CI for real builds:** `.github/workflows/ios.yml` (manual): `ubrn build jsi2 ios --and-generate` → `pingdost_crypto.xcframework` (git-ignored `packages/crypto-native/ios/`, vendored by the existing `CryptoNative.podspec`), a bindings drift check, `expo prebuild --platform ios` (CocoaPods), `xcodebuild` for the simulator with signing off. Written, **not yet run** (it needs the repository pushed).
3. **Device builds** (later, after the Apple account): EAS Build with a custom step that builds the xcframework, or a signed archive from the macOS runner with the App Store Connect API key in GitHub secrets. Decide when the account exists.
4. **Prebuild verified on Linux** (Docker `node:24-bookworm-slim`, `expo prebuild --platform ios --no-install`): plugins apply, SQLCipher is enabled (`expo.sqlite.useSQLCipher`), deployment target 16.4, Info.plist usage strings name calls; the default Face ID string from expo-secure-store is removed (`faceIDPermission: false`; no biometrics are used).
5. **Video on iOS:** no encoder until an AVFoundation version of `PingdostMedia` exists. `PingdostMedia` loads optionally; `planDraft(..., { videoCompression: false })` sends videos as they are when ≤ 100 MB and refuses larger ones with "can't be made smaller on this device yet". Nearby and calls modules already load optionally (null on iOS): nearby screens say unsupported, calls run without the Android call UI (CallKit is Phase 29).
6. **Google Sign-In on iOS:** optional `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` (public config); `app.config.js` adds the google-signin plugin with the reversed client ID as `iosUrlScheme` only when it is set; without it the button is hidden on iOS.

## Consequences
- Still open in Phase 28 (need the account, a device or a Mac): run `ios.yml`; crypto conformance on a device; **exclude the SQLCipher database and the attachment vault from iCloud/iTunes backups** (`NSURLIsExcludedFromBackupKey`; iOS backs up the Documents directory, and a same-device restore could bring back Olm state, which ADR 0003 forbids) — needs a small native step; Keychain access group check; the AVFoundation media module; parity tests; TestFlight. Export compliance (`ITSAppUsesNonExemptEncryption`) is the user's call before the first upload.
- Phase 29 (APNs, CallKit) and 30 (BLE on iOS) unchanged.

## Evidence
- `cargo clippy --workspace --target aarch64-apple-ios -- -D warnings` and `--target aarch64-apple-ios-sim`: pass (Rust 1.99.1, 2026-11-03).
- `npx expo export --platform ios`: the iOS JS bundle builds.
- Linux prebuild output (Info.plist keys): `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSLocalNetworkUsageDescription` (dev client only); no `NSFaceIDUsageDescription`.
- ubrn 0.31.0-6 docs (`docs/src/reference/jsi2.md`): `ubrn build jsi2 ios --and-generate` → `ios/<name>.xcframework`; the player `@ubjs/react-native` ships `UniffiRuntimeJsi.xcframework`.
