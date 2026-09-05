import { fileURLToPath } from "node:url";
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
      {
        // [capygen] Task B3: render tests for apps/renderer/src/brand/**.
        // `environment: "node"` + `react-dom/server` (SSR string rendering)
        // instead of jsdom + @testing-library, so brand's tests need no new
        // dependency and no renderer-wide vitest project. `esbuild.jsx` is
        // set explicitly because this project has no @vitejs/plugin-react to
        // infer it from (apps/renderer/vite.config.ts is not loaded here).
        esbuild: { jsx: "automatic" },
        test: {
          name: "renderer-brand",
          root: "./apps/renderer",
          environment: "node",
          include: ["src/brand/**/*.test.tsx"],
        },
      },
      {
        // [capygen] Task B2: component tests for the rest of the renderer
        // (composer, transcript, block cards, sidebar, store). jsdom +
        // @testing-library/react, unlike the brand project above — these
        // components use real DOM events (keydown, click, focus) that SSR
        // string rendering can't exercise. `src/brand/**` is excluded so the
        // two projects never double-run the same file.
        esbuild: { jsx: "automatic" },
        test: {
          name: "renderer",
          root: "./apps/renderer",
          environment: "jsdom",
          setupFiles: ["./src/test/setup.ts"],
          include: ["src/**/*.test.tsx", "src/**/*.test.ts"],
          exclude: ["src/brand/**"],
        },
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./apps/renderer/src", import.meta.url)),
          },
        },
      },
    ],
  },
});
