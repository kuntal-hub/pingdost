# 0001 — Project license: AGPL-3.0-or-later

- **Status:** Accepted
- **Date:** 2026-10-18
- **Phase:** 01
- **Approved by user:** yes (Phase 1 question, 2026-10-18)

## Context
The user chose to open-source PingDost (docs/CHANGES.md #11). The license constrains which E2EE libraries we can ship (REQ §7.2, decided in Phase 2), and whether others can run closed, modified hosted copies of the server. ARCHITECTURE A10 requires dependencies with permissive or OSI licenses.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| AGPL-3.0-or-later | Network copyleft: hosted forks must publish their changes. Compatible with AGPL libsignal if Phase 2 picks it. Compatible with permissive deps (MIT, Apache-2.0, BSD, ISC) and MPL-2.0 (vodozemac's Apache-2.0 too). | Some companies avoid AGPL code. Every distributed app (APK, web bundle) must offer its source. | OSI | Free |
| MPL-2.0 | File-level copyleft, easy to embed | Cannot bundle AGPL libsignal. Weak protection against closed hosted forks. | OSI | Free |
| Apache-2.0 | Permissive, patent grant, widest adoption | Allows closed forks. Cannot bundle AGPL libsignal. | OSI | Free |

## Decision
License the whole repository under **AGPL-3.0-or-later**:
- root `LICENSE` holds the official GNU text (gnu.org, SHA-256 `0d96a4ff…abcb0`);
- every `package.json` has `"license": "AGPL-3.0-or-later"`.

## Consequences
- Dependencies stay limited to licenses compatible with AGPL-3.0 (permissive, MPL-2.0, LGPL, GPL-3.0, AGPL-3.0). GPL-2.0-only code is incompatible and must not be added.
- Phase 2's crypto ADR may choose libsignal (AGPL) or vodozemac (Apache-2.0); both are compatible.
- Phase 27 (release) must provide source availability for distributed builds: a link to the public repo in the app's About screen and store listing.
- Google Play distribution of AGPL apps is allowed. Apple App Store compatibility (iOS track, Phases 28–30) should be re-checked then.
- Contributions are accepted under the same license (CONTRIBUTING.md).

## Evidence
- User answer to the Phase 1 license question, 2026-10-18.
- License text downloaded from https://www.gnu.org/licenses/agpl-3.0.txt on 2026-10-18 (34,523 bytes).
