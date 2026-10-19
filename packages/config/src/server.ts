/**
 * Server configuration: typed, validated env parsing for REQ §17 plus the ARCHITECTURE A11
 * additions. Server-only; clients import `@pingdost/config/public` instead (A10).
 */
import { z } from 'zod';

import { ConfigError, formatZodIssues, withoutBlankValues } from './errors';
import { DEFAULT_LIMITS, MESH_PACKET_MAX_HOPS_RANGE } from './public';

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;
const KIB = 1_024;
const MIB = 1_048_576;
const GIB = 1_073_741_824;

/** A whole-number variable within inclusive bounds. Rejects "1e3", "0x10", "-1" and "1.5". */
function int(min: number, max: number) {
  return z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
}

function bool() {
  return z.stringbool({ truthy: ['true', '1'], falsy: ['false', '0'] });
}

/** A comma-separated, non-empty list. */
function list(item: z.ZodType<string, string>) {
  return z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    )
    .pipe(z.array(item).min(1));
}

const httpUrl = z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' });
const wsUrl = z.url({ protocol: /^wss?$/, error: 'must be a ws(s) URL' });

/** Random key material: base64 that decodes to at least 32 bytes. */
const secretKey = z
  .base64({ error: 'must be base64' })
  .refine((value) => Buffer.from(value, 'base64').length >= 32, 'must decode to at least 32 bytes');

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(1, 65_535).default(3_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Behind a reverse proxy (Caddy, nginx): trust X-Forwarded-For for client IPs and rate limits.
  TRUST_PROXY: bool().default(false),
  PUBLIC_API_URL: httpUrl,
  PUBLIC_WS_URL: wsUrl,
  WEB_ORIGIN: httpUrl,

  MONGODB_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb:// or mongodb+srv:// URI'),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis:// or rediss:// URL'),
  RUN_WORKER_IN_PROCESS: bool().default(true),

  // Delivery mailbox (REQ §9).
  MESSAGE_REDIS_STAGE_SECONDS: int(MINUTE, 30 * DAY).default(50_400),
  MESSAGE_MAX_RETENTION_SECONDS: int(HOUR, 30 * DAY).default(
    DEFAULT_LIMITS.messageMaxRetentionSeconds,
  ),
  MESSAGE_MIGRATION_GRACE_SECONDS: int(MINUTE, DAY).default(900),
  MESSAGE_MIGRATION_POLL_SECONDS: int(10, HOUR).default(300),
  MESSAGE_REAPER_INTERVAL_SECONDS: int(5, HOUR).default(60),
  MESSAGE_ONLINE_ACK_TIMEOUT_MS: int(500, 60_000).default(5_000),
  ENVELOPE_MAX_BYTES: int(KIB, MIB).default(DEFAULT_LIMITS.envelopeMaxBytes),

  // Attachments (REQ §10).
  ATTACHMENT_MAX_BYTES: int(MIB, GIB).default(DEFAULT_LIMITS.attachmentMaxBytes),
  ATTACHMENT_MAX_RETENTION_SECONDS: int(HOUR, 30 * DAY).default(1_209_600),
  ATTACHMENT_PRESIGNED_URL_TTL_SECONDS: int(30, HOUR).default(300),
  ATTACHMENT_STORE: z.enum(['fs', 's3']).default('fs'),
  ATTACHMENT_FS_ROOT: z.string().default('./.data/attachments'),
  ATTACHMENT_USER_QUOTA_BYTES: int(MIB, 100 * GIB).default(GIB),
  ATTACHMENT_ORPHAN_SECONDS: int(MINUTE, 7 * DAY).default(21_600),
  ATTACHMENT_OBJECT_STORE_ENDPOINT: httpUrl.optional(),
  ATTACHMENT_OBJECT_STORE_BUCKET: z.string().optional(),
  ATTACHMENT_OBJECT_STORE_ACCESS_KEY: z.string().optional(),
  ATTACHMENT_OBJECT_STORE_SECRET_KEY: z.string().optional(),

  // Email and OTP.
  EMAIL_PROVIDER: z.enum(['smtp', 'zeptomail', 'console']),
  EMAIL_FROM: z.string().regex(/@/, 'must contain an email address'),
  EMAIL_API_KEY: z.string().optional(),
  // The send-mail URL for your account's region (shown in the ZeptoMail mail agent setup).
  ZEPTOMAIL_API_URL: z
    .url({ protocol: /^https$/, error: 'must be an https URL' })
    .default('https://api.zeptomail.com/v1.1/email'),
  EMAIL_OTP_TTL_SECONDS: int(MINUTE, HOUR).default(600),
  EMAIL_OTP_RESEND_COOLDOWN_SECONDS: int(5, HOUR).default(30),
  EMAIL_OTP_MAX_ATTEMPTS: int(1, 20).default(5),
  EMAIL_CONSOLE_SHOW_CONTENT: bool().default(false),
  // Registrations still unverified after this are deleted, freeing the username and email.
  UNVERIFIED_ACCOUNT_TTL_SECONDS: int(HOUR, 7 * DAY).default(DAY),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(1, 65_535).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: bool().default(false),

  // Tokens and password hashing.
  ACCESS_TOKEN_SIGNING_KEY: secretKey,
  SERVER_HMAC_PEPPER: secretKey,
  ACCESS_TOKEN_TTL_SECONDS: int(MINUTE, DAY).default(900),
  REFRESH_TOKEN_TTL_SECONDS: int(HOUR, 365 * DAY).default(2_592_000),
  ARGON2_MEMORY_KIB: int(19_456, 262_144).default(19_456),
  ARGON2_ITERATIONS: int(2, 10).default(2),
  ARGON2_PARALLELISM: int(1, 16).default(1),

  // Social login. Google verifies ID tokens, so it needs only public client IDs.
  GOOGLE_CLIENT_IDS: list(z.string()).optional(),
  FACEBOOK_APP_ID: z.string().optional(),
  FACEBOOK_APP_SECRET: z.string().optional(),

  // Avatars and push.
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_SERVICE_ACCOUNT_JSON_BASE64: z.base64({ error: 'must be base64' }).optional(),
  WEB_PUSH_VAPID_PUBLIC_KEY: z.string().optional(),
  WEB_PUSH_VAPID_PRIVATE_KEY: z.string().optional(),
  WEB_PUSH_SUBJECT: z
    .string()
    .regex(/^(mailto:|https:\/\/)/, 'must start with mailto: or https://')
    .optional(),

  // Web pairing, sync and groups.
  WEB_PAIRING_TTL_SECONDS: int(30, 600).default(DEFAULT_LIMITS.webPairingTtlSeconds),
  SYNC_RECENT_DAYS: int(1, 365).default(DEFAULT_LIMITS.syncRecentDays),
  GROUP_MAX_MEMBERS: int(2, 1_024).default(DEFAULT_LIMITS.groupMaxMembers),

  // Mesh (REQ §11.4).
  MESH_PACKET_MAX_HOPS: int(MESH_PACKET_MAX_HOPS_RANGE.min, MESH_PACKET_MAX_HOPS_RANGE.max).default(
    DEFAULT_LIMITS.meshPacketMaxHops,
  ),
  MESH_PACKET_TTL_SECONDS: int(MINUTE, 30 * DAY).default(DEFAULT_LIMITS.meshPacketTtlSeconds),
  MESH_RELAY_STORAGE_LIMIT_BYTES: int(MIB, 10 * GIB).default(
    DEFAULT_LIMITS.meshRelayStorageLimitBytes,
  ),

  // Calls (REQ §12).
  STUN_URLS: list(z.string().regex(/^stuns?:/, 'must start with stun: or stuns:')).optional(),
  TURN_URLS: list(z.string().regex(/^turns?:/, 'must start with turn: or turns:')).optional(),
  TURN_SHARED_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
  TURN_CREDENTIAL_TTL_SECONDS: int(MINUTE, DAY).default(3_600),

  // Operations.
  SECURITY_EVENT_RETENTION_SECONDS: int(DAY, 365 * DAY).default(7_776_000),
  METRICS_TOKEN: z.string().min(32, 'must be at least 32 characters').optional(),
});

