// "Link this browser" (REQ §13.1): the QR code the phone scans, how to find the scanner, the
// time left (a new code replaces it before it expires), and what browser storage can and
// cannot promise (REQ §7.5, §14.2).
import { useEffect, useState } from 'react';

import { QrCode } from '@/components/qr-code';
import { Button } from '@/components/ui/button';
import { Alert, Card, CardTitle } from '@/components/ui/card';
import { browserName } from '@/session/browser-name';
import { useSession } from '@/session/session';

import { linkThisBrowser } from './link';
import { isStopped } from './pairing';

type Phase = 'starting' | 'waiting' | 'approved' | 'failed';

function useSecondsLeft(until: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return until === undefined ? 0 : Math.max(0, Math.round((until - now) / 1_000));
}

export function PairingPage() {
  const notice = useSession((state) => state.notice);
  const [code, setCode] = useState<{ text: string; expiresAt: number }>();
  const [phase, setPhase] = useState<Phase>('starting');
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const secondsLeft = useSecondsLeft(code?.expiresAt);
  const name = browserName(navigator.userAgent);

  useEffect(() => {
    const controller = new AbortController();
    setPhase('starting');
    linkThisBrowser(
      name,
      {
        onCode: (next) => {
          setCode(next);
          setPhase('waiting');
        },
        onApproved: () => setPhase('approved'),
        onOffline: setOffline,
      },
      controller.signal,
    ).catch((error: unknown) => {
      if (!isStopped(error)) setPhase('failed');
    });
    return () => controller.abort();
  }, [name, attempt]);

  return (
    <main className="pd-wallpaper flex min-h-screen flex-col items-center justify-center gap-6 p-6">
      <div className="pd-rise flex w-full max-w-3xl flex-col gap-6">
        <header className="flex items-center gap-4">
          <span className="relative flex">
            <span className="pd-ring absolute inset-0 rounded-[28%] border-2 border-accent" />
            <img src="/favicon.svg" alt="" width={56} height={56} className="relative" />
          </span>
          <div>
            <h1 className="font-display text-4xl font-extrabold">PingDost</h1>
            <p className="font-semibold text-muted">On the web, linked to your phone.</p>
          </div>
        </header>
        {notice && <Alert>{notice}</Alert>}
        <Card className="pd-floating grid gap-8 md:grid-cols-[auto_1fr] md:items-center">
          <div className="flex flex-col items-center gap-2">
            <div className="rounded-xl bg-white p-3">
              {code && phase !== 'failed' ? (
                <QrCode value={code.text} size={240} label="Pairing code for the PingDost app" />
              ) : (
                <div className="flex h-[240px] w-[240px] items-center justify-center text-sm text-neutral-600">
                  {phase === 'failed' ? 'No code' : 'Preparing a code…'}
                </div>
              )}
            </div>
            {phase === 'waiting' && (
              <p className="text-sm text-muted">
                {secondsLeft > 0 ? `${secondsLeft} s left · renews on its own` : 'Renewing…'}
              </p>
            )}
            {import.meta.env.DEV && code && (
              // Dev builds: the code as text, for `pnpm --filter @pingdost/sim-client phone`.
              <details className="max-w-[260px] text-xs text-muted">
                <summary>Pairing code as text (dev)</summary>
                <code data-testid="pairing-code" className="break-all">
                  {code.text}
                </code>
              </details>
            )}
          </div>
          <div className="flex flex-col gap-4">
            <CardTitle>Link this browser</CardTitle>
            <ol className="list-decimal space-y-2 pl-5">
              <li>Open PingDost on your phone.</li>
              <li>
                Go to <strong>Settings → Devices → Link a browser</strong>.
              </li>
              <li>Scan this code, check that it says {name}, and approve.</li>
            </ol>
            <div aria-live="polite">
              {phase === 'approved' && (
                <Alert tone="success">Approved. Finishing on this browser…</Alert>
              )}
              {phase === 'failed' && (
                <Alert tone="error">
                  This browser could not be linked. Check your connection and try again.
                </Alert>
              )}
              {offline && phase === 'waiting' && (
                <Alert tone="error">No connection to PingDost. Still trying…</Alert>
              )}
            </div>
            {phase === 'failed' && (
              <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            )}
            <p className="text-sm text-muted">
              The code holds no password or key, works once, and expires in two minutes. Your phone
              must approve it.
            </p>
          </div>
        </Card>
        <p className="text-sm text-muted">
          Messages here are end-to-end encrypted and stored encrypted in this browser. Browser
          storage is weaker than your phone&apos;s keystore, and the browser may clear it; your
          phone keeps your history.
        </p>
      </div>
    </main>
  );
}
