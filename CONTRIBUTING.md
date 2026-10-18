# Contributing to PingDost

Thanks for your interest! PingDost is licensed under [AGPL-3.0-or-later](LICENSE); by contributing you agree that your contribution is released under the same license.

## Setup

See the quick start in [README.md](README.md). Before opening a pull request, run:

```sh
pnpm format && pnpm lint && pnpm typecheck && pnpm test
```

Run `pnpm test:int` too if you touched code that talks to MongoDB, Valkey or email (it needs `pnpm infra:up`).

## Ground rules

- **Privacy and security** (docs/ARCHITECTURE.md A10):
  - never log message text, attachment bytes, keys, OTPs, passwords, tokens or recovery phrases;
  - no custom cryptography; use the vetted libraries chosen in the ADRs;
  - server secrets never go into client bundles (clients import only `@pingdost/config/public`).
- **Dependencies** must use permissive or OSI-approved licenses. Pin exact versions.
- **Architecture changes** need an ADR in `docs/decisions/` (copy `0000-template.md`).
- Keep pull requests focused, and add tests with behavior changes.

## Reporting bugs

Use GitHub issues for ordinary bugs. Report security problems privately as described in [SECURITY.md](SECURITY.md).
