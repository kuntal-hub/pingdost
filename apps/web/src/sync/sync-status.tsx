// The history sync from the phone as this browser shows it (REQ §13.2, ADR 0021): a progress
// banner above the chat list while it runs (pause, resume, try again), and a Settings card
// for the window and a fresh sync. The status says plainly when the phone or this browser is
// offline: then nothing moves, and the server keeps nothing meanwhile.
import { useEffect, useState } from 'react';

import { useChatClient } from '@/chat/store';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import type { HistorySyncStatus } from '@pingdost/message-engine';

import { setSyncDays, SYNC_DAY_CHOICES, syncDays, syncWindow } from './prefs';

export function useHistorySync(): HistorySyncStatus | undefined {
  const client = useChatClient();
  const [status, setStatus] = useState<HistorySyncStatus>();
  useEffect(() => {
    if (!client) return;
    let live = true;
    void client.historySyncStatus().then(
      (next) => live && setStatus(next),
      () => undefined,
    );
    const unsubscribe = client.onHistorySync((next) => setStatus(next));
    return () => {
      live = false;
      unsubscribe();
    };
  }, [client]);
  return status;
}

const count = (n: number) => n.toLocaleString();

/** One line saying where the sync stands. */
export function syncLabel(status: HistorySyncStatus): string {
  const scope = status.conversationId ? 'older messages' : 'history';
  const progress =
    status.conversationsTotal > 0
      ? ` ${count(status.conversationsDone)} of ${count(status.conversationsTotal)} chats · ${count(status.messages)} messages`
      : '';
  switch (status.state) {
    case 'idle':
      return 'Not synced yet.';
    case 'requesting':
      return `Asking your phone for ${scope}…`;
    case 'syncing':
      return `Syncing ${scope} from your phone…${progress}`;
    case 'paused':
      return `Sync paused.${progress}`;
    case 'phone_offline':
      return 'Phone offline — sync paused. It goes on when your phone is online.';
    case 'offline':
      return "You're offline — sync paused.";
    case 'done':
      return status.conversationId
        ? `Loaded ${count(status.messages)} older messages from your phone.`
        : `History synced: ${count(status.messages)} messages from the last ${status.window.days} days.`;
    case 'failed':
      return status.error === 'refused'
        ? 'Your phone did not send history to this browser.'
        : status.error === 'no_phone'
          ? 'No phone found for this account.'
          : "The history didn't arrive intact, so it was not kept. Try again.";
  }
}

const ACTIVE: ReadonlySet<HistorySyncStatus['state']> = new Set([
  'requesting',
  'syncing',
  'paused',
  'phone_offline',
  'offline',
  'failed',
]);

function percent(status: HistorySyncStatus): number | undefined {
  if (status.conversationsTotal === 0) return undefined;
  return Math.round((status.conversationsDone / status.conversationsTotal) * 100);
}

/** Shown above the chat list while the recent-history sync is not finished. */
export function SyncBanner() {
  const client = useChatClient();
  const status = useHistorySync();
  if (!client || !status || !ACTIVE.has(status.state) || status.conversationId) return null;
  const value = percent(status);
  const running = status.state !== 'paused' && status.state !== 'failed';
  return (
    <div className="border-b border-border bg-surface px-3 py-2" role="status">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-sm">{syncLabel(status)}</p>
        {status.state === 'failed' ? (
          <Button
            variant="ghost"
            className="min-h-8 px-2 text-sm"
            onClick={() => void client.resumeHistorySync()}
          >
            Try again
          </Button>
        ) : (
          <Button
            variant="ghost"
            className="min-h-8 px-2 text-sm"
            onClick={() => void (running ? client.pauseHistorySync() : client.resumeHistorySync())}
          >
            {running ? 'Pause' : 'Resume'}
          </Button>
        )}
      </div>
      <progress
        className="mt-1 h-1.5 w-full accent-primary"
        max={100}
        {...(value === undefined ? {} : { value })}
        aria-label="History sync progress"
      />
    </div>
  );
}

/** Settings: how far back to sync, where it stands, and a fresh sync. */
export function HistorySyncCard() {
  const client = useChatClient();
  const status = useHistorySync();
  const [days, setDays] = useState(syncDays);
  const running =
    status?.state === 'requesting' ||
    status?.state === 'syncing' ||
    status?.state === 'phone_offline' ||
    status?.state === 'offline';
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>History from your phone</CardTitle>
      <p className="text-muted">
        Your phone sends this browser recent messages, end-to-end encrypted. Your phone has to be
        online; the server only passes the data on and keeps none of it. Older messages of a chat
        come when you ask for them there.
      </p>
      <label className="flex items-center gap-3">
        <span>Recent messages from the last</span>
        <select
          className="rounded-md border border-border bg-background px-2 py-1"
          value={days}
          onChange={(event) => {
            const next = Number(event.target.value);
            setDays(next);
            setSyncDays(next);
          }}
        >
          {SYNC_DAY_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {choice === 365 ? 'year' : `${choice} days`}
            </option>
          ))}
        </select>
      </label>
      {status && <p className="text-sm">{syncLabel(status)}</p>}
      {status?.recentSyncedAt && (
        <p className="text-sm text-muted">
          Last full sync: {new Date(status.recentSyncedAt).toLocaleString()}
        </p>
      )}
      <Button
        variant="secondary"
        className="self-start"
        disabled={!client || running}
        onClick={() => void client?.syncHistory(syncWindow())}
      >
        {running ? 'Syncing…' : 'Sync again now'}
      </Button>
    </Card>
  );
}
