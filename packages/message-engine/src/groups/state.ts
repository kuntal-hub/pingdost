/**
 * Group membership as this device sees it (ADR 0016). Pure, so every rule is unit-tested.
 *
 * - Membership comes from E2EE `GroupControl`s. Each carries the server's version after the
 *   change and the full member list, so the newest version wins and skipped versions are
 *   harmless. A control counts only if its sender may make it in the state this device has:
 *   admins add, remove plain members and change info; the owner removes admins and changes
 *   roles; anyone leaves; CREATE and SNAPSHOT come from an admin listed in them.
 * - The server's view (`GET /v1/groups/:id`) is applied only restrictively: it removes
 *   members and lowers roles, never adds. A server cannot make clients share keys with a user
 *   no admin added.
 * - A late ADD (older than the state already applied) still adds the users it names if the
 *   server lists them now.
 * - Name, description and avatar: last-write-wins on (header time, message ID).
 */
import type { GroupNotice } from './notices';
import type { GroupMemberRecord, GroupRecord, GroupRole } from '../store';

export type ControlAction =
  'create' | 'snapshot' | 'add' | 'remove' | 'leave' | 'change_role' | 'update_info';

/** A decrypted, decoded `GroupControl` with its authenticated sender. */
export interface ControlInput {
  action: ControlAction;
  groupId: string;
  senderUserId: string;
  /** The users added, removed or whose role changed. */
  users: string[];
  version: number;
  members: GroupMemberRecord[];
  name: string;
  description: string;
  avatar: Uint8Array | null;
  sentAt: number;
  messageId: string;
}

export type ControlResult =
  | { applied: false; reason: 'stale' | 'not_allowed' | 'not_member' | 'unknown_group' | 'left' }
  | {
      applied: true;
      group: GroupRecord;
      /** The notice to show, if any. */
      notice: GroupNotice | undefined;
      /** The member set or a role changed (Megolm sessions rotate on the next send). */
      membersChanged: boolean;
    };

const RANK: Record<GroupRole, number> = { owner: 3, admin: 2, member: 1 };

export function roleOf(group: Pick<GroupRecord, 'members'>, userId: string): GroupRole | undefined {
  return group.members.find((m) => m.userId === userId)?.role;
}

