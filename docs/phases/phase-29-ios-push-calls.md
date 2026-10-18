# Phase 29 — iOS: APNs push + CallKit calls (DEFERRED)

**Depends on:** 28 · **Platforms:** iOS · **Status:** ⏸

## Goal
Content-free wake notifications and reliable incoming calls on iOS.

## Read first
- REQ §4.1 (Push), §12
- ARCHITECTURE A2 (Push)
- The Phase 12 and Phase 26 ADRs and notes

## Tasks (outline)
- [ ] An `apns` adapter in `PushNotifier`, either direct (token-based .p8 key) or FCM for iOS. Decide by ADR, with privacy and simplicity in mind.
- [ ] Message wake. Because silent pushes are throttled on iOS, evaluate a Notification Service Extension that fetches and decrypts locally to show content (keys shared via an app group + keychain access group). Keep payloads content-free.
- [ ] VoIP push (PushKit) + CallKit for incoming calls; iOS requires reporting every VoIP push to CallKit. Audio session handling; react-native-webrtc iOS config.
- [ ] Test matrix: iPhone↔Android, iPhone↔web, locked or killed app, network switch.

## Done when
The REQ §19.5 call criteria pass on iOS, and message notifications work with the app killed.
