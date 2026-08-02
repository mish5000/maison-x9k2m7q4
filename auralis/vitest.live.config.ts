import { defineConfig } from 'vitest/config';

/**
 * The opt-in live suite. These tests talk to real third-party services, so they
 * are excluded from the default run: a public API being slow or down must never
 * be able to fail this project's build.
 *
 * Run with: npm run test:live
 */
export default defineConfig({
  test: {
    include: ['packages/*/tests/live/**/*.live.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    retry: 1,
  },
  esbuild: { target: 'node22' },
});
