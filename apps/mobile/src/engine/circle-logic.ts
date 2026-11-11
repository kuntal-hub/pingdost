// Pure helpers for the circle (Phase 37): where someone stands, what a refresh brought, names.
import type { CircleMember, CirclePerson, CircleRequest } from '@pingdost/shared-types';

/** How a person relates to this user's circle. */
export type CircleState = 'member' | 'requested' | 'incoming' | 'none';

export interface CircleLists {
  members: readonly CircleMember[];
  incoming: readonly CircleRequest[];
  outgoing: readonly CircleRequest[];
}

/** Where `userId` stands; `undefined` until the lists were loaded once. */
export function circleStateOf(
  state: CircleLists & { loaded: boolean },
  userId: string,
): CircleState | undefined {
  if (!state.loaded) return undefined;
  if (state.members.some((m) => m.userId === userId)) return 'member';
  if (state.incoming.some((r) => r.userId === userId)) return 'incoming';
  if (state.outgoing.some((r) => r.userId === userId)) return 'requested';
  return 'none';
}

/** What is new between two snapshots: requests that arrived, and people who accepted. */
export function circleChanges(
  before: CircleLists,
  after: CircleLists,
): { requests: CircleRequest[]; accepted: CircleMember[] } {
  const known = new Set(before.incoming.map((r) => r.userId));
  const asked = new Set(before.outgoing.map((r) => r.userId));
  const members = new Set(before.members.map((m) => m.userId));
  return {
    requests: after.incoming.filter((r) => !known.has(r.userId)),
    accepted: after.members.filter((m) => !members.has(m.userId) && asked.has(m.userId)),
  };
}

/** The display name, else the @username. */
export function personName(person: Pick<CirclePerson, 'displayName' | 'username'>): string {
  return person.displayName ?? (person.username ? `@${person.username}` : 'Someone');
}
