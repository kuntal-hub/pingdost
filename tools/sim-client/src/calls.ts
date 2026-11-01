/**
 * Calls for the headless sim client (ADR 0028): the shared `CallManager` on the engine's E2EE
 * signaling, with werift (MIT, pure TypeScript WebRTC) as the media stack. It has no camera
 * or microphone: it sends back whatever it receives (an echo), so a phone or browser hears
 * and sees itself once media really flows, direct or through TURN.
 */
import { RTCPeerConnection, type MediaStreamTrack, type RTCRtpTransceiver } from 'werift';

import { callsApi } from '@pingdost/api-client';
import {
  CallManager,
  type CallPeer,
  type CallPlatform,
  type CallSnapshot,
  type IceServer,
} from '@pingdost/call-engine';

import type { SimClient } from './client';

/** werift takes one URL per server, UDP TURN only. */
function weriftServers(
  servers: IceServer[],
): { urls: string; username?: string; credential?: string }[] {
  const out: { urls: string; username?: string; credential?: string }[] = [];
  for (const server of servers) {
    for (const url of Array.isArray(server.urls) ? server.urls : [server.urls]) {
      if (/transport=tcp/i.test(url) || url.startsWith('turns:')) continue;
      out.push({
        urls: url.replace(/\?.*$/, ''),
        ...(server.username ? { username: server.username } : {}),
        ...(server.credential ? { credential: server.credential } : {}),
      });
    }
  }
  return out;
}

function echo(transceiver: RTCRtpTransceiver): void {
  // werift answers recvonly when nothing is sending: the echo needs sendrecv (its README).
  transceiver.setDirection('sendrecv');
  transceiver.onTrack.subscribe((track: MediaStreamTrack) => {
    void transceiver.sender.replaceTrack(track);
  });
}

/** `PINGDOST_CALL_DEBUG=1`: how long each werift step takes. */
async function timed<T>(step: string, run: () => Promise<T>): Promise<T> {
  if (!process.env.PINGDOST_CALL_DEBUG) return run();
  const started = Date.now();
  try {
    return await run();
  } finally {
    console.log(`  [werift] ${step}: ${Date.now() - started} ms`);
  }
}

export function echoPlatform(client: SimClient): CallPlatform {
  const calls = callsApi(client.api);
  return {
    iceServers: async () => (await calls.turnCredentials()).iceServers,
    createPeer: (options, events) => {
      const pc = new RTCPeerConnection({
        iceServers: weriftServers(options.iceServers),
        iceTransportPolicy: options.relayOnly ? 'relay' : 'all',
      });
      pc.onRemoteTransceiverAdded.subscribe(echo);
      pc.onIceCandidate.subscribe((candidate) => {
        events.onIceCandidate(
          candidate
            ? {
                candidate: candidate.candidate,
                sdpMid: candidate.sdpMid ?? null,
                sdpMLineIndex: candidate.sdpMLineIndex ?? null,
              }
            : null,
        );
      });
      pc.connectionStateChange.subscribe((state) => events.onConnectionState(state));
      let transceivers = false;
      const peer: CallPeer = {
        createOffer: async (offerOptions) => {
          // Calling out: one echoing transceiver per kind, before the first offer.
          if (!transceivers) {
            transceivers = true;
            echo(pc.addTransceiver('audio', { direction: 'sendrecv' }));
            if (options.video) echo(pc.addTransceiver('video', { direction: 'sendrecv' }));
          }
          const offer = await timed('createOffer', () => pc.createOffer(offerOptions));
          return { type: 'offer', sdp: offer.sdp };
        },
        createAnswer: async () => {
          const answer = await timed('createAnswer', () => pc.createAnswer());
          return { type: 'answer', sdp: answer.sdp };
        },
        setLocalDescription: async (description) => {
          await timed('setLocalDescription', () =>
            pc.setLocalDescription(description as { type: 'offer' | 'answer'; sdp: string }),
          );
        },
        setRemoteDescription: (description) =>
          timed('setRemoteDescription', () =>
            pc.setRemoteDescription(description as { type: 'offer' | 'answer'; sdp: string }),
          ),
        addIceCandidate: (candidate) =>
          timed(`addIceCandidate ${candidate.candidate?.split(' ')[4] ?? ''}`, () =>
            pc.addIceCandidate({
              candidate: candidate.candidate ?? '',
              sdpMid: candidate.sdpMid ?? undefined,
              sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
            }),
          ),
        get localDescription() {
          const local = pc.localDescription;
          return local ? { type: local.type, sdp: local.sdp } : null;
        },
        get signalingState() {
          return pc.signalingState;
        },
        setMuted: () => undefined,
        setCameraOff: () => undefined,
        close: () => void pc.close(),
      };
      return Promise.resolve(peer);
    },
  };
}

export interface SimCallsOptions {
  /** Answer incoming calls after this many ms (default 1 s); negative: decline them. */
  answerAfterMs?: number;
  relayOnly?: boolean;
  log?: (line: string) => void;
}

/** A call manager for the sim client that answers (or declines) by itself and logs. */
export function simCalls(client: SimClient, options: SimCallsOptions = {}): CallManager {
  const log = options.log ?? ((line: string) => console.log(line));
  const manager = new CallManager({
    self: { userId: client.userId, deviceId: client.deviceId },
    signaling: {
      devices: (userId) => client.engine.callDevices(userId),
      send: (userId, deviceId, signal) => client.engine.sendCallSignal(userId, deviceId, signal),
      onSignal: (listener) => client.engine.onCallSignal(listener),
    },
    platform: echoPlatform(client),
    relayOnly: () => options.relayOnly ?? false,
    onEnded: (call) => {
      log(
        `call ${call.callId.slice(-6)} ended: ${call.outcome ?? '?'}${call.error ? ` (${call.error})` : ''}`,
      );
    },
  });
  let last: CallSnapshot['state'] | undefined;
  manager.onChange((call) => {
    if (!call || call.state === last) return;
    last = call.state;
    const setup =
      call.state === 'connected' && call.answeredAt !== null && call.connectedAt !== null
        ? ` (setup ${call.connectedAt - call.answeredAt} ms after the answer${call.relayOnly ? ', relay forced' : ''})`
        : '';
    log(
      `call ${call.callId.slice(-6)} ${call.direction} ${call.video ? 'video' : 'voice'}: ${call.state}${setup}`,
    );
    if (call.state === 'incoming') {
      const after = options.answerAfterMs ?? 1_000;
      setTimeout(() => void (after < 0 ? manager.reject() : manager.accept()), Math.abs(after));
    }
  });
  return manager;
}
