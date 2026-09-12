import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it } from "vitest";

import { getModuleSpecifiers as importSpecifiers } from "../../../tests/helpers/source-dependencies";

import {
  alignMarginToRunningRegionBoundary,
  appendCommentMessage,
  createCommentThread,
  createEmptyOverlaySnapshot,
  diffDeletedContentIds,
  enablePageRunningRegion,
  getGraphAxisLabelSpecText,
  getGraphAxisLabelTextsByKey,
  getOverlayTextBlocksLabelText,
  getRunningRegionBoundsMm,
  insertTopLevelDocumentBlocks,
  insertTopLevelDocumentBlocksBefore,
  normalizeOverlaySnapshot,
  patchShape,
  removeCommentReplyMessage,
  removeCommentThread,
  removeShapes,
  repairDuplicateTopLevelIds,
  resizeHorizontalMarginsLayout,
  resizeRunningRegionLayout,
  roundHalfMm,
  setCommentThreadResolved,
  toggleCommentMessageReaction,
  updateCommentMessageBody,
  updateCommentThreadBody,
  upsertShape,
} from ".";
import {
  alignMarginToRunningRegionBoundary as legacyAlignMarginToRunningRegionBoundary,
  enablePageRunningRegion as legacyEnablePageRunningRegion,
  getRunningRegionBoundsMm as legacyGetRunningRegionBoundsMm,
  resizeHorizontalMarginsLayout as legacyResizeHorizontalMarginsLayout,
  resizeRunningRegionLayout as legacyResizeRunningRegionLayout,
  roundHalfMm as legacyRoundHalfMm,
} from "@/components/editor/page-canvas/running-region-math";
import type { TiptapDoc } from "@/lib/tiptap-adapter";
import type {
  Graph2DSpec as LegacyGraph2DSpec,
  InlineNode as LegacyInlineNode,
  LineHeight as LegacyLineHeight,
  MathFractionSizing as LegacyMathFractionSizing,
  SigmaBlockCommentAnchor as LegacySigmaBlockCommentAnchor,
  SigmaCommentAnchor as LegacySigmaCommentAnchor,
  SigmaCommentMessage as LegacySigmaCommentMessage,
  SigmaCommentReaction as LegacySigmaCommentReaction,
  SigmaCommentTextPosition as LegacySigmaCommentTextPosition,
  SigmaCommentThread as LegacySigmaCommentThread,
  SigmaInlineMathCommentAnchor as LegacySigmaInlineMathCommentAnchor,
  SigmaOverlayMathCommentAnchor as LegacySigmaOverlayMathCommentAnchor,
  SigmaOverlayShapeCommentAnchor as LegacySigmaOverlayShapeCommentAnchor,
  SigmaTextRangeCommentAnchor as LegacySigmaTextRangeCommentAnchor,
  TextAlign as LegacyTextAlign,
} from "@/types/sigma-doc";
import type {
  BoxBlockNode,
  CodeBlockNode,
  DividerNode,
  Graph2DSpec,
  InlineNode,
  LayoutSectionNode,
  LineHeight,
  MathFractionSizing,
  ProblemNode,
  QuoteBlockNode,
  RichBlock,
  SigmaBlockCommentAnchor,
  SigmaCommentAnchor,
  SigmaCommentMessage,
  SigmaCommentReaction,
  SigmaCommentTextPosition,
  SigmaCommentThread,
  SigmaInlineMathCommentAnchor,
  SigmaOverlayMathCommentAnchor,
  SigmaOverlayShapeCommentAnchor,
  SigmaTextRangeCommentAnchor,
  TextAlign,
} from "./model";
import type {
  OverlayTextBlock,
  OverlayCalloutShape,
  OverlayTextShape,
} from "./overlay-model";

function sourceFiles(directory: URL): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryUrl = new URL(entry.name, directory);
    if (entry.isDirectory()) {
      return sourceFiles(new URL(`${entry.name}/`, directory));
    }
    return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)
      ? [fileURLToPath(entryUrl)]
      : [];
  });
}

function filesContaining(files: readonly string[], pattern: RegExp): string[] {
  return files.filter((file) => pattern.test(readFileSync(file, "utf8")));
}

