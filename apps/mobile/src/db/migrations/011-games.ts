// Migration 011: games inside chats (Phase 42, ADR 0049). `games` is one row per game (its
// seat secret stays here, never sent); `game_events` holds every event as protobuf (base64),
// listed by event ID (UUIDv7) for `@pingdost/games` to fold.
export const GAMES_SCHEMA = `
  CREATE TABLE games (
    game_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    game_type TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    seat_seed TEXT
  );
  CREATE INDEX games_by_conversation ON games (conversation_id);
  CREATE TABLE game_events (
    event_id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,
    sender_device_id TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX game_events_by_game ON game_events (game_id, event_id);
`;
