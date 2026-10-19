// @pingdost/message-engine: the platform- and transport-neutral message engine (REQ §4.3,
// §8): outbox, REQ §8.3 states, retries, dedupe, multi-device fan-out, Olm sessions and repair,
// E2EE receipts. Storage is an `EngineStore`; SQLite (Android) and Dexie (web) implement it.
export { checkHeader, textContentFor } from './content';
export { DEFAULT_ENGINE_SETTINGS } from './core';
export type {
  ConversationEvent,
  EngineEvent,
  EngineLogger,
  EngineOptions,
  EngineSettings,
  EngineTransport,
} from './core';
export { diffDirectory, verifyDirectory } from './directory';
export type { DirectoryApi } from './directory';
export { MessageEngine } from './engine';
export type { ContactInfo } from './engine';
export {
  FALLBACK_KEY_MAX_AGE_MS,
  ONE_TIME_KEY_MINIMUM,
  ONE_TIME_KEY_TARGET,
  publishKeys,
  syncKeys,
} from './keys';
export type { PublishKeysDeps, PublishKeysResult, SyncKeysDeps } from './keys';
export { compareMessages, MemoryEngineStore } from './memoryStore';
export { advance, aggregateState, nextMessageState, SETTLED_STATES } from './states';
export type * from './store';