function withoutModuleSpecifierText(source: string): string {
  return source.replace(
    /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)(["'])[^"']+\1/g,
    "",
  );
}

function productionSourceFiles(directory: URL): string[] {
  return sourceFiles(directory)
    .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"));
}

function forbiddenImports(
  files: readonly string[],
  isForbidden: (specifier: string) => boolean,
): Array<{ file: string; specifier: string }> {
  return files.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    const specifiers = importSpecifiers(source, {
      // This transport loads the optional native @resvg/resvg-js dependency through a
      // variable so esbuild does not bundle it. Its static feature dependencies still count.
      allowComputed: file.endsWith("/mcp/sigma-doc-mcp-preview.ts"),
    });
    return specifiers
      .filter(isForbidden)
      .map((specifier) => ({ file, specifier }));
  });
}

function isReactImport(specifier: string): boolean {
  return specifier === "react" ||
    specifier.startsWith("react/") ||
    specifier === "react-dom" ||
    specifier.startsWith("react-dom/") ||
    specifier === "next" ||
    specifier.startsWith("next/");
}

function isTiptapImport(specifier: string): boolean {
  return specifier.startsWith("@tiptap/") || pointsToProjectPath(specifier, "lib/tiptap-adapter");
}

function isAiFeatureImport(specifier: string): boolean {
  return pointsToProjectPath(specifier, "lib/ai") || pointsToProjectPath(specifier, "features/ai-edit");
}

function pointsToProjectPath(specifier: string, path: string): boolean {
  return specifier === `@/${path}` ||
    specifier.startsWith(`@/${path}/`) ||
    specifier.endsWith(`/${path}`) ||
    specifier.includes(`/${path}/`);
}

function documentBoundaryViolations(source: string, sourceFile: string): string[] {
  return importSpecifiers(source, { resolveFrom: {
    sourceFile,
    sourceRoot: fileURLToPath(new URL("../../", import.meta.url)),
  } }).filter((specifier) => (
    specifier !== "@/features/document" && !specifier.startsWith("@/features/document/")
  ));
}

