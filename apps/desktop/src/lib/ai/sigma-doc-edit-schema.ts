import { MAX_AI_SVG_BYTES, validateAiSvg } from "./svg-image";
import { tv } from "@/lib/ai/validation-locale";
import { z } from "zod";

import {
  listItemContinuationInlineNodes,
  isOverlayAsset,
  isValidOverlaySnapshot,
  normalizeOverlaySnapshot,
  patchShape,
  removeShapes,
  type SigmaTableBorderStyle,
  type SigmaTableCell,
  type SigmaTableCellContent,
  type SigmaTableCellStyle,
  type SigmaTableColumn,
  type SigmaTableColumnRole,
  type SigmaTableGridStyle,
  type SigmaTableKind,
  type SigmaTableRow,
  type SigmaTableRowRole,
  type SigmaTableSpec,
  type SigmaTableTrackSize,
  type SigmaTableTrendDirection,
  type OverlayAsset,
  type OverlayGraphShape,
  type OverlayShape,
  type OverlayShapeId,
  type OverlayShapePatch,
  type OverlaySnapshot,
  type OverlayTableShape,
  DEFAULT_PAGE_MARGINS_MM,
  MIN_PAGE_BODY_HEIGHT_MM,
  PAGE_SIZE_PRESETS_MM,
  ensurePageLayout,
  expandMarginsForRunningRegions,
  getPageLayoutIssues,
  isWhiteboardPageLayout,
  normalizePageLayout,
  type PageLayoutInput,
  type SigmaBlock,
  type SigmaDocument,
  type InlineNode,
  type LayoutSectionChildBlock,
  type ListItemNode,
  type ProblemAreaBlock,
  type ProblemNode,
  type RichBlock,
  type TextAlign,
} from "@/features/document";
import { areStructurallyEqual } from "@/lib/structural-equality";

import {
  deleteBlocksFromDocument,
  ensureBodyBlockAfterProblem,
  findBlock,
  findContainingLayoutSection,
  insertRichBlockNearSelection,
  insertTopLevelBlock,
  moveBlocksInDocument,
  type EditableBlock,
  unwrapLayoutSection,
  updateBlockInDocument,
  wrapTextFlowBlocksInLayoutSection,
} from "@/lib/document-tree";
import { splitDelimitedInlineMathText } from "@/features/rendering/core";
import { SigmaBlockSchema, RichBlockSchema, getTexIssues, parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { createId } from "@/lib/id";
import { formatSigmaValidationCode } from "@/lib/validation-text";

export const AI_EDIT_MODELS = ["gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna"] as const;
export type AiEditModel = (typeof AI_EDIT_MODELS)[number] | (string & {});
export const DEFAULT_AI_EDIT_MODEL: AiEditModel = "gpt-5.6-luna";
export const AI_EDIT_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
// Codex app-server advertises supported efforts per model through model/list.
// Keep this open to newly introduced values (for example `none` or `max`)
// while retaining the array above as the offline fallback picker.
export type AiEditReasoningEffort = (typeof AI_EDIT_REASONING_EFFORTS)[number] | (string & {});
export const DEFAULT_AI_EDIT_REASONING_EFFORT: AiEditReasoningEffort = "low";
export const EditableBlockSchema: z.ZodType<EditableBlock> = z.union([SigmaBlockSchema, RichBlockSchema]);
const OverlayTableShapeSchema = z.custom<OverlayTableShape>(
  (value): value is OverlayTableShape => isAiOverlayTableShape(value),
) as z.ZodType<OverlayTableShape>;

const AiEditReplaceDraftSchema = z.object({
  operation: z.literal("replace").optional(),
  summary: z.string().min(1),
  targetId: z.string().min(1),
  replacementBlock: EditableBlockSchema,
});

const AiEditInsertAfterDraftSchema = z.object({
  operation: z.literal("insertAfter"),
  summary: z.string().min(1),
  targetId: z.string().min(1),
  insertedBlock: EditableBlockSchema,
});

const AiEditInsertTableShapeDraftSchema = z.object({
  operation: z.literal("insertTableShape"),
  summary: z.string().min(1),
  targetId: z.string().min(1),
  tableShape: OverlayTableShapeSchema,
});

const AiOverlayAssetSchema = z.custom<OverlayAsset>(
  (value): value is OverlayAsset => isOverlayAsset(value),
);
export const MAX_AI_OVERLAY_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_AI_OVERLAY_ASSET_DIMENSION = 8192;
export const MAX_AI_OVERLAY_ASSET_PIXELS = 25_000_000;
export const MAX_AI_OVERLAY_ASSETS_PER_OPERATION = 16;
export const MAX_AI_OVERLAY_ASSETS_PER_PROPOSAL = 64;
export const MAX_AI_OVERLAY_ASSET_DECODED_BYTES_PER_PROPOSAL = 8 * 1024 * 1024;
export const MAX_AI_OVERLAY_ASSET_ENCODED_BYTES_PER_PROPOSAL = 12 * 1024 * 1024;
export const MAX_AI_EDIT_OPERATIONS_PER_PROPOSAL = 256;
const MAX_AI_STORAGE_ASSET_REFERENCE_LENGTH = 160;
const AI_STORAGE_ASSET_REFERENCE_PATTERN = /^sigma-doc-storage:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AiOverlayAssetsSchema = z.record(z.string(), AiOverlayAssetSchema).superRefine((assets, context) => {
  if (Object.keys(assets).length > MAX_AI_OVERLAY_ASSETS_PER_OPERATION) {
    context.addIssue({
      code: z.ZodIssueCode.too_big,
      maximum: MAX_AI_OVERLAY_ASSETS_PER_OPERATION,
      inclusive: true,
      origin: "object",
      message: tv("schema.overlayAssets1", { p0: MAX_AI_OVERLAY_ASSETS_PER_OPERATION }),
    });
  }
  for (const [assetId, asset] of Object.entries(assets)) {
    if (asset.id !== assetId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [assetId, "id"],
        message: tv("schema.overlayAssets2"),
      });
    }
    if (!isAllowedAiOverlayAssetSource(asset.props.src)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [assetId, "props", "src"],
        message: tv("schema.overlayAssets3"),
      });
    }
  }
});

const AiEditInsertOverlayShapeDraftSchema = z.object({
  operation: z.literal("insertOverlayShape"),
  summary: z.string().min(1),
  targetId: z.string().min(1),
  overlayShape: z.custom<OverlayShape>((value) => isRecord(value)),
  assets: AiOverlayAssetsSchema.optional().default({}),
});

export const AiEditDraftSchema = z.union([
  AiEditReplaceDraftSchema,
  AiEditInsertAfterDraftSchema,
  AiEditInsertTableShapeDraftSchema,
  AiEditInsertOverlayShapeDraftSchema,
]);

export type AiEditDraft = z.infer<typeof AiEditDraftSchema>;

// --- Additional block/layout/overlay/page-layout mutation operations ---
//
// These are intentionally NOT part of AiEditDraftSchema/AiEditDraft above: that union is
// rendered directly by features/ai-edit/view/AiEditInlinePreviewCard.tsx, which narrows on
// `draft.operation` and assumes every non-insert variant carries a `replacementBlock`. Adding
// members here would break that (out of scope) component. These mutation ops are applied via
// their own `applySigmaDocMutationOp` below and summarized via sigma-doc-agent-tools.ts's
// `summarizeSigmaDocMutationOps`, independent of the AiEditDraft/session-draft pipeline.

const SigmaDocDeleteBlocksOpSchema = z.object({
  operation: z.literal("deleteBlocks"),
  summary: z.string().min(1),
  blockIds: z.array(z.string().min(1)).min(1),
});

const SigmaDocMoveBlocksOpSchema = z.object({
  operation: z.literal("moveBlocks"),
  summary: z.string().min(1),
  blockIds: z.array(z.string().min(1)).min(1),
  targetId: z.string().min(1),
  position: z.enum(["before", "after"]),
});

const SigmaDocUpdateOverlayShapeOpSchema = z.object({
  operation: z.literal("updateOverlayShape"),
  summary: z.string().min(1),
  shapeId: z.string().min(1),
  patch: z.record(z.string(), z.unknown()),
  // Some shapes carry a derived picture in the overlay's asset store (a 3D figure's headless
  // preview PNG). Changing such a shape's spec without being able to replace that picture in the
  // same operation would leave the document showing the old figure, so an update writes its
  // replacement assets here. The same `AiOverlayAssetsSchema` the insert path uses gates the
  // source, so an update cannot smuggle in a form insertion is not allowed to write either.
  assets: AiOverlayAssetsSchema.optional(),
});

const SigmaDocAlignOverlayShapesOpSchema = z.object({
  operation: z.literal("alignOverlayShapes"),
  summary: z.string().min(1),
  shapeIds: z.array(z.string().min(1)).min(2),
  mode: z.enum(["left", "right", "top", "bottom", "centerX", "centerY", "distributeX", "distributeY"]),
});

const SigmaDocDeleteOverlayShapesOpSchema = z.object({
  operation: z.literal("deleteOverlayShapes"),
  summary: z.string().min(1),
  shapeIds: z.array(z.string().min(1)).min(1),
});
const StandardPageSizePresetSchema = z.enum(["A4", "A3", "B5", "B4", "whiteboard", "custom"]);
const PageLayoutSizePatchSchema = z.object({
  widthMm: z.number().positive({ error: () => tv("schema.pageLayoutSizePatch1") }).optional(),
  heightMm: z.number().positive({ error: () => tv("schema.pageLayoutSizePatch2") }).optional(),
}).strict().refine((patch) => patch.widthMm !== undefined || patch.heightMm !== undefined, {
  error: () => tv("schema.pageLayoutSizePatch3"),
});
// `.describe()` は**スキーマ構築時**に評価されるので `tv()` を渡すと読み込み時の言語で
// 焼き付く。ここの説明は MCP のツール schema として外へ出ておらず (公開 schema は
// `mcp/sigma-doc-mcp-server-core.ts` が別に定義する) モデルにも届かない内部文書なので、
// リテラルのまま残す。
const PageLayoutMarginsPatchSchema = z.object({
  top: z.number().nonnegative({ error: () => tv("schema.pageLayoutMarginsPatch1") }).optional()
    .describe(`上余白(mm)。既定値は${DEFAULT_PAGE_MARGINS_MM.top}mmです。`),
  right: z.number().nonnegative({ error: () => tv("schema.pageLayoutMarginsPatch3") }).optional()
    .describe(`右余白(mm)。既定値は${DEFAULT_PAGE_MARGINS_MM.right}mmです。`),
  bottom: z.number().nonnegative({ error: () => tv("schema.pageLayoutMarginsPatch5") }).optional()
    .describe(`下余白(mm)。既定値は${DEFAULT_PAGE_MARGINS_MM.bottom}mmです。`),
  left: z.number().nonnegative({ error: () => tv("schema.pageLayoutMarginsPatch7") }).optional()
    .describe(`左余白(mm)。既定値は${DEFAULT_PAGE_MARGINS_MM.left}mmです。`),
}).strict().refine((patch) => Object.values(patch).some((value) => value !== undefined), {
  error: () => tv("schema.pageLayoutMarginsPatch9"),
});
const PageLayoutPatchSchema = z.object({
  preset: z.union([StandardPageSizePresetSchema, z.literal("custom")]).optional(),
  orientation: z.enum(["portrait", "landscape"]).optional(),
  pageSize: PageLayoutSizePatchSchema.optional(),
  marginsMm: PageLayoutMarginsPatchSchema.optional(),
}).strict().refine((patch) => Object.values(patch).some((value) => value !== undefined), {
  error: () => tv("schema.pageLayoutPatch1"),
});

