// Profile avatars (ADR 0008 point 7): pick an image, upload it to Cloudinary with a
// server-signed request, then save its `secure_url` with `PATCH /v1/me`. Avatars are public
// profile pictures, not chat content. The server answers 503 when Cloudinary is not set up.
import * as ImagePicker from 'expo-image-picker';

import { api } from '@/api';
import { errorCode } from '@/api/errors';

export class AvatarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AvatarError';
  }
}

/** Whether the server can sign avatar uploads (Cloudinary configured). */
export async function avatarUploadsEnabled(): Promise<boolean> {
  try {
    await api.account.signAvatarUpload();
    return true;
  } catch (error) {
    if (errorCode(error) === 'UNAVAILABLE') return false;
    throw error;
  }
}

/** Lets the user pick a square image and uploads it; null if they cancelled. */
export async function pickAndUploadAvatar(): Promise<string | null> {
  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.85,
  });
  const asset = picked.canceled ? undefined : picked.assets[0];
  if (!asset) return null;

  const signature = await api.account.signAvatarUpload();
  if (asset.fileSize !== undefined && asset.fileSize > signature.maxBytes) {
    const limit = Math.floor(signature.maxBytes / 1_048_576);
    throw new AvatarError(`Pick an image under ${limit} MB.`);
  }

  const form = new FormData();
  for (const [name, value] of Object.entries(signature.fields)) form.append(name, value);
  // React Native's FormData takes a file as { uri, name, type }.
  form.append('file', {
    uri: asset.uri,
    name: asset.fileName ?? 'avatar.jpg',
    type: asset.mimeType ?? 'image/jpeg',
  } as unknown as Blob);

  let response: Response;
  try {
    response = await fetch(signature.uploadUrl, { method: 'POST', body: form });
  } catch {
    throw new AvatarError("Can't reach the image service. Check your connection.");
  }
  const body = (await response.json().catch(() => ({}))) as { secure_url?: unknown };
  if (!response.ok || typeof body.secure_url !== 'string') {
    throw new AvatarError('The image upload failed. Try another image.');
  }
  return body.secure_url;
}
