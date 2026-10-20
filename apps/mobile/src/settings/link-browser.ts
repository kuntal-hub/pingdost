// Linking a browser from the primary phone (REQ §13.1, ADR 0019): the scanned code names one
// pairing request and the browser's keys; the server shows what asked; on approval this phone's
// device key signs the pairing and the account identity key certifies the browser's keys
// (contacts then trust it without a safety-number change, ADR 0003). The browser finishes on
// its own by proving it holds those keys.
import type { PairingApi } from '@pingdost/api-client';
import type { OlmAccount, SigningKey } from '@pingdost/crypto/core';
import {
  deviceCertificateMessage,
  pairingApprovalMessage,
  parsePairingQr,
  ProtocolError,
  uuidv7,
  type PairingQr,
} from '@pingdost/protocol';
import type { ApprovePairingRequest, InspectPairingResponse } from '@pingdost/shared-types';

export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkError';
  }
}

/** Reads a scanned code; a code that is not a PingDost pairing code says so. */
export function readPairingCode(text: string): PairingQr {
  try {
    return parsePairingQr(text);
  } catch (error) {
    if (error instanceof ProtocolError) {
      throw new LinkError(
        'That is not a PingDost browser code. Open PingDost on the web and scan the code it shows.',
      );
    }
    throw error;
  }
}

export interface LinkRequest {
  qr: PairingQr;
  details: InspectPairingResponse;
}

/** Asks the server what the code is for, and checks it shows the same keys as the code. */
export async function inspectPairing(
  api: Pick<PairingApi, 'inspect'>,
  qr: PairingQr,
): Promise<LinkRequest> {
  const details = await api.inspect({ pairingId: qr.pairingId, challenge: qr.challenge });
  if (
    details.identityKeys.curve25519 !== qr.curve25519 ||
    details.identityKeys.ed25519 !== qr.ed25519
  ) {
    throw new LinkError('The server describes another browser than the code. Do not approve it.');
  }
  return { qr, details };
}

/** The approval this phone sends; `deviceId` is the browser's new device ID. */
export function approvalFor(
  qr: PairingQr,
  deviceId: string,
  account: OlmAccount,
  identity: SigningKey,
): ApprovePairingRequest {
  const webKeys = { curve25519: qr.curve25519, ed25519: qr.ed25519 };
  return {
    pairingId: qr.pairingId,
    challenge: qr.challenge,
    deviceId,
    webKeys,
    signature: account.sign(pairingApprovalMessage(qr.pairingId, qr.challenge, deviceId, webKeys)),
    deviceCertificate: identity.sign(deviceCertificateMessage(deviceId, webKeys)),
  };
}

export async function approvePairing(
  api: Pick<PairingApi, 'approve'>,
  qr: PairingQr,
  account: OlmAccount,
  identity: SigningKey,
): Promise<string> {
  const deviceId = uuidv7();
  await api.approve(approvalFor(qr, deviceId, account, identity));
  return deviceId;
}
