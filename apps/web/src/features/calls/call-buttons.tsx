// Voice and video call buttons for a direct chat's header (ADR 0028). Group chats have none
// (REQ §19.5). Calls need the Internet: offline, or with a blocked contact, they are disabled.
import { Phone, Video } from 'lucide-react';

import { useChat } from '@/chat/store';
import { isLive } from '@pingdost/call-engine';

import { dial, useCalls } from './runtime';

export function CallButtons({ peerUserId }: { peerUserId: string }) {
  const online = useChat((state) => state.status === 'online');
  const blocked = useChat((state) => state.blocked.includes(peerUserId));
  const inCall = useCalls((state) => state.call !== null && isLive(state.call.state));
  const disabled = !online || blocked || inCall;
  const title = blocked
    ? 'You blocked this contact'
    : !online
      ? 'Calls need an Internet connection'
      : inCall
        ? 'You are in a call'
        : undefined;
  return (
    <>
      <button
        type="button"
        className="rounded p-2 hover:bg-surface disabled:opacity-50"
        aria-label="Voice call"
        title={title ?? 'Voice call'}
        disabled={disabled}
        onClick={() => void dial(peerUserId, false)}
      >
        <Phone size={18} />
      </button>
      <button
        type="button"
        className="rounded p-2 hover:bg-surface disabled:opacity-50"
        aria-label="Video call"
        title={title ?? 'Video call'}
        disabled={disabled}
        onClick={() => void dial(peerUserId, true)}
      >
        <Video size={18} />
      </button>
    </>
  );
}
