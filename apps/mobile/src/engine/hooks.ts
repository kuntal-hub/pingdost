// React bindings for the chat engine: the chat list, a conversation's timeline, typing and
// contacts. Everything reads from the local store; the engine's events keep it current.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  /** Loads the next older page; false when there is none. */
  loadOlder: () => Promise<boolean>;
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
      else setTyping(event.active);
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

  const loadOlder = useCallback(async () => {
    if (!runtime || exhausted.current || loadingOlder.current) return false;
    const oldest = [...messages.values()].reduce<MessageRecord | undefined>(
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
        return next;
      });
      return page.length > 0;
    } finally {
      loadingOlder.current = false;
    }
  }, [runtime, conversationId, messages]);

  const items = useMemo(() => buildTimeline([...messages.values()]), [messages]);
  return { items, loadOlder, typing };
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
