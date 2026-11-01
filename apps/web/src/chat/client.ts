// What the web UI talks to (ADR 0020): one interface whether this tab runs the engine (the
// leader) or another tab does (a follower, over BroadcastChannel). The methods are the
// engine's own, so both sides behave the same, plus the leader's attachment transfers
// (ADR 0021), which run next to the engine.
import type { SendFileOptions, TransferStatus } from '@/attachments/transfers';
import type {
  ConversationEvent,
  EngineEvent,
  HistorySyncStatus,
  MessageEngine,
} from '@pingdost/message-engine';
import type { IncomingCallSignal } from '@pingdost/protocol';

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
  'historySyncStatus',
  'syncHistory',
  'pauseHistorySync',
  'resumeHistorySync',
  'loadOlderFromPhone',
  'callDevices',
  'sendCallSignal',
  'callHistory',
  'recordCall',
  'clearCallHistory',
] as const satisfies readonly (keyof MessageEngine)[];

export type EngineMethod = (typeof ENGINE_METHODS)[number];

/** The leader tab's own calls, besides the engine's. */
export interface LeaderApi {
  /** Only these users' presence is reported (the open chat's peer). */
  watchPresence(userIds: string[]): Promise<void>;
  /** Fetches a message's file (or preview) into this browser's cache. */
  downloadAttachment(messageId: string, role?: 'file' | 'thumbnail'): Promise<void>;
  /** Compresses (images), encrypts and sends a file; throws `SendFileError` with the reason. */
  sendFile(conversationId: string, file: File, options: SendFileOptions): Promise<void>;
  retryUpload(messageId: string): Promise<void>;
  transfers(): Promise<TransferStatus[]>;
  /** Trims the cache to its limit (after the limit changed); returns the bytes freed. */
  applyCacheLimit(): Promise<number>;
  clearCache(): Promise<number>;
}

export const LEADER_METHODS = [
  'watchPresence',
  'downloadAttachment',
  'sendFile',
  'retryUpload',
  'transfers',
  'applyCacheLimit',
  'clearCache',
] as const satisfies readonly (keyof LeaderApi)[];

export type ClientMethod = EngineMethod | (typeof LEADER_METHODS)[number];

export type ChatApi = Pick<MessageEngine, EngineMethod> & LeaderApi;

export interface ChatEvents {
  subscribe(conversationId: string, listener: (event: ConversationEvent) => void): () => void;
  onListChanged(listener: () => void): () => void;
  onEngineEvent(listener: (event: EngineEvent) => void): () => void;
  onHistorySync(listener: (status: HistorySyncStatus) => void): () => void;
  onTransfer(listener: (status: TransferStatus) => void): () => void;
  /** E2EE call signals for this device (ADR 0028), in every tab. */
  onCallSignal(listener: (signal: IncomingCallSignal) => void): () => void;
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
