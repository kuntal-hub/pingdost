import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ConfigError } from './errors';
import { loadServerConfig, SERVER_ENV_KEYS, SERVER_SECRET_KEYS } from './server';

type Env = Record<string, string | undefined>;

/** A minimal valid production environment (fake values). */
const productionEnv: Env = {
  NODE_ENV: 'production',
  PUBLIC_API_URL: 'https://api.pingdost.com',
  PUBLIC_WS_URL: 'wss://api.pingdost.com/ws',
  WEB_ORIGIN: 'https://pingdost.com',
  MONGODB_URI: 'mongodb+srv://user:pass@cluster.example.net/pingdost',
  REDIS_URL: 'rediss://default:token@redis.example.net:6379',
  EMAIL_PROVIDER: 'zeptomail',
  EMAIL_API_KEY: 'zepto-api-key',
  EMAIL_FROM: 'PingDost <no-reply@pingdost.com>',
  ACCESS_TOKEN_SIGNING_KEY: Buffer.alloc(32, 7).toString('base64'),
  SERVER_HMAC_PEPPER: Buffer.alloc(32, 9).toString('base64'),
};

function issuesOf(env: Env): readonly string[] {
  try {
    loadServerConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  return expect.fail('expected loadServerConfig to throw');
}

function issuesFor(env: Env, key: string): readonly string[] {
  return issuesOf(env).filter(
    (issue) => issue.startsWith(`${key}:`) || issue.startsWith(`${key}.`),
  );
}

describe('defaults (development)', () => {
  it('applies REQ §9.1 and A11 defaults to an empty env', () => {
    const config = loadServerConfig({});
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      MESSAGE_REDIS_STAGE_SECONDS: 50_400,
      MESSAGE_MAX_RETENTION_SECONDS: 1_209_600,
      MESSAGE_MIGRATION_GRACE_SECONDS: 900,
      MESSAGE_MIGRATION_POLL_SECONDS: 300,
      MESSAGE_REAPER_INTERVAL_SECONDS: 60,
      MESSAGE_ONLINE_ACK_TIMEOUT_MS: 5_000,
      ENVELOPE_MAX_BYTES: 65_536,
      ATTACHMENT_MAX_BYTES: 104_857_600,
      ATTACHMENT_MAX_RETENTION_SECONDS: 1_209_600,
      ATTACHMENT_PRESIGNED_URL_TTL_SECONDS: 300,
      ATTACHMENT_STORE: 'fs',
      MESH_PACKET_MAX_HOPS: 8,
      MESH_PACKET_TTL_SECONDS: 1_209_600,
      MESH_RELAY_STORAGE_LIMIT_BYTES: 262_144_000,
      WEB_PAIRING_TTL_SECONDS: 120,
      ACCESS_TOKEN_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_SECONDS: 2_592_000,
      ARGON2_MEMORY_KIB: 19_456,
      ARGON2_ITERATIONS: 2,
      ARGON2_PARALLELISM: 1,
      RUN_WORKER_IN_PROCESS: true,
      EMAIL_CONSOLE_SHOW_CONTENT: false,
      MONGODB_URI: 'mongodb://localhost:27017/pingdost?replicaSet=rs0',
      REDIS_URL: 'redis://localhost:6379',
      EMAIL_PROVIDER: 'smtp',
      smtp: { host: 'localhost', port: 1025, secure: false, auth: undefined },
    });
    for (const name of ['objectStore', 'google', 'cloudinary', 'fcm', 'webPush', 'turn'] as const) {
      expect(config[name]).toBeUndefined();
    }
  });

  it('treats blank values as unset', () => {
    const config = loadServerConfig({ PORT: '', MESSAGE_REDIS_STAGE_SECONDS: '   ' });
    expect(config.PORT).toBe(3000);
    expect(config.MESSAGE_REDIS_STAGE_SECONDS).toBe(50_400);
  });

  it('parses integers, booleans and lists', () => {
    const config = loadServerConfig({
      PORT: '8080',
      RUN_WORKER_IN_PROCESS: 'false',
      SMTP_SECURE: '1',
      GOOGLE_CLIENT_IDS: 'web.apps.googleusercontent.com, android.apps.googleusercontent.com',
      TURN_URLS: 'turn:turn.example.com:3478,turns:turn.example.com:5349',
      TURN_SHARED_SECRET: 'x'.repeat(32),
    });
    expect(config.PORT).toBe(8080);
    expect(config.RUN_WORKER_IN_PROCESS).toBe(false);
    expect(config.smtp?.secure).toBe(true);
    expect(config.google?.clientIds).toEqual([
      'web.apps.googleusercontent.com',
      'android.apps.googleusercontent.com',
    ]);
    expect(config.turn?.urls).toHaveLength(2);
  });
});

