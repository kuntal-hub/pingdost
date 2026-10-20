/**
 * Group DTOs: `/v1/groups*` (Phase 13). The server keeps membership and roles only as
 * routing metadata; name, description and avatar are E2EE `GroupControl` content.
 */
import { z } from 'zod';

import { EpochMsSchema, IdSchema } from './common';

export const GroupRoleSchema = z.enum(['owner', 'admin', 'member']);
export type GroupRole = z.infer<typeof GroupRoleSchema>;

export const GroupMemberSchema = z.object({
  userId: IdSchema,
  role: GroupRoleSchema,
  addedAt: EpochMsSchema,
});
export type GroupMember = z.infer<typeof GroupMemberSchema>;

/** Response of every group endpoint. */
export const GroupSchema = z.object({
  groupId: IdSchema,
  createdBy: IdSchema,
  members: z.array(GroupMemberSchema),
  /** Bumped on every membership or role change. */
  version: z.int().nonnegative(),
  createdAt: EpochMsSchema,
});
export type Group = z.infer<typeof GroupSchema>;

// GET /v1/groups: the caller's groups.
export const GroupListResponseSchema = z.object({ groups: z.array(GroupSchema) });
export type GroupListResponse = z.infer<typeof GroupListResponseSchema>;

/** At most this many users per create or add request (the group limit still applies). */
export const MAX_GROUP_REQUEST_USERS = 256;

// POST /v1/groups
export const CreateGroupRequestSchema = z.object({
  /** Client-generated UUIDv7. */
  groupId: IdSchema,
  /** The other members; the caller becomes the owner. */
  memberUserIds: z.array(IdSchema).min(1).max(MAX_GROUP_REQUEST_USERS),
});
export type CreateGroupRequest = z.infer<typeof CreateGroupRequestSchema>;

// POST /v1/groups/:groupId/members (admins and the owner)
export const AddGroupMembersRequestSchema = z.object({
  userIds: z.array(IdSchema).min(1).max(MAX_GROUP_REQUEST_USERS),
});
export type AddGroupMembersRequest = z.infer<typeof AddGroupMembersRequestSchema>;

// PATCH /v1/groups/:groupId/members/:userId (the owner). Ownership cannot be handed over
// this way; it passes on only when the owner leaves.
export const ChangeGroupRoleRequestSchema = z.object({ role: z.enum(['admin', 'member']) });
export type ChangeGroupRoleRequest = z.infer<typeof ChangeGroupRoleRequestSchema>;

// DELETE /v1/groups/:groupId/members/:userId (remove, or leave when it is the caller) → Group
// as it is after the change.
