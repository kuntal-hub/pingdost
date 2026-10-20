// Contacts' public profiles (username, display name, avatar), fetched once per session and kept
// in memory; profiles are public directory data, not chat content.
import { create } from 'zustand';

import { api } from '@/session/session';
import type { UserLookupResponse } from '@pingdost/shared-types';

export type Contact = UserLookupResponse;

interface ContactsState {
  byId: Record<string, Contact>;
}

export const useContacts = create<ContactsState>()(() => ({ byId: {} }));

const loading = new Map<string, Promise<Contact | undefined>>();

export function rememberContact(contact: Contact): void {
  useContacts.setState((state) => ({ byId: { ...state.byId, [contact.userId]: contact } }));
}

export function loadContact(userId: string): Promise<Contact | undefined> {
  const known = useContacts.getState().byId[userId];
  if (known) return Promise.resolve(known);
  let pending = loading.get(userId);
  if (!pending) {
    pending = api.account
      .profile(userId)
      .then((contact) => {
        rememberContact(contact);
        return contact;
      })
      .catch(() => undefined)
      .finally(() => loading.delete(userId));
    loading.set(userId, pending);
  }
  return pending;
}

export function contactName(contact: Contact | undefined): string {
  if (contact?.displayName) return contact.displayName;
  if (contact?.username) return `@${contact.username}`;
  return 'PingDost user';
}

export function useContact(userId: string | undefined): Contact | undefined {
  const contact = useContacts((state) => (userId ? state.byId[userId] : undefined));
  if (userId && !contact) void loadContact(userId);
  return contact;
}
