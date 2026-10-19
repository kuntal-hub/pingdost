// The signed-in session as persisted in SecureStore: the token pair, the account summary,
// and the device the tokens are bound to (null until device setup binds them).
import { z } from 'zod';

import { AuthTokensSchema, AuthUserSchema, IdSchema } from '@pingdost/shared-types';

export const StoredSessionSchema = z.object({
  tokens: AuthTokensSchema,
  user: AuthUserSchema,
  deviceId: IdSchema.nullable(),
});
export type StoredSession = z.infer<typeof StoredSessionSchema>;

/** Persistence for the session. Tokens are secrets: never logged. */
export interface SessionStorage {
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}
