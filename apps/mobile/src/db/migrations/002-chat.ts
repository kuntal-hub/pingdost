// Migration 002: the chat tables (REQ §14.1, ARCHITECTURE A6, ADR 0011/0012).
// - The engine's store: conversations, messages, delivery_state, outbox, crypto_sessions,
//   device_directory (+ directory_devices to find a device's owner), seen_ids.
// - Entities later phases fill: group_memberships (13), attachments (14–15),
//   seen_mesh_packets (23), device_sync_state (18), and messages_fts (11, local search).
// - contacts: cached public profiles (username, display name, avatar URL).
// Olm state lives only as pickles (crypto_sessions.pickle, crypto_store); the whole file is
// SQLCipher-encrypted.
export const CHAT_SCHEMA = `
  CREATE TABLE conversations (
    conversation_id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    peer_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_message_id TEXT,
    unread_count INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE INDEX conversations_by_activity ON conversations (updated_at DESC);

  CREATE TABLE messages (
    message_id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,
    sender_device_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    reply_to TEXT,
    sent_at INTEGER NOT NULL,
    sort_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    state TEXT,
    expires_at INTEGER
  ) STRICT;
  CREATE INDEX messages_by_conversation ON messages (conversation_id, sort_at DESC, message_id DESC);
  CREATE INDEX messages_by_expiry ON messages (expires_at) WHERE expires_at IS NOT NULL;

  CREATE TABLE delivery_state (
    message_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    own INTEGER NOT NULL,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, device_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX delivery_state_by_device ON delivery_state (device_id, state);

  CREATE TABLE outbox (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL,
    message_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    content BLOB,
    packet BLOB,
    -- The item's other fields (purpose, recipients, …) as JSON.
    fields TEXT NOT NULL
  ) STRICT;
  CREATE INDEX outbox_by_age ON outbox (created_at);

  CREATE TABLE crypto_sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    device_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    identity_key TEXT NOT NULL,
    pickle TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_received_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX crypto_sessions_by_device ON crypto_sessions (device_id);

  CREATE TABLE device_directory (
    user_id TEXT PRIMARY KEY NOT NULL,
    account_identity_key TEXT,
    key_version INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    verified_identity_key TEXT,
    -- Verified devices with their signed fallback keys, as JSON.
    devices TEXT NOT NULL
  ) STRICT;
  CREATE TABLE directory_devices (
    device_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL
  ) STRICT;
  CREATE INDEX directory_devices_by_user ON directory_devices (user_id);

  CREATE TABLE seen_ids (
    id TEXT PRIMARY KEY NOT NULL,
    seen_at INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX seen_ids_by_time ON seen_ids (seen_at);

  CREATE TABLE contacts (
    user_id TEXT PRIMARY KEY NOT NULL,
    username TEXT,
    display_name TEXT,
    avatar_url TEXT,
    fetched_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE group_memberships (
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  ) STRICT;

  CREATE TABLE attachments (
    attachment_id TEXT PRIMARY KEY NOT NULL,
    message_id TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    local_path TEXT,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX attachments_by_message ON attachments (message_id);

  -- Bounded and expiring (REQ §11.4); separate from chat history (REQ §14.3).
  CREATE TABLE seen_mesh_packets (
    packet_id TEXT PRIMARY KEY NOT NULL,
    seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX seen_mesh_packets_by_expiry ON seen_mesh_packets (expires_at);

  CREATE TABLE device_sync_state (
    device_id TEXT PRIMARY KEY NOT NULL,
    synced_until INTEGER,
    cursor TEXT
  ) STRICT;

  CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED, body);
`;
