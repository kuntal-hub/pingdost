# PingDost — Requirement Changes & Deviations

This log records every change to, or deviation from, `privacy_first_messaging_app_requirements.md` (REQ), newest first. Format: date · change · reason · affected phases.

---

### 2026-11-12 — Phase 40 built: decisions taken while building (ADR 0044)
1. **Locked recordings can also be sent directly** (Delete, Stop, and Send on the round button), as in other messengers. Stop opens review as planned.
2. **The screen-reader flow is now the locked state:** a tap starts a hands-free recording with Delete, Stop (review) and Send. Phase 15's version had only Send or Cancel.
3. **Leaving the chat** (not only the app) counts as an interruption. Recording during a call is refused with a hint, since the call holds the microphone.
4. **No wire, server or native change:** the current dev build runs it. The sim peer now opens received files and voice notes and replies with what it got (a dev tool).
   - *Affects:* 40 (done, phone check open).

### 2026-11-11 — Phase 39 built: decisions taken while building (ADR 0043)
1. **A forwarded file is a new attachment** sent from the forwarding device's own encrypted copy (new key, new upload per chat), since the server copy may already be gone (ADR 0017). A file that device never downloaded (or removed) is skipped, and the notice says so.
   - *Affects:* 39 (done, phone check open).
2. **Additive wire change:** `ContentHeader.forwarded` (E2EE; the server never sees it). Older apps ignore it.
   - *Affects:* 39; 29/30 (iOS) read it the same way once built.
3. **New native dependency `expo-clipboard` 58.0.4 (MIT)** for Copy on the phone: it needs a new APK. Older builds say copying needs the latest build; nothing else in Phase 39 needs a build.
   - *Affects:* 39; the next EAS or local build.
4. **The web starts selecting from a "Select" button in the hover toolbar** (then a click on any row selects it), rather than a checkbox always shown on hover, so incoming bubbles do not move when the pointer passes.
   - *Affects:* 39.

### 2026-11-11 — Phases 36 and 37 built: decisions taken while building (ADR 0040, 0041)
1. **Emoji data:** `emojibase-data` 18.0.0 (MIT) for both pickers, loaded on first use; emoji newer than the device's font are hidden; recents and skin tone stay on the device.
   - *Affects:* 36 (done, phone check open).
2. **No Enter-to-send on a phone's hardware keyboard:** Android cannot tell it from the soft keyboard's Enter, which stays a new line. Every send jumps to the newest message.
   - *Affects:* 36.
3. **Group co-members outside each other's circle may still exchange one-to-one envelopes through the server**, refined from "1:1 envelopes refused outside the circle": group receipts, room-key requests and session repair travel one to one over Olm. Their apps drop direct content from outside the circle; calls, key claims for strangers, typing outside the group and group adds still need the circle.
   - *Affects:* 37 (done, two-phone check open).
4. **Additive wire and API changes:** `ServerFrame.circle_changed`; `ClaimKeysResponse.refusedDeviceIds`; push payload `{"t":"circle"}` (APNs alert "Circle update").
   - *Affects:* 37; 29 (iOS) handles the new push the same way as Android once built.
5. **Request details:** declining is silent (the sender sees "Requested" until the 30-day expiry); a request to someone who blocked the sender is stored as declined; a blocker must unblock before asking. Limits: 20 new requests a day, 100 pending, 1,000 per circle.
   - *Affects:* 37.
### 2026-11-10 — The user's UI/UX list: account screens, chat look and composer, Circles, people search, selection and forwarding, voice-note gestures
The user's 22-item list is in `prompts/UI_modifications.txt`; item numbers below refer to it. Planned as Phases 34–40; nothing is built yet.
1. **Circles: consent before contact (item 8).** People can message, call or add to a group only those in their circle; getting in takes a request the other side accepts. A deviation from REQ §8.1 and §8.2 (anyone could start a conversation with any username), and a change to ARCHITECTURE A2 ("the server keeps no contact list") and A4.
   - **The server stores the circle links**, by the user's choice over enforcement on the phones only. A stranger's data then never reaches the recipient's phone. The cost: a lasting "who is connected to whom" list on the server, which the privacy policy and the in-app explainer will state. The apps also drop content from outside the circle, because nearby and mesh routes have no server.
   - Name chosen by the user: **Circle**.
   - *Affects:* new Phase 37; 38 and 39 build on it. Finished phases are not reworked, but their integration tests and the sim peer must link test users first (37).
2. **People search (item 9):** username and display-name prefix from 2 characters, and email only as a whole address. At most 10 results, rate-limited, never returning anyone's email; users can turn off being found by name or by email. Replaces A2's "exact-match username lookup only". The user chose this over partial matching of everything, which would let anyone discover email addresses by typing fragments.
   - *Affects:* new Phase 38.
3. **Group members come only from the circle (item 10)**, picked several at a time. **New groups get a description field (item 11)**; the description already travels E2EE in `GroupControl` and is editable in Group info.
   - *Affects:* 37 (server check), 38 (UI). Phase 13's group model is unchanged.
