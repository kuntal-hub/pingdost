/**
 * The receive pipeline (REQ §8.1, §8.3; ARCHITECTURE A3). Packets are handled one at a time,
 * in arrival order:
 * 1. decode the envelope; drop duplicates by envelope ID;
 * 2. find the sending device in its owner's verified directory (asking the server who owns
 *    an unknown device); offline, the packet stays unacknowledged and is redelivered later;
 * 3. decrypt (pre-key routing in `SessionManager`); a failure asks the device for a new
 *    session, rate-limited;
 * 4. check the header, dedupe by message ID, then persist the message, the advanced session,
 *    the seen IDs and the receipt to send in one batch;
 * 5. transport ACK, only after the batch is stored;
 * 6. events (via the commit), then the receipt goes out with the next outbox pass.
 */
import {
  bytesToUuid,
  CryptoType,
  decodeContent,
  decodeContentHeader,
  decodeEnvelope,
  ProtocolError,
  Receipt_Type,
  type Content,
  type ContentHeader,
  type Envelope,
  type TransportPacket,
} from '@pingdost/protocol';

import { checkHeader, type CheckedHeader } from './content';
import { EngineCore } from './core';
import type { Outbox } from './outbox';
import type { RemoteDevice } from './sessions';
import type { DeliveryRecord, MessageRecord, ReceiptItem, WriteBatch } from './store';

type Effect = () => void | Promise<void>;

export class Receiver {
  #queue: Promise<void> = Promise.resolve();
  /** When this device last asked each remote device for a session reset. */
  readonly #resets = new Map<string, number>();

  constructor(
    private readonly core: EngineCore,
    private readonly outbox: Outbox,
  ) {}

