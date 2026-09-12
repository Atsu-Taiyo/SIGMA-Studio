import { encodeAiSvg, MAX_AI_SVG_BYTES } from "./svg-image";
import { resolveValidationLocale, tv } from "@/lib/ai/validation-locale";
import { z } from "zod";

import {
  DEFAULT_CALLOUT_CORNER_RADIUS,
  buildGraph3DSceneGeometry,
  createArcShapeFromCenterDrag,
  createArcShapeFromThreePoints,
  createGraph3DSampledSpec,
  createGraph3DSpecPreset,
  createGraphAnnotationLabelShapeEntries,
  createGraphAxisLabelShapeEntries,
  createGraphFormulaLabelShapeEntries,
  createGraphPointLabelShapeEntries,
  DEFAULT_TEXT_SHAPE_WIDTH,
  estimateTextWidthEm,
  getGraph3DPreviewSourceHash,
  getGraphPlotSize,
  getOverlayTextBlocksLineCount,
  GRAPH3D_DEFAULT_CAMERA,
  normalizeCalloutCornerRadius,
  TEXT_ASCENT_EM,
  TEXT_DESCENT_EM,
  TEXT_SHAPE_LINE_HEIGHT,
} from "@/features/drawing";
import { createGraphLabelLayoutPort, measureTexBoxEm } from "@/features/rendering/adapters";
import { DEFAULT_MATH_RENDER_ENVIRONMENT } from "@/lib/math-environment";
import {
  clearMaterializedGraphLabelTexts,
  formatInlineNodeRange,
  isGraph3DSpec,
  isValidOverlaySnapshot,
  isWhiteboardPageLayout,
  migrateLegacyGraphShapeToPlotBounds,
  normalizeOrderedListMarkerStyle,
  normalizeOverlaySnapshot,
  overlayTextSizeToPx,
  reconcileInlineNodeReplacement,
  replaceInlineNodeRange,
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
  type OverlayAnchor,
  type OverlayArrowhead,
  type OverlayAsset,
  type OverlayDash,
  type OverlayGraph3DShape,
  type OverlayGraphAxisLabelKey,
  type OverlayGraphShape,
  type OverlayImageShape,
  type OverlayLineKind,
  type OverlayPoint,
  type OverlayTextBlock,
  type OverlayShape,
  type OverlayShapeId,
  type OverlayTableShape,
  type OverlayTextSize,
  normalizeLineHeight,
  OVERLAY_ARROWHEADS,
  type SigmaBlock,
  type SigmaDocument,
  listItemContinuationInlineNodes,
  type BoxBlockNode,
  type CodeBlockNode,
  type DividerNode,
  type QuoteBlockNode,
  type BoxBlockChildBlock,
  type BoxFrameSpec,
  type Graph2DSpec,
  type Graph3DSpec,
  type Graph3DViewSettings,
  type GraphAnnotation,
  type GraphAxes,
  type GraphCurve,
  type GraphCurveDash,
  type GraphCurveMode,
  type GraphFillRegion,
  type GraphPoint,
  type GraphPointLabelPlacement,
  type GraphViewBox,
  type InlineNode,
  type LayoutSectionChildBlock,
  type LayoutSectionNode,
  type SectionNode,
  type ProblemAreaBlock,
  type ProblemAreaKind,
  type ProblemNode,
  type PaginationHints,
  type RichBlock,
  type ListNode,
  type TextAlign,
  type TextMark,
} from "@/features/document";
import { resolveDocumentTitle } from "@/lib/document-title";

import {
  collectOutline,
  findBlock,
  findContainingProblem,
  insertRichBlockNearSelection,
  type EditableBlock,
} from "@/lib/document-tree";
import {
  blockToReferenceText,
  collectAiEditInsertionCandidates,
  getDefaultAiEditInsertionTargetId,
  type AiEditReference,
} from "@/lib/ai/ai-edit-reference";
import {
  applySigmaDocMutationOp,
  EditableBlockSchema,
  isAllowedAiOverlayAssetSource,
  type AiEditDraft,
  type AiEditSessionDocumentDraft,
  type SigmaDocMutationOp,
  createAiEditSessionDocumentDraft,
} from "@/lib/ai/sigma-doc-edit-schema";
import {
  anchorAbsoluteShape,
  getAiOverlayBlockRects,
  resolveAiOverlayPlacement,
  type AiOverlayPlacement,
} from "@/lib/ai/ai-overlay-placement";
import { splitDelimitedInlineMathText } from "@/features/rendering/core";
import { SigmaBlockSchema, RichBlockSchema, getTexIssues, parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { getGraphFillPath } from "@/lib/graph-fill";
import { buildGraph3DPresetNames } from "@/lib/graph3d-preset-names";
import { createTranslator, type Translate } from "@/lib/i18n";
import { formatGraphIssue, getGraphIssues, getGraphPlotBox } from "@/lib/graph2d";
import { formatValidationError } from "@/lib/validation-text";
import { isSigmaValidationError } from "@/features/document";
import { ptToPx } from "@/lib/font-size-units";
import { createId } from "@/lib/id";
import { parseMarkdownToTextFlowBlocks } from "@/lib/markdown-to-text-flow";

import { getBoxStyleDefinition, BUILTIN_BOX_STYLES, inlineTitleFromText } from "@/lib/box-blocks";
import {
  cloneMaterialContentForInsert,
  createMaterialCatalogEntry,
  materialMatchesConcepts,
  materialMatchesQuery,
} from "@/lib/materials";
import {
  inlineNodesToOverlayTextBlocks,
  inlineNodesToPlainText,
} from "@/lib/tiptap-adapter";

import type { MaterialItem } from "@/types/material";

export interface AiEditAttachment {
  id: string;
  name: string;
  mimeType: string | null;
  dataUrl: string;
  width?: number;
  height?: number;
  fileSize?: number;
  /** Overlay preview attachments keep the reference they visualize so history fallback stays per-reference. */
  sourceReferenceKey?: string;
}

export interface AiEditMentionedDocumentContext {
  id: string;
  fileId: string;
  title: string;
  documentPath: string;
  revision: number;
  excerpt: string;
  document: SigmaDocument;
}

export interface SigmaDocAgentSession {
  baseDocument: SigmaDocument;
  draftDocument: SigmaDocument;
  selectedId: string | null;
  references: AiEditReference[];
  attachments: AiEditAttachment[];
  mentionedDocuments: AiEditMentionedDocumentContext[];
  materials: MaterialItem[];
  operations: AiEditDraft[];
  operationResults: AiEditSessionDocumentDraft["operationResults"];
  /**
   * Block, column-layout, and overlay operations committed via `commitSigmaDocMutation`. Kept
   * separate from `operations` (AiEditDraft[])
   * because that array is rendered directly by AiEditInlinePreviewCard, which assumes every entry
   * carries a replacementBlock/insertedBlock/overlayShape/tableShape.
   */
  mutationOperations: SigmaDocMutationOp[];
  changedIds: string[];
  toolEvents: SigmaDocAgentToolEvent[];
}

export interface SigmaDocAgentToolEvent {
  toolName: SigmaDocAgentToolName;
  status: "ok" | "error";
  message: string;
  changedIds: string[];
}

export type SigmaDocAgentReadToolName =
  | "get_selected_block"
  | "get_active_reference"
  | "get_document_outline"
  | "get_document_metadata"
  | "get_insertion_candidates"
  | "get_neighbor_blocks"
  | "get_attached_media"
  | "get_mentioned_sigma_docs"
  | "get_material_catalog"
  | "get_material_content";

export type SigmaDocAgentDraftToolName =
  | "draft_insert_body_content"
  | "draft_format_inline"
  | "draft_replace_inline_text"
  | "draft_update_rich_content"
  | "draft_replace_block"
  | "draft_create_problem_content"
  | "draft_update_problem_content"
  | "draft_insert_table"
  | "draft_insert_shape"
  | "draft_insert_graph"
  | "draft_insert_graph3d"
  | "draft_update_graph3d"
  | "draft_insert_text_block"
  | "draft_create_problem"
  | "draft_update_problem_answer"
  | "draft_insert_overlay_shape"
  | "draft_insert_material"
  | "draft_insert_table_shape"
  | "draft_insert_graph_shape"
  | "draft_insert_svg_image"
  | "draft_update_svg_image"
  | "draft_insert_generated_image"
  | "draft_update_generated_image"
  | "draft_attach_image_asset"
  | "draft_validate";

export type SigmaDocAgentToolName = SigmaDocAgentReadToolName | SigmaDocAgentDraftToolName;

export const NULLABLE_SIGMA_DOC_AGENT_DRAFT_TOOL_ARGUMENT_KEYS: Partial<Record<SigmaDocAgentDraftToolName, readonly string[]>> = {
  draft_insert_body_content: ["targetId", "area"],
  draft_format_inline: ["targetId"],
  draft_replace_inline_text: ["targetId"],
  draft_update_rich_content: ["targetId", "text", "runs"],
  draft_replace_block: ["targetId"],
  draft_create_problem_content: [
    "targetId",
    "id",
    "title",
    "tags",
    "lead",
    "answer",
    "answerText",
    "answerTex",
    "solution",
    "hints",
    "numbering",
    "frame",
    "areaLayout",
  ],
  draft_update_problem_content: ["targetId", "lead", "prompt", "answerText", "answerTex", "solution", "hints"],
  draft_insert_table: [
    "targetId",
    "area",
    "id",
    "x",
    "y",
    "w",
    "h",
    "kind",
    "columns",
    "rows",
    "cells",
    "table",
    "grid",
    "defaultCellStyle",
    "variableLabel",
    "derivativeLabel",
    "functionLabel",
    "leftEndpoint",
    "rightEndpoint",
    "endpointValues",
    "criticalPoints",
    "criticalValues",
    "criticalDerivativeValues",
    "intervalSigns",
    "derivativeSigns",
    "trends",
    "functionValues",
  ],
  draft_insert_shape: [
    "targetId",
    "area",
    "id",
    "kind",
    "x",
    "y",
    "rotation",
    "label",
    "text",
    "tex",
    "points",
    "start",
    "end",
    "closed",
    "color",
    "fill",
    "fillColor",
    "fillOpacity",
    "strokeOpacity",
    "opacity",
    "dash",
    "size",
    "arrowheadStart",
    "arrowheadEnd",
    "tailBaseStart",
    "tailBaseEnd",
    "tailTip",
    "startAngle",
    "endAngle",
    "r",
    "rx",
    "ry",
    "stackLayer",
    "reserveSpace",
  ],
  draft_insert_graph: [
    "targetId",
    "area",
    "id",
    "x",
    "y",
    "w",
    "h",
    "spec",
    "kind",
    "title",
    "width",
    "height",
    "viewBox",
    "graphViewBox",
    "axes",
    "curves",
    "points",
    "annotations",
    "fills",
    "showFormulaLabels",
  ],
  draft_insert_graph3d: [
    "targetId",
    "area",
    "id",
    "x",
    "y",
    "w",
    "h",
    "preset",
    "spec",
    "parameters",
    "objects",
    "regions",
    "annotations",
    "camera",
    "view",
    "previewPng",
  ],
  draft_update_graph3d: [
    "w",
    "h",
    "preset",
    "spec",
    "parameters",
    "objects",
    "regions",
    "annotations",
    "camera",
    "view",
    "previewPng",
  ],
  draft_insert_text_block: ["targetId", "area"],
  draft_create_problem: ["targetId"],
  draft_update_problem_answer: ["targetId", "answer", "solution", "hints"],
  draft_insert_overlay_shape: ["targetId", "area", "assets"],
  draft_insert_material: ["targetId", "area", "x", "y", "scaleX", "scaleY", "rotation", "reason"],
  draft_insert_table_shape: ["targetId", "area"],
  draft_insert_graph_shape: ["targetId", "area", "shape", "spec", "id", "x", "y", "w", "h"],
  draft_insert_svg_image: ["name", "targetId", "area", "x", "y", "w", "h"],
  draft_update_svg_image: ["name"],
  draft_insert_generated_image: ["targetId", "area", "x", "y", "w", "h"],
  draft_update_generated_image: [],
  draft_attach_image_asset: ["targetId", "area", "attachmentId", "id", "assetId", "x", "y", "w", "h"],
};

export interface SigmaDocAgentToolResult {
  ok: boolean;
  message: string;
  changedIds: string[];
  draftSummary: {
    contentCount: number;
    operationCount: number;
    changedIds: string[];
  };
  data?: unknown;
}

const ProblemAreaSchema = z.enum(["lead", "prompt", "solution", "hints"]);
const AnswerDefinitionSchema = z.object({
  type: z.enum(["math", "text"]),
  expected: z.string(),
});
const OverlayShapeSchema = z.custom<OverlayShape>((value) => isRecord(value));
const OverlayAssetSchema = z.custom<OverlayAsset>((value) => isRecord(value));
const OverlayAssetsSchema = z.record(z.string(), OverlayAssetSchema).optional().default({});
const Graph2DSpecSchema = z.custom<Graph2DSpec>((value) => isRecord(value));
const LooseRecordSchema = z.record(z.string(), z.unknown());
const AiRichBlockInputSchema = z.union([z.string(), LooseRecordSchema]);
const PaginationInputSchema = z.object({
  break: z.boolean().optional(),
  keepTogether: z.boolean().optional(),
  keepWithNext: z.boolean().optional(),
}).strict();
const AiRichBlockListSchema = z.union([
  AiRichBlockInputSchema,
  z.array(AiRichBlockInputSchema).min(1),
]);
const AiUpdateRichBlockListSchema = z.union([
  AiRichBlockInputSchema,
  z.array(AiRichBlockInputSchema),
]);
const AiLeadRichBlockListSchema = z.union([
  AiRichBlockInputSchema,
  z.array(AiRichBlockInputSchema).min(1),
]);
const AiUpdateLeadRichBlockListSchema = z.union([
  AiRichBlockInputSchema,
  z.array(AiRichBlockInputSchema),
]);
const AiTableCellInputSchema = z.union([z.string(), z.number(), z.null(), LooseRecordSchema]).optional();
const AiTableColumnSchema = LooseRecordSchema;
const AiTableRowSchema = LooseRecordSchema;
const AiGraphItemSchema = LooseRecordSchema;
const AiVariationTableValueSchema = z.union([z.string(), z.number(), z.null()]);
const AiVariationTrendSchema = z.enum(["up", "down", "flat"]);
const AiOverlayPointSchema = z.object({
  x: z.number(),
  y: z.number(),
});
const MaterialCatalogArgsSchema = z.object({
  query: z.string().optional(),
  concepts: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(50).optional(),
});
const MaterialContentArgsSchema = z.object({
  materialId: z.string().min(1),
});
const AiOverlayShapeKindSchema = z.enum([
  "rectangle",
  "circle",
  "ellipse",
  "triangle",
  "diamond",
  "pentagon",
  "blockArrow",
  "arc",
  "sector",
  "arrow",
  "line",
  "polyline",
  "curve",
  "freehand",
  "highlight",
  "text",
  "callout",
]);

export const DraftInsertBodyContentArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  area: ProblemAreaSchema.optional(),
  blocks: z.array(AiRichBlockInputSchema).min(1),
});

export const DraftUpdateRichContentArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  text: z.string().optional(),
  runs: z.array(z.union([z.string(), LooseRecordSchema])).min(1).optional(),
  pagination: PaginationInputSchema.nullable().optional(),
}).refine((value) => !(value.text !== undefined && value.runs !== undefined), {
  error: () => tv("tools.updateRichContent1"),
}).refine((value) => value.text !== undefined || value.runs !== undefined || value.pagination !== undefined, {
  error: () => tv("tools.updateRichContent2"),
});

const InlineFormatBoxSchema = z.object({
  enabled: z.boolean(),
  paddingY: z.number().min(0).max(100).optional(),
  variant: z.enum(["frame", "thick", "double", "oval", "shade"]).optional(),
  tone: z.enum(["gray", "blue", "green", "red", "yellow"]).optional(),
}).strict();

export const DraftFormatInlineArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  from: z.number().int().nonnegative(),
  to: z.number().int().positive(),
  quote: z.string().optional(),
  style: z.object({
    fontFamily: z.string().nullable().optional(),
    fontSize: z.number().positive().max(512).nullable().optional(),
    boxed: InlineFormatBoxSchema.optional(),
  }).strict().refine((style) => (
    style.fontFamily !== undefined || style.fontSize !== undefined || style.boxed !== undefined
  ), { error: () => tv("tools.formatInline1") }),
}).strict();

export const DraftReplaceInlineTextArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  quote: z.string(),
  replacement: z.union([
    z.string(),
    z.array(z.union([z.string(), LooseRecordSchema])).min(1),
  ]),
}).strict().refine((value) => value.to >= value.from, {
  error: () => tv("tools.replaceInlineText1"),
});

export const DraftUpdateBlockArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  block: EditableBlockSchema,
});

export const DraftCreateProblemContentArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  lead: AiLeadRichBlockListSchema.optional(),
  prompt: AiRichBlockListSchema,
  answer: AnswerDefinitionSchema.optional(),
  answerText: z.string().optional(),
  answerTex: z.string().optional(),
  solution: AiRichBlockListSchema.optional(),
  hints: AiRichBlockListSchema.optional(),
  numbering: LooseRecordSchema.optional(),
  frame: LooseRecordSchema.optional(),
  areaLayout: LooseRecordSchema.optional(),
  pagination: PaginationInputSchema.optional(),
});

export const DraftUpdateProblemSolutionArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  lead: AiUpdateLeadRichBlockListSchema.optional(),
  prompt: AiRichBlockListSchema.optional(),
  answer: AnswerDefinitionSchema.nullable().optional(),
  answerText: z.string().optional(),
  answerTex: z.string().optional(),
  solution: AiUpdateRichBlockListSchema.optional(),
  hints: AiUpdateRichBlockListSchema.optional(),
  pagination: PaginationInputSchema.nullable().optional(),
}).refine((value) => (
  value.lead !== undefined ||
  value.prompt !== undefined ||
  value.answer !== undefined ||
  value.answerText !== undefined ||
  value.answerTex !== undefined ||
  value.solution !== undefined ||
  value.hints !== undefined ||
  value.pagination !== undefined
), {
  error: () => tv("tools.updateProblemSolution1"),
}).refine((value) => [value.answer, value.answerText, value.answerTex].filter((item) => item !== undefined).length <= 1, {
  error: () => tv("tools.updateProblemSolution2"),
});

const PlacementSchema = z.object({
  anchorBlockId: z.string().min(1),
  position: z.enum(["below", "above", "rightOf", "leftOf"]),
  offsetX: z.number().optional(),
  offsetY: z.number().optional(),
});

export const DraftInsertTableArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  area: ProblemAreaSchema.optional(),
  id: z.string().min(1).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  placement: PlacementSchema.optional(),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
  kind: z.enum(["plain", "variation"]).optional(),
  columns: z.array(AiTableColumnSchema).min(1).max(12).optional(),
  rows: z.array(AiTableRowSchema).min(1).max(24).optional(),
  cells: z.array(z.array(AiTableCellInputSchema).max(12)).min(1).max(24).optional(),
  table: z.custom<SigmaTableSpec>((value) => isRecord(value)).optional(),
  grid: LooseRecordSchema.optional(),
  defaultCellStyle: LooseRecordSchema.optional(),
  variableLabel: z.string().optional(),
  derivativeLabel: z.string().optional(),
  functionLabel: z.string().optional(),
  leftEndpoint: AiVariationTableValueSchema.optional(),
  rightEndpoint: AiVariationTableValueSchema.optional(),
  endpointValues: z.array(AiVariationTableValueSchema).max(2).optional(),
  criticalPoints: z.array(AiVariationTableValueSchema).max(12).optional(),
  criticalValues: z.array(AiVariationTableValueSchema).max(12).optional(),
  criticalDerivativeValues: z.array(AiVariationTableValueSchema).max(12).optional(),
  intervalSigns: z.array(AiVariationTableValueSchema).min(1).max(13).optional(),
  derivativeSigns: z.array(AiVariationTableValueSchema).min(1).max(25).optional(),
  trends: z.array(AiVariationTrendSchema).min(1).max(13).optional(),
  functionValues: z.array(AiVariationTableValueSchema).max(14).optional(),
  reserveSpace: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  const hasXY = value.x !== undefined || value.y !== undefined;
  const hasPlacement = value.placement !== undefined;

  if (hasXY && hasPlacement) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: tv("tools.insertTable1"),
    });
  }
});

export const DraftInsertShapeArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  area: ProblemAreaSchema.optional(),
  id: z.string().min(1).optional(),
  kind: AiOverlayShapeKindSchema,
  x: z.number().optional(),
  y: z.number().optional(),
  placement: PlacementSchema.optional(),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
  rotation: z.number().optional(),
  label: z.string().optional(),
  text: z.string().optional(),
  tex: z.string().optional(),
  markdown: z.string().optional(),
  points: z.array(AiOverlayPointSchema).min(2).max(24).optional(),
  start: AiOverlayPointSchema.optional(),
  end: AiOverlayPointSchema.optional(),
  closed: z.boolean().optional(),
  color: z.string().optional(),
  fill: z.enum(["none", "solid"]).optional(),
  fillColor: z.string().optional(),
  fillOpacity: z.number().min(0).max(1).optional(),
  strokeOpacity: z.number().min(0).max(1).optional(),
  opacity: z.number().min(0).max(1).optional(),
  dash: z.enum(["solid", "dashed", "dotted"]).optional(),
  size: z.enum(["s", "m", "l", "xl"]).optional(),
  fontSize: z.number().positive().optional(),
  arrowheadStart: z.enum(OVERLAY_ARROWHEADS).optional(),
  arrowheadEnd: z.enum(OVERLAY_ARROWHEADS).optional(),
  tailBaseStart: AiOverlayPointSchema.optional(),
  tailBaseEnd: AiOverlayPointSchema.optional(),
  tailTip: AiOverlayPointSchema.optional(),
  cornerRadius: z.number().nonnegative().optional(),
  startAngle: z.number().optional(),
  endAngle: z.number().optional(),
  r: z.number().positive().optional(),
  rx: z.number().positive().optional(),
  ry: z.number().positive().optional(),
  stackLayer: z.enum(["foreground", "background"]).optional(),
  reserveSpace: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  const hasXY = value.x !== undefined || value.y !== undefined;
  const hasPlacement = value.placement !== undefined;

  if (hasXY && hasPlacement) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: tv("tools.insertShape1"),
    });
  }

  if (value.kind !== "text" && value.kind !== "callout" && value.w !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: tv("tools.insertShape2"),
    });
  }
  if (value.kind !== "text" && value.kind !== "callout" && value.fontSize !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: tv("tools.insertShape3"),
    });
  }
  // A text shape's height is its content's, so a caller naming one is asking for something that
  // cannot be honoured — the editor overwrites it with the measured height the first time it
  // draws the shape. Refused rather than accepted and dropped.
  if (value.kind !== "callout" && value.h !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: tv("tools.insertShape4"),
    });
  }
  if (value.kind !== "callout" && value.cornerRadius !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: tv("tools.insertShape5"),
    });
  }
  for (const message of getShapeToolMarkdownIssues(value, value.kind)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message,
    });
  }
});

export const DraftInsertGraphArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  area: ProblemAreaSchema.optional(),
  id: z.string().min(1).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
  spec: Graph2DSpecSchema.optional(),
  kind: z.enum(["cartesian", "numberLine"]).optional(),
  title: z.string().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  viewBox: LooseRecordSchema.optional(),
  graphViewBox: LooseRecordSchema.optional(),
  axes: LooseRecordSchema.optional(),
  curves: z.array(AiGraphItemSchema).max(16).optional(),
  points: z.array(AiGraphItemSchema).max(64).optional(),
  annotations: z.array(AiGraphItemSchema).max(32).optional(),
  fills: z.array(AiGraphItemSchema).max(24).optional(),
  showFormulaLabels: z.boolean().optional(),
});

/**
 * 3D の draft 層は 2D (`Graph2DSpecSchema`) と同じ分業で、型は緩く受けて
 * `isGraph3DSpec()` で最終検証する。厳密な形は MCP / WebMCP の入力スキーマが担う。
 */
const Graph3DSpecArgSchema = z.custom<Record<string, unknown>>((value) => isRecord(value));
const Graph3DPresetSchema = z.enum(["revolution", "surface", "tricylinder", "sphereTetrahedron", "blank"]);
const Graph3DPreviewPngSchema = z.object({
  dataUrl: z.string().min(1),
  w: z.number().positive(),
  h: z.number().positive(),
  fileSize: z.number().nonnegative().optional(),
}).strict();

const Graph3DSpecPartsArgsSchema = {
  preset: Graph3DPresetSchema.optional(),
  spec: Graph3DSpecArgSchema.optional(),
  parameters: z.array(LooseRecordSchema).max(16).optional(),
  objects: z.array(LooseRecordSchema).max(64).optional(),
  regions: z.array(LooseRecordSchema).max(32).optional(),
  annotations: z.array(LooseRecordSchema).max(64).optional(),
  camera: LooseRecordSchema.optional(),
  view: LooseRecordSchema.optional(),
} as const;

export const DraftInsertGraph3DArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  area: ProblemAreaSchema.optional(),
  id: z.string().min(1).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
  ...Graph3DSpecPartsArgsSchema,
  previewPng: Graph3DPreviewPngSchema.optional(),
});

export const DraftUpdateGraph3DArgsSchema = z.object({
  shapeId: z.string().min(1),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
  ...Graph3DSpecPartsArgsSchema,
  previewPng: Graph3DPreviewPngSchema.optional(),
});

const DraftInsertTextBlockArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  area: ProblemAreaSchema.optional(),
  block: RichBlockSchema,
});

const DraftCreateProblemArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  problem: SigmaBlockSchema.refine((block): block is ProblemNode => block.type === "problem", {
    error: () => tv("tools.createProblem1"),
  }),
});

const DraftUpdateProblemAnswerArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  answer: AnswerDefinitionSchema.optional(),
  solution: z.array(RichBlockSchema).optional(),
  hints: z.array(RichBlockSchema).optional(),
}).refine((value) => value.answer !== undefined || value.solution !== undefined || value.hints !== undefined, {
  error: () => tv("tools.updateProblemAnswer1"),
});

export const DraftInsertOverlayShapeArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  area: ProblemAreaSchema.optional(),
  shape: OverlayShapeSchema,
  assets: OverlayAssetsSchema,
});

export const DraftInsertMaterialArgsSchema = z.object({
  materialId: z.string().min(1),
  targetId: z.string().min(1).optional(),
  area: ProblemAreaSchema.optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  scaleX: z.number().positive().optional(),
  scaleY: z.number().positive().optional(),
  rotation: z.number().optional(),
  reason: z.string().optional(),
});

const DraftInsertTableShapeArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  area: ProblemAreaSchema.optional(),
  shape: OverlayShapeSchema.refine((shape): shape is OverlayTableShape => (
    isRecord(shape) && shape.type === "tableShape"
  ), { error: () => tv("tools.insertTableShape1") }),
});

const DraftInsertGraphShapeArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  area: ProblemAreaSchema.optional(),
  shape: OverlayShapeSchema.optional(),
  spec: Graph2DSpecSchema.optional(),
  id: z.string().min(1).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
}).refine((value) => value.shape !== undefined || value.spec !== undefined, {
  error: () => tv("tools.insertGraphShape1"),
});

export const DraftInsertSvgImageArgsSchema = z.object({
  svg: z.string().min(1).max(MAX_AI_SVG_BYTES),
  name: z.string().min(1).max(200).optional(),
  targetId: z.string().min(1).optional(),
  area: ProblemAreaSchema.optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  w: z.number().positive().max(8192).optional(),
  h: z.number().positive().max(8192).optional(),
});

export const DraftUpdateSvgImageArgsSchema = z.object({
  shapeId: z.string().min(1),
  svg: z.string().min(1).max(MAX_AI_SVG_BYTES),
  name: z.string().min(1).max(200).optional(),
});

export const DraftAttachImageAssetArgsSchema = z.object({
  targetId: z.string().min(1).optional(),
  area: ProblemAreaSchema.optional(),
  attachmentId: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  assetId: z.string().min(1).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
});

export const DraftInsertGeneratedImageArgsSchema = DraftAttachImageAssetArgsSchema.pick({
  targetId: true, area: true, x: true, y: true, w: true, h: true,
}).extend({ imageId: z.string().regex(/^[a-f0-9]{64}$/) });

export const DraftUpdateGeneratedImageArgsSchema = z.object({
  imageId: z.string().regex(/^[a-f0-9]{64}$/),
  shapeId: z.string().min(1),
});

