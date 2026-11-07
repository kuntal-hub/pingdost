// Routes by stage (ADR 0019, 0020): the pairing screen until this browser is linked, then the
// app: chats (list and conversation), new chat and group, contact and group info, message info,
// search, calls and settings. The app's code (engine, protocol, chat screens) loads on demand,
// so the pairing screen opens fast.
import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { RouterProvider } from 'react-router/dom';

import { configError } from '@/config';
import { PairingPage } from '@/pairing/pairing-page';
import { useSession } from '@/session/session';

const AppShell = lazy(() => import('@/shell/app-shell').then((m) => ({ default: m.AppShell })));

function Loading() {
  return (
    <main className="flex min-h-screen items-center justify-center text-muted" aria-busy>
      Opening PingDost…
    </main>
  );
}

function Root() {
  const stage = useSession((state) => state.stage);
  if (configError) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <h1 className="text-xl font-bold">PingDost is not configured</h1>
        <p className="mt-2 text-muted">{configError}</p>
      </main>
    );
  }
  if (stage === 'loading') return <Loading />;
  if (stage !== 'paired') return <PairingPage />;
  return (
    <Suspense fallback={<Loading />}>
      <AppShell />
    </Suspense>
  );
}

const page = (load: () => Promise<RouteObject['Component']>): Pick<RouteObject, 'lazy'> => ({
  lazy: async () => ({ Component: await load() }),
});

const router = createBrowserRouter([
  {
    path: '/',
    element: <Root />,
    children: [
      {
        ...page(() => import('@/shell/chats-page').then((m) => m.ChatsLayout)),
        children: [
          { index: true, ...page(() => import('@/shell/chats-page').then((m) => m.NoChatOpen)) },
          {
            path: 'chat/:conversationId',
            ...page(() => import('@/features/chats/chat-view').then((m) => m.ChatView)),
          },
        ],
      },
      {
        path: 'new',
        ...page(() => import('@/features/chats/new-chat').then((m) => m.NewChatPage)),
      },
      {
        path: 'new-group',
        ...page(() => import('@/features/chats/new-chat').then((m) => m.NewGroupPage)),
      },
      {
        path: 'contact/:userId',
        ...page(() => import('@/features/contact/contact-page').then((m) => m.ContactPage)),
      },
      {
        path: 'group/:groupId',
        ...page(() => import('@/features/groups/group-page').then((m) => m.GroupPage)),
      },
      {
        path: 'message/:messageId',
        ...page(() => import('@/features/chats/message-info').then((m) => m.MessageInfoPage)),
      },
      {
        path: 'search',
        ...page(() => import('@/features/chats/search-page').then((m) => m.SearchPage)),
      },
      {
        path: 'calls',
        ...page(() => import('@/features/calls/calls-page').then((m) => m.CallsPage)),
      },
      {
        path: 'settings',
        ...page(() => import('@/shell/settings-page').then((m) => m.SettingsPage)),
      },
      {
        path: 'appearance',
        ...page(() =>
          import('@/features/appearance/appearance-page').then((m) => m.AppearancePage),
        ),
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
