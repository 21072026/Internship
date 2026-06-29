import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config.
 *
 * - Local default: starts the dev server and tests http://localhost:3000.
 *   Run headed to watch: `npm run test:e2e -- --headed`.
 * - CI: builds + `next start`, runs headless against localhost.
 * - Against a deployed env: set BASE_URL (e.g. BASE_URL=https://crm-preview.ersah.in),
 *   which skips the local webServer and tests the remote URL.
 */
const externalBase = process.env.BASE_URL;
const PORT = 3000;
const localURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: externalBase || localURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // Returning-visitor state: consent already given so the banner stays hidden
    // and never overlaps page actions. legal-consent.spec overrides this.
    storageState: './e2e/.state/consent.json',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Only spin up the app locally; when BASE_URL targets a deployed env, skip it.
  webServer: externalBase
    ? undefined
    : {
        command: process.env.CI ? 'npm run start' : 'npm run dev',
        url: localURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
