// The circle on the web (Phase 37, ADR 0041), from Settings and the chat list's Requests row:
// the people in it (search, remove) and the requests (accept, decline, block; withdraw one's own).
import { Ban, Check, Search, Users, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { useChat } from '@/chat/store';
import { Avatar } from '@/components/avatar';
import { Button, IconButton } from '@/components/ui/button';
import { Alert, Card, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/controls';
import { Dialog } from '@/components/ui/menu';
import { cn } from '@/lib/cn';
import { api } from '@/session/session';
import type { CirclePerson } from '@pingdost/shared-types';

import { useCircleChange } from './circle-action';

function personName(person: Pick<CirclePerson, 'displayName' | 'username'>): string {
  return person.displayName ?? (person.username ? `@${person.username}` : 'Someone');
}

function PersonRow({
  person,
  detail,
  children,
}: {
  person: CirclePerson;
  detail?: string;
  children?: React.ReactNode;
}) {
  const name = personName(person);
  const handle = person.displayName && person.username ? `@${person.username}` : undefined;
  return (
    <li className="flex items-center gap-3 py-2">
      <Avatar url={person.avatarUrl} name={name} size={40} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{name}</span>
        {(handle ?? detail) && (
          <span className="block truncate text-sm text-muted">
            {[handle, detail].filter(Boolean).join(' · ')}
          </span>
        )}
      </span>
      {children}
    </li>
  );
}

export function CirclePage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const circle = useChat((state) => state.circle);
  const tab = params.get('tab') === 'requests' ? 'requests' : 'circle';
  const [query, setQuery] = useState('');
  const [removing, setRemoving] = useState<CirclePerson>();
  const { busy, error, run } = useCircleChange();
  const members = useMemo(() => circle?.members ?? [], [circle]);
  const incoming = circle?.incoming ?? [];
  const outgoing = circle?.outgoing ?? [];

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase().replace(/^@/, '');
    if (!needle) return members;
    return members.filter((m) =>
      [m.displayName, m.username].some((field) => field?.toLowerCase().includes(needle)),
    );
  }, [members, query]);

  const tabs = [
    { id: 'circle', label: `Circle · ${members.length}` },
    { id: 'requests', label: incoming.length ? `Requests · ${incoming.length}` : 'Requests' },
  ] as const;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <h1 className="font-display text-4xl font-extrabold">Circle</h1>
      <div role="tablist" aria-label="Circle or requests" className="pd-card flex rounded-2xl p-1">
        {tabs.map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={tab === option.id}
            onClick={() => setParams(option.id === 'requests' ? { tab: 'requests' } : {})}
            className={cn(
              'flex-1 rounded-xl py-2 font-semibold',
              tab === option.id ? 'bg-brand text-on-primary' : 'text-muted hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {!circle ? (
        <p className="pd-skeleton text-muted">Loading your circle…</p>
      ) : tab === 'circle' ? (
        members.length === 0 ? (
          <EmptyState icon={Users} title="Your circle is empty">
            Start a chat by username to send a request. Once they accept, you can message and call
            each other.
          </EmptyState>
        ) : (
          <Card className="flex flex-col gap-2">
            <label className="flex h-10 items-center gap-2 rounded-xl bg-background px-3">
              <Search aria-hidden size={16} className="text-muted" />
              <input
                aria-label="Search your circle"
                placeholder="Search your circle"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="min-w-0 flex-1 bg-transparent focus:outline-none"
              />
            </label>
            {shown.length === 0 ? (
              <p className="text-muted">No one in your circle matches “{query}”.</p>
            ) : (
              <ul className="divide-y divide-border">
                {shown.map((member) => (
                  <PersonRow key={member.userId} person={member}>
                    <Button
                      variant="ghost"
                      onClick={() => void navigate(`/contact/${member.userId}`)}
                    >
                      Info
                    </Button>
                    <IconButton
                      aria-label={`Remove ${personName(member)} from your circle`}
                      disabled={busy}
                      onClick={() => setRemoving(member)}
                    >
                      <X size={18} />
                    </IconButton>
                  </PersonRow>
                ))}
              </ul>
            )}
          </Card>
        )
      ) : incoming.length === 0 && outgoing.length === 0 ? (
        <EmptyState icon={Users} title="No requests">
          When someone asks to join your circle, it shows here.
        </EmptyState>
      ) : (
        <>
          {incoming.length > 0 && (
            <Card className="flex flex-col">
              <CardTitle className="mb-1">Waiting for you</CardTitle>
              <ul className="divide-y divide-border">
                {incoming.map((request) => {
                  const name = personName(request);
                  return (
                    <PersonRow key={request.userId} person={request} detail="Wants to join">
                      <IconButton
                        aria-label={`Block ${name}`}
                        title="Block"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await api.security.block(request.userId);
                            useChat.setState((state) => ({
                              blocked: [...new Set([...state.blocked, request.userId])],
                            }));
                          })
                        }
                      >
                        <Ban size={18} />
                      </IconButton>
                      <IconButton
                        aria-label={`Decline ${name}'s request`}
                        title="Decline"
                        disabled={busy}
                        onClick={() => run(() => api.circles.decline(request.userId))}
                      >
                        <X size={18} />
                      </IconButton>
                      <IconButton
                        tone="brand"
                        aria-label={`Accept ${name}'s request`}
                        title="Accept"
                        disabled={busy}
                        onClick={() => run(() => api.circles.accept(request.userId))}
                      >
                        <Check size={18} />
                      </IconButton>
                    </PersonRow>
                  );
                })}
              </ul>
            </Card>
          )}
          {outgoing.length > 0 && (
            <Card className="flex flex-col">
              <CardTitle className="mb-1">Sent by you</CardTitle>
              <ul className="divide-y divide-border">
                {outgoing.map((request) => (
                  <PersonRow key={request.userId} person={request} detail="Requested">
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => run(() => api.circles.withdraw(request.userId))}
                    >
                      Withdraw
                    </Button>
                  </PersonRow>
                ))}
              </ul>
            </Card>
          )}
          <p className="text-sm text-muted">
            Declining is silent: they keep seeing “Requested” until the request expires after 30
            days.
          </p>
        </>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      <p className="text-sm text-muted">
        Only people in your circle can message you, call you or add you to a group. PingDost’s
        server keeps the list of who is in whose circle until either of you removes the other or
        deletes the account.
      </p>

      <Dialog
        open={removing !== undefined}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title={removing ? `Remove ${personName(removing)}?` : 'Remove'}
      >
        <div className="flex flex-col gap-3">
          <p className="text-muted">
            You can no longer message or call each other. They are not told, but they will see that
            you are no longer in their circle.
          </p>
          <Button
            variant="danger"
            onClick={() => {
              const person = removing;
              setRemoving(undefined);
              if (person) run(() => api.circles.remove(person.userId));
            }}
          >
            Remove
          </Button>
          <Button variant="secondary" onClick={() => setRemoving(undefined)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
