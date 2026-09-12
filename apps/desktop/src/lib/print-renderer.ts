import {
  ensurePageLayout,
  getDefaultPageLayout,
  isWhiteboardPageLayout,
  MM_TO_PX,
  normalizeOverlaySnapshot,
  type OverlayShape,
  type BoxBlockChildBlock,
  type SigmaBlock,
  type SigmaDocument,
  type LayoutSectionChildBlock,
  type OutputProfile,
  type OutputProfileName,
  type PageLayout,
  type RichBlock,
  type ProblemNode,
  WHITEBOARD_BASE_CELL_PX,
} from "@/features/document";
import { getShapesVisualBounds, resolveShapeAnchorPositions } from "@/features/drawing";

import { collectBlocksById, collectProblemAreaBlockLocations, type ProblemAreaBlockLocation } from "@/lib/document-tree";
import { resolveDocumentTitle } from "@/lib/document-title";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";

const DEFAULT_PRINT_TRANSLATE = createCurrentLocaleTranslator("print");

export function resolveOutputProfile(
  document: SigmaDocument,
  profileName: OutputProfileName,
): OutputProfile {
  return document.outputProfiles[profileName] ?? document.outputProfiles.teacher;
}

export function getPrintableDocument(
  document: SigmaDocument,
  profileName: OutputProfileName,
  t: Translate<"print"> = DEFAULT_PRINT_TRANSLATE,
): SigmaDocument {
  const sourceDocument = ensurePageLayout(document);
  const profile = resolveOutputProfile(sourceDocument, profileName);
  if (isWhiteboardPageLayout(sourceDocument.pageLayout)) {
    return cropWhiteboardDocumentForPrint(sourceDocument);
  }
  const problemAreaBlockLocations = collectProblemAreaBlockLocations(sourceDocument);

  if (profile.onlySolutions) {
    const content = buildAnswerBookContent(sourceDocument.content, profile, t);
    return {
      ...sourceDocument,
      metadata: {
        ...sourceDocument.metadata,
        title: t("baked.answerBookTitle", { title: resolveDocumentTitle(sourceDocument) }),
      },
      content,
      pageLayout: filterPageLayoutOverlay(sourceDocument.pageLayout, collectVisibleBlockIds(content), problemAreaBlockLocations),
    };
  }

  const content = sourceDocument.content.flatMap((block) => filterBlock(block, profile));
  return {
    ...sourceDocument,
    content,
    pageLayout: filterPageLayoutOverlay(sourceDocument.pageLayout, collectVisibleBlockIds(content), problemAreaBlockLocations),
  };
}

export const WHITEBOARD_PRINT_PADDING_PX = 40;

/**
 * Turns an infinite whiteboard into one custom paper sheet around its visible shapes.
 * The stored document remains a whiteboard; this custom layout exists only in the print view.
 */
export function cropWhiteboardDocumentForPrint(document: SigmaDocument): SigmaDocument {
  const source = ensurePageLayout(document);
  const snapshot = normalizeOverlaySnapshot(source.pageLayout?.overlay?.overlaySnapshot);
  const visibleShapes = resolveShapeAnchorPositions(snapshot.shapes)
    .filter((shape) => !isShapeHiddenForPrint(shape, snapshot.shapes));
  const bounds = getShapesVisualBounds(visibleShapes, visibleShapes);

  if (!bounds) {
    return {
      ...source,
      content: [],
      pageLayout: {
        ...getDefaultPageLayout("A4"),
        preset: "custom",
        marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
        flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
        header: undefined,
        footer: undefined,
        background: source.pageLayout?.background,
        overlay: {
          ...source.pageLayout?.overlay,
          overlaySnapshot: snapshot,
        },
      },
    };
  }

  const background = source.pageLayout?.background;
  // 下地のパターンがあるときは、切り出し原点をセル境界へ寄せる。紙面は原点を 0 として
  // 同じ 24px セルで描くので、原点がセルの倍数でなければ紙面のグリッドが画面のワールド
  // グリッドと位相ずれし、「図形とマス目の相対位置が画面と違う」紙が出る。
  // ジオメトリを動かすのはここだけで、寄せたぶんは紙を広げて吸収する (余白は 40〜63px)。
  const snapsToCells = background === "grid" || background === "dots";
  const snapOrigin = (value: number) => (
    snapsToCells
      ? Math.floor(value / WHITEBOARD_BASE_CELL_PX) * WHITEBOARD_BASE_CELL_PX
      : value
  );
  const originX = snapOrigin(bounds.x - WHITEBOARD_PRINT_PADDING_PX);
  const originY = snapOrigin(bounds.y - WHITEBOARD_PRINT_PADDING_PX);
  const widthPx = Math.max(1, bounds.x + bounds.w + WHITEBOARD_PRINT_PADDING_PX - originX);
  const heightPx = Math.max(1, bounds.y + bounds.h + WHITEBOARD_PRINT_PADDING_PX - originY);
  const translatedShapes = snapshot.shapes.map((shape) => ({
    ...shape,
    x: shape.x - originX,
    y: shape.y - originY,
  }));

  return {
    ...source,
    content: [],
    pageLayout: {
      ...getDefaultPageLayout("A4"),
      preset: "custom",
      pageSize: {
        widthMm: widthPx / MM_TO_PX,
        heightMm: heightPx / MM_TO_PX,
      },
      marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
      header: undefined,
      footer: undefined,
      background,
      overlay: {
        ...source.pageLayout?.overlay,
        overlaySnapshot: { ...snapshot, shapes: translatedShapes },
      },
    },
  };
}

