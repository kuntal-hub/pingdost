# @pingdost/shared-types

Contracts shared by the server and the clients (ARCHITECTURE A2, A8):

- Zod v4 REST DTOs per module (`auth`, `profile`, `devices`, `keys`, `groups`, `attachments`, `pairing`, `health`). DTOs for later phases are stubs that those phases extend.
- `ErrorCode` (shared by REST problem+json and the WebSocket `ServerError`), `ERROR_STATUS`, `ProblemSchema`, `problemType()`.
- Pagination (`PageQuerySchema`, `pageSchema`, `Page<T>`).
- `MessageState` (exactly the REQ §8.3 names) and its legal transitions.