// Host-supplied bytes only; public MCP schemas accept an imageId, never a path/data URL.
const GeneratedImageAttachmentSchema = z.object({
  id: z.string().min(1), name: z.string(),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  dataUrl: z.string().max(28 * 1024 * 1024).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
  width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
  fileSize: z.number().int().positive().max(20 * 1024 * 1024),
});

export function createSigmaDocAgentSession({
  document,
  selectedId,
  references = [],
  attachments = [],
  mentionedDocuments = [],
  materials = [],
}: {
  document: SigmaDocument;
  selectedId: string | null;
  references?: AiEditReference[];
  attachments?: AiEditAttachment[];
  mentionedDocuments?: AiEditMentionedDocumentContext[];
  materials?: MaterialItem[];
}): SigmaDocAgentSession {
  const baseDocument = parseSigmaDocument(document);
  return {
    baseDocument,
    draftDocument: baseDocument,
    selectedId,
    references,
    attachments,
    mentionedDocuments,
    materials,
    operations: [],
    operationResults: [],
    mutationOperations: [],
    changedIds: [],
    toolEvents: [],
  };
}

export function executeSigmaDocAgentTool(
  session: SigmaDocAgentSession,
  name: SigmaDocAgentToolName,
  rawArgs: unknown,
): SigmaDocAgentToolResult {
  if (isSigmaDocAgentReadToolName(name)) {
    return executeSigmaDocAgentReadTool(session, name, rawArgs);
  }
  return executeSigmaDocAgentDraftTool(session, name, rawArgs);
}

export function executeSigmaDocAgentReadTool(
  session: SigmaDocAgentSession,
  name: SigmaDocAgentReadToolName,
  rawArgs: unknown,
): SigmaDocAgentToolResult {
  const args = parseRawToolArgs(rawArgs);

  try {
    const result = runReadTool(session, name, args);
    session.toolEvents.push({
      toolName: name,
      status: "ok",
      message: result.message,
      changedIds: [],
    });
    return result;
  } catch (error) {
    const message = formatToolError(error);
    const result = createToolResult(session, false, message, [], undefined);
    session.toolEvents.push({
      toolName: name,
      status: "error",
      message,
      changedIds: [],
    });
    return result;
  }
}

export function executeSigmaDocAgentDraftTool(
  session: SigmaDocAgentSession,
  name: SigmaDocAgentDraftToolName,
  rawArgs: unknown,
): SigmaDocAgentToolResult {
  const args = parseToolArgs(name, rawArgs);

  try {
    const result = runDraftTool(session, name, args);
    session.toolEvents.push({
      toolName: name,
      status: "ok",
      message: result.message,
      changedIds: result.changedIds,
    });
    return result;
  } catch (error) {
    const message = formatToolError(error);
    const result = createToolResult(session, false, message, [], undefined);
    session.toolEvents.push({
      toolName: name,
      status: "error",
      message,
      changedIds: [],
    });
    return result;
  }
}

export function getSigmaDocAgentSessionDraft(
  session: SigmaDocAgentSession,
  finalOutput: unknown,
): AiEditSessionDocumentDraft & { changedIds: string[] } {
  const output = isRecord(finalOutput) ? finalOutput : {};
  const summary = nonEmptyStringOr(output.summary, session.operations.length > 0 ? tv("tools.getSigmaDocAgentSessionDraft1") : tv("tools.getSigmaDocAgentSessionDraft2"));
  const plan = normalizeStringArray(output.plan).slice(0, 8);
  const warnings = normalizeStringArray(output.warnings).slice(0, 8);

  return {
    draft: {
      summary,
      plan: plan.length > 0 ? plan : session.toolEvents.map((event) => event.message).slice(0, 8),
      operations: session.operations,
      mutationOperations: session.mutationOperations,
      warnings,
    },
    nextDocument: parseSigmaDocument(session.draftDocument),
    operationResults: session.operationResults,
    changedIds: uniqueStrings([
      ...session.changedIds,
      ...normalizeStringArray(output.changedIds),
    ]),
  };
}

export interface SigmaDocOperationSummary {
  /** The op's `operation` field, or "replace" for the legacy (operation-less) replace shape. */
  type: string;
  targetId?: string;
  blockIds?: string[];
  shapeIds?: string[];
  insertedBlockIds?: string[];
  /** One Japanese line describing the change (the op's own `summary`). */
  summaryText: string;
}

export interface SigmaDocSessionDraftSummary {
  operationSummaries: SigmaDocOperationSummary[];
  blockCount: number;
  revisionInfo: { changedIds: string[] };
}

/**
 * Lightweight alternative to `getSigmaDocAgentSessionDraft`'s full result: no `nextDocument`, no
 * full block payloads, just enough for a tool result to describe what changed. Additive — does
 * not change `getSigmaDocAgentSessionDraft`'s behavior or signature.
 */
export function summarizeSessionDraftForToolResult(
  draft: AiEditSessionDocumentDraft & { changedIds?: string[] },
): SigmaDocSessionDraftSummary {
  return {
    operationSummaries: draft.draft.operations.map(summarizeAiEditDraftOperation),
    blockCount: draft.nextDocument.content.length,
    revisionInfo: { changedIds: draft.changedIds ?? [] },
  };
}

function summarizeAiEditDraftOperation(op: AiEditDraft): SigmaDocOperationSummary {
  if (op.operation === "insertAfter") {
    return { type: op.operation, targetId: op.targetId, insertedBlockIds: [op.insertedBlock.id], summaryText: op.summary };
  }
  if (op.operation === "insertTableShape") {
    return { type: op.operation, targetId: op.targetId, insertedBlockIds: [op.tableShape.id], summaryText: op.summary };
  }
  if (op.operation === "insertOverlayShape") {
    return { type: op.operation, targetId: op.targetId, insertedBlockIds: [op.overlayShape.id], summaryText: op.summary };
  }
  return { type: "replace", targetId: op.targetId, summaryText: op.summary };
}

/**
 * Same shape as `summarizeSessionDraftForToolResult`'s entries, for block/layout/overlay/page-layout
 * mutation ops (see `session.mutationOperations`). A caller building a combined
 * tool result can concatenate this with `summarizeSessionDraftForToolResult(...).operationSummaries`.
 */
export function summarizeSigmaDocMutationOps(ops: SigmaDocMutationOp[]): SigmaDocOperationSummary[] {
  return ops.map(summarizeSigmaDocMutationOp);
}

function summarizeSigmaDocMutationOp(op: SigmaDocMutationOp): SigmaDocOperationSummary {
  if (op.operation === "deleteBlocks") {
    return { type: op.operation, blockIds: op.blockIds, summaryText: op.summary };
  }
  if (op.operation === "moveBlocks") {
    return { type: op.operation, targetId: op.targetId, blockIds: op.blockIds, summaryText: op.summary };
  }
  if (op.operation === "updateOverlayShape") {
    return { type: op.operation, shapeIds: [op.shapeId], summaryText: op.summary };
  }
  if (op.operation === "updatePageLayout") {
    return { type: op.operation, summaryText: op.summary };
  }
  if (op.operation === "alignOverlayShapes" || op.operation === "deleteOverlayShapes") {
    return { type: op.operation, shapeIds: op.shapeIds, summaryText: op.summary };
  }
  if (op.operation === "wrapBlocksInColumns") {
    return { type: op.operation, blockIds: op.blockIds, summaryText: op.summary };
  }
  if (op.operation === "updateLayoutSection") {
    return { type: op.operation, targetId: op.sectionId, summaryText: op.summary };
  }
  return { type: op.operation, summaryText: op.summary };
}

function runReadTool(
  session: SigmaDocAgentSession,
  name: SigmaDocAgentReadToolName,
  args: Record<string, unknown>,
): SigmaDocAgentToolResult {
  switch (name) {
    case "get_selected_block":
      return getSelectedBlock(session, args);
    case "get_active_reference":
      return getActiveReference(session);
    case "get_document_outline":
      return getDocumentOutline(session);
    case "get_document_metadata":
      return getDocumentMetadata(session);
    case "get_insertion_candidates":
      return getInsertionCandidates(session, args);
    case "get_neighbor_blocks":
      return getNeighborBlocks(session, args);
    case "get_attached_media":
      return getAttachedMedia(session);
    case "get_mentioned_sigma_docs":
      return getMentionedSigmaDocs(session);
    case "get_material_catalog":
      return getMaterialCatalog(session, args);
    case "get_material_content":
      return getMaterialContent(session, args);
  }
}

function runDraftTool(
  session: SigmaDocAgentSession,
  name: SigmaDocAgentDraftToolName,
  args: Record<string, unknown>,
): SigmaDocAgentToolResult {
  switch (name) {
    case "draft_insert_body_content":
      return draftInsertBodyContent(session, args);
    case "draft_format_inline":
      return draftFormatInline(session, args);
    case "draft_replace_inline_text":
      return draftReplaceInlineText(session, args);
    case "draft_update_rich_content":
      return draftUpdateRichContent(session, args);
    case "draft_replace_block":
      return draftUpdateBlock(session, args);
    case "draft_create_problem_content":
      return draftCreateProblemContent(session, args);
    case "draft_update_problem_content":
      return draftUpdateProblemSolution(session, args);
    case "draft_insert_table":
      return draftInsertTable(session, args);
    case "draft_insert_shape":
      return draftInsertShape(session, args);
    case "draft_insert_graph":
      return draftInsertGraph(session, args);
    case "draft_insert_graph3d":
      return draftInsertGraph3D(session, args);
    case "draft_update_graph3d":
      return draftUpdateGraph3D(session, args);
    case "draft_insert_text_block":
      return draftInsertTextBlock(session, args);
    case "draft_create_problem":
      return draftCreateProblem(session, args);
    case "draft_update_problem_answer":
      return draftUpdateProblemAnswer(session, args);
    case "draft_insert_overlay_shape":
      return draftInsertOverlayShape(session, args);
    case "draft_insert_material":
      return draftInsertMaterial(session, args);
    case "draft_insert_table_shape":
      return draftInsertTableShape(session, args);
    case "draft_insert_graph_shape":
      return draftInsertGraphShape(session, args);
    case "draft_insert_svg_image":
      return draftInsertSvgImage(session, args);
    case "draft_update_svg_image":
      return draftUpdateSvgImage(session, args);
    case "draft_insert_generated_image":
      return draftInsertGeneratedImage(session, args);
    case "draft_update_generated_image":
      return draftUpdateGeneratedImage(session, args);
    case "draft_attach_image_asset":
      return draftAttachImageAsset(session, args);
    case "draft_validate":
      return draftValidate(session);
  }
}

function draftFormatInline(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftFormatInlineArgsSchema.parse(rawArgs);
  const targetId = getTargetId(session, args.targetId);
  const current = findBlock(session.draftDocument, targetId);
  if (!current) {
    throw new Error(tv("tools.draftFormatInline1", { p0: targetId }));
  }
  if (current.type !== "paragraph" && current.type !== "heading") {
    throw new Error(tv("tools.draftFormatInline2"));
  }

  const referenceText = blockToReferenceText(current);
  if (args.quote !== undefined && referenceText.slice(args.from, args.to) !== args.quote) {
    throw new Error(tv("tools.draftFormatInline3"));
  }
  const replacementBlock = {
    ...current,
    children: formatInlineNodeRange(current.children, args.from, args.to, args.style),
  };

  return commitOperation(session, {
    operation: "replace",
    summary: tv("tools.draftFormatInline4"),
    targetId,
    replacementBlock,
  }, [targetId]);
}

function draftReplaceInlineText(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftReplaceInlineTextArgsSchema.parse(rawArgs);
  const targetId = getTargetId(session, args.targetId);
  const current = findBlock(session.draftDocument, targetId);
  if (!current) {
    throw new Error(tv("tools.draftReplaceInlineText1", { p0: targetId }));
  }
  if (current.type !== "paragraph" && current.type !== "heading") {
    throw new Error(tv("tools.draftReplaceInlineText2"));
  }

  const referenceText = blockToReferenceText(current);
  if (referenceText.slice(args.from, args.to) !== args.quote) {
    throw new Error(tv("tools.draftReplaceInlineText3"));
  }
  const replacementChildren = typeof args.replacement === "string"
    ? createTextInlinesWithDelimitedMath(args.replacement, {})
    : normalizeAiInlineNodes(args.replacement);
  const replacementBlock = normalizeRichBlockMath({
    ...current,
    children: replaceInlineNodeRange(current.children, args.from, args.to, replacementChildren),
  });
  assertTypedMathRunsPreserved(
    typeof args.replacement === "string" ? undefined : args.replacement,
    replacementBlock.children,
  );

  return commitOperation(session, {
    operation: "replace",
    summary: tv("tools.draftReplaceInlineText4"),
    targetId,
    replacementBlock,
  }, [targetId]);
}

function getSelectedBlock(session: SigmaDocAgentSession, args: Record<string, unknown>): SigmaDocAgentToolResult {
  const targetId = getReadableTargetId(session, args.targetId);
  const block = targetId ? findBlock(session.draftDocument, targetId) : null;
  return createToolResult(session, true, block ? tv("tools.getSelectedBlock1") : tv("tools.getSelectedBlock2"), [], {
    selectedId: targetId,
    block: summarizeToolBlock(block),
  });
}

function getActiveReference(session: SigmaDocAgentSession): SigmaDocAgentToolResult {
  return createToolResult(session, true, tv("tools.getActiveReference1"), [], {
    selectedId: session.selectedId,
    // 単数版を読む既存の外部MCP client向け互換field。複数対応clientはreferencesを使う。
    reference: session.references[0] ?? null,
    // ユーザーが指定した参照の一覧 (複数可)。0件 = 参照指定なし。
    references: session.references,
  });
}

function getDocumentOutline(session: SigmaDocAgentSession): SigmaDocAgentToolResult {
  return createToolResult(session, true, tv("tools.getDocumentOutline1"), [], {
    outline: collectOutline(session.draftDocument, { includeBodyBlocks: true }),
    comments: (session.draftDocument.comments ?? []).map((thread) => ({
      id: thread.id,
      resolved: Boolean(thread.resolved),
      anchor: thread.anchor,
      excerpt: inlineNodesToPlainText(thread.messages[0]?.body ?? []).trim().slice(0, 120),
    })),
  });
}

function getDocumentMetadata(session: SigmaDocAgentSession): SigmaDocAgentToolResult {
  return createToolResult(session, true, tv("tools.getDocumentMetadata1"), [], {
    version: session.draftDocument.version,
    docId: session.draftDocument.docId,
    title: resolveDocumentTitle(session.draftDocument),
    contentCount: session.draftDocument.content.length,
    outputProfiles: session.draftDocument.outputProfiles,
  });
}

function getInsertionCandidates(session: SigmaDocAgentSession, args: Record<string, unknown>): SigmaDocAgentToolResult {
  const fallbackTargetId = getReadableTargetId(session, args.targetId);
  return createToolResult(session, true, tv("tools.getInsertionCandidates1"), [], {
    targetId: fallbackTargetId,
    candidates: collectAiEditInsertionCandidates(session.draftDocument, { fallbackTargetId }),
  });
}

function getNeighborBlocks(session: SigmaDocAgentSession, args: Record<string, unknown>): SigmaDocAgentToolResult {
  const targetId = getReadableTargetId(session, args.targetId);
  if (!targetId) {
    return createToolResult(session, true, tv("tools.getNeighborBlocks1"), [], {
      scope: "none",
      targetId: null,
    });
  }
  return createToolResult(session, true, tv("tools.getNeighborBlocks2"), [], collectNeighborBlocks(session.draftDocument, targetId));
}

function getAttachedMedia(session: SigmaDocAgentSession): SigmaDocAgentToolResult {
  return createToolResult(session, true, tv("tools.getAttachedMedia1"), [], {
    attachments: session.attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      width: attachment.width ?? null,
      height: attachment.height ?? null,
      fileSize: attachment.fileSize ?? null,
      sourceReferenceKey: attachment.sourceReferenceKey ?? null,
      hasFileData: attachment.dataUrl.startsWith("data:"),
      hasImageData: attachment.dataUrl.startsWith("data:image/"),
    })),
  });
}

function getMentionedSigmaDocs(session: SigmaDocAgentSession): SigmaDocAgentToolResult {
  return createToolResult(session, true, tv("tools.getMentionedSigmaDocs1"), [], {
    documents: session.mentionedDocuments.map((item) => ({
      id: item.id,
      fileId: item.fileId,
      title: item.title,
      documentPath: item.documentPath,
      revision: item.revision,
      excerpt: item.excerpt,
      document: item.document,
    })),
  });
}

function getMaterialCatalog(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = MaterialCatalogArgsSchema.parse(rawArgs);
  const concepts = args.concepts ?? [];
  const query = args.query ?? "";
  const matches = session.materials.filter((material) => (
    materialMatchesQuery(material, query) && materialMatchesConcepts(material, concepts)
  ));
  const limit = args.limit ?? 20;
  return createToolResult(session, true, tv("tools.getMaterialCatalog1"), [], {
    totalCount: session.materials.length,
    matchedCount: matches.length,
    materials: matches.slice(0, limit).map(createMaterialCatalogEntry),
  });
}

function getMaterialContent(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = MaterialContentArgsSchema.parse(rawArgs);
  const material = findMaterialById(session, args.materialId);
  return createToolResult(session, true, tv("tools.getMaterialContent1"), [], {
    material: {
      ...createMaterialCatalogEntry(material),
      content: material.content,
    },
  });
}

function draftInsertBodyContent(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftInsertBodyContentArgsSchema.parse(rawArgs);
  if (session.draftDocument.pageLayout && isWhiteboardPageLayout(session.draftDocument.pageLayout)) {
    throw new Error(tv("tools.whiteboardBodyInsertionUnsupported"));
  }
  const targetId = getTargetId(session, args.targetId);
  const blocks = ensureUniqueRichBlocksForInsert(
    session,
    args.blocks.map((block, index) => normalizeAiRichBlockInput(block, "ai_body", index)),
  );
  assertNewBlockIds(session, blocks.map((block) => block.id), targetId);
  const texIssues = blocks.flatMap((block) => getBlockTexIssues(block));
  if (texIssues.length > 0) {
    throw new Error(tv("tools.draftInsertBodyContent1", { p0: texIssues.slice(0, 10).join(" / ") }));
  }
  assertRichBlocksDoNotContainVariationTableArray(blocks);

  if (args.area) {
    if (blocks.some(b => b.type === "boxBlock")) {
      throw new Error(tv("tools.draftInsertBodyContent2"));
    }
    const problem = findContainingProblem(session.draftDocument, targetId);
    if (!problem) {
      throw new Error(tv("tools.draftInsertBodyContent3"));
    }
    const richBlocks = blocks as ProblemAreaBlock[];
    if (args.area !== "lead") {
      let insertionTargetId: string | null = null;
      if (targetId !== problem.id) {
        // Confirm that the requested target belongs to the requested problem
        // area. The real proposal remains a sequence of additive insertAfter
        // operations so later edits elsewhere in the Problem cannot make it a
        // whole-Problem replacement conflict.
        let insertionDocument = session.draftDocument;
        let simulatedTargetId = targetId;
        let insertedNearTarget = true;
        for (const block of richBlocks) {
          const inserted = insertRichBlockNearSelection(insertionDocument, simulatedTargetId, block);
          if (!inserted) {
            insertedNearTarget = false;
            break;
          }
          insertionDocument = inserted;
          simulatedTargetId = block.id;
        }
        if (insertedNearTarget) {
          const insertedProblem = findContainingProblem(insertionDocument, simulatedTargetId);
          const insertedIds = new Set(richBlocks.map((block) => block.id));
          if (
            insertedProblem?.id === problem.id
            && insertedProblem[args.area].some((block) => insertedIds.has(block.id))
          ) {
            insertionTargetId = targetId;
          }
        }
      }
      insertionTargetId ??= problem[args.area].at(-1)?.id ?? null;
      if (insertionTargetId) {
        const area = args.area;
        let nextTargetId = insertionTargetId;
        const operations = richBlocks.map((block): AiEditDraft => {
          const operation: AiEditDraft = {
            operation: "insertAfter",
            summary: tv("tools.draftInsertBodyContent4", { p0: problemAreaLabel(area) }),
            targetId: nextTargetId,
            insertedBlock: block,
          };
          nextTargetId = block.id;
          return operation;
        });
        return commitOperations(
          session,
          operations,
          blocks.map((block) => block.id),
          tv("tools.draftInsertBodyContent5", { p0: problemAreaLabel(args.area) }),
        );
      }
    }

    // For an empty area, the first block has no nested anchor and must be
    // materialized through the containing Problem; subsequent inserts can use
    // insertAfter.
    const nextAreaBlocks = [...problem[args.area], ...richBlocks];
    const replacementBlock: ProblemNode = normalizeProblemMath({
      ...problem,
      [args.area]: nextAreaBlocks,
    });
    return commitOperation(session, {
      operation: "replace",
      summary: tv("tools.draftInsertBodyContent6", { p0: problemAreaLabel(args.area) }),
      targetId: problem.id,
      replacementBlock,
    }, [problem.id, ...blocks.map((block) => block.id)]);
  }

  let insertTargetId = targetId;
  const changedIds: string[] = [];
  for (const block of blocks) {
    commitOperation(session, {
      operation: "insertAfter",
      summary: block.type === "heading" ? tv("tools.draftInsertBodyContent7") : block.type === "boxBlock" ? tv("tools.draftInsertBodyContent8") : tv("tools.draftInsertBodyContent9"),
      targetId: insertTargetId,
      insertedBlock: block,
    }, [block.id]);
    changedIds.push(block.id);
    insertTargetId = block.id;
  }

  return createToolResult(session, true, tv("tools.draftInsertBodyContent10", { p0: blocks.length }), changedIds, {
    insertedIds: changedIds,
  });
}

function draftUpdateRichContent(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftUpdateRichContentArgsSchema.parse(rawArgs);
  const targetId = getTargetId(session, args.targetId);
  const current = findBlock(session.draftDocument, targetId);
  if (!current) {
    throw new Error(tv("tools.draftUpdateRichContent1", { p0: targetId }));
  }
  if (current.type !== "paragraph" && current.type !== "heading") {
    throw new Error(tv("tools.draftUpdateRichContent2"));
  }

  const hasContentUpdate = args.text !== undefined || args.runs !== undefined;
  const normalized = hasContentUpdate
    ? normalizeAiRichBlockInput({
        type: current.type,
        id: current.id,
        ...(args.text === undefined ? {} : { text: args.text }),
        ...(args.runs === undefined ? {} : { runs: args.runs }),
      }, "ai_update", 0)
    : current;
  if (normalized.type !== current.type) {
    throw new Error(tv("tools.draftUpdateRichContent3"));
  }
  const replacementBlockInput = {
    ...current,
    children: hasContentUpdate
      ? reconcileInlineNodeReplacement(current.children, normalized.children)
      : normalized.children,
  };
  if (args.pagination !== undefined) {
    const pagination = normalizePaginationInput(args.pagination);
    if (pagination) {
      replacementBlockInput.pagination = pagination;
    } else {
      delete replacementBlockInput.pagination;
    }
  }
  const replacementBlock = normalizeRichBlockMath(replacementBlockInput);
  assertTypedMathRunsPreserved(args.runs, replacementBlock.children);

  return commitOperation(session, {
    operation: "replace",
    summary: current.type === "heading" ? tv("tools.draftUpdateRichContent4") : tv("tools.draftUpdateRichContent5"),
    targetId,
    replacementBlock,
  }, [targetId]);
}

/**
 * A typed `{type:"math", tex}` run is an explicit request for a SigmaDoc
 * mathInline node. Keep this as a runtime invariant in addition to schema
 * tests so a future normalizer refactor cannot silently flatten math to text
 * and still create an apparently successful proposal.
 */
function assertTypedMathRunsPreserved(
  runs: Array<string | Record<string, unknown>> | undefined,
  children: InlineNode[],
): void {
  if (!runs) {
    return;
  }
  const expected = runs.flatMap((run) => {
    if (
      !isRecord(run)
      || (run.type !== "math" && run.type !== "mathInline" && typeof run.tex !== "string")
      || typeof run.tex !== "string"
    ) {
      return [];
    }
    return [{
      id: typeof run.id === "string" && run.id.trim().length > 0 ? run.id.trim() : null,
      tex: normalizeLikelyAiMathNewlines(run.tex),
    }];
  });
  if (expected.length === 0) {
    return;
  }

  const unmatched = children
    .filter((child): child is Extract<InlineNode, { type: "mathInline" }> => child.type === "mathInline")
    .map((child) => ({ id: child.id, tex: child.tex }));
  for (const requested of expected) {
    const matchIndex = unmatched.findIndex((actual) => (
      requested.id ? actual.id === requested.id && actual.tex === requested.tex : actual.tex === requested.tex
    ));
    if (matchIndex < 0) {
      throw new Error(
        tv("tools.assertTypedMathRunsPreserved1", { p0: requested.id ?? tv("tools.unspecifiedId"), p1: requested.tex }),
      );
    }
    unmatched.splice(matchIndex, 1);
  }
}

/**
 * Replaces an existing block (body paragraph/heading/list/problem/etc.) in place with a new
 * definition of the same id and type. Reuses the existing "replace" AiEditDraft path (via
 * commitOperation), so it gets the same type-match guard and MathLive TeX validation as every
 * other replace-family draft tool (draft_update_problem_content, etc.) for free.
 */
function draftUpdateBlock(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftUpdateBlockArgsSchema.parse(rawArgs);
  const targetId = getTargetId(session, args.targetId);
  if (!findBlock(session.draftDocument, targetId)) {
    throw new Error(tv("tools.draftUpdateBlock1", { p0: targetId }));
  }

  return commitOperation(session, {
    operation: "replace",
    summary: tv("tools.draftUpdateBlock2"),
    targetId,
    replacementBlock: args.block,
  }, [targetId]);
}

function draftCreateProblemContent(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftCreateProblemContentArgsSchema.parse(rawArgs);
  if (session.draftDocument.pageLayout && isWhiteboardPageLayout(session.draftDocument.pageLayout)) {
    throw new Error(tv("tools.whiteboardBodyInsertionUnsupported"));
  }
  const targetId = getTopLevelInsertTargetId(session, getTargetId(session, args.targetId));
  const problem = ensureUniqueProblemForInsert(session, createProblemNodeFromContentArgs(args));
  assertProblemDoesNotContainVariationTableArray(problem);

  return commitOperation(session, {
    operation: "insertAfter",
    summary: tv("tools.draftCreateProblemContent1"),
    targetId,
    insertedBlock: problem,
  }, [problem.id]);
}

function draftUpdateProblemSolution(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftUpdateProblemSolutionArgsSchema.parse(rawArgs);
  const targetId = getTargetId(session, args.targetId);
  const problem = findContainingProblem(session.draftDocument, targetId);
  if (!problem) {
    throw new Error(tv("tools.draftUpdateProblemSolution1"));
  }

  const answerWasSpecified = args.answer !== undefined || args.answerText !== undefined || args.answerTex !== undefined;
  const answer = normalizeAnswerDefinition(args.answer, args.answerText, args.answerTex);
  const takenIds = createTakenIdAllocator(session);
  const replacementSource: ProblemNode = {
    ...problem,
    ...(args.lead === undefined ? {} : {
      lead: ensureUniqueRichBlocksWithAllocator(
        normalizeAiRichBlockList(args.lead, "ai_lead").slice(0, 1),
        takenIds,
      ),
    }),
    ...(args.prompt === undefined ? {} : {
      prompt: ensureUniqueRichBlocksWithAllocator(
        normalizeAiRichBlockList(args.prompt, "ai_prompt"),
        takenIds,
      ),
    }),
    ...(args.solution === undefined ? {} : {
      solution: ensureUniqueRichBlocksWithAllocator(
        normalizeAiRichBlockList(args.solution, "ai_solution"),
        takenIds,
      ),
    }),
    ...(args.hints === undefined ? {} : {
      hints: ensureUniqueRichBlocksWithAllocator(
        normalizeAiRichBlockList(args.hints, "ai_hint"),
        takenIds,
      ),
    }),
  };
  if (args.pagination !== undefined) {
    const pagination = normalizePaginationInput(args.pagination);
    if (pagination) {
      replacementSource.pagination = pagination;
    } else {
      delete replacementSource.pagination;
    }
  }
  if (answerWasSpecified) {
    if (answer === undefined) {
      delete replacementSource.answer;
    } else {
      replacementSource.answer = answer;
    }
  }
  const replacementBlock: ProblemNode = normalizeProblemMath(replacementSource);
  assertProblemDoesNotContainVariationTableArray(replacementBlock);

  return commitOperation(session, {
    operation: "replace",
    summary: tv("tools.draftUpdateProblemSolution2"),
    targetId: problem.id,
    replacementBlock,
  }, [problem.id]);
}

