# PingDost — Roadmap

Each phase is sized for one Claude session. Start a phase with **"start phase N"** (see `CLAUDE.md`).

Status legend: ⬜ todo · 🔄 in progress · ✅ done · ⏸ deferred

| # | Phase | Depends on | Status |
|---|---|---|---|
| 01 | [Repo bootstrap](phases/phase-01-repo-bootstrap.md) | — | ✅ |
| 02 | [Crypto spike A: Rust core, WASM, license matrix (GATE)](phases/phase-02-crypto-spike-core.md) | 01 | ✅ |
| 03 | [Crypto spike B: mobile shell + native crypto on Android (GATE)](phases/phase-03-mobile-shell-native-crypto.md) | 02 | ✅ |
| 04 | [Protocol & shared contracts](phases/phase-04-protocol-contracts.md) | 02 | ✅ |
| 05 | [Server foundation + password auth](phases/phase-05-server-auth.md) | 01, 04 | ✅ |
| 06 | [Google sign-in, devices, key directory, profiles](phases/phase-06-google-devices-keys.md) | 05 | ✅ |
| 07 | [Mobile onboarding & account UI](phases/phase-07-mobile-onboarding.md) | 03, 06 | ✅ |
| 08 | [Realtime gateway & delivery mailbox](phases/phase-08-gateway-mailbox.md) | 06 | ✅ |
| 09 | [Message engine & session management](phases/phase-09-message-engine.md) | 04, 08 | ✅ |
| 10 | [1:1 chat on Android](phases/phase-10-android-1to1-chat.md) | 07, 09 | ✅ |
| 11 | [Chat features](phases/phase-11-chat-features.md) | 10 | 🔄 |
| 12 | [Push notifications](phases/phase-12-push-notifications.md) | 10 | 🔄 |
| 13 | [Groups (Megolm)](phases/phase-13-groups.md) | 10 | ✅ |
| 14 | [Attachments core](phases/phase-14-attachments-core.md) | 09 | ✅ |
| 15 | [Attachments UX (Android)](phases/phase-15-attachments-android-ux.md) | 10, 14 | ✅ |
| 16 | [Web foundation + QR pairing](phases/phase-16-web-pairing.md) | 09, 10 | 🔄 |
| 17 | [Web chat](phases/phase-17-web-chat.md) | 13, 16 | 🔄 |
| 18 | [History sync + web attachments](phases/phase-18-history-sync.md) | 15, 17 | ✅ |
| 19 | [Recovery & backup](phases/phase-19-recovery-backup.md) | 13, 16 | ✅ |
| 20 | [Deployment (staging)](phases/phase-20-deployment-staging.md) | 12, 14 | 🔄 |
| 21 | [Nearby spike (Android BLE; no Nearby Connections)](phases/phase-21-nearby-spike.md) | 03 | 🔄 |
| 22 | [Direct nearby messaging](phases/phase-22-nearby-direct.md) | 10, 21 | ✅ |
| 23 | [Mesh store-and-forward relay](phases/phase-23-mesh-relay.md) | 22 | ✅ |
| 24 | [Mesh file transfer](phases/phase-24-mesh-files.md) | 15, 23 | ✅ |
| 25 | [Calls A: TURN, signaling, web calls](phases/phase-25-calls-web.md) | 17, 20 | 🔄 |
| 26 | [Calls B: Android calls](phases/phase-26-calls-android.md) | 12, 25 | 🔄 |
| 27 | [Hardening & release readiness](phases/phase-27-hardening-release.md) | 18, 19, 24, 26 | 🔄 |
| 28 | [iOS: build, crypto, core chat](phases/phase-28-ios-core.md) | 27 | 🔄 |
| 29 | [iOS: push (APNs) + calls (CallKit)](phases/phase-29-ios-push-calls.md) | 28 | 🔄 |
| 30 | [iOS: nearby / mesh + Android↔iOS](phases/phase-30-ios-mesh.md) | 28 | 🔄 |
| 31 | [UI/UX refresh: "Pop" design system, configurable appearance](phases/phase-31-ui-refresh.md) | — | 🔄 |
| 32 | [Calls C: voice ↔ video, screen sharing, background, picture-in-picture](phases/phase-32-calls-in-call.md) | 25, 26 | 🔄 |
| 33 | [Calls D: camera filters and effects](phases/phase-33-calls-effects.md) | 32 | 🔄 |
| 34 | [Sign-in and sign-up polish](phases/phase-34-auth-polish.md) | 07, 31 | 🔄 |
| 35 | [Chat look: titles, new-chat button, message times, bubbles, deleted messages, big emoji](phases/phase-35-chat-look.md) | 11, 17, 31 | 🔄 |
| 36 | [Chat composer: emoji picker, keyboard, scrolling](phases/phase-36-chat-composer.md) | 34, 35 | 🔄 |
| 37 | [Circles: nobody can contact you without your consent](phases/phase-37-circles.md) | 13, 17, 26 | 🔄 |
| 38 | [Find people and pick group members](phases/phase-38-people-search.md) | 37 | ⬜ |
| 39 | [Select several messages and forward them](phases/phase-39-select-forward.md) | 35, 37 | ⬜ |
| 40 | [Voice notes: hold to record, slide to cancel, lock, review](phases/phase-40-voice-note-gestures.md) | 15, 36 | ⬜ |

