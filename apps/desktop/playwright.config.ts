import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: true,
  // One retry on CI absorbs occasional Electron startup jitter under Xvfb.
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  // Dev Electron boots the bundled renderer in a few seconds under Xvfb; the
  // headroom here just covers cold-cache first launches on CI runners.
  timeout: 60_000,
  use: {
    trace: "retain-on-failure",
  },
});
