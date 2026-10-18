# 0005 — Native crypto binding & Android build: ubrn `jsi2` player, SQLCipher, 64-bit ABIs

- **Status:** Accepted
- **Date:** 2026-10-18
- **Phase:** 03 (closes the crypto gate opened by ADR 0003)
- **Approved by user:** n.a. (implementation of the approved ADR 0003)

## Context
- **REQ §7.1:** the crypto proof must run on React Native Android, not only web/Node (Phase 2).
- **REQ §7.5, §14.1:** encrypted local SQLite (SQLCipher "subject to build-size/native compatibility tests"); the DB key and private keys in OS secure storage.
- **ADR 0003** chose vodozemac behind `crates/pingdost-crypto`, bound with uniffi-bindgen-react-native (ubrn) 0.31.0-6, and asked Phase 3 to prove the Android build on a Windows host.
- **ARCHITECTURE A5, A6:** consumers see only `CryptoProvider`; Expo dev builds; `expo-sqlite` with SQLCipher.
- **Stack found at Phase 3 (2026-10-18):** Expo SDK 58.0.14, React Native 0.88.0 (new architecture, Hermes), Gradle 9.4.1, NDK 27.1, JDK 17.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| **ubrn `jsi2`** (chosen): our crate as `lib<name>.so`; the prebuilt `@ubjs/react-native` JSI player (one Turbo Module) loads it | No per-library C++/Kotlin/CMake; only `cargo-ndk` builds; generated TypeScript has the same API as `wasm2`, so web and Android share one wrapper | New (0.31.0-6, 2026-09-25); player ships **64-bit ABIs only**; libffi dispatch per call | MPL-2.0 | Free |
| ubrn `jsi` (classic per-library Turbo Module) | Mature since 2024; any ABI including `armeabi-v7a` | Generated C++/Kotlin/CMake per library compiled in the app's Gradle build; a different TS runtime from `wasm2` (two wrappers) | MPL-2.0 | Free |
| Hand-written JSI or Kotlin JNI | Full control | Large unsafe glue to write, review and keep in sync | — | Free |