type ServerEnvKey = keyof z.input<typeof serverEnvSchema>;
export type ServerEnv = z.output<typeof serverEnvSchema>;

/** Variables whose values are secrets. They must never reach a client bundle or a log. */
export const SERVER_SECRET_KEYS = [
  'MONGODB_URI',
  'REDIS_URL',
  'ATTACHMENT_OBJECT_STORE_ACCESS_KEY',
  'ATTACHMENT_OBJECT_STORE_SECRET_KEY',
  'EMAIL_API_KEY',
  'SMTP_PASS',
  'ACCESS_TOKEN_SIGNING_KEY',
  'SERVER_HMAC_PEPPER',
  'FACEBOOK_APP_SECRET',
  'CLOUDINARY_API_SECRET',
  'FCM_SERVICE_ACCOUNT_JSON_BASE64',
  'WEB_PUSH_VAPID_PRIVATE_KEY',
  'TURN_SHARED_SECRET',
  'METRICS_TOKEN',
] as const satisfies readonly ServerEnvKey[];

/** Key material that is only for local development; production rejects it. */
const DEV_ONLY_SECRETS = {
  ACCESS_TOKEN_SIGNING_KEY: Buffer.from('pingdost-dev-only-access-token-signing-key').toString(
    'base64',
  ),
  SERVER_HMAC_PEPPER: Buffer.from('pingdost-dev-only-server-hmac-pepper-value').toString('base64'),
} as const satisfies Partial<Record<ServerEnvKey, string>>;

