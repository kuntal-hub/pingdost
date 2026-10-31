# syntax=docker/dockerfile:1.7
# The API, gateway and jobs in one image (ADR 0013), for linux/amd64. Build from the repo root:
#   docker build -f apps/server/Dockerfile --platform linux/amd64 -t pingdost-server .
# The bundle (tsup) inlines the workspace packages; `pnpm deploy --prod` adds only the npm
# packages it needs at runtime (including the native Argon2 binding for linux-x64-gnu).
ARG NODE_IMAGE=node:24.22.2-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV CI=1 PNPM_HOME=/pnpm COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@pingdost/server..."
# `deploy` copies the package with its fresh `dist/`; sources and build configs are dropped.
RUN pnpm --filter @pingdost/server build \
 && pnpm --filter @pingdost/server deploy --prod --legacy /out \
 && cd /out && rm -rf src test scripts Dockerfile README.md tsconfig.json ./*.config.ts \
 && test -f dist/main.js

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Root-owned and read-only for the app user; only the attachment volume is writable.
COPY --from=build /out /app
RUN mkdir -p /data/attachments && chown node:node /data/attachments
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
