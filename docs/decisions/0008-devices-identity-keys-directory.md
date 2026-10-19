# 0008 — Devices, account identity key, key directory and Google linking

- **Status:** Accepted
- **Date:** 2026-10-19
- **Phase:** 06
- **Approved by user:** n.a.

## Context
REQ §6.2 (one primary phone, linked browsers, independent device identities, public keys only on the server), §15 (device and crypto directory modules) and §16.2, plus ADR 0003 (an account identity key certifies devices; clients cache fallback keys for offline first contact). Phase 6 had to fix the signed formats, the registration and revocation rules, the directory contents and the Google account-linking policy.

## Options considered
| Question | Option | Pros | Cons |
|---|---|---|---|
| Signed bytes | **Context string + NUL, then fixed-length fields** (`@pingdost/protocol` `signing.ts`) | Unambiguous; a signature cannot be replayed for another purpose | Not the Matrix canonical-JSON format (we do not federate) |
| | Raw `nonce ‖ deviceId ‖ keys` (as first sketched) | Shortest | Signatures portable across purposes |
| Server-side Ed25519 | **`node:crypto`** | No WASM in the server bundle | Not vodozemac's `verify_strict`; clients still verify strictly |
| | The WASM `CryptoProvider` | Same code as clients | The `.wasm` asset would need bundling |
| Unverified Google email | **Reject (`GOOGLE_EMAIL_UNVERIFIED`)** | Every account keeps a verified email (REQ §16.1) | Rare Google accounts without a verified email cannot sign in |
| | Create an unlinked account | Never blocks | Duplicate email impossible (unique index) |

## Decision
1. **Account identity key.**
   - `crates/pingdost-crypto` gains a `SigningKey` object (vodozemac `Ed25519SecretKey`: new, `from_secret`, `public_key`, `sign`, `export_secret`); `CryptoProvider` gains `createSigningKey()` and `restoreSigningKey()`. Conformance scenario `idk` covers it.
   - The primary phone keeps the secret in secure storage, and only the public key goes to the server (`users.accountIdentityKey`, set once by the first primary device; a different key afterwards is `IDENTITY_KEY_MISMATCH`).
2. **Signed statements**, each `utf8(context) ‖ 0x00 ‖ fields`:
   - `pingdost/device-certificate/v1`: deviceId (16) ‖ curve25519 (32) ‖ ed25519 (32), signed by the account identity key;
   - `pingdost/device-registration/v1`: nonce (32) ‖ deviceId ‖ curve25519 ‖ ed25519, signed by the device's ed25519 key (proof of possession);
   - `pingdost/one-time-key/v1` and `pingdost/fallback-key/v1`: deviceId ‖ keyId length (1) ‖ keyId ‖ publicKey (32), signed by the device.
3. **Registration** (`POST /v1/devices/challenge`, then `POST /v1/devices`).
   - Only active accounts can register (`USERNAME_REQUIRED` for Google accounts without one). The nonce is 32 random bytes, valid for 5 minutes and single-use (even after a failed attempt).
   - The server checks the proof of possession and the certificate. Phones register as `primary`; web devices only through pairing (Phase 16). A partial unique index allows one active primary per account (`PRIMARY_EXISTS`).
   - The session is bound to the device: its refresh token rotates and the new access token carries `did`. Registering on an already-bound session is a `CONFLICT`.
   - `users.keyVersion` is bumped on every registration and revocation; devices start at `keyVersion` 1.
4. **Revocation** (`DELETE /v1/devices/:id`).
   - The caller needs a device-bound session (`DEVICE_REQUIRED`). The primary may revoke linked devices, and any device may revoke itself. Other users' devices are `DEVICE_NOT_FOUND`.
   - Effects: status `revoked`, fallback key cleared, one-time keys deleted, the device's sessions revoked, `keyVersion` bumped, a `device_revoke` event, then the `onDeviceRevoked` hooks (Phase 8 pushes `Revoked`).
   - Replacing a lost primary from another device is the recovery flow (Phase 19). After the primary revokes itself, a new phone certified by the same identity key may register.
5. **Key directory.**
   - Uploads need a device-bound session. Every key must carry a valid device signature, otherwise the whole batch is rejected. At most 200 unclaimed one-time keys are kept per device, and re-uploads are idempotent.
   - `GET /v1/keys/users/:id` returns the account identity key, `keyVersion`, and the active devices with their certificate and signed fallback key. Clients verify the certificate and the key signatures before encrypting.
   - `POST /v1/keys/claim` takes one key per active device with `findOneAndDelete` (oldest first), or the fallback key. Unknown and revoked devices are omitted. Per-account budget: 500 per hour.
6. **Google linking.**
   - A known `googleSub` signs in.
   - Otherwise the Google email must be verified; an unverified one is rejected (`GOOGLE_EMAIL_UNVERIFIED`).
   - A verified Google email that matches a verified account links to it (`google_link` event). An existing link to another Google `sub` is `EMAIL_TAKEN`.
   - Anything else creates a `pending_username` account (an unverified password registration for that email is replaced). `POST /v1/auth/google/complete` then sets the username.
   - Without `GOOGLE_CLIENT_IDS` the endpoint answers 503.
7. **Profiles.**
   - `PATCH /v1/me` (display name, privacy, avatar).
   - Exact username lookup returns active users only. It is limited per IP (route) and per account (30 per 15 minutes).
   - Avatars:
     - `POST /v1/me/avatar/sign` signs `public_id=avatars/<userId>`, `overwrite`, `invalidate`, `allowed_formats=jpg,jpeg,png,webp` and `transformation=c_limit,h_512,w_512` with SHA-256.
     - `avatarUrl` must be that asset's `secure_url` in our cloud. The client enforces the 5 MB upload limit.
     - Without Cloudinary configuration this answers 503.
8. **Last seen** is stored at UTC-day granularity, with at most one write per device per day.

## Consequences
- New error codes: `GOOGLE_EMAIL_UNVERIFIED`, `DEVICE_REQUIRED`, `IDENTITY_KEY_MISMATCH`. New collections: `devices`, `device_challenges` (TTL) and `one_time_keys`.
- Phase 7 creates the identity key, registers the primary device and publishes keys. Phase 9 verifies certificates and key signatures. Phase 16 creates linked devices with certificates from the primary. Phase 19 restores the identity key.
- The Cloudinary signature was checked against the documented algorithm, but not yet against a real account.

## Evidence
- `pnpm --filter @pingdost/server test:int`: 71 tests. They cover mocked-JWKS Google tokens, registration signatures and nonces, `PRIMARY_EXISTS`, revocation effects, and a claim race (50 parallel claims, 20 unique one-time keys, then 30 fallbacks). They also cover lookup limits, and Mongo docs containing public keys but no identity-key secret.
- `cargo test`: the signing key restores and signs deterministically. Crypto conformance on WASM includes `idk`. The native bindings were regenerated with NDK 27.1.
- Cloudinary signing checked 2026-10-19: cloudinary.com/documentation/authentication_signatures.