/** Applied only when NODE_ENV is not "production". Points at the docker-compose services. */
const DEV_DEFAULTS = {
  PUBLIC_API_URL: 'http://localhost:3000',
  PUBLIC_WS_URL: 'ws://localhost:3000/v1/ws',
  WEB_ORIGIN: 'http://localhost:5173',
  MONGODB_URI: 'mongodb://localhost:27017/pingdost?replicaSet=rs0',
  REDIS_URL: 'redis://localhost:6379',
  EMAIL_PROVIDER: 'smtp',
  EMAIL_FROM: 'PingDost <no-reply@pingdost.localhost>',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  ...DEV_ONLY_SECRETS,
} as const satisfies Partial<Record<ServerEnvKey, string>>;

/** Production has no defaults for these; a missing value fails startup. */
const REQUIRED_IN_PRODUCTION = [
  'PUBLIC_API_URL',
  'PUBLIC_WS_URL',
  'WEB_ORIGIN',
  'MONGODB_URI',
  'REDIS_URL',
  'EMAIL_PROVIDER',
  'EMAIL_FROM',
  'ACCESS_TOKEN_SIGNING_KEY',
  'SERVER_HMAC_PEPPER',
] as const satisfies readonly ServerEnvKey[];

/** Optional feature groups: set every variable in a group, or none of them. */
const OPTIONAL_GROUPS = {
  objectStore: [
    'ATTACHMENT_OBJECT_STORE_ENDPOINT',
    'ATTACHMENT_OBJECT_STORE_BUCKET',
    'ATTACHMENT_OBJECT_STORE_ACCESS_KEY',
    'ATTACHMENT_OBJECT_STORE_SECRET_KEY',
  ],
  smtp: ['SMTP_HOST', 'SMTP_PORT'],
  smtpAuth: ['SMTP_USER', 'SMTP_PASS'],
  google: ['GOOGLE_CLIENT_IDS'],
  facebook: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'],
  cloudinary: ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'],
  fcm: ['FCM_PROJECT_ID', 'FCM_SERVICE_ACCOUNT_JSON_BASE64'],
  webPush: ['WEB_PUSH_VAPID_PUBLIC_KEY', 'WEB_PUSH_VAPID_PRIVATE_KEY', 'WEB_PUSH_SUBJECT'],
  turn: ['TURN_URLS', 'TURN_SHARED_SECRET'],
} as const satisfies Record<string, readonly ServerEnvKey[]>;

/** REQ §17 names that ARCHITECTURE A11 replaced (docs/CHANGES.md). */
const REPLACED_KEYS: Readonly<Record<string, ServerEnvKey>> = {
  UPSTASH_REDIS_URL: 'REDIS_URL',
  UPSTASH_REDIS_TOKEN: 'REDIS_URL',
  GOOGLE_CLIENT_ID: 'GOOGLE_CLIENT_IDS',
};

export type ServerConfig = ReturnType<typeof toServerConfig>;

/**
 * Parses and validates server configuration. Throws `ConfigError` listing every problem.
 *
 * Outside production, unset variables fall back to dev defaults that match docker-compose.
 * In production nothing is defaulted: missing secrets and dev-only keys fail startup.
 */