function draftInsertTable(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftInsertTableArgsSchema.parse(rawArgs);

  // Validate placement anchorBlockId if placement is specified
  if (args.placement) {
    const anchorBlock = findBlock(session.draftDocument, args.placement.anchorBlockId);
    if (!anchorBlock) {
      throw new Error(tv("tools.draftInsertTable1", { p0: args.placement.anchorBlockId }));
    }
  }

  const target = resolveOverlayInsertionTarget(session, args.targetId, args.area);
  const isVariationTemplateRequest = args.kind === "variation" && !args.table && !args.cells && !args.rows;
  const isSemanticVariationTable = !args.table && (isVariationTemplateRequest || hasVariationTableSemanticArgs(args));
  const table = args.table ?? (isSemanticVariationTable ? createVariationTableSpecFromToolArgs(args) : createTableSpecFromToolArgs(args));
  const canvasDefault = target.targetId === "CANVAS" ? { x: 320, y: 240 } : {};
  const placed = resolveAiOverlayPlacement({
    document: session.draftDocument,
    anchorBlockId: target.targetId,
    x: args.x ?? canvasDefault.x,
    y: args.y ?? canvasDefault.y,
    ...(args.placement ? { placement: args.placement } : {}),
    ...(args.reserveSpace === undefined ? {} : { reserveSpace: args.reserveSpace }),
  });
  const shape: OverlayTableShape = ensureUniqueOverlayShapeId(session, {
    id: args.id ?? createId("ai_table"),
    type: "tableShape",
    x: placed.x,
    y: placed.y,
    rotation: 0,
    anchor: placed.anchor,
    props: {
      w: args.w ?? getDefaultAiTableShapeWidth(table),
      h: args.h ?? getDefaultAiTableShapeHeight(table),
      table,
    },
  });

  return commitOperations(session, [...target.preOperations, {
    operation: "insertTableShape",
    summary: isSemanticVariationTable ? tv("tools.draftInsertTable2") : tv("tools.draftInsertTable3"),
    targetId: target.targetId,
    tableShape: shape,
  }], [...target.changedIds, shape.id], isSemanticVariationTable ? tv("tools.draftInsertTable4") : tv("tools.draftInsertTable5"));
}

/**
 * Builds a SigmaTableSpec from AI tool args, optionally inheriting column widths/row heights/
 * grid/defaultCellStyle from `baseTable` for any index the caller did not explicitly specify.
 * Used by update_table's content-mode rebuild (core.ts) so a partial content edit (e.g. only
 * `cells`) does not reset a user's manual column-width/row-height resize back to auto/fr
 * defaults — mirrors update_graph's merge-into-existing-spec approach. `insert_table` never
 * passes `baseTable`, so its behavior (hard-coded defaults) is unchanged.
 */
export function createTableSpecFromAiToolArgs(rawArgs: Record<string, unknown>, baseTable?: SigmaTableSpec): SigmaTableSpec {
  const args = DraftInsertTableArgsSchema.parse(rawArgs);
  const isVariationTemplateRequest = args.kind === "variation" && !args.table && !args.cells && !args.rows;
  const isSemanticVariationTable = !args.table && (isVariationTemplateRequest || hasVariationTableSemanticArgs(args));
  return args.table ?? (isSemanticVariationTable
    ? createVariationTableSpecFromToolArgs(args, baseTable)
    : createTableSpecFromToolArgs(args, baseTable));
}

/**
 * Normalizes a single cell-content AI tool input (string/number/null or the structured cell
 * object) into `SigmaTableCellContent[]` for the given table kind. Exported so update_table's
 * `cellPatches` (core.ts) can turn one patch's `content` into the same shape the full-rebuild
 * path (`createTableCell`) produces, without going through a full table rebuild.
 */
export function createTableCellContentFromAiInput(
  input: unknown,
  kind: SigmaTableKind,
): SigmaTableCellContent[] {
  return normalizeTableCellContent(input as z.infer<typeof AiTableCellInputSchema>, kind);
}

export interface AiTableCellPatch {
  row: number;
  col: number;
  content?: unknown;
}

/**
 * Applies `cellPatches` (update_table, core.ts) to an EXISTING table spec by replacing only the
 * targeted cells' `content` — columns/rows/grid/defaultCellStyle and every other cell are left
 * byte-for-byte untouched. This is the granular alternative to a full content-mode rebuild, and
 * is what lets a single-cell AI edit preserve a user's manual column-width/row-height resize
 * with zero risk (no rebuild happens at all). Cells are matched by rowId/columnId at the given
 * row/col index; an out-of-range row/col throws a Japanese error.
 */
export function applyAiTableCellPatches(table: SigmaTableSpec, patches: AiTableCellPatch[]): SigmaTableSpec {
  let cells = table.cells;
  for (const patch of patches) {
    // undefined content would normalize to an empty paragraph = silent wipe. Require the caller
    // to be explicit (the MCP schema already makes content required; this guards the exported
    // helper / any direct caller). Clearing a cell is still possible via null / "".
    if (patch.content === undefined) {
      throw new Error(
        tv("tools.applyAiTableCellPatches1", { p0: patch.row, p1: patch.col }),
      );
    }
    const row = table.rows[patch.row];
    const column = table.columns[patch.col];
    if (!row || !column) {
      throw new Error(
        tv("tools.applyAiTableCellPatches2", { p0: patch.row, p1: patch.col, p2: table.rows.length, p3: table.columns.length }),
      );
    }
    const cellIndex = cells.findIndex((cell) => cell.rowId === row.id && cell.columnId === column.id);
    if (cellIndex === -1) {
      // row/colは範囲内なのにセルが無い = 別セルのrowSpan/colSpanに覆われた位置。個別更新はできない。
      throw new Error(tv("tools.applyAiTableCellPatches3", { p0: patch.row, p1: patch.col }));
    }
    const content = createTableCellContentFromAiInput(patch.content, table.kind);
    cells = cells.map((cell, index) => (index === cellIndex ? { ...cell, content } : cell));
  }
  return { ...table, cells };
}

/** Style-only fields update_table can merge onto an EXISTING table without rebuilding content. */
export interface AiTableStyleMerge {
  grid?: unknown;
  defaultCellStyle?: unknown;
  kind?: SigmaTableKind;
}

/**
 * Merges only the supplied grid / defaultCellStyle / kind onto an existing table spec, leaving
 * columns/rows/cells untouched. Used by update_table when the caller gives ONLY style/kind (and/or
 * cellPatches) but no cell content — previously such a call went through the full content rebuild
 * with an empty matrix and collapsed the table to a single empty 1×1 cell. grid/defaultCellStyle
 * are merged field-by-field against the existing values (same as the content-rebuild inheritance).
 */
export function mergeAiTableStyle(table: SigmaTableSpec, changes: AiTableStyleMerge): SigmaTableSpec {
  return {
    ...table,
    ...(changes.kind === undefined ? {} : { kind: changes.kind }),
    ...(changes.grid === undefined ? {} : { grid: normalizeTableGridStyle(changes.grid, table.grid) }),
    ...(changes.defaultCellStyle === undefined
      ? {}
      : { defaultCellStyle: normalizeTableCellStyle(changes.defaultCellStyle, false, table.defaultCellStyle) }),
  };
}

/** AI tool geometry inputs for update_shape, expressed in ABSOLUTE anchor/page coordinates
 * (the SAME convention as insert_shape's `points`/`start`/`end`). */
export interface AiShapeGeometryInput {
  points?: OverlayPoint[];
  closed?: boolean;
  start?: OverlayPoint;
  end?: OverlayPoint;
}

/** The origin-normalized geometry portion of an updateOverlayShape patch. */
export interface AiShapeGeometryPatch {
  x?: number;
  y?: number;
  anchor?: OverlayAnchor;
  props: Record<string, unknown>;
}

// When update_shape moves a line/arrow's origin, recompute the BLOCK anchor by DELTA from the
// shape's OLD position, preserving the render invariant (resolveShapeY = blockTop + anchor.dy,
// resolveX = blockLeft + anchor.dx; see features/drawing/anchor-position.ts). In a saved doc anchor.dy =
// shape.y - blockTop (NOT the absolute y), so overwriting dy with the absolute origin.y would
// drop the shape by blockTop on the next render. shape.y/x and the AI's absolute newOrigin are in
// the same page-coordinate frame, so shifting dx/dy by (newOrigin - shape.position) keeps the
// block-relative offset correct: position is PRESERVED when the AI echoes the origin unchanged and
// moves by exactly the delta otherwise. No clamping anywhere: insert-time placement goes through
// resolveAiOverlayPlacement (lib/ai/ai-overlay-placement.ts), which is likewise clamp-free, so the
// insert and update paths share one coordinate contract — a clamp would itself shift the shape.
// dx is optional on a block anchor; when absent, resolveX falls back to shape.x, so we leave it
// absent (setting it would reintroduce the blockLeft offset). Only block anchors carry an origin
// offset; page/shape anchors (and non-block) are left untouched.
function recomputeBlockAnchorForMovedOrigin(
  shape: Pick<OverlayShape, "x" | "y" | "anchor">,
  newOrigin: OverlayPoint,
): OverlayAnchor | undefined {
  const anchor = shape.anchor;
  if (anchor?.type !== "block") {
    return undefined;
  }
  return {
    ...anchor,
    dy: anchor.dy + (newOrigin.y - shape.y),
    ...(anchor.dx === undefined ? {} : { dx: anchor.dx + (newOrigin.x - shape.x) }),
  };
}

/**
 * Normalizes update_shape's ABSOLUTE line/arrow geometry inputs into the local-origin form the
 * shapes actually store — the SAME transform createOverlayShapeFromShapeToolArgs applies for
 * insert_shape, so an AI that supplies absolute coordinates gets identical positioning from both
 * tools (no double-offset). For a line: x/y become the first point, props.points become relative
 * to it. For an arrow: x/y become the (possibly reconstructed) absolute start, props.start
 * becomes {0,0} and props.end relative to start. The block anchor's origin is recomputed to
 * match. `closed` (line-only) passes through unchanged; when only `closed` is supplied (no
 * points), coords/anchor are left untouched. Assumes the caller has already validated that
 * points/closed target a line and start/end target an arrow.
 */
export function normalizeAiShapeGeometryPatch(shape: OverlayShape, input: AiShapeGeometryInput): AiShapeGeometryPatch {
  const patch: AiShapeGeometryPatch = { props: {} };

  if (shape.type === "line") {
    if (input.points && input.points.length >= 2) {
      const origin = input.points[0]!;
      patch.x = origin.x;
      patch.y = origin.y;
      patch.props.points = input.points.map((point) => ({ x: point.x - origin.x, y: point.y - origin.y }));
      const anchor = recomputeBlockAnchorForMovedOrigin(shape, origin);
      if (anchor) {
        patch.anchor = anchor;
      }
    }
    if (input.closed !== undefined) {
      patch.props.closed = input.closed;
    }
    return patch;
  }

  if (shape.type === "arrow" && (input.start !== undefined || input.end !== undefined)) {
    const existingAbsStart = { x: shape.x + shape.props.start.x, y: shape.y + shape.props.start.y };
    const existingAbsEnd = { x: shape.x + shape.props.end.x, y: shape.y + shape.props.end.y };
    const absStart = input.start ?? existingAbsStart;
    const absEnd = input.end ?? existingAbsEnd;
    patch.x = absStart.x;
    patch.y = absStart.y;
    patch.props.start = { x: 0, y: 0 };
    patch.props.end = { x: absEnd.x - absStart.x, y: absEnd.y - absStart.y };
    const anchor = recomputeBlockAnchorForMovedOrigin(shape, absStart);
    if (anchor) {
      patch.anchor = anchor;
    }
  }

  return patch;
}

function draftInsertShape(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftInsertShapeArgsSchema.parse(rawArgs);

  // Validate placement anchorBlockId if placement is specified
  if (args.placement) {
    const anchorBlock = findBlock(session.draftDocument, args.placement.anchorBlockId);
    if (!anchorBlock) {
      throw new Error(tv("tools.draftInsertShape1", { p0: args.placement.anchorBlockId }));
    }
  }

  const target = resolveOverlayInsertionTarget(session, args.targetId, args.area);

  const shape = ensureUniqueOverlayShapeId(session, createOverlayShapeFromShapeToolArgs(args, session.draftDocument, target.targetId));
  validateOverlayShapeWithAssets(shape, {});

  return commitOperations(session, [...target.preOperations, {
    operation: "insertOverlayShape",
    summary: tv("tools.draftInsertShape2"),
    targetId: target.targetId,
    overlayShape: shape,
    assets: {},
  }], [...target.changedIds, shape.id], tv("tools.draftInsertShape3"));
}

function draftInsertGraph(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftInsertGraphArgsSchema.parse(rawArgs);
  const target = resolveOverlayInsertionTarget(session, args.targetId, args.area);
  const spec = normalizeGraphSpec(args.spec ?? createGraphSpecFromToolArgs(args));
  const { shape, labelShapes } = ensureUniqueOverlayShapeSet(
    session,
    createGraphWithOwnedLabelsFromSpec(spec, session.draftDocument, target.targetId, args),
  );
  const shapes = [shape, ...labelShapes];
  validateGraphSpec(shape.props.spec, shape.id);
  validateOverlayShapesWithAssets(shapes, {});

  return commitOperations(session, [
    ...target.preOperations,
    {
      operation: "insertOverlayShape",
      summary: tv("tools.draftInsertGraph1"),
      targetId: target.targetId,
      overlayShape: shape,
      assets: {},
    },
    ...labelShapes.map((labelShape) => ({
      operation: "insertOverlayShape" as const,
      summary: tv("tools.draftInsertGraph2"),
      targetId: target.targetId,
      overlayShape: labelShape,
      assets: {},
    })),
  ], [...target.changedIds, ...shapes.map((item) => item.id)], shapes.length > 1 ? tv("tools.draftInsertGraph3") : tv("tools.draftInsertGraph4"));
}

export function createGraphSpecFromAiToolArgs(rawArgs: Record<string, unknown>): Graph2DSpec {
  const args = DraftInsertGraphArgsSchema.parse(rawArgs);
  return normalizeGraphSpec(args.spec ?? createGraphSpecFromToolArgs(args));
}

/** ドラッグ作成 (`overlay-canvas/shapes/create-shape.ts`) と同じ既定サイズ。 */
const DEFAULT_GRAPH3D_SHAPE_W = 360;
const DEFAULT_GRAPH3D_SHAPE_H = 280;
const GRAPH3D_SPEC_ARRAY_KEYS = ["parameters", "objects", "regions", "annotations"] as const;
/** `findGraph3DSpecIssuePath` が camera と view を切り分けるための既知の正しい view。 */
const GRAPH3D_PROBE_VIEW: Graph3DViewSettings = {
  coordinateSystem: "zUp",
  showAxes: true,
  showGrid: true,
  backgroundColor: "#ffffff",
};

export interface Graph3DSpecToolArgs {
  spec?: Record<string, unknown>;
  parameters?: unknown[];
  objects?: unknown[];
  regions?: unknown[];
  annotations?: unknown[];
  camera?: Record<string, unknown>;
  view?: Record<string, unknown>;
}

export interface Graph3DSpecBuildOptions {
  /**
   * 土台の `cuts` をそのまま持ち越すか。
   *
   * `cuts` は永続化されるが `buildGraph3DSceneGeometry` が一切ビルドしない
   * (`features/drawing/graph3d-scene.ts`) ため、ツールの入力語彙には出していない。新規作成では
   * 常に空で確定させるが (`false`)、更新では**土台にあったものを残す** (`true`) —
   * ツールが理解していないだけのデータを、無関係な更新のついでに黙って消してはいけない。
   */
  preserveCuts: boolean;
}

/**
 * `preset` / 既存 spec を土台に、ツール引数で指定された部分だけを差し替えた `Graph3DSpec` を作る。
 *
 * - `spec` は「描かれる部分の丸ごと差し替え」、個別 field はその上に重なる細かい差し替え。
 * - **配列 (`objects` など) は置換であって追加ではない**。id ベースの差分マージは「未知 id は
 *   追加か更新か」「削除の表し方」で仕様が発散するため採らない。
 * - `camera` / `view` だけは**浅くマージ**する。視点を1軸だけ動かす指示が、残りの視点情報を
 *   書き直させずに済むのがこの2つだけだから。
 */
export function buildGraph3DSpecFromToolArgs(
  base: Graph3DSpec,
  args: Graph3DSpecToolArgs,
  options: Graph3DSpecBuildOptions = { preserveCuts: false },
): Graph3DSpec {
  const source: Record<string, unknown> = { ...base, ...(args.spec ?? {}) };
  const next: Record<string, unknown> = {
    version: 1,
    parameters: args.parameters ?? source.parameters,
    objects: args.objects ?? source.objects,
    cuts: options.preserveCuts ? base.cuts : [],
    regions: args.regions ?? source.regions,
    annotations: args.annotations ?? source.annotations,
    camera: { ...(isRecord(source.camera) ? source.camera : {}), ...(args.camera ?? {}) },
    view: { ...(isRecord(source.view) ? source.view : {}), ...(args.view ?? {}) },
  };

  if (!isGraph3DSpec(next)) {
    throw new Error(tv("tools.buildGraph3DSpec1", { p0: findGraph3DSpecIssuePath(next) }));
  }
  return next;
}

/**
 * `isGraph3DSpec` は真偽しか返さないので、AI が自己修正できるようにフィールドパスを復元する。
 * 空の骨組みへ 1 件ずつ差し戻して、最初に落ちた位置を報告する。
 */
function findGraph3DSpecIssuePath(spec: Record<string, unknown>): string {
  const skeleton: Record<string, unknown> = {
    ...spec,
    parameters: [],
    objects: [],
    cuts: [],
    regions: [],
    annotations: [],
  };
  if (!isGraph3DSpec(skeleton)) {
    // 片方ずつ既知の正しい値へ差し替えて、どちらが原因かを個別に確かめる。両方壊れているときに
    // 片方だけ挙げると、モデルはそこを直して同じエラーで戻ってくる (このヘルパが防ぐはずのループ)。
    const cameraBroken = !isGraph3DSpec({ ...skeleton, view: GRAPH3D_PROBE_VIEW });
    const viewBroken = !isGraph3DSpec({ ...skeleton, camera: GRAPH3D_DEFAULT_CAMERA });
    if (cameraBroken && viewBroken) {
      return "camera, view";
    }
    return cameraBroken ? "camera" : "view";
  }
  for (const key of GRAPH3D_SPEC_ARRAY_KEYS) {
    const items = spec[key];
    if (!Array.isArray(items)) {
      return key;
    }
    const index = items.findIndex((item) => !isGraph3DSpec({ ...skeleton, [key]: [item] }));
    if (index >= 0) {
      return `${key}[${index}]`;
    }
  }
  return "spec";
}

/**
 * プリセット名は MCP サーバープロセスでも正しい言語で引ける唯一の入口を通す。
 * `createCurrentLocaleTranslator` は node で常に既定ロケールを返すので使わない。
 */
function getGraph3DShapeTranslator(): Translate<"shape"> {
  return createTranslator(resolveValidationLocale(), "shape");
}

function createGraph3DShapeFromSpec(
  spec: Graph3DSpec,
  document: SigmaDocument,
  targetId: string,
  args: { id?: string; x?: number; y?: number; w?: number; h?: number },
): OverlayGraph3DShape {
  const placed = resolveAiOverlayPlacement({
    document,
    anchorBlockId: targetId,
    ...(args.x === undefined ? {} : { x: args.x }),
    ...(args.y === undefined ? {} : { y: args.y }),
  });
  return {
    id: args.id ?? createId("ai_graph3d"),
    type: "graph3dShape",
    x: placed.x,
    y: placed.y,
    rotation: 0,
    anchor: placed.anchor,
    props: {
      w: args.w ?? DEFAULT_GRAPH3D_SHAPE_W,
      h: args.h ?? DEFAULT_GRAPH3D_SHAPE_H,
      spec,
    },
  };
}

/**
 * ヘッドレスに描かれた派生 PNG を overlay asset にする。
 * asset id を図形 id から決め打ちにするのは、アプリ側の WebGL キャプチャ
 * (`OverlayCanvasEditorClient` の `handleGraph3DPreviewReady`) と同じ規約に乗せて、
 * 上書きのたびに孤児 asset が増えないようにするため。
 */
const GRAPH3D_PREVIEW_PNG_DATA_URL_PREFIX = "data:image/png;base64,";

function createGraph3DPreviewAsset(
  shapeId: string,
  // `w` / `h` は**実際に描かれたビットマップの寸法**で、図形の文書上のサイズではない
  // (拡大・印刷で滲まないよう supersample するため)。渡すのはサーバ側のレンダラであって
  // モデルではない — この引数は MCP のツールスキーマには出ない。
  previewPng: { dataUrl: string; w: number; h: number; fileSize?: number },
): OverlayAsset {
  const dataUrl = previewPng.dataUrl.trim();
  // 同じ判定は提案を書き出す直前にも文書全体へ掛かる (`assertAiOverlayAssetsInDocument`) が、
  // そこで落とすと「ツールはokと言ったのに提案が失敗する」になる。asset を組み立てている
  // ここで拒むのが、どの入力が悪かったかを呼び出し側へ返せる唯一の場所。
  // 加えて PNG に限定する — 共通ゲートは jpeg / webp / storage 参照も通すが、下で mimeType を
  // "image/png" と書くので、そこを通してしまうと文書に嘘の mimeType が残る。
  if (!dataUrl.startsWith(GRAPH3D_PREVIEW_PNG_DATA_URL_PREFIX) || !isAllowedAiOverlayAssetSource(dataUrl)) {
    throw new Error(tv("tools.createGraph3DPreviewAsset1"));
  }
  const encoded = dataUrl.split(",")[1] ?? "";
  return {
    id: `asset_graph3d_preview_${shapeId}`,
    type: "image",
    props: {
      w: Math.max(1, Math.round(previewPng.w)),
      h: Math.max(1, Math.round(previewPng.h)),
      name: getGraph3DShapeTranslator()("graph3d.previewFileName"),
      isAnimated: false,
      mimeType: "image/png",
      src: dataUrl,
      fileSize: previewPng.fileSize ?? Math.max(0, Math.floor(encoded.length * 0.75)),
    },
  };
}

/**
 * issue 検出用のサンプル密度の係数。`createGraph3DSampledSpec` の下限
 * (解像度10 / サンプル6) まで落としきる小さい値を選ぶ。
 *
 * 式の誤りは密度に依らず最初の評価で出るので、検出には粗いサンプルで足りる。一方で
 * marching cubes は解像度の3乗で効き、実測では解像度256の `boundedSolid` 1個で約1.8秒、
 * 4個で約7.6秒、64個 (スキーマ上限) ではヒープが尽きてプロセスごと落ちる。
 * ここは stdio の MCP リクエスト内で同期に走るので、authored の密度をそのまま使ってはいけない。
 */
const GRAPH3D_ISSUE_PROBE_SAMPLE_FACTOR = 0.05;
/**
 * `createGraph3DSampledSpec` は `primitive` の分割数を **factor > 1 のときしか書き換えない**
 * (1個のリングは marched solid に比べて無視できる、という前提)。ところが上限どうしを掛けると
 * 64個 × 分割数256 で 1GB 級のピークメモリになるので、検査用のサンプルではここも落とす。
 */
const GRAPH3D_ISSUE_PROBE_PRIMITIVE_RESOLUTION = 8;

/** authored の密度を一切変えずに、検査だけを固定の粗いサンプルで走らせるための spec。 */
function createGraph3DIssueProbeSpec(spec: Graph3DSpec): Graph3DSpec {
  const sampled = createGraph3DSampledSpec(spec, GRAPH3D_ISSUE_PROBE_SAMPLE_FACTOR);
  return {
    ...sampled,
    objects: sampled.objects.map((object) => (
      object.kind === "primitive" && (object.resolution ?? 0) > GRAPH3D_ISSUE_PROBE_PRIMITIVE_RESOLUTION
        ? { ...object, resolution: GRAPH3D_ISSUE_PROBE_PRIMITIVE_RESOLUTION }
        : object
    )),
  };
}

/**
 * 共通部分のメンバーが2個そろっていない region の id。
 *
 * 配列は丸ごと置換なので、`objects` だけ差し替えると preset 由来の region が消えた id を
 * 指したまま残る。`graph3d-scene.ts` はそれを `members.length < 2` で**黙って捨てる**ので、
 * ここで返さないとモデルには「regionCount は5なのに何も描かれない」としか見えない。
 */
function findUnresolvedGraph3DRegionIds(spec: Graph3DSpec): string[] {
  const objectIds = new Set(spec.objects.map((object) => object.id));
  return spec.regions
    .filter((region) => (
      region.kind === "objectIntersection" &&
      region.objectIds.filter((objectId) => objectIds.has(objectId)).length < 2
    ))
    .map((region) => region.id);
}

/**
 * 式の誤りは永続化エラーにしない (`features/document/model/graph3d.ts` の設計方針) ため、
 * ビルド時の issue を結果データで返すのが「描く前にモデルへ知らせる」唯一の経路になる。
 */
function describeGraph3DSpec(spec: Graph3DSpec): Record<string, unknown> {
  return {
    objectCount: spec.objects.length,
    regionCount: spec.regions.length,
    unresolvedRegionIds: findUnresolvedGraph3DRegionIds(spec),
    sceneIssues: buildGraph3DSceneGeometry(createGraph3DIssueProbeSpec(spec)).issues,
  };
}

/** 図とその描画サイズ。派生 PNG を作る側 (MCP 層) が、draft を走らせる前に必要とする一式。 */
export interface Graph3DPreviewRenderTarget {
  spec: Graph3DSpec;
  width: number;
  height: number;
}

function resolveGraph3DInsertSpec(args: z.infer<typeof DraftInsertGraph3DArgsSchema>): Graph3DSpec {
  const base = createGraph3DSpecPreset(args.preset ?? "blank", buildGraph3DPresetNames(getGraph3DShapeTranslator()));
  return buildGraph3DSpecFromToolArgs(base, args, { preserveCuts: false });
}

/**
 * `draft_insert_graph3d` がこれから書く図と、その箱の大きさ。
 *
 * 派生 PNG は WebGL の無いプロセスで描くので時間がかかり、draft 層は同期のまま保ちたい。
 * そこで「何を描くか」だけを先に同じコードで解いておき、絵は呼び出し側が非同期に作って
 * `previewPng` として渡す。組み立てを二重に書かないためにここを共有する。
 */
export function resolveGraph3DInsertPreviewTarget(rawArgs: Record<string, unknown>): Graph3DPreviewRenderTarget {
  const args = DraftInsertGraph3DArgsSchema.parse(rawArgs);
  return {
    spec: resolveGraph3DInsertSpec(args),
    width: args.w ?? DEFAULT_GRAPH3D_SHAPE_W,
    height: args.h ?? DEFAULT_GRAPH3D_SHAPE_H,
  };
}

interface Graph3DUpdatePlan {
  shape: OverlayGraph3DShape;
  spec: Graph3DSpec;
  /** 図の中身が変わるか。偽なら w/h だけの更新で、既存の絵はそのまま正しい。 */
  changesSpec: boolean;
}

function planGraph3DUpdate(
  document: SigmaDocument,
  args: z.infer<typeof DraftUpdateGraph3DArgsSchema>,
): Graph3DUpdatePlan {
  const snapshot = normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot);
  const shape = snapshot.shapes.find((item) => item.id === args.shapeId);
  if (!shape) {
    throw new Error(tv("tools.draftUpdateGraph3D1", { p0: args.shapeId }));
  }
  if (shape.type !== "graph3dShape") {
    throw new Error(tv("tools.draftUpdateGraph3D2", { p0: shape.type }));
  }

  const changesSpec = args.spec !== undefined
    || args.preset !== undefined
    || GRAPH3D_SPEC_ARRAY_KEYS.some((key) => args[key] !== undefined)
    || args.camera !== undefined
    || args.view !== undefined;
  if (!changesSpec && args.w === undefined && args.h === undefined) {
    throw new Error(tv("tools.draftUpdateGraph3D4"));
  }

  const base = args.preset
    ? createGraph3DSpecPreset(args.preset, buildGraph3DPresetNames(getGraph3DShapeTranslator()))
    : shape.props.spec;
  // spec に触らない更新 (w/h だけ) で組み直さないのが重要。`getGraph3DPreviewSourceHash` は
  // `JSON.stringify` なのでキー順まで見る — 内容が同じでも組み直せばハッシュが変わり、
  // 最新のプレビューが「更新待ち」に化ける。
  return {
    shape,
    changesSpec,
    spec: changesSpec
      ? buildGraph3DSpecFromToolArgs(base, args, { preserveCuts: true })
      : shape.props.spec,
  };
}

