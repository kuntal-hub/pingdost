# PingDost threat model

Status: Phase 27 (2026-11-02), Android + web. iOS (Phases 28–30) will add APNs, CallKit and iOS storage; revisit then. Decisions referenced: ARCHITECTURE A5, A10; ADRs 0003–0030.

## 1. What we protect (assets)

| Asset | Where it lives | Protection |
|---|---|---|
| Message and call content | Devices only (plaintext); servers, relays and push see ciphertext | Olm/Megolm via vodozemac (ADR 0003); DTLS-SRTP for media (ADR 0028) |
| Attachment content and keys | Devices; ciphertext staged on the VPS disk until acknowledged | XChaCha20-Poly1305 STREAM, key only inside the E2EE manifest (ADR 0004, 0017) |
| Device private keys (Olm account, Ed25519) | Phone: SQLCipher DB, key in Android Keystore-backed SecureStore; browser: IndexedDB sealed with a non-extractable WebCrypto key | Never leave the device (ADR 0005, 0019, 0020) |
| Account identity key | Primary phone (SecureStore), backups | Signs device certificates (ADR 0008) |
| Recovery phrase / backups | Shown once; phrase bytes in SecureStore; `.pdbk` files wherever the user keeps them | Argon2id + XChaCha20-Poly1305 (ADR 0022) |
| Local history | Device DBs | SQLCipher (phone); vault-sealed Dexie (web) |
| Credentials | Server: Argon2id password hashes, HMAC-peppered OTP and refresh-token hashes | ADR 0007 |
| Metadata | Server: accounts, devices, public keys, routing data, short-lived security events | Minimised and time-limited (REQ §5, retention audit) |
| Server secrets | VPS `.env`, GitHub `staging` environment | Never in client bundles (A10); rotation runbook |

## 2. Actors

| Actor | Capability | Goal |
|---|---|---|
| Network attacker | Reads/changes traffic between client and server, on Wi-Fi or ISP | Read messages, hijack sessions |
| Honest-but-curious operator / compromised server | Full control of the VPS, Mongo, Valkey, Caddy, coturn | Read content, map the social graph, inject devices |
| Malicious relay phone (mesh) | Runs a modified app, carries and drops packets | Read, alter, track, or exhaust others' storage |
| Phone in Bluetooth range | Passive or active BLE peer | Track a phone, spam it |
| Malicious contact or group member | Valid account, sends anything | Spam, harass, exhaust quotas, deanonymise |
| Abuser at scale | Many accounts/IPs | Fill storage, run up costs, brute-force logins |
| Thief / person with the unlocked phone or browser | Physical access | Read history, impersonate |
| Push providers (Google FCM, browser push services) | See push metadata | Learn timing and device addresses |
| Supply chain | A compromised dependency or CI action | Exfiltrate keys or ship a backdoor |

## 3. Trust boundaries

```
 phone (SQLCipher, Keystore) ──TLS──► Caddy ─► API/gateway ─► Valkey (staged ciphertext, ≤ stage + grace)
   │  ▲                                  │            └──────► Atlas M0 (metadata, migrated ciphertext ≤ 14 d)
   │  └─ QR + approve ── browser (IndexedDB vault)   └──────► VPS disk (staged attachment ciphertext)
   ├─ BLE GATT ── relay phones (mesh, signed packets, routing tokens)
   ├─ FCM ── Google (content-free wakes)          browser ── Web Push service (content-free)
   └─ WebRTC (DTLS-SRTP) ── peer, or ── coturn (relays encrypted media)
```

Everything right of "TLS" and every relay, push service and TURN server is **outside** the content trust boundary: it handles only ciphertext and the metadata listed in §5.

## 4. STRIDE-lite

