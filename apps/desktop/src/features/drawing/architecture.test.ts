import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it } from "vitest";

import { getModuleSpecifiers as importSpecifiers, getSourceDependencies } from "../../../tests/helpers/source-dependencies";

import type {
  OverlayInteractionMode as LegacyOverlayInteractionMode,
  ResizeHandle as LegacyResizeHandle,
} from "@/components/editor/overlay-canvas/interaction-mode";
import {
  getShapeSnapPoints as getLegacyShapeSnapPoints,
} from "@/components/editor/overlay-canvas/shape-snap-points";
import {
  createOverlaySnapGeometry as createLegacyOverlaySnapGeometry,
  snapBoundsToGeometry as snapLegacyBoundsToGeometry,
  snapPointToGeometry as snapLegacyPointToGeometry,
  snapResizeBoundsToGeometry as snapLegacyResizeBoundsToGeometry,
} from "@/components/editor/overlay-canvas/snapping";
import type {
  OverlaySnapGeometry as LegacyOverlaySnapGeometry,
  OverlaySnapGuide as LegacyOverlaySnapGuide,
} from "@/components/editor/overlay-canvas/snapping";
import {
  updateShapePoint as updateLegacyShapePoint,
} from "@/components/editor/overlay-canvas/point-edit";
import {
  alignShapes as alignLegacyShapes,
  distributeShapes as distributeLegacyShapes,
  fitShapesWithinPage as fitLegacyShapesWithinPage,
  moveShapes as moveLegacyShapes,
  resizeRotatedShapeToBounds as resizeLegacyRotatedShapeToBounds,
  resizeShapesToBounds as resizeLegacyShapesToBounds,
  rotateShapesAround as rotateLegacyShapesAround,
} from "@/components/editor/overlay-canvas/arrange";
import type {
  OverlayAlignAction as LegacyOverlayAlignAction,
  OverlayDistributeAxis as LegacyOverlayDistributeAxis,
} from "@/components/editor/overlay-canvas/arrange";
import {
  getShapesBounds as getLegacyShapesBounds,
} from "@/components/editor/overlay-canvas/shape-bounds";
import {
  createArcShapeFromCenterDrag as createLegacyArcShapeFromCenterDrag,
  createArcShapeFromThreePoints as createLegacyArcShapeFromThreePoints,
  getArcMidAngle as getLegacyArcMidAngle,
  getSnappedArcInsertDragPoint as getLegacySnappedArcInsertDragPoint,
  scaleArcRadiusFromDrag as scaleLegacyArcRadiusFromDrag,
} from "@/components/editor/overlay-canvas/shapes/arc";
import {
  getGraphPlotSize as getLegacyGraphPlotSize,
  isGraphLabelTextShape as isLegacyGraphLabelTextShape,
} from "@/components/editor/overlay-canvas/shapes/graph";
import {
  canBoxResize as canLegacyBoxResize,
  hitTestShape as hitTestLegacyShape,
  moveShape as moveLegacyShape,
  resizeBoxShape as resizeLegacyBoxShape,
  rotateShape as rotateLegacyShape,
} from "@/components/editor/overlay-canvas/shapes/geometry";
import type { MeasuredBlock as LegacyMeasuredBlock } from "@/components/editor/overlay-canvas/anchor";
import {
  fitImageRowToWidth as fitLegacyImageRowToWidth,
  fitImageSizeWithinArea as fitLegacyImageSizeWithinArea,
} from "@/components/editor/overlay-canvas/image-insert";
import type {
  OverlayInsertCommand as LegacyOverlayInsertCommand,
  OverlayTool as LegacyOverlayTool,
} from "@/components/editor/overlay-canvas/types";
import type { Graph2DPreset as LegacyGraph2DPreset } from "@/lib/graph2d";
import type { Graph2DPreset } from "@/features/document";

