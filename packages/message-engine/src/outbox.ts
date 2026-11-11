/**
 * The outbox (REQ §8.1, ARCHITECTURE A3): the sender's durable copy until the next hop
 * accepts each envelope.
 *
 * 1. A new message is a `fanout` item. Once the directories of the peer and of this user are
 *    known, it becomes one `device` item per recipient device: every active device of the
 *    peer and this user's other devices, `envelopeId = envelopeIdFor(messageId, deviceId)`.
 * 2. A device item is encrypted once (claiming a one-time key when no session exists yet) and
 *    its packet stored with the advanced session, so retransmits resend the same bytes.
 * 3. `Accepted` deletes the item: the device is `sent_to_server`. Retryable failures back off
 *    with jitter; `RECIPIENT_UNKNOWN` (a revoked device) drops it and refreshes the directory.
 * 4. Routing (ADR 0024): the transport says how each device is reached now. Over the Internet
 *    as above; nearby (the recipient device's own ACK) it is `sent_to_server` too, with the
 *    delivery row naming the path. With no route the item is not encrypted yet and waits
 *    (`waiting_for_nearby_route`, no attempt counted) until `routesChanged`. Nearby with no
 *    session, the device's cached, signature-checked fallback key starts one offline.
 * Queued receipts are coalesced: one Content acknowledges a burst of messages. Control
 * Contents (edits, deletes, reactions) fan out the same way but carry no delivery state, so
 * they are not resent after a session repair once the server has accepted them.
 */
import type { OlmCiphertext } from '@pingdost/crypto/core';
import {
  bytesToUuid,
  create,
  CryptoType,
  decodeTransportPacket,
  encodeEnvelope,
  encodeTransportPacket,
  envelopeIdFor,
  EnvelopeSchema,
  PacketKind,
  PROTOCOL_VERSION,
  TransportPacketSchema,
  uuidToBytes,
  uuidv7,
  uuidv7Bytes,
  type TransportPacket,
} from '@pingdost/protocol';
import { MAX_CLAIM_DEVICES, type MessageState } from '@pingdost/shared-types';
import { backoffDelay, type Route, type SendResult } from '@pingdost/transport';

import { attachmentContentFor } from './attachments';
import { buildContent, receiptBody, textContentFor } from './content';
import { EngineCore } from './core';
import { claimedKeySigned, errorCode } from './directory';
import { keyRequestBody, roomKeyBody } from './groups/content';
import { needsRotation } from './groups/megolm';
import { memberKey } from './groups/state';
import type { RemoteDevice } from './sessions';
import { advance } from './states';
import type {
  DeliveryRecord,
  DeviceItem,
  DirectoryDeviceRecord,
  FanoutItem,
  InboundGroupSessionRecord,
  MessageCursor,
  MessageRecord,
  OutboundGroupSessionRecord,
  OutboxItem,
  ReceiptItem,
  WriteBatch,
} from './store';

/** Message IDs per receipt Content (16 bytes each, well inside the smallest buckets). */
const RECEIPT_IDS_PER_CONTENT = 200;
/** Floor for the next wake-up, so items that cannot progress never spin. */
const MIN_WAKE_MS = 250;

/** Routes without the Internet: no key claim, sessions start from cached fallback keys. */
const offline = (route: Route | undefined) => route === 'nearby' || route === 'mesh';

