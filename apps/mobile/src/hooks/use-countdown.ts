import { useEffect, useState } from 'react';

/** Seconds left on a resend timer, and a function to start it again. */
export function useCountdown(initialSeconds = 0): [number, (seconds: number) => void] {
  const [endsAt, setEndsAt] = useState(() => Date.now() + initialSeconds * 1000);
  const [now, setNow] = useState(() => Date.now());
  const left = Math.max(0, Math.ceil((endsAt - now) / 1000));

  useEffect(() => {
    if (left <= 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [left]);

  function start(seconds: number): void {
    const at = Date.now();
    setNow(at);
    setEndsAt(at + seconds * 1000);
  }

  return [left, start];
}
