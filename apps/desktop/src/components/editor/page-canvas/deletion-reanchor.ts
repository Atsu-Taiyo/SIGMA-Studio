import {
  reanchorAfterDeletion,
  resolveShapeAnchorPositions,
  type BlockExtent,
  type MeasuredBlock,
} from "../overlay-canvas/anchor";
import type { OverlayShape } from "../overlay-canvas/types";

/**
 * ブロックの削除で固定先を失った図形を、残ったブロックへ付け替えた図形の一覧 (変わらなければ null)。付け替えは
 * 1 回のコミットで出す。
 *
 * 機能が守っている図形 (`OverlayEditPolicy.preservedShapeIds`: 「適用後だけ」で隠した図形) も付け替える。保存時の
 * 付け替え・固定の補修と違い、ここは固定先が消えた図形だけを選び直す。その選び直しは文書の変更口が導出として
 * 通す (`locked-target-diff.ts`)。残すと、消えたブロックへの固定と削除前の y のまま残り (削除の再検出は 1 回
 * きり)、表示を戻すと本文からずれる。
 */
export function reanchorOverlayShapesAfterDeletion(
  shapes: OverlayShape[],
  deletedIds: ReadonlySet<string>,
  preMeasure: Map<string, BlockExtent>,
  anchorable: MeasuredBlock[],
): OverlayShape[] | null {
  const { shapes: reanchored, changed } = reanchorAfterDeletion(shapes, deletedIds, preMeasure, anchorable);
  return changed ? resolveShapeAnchorPositions(reanchored) : null;
}
