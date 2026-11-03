// The local `PingdostNearby` Expo module (modules/nearby): BLE discovery with a rotating random
// token, GATT links with framing and credit flow control, and a native packet queue. Android
// (Kotlin; Phase 21, ADR 0023) adds a `connectedDevice` foreground service; iOS (Swift,
// CoreBluetooth; Phase 30, ADR 0033) speaks the same link protocol within Apple's background limits.
import { requireOptionalNativeModule, type NativeModule } from 'expo';

import type { NearbyEvents, NearbyNative } from './types';

type PingdostNearbyModule = NativeModule<NearbyEvents> & Omit<NearbyNative, 'addListener'>;

/** Null in a build made before the module existed (rebuild the dev client), and on web. */
export const PingdostNearby = requireOptionalNativeModule<PingdostNearbyModule>(
  'PingdostNearby',
) as (PingdostNearbyModule & NearbyNative) | null;

export * from './types';
export { encodeInbound, parseInbound, type InboundPacket } from './inbound';
export {
  createBleTransport,
  type BleTransport,
  type PeerConnection,
  type PeerDescriptor,
  type Unsubscribe,
} from './transport';
