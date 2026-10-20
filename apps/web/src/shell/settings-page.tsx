// Settings for the linked browser: what it is, how its storage compares to the phone's, and
// "Unlink this browser", which revokes it and deletes everything PingDost stored here.
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Alert, Card, CardTitle } from '@/components/ui/card';
import { unlink, useSession } from '@/session/session';

export function SettingsPage() {
  const device = useSession((state) => state.device);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <h1 className="text-2xl font-bold">Settings</h1>
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
          Your phone is the main device; you can see and revoke this browser there under Settings →
          Devices.
        </p>
      </Card>
      <Card className="flex flex-col gap-2">
        <CardTitle>Storage in this browser</CardTitle>
        <p className="text-muted">
          PingDost keeps its data in this browser&apos;s storage, encrypted with a key the browser
          will not reveal. That is weaker than your phone&apos;s keystore: anyone who can use this
          browser profile, or run code on this site, could use it. The browser may also clear it to
          free space. Your phone keeps your history.
        </p>
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
                  void unlink().finally(() => setBusy(false));
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
