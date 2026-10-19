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
| 10 | [1:1 chat on Android](phases/phase-10-android-1to1-chat.md) | 07, 09 | 🔄 |
| 11 | [Chat features](phases/phase-11-chat-features.md) | 10 | ⬜ |
| 12 | [Push notifications](phases/phase-12-push-notifications.md) | 10 | ⬜ |
| 13 | [Groups (Megolm)](phases/phase-13-groups.md) | 10 | ⬜ |
| 14 | [Attachments core](phases/phase-14-attachments-core.md) | 09 | ⬜ |
| 15 | [Attachments UX (Android)](phases/phase-15-attachments-android-ux.md) | 10, 14 | ⬜ |
| 16 | [Web foundation + QR pairing](phases/phase-16-web-pairing.md) | 09, 10 | ⬜ |
| 17 | [Web chat](phases/phase-17-web-chat.md) | 13, 16 | ⬜ |
| 18 | [History sync + web attachments](phases/phase-18-history-sync.md) | 15, 17 | ⬜ |
| 19 | [Recovery & backup](phases/phase-19-recovery-backup.md) | 13, 16 | ⬜ |
| 20 | [Deployment (staging)](phases/phase-20-deployment-staging.md) | 12, 14 | ⬜ |
| 21 | [Nearby spike (Android BLE / Nearby Connections)](phases/phase-21-nearby-spike.md) | 03 | ⬜ |
| 22 | [Direct nearby messaging](phases/phase-22-nearby-direct.md) | 10, 21 | ⬜ |
| 23 | [Mesh store-and-forward relay](phases/phase-23-mesh-relay.md) | 22 | ⬜ |
| 24 | [Mesh file transfer](phases/phase-24-mesh-files.md) | 15, 23 | ⬜ |
| 25 | [Calls A: TURN, signaling, web calls](phases/phase-25-calls-web.md) | 17, 20 | ⬜ |
| 26 | [Calls B: Android calls](phases/phase-26-calls-android.md) | 12, 25 | ⬜ |
| 27 | [Hardening & release readiness](phases/phase-27-hardening-release.md) | 18, 19, 24, 26 | ⬜ |
| 28 | [iOS: build, crypto, core chat](phases/phase-28-ios-core.md) | 27 | ⏸ |
| 29 | [iOS: push (APNs) + calls (CallKit)](phases/phase-29-ios-push-calls.md) | 28 | ⏸ |
| 30 | [iOS: nearby / mesh + Android↔iOS](phases/phase-30-ios-mesh.md) | 28 | ⏸ |

**Order notes**
- Phases mostly run in number order. Where dependencies allow, some can move:
  - 04 can run before 03;
  - 21 (nearby spike) can run any time after 03 to surface Bluetooth risk early;
  - 20 (deployment) can move earlier if real-network testing is needed sooner.
- REQ §20's Phase 0 spikes are placed just-in-time:

  | Spike | Phase |
  |---|---|
  | Crypto | 02–03 |
  | Redis/queue budget | 08 |
  | Object store | 14 |
  | Nearby | 21 |
  | 100 MB nearby transfer | 24 |
  | WebRTC | 25 |

- Mesh (21–24) is a launch requirement (REQ §20). The product must not be described as meeting the offline-mesh requirement until Phase 24 is ✅.

## Requirement coverage (REQ § → phases)

| REQ § | Topic | Phases |
|---|---|---|
| §1, §5 | Privacy promise, retention, deletion wording | 01 (README), 08, 14, 20, 27 |
| §6.1 | Registration, OTP, login, Google | 05, 06, 07 |
| §6.2 | Device model, revoke | 06, 07, 16 |
| §6.3 | Recovery | 19 |
| §7.1–7.3 | E2EE gate, protocol, properties | 02, 03, 04, 09, 13 |
| §7.4 | Attachment encryption | 02 (ADR), 14 |
| §7.5 | Local encryption, log hygiene | 03, 05, 16, 27 |
| §8.1 | Direct messages | 09, 10, 11 |
| §8.2 | Groups | 13, 17 |
| §8.3 | Message states | 09, 10, 22, 23 |
| §9 | Mailbox, retention, migration, monitoring | 08, 20 |
| §10 | Attachments | 14, 15, 18, 24 |
| §11 | Nearby + mesh | 21, 22, 23, 24, (30) |
| §12 | Calls | 25, 26, (29) |
| §13 | Web pairing + sync | 16, 17, 18 |
| §14 | Local storage + controls | 03, 10, 15, 16, 17, 23 |
| §15 | Backend modules | 05, 06, 08, 12, 13, 14, 16, 23, 25 |
| §16 | Data models | 05, 06, 08, 14 |
| §17 | Env config | 01 (+ every phase adds vars) |
| §18 | Reliability, metrics, cost alerts | 08, 20, 27 |
| §19 | Acceptance criteria | each phase's "Done when" + 27 (traceability) |
| §21 | Risks | 02, 08, 20, 21, 27 |
| §22 | Low-cost providers | 05, 06, 14, 20 |