async function pool<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export class Outbox {
  #running = false;
  #again = false;
  #stopped = true;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** In-flight work, so `stop()` can wait for it. */
  #current: Promise<void> = Promise.resolve();
  /**
   * Device items no transport reached when last tried. They wait for `routesChanged` (in
   * memory only: after a restart each is tried once more).
   */
  readonly #parked = new Set<string>();

  constructor(private readonly core: EngineCore) {}

  /** A route may have appeared (Internet back, a nearby peer proved its key): flush. */
  routesChanged(): void {
    this.#parked.clear();
    this.kick();
  }

  start(): void {
    this.#stopped = false;
    this.kick();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#current;
  }

  /** Processes the outbox now, or again right after the pass in progress. */
  kick(): void {
    if (this.#stopped) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    this.#current = this.#run();
  }

  async #run(): Promise<void> {
    try {
      do {
        this.#again = false;
        try {
          await this.#pass();
        } catch (error) {
          this.core.log('error', 'outbox pass failed', { error: String(error) });
        }
      } while (this.#again && !this.#stopped);
    } finally {
      this.#running = false;
      await this.#schedule().catch(() => undefined);
    }
  }

  async #pass(): Promise<void> {
    const { core } = this;
    await this.#coalesceReceipts();
    if (core.options.transport.status$.value !== 'online') return;

    for (const item of await core.store.listOutbox()) {
      if (this.#stopped) return;
      if (item.type !== 'fanout' || !this.#due(item)) continue;
      if (item.groupId) await this.#fanOutGroup({ ...item, groupId: item.groupId });
      else await this.#fanOut(item);
    }
    const due = (await core.store.listOutbox()).filter(
      (item): item is DeviceItem => item.type === 'device' && this.#due(item),
    );
    if (due.length === 0 || this.#stopped) return;
    const routes = new Map<string, Route>();
    const ready: DeviceItem[] = [];
    for (const item of due) {
      let route = core.options.transport.route?.(item.recipientDeviceId) ?? 'internet';
      if (route === 'offline') continue; // everything went down meanwhile
      // A browser is never in Bluetooth range: it waits for the Internet, not the mesh.
      if (route === 'mesh' && (await this.#device(item))?.platform === 'web') route = 'unreachable';
      if (route === 'unreachable') {
        await core.mutex.run(() => this.#wait(item));
        continue;
      }
      routes.set(item.id, route);
      ready.push(item);
    }
    if (ready.length === 0 || this.#stopped) return;
    // Nearby or the mesh means no Internet: no key claim, the cached fallback key instead.
    const { keys, refused } = await this.#claimKeys(
      ready.filter((item) => !offline(routes.get(item.id))),
    );
    await pool(ready, core.settings.maxInflight, async (item) => {
      if (this.#stopped) return;
      try {
        if (refused.has(item.recipientDeviceId)) {
          await this.#refused(item);
          return;
        }
        await this.#send(item, keys, routes.get(item.id) ?? 'internet');
      } catch (error) {
        core.log('error', 'outbox item failed', { error: String(error) });
      }
    });
  }

  #due(item: OutboxItem): boolean {
    const now = this.core.now();
    return item.nextAttemptAt <= now && item.expiresAt > now && !this.#parked.has(item.id);
  }

  /** No transport reaches the device now: wait for a route (not an attempt). */
  async #wait(item: DeviceItem): Promise<void> {
    this.#parked.add(item.id);
    const stored = await this.core.store.getOutboxItem(item.id);
    if (stored?.type !== 'device') return;
    const batch: WriteBatch = {};
    await this.#moveDelivery(batch, stored, 'waiting_for_nearby_route', this.core.now());
    if (batch.deliveries?.length) await this.core.commit(batch);
  }

  /** Wakes up for the next due item (while online) or the next receipt batch. */
  async #schedule(): Promise<void> {
    clearTimeout(this.#timer);
    if (this.#stopped) return;
    const { core } = this;
    const online = core.options.transport.status$.value === 'online';
    let next = Infinity;
    for (const item of await core.store.listOutbox()) {
      if (item.type === 'receipt')
        next = Math.min(next, item.createdAt + core.settings.receiptDelayMs);
      else if (online && item.expiresAt > core.now() && !this.#parked.has(item.id))
        next = Math.min(next, item.nextAttemptAt);
    }
    if (next === Infinity) return;
    const delay = Math.max(MIN_WAKE_MS, next - core.now());
    this.#timer = setTimeout(() => this.kick(), delay);
  }

  // Receipts

  async #coalesceReceipts(): Promise<void> {
    const { core } = this;
    await core.mutex.run(async () => {
      const receipts = (await core.store.listOutbox()).filter(
        (item): item is ReceiptItem => item.type === 'receipt',
      );
      if (receipts.length === 0) return;
      const now = core.now();
      const groups = new Map<string, ReceiptItem[]>();
      for (const item of receipts) {
        const key = `${item.recipientDeviceId}/${item.receipt}`;
        groups.set(key, [...(groups.get(key) ?? []), item]);
      }
      const batch: WriteBatch = { outbox: [], deleteOutbox: [] };
      for (const group of groups.values()) {
        const newest = Math.max(...group.map((item) => item.createdAt));
        if (now - newest < core.settings.receiptDelayMs) continue; // more may follow
        const first = group[0]!;
        for (let start = 0; start < group.length; start += RECEIPT_IDS_PER_CONTENT) {
          const chunk = group.slice(start, start + RECEIPT_IDS_PER_CONTENT);
          const contentId = uuidv7();
          batch.outbox!.push({
            type: 'device',
            purpose: 'receipt',
            id: bytesToUuid(envelopeIdFor(contentId, first.recipientDeviceId)),
            messageId: contentId,
            recipientUserId: first.recipientUserId,
            recipientDeviceId: first.recipientDeviceId,
            content: buildContent(
              {
                messageId: contentId,
                conversationId: core.directConversationId(first.recipientUserId),
                senderUserId: core.self.userId,
                recipientUserId: first.recipientUserId,
                sentAt: now,
              },
              receiptBody(
                first.receipt,
                chunk.map((item) => item.messageId),
              ),
              core.settings.envelopeMaxBytes,
            ),
            packet: null,
            newSession: false,
            createdAt: now,
            expiresAt: now + core.settings.maxRetentionMs,
            attempts: 0,
            nextAttemptAt: now,
          });
          batch.deleteOutbox!.push(...chunk.map((item) => item.id));
        }
      }
      if (batch.deleteOutbox!.length > 0) await core.commit(batch);
    });
  }

  // Fan-out

  async #fanOut(item: FanoutItem): Promise<void> {
    const { core } = this;
    const recipients: { userId: string; device: DirectoryDeviceRecord; own: boolean }[] = [];
    // Users whose directory is neither cached nor fetchable now (offline): they get their
    // copies later, from what stays of this item (ADR 0024).
    const pending: string[] = [];
    let gone = 0;
    for (const userId of item.recipientUserIds) {
      const lookup = await core.directoryFor(userId, core.settings.directoryMaxAgeMs);
      if (lookup.status === 'unavailable') {
        pending.push(userId);
        continue;
      }
      if (lookup.status === 'not_found') {
        if (userId !== core.self.userId) gone++;
        continue;
      }
      for (const device of lookup.record.devices) {
        if (device.deviceId === core.self.deviceId) continue;
        recipients.push({ userId, device, own: userId === core.self.userId });
      }
    }
    // Every other recipient's account is gone (a group control still reaches the rest).
    const others = item.recipientUserIds.filter((u) => u !== core.self.userId).length;
    const peerGone = others > 0 && gone === others;
    // What stays of a partial fan-out names only this user: its own devices are enough then.
    const needsPeer = others > 0;
    const unavailable = pending.length > 0 && (!needsPeer || !recipients.some((r) => !r.own));

    await core.mutex.run(async () => {
      const stored = await core.store.getOutboxItem(item.id);
      if (stored?.type !== 'fanout') return;
      const now = core.now();
      // Control Contents (edits, deletes, reactions) have no delivery rows or state.
      const purpose = stored.purpose ?? 'message';
      const batch: WriteBatch = {};
      if (peerGone) {
        // The account no longer exists: nothing can deliver this.
        batch.deleteOutbox = [item.id];
        const message =
          purpose === 'message' ? await core.store.getMessage(item.messageId) : undefined;
        if (message?.state) {
          batch.messages = [{ ...message, state: advance(message.state, 'failed') }];
        }
      } else if (unavailable || (needsPeer && !recipients.some((r) => !r.own))) {
        if (!unavailable) core.log('info', 'recipient has no devices yet');
        batch.outbox = [this.#retryLater(stored, now)];
      } else {
        batch.outbox = [];
        batch.deliveries = [];
        if (pending.length > 0) {
          // The peer's devices go now; the rest (e.g. this user's own, uncached offline) later.
          batch.outbox.push({ ...this.#retryLater(stored, now), recipientUserIds: pending });
        } else {
          batch.deleteOutbox = [item.id];
        }
        for (const { userId, device, own } of recipients) {
          batch.outbox.push({
            type: 'device',
            purpose,
            id: bytesToUuid(envelopeIdFor(item.messageId, device.deviceId)),
            messageId: item.messageId,
            recipientUserId: userId,
            recipientDeviceId: device.deviceId,
            content: item.content,
            packet: null,
            newSession: false,
            createdAt: item.createdAt,
            expiresAt: item.expiresAt,
            attempts: 0,
            nextAttemptAt: now,
          });
          if (purpose !== 'message') continue;
          batch.deliveries.push({
            messageId: item.messageId,
            deviceId: device.deviceId,
            userId,
            own,
            state: 'local_queued',
            updatedAt: now,
          });
        }
      }
      await core.commit(batch);
    });
  }

  /**
   * Group traffic (ADR 0016): the Content is encrypted once with this device's Megolm session
   * for the group and the same ciphertext goes to every member device. Devices that have not
   * had the session's key get it first, over Olm, at the current index: this message is the
   * first they can read. The session is replaced first when the members or their devices
   * changed, or it is old or busy (`needsRotation`).
   */
  async #fanOutGroup(item: FanoutItem & { groupId: string }): Promise<void> {
    const { core } = this;
    const { groupId } = item;
    const before = await core.store.getGroup(groupId);
    const recipients: { userId: string; device: DirectoryDeviceRecord; own: boolean }[] = [];
    let unavailable = false;
    for (const { userId } of before && !before.left ? before.members : []) {
      const lookup = await core.directoryFor(userId, core.settings.directoryMaxAgeMs);
      if (lookup.status === 'unavailable') {
        unavailable = true;
        break;
      }
      if (lookup.status === 'not_found') continue;
      for (const device of lookup.record.devices) {
        if (device.deviceId === core.self.deviceId) continue;
        recipients.push({ userId, device, own: userId === core.self.userId });
      }
    }

    await core.mutex.run(async () => {
      const stored = await core.store.getOutboxItem(item.id);
      if (stored?.type !== 'fanout') return;
      const purpose = stored.purpose ?? 'message';
      const now = core.now();
      const group = await core.store.getGroup(groupId);
      const batch: WriteBatch = {};
      if (!group || group.left) {
        // No longer a member: it can never go out.
        batch.deleteOutbox = [item.id];
        await this.#fail(batch, stored);
        await core.commit(batch);
        return;
      }
      // The members may have changed while the directories were fetched.
      const members = new Set(group.members.map((m) => m.userId));
      const targets = recipients.filter((r) => members.has(r.userId));
      if (unavailable || !targets.some((r) => !r.own)) {
        if (!unavailable && !group.members.some((m) => m.userId !== core.self.userId)) {
          // Alone in the group: nobody can receive it.
          batch.deleteOutbox = [item.id];
          await this.#fail(batch, stored);
        } else {
          batch.outbox = [this.#retryLater(stored, now)];
        }
        await core.commit(batch);
        return;
      }

      const self = this.#selfSender();
      const key = memberKey(group);
      let session = await core.store.getOutboundGroupSession(groupId);
      let own = session
        ? await core.store.getInboundGroupSession(core.self.deviceId, session.sessionId)
        : undefined;
      const rotation = {
        maxMessages: core.settings.groupRotationMessages,
        maxAgeMs: core.settings.groupRotationMs,
      };
      const deviceIds = targets.map((r) => r.device.deviceId);
      if (
        !session ||
        !own ||
        needsRotation(session, { now, memberKey: key, recipientDeviceIds: deviceIds }, rotation)
      ) {
        const created = core.groupSessions.create(groupId, self, key, now);
        session = created.outbound;
        own = created.own;
      }

      batch.deleteOutbox = [item.id];
      batch.outbox = [];
      batch.deliveries = [];
      const shared = new Set(session.sharedWith);
      const unshared = targets.filter((r) => !shared.has(r.device.deviceId));
      // Sessions made here start at index 0, so the count is the next message's index.
      const sharedAt = { ...own.sharedAt };
      for (const r of unshared) sharedAt[r.device.deviceId] = session.messageCount;
      if (unshared.length > 0) {
        const keyId = uuidv7();
        const keyContent = buildContent(
          {
            messageId: keyId,
            conversationId: groupId,
            senderUserId: core.self.userId,
            sentAt: now,
          },
          roomKeyBody(groupId, session.sessionId, core.groupSessions.sessionKey(session), false),
          core.settings.envelopeMaxBytes,
        );
        for (const r of unshared) {
          // Sorted before the message, so it usually goes out first.
          batch.outbox.push(
            this.#olmItem('room_key', keyId, r, keyContent, item.createdAt - 1, now, groupId),
          );
        }
        session = {
          ...session,
          sharedWith: [...session.sharedWith, ...unshared.map((r) => r.device.deviceId)],
        };
      }

      const { ciphertext, record } = core.groupSessions.encrypt(session, stored.content);
      for (const r of targets) {
        const id = bytesToUuid(envelopeIdFor(item.messageId, r.device.deviceId));
        let packet: Uint8Array;
        try {
          packet = this.#megolmPacket(id, r.device.deviceId, groupId, record, ciphertext, {
            expiresAt: stored.expiresAt,
            now,
          });
        } catch {
          // Too large or already expired: it can never be sent.
          await core.commit({
            deleteOutbox: [item.id],
            outboundGroupSessions: [record],
            inboundGroupSessions: [{ ...own, sharedAt }],
            ...(await this.#fail({}, stored)),
          });
          return;
        }
        batch.outbox.push({
          type: 'device',
          purpose,
          id,
          messageId: item.messageId,
          recipientUserId: r.userId,
          recipientDeviceId: r.device.deviceId,
          content: stored.content,
          packet,
          newSession: false,
          groupId,
          megolm: true,
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
          attempts: 0,
          nextAttemptAt: now,
        });
        if (purpose !== 'message') continue;
        batch.deliveries.push({
          messageId: item.messageId,
          deviceId: r.device.deviceId,
          userId: r.userId,
          own: r.own,
          state: 'local_queued',
          updatedAt: now,
        });
      }
      batch.outboundGroupSessions = [record];
      batch.inboundGroupSessions = [{ ...own, sharedAt }];
      await core.commit(batch);
    });
  }

  /** Marks the fan-out's message failed (message items only). */
  async #fail(batch: WriteBatch, item: FanoutItem): Promise<WriteBatch> {
    if ((item.purpose ?? 'message') !== 'message') return batch;
    const message = await this.core.store.getMessage(item.messageId);
    if (message?.state) {
      batch.messages = [
        ...(batch.messages ?? []),
        { ...message, state: advance(message.state, 'failed') },
      ];
    }
    return batch;
  }

  #selfSender(): { userId: string; deviceId: string; curve25519: string } {
    const { core } = this;
    return {
      userId: core.self.userId,
      deviceId: core.self.deviceId,
      curve25519: core.options.account.identityKeys().curve25519,
    };
  }

  /** One Olm-encrypted Content to one device (`id` = its envelope ID). */
  #olmItem(
    purpose: DeviceItem['purpose'],
    contentId: string,
    to: { userId: string; device: { deviceId: string } },
    content: Uint8Array,
    createdAt: number,
    now: number,
    groupId?: string,
  ): DeviceItem {
    return {
      type: 'device',
      purpose,
      id: bytesToUuid(envelopeIdFor(contentId, to.device.deviceId)),
      messageId: contentId,
      recipientUserId: to.userId,
      recipientDeviceId: to.device.deviceId,
      content,
      packet: null,
      newSession: false,
      ...(groupId ? { groupId } : {}),
      createdAt,
      expiresAt: now + this.core.settings.maxRetentionMs,
      attempts: 0,
      nextAttemptAt: now,
    };
  }

  #megolmPacket(
    envelopeId: string,
    recipientDeviceId: string,
    groupId: string,
    session: OutboundGroupSessionRecord,
    ciphertext: Uint8Array,
    at: { expiresAt: number; now: number },
  ): Uint8Array {
    const { core } = this;
    const options = { envelopeMaxBytes: core.settings.envelopeMaxBytes, nowMs: at.now };
    const payload = encodeEnvelope(
      create(EnvelopeSchema, {
        envelopeId: uuidToBytes(envelopeId),
        senderDeviceId: uuidToBytes(core.self.deviceId),
        recipientDeviceId: uuidToBytes(recipientDeviceId),
        cryptoType: CryptoType.MEGOLM,
        groupId: uuidToBytes(groupId),
        megolmSessionId: session.sessionId,
        ciphertext,
      }),
      options,
    );
    return encodeTransportPacket(
      create(TransportPacketSchema, {
        version: PROTOCOL_VERSION,
        packetId: uuidv7Bytes(),
        kind: PacketKind.ENVELOPE,
        dst: uuidToBytes(recipientDeviceId),
        createdAtMs: BigInt(at.now),
        expiresAtMs: BigInt(at.expiresAt),
        hopBudget: 0,
        flags: 0,
        payload,
      }),
      options,
    );
  }

  /** Asks the device that sent a Megolm session for its key (`RoomKeyRequest`). */
  async requestRoomKey(
    sender: { userId: string; deviceId: string },
    groupId: string,
    sessionId: string,
    fromIndex: number,
  ): Promise<void> {
    const { core } = this;
    await core.mutex.run(async () => {
      const now = core.now();
      const contentId = uuidv7();
      const content = buildContent(
        {
          messageId: contentId,
          conversationId: groupId,
          senderUserId: core.self.userId,
          sentAt: now,
        },
        keyRequestBody(groupId, sessionId, fromIndex),
        core.settings.envelopeMaxBytes,
      );
      await core.commit({
        outbox: [
          this.#olmItem(
            'control',
            contentId,
            { userId: sender.userId, device: { deviceId: sender.deviceId } },
            content,
            now,
            now,
            groupId,
          ),
        ],
      });
    });
    this.kick();
  }

  /**
   * Answers a key request with this device's session exported from the index asked for.
   * Called under the lock by the receiver, which checked the requester may have it.
   */
  answerKeyRequest(
    batch: WriteBatch,
    requester: { userId: string; deviceId: string },
    own: InboundGroupSessionRecord,
    fromIndex: number,
  ): void {
    const { core } = this;
    const exported = core.groupSessions.exportFrom(own, fromIndex);
    if (!exported) return;
    const now = core.now();
    const contentId = uuidv7();
    const content = buildContent(
      {
        messageId: contentId,
        conversationId: own.groupId,
        senderUserId: core.self.userId,
        sentAt: now,
      },
      roomKeyBody(own.groupId, own.sessionId, exported, true),
      core.settings.envelopeMaxBytes,
    );
    (batch.outbox ??= []).push(
      this.#olmItem(
        'room_key',
        contentId,
        { userId: requester.userId, device: { deviceId: requester.deviceId } },
        content,
        now,
        now,
        own.groupId,
      ),
    );
  }

  // Devices

  /** The recipient device as last verified, if it is still listed. */
  async #device(item: DeviceItem): Promise<DirectoryDeviceRecord | undefined> {
    const directory = await this.core.store.getDirectory(item.recipientUserId);
    return directory?.devices.find((d) => d.deviceId === item.recipientDeviceId);
  }

  /**
   * One signature-checked key per device that has no session yet (one claim call per 100).
   * `refused`: devices of people outside this user's circle (Phase 37); nothing goes to them.
   */
  async #claimKeys(
    items: DeviceItem[],
  ): Promise<{ keys: Map<string, string>; refused: Set<string> }> {
    const { core } = this;
    const needed = new Map<string, DirectoryDeviceRecord>();
    for (const item of items) {
      if (item.packet || needed.has(item.recipientDeviceId)) continue;
      const device = await this.#device(item);
      if (!device) continue;
      const remote = { ...device, userId: item.recipientUserId };
      if (!item.newSession && (await core.sessions.preferred(remote))) continue;
      needed.set(device.deviceId, device);
    }
    const keys = new Map<string, string>();
    const refused = new Set<string>();
    const ids = [...needed.keys()];
    for (let start = 0; start < ids.length; start += MAX_CLAIM_DEVICES) {
      const chunk = ids.slice(start, start + MAX_CLAIM_DEVICES);
      try {
        const { keys: claimed, refusedDeviceIds } = await core.options.api.claim(chunk);
        for (const id of refusedDeviceIds ?? []) refused.add(id);
        for (const entry of claimed) {
          const device = needed.get(entry.deviceId);
          if (!device) continue;
          if (claimedKeySigned(core.options.crypto, device, entry)) {
            keys.set(entry.deviceId, entry.key.publicKey);
          } else {
            core.log('warn', 'claimed key has a bad signature');
          }
        }
      } catch (error) {
        const code = errorCode(error);
        if (code === 'NOT_IN_CIRCLE') for (const id of chunk) refused.add(id);
        else core.log('warn', 'key claim failed', { code: code ?? 'network' });
      }
    }
    return { keys, refused };
  }

  /** The server will not take it (outside the circle): failed, and not tried again. */
  async #refused(item: DeviceItem): Promise<void> {
    const { core } = this;
    await core.mutex.run(async () => {
      const stored = await core.store.getOutboxItem(item.id);
      if (stored?.type !== 'device') return;
      const batch: WriteBatch = { deleteOutbox: [item.id] };
      await this.#moveDelivery(batch, stored, 'failed', core.now());
      await core.commit(batch);
    });
  }

  async #send(item: DeviceItem, keys: Map<string, string>, route: Route): Promise<void> {
    const { core } = this;
    const ready = await core.mutex.run(() => this.#prepare(item, keys, route));
    if (!ready) return;
    let packet: TransportPacket;
    try {
      packet = decodeTransportPacket(ready.packet!, {
        envelopeMaxBytes: core.settings.envelopeMaxBytes,
        nowMs: core.now(),
      });
    } catch {
      await core.mutex.run(() =>
        this.#settle(ready, { ok: false, code: 'ENVELOPE_EXPIRED', retryable: false }),
      );
      return;
    }
    const result = await core.options.transport.send(packet);
    await core.mutex.run(() => this.#settle(ready, result));
  }

  /**
   * Encrypts the item if it has no packet yet, and marks its delivery `sending` (not for the
   * mesh, which only holds it here). Nearby or the mesh: no Internet, so a new session starts
   * from the device's cached fallback key (mesh first contact, ARCHITECTURE A5).
   */
  async #prepare(
    item: DeviceItem,
    keys: Map<string, string>,
    route: Route,
  ): Promise<DeviceItem | undefined> {
    const nearby = offline(route);
    const { core } = this;
    const stored = await core.store.getOutboxItem(item.id);
    if (stored?.type !== 'device') return undefined; // settled meanwhile (receipt, revocation)
    const now = core.now();
    const batch: WriteBatch = {};
    let current = stored;

    if (!current.packet) {
      const device = await this.#device(current);
      if (!device) {
        await core.commit(await this.#drop(current));
        return undefined;
      }
      const remote: RemoteDevice = { ...device, userId: current.recipientUserId };
      let session = current.newSession ? undefined : await core.sessions.preferred(remote);
      if (!session) {
        const claimed = keys.get(device.deviceId);
        // Verified with the directory: the device's own signature (directory.ts).
        const key = claimed ?? (nearby ? device.fallbackKey?.publicKey : undefined);
        if (!key) {
          // No key to start a session (none left on the server, the claim failed, or offline
          // with no cached fallback key).
          await core.commit({ outbox: [this.#retryLater(current, now)] });
          return undefined;
        }
        if (claimed) keys.delete(device.deviceId); // one claimed key makes one session
        session = core.sessions.createOutbound(remote, key, now);
      }
      let encrypted: ReturnType<typeof core.sessions.encrypt>;
      try {
        encrypted = core.sessions.encrypt(session, current.content);
      } catch {
        // An unreadable session: start a new one on the next attempt.
        core.sessions.forget(session.sessionId);
        await core.commit({ outbox: [{ ...this.#retryLater(current, now), newSession: true }] });
        return undefined;
      }
      let packet: Uint8Array;
      try {
        packet = this.#packet(current, encrypted.ciphertext, now);
      } catch {
        // Too large or already expired: it can never be sent.
        await core.commit({ ...(await this.#drop(current)), sessions: [encrypted.session] });
        return undefined;
      }
      current = { ...current, packet, newSession: false };
      batch.sessions = [encrypted.session];
      batch.outbox = [current];
    }

    if (route !== 'mesh') await this.#moveDelivery(batch, current, 'sending', now);
    if (batch.sessions || batch.deliveries?.length) await core.commit(batch);
    return current;
  }

  #packet(item: DeviceItem, ciphertext: OlmCiphertext, now: number): Uint8Array {
    const { core } = this;
    const options = { envelopeMaxBytes: core.settings.envelopeMaxBytes, nowMs: now };
    const payload = encodeEnvelope(
      create(EnvelopeSchema, {
        envelopeId: uuidToBytes(item.id),
        senderDeviceId: uuidToBytes(core.self.deviceId),
        recipientDeviceId: uuidToBytes(item.recipientDeviceId),
        cryptoType: ciphertext.type === 'prekey' ? CryptoType.OLM_PREKEY : CryptoType.OLM,
        // Room keys name their group: the server delivers them only between members.
        ...(item.groupId ? { groupId: uuidToBytes(item.groupId) } : {}),
        ciphertext: ciphertext.body,
      }),
      options,
    );
    return encodeTransportPacket(
      create(TransportPacketSchema, {
        version: PROTOCOL_VERSION,
        packetId: uuidv7Bytes(),
        kind: PacketKind.ENVELOPE,
        dst: uuidToBytes(item.recipientDeviceId),
        createdAtMs: BigInt(now),
        // The server keeps it no longer than this, so the sender's expiry deadline holds.
        expiresAtMs: BigInt(item.expiresAt),
        hopBudget: 0,
        flags: 0,
        payload,
      }),
      options,
    );
  }

  async #settle(item: DeviceItem, result: SendResult): Promise<void> {
    const { core } = this;
    const stored = await core.store.getOutboxItem(item.id);
    if (stored?.type !== 'device') return; // a receipt or a revocation settled it first
    const now = core.now();
    const batch: WriteBatch = {};
    let state: MessageState;
    let via: DeliveryRecord['via'];
    if (result.ok && result.status === 'held') {
      // The mesh on this phone holds it for relays (ADR 0025). The item stays, so the same
      // packet still goes over the Internet or a direct link when one appears; it waits for
      // that, and `relayed` comes from the relays' signed acceptances.
      this.#parked.add(item.id);
      state = 'waiting_for_nearby_route';
    } else if (result.ok) {
      // The server's Accepted, or the recipient device's nearby ACK: the next hop holds it.
      batch.deleteOutbox = [item.id];
      state = 'sent_to_server';
      via = result.via;
    } else if (result.code === 'NO_ROUTE') {
      // The route went away before it was sent: wait for the next one (not an attempt).
      this.#parked.add(item.id);
      state = 'waiting_for_nearby_route';
    } else if (result.code === 'OFFLINE') {
      // Not an attempt: the status turning online resends it.
      state = 'local_queued';
    } else if (result.code === 'RECIPIENT_UNKNOWN') {
      await core.commit(await this.#drop(stored));
      void core.refreshDirectory(item.recipientUserId);
      return;
    } else if (result.code === 'NOT_A_MEMBER') {
      // The server says the recipient (or this user) left the group: refresh the membership.
      await core.commit(await this.#drop(stored));
      if (stored.groupId) void core.groupSync?.(stored.groupId);
      return;
    } else if (result.retryable) {
      batch.outbox = [this.#retryLater(stored, now)];
      state = 'local_queued';
    } else if (result.code === 'ENVELOPE_EXPIRED') {
      // The expiry sweep marks the message.
      batch.deleteOutbox = [item.id];
      state = 'local_queued';
    } else {
      core.log('warn', 'envelope rejected', { code: result.code });
      batch.deleteOutbox = [item.id];
      state = 'failed';
    }
    await this.#moveDelivery(batch, stored, state, now, via);
    await core.commit(batch);
  }

  /** Moves the item's delivery row (message items only) and restates its message. */
  async #moveDelivery(
    batch: WriteBatch,
    item: DeviceItem,
    state: MessageState,
    now: number,
    via?: DeliveryRecord['via'],
  ) {
    if (item.purpose !== 'message') return;
    const { core } = this;
    const row = (await core.store.listDeliveries(item.messageId)).find(
      (d) => d.deviceId === item.recipientDeviceId,
    );
    if (!row) return;
    const next = EngineCore.moved(row, state, now);
    if (!next) return;
    const moved = via ? { ...next, via } : next;
    batch.deliveries = [...(batch.deliveries ?? []), moved];
    const message = await core.restate(item.messageId, [moved]);
    if (message) batch.messages = [...(batch.messages ?? []), message];
  }

  /**
   * Relays accepted an envelope the mesh holds (ADR 0025): its device row becomes `relayed`
   * ("Forwarded by N devices — not yet delivered"), never more. A row that is already further
   * (the server took it, or a receipt came) keeps its state.
   */
  async relayed(envelopeId: string, relays: number): Promise<void> {
    const { core } = this;
    await core.mutex.run(async () => {
      const item = await core.store.getOutboxItem(envelopeId);
      if (item?.type !== 'device' || item.purpose !== 'message') return;
      const row = (await core.store.listDeliveries(item.messageId)).find(
        (d) => d.deviceId === item.recipientDeviceId,
      );
      if (!row) return;
      const now = core.now();
      const base = row.state === 'relayed' ? row : EngineCore.moved(row, 'relayed', now);
      if (base?.state !== 'relayed') return;
      const count = Math.max(row.relays ?? 0, relays);
      if (row.state === 'relayed' && row.relays === count) return;
      const next: DeliveryRecord = { ...base, via: 'mesh', relays: count, updatedAt: now };
      const batch: WriteBatch = { deliveries: [next] };
      const message = await core.restate(item.messageId, [next]);
      if (message) batch.messages = [message];
      await core.commit(batch);
    });
  }

  /** Deletes an item whose device is gone, with its delivery row. */
  async #drop(item: DeviceItem): Promise<WriteBatch> {
    const batch: WriteBatch = { deleteOutbox: [item.id] };
    if (item.purpose !== 'message') return batch;
    batch.deleteDeliveries = [{ messageId: item.messageId, deviceId: item.recipientDeviceId }];
    const message = await this.core.restate(item.messageId, [], [item.recipientDeviceId]);
    if (message) batch.messages = [message];
    return batch;
  }

  #retryLater<T extends FanoutItem | DeviceItem>(item: T, now: number): T {
    const attempts = item.attempts + 1;
    return {
      ...item,
      attempts,
      nextAttemptAt: now + backoffDelay(attempts, this.core.settings.retry),
    };
  }

  // Repair

  /**
   * After a peer device asked for a session reset: everything it has not confirmed goes out
   * again on the new session (the same envelope IDs, so the server and the device dedupe).
   *
   * A replacement phone (ADR 0022) also gets the recent direct messages that none of the
   * user's devices confirmed: they went to the lost phone, which will never read them.
   */
  async resendTo(userId: string, deviceId: string): Promise<void> {
    const { core } = this;
    await core.mutex.run(async () => {
      const now = core.now();
      const outbox: OutboxItem[] = [];
      const deliveries: DeliveryRecord[] = [];
      const queued = new Map<string, DeviceItem>();
      for (const item of await core.store.listOutbox()) {
        if (item.type === 'device' && item.recipientDeviceId === deviceId)
          queued.set(item.id, item);
      }
      // Still queued: encrypt again on the now preferred session (Megolm packets stay).
      for (const item of queued.values()) {
        if (item.packet && !item.megolm) outbox.push({ ...item, packet: null, nextAttemptAt: now });
      }
      const rows: DeliveryRecord[] = await core.store.listDeliveriesTo(deviceId, [
        'local_queued',
        'sending',
        'sent_to_server',
      ]);
      for (const row of rows) {
        if (row.own || row.userId !== userId) continue;
        const id = bytesToUuid(envelopeIdFor(row.messageId, deviceId));
        if (queued.has(id)) continue;
        const message: MessageRecord | undefined = await core.store.getMessage(row.messageId);
        if (message?.kind !== 'text' && message?.kind !== 'attachment') continue;
        if (message.expiresAt === null || message.expiresAt <= now) continue;
        // Group messages are Megolm: a device that lost one asks for the key instead.
        if ((await core.store.getConversation(message.conversationId))?.kind === 'group') continue;
        outbox.push(this.#resendItem(message, userId, deviceId, now));
      }
      if (userId !== core.self.userId) {
        const sent = new Set([...queued.keys(), ...outbox.map((item) => item.id)]);
        for (const message of await this.#unconfirmed(userId, now)) {
          const item = this.#resendItem(message, userId, deviceId, now);
          if (sent.has(item.id)) continue;
          const rows = await core.store.listDeliveries(message.messageId);
          if (rows.some((row) => row.deviceId === deviceId)) continue;
          outbox.push(item);
          deliveries.push({
            messageId: message.messageId,
            deviceId,
            userId,
            own: false,
            state: 'local_queued',
            updatedAt: now,
          });
        }
      }
      if (outbox.length > 0) await core.commit({ outbox, deliveries });
    });
    this.kick();
  }

  #resendItem(message: MessageRecord, userId: string, deviceId: string, now: number): DeviceItem {
    const { core } = this;
    return {
      type: 'device',
      purpose: 'message',
      id: bytesToUuid(envelopeIdFor(message.messageId, deviceId)),
      messageId: message.messageId,
      recipientUserId: userId,
      recipientDeviceId: deviceId,
      content:
        message.kind === 'attachment'
          ? attachmentContentFor(message, userId, core.settings.envelopeMaxBytes)
          : textContentFor(message, userId, core.settings.envelopeMaxBytes),
      packet: null,
      newSession: false,
      createdAt: message.createdAt,
      expiresAt: message.expiresAt ?? now + core.settings.maxRetentionMs,
      attempts: 0,
      nextAttemptAt: now,
    };
  }

  /**
   * Outgoing direct messages to `userId` still within the retention window that reached the
   * server but no device of theirs confirmed (newest first).
   */
  async #unconfirmed(userId: string, now: number): Promise<MessageRecord[]> {
    const { core } = this;
    const conversationId = core.directConversationId(userId);
    if (!(await core.store.getConversation(conversationId))) return [];
    const oldest = now - core.settings.maxRetentionMs;
    const out: MessageRecord[] = [];
    let before: MessageCursor | undefined;
    for (;;) {
      const page = await core.store.listMessages(conversationId, { before, limit: 200 });
      for (const message of page) {
        if (message.sortAt < oldest) return out;
        if (message.direction !== 'out') continue;
        if (message.kind !== 'text' && message.kind !== 'attachment') continue;
        if (message.state !== 'sent_to_server' && message.state !== 'relayed') continue;
        if (message.expiresAt === null || message.expiresAt <= now) continue;
        out.push(message);
      }
      if (page.length < 200) return out;
      const last = page.at(-1)!;
      before = { sortAt: last.sortAt, messageId: last.messageId };
    }
  }

  /** Asks `device` for a new session: a `SessionReset` on a freshly claimed session. */
  async requestReset(userId: string, deviceId: string, brokenSessionId?: string): Promise<void> {
    const { core } = this;
    await core.mutex.run(async () => {
      const now = core.now();
      const contentId = uuidv7();
      await core.commit({
        outbox: [
          {
            type: 'device',
            purpose: 'session_reset',
            id: bytesToUuid(envelopeIdFor(contentId, deviceId)),
            messageId: contentId,
            recipientUserId: userId,
            recipientDeviceId: deviceId,
            content: buildContent(
              {
                messageId: contentId,
                conversationId: core.directConversationId(userId),
                senderUserId: core.self.userId,
                recipientUserId: userId,
                sentAt: now,
              },
              { case: 'sessionReset', value: { sessionId: brokenSessionId ?? '' } },
              core.settings.envelopeMaxBytes,
            ),
            packet: null,
            newSession: true,
            createdAt: now,
            expiresAt: now + core.settings.maxRetentionMs,
            attempts: 0,
            nextAttemptAt: now,
          },
        ],
      });
    });
    this.kick();
  }
}
