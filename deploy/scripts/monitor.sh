#!/usr/bin/env bash
# PingDost staging threshold checks (Phase 20, docs/ops/alerts.md). Cron runs it every 5 minutes
# as the deploy user. All clear: a ping to MONITOR_PING_URL. Anything wrong: a ping to its
# /fail endpoint with one line per problem (healthchecks.io then emails you). A missed ping
# (the VPS or cron is down) alerts too.
#
# It reads /metrics from inside the VPS (Caddy does not serve it publicly), Valkey's memory,
# the disk and the RAM. Never prints secrets.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
compose=(docker compose -f compose.staging.yml)
state=/var/tmp/pingdost-monitor.state

# `.env` holds values with spaces and angle brackets, so it is read key by key, never sourced.
env_value() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | tr -d '\r'; }
METRICS_TOKEN=$(env_value METRICS_TOKEN)
MONITOR_PING_URL=$(env_value MONITOR_PING_URL)
# 80% of ATTACHMENT_TOTAL_QUOTA_BYTES (30 GiB by default).
QUOTA=$(env_value ATTACHMENT_TOTAL_QUOTA_BYTES)
QUOTA=${QUOTA:-32212254720}
RETENTION=$(env_value MESSAGE_MAX_RETENTION_SECONDS)
RETENTION=${RETENTION:-1209600}
STAGE=$(env_value MESSAGE_REDIS_STAGE_SECONDS)
STAGE=${STAGE:-50400}

problems=()
gt() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a + 0 > b + 0) }'; }

metrics=$("${compose[@]}" exec -T caddy wget -qO- -T 10 \
  --header "Authorization: Bearer $METRICS_TOKEN" http://server:3000/metrics 2>/dev/null)
if [ -z "$metrics" ]; then
  problems+=("metrics: the server did not answer /metrics")
fi
# The sum of a metric over its labels (0 if absent).
metric() {
  awk -v n="$1" 'index($1, n) == 1 && (length($1) == length(n) || substr($1, length(n) + 1, 1) == "{") { s += $2 } END { print s + 0 }' <<<"$metrics"
}

if [ -n "$metrics" ]; then
  v=$(metric pingdost_mailbox_due_overdue)
  gt "$v" 0 && problems+=("mailbox: $v envelopes overdue for migration or expiry")
  v=$(metric pingdost_mailbox_redis_oldest_age_seconds)
  gt "$v" $((STAGE + 3600)) && problems+=("mailbox: an envelope has been in Valkey for ${v}s (stage ${STAGE}s)")
  v=$(metric pingdost_mailbox_mongo_oldest_age_seconds)
  gt "$v" $((RETENTION + 3600)) && problems+=("mailbox: an envelope is older than the retention (${v}s)")
  v=$(metric pingdost_attachments_oldest_age_seconds)
  gt "$v" $((RETENTION + 3600)) && problems+=("attachments: a staged file is older than the retention (${v}s)")
  v=$(metric pingdost_attachments_staged_bytes)
  gt "$v" "$(awk -v q="$QUOTA" 'BEGIN { print q * 0.8 }')" && problems+=("attachments: staging is over 80% of its cap ($v bytes)")

  # Failure counters: an increase since the last run is an alert.
  touch "$state"
  for name in pingdost_mailbox_migration_failures_total pingdost_mailbox_deletion_failures_total \
    pingdost_attachment_deletion_failures_total; do
    now=$(metric "$name")
    before=$(awk -v n="$name" '$1 == n { print $2 }' "$state")
    if [ -n "$before" ] && gt "$now" "$before"; then
      problems+=("$name rose from $before to $now")
    fi
    sed -i "/^$name /d" "$state"
    echo "$name $now" >>"$state"
  done
fi

# Valkey memory against maxmemory (noeviction: a full Valkey refuses writes).
info=$("${compose[@]}" exec -T valkey valkey-cli info memory 2>/dev/null | tr -d '\r')
used=$(awk -F: '$1 == "used_memory" { print $2 }' <<<"$info")
max=$(awk -F: '$1 == "maxmemory" { print $2 }' <<<"$info")
if [ -z "$used" ] || [ -z "$max" ]; then
  problems+=("valkey: no answer")
elif gt "$max" 0 && gt "$used" "$(awk -v m="$max" 'BEGIN { print m * 0.8 }')"; then
  problems+=("valkey: ${used} of ${max} bytes used")
fi

# The VPS itself.
disk=$(df --output=pcent / | tail -n 1 | tr -dc '0-9')
gt "$disk" 85 && problems+=("disk: ${disk}% used")
avail=$(awk '$1 == "MemAvailable:" { print int($2 / 1024) }' /proc/meminfo)
gt 300 "$avail" && problems+=("ram: only ${avail} MB available")
for service in server valkey caddy; do
  running=$("${compose[@]}" ps --status running --services 2>/dev/null | grep -cx "$service")
  [ "$running" = 1 ] || problems+=("container $service is not running")
done

if [ -z "$MONITOR_PING_URL" ]; then
  printf '%s\n' "${problems[@]:-all clear}"
  exit "${#problems[@]}"
fi
if [ "${#problems[@]}" -eq 0 ]; then
  curl -fsS -m 10 --retry 3 -o /dev/null "$MONITOR_PING_URL"
else
  printf '%s\n' "${problems[@]}" | curl -fsS -m 10 --retry 3 -o /dev/null --data-binary @- "$MONITOR_PING_URL/fail"
fi
