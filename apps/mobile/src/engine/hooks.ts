// React bindings for the chat engine: the chat list, a conversation's timeline, typing and
// contacts. Everything reads from the local store; the engine's events keep it current.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAccount } from '@/settings/account';
import type { ConversationRecord, MessageRecord } from '@pingdost/message-engine';

import { loadContact, useContacts, type Contact } from './contacts';
import { useChatStore, type ChatRuntime } from './runtime';
import { buildTimeline, type TimelineItem } from './timeline';

const PAGE = 50;

export function useChatRuntime(): ChatRuntime | null {
  return useChatStore((state) => state.runtime);
}

export function useConnectionStatus() {
  return useChatStore((state) => state.status);
}

export interface ChatListEntry {
  conversation: ConversationRecord;
  last: MessageRecord | undefined;
}

/** All conversations, most recent first, with their last message (decrypted locally). */
export function useConversations(): { entries: ChatListEntry[]; loading: boolean } {
  const runtime = useChatRuntime();
  const [entries, setEntries] = useState<ChatListEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!runtime) return;
    let live = true;
    const load = async () => {
      const conversations = await runtime.engine.listConversations();
      const next = await Promise.all(
        conversations.map(async (conversation) => ({
          conversation,
          last: conversation.lastMessageId
            ? await runtime.engine.getMessage(conversation.lastMessageId)
            : undefined,
        })),
      );
      if (!live) return;
      setEntries(next);
      setLoading(false);
    };
    void load();
    const unsubscribe = runtime.engine.onConversationListChanged(() => void load());
    return () => {
      live = false;
      unsubscribe();
    };
  }, [runtime]);

  return { entries, loading: loading || !runtime };
}

export interface ConversationView {
  items: TimelineItem[];
  /** The loaded messages by ID (quotes resolve here first). */
  loaded: ReadonlyMap<string, MessageRecord>;
  /** Loads the next older page; false when there is none. */
  loadOlder: () => Promise<boolean>;
  /** Loads older pages until `messageId` is loaded (e.g. a search result); false if never. */
  loadUntil: (messageId: string) => Promise<boolean>;
  /** The peer is typing (only when typing indicators are on). */
  typing: boolean;
}

/** One conversation's timeline, newest page first, kept live by the engine's events. */
export function useConversation(conversationId: string): ConversationView {
  const runtime = useChatRuntime();
  const [messages, setMessages] = useState<Map<string, MessageRecord>>(new Map());
  const [typing, setTyping] = useState(false);
  const exhausted = useRef(false);
  const loadingOlder = useRef(false);

  useEffect(() => {
    if (!runtime) return;
    let live = true;
    exhausted.current = false;
    const merge = (records: MessageRecord[]) =>
      setMessages((current) => {
        const next = new Map(current);
        for (const record of records) next.set(record.messageId, record);
        return next;
      });
    const unsubscribe = runtime.engine.subscribe(conversationId, (event) => {
      if (!live) return;
      if (event.type === 'message') merge([event.message]);
      else if (event.type === 'removed') {
        setMessages((current) => {
          const next = new Map(current);
          for (const id of event.messageIds) next.delete(id);
          return next;
        });
      } else setTyping(event.active);
    });
    void runtime.engine.listMessages(conversationId, { limit: PAGE }).then((page) => {
      if (!live) return;
      if (page.length < PAGE) exhausted.current = true;
      merge(page);
    });
    return () => {
      live = false;
      unsubscribe();
      setMessages(new Map());
      setTyping(false);
    };
  }, [runtime, conversationId]);

  // The newest map, for callbacks that run across renders (paging, jump to a message).
  const latest = useRef(messages);
  latest.current = messages;

  const loadOlder = useCallback(async () => {
    if (!runtime || exhausted.current || loadingOlder.current) return false;
    const oldest = [...latest.current.values()].reduce<MessageRecord | undefined>(
      (min, m) =>
        !min || m.sortAt < min.sortAt || (m.sortAt === min.sortAt && m.messageId < min.messageId)
          ? m
          : min,
      undefined,
    );
    if (!oldest) return false;
    loadingOlder.current = true;
    try {
      const page = await runtime.engine.listMessages(conversationId, {
        limit: PAGE,
        before: { sortAt: oldest.sortAt, messageId: oldest.messageId },
      });
      if (page.length < PAGE) exhausted.current = true;
      setMessages((current) => {
        const next = new Map(current);
        for (const record of page) next.set(record.messageId, record);
        latest.current = next;
        return next;
      });
      return page.length > 0;
    } finally {
      loadingOlder.current = false;
    }
  }, [runtime, conversationId]);
  const loadUntil = useCallback(
    async (messageId: string) => {
      for (let page = 0; page < 40; page++) {
        if (latest.current.has(messageId)) return true;
        if (!(await loadOlder())) break;
        // Let the merged page render before looking again.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return latest.current.has(messageId);
    },
    [loadOlder],
  );

  const items = useMemo(() => buildTimeline([...messages.values()]), [messages]);
  return { items, loaded: messages, loadOlder, loadUntil, typing };
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
