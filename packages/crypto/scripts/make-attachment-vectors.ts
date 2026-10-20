/**
 * Writes the attachment encryption vectors (`src/conformance/attachment.ts`) with the WASM
 * provider: `pnpm --filter @pingdost/crypto make-attachment-vectors`. Re-run only when the
 * attachment scheme changes (a new `scheme`, with a new file next to the old one).
 */
import { writeFileSync } from 'node:fs';

import { createAttachmentVectors } from '../src/conformance/index';
import { createWasmCryptoProvider } from '../src/index';

const provider = await createWasmCryptoProvider();
const target = new URL('../../test-fixtures/crypto/attachment-stream-v1.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(createAttachmentVectors(provider), null, 2)}\n`);
console.log(`wrote ${target.pathname}`);
