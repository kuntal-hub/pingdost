// Routes by stage (ADR 0019): the pairing screen until this browser is linked, then the app.
import { createBrowserRouter, Navigate } from 'react-router';
import { RouterProvider } from 'react-router/dom';

import { configError } from '@/config';
import { PairingPage } from '@/pairing/pairing-page';
import { useSession } from '@/session/session';
import { AppShell } from '@/shell/app-shell';
import { ChatsPage } from '@/shell/chats-page';
import { SettingsPage } from '@/shell/settings-page';

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
  if (stage === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center text-muted" aria-busy>
        Opening PingDost…
      </main>
    );
  }
  return stage === 'paired' ? <AppShell /> : <PairingPage />;
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <Root />,
    children: [
      { index: true, element: <ChatsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
