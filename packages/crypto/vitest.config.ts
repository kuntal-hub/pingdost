import { defineProject } from 'vitest/config';

// Unit and interop tests (WASM in Node). `*.int.test.ts` files run via `pnpm test:int`.
export default defineProject({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/*.int.test.ts'],
  },
});
