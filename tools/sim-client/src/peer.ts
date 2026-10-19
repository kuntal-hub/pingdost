/**
 * An echo peer for device checks (Phases 10–11): a headless PingDost user with real E2EE that
 * shows as online, reads every message (read receipts on), types for a moment, then answers
 * with "echo: <text>" and logs the states of its replies. Start it, then open a chat with the
 * printed username on the phone. Messages starting with a command also exercise Phase 11:
 * - `!react …`: it reacts 👍 to your message;
 * - `!edit …`: it edits its echo a few seconds later;
 * - `!delete …`: it deletes its echo for everyone a few seconds later.
 * It logs your edits, deletes and reactions as they arrive.
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
    receipts: () => true,
  });
  await peer.start();
  // Online for anyone who watches (the app watches the open chat's peer).
  peer.transport.setPresence(true);
  console.log(`echo peer ready: username ${peer.username} (user ${peer.userId})`);

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const answered = new Set<string>();
  const watched = new Set<string>();
  peer.engine.onConversationListChanged(() => {
    void (async () => {
      for (const conversation of await peer.engine.listConversations()) {
        const { conversationId } = conversation;
        if (!watched.has(conversationId)) {
          watched.add(conversationId);
          peer.engine.subscribe(conversationId, (event) => {
            if (event.type !== 'message' || event.message.direction !== 'out') return;
            const { message } = event;
            if (message.kind === 'deleted')
              console.log(`  deleted for everyone: ${message.messageId}`);
            const reactions = message.reactions.filter((r) => r.userId !== peer.userId);
            if (reactions.length > 0) {
              console.log(
                `  reactions on ${message.messageId.slice(-6)}: ${reactions.map((r) => r.emoji ?? '(none)').join(' ')}`,
              );
            }
          });
        }
        const [latest] = await peer.engine.listMessages(conversationId, { limit: 5 });
        if (latest?.direction === 'in' && latest.editId && !answered.has(latest.editId)) {
          answered.add(latest.editId);
          console.log(`  edited by them: ${latest.body}`);
        }
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
          await peer.engine.markRead(conversationId);
          const command = /^!(react|edit|delete)\b/.exec(message.body)?.[1];
          if (command === 'react') await peer.engine.react(message.messageId, '👍');
          await peer.engine.setTyping(conversationId, true);
          await wait(2_500);
          const reply = await peer.engine.sendText(conversationId, `echo: ${message.body}`, {
            replyTo: message.messageId,
          });
          console.log(`→ echo (${reply.messageId})`);
          if (command === 'edit') {
            await wait(3_000);
            await peer.engine.editMessage(reply.messageId, `echo (edited): ${message.body}`);
            console.log('→ edited the echo');
          } else if (command === 'delete') {
            await wait(3_000);
            await peer.engine.deleteForEveryone(reply.messageId);
            console.log('→ deleted the echo for everyone');
          }
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
