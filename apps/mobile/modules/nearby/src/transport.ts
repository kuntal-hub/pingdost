// REQ §11.2's `NearbyTransport` (`@pingdost/transport`) over the BLE module. The message
// engine's `NearbyPeerTransport` runs on it (ADR 0024); packets are already E2EE envelopes
// then, so this layer never looks inside them.
import type {
  NearbyTransport,
  PeerConnection,
  PeerDescriptor,
  Unsubscribe,
} from '@pingdost/transport';

import { parseInbound } from './inbound';
import type { LinkDownEvent, LinkInfo, NearbyNative, PeerInfo, StartOptions } from './types';

export type { PeerConnection, PeerDescriptor, Unsubscribe };

export interface BleTransport extends NearbyTransport {
  startDiscovery(options?: StartOptions): Promise<void>;
  onPeer(handler: (peer: PeerDescriptor & { rssi: number }) => void): Unsubscribe;
  onDisconnect(handler: (event: LinkDownEvent) => void): Unsubscribe;
  /** Stops listening (the native engine keeps running until `stopDiscovery`). */
  dispose(): void;
}

/** Bytes taken from the native queue per crossing. */
const RECEIVE_BATCH_BYTES = 256 * 1024;

function connectionOf(link: LinkInfo): PeerConnection {
  return { linkId: link.id, peer: { address: link.address, token: link.peerToken }, mtu: link.mtu };
}

export function createBleTransport(native: NearbyNative): BleTransport {
  const packetHandlers = new Set<(packet: Uint8Array, from: PeerConnection) => void>();
  const peerHandlers = new Set<(peer: PeerDescriptor & { rssi: number }) => void>();
  const connectionHandlers = new Set<(connection: PeerConnection) => void>();
  const disconnectHandlers = new Set<(event: LinkDownEvent) => void>();
  const connections = new Map<number, PeerConnection>();

  const add = <T>(set: Set<T>, handler: T): Unsubscribe => {
    set.add(handler);
    return () => set.delete(handler);
  };

  // Packets queued while JS was busy or reloading are taken here; the native side sends no
  // further `packet` event until its queue has been emptied once.
  const drain = () => {
    for (;;) {
      const batch = native.receive(RECEIVE_BATCH_BYTES);
      if (batch.length === 0) return;
      for (const { linkId, data } of parseInbound(batch)) {
        const from = connections.get(linkId) ?? {
          linkId,
          peer: { address: '', token: null },
          mtu: 0,
        };
        packetHandlers.forEach((handler) => {
          try {
            handler(data, from);
          } catch (error) {
            // Keep draining; report the handler's error outside this loop.
            queueMicrotask(() => {
              throw error;
            });
          }
        });
      }
    }
  };

  const subscriptions = [
    native.addListener('packet', drain),
    native.addListener('linkUp', (link) => {
      const connection = connectionOf(link);
      connections.set(link.id, connection);
      connectionHandlers.forEach((handler) => handler(connection));
    }),
    native.addListener('linkDown', (event) => {
      connections.delete(event.id);
      disconnectHandlers.forEach((handler) => handler(event));
    }),
    native.addListener('peerDiscovered', (peer: PeerInfo) => {
      peerHandlers.forEach((handler) =>
        handler({ address: peer.address, token: peer.token, rssi: peer.rssi }),
      );
    }),
  ];

  // Links that came up before this transport existed (a JS reload keeps native links): they
  // are reported as new, so the layer above handshakes on them again.
  void native.getState().then((state) => {
    for (const link of state.links) {
      if (!link.up || connections.has(link.id)) continue;
      const connection = connectionOf(link);
      connections.set(link.id, connection);
      connectionHandlers.forEach((handler) => handler(connection));
    }
    drain();
  });

  return {
    startDiscovery: (options = {}) => native.start(options),
    stopDiscovery: () => native.stop(),
    async connect(peer) {
      const connection = connectionOf(await native.connect(peer.address));
      connections.set(connection.linkId, connection);
      return connection;
    },
    disconnect: (connection) => native.disconnect(connection.linkId),
    send: (connection, packet) => native.send(connection.linkId, packet),
    onPacket: (handler) => add(packetHandlers, handler),
    onPeer: (handler) => add(peerHandlers, handler),
    onConnection: (handler) => add(connectionHandlers, handler),
    onDisconnect: (handler) => add(disconnectHandlers, handler),
    dispose() {
      subscriptions.forEach((subscription) => subscription.remove());
      packetHandlers.clear();
      peerHandlers.clear();
      connectionHandlers.clear();
      disconnectHandlers.clear();
    },
  };
}
