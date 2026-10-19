/**
 * Client-safe configuration for the mobile and web apps: shared constants and
 * `EXPO_PUBLIC_*` / `VITE_*` parsing.
 *
 * This module ships inside client bundles. It must never import `./server` or name a
 * server secret (ARCHITECTURE A10); ESLint and `public.test.ts` enforce this.
 */
import { z } from 'zod';

import { ConfigError, formatZodIssues, withoutBlankValues } from './errors';

/** One "MB" in the UI is a binary megabyte, everywhere (ARCHITECTURE A8). */
export const BYTES_PER_MB = 1_048_576;

/**
 * Default limits shared by the server and clients (REQ §9.1, §11.4, §17). The server can
 * override them through its env; clients should prefer the limits the server reports.
 */
export const DEFAULT_LIMITS = {
  attachmentMaxBytes: 104_857_600,
  envelopeMaxBytes: 65_536,
  groupMaxMembers: 64,
  /**
   * `MESSAGE_MAX_RETENTION_SECONDS`: senders mark a message `expired_undelivered` when no
   * delivery receipt arrived by then (ARCHITECTURE A3).
   */
  messageMaxRetentionSeconds: 1_209_600,
  meshPacketMaxHops: 8,
  meshPacketTtlSeconds: 1_209_600,
  meshRelayStorageLimitBytes: 262_144_000,
  syncRecentDays: 30,
  webPairingTtlSeconds: 120,
} as const;

/** Allowed range for `MESH_PACKET_MAX_HOPS` (REQ §11.4). */
export const MESH_PACKET_MAX_HOPS_RANGE = { min: 1, max: 32 } as const;

export type PublicEnvPrefix = 'EXPO_PUBLIC_' | 'VITE_';

export interface PublicConfig {
  apiUrl: string;
  wsUrl: string;
  /**
   * The OAuth "Web application" client ID the mobile app asks Google for ID tokens with
   * (one of the server's GOOGLE_CLIENT_IDS). Public, not a secret; absent hides Google
   * sign-in.
   */
  googleWebClientId?: string;
}

const publicEnvSchema = z.object({
  API_URL: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }),
  WS_URL: z.url({ protocol: /^wss?$/, error: 'must be a ws(s) URL' }),
  GOOGLE_WEB_CLIENT_ID: z
    .string()
    .regex(/\.apps\.googleusercontent\.com$/, 'must end with .apps.googleusercontent.com')
    .optional(),
});

/**
 * Parses client config from prefixed variables, e.g. `EXPO_PUBLIC_API_URL` or `VITE_API_URL`.
 *
 * Expo inlines only static `process.env.EXPO_PUBLIC_*` references, so the mobile app must pass
 * an object literal built from those references. The web app can pass `import.meta.env`.
 */
export function loadPublicConfig(
  env: Readonly<Record<string, unknown>>,
  prefix: PublicEnvPrefix,
): PublicConfig {
  const provided = withoutBlankValues(env);
  const input: Record<string, string> = {};
  for (const key of Object.keys(publicEnvSchema.shape)) {
    const value = provided[prefix + key];
    if (value !== undefined) input[key] = value;
  }

  const parsed = publicEnvSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError('public', formatZodIssues(parsed.error, input, prefix));
  }
  const { API_URL, WS_URL, GOOGLE_WEB_CLIENT_ID } = parsed.data;
  return {
    apiUrl: API_URL,
    wsUrl: WS_URL,
    ...(GOOGLE_WEB_CLIENT_ID === undefined ? {} : { googleWebClientId: GOOGLE_WEB_CLIENT_ID }),
  };
}
