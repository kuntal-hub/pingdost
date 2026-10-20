# 0019 — Web foundation and QR pairing

- **Status:** Accepted
- **Date:** 2026-10-20
- **Phase:** 16
- **Approved by user:** n.a. (follows ADR 0003/0008; no new cryptography)

## Context
A browser may join an account only as a linked device that the primary phone approves (REQ §6.2, §13.1; ARCHITECTURE A7: no password or Google login on the web). Pairing must be single-use, quick to expire, replay-proof and auditable (REQ §6.2, §19.5). It must reuse only signatures and Olm keys (REQ §7.2). Browser storage is weaker than a phone keystore and the UI must say so (REQ §7.5, §14.2).

## Options considered
| Option | Pros | Cons |
|---|---|---|
| **Phone-approved request + browser proof of possession** (below) | Signatures only; the server never holds a secret that grants access; the QR alone does nothing | Three round trips |
| The QR carries a one-time login token | Simplest | Whoever sees or photographs the QR first gets in; nothing ties the session to the browser's keys |
| A PAKE or a direct phone↔browser channel | No server trust for the key exchange | New cryptography (REQ §7.2); WebRTC/BLE are not available on every browser |

## Decision
1. **Flow** (`apps/server/src/modules/pairing`, `/v1/pairing/*`):
   1. The **browser** creates an Olm account and calls `POST /v1/pairing/requests {identityKeys, name}` (unauthenticated, IP rate-limited). It gets `{pairingId, challenge (32 random bytes), pollSecret (32), expiresAt}`, with a TTL of `WEB_PAIRING_TTL_SECONDS` (120 s). The server stores only an HMAC of the poll secret.
   2. **QR code** `pingdost-pair:v1:<base64url JSON {p, c, k, e, o}>` holds the pairing ID, challenge, the browser's curve25519 and ed25519 keys, and its origin (`@pingdost/protocol` `encodePairingQr` / `parsePairingQr`, strict). It holds no secret that grants access. The browser renews it, with the same keys, 10 s before it expires.
   3. The **phone** scans it. `POST /v1/pairing/inspect {pairingId, challenge}` (active primary only) returns the name, user agent and times, and the phone refuses if those keys differ from the QR's. On approval it calls `POST /v1/pairing/approve`. It picks the browser's device ID (UUIDv7), signs `pairingApprovalMessage(pairingId, challenge, deviceId, webKeys)` (new context `pingdost/pairing-approval/v1`) with its device key, and signs the device certificate (`deviceCertificateMessage(deviceId, webKeys)`, ADR 0008) with the account identity key. Contacts therefore trust the browser without a safety-number change.
   4. The **server** checks that the caller is the account's active primary, and that the request is pending, unexpired and has a matching challenge (constant-time). The keys must equal the request's, both signatures must verify, and the device ID must be unused. Then one conditional update marks the request approved and stores a fresh nonce. It also extends the deadline to at least 60 s, so the browser can finish.
   5. The **browser** polls `GET /v1/pairing/requests/:id` with the header `x-pairing-secret` (never in the URL) every 2 s. Once approved, it signs `deviceRegistrationMessage(nonce, deviceId, keys)` with its own key and calls `POST …/complete`. The server checks the signature and that the approving phone is still the active primary. A conditional update then marks the request completed, and only then is the `devices` row created (`platform: web`, `role: linked`). The user's `keyVersion` goes up, a session bound to the device is opened (`AuthService.linkedDeviceSession`), and `device_link` is audited (`pairing_approve` was audited at approval).
   6. The browser publishes its one-time and fallback keys. The phone refetches its own directory, so new messages are encrypted to the browser (its Olm session opens with the first message; history sync is Phase 18).
