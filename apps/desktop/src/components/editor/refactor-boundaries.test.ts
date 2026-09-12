import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { getModuleSpecifiers } from "../../../tests/helpers/source-dependencies";

const modules = [
  "editor-shell/clipboard-events.ts",
  "editor-shell/document-file-import.ts",
  "editor-shell/document-tab-commands.ts",
  "editor-shell/material-library-commands.ts",
  "editor-shell/material-metadata-draft.ts",
  "editor-shell/use-document-save-boundary.ts",
  "editor-shell/use-comment-actions.ts",
  "editor-shell/document-storage-sync.ts",
  "editor-shell/use-workspace-document-commands.ts",
  "editor-shell/use-document-file-commands.ts",
  "editor-shell/use-desktop-menu-actions.ts",
  "editor-shell/editor-command-actions.ts",
  "editor-shell/use-editor-command-routing.ts",
  "editor-shell/use-command-palette.tsx",
  "editor-shell/use-material-library-controller.ts",
  "editor-shell/material-library-dialogs.tsx",
  "editor-shell/document-lifecycle-types.ts",
  "page-canvas/pointer-targets.ts",
  "overlay-canvas/selection-handles.tsx",
  "overlay-canvas/use-document-snapshot-sync.ts",
  "overlay-canvas/pending-save.ts",
  "text-flow/command-popovers.tsx",
];

describe("extracted editor responsibilities", () => {
  it.each(modules)("%s cannot depend on its controller or AI state", (file) => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const imports = getModuleSpecifiers(source);
    expect(imports.filter((name) => /(?:EditorShell|PageCanvasEditor|OverlayCanvasEditorClient|TextFlowEditor)$/.test(name))).toEqual([]);
    expect(imports.filter((name) => name.startsWith("@/features/ai-edit") || name.startsWith("@/lib/ai/"))).toEqual([]);
  });

  it.each(["document-tab-commands.ts", "material-library-commands.ts", "material-metadata-draft.ts"])("%s keeps operations independent of rendering and runtime selection", (file) => {
    const source = readFileSync(new URL(`editor-shell/${file}`, import.meta.url), "utf8");
    const imports = getModuleSpecifiers(source);
    expect(imports.filter((name) => name === "react"
      || name.startsWith("@/components/")
      || name.startsWith("@/lib/runtime") && name !== "@/lib/runtime/types"
      || name.includes("material-dialogs"))).toEqual([]);
  });
});
