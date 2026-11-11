// Migration 010: forwarded messages (Phase 39, ADR 0043): 1 when the message was forwarded
// from someone else's (shown as "Forwarded").
export const FORWARDED_SCHEMA = `
  ALTER TABLE messages ADD COLUMN forwarded INTEGER NOT NULL DEFAULT 0;
`;
