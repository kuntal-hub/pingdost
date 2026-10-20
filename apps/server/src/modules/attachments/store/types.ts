/**
 * Where staged ciphertext lives (ADR 0017): `fs` on the VPS disk (production), or `s3` (R2,
 * or SeaweedFS locally). Both hand out short-lived signed URLs; neither ever sees a key.
 */
export interface StagedPart {
  index: number;
  size: number;
}

export interface AttachmentStore {
  readonly kind: 'fs' | 's3';
  /** Prepares an upload; returns the store's multipart upload ID (s3) or undefined (fs). */
  begin(id: string): Promise<string | undefined>;
  /** A URL to `PUT` part `index` to, valid until `expiresAt`. */
  uploadUrl(
    id: string,
    uploadId: string | undefined,
    index: number,
    expiresAt: number,
  ): Promise<string>;
  /** The parts received so far. */
  listParts(id: string, uploadId: string | undefined): Promise<StagedPart[]>;
  /**
   * Joins the parts into the final object, streaming, and returns its size and SHA-256. The
   * object is downloadable only after the caller checked both.
   */
  complete(
    id: string,
    uploadId: string | undefined,
    partCount: number,
  ): Promise<{ size: number; sha256: Buffer }>;
  /** A URL to `GET` the object, valid until `expiresAt`; bound to the device it is for. */
  downloadUrl(id: string, deviceId: string, expiresAt: number): Promise<string>;
  /** Deletes the object, its parts and any unfinished upload. Idempotent. */
  delete(id: string, uploadId: string | undefined): Promise<void>;
  /**
   * Deletes leftovers older than `before` that `known` does not claim (a crash between a
   * store write and its record). Returns how many were deleted.
   */
  sweep(before: number, known: (id: string) => Promise<boolean>): Promise<number>;
}
