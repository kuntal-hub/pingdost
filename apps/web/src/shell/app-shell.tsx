// The linked browser's app frame (ADR 0020, 0035): a floating dock with chats, calls and
// settings, the connection state, and chat itself, started here for this tab (the engine in one
// tab per browser). Shortcuts: Ctrl+K searches, Alt+N starts a new chat.
import { MessageCircle, Phone, Settings, type LucideIcon } from 'lucide-react';
import { useEffect } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';

import { startChat } from '@/chat/start';
import { useChat } from '@/chat/store';
import { Avatar } from '@/components/avatar';
import { CallOverlay } from '@/features/calls/call-overlay';
import { startCalls } from '@/features/calls/runtime';
import { cn } from '@/lib/cn';
import { useSession } from '@/session/session';
import type { TransportStatus } from '@pingdost/transport';

import { PhoneRequests } from './phone-requests';

const STATUS_TEXT: Record<TransportStatus, string> = {
  online: 'Connected',
  connecting: 'Connecting…',
  offline: 'Offline',
};

const TABS: { to: string; label: string; icon: LucideIcon; match: (path: string) => boolean }[] = [
  {
    to: '/',
    label: 'Chats',
    icon: MessageCircle,
    match: (path) => path === '/' || path.startsWith('/chat'),
  },
  { to: '/calls', label: 'Calls', icon: Phone, match: (path) => path.startsWith('/calls') },
  {
    to: '/settings',
    label: 'Settings',
    icon: Settings,
    match: (path) => path.startsWith('/settings') || path.startsWith('/appearance'),
  },
];

/** The rail on wide screens, a floating pill along the bottom on narrow ones. */
function Dock() {
  const { pathname } = useLocation();
  const device = useSession((state) => state.device);
  const status = useChat((state) => state.status);
  const active = TABS.findIndex((tab) => tab.match(pathname));
  return (
    <nav
      aria-label="Main"
      className={cn(
        'pd-floating fixed inset-x-3 bottom-3 z-30 flex items-center rounded-full p-1.5 md:static md:flex md:w-[72px] md:flex-col md:gap-1 md:rounded-2xl md:py-3',
        // On a phone-sized screen a conversation gets the whole height.
        pathname.startsWith('/chat/') && 'hidden',
      )}
    >
      <Link to="/" aria-label="PingDost home" className="pd-press mb-3 hidden md:block">
        <img src="/favicon.svg" alt="" width={44} height={44} />
      </Link>
      <div className="relative flex flex-1 md:w-full md:flex-none md:flex-col md:gap-1">
        {TABS.map((tab, index) => (
          <Link
            key={tab.to}
            to={tab.to}
            aria-label={tab.label}
            aria-current={index === active ? 'page' : undefined}
            title={tab.label}
            className={cn(
              'pd-press flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-xs font-bold md:mx-auto md:size-14 md:flex-none md:rounded-xl',
              index === active ? 'bg-brand text-on-primary' : 'text-muted hover:bg-raised',
            )}
          >
            <tab.icon aria-hidden size={22} />
            <span>{tab.label}</span>
          </Link>
        ))}
      </div>
      <div className="mt-auto hidden flex-col items-center gap-3 md:flex" aria-live="polite">
        <span title={STATUS_TEXT[status]} className="flex items-center">
          <span
            aria-hidden
            className={cn(
              'inline-block size-2.5 rounded-full',
              status === 'online'
                ? 'bg-success'
                : status === 'connecting'
                  ? 'pd-skeleton bg-warning'
                  : 'bg-danger',
            )}
          />
          <span className="sr-only">{STATUS_TEXT[status]}</span>
        </span>
        {device?.username && (
          <Link to="/settings" aria-label={`@${device.username}, settings`} className="pd-press">
            <Avatar name={device.username} size={40} />
          </Link>
        )}
      </div>
    </nav>
  );
}

export function AppShell() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const device = useSession((state) => state.device);
  const error = useChat((state) => state.error);

  useEffect(() => startChat(), []);
  // Calls in this tab (ADR 0028), on whichever chat client the tab has.
  const userId = device?.userId;
  const deviceId = device?.deviceId;
  useEffect(() => {
    if (!userId || !deviceId) return;
    return startCalls({ userId, deviceId });
  }, [userId, deviceId]);

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
    <div className="flex h-dvh gap-3 p-0 md:p-3">
      <Dock />
      {/* The bottom padding keeps narrow screens clear of the floating dock. */}
      <main
        className={cn(
          'min-h-0 min-w-0 flex-1 overflow-y-auto md:pb-0',
          !pathname.startsWith('/chat/') && 'pb-20',
        )}
      >
        <PhoneRequests />
        {error && (
          <p
            role="alert"
            className="mb-2 rounded-lg bg-danger/10 px-4 py-2 font-medium text-danger"
          >
            {error}. Reload the page; if it keeps happening, unlink this browser and link it again.
          </p>
        )}
        <Outlet />
      </main>
      <CallOverlay />
    </div>
  );
}
