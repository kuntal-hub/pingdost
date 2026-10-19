/**
 * A simulated account with one primary device: registration with the email code read from
 * Mailpit, then device registration with real keys (the server checks the signatures).
 * Message payloads stay fake: real E2EE arrives in Phase 9.
 */
import { randomUUID } from 'node:crypto';

import { authApi, createApiClient, devicesApi, type ApiClient } from '@pingdost/api-client';
import type { CryptoProvider } from '@pingdost/crypto';
import { uuidv7 } from '@pingdost/protocol/ids';
import { deviceCertificateMessage, deviceRegistrationMessage } from '@pingdost/protocol/signing';

export interface SimDevice {
  username: string;
  userId: string;
  deviceId: string;
  /** Device-bound access token. Secret: never printed. */
  accessToken: string;
}

export interface Endpoints {
  api: string;
  mailpit: string;
}

async function otpFor(mailpit: string, email: string): Promise<string> {
  const query = encodeURIComponent(`to:"${email}"`);
  for (let attempt = 0; attempt < 50; attempt++) {
    const search = (await (await fetch(`${mailpit}/api/v1/search?query=${query}`)).json()) as {
      messages: { ID: string }[];
    };
    const newest = search.messages[0];
    if (newest) {
      const message = (await (await fetch(`${mailpit}/api/v1/message/${newest.ID}`)).json()) as {
        Text: string;
      };
      const code = /\b(\d{6})\b/.exec(message.Text)?.[1];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no verification email for ${email} in Mailpit`);
}

export async function createDevice(
  endpoints: Endpoints,
  crypto: CryptoProvider,
): Promise<SimDevice> {
  const bearer: { token?: string } = {};
  const client: ApiClient = createApiClient({
    baseUrl: endpoints.api,
    getAccessToken: () => bearer.token,
  });
  const auth = authApi(client);
  const devices = devicesApi(client);

  const id = randomUUID().replaceAll('-', '').slice(0, 10);
  const username = `sim_${id}`;
  const email = `${username}@sim.pingdost.localhost`;
  await auth.register({ username, email, password: `sim password ${id}` });
  const session = await auth.verifyEmail({ email, otp: await otpFor(endpoints.mailpit, email) });
  bearer.token = session.tokens.accessToken;

  const account = crypto.createAccount();
  const identity = crypto.createSigningKey();
  const deviceId = uuidv7();
  const keys = account.identityKeys();
  const { nonce } = await devices.challenge();
  const { tokens } = await devices.register({
    deviceId,
    platform: 'android',
    name: 'sim-client',
    identityKeys: keys,
    nonce,
    signature: account.sign(deviceRegistrationMessage(nonce, deviceId, keys)),
    deviceCertificate: identity.sign(deviceCertificateMessage(deviceId, keys)),
    accountIdentityKey: identity.publicKey(),
  });
  account.dispose();
  identity.dispose();
  return { username, userId: session.user.userId, deviceId, accessToken: tokens.accessToken };
}
