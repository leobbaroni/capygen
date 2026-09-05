import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The renderer is loaded two ways: from this dev server (main reads
 * CAPYGEN_DEV_URL) and from `dist/index.html` via `file://` in the built app.
 * `base: "./"` is what makes the second case work — absolute asset URLs would
 * resolve against the filesystem root.
 */
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "chrome138",
  },
});