export function loadServerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ServerConfig {
  const provided = withoutBlankValues(env);
  const production = provided.NODE_ENV === 'production';
  const input: Record<string, string> = production ? provided : { ...DEV_DEFAULTS, ...provided };
  const issues: string[] = [];

  for (const [oldKey, newKey] of Object.entries(REPLACED_KEYS)) {
    if (provided[oldKey] !== undefined) {
      issues.push(`${oldKey}: replaced by ${newKey} (see docs/CHANGES.md)`);
    }
  }
  const missingInProduction = new Set<string>();
  if (production) {
    for (const key of REQUIRED_IN_PRODUCTION) {
      if (input[key] === undefined) missingInProduction.add(key);
    }
    for (const key of missingInProduction) {
      issues.push(`${key}: is required when NODE_ENV=production`);
    }
    for (const [key, devValue] of Object.entries(DEV_ONLY_SECRETS)) {
      if (input[key] === devValue) {
        issues.push(`${key}: the development key must not be used in production`);
      }
    }
  }
  issues.push(...groupIssues(input));

  const parsed = serverEnvSchema.safeParse(input);
  if (!parsed.success) {
    const zodIssues = formatZodIssues(parsed.error, input).filter(
      (issue) => !missingInProduction.has(issue.split(/[.:]/, 1)[0] ?? ''),
    );
    throw new ConfigError('server', [...issues, ...zodIssues]);
  }

  issues.push(...crossFieldIssues(parsed.data));
  if (issues.length > 0) throw new ConfigError('server', issues);
  return toServerConfig(parsed.data);
}

function groupIssues(input: Readonly<Record<string, string>>): string[] {
  const issues: string[] = [];
  for (const keys of Object.values(OPTIONAL_GROUPS)) {
    const missing = keys.filter((key) => input[key] === undefined);
    if (missing.length > 0 && missing.length < keys.length) {
      issues.push(`${missing.join(', ')}: must be set together with ${keys.join(', ')} (or none)`);
    }
  }
  return issues;
}

function crossFieldIssues(c: ServerEnv): string[] {
  const rules: [ok: boolean, issue: string][] = [
    [
      c.MESSAGE_REDIS_STAGE_SECONDS < c.MESSAGE_MAX_RETENTION_SECONDS,
      'MESSAGE_REDIS_STAGE_SECONDS: must be less than MESSAGE_MAX_RETENTION_SECONDS',
    ],
    [
      c.MESSAGE_MIGRATION_POLL_SECONDS * 3 <= c.MESSAGE_MIGRATION_GRACE_SECONDS,
      'MESSAGE_MIGRATION_POLL_SECONDS: must be at most MESSAGE_MIGRATION_GRACE_SECONDS / 3',
    ],
    [
      c.ATTACHMENT_MAX_RETENTION_SECONDS <= c.MESSAGE_MAX_RETENTION_SECONDS,
      'ATTACHMENT_MAX_RETENTION_SECONDS: must not exceed MESSAGE_MAX_RETENTION_SECONDS',
    ],
    [
      c.ATTACHMENT_USER_QUOTA_BYTES >= c.ATTACHMENT_MAX_BYTES,
      'ATTACHMENT_USER_QUOTA_BYTES: must be at least ATTACHMENT_MAX_BYTES',
    ],
    [
      c.ACCESS_TOKEN_TTL_SECONDS < c.REFRESH_TOKEN_TTL_SECONDS,
      'ACCESS_TOKEN_TTL_SECONDS: must be less than REFRESH_TOKEN_TTL_SECONDS',
    ],
    [
      c.EMAIL_OTP_RESEND_COOLDOWN_SECONDS < c.EMAIL_OTP_TTL_SECONDS,
      'EMAIL_OTP_RESEND_COOLDOWN_SECONDS: must be less than EMAIL_OTP_TTL_SECONDS',
    ],
    [
      c.ATTACHMENT_STORE !== 's3' || c.ATTACHMENT_OBJECT_STORE_BUCKET !== undefined,
      'ATTACHMENT_STORE: "s3" requires the ATTACHMENT_OBJECT_STORE_* variables',
    ],
    [
      c.EMAIL_PROVIDER !== 'smtp' || c.SMTP_HOST !== undefined,
      'EMAIL_PROVIDER: "smtp" requires SMTP_HOST and SMTP_PORT',
    ],
    [
      c.EMAIL_PROVIDER !== 'zeptomail' || c.EMAIL_API_KEY !== undefined,
      'EMAIL_PROVIDER: "zeptomail" requires EMAIL_API_KEY',
    ],
    [
      c.SMTP_USER === undefined || c.SMTP_HOST !== undefined,
      'SMTP_USER: SMTP auth requires SMTP_HOST and SMTP_PORT',
    ],
    [
      c.NODE_ENV !== 'production' || !c.EMAIL_CONSOLE_SHOW_CONTENT,
      'EMAIL_CONSOLE_SHOW_CONTENT: must be false in production (OTPs must never be logged)',
    ],
    [
      c.NODE_ENV !== 'production' || hasPassword(c.REDIS_URL),
      'REDIS_URL: must include the Valkey password in production (redis://:<password>@host:6379)',
    ],
  ];
  return rules.filter(([ok]) => !ok).map(([, issue]) => issue);
}

