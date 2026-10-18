# Phase 16 — Web foundation + QR pairing

**Depends on:** 09, 10 · **Platforms:** web, server, Android

## Goal
The Vite web app exists with encrypted local storage and WASM crypto. A browser becomes an authorized linked device only by being scanned and approved by the primary phone, with a single-use, expiring, replay-proof pairing. The phone can revoke it.

## Read first
- REQ §6.2, §7.5 (web bullet), §13.1, §14.2, §19.5 (pairing and revocation bullets)
- ARCHITECTURE A5, A7

## Tasks
- [ ] **Create `apps/web`:** Vite + React + TS, Tailwind v4 + shadcn/ui (`ui-tokens`), React Router, TanStack Query, Zustand. Env `VITE_API_URL`, `VITE_WS_URL`. Strict CSP meta for dev, matching the prod headers planned in Phase 20.
- [ ] **WASM crypto:** lazy-load the `@pingdost/crypto` WASM provider; optionally run it in a Web Worker.
- [ ] **Encrypted storage foundation:**
  - Dexie DB `pingdost`;
  - a non-extractable AES-GCM `CryptoKey` generated once and stored in IndexedDB;
  - `encryptRecord` / `decryptRecord` helpers;
  - Olm account pickle stored encrypted;
  - a "browser storage is weaker than a phone keystore and can be evicted" note in the UI (REQ §7.5, §14.2).
- [ ] **Pairing protocol** (write an ADR). It uses only signatures + Olm, no new crypto. Flow:
  1. **Web** creates an Olm account → `POST /v1/pairing/requests` (unauthenticated, IP rate-limited) with its identity keys → gets `{pairingId, challenge, pollSecret, expiresAt}` (TTL `WEB_PAIRING_TTL_SECONDS`).
  2. The QR encodes `{v, pairingId, challenge, webCurve, webEd, origin}`, with no secrets that grant access alone. The web auto-refreshes the QR before expiry.
  3. **Phone** scans it (expo-camera) and shows browser details (user agent summary, time) for approval. It then calls `POST /v1/pairing/approve {pairingId, challenge, webKeys, signature by phone ed25519}`.
  4. **Server** atomically checks unexpired + unused + challenge match + approving device is the active primary. It registers the web device (`type=web`, `role=linked`, keys from the request) and marks the request consumed.
  5. **Web** polls `GET /v1/pairing/requests/:id` with `pollSecret`. Once approved, it signs a server nonce with its ed25519 key to receive device-bound tokens. It then uploads OTKs and the fallback key.
  6. The phone establishes an Olm session with the web device for later sync.
  - Replay, expiry, double-approval and wrong-challenge cases are all rejected. A cleanup job removes expired requests.
- [ ] **Phone UI:** "Linked devices" → "Link a browser" (scanner) → approval screen → list with name, last active (coarse) and **Revoke**.
- [ ] **Web UI:** pairing screen (QR + instructions + expiry countdown) → post-pairing app shell (empty conversations; chat comes in Phase 17). Settings → "Unlink this browser" wipes local data.
- [ ] **Revocation:** the server closes the web socket with `Revoked`; the web wipes IndexedDB and returns to the pairing screen. Contacts' clients see the device disappear from the directory and stop encrypting to it.
- [ ] **Tests:** server pairing integration (expired, replayed, wrong challenge, non-primary approver, double approve, poll without secret, rate limit); web unit tests for the record encryption helpers.

## Key files
`apps/web/*`, `apps/server/src/modules/pairing/*`, `apps/mobile/app/(app)/settings/devices/*`, `apps/web/src/{db/*,crypto/*,pairing/*}`

## Out of scope
Web chat (17); history sync (18).

## Done when
- The phone pairs a desktop Chrome and a second browser; both appear as linked; revoking one wipes it.
- Replayed or expired QR payloads are rejected (tests + a manual check).
- `pnpm lint typecheck test` and `pnpm --filter @pingdost/web build` pass.
