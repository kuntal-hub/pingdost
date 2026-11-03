# 0034 — Android development builds from EAS Build (free tier)

- **Status:** Accepted
- **Date:** 2026-11-03
- **Phase:** n.a. (tooling; before the end-of-project device checks)
- **Approved by user:** yes (asked for an EAS dev build to test chat on a phone and the emulator)

## Context
A6 builds the Android dev client locally (`expo run:android`). That needs the long-path and
Ninja setup (ADR 0005), several GB of Gradle output under OneDrive, and a build per ABI: a
phone build (arm64) crashes on the x86_64 emulator. The user wants one installable dev client
for their phone and the emulator, built in the cloud.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| Local `expo run:android` (A6) | No quota, no account | Windows path/Ninja setup, one ABI per build, slow on this PC | — | Free |
| EAS Build, cloud | One APK with both ABIs (`buildArchs`), no local Gradle, shareable link | Free plan: 15 Android builds/month, low-priority queue; the Rust `.so` is not built there | eas-cli MIT | Free plan, no card |
| `eas build --local` | No quota | Not supported on Windows (macOS/Linux only) | MIT | Free |

## Decision
- `apps/mobile/eas.json`, profile `development`: `developmentClient`, `distribution: internal`,
  APK, Node 24.11.0, pnpm 10.28.1 (the repo's pins). `cli.appVersionSource: local`, so
  `versionCode` stays in `app.json` for the Phase 20 release process.
- EAS project `@kuntal-hub/pingdost` (`extra.eas.projectId` and `owner` in `app.json`).
- Root `.easignore`. EAS reads it only from the git root, and it replaces every `.gitignore`.
  It repeats both `.gitignore` files and un-ignores
  `packages/crypto-native/android/src/main/jniLibs/`, so the build ships the Rust library
  built on this PC. EAS has no Rust step, so run `build:android` before an EAS build whenever
  the crate changed.
- Remote Android credentials (EAS generated a keystore for these internal builds). Release
  signing stays with the upload key (Phase 20, `with-release-signing.js`).
- The local build path in A6 stays; EAS is an alternative, not a requirement.

## Consequences
- The JS still comes from Metro on this PC (`pnpm --filter @pingdost/mobile start`), so
  `apps/mobile/.env` (API URLs) still applies, and JS changes need no new build. A new EAS build
  is needed only after native changes: `app.json` plugins, native dependencies, local modules,
  or the Rust library.
- `google-services.json` is not uploaded, so EAS builds have no FCM pushes. If needed, add it as
  an EAS file environment variable and point `GOOGLE_SERVICES_JSON` at it.
- Check what gets uploaded with
  `eas build:inspect -p android -e development --stage archive --output <dir>`.

## Evidence
- Checked 2026-11-03: eas-cli 27.3.0 (MIT). EAS Free plan: 15 Android builds/month, and free
  accounts cannot incur overage (https://expo.dev/pricing, https://docs.expo.dev/billing/plans/).
  `.easignore` is read only from the git root (https://docs.expo.dev/build-reference/easignore/;
  eas-cli issue #4259, PR #4387 still open).
- `build:inspect --stage archive`: 883 files, 13.4 MB, both `libpingdost_crypto.so` included;
  no `node_modules`, `.env`, keystores, or the local `android/`/`ios/`. Upload was 6.6 MB
  compressed.
