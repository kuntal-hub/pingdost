/**
 * Group management (ADR 0016). A membership change goes to the server first, which checks the
 * roles and the size limit and bumps the version; then it goes to the members as an E2EE
 * `GroupControl`, which is what their devices act on. A member just added also gets a
 * SNAPSHOT with the name, description and picture. Info changes are E2EE only.
 *
 * `sync` / `syncAll` apply the server's view, restrictively (`state.ts`).
 */
import { uuidv7 } from '@pingdost/protocol';
import type { Group } from '@pingdost/shared-types';

import {
  controlBody,
  GROUP_AVATAR_MAX_BYTES,
  GROUP_DESCRIPTION_MAX,
  GROUP_NAME_MAX,
} from './content';
import { groupNoticeBody, type GroupNotice } from './notices';
import {
  isAdmin,
  isMember,
  newGroup,
  reconcile,
  roleOf,
  type ControlAction,
  type ServerView,
} from './state';
import { buildContent } from '../content';
import type { EngineCore, GroupsApi } from '../core';
import { errorCode } from '../directory';
import { MessageActionError } from '../errors';
import type { Outbox } from '../outbox';
import type {
  ConversationRecord,
  FanoutItem,
  GroupMemberRecord,
  GroupRecord,
  WriteBatch,
} from '../store';

export interface GroupInfo {
  name: string;
  description?: string;
  /** A small image (at most 32 KiB), or null for none. */
  avatar?: Uint8Array | null;
}

function membersOf(group: Group): GroupMemberRecord[] {
  return group.members.map((m) => ({ userId: m.userId, role: m.role }));
}

function checkInfo(info: GroupInfo): {
  name: string;
  description: string;
  avatar: Uint8Array | null;
} {
  const name = info.name.trim();
  const description = (info.description ?? '').trim();
  if (name === '' || name.length > GROUP_NAME_MAX) {
    throw new MessageActionError('invalid', `a group name has 1 to ${GROUP_NAME_MAX} characters`);
  }
  if (description.length > GROUP_DESCRIPTION_MAX) {
    throw new MessageActionError('invalid', 'the description is too long');
  }
  const avatar = info.avatar && info.avatar.length > 0 ? info.avatar : null;
  if (avatar && avatar.length > GROUP_AVATAR_MAX_BYTES) {
    throw new MessageActionError('invalid', 'the group picture is too large');
  }
  return { name, description, avatar };
}

export class GroupManager {
  constructor(
    private readonly core: EngineCore,
    private readonly outbox: Outbox,
  ) {}

