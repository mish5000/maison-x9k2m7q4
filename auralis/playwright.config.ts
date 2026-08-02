import { existsSync } from 'node:fs';

import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * The suite runs against the production build of the client served by the API
 * process, with the bundled fixture origin providing real audio. Nothing is
 * mocked in the browser: the page performs real searches over real SSE.
 */

const CHROMIUM_PATH =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ??
  (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
    ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
    : undefined);

const API_PORT = 5185;
const FIXTURE_PORT = 5186;
const BASE_URL = `http://127.0.0.1:${API_PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // This environment ships a pre-installed Chromium whose build number may
    // not match the one this Playwright version expects, so it is pointed at
    // explicitly rather than downloaded. PLAYWRIGHT_CHROMIUM_PATH overrides it.
    launchOptions: {
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
    },
  },

  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        channel: undefined,
      },
    },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel: undefined } },
  ],

  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: `${BASE_URL}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'development',
      AURALIS_PORT: String(API_PORT),
      AURALIS_FIXTURE_ORIGIN_PORT: String(FIXTURE_PORT),
      AURALIS_ALLOW_PRIVATE_EGRESS: 'true',
      AURALIS_ALLOW_INSECURE_HTTP: 'true',
      AURALIS_SERVE_WEB: 'true',
      AURALIS_WEB_DIST: 'packages/web/dist',
      AURALIS_DATABASE_PATH: './data/e2e.db',
      AURALIS_FIXTURE_DIR: './data/e2e-fixtures',
      AURALIS_LOG_LEVEL: 'error',
      AURALIS_SESSION_SECRET: 'e2e-session-secret-that-is-long-enough-here',
    },
  },
});
