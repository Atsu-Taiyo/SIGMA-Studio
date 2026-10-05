import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);
export default defineConfig({
  plugins: [react()],
  // The shared example source must use this host's React 19 runtime.
  resolve: {
    alias: Object.fromEntries(["react", "react-dom"].map((name) => [name, path.dirname(require.resolve(`${name}/package.json`))])),
    dedupe: ["react", "react-dom"],
  },
});
