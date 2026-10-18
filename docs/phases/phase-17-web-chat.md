# Phase 17 — Web chat (1:1 + groups) + Web Push + PWA

**Depends on:** 13, 16 · **Platforms:** web

## Goal
A linked browser can send and receive 1:1 and group messages using the shared engine, with UI parity for text features, Web Push wake-ups and PWA install.

## Read first
- REQ §8.1, §8.2, §13.2 (last 3 bullets), §14.2
- ARCHITECTURE A7

## Tasks
- [ ] **`DexieEngineStore`** implementing `EngineStore`, with sensitive fields encrypted via the Phase 16 helpers. It must pass the shared store contract tests (fake-indexeddb in Vitest).
- [ ] **Tab leadership:** the Web Locks API elects one leader tab that owns the WS + engine; follower tabs get updates via BroadcastChannel and route their sends through the leader. Handle leader handoff.
- [ ] **UI:**
  - conversations list, chat view (virtualized), composer, statuses, message info;
  - new chat by username; contact info with safety number + QR display for verification;
  - groups: create, manage, info, system messages;
  - reactions, reply, edit, delete, search (a client-side index, e.g. MiniSearch, kept in memory and rebuilt from Dexie, or persisted encrypted; pick one with a note);
  - typing and receipts per settings;
  - keyboard shortcuts.
- [ ] **Own-device sync:** messages sent from the phone show up on web (and vice versa) via the fan-out to own devices from Phase 9. Verify sent-message transcripts render as "from me".
- [ ] **Web Push:**
  - vite-plugin-pwa service worker;
  - subscribe with the VAPID public key from public config → `PUT /v1/push/token (webpush)`;
  - the service worker shows a generic "New message" (no decryption in the SW in v1), and a click focuses or opens the app.
- [ ] **PWA:** manifest, icons, offline shell (history from IndexedDB while offline; the outbox queues).
- [ ] **Settings:** privacy toggles (synced with the account prefs), notifications, linked-device info, unlink.

## Key files
`apps/web/src/{engine/*,db/dexieStore.ts,features/chats/*,features/groups/*,sw/*}`, `apps/web/vite.config.ts`

## Out of scope
History sync from the phone and attachments on web (18); calls (25).

## Done when
- Phone ↔ web messages work both ways, 1:1 and in a group.
- Two web tabs open: there is no duplicate socket and the UI stays consistent.
- Push arrives with the tab closed (Chrome) and contains no content.
- `pnpm lint typecheck test` and `pnpm --filter @pingdost/web build` pass.
