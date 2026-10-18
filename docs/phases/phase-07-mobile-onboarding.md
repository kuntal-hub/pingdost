# Phase 07 — Mobile onboarding & account UI (Android)

**Depends on:** 03, 06 · **Platforms:** Android

## Goal
A real phone can register, verify by email, log in (password or Google), create its device crypto identity, register as the primary device with public keys, and manage its profile and devices.

## Read first
- REQ §6.1, §6.2, §7.5
- ARCHITECTURE A6, A10
- **Load skill `expo:expo-overview`** (then `expo-router`, `expo-native-ui` / `expo-design-system` as it suggests)

## Tasks
- [ ] **Route structure:**
  - `(auth)`: welcome, register, verify-otp, login, forgot-password, reset-password, google-username;
  - `(app)`: tabs Chats (placeholder) · Settings.
  - Root layout gate on auth state.
- [ ] **API wiring:** `@pingdost/api-client` with base URL from `EXPO_PUBLIC_API_URL`. Dev cleartext to the LAN IP is allowed in dev builds only (expo-build-properties or a config plugin; never in release).
- [ ] **Auth store:**
  - Zustand store; tokens in `expo-secure-store`;
  - single-flight refresh on 401;
  - logout clears the tokens. Local history is kept unless the user chooses "remove data".
- [ ] **Forms** validated with the shared Zod schemas. Clear server error mapping, OTP resend countdown, and loading, offline and error states.
- [ ] **Google Sign-In:** `@react-native-google-signin/google-signin` (check the free/original package and its Expo config plugin). Obtain the ID token and call `/v1/auth/google`; handle the `pending_username` step. Write the user's console setup steps (from the Phase 6 notes) and use env for the client IDs.
- [ ] **Device setup after first auth:**
  1. Load or create the Olm account (Phase 3 store).
  2. Get the device challenge and sign it.
  3. `POST /v1/devices` as primary.
  4. Upload 50 OTKs + the fallback key, then mark them published.
  5. A replenish routine tops up when the count falls below 20 (checked on app start; the WS notice arrives in Phase 8).
  - Handle `PRIMARY_EXISTS` with a clear screen ("This account is active on another phone"; replacement comes in Phase 19).
- [ ] **Settings:**
  - Profile: display name; avatar via expo-image-picker → Cloudinary signed upload → PATCH. Hide it if Cloudinary is disabled.
  - Privacy: receipts, typing and last-seen toggles, stored server-side and locally.
  - Devices list with revoke for linked devices (none yet).
  - "About privacy" screen with the honest REQ §1 / §5.4 wording.
  - Logout.
- [ ] **Theme:** light/dark via `ui-tokens`; basic accessibility (labels, font scaling).
- [ ] **Tests:** unit tests for the auth store/refresh logic and form schemas (Vitest or jest-expo, whichever Expo recommends now).

## Key files
`apps/mobile/app/(auth)/*`, `apps/mobile/app/(app)/*`, `apps/mobile/src/{auth/*,api/*,device/*,settings/*}`

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
