import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@/lib/i18n/react",
        replacement: fileURLToPath(new URL("./src/i18n-react.ts", import.meta.url)),
      },
      {
        find: "@/lib/i18n",
        replacement: fileURLToPath(new URL("./src/i18n.ts", import.meta.url)),
      },
      {
        find: "@sigma-studio/viewer-internal/print-surface",
        replacement: fileURLToPath(
          new URL("../../apps/desktop/src/components/print/PrintPreview.tsx", import.meta.url),
        ),
      },
      {
        find: "@sigma-studio/viewer-internal/schema",
        replacement: fileURLToPath(
          new URL("../../apps/desktop/src/lib/sigma-doc-schema.ts", import.meta.url),
        ),
      },
      {
        find: "@sigma-studio/viewer-internal/css-safety",
        replacement: fileURLToPath(
          new URL("../../apps/desktop/src/features/document/css-safety.ts", import.meta.url),
        ),
      },
      {
        find: /^@\//,
        replacement: `${fileURLToPath(new URL("../../apps/desktop/src/", import.meta.url))}`,
      },
    ],
  },
  test: {
    environment: "happy-dom",
    restoreMocks: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
