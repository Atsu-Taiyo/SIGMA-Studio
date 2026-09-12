/**
 * ブロックのドラッグ中、「ポインタの下に何があるか」(DOM の実測) から「どこへ落とすか」と
 * 「線をどこに描くか」を決める純関数。DOM は触らない — 実測は呼び出し側が集めて渡す。
 *
 * 座標はすべて紙面のレイアウト px (アフォーダンス層と同じ)。
 */

import {
  containerAllowsNewColumns,
  type BlockDropTarget,
  type DragContainerKind,
} from "@/lib/block-drag-move";
import type { ProblemAreaKind } from "@/features/document";

export interface DragBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 落とし先候補の祖先。内側から外側の順。 */
export interface DragHitAncestor {
  id: string;
  box: DragBox;
}

export type DragHit =
  | {
      kind: "unit";
      id: string;
      type: string;
      /** 見た目の箱 (リスト項目なら入れ子ごと、問題ならエリアの合併)。線の幅・高さの出典。 */
      box: DragBox;
      /** その単位自身の行 (リスト項目なら 1 行目の段落)。前後の判定はこちらで行う。 */
      ownBox: DragBox;
      containerKind: DragContainerKind;
      isFirstInContainer: boolean;
      isLastInContainer: boolean;
      /** 内側から外側へ並べた祖先 (入れ物・リスト・項目)。前後の判定を外へ逃がす候補。 */
      ancestors: readonly DragHitAncestor[];
      /** 多段の段組の直下 (または直下の子孫) にいるとき、その段組と直下の子。 */
      section: { id: string; childId: string; columnBox: DragBox } | null;
      /** リストの項目のとき、そのリストが置かれている入れ物 (段組化できるかの判定に使う)。 */
      listContainerKind?: DragContainerKind;
      /** 隙間から拾ったとき、どちらの辺のそばか。 */
      gapEdge?: "top" | "bottom" | null;
    }
  | {
      kind: "area";
      problemId: string;
      area: ProblemAreaKind;
      box: DragBox;
    };

export type DropIndicator =
  | { orientation: "horizontal"; top: number; left: number; width: number }
  | { orientation: "vertical"; left: number; top: number; height: number };

export interface DropResolution {
  target: BlockDropTarget;
  indicator: DropIndicator;
}

export interface ResolveDropOptions {
  /** 掴んでいる単位がすべて横並びにできる型か。 */
  columnEligible: boolean;
  canDrop: (target: BlockDropTarget) => boolean;
  /** 左右端の帯の幅 (px)。省略時はブロック幅から決める。 */
  edgeZonePx?: number;
}

/** 入れ物の端に寄ったとき、内側の子ではなく入れ物そのものの前後にする距離。 */
const CONTAINER_EDGE_ESCALATE_PX = 10;
/** 縦線を段の端から外へ出す量。 */
const COLUMN_LINE_OFFSET_PX = 6;
const MIN_EDGE_ZONE_PX = 20;
const MAX_EDGE_ZONE_PX = 56;

export function resolveEdgeZonePx(box: DragBox): number {
  const width = Math.max(0, box.right - box.left);
  return Math.max(MIN_EDGE_ZONE_PX, Math.min(MAX_EDGE_ZONE_PX, width * 0.18));
}

export function resolveDropFromHit(
  hit: DragHit | null,
  point: { x: number; y: number },
  options: ResolveDropOptions,
): DropResolution | null {
  if (!hit) {
    return null;
  }
  if (hit.kind === "area") {
    const target: BlockDropTarget = { kind: "areaEnd", problemId: hit.problemId, area: hit.area };
    return options.canDrop(target)
      ? { target, indicator: horizontalLine(hit.box, "after") }
      : null;
  }

  const column = resolveColumnDrop(hit, point, options);
  if (column) {
    return column;
  }

  const position: "before" | "after" = hit.gapEdge
    ? (hit.gapEdge === "bottom" ? "after" : "before")
    : (point.y < (hit.ownBox.top + hit.ownBox.bottom) / 2 ? "before" : "after");

  // 入れ物の端に寄っていれば、内側の子ではなく入れ物そのものの前後 (箱の外へ出す道)。
  const nearest = hit.ancestors[0];
  if (nearest) {
    const nearContainerEdge = position === "before"
      ? hit.isFirstInContainer && point.y - nearest.box.top <= CONTAINER_EDGE_ESCALATE_PX
      : hit.isLastInContainer && nearest.box.bottom - point.y <= CONTAINER_EDGE_ESCALATE_PX;
    if (nearContainerEdge) {
      const escalated = tryAnchors(hit.ancestors, position, options);
      if (escalated) {
        return escalated;
      }
    }
  }

  return tryAnchors([{ id: hit.id, box: hit.box }, ...hit.ancestors], position, options);
}

