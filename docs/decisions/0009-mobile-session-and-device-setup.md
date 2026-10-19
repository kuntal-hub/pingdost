# 0009 — Mobile session, device setup and device resume

- **Status:** Accepted
- **Date:** 2026-10-19
- **Phase:** 07
- **Approved by user:** n.a.

## Context
REQ §6.1 (sign-in), §6.2 (one primary phone with its own device identity; public keys only on the server), §7.5 (keys in OS secure storage), ARCHITECTURE A5, A6, A10, and ADR 0008 (registration, account identity key, key directory). Phase 7 needed:
- where the Android app keeps tokens and how it refreshes them;
- how the first sign-in turns into a registered primary device with published keys;
- what happens when the same phone logs out and back in. ADR 0008 rejected a second registration of the same device ID (`CONFLICT`), and a new session cannot be bound to an existing device any other way.

## Options considered
| Question | Option | Pros | Cons |
|---|---|---|---|
| Re-login on the same phone | **`POST /v1/devices` with the same device ID and identity keys resumes the device** (fresh nonce, proof of possession, certificate) | One client path for first and later sign-ins; proof that the caller holds the device key; no second primary | Registration now has two outcomes |
| | A separate `POST /v1/devices/:id/session` | Explicit | A second, near-identical route and client path |
| | A new device identity on every login | No server change | A new primary each time; peers see a new device and sessions break; `PRIMARY_EXISTS` |
| Token storage | **One `expo-secure-store` item: tokens, account summary, bound device ID** | Keystore-backed; one atomic write per rotation | Small size budget (≈1 KB used) |
| | Tokens in the SQLCipher DB | Unlimited size | Session restore waits for the DB and the crypto bootstrap |
| App state | **Zustand vanilla store with injected storage and API** | Unit-tested in Node; no React context plumbing | — |
| Protocol helpers on Hermes | **`@pingdost/protocol/signing` and `/ids` subpath exports** + a `crypto.getRandomValues` shim from expo-crypto | No protobuf descriptors load at start, so no `TextDecoder` polyfill yet | Two more package entry points |
| | Import the package root now | One entry point | Needs the Phase 10 `TextDecoder` polyfill now |

## Decision
1. **Device resume (server).**
   - `POST /v1/devices` whose `deviceId` already exists checks the nonce, the proof of possession and the certificate as usual. Then:
     - for an **active device of the caller's account with the same identity keys**, it binds the session (rotated refresh token, `did` claim), records `device_resume`, and returns the stored device;
     - nothing else changes: no new device, no `keyVersion` bump, and the published keys stay;
     - another account's ID, or other keys under that ID, is `CONFLICT`;
     - a revoked device is `DEVICE_REVOKED`.
   - The response status stays 201.
2. **Session (app).**
   - `pingdost.session.v1` in SecureStore holds `{ tokens, user, deviceId | null }`, validated with Zod on load (an unparsable value means signed out).
   - Each change is written before it is used: sign-in, the username step, the device binding and every refresh rotation.
   - Refresh is single-flight in the store and in the API client. Concurrent 401 `TOKEN_EXPIRED` requests share one refresh, then retry.
   - A 401/403 answer to the refresh signs out. Offline, 429 and 5xx keep the session.
   - Logout waits at most 3 s for `POST /v1/auth/logout`, forgets the tokens and signs out of the Google SDK.
   - **Local data stays**: the SQLCipher DB, the Olm account, the account identity key and the device record.
3. **Stages.** The root layout derives one stage from the session and guards route groups with `Stack.Protected`. The stages are:
   - `loading` (splash screen);
   - `signedOut` → `(auth)`;
   - `needsUsername` (Google `pending_username`) → `(auth)/google-username`;
   - `deviceSetup` (tokens not yet device-bound) → `setup`;
   - `ready` → `(app)`.
