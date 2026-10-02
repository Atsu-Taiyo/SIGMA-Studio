import {
  normalizeOverlaySnapshot,
  type PageOverlay,
  type ProblemAreaKind,
  type ProblemNode,
  type RichBlock,
  type SigmaDocument,
} from "@/features/document";
import { getShapeBounds,hitTestShape } from "@/features/drawing";
import { isProblemAreaKind } from "@/features/text-editing";
import { createEmptyProblemAreaAnchorBlock } from "@/lib/document-tree";
import { measureBlockTops,resolveShapeAnchorPositions,resolveShapesPosition } from "../overlay-canvas/anchor";
import type { OverlayPoint,OverlayShape } from "../overlay-canvas/types";
import { emptyProblemAreaEditorBlockId,PROBLEM_AREA_ORDER } from "./block-ops";
import { calculateReserveSpaceGaps } from "./layout-measure";

export const BODY_MODE_OPEN_STROKE_HIT_MARGIN = 14;

export const BODY_MODE_OVERLAY_HIT_MARGIN = 8;

export interface EmptyProblemAreaOverlayAnchorAddition {
  problemId: string;
  area: ProblemAreaKind;
  block: RichBlock;
}

export interface EmptyProblemAreaOverlayAnchorTarget {
  problemId: string;
  area: ProblemAreaKind;
  hitBounds: OverlayRect;
  anchorBounds: OverlayRect;
}

export interface OverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function materializeEmptyProblemAreaOverlayAnchors(
  overlay: PageOverlay,
  document: SigmaDocument,
  overlayLayerElement: HTMLElement | null,
  canvasWidth: number,
  canvasHeight: number,
  blockAnchorScopeElement: HTMLElement | null = null,
): { overlay: PageOverlay; additions: EmptyProblemAreaOverlayAnchorAddition[] } {
  if (!overlay.overlaySnapshot || !overlayLayerElement) {
    return { overlay, additions: [] };
  }

  const layerRect = overlayLayerElement.getBoundingClientRect();
  if (layerRect.width <= 0 || layerRect.height <= 0) {
    return { overlay, additions: [] };
  }

  const targets = collectEmptyProblemAreaOverlayAnchorTargets(
    document,
    overlayLayerElement,
    layerRect,
    canvasWidth,
    canvasHeight,
    blockAnchorScopeElement,
  );
  if (targets.length === 0) {
    return { overlay, additions: [] };
  }

  const knownBlockIds = collectDocumentBlockIds(document);
  const snapshot = normalizeOverlaySnapshot(overlay.overlaySnapshot);
  const pageCanvas = overlayLayerElement.closest(".page-canvas");
  const scope = blockAnchorScopeElement && overlayLayerElement.ownerDocument.contains(blockAnchorScopeElement)
    ? blockAnchorScopeElement
    : pageCanvas?.querySelector<HTMLElement>(".page-flow") ?? pageCanvas ?? overlayLayerElement.ownerDocument;
  const { rects } = measureBlockTops(overlayLayerElement, scope, canvasHeight, canvasWidth);
  const resolvedShapes = rects.size > 0
    ? resolveShapesPosition(snapshot.shapes, rects, calculateReserveSpaceGaps(snapshot.shapes))
    : resolveShapeAnchorPositions(snapshot.shapes);
  const resolvedShapeById = new Map(resolvedShapes.map((shape) => [shape.id, shape]));
  const createdBlocksByTarget = new Map<string, RichBlock>();
  const additions: EmptyProblemAreaOverlayAnchorAddition[] = [];
  let changed = false;

  const shapes = snapshot.shapes.map((shape): OverlayShape => {
    if (shape.anchor?.type === "page" || shape.anchor?.type === "shape") {
      return shape;
    }

    const displayShape = resolvedShapeById.get(shape.id) ?? shape;
    const bounds = getShapeBounds(displayShape);
    const target = targets.find((item) => pointInsideOverlayRect({
      x: bounds.x + bounds.w / 2,
      y: bounds.y + bounds.h / 2,
    }, item.hitBounds));
    if (!target) {
      return shape;
    }
    if (
      shape.anchor?.type === "block" &&
      !knownBlockIds.has(shape.anchor.blockId) &&
      shape.anchor.blockId !== emptyProblemAreaEditorBlockId(target.problemId, target.area)
    ) {
      return shape;
    }

    const targetKey = `${target.problemId}:${target.area}`;
    let block = createdBlocksByTarget.get(targetKey);
    if (!block) {
      block = createEmptyProblemAreaAnchorBlock(target.area);
      createdBlocksByTarget.set(targetKey, block);
      knownBlockIds.add(block.id);
      additions.push({ problemId: target.problemId, area: target.area, block });
    }

    changed = true;
    return {
      ...shape,
      anchor: {
        type: "block",
        blockId: block.id,
        dx: displayShape.x - target.anchorBounds.x,
        dy: displayShape.y - target.anchorBounds.y,
      },
    };
  });
  return {
    overlay: changed
      ? {
          ...overlay,
          overlaySnapshot: {
            ...snapshot,
            shapes,
          },
        }
      : overlay,
    additions,
  };
}

