# 0027 — Files over the mesh: signed chunks, resume bitmaps, receipt after verification

- **Status:** Accepted
- **Date:** 2026-11-01
- **Phase:** 24
- **Approved by user:** n.a. (follows the Phase 24 plan; the user approved starting before Phases 15 and 23 are ✅)

## Context
REQ §10.2 bullet 3: when neither side has the Internet, files go as chunked, encrypted store-and-forward through nearby devices. REQ §11.4: integrity per chunk and for the whole file, and resume after devices go out of range. REQ §19.3 (last bullet): acknowledge only after the recipient has assembled and verified the complete file.

What exists:
- The attachment format (ADR 0004) is XChaCha20-Poly1305 STREAM over 64 KiB chunks, kept locally as ciphertext (ADR 0018). The manifest carries the whole-ciphertext SHA-256 and the SHA-256 of the per-chunk hash list.
- The relay (ADR 0025) has routing tokens, signed statements, spray-and-wait, signed ACKs, the relay store and summaries.
- BLE links carry packets up to 128 KiB (ADR 0023); throughput is expected at 50–150 KB/s (the measurement matrix is still open).
- Google Nearby Connections is out (CHANGES 2026-10-31).

## Options considered
**Chunk size**
| Option | Pros | Cons |
|---|---|---|
| **One STREAM ciphertext chunk (65,552 B) per mesh chunk (chosen)** | No re-encryption or re-cutting: the receiver's file is byte for byte the server's. The format's own checks apply. One BLE packet per chunk. | Mid-size for BLE: a link drop loses up to 64 KiB in flight. |
| Smaller chunks (e.g. one GATT write) | Finer resume. | Many more packets, signatures and ACKs; another layer of framing. |
| Larger chunks for Wi-Fi | Fewer round trips. | No Wi-Fi path yet (below). |

**Per-chunk integrity**
| Option | Pros | Cons |
|---|---|---|
| Send the hash list first, check chunks against it | Relays and the recipient check each chunk against a list the manifest commits to. | Relays cannot check the list (the manifest is E2EE), so they could still carry garbage. An extra special chunk. |
| **The chunk's SHA-256 in its ref, checked by everyone, and the sender's Ed25519 signature over the header plus that hash, checked by the recipient (chosen)** | Relays drop corrupt chunks (REQ §11.4: "integrity verification per chunk"). The recipient knows every chunk is the sender's. At the end the hash list, every AEAD tag and the whole-file hash are checked anyway. Same pattern as ADR 0025. | One signature per chunk (cheap). |

**Resume**
| Option | Pros | Cons |
|---|---|---|
| Explicit "send me chunks i–j" requests | Precise. | A new message type and request bookkeeping per holder. |
| **The recipient's `MeshSummary` carries a bitmap per incoming transfer (chosen)** | Holders skip what it has, and resume after any reconnect with no extra round trip. "Complete" in the same list makes holders drop every chunk of it. | Bitmaps go stale during a long link: each chunk is offered once per link anyway. |

**When the sender sees "delivered"**
| Option | Pros | Cons |
|---|---|---|
| On the manifest's receipt, as for server attachments | No change. | REQ §19.3: the file may still be incomplete. |
| **The manifest says `mesh`; the recipient's engine holds its delivery (and read) receipt until the app has assembled and verified the file (`confirmMeshFile`) (chosen)** | The ordinary E2EE receipt is the file's acknowledgement: the sender's states need nothing new. | A new manifest field (add-only). The recipient must confirm. |

**Bulk path (Wi-Fi)**
| Option | Pros | Cons |
|---|---|---|
| Wi-Fi Aware (NAN) | Platform API since Android 8.0; much faster than BLE; iOS 26 supports it too (ADR 0023 Evidence), which matters for Phase 30. No library, no license question. | Hardware support varies (`FEATURE_WIFI_AWARE`; many low-end phones lack it). Needs `NEARBY_WIFI_DEVICES` on Android 13+ (location before). A data path per peer pair. Untestable here: no two phones. |
| Wi-Fi Direct with the group name and passphrase over BLE (`WifiP2pConfig.Builder`, API 29) | Widely supported; no invitation dialog. | Often interrupts the phone's normal Wi-Fi; not on iOS. |
| **BLE only for now (chosen)** | Works today on every Android 8+ phone with the relay already built. | Slow: about 1–4 minutes per 10 MB per hop at the expected rates. |

## Decision
**Wire (add-only, v1; `buf breaking` clean):**
- `AttachmentManifest.mesh` (18): the file travels as mesh chunks. The thumbnail's manifest says so too.
- `MeshChunk` gains `origin_token` (3) and `signature` (4). `meshChunkMessage` = `"pingdost/mesh-chunk/v1"` ‖ 0x00 ‖ packet ID (16) ‖ created (8) ‖ expires (8) ‖ dst (16) ‖ origin token (16) ‖ transfer ID (16) ‖ index (4) ‖ count (4) ‖ chunk SHA-256 (32), big-endian. The data is bound through its hash.
- A chunk's packet ID is `meshChunkPacketId` = the first 16 bytes of SHA-256(`"pingdost/mesh-chunk-id/v1"` ‖ 0x00 ‖ transfer ID ‖ index). Every copy has the same ID, so seen-caches dedupe.
- `MeshSummary.transfers` (3): `MeshTransferState { transfer_id, have (bitmap, least significant bit first), complete }`, at most 16 per summary.
- Limits: 4,096 chunks per transfer, and one ciphertext chunk per payload (`MESH_CHUNK_MAX_BYTES`).

