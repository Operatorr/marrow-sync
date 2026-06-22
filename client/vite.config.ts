// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vite config for the Marrow desktop UI (SPEC §3). Tuned for Tauri: a fixed dev
 * port Tauri's `devUrl` points at, no screen-clearing so Rust build logs stay
 * visible, and a `TAURI_`/`VITE_` env prefix so only intentionally-exposed vars
 * reach the bundle.
 */

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  server: {
    port: 1420,
    strictPort: true,
    host: false,
  },
  build: {
    target: "esnext",
    outDir: "dist",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
