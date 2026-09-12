import { defineConfig, devices } from "@playwright/test";

const externalBaseURL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
const baseURL = externalBaseURL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    // 表示言語を日本語に固定する。ブラウザのロケールを固定しないと、OSロケールが
    // en の環境 (CI / Linux) でアプリが英語UIで起動し、日本語をアサートしている
    // 既存 spec が一斉に落ちる。
    locale: "ja-JP",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: externalBaseURL ? undefined : {
    command: "npm run dev -- --hostname 127.0.0.1",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
