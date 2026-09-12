/**
 * 本文モードでポインタを押したとき、その押下を「本文」と「図形」のどちらが受け取るか。
 *
 * 確定方針は **本文の上に重なった未選択の図形は本文を透過する**。図形が本文の上に乗っていても、
 * 選択していない限り背面の本文をクリック・ドラッグ選択できる。そこで図形を掴むのは「先に選ぶ」か
 * 「Ctrl/Cmd を押す」かの明示操作だけで、モード切替トグルや常用の修飾キーは採らない。
 *
 * 透過するのは **透過する相手 (本文) が下にあるとき** に限る。用紙の外・余白・本文の切れ目には
 * 渡す先が無いので、そこに置かれたオブジェクトは素のクリックでそのまま掴める。用紙の内か外かは
 * 判定に入らない — 「押した点の下に本文があるか」だけが効く。
 *
 * 判定に図形の種別・塗り・線の有無も入らない。図形も画像も表もテキストも、本文の上なら等しく
 * 透過し、本文の無いところなら等しく掴める (当たったかどうかは呼び出し側のヒットテストの関心)。
 */
export type BodyPointerRoute = "text" | "overlayShape";

export interface BodyPointerModifiers {
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

export interface BodyPointerRouteInput {
  /** ヒットテストで当たった最前面の図形 id。当たらなければ null。 */
  hitShapeId: string | null;
  /**
   * いま選択されている図形。
   *
   * 現在のアプリではオーバーレイ編集を抜けると選択が空に戻る (`EditorShell` の
   * `onOverlayEditingChange`) ので、本文モードでは実際には常に空になる。それでも規約として
   * 「選択済みの図形は押下を保つ」を明示しておく — 本文モードで選択が残る状態が将来生まれたとき、
   * 透過の規約がここ 1 箇所で決まっているようにするため。
   */
  selectedShapeIds: readonly string[];
  /**
   * 押した点の下に本文 (編集可能な本文要素) があるか。
   *
   * 透過は「本文を触らせるため」の規約なので、本文が無ければ透過する理由も無い。用紙の外に
   * はみ出したオブジェクト・余白や空白部分に置かれたオブジェクトはここが false になり、
   * 素のクリックでそのまま掴める。
   */
  pointerOverBodyText: boolean;
  modifiers: BodyPointerModifiers;
}

export const NO_POINTER_MODIFIERS: BodyPointerModifiers = {
  alt: false,
  ctrl: false,
  meta: false,
  shift: false,
};

export function resolveBodyPointerRoute({
  hitShapeId,
  selectedShapeIds,
  pointerOverBodyText,
  modifiers,
}: BodyPointerRouteInput): BodyPointerRoute {
  // Ctrl/Cmd は「いまは図形を触る」という明示操作。図形に当たっていなくても範囲選択
  // (marquee) を始めたいので、ヒットの有無に関わらずオーバーレイへ渡す。
  if (modifiers.ctrl || modifiers.meta) {
    return "overlayShape";
  }

  // Shift / Alt は本文側の操作 (範囲選択の伸長など) なので図形に横取りさせない。
  if (!hitShapeId || modifiers.shift || modifiers.alt) {
    return "text";
  }

  // 本文が下に無いなら透過する相手がいない。用紙の外にはみ出した図形・画像・表も、
  // 余白に置かれたオブジェクトも、素のクリックで掴めるのが「押した物が選ばれる」規約。
  if (!pointerOverBodyText) {
    return "overlayShape";
  }

  return selectedShapeIds.includes(hitShapeId) ? "overlayShape" : "text";
}
