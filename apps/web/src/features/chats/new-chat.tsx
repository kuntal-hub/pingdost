// Start a chat or a group by username (exact match, like the phone).
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';

import { contactName, rememberContact, type Contact } from '@/chat/contacts';
import { useChatClient } from '@/chat/store';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Alert, Card, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, useSession } from '@/session/session';
import { GROUP_NAME_MAX } from '@pingdost/message-engine';

async function lookUp(username: string, self: string | undefined): Promise<Contact> {
  const clean = username.trim().replace(/^@/, '').toLowerCase();
  if (!clean) throw new Error('Type a username.');
  let found: Contact;
  try {
    found = await api.account.lookupUsername(clean);
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new Error(
      code === 'NOT_FOUND'
        ? `No one is called @${clean}.`
        : 'Could not look that up. Check your connection.',
      { cause: error },
    );
  }
  if (found.userId === self) throw new Error("That's you.");
  rememberContact(found);
  return found;
}

export function NewChatPage() {
  const navigate = useNavigate();
  const client = useChatClient();
  const self = useSession((state) => state.device?.userId);
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!client) return;
    setBusy(true);
    setError(undefined);
    try {
      const contact = await lookUp(username, self);
      const conversation = await client.openDirectConversation(contact.userId);
      void navigate(`/chat/${conversation.conversationId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start the chat.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg p-6">
      <Card className="flex flex-col gap-4">
        <CardTitle>New chat</CardTitle>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-medium">Username</span>
            <Input
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="@username"
              autoComplete="off"
            />
          </label>
          {error && <Alert tone="error">{error}</Alert>}
          <Button type="submit" disabled={busy || !client}>
            {busy ? 'Looking up…' : 'Start chat'}
          </Button>
        </form>
      </Card>
    </div>
  );
}

/** Picks members by username for a new group or "add members". */
export function MemberPicker({
  members,
  onChange,
  exclude = [],
}: {
  members: Contact[];
  onChange: (members: Contact[]) => void;
  exclude?: string[];
}) {
  const self = useSession((state) => state.device?.userId);
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string>();

  async function add() {
    setError(undefined);
    try {
      const contact = await lookUp(username, self);
      if (exclude.includes(contact.userId) || members.some((m) => m.userId === contact.userId)) {
        throw new Error(`${contactName(contact)} is already in the group.`);
      }
      onChange([...members, contact]);
      setUsername('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add them.');
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
          placeholder="Add by @username"
          aria-label="Add a member by username"
        />
        <Button type="button" variant="secondary" onClick={() => void add()}>
          Add
        </Button>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <ul className="flex flex-col gap-1">
        {members.map((member) => (
          <li key={member.userId} className="flex items-center gap-3 rounded-md px-2 py-1">
            <Avatar name={contactName(member)} url={member.avatarUrl} size={32} />
            <span className="flex-1">{contactName(member)}</span>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onChange(members.filter((m) => m.userId !== member.userId))}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function NewGroupPage() {
  const navigate = useNavigate();
  const client = useChatClient();
  const [name, setName] = useState('');
  const [members, setMembers] = useState<Contact[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!client || name.trim() === '' || members.length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      const conversation = await client.createGroup({
        name: name.trim(),
        memberUserIds: members.map((m) => m.userId),
      });
      void navigate(`/chat/${conversation.conversationId}`);
    } catch (caught) {
      const code = (caught as { code?: string }).code;
      setError(
        code === 'GROUP_FULL'
          ? 'That is more people than a group can have.'
          : 'Could not create the group. Check your connection.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg p-6">
      <Card className="flex flex-col gap-4">
        <CardTitle>New group</CardTitle>
        <form onSubmit={(e) => void create(e)} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="font-medium">Group name</span>
            <Input
              autoFocus
              value={name}
              maxLength={GROUP_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekend trip"
            />
          </label>
          <MemberPicker members={members} onChange={setMembers} />
          <p className="text-sm text-muted">
            The group&apos;s name, picture and messages are end-to-end encrypted. The server only
            knows who is in it, to deliver messages.
          </p>
          {error && <Alert tone="error">{error}</Alert>}
          <Button
            type="submit"
            disabled={busy || !client || name.trim() === '' || members.length === 0}
          >
            {busy ? 'Creating…' : 'Create group'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
