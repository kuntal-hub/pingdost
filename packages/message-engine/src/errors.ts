/** Why a history sync or a fetch from the phone could not run (ADR 0021). */
export class SyncError extends Error {
  constructor(
    /**
     * `no_phone`: this account lists no phone; `phone_offline` / `offline`: the phone or this
     * device is not connected; `timeout`: the phone did not answer; `missing`: the phone has
     * no copy of the file; `busy`: another sync is running here.
     */
    readonly code: 'no_phone' | 'phone_offline' | 'offline' | 'timeout' | 'missing' | 'busy',
    message: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

/** Why a message or group action was refused. */
export class MessageActionError extends Error {
  constructor(
    readonly code: 'not_found' | 'not_allowed' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'MessageActionError';
  }
}
