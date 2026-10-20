// Group chats in the app (ADR 0016): the group record as React state, contact names for
// notices and sender labels, and group pictures. A group picture is chat content: it travels
// E2EE inside the group's controls (at most 32 KiB), never through Cloudinary or the server.
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { fromBase64, toBase64 } from '@/utils/bytes';
import { GROUP_AVATAR_MAX_BYTES, type GroupRecord } from '@pingdost/message-engine';

import { contactName, loadContact, useContacts } from './contacts';
import { useChatRuntime } from './hooks';
import type { Names } from './labels';

/** A group as this device knows it, kept current by the engine; undefined while loading. */
export function useGroup(groupId: string | undefined): GroupRecord | undefined {
  const runtime = useChatRuntime();
  const [group, setGroup] = useState<GroupRecord>();
  useEffect(() => {
    if (!runtime || !groupId) return;
    let live = true;
    const load = () =>
      void runtime.engine.getGroup(groupId).then((next) => {
        if (live) setGroup(next);
      });
    load();
    const unsubscribe = runtime.engine.onConversationListChanged(load);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [runtime, groupId]);
  return group;
}

/** Contact names for notices and sender labels; unknown profiles are fetched once. */
export function useNames(): Names {
  const runtime = useChatRuntime();
  const byId = useContacts((state) => state.byId);
  const name = useCallback(
    (userId: string) => {
      const contact = byId[userId];
      if (!contact) void loadContact(userId);
      return contactName(contact);
    },
    [byId],
  );
  return useMemo(() => ({ name, selfUserId: runtime?.userId ?? '' }), [name, runtime?.userId]);
}

/** A `data:` URI for a group picture, for expo-image. */
export function groupPictureUri(avatar: Uint8Array | null | undefined): string | null {
  return avatar && avatar.length > 0 ? `data:image/jpeg;base64,${toBase64(avatar)}` : null;
}

/** A readable colour per sender in group chats, from a fixed set (same user, same colour). */
const SENDER_COLORS = ['#0B7A64', '#1F6FB2', '#A34D9E', '#B5651D', '#2E7D32', '#C2185B'];
export function senderColor(userId: string): string {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return SENDER_COLORS[Math.abs(hash) % SENDER_COLORS.length]!;
}

export class GroupPictureError extends Error {}

/**
 * Lets the user pick a square image and shrinks it to fit a group control (JPEG, at most
 * 32 KiB); null if they cancelled.
 */
export async function pickGroupPicture(): Promise<Uint8Array | null> {
  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  });
  const asset = picked.canceled ? undefined : picked.assets[0];
  if (!asset) return null;
  for (const [size, compress] of [
    [256, 0.7],
    [192, 0.55],
    [128, 0.45],
  ] as const) {
    const image = await ImageManipulator.manipulate(asset.uri)
      .resize({ width: size })
      .renderAsync();
    const saved = await image.saveAsync({ compress, format: SaveFormat.JPEG, base64: true });
    const bytes = saved.base64 ? fromBase64(saved.base64) : undefined;
    if (bytes && bytes.length <= GROUP_AVATAR_MAX_BYTES) return bytes;
  }
  throw new GroupPictureError('That picture is too detailed to use. Try another one.');
}
