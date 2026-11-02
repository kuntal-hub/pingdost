# Release checklist (Phase 27)

Production runs on the same VPS and domains as staging (`api.pingdost.com`, `app.pingdost.com`; ADR 0013). "Promoting" means hardening the one stack and its configuration, not building a second one.

## Before the first public build
- [ ] REQ §19 traceability: every ⏳ row in `docs/security/acceptance.md` has a recorded result (device checks of Phases 10–26).
- [ ] Audits re-run (`docs/security/audits.md`): CI green on `main` (lint, typecheck, tests, integration, secrets, advisories, licenses, bindings).
- [ ] Retention audit on the VPS passes (`docs/ops/retention-audit.md`).
- [ ] A metadata restore practised (`docs/ops/restore-metadata-db.md`).
- [ ] Legal: bracketed fields in `docs/legal/privacy-policy.md` and `terms.md` filled in and reviewed; the policy published at a public URL; the in-app explainer (`packages/chat-core/src/privacy.ts`) still matches.
- [ ] Capacity re-measured on the VPS (`docs/ops/capacity.md` §5); Atlas alerts set (350 MB, 60 ops/s).
- [ ] **Account deletion** (Google Play requires an in-app path and a web URL for apps with accounts): not built yet. Until it is, the privacy policy names an email address for deletion requests; build the flow before production access.

## Server: promote staging to production
1. `.env` on the VPS (`/srv/pingdost/.env`):
   - `LOG_LEVEL=info` (`NODE_ENV=production` and `TRUST_PROXY=true` are already fixed in `compose.staging.yml`);
   - a real email provider (`EMAIL_PROVIDER` + ZeptoMail/Brevo values), not the console provider;
   - fresh secrets if staging ones were ever shared (`ACCESS_TOKEN_SIGNING_KEY`, `SERVER_HMAC_PEPPER`, `METRICS_TOKEN`, `VALKEY_PASSWORD`, `TURN_SHARED_SECRET`): rotating them signs everyone out, so do it **before** inviting testers;
   - `WEB_ORIGIN=https://app.pingdost.com`, `PUBLIC_API_URL=https://api.pingdost.com`;
   - FCM and VAPID keys set (push).
2. Atlas: a fresh database name for production (e.g. `MONGODB_URI=…/pingdost`) if the staging one holds test accounts you do not want; Network Access lists only the VPS IP.
3. Tag a release: `git tag v0.1.0 && git push origin v0.1.0` (the deploy workflow builds the image and deploys it; you push, per CLAUDE.md).
4. Check `/readyz`, the alerts (alerts.md "Test the alerts") and a two-device chat.
5. TURN over TLS stays off (ADR 0030); open ports per vps-setup.md "Calls".

## Web: production deploy (Cloudflare Pages)
1. Pages project → Settings → Environment variables (**Production**): `VITE_API_URL=https://api.pingdost.com`, `VITE_WS_URL=wss://api.pingdost.com/v1/ws`, `VITE_WEB_PUSH_PUBLIC_KEY=<VAPID public key>`, `NODE_VERSION=24`.
2. Production branch `main`; every push builds. Deployments → the latest → **Retry deployment** after changing variables.
3. Check `https://app.pingdost.com`: the response headers include the CSP with `frame-ancestors 'none'` and HSTS (`curl -sI https://app.pingdost.com | findstr /i "content-security strict-transport"`); pair it with a phone.

## Android: internal testing
Follow `docs/release/play-console.md` (US$25 Play account first: your decision). Versioning: SemVer `version`, `versionCode` +1 per upload (ADR 0030).

## Crash reporting
None in the app (ADR 0030). Watch Play Console → Android vitals after the internal release; reproduce crashes with a debug build and the dev logs (`__DEV__` only).

## After each release
- Record the version, date and the checks above in docs/PROGRESS.md.
- Review `pnpm-workspace.yaml` `auditConfig.ignoreGhsas` and the Expo/tsup versions.
