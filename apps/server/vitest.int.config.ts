import { defineProject } from 'vitest/config';

// Integration tests against docker-compose (`pnpm infra:up`): Mongo, Valkey and Mailpit.
// Each test file uses its own Mongo database and unique email addresses.
export default defineProject({
  test: {
    include: ['src/**/*.int.test.ts', 'test/**/*.int.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
