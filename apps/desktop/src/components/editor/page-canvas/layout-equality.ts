import type { BlockExtent, MeasuredBlock } from "@/components/editor/overlay-canvas/anchor";
import type { TextFlowBoxFragmentSourceLayout } from "@/components/editor/TextFlowEditor";
import type { TextFlowColumnBlockLayout } from "@/features/rendering/core";
import type { PageMetrics } from "@/features/document";
import type {
  EditorBoxBlockFragmentLayout,
  FlowUnitLayout,
  ProblemAreaColumnLayout,
  ProblemAreaFrameFragmentLayout,
} from "./types";

/** Page layout normalization returns fresh objects, so structural checks compare geometry, not identity. */
export function samePageMetrics(a: PageMetrics, b: PageMetrics): boolean {
  return a.page.widthMm === b.page.widthMm &&
    a.page.heightMm === b.page.heightMm &&
    a.page.widthPx === b.page.widthPx &&
    a.page.heightPx === b.page.heightPx &&
    a.margins.topPx === b.margins.topPx &&
    a.margins.rightPx === b.margins.rightPx &&
    a.margins.bottomPx === b.margins.bottomPx &&
    a.margins.leftPx === b.margins.leftPx &&
    a.content.widthMm === b.content.widthMm &&
    a.content.heightMm === b.content.heightMm &&
    a.content.widthPx === b.content.widthPx &&
    a.content.heightPx === b.content.heightPx &&
    a.flow.columnCount === b.flow.columnCount &&
    a.flow.columnGapMm === b.flow.columnGapMm &&
    a.flow.columnGapPx === b.flow.columnGapPx &&
    a.flow.columnWidthMm === b.flow.columnWidthMm &&
    a.flow.columnWidthPx === b.flow.columnWidthPx;
}

export function sameGapMap(a: Record<string, number>, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (const key of aKeys) {
    if (Math.abs((a[key] ?? 0) - (b[key] ?? 0)) > 0.5) {
      return false;
    }
  }
  return true;
}

export function sameNumberMap(a: Record<string, number>, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (const key of aKeys) {
    if (Math.abs((a[key] ?? 0) - (b[key] ?? 0)) > 0.5) {
      return false;
    }
  }
  return true;
}

export function sameNullableNumber(a: number | null, b: number | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return Math.abs(a - b) <= 0.5;
}

export function sameUnitLayouts(a: Record<string, FlowUnitLayout>, b: Record<string, FlowUnitLayout>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }

  for (const key of aKeys) {
    const left = a[key];
    const right = b[key];
    if (
      !right ||
      Math.abs(left.x - right.x) > 0.5 ||
      Math.abs(left.y - right.y) > 0.5 ||
      Math.abs(left.width - right.width) > 0.5 ||
      Math.abs((left.height ?? 0) - (right.height ?? 0)) > 0.5
    ) {
      return false;
    }
  }

  return true;
}

export function sameTextFlowBlockLayouts(
  a: Record<string, TextFlowColumnBlockLayout>,
  b: Record<string, TextFlowColumnBlockLayout>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }

  for (const key of aKeys) {
    const left = a[key];
    const right = b[key];
    if (
      !right ||
      Math.abs(left.x - right.x) > 0.5 ||
      Math.abs(left.y - right.y) > 0.5 ||
      Math.abs(left.width - right.width) > 0.5
    ) {
      return false;
    }
  }

  return true;
}

export function sameTextFlowBoxFragmentSourceLayouts(
  a: Record<string, TextFlowBoxFragmentSourceLayout>,
  b: Record<string, TextFlowBoxFragmentSourceLayout>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }

  for (const key of aKeys) {
    const left = a[key];
    const right = b[key];
    if (
      !right ||
      Math.abs(left.visibleHeight - right.visibleHeight) > 0.5 ||
      left.origin?.x !== right.origin?.x ||
      left.origin?.y !== right.origin?.y ||
      left.origin?.width !== right.origin?.width ||
      Math.abs(left.totalHeight - right.totalHeight) > 0.5
    ) {
      return false;
    }
  }

  return true;
}

export function sameEditorBoxBlockFragmentLayouts(
  a: Record<string, EditorBoxBlockFragmentLayout[]>,
  b: Record<string, EditorBoxBlockFragmentLayout[]>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }

  for (const key of aKeys) {
    const leftFragments = a[key];
    const rightFragments = b[key];
    if (!rightFragments || leftFragments.length !== rightFragments.length) {
      return false;
    }
    for (let index = 0; index < leftFragments.length; index += 1) {
      const left = leftFragments[index];
      const right = rightFragments[index];
      if (
        !right ||
        left.blockId !== right.blockId ||
        left.fragmentIndex !== right.fragmentIndex ||
        Math.abs(left.x - right.x) > 0.5 ||
        Math.abs(left.y - right.y) > 0.5 ||
        Math.abs(left.width - right.width) > 0.5 ||
        Math.abs(left.height - right.height) > 0.5 ||
        Math.abs(left.sourceOffsetY - right.sourceOffsetY) > 0.5 ||
        Math.abs(left.totalHeight - right.totalHeight) > 0.5
      ) {
        return false;
      }
    }
  }

  return true;
}

