/**
 * Hover model for the block handle (left gutter) and the insertion line drawn between
 * top-level blocks. Both read the same hovered block and the same pointer position, so
 * "which block am I on" and "which boundary am I near" can never disagree.
 *
 * Only the block under the pointer is measured, never the whole document: a cached table of
 * every block's box goes stale on any reflow, and a stale box silently stops matching the
 * pointer, which reads as "the handle just stopped appearing".
 *
 * All coordinates are canvas pixels (zoom already divided out), matching the geometry the
 * page canvas uses for its other absolutely positioned layers.
 */

export interface TopLevelBlockBox {
  id: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * What sits on one side of a block. `atomic` is a problem or a box — a block a caret cannot
 * step out of, so the gap beside it has no keyboard route in and always earns an insert line.
 */
export type BlockNeighborKind = "none" | "atomic" | "body";

export interface HoveredTopLevelBlock {
  box: TopLevelBlockBox;
  /**
   * 下端を伸ばすハンドルの対象。トップレベルのブロック、または問題エリア・局所段組の中の
   * ブロック (入れ物ではなく、その中のポインタに対応する 1 ブロックへ降ろす)。
   * 枠を持つブロック (引用・コード・囲み枠) や入れ物そのもの (段組・問題) では null —
   * 判定は描画・計測と同じ `rendersBlockSpaceAfter` を通す。
   */
  spaceAfterTarget?: BlockSpaceAfterTarget | null;
  /** The following top-level block, if any. Anchors "insert after" to a stable side. */
  nextBlockId: string | null;
  /** Whether this block is itself a problem or a box. */
  isAtomic: boolean;
  aboveKind: BlockNeighborKind;
  belowKind: BlockNeighborKind;
  /**
   * Set when the pointer sat in the gap between two blocks rather than on one of them. The
   * gap is wider than the edge threshold, so without this the line would blink out exactly
   * where the user is aiming — between a problem and the box under it, say.
   */
  gapEdge?: "top" | "bottom" | null;
  /** グリップを出す単位。無ければトップレベルのブロックそのもの。 */
  unit?: HoveredDragUnit | null;
  /** 入れ物の上端帯に居るため、計測済みの子より入れ物自身を優先する。 */
  useOwnerAffordance?: boolean;
}

export interface BlockInsertPoint {
  /** Null means "at the end of the document" — there is no block to anchor to. */
  anchorBlockId: string | null;
  position: "before" | "after";
  /** Where the line is drawn. */
  top: number;
  left: number;
  width: number;
}

/**
 * 「ブロックの下端を掴んで下余白を伸ばす」つまみの当たり先。
 *
 * ブロック本体の box とは別に持つ: 問題の中では box が問題全体でも、掴む相手は
 * その中の 1 ブロックの下端になる。
 */
export interface BlockSpaceAfterTarget {
  blockId: string;
  /** 実測のブロック下端 (canvas px)。つまみの y。 */
  bottom: number;
  /** 実測のブロック左端。n 段組ではその段の左に一致する。 */
  left: number;
  /** 問題エリアの中か。既存のエリア高さハンドル・問題番号と重ねないためのレーン指定。 */
  insideProblemArea: boolean;
  /** 現在の下余白 (px)。ドラッグの初期値。 */
  spaceAfterPx: number;
}

export interface BlockHandleTarget {
  blockId: string;
  top: number;
  bottom: number;
  left: number;
  /** 問題エリアの中。左ガターの chrome と重ならないレーンへ出す。 */
  insideProblemArea?: boolean;
}

/**
 * ポインタの下の **掴む単位** — 箱の中の段落、リストの 1 項目など、トップレベルより内側の
 * 1 ブロック。グリップはこれに出す (Notion と同じ「段落ごと」の粒度)。挿入線・下端つまみは
 * これまでどおりトップレベルの箱で決める。
 */
export interface HoveredDragUnit {
  id: string;
  top: number;
  bottom: number;
  left: number;
  insideProblemArea: boolean;
}

/**
 * 左ガター・段間からのホバー救済プローブを打つ x (レイアウト px)。
 *
 * 1 段では常に本文の左端。n 段組ページでは **ポインタが居る段** の左端 — つまみとグリップは
 * 段の左の外へ描かれるので、段間と各段の左ガターはその右にある段のレーンとして帰属させる。
 * ここを常に 1 段目にすると、2 段目のつまみへ近づいた瞬間にホバーが 1 段目のブロックへ
 * 解決し直され、つまみが消えて掴めない。
 */
export function blockHitProbeColumnLeftPx(
  layout: {
    contentLeftPx: number;
    columnCount: number;
    columnWidthPx: number;
    columnGapPx: number;
  },
  layoutX: number,
): number {
  const { contentLeftPx, columnCount, columnWidthPx, columnGapPx } = layout;
  if (columnCount <= 1) {
    return contentLeftPx;
  }
  const stride = columnWidthPx + columnGapPx;
  const index = Math.floor((layoutX - contentLeftPx + columnGapPx) / stride);
  return contentLeftPx + Math.min(columnCount - 1, Math.max(0, index)) * stride;
}

/** フローユニット内のブロック候補。座標系は呼び出し側で揃っていれば何でもよい (client px 等)。 */
export interface InnerBlockCandidate {
  id: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface InnerBlockHit {
  id: string;
  /** 候補集合の最左の段に居るか。問題エリアの左ガター chrome を避けるレーン選びに使う。 */
  firstColumn: boolean;
}

/** 同じ段と見なす左端のゆらぎ。リストと段落の描画差・小数丸めを吸収する程度。 */
const INNER_COLUMN_CLUSTER_TOLERANCE_PX = 4;

/** The shared lane rule: every gap begins the lane on its right. */
export function resolveInnerLaneIndex(
  columns: readonly { left: number; right: number }[],
  x: number,
): number {
  let lane = 0;
  for (let index = 1; index < columns.length; index += 1) {
    if (x >= columns[index - 1].right) {
      lane = index;
    }
  }
  return lane;
}

export interface InnerLaneProbe {
  laneIndex: number;
  probeX: number;
  laneLeft: number;
  firstColumn: boolean;
}

/** A container keeps its real padding above the first row, with a 6px minimum at zero padding. */
export function isContainerTopBand(
  ownerTop: number,
  pointerY: number,
  firstInnerTop?: number,
  minimumPx = 6,
): boolean {
  return pointerY < Math.max(ownerTop + minimumPx, firstInnerTop ?? ownerTop);
}

/** Resolve one grid lane while carrying problem-area first-column ownership through nesting. */
export function resolveInnerLaneProbe(
  columns: readonly { left: number; right: number }[],
  x: number,
  parentFirstColumn = true,
): InnerLaneProbe | null {
  if (columns.length === 0) return null;
  const lane = Math.min(resolveInnerLaneIndex(columns, x), columns.length - 1);
  const column = columns[lane];
  return {
    laneIndex: lane,
    probeX: column.left + Math.min(8, (column.right - column.left) / 2),
    laneLeft: column.left,
    firstColumn: parentFirstColumn && lane === 0,
  };
}

/**
 * フローユニットの中 (問題エリア・局所段組) で、ポインタ位置に対応するブロックを選ぶ。
 *
 * y だけでは決まらない: 局所段組では同じ高さに段の数だけブロックが並ぶ。段は候補の左端を
 * クラスタして復元し、ポインタの x をどれか 1 つの段 (レーン) に帰属させる — 段間と段の
 * 左ガターは **右側の段のレーン** (つまみは段の左の外へ描かれる)。どの段の右端よりも左は
 * 第 1 段なので、1 段しかないユニットでは従来どおり x に依存しない (問題エリアの chrome に
 * プローブが落ちても正しいブロックに当たる)。
 *
 * レーン内では、まずポインタの高さにあるブロック。無ければポインタより上で最も下のもの
 * (左ガターから狙ったときの救済) を `fallbackReachPx` の範囲で採る。
 */
export function resolveInnerBlockAt(
  candidates: readonly InnerBlockCandidate[],
  x: number,
  y: number,
  options: { hitSlackPx?: number; fallbackReachPx?: number } = {},
): InnerBlockHit | null {
  const hitSlackPx = options.hitSlackPx ?? 4;
  const fallbackReachPx = options.fallbackReachPx ?? 24;
  if (candidates.length === 0) {
    return null;
  }

  const columns: Array<{ left: number; right: number }> = [];
  for (const candidate of [...candidates].sort((a, b) => a.left - b.left)) {
    const last = columns[columns.length - 1];
    if (last && candidate.left - last.left <= INNER_COLUMN_CLUSTER_TOLERANCE_PX) {
      last.right = Math.max(last.right, candidate.right);
    } else {
      columns.push({ left: candidate.left, right: candidate.right });
    }
  }

  const lane = resolveInnerLaneIndex(columns, x);
  const laneLeft = columns[lane].left;
  const inLane = candidates.filter(
    (candidate) => Math.abs(candidate.left - laneLeft) <= INNER_COLUMN_CLUSTER_TOLERANCE_PX,
  );

  let fallback: InnerBlockCandidate | null = null;
  for (const candidate of inLane) {
    if (y >= candidate.top - hitSlackPx && y <= candidate.bottom + hitSlackPx) {
      return { id: candidate.id, firstColumn: lane === 0 };
    }
    if (
      candidate.bottom <= y
      && y - candidate.bottom <= fallbackReachPx
      && (!fallback || candidate.bottom > fallback.bottom)
    ) {
      fallback = candidate;
    }
  }

  return fallback ? { id: fallback.id, firstColumn: lane === 0 } : null;
}

export interface BlockAffordanceHover {
  handle: BlockHandleTarget | null;
  insertPoint: BlockInsertPoint | null;
  spaceAfter: BlockSpaceAfterTarget | null;
}

export interface BlockAffordanceHoverOptions {
  /** How close to a block edge the pointer must be for the insertion line to appear. */
  edgeThresholdPx?: number;
  /** How far left of a block the pointer may stray and still count as hovering it. */
  gutterWidthPx?: number;
  /** 局所段組の列境界ハンドルがこのポインタを所有している。 */
  suppressGutterControls?: boolean;
}

export const EMPTY_BLOCK_AFFORDANCE_HOVER: BlockAffordanceHover = {
  handle: null,
  insertPoint: null,
  spaceAfter: null,
};

export type BlockAffordancePointerOwner = "frozen" | "divider" | "content";

/** Decide which already-measured hover surface owns the current pointer position. */
export function resolveBlockAffordancePointerOwner(input: {
  dragging: boolean;
  targetIsAffordance: boolean;
  hitsColumnDivider: boolean;
}): BlockAffordancePointerOwner {
  if (input.dragging) return "frozen";
  if (input.targetIsAffordance) return "frozen";
  if (input.hitsColumnDivider) return "divider";
  return "content";
}

export function resolveBlockAffordanceHover(
  hovered: HoveredTopLevelBlock | null,
  point: { x: number; y: number },
  options: BlockAffordanceHoverOptions = {},
): BlockAffordanceHover {
  const edgeThresholdPx = options.edgeThresholdPx ?? 7;
  const gutterWidthPx = options.gutterWidthPx ?? 48;
  if (!hovered || options.suppressGutterControls) {
    return EMPTY_BLOCK_AFFORDANCE_HOVER;
  }

  const { box } = hovered;
  const withinColumn = point.x >= box.left - gutterWidthPx && point.x <= box.right;
  // A gap-resolved hit is adjacent by construction, so it skips the vertical range test the
  // pointer would otherwise fail for sitting further out than the edge threshold.
  const withinBlock = !!hovered.gapEdge
    || (point.y >= box.top - edgeThresholdPx && point.y <= box.bottom + edgeThresholdPx);
  if (!withinColumn || !withinBlock) {
    return EMPTY_BLOCK_AFFORDANCE_HOVER;
  }

  const distanceToTop = Math.abs(point.y - box.top);
  const distanceToBottom = Math.abs(point.y - box.bottom);
  const width = box.right - box.left;
  const nearTop = hovered.gapEdge === "top" || distanceToTop <= edgeThresholdPx;
  const nearBottom = hovered.gapEdge === "bottom" || distanceToBottom <= edgeThresholdPx;

  // A boundary earns the line when a caret cannot reach it: next to a problem or a box, or
  // at the very top of the document. Both sides of one gap agree, because the test looks at
  // the pair of blocks around it rather than at whichever one the pointer happens to be on.
  // The document's own end is left to the trailing click zone.
  const atTopEdge = nearTop && (hovered.isAtomic || hovered.aboveKind !== "body");
  const atBottomEdge = nearBottom && (hovered.isAtomic || hovered.belowKind === "atomic");

  // One gap must resolve to one insert point no matter which side the pointer approached
  // from, so "after this block" is expressed as "before the next one" whenever there is one.
  const insertPoint: BlockInsertPoint | null = atTopEdge
    && (!atBottomEdge || distanceToTop <= distanceToBottom)
    ? { anchorBlockId: box.id, position: "before", top: box.top, left: box.left, width }
    : atBottomEdge
      ? {
          anchorBlockId: hovered.nextBlockId ?? box.id,
          position: hovered.nextBlockId ? "before" : "after",
          top: box.bottom,
          left: box.left,
          width,
        }
      : null;

  const unit = hovered.useOwnerAffordance ? null : hovered.unit ?? null;
  return {
    handle: unit
      ? { blockId: unit.id, top: unit.top, bottom: unit.bottom, left: unit.left, insideProblemArea: unit.insideProblemArea }
      : { blockId: box.id, top: box.top, bottom: box.bottom, left: box.left },
    insertPoint,
    // グリップと同じ条件 (段の中 + ブロックの縦範囲) で出す。掴む相手だけがブロック本体では
    // なく「その下端」なので、幾何は呼び出し側が実測した値をそのまま運ぶ。
    spaceAfter: hovered.spaceAfterTarget ?? null,
  };
}

/**
 * 左ガターに並ぶ 2 つの当たり判定の矩形 (`globals.css` の写し。原点はそれぞれの affordance の
 * 基準点 — つまみは「ブロックの下端」、＋ は「挿入線の位置」)。
 *
 * 既定のままだと ＋ (`.page-block-insert-button`) はつまみ (`.page-block-space-handle`) と
 * ほぼ完全に重なる。両方が同じ辺に出るのは「問題・囲み枠の直前のブロック」で、そこでは
 * 後から描かれる ＋ が必ず上に乗るので、下端つまみを掴めない (ドラッグしても何も起きない)。
 */
const SPACE_HANDLE_RECT = { left: -30, right: 0, top: -8, bottom: 8 };
/** 問題エリアの中のつまみ。問題番号・サイドノートを避けて 1 レーン外に描かれる。 */
const PROBLEM_LANE_SPACE_HANDLE_RECT = { left: -54, right: -24, top: -8, bottom: 8 };
const INSERT_BUTTON_RECTS = {
  default: { left: -26, right: -6, top: -11, bottom: 9 },
  outer: { left: -56, right: -36, top: -11, bottom: 9 },
} as const;

export type BlockInsertButtonLane = keyof typeof INSERT_BUTTON_RECTS;

/**
 * ＋ を描くレーン。つまみと重なるときだけ 1 レーン外へ逃がす。
 *
 * 逃がす先でも重なる (問題レーンのつまみ) なら既定のまま — そこは重なりが数 px で、
 * 外へ動かすと逆に食い込む。ずらすのは ＋ の方: つまみは右端を本文の左端に密着させる規約
 * なので動かせない (隙間があると、そこを通って寄る途中でホバーが下のブロックへ移る)。
 */
export function resolveBlockInsertButtonLane(hover: BlockAffordanceHover): BlockInsertButtonLane {
  const { insertPoint, spaceAfter } = hover;
  if (!insertPoint || !spaceAfter) {
    return "default";
  }

  const handle = spaceAfter.insideProblemArea ? PROBLEM_LANE_SPACE_HANDLE_RECT : SPACE_HANDLE_RECT;
  const handleBox = {
    left: spaceAfter.left + handle.left,
    right: spaceAfter.left + handle.right,
    top: spaceAfter.bottom + handle.top,
    bottom: spaceAfter.bottom + handle.bottom,
  };
  const insertBox = (lane: BlockInsertButtonLane) => ({
    left: insertPoint.left + INSERT_BUTTON_RECTS[lane].left,
    right: insertPoint.left + INSERT_BUTTON_RECTS[lane].right,
    top: insertPoint.top + INSERT_BUTTON_RECTS[lane].top,
    bottom: insertPoint.top + INSERT_BUTTON_RECTS[lane].bottom,
  });

  if (!overlaps(handleBox, insertBox("default"))) {
    return "default";
  }
  return overlaps(handleBox, insertBox("outer")) ? "default" : "outer";
}

interface AffordanceBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function overlaps(a: AffordanceBox, b: AffordanceBox): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Shift-clicking a second handle selects everything between the two, so a run of paragraphs
 * can go in one Delete. Order follows the document, not the click order.
 */
export function resolveBlockSelectionRange(
  orderedIds: readonly string[],
  anchorId: string,
  targetId: string,
): string[] {
  const anchorIndex = orderedIds.indexOf(anchorId);
  const targetIndex = orderedIds.indexOf(targetId);
  if (anchorIndex < 0 || targetIndex < 0) {
    return [targetId];
  }

  return orderedIds.slice(
    Math.min(anchorIndex, targetIndex),
    Math.max(anchorIndex, targetIndex) + 1,
  );
}

/** Pointer moves fire continuously; only a changed hover may re-render the canvas. */
export function sameBlockAffordanceHover(
  a: BlockAffordanceHover,
  b: BlockAffordanceHover,
): boolean {
  if (
    a.handle?.blockId !== b.handle?.blockId
    || a.handle?.top !== b.handle?.top
    || a.handle?.bottom !== b.handle?.bottom
    || a.handle?.left !== b.handle?.left
    || a.handle?.insideProblemArea !== b.handle?.insideProblemArea
  ) {
    return false;
  }
  // 下端つまみは位置も値も比べる。ここを省くとポインタが動くたびに新しいオブジェクトが
  // 採用され、紙面全体が 60Hz で再レンダリングされる。
  if (
    a.spaceAfter?.blockId !== b.spaceAfter?.blockId
    || a.spaceAfter?.bottom !== b.spaceAfter?.bottom
    || a.spaceAfter?.left !== b.spaceAfter?.left
    || a.spaceAfter?.spaceAfterPx !== b.spaceAfter?.spaceAfterPx
    || a.spaceAfter?.insideProblemArea !== b.spaceAfter?.insideProblemArea
  ) {
    return false;
  }
  if (!a.insertPoint || !b.insertPoint) {
    return a.insertPoint === b.insertPoint;
  }

  return (
    a.insertPoint.anchorBlockId === b.insertPoint.anchorBlockId &&
    a.insertPoint.position === b.insertPoint.position &&
    a.insertPoint.top === b.insertPoint.top &&
    a.insertPoint.left === b.insertPoint.left &&
    a.insertPoint.width === b.insertPoint.width
  );
}

export function resolveStationaryBlockAffordanceRefresh(input: {
  previousRevision: number;
  revision: number;
  point: { x: number; y: number } | null;
  current: BlockAffordanceHover;
  next: BlockAffordanceHover;
}): { revision: number; hover: BlockAffordanceHover; changed: boolean } {
  if (!input.point || input.revision <= input.previousRevision) {
    return { revision: input.revision, hover: input.current, changed: false };
  }
  const changed = !sameBlockAffordanceHover(input.current, input.next);
  return {
    revision: input.revision,
    hover: changed ? input.next : input.current,
    changed,
  };
}
