// New chat and new group (Phase 38, ADR 0042). One field finds people by the start of their
// username or name, or by a whole email address: circle members match in this browser at once,
// the server's search adds everyone else. Group members come only from the circle, several at
// once.
import { Check, Search, UserPlus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';

import { contactName, rememberContact, type Contact } from '@/chat/contacts';
import { prefsChanged } from '@/chat/start';
import { circleStateOf, useChat, useChatClient, type CircleState } from '@/chat/store';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Alert, Card, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { api, useSession } from '@/session/session';
import {
  isWholeEmail,
  matchesPerson,
  mergePeople,
  searchable,
  togglePicked,
} from '@pingdost/chat-core';
import { GROUP_DESCRIPTION_MAX, GROUP_NAME_MAX } from '@pingdost/message-engine';

import { circleError } from '../circle/circle-action';

const DEBOUNCE_MS = 300;

interface Found extends Contact {
  circle: CircleState;
}

function personName(person: Pick<Contact, 'displayName' | 'username'>): string {
  return person.displayName ?? (person.username ? `@${person.username}` : 'Someone');
}

/** Circle members as contacts. */
function useCircleMembers(): Contact[] {
  const circle = useChat((state) => state.circle);
  return useMemo(
    () =>
      (circle?.members ?? []).map((m) => ({
        userId: m.userId,
        username: m.username ?? '',
        displayName: m.displayName,
        avatarUrl: m.avatarUrl,
      })),
    [circle],
  );
}

/** The server's search after a pause in typing; an older answer never replaces a newer one. */
function useServerSearch(query: string, enabled: (q: string) => boolean) {
  const [results, setResults] = useState<Found[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string>();
  const latest = useRef(0);
  useEffect(() => {
    setError(undefined);
    if (!enabled(query)) {
      setResults([]);
      setSearching(false);
      return;
    }
    const ticket = ++latest.current;
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      api.account
        .searchUsers(query.trim(), controller.signal)
        .then((found) => {
          if (ticket === latest.current) setResults(found);
        })
        .catch((caught: unknown) => {
          if (ticket !== latest.current || controller.signal.aborted) return;
          setError(
            (caught as { code?: string }).code === 'RATE_LIMITED'
              ? 'Too many searches for now. Wait a moment.'
              : 'The search did not work. Check your connection.',
          );
        })
        .finally(() => {
          if (ticket === latest.current) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, enabled]);
  return { results, searching, error };
}

function ResultRow({ person }: { person: Found }) {
  const navigate = useNavigate();
  const client = useChatClient();
  const local = useChat((state) => circleStateOf(state.circle, person.userId));
  const state = local ?? person.circle;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = personName(person);

  function run(change: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    change()
      .then(() => prefsChanged())
      .catch((caught: unknown) => setError(circleError(caught)))
      .finally(() => setBusy(false));
  }

  async function message() {
    if (!client) return;
    rememberContact(person);
    const conversation = await client.openDirectConversation(person.userId);
    void navigate(`/chat/${conversation.conversationId}`);
  }

  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex items-center gap-3">
        <Avatar url={person.avatarUrl} name={name} size={40} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{name}</span>
          {person.displayName && person.username && (
            <span className="block truncate text-sm text-muted">@{person.username}</span>
          )}
        </span>
        {state === 'member' ? (
          <Button disabled={!client} onClick={() => void message()}>
            Message
          </Button>
        ) : state === 'incoming' ? (
          <Button disabled={busy} onClick={() => run(() => api.circles.accept(person.userId))}>
            <Check aria-hidden size={18} />
            Accept
          </Button>
        ) : state === 'requested' ? (
          <Button
            variant="ghost"
            disabled={busy}
            title="Withdraw the request"
            onClick={() => run(() => api.circles.withdraw(person.userId))}
          >
            Requested
          </Button>
        ) : (
          <Button
            variant="secondary"
            disabled={busy}
            aria-label={`Add ${name} to your circle`}
            onClick={() => run(() => api.circles.request(person.userId))}
          >
            <UserPlus aria-hidden size={18} />
            Add
          </Button>
        )}
      </div>
      {error && <Alert tone="error">{error}</Alert>}
    </li>
  );
}

export function NewChatPage() {
  const self = useSession((state) => state.device?.userId);
  const members = useCircleMembers();
  const [query, setQuery] = useState('');
  const { results, searching, error } = useServerSearch(query, searchable);

  const local = useMemo<Found[]>(
    () =>
      query.trim() === ''
        ? []
        : members
            .filter((member) => matchesPerson(member, query))
            .map((member) => ({ ...member, circle: 'member' as const })),
    [members, query],
  );
  const shown = mergePeople(local, results).filter((person) => person.userId !== self);

  return (
    <div className="mx-auto max-w-lg p-6">
      <Card className="flex flex-col gap-4">
        <CardTitle>New chat</CardTitle>
        <label className="flex h-11 items-center gap-2 rounded-xl bg-background px-3">
          <Search aria-hidden size={18} className="text-muted" />
          <input
            autoFocus
            aria-label="Find people"
            placeholder="Name, @username or email"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent focus:outline-none"
          />
          {searching && <span className="pd-skeleton text-sm text-muted">Searching…</span>}
        </label>
        {error && <Alert tone="error">{error}</Alert>}
        {query.trim() === '' ? (
          <p className="text-sm text-muted">
            Type the start of a name or username, or someone&apos;s whole email address. Emails are
            never shown, and a part of one finds nothing.
          </p>
        ) : shown.length > 0 ? (
          <ul className="divide-y divide-border">
            {shown.map((person) => (
              <ResultRow key={person.userId} person={person} />
            ))}
          </ul>
        ) : (
          !searching &&
          searchable(query) && (
            <p className="text-center text-muted">
              No one found. Some people turn off being found by name or email.
            </p>
          )
        )}
      </Card>
    </div>
  );
}

/**
 * Picks group members from the circle, several at once. A whole email goes through the server
 * and keeps only circle members. `exclude`: current members, shown but not pickable.
 */
export function MemberPicker({
  members: picked,
  onChange,
  exclude = [],
}: {
  members: Contact[];
  onChange: (members: Contact[]) => void;
  exclude?: string[];
}) {
  const circle = useCircleMembers();
  const [query, setQuery] = useState('');
  const { results } = useServerSearch(query, isWholeEmail);
  const byEmail = results.filter((r) => r.circle === 'member');
  const shown = mergePeople(
    circle.filter((member) => matchesPerson(member, query)),
    byEmail,
  );
  const pickedIds = picked.map((m) => m.userId);

  function toggle(person: Contact) {
    const ids = togglePicked(pickedIds, person.userId);
    const all = [...picked, ...circle, ...byEmail];
    onChange(ids.map((id) => all.find((p) => p.userId === id)!).filter(Boolean));
  }

  return (
    <div className="flex flex-col gap-2">
      {picked.length > 0 && (
        <ul aria-label={`${picked.length} picked`} className="flex flex-wrap gap-2">
          {picked.map((person) => (
            <li key={person.userId}>
              <button
                type="button"
                aria-label={`Remove ${contactName(person)}`}
                onClick={() => toggle(person)}
                className="flex items-center gap-2 rounded-full bg-accent/15 py-1 pr-3 pl-1 font-semibold"
              >
                <Avatar url={person.avatarUrl} name={contactName(person)} size={24} />
                {contactName(person)}
                <X aria-hidden size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search your circle, or a whole email"
        aria-label="Search your circle"
      />
      {circle.length === 0 ? (
        <p className="text-sm text-muted">
          Only people in your circle can be added. Add people from New chat first.
        </p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted">No one in your circle matches “{query}”.</p>
      ) : (
        <ul className="flex max-h-72 flex-col overflow-y-auto">
          {shown.map((person) => {
            const member = exclude.includes(person.userId);
            const checked = member || pickedIds.includes(person.userId);
            return (
              <li key={person.userId}>
                <label
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-raised',
                    member && 'cursor-default opacity-60',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={member}
                    onChange={() => toggle(person)}
                    className="size-4 accent-[rgb(var(--pd-accent))]"
                  />
                  <Avatar name={contactName(person)} url={person.avatarUrl} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{contactName(person)}</span>
                    <span className="block truncate text-sm text-muted">
                      {member
                        ? 'Already in the group'
                        : person.displayName && person.username
                          ? `@${person.username}`
                          : ''}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function NewGroupPage() {
  const navigate = useNavigate();
  const client = useChatClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
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
        ...(description.trim() ? { description: description.trim() } : {}),
        memberUserIds: members.map((m) => m.userId),
      });
      void navigate(`/chat/${conversation.conversationId}`);
    } catch (caught) {
      const code = (caught as { code?: string }).code;
      setError(
        code === 'GROUP_FULL'
          ? 'That is more people than a group can have.'
          : code === 'NOT_IN_CIRCLE'
            ? 'Only people in your circle can be added.'
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
          <label className="flex flex-col gap-1">
            <span className="font-medium">Description (optional)</span>
            <textarea
              value={description}
              maxLength={GROUP_DESCRIPTION_MAX}
              rows={2}
              onChange={(e) => setDescription(e.target.value)}
              className="pd-card resize-none rounded-xl px-3 py-2 focus:outline-none"
            />
          </label>
          <span className="font-medium">Members{members.length ? ` (${members.length})` : ''}</span>
          <MemberPicker members={members} onChange={setMembers} />
          <p className="text-sm text-muted">
            The group&apos;s name, description, picture and messages are end-to-end encrypted. The
            server only knows who is in it, to deliver messages.
          </p>
          {error && <Alert tone="error">{error}</Alert>}
          <Button
            type="submit"
            disabled={busy || !client || name.trim() === '' || members.length === 0}
          >
            {busy
              ? 'Creating…'
              : members.length > 0
                ? `Create group (${members.length + 1})`
                : 'Create group'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
