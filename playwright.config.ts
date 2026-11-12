import { defineConfig, devices } from '@playwright/test';

// E2E smoke: boots the real Next.js dev server and drives the actual
// terminal UI — home, orderflow workspace, forecast view, storage APIs.
// Local: `bunx playwright test` (reuses a server already on :3000).
// CI: separate job with chromium installed first.

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'bun run dev',
        url: 'http://localhost:3000',
        timeout: 180_000,
        reuseExistingServer: !process.env.CI,
        env: { DATABASE_URL: 'file:./db/custom.db' },
      },
});
