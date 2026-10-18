/**
 * Writes the golden protocol vectors (`src/vectors.ts`):
 * `pnpm --filter @pingdost/protocol make-vectors`. Re-run only for a deliberate wire change,
 * then review the diff of the JSON file.
 */
import { writeFileSync } from 'node:fs';

import { createVectors } from '../src/vectors';

const target = new URL('../../test-fixtures/protocol/v1.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(createVectors(), null, 2)}\n`);
console.log(`wrote ${target.pathname}`);
