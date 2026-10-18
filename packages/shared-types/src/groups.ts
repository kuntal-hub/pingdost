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

// POST /v1/groups
export const CreateGroupRequestSchema = z.object({
  /** Client-generated UUIDv7. */
  groupId: IdSchema,
  memberUserIds: z.array(IdSchema).min(1),
});
export type CreateGroupRequest = z.infer<typeof CreateGroupRequestSchema>;

// POST /v1/groups/:groupId/members
export const AddGroupMembersRequestSchema = z.object({ userIds: z.array(IdSchema).min(1) });
export type AddGroupMembersRequest = z.infer<typeof AddGroupMembersRequestSchema>;

// PATCH /v1/groups/:groupId/members/:userId
export const ChangeGroupRoleRequestSchema = z.object({ role: GroupRoleSchema });
export type ChangeGroupRoleRequest = z.infer<typeof ChangeGroupRoleRequestSchema>;

// DELETE /v1/groups/:groupId/members/:userId (remove, or leave when it is the caller) → Group
