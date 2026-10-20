/// <reference lib="webworker" />
// The service worker (ADR 0020), built by vite-plugin-pwa (injectManifest):
// - the app shell is precached, so PingDost opens offline (history comes from IndexedDB, and
//   the outbox sends when the connection is back);
// - a Web Push wake (`{"t":"wake"}`, never content) shows a generic "New message" unless a
//   PingDost tab is visible; it decrypts nothing (v1). The tab's own notices use the same tag,
//   so the two never stack;
// - clicking the notice focuses an open PingDost tab or opens one.
import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | { url: string; revision: string | null })[];
};

export const NOTICE_TAG = 'pingdost-new-message';

void self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')));

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let kind = 'wake';
      try {
        kind = (event.data?.json() as { t?: string } | undefined)?.t ?? 'wake';
      } catch {
        // Not JSON: treat it as a wake.
      }
      if (kind !== 'wake') return;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // A visible tab gets the message over its own connection.
      if (windows.some((client) => client.visibilityState === 'visible')) return;
      await self.registration.showNotification('PingDost', {
        body: 'New message',
        tag: NOTICE_TAG,
        icon: '/icons/icon-192.png',
        data: { url: '/' },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows[0];
      if (open) {
        await open.focus();
        return;
      }
      await self.clients.openWindow('/');
    })(),
  );
});
