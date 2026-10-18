# @pingdost/config

Zod-typed environment parsing (REQ §17 + ARCHITECTURE A11). `@pingdost/config/public` holds client-safe constants and `EXPO_PUBLIC_*` / `VITE_*` parsing (ARCHITECTURE A1, A10).

- `loadServerConfig(env = process.env)` (server only): validates every variable, applies dev defaults outside production, and throws `ConfigError` listing variable names and problems. Error messages never include values.
- `loadPublicConfig(env, prefix)` (clients): parses `API_URL` / `WS_URL` with the `EXPO_PUBLIC_` or `VITE_` prefix.
- Mobile and web code may import **only** `@pingdost/config/public`; ESLint enforces this.
