/**
 * Short-lived TURN credentials (REQ §12.1, ADR 0028), the TURN REST API convention that coturn
 * checks with `use-auth-secret` + `static-auth-secret`:
 *   username   = "<expiry unix seconds>:<user ID>"
 *   credential = base64(HMAC-SHA1(TURN_SHARED_SECRET, username))
 * coturn recomputes the HMAC and refuses the username once its expiry has passed. The secret
 * stays on the server; clients get only the derived pair.
 */
import { createHmac } from 'node:crypto';

import type { IceServerDto, TurnCredentialsResponse } from '@pingdost/shared-types';

export interface TurnSettings {
  stunUrls: readonly string[];
  /** Unset: no TURN (calls then work only where a direct path exists). */
  turn?: { urls: readonly string[]; sharedSecret: string };
  ttlSeconds: number;
}

export function turnCredential(
  sharedSecret: string,
  userId: string,
  nowMs: number,
  ttlSeconds: number,
): { username: string; credential: string; expiresAtSeconds: number } {
  const expiresAtSeconds = Math.floor(nowMs / 1_000) + ttlSeconds;
  const username = `${expiresAtSeconds}:${userId}`;
  const credential = createHmac('sha1', sharedSecret).update(username, 'utf8').digest('base64');
  return { username, credential, expiresAtSeconds };
}

export function iceServersFor(
  settings: TurnSettings,
  userId: string,
  nowMs: number,
): TurnCredentialsResponse {
  const iceServers: IceServerDto[] = [];
  if (settings.stunUrls.length > 0) iceServers.push({ urls: [...settings.stunUrls] });
  let expiresAt = nowMs + settings.ttlSeconds * 1_000;
  if (settings.turn) {
    const { username, credential, expiresAtSeconds } = turnCredential(
      settings.turn.sharedSecret,
      userId,
      nowMs,
      settings.ttlSeconds,
    );
    iceServers.push({ urls: [...settings.turn.urls], username, credential });
    expiresAt = expiresAtSeconds * 1_000;
  }
  return { iceServers, expiresAt, ttlSeconds: settings.ttlSeconds };
}
