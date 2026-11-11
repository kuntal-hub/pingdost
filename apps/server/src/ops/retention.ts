/**
 * Retention audit (Phase 27, REQ §5, §18, §23.3 "temporary means temporary"): checks that no
 * temporary record outlived its limit. It reads counts, ages and TTLs only: never a payload,
 * address or token, so its report is safe to paste into an issue.
 *
 * Run it on the VPS: `docker compose exec server node dist/retention-audit.js` (exit 1 on a
 * violation; docs/ops/retention-audit.md).
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Db } from 'mongodb';

import { CIRCLE_REQUEST_TTL_DAYS } from '@pingdost/shared-types';

import type { RedisHandle } from '../infra/redis';

export interface RetentionLimits {
  /** MESSAGE_MAX_RETENTION_SECONDS, in ms: pending envelopes and staged attachments. */
  messageRetentionMs: number;
  /** MESSAGE_REDIS_STAGE_SECONDS + MESSAGE_MIGRATION_GRACE_SECONDS, in ms. */
  redisStageMs: number;
  securityEventRetentionMs: number;
  abuseReportRetentionMs: number;
  /** ATTACHMENT_ORPHAN_SECONDS, in ms: staged files without a live record. */
  attachmentOrphanMs: number;
  /** ATTACHMENT_JANITOR_INTERVAL_SECONDS, in ms. */
  attachmentJanitorMs: number;
  /**
   * Allowed lag: Mongo's TTL monitor runs every 60 s and the jobs every few minutes.
   * Default 15 minutes.
   */
  slackMs?: number;
}

export interface RetentionCheck {
  name: string;
  /** Records looked at. */
  checked: number;
  /** Records past their limit (0 = pass). */
  violations: number;
  /** Age of the oldest record past its limit, in seconds. */
  worstOverdueSeconds?: number;
  note?: string;
}

export interface RetentionReport {
  checkedAt: string;
  ok: boolean;
  checks: RetentionCheck[];
}

export interface RetentionDeps {
  db: Db;
  redis?: RedisHandle;
  /** The mailbox's Redis key prefix ('' in production). */
  redisKeyPrefix?: string;
  /** ATTACHMENT_FS_ROOT when ATTACHMENT_STORE=fs. */
  attachmentRoot?: string;
  limits: RetentionLimits;
  now?: number;
}

/** Collections whose documents must carry a TTL index on `field`. */
const TTL_COLLECTIONS: [collection: string, field: string][] = [
  ['pending_envelopes', 'expiresAt'],
  ['email_otps', 'expiresAt'],
  ['sessions', 'expiresAt'],
  ['pairing_requests', 'expiresAt'],
  ['primary_transfer_requests', 'expiresAt'],
  ['device_challenges', 'expiresAt'],
  ['security_events', 'expiresAt'],
  ['abuse_reports', 'expiresAt'],
  ['circle_requests', 'expiresAt'],
  ['users', 'pendingExpiresAt'],
];

