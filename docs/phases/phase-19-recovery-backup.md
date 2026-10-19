# Phase 19 — Recovery, encrypted backup & primary replacement

**Depends on:** 13, 16 · **Platforms:** Android, server, web (approval)

## Goal
Opt-in, user-controlled encrypted backup and restore with a recovery phrase. Replacing the primary phone is approved by an already-authorized device or proven with a backup. Key changes are communicated honestly. Nothing is backed up on the server.

## Read first
- REQ §6.2, §6.3 (all), §7.5, §21 (row "User loses every device")
- ARCHITECTURE A5 (Local at rest)
- The E2EE ADR (backup section)

## Tasks
- [ ] **Backup format ADR**:
  - file `pingdost-backup-<date>.pdbk` = versioned header (magic, version, KDF id + params, salt) + AEAD-encrypted body (XChaCha20-Poly1305 STREAM from the crypto crate, as in ADR 0004);
  - key from **Argon2id(recovery phrase)**, run on-device via the crypto crate (e.g. RustCrypto `argon2`; check its license and audit status) so every platform shares one implementation (no new primitives);
  - **body:** DB export (versioned JSON lines or SQLite copy), the **account identity key** (ADR 0003), Megolm inbound sessions (`exportAtFirstKnownIndex`), settings; attachments optional, with a size warning.
    - **Never include** the device Olm account, Olm sessions or outbound Megolm sessions: restoring old ratchet state can reuse message keys (ADR 0003, backup rules);
  - integrity check and a manifest hash;
  - per the ADR's portability findings, **1:1 Olm sessions are not restored as live**: they are marked stale and re-established via `SessionReset` after restore.
- [ ] **Recovery phrase:** 24-word BIP39 (`@scure/bip39`, MIT; check), generated on the device, shown once, confirmed with a quiz. **It is never sent to the server, logged or copied to analytics.** Warn about clipboard exposure: no auto-copy; if copied, clear the clipboard after 60 s where supported.
- [ ] **Mobile:**
  - Settings → Backup: create a backup to a user-chosen location (Android SAF via expo-document-picker / expo-sharing), last backup date, optional reminder (local notification);
  - onboarding offers "Restore from backup" after login.
- [ ] **Server primary-replacement flow** (`primary_transfer_requests`, TTL):
  - a new phone logs in → `PRIMARY_EXISTS` → options:
    - **(a) Approve from an existing device:** the active primary, or a linked web device if the policy allows (write the policy in the ADR). The approver gets a WS prompt plus a push wake, approves, and the old primary is revoked.
    - **(b) Restore from backup + fresh email OTP:** the old primary is revoked. The new phone restores the **account identity key** from the backup and creates a **fresh** Olm device account, certified by that key, as the new primary (new deviceId, bumped `keyVersion`). The safety number is unchanged (ADR 0003).
    - **(c) Start fresh:** a new identity, no history, and contacts see "safety number changed".
  - Every path is audited and rate-limited, and requires recent authentication.
- [ ] **Key-change notices:** directory `keyVersion` changes produce a system message in affected chats and reset the verified flag. Web and other devices update their caches.
- [ ] **Plain-language copy:** "If you lose all devices and have no backup, your chat history cannot be recovered. PingDost cannot restore it." (REQ §6.3)
- [ ] **Tests:** backup encrypt/decrypt round-trip, a wrong phrase fails, a tampered file fails, version handling; server transfer flows (approve, deny, expiry, replay); a sim-client test of restore → `SessionReset` → messaging resumes.

## Key files
`packages/attachments` or a new `packages/backup/*`, `apps/mobile/src/backup/*`, `apps/server/src/modules/device/primaryTransfer.ts`

## Out of scope
Server-side backups (forbidden); iOS (28).

## Done when
- On a phone: create a backup → wipe app data → log in → restore with the phrase → history and identity are back → chatting with the contact resumes (after an automatic session reset).
- Path (a) works with two devices.
- The tests pass, and `pnpm lint typecheck test` passes.

## Handoff notes
**From Phase 6 (ADR 0008):** `users.accountIdentityKey` is set once; registering with another key gives `IDENTITY_KEY_MISMATCH`. A replacement phone restores the identity key from the backup and registers as a new primary once the old one is revoked (`DELETE /v1/devices/:id` by the old primary, or the Phase 19 flow when it is lost). `PRIMARY_EXISTS` guards against two active primaries.