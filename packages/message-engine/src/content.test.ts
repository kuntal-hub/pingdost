import { beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import {
  decodeContent,
  deviceCertificateMessage,
  directConversationIdFor,
  signedKeyMessage,
  uuidv7,
} from '@pingdost/protocol';
import type { UserKeysResponse } from '@pingdost/shared-types';

import { buildContent, checkHeader } from './content';
import { diffDirectory, verifyDirectory } from './directory';

const alice = uuidv7();
const bob = uuidv7();
const carol = uuidv7();

function header(fields: { sender: string; recipient?: string; conversation?: string }) {
  const bytes = buildContent(
    {
      messageId: uuidv7(),
      conversationId:
        fields.conversation ?? directConversationIdFor(fields.sender, fields.recipient ?? bob),
      senderUserId: fields.sender,
      ...(fields.recipient ? { recipientUserId: fields.recipient } : {}),
      sentAt: 1_000,
    },
    { case: 'text', value: { body: 'x' } },
  );
  return decodeContent(bytes).header!;
}

describe('checkHeader', () => {
  it('accepts a direct message to this user from the device owner', () => {
    expect(
      checkHeader(header({ sender: alice, recipient: bob }), { userId: alice }, bob),
    ).toMatchObject({
      senderUserId: alice,
      recipientUserId: bob,
      conversationId: directConversationIdFor(alice, bob),
    });
  });

  it("accepts a copy from this user's own other device", () => {
    expect(
      checkHeader(header({ sender: bob, recipient: carol }), { userId: bob }, bob),
    ).toBeDefined();
  });

  it('rejects a sender that does not own the device, another recipient, or a foreign conversation', () => {
    // The device belongs to carol, but the header claims alice.
    expect(
      checkHeader(header({ sender: alice, recipient: bob }), { userId: carol }, bob),
    ).toBeUndefined();
    // Addressed to carol, delivered to bob.
    expect(
      checkHeader(header({ sender: alice, recipient: carol }), { userId: alice }, bob),
    ).toBeUndefined();
    // Filed into the alice–carol conversation while addressed to bob.
    expect(
      checkHeader(
        header({
          sender: alice,
          recipient: bob,
          conversation: directConversationIdFor(alice, carol),
        }),
        { userId: alice },
        bob,
      ),
    ).toBeUndefined();
    // No recipient: not a direct message (groups arrive in Phase 13).
    expect(checkHeader(header({ sender: alice }), { userId: alice }, bob)).toBeUndefined();
  });
});

describe('verifyDirectory', () => {
  let crypto: CryptoProvider;
  beforeAll(async () => {
    crypto = await createWasmCryptoProvider();
  });

  function directory(): { response: UserKeysResponse; deviceId: string } {
    const identity = crypto.createSigningKey();
    const account = crypto.createAccount();
    const keys = account.identityKeys();
    const deviceId = uuidv7();
    account.generateFallbackKey();
    const fallback = account.fallbackKey()!;
    return {
      deviceId,
      response: {
        userId: alice,
        accountIdentityKey: identity.publicKey(),
        keyVersion: 1,
        devices: [
          {
            deviceId,
            platform: 'android',
            role: 'primary',
            identityKeys: keys,
            deviceCertificate: identity.sign(deviceCertificateMessage(deviceId, keys)),
            fallbackKey: {
              ...fallback,
              signature: account.sign(
                signedKeyMessage('fallback', deviceId, fallback.keyId, fallback.publicKey),
              ),
            },
          },
        ],
      },
    };
  }

  it('keeps certified devices and signed fallback keys', () => {
    const { response, deviceId } = directory();
    const { record, rejected } = verifyDirectory(crypto, response, 5);
    expect(rejected).toBe(0);
    expect(record.devices).toEqual([
      expect.objectContaining({ deviceId, fallbackKey: response.devices[0]!.fallbackKey }),
    ]);
  });

  it('drops a device whose certificate fails, and a fallback key with a bad signature', () => {
    const { response } = directory();
    const other = directory().response;
    const forged = { ...response, accountIdentityKey: other.accountIdentityKey };
    expect(verifyDirectory(crypto, forged, 5)).toMatchObject({
      rejected: 1,
      record: { devices: [] },
    });
    const badFallback = structuredClone(response);
    badFallback.devices[0]!.fallbackKey!.signature = other.devices[0]!.fallbackKey!.signature;
    expect(verifyDirectory(crypto, badFallback, 5).record.devices[0]?.fallbackKey).toBeNull();
    expect(verifyDirectory(crypto, { ...response, accountIdentityKey: null }, 5).rejected).toBe(1);
  });

  it('reports added and removed devices and a changed identity key', () => {
    const { response } = directory();
    const first = { ...verifyDirectory(crypto, response, 1).record, verifiedIdentityKey: null };
    const replaced = directory().response;
    const next = verifyDirectory(crypto, replaced, 2).record;
    const change = diffDirectory(first, next);
    expect(change.added.map((d) => d.deviceId)).toEqual([replaced.devices[0]!.deviceId]);
    expect(change.removed.map((d) => d.deviceId)).toEqual([response.devices[0]!.deviceId]);
    expect(change.identityChanged).toBe(true);
    // The first sighting of a key is not a change.
    expect(diffDirectory(undefined, next).identityChanged).toBe(false);
  });
});
