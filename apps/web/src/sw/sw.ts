/// <reference lib="webworker" />
// The service worker (ADR 0020), built by vite-plugin-pwa (injectManifest):
// - the app shell is precached, so PingDost opens offline (history comes from IndexedDB, and
//   the outbox sends when the connection is back);
// - a Web Push wake (`{"t":"wake"}`, never content) shows a generic "New message" unless a
//   PingDost tab is visible; it decrypts nothing (v1). The tab's own notices use the same tag,
//   so the two never stack;
// - a call push (`{"t":"call"}`, ADR 0028) shows a generic "Incoming call" for about one ring;
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

/** The "Incoming call" notice; the tab closes it when the call is answered or ends. */
export const CALL_NOTICE_TAG = 'pingdost-call';
/** How long an "Incoming call" notice may stay: about one ring (ADR 0028). */
const CALL_NOTICE_MS = 45_000;

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let kind = 'wake';
      try {
        kind = (event.data?.json() as { t?: string } | undefined)?.t ?? 'wake';
      } catch {
        // Not JSON: treat it as a wake.
      }
      if (kind !== 'wake' && kind !== 'call' && kind !== 'circle') return;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // A visible tab gets the message (or the call invite) over its own connection.
      if (windows.some((client) => client.visibilityState === 'visible')) return;
      if (kind === 'call') {
        // `{"t":"call"}` names no caller: the invite itself is E2EE and arrives once PingDost
        // is open and connected (an open tab connects by itself).
        await self.registration.showNotification('PingDost', {
          body: 'Incoming call',
          tag: CALL_NOTICE_TAG,
          requireInteraction: true,
          icon: '/icons/icon-192.png',
          data: { url: '/' },
        });
        // Best effort: the worker may be stopped before this.
        await new Promise((resolve) => setTimeout(resolve, CALL_NOTICE_MS));
        for (const shown of await self.registration.getNotifications({ tag: CALL_NOTICE_TAG })) {
          shown.close();
        }
        return;
      }
      if (kind === 'circle') {
        // A circle request or accept (Phase 37); the lists load once PingDost is open.
        await self.registration.showNotification('PingDost', {
          body: 'Circle update',
          tag: 'pingdost-circle',
          icon: '/icons/icon-192.png',
          data: { url: '/circle' },
        });
        return;
      }
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
