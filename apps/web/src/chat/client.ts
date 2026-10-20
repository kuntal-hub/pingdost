// What the web UI talks to (ADR 0020): one interface whether this tab runs the engine (the
// leader) or another tab does (a follower, over BroadcastChannel). The methods are the
// engine's own, so both sides behave the same.
import type { ConversationEvent, EngineEvent, MessageEngine } from '@pingdost/message-engine';

export const ENGINE_METHODS = [
  'listConversations',
  'getConversation',
  'getMessage',
  'listMessages',
  'messageInfo',
  'search',
  'getGroup',
  'contact',
  'openDirectConversation',
  'sendText',
  'retry',
  'markRead',
  'editMessage',
  'deleteForEveryone',
  'react',
  'deleteForMe',
  'deleteConversation',
  'setArchived',
  'setPinned',
  'setMuted',
  'createGroup',
  'addGroupMembers',
  'removeGroupMember',
  'leaveGroup',
  'setGroupRole',
  'updateGroupInfo',
  'refreshDevices',
  'markVerified',
  'setTyping',
  'attachmentRecipients',
  'sendAttachment',
  'releaseAttachment',
] as const satisfies readonly (keyof MessageEngine)[];

export type EngineMethod = (typeof ENGINE_METHODS)[number];

export type ChatApi = Pick<MessageEngine, EngineMethod> & {
  /** Only these users' presence is reported (the open chat's peer). */
  watchPresence(userIds: string[]): Promise<void>;
};

export interface ChatEvents {
  subscribe(conversationId: string, listener: (event: ConversationEvent) => void): () => void;
  onListChanged(listener: () => void): () => void;
  onEngineEvent(listener: (event: EngineEvent) => void): () => void;
}

export type ChatClient = ChatApi & ChatEvents;

/** An error as it crosses between tabs (structured clone keeps only plain data). */
export interface WireError {
  name: string;
  message: string;
  code?: string;
}

export function toWireError(error: unknown): WireError {
  if (error instanceof Error) {
    const { code } = error as { code?: unknown };
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
  return { name: 'Error', message: String(error) };
}

export class RemoteError extends Error {
  readonly code: string | undefined;

  constructor(wire: WireError) {
    super(wire.message);
    this.name = wire.name;
    this.code = wire.code;
  }
}
