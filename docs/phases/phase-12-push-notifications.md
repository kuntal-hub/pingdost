# Phase 12 — Push notifications (content-free)

**Depends on:** 10 · **Platforms:** server, Android (+ the server side of Web Push)

## Goal
Offline Android devices get woken by FCM with a payload that carries no content. They then fetch, decrypt and show a local notification. Previews are optional.

## Read first
- REQ §4.1 (Push), §5.2, §7.5 (last bullet), §18
- ARCHITECTURE A2 (Push), A10
- **Load skill `expo:expo-overview`**

## Tasks
- [ ] **User setup steps** (write them out; free): create a Firebase project → add the Android app `com.pingdost.app` → download `google-services.json` (gitignored; path via app config env) → create a service account key for FCM HTTP v1 → base64 it into `FCM_SERVICE_ACCOUNT_JSON_BASE64`.
- [ ] **Server push module:**
  - `push_tokens` collection (deviceId, provider fcm|webpush, token/subscription, updatedAt); `PUT /v1/push/token`, `DELETE /v1/push/token`;
  - `PushNotifier` implementation with an `fcm` adapter (OAuth via the service account JWT; check the current FCM v1 API) and a `webpush` adapter (`web-push` lib, VAPID env; used by web in Phase 17);
  - payload `{t:"wake"}` only, high priority, collapse key per device;
  - throttle at most 1 wake per device per N seconds (env);
  - remove invalid tokens on `UNREGISTERED`.
- [ ] Hook `wake()` into the delivery offline path (Phase 8 interface).
- [ ] **Android client:**
  - `expo-notifications`: get the **device** FCM token (`getDevicePushTokenAsync`) and register it;
  - background task (`expo-task-manager` + `Notifications.registerTaskAsync`): on a data message, start the engine headless → connect WS → fetch → decrypt → ack → local notification → disconnect;
  - notification channels (Messages; Calls placeholder);
  - Android 13+ notification permission prompt with an explanation;
  - tapping a notification deep-links to the chat;
  - **Settings:** "Show message previews" (default on; when off: "New message"), per-chat mute respected, and a "Hide sender name" option.
- [ ] Handle Doze/battery: document the high-priority data message limits and add a "battery optimization" help link in Settings.
- [ ] **Tests:** server unit tests with mocked FCM/web-push endpoints (payload has no content fields, throttling, token cleanup).

## Key files
`apps/server/src/modules/push/*`, `apps/mobile/src/push/*`, `apps/mobile/app.config.ts` (google-services path)

## Out of scope
Call push (26), web subscription UI (17), APNs (29).

## Done when
- On a phone, a message to an app that is backgrounded, swiped away or screen-locked shows a notification within seconds. Report the exact behavior per state in PROGRESS.
- An inspected FCM request body contains only `{t:"wake"}`.
- `pnpm lint typecheck test` passes.

## Handoff notes
**From Phase 8 (ADR 0010):** implement `PushNotifier` (`apps/server/src/modules/push/notifier.ts`) and pass it as `AppDeps.push`. The gateway calls `wake(recipientDeviceId, urgent)` after `Accepted{STORED}` (not for duplicates); `urgent` comes from the packet's `PACKET_FLAG_URGENT`.
**From Phase 10 (ADR 0012):** after 30 s in the background the app closes its socket (`BACKGROUND_GRACE_MS` in `apps/mobile/src/engine/runtime.ts`). From then on, only the push wake can bring messages in. On a wake, call `startChat()` and `transport.start()`, then let the mailbox fetch run before the OS suspends the app again.
**From Phase 11 (ADR 0014):**
- Muted chats must not notify: `ConversationRecord.mutedUntil` (`MUTED_FOREVER` = always) is local, so the app decides after the wake. Archived chats still notify unless muted.
- Read receipts are sent when a chat is open (`engine.markRead`). Reading from a notification must not send one unless the user opened the chat.
