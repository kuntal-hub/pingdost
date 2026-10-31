// The linked browser's app frame (ADR 0020): a rail with chats and settings, the connection
// state, and chat itself, started here for this tab (the engine in one tab per browser).
// Shortcuts: Ctrl+K searches, Alt+N starts a new chat.
import { MessageSquare, Settings } from 'lucide-react';
import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';

import { startChat } from '@/chat/start';
import { useChat } from '@/chat/store';
import { cn } from '@/lib/cn';
import { useSession } from '@/session/session';
import type { TransportStatus } from '@pingdost/transport';

import { PhoneRequests } from './phone-requests';

const STATUS_TEXT: Record<TransportStatus, string> = {
  online: 'Connected',
  connecting: 'Connecting…',
  offline: 'Offline',
};

function railClass({ isActive }: { isActive: boolean }): string {
  return cn(
    'flex min-h-11 items-center gap-2 rounded-md px-3 font-medium',
    isActive ? 'bg-primary/15 text-primary' : 'text-foreground hover:bg-surface',
  );
}

export function AppShell() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const inChats = pathname === '/' || pathname.startsWith('/chat');
  const device = useSession((state) => state.device);
  const status = useChat((state) => state.status);
  const error = useChat((state) => state.error);

  useEffect(() => startChat(), []);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        void navigate('/search');
      } else if (event.altKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        void navigate('/new');
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [navigate]);

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <nav
        aria-label="Main"
        className="flex gap-2 border-b border-border p-2 md:w-48 md:flex-col md:border-b-0 md:border-r"
      >
        <div className="mb-2 hidden items-center gap-2 px-3 md:flex">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span className="text-lg font-bold">PingDost</span>
        </div>
        <Link
          to="/"
          className={railClass({ isActive: inChats })}
          aria-current={inChats ? 'page' : undefined}
        >
          <MessageSquare aria-hidden size={18} /> Chats
        </Link>
        <NavLink to="/settings" className={railClass}>
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
          {device?.username ? (
            <span className="hidden md:inline"> · @{device.username}</span>
          ) : null}
        </p>
      </nav>
      <main className="min-h-0 min-w-0 flex-1">
        <PhoneRequests />
        {error && (
          <p role="alert" className="border-b border-danger px-4 py-2 text-danger">
            {error}. Reload the page; if it keeps happening, unlink this browser and link it again.
          </p>
        )}
        <Outlet />
      </main>
    </div>
  );
}
