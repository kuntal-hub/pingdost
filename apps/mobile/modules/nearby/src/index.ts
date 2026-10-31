// The local `PingdostNearby` Expo module (modules/nearby, Kotlin; Phase 21, ADR 0023): BLE
// discovery with a rotating random token, GATT links with framing and credit flow control, a
// native packet queue, and a `connectedDevice` foreground service. Android only for now.
import { requireOptionalNativeModule, type NativeModule } from 'expo';

import type { NearbyEvents, NearbyNative } from './types';

type PingdostNearbyModule = NativeModule<NearbyEvents> & Omit<NearbyNative, 'addListener'>;

/** Null in a build made before the module existed (rebuild the dev client), and on iOS/web. */
export const PingdostNearby = requireOptionalNativeModule<PingdostNearbyModule>(
  'PingdostNearby',
) as (PingdostNearbyModule & NearbyNative) | null;

export * from './types';
export { encodeInbound, parseInbound, type InboundPacket } from './inbound';
export {
  createBleTransport,
  type NearbyTransport,
  type PeerConnection,
  type PeerDescriptor,
  type Unsubscribe,
} from './transport';