4. **Device setup** (`src/device/setup.ts`):
   1. The device record `{ deviceId, userId }` lives in `local_settings`. A record for another account stops with "this phone is set up for another account" (one account per phone for now).
   2. Load the account identity key secret from SecureStore (`pingdost.account-identity-key.v1`). If there is none and `/v1/me` already has an `accountIdentityKey`, stop with the `PRIMARY_EXISTS` screen; replacing the primary is Phase 19. Otherwise create the key and store the secret before registering.
   3. Only then is a new device record saved (before registering, so retries reuse the ID). An account that lives on another phone therefore never claims this one.
   4. Challenge → sign → register or resume → store the device-bound tokens.
      - `CHALLENGE_EXPIRED` retries.
      - `DEVICE_REVOKED` replaces the Olm account (`CryptoStore.resetAccount`), picks a new device ID and registers again.
      - `PRIMARY_EXISTS` or `IDENTITY_KEY_MISMATCH` shows the "active on another phone" screen.
5. **Keys** (`src/device/keys.ts`):
   - Keep 50 one-time keys on the server. Top up when it holds fewer than 20. Upload at most 100 per request.
   - The fallback key is generated only when the directory shows none for this device. That is checked at setup and on every app start, so an interrupted first upload heals.
   - The account is pickled before an upload (a crash re-sends the same key IDs, which the server accepts idempotently) and again after `markKeysAsPublished`.
   - Setup and top-ups share one queue because both change the Olm account.
6. **Config and dev cleartext.**
   - `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_WS_URL` and the optional `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (`@pingdost/config/public`) come from `apps/mobile/.env`.
   - Cleartext HTTP stays allowed only by Expo's debug manifest; release builds are HTTPS-only. No extra plugin is needed.
7. **Google Sign-In:** `@react-native-google-signin/google-signin` 16.1.5 (MIT; the free "Original" API). It needs no config plugin on Android without Firebase: the plugin without options would add `google-services`, and with options it only edits the iOS `Info.plist` (Phase 28 adds it with `iosUrlScheme`).
8. **Permissions:** expo-image-picker uses the system photo picker; its plugin blocks `CAMERA` and `RECORD_AUDIO`. Phase 16 re-adds camera for QR pairing.

## Consequences
- New security event type `device_resume`. ADR 0008 point 3 now has a resume case.
- "Remove data from this phone" moves to Phase 19: wiping the identity key without a backup would lock the account out of every phone.
- One phone holds one account. Switching accounts needs that removal (Phase 19).
- Phase 8 calls `replenishKeys()` on the gateway's low-keys notice; Phase 10 adds `TextDecoder` and can then import the protocol package root; Phase 11 honours the cached privacy preferences; Phase 28 adds the Google plugin's `iosUrlScheme`.

## Evidence
- `pnpm --filter @pingdost/server test:int`: device resume (same device, no second primary, unchanged `keyVersion`, one `device_resume` event), another account or other keys under the ID (`CONFLICT`), and a revoked device (`DEVICE_REVOKED`).
- `pnpm --filter @pingdost/mobile test` runs device setup against an in-memory server with the WASM vodozemac provider. It covers:
  - signatures checked like the server;
  - first setup, resume, `primary_exists`, `other_account` and the revoked-device restart;
  - top-ups, and re-sending after a failed upload;
  - the auth store: single-flight refresh, sign-out rules, logout racing a refresh, a hung logout, and the API client retrying after one shared refresh.
- Package docs checked 2026-10-19: react-native-google-signin.github.io (Expo setup, Original API); npm versions and licenses of zustand 5.0.15 (MIT), google-signin 16.1.5 (MIT), expo-image-picker 58.0.10, expo-network 58.0.3 and expo-symbols 58.0.4 (MIT; `NativeTabs` `md` icons on Android need it).
- Emulator (Pixel_8_API_35, dev build, local server), 2026-10-19:
  - register → OTP from Mailpit → device setup → tabs;
  - the profile name and privacy toggles saved in Mongo;
  - kill and relaunch kept the session and identity key;
  - logout → login resumed the same device: one primary, unchanged `keyVersion`, 50 one-time keys, a `device_resume` event;
  - an account whose primary is elsewhere showed the `PRIMARY_EXISTS` screen;
  - light and dark themes both render.