describe('bounds', () => {
  const limitKeys = SERVER_ENV_KEYS.filter((key) =>
    /_(SECONDS|MS|BYTES|KIB|DAYS|MEMBERS|HOPS|ATTEMPTS|ITERATIONS|PARALLELISM)$/.test(key),
  );

  it('covers every TTL and limit variable', () => {
    expect(limitKeys.length).toBeGreaterThanOrEqual(25);
  });

  it.each(limitKeys)('%s rejects zero and huge values', (key) => {
    expect(issuesFor({ [key]: '0' }, key)).not.toHaveLength(0);
    expect(issuesFor({ [key]: '1000000000000000' }, key)).not.toHaveLength(0);
  });

  it.each(['-5', '1.5', '1e6', '0x10', '12abc', 'ten'])('rejects non-integer "%s"', (value) => {
    expect(
      issuesFor({ MESSAGE_MAX_RETENTION_SECONDS: value }, 'MESSAGE_MAX_RETENTION_SECONDS'),
    ).toEqual(['MESSAGE_MAX_RETENTION_SECONDS: must be a whole number']);
  });

  it('keeps MESH_PACKET_MAX_HOPS between 1 and 32', () => {
    expect(loadServerConfig({ MESH_PACKET_MAX_HOPS: '1' }).MESH_PACKET_MAX_HOPS).toBe(1);
    expect(loadServerConfig({ MESH_PACKET_MAX_HOPS: '32' }).MESH_PACKET_MAX_HOPS).toBe(32);
    expect(issuesFor({ MESH_PACKET_MAX_HOPS: '33' }, 'MESH_PACKET_MAX_HOPS')).toHaveLength(1);
  });

  it('rejects invalid enums, booleans and URLs', () => {
    const issues = issuesOf({
      ATTACHMENT_STORE: 'gcs',
      RUN_WORKER_IN_PROCESS: 'yes',
      PUBLIC_WS_URL: 'http://localhost:3000/ws',
      REDIS_URL: 'http://localhost:6379',
      STUN_URLS: 'stun:ok.example.com,http://bad.example.com',
    });
    for (const key of ['ATTACHMENT_STORE', 'RUN_WORKER_IN_PROCESS', 'PUBLIC_WS_URL', 'REDIS_URL']) {
      expect(issues.some((issue) => issue.startsWith(`${key}:`))).toBe(true);
    }
    expect(issues.some((issue) => issue.startsWith('STUN_URLS.1:'))).toBe(true);
  });
});

