// The chats area: the list beside the open chat on wide screens; on narrow ones, either the list
// or the chat. Each is its own floating panel.
import { MessageCircleHeart } from 'lucide-react';
import { Outlet, useParams } from 'react-router';

import { EmptyState } from '@/components/ui/controls';
import { ChatList } from '@/features/chats/chat-list';
import { cn } from '@/lib/cn';

export function ChatsLayout() {
  const { conversationId } = useParams();
  return (
    <div className="flex h-full gap-3">
      <aside
        className={cn(
          'h-full w-full overflow-hidden md:block md:w-96 md:shrink-0 md:rounded-2xl md:pd-card',
          conversationId ? 'hidden' : 'block',
        )}
      >
        <ChatList />
      </aside>
      <section
        className={cn(
          'pd-wallpaper h-full min-w-0 flex-1 overflow-hidden md:rounded-2xl md:pd-card',
          conversationId ? 'block' : 'hidden md:block',
        )}
      >
        <Outlet />
      </section>
    </div>
  );
}

export function NoChatOpen() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState icon={MessageCircleHeart} title="Pick a chat">
        Or start one with the + button. Messages are end-to-end encrypted on every device.
      </EmptyState>
    </div>
  );
}