function isShapeHiddenForPrint(shape: OverlayShape, allShapes: readonly OverlayShape[]): boolean {
  const byId = new Map(allShapes.map((candidate) => [candidate.id, candidate]));
  const visited = new Set<string>();
  let current: OverlayShape | undefined = shape;
  while (current && !visited.has(current.id)) {
    if (current.hidden) return true;
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

export function shouldRenderAnswer(profile: OutputProfile): boolean {
  return profile.includeAnswers === true;
}

export function shouldRenderSolution(profile: OutputProfile): boolean {
  return profile.showSolutions === true || profile.onlySolutions === true;
}

export function shouldRenderHint(profile: OutputProfile): boolean {
  return profile.showHints === true;
}

function filterBlock<T extends SigmaBlock>(block: T, profile: OutputProfile): T[] {
  if (block.type === "boxBlock" || block.type === "quote") return [{ ...block, blocks: block.blocks.flatMap((child) => filterBlock(child, profile)) }];
  if (block.type === "layoutSection") return [{ ...block, children: block.children.flatMap((child) => filterBlock(child, profile)) }];
  if (block.type === "problem") {
    return [
      {
        ...block,
        answer: shouldRenderAnswer(profile) ? block.answer : undefined,
        lead: block.lead.flatMap((child) => filterBlock(child, profile)),
        prompt: block.prompt.flatMap((child) => filterBlock(child, profile)),
        solution: shouldRenderSolution(profile) ? block.solution.flatMap((child) => filterBlock(child, profile)) : [],
        hints: shouldRenderHint(profile) ? block.hints.flatMap((child) => filterBlock(child, profile)) : [],
      },
    ];
  }

  return [block];
}

function buildAnswerBookContent(
  content: SigmaBlock[],
  profile: OutputProfile,
  t: Translate<"print">,
): SigmaBlock[] {
  const blocks: SigmaBlock[] = [
    {
      type: "heading",
      id: "answer_book_heading",
      level: 1,
      children: [{ type: "text", text: t("baked.answerHeading") }],
    },
  ];

  let nextProblemNumber = 1;
  for (const block of collectBlocksById(content).values()) {
    if (block.type !== "problem") {
      continue;
    }

    const specifiedNumber = getSpecifiedProblemNumber(block);
    const problemNumber = specifiedNumber ?? nextProblemNumber;
    blocks.push(...problemToAnswerBlocks(block, problemNumber, profile, t));
    nextProblemNumber = problemNumber + 1;
  }

  return blocks;
}

function getSpecifiedProblemNumber(problem: ProblemNode): number | undefined {
  const value = problem.numbering?.value;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function filterPageLayoutOverlay(
  pageLayout: PageLayout | undefined,
  visibleBlockIds: Set<string>,
  problemAreaBlockLocations: Map<string, ProblemAreaBlockLocation>,
): PageLayout | undefined {
  const overlay = pageLayout?.overlay;
  if (!pageLayout || !overlay?.overlaySnapshot) {
    return pageLayout;
  }

  const snapshot = normalizeOverlaySnapshot(overlay.overlaySnapshot);
  return {
    ...pageLayout,
    overlay: {
      ...overlay,
      overlaySnapshot: {
        ...snapshot,
        shapes: filterVisibleOverlayShapes(snapshot.shapes, visibleBlockIds, problemAreaBlockLocations),
      },
    },
  };
}

function filterVisibleOverlayShapes(
  shapes: OverlayShape[],
  visibleBlockIds: Set<string>,
  problemAreaBlockLocations: Map<string, ProblemAreaBlockLocation>,
): OverlayShape[] {
  const shapeById = new Map(shapes.map((shape) => [shape.id, shape]));
  const visibilityCache = new Map<string, boolean>();

  const isVisibleShape = (shape: OverlayShape, visiting = new Set<string>()): boolean => {
    const cached = visibilityCache.get(shape.id);
    if (cached !== undefined) {
      return cached;
    }

    if (visiting.has(shape.id)) {
      visibilityCache.set(shape.id, false);
      return false;
    }

    visiting.add(shape.id);
    let visible = true;

    if (shape.anchor?.type === "block") {
      const owner = problemAreaBlockLocations.get(shape.anchor.blockId);
      visible = owner
        ? visibleBlockIds.has(owner.blockId)
        : visibleBlockIds.has(shape.anchor.blockId);
    } else if (shape.anchor?.type === "shape") {
      const parent = shapeById.get(shape.anchor.shapeId);
      visible = parent ? isVisibleShape(parent, visiting) : false;
    }

    visiting.delete(shape.id);
    visibilityCache.set(shape.id, visible);
    return visible;
  };

  return shapes.filter((shape) => isVisibleShape(shape));
}

function collectVisibleBlockIds(content: SigmaBlock[]): Set<string> {
  const ids = new Set<string>();
  const visitTextFlowBlock = (block: RichBlock | LayoutSectionChildBlock | BoxBlockChildBlock) => {
    ids.add(block.id);
    if (block.type === "layoutSection") {
      block.children.forEach(visitTextFlowBlock);
      return;
    }
    if (block.type === "boxBlock") {
      block.blocks.forEach(visitTextFlowBlock);
      return;
    }
    if (block.type === "list") {
      for (const item of block.items) {
        ids.add(item.id);
        item.continuations?.forEach(visitTextFlowBlock);
        item.nested?.forEach(visitTextFlowBlock);
      }
    }
  };

  for (const block of content) {
    ids.add(block.id);
    if (block.type === "list") {
      visitTextFlowBlock(block);
    }
    if (block.type === "layoutSection") {
      block.children.forEach(visitTextFlowBlock);
    }
    if (block.type === "boxBlock") {
      block.blocks.forEach(visitTextFlowBlock);
    }
    if (block.type === "problem") {
      block.lead.forEach(visitTextFlowBlock);
      block.prompt.forEach(visitTextFlowBlock);
      block.solution.forEach(visitTextFlowBlock);
      block.hints.forEach(visitTextFlowBlock);
    }
  }

  return ids;
}

function problemToAnswerBlocks(
  problem: ProblemNode,
  problemNumber: number,
  profile: OutputProfile,
  t: Translate<"print">,
): SigmaBlock[] {
  const blocks: SigmaBlock[] = [
    {
      type: "heading",
      id: `${problem.id}_answer_problem_${problemNumber}`,
      level: 2,
      children: [{ type: "text", text: t("baked.problemHeading", { number: problemNumber }) }],
    },
  ];

  if (shouldRenderAnswer(profile) && problem.answer?.expected) {
    blocks.push({
      type: "paragraph",
      id: `${problem.id}_answer_expected_${problemNumber}`,
      children: [
        {
          type: "mathInline",
          id: `${problem.id}_answer_expected_math_${problemNumber}`,
          tex: problem.answer.expected,
          display: "inline",
          semanticRole: "expression",
        },
      ],
      align: "center",
    });
  }

  blocks.push(...problem.solution);
  return blocks;
}
