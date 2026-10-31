// What Settings → Devices shows about history this phone sends to linked browsers (ADR 0021):
// the engine's per-browser sync state, read again on each change and every few seconds while
// the screen is open (a browser that stopped answering shows as paused after a while).
import { useEffect, useState } from 'react';

import { useChatRuntime } from '@/engine/hooks';
import type { SyncSendProgress } from '@pingdost/message-engine';

const REFRESH_MS = 3_000;

export function useSyncSendProgress(): Record<string, SyncSendProgress> {
  const runtime = useChatRuntime();
  const [progress, setProgress] = useState<Record<string, SyncSendProgress>>({});
  useEffect(() => {
    if (!runtime) return;
    let live = true;
    const load = () =>
      void runtime.engine.historySendProgress().then(
        (list) => live && setProgress(Object.fromEntries(list.map((p) => [p.deviceId, p]))),
        () => undefined,
      );
    load();
    const unsubscribe = runtime.engine.onHistorySendProgress(load);
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      unsubscribe();
      clearInterval(timer);
    };
  }, [runtime]);
  return progress;
}

export function describeSync(progress: SyncSendProgress | undefined): string | undefined {
  if (!progress) return undefined;
  const messages = progress.messages.toLocaleString();
  switch (progress.state) {
    case 'sending':
      return `Sending history: ${progress.conversationsDone} of ${progress.conversationsTotal} chats · ${messages} messages`;
    case 'paused':
      return `History paused at ${messages} messages (the browser paused or went offline)`;
    case 'done':
      return `History sent: ${messages} messages`;
  }
}
