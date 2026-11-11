// The circle action for one person on the web (Phase 37, ADR 0041): ask them in, withdraw,
// or answer their request. Used on the new-chat result, the contact page and in place of the
// composer.
import { Check, UserPlus } from 'lucide-react';
import { useState } from 'react';

import { prefsChanged } from '@/chat/start';
import { useChat, useCircleState } from '@/chat/store';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { api } from '@/session/session';

export function circleError(error: unknown): string {
  const code = (error as { code?: string }).code;
  if (code === 'RATE_LIMITED') return 'You sent many requests today. Try again tomorrow.';
  if (code === 'CIRCLE_LIMIT_REACHED')
    return 'Your circle or your waiting requests are full. Remove someone or withdraw a request first.';
  if (code === 'CONFLICT') return 'You blocked them. Unblock them first.';
  if (code === 'NOT_FOUND') return 'That request is no longer there.';
  return 'That did not work. Check your connection and try again.';
}

/** Runs a circle change, then has the leader tab reload the lists for every tab. */
export function useCircleChange(): {
  busy: boolean;
  error: string | undefined;
  run: (change: () => Promise<unknown>) => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return {
    busy,
    error,
    run(change) {
      setBusy(true);
      setError(undefined);
      change()
        .then(() => prefsChanged())
        .catch((caught: unknown) => setError(circleError(caught)))
        .finally(() => setBusy(false));
    },
  };
}

/** Nothing once they are in the circle (or before the lists load). */
export function CircleAction({ userId, name }: { userId: string; name: string }) {
  const state = useCircleState(userId);
  const { busy, error, run } = useCircleChange();
  if (state === undefined || state === 'member') return null;
  return (
    <div className="flex flex-col gap-2">
      {state === 'incoming' ? (
        <>
          <p className="text-center text-muted">{name} asked to join your circle.</p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              disabled={busy}
              onClick={() => run(() => api.circles.decline(userId))}
            >
              Decline
            </Button>
            <Button
              className="flex-1"
              disabled={busy}
              onClick={() => run(() => api.circles.accept(userId))}
            >
              <Check aria-hidden size={18} />
              Accept
            </Button>
          </div>
        </>
      ) : state === 'requested' ? (
        <>
          <p className="text-center text-muted">
            Requested. You can message {name} once they accept.
          </p>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => run(() => api.circles.withdraw(userId))}
          >
            Withdraw request
          </Button>
        </>
      ) : (
        <Button disabled={busy} onClick={() => run(() => api.circles.request(userId))}>
          <UserPlus aria-hidden size={18} />
          Add to circle
        </Button>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}

/** Circle requests waiting for an answer: the count for the chat list's Requests row. */
export function useIncomingCount(): number {
  return useChat((state) => state.circle?.incoming.length ?? 0);
}
