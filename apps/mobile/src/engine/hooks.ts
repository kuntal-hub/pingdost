// React bindings for the chat engine: the chat list, a conversation's messages, typing and
// contacts. Chats and messages come from the in-memory chat store (`chat-store.ts`), which the
// app fills from the local database as it opens and the engine's events keep current, so no
// screen waits for the database (ADR 0047).
import { useCallback, useEffect, useState } from 'react';

import { useAccount } from '@/settings/account';
import type { ConversationRecord, MessageRecord } from '@pingdost/message-engine';

import {
  ensureThread,
  loadOlderMessages,
  releaseThread,
  useChatData,
  type ChatListEntry,
} from './chat-store';
import { loadContact, useContacts, type Contact } from './contacts';
import { useChatStore, type ChatRuntime } from './runtime';
import { EMPTY_THREAD } from './thread';

export type { ChatListEntry } from './chat-store';

/**
 * Dev builds only: how long a chat takes from the tap to messages on screen, in Metro's log
 * (`[chat-open] …`). Release builds skip it.
 */
export const openTiming = {
  pressedAt: new Map<string, number>(),
  press(conversationId: string): void {
    if (__DEV__) this.pressedAt.set(conversationId, performance.now());
  },
  mark(conversationId: string, step: string, detail = ''): void {
    if (!__DEV__) return;
    const at = this.pressedAt.get(conversationId);
    if (at === undefined) return;
    if (__DEV__)
      console.log(`[chat-open] ${step} +${Math.round(performance.now() - at)} ms ${detail}`);
  },
  done(conversationId: string): void {
    this.pressedAt.delete(conversationId);
  },
};

export function useChatRuntime(): ChatRuntime | null {
  return useChatStore((state) => state.runtime);
}

export function useConnectionStatus() {
  return useChatStore((state) => state.status);
}

/** All conversations, most recent first, with their last message (decrypted locally). */
export function useConversations(): { entries: readonly ChatListEntry[]; loading: boolean } {
  const runtime = useChatRuntime();
  const entries = useChatData((state) => state.entries);
  const listed = useChatData((state) => state.listed);
  return { entries, loading: !listed || !runtime };
}

/** One conversation's record: from memory, or read once if the list does not have it yet. */
export function useConversationRecord(conversationId: string): ConversationRecord | undefined {
  const runtime = useChatRuntime();
  const listed = useChatData((state) => state.conversations[conversationId]);
  const [read, setRead] = useState<ConversationRecord>();
  useEffect(() => {
    if (listed || !runtime) return;
    let live = true;
    void runtime.engine.getConversation(conversationId).then((record) => {
      if (live) setRead(record);
    });
    return () => {
      live = false;
    };
  }, [listed, runtime, conversationId]);
  return listed ?? read;
}

export interface ConversationView {
  /** Newest first. */
  messages: readonly MessageRecord[];
  /** The loaded messages by ID (quotes resolve here first). */
  loaded: ReadonlyMap<string, MessageRecord>;
  /** Loads the next older page; false when there is none. */
  loadOlder: () => Promise<boolean>;
  /** Loads older pages until `messageId` is loaded (e.g. a search result); false if never. */
  loadUntil: (messageId: string) => Promise<boolean>;
  /** The peer is typing (only when typing indicators are on). */
  typing: boolean;
  /** The store was read: an empty chat really is empty. */
  ready: boolean;
}

/**
 * One conversation's messages, from memory: on the first render they are already there. A chat
 * the app has not read yet (it was just tapped while the app opened) arrives a moment later.
 */
export function useConversation(conversationId: string): ConversationView {
  const runtime = useChatRuntime();
  const thread = useChatData((state) => state.threads[conversationId]) ?? EMPTY_THREAD;
  const typing = useChatData((state) => state.typing[conversationId] ?? false);

  useEffect(() => {
    if (!runtime) return;
    void ensureThread(runtime, conversationId);
    // Leaving the chat: older pages read while scrolling up are let go.
    return () => releaseThread(conversationId);
  }, [runtime, conversationId]);

  const loadOlder = useCallback(
    () => (runtime ? loadOlderMessages(runtime, conversationId) : Promise.resolve(false)),
    [runtime, conversationId],
  );
  const loadUntil = useCallback(
    async (messageId: string) => {
      const has = () => !!useChatData.getState().threads[conversationId]?.byId.has(messageId);
      for (let page = 0; page < 40; page++) {
        if (has()) return true;
        if (!(await loadOlder())) break;
        // Let the merged page render before looking again.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return has();
    },
    [conversationId, loadOlder],
  );

  return {
    messages: thread.messages,
    loaded: thread.byId,
    loadOlder,
    loadUntil,
    typing,
    ready: thread.complete,
  };
}

/**
 * The message a reply quotes, if this device has it in the same conversation: from the loaded
 * page, else from the store. Undefined means "Original message not available".
 */
export function useQuoted(
  replyTo: string | null,
  conversationId: string,
  loaded: ReadonlyMap<string, MessageRecord>,
): MessageRecord | undefined {
  const runtime = useChatRuntime();
  const [fetched, setFetched] = useState<MessageRecord>();
  const local = replyTo ? loaded.get(replyTo) : undefined;
  useEffect(() => {
    if (!replyTo || local || !runtime) return;
    let live = true;
    void runtime.engine.getMessage(replyTo).then((message) => {
      if (live) setFetched(message);
    });
    return () => {
      live = false;
    };
  }, [replyTo, local, runtime]);
  const quoted = local ?? fetched;
  return quoted?.conversationId === conversationId ? quoted : undefined;
}

const jumps = new Map<string, string>();

/** Asks the conversation's (already open) chat screen to scroll to a message when focused. */
export function requestJump(conversationId: string, messageId: string): void {
  jumps.set(conversationId, messageId);
}

/** The message to scroll to, once. */
export function takeJump(conversationId: string): string | undefined {
  const messageId = jumps.get(conversationId);
  jumps.delete(conversationId);
  return messageId;
}

/** Whether this user shares read receipts; when off, others' are not shown either. */
export function useReadReceipts(): boolean {
  return useAccount((state) => state.privacy?.readReceipts ?? false);
}

/** A contact's cached profile, refreshed in the background. */
export function useContact(userId: string | undefined): Contact | undefined {
  const contact = useContacts((state) => (userId ? state.byId[userId] : undefined));
  useEffect(() => {
    if (userId) void loadContact(userId);
  }, [userId]);
  return contact;
}

/** Whether a watched user is online (only while their chat is open and both share it). */
export function usePresence(userId: string | undefined): boolean {
  return useChatStore((state) => (userId ? (state.presence[userId] ?? false) : false));
}
