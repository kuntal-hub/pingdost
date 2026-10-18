# @pingdost/test-fixtures

Shared test vectors (data only; the tests live in the packages that use them):

- `crypto/vodozemac-0.11.1.json`: deterministic crypto vectors (`pnpm --filter @pingdost/crypto make-vectors`).
- `protocol/v1.json`: golden wire-protocol vectors, protobuf JSON plus bytes (`pnpm --filter @pingdost/protocol make-vectors`).

Regenerate a file only for a deliberate change, and review its diff.
