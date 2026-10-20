// The chats area: the list beside the open chat on wide screens; on narrow ones, either the list
// or the chat.
import { Outlet, useParams } from 'react-router';

import { ChatList } from '@/features/chats/chat-list';
import { cn } from '@/lib/cn';

export function ChatsLayout() {
  const { conversationId } = useParams();
  return (
    <div className="flex h-full">
      <aside
        className={cn(
          'h-full w-full border-r border-border md:block md:w-80 md:shrink-0',
          conversationId ? 'hidden' : 'block',
        )}
      >
        <ChatList />
      </aside>
      <section
        className={cn('h-full min-w-0 flex-1', conversationId ? 'block' : 'hidden md:block')}
      >
        <Outlet />
      </section>
    </div>
  );
}

export function NoChatOpen() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-muted">
      Pick a chat, or start one with the + button. Messages are end-to-end encrypted on every
      device.
    </div>
  );
}
