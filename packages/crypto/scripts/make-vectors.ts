/**
 * Writes the deterministic crypto vectors (`src/conformance/vectors.ts`) with the WASM
 * provider: `pnpm --filter @pingdost/crypto make-vectors`. Re-run only when the vodozemac
 * version changes, and commit the new file next to the old one.
 */
import { writeFileSync } from 'node:fs';

import { createVectors } from '../src/conformance/index';
import { createWasmCryptoProvider } from '../src/index';

const provider = await createWasmCryptoProvider();
const target = new URL('../../test-fixtures/crypto/vodozemac-0.11.1.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(createVectors(provider), null, 2)}\n`);
console.log(`wrote ${target.pathname}`);