  get #api(): GroupsApi {
    const api = this.core.options.api.groups;
    if (!api) throw new Error('group chats need EngineOptions.api.groups');
    return api;
  }

  get #self(): string {
    return this.core.self.userId;
  }

  async create(input: GroupInfo & { memberUserIds: string[] }): Promise<ConversationRecord> {
    const { core } = this;
    const info = checkInfo(input);
    const others = [...new Set(input.memberUserIds)].filter((id) => id !== this.#self);
    if (others.length === 0)
      throw new MessageActionError('invalid', 'a group needs another member');
    const groupId = uuidv7();
    const server = await this.#api.create(groupId, others);
    const conversation = await core.mutex.run(async () => {
      const now = core.now();
      const opId = uuidv7();
      const members = membersOf(server);
      const group: GroupRecord = {
        ...newGroup(groupId, members, server.version, now),
        serverVersion: server.version,
        serverMembers: members,
        ...info,
        infoAt: now,
        infoId: opId,
      };
      const batch: WriteBatch = { groups: [group] };
      const created = this.#notice(batch, core.newGroupConversation(groupId, now), {
        type: 'created',
        by: this.#self,
      });
      batch.outbox = [this.#control(opId, group, 'create', [], ids(group), now)];
      await core.commit(batch);
      return created;
    });
    this.outbox.kick();
    return conversation;
  }

  async addMembers(groupId: string, userIds: string[]): Promise<void> {
    const local = await this.#member(groupId, 'admin');
    const toAdd = [...new Set(userIds)].filter((id) => id !== this.#self && !isMember(local, id));
    if (toAdd.length === 0) return;
    const server = await this.#api.addMembers(groupId, toAdd);
    await this.#change(groupId, server, (current, now, batch) => {
      const listed = new Set(server.members.map((m) => m.userId));
      const added = toAdd.filter((id) => listed.has(id) && !isMember(current, id));
      if (added.length === 0) return current;
      const group: GroupRecord = {
        ...current,
        members: [
          ...current.members,
          ...added.map((userId) => ({ userId, role: 'member' as const })),
        ],
      };
      // Everyone already in hears of the addition; the new members get the whole state.
      batch.outbox!.push(this.#control(uuidv7(), group, 'add', added, ids(current), now));
      batch.outbox!.push(this.#control(uuidv7(), group, 'snapshot', [], added, now));
      return { group, notice: { type: 'added', by: this.#self, users: added } };
    });
  }

  async removeMember(groupId: string, userId: string): Promise<void> {
    if (userId === this.#self) return this.leave(groupId);
    const local = await this.#member(groupId, 'admin');
    if (!isMember(local, userId)) return;
    const server = await this.#api.removeMember(groupId, userId);
    await this.#change(groupId, server, (current, now, batch) => {
      const group: GroupRecord = {
        ...current,
        members: current.members.filter((m) => m.userId !== userId),
      };
      // The removed user hears of it too, so their app turns read-only at once.
      batch.outbox!.push(this.#control(uuidv7(), group, 'remove', [userId], ids(current), now));
      return { group, notice: { type: 'removed', by: this.#self, users: [userId] } };
    });
  }

  async leave(groupId: string): Promise<void> {
    await this.#member(groupId, 'member');
    let server: Group | undefined;
    try {
      server = await this.#api.removeMember(groupId, this.#self);
    } catch (error) {
      // Already out on the server: finish locally.
      const code = errorCode(error);
      if (code !== 'NOT_A_MEMBER' && code !== 'NOT_FOUND') throw error;
    }
    await this.#change(groupId, server, (current, now, batch) => {
      const group: GroupRecord = {
        ...current,
        members: current.members.filter((m) => m.userId !== this.#self),
        left: true,
      };
      batch.outbox!.push(this.#control(uuidv7(), group, 'leave', [this.#self], ids(current), now));
      return { group, notice: { type: 'left', users: [this.#self] } };
    });
  }

  async setRole(groupId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
    const local = await this.#member(groupId, 'owner');
    const currentRole = roleOf(local, userId);
    if (!currentRole || currentRole === 'owner') {
      throw new MessageActionError('not_allowed', 'that role cannot be changed');
    }
    if (currentRole === role) return;
    const server = await this.#api.setRole(groupId, userId, role);
    await this.#change(groupId, server, (current, now, batch) => {
      const group: GroupRecord = {
        ...current,
        members: current.members.map((m) => (m.userId === userId ? { ...m, role } : m)),
      };
      batch.outbox!.push(this.#control(uuidv7(), group, 'change_role', [userId], ids(group), now));
      return { group, notice: { type: 'role', by: this.#self, users: [userId], role } };
    });
  }

  /** Name, description and picture: E2EE only, last-write-wins on every device. */
  async updateInfo(groupId: string, input: GroupInfo): Promise<void> {
    const { core } = this;
    const info = checkInfo(input);
    await this.#member(groupId, 'admin');
    await core.mutex.run(async () => {
      const current = await core.store.getGroup(groupId);
      if (!current || current.left) throw new MessageActionError('not_allowed', 'not a member');
      const now = core.now();
      const opId = uuidv7();
      const group: GroupRecord = { ...current, ...info, infoAt: now, infoId: opId, updatedAt: now };
      const batch: WriteBatch = { groups: [group] };
      this.#notice(batch, await this.#conversation(groupId, now), { type: 'info', by: this.#self });
      batch.outbox = [this.#control(opId, group, 'update_info', [], ids(group), now)];
      await core.commit(batch);
    });
    this.outbox.kick();
  }

  /** Applies the server's view of one group (after a `GroupChanged` notice). */
  async sync(groupId: string): Promise<void> {
    const api = this.core.options.api.groups;
    if (!api) return;
    let view: ServerView;
    try {
      const group = await api.get(groupId);
      view = { version: group.version, members: membersOf(group) };
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'NOT_A_MEMBER' && code !== 'NOT_FOUND') return; // offline: next time
      view = 'not_member';
    }
    await this.#reconcile(groupId, view);
  }

  /** Applies the server's view of every group this device knows (at start). */
  async syncAll(): Promise<void> {
    const api = this.core.options.api.groups;
    if (!api) return;
    let groups: Group[];
    try {
      groups = await api.list();
    } catch {
      return;
    }
    const byId = new Map(groups.map((g) => [g.groupId, g]));
    for (const local of await this.core.store.listGroups()) {
      if (local.left) continue;
      const server = byId.get(local.groupId);
      await this.#reconcile(
        local.groupId,
        server ? { version: server.version, members: membersOf(server) } : 'not_member',
      );
    }
  }

  async #reconcile(groupId: string, view: ServerView): Promise<void> {
    const { core } = this;
    await core.mutex.run(async () => {
      const current = await core.store.getGroup(groupId);
      if (!current) return;
      const now = core.now();
      const result = reconcile(current, view, this.#self, now);
      if (!result.changed) return;
      const batch: WriteBatch = { groups: [result.group] };
      if (result.notice) this.#notice(batch, await this.#conversation(groupId, now), result.notice);
      await core.commit(batch);
    });
  }

  /** This user's group record, if they are at least `role` in it. */
  async #member(groupId: string, role: 'owner' | 'admin' | 'member'): Promise<GroupRecord> {
    const group = await this.core.store.getGroup(groupId);
    if (!group || group.left)
      throw new MessageActionError('not_found', 'not a member of this group');
    const own = roleOf(group, this.#self);
    const allowed =
      role === 'member' ? own !== undefined : role === 'admin' ? isAdmin(own) : own === 'owner';
    if (!allowed) throw new MessageActionError('not_allowed', `only a group ${role} can do that`);
    return group;
  }

  /**
   * Records a change the server accepted: `apply` returns the new group (or the current one
   * for no change) and queues the controls in `batch.outbox`.
   */
  async #change(
    groupId: string,
    server: Group | undefined,
    apply: (
      current: GroupRecord,
      now: number,
      batch: WriteBatch,
    ) => GroupRecord | { group: GroupRecord; notice: GroupNotice },
  ): Promise<void> {
    const { core } = this;
    await core.mutex.run(async () => {
      const current = await core.store.getGroup(groupId);
      if (!current) return;
      const now = core.now();
      const batch: WriteBatch = { outbox: [] };
      const versioned: GroupRecord = server
        ? {
            ...current,
            version: Math.max(current.version, server.version),
            serverVersion: Math.max(current.serverVersion, server.version),
            serverMembers:
              server.version >= current.serverVersion ? membersOf(server) : current.serverMembers,
          }
        : current;
      const result = apply(versioned, now, batch);
      if (result === versioned) return;
      const { group, notice } = 'notice' in result ? result : { group: result, notice: undefined };
      batch.groups = [{ ...group, updatedAt: now }];
      if (notice) this.#notice(batch, await this.#conversation(groupId, now), notice);
      await core.commit(batch);
    });
    this.outbox.kick();
  }

  async #conversation(groupId: string, now: number): Promise<ConversationRecord> {
    return (
      (await this.core.store.getConversation(groupId)) ??
      this.core.newGroupConversation(groupId, now)
    );
  }

  #notice(
    batch: WriteBatch,
    conversation: ConversationRecord,
    notice: GroupNotice,
  ): ConversationRecord {
    return this.core.addSystemMessage(batch, conversation, groupNoticeBody(notice), this.#self);
  }

  /** A control to `recipients`' devices (this user's other devices included) over Olm. */
  #control(
    contentId: string,
    group: GroupRecord,
    action: ControlAction,
    users: string[],
    recipients: string[],
    now: number,
  ): FanoutItem {
    const { core } = this;
    const content = buildContent(
      {
        messageId: contentId,
        conversationId: group.groupId,
        senderUserId: this.#self,
        sentAt: now,
      },
      controlBody(action, group, users),
      core.settings.envelopeMaxBytes,
    );
    return {
      type: 'fanout',
      purpose: 'control',
      id: contentId,
      messageId: contentId,
      conversationId: group.groupId,
      recipientUserIds: [...new Set([...recipients, this.#self])],
      content,
      createdAt: now,
      expiresAt: now + core.settings.maxRetentionMs,
      attempts: 0,
      nextAttemptAt: now,
    };
  }
}

/** Every member's user ID. */
function ids(group: GroupRecord): string[] {
  return group.members.map((m) => m.userId);
}
