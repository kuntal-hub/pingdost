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
 *
 * Calls (Phase 25, ADR 0028): it answers incoming voice and video calls after
 * `--answer-after` seconds (default 1; a negative value declines them) and sends back what it
 * receives (werift echo), so the caller hears and sees itself. `--relay` forces TURN on its
 * side; `--dial-user <user ID> [--video]` calls that user 5 s after start. `--calls false`
 * turns this off. It agrees to every request to switch to video (ADR 0037). During a call,
 * chat messages drive its side: `!video` asks you to switch to video, `!voice` switches back,
 * `!share` / `!unshare` mark its (echoed) picture as a shared screen.
 *
 * Circles (Phase 37): it accepts every circle request within a few seconds, so open a chat
 * with it after adding it to your circle. `--dial-user` first asks that user into its circle
 * and calls once they accept.
 *
 * Files and voice notes (Phase 40): it downloads and decrypts each one, checks its size and that
 * audio is a real MP4 file, logs the duration and waveform, and replies with what it got.
 */
import { parseArgs } from 'node:util';

import { attachmentsApi, circlesApi } from '@pingdost/api-client';
import { decryptStream } from '@pingdost/attachments';
import { createWasmCryptoProvider } from '@pingdost/crypto';
import { attachmentDecryptInput, type MessageRecord } from '@pingdost/message-engine';

import { simCalls } from './calls';
import { SimClient } from './client';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:3000' },
    mailpit: { type: 'string', default: 'http://127.0.0.1:8025' },
    'offline-after': { type: 'string', default: '0' },
    calls: { type: 'string', default: 'true' },
    'answer-after': { type: 'string', default: '1' },
    relay: { type: 'boolean', default: false },
    'dial-user': { type: 'string' },
    video: { type: 'boolean', default: false },
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
  const circles = circlesApi(peer.api);
  // Accepts every circle request (Phase 37); the server tells online sockets, a poll is simpler.
  const acceptAll = async () => {
    try {
      for (const request of (await circles.requests()).incoming) {
        await circles.accept(request.userId);
        console.log(`circle: accepted @${request.username ?? request.userId}`);
      }
    } catch (error) {
      console.log(`circle check failed: ${String(error)}`);
    }
  };
  // Every 5 s: the server allows 300 circle reads per 15 minutes per IP, and every local client
  // (this peer, the emulator, the browser) shares 127.0.0.1. Every 2 s used them all up.
  setInterval(() => void acceptAll(), 5_000).unref();
  void acceptAll();
  let calls: ReturnType<typeof simCalls> | undefined;
  if (values.calls !== 'false') {
    calls = simCalls(peer, {
      answerAfterMs: Number(values['answer-after']) * 1_000,
      relayOnly: values.relay,
    });
    console.log(`answers calls${values.relay ? ' (relay forced)' : ''}`);
    const dialUser = values['dial-user'];
    if (dialUser) {
      // Calls need the circle: ask, then wait for the accept.
      const linked = async () => (await circles.list()).some((m) => m.userId === dialUser);
      if ((await circles.request(dialUser)) !== 'linked') {
        console.log(`asked ${dialUser} into the circle; waiting for them to accept…`);
        while (!(await linked())) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      setTimeout(() => {
        console.log(`calling ${dialUser}…`);
        void calls?.dial(dialUser, { video: values.video }).catch((error: unknown) => {
          console.log(`call failed: ${String(error)}`);
        });
      }, 5_000);
    }
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Fetches, decrypts and checks a file from the user, then replies with what arrived. */
  async function openFile(conversationId: string, message: MessageRecord): Promise<void> {
    const info = message.attachment;
    if (!info) return;
    const bars = info.waveform ? Buffer.from(info.waveform, 'base64').length : 0;
    const seconds = info.durationMs ? `${(info.durationMs / 1_000).toFixed(1)} s` : 'no duration';
    console.log(
      `← file ${info.mimeType}, ${info.plaintextSize} bytes, ${seconds}, waveform ${bars} bars`,
    );
    let verdict: string;
    try {
      const files = attachmentsApi(peer.api);
      const { url } = await files.downloadUrl(info.attachmentId);
      const staged = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const pieces: Uint8Array[] = [];
      const source = (async function* () {
        await Promise.resolve();
        yield staged;
      })();
      for await (const piece of decryptStream(crypto, attachmentDecryptInput(info), source)) {
        pieces.push(piece);
      }
      await files.ack(info.attachmentId);
      const plain = Buffer.concat(pieces);
      // An MP4 file (AAC voice notes from Android) starts with a box whose type is "ftyp".
      const mp4 = plain.subarray(4, 8).toString('latin1') === 'ftyp';
      verdict =
        plain.length !== info.plaintextSize
          ? `size mismatch (${plain.length} bytes)`
          : info.mimeType.startsWith('audio/')
            ? mp4
              ? 'playable MP4 audio'
              : 'audio, but not MP4'
            : 'opened';
    } catch (error) {
      verdict = `could not open it: ${String(error)}`;
    }
    console.log(`  ${verdict}`);
    await peer.engine.markRead(conversationId);
    const what = info.durationMs ? `a ${seconds} voice note with ${bars} waveform bars` : 'a file';
    await peer.engine.sendText(conversationId, `echo: got ${what}, ${verdict}`, {
      replyTo: message.messageId,
    });
  }

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
          if (message.direction !== 'in' || answered.has(message.messageId)) continue;
          if (message.kind === 'attachment') {
            answered.add(message.messageId);
            await openFile(conversationId, message);
            continue;
          }
          if (message.kind !== 'text') continue;
          answered.add(message.messageId);
          console.log(`← ${message.body}`);
          await peer.engine.markRead(conversationId);
          // In-call commands (ADR 0037).
          const inCall = /^!(video|voice|share|unshare)\b/.exec(message.body)?.[1];
          if (inCall && calls) {
            const action =
              inCall === 'video'
                ? calls.requestVideo()
                : inCall === 'voice'
                  ? Promise.resolve(calls.switchToVoice())
                  : inCall === 'share'
                    ? calls.startScreenShare('screen')
                    : calls.stopScreenShare();
            await action.then(
              () => console.log(`  in call: ${inCall}`),
              (error: unknown) => console.log(`  in call: ${inCall} failed: ${String(error)}`),
            );
          }
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
