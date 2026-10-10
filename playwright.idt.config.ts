import { defineConfig, devices } from '@playwright/test';

const port = 3000;
const baseURL = process.env.IDT_BASE_URL || `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e/generated',
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['html'], ['github']] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'Desktop Chrome', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: process.env.CI ? 'pnpm start' : 'pnpm dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
