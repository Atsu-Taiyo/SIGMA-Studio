import { createOverlayClipboardPayload, cloneDocumentBlocksForPaste, cloneOverlayShapesForPaste } from "@/lib/editor-clipboard";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import { SigmaBlockSchema } from "@/lib/sigma-doc-schema";
import {
  listItemContinuationInlineNodes,
  normalizePageLayout,
  createEmptyOverlaySnapshot,
  isValidOverlaySnapshot,
  normalizeOverlaySnapshot,
  type OverlayPoint,
  type OverlayShape,
  type OverlaySnapshot,
  type BoxBlockChildBlock,
  type SigmaBlock,
  type SigmaDocument,
  type LayoutSectionChildBlock,
  type ListNode,
  type ProblemAreaBlock,
  type ProblemAreaKind,
  type ProblemNode,
  type RichBlock,
} from "@/features/document";
import { getShapesSelectionBounds, getTextShapeFontSizePt } from "@/features/drawing";

import { inlineNodesToPlainText } from "@/lib/tiptap-adapter";

import type { MaterialContent, MaterialItem, MaterialPort, MaterialTransformPolicy, MaterialUsage } from "@/types/material";

export interface MaterialInsertResult {
  blocks: SigmaBlock[];
  blockIdMap: Map<string, string>;
  overlaySnapshot: OverlaySnapshot;
}

export interface MaterialMetadataInput {
  description?: string | null;
  tags?: readonly string[] | null;
  usage?: MaterialUsage | null;
  visualConcepts?: readonly string[] | null;
  transformPolicy?: MaterialTransformPolicy | null;
  ports?: readonly MaterialPort[] | null;
}

export interface MaterialPlacement {
  origin: OverlayPoint;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
}

export interface MaterialContentSummary {
  blockCount: number;
  shapeCount: number;
  assetCount: number;
  representativeText: string;
  blockTypes: string[];
  shapeTypes: string[];
  hasTextBlocks: boolean;
  hasShapes: boolean;
  hasImages: boolean;
  hasBoxBlocks: boolean;
  hasTables: boolean;
  hasGraphs: boolean;
}

export interface MaterialCatalogEntry {
  id: string;
  name: string;
  source?: MaterialItem["source"];
  description?: string;
  tags: string[];
  usage: Required<MaterialUsage>;
  visualConcepts: string[];
  transformPolicy: Required<MaterialTransformPolicy>;
  ports: MaterialPort[];
  contentSummary: MaterialContentSummary;
}

