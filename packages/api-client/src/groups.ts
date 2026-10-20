import {
  GroupListResponseSchema,
  GroupSchema,
  type ChangeGroupRoleRequest,
  type Group,
} from '@pingdost/shared-types';

import type { ApiClient } from './client';

/** `/v1/groups*` (Phase 13): membership and roles as routing metadata, nothing else. */
export interface GroupsApi {
  /** The caller becomes the owner. */
  create(groupId: string, memberUserIds: string[]): Promise<Group>;
  /** The caller's groups. */
  list(): Promise<Group[]>;
  /** Members only (`NOT_A_MEMBER` otherwise). */
  get(groupId: string): Promise<Group>;
  addMembers(groupId: string, userIds: string[]): Promise<Group>;
  /** Removes `userId`, or leaves when it is the caller. */
  removeMember(groupId: string, userId: string): Promise<Group>;
  setRole(groupId: string, userId: string, role: ChangeGroupRoleRequest['role']): Promise<Group>;
}

export function groupsApi(client: ApiClient): GroupsApi {
  const member = (groupId: string, userId: string) =>
    `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`;
  return {
    create: (groupId, memberUserIds) =>
      client.request({
        method: 'POST',
        path: '/v1/groups',
        body: { groupId, memberUserIds },
        response: GroupSchema,
      }),
    list: async () =>
      (
        await client.request({
          method: 'GET',
          path: '/v1/groups',
          response: GroupListResponseSchema,
        })
      ).groups,
    get: (groupId) =>
      client.request({
        method: 'GET',
        path: `/v1/groups/${encodeURIComponent(groupId)}`,
        response: GroupSchema,
      }),
    addMembers: (groupId, userIds) =>
      client.request({
        method: 'POST',
        path: `/v1/groups/${encodeURIComponent(groupId)}/members`,
        body: { userIds },
        response: GroupSchema,
      }),
    removeMember: (groupId, userId) =>
      client.request({ method: 'DELETE', path: member(groupId, userId), response: GroupSchema }),
    setRole: (groupId, userId, role) =>
      client.request({
        method: 'PATCH',
        path: member(groupId, userId),
        body: { role },
        response: GroupSchema,
      }),
  };
}
