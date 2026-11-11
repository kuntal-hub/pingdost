# PingDost

**PingDost** ([pingdost.com](https://pingdost.com)) is a privacy-first, offline-capable messenger:


- end-to-end encrypted 1:1 and group chat, plus encrypted attachments;
- local-first history, where your phone is the primary device;
- nearby messaging over Bluetooth, with opt-in multi-hop mesh relay;
- web clients linked to your phone by QR code;
- 1:1 audio/video calls over WebRTC.

## Privacy promise

> Conversation history is stored on users' devices, not maintained as a permanent server-side archive. End-to-end encrypted message envelopes and encrypted attachments may be held temporarily on servers to deliver them to offline recipients, but must expire and be deleted under defined retention policies. Account and device metadata may be stored in the database.

In short: **no permanent server-side chat history.** Encrypted messages for offline recipients are queued temporarily and deleted after delivery or after the retention limit (14 days by default). PingDost does not claim that no data ever touches a server.

## Status

**Pre-release (Phase 27 of the roadmap, November 2026).** Android and web are built and tested in code; real-device checks and the Play internal-testing release are still open. **iOS is not available yet** (Phases 28–30 need an Apple Developer account and an iPhone). Not ready for real use until the release checklist in [docs/release/README.md](docs/release/README.md) is done. Phase status: [docs/ROADMAP.md](docs/ROADMAP.md).

| Feature | Android | Web | How it is verified |
|---|---|---|---|
| Accounts: email + password, Google sign-in, device management | built | linked browser | automated tests; device checks open |
| End-to-end encrypted 1:1 and group chat (vodozemac: Olm, Megolm) | built | built | automated tests incl. a real server |
| Replies, edits, deletes, reactions, receipts, search, blocks, reports | built | built | automated tests |
| Encrypted attachments up to 100 MB, compression, resumable transfers | built | built (no video compression) | automated tests; 100 MiB spike |
| Content-free push wakes (FCM, Web Push) | built | built | automated tests; device checks open |
| QR-linked browsers with recent-history sync from the phone | phone side | built | automated tests |
| Encrypted backups with a recovery phrase; replacing the phone | built | — | automated tests; device checks open |
| Nearby messaging over Bluetooth, opt-in mesh relay, files over the mesh | built (Android 8+) | — | **simulation only**; two/three-phone checks open |
| 1:1 audio/video calls (WebRTC, TURN) | built | built | automated tests and a browser call; phone matrix open |
| Group calls | not planned | not planned | — |

Known limits are stated honestly in the [threat model](docs/security/threat-model.md): the server sees routing metadata, browser storage is weaker than the phone's, and history cannot be recovered without a backup.

## Quick start

Prerequisites: Node 24, pnpm 10 (`corepack enable` or a global install), and Docker Desktop.

```sh
pnpm install
pnpm infra:up      # MongoDB (replica set), Valkey, Mailpit; waits until healthy
cp .env.example .env
pnpm lint && pnpm typecheck && pnpm test
```

Mailpit's inbox (dev email, e.g. OTPs) is at http://localhost:8025. Stop the infrastructure with `pnpm infra:down`.

| Command | What it does |
|---|---|
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | ESLint, `tsc` and Vitest unit tests in every package (Turborepo) |
| `pnpm test:int` | Integration tests (`*.int.test.ts`) against the docker-compose services |
| `pnpm test:watch` | All unit-test projects in watch mode |
| `pnpm format` / `pnpm format:check` | Prettier |
| `pnpm infra:up` / `infra:down` / `infra:logs` | Local MongoDB, Valkey and Mailpit |

## Repository layout

pnpm + Turborepo monorepo, TypeScript strict. `apps/` holds the mobile (Expo), web (Vite) and server (Fastify) apps as they are built. `packages/` holds shared modules (`@pingdost/*`), and `tools/` holds dev tooling. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Docs

- [Architecture decisions](docs/ARCHITECTURE.md), [ADRs](docs/decisions/)
- [Roadmap](docs/ROADMAP.md), [progress log](docs/PROGRESS.md), [requirement changes](docs/CHANGES.md)
- [Requirements baseline](privacy_first_messaging_app_requirements.md)
- Security: [threat model](docs/security/threat-model.md), [REQ §19 traceability](docs/security/acceptance.md), [audits](docs/security/audits.md)
- Operations: [runbooks](docs/ops/), [capacity](docs/ops/capacity.md), [release checklist](docs/release/README.md); drafts of the [privacy policy](docs/legal/privacy-policy.md) and [terms](docs/legal/terms.md)

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0-or-later](LICENSE). Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