export function parseMaterialItem(value: unknown): MaterialItem | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  const content = parseMaterialContent(value.content);
  if (!content) {
    return null;
  }
  const source = value.source === "official" || value.source === "user"
    ? value.source
    : undefined;
  const metadata = normalizeMaterialMetadata(value);

  return {
    version: 1,
    id: value.id,
    name: value.name,
    ...(source ? { source } : {}),
    ...metadata,
    content,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/** 素材検索用にテキストを正規化（小文字化・前後空白除去）。 */
export function normalizeMaterialSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

/** 名前・説明・タグを横断して検索クエリに一致するか判定する。 */
export function materialMatchesQuery(material: MaterialItem, query: string): boolean {
  const normalizedQuery = normalizeMaterialSearchText(query);
  if (!normalizedQuery) {
    return true;
  }
  const haystack = [
    material.name,
    material.description ?? "",
    ...(material.tags ?? []),
    ...(material.usage?.useCases ?? []),
    ...(material.usage?.avoidWhen ?? []),
    ...(material.usage?.aliases ?? []),
    ...(material.visualConcepts ?? []),
    ...summarizeMaterialContent(material.content).blockTypes,
    ...summarizeMaterialContent(material.content).shapeTypes,
  ]
    .map(normalizeMaterialSearchText)
    .join(" ");
  return haystack.includes(normalizedQuery);
}

export function materialMatchesConcepts(material: MaterialItem, concepts: readonly string[]): boolean {
  const normalizedConcepts = concepts.map(normalizeMaterialSearchText).filter(Boolean);
  if (normalizedConcepts.length === 0) {
    return true;
  }
  const catalog = createMaterialCatalogEntry(material);
  const haystack = [
    catalog.name,
    catalog.description ?? "",
    ...catalog.tags,
    ...catalog.usage.useCases,
    ...catalog.usage.aliases,
    ...catalog.visualConcepts,
    ...catalog.contentSummary.blockTypes,
    ...catalog.contentSummary.shapeTypes,
  ].map(normalizeMaterialSearchText).join(" ");
  return normalizedConcepts.some((concept) => haystack.includes(concept));
}

export function normalizeMaterialMetadata(input: MaterialMetadataInput | Record<string, unknown>): Partial<MaterialItem> {
  const description = normalizeOptionalString(input.description);
  const tags = normalizeStringList(input.tags);
  const usage = normalizeMaterialUsage(input.usage);
  const visualConcepts = normalizeStringList(input.visualConcepts);
  const transformPolicy = normalizeMaterialTransformPolicy(input.transformPolicy);
  const ports = normalizeMaterialPorts(input.ports);
  return {
    ...(description ? { description } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(hasMaterialUsage(usage) ? { usage } : {}),
    ...(visualConcepts.length > 0 ? { visualConcepts } : {}),
    ...(hasMaterialTransformPolicy(transformPolicy) ? { transformPolicy } : {}),
    ...(ports.length > 0 ? { ports } : {}),
  };
}

export function createMaterialCatalogEntry(material: MaterialItem): MaterialCatalogEntry {
  const usage = normalizeMaterialUsage(material.usage);
  const transformPolicy = normalizeMaterialTransformPolicy(material.transformPolicy);
  return {
    id: material.id,
    name: material.name,
    ...(material.source ? { source: material.source } : {}),
    ...(material.description ? { description: material.description } : {}),
    tags: material.tags ?? [],
    usage: {
      useCases: usage.useCases ?? [],
      avoidWhen: usage.avoidWhen ?? [],
      aliases: usage.aliases ?? [],
    },
    visualConcepts: material.visualConcepts ?? [],
    transformPolicy: {
      scale: transformPolicy.scale ?? true,
      rotate: transformPolicy.rotate ?? false,
    },
    ports: material.ports ?? [],
    contentSummary: summarizeMaterialContent(material.content),
  };
}

export function summarizeMaterialContent(content: MaterialContent): MaterialContentSummary {
  const blockTexts = content.blocks.map(getMaterialBlockSummaryText).filter(Boolean);
  const blockTypes = uniqueStrings(content.blocks.flatMap(collectMaterialBlockTypes));
  const shapeTypes = uniqueStrings(content.overlaySnapshot.shapes.map((shape) => shape.type));
  return {
    blockCount: content.blocks.length,
    shapeCount: content.overlaySnapshot.shapes.length,
    assetCount: Object.keys(content.overlaySnapshot.assets).length,
    representativeText: blockTexts.join(" / ").slice(0, 160),
    blockTypes,
    shapeTypes,
    hasTextBlocks: content.blocks.length > 0,
    hasShapes: content.overlaySnapshot.shapes.length > 0,
    hasImages: content.overlaySnapshot.shapes.some((shape) => shape.type === "image"),
    hasBoxBlocks: blockTypes.includes("boxBlock"),
    hasTables: content.overlaySnapshot.shapes.some((shape) => shape.type === "tableShape"),
    hasGraphs: content.overlaySnapshot.shapes.some((shape) => (
      shape.type === "graph2dShape" || shape.type === "graph3dShape"
    )),
  };
}

const tWorkspace = createCurrentLocaleTranslator("workspace");

export function inferDefaultMaterialPorts(content: MaterialContent): MaterialPort[] {
  const bounds = getShapesSelectionBounds(content.overlaySnapshot.shapes);
  if (!bounds) {
    return [];
  }
  const centerY = bounds.y + bounds.h / 2;
  // D3: label は素材へ**保存される**表示名なので、作成時点の UI 言語で焼く。
  // 照合に使うのは `kind` の方 (英語の機械値) なので、言語が混ざっても検索は壊れない。
  return [
    { id: "leftEnd", label: tWorkspace("asset.portLeftEnd"), kind: "leftEnd", x: bounds.x, y: centerY },
    { id: "rightEnd", label: tWorkspace("asset.portRightEnd"), kind: "rightEnd", x: bounds.x + bounds.w, y: centerY },
    { id: "center", label: tWorkspace("asset.portCenter"), kind: "center", x: bounds.x + bounds.w / 2, y: centerY },
  ];
}

export function parseMaterialContent(value: unknown): MaterialContent | null {
  if (!isRecord(value) || !Array.isArray(value.blocks)) {
    return null;
  }

  const blocks: SigmaBlock[] = [];
  for (const block of value.blocks) {
    const result = SigmaBlockSchema.safeParse(block);
    if (!result.success) {
      return null;
    }
    blocks.push(result.data);
  }

  const overlaySnapshot = isValidOverlaySnapshot(value.overlaySnapshot)
    ? normalizeOverlaySnapshot(value.overlaySnapshot)
    : null;
  if (!overlaySnapshot) {
    return null;
  }

  return {
    blocks,
    overlaySnapshot,
  };
}

export function createEmptyMaterialContent(): MaterialContent {
  return {
    blocks: [],
    overlaySnapshot: createEmptyOverlaySnapshot(),
  };
}

/**
 * 名前が空のときの防御的な既定名。**UI 言語には連動しない** — 呼び出し元が
 * Electron main (`electron/local-material-store.ts`) なので、常に既定ロケール
 * で解決される (画面側は空名での保存を塞いでいる)。`MaterialPort.label` の方は
 * 画面から呼ぶので、そちらは作成時の言語で焼かれる。
 */
export function normalizeMaterialName(name: string): string {
  return name.trim() || tWorkspace("untitledAsset");
}

export function cloneMaterialContentForInsert(
  content: MaterialContent,
  options: MaterialPlacement,
): MaterialInsertResult {
  const originalBlockIds = collectMaterialBlockIds(content.blocks);
  const blocks = cloneDocumentBlocksForPaste(content.blocks);
  const clonedBlockIds = collectMaterialBlockIds(blocks);
  const blockIdMap = new Map<string, string>();
  originalBlockIds.forEach((id, index) => {
    const nextId = clonedBlockIds[index];
    if (nextId) {
      blockIdMap.set(id, nextId);
    }
  });

  const overlaySnapshot = getOverlaySnapshotForMaterialInsert(content);
  const pasted = cloneOverlayShapesForPaste(
    createOverlayClipboardPayload(overlaySnapshot.shapes, overlaySnapshot.assets),
    options.origin,
  );
  const shapes = pasted.shapes
    .map((shape) => transformMaterialShapeForPlacement(shape, options))
    .map((shape) => remapMaterialShapeAnchor(shape, blockIdMap));

  return {
    blocks,
    blockIdMap,
    overlaySnapshot: {
      version: 1,
      shapes,
      assets: pasted.assets,
    },
  };
}

export function normalizeMaterialOverlayToOrigin(
  snapshot: OverlaySnapshot,
  origin: OverlayPoint,
  options: { detachBlockAnchors?: boolean } = {},
): OverlaySnapshot {
  const normalized = normalizeOverlaySnapshot(snapshot);
  return {
    ...normalized,
    shapes: normalized.shapes.map((shape) => normalizeMaterialShapeToOrigin(shape, origin, options)),
  };
}

function getOverlaySnapshotForMaterialInsert(content: MaterialContent): OverlaySnapshot {
  const snapshot = content.overlaySnapshot;
  const bounds = getShapesSelectionBounds(snapshot.shapes);
  if (!bounds) {
    return snapshot;
  }

  return {
    ...snapshot,
    shapes: snapshot.shapes.map((shape) => normalizeMaterialShapeToOrigin(shape, { x: bounds.x, y: bounds.y }, { detachBlockAnchors: content.blocks.length === 0 })),
  };
}

export function replaceMaterialTriggerWithBlocks(
  document: SigmaDocument,
  triggerBlockId: string,
  blocks: SigmaBlock[],
): { document: SigmaDocument; selectedId: string | null } {
  if (blocks.length === 0) {
    return { document, selectedId: null };
  }

  const directIndex = document.content.findIndex((block) => block.id === triggerBlockId);
  if (directIndex >= 0) {
    const content = [...document.content];
    content.splice(directIndex, 1, ...blocks);
    return {
      document: {
        ...document,
        content,
        updatedAt: new Date().toISOString(),
      },
      selectedId: blocks[blocks.length - 1]?.id ?? null,
    };
  }

  const richBlocks = blocks.filter(isRichBlock);
  if (richBlocks.length === 0) {
    return { document, selectedId: null };
  }

  let selectedId: string | null = null;
  const content = document.content.map((block) => {
    if (block.type !== "problem") {
      return block;
    }

    const replaced = replaceProblemRichBlock(block, triggerBlockId, richBlocks);
    if (!replaced.changed) {
      return block;
    }

    selectedId = richBlocks[richBlocks.length - 1]?.id ?? null;
    return replaced.problem;
  });

  if (!selectedId) {
    return { document, selectedId: null };
  }

  return {
    document: {
      ...document,
      content,
      updatedAt: new Date().toISOString(),
    },
    selectedId,
  };
}

export function mergeMaterialOverlayIntoDocument(document: SigmaDocument, overlaySnapshot: OverlaySnapshot): SigmaDocument {
  if (overlaySnapshot.shapes.length === 0 && Object.keys(overlaySnapshot.assets).length === 0) {
    return document;
  }

  const pageLayout = normalizePageLayout(document.pageLayout);
  const currentSnapshot = normalizeOverlaySnapshot(pageLayout.overlay?.overlaySnapshot);
  return {
    ...document,
    pageLayout: {
      ...pageLayout,
      overlay: {
        ...pageLayout.overlay,
        overlaySnapshot: {
          ...currentSnapshot,
          shapes: [...currentSnapshot.shapes, ...overlaySnapshot.shapes],
          assets: {
            ...currentSnapshot.assets,
            ...overlaySnapshot.assets,
          },
        },
        updatedAt: new Date().toISOString(),
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

export function isRichBlock(block: SigmaBlock): block is RichBlock {
  return block.type === "heading" || block.type === "paragraph" || block.type === "list";
}

function normalizeMaterialShapeToOrigin(
  shape: OverlayShape,
  origin: OverlayPoint,
  options: { detachBlockAnchors?: boolean },
): OverlayShape {
  const next = {
    ...shape,
    x: shape.x - origin.x,
    y: shape.y - origin.y,
  } as OverlayShape;

  if (options.detachBlockAnchors && next.anchor?.type === "block") {
    return {
      ...next,
      anchor: { type: "page" },
    };
  }

  return next;
}

function remapMaterialShapeAnchor(
  shape: OverlayShape,
  blockIdMap: Map<string, string>,
): OverlayShape {
  if (shape.anchor?.type !== "block") {
    return shape;
  }

  const nextBlockId = blockIdMap.get(shape.anchor.blockId);
  if (nextBlockId) {
    return {
      ...shape,
      anchor: {
        ...shape.anchor,
        blockId: nextBlockId,
      },
    };
  }

  return {
    ...shape,
    anchor: { type: "page" },
  };
}

function replaceProblemRichBlock(
  problem: ProblemNode,
  triggerBlockId: string,
  blocks: RichBlock[],
): { changed: boolean; problem: ProblemNode } {
  for (const area of ["lead", "prompt", "hints", "solution"] as const satisfies readonly ProblemAreaKind[]) {
    const index = problem[area].findIndex((block) => richBlockContainsId(block, triggerBlockId));
    if (index < 0) {
      continue;
    }

    const nextArea = [...problem[area]];
    nextArea.splice(index, 1, ...blocks);
    return {
      changed: true,
      problem: {
        ...problem,
        [area]: nextArea,
      },
    };
  }

  return { changed: false, problem };
}

export function collectMaterialBlockIds(blocks: readonly SigmaBlock[]): string[] {
  return blocks.flatMap((block) => {
    if (block.type === "problem") {
      return [
        block.id,
        ...collectRichBlockIds(block.lead),
        ...collectRichBlockIds(block.prompt),
        ...collectRichBlockIds(block.hints),
        ...collectRichBlockIds(block.solution),
      ];
    }

    if (block.type === "list") {
      return collectListBlockIds(block);
    }

    if (block.type === "boxBlock") {
      return [block.id, ...collectBoxBlockChildIds(block.blocks)];
    }

    if (block.type === "layoutSection") {
      return [block.id, ...collectLayoutSectionChildIds(block.children)];
    }

    return [block.id];
  });
}

function collectRichBlockIds(blocks: readonly ProblemAreaBlock[]): string[] {
  return blocks.flatMap((block) => {
    if (block.type === "layoutSection") {
      return [block.id, ...collectLayoutSectionChildIds(block.children)];
    }
    if (block.type === "boxBlock") {
      return [block.id, ...collectBoxBlockChildIds(block.blocks)];
    }
    return block.type === "list" ? collectListBlockIds(block) : [block.id];
  });
}

function collectBoxBlockChildIds(blocks: readonly BoxBlockChildBlock[]): string[] {
  return blocks.flatMap((block) => {
    if (block.type === "layoutSection") {
      return [block.id, ...collectLayoutSectionChildIds(block.children)];
    }
    if (block.type === "problem") return [block.id, ...collectRichBlockIds([...block.lead, ...block.prompt, ...block.hints, ...block.solution])];
    return collectLayoutSectionChildIds([block]);
  });
}

function collectLayoutSectionChildIds(blocks: readonly LayoutSectionChildBlock[]): string[] {
  return blocks.flatMap((block) => {
    if (block.type === "section") {
      return [block.id];
    }
    if (block.type === "boxBlock") {
      return [block.id, ...collectBoxBlockChildIds(block.blocks)];
    }
    return collectRichBlockIds([block]);
  });
}

function collectListBlockIds(block: ListNode): string[] {
  return [
    block.id,
    ...block.items.flatMap((item) => [
      item.id,
      ...(item.continuations ?? []).map((continuation) => continuation.id),
      ...(item.nested?.flatMap(collectListBlockIds) ?? []),
    ]),
  ];
}

function richBlockContainsId(block: ProblemAreaBlock, id: string): boolean {
  if (block.id === id) {
    return true;
  }
  if (block.type === "layoutSection") {
    return block.children.some((child) => collectLayoutSectionChildIds([child]).includes(id));
  }
  if (block.type === "boxBlock") {
    return collectBoxBlockChildIds(block.blocks).includes(id);
  }
  if (block.type !== "list") {
    return false;
  }
  return block.items.some((item) =>
    item.id === id ||
    item.continuations?.some((continuation) => continuation.id === id) ||
    item.nested?.some((nested) => richBlockContainsId(nested, id))
  );
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(
    value
      .map(normalizeOptionalString)
      .filter((item): item is string => Boolean(item)),
  );
}

function normalizeMaterialUsage(value: unknown): MaterialUsage {
  if (!isRecord(value)) {
    return {};
  }
  const useCases = normalizeStringList(value.useCases);
  const avoidWhen = normalizeStringList(value.avoidWhen);
  const aliases = normalizeStringList(value.aliases);
  return {
    ...(useCases.length > 0 ? { useCases } : {}),
    ...(avoidWhen.length > 0 ? { avoidWhen } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
  };
}

function hasMaterialUsage(value: MaterialUsage): boolean {
  return Boolean(value.useCases?.length || value.avoidWhen?.length || value.aliases?.length);
}

function normalizeMaterialTransformPolicy(value: unknown): MaterialTransformPolicy {
  if (!isRecord(value)) {
    return {};
  }
  return {
    ...(typeof value.scale === "boolean" ? { scale: value.scale } : {}),
    ...(typeof value.rotate === "boolean" ? { rotate: value.rotate } : {}),
  };
}

function hasMaterialTransformPolicy(value: MaterialTransformPolicy): boolean {
  return value.scale !== undefined || value.rotate !== undefined;
}

function normalizeMaterialPorts(value: unknown): MaterialPort[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ports: MaterialPort[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) {
      continue;
    }
    const x = finiteNumberOrUndefined(item.x);
    const y = finiteNumberOrUndefined(item.y);
    if (x === undefined || y === undefined) {
      continue;
    }
    ports.push({
      id: item.id.trim(),
      ...(normalizeOptionalString(item.label) ? { label: normalizeOptionalString(item.label) } : {}),
      x,
      y,
      ...(isMaterialPortKind(item.kind) ? { kind: item.kind } : {}),
    });
  }
  return ports;
}

function isMaterialPortKind(value: unknown): value is NonNullable<MaterialPort["kind"]> {
  return value === "point" ||
    value === "leftEnd" ||
    value === "rightEnd" ||
    value === "start" ||
    value === "end" ||
    value === "center";
}

function getMaterialBlockSummaryText(block: SigmaBlock | RichBlock | LayoutSectionChildBlock | BoxBlockChildBlock): string {
  if (block.type === "section") {
    return block.title.trim();
  }
  if (block.type === "heading" || block.type === "paragraph") {
    return inlineNodesToPlainText(block.children).trim();
  }
  if (block.type === "list") {
    return block.items
      .flatMap((item) => [
        inlineNodesToPlainText(item.children).trim(),
        ...(item.continuations ?? []).map((continuation) => inlineNodesToPlainText(listItemContinuationInlineNodes(continuation)).trim()),
      ])
      .find(Boolean) ?? "";
  }
  if (block.type === "layoutSection") {
    return block.children.map(getMaterialBlockSummaryText).find(Boolean) ?? "";
  }
  if (block.type === "boxBlock") {
    const title = inlineNodesToPlainText(block.title ?? []).trim();
    return title || block.blocks.map(getMaterialBlockSummaryText).find(Boolean) || "";
  }
  if (block.type === "divider") {
    return "";
  }
  if (block.type === "codeBlock") {
    return inlineNodesToPlainText(block.children).trim();
  }
  if (block.type === "quote") {
    return block.blocks.map(getMaterialBlockSummaryText).find(Boolean) ?? "";
  }
  return [...block.lead, ...block.prompt, ...block.hints, ...block.solution]
    .map(getMaterialBlockSummaryText)
    .find(Boolean) ?? "";
}

function collectMaterialBlockTypes(block: SigmaBlock | RichBlock | LayoutSectionChildBlock | BoxBlockChildBlock): string[] {
  if (block.type === "layoutSection") {
    return [block.type, ...block.children.flatMap(collectMaterialBlockTypes)];
  }
  if (block.type === "boxBlock") {
    return [block.type, ...block.blocks.flatMap(collectMaterialBlockTypes)];
  }
  if (block.type === "problem") {
    return [
      block.type,
      ...block.lead.flatMap(collectMaterialBlockTypes),
      ...block.prompt.flatMap(collectMaterialBlockTypes),
      ...block.hints.flatMap(collectMaterialBlockTypes),
      ...block.solution.flatMap(collectMaterialBlockTypes),
    ];
  }
  if (block.type === "list") {
    return [block.type, ...block.items.flatMap((item) => item.nested?.flatMap(collectMaterialBlockTypes) ?? [])];
  }
  return [block.type];
}

function transformMaterialShapeForPlacement(shape: OverlayShape, placement: MaterialPlacement): OverlayShape {
  const scaleX = positiveFiniteNumberOr(placement.scaleX ?? 1, 1);
  const scaleY = positiveFiniteNumberOr(placement.scaleY ?? placement.scaleX ?? 1, scaleX);
  const rotation = finiteNumberOr(placement.rotation, 0);
  if (scaleX === 1 && scaleY === 1 && rotation === 0) {
    return shape;
  }

  const next = {
    ...shape,
    x: placement.origin.x + (shape.x - placement.origin.x) * scaleX,
    y: placement.origin.y + (shape.y - placement.origin.y) * scaleY,
    ...(rotation === 0 ? {} : { rotation: finiteNumberOr(shape.rotation, 0) + rotation }),
    anchor: scaleMaterialAnchor(shape.anchor, scaleX, scaleY),
  } as OverlayShape;
  next.props = scaleMaterialShapeProps(next, shape, scaleX, scaleY) as OverlayShape["props"];
  return next;
}

function scaleMaterialAnchor(anchor: OverlayShape["anchor"], scaleX: number, scaleY: number): OverlayShape["anchor"] {
  if (!anchor) {
    return anchor;
  }
  if (anchor.type === "block") {
    return {
      ...anchor,
      dx: anchor.dx === undefined ? undefined : anchor.dx * scaleX,
      dy: anchor.dy * scaleY,
    };
  }
  if (anchor.type === "shape") {
    return {
      ...anchor,
      dx: anchor.dx * scaleX,
      dy: anchor.dy * scaleY,
      ...(anchor.rx === undefined ? {} : { rx: anchor.rx * scaleX }),
      ...(anchor.ry === undefined ? {} : { ry: anchor.ry * scaleY }),
    };
  }
  return anchor;
}

function scaleMaterialShapeProps(
  _next: OverlayShape,
  original: OverlayShape,
  scaleX: number,
  scaleY: number,
): Record<string, unknown> {
  const props = { ...original.props } as Record<string, unknown>;
  if (typeof props.w === "number") {
    props.w *= scaleX;
  }
  if (typeof props.h === "number") {
    props.h *= scaleY;
  }
  if (original.type === "arc") {
    props.r = typeof original.props.r === "number" ? original.props.r * Math.max(scaleX, scaleY) : props.r;
    props.rx = typeof original.props.rx === "number" ? original.props.rx * scaleX : props.rx;
    props.ry = typeof original.props.ry === "number" ? original.props.ry * scaleY : props.ry;
  }
  if (original.type === "arrow") {
    props.start = scalePoint(original.props.start, scaleX, scaleY);
    props.end = scalePoint(original.props.end, scaleX, scaleY);
  }
  if (original.type === "line") {
    props.points = original.props.points.map((point) => scalePoint(point, scaleX, scaleY));
  }
  if (original.type === "callout") {
    props.tail = {
      baseStart: scalePoint(original.props.tail.baseStart, scaleX, scaleY),
      baseEnd: scalePoint(original.props.tail.baseEnd, scaleX, scaleY),
      tip: scalePoint(original.props.tail.tip, scaleX, scaleY),
    };
  }
  if (original.type === "text" || original.type === "callout") {
    // Shrinking a material used to ride on `props.scale`, which existed only to multiply the font
    // size. With that gone the point size is the thing to scale — `w`/`h` above already moved, so
    // scaling the glyphs by the same factor keeps the text wrapping where the author put it.
    props.fontSize = getTextShapeFontSizePt(original) * Math.min(scaleX, scaleY);
  }
  return props;
}

function scalePoint(point: OverlayPoint, scaleX: number, scaleY: number): OverlayPoint {
  return {
    x: point.x * scaleX,
    y: point.y * scaleY,
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveFiniteNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
