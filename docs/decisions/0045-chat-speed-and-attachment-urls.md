# 0045 — Chat speed and attachment URLs on the client's own address

- **Status:** Accepted
- **Date:** 2026-11-13
- **Phase:** none (fixes after Phase 40, reported by the user on two phones with EAS dev builds)
- **Approved by user:** n.a. (bug fixes the user asked for)

## Context
The user found three problems on two phones:
1. A chat took seconds to show its messages, including new unread ones.
2. A message took seconds to go through queued → sending → sent → delivered → read, even with both phones in the chat.
3. Voice notes and files were never sent.

The causes:
- **Files (3):** the `fs` store signs part and download URLs with the server's `PUBLIC_API_URL`. The dev `.env` has `http://localhost:3000`, and phones on the LAN reach the server at the PC's IP. Every part upload went to the phone itself and failed, so the held message was never released. Downloads failed the same way. The Phase 40 emulator checks passed only because `adb reverse` made `localhost:3000` reach the PC.
- **Speed (1, 2):** the engine store ran every statement through expo-sqlite's async calls. Each call (`runAsync`, `getAllAsync`) is 3–4 round trips between the JS thread and a native IO worker, and each round trip waits for the JS thread to be free. A send, a receive or a receipt runs dozens of statements, so on a busy phone this added up to seconds. The server answers the sender only after the recipient has stored and acknowledged the envelope (online path), so slowness on the receiving phone also showed on the sender.
- A chat read its first page only after it mounted (an empty frame, then "Just you two", then the messages).
- Every state change re-rendered every bubble on screen.
- A send after 5 idle minutes first refetched both device lists, one after the other.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| Set `PUBLIC_API_URL` to the LAN IP in `.env` | no code | breaks the emulator (`10.0.2.2`) and `adb reverse` (`127.0.0.1`); the LAN IP changes (1.2 → 1.5 → 1.31) | — | 0 |
| Server returns relative URLs | clean contract | breaks installed builds (zod expects absolute URLs) | — | 0 |
| **Client rebases the API's own signed routes onto its base URL** | works for every dev setup; compatible both ways; production unchanged (same origin) | the client must recognise the route (`/v1/attachments/…`) | — | 0 |
| **Engine store on expo-sqlite sync calls (JSI)** | statements take microseconds; no native round trips | runs on the JS thread (fine for the engine's small indexed queries) | MIT (expo-sqlite, already used) | 0 |
| Batch statements in native code | fewer calls | new native module, rebuild | — | 0 |

## Decision
1. **`rebaseSignedUrl`** (`@pingdost/api-client`): a URL whose path starts with `/v1/attachments/` is moved to the `baseUrl` the client was created with. `attachmentsApi` applies it to `create`, `status` and `complete` (upload URLs) and to `downloadUrl`. Object-store (`s3`) URLs are left as they are. The HMAC covers the path and query only, so signatures still hold. `ApiClient` now exposes `baseUrl`.
2. **`syncSql(db)`** (`apps/mobile/src/db/sync-sql.ts`) adapts expo-sqlite's `execSync`/`runSync`/`getFirstSync`/`getAllSync` to the promise-based `SqlDatabase`. The runtime gives it to `SqliteEngineStore` and `AttachmentRepo`. Other modules (nearby, backup, settings) keep the async calls. SQLite is built serialized (expo-sqlite sets no `SQLITE_THREADSAFE`), so sync and async calls share the keyed connection safely. Writes still go through the store's `exclusive` queue.
3. **Chat page cache** (`engine/hooks.ts`):
   - The newest page (50 messages) of up to 24 chats stays in memory. The chat list fills it in the background, unread chats first, one chat per macrotask. Pressing a row loads that chat too.
   - `subscribeAll` events keep the cache current, and `content_removed` clears it.
   - `useConversation` starts from the cache, then replaces it with the store's page; events seen meanwhile win. Its new `ready` flag shows the empty state only after the store was read.
4. **Bubbles** are `memo` with a comparator that counts `loaded` only through the quoted message; the screen's callbacks are stable.
5. **`engine.warmDirectories(userIds)`** refreshes cached device lists older than half of `directoryMaxAgeMs`, 8 at a time. The chat screen calls it when the chat opens (online) and every 2 minutes. A direct fan-out now looks up both lists in parallel.

## Consequences
- Files and voice notes work against a dev server whatever address the phone uses. `PUBLIC_API_URL` matters again only for object-store setups.
- No new native build: all changes are JS (expo-sqlite's sync API is in the installed module).
- A very large engine batch (e.g. a history-sync page) now blocks the JS thread for its duration instead of yielding between statements; measured batches are small.
- Open: measure send→read and chat-open times on the user's two phones (the emulator here is too loaded for timings).

## Evidence
- `apps/server/test/attachments.int.test.ts` "client on another address": the server signs with `http://localhost:<port nobody listens on>`. Upload and download through `@pingdost/api-client` pass (7/7 with the existing suite). `engine.int.test.ts` + `web.int.test.ts` 11/11.
- `apps/mobile/src/db/sync-sql.test.ts`: the `EngineStore` contract over `syncSql`, plus rollback of a failed batch.
- Emulator `Pixel_8_API_35` with Metro at `10.0.2.2:3000`, the server's `PUBLIC_API_URL=http://localhost:3000` and no `adb reverse` for the API, so the bug was in reach:
  - a 1.9 s voice note uploaded (`POST`/`PUT parts/0`/`complete`), was delivered and read, and the sim peer downloaded it ("playable MP4 audio");
  - text went to read with the echo back;
  - chats opened onto their history.
- expo-sqlite 58.0.13 source checked 2026-11-13: async calls are `withContext(Dispatchers.IO)`; `runAsync` = prepare + execute + finalize, while `runSync` does the same on the JS thread.
