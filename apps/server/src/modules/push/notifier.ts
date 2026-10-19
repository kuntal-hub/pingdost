/**
 * Content-free push wakes (ARCHITECTURE A2): `{"t":"wake"}` makes an offline device connect
 * and fetch its mailbox. Phase 12 adds the FCM and Web Push adapters; until then wakes are
 * dropped.
 */
export interface PushNotifier {
  /** Best effort and coalesced per device; never carries message data. */
  wake(deviceId: string, urgent: boolean): void;
}

export const noopPushNotifier: PushNotifier = { wake: () => undefined };