4. **Account screens (items 1–5):** live username availability (a new endpoint that needs no sign-in and has a per-IP rate limit; it only reveals whether a name is free, which `by-username` already reveals to signed-in users), a password visibility toggle, a keyboard-safe layout, specific error messages, and the logo and brand colours. A failed sign-in still never says whether the email or the password was wrong.
   - *Affects:* new Phase 34 (phone only; the web has no sign-up).
5. **Chat look (items 6, 7, 12–15):** smaller screen titles, the Chats "+" floating above a full-width tab bar, a time and state on every message, bubbles at most 80% wide with the time inline when it fits, "This message was deleted" at once on both sides, and a single emoji shown large.
   - *Affects:* new Phase 35 (phone and web).
6. **Composer (items 16–19):** an emoji picker (recents stay on the device), the composer directly on the keyboard, a jump to the newest message on send, and a new-message pill.
   - *Affects:* new Phase 36 (phone and web).
7. **Selection and forwarding (items 20–21):** multi-select with copy, delete for me or everyone, and forward to up to 5 chats. A new optional `forwarded` field in message Content (an additive protocol change) marks other people's messages; one's own forwarded messages carry no mark.
   - *Affects:* new Phase 39.
8. **Voice notes by hold and slide (item 22):** hold to record, release to send, slide left to cancel, slide up to lock, then review before sending. Replaces Phase 15's tap to start, which stays for screen-reader users.
   - *Affects:* new Phase 40.
9. **A new native Android build is required** from Phase 34 on: `react-native-keyboard-controller` 1.22.7 (MIT; ADR 0039). Phase 36 may add an emoji picker.
10. **Phases 34 and 35 were built on 2026-11-10** (ADR 0039). Decided while building: the availability check takes the name as a query parameter (request logs leave queries out); an unverified sign-up's name counts as taken; the password meter only advises (the rule stays 10–128 characters); "big emoji" now means exactly one emoji.

### 2026-11-09 — New requirement: camera filters and effects in video calls (ADR 0038)
1. **21 effects** (beauty, face, colour and fun) drawn on the device before encryption: Android for all of them, the web (Chrome and Edge) for all but the face ones.
   - *Affects:* new Phase 33. No protocol or server change.
2. **Face tracking uses Android's built-in `FaceDetector`**, not MediaPipe or ML Kit: MediaPipe Tasks send usage metrics to Google, and ML Kit's terms are not OSI. Face effects on the web are deferred.
3. **A new native Android build is required** (calls module).

### 2026-11-09 — New requirement: calls change while they go on (ADR 0037)
1. **Voice ↔ video without hanging up.** Voice → video is a request the other side accepts or declines; video → voice applies at once on both sides. Every call now carries a video section in its SDP; with an app from before this change, switching is refused with a notice.
   - *Affects:* new Phase 32. 25, 26 (done parts) are not reworked; the protocol change is additive (`CallSignal.TYPE_MODE`, `screen_sharing`).
2. **Screen sharing**, one app (Android 14+; a window in browsers) or the whole screen, after the system's or browser's own consent. PingDost's own window/tab never appears in the share. No screen audio.
   - *Affects:* 32. iOS screen sharing (ReplayKit) goes to 29/30.
3. **Background:** the call already ran in a foreground service (26); it now also holds wake and Wi-Fi locks. **Video calls shrink into picture-in-picture** when the user leaves the app; without it the camera pauses until the app is back (privacy default, not asked for by the user). In the app, a mini call window replaces the full-screen call when the user goes elsewhere; on the web, a minimized call window and browser picture-in-picture.
   - *Affects:* 32; iOS picture-in-picture goes to 29/30.
4. **Front/back camera** already existed on Android (26); the back camera's self view is no longer mirrored, and the web gets "Next camera".
5. **Camera filters:** feasibility only (ADR 0037); not built until the user decides.
6. **A new native Android build is required** (calls module, manifest, `with-call-pip` plugin).

### 2026-11-07 — New requirement: the whole UI redone for Gen Z and Gen Alpha, configurable by the user (ADR 0035)
1. **The UI of both apps was replaced by the "Pop" design system.** Requirements from the user: light and dark mode; several color schemes; configurable from settings; interactive animations; standard UI/UX guidelines; icons instead of emoji where applicable. Done before the open phases, by the user's choice.
   - *Affects:* new Phase 31. Finished phases are not reworked beyond their look; their behavior and tests are unchanged.
2. **Appearance is stored per device and never leaves it.** Not a change to the privacy promise; it adds no server data.
3. **Notification text and previews no longer carry emoji** ("Photo", not "📷 Photo"): `attachmentText` returns plain text and the UI draws the icon.
   - *Affects:* 11, 12, 15 (labels only).
