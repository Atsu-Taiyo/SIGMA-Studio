import {
  hitTestShape,
  isOverlayRichTextShape
} from "@/features/drawing";
import {
  getRenderableShapesInReverseVisualStackOrder,
  isShapeEditPolicyLockedInTree,
  isShapeLockedInTree
} from "./grouping";
import type {
  OverlayPoint,
  OverlayShape,
  OverlayShapeId
} from "./types";

/**
 * ダブルクリックで、その図形自身の文字を編集に入る図形か。
 *
 * 文章の図形 (text / callout) は本文を、表は枠の中のセルの文字を直す。こうした図形が一番上に
 * あるときは、下に何があってもその図形の編集に入る (従来どおり)。画像・図・グラフ・四角形など、
 * ダブルクリックで文字を直さない図形が一番上のときだけ、下の文章の図形へ抜ける対象になる。
 */
export function isDoubleClickTextEditShape(shape: OverlayShape): boolean {
  return isOverlayRichTextShape(shape) || shape.type === "tableShape";
}

export interface EditableTextShapeAtPointInput {
  shapes: readonly OverlayShape[];
  point: OverlayPoint;
  /** 選べない図形 (編集ポリシーが選択から外したもの)。クリックの当たり判定と同じ扱い。 */
  isUnselectable: (id: OverlayShapeId) => boolean;
  /** 編集ポリシー (AIの提案待ちなど) が予約していて、人が編集に入れない図形。 */
  editPolicyLockedIds: ReadonlySet<OverlayShapeId>;
  /** 当たり判定の余白。下の文章の図形は、箱の内側を指しているときだけ拾うので 0 が既定。 */
  margin?: number;
}

/**
 * 点の下にある文章の図形のうち、一番手前の編集できるものを返す (無ければ undefined)。
 *
 * 一番手前の図形が文字を持たない図形 (画像・SVGの図・四角形など) でも、その下に隠れた文章の
 * 図形をダブルクリックで直せるようにするための探索。クリックでの選択は一番手前が勝つままで、
 * ここは編集に入る先を決めるだけ。非表示・ロック (グループ越しを含む)・編集ポリシーの予約・
 * 選べない図形は編集に入れないので飛ばし、見つからなければ呼び出し側が従来の動き
 * (画像のトリミングなど) に戻る。
 */
export function findEditableTextShapeAtPoint({
  shapes,
  point,
  isUnselectable,
  editPolicyLockedIds,
  margin = 0,
}: EditableTextShapeAtPointInput): OverlayShape | undefined {
  const all = shapes as OverlayShape[];
  for (const shape of getRenderableShapesInReverseVisualStackOrder(all)) {
    if (
      !isOverlayRichTextShape(shape)
      || isUnselectable(shape.id)
      || isShapeLockedInTree(all, shape)
      || isShapeEditPolicyLockedInTree(all, shape, editPolicyLockedIds)
      || !hitTestShape(shape, point, margin)
    ) {
      continue;
    }
    return shape;
  }
  return undefined;
}

/**
 * ダブルクリックの対象を決める。`topmost` は従来どおり一番手前で当たった図形。
 *
 * - `topmost` が自分の文字を編集する図形 (文章・表) なら、そのまま `topmost`。
 * - それ以外 (画像・図・グラフ・四角形など) で、その下に編集できる文章の図形があれば、その図形。
 * - 下に文章の図形が無ければ `topmost` (画像のトリミングなど従来の動き)。
 *
 * 覆っている図形は変更しない (返すだけ)。
 */
export function resolveDoubleClickTarget(
  topmost: OverlayShape,
  find: () => OverlayShape | undefined,
): OverlayShape {
  if (isDoubleClickTextEditShape(topmost)) {
    return topmost;
  }
  return find() ?? topmost;
}
