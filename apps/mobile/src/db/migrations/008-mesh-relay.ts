// Migration 008: the mesh relay (Phase 23, ADR 0025).
// - delivery_state.relays: mesh relays that accepted an outgoing message from this phone
//   ("Forwarded by N devices — not yet delivered"); NULL otherwise. `via` may now be `mesh`.
// - mesh_relay_packets: other people's encrypted packets this phone carries (REQ §11.4). Kept
//   apart from chat history, so "Clear relay cache" deletes only these rows (REQ §14.3). The
//   payload is the relayed MeshEnvelope: ciphertext only, no device IDs. seen_mesh_packets
//   (migration 002) holds the IDs of packets taken, until they expire.
export const MESH_RELAY_SCHEMA = `
  ALTER TABLE delivery_state ADD COLUMN relays INTEGER;

  CREATE TABLE mesh_relay_packets (
    packet_id TEXT PRIMARY KEY NOT NULL,
    dst TEXT NOT NULL,
    origin TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    hop_budget INTEGER NOT NULL,
    copies INTEGER NOT NULL,
    flags INTEGER NOT NULL,
    size INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    payload BLOB NOT NULL
  ) STRICT;
  CREATE INDEX mesh_relay_packets_by_expiry ON mesh_relay_packets (expires_at);
`;