4. **Quick reactions changed** to ❤️ 😂 🔥 😮 😢 👍 (🔥 in, 🙏 out). Older reactions still display: any emoji is valid content.
   - *Affects:* 11, 17.
5. **A new native Android build is required** (`react-native-svg`, `expo-haptics`, `expo-font`). Existing dev builds cannot run this JS.

### 2026-11-06 — Android: `DETECT_SCREEN_CAPTURE` is no longer blocked (corrects Phase 27, ADR 0030)
1. **`DETECT_SCREEN_CAPTURE` stays in the manifest.** On Android 14+, expo-screen-capture 58.0.6 registers its screenshot callback as soon as the module loads, whether or not anything listens. Phase 27 blocked the permission that call needs, so builds since then crash at launch on Android 14+ (`Permission Denial: registerScreencaptureObserver`, then `Capture observer already registered`). It is a normal permission: granted at install, no prompt, no access to images. The app still has no screenshot listener. `READ_MEDIA_IMAGES` stays blocked: only the listener for older Android versions uses it, and that code checks first. Needs a new native build.
   - *Affects:* 27 (done; release builds carried the same block).

### 2026-11-03 — Phase 30: iOS nearby and mesh, code only (ADR 0033)
1. **Phase 30 started before Phase 28 was done** (no iPhone, Apple account or Mac): the user asked for Phases 29 and 30. The code and Linux-testable core were written; the phase stays 🔄 until the device matrix (`docs/ops/nearby-ios-matrix.md`).
   - *Affects:* 30.