describe('cross-field rules', () => {
  it('requires MESSAGE_REDIS_STAGE_SECONDS < MESSAGE_MAX_RETENTION_SECONDS', () => {
    const env = {
      MESSAGE_REDIS_STAGE_SECONDS: '1209600',
      MESSAGE_MAX_RETENTION_SECONDS: '1209600',
    };
    expect(issuesFor(env, 'MESSAGE_REDIS_STAGE_SECONDS')).toHaveLength(1);
    expect(() =>
      loadServerConfig({ ...env, MESSAGE_REDIS_STAGE_SECONDS: '1209599' }),
    ).not.toThrow();
  });

  it('requires MESSAGE_MIGRATION_POLL_SECONDS <= MESSAGE_MIGRATION_GRACE_SECONDS / 3', () => {
    const env = { MESSAGE_MIGRATION_GRACE_SECONDS: '900', MESSAGE_MIGRATION_POLL_SECONDS: '301' };
    expect(issuesFor(env, 'MESSAGE_MIGRATION_POLL_SECONDS')).toHaveLength(1);
    expect(() => loadServerConfig({ ...env, MESSAGE_MIGRATION_POLL_SECONDS: '300' })).not.toThrow();
  });

  it('requires ATTACHMENT_MAX_RETENTION_SECONDS <= MESSAGE_MAX_RETENTION_SECONDS', () => {
    const env = { ATTACHMENT_MAX_RETENTION_SECONDS: '1209601' };
    expect(issuesFor(env, 'ATTACHMENT_MAX_RETENTION_SECONDS')).toHaveLength(1);
  });

  it.each([
    ['ATTACHMENT_USER_QUOTA_BYTES', { ATTACHMENT_USER_QUOTA_BYTES: '104857599' }],
    [
      'ACCESS_TOKEN_TTL_SECONDS',
      { ACCESS_TOKEN_TTL_SECONDS: '3600', REFRESH_TOKEN_TTL_SECONDS: '3600' },
    ],
    ['EMAIL_OTP_RESEND_COOLDOWN_SECONDS', { EMAIL_OTP_RESEND_COOLDOWN_SECONDS: '600' }],
  ])('checks %s against its related limit', (key, env) => {
    expect(issuesFor(env, key)).toHaveLength(1);
  });
});

describe('optional feature groups', () => {
  it('rejects a partially configured group and names the missing variables', () => {
    const issues = issuesOf({ CLOUDINARY_CLOUD_NAME: 'demo', CLOUDINARY_API_KEY: 'key' });
    expect(issues).toEqual([
      'CLOUDINARY_API_SECRET: must be set together with CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET (or none)',
    ]);
  });

  it('builds a typed object for a complete group', () => {
    const config = loadServerConfig({
      CLOUDINARY_CLOUD_NAME: 'demo',
      CLOUDINARY_API_KEY: 'key',
      CLOUDINARY_API_SECRET: 'secret',
    });
    expect(config.cloudinary).toEqual({ cloudName: 'demo', apiKey: 'key', apiSecret: 'secret' });
  });

  it('requires the object-store group when ATTACHMENT_STORE=s3', () => {
    expect(issuesFor({ ATTACHMENT_STORE: 's3' }, 'ATTACHMENT_STORE')).toHaveLength(1);
    const config = loadServerConfig({
      ATTACHMENT_STORE: 's3',
      ATTACHMENT_OBJECT_STORE_ENDPOINT: 'http://localhost:9000',
      ATTACHMENT_OBJECT_STORE_BUCKET: 'pingdost-attachments',
      ATTACHMENT_OBJECT_STORE_ACCESS_KEY: 'minio',
      ATTACHMENT_OBJECT_STORE_SECRET_KEY: 'minio-secret',
    });
    expect(config.objectStore?.bucket).toBe('pingdost-attachments');
  });

  it('requires the provider credentials for the chosen email provider', () => {
    expect(issuesFor({ EMAIL_PROVIDER: 'zeptomail' }, 'EMAIL_PROVIDER')).toHaveLength(1);
    expect(loadServerConfig({ EMAIL_PROVIDER: 'zeptomail', EMAIL_API_KEY: 'k' }).zeptomail).toEqual(
      {
        apiKey: 'k',
      },
    );
  });

  it('treats SMTP auth as its own all-or-none pair', () => {
    expect(issuesOf({ SMTP_USER: 'user' })).toHaveLength(1);
    expect(loadServerConfig({ SMTP_USER: 'user', SMTP_PASS: 'pass' }).smtp?.auth).toEqual({
      user: 'user',
      pass: 'pass',
    });
  });
});