export function isAdmin(role: GroupRole | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export function isMember(group: Pick<GroupRecord, 'members'>, userId: string): boolean {
  return group.members.some((m) => m.userId === userId);
}

/** The member set as one string, for "did it change" checks. */
export function memberKey(group: Pick<GroupRecord, 'members'>): string {
  return group.members
    .map((m) => m.userId)
    .sort()
    .join(',');
}

function sameMembers(a: GroupMemberRecord[], b: GroupMemberRecord[]): boolean {
  const key = (list: GroupMemberRecord[]) =>
    list
      .map((m) => `${m.userId}:${m.role}`)
      .sort()
      .join(',');
  return key(a) === key(b);
}

/** Drops members the server removed in a version newer than `version`. */
function restrict(
  members: GroupMemberRecord[],
  group: GroupRecord | undefined,
  version: number,
): GroupMemberRecord[] {
  if (!group || group.serverVersion <= version) return members;
  const allowed = new Set(group.serverMembers.map((m) => m.userId));
  return members.filter((m) => allowed.has(m.userId));
}

function infoNewer(group: GroupRecord | undefined, c: ControlInput): boolean {
  if (!group) return true;
  return c.sentAt > group.infoAt || (c.sentAt === group.infoAt && c.messageId > group.infoId);
}

function withInfo(group: GroupRecord, c: ControlInput): GroupRecord {
  return {
    ...group,
    name: c.name,
    description: c.description,
    avatar: c.avatar,
    infoAt: c.sentAt,
    infoId: c.messageId,
  };
}

/** A new group record from a control or a server response. */
export function newGroup(
  groupId: string,
  members: GroupMemberRecord[],
  version: number,
  now: number,
): GroupRecord {
  return {
    groupId,
    version,
    members,
    serverVersion: 0,
    serverMembers: [],
    name: '',
    description: '',
    avatar: null,
    infoAt: 0,
    infoId: '',
    left: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function applyControl(
  current: GroupRecord | undefined,
  c: ControlInput,
  selfUserId: string,
  now: number,
): ControlResult {
  if (c.action === 'create' || c.action === 'snapshot')
    return applyState(current, c, selfUserId, now);
  if (!current) return { applied: false, reason: 'unknown_group' };
  if (current.left) return { applied: false, reason: 'left' };

  const senderRole = roleOf(current, c.senderUserId);
  if (c.action === 'update_info') {
    if (!isAdmin(senderRole)) return { applied: false, reason: 'not_allowed' };
    if (!infoNewer(current, c)) return { applied: false, reason: 'stale' };
    return {
      applied: true,
      group: { ...withInfo(current, c), updatedAt: now },
      notice: { type: 'info', by: c.senderUserId },
      membersChanged: false,
    };
  }

  if (!allowed(current, c, senderRole)) return { applied: false, reason: 'not_allowed' };
  const notice = noticeFor(c);

  if (c.version <= current.version) {
    // Older than the state here, usually because the server's change notice was faster: the
    // removals are in already. An ADD or a promotion still counts where the server agrees
    // now; the notice is shown either way.
    const server = new Map(
      current.serverVersion >= c.version
        ? current.serverMembers.map((m) => [m.userId, m.role])
        : [],
    );
    let members = current.members;
    if (c.action === 'add') {
      const added = c.users.filter((u) => server.has(u) && !isMember(current, u));
      members = [...members, ...added.map((userId) => ({ userId, role: 'member' as const }))];
    } else if (c.action === 'change_role') {
      const role = c.members.find((m) => m.userId === c.users[0])?.role;
      members = members.map((m) =>
        c.users.includes(m.userId) && role && server.get(m.userId) === role ? { ...m, role } : m,
      );
    }
    const changed = !sameMembers(members, current.members);
    return {
      applied: true,
      group: changed ? { ...current, members, updatedAt: now } : current,
      notice,
      membersChanged: changed,
    };
  }

  const members = restrict(c.members, current, c.version);
  const left = !members.some((m) => m.userId === selfUserId);
  return {
    applied: true,
    group: { ...current, members, version: c.version, left, updatedAt: now },
    notice,
    membersChanged: !sameMembers(members, current.members),
  };
}

/** CREATE (the first state) or SNAPSHOT (the whole state, for a member just added). */
function applyState(
  current: GroupRecord | undefined,
  c: ControlInput,
  selfUserId: string,
  now: number,
): ControlResult {
  const listed = (userId: string) => c.members.find((m) => m.userId === userId)?.role;
  if (!isAdmin(listed(c.senderUserId))) return { applied: false, reason: 'not_allowed' };
  if (c.action === 'create' && listed(c.senderUserId) !== 'owner') {
    return { applied: false, reason: 'not_allowed' };
  }
  if (!listed(selfUserId)) return { applied: false, reason: 'not_member' };

  if (current && !current.left && c.version <= current.version) {
    // Membership is not newer; the info may be.
    if (!infoNewer(current, c)) return { applied: false, reason: 'stale' };
    return {
      applied: true,
      group: { ...withInfo(current, c), updatedAt: now },
      notice: undefined,
      membersChanged: false,
    };
  }
  if (current?.left && c.version <= current.version) return { applied: false, reason: 'stale' };

  const base = current ?? newGroup(c.groupId, [], c.version, now);
  const members = restrict(c.members, current, c.version);
  let group: GroupRecord = {
    ...base,
    members,
    version: c.version,
    left: !members.some((m) => m.userId === selfUserId),
    updatedAt: now,
  };
  if (infoNewer(current, c)) group = withInfo(group, c);
  const notice: GroupNotice | undefined =
    c.action === 'create'
      ? { type: 'created', by: c.senderUserId }
      : !current || current.left
        ? { type: 'joined', by: c.senderUserId }
        : undefined;
  return {
    applied: true,
    group,
    notice,
    membersChanged: !current || !sameMembers(members, current.members),
  };
}

function allowed(
  current: GroupRecord,
  c: ControlInput,
  senderRole: GroupRole | undefined,
): boolean {
  switch (c.action) {
    case 'leave':
      // Only for oneself; the server's notice may already have removed the sender here.
      return c.users.length === 1 && c.users[0] === c.senderUserId;
    case 'add':
      return isAdmin(senderRole);
    case 'remove':
      // Admins remove plain members; the owner removes anyone else.
      return (
        isAdmin(senderRole) &&
        c.users.every((u) => {
          const role = roleOf(current, u);
          return role === undefined || RANK[role] < RANK[senderRole!];
        })
      );
    case 'change_role':
      return senderRole === 'owner';
    default:
      return false;
  }
}

function noticeFor(c: ControlInput): GroupNotice | undefined {
  switch (c.action) {
    case 'add':
      return { type: 'added', by: c.senderUserId, users: c.users };
    case 'remove':
      return { type: 'removed', by: c.senderUserId, users: c.users };
    case 'leave':
      return { type: 'left', users: c.users };
    case 'change_role': {
      const role = c.members.find((m) => m.userId === c.users[0])?.role ?? 'member';
      return { type: 'role', by: c.senderUserId, users: c.users, role };
    }
    default:
      return undefined;
  }
}

/** The server's view of a group, from `GET /v1/groups/:id`, or "not a member any more". */
export type ServerView = { version: number; members: GroupMemberRecord[] } | 'not_member';

/**
 * Applies the server's view restrictively: members it no longer lists are removed and roles
 * it lowered are lowered. Additions are ignored (they need an admin's control).
 */
export function reconcile(
  current: GroupRecord,
  server: ServerView,
  selfUserId: string,
  now: number,
): {
  group: GroupRecord;
  changed: boolean;
  notice: GroupNotice | undefined;
  membersChanged: boolean;
} {
  if (server === 'not_member') {
    if (current.left)
      return { group: current, changed: false, notice: undefined, membersChanged: false };
    return {
      group: { ...current, left: true, updatedAt: now },
      changed: true,
      notice: { type: 'not_member' },
      membersChanged: true,
    };
  }
  if (server.version <= current.serverVersion) {
    return { group: current, changed: false, notice: undefined, membersChanged: false };
  }
  const serverRoles = new Map(server.members.map((m) => [m.userId, m.role]));
  const members: GroupMemberRecord[] = [];
  for (const member of current.members) {
    const role = serverRoles.get(member.userId);
    if (!role) continue;
    members.push(RANK[role] < RANK[member.role] ? { ...member, role } : member);
  }
  const left = current.left || !serverRoles.has(selfUserId);
  const group: GroupRecord = {
    ...current,
    members,
    version: Math.max(current.version, server.version),
    serverVersion: server.version,
    serverMembers: server.members,
    left,
    updatedAt: now,
  };
  return {
    group,
    changed: true,
    notice: left && !current.left ? { type: 'not_member' } : undefined,
    membersChanged: !sameMembers(members, current.members),
  };
}
