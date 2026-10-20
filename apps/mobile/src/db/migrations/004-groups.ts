// Migration 004: group chats (Phase 13, ADR 0016).
// - groups: membership as this device knows it (from E2EE controls), the server's last view,
//   and the E2EE name, description and picture. Replaces 002's unused group_memberships.
// - group_sessions_out: this device's current Megolm session per group.
// - group_sessions_in: Megolm sessions received over Olm, keyed by the device that shared
//   them, with the message indices already accepted (replay check).
// - group_held: group messages waiting for their key, and keys waiting for their group.
// Megolm state is stored only as pickles; the file is SQLCipher-encrypted like the rest.
export const GROUPS_SCHEMA = `
  DROP TABLE group_memberships;

  CREATE TABLE groups (
    group_id TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL,
    members TEXT NOT NULL,
    server_version INTEGER NOT NULL,
    server_members TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    avatar BLOB,
    info_at INTEGER NOT NULL,
    info_id TEXT NOT NULL,
    left_group INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE group_sessions_out (
    group_id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    pickle TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    message_count INTEGER NOT NULL,
    shared_with TEXT NOT NULL,
    member_key TEXT NOT NULL
  ) STRICT;

  CREATE TABLE group_sessions_in (
    sender_device_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,
    sender_key TEXT NOT NULL,
    pickle TEXT NOT NULL,
    first_known_index INTEGER NOT NULL,
    seen_indices TEXT NOT NULL,
    shared_at TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (sender_device_id, session_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX group_sessions_in_by_group ON group_sessions_in (group_id);

  CREATE TABLE group_held (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    group_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,
    sender_device_id TEXT NOT NULL,
    payload BLOB NOT NULL,
    received_at INTEGER NOT NULL,
    requested_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX group_held_by_group ON group_held (group_id, received_at);
  CREATE INDEX group_held_by_age ON group_held (received_at);
`;
