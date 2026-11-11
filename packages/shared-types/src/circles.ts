/**
 * Circles: `/v1/circle*` (Phase 37, ADR 0041). People message, call and add to groups only
 * those in their circle. A link is mutual and starts with a request the other side accepts.
 */
import { z } from 'zod';

import { UsernameSchema } from './auth';
import { EpochMsSchema, IdSchema } from './common';
import { DisplayNameSchema } from './profile';

/** People one account's circle can hold. */
export const MAX_CIRCLE = 1_000;
/** A request waits this long for an answer; a declined one stays "requested" for as long. */
export const CIRCLE_REQUEST_TTL_DAYS = 30;
/** New requests one account may send per day. */
export const CIRCLE_REQUESTS_PER_DAY = 20;
/** Requests one account may have waiting at once. */
export const MAX_PENDING_CIRCLE_REQUESTS = 100;

/** The other person, as the server shows them: their public profile only. */
export const CirclePersonSchema = z.object({
  userId: IdSchema,
  username: UsernameSchema.nullable(),
  displayName: DisplayNameSchema.nullable(),
  avatarUrl: z.url().nullable(),
});
export type CirclePerson = z.infer<typeof CirclePersonSchema>;

// GET /v1/circle
export const CircleMemberSchema = CirclePersonSchema.extend({ since: EpochMsSchema });
export type CircleMember = z.infer<typeof CircleMemberSchema>;
export const CircleResponseSchema = z.object({ members: z.array(CircleMemberSchema) });
export type CircleResponse = z.infer<typeof CircleResponseSchema>;

// GET /v1/circle/requests
export const CircleRequestSchema = CirclePersonSchema.extend({
  createdAt: EpochMsSchema,
  expiresAt: EpochMsSchema,
});
export type CircleRequest = z.infer<typeof CircleRequestSchema>;
export const CircleRequestsResponseSchema = z.object({
  /** Sent to this user, waiting for an answer (declined ones are gone). */
  incoming: z.array(CircleRequestSchema),
  /** Sent by this user: shown as "Requested" until accepted, withdrawn or expired. */
  outgoing: z.array(CircleRequestSchema),
});
export type CircleRequestsResponse = z.infer<typeof CircleRequestsResponseSchema>;

// POST /v1/circle/requests
export const SendCircleRequestSchema = z.object({ userId: IdSchema });
export type SendCircleRequest = z.infer<typeof SendCircleRequestSchema>;
/**
 * `requested`: waiting for them. `linked`: they had asked first, so this accepted it; or the
 * link already existed.
 */
export const SendCircleRequestResponseSchema = z.object({
  status: z.enum(['requested', 'linked']),
});
export type SendCircleRequestResponse = z.infer<typeof SendCircleRequestResponseSchema>;

/** How a person relates to the caller's circle (Phase 38 search results). */
export const CircleStateSchema = z.enum(['member', 'requested', 'incoming', 'none']);
export type CircleState = z.infer<typeof CircleStateSchema>;

/** People search (Phase 38, ADR 0042): from this many characters. */
export const USER_SEARCH_MIN = 2;
/** At most this many results. */
export const USER_SEARCH_LIMIT = 10;

// GET /v1/users/search?q=
export const UserSearchQuerySchema = z.object({
  q: z.string().trim().min(USER_SEARCH_MIN).max(254),
});
/** Never an email: a match by email shows only the public profile. */
export const UserSearchResultSchema = CirclePersonSchema.extend({
  username: UsernameSchema,
  circle: CircleStateSchema,
});
export type UserSearchResult = z.infer<typeof UserSearchResultSchema>;
export const UserSearchResponseSchema = z.object({ results: z.array(UserSearchResultSchema) });
export type UserSearchResponse = z.infer<typeof UserSearchResponseSchema>;