/**
 * `draft_update_graph3d` がこれから書く図と箱の大きさ。描き直す絵が無いなら `null`。
 *
 * 更新できない入力 (対象が無い・graph3dShape でない・何も変えない) もここでは `null` を返す。
 * 絵が作れないことは更新の失敗ではなく、本当のエラーは直後の draft 実行が同じ判定で返すため、
 * ここで投げると同じ失敗を二度別の言葉で報告することになる。
 */
export function resolveGraph3DUpdatePreviewTarget(
  document: SigmaDocument,
  rawArgs: Record<string, unknown>,
): Graph3DPreviewRenderTarget | null {
  try {
    const args = DraftUpdateGraph3DArgsSchema.parse(rawArgs);
    const plan = planGraph3DUpdate(document, args);
    if (!plan.changesSpec) {
      return null;
    }
    return {
      spec: plan.spec,
      width: args.w ?? plan.shape.props.w,
      height: args.h ?? plan.shape.props.h,
    };
  } catch {
    return null;
  }
}

function draftInsertGraph3D(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftInsertGraph3DArgsSchema.parse(rawArgs);
  const target = resolveOverlayInsertionTarget(session, args.targetId, args.area);
  const spec = resolveGraph3DInsertSpec(args);
  const placedShape = ensureUniqueOverlayShapeId(
    session,
    createGraph3DShapeFromSpec(spec, session.draftDocument, target.targetId, args),
  );
  const previewAsset = args.previewPng ? createGraph3DPreviewAsset(placedShape.id, args.previewPng) : null;
  const shape: OverlayGraph3DShape = previewAsset
    ? {
      ...placedShape,
      props: {
        ...placedShape.props,
        previewAssetId: previewAsset.id,
        // ハッシュを省くと、エディタを持たない公開ビューアに「プレビュー更新待ち」バッジが
        // 恒久的に出る (`shape-renderer.tsx` の previewStale 判定)。
        previewSourceHash: getGraph3DPreviewSourceHash(spec),
      },
    }
    : placedShape;
  const assets = previewAsset ? { [previewAsset.id]: previewAsset } : {};
  validateOverlayShapeWithAssets(shape, assets);

  return commitOperations(session, [...target.preOperations, {
    operation: "insertOverlayShape",
    summary: tv("tools.draftInsertGraph3D1"),
    targetId: target.targetId,
    overlayShape: shape,
    assets,
  }], [...target.changedIds, shape.id, ...(previewAsset ? [previewAsset.id] : [])], tv("tools.draftInsertGraph3D2"), {
    ...describeGraph3DSpec(spec),
    preview: { source: previewAsset ? "provided" : "none" },
  });
}

function draftUpdateGraph3D(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftUpdateGraph3DArgsSchema.parse(rawArgs);
  const { shape, spec, changesSpec } = planGraph3DUpdate(session.draftDocument, args);
  const previewAsset = args.previewPng ? createGraph3DPreviewAsset(shape.id, args.previewPng) : null;

  return commitSigmaDocMutation(session, {
    operation: "updateOverlayShape",
    summary: tv("tools.draftUpdateGraph3D3"),
    shapeId: shape.id,
    // `patchShape` は props を浅くマージするので、id / x / y / anchor と未指定の props は保持される。
    patch: {
      props: {
        ...(changesSpec ? { spec } : {}),
        ...(args.w === undefined ? {} : { w: args.w }),
        ...(args.h === undefined ? {} : { h: args.h }),
        // 描き直した図には描き直した絵を同じ操作で添える。別operationに分けると、片方だけが
        // 適用された瞬間に「新しいspecに古い絵」が文書へ残る。
        ...(previewAsset
          ? { previewAssetId: previewAsset.id, previewSourceHash: getGraph3DPreviewSourceHash(spec) }
          : {}),
      },
    },
    ...(previewAsset ? { assets: { [previewAsset.id]: previewAsset } } : {}),
  }, {
    ...describeGraph3DSpec(spec),
    preview: {
      source: previewAsset
        ? "provided"
        : shape.props.previewAssetId === undefined ? "none" : "unchanged",
    },
  });
}

function draftInsertTextBlock(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftInsertTextBlockArgsSchema.parse(rawArgs);
  const targetId = getTargetId(session, args.targetId);
  const block = normalizeRichBlockMath(args.block);
  assertRichBlocksDoNotContainVariationTableArray([block]);

  if (args.area) {
    const problem = findContainingProblem(session.draftDocument, targetId);
    if (!problem) {
      throw new Error(tv("tools.draftInsertTextBlock1"));
    }
    if (args.area !== "lead") {
      let insertionTargetId: string | null = null;
      if (targetId !== problem.id) {
        const inserted = insertRichBlockNearSelection(session.draftDocument, targetId, block);
        const insertedProblem = inserted ? findContainingProblem(inserted, block.id) : null;
        if (insertedProblem?.id === problem.id
          && insertedProblem[args.area].some((candidate) => candidate.id === block.id)) {
          insertionTargetId = targetId;
        }
      }
      insertionTargetId ??= problem[args.area].at(-1)?.id ?? null;
      if (insertionTargetId) {
        return commitOperation(session, {
          operation: "insertAfter",
          summary: tv("tools.draftInsertTextBlock2", { p0: problemAreaLabel(args.area) }),
          targetId: insertionTargetId,
          insertedBlock: block,
        }, [block.id]);
      }
    }
    const replacementBlock: ProblemNode = {
      ...problem,
      [args.area]: [...problem[args.area], block],
    };
    return commitOperation(session, {
      operation: "replace",
      summary: tv("tools.draftInsertTextBlock3", { p0: problemAreaLabel(args.area) }),
      targetId: problem.id,
      replacementBlock,
    }, [problem.id, block.id]);
  }

  return commitOperation(session, {
    operation: "insertAfter",
    summary: tv("tools.draftInsertTextBlock4"),
    targetId,
    insertedBlock: block,
  }, [block.id]);
}

function draftCreateProblem(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftCreateProblemArgsSchema.parse(rawArgs);
  const targetId = getTopLevelInsertTargetId(session, getTargetId(session, args.targetId));
  const problem = normalizeProblemMath(args.problem);
  assertProblemDoesNotContainVariationTableArray(problem);

  return commitOperation(session, {
    operation: "insertAfter",
    summary: tv("tools.draftCreateProblem1"),
    targetId,
    insertedBlock: problem,
  }, [problem.id]);
}

function draftUpdateProblemAnswer(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftUpdateProblemAnswerArgsSchema.parse(rawArgs);
  const targetId = getTargetId(session, args.targetId);
  const problem = findContainingProblem(session.draftDocument, targetId);
  if (!problem) {
    throw new Error(tv("tools.draftUpdateProblemAnswer1"));
  }

  const replacementBlock: ProblemNode = normalizeProblemMath({
    ...problem,
    ...(args.answer === undefined ? {} : { answer: args.answer }),
    ...(args.solution === undefined ? {} : { solution: args.solution }),
    ...(args.hints === undefined ? {} : { hints: args.hints }),
  });
  assertProblemDoesNotContainVariationTableArray(replacementBlock);

  return commitOperation(session, {
    operation: "replace",
    summary: tv("tools.draftUpdateProblemAnswer2"),
    targetId: problem.id,
    replacementBlock,
  }, [problem.id]);
}

function draftInsertOverlayShape(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftInsertOverlayShapeArgsSchema.parse(rawArgs);
  const target = resolveOverlayInsertionTarget(session, args.targetId, args.area);
  const shape = ensureUniqueOverlayShapeId(
    session,
    withDefaultBlockAnchor(args.shape, session.draftDocument, target.targetId, Boolean(args.area)),
  );
  validateOverlayShapeWithAssets(shape, args.assets);

  return commitOperations(session, [...target.preOperations, {
    operation: "insertOverlayShape",
    summary: tv("tools.draftInsertOverlayShape1"),
    targetId: target.targetId,
    overlayShape: shape,
    assets: args.assets,
  }], [...target.changedIds, shape.id, ...Object.keys(args.assets)], tv("tools.draftInsertOverlayShape2"));
}

function draftInsertMaterial(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftInsertMaterialArgsSchema.parse(rawArgs);
  const material = findMaterialById(session, args.materialId);
  const targetId = getTargetId(session, args.targetId);
  // 素材の内部相対配置は clone 側が保つので、ここでは原点だけを絶対ページ座標へ解決する。
  const origin = resolveAiOverlayPlacement({
    document: session.draftDocument,
    anchorBlockId: targetId,
    ...(args.x === undefined ? {} : { x: args.x }),
    ...(args.y === undefined ? {} : { y: args.y }),
  });
  const cloned = cloneMaterialContentForInsert(material.content, {
    origin: {
      x: origin.x,
      y: origin.y,
    },
    ...(args.scaleX === undefined ? {} : { scaleX: args.scaleX }),
    ...(args.scaleY === undefined ? {} : { scaleY: args.scaleY }),
    ...(args.rotation === undefined ? {} : { rotation: args.rotation }),
  });

  const operations: AiEditDraft[] = [];
  const changedIds: string[] = [];
  let shapeTargetId = targetId;

  if (args.area) {
    assertMaterialBlocksCanInsertIntoProblemArea(cloned.blocks);
    const problem = findContainingProblem(session.draftDocument, targetId);
    if (!problem) {
      throw new Error(tv("tools.draftInsertMaterial1"));
    }

    if (cloned.blocks.length > 0) {
      const areaBlocks = cloned.blocks as RichBlock[];
      const replacementBlock = normalizeProblemMath({
        ...problem,
        [args.area]: [...problem[args.area], ...areaBlocks],
      });
      operations.push({
        operation: "replace",
        summary: tv("tools.draftInsertMaterial2", { p0: material.name, p1: problemAreaLabel(args.area) }),
        targetId: problem.id,
        replacementBlock,
      });
      changedIds.push(problem.id, ...areaBlocks.map((block) => block.id));
      shapeTargetId = areaBlocks[0]?.id ?? problem.id;
    } else if (cloned.overlaySnapshot.shapes.length > 0) {
      const target = resolveOverlayInsertionTarget(session, args.targetId, args.area);
      operations.push(...target.preOperations);
      changedIds.push(...target.changedIds);
      shapeTargetId = target.targetId;
    }
  } else if (cloned.blocks.length > 0) {
    let insertTargetId = getMaterialBlockInsertionTargetId(session, targetId, cloned.blocks);
    for (const block of cloned.blocks) {
      operations.push({
        operation: "insertAfter",
        summary: tv("tools.draftInsertMaterial3", { p0: material.name }),
        targetId: insertTargetId,
        insertedBlock: block,
      });
      changedIds.push(block.id);
      insertTargetId = block.id;
    }
    shapeTargetId = cloned.blocks[0]?.id ?? targetId;
  }

  // アンカーは「現ドラフトに実在するブロック」でなければデルタを計算できない。素材本文の
  // 新規ブロックはこの時点でまだ未挿入なので、その場合は配置基準に使った targetId へ寄せる。
  const shapeAnchorBlockId = getAiOverlayBlockRects(session.draftDocument).has(shapeTargetId)
    ? shapeTargetId
    : targetId;
  const shapeOperations = createMaterialShapeInsertOperations(session, material.name, cloned.overlaySnapshot.shapes, cloned.overlaySnapshot.assets, shapeTargetId, shapeAnchorBlockId);
  operations.push(...shapeOperations.operations);
  changedIds.push(...shapeOperations.changedIds);

  if (operations.length === 0) {
    throw new Error(tv("tools.draftInsertMaterial4"));
  }

  const message = args.reason?.trim()
    ? tv("tools.draftInsertMaterial5", { p0: material.name, p1: args.reason.trim() })
    : tv("tools.draftInsertMaterial6", { p0: material.name });
  return commitOperations(session, operations, uniqueStrings(changedIds), message);
}

function draftInsertTableShape(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftInsertTableShapeArgsSchema.parse(rawArgs);
  const target = resolveOverlayInsertionTarget(session, args.targetId, args.area);
  const shape = ensureUniqueOverlayShapeId(
    session,
    withDefaultBlockAnchor(args.shape, session.draftDocument, target.targetId, Boolean(args.area)),
  );
  validateOverlayShapeWithAssets(shape, {});

  return commitOperations(session, [...target.preOperations, {
    operation: "insertTableShape",
    summary: tv("tools.draftInsertTableShape1"),
    targetId: target.targetId,
    tableShape: shape,
  }], [...target.changedIds, shape.id], tv("tools.draftInsertTableShape2"));
}

function draftInsertGraphShape(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftInsertGraphShapeArgsSchema.parse(rawArgs);
  const target = resolveOverlayInsertionTarget(session, args.targetId, args.area);
  const rawShape = args.shape
    ? migrateLegacyGraphShapeToPlotBounds(assertGraphShape(withDefaultBlockAnchor(args.shape, session.draftDocument, target.targetId, Boolean(args.area))))
    : createGraphShapeFromSpec(normalizeGraphSpec(args.spec!), session.draftDocument, target.targetId, args);
  const shape: OverlayGraphShape = ensureUniqueOverlayShapeId(session, {
    ...rawShape,
    props: {
      ...rawShape.props,
      spec: normalizeGraphSpec(rawShape.props.spec),
    },
  });
  validateGraphSpec(shape.props.spec, shape.id);
  validateOverlayShapeWithAssets(shape, {});

  return commitOperations(session, [...target.preOperations, {
    operation: "insertOverlayShape",
    summary: tv("tools.draftInsertGraphShape1"),
    targetId: target.targetId,
    overlayShape: shape,
    assets: {},
  }], [...target.changedIds, shape.id], tv("tools.draftInsertGraphShape2"));
}

function draftInsertSvgImage(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftInsertSvgImageArgsSchema.parse(rawArgs);
  const image = encodeAiSvg(args.svg);
  const width = args.w ?? (args.h === undefined ? Math.min(480, image.width) : args.h * image.width / image.height);
  const height = args.h ?? width * image.height / image.width;
  if (![width, height].every((n) => Number.isFinite(n) && n > 0 && n <= 8192)) throw new Error(tv("svg.displaySize"));
  // Reuse image placement/anchoring and atomic asset+shape proposal operations.
  return draftAttachImageAsset(session, { ...args, w: width, h: height }, {
    id: createId("svg_attachment"), name: args.name ?? "AI SVG", mimeType: "image/svg+xml",
    dataUrl: image.src, width: image.width, height: image.height, fileSize: image.fileSize,
  });
}

function draftUpdateSvgImage(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftUpdateSvgImageArgsSchema.parse(rawArgs);
  const image = encodeAiSvg(args.svg);
  const snapshot = normalizeOverlaySnapshot(session.draftDocument.pageLayout?.overlay?.overlaySnapshot);
  const shape = snapshot.shapes.find((candidate) => candidate.id === args.shapeId);
  if (!shape || shape.type !== "image") throw new Error(tv("svg.imageTarget"));
  const previous = snapshot.assets[shape.props.assetId];
  if (previous?.props.mimeType !== "image/svg+xml") throw new Error(tv("svg.svgTarget"));
  // Copy on write when duplicated images share an asset; replacing one must not change the other.
  const shared = snapshot.shapes.some((candidate) => candidate.id !== shape.id && candidate.type === "image" && candidate.props.assetId === previous.id);
  const assetId = shared ? createTakenIdAllocator(session).allocate(createId("ai_svg_asset"), "ai_svg_asset") : previous.id;
  const asset: OverlayAsset = {
    id: assetId, type: "image", props: {
      w: image.width, h: image.height, name: args.name ?? previous.props.name,
      isAnimated: false, mimeType: "image/svg+xml", src: image.src, fileSize: image.fileSize,
    },
  };
  return commitSigmaDocMutation(session, {
    operation: "updateOverlayShape", summary: tv("svg.updated"), shapeId: shape.id,
    patch: { props: { assetId } }, assets: { [assetId]: asset },
  });
}

function draftInsertGeneratedImage(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftInsertGeneratedImageArgsSchema.parse(rawArgs);
  const image = GeneratedImageAttachmentSchema.parse(rawArgs.generatedImage);
  if (image.id !== args.imageId) throw new Error(tv("generatedImage.invalidImage"));
  const id = `ai_generated_${args.imageId}`;
  const snapshot = normalizeOverlaySnapshot(session.draftDocument.pageLayout?.overlay?.overlaySnapshot);
  if (snapshot.shapes.some((shape) => shape.id === id)) {
    return createToolResult(session, true, tv("generatedImage.alreadyInserted"), [], { shapeId: id });
  }
  const width = args.w ?? (args.h === undefined ? Math.min(480, image.width) : args.h * image.width / image.height);
  const height = args.h ?? width * image.height / image.width;
  if (![width, height].every((n) => Number.isFinite(n) && n > 0 && n <= 8192)) throw new Error(tv("svg.displaySize"));
  return draftAttachImageAsset(session, { ...args, id, w: width, h: height }, image);
}

function draftUpdateGeneratedImage(session: SigmaDocAgentSession, rawArgs: Record<string, unknown>): SigmaDocAgentToolResult {
  const args = DraftUpdateGeneratedImageArgsSchema.parse(rawArgs);
  const image = GeneratedImageAttachmentSchema.parse(rawArgs.generatedImage);
  if (image.id !== args.imageId) throw new Error(tv("generatedImage.invalidImage"));
  const snapshot = normalizeOverlaySnapshot(session.draftDocument.pageLayout?.overlay?.overlaySnapshot);
  const shape = snapshot.shapes.find((candidate) => candidate.id === args.shapeId);
  if (!shape || shape.type !== "image") throw new Error(tv("svg.imageTarget"));
  const previous = snapshot.assets[shape.props.assetId];
  if (!previous) throw new Error(tv("generatedImage.invalidImage"));
  const shared = snapshot.shapes.some((candidate) => candidate.id !== shape.id && candidate.type === "image" && candidate.props.assetId === previous.id);
  const assetId = shared ? createTakenIdAllocator(session).allocate(createId("ai_image_asset"), "ai_image_asset") : previous.id;
  const asset: OverlayAsset = { id: assetId, type: "image", props: {
    w: image.width, h: image.height, name: previous.props.name, isAnimated: false,
    mimeType: image.mimeType, src: image.dataUrl, fileSize: image.fileSize,
  } };
  return commitSigmaDocMutation(session, {
    operation: "updateOverlayShape", summary: tv("generatedImage.updated"), shapeId: shape.id,
    patch: { props: { assetId } }, assets: { [assetId]: asset },
  });
}

function draftAttachImageAsset(
  session: SigmaDocAgentSession,
  rawArgs: Record<string, unknown>,
  generatedImage?: SigmaDocAgentSession["attachments"][number],
): SigmaDocAgentToolResult {
  const args = DraftAttachImageAssetArgsSchema.parse(rawArgs);
  const target = resolveOverlayInsertionTarget(session, args.targetId, args.area);
  const attachmentId = args.attachmentId ?? session.attachments[0]?.id;
  const attachment = generatedImage ?? session.attachments.find((item) => item.id === attachmentId);
  if (!attachment) {
    throw new Error(tv("tools.draftAttachImageAsset1"));
  }

  const idAllocator = createTakenIdAllocator(session);
  const assetId = idAllocator.allocate(args.assetId ?? createId("ai_image_asset"), "ai_image_asset");
  const width = args.w ?? Math.min(320, attachment.width || 240);
  const ratio = attachment.width && attachment.height ? attachment.height / attachment.width : 0.66;
  const height = args.h ?? Math.max(80, Math.round(width * ratio));
  const asset: OverlayAsset = {
    id: assetId,
    type: "image",
    props: {
      w: attachment.width || width,
      h: attachment.height || height,
      name: attachment.name,
      isAnimated: false,
      mimeType: attachment.mimeType,
      src: attachment.dataUrl,
      fileSize: attachment.fileSize ?? 0,
    },
  };
  const canvasDefault = target.targetId === "CANVAS" ? { x: 320, y: 240 } : {};
  const placed = resolveAiOverlayPlacement({
    document: session.draftDocument,
    anchorBlockId: target.targetId,
    x: args.x ?? canvasDefault.x,
    y: args.y ?? canvasDefault.y,
    ...(generatedImage && target.targetId !== "CANVAS" && args.x === undefined && args.y === undefined
      ? { placement: { anchorBlockId: target.targetId, position: "below" as const } }
      : {}),
  });
  const rawShape: OverlayImageShape = {
    id: args.id ?? createId("ai_image"),
    type: "image",
    x: placed.x,
    y: placed.y,
    rotation: 0,
    anchor: placed.anchor,
    props: {
      assetId,
      w: width,
      h: height,
    },
  };
  const shape: OverlayImageShape = {
    ...rawShape,
    id: idAllocator.allocate(rawShape.id, "ai_image"),
  };
  validateOverlayShapeWithAssets(shape, { [assetId]: asset });

  return commitOperations(session, [...target.preOperations, {
    operation: "insertOverlayShape",
    summary: tv("tools.draftAttachImageAsset2"),
    targetId: target.targetId,
    overlayShape: shape,
    assets: { [assetId]: asset },
  }], [...target.changedIds, shape.id, assetId], tv("tools.draftAttachImageAsset3"));
}

function draftValidate(session: SigmaDocAgentSession): SigmaDocAgentToolResult {
  const nextDocument = parseSigmaDocument(session.draftDocument);
  validateDocumentMath(nextDocument);
  const snapshot = normalizeOverlaySnapshot(nextDocument.pageLayout?.overlay?.overlaySnapshot);
  return createToolResult(session, true, tv("tools.draftValidate1"), session.changedIds, {
    contentCount: nextDocument.content.length,
    overlayShapeCount: snapshot.shapes.length,
    operationCount: session.operations.length,
  });
}

function commitOperation(
  session: SigmaDocAgentSession,
  operation: AiEditDraft,
  changedIds: string[],
): SigmaDocAgentToolResult {
  return commitOperations(session, [operation], changedIds, operation.summary);
}

/**
 * ツール結果の `data` へ載せるとき、asset の中身 (`src`) を短い印に置き換える。
 *
 * `src` は最大 2MB の data URL で、まったく同じ内容が文書側にも入る。呼び出したモデルへ
 * もう一度返しても読む意味は無く、1回のツール応答で context を食い尽くすだけなので、
 * 「どの asset が付いたか」だけが分かる形にする (`id` / `mimeType` / `fileSize` は残す)。
 */
const TOOL_DATA_OMITTED_ASSET_SOURCE = "<omitted: written into the document>";

function summarizeAssetsForToolData(assets: Record<string, OverlayAsset>): Record<string, OverlayAsset> {
  return Object.fromEntries(Object.entries(assets).map(([assetId, asset]) => [assetId, {
    ...asset,
    props: { ...asset.props, src: TOOL_DATA_OMITTED_ASSET_SOURCE },
  }]));
}

function summarizeOperationForToolData(operation: AiEditDraft): AiEditDraft {
  return operation.operation === "insertOverlayShape" && Object.keys(operation.assets ?? {}).length > 0
    ? { ...operation, assets: summarizeAssetsForToolData(operation.assets) }
    : operation;
}

function summarizeMutationOpForToolData(op: SigmaDocMutationOp): SigmaDocMutationOp {
  return op.operation === "updateOverlayShape" && Object.keys(op.assets ?? {}).length > 0
    ? { ...op, assets: summarizeAssetsForToolData(op.assets!) }
    : op;
}

function commitOperations(
  session: SigmaDocAgentSession,
  operations: AiEditDraft[],
  changedIds: string[],
  message: string,
  /** ツール固有の結果 (検証 issue やカウント) を `data` へ合流させる。 */
  extraData?: Record<string, unknown>,
): SigmaDocAgentToolResult {
  const result = createAiEditSessionDocumentDraft(session.draftDocument, operations[0].targetId, {
    summary: message,
    plan: operations.map((operation) => operation.summary).slice(0, 8),
    operations,
    warnings: [],
  });
  validateDocumentMath(result.nextDocument);
  session.draftDocument = result.nextDocument;
  session.operations.push(...result.draft.operations);
  session.operationResults.push(...result.operationResults);
  session.changedIds = uniqueStrings([...session.changedIds, ...changedIds]);
  return createToolResult(session, true, message, changedIds, {
    operations: result.draft.operations.map(summarizeOperationForToolData),
    ...(extraData ?? {}),
  });
}

/**
 * Applies one of the additional block/layout/overlay/page-layout mutation operations to the session's draft
 * document. Mirrors `commitOperation`/`commitOperations` above: validates math, advances
 * `session.draftDocument`, and records the applied op for later summarization — but tracks the
 * op in `session.mutationOperations` instead of `session.operations` since these ops are not
 * part of the AiEditDraft family the inline preview UI renders.
 */
export function commitSigmaDocMutation(
  session: SigmaDocAgentSession,
  input: unknown,
  /** ツール固有の結果 (検証 issue やカウント) を `data` へ合流させる。 */
  extraData?: Record<string, unknown>,
): SigmaDocAgentToolResult {
  try {
    const { op, nextDocument } = applySigmaDocMutationOp(session.draftDocument, input);
    validateDocumentMath(nextDocument);
    const changedIds = collectSigmaDocMutationChangedIds(op);
    session.draftDocument = nextDocument;
    session.mutationOperations.push(op);
    session.changedIds = uniqueStrings([...session.changedIds, ...changedIds]);
    return createToolResult(session, true, op.summary, changedIds, {
      operation: summarizeMutationOpForToolData(op),
      ...(extraData ?? {}),
    });
  } catch (error) {
    return createToolResult(session, false, formatToolError(error), [], undefined);
  }
}

function collectSigmaDocMutationChangedIds(op: SigmaDocMutationOp): string[] {
  if (op.operation === "deleteBlocks") {
    return op.blockIds;
  }
  if (op.operation === "moveBlocks") {
    return [...op.blockIds, op.targetId];
  }
  if (op.operation === "updateOverlayShape") {
    return [op.shapeId];
  }
  if (op.operation === "updatePageLayout") {
    return [];
  }
  if (op.operation === "alignOverlayShapes" || op.operation === "deleteOverlayShapes") {
    return op.shapeIds;
  }
  if (op.operation === "wrapBlocksInColumns") {
    return op.blockIds;
  }
  if (op.operation === "updateLayoutSection") {
    return [op.sectionId];
  }
  return [];
}

function createToolResult(
  session: SigmaDocAgentSession,
  ok: boolean,
  message: string,
  changedIds: string[],
  data: unknown,
): SigmaDocAgentToolResult {
  return {
    ok,
    message,
    changedIds,
    draftSummary: {
      contentCount: session.draftDocument.content.length,
      operationCount: session.operations.length,
      changedIds: session.changedIds,
    },
    ...(data === undefined ? {} : { data }),
  };
}

function getReadableTargetId(session: SigmaDocAgentSession, targetId: unknown): string | null {
  const resolvedTargetId =
    (typeof targetId === "string" ? targetId.trim() : "") ||
    session.selectedId ||
    getDefaultAiEditInsertionTargetId(session.draftDocument);
  if (!resolvedTargetId) {
    return null;
  }
  return findBlock(session.draftDocument, resolvedTargetId) ? resolvedTargetId : null;
}

function getTargetId(session: SigmaDocAgentSession, targetId: string | undefined): string {
  const resolvedTargetId =
    targetId?.trim() ||
    session.selectedId ||
    getDefaultAiEditInsertionTargetId(session.draftDocument);
  if (!resolvedTargetId || !findBlock(session.draftDocument, resolvedTargetId)) {
    throw new Error(tv("tools.getTargetId1"));
  }
  return resolvedTargetId;
}

function getTopLevelInsertTargetId(session: SigmaDocAgentSession, targetId: string): string {
  const topLevel = session.draftDocument.content.find((block) => block.id === targetId);
  if (topLevel) {
    return topLevel.id;
  }
  const problem = findContainingProblem(session.draftDocument, targetId);
  if (problem) {
    return problem.id;
  }
  return targetId;
}

function findMaterialById(session: SigmaDocAgentSession, materialId: string): MaterialItem {
  const material = session.materials.find((item) => item.id === materialId);
  if (!material) {
    throw new Error(tv("tools.findMaterialById1", { p0: materialId }));
  }
  return material;
}

