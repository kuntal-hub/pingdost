// The old phone's side of a phone change (ADR 0022): requests from new phones arrive as a
// gateway frame (or are found when the app comes to the foreground), and the user approves
// one after comparing the code, or denies it. Approving certifies the new phone's keys with
// the account identity key and seals that key to it; when the new phone finishes, the server
// revokes this phone, which then wipes its chats (`runtime.ts`).
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';
import { create } from 'zustand';

import { api, authStore } from '@/api';
import { getCryptoContext } from '@/crypto/bootstrap';
import { SECRET_ITEMS, SECURE_STORE_OPTIONS } from '@/crypto/secrets';
import { ensureChannels, MESSAGES_CHANNEL } from '@/push/notifications';
import { approveTransfer, transferCode } from '@pingdost/backup';
import type { PendingPrimaryTransfer } from '@pingdost/shared-types';

export interface PhoneRequest extends PendingPrimaryTransfer {
  /** What this phone computes; the new phone must show the same. */
  code: string;
}

interface PhoneRequestsState {
  requests: PhoneRequest[];
  /** Requests the user closed without deciding (shown again only when they reopen them). */
  dismissed: string[];
}

export const usePhoneRequests = create<PhoneRequestsState>()(() => ({
  requests: [],
  dismissed: [],
}));

let loading: Promise<void> | undefined;

/** Fetches the pending requests (any device may; only the primary may approve). */
export function refreshPhoneRequests(): Promise<void> {
  loading ??= (async () => {
    const { provider } = await getCryptoContext();
    const { requests } = await api.recovery.pending();
    usePhoneRequests.setState({
      requests: requests.map((request) => ({
        ...request,
        code: transferCode(provider, request.requestId, request.deviceId, request.identityKeys),
      })),
    });
  })().finally(() => {
    loading = undefined;
  });
  return loading;
}

/** On the gateway's `PrimaryTransferRequested`: fetch, and tell the user if PingDost is closed. */
export async function onPhoneRequested(): Promise<void> {
  await refreshPhoneRequests();
  if (AppState.currentState === 'active' || usePhoneRequests.getState().requests.length === 0) {
    return;
  }
  await ensureChannels();
  await Notifications.scheduleNotificationAsync({
    identifier: 'pingdost-phone-request',
    content: {
      title: 'A new phone wants your PingDost account',
      body: 'Open PingDost to approve or deny it. If this was not you, deny it.',
      data: { phoneRequest: true },
    },
    trigger: Platform.OS === 'android' ? { channelId: MESSAGES_CHANNEL } : null,
  });
}

export function dismissPhoneRequest(requestId: string): void {
  usePhoneRequests.setState((state) => ({ dismissed: [...state.dismissed, requestId] }));
}

/** Approves `request` on this (primary) phone. */
export async function approvePhone(request: PhoneRequest): Promise<void> {
  const session = authStore.getState().session;
  if (!session) throw new Error('not signed in');
  const context = await getCryptoContext();
  const secret = await SecureStore.getItemAsync(
    SECRET_ITEMS.accountIdentityKey,
    SECURE_STORE_OPTIONS,
  );
  if (!secret) throw new Error('Only your current phone can approve a new one.');
  const identity = context.provider.restoreSigningKey(secret);
  try {
    // A one-off Olm session from this phone's account; the account itself does not change.
    const body = approveTransfer(
      context.provider,
      context.store.account,
      identity,
      session.user.userId,
      request,
    );
    await api.recovery.approve(request.requestId, body);
  } finally {
    identity.dispose();
  }
  removeRequest(request.requestId);
}

export async function denyPhone(requestId: string): Promise<void> {
  await api.recovery.deny(requestId);
  removeRequest(requestId);
}

function removeRequest(requestId: string): void {
  usePhoneRequests.setState((state) => ({
    requests: state.requests.filter((r) => r.requestId !== requestId),
  }));
}
