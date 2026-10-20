# 0015 — Push notifications: content-free wakes, local notifications

- **Status:** Accepted
- **Date:** 2026-10-20
- **Phase:** 12
- **Approved by user:** n.a.

## Context
REQ §4.1 and §7.5 allow FCM/APNs to wake a device, but forbid message text, file content, keys or secrets in push payloads. REQ §5.2 forbids permanent server records of receipts or presence; REQ §18 asks for timeouts, bounded retries and metrics. ARCHITECTURE A2 fixes the payload to `{"t":"wake"}` / `{"t":"call"}`, coalesced per device. After 30 s in the background the app closes its socket (ADR 0012), so a push is the only way to learn of new messages.

## Options considered
| Topic | Option | Pros | Cons | License | Cost |
|---|---|---|---|---|---|
| FCM client on the server | `firebase-admin` | Official | Large dependency tree for one HTTP call | Apache-2.0 | free |
| | **FCM HTTP v1 over `fetch`, OAuth JWT bearer grant signed with `jose`** (already a dependency) | No new dependency; every byte sent is visible and tested | We map FCM errors ourselves | — | free |
| Web Push | **`web-push` 3.6.7** (VAPID, RFC 8291 encryption) | Standard, small | MPL-2.0 (file-level copyleft; used unmodified) | MPL-2.0 | free |
| Payload | Notification message with a generic title | Shown by the OS even if the app is dead | FCM shows it without our code: no mute, no preview setting; a "notification" body is content-like | — | — |
| | **Data-only `{t:"wake"}`, high priority; the app builds a local notification** | Nothing readable leaves the server; mute/preview rules apply on the device | Android may delay or drop data messages (Doze, app standby, OEM battery savers) | — | — |
| Wake rate | One push per stored envelope | Simple | A burst of 20 messages = 20 pushes; FCM throttles high-priority data that shows nothing | — | — |
| | **≤ 1 per device per `PUSH_WAKE_THROTTLE_SECONDS` (10 s), plus one deferred wake at the end of the window** (skipped if the device connected) | Bursts collapse; a message right after a wake is never stranded | In-memory (single API instance, A2) | — | — |
| App wake handling | **`expo-notifications` background task (`registerTaskAsync` + `expo-task-manager`) defined in a custom entry (`apps/mobile/index.ts`)** | Runs headless when the app was swiped away | Needs the polyfills before the task; JS time is limited | MIT | free |

## Decision
**Server (`apps/server/src/modules/push/`):**
- `push_tokens`: one document per device, `{_id: deviceId, userId, provider: fcm|webpush, address, keys?, updatedAt}`. `address` is the FCM token or the Web Push endpoint, indexed; registering an address removes it from any other device (reinstalls). Revoking a device or logging out deletes its token.
- `PUT /v1/push/token` (`{provider:'fcm', token}` or `{provider:'webpush', subscription}`; https endpoints only) and `DELETE /v1/push/token`, both for a device-bound session, rate-limited (`pushToken`).
- `PushService` implements the gateway's `PushNotifier`:
  - the first wake for a device goes out at once; later wakes inside `PUSH_WAKE_THROTTLE_SECONDS` collapse into one deferred wake at the window's end, skipped if the device has a socket by then; urgent wakes skip the window;
  - transient failures (network, 429, 5xx, a 401 that refreshes the OAuth token) are retried at most twice with backoff (`Retry-After` honoured, ≤ 30 s);
  - a rejected address is deleted: FCM `UNREGISTERED` or `SENDER_ID_MISMATCH`, or `INVALID_ARGUMENT` that names `message.token`; Web Push 404/410. A bare 404 or a payload `INVALID_ARGUMENT` never deletes (a wrong project ID must not wipe every token);
  - `pingdost_push_wakes_total{result}` counts sent, throttled, skipped_connected, no_token, unconfigured, invalid_token and failed. Logs carry the provider and HTTP status only, never the address.
- FCM request body, exactly: `{"message":{"token":…,"data":{"t":"wake"},"android":{"priority":"HIGH","collapse_key":"wake","ttl":"<retention>s"}}}`. TTL = min(`MESSAGE_MAX_RETENTION_SECONDS`, 28 days). Web Push sends `{"t":"wake"}` with `urgency: high`, `topic: wake`.
- Without `FCM_*` / `WEB_PUSH_*` the service still accepts tokens and counts wakes as `unconfigured`.

**Android (`apps/mobile/src/push/`):**
- The entry `index.ts` loads the polyfills, defines the task (`push/task.ts`), then `expo-router/entry`. Every data message is treated as a wake: `handleWake` hydrates the session, starts the engine, opens the socket, waits until the mailbox is quiet (2.5 s without changes after connecting; at most 20 s; 10 s to connect), then closes the socket unless the app came to the foreground.
- The engine emits `received` once per new incoming unread message after it is committed. `installNotifier` turns it into a local notification on the `messages` channel when the app is not active and the chat is not muted. One notification per chat (ID = conversation ID), replaced by newer messages, removed when the chat is opened. Lock-screen visibility is `PRIVATE`.
- "Show message previews" (default on) and "Hide sender name" (default off) are local settings (`local_settings.notifications`).
- Channels `messages` (high) and `calls` (max; Phase 26). An explainer card asks before Android 13+'s permission prompt.
- The token is registered on every start in the `ready` stage, re-registered on token rotation, and deleted on logout before the session is revoked.
- Opening a notification deep-links to the chat. Only opening the chat sends read receipts; the notification never does.
- `google-services.json` is git-ignored and optional: `app.config.js` sets `android.googleServicesFile` only when the file exists.

## Consequences
- Delivery while the app is closed depends on Android delivering high-priority data messages. Doze defers normal-priority messages but lets high-priority ones through within limits. App standby buckets and some OEM battery savers (Xiaomi, Oppo, Vivo, Samsung "sleeping apps") can still delay or drop them, and a force-stopped app receives nothing until opened. Settings → Notifications links to the battery optimization settings with that advice.
- FCM may deprioritize an app's high-priority messages if they rarely lead to a visible notification. A wake for a muted chat or a duplicate shows nothing; watch it in Phase 27.
- Phase 17 (web) registers a Web Push subscription with the same endpoint; Phase 26 adds `{t:"call"}` (urgent, `calls` channel).
- Phase 20 sets `FCM_PROJECT_ID` and `FCM_SERVICE_ACCOUNT_JSON_BASE64` on the VPS (and the VAPID keys for the web).

## Evidence
- FCM HTTP v1 request fields and token-error guidance: firebase.google.com/docs/reference/fcm/rest/v1/projects.messages, /docs/cloud-messaging/manage-tokens (checked 2026-10-20).
- expo-notifications 58.1.5 `registerTaskAsync` (headless data messages on Android), `NotificationTaskPayload`, channel and permission APIs: installed `build/*.d.ts` and docs.expo.dev (checked 2026-10-20).
- `web-push` 3.6.7 (MPL-2.0) and `@types/web-push` 3.6.4 (MIT), npm registry (checked 2026-10-20).
- Tests: `apps/server/src/modules/push/push.test.ts` (FCM body, OAuth JWT, error mapping, throttling, retries) and `apps/server/test/push.int.test.ts` (an offline send produces exactly the body above, with no ciphertext marker, message, envelope, user or device IDs).
