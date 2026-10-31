// Settings for the linked browser: privacy (the account's settings, the same as on the phone),
// notifications, history from the phone, storage (the attachment cache), what this browser is,
// how its storage compares to the phone's, keyboard shortcuts, and "Unlink this browser",
// which revokes it and deletes its PingDost data.
import { useEffect, useState } from 'react';

import { StorageCard } from '@/attachments/storage-card';
import { prefsChanged } from '@/chat/start';
import { useChat } from '@/chat/store';
import { Button } from '@/components/ui/button';
import { Alert, Card, CardTitle } from '@/components/ui/card';
import { Toggle } from '@/components/ui/input';
import { disablePush, enablePush, pushState, type PushState } from '@/push/push';
import { api, unlink, useSession } from '@/session/session';
import { HistorySyncCard } from '@/sync/sync-status';
import type { PrivacyPrefs } from '@pingdost/shared-types';

const PRIVACY: { key: keyof PrivacyPrefs; label: string; description: string }[] = [
  {
    key: 'readReceipts',
    label: 'Read receipts',
    description: "Off: others don't see when you read, and you don't see theirs.",
  },
  {
    key: 'deliveryReceipts',
    label: 'Delivery receipts',
    description: 'Off: your devices do not confirm delivery to senders.',
  },
  { key: 'typingIndicators', label: 'Typing indicators', description: 'Show and see typing.' },
  {
    key: 'lastSeen',
    label: 'Online status',
    description: 'Contacts you chat with see when you are online.',
  },
];

export const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Ctrl+K', action: 'Search messages' },
  { keys: 'Alt+N', action: 'New chat' },
  { keys: 'Enter', action: 'Send' },
  { keys: 'Shift+Enter', action: 'New line' },
  { keys: '↑ (empty message)', action: 'Edit your last message' },
  { keys: 'Esc', action: 'Cancel reply or edit' },
];

export function SettingsPage() {
  const device = useSession((state) => state.device);
  const privacy = useChat((state) => state.privacy);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [push, setPush] = useState<PushState>();

  useEffect(() => {
    void pushState().then(setPush, () => setPush('unsupported'));
  }, []);

  async function setPrivacy(key: keyof PrivacyPrefs, value: boolean) {
    setError(undefined);
    try {
      const me = await api.account.updateMe({ privacy: { [key]: value } });
      useChat.setState({ privacy: me.privacy });
      prefsChanged();
    } catch {
      setError('Could not save that. Check your connection.');
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">Settings</h1>
      <Card className="flex flex-col">
        <CardTitle className="mb-2">Privacy</CardTitle>
        <p className="mb-2 text-sm text-muted">
          These apply to your whole account, on every device.
        </p>
        {PRIVACY.map(({ key, label, description }) => (
          <Toggle
            key={key}
            label={label}
            description={description}
            checked={privacy?.[key] ?? false}
            disabled={!privacy}
            onChange={(value) => void setPrivacy(key, value)}
          />
        ))}
        {error && <Alert tone="error">{error}</Alert>}
      </Card>

      <Card className="flex flex-col gap-3">
        <CardTitle>Notifications</CardTitle>
        <p className="text-muted">
          Notices say only “New message”. Nothing about the message or its sender leaves your
          devices.
        </p>
        {push === 'unsupported' ? (
          <p className="text-sm text-muted">
            Not available here: this browser cannot, or this build of PingDost has no notification
            key.
          </p>
        ) : push === 'blocked' ? (
          <p className="text-sm text-muted">
            Notifications are blocked for this site. Allow them in the browser&apos;s site settings.
          </p>
        ) : (
          <Button
            variant="secondary"
            className="self-start"
            disabled={push === undefined}
            onClick={() =>
              void (push === 'on' ? disablePush() : enablePush()).then(setPush, () => undefined)
            }
          >
            {push === 'on' ? 'Turn notifications off' : 'Turn notifications on'}
          </Button>
        )}
      </Card>

      <HistorySyncCard />
      <StorageCard />

      <Card className="flex flex-col gap-3">
        <CardTitle>This browser</CardTitle>
        {device && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted">Name</dt>
            <dd>{device.name}</dd>
            <dt className="text-muted">Account</dt>
            <dd>{device.username ? `@${device.username}` : '—'}</dd>
            <dt className="text-muted">Linked</dt>
            <dd>{new Date(device.linkedAt).toLocaleString()}</dd>
          </dl>
        )}
        <p className="text-sm text-muted">
          Your phone is the main device; you can see and remove this browser there under Settings →
          Devices.
        </p>
        <p className="text-sm text-muted">
          PingDost keeps its data in this browser&apos;s storage, encrypted with a key the browser
          will not reveal. That is weaker than your phone&apos;s keystore: anyone who can use this
          browser profile, or run code on this site, could use it. The browser may also clear it to
          free space. Your phone keeps your history.
        </p>
      </Card>

      <Card className="flex flex-col gap-2">
        <CardTitle>Keyboard shortcuts</CardTitle>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
          {SHORTCUTS.map(({ keys, action }) => (
            <div key={keys} className="contents">
              <dt>
                <kbd className="rounded border border-border px-1.5 text-sm">{keys}</kbd>
              </dt>
              <dd className="text-muted">{action}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card className="flex flex-col gap-3">
        <CardTitle>Unlink this browser</CardTitle>
        <p className="text-muted">
          Removes this browser from your account and deletes everything PingDost stored here.
        </p>
        {confirming ? (
          <Alert tone="error" className="flex flex-col gap-3">
            <span>Unlink now? You can link it again later from your phone.</span>
            <div className="flex gap-2">
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void disablePush()
                    .catch(() => undefined)
                    .then(() => unlink())
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? 'Unlinking…' : 'Unlink and delete data'}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </Alert>
        ) : (
          <Button variant="danger" className="self-start" onClick={() => setConfirming(true)}>
            Unlink this browser
          </Button>
        )}
      </Card>
    </div>
  );
}