import {
  alignShapes,
  canBoxResize,
  createArcShapeFromCenterDrag,
  createArcShapeFromThreePoints,
  createOverlaySnapGeometry,
  distributeShapes,
  fitShapesWithinPage,
  fitImageRowToWidth,
  fitImageSizeWithinArea,
  getArcMidAngle,
  getGraphPlotSize,
  getShapeSnapPoints,
  getSnappedArcInsertDragPoint,
  getShapesBounds,
  hitTestShape,
  isGraphLabelTextShape,
  moveShape,
  moveShapes,
  pageIndexForY,
  resolveShapeAnchorPositions,
  resolveResizePointer,
  resolveRotatePointerDelta,
  resizeBoxShape,
  resizeRotatedShapeToBounds,
  resizeShapesToBounds,
  rotateShape,
  rotateShapesAround,
  scaleArcRadiusFromDrag,
  snapBoundsToGeometry,
  snapPointToGeometry,
  snapResizeBoundsToGeometry,
  updateShapePoint,
} from ".";
import type {
  MeasuredBlock,
  OverlayAlignAction,
  OverlayDistributeAxis,
  OverlayInsertCommand,
  OverlayInteractionMode,
  OverlaySnapGeometry,
  OverlaySnapGuide,
  OverlayTool,
  ResizeHandle,
} from ".";

function productionSourceFiles(directory: URL): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryUrl = new URL(entry.name, directory);
    if (entry.isDirectory()) {
      return productionSourceFiles(new URL(`${entry.name}/`, directory));
    }
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")
      ? [fileURLToPath(entryUrl)]
      : [];
  });
}

function resolutionFor(sourceFile: string) {
  return { sourceFile, sourceRoot: fileURLToPath(new URL("../../", import.meta.url)) };
}

function drawingBoundaryViolations(source: string, sourceFile: string): string[] {
  return importSpecifiers(source, { resolveFrom: resolutionFor(sourceFile) }).filter((specifier) => (
    specifier !== "@/features/document" &&
    !specifier.startsWith("@/features/document/") &&
    specifier !== "@/features/rendering/core" &&
    specifier !== "@/features/drawing" &&
    !specifier.startsWith("@/features/drawing/")
  ));
}

function runtimeDocumentDependencies(source: string, sourceFile: string) {
  return getSourceDependencies(source, resolutionFor(sourceFile))
    .filter(({ specifier, typeOnly }) => !typeOnly && specifier !== null &&
      /^@\/features\/document(?:\/|$)/.test(specifier));
}

