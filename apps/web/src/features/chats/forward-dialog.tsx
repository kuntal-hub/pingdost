// Forward to (Phase 39, ADR 0043), like the phone's: up to five chats at once, recent chats
// first, then circle members without a chat; search by name. Text goes as it is; a file goes
// from this browser's cache as a new attachment, and files not cached here are skipped.
import { Send, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { ChatClient } from '@/chat/client';
import { contactName, loadContact, useContacts } from '@/chat/contacts';
import { useChat, useChatClient } from '@/chat/store';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/menu';
import { cn } from '@/lib/cn';
import {
  forwardNotice,
  forwardTargets,
  MAX_FORWARD_TARGETS,
  pickTarget,
  type ForwardTarget,
} from '@pingdost/chat-core';
import type { ConversationRecord, GroupRecord, MessageRecord } from '@pingdost/message-engine';

import { groupPictureUri } from './format';

interface Shown extends ForwardTarget {
  avatarUrl: string | null | undefined;
}

async function forwardAll(
  client: ChatClient,
  messages: readonly MessageRecord[],
  targets: readonly ForwardTarget[],
  selfUserId: string,
): Promise<{ sent: number; missing: number; failed: number }> {
  const conversationIds: string[] = [];
  for (const target of targets) {
    if (target.conversationId) conversationIds.push(target.conversationId);
    else if (target.userId) {
      conversationIds.push((await client.openDirectConversation(target.userId)).conversationId);
    }
  }
  const result = { sent: 0, missing: 0, failed: 0 };
  for (const message of messages) {
    try {
      if (message.kind === 'text') {
        await client.forwardText(message.messageId, conversationIds);
      } else if (
        !(await client.forwardFile(
          message.messageId,
          conversationIds,
          message.senderUserId !== selfUserId,
        ))
      ) {
        result.missing++;
        continue;
      }
      result.sent++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

export function ForwardDialog({
  messages,
  selfUserId,
  onClose,
}: {
  /** The messages to forward (oldest first); the dialog is open while there are any. */
  messages: MessageRecord[];
  selfUserId: string;
  onClose: (notice?: string) => void;
}) {
  const client = useChatClient();
  const contacts = useContacts((state) => state.byId);
  const circle = useChat((state) => state.circle);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [groups, setGroups] = useState<Record<string, GroupRecord>>({});
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const open = messages.length > 0;

  useEffect(() => {
    if (!client || !open) return;
    let live = true;
    void (async () => {
      const list = await client.listConversations();
      const found = await Promise.all(
        list.filter((c) => c.kind === 'group').map((c) => client.getGroup(c.conversationId)),
      );
      if (!live) return;
      setConversations(list);
      setGroups(Object.fromEntries(found.flatMap((g) => (g ? [[g.groupId, g]] : []))));
      for (const c of list) if (c.kind === 'direct') void loadContact(c.peerUserId);
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, open]);

  useEffect(() => {
    if (open) return;
    setQuery('');
    setPicked([]);
    setError(undefined);
    setBusy(false);
  }, [open]);

  const all = useMemo(() => {
    const members = circle ? new Set(circle.members.map((m) => m.userId)) : undefined;
    const chats: Shown[] = [];
    for (const conversation of conversations) {
      if (conversation.kind === 'group') {
        const group = groups[conversation.conversationId];
        if (!group || group.left) continue;
        chats.push({
          key: conversation.conversationId,
          kind: 'group',
          conversationId: conversation.conversationId,
          userId: null,
          name: group.name || 'Group',
          username: null,
          updatedAt: conversation.updatedAt,
          avatarUrl: groupPictureUri(group.avatar),
        });
      } else if (!members || members.has(conversation.peerUserId)) {
        // One to one only within the circle (Phase 37).
        const contact = contacts[conversation.peerUserId];
        chats.push({
          key: conversation.conversationId,
          kind: 'direct',
          conversationId: conversation.conversationId,
          userId: conversation.peerUserId,
          name: contactName(contact),
          username: contact?.username ?? null,
          updatedAt: conversation.updatedAt,
          avatarUrl: contact?.avatarUrl,
        });
      }
    }
    const people: Shown[] = (circle?.members ?? []).map((person) => ({
      key: `user:${person.userId}`,
      kind: 'direct',
      conversationId: null,
      userId: person.userId,
      name: person.displayName || (person.username ? `@${person.username}` : 'PingDost user'),
      username: person.username,
      updatedAt: 0,
      avatarUrl: person.avatarUrl,
    }));
    return { chats, people };
  }, [conversations, groups, contacts, circle]);

  const shown = forwardTargets(all.chats, all.people, query) as Shown[];
  const byKey = new Map([...all.chats, ...all.people].map((t) => [t.key, t]));
  const targets = picked.map((key) => byKey.get(key)).filter((t) => t !== undefined);
  const files = messages.filter((m) => m.kind === 'attachment').length;

  function toggle(key: string) {
    const next = pickTarget(picked, key);
    if (next === false) {
      setError(`You can forward to up to ${MAX_FORWARD_TARGETS} chats at once.`);
      return;
    }
    setError(undefined);
    setPicked(next);
  }

  async function send() {
    if (!client || targets.length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await forwardAll(client, messages, targets, selfUserId);
      if (result.sent === 0) {
        setError(forwardNotice(result));
        setBusy(false);
        return;
      }
      onClose(forwardNotice(result));
    } catch {
      setError('The messages could not be forwarded. Try again.');
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && !busy && onClose()}
      title="Forward to"
      description={`${messages.length === 1 ? '1 message' : `${messages.length} messages`}${
        files > 0 ? ` (${files === 1 ? '1 file' : `${files} files`})` : ''
      } · up to ${MAX_FORWARD_TARGETS} chats`}
    >
      <div className="flex flex-col gap-3">
        {targets.length > 0 && (
          <ul aria-label={`${targets.length} picked`} className="flex flex-wrap gap-2">
            {targets.map((target) => (
              <li key={target.key}>
                <button
                  type="button"
                  aria-label={`Remove ${target.name}`}
                  onClick={() => toggle(target.key)}
                  className="flex cursor-pointer items-center gap-2 rounded-full bg-accent/15 py-1 pr-3 pl-1 font-semibold"
                >
                  <Avatar url={target.avatarUrl} name={target.name} size={24} />
                  {target.name}
                  <X aria-hidden size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats and your circle"
          aria-label="Search chats"
        />
        {shown.length === 0 ? (
          <p className="text-sm text-muted">
            {query ? `Nothing matches “${query}”.` : 'No chats yet.'}
          </p>
        ) : (
          <ul className="flex max-h-72 flex-col overflow-y-auto">
            {shown.map((target) => (
              <li key={target.key}>
                <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-raised">
                  <input
                    type="checkbox"
                    checked={picked.includes(target.key)}
                    onChange={() => toggle(target.key)}
                    className="size-4 accent-[rgb(var(--pd-accent))]"
                  />
                  <Avatar name={target.name} url={target.avatarUrl} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{target.name}</span>
                    <span className="block truncate text-sm text-muted">
                      {target.kind === 'group'
                        ? 'Group'
                        : target.username && !target.name.startsWith('@')
                          ? `@${target.username}`
                          : ''}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className={cn('text-sm font-medium text-danger')}>
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onClose()} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void send()} disabled={busy || targets.length === 0}>
            <Send aria-hidden size={16} />
            {busy ? 'Sending…' : targets.length > 0 ? `Send to ${targets.length}` : 'Send'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
