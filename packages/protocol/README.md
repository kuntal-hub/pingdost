# @pingdost/protocol

The versioned, transport-neutral wire protocol (ARCHITECTURE A4, ADR 0006).

- `proto/pingdost/v1/*.proto`: `TransportPacket`, `Envelope`, `Content`, WebSocket frames, mesh messages.
- `src/gen/`: protoc-gen-es output. Committed; never hand-edit. Regenerate with `pnpm --filter @pingdost/protocol gen`.
- `src/codec.ts`: `encode*`/`decode*` for packets, envelopes, content and frames. They enforce `ENVELOPE_MAX_BYTES`, the major version, expiry and required fields, and throw `ProtocolError`. Always use them instead of raw `toBinary`/`fromBinary`.
- `src/padding.ts`: Content size buckets (256 B / 1 KiB / 4 KiB / 16 KiB, then 16 KiB steps).
- `src/ids.ts`: `uuidv7()`, `envelopeIdFor()`, UUID and base64 helpers.

Golden vectors: `pnpm --filter @pingdost/protocol make-vectors` rewrites `@pingdost/test-fixtures/protocol/v1.json`. Run it only for a deliberate wire change, and review the diff.

`pnpm --filter @pingdost/protocol lint` also runs `buf lint`.

**React Native:** install `TextDecoder` (with `fatal: true`) and `crypto.getRandomValues` on `globalThis` before using this package.

`@pingdost/protocol/signing` exports only the signed-statement formats (`src/signing.ts`); `uuidv7()` and the other ID helpers come from `@pingdost/protocol/ids`. Neither loads the generated protobuf code, so they need only `crypto.getRandomValues` (the mobile app uses them for device setup before Phase 10 adds `TextDecoder`).
