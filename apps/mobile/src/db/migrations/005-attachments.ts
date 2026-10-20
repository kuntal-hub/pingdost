// Migration 005: attachment messages (Phase 14, ADR 0017).
// - messages.attachment: the checked manifest of a `kind = 'attachment'` message as JSON
//   (`AttachmentInfo`, file key included), null otherwise. The SQLCipher file encrypts it like
//   the message text. 002's `attachments` table stays for the local copy (Phase 15).
export const ATTACHMENTS_SCHEMA = `
  ALTER TABLE messages ADD COLUMN attachment TEXT;
`;
