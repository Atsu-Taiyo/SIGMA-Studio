import type { PageCanvasSelectionSource } from "@/components/editor/page-canvas/editor-extension";
import type { AiEditReference } from "@/lib/ai/ai-edit-reference";

/**
 * 選択アクション (「AIに追加」ボタン) の同値判定キー。
 *
 * 紙面はこのキーでポップオーバーの state を差し替えるかどうかを決める。参照の中身をそのまま
 * 鍵にすると、ブロックを選んだまま本文を 1 文字打つだけで鍵が変わり、紙面全体が再描画される。
 * **場所で鍵を作り、参照の中身はボタンを押した瞬間に作り直す** (`createSelectionAction`)。
 *
 * ただし「中身そのものが参照」になる種別 — テキスト選択の文字列とインライン数式の TeX — は
 * 中身も鍵に入れる (打鍵で選択は壊れるので本文入力では churn しない一方、位置だけにすると
 * 古い引用・古い数式が AI へ渡りうる)。
 */
export function getSelectionActionKey(
  source: PageCanvasSelectionSource,
  reference: AiEditReference,
): string {
  switch (source.kind) {
    case "block":
      return JSON.stringify(["block", source.targetId]);
    case "inlineMath":
      // TeX も鍵に入れる。数式は「中身そのもの」が参照なので、編集した直後に古い TeX が
      // AI へ渡ってはいけない (数式を打っている間だけ churn するが、本文打鍵では動かない)。
      return JSON.stringify(["inlineMath", source.targetId, source.mathInlineId, source.tex]);
    case "overlaySelection":
      return JSON.stringify(["overlaySelection", source.targetId, source.selection.selectedShapeIds]);
    case "textRange":
      return JSON.stringify(reference);
  }
}
