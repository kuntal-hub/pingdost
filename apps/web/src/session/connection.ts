// The gateway connection of a linked browser (ADR 0019). One tab holds it (Web Locks), so two
// open tabs do not keep replacing each other's socket; the others take over when it closes.
// Through it the server says when this device was revoked; every tab then wipes its data
// (BroadcastChannel). Phase 17 grows this leader into the tab that runs the message engine.
import { publicConfig } from '@/config';
import { WsTransport, type TransportStatus } from '@pingdost/transport';

import { accessToken, onSignedOut, refreshTokens, signOut } from './session';

const LOCK = 'pingdost-connection';
const CHANNEL = 'pingdost-session';
const REVOKED = 'This browser was unlinked from your phone, so its PingDost data was deleted.';

type SessionMessage = { type: 'signed_out'; notice?: string };

/** Connects (in the leader tab) and watches for the session ending. Returns its stop. */
export function startConnection(onStatus?: (status: TransportStatus) => void): () => void {
  const channel = new BroadcastChannel(CHANNEL);
  const controller = new AbortController();
  let transport: WsTransport | undefined;
  let release: (() => void) | undefined;
  let stopped = false;

  const end = (notice: string) => {
    channel.postMessage({ type: 'signed_out', notice } satisfies SessionMessage);
    void signOut(notice);
  };
  channel.onmessage = (event: MessageEvent<SessionMessage>) => {
    if (event.data.type === 'signed_out') void signOut(event.data.notice);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    transport?.stop();
    transport = undefined;
    release?.();
    channel.close();
  };
  const unsubscribe = onSignedOut(stop);

  if (publicConfig && 'locks' in navigator) {
    const { wsUrl } = publicConfig;
    navigator.locks
      .request(LOCK, { signal: controller.signal }, () => {
        if (stopped) return undefined;
        transport = new WsTransport({
          url: wsUrl,
          getAccessToken: accessToken,
          refreshToken: refreshTokens,
        });
        transport.status$.subscribe((status) => onStatus?.(status), { emitCurrent: true });
        transport.onEvent((event) => {
          if (event.type === 'revoked') end(REVOKED);
          if (event.type === 'auth_failed' && event.code === 'DEVICE_REVOKED') end(REVOKED);
        });
        transport.start();
        // Held until this tab stops.
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .catch(() => undefined); // aborted on stop
  }

  return () => {
    unsubscribe();
    stop();
  };
}