const SigmaDocUpdatePageLayoutOpSchema = z.object({
  operation: z.literal("updatePageLayout"),
  summary: z.string().min(1),
  patch: PageLayoutPatchSchema,
});

const SigmaDocSetDocumentColumnsOpSchema = z.object({
  operation: z.literal("setDocumentColumns"),
  summary: z.string().min(1),
  columnCount: z.number().int().min(1).max(4),
  columnGapMm: z.number().nonnegative().optional(),
});

const SigmaDocWrapBlocksInColumnsOpSchema = z.object({
  operation: z.literal("wrapBlocksInColumns"),
  summary: z.string().min(1),
  blockIds: z.array(z.string().min(1)).min(1),
  columnCount: z.number().int().min(2).max(4),
  columnGapMm: z.number().nonnegative().optional(),
});

const SigmaDocUpdateLayoutSectionOpSchema = z.object({
  operation: z.literal("updateLayoutSection"),
  summary: z.string().min(1),
  sectionId: z.string().min(1),
  columnCount: z.number().int().min(1).max(4).optional(),
  columnGapMm: z.number().nonnegative().optional(),
  unwrap: z.boolean().optional(),
}).superRefine((value, context) => {
  if (value.unwrap !== true && value.columnCount === undefined && value.columnGapMm === undefined) {
    context.addIssue({
      code: "custom",
      message: tv("schema.updateLayoutSectionOp1"),
    });
  }
});

export const SigmaDocMutationOpSchema = z.union([
  SigmaDocDeleteBlocksOpSchema,
  SigmaDocMoveBlocksOpSchema,
  SigmaDocUpdateOverlayShapeOpSchema,
  SigmaDocAlignOverlayShapesOpSchema,
  SigmaDocDeleteOverlayShapesOpSchema,
  SigmaDocUpdatePageLayoutOpSchema,
  SigmaDocSetDocumentColumnsOpSchema,
  SigmaDocWrapBlocksInColumnsOpSchema,
  SigmaDocUpdateLayoutSectionOpSchema,
]);

export type SigmaDocMutationOp = z.infer<typeof SigmaDocMutationOpSchema>;

export interface SigmaDocMutationResult {
  op: SigmaDocMutationOp;
  nextDocument: SigmaDocument;
}

export function parseSigmaDocMutationOp(input: unknown): SigmaDocMutationOp {
  return SigmaDocMutationOpSchema.parse(parseJsonStringIfNeeded(input));
}

/**
 * The first document id a mutation op affects — used to anchor its preview
 * card to a block (including local column sections) or, for overlay-shape ops, to
 * identify the shape it targets (which the inline text-flow preview cannot
 * anchor to, but the AI task dock and MCP proposal summaries still surface).
 * Defensive against op shapes the current SigmaDocMutationOpSchema union
 * doesn't (yet) know about — falls back to common field names, then undefined.
 */
export function primarySigmaDocMutationOpTargetId(op: SigmaDocMutationOp | Record<string, unknown>): string | undefined {
  const operation = (op as { operation?: unknown }).operation;
  if (operation === "deleteBlocks" || operation === "moveBlocks") {
    return (op as Extract<SigmaDocMutationOp, { operation: "deleteBlocks" | "moveBlocks" }>).blockIds[0];
  }
  if (operation === "updateOverlayShape") {
    return (op as Extract<SigmaDocMutationOp, { operation: "updateOverlayShape" }>).shapeId;
  }
  if (operation === "alignOverlayShapes" || operation === "deleteOverlayShapes") {
    return (op as Extract<SigmaDocMutationOp, { operation: "alignOverlayShapes" | "deleteOverlayShapes" }>).shapeIds[0];
  }
  if (operation === "wrapBlocksInColumns") {
    return (op as Extract<SigmaDocMutationOp, { operation: "wrapBlocksInColumns" }>).blockIds[0];
  }
  if (operation === "updateLayoutSection") {
    return (op as Extract<SigmaDocMutationOp, { operation: "updateLayoutSection" }>).sectionId;
  }
  // Unknown future op type: best-effort guess from common field shapes.
  const fallback = op as { blockIds?: unknown[]; shapeIds?: unknown[]; shapeId?: unknown; targetId?: unknown };
  const guess = fallback.blockIds?.[0] ?? fallback.shapeIds?.[0] ?? fallback.shapeId ?? fallback.targetId;
  return typeof guess === "string" ? guess : undefined;
}

/**
 * Applies one of the additional block/layout/overlay/page-layout mutation operations to `document`, returning the
 * next document. Pure function: throws (Japanese message) on any validation failure instead of
 * mutating in place. Callers (e.g. sigma-doc-agent-tools.ts) are expected to run
 * `parseSigmaDocument`/math validation on the result the same way the existing AiEditDraft
 * pipeline does.
 */
export function applySigmaDocMutationOp(document: SigmaDocument, input: unknown): SigmaDocMutationResult {
  const op = parseSigmaDocMutationOp(input);

  if (op.operation === "deleteBlocks") {
    return { op, nextDocument: parseSigmaDocument(deleteBlocksFromDocument(document, op.blockIds)) };
  }

  if (op.operation === "moveBlocks") {
    return {
      op,
      nextDocument: parseSigmaDocument(moveBlocksInDocument(document, op.blockIds, op.targetId, op.position)),
    };
  }

  if (op.operation === "updateOverlayShape") {
    return { op, nextDocument: parseSigmaDocument(applyUpdateOverlayShape(document, op)) };
  }

  if (op.operation === "alignOverlayShapes") {
    return { op, nextDocument: parseSigmaDocument(applyAlignOverlayShapes(document, op)) };
  }
  if (op.operation === "updatePageLayout") {
    const withLayout = ensurePageLayout(document);
    const baseLayout = withLayout.pageLayout ?? normalizePageLayout({
      preset: "A4",
      pageSize: PAGE_SIZE_PRESETS_MM.A4,
      marginsMm: DEFAULT_PAGE_MARGINS_MM,
    });
    if (isWhiteboardPageLayout(baseLayout) && op.patch.preset && op.patch.preset !== "whiteboard") {
      throw new Error(tv("schema.whiteboardToPaperUnsupported"));
    }
    const mergedLayout: PageLayoutInput = {
      ...baseLayout,
      ...op.patch,
      pageSize: {
        ...baseLayout.pageSize,
        ...op.patch.pageSize,
      },
      marginsMm: {
        ...baseLayout.marginsMm,
        ...op.patch.marginsMm,
      },
    };
    const normalizedLayout = expandMarginsForRunningRegions(normalizePageLayout(mergedLayout));
    const issues = getPageLayoutIssues(normalizedLayout);
    if (issues.length > 0) {
      // `getPageLayoutIssues` はコードを返すので、必ず文へ解決してから並べる
      // (そのまま join すると `pageMarginTooTall` のような内部 enum が表に出る)。
      // 本文高さの注意書きは `pageMarginTooTall` の文面に含まれるので別に足さない。
      throw new Error([
        tv("schema.applySigmaDocMutationOp1"),
        ...issues.map((code) => formatSigmaValidationCode(code, { min: MIN_PAGE_BODY_HEIGHT_MM })),
      ].join(" "));
    }
    return {
      op,
      nextDocument: parseSigmaDocument({
        ...withLayout,
        pageLayout: normalizedLayout,
      }),
    };
  }

  if (op.operation === "setDocumentColumns") {
    return { op, nextDocument: parseSigmaDocument(applySetDocumentColumns(document, op)) };
  }

  if (op.operation === "wrapBlocksInColumns") {
    return { op, nextDocument: parseSigmaDocument(applyWrapBlocksInColumns(document, op)) };
  }

  if (op.operation === "updateLayoutSection") {
    return { op, nextDocument: parseSigmaDocument(applyUpdateLayoutSection(document, op)) };
  }

  return { op, nextDocument: parseSigmaDocument(applyDeleteOverlayShapes(document, op)) };
}

function applySetDocumentColumns(
  document: SigmaDocument,
  op: Extract<SigmaDocMutationOp, { operation: "setDocumentColumns" }>,
): SigmaDocument {
  const base = ensurePageLayout(document);
  const currentLayout = normalizePageLayout(base.pageLayout);
  if (isWhiteboardPageLayout(currentLayout)) {
    throw new Error(tv("schema.whiteboardColumnsUnsupported"));
  }
  const pageLayout = normalizePageLayout({
    ...currentLayout,
    flow: {
      ...currentLayout.flow,
      columnCount: op.columnCount,
      ...(op.columnGapMm === undefined ? {} : { columnGapMm: op.columnGapMm }),
    },
  });
  assertValidColumnLayout(pageLayout);
  return ensurePageLayout({
    ...base,
    pageLayout,
    updatedAt: new Date().toISOString(),
  });
}

function applyWrapBlocksInColumns(
  document: SigmaDocument,
  op: Extract<SigmaDocMutationOp, { operation: "wrapBlocksInColumns" }>,
): SigmaDocument {
  if (new Set(op.blockIds).size !== op.blockIds.length) {
    throw new Error(tv("schema.applyWrapBlocksInColumns1"));
  }

  for (const blockId of op.blockIds) {
    const block = findBlock(document, blockId);
    if (!block) {
      throw new Error(tv("schema.applyWrapBlocksInColumns2", { p0: blockId }));
    }
    if (findContainingLayoutSection(document, blockId)) {
      throw new Error(tv("schema.applyWrapBlocksInColumns3", { p0: blockId }));
    }
    if (
      block.type !== "section" &&
      block.type !== "heading" &&
      block.type !== "paragraph" &&
      block.type !== "list" &&
      block.type !== "divider" &&
      block.type !== "boxBlock"
    ) {
      throw new Error(tv("schema.applyWrapBlocksInColumns4", { p0: blockId }));
    }
  }

  const currentLayout = normalizePageLayout(document.pageLayout);
  const columnGapMm = op.columnGapMm ?? currentLayout.flow.columnGapMm;
  assertValidColumnLayout(normalizePageLayout({
    ...currentLayout,
    flow: { ...currentLayout.flow, columnCount: op.columnCount, columnGapMm },
  }));

  const nextDocument = wrapTextFlowBlocksInLayoutSection(
    document,
    op.blockIds,
    op.columnCount,
    columnGapMm,
  );
  if (nextDocument === document) {
    throw new Error(tv("schema.applyWrapBlocksInColumns5"));
  }

  return nextDocument;
}

function applyUpdateLayoutSection(
  document: SigmaDocument,
  op: Extract<SigmaDocMutationOp, { operation: "updateLayoutSection" }>,
): SigmaDocument {
  const section = findBlock(document, op.sectionId);
  if (!section) {
    throw new Error(tv("schema.applyUpdateLayoutSection1", { p0: op.sectionId }));
  }
  if (section.type !== "layoutSection") {
    throw new Error(tv("schema.applyUpdateLayoutSection2", { p0: op.sectionId }));
  }

  if (op.unwrap === true) {
    if (op.columnCount !== undefined || op.columnGapMm !== undefined) {
      throw new Error(tv("schema.applyUpdateLayoutSection3"));
    }
    return unwrapLayoutSection(document, op.sectionId);
  }
  if (op.columnCount === undefined && op.columnGapMm === undefined) {
    throw new Error(tv("schema.applyUpdateLayoutSection4"));
  }

  const currentLayout = normalizePageLayout(document.pageLayout);
  const columnCount = op.columnCount ?? section.layout.columnCount;
  const columnGapMm = op.columnGapMm ?? section.layout.columnGapMm ?? currentLayout.flow.columnGapMm;
  assertValidColumnLayout(normalizePageLayout({
    ...currentLayout,
    flow: { ...currentLayout.flow, columnCount, columnGapMm },
  }));

  return updateBlockInDocument(document, op.sectionId, (block) => {
    if (block.type !== "layoutSection") {
      return block;
    }
    return {
      ...block,
      layout: {
        ...block.layout,
        ...(op.columnCount === undefined ? {} : { columnCount: op.columnCount }),
        ...(op.columnGapMm === undefined ? {} : { columnGapMm: op.columnGapMm }),
      },
    };
  });
}

