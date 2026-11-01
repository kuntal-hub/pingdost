/**
 * Calls (REQ §12, ADR 0028): `GET /v1/calls/turn-credentials`. TURN credentials follow the
 * TURN REST API convention coturn checks with `use-auth-secret`: username `expiry:userId`,
 * credential base64(HMAC-SHA1(secret, username)). They expire with `expiresAt`; the shared
 * secret never leaves the server.
 */
import { z } from 'zod';

import { EpochMsSchema } from './common';

/** `RTCIceServer`. */
export const IceServerSchema = z.object({
  urls: z.array(z.string().regex(/^(stuns?|turns?):/)).min(1),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServerDto = z.infer<typeof IceServerSchema>;

export const TurnCredentialsResponseSchema = z.object({
  /** STUN first, then TURN with this caller's short-lived credentials (empty: none set up). */
  iceServers: z.array(IceServerSchema),
  /** When the TURN credentials stop working (epoch ms); fetch new ones per call. */
  expiresAt: EpochMsSchema,
  ttlSeconds: z.int().positive(),
});
export type TurnCredentialsResponse = z.infer<typeof TurnCredentialsResponseSchema>;
