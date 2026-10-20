// Web Push and notices (ADR 0015, 0020). The browser's push service wakes the service worker
// with `{"t":"wake"}` only; the notice says "New message" and nothing else, from both the
// service worker and the leader tab (one tag, so they never stack). Subscribing needs the
// server's VAPID public key (`VITE_WEB_PUSH_PUBLIC_KEY`) and a built app with its service
// worker (`build` + `preview`, or production).
import { Workbox } from 'workbox-window';

import type { ChatClient } from '@/chat/client';
import { publicConfig } from '@/config';
import { api } from '@/session/session';
import { fromBase64 } from '@pingdost/protocol';

export const NOTICE_TAG = 'pingdost-new-message';

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  void new Workbox('/sw.js').register().catch(() => undefined);
}

export type PushState =
  /** No key configured, no service worker (dev), or the browser cannot. */
  'unsupported' | 'blocked' | 'off' | 'on';

function supported(): boolean {
  return (
    Boolean(publicConfig?.webPushPublicKey) &&
    import.meta.env.PROD &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!supported()) return undefined;
  return (await navigator.serviceWorker.getRegistration()) ?? undefined;
}

export async function pushState(): Promise<PushState> {
  const reg = await registration();
  if (!reg) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return (await reg.pushManager.getSubscription()) && Notification.permission === 'granted'
    ? 'on'
    : 'off';
}

export async function enablePush(): Promise<PushState> {
  const reg = await registration();
  const key = publicConfig?.webPushPublicKey;
  if (!reg || !key) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'off';
  const subscription =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: fromBase64(key) as Uint8Array<ArrayBuffer>,
    }));
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return 'off';
  await api.push.registerToken({
    provider: 'webpush',
    subscription: {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    },
  });
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const reg = await registration();
  await (await reg?.pushManager.getSubscription())?.unsubscribe().catch(() => false);
  await api.push.unregisterToken().catch(() => undefined);
  return reg ? 'off' : 'unsupported';
}

/** In the leader tab: a "New message" notice while no PingDost tab is in front. */
export function installNotices(client: ChatClient): () => void {
  return client.onEngineEvent((event) => {
    if (event.type !== 'received') return;
    if (document.visibilityState === 'visible' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    void (async () => {
      const conversation = await client.getConversation(event.message.conversationId);
      if (conversation?.mutedUntil && conversation.mutedUntil > Date.now()) return;
      const options: NotificationOptions = {
        body: 'New message',
        tag: NOTICE_TAG,
        icon: '/icons/icon-192.png',
      };
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await reg.showNotification('PingDost', options);
      else new Notification('PingDost', options);
    })().catch(() => undefined);
  });
}