describe("drawing feature dependency boundary", () => {
  it("keeps coordinate primitives independent of geometry interpretation", () => {
    const vectorSource = readFileSync(new URL("./graph3d-vector.ts", import.meta.url), "utf8");

    expect(importSpecifiers(vectorSource)).toEqual([]);
  });

  // Layering: document < rendering/core < drawing < rendering/adapters. `rendering/core` is pure
  // and depends only on canonical document primitives (pinned by `features/rendering/architecture.test.ts`, which
  // also asserts the reverse edge — core must not reach back into drawing), so this one direction
  // cannot form a cycle. It exists so the line rules of the text estimator and of the renderer are
  // literally the same code instead of two copies that drift.
  it("depends only on document types, the rendering core, and pure sibling modules", () => {
    const files = productionSourceFiles(new URL("./", import.meta.url));
    const invalidImports = files.flatMap((file) => (
      drawingBoundaryViolations(readFileSync(file, "utf8"), file)
        .map((specifier) => ({ file, specifier }))
    ));

    expect(invalidImports).toEqual([]);
  });

  it.each([
    "@/features/rendering/adapters/math-html",
    "../rendering/adapters/math-html",
    "@/components/editor/OverlayCanvasEditorClient",
    "../../components/editor/OverlayCanvasEditorClient.tsx",
    "@/lib/ai/sigma-doc-agent-tools",
    "../../lib/ai/sigma-doc-agent-tools",
    "@/../electron/main",
    "../../../electron/main",
  ])("rejects a resolved drawing dependency in every syntax: %s", (specifier) => {
    const source = `import { value } from "${specifier}"; export { value } from "${specifier}"; const load = () => import("${specifier}");`;
    expect(drawingBoundaryViolations(source, fileURLToPath(new URL("./probe.ts", import.meta.url))))
      .toHaveLength(3);
  });

  it.each(["@/features/document/overlay-text-font", "../document/overlay-text-font.ts"])(
    "detects a runtime document edge in every syntax while allowing document types: %s",
    (specifier) => {
      const source = `import { value } from "${specifier}"; export { value } from "${specifier}"; const load = () => import("${specifier}"); import type { Value } from "${specifier}";`;
      expect(runtimeDocumentDependencies(source, fileURLToPath(new URL("./probe.ts", import.meta.url))))
        .toHaveLength(3);
    },
  );

  it("accepts equivalent local spellings of the existing inward dependencies", () => {
    const source = 'import type { OverlayShape } from "../document/index.js"; export * from "../rendering/core/index.js"; import "./shape-transform";';
    const sourceFile = fileURLToPath(new URL("./probe.ts", import.meta.url));
    expect(drawingBoundaryViolations(source, sourceFile)).toEqual([]);
    expect(runtimeDocumentDependencies(source, sourceFile)).toEqual([]);
  });

  // Rendering core and its canonical document primitives are pure inward dependencies;
  // drawing still owns no document mutations and reaches rendering through its public API.
  it("reaches the rendering core only through its public entrypoint", () => {
    const files = productionSourceFiles(new URL("./", import.meta.url));
    const deepCoreImports = files.flatMap((file) => (
      importSpecifiers(readFileSync(file, "utf8"), { resolveFrom: resolutionFor(file) })
        .filter((specifier) => specifier.startsWith("@/features/rendering/core/"))
        .map((specifier) => ({ file, specifier }))
    ));

    expect(deepCoreImports).toEqual([]);
  });

  // Pre-existing constrained exception to the document-type-only rule: the overlay text font math (size table +
  // pt→px conversion) is owned by `features/document/overlay-text-font.ts` because that is the only
  // layer both features can read — `features/document` may not import `features/rendering` at all
  // and this feature may not import `@/lib` (see the two rules above and
  // `features/document/architecture.test.ts`). Rather than leaning on `export … from` slipping past
  // an `import`-only regex, state the design: exactly one drawing module carries that edge, it is a
  // pure re-export facade, and the reverse edge (document → drawing) is forbidden outright by
  // `features/document/architecture.test.ts`, so the pair cannot form a cycle.
  it("keeps its single runtime document dependency inside the text-shape-font facade", () => {
    const facade = fileURLToPath(new URL("./text-shape-font.ts", import.meta.url));
    const files = productionSourceFiles(new URL("./", import.meta.url));
    // Syntax classification includes re-exports, deferred imports, and inline type bindings.
    const runtimeDocumentDependents = files.filter((file) => (
      runtimeDocumentDependencies(readFileSync(file, "utf8"), file).length > 0
    ));
    const facadeSource = readFileSync(facade, "utf8");
    const reExportedNames = (/\bexport\s*\{([^}]*)\}\s*from\s+["']@\/features\/document\/overlay-text-font["']/
      .exec(facadeSource)?.[1] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);

    expect(runtimeDocumentDependents).toEqual([facade]);
    // Re-export only, and the whole shared surface must come through that one statement: a locally
    // declared `getTextShapeFontSizePt` would be exactly the second implementation this WI removed,
    // so the facade owns no functions at all — only the two drawing-local constants.
    expect(facadeSource).not.toMatch(/^\s*(?:export\s+)?(?:function|class|interface)\b/m);
    expect(reExportedNames).toContain("getTextShapeFontSizePt");
    expect(reExportedNames).toContain("getTextShapeRenderedFontSizePx");
    expect(reExportedNames).toContain("getTextShapeRenderedLineHeightPx");
    expect(reExportedNames).toContain("getTextShapeLineHeightPx");
    // Deep specifier only: the barrel would pull the whole document feature into this feature's
    // runtime graph.
    expect(facadeSource).not.toMatch(/from\s+["']@\/features\/document["']/);
  });

  it("keeps the legacy component entrypoints as logic-free re-export facades", () => {
    const legacyEntrypoints = [
      "../../components/editor/overlay-canvas/angle.ts",
      "../../components/editor/overlay-canvas/arrange.ts",
      "../../components/editor/overlay-canvas/interaction-mode.ts",
      "../../components/editor/overlay-canvas/image-insert.ts",
      "../../components/editor/overlay-canvas/math.ts",
      "../../components/editor/overlay-canvas/point-edit.ts",
      "../../components/editor/overlay-canvas/resize.ts",
      "../../components/editor/overlay-canvas/shape-bounds.ts",
      "../../components/editor/overlay-canvas/shape-snap-points.ts",
      "../../components/editor/overlay-canvas/snapping.ts",
      "../../components/editor/overlay-canvas/shapes/arc.ts",
      "../../components/editor/overlay-canvas/shapes/block-arrow.ts",
      "../../components/editor/overlay-canvas/shapes/callout.ts",
      "../../components/editor/overlay-canvas/shapes/geometry.ts",
      "../../components/editor/overlay-canvas/shapes/line.ts",
      "../../components/editor/overlay-canvas/shapes/regular-polygon.ts",
    ];

    for (const relativePath of legacyEntrypoints) {
      const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

      expect(source).toContain("export ");
      expect(source).not.toMatch(/^\s*import\b/m);
      expect(source).not.toMatch(/^\s*(?:const|let|var|function|class|interface|type)\b/m);
    }
  });

  it("keeps mixed UI modules from owning static SVG geometry", () => {
    const imageCropSource = readFileSync(fileURLToPath(new URL(
      "../../components/editor/overlay-canvas/image-crop.ts",
      import.meta.url,
    )), "utf8");
    const graphSource = readFileSync(fileURLToPath(new URL(
      "../../components/editor/overlay-canvas/shapes/graph.ts",
      import.meta.url,
    )), "utf8");

    expect(imageCropSource).toContain('from "@/features/drawing"');
    expect(imageCropSource).not.toMatch(/\bfunction\s+getImageCoverCrop\b/);
    expect(imageCropSource).not.toMatch(/\bfunction\s+getCroppedImageLayout\b/);
    expect(graphSource).toContain('from "@/features/drawing"');
    expect(graphSource).not.toMatch(/\bfunction\s+getGraphDisplaySpec\b/);
    expect(graphSource).not.toMatch(/\bfunction\s+getGraphPlotSize\b/);
    expect(graphSource).not.toMatch(/\bfunction\s+getGraphRenderLayout\b/);
  });

  it("keeps arc creation and graph label layout out of mixed UI modules", () => {
    const arcSource = readFileSync(fileURLToPath(new URL(
      "../../components/editor/overlay-canvas/shapes/arc.ts",
      import.meta.url,
    )), "utf8");
    const graphSource = readFileSync(fileURLToPath(new URL(
      "../../components/editor/overlay-canvas/shapes/graph.ts",
      import.meta.url,
    )), "utf8");

    expect(arcSource).not.toMatch(/\bfunction\s+createArcShapeFrom(?:ThreePoints|CenterDrag)\b/);
    expect(arcSource).not.toMatch(/\bfunction\s+getCircleFromThreePoints\b/);
    expect(graphSource).not.toMatch(/\bfunction\s+getGraph(?:Axis|Point|Annotation)LabelEntries\b/);
    expect(graphSource).not.toMatch(/\bfunction\s+measureGraphLabelTex\b/);
    expect(graphSource).not.toMatch(/\bfunction\s+chooseGraphPointLabelPlacement\b/);
  });

  it("keeps compatibility facades identical where no runtime port is required", () => {
    expect(alignLegacyShapes).toBe(alignShapes);
    expect(createLegacyArcShapeFromThreePoints).toBe(createArcShapeFromThreePoints);
    expect(createLegacyArcShapeFromCenterDrag).toBe(createArcShapeFromCenterDrag);
    expect(createLegacyOverlaySnapGeometry).toBe(createOverlaySnapGeometry);
    expect(canLegacyBoxResize).toBe(canBoxResize);
    expect(distributeLegacyShapes).toBe(distributeShapes);
    expect(fitLegacyShapesWithinPage).toBe(fitShapesWithinPage);
    expect(fitLegacyImageRowToWidth).toBe(fitImageRowToWidth);
    expect(fitLegacyImageSizeWithinArea).toBe(fitImageSizeWithinArea);
    expect(getLegacyArcMidAngle).toBe(getArcMidAngle);
    expect(getLegacyGraphPlotSize).toBe(getGraphPlotSize);
    expect(getLegacyShapeSnapPoints).toBe(getShapeSnapPoints);
    expect(getLegacySnappedArcInsertDragPoint).toBe(getSnappedArcInsertDragPoint);
    expect(getLegacyShapesBounds).toBe(getShapesBounds);
    expect(hitTestLegacyShape).toBe(hitTestShape);
    expect(isLegacyGraphLabelTextShape).toBe(isGraphLabelTextShape);
    expect(moveLegacyShape).toBe(moveShape);
    expect(moveLegacyShapes).toBe(moveShapes);
    expect(resizeLegacyBoxShape).toBe(resizeBoxShape);
    expect(resizeLegacyRotatedShapeToBounds).toBe(resizeRotatedShapeToBounds);
    expect(resizeLegacyShapesToBounds).toBe(resizeShapesToBounds);
    expect(rotateLegacyShape).toBe(rotateShape);
    expect(rotateLegacyShapesAround).toBe(rotateShapesAround);
    expect(scaleLegacyArcRadiusFromDrag).toBe(scaleArcRadiusFromDrag);
    expect(snapLegacyBoundsToGeometry).toBe(snapBoundsToGeometry);
    expect(snapLegacyPointToGeometry).toBe(snapPointToGeometry);
    expect(snapLegacyResizeBoundsToGeometry).toBe(snapResizeBoundsToGeometry);
    expect(updateLegacyShapePoint).toBe(updateShapePoint);
  });

  it("keeps legacy editor entrypoints type-identical to the public drawing API", () => {
    expectTypeOf<LegacyMeasuredBlock>().toEqualTypeOf<MeasuredBlock>();
    expectTypeOf<LegacyOverlayAlignAction>().toEqualTypeOf<OverlayAlignAction>();
    expectTypeOf<LegacyOverlayDistributeAxis>().toEqualTypeOf<OverlayDistributeAxis>();
    expectTypeOf<LegacyOverlayInsertCommand>().toEqualTypeOf<OverlayInsertCommand>();
    expectTypeOf<LegacyOverlayTool>().toEqualTypeOf<OverlayTool>();
    expectTypeOf<LegacyOverlayInteractionMode>().toEqualTypeOf<OverlayInteractionMode>();
    expectTypeOf<LegacyResizeHandle>().toEqualTypeOf<ResizeHandle>();
    expectTypeOf<LegacyOverlaySnapGeometry>().toEqualTypeOf<OverlaySnapGeometry>();
    expectTypeOf<LegacyOverlaySnapGuide>().toEqualTypeOf<OverlaySnapGuide>();
    expectTypeOf<LegacyGraph2DPreset>().toEqualTypeOf<Graph2DPreset>();
  });

  it("keeps pure anchor resolution out of the DOM adapter", () => {
    const anchorSource = readFileSync(fileURLToPath(new URL(
      "../../components/editor/overlay-canvas/anchor.ts",
      import.meta.url,
    )), "utf8");

    expectTypeOf(pageIndexForY).toBeFunction();
    expectTypeOf(resolveShapeAnchorPositions).toBeFunction();
    expect(anchorSource).toContain('from "@/features/drawing"');
    expect(anchorSource).not.toMatch(/\bfunction\s+pageIndexForY\b/);
    expect(anchorSource).not.toMatch(/\bfunction\s+resolveShapeAnchorPositions\b/);
    expect(anchorSource).not.toMatch(/\bfunction\s+resolveShapePosition\b/);
    expect(anchorSource).toMatch(/\bfunction\s+pickBlockAnchor\b/);
    expect(anchorSource).toMatch(/\bfunction\s+pickShapeAnchor\b/);
    expect(anchorSource).toMatch(/\bfunction\s+measureBlockTops\b/);
  });

  it("keeps headless anchor consumers on the public drawing entrypoint", () => {
    const headlessDirectories = [
      new URL("../../lib/ai/", import.meta.url),
      new URL("../../../electron/", import.meta.url),
      new URL("../../../mcp/", import.meta.url),
    ];
    const invalidImports = headlessDirectories.flatMap((directory) => (
      productionSourceFiles(directory).flatMap((file) => (
        importSpecifiers(readFileSync(file, "utf8"), {
          // The optional native rasterizer stays outside esbuild via a variable import.
          allowComputed: file.endsWith("/mcp/sigma-doc-mcp-preview.ts"),
        })
          .filter((specifier) => specifier === "@/components/editor/overlay-canvas/anchor")
          .map((specifier) => ({ file, specifier }))
      ))
    ));

    expect(invalidImports).toEqual([]);
  });

  it("keeps headless block-rect estimation on the public document entrypoint", () => {
    // 推定矩形は features/document(ページ送り・段組み)が持ち、AI/MCP/electron は
    // 公開境界からだけ使う。editor-shell 側に第二の実装を復活させない。
    const overlayHelpersSource = readFileSync(fileURLToPath(new URL(
      "../../components/editor/editor-shell/overlay-helpers.ts",
      import.meta.url,
    )), "utf8");
    const placementSource = readFileSync(fileURLToPath(new URL(
      "../../lib/ai/ai-overlay-placement.ts",
      import.meta.url,
    )), "utf8");

    expect(overlayHelpersSource).toContain("estimateTopLevelBlockRects");
    expect(overlayHelpersSource).not.toMatch(/\bfunction\s+estimateTopLevelBlockRects\b/);
    expect(overlayHelpersSource).not.toContain("TEXT_FLOW_BLOCK_ANCHOR_LEFT_OFFSET_PX");
    expect(placementSource).toContain('from "@/features/document"');
    expect(importSpecifiers(placementSource).filter((specifier) => specifier.startsWith("@/components/")))
      .toEqual([]);
  });

  it("keeps AI document tools independent from editor components", () => {
    const source = readFileSync(fileURLToPath(new URL(
      "../../lib/ai/sigma-doc-agent-tools.ts",
      import.meta.url,
    )), "utf8");
    const componentImports = importSpecifiers(source)
      .filter((specifier) => specifier.startsWith("@/components/"));

    expect(componentImports).toEqual([]);
  });

  it("keeps pointer-to-rotation resolution behind the public headless drawing boundary", () => {
    const clientSource = readFileSync(fileURLToPath(new URL(
      "../../components/editor/OverlayCanvasEditorClient.tsx",
      import.meta.url,
    )), "utf8");

    expectTypeOf(resolveRotatePointerDelta).toBeFunction();
    expect(clientSource).toContain("resolveRotatePointerDelta(interaction, point, modifiers.shiftKey)");
    expect(clientSource).not.toContain("snapRotationDeltaToAbsoluteStep");
  });

  it("keeps pointer-to-resize resolution behind the public headless drawing boundary", () => {
    const clientSource = readFileSync(fileURLToPath(new URL(
      "../../components/editor/OverlayCanvasEditorClient.tsx",
      import.meta.url,
    )), "utf8");

    expectTypeOf(resolveResizePointer).toBeFunction();
    expect(clientSource).toContain("resolveResizePointer(interaction, point, modifiers)");
    expect(clientSource).not.toContain("shouldPreserveResizeAspect");
  });

  it("keeps overlay snapping consumers on the public drawing entrypoint", () => {
    const clientSource = readFileSync(fileURLToPath(new URL(
      "../../components/editor/OverlayCanvasEditorClient.tsx",
      import.meta.url,
    )), "utf8");

    expect(clientSource).toContain("createOverlaySnapGeometry");
    expect(clientSource).not.toContain('from "./overlay-canvas/snapping"');
  });

  it("keeps pure arrangement behind the public drawing boundary", () => {
    const componentFiles = productionSourceFiles(new URL("../../components/", import.meta.url));
    const legacyImports = componentFiles.flatMap((file) => (
      importSpecifiers(readFileSync(file, "utf8"))
        .filter((specifier) => (
          specifier.endsWith("/overlay-canvas/arrange")
          || specifier.endsWith("/overlay-canvas/shape-bounds")
          || specifier === "./arrange"
          || specifier === "../arrange"
          || specifier === "./shape-bounds"
          || specifier === "../shape-bounds"
        ))
        .map((specifier) => ({ file, specifier }))
    ));
    const arrangementSource = readFileSync(fileURLToPath(new URL(
      "./shape-arrangement.ts",
      import.meta.url,
    )), "utf8");
    const clientSource = readFileSync(fileURLToPath(new URL(
      "../../components/editor/OverlayCanvasEditorClient.tsx",
      import.meta.url,
    )), "utf8");
    const reorderSource = readFileSync(fileURLToPath(new URL(
      "../../components/editor/overlay-canvas/reorder-shapes.ts",
      import.meta.url,
    )), "utf8");

    expect(legacyImports).toEqual([]);
    expect(arrangementSource).not.toMatch(
      /normalizeOverlayGroups|reorderShapes|features\/rendering|components\//,
    );
    expect(clientSource).toContain("fitShapesWithinPage(");
    expect(clientSource).not.toMatch(/\bfunction\s+fitShapesWithinPage\b/);
    expect(reorderSource).toContain("normalizeOverlayGroups");
  });

  it("keeps production shape geometry consumers on the public drawing entrypoint", () => {
    const componentFiles = productionSourceFiles(new URL("../../components/", import.meta.url));
    const legacyImports = componentFiles.flatMap((file) => (
      importSpecifiers(readFileSync(file, "utf8"))
        .filter((specifier) => specifier.endsWith("/overlay-canvas/shapes/geometry") ||
          specifier === "./geometry" ||
          specifier.endsWith("/shapes/geometry"))
        .map((specifier) => ({ file, specifier }))
    ));

    expect(legacyImports).toEqual([]);
  });

  it("keeps point and arc interaction consumers on the public drawing entrypoint", () => {
    const componentFiles = productionSourceFiles(new URL("../../components/", import.meta.url));
    const legacyImports = componentFiles.flatMap((file) => (
      importSpecifiers(readFileSync(file, "utf8"))
        .filter((specifier) => (
          specifier.endsWith("/overlay-canvas/point-edit") ||
          specifier.endsWith("/overlay-canvas/shapes/arc") ||
          specifier === "./point-edit" ||
          specifier === "./shapes/arc" ||
          specifier === "./arc"
        ))
        .map((specifier) => ({ file, specifier }))
    ));

    expect(legacyImports).toEqual([]);
  });

  it("keeps localized arc readout outside the headless drawing feature", () => {
    const interactionSource = readFileSync(fileURLToPath(new URL(
      "./arc-interaction.ts",
      import.meta.url,
    )), "utf8");
    const readoutSource = readFileSync(fileURLToPath(new URL(
      "../../components/editor/overlay-canvas/shapes/arc-readout.ts",
      import.meta.url,
    )), "utf8");

    expect(interactionSource).not.toContain("Readout");
    expect(readoutSource).toContain("getArcDragReadoutText");
  });
});
