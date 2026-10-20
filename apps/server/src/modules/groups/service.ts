/**
 * Groups (REQ §8.2, ADR 0016): membership and roles as routing metadata only. The name,
 * description and avatar never reach the server; they travel E2EE in `GroupControl`.
 * - The caller of `create` is the owner. Admins (and the owner) add members and remove plain
 *   members; the owner also removes admins and changes roles. Anyone may leave; a leaving
 *   owner hands ownership to the longest-standing admin, else member. The last member
 *   leaving deletes the group.
 * - Every change bumps `version` (optimistic concurrency) and notifies the members before
 *   and after the change.
 * - The gateway accepts group envelopes only between current members (`isMember`, cached;
 *   one API instance, ARCHITECTURE A2).
 */
import type { Collection, Db } from 'mongodb';

import type { Group, GroupRole } from '@pingdost/shared-types';

import type { Clock } from '../../infra/clock';
import { AppError } from '../../infra/errors';
import type { IndexSetup } from '../../infra/mongo';
import type { AuthCollections } from '../auth/repo';

interface GroupMemberDoc {
  userId: string;
  role: GroupRole;
  addedAt: Date;
  addedBy: string;
}

export interface GroupDoc {
  /** The group ID (client-generated UUIDv7). */
  _id: string;
  createdBy: string;
  members: GroupMemberDoc[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const groupIndexes: IndexSetup = async (db) => {
  await db.collection<GroupDoc>('groups').createIndex({ 'members.userId': 1 });
};

export interface GroupServiceDeps {
  db: Db;
  users: AuthCollections['users'];
  clock: Clock;
  /** `GROUP_MAX_MEMBERS`. */
  maxMembers: number;
  /** After a change: the group's new version and every user to tell (before and after). */
  onChanged?: (groupId: string, version: number, userIds: string[]) => void;
}

/** Cached member sets kept at once; beyond this the cache starts over. */
const MAX_CACHED = 10_000;
const MAX_ATTEMPTS = 3;
const RANK: Record<GroupRole, number> = { owner: 3, admin: 2, member: 1 };

export function toGroup(doc: GroupDoc): Group {
  return {
    groupId: doc._id,
    createdBy: doc.createdBy,
    version: doc.version,
    createdAt: doc.createdAt.getTime(),
    members: doc.members.map((m) => ({
      userId: m.userId,
      role: m.role,
      addedAt: m.addedAt.getTime(),
    })),
  };
}

export class GroupService {
  readonly #groups: Collection<GroupDoc>;
  readonly #members = new Map<string, ReadonlySet<string>>();

  constructor(private readonly d: GroupServiceDeps) {
    this.#groups = d.db.collection<GroupDoc>('groups');
  }

  async create(callerId: string, groupId: string, memberUserIds: string[]): Promise<Group> {
    const others = [...new Set(memberUserIds)].filter((id) => id !== callerId);
    if (others.length === 0) {
      throw new AppError('VALIDATION_FAILED', { detail: 'A group needs another member.' });
    }
    if (others.length + 1 > this.d.maxMembers) throw new AppError('GROUP_FULL');
    await this.#requireUsers(others);
    const now = new Date(this.d.clock.now());
    const doc: GroupDoc = {
      _id: groupId,
      createdBy: callerId,
      members: [
        { userId: callerId, role: 'owner', addedAt: now, addedBy: callerId },
        ...others.map((userId) => ({
          userId,
          role: 'member' as const,
          addedAt: now,
          addedBy: callerId,
        })),
      ],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.#groups.insertOne(doc);
    } catch (error) {
      if ((error as { code?: number }).code === 11_000) throw new AppError('CONFLICT');
      throw error;
    }
    this.#changed(doc, []);
    return toGroup(doc);
  }

  async list(callerId: string): Promise<Group[]> {
    const docs = await this.#groups
      .find({ 'members.userId': callerId })
      .sort({ createdAt: 1 })
      .toArray();
    return docs.map(toGroup);
  }

  async get(callerId: string, groupId: string): Promise<Group> {
    const doc = await this.#load(groupId);
    if (!doc.members.some((m) => m.userId === callerId)) throw new AppError('NOT_A_MEMBER');
    return toGroup(doc);
  }

  addMembers(callerId: string, groupId: string, userIds: string[]): Promise<Group> {
    return this.#change(groupId, async (doc, now) => {
      requireRole(doc, callerId, 'admin');
      const present = new Set(doc.members.map((m) => m.userId));
      const added = [...new Set(userIds)].filter((id) => !present.has(id));
      if (added.length === 0) return undefined;
      if (doc.members.length + added.length > this.d.maxMembers) {
        throw new AppError('GROUP_FULL');
      }
      await this.#requireUsers(added);
      return [
        ...doc.members,
        ...added.map((userId) => ({
          userId,
          role: 'member' as const,
          addedAt: now,
          addedBy: callerId,
        })),
      ];
    });
  }

