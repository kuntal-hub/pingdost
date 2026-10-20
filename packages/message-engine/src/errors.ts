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