function getMaterialBlockInsertionTargetId(
  session: SigmaDocAgentSession,
  targetId: string,
  blocks: readonly SigmaBlock[],
): string {
  if (blocks.every(isProblemAreaMaterialBlock)) {
    return targetId;
  }
  const topLevel = session.draftDocument.content.find((block) => block.id === targetId);
  if (topLevel) {
    return topLevel.id;
  }
  return getTopLevelInsertTargetId(session, targetId);
}

function assertMaterialBlocksCanInsertIntoProblemArea(
  blocks: readonly SigmaBlock[],
): asserts blocks is RichBlock[] {
  if (blocks.some((block) => !isProblemAreaMaterialBlock(block))) {
    throw new Error(tv("tools.assertMaterialBlocksCanInsertIntoProblemArea1"));
  }
}

function isProblemAreaMaterialBlock(block: SigmaBlock): block is RichBlock {
  return block.type === "heading" || block.type === "paragraph" || block.type === "list";
}

function createMaterialShapeInsertOperations(
  session: SigmaDocAgentSession,
  materialName: string,
  shapes: readonly OverlayShape[],
  assets: Record<string, OverlayAsset>,
  targetId: string,
  anchorBlockId: string,
): { operations: AiEditDraft[]; changedIds: string[] } {
  const operations: AiEditDraft[] = [];
  const changedIds: string[] = [];
  const assetIds = Object.keys(assets);
  let includeAssets = assetIds.length > 0;

  for (const shape of shapes) {
    const anchoredShape = ensureUniqueOverlayShapeId(
      session,
      withDefaultBlockAnchor(shape, session.draftDocument, anchorBlockId),
    );
    if (anchoredShape.type === "tableShape") {
      validateOverlayShapeWithAssets(anchoredShape, {});
      operations.push({
        operation: "insertTableShape",
        summary: tv("tools.createMaterialShapeInsertOperations1", { p0: materialName }),
        targetId,
        tableShape: anchoredShape,
      });
      changedIds.push(anchoredShape.id);
      continue;
    }

    const operationAssets = includeAssets ? assets : {};
    validateOverlayShapeWithAssets(anchoredShape, operationAssets);
    operations.push({
      operation: "insertOverlayShape",
      summary: tv("tools.createMaterialShapeInsertOperations2", { p0: materialName }),
      targetId,
      overlayShape: anchoredShape,
      assets: operationAssets,
    });
    changedIds.push(anchoredShape.id, ...(includeAssets ? assetIds : []));
    includeAssets = false;
  }

  return {
    operations,
    changedIds,
  };
}

export function collectNeighborBlocks(document: SigmaDocument, targetId: string): unknown {
  const topLevelIndex = document.content.findIndex((block) => block.id === targetId);
  if (topLevelIndex >= 0) {
    return {
      scope: "topLevel",
      previous: summarizeToolBlockLight(document.content[topLevelIndex - 1] ?? null),
      current: summarizeToolBlock(document.content[topLevelIndex]),
      next: summarizeToolBlockLight(document.content[topLevelIndex + 1] ?? null),
    };
  }

  for (const block of document.content) {
    if (block.type !== "problem") {
      continue;
    }
    const match =
      findRichBlockNeighbors(block, "lead", block.lead, targetId) ??
      findRichBlockNeighbors(block, "prompt", block.prompt, targetId) ??
      findRichBlockNeighbors(block, "solution", block.solution, targetId) ??
      findRichBlockNeighbors(block, "hints", block.hints, targetId);
    if (match) {
      return match;
    }
  }

  return { scope: "unknown", targetId };
}

function findRichBlockNeighbors(
  problem: ProblemNode,
  area: ProblemAreaKind,
  blocks: ProblemAreaBlock[],
  targetId: string,
): unknown | null {
  const index = blocks.findIndex((block) => block.id === targetId);
  if (index < 0) {
    return null;
  }

  return {
    scope: "problemRichBlock",
    area,
    parentProblem: summarizeToolBlockLight(problem),
    previous: summarizeToolBlockLight(blocks[index - 1] ?? null),
    current: summarizeToolBlock(blocks[index]),
    next: summarizeToolBlockLight(blocks[index + 1] ?? null),
  };
}

export function summarizeToolBlock(block: EditableBlock | null | undefined): unknown {
  if (!block) {
    return null;
  }
  return {
    id: block.id,
    type: block.type,
    text: blockToReferenceText(block),
    block,
  };
}

export function summarizeToolBlockLight(block: EditableBlock | null | undefined): unknown {
  if (!block) {
    return null;
  }
  return {
    id: block.id,
    type: block.type,
    text: blockToReferenceText(block),
  };
}

function createProblemNodeFromContentArgs(args: z.infer<typeof DraftCreateProblemContentArgsSchema>): ProblemNode {
  const answer = normalizeAnswerDefinition(args.answer, args.answerText, args.answerTex);
  const pagination = normalizePaginationInput(args.pagination);
  const lead = normalizeAiRichBlockList(args.lead, "ai_problem_lead");
  if (lead.length === 0 && args.title?.trim()) {
    const titleBlock = normalizeAiRichBlockInput({
      type: "heading",
      level: 3,
      id: `${args.id ?? "ai_problem"}_lead`,
      text: args.title,
    }, "ai_problem_lead", 0);
    if (titleBlock.type === "boxBlock") {
      throw new Error(tv("tools.createProblemNodeFromContent1"));
    }
    lead.push(titleBlock);
  }

  return normalizeProblemMath({
    type: "problem",
    id: args.id ?? createId("ai_problem"),
    tags: args.tags ?? [],
    lead,
    prompt: normalizeAiRichBlockList(args.prompt, "ai_problem_prompt"),
    ...(answer ? { answer } : {}),
    solution: normalizeAiRichBlockList(args.solution, "ai_problem_solution"),
    hints: normalizeAiRichBlockList(args.hints, "ai_problem_hint"),
    ...(pagination ? { pagination } : {}),
    ...(isRecord(args.areaLayout) ? { areaLayout: args.areaLayout as ProblemNode["areaLayout"] } : {}),
    ...(isRecord(args.numbering) ? { numbering: args.numbering as ProblemNode["numbering"] } : {}),
    ...(isRecord(args.frame) ? { frame: args.frame as ProblemNode["frame"] } : {}),
  });
}

function normalizeAnswerDefinition(
  answer: z.infer<typeof AnswerDefinitionSchema> | null | undefined,
  answerText: string | undefined,
  answerTex: string | undefined,
): ProblemNode["answer"] | undefined {
  if (answer) {
    return answer;
  }

  if (typeof answerTex === "string" && answerTex.trim()) {
    return {
      type: "math",
      expected: normalizeLikelyAiMathNewlines(answerTex.trim()),
    };
  }

  if (typeof answerText === "string" && answerText.trim()) {
    return {
      type: "text",
      expected: answerText.trim(),
    };
  }

  return undefined;
}

function normalizeAiRichBlockList(
  input: z.infer<typeof AiRichBlockListSchema> | undefined,
  idPrefix: string,
): ProblemAreaBlock[] {
  if (input === undefined) {
    return [];
  }

  const blocks = Array.isArray(input) ? input : [input];
  return blocks.map((block, index) => {
    const normalized = normalizeAiRichBlockInput(block, idPrefix, index);
    if (normalized.type === "boxBlock" || normalized.type === "layoutSection") {
      throw new Error(tv("tools.normalizeAiRichBlockList1"));
    }
    return normalized;
  });
}

function normalizeAiRichBlockInput(
  input: z.infer<typeof AiRichBlockInputSchema>,
  idPrefix: string,
  index: number,
): ProblemAreaBlock | BoxBlockNode {
  const source: Record<string, unknown> = typeof input === "string" ? { text: input } : input;
  const pagination = normalizePaginationInput(source.pagination);

  if (source.type === "boxBlock") {
    const styleId = typeof source.styleId === "string" ? source.styleId : "";
    if (!styleId) {
      throw new Error(tv("tools.normalizeAiRichBlockInput1"));
    }
    const style = getBoxStyleDefinition(styleId);
    if (!style) {
      const validIds = BUILTIN_BOX_STYLES.map(s => s.id).join(", ");
      throw new Error(tv("tools.normalizeAiRichBlockInput2", { p0: styleId, p1: validIds }));
    }
    const blocksList = Array.isArray(source.blocks) ? source.blocks : [];
    const normalizedBlocks: BoxBlockChildBlock[] = blocksList.map((block, blockIndex) =>
      normalizeAiRichBlockInput(block, `${idPrefix}_box_${index + 1}`, blockIndex)
    );
    const titleText = typeof source.title === "string" ? source.title : "";
    return {
      type: "boxBlock",
      id: nonEmptyStringOr(source.id, createId(`${idPrefix}_box_${index + 1}`)),
      styleId: style.id,
      ...(titleText ? { title: inlineTitleFromText(titleText) } : {}),
      blocks: normalizedBlocks,
      ...(isRecord(source.frame) ? { frame: source.frame as BoxFrameSpec } : {}),
      ...(pagination ? { pagination } : {}),
    };
  }

  if (source.type === "list") {
    return normalizeAiListInput(source, idPrefix, index, pagination);
  }
  if (source.type === "codeBlock") {
    const code = Array.isArray(source.children)
      ? source.children.map((node) => {
          if (typeof node === "string") return node;
          return isRecord(node) && typeof node.text === "string" ? node.text : "";
        }).join("")
      : typeof source.text === "string"
        ? source.text
        : "";
    const language = typeof source.language === "string" && source.language.trim()
      ? source.language.trim()
      : undefined;
    const theme = source.theme === "light" || source.theme === "dark" ? source.theme : undefined;
    return {
      type: "codeBlock",
      id: nonEmptyStringOr(source.id, createId(`${idPrefix}_code_${index + 1}`)),
      children: code ? [{ type: "text", text: code }] : [],
      ...(language ? { language } : {}),
      ...(theme ? { theme } : {}),
      ...(pagination ? { pagination } : {}),
    };
  }
  const children = normalizeAiInlineContent(source);
  const id = nonEmptyStringOr(source.id, createId(`${idPrefix}_${index + 1}`));
  const align = normalizeTextAlign(source.align);
  const lineHeight = normalizeLineHeight(source.lineHeight);

  if (source.type === "heading" || Number.isFinite(source.level)) {
    return {
      type: "heading",
      id,
      level: normalizeHeadingLevel(source.level),
      children,
      ...(align ? { align } : {}),
      ...(lineHeight ? { lineHeight } : {}),
      ...(pagination ? { pagination } : {}),
    };
  }

  return {
    type: "paragraph",
    id,
    children,
    ...(align ? { align } : {}),
    ...(lineHeight ? { lineHeight } : {}),
    ...(pagination ? { pagination } : {}),
  };
}

function normalizeAiListInput(
  source: Record<string, unknown>,
  idPrefix: string,
  index: number,
  pagination?: PaginationHints,
): ListNode {
  const id = nonEmptyStringOr(source.id, createId(`${idPrefix}_list_${index + 1}`));
  const itemInputs = Array.isArray(source.items) ? source.items : [];
  const items = itemInputs.map((item, itemIndex) => {
    const itemRecord = typeof item === "string" ? { text: item } : isRecord(item) ? item : {};
    const continuationInputs = Array.isArray(itemRecord.continuations) ? itemRecord.continuations : [];
    const continuations = continuationInputs.map((continuationInput, continuationIndex) => {
      const normalized = normalizeAiRichBlockInput(
        continuationInput,
        `${id}_item_${itemIndex + 1}_continuation`,
        continuationIndex,
      );
      if (normalized.type !== "paragraph" && normalized.type !== "heading") {
        throw new Error(tv("tools.normalizeAiListInput1"));
      }
      return normalized;
    });
    const nestedInputs = Array.isArray(itemRecord.nested) ? itemRecord.nested : [];
    const nested = nestedInputs.map((nestedInput, nestedIndex): ListNode => {
      const normalized = normalizeAiRichBlockInput(
        nestedInput,
        `${id}_item_${itemIndex + 1}`,
        nestedIndex,
      );
      if (normalized.type !== "list") {
        throw new Error(tv("tools.normalizeAiListInput2"));
      }
      return normalized;
    });

    return {
      type: "listItem" as const,
      id: nonEmptyStringOr(itemRecord.id, createId(`${id}_item_${itemIndex + 1}`)),
      children: normalizeAiInlineContent(itemRecord),
      ...(normalizeTextAlign(itemRecord.align) ? { align: normalizeTextAlign(itemRecord.align) } : {}),
      ...(continuations.length > 0 ? { continuations } : {}),
      ...(nested.length > 0 ? { nested } : {}),
    };
  });
  const start = positiveIntegerOrUndefined(source.start);
  const listType = source.listType === "ordered" ? "ordered" : "bullet";
  // 番号マーカーの見せ方だけの指定。未知の値は decimal に倒す (normalizeOrderedListMarkerStyle)。
  const markerStyle = listType === "ordered"
    ? normalizeOrderedListMarkerStyle(source.markerStyle)
    : undefined;

  return {
    type: "list",
    id,
    listType,
    items,
    ...(start ? { start } : {}),
    ...(markerStyle ? { markerStyle } : {}),
    ...(pagination ? { pagination } : {}),
  };
}

function normalizePaginationInput(input: unknown): PaginationHints | undefined {
  if (input === null || input === undefined) {
    return undefined;
  }
  const parsed = PaginationInputSchema.parse(input);
  const pagination = {
    ...(parsed.break === true ? { break: true } : {}),
    ...(parsed.keepTogether === true ? { keepTogether: true } : {}),
    ...(parsed.keepWithNext === true ? { keepWithNext: true } : {}),
  };
  return Object.keys(pagination).length > 0 ? pagination : undefined;
}

function normalizeAiInlineContent(source: Record<string, unknown>): InlineNode[] {
  if (Array.isArray(source.children)) {
    return normalizeAiInlineNodes(source.children);
  }

  if (Array.isArray(source.runs)) {
    return normalizeAiInlineNodes(source.runs);
  }

  const children: InlineNode[] = [];
  if (typeof source.text === "string") {
    children.push(...createTextInlinesWithDelimitedMath(source.text, source));
  }
  if (typeof source.tex === "string") {
    children.push(createMathInline(source.tex, source.id, source));
  }

  return children.length > 0 ? children : [{ type: "text", text: "" }];
}

function normalizeAiInlineNodes(input: unknown[]): InlineNode[] {
  const children = input.flatMap((node): InlineNode[] => {
    if (typeof node === "string") {
      return createTextInlinesWithDelimitedMath(node, {});
    }

    if (!isRecord(node)) {
      return [];
    }

    if (node.type === "math" || node.type === "mathInline" || typeof node.tex === "string") {
      return [createMathInline(typeof node.tex === "string" ? node.tex : "", node.id, node)];
    }

    if (node.type === "text" || typeof node.text === "string") {
      return createTextInlinesWithDelimitedMath(typeof node.text === "string" ? node.text : "", node);
    }

    return [];
  });

  return children.length > 0 ? children : [{ type: "text", text: "" }];
}

function createTextInlinesWithDelimitedMath(text: string, source: Record<string, unknown>): InlineNode[] {
  return splitDelimitedInlineMathText(text).map((segment) => (
    segment.type === "math"
      ? createMathInline(segment.tex, undefined, source)
      : createTextInline(segment.text, source)
  ));
}

function createTextInline(text: string, source: Record<string, unknown>): InlineNode {
  const marks = normalizeTextMarks(source.marks);
  const boxedVariant = normalizeInlineBoxedVariant(source.boxedVariant);
  const boxedTone = normalizeInlineBoxedTone(source.boxedTone);
  return {
    type: "text",
    text,
    ...(marks.length > 0 ? { marks } : {}),
    ...(typeof source.color === "string" ? { color: source.color } : {}),
    ...(typeof source.backgroundColor === "string" ? { backgroundColor: source.backgroundColor } : {}),
    ...(typeof source.fontFamily === "string" ? { fontFamily: source.fontFamily } : {}),
    ...(positiveNumberOrUndefined(source.fontSize) ? { fontSize: positiveNumberOrUndefined(source.fontSize) } : {}),
    ...(positiveNumberOrUndefined(source.boxedPaddingY) ? { boxedPaddingY: positiveNumberOrUndefined(source.boxedPaddingY) } : {}),
    ...(boxedVariant ? { boxedVariant } : {}),
    ...(boxedTone ? { boxedTone } : {}),
  };
}

function createMathInline(tex: string, id: unknown, source: Record<string, unknown> = {}): InlineNode {
  const marks = normalizeTextMarks(source.marks).filter(
    (mark): mark is "underline" | "boxed" => mark === "underline" || mark === "boxed",
  );
  const boxedVariant = normalizeInlineBoxedVariant(source.boxedVariant);
  const boxedTone = normalizeInlineBoxedTone(source.boxedTone);
  return {
    type: "mathInline",
    id: nonEmptyStringOr(id, createId("ai_math")),
    tex: normalizeLikelyAiMathNewlines(tex),
    display: "inline",
    ...(marks.length > 0 ? { marks } : {}),
    ...(typeof source.color === "string" ? { color: source.color } : {}),
    ...(typeof source.backgroundColor === "string" ? { backgroundColor: source.backgroundColor } : {}),
    ...(typeof source.fontFamily === "string" ? { fontFamily: source.fontFamily } : {}),
    ...(positiveNumberOrUndefined(source.fontSize) ? { fontSize: positiveNumberOrUndefined(source.fontSize) } : {}),
    ...(positiveNumberOrUndefined(source.boxedPaddingY) ? { boxedPaddingY: positiveNumberOrUndefined(source.boxedPaddingY) } : {}),
    ...(boxedVariant ? { boxedVariant } : {}),
    ...(boxedTone ? { boxedTone } : {}),
  };
}

function normalizeInlineBoxedVariant(value: unknown): "frame" | "thick" | "double" | "oval" | "shade" | undefined {
  return value === "frame" || value === "thick" || value === "double" || value === "oval" || value === "shade"
    ? value
    : undefined;
}

function normalizeInlineBoxedTone(value: unknown): "gray" | "blue" | "green" | "red" | "yellow" | undefined {
  return value === "gray" || value === "blue" || value === "green" || value === "red" || value === "yellow"
    ? value
    : undefined;
}

function normalizeTextMarks(value: unknown): TextMark[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((mark): mark is TextMark =>
    mark === "bold" || mark === "italic" || mark === "underline" || mark === "boxed"
  );
}

function normalizeHeadingLevel(value: unknown): 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3 ? value : 2;
}

function normalizeTextAlign(value: unknown): TextAlign | undefined {
  return value === "left" || value === "center" || value === "right" || value === "justify" ? value : undefined;
}

function assertNewBlockIds(session: SigmaDocAgentSession, ids: string[], targetId: string): void {
  const uniqueIds = new Set<string>();
  for (const id of ids) {
    if (id === targetId || uniqueIds.has(id) || findBlock(session.draftDocument, id)) {
      throw new Error(tv("tools.assertNewBlockIds1", { p0: id }));
    }
    uniqueIds.add(id);
  }
}

interface TakenIdAllocator {
  taken: Set<string>;
  allocate: (preferredId: string | undefined, fallbackPrefix: string) => string;
}

function createTakenIdAllocator(session: SigmaDocAgentSession): TakenIdAllocator {
  const taken = collectDocumentOwnedIds(session.draftDocument);
  return {
    taken,
    allocate: (preferredId, fallbackPrefix) => allocateUniqueId(taken, preferredId, fallbackPrefix),
  };
}

function allocateUniqueId(taken: Set<string>, preferredId: string | undefined, fallbackPrefix: string): string {
  const preferred = preferredId?.trim() ?? "";
  if (preferred && !taken.has(preferred)) {
    taken.add(preferred);
    return preferred;
  }

  let nextId = createId(fallbackPrefix);
  while (taken.has(nextId)) {
    nextId = createId(fallbackPrefix);
  }
  taken.add(nextId);
  return nextId;
}

function collectDocumentOwnedIds(document: SigmaDocument): Set<string> {
  const ids = new Set<string>();
  document.content.forEach((block) => collectSigmaBlockIds(block, ids));
  for (const thread of document.comments ?? []) {
    ids.add(thread.id);
    for (const message of thread.messages) {
      ids.add(message.id);
      for (const reaction of message.reactions ?? []) {
        ids.add(reaction.id);
      }
      collectInlineNodeIds(message.body, ids);
    }
    for (const reaction of thread.reactions ?? []) {
      ids.add(reaction.id);
    }
  }

  const overlaySnapshot = normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot);
  overlaySnapshot.shapes.forEach((shape) => ids.add(shape.id));
  Object.keys(overlaySnapshot.assets).forEach((id) => ids.add(id));
  return ids;
}

function collectSigmaBlockIds(block: SigmaBlock, ids: Set<string>): void {
  ids.add(block.id);
  if (block.type === "heading" || block.type === "paragraph") {
    collectInlineNodeIds(block.children, ids);
    return;
  }

  if (block.type === "list") {
    collectListIds(block, ids);
    return;
  }

  if (block.type === "problem") {
    block.lead.forEach((richBlock) => collectRichBlockIdsForUniqueness(richBlock, ids));
    block.prompt.forEach((richBlock) => collectRichBlockIdsForUniqueness(richBlock, ids));
    block.solution.forEach((richBlock) => collectRichBlockIdsForUniqueness(richBlock, ids));
    block.hints.forEach((richBlock) => collectRichBlockIdsForUniqueness(richBlock, ids));
    return;
  }

  if (block.type === "layoutSection") {
    block.children.forEach((child) => {
      if (child.type === "section") {
        ids.add(child.id);
      } else if (child.type === "boxBlock") {
        collectBoxBlockIds(child, ids);
      } else {
        collectRichBlockIdsForUniqueness(child, ids);
      }
    });
    return;
  }

  if (block.type === "boxBlock") {
    collectBoxBlockIds(block, ids);
  }
}

function collectRichBlockIdsForUniqueness(block: ProblemAreaBlock, ids: Set<string>): void {
  ids.add(block.id);
  if (block.type === "layoutSection") {
    block.children.forEach((child) => collectLayoutSectionChildIdsForUniqueness(child, ids));
    return;
  }
  if (block.type === "boxBlock") {
    collectBoxBlockIds(block, ids);
    return;
  }
  if (block.type === "list") {
    collectListIds(block, ids);
  } else if (block.type === "quote") {
    block.blocks.forEach((child) => collectLayoutSectionChildIdsForUniqueness(child, ids));
  } else if (block.type !== "divider") {
    collectInlineNodeIds(block.children, ids);
  }
}

function collectLayoutSectionChildIdsForUniqueness(block: LayoutSectionChildBlock, ids: Set<string>): void {
  ids.add(block.id);
  if (block.type === "boxBlock") {
    collectBoxBlockIds(block, ids);
  } else if (block.type === "list") {
    collectListIds(block, ids);
  } else if (block.type === "heading" || block.type === "paragraph") {
    collectInlineNodeIds(block.children, ids);
  }
}

function collectListIds(block: Extract<RichBlock, { type: "list" }>, ids: Set<string>): void {
  ids.add(block.id);
  for (const item of block.items) {
    ids.add(item.id);
    collectInlineNodeIds(item.children, ids);
    for (const continuation of item.continuations ?? []) {
      ids.add(continuation.id);
      collectInlineNodeIds(listItemContinuationInlineNodes(continuation), ids);
    }
    item.nested?.forEach((nested) => collectListIds(nested, ids));
  }
}

function collectBoxBlockIds(block: Extract<SigmaBlock, { type: "boxBlock" }>, ids: Set<string>): void {
  ids.add(block.id);
  if (block.title) {
    collectInlineNodeIds(block.title, ids);
  }
  for (const child of block.blocks) {
    if (child.type === "layoutSection" || child.type === "problem") {
      collectSigmaBlockIds(child, ids);
    } else if (child.type === "boxBlock") {
      collectBoxBlockIds(child, ids);
    } else if (child.type === "section") {
      ids.add(child.id);
    } else {
      collectRichBlockIdsForUniqueness(child, ids);
    }
  }
}

function collectInlineNodeIds(children: InlineNode[], ids: Set<string>): void {
  for (const child of children) {
    if ("id" in child) {
      ids.add(child.id);
    }
  }
}

function ensureUniqueRichBlocksForInsert(session: SigmaDocAgentSession, blocks: (ProblemAreaBlock | BoxBlockNode)[]): (ProblemAreaBlock | BoxBlockNode)[] {
  return ensureUniqueRichBlocksWithAllocator(blocks, createTakenIdAllocator(session));
}

function ensureUniqueProblemForInsert(session: SigmaDocAgentSession, problem: ProblemNode): ProblemNode {
  const allocator = createTakenIdAllocator(session);
  return {
    ...problem,
    id: allocator.allocate(problem.id, "ai_problem"),
    lead: ensureUniqueRichBlocksWithAllocator(problem.lead, allocator),
    prompt: ensureUniqueRichBlocksWithAllocator(problem.prompt, allocator),
    solution: ensureUniqueRichBlocksWithAllocator(problem.solution, allocator),
    hints: ensureUniqueRichBlocksWithAllocator(problem.hints, allocator),
  };
}

function ensureUniqueRichBlocksWithAllocator<T extends ProblemAreaBlock | BoxBlockNode | ProblemNode>(blocks: T[], allocator: TakenIdAllocator): T[] {
  return blocks.map((block) => ensureUniqueRichBlockWithAllocator(block, allocator));
}

function ensureUniqueRichBlockWithAllocator<T extends ProblemAreaBlock | BoxBlockNode | ProblemNode>(block: T, allocator: TakenIdAllocator): T {
  if (block.type === "problem") return { ...block,
    id: allocator.allocate(block.id, "ai_problem"),
    lead: ensureUniqueRichBlocksWithAllocator(block.lead, allocator),
    prompt: ensureUniqueRichBlocksWithAllocator(block.prompt, allocator),
    hints: ensureUniqueRichBlocksWithAllocator(block.hints, allocator),
    solution: ensureUniqueRichBlocksWithAllocator(block.solution, allocator),
  };
  if (block.type === "layoutSection") {
    return {
      ...block,
      id: allocator.allocate(block.id, "ai_layout_section"),
      children: block.children.map((child) => ensureUniqueLayoutSectionChildWithAllocator(child, allocator)),
    } as T;
  }
  if (block.type === "boxBlock") {
    return {
      ...block,
      id: allocator.allocate(block.id, "ai_box"),
      blocks: block.blocks.map((b) => {
        if (b.type === "problem") return ensureUniqueRichBlockWithAllocator(b, allocator);
        if (b.type === "layoutSection") {
          return ensureUniqueRichBlockWithAllocator(b, allocator) as LayoutSectionNode;
        } else if (b.type === "boxBlock") {
          return ensureUniqueRichBlockWithAllocator(b, allocator) as BoxBlockNode;
        }
        // For RichBlock, use the layout section child handler
        return ensureUniqueLayoutSectionChildWithAllocator(b, allocator);
      }),
    } as T;
  }
  if (block.type === "list") {
    return {
      ...block,
      id: allocator.allocate(block.id, "ai_list"),
      items: block.items.map((item) => ({
        ...item,
        id: allocator.allocate(item.id, "ai_list_item"),
        children: ensureUniqueInlineNodesWithAllocator(item.children, allocator),
        ...(item.continuations ? {
          continuations: item.continuations.map((continuation) =>
            ensureUniqueRichBlockWithAllocator(continuation, allocator) as typeof continuation
          ),
        } : {}),
        ...(item.nested ? { nested: item.nested.map((nested) => ensureUniqueRichBlockWithAllocator(nested, allocator) as Extract<RichBlock, { type: "list" }>) } : {}),
      })),
    } as T;
  }

  if (block.type === "divider") {
    return { ...block, id: allocator.allocate(block.id, "ai_divider") } as T;
  }

  if (block.type === "quote") {
    return {
      ...block,
      id: allocator.allocate(block.id, "ai_quote"),
      blocks: block.blocks.map((child) => (
        ensureUniqueLayoutSectionChildWithAllocator(child, allocator) as typeof child
      )),
    } as T;
  }

  return {
    ...block,
    id: allocator.allocate(
      block.id,
      block.type === "heading" ? "ai_heading" : block.type === "codeBlock" ? "ai_code" : "ai_paragraph",
    ),
    children: ensureUniqueInlineNodesWithAllocator(block.children, allocator),
  } as T;
}

