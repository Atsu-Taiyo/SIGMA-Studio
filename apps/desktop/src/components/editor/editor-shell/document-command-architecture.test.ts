import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getModuleSpecifiers } from "../../../../tests/helpers/source-dependencies";

describe("document command composition boundary", () => {
  it.each([
    "use-workspace-document-commands.ts",
    "use-document-file-commands.ts",
    "use-desktop-menu-actions.ts",
  ])("keeps %s independent of controllers, sibling hooks, AI and storage backends", (file) => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const invalidImports = getModuleSpecifiers(source).filter((specifier) => (
      /(?:EditorShell|TextFlowEditor|PageCanvasEditor|OverlayCanvasEditorClient)/.test(specifier)
      || specifier.startsWith("./use-")
      || specifier.startsWith("@tiptap/")
      || specifier.startsWith("@/features/ai-edit")
      || specifier.startsWith("@/lib/ai/")
      || specifier.startsWith("@/lib/runtime")
      || specifier.startsWith("@/electron/")
    ));
    expect(invalidImports).toEqual([]);
  });
});