**Order notes**
- Phases mostly run in number order. Where dependencies allow, some can move:
  - 04 can run before 03;
  - 21 (nearby spike) can run any time after 03 to surface Bluetooth risk early;
  - 20 (deployment) can move earlier if real-network testing is needed sooner.
- 34–40 come from the user's UI/UX list of 2026-11-10 (CHANGES):
  - 34, 35, 36 and 40 change only the apps' UI (34 also adds one server endpoint);
  - 37 (Circles) is the largest: server, engine, both apps and every integration suite. It must come before 38 and 39;
  - 36 needs 34's keyboard-library decision.
- REQ §20's Phase 0 spikes are placed just-in-time:

  | Spike | Phase |
  |---|---|
  | Crypto | 02–03 |
  | Redis/queue budget | 08 |
  | Object store | 14 (done: ADR 0017) |
  | Nearby | 21 |
  | 100 MB nearby transfer | 24 |
  | WebRTC | 25 |

- Mesh (21–24) is a launch requirement (REQ §20). The product must not be described as meeting the offline-mesh requirement until Phase 24 is ✅.
  - 2026-11-01: Phases 21–24 are built and **met in simulation only** (ADR 0025, 0027). "Offline-mesh launch requirement met on Android" may be written here only after the open two-phone checks of 21–24 pass.
  - 2026-11-08: the two-phone checks of 22, 23 (two-phone part) and 24 (direct 12 MB with a cut and resume) passed on real phones. The screen-off row works on the vivo only with PingDost exempt from battery optimization (the app now asks for it), and the swiped-from-Recents row works.
  - **2026-11-08: Offline-mesh launch requirement met on Android**, on two phone models (Nothing A001T, vivo V2437; Android 16). Limits: phone makers that freeze background apps need the battery exemption; range, the 1 h battery drain and a three-phone A→B→C run are not measured yet (Phase 21, 23 notes). iOS is Phase 30. Range, the 1 h battery row and the three-phone A→B→C run are recorded as pending, not as blockers.

## Requirement coverage (REQ § → phases)

| REQ § | Topic | Phases |
|---|---|---|
| §1, §5 | Privacy promise, retention, deletion wording | 01 (README), 08, 14, 20, 27 |
| §6.1 | Registration, OTP, login, Google | 05, 06, 07, 34 |
| §6.2 | Device model, revoke | 06, 07, 16 |
| §6.3 | Recovery | 19 |
| §7.1–7.3 | E2EE gate, protocol, properties | 02, 03, 04, 09, 13 |
| §7.4 | Attachment encryption | 02 (ADR), 14 |
| §7.5 | Local encryption, log hygiene | 03, 05, 16, 27 |
| §8.1 | Direct messages (⚠ circle members only, CHANGES 2026-11-10) | 09, 10, 11, 35, 36, 37, 38, 39, 40 |
| §8.2 | Groups | 13, 17, 37, 38 |
| §8.3 | Message states | 09, 10, 22, 23 |
| §9 | Mailbox, retention, migration, monitoring | 08, 20 |
| §10 | Attachments | 14, 15, 18, 24 |
| §11 | Nearby + mesh | 21, 22, 23, 24, (30) |
| §12 | Calls | 25, 26, 32, 33, (29) |
| §13 | Web pairing + sync | 16, 17, 18 |
| §14 | Local storage + controls | 03, 10, 11, 15, 16, 17, 23 |
| §15 | Backend modules | 05, 06, 08, 11, 12, 13, 14, 16, 23, 25, 34, 37, 38 |
| §16 | Data models | 05, 06, 08, 14 |
| §17 | Env config | 01 (+ every phase adds vars) |
| §18 | Reliability, metrics, cost alerts | 08, 20, 27 |
| §19 | Acceptance criteria | each phase's "Done when" + 27 (traceability) |
| §21 | Risks | 02, 08, 20, 21, 27 |
| §22 | Low-cost providers | 05, 06, 14, 20 |
