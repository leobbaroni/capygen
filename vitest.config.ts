import { defineConfig } from "vitest/config";

/**
 * One vitest run across the workspace. Each package is a project so failures
 * name where they came from, and so a browser-ish project (the renderer) can
 * pick jsdom without dragging the node packages into it.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "shared",
          root: "./packages/shared",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "db",
          root: "./packages/db",
          environment: "node",
          include: ["test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "desktop",
          root: "./apps/desktop",
          environment: "node",
          include: ["test/**/*.test.ts"],
        },
      },
    ],
  },
});
