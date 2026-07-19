import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: true,
  // Retry on CI to absorb residual flakiness in the packaged Electron launch
  // under Xvfb (the GPU/shm launch flags below are the primary mitigation).
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  timeout: 45_000,
  use: {
    trace: "retain-on-failure",
  },
});
