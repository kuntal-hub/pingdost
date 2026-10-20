import { describe, expect, it } from 'vitest';

import { applyControl, newGroup, reconcile, type ControlInput } from './state';
import type { GroupMemberRecord, GroupRecord } from '../store';

const OWNER = 'owner-user';
const ADMIN = 'admin-user';
const BOB = 'bob-user';
const CAROL = 'carol-user';
const ME = BOB;

const base: GroupMemberRecord[] = [
  { userId: OWNER, role: 'owner' },
  { userId: ADMIN, role: 'admin' },
  { userId: BOB, role: 'member' },
];

function control(over: Partial<ControlInput>): ControlInput {
  return {
    action: 'add',
    groupId: 'g',
    senderUserId: OWNER,
    users: [],
    version: 2,
    members: base,
    name: '',
    description: '',
    avatar: null,
    sentAt: 1_000,
    messageId: 'm1',
    ...over,
  };
}

function group(over: Partial<GroupRecord> = {}): GroupRecord {
  return { ...newGroup('g', base, 1, 0), ...over };
}

describe('applyControl', () => {
  it('creates a group from its owner, with the info', () => {
    const result = applyControl(
      undefined,
      control({ action: 'create', version: 1, name: 'Trip', senderUserId: OWNER }),
      ME,
      5,
    );
    expect(result).toMatchObject({
      applied: true,
      group: { members: base, version: 1, name: 'Trip', left: false },
      notice: { type: 'created', by: OWNER },
    });
    // Not from the owner it lists, or not listing this user: ignored.
    expect(
      applyControl(undefined, control({ action: 'create', senderUserId: ADMIN }), ME, 5),
    ).toEqual({
      applied: false,
      reason: 'not_allowed',
    });
    expect(
      applyControl(undefined, control({ action: 'create', version: 1 }), 'stranger', 5),
    ).toEqual({ applied: false, reason: 'not_member' });
  });

  it('lets admins add and remove members, never plain members', () => {
    const withCarol = [...base, { userId: CAROL, role: 'member' as const }];
    const added = applyControl(
      group(),
      control({ action: 'add', senderUserId: ADMIN, users: [CAROL], members: withCarol }),
      ME,
      5,
    );
    expect(added).toMatchObject({ applied: true, membersChanged: true, group: { version: 2 } });
    expect(
      applyControl(
        group(),
        control({ action: 'add', senderUserId: BOB, members: withCarol }),
        ME,
        5,
      ),
    ).toEqual({ applied: false, reason: 'not_allowed' });
    // An admin cannot remove another admin; the owner can.
    const withoutAdmin = base.filter((m) => m.userId !== ADMIN);
    const byAdmin = control({
      action: 'remove',
      senderUserId: ADMIN,
      users: [ADMIN],
      members: withoutAdmin,
    });
    expect(applyControl(group(), { ...byAdmin, users: [OWNER] }, ME, 5)).toMatchObject({
      applied: false,
    });
    expect(
      applyControl(group(), { ...byAdmin, senderUserId: OWNER, users: [ADMIN] }, ME, 5),
    ).toMatchObject({ applied: true, notice: { type: 'removed', users: [ADMIN] } });
  });

  it('marks the group left when this user is removed', () => {
    const result = applyControl(
      group(),
      control({
        action: 'remove',
        users: [BOB],
        members: base.filter((m) => m.userId !== BOB),
      }),
      ME,
      5,
    );
    expect(result).toMatchObject({ applied: true, group: { left: true } });
  });

  it('keeps the newest membership and lets a late ADD in only if the server lists the user', () => {
    const current = group({
      version: 5,
      serverVersion: 5,
      serverMembers: [...base, { userId: CAROL, role: 'member' }],
    });
    const lateAdd = control({ action: 'add', version: 4, users: [CAROL] });
    expect(applyControl(current, lateAdd, ME, 5)).toMatchObject({
      applied: true,
      membersChanged: true,
      notice: { type: 'added', users: [CAROL] },
    });
    const notListed = group({ version: 5, serverVersion: 5, serverMembers: base });
    expect(applyControl(notListed, lateAdd, ME, 5)).toMatchObject({
      applied: true,
      membersChanged: false,
    });
    // A late REMOVE changes nothing but still tells what happened.
    expect(
      applyControl(current, control({ action: 'remove', version: 4, users: [CAROL] }), ME, 5),
    ).toMatchObject({ applied: true, membersChanged: false, notice: { type: 'removed' } });
  });

  it('never lets a newer control re-add someone the server already removed', () => {
    const current = group({ version: 3, serverVersion: 6, serverMembers: base });
    const result = applyControl(
      current,
      control({
        action: 'add',
        senderUserId: ADMIN,
        version: 4,
        users: [CAROL],
        members: [...base, { userId: CAROL, role: 'member' }],
      }),
      ME,
      5,
    );
    expect(result).toMatchObject({ applied: true, group: { members: base } });
  });

  it('applies info last-write-wins, from admins only', () => {
    const named = applyControl(
      group(),
      control({ action: 'update_info', senderUserId: ADMIN, name: 'New', sentAt: 2_000 }),
      ME,
      5,
    );
    expect(named).toMatchObject({ applied: true, group: { name: 'New', infoAt: 2_000 } });
    const older = control({
      action: 'update_info',
      senderUserId: OWNER,
      name: 'Old',
      sentAt: 1_500,
    });
    expect(applyControl(named.applied ? named.group : group(), older, ME, 5)).toEqual({
      applied: false,
      reason: 'stale',
    });
    expect(
      applyControl(group(), control({ action: 'update_info', senderUserId: BOB }), ME, 5),
    ).toEqual({ applied: false, reason: 'not_allowed' });
  });

  it('lets anyone leave, but only themselves', () => {
    const rest = base.filter((m) => m.userId !== ADMIN);
    expect(
      applyControl(
        group(),
        control({ action: 'leave', senderUserId: ADMIN, users: [ADMIN], members: rest }),
        ME,
        5,
      ),
    ).toMatchObject({ applied: true, notice: { type: 'left', users: [ADMIN] } });
    expect(
      applyControl(
        group(),
        control({ action: 'leave', senderUserId: ADMIN, users: [OWNER], members: rest }),
        ME,
        5,
      ),
    ).toEqual({ applied: false, reason: 'not_allowed' });
  });
});

describe('reconcile', () => {
  it('only removes members and lowers roles', () => {
    const current = group();
    const server = {
      version: 4,
      members: [
        { userId: OWNER, role: 'owner' as const },
        { userId: ADMIN, role: 'member' as const },
        { userId: BOB, role: 'member' as const },
        { userId: CAROL, role: 'admin' as const },
      ],
    };
    const { group: next } = reconcile(current, server, ME, 5);
    expect(next.members).toEqual([
      { userId: OWNER, role: 'owner' },
      { userId: ADMIN, role: 'member' },
      { userId: BOB, role: 'member' },
    ]);
    expect(next).toMatchObject({ version: 4, serverVersion: 4 });

    const removed = reconcile(current, { version: 2, members: base.slice(0, 2) }, ME, 5);
    expect(removed).toMatchObject({ group: { left: true }, notice: { type: 'not_member' } });
    expect(reconcile(current, 'not_member', ME, 5)).toMatchObject({ group: { left: true } });
  });
});