  removeMember(callerId: string, groupId: string, userId: string): Promise<Group> {
    return this.#change(groupId, (doc) => {
      const target = doc.members.find((m) => m.userId === userId);
      if (callerId !== userId) {
        const caller = requireRole(doc, callerId, 'admin');
        if (!target) return Promise.resolve(undefined);
        // Admins remove plain members; only the owner removes admins.
        if (RANK[target.role] >= RANK[caller.role]) throw new AppError('FORBIDDEN');
      } else if (!target) {
        throw new AppError('NOT_A_MEMBER');
      }
      const rest = doc.members.filter((m) => m.userId !== userId);
      if (target?.role === 'owner' && rest.length > 0) {
        // The owner left: the longest-standing admin, else member, takes over.
        const heir =
          rest.find((m) => m.role === 'admin') ??
          [...rest].sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime())[0]!;
        return Promise.resolve(
          rest.map((m) => (m === heir ? { ...m, role: 'owner' as const } : m)),
        );
      }
      return Promise.resolve(rest);
    });
  }

  setRole(
    callerId: string,
    groupId: string,
    userId: string,
    role: 'admin' | 'member',
  ): Promise<Group> {
    return this.#change(groupId, (doc) => {
      requireRole(doc, callerId, 'owner');
      const target = doc.members.find((m) => m.userId === userId);
      if (!target) throw new AppError('NOT_A_MEMBER');
      if (target.role === 'owner') throw new AppError('FORBIDDEN');
      if (target.role === role) return Promise.resolve(undefined);
      return Promise.resolve(doc.members.map((m) => (m === target ? { ...m, role } : m)));
    });
  }

  /** Whether `userId` is a current member (cached; dropped on every change). */
  async isMember(groupId: string, userId: string): Promise<boolean> {
    let members = this.#members.get(groupId);
    if (!members) {
      const doc = await this.#groups.findOne(
        { _id: groupId },
        { projection: { 'members.userId': 1 } },
      );
      members = new Set(doc?.members.map((m) => m.userId) ?? []);
      if (this.#members.size >= MAX_CACHED) this.#members.clear();
      this.#members.set(groupId, members);
    }
    return members.has(userId);
  }

  /**
   * Applies `change` to the current document; `undefined` means nothing changed. Retried when
   * another change won the race. An empty member list deletes the group.
   */
  async #change(
    groupId: string,
    change: (doc: GroupDoc, now: Date) => Promise<GroupMemberDoc[] | undefined>,
  ): Promise<Group> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const doc = await this.#load(groupId);
      const now = new Date(this.d.clock.now());
      const members = await change(doc, now);
      if (!members) return toGroup(doc);
      const next: GroupDoc = { ...doc, members, version: doc.version + 1, updatedAt: now };
      const result =
        members.length === 0
          ? await this.#groups.deleteOne({ _id: groupId, version: doc.version })
          : await this.#groups.replaceOne({ _id: groupId, version: doc.version }, next);
      const done = 'deletedCount' in result ? result.deletedCount : result.modifiedCount;
      if (done === 0) continue;
      this.#changed(
        next,
        doc.members.map((m) => m.userId),
      );
      return toGroup(next);
    }
    throw new AppError('CONFLICT');
  }

  async #load(groupId: string): Promise<GroupDoc> {
    const doc = await this.#groups.findOne({ _id: groupId });
    if (!doc) throw new AppError('NOT_FOUND');
    return doc;
  }

  async #requireUsers(userIds: string[]): Promise<void> {
    const found = await this.d.users.countDocuments({ _id: { $in: userIds } });
    if (found !== userIds.length) {
      throw new AppError('NOT_FOUND', { detail: 'A user to add does not exist.' });
    }
  }

  #changed(doc: GroupDoc, before: string[]): void {
    this.#members.delete(doc._id);
    const users = new Set([...before, ...doc.members.map((m) => m.userId)]);
    this.d.onChanged?.(doc._id, doc.version, [...users]);
  }
}

/** The caller's membership, if their role is at least `role`. */
function requireRole(doc: GroupDoc, userId: string, role: GroupRole): GroupMemberDoc {
  const member = doc.members.find((m) => m.userId === userId);
  if (!member) throw new AppError('NOT_A_MEMBER');
  if (RANK[member.role] < RANK[role]) throw new AppError('FORBIDDEN');
  return member;
}