describe("document feature dependency boundary", () => {
  it("does not import editor components or Tiptap runtime types", () => {
    const documentFeatureFiles = productionSourceFiles(new URL("./", import.meta.url));

    // `features/drawing` is listed for the same reason as `features/rendering`: this is the bottom
    // layer. The edge runs the other way (`features/drawing/text-shape-font.ts` re-exports
    // `overlay-text-font.ts`, pinned by `features/drawing/architecture.test.ts`), so stating the
    // ban here is what makes that facade acyclic by construction rather than by inspection.
    expect(documentFeatureFiles.flatMap((file) => (
      documentBoundaryViolations(readFileSync(file, "utf8"), file)
        .map((specifier) => ({ file, specifier }))
    ))).toEqual([]);
  });

  it("keeps the shared overlay text font module free of outgoing package dependencies", () => {
    // `features/drawing` reads this module at runtime through its `text-shape-font.ts` facade, and
    // that feature's own boundary test scans drawing files — so anything this module imports
    // silently becomes part of the drawing feature's (and therefore the renderers') runtime graph.
    // The module sits at the feature root, so "relative and never `../`" is exactly "a leaf inside
    // this feature".
    const fontModule = fileURLToPath(new URL("./overlay-text-font.ts", import.meta.url));

    expect(forbiddenImports(
      [fontModule],
      (specifier) => !specifier.startsWith(".") || specifier.startsWith(".."),
    )).toEqual([]);
  });

  it("keeps the shared CSS safety module free of outgoing dependencies", () => {
    // `packages/viewer` bundles this one file through a build alias
    // (`@sigma-studio/viewer-internal/css-safety`) so the published viewer cannot disagree with the
    // normalization boundary about which CSS scalars a document may carry. Anything this module
    // imports would be pulled into that browser bundle with it, so it has to stay a leaf.
    const cssSafetyModule = fileURLToPath(new URL("./css-safety.ts", import.meta.url));

    expect(importSpecifiers(readFileSync(cssSafetyModule, "utf8"))).toEqual([]);
  });

  it.each([
    "@/features/drawing/shape-transform",
    "../drawing/shape-transform",
    "@/components/editor/EditorShell",
    "../../components/editor/EditorShell.tsx",
    "@/features/document/../../lib/storage",
    "../../lib/storage",
    "@/../electron/main",
    "../../../electron/main",
  ])("rejects an escaping dependency in every syntax: %s", (specifier) => {
    const source = `import { value } from "${specifier}"; export { value } from "${specifier}"; const load = () => import("${specifier}");`;
    expect(documentBoundaryViolations(source, fileURLToPath(new URL("./probe.ts", import.meta.url))))
      .toHaveLength(3);
  });

  it("accepts equivalent aliases and relative paths within the document feature", () => {
    const source = 'import type { SigmaDocument } from "@/features/document/model"; export type * from "./model/index.js";';
    expect(documentBoundaryViolations(source, fileURLToPath(new URL("./probe.ts", import.meta.url)))).toEqual([]);
  });

  it("keeps canonical model dependencies inside the document feature", () => {
    const modelFiles = productionSourceFiles(new URL("./model/", import.meta.url));
    const overlayModelSource = readFileSync(
      fileURLToPath(new URL("./overlay-model.ts", import.meta.url)),
      "utf8",
    );

    expect(forbiddenImports(modelFiles, (specifier) => !specifier.startsWith("."))).toEqual([]);
    expect(overlayModelSource).not.toMatch(/\bfrom\s+["']\.\/model["']/u);
  });

  it("owns page application logic without legacy reverse dependencies", () => {
    const pageApplicationFiles = [
      new URL("./application/line-height.ts", import.meta.url),
      new URL("./application/page-layout.ts", import.meta.url),
      new URL("./application/page-layout-resize.ts", import.meta.url),
      new URL("./application/page-running-region-layout.ts", import.meta.url),
    ].map((url) => fileURLToPath(url));
    const legacyFacades = [
      {
        url: new URL("../../lib/line-height.ts", import.meta.url),
        statement: 'export * from "@/features/document/application/line-height";',
      },
      {
        url: new URL("../../lib/page-layout.ts", import.meta.url),
        statement: 'export * from "@/features/document/application/page-layout";',
      },
      {
        url: new URL("../../lib/page-running-region-layout.ts", import.meta.url),
        statement: 'export * from "@/features/document/application/page-running-region-layout";',
      },
    ];

    expect(forbiddenImports(
      pageApplicationFiles,
      (specifier) => !specifier.startsWith("."),
    )).toEqual([]);
    for (const facade of legacyFacades) {
      const statements = readFileSync(fileURLToPath(facade.url), "utf8")
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/u, "").trim())
        .filter(Boolean);
      expect(statements).toEqual([facade.statement]);
    }
  });

  it("owns comment mutations behind the public document boundary", () => {
    const commentOperationsFile = fileURLToPath(new URL(
      "./application/comment-operations.ts",
      import.meta.url,
    ));
    const commentOperationsSource = readFileSync(commentOperationsFile, "utf8");
    const editorShellSource = readFileSync(fileURLToPath(new URL(
      "../../components/editor/EditorShell.tsx",
      import.meta.url,
    )), "utf8");
    const commentActionsSource = readFileSync(fileURLToPath(new URL(
      "../../components/editor/editor-shell/use-comment-actions.ts",
      import.meta.url,
    )), "utf8");

    expect(importSpecifiers(commentOperationsSource)).toEqual(["../model"]);
    expect(forbiddenImports(
      [commentOperationsFile],
      (specifier) => !specifier.startsWith("."),
    )).toEqual([]);
    expectTypeOf(createCommentThread).toBeFunction();
    expectTypeOf(appendCommentMessage).toBeFunction();
    expectTypeOf(setCommentThreadResolved).toBeFunction();
    expectTypeOf(updateCommentThreadBody).toBeFunction();
    expectTypeOf(updateCommentMessageBody).toBeFunction();
    expectTypeOf(toggleCommentMessageReaction).toBeFunction();
    expectTypeOf(removeCommentThread).toBeFunction();
    expectTypeOf(removeCommentReplyMessage).toBeFunction();
    expect(editorShellSource).toContain('from "./editor-shell/use-comment-actions"');
    expect(editorShellSource).toContain("useCommentActions({");
    expect(importSpecifiers(commentActionsSource)).toContain("@/features/document");
    for (const operationName of [
      "createCommentThread", "appendCommentMessage", "setCommentThreadResolved",
      "updateCommentThreadBody", "updateCommentMessageBody", "toggleCommentMessageReaction",
      "removeCommentThread", "removeCommentReplyMessage",
    ]) {
      expect(commentActionsSource).toContain(`${operationName}(`);
    }
    for (const source of [editorShellSource, commentActionsSource]) {
      expect(source).not.toMatch(/createId\(["']comment_(?:thread|msg|reaction)["']\)/u);
      expect(importSpecifiers(source)).not.toContain("@/features/document/application/comment-operations");
    }
  });

  it("owns document block operations behind the public document boundary", () => {
    const blockOperationsFile = fileURLToPath(new URL(
      "./application/document-block-operations.ts",
      import.meta.url,
    ));
    const blockOperationsSource = readFileSync(blockOperationsFile, "utf8");
    const legacyHelperSource = readFileSync(fileURLToPath(new URL(
      "../../components/editor/editor-shell/document-helpers.ts",
      import.meta.url,
    )), "utf8");
    const editorShellSource = readFileSync(fileURLToPath(new URL(
      "../../components/editor/EditorShell.tsx",
      import.meta.url,
    )), "utf8");
    const movedOperationNames = [
      "diffDeletedContentIds",
      "insertTopLevelDocumentBlocks",
      "insertTopLevelDocumentBlocksBefore",
      "repairDuplicateTopLevelIds",
    ];

    expect(importSpecifiers(blockOperationsSource)).toEqual(["../model"]);
    expect(forbiddenImports(
      [blockOperationsFile],
      (specifier) => !specifier.startsWith("."),
    )).toEqual([]);
    expect(blockOperationsSource).not.toContain("new Date");
    expect(blockOperationsSource).not.toContain("@/lib/id");
    expectTypeOf(diffDeletedContentIds).toBeFunction();
    expectTypeOf(insertTopLevelDocumentBlocks).toBeFunction();
    expectTypeOf(insertTopLevelDocumentBlocksBefore).toBeFunction();
    expectTypeOf(repairDuplicateTopLevelIds).toBeFunction();
    for (const operationName of movedOperationNames) {
      expect(legacyHelperSource).not.toContain(operationName);
      expect(editorShellSource).toContain(operationName);
    }
    expect(legacyHelperSource).not.toContain("@/lib/id");
    expect(editorShellSource).toContain("DOCUMENT_BLOCK_OPERATION_PORTS");
    expect(editorShellSource).not.toContain(
      "@/features/document/application/document-block-operations",
    );
  });

  it("owns interactive page resize math behind the public document boundary", () => {
    const facade = readFileSync(fileURLToPath(new URL(
      "../../components/editor/page-canvas/running-region-math.ts",
      import.meta.url,
    )), "utf8");
    const pageCanvas = readFileSync(fileURLToPath(new URL(
      "../../components/editor/PageCanvasEditor.tsx",
      import.meta.url,
    )), "utf8");
    const productionConsumers = [
      pageCanvas,
      readFileSync(fileURLToPath(new URL(
        "../../components/editor/page-canvas/pointer-model.ts",
        import.meta.url,
      )), "utf8"),
      readFileSync(fileURLToPath(new URL(
        "../../components/editor/page-canvas/problem-area-model.ts",
        import.meta.url,
      )), "utf8"),
      readFileSync(fileURLToPath(new URL(
        "../../components/editor/page-canvas/running-region-text-model.ts",
        import.meta.url,
      )), "utf8"),
    ];

    expect(importSpecifiers(facade)).toEqual([
      "@/features/document",
      "./page-layout-format",
    ]);
    expect(facade).not.toMatch(/\b(?:function|const|let|class)\b/);
    expect(productionConsumers.every(
      (source) => !source.includes("./running-region-math"),
    )).toBe(true);
    expect(pageCanvas).toContain('from "@/features/document"');
    expect(pageCanvas).toContain('from "./page-canvas/page-layout-format"');

    expect(legacyEnablePageRunningRegion).toBe(enablePageRunningRegion);
    expect(legacyGetRunningRegionBoundsMm).toBe(getRunningRegionBoundsMm);
    expect(legacyResizeRunningRegionLayout).toBe(
      resizeRunningRegionLayout,
    );
    expect(legacyAlignMarginToRunningRegionBoundary).toBe(
      alignMarginToRunningRegionBoundary,
    );
    expect(legacyResizeHorizontalMarginsLayout).toBe(
      resizeHorizontalMarginsLayout,
    );
    expect(legacyRoundHalfMm).toBe(roundHalfMm);
  });

  it("routes non-UI page consumers through the public document API", () => {
    const nonUiPageConsumers = [
      ...productionSourceFiles(new URL("../../lib/", import.meta.url)),
      ...productionSourceFiles(new URL("../../../electron/", import.meta.url)),
      ...productionSourceFiles(new URL("../../../mcp/", import.meta.url)),
      ...productionSourceFiles(new URL("../rendering/adapters/", import.meta.url)),
    ];

    expect(forbiddenImports(nonUiPageConsumers, (specifier) => (
      pointsToProjectPath(specifier, "lib/line-height") ||
      pointsToProjectPath(specifier, "lib/page-layout") ||
      pointsToProjectPath(specifier, "lib/page-running-region-layout")
    ))).toEqual([]);
  });

  it("routes the schema and Tiptap adapter through the public document API", () => {
    const canonicalConsumers = [
      fileURLToPath(new URL("../../lib/sigma-doc-schema.ts", import.meta.url)),
      fileURLToPath(new URL("../../lib/tiptap-adapter.ts", import.meta.url)),
    ];

    expect(forbiddenImports(
      canonicalConsumers,
      (specifier) => pointsToProjectPath(specifier, "types/sigma-doc"),
    )).toEqual([]);
    expect(canonicalConsumers.every((file) => (
      readFileSync(file, "utf8").includes('from "@/features/document"')
    ))).toBe(true);
  });

  it("keeps non-UI document consumers off the legacy canvas type path", () => {
    const nonUiFiles = [
      ...sourceFiles(new URL("../../types/", import.meta.url)),
      ...sourceFiles(new URL("../../lib/", import.meta.url)),
      ...sourceFiles(new URL("../../../electron/", import.meta.url)),
      ...sourceFiles(new URL("../../../mcp/", import.meta.url)),
    ];

    expect(filesContaining(nonUiFiles, /@\/components\/editor\/overlay-canvas\/types/)).toEqual([]);
    expect(filesContaining(nonUiFiles, /@\/components\/editor\/overlay-canvas\/store/)).toEqual([]);
    expect(filesContaining(nonUiFiles, /@\/components\/editor\/overlay-canvas\/shapes\/graph-labels/)).toEqual([]);
  });

  it("owns graph label read models behind the public document feature boundary", () => {
    expectTypeOf(getGraphAxisLabelSpecText).toBeFunction();
    expectTypeOf(getGraphAxisLabelTextsByKey).toBeFunction();
    expectTypeOf(getOverlayTextBlocksLabelText).toBeFunction();
  });

  it("owns snapshot operations behind the public document feature boundary", () => {
    const legacyStoreSource = readFileSync(fileURLToPath(new URL(
      "../../components/editor/overlay-canvas/store.ts",
      import.meta.url,
    )), "utf8");
    expectTypeOf(createEmptyOverlaySnapshot).toBeFunction();
    expectTypeOf(normalizeOverlaySnapshot).toBeFunction();
    expectTypeOf(patchShape).toBeFunction();
    expectTypeOf(removeShapes).toBeFunction();
    expectTypeOf(upsertShape).toBeFunction();
    expect(legacyStoreSource).toContain('} from "@/features/document";');
    expect(legacyStoreSource).not.toMatch(/\b(?:function|const|let|class)\b/u);
  });

  /**
   * A shape's content is built from the body's own block types, not from a second model that
   * mirrors them. The pin is a mutual assignment against those types: an alias that merely
   * *looked* like them (a hand-written copy, or one that drifted by a field) is what this replaced.
   *
   * The membership itself is pinned too, in both directions. A shape holds prose, quotes, code and
   * rules; it does not hold the page furniture that owns pagination — a box that breaks across
   * pages, a column band, a numbered problem — because a shape is drawn on top of the page rather
   * than being part of its structure.
   */
  it("stores the body's blocks in text shapes and stays narrower than the Tiptap adapter JSON", () => {
    // Written out rather than restated through the alias: naming the alias on both sides would
    // pin the type against itself and pass whatever the alias became.
    expectTypeOf<OverlayTextShape["props"]["blocks"]>()
      .toEqualTypeOf<(RichBlock | QuoteBlockNode | CodeBlockNode | DividerNode)[]>();
    // The callout holds the same blocks and shares the same editor, so it moves with the text
    // shape or not at all.
    expectTypeOf<OverlayCalloutShape["props"]["blocks"]>()
      .toEqualTypeOf<OverlayTextShape["props"]["blocks"]>();
    expectTypeOf<OverlayTextBlock>()
      .toEqualTypeOf<RichBlock | QuoteBlockNode | CodeBlockNode | DividerNode>();
    expectTypeOf<RichBlock>().toMatchTypeOf<OverlayTextBlock>();
    expectTypeOf<TiptapDoc>().not.toMatchTypeOf<OverlayTextBlock>();
    expectTypeOf<OverlayTextBlock["type"]>()
      .toEqualTypeOf<"heading" | "paragraph" | "list" | "quote" | "codeBlock" | "divider">();
    expectTypeOf<BoxBlockNode>().not.toMatchTypeOf<OverlayTextBlock>();
    expectTypeOf<LayoutSectionNode>().not.toMatchTypeOf<OverlayTextBlock>();
    expectTypeOf<ProblemNode>().not.toMatchTypeOf<OverlayTextBlock>();
  });

  it("keeps the legacy SigmaDoc facade type-identical to canonical semantic primitives", () => {
    expectTypeOf<LegacyGraph2DSpec>().toEqualTypeOf<Graph2DSpec>();
    expectTypeOf<LegacyInlineNode>().toEqualTypeOf<InlineNode>();
    expectTypeOf<LegacyLineHeight>().toEqualTypeOf<LineHeight>();
    expectTypeOf<LegacyMathFractionSizing>().toEqualTypeOf<MathFractionSizing>();
    expectTypeOf<LegacySigmaCommentThread>().toEqualTypeOf<SigmaCommentThread>();
    expectTypeOf<LegacySigmaCommentMessage>().toEqualTypeOf<SigmaCommentMessage>();
    expectTypeOf<LegacySigmaCommentReaction>().toEqualTypeOf<SigmaCommentReaction>();
    expectTypeOf<LegacySigmaCommentAnchor>().toEqualTypeOf<SigmaCommentAnchor>();
    expectTypeOf<LegacySigmaTextRangeCommentAnchor>().toEqualTypeOf<SigmaTextRangeCommentAnchor>();
    expectTypeOf<LegacySigmaCommentTextPosition>().toEqualTypeOf<SigmaCommentTextPosition>();
    expectTypeOf<LegacySigmaInlineMathCommentAnchor>().toEqualTypeOf<SigmaInlineMathCommentAnchor>();
    expectTypeOf<LegacySigmaBlockCommentAnchor>().toEqualTypeOf<SigmaBlockCommentAnchor>();
    expectTypeOf<LegacySigmaOverlayShapeCommentAnchor>().toEqualTypeOf<SigmaOverlayShapeCommentAnchor>();
    expectTypeOf<LegacySigmaOverlayMathCommentAnchor>().toEqualTypeOf<SigmaOverlayMathCommentAnchor>();
    expectTypeOf<LegacyTextAlign>().toEqualTypeOf<TextAlign>();
  });

  it("keeps the legacy SigmaDoc facade as a logic-free type re-export", () => {
    const sigmaDocFacade = readFileSync(fileURLToPath(new URL(
      "../../types/sigma-doc.ts",
      import.meta.url,
    )), "utf8");
    const facadeStatements = sigmaDocFacade
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/u, "").trim())
      .filter(Boolean);

    expect(facadeStatements).toEqual([
      'export type * from "@/features/document/model";',
    ]);
  });
});

describe("rendering and editor feature dependency boundaries", () => {
  it("keeps rendering core independent from UI frameworks and adapters", () => {
    const renderingCoreFiles = productionSourceFiles(new URL("../rendering/core/", import.meta.url));

    expect(forbiddenImports(renderingCoreFiles, (specifier) => (
      (!specifier.startsWith(".") && !pointsToProjectPath(specifier, "features/document")) ||
      isReactImport(specifier) ||
      isTiptapImport(specifier) ||
      isAiFeatureImport(specifier) ||
      specifier === "katex" ||
      specifier.startsWith("katex/") ||
      pointsToProjectPath(specifier, "components") ||
      pointsToProjectPath(specifier, "features/rendering/adapters") ||
      pointsToProjectPath(specifier, "types/sigma-doc")
    ))).toEqual([]);
    const domTokenPattern =
      /\b(?:window|HTMLElement|Element|ResizeObserver|MutationObserver)\b|data-[a-z]|--[a-z]/;
    expect(renderingCoreFiles.filter((file) => (
      domTokenPattern.test(withoutModuleSpecifierText(
        readFileSync(file, "utf8"),
      ))
    ))).toEqual([]);
    // Canonical document primitives (font resolution, table grids, unit conversion) are
    // pure inward dependencies. The document boundary above keeps that layer framework-free.
  });

  it("keeps base editing surfaces independent from AI feature internals", () => {
    const baseEditorFiles = [
      new URL("../../components/editor/TextFlowEditor.tsx", import.meta.url),
      new URL("../../components/editor/OverlayCanvasEditorClient.tsx", import.meta.url),
      new URL("../../components/editor/overlay-canvas/shape-renderer.tsx", import.meta.url),
    ].map((url) => fileURLToPath(url));

    expect(forbiddenImports(baseEditorFiles, isAiFeatureImport)).toEqual([]);
  });
});
