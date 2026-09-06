import { defineConfig } from "@playwright/test";

/**
 * Electron end-to-end. `_electron.launch` drives the app's own Chromium, so no
 * browser download is needed — hence no `projects` with a browser name and no
 * `npx playwright install`.
 *
 * Not a `webServer` config either: the app under test is the built desktop
 * bundle plus the built renderer, and `corepack pnpm e2e` builds both first.
 *
 * `globalSetup` puts the whole run on isolated backend homes before any worker
 * starts, so `corepack pnpm e2e` never reads or writes `~/.claude` or
 * `~/.codex` and never inherits a personal provider key. Live tests skip on a
 * disposable home; to run them, point `CAPYGEN_TEST_CLAUDE_HOME` and
 * `CAPYGEN_TEST_CODEX_HOME` at persistent, separately authenticated test
 * identities (`tests/e2e/testPolicy.ts`).
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // Returns its own cleanup closure; there is deliberately no globalTeardown
  // file, so no path can reach the run's `rm -rf` through the environment.
  globalSetup: "./tests/e2e/globalSetup.ts",
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
