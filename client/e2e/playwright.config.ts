import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

export default defineConfig({
  fullyParallel: false,
  forbidOnly: CI,
  retries: 0,
  workers: 1,
  reporter: CI ? 'blob' : [['html', { open: 'never' }]],
  timeout: 120_000,
  outputDir: './test-results',

  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:4080',
    trace: 'on',
    screenshot: 'on',
    video: 'retain-on-failure',
    // Fail fast on a missing/stale locator instead of hanging until the
    // per-test timeout. Explicit `expect(...).toBeVisible({ timeout })` calls
    // override this for known-slow waits (encryption, voice connect).
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'setup',
      testDir: '.',
      testMatch: /global-setup\.ts/,
      teardown: 'teardown',
    },
    {
      name: 'teardown',
      testDir: '.',
      testMatch: /global-teardown\.ts/,
    },
    {
      name: 'chromium',
      testDir: './journeys',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['clipboard-read', 'clipboard-write'],
      },
      dependencies: ['setup'],
    },
  ],
});
