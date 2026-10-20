// The linked browser's app frame: navigation, the connection state, and the gateway
// connection that hears a revocation (`connection.ts`).
import { MessageSquare, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router';

import { cn } from '@/lib/cn';
import { startConnection } from '@/session/connection';
import { useSession } from '@/session/session';
import type { TransportStatus } from '@pingdost/transport';

const STATUS_TEXT: Record<TransportStatus, string> = {
  online: 'Connected',
  connecting: 'Connecting…',
  offline: 'Offline',
};

function navClass({ isActive }: { isActive: boolean }): string {
  return cn(
    'flex min-h-11 items-center gap-2 rounded-md px-3 font-medium',
    isActive ? 'bg-primary/15 text-primary' : 'text-foreground hover:bg-surface',
  );
}

export function AppShell() {
  const device = useSession((state) => state.device);
  const [status, setStatus] = useState<TransportStatus>('connecting');

  useEffect(() => startConnection(setStatus), []);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <nav
        aria-label="Main"
        className="flex gap-2 border-b border-border p-3 md:w-60 md:flex-col md:border-b-0 md:border-r"
      >
        <div className="mb-2 hidden items-center gap-2 px-3 md:flex">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span className="text-lg font-bold">PingDost</span>
        </div>
        <NavLink to="/" end className={navClass}>
          <MessageSquare aria-hidden size={18} /> Chats
        </NavLink>
        <NavLink to="/settings" className={navClass}>
          <Settings aria-hidden size={18} /> Settings
        </NavLink>
        <p
          className="ml-auto self-center text-sm text-muted md:mt-auto md:ml-0 md:px-3"
          aria-live="polite"
        >
          <span
            aria-hidden
            className={cn(
              'mr-2 inline-block h-2 w-2 rounded-full',
              status === 'online'
                ? 'bg-success'
                : status === 'connecting'
                  ? 'bg-muted'
                  : 'bg-danger',
            )}
          />
          {STATUS_TEXT[status]}
          {device?.username ? ` · @${device.username}` : ''}
        </p>
      </nav>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
