# @pingdost/crypto-native

`createNativeCryptoProvider()`: the `CryptoProvider` (from `@pingdost/crypto/core`) for React Native, built from `crates/pingdost-crypto` with uniffi-bindgen-react-native's `jsi2` flavour (ADR 0005).

- The app must list `@ubjs/react-native` as a **direct** dependency (the JSI player; autolinking reads only the app's `package.json`).
- `pnpm --filter @pingdost/crypto-native build:android` cross-compiles `libpingdost_crypto.so` for `arm64-v8a` and `x86_64` into `android/src/main/jniLibs/` (git-ignored) and regenerates `src/generated/` (committed; never hand-edit).
- Needs the Rust toolchain from `rust-toolchain.toml`, `cargo-ndk` and the Android NDK (see `CLAUDE.md`).