**Relay (`MeshRelay`):**
- **Sending.** `sendFile({ transferId, recipientDeviceId, count, read(i) })` reads chunks lazily from the vault copy and signs each when it is offered.
  - It offers missing chunks straight to the recipient's device when that device is linked and proved its key (known peer), skipping what its bitmap says it has.
  - It sprays to relay-capable peers with `chunkCopies` = 4 (binary spray-and-wait).
  - `withdrawFile` ends it (delivered, cancelled, paused).
- **Relays:**
  - `checkMeshChunkPacket`: header rules, the packet ID, and `sha256(data) == chunk_sha256`, so corrupt chunks are dropped (`corrupt`).
  - Chunks are stored with `kind: chunk` under their own per-origin byte budget (`perOriginMaxChunkBytes` = 110 MiB, room for one 100 MB file) and a chunk rate per neighbour (600/min, burst 300).
  - Chunks are handed to peers whose tokens match, minus what their bitmap says they hold. A peer's complete transfer drops every chunk of it, and is passed on only by holders.
- **Receiving:** the sender's token is resolved and its signature checked. The chunk goes to the sink (`MeshFileSink`) and is answered DELIVERED once stored. Paused or cancelled transfers are refused.
- `transfersChanged()` sends new summaries at once (at least 2 s apart per link), so a finished file stops other holders quickly.
- Messages go before chunks in every offer round.

**Receiver (`MeshFileReceiver`, `@pingdost/attachments`):**
- It keeps a bitmap per transfer and stores chunks durably before the ACK (Android: `mesh_incoming_chunks`, migration 009).
- It accepts chunks before their manifest, for up to 16 unknown transfers.
- Once every chunk is here and the manifest is known, `verifyMeshFile` checks the chunk-hash list against the manifest, then every AEAD tag and the whole-ciphertext hash (`verifyStream`).
  - Pass: `verified` (Android writes the vault file, marks the row `done` and calls `engine.confirmMeshFile`). The transfer is announced complete.
  - Fail: the chunks are dropped and come again (the sender keeps its copy).

**Engine:**
- `AttachmentInfo.mesh` and `meshConfirmed`. An incoming `mesh` attachment queues no delivery receipt, and `markRead` skips its read receipt.
- `confirmMeshFile(messageId)` queues both and marks it confirmed.
- `routesTo(userId)` returns the route for each of the user's non-browser devices.

**Android:**
- A file goes over the mesh only when all of these hold: a direct chat; no device of the contact reachable over the Internet; at least one reachable over nearby or the mesh; the ciphertext within the user's limit (Settings → Nearby messaging: 10/25/50/100 MB, default 25 MB, with a BLE time estimate).
- Such a file has no staged upload and no held message. Its rows have `via = 'mesh'`, so the server runner skips them; the receiver takes them automatically (no data cost).
- The bubble line reads "Over Bluetooth: 12 / 161 chunks received", "Forwarded by 2 devices — not yet delivered", or "Waiting for a nearby route · about 2–4 min over Bluetooth". Pause, resume and cancel work on both sides.
- After a restart, outgoing rows are offered again and incoming ones expected again.

## Consequences
- **No Wi-Fi bulk path yet.** 100 MB over BLE is slow, hence the 25 MB default. Wi-Fi Aware is the first candidate once two phones and ADR 0023's measurements exist (Phase 27, and Phase 30 for iOS).
- Mesh files go only to the contact's phones in a direct chat. Not to groups, not to the sender's own other phones, and not to linked browsers.
  - A browser gets the manifest later over the Internet and needs the file from the phone (ADR 0021 `fetchFromPhone`). The web client should go there first for `mesh` manifests (Phase 27).
- If the Internet comes back during a mesh transfer, the file still goes only over the mesh: there is no switch to staging (Phase 27).
- Offers are stop-and-wait per link: one signed ACK per 64 KiB chunk, small next to BLE airtime. Pipelining stays open.
- Relays' and receivers' JavaScript SHA-256 (`@noble/hashes`) costs about 0.7 ms per chunk on a desktop. Phones are slower; measure on devices (ADR 0023 matrix).
- Incoming chunks sit in SQLCipher until assembled (up to the file size), then are deleted. They are wiped at sign-out.
- Updated: ARCHITECTURE A4/A6; CHANGES 2026-11-01 (Phase 24); ROADMAP note; Phase 27 and 30 handoffs; CLAUDE.md.

## Evidence
- Tests (2026-11-01):
  - `packages/protocol/src/mesh.test.ts`: chunk codec limits, packet IDs, statement layout, summary bitmaps;
  - `packages/mesh-protocol/src/chunks.test.ts`: bitmap, corrupt and misnamed chunks, chunk quotas;
  - `packages/attachments/src/mesh.test.ts`: chunk ranges equal the STREAM chunks, the list digest equals the manifest's, an incomplete, reordered or flipped file is refused;
  - `packages/message-engine/src/mesh/files.test.ts`, real engines and encryption:
    - a 10 MB file (161 chunks) A → B → C with link drops on both hops, resumed from bitmaps; no receipt and A still "Forwarded" while incomplete; verified, then the receipt returns C → B → A; nothing on the server;
    - a corrupt chunk at B is refused at C and sent again directly by A;
    - B's chunk quota holds and the file still arrives directly;
    - pause, resume and cancel at the receiver;
  - `apps/mobile/src/nearby/chunk-store.test.ts` (migration 009 under the receiver, across a restart), `attachments/mesh-status.test.ts` (wording).
- Wi-Fi facts: Android API levels from the platform documentation as known when the plan was written; not re-checked in this session. iOS 26 Wi-Fi Aware from ADR 0023's dated research.
- Not run on phones (see PROGRESS).
