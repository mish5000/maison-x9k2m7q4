import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**', '**/tests/live/**'],
    environment: 'node',
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Provider adapters and the fixture origin bind real sockets; one fork
    // keeps port usage predictable and makes failures reproducible.
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts', 'packages/server/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/testing/**', '**/fixtures/origin-cli.ts', '**/main.ts'],
    },
  },
  esbuild: { target: 'node22' },
});
