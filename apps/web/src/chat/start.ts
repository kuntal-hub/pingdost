// One engine per browser (ADR 0020): the tab holding the Web Lock runs it with the gateway
// socket; every other tab is a follower whose calls go to it over BroadcastChannel. When the
// leader tab closes, the lock passes to another tab, which starts the engine and announces
// itself. A revocation reaches every tab, which then wipes its data (ADR 0019).
import { installNotices } from '@/push/push';
import { onSignedOut, signOut } from '@/session/session';

import { CHANNEL, RemoteChat, type BusMessage } from './bus';
import { startLeader, type LeaderRuntime } from './leader';
import { useChat } from './store';

const LOCK = 'pingdost-connection';
const REVOKED = 'This browser was unlinked from your phone, so its PingDost data was deleted.';

/** Starts chat for this tab; returns its stop. */
export function startChat(): () => void {
  const tab = crypto.randomUUID();
  const channel = new BroadcastChannel(CHANNEL);
  const post = (message: BusMessage) => channel.postMessage(message);
  const remote = new RemoteChat(channel, tab);
  const controller = new AbortController();
  let leader: LeaderRuntime | undefined;
  let release: (() => void) | undefined;
  let stopped = false;

  useChat.setState({ client: remote.client, role: 'follower', error: undefined });

  const revoked = () => {
    post({ type: 'signed_out', notice: REVOKED });
    void signOut(REVOKED);
  };

  channel.onmessage = (event: MessageEvent<BusMessage>) => {
    const message = event.data;
    if (message.type === 'signed_out') {
      void signOut(message.notice);
      return;
    }
    if (leader) {
      leader.handle(message);
      return;
    }
    switch (message.type) {
      case 'status':
        useChat.setState({ status: message.status });
        break;
      case 'presence':
        useChat.setState((state) => ({
          presence: { ...state.presence, [message.userId]: message.online },
        }));
        break;
      case 'prefs':
        useChat.setState({ privacy: message.privacy, blocked: message.blocked });
        break;
      default:
        remote.handle(message);
    }
  };

  void navigator.locks
    .request(LOCK, { signal: controller.signal }, async () => {
      if (stopped) return;
      useChat.setState({ role: 'starting' });
      try {
        leader = await startLeader(post, revoked);
      } catch (error) {
        useChat.setState({
          role: 'follower',
          error: error instanceof Error ? error.message : 'PingDost could not start',
        });
        return;
      }
      if (stopped) {
        await leader.stop();
        leader = undefined;
        return;
      }
      useChat.setState({ client: leader.client, role: 'leader' });
      post({ type: 'leader', tab });
      const removeNotices = installNotices(leader.client);
      // Held until this tab stops.
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      removeNotices();
      await leader.stop();
      leader = undefined;
    })
    .catch(() => undefined); // aborted on stop

  const stop = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    release?.();
    remote.dispose();
    channel.close();
    useChat.setState({ client: null, role: 'waiting' });
  };
  const unsubscribe = onSignedOut(stop);
  return () => {
    unsubscribe();
    stop();
  };
}

/** Tells the leader tab that privacy settings or blocks changed (from this tab). */
export function prefsChanged(): void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage({ type: 'prefs_changed' } satisfies BusMessage);
  channel.close();
}