/** Self-hosted Valkey (ADR 0013) must require auth even on the private Docker network. */
function hasPassword(url: string): boolean {
  return URL.canParse(url) && new URL(url).password !== '';
}

/** Returns the values when all are set, otherwise undefined (groups are all-or-none). */
function group<T extends Record<string, unknown>>(
  values: T,
): { [K in keyof T]-?: NonNullable<T[K]> } | undefined {
  return Object.values(values).every((value) => value !== undefined)
    ? (values as { [K in keyof T]-?: NonNullable<T[K]> })
    : undefined;
}

/** Flat scalars keep their env names; optional feature groups become typed objects. */
function toServerConfig(env: ServerEnv) {
  const {
    ATTACHMENT_OBJECT_STORE_ENDPOINT,
    ATTACHMENT_OBJECT_STORE_BUCKET,
    ATTACHMENT_OBJECT_STORE_ACCESS_KEY,
    ATTACHMENT_OBJECT_STORE_SECRET_KEY,
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
    SMTP_SECURE,
    EMAIL_API_KEY,
    ZEPTOMAIL_API_URL,
    GOOGLE_CLIENT_IDS,
    FACEBOOK_APP_ID,
    FACEBOOK_APP_SECRET,
    CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET,
    FCM_PROJECT_ID,
    FCM_SERVICE_ACCOUNT_JSON_BASE64,
    WEB_PUSH_VAPID_PUBLIC_KEY,
    WEB_PUSH_VAPID_PRIVATE_KEY,
    WEB_PUSH_SUBJECT,
    TURN_URLS,
    TURN_SHARED_SECRET,
    ...scalars
  } = env;
  const smtpServer = group({ host: SMTP_HOST, port: SMTP_PORT });

  return {
    ...scalars,
    objectStore: group({
      endpoint: ATTACHMENT_OBJECT_STORE_ENDPOINT,
      bucket: ATTACHMENT_OBJECT_STORE_BUCKET,
      accessKey: ATTACHMENT_OBJECT_STORE_ACCESS_KEY,
      secretKey: ATTACHMENT_OBJECT_STORE_SECRET_KEY,
    }),
    smtp: smtpServer && {
      ...smtpServer,
      secure: SMTP_SECURE,
      auth: group({ user: SMTP_USER, pass: SMTP_PASS }),
    },
    zeptomail:
      EMAIL_API_KEY === undefined ? undefined : { apiKey: EMAIL_API_KEY, url: ZEPTOMAIL_API_URL },
    google: group({ clientIds: GOOGLE_CLIENT_IDS }),
    facebook: group({ appId: FACEBOOK_APP_ID, appSecret: FACEBOOK_APP_SECRET }),
    cloudinary: group({
      cloudName: CLOUDINARY_CLOUD_NAME,
      apiKey: CLOUDINARY_API_KEY,
      apiSecret: CLOUDINARY_API_SECRET,
    }),
    fcm: group({
      projectId: FCM_PROJECT_ID,
      serviceAccountJsonBase64: FCM_SERVICE_ACCOUNT_JSON_BASE64,
    }),
    webPush: group({
      vapidPublicKey: WEB_PUSH_VAPID_PUBLIC_KEY,
      vapidPrivateKey: WEB_PUSH_VAPID_PRIVATE_KEY,
      subject: WEB_PUSH_SUBJECT,
    }),
    turn: group({ urls: TURN_URLS, sharedSecret: TURN_SHARED_SECRET }),
  };
}

/** The schema's variable names, e.g. for docs or `.env.example` checks. */
export const SERVER_ENV_KEYS = Object.keys(serverEnvSchema.shape) as ServerEnvKey[];
