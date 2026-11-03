# Phase 29 — iOS: APNs push + CallKit calls

**Depends on:** 28 · **Platforms:** iOS · **Status:** 🔄 code written (2026-11-03); device checks blocked on the Apple Developer Program, an iPhone and a macOS build

## Goal
Content-free wake notifications and reliable incoming calls on iOS.

## Read first
- REQ §4.1 (Push), §12
- ARCHITECTURE A2 (Push)
- The Phase 12 and Phase 26 ADRs and notes
- ADR 0032 (this phase)

## Tasks
- [x] An `apns` adapter in `PushNotifier`: **direct APNs with a token-based .p8 key** (ADR 0032). `ApnsSender` (`apps/server/src/modules/push/apns.ts`) on `node:http2` + `jose` ES256; `PUT /v1/push/token` takes `{provider:'apns', token, voipToken?, environment}`; config `APNS_*`.
- [x] Message wake: a constant "New message" alert with `content-available` (silent pushes do not reach a force-quit app). The app hides it while open and removes it once it has fetched. A **Notification Service Extension** that decrypts was evaluated and **deferred** (ADR 0032: shared Olm sessions across processes).
- [x] VoIP push (PushKit) + CallKit: Swift half of `modules/pingdost-calls` (`CallKitCenter`, `CallsAppDelegate`, `CallsModule`); every VoIP push is reported to CallKit before its handler returns; `src/calls/callkit.ts` binds CallKit calls to the call manager; `src/calls/voip.ts` connects on a VoIP push. Audio session: play-and-record, CallKit activation passed to WebRTC (`RTCAudioSession`).
- [x] App config: background modes `voip` + `audio` (`plugins/with-ios-background-modes.js`, registered first because expo-video drops `audio`) and `remote-notification`; `PINGDOST_APS_ENVIRONMENT` → `aps-environment` + `extra.apsEnvironment`; the notification explainer card on iOS; privacy texts name Apple.
- [ ] **First compile:** push, run `.github/workflows/ios.yml`, fix the Swift until it builds (never compiled; no Mac here).
- [ ] **Apple account steps** (US$99/yr, the user's decision; see "Setup" below), then the server's `APNS_*` on the VPS.
- [ ] Test matrix on devices: iPhone↔Android, iPhone↔web, locked and killed app, network switch, answer from the lock screen with sound, speaker/earpiece/Bluetooth, a push during a call, decline before the invite arrives, a muted chat (shows "New message" when the app cannot run: known).

## Setup (after the Apple Developer Program exists)
1. developer.apple.com → Certificates, IDs & Profiles → Identifiers → `com.pingdost.app`: enable **Push Notifications**.
2. Keys → **+** → name "PingDost APNs", tick **Apple Push Notifications service (APNs)** → Continue → Register → **Download** the `.p8` (only once). Note the **Key ID** and your **Team ID** (top right, or Membership).
3. On the VPS `.env`: `APNS_KEY_ID=<key id>`, `APNS_TEAM_ID=<team id>`, `APNS_BUNDLE_ID=com.pingdost.app`, `APNS_PRIVATE_KEY_BASE64=` the output of `base64 -w0 AuthKey_<id>.p8` (PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes('AuthKey_<id>.p8'))`). Restart the server.
4. Development builds use the sandbox gateway automatically; build TestFlight/App Store builds with `PINGDOST_APS_ENVIRONMENT=production`.

## Done when
The REQ §19.5 call criteria pass on iOS, and message notifications work with the app killed.

## Results (2026-11-03)
- Server: `apns.test.ts` 10 passed (real HTTP/2 against a fake gateway; provider token verified with the public key); `push.int.test.ts` 9 passed (3 APNs: tokens, the exact wake request with no IDs or content, a 410 deleting the token).
- Mobile: `callkit.test.ts` 13 passed; `content.test.ts` +2. Lint and typecheck clean.
- Linux `expo prebuild --platform ios --no-install`: pass; Info.plist modes `fetch`, `remote-notification`, `voip`, `audio`; `aps-environment` `development`.
- **Not run:** any Swift compile, an iPhone, a real APNs send.

## Handoff notes
- Phase 30's nearby module needs the Bluetooth background modes (add them to `MODES` in `plugins/with-ios-background-modes.js`) and `NSBluetoothAlwaysUsageDescription`.
- If the NSE is built later: it must not advance the Olm ratchet the app also uses; options are a read-only peek (not possible with Olm) or a cross-process lock on the session store.
