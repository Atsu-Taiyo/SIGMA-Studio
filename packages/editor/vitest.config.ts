import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@sigma-studio/editor-internal/editor-shell",
        replacement: fileURLToPath(
          new URL("../../apps/desktop/src/components/editor/EditorShell.tsx", import.meta.url),
        ),
      },
      {
        find: "@sigma-studio/editor-internal/page-canvas-editor",
        replacement: fileURLToPath(
          new URL("../../apps/desktop/src/components/editor/PageCanvasEditor.tsx", import.meta.url),
        ),
      },
      {
        find: "@sigma-studio/editor-internal/tex-import",
        replacement: fileURLToPath(
          new URL("../../apps/desktop/src/lib/tex-import.ts", import.meta.url),
        ),
      },
      {
        find: "@sigma-studio/editor-internal/i18n",
        replacement: fileURLToPath(
          new URL("../../apps/desktop/src/lib/i18n/index.ts", import.meta.url),
        ),
      },
      {
        find: "next/dynamic",
        replacement: fileURLToPath(new URL("./src/next-dynamic-shim.tsx", import.meta.url)),
      },
      {
        find: /^@\//,
        replacement: fileURLToPath(new URL("../../apps/desktop/src/", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "happy-dom",
    restoreMocks: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