export function sameProblemAreaFrameFragmentLayouts(
  a: Record<string, ProblemAreaFrameFragmentLayout[]>,
  b: Record<string, ProblemAreaFrameFragmentLayout[]>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }

  for (const key of aKeys) {
    const leftFragments = a[key];
    const rightFragments = b[key];
    if (!rightFragments || leftFragments.length !== rightFragments.length) {
      return false;
    }
    for (let index = 0; index < leftFragments.length; index += 1) {
      const left = leftFragments[index];
      const right = rightFragments[index];
      if (
        !right ||
        Math.abs(left.x - right.x) > 0.5 ||
        Math.abs(left.y - right.y) > 0.5 ||
        Math.abs(left.width - right.width) > 0.5 ||
        Math.abs(left.height - right.height) > 0.5
      ) {
        return false;
      }
    }
  }

  return true;
}

export function sameMeasuredBlockMap(a: Map<string, MeasuredBlock>, b: Map<string, MeasuredBlock>): boolean {
  // 増分計測が「どこも動いていない」パスで前回のマップをそのまま返すので、参照が同じなら
  // 中身を比べる必要はない (1,500 要素の全比較を丸ごと省ける)。
  if (a === b) {
    return true;
  }
  if (a.size !== b.size) {
    return false;
  }

  for (const [id, left] of a) {
    const right = b.get(id);
    // 増分計測は動いていないブロックのオブジェクトをそのまま持ち越すので、参照一致なら
    // 中身を見る必要がない (行ボックス配列の比較まで省ける)。
    if (left === right) {
      continue;
    }
    if (
      !right ||
      Math.abs(left.top - right.top) > 0.5 ||
      Math.abs((left.left ?? 0) - (right.left ?? 0)) > 0.5 ||
      Math.abs((left.width ?? 0) - (right.width ?? 0)) > 0.5 ||
      Math.abs((left.height ?? 0) - (right.height ?? 0)) > 0.5 ||
      !sameMeasuredLines(left.lines, right.lines)
    ) {
      return false;
    }
  }

  return true;
}

export function sameBlockExtentMap(a: Map<string, BlockExtent>, b: Map<string, BlockExtent>): boolean {
  // 増分計測が「どこも動いていない」パスで前回のマップをそのまま返すので、参照が同じなら
  // 中身を比べる必要はない (1,500 要素の全比較を丸ごと省ける)。
  if (a === b) {
    return true;
  }
  if (a.size !== b.size) {
    return false;
  }

  for (const [id, left] of a) {
    const right = b.get(id);
    // 増分計測は動いていないブロックのオブジェクトをそのまま持ち越すので、参照一致なら
    // 中身を見る必要がない (行ボックス配列の比較まで省ける)。
    if (left === right) {
      continue;
    }
    if (
      !right ||
      Math.abs(left.top - right.top) > 0.5 ||
      Math.abs(left.height - right.height) > 0.5 ||
      Math.abs((left.left ?? 0) - (right.left ?? 0)) > 0.5 ||
      Math.abs((left.width ?? 0) - (right.width ?? 0)) > 0.5
    ) {
      return false;
    }
  }

  return true;
}

function sameMeasuredLines(a: MeasuredBlock["lines"], b: MeasuredBlock["lines"]): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const l = left[index];
    const r = right[index];
    if (
      l.index !== r.index ||
      Math.abs(l.top - r.top) > 0.5 ||
      Math.abs(l.height - r.height) > 0.5 ||
      Math.abs((l.left ?? 0) - (r.left ?? 0)) > 0.5 ||
      Math.abs((l.width ?? 0) - (r.width ?? 0)) > 0.5
    ) {
      return false;
    }
  }

  return true;
}

export function sameProblemAreaColumnLayouts(
  a: Record<string, ProblemAreaColumnLayout>,
  b: Record<string, ProblemAreaColumnLayout>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }

  for (const key of aKeys) {
    const left = a[key];
    const right = b[key];
    if (
      !right ||
      Math.abs(left.totalHeightPx - right.totalHeightPx) > 0.5 ||
      Math.abs(left.columnWidthPx - right.columnWidthPx) > 0.5 ||
      Math.abs(left.columnGapPx - right.columnGapPx) > 0.5 ||
      !sameTextFlowBlockLayouts(left.blockLayouts, right.blockLayouts) ||
      !sameTextFlowBlockLayouts(left.markerLayouts, right.markerLayouts)
    ) {
      return false;
    }
  }

  return true;
}
