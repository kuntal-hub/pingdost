/**
 * An echo peer for device checks (Phase 10): a headless PingDost user with real E2EE that
 * shows as online, types for a moment, then answers every message with "echo: <text>" and logs
 * the states of its replies. Start it, then open a chat with the printed username on the phone.
 *
 *   pnpm --filter @pingdost/sim-client peer [--api http://127.0.0.1:3000] [--offline-after 0]
 *
 * With `--offline-after N` it disconnects N seconds after start (to test queued delivery) and
 * reconnects when Enter is pressed.
 */
import { parseArgs } from 'node:util';

import { createWasmCryptoProvider } from '@pingdost/crypto';

import { SimClient } from './client';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:3000' },
    mailpit: { type: 'string', default: 'http://127.0.0.1:8025' },
    'offline-after': { type: 'string', default: '0' },
  },
});
const api = values.api.replace(/\/+$/, '');

async function main(): Promise<void> {
  const crypto = await createWasmCryptoProvider();
  const peer = await SimClient.register({
    endpoints: { api, ws: `${api.replace(/^http/, 'ws')}/v1/ws`, mailpit: values.mailpit },
    crypto,
  });
  await peer.start();
  // Online for anyone who watches (the app watches the open chat's peer).
  peer.transport.setPresence(true);
  console.log(`echo peer ready: username ${peer.username} (user ${peer.userId})`);

  const answered = new Set<string>();
  peer.engine.onConversationListChanged(() => {
    void (async () => {
      for (const conversation of await peer.engine.listConversations()) {
        const [latest] = await peer.engine.listMessages(conversation.conversationId, { limit: 5 });
        for (const message of latest ? [latest] : []) {
          if (
            message.direction !== 'in' ||
            message.kind !== 'text' ||
            answered.has(message.messageId)
          ) {
            continue;
          }
          answered.add(message.messageId);
          console.log(`← ${message.body}`);
          await peer.engine.setTyping(conversation.conversationId, true);
          await new Promise((resolve) => setTimeout(resolve, 2_500));
          const reply = await peer.engine.sendText(
            conversation.conversationId,
            `echo: ${message.body}`,
          );
          console.log(`→ echo (${reply.messageId})`);
        }
      }
    })();
  });
  peer.engine.onEvent((event) => console.log(`event: ${event.type}`));
  setInterval(() => {
    void (async () => {
      for (const conversation of await peer.engine.listConversations()) {
        for (const m of await peer.engine.listMessages(conversation.conversationId, { limit: 3 })) {
          if (m.direction === 'out') console.log(`  state ${m.messageId.slice(-6)}: ${m.state}`);
        }
      }
    })();
  }, 5_000).unref();

  const offlineAfter = Number(values['offline-after']);
  if (offlineAfter > 0) {
    setTimeout(() => {
      peer.transport.stop();
      console.log('peer offline — press Enter to reconnect');
      process.stdin.once('data', () => {
        peer.transport.start();
        console.log('peer online');
      });
    }, offlineAfter * 1000);
  }
}

main().catch((error: unknown) => {
  console.error(`peer failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
