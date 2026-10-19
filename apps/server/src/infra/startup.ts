/** Shared startup for `main.ts` and `worker.ts`: config, logger, Mongo with indexes. */
import type { Logger } from 'pino';

import {
  ConfigError,
  loadServerConfig,
  SERVER_SECRET_KEYS,
  type ServerConfig,
} from '@pingdost/config';

import { createLogger, REDACTED } from './logger';
import { createMongo, ensureIndexes, type IndexSetup, type Mongo } from './mongo';

/** Secrets inside the typed config groups (`SERVER_SECRET_KEYS` covers the flat ones). */
const GROUP_SECRETS: Readonly<Record<string, readonly string[]>> = {
  objectStore: ['accessKey', 'secretKey'],
  zeptomail: ['apiKey'],
  facebook: ['appSecret'],
  cloudinary: ['apiSecret'],
  fcm: ['serviceAccountJsonBase64'],
  webPush: ['vapidPrivateKey'],
  turn: ['sharedSecret'],
};

/** A copy of the config that is safe to log (ADR 0002 §11). */
export function redactConfig(config: ServerConfig): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...config };
  for (const key of SERVER_SECRET_KEYS) {
    if (copy[key] !== undefined) copy[key] = REDACTED;
  }
  for (const [group, fields] of Object.entries(GROUP_SECRETS)) {
    const value = copy[group];
    if (value && typeof value === 'object') {
      const redacted: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      for (const field of fields) if (redacted[field] !== undefined) redacted[field] = REDACTED;
      copy[group] = redacted;
    }
  }
  if (config.smtp?.auth)
    copy.smtp = { ...config.smtp, auth: { user: config.smtp.auth.user, pass: REDACTED } };
  return copy;
}

/** Loads config or exits with the (value-free) list of problems. */
export function loadConfigOrExit(): ServerConfig {
  try {
    return loadServerConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

export function startupLogger(config: ServerConfig, name: string): Logger {
  return createLogger({
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === 'development' && process.stdout.isTTY,
  }).child({ name });
}

/** Connects (failing fast when Mongo is unreachable) and creates every index. */
export async function connectDatabase(
  config: ServerConfig,
  indexes: readonly IndexSetup[],
): Promise<Mongo> {
  const mongo = createMongo(config.MONGODB_URI);
  await mongo.client.connect();
  await ensureIndexes(mongo.db, indexes);
  return mongo;
}
