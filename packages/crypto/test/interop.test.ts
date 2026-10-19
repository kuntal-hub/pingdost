/**
 * Phase 2 crypto gate: the conformance scenarios (`src/conformance/scenarios.ts`) through the
 * WASM CryptoProvider in Node. The phone runs the same scenarios on its native provider.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { runScenarios, scenarios } from '../src/conformance/index';
import { createWasmCryptoProvider } from '../src/index';
import type { CryptoProvider } from '../src/index';

let provider: CryptoProvider;

beforeAll(async () => {
  provider = await createWasmCryptoProvider();
});

describe('conformance scenarios (WASM)', () => {
  it.each(scenarios.map((scenario) => [`${scenario.id}. ${scenario.title}`, scenario] as const))(
    '%s',
    (_name, scenario) => {
      scenario.run(provider);
    },
  );

  it('reports a failure when the provider misbehaves', () => {
    const lying: CryptoProvider = { ...provider, verifyEd25519: () => true };
    const failed = runScenarios(lying).filter((step) => !step.ok);
    expect(failed.map((step) => step.id)).toEqual(['sig', 'idk']);
    expect(failed[0]?.detail).toContain('check failed');
  });
});