export async function auditRetention(deps: RetentionDeps): Promise<RetentionReport> {
  const now = deps.now ?? Date.now();
  const { limits } = deps;
  const slack = limits.slackMs ?? 15 * 60_000;
  const checks: RetentionCheck[] = [];
  const at = (ms: number) => new Date(ms);

  /** Documents of `collection` matching `overdue`, with how far past `due` the worst one is. */
  async function mongoCheck(
    name: string,
    collection: string,
    overdue: Record<string, unknown>,
    dueField: string,
    dueOffsetMs = 0,
  ): Promise<void> {
    const docs = deps.db.collection(collection);
    const [checked, violations, worst] = await Promise.all([
      docs.estimatedDocumentCount(),
      docs.countDocuments(overdue),
      docs
        .find(overdue, { projection: { _id: 0, [dueField]: 1 } })
        .sort({ [dueField]: 1 })
        .limit(1)
        .next(),
    ]);
    const due: unknown = worst?.[dueField];
    checks.push({
      name,
      checked,
      violations,
      ...(due instanceof Date
        ? { worstOverdueSeconds: Math.round((now - due.getTime() - dueOffsetMs) / 1000) }
        : {}),
    });
  }

  // 1. TTL indexes exist (Mongo deletes on its own; the jobs are a second line).
  const missing: string[] = [];
  for (const [collection, field] of TTL_COLLECTIONS) {
    const indexes = await deps.db
      .collection(collection)
      .indexes()
      .catch(() => []);
    const ttl = indexes.some(
      (index) => index.key[field] === 1 && typeof index.expireAfterSeconds === 'number',
    );
    if (!ttl) missing.push(`${collection}.${field}`);
  }
  checks.push({
    name: 'ttl indexes present',
    checked: TTL_COLLECTIONS.length,
    violations: missing.length,
    ...(missing.length ? { note: `missing: ${missing.join(', ')}` } : {}),
  });

  // 2. Expired records still present (beyond the TTL monitor's lag).
  for (const [collection, field] of TTL_COLLECTIONS) {
    await mongoCheck(
      `${collection}: past ${field}`,
      collection,
      { [field]: { $lt: at(now - slack) } },
      field,
    );
  }

  // 3. Envelopes: expiry never later than creation + retention (absolute, REQ §19.2).
  await mongoCheck(
    'pending_envelopes: older than the retention',
    'pending_envelopes',
    { createdAt: { $lt: at(now - limits.messageRetentionMs - slack) } },
    'createdAt',
    limits.messageRetentionMs,
  );
  const docs = deps.db.collection('pending_envelopes');
  const stretched = await docs.countDocuments({
    $expr: { $gt: ['$expiresAt', { $add: ['$createdAt', limits.messageRetentionMs + slack] }] },
  });
  checks.push({
    name: 'pending_envelopes: expiry beyond creation + retention',
    checked: await docs.estimatedDocumentCount(),
    violations: stretched,
  });

  // 4. Security events and abuse reports: their documented retention.
  await mongoCheck(
    'security_events: older than SECURITY_EVENT_RETENTION_SECONDS',
    'security_events',
    { createdAt: { $lt: at(now - limits.securityEventRetentionMs - slack) } },
    'createdAt',
    limits.securityEventRetentionMs,
  );
  await mongoCheck(
    'abuse_reports: older than ABUSE_REPORT_RETENTION_SECONDS',
    'abuse_reports',
    { createdAt: { $lt: at(now - limits.abuseReportRetentionMs - slack) } },
    'createdAt',
    limits.abuseReportRetentionMs,
  );

  // 5. Attachment records the janitor should have removed.
  await mongoCheck(
    'attachments: past expiresAt',
    'attachments',
    { expiresAt: { $lt: at(now - limits.attachmentJanitorMs - slack) } },
    'expiresAt',
  );

  // 5b. Circles (Phase 37): requests live at most 30 days; links only while both accounts do.
  const requestLifeMs = CIRCLE_REQUEST_TTL_DAYS * 86_400_000;
  await mongoCheck(
    'circle_requests: older than 30 days',
    'circle_requests',
    { createdAt: { $lt: at(now - requestLifeMs - slack) } },
    'createdAt',
    requestLifeMs,
  );
  const requests = deps.db.collection('circle_requests');
  checks.push({
    name: 'circle_requests: expiry beyond creation + 30 days',
    checked: await requests.estimatedDocumentCount(),
    violations: await requests.countDocuments({
      $expr: { $gt: ['$expiresAt', { $add: ['$createdAt', requestLifeMs + slack] }] },
    }),
  });
  const links = deps.db.collection('circle_links');
  const orphaned = await links
    .aggregate<{ count: number }>([
      { $unwind: '$users' },
      { $lookup: { from: 'users', localField: 'users', foreignField: '_id', as: 'user' } },
      { $match: { user: { $size: 0 } } },
      { $group: { _id: '$_id' } },
      { $count: 'count' },
    ])
    .next();
  checks.push({
    name: 'circle_links: naming a deleted account',
    checked: await links.estimatedDocumentCount(),
    violations: orphaned?.count ?? 0,
  });

  // 6. Staged attachment files: none without a record past the orphan window, none older
  //    than the retention.
  if (deps.attachmentRoot) checks.push(await fileCheck(deps, now, slack));

  // 7. Redis: every envelope and lock key expires, within the stage + grace window.
  if (deps.redis)
    checks.push(await redisCheck(deps.redis, deps.redisKeyPrefix ?? '', limits, slack));

  return {
    checkedAt: new Date(now).toISOString(),
    ok: checks.every((check) => check.violations === 0),
    checks,
  };
}

async function fileCheck(deps: RetentionDeps, now: number, slack: number): Promise<RetentionCheck> {
  const root = deps.attachmentRoot!;
  const { limits } = deps;
  const attachments = deps.db.collection<{ _id: string }>('attachments');
  let checked = 0;
  let violations = 0;
  let worst = 0;
  let shards: string[];
  try {
    shards = await readdir(root);
  } catch {
    return {
      name: 'staged attachment files',
      checked: 0,
      violations: 0,
      note: 'no staging directory',
    };
  }
  for (const shard of shards) {
    let names: string[];
    try {
      names = await readdir(join(root, shard));
    } catch {
      continue;
    }
    for (const name of names) {
      checked++;
      const id = name.replace(/\.parts$/, '').replace(/\.[0-9a-f-]+\.tmp$/, '');
      const { mtimeMs } = await stat(join(root, shard, name));
      const age = now - mtimeMs;
      const tooOld = age > limits.messageRetentionMs + slack;
      const orphan =
        age > limits.attachmentOrphanMs + limits.attachmentJanitorMs + slack &&
        (await attachments.countDocuments({ _id: id }, { limit: 1 })) === 0;
      if (tooOld || orphan) {
        violations++;
        worst = Math.max(worst, Math.round(age / 1000));
      }
    }
  }
  return {
    name: 'staged attachment files: orphaned or older than the retention',
    checked,
    violations,
    ...(violations ? { worstOverdueSeconds: worst } : {}),
  };
}

async function redisCheck(
  redis: RedisHandle,
  prefix: string,
  limits: RetentionLimits,
  slack: number,
): Promise<RetentionCheck> {
  const client = redis.client();
  const maxTtlMs = limits.redisStageMs + slack;
  let checked = 0;
  let violations = 0;
  let worst = 0;
  for (const pattern of [`${prefix}env:*`, `${prefix}lock:*`]) {
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', '500');
      cursor = next;
      for (const key of keys) {
        checked++;
        const ttl = await client.pttl(key);
        // -1: no expiry at all; a TTL beyond the stage + grace window means it was extended.
        if (ttl === -1 || ttl > maxTtlMs) {
          violations++;
          worst = Math.max(worst, ttl === -1 ? Number.POSITIVE_INFINITY : ttl);
        }
      }
    } while (cursor !== '0');
  }
  return {
    name: 'redis: envelope and lock keys expire within stage + grace',
    checked,
    violations,
    ...(violations
      ? { note: worst === Number.POSITIVE_INFINITY ? 'a key has no TTL' : 'a TTL is too long' }
      : {}),
  };
}
