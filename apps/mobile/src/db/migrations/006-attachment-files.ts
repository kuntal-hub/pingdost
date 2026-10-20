// Migration 006: local attachment copies and transfers (Phase 15, ADR 0018).
// - attachments: one row per staged file of a message (the file and its thumbnail), with its
//   transfer and its encrypted local copy. The copy is the attachment's own STREAM ciphertext
//   in the app's files (`local_path`, relative to the vault folder); its key is the manifest
//   key in `messages.attachment`, so it stays inside this SQLCipher file. 002's table was
//   never written, so it is rebuilt.
//   `state`: pending (not fetched), transferring (queued or running), paused, failed (`error`
//   says why), gone (the server no longer has it), done, removed (the local copy was deleted).
//   `recipients`: an upload's devices as JSON, fixed when the server first accepts it.
// - Attachment captions join the search index.
export const ATTACHMENT_FILES_SCHEMA = `
  DROP TABLE attachments;
  CREATE TABLE attachments (
    attachment_id TEXT PRIMARY KEY NOT NULL,
    message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    direction TEXT NOT NULL,
    state TEXT NOT NULL,
    ciphertext_size INTEGER NOT NULL,
    transferred INTEGER NOT NULL DEFAULT 0,
    local_path TEXT,
    error TEXT,
    recipients TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX attachments_by_message ON attachments (message_id);
  CREATE INDEX attachments_by_conversation ON attachments (conversation_id, role);
  CREATE INDEX attachments_by_state ON attachments (state);

  DROP TRIGGER messages_fts_insert;
  DROP TRIGGER messages_fts_update;
  CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
    WHEN new.kind IN ('text', 'attachment') BEGIN
    INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
  END;
  CREATE TRIGGER messages_fts_update AFTER UPDATE OF body, kind ON messages
    WHEN old.body IS NOT new.body OR old.kind IS NOT new.kind BEGIN
    DELETE FROM messages_fts WHERE rowid = old.rowid;
    INSERT INTO messages_fts (rowid, body) SELECT new.rowid, new.body
      WHERE new.kind IN ('text', 'attachment');
  END;
  INSERT INTO messages_fts (rowid, body)
    SELECT rowid, body FROM messages WHERE kind = 'attachment' AND body <> '';
`;
