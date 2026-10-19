// Public profiles of the people this user chats with (username, display name, avatar URL),
// cached in the encrypted `contacts` table. The server is asked again once a day.
import { create } from 'zustand';

import { api } from '@/api';
import { getCryptoContext } from '@/crypto/bootstrap';
import type { UserLookupResponse } from '@pingdost/shared-types';

const PROFILE_MAX_AGE_MS = 86_400_000;

export interface Contact {
  userId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  fetchedAt: number;
}

interface ContactRow {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  fetched_at: number;
}

export const useContacts = create<{ byId: Record<string, Contact> }>()(() => ({ byId: {} }));

const pending = new Map<string, Promise<Contact | undefined>>();

function remember(contact: Contact): void {
  useContacts.setState((state) => ({ byId: { ...state.byId, [contact.userId]: contact } }));
}

/** The name to show: display name, else @username, else a placeholder. */
export function contactName(contact: Contact | undefined): string {
  if (contact?.displayName) return contact.displayName;
  if (contact?.username) return `@${contact.username}`;
  return 'PingDost user';
}

/** Stores a profile the server just returned (e.g. a username lookup). */
export async function saveProfile(profile: UserLookupResponse): Promise<Contact> {
  const contact: Contact = {
    userId: profile.userId,
    username: profile.username,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    fetchedAt: Date.now(),
  };
  const { db } = (await getCryptoContext()).database;
  await db.runAsync(
    `INSERT OR REPLACE INTO contacts (user_id, username, display_name, avatar_url, fetched_at)
     VALUES (?, ?, ?, ?, ?)`,
    [contact.userId, contact.username, contact.displayName, contact.avatarUrl, contact.fetchedAt],
  );
  remember(contact);
  return contact;
}

/** The cached profile, refreshed from the server when missing or a day old (best effort). */
export function loadContact(userId: string): Promise<Contact | undefined> {
  let loading = pending.get(userId);
  if (!loading) {
    loading = (async () => {
      const { db } = (await getCryptoContext()).database;
      const row = await db.getFirstAsync<ContactRow>('SELECT * FROM contacts WHERE user_id = ?', [
        userId,
      ]);
      const cached: Contact | undefined = row
        ? {
            userId: row.user_id,
            username: row.username,
            displayName: row.display_name,
            avatarUrl: row.avatar_url,
            fetchedAt: row.fetched_at,
          }
        : undefined;
      if (cached) remember(cached);
      if (cached && Date.now() - cached.fetchedAt < PROFILE_MAX_AGE_MS) return cached;
      try {
        return await saveProfile(await api.account.profile(userId));
      } catch {
        return cached; // offline, or the account is gone
      }
    })().finally(() => pending.delete(userId));
    pending.set(userId, loading);
  }
  return loading;
}
