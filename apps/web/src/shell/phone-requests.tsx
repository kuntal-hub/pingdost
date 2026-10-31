// A new phone asked to take over this account (ADR 0022). A linked browser holds no account
// key, so it cannot approve; it shows the request so the user notices one they did not make,
// and can deny it. Checked on load, on focus and every minute.
import { Smartphone } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { api } from '@/session/session';
import type { PendingPrimaryTransfer } from '@pingdost/shared-types';

const POLL_MS = 60_000;

export function PhoneRequests() {
  const [requests, setRequests] = useState<PendingPrimaryTransfer[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.recovery.pending().then(
      ({ requests: pending }) => setRequests(pending),
      () => undefined, // offline: try again later
    );
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    window.addEventListener('focus', load);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [load]);

  async function deny(requestId: string) {
    setBusy(requestId);
    setError(null);
    try {
      await api.recovery.deny(requestId);
      setRequests((current) => current.filter((r) => r.requestId !== requestId));
    } catch {
      setError('Could not deny it. Check the connection and try again.');
    } finally {
      setBusy(null);
    }
  }

  if (requests.length === 0) return null;
  return (
    <section
      role="alert"
      aria-label="New phone requests"
      className="flex flex-col gap-2 border-b border-danger px-4 py-3"
    >
      {requests.map((request) => (
        <div key={request.requestId} className="flex flex-wrap items-center gap-3">
          <Smartphone aria-hidden size={18} className="text-danger" />
          <p className="min-w-0 flex-1">
            <strong>“{request.name}” wants to become your PingDost phone</strong> (asked at{' '}
            {new Date(request.createdAt).toLocaleTimeString()}). Approve it on your current phone.
            If this was not you, deny it and change your password.
          </p>
          <Button
            variant="secondary"
            disabled={busy === request.requestId}
            onClick={() => void deny(request.requestId)}
          >
            Deny
          </Button>
        </div>
      ))}
      {error && <p className="text-danger">{error}</p>}
    </section>
  );
}
