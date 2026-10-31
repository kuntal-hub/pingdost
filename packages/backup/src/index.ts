// @pingdost/backup: the encrypted, user-held backup and the phone-change crypto (REQ §6.3,
// ADR 0022). Nothing here talks to the server: the file goes wherever the user saves it.
export { BackupError, type BackupErrorCode } from './errors';
export {
  BACKUP_EXTENSION,
  BACKUP_FORMAT_VERSION,
  BACKUP_MIME_TYPE,
  backupFileName,
  decodeHeader,
  DEFAULT_KDF_PARAMS,
  HEADER_LENGTH,
  type BackupHeader,
} from './format';
export {
  defaultRandomBytes,
  generatePhrase,
  isPhraseWord,
  normalizePhrase,
  PHRASE_WORDS,
  phraseEntropy,
  quizPositions,
  suggestWords,
  type RandomBytes,
} from './phrase';
export type { BackupManifest, BackupRecord } from './records';
export {
  exportToBackup,
  restoreFromBackup,
  type BackupFileSource,
  type ExportCounts,
  type ExportOptions,
  type RestoreFileSink,
  type RestoreOptions,
  type RestoreResult,
} from './store';
export {
  approveTransfer,
  openTransferApproval,
  TransferError,
  transferCode,
  transferOneTimeKey,
} from './transfer';
export {
  BackupReader,
  BackupWriter,
  memorySink,
  memorySource,
  type BackupItem,
  type BackupSink,
  type BackupSource,
  type WriterOptions,
} from './stream';