function ensureUniqueLayoutSectionChildWithAllocator(block: LayoutSectionChildBlock, allocator: TakenIdAllocator): LayoutSectionChildBlock {
  if (block.type === "section") {
    return { ...block, id: allocator.allocate(block.id, "ai_section") };
  }
  if (block.type === "boxBlock") {
    return {
      ...block,
      id: allocator.allocate(block.id, "ai_box"),
      title: block.title ? ensureUniqueInlineNodesWithAllocator(block.title, allocator) : undefined,
      blocks: block.blocks.map((child) => child.type === "layoutSection" || child.type === "problem"
        ? ensureUniqueRichBlockWithAllocator(child, allocator)
        : ensureUniqueLayoutSectionChildWithAllocator(child, allocator)),
    };
  }
  return ensureUniqueRichBlockWithAllocator(block, allocator) as LayoutSectionChildBlock;
}

function ensureUniqueInlineNodesWithAllocator(children: InlineNode[], allocator: TakenIdAllocator): InlineNode[] {
  return children.map((child) => {
    if (child.type !== "mathInline") {
      return child;
    }
    return {
      ...child,
      id: allocator.allocate(child.id, "ai_math"),
    };
  });
}

function createTableSpecFromToolArgs(args: z.infer<typeof DraftInsertTableArgsSchema>, baseTable?: SigmaTableSpec): SigmaTableSpec {
  const kind: SigmaTableKind = args.kind ?? "plain";
  const matrix = getTableInputMatrix(args);
  const rowInputs = args.rows ?? [];
  const columnInputs = args.columns ?? [];
  const rowCount = Math.max(rowInputs.length, matrix.length, 1);
  const columnCount = Math.max(
    columnInputs.length,
    ...matrix.map((row) => row.length),
    1,
  );
  const columns = Array.from({ length: columnCount }, (_, index) =>
    normalizeTableColumn(columnInputs[index], index, kind, baseTable?.columns[index])
  );
  const rows = Array.from({ length: rowCount }, (_, index) =>
    normalizeTableRow(rowInputs[index], index, kind, baseTable?.rows[index])
  );

  return {
    version: 1,
    kind,
    columns,
    rows,
    cells: rows.flatMap((row, rowIndex) =>
      columns.map((column, columnIndex) => {
        const cellInput = matrix[rowIndex]?.[columnIndex] ?? getRowLabelCellInput(rowInputs[rowIndex], columnIndex);
        return createTableCell(row.id, column.id, cellInput, kind, rowIndex, columnIndex);
      }),
    ),
    grid: normalizeTableGridStyle(args.grid, baseTable?.grid),
    defaultCellStyle: normalizeTableCellStyle(args.defaultCellStyle, false, baseTable?.defaultCellStyle),
  };
}

function hasVariationTableSemanticArgs(args: z.infer<typeof DraftInsertTableArgsSchema>): boolean {
  const hasSemanticVariationInput = (
    (args.criticalPoints?.length ?? 0) > 0 ||
    (args.intervalSigns?.length ?? 0) > 0 ||
    (args.derivativeSigns?.length ?? 0) > 0 ||
    (args.trends?.length ?? 0) > 0 ||
    (args.criticalValues?.length ?? 0) > 0 ||
    (args.functionValues?.length ?? 0) > 0
  );
  return hasSemanticVariationInput && args.kind !== "plain";
}

function createVariationTableSpecFromToolArgs(args: z.infer<typeof DraftInsertTableArgsSchema>, baseTable?: SigmaTableSpec): SigmaTableSpec {
  const criticalPoints = normalizeVariationTableValues(args.criticalPoints);
  const pointCount = criticalPoints.length;
  const intervalCount = pointCount + 1;
  const { intervalSigns, criticalDerivativeValues } = getVariationTableDerivativeValues(args, intervalCount, pointCount);
  const trends = getVariationTableTrends(args.trends, intervalSigns, intervalCount);
  const functionValues = normalizeVariationTableValues(args.functionValues);
  const criticalValues = getVariationTableCriticalValues(args.criticalValues, functionValues, pointCount);
  const [leftValue, rightValue] = getVariationTableEndpointValues(args.endpointValues, functionValues, pointCount);
  const xRow: Array<z.infer<typeof AiTableCellInputSchema>> = [
    args.variableLabel ?? "x",
    normalizeVariationTableValue(args.leftEndpoint, "-\\infty"),
  ];
  const derivativeRow: Array<z.infer<typeof AiTableCellInputSchema>> = [
    args.derivativeLabel ?? "f'(x)",
    "",
  ];
  const functionRow: Array<z.infer<typeof AiTableCellInputSchema>> = [
    args.functionLabel ?? "f(x)",
    leftValue,
  ];

  for (let index = 0; index < intervalCount; index += 1) {
    xRow.push("");
    derivativeRow.push(intervalSigns[index] ?? "");
    functionRow.push({ tex: trendDirectionTex(trends[index] ?? "flat") });

    if (index < pointCount) {
      xRow.push(criticalPoints[index]);
      derivativeRow.push(criticalDerivativeValues[index] ?? "0");
      functionRow.push(criticalValues[index] ?? "");
    }
  }

  xRow.push(normalizeVariationTableValue(args.rightEndpoint, "\\infty"));
  derivativeRow.push("");
  functionRow.push(rightValue);

  return createTableSpecFromToolArgs({
    kind: "variation",
    cells: [xRow, derivativeRow, functionRow],
    grid: args.grid,
    defaultCellStyle: args.defaultCellStyle,
  }, baseTable);
}

function getVariationTableDerivativeValues(
  args: z.infer<typeof DraftInsertTableArgsSchema>,
  intervalCount: number,
  pointCount: number,
): { intervalSigns: string[]; criticalDerivativeValues: string[] } {
  let intervalSigns = normalizeVariationTableValues(args.intervalSigns);
  let criticalDerivativeValues = normalizeVariationTableValues(args.criticalDerivativeValues);
  const derivativeSigns = stripVariationDerivativeLabel(normalizeVariationTableValues(args.derivativeSigns));

  if (intervalSigns.length === 0 && derivativeSigns.length > 0) {
    const compactSigns = derivativeSigns.filter((value) => value !== "");
    const source = compactSigns.length === intervalCount + pointCount ? compactSigns : derivativeSigns;
    if (source.length === intervalCount + pointCount) {
      intervalSigns = source.filter((_, index) => index % 2 === 0).slice(0, intervalCount);
      criticalDerivativeValues = criticalDerivativeValues.length > 0
        ? criticalDerivativeValues
        : source.filter((_, index) => index % 2 === 1).slice(0, pointCount);
    } else {
      intervalSigns = source.slice(0, intervalCount);
    }
  }

  if (intervalSigns.length === 0) {
    intervalSigns = getVariationTableTrends(args.trends, [], intervalCount).map(signForTrendDirection);
  }

  return {
    intervalSigns: padVariationValues(intervalSigns, intervalCount, ""),
    criticalDerivativeValues: padVariationValues(criticalDerivativeValues, pointCount, "0"),
  };
}

function stripVariationDerivativeLabel(values: string[]): string[] {
  const first = values[0]?.replace(/\s/g, "");
  if (!first || !first.includes("f") || !first.includes("x")) {
    return values;
  }

  return values.slice(1);
}

function getVariationTableTrends(
  input: z.infer<typeof AiVariationTrendSchema>[] | undefined,
  intervalSigns: string[],
  intervalCount: number,
): SigmaTableTrendDirection[] {
  const trends = (input ?? []).map((value) => normalizeTrendDirection(value));
  if (trends.length > 0) {
    return padVariationValues(trends, intervalCount, "flat");
  }

  return padVariationValues(intervalSigns.map(trendDirectionForSign), intervalCount, "flat");
}

function getVariationTableCriticalValues(
  input: z.infer<typeof AiVariationTableValueSchema>[] | undefined,
  functionValues: string[],
  pointCount: number,
): string[] {
  const explicit = normalizeVariationTableValues(input);
  if (explicit.length > 0) {
    return padVariationValues(explicit, pointCount, "");
  }

  if (functionValues.length === pointCount + 2) {
    return padVariationValues(functionValues.slice(1, -1), pointCount, "");
  }

  if (functionValues.length === pointCount) {
    return padVariationValues(functionValues, pointCount, "");
  }

  return padVariationValues([], pointCount, "");
}

function getVariationTableEndpointValues(
  input: z.infer<typeof AiVariationTableValueSchema>[] | undefined,
  functionValues: string[],
  pointCount: number,
): [string, string] {
  const explicit = normalizeVariationTableValues(input);
  if (explicit.length > 0) {
    return [explicit[0] ?? "", explicit[1] ?? ""];
  }

  if (functionValues.length === pointCount + 2) {
    return [functionValues[0] ?? "", functionValues[functionValues.length - 1] ?? ""];
  }

  return ["", ""];
}

function normalizeVariationTableValues(input: readonly z.infer<typeof AiVariationTableValueSchema>[] | undefined): string[] {
  return (input ?? []).map((value) => normalizeVariationTableValue(value, ""));
}

function normalizeVariationTableValue(value: z.infer<typeof AiVariationTableValueSchema> | undefined, fallback: string): string {
  if (value === null || value === undefined) {
    return fallback;
  }

  const text = String(value).trim();
  if (!text) {
    return fallback;
  }

  if (/^[+＋]?∞$/.test(text) || /^[+]?infinity$/i.test(text) || /^[+]?infty$/i.test(text)) {
    return "\\infty";
  }

  if (/^[−－-]∞$/.test(text) || /^[-−－]infinity$/i.test(text) || /^[-−－]infty$/i.test(text)) {
    return "-\\infty";
  }

  return text
    .replaceAll("∞", "\\infty")
    .replaceAll("±", "\\pm")
    .replace(/[−－]/g, "-")
    .replaceAll("＋", "+");
}

function padVariationValues<T>(values: T[], count: number, fallback: T): T[] {
  return Array.from({ length: count }, (_, index) => values[index] ?? fallback);
}

function trendDirectionForSign(sign: string): SigmaTableTrendDirection {
  const normalized = sign.trim();
  if (normalized === "+" || normalized === "\\plus") {
    return "up";
  }
  if (normalized === "-" || normalized === "\\minus") {
    return "down";
  }
  return "flat";
}

function signForTrendDirection(direction: SigmaTableTrendDirection): string {
  if (direction === "up") {
    return "+";
  }
  if (direction === "down") {
    return "-";
  }
  return "0";
}

function getDefaultAiTableShapeWidth(table: SigmaTableSpec): number {
  if (table.kind === "variation") {
    return Math.max(280, Math.min(720, 58 + Math.max(1, table.columns.length - 1) * 58));
  }

  return Math.max(220, table.columns.length * 86);
}

function getDefaultAiTableShapeHeight(table: SigmaTableSpec): number {
  return Math.max(table.kind === "variation" ? 116 : 92, table.rows.length * 34);
}

function getTableInputMatrix(args: z.infer<typeof DraftInsertTableArgsSchema>): Array<Array<z.infer<typeof AiTableCellInputSchema>>> {
  if (args.cells) {
    return args.cells;
  }

  const rows = args.rows ?? [];
  return rows.map((row) => Array.isArray(row.cells) ? row.cells as Array<z.infer<typeof AiTableCellInputSchema>> : []);
}

function getRowLabelCellInput(rowInput: Record<string, unknown> | undefined, columnIndex: number): z.infer<typeof AiTableCellInputSchema> {
  if (columnIndex !== 0 || !rowInput) {
    return undefined;
  }

  if (typeof rowInput.label === "string" || isRecord(rowInput.label)) {
    return rowInput.label;
  }

  return undefined;
}

// `baseColumn`/`baseRow` (below) come from the EXISTING tableShape when update_table rebuilds a
// table from content args (see createTableSpecFromAiToolArgs). When the caller doesn't specify a
// width/height for a given column/row index, we fall back to the existing table's track size at
// that index (preserving a user's manual resize) before falling back further to the hard-coded
// auto/fr default — never the other way around. `insert_table` never passes a base, so its
// defaults are unchanged.
function normalizeTableColumn(
  input: Record<string, unknown> | undefined,
  index: number,
  kind: SigmaTableKind,
  baseColumn?: SigmaTableColumn,
): SigmaTableColumn {
  const isLabelColumn = index === 0;
  const isPointColumn = kind === "variation" && index > 0 && index % 2 === 0;
  const hardcodedDefault: SigmaTableTrackSize = {
    mode: isLabelColumn || isPointColumn ? "auto" : "fr",
    ...(isLabelColumn ? { min: 48, max: 110 } : isPointColumn ? { min: 52, max: 110 } : { value: 1, min: 64 }),
  } as SigmaTableTrackSize;
  return {
    id: nonEmptyStringOr(input?.id, baseColumn?.id ?? `ai_table_col_${index + 1}`),
    width: normalizeTableTrackSize(input?.width, baseColumn?.width ?? hardcodedDefault),
    ...(normalizeTableColumnRole(input?.role, kind, index) ? { role: normalizeTableColumnRole(input?.role, kind, index) } : {}),
  };
}

function normalizeTableRow(
  input: Record<string, unknown> | undefined,
  index: number,
  kind: SigmaTableKind,
  baseRow?: SigmaTableRow,
): SigmaTableRow {
  return {
    id: nonEmptyStringOr(input?.id, baseRow?.id ?? `ai_table_row_${index + 1}`),
    height: normalizeTableTrackSize(input?.height, baseRow?.height ?? {
      mode: "auto",
      min: kind === "variation" && index === 2 ? 38 : index === 0 ? 34 : 32,
    }),
    ...(normalizeTableRowRole(input?.role, kind, index) ? { role: normalizeTableRowRole(input?.role, kind, index) } : {}),
  };
}

function normalizeTableColumnRole(value: unknown, kind: SigmaTableKind, index: number): SigmaTableColumnRole | undefined {
  if (value === "label" || value === "point" || value === "interval" || value === "value") {
    return value;
  }

  if (kind === "variation") {
    if (index === 0) {
      return "label";
    }
    return index % 2 === 0 ? "point" : "interval";
  }

  return index === 0 ? "label" : "value";
}

function normalizeTableRowRole(value: unknown, kind: SigmaTableKind, index: number): SigmaTableRowRole | undefined {
  if (
    value === "header" ||
    value === "body" ||
    value === "variable" ||
    value === "derivative" ||
    value === "variation" ||
    value === "note"
  ) {
    return value;
  }

  if (kind === "variation") {
    return index === 0 ? "variable" : index === 1 ? "derivative" : index === 2 ? "variation" : "note";
  }

  return index === 0 ? "header" : "body";
}

function normalizeTableTrackSize(input: unknown, fallback: SigmaTableTrackSize): SigmaTableTrackSize {
  if (!isRecord(input)) {
    return fallback;
  }

  if (input.mode === "fixed") {
    return { mode: "fixed", value: positiveNumberOr(input.value, 64) };
  }

  if (input.mode === "auto") {
    return {
      mode: "auto",
      ...(input.min === undefined ? {} : { min: positiveNumberOr(input.min, 1) }),
      ...(input.max === undefined ? {} : { max: positiveNumberOr(input.max, positiveNumberOr(input.min, 120)) }),
    };
  }

  if (input.mode === "fr") {
    return {
      mode: "fr",
      value: positiveNumberOr(input.value, 1),
      ...(input.min === undefined ? {} : { min: positiveNumberOr(input.min, 1) }),
      ...(input.max === undefined ? {} : { max: positiveNumberOr(input.max, positiveNumberOr(input.min, 120)) }),
    };
  }

  return fallback;
}

function createTableCell(
  rowId: string,
  columnId: string,
  input: z.infer<typeof AiTableCellInputSchema>,
  kind: SigmaTableKind,
  rowIndex: number,
  columnIndex: number,
): SigmaTableCell {
  const source = isRecord(input) ? input : {};
  return {
    id: nonEmptyStringOr(source.id, `ai_table_cell_${rowIndex + 1}_${columnIndex + 1}`),
    rowId,
    columnId,
    ...(positiveIntegerOrUndefined(source.rowSpan) ? { rowSpan: positiveIntegerOrUndefined(source.rowSpan) } : {}),
    ...(positiveIntegerOrUndefined(source.colSpan) ? { colSpan: positiveIntegerOrUndefined(source.colSpan) } : {}),
    content: normalizeTableCellContent(input, kind),
    ...(isRecord(source.style) ? { style: normalizeTableCellStyle(source.style, true) } : {}),
  };
}

function normalizeTableCellContent(
  input: z.infer<typeof AiTableCellInputSchema>,
  kind: SigmaTableKind,
): SigmaTableCellContent[] {
  if (input === undefined || input === null) {
    return [createTableCellParagraph([])];
  }

  if (typeof input === "string" || typeof input === "number") {
    return [createTableCellParagraph(normalizeVariationMathIfNeeded([{ type: "text", text: String(input) }], kind))];
  }

  if (input.type === "trend" || typeof input.trend === "string") {
    const direction = normalizeTrendDirection(input.direction ?? input.trend);
    if (kind === "variation") {
      const label = Array.isArray(input.label) ? normalizeAiInlineNodes(input.label) : [];
      return [createTableCellParagraph([createMathInline(trendDirectionTex(direction), undefined), ...label], input)];
    }

    return [{
      type: "trend",
      id: nonEmptyStringOr(input.id, createId("ai_table_trend")),
      direction,
      ...(Array.isArray(input.label) ? { label: normalizeAiInlineNodes(input.label) } : {}),
    }];
  }

  if (input.type === "convexity" || typeof input.convexity === "string" || typeof input.curvature === "string") {
    return [createTableCellParagraph([
      createMathInline(convexityTex(input.direction ?? input.convexity ?? input.curvature), undefined),
    ], input)];
  }

  if (Array.isArray(input.content)) {
    return input.content.flatMap((item) => normalizeTableCellContent(item as z.infer<typeof AiTableCellInputSchema>, kind));
  }

  const children = normalizeVariationMathIfNeeded(normalizeAiInlineContent(input), kind);
  return [createTableCellParagraph(children, input)];
}

function createTableCellParagraph(children: InlineNode[], source: Record<string, unknown> = {}): SigmaTableCellContent {
  return {
    type: "paragraph",
    id: nonEmptyStringOr(source.id, createId("ai_table_p")),
    children,
    ...(normalizeTextAlign(source.align) ? { align: normalizeTextAlign(source.align) } : {}),
  };
}

function normalizeVariationMathIfNeeded(children: InlineNode[], kind: SigmaTableKind): InlineNode[] {
  if (kind !== "variation" || children.length !== 1 || children[0].type !== "text") {
    return children;
  }

  const tex = textToVariationMathTex(children[0].text);
  return tex ? [createMathInline(tex, undefined)] : children;
}