  /** Queues a packet; `ack` is called once it is stored (or known to be useless). */
  handle(packet: TransportPacket, ack: () => void): void {
    this.#queue = this.#queue
      .then(() => this.#process(packet, ack))
      .catch((error: unknown) => {
        // Not acknowledged: the mailbox delivers it again on the next connection.
        this.core.log('error', 'receive failed', { error: String(error) });
      });
  }

  /** Resolves once every queued packet is handled. */
  idle(): Promise<void> {
    return this.#queue;
  }

  async #process(packet: TransportPacket, ack: () => void): Promise<void> {
    const { core } = this;
    let envelope: Envelope;
    try {
      envelope = decodeEnvelope(packet.payload, {
        envelopeMaxBytes: core.settings.envelopeMaxBytes,
      });
    } catch {
      ack(); // can never be read
      return;
    }
    const envelopeId = bytesToUuid(envelope.envelopeId);
    if (
      bytesToUuid(envelope.recipientDeviceId) !== core.self.deviceId ||
      envelope.cryptoType === CryptoType.MEGOLM // groups arrive in Phase 13
    ) {
      ack();
      return;
    }
    if (await core.store.hasSeen(envelopeId)) {
      ack();
      return;
    }

    const senderDeviceId = bytesToUuid(envelope.senderDeviceId);
    const owner = await core.ownerOf(senderDeviceId);
    if (owner.status === 'unavailable') return; // retried on the next connection
    if (owner.status === 'unknown') {
      core.log('warn', 'envelope from an unknown or unverified device');
      ack();
      return;
    }
    const sender: RemoteDevice = {
      deviceId: senderDeviceId,
      userId: owner.userId,
      curve25519: owner.device.curve25519,
    };

    const effects = await core.mutex.run(() => this.#decryptAndStore(envelope, envelopeId, sender));
    ack();
    for (const effect of effects) await effect();
  }

  async #decryptAndStore(
    envelope: Envelope,
    envelopeId: string,
    sender: RemoteDevice,
  ): Promise<Effect[]> {
    const { core } = this;
    if (await core.store.hasSeen(envelopeId)) return [];
    const now = core.now();
    const result = await core.sessions.decrypt(
      sender,
      {
        type: envelope.cryptoType === CryptoType.OLM_PREKEY ? 'prekey' : 'normal',
        body: envelope.ciphertext,
      },
      now,
    );
    if (!result.ok) {
      // Not marked seen: after the repair, the sender resends it under the same envelope ID.
      return [() => this.#undecryptable(sender, result.sessionId)];
    }

    const batch: WriteBatch = {
      sessions: [result.session],
      seen: [{ id: envelopeId, seenAt: now }],
    };
    if (result.accountChanged) batch.account = core.accountPickle();
    const effects = await this.#interpret(result.plaintext, sender, batch, now);
    await core.commit(batch);
    // A receipt was queued: the outbox batches it after `receiptDelayMs`.
    if (batch.outbox?.length) effects.push(() => this.outbox.kick());
    return effects;
  }

  async #interpret(
    plaintext: Uint8Array,
    sender: RemoteDevice,
    batch: WriteBatch,
    now: number,
  ): Promise<Effect[]> {
    const { core } = this;
    let content: Content | undefined;
    let header: ContentHeader;
    try {
      content = decodeContent(plaintext, { envelopeMaxBytes: core.settings.envelopeMaxBytes });
      header = content.header!;
    } catch (error) {
      if (!(error instanceof ProtocolError) || error.code !== 'UNKNOWN_BODY') {
        core.log('warn', 'undecodable content', {
          code: error instanceof ProtocolError ? error.code : 'unknown',
        });
        return [];
      }
      // A body from a newer version: keep a placeholder ("update needed").
      header = decodeContentHeader(plaintext, { envelopeMaxBytes: core.settings.envelopeMaxBytes });
    }
    const checked = checkHeader(header, sender, core.self.userId);
    if (!checked) {
      core.log('warn', 'content header rejected');
      return [];
    }
    if (await core.store.hasSeen(checked.messageId)) return [];
    batch.seen!.push({ id: checked.messageId, seenAt: now });

    const body = content?.body;
    switch (body?.case) {
      case undefined:
        await this.#storeMessage(batch, checked, sender, 'unsupported', '', now);
        return [];
      case 'text':
        await this.#storeMessage(batch, checked, sender, 'text', body.value.body, now);
        return [];
      case 'receipt':
        if (checked.senderUserId !== core.self.userId) {
          await this.#applyReceipt(
            batch,
            sender,
            body.value.type === Receipt_Type.READ ? 'read' : 'delivered_to_recipient_device',
            body.value.messageIds,
            now,
          );
        }
        return [];
      case 'sessionReset':
        return [() => this.outbox.resendTo(sender.userId, sender.deviceId)];
      case 'keyChange':
        return [() => void core.refreshDirectory(sender.userId)];
      default:
        // Reactions, edits and the rest arrive with their phases (11, 13, 14, 18, 25).
        return [];
    }
  }

  async #storeMessage(
    batch: WriteBatch,
    header: CheckedHeader,
    sender: RemoteDevice,
    kind: MessageRecord['kind'],
    text: string,
    now: number,
  ): Promise<void> {
    const { core } = this;
    // From this user's other device: a copy of something this user sent.
    const own = header.senderUserId === core.self.userId;
    const peerUserId = own ? header.recipientUserId! : header.senderUserId;
    const conversation =
      (await core.store.getConversation(header.conversationId)) ??
      core.newConversation(peerUserId, now);
    const message: MessageRecord = {
      messageId: header.messageId,
      conversationId: header.conversationId,
      senderUserId: header.senderUserId,
      senderDeviceId: sender.deviceId,
      direction: own ? 'out' : 'in',
      kind,
      body: text,
      replyTo: header.replyTo,
      sentAt: header.sentAt,
      // A sender clock ahead of ours must not pin the message below newer ones.
      sortAt: Math.min(header.sentAt, now),
      createdAt: now,
      // The sending device tracks delivery; this copy only knows the server had it.
      state: own ? 'sent_to_server' : null,
      expiresAt: null,
    };
    const latest = message.sortAt >= conversation.updatedAt;
    batch.messages = [...(batch.messages ?? []), message];
    batch.conversations = [
      {
        ...conversation,
        updatedAt: Math.max(conversation.updatedAt, message.sortAt),
        lastMessageId: latest ? message.messageId : conversation.lastMessageId,
        unreadCount: conversation.unreadCount + (own ? 0 : 1),
      },
    ];
    if (!own && (core.options.receipts?.('delivered') ?? true)) {
      const receipt: ReceiptItem = {
        type: 'receipt',
        receipt: 'delivered',
        id: `receipt:delivered:${message.messageId}:${sender.deviceId}`,
        messageId: message.messageId,
        recipientUserId: sender.userId,
        recipientDeviceId: sender.deviceId,
        createdAt: now,
        expiresAt: now + core.settings.maxRetentionMs,
        attempts: 0,
        nextAttemptAt: now,
      };
      batch.outbox = [...(batch.outbox ?? []), receipt];
    }
  }

  /**
   * Only a receipt from a recipient device of the message counts; receipts from the sender's
   * own devices, or for messages this device did not send, change nothing.
   */
  async #applyReceipt(
    batch: WriteBatch,
    sender: RemoteDevice,
    state: 'delivered_to_recipient_device' | 'read',
    messageIds: Uint8Array[],
    now: number,
  ): Promise<void> {
    const { core } = this;
    const ids = new Set<string>();
    for (const bytes of messageIds) {
      try {
        ids.add(bytesToUuid(bytes));
      } catch {
        // not an ID: skip it
      }
    }
    for (const messageId of ids) {
      const row = (await core.store.listDeliveries(messageId)).find(
        (d) => d.deviceId === sender.deviceId && d.userId === sender.userId && !d.own,
      );
      if (!row) continue;
      const moved: DeliveryRecord | undefined = EngineCore.moved(row, state, now);
      if (!moved) continue;
      batch.deliveries = [...(batch.deliveries ?? []), moved];
      // Delivered before the server's answer came: nothing left to send.
      (batch.deleteOutbox ??= []).push(...(await this.#queuedFor(messageId, sender.deviceId)));
      const message = await core.restate(messageId, [moved]);
      if (message) batch.messages = [...(batch.messages ?? []), message];
    }
  }

  async #queuedFor(messageId: string, deviceId: string): Promise<string[]> {
    const items = await this.core.store.listOutbox();
    return items
      .filter(
        (item) =>
          item.type === 'device' &&
          item.messageId === messageId &&
          item.recipientDeviceId === deviceId,
      )
      .map((item) => item.id);
  }

  async #undecryptable(sender: RemoteDevice, sessionId: string | undefined): Promise<void> {
    const { core } = this;
    core.events.emit({ type: 'decrypt_failed', userId: sender.userId, deviceId: sender.deviceId });
    const last = this.#resets.get(sender.deviceId) ?? -Infinity;
    const now = core.now();
    if (now - last < core.settings.sessionResetIntervalMs) return;
    this.#resets.set(sender.deviceId, now);
    core.log('warn', 'undecryptable envelope: requesting a new session');
    await this.outbox.requestReset(sender.userId, sender.deviceId, sessionId);
  }
}
