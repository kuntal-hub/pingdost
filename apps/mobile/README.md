# @pingdost/mobile

The PingDost Android app (Expo SDK 58, Expo Router, NativeWind v4). iOS is deferred (ARCHITECTURE A12). Runs as a **dev build**, never Expo Go: it needs SQLCipher and the native crypto module.

## Run on Android
1. Build the native crypto library once (and after Rust changes): `pnpm --filter @pingdost/crypto-native build:android`.
2. Start an emulator or plug in a phone with USB debugging (`adb devices` lists it).
3. `pnpm --filter @pingdost/mobile android`: prebuilds `android/` (git-ignored), builds, installs and starts Metro.

Later runs only need `pnpm --filter @pingdost/mobile start` while the dev build is installed.

## Layout
- `src/app/`: routes only. `(dev)/crypto` is the dev-only crypto interop screen (removed from release bundles).
- `src/screens/`: screen bodies. `src/db/`: SQLCipher database and migrations. `src/crypto/`: secrets, the Olm account store and startup.
- `src/theme/`: light/dark theme from `@pingdost/ui-tokens` (CSS variables read by NativeWind classes).

## Crypto interop proof (Phase 3)
1. `pnpm --filter @pingdost/crypto interop-server` (WASM peer on http://127.0.0.1:8787).
2. `adb reverse tcp:8787 tcp:8787`.
3. In the app: **Crypto interop (dev)** → **Run scenarios** and **Run interop**.