function textToVariationMathTex(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const semanticTex = variationSemanticTextToMathTex(trimmed);
  if (semanticTex) {
    return semanticTex;
  }

  if (trimmed === "~" || trimmed === "〜") {
    return "\\sim";
  }

  const mathLike = /^[A-Za-z0-9+\-−－＋*/=<>^_\\'().,{}\[\]\s~∞±]+$/u;
  const hasMathSignal = /[A-Za-z0-9+\-−－＋*/=<>^_\\'~∞±]/u.test(trimmed);
  if (!mathLike.test(trimmed) || !hasMathSignal) {
    return null;
  }

  return trimmed
    .replaceAll("∞", "\\infty")
    .replaceAll("±", "\\pm")
    .replace(/[−－]/g, "-")
    .replaceAll("＋", "+")
    .replaceAll("~", "\\sim");
}

/**
 * 増減表のセルに書かれた語を TeX の記号へ寄せる。
 *
 * **これは表示文言ではなくモデルが書いてくる入力の語彙**なので、訳すのではなく
 * 「その言語で実際に書かれる語」を足す。プロンプトが英語になるとモデルは英語で
 * 書いてくるので、日本語だけを見ていると増減表が記号にならない (WI-8 で英語を追加)。
 */
const VARIATION_SEMANTIC_TEX: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["\\nearrow", ["↗", "↑", "増加", "上昇", "increasing", "increase", "up", "rising"]],
  ["\\searrow", ["↘", "↓", "減少", "下降", "decreasing", "decrease", "down", "falling"]],
  ["\\rightarrow", ["→", "横ばい", "一定", "constant", "flat", "unchanged", "steady"]],
  ["\\cap", ["上に凸", "上凸", "∩", "concave down", "convex up", "concave-down"]],
  ["\\cup", ["下に凸", "下凸", "∪", "concave up", "convex down", "concave-up"]],
];

function variationSemanticTextToMathTex(text: string): string | null {
  const normalized = text.trim().toLowerCase();
  for (const [tex, words] of VARIATION_SEMANTIC_TEX) {
    if (words.some((word) => word.toLowerCase() === normalized)) {
      return tex;
    }
  }
  return null;
}

function normalizeTrendDirection(value: unknown): SigmaTableTrendDirection {
  return value === "up" || value === "down" || value === "flat" ? value : "flat";
}

function trendDirectionTex(direction: SigmaTableTrendDirection): string {
  if (direction === "up") {
    return "\\nearrow";
  }

  if (direction === "down") {
    return "\\searrow";
  }

  return "\\rightarrow";
}

function convexityTex(value: unknown): string {
  if (
    value === "up" ||
    value === "upper" ||
    value === "convexUp" ||
    value === "concaveDown" ||
    value === "cap" ||
    value === "上に凸" ||
    value === "上凸"
  ) {
    return "\\cap";
  }

  if (
    value === "down" ||
    value === "lower" ||
    value === "convexDown" ||
    value === "concaveUp" ||
    value === "cup" ||
    value === "下に凸" ||
    value === "下凸"
  ) {
    return "\\cup";
  }

  return "\\rightarrow";
}

// `base` is the EXISTING table's grid style (update_table content-mode rebuild only — see
// normalizeTableColumn's comment above). Any field the caller didn't specify falls back to the
// existing table's value before the hard-coded default, so re-supplying `cells` alone doesn't
// silently reset a previously-customized border style. `insert_table` never passes a base.
function normalizeTableGridStyle(input: unknown, base?: SigmaTableGridStyle): SigmaTableGridStyle {
  const grid = isRecord(input) ? input : {};
  const fallback: SigmaTableGridStyle = base ?? {
    borderColor: "#111827",
    borderWidth: 1,
    borderStyle: "solid",
    showOuterBorder: true,
    showInnerBorders: true,
  };
  return {
    borderColor: typeof grid.borderColor === "string" ? grid.borderColor : fallback.borderColor,
    borderWidth: grid.borderWidth === undefined ? fallback.borderWidth : nonnegativeNumberOr(grid.borderWidth, 1),
    borderStyle: grid.borderStyle === undefined ? (fallback.borderStyle ?? "solid") : normalizeTableBorderStyle(grid.borderStyle),
    showOuterBorder: typeof grid.showOuterBorder === "boolean" ? grid.showOuterBorder : fallback.showOuterBorder ?? true,
    showInnerBorders: typeof grid.showInnerBorders === "boolean" ? grid.showInnerBorders : fallback.showInnerBorders ?? true,
  };
}

function normalizeTableBorderStyle(value: unknown): SigmaTableBorderStyle {
  return value === "solid" || value === "dashed" || value === "dotted" || value === "double" ? value : "solid";
}

// `base` is the EXISTING table's defaultCellStyle (update_table content-mode rebuild only, see
// normalizeTableColumn's comment above) — never passed for the per-cell `style` override
// (partial:true call from createTableCell), which has no analogous "existing per-cell style at
// this index" to preserve. When `base` is present its fields become the "unspecified" default
// instead of the hard-coded ones, so re-supplying `cells` alone doesn't reset a previously
// customized defaultCellStyle. `insert_table` never passes a base.
function normalizeTableCellStyle(input: unknown, partial = false, base?: SigmaTableCellStyle): SigmaTableCellStyle {
  const style = isRecord(input) ? input : {};
  if (partial) {
    return {
      ...(normalizeTextAlign(style.align) ? { align: normalizeTextAlign(style.align) } : {}),
      ...(style.verticalAlign === "top" || style.verticalAlign === "middle" || style.verticalAlign === "bottom"
        ? { verticalAlign: style.verticalAlign }
        : {}),
      ...(style.paddingX === undefined ? {} : { paddingX: nonnegativeNumberOr(style.paddingX, 8) }),
      ...(style.paddingY === undefined ? {} : { paddingY: nonnegativeNumberOr(style.paddingY, 5) }),
      ...(typeof style.color === "string" ? { color: style.color } : {}),
      ...(typeof style.backgroundColor === "string" ? { backgroundColor: style.backgroundColor } : {}),
      ...(typeof style.fontFamily === "string" ? { fontFamily: style.fontFamily } : {}),
      ...(style.fontSize === undefined ? {} : { fontSize: positiveNumberOr(style.fontSize, 15) }),
      ...(style.fontWeight === "normal" || style.fontWeight === "bold" ? { fontWeight: style.fontWeight } : {}),
    };
  }

  const fallback: SigmaTableCellStyle = base ?? {
    align: "center",
    verticalAlign: "middle",
    paddingX: 8,
    paddingY: 5,
    color: "#111827",
    fontWeight: "normal",
  };
  return {
    align: normalizeTextAlign(style.align) ?? fallback.align ?? "center",
    verticalAlign: (style.verticalAlign === "top" || style.verticalAlign === "middle" || style.verticalAlign === "bottom")
      ? style.verticalAlign
      : fallback.verticalAlign ?? "middle",
    paddingX: style.paddingX === undefined ? (fallback.paddingX ?? 8) : nonnegativeNumberOr(style.paddingX, 8),
    paddingY: style.paddingY === undefined ? (fallback.paddingY ?? 5) : nonnegativeNumberOr(style.paddingY, 5),
    color: typeof style.color === "string" ? style.color : fallback.color ?? "#111827",
    ...(typeof style.backgroundColor === "string"
      ? { backgroundColor: style.backgroundColor }
      : fallback.backgroundColor !== undefined ? { backgroundColor: fallback.backgroundColor } : {}),
    ...(typeof style.fontFamily === "string"
      ? { fontFamily: style.fontFamily }
      : fallback.fontFamily !== undefined ? { fontFamily: fallback.fontFamily } : {}),
    fontSize: style.fontSize === undefined ? (fallback.fontSize ?? 15) : positiveNumberOr(style.fontSize, 15),
    fontWeight: (style.fontWeight === "normal" || style.fontWeight === "bold") ? style.fontWeight : fallback.fontWeight ?? "normal",
  };
}

function createGraphSpecFromToolArgs(args: z.infer<typeof DraftInsertGraphArgsSchema>): Graph2DSpec {
  const kind = args.kind ?? "cartesian";
  const plotBox = getGraphPlotBox({ kind } as Graph2DSpec);
  return {
    kind,
    title: args.title ?? "",
    width: args.width ?? (args.w === undefined ? 560 : args.w + plotBox.left + plotBox.right),
    height: args.height ?? (args.h === undefined ? (kind === "numberLine" ? 150 : 320) : args.h + plotBox.top + plotBox.bottom),
    viewBox: normalizeGraphViewBox(args.viewBox, getDefaultGraphViewBox(kind)),
    ...(args.graphViewBox ? { graphViewBox: normalizeGraphViewBox(args.graphViewBox, getDefaultGraphViewBox(kind)) } : {}),
    axes: normalizeGraphAxes(args.axes, kind),
    curves: (args.curves ?? []).map((curve, index, curves) => normalizeGraphCurve(curve, index, curves.length)),
    ...(args.points ? { points: args.points.map((point, index) => normalizeGraphPoint(point, index)) } : {}),
    ...(args.annotations ? { annotations: args.annotations.map((annotation, index) => normalizeGraphAnnotation(annotation, index)) } : {}),
    ...(args.fills ? { fills: args.fills.map((fill, index) => normalizeGraphFill(fill, index)) } : {}),
    ...(args.showFormulaLabels === undefined ? {} : { showFormulaLabels: args.showFormulaLabels }),
  };
}

function normalizeGraphSpec(input: Graph2DSpec): Graph2DSpec {
  const source: Record<string, unknown> = isRecord(input) ? input as unknown as Record<string, unknown> : {};
  const kind = source.kind === "numberLine" ? "numberLine" : "cartesian";
  const spec: Graph2DSpec = {
    kind,
    title: typeof source.title === "string" ? source.title : "",
    width: positiveNumberOr(source.width, 560),
    height: positiveNumberOr(source.height, kind === "numberLine" ? 150 : 320),
    viewBox: normalizeGraphViewBox(source.viewBox, getDefaultGraphViewBox(kind)),
    ...(isRecord(source.graphViewBox) ? {
      graphViewBox: normalizeGraphViewBox(source.graphViewBox, getDefaultGraphViewBox(kind)),
    } : {}),
    axes: normalizeGraphAxes(source.axes, kind),
    curves: Array.isArray(source.curves)
      ? source.curves.map((curve, index, curves) => normalizeGraphCurve(curve, index, curves.length))
      : [],
    ...(Array.isArray(source.points) ? {
      points: source.points.map((point, index) => normalizeGraphPoint(point, index)),
    } : {}),
    ...(Array.isArray(source.annotations) ? {
      annotations: source.annotations.map((annotation, index) => normalizeGraphAnnotation(annotation, index)),
    } : {}),
    ...(Array.isArray(source.fills) ? {
      fills: source.fills.map((fill, index) => normalizeGraphFill(fill, index)),
    } : {}),
    ...(typeof source.showFormulaLabels === "boolean" ? { showFormulaLabels: source.showFormulaLabels } : {}),
  };
  return spec;
}

function getDefaultGraphViewBox(kind: "cartesian" | "numberLine"): GraphViewBox {
  return kind === "numberLine"
    ? { xMin: "0", xMax: "5", yMin: "-1", yMax: "1" }
    : { xMin: "-5", xMax: "5", yMin: "-5", yMax: "5" };
}

function normalizeGraphViewBox(input: unknown, fallback: GraphViewBox): GraphViewBox {
  const source = isRecord(input) ? input : {};
  return {
    xMin: stringOr(source.xMin, fallback.xMin),
    xMax: stringOr(source.xMax, fallback.xMax),
    yMin: stringOr(source.yMin, fallback.yMin),
    yMax: stringOr(source.yMax, fallback.yMax),
  };
}

function normalizeGraphAxes(input: unknown, kind: "cartesian" | "numberLine"): GraphAxes {
  const axes = isRecord(input) ? input : {};
  return {
    grid: typeof axes.grid === "boolean" ? axes.grid : false,
    showX: typeof axes.showX === "boolean" ? axes.showX : true,
    showY: typeof axes.showY === "boolean" ? axes.showY : kind === "cartesian",
    showTicks: typeof axes.showTicks === "boolean" ? axes.showTicks : false,
    xLabel: typeof axes.xLabel === "string" ? axes.xLabel : "x",
    ...(kind === "cartesian" ? { yLabel: typeof axes.yLabel === "string" ? axes.yLabel : "y" } : {}),
    ...(typeof axes.originLabel === "string" ? { originLabel: axes.originLabel } : {}),
    ...(typeof axes.tickFontSize === "number" && Number.isFinite(axes.tickFontSize) && axes.tickFontSize > 0
      ? { tickFontSize: axes.tickFontSize }
      : {}),
    xTickStep: typeof axes.xTickStep === "string" ? axes.xTickStep : "1",
    ...(kind === "cartesian" ? { yTickStep: typeof axes.yTickStep === "string" ? axes.yTickStep : "1" } : {}),
    ...(axes.xTickMode === "pi" || axes.xTickMode === "number" ? { xTickMode: axes.xTickMode } : {}),
    ...(axes.yTickMode === "pi" || axes.yTickMode === "number" ? { yTickMode: axes.yTickMode } : {}),
  };
}

// グラフは白黒印刷を基本とするため、AI挿入時の既定色は黒とグレー階調のみを循環させる。
// 複数曲線を色だけで区別しない設計なので、色を指定しなかった曲線どうしは代わりに
// 線種 (dash) で区別する (normalizeGraphCurve 参照)。ユーザーが明示した色は常にそのまま使う。
const GRAPH_COLOR_SEQUENCE = ["#0d0d0d", "#6b7280", "#9ca3af", "#0d0d0d", "#6b7280"] as const;

function normalizeGraphCurve(input: unknown, index: number, totalCurves: number): GraphCurve {
  const curve = isRecord(input) ? input : {};
  const mode = normalizeGraphCurveModeValue(curve.mode, curve);
  const expr = mode === "parametric"
    ? stringOr(curve.expr, stringOr(curve.xExpr, ""))
    : stringOr(curve.expr, stringOr(curve.yExpr, ""));
  const hasExplicitColor = isValidHexColor(curve.color);
  // 色を指定されず、かつ他にも曲線がある場合は、白黒でも区別できるよう
  // 主曲線 (index 0) 以外を破線にする。色を明示された曲線はそのまま実線扱いにできる。
  const dashFallback: GraphCurveDash = !hasExplicitColor && totalCurves > 1 && index > 0 ? "dashed" : "solid";
  return {
    id: nonEmptyStringOr(curve.id, `ai_curve_${index + 1}`),
    expr,
    ...(mode === "parametric" ? { yExpr: stringOr(curve.yExpr, "") } : {}),
    ...(typeof curve.label === "string" ? { label: curve.label } : {}),
    color: normalizeGraphColor(curve.color, index),
    mode,
    dash: normalizeGraphCurveDash(curve.dash, dashFallback),
    strokeWidth: positiveNumberOr(curve.strokeWidth, 2.4),
    ...(isRecord(curve.domain) ? {
      domain: {
        ...(curve.domain.min === undefined ? {} : { min: stringOr(curve.domain.min, "") }),
        ...(curve.domain.max === undefined ? {} : { max: stringOr(curve.domain.max, "") }),
      },
    } : {}),
    ...(positiveIntegerOrUndefined(curve.samples) ? { samples: positiveIntegerOrUndefined(curve.samples) } : {}),
  };
}

function normalizeGraphCurveModeValue(value: unknown, curve: Record<string, unknown>): GraphCurveMode {
  if (value === "xOfY" || value === "parametric" || value === "yOfX" || value === "implicit") {
    return value;
  }

  if (typeof curve.xExpr === "string" && typeof curve.yExpr === "string") {
    return "parametric";
  }

  return "yOfX";
}

function normalizeGraphCurveDash(value: unknown, fallback: GraphCurveDash = "solid"): GraphCurveDash {
  return value === "dashed" || value === "dotted" || value === "solid" ? value : fallback;
}

const GRAPH_POINT_LABEL_PLACEMENTS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;

function normalizeGraphPointLabelPlacement(value: unknown): GraphPointLabelPlacement | undefined {
  return (GRAPH_POINT_LABEL_PLACEMENTS as readonly unknown[]).includes(value)
    ? (value as GraphPointLabelPlacement)
    : undefined;
}

function normalizeGraphPoint(input: unknown, index: number): GraphPoint {
  const point = isRecord(input) ? input : {};
  const labelPlacement = normalizeGraphPointLabelPlacement(point.labelPlacement);
  return {
    id: nonEmptyStringOr(point.id, `ai_point_${index + 1}`),
    x: stringOr(point.x, "0"),
    y: stringOr(point.y, "0"),
    ...(typeof point.label === "string" ? { label: point.label } : {}),
    ...(labelPlacement ? { labelPlacement } : {}),
    // 白黒基調が基本のため、色を指定しなかった点は既定で黒にする (色付きの点を描いたつもりがない限り赤にならないようにする)。
    color: isValidHexColor(point.color) ? point.color : "#0d0d0d",
    ...(point.fill === "none" || point.fill === "solid" ? { fill: point.fill } : {}),
    ...(typeof point.radius === "number" && Number.isFinite(point.radius) ? { radius: point.radius } : {}),
    ...(typeof point.showXProjection === "boolean" ? { showXProjection: point.showXProjection } : {}),
    ...(typeof point.showYProjection === "boolean" ? { showYProjection: point.showYProjection } : {}),
  };
}

function normalizeGraphAnnotation(input: unknown, index: number): GraphAnnotation {
  const annotation = isRecord(input) ? input : {};
  return {
    id: nonEmptyStringOr(annotation.id, `ai_annotation_${index + 1}`),
    x: stringOr(annotation.x, "0"),
    y: stringOr(annotation.y, "0"),
    text: stringOr(annotation.text, stringOr(annotation.label, "")),
  };
}

function normalizeGraphFill(input: unknown, index: number): GraphFillRegion {
  const fill = isRecord(input) ? input : {};
  return {
    id: nonEmptyStringOr(fill.id, `ai_fill_${index + 1}`),
    x: stringOr(fill.x, "0"),
    y: stringOr(fill.y, "0"),
    // 白黒基調が基本のため、色を指定しなかった塗り領域は薄いグレーにする。
    color: isValidHexColor(fill.color) ? fill.color : "#d1d5db",
    ...(typeof fill.opacity === "number" ? { opacity: fill.opacity } : { opacity: 0.5 }),
    ...(fill.pattern === "solid" ||
      fill.pattern === "diagonal" ||
      fill.pattern === "diagonalBack" ||
      fill.pattern === "cross" ||
      fill.pattern === "horizontal" ||
      fill.pattern === "vertical" ||
      fill.pattern === "dots"
      ? { pattern: fill.pattern }
      : {}),
  };
}

function isValidHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function normalizeGraphColor(value: unknown, index: number): string {
  return isValidHexColor(value) ? value : GRAPH_COLOR_SEQUENCE[index % GRAPH_COLOR_SEQUENCE.length];
}

function normalizeRichBlockMath<T extends ProblemAreaBlock | ProblemNode>(block: T): T {
  if (block.type === "problem") return { ...block,
    lead: block.lead.map(normalizeRichBlockMath), prompt: block.prompt.map(normalizeRichBlockMath),
    hints: block.hints.map(normalizeRichBlockMath), solution: block.solution.map(normalizeRichBlockMath),
  };
  if (block.type === "layoutSection") {
    return {
      ...block,
      children: block.children.map(normalizeLayoutSectionChildMath),
    } as T;
  }
  if (block.type === "boxBlock") {
    return normalizeLayoutSectionChildMath(block) as T;
  }
  if (block.type === "list") {
    return normalizeListBlockMath(block) as T;
  }
  if (block.type === "divider") {
    return block;
  }
  if (block.type === "quote") {
    return {
      ...block,
      blocks: block.blocks.map((child) => normalizeLayoutSectionChildMath(child) as typeof child),
    } as T;
  }

  return { ...block, children: block.children.map(normalizeInlineMath) } as T;
}

function normalizeLayoutSectionChildMath(block: LayoutSectionChildBlock): LayoutSectionChildBlock {
  if (block.type === "section") {
    return block;
  }
  if (block.type === "boxBlock") {
    return {
      ...block,
      title: block.title?.map(normalizeInlineMath),
      blocks: block.blocks.map((child) => child.type === "layoutSection" || child.type === "problem"
        ? normalizeRichBlockMath(child)
        : normalizeLayoutSectionChildMath(child)),
    };
  }
  return normalizeRichBlockMath(block) as LayoutSectionChildBlock;
}

function normalizeListBlockMath(block: Extract<RichBlock, { type: "list" }>): Extract<RichBlock, { type: "list" }> {
  return {
    ...block,
    items: block.items.map((item) => ({
      ...item,
      children: item.children.map(normalizeInlineMath),
      continuations: item.continuations?.map((continuation) => ({
        ...continuation,
        children: listItemContinuationInlineNodes(continuation).map(normalizeInlineMath),
      })),
      nested: item.nested?.map(normalizeListBlockMath),
    })),
  };
}

function normalizeProblemMath(problem: ProblemNode): ProblemNode {
  return {
    ...problem,
    lead: problem.lead.map(normalizeRichBlockMath),
    prompt: problem.prompt.map(normalizeRichBlockMath),
    solution: problem.solution.map(normalizeRichBlockMath),
    hints: problem.hints.map(normalizeRichBlockMath),
  };
}

function normalizeInlineMath<T extends { type: string }>(node: T): T {
  if (node.type !== "mathInline" || !("tex" in node) || typeof node.tex !== "string") {
    return node;
  }
  return {
    ...node,
    tex: normalizeLikelyAiMathNewlines(node.tex),
  };
}

function normalizeLikelyAiMathNewlines(tex: string): string {
  return tex.includes("//") ? tex.replace(/\/\//g, "\\\\") : tex;
}

function assertRichBlocksDoNotContainVariationTableArray(
  blocks: (
    | RichBlock
    | QuoteBlockNode
    | CodeBlockNode
    | DividerNode
    | BoxBlockNode
    | LayoutSectionNode
    | SectionNode
    | ProblemNode
  )[],
): void {
  for (const block of blocks) {
    if (block.type === "layoutSection") {
      for (const child of block.children) {
        if (child.type === "heading" || child.type === "paragraph") {
          assertInlineNodesDoNotContainVariationTableArray(child.children);
        } else if (child.type === "list") {
          assertRichBlocksDoNotContainVariationTableArray([child]);
        } else if (child.type === "boxBlock") {
          for (const boxChild of child.blocks) {
            if (boxChild.type === "layoutSection") {
              assertRichBlocksDoNotContainVariationTableArray([boxChild]);
            }
          }
        }
      }
      continue;
    }
    if (block.type === "list") {
      for (const item of block.items) {
        assertInlineNodesDoNotContainVariationTableArray(item.children);
        assertRichBlocksDoNotContainVariationTableArray(item.continuations ?? []);
        assertRichBlocksDoNotContainVariationTableArray(item.nested ?? []);
      }
      continue;
    }
    if (block.type === "boxBlock") {
      for (const child of block.blocks) {
        if (child.type === "layoutSection") {
          assertRichBlocksDoNotContainVariationTableArray([child]);
        } else if (child.type === "section" || child.type === "divider") {
          // SectionNode / DividerNode は中身を持たない
        } else {
          // RichBlock (paragraph, heading, list, boxBlock)
          assertRichBlocksDoNotContainVariationTableArray([child]);
        }
      }
      continue;
    }
    if (block.type === "section" || block.type === "divider") {
      // SectionNode / DividerNode have no children to check
      continue;
    }
    if (block.type === "quote") {
      assertRichBlocksDoNotContainVariationTableArray(block.blocks);
      continue;
    }

    if (block.type === "problem") {
      assertProblemDoesNotContainVariationTableArray(block);
      continue;
    }
    assertInlineNodesDoNotContainVariationTableArray(block.children);
  }
}

function assertProblemDoesNotContainVariationTableArray(problem: ProblemNode): void {
  assertRichBlocksDoNotContainVariationTableArray([
    ...problem.lead,
    ...problem.prompt,
    ...problem.solution,
    ...problem.hints,
  ]);

  if (problem.answer?.type === "math" && looksLikeVariationTableArrayTex(problem.answer.expected)) {
    throw new Error(tv("tools.variationTableNotArray"));
  }
}

function assertInlineNodesDoNotContainVariationTableArray(children: InlineNode[]): void {
  for (const child of children) {
    if (child.type === "mathInline" && looksLikeVariationTableArrayTex(child.tex)) {
      throw new Error(tv("tools.variationTableNotArray"));
    }
  }
}



function looksLikeVariationTableArrayTex(tex: string): boolean {
  const compact = tex.replace(/\s+/g, "");
  if (!/\\begin\{array\}/.test(compact)) {
    return false;
  }

  return (
    /\\(?:nearrow|searrow|rightarrow|uparrow|downarrow|cap|cup)/.test(compact) ||
    /[↗↘↑↓∩∪]/u.test(tex) ||
    /増減|単調|極大|極小|導関数|上に凸|下に凸/u.test(tex) ||
    /f(?:['’′]|\\prime|\^\{?\\prime\}?)\(x\)/.test(compact)
  );
}

interface OverlayInsertionTarget {
  targetId: string;
  preOperations: AiEditDraft[];
  changedIds: string[];
}

function resolveOverlayInsertionTarget(
  session: SigmaDocAgentSession,
  requestedTargetId: string | undefined,
  area: ProblemAreaKind | undefined,
): OverlayInsertionTarget {
  const isWhiteboard = session.draftDocument.pageLayout && isWhiteboardPageLayout(session.draftDocument.pageLayout);

  // In whiteboard mode, CANVAS is the sentinel for absolute canvas insertion.
  if (isWhiteboard && requestedTargetId?.trim() === "CANVAS") {
    if (area) {
      throw new Error(tv("tools.whiteboardAreaUnsupported"));
    }
    return {
      targetId: "CANVAS",
      preOperations: [],
      changedIds: [],
    };
  }
  if (isWhiteboard) {
    throw new Error(tv("tools.whiteboardCanvasTargetRequired"));
  }

  const targetId = getTargetId(session, requestedTargetId);
  const targetBlock = findBlock(session.draftDocument, targetId);

  if (area) {
    const problem = findContainingProblem(session.draftDocument, targetId);
    if (!problem) {
      throw new Error(tv("tools.resolveOverlayInsertionTarget1"));
    }
    return resolveProblemAreaOverlayInsertionTarget(problem, area, targetId);
  }

  if (targetBlock?.type === "problem") {
    return resolveProblemAreaOverlayInsertionTarget(targetBlock, "prompt", targetBlock.id);
  }

  return {
    targetId,
    preOperations: [],
    changedIds: [],
  };
}

function resolveProblemAreaOverlayInsertionTarget(
  problem: ProblemNode,
  area: ProblemAreaKind,
  requestedTargetId: string,
): OverlayInsertionTarget {
  const requestedBlock = problem[area].find((block) => block.id === requestedTargetId);
  const existingBlock = requestedBlock ?? problem[area][0];
  if (existingBlock) {
    return {
      targetId: existingBlock.id,
      preOperations: [],
      changedIds: [],
    };
  }
  // Overlay is an independent layer. An empty problem area must not be
  // materialized as a body paragraph merely to obtain an anchor; anchoring to
  // the containing problem keeps the requested visual insertion additive.
  return {
    targetId: problem.id,
    preOperations: [],
    changedIds: [],
  };
}

/**
 * 生の overlay shape (素材クローン / insert_overlay_shape) は既に絶対 x/y を持つので、
 * `dx = x - blockLeft` / `dy = y - blockTop` でブロックアンカーへ変換する。
 * `type:"shape"` アンカー (グラフ所有ラベル) は force でも温存する。
 */
function withDefaultBlockAnchor<T extends OverlayShape>(
  shape: T,
  document: SigmaDocument,
  targetId: string,
  force = false,
): T {
  return anchorAbsoluteShape(shape, { document, anchorBlockId: targetId, force });
}

/**
 * 単一図形の挿入で、図形IDが空、または現在のドラフト本文の既存ブロックID/
 * オーバーレイ図形IDと衝突する場合に、新しい一意IDを採番する。
 * 1ツール=1図形で他から参照されないため、ID差し替えは安全
 * (相互参照を持つグラフ等の複数図形ツールでは使用しない)。
 */
function ensureUniqueOverlayShapeId<T extends OverlayShape>(session: SigmaDocAgentSession, shape: T): T {
  const allocator = createTakenIdAllocator(session);
  const nextId = allocator.allocate(shape.id, getOverlayShapeIdPrefix(shape));
  return nextId === shape.id ? shape : { ...shape, id: nextId };
}

function ensureUniqueOverlayShapeSet(
  session: SigmaDocAgentSession,
  input: { shape: OverlayGraphShape; labelShapes: OverlayShape[] },
): { shape: OverlayGraphShape; labelShapes: OverlayShape[] } {
  const allocator = createTakenIdAllocator(session);
  const idMap = new Map<string, string>();
  const shapes = [input.shape, ...input.labelShapes].map((shape) => {
    const nextId = allocator.allocate(shape.id, getOverlayShapeIdPrefix(shape));
    if (nextId !== shape.id) {
      idMap.set(shape.id, nextId);
    }
    return nextId === shape.id ? shape : { ...shape, id: nextId };
  });
  const remappedShapes = shapes.map((shape) => remapOverlayShapeReferences(shape, idMap));
  return {
    shape: remappedShapes[0] as OverlayGraphShape,
    labelShapes: remappedShapes.slice(1),
  };
}

function getOverlayShapeIdPrefix(shape: OverlayShape): string {
  if (shape.type === "tableShape") {
    return "ai_table";
  }
  if (shape.type === "graph2dShape") {
    return "ai_graph";
  }
  if (shape.type === "graph3dShape") {
    return "ai_graph3d";
  }
  if (shape.type === "image") {
    return "ai_image";
  }
  return "ai_shape";
}

function remapOverlayShapeReferences<T extends OverlayShape>(shape: T, idMap: Map<string, string>): T {
  if (idMap.size === 0) {
    return shape;
  }

  const base = {
    ...shape,
    ...(shape.parentId && idMap.has(shape.parentId) ? { parentId: idMap.get(shape.parentId) } : {}),
    ...(shape.anchor?.type === "shape" && idMap.has(shape.anchor.shapeId)
      ? { anchor: { ...shape.anchor, shapeId: idMap.get(shape.anchor.shapeId)! } }
      : {}),
  } as T;

  if (base.type !== "graph2dShape") {
    return base;
  }

  return {
    ...base,
    props: {
      ...base.props,
      ...(base.props.axisLabelTextShapeIds ? {
        axisLabelTextShapeIds: Object.fromEntries(
          Object.entries(base.props.axisLabelTextShapeIds).map(([key, id]) => [key, idMap.get(id) ?? id]),
        ),
      } : {}),
      ...(base.props.pointLabelTextShapeIdsByPointId ? {
        pointLabelTextShapeIdsByPointId: Object.fromEntries(
          Object.entries(base.props.pointLabelTextShapeIdsByPointId).map(([key, id]) => [key, idMap.get(id) ?? id]),
        ),
      } : {}),
      ...(base.props.annotationTextShapeIdsByAnnotationId ? {
        annotationTextShapeIdsByAnnotationId: Object.fromEntries(
          Object.entries(base.props.annotationTextShapeIdsByAnnotationId).map(([key, id]) => [key, idMap.get(id) ?? id]),
        ),
      } : {}),
      ...(base.props.labelTextShapeIds ? {
        labelTextShapeIds: base.props.labelTextShapeIds.map((id) => idMap.get(id) ?? id),
      } : {}),
      ...(base.props.labelTextShapeIdsByCurveId ? {
        labelTextShapeIdsByCurveId: Object.fromEntries(
          Object.entries(base.props.labelTextShapeIdsByCurveId).map(([key, id]) => [key, idMap.get(id) ?? id]),
        ),
      } : {}),
    },
  } as T;
}

type DraftInsertShapeArgs = z.infer<typeof DraftInsertShapeArgsSchema>;

const AI_TEXT_SHAPE_MIN_WIDTH = 8;
const AI_SHAPE_LABEL_PADDING_X = 32;
const AI_SHAPE_LABEL_PADDING_Y = 24;

const AI_CALLOUT_PADDING = 12;
const AI_CALLOUT_DEFAULT_TAIL_DEPTH = 28;

function createOverlayShapeFromShapeToolArgs(
  args: DraftInsertShapeArgs,
  document: SigmaDocument,
  targetId: string,
): OverlayShape {
  const id = args.id ?? createId("ai_shape");
  const color = args.color ?? (args.kind === "highlight" ? "#facc15" : "black");
  const fillColor = args.fillColor ?? (
    args.kind === "highlight"
      ? "#facc15"
      : args.kind === "blockArrow"
        ? "#bfdbfe"
        : args.kind === "sector"
          ? "#e5e7eb"
          : "#ffffff"
  );
  const dash = normalizeOverlayDash(args.dash);
  const size = normalizeOverlayTextSize(args.size);
  const opacity = args.opacity ?? (args.kind === "highlight" ? 0.45 : undefined);
  const common = {
    id,
    rotation: args.rotation ?? 0,
    ...(args.stackLayer ? { stackLayer: args.stackLayer } : {}),
    ...(opacity === undefined ? {} : { opacity }),
  };

  if (isGeoShapeToolKind(args.kind)) {
    const defaultSize = getDefaultShapeToolSize(args.kind, args.label, size);
    const requestedSize = getRequestedGeoShapeToolSize(args, defaultSize);
    const box = getShapeToolBox(args, requestedSize);
    const isCircle = args.kind === "circle";
    const circleSize = Math.max(box.w, box.h);
    const x = isCircle ? box.x + (box.w - circleSize) / 2 : box.x;
    const y = isCircle ? box.y + (box.h - circleSize) / 2 : box.y;
    const w = isCircle ? circleSize : box.w;
    const h = isCircle ? circleSize : box.h;
    const fill = args.fill ?? (args.kind === "highlight" || args.kind === "blockArrow" ? "solid" : "none");
    const placed = resolveShapeToolPlacement(args, document, targetId, { x, y });
    return {
      ...common,
      type: "geo",
      x: placed.x,
      y: placed.y,
      anchor: placed.anchor,
      props: {
        w,
        h,
        geo: args.kind === "circle" || args.kind === "ellipse" ? "ellipse" : args.kind === "highlight" ? "rectangle" : args.kind,
        fill,
        color,
        fillColor,
        ...(args.strokeOpacity === undefined ? {} : { strokeOpacity: args.strokeOpacity }),
        ...(args.fillOpacity === undefined
          ? args.kind === "blockArrow" ? { fillOpacity: 0.85 } : {}
          : { fillOpacity: args.fillOpacity }),
        labelColor: color,
        dash,
        size,
        ...(args.label ? { label: args.label } : {}),
        ...(args.kind === "triangle" ? { apexX: w / 2 } : {}),
      },
    };
  }

  if (args.kind === "arc" || args.kind === "sector") {
    const style = {
      color,
      strokeOpacity: args.strokeOpacity,
      fill: args.fill,
      fillColor,
      fillOpacity: args.fillOpacity,
      dash,
      size,
      arrowheadStart: args.kind === "arc" ? normalizeOverlayArrowhead(args.arrowheadStart, "none") : undefined,
      arrowheadEnd: args.kind === "arc" ? normalizeOverlayArrowhead(args.arrowheadEnd, "none") : undefined,
    };
    const points = args.points ?? [];
    const arcFromPoints = args.kind === "arc" && points.length >= 3
      ? createArcShapeFromThreePoints(id, points[0], points[1], points[2], style)
      : null;
    const arc = arcFromPoints ?? createArcShapeFromBoxArgs(id, args, style);
    const placed = resolveShapeToolPlacement(args, document, targetId, { x: arc.x, y: arc.y });
    return {
      ...arc,
      ...common,
      x: placed.x,
      y: placed.y,
      anchor: placed.anchor,
    };
  }

  if (args.kind === "arrow") {
    const segment = getShapeToolSegment(args, { w: 160, h: 0 });
    const placed = resolveShapeToolPlacement(args, document, targetId, segment.start);
    return {
      ...common,
      type: "arrow",
      x: placed.x,
      y: placed.y,
      anchor: placed.anchor,
      props: {
        start: { x: 0, y: 0 },
        end: {
          x: segment.end.x - segment.start.x,
          y: segment.end.y - segment.start.y,
        },
        arrowheadStart: normalizeOverlayArrowhead(args.arrowheadStart, "none"),
        arrowheadEnd: normalizeOverlayArrowhead(args.arrowheadEnd, "arrow"),
        fill: "none",
        color,
        ...(args.strokeOpacity === undefined ? {} : { strokeOpacity: args.strokeOpacity }),
        labelColor: color,
        dash,
        size,
        ...(args.label ? { label: args.label } : {}),
      },
    };
  }

  if (isLineShapeToolKind(args.kind)) {
    const points = getShapeToolLinePoints(args);
    const origin = points[0] ?? { x: 0, y: 44 };
    const linePoints = points.map((point) => ({ x: point.x - origin.x, y: point.y - origin.y }));
    const kind: OverlayLineKind = args.kind === "curve" || args.kind === "freehand" ? args.kind : "polyline";
    // anchor は原点正規化後の origin に対して計算する (props.points は相対のまま触らない)。
    const placed = resolveShapeToolPlacement(args, document, targetId, origin);
    return {
      ...common,
      type: "line",
      x: placed.x,
      y: placed.y,
      anchor: placed.anchor,
      props: {
        kind,
        points: linePoints,
        closed: args.kind === "polyline" && Boolean(args.closed) && linePoints.length >= 3,
        arrowheadStart: normalizeOverlayArrowhead(args.arrowheadStart, "none"),
        arrowheadEnd: normalizeOverlayArrowhead(args.arrowheadEnd, "none"),
        fill: args.fill ?? "none",
        fillColor,
        ...(args.fillOpacity === undefined ? {} : { fillOpacity: args.fillOpacity }),
        color,
        ...(args.strokeOpacity === undefined ? {} : { strokeOpacity: args.strokeOpacity }),
        labelColor: color,
        dash,
        size,
        ...(args.label ? { label: args.label } : {}),
      },
    };
  }

  if (args.kind === "text") {
    const blocks = args.markdown !== undefined
      ? createShapeToolMarkdownBlocks(args.markdown)
      : inlineNodesToOverlayTextBlocks(createShapeToolInlineContent(args));
    // `h` is never taken from the caller: it is a cache of the measured DOM, and a number invented
    // here would be overwritten the first time the editor draws the shape.
    const defaultBox = getShapeToolTextBox(blocks, size, args.fontSize, args.w);
    const box = {
      x: args.x ?? 0,
      y: args.y ?? 44,
      w: defaultBox.w,
      h: defaultBox.h,
    };
    const placed = resolveShapeToolPlacement(args, document, targetId, box);
    return {
      ...common,
      type: "text",
      x: placed.x,
      y: placed.y,
      anchor: placed.anchor,
      props: {
        w: box.w,
        h: box.h,
        blocks,
        color,
        ...(args.fontSize === undefined ? {} : { fontSize: args.fontSize }),
        size,
      },
    };
  }

  const children = createShapeToolInlineContent(args);
  const calloutBlocks = inlineNodesToOverlayTextBlocks(children);
  // A callout is sized to the words it holds, not to the default a text shape takes: its width is
  // part of a drawn bubble with a tail on it, and a bubble that is always the same width whatever
  // it says is not a bubble anyone drew. So this keeps estimating the caption, which is what it
  // did before the text shape stopped estimating anything.
  const estimatedTextSize = {
    w: estimateShapeToolContentWidth(children, size, args.fontSize),
    h: getShapeToolTextBox(calloutBlocks, size, args.fontSize).h,
  };
  const hasContent = Boolean(args.text || args.tex || args.label);
  const defaultWidth = hasContent
    ? Math.max(80, estimatedTextSize.w + AI_CALLOUT_PADDING * 2)
    : 180;
  const defaultHeight = hasContent
    ? Math.max(48, estimatedTextSize.h + AI_CALLOUT_PADDING * 2)
    : 68;
  const box = getShapeToolBox(args, { w: args.w ?? defaultWidth, h: args.h ?? defaultHeight });
  const defaultBaseStart = { x: box.w * 0.22, y: box.h };
  const defaultBaseEnd = { x: box.w * 0.42, y: box.h };
  const defaultTip = { x: box.w * 0.14, y: box.h + AI_CALLOUT_DEFAULT_TAIL_DEPTH };
  const placed = resolveShapeToolPlacement(args, document, targetId, box);
  return {
    ...common,
    type: "callout",
    x: placed.x,
    y: placed.y,
    anchor: placed.anchor,
    props: {
      w: box.w,
      h: box.h,
      radius: normalizeCalloutCornerRadius(args.cornerRadius ?? DEFAULT_CALLOUT_CORNER_RADIUS, box.w, box.h),
      tail: {
        baseStart: args.tailBaseStart ?? defaultBaseStart,
        baseEnd: args.tailBaseEnd ?? defaultBaseEnd,
        tip: args.tailTip ?? defaultTip,
      },
      blocks: inlineNodesToOverlayTextBlocks(children),
      color,
      ...(args.fontSize === undefined ? {} : { fontSize: args.fontSize }),
      size,
      dash,
      strokeWidth: "m",
    },
  };
}

function createArcShapeFromBoxArgs(
  id: OverlayShapeId,
  args: DraftInsertShapeArgs,
  style: NonNullable<Parameters<typeof createArcShapeFromCenterDrag>[4]>,
) {
  const box = getShapeToolBox(args, { w: 120, h: 120 });
  if (args.startAngle !== undefined || args.endAngle !== undefined || args.r !== undefined || args.rx !== undefined || args.ry !== undefined) {
    const rx = args.rx ?? args.r ?? Math.max(4, box.w / 2);
    const ry = args.ry ?? args.r ?? Math.max(4, box.h / 2);
    const r = args.r ?? Math.max(rx, ry);
    return {
      id,
      type: "arc" as const,
      x: box.x,
      y: box.y,
      rotation: 0,
      props: {
        kind: args.kind === "sector" ? "sector" as const : "arc" as const,
        r,
        rx,
        ry,
        startAngle: args.startAngle ?? 0,
        endAngle: args.endAngle ?? Math.PI / 2,
        fill: args.kind === "sector" ? style.fill ?? "solid" : style.fill,
        fillColor: args.kind === "sector" ? style.fillColor ?? "#e5e7eb" : style.fillColor,
        fillOpacity: args.kind === "sector" ? style.fillOpacity ?? 0.35 : style.fillOpacity,
        color: style.color ?? "black",
        strokeOpacity: style.strokeOpacity,
        dash: style.dash ?? "solid",
        size: style.size ?? "m",
      },
    };
  }

  return createArcShapeFromCenterDrag(
    id,
    { x: box.x + box.w / 2, y: box.y + box.h / 2 },
    { x: box.x + box.w, y: box.y + box.h / 2 },
    args.kind === "sector" ? "sector" : "arc",
    style,
  );
}

export function createShapeToolInlineContent(args: { text?: string; tex?: string; label?: string }): InlineNode[] {
  const children = normalizeAiInlineContent({
    ...(args.text !== undefined || args.label !== undefined ? { text: args.text ?? args.label } : {}),
    ...(args.tex !== undefined ? { tex: args.tex } : {}),
  });
  const texIssues = children.flatMap((child) => child.type === "mathInline" ? getTexIssues(child.tex, child.id) : []);
  if (texIssues.length > 0) {
    throw new Error(tv("tools.createShapeToolInlineContent1", { p0: texIssues.slice(0, 10).join(" / ") }));
  }
  return children;
}

function getShapeToolMarkdownIssues(
  args: { markdown?: unknown; text?: unknown; tex?: unknown; label?: unknown },
  kind: string,
): string[] {
  if (args.markdown === undefined) return [];
  return [
    ...(kind === "text" ? [] : [tv("tools.insertShapeMarkdownTextOnly")]),
    ...(args.text === undefined && args.tex === undefined && args.label === undefined
      ? []
      : [tv("tools.insertShapeMarkdownExclusive")]),
  ];
}

export function assertShapeToolMarkdownArgs(
  args: { markdown?: unknown; text?: unknown; tex?: unknown; label?: unknown },
  kind: string,
): void {
  const issues = getShapeToolMarkdownIssues(args, kind);
  if (issues.length > 0) throw new Error(issues.join(" "));
}

type ParsedMarkdownBlock = NonNullable<ReturnType<typeof parseMarkdownToTextFlowBlocks>>[number];

function isOverlayTextBlock(block: ParsedMarkdownBlock): block is OverlayTextBlock {
  return block.type === "heading" ||
    block.type === "paragraph" ||
    block.type === "list" ||
    block.type === "quote" ||
    block.type === "codeBlock" ||
    block.type === "divider";
}

export function createShapeToolMarkdownBlocks(markdown: string): OverlayTextBlock[] {
  const parsed = parseMarkdownToTextFlowBlocks(markdown, { requireMarkdownSyntax: false });
  if (!parsed || parsed.length === 0) {
    throw new Error(tv("tools.createShapeToolMarkdownEmpty"));
  }
  const unsupported = parsed.find((block) => !isOverlayTextBlock(block));
  if (unsupported) {
    throw new Error(tv("tools.createShapeToolMarkdownUnsupported", { p0: unsupported.type }));
  }
  const blocks = parsed.filter(isOverlayTextBlock);
  const texIssues = blocks.flatMap(getRichBlockTexIssues);
  if (texIssues.length > 0) {
    throw new Error(tv("tools.createShapeToolInlineContent1", { p0: texIssues.slice(0, 10).join(" / ") }));
  }
  return blocks;
}

/**
 * The box a text shape gets from a tool that did not name one.
 *
 * Not a measurement. A text shape's width is chosen, not derived — nothing re-fits the box to its
 * content — so an author (or a tool acting for one) either names a width or takes the same default
 * every other creation path takes. The height is the floor the content cannot go under: the lines
 * its own breaks put in it. The editor writes the real height back from the measured DOM the first
 * time it draws the shape, and that is the only place a true height comes from.
 */
export function getShapeToolTextBox(
  blocks: readonly OverlayTextBlock[],
  size: OverlayTextSize,
  fontSizePt?: number,
  widthPx?: number,
): { w: number; h: number } {
  const fontSizePx = fontSizePt === undefined ? overlayTextSizeToPx(size) : ptToPx(fontSizePt);
  const lineHeightPx = Math.ceil(fontSizePx * TEXT_SHAPE_LINE_HEIGHT);
  return {
    w: Math.max(AI_TEXT_SHAPE_MIN_WIDTH, widthPx ?? DEFAULT_TEXT_SHAPE_WIDTH),
    h: getOverlayTextBlocksLineCount(blocks) * lineHeightPx,
  };
}

/**
 * The box a caption occupies, for a shape being sized to fit the one it carries.
 *
 * This one *is* a measurement, because a `props.label` is drawn straight into the SVG as a single
 * line with no box of its own to wrap in — the same estimate `shape-label-geometry.ts` places it
 * with, so a shape sized here and the caption drawn there agree.
 */
/**
 * How wide the content of a callout wants to be, on one line.
 *
 * A formula is measured as the box it renders in, not as the characters of its TeX: `\frac{1}{2}`
 * is one small stacked fraction, and counting its thirteen source characters would blow the bubble
 * out to several times the width it needs. Plain text has no rendered box to ask about, so it
 * keeps the caption estimate.
 */
function estimateShapeToolContentWidth(
  children: readonly InlineNode[],
  size: OverlayTextSize,
  fontSizePt?: number,
): number {
  const fontSizePx = fontSizePt === undefined ? overlayTextSizeToPx(size) : ptToPx(fontSizePt);
  const widthEm = children.reduce((sum, child) => {
    if (child.type === "mathInline") {
      return sum + measureTexBoxEm(child.tex, DEFAULT_MATH_RENDER_ENVIRONMENT).widthEm;
    }
    return sum + (child.type === "text" ? estimateTextWidthEm(child.text.replace(/\s+/g, " ")) : 0);
  }, 0);
  return Math.ceil(widthEm * fontSizePx);
}

function estimateShapeToolLabelSize(
  text: string,
  size: OverlayTextSize,
  fontSizePt?: number,
): { w: number; h: number } {
  const fontSizePx = fontSizePt === undefined ? overlayTextSizeToPx(size) : ptToPx(fontSizePt);
  return {
    w: Math.ceil(estimateTextWidthEm(text.replace(/\s+/g, " ")) * fontSizePx),
    h: Math.ceil(fontSizePx * (TEXT_ASCENT_EM + TEXT_DESCENT_EM)),
  };
}

function getShapeToolBox(
  args: DraftInsertShapeArgs,
  fallback: { w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  if (args.start && args.end) {
    const minX = Math.min(args.start.x, args.end.x);
    const minY = Math.min(args.start.y, args.end.y);
    return {
      x: minX,
      y: minY,
      w: Math.max(2, Math.abs(args.end.x - args.start.x)),
      h: Math.max(2, Math.abs(args.end.y - args.start.y)),
    };
  }

  if (args.points && args.points.length > 0) {
    const xs = args.points.map((point) => point.x);
    const ys = args.points.map((point) => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      x: minX,
      y: minY,
      w: Math.max(2, Math.max(...xs) - minX),
      h: Math.max(2, Math.max(...ys) - minY),
    };
  }

  return {
    x: args.x ?? 0,
    y: args.y ?? 44,
    w: fallback.w,
    h: fallback.h,
  };
}

function getShapeToolSegment(
  args: DraftInsertShapeArgs,
  fallback: { w: number; h: number },
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const start = args.start ?? args.points?.[0] ?? { x: args.x ?? 0, y: args.y ?? 44 };
  const end = args.end ?? args.points?.[args.points.length - 1] ?? {
    x: start.x + fallback.w,
    y: start.y + fallback.h,
  };
  if (start.x === end.x && start.y === end.y) {
    return {
      start,
      end: { x: end.x + Math.max(2, fallback.w), y: end.y + fallback.h },
    };
  }
  return { start, end };
}

function getShapeToolLinePoints(args: DraftInsertShapeArgs): { x: number; y: number }[] {
  if (args.points && args.points.length >= 2) {
    return args.points;
  }
  const segment = getShapeToolSegment(args, args.kind === "curve" ? { w: 160, h: 80 } : { w: 160, h: 0 });
  if (args.kind === "curve") {
    return [
      segment.start,
      {
        x: (segment.start.x + segment.end.x) / 2,
        y: Math.min(segment.start.y, segment.end.y) - 48,
      },
      segment.end,
    ];
  }
  return [segment.start, segment.end];
}

function getDefaultShapeToolSize(kind: DraftInsertShapeArgs["kind"], label: string | undefined, size: OverlayTextSize): { w: number; h: number } {
  const baseSize = getDefaultShapeToolBaseSize(kind);
  if (!label) {
    return baseSize;
  }

  const labelSize = estimateShapeToolLabelSize(label, size);
  return {
    w: Math.max(baseSize.w, labelSize.w + AI_SHAPE_LABEL_PADDING_X),
    h: Math.max(baseSize.h, labelSize.h + AI_SHAPE_LABEL_PADDING_Y),
  };
}

function getDefaultShapeToolBaseSize(kind: DraftInsertShapeArgs["kind"]): { w: number; h: number } {
  if (kind === "circle" || kind === "ellipse") {
    return { w: 96, h: 96 };
  }
  if (kind === "triangle" || kind === "diamond" || kind === "pentagon") {
    return { w: 120, h: 96 };
  }
  if (kind === "blockArrow") {
    return { w: 180, h: 48 };
  }
  if (kind === "highlight") {
    return { w: 180, h: 36 };
  }
  return { w: 160, h: 96 };
}

function getRequestedGeoShapeToolSize(
  args: DraftInsertShapeArgs,
  fallback: { w: number; h: number },
): { w: number; h: number } {
  if (args.kind === "circle" && args.r !== undefined) {
    return { w: args.r * 2, h: args.r * 2 };
  }
  if (args.kind === "ellipse" && (args.rx !== undefined || args.ry !== undefined)) {
    return {
      w: (args.rx ?? fallback.w / 2) * 2,
      h: (args.ry ?? fallback.h / 2) * 2,
    };
  }
  return fallback;
}

function isGeoShapeToolKind(kind: DraftInsertShapeArgs["kind"]): kind is "rectangle" | "circle" | "ellipse" | "triangle" | "diamond" | "pentagon" | "blockArrow" | "highlight" {
  return kind === "rectangle" ||
    kind === "circle" ||
    kind === "ellipse" ||
    kind === "triangle" ||
    kind === "diamond" ||
    kind === "pentagon" ||
    kind === "blockArrow" ||
    kind === "highlight";
}

function isLineShapeToolKind(kind: DraftInsertShapeArgs["kind"]): kind is "line" | "polyline" | "curve" | "freehand" {
  return kind === "line" || kind === "polyline" || kind === "curve" || kind === "freehand";
}

function normalizeOverlayDash(value: OverlayDash | undefined): OverlayDash {
  return value === "dashed" || value === "dotted" ? value : "solid";
}

function normalizeOverlayTextSize(value: OverlayTextSize | undefined): OverlayTextSize {
  return value === "s" || value === "l" || value === "xl" ? value : "m";
}

function normalizeOverlayArrowhead(value: OverlayArrowhead | undefined, fallback: OverlayArrowhead): OverlayArrowhead {
  // Derived, not enumerated: this used to carry its own copy of the four original heads and
  // quietly rewrote anything else to the fallback, so a new head reached the schema but never the
  // document.
  return value !== undefined && (OVERLAY_ARROWHEADS as readonly string[]).includes(value) ? value : fallback;
}

const aiGraphLabelLayoutPort = createGraphLabelLayoutPort();

function createGraphShapeFromSpec(
  spec: Graph2DSpec,
  document: SigmaDocument,
  targetId: string,
  args: GraphShapePlacementArgs,
): OverlayGraphShape {
  const plotSize = getGraphPlotSize(spec);
  const placed = resolveAiOverlayPlacement({
    document,
    anchorBlockId: targetId,
    ...(args.x === undefined ? {} : { x: args.x }),
    ...(args.y === undefined ? {} : { y: args.y }),
  });
  return {
    id: args.id ?? createId("ai_graph"),
    type: "graph2dShape",
    x: placed.x,
    y: placed.y,
    rotation: 0,
    anchor: placed.anchor,
    props: {
      boundsMode: "plot",
      w: args.w ?? plotSize.w,
      h: args.h ?? plotSize.h,
      spec,
    },
  };
}

function createGraphWithOwnedLabelsFromSpec(
  spec: Graph2DSpec,
  document: SigmaDocument,
  targetId: string,
  args: GraphShapePlacementArgs,
): { shape: OverlayGraphShape; labelShapes: OverlayShape[] } {
  return createGraphWithOwnedLabelsFromShape(createGraphShapeFromSpec(spec, document, targetId, args));
}

export function createGraphWithOwnedLabelsFromShape(
  sourceShape: OverlayGraphShape,
): { shape: OverlayGraphShape; labelShapes: OverlayShape[] } {
  let shape: OverlayGraphShape = {
    ...sourceShape,
    props: {
      ...sourceShape.props,
      axisLabelTextShapeIds: {},
      pointLabelTextShapeIdsByPointId: {},
      annotationTextShapeIdsByAnnotationId: {},
      labelTextShapeIdsByCurveId: {},
      labelTextShapeIds: [],
    },
  };
  const spec = shape.props.spec;
  const axisLabelsByKey = getGraphFixedAxisLabelsByKey(spec);
  const axisEntries = createGraphAxisLabelShapeEntries(shape, () => createId("ai_graph_label"), aiGraphLabelLayoutPort, {
    keys: Object.keys(axisLabelsByKey).filter(isOverlayGraphAxisLabelKey),
    labelsByKey: axisLabelsByKey,
  });
  const pointEntries = createGraphPointLabelShapeEntries(shape, () => createId("ai_graph_label"), aiGraphLabelLayoutPort);
  const annotationEntries = createGraphAnnotationLabelShapeEntries(
    shape,
    () => createId("ai_graph_label"),
    aiGraphLabelLayoutPort,
  );
  const formulaEntries = spec.showFormulaLabels === true
    ? createGraphFormulaLabelShapeEntries(shape, () => createId("ai_graph_label"), {
        width: Math.max(800, shape.x + shape.props.w + 220),
        height: Math.max(600, shape.y + shape.props.h + 220),
      }, aiGraphLabelLayoutPort)
    : [];
  const labelShapes = [
    ...axisEntries,
    ...pointEntries,
    ...annotationEntries,
    ...formulaEntries,
  ].map((entry) => entry.shape);

  if (axisEntries.length > 0) {
    shape = {
      ...shape,
      props: {
        ...shape.props,
        axisLabelTextShapeIds: Object.fromEntries(axisEntries.map((entry) => [entry.key, entry.shape.id])),
        spec: clearGraphFixedAxisLabels(shape.props.spec),
      },
    };
  }

  if (pointEntries.length > 0) {
    shape = {
      ...shape,
      props: {
        ...shape.props,
        pointLabelTextShapeIdsByPointId: Object.fromEntries(pointEntries.map((entry) => [entry.pointId, entry.shape.id])),
      },
    };
  }

  if (annotationEntries.length > 0) {
    shape = {
      ...shape,
      props: {
        ...shape.props,
        annotationTextShapeIdsByAnnotationId: Object.fromEntries(annotationEntries.map((entry) => [entry.annotationId, entry.shape.id])),
      },
    };
  }

  if (formulaEntries.length > 0) {
    const labelIdsByCurveId = Object.fromEntries(formulaEntries.map((entry) => [entry.curveId, entry.shape.id]));
    shape = {
      ...shape,
      props: {
        ...shape.props,
        labelTextShapeIds: shape.props.spec.curves
          .map((curve) => labelIdsByCurveId[curve.id])
          .filter((id): id is OverlayShapeId => typeof id === "string"),
        labelTextShapeIdsByCurveId: labelIdsByCurveId,
      },
    };
  }

  return { shape: clearMaterializedGraphLabelTexts(shape), labelShapes };
}

function getGraphFixedAxisLabelsByKey(spec: Graph2DSpec): Partial<Record<OverlayGraphAxisLabelKey, string>> {
  return {
    ...(spec.axes.xLabel?.trim() ? { x: spec.axes.xLabel.trim() } : {}),
    ...(spec.axes.yLabel?.trim() ? { y: spec.axes.yLabel.trim() } : {}),
    ...(spec.axes.originLabel?.trim() ? { origin: spec.axes.originLabel.trim() } : {}),
  };
}

function clearGraphFixedAxisLabels(spec: Graph2DSpec): Graph2DSpec {
  return {
    ...spec,
    axes: {
      ...spec.axes,
      xLabel: "",
      yLabel: "",
      originLabel: "",
    },
  };
}

function isOverlayGraphAxisLabelKey(value: string): value is OverlayGraphAxisLabelKey {
  return value === "x" || value === "y" || value === "origin";
}

interface GraphShapePlacementArgs {
  id?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

function assertGraphShape(shape: OverlayShape): OverlayGraphShape {
  if (shape.type !== "graph2dShape") {
    throw new Error(tv("tools.assertGraphShape1"));
  }
  return shape;
}

function validateOverlayShapeWithAssets(shape: OverlayShape, assets: Record<string, OverlayAsset>): void {
  validateOverlayShapesWithAssets([shape], assets);
}

function validateOverlayShapesWithAssets(shapes: OverlayShape[], assets: Record<string, OverlayAsset>): void {
  if (!isValidOverlaySnapshot({ version: 1, shapes, assets })) {
    throw new Error(tv("tools.validateOverlayShapesWithAssets1"));
  }
}

function validateGraphSpec(spec: Graph2DSpec, nodeId = "ai_graph"): void {
  const issues = getGraphIssues(spec, nodeId);
  if (issues.length > 0) {
    // `getGraphIssues` はコードを返すので、そのまま埋めると `[object Object]` になり
    // AI がどの曲線・点・塗りが不正なのか分からなくなる。必ず整形を通す。
    // AI には**どの曲線・点・塗りか**を渡す (id で対象を特定して自己修正できる)。
    // 利用者向けパネルは id を出さない — あちらの id は UUID で手掛かりにならない。
    throw new Error(tv("tools.validateGraphSpec1", { p0: formatGraphIssue(issues[0], undefined, { withTarget: true }) }));
  }

  assertUniqueGraphIds(spec, nodeId);

  for (const fill of spec.fills ?? []) {
    if (!getGraphFillPath(spec, fill)) {
      throw new Error(tv("tools.validateGraphSpec2", { p0: fill.id }));
    }
  }
}

function assertUniqueGraphIds(spec: Graph2DSpec, nodeId: string): void {
  const ids = [
    ...spec.curves.map((curve) => curve.id),
    ...(spec.points ?? []).map((point) => point.id),
    ...(spec.annotations ?? []).map((annotation) => annotation.id),
    ...(spec.fills ?? []).map((fill) => fill.id),
  ].filter(Boolean);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    throw new Error(tv("tools.assertUniqueGraphIds1", { p0: nodeId }));
  }
}

/**
 * 図形ツールが組み立てた幾何原点 (絶対ページ座標) と、AIが位置を明示したかどうかから
 * 配置を決める。AIが x / y / points / start / end のいずれも指定していない軸は
 * 「アンカーブロック直下」の意味ベース既定へ倒し、幾何原点をそのまま絶対座標として
 * 使わない (tool側の暫定値 0 / 44 を絶対座標と誤解しないため)。
 */
function resolveShapeToolPlacement(
  args: DraftInsertShapeArgs,
  document: SigmaDocument,
  targetId: string,
  origin: { x: number; y: number },
): AiOverlayPlacement {
  const hasGeometryPoints = args.points !== undefined || args.start !== undefined || args.end !== undefined;
  return resolveAiOverlayPlacement({
    document,
    anchorBlockId: targetId,
    ...(args.x !== undefined || hasGeometryPoints ? { x: origin.x } : {}),
    ...(args.y !== undefined || hasGeometryPoints ? { y: origin.y } : {}),
    ...(args.placement ? { placement: args.placement } : {}),
    ...(args.reserveSpace === undefined ? {} : { reserveSpace: args.reserveSpace }),
  });
}

function validateDocumentMath(document: SigmaDocument): void {
  const issues = document.content.flatMap(getBlockTexIssues);
  if (issues.length > 0) {
    throw new Error(tv("tools.validateDocumentMath1", { p0: issues.slice(0, 10).join(" / ") }));
  }
}

function getBlockTexIssues(block: SigmaBlock): string[] {
  if (
    block.type === "heading" ||
    block.type === "paragraph" ||
    block.type === "list" ||
    block.type === "layoutSection" ||
    block.type === "boxBlock"
  ) {
    return getRichBlockTexIssues(block);
  }
  if (block.type === "problem") {
    return [...block.lead, ...block.prompt, ...block.solution, ...block.hints]
      .flatMap(getRichBlockTexIssues);
  }
  return [];
}

function getRichBlockTexIssues(
  block: RichBlock | QuoteBlockNode | CodeBlockNode | DividerNode | LayoutSectionNode | BoxBlockNode | ProblemNode,
): string[] {
  if (block.type === "problem") return [...block.lead, ...block.prompt, ...block.hints, ...block.solution].flatMap(getRichBlockTexIssues);
  if (block.type === "divider") {
    return [];
  }
  if (block.type === "quote") {
    return block.blocks.flatMap(getRichBlockTexIssues);
  }
  if (block.type === "codeBlock") {
    return block.children.flatMap(getInlineTexIssues);
  }
  if (block.type === "layoutSection") {
    return block.children.flatMap((child) => child.type === "section" ? [] : getRichBlockTexIssues(child));
  }
  if (block.type === "boxBlock") {
    return [
      ...(block.title?.flatMap(getInlineTexIssues) ?? []),
      ...block.blocks.flatMap((child) => child.type === "section" ? [] : getRichBlockTexIssues(child)),
    ];
  }
  if (block.type === "list") {
    return block.items.flatMap((item) => [
      ...item.children.flatMap(getInlineTexIssues),
      ...(item.continuations ?? []).flatMap(getRichBlockTexIssues),
      ...(item.nested ?? []).flatMap(getRichBlockTexIssues),
    ]);
  }

  return block.children.flatMap(getInlineTexIssues);
}

function getInlineTexIssues(node: InlineNode): string[] {
  return node.type === "mathInline" ? getTexIssues(node.tex, node.id) : [];
}

export function normalizeSigmaDocAgentDraftToolArgsForParsing(
  name: SigmaDocAgentDraftToolName,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const nullableKeys = NULLABLE_SIGMA_DOC_AGENT_DRAFT_TOOL_ARGUMENT_KEYS[name] ?? [];
  if (nullableKeys.length === 0) {
    return input;
  }
  const nullableKeySet = new Set(nullableKeys);
  return Object.fromEntries(
    Object.entries(input).filter(([key, value]) => !(value === null && nullableKeySet.has(key))),
  );
}
function parseToolArgs(name: SigmaDocAgentDraftToolName, input: unknown): Record<string, unknown> {
  const parsed = parseRawToolArgs(input);
  return normalizeSigmaDocAgentDraftToolArgsForParsing(name, parsed);
}

function isSigmaDocAgentReadToolName(name: SigmaDocAgentToolName): name is SigmaDocAgentReadToolName {
  switch (name) {
    case "get_selected_block":
    case "get_active_reference":
    case "get_document_outline":
    case "get_document_metadata":
    case "get_insertion_candidates":
    case "get_neighbor_blocks":
    case "get_attached_media":
    case "get_mentioned_sigma_docs":
    case "get_material_catalog":
    case "get_material_content":
      return true;
    default:
      return false;
  }
}

function parseRawToolArgs(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    const parsed = JSON.parse(input);
    return isRecord(parsed) ? parsed : {};
  }
  return isRecord(input) ? input : {};
}

function problemAreaLabel(area: ProblemAreaKind): string {
  switch (area) {
    case "lead":
      return tv("tools.problemAreaLabel1");
    case "prompt":
      return tv("tools.problemAreaLabel2");
    case "solution":
      return tv("tools.problemAreaLabel3");
    case "hints":
      return tv("tools.problemAreaLabel4");
  }
}

function formatToolError(error: unknown): string {
  // `features/document` が投げる検証エラーはコードだけを運ぶ (最下層は文言を持たない)。
  // ここで文へ解決しないと、開発者向けの英語 message が AI へそのまま返ってしまう。
  if (isSigmaValidationError(error)) {
    return formatValidationError(error);
  }
  if (error instanceof z.ZodError) {
    if (error.issues.length === 0) {
      return tv("tools.formatToolError1");
    }
    const issueLines = error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join(" / ");
    return tv("tools.formatToolError2", { p0: issueLines });
  }
  return error instanceof Error ? error.message : tv("tools.formatToolError3");
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function nonEmptyStringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return fallback;
}

function positiveNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonnegativeNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
