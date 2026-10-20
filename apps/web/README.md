# @pingdost/web

PingDost in the browser: a linked device of the account's phone (ADR 0019). It has no password or Google login; the phone approves it by scanning a QR code.

- `pnpm --filter @pingdost/web dev`: http://localhost:5173 (copy `.env.example` to `.env` first).
- `pnpm --filter @pingdost/web build` / `test`.
- Storage: IndexedDB (Dexie `pingdost`), values sealed with a non-extractable AES-GCM key. This is weaker than a phone keystore, and the browser may evict it.
- Security headers: a strict CSP (no inline code). See `vite.config.ts`.