## Decision
1. **Binding.** `packages/crypto-native` is a ubrn `jsi2` library (`ubrn.config.yaml`): an empty `ReactPackage`, a Gradle file that packages `jniLibs`, and generated TypeScript bindings.
   - `pnpm --filter @pingdost/crypto-native build:android` runs `cargo ndk` for `arm64-v8a` and `x86_64` (API 24, release profile) and regenerates `src/generated/`.
   - The `.so` files are **not committed** (build output, about 1.9 MB each); the TypeScript bindings are, like the `wasm2` ones.
   - The app depends **directly** on `@ubjs/react-native` 0.31.0-6 (autolinking reads only the app's `package.json`).
2. **One wrapper.** `createBindingsProvider(bindings, implementation)` in `@pingdost/crypto/core` wraps either generated module. `createWasmCryptoProvider()` and `createNativeCryptoProvider()` both call it, so error mapping (`CryptoOperationError`) and byte handling (`ArrayBuffer` across JSI, never base64) are identical. TypeScript checks that the `jsi2` bindings match the `wasm2` shape.
3. **ABIs.** The app builds only `arm64-v8a` and `x86_64` (`expo-build-properties` `buildArchs`). 32-bit-only phones are unsupported for now (CHANGES 2026-10-18). Revisit in Phase 27: build the player for `armeabi-v7a` from ubrn's sources, or switch to the `jsi` flavour.
4. **Local database.** `expo-sqlite` 58.0.13 with `useSQLCipher: true`, `enableFTS: true`.
   - A random 32-byte raw key, passed as `PRAGMA key = "x'…'"` (no passphrase KDF on every open).
   - Opening fails unless `PRAGMA cipher_version` answers (plain SQLite ignores `PRAGMA key` silently) and `sqlite_master` is readable.
   - `STRICT` tables; migrations keyed on `PRAGMA user_version`, each in an exclusive transaction with its version bump.
5. **Secrets.** Two 32-byte secrets from `expo-crypto`, stored hex-encoded in `expo-secure-store` (Android Keystore-backed): `pingdost.db-key.v1` and `pingdost.pickle-key.v1`. iOS later uses `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
6. **Crypto store.** The device Olm account exists only as a pickle in `crypto_store` (`kind = 'olm.account'`), re-saved after every change (one-time keys, inbound sessions).
7. **No Android Auto Backup** (`allowBackup: false`): backups must not carry the DB or pickles (ADR 0003 backup rule).
8. **Conformance.** `@pingdost/crypto/conformance` holds the Phase 2 scenarios (runner-independent), deterministic vectors (`@pingdost/test-fixtures/crypto/vodozemac-0.11.1.json`) and the phone ↔ Node interop protocol. Vitest runs them on WASM; the dev screen runs them on the phone.

9. **Windows build environment** (found while building; needed on every Windows machine that builds the app):
   - **Repo path.** React Native's CMake builds nest the absolute source path inside object paths, so paths double. The phase was finished in a short copy (`C:\dev\pd`); afterwards the user chose to keep the repo in `C:\Users\Km799\OneDrive\Desktop\pingdost`. With the two fixes below, a dev build at that path works (verified on the phone, 2026-10-19).
   - **pnpm `nodeLinker: hoisted`** (`pnpm-workspace.yaml`), as Expo documents for React Native problems with isolated installs: isolated paths (`node_modules/.pnpm/<name>@<version>_<hash>/…`) pushed CMake prefab files past 260 characters.
   - **Windows long paths on** (`LongPathsEnabled=1`, one admin change) **and Ninja ≥ 1.12** (Reanimated's Windows guide). The Android SDK's CMake 3.22.1 ships Ninja 1.10.2, which cannot handle long paths; it was replaced with the official Ninja 1.13.2 (SHA-256 checked, backup kept as `ninja.exe.1.10.2.bak`). React Native codegen paths in the app module reach about 280 characters even at `C:\dev\pd`, and more at the OneDrive path.
10. **Package details.**
    - `crypto-native` sets its Java package in `ubrn.config.yaml` (`android.packageName`), not in `package.json` `codegenConfig`: that field makes React Native autolinking include a codegen header the library does not have.
    - `react-native-gesture-handler` is pinned to SDK 58's 3.3.0 as a direct dependency (otherwise pnpm auto-installs 3.4.0 as a peer of Expo Router's drawer).
    - `react-native-css-interop` 0.2.7 is a direct dependency (NativeWind's Babel preset imports it).

## Consequences
- Rust changes need `build:android` before an Android build; the `jsi2` and `wasm2` bindings must be regenerated together (drift check: Phase 27).
- `@ubjs/react-native` must stay a direct app dependency, pinned to the same 0.31.0-x as ubrn and `@ubjs/core`.
- **SQLCipher keys are per connection.** expo-sqlite's `withExclusiveTransactionAsync` (and any `useNewConnection: true` open) creates a second connection without `PRAGMA key`, and every statement on it fails with "file is not a database". Use `withTransactionAsync` or `BEGIN IMMEDIATE … COMMIT` on the keyed connection (see `apps/mobile/src/db/migrate.ts`), or key every new connection.
- Java on this PC must prefer IPv4 for Gradle downloads (`JAVA_TOOL_OPTIONS=-Djava.net.preferIPv4Stack=true`); IPv6 connects time out.
- Updated: ARCHITECTURE A5/A6, CHANGES, CLAUDE.md, phases 07, 10 and 27.

## Evidence (2026-10-19)
**Devices:** Pixel 8 API 35 emulator (x86_64) and a **vivo V2437, Android 16, arm64-v8a** (real phone).

**Gate checks (dev build, both devices):**
- On-device conformance: all 14 Phase 2 scenarios and the 3 WASM-made vectors pass on the native provider. 52 ms on the phone, 1.19 s on the emulator.
- Phone ↔ Node interop (`scripts/interop-server.ts`, WASM peer): all 6 steps pass on both devices. Olm both ways (pre-key, reply, ratchet message) and Megolm both ways (room key over Olm, then a group message).
- Restart: same Curve25519 identity key, "restored from pickle".
- At rest: the DB and WAL files pulled with `adb shell run-as com.pingdost.app` have no SQLite header and no readable schema text; Node's `node:sqlite` fails with "file is not a database". `PRAGMA cipher_version` reports `4.17.0 community`.

**Cold-start crypto init (release build, phone):** DB open + key check + migrations + account restore, including the first native library call.

| Case | Runs | Crypto ready | Activity launch (`am start -W` TotalTime) |
|---|---|---|---|
| Restore (normal start) | 5 | 48–144 ms, median 64 ms | 591–842 ms, median 678 ms |
| First run (new keys + account) | 3 | 88–125 ms | 659–852 ms |

Dev builds are slower: 144–441 ms (emulator), 144–320 ms (phone).

**Release APK size** (`assembleRelease`, no R8 minify, both ABIs): 71.4 MB in total, of which the arm64-v8a native libraries are 30.8 MB (stored uncompressed and page-aligned). Per arm64 slice:

| Component | Size |
|---|---|
| Crypto module: `libpingdost_crypto.so` (stripped) + `libuniffi_runtime_jsi.so` + `libubrn_jsi_player.so` | 0.98 + 0.51 + 0.21 = **1.70 MB** |
| SQLCipher build: OpenSSL `libcrypto.so` + `libexpo-sqlite.so` | 4.98 + 1.98 MB (delta vs plain SQLite below) |
| JS bundle (Hermes bytecode, shared by ABIs) | 3.19 MB |

**SQLCipher delta** (same build with `-Pexpo.sqlite.useSQLCipher=false`): the arm64 libraries shrink from 30.78 MB to 25.72 MB, so SQLCipher costs **5.06 MB per arm64 slice** (OpenSSL `libcrypto.so` 4.98 MB, plus 0.08 MB on `libexpo-sqlite.so`). The two-ABI APK drops from 71.4 MB to 60.9 MB. With per-ABI delivery (Play app bundle), a phone downloads about 5.1 MB for SQLCipher and 1.7 MB for the crypto module.

**Verdict for REQ §14.1:** SQLCipher stays unconditional. 5 MB is acceptable for the at-rest guarantee, and open + key check cost tens of milliseconds on a mid-range phone. Re-check on a low-end device in Phase 27.
