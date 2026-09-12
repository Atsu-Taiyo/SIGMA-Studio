/**
 * ブロック下余白つまみの **ドラッグ中プレビュー** を決める純関数。
 *
 * ドラッグ中は紙面の寸法を一切変えない: 後続ブロックの追従は `transform: translateY()` の
 * 平行移動でだけ表現し、値は CSS カスタムプロパティ 1 本で運ぶ。寸法が変わらないので
 * 寸法の変化を見張っている側が鳴らず、ページ割りの再計算 → 全面再レンダーの連鎖が起きない
 * (以前は `padding-bottom` を伸ばしていたので、pointermove 1 回ごとにその連鎖が走っていた)。
 *
 * 「どのブロックが追従するか」(cohort) は pointerdown で 1 回だけ決める。ドラッグ中は
 * ページ割りが凍っているので、答えが変わりようがない。
 *
 * DOM に触らない (`architecture.test.ts` の純モデル境界)。
 */

import { MAX_BLOCK_SPACE_AFTER_PX } from "@/features/document";

/** 段の食い違い・丸めを吸収する許容量 (canvas px)。 */
const COLUMN_OVERLAP_EPSILON_PX = 0.5;

export interface SpaceAfterDragInput {
  /** ドラッグ開始時に文書が持っていた下余白 (論理 px)。 */
  startPx: number;
  /** pointerdown の clientY (画面 px)。 */
  startClientY: number;
  /** いまの clientY (画面 px)。 */
  clientY: number;
  /** pointerdown 時点のズーム倍率。紙面は transform で拡大されるので画面 px を割り戻す。 */
  zoomFactor: number;
}

/**
 * ポインタの移動量から、文書に入る下余白 (論理 px) を決める。
 *
 * 丸めはここで済ませる — プレビューと確定値が違う丸めをすると、離した瞬間に 1px 跳ねる。
 */
export function resolveSpaceAfterDragPx({
  startPx,
  startClientY,
  clientY,
  zoomFactor,
}: SpaceAfterDragInput): number {
  const scale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const deltaPx = (clientY - startClientY) / scale;
  return Math.min(MAX_BLOCK_SPACE_AFTER_PX, Math.max(0, Math.round(startPx + deltaPx)));
}

/** cohort の判定に要るだけの矩形 (`MeasuredBlock` の部分集合)。 */
export interface SpaceAfterPreviewBlockRect {
  top: number;
  left?: number;
  width?: number;
  height?: number;
  /** 入れ子の親 (リスト → 項目、問題エリア → ブロック)。掴んだブロックの子孫を外すのに使う。 */
  containerId?: string;
}

/** 紙面に並ぶフローユニットと、その中で編集面が持つブロック (= `.ProseMirror` の直下)。 */
export interface SpaceAfterPreviewUnit {
  id: string;
  blockIds: readonly string[];
}

export interface SpaceAfterPreviewCohort {
  /** 丸ごと平行移動するフローユニット (問題・局所段組・block ユニット)。 */
  followerUnitIds: readonly string[];
  /** ProseMirror の面が node decoration で印を付けるブロック。 */
  followerBlockIds: readonly string[];
}

const EMPTY_COHORT: SpaceAfterPreviewCohort = { followerUnitIds: [], followerBlockIds: [] };

export interface SpaceAfterPreviewCohortInput {
  /**
   * 紙面の実測 (canvas 座標)。段組の配置表ではなく **実測** を読むのは、ページ段組・局所
   * 段組・問題エリア段組で配置表の原点がそれぞれ違うのに対し、実測だけが全部を同じ 1 つの
   * 座標系で語れるため。
   */
  blockRects: ReadonlyMap<string, SpaceAfterPreviewBlockRect>;
  units: readonly SpaceAfterPreviewUnit[];
  /** 1 ページぶんの縦の刻み (`pageHeightPx + PAGE_GAP_PX`)。 */
  pageStride: number;
  draggedBlockId: string;
}

