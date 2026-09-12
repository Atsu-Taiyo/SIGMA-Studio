import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  outputDir: fileURLToPath(new URL("../../test-results/public-browser/", import.meta.url)),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4178",
    locale: "ja-JP",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // Exercise the public packages and example's production output, including
    // React 18 and emitted assets. Build the example before running this suite.
    command: "npm --workspace @sigma-studio/editor-react18-example exec -- vite preview --host 127.0.0.1 --port 4178 --strictPort",
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    url: "http://127.0.0.1:4178",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
