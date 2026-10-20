// React bindings for chat on the web, the same shape as the phone's (`apps/mobile/src/engine`):
// the chat list, a conversation's timeline (paged, kept live by events), groups, presence, names
// and safety numbers. Everything reads through this tab's chat client.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useSession } from '@/session/session';
import { buildTimeline, type Names, type TimelineItem } from '@pingdost/chat-core';
import type { ConversationRecord, GroupRecord, MessageRecord } from '@pingdost/message-engine';
import {
  safetyFingerprintAsync,
  safetyNumber,
  type SafetyNumber,
} from '@pingdost/protocol/safety-number';

import { contactName, loadContact, useContacts } from './contacts';
import { useChat, useChatClient } from './store';

const PAGE = 50;

export interface ChatListEntry {
  conversation: ConversationRecord;
  last: MessageRecord | undefined;
  group: GroupRecord | undefined;
}

export function useConversations(): { entries: ChatListEntry[]; loading: boolean } {
  const client = useChatClient();
  const [entries, setEntries] = useState<ChatListEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!client) return;
    let live = true;
    const load = async () => {
      try {
        const conversations = await client.listConversations();
        const next = await Promise.all(
          conversations.map(async (conversation) => ({
            conversation,
            last: conversation.lastMessageId
              ? await client.getMessage(conversation.lastMessageId)
              : undefined,
            group:
              conversation.kind === 'group'
                ? await client.getGroup(conversation.conversationId)
                : undefined,
          })),
        );
        if (!live) return;
        setEntries(next);
        setLoading(false);
      } catch {
        // The leader is changing: the next list event loads again.
      }
    };
    void load();
    const unsubscribe = client.onListChanged(() => void load());
    return () => {
      live = false;
      unsubscribe();
    };
  }, [client]);

  return { entries, loading };
}

export interface ConversationView {
  items: TimelineItem[];
  loaded: ReadonlyMap<string, MessageRecord>;
  loadOlder: () => Promise<boolean>;
  loadUntil: (messageId: string) => Promise<boolean>;
  typing: boolean;
  /** No older page. */
  complete: boolean;
}

export function useConversation(conversationId: string): ConversationView {
  const client = useChatClient();
  const [messages, setMessages] = useState<Map<string, MessageRecord>>(new Map());
  const [typing, setTyping] = useState(false);
  const [complete, setComplete] = useState(false);
  const loadingOlder = useRef(false);

  useEffect(() => {
    if (!client) return;
    let live = true;
    setComplete(false);
    const merge = (records: MessageRecord[]) =>
      setMessages((current) => {
        const next = new Map(current);
        for (const record of records) next.set(record.messageId, record);
        return next;
      });
    const unsubscribe = client.subscribe(conversationId, (event) => {
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
    void client
      .listMessages(conversationId, { limit: PAGE })
      .then((page) => {
        if (!live) return;
        if (page.length < PAGE) setComplete(true);
        merge(page);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      unsubscribe();
      setMessages(new Map());
      setTyping(false);
    };
  }, [client, conversationId]);

  const latest = useRef(messages);
  latest.current = messages;

  const loadOlder = useCallback(async () => {
    if (!client || complete || loadingOlder.current) return false;
    const oldest = [...latest.current.values()].sort(
      (a, b) => a.sortAt - b.sortAt || (a.messageId < b.messageId ? -1 : 1),
    )[0];
    if (!oldest) return false;
    loadingOlder.current = true;
    try {
      const page = await client.listMessages(conversationId, {
        before: { sortAt: oldest.sortAt, messageId: oldest.messageId },
        limit: PAGE,
      });
      if (page.length < PAGE) setComplete(true);
      setMessages((current) => {
        const next = new Map(current);
        for (const record of page) next.set(record.messageId, record);
        return next;
      });
      return page.length > 0;
    } finally {
      loadingOlder.current = false;
    }
  }, [client, conversationId, complete]);

  const loadUntil = useCallback(
    async (messageId: string) => {
      for (let i = 0; i < 40; i++) {
        if (latest.current.has(messageId)) return true;
        if (!(await loadOlder())) return latest.current.has(messageId);
      }
      return false;
    },
    [loadOlder],
  );

  const items = useMemo(() => buildTimeline([...messages.values()]), [messages]);
  return { items, loaded: messages, loadOlder, loadUntil, typing, complete };
}

/** A message by ID: from the loaded page first, else from the store. */
export function useQuoted(
  messageId: string | null,
  loaded: ReadonlyMap<string, MessageRecord>,
): MessageRecord | undefined {
  const client = useChatClient();
  const [fetched, setFetched] = useState<MessageRecord>();
  const inPage = messageId ? loaded.get(messageId) : undefined;
  useEffect(() => {
    if (!client || !messageId || inPage) return;
    void client.getMessage(messageId).then(setFetched, () => undefined);
  }, [client, messageId, inPage]);
  return inPage ?? fetched;
}

export function useGroup(groupId: string | undefined): GroupRecord | undefined {
  const client = useChatClient();
  const [group, setGroup] = useState<GroupRecord>();
  useEffect(() => {
    if (!client || !groupId) return;
    let live = true;
    const load = () =>
      void client.getGroup(groupId).then(
        (next) => live && setGroup(next),
        () => undefined,
      );
    load();
    const unsubscribe = client.onListChanged(load);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [client, groupId]);
  return group;
}

export function usePresence(userId: string | undefined): boolean {
  return useChat((state) => (userId ? (state.presence[userId] ?? false) : false));
}

/** Names for notices and sender labels: contacts' names, and who "you" are. */
export function useNames(): Names {
  const self = useSession((state) => state.device?.userId ?? '');
  const byId = useContacts((state) => state.byId);
  return useMemo(
    () => ({
      selfUserId: self,
      name: (userId: string) => {
        const contact = byId[userId];
        if (!contact) void loadContact(userId);
        return contactName(contact);
      },
    }),
    [self, byId],
  );
}

const safetyCache = new Map<string, SafetyNumber>();
const sha512 = async (data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-512', new Uint8Array(data)));

export interface SafetyState {
  number: SafetyNumber | undefined;
  identityKey: string | undefined;
  verified: boolean;
  problem: 'loading' | 'no_own_key' | 'no_contact_key' | undefined;
}

/** The safety number with a contact (ADR 0012), from both account identity keys. */
export function useSafetyNumber(userId: string): SafetyState {
  const client = useChatClient();
  const device = useSession((state) => state.device);
  const [state, setState] = useState<SafetyState>({
    number: undefined,
    identityKey: undefined,
    verified: false,
    problem: 'loading',
  });

  useEffect(() => {
    if (!client || !device) return;
    let live = true;
    void (async () => {
      const own = device.accountIdentityKey;
      if (!own) return setState((s) => ({ ...s, problem: 'no_own_key' }));
      const info = await client.refreshDevices(userId).then(
        () => client.contact(userId),
        () => client.contact(userId),
      );
      const theirs = info.directory?.accountIdentityKey;
      if (!theirs) return live && setState((s) => ({ ...s, problem: 'no_contact_key' }));
      const key = `${own}|${theirs}|${userId}`;
      let number = safetyCache.get(key);
      if (!number) {
        const [local, remote] = await Promise.all([
          safetyFingerprintAsync({ userId: device.userId, accountIdentityKey: own }, sha512),
          safetyFingerprintAsync({ userId, accountIdentityKey: theirs }, sha512),
        ]);
        number = safetyNumber(local, remote);
        safetyCache.set(key, number);
      }
      if (live)
        setState({ number, identityKey: theirs, verified: info.verified, problem: undefined });
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, device, userId]);

  return state;
}
