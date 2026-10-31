// @pingdost/transport: the transport-neutral interface, the gateway WebSocket transport, the
// nearby transport and the router (REQ §4.3, §11.2, ARCHITECTURE A4, ADR 0024).
export { backoffDelay } from './backoff';
export type { BackoffOptions } from './backoff';
export { NearbyPeerTransport } from './nearby';
export type {
  HelloCheck,
  NearbyIdentity,
  NearbyLinkDown,
  NearbyPeer,
  NearbyPeerTransportOptions,
  NearbySummary,
  NearbyTransport,
  PeerConnection,
  PeerDescriptor,
} from './nearby';
export { TransportRouter } from './router';
export { Listeners, ValueStream } from './stream';
export type { ReadonlyValueStream } from './stream';
export type * from './types';
export { WS_CLOSE_CODES, WsTransport } from './ws';
export type { WebSocketFactory, WebSocketLike, WsEvent, WsTransportOptions } from './ws';
