# 0032 — iOS push (direct APNs) and calls (PushKit + CallKit)

- **Status:** Accepted (code; device checks blocked on the Apple Developer Program)
- **Date:** 2026-11-03
- **Phase:** 29
- **Approved by user:** n.a. Nothing paid. An APNs key needs the US$99/yr Apple Developer Program, which is the user's decision (ADR 0031).

## Context
REQ §4.1 allows APNs to wake a device but forbids message text, files, secrets or keys in payloads; §12 asks for reliable incoming calls; §19.5's call criteria must hold on iOS. ADR 0015 made Android pushes data-only wakes, after which the phone builds its own notification. iOS works differently:
- a silent (`content-available`) push is throttled, and **never** delivered to an app the user force-quit;
- incoming calls need PushKit VoIP pushes, and since iOS 13 **every** VoIP push must be reported to CallKit before its handler returns, or iOS kills the app and soon stops delivering VoIP pushes;
- FCM cannot send PushKit VoIP pushes.

There is no Mac, iPhone or Apple account here (ADR 0031), so only the server can be tested end to end.

## Options considered
| Topic | Option | Pros | Cons | License | Cost |
|---|---|---|---|---|---|
| APNs route | FCM for iOS | One provider for both platforms | Google sees iOS push timing too; no VoIP pushes, so APNs is needed anyway; the APNs key goes to Firebase | — | free |
| | **Direct APNs, token auth (.p8), `node:http2` + `jose` ES256** | No third party besides Apple; VoIP and alerts through one client; no new dependency; every request testable | We map APNs errors ourselves; HTTP/2 session care | — | free (needs the Apple account) |
| Message wake | Silent push only | Nothing visible from the server | Not delivered after a force-quit; throttled: messages would wait until the app is opened | — | — |
| | **Alert with a constant "New message" + `content-available`** | Shown even after a force-quit; a suspended app still wakes, fetches and shows its own notification, then removes the constant one | The constant alert ignores mute and previews when the app cannot run | — | — |
| | Notification Service Extension that fetches and decrypts | Real sender and text, mute honoured | Needs the Olm sessions in a second process (app group + keychain group, file locking against the app advancing the same ratchet), the Rust crypto and SQLCipher inside a 24 MB extension; any race corrupts sessions. Cannot be built or tested without a Mac | — | — |
| Incoming calls | Alert push + in-app ring | No CallKit | Does not ring on a locked phone or a killed app | — | — |
| | react-native-callkeep + react-native-voip-push-notification | Common pair | Two libraries; the VoIP push must still be reported natively at launch; callkeep also wraps Android's ConnectionService, which ADR 0029 decided against | ISC | free |
| | **A Swift half of the local `pingdost-calls` module (PushKit + CallKit, no dependency)** | Reports VoIP pushes natively before JS exists; same JS surface as Android; nothing new to audit | Ours to maintain; compiled only on macOS CI | — | free |

