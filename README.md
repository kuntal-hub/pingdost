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

Early development. Android and web come first; iOS is deferred. See [docs/ROADMAP.md](docs/ROADMAP.md) for phase status. Nothing here is ready for real use yet.

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

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0-or-later](LICENSE). Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
