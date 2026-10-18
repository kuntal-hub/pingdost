# Phase 06 — Google sign-in, devices, key directory, profiles

**Depends on:** 05 · **Platforms:** Node server

## Goal
Add Google sign-in (ID-token verification), the device registry (one primary mobile + linked web devices), the public key directory with atomic one-time-key claims, device revocation, profiles, username lookup and Cloudinary avatar signing.

## Read first
- REQ §5.1, §6.1 (OAuth), §6.2, §15 (Device, Crypto directory, Account), §16.2
- ARCHITECTURE A2, A5
- The E2EE ADR from Phase 2

## Tasks
- [ ] **Google** `POST /v1/auth/google {idToken}`:
  - verify with `jose.createRemoteJWKSet('https://www.googleapis.com/oauth2/v3/certs')`;
  - `iss` ∈ {accounts.google.com, https://accounts.google.com}; `aud` ∈ `GOOGLE_CLIENT_IDS`; `exp`; `email_verified`.
  - **Linking policy** (write it in an ADR or the CHANGES log): auto-link to an existing account only when both emails are verified. Otherwise create a new user in `pending_username` status, which `POST /v1/auth/google/complete {username}` finishes.
  - Store `authProviders` + `googleSub`.
- [ ] **Devices** collection (REQ §16.2): `deviceId`, `userId`, `type` (android/ios/web), `role` (primary/linked), `name`, identity keys (curve25519, ed25519), `keyVersion`, `status` (active/revoked), `createdAt`, `revokedAt`, `lastSeenAt` (coarse, day granularity).
  - `POST /v1/devices/challenge` → a one-time nonce.
  - `POST /v1/devices` registers a device: the client signs `nonce || deviceId || identity keys` with its ed25519 key (proof of possession).
  - **Account identity key (ADR 0003):**
    - the primary phone creates one Ed25519 account identity key, kept separate from the device Olm account. Add a signing-key object to `crates/pingdost-crypto` and `CryptoProvider`, then regenerate bindings;
    - the users collection stores its public part;
    - each device record carries a **device certificate**: the account identity key's signature over `deviceId || curve25519 || ed25519`;
    - clients verify certificates before trusting a device; the server only stores them.
  - Uploaded one-time and fallback keys are signed by the device ed25519 key, so clients verify claimed keys too.
  - **Only one active primary:** if a primary already exists, return `PRIMARY_EXISTS`. The replacement flow comes in Phase 19.
  - Web devices are registered **only** via pairing (Phase 16); reject `type=web` here.
  - On registration, the session is bound to the device (`did` claim; a new token pair is issued).
- [ ] **Key directory** (`one_time_keys` collection, plus a fallback key on the device doc):
  - `POST /v1/keys/otks` uploads up to 100 OTKs per batch, plus the fallback key. Keys are signed and the signatures verified server-side.
  - `GET /v1/keys/users/:userId` lists active devices with identity keys + `keyVersion`.
  - `POST /v1/keys/claim {deviceIds[]}`: **atomically** takes one OTK per device (`findOneAndDelete`), or returns the fallback key when none remain. Rate-limited.
  - `GET /v1/keys/otks/count` for the owner. A WS `OtkLow` notice arrives in Phase 8.
- [ ] **Revocation:**
  - `GET /v1/devices` lists own devices;
  - `DELETE /v1/devices/:deviceId`: owner only; the primary can revoke linked devices. It revokes the device's sessions, deletes its OTKs, marks it revoked, bumps `keyVersion` on the account-level device list, and logs a security event. A WS `Revoked` push to the live socket comes in Phase 8 (leave a hook).
- [ ] **Profiles:**
  - `GET/PATCH /v1/me`: displayName, avatar, privacy prefs (receipts, typing, last-seen as booleans, used by clients).
  - `GET /v1/users/by-username/:username`: **exact match**, rate-limited per account and IP. Returns `{userId, username, displayName, avatarUrl}`.
- [ ] **Cloudinary** (optional feature; disabled if env is missing):
  - `POST /v1/me/avatar/sign` → signed upload params (folder `avatars/`, public_id `userId`, allowed formats, max bytes, overwrite). Check the current Cloudinary signing docs.
  - `PATCH /v1/me` stores the resulting `secure_url` after validating that it is under our cloud and folder.
- [ ] **Tests (integration):**
  - Google token validation with a **local mocked JWKS** (sign test tokens with jose): good token, wrong aud/iss, expired, and an unverified email that does not auto-link;
  - device registration signature checks; `PRIMARY_EXISTS`;
  - **claim race** (50 parallel claims never return a duplicate OTK; the fallback is returned after exhaustion);
  - revocation effects;
  - username lookup rate limit.

## Key files
`apps/server/src/modules/{auth/google.ts,device/*,keys/*,account/*}`, `packages/shared-types/src/{devices,keys,profile}.ts`

## Out of scope
Mobile UI (07), WS notifications (08), pairing (16), primary replacement (19).

## Done when
- `pnpm --filter @pingdost/server test:int` is green, including the claim race and mocked-JWKS tests.
- Mongo inspection shows only **public** keys stored.
- `pnpm lint typecheck test` passes.

## Handoff notes
Phase 7 needs Google OAuth client IDs. Write the console steps in PROGRESS: Google Cloud project → OAuth consent screen → Web client ID + Android client ID (package `com.pingdost.app` + debug keystore SHA-1). This is free.
