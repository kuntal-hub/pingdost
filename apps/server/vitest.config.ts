import { defineProject } from 'vitest/config';

// Unit tests only. `*.int.test.ts` files run via `pnpm test:int` against docker-compose.
export default defineProject({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
  },
});
