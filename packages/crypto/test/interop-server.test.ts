/**
 * Runs the phone's interop flow against the dev interop server in-process (WASM on both
 * sides), so the protocol is checked in CI; the real proof runs the client on a phone.
 */
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createInteropServer } from '../scripts/interop-server';
import { INTEROP_STEPS, runInteropClient, type StepResult } from '../src/conformance/index';
import { createWasmCryptoProvider } from '../src/index';
import type { CryptoProvider } from '../src/index';

let provider: CryptoProvider;
let server: ReturnType<typeof createInteropServer>;
let baseUrl: string;

beforeAll(async () => {
  provider = await createWasmCryptoProvider();
  server = createInteropServer(provider, () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('phone ↔ Node interop protocol', () => {
  it('passes every step and persists the account after key changes', async () => {
    const steps: StepResult[] = [];
    let persisted = 0;
    const ok = await runInteropClient({
      provider,
      account: provider.createAccount(),
      persistAccount: () => {
        persisted++;
        return Promise.resolve();
      },
      baseUrl,
      fetch,
      onStep: (step) => steps.push(step),
    });
    expect(steps.filter((step) => !step.ok)).toEqual([]);
    expect(ok).toBe(true);
    expect(steps.map((step) => step.id)).toEqual(INTEROP_STEPS.map((step) => step.id));
    expect(persisted).toBe(2);
  });

  it('stops at the first failing step', async () => {
    const steps: StepResult[] = [];
    const ok = await runInteropClient({
      provider,
      account: provider.createAccount(),
      persistAccount: () => Promise.resolve(),
      baseUrl: `${baseUrl}/missing`,
      fetch,
      onStep: (step) => steps.push(step),
    });
    expect(ok).toBe(false);
    expect(steps).toEqual([expect.objectContaining({ id: 'olm-start', ok: false })]);
  });
});
