// Small display helpers for the web chat UI.
import type { GroupRecord } from '@pingdost/message-engine';
import { toBase64 } from '@pingdost/protocol';

/** A group picture (inline bytes from the E2EE group info) as a `data:` URI. */
export function groupPictureUri(avatar: Uint8Array | null | undefined): string | undefined {
  return avatar && avatar.length > 0 ? `data:image/jpeg;base64,${toBase64(avatar)}` : undefined;
}

/** "14:05" today, "Mon" this week, else the date. */
export function listTime(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (now - ms < 6 * 86_400_000) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString();
}

/** A stable colour per sender in groups (from the ID), readable in both themes. */
export function senderColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 60% 45%)`;
}

export function groupName(group: GroupRecord | undefined): string {
  return group?.name || 'Group';
}
