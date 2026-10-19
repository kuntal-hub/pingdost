/** Captures raw WebSocket frames, for the "ciphertext only" check (REQ §19.1). */
import type { WebSocketFactory, WebSocketLike } from '@pingdost/transport';

/** A socket factory (Node's global WebSocket) that records every frame sent and received. */
export function capturingSocket(frames: Uint8Array[]): WebSocketFactory {
  return (url) => {
    const socket = new WebSocket(url);
    socket.addEventListener('message', (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) frames.push(new Uint8Array(event.data.slice(0)));
    });
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      if (data instanceof ArrayBuffer) frames.push(new Uint8Array(data.slice(0)));
      send(data);
    };
    return socket as unknown as WebSocketLike;
  };
}

const encoder = new TextEncoder();

/** Whether `bytes` contains `marker` as UTF-8 anywhere. */
export function containsMarker(bytes: Uint8Array, marker: string): boolean {
  const needle = encoder.encode(marker);
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