function assertValidColumnLayout(pageLayout: ReturnType<typeof normalizePageLayout>): void {
  const issues = getPageLayoutIssues(pageLayout);
  if (issues.length > 0) {
    const messages = issues.map((code) => formatSigmaValidationCode(code, { min: MIN_PAGE_BODY_HEIGHT_MM }));
    throw new Error(tv("schema.assertValidColumnLayout1", { p0: messages.join(" / ") }));
  }
}

export const AiEditSessionDraftSchema = z.object({
  summary: z.string().min(1),
  plan: z.array(z.string().min(1)).min(1),
  // Historically required at least one entry. Now optional (defaults to []) because a
  // mutation-only session draft (block/layout/overlay ops — see
  // `mutationOperations` below) carries zero AiEditDraft operations. `createAiEditSessionDocumentDraft`
  // enforces that at least one of operations/mutationOperations is non-empty at runtime.
  operations: z.array(AiEditDraftSchema).optional().default([]),
  warnings: z.array(z.string().min(1)).optional().default([]),
  // Block/layout/overlay/page-layout operations (see SigmaDocMutationOpSchema above), kept in a
  // separate array from `operations`
  // for the same reason session.mutationOperations is separate from session.operations (see the
  // comment on that field in sigma-doc-agent-tools.ts): the AiEditDraft union is rendered
  // directly by AiEditInlinePreviewCard, which assumes every entry carries a
  // replacementBlock/insertedBlock/overlayShape/tableShape. Persisted MCP edit proposals
  // (LocalMcpEditProposal.draft) may carry this alongside `operations`; re-applying a persisted
  // draft (see createAiEditSessionDocumentDraft below) executes legacy records as `operations`
  // first, then `mutationOperations`; aggregated MCP records can preserve their cross-array order
  // with `operationOrder` below.
  //
  // Deliberately `.optional()` WITHOUT `.default([])`: unlike `operations`/`warnings` above, this
  // field is new and many existing call sites across the codebase construct AiEditSessionDraft
  // object literals directly (not via this schema's `.parse()`) and are out of scope for this
  // change. A `.default()` here would make TypeScript's inferred type require the key on every
  // such literal. Treat a missing/undefined value the same as an empty array.
  mutationOperations: z.array(SigmaDocMutationOpSchema).optional(),
  // `operations` と `mutationOperations` は後方互換のため別配列のまま保持するが、複数の
  // MCP tool call を1提案へ集約するときは配列をまたぐ実行順も保存する必要がある。
  // 未指定の旧提案は従来どおり operations -> mutationOperations の順で再生する。
  operationOrder: z.array(z.object({
    kind: z.enum(["operation", "mutation"]),
    index: z.number().int().nonnegative(),
  })).optional(),
}).superRefine((draft, context) => {
  const operationCount = draft.operations.length + (draft.mutationOperations?.length ?? 0);
  if (operationCount > MAX_AI_EDIT_OPERATIONS_PER_PROPOSAL) {
    context.addIssue({
      code: z.ZodIssueCode.too_big,
      maximum: MAX_AI_EDIT_OPERATIONS_PER_PROPOSAL,
      inclusive: true,
      origin: "array",
      path: ["operations"],
      message: tv("schema.editSessionDraft1", { p0: MAX_AI_EDIT_OPERATIONS_PER_PROPOSAL }),
    });
  }

  const assets = [
    ...draft.operations.flatMap((operation) => (
      operation.operation === "insertOverlayShape" ? Object.values(operation.assets ?? {}) : []
    )),
    // Replacement assets on an update cost the proposal exactly what an insertion's do, so they
    // are weighed on the same scale — otherwise a run of updates could carry unbounded bytes.
    ...(draft.mutationOperations ?? []).flatMap((operation) => (
      operation.operation === "updateOverlayShape" ? Object.values(operation.assets ?? {}) : []
    )),
  ];
  if (assets.length > MAX_AI_OVERLAY_ASSETS_PER_PROPOSAL) {
    context.addIssue({
      code: z.ZodIssueCode.too_big,
      maximum: MAX_AI_OVERLAY_ASSETS_PER_PROPOSAL,
      inclusive: true,
      origin: "array",
      path: ["operations"],
      message: tv("schema.editSessionDraft2", { p0: MAX_AI_OVERLAY_ASSETS_PER_PROPOSAL }),
    });
  }

  let encodedBytes = 0;
  let decodedBytes = 0;
  for (const asset of assets) {
    const sizes = getAiOverlayAssetSourceSizes(asset.props.src);
    if (!sizes) {
      continue;
    }
    encodedBytes += sizes.encodedBytes;
    decodedBytes += sizes.decodedBytes;
  }
  if (encodedBytes > MAX_AI_OVERLAY_ASSET_ENCODED_BYTES_PER_PROPOSAL) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["operations"],
      message: tv("schema.editSessionDraft3"),
    });
  }
  if (decodedBytes > MAX_AI_OVERLAY_ASSET_DECODED_BYTES_PER_PROPOSAL) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["operations"],
      message: tv("schema.editSessionDraft4"),
    });
  }
});

export type AiEditSessionDraft = z.infer<typeof AiEditSessionDraftSchema>;
export type AiEditSessionOperationOrderEntry = NonNullable<AiEditSessionDraft["operationOrder"]>[number];

/**
 * True when replay can only add new blocks/shapes and cannot mutate existing
 * content. Legacy insert proposals may use this structural freshness contract
 * even when touchedBlocks/requestSelection were not persisted: external
 * anchors must still exist and inserted ids must still be available, but the
 * anchor text itself is not a dependency.
 */
export function isAdditiveInsertOnlyDraft(
  draft: AiEditSessionDraft,
  currentDocument?: Pick<SigmaDocument, "pageLayout">,
): boolean {
  if (draft.operations.length === 0 || (draft.mutationOperations?.length ?? 0) > 0) {
    return false;
  }

  const occupiedAssetIds = currentDocument
    ? new Set(Object.keys(normalizeOverlaySnapshot(currentDocument.pageLayout?.overlay?.overlaySnapshot).assets))
    : null;
  for (const operation of draft.operations) {
    if (operation.operation !== "insertAfter"
      && operation.operation !== "insertTableShape"
      && operation.operation !== "insertOverlayShape") {
      return false;
    }
    if (operation.operation !== "insertOverlayShape") {
      continue;
    }
    const assetIds = Object.keys(operation.assets ?? {});
    if (assetIds.length > 0 && occupiedAssetIds === null) {
      return false;
    }
    if (assetIds.some((assetId) => occupiedAssetIds?.has(assetId))) {
      return false;
    }
    assetIds.forEach((assetId) => occupiedAssetIds?.add(assetId));
  }
  return true;
}

export function resolveAiEditSessionOperationOrder(
  draft: Pick<AiEditSessionDraft, "operations" | "mutationOperations" | "operationOrder">,
): AiEditSessionOperationOrderEntry[] {
  const mutationOperations = draft.mutationOperations ?? [];
  const fallback: AiEditSessionOperationOrderEntry[] = [
    ...draft.operations.map((_, index) => ({ kind: "operation" as const, index })),
    ...mutationOperations.map((_, index) => ({ kind: "mutation" as const, index })),
  ];
  if (draft.operationOrder === undefined) {
    return fallback;
  }
  if (draft.operationOrder.length !== fallback.length) {
    throw new Error(tv("schema.resolveAiEditSessionOperationOrder1"));
  }

  const seen = new Set<string>();
  for (const entry of draft.operationOrder) {
    const listLength = entry.kind === "operation" ? draft.operations.length : mutationOperations.length;
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= listLength) {
      throw new Error(tv("schema.resolveAiEditSessionOperationOrder2", { p0: entry.kind, p1: entry.index }));
    }
    const key = `${entry.kind}:${entry.index}`;
    if (seen.has(key)) {
      throw new Error(tv("schema.resolveAiEditSessionOperationOrder3", { p0: key }));
    }
    seen.add(key);
  }
  return draft.operationOrder;
}

export interface AiEditDocumentDraft {
  draft: AiEditDraft;
  nextDocument: SigmaDocument;
  previousBlock: EditableBlock | null;
}

interface CreateAiEditDocumentDraftOptions {
  ensureBodyAfterInsertedProblem?: boolean;
}

export interface AiEditSessionDocumentDraft {
  draft: AiEditSessionDraft;
  nextDocument: SigmaDocument;
  operationResults: AiEditDocumentDraft[];
}

export function parseAiEditDraft(input: unknown): AiEditDraft {
  return AiEditDraftSchema.parse(parseJsonStringIfNeeded(input));
}

export function parseAiEditSessionDraft(input: unknown): AiEditSessionDraft {
  const parsed = parseJsonStringIfNeeded(input);

  if (isLikelySingleAiEditDraft(parsed)) {
    const draft = parseAiEditDraft(parsed);
    return {
      summary: draft.summary,
      plan: [draft.summary],
      operations: [draft],
      warnings: [],
    };
  }

  const sessionDraft = AiEditSessionDraftSchema.parse(parsed);
  return {
    ...sessionDraft,
    warnings: sessionDraft.warnings ?? [],
  };
}

export function normalizeAiEditReasoningEffort(input: unknown): AiEditReasoningEffort {
  if (typeof input !== "string") {
    return DEFAULT_AI_EDIT_REASONING_EFFORT;
  }

  const normalized = input.trim().toLowerCase();
  return normalized || DEFAULT_AI_EDIT_REASONING_EFFORT;
}

export function validateAiEditDraftForDocument(
  document: SigmaDocument,
  selectedId: string | null,
  input: unknown,
): AiEditDocumentDraft {
  if (!selectedId) {
    throw new Error(tv("schema.validateAiEditDraftForDocument1"));
  }

  const draft = parseAiEditDraft(input);
  return createAiEditDocumentDraft(document, selectedId, draft);
}

export function validateAiEditSessionDraftForDocument(
  document: SigmaDocument,
  selectedId: string | null,
  input: unknown,
): AiEditSessionDocumentDraft {
  const draft = parseAiEditSessionDraft(input);
  return createAiEditSessionDocumentDraft(document, selectedId, draft);
}

