# Phase 07 — Mobile onboarding & account UI (Android)

**Depends on:** 03, 06 · **Platforms:** Android

## Goal
A real phone can register, verify by email, log in (password or Google), create its device crypto identity, register as the primary device with public keys, and manage its profile and devices.

## Read first
- REQ §6.1, §6.2, §7.5
- ARCHITECTURE A6, A10
- **Load skill `expo:expo-overview`** (then `expo-router`, `expo-native-ui` / `expo-design-system` as it suggests)

## Tasks
- [x] **Route structure:**
  - `(auth)`: welcome, register, verify-otp, login, forgot-password, reset-password, google-username;
  - `(app)`: tabs Chats (placeholder) · Settings.
  - Root layout gate on auth state.
- [x] **API wiring:** `@pingdost/api-client` with base URL from `EXPO_PUBLIC_API_URL`. Dev cleartext to the LAN IP is allowed in dev builds only (expo-build-properties or a config plugin; never in release).
- [x] **Auth store:**
  - Zustand store; tokens in `expo-secure-store`;
  - single-flight refresh on 401;
  - logout clears the tokens. Local history is kept unless the user chooses "remove data".
- [x] **Forms** validated with the shared Zod schemas. Clear server error mapping, OTP resend countdown, and loading, offline and error states.
- [x] **Google Sign-In:** `@react-native-google-signin/google-signin` (check the free/original package and its Expo config plugin). Obtain the ID token and call `/v1/auth/google`; handle the `pending_username` step. Write the user's console setup steps (from the Phase 6 notes) and use env for the client IDs.
- [x] **Device setup after first auth:**
  1. Load or create the Olm account (Phase 3 store).
  2. Get the device challenge and sign it.
  3. `POST /v1/devices` as primary.
  4. Upload 50 OTKs + the fallback key, then mark them published.
  5. A replenish routine tops up when the count falls below 20 (checked on app start; the WS notice arrives in Phase 8).
  - Handle `PRIMARY_EXISTS` with a clear screen ("This account is active on another phone"; replacement comes in Phase 19).
- [x] **Settings:**
  - Profile: display name; avatar via expo-image-picker → Cloudinary signed upload → PATCH. Hide it if Cloudinary is disabled.
  - Privacy: receipts, typing and last-seen toggles, stored server-side and locally.
  - Devices list with revoke for linked devices (none yet).
  - "About privacy" screen with the honest REQ §1 / §5.4 wording.
  - Logout.
- [x] **Theme:** light/dark via `ui-tokens`; basic accessibility (labels, font scaling).
- [x] **Tests:** unit tests for the auth store/refresh logic and form schemas (Vitest or jest-expo, whichever Expo recommends now).

**Status (2026-10-19): done (ADR 0009).** Done-when steps 1–6 pass on the x86_64 emulator against the local server. Still pending, by user action:
- a run on the real phone;
- Google sign-in (needs client IDs);
- avatars (needs Cloudinary).

"Remove data" moved to Phase 19 (see its handoff notes).

## Key files
`apps/mobile/src/app/(auth)/*`, `apps/mobile/src/app/(app)/*`, `apps/mobile/src/{auth/*,api/*,device/*,settings/*}`

## Out of scope
Chat UI (10); pairing the web (16).

## Done when
- **On a real phone against the local server:**
  1. Register.
  2. Verify with the OTP read from Mailpit.
  3. Land in the app.
  4. The device and public keys appear in Mongo; no private material is present.
  5. Kill and relaunch: still logged in, same identity.
  6. Log out, log back in: the device is recognized and there is no duplicate primary.
- Google sign-in works once the user has created client IDs. Otherwise mark it pending in PROGRESS with the exact steps.
- `pnpm lint typecheck test` passes.

## Handoff notes
**From Phase 3:**
- Routes live in `apps/mobile/src/app/` (Expo Router `src/` layout); screen bodies in `src/screens/`. Replace the Phase 3 home screen (`src/screens/home.tsx`); keep `(dev)/crypto` dev-only.
- Crypto: `getCryptoContext()` (`src/crypto/bootstrap.ts`) opens the SQLCipher DB and loads or creates the Olm account. Call `store.saveAccount()` after every account change (one-time keys generated or published, inbound sessions created).
- Theme: `ThemeRoot` + NativeWind classes such as `bg-surface text-foreground` (tokens in `@pingdost/ui-tokens`). Vitest already runs `src/**/*.test.ts` for platform-independent modules.
- Debug builds allow cleartext HTTP (Expo's debug manifest), release builds do not.

**From Phase 6 (ADR 0008):**
- First primary registration:
  1. `createSigningKey()` → keep `exportSecret()` in SecureStore (never upload it);
  2. `devicesApi.challenge()`;
  3. sign `deviceRegistrationMessage(nonce, deviceId, keys)` with the Olm account and `deviceCertificateMessage(deviceId, keys)` with the identity key (`@pingdost/protocol`);
  4. `devicesApi.register({..., accountIdentityKey})` → **store the returned token pair** (the old refresh token is now rotated out).
- Then publish keys: one-time keys and the fallback key signed with `signedKeyMessage('one_time' | 'fallback', ...)` via `keysApi.upload`, followed by `markKeysAsPublished()`.
- Google sign-in can return `pending_username`: show the username step and call `authApi.completeGoogle`. Device registration answers `USERNAME_REQUIRED` until then.
- Avatars: `accountApi.signAvatarUpload()` → POST the file plus `fields` to `uploadUrl` (multipart) → `accountApi.updateMe({ avatarUrl: secure_url })`. The SHA-256 signature is untested against a real Cloudinary account: verify it here if avatars are enabled.