function tryAnchors(
  anchors: readonly DragHitAncestor[],
  position: "before" | "after",
  options: ResolveDropOptions,
): DropResolution | null {
  for (const anchor of anchors) {
    const target: BlockDropTarget = { kind: "sibling", anchorId: anchor.id, position };
    if (options.canDrop(target)) {
      return { target, indicator: horizontalLine(anchor.box, position) };
    }
  }
  return null;
}

function resolveColumnDrop(
  hit: Extract<DragHit, { kind: "unit" }>,
  point: { x: number; y: number },
  options: ResolveDropOptions,
): DropResolution | null {
  if (!options.columnEligible || hit.type === "problem" || hit.gapEdge) {
    return null;
  }
  const edgeZone = options.edgeZonePx ?? resolveEdgeZonePx(hit.ownBox);
  const side: "left" | "right" | null = point.x < hit.ownBox.left + edgeZone
    ? "left"
    : point.x > hit.ownBox.right - edgeZone ? "right" : null;
  if (!side) {
    return null;
  }

  if (hit.section) {
    const target: BlockDropTarget = {
      kind: "insertColumn",
      sectionId: hit.section.id,
      anchorChildId: hit.section.childId,
      side,
    };
    return options.canDrop(target)
      ? { target, indicator: verticalLine(hit.section.columnBox, side) }
      : null;
  }

  const hostKind = hit.type === "listItem" ? hit.listContainerKind : hit.containerKind;
  if (!hostKind || !containerAllowsNewColumns(hostKind)) {
    return null;
  }
  const target: BlockDropTarget = { kind: "newColumns", anchorId: hit.id, side };
  return options.canDrop(target)
    ? { target, indicator: verticalLine(hit.box, side) }
    : null;
}

function horizontalLine(box: DragBox, position: "before" | "after"): DropIndicator {
  return {
    orientation: "horizontal",
    top: position === "before" ? box.top : box.bottom,
    left: box.left,
    width: Math.max(0, box.right - box.left),
  };
}

function verticalLine(box: DragBox, side: "left" | "right"): DropIndicator {
  return {
    orientation: "vertical",
    left: side === "left" ? box.left - COLUMN_LINE_OFFSET_PX : box.right + COLUMN_LINE_OFFSET_PX,
    top: box.top,
    height: Math.max(0, box.bottom - box.top),
  };
}

export function sameDropResolution(a: DropResolution | null, b: DropResolution | null): boolean {
  if (!a || !b) {
    return a === b;
  }
  if (JSON.stringify(a.target) !== JSON.stringify(b.target)) {
    return false;
  }
  const x = a.indicator;
  const y = b.indicator;
  if (x.orientation !== y.orientation) {
    return false;
  }
  if (x.orientation === "horizontal" && y.orientation === "horizontal") {
    return x.top === y.top && x.left === y.left && x.width === y.width;
  }
  if (x.orientation === "vertical" && y.orientation === "vertical") {
    return x.left === y.left && x.top === y.top && x.height === y.height;
  }
  return false;
}

/**
 * 段組の直下の子を、左端で束ねて段に分ける (左の段から)。CSS multicol の自動配分でどの段に
 * 居るかは文書に無いので、落とすときにここで実測から決めて文書へ明示する。
 */
export function clusterColumnsByLeft(
  children: readonly { id: string; left: number }[],
  tolerancePx = 4,
): string[][] {
  const columns: { left: number; ids: string[] }[] = [];
  for (const child of children) {
    const column = columns.find((candidate) => Math.abs(candidate.left - child.left) <= tolerancePx);
    if (column) {
      column.ids.push(child.id);
    } else {
      columns.push({ left: child.left, ids: [child.id] });
    }
  }
  return columns.sort((a, b) => a.left - b.left).map((column) => column.ids);
}
