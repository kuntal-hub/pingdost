# @pingdost/mobile

The PingDost Android app (Expo SDK 58, Expo Router, NativeWind v4). iOS is deferred (ARCHITECTURE A12). Runs as a **dev build**, never Expo Go: it needs SQLCipher, the native crypto module and Google Sign-In.

## Configure
Create `apps/mobile/.env` (git-ignored; Metro inlines the values at bundle time, so restart Metro after a change):

```
EXPO_PUBLIC_API_URL=http://192.168.x.x:3000      # the PC's LAN IP; the server binds 0.0.0.0
EXPO_PUBLIC_WS_URL=ws://192.168.x.x:3000/v1/ws
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=…apps.googleusercontent.com   # optional; hides Google sign-in when unset
```

Debug builds allow cleartext HTTP to the LAN (Expo's debug manifest); release builds are HTTPS-only. Without the API and WS URLs the app shows a configuration error.

## Run on Android
1. Build the native crypto library once (and after Rust changes): `pnpm --filter @pingdost/crypto-native build:android`.
2. Start the infra and the API: `pnpm infra:up`, then `pnpm --filter @pingdost/server dev`.
3. Start an emulator or plug in a phone with USB debugging (`adb devices` lists it).
4. `pnpm --filter @pingdost/mobile android`: prebuilds `android/` (git-ignored), builds, installs and starts Metro.

Later runs only need `pnpm --filter @pingdost/mobile start` while the dev build is installed. Run `npx expo prebuild --platform android --clean` after changing `app.json` plugins or native dependencies.

## Layout
- `src/app/`: routes only. The root layout gates groups with `Stack.Protected` (ADR 0009):
  - `(auth)`: welcome, register, verify-otp, login, forgot/reset password, google-username;
  - `setup`: device registration;
  - `(app)`: tabs Chats and Settings;
  - `(dev)/crypto`: the dev-only crypto interop screen (removed from release bundles).
- `src/screens/`: screen bodies. `src/components/`: shared UI.
- `src/auth/`: the session store (Zustand; tokens in SecureStore, single-flight refresh), form schemas, Google sign-in.
- `src/device/`: device setup (register or resume the primary device) and one-time key top-ups.
- `src/api/`: the API client wired to the session, and user-facing error messages.
- `src/settings/`: profile, avatar upload and privacy preferences.
- `src/db/`: SQLCipher database, migrations and `local_settings`. `src/crypto/`: secrets, the Olm account store and startup.
- `src/theme/`: light/dark theme from `@pingdost/ui-tokens` (CSS variables read by NativeWind classes).

## Tests
`pnpm --filter @pingdost/mobile test` runs the platform-independent modules in Node (Vitest): the auth store, form schemas and error messages, and device setup against an in-memory server with the WASM crypto provider.

## Crypto interop proof (Phase 3)
1. `pnpm --filter @pingdost/crypto interop-server` (WASM peer on http://127.0.0.1:8787).
2. `adb reverse tcp:8787 tcp:8787`.
3. In the app: **Crypto interop (dev)** (welcome screen or Settings → Developer) → **Run scenarios** and **Run interop**.
