// @pingdost/message-engine: the platform- and transport-neutral message engine (REQ §4.3,
// §8): outbox, REQ §8.3 states, retries, dedupe, multi-device fan-out, Olm sessions and repair,
// E2EE receipts. Storage is an `EngineStore`; SQLite (Android) and Dexie (web) implement it.
export { checkGroupHeader, checkHeader, textContentFor } from './content';
export { DEFAULT_ENGINE_SETTINGS } from './core';
export type {
  ConversationEvent,
  EngineEvent,
  EngineLogger,
  EngineOptions,
  EngineSettings,
  EngineTransport,
  GroupsApi,
} from './core';
export { diffDirectory, verifyDirectory } from './directory';
export type { DirectoryApi } from './directory';
export { MessageEngine } from './engine';
export type { ContactInfo } from './engine';
export { MessageActionError } from './errors';
export { GROUP_AVATAR_MAX_BYTES, GROUP_DESCRIPTION_MAX, GROUP_NAME_MAX } from './groups/content';
export type { GroupInfo } from './groups/manager';
export { groupNoticeBody, parseGroupNotice } from './groups/notices';
export type { GroupNotice } from './groups/notices';
export { applyControl, isAdmin, isMember, memberKey, reconcile, roleOf } from './groups/state';
export type { ControlInput, ControlResult, ServerView } from './groups/state';
export {
  applyOp,
  canDeleteForEveryone,
  canEdit,
  canReact,
  isValidReaction,
  MAX_REACTION_LENGTH,
  summarizeReactions,
} from './features/ops';
export type { Op, OpRules, ReactionSummary } from './features/ops';
export { foldText, ftsQuery, highlightRanges, matchesQuery, searchTerms } from './search';
export type { TextRange } from './search';
export {
  FALLBACK_KEY_MAX_AGE_MS,
  ONE_TIME_KEY_MINIMUM,
  ONE_TIME_KEY_TARGET,
  publishKeys,
  syncKeys,
} from './keys';
export type { PublishKeysDeps, PublishKeysResult, SyncKeysDeps } from './keys';
export { compareMessages, MemoryEngineStore } from './memoryStore';
export {
  advance,
  aggregateGroupState,
  aggregateState,
  nextGroupState,
  nextMessageState,
  SETTLED_STATES,
} from './states';
export { MUTED_FOREVER } from './store';
export type * from './store';
