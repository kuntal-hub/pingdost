// Migration 007: direct nearby messaging (Phase 22, ADR 0024).
// - delivery_state.via: the path that carried an outgoing message to each device's next hop
//   (`internet` or `nearby`), shown in message info. NULL until a next hop accepted it, and
//   for rows from before this migration.
export const NEARBY_SCHEMA = `
  ALTER TABLE delivery_state ADD COLUMN via TEXT;
`;
