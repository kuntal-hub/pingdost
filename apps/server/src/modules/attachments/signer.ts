/**
 * Signed URLs for the `fs` store (ADR 0017): HMAC-SHA256 with the server pepper over the
 * purpose, the attachment, the part or device, and the expiry. No custom cryptography; the
 * signature check is constant-time.
 */
import type { Hasher } from '../../infra/secrets';
import { safeEqual } from '../../infra/secrets';

export class UrlSigner {
  constructor(
    private readonly hasher: Hasher,
    /** `PUBLIC_API_URL`, without a trailing slash. */
    private readonly base: string,
  ) {}

  uploadUrl(id: string, index: number, expiresAt: number): string {
    const sig = this.hasher.hash('attachment-upload', `${id}:${index}:${expiresAt}`);
    return `${this.base}/v1/attachments/${id}/parts/${index}?exp=${expiresAt}&sig=${sig}`;
  }

  downloadUrl(id: string, deviceId: string, expiresAt: number): string {
    const sig = this.hasher.hash('attachment-download', `${id}:${deviceId}:${expiresAt}`);
    return `${this.base}/v1/attachments/${id}/blob?device=${deviceId}&exp=${expiresAt}&sig=${sig}`;
  }

  /** Whether an upload URL's signature holds and it has not expired. */
  checkUpload(id: string, index: number, exp: number, sig: string, now: number): boolean {
    return (
      exp > now && safeEqual(sig, this.hasher.hash('attachment-upload', `${id}:${index}:${exp}`))
    );
  }

  checkDownload(id: string, deviceId: string, exp: number, sig: string, now: number): boolean {
    return (
      exp > now &&
      safeEqual(sig, this.hasher.hash('attachment-download', `${id}:${deviceId}:${exp}`))
    );
  }
}
