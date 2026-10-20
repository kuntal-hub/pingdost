// Chat state the UI reads (ADR 0020): the client of this tab (the engine itself in the leader
// tab, a relay to it elsewhere), the connection, watched presence, and this account's privacy
// settings and blocks.
import { create } from 'zustand';

import type { PrivacyPrefs } from '@pingdost/shared-types';
import type { TransportStatus } from '@pingdost/transport';

import type { ChatClient } from './client';

export type ChatRole = 'waiting' | 'starting' | 'leader' | 'follower';

interface ChatState {
  client: ChatClient | null;
  role: ChatRole;
  status: TransportStatus;
  presence: Record<string, boolean>;
  privacy: PrivacyPrefs | null;
  blocked: string[];
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
  error: undefined,
}));

export function useChatClient(): ChatClient | null {
  return useChat((state) => state.client);
}
