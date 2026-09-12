import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getSourceDependencies } from "../../../../tests/helpers/source-dependencies";

const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));

function dependencies(fileName: string) {
  const sourceFile = fileURLToPath(new URL(fileName, import.meta.url));
  return getSourceDependencies(readFileSync(sourceFile, "utf8"), { sourceFile, sourceRoot });
}

describe("Graph3D controller boundary", () => {
  it("keeps canvas state ownership outside the Graph3D controller", () => {
    const allowed = new Set([
      "react",
      "@/components/editor/Graph3DSettingsPanel",
      "@/components/editor/graph3d-animation-preview",
      "@/components/editor/page-overlay-types",
      "@/components/editor/overlay-canvas/grouping",
      "@/components/editor/overlay-canvas/ids",
      "@/components/editor/overlay-canvas/interaction-mode",
      "@/features/document",
      "@/features/drawing",
    ]);
    expect(dependencies("use-graph3d-controller.ts").filter(({ specifier }) => specifier === null || !allowed.has(specifier))).toEqual([]);
    expect(dependencies("../OverlayCanvasEditorClient.tsx")).toContainEqual(expect.objectContaining({
      specifier: "@/components/editor/overlay-canvas/use-graph3d-controller", typeOnly: false,
    }));
  });
});
