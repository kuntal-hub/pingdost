// Test helpers (`@pingdost/transport/testing`): an in-memory nearby radio for
// `NearbyPeerTransport` tests here and the engine's routing tests.
import type { NearbyLinkDown, NearbyTransport, PeerConnection } from './nearby';
import { Listeners } from './stream';

/**
 * A tick later, in order. `setImmediate` where there is one (Node): `setTimeout(0)` waits for
 * the timer resolution (about 15 ms on Windows), which made file-transfer tests crawl.
 */
const later: (run: () => void) => void =
  typeof setImmediate === 'function'
    ? (run) => void setImmediate(run)
    : (run) => void setTimeout(run, 0);

export const fakeConnection = (linkId: number): PeerConnection => ({
  linkId,
  peer: { address: `AA:${linkId}`, token: null },
  mtu: 517,
});

/** One phone's radio. Links made with `connectFakeLinks` deliver in order, a tick later. */
export class FakeLinks implements NearbyTransport {
  readonly packets = new Listeners<[Uint8Array, PeerConnection]>();
  readonly connections = new Listeners<[PeerConnection]>();
  readonly disconnects = new Listeners<[NearbyLinkDown]>();
  readonly remotes = new Map<number, { other: FakeLinks; otherId: number }>();
  readonly sent: { linkId: number; packet: Uint8Array }[] = [];
  /** Link IDs this side closed. */
  readonly disconnected: number[] = [];
  discovering = false;
  /** Drop what this side sends (the radio failing). */
  mute = false;

  startDiscovery(): Promise<void> {
    this.discovering = true;
    return Promise.resolve();
  }

  stopDiscovery(): Promise<void> {
    this.discovering = false;
    for (const id of [...this.remotes.keys()]) this.drop(id);
    return Promise.resolve();
  }

  connect(): Promise<PeerConnection> {
    return Promise.reject(new Error('use connectFakeLinks'));
  }

  disconnect(connection: PeerConnection): Promise<void> {
    this.disconnected.push(connection.linkId);
    this.drop(connection.linkId);
    return Promise.resolve();
  }

  send(connection: PeerConnection, packet: Uint8Array): Promise<void> {
    const remote = this.remotes.get(connection.linkId);
    if (!remote) return Promise.reject(new Error('link_down'));
    this.sent.push({ linkId: connection.linkId, packet });
    if (!this.mute) {
      later(() => {
        if (remote.other.remotes.has(remote.otherId)) {
          remote.other.packets.emit(packet, fakeConnection(remote.otherId));
        }
      });
    }
    return Promise.resolve();
  }

  onPacket(handler: (packet: Uint8Array, from: PeerConnection) => void): () => void {
    return this.packets.add(handler);
  }

  onConnection(handler: (connection: PeerConnection) => void): () => void {
    return this.connections.add(handler);
  }

  onDisconnect(handler: (event: NearbyLinkDown) => void): () => void {
    return this.disconnects.add(handler);
  }

  /** The link goes down on both ends (out of range). */
  drop(linkId: number): void {
    const remote = this.remotes.get(linkId);
    if (!remote) return;
    this.remotes.delete(linkId);
    remote.other.remotes.delete(remote.otherId);
    this.disconnects.emit({ id: linkId, reason: 'link_down', unsent: 0 });
    remote.other.disconnects.emit({ id: remote.otherId, reason: 'link_down', unsent: 0 });
  }

  /** Drops every link (e.g. this phone walked away). */
  dropAll(): void {
    for (const id of [...this.remotes.keys()]) this.drop(id);
  }
}

let nextLinkId = 1;

/** Two phones in range: a link comes up on both, as the BLE module's `linkUp`. */
export function connectFakeLinks(a: FakeLinks, b: FakeLinks): [number, number] {
  const idA = nextLinkId++;
  const idB = nextLinkId++;
  a.remotes.set(idA, { other: b, otherId: idB });
  b.remotes.set(idB, { other: a, otherId: idA });
  a.connections.emit(fakeConnection(idA));
  b.connections.emit(fakeConnection(idB));
  return [idA, idB];
}
