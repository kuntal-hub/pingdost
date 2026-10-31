#!/usr/bin/env bash
# Nightly dump of the Atlas database to the VPS (ADR 0013), kept 7 days. Cron runs it as the
# deploy user. The mailbox and short-lived request collections are left out, so the dump holds
# account metadata and public keys, never undelivered message ciphertext (REQ §18).
set -euo pipefail

cd "$(dirname "$0")/.."
uri=$(grep -E '^MONGODB_URI=' .env | tail -n 1 | cut -d= -f2- | tr -d '\r')
db=${MONGO_BACKUP_DB:-pingdost}
dir=/srv/pingdost/backups
mkdir -p "$dir"
chmod 700 "$dir"
name="mongo-$(date -u +%F).archive.gz"

# The URI goes in through the environment, so it never shows in the host's process list.
docker run --rm -e URI="$uri" -v "$dir:/backup" mongo:8.0.34 sh -c "exec mongodump \
  --uri=\"\$URI\" --db=$db \
  --excludeCollection=pending_envelopes \
  --excludeCollection=primary_transfer_requests \
  --excludeCollection=pairing_requests \
  --excludeCollection=device_challenges \
  --gzip --archive=/backup/$name --quiet"

find "$dir" -name 'mongo-*.archive.gz' -mtime +7 -delete
echo "backup written: $dir/$name"