export function createAiEditSessionDocumentDraft(
  document: SigmaDocument,
  selectedId: string | null,
  draft: AiEditSessionDraft,
): AiEditSessionDocumentDraft {
  const usesWhiteboardCanvasTarget = selectedId === "CANVAS"
    && Boolean(document.pageLayout && isWhiteboardPageLayout(document.pageLayout));
  if (selectedId && !usesWhiteboardCanvasTarget && !findBlock(document, selectedId)) {
    throw new Error(tv("schema.createAiEditSessionDocumentDraft1"));
  }

  const mutationOperations = draft.mutationOperations ?? [];
  if (draft.operations.length === 0 && mutationOperations.length === 0) {
    throw new Error(tv("schema.createAiEditSessionDocumentDraft2"));
  }

  const operationResults: AiEditDocumentDraft[] = [];
  const normalizedOperations: AiEditDraft[] = [...draft.operations];
  const normalizedMutationOperations: SigmaDocMutationOp[] = [...mutationOperations];
  let nextDocument = document;
  let insertedProblemIds: string[] = [];
  const flushInsertedProblemBodies = (): void => {
    for (const problemId of insertedProblemIds) {
      nextDocument = ensureBodyBlockAfterProblem(nextDocument, problemId).document;
    }
    insertedProblemIds = [];
  };

  // 旧提案は従来どおり operations -> mutationOperations。新しい集約提案は
  // operationOrder に記録したtool call順で両配列を交互に再生する。
  for (const entry of resolveAiEditSessionOperationOrder(draft)) {
    if (entry.kind === "operation") {
      const operation = draft.operations[entry.index]!;
      const result = createAiEditDocumentDraft(nextDocument, operation.targetId, operation, {
        ensureBodyAfterInsertedProblem: false,
      });
      operationResults.push(result);
      normalizedOperations[entry.index] = result.draft;
      nextDocument = result.nextDocument;
      if (result.draft.operation === "insertAfter" && result.draft.insertedBlock.type === "problem") {
        insertedProblemIds.push(result.draft.insertedBlock.id);
      }
      continue;
    }

    // 従来も全insertのbody補完をmutationより先に行っていたため、その境界を保つ。
    flushInsertedProblemBodies();
    const result = applySigmaDocMutationOp(nextDocument, mutationOperations[entry.index]!);
    normalizedMutationOperations[entry.index] = result.op;
    nextDocument = result.nextDocument;
  }
  flushInsertedProblemBodies();

  return {
    draft: {
      ...draft,
      operations: normalizedOperations,
      mutationOperations: normalizedMutationOperations,
      warnings: draft.warnings ?? [],
    },
    nextDocument: parseSigmaDocument(nextDocument),
    operationResults,
  };
}

export function createAiEditDocumentDraft(
  document: SigmaDocument,
  targetId: string,
  draft: AiEditDraft,
  options?: CreateAiEditDocumentDraftOptions,
): AiEditDocumentDraft {
  const previousBlock = findBlock(document, targetId);
  const isWhiteboardCanvasInsertion = targetId === "CANVAS"
    && Boolean(document.pageLayout && isWhiteboardPageLayout(document.pageLayout))
    && (draft.operation === "insertTableShape" || draft.operation === "insertOverlayShape");
  if (!previousBlock && !isWhiteboardCanvasInsertion) {
    throw new Error(tv("schema.createAiEditDocumentDraft1"));
  }

  if (draft.targetId !== targetId) {
    throw new Error(tv("schema.createAiEditDocumentDraft2"));
  }

  if (draft.operation === "insertAfter") {
    if (!previousBlock) {
      throw new Error(tv("schema.createAiEditDocumentDraft1"));
    }
    return createInsertAfterDraft(document, targetId, draft, previousBlock, options);
  }

  if (draft.operation === "insertTableShape") {
    return createInsertTableShapeDraft(document, targetId, draft, previousBlock);
  }

  if (draft.operation === "insertOverlayShape") {
    return createInsertOverlayShapeDraft(document, targetId, draft, previousBlock);
  }

  if (!previousBlock) {
    throw new Error(tv("schema.createAiEditDocumentDraft1"));
  }

  if (draft.replacementBlock.id !== targetId) {
    throw new Error(tv("schema.createAiEditDocumentDraft3"));
  }

  if (draft.replacementBlock.type !== previousBlock.type) {
    throw new Error(tv("schema.createAiEditDocumentDraft4"));
  }

  const replacementBlock = normalizeAiReplacementBlockMathTex(draft.replacementBlock);
  const normalizedDraft = { ...draft, replacementBlock };

  const texIssues = getReplacementBlockTexIssues(replacementBlock);
  if (texIssues.length > 0) {
    throw new Error(tv("schema.createAiEditDocumentDraft5", { p0: texIssues.slice(0, 10).join(" / ") }));
  }

  const nextDocument = parseSigmaDocument(
    updateBlockInDocument(document, targetId, () => replacementBlock),
  );

  return {
    draft: normalizedDraft,
    nextDocument,
    previousBlock,
  };
}

function createInsertTableShapeDraft(
  document: SigmaDocument,
  targetId: string,
  draft: Extract<AiEditDraft, { operation: "insertTableShape" }>,
  previousBlock: EditableBlock | null,
): AiEditDocumentDraft {
  if (draft.tableShape.id === targetId) {
    throw new Error(tv("schema.createInsertTableShapeDraft1"));
  }

  if (findBlock(document, draft.tableShape.id)) {
    throw new Error(tv("schema.createInsertTableShapeDraft2"));
  }

  const tableShape = normalizeAiTableShape(draft.tableShape, targetId);
  const normalizedDraft = { ...draft, tableShape };
  const texIssues = getTableShapeTexIssues(tableShape);
  if (texIssues.length > 0) {
    throw new Error(tv("schema.createInsertTableShapeDraft3", { p0: texIssues.slice(0, 10).join(" / ") }));
  }

  const nextDocument = parseSigmaDocument(insertTableShapeInDocument(document, tableShape));

  return {
    draft: normalizedDraft,
    nextDocument,
    previousBlock,
  };
}

function createInsertOverlayShapeDraft(
  document: SigmaDocument,
  targetId: string,
  draft: Extract<AiEditDraft, { operation: "insertOverlayShape" }>,
  previousBlock: EditableBlock | null,
): AiEditDocumentDraft {
  if (draft.overlayShape.id === targetId) {
    throw new Error(tv("schema.createInsertOverlayShapeDraft1"));
  }

  if (findBlock(document, draft.overlayShape.id)) {
    throw new Error(tv("schema.createInsertOverlayShapeDraft2"));
  }

  const overlayShape = normalizeAiOverlayShape(draft.overlayShape, targetId);
  const normalizedDraft = {
    ...draft,
    overlayShape,
    assets: draft.assets ?? {},
  };
  const nextDocument = parseSigmaDocument(insertOverlayShapeInDocument(document, overlayShape, normalizedDraft.assets));

  return {
    draft: normalizedDraft,
    nextDocument,
    previousBlock,
  };
}

/**
 * Computes the result of `updateOverlayShape` against an arbitrary shape array (not
 * necessarily a full document's overlay snapshot) — the same merge semantics
 * `applyUpdateOverlayShape` writes into the document, factored out so preview code
 * (see ai-edit-preview-types.ts's `resolveMutationOpShapeResults`) can compute the
 * after-state without ever drifting from what apply actually does. Throws (Japanese
 * message) if `op.shapeId` isn't present in `shapes`.
 */
export function computeUpdatedOverlayShapes(
  shapes: OverlayShape[],
  op: Extract<SigmaDocMutationOp, { operation: "updateOverlayShape" }>,
): OverlayShape[] {
  const shape = shapes.find((item) => item.id === op.shapeId);
  if (!shape) {
    throw new Error(tv("schema.computeUpdatedOverlayShapes1", { p0: op.shapeId }));
  }

  // `id`/`type` are always taken from the existing shape, never from the caller's patch, so
  // callers cannot retype or re-id a shape via this op.
  const patch: OverlayShapePatch = {
    ...(op.patch as Record<string, unknown>),
    id: shape.id,
    type: shape.type,
  } as OverlayShapePatch;

  return patchShape(shapes, patch);
}

function applyUpdateOverlayShape(
  document: SigmaDocument,
  op: Extract<SigmaDocMutationOp, { operation: "updateOverlayShape" }>,
): SigmaDocument {
  const snapshot = getOverlaySnapshotForRead(document);
  const nextSnapshot: OverlaySnapshot = {
    ...snapshot,
    // Unlike insertion, a same-id asset here is overwritten rather than rejected: the picture is
    // derived from the shape being updated, so replacing it is the whole point (and the shared
    // `asset_..._<shapeId>` id keeps the store from growing an orphan per update).
    assets: { ...snapshot.assets, ...(op.assets ?? {}) },
    shapes: computeUpdatedOverlayShapes(snapshot.shapes, op),
  };
  if (!isValidOverlaySnapshot(nextSnapshot)) {
    throw new Error(tv("schema.applyUpdateOverlayShape1"));
  }

  return writeOverlaySnapshot(document, nextSnapshot);
}

/**
 * Computes the result of `alignOverlayShapes` against an arbitrary shape array — see
 * `computeUpdatedOverlayShapes` above for why this is factored out of `applyAlignOverlayShapes`.
 * Throws (Japanese message) if any of `op.shapeIds` isn't present in `shapes`, or if the mode
 * is `distributeX`/`distributeY` with fewer than 3 selected shapes.
 */
export function computeAlignedOverlayShapes(
  shapes: OverlayShape[],
  op: Extract<SigmaDocMutationOp, { operation: "alignOverlayShapes" }>,
): OverlayShape[] {
  const selected = op.shapeIds.map((id) => {
    const shape = shapes.find((item) => item.id === id);
    if (!shape) {
      throw new Error(tv("schema.computeAlignedOverlayShapes1", { p0: id }));
    }
    return shape;
  });

  if ((op.mode === "distributeX" || op.mode === "distributeY") && selected.length < 3) {
    throw new Error(tv("schema.computeAlignedOverlayShapes2"));
  }

  const aligned = alignOverlayShapesByMode(selected, op.mode);
  const alignedById = new Map(aligned.map((shape) => [shape.id, shape]));
  return shapes.map((shape) => alignedById.get(shape.id) ?? shape);
}

function applyAlignOverlayShapes(
  document: SigmaDocument,
  op: Extract<SigmaDocMutationOp, { operation: "alignOverlayShapes" }>,
): SigmaDocument {
  const snapshot = getOverlaySnapshotForRead(document);
  const nextSnapshot: OverlaySnapshot = { ...snapshot, shapes: computeAlignedOverlayShapes(snapshot.shapes, op) };
  if (!isValidOverlaySnapshot(nextSnapshot)) {
    throw new Error(tv("schema.applyAlignOverlayShapes1"));
  }

  return writeOverlaySnapshot(document, nextSnapshot);
}

function applyDeleteOverlayShapes(
  document: SigmaDocument,
  op: Extract<SigmaDocMutationOp, { operation: "deleteOverlayShapes" }>,
): SigmaDocument {
  const snapshot = getOverlaySnapshotForRead(document);
  for (const id of op.shapeIds) {
    if (!snapshot.shapes.some((shape) => shape.id === id)) {
      if (findBlock(document, id)) {
        throw new Error(tv("schema.applyDeleteOverlayShapes1", { p0: id }));
      }
      throw new Error(tv("schema.applyDeleteOverlayShapes2", { p0: id }));
    }
  }

  const nextSnapshot = deleteOverlayShapesFromSnapshot(snapshot, op.shapeIds);
  if (!isValidOverlaySnapshot(nextSnapshot)) {
    throw new Error(tv("schema.applyDeleteOverlayShapes3"));
  }

  return writeOverlaySnapshot(document, nextSnapshot);
}

function getOverlaySnapshotForRead(document: SigmaDocument): OverlaySnapshot {
  return normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot);
}