export function collectEmptyProblemAreaOverlayAnchorTargets(
  document: SigmaDocument,
  overlayLayerElement: HTMLElement,
  layerRect: DOMRect,
  canvasWidth: number,
  canvasHeight: number,
  blockAnchorScopeElement: HTMLElement | null = null,
): EmptyProblemAreaOverlayAnchorTarget[] {
  const problemById = new Map(document.content
    .filter((block): block is ProblemNode => block.type === "problem")
    .map((problem) => [problem.id, problem]));
  const targets: EmptyProblemAreaOverlayAnchorTarget[] = [];

  const searchRoot: ParentNode = blockAnchorScopeElement && overlayLayerElement.ownerDocument.contains(blockAnchorScopeElement)
    ? blockAnchorScopeElement
    : overlayLayerElement.ownerDocument;

  searchRoot
    .querySelectorAll<HTMLElement>("[data-problem-area][data-problem-id]")
    .forEach((areaElement) => {
      const problemId = areaElement.getAttribute("data-problem-id");
      const areaValue = areaElement.getAttribute("data-problem-area");
      const problem = problemId ? problemById.get(problemId) : null;
      const area = isProblemAreaKind(areaValue) ? areaValue : null;
      if (!problemId || !problem || !area || problem[area].length > 0) {
        return;
      }

      const hitBounds = elementRectToOverlayRect(areaElement, layerRect, canvasWidth, canvasHeight);
      const bodyElement = areaElement.querySelector<HTMLElement>(".problem-area-paper-body") ?? areaElement;
      const emptyBlockId = emptyProblemAreaEditorBlockId(problemId, area);
      const placeholderBlock = areaElement.querySelector<HTMLElement>(`[data-sigma-doc-id="${CSS.escape(emptyBlockId)}"]`);
      const anchorElement = placeholderBlock ?? bodyElement;
      targets.push({
        problemId,
        area,
        hitBounds,
        anchorBounds: elementRectToOverlayRect(anchorElement, layerRect, canvasWidth, canvasHeight),
      });
    });

  return targets;
}

export function collectDocumentBlockIds(document: SigmaDocument): Set<string> {
  const ids = new Set<string>();
  for (const block of document.content) {
    ids.add(block.id);
    if (block.type === "layoutSection") {
      block.children.forEach((child) => ids.add(child.id));
    }
    if (block.type !== "problem") {
      continue;
    }
    for (const area of PROBLEM_AREA_ORDER) {
      block[area].forEach((richBlock) => ids.add(richBlock.id));
    }
  }
  return ids;
}

export function elementRectToOverlayRect(
  element: HTMLElement,
  layerRect: DOMRect,
  canvasWidth: number,
  canvasHeight: number,
): OverlayRect {
  const rect = element.getBoundingClientRect();
  const scaleX = canvasWidth / layerRect.width;
  const scaleY = canvasHeight / layerRect.height;
  return {
    x: (rect.left - layerRect.left) * scaleX,
    y: (rect.top - layerRect.top) * scaleY,
    w: rect.width * scaleX,
    h: rect.height * scaleY,
  };
}

export function pointInsideOverlayRect(point: OverlayPoint, rect: OverlayRect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w &&
    point.y >= rect.y && point.y <= rect.y + rect.h;
}

export function getTopmostBodyModeOverlayHit(shapes: OverlayShape[], point: OverlayPoint): OverlayShape | null {
  for (let index = shapes.length - 1; index >= 0; index -= 1) {
    const shape = shapes[index];
    const margin = isBodyModeOpenStrokeShape(shape)
      ? BODY_MODE_OPEN_STROKE_HIT_MARGIN
      : BODY_MODE_OVERLAY_HIT_MARGIN;
    if (hitTestShape(shape, point, margin)) {
      return shape;
    }
  }

  return null;
}

export function isBodyModeOpenStrokeShape(shape: OverlayShape): boolean {
  return shape.type === "arrow" || shape.type === "line" || shape.type === "arc";
}
