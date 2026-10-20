# 0020 — Web chat: Dexie engine store, tab leadership, Web Push, PWA

- **Status:** Accepted
- **Date:** 2026-10-20
- **Phase:** 17
- **Approved by user:** n.a.

## Context
A linked browser (ADR 0019) must chat with the same engine as the phone (REQ §8.1–8.2). Its storage must be encrypted (REQ §7.5, §14.2). Several open tabs must neither open several sockets nor show different states (ARCHITECTURE A7). It needs content-free wake-ups (Web Push) and must open offline as an installed app.

## Decision
1. **`DexieEngineStore`** (`packages/web-store`, shared by the web app and by server tests that run a browser-like device in Node).
   - Every record is sealed with the browser's non-extractable AES-GCM vault key (ADR 0019). The AAD is `table:key`, so rows cannot be swapped.
   - Plaintext fields, only for the indexes: IDs, `conversationId`, `sortAt`, an `unread` flag, the `expiring` deadline of unsettled outgoing messages, delivery `state`, `createdAt`/`receivedAt` and group IDs. Never text, keys, pickles or envelopes. Seen IDs are stored as IDs and times only.
   - `apply(batch)` seals everything first, then writes in **one** IndexedDB transaction. Awaiting Web Crypto inside a transaction would commit it early. Applies are queued.
   - Decrypted records are cached by their IV, up to 5,000.
   - **Search:** an in-memory index of text and caption bodies, built the first time a search runs (every message decrypted once) and kept in step by each apply. It matches with the shared `matchesQuery` rules. Nothing is written for it. A persisted encrypted index or MiniSearch was not worth the complexity at web scale.
   - The store passes the full shared `runEngineStoreContract`, plus a test that nothing readable stays in IndexedDB.
2. **One engine per browser.**
   - The tab holding the Web Lock `pingdost-connection` runs the engine, the gateway socket and the account's privacy settings and blocks (`chat/leader.ts`). Every other tab is a follower.
   - Followers' calls go over the BroadcastChannel `pingdost-chat` (`chat/bus.ts`: `call`/`result` by ID; errors keep `name` and `code`).
   - The leader announces conversation events (`MessageEngine.subscribeAll`, new), list changes, engine events, connection status, presence and prefs.
   - When the leader tab closes, the lock passes on. The new leader starts the engine and announces itself; calls still pending with the old one fail ("PingDost moved to another tab. Try again") rather than repeating a write.
   - Revocation and a refused refresh reach every tab (`signed_out`), and each wipes its data and shows pairing.
   - The UI talks to one `ChatClient` interface in either role (`chat/client.ts`).
3. **Receipts stay with the sending device only** (Phase 9 question). A message this user sent from another device shows "sent from your other device" without ticks, rather than fanning receipts out to every device. That would double the receipt traffic and tell more devices about reading.
4. **Web Push and notices:**
   - The VAPID public key is `VITE_WEB_PUSH_PUBLIC_KEY`, optional public config; `pnpm --filter @pingdost/server vapid-keys` prints a pair. `PUT /v1/push/token {provider: webpush}` registers the subscription.
   - The service worker (`src/sw/sw.ts`, vite-plugin-pwa 2.0.0 `injectManifest`, Workbox 7.4.1) shows "New message" for a wake, unless a PingDost tab is visible. It never decrypts.
   - The leader tab shows the same notice for messages that arrive while no PingDost tab is in front. Both use one tag, so they never stack. A click focuses or opens the app.
   - The service worker exists only in builds. To try notifications, run `vite build` then `vite preview`; preview uses port 5173, so the server's `WEB_ORIGIN` matches.
5. **PWA:** a manifest with PingDost icons (192, 512, maskable, apple-touch) and a precached app shell. Navigations fall back to `index.html`, so it opens offline, history comes from IndexedDB, and the outbox sends when the connection returns.
6. **UI:**
   - shared labels and timeline in `@pingdost/chat-core` (moved from mobile; mobile re-exports them);
   - conversation list (pin, mute, archive, delete) and chat view (react-virtuoso 4.18.19: virtualized, keeps position when older pages load, follows new messages);
   - bubbles with quote, reactions, edit, delete, info and retry; composer with reply and edit;
   - new chat and group by username; contact page (safety number, QR, mark verified, block); group page (edit info, roles, add, remove, leave);
   - message info, search (highlights) and settings (privacy synced with the account, notifications, shortcuts, unlink);
   - shortcuts: Ctrl+K, Alt+N, Enter, Shift+Enter, ↑, Esc.
   - Screens and the engine load on demand: the first chunk is about 264 kB.
7. **CSP:** `img-src` adds `https://res.cloudinary.com` (public profile pictures, ADR 0008).

## Consequences
- **Phase 18** adds attachments to `features/attachments/attachment-view.tsx` (a placeholder now) and sync to the leader runtime. The chat client already exposes `attachmentRecipients`, `sendAttachment` and `releaseAttachment`.
- Server tests can run a browser-like device on the real store: `SimClient` takes `store` (`apps/server/test/web.int.test.ts`).
- **Phase 20:** the Pages headers carry the CSP; set `VITE_WEB_PUSH_PUBLIC_KEY` and the server's VAPID trio.

## Evidence
- `packages/web-store`: 21 tests (the full store contract on fake-indexeddb, at-rest secrecy, the vault).
- `apps/web`: the bus relays calls, maps errors, delivers events and fails pending calls on handoff (3); pairing (4).
- `apps/server/test/web.int.test.ts` (real server, real pairing, the Dexie store):
  - a contact's message reaches the phone and the browser; the browser's reply reaches the contact, is filed on the phone as "from me", and becomes delivered;
  - the phone's message is filed on the browser as "from me";
  - a group made on the phone works both ways from the browser;
  - search works over the browser's store;
  - no message text or group name is readable in IndexedDB.
- `pnpm --filter @pingdost/web build`: the service worker precaches 41 entries (2.1 MB, the WASM included).
