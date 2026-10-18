# Phase 25 — Calls A: TURN, E2EE signaling, web calls (+ WebRTC spike)

**Depends on:** 17, 20 · **Platforms:** server, infra, web

## Goal
One-to-one audio and video calls in the browser over WebRTC. Signaling is E2EE, ephemeral and device-bound, and short-lived credentials give access to a self-hosted coturn. Calls are tested both direct and TURN-relayed.

## Read first
- REQ §12 (all), §5.2 (call records), §17 (STUN/TURN vars), §19.5 (call bullets)
- ARCHITECTURE A4 (ephemeral)

## Tasks
- [ ] **coturn:**
  - compose profile `calls` for dev; a service in `deploy/compose.staging.yml`;
  - `use-auth-secret` + `static-auth-secret` (= `TURN_SHARED_SECRET`), realm;
  - relay port range; `denied-peer-ip` for private and metadata ranges (block SSRF into the VPS network);
  - TLS on 5349 via Caddy certs if feasible; no logging of peers beyond the minimum.
  - Open the firewall ports on the staging host.
- [ ] **Server:**
  - `GET /v1/calls/turn-credentials` follows the TURN REST API convention: username = `expiry:userId`, credential = base64 HMAC-SHA1(secret, username), TTL `TURN_CREDENTIAL_TTL_SECONDS`. It returns `iceServers` from `STUN_URLS` / `TURN_URLS`. Rate-limited.
  - **No call records stored**, only transient in-memory call state with short expiry.
- [ ] **`packages/call-engine`:**
  - the shared state machine (REQ §12.2): idle → outgoing / incoming → ringing → connecting → connected → reconnecting → ended (completed / rejected / busy / no-answer / failed);
  - timeouts: ring 45 s, offer expiry;
  - `CallSignal` content (offer, answer, ice, hangup, reject, busy, renegotiate) sent as **E2EE ephemeral envelopes**, bound to `callId` + caller/callee device IDs;
  - glare handling; busy when already in a call.
- [ ] **Web implementation:**
  - `getUserMedia` with permission states;
  - `RTCPeerConnection` with server iceServers;
  - mute, video on/off, device selection (mic/camera/speaker where supported);
  - incoming-call modal (Web Push wake shows "Incoming call", which opens the app);
  - in-call UI; network-change handling (ICE restart);
  - a **"Force relay (TURN)" debug toggle** (`iceTransportPolicy: 'relay'`).
  - The 1:1 call buttons appear in 1:1 chats only; **groups have none** (REQ §19.5).
- [ ] **WebRTC spike record:**
  - browser↔browser on the same LAN, across different networks (e.g. a phone hotspot), and TURN-forced;
  - measure setup time;
  - verify the server only ever sees ciphertext signaling (no SDP or ICE in logs or stores);
  - a local-only call history list.
- [ ] **Tests:** call-engine state machine unit tests (all transitions and timeouts); TURN credential generation tests (an HMAC vector matching coturn's expectation).

## Key files
`packages/call-engine/src/*`, `apps/server/src/modules/calls/*`, `apps/web/src/features/calls/*`, `deploy/coturn/turnserver.conf`, `docker-compose.yml` (calls profile)

## Out of scope
Android calls (26); group calls (never).

## Done when
- Web↔web audio and video calls work both direct and TURN-forced through staging coturn.
- Logs and stores contain no SDP plaintext.
- The tests pass, and `pnpm lint typecheck test` passes.