describe('production fail-fast', () => {
  it('loads a complete production env without applying dev defaults', () => {
    const config = loadServerConfig(productionEnv);
    expect(config.NODE_ENV).toBe('production');
    expect(config.smtp).toBeUndefined();
    expect(config.zeptomail).toEqual({ apiKey: 'zepto-api-key' });
  });

  it('reports each missing required variable exactly once', () => {
    const issues = issuesOf({ NODE_ENV: 'production' });
    for (const key of [
      'PUBLIC_API_URL',
      'PUBLIC_WS_URL',
      'WEB_ORIGIN',
      'MONGODB_URI',
      'REDIS_URL',
      'EMAIL_PROVIDER',
      'EMAIL_FROM',
      'ACCESS_TOKEN_SIGNING_KEY',
      'SERVER_HMAC_PEPPER',
    ]) {
      expect(issues.filter((issue) => issue.startsWith(`${key}:`))).toEqual([
        `${key}: is required when NODE_ENV=production`,
      ]);
    }
  });

  it('rejects the development keys in production', () => {
    const devConfig = loadServerConfig({});
    const issues = issuesOf({
      ...productionEnv,
      ACCESS_TOKEN_SIGNING_KEY: devConfig.ACCESS_TOKEN_SIGNING_KEY,
      SERVER_HMAC_PEPPER: devConfig.SERVER_HMAC_PEPPER,
    });
    expect(issues).toHaveLength(2);
  });

  it('rejects short key material', () => {
    const env = { ...productionEnv, ACCESS_TOKEN_SIGNING_KEY: Buffer.alloc(16).toString('base64') };
    expect(issuesFor(env, 'ACCESS_TOKEN_SIGNING_KEY')).toEqual([
      'ACCESS_TOKEN_SIGNING_KEY: must decode to at least 32 bytes',
    ]);
  });

  it('forbids logging email content in production', () => {
    const env = { ...productionEnv, EMAIL_CONSOLE_SHOW_CONTENT: 'true' };
    expect(issuesFor(env, 'EMAIL_CONSOLE_SHOW_CONTENT')).toHaveLength(1);
  });
});

describe('secret hygiene', () => {
  it('never includes values in error messages', () => {
    const values = ['hunter2-not-base64!', 'short-turn-secret', 'mysql://leaked@db'];
    let message = '';
    try {
      loadServerConfig({
        ACCESS_TOKEN_SIGNING_KEY: values[0],
        TURN_SHARED_SECRET: values[1],
        MONGODB_URI: values[2],
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('ACCESS_TOKEN_SIGNING_KEY');
    for (const value of values) expect(message).not.toContain(value);
  });

  it('rejects REQ §17 names that A11 replaced', () => {
    expect(issuesFor({ UPSTASH_REDIS_URL: 'https://x.upstash.io' }, 'UPSTASH_REDIS_URL')).toEqual([
      'UPSTASH_REDIS_URL: replaced by REDIS_URL (see docs/CHANGES.md)',
    ]);
  });
});

describe('.env.example', () => {
  const example = Object.fromEntries(
    readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')
      .split(/\r?\n/)
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => {
        const index = line.indexOf('=');
        return [
          line.slice(0, index),
          line
            .slice(index + 1)
            .replace(/\s+#.*$/, '')
            .trim(),
        ];
      }),
  ) as Record<string, string>;

  it('documents every server variable', () => {
    expect(SERVER_ENV_KEYS.filter((key) => !(key in example))).toEqual([]);
  });

  it('leaves real secrets empty', () => {
    const allowed = new Set(['MONGODB_URI', 'REDIS_URL']); // local docker-compose URLs
    const filled = SERVER_SECRET_KEYS.filter((key) => !allowed.has(key) && example[key] !== '');
    expect(filled).toEqual([]);
  });

  it('is a valid development config as-is', () => {
    expect(() => loadServerConfig(example)).not.toThrow();
  });
});
