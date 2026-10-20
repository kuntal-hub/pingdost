/**
 * A simulated primary phone for web pairing checks (Phase 16, ADR 0019): it registers a
 * headless account, approves the browser whose pairing code you pass (what the phone's scanner
 * reads), and can revoke it later. In `vite dev` the web app shows the code as text under the
 * QR code.
 *
 *   pnpm --filter @pingdost/sim-client phone -- --code 'pingdost-pair:v1:…' [--revoke-after 30]
 */
import { parseArgs } from 'node:util';

import { devicesApi } from '@pingdost/api-client';
import { createWasmCryptoProvider } from '@pingdost/crypto';

import { SimClient } from './client';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:3000' },
    mailpit: { type: 'string', default: 'http://127.0.0.1:8025' },
    code: { type: 'string' },
    'revoke-after': { type: 'string', default: '0' },
  },
});
const api = values.api.replace(/\/+$/, '');
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  if (!values.code) throw new Error("pass the browser's pairing code: --code 'pingdost-pair:v1:…'");
  const phone = await SimClient.register({
    endpoints: { api, ws: `${api.replace(/^http/, 'ws')}/v1/ws`, mailpit: values.mailpit },
    crypto: await createWasmCryptoProvider(),
  });
  console.log(`phone ready: username ${phone.username}`);
  const deviceId = await phone.approveBrowser(values.code);
  console.log(`approved; the browser becomes device ${deviceId}`);

  const devices = devicesApi(phone.api);
  for (let i = 0; i < 60; i++) {
    const browser = (await devices.list()).find((d) => d.deviceId === deviceId);
    if (browser?.status === 'active') {
      console.log(`linked: ${browser.name} (${browser.platform}, ${browser.role})`);
      break;
    }
    await wait(1_000);
  }

  const revokeAfter = Number(values['revoke-after']);
  if (revokeAfter > 0) {
    await wait(revokeAfter * 1_000);
    await devices.revoke(deviceId);
    console.log('revoked the browser');
  }
  await phone.stop();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
