// Test helpers for engine users: the EngineStore contract suite (Vitest) and an in-memory
// fake server. Never imported by app code.
export {
  createTestClient,
  eventually,
  FakeApiError,
  FakeServer,
  FakeTransport,
} from './fake-server';
export type { TestClient, TestClientOptions } from './fake-server';
export {
  conversationRecord,
  messageRecord,
  runEngineStoreContract,
  testId,
} from './store-contract';
