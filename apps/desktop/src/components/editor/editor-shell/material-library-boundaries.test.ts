import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getSourceDependencies } from "../../../../tests/helpers/source-dependencies";

function dependencies(file: string) {
  const url = new URL(file, import.meta.url);
  return getSourceDependencies(readFileSync(url, "utf8"), {
    sourceFile: fileURLToPath(url),
    sourceRoot: fileURLToPath(new URL("../../../", import.meta.url)),
  });
}

describe("material library ownership", () => {
  it.each(["use-material-library-controller.ts", "material-library-dialogs.tsx"])("%s stays independent of shell and AI state", (file) => {
    expect(dependencies(file).filter(({ specifier }) => specifier && (
      /\/(?:EditorShell|PageCanvasEditor|OverlayCanvasEditorClient|TextFlowEditor)$/.test(specifier)
      || specifier.startsWith("@/features/ai-edit") || specifier.startsWith("@/lib/ai/")
    ))).toEqual([]);
  });

  it("keeps dialogs as consumers of controller types without repository or mutation access", () => {
    const imports = dependencies("material-library-dialogs.tsx");
    expect(imports.filter(({ specifier, typeOnly }) => !typeOnly && specifier && (
      specifier.includes("use-material-library-controller") || specifier.includes("material-library-commands")
      || specifier.startsWith("@/lib/runtime") || specifier === "@/lib/document-tree"
    ))).toEqual([]);
    expect(imports.some(({ specifier, typeOnly }) => typeOnly && specifier?.endsWith("/use-material-library-controller"))).toBe(true);
  });

  it("keeps the controller independent of its leaf views", () => {
    expect(dependencies("use-material-library-controller.ts").filter(({ specifier }) => specifier && (
      /\/(?:material-library-dialogs|material-dialogs|MaterialPreview|MaterialEditSurface)$/.test(specifier)
    ))).toEqual([]);
  });
});
