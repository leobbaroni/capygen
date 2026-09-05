import { defineConfig } from "@playwright/test";

/**
 * Electron end-to-end. `_electron.launch` drives the app's own Chromium, so no
 * browser download is needed — hence no `projects` with a browser name and no
 * `npx playwright install`.
 *
 * Not a `webServer` config either: the app under test is the built desktop
 * bundle plus the built renderer, and `corepack pnpm e2e` builds both first.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Electron windows are singletons per user-data-dir; one worker keeps the
  // isolated profiles from racing each other.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  outputDir: "e2e-out/artifacts",
});
