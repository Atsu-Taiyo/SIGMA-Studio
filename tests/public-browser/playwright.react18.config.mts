import { defineConfig } from "@playwright/test";
import config from "./playwright.config.mjs";

export default defineConfig({
  ...config,
  projects: [{ name: "react18" }],
  outputDir: "../../test-results/public-browser-react18",
  use: { ...config.use, baseURL: "http://127.0.0.1:4179" },
  webServer: {
    ...(Array.isArray(config.webServer) ? config.webServer[0] : config.webServer),
    command: "npm --workspace @sigma-studio/editor-react18-fixture exec -- vite preview --host 127.0.0.1 --port 4179 --strictPort",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
  },
});
