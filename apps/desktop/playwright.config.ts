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
  // The packaged Electron binary can take ~45-60s just to open its first window
  // under CI's headless Xvfb (an identical binary launched in one run, timed out
  // at 45s in others), so give the whole test generous headroom over that.
  timeout: 120_000,
  use: {
    trace: "retain-on-failure",
  },
});