2. **Refusals:**
   - wrong challenge, unknown ID or wrong poll secret: `PAIRING_NOT_FOUND`;
   - expired: `PAIRING_EXPIRED` (polling reads `expired`);
   - a second approval or completion, or polling after completion: `PAIRING_ALREADY_USED`;
   - a non-primary or device-less caller: `FORBIDDEN` / `DEVICE_REQUIRED`;
   - bad signatures: `INVALID_SIGNATURE`; swapped keys: `VALIDATION_FAILED`;
   - completing before approval: `CONFLICT`.

   Requests are deleted by a Mongo TTL index on `expiresAt` (the cleanup job). The rate limits are `pairingCreate` (30 / 15 min per IP), `pairingPoll`, `pairingComplete`, `pairingInspect` and `pairingApprove`.
3. **Revocation** reuses `DELETE /v1/devices/:id` (the phone, or the browser itself). The gateway pushes `Revoked`; every tab of that browser wipes IndexedDB and returns to pairing (BroadcastChannel). A refresh the server refuses has the same effect.
4. **CORS:** `@fastify/cors` 11.3.1 allows only `WEB_ORIGIN`, with the `x-pairing-secret` header.
5. **Web app** (`apps/web`):
   - Vite 8, React 19.3, React Router 8, TanStack Query 5, Zustand 5, Tailwind v4 with shadcn-style components on `@pingdost/ui-tokens`. The theme is applied through the CSSOM, never an inline `<style>`.
   - **CSP** (meta, from `vite.config.ts`): `script-src 'self' 'wasm-unsafe-eval'`, `style-src 'self'`, `connect-src` limited to the API and WS origins, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`. `vite dev` adds a fixed dev nonce for Vite's injected tags. Phase 20 sends the same policy as a header, plus `frame-ancestors 'none'`.
   - **WASM crypto** loads lazily as its own chunk. There is no Web Worker yet: the provider's calls are short.
   - **Storage:** the Dexie database `pingdost`. Table `keys` holds a non-extractable AES-256-GCM `CryptoKey`, which IndexedDB stores without revealing it. Table `records` holds values sealed with it (`encryptRecord`/`decryptRecord`: fresh 96-bit IV; the AAD is `pingdost/web-record/v1\0<record name>`). The device record, tokens, Olm account pickle and its pickle key are all sealed. Nothing is saved until linking has finished.
   - **One connection per browser:** the tab holding the Web Lock `pingdost-connection` opens the gateway socket; Phase 17 makes it the engine's leader.
6. **Dev tooling:** `pnpm --filter @pingdost/sim-client phone -- --code '<code>' [--revoke-after N]` approves a browser as a simulated phone. `vite dev` shows the code as text under the QR. `SimClient.linkedDevice` now links through this flow, and the server tests' out-of-band `bindLinkedDevice` is gone.

## Consequences
- Phase 17 builds the engine store and leader tab on this database and lock. Phase 18 sync runs over the Olm session between phone and browser.
- Phase 20 must serve the CSP as a header (`frame-ancestors 'none'`, HSTS) from Cloudflare Pages.
- A browser approved but never completed leaves nothing behind: no device row exists until its proof of possession.
- The browser's main chunk is about 700 kB (the protocol and engine code); split it when the engine arrives (Phase 17).

## Evidence
- `apps/server/test/pairing.int.test.ts` (8 tests): the full flow with real keys, expiry, wrong challenge, no or wrong secret, a guessed ID, completing early, a non-primary or device-less approver, double approval (also across accounts), a bad certificate, signature or keys, a failed proof of possession, revocation (refresh refused, gone from the directory), CORS, and the rate limit.
- The engine and groups integration scenarios with linked devices now pair for real (25 tests).
- Web unit tests: vault round trips, tampering, AAD binding, the non-extractable key, and persistence; the pairing loop renews the code with the same keys, proves possession, survives offline polls, and stops when asked.
- Mobile unit tests: code parsing, the key-mismatch refusal, and signatures that verify.
- Browser check 2026-10-20 (Chrome, Windows, `vite dev` against the local API; the phone simulated with the CLI above):
  - the QR rendered under the CSP and the WASM loaded;
  - after approval the app shell showed "Connected";
  - IndexedDB held four sealed records and a non-extractable key, with no readable tokens or pickle;
  - revoking from the "phone" wiped the browser and returned it to pairing, with the notice.
