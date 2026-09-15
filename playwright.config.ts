import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const PREINSTALLED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const chromiumPath = process.env.CHROMIUM_PATH ?? (existsSync(PREINSTALLED) ? PREINSTALLED : '');

/**
 * The dev harness must work with no device, no camera and no network (CLAUDE.md), so
 * the e2e check is exactly that: a headless browser, manual TC entry, and a reload to
 * prove the sql.js database really reached IndexedDB.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'list' : [['list']],
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    // Portrait, one hand (§9).
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // This environment ships Chromium at /opt/pw-browsers (build 1194) and
          // blocks `playwright install`. Point at it rather than downloading a build
          // matched to whatever @playwright/test resolves to. Override with
          // CHROMIUM_PATH, or unset it to let Playwright resolve normally.
          ...(chromiumPath ? { executablePath: chromiumPath } : {}),
        },
      },
    },
  ],
  webServer: {
    command: 'npx vite --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
