/** Why a backup could not be read. Messages are fixed: never phrase words or file contents. */
export type BackupErrorCode =
  /** The file does not start with the backup magic. */
  | 'not_a_backup'
  /** A newer (or unknown) format or KDF: update PingDost. */
  | 'unsupported_version'
  /** The phrase is not 24 valid words (unknown word or wrong checksum). */
  | 'invalid_phrase'
  /** The first chunk did not decrypt: almost always a different phrase, else a damaged file. */
  | 'wrong_phrase'
  /** The file ends early. */
  | 'truncated'
  /** Later data failed authentication, framing or the manifest checks. */
  | 'corrupt';

const MESSAGES: Record<BackupErrorCode, string> = {
  not_a_backup: 'This is not a PingDost backup file.',
  unsupported_version: 'This backup was made by a newer PingDost. Update the app and try again.',
  invalid_phrase: 'That is not a valid recovery phrase. Check each of the 24 words.',
  wrong_phrase: 'The recovery phrase does not open this backup, or the file is damaged.',
  truncated: 'The backup file is incomplete. Copy it again and retry.',
  corrupt: 'The backup file is damaged and cannot be restored.',
};

export class BackupError extends Error {
  constructor(readonly code: BackupErrorCode) {
    super(MESSAGES[code]);
    this.name = 'BackupError';
  }
}
