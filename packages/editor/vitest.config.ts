import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const disabledDesktopAi = fileURLToPath(
  new URL("./src/desktop-ai-disabled.tsx", import.meta.url),
);
const privateDesktopAiModules = [
  "@/features/ai-edit",
  "@/components/editor/AiEditPanel",
  "@/components/editor/AiTaskDock",
  "@/components/editor/AiSettingsDialog",
  "@/components/editor/ai-inline-placement",
  "@/lib/ai/ai-surface",
  "@/lib/ai/codex-ai-edit-client",
  "@/lib/ai/ai-source-reference-navigation",
  "@/lib/ai/ai-run-controller",
  "@/lib/ai/ai-run-session-store",
  "@/lib/ai/ai-connection",
  "@/lib/ai/ai-providers",
];

export default defineConfig({
  resolve: {
    alias: [
      ...privateDesktopAiModules.map((find) => ({
        find,
        replacement: disabledDesktopAi,
      })),
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
