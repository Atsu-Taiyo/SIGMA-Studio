import { PROBLEM_AREA_ORDER, type OverlayShape, type ProblemNode, type SigmaBlock } from "@/features/document";

import { shouldShowProblemArea } from "./problem-area-visibility";
import { isProblemDisplayFiltered, type ProblemDisplayFilter } from "./problem-display-filter";

/**
 * 設定 > 表示 で絞っている間、編集面に描かれないブロック。隠した領域の中のすべてのブロック (入れ子も) と、
 * 領域が 1 つも描かれない問題そのもの。
 *
 * 紙面に直に置いた問題はページ割り (`buildRenderUnits`) が隠した領域を描かず、箱の中の問題は箱の編集面が
 * 隠した領域を畳む (`nested-problem-extension.ts`)。どちらも同じ `shouldShowProblemArea` で決める。
 * 絞っていなければ空。
 */
export function collectProblemDisplayHiddenBlockIds(
  content: readonly SigmaBlock[],
  display: ProblemDisplayFilter,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  if (!isProblemDisplayFiltered(display)) {
    return hidden;
  }
  forEachDrawnProblem(content, (problem) => {
    let drawnAreaCount = 0;
    for (const area of PROBLEM_AREA_ORDER) {
      if (shouldShowProblemArea(problem, area, display)) {
        drawnAreaCount += 1;
      } else {
        collectIdsWithin(problem[area], hidden);
      }
    }
    if (drawnAreaCount === 0) {
      hidden.add(problem.id);
    }
    return drawnAreaCount > 0;
  }, display);
  return hidden;
}

/**
 * 絞り込みで紙面から外す図形: 描かれないブロックに錨を下ろした図形、「問題」を隠す表示で問題そのもの
 * (導入文の位置) を基準にした図形、それらを基準にした図形 (`anchor.type === "shape"`) とグループの中身。
 *
 * 錨の先が描かれていない図形は、前回の位置のまま浮き、保存時の付け替えが見えている本文へ錨を移してしまう。
 * 見せず、触らせず、書き換えさせない (`OverlayEditPolicy`) ための集合。
 */
export function collectProblemDisplayHiddenShapeIds(
  content: readonly SigmaBlock[],
  shapes: readonly OverlayShape[],
  display: ProblemDisplayFilter,
  hiddenBlockIds: ReadonlySet<string> = collectProblemDisplayHiddenBlockIds(content, display),
): ReadonlySet<string> {
  const hidden = new Set<string>();
  if (!isProblemDisplayFiltered(display) || shapes.length === 0) {
    return hidden;
  }
  // 問題の id は先頭に描かれた領域が持つ。「問題」を隠すと、それは導入文ではなく解答などになる。
  const lostProblemIds = new Set<string>();
  if (!display.problem) {
    forEachDrawnProblem(content, (problem) => {
      lostProblemIds.add(problem.id);
      return true;
    }, display);
  }
  const shapeById = new Map(shapes.map((shape) => [shape.id, shape]));
  const verdicts = new Map<string, boolean>();

  const isHidden = (shape: OverlayShape, visiting: Set<string>): boolean => {
    const known = verdicts.get(shape.id);
    if (known !== undefined) {
      return known;
    }
    if (visiting.has(shape.id)) {
      return false;
    }
    visiting.add(shape.id);
    const anchor = shape.anchor;
    const parentAnchor = anchor?.type === "shape" ? shapeById.get(anchor.shapeId) : undefined;
    const group = shape.parentId ? shapeById.get(shape.parentId) : undefined;
    const verdict = (anchor?.type === "block" && (hiddenBlockIds.has(anchor.blockId) || lostProblemIds.has(anchor.blockId)))
      || (parentAnchor !== undefined && isHidden(parentAnchor, visiting))
      || (group !== undefined && isHidden(group, visiting));
    visiting.delete(shape.id);
    verdicts.set(shape.id, verdict);
    return verdict;
  };

  for (const shape of shapes) {
    if (isHidden(shape, new Set())) {
      hidden.add(shape.id);
    }
  }
  return hidden;
}

/**
 * 描かれうる問題を文書の順にたどる (紙面に直に置いた問題と、箱・段組み・問題の領域の中の箱にある問題)。
 * 隠した領域の中はたどらない (そこは丸ごと描かれない)。`visit` が false を返した問題の中もたどらない。
 */
function forEachDrawnProblem(
  blocks: readonly unknown[],
  visit: (problem: ProblemNode) => boolean,
  display: ProblemDisplayFilter,
): void {
  for (const block of blocks as readonly SigmaBlock[]) {
    if (block.type === "problem") {
      if (!visit(block)) {
        continue;
      }
      for (const area of PROBLEM_AREA_ORDER) {
        if (shouldShowProblemArea(block, area, display)) {
          forEachDrawnProblem(block[area], visit, display);
        }
      }
    } else if (block.type === "boxBlock") {
      forEachDrawnProblem(block.blocks, visit, display);
    } else if (block.type === "layoutSection") {
      forEachDrawnProblem(block.children, visit, display);
    }
  }
}

/** `value` の中で id を持つものすべて (入れ物の種類によらない)。 */
function collectIdsWithin(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((child) => collectIdsWithin(child, ids));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const id = (value as { id?: unknown }).id;
  if (typeof id === "string") {
    ids.add(id);
  }
  Object.values(value).forEach((child) => collectIdsWithin(child, ids));
}
