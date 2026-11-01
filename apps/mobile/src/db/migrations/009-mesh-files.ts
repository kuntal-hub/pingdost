// Migration 009: files over the mesh (Phase 24, ADR 0027).
// - mesh_relay_packets.kind / transfer / chunk_index: the relay store also carries file chunks
//   (`kind` = 'chunk', with the transfer's hex ID and the chunk index), else envelopes.
// - attachments.via: 'mesh' when the file travels over the nearby mesh instead of the server;
//   the upload/download runner leaves those rows to `nearby/files.ts`.
// - mesh_incoming / mesh_incoming_chunks: chunks of files coming to this phone, kept until the
//   whole file is assembled into the vault and verified (REQ §19.3). Ciphertext only.
export const MESH_FILES_SCHEMA = `
  ALTER TABLE mesh_relay_packets ADD COLUMN kind TEXT NOT NULL DEFAULT 'envelope';
  ALTER TABLE mesh_relay_packets ADD COLUMN transfer TEXT;
  ALTER TABLE mesh_relay_packets ADD COLUMN chunk_index INTEGER;

  ALTER TABLE attachments ADD COLUMN via TEXT;

  CREATE TABLE mesh_incoming (
    transfer_id TEXT PRIMARY KEY NOT NULL,
    chunk_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE mesh_incoming_chunks (
    transfer_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (transfer_id, chunk_index)
  ) STRICT;
`;
