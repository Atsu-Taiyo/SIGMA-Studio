import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // DOM editors, parsers and real filesystem suites share the host. Bound
    // concurrency so a high CPU count does not turn the 5s timeout into noise.
    maxWorkers: 4,
    // Playwright の spec は vitest から見えてはいけない (test.describe が別実装で落ちる)。
    // tests/electron/** は Electron 実機スモーク (playwright.electron.config.ts)。
    exclude: [...configDefaults.exclude, "tests/e2e/**", "tests/electron/**"],
    globals: true,
    setupFiles: [fileURLToPath(new URL("./vitest.setup.ts", import.meta.url))],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    fs: {
      allow: [fileURLToPath(new URL("../../", import.meta.url))],
    },
  },
});