/**
 * 掴んだブロックに追従する集合を決める。
 *
 * 規則:
 * - 掴んだブロックの下端より **下** にあり、**同じページ** にあるものだけ。ページ割りは
 *   凍っているので、別ページを動かしても紙の隙間へはみ出す量が増えるだけになる。
 * - **横に重ならない** ものは動かさない。段組 (ページ段組・局所段組・問題エリア段組) の
 *   隣の段はこれで落ちる。「段が同じか」を段組の種類ごとに判定すると機構ごとに分岐が
 *   増えるので、`x` の重なりという 1 つの幾何で言い切る (字下げされた引用や枠は掴んだ
 *   ブロックと重なるので、ちゃんと追従する)。
 * - ユニットは「そのユニットのブロックが **全部** follower のとき」だけ丸ごと動かし、その
 *   ブロックは個別の印から外す。問題枠・サイドノート・問題番号は殻が持っているので殻ごと
 *   動かすのが正しく、二重に translate されるのも構造的に防げる。
 * - 掴んだブロック自身とその子孫は絶対に含めない。
 */
export function resolveSpaceAfterPreviewCohort({
  units,
  blockRects,
  pageStride,
  draggedBlockId,
}: SpaceAfterPreviewCohortInput): SpaceAfterPreviewCohort {
  const dragged = blockRects.get(draggedBlockId);
  if (!dragged) {
    return EMPTY_COHORT;
  }

  const draggedBottom = dragged.top + (dragged.height ?? 0);
  // 基準は **下端が居るページ**。下余白は最後の行の下に描かれるので、ページを跨いで分割された
  // ブロックでは掴んだ側ではなく続きの側のページで追従が起きる。上端で判定すると、分割された
  // ブロックを掴んだときだけ候補が 0 件になり「ドラッグ中は動かず、離した瞬間に飛ぶ」に戻る。
  // 下端がちょうど境界に乗ったときに次ページへ倒れないよう、1px 内側で読む。
  const draggedPage = pageIndexOf(Math.max(dragged.top, draggedBottom - 1), pageStride);
  const draggedSpan = horizontalSpan(dragged);

  const isFollower = (blockId: string): boolean => {
    if (blockId === draggedBlockId) {
      return false;
    }
    const rect = blockRects.get(blockId);
    if (!rect) {
      return false;
    }
    if (rect.top < draggedBottom - COLUMN_OVERLAP_EPSILON_PX) {
      return false;
    }
    if (pageIndexOf(rect.top, pageStride) !== draggedPage) {
      return false;
    }
    if (!overlapsHorizontally(draggedSpan, horizontalSpan(rect))) {
      return false;
    }
    return !isDescendantOf(blockId, draggedBlockId, blockRects);
  };

  const followerUnitIds: string[] = [];
  const followerBlockIds: string[] = [];
  for (const unit of units) {
    const members = unit.blockIds.filter((blockId) => blockRects.has(blockId));
    const followers = members.filter(isFollower);
    if (members.length > 0 && followers.length === members.length) {
      followerUnitIds.push(unit.id);
      continue;
    }
    followerBlockIds.push(...followers);
  }

  return { followerUnitIds, followerBlockIds };
}

function pageIndexOf(top: number, pageStride: number): number {
  return pageStride > 0 ? Math.floor(top / pageStride) : 0;
}

interface HorizontalSpan {
  left: number;
  right: number;
}

/** 横の占有範囲。判らないときは null = 「重なっている」として扱う (追従する側に倒す)。 */
function horizontalSpan(rect: SpaceAfterPreviewBlockRect): HorizontalSpan | null {
  if (rect.left === undefined || rect.width === undefined) {
    return null;
  }
  return { left: rect.left, right: rect.left + rect.width };
}

function overlapsHorizontally(a: HorizontalSpan | null, b: HorizontalSpan | null): boolean {
  if (!a || !b) {
    return true;
  }
  return a.left < b.right - COLUMN_OVERLAP_EPSILON_PX
    && b.left < a.right - COLUMN_OVERLAP_EPSILON_PX;
}

function isDescendantOf(
  blockId: string,
  ancestorId: string,
  blockRects: ReadonlyMap<string, SpaceAfterPreviewBlockRect>,
): boolean {
  const seen = new Set<string>([blockId]);
  let containerId = blockRects.get(blockId)?.containerId;
  while (containerId && !seen.has(containerId)) {
    if (containerId === ancestorId) {
      return true;
    }
    seen.add(containerId);
    containerId = blockRects.get(containerId)?.containerId;
  }
  return false;
}