2. **Between Android and iOS the iPhone always connects** (ADR 0023's "lower token connects" cannot work: iOS cannot advertise a token). Android is unchanged; two iPhones both connect and the duplicate rule closes one.
   - *Affects:* 30 (done), 21–23's design (no Android change).
3. **MultipeerConnectivity and Wi-Fi Aware are deferred** (the phase called them optional): BLE is the only shared path; revisit after device measurements.
   - *Affects:* 30 (open), later.
4. **New dev tool: the Swift toolchain in Docker (`swift:6.4.2-noble`, Apache-2.0)** runs the iOS nearby core's tests on Linux and in CI. Not shipped.
   - *Affects:* 30 (done), CI.

### 2026-11-03 — Phase 29: iOS push and calls, code only (ADR 0032)
1. **Phase 29 started before Phase 28 was done** (Apple account, iPhone and Mac still missing): the user asked for Phases 29 and 30. The code that needs no Apple account was written; the phase stays 🔄 until device checks.
   - *Affects:* 29.
2. **On iOS the wake push is a visible alert with the constant text "New message"** (and `content-available`), not a data-only wake (A2, ADR 0015). iOS never delivers silent pushes to a force-quit app. The alert holds no content (REQ §4.1 holds); the app hides it while open and removes it after fetching. When the app cannot run, mute and preview settings cannot apply to it.
   - *Affects:* 29 (done), 12's design on iOS only.
3. **A Notification Service Extension that decrypts is deferred:** it would share Olm sessions across processes, which cannot be proved safe without a Mac and a device.
   - *Affects:* 29 (open), later.
4. **APNs is called directly** (token auth, `node:http2` + `jose`), not through FCM: VoIP pushes need APNs anyway, and Google then never sees iPhone pushes. New variables `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY_BASE64`, `APNS_BUNDLE_ID` (A11).
   - *Affects:* 29 (done), 20 (staging `.env`).
5. **iPhone calls use CallKit for every incoming call** and are kept out of the Phone app's Recents (iCloud syncs it). No new dependency: a Swift half of `modules/pingdost-calls`.
   - *Affects:* 29 (done).

### 2026-11-03 — Phase 28: iOS groundwork without a Mac (ADR 0031)
1. **Phase 28 started before its prerequisites** (Apple account, iPhone, Mac/EAS): the user asked to start it. Only no-cost groundwork was done; the phase stays 🔄 until the device steps.
   - *Affects:* 28.
2. **iOS builds go through a manual macOS GitHub Actions workflow** (unsigned simulator build) and Linux prebuild checks; device builds are decided once the Apple account exists (EAS or a signed CI archive).
   - *Affects:* 28, 29, 30.
3. **No video compression on iOS yet:** videos up to 100 MB are sent as they are; larger ones are refused with a message, until an AVFoundation module exists (REQ §10.1 allows sending originals that fit).
   - *Affects:* 28.
4. **Google Sign-In on iOS needs its own public variable** `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` (A11); without it iOS hides the button.
   - *Affects:* 28.

### 2026-11-02 — Phase 27: hardening and release readiness (ADR 0030)
1. **A per-sender mailbox budget** (REQ §18 asks to protect against never-delivered queues, without numbers): an account may leave at most 5,000 envelopes per recipient device and 32 MiB of ciphertext in the mailbox per 24 h; beyond that a `Send` is answered `RATE_LIMITED` and stays in the sender's outbox. Online deliveries are not counted.
   - *Affects:* 27 (done).
2. **The mailbox migration drains its backlog in one run, with bulk Mongo writes.** One batch per poll could let staged envelopes outlive their Redis safety TTL (the load test lost 9,400 of 10,000 that way). REQ §19.2's behaviour (verified write before the Redis delete) is unchanged.
   - *Affects:* 27 (done), 08's design (ADR 0010 budget unchanged).
3. **Atlas Free (M0) allows 100 operations per second** (REQ §22 lists only its 512 MB). It is the first capacity limit (docs/ops/capacity.md); a device-owner cache cuts the per-message reads.
   - *Affects:* 27 (done), operations.
4. **Backups exclude more** (REQ §18): the nightly dump also leaves out `attachments`, `email_otps` and `job_locks`. The privacy policy states that security events and abuse reports can stay in a dump up to 7 days past their TTL, and that encrypted remnants can stay in Valkey's append-only file and the host's VPS snapshots for a while.
   - *Affects:* 20 (script), 27 (done).
5. **No crash-reporting SDK; 64-bit Android only for the first release; TURN over TLS stays off** (decisions the plan left open; ADR 0030).
   - *Affects:* 27 (done), 26, 28.
6. **Screenshots are blocked on the recovery-phrase screens** with expo-screen-capture 58.0.6 (MIT; Phase 19 handoff). Its screenshot-listener permissions (`READ_MEDIA_IMAGES`, `DETECT_SCREEN_CAPTURE`) are removed in `app.json`. Needs a new native build.
   - *Affects:* 19, 27 (done).
7. **Release build fixes:** R8 keep rules for react-native-webrtc (the release build had failed since Phase 26) and `SYSTEM_ALERT_WINDOW` removed from the manifest (ADR 0030).
   - *Affects:* 26, 27 (done).
8. **The Play internal-testing release, the staging retention audit, the restore practice and the load re-run on the VPS are left to the user** (they need the US$25 Play account, the VPS or real devices).
   - *Affects:* 27 (open items).

### 2026-11-01 — Phase 26: Android calls (ADR 0029)
1. **Incoming calls use a full-screen-intent call notification and a local module, not a `ConnectionService`.** The phase asked to choose; react-native-callkeep (self-managed ConnectionService) was evaluated and not taken (Telecom coupling, unverified on the new architecture), notifee is unmaintained since 2024. So there is no system call log, car or headset-button integration.
   - *Affects:* 26 (done), 27 (a ConnectionService if wanted; Play Console declarations for `USE_FULL_SCREEN_INTENT` and the `phoneCall` foreground service).
2. **"A call while a GSM call is active" is read from the audio mode** (in a call or ringing), so no `READ_PHONE_STATE` permission is asked. Such a call answers new PingDost invites busy. A GSM call that starts during a PingDost call is not detected; Android's audio focus decides.
   - *Affects:* 26 (done).
3. **A Calls tab** (not in the plan) holds the phone's local call history, call back, the full-screen permission state and Force relay (TURN).
   - *Affects:* 26 (done).
4. **Phase 12's `calls` notification channel is replaced** by the native `incoming_calls` channel (it plays the ringtone), `ongoing_calls`, and `missed_calls`; the old channel is deleted on start.
   - *Affects:* 26 (done).

### 2026-11-01 — Phase 25: calls, TURN and web calls (ADR 0028)
1. **The server learns that a call invite was meant for an offline device.** Signaling is E2EE (REQ §12.2 asks only for authenticated signaling), but an invite carries `PacketFlag.RING` so the gateway can send that device a content-free `{"t":"call"}` push. The server keeps only the time of the last call push per device, in memory, for 15 s. Without it, a callee whose app is closed could not ring.
   - *Affects:* 25 (done), 26 (the phone's call wake), 27 (privacy notice).
2. **A call rings every device of the callee, linked browsers included; the first to answer takes it**, the others are told "answered elsewhere". A reject or busy on any device ends the call. REQ says nothing about several devices.
   - *Affects:* 25 (done), 26.
3. **TURN over TLS (5349) is optional and off on staging.** coturn runs as `nobody` and cannot read Caddy's root-only certificate files; the runbook describes a copy step. Plain TURN on 3478 UDP/TCP is set up.
   - *Affects:* 25 (done), 27 (decide for production).
4. **coturn uses host networking on the VPS**, not Docker-published ports (one proxy per relay port would be heavy). Its ports must be opened in Hostinger's panel firewall (and in ufw, if it is on). The dev Compose profile allows Docker's bridge as a relay peer so relay-to-relay works on one PC; staging refuses every private range.
   - *Affects:* 20, 25 (done).
5. **The TURN username carries the user ID** (`<expiry>:<user ID>`, as planned). coturn logs a line only for problems; those lines can name it with the client's address, and rotate with the other container logs (about a week).
   - *Affects:* 25 (done), 27.
6. **The call history is per device**, a sealed engine setting (at most 200 entries), never synced to linked browsers or uploaded.
   - *Affects:* 25 (done), 26.
7. **Web calls run in whichever tab the user uses**, not only in the tab that holds the connection: every tab runs a call manager on the leader's engine, and the Web Lock `pingdost-call` keeps one call per browser.
   - *Affects:* 25 (done).
8. **New dev dependency: werift 0.25.2** (MIT; its media dependency mediabunny is MPL-2.0, an OSI license) in `tools/sim-client` only, so a headless peer can make and answer real WebRTC calls (tests, and single-phone checks in Phase 26).
   - *Affects:* 25 (done), 26.

### 2026-11-01 — Phase 24: files over the mesh (ADR 0027)
1. **No Wi-Fi bulk path yet: files move over BLE only.** The plan had an optional Wi-Fi Aware or Wi-Fi Direct path. It was evaluated (ADR 0027) but not built: it cannot be tested without two phones, and Wi-Fi Aware hardware support varies. The default mesh file limit is therefore **25 MB** (configurable 10–100 MB in Settings → Nearby messaging, with a time estimate), not REQ's 100 MB.
   - *Affects:* 24 (done), 27 (Wi-Fi Aware once measured), 30.
2. **"Acknowledged after full verification" is the ordinary E2EE delivery receipt, held back.** The manifest says `mesh`; the recipient sends its delivery (and read) receipt only after assembling the file and checking the chunk-hash list, every AEAD tag and the whole-file hash. Per-chunk mesh ACKs only hand storage over from one holder to the next.
   - *Affects:* 24 (done).
3. **Mesh files go only to the contact's phones in a direct chat.** Groups, the sender's other phones and linked browsers are not sent the file over the mesh. A browser fetches it from the phone once online (ADR 0021). If the Internet returns mid-transfer, the file still completes over the mesh only.
   - *Affects:* 24 (done), 27.
4. **Per-chunk integrity is the chunk's own hash (checked by relays) plus the sender's signature (checked by the recipient)**, not a hash list sent ahead. The manifest's list hash is still checked at the end.
   - *Affects:* 24 (done).
5. **The simulation harness is in `packages/message-engine/src/mesh/`** and the key files moved accordingly (`packages/attachments/src/mesh*.ts`, `apps/mobile/src/nearby/files.ts`, `chunk-store.ts`), not `packages/mesh-protocol/src/chunks/*`.
   - *Affects:* 24 (done).

### 2026-11-01 — Phase 23: mesh store-and-forward relay (ADR 0025, ADR 0026)
1. **"Boot restart" is a notification, not a service start.** The plan asked for an optional, best-effort restart at boot. The relay's logic runs in the app's JavaScript, which Android does not start at boot, so a service started then would hold Bluetooth without relaying anything. With "Remind me to turn it back on" (Settings → Nearby relay, off by default), a `BOOT_COMPLETED` receiver posts "Nearby is paused since the restart"; opening PingDost starts nearby and relaying again.
   - *Affects:* 23 (done), 27 (a headless start, if wanted; the Play declaration for `RECEIVE_BOOT_COMPLETED`).
2. **Delivered-ID lists are not authenticated.** Holders drop copies that a peer says were delivered, so a malicious peer can make others drop copies; it could already drop what it carries itself. The sender never drops its own copy on such a list: only the E2EE receipt, or sending it another way, settles the message.
   - *Affects:* 23 (done), 27 (an authenticated delivery proof if abuse appears).
3. **Relay-visible data** (REQ §11.3 allows routing identifiers): daily routing tokens for the recipient and the sender, packet ID, times, hop budget, copies, size, crypto type, and for group traffic the group ID and Megolm session ID. A phone announces its tokens for the whole TTL window to every phone it links to, so the daily rotation hides little from a relay that meets it. No device IDs, names or contents. The Nearby relay screen says this.
   - *Affects:* 23 (done), 27 (privacy notice).
4. **Relaying is part of nearby messaging.** It needs nearby messaging on and is its own opt-in, off by default. The foreground service runs while nearby is on, and its notification reads "PingDost nearby relay active" while relaying. Turning relaying off stops taking and passing on other people's packets at once; packets already held stay until they expire or the user clears the relay cache.
   - *Affects:* 23 (done).
5. **The simulation harness is `packages/message-engine/src/mesh/`**, not `packages/mesh-protocol/test/sim/`: the scenarios need real engines, and `mesh-protocol` sits below the engine.
   - *Affects:* 23 (done).
6. **Nearby recognition stays key-based (ADR 0026).** Contact-only recognition would need a new protocol (A10). Strangers in range can recognise a phone's public device key, as ADR 0024 already says.
   - *Affects:* 23 (done), 27, 30.

### 2026-11-01 — Phase 22: direct nearby messaging (ADR 0024)
1. **After the recipient's phone acknowledges a message over Bluetooth, the state is `sent_to_server`, with the path recorded on the delivery row.** REQ §8.3's names have no state for "the recipient's own phone took it over Bluetooth". The state machine already means "the next hop holds it; only the E2EE receipt delivers it", so the state is reused. Labels and message info name the path ("Sent over Bluetooth to the recipient's phone — not yet delivered") and never show the raw name.
   - *Reason:* a new state would touch the shared enum, both stores, history sync and both UIs, for the same meaning.
   - *Affects:* 22 (done), 23 (relay acceptance stays `relayed`).
2. **The handshake shows strangers this phone's public device key.** While nearby messaging is on, a PingDost phone in range sees that a PingDost phone is near and, once linked, this device's Ed25519 public key. It does not see the device ID, account, name or number, and the app looks nothing up on the server. The key is stable, so a stranger could recognise the phone again. The Settings screen says this. Contact-only recognition (no stable identifier) needs its own protocol, so Phase 23 will consider it under a separate ADR.
   - *Affects:* 22 (done), 23, 27 (privacy notice).
3. **Nearby messaging is off by default and local to each phone.** REQ says nothing about a default. Turning it on goes through a screen that explains the permission first.
   - *Affects:* 22 (done), 27.
4. **An offline fan-out is partial.** When the sender's own directory is not cached (it never needed it), the contact's devices get the message now and the sender's own linked browsers get their copy once the Internet is back. Before this, the whole message waited.
   - *Affects:* 22 (done).

### 2026-10-31 — Phase 21: nearby spike (ADR 0023)
1. **No Google Nearby Connections.** The Phase 21 plan had an optional Nearby Connections path for bulk transfer between Android phones, and Phase 24 would have used it. `play-services-nearby` is closed source under the Android SDK License, which breaks the "permissive or OSI licenses" rule, and it needs Google Play services.
   - *Decision:* the user chose BLE only, with no Google library (2026-10-31).
   - *Trade-off:* no ready-made Wi-Fi upgrade. Phase 24 evaluates Android's own Wi-Fi Aware (which iOS 26 also supports) and Wi-Fi Direct as an optional fast path, and otherwise moves files over BLE, where 100 MB takes many minutes.
   - *Affects:* 21 (done in code), 24, 30.
2. **Nearby needs Android 8.0 (API 26) or newer.** The app still installs from Android 7.0 (minSdk 24); there the nearby screen says the phone is too old. REQ names no minimum version.
   - *Affects:* 22, 27.
3. **BitChat-android is GPL-3.0, not public domain** (the plan said "public domain; confirm the license"). It changed from MIT to GPLv3 in 1.7.x. It is used as a design reference only; no code is copied.
   - *Affects:* 21–24.
4. **The BLE link itself is not paired or encrypted.** Pairing shows system dialogs and leaves a lasting bond identifier. Confidentiality and integrity come from the E2EE layer and Phase 22's signed handshake (REQ §11.3).
   - *Affects:* 22, 23.

### 2026-10-31 — Phase 20: staging deployment (ADR 0013 verification)
1. **Atlas Free allows 500 connections** (REQ §22 says 100), 0.5 GB, 100 ops/s and 10 GB in plus 10 GB out per 7 days (checked 2026-10-31). Nothing changes in the code; the alerts use these numbers.
   - *Affects:* 20, 27.
2. **Monitoring is healthchecks.io plus UptimeRobot, without Grafana.** The server pings a heartbeat (`HEARTBEAT_URL`, new optional variable) from its job loop, and `deploy/scripts/monitor.sh` checks the REQ §18 metrics, Valkey, disk and RAM every 5 minutes and reports problems as a failed ping (one email path for everything).
   - *Trade-off:* no dashboards or history; UptimeRobot's free plan is non-commercial only, so production (Phase 27) needs another outside checker or a paid plan.
   - *Affects:* 20, 27.
3. **`/metrics` is not reachable from the internet** (Caddy answers 404); the monitor reads it inside the VPS. **Caddy keeps no access log** (attachment URLs carry their signature in the query string).
   - *Affects:* 20.
4. **Logs rotate by size** (5 × 10 MB per container), about a week at staging volume, instead of a strict 7 days.
   - *Affects:* 20, 27.
5. **No COEP header** on the web app: the WASM needs no shared memory, and COEP would block Cloudinary avatars. COOP is `same-origin`.
   - *Affects:* 20, 25 (recheck if calls need isolation).
### 2026-10-31 — Phase 19: backup, recovery and replacing the primary phone (ADR 0022)
1. **The recovery phrase's entropy is kept in the phone's secure storage** after it is shown once, so later backups reuse it. REQ §6.3 says the key must never reach the server, analytics or logs (it does not); REQ §7.5 asks for recovery keys in OS secure storage where practical.
   - *Trade-off:* someone with the unlocked phone can make a new backup, but cannot see the phrase that opens it.
   - *Affects:* 19 (done), 27.
2. **A restored phone is a new device**, so no 1:1 Olm session is restored or "marked stale": there are none. Contacts are asked for new sessions (`SessionReset`) and resend what the lost phone missed. This replaces the plan's "sessions marked stale, then reset".
   - *Affects:* 19 (done).
3. **Key-change notices:** only a changed account key shows "safety number changed" and resets verification. A new phone under the **same** account key (approved, or restored) shows "moved to a new phone; the safety number is unchanged" in the direct chat and **keeps** verification. Linked browsers add no notice. The Phase 19 plan said every `keyVersion` change resets verification.
   - *Reason:* only the account key's holder can certify a phone (ADR 0008), and the number the user compared did not change.
   - *Affects:* 19 (done).
4. **Only the active primary phone approves a new phone** (it alone holds the account key); a linked browser can only deny. The plan allowed a linked web device "if the policy allows".
   - *Affects:* 19 (done), 27.
5. **Approving from the old phone moves no history**; the app says to back up first and restore instead.
   - *Affects:* 19 (done), 27 (an online hand-over).
### 2026-10-31 — Phase 18: history sync and web attachments (ADR 0021)
1. **The server never holds sync data, not even briefly.** REQ §13.2 allows a relay to hold encrypted sync chunks "temporarily, with strict short expiry". PingDost relays them only to the online device, in memory, and otherwise answers `RECIPIENT_OFFLINE`.
   - *Reason:* nothing to expire or delete, and a test can prove no writes. Both devices are online during a sync anyway.
   - *Trade-off:* the phone must be online and PingDost open (or within 30 s of leaving it): there is no push wake for a sync, and the browser says "Phone offline — sync paused" meanwhile.
   - *Affects:* 18 (done), 27 (a wake for sync, if wanted).
2. **`device_sync_state` (REQ §14.1) is a sealed engine setting, not its own table**, on the phone (SQLCipher) and in the browser (Dexie).
   - *Reason:* one small JSON state per linked browser, written in the same atomic `apply` as each batch, with the same encryption as everything else.
   - *Affects:* 18 (done). Migration 002's empty `device_sync_state` table stays unused.
3. **History from before pairing comes with a cap per conversation (500 newest messages in the window) as well as the window.** REQ asks for a configurable duration/count; the window is 7/30/90/365 days in the browser's Settings.
   - *Affects:* 18 (done).
4. **Files sent before a browser was linked come from the phone, up to 25 MB by default (10–100 MB in Settings).** Larger ones say to open them on the phone. There is no video compression in the browser: a video over 100 MB is refused there.
   - *Affects:* 18 (done), 27.

### 2026-10-20 — Phase 15: attachments on Android (ADR 0018)
1. **Video compression uses AndroidX Media3 Transformer in a local Expo module (`apps/mobile/modules/pingdost-media`), not react-native-compressor.** ARCHITECTURE A6 and the Phase 15 plan named react-native-compressor, to be re-validated; REQ does not name one.
   - *Reason:* react-native-compressor 2.0.3 is maintained, but it pulls a Nitro C++ build, a JitPack LAME build and LGPL audio libraries we do not need. Media3 (Apache-2.0, Google) is already in the app through expo-video and expo-audio, and it has hardware encoders, progress and cancel.
   - *Trade-off:* about 150 lines of Kotlin to maintain; iOS (Phase 28) needs its own implementation.
   - *Affects:* 15 (done), 28.
2. **Attachment captions are searchable.** Phase 11 indexed text messages only and left captions open.
   - *Affects:* 15, 17 (the web store follows the store contract).
3. **The `AttachmentManifest` gains media details (width, height, duration, voice-note waveform; add-only fields).** Receivers lay out and label files before downloading them.
   - *Affects:* 15, 18 (web reads and writes them).

### 2026-10-20 — Phase 14: attachment staging (ADR 0017)
1. **The local S3 test service is SeaweedFS, not MinIO.** ARCHITECTURE A1 and the Phase 14 plan named MinIO; REQ does not.
   - *Reason:* MinIO's community edition is no longer distributed, and its image pulls were denied on the dev PC. SeaweedFS is Apache-2.0 and serves the same S3 API.
   - *Trade-off:* none in production: `fs` on the VPS disk is the production store, and `s3` stays an R2 option that needs a card.
   - *Affects:* 14 (done), 20.
2. **A total staging cap (`ATTACHMENT_TOTAL_QUOTA_BYTES`, 30 GiB) is added next to the REQ per-user quota.** When it is full, uploads get `ATTACHMENT_STAGING_FULL` (503) until space frees up; nearby transfer (Phase 24) still works.
   - *Reason:* the 50 GB VPS disk is shared with everything else.
   - *Affects:* 15 (show the error), 20 (disk sizing).

### 2026-10-19 — Hosting: one Hostinger VPS, Valkey only (ADR 0013)
1. **Upstash is dropped; the hot mailbox is self-hosted Valkey on the VPS.** REQ §2, §4, §17 and §22 name Upstash Redis.
   - *Reason:* Upstash free (500K commands/month) fits only about 50–60 active users (ADR 0010). Valkey costs nothing extra and was already the dev and test path.
   - *Trade-off:* we run Valkey ourselves (AOF, `noeviction`, a password, never exposed). Losing the VPS loses envelopes still in the Redis stage.
   - *Affects:* 20, 27. Phase 08 is done; ADR 0010 now points to ADR 0013.
2. **Host: one Hostinger KVM VPS (KVM 1 or 2, `x86_64`), bought by the user. Nothing else is paid.** This replaces "Hosting provider decided in Phase 20" (2026-10-18, item 10) and the Oracle Always Free candidate.
   - On the VPS, one Docker Compose stack: API, worker, Valkey, Caddy, attachment staging (`fs`) and coturn.
   - On free tiers: Atlas M0, Cloudflare DNS and Pages, GitHub Actions/GHCR, email and FCM.
   - *Reason:* the user's choice.
   - *Affects:* 14 (`fs` is the production store), 20, 25, 27.
3. **A production `REDIS_URL` must carry a password.** `@pingdost/config` enforces it.
   - *Affects:* 20.

### 2026-10-18 — Phase 3: Android native crypto build
1. **Android ships for 64-bit ABIs only** (`arm64-v8a`, plus `x86_64` for emulators). Phones that run a 32-bit-only Android (some low-end and Android Go devices) cannot install the app for now.
   - *Reason:* the chosen binding, ubrn's `jsi2` JSI player (ADR 0005), ships prebuilt only for 64-bit ABIs.
   - *Mitigation:* build the player for `armeabi-v7a` from ubrn's sources, or switch to ubrn's classic `jsi` flavour. Revisit in Phase 27 with real device data (REQ §14.1 asks for low-end device tests).
   - *Affects:* 03, 20, 27.
2. **Android Auto Backup is disabled** (`allowBackup: false`). REQ does not ask for it; ADR 0003 forbids restoring Olm state from backups. Account recovery stays with Phase 19.
   - *Affects:* 03, 19.

### 2026-10-18 — Initial planning deviations
1. **iOS deferred.** Android + web first; iOS moves to Phases 28–30. REQ §3 says all three platforms at launch, so iOS launch readiness is still required before a "full" launch.
   - *Reason:* the user has Android phones and no Mac or iPhone.
   - *Affects:* all mobile phases.
2. **Google-only social login in v1; Facebook deferred.**
   - REQ §3 lists Google + Facebook, while §6.1 lists only Google.
   - *Reason:* the user's choice; Facebook production login needs Meta app review.
   - *Affects:* 05–07.
3. **Worker is a second entrypoint** (`apps/server/src/worker.ts`), not `apps/worker`. `RUN_WORKER_IN_PROCESS` can co-host it with the API.
   - *Reason:* simpler deployment on a single small VM.
   - *Affects:* 05, 08.
4. **`REDIS_URL` replaces `UPSTASH_REDIS_URL`/`UPSTASH_REDIS_TOKEN`.** One native-protocol URL works with Upstash or self-hosted Valkey.
   - *Reason:* provider portability (REQ §21), given the free-tier command limits.
   - *Affects:* 01, 08, 20.
5. **No BullMQ or QStash initially.** Jobs use a small scheduler with Mongo leases, which REQ §21 allows.
   - *Reason:* the Upstash 500K commands/month free tier.
   - *Affects:* 05, 08.
6. **Temporary attachment staging uses an `AttachmentStore` interface** with `fs` (VPS disk, REQ §22) and `s3` (R2/MinIO) adapters.
   - *Reason:* REQ §10.3 (R2) conflicts with §22 (VPS storage); hosting is not chosen yet.
   - *Affects:* 14, 20.
7. **Cloudinary is used only for user profile avatars** (REQ §22). Group name and avatar are E2EE group-control content and are not stored on the server.
   - *Reason:* privacy.
   - *Affects:* 06, 13.
8. **Web devices authenticate only by QR pairing** from the primary mobile device; there is no password or Google login on web.
   - *Reason:* REQ §6.2 / §13.1 device model.
   - *Affects:* 16.
9. **REQ §20's Phase 0 spikes are scheduled just-in-time.** The crypto gate comes first (Phases 2–3); the other spikes open their tracks (8, 14, 21, 24, 25).
   - *Reason:* only the crypto choice shapes the core architecture; transports sit behind interfaces.
10. **Hosting provider decided in Phase 20.** Development is local on Docker until then.
    - *Reason:* the user's choice.
11. **Project is open source.** The license is confirmed in Phase 1 (AGPL-3.0-or-later recommended).
    - *Reason:* the user's choice.
12. **New env vars** (ARCHITECTURE A11), for example `MESSAGE_MIGRATION_POLL_SECONDS`, `MESSAGE_ONLINE_ACK_TIMEOUT_MS`, `ENVELOPE_MAX_BYTES` and `GOOGLE_CLIENT_IDS`. `GOOGLE_CLIENT_SECRET` is unused because sign-in verifies ID tokens.
