# Phase 03 — Crypto spike B: mobile shell + native crypto on Android (GATE closes)

**Depends on:** 02 · **Platforms:** Android (real phone + emulator)

## Goal
Create the Expo app shell. Run the approved crypto core natively on Android, with encrypted local storage. Prove Android ↔ Node interop, which closes the REQ §7.1 gate.

## Read first
- REQ §4.1 (Mobile, local DB), §7.1, §7.5, §14.1
- ARCHITECTURE A1, A5, A6
- ADRs from Phase 2
- **Load skill `expo:expo-overview`** (it routes to `expo-project-structure`, `expo-module` and others as needed)

## Tasks
- [ ] Check the latest Expo SDK version and the monorepo + pnpm guidance (Expo docs). Create `apps/mobile` with `create-expo-app` (TypeScript + Expo Router template). Name `PingDost`; package `com.pingdost.app`; scheme `pingdost`.
- [ ] **Monorepo wiring:** Metro resolves `@pingdost/*` TS-source packages; apply the `.npmrc` linker setting if Expo requires it; add `@pingdost/ui-tokens` with initial tokens. Set up NativeWind with a light/dark theme.
- [ ] **Android toolchain:**
  - install the NDK via `sdkmanager` (version recommended by ubrn/RN);
  - add rust targets `aarch64-linux-android`, `armv7-linux-androideabi` and `x86_64-linux-android` (emulator);
  - install `cargo-ndk` if ubrn needs it.
- [ ] **Generate `packages/crypto-native`** (RN Turbo Module) from `crates/pingdost-crypto` with ubrn. Implement `createNativeCryptoProvider()` with the **same** `CryptoProvider` interface as the WASM build.
  - Bytes cross JSI as `ArrayBuffer`/`Uint8Array`, never base64 strings.
- [ ] **Dev build:** `npx expo run:android` works on the emulator and on a real phone.
- [ ] **Encrypted DB:**
  - `expo-sqlite` config plugin with `useSQLCipher: true`, `enableFTS: true`;
  - `src/db/open.ts`: get or create a 32-byte key (expo-crypto random) in `expo-secure-store`, open the DB, run `PRAGMA key`, verify with a test query;
  - `src/db/migrate.ts`: ordered SQL migrations keyed on `PRAGMA user_version`, each in a transaction;
  - migration 001: `local_settings(key PRIMARY KEY, value)` and `crypto_store(id PRIMARY KEY, kind, pickle BLOB, updated_at)`. Chat tables arrive in Phase 10.
- [ ] **Crypto store:** create the Olm account on first run, pickle it with a pickle key held in SecureStore, and store the pickle in `crypto_store`. Reload it on restart.
- [ ] **Interop proof:** dev-only route `app/(dev)/crypto.tsx` plus a Node script `packages/crypto/scripts/interop-server.ts`.
  - The script is a tiny HTTP server on the LAN that uses the WASM provider.
  - **Flow:**
    1. The phone posts its identity key and an OTK.
    2. Node creates an outbound session and returns a prekey message.
    3. The phone decrypts it and replies.
    4. Node decrypts the reply.
    5. Then the same Megolm exchange.
  - The screen shows ✅/❌ per step.
  - Save deterministic vectors (where possible) to `packages/test-fixtures/crypto/`.
- [ ] **Measure** the release APK size delta of SQLCipher + the crypto module (`./gradlew assembleRelease` or `expo run:android --variant release`), and cold-start crypto init time. Record both in a new ADR (native binding & mobile build).
- [ ] Optionally, run the Phase 2 conformance scenarios on-device through the dev screen.

## Key files
`apps/mobile/{app.json|app.config.ts,metro.config.js,app/_layout.tsx,app/(dev)/crypto.tsx,src/db/*,src/crypto/*}`, `packages/crypto-native/*`, `packages/ui-tokens/*`, `packages/crypto/scripts/interop-server.ts`

## Out of scope
Auth screens (07), chat schema (10), protobuf (04).

## Done when
- The real phone's dev build shows all interop steps ✅ in both directions (Olm + Megolm).
- After a restart, the app reloads the same identity key from the pickle.
- The DB file pulled via `adb shell run-as com.pingdost.app` is not readable as plain SQLite (`file`/`sqlite3` fails without the key).
- `pnpm typecheck` and `pnpm lint` pass across the repo.
- The ADR is written; PROGRESS notes **"Crypto gate closed"**.

## Handoff notes
Document the exact build commands in `CLAUDE.md` "Commands": rebuilding the native crypto module and running the Android dev build.

**From Phase 2 (ADR 0003):**
- **Toolchain already installed:**
  - Rust 1.99.1 (MSVC host, pinned in `rust-toolchain.toml`) with VS 2022 Build Tools 17.14;
  - Android NDK 26.1, 27.1 and 28.0 under `%ANDROID_HOME%\ndk`.
- **Pins.** ubrn, `@ubjs/*` and `uniffi-runtime-wasm` are 0.31.0-6. uniffi stays on 0.31.x (ubrn pins `=0.31`).
- **Native targets.** Add the Android targets to `rust-toolchain.toml`'s `targets` list so CI and other machines get them.
- **Same crate as WASM.** The Android build uses the same crate. The WASM-only deps (`uniffi-runtime-wasm`, `wasm-unstable-single-threaded`) sit behind `cfg(target_arch = "wasm32")`.
- **Wrapper target.** `createNativeCryptoProvider()` must implement the same `CryptoProvider` and map errors to `CryptoOperationError`. Mirror `packages/crypto/src/wasm.ts`.
- **Interop test.** Run the same 9 scenarios from `packages/crypto/test/interop.test.ts` between the phone and the Node/WASM side.
- **ubrn quirks:**
  - ubrn needs `repository.url` in the package's `package.json`. Phase 2 used a placeholder (`OWNER`); replace it once the GitHub remote exists.
  - The ubrn CLI compiles itself on first run (about 2 minutes).
