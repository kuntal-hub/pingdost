# Restoring the metadata database (Phase 27)

The Mongo database holds account metadata: users, devices, public keys, sessions, groups (routing membership), blocks, push tokens, security events, abuse reports, and the delayed mailbox. It holds **no chat history**, so a restore never brings messages back; devices own history (REQ §23.1).

## Before you restore: is it needed?
- Atlas Free keeps the data on a 3-node replica set; a single node failing needs nothing from you.
- Restore only when data is gone or corrupted (an operator mistake, a bad migration, Atlas losing the cluster). A VPS loss needs no restore (deploy.md → "Rebuild").

## What a restore from the nightly dump brings back, and what it cannot
| Data | In the dump | After restore |
|---|---|---|
| Users, devices, public keys, one-time keys, groups, blocks, push tokens | yes | as of the dump |
| Sessions | yes | refresh tokens issued since the dump fail; those users sign in again |
| Security events, abuse reports | yes | as of the dump |
| `pending_envelopes` (delayed mailbox) | **no** (by design) | empty: envelopes that had migrated to Mongo are gone; senders whose messages were still `sent_to_server` see them stay undelivered and can resend; recipients repair sessions as usual |
| `attachments` records | **no** | staged files become orphans; the janitor deletes them; recipients get "file no longer available" and senders can resend |
| OTPs, pairing / phone-transfer requests, device challenges, job locks | **no** | users request new codes or QR codes |
| Devices registered or revoked since the dump | — | **check**: a device revoked after the dump is active again (revoke it again from the audit trail below); a device registered after it is unknown (its owner signs in and registers again) |

## Steps
1. **Stop writes**: `dc stop server` (API and jobs). UptimeRobot will alert; expected.
2. **Keep the broken state** for investigation: `docker run --rm -e URI="$(grep ^MONGODB_URI= .env | cut -d= -f2-)" -v /srv/pingdost/backups:/b mongo:8.0.34 sh -c 'mongodump --uri="$URI" --gzip --archive=/b/broken-$(date -u +%F-%H%M).archive.gz'`.
3. **Pick the dump**: `ls -l /srv/pingdost/backups/` (7 nightly files). Prefer the newest one from before the damage.
4. **Restore** (drops each collection in the dump before loading it; collections not in the dump, such as `pending_envelopes`, are left as they are; empty them yourself if they are corrupt):
   ```sh
   docker run --rm -i -e URI="$(grep ^MONGODB_URI= .env | cut -d= -f2-)" -v /srv/pingdost/backups:/b mongo:8.0.34 \
     sh -c 'mongorestore --uri="$URI" --drop --gzip --archive=/b/mongo-YYYY-MM-DD.archive.gz'
   ```
5. **Re-apply revocations since the dump**: devices revoked after the dump's time appear in the broken copy (`devices` with `revokedAt` after the dump) or in `security_events` (`type: "device_revoke"`). Revoke them again (`status: "revoked"`, `revokedAt`), so a lost or stolen device stays out.
6. **Start**: `dc start server`. Start-up recreates every index (TTL indexes included).
7. **Check**: `curl -fsS https://api.pingdost.com/readyz`; sign in on a test account; send a message between two test devices; run the [retention audit](retention-audit.md).
8. **Tell users** if sessions or messages were affected: "Some of you will need to sign in again. Messages sent between <time> and <time> to people who were offline may not have arrived; please resend them." Never imply that history was restored from the server.

## Practise
Once before release (and after major changes), restore a dump into a scratch Atlas database (another database name in the URI, never the live one), point a local server at it (`MONGODB_URI=…/pingdost_restore_test`) and run step 7. Record the date here.

- Last practice: not yet (to do with the staging data).
