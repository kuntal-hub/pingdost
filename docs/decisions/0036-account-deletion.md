# 0036 — Account deletion

- **Status:** Accepted
- **Date:** 2026-11-09
- **Phase:** 27
- **Approved by user:** n.a. (the user asked for the open Phase 27 items to be built)

## Context
Google Play requires apps with accounts to let people delete their account from inside the app, plus a web resource to request it (`docs/release/README.md`). The privacy policy promised deletion "when it ships" (REQ §5: retention and deletion wording). PingDost keeps no permanent chat history on the server (ARCHITECTURE A3), so what remains to delete is account and routing data: the user record, sessions, devices and their keys, mailboxes, group memberships, blocks, pending pairing and phone-transfer requests, and email codes.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| Hard delete after an email code (chosen) | Nothing personal left; the email code works for password and Google accounts alike; reuses `sendAccountOtp`/`checkAccountOtp` | The username becomes free again | — | free |
| Tombstone (keep the user ID and username, strip the rest) | A username cannot be taken over | Keeps an identifier of a person who asked to be forgotten | — | free |
| Also require a recent login (like `primary_replace`) | Stronger against a stolen, unlocked phone | Long-installed phones would have to log out and in first; the email code already proves the mailbox | — | free |
| Deletion by email request only | Nothing to build | Not allowed by Play for production | — | free |

## Decision
- `POST /v1/me/delete/code` emails a `delete_account` code; `POST /v1/me/delete {otp}` deletes. Any signed-in session of the account may ask (the code proves the mailbox). Rate limit `accountDelete`: 10 per hour per IP; the OTP throttles apply as for other codes.
- `AccountDeletion.delete` (`apps/server/src/modules/account/deletion.ts`), in this order:
  1. check the code;
  2. revoke every active device (`revokeDevice`: one-time keys, device sessions, push tokens, and the live socket is told, so the apps wipe themselves), then empty each device's mailbox from Redis and Mongo (`DeliveryService.purgeDevice`);
  3. leave every group (`removeMember` on itself: an owner hands over, members are notified);
  4. delete blocks both ways (`BlockService.removeUser`, cache dropped), pairing and phone-transfer requests, email codes, sessions and device records;
  5. delete the user record last, so a failure part-way can be retried with a new code;
  6. record a `security_events` entry `account_delete` (its own retention, `SECURITY_EVENT_RETENTION_SECONDS`).
- Kept: envelopes this account already sent to other people (they belong to the recipients and expire with the mailbox retention), staged attachments for them (same), abuse reports (`ABUSE_REPORT_RETENTION_SECONDS`).
- Hard delete: the username is free again. Contacts' chats point at the old user ID, so a newcomer with the same username appears as a new contact, never inside an old chat.
- Android: Settings → **Delete account** (`apps/mobile/src/screens/settings/delete-account.tsx`, `src/recovery/delete-account.ts`): what goes and what stays, the email code (the shared `CodeStep`), then the chat engine stops, the server deletes, and the phone runs the Remove-data wipe.

## Consequences
- Not done yet (follow-ups for Phase 27):
  - the profile picture on Cloudinary is not deleted (needs Cloudinary's signed Destroy API; avatars are off unless the Cloudinary variables are set);
  - the web app has no Delete account entry (Play needs it in the Android app; a browser is a linked device);
  - Play's web resource: a page or address where people without the app can ask (the privacy policy names how).
- `docs/legal/privacy-policy.md` and `docs/release/README.md` describe the in-app path.

## Evidence
- `apps/server/test/account-deletion.int.test.ts`: a wrong code deletes nothing; after deletion the user, devices, sessions, one-time keys, blocks (only this account's), email codes and the waiting message in the device's mailbox are gone, revocation reached both devices, the old token gets 401, contacts get `NOT_FOUND` for the directory and the username, and the group goes on without the account under a new owner. The mailbox check fails without `purgeDevice` (checked 2026-11-09).
- Related suites still pass: recovery, groups, security, gateway (35 tests together).
