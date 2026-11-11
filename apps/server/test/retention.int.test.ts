/**
 * The retention audit (Phase 27): a fresh server's data passes; each kind of overdue record
 * is caught; the report holds counts and ages only.
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registeredUser, startTestServer, type TestServer } from './helpers';
import { auditRetention, type RetentionLimits } from '../src/ops/retention';

const DAY = 86_400_000;
const limits: RetentionLimits = {
  messageRetentionMs: 14 * DAY,
  redisStageMs: 14 * 3_600_000 + 900_000,
  securityEventRetentionMs: 90 * DAY,
  abuseReportRetentionMs: 90 * DAY,
  attachmentOrphanMs: 6 * 3_600_000,
  attachmentJanitorMs: 300_000,
};

let server: TestServer;
let root: string;

beforeAll(async () => {
  server = await startTestServer();
  root = await mkdtemp(join(tmpdir(), 'pingdost-retention-'));
});

afterAll(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

function audit(now = Date.now()) {
  return auditRetention({
    db: server.mongo.db,
    redis: server.redis,
    redisKeyPrefix: server.mailbox.redisKeyPrefix,
    attachmentRoot: root,
    limits,
    now,
  });
}

function failing(report: Awaited<ReturnType<typeof audit>>): string[] {
  return report.checks.filter((check) => check.violations > 0).map((check) => check.name);
}

describe('retention audit', () => {
  it('passes on live data, with every TTL index in place', async () => {
    await registeredUser(server); // a user, a session, a security event
    const report = await audit();
    expect(failing(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.name === 'ttl indexes present')).toMatchObject({
      checked: 10,
      violations: 0,
    });
  });

  it('catches every kind of record that outlived its limit, and reports no contents', async () => {
    const db = server.mongo.db;
    const now = Date.now();
    const old = (ms: number) => new Date(now - ms);
    await db.collection('pending_envelopes').insertOne({
      _id: 'env-stretched',
      createdAt: old(DAY),
      expiresAt: new Date(now + 20 * DAY), // more than creation + 14 days
      ciphertextMarker: 'SECRET-PAYLOAD',
    } as never);
    // The TTL monitor removes this one within a minute; the audit runs first.
    await db.collection('email_otps').insertOne({ _id: 'otp-old', expiresAt: old(DAY) } as never);
    await db.collection('security_events').insertOne({
      _id: 'event-old',
      createdAt: old(120 * DAY),
      expiresAt: new Date(now + DAY),
    } as never);
    await db
      .collection('attachments')
      .insertOne({ _id: 'att-old', createdAt: old(15 * DAY), expiresAt: old(DAY) } as never);
    // A staged file nobody owns, older than the orphan window.
    await mkdir(join(root, 'ab'), { recursive: true });
    const file = join(root, 'ab', '0192aaaa-0000-7000-8000-0000000000ab');
    await writeFile(file, 'ciphertext');
    await utimes(file, new Date(now - DAY), new Date(now - DAY));
    // Circles (Phase 37): a request kept past 30 days, and a link naming a deleted account.
    await db.collection('circle_requests').insertOne({
      _id: 'req-old',
      from: 'a',
      to: 'b',
      createdAt: old(40 * DAY),
      expiresAt: new Date(now + DAY),
      declined: false,
    } as never);
    await db.collection('circle_links').insertOne({
      _id: 'gone-1:gone-2',
      users: ['gone-1', 'gone-2'],
      since: old(DAY),
    } as never);
    // A mailbox key that never expires.
    await server.redis.client().set(`${server.mailbox.redisKeyPrefix}env:forever`, 'x');

    const report = await audit(now);
    expect(report.ok).toBe(false);
    expect(failing(report).sort()).toEqual(
      [
        'attachments: past expiresAt',
        'circle_links: naming a deleted account',
        'circle_requests: expiry beyond creation + 30 days',
        'circle_requests: older than 30 days',
        'email_otps: past expiresAt',
        'pending_envelopes: expiry beyond creation + retention',
        'redis: envelope and lock keys expire within stage + grace',
        'security_events: older than SECURITY_EVENT_RETENTION_SECONDS',
        'staged attachment files: orphaned or older than the retention',
      ].sort(),
    );
    const otp = report.checks.find((check) => check.name === 'email_otps: past expiresAt');
    expect(otp?.worstOverdueSeconds).toBeGreaterThanOrEqual(86_400 - 1);
    expect(JSON.stringify(report)).not.toMatch(/SECRET-PAYLOAD|otp-old|ciphertext"|forever|gone-1/);

    await server.redis.client().del(`${server.mailbox.redisKeyPrefix}env:forever`);
  });

  it('reports a missing TTL index instead of repairing it', async () => {
    await server.mongo.db.collection('pairing_requests').dropIndex('expiresAt_1');
    const report = await audit();
    expect(report.checks.find((check) => check.name === 'ttl indexes present')).toMatchObject({
      violations: 1,
      note: 'missing: pairing_requests.expiresAt',
    });
  });
});
