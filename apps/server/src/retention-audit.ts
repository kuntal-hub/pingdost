/**
 * Retention audit entrypoint (Phase 27; `src/ops/retention.ts`). Prints a JSON report of
 * counts and ages, never contents, and exits 1 when a temporary record outlived its limit.
 *
 *   docker compose exec server node dist/retention-audit.js
 *   pnpm --filter @pingdost/server retention-audit      # dev, against the root .env
 *
 * It creates no indexes: a missing TTL index must show up as a violation, not be repaired.
 */
import { createMongo } from './infra/mongo';
import { createRedisHandle } from './infra/redis';
import { loadConfigOrExit } from './infra/startup';
import { auditRetention } from './ops/retention';

const config = loadConfigOrExit();
const mongo = createMongo(config.MONGODB_URI);
const redis = createRedisHandle(config.REDIS_URL);
const seconds = (value: number) => value * 1000;

try {
  const report = await auditRetention({
    db: mongo.db,
    redis,
    ...(config.ATTACHMENT_STORE === 'fs' ? { attachmentRoot: config.ATTACHMENT_FS_ROOT } : {}),
    limits: {
      messageRetentionMs: seconds(config.MESSAGE_MAX_RETENTION_SECONDS),
      redisStageMs: seconds(
        config.MESSAGE_REDIS_STAGE_SECONDS + config.MESSAGE_MIGRATION_GRACE_SECONDS,
      ),
      securityEventRetentionMs: seconds(config.SECURITY_EVENT_RETENTION_SECONDS),
      abuseReportRetentionMs: seconds(config.ABUSE_REPORT_RETENTION_SECONDS),
      attachmentOrphanMs: seconds(config.ATTACHMENT_ORPHAN_SECONDS),
      attachmentJanitorMs: seconds(config.ATTACHMENT_JANITOR_INTERVAL_SECONDS),
    },
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  console.error(
    `retention audit failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 2;
} finally {
  await redis.close();
  await mongo.close();
}
