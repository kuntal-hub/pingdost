# @pingdost/test-fixtures

Shared test vectors (data only; the tests live in the packages that use them):

- `crypto/vodozemac-0.11.1.json`: deterministic crypto vectors (`pnpm --filter @pingdost/crypto make-vectors`).
- `crypto/attachment-stream-v1.json`: attachment encryption vectors, XChaCha20-Poly1305 STREAM (ADR 0004; `pnpm --filter @pingdost/crypto make-attachment-vectors`). Also checked against `@noble/ciphers` in `packages/crypto/test/conformance.test.ts`.
- `protocol/v1.json`: golden wire-protocol vectors, protobuf JSON plus bytes (`pnpm --filter @pingdost/protocol make-vectors`).
- `backup/pdbk-v1.pdbk` + `pdbk-v1.json`: a frozen, synthetic backup of format version 1 and what restoring it must give (Phase 27; `packages/backup/src/compat.test.ts`). Throwaway phrase and keys. **Never regenerate it**: a new format version gets a new file (`pnpm --filter @pingdost/backup make-fixture` after bumping `BACKUP_FORMAT_VERSION`).

Regenerate a file only for a deliberate change, and review its diff.
