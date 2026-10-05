import {
  reanchorAfterDeletion,
  resolveShapeAnchorPositions,
  type BlockExtent,
  type MeasuredBlock,
} from "../overlay-canvas/anchor";
import { isShapeEditPolicyLockedInTree } from "../overlay-canvas/grouping";
import type { OverlayShape } from "../overlay-canvas/types";

const NO_PRESERVED_SHAPES: ReadonlySet<string> = new Set();

/**
 * ブロックの削除で固定先を失った図形を、残ったブロックへ付け替えた図形の一覧 (変わらなければ null)。付け替えは
 * 1 回のコミットで出す。
 *
 * 機能が人の編集から守っている図形 (`OverlayEditPolicy.preservedShapeIds`: 適用後だけを見せている間に隠した
 * 変更前) とそのグループの中の図形は、保存のまま残す: 混ざると変更口がコミット全体を断り、ほかの図形まで消した
 * ブロックにぶら下がったまま残る。ほかのロック (AI の実行中・合成できない提案・バーで隠した図形) は付け替える。
 */
export function reanchorOverlayShapesAfterDeletion(
  shapes: OverlayShape[],
  deletedIds: ReadonlySet<string>,
  preMeasure: Map<string, BlockExtent>,
  anchorable: MeasuredBlock[],
  preservedShapeIds: ReadonlySet<string> = NO_PRESERVED_SHAPES,
): OverlayShape[] | null {
  const { shapes: reanchored, changed } = reanchorAfterDeletion(shapes, deletedIds, preMeasure, anchorable, {
    keepsStoredAnchor: (shape) => isShapeEditPolicyLockedInTree(shapes, shape, preservedShapeIds),
  });
  return changed ? resolveShapeAnchorPositions(reanchored) : null;
}
