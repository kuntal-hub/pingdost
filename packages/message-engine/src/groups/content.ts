/** Building and reading group Contents: `GroupControl`, `RoomKey`, `RoomKeyRequest`. */
import {
  bytesToUuid,
  GroupControl_Action,
  GroupMember_Role,
  uuidToBytes,
  type GroupControl,
} from '@pingdost/protocol';

import type { ControlAction, ControlInput } from './state';
import type { buildContent, CheckedHeader } from '../content';
import type { GroupMemberRecord, GroupRecord, GroupRole } from '../store';

type Body = Parameters<typeof buildContent>[1];

/** Inline group pictures travel inside one envelope (ADR 0016). */
export const GROUP_AVATAR_MAX_BYTES = 32_768;
export const GROUP_NAME_MAX = 100;
export const GROUP_DESCRIPTION_MAX = 500;

const ACTIONS: Record<ControlAction, GroupControl_Action> = {
  create: GroupControl_Action.CREATE,
  snapshot: GroupControl_Action.SNAPSHOT,
  add: GroupControl_Action.ADD_MEMBERS,
  remove: GroupControl_Action.REMOVE_MEMBERS,
  leave: GroupControl_Action.LEAVE,
  change_role: GroupControl_Action.CHANGE_ROLE,
  update_info: GroupControl_Action.UPDATE_INFO,
};

const ROLES: Record<GroupRole, GroupMember_Role> = {
  owner: GroupMember_Role.OWNER,
  admin: GroupMember_Role.ADMIN,
  member: GroupMember_Role.MEMBER,
};

/** CREATE, SNAPSHOT and UPDATE_INFO carry the name, description and picture. */
const WITH_INFO: ReadonlySet<ControlAction> = new Set(['create', 'snapshot', 'update_info']);

export function controlBody(action: ControlAction, group: GroupRecord, users: string[]): Body {
  const info = WITH_INFO.has(action);
  return {
    case: 'groupControl',
    value: {
      groupId: uuidToBytes(group.groupId),
      action: ACTIONS[action],
      memberUserIds: users.map((id) => uuidToBytes(id)),
      version: BigInt(group.version),
      members: group.members.map((m) => ({ userId: uuidToBytes(m.userId), role: ROLES[m.role] })),
      ...(info
        ? {
            name: group.name,
            description: group.description,
            avatar: group.avatar ?? new Uint8Array(0),
          }
        : {}),
    },
  };
}

export function roomKeyBody(
  groupId: string,
  sessionId: string,
  sessionKey: string,
  exported: boolean,
): Body {
  return {
    case: 'roomKey',
    value: { groupId: uuidToBytes(groupId), sessionId, sessionKey, exported },
  };
}

export function keyRequestBody(groupId: string, sessionId: string, fromIndex: number): Body {
  return {
    case: 'roomKeyRequest',
    value: { groupId: uuidToBytes(groupId), sessionId, fromIndex },
  };
}

/** A decoded control as `applyControl` takes it, or undefined when malformed. */
export function readControl(value: GroupControl, header: CheckedHeader): ControlInput | undefined {
  const action = (Object.keys(ACTIONS) as ControlAction[]).find((a) => ACTIONS[a] === value.action);
  if (!action) return undefined;
  try {
    const members: GroupMemberRecord[] = [];
    for (const member of value.members) {
      const role = (Object.keys(ROLES) as GroupRole[]).find((r) => ROLES[r] === member.role);
      if (!role) return undefined;
      members.push({ userId: bytesToUuid(member.userId), role });
    }
    if (new Set(members.map((m) => m.userId)).size !== members.length) return undefined;
    if (members.filter((m) => m.role === 'owner').length > 1) return undefined;
    const info = WITH_INFO.has(action);
    return {
      action,
      groupId: bytesToUuid(value.groupId),
      senderUserId: header.senderUserId,
      users: value.memberUserIds.map((id) => bytesToUuid(id)),
      version: Number(value.version),
      members,
      name: info ? value.name.slice(0, GROUP_NAME_MAX) : '',
      description: info ? value.description.slice(0, GROUP_DESCRIPTION_MAX) : '',
      avatar:
        info && value.avatar.length > 0 && value.avatar.length <= GROUP_AVATAR_MAX_BYTES
          ? value.avatar
          : null,
      sentAt: header.sentAt,
      messageId: header.messageId,
    };
  } catch {
    return undefined;
  }
}
