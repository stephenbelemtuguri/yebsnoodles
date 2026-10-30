const { defineConfig, devices } = require('@playwright/test');

const port = 3188;

module.exports = defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  timeout: 30000,
  expect: {
    timeout: 7000
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    ...(process.env.PLAYWRIGHT_BROWSER ? { channel: process.env.PLAYWRIGHT_BROWSER } : {}),
    ...devices['Desktop Chrome']
  },
  webServer: {
    command: 'node scripts/playwright-test-server.js',
    url: `http://127.0.0.1:${port}/index.html`,
    reuseExistingServer: false,
    timeout: 60000
  }
});