| # | Threat | Where | Mitigation | Residual |
|---|---|---|---|---|
| S1 | Spoofed sender device on the gateway | WS `Send` | Device-bound access tokens; `sender_device_id` must equal the socket's device (gateway test "rejects spoofed senders") | — |
| S2 | Server injects a device into a user's account | Key directory | Device certificates signed by the account identity key; clients verify; safety numbers (ADR 0008, 0012) | Users who never compare safety numbers trust the first key they see (TOFU) |
| S3 | Server/admin adds a member to a group | Groups | Membership changes are E2EE controls from admins; members see joins (ADR 0016) | An admin together with a compromised server can add members; documented |
| S4 | Replayed or expired QR pairing | Pairing | One-time challenge, 2-minute expiry, phone approval, key proof (pairing tests) | — |
| S5 | Stolen refresh token reused | Auth | Rotation with reuse detection revokes the session (auth-session test) | Until reuse is detected the thief has the session |
| T1 | Envelope altered in transit or by a relay | Server, mesh | AEAD in Olm/Megolm; mesh packets signed by the origin device (mesh tamper test) | — |
| T2 | Attachment ciphertext swapped | Staging | Whole-ciphertext SHA-256 in the E2EE manifest; per-chunk tags | — |
| T3 | Malicious dependency changes crypto | Supply chain | Pinned versions, lockfiles, CI audits, license gate, cargo-deny sources, no custom crypto | A compromised maintainer of a pinned version is not detected by audits |
| R1 | A user denies sending a message | — | Not a goal: Olm is deniable by design | — |
| I1 | Server reads content | All storage | E2EE; inspectors see ciphertext only (engine test 8) | — |
| I2 | Server learns the social graph and timing | Routing | Minimal records, TTLs, no permanent history, presence in memory only | **Metadata is visible**: sender/recipient device IDs, timing, sizes (REQ §5.3). Not a zero-metadata system |
| I3 | Logs leak secrets | Server, apps | Redacting logger; request logs without bodies or IPs; log-hygiene tests; engine test 10 scans debug logs | coturn's problem lines can name a user ID (ADR 0028) |
| I4 | Relays learn who talks to whom | Mesh | Daily routing tokens, no device IDs in mesh envelopes | Tokens are announced for the whole TTL window; group traffic shows group and Megolm session IDs (ADR 0025) |
| I5 | Phones in range recognise a phone | Nearby | Off by default; explained on the screen | The device's Ed25519 public key is stable and visible to linked PingDost phones (ADR 0024, 0026) |
| I6 | Push providers learn activity | FCM, Web Push | Payloads are content-free (`{"t":"wake"}`, `{"t":"call"}`) | Google and push services see timing and that PingDost woke a device |
| I7 | Browser storage read by malware or another user | Web | Non-extractable vault key, IndexedDB per origin | A compromised browser profile or an XSS reads everything the tab can; strict CSP reduces XSS risk. Browser storage is weaker than the phone's |
| I8 | Lost phone without backup | Devices | Backups with a recovery phrase | History is unrecoverable without a backup or another linked device; the server cannot restore it |
| I9 | Build-machine paths in binaries | WASM | Remapped (ADR 0030) | Android `.so` still carries them (low) |
| I10 | Temporary ciphertext outlives its limit | Valkey AOF, VPS disk, provider snapshots | TTLs, janitor, retention audit, backups exclude delivery data | Deleted ciphertext can stay in Valkey's append-only file until its next rewrite and in hosting-provider snapshots; still end-to-end encrypted |
| D1 | WS flood | Gateway | Per-socket frame, typing, ephemeral and in-flight limits (abuse test) | Many sockets from many IPs: per-IP upgrade limit (60/15 min) only |
| D2 | Never-delivered queue growth | Mailbox | Per-sender daily budgets (ADR 0030), 14-day expiry, alerts | Many accounts; Atlas M0 is 512 MB |
| D3 | Mass large uploads | Attachments | Per-user 1 GiB and total 30 GiB quotas, 100 MB limit, expiry | — |
| D4 | OTP / login brute force | Auth | Attempt limits, lockouts, per-address and per-IP budgets | — |
| D5 | Mesh spam / storage exhaustion | Relay phones | Opt-in, per-origin quotas, rate limits, 250 MB cap, TTL and hop limits (mesh tests) | Origin tokens are self-chosen; delivered-ID lists are unauthenticated (ADR 0025) |
| D6 | TURN abuse (open relay, SSRF) | coturn | Time-limited HMAC credentials, private ranges denied, quotas, bandwidth cap (ADR 0028) | Bandwidth costs if credentials leak within their TTL |
| E1 | Revoked browser keeps access | Devices | Sessions revoked, gateway closes the socket, clients stop encrypting to it (pairing, engine test 7) | Messages it already decrypted stay on it |
| E2 | XSS in the web app | Web | No inline script/style, strict CSP, `frame-ancestors 'none'` (security-headers test) | A malicious extension is out of scope |

## 5. Data each third party sees

| Party | Sees |
|---|---|
| PingDost server | Account (username, email, password hash), devices and public keys, who sends envelopes to which device and when, sizes, staged ciphertext until delivery or 14 days, group membership (server routing), blocks, abuse reports with only the messages the reporter attached, hashed-IP security events (90 days), call invites to offline devices (time only, 15 s in memory) |
| Atlas (MongoDB Inc.) | The server's Mongo data above (encrypted at rest by Atlas) |
| Hostinger | The VPS disk: staged ciphertext, Valkey data, backups of account metadata, logs |
| Cloudflare | Web app requests (static files), DNS |
| Google (FCM) | Device push tokens, wake timing; Android vitals crash data if users opted in |
| Browser push services | Web Push subscription endpoint, wake timing |
| coturn (on the VPS) | Peer IP addresses and relayed encrypted media volume; TURN usernames carry the user ID |
| Relay phones | Routing tokens, packet IDs, times, hop budget, copies, sizes, crypto type (and group/Megolm session IDs for groups) |
| Phones in BLE range | That a PingDost phone is near; once linked, its public device key |
| Email provider | The address and the OTP email |

## 6. Cryptographic limits to state honestly
- **Megolm has weak post-compromise security**: a session key that leaks lets the holder read later messages of that sender's session until it rotates (rotation on membership change, ADR 0016). Olm (1:1) heals after the next ratchet step.
- **Forward secrecy** holds for Olm; Megolm sessions are shared and ratchet forward only.
- **Deniability**: Olm messages are not signed by long-term keys.
- **TOFU**: without safety-number checks a server could serve a fake key for a new contact.
- **Pickle keys** are wiped in Rust after each call; their JavaScript copies (and uniffi's transfer buffer) cannot be wiped reliably.

## 7. Out of scope
A compromised OS or rooted phone; malicious browser extensions; traffic analysis by a global observer; legal compulsion of users; physical coercion.

## 8. Review triggers
New transport or platform (iOS), a protocol change (ADR 0006 version bump), a new third party, or any change to what the server stores.