function writeOverlaySnapshot(document: SigmaDocument, snapshot: OverlaySnapshot): SigmaDocument {
  const withLayout = ensurePageLayout(document);
  const layout = withLayout.pageLayout!;

  return {
    ...withLayout,
    pageLayout: {
      ...layout,
      overlay: {
        ...(layout.overlay ?? {}),
        overlaySnapshot: snapshot,
        updatedAt: new Date().toISOString(),
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

type OverlayAlignMode = "left" | "right" | "top" | "bottom" | "centerX" | "centerY" | "distributeX" | "distributeY";

function alignOverlayShapesByMode(shapes: OverlayShape[], mode: OverlayAlignMode): OverlayShape[] {
  if (mode === "left") {
    const minX = Math.min(...shapes.map((shape) => shape.x));
    return shapes.map((shape) => ({ ...shape, x: minX }));
  }

  if (mode === "right") {
    const maxRight = Math.max(...shapes.map((shape) => shape.x + overlayShapeWidth(shape)));
    return shapes.map((shape) => ({ ...shape, x: maxRight - overlayShapeWidth(shape) }));
  }

  if (mode === "top") {
    const minY = Math.min(...shapes.map((shape) => shape.y));
    return shapes.map((shape) => ({ ...shape, y: minY }));
  }

  if (mode === "bottom") {
    const maxBottom = Math.max(...shapes.map((shape) => shape.y + overlayShapeHeight(shape)));
    return shapes.map((shape) => ({ ...shape, y: maxBottom - overlayShapeHeight(shape) }));
  }

  if (mode === "centerX") {
    const centerX = average(shapes.map((shape) => shape.x + overlayShapeWidth(shape) / 2));
    return shapes.map((shape) => ({ ...shape, x: centerX - overlayShapeWidth(shape) / 2 }));
  }

  if (mode === "centerY") {
    const centerY = average(shapes.map((shape) => shape.y + overlayShapeHeight(shape) / 2));
    return shapes.map((shape) => ({ ...shape, y: centerY - overlayShapeHeight(shape) / 2 }));
  }

  if (mode === "distributeX") {
    return distributeOverlayShapes(shapes, "x", overlayShapeWidth);
  }

  return distributeOverlayShapes(shapes, "y", overlayShapeHeight);
}

function distributeOverlayShapes(
  shapes: OverlayShape[],
  axis: "x" | "y",
  sizeOf: (shape: OverlayShape) => number,
): OverlayShape[] {
  const sorted = [...shapes].sort((a, b) => a[axis] - b[axis]);
  const spanStart = sorted[0][axis];
  const spanEnd = sorted[sorted.length - 1][axis] + sizeOf(sorted[sorted.length - 1]);
  const totalSize = sorted.reduce((sum, shape) => sum + sizeOf(shape), 0);
  const gapCount = sorted.length - 1;
  const gap = gapCount > 0 ? (spanEnd - spanStart - totalSize) / gapCount : 0;

  let cursor = spanStart;
  const placedById = new Map<string, OverlayShape>();
  for (const shape of sorted) {
    placedById.set(shape.id, { ...shape, [axis]: cursor });
    cursor += sizeOf(shape) + gap;
  }

  return shapes.map((shape) => placedById.get(shape.id) ?? shape);
}

function overlayShapeWidth(shape: OverlayShape): number {
  const width = (shape.props as { w?: unknown }).w;
  return typeof width === "number" && Number.isFinite(width) ? width : 0;
}

function overlayShapeHeight(shape: OverlayShape): number {
  const height = (shape.props as { h?: unknown }).h;
  return typeof height === "number" && Number.isFinite(height) ? height : 0;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deleteOverlayShapesFromSnapshot(snapshot: OverlaySnapshot, shapeIds: string[]): OverlaySnapshot {
  const shapesById = new Map(snapshot.shapes.map((shape) => [shape.id, shape]));
  const toDelete = new Set(shapeIds);

  // Cascade-delete children of any deleted group shape (a group has no separate children list;
  // membership is expressed by the child's own parentId).
  let changed = true;
  while (changed) {
    changed = false;
    for (const shape of snapshot.shapes) {
      if (toDelete.has(shape.id) || !shape.parentId || !toDelete.has(shape.parentId)) {
        continue;
      }
      const parent = shapesById.get(shape.parentId);
      if (parent?.type === "group") {
        toDelete.add(shape.id);
        changed = true;
      }
    }
  }

  const survivors = removeShapes(snapshot.shapes, Array.from(toDelete));
  const survivorIds = new Set(survivors.map((shape) => shape.id));
  const removedIds = new Set(
    snapshot.shapes.map((shape) => shape.id).filter((id) => !survivorIds.has(id)),
  );

  return {
    ...snapshot,
    shapes: survivors.map((shape) => cleanupOverlayShapeAfterDeletion(shape, removedIds)),
  };
}

function cleanupOverlayShapeAfterDeletion(shape: OverlayShape, removedIds: Set<OverlayShapeId>): OverlayShape {
  let next = shape;

  if (next.parentId && removedIds.has(next.parentId)) {
    next = { ...next };
    delete next.parentId;
  }

  if (next.type === "graph2dShape") {
    next = cleanupGraphLabelOwnership(next, removedIds);
  }

  return next;
}

function cleanupGraphLabelOwnership(shape: OverlayGraphShape, removedIds: Set<OverlayShapeId>): OverlayGraphShape {
  return {
    ...shape,
    props: {
      ...shape.props,
      ...(shape.props.axisLabelTextShapeIds
        ? { axisLabelTextShapeIds: filterOwnershipRecord(shape.props.axisLabelTextShapeIds, removedIds) }
        : {}),
      ...(shape.props.pointLabelTextShapeIdsByPointId
        ? { pointLabelTextShapeIdsByPointId: filterOwnershipRecord(shape.props.pointLabelTextShapeIdsByPointId, removedIds) }
        : {}),
      ...(shape.props.annotationTextShapeIdsByAnnotationId
        ? { annotationTextShapeIdsByAnnotationId: filterOwnershipRecord(shape.props.annotationTextShapeIdsByAnnotationId, removedIds) }
        : {}),
      ...(shape.props.labelTextShapeIdsByCurveId
        ? { labelTextShapeIdsByCurveId: filterOwnershipRecord(shape.props.labelTextShapeIdsByCurveId, removedIds) }
        : {}),
      ...(shape.props.labelTextShapeIds
        ? { labelTextShapeIds: shape.props.labelTextShapeIds.filter((id) => !removedIds.has(id)) }
        : {}),
    },
  };
}

function filterOwnershipRecord(
  record: Partial<Record<string, OverlayShapeId>>,
  removedIds: Set<OverlayShapeId>,
): Record<string, OverlayShapeId> {
  const entries = Object.entries(record).filter(
    (entry): entry is [string, OverlayShapeId] => typeof entry[1] === "string" && !removedIds.has(entry[1]),
  );
  return Object.fromEntries(entries);
}

function normalizeAiOverlayShape<T extends OverlayShape>(shape: T, targetId: string): T {
  const normalizedAnchor = normalizeAiOverlayAnchor(shape, targetId);
  const shapeWithoutAnchor = { ...shape };
  delete shapeWithoutAnchor.anchor;

  return {
    ...shapeWithoutAnchor,
    rotation: finiteNumberOr(shape.rotation, 0),
    x: finiteNumberOr(shape.x, 0),
    y: finiteNumberOr(shape.y, 44),
    ...(normalizedAnchor ? { anchor: normalizedAnchor } : {}),
  } as T;
}

/**
 * anchor 欠落・非有限時のフォールバック。`shape.x/y` は絶対ページ座標なので
 * デルタとして流用してはいけない (blockLeft/blockTop 分の二重加算になる)。
 * 位置が決められないときは「アンカーブロック直下24px」の意味ベース既定へ倒す。
 */
const AI_OVERLAY_FALLBACK_ANCHOR_DX = 0;
const AI_OVERLAY_FALLBACK_ANCHOR_DY = 24;

function normalizeAiOverlayAnchor<T extends OverlayShape>(shape: T, targetId: string): OverlayShape["anchor"] {
  if (targetId === "CANVAS") {
    return undefined;
  }

  if (shape.anchor?.type === "block") {
    return {
      type: "block",
      blockId: shape.anchor.blockId || targetId,
      dy: finiteNumberOr(shape.anchor.dy, AI_OVERLAY_FALLBACK_ANCHOR_DY),
      dx: finiteNumberOr(shape.anchor.dx, AI_OVERLAY_FALLBACK_ANCHOR_DX),
      ...(shape.anchor.line ? { line: shape.anchor.line } : {}),
      ...(shape.anchor.reserveSpace === undefined ? {} : { reserveSpace: shape.anchor.reserveSpace }),
    };
  }

  if (shape.anchor?.type === "shape") {
    return {
      type: "shape",
      shapeId: shape.anchor.shapeId,
      dx: finiteNumberOr(shape.anchor.dx, 0),
      dy: finiteNumberOr(shape.anchor.dy, 0),
      ...(shape.anchor.rx === undefined ? {} : { rx: finiteNumberOr(shape.anchor.rx, 0) }),
      ...(shape.anchor.ry === undefined ? {} : { ry: finiteNumberOr(shape.anchor.ry, 0) }),
    };
  }

  return {
    type: "block",
    blockId: targetId,
    dy: AI_OVERLAY_FALLBACK_ANCHOR_DY,
    dx: AI_OVERLAY_FALLBACK_ANCHOR_DX,
  };
}

function insertOverlayShapeInDocument(
  document: SigmaDocument,
  overlayShape: OverlayShape,
  assets: Record<string, OverlayAsset>,
): SigmaDocument {
  const withLayout = ensurePageLayout(document);
  const layout = withLayout.pageLayout!;
  const currentSnapshot = normalizeOverlaySnapshot(layout.overlay?.overlaySnapshot);
  for (const [assetId, asset] of Object.entries(assets)) {
    const existingAsset = currentSnapshot.assets[assetId];
    if (existingAsset && !areStructurallyEqual(existingAsset, asset)) {
      throw new Error(tv("schema.insertOverlayShapeInDocument1", { p0: assetId }));
    }
  }
  const nextAssets = {
    ...currentSnapshot.assets,
    ...assets,
  };
  const nextSnapshot = {
    ...currentSnapshot,
    assets: nextAssets,
    shapes: [...currentSnapshot.shapes, overlayShape],
  };

  if (currentSnapshot.shapes.some((shape) => shape.id === overlayShape.id)) {
    throw new Error(tv("schema.insertOverlayShapeInDocument2"));
  }

  if (!isValidOverlaySnapshot(nextSnapshot)) {
    throw new Error(tv("schema.insertOverlayShapeInDocument3"));
  }

  return {
    ...withLayout,
    pageLayout: {
      ...layout,
      overlay: {
        ...(layout.overlay ?? {}),
        overlaySnapshot: nextSnapshot,
        updatedAt: new Date().toISOString(),
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

function normalizeAiTableShape(shape: OverlayTableShape, targetId: string): OverlayTableShape {
  const table = normalizeAiTableSpec(shape.props.table);
  const anchor = normalizeAiTableAnchor(shape, targetId);
  const shapeWithoutAnchor = { ...shape };
  delete shapeWithoutAnchor.anchor;
  return {
    ...shapeWithoutAnchor,
    id: shape.id || createId("ai_table"),
    type: "tableShape",
    rotation: 0,
    x: finiteNumberOr(shape.x, 0),
    y: finiteNumberOr(shape.y, 44),
    ...(anchor ? { anchor } : {}),
    props: {
      ...shape.props,
      w: Math.max(120, finiteNumberOr(shape.props.w, 360)),
      h: Math.max(72, finiteNumberOr(shape.props.h, 126)),
      table,
    },
  };
}

function normalizeAiTableAnchor(shape: OverlayTableShape, targetId: string): OverlayTableShape["anchor"] {
  if (targetId === "CANVAS") {
    return undefined;
  }

  const anchor = shape.anchor;
  if (anchor?.type === "block") {
    return {
      type: "block",
      blockId: anchor.blockId || targetId,
      dy: finiteNumberOr(anchor.dy, AI_OVERLAY_FALLBACK_ANCHOR_DY),
      dx: finiteNumberOr(anchor.dx, AI_OVERLAY_FALLBACK_ANCHOR_DX),
    };
  }

  return {
    type: "block",
    blockId: targetId,
    dy: AI_OVERLAY_FALLBACK_ANCHOR_DY,
    dx: AI_OVERLAY_FALLBACK_ANCHOR_DX,
  };
}

function normalizeAiTableSpec(input: SigmaTableSpec): SigmaTableSpec {
  const rowsInput = Array.isArray(input.rows) ? input.rows : [];
  const columnsInput = Array.isArray(input.columns) ? input.columns : [];
  const columns = normalizeAiTableColumns(columnsInput);
  const rows = normalizeAiTableRows(rowsInput);
  const inputCells = Array.isArray(input.cells) ? input.cells : [];
  const kind = input.kind === "plain" ? "plain" : "variation";
  const cells = normalizeAiTableCells(inputCells, rows, columns, kind);

  return {
    version: 1,
    kind,
    columns,
    rows,
    cells,
    grid: normalizeAiTableGrid(input.grid),
    defaultCellStyle: normalizeAiTableCellStyle(input.defaultCellStyle),
  };
}

function normalizeAiTableColumns(input: SigmaTableColumn[]): SigmaTableColumn[] {
  const columns = input
    .filter((column) => isRecord(column))
    .map((column, index) => ({
      id: nonEmptyStringOr(column.id, `ai_table_col_${index + 1}`),
      width: normalizeAiTableTrackSize(column.width, { mode: "fr", value: 1, min: index === 0 ? 48 : 56 }),
      ...(isTableColumnRole(column.role) ? { role: column.role } : {}),
    }));

  return ensureUniqueTableIds(
    columns.length > 0
      ? columns
      : [
          { id: "ai_table_col_label", width: { mode: "auto", min: 48, max: 96 }, role: "label" },
          { id: "ai_table_col_left", width: { mode: "fr", value: 1, min: 56 }, role: "interval" },
          { id: "ai_table_col_point", width: { mode: "auto", min: 52, max: 96 }, role: "point" },
          { id: "ai_table_col_right", width: { mode: "fr", value: 1, min: 56 }, role: "interval" },
        ],
    "ai_table_col",
  );
}

function normalizeAiTableRows(input: SigmaTableRow[]): SigmaTableRow[] {
  const rows = input
    .filter((row) => isRecord(row))
    .map((row, index) => ({
      id: nonEmptyStringOr(row.id, `ai_table_row_${index + 1}`),
      height: normalizeAiTableTrackSize(row.height, { mode: "auto", min: index === 2 ? 38 : 32 }),
      ...(isTableRowRole(row.role) ? { role: row.role } : {}),
    }));

  return ensureUniqueTableIds(
    rows.length > 0
      ? rows
      : [
          { id: "ai_table_row_x", height: { mode: "auto", min: 32 }, role: "variable" },
          { id: "ai_table_row_derivative", height: { mode: "auto", min: 32 }, role: "derivative" },
          { id: "ai_table_row_variation", height: { mode: "auto", min: 38 }, role: "variation" },
        ],
    "ai_table_row",
  );
}

function normalizeAiTableCells(
  input: SigmaTableCell[],
  rows: SigmaTableRow[],
  columns: SigmaTableColumn[],
  kind: SigmaTableKind,
): SigmaTableCell[] {
  const inputCellMap = new Map<string, SigmaTableCell>();
  const rowIds = new Set(rows.map((row) => row.id));
  const columnIds = new Set(columns.map((column) => column.id));

  for (const cell of input) {
    if (!isRecord(cell) || !rowIds.has(cell.rowId) || !columnIds.has(cell.columnId)) {
      continue;
    }
    inputCellMap.set(`${cell.rowId}:${cell.columnId}`, cell);
  }

  return rows.flatMap((row) =>
    columns.map((column) => {
      const inputCell = inputCellMap.get(`${row.id}:${column.id}`);
      return normalizeAiTableCell(inputCell, row.id, column.id, kind);
    }),
  );
}

function normalizeAiTableCell(
  input: SigmaTableCell | undefined,
  rowId: string,
  columnId: string,
  kind: SigmaTableKind,
): SigmaTableCell {
  const contentInput = Array.isArray(input?.content) ? input.content : [];
  const content = normalizeAiTableCellContentList(contentInput, kind);

  return {
    id: nonEmptyStringOr(input?.id, createId("ai_table_cell")),
    rowId,
    columnId,
    ...(positiveIntegerOrUndefined(input?.rowSpan) ? { rowSpan: positiveIntegerOrUndefined(input?.rowSpan) } : {}),
    ...(positiveIntegerOrUndefined(input?.colSpan) ? { colSpan: positiveIntegerOrUndefined(input?.colSpan) } : {}),
    content,
    ...(input?.style && isRecord(input.style) ? { style: normalizeAiTableCellStyle(input.style, true) } : {}),
  };
}

function normalizeAiTableCellContentList(input: unknown[], kind: SigmaTableKind): SigmaTableCellContent[] {
  const content = input.flatMap((item) => normalizeAiTableCellContent(item));
  const normalizedContent = kind === "variation" ? content.map(preferVariationTableMathContent) : content;
  return normalizedContent.length > 0 ? normalizedContent : [createEmptyTableParagraph()];
}

function normalizeAiTableCellContent(input: unknown): SigmaTableCellContent[] {
  if (typeof input === "string") {
    return [createTableParagraph([{ type: "text", text: input }])];
  }

  if (!isRecord(input)) {
    return [];
  }

  if (input.type === "trend") {
    return [{
      type: "trend",
      id: nonEmptyStringOr(input.id, createId("ai_table_trend")),
      direction: isTrendDirection(input.direction) ? input.direction : "flat",
      ...(Array.isArray(input.label) ? { label: normalizeInlineMathTex(normalizeAiInlineNodes(input.label)) } : {}),
    }];
  }

  if (input.type === "paragraph") {
    return [createTableParagraph(normalizeInlineMathTex(normalizeAiInlineNodes(input.children)), input)];
  }

  if (input.type === "mathInline" || input.type === "text") {
    return [createTableParagraph(normalizeInlineMathTex(normalizeAiInlineNodes([input])))];
  }

  if (Array.isArray(input.children)) {
    return [createTableParagraph(normalizeInlineMathTex(normalizeAiInlineNodes(input.children)), input)];
  }

  if (typeof input.text === "string") {
    return [createTableParagraph([{ type: "text", text: input.text }], input)];
  }

  if (typeof input.tex === "string") {
    return [createTableParagraph([createMathInline(input.tex, input.id, input.semanticRole)], input)];
  }

  return [];
}

function normalizeAiInlineNodes(input: unknown): InlineNode[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((node) => {
    if (typeof node === "string") {
      return createTextInlinesWithDelimitedMath(node, {});
    }

    if (!isRecord(node)) {
      return [];
    }

    if (node.type === "text") {
      return createTextInlinesWithDelimitedMath(typeof node.text === "string" ? node.text : "", node);
    }

    if (node.type === "mathInline" && typeof node.tex === "string") {
      return [createMathInline(node.tex, node.id, node.semanticRole)];
    }

    if (typeof node.tex === "string") {
      return [createMathInline(node.tex, node.id, node.semanticRole)];
    }

    if (typeof node.text === "string") {
      return createTextInlinesWithDelimitedMath(node.text, node);
    }

    return [];
  });
}

function createTableParagraph(children: InlineNode[], input?: Record<string, unknown>): SigmaTableCellContent {
  return {
    type: "paragraph",
    id: nonEmptyStringOr(input?.id, createId("ai_table_p")),
    children,
    align: isTextAlign(input?.align) ? input.align : "center",
  };
}

function createEmptyTableParagraph(): SigmaTableCellContent {
  return createTableParagraph([]);
}

function createMathInline(tex: string, id: unknown, semanticRole?: unknown): InlineNode {
  return {
    type: "mathInline",
    id: nonEmptyStringOr(id, createId("ai_table_math")),
    tex,
    display: "inline",
    semanticRole: normalizeMathInlineSemanticRole(semanticRole),
  };
}

function preferVariationTableMathContent(content: SigmaTableCellContent): SigmaTableCellContent {
  if (content.type === "trend") {
    return content;
  }

  if (content.children.length !== 1 || content.children[0].type !== "text") {
    return content;
  }

  const tex = textToVariationTableMathTex(content.children[0].text);
  if (!tex) {
    return content;
  }

  return {
    ...content,
    children: [createMathInline(tex, undefined)],
  };
}

function textToVariationTableMathTex(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed === "~" || trimmed === "〜") {
    return "\\sim";
  }

  const asciiMathLike = /^[A-Za-z0-9+\-−－＋*/=<>^_\\'().,{}\[\]\s~∞±]+$/u;
  const hasMathSignal = /[A-Za-z0-9+\-−－＋*/=<>^_\\'~∞±]/u.test(trimmed);
  if (!asciiMathLike.test(trimmed) || !hasMathSignal) {
    return null;
  }

  return trimmed
    .replaceAll("∞", "\\infty")
    .replaceAll("±", "\\pm")
    .replace(/[−－]/g, "-")
    .replaceAll("＋", "+")
    .replaceAll("~", "\\sim");
}

function normalizeAiTableGrid(input: unknown): SigmaTableGridStyle {
  const grid = isRecord(input) ? input : {};
  return {
    borderColor: typeof grid.borderColor === "string" ? grid.borderColor : "#111827",
    borderWidth: nonnegativeNumberOr(grid.borderWidth, 1),
    borderStyle: isBorderStyle(grid.borderStyle) ? grid.borderStyle : "solid",
    showOuterBorder: typeof grid.showOuterBorder === "boolean" ? grid.showOuterBorder : true,
    showInnerBorders: typeof grid.showInnerBorders === "boolean" ? grid.showInnerBorders : true,
  };
}

function normalizeAiTableCellStyle(input: unknown, partial = false): SigmaTableCellStyle {
  const style = isRecord(input) ? input : {};
  return {
    ...(partial ? {} : { align: "center" as const }),
    ...(isTextAlign(style.align) ? { align: style.align } : {}),
    ...(partial ? {} : { verticalAlign: "middle" as const }),
    ...(isVerticalAlign(style.verticalAlign) ? { verticalAlign: style.verticalAlign } : {}),
    ...(partial ? {} : { paddingX: 8 }),
    ...(style.paddingX === undefined && partial ? {} : { paddingX: nonnegativeNumberOr(style.paddingX, 8) }),
    ...(partial ? {} : { paddingY: 5 }),
    ...(style.paddingY === undefined && partial ? {} : { paddingY: nonnegativeNumberOr(style.paddingY, 5) }),
    ...(partial ? {} : { color: "#111827" }),
    ...(typeof style.color === "string" ? { color: style.color } : {}),
    ...(typeof style.backgroundColor === "string" ? { backgroundColor: style.backgroundColor } : {}),
    ...(typeof style.fontFamily === "string" ? { fontFamily: style.fontFamily } : {}),
    ...(style.fontSize === undefined && partial ? {} : { fontSize: positiveNumberOr(style.fontSize, 15) }),
    ...(partial ? {} : { fontWeight: "normal" as const }),
    ...(style.fontWeight === "normal" || style.fontWeight === "bold" ? { fontWeight: style.fontWeight } : {}),
  };
}

function normalizeAiTableTrackSize(input: unknown, fallback: SigmaTableTrackSize): SigmaTableTrackSize {
  if (!isRecord(input)) {
    return fallback;
  }

  if (input.mode === "fixed") {
    return { mode: "fixed", value: positiveNumberOr(input.value, 56) };
  }

  if (input.mode === "auto") {
    return {
      mode: "auto",
      ...(input.min === undefined ? {} : { min: positiveNumberOr(input.min, 1) }),
      ...(input.max === undefined ? {} : { max: positiveNumberOr(input.max, positiveNumberOr(input.min, 96)) }),
    };
  }

  if (input.mode === "fr") {
    return {
      mode: "fr",
      value: positiveNumberOr(input.value, 1),
      ...(input.min === undefined ? {} : { min: positiveNumberOr(input.min, 1) }),
      ...(input.max === undefined ? {} : { max: positiveNumberOr(input.max, positiveNumberOr(input.min, 96)) }),
    };
  }

  return fallback;
}

function insertTableShapeInDocument(document: SigmaDocument, tableShape: OverlayTableShape): SigmaDocument {
  const withLayout = ensurePageLayout(document);
  const layout = withLayout.pageLayout!;
  const currentSnapshot = normalizeOverlaySnapshot(layout.overlay?.overlaySnapshot);
  const nextSnapshot = {
    ...currentSnapshot,
    assets: currentSnapshot.assets,
    shapes: [...currentSnapshot.shapes, tableShape],
  };

  if (currentSnapshot.shapes.some((shape) => shape.id === tableShape.id)) {
    throw new Error(tv("schema.insertTableShapeInDocument1"));
  }

  if (!isValidOverlaySnapshot(nextSnapshot)) {
    throw new Error(tv("schema.insertTableShapeInDocument2"));
  }

  return {
    ...withLayout,
    pageLayout: {
      ...layout,
      overlay: {
        ...(layout.overlay ?? {}),
        overlaySnapshot: nextSnapshot,
        updatedAt: new Date().toISOString(),
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

function createInsertAfterDraft(
  document: SigmaDocument,
  targetId: string,
  draft: Extract<AiEditDraft, { operation: "insertAfter" }>,
  previousBlock: EditableBlock,
  options?: CreateAiEditDocumentDraftOptions,
): AiEditDocumentDraft {
  if (draft.insertedBlock.id === targetId) {
    throw new Error(tv("schema.createInsertAfterDraft1"));
  }

  if (findBlock(document, draft.insertedBlock.id)) {
    throw new Error(tv("schema.createInsertAfterDraft2"));
  }

  const insertedBlock = normalizeAiReplacementBlockMathTex(draft.insertedBlock);
  const normalizedDraft = { ...draft, insertedBlock };
  const texIssues = getReplacementBlockTexIssues(insertedBlock);
  if (texIssues.length > 0) {
    throw new Error(tv("schema.createInsertAfterDraft3", { p0: texIssues.slice(0, 10).join(" / ") }));
  }

  const nextDocument = parseSigmaDocument(insertBlockAfterTarget(document, targetId, insertedBlock, options));

  return {
    draft: normalizedDraft,
    nextDocument,
    previousBlock,
  };
}

function insertBlockAfterTarget(
  document: SigmaDocument,
  targetId: string,
  insertedBlock: EditableBlock,
  options?: CreateAiEditDocumentDraftOptions,
): SigmaDocument {
  const topLevelTarget = document.content.find((block) => block.id === targetId);
  if (topLevelTarget) {
    const nextDocument = insertTopLevelBlock(document, insertedBlock as SigmaBlock, targetId);
    return insertedBlock.type === "problem" && options?.ensureBodyAfterInsertedProblem !== false
      ? ensureBodyBlockAfterProblem(nextDocument, insertedBlock.id).document
      : nextDocument;
  }

  if (insertedBlock.type === "section" || insertedBlock.type === "problem") {
    throw new Error(tv("schema.insertBlockAfterTarget1"));
  }

  if (!isRichBlock(insertedBlock)) {
    throw new Error(tv("schema.insertBlockAfterTarget2"));
  }

  const nextDocument = insertRichBlockNearSelection(document, targetId, insertedBlock);
  if (!nextDocument) {
    throw new Error(tv("schema.insertBlockAfterTarget3"));
  }

  return nextDocument;
}

function normalizeAiReplacementBlockMathTex(block: EditableBlock): EditableBlock {
  if (block.type === "heading" || block.type === "paragraph") {
    return { ...block, children: normalizeInlineMathTex(block.children) };
  }

  if (block.type === "list") {
    return normalizeListMathTex(block);
  }

  if (block.type === "listItem") {
    return normalizeListItemMathTex(block);
  }

  if (block.type === "problem") {
    return {
      ...block,
      lead: normalizeRichBlocksMathTex(block.lead),
      prompt: normalizeRichBlocksMathTex(block.prompt),
      solution: normalizeRichBlocksMathTex(block.solution),
      hints: normalizeRichBlocksMathTex(block.hints),
    };
  }

  return block;
}

function normalizeRichBlocksMathTex<T extends ProblemAreaBlock>(blocks: T[]): T[] {
  return blocks.map((block) => {
    if (block.type === "layoutSection") {
      return {
        ...block,
        children: block.children.map(normalizeLayoutSectionChildMathTex),
      } as T;
    }
    if (block.type === "boxBlock") {
      return normalizeLayoutSectionChildMathTex(block) as T;
    }
    if (block.type === "list") {
      return normalizeListMathTex(block) as T;
    }
    if (block.type === "divider") {
      return block;
    }
    if (block.type === "quote") {
      return {
        ...block,
        blocks: block.blocks.map((child) => normalizeLayoutSectionChildMathTex(child) as typeof child),
      } as T;
    }

    return { ...block, children: normalizeInlineMathTex(block.children) } as T;
  });
}

function normalizeLayoutSectionChildMathTex(block: LayoutSectionChildBlock): LayoutSectionChildBlock {
  if (block.type === "section") {
    return block;
  }
  if (block.type === "boxBlock") {
    return {
      ...block,
      title: block.title ? normalizeInlineMathTex(block.title) : undefined,
      blocks: block.blocks.map((child) => child.type === "problem"
        ? { ...child, lead: normalizeRichBlocksMathTex(child.lead), prompt: normalizeRichBlocksMathTex(child.prompt), hints: normalizeRichBlocksMathTex(child.hints), solution: normalizeRichBlocksMathTex(child.solution) }
        : child.type === "layoutSection"
        ? normalizeRichBlocksMathTex([child])[0]
        : normalizeLayoutSectionChildMathTex(child)),
    };
  }
  return normalizeRichBlocksMathTex([block])[0] as LayoutSectionChildBlock;
}

function normalizeListMathTex(block: Extract<RichBlock, { type: "list" }>): Extract<RichBlock, { type: "list" }> {
  return {
    ...block,
    items: block.items.map(normalizeListItemMathTex),
  };
}

function normalizeListItemMathTex(item: ListItemNode): ListItemNode {
  return {
    ...item,
    children: normalizeInlineMathTex(item.children),
    continuations: item.continuations?.map((continuation) => ({
      ...continuation,
      children: normalizeInlineMathTex(listItemContinuationInlineNodes(continuation)),
    })),
    nested: item.nested?.map(normalizeListMathTex),
  };
}

function normalizeInlineMathTex(children: InlineNode[]): InlineNode[] {
  return children.flatMap((child) => {
    if (child.type === "mathInline") {
      return [{
        type: "mathInline",
        id: child.id,
        tex: normalizeLikelyAiMathNewlines(child.tex),
        display: "inline",
        ...(child.marks !== undefined ? { marks: child.marks } : {}),
        ...(child.color !== undefined ? { color: child.color } : {}),
        ...(child.backgroundColor !== undefined ? { backgroundColor: child.backgroundColor } : {}),
        ...(child.fontFamily !== undefined ? { fontFamily: child.fontFamily } : {}),
        ...(child.fontSize !== undefined ? { fontSize: child.fontSize } : {}),
        ...(child.boxedPaddingY !== undefined ? { boxedPaddingY: child.boxedPaddingY } : {}),
        ...(child.boxedVariant !== undefined ? { boxedVariant: child.boxedVariant } : {}),
        ...(child.boxedTone !== undefined ? { boxedTone: child.boxedTone } : {}),
        ...(child.altText !== undefined ? { altText: child.altText } : {}),
        semanticRole: normalizeMathInlineSemanticRole(child.semanticRole),
      }];
    }

    return createTextInlinesWithDelimitedMath(child.text, child);
  });
}

function createTextInlinesWithDelimitedMath(text: string, source: Partial<Extract<InlineNode, { type: "text" }>>): InlineNode[] {
  return splitDelimitedInlineMathText(text).map((segment) => (
    segment.type === "math"
      ? createDelimitedMathInline(segment.tex)
      : createDelimitedTextInline(segment.text, source)
  ));
}

function createDelimitedTextInline(text: string, source: Partial<Extract<InlineNode, { type: "text" }>>): InlineNode {
  return {
    type: "text",
    text,
    ...(source.marks ? { marks: source.marks } : {}),
    ...(source.color !== undefined ? { color: source.color } : {}),
    ...(source.backgroundColor !== undefined ? { backgroundColor: source.backgroundColor } : {}),
    ...(source.fontFamily !== undefined ? { fontFamily: source.fontFamily } : {}),
    ...(source.fontSize !== undefined ? { fontSize: source.fontSize } : {}),
    ...(source.boxedPaddingY !== undefined ? { boxedPaddingY: source.boxedPaddingY } : {}),
    ...(source.boxedVariant !== undefined ? { boxedVariant: source.boxedVariant } : {}),
    ...(source.boxedTone !== undefined ? { boxedTone: source.boxedTone } : {}),
  };
}

function createDelimitedMathInline(tex: string): InlineNode {
  return {
    type: "mathInline",
    id: createId("ai_math"),
    tex: normalizeLikelyAiMathNewlines(tex),
    display: "inline",
    semanticRole: "expression",
  };
}

function normalizeMathInlineSemanticRole(value: unknown): "expression" | "equation" | "variable" {
  return value === "equation" || value === "variable" ? value : "expression";
}

function normalizeLikelyAiMathNewlines(tex: string): string {
  if (!tex.includes("//")) {
    return tex;
  }

  return normalizeMultilineEnvironmentSlashes(tex, (outsideEnvironment) =>
    looksLikeAiLineBreakTex(outsideEnvironment)
      ? wrapLikelyLineBreakTexInAligned(outsideEnvironment)
      : outsideEnvironment,
  );
}

function normalizeMultilineEnvironmentSlashes(
  tex: string,
  normalizeOutsideEnvironment: (value: string) => string,
): string {
  const environmentPattern = /\\begin\{(aligned|alignedat|array|cases|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix)\}([\s\S]*?)\\end\{\1\}/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = environmentPattern.exec(tex)) !== null) {
    result += normalizeOutsideEnvironment(tex.slice(lastIndex, match.index));
    result += match[0].replace(match[2], replaceSimpleSlashPairs(match[2]));
    lastIndex = match.index + match[0].length;
  }

  result += normalizeOutsideEnvironment(tex.slice(lastIndex));
  return result;
}

function looksLikeAiLineBreakTex(tex: string): boolean {
  const parts = tex.split("//").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    return false;
  }

  return parts.filter(looksLikeEquationLine).length >= 2;
}

function looksLikeEquationLine(value: string): boolean {
  return /(?:=|<|>|\\leq{0,2}\b|\\geq{0,2}\b|\\ne\b|\\approx\b|\\equiv\b|\\iff\b|\\to\b|\\Rightarrow\b|\\Leftarrow\b)/.test(value);
}

function wrapLikelyLineBreakTexInAligned(value: string): string {
  const leadingWhitespace = value.match(/^\s*/)?.[0] ?? "";
  const trailingWhitespace = value.match(/\s*$/)?.[0] ?? "";
  const body = value.trim();
  return `${leadingWhitespace}\\begin{aligned}${replaceSimpleSlashPairs(body)}\\end{aligned}${trailingWhitespace}`;
}

function replaceSimpleSlashPairs(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (
      value[index] === "/" &&
      value[index + 1] === "/" &&
      value[index - 1] !== "/" &&
      value[index + 2] !== "/"
    ) {
      result += "\\\\";
      index += 1;
      continue;
    }

    result += value[index];
  }

  return result;
}

function getReplacementBlockTexIssues(block: EditableBlock): string[] {
  if (block.type === "heading" || block.type === "paragraph") {
    return getInlineTexIssues(block.children);
  }

  if (block.type === "problem") {
    return [
      ...getRichBlocksTexIssues(block.lead),
      ...getRichBlocksTexIssues(block.prompt),
      ...getRichBlocksTexIssues(block.solution),
      ...getRichBlocksTexIssues(block.hints),
    ];
  }

  return [];
}

function getTableShapeTexIssues(shape: OverlayTableShape): string[] {
  return shape.props.table.cells.flatMap((cell) =>
    cell.content.flatMap((content) => getTableCellContentTexIssues(content)),
  );
}

function getTableCellContentTexIssues(content: SigmaTableCellContent): string[] {
  if (content.type === "trend") {
    return getInlineTexIssues(content.label ?? []);
  }

  return getInlineTexIssues(content.children);
}

function getRichBlocksTexIssues(blocks: ProblemAreaBlock[]): string[] {
  return blocks.flatMap(getRichBlockTexIssues);
}

function getRichBlockTexIssues(block: ProblemAreaBlock | ProblemNode): string[] {
  if (block.type === "problem") return [...block.lead, ...block.prompt, ...block.hints, ...block.solution].flatMap(getRichBlockTexIssues);
  if (block.type === "layoutSection") {
    return block.children.flatMap((child) =>
      child.type === "section" ? [] : getRichBlockTexIssues(child),
    );
  }
  if (block.type === "boxBlock") {
    return [
      ...getInlineTexIssues(block.title ?? []),
      ...block.blocks.flatMap((child) =>
        child.type === "section" ? [] : getRichBlockTexIssues(child),
      ),
    ];
  }
  if (block.type === "list") {
    return block.items.flatMap((item) => [
      ...getInlineTexIssues(item.children),
      ...(item.continuations ?? []).flatMap(getRichBlockTexIssues),
      ...(item.nested ?? []).flatMap(getRichBlockTexIssues),
    ]);
  }
  if (block.type === "divider") {
    return [];
  }
  if (block.type === "quote") {
    return block.blocks.flatMap(getRichBlockTexIssues);
  }

  return getInlineTexIssues(block.children);
}

function isRichBlock(block: EditableBlock): block is RichBlock {
  return block.type === "heading" || block.type === "paragraph" || block.type === "list";
}

function getInlineTexIssues(children: InlineNode[]): string[] {
  return children.flatMap((child) => child.type === "mathInline" ? getTexIssues(child.tex, child.id) : []);
}

function parseJsonStringIfNeeded(input: unknown): unknown {
  if (typeof input !== "string") {
    return input;
  }

  try {
    return JSON.parse(input);
  } catch {
    throw new Error(tv("schema.parseJsonStringIfNeeded1"));
  }
}

function isLikelySingleAiEditDraft(input: unknown): boolean {
  return isRecord(input) && typeof input.targetId === "string" && !Array.isArray(input.operations);
}

function ensureUniqueTableIds<T extends { id: string }>(items: T[], prefix: string): T[] {
  const seen = new Set<string>();
  return items.map((item, index) => {
    let id = item.id.trim() || `${prefix}_${index + 1}`;
    if (seen.has(id)) {
      id = `${prefix}_${index + 1}`;
      while (seen.has(id)) {
        id = createId(prefix);
      }
    }
    seen.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

function nonEmptyStringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveNumberOr(value: unknown, fallback: number): number {
  const numberValue = finiteNumberOr(value, fallback);
  return numberValue > 0 ? numberValue : fallback;
}

function nonnegativeNumberOr(value: unknown, fallback: number): number {
  const numberValue = finiteNumberOr(value, fallback);
  return numberValue >= 0 ? numberValue : fallback;
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function isTextAlign(value: unknown): value is TextAlign {
  return value === "left" || value === "center" || value === "right" || value === "justify";
}

function isVerticalAlign(value: unknown): value is "top" | "middle" | "bottom" {
  return value === "top" || value === "middle" || value === "bottom";
}

function isBorderStyle(value: unknown): value is SigmaTableBorderStyle {
  return value === "solid" || value === "dashed" || value === "dotted" || value === "double";
}

function isTableColumnRole(value: unknown): value is SigmaTableColumnRole {
  return value === "label" || value === "point" || value === "interval" || value === "value";
}

function isTableRowRole(value: unknown): value is SigmaTableRowRole {
  return value === "header" ||
    value === "body" ||
    value === "variable" ||
    value === "derivative" ||
    value === "variation" ||
    value === "note";
}

function isTrendDirection(value: unknown): value is SigmaTableTrendDirection {
  return value === "up" || value === "down" || value === "flat";
}

function isAiOverlayTableShape(value: unknown): value is OverlayTableShape {
  return isRecord(value) &&
    value.type === "tableShape" &&
    typeof value.id === "string" &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    isRecord(value.props) &&
    typeof value.props.w === "number" &&
    Number.isFinite(value.props.w) &&
    typeof value.props.h === "number" &&
    Number.isFinite(value.props.h) &&
    isRecord(value.props.table);
}

export function isAllowedAiOverlayAssetSource(source: string): boolean {
  if (source.startsWith("sigma-doc-storage://")) {
    return source.length <= MAX_AI_STORAGE_ASSET_REFERENCE_LENGTH
      && AI_STORAGE_ASSET_REFERENCE_PATTERN.test(source);
  }
  if (source.startsWith("data:image/svg+xml;base64,")) {
    if (source.length > MAX_AI_SVG_BYTES * 4 / 3 + 64) return false;
    const bytes = decodeStrictBase64(source.slice("data:image/svg+xml;base64,".length));
    if (!bytes || bytes.length > MAX_AI_SVG_BYTES) return false;
    try {
      validateAiSvg(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return true;
    } catch { return false; }
  }
  const match = /^data:image\/(png|jpeg|webp);base64,([a-z\d+/]+={0,2})$/i.exec(source);
  if (!match) {
    return false;
  }
  const bytes = decodeStrictBase64(match[2]);
  if (!bytes || bytes.length === 0 || bytes.length > MAX_AI_OVERLAY_ASSET_BYTES) {
    return false;
  }
  const dimensions = readRasterImageDimensions(match[1].toLowerCase(), bytes);
  return dimensions !== null
    && dimensions.width > 0
    && dimensions.height > 0
    && dimensions.width <= MAX_AI_OVERLAY_ASSET_DIMENSION
    && dimensions.height <= MAX_AI_OVERLAY_ASSET_DIMENSION
    && dimensions.width * dimensions.height <= MAX_AI_OVERLAY_ASSET_PIXELS;
}

export function getInvalidAiOverlayAssetIdsInDocument(document: Pick<SigmaDocument, "pageLayout">): string[] {
  // **生の asset を見る**。`normalizeOverlaySnapshot` は許可外の `src` を持つ asset を落とすように
  // なったので、正規化済みを見ると「不正なものが 1 件も無い」と読めてしまい、この門番が黙って
  // 効かなくなる (正規化が防いでいるのは描画であって、文書をブリッジや外部へ渡すことではない)。
  const rawAssets = document.pageLayout?.overlay?.overlaySnapshot?.assets;
  if (!isRecord(rawAssets)) {
    return [];
  }
  return Object.entries(rawAssets)
    .filter(([assetId, asset]) => {
      // 構造として壊れている項目は正規化が落とすので、ここでは「不正」と数えない。
      // 数えると、古い文書に 1 件でも欠けた asset があるだけで overlay を触らない編集まで
      // 失敗する (以前は正規化済みを見ていたので、この形はそもそも見えていなかった)。
      if (!isRecord(asset) || !isRecord(asset.props) || typeof asset.props.src !== "string") {
        return false;
      }
      return asset.id !== assetId || !isAllowedAiOverlayAssetSource(asset.props.src.trim());
    })
    .map(([assetId]) => assetId);
}

export function assertAiOverlayAssetsInDocument(document: Pick<SigmaDocument, "pageLayout">): void {
  const invalidAssetIds = getInvalidAiOverlayAssetIdsInDocument(document);
  if (invalidAssetIds.length > 0) {
    throw new Error(tv("schema.assertAiOverlayAssetsInDocument1", { p0: invalidAssetIds.slice(0, 8).join(", ") }));
  }
}

function getAiOverlayAssetSourceSizes(source: string): { encodedBytes: number; decodedBytes: number } | null {
  if (source.startsWith("sigma-doc-storage://")) {
    return { encodedBytes: source.length, decodedBytes: 0 };
  }
  const match = /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,([a-z\d+/]+={0,2})$/i.exec(source);
  if (!match) {
    return null;
  }
  const bytes = decodeStrictBase64(match[1]);
  return bytes ? { encodedBytes: source.length, decodedBytes: bytes.length } : null;
}

function decodeStrictBase64(encoded: string): Uint8Array | null {
  if (
    encoded.length === 0
    || encoded.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    return null;
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedLength = (encoded.length / 4) * 3 - padding;
  if (decodedLength > MAX_AI_OVERLAY_ASSET_BYTES) {
    return null;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (
    (padding === 2 && (alphabet.indexOf(encoded[encoded.length - 3]) & 0x0f) !== 0)
    || (padding === 1 && (alphabet.indexOf(encoded[encoded.length - 2]) & 0x03) !== 0)
  ) {
    return null;
  }
  const bytes = new Uint8Array(decodedLength);
  let outputIndex = 0;
  for (let index = 0; index < encoded.length; index += 4) {
    const a = alphabet.indexOf(encoded[index]);
    const b = alphabet.indexOf(encoded[index + 1]);
    const c = encoded[index + 2] === "=" ? 0 : alphabet.indexOf(encoded[index + 2]);
    const d = encoded[index + 3] === "=" ? 0 : alphabet.indexOf(encoded[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) {
      return null;
    }
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    if (outputIndex < decodedLength) bytes[outputIndex++] = bits >>> 16;
    if (outputIndex < decodedLength) bytes[outputIndex++] = (bits >>> 8) & 0xff;
    if (outputIndex < decodedLength) bytes[outputIndex++] = bits & 0xff;
  }
  return bytes;
}

function readRasterImageDimensions(
  mimeSubtype: string,
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (mimeSubtype === "png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 24 || !signature.every((byte, index) => bytes[index] === byte)) {
      return null;
    }
    if (readUint32Be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") {
      return null;
    }
    return { width: readUint32Be(bytes, 16), height: readUint32Be(bytes, 20) };
  }
  if (mimeSubtype === "jpeg") {
    return readJpegDimensions(bytes);
  }
  if (mimeSubtype === "webp") {
    return readWebpDimensions(bytes);
  }
  return null;
}

function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += segmentLength;
  }
  return null;
}

function readWebpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    return null;
  }
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: readUint24Le(bytes, 24) + 1,
      height: readUint24Le(bytes, 27) + 1,
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: ((bytes[26] | (bytes[27] << 8)) & 0x3fff),
      height: ((bytes[28] | (bytes[29] << 8)) & 0x3fff),
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] * 0x1000000)
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3]) >>> 0;
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
