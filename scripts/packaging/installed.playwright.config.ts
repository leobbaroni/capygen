import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../../tests",
  testMatch: "installed-smoke.spec.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../../e2e-out/installed-artifacts",
});
