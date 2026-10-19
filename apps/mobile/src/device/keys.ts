// Key publishing moved into the message engine in Phase 9 (ADR 0011), so every client shares
// it. While the engine runs, top-ups go through `engine.replenishKeys()`; device setup (before
// the engine starts) calls `syncKeys` directly.
export {
  ONE_TIME_KEY_MINIMUM,
  ONE_TIME_KEY_TARGET,
  publishKeys,
  syncKeys,
  type PublishKeysDeps,
  type PublishKeysResult,
  type SyncKeysDeps,
} from '@pingdost/message-engine';
