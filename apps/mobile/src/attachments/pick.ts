// Picking something to send (Phase 15): photos and videos from the gallery (the system photo
// picker; no storage permission), the camera, or any document. Each picker hands back its own
// copy in the app cache, which the send flow deletes once the file is encrypted.
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { create } from 'zustand';

import { makeDraft, type Draft } from './send';

export type PickSource = 'library' | 'photo' | 'video' | 'document';

export class PickError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PickError';
  }
}

async function fromImagePicker(result: ImagePicker.ImagePickerResult): Promise<Draft | null> {
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;
  return makeDraft({
    uri: asset.uri,
    name: asset.fileName ?? null,
    width: asset.width,
    height: asset.height,
    durationMs: asset.duration ?? null,
    temporary: true,
  });
}

/** Opens a picker; null when the user backed out. */
export async function pick(source: PickSource): Promise<Draft | null> {
  if (source === 'document') {
    const result = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      copyToCacheDirectory: true,
      multiple: false,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return null;
    return makeDraft({ uri: asset.uri, name: asset.name, temporary: true });
  }
  if (source === 'library') {
    return fromImagePicker(
      await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        quality: 1,
        exif: false,
        allowsMultipleSelection: false,
      }),
    );
  }
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new PickError('PingDost needs camera access for this. You can allow it in Settings.');
  }
  return fromImagePicker(
    await ImagePicker.launchCameraAsync({
      mediaTypes: source === 'photo' ? ['images'] : ['videos'],
      quality: 1,
      exif: false,
    }),
  );
}

/** The draft the send screen shows (a file is too big to pass as a route parameter). */
interface PendingSend {
  conversationId: string | undefined;
  draft: Draft | undefined;
  replyTo: string | undefined;
}

export const usePendingSend = create<PendingSend>()(() => ({
  conversationId: undefined,
  draft: undefined,
  replyTo: undefined,
}));
