// Migration 003: chat features (Phase 11, ADR 0014).
// - conversations: local pin, archive and mute.
// - messages: the shown edit, the delete-for-everyone time, the read time (read receipts),
//   reactions as JSON (one entry per user).
// - message_ops: edits, deletes and reactions waiting for their target message.
// - messages_fts is rebuilt as an FTS5 index keyed on the messages rowid and kept in step by
//   triggers, so every write path (edits, deletes, wipes) updates it. Words keep combining
//   marks (`M*`), so Devanagari vowel signs stay inside words. Like every table here, it is
//   inside the SQLCipher-encrypted file. Messages must be upserted (ON CONFLICT DO UPDATE),
//   never INSERT OR REPLACE, which would change the rowid without firing the delete trigger.
// Incoming messages from before this migration count as read: no late read receipts.
export const CHAT_FEATURES_SCHEMA = `
  ALTER TABLE conversations ADD COLUMN pinned_at INTEGER;
  ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE conversations ADD COLUMN muted_until INTEGER;

  ALTER TABLE messages ADD COLUMN edited_at INTEGER;
  ALTER TABLE messages ADD COLUMN edit_id TEXT;
  ALTER TABLE messages ADD COLUMN deleted_at INTEGER;
  ALTER TABLE messages ADD COLUMN read_at INTEGER;
  ALTER TABLE messages ADD COLUMN reactions TEXT NOT NULL DEFAULT '[]';
  UPDATE messages SET read_at = created_at WHERE direction = 'in';
  CREATE INDEX messages_unread ON messages (conversation_id, sort_at)
    WHERE direction = 'in' AND read_at IS NULL;

  CREATE TABLE message_ops (
    op_id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL,
    target_message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    body TEXT NOT NULL,
    remove INTEGER NOT NULL,
    received_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX message_ops_by_target ON message_ops (target_message_id);
  CREATE INDEX message_ops_by_conversation ON message_ops (conversation_id);
  CREATE INDEX message_ops_by_age ON message_ops (received_at);

  DROP TABLE messages_fts;
  CREATE VIRTUAL TABLE messages_fts USING fts5(
    body,
    tokenize = "unicode61 remove_diacritics 2 categories 'L* N* Co M*'"
  );
  INSERT INTO messages_fts (rowid, body) SELECT rowid, body FROM messages WHERE kind = 'text';
  CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages WHEN new.kind = 'text' BEGIN
    INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
  END;
  CREATE TRIGGER messages_fts_update AFTER UPDATE OF body, kind ON messages
    WHEN old.body IS NOT new.body OR old.kind IS NOT new.kind BEGIN
    DELETE FROM messages_fts WHERE rowid = old.rowid;
    INSERT INTO messages_fts (rowid, body) SELECT new.rowid, new.body WHERE new.kind = 'text';
  END;
  CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.rowid;
  END;
`;
