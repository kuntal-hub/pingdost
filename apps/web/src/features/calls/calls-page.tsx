// The call history of this browser (ADR 0028): kept only here, in the encrypted store, never
// on the server. Each entry can call the contact back.
import { Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Video } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { contactName, useContact } from '@/chat/contacts';
import { useChatClient } from '@/chat/store';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import type { CallHistoryEntry } from '@pingdost/message-engine';

import { dial, useCalls } from './runtime';

const OUTCOME: Record<CallHistoryEntry['outcome'], string> = {
  completed: '',
  rejected: 'Declined',
  busy: 'Busy',
  no_answer: 'No answer',
  missed: 'Missed',
  cancelled: 'Cancelled',
  failed: 'Failed',
  answered_elsewhere: 'Answered on another device',
  declined_elsewhere: 'Declined on another device',
};

function length(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function Row({ entry }: { entry: CallHistoryEntry }) {
  const peer = useContact(entry.peerUserId);
  const name = contactName(peer);
  const missed = entry.direction === 'in' && entry.outcome === 'missed';
  const Icon = missed ? PhoneMissed : entry.direction === 'in' ? PhoneIncoming : PhoneOutgoing;
  const detail = [
    entry.video ? 'Video' : 'Voice',
    entry.durationMs > 0 ? length(entry.durationMs) : OUTCOME[entry.outcome],
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="flex items-center gap-3 py-2">
      <Avatar name={name} url={peer?.avatarUrl} size={40} />
      <div className="min-w-0 flex-1">
        <p className={missed ? 'truncate font-semibold text-danger' : 'truncate font-semibold'}>
          {name}
        </p>
        <p className="flex items-center gap-1 text-sm text-muted">
          <Icon aria-hidden size={14} />
          <span className="sr-only">{entry.direction === 'in' ? 'Incoming' : 'Outgoing'}</span>
          {detail} · {new Date(entry.startedAt).toLocaleString()}
        </p>
      </div>
      <button
        type="button"
        className="rounded p-2 hover:bg-surface"
        aria-label={`Call ${name}`}
        onClick={() => void dial(entry.peerUserId, entry.video)}
      >
        {entry.video ? <Video size={18} /> : <Phone size={18} />}
      </button>
    </li>
  );
}

export function CallsPage() {
  const client = useChatClient();
  const [entries, setEntries] = useState<CallHistoryEntry[]>();
  const ended = useCalls((state) => state.call?.endedAt ?? null);
  const load = useCallback(() => {
    if (!client) return;
    void client.callHistory().then(setEntries, () => setEntries([]));
  }, [client]);
  useEffect(() => {
    // Reloaded after each call (the entry is written as the call ends).
    const timer = setTimeout(load, ended ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, ended]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">Calls</h1>
      <p className="text-sm text-muted">
        This list is kept only in this browser. PingDost keeps no record of your calls.
      </p>
      {entries === undefined ? (
        <p className="text-muted">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-muted">No calls yet. Start one from a chat with a contact.</p>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {entries.map((entry) => (
              <Row key={entry.callId} entry={entry} />
            ))}
          </ul>
          <Button
            variant="secondary"
            className="self-start"
            onClick={() => void client?.clearCallHistory().then(load, () => undefined)}
          >
            Clear call history
          </Button>
        </>
      )}
    </div>
  );
}