## Decision
**Server (`apps/server/src/modules/push/apns.ts`):**
- `ApnsSender` posts to `https://api.push.apple.com` (or `api.sandbox.push.apple.com` for development builds) over one reused HTTP/2 session per gateway, with an ES256 provider token (`kid` = key ID, `iss` = team ID, `iat`) signed by `jose` and reused for 50 minutes.
- Wake: `apns-push-type: alert`, topic = bundle ID, priority 10, `apns-collapse-id: wake`, expiry = the wake TTL; body exactly `{"aps":{"alert":{"body":"New message"},"sound":"default","content-available":1},"t":"wake"}`.
- Call: to the VoIP token, `apns-push-type: voip`, topic `<bundle>.voip`, expiry 60 s; body exactly `{"t":"call"}`. A device without a VoIP token gets the alert form with "Incoming call" and `apns-collapse-id: call`.
- No sender, conversation, message, user or device ID is ever in a request (tested).
- 410, or 400 `BadDeviceToken`: the token is deleted (only the VoIP token when that one failed). `DeviceTokenNotForTopic`/`TopicDisallowed` point at our config, so nothing is deleted. 403 `ExpiredProviderToken`/`InvalidProviderToken`: new provider token, one retry. 429/5xx: bounded retries (ADR 0015's loop).
- `PUT /v1/push/token` takes `{provider:'apns', token, voipToken?, environment:'sandbox'|'production'}` (hex tokens). `push_tokens` gains `voip` and `sandbox`; a VoIP token moves to the device that registered it last, like the other addresses.
- Config: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY_BASE64` (secret), `APNS_BUNDLE_ID`, all or none.

**iPhone:**
- `push/token.ts` registers the alert token, the VoIP token (from `PingdostCalls`) and the build's environment. `PINGDOST_APS_ENVIRONMENT=production` (TestFlight/App Store builds) sets both the `aps-environment` entitlement and `extra.apsEnvironment`; anything else is `development`/sandbox.
- The constant alert is hidden while the app is open and removed once the app has fetched (on opening, and at the end of a background wake), so the app's own notification replaces it and mute applies whenever the app gets to run.
- `modules/pingdost-calls/ios` (Swift): `CallKitCenter` starts at every launch (`CallsAppDelegate`), registers PushKit, and reports each VoIP push as a call named "PingDost" before returning. A push call nobody binds within 30 s is ended natively. `includesCallsInRecents = false` (Recents syncs through iCloud; call history stays per device, ADR 0028). No hold, one call at a time. The audio session is set to play-and-record (voice chat or video chat) on answer and start; CallKit's activation is passed to WebRTC (`RTCAudioSession.audioSessionDidActivate`).
- `src/calls/callkit.ts` (`CallKitBridge`, unit-tested) binds a push call to the E2EE invite when it arrives and updates the name, reports invites that came over the socket as new calls, reports outgoing calls, ends push calls whose invite never comes (20 s) and pushes during a live call, keeps a lock-screen answer or decline made before the invite, and tells CallKit why each call ended (a local end is an end action).
- `src/calls/voip.ts` (loaded by the entry) connects when a VoIP push arrives and holds CallKit events until the call runtime takes them.
- Info.plist background modes `voip` and `audio` from the local plugin `plugins/with-ios-background-modes.js`, which app.config.js registers **first**: Expo runs mods in reverse order, and expo-video removes `audio` (no background video). `remote-notification` comes from expo-notifications (`enableBackgroundRemoteNotifications`). Checked in the Linux prebuild: `fetch`, `remote-notification`, `voip`, `audio`; entitlement `aps-environment` = `development`.

## Consequences
- **Mute and previews on iPhone:** when the app cannot run (force-quit, or iOS refuses background time), the user sees "New message" for muted chats too. A Notification Service Extension would fix it; it is deferred until there is a Mac and a device to prove it does not corrupt sessions.
- A lock-screen answer before the user ever allowed the microphone fails as "media denied": the permission prompt cannot show there. The explainer should ask early (device check).
- The **ApnsSender is tested only against a fake gateway** (real HTTP/2, provider token verified with the public key). Nothing has been sent to Apple; the Swift code has not compiled yet (first compile: `.github/workflows/ios.yml`).
- Device matrix still open: iPhone↔Android, iPhone↔web, locked and killed app, network switch, Bluetooth and speaker routes, a call answered from the lock screen with sound.

## Evidence
- Checked by web search on 2026-11-03 (Apple's pages were not fetched in full; recheck when the account exists):
  - Apple's APNs guide: `apns-push-type` is required on iOS 13+; `apns-topic` is the bundle ID, with `.voip` for VoIP; `apns-collapse-id` is at most 64 bytes; `apns-expiration` is epoch seconds; priority 10 must alert.
  - Provider tokens: refresh no more than once every 20 minutes (`TooManyProviderTokenUpdates`), rejected when older than 60 minutes (Apple forum threads quoting the docs).
  - Responses: 410 `Unregistered`, 400 `BadDeviceToken`, 400 `DeviceTokenNotForTopic`, 403 `ExpiredProviderToken` (third-party references and forum quotes). Apple lists `DeviceTokenNotForTopic` as not retryable and to stop using the token; we keep the token because a wrong `APNS_BUNDLE_ID` would otherwise delete every token.
  - PushKit `pushRegistry(_:didReceiveIncomingPushWith:for:completion:)`: apps built with the iOS 13 SDK or later must call `reportNewIncomingCall`; developers report the app is killed when the report is not made synchronously in the delegate (the code reports before any other work).
  - `CXProviderConfiguration.includesCallsInRecents` is from memory and was not checked.
- expo-notifications 58.1.5: `enableBackgroundRemoteNotifications` adds `remote-notification`; remote notifications have a `push` trigger and `content.data` from `body` only (installed `plugin/build/withNotificationsIOS.js`, `ios/.../NotificationRecords.swift`).
- react-native-webrtc 155.0.1: `RTCAudioSession.audioSessionDidActivate/Deactivate` for CallKit (installed `src/RTCAudioSession.ts`).
- Tests: `apps/server/src/modules/push/apns.test.ts` (10), `apps/server/test/push.int.test.ts` APNs block (3), `apps/mobile/src/calls/callkit.test.ts` (13), `apps/mobile/src/push/content.test.ts` (2 new).
