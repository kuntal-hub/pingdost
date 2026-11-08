/**
 * Deleting an account (Phase 27, ADR 0036; Google Play requires an in-app path). An email code
 * confirms it, then everything tied to the account goes:
 * - every device is revoked (its live socket is told, so the apps wipe themselves; keys,
 *   sessions and push tokens go with it) and its mailbox is emptied;
 * - the account leaves its groups (an owner hands over, as when leaving);
 * - blocks both ways, pending pairing and phone-transfer requests, email codes, sessions,
 *   device records, and last the account record itself.
 * The account record goes last, so a failure part-way can be retried with a new code.
 * Not removed here: envelopes this account already sent to other people (they are theirs,
 * and expire with the retention), abuse reports (their own retention), the `account_delete`
 * security event (its own retention), and a profile picture on Cloudinary (ADR 0036).
 */
import type { Collection } from 'mongodb';

import type { Clock } from '../../infra/clock';
import { AppError } from '../../infra/errors';
import type { AuthCollections } from '../auth/repo';
import type { AuthService } from '../auth/service';
import type { DeliveryService } from '../delivery/service';
import type { PrimaryTransferDoc } from '../device/primary-transfer';
import type { DeviceCollections } from '../device/repo';
import type { DeviceService } from '../device/service';
import type { GroupService } from '../groups/service';
import type { PairingDoc } from '../pairing/repo';
import type { BlockService } from '../security/blocks';
import type { RequestContext, SecurityEvents } from '../security/events';

export interface AccountDeletionDeps {
  auth: AuthCollections;
  authService: Pick<AuthService, 'sendAccountOtp' | 'checkAccountOtp'>;
  devices: DeviceCollections;
  deviceService: Pick<DeviceService, 'revokeDevice'>;
  groups: Pick<GroupService, 'list' | 'removeMember'>;
  blocks: Pick<BlockService, 'removeUser'>;
  delivery: Pick<DeliveryService, 'purgeDevice'>;
  pairingRequests: Collection<PairingDoc>;
  primaryTransfers: Collection<PrimaryTransferDoc>;
  events: Pick<SecurityEvents, 'record'>;
  clock: Clock;
}

export class AccountDeletion {
  constructor(private readonly d: AccountDeletionDeps) {}

  /** Emails the confirmation code to the account's address. */
  sendCode(userId: string): Promise<void> {
    return this.d.authService.sendAccountOtp(userId, 'delete_account');
  }

  async delete(userId: string, otp: string, context: RequestContext): Promise<void> {
    const user = await this.d.auth.users.findOne({ _id: userId, status: 'active' });
    if (!user) throw new AppError('FORBIDDEN');
    await this.d.authService.checkAccountOtp(userId, 'delete_account', otp, context);

    const devices = await this.d.devices.devices.find({ userId }).toArray();
    for (const device of devices) {
      if (device.status === 'active') await this.d.deviceService.revokeDevice(device, context);
      await this.d.delivery.purgeDevice(device._id);
    }
    for (const group of await this.d.groups.list(userId)) {
      await this.d.groups.removeMember(userId, group.groupId, userId).catch((error: unknown) => {
        // Another change removed it or the group meanwhile.
        if (!(error instanceof AppError && ['NOT_FOUND', 'NOT_A_MEMBER'].includes(error.code))) {
          throw error;
        }
      });
    }
    await this.d.blocks.removeUser(userId);
    await this.d.pairingRequests.deleteMany({ userId });
    await this.d.primaryTransfers.deleteMany({ userId });
    await this.d.auth.otps.deleteMany({ email: user.email });
    await this.d.auth.sessions.deleteMany({ userId });
    await this.d.devices.devices.deleteMany({ userId });
    await this.d.auth.users.deleteOne({ _id: userId });
    await this.d.events.record('account_delete', context, userId);
  }
}
