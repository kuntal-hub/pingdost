/**
 * Signed avatar uploads to Cloudinary (ARCHITECTURE A2; signing rules checked 2026-10-19 at
 * cloudinary.com/documentation/authentication_signatures): the signed fields, sorted, joined
 * as `name=value` with `&`, followed by the API secret, then hashed (SHA-256, hex). `file`
 * and `api_key` are not signed. A signature is valid for one hour after `timestamp`.
 */
import { createHash } from 'node:crypto';

import type { AvatarUploadSignature } from '@pingdost/shared-types';

export interface CloudinarySettings {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/** Clients compress below this before uploading; Cloudinary stores at most 512×512. */
export const AVATAR_MAX_BYTES = 5 * 1_048_576;
const FORMATS = ['jpg', 'jpeg', 'png', 'webp'];

export function cloudinarySignature(params: Record<string, string>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join('&');
  return createHash('sha256')
    .update(toSign + apiSecret)
    .digest('hex');
}

/** Upload parameters for the user's single avatar (`avatars/<userId>`, overwritten in place). */
export function signAvatarUpload(
  settings: CloudinarySettings,
  userId: string,
  nowMs: number,
): AvatarUploadSignature {
  const params = {
    allowed_formats: FORMATS.join(','),
    invalidate: 'true',
    overwrite: 'true',
    public_id: `avatars/${userId}`,
    timestamp: String(Math.floor(nowMs / 1000)),
    transformation: 'c_limit,h_512,w_512',
  };
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${settings.cloudName}/image/upload`,
    fields: {
      ...params,
      api_key: settings.apiKey,
      signature: cloudinarySignature(params, settings.apiSecret),
    },
    maxBytes: AVATAR_MAX_BYTES,
  };
}

/** Whether `url` is the `secure_url` of this user's avatar in our cloud. */
export function isOwnAvatarUrl(settings: CloudinarySettings, userId: string, url: string): boolean {
  const cloud = settings.cloudName.replace(/[^a-z0-9_-]/gi, '');
  const pattern = new RegExp(
    `^https://res\\.cloudinary\\.com/${cloud}/image/upload/(?:v\\d+/)?avatars/${userId}\\.(?:${FORMATS.join('|')})$`,
  );
  return pattern.test(url);
}
