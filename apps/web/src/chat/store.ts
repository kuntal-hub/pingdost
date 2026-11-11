// Chat state the UI reads (ADR 0020): the client of this tab (the engine itself in the leader
// tab, a relay to it elsewhere), the connection, watched presence, and this account's privacy
// settings and blocks.
import { create } from 'zustand';

import type { CircleMember, CircleRequest, PrivacyPrefs } from '@pingdost/shared-types';
import type { TransportStatus } from '@pingdost/transport';

import type { ChatClient } from './client';

export type ChatRole = 'waiting' | 'starting' | 'leader' | 'follower';

export interface CircleLists {
  members: CircleMember[];
  incoming: CircleRequest[];
  outgoing: CircleRequest[];
}

/** How a person relates to this user's circle. */
export type CircleState = 'member' | 'requested' | 'incoming' | 'none';

/** Where `userId` stands; `undefined` until the lists were loaded. */
export function circleStateOf(circle: CircleLists | null, userId: string): CircleState | undefined {
  if (!circle) return undefined;
  if (circle.members.some((m) => m.userId === userId)) return 'member';
  if (circle.incoming.some((r) => r.userId === userId)) return 'incoming';
  if (circle.outgoing.some((r) => r.userId === userId)) return 'requested';
  return 'none';
}

interface ChatState {
  client: ChatClient | null;
  role: ChatRole;
  status: TransportStatus;
  presence: Record<string, boolean>;
  privacy: PrivacyPrefs | null;
  blocked: string[];
  /** The circle and its requests (Phase 37); null until loaded. */
  circle: CircleLists | null;
  /** Why the engine could not start in this tab. */
  error: string | undefined;
}

export const useChat = create<ChatState>()(() => ({
  client: null,
  role: 'waiting',
  status: 'connecting',
  presence: {},
  privacy: null,
  blocked: [],
  circle: null,
  error: undefined,
}));

export function useCircleState(userId: string | undefined): CircleState | undefined {
  return useChat((state) => (userId ? circleStateOf(state.circle, userId) : undefined));
}

export function useChatClient(): ChatClient | null {
  return useChat((state) => state.client);
}